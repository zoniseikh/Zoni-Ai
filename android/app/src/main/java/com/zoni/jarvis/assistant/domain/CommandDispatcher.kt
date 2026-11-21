package com.zoni.jarvis.assistant.domain

import android.provider.Settings

class CommandDispatcher {

    private var lastCommandText: String = ""
    private var lastCommandTimestamp: Long = 0L
    private val duplicateSuppressionWindowMs = 1500L

    /**
     * Checks if this command is a duplicate execution from rapid speech-recognition callbacks.
     */
    fun isDuplicateCallback(rawText: String): Boolean {
        val trimmed = rawText.trim().lowercase()
        val now = System.currentTimeMillis()
        if (trimmed == lastCommandText && (now - lastCommandTimestamp) < duplicateSuppressionWindowMs) {
            return true
        }
        lastCommandText = trimmed
        lastCommandTimestamp = now
        return false
    }

    /**
     * Parses Bengali and English spoken text into a deterministic typed VoiceCommand.
     */
    fun parseCommand(rawText: String): VoiceCommand {
        val trimmed = rawText.trim()
        val lower = trimmed.lowercase()

        if (trimmed.isBlank()) {
            return VoiceCommand.Unknown(trimmed)
        }

        // 1. Flashlight On/Off
        if (isFlashlightOnCommand(lower)) {
            return VoiceCommand.ToggleFlashlight(enable = true)
        }
        if (isFlashlightOffCommand(lower)) {
            return VoiceCommand.ToggleFlashlight(enable = false)
        }

        // 2. Screen Query ("আমার স্ক্রিনে কী লেখা আছে?" / "What is on my screen?")
        if (isScreenQuery(lower)) {
            return VoiceCommand.ScreenQuery(trimmed)
        }

        // 3. Settings Commands (e.g. "ওয়াইফাই সেটিংস খোলো", "Open Wi-Fi Settings")
        val settingsCmd = parseSettingsCommand(lower)
        if (settingsCmd != null) {
            return settingsCmd
        }

        // 4. Calling by Phone Number (e.g., "৯৮৭৬৫৪৩২১০ নম্বরে কল করো", "Call 9876543210")
        val directCall = parseDirectNumberCall(trimmed)
        if (directCall != null) {
            return directCall
        }

        // 5. Calling by Contact Name (e.g., "রাহুলকে ফোন করো", "Call Rahul")
        val contactCall = parseContactCall(trimmed)
        if (contactCall != null) {
            return contactCall
        }

        // 6. App Launching (e.g., "YouTube খোলো", "ইউটিউব ওপেন করো", "Open WhatsApp")
        val appLaunch = parseAppLaunch(trimmed)
        if (appLaunch != null) {
            return appLaunch
        }

        // 7. Language Switch commands
        if (lower.contains("বাংলায় কথা") || lower.contains("speak in bengali")) {
            return VoiceCommand.SwitchLanguage("bn-BD", "Bengali")
        }
        if (lower.contains("speak in english") || lower.contains("ইংরেজিতে কথা")) {
            return VoiceCommand.SwitchLanguage("en-US", "English")
        }

        // 8. Default to Gemini General Query (for AI reasoning, weather, general questions)
        return VoiceCommand.GeminiGeneralQuery(trimmed)
    }

    private fun isFlashlightOnCommand(raw: String): Boolean {
        val normalized = normalizeCommand(raw)
        if (isNonFlashlightLightQuery(normalized)) {
            return false
        }

        // Explicit English ON commands
        val englishOnRegex = Regex(
            "^(?:(?:please\\s+)?(?:turn\\s+on|switch\\s+on)\\s+(?:the\\s+)?(?:flashlight|torch|phone\\s+light|mobile\\s+light)|" +
            "(?:turn\\s+on|switch\\s+on)\\s+(?:the\\s+)?light|" +
            "(?:flashlight|torch)\\s+(?:on|please\\s+on|turn\\s+on|switch\\s+on)|" +
            "(?:phone|mobile)\\s+light\\s+(?:on|turn\\s+on))$",
            RegexOption.IGNORE_CASE
        )
        if (englishOnRegex.containsMatchIn(normalized)) return true

        // Explicit Bengali ON commands: "টর্চ লাইট জ্বালাও", "টর্চ জ্বালিয়ে দাও", "ফ্ল্যাশলাইট অন করো", "ফ্ল্যাশ লাইট জ্বালাও"
        val hasTorchNoun = Regex("(?:টর্চ|টরচ|ফ্ল্যাশ\\s*লাইট|ফ্লাস\\s*লাইট|মোবাইলের\\s*লাইট|ফোনের\\s*লাইট)").containsMatchIn(normalized)
        val hasOnVerb = Regex("(?:জ্বালাও|জ্বালিয়ে\\s*দাও|জ্বালিয়ে\\s*দাও|অন\\s*করো|অন\\s*কর|চালু\\s*করো|চালু\\s*কর)").containsMatchIn(normalized)

        if (hasTorchNoun && hasOnVerb) return true

        // Standalone direct command: "লাইট অন করো", "লাইট জ্বালাও", "লাইট জ্বালিয়ে দাও"
        val directLightOn = Regex("^(?:মোবাইলের\\s*)?লাইট\\s*(?:অন\\s*করো|অন\\s*কর|জ্বালাও|জ্বালিয়ে\\s*দাও|জ্বালিয়ে\\s*দাও|চালু\\s*করো)$")
        if (directLightOn.containsMatchIn(normalized)) return true

        return false
    }

