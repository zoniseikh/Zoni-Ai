package com.zoni.jarvis.assistant.device

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.database.Cursor
import android.net.Uri
import android.provider.ContactsContract
import androidx.core.content.ContextCompat
import com.zoni.jarvis.assistant.domain.NumberNormalizer
import com.zoni.jarvis.assistant.domain.NumberNormalizerResult

import com.zoni.jarvis.assistant.service.MultilingualNameMatcher
import java.text.Normalizer
import kotlin.math.max
import kotlin.math.min

data class ContactMatch(
    val id: String,
    val displayName: String,
    val phoneNumbers: List<String>
)

sealed class ContactCallResolution {
    data class ReadyToCall(val name: String, val number: String, val useDirectCall: Boolean) : ContactCallResolution()
    data class MultipleMatches(val query: String, val candidates: List<ContactMatch>) : ContactCallResolution()
    data class MultipleNumbersForContact(val name: String, val numbers: List<String>) : ContactCallResolution()
    data class ContactNotFound(val query: String) : ContactCallResolution()
    object PermissionMissing : ContactCallResolution()
    data class CallFailed(val reason: String) : ContactCallResolution()
}

/**
 * Pure JVM-testable Bilingual (Bengali & English) Smart Contact Search & Disambiguation Engine.
 *
 * Supports:
 * 1. Exact Bengali Unicode match ("রহিম" -> "রহিম") with NFC + zero-width cleanup + suffix stripping ("রহিমকে" -> "রহিম")
 * 2. Case-insensitive English match ("Rahim" / "rahim" -> "Rahim")
 * 3. Bidirectional Bengali <-> English transliteration ("রহিম" <-> "Rahim"/"Rohim", "অমিত" <-> "Amit", "সুমন" <-> "Sumon"/"Suman")
 * 4. Kinship aliases ("মা" <-> "Mom"/"Ammu", "বাবা" <-> "Dad"/"Abbu")
 * 5. Controlled fuzzy similarity (Levenshtein >= 72% for typo tolerance) without unsafe false matches
 * 6. Phone number normalization & equivalent-number deduplication ("+8801711..." vs "01711...")
 * 7. Safe disambiguation when multiple contacts genuinely tie
 */
object SmartContactMatcher {

    private val BENGALI_VOWEL_SIGNS = setOf('া', 'ি', 'ী', 'ু', 'ূ', 'ৃ', 'ে', 'ৈ', 'ো', 'ৌ', '্')

    private val BENGALI_CONSONANT_MAP: Map<Char, String> = mapOf(
        'ক' to "k", 'খ' to "kh", 'গ' to "g", 'ঘ' to "gh", 'ঙ' to "ng",
        'চ' to "ch", 'ছ' to "ch", 'জ' to "j", 'ঝ' to "jh", 'ঞ' to "n",
        'ট' to "t", 'ঠ' to "th", 'ড' to "d", 'ঢ' to "dh", 'ণ' to "n",
        'ত' to "t", 'থ' to "th", 'দ' to "d", 'ধ' to "dh", 'ন' to "n",
        'প' to "p", 'ফ' to "f", 'ব' to "b", 'ভ' to "bh", 'ম' to "m",
        'য' to "j", 'র' to "r", 'ল' to "l", 'শ' to "sh", 'ষ' to "sh", 'স' to "s", 'হ' to "h",
        '\u09DC' to "r", '\u09DD' to "rh", '\u09DF' to "y",
        'ৎ' to "t", 'ং' to "ng", 'ঃ' to "h", 'ঁ' to "n"
    )

    private val BENGALI_VOWEL_MAP: Map<Char, String> = mapOf(
        'অ' to "a", 'আ' to "a", 'ই' to "i", 'ঈ' to "i", 'উ' to "u", 'ঊ' to "u",
        'ঋ' to "ri", 'এ' to "e", 'ঐ' to "oi", 'ও' to "o", 'ঔ' to "ou",
        'া' to "a", 'ি' to "i", 'ী' to "i", 'ু' to "u", 'ূ' to "u", 'ৃ' to "ri",
        'ে' to "e", 'ৈ' to "oi", 'ো' to "o", 'ৌ' to "ou", '্' to ""
    )

    private val INVISIBLE_PHONE_CHARS_REGEX = Regex("[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]")

