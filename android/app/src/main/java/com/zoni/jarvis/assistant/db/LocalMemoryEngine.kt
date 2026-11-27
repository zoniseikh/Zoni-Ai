package com.zoni.jarvis.assistant.db

import android.content.Context
import android.database.sqlite.SQLiteDatabaseCorruptException
import android.database.sqlite.SQLiteFullException
import androidx.room.withTransaction
import com.zoni.jarvis.assistant.data.SecureKeyManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.UUID

/**
 * Decrypted view of a permanent conversation record.
 */
data class DecryptedConversationRecord(
    val id: String,
    val conversationId: String = "default",
    val role: String,
    val text: String,
    val language: String = "bn-BD",
    val createdAtMs: Long = System.currentTimeMillis(),
    val inputType: String = "text",
    val commandName: String = "",
    val executionStatus: String = "",
    val dateBucket: String = ""
)

/**
 * Decrypted view of a local long-term memory entry linked to its original conversation.
 */
data class DecryptedMemoryRecord(
    val id: String,
    val category: String,
    val factKey: String,
    val value: String,
    val searchKeywords: String,
    val usageCount: Int,
    val userApproved: Boolean,
    val createdAtMs: Long,
    val updatedAtMs: Long,
    val sourceConversationId: String = "",
    val sourceMessageId: String = "",
    val status: String = "active",
    val correctionHistoryJson: String = "[]"
)

data class ExtractedMemoryFact(
    val category: String,
    val factKey: String,
    val value: String,
    val searchKeywords: String,
    val isCorrection: Boolean = false
)

data class HistoricalDateQuery(
    val startMs: Long,
    val endMs: Long,
    val label: String
)

data class LocalMemoryRecallResult(
    val isMemoryQuery: Boolean,
    val handledOffline: Boolean,
    val replyText: String,
    val matchedFacts: List<DecryptedMemoryRecord> = emptyList(),
    val matchedMessages: List<ConversationEntity> = emptyList(),
    val foundEvidence: Boolean = false
)

data class PaginatedArchiveSearchResult(
    val messages: List<DecryptedConversationRecord>,
    val totalReturned: Int,
    val hasMore: Boolean,
    val dateRangeApplied: HistoricalDateQuery? = null
)

/**
 * Pure JVM-testable permanent conversation memory, multilingual search, temporal recall,
 * semantic similarity, and privacy policy engine.
 *
 * Guarantees:
 * - Zero automatic expiry or 500-message truncation.
 * - NEVER stores passwords, OTPs, PINs, CVVs, card numbers, banking credentials, or API keys.
 * - Supports Bengali, English, and Hindi date/keyword/topic/semantic historical recall (15 days,
 *   6 months, or years ago).
 * - NEVER invents or guesses historical conversations — explicitly states when nothing is found.
 */
object LocalMemoryLogic {

    const val CATEGORY_LANGUAGE = "language"
    const val CATEGORY_PREFERENCE = "preference"
    const val CATEGORY_PERSONAL_FACT = "personal_fact"
    const val CATEGORY_ONGOING_TASK = "ongoing_task"
    const val CATEGORY_FREQUENT_COMMAND = "frequent_command"
    const val CATEGORY_CONTEXT = "context"

    const val MAX_COMPACT_CONTEXT_CHARS = 520
    const val MAX_HISTORICAL_CONTEXT_CHARS = 900
    const val MAX_STORED_MESSAGE_CHARS = 16_000

    private val IST_ZONE: ZoneId = ZoneId.of("Asia/Kolkata")
    private val DATE_BUCKET_FMT: DateTimeFormatter = DateTimeFormatter.ofPattern("yyyy-MM-dd")

    private val SENSITIVE_KEYWORDS = listOf(
        "password", "passwd", "passcode", "পাসওয়ার্ড", "পাসওয়ার্ড", "पासवर्ड",
        "otp", "ওটিপি", "ओटीपी", "one time password", "verification code", "ভেরিফিকেশন কোড",
        "pin ", " pin", "পিন", "mpin", "upi pin", "atm pin", "বিকাশ পিন", "নগদ পিন",
        "cvv", "cvc", "সিভিভি", "card number", "কার্ড নম্বর", "debit card", "credit card",
        "bank account", "ব্যাংক একাউন্ট", "routing number", "ifsc", "swift code",
        "secret key", "private key", "recovery phrase", "seed phrase", "api key"
    )

    private val OTP_PATTERN = Regex(
        "(?:otp|code|pin|পিন|ওটিপি|কোড)\\s*(?:is|হলো|হল|:|=|-)?\\s*\\d{4,8}\\b",
        RegexOption.IGNORE_CASE
    )
    private val CARD_NUMBER_PATTERN = Regex("\\b(?:\\d[ -]*?){13,19}\\b")
    private val API_KEY_PATTERN = Regex("(?:AIza[0-9A-Za-z_\\-]{12,}|AQ\\.[0-9A-Za-z._\\-]{12,}|sk-[0-9A-Za-z]{16,})")

    /**
     * Cross-lingual semantic topic equivalence clusters (Bengali + English + Hindi).
     * Enables finding Bengali conversations when queried in English/Hindi and vice-versa.
     */
    private val SEMANTIC_TOPIC_CLUSTERS: List<Pair<String, Set<String>>> = listOf(
        "topic_medical" to setOf(
            "doctor", "hospital", "clinic", "medicine", "appointment", "health", "checkup", "fever",
            "ডাক্তার", "ডাক্তারের", "হাসপাতাল", "ওষুধ", "অ্যাপয়েন্টমেন্ট", "অ্যাপয়েন্টমেন্ট", "স্বাস্থ্য", "জ্বর",
            "डॉक्टर", "अस्पताल", "दवाई", "दवा", "अपॉइंटमेंट", "बुखार", "स्वास्थ्य"
        ),
        "topic_meeting" to setOf(
            "meeting", "office", "boss", "deadline", "presentation", "interview", "work", "project",
            "মিটিং", "অফিস", "কাজ", "প্রজেক্ট", "ইন্টারভিউ", "ডেডলাইন",
            "मीटिंग", "ऑफिस", "काम", "प्रोजेक्ट", "इंटरव्यू"
        ),
        "topic_travel" to setOf(
            "travel", "trip", "flight", "train", "ticket", "hotel", "vacation", "tour", "airport",
            "ভ্রমণ", "ট্রিপ", "ফ্লাইট", "ট্রেন", "টিকিট", "হোটেল", "বেড়াতে", "বেড়াতে", "এয়ারপোর্ট",
            "यात्रा", "ट्रिप", "फ्लाइट", "ट्रेन", "टिकट", "होटल", "घूमने"
        ),
        "topic_finance" to setOf(
            "budget", "salary", "rent", "bill", "expense", "price", "shopping", "market", "money",
            "বাজেট", "বেতন", "ভাড়া", "ভাড়া", "বিল", "খরচ", "বাজার", "দাম", "টাকা",
            "बजट", "सैलरी", "किराया", "बिल", "खर्च", "बाजार", "पैसे"
        ),
        "topic_study" to setOf(
            "exam", "study", "college", "university", "class", "homework", "book", "course",
            "পরীক্ষা", "পড়াশোনা", "পড়াশোনা", "কলেজ", "বিশ্ববিদ্যালয়", "ক্লাস", "বই", "কোর্স",
            "परीक्षा", "पढ़ाई", "कॉलेज", "किताब", "कोर्स", "क्लास"
        ),
        "topic_family" to setOf(
            "family", "mother", "mom", "father", "dad", "brother", "sister", "birthday", "wedding", "anniversary",
            "পরিবার", "মা", "বাবা", "ভাই", "বোন", "জন্মদিন", "বিয়ে", "বিয়ে", "বিবাহবার্ষিকী",
            "परिवार", "माँ", "पिता", "भाई", "बहन", "जन्मदिन", "शादी"
        ),
        "topic_food" to setOf(
            "food", "coffee", "tea", "dinner", "lunch", "breakfast", "restaurant", "recipe",
            "খাবার", "কফি", "চা", "ডিনার", "লাঞ্চ", "নাস্তা", "রেস্টুরেন্ট", "রান্না",
            "खाना", "कॉफी", "चाय", "डिनर", "लंच", "नाश्ता", "रेस्टोरेंट"
        ),
        "topic_task" to setOf(
            "task", "todo", "reminder", "plan", "pending", "finish", "complete", "schedule",
            "কাজ", "রিমাইন্ডার", "প্ল্যান", "বাকি", "শেষ", "তালিকা",
            "टास्क", "रिमाइंडर", "प्लान", "बाकी", "पूरा"
        )
    )

    private val STOP_WORDS = setOf(
        "what", "did", "you", "the", "about", "remember", "say", "said", "talk", "know", "that", "this",
        "was", "were", "have", "had", "from", "with", "when", "where", "tell", "me", "we", "ago", "days",
        "day", "month", "months", "year", "years", "last", "previous", "history", "conversation", "discuss",
        "আমার", "আমি", "তুমি", "আগে", "বলেছিলাম", "জানো", "মনে", "আছে", "সম্পর্কে", "কী", "কি",
        "দিন", "মাস", "বছর", "কথা", "হয়েছিল", "হয়েছিল", "করেছিলাম", "নিয়ে", "নিয়ে",
        "क्या", "था", "थी", "थे", "मैंने", "हमने", "पहले", "दिन", "महीने", "साल", "बात", "याद", "है", "बारे"
    )

    fun formatDateBucket(timestampMs: Long): String {
        return try {
            Instant.ofEpochMilli(timestampMs).atZone(IST_ZONE).toLocalDate().format(DATE_BUCKET_FMT)
        } catch (_: Exception) {
            "1970-01-01"
        }
    }