    private fun isFlashlightOffCommand(raw: String): Boolean {
        val normalized = normalizeCommand(raw)
        if (isNonFlashlightLightQuery(normalized)) {
            return false
        }

        // Explicit English OFF commands
        val englishOffRegex = Regex(
            "^(?:(?:please\\s+)?(?:turn\\s+off|switch\\s+off)\\s+(?:the\\s+)?(?:flashlight|torch|phone\\s+light|mobile\\s+light)|" +
            "(?:turn\\s+off|switch\\s+off)\\s+(?:the\\s+)?light|" +
            "(?:flashlight|torch)\\s+(?:off|please\\s+off|turn\\s+off|switch\\s+off)|" +
            "(?:phone|mobile)\\s+light\\s+(?:off|turn\\s+off))$",
            RegexOption.IGNORE_CASE
        )
        if (englishOffRegex.containsMatchIn(normalized)) return true

        // Explicit Bengali OFF commands: "টর্চ লাইট বন্ধ করো", "টর্চ বন্ধ করে দাও", "ফ্ল্যাশলাইট অফ করো", "ফ্ল্যাশ লাইট বন্ধ করো"
        val hasTorchNoun = Regex("(?:টর্চ|টরচ|ফ্ল্যাশ\\s*লাইট|ফ্লাস\\s*লাইট|মোবাইলের\\s*লাইট|ফোনের\\s*লাইট)").containsMatchIn(normalized)
        val hasOffVerb = Regex("(?:বন্ধ\\s*করো|বন্ধ\\s*কর|বন্ধ\\s*করে\\s*দাও|অফ\\s*করো|অফ\\s*কর|নিভিয়ে\\s*দাও|নিভিয়ে\\s*দাও|নিভাও)").containsMatchIn(normalized)

        if (hasTorchNoun && hasOffVerb) return true

        // Standalone direct command: "লাইট অফ করো", "লাইট বন্ধ করো", "লাইট নিভিয়ে দাও"
        val directLightOff = Regex("^(?:মোবাইলের\\s*)?লাইট\\s*(?:অফ\\s*করো|অফ\\s*কর|বন্ধ\\s*করো|বন্ধ\\s*কর|বন্ধ\\s*করে\\s*দাও|নিভিয়ে\\s*দাও|নিভিয়ে\\s*দাও|নিভাও)$")
        if (directLightOff.containsMatchIn(normalized)) return true

        return false
    }

    private fun isNonFlashlightLightQuery(text: String): Boolean {
        return text.contains("traffic light") ||
                text.contains("sun gives light") ||
                text.contains("speed of light") ||
                text.contains("light year") ||
                text.contains("কবিতা") ||
                text.contains("গান") ||
                text.contains("অর্থ কী") ||
                text.contains("মানে কী") ||
                text.contains("কী") ||
                text.contains("কি") ||
                text.contains("what is") ||
                text.contains("tell me about")
    }

    private fun normalizeCommand(text: String): String {
        return text.trim()
            .replace(Regex("[.,?!;:।\\-_]"), " ")
            .replace(Regex("\\s+"), " ")
            .lowercase()
    }

    private fun isScreenQuery(lower: String): Boolean {
        return lower.contains("স্ক্রিনে কী লেখা") ||
                lower.contains("স্ক্রিনে কি লেখা") ||
                lower.contains("আমার স্ক্রিন পড়ো") ||
                lower.contains("what is on my screen") ||
                lower.contains("read my screen")
    }