    fun normalizeDisplayText(raw: String): String {
        return Normalizer.normalize(raw, Normalizer.Form.NFC)
            .replace(INVISIBLE_PHONE_CHARS_REGEX, "")
            .replace(Regex("\\s+"), " ")
            .trim()
    }

    fun cleanContactQuery(raw: String): String {
        val norm = normalizeDisplayText(raw)
        return MultilingualNameMatcher.cleanPersonQuery(norm)
    }

    /**
     * Inherent-vowel-aware Bengali -> Latin transliteration so:
     * "রহিম" -> "rahim", "অমিত" -> "amit", "সুমন" -> "suman", "করিম" -> "karim", "রাহুল" -> "rahul".
     */
    fun transliterateToLatin(input: String): String {
        val norm = normalizeDisplayText(input).lowercase()
        val sb = StringBuilder(norm.length * 2)
        var i = 0
        while (i < norm.length) {
            val ch = norm[i]
            val next = if (i + 1 < norm.length) norm[i + 1] else '\u0000'

            // Handle decomposed Bengali nukta letters (ড/ঢ/য + U+09BC)
            if (next == '\u09BC') {
                val nukta = when (ch) {
                    'ড' -> "r"
                    'ঢ' -> "rh"
                    'য' -> "y"
                    else -> null
                }
                if (nukta != null) {
                    sb.append(nukta)
                    val afterNukta = if (i + 2 < norm.length) norm[i + 2] else '\u0000'
                    if (afterNukta != '\u0000' && afterNukta !in BENGALI_VOWEL_SIGNS && BENGALI_CONSONANT_MAP.containsKey(afterNukta)) {
                        sb.append('a')
                    }
                    i += 2
                    continue
                }
            }

            val consonant = BENGALI_CONSONANT_MAP[ch]
            if (consonant != null) {
                sb.append(consonant)
                // Insert inherent 'a' when followed by another Bengali consonant (and NOT a vowel sign or virama '্' or word end)
                if (next != '\u0000' && next !in BENGALI_VOWEL_SIGNS && BENGALI_CONSONANT_MAP.containsKey(next)) {
                    sb.append('a')
                }
                i++
                continue
            }

            val vowel = BENGALI_VOWEL_MAP[ch]
            if (vowel != null) {
                sb.append(vowel)
                i++
                continue
            }

            if (ch.isLetterOrDigit() || ch == ' ') {
                sb.append(ch)
            } else if (ch == '-' || ch == '_' || ch == '.') {
                sb.append(' ')
            }
            i++
        }
        return sb.toString().replace(Regex("\\s+"), " ").trim()
    }

    /**
     * Canonical phonetic key bridging Bengali/English spelling variations:
     * "Rahim"/"Rohim"/"Raheem"/"রহিম" -> "rahim"
     * "Sumon"/"Suman"/"সুমন" -> "suman"
     * "Amit"/"Omit"/"অমিত" -> "amit"
     * "Shakib"/"Sakib"/"সাকিব" -> "sakib"
     * "Tanveer"/"Tanvir"/"তানভীর" -> "tanbir"
     */
    fun toCanonicalPhonetic(raw: String): String {
        val latin = transliterateToLatin(raw).lowercase()
        val replaced = latin
            .replace("ph", "f")
            .replace("bh", "b")
            .replace("sh", "s")
            .replace("kh", "k")
            .replace("gh", "g")
            .replace("dh", "d")
            .replace("th", "t")
            .replace("ch", "c")
            .replace("ee", "i")
            .replace("oo", "u")
            .replace('v', 'b')
            .replace('w', 'b')
            .replace('z', 'j')
            .replace('q', 'k')
            .replace('y', 'i')
            .replace('o', 'a')
            .replace(Regex("([a-z])\\1+"), "$1")
            .replace(Regex("\\s+"), " ")
            .trim()
        return replaced
    }

