package com.zoni.jarvis.assistant.domain

sealed class NumberNormalizerResult {
    data class ValidCandidate(
        val original: String,
        val normalizedNumber: String,
        val formatted: String,
        val country: String? = null
    ) : NumberNormalizerResult()

    data class IncompleteNumber(
        val original: String,
        val currentDigits: String,
        val currentLength: Int
    ) : NumberNormalizerResult()

    data class InvalidNumber(
        val original: String,
        val reason: String
    ) : NumberNormalizerResult()

    data class AmbiguousInterpretation(
        val original: String,
        val candidates: List<String>
    ) : NumberNormalizerResult()
}

object NumberNormalizer {

    private val BENGALI_TO_ASCII_DIGIT_MAP = mapOf(
        '০' to '0',
        '১' to '1',
        '২' to '2',
        '৩' to '3',
        '৪' to '4',
        '৫' to '5',
        '৬' to '6',
        '৭' to '7',
        '৮' to '8',
        '৯' to '9'
    )

    private val WORD_TO_DIGIT_MAP = mapOf(
        "zero" to "0", "one" to "1", "two" to "2", "three" to "3", "four" to "4",
        "five" to "5", "six" to "6", "seven" to "7", "eight" to "8", "nine" to "9",
        "শূণ্য" to "0", "শূন্য" to "0", "এক" to "1", "দুই" to "2", "তিন" to "3",
        "চার" to "4", "পাঁচ" to "5", "ছয়" to "6", "ছয়" to "6", "সাত" to "7",
        "আট" to "8", "নয়" to "9", "নয়" to "9"
    )

    /**
     * Converts Bengali digits and word numerals to ASCII digits.
     */
    fun convertDigitsToAscii(input: String): String {
        var processed = input.trim()

        // Replace unambiguous Bengali and English digit words
        for ((word, digit) in WORD_TO_DIGIT_MAP) {
            val regex = Regex("\\b$word\\b", RegexOption.IGNORE_CASE)
            processed = processed.replace(regex, digit)
        }

        // Replace individual Bengali digit characters
        val sb = StringBuilder()
        for (char in processed) {
            sb.append(BENGALI_TO_ASCII_DIGIT_MAP[char] ?: char)
        }
        return sb.toString()
    }

    /**
     * Normalizes a phone number phrase according to Bengali/English speech rules,
     * handling speech recognition spacing, country codes, and Indian/Bangladeshi formats.
     */
    fun normalizePhoneNumber(input: String): NumberNormalizerResult {
        val trimmed = input.trim()
        if (trimmed.isBlank()) {
            return NumberNormalizerResult.InvalidNumber(trimmed, "Number input is empty.")
        }

        val converted = convertDigitsToAscii(trimmed)

        // Check if plus is present at start
        val hasLeadingPlus = converted.startsWith("+")

        // Strip harmless separators like spaces, hyphens, parenthesis, dots
        val digitsOnly = converted.filter { it.isDigit() }

        if (digitsOnly.isEmpty()) {
            return NumberNormalizerResult.InvalidNumber(trimmed, "No digits recognized in input.")
        }

        // If digits are fewer than 7, it's definitively incomplete
        if (digitsOnly.length in 1..6) {
            return NumberNormalizerResult.IncompleteNumber(trimmed, digitsOnly, digitsOnly.length)
        }

        // Check Bangladesh 11-digit format starting with 01
        if (digitsOnly.length == 11 && digitsOnly.startsWith("01")) {
            val formatted = "+88$digitsOnly"
            return NumberNormalizerResult.ValidCandidate(trimmed, formatted, formatted, country = "BD")
        }

        // Check Bangladesh format with 880 prefix (13 digits: 8801...)
        if (digitsOnly.length == 13 && digitsOnly.startsWith("8801")) {
            val formatted = "+$digitsOnly"
            return NumberNormalizerResult.ValidCandidate(trimmed, formatted, formatted, country = "BD")
        }

        // Check Indian 10-digit mobile number starting with 6, 7, 8, or 9
        if (digitsOnly.length == 10 && digitsOnly[0] in '6'..'9') {
            val formatted = "+91$digitsOnly"
            return NumberNormalizerResult.ValidCandidate(trimmed, formatted, formatted, country = "IN")
        }

        // Check Indian number with 91 prefix (12 digits: 91...)
        if (digitsOnly.length == 12 && digitsOnly.startsWith("91") && digitsOnly[2] in '6'..'9') {
            val formatted = "+$digitsOnly"
            return NumberNormalizerResult.ValidCandidate(trimmed, formatted, formatted, country = "IN")
        }

        // Check international standard E.164 (between 7 and 15 digits)
        if (digitsOnly.length in 10..15) {
            val normalized = if (hasLeadingPlus) "+$digitsOnly" else digitsOnly
            return NumberNormalizerResult.ValidCandidate(trimmed, normalized, normalized)
        }

        // Between 7 and 9 digits (could be incomplete mobile number or local landline)
        if (digitsOnly.length in 7..9) {
            return NumberNormalizerResult.IncompleteNumber(trimmed, digitsOnly, digitsOnly.length)
        }

        return NumberNormalizerResult.InvalidNumber(
            trimmed,
            "Digit sequence of length ${digitsOnly.length} does not match any valid telephone format."
        )
    }
}