    /**
     * Converts Bengali (`০-৯`) and Devanagari (`०-९`) digits to ASCII digits for temporal parsing.
     */
    fun normalizeIndicDigits(input: String): String {
        val sb = StringBuilder(input.length)
        for (ch in input) {
            when (ch) {
                in '০'..'৯' -> sb.append(('0'.code + (ch.code - '০'.code)).toChar())
                in '०'..'९' -> sb.append(('0'.code + (ch.code - '०'.code)).toChar())
                else -> sb.append(ch)
            }
        }
        return sb.toString()
    }

    /**
     * Returns true when text contains passwords, OTPs, PINs, CVVs, card numbers,
     * banking credentials, or API keys that MUST NEVER be persisted to local history or memory.
     */
    fun containsSensitiveSecret(text: String?): Boolean {
        val clean = text?.trim().orEmpty()
        if (clean.isEmpty()) return false
        val lower = " ${clean.lowercase()} "
        if (API_KEY_PATTERN.containsMatchIn(clean)) return true
        if (OTP_PATTERN.containsMatchIn(clean)) return true
        if (CARD_NUMBER_PATTERN.containsMatchIn(clean)) {
            val digits = clean.filter { it.isDigit() }
            if (digits.length in 13..19) return true
        }
        return SENSITIVE_KEYWORDS.any { lower.contains(it) }
    }

    /**
     * Sanitizes a message before persisting to Room; returns null if it should be completely omitted
     * due to sensitive credentials. Preserves complete messages up to 16,000 characters.
     */
    fun sanitizeForStorage(text: String?): String? {
        val clean = text?.trim().orEmpty()
        if (clean.isEmpty()) return null
        if (containsSensitiveSecret(clean)) return null
        return if (clean.length > MAX_STORED_MESSAGE_CHARS) {
            clean.take(MAX_STORED_MESSAGE_CHARS).trimEnd()
        } else {
            clean
        }
    }

    /**
     * Builds an indexed, privacy-safe multilingual search token string (keywords + topic tags)
     * so encrypted Room records can be searched via SQL pagination without loading all rows into RAM.
     */
    fun buildIndexedSearchTokens(text: String, commandName: String = ""): String {
        val clean = text.trim()
        if (clean.isEmpty() || containsSensitiveSecret(clean)) return ""
        val combined = if (commandName.isNotBlank()) "$clean $commandName" else clean
        val rawTokens = combined.lowercase()
            .replace(Regex("[^\\p{L}\\p{M}\\p{N}\\s]+"), " ")
            .split(Regex("\\s+"))
            .filter { it.length >= 2 }
            .distinct()
            .take(48)

        val topicTags = detectSemanticTopics(rawTokens)
        return (rawTokens + topicTags).distinct().joinToString(" ").take(1024)
    }

    fun detectSemanticTopics(tokens: Collection<String>): Set<String> {
        val matched = mutableSetOf<String>()
        for ((topicTag, vocab) in SEMANTIC_TOPIC_CLUSTERS) {
            if (tokens.any { tok -> vocab.any { v -> tok == v || (tok.length >= 4 && v.length >= 4 && (tok.startsWith(v) || v.startsWith(tok))) } }) {
                matched.add(topicTag)
            }
        }
        return matched
    }

    /**
     * Parses temporal expressions in Bengali, English, and Hindi (e.g. "15 days ago", "১৫ দিন আগে",
     * "6 months ago", "৬ মাস আগে", "last year", "গত বছর", "2 years ago", "15 दिन पहले", "2025-11-10").
     */
    fun parseHistoricalDateRange(
        query: String,
        nowMs: Long = System.currentTimeMillis()
    ): HistoricalDateQuery? {
        val normalized = normalizeIndicDigits(query).lowercase()
        val nowZdt = Instant.ofEpochMilli(nowMs).atZone(IST_ZONE)
        val today = nowZdt.toLocalDate()

        fun dayBounds(startDate: LocalDate, endDate: LocalDate, label: String): HistoricalDateQuery {
            val s = startDate.atStartOfDay(IST_ZONE).toInstant().toEpochMilli()
            val e = endDate.plusDays(1).atStartOfDay(IST_ZONE).toInstant().toEpochMilli() - 1L
            return HistoricalDateQuery(startMs = s, endMs = e, label = label)
        }

        // 1. Explicit ISO date YYYY-MM-DD
        Regex("\\b(20\\d{2})[-/](\\d{1,2})[-/](\\d{1,2})\\b").find(normalized)?.let { m ->
            val y = m.groupValues[1].toIntOrNull()
            val mo = m.groupValues[2].toIntOrNull()
            val d = m.groupValues[3].toIntOrNull()
            if (y != null && mo in 1..12 && d in 1..31) {
                return try {
                    val date = LocalDate.of(y, mo!!, d!!)
                    dayBounds(date, date, date.format(DATE_BUCKET_FMT))
                } catch (_: Exception) {
                    null
                }
            }
        }

        // 2. N days ago (English / Bengali / Hindi)
        Regex("(\\d{1,4})\\s*(?:days?\\s+ago|দিন\\s+আগে|দিন\\s+আগের|दिन\\s+पहले)").find(normalized)?.let { m ->
            val days = m.groupValues[1].toLongOrNull()?.coerceIn(1L, 3650L) ?: return@let
            val target = today.minusDays(days)
            val tol = if (days <= 3L) 0L else if (days <= 30L) 1L else 3L
            return dayBounds(target.minusDays(tol), target.plusDays(tol), "$days days ago (${target.format(DATE_BUCKET_FMT)})")
        }

        // 3. N weeks ago
        Regex("(\\d{1,3})\\s*(?:weeks?\\s+ago|সপ্তাহ\\s+আগে|হপ্তা\\s+আগে|हफ्ते\\s+पहले|सप्ताह\\s+पहले)").find(normalized)?.let { m ->
            val weeks = m.groupValues[1].toLongOrNull()?.coerceIn(1L, 520L) ?: return@let
            val target = today.minusWeeks(weeks)
            return dayBounds(target.minusDays(3), target.plusDays(3), "$weeks weeks ago")
        }

        // 4. N months ago
        Regex("(\\d{1,3})\\s*(?:months?\\s+ago|মাস\\s+আগে|মাস\\s+আগের|महीने\\s+पहले|माह\\s+पहले)").find(normalized)?.let { m ->
            val months = m.groupValues[1].toLongOrNull()?.coerceIn(1L, 120L) ?: return@let
            val target = today.minusMonths(months)
            return dayBounds(target.minusDays(15), target.plusDays(15), "$months months ago")
        }

        // 5. N years ago
        Regex("(\\d{1,2})\\s*(?:years?\\s+ago|বছর\\s+আগে|বছর\\s+আগের|साल\\s+पहले|वर्ष\\s+पहले)").find(normalized)?.let { m ->
            val years = m.groupValues[1].toLongOrNull()?.coerceIn(1L, 30L) ?: return@let
            val target = today.minusYears(years)
            return dayBounds(target.minusDays(45), target.plusDays(45), "$years years ago")
        }

        // 6. Named relative periods
        return when {
            normalized.contains("yesterday") || normalized.contains("গতকাল") || normalized.contains("बीते कल") ||
                Regex("(?:^|\\s)कल(?:\\s|$)").containsMatchIn(normalized) -> {
                val y = today.minusDays(1)
                dayBounds(y, y, "yesterday (${y.format(DATE_BUCKET_FMT)})")
            }
            normalized.contains("day before yesterday") || normalized.contains("পরশু") || normalized.contains("परसों") -> {
                val d = today.minusDays(2)
                dayBounds(d, d, "2 days ago (${d.format(DATE_BUCKET_FMT)})")
            }
            normalized.contains("last week") || normalized.contains("গত সপ্তাহ") || normalized.contains("पिछले हफ्ते") -> {
                dayBounds(today.minusDays(10), today.minusDays(4), "last week")
            }
            normalized.contains("last month") || normalized.contains("গত মাস") || normalized.contains("पिछले महीने") -> {
                dayBounds(today.minusMonths(1).minusDays(10), today.minusMonths(1).plusDays(10), "last month")
            }
            normalized.contains("last year") || normalized.contains("গত বছর") || normalized.contains("पिछले साल") -> {
                val prevYear = today.year - 1
                dayBounds(LocalDate.of(prevYear, 1, 1), LocalDate.of(prevYear, 12, 31), "year $prevYear")
            }
            else -> null
        }
    }

    private fun charTrigrams(text: String): Set<String> {
        val clean = text.lowercase().replace(Regex("[^\\p{L}\\p{M}\\p{N}]+"), "")
        if (clean.length < 3) return if (clean.isEmpty()) emptySet() else setOf(clean)
        val out = HashSet<String>(clean.length)
        for (i in 0..(clean.length - 3)) {
            out.add(clean.substring(i, i + 3))
        }
        return out
    }