    fun scoreContactName(displayName: String, rawQuery: String): Int {
        val cleanName = normalizeDisplayText(displayName)
        val cleanQuery = cleanContactQuery(rawQuery)
        if (cleanName.isEmpty() || cleanQuery.isEmpty()) return 0

        val nLower = cleanName.lowercase()
        val qLower = cleanQuery.lowercase()

        // 1. Exact full match (Bengali Unicode or English case-insensitive)
        if (nLower == qLower) return 100

        // 2. Exact transliterated / canonical phonetic match ("রহিম" <-> "Rahim"/"Rohim", "অমিত" <-> "Amit", "সুমন" <-> "Sumon")
        val nTrans = transliterateToLatin(cleanName)
        val qTrans = transliterateToLatin(cleanQuery)
        if (nTrans.isNotEmpty() && nTrans == qTrans) return 96

        val nCanon = toCanonicalPhonetic(cleanName)
        val qCanon = toCanonicalPhonetic(cleanQuery)
        if (nCanon.isNotEmpty() && nCanon == qCanon) return 95

        // 3. Kinship alias match ("মা" <-> "Mom"/"Ammu", "বাবা" <-> "Dad"/"Abbu")
        if (MultilingualNameMatcher.matchesKinshipAlias(cleanName, cleanQuery)) return 92

        // 4. Whole-word exact match in multi-word display names ("রহিম" -> "Rahim Khan" / "Rahim Bhai")
        val nWords = nLower.split(Regex("\\s+")).filter { it.isNotEmpty() }
        val nCanonWords = nCanon.split(Regex("\\s+")).filter { it.isNotEmpty() }
        val qCanonWords = qCanon.split(Regex("\\s+")).filter { it.isNotEmpty() }
        if (qLower in nWords) return 88
        if (qCanon.isNotEmpty() && qCanon in nCanonWords) return 87
        if (qCanonWords.size > 1 && qCanonWords.all { qw -> nCanonWords.any { nw -> nw == qw } }) return 91

        // 5. Prefix match (full name or first word)
        if (nLower.startsWith(qLower) || (qCanon.length >= 2 && nCanon.startsWith(qCanon))) return 82
        if (qCanon.length >= 3 && nCanonWords.any { it.startsWith(qCanon) }) return 80

        // 6. Consonant skeleton match (for Bengali/English vowel differences where length >= 3)
        val nSkel = MultilingualNameMatcher.consonantSkeleton(nCanon)
        val qSkel = MultilingualNameMatcher.consonantSkeleton(qCanon)
        if (qSkel.length >= 3 && (nSkel == qSkel || nCanonWords.any { MultilingualNameMatcher.consonantSkeleton(it) == qSkel })) {
            return 84
        }

        // 7. Substring match
        if (qLower.length >= 3 && nLower.contains(qLower)) return 76
        if (qCanon.length >= 3 && nCanon.contains(qCanon)) return 75

        // 8. Controlled fuzzy similarity (Levenshtein >= 74% on full name or individual token)
        if (qCanon.length >= 3) {
            val fullSim = similarityScore(qCanon, nCanon)
            val bestTokenSim = nCanonWords.maxOfOrNull { similarityScore(qCanon, it) } ?: 0
            val bestSim = max(fullSim, bestTokenSim)
            if (bestSim >= 74) {
                return (bestSim * 0.92f).toInt().coerceIn(70, 86)
            }
        }

        return 0
    }

    private fun similarityScore(a: String, b: String): Int {
        if (a.isEmpty() || b.isEmpty()) return 0
        val maxLen = max(a.length, b.length)
        val dist = levenshtein(a, b)
        // Guard against short 3-4 char names matching wildly different words
        if (maxLen <= 4 && dist > 1) return 0
        return (((maxLen - dist).toFloat() / maxLen.toFloat()) * 100f).toInt().coerceIn(0, 100)
    }

    private fun levenshtein(a: String, b: String): Int {
        val dp = Array(a.length + 1) { IntArray(b.length + 1) }
        for (i in 0..a.length) dp[i][0] = i
        for (j in 0..b.length) dp[0][j] = j
        for (i in 1..a.length) {
            for (j in 1..b.length) {
                val cost = if (a[i - 1] == b[j - 1]) 0 else 1
                dp[i][j] = min(min(dp[i - 1][j] + 1, dp[i][j - 1] + 1), dp[i - 1][j - 1] + cost)
            }
        }
        return dp[a.length][b.length]
    }

