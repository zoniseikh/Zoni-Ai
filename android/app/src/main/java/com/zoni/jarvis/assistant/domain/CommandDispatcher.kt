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
     * Strips optional wake-word prefix such as "জনি,", "ZONI,", "Hey Zoni," before command parsing.
     */
    fun stripWakeWord(rawText: String): String {
        return rawText.trim()
            .replace(Regex("^(?:hey\\s+|ওহে\\s+|হেই\\s+)?(?:zoni\\s*ai|zoni|জনি\\s*এআই|জনি|ज़ोनी\\s*एआई|ज़ोनी)\\s*[,:\\-!।]*\\s*", RegexOption.IGNORE_CASE), "")
            .trim()
    }

    /**
     * Parses Bengali, English, and Hindi spoken text into a deterministic typed VoiceCommand.
     * Ordinary conversation is intentionally routed to [VoiceCommand.GeminiGeneralQuery].
     */
    fun parseCommand(rawText: String): VoiceCommand {
        val trimmed = rawText.trim()
        if (trimmed.isBlank()) {
            return VoiceCommand.Unknown(trimmed)
        }

        val cleaned = stripWakeWord(trimmed).ifBlank { trimmed }
        val lower = cleaned.lowercase()

        // 0. Pending draft review, cancellation & explicit approval commands
        if (isCancelCurrentTaskCommand(lower)) {
            return VoiceCommand.CancelCurrentTask(cleaned)
        }
        if (isApprovePendingCommand(lower)) {
            return VoiceCommand.ApprovePendingAction(cleaned)
        }
        if (isReviewPendingDraftCommand(lower)) {
            return VoiceCommand.ReviewPendingDraft(cleaned)
        }

        // 1. Flashlight On/Off
        if (isFlashlightOnCommand(lower)) {
            return VoiceCommand.ToggleFlashlight(enable = true)
        }
        if (isFlashlightOffCommand(lower)) {
            return VoiceCommand.ToggleFlashlight(enable = false)
        }

        // 2. Screen Query ("আমার স্ক্রিনে কী লেখা আছে?", "এই স্ক্রিনে কী আছে পড়ে শোনাও।", "What is on my screen?")
        if (isScreenQuery(lower)) {
            return VoiceCommand.ScreenQuery(cleaned)
        }

        // 3. Scroll & Accessibility Navigation ("নিচে স্ক্রল করো।", "উপরে স্ক্রল করো", "go back", "go home")
        val navCmd = parseAccessibilityNav(cleaned, lower)
        if (navCmd != null) {
            return navCmd
        }

        // 4. WhatsApp / Message draft commands ("রাহুলকে WhatsApp-এ মেসেজ পাঠাও: ...", "রাহুলকে একটা মেসেজ লিখে দাও।", "মাকে WhatsApp-এ বলো ...")
        val waCmd = parseWhatsAppDraftCommand(cleaned)
        if (waCmd != null) {
            return waCmd
        }

        // 5. Multi-step App Search Workflow ("ইউটিউবে গান খুঁজে দাও।", "search songs on YouTube")
        val appSearch = parseAppSearchWorkflow(cleaned)
        if (appSearch != null) {
            return appSearch
        }

        // 6. Settings Commands ("ফোনের সেটিংস খোলো।", "ওয়াইফাই সেটিংস খোলো", "Open Wi-Fi Settings")
        val settingsCmd = parseSettingsCommand(lower)
        if (settingsCmd != null) {
            return settingsCmd
        }

        // 7. Calling by Phone Number ("৯৮৭৬৫৪৩২১০ নম্বরে কল করো", "Call 9876543210")
        val directCall = parseDirectNumberCall(cleaned)
        if (directCall != null) {
            return directCall
        }

        // 8. Calling by Contact Name ("আমার মাকে ফোন করো।", "রাহুলকে ফোন করো", "Call Rahul")
        val contactCall = parseContactCall(cleaned)
        if (contactCall != null) {
            return contactCall
        }

        // 9. App Launching ("জনি, WhatsApp খোলো।", "YouTube খোলো", "Open WhatsApp")
        val appLaunch = parseAppLaunch(cleaned)
        if (appLaunch != null) {
            return appLaunch
        }

        // 10. Language Switch commands
        if (lower.contains("বাংলায় কথা") || lower.contains("বাংলায় কথা") || lower.contains("speak in bengali")) {
            return VoiceCommand.SwitchLanguage("bn-BD", "Bengali")
        }
        if (lower.contains("হিন্দিতে কথা") || lower.contains("speak in hindi") || lower.contains("हिंदी में बात")) {
            return VoiceCommand.SwitchLanguage("hi-IN", "Hindi")
        }
        if (lower.contains("speak in english") || lower.contains("ইংরেজিতে কথা")) {
            return VoiceCommand.SwitchLanguage("en-US", "English")
        }

        // 11. Default to Gemini General Query (ordinary conversation never misclassified as device action)
        return VoiceCommand.GeminiGeneralQuery(trimmed)
    }

    private fun isApprovePendingCommand(lower: String): Boolean {
        return Regex(
            "(?:এখন\\s*পাঠানোর\\s*অনুমতি\\s*দিলাম|পাঠানোর\\s*অনুমতি\\s*দিলাম|অনুমতি\\s*দিলাম|মেসেজটা\\s*পাঠিয়ে\\s*দাও|এখন\\s*পাঠাও|confirm\\s*(?:and\\s*)?send|approve\\s*(?:and\\s*)?send|yes\\s+send\\s+it|भेजने\\s*की\\s*अनुमति|अब\\s*भेज\\s*दो)",
            RegexOption.IGNORE_CASE
        ).containsMatchIn(lower)
    }

    private fun isCancelCurrentTaskCommand(lower: String): Boolean {
        return Regex(
            "(?:আগের\\s*কাজ(?:টা)?\\s*বন্ধ\\s*করো|বর্তমান\\s*কাজ\\s*(?:cancel|বাতিল|বন্ধ)\\s*করো|কাজ(?:টা)?\\s*(?:বাতিল|বন্ধ)\\s*করো|ড্রাফট\\s*বাতিল\\s*করো|cancel\\s+(?:current\\s+|pending\\s+)?(?:task|action|draft)|stop\\s+(?:current\\s+)?task|पिछला\\s*काम\\s*बंद\\s*करो|काम\\s*रद्द\\s*करो)",
            RegexOption.IGNORE_CASE
        ).containsMatchIn(lower)
    }

    private fun isReviewPendingDraftCommand(lower: String): Boolean {
        return Regex(
            "(?:পাঠানোর\\s*আগে\\s*(?:আমাকে\\s*)?দেখাও|মেসেজটা\\s*(?:আমাকে\\s*)?দেখাও|ড্রাফট\\s*দেখাও|show\\s*(?:me\\s*)?(?:the\\s*)?(?:draft|message)\\s*(?:before\\s+sending)?|भेजने\\s*से\\s*पहले\\s*दिखाओ)",
            RegexOption.IGNORE_CASE
        ).containsMatchIn(lower)
    }

    private fun parseAccessibilityNav(raw: String, lower: String): VoiceCommand? {
        if (Regex("(?:scroll\\s+down|swipe\\s+down|নিচে\\s*স্ক্রল\\s*করো|নিচে\\s*যাও|नीचे\\s*स्क्रॉल\\s*करो)", RegexOption.IGNORE_CASE).containsMatchIn(lower)) {
            return VoiceCommand.ScrollScreen("down")
        }
        if (Regex("(?:scroll\\s+up|swipe\\s+up|উপরে\\s*স্ক্রল\\s*করো|ऊपर\\s*स्क्रॉल\\s*करो)", RegexOption.IGNORE_CASE).containsMatchIn(lower)) {
            return VoiceCommand.ScrollScreen("up")
        }
        if (Regex("^(?:go\\s+back|back\\s+button|পেছনে\\s*যাও|ব্যাক\\s*করো|वापस\\s*जाओ)[.,?!।]*$", RegexOption.IGNORE_CASE).matches(lower)) {
            return VoiceCommand.NavigateGlobal("back")
        }
        if (Regex("^(?:go\\s+home|home\\s+screen|হোম\\s*স্ক্রিনে\\s*যাও|হোমে\\s*যাও|होम\\s*स्क्रीन\\s*पर\\s*जाओ)[.,?!।]*$", RegexOption.IGNORE_CASE).matches(lower)) {
            return VoiceCommand.NavigateGlobal("home")
        }
        val tapEn = Regex("^(?:tap|click|press)\\s+(?:on\\s+)?(.+?)[.,?!।]*$", RegexOption.IGNORE_CASE).find(raw)
        if (tapEn != null && tapEn.groupValues[1].isNotBlank()) {
            return VoiceCommand.TapVisibleElement(tapEn.groupValues[1].trim())
        }
        val tapBn = Regex("^(.+?)\\s*(?:বাটনে\\s*)?(?:ট্যাপ\\s*করো|ক্লিক\\s*করো|চাপো)[.,?!।]*$", RegexOption.IGNORE_CASE).find(raw)
        if (tapBn != null && tapBn.groupValues[1].isNotBlank()) {
            return VoiceCommand.TapVisibleElement(tapBn.groupValues[1].trim())
        }
        return null
    }

    private fun parseWhatsAppDraftCommand(raw: String): VoiceCommand.PrepareWhatsAppMessage? {
        // 1. Bengali: "রাহুলকে WhatsApp-এ মেসেজ পাঠাও: আমি আজ আসতে পারব না।"
        //    "মাকে WhatsApp-এ বলো আমি বাড়ি ফিরছি।"
        //    "পাপাকে মেসেজ করো আমি পরে ফোন করব।"
        //    "রাহুলকে একটা মেসেজ লিখে দাও।"
        val bnPatterns = listOf(
            Regex("^(?:আমার\\s+)?(.+?)(?:কে|-কে)\\s*(?:হোয়াটসঅ্যাপ|হোয়াটসঅ্যাপ|whatsapp)(?:-?এ)?\\s*(?:একটা\\s+)?(?:মেসেজ\\s*)?(?:পাঠাও|করো|লিখে\\s*দাও|বলো|দাও)\\s*[:,-]?\\s*(.*)$", RegexOption.IGNORE_CASE),
            Regex("^(?:আমার\\s+)?(.+?)(?:কে|-কে)\\s*(?:একটা\\s+)?মেসেজ\\s*(?:পাঠাও|করো|লিখে\\s*দাও|দাও)\\s*[:,-]?\\s*(.*)$", RegexOption.IGNORE_CASE)
        )
        for (pattern in bnPatterns) {
            val m = pattern.find(raw)
            if (m != null) {
                val recipient = m.groupValues[1].trim()
                val msg = m.groupValues[2].trim().trimEnd('।', '.')
                if (recipient.isNotBlank()) {
                    return VoiceCommand.PrepareWhatsAppMessage(recipient, msg)
                }
            }
        }

        // 2. English: "Send Rahul a WhatsApp message saying I will arrive in 10 minutes."
        //    "Send a WhatsApp message to Rahul saying I am on my way"
        val enSendTo = Regex(
            "^(?:please\\s+)?send\\s+(?:a\\s+)?whats\\s*app\\s*(?:message\\s*)?to\\s+(.+?)(?:\\s+(?:saying|that|message|:)\\s*(.+))?[.,?!]*$",
            RegexOption.IGNORE_CASE
        ).find(raw)
        if (enSendTo != null) {
            val recipient = enSendTo.groupValues[1].trim()
            val msg = enSendTo.groupValues[2].trim()
            if (recipient.isNotBlank()) {
                return VoiceCommand.PrepareWhatsAppMessage(recipient, msg)
            }
        }

        val enSendPerson = Regex(
            "^(?:please\\s+)?send\\s+([\\p{L}\\p{M}\\w\\s.'-]{1,40}?)\\s+(?:a\\s+)?whats\\s*app\\s*(?:message\\s*)?(?:saying|that|:)?\\s*(.*)[.,?!]*$",
            RegexOption.IGNORE_CASE
        ).find(raw)
        if (enSendPerson != null) {
            val recipient = enSendPerson.groupValues[1].trim()
            val msg = enSendPerson.groupValues[2].trim().trimEnd('.')
            if (recipient.isNotBlank() && !recipient.equals("a", ignoreCase = true)) {
                return VoiceCommand.PrepareWhatsAppMessage(recipient, msg)
            }
        }

        // 3. Hindi: "राहुल को व्हाट्सएप मैसेज भेजो मैं 10 मिनट में आ रहा हूं"
        val hiMatch = Regex(
            "^(.+?)\\s*को\\s*(?:व्हाट्सएप|व्हाट्सऐप|whatsapp)?\\s*(?:मैसेज|मेसेज)\\s*(?:भेजो|करो|लिखो)\\s*[:,-]?\\s*(.*)$",
            RegexOption.IGNORE_CASE
        ).find(raw)
        if (hiMatch != null) {
            val recipient = hiMatch.groupValues[1].trim()
            val msg = hiMatch.groupValues[2].trim()
            if (recipient.isNotBlank()) {
                return VoiceCommand.PrepareWhatsAppMessage(recipient, msg)
            }
        }

        return null
    }

    private fun parseAppSearchWorkflow(raw: String): VoiceCommand.AppSearchWorkflow? {
        // Bengali: "ইউটিউবে গান খুঁজে দাও।" / "YouTube-এ নতুন গান সার্চ করো"
        val bnYoutube = Regex("^(?:ইউটিউবে|ইউটিউব-?এ|youtube-?এ|youtube\\s*এ)\\s+(.+?)\\s*(?:খুঁজে\\s*দাও|খুঁজো|সার্চ\\s*করো|চালাও)[.,?!।]*$", RegexOption.IGNORE_CASE).find(raw)
        if (bnYoutube != null && bnYoutube.groupValues[1].isNotBlank()) {
            return VoiceCommand.AppSearchWorkflow("YouTube", bnYoutube.groupValues[1].trim())
        }

        // English: "Search <query> on YouTube" / "Find <query> on YouTube"
        val enYoutube = Regex("^(?:search|find|play)\\s+(.+?)\\s+(?:on|in)\\s+(youtube|spotify|chrome|maps)[.,?!]*$", RegexOption.IGNORE_CASE).find(raw)
        if (enYoutube != null && enYoutube.groupValues[1].isNotBlank()) {
            return VoiceCommand.AppSearchWorkflow(enYoutube.groupValues[2].trim(), enYoutube.groupValues[1].trim())
        }

        // Hindi: "यूट्यूब पर गाने खोजो"
        val hiYoutube = Regex("^(?:यूट्यूब|youtube)\\s*(?:पर|में)\\s+(.+?)\\s*(?:खोजो|सर्च\\s*करो|चलाओ)[.,?!।]*$", RegexOption.IGNORE_CASE).find(raw)
        if (hiYoutube != null && hiYoutube.groupValues[1].isNotBlank()) {
            return VoiceCommand.AppSearchWorkflow("YouTube", hiYoutube.groupValues[1].trim())
        }

        return null
    }

    private fun isFlashlightOnCommand(raw: String): Boolean {
        val normalized = normalizeCommand(raw)
        if (isNonFlashlightLightQuery(normalized)) {
            return false
        }

        val englishOnRegex = Regex(
            "^(?:(?:please\\s+)?(?:turn\\s+on|switch\\s+on)\\s+(?:the\\s+)?(?:flashlight|torch|phone\\s+light|mobile\\s+light)|" +
            "(?:turn\\s+on|switch\\s+on)\\s+(?:the\\s+)?light|" +
            "(?:flashlight|torch)\\s+(?:on|please\\s+on|turn\\s+on|switch\\s+on)|" +
            "(?:phone|mobile)\\s+light\\s+(?:on|turn\\s+on))$",
            RegexOption.IGNORE_CASE
        )
        if (englishOnRegex.containsMatchIn(normalized)) return true

        val hasTorchNoun = Regex("(?:টর্চ|টরচ|ফ্ল্যাশ\\s*লাইট|ফ্লাস\\s*লাইট|মোবাইলের\\s*লাইট|ফোনের\\s*লাইট)").containsMatchIn(normalized)
        val hasOnVerb = Regex("(?:জ্বালাও|জ্বালিয়ে\\s*দাও|জ্বালিয়ে\\s*দাও|অন\\s*করো|অন\\s*কর|চালু\\s*করো|চালু\\s*কর)").containsMatchIn(normalized)
        if (hasTorchNoun && hasOnVerb) return true

        val directLightOn = Regex("^(?:মোবাইলের\\s*)?লাইট\\s*(?:অন\\s*করো|অন\\s*কর|জ্বালাও|জ্বালিয়ে\\s*দাও|জ্বালিয়ে\\s*দাও|চালু\\s*করো)$")
        if (directLightOn.containsMatchIn(normalized)) return true

        return false
    }

    private fun isFlashlightOffCommand(raw: String): Boolean {
        val normalized = normalizeCommand(raw)
        if (isNonFlashlightLightQuery(normalized)) {
            return false
        }

        val englishOffRegex = Regex(
            "^(?:(?:please\\s+)?(?:turn\\s+off|switch\\s+off)\\s+(?:the\\s+)?(?:flashlight|torch|phone\\s+light|mobile\\s+light)|" +
            "(?:turn\\s+off|switch\\s+off)\\s+(?:the\\s+)?light|" +
            "(?:flashlight|torch)\\s+(?:off|please\\s+off|turn\\s+off|switch\\s+off)|" +
            "(?:phone|mobile)\\s+light\\s+(?:off|turn\\s+off))$",
            RegexOption.IGNORE_CASE
        )
        if (englishOffRegex.containsMatchIn(normalized)) return true

        val hasTorchNoun = Regex("(?:টর্চ|টরচ|ফ্ল্যাশ\\s*লাইট|ফ্লাস\\s*লাইট|মোবাইলের\\s*লাইট|ফোনের\\s*লাইট)").containsMatchIn(normalized)
        val hasOffVerb = Regex("(?:বন্ধ\\s*করো|বন্ধ\\s*কর|বন্ধ\\s*করে\\s*দাও|অফ\\s*করো|অফ\\s*কর|নিভিয়ে\\s*দাও|নিভিয়ে\\s*দাও|নিভাও)").containsMatchIn(normalized)
        if (hasTorchNoun && hasOffVerb) return true

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
                lower.contains("স্ক্রিনে কী আছে") ||
                lower.contains("স্ক্রিনে কি আছে") ||
                lower.contains("আমার স্ক্রিন পড়ো") ||
                lower.contains("আমার স্ক্রিন পড়ো") ||
                lower.contains("পড়ে শোনাও") ||
                lower.contains("পড়ে শোনাও") ||
                lower.contains("what is on my screen") ||
                lower.contains("read my screen") ||
                lower.contains("read this screen") ||
                lower.contains("स्क्रीन पर क्या है")
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
        if (lower.contains("লোকেশন সেটিংস") || lower.contains("location settings")) {
            return VoiceCommand.OpenSettings(Settings.ACTION_LOCATION_SOURCE_SETTINGS, "Location Settings")
        }
        if (lower.contains("সাউন্ড সেটিংস") || lower.contains("sound settings")) {
            return VoiceCommand.OpenSettings(Settings.ACTION_SOUND_SETTINGS, "Sound Settings")
        }
        if (lower.contains("অ্যাপ সেটিংস") || lower.contains("app settings") || lower.contains("application settings")) {
            return VoiceCommand.OpenSettings(Settings.ACTION_APPLICATION_SETTINGS, "App Settings")
        }
        if (lower.contains("নোটিফিকেশন সেটিংস") || lower.contains("notification settings")) {
            return VoiceCommand.OpenSettings(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS, "Notification Settings")
        }
        if (lower.contains("অ্যাক্সেসিবিলিটি সেটিংস") || lower.contains("accessibility settings")) {
            return VoiceCommand.OpenSettings(Settings.ACTION_ACCESSIBILITY_SETTINGS, "Accessibility Settings")
        }
        if (lower.contains("নেটওয়ার্ক সেটিংস") || lower.contains("network settings")) {
            return VoiceCommand.OpenSettings(Settings.ACTION_WIRELESS_SETTINGS, "Network Settings")
        }
        if (lower.contains("সেটিংস খোলো") ||
            lower.contains("সেটিংস ওপেন করো") ||
            lower.contains("ফোনের সেটিংস") ||
            lower.contains("open settings") ||
            lower.contains("phone settings") ||
            lower.contains("सेटिंग्स खोलो")
        ) {
            return VoiceCommand.OpenSettings(Settings.ACTION_SETTINGS, "Settings")
        }
        return null
    }

    private fun parseDirectNumberCall(raw: String): VoiceCommand.CallDirectNumber? {
        val numberFirstRegex = Regex("([+0-9০-৯\\s-]{7,20})\\s*(?:নম্বরে|নাম্বারে)?\\s*(?:কল\\s*করো|ফোন\\s*করো|ডায়াল\\s*করো|ডায়াল\\s*করো)", RegexOption.IGNORE_CASE)
        val firstMatch = numberFirstRegex.find(raw)
        if (firstMatch != null) {
            val candidate = firstMatch.groupValues[1]
            val normResult = NumberNormalizer.normalizePhoneNumber(candidate)
            if (normResult is NumberNormalizerResult.ValidCandidate) {
                return VoiceCommand.CallDirectNumber(normResult.normalizedNumber, normResult.formatted)
            }
        }

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
        // Bengali: "আমার মাকে ফোন করো।", "রাহুলকে ফোন করো", "বাবাকে কল করো"
        val bengaliMatch = Regex("^(?:আমার\\s+)?([\\p{L}\\p{M}\\w\\s]+?)(?:কে|রে)?\\s*(?:ফোন\\s*করো|কল\\s*করো|ফোন\\s*দাও|কল\\s*দাও)[.,?!।]*$", RegexOption.IGNORE_CASE).find(raw)
        if (bengaliMatch != null) {
            val contact = bengaliMatch.groupValues[1].trim()
            if (contact.isNotBlank() && !contact.contains("নম্বর")) {
                return VoiceCommand.CallContact(contact)
            }
        }

        // English: "call Rahul", "call my mom"
        val englishMatch = Regex("^(?:please\\s+)?(?:call|phone)\\s+(?:my\\s+)?([\\p{L}\\p{M}\\w\\s]+?)[.,?!।]*$", RegexOption.IGNORE_CASE).find(raw)
        if (englishMatch != null) {
            val candidate = englishMatch.groupValues[1].trim()
            if (candidate.any { it.isLetter() } && !Regex("\\b(?:me|back|off|it|this|that)\\b", RegexOption.IGNORE_CASE).matches(candidate)) {
                return VoiceCommand.CallContact(candidate)
            }
        }

        // Hindi: "माँ को फोन करो", "राहुल को कॉल करो"
        val hindiMatch = Regex("^(?:मेरी\\s+|मेरे\\s+)?(.+?)\\s*को\\s*(?:कॉल\\s*करो|फोन\\s*करो|फ़ोन\\s*करो)[.,?!।]*$", RegexOption.IGNORE_CASE).find(raw)
        if (hindiMatch != null) {
            val candidate = hindiMatch.groupValues[1].trim()
            if (candidate.isNotBlank()) {
                return VoiceCommand.CallContact(candidate)
            }
        }

        return null
    }

    private fun parseAppLaunch(raw: String): VoiceCommand.OpenApp? {
        val openBengaliMatch = Regex("^([\\p{L}\\p{M}\\w\\s]+?)\\s*(?:খোলো|ওপেন\\s*করো|চালু\\s*করো)[.,?!।]*$", RegexOption.IGNORE_CASE).find(raw)
        if (openBengaliMatch != null) {
            val appQuery = openBengaliMatch.groupValues[1].trim()
            if (appQuery.isNotBlank() && !appQuery.contains("সেটিংস") && !appQuery.contains("টর্চ") && !appQuery.contains("লাইট")) {
                return VoiceCommand.OpenApp(appQuery)
            }
        }

        val openEnglishMatch = Regex("^(?:please\\s+)?(?:open|launch)\\s+([\\p{L}\\p{M}\\w\\s]+?)[.,?!।]*$", RegexOption.IGNORE_CASE).find(raw)
        if (openEnglishMatch != null) {
            val appQuery = openEnglishMatch.groupValues[1].trim()
            if (appQuery.isNotBlank() && !appQuery.contains("settings") && !appQuery.contains("flashlight")) {
                return VoiceCommand.OpenApp(appQuery)
            }
        }

        val openHindiMatch = Regex("^([\\p{L}\\p{M}\\w\\s]+?)\\s*खोलो[.,?!।]*$", RegexOption.IGNORE_CASE).find(raw)
        if (openHindiMatch != null) {
            val appQuery = openHindiMatch.groupValues[1].trim()
            if (appQuery.isNotBlank() && !appQuery.contains("सेटिंग्स")) {
                return VoiceCommand.OpenApp(appQuery)
            }
        }

        return null
    }
}
