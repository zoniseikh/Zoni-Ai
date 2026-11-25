package com.zoni.jarvis.assistant.db

import com.zoni.jarvis.assistant.data.SecureKeyManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/**
 * Decrypted view of a local long-term memory entry.
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
    val updatedAtMs: Long
)

data class ExtractedMemoryFact(
    val category: String,
    val factKey: String,
    val value: String,
    val searchKeywords: String
)

data class LocalMemoryRecallResult(
    val isMemoryQuery: Boolean,
    val handledOffline: Boolean,
    val replyText: String,
    val matchedFacts: List<DecryptedMemoryRecord> = emptyList(),
    val matchedMessages: List<ConversationEntity> = emptyList()
)

/**
 * Pure JVM-testable local memory intelligence & privacy policy engine.
 *
 * Enforces strict privacy rules:
 * - NEVER stores passwords, OTPs, PINs, CVVs, card numbers, banking credentials, or API keys.
 * - Extracts bounded, deduplicated user preferences, personal facts, preferred language,
 *   and frequent commands.
 * - Supports offline-first local memory recall and compact context generation
 *   (never dumps full conversation history to Gemini).
 */
object LocalMemoryLogic {

    const val CATEGORY_LANGUAGE = "language"
    const val CATEGORY_PREFERENCE = "preference"
    const val CATEGORY_PERSONAL_FACT = "personal_fact"
    const val CATEGORY_FREQUENT_COMMAND = "frequent_command"
    const val CATEGORY_CONTEXT = "context"