    private fun parseSettingsCommand(lower: String): VoiceCommand.OpenSettings? {
        if (lower.contains("ওয়াইফাই সেটিংস") || lower.contains("wifi settings") || lower.contains("wi-fi settings")) {
            return VoiceCommand.OpenSettings(Settings.ACTION_WIFI_SETTINGS, "Wi-Fi Settings")
        }
        if (lower.contains("ব্লুটুথ সেটিংস") || lower.contains("bluetooth settings")) {
            return VoiceCommand.OpenSettings(Settings.ACTION_BLUETOOTH_SETTINGS, "Bluetooth Settings")
        }
        if (lower.contains("ডিসপ্লে সেটিংস") || lower.contains("display settings")) {
            return VoiceCommand.OpenSettings(Settings.ACTION_DISPLAY_SETTINGS, "Display Settings")
        }
        return null
    }

    private fun parseDirectNumberCall(raw: String): VoiceCommand.CallDirectNumber? {
        // 1. Bengali number-first pattern: "৯৮৭৬৫৪৩২১০ নম্বরে কল করো" / "01712345678 কল করো"
        val numberFirstRegex = Regex("([+0-9০-৯\\s-]{7,20})\\s*(?:নম্বরে|নাম্বারে)?\\s*(?:কল\\s*করো|ফোন\\s*করো|ডায়াল\\s*করো|ডায়াল\\s*করো)", RegexOption.IGNORE_CASE)
        val firstMatch = numberFirstRegex.find(raw)
        if (firstMatch != null) {
            val candidate = firstMatch.groupValues[1]
            val normResult = NumberNormalizer.normalizePhoneNumber(candidate)
            if (normResult is NumberNormalizerResult.ValidCandidate) {
                return VoiceCommand.CallDirectNumber(normResult.normalizedNumber, normResult.formatted)
            }
        }

        // 2. Verb-first pattern: "Call 9876543210", "কল করো 017..."
        val callNumberRegex = Regex("(?:কল\\s*করো|ফোন\\s*করো|call|dial)\\s*(?:নম্বরে)?\\s*([+0-9০-৯\\s-]{7,20})", RegexOption.IGNORE_CASE)
        val match = callNumberRegex.find(raw)
        if (match != null) {
            val candidate = match.groupValues[1]
            val normResult = NumberNormalizer.normalizePhoneNumber(candidate)
            if (normResult is NumberNormalizerResult.ValidCandidate) {
                return VoiceCommand.CallDirectNumber(normResult.normalizedNumber, normResult.formatted)
            }
        }
        return null
    }

    private fun parseContactCall(raw: String): VoiceCommand.CallContact? {
        // Bengali pattern: "<Name>কে ফোন করো" or "<Name>কে কল করো"
        val bengaliMatch = Regex("^([\\p{L}\\p{M}\\w\\s]+?)(?:কে|রে)?\\s*(?:ফোন\\s*করো|কল\\s*করো)[.,?!।]*$", RegexOption.IGNORE_CASE).find(raw)
        if (bengaliMatch != null) {
            val contact = bengaliMatch.groupValues[1].trim()
            if (contact.isNotBlank() && !contact.contains("নম্বর")) {
                return VoiceCommand.CallContact(contact)
            }
        }

        // English pattern: "call <Name>" or "phone <Name>"
        val englishMatch = Regex("^(?:call|phone)\\s+([\\p{L}\\p{M}\\w\\s]+?)[.,?!।]*$", RegexOption.IGNORE_CASE).find(raw)
        if (englishMatch != null) {
            val candidate = englishMatch.groupValues[1].trim()
            // Make sure it's not numbers
            if (candidate.any { it.isLetter() }) {
                return VoiceCommand.CallContact(candidate)
            }
        }

        return null
    }

    private fun parseAppLaunch(raw: String): VoiceCommand.OpenApp? {
        // "YouTube খোলো", "ওয়াতসঅ্যাপ ওপেন করো", "Open YouTube"
        val openBengaliMatch = Regex("^([\\p{L}\\p{M}\\w\\s]+?)\\s*(?:খোলো|ওপেন\\s*করো)[.,?!।]*$", RegexOption.IGNORE_CASE).find(raw)
        if (openBengaliMatch != null) {
            val appQuery = openBengaliMatch.groupValues[1].trim()
            if (appQuery.isNotBlank() && !appQuery.contains("সেটিংস") && !appQuery.contains("টর্চ")) {
                return VoiceCommand.OpenApp(appQuery)
            }
        }

        val openEnglishMatch = Regex("^(?:open|launch)\\s+([\\p{L}\\p{M}\\w\\s]+?)[.,?!।]*$", RegexOption.IGNORE_CASE).find(raw)
        if (openEnglishMatch != null) {
            val appQuery = openEnglishMatch.groupValues[1].trim()
            if (appQuery.isNotBlank() && !appQuery.contains("settings") && !appQuery.contains("flashlight")) {
                return VoiceCommand.OpenApp(appQuery)
            }
        }

        return null
    }
}