    /**
     * Produces a canonical comparison key for phone numbers regardless of formatting,
     * spaces, hyphens, parentheses, BiDi characters, leading trunk '0', '00' prefix,
     * or country code differences (e.g., "9876543210", "098765-43210", "+91 98765 43210",
     * "00919876543210" all share canonical key "9876543210").
     */
    fun canonicalPhoneKey(rawNumber: String): String {
        val cleaned = INVISIBLE_PHONE_CHARS_REGEX.replace(rawNumber, "").trim()
        if (cleaned.isEmpty()) return ""
        val ascii = NumberNormalizer.convertDigitsToAscii(cleaned)
        val digitsOnly = ascii.filter { it.isDigit() }
        if (digitsOnly.length < 3) return ""
        if (digitsOnly.length >= 10) {
            return digitsOnly.takeLast(10)
        }
        val withoutLeadingZeros = digitsOnly.trimStart('0')
        return if (withoutLeadingZeros.length >= 3) withoutLeadingZeros else digitsOnly
    }

    /**
     * Normalizes a raw saved phone number into a clean dialable string while handling
     * invisible BiDi characters, '00' international dialing prefix, and Indian trunk '0'.
     */
    fun normalizeSavedPhoneNumber(raw: String): String {
        var cleaned = INVISIBLE_PHONE_CHARS_REGEX.replace(raw, "").trim()
        if (cleaned.isEmpty()) return ""
        cleaned = NumberNormalizer.convertDigitsToAscii(cleaned)

        val compact = cleaned.filter { it.isDigit() || it == '+' }
        val normalizedInput = when {
            compact.startsWith("00") && compact.length >= 12 -> "+${compact.drop(2)}"
            !compact.startsWith("+") && compact.length == 11 && compact[0] == '0' && compact[1] in '6'..'9' ->
                compact.drop(1)
            else -> cleaned
        }

        val normResult = NumberNormalizer.normalizePhoneNumber(normalizedInput)
        return if (normResult is NumberNormalizerResult.ValidCandidate) {
            normResult.normalizedNumber
        } else {
            normalizedInput.filter { it.isDigit() || it == '+' }
        }
    }

    /**
     * Deduplicates phone numbers representing the same line (e.g. "+91 98765-43210", "09876543210",
     * "9876543210" or "+8801711223344" and "01711-223344"), keeping the cleanest normalized format
     * (preferring international '+' prefix when present).
     */
    fun deduplicatePhoneNumbers(rawNumbers: List<String>): List<String> {
        val byKey = LinkedHashMap<String, String>()
        for (raw in rawNumbers) {
            val clean = normalizeSavedPhoneNumber(raw)
            val dedupKey = canonicalPhoneKey(clean.ifEmpty { raw })
            if (dedupKey.isEmpty()) continue
            val existing = byKey[dedupKey]
            if (existing == null || (clean.startsWith("+") && !existing.startsWith("+"))) {
                byKey[dedupKey] = clean
            }
        }
        return byKey.values.toList()
    }

    /**
     * Deduplicates contacts across Android accounts/sources (e.g., Google + SIM + Device + WhatsApp
     * creating separate CONTACT_ID rows for the exact same person & phone number):
     * - Merges entries with identical contact ID.
     * - Merges entries with identical normalized display name that share at least one canonical phone number.
     * - Preserves genuinely distinct phone numbers for the same contact.
     * - Preserves genuinely distinct contacts that share the same name but have completely different phone numbers.
     */
    fun deduplicateContacts(contacts: List<ContactMatch>): List<ContactMatch> {
        // Pass 1: merge by explicit contact ID and deduplicate each contact's numbers
        val byId = LinkedHashMap<String, ContactMatch>()
        for (contact in contacts) {
            val cleanName = normalizeDisplayText(contact.displayName)
            val dedupedPhones = deduplicatePhoneNumbers(contact.phoneNumbers)
            if (cleanName.isEmpty() || dedupedPhones.isEmpty()) continue

            val idKey = contact.id.trim()
            if (idKey.isNotEmpty() && byId.containsKey(idKey)) {
                val prev = byId.getValue(idKey)
                byId[idKey] = prev.copy(
                    phoneNumbers = deduplicatePhoneNumbers(prev.phoneNumbers + dedupedPhones)
                )
            } else {
                val mapKey = idKey.ifEmpty { "__anon_${byId.size}" }
                byId[mapKey] = contact.copy(
                    displayName = cleanName,
                    phoneNumbers = dedupedPhones
                )
            }
        }

        // Pass 2: merge duplicate cross-source contacts (same normalized name + overlapping canonical phone key)
        val merged = mutableListOf<ContactMatch>()
        val mergedNameKeys = mutableListOf<String>()
        val mergedPhoneKeys = mutableListOf<MutableSet<String>>()

        for (candidate in byId.values) {
            val nameKey = candidate.displayName.lowercase()
            val candKeys = candidate.phoneNumbers
                .map { canonicalPhoneKey(it) }
                .filter { it.isNotEmpty() }
                .toSet()
            if (candKeys.isEmpty()) continue

            val matchIdx = merged.indices.firstOrNull { idx ->
                mergedNameKeys[idx] == nameKey && mergedPhoneKeys[idx].any { it in candKeys }
            }

            if (matchIdx != null) {
                val existing = merged[matchIdx]
                val combinedNumbers = deduplicatePhoneNumbers(existing.phoneNumbers + candidate.phoneNumbers)
                merged[matchIdx] = existing.copy(phoneNumbers = combinedNumbers)
                mergedPhoneKeys[matchIdx].addAll(candKeys)
            } else {
                merged.add(candidate)
                mergedNameKeys.add(nameKey)
                mergedPhoneKeys.add(candKeys.toMutableSet())
            }
        }

        return merged
    }