    /**
     * Scores a candidate conversation message against a Bengali/English/Hindi query using:
     * 1) Exact keyword hits
     * 2) Prefix/inflection token matching
     * 3) Cross-lingual semantic topic cluster overlap
     * 4) Character 3-gram Jaccard similarity
     * 5) Date window match boost
     */
    fun scoreConversationMatch(
        query: String,
        candidateText: String,
        candidateSearchTokens: String = "",
        candidateTimestampMs: Long = 0L,
        dateRange: HistoricalDateQuery? = null
    ): Double {
        val qTokens = tokenizeQuery(query)
        val cLower = candidateText.lowercase()
        val cTokenStr = "$cLower ${candidateSearchTokens.lowercase()}"
        val cTokens = cTokenStr
            .replace(Regex("[^\\p{L}\\p{M}\\p{N}\\s]+"), " ")
            .split(Regex("\\s+"))
            .filter { it.length >= 2 }
            .toSet()

        var score = 0.0

        // Exact & stem/prefix hits
        for (qt in qTokens) {
            if (cLower.contains(qt) || cTokens.contains(qt)) {
                score += 24.0
            } else if (qt.length >= 4 && cTokens.any { it.startsWith(qt.take(4)) || qt.startsWith(it.take(4)) }) {
                score += 12.0
            }
        }

        // Cross-lingual semantic topic overlap
        val qTopics = detectSemanticTopics(qTokens)
        if (qTopics.isNotEmpty()) {
            val cTopics = detectSemanticTopics(cTokens) +
                cTokens.filter { it.startsWith("topic_") }
            val sharedTopics = qTopics.intersect(cTopics)
            if (sharedTopics.isNotEmpty()) {
                score += sharedTopics.size * 22.0
            }
        }

        // Character 3-gram similarity for inflected Bengali/Hindi/English queries
        if (qTokens.isNotEmpty()) {
            val qGrams = charTrigrams(qTokens.joinToString(""))
            val cGrams = charTrigrams(candidateText.take(280))
            if (qGrams.isNotEmpty() && cGrams.isNotEmpty()) {
                val overlap = qGrams.count { it in cGrams }
                val jaccard = overlap.toDouble() / (qGrams.size + cGrams.size - overlap).coerceAtLeast(1)
                if (jaccard >= 0.14) {
                    score += jaccard * 30.0
                }
            }
        }

        // Temporal window match
        if (dateRange != null && candidateTimestampMs > 0L) {
            if (candidateTimestampMs in dateRange.startMs..dateRange.endMs) {
                score += 35.0
            }
        }

        return score
    }

    /**
     * Extracts structured, non-sensitive user facts, preferences, ongoing tasks, and corrections.
     */
    fun extractUserMemories(userText: String): List<ExtractedMemoryFact> {
        val clean = userText.trim()
        if (clean.isEmpty() || containsSensitiveSecret(clean)) return emptyList()

        val lower = clean.lowercase()
        val isCorrection = lower.startsWith("actually") ||
            lower.startsWith("correction") ||
            lower.startsWith("update:") ||
            lower.contains("আসলে ") ||
            lower.contains("ভুল বলেছিলাম") ||
            lower.contains("আপডেট করো") ||
            lower.contains("सही करो") ||
            lower.contains("दरअसल")

        val extracted = mutableListOf<ExtractedMemoryFact>()

        // 1. User's own name (Bengali / English / Hindi)
        val namePatterns = listOf(
            Regex("(?:আমার\\s+নাম|আমাকে\\s+ডাকবে|আমার\\s+নামটা)\\s*[:,-]?\\s*([\\p{L}\\p{M}][\\p{L}\\p{M}\\s.'-]{1,36}?)(?:\\s*(?:বলে|নামে|।|\\.|!|$))", RegexOption.IGNORE_CASE),
            Regex("(?:my\\s+name\\s+is|call\\s+me)\\s+([A-Za-z][A-Za-z\\s.'-]{1,36}?)(?:\\s*(?:\\.|!|,|$))", RegexOption.IGNORE_CASE),
            Regex("(?:मेरा\\s+नाम)\\s+([\\p{L}\\p{M}][\\p{L}\\p{M}\\s.'-]{1,36}?)(?:\\s*(?:है|।|\\.|!|$))", RegexOption.IGNORE_CASE)
        )
        for (pattern in namePatterns) {
            val match = pattern.find(clean)
            val candidate = match?.groupValues?.getOrNull(1)?.trim().orEmpty()
            if (candidate.length in 2..36 && !containsSensitiveSecret(candidate)) {
                extracted.add(
                    ExtractedMemoryFact(
                        category = CATEGORY_PERSONAL_FACT,
                        factKey = "user_name",
                        value = candidate,
                        searchKeywords = "name নাম user_name ${candidate.lowercase()}",
                        isCorrection = isCorrection
                    )
                )
                break
            }
        }

        // 2. Explicit "remember that..." / "মনে রাখো..." memory instruction
        val explicitRememberPatterns = listOf(
            Regex("(?:মনে\\s*রাখো|মনে\\s*রেখো|সেভ\\s*করে\\s*রাখো)\\s*(?:যে)?\\s*[:,-]?\\s*(.+)", RegexOption.IGNORE_CASE),
            Regex("(?:remember\\s+that|remember\\s+this|save\\s+this\\s+to\\s+memory|keep\\s+in\\s+mind\\s+that)\\s*[:,-]?\\s*(.+)", RegexOption.IGNORE_CASE),
            Regex("(?:याद\\s*रखो|याद\\s*रखना)\\s*(?:कि)?\\s*[:,-]?\\s*(.+)", RegexOption.IGNORE_CASE)
        )
        for (pattern in explicitRememberPatterns) {
            val match = pattern.find(clean)
            val note = match?.groupValues?.getOrNull(1)?.trim()?.trimEnd('.', '।', '!', '?').orEmpty()
            if (note.length in 3..180 && !containsSensitiveSecret(note)) {
                val normalizedKey = "note_${normalizeKeySlug(note).take(40)}"
                extracted.add(
                    ExtractedMemoryFact(
                        category = CATEGORY_PERSONAL_FACT,
                        factKey = normalizedKey,
                        value = note,
                        searchKeywords = buildSearchKeywords("remember মনে note $note"),
                        isCorrection = isCorrection
                    )
                )
                break
            }
        }

        // 3. Language preference
        when {
            lower.contains("বাংলায় কথা বল") || lower.contains("বাংলায় কথা বল") ||
                lower.contains("speak in bengali") || lower.contains("talk in bangla") -> {
                extracted.add(
                    ExtractedMemoryFact(
                        category = CATEGORY_LANGUAGE,
                        factKey = "preferred_language",
                        value = "bn-BD (Bengali)",
                        searchKeywords = "language ভাষা bengali bangla বাংলা bn-bd",
                        isCorrection = isCorrection
                    )
                )
            }
            lower.contains("speak in english") || lower.contains("talk in english") ||
                lower.contains("ইংরেজিতে কথা বল") -> {
                extracted.add(
                    ExtractedMemoryFact(
                        category = CATEGORY_LANGUAGE,
                        factKey = "preferred_language",
                        value = "en-US (English)",
                        searchKeywords = "language ভাষা english ইংরেজি en-us",
                        isCorrection = isCorrection
                    )
                )
            }
            lower.contains("speak in hindi") || lower.contains("हिंदी में बात") ||
                lower.contains("হিন্দিতে কথা বল") -> {
                extracted.add(
                    ExtractedMemoryFact(
                        category = CATEGORY_LANGUAGE,
                        factKey = "preferred_language",
                        value = "hi-IN (Hindi)",
                        searchKeywords = "language ভাষা hindi হিন্দি हिंदी hi-in",
                        isCorrection = isCorrection
                    )
                )
            }
        }

        // 4. User preference ("আমি ... পছন্দ করি" / "I prefer ..." / "I like ...")
        val preferencePatterns = listOf(
            Regex("(?:আমি)\\s+(.{3,90}?)\\s+(?:পছন্দ\\s*করি|ভালোবাসি)", RegexOption.IGNORE_CASE),
            Regex("(?:i\\s+prefer|i\\s+really\\s+like|my\\s+favorite\\s+[a-z]+\\s+is)\\s+(.{3,90}?)(?:\\.|!|$)", RegexOption.IGNORE_CASE),
            Regex("(?:मुझे)\\s+(.{3,90}?)\\s+(?:पसंद\\s*है)", RegexOption.IGNORE_CASE)
        )
        for (pattern in preferencePatterns) {
            val match = pattern.find(clean)
            val pref = match?.groupValues?.getOrNull(1)?.trim().orEmpty()
            if (pref.length in 3..90 && !containsSensitiveSecret(pref)) {
                extracted.add(
                    ExtractedMemoryFact(
                        category = CATEGORY_PREFERENCE,
                        factKey = "pref_${normalizeKeySlug(pref).take(36)}",
                        value = pref,
                        searchKeywords = buildSearchKeywords("preference পছন্দ favorite $pref"),
                        isCorrection = isCorrection
                    )
                )
                break
            }
        }

        // 5. Ongoing tasks / pending work
        val taskPatterns = listOf(
            Regex("(?:আমার\\s+কাজ\\s+বাকি\\s+আছে|চলমান\\s+কাজ|আমাকে\\s+শেষ\\s+করতে\\s+হবে)\\s*[:,-]?\\s*(.+)", RegexOption.IGNORE_CASE),
            Regex("(?:ongoing\\s+task|i\\s+need\\s+to\\s+finish|my\\s+pending\\s+task\\s+is|todo)\\s*[:,-]?\\s*(.+)", RegexOption.IGNORE_CASE),
            Regex("(?:मुझे\\s+पूरा\\s+करना\\s+है|मेरा\\s+बाकी\\s+काम)\\s*[:,-]?\\s*(.+)", RegexOption.IGNORE_CASE)
        )
        for (pattern in taskPatterns) {
            val match = pattern.find(clean)
            val task = match?.groupValues?.getOrNull(1)?.trim()?.trimEnd('.', '।', '!', '?').orEmpty()
            if (task.length in 3..160 && !containsSensitiveSecret(task)) {
                extracted.add(
                    ExtractedMemoryFact(
                        category = CATEGORY_ONGOING_TASK,
                        factKey = "task_${normalizeKeySlug(task).take(36)}",
                        value = task,
                        searchKeywords = buildSearchKeywords("task কাজ todo ongoing pending $task"),
                        isCorrection = isCorrection
                    )
                )
                break
            }
        }

        return extracted.distinctBy { it.factKey }
    }