    const val MAX_COMPACT_CONTEXT_CHARS = 520
    const val MAX_STORED_MESSAGE_CHARS = 1600

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
     * due to sensitive credentials.
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
     * Extracts structured, non-sensitive user-approved facts and preferences from a user utterance.
     */
    fun extractUserMemories(userText: String): List<ExtractedMemoryFact> {
        val clean = userText.trim()
        if (clean.isEmpty() || containsSensitiveSecret(clean)) return emptyList()

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
                        searchKeywords = "name নাম user_name ${candidate.lowercase()}"
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
                        searchKeywords = buildSearchKeywords("remember মনে note $note")
                    )
                )
                break
            }
        }

        // 3. Language preference
        val lower = clean.lowercase()
        when {
            lower.contains("বাংলায় কথা বল") || lower.contains("বাংলায় কথা বল") ||
                lower.contains("speak in bengali") || lower.contains("talk in bangla") -> {
                extracted.add(
                    ExtractedMemoryFact(
                        category = CATEGORY_LANGUAGE,
                        factKey = "preferred_language",
                        value = "bn-BD (Bengali)",
                        searchKeywords = "language ভাষা bengali bangla বাংলা bn-bd"
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
                        searchKeywords = "language ভাষা english ইংরেজি en-us"
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
                        searchKeywords = "language ভাষা hindi হিন্দি हिंदी hi-in"
                    )
                )
            }
        }

        // 4. User preference ("আমি ... পছন্দ করি" / "I prefer ..." / "I like ...")
        val preferencePatterns = listOf(
            Regex("(?:আমি)\\s+(.{3,90}?)\\s+(?:পছন্দ\\s*করি|ভালোবাসি)", RegexOption.IGNORE_CASE),
            Regex("(?:i\\s+prefer|i\\s+really\\s+like|my\\s+favorite\\s+[a-z]+\\s+is)\\s+(.{3,90}?)(?:\\.|!|$)", RegexOption.IGNORE_CASE)
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
                        searchKeywords = buildSearchKeywords("preference পছন্দ favorite $pref")
                    )
                )
                break
            }
        }

        return extracted.distinctBy { it.factKey }
    }

    /**
     * Detects whether the user is asking about past conversations or saved personal memory.
     */
    fun isMemoryRecallQuery(userText: String): Boolean {
        val lower = userText.trim().lowercase()
        if (lower.isEmpty()) return false
        return lower.contains("আগে কী বলেছিলাম") ||
            lower.contains("আগে কি বলেছিলাম") ||
            lower.contains("গতবার কী বলেছিলাম") ||
            lower.contains("আমার সম্পর্কে কী জানো") ||
            lower.contains("আমার সম্পর্কে কি জানো") ||
            lower.contains("আমার নাম কী") ||
            lower.contains("আমার নাম কি") ||
            lower.contains("তুমি কী মনে রেখেছ") ||
            lower.contains("তুমি কি মনে রেখেছ") ||
            lower.contains("মনে আছে কি") ||
            lower.contains("মেমোরিতে কী আছে") ||
            lower.contains("what did i say") ||
            lower.contains("what did we talk about") ||
            lower.contains("what do you remember") ||
            lower.contains("what do you know about me") ||
            lower.contains("what is my name") ||
            lower.contains("do you remember") ||
            lower.contains("my previous message") ||
            lower.contains("conversation history") ||
            lower.contains("मेरा नाम क्या है") ||
            lower.contains("मैंने पहले क्या कहा")
    }

    /**
     * Offline-first local search & recall over saved memories and recent conversations.
     */
    fun answerMemoryRecallLocally(
        query: String,
        memories: List<DecryptedMemoryRecord>,
        recentMessages: List<ConversationEntity>,
        language: String = "bn-BD"
    ): LocalMemoryRecallResult {
        if (!isMemoryRecallQuery(query)) {
            return LocalMemoryRecallResult(isMemoryQuery = false, handledOffline = false, replyText = "")
        }

        val isBn = language.startsWith("bn", ignoreCase = true) ||
            query.any { it in '\u0980'..'\u09FF' }
        val lower = query.lowercase()

        // Direct "What is my name?" check
        if (lower.contains("আমার নাম") || lower.contains("my name") || lower.contains("मेरा नाम")) {
            val nameFact = memories.firstOrNull { it.factKey == "user_name" }
            if (nameFact != null) {
                val reply = if (isBn) {
                    "আপনার নাম ${nameFact.value}।"
                } else {
                    "Your name is ${nameFact.value}."
                }
                return LocalMemoryRecallResult(
                    isMemoryQuery = true,
                    handledOffline = true,
                    replyText = reply,
                    matchedFacts = listOf(nameFact)
                )
            }
        }

        // Token-scored search across decrypted memories
        val queryTokens = tokenizeQuery(query)
        val rankedMemories = memories
            .filter { it.userApproved && it.value.isNotBlank() }
            .map { rec ->
                val haystack = "${rec.value} ${rec.searchKeywords} ${rec.category}".lowercase()
                val tokenHits = queryTokens.count { haystack.contains(it) }
                val score = tokenHits * 20 + rec.usageCount.coerceAtMost(10)
                rec to score
            }
            .sortedByDescending { it.second }
            .map { it.first }
            .take(5)

        // Filter out the current recall question itself from recent user messages
        val priorUserMessages = recentMessages
            .filter { it.role == "user" && !it.text.equals(query.trim(), ignoreCase = true) }
            .sortedByDescending { it.createdAtMs }

        val matchedMessages = if (queryTokens.isNotEmpty()) {
            val scored = priorUserMessages.filter { msg ->
                val msgLower = msg.text.lowercase()
                queryTokens.any { msgLower.contains(it) }
            }
            if (scored.isNotEmpty()) scored.take(3) else priorUserMessages.take(3)
        } else {
            priorUserMessages.take(3)
        }

        if (rankedMemories.isEmpty() && matchedMessages.isEmpty()) {
            val reply = if (isBn) {
                "এখনো লোকাল মেমোরিতে সংরক্ষিত কোনো তথ্য বা আগের কথোপকথন নেই।"
            } else {
                "There are no saved local memories or previous conversations yet."
            }
            return LocalMemoryRecallResult(
                isMemoryQuery = true,
                handledOffline = true,
                replyText = reply
            )
        }

        val parts = mutableListOf<String>()
        if (rankedMemories.isNotEmpty()) {
            val summary = rankedMemories.joinToString("; ") { it.value }
            parts.add(
                if (isBn) "লোকাল মেমোরিতে যা মনে আছে: $summary।"
                else "From local memory: $summary."
            )
        }
        if (matchedMessages.isNotEmpty()) {
            val snippet = matchedMessages.first().text.take(120)
            parts.add(
                if (isBn) "আগে আপনি বলেছিলেন: \"$snippet\"।"
                else "Earlier you said: \"$snippet\"."
            )
        }

        return LocalMemoryRecallResult(
            isMemoryQuery = true,
            handledOffline = true,
            replyText = parts.joinToString(" "),
            matchedFacts = rankedMemories,
            matchedMessages = matchedMessages
        )
    }

    /**
     * Builds a compact, strictly bounded context snippet for Gemini from relevant local memories
     * and the most recent turns. NEVER dumps full conversation history.
     */
    fun buildCompactContextForGemini(
        query: String,
        memories: List<DecryptedMemoryRecord>,
        recentMessages: List<ConversationEntity>,
        maxChars: Int = MAX_COMPACT_CONTEXT_CHARS
    ): String {
        val tokens = tokenizeQuery(query)
        val topMemories = memories
            .filter { it.userApproved && it.value.isNotBlank() && !containsSensitiveSecret(it.value) }
            .sortedByDescending { rec ->
                val hay = "${rec.value} ${rec.searchKeywords}".lowercase()
                val relevance = tokens.count { hay.contains(it) } * 15
                val priority = when (rec.category) {
                    CATEGORY_PERSONAL_FACT -> 10
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

        val relevantRecent = recentMessages
            .filter { !containsSensitiveSecret(it.text) }
            .sortedByDescending { it.createdAtMs }
            .take(3)
            .reversed()

        if (relevantRecent.isNotEmpty()) {
            if (sb.isNotEmpty()) sb.append("\n")
            sb.append("[Recent] ")
            sb.append(relevantRecent.joinToString(" / ") { "${it.role}:${it.text.take(60)}" })
        }

        val result = sb.toString().trim()
        return if (result.length <= maxChars) result else result.take(maxChars).trimEnd()
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

    private val STOP_WORDS = setOf(
        "what", "did", "you", "the", "about", "remember", "say", "said", "talk", "know", "that", "this",
        "আমার", "আমি", "তুমি", "আগে", "বলেছিলাম", "জানো", "মনে", "আছে", "সম্পর্কে", "কী", "কি"
    )

    private fun tokenizeQuery(query: String): List<String> {
        return query.lowercase()
            .replace(Regex("[^\\p{L}\\p{M}\\p{N}\\s]+"), " ")
            .split(Regex("\\s+"))
            .filter { it.length >= 2 && it !in STOP_WORDS }
            .distinct()
            .take(8)
    }
}

/**
 * Room-backed async local conversation & encrypted long-term memory repository.
 * Reuses the single existing [ZoniDatabase] and [SecureKeyManager] — zero duplicate databases.
 */
class LocalMemoryRepository(
    private val database: ZoniDatabase,
    private val secureKeyManager: SecureKeyManager
) {
    private val conversationDao = database.conversationDao()
    private val memoryDao = database.memoryDao()

    suspend fun saveMessage(
        role: String,
        text: String,
        language: String = "bn-BD",
        id: String = UUID.randomUUID().toString(),
        createdAtMs: Long = System.currentTimeMillis()
    ): Boolean = withContext(Dispatchers.IO) {
        val safeText = LocalMemoryLogic.sanitizeForStorage(text) ?: return@withContext false
        try {
            conversationDao.insertMessage(
                ConversationEntity(
                    id = id,
                    role = role,
                    text = safeText,
                    language = language,
                    createdAtMs = createdAtMs
                )
            )
            // Keep bounded size for low-end devices without wiping recent history
            if (conversationDao.getMessageCount() > MAX_CONVERSATION_ROWS) {
                conversationDao.pruneToRecent(MAX_CONVERSATION_ROWS)
            }
            if (role == "user") {
                val extracted = LocalMemoryLogic.extractUserMemories(safeText)
                for (fact in extracted) {
                    upsertMemoryFact(fact)
                }
            }
            true
        } catch (_: Exception) {
            false
        }
    }

    suspend fun recordFrequentCommand(commandLabel: String): Boolean = withContext(Dispatchers.IO) {
        val safe = LocalMemoryLogic.sanitizeForStorage(commandLabel) ?: return@withContext false
        if (safe.length < 3) return@withContext false
        upsertMemoryFact(
            ExtractedMemoryFact(
                category = LocalMemoryLogic.CATEGORY_FREQUENT_COMMAND,
                factKey = "cmd_${LocalMemoryLogic.normalizeKeySlug(safe).take(36)}",
                value = safe.take(90),
                searchKeywords = LocalMemoryLogic.buildSearchKeywords("command $safe")
            )
        )
    }

    suspend fun upsertMemoryFact(fact: ExtractedMemoryFact): Boolean = withContext(Dispatchers.IO) {
        if (LocalMemoryLogic.containsSensitiveSecret(fact.value)) return@withContext false
        try {
            val now = System.currentTimeMillis()
            val existing = memoryDao.findByFactKey(fact.factKey)
            val (storedVal, encrypted) = secureKeyManager.encryptLocalMemoryText(fact.value)
            val entity = if (existing != null) {
                existing.copy(
                    category = fact.category,
                    valueEncrypted = storedVal,
                    isEncrypted = encrypted,
                    searchKeywords = fact.searchKeywords,
                    usageCount = existing.usageCount + 1,
                    updatedAtMs = now
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
                    updatedAtMs = now
                )
            }
            memoryDao.upsertMemory(entity)
            true
        } catch (_: Exception) {
            false
        }
    }

    suspend fun loadRecentConversations(limit: Int = 60, offset: Int = 0): List<ConversationEntity> =
        withContext(Dispatchers.IO) {
            try {
                conversationDao.getRecentMessagesPaged(limit.coerceIn(1, 200), offset.coerceAtLeast(0))
                    .reversed()
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
                            updatedAtMs = entity.updatedAtMs
                        )
                    }
                }
            } catch (_: Exception) {
                emptyList()
            }
        }

    suspend fun tryLocalMemoryRecall(query: String, language: String = "bn-BD"): LocalMemoryRecallResult =
        withContext(Dispatchers.IO) {
            if (!LocalMemoryLogic.isMemoryRecallQuery(query)) {
                return@withContext LocalMemoryRecallResult(false, false, "")
            }
            val memories = loadTopMemories(40)
            val recent = loadRecentConversations(40, 0)
            LocalMemoryLogic.answerMemoryRecallLocally(query, memories, recent, language)
        }

    suspend fun buildCompactContextForQuery(query: String): String = withContext(Dispatchers.IO) {
        val memories = loadTopMemories(25)
        val recent = loadRecentConversations(6, 0)
        LocalMemoryLogic.buildCompactContextForGemini(query, memories, recent)
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
        val convCount = try {
            conversationDao.getMessageCount()
        } catch (_: Exception) {
            0
        }
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
            )
        }
        JSONObject()
            .put("success", true)
            .put("conversationCount", convCount)
            .put("memoryCount", memories.size)
            .put("encryptedAtRest", secureKeyManager.isUsingAndroidKeystore())
            .put("memories", arr)
            .toString()
    }

    companion object {
        private const val MAX_CONVERSATION_ROWS = 500
    }
}