    /**
     * Strict case-insensitive prefix check for Android SIM Calling Contact Search:
     * - English query ("Babu") matches ONLY contacts whose display name starts with "Babu" (case-insensitive),
     *   e.g. "Babu", "Babu Jamai", "Babu Mama", "Babu Telecom"; excludes "Deb Babu", "Ful Babu Karandi", "বাবু".
     * - Bengali query ("বাবু") matches ONLY contacts whose display name starts with "বাবু",
     *   e.g. "বাবু", "বাবু মামা"; excludes "দেব বাবু", "ফুল বাবু করন্দি", "Babu".
     * - Hindi/Devanagari query ("राम") matches ONLY contacts starting with "राम"; excludes "श्री राम", "Ram".
     */
    fun matchesPrefixQuery(displayName: String, rawQuery: String): Boolean {
        val cleanName = normalizeDisplayText(displayName).lowercase(java.util.Locale.ROOT)
        val cleanQuery = normalizeDisplayText(rawQuery).lowercase(java.util.Locale.ROOT)
        if (cleanName.isEmpty() || cleanQuery.isEmpty()) return false
        return cleanName.startsWith(cleanQuery)
    }

    /**
     * Pure JVM-testable prefix-only contact search for Android SIM Calling Search Box:
     * 1. Deduplicates contacts & equivalent phone numbers across Android accounts/formatting.
     * 2. Filters strictly by case-insensitive display-name prefix (no mid-name, end-of-name, substring, fuzzy, or cross-script matches).
     * 3. Sorts exact match first, then alphabetically by display name.
     * 4. Prevents the same phone number from appearing more than once while preserving:
     *    - Multiple distinct contacts with the same name (different phone numbers).
     *    - Multiple distinct phone numbers belonging to the same contact.
     */
    fun searchContactsByPrefix(
        rawQuery: String,
        contacts: List<ContactMatch>,
        maxResults: Int = 50
    ): List<ContactMatch> {
        val cleanQuery = normalizeDisplayText(rawQuery).lowercase(java.util.Locale.ROOT)
        if (cleanQuery.isEmpty()) return emptyList()

        val uniqueContacts = deduplicateContacts(contacts)
        val matched = uniqueContacts
            .filter { contact -> matchesPrefixQuery(contact.displayName, cleanQuery) }
            .sortedWith(
                compareByDescending<ContactMatch> {
                    normalizeDisplayText(it.displayName).lowercase(java.util.Locale.ROOT) == cleanQuery
                }.thenBy {
                    normalizeDisplayText(it.displayName).lowercase(java.util.Locale.ROOT)
                }
            )

        val seenPhoneKeys = HashSet<String>()
        val result = mutableListOf<ContactMatch>()
        for (contact in matched) {
            val uniquePhonesForContact = mutableListOf<String>()
            for (phone in deduplicatePhoneNumbers(contact.phoneNumbers)) {
                val phoneKey = canonicalPhoneKey(phone)
                if (phoneKey.isNotEmpty() && seenPhoneKeys.add(phoneKey)) {
                    uniquePhonesForContact.add(phone)
                }
            }
            if (uniquePhonesForContact.isNotEmpty()) {
                result.add(contact.copy(phoneNumbers = uniquePhonesForContact))
                if (result.size >= maxResults) break
            }
        }
        return result
    }