    /**
     * Detects whether the user is asking about past conversations (including 15 days, 6 months,
     * or years ago) or saved personal memory.
     */
    fun isMemoryRecallQuery(userText: String): Boolean {
        val lower = normalizeIndicDigits(userText).trim().lowercase()
        if (lower.isEmpty()) return false
        if (parseHistoricalDateRange(lower) != null && (
                lower.contains("talk") || lower.contains("say") || lower.contains("said") ||
                    lower.contains("discuss") || lower.contains("chat") || lower.contains("conversation") ||
                    lower.contains("remember") || lower.contains("told") ||
                    lower.contains("বলেছিলাম") || lower.contains("কথা") || lower.contains("আলোচনা") ||
                    lower.contains("মনে") || lower.contains("কী হয়েছিল") || lower.contains("কি হয়েছিল") ||
                    lower.contains("बात") || lower.contains("कहा") || lower.contains("बताया") ||
                    lower.contains("याद") || lower.contains("चर्चा")
                )
        ) {
            return true
        }
        return lower.contains("আগে কী বলেছিলাম") ||
            lower.contains("আগে কি বলেছিলাম") ||
            lower.contains("গতবার কী বলেছিলাম") ||
            lower.contains("কী কথা হয়েছিল") ||
            lower.contains("কি কথা হয়েছিল") ||
            lower.contains("কী কথা হয়েছিল") ||
            lower.contains("আমার সম্পর্কে কী জানো") ||
            lower.contains("আমার সম্পর্কে কি জানো") ||
            lower.contains("আমার নাম কী") ||
            lower.contains("আমার নাম কি") ||
            lower.contains("তুমি কী মনে রেখেছ") ||
            lower.contains("তুমি কি মনে রেখেছ") ||
            lower.contains("মনে আছে কি") ||
            lower.contains("মেমোরিতে কী আছে") ||
            lower.contains("আগের কথোপকথন") ||
            lower.contains("what did i say") ||
            lower.contains("what did we talk about") ||
            lower.contains("what did we discuss") ||
            lower.contains("what did i tell you") ||
            lower.contains("what do you remember") ||
            lower.contains("what do you know about me") ||
            lower.contains("what is my name") ||
            lower.contains("do you remember") ||
            lower.contains("my previous message") ||
            lower.contains("conversation history") ||
            lower.contains("मेरा नाम क्या है") ||
            lower.contains("मैंने पहले क्या कहा") ||
            lower.contains("क्या बात हुई थी") ||
            lower.contains("तुम्हें क्या याद है")
    }

    /**
     * Offline-first local search & recall over saved memories and archived conversations.
     * STRICT HONESTY RULE: Never invents or guesses past conversations. If a specific date
     * or topic is asked and zero archived records match, clearly reports it was not found.
     */
    fun answerMemoryRecallLocally(
        query: String,
        memories: List<DecryptedMemoryRecord>,
        candidateMessages: List<ConversationEntity>,
        language: String = "bn-BD",
        nowMs: Long = System.currentTimeMillis()
    ): LocalMemoryRecallResult {
        if (!isMemoryRecallQuery(query)) {
            return LocalMemoryRecallResult(isMemoryQuery = false, handledOffline = false, replyText = "")
        }

        val isBn = language.startsWith("bn", ignoreCase = true) || query.any { it in '\u0980'..'\u09FF' }
        val isHi = !isBn && (language.startsWith("hi", ignoreCase = true) || query.any { it in '\u0900'..'\u097F' })
        val lower = query.lowercase()
        val dateRange = parseHistoricalDateRange(query, nowMs)

        // Direct "What is my name?" check
        if (lower.contains("আমার নাম") || lower.contains("my name") || lower.contains("मेरा नाम")) {
            val nameFact = memories.firstOrNull { it.factKey == "user_name" }
            if (nameFact != null) {
                val reply = when {
                    isBn -> "আপনার নাম ${nameFact.value}।"
                    isHi -> "आपका नाम ${nameFact.value} है।"
                    else -> "Your name is ${nameFact.value}."
                }
                return LocalMemoryRecallResult(
                    isMemoryQuery = true,
                    handledOffline = true,
                    replyText = reply,
                    matchedFacts = listOf(nameFact),
                    foundEvidence = true
                )
            }
            val notFoundName = when {
                isBn -> "লোকাল মেমোরিতে আপনার নাম এখনো সংরক্ষিত পাওয়া যায়নি।"
                isHi -> "स्थानीय मेमोरी में आपका नाम अभी सेव नहीं मिला।"
                else -> "I could not find your name saved in local memory yet."
            }
            return LocalMemoryRecallResult(
                isMemoryQuery = true,
                handledOffline = true,
                replyText = notFoundName,
                foundEvidence = false
            )
        }

        val queryTokens = tokenizeQuery(query)
        val hasSpecificTopicOrDate = dateRange != null || queryTokens.isNotEmpty()

        // Filter out the current recall question itself and any encrypted ciphertext that wasn't decrypted
        val cleanCandidates = candidateMessages.filter {
            !it.isEncrypted &&
                it.text.isNotBlank() &&
                !it.text.equals(query.trim(), ignoreCase = true) &&
                !containsSensitiveSecret(it.text)
        }

        // Strict date filtering when user asks about a specific historical time window
        val dateFilteredCandidates = if (dateRange != null) {
            cleanCandidates.filter { it.createdAtMs in dateRange.startMs..dateRange.endMs }
        } else {
            cleanCandidates
        }

        val scoredMessages = dateFilteredCandidates.map { msg ->
            val score = scoreConversationMatch(
                query = query,
                candidateText = msg.text,
                candidateSearchTokens = msg.searchTokens,
                candidateTimestampMs = msg.createdAtMs,
                dateRange = dateRange
            )
            msg to score
        }

        val matchedMessages = when {
            dateRange != null && queryTokens.isEmpty() -> {
                // Asking "what did we talk about 15 days ago?" without extra keyword
                dateFilteredCandidates.sortedByDescending { it.createdAtMs }.take(4)
            }
            queryTokens.isNotEmpty() -> {
                // Strictly require real keyword/semantic score (> 0) — NEVER fall back to unrelated rows
                val threshold = if (dateRange != null) 45.0 else 10.0
                scoredMessages
                    .filter { it.second >= threshold }
                    .sortedByDescending { it.second }
                    .map { it.first }
                    .take(4)
            }
            else -> {
                cleanCandidates
                    .filter { it.role == "user" }
                    .sortedByDescending { it.createdAtMs }
                    .take(3)
            }
        }

        // Rank memories — strictly require token/topic match when specific topic was requested
        val rankedMemories = memories
            .filter { it.userApproved && it.value.isNotBlank() && !containsSensitiveSecret(it.value) }
            .map { rec ->
                val haystack = "${rec.value} ${rec.searchKeywords} ${rec.category}".lowercase()
                val tokenHits = queryTokens.count { haystack.contains(it) }
                val score = tokenHits * 20 + if (dateRange == null && queryTokens.isEmpty()) rec.usageCount.coerceAtMost(10) else 0
                rec to score
            }
            .filter { (_, score) ->
                if (dateRange != null) false // Date-specific conversation recall must come from original archive
                else if (queryTokens.isNotEmpty()) score >= 20
                else score > 0
            }
            .sortedByDescending { it.second }
            .map { it.first }
            .take(5)

        if (rankedMemories.isEmpty() && matchedMessages.isEmpty()) {
            val reply = when {
                dateRange != null && isBn ->
                    "সংরক্ষিত কথোপকথনের ইতিহাসে (${dateRange.label}) এই সময়ের কোনো রেকর্ড খুঁজে পাওয়া যায়নি।"
                dateRange != null && isHi ->
                    "स्थानीय इतिहास में (${dateRange.label}) इस समय की कोई बातचीत नहीं मिली।"
                dateRange != null ->
                    "I could not find any saved conversation records from ${dateRange.label} in local history."
                hasSpecificTopicOrDate && isBn ->
                    "সংরক্ষিত কথোপকথন ও লোকাল মেমোরিতে এই বিষয়ে কোনো তথ্য খুঁজে পাওয়া যায়নি।"
                hasSpecificTopicOrDate && isHi ->
                    "स्थानीय बातचीत और मेमोरी में इस विषय के बारे में कोई जानकारी नहीं मिली।"
                hasSpecificTopicOrDate ->
                    "I could not find any information about that topic in your saved conversation history."
                isBn ->
                    "এখনো লোকাল মেমোরিতে সংরক্ষিত কোনো তথ্য বা আগের কথোপকথন নেই।"
                isHi ->
                    "अभी तक स्थानीय मेमोरी में कोई सहेजी गई बातचीत या जानकारी नहीं है।"
                else ->
                    "There are no saved local memories or previous conversations yet."
            }
            return LocalMemoryRecallResult(
                isMemoryQuery = true,
                handledOffline = true,
                replyText = reply,
                foundEvidence = false
            )
        }

        val parts = mutableListOf<String>()
        if (rankedMemories.isNotEmpty()) {
            val summary = rankedMemories.joinToString("; ") { it.value }
            parts.add(
                when {
                    isBn -> "লোকাল মেমোরিতে যা মনে আছে: $summary।"
                    isHi -> "स्थानीय मेमोरी में सहेजी जानकारी: $summary।"
                    else -> "From local memory: $summary."
                }
            )
        }
        if (matchedMessages.isNotEmpty()) {
            val top = matchedMessages.first()
            val dateLabel = top.dateBucket.ifBlank { formatDateBucket(top.createdAtMs) }
            val snippet = top.text.take(180)
            parts.add(
                when {
                    isBn -> "আগে ($dateLabel) আপনি বলেছিলেন: \"$snippet\"।"
                    isHi -> "पहले ($dateLabel) बातचीत में कहा गया था: \"$snippet\"।"
                    else -> "Earlier ($dateLabel) you said: \"$snippet\"."
                }
            )
        }

        return LocalMemoryRecallResult(
            isMemoryQuery = true,
            handledOffline = true,
            replyText = parts.joinToString(" "),
            matchedFacts = rankedMemories,
            matchedMessages = matchedMessages,
            foundEvidence = true
        )
    }

    /**
     * Builds a compact, strictly bounded context snippet for Gemini from relevant local memories,
     * recent turns, and (when relevant) verified historical archive evidence.
     */
    fun buildCompactContextForGemini(
        query: String,
        memories: List<DecryptedMemoryRecord>,
        recentMessages: List<ConversationEntity>,
        maxChars: Int = MAX_COMPACT_CONTEXT_CHARS,
        archivedMatches: List<ConversationEntity> = emptyList(),
        isHistoricalQuery: Boolean = false
    ): String {
        val tokens = tokenizeQuery(query)
        val topMemories = memories
            .filter { it.userApproved && it.value.isNotBlank() && !containsSensitiveSecret(it.value) }
            .sortedByDescending { rec ->
                val hay = "${rec.value} ${rec.searchKeywords}".lowercase()
                val relevance = tokens.count { hay.contains(it) } * 15
                val priority = when (rec.category) {
                    CATEGORY_PERSONAL_FACT -> 10
                    CATEGORY_ONGOING_TASK -> 9
                    CATEGORY_LANGUAGE -> 8
                    CATEGORY_PREFERENCE -> 6
                    else -> 2
                }
                relevance + priority + rec.usageCount.coerceAtMost(8)
            }
            .take(4)

        val sb = StringBuilder()
        if (topMemories.isNotEmpty()) {
            sb.append("[LocalMemory] ")
            sb.append(topMemories.joinToString(" | ") { "${it.category}:${it.value.take(70)}" })
        }

        val cleanArchive = archivedMatches.filter { !it.isEncrypted && !containsSensitiveSecret(it.text) }.take(3)
        if (cleanArchive.isNotEmpty()) {
            if (sb.isNotEmpty()) sb.append("\n")
            sb.append("[ArchiveEvidence] ")
            sb.append(
                cleanArchive.joinToString(" / ") { m ->
                    val d = m.dateBucket.ifBlank { formatDateBucket(m.createdAtMs) }
                    "[$d ${m.role}]:${m.text.take(100)}"
                }
            )
        } else if (isHistoricalQuery) {
            if (sb.isNotEmpty()) sb.append("\n")
            sb.append("[ArchiveEvidence] NOT_FOUND (Do NOT invent or guess past conversations; state honestly not found)")
        }

        val relevantRecent = recentMessages
            .filter { !it.isEncrypted && !containsSensitiveSecret(it.text) }
            .sortedByDescending { it.createdAtMs }
            .take(3)
            .reversed()

        if (relevantRecent.isNotEmpty()) {
            if (sb.isNotEmpty()) sb.append("\n")
            sb.append("[Recent] ")
            sb.append(relevantRecent.joinToString(" / ") { "${it.role}:${it.text.take(60)}" })
        }

        val effectiveMax = if (isHistoricalQuery) maxChars.coerceAtLeast(MAX_HISTORICAL_CONTEXT_CHARS) else maxChars
        val result = sb.toString().trim()
        return if (result.length <= effectiveMax) result else result.take(effectiveMax).trimEnd()
    }

    fun normalizeKeySlug(input: String): String {
        return input.trim()
            .lowercase()
            .replace(Regex("[^\\p{L}\\p{M}\\p{N}]+"), "_")
            .trim('_')
            .ifEmpty { "entry" }
    }

    fun buildSearchKeywords(text: String): String {
        return text.trim()
            .lowercase()
            .replace(Regex("[^\\p{L}\\p{M}\\p{N}\\s]+"), " ")
            .split(Regex("\\s+"))
            .filter { it.length >= 2 }
            .distinct()
            .take(18)
            .joinToString(" ")
    }

    fun tokenizeQuery(query: String): List<String> {
        return normalizeIndicDigits(query)
            .lowercase()
            .replace(Regex("[^\\p{L}\\p{M}\\p{N}\\s]+"), " ")
            .split(Regex("\\s+"))
            .filter { it.length >= 2 && it !in STOP_WORDS && !it.all { ch -> ch.isDigit() } }
            .distinct()
            .take(8)
    }
}

/**
 * Room-backed permanent, encrypted, transactionally-verified local conversation & long-term memory repository.
 *
 * - NEVER prunes or automatically deletes old messages (arbitrary 500-message cap permanently removed).
 * - Encrypts both conversations and memory facts at rest via Android Keystore-backed AES-256-GCM.
 * - Uses serialized write queue + transactional read-back verification + encrypted fallback spool
 *   so failed writes or interrupted background sessions never silently drop messages.
 * - Supports full-history paginated search across 10,000+ / 100,000+ messages without loading all into RAM.
 * - Supports cross-platform PBKDF2-SHA256 + AES-256-GCM encrypted backup export and restore.
 */