    /**
     * Pure JVM-testable resolution over a list of contacts.
     * Applies cross-source & phone-number deduplication, strict confidence threshold (>= 70),
     * exact-winner priority over partial matches, and safe disambiguation on genuine ties.
     */
    fun resolveFromContacts(
        rawQuery: String,
        contacts: List<ContactMatch>,
        useDirectCall: Boolean
    ): ContactCallResolution {
        val cleanQuery = rawQuery.trim()
        if (cleanQuery.isBlank()) {
            return ContactCallResolution.ContactNotFound(cleanQuery)
        }

        val uniqueContacts = deduplicateContacts(contacts)

        val scored = uniqueContacts.mapNotNull { contact ->
            val score = scoreContactName(contact.displayName, cleanQuery)
            if (score < 70) return@mapNotNull null
            Pair(contact, score)
        }.sortedWith(compareByDescending<Pair<ContactMatch, Int>> { it.second }.thenBy { it.first.displayName.lowercase() })

        if (scored.isEmpty()) {
            return ContactCallResolution.ContactNotFound(cleanQuery)
        }

        val topScore = scored[0].second
        // Select clear winner if top match is exact/phonetic-exact (>= 92) and leads runner-up by >= 8 points,
        // or if only one contact qualifies in the top tier.
        val topTier = if (scored.size > 1 && topScore >= 92 && (topScore - scored[1].second) >= 8) {
            listOf(scored[0].first)
        } else {
            scored.filter { it.second >= topScore - 6 }.map { it.first }
        }

        if (topTier.size == 1) {
            val contact = topTier[0]
            return if (contact.phoneNumbers.size == 1) {
                ContactCallResolution.ReadyToCall(
                    name = contact.displayName,
                    number = contact.phoneNumbers[0],
                    useDirectCall = useDirectCall
                )
            } else {
                ContactCallResolution.MultipleNumbersForContact(contact.displayName, contact.phoneNumbers)
            }
        }

        return ContactCallResolution.MultipleMatches(cleanQuery, topTier.take(6))
    }
}

class ContactCallManager(private val context: Context) {

    fun hasContactPermission(): Boolean {
        return ContextCompat.checkSelfPermission(
            context,
            Manifest.permission.READ_CONTACTS
        ) == PackageManager.PERMISSION_GRANTED
    }

    fun hasCallPhonePermission(): Boolean {
        return ContextCompat.checkSelfPermission(
            context,
            Manifest.permission.CALL_PHONE
        ) == PackageManager.PERMISSION_GRANTED
    }

    /**
     * Loads all phone-bearing Android contacts grouped by LOOKUP_KEY (fallback CONTACT_ID)
     * with per-contact phone number deduplication.
     */
    private fun loadAllContacts(): Pair<List<ContactMatch>?, String?> {
        val allContacts = mutableListOf<ContactMatch>()
        val uri = ContactsContract.CommonDataKinds.Phone.CONTENT_URI
        val projection = arrayOf(
            ContactsContract.CommonDataKinds.Phone.CONTACT_ID,
            ContactsContract.CommonDataKinds.Phone.LOOKUP_KEY,
            ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME,
            ContactsContract.CommonDataKinds.Phone.NUMBER,
            ContactsContract.CommonDataKinds.Phone.NORMALIZED_NUMBER
        )

        var cursor: Cursor? = null
        try {
            cursor = context.contentResolver.query(
                uri,
                projection,
                null,
                null,
                "${ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME} ASC"
            )

            if (cursor != null && cursor.moveToFirst()) {
                val tempMap = LinkedHashMap<String, Triple<String, String, MutableList<String>>>()
                val idIndex = cursor.getColumnIndex(ContactsContract.CommonDataKinds.Phone.CONTACT_ID)
                val lookupIndex = cursor.getColumnIndex(ContactsContract.CommonDataKinds.Phone.LOOKUP_KEY)
                val nameIndex = cursor.getColumnIndex(ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME)
                val numberIndex = cursor.getColumnIndex(ContactsContract.CommonDataKinds.Phone.NUMBER)
                val normalizedIndex = cursor.getColumnIndex(ContactsContract.CommonDataKinds.Phone.NORMALIZED_NUMBER)

                do {
                    val id = if (idIndex >= 0) cursor.getString(idIndex) else null
                    val lookupKey = if (lookupIndex >= 0) cursor.getString(lookupIndex) else null
                    val name = if (nameIndex >= 0) cursor.getString(nameIndex) else null
                    val rawNumber = if (numberIndex >= 0) cursor.getString(numberIndex) else null
                    val normalizedNumber = if (normalizedIndex >= 0) cursor.getString(normalizedIndex) else null
                    val chosenNumber = rawNumber?.takeIf { it.isNotBlank() } ?: normalizedNumber
                    if (id.isNullOrBlank() || name.isNullOrBlank() || chosenNumber.isNullOrBlank()) continue

                    // Group by Android LOOKUP_KEY when available (aggregates linked RawContacts cleanly), else CONTACT_ID
                    val groupKey = lookupKey?.takeIf { it.isNotBlank() } ?: id
                    val existing = tempMap.getOrPut(groupKey) { Triple(id, name, mutableListOf()) }
                    existing.third.add(chosenNumber)
                } while (cursor.moveToNext())

                for ((_, triple) in tempMap) {
                    val dedupedNumbers = SmartContactMatcher.deduplicatePhoneNumbers(triple.third)
                    if (dedupedNumbers.isNotEmpty()) {
                        allContacts.add(ContactMatch(triple.first, triple.second, dedupedNumbers))
                    }
                }
            }
        } catch (e: Exception) {
            return Pair(null, "Contacts provider query error: ${e.message}")
        } finally {
            cursor?.close()
        }

        return Pair(allContacts, null)
    }

    /**
     * Strict prefix-only contact search for Android SIM Calling Contact Search Box.
     * Case-insensitive, script-preserving prefix match with duplicate contact & phone-number prevention.
     */
    fun searchContactsByPrefix(contactQuery: String, maxResults: Int = 50): List<ContactMatch> {
        if (!hasContactPermission()) return emptyList()
        val cleanQuery = contactQuery.trim()
        if (cleanQuery.isBlank()) return emptyList()
        val (contacts, error) = loadAllContacts()
        if (error != null || contacts == null) return emptyList()
        return SmartContactMatcher.searchContactsByPrefix(
            rawQuery = cleanQuery,
            contacts = contacts,
            maxResults = maxResults
        )
    }

    /**
     * Resolves a Bengali, Hindi, or English contact name query against the Android Contacts Provider
     * using [SmartContactMatcher] (exact Unicode, case-insensitive English, cross-script
     * Bengali <-> English transliteration, phonetic, kinship, controlled fuzzy matching,
     * and cross-account/LOOKUP_KEY/canonical-phone deduplication).
     */
    fun resolveContact(contactQuery: String): ContactCallResolution {
        if (!hasContactPermission()) {
            return ContactCallResolution.PermissionMissing
        }

        val cleanQuery = contactQuery.trim()
        if (cleanQuery.isBlank()) {
            return ContactCallResolution.ContactNotFound(cleanQuery)
        }

        val (allContacts, error) = loadAllContacts()
        if (error != null || allContacts == null) {
            return ContactCallResolution.CallFailed(error ?: "Contacts provider query error")
        }

        return SmartContactMatcher.resolveFromContacts(
            rawQuery = cleanQuery,
            contacts = allContacts,
            useDirectCall = hasCallPhonePermission()
        )
    }

    /**
     * Executes the phone call intent. Uses ACTION_CALL if CALL_PHONE is granted,
     * otherwise gracefully falls back to ACTION_DIAL.
     */
    fun initiateCall(phoneNumber: String): Boolean {
        val cleanNumber = phoneNumber.trim()
        if (cleanNumber.isBlank()) return false

        val intent = if (hasCallPhonePermission()) {
            Intent(Intent.ACTION_CALL, Uri.parse("tel:$cleanNumber"))
        } else {
            Intent(Intent.ACTION_DIAL, Uri.parse("tel:$cleanNumber"))
        }.apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK
        }

        return try {
            context.startActivity(intent)
            true
        } catch (e: Exception) {
            false
        }
    }
}