class LocalMemoryRepository(
    private val database: ZoniDatabase,
    private val secureKeyManager: SecureKeyManager,
    private val appContext: Context? = null
) {
    private val conversationDao = database.conversationDao()
    private val memoryDao = database.memoryDao()
    private val pendingWriteDao = database.pendingWriteDao()
    private val writeMutex = Mutex()

    @Volatile
    private var lastWriteError: String = ""

    private val pendingSpool: EncryptedPendingWriteSpool? = appContext?.let { ctx ->
        EncryptedPendingWriteSpool(
            spoolFile = File(ctx.filesDir, "zoni_pending_writes_spool.jsonl"),
            encryptor = { plain -> secureKeyManager.encryptLocalMemoryText(plain) },
            decryptor = { stored, enc -> secureKeyManager.decryptLocalMemoryText(stored, enc) }
        )
    }

    private fun decryptEntity(entity: ConversationEntity): DecryptedConversationRecord {
        val plain = if (entity.isEncrypted) {
            secureKeyManager.decryptLocalMemoryText(entity.text, true)
        } else {
            entity.text
        }
        return DecryptedConversationRecord(
            id = entity.id,
            conversationId = entity.conversationId.ifBlank { "default" },
            role = entity.role,
            text = plain,
            language = entity.language.ifBlank { "bn-BD" },
            createdAtMs = entity.createdAtMs,
            inputType = entity.inputType.ifBlank { "text" },
            commandName = entity.commandName,
            executionStatus = entity.executionStatus,
            dateBucket = entity.dateBucket.ifBlank { LocalMemoryLogic.formatDateBucket(entity.createdAtMs) }
        )
    }

    private fun toDecryptedConversationEntity(rec: DecryptedConversationRecord): ConversationEntity {
        return ConversationEntity(
            id = rec.id,
            role = rec.role,
            text = rec.text,
            language = rec.language,
            createdAtMs = rec.createdAtMs,
            conversationId = rec.conversationId,
            inputType = rec.inputType,
            commandName = rec.commandName,
            executionStatus = rec.executionStatus,
            dateBucket = rec.dateBucket,
            searchTokens = LocalMemoryLogic.buildIndexedSearchTokens(rec.text, rec.commandName),
            isEncrypted = false
        )
    }

    /**
     * Backward-compatible boolean save entrypoint. Always persists permanently with transactional
     * write verification and automatic recovery queuing on failure.
     */
    suspend fun saveMessage(
        role: String,
        text: String,
        language: String = "bn-BD",
        id: String = UUID.randomUUID().toString(),
        createdAtMs: Long = System.currentTimeMillis(),
        conversationId: String = "default",
        inputType: String = "text",
        commandName: String = "",
        executionStatus: String = ""
    ): Boolean {
        val res = saveMessageVerified(
            role = role,
            text = text,
            language = language,
            id = id,
            createdAtMs = createdAtMs,
            conversationId = conversationId,
            inputType = inputType,
            commandName = commandName,
            executionStatus = executionStatus
        )
        return res.success && res.verified
    }

    /**
     * Transactionally saves a finalized conversation message (encrypted at rest via Android Keystore)
     * and verifies the row exists in Room before returning.
     *
     * If storage is low or SQLite fails, spools the message into the encrypted recovery queue
     * instead of silently discarding it, and returns an honest failure status.
     */
    suspend fun saveMessageVerified(
        role: String,
        text: String,
        language: String = "bn-BD",
        id: String = UUID.randomUUID().toString(),
        createdAtMs: Long = System.currentTimeMillis(),
        conversationId: String = "default",
        inputType: String = "text",
        commandName: String = "",
        executionStatus: String = ""
    ): WriteVerificationResult = withContext(Dispatchers.IO) {
        val safeText = LocalMemoryLogic.sanitizeForStorage(text)
            ?: return@withContext WriteVerificationResult(
                success = false,
                verified = false,
                messageId = id,
                conversationId = conversationId,
                errorCode = "SENSITIVE_OR_EMPTY_BLOCKED",
                errorMessage = "Message omitted by privacy filter or empty."
            )

        val safeConvId = conversationId.ifBlank { "conv_${LocalMemoryLogic.formatDateBucket(createdAtMs)}" }
        val safeRole = if (role == "assistant") "assistant" else "user"
        val safeInputType = if (inputType == "voice") "voice" else "text"
        val safeLang = language.ifBlank { "bn-BD" }
        val dateBucket = LocalMemoryLogic.formatDateBucket(createdAtMs)
        val searchTokens = LocalMemoryLogic.buildIndexedSearchTokens(safeText, commandName)

        val record = DecryptedConversationRecord(
            id = id,
            conversationId = safeConvId,
            role = safeRole,
            text = safeText,
            language = safeLang,
            createdAtMs = createdAtMs,
            inputType = safeInputType,
            commandName = commandName.take(80),
            executionStatus = executionStatus.take(48),
            dateBucket = dateBucket
        )

        writeMutex.withLock {
            // Opportunistically flush any previously spooled messages first
            flushPendingSpoolLocked()

            // Check internal storage space before write
            val availableBytes = appContext?.let { ZoniDatabase.getAvailableInternalStorageBytes(it) }
                ?: Long.MAX_VALUE
            if (availableBytes < ZoniDatabase.MIN_SAFE_STORAGE_BYTES) {
                val queued = pendingSpool?.append(record) ?: false
                lastWriteError = "LOW_STORAGE: Less than 16 MB internal storage available."
                return@withLock WriteVerificationResult(
                    success = false,
                    verified = false,
                    messageId = id,
                    conversationId = safeConvId,
                    errorCode = "LOW_STORAGE",
                    errorMessage = lastWriteError,
                    queuedForRecovery = queued
                )
            }

            try {
                val (storedText, encrypted) = secureKeyManager.encryptLocalMemoryText(safeText)
                val entity = ConversationEntity(
                    id = id,
                    role = safeRole,
                    text = storedText,
                    language = safeLang,
                    createdAtMs = createdAtMs,
                    conversationId = safeConvId,
                    inputType = safeInputType,
                    commandName = record.commandName,
                    executionStatus = record.executionStatus,
                    dateBucket = dateBucket,
                    searchTokens = searchTokens,
                    isEncrypted = encrypted
                )

                var verified = false
                database.withTransaction {
                    conversationDao.insertMessage(entity)
                    verified = conversationDao.existsById(id) > 0
                    if (!verified) {
                        throw IllegalStateException("Write verification check failed for message row.")
                    }
                    if (safeRole == "user") {
                        val extracted = LocalMemoryLogic.extractUserMemories(safeText)
                        for (fact in extracted) {
                            upsertMemoryFactInternal(
                                fact = fact,
                                sourceConversationId = safeConvId,
                                sourceMessageId = id
                            )
                        }
                    }
                }

                lastWriteError = ""
                WriteVerificationResult(
                    success = verified,
                    verified = verified,
                    messageId = id,
                    conversationId = safeConvId
                )
            } catch (e: Exception) {
                val code = when (e) {
                    is SQLiteFullException -> "SQLITE_FULL"
                    is SQLiteDatabaseCorruptException -> "SQLITE_CORRUPT"
                    else -> "DB_WRITE_FAILED"
                }
                lastWriteError = "$code: ${e.javaClass.simpleName}"
                val spooled = pendingSpool?.append(record) ?: false
                // Also try storing inside Room pending table if error was transient
                if (!spooled) {
                    try {
                        val payloadJson = JSONObject()
                            .put("id", record.id)
                            .put("conversationId", record.conversationId)
                            .put("role", record.role)
                            .put("text", record.text)
                            .put("language", record.language)
                            .put("createdAtMs", record.createdAtMs)
                            .put("inputType", record.inputType)
                            .put("commandName", record.commandName)
                            .put("executionStatus", record.executionStatus)
                            .put("dateBucket", record.dateBucket)
                            .toString()
                        val (encPayload, isEnc) = secureKeyManager.encryptLocalMemoryText(payloadJson)
                        pendingWriteDao.enqueue(
                            PendingWriteEntity(
                                id = record.id,
                                payloadEncrypted = encPayload,
                                isEncrypted = isEnc,
                                retryCount = 1,
                                lastError = code,
                                createdAtMs = record.createdAtMs
                            )
                        )
                    } catch (_: Exception) {
                        // Already captured in lastWriteError
                    }
                }
                WriteVerificationResult(
                    success = false,
                    verified = false,
                    messageId = id,
                    conversationId = safeConvId,
                    errorCode = code,
                    errorMessage = lastWriteError,
                    queuedForRecovery = spooled
                )
            }
        }
    }

    /**
     * Flushes any pending conversation writes saved during interrupted sessions or transient DB errors.
     */
    suspend fun recoverPendingWrites(): Int = withContext(Dispatchers.IO) {
        writeMutex.withLock {
            flushPendingSpoolLocked()
        }
    }

    private suspend fun flushPendingSpoolLocked(): Int {
        var recovered = 0

        // 1. Recover from encrypted file spool
        val spool = pendingSpool
        if (spool != null) {
            val spooledRecords = spool.readAll()
            if (spooledRecords.isNotEmpty()) {
                val remaining = mutableListOf<DecryptedConversationRecord>()
                for (rec in spooledRecords) {
                    try {
                        val (storedText, encrypted) = secureKeyManager.encryptLocalMemoryText(rec.text)
                        val entity = ConversationEntity(
                            id = rec.id,
                            role = rec.role,
                            text = storedText,
                            language = rec.language,
                            createdAtMs = rec.createdAtMs,
                            conversationId = rec.conversationId,
                            inputType = rec.inputType,
                            commandName = rec.commandName,
                            executionStatus = rec.executionStatus,
                            dateBucket = rec.dateBucket.ifBlank { LocalMemoryLogic.formatDateBucket(rec.createdAtMs) },
                            searchTokens = LocalMemoryLogic.buildIndexedSearchTokens(rec.text, rec.commandName),
                            isEncrypted = encrypted
                        )
                        database.withTransaction {
                            conversationDao.insertMessage(entity)
                        }
                        if (conversationDao.existsById(rec.id) > 0) {
                            recovered++
                        } else {
                            remaining.add(rec)
                        }
                    } catch (_: Exception) {
                        remaining.add(rec)
                    }
                }
                spool.rewriteRemaining(remaining)
            }
        }

        // 2. Recover from Room pending_conversation_writes table
        try {
            val pendingRows = pendingWriteDao.getPendingBatch(50)
            for (row in pendingRows) {
                val plainJson = secureKeyManager.decryptLocalMemoryText(row.payloadEncrypted, row.isEncrypted)
                if (plainJson.isBlank()) {
                    pendingWriteDao.deleteById(row.id)
                    continue
                }
                val obj = JSONObject(plainJson)
                val text = LocalMemoryLogic.sanitizeForStorage(obj.optString("text"))
                if (text == null) {
                    pendingWriteDao.deleteById(row.id)
                    continue
                }
                val ts = obj.optLong("createdAtMs", row.createdAtMs)
                val cmdName = obj.optString("commandName", "")
                val (storedText, encrypted) = secureKeyManager.encryptLocalMemoryText(text)
                database.withTransaction {
                    conversationDao.insertMessage(
                        ConversationEntity(
                            id = row.id,
                            role = obj.optString("role", "user"),
                            text = storedText,
                            language = obj.optString("language", "bn-BD"),
                            createdAtMs = ts,
                            conversationId = obj.optString("conversationId", "recovered"),
                            inputType = obj.optString("inputType", "voice"),
                            commandName = cmdName,
                            executionStatus = obj.optString("executionStatus", ""),
                            dateBucket = obj.optString("dateBucket", LocalMemoryLogic.formatDateBucket(ts)),
                            searchTokens = LocalMemoryLogic.buildIndexedSearchTokens(text, cmdName),
                            isEncrypted = encrypted
                        )
                    )
                    pendingWriteDao.deleteById(row.id)
                }
                recovered++
            }
        } catch (_: Exception) {
            // Keep pending items intact for next recovery attempt
        }

        return recovered
    }

    suspend fun recordFrequentCommand(
        commandLabel: String,
        sourceConversationId: String = ""
    ): Boolean = withContext(Dispatchers.IO) {
        val safe = LocalMemoryLogic.sanitizeForStorage(commandLabel) ?: return@withContext false
        if (safe.length < 3) return@withContext false
        upsertMemoryFact(
            fact = ExtractedMemoryFact(
                category = LocalMemoryLogic.CATEGORY_FREQUENT_COMMAND,
                factKey = "cmd_${LocalMemoryLogic.normalizeKeySlug(safe).take(36)}",
                value = safe.take(90),
                searchKeywords = LocalMemoryLogic.buildSearchKeywords("command $safe")
            ),
            sourceConversationId = sourceConversationId
        )
    }

    suspend fun upsertMemoryFact(
        fact: ExtractedMemoryFact,
        sourceConversationId: String = "",
        sourceMessageId: String = ""
    ): Boolean = withContext(Dispatchers.IO) {
        if (LocalMemoryLogic.containsSensitiveSecret(fact.value)) return@withContext false
        try {
            upsertMemoryFactInternal(fact, sourceConversationId, sourceMessageId)
            true
        } catch (_: Exception) {
            false
        }
    }

    /**
     * Updates an existing structured memory fact while preserving correction history and linking
     * to the new source conversation — NEVER modifies or deletes the original conversation archive.
     */
    suspend fun correctMemoryFact(
        factKey: String,
        newValue: String,
        sourceConversationId: String = "",
        sourceMessageId: String = ""
    ): Boolean = withContext(Dispatchers.IO) {
        val safeVal = LocalMemoryLogic.sanitizeForStorage(newValue) ?: return@withContext false
        try {
            val existing = memoryDao.findByFactKey(factKey)
            val category = existing?.category ?: LocalMemoryLogic.CATEGORY_PERSONAL_FACT
            upsertMemoryFactInternal(
                fact = ExtractedMemoryFact(
                    category = category,
                    factKey = factKey,
                    value = safeVal,
                    searchKeywords = LocalMemoryLogic.buildSearchKeywords("$factKey $safeVal"),
                    isCorrection = true
                ),
                sourceConversationId = sourceConversationId,
                sourceMessageId = sourceMessageId
            )
            true
        } catch (_: Exception) {
            false
        }
    }

    private suspend fun upsertMemoryFactInternal(
        fact: ExtractedMemoryFact,
        sourceConversationId: String,
        sourceMessageId: String
    ) {
        val now = System.currentTimeMillis()
        val existing = memoryDao.findByFactKey(fact.factKey)
        val (storedVal, encrypted) = secureKeyManager.encryptLocalMemoryText(fact.value)
        val entity = if (existing != null) {
            val prevPlain = secureKeyManager.decryptLocalMemoryText(existing.valueEncrypted, existing.isEncrypted)
            val updatedCorrections = if (prevPlain.isNotBlank() && prevPlain != fact.value) {
                appendCorrectionHistory(existing.correctionHistoryJson, prevPlain, now, existing.sourceConversationId)
            } else {
                existing.correctionHistoryJson
            }
            existing.copy(
                category = fact.category,
                valueEncrypted = storedVal,
                isEncrypted = encrypted,
                searchKeywords = fact.searchKeywords,
                usageCount = existing.usageCount + 1,
                updatedAtMs = now,
                sourceConversationId = sourceConversationId.ifBlank { existing.sourceConversationId },
                sourceMessageId = sourceMessageId.ifBlank { existing.sourceMessageId },
                status = "active",
                correctionHistoryJson = updatedCorrections
            )
        } else {
            MemoryEntity(
                id = UUID.randomUUID().toString(),
                category = fact.category,
                factKey = fact.factKey,
                valueEncrypted = storedVal,
                isEncrypted = encrypted,
                searchKeywords = fact.searchKeywords,
                usageCount = 1,
                userApproved = true,
                createdAtMs = now,
                updatedAtMs = now,
                sourceConversationId = sourceConversationId,
                sourceMessageId = sourceMessageId,
                status = "active",
                correctionHistoryJson = "[]"
            )
        }
        memoryDao.upsertMemory(entity)
    }

    private fun appendCorrectionHistory(
        existingJson: String,
        previousValue: String,
        replacedAtMs: Long,
        previousConversationId: String
    ): String {
        val arr = try {
            JSONArray(existingJson.ifBlank { "[]" })
        } catch (_: Exception) {
            JSONArray()
        }
        arr.put(
            JSONObject()
                .put("previousValue", previousValue.take(160))
                .put("replacedAtMs", replacedAtMs)
                .put("sourceConversationId", previousConversationId)
        )
        // Bound correction metadata per entry (archive remains 100% permanent)
        val trimmed = JSONArray()
        val start = (arr.length() - 10).coerceAtLeast(0)
        for (i in start until arr.length()) {
            trimmed.put(arr.get(i))
        }
        return trimmed.toString()
    }

    /**
     * Loads a page of recent conversations decrypted transparently (never loads entire DB into RAM).
     */
    suspend fun loadRecentConversations(limit: Int = 60, offset: Int = 0): List<ConversationEntity> =
        withContext(Dispatchers.IO) {
            try {
                conversationDao.getRecentMessagesPaged(limit.coerceIn(1, 200), offset.coerceAtLeast(0))
                    .reversed()
                    .map { toDecryptedConversationEntity(decryptEntity(it)) }
            } catch (_: Exception) {
                emptyList()
            }
        }

    /**
     * Paginated full-history search by keyword, topic, semantic synonyms, date bucket, date range,
     * and input type across unlimited messages without loading all rows into RAM.
     */
    suspend fun searchConversationsPaged(
        query: String = "",
        dateBucket: String = "",
        startMs: Long = 0L,
        endMs: Long = 0L,
        inputType: String = "",
        limit: Int = 40,
        offset: Int = 0
    ): PaginatedArchiveSearchResult = withContext(Dispatchers.IO) {
        val safeLimit = limit.coerceIn(1, 100)
        val safeOffset = offset.coerceAtLeast(0)
        val parsedDateRange = if (startMs <= 0L && endMs <= 0L && dateBucket.isBlank() && query.isNotBlank()) {
            LocalMemoryLogic.parseHistoricalDateRange(query)
        } else {
            null
        }
        val effectiveStart = if (startMs > 0L) startMs else (parsedDateRange?.startMs ?: 0L)
        val effectiveEnd = if (endMs > 0L) endMs else (parsedDateRange?.endMs ?: 0L)

        try {
            val rawRows = if (dateBucket.isNotBlank() && query.isBlank()) {
                conversationDao.getMessagesByDateBucketPaged(dateBucket, safeLimit + 1, safeOffset)
            } else {
                val tokens = LocalMemoryLogic.tokenizeQuery(query)
                val topics = LocalMemoryLogic.detectSemanticTopics(tokens).toList()
                val searchTerms = (tokens + topics).distinct()
                conversationDao.searchMessagesPaged(
                    t1 = searchTerms.getOrElse(0) { "" },
                    t2 = searchTerms.getOrElse(1) { "" },
                    t3 = searchTerms.getOrElse(2) { "" },
                    t4 = searchTerms.getOrElse(3) { "" },
                    startMs = effectiveStart,
                    endMs = effectiveEnd,
                    inputType = inputType,
                    limit = safeLimit + 1,
                    offset = safeOffset
                )
            }

            val hasMore = rawRows.size > safeLimit
            val pageDecrypted = rawRows.take(safeLimit).map { decryptEntity(it) }
                .filter { it.text.isNotBlank() }

            val ranked = if (query.isNotBlank() && dateBucket.isBlank()) {
                pageDecrypted.sortedByDescending { rec ->
                    LocalMemoryLogic.scoreConversationMatch(
                        query = query,
                        candidateText = rec.text,
                        candidateTimestampMs = rec.createdAtMs,
                        dateRange = parsedDateRange
                    )
                }
            } else {
                pageDecrypted
            }

            PaginatedArchiveSearchResult(
                messages = ranked,
                totalReturned = ranked.size,
                hasMore = hasMore,
                dateRangeApplied = parsedDateRange
            )
        } catch (_: Exception) {
            PaginatedArchiveSearchResult(emptyList(), 0, false, parsedDateRange)
        }
    }

    suspend fun getConversationDateBuckets(limit: Int = 90, offset: Int = 0): List<DateBucketSummaryRow> =
        withContext(Dispatchers.IO) {
            try {
                conversationDao.getDateBucketsPaged(limit.coerceIn(1, 365), offset.coerceAtLeast(0))
            } catch (_: Exception) {
                emptyList()
            }
        }

    suspend fun getMessagesByConversationId(
        conversationId: String,
        limit: Int = 100,
        offset: Int = 0
    ): List<DecryptedConversationRecord> = withContext(Dispatchers.IO) {
        try {
            conversationDao.getMessagesByConversationIdPaged(
                conversationId = conversationId,
                limit = limit.coerceIn(1, 200),
                offset = offset.coerceAtLeast(0)
            ).map { decryptEntity(it) }
        } catch (_: Exception) {
            emptyList()
        }
    }

    suspend fun loadTopMemories(limit: Int = 40): List<DecryptedMemoryRecord> =
        withContext(Dispatchers.IO) {
            try {
                memoryDao.getTopMemories(limit.coerceIn(1, 100)).mapNotNull { entity ->
                    val plain = secureKeyManager.decryptLocalMemoryText(
                        entity.valueEncrypted,
                        entity.isEncrypted
                    ).trim()
                    if (plain.isEmpty() || LocalMemoryLogic.containsSensitiveSecret(plain)) {
                        null
                    } else {
                        DecryptedMemoryRecord(
                            id = entity.id,
                            category = entity.category,
                            factKey = entity.factKey,
                            value = plain,
                            searchKeywords = entity.searchKeywords,
                            usageCount = entity.usageCount,
                            userApproved = entity.userApproved,
                            createdAtMs = entity.createdAtMs,
                            updatedAtMs = entity.updatedAtMs,
                            sourceConversationId = entity.sourceConversationId,
                            sourceMessageId = entity.sourceMessageId,
                            status = entity.status,
                            correctionHistoryJson = entity.correctionHistoryJson
                        )
                    }
                }
            } catch (_: Exception) {
                emptyList()
            }
        }

    /**
     * Performs full-history indexed recall (date window + keyword + multilingual semantic topics)
     * BEFORE answering any historical question, without loading the full archive into RAM.
     */
    suspend fun tryLocalMemoryRecall(query: String, language: String = "bn-BD"): LocalMemoryRecallResult =
        withContext(Dispatchers.IO) {
            if (!LocalMemoryLogic.isMemoryRecallQuery(query)) {
                return@withContext LocalMemoryRecallResult(false, false, "")
            }
            val memories = loadTopMemories(50)
            val archiveSearch = searchConversationsPaged(query = query, limit = 30, offset = 0)
            val candidates = if (archiveSearch.messages.isNotEmpty()) {
                archiveSearch.messages.map { toDecryptedConversationEntity(it) }
            } else if (archiveSearch.dateRangeApplied == null && LocalMemoryLogic.tokenizeQuery(query).isEmpty()) {
                loadRecentConversations(30, 0)
            } else {
                emptyList()
            }
            LocalMemoryLogic.answerMemoryRecallLocally(
                query = query,
                memories = memories,
                candidateMessages = candidates,
                language = language
            )
        }

    suspend fun buildCompactContextForQuery(query: String): String = withContext(Dispatchers.IO) {
        val memories = loadTopMemories(30)
        val recent = loadRecentConversations(6, 0)
        val isHistorical = LocalMemoryLogic.isMemoryRecallQuery(query) ||
            LocalMemoryLogic.parseHistoricalDateRange(query) != null
        val archivedMatches = if (isHistorical) {
            searchConversationsPaged(query = query, limit = 6, offset = 0)
                .messages
                .map { toDecryptedConversationEntity(it) }
        } else {
            emptyList()
        }
        LocalMemoryLogic.buildCompactContextForGemini(
            query = query,
            memories = memories,
            recentMessages = recent,
            archivedMatches = archivedMatches,
            isHistoricalQuery = isHistorical
        )
    }

    /**
     * Streams all permanent conversations & memories in 500-row pages and produces a single
     * passphrase-encrypted PBKDF2-SHA256 + AES-256-GCM backup archive JSON.
     */
    suspend fun exportEncryptedBackup(passphrase: String): BackupExportResult = withContext(Dispatchers.IO) {
        try {
            val allConversations = mutableListOf<DecryptedConversationRecord>()
            var offset = 0
            val pageSize = 500
            while (true) {
                val page = conversationDao.getMessagesAscendingPaged(limit = pageSize, offset = offset)
                if (page.isEmpty()) break
                for (row in page) {
                    val dec = decryptEntity(row)
                    if (dec.text.isNotBlank() && !LocalMemoryLogic.containsSensitiveSecret(dec.text)) {
                        allConversations.add(dec)
                    }
                }
                if (page.size < pageSize) break
                offset += pageSize
            }

            val allMemories = mutableListOf<DecryptedMemoryRecord>()
            var memOffset = 0
            while (true) {
                val page = memoryDao.getTopMemoriesPaged(limit = 200, offset = memOffset)
                if (page.isEmpty()) break
                for (entity in page) {
                    val plain = secureKeyManager.decryptLocalMemoryText(entity.valueEncrypted, entity.isEncrypted).trim()
                    if (plain.isNotBlank() && !LocalMemoryLogic.containsSensitiveSecret(plain)) {
                        allMemories.add(
                            DecryptedMemoryRecord(
                                id = entity.id,
                                category = entity.category,
                                factKey = entity.factKey,
                                value = plain,
                                searchKeywords = entity.searchKeywords,
                                usageCount = entity.usageCount,
                                userApproved = entity.userApproved,
                                createdAtMs = entity.createdAtMs,
                                updatedAtMs = entity.updatedAtMs,
                                sourceConversationId = entity.sourceConversationId,
                                sourceMessageId = entity.sourceMessageId,
                                status = entity.status,
                                correctionHistoryJson = entity.correctionHistoryJson
                            )
                        )
                    }
                }
                if (page.size < 200) break
                memOffset += 200
            }

            PermanentMemoryBackupCrypto.encryptBackupPayload(
                payload = PlainBackupPayload(
                    exportedAtMs = System.currentTimeMillis(),
                    conversations = allConversations,
                    memories = allMemories
                ),
                passphrase = passphrase
            )
        } catch (e: Exception) {
            BackupExportResult(
                success = false,
                error = "Failed to export backup: ${e.javaClass.simpleName}"
            )
        }
    }

    /**
     * Decrypts a user-provided encrypted backup archive and transactionally restores all
     * conversations and memories into Room (re-encrypted with this device's Keystore AES-256-GCM key).
     */
    suspend fun restoreEncryptedBackup(
        encryptedArchiveJson: String,
        passphrase: String,
        replaceExisting: Boolean = false
    ): BackupRestoreResult = withContext(Dispatchers.IO) {
        val (payload, err) = PermanentMemoryBackupCrypto.decryptBackupPayload(encryptedArchiveJson, passphrase)
        if (payload == null) {
            return@withContext BackupRestoreResult(success = false, error = err)
        }

        writeMutex.withLock {
            try {
                var restoredMsgs = 0
                var restoredMems = 0
                var skippedSensitive = 0

                database.withTransaction {
                    if (replaceExisting) {
                        conversationDao.clearAll()
                        memoryDao.clearAll()
                    }

                    val batch = mutableListOf<ConversationEntity>()
                    for (c in payload.conversations) {
                        val safeText = LocalMemoryLogic.sanitizeForStorage(c.text)
                        if (safeText == null) {
                            skippedSensitive++
                            continue
                        }
                        val (storedText, encrypted) = secureKeyManager.encryptLocalMemoryText(safeText)
                        batch.add(
                            ConversationEntity(
                                id = c.id,
                                role = if (c.role == "assistant") "assistant" else "user",
                                text = storedText,
                                language = c.language.ifBlank { "bn-BD" },
                                createdAtMs = c.createdAtMs,
                                conversationId = c.conversationId.ifBlank { "restored" },
                                inputType = if (c.inputType == "voice") "voice" else "text",
                                commandName = c.commandName.take(80),
                                executionStatus = c.executionStatus.take(48),
                                dateBucket = c.dateBucket.ifBlank { LocalMemoryLogic.formatDateBucket(c.createdAtMs) },
                                searchTokens = LocalMemoryLogic.buildIndexedSearchTokens(safeText, c.commandName),
                                isEncrypted = encrypted
                            )
                        )
                        restoredMsgs++
                        if (batch.size >= 250) {
                            conversationDao.insertMessages(batch)
                            batch.clear()
                        }
                    }
                    if (batch.isNotEmpty()) {
                        conversationDao.insertMessages(batch)
                        batch.clear()
                    }

                    val memEntities = mutableListOf<MemoryEntity>()
                    for (m in payload.memories) {
                        if (LocalMemoryLogic.containsSensitiveSecret(m.value)) {
                            skippedSensitive++
                            continue
                        }
                        val (storedVal, encrypted) = secureKeyManager.encryptLocalMemoryText(m.value)
                        memEntities.add(
                            MemoryEntity(
                                id = m.id,
                                category = m.category,
                                factKey = m.factKey,
                                valueEncrypted = storedVal,
                                isEncrypted = encrypted,
                                searchKeywords = m.searchKeywords,
                                usageCount = m.usageCount,
                                userApproved = m.userApproved,
                                createdAtMs = m.createdAtMs,
                                updatedAtMs = m.updatedAtMs,
                                sourceConversationId = m.sourceConversationId,
                                sourceMessageId = m.sourceMessageId,
                                status = m.status,
                                correctionHistoryJson = m.correctionHistoryJson
                            )
                        )
                        restoredMems++
                    }
                    if (memEntities.isNotEmpty()) {
                        memoryDao.upsertMemories(memEntities)
                    }
                }

                BackupRestoreResult(
                    success = true,
                    restoredMessages = restoredMsgs,
                    restoredMemories = restoredMems,
                    skippedSensitive = skippedSensitive
                )
            } catch (e: Exception) {
                BackupRestoreResult(
                    success = false,
                    error = "Database restore failed: ${e.javaClass.simpleName}"
                )
            }
        }
    }

    suspend fun getDatabaseHealth(): DatabaseHealthSnapshot = withContext(Dispatchers.IO) {
        val (integrityOk, integrityStatus) = database.checkIntegrity()
        val availableBytes = appContext?.let { ZoniDatabase.getAvailableInternalStorageBytes(it) }
            ?: Long.MAX_VALUE
        val lowStorage = availableBytes < ZoniDatabase.MIN_SAFE_STORAGE_BYTES
        val totalConvs = try { conversationDao.getMessageCount() } catch (_: Exception) { 0 }
        val totalMems = try { memoryDao.getMemoryCount() } catch (_: Exception) { 0 }
        val pendingDb = try { pendingWriteDao.getPendingCount() } catch (_: Exception) { 0 }
        val pendingFile = pendingSpool?.count() ?: 0

        DatabaseHealthSnapshot(
            healthy = integrityOk && !lowStorage && lastWriteError.isEmpty(),
            integrityStatus = integrityStatus,
            lowStorage = lowStorage,
            availableBytes = availableBytes,
            pendingRecoveryCount = pendingDb + pendingFile,
            totalConversations = totalConvs,
            totalMemories = totalMems,
            encryptedAtRest = secureKeyManager.isUsingAndroidKeystore(),
            lastWriteError = lastWriteError
        )
    }

    suspend fun clearConversationHistory(): Boolean = withContext(Dispatchers.IO) {
        try {
            conversationDao.clearAll()
            true
        } catch (_: Exception) {
            false
        }
    }

    suspend fun clearLongTermMemory(): Boolean = withContext(Dispatchers.IO) {
        try {
            memoryDao.clearAll()
            true
        } catch (_: Exception) {
            false
        }
    }

    suspend fun getMemorySummaryJson(limit: Int = 30): String = withContext(Dispatchers.IO) {
        val memories = loadTopMemories(limit)
        val health = getDatabaseHealth()
        val oldestTs = try { conversationDao.getOldestTimestampMs() ?: 0L } catch (_: Exception) { 0L }
        val newestTs = try { conversationDao.getNewestTimestampMs() ?: 0L } catch (_: Exception) { 0L }
        val arr = JSONArray()
        memories.forEach { rec ->
            arr.put(
                JSONObject()
                    .put("id", rec.id)
                    .put("category", rec.category)
                    .put("factKey", rec.factKey)
                    .put("value", rec.value)
                    .put("usageCount", rec.usageCount)
                    .put("updatedAtMs", rec.updatedAtMs)
                    .put("sourceConversationId", rec.sourceConversationId)
                    .put("sourceMessageId", rec.sourceMessageId)
                    .put("status", rec.status)
            )
        }
        JSONObject()
            .put("success", true)
            .put("conversationCount", health.totalConversations)
            .put("memoryCount", health.totalMemories)
            .put("encryptedAtRest", health.encryptedAtRest)
            .put("healthy", health.healthy)
            .put("integrityStatus", health.integrityStatus)
            .put("lowStorage", health.lowStorage)
            .put("pendingRecoveryCount", health.pendingRecoveryCount)
            .put("lastWriteError", health.lastWriteError)
            .put("oldestTimestampMs", oldestTs)
            .put("newestTimestampMs", newestTs)
            .put("memories", arr)
            .toString()
    }
}
