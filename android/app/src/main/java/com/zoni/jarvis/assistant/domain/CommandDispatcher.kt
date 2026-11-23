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
            .replace(Regex("^(?:hey\\s+|ওহে\\s+|হেই\\s+)?(?:zoni\\s*ai|zoni|জোনি\\s*এআই|জোনি|জনি\\s*এআই|জনি|ज़ोनी\\s*एआई|ज़ोनी|जोनी)\\s*[,:\\-!।]*\\s*", RegexOption.IGNORE_CASE), "")
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

        // 0b. Strict Incoming & Active Phone Call Control (requires explicit call-control intent)
        val callCtrl = parseIncomingCallControlCommand(cleaned, lower)
        if (callCtrl != null) {
            return callCtrl
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

        // 2b. Advanced YouTube Click Engine commands (Bengali / English / Hindi)
        val ytClick = parseYouTubeClickCommand(cleaned, lower)
        if (ytClick != null) {
            return ytClick
        }

        // 2c. WhatsApp Smart Contact & Chat Name Click commands (Bengali / English / Hindi)
        val waContactClick = parseWhatsAppContactClickCommand(cleaned, lower)
        if (waContactClick != null) {
            return waContactClick
        }

        // 3. Scroll & Accessibility Navigation ("নিচে স্ক্রল করো।", "উপরে স্ক্রল করো", "go back", "go home")
        val navCmd = parseAccessibilityNav(cleaned, lower)
        if (navCmd != null) {
            return navCmd
        }

        // 4a. Direct SMS commands ("বাবাকে SMS পাঠাও: আমি বাড়ি ফিরছি", "Send SMS to Dad: I am coming")
        val smsCmd = parseSmsCommand(cleaned)
        if (smsCmd != null) {
            return smsCmd
        }

        // 4b. WhatsApp / Message commands ("রাহুলকে WhatsApp-এ মেসেজ পাঠাও: ...", "রাহুলকে একটা মেসেজ লিখে দাও।", "মাকে WhatsApp-এ বলো ...")
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

    private fun parseIncomingCallControlCommand(raw: String, lower: String): VoiceCommand? {
        val clean = lower.trimEnd('।', '.', '!', '?').trim()

        // Answer Incoming Call ("receive the call", "answer the call", "pick up the call", "কল রিসিভ করো", "ফোনটা ধরো", "कॉल उठाओ")
        if (Regex(
                "^(?:please\\s+)?(?:receive|answer|accept|pick\\s*up)\\s+(?:the\\s+|this\\s+|my\\s+|incoming\\s+)?(?:phone\\s+)?call$|" +
                "^(?:ইনকামিং\\s+)?(?:কলটা|কল|ফোনটা|ফোন)\\s*(?:রিসিভ\\s*করো|ধরো|ধরে\\s*নাও|তুলো|উঠাও|অ্যাকসেপ্ট\\s*করো)$|" +
                "^(?:इनकमिंग\\s+)?(?:कॉल|फ़ोन|फोन)\\s*(?:उठाओ|रिसीव\\s*करो|पिक\\s*करो|अटेंड\\s*करो)$",
                RegexOption.IGNORE_CASE
            ).matches(clean)
        ) {
            return VoiceCommand.AnswerIncomingCall(raw)
        }

        // Reject Incoming Call ("reject the call", "decline the call", "কল রিজেক্ট করো", "ইনকামিং কল কেটে দাও", "कॉल रिजेक्ट करो", "इनकमिंग कॉल काट दो")
        if (Regex(
                "^(?:please\\s+)?(?:reject|decline|dismiss|ignore)\\s+(?:the\\s+|this\\s+|my\\s+|incoming\\s+)?(?:phone\\s+)?call$|" +
                "^(?:ইনকামিং\\s+)?(?:কলটা|কল|ফোনটা|ফোন)\\s*(?:রিজেক্ট\\s*করো|বাতিল\\s*করো|না\\s*ধরে\\s*কাটো)$|" +
                "^ইনকামিং\\s+(?:কলটা|কল|ফোনটা|ফোন)\\s*কেটে\\s*দাও$|" +
                "^(?:इनकमिंग\\s+)?(?:कॉल|फ़ोन|फोन)\\s*(?:रिजेक्ट\\s*करो|डिक्लाइन\\s*करो|अस्वीकार\\s*करो)$|" +
                "^इनकमिंग\\s+(?:कॉल|फ़ोन|फोन)\\s*(?:काट\\s*दो|काटो)$",
                RegexOption.IGNORE_CASE
            ).matches(clean)
        ) {
            return VoiceCommand.RejectIncomingCall(raw)
        }

        // End Active Call ("end the call", "hang up", "disconnect the call", "কল কেটে দাও", "কল বন্ধ করো", "কল শেষ করো", "कॉल बंद करो", "कॉल काटो")
        if (Regex(
                "^(?:please\\s+)?(?:end|disconnect|cut|terminate|stop)\\s+(?:the\\s+|this\\s+|my\\s+|active\\s+|current\\s+)?(?:phone\\s+)?call$|" +
                "^(?:please\\s+)?hang\\s*up(?:\\s+(?:the\\s+)?call)?$|" +
                "^(?:চলমান\\s+)?(?:কলটা|কল|ফোনটা|ফোন)\\s*(?:কেটে\\s*দাও|বন্ধ\\s*করো|শেষ\\s*করো|ডিসকানেক্ট\\s*করো|রেখে\\s*দাও)$|" +
                "^(?:कॉल|फ़ोन|फोन)\\s*(?:काटो|काट\\s*दो|बंद\\s*करो|खत्म\\s*करो|डिस्कनेक्ट\\s*करो)$",
                RegexOption.IGNORE_CASE
            ).matches(clean)
        ) {
            return VoiceCommand.EndActiveCall(raw)
        }

        return null
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

    private fun parseOrdinal(text: String): Int? {
        val lower = text.lowercase()
        return when {
            Regex("(?:প্রথম|পহেলা|1st|\\bfirst\\b|पहला|पहले|प्रथम)").containsMatchIn(lower) -> 1
            Regex("(?:দ্বিতীয়|দ্বিতীয়|2nd|\\bsecond\\b|दूसरा|दूसरे|दूसरी)").containsMatchIn(lower) -> 2
            Regex("(?:তৃতীয়|তৃতীয়|3rd|\\bthird\\b|तीसरा|तीसरे)").containsMatchIn(lower) -> 3
            Regex("(?:চতুর্থ|4th|\\bfourth\\b|चौथा|चौथे)").containsMatchIn(lower) -> 4
            Regex("(?:পঞ্চম|5th|\\bfifth\\b|पांचवा|पाँचवाँ)").containsMatchIn(lower) -> 5
            else -> null
        }
    }

    private fun parseYouTubeClickCommand(raw: String, lower: String): VoiceCommand? {
        val clean = raw.trimEnd('।', '.', '!', '?').trim()

        // Pause Video ("ভিডিওটি Pause করো", "Pause the video", "ভিডিও পজ করো", "वीडियो पॉज़ करो")
        if (Regex("(?:pause|পজ|বিরতি|पॉज़|रोकें)", RegexOption.IGNORE_CASE).containsMatchIn(clean) &&
            Regex("(?:video|ভিডিও|वीडियो|playback|প্লেব্যাক|button|বাটন|করো|करो|the)", RegexOption.IGNORE_CASE).containsMatchIn(clean)
        ) {
            return VoiceCommand.ClickYouTubeVideo(index = null, targetHint = "pause_video")
        }

        // Stop Video ("ভিডিওটি Stop করো", "Stop the video", "ভিডিও বন্ধ করো", "वीडियो बंद करो")
        if (Regex("(?:stop|স্টপ|বন্ধ\\s*করো|बंद\\s*करो)", RegexOption.IGNORE_CASE).containsMatchIn(clean) &&
            Regex("(?:video|ভিডিও|वीडियो|playback|প্লেব্যাক)", RegexOption.IGNORE_CASE).containsMatchIn(clean)
        ) {
            return VoiceCommand.ClickYouTubeVideo(index = null, targetHint = "stop_video")
        }

        // Play Button ("Play Button চাপো", "Click the Play button", "প্লে বাটন চাপো")
        if (Regex("(?:play\\s*button|প্লে\\s*বাটন|प्ले\\s*बटन)", RegexOption.IGNORE_CASE).containsMatchIn(clean) &&
            Regex("(?:click|tap|press|চাপো|ক্লিক|ট্যাপ|दबाओ|क्लिक)", RegexOption.IGNORE_CASE).containsMatchIn(clean)
        ) {
            return VoiceCommand.ClickYouTubeVideo(index = null, targetHint = "play_button")
        }

        // Resume / Play current video ("ভিডিওটি Play করো", "ভিডিও আবার চালাও", "Play the video", "Resume the video")
        if (Regex("^(?:play|resume)\\s+(?:the\\s+|this\\s+)?video$|^ভিডিও(?:টি|টা)?\\s*(?:(?:play|প্লে|রিজিউম)\\s*করো|আবার\\s*চালাও)$|^वीडियो\\s*(?:प्ले|चलाओ|फिर\\s*से\\s*चलाओ)\\s*(?:करो)?$", RegexOption.IGNORE_CASE).matches(clean)) {
            return VoiceCommand.ClickYouTubeVideo(index = null, targetHint = "play_video")
        }

        // Thumbnail click ("এই ভিডিওর Thumbnail-এ ক্লিক করো", "Click this video's thumbnail")
        if (Regex("(?:thumbnail|থাম্বনেইল|थंबनेल)", RegexOption.IGNORE_CASE).containsMatchIn(clean) &&
            Regex("(?:click|tap|open|ক্লিক|ট্যাপ|খোলো|ওপেন|क्लिक)", RegexOption.IGNORE_CASE).containsMatchIn(clean)
        ) {
            return VoiceCommand.ClickYouTubeVideo(index = parseOrdinal(clean) ?: 1, targetHint = "thumbnail")
        }

        // Search Result click ("প্রথম সার্চ রেজাল্টে ক্লিক করো", "Open the first search result")
        if (Regex("(?:search\\s*result|সার্চ\\s*রেজাল্ট|सर्च\\s*रिजल्ट|सर्च\\s*परिणाम)", RegexOption.IGNORE_CASE).containsMatchIn(clean) &&
            Regex("(?:click|tap|open|play|ক্লিক|ওপেন|খোলো|চালাও|क्लिक|खोलो)", RegexOption.IGNORE_CASE).containsMatchIn(clean)
        ) {
            return VoiceCommand.ClickYouTubeSearchResult(index = parseOrdinal(clean) ?: 1)
        }

        // Video click/play/open ("প্রথম ভিডিওটি চালাও", "দ্বিতীয় ভিডিওতে ক্লিক করো", "এই ভিডিওটা ওপেন করো",
        // "Play the first video", "Click the second video", "Open this video",
        // "पहला वीडियो चलाओ", "दूसरे वीडियो पर क्लिक करो", "इस वीडियो को खोलो")
        val mentionsVideo = Regex("(?:video|ভিডিও|वीडियो)", RegexOption.IGNORE_CASE).containsMatchIn(clean)
        val hasVideoAction = Regex("(?:play|click|tap|open|select|চালাও|ক্লিক|ট্যাপ|ওপেন|খোলো|चलाओ|क्लिक|खोलो)", RegexOption.IGNORE_CASE).containsMatchIn(clean)
        if (mentionsVideo && hasVideoAction && !Regex("(?:youtube|ইউটিউব|यूट्यूब)\\s*(?:এ|पर|में|on|in)\\s+.+(?:খুঁজো|search|खोजो)", RegexOption.IGNORE_CASE).containsMatchIn(clean)) {
            val ord = parseOrdinal(clean)
            if (ord != null) {
                return VoiceCommand.ClickYouTubeVideo(index = ord, targetHint = "video_$ord")
            }
            if (Regex("(?:এই\\s*ভিডিও|this\\s+video|current\\s+video|इस\\s*वीडियो)", RegexOption.IGNORE_CASE).containsMatchIn(clean)) {
                return VoiceCommand.ClickYouTubeVideo(index = 1, targetHint = "current_video")
            }
        }
        return null
    }

    private fun parseWhatsAppContactClickCommand(raw: String, lower: String): VoiceCommand? {
        val clean = raw.trimEnd('।', '.', '!', '?').trim()
        val hasWaContext = Regex("(?:whatsapp|হোয়াটসঅ্যাপ|হোয়াটসঅ্যাপ|व्हाट्सएप|chat|চ্যাট|चैट|contact|কন্টাক্ট|कॉन्टैक्ट|নামের\\s*উপর|নামটিতে)", RegexOption.IGNORE_CASE).containsMatchIn(clean)
        if (!hasWaContext) return null

        // Do not hijack full message-sending commands ("রাহুলকে WhatsApp-এ মেসেজ পাঠাও: ...")
        if (Regex("(?:মেসেজ\\s*(?:পাঠাও|পাঠিয়ে|করো|লিখে)|message\\s+(?:to|saying)|मैसेज\\s*(?:भेजो|लिखो))", RegexOption.IGNORE_CASE).containsMatchIn(clean)) {
            return null
        }

        // 1. Ordinal chat / contact click ("নিচের দ্বিতীয় নামটিতে ক্লিক করো", "প্রথম Chat ওপেন করো", "Click the second contact", "Open the first chat", "दूसरा चैट खोलो")
        val ord = parseOrdinal(clean)
        if (ord != null && Regex("(?:chat|চ্যাট|चैट|contact|কন্টাক্ট|নাম|name)", RegexOption.IGNORE_CASE).containsMatchIn(clean)) {
            return if (Regex("(?:chat|চ্যাট|चैट)", RegexOption.IGNORE_CASE).containsMatchIn(clean)) {
                VoiceCommand.OpenWhatsAppChat(contactName = "", index = ord)
            } else {
                VoiceCommand.ClickWhatsAppContact(contactName = "", index = ord)
            }
        }

        // 2. Bengali: "WhatsApp-এ রাহুলের নামের উপর ক্লিক করো" / "এই Contact-এর নামের উপর ক্লিক করো"
        val bnClickName = Regex(
            "^(?:(?:whatsapp|হোয়াটসঅ্যাপ|হোয়াটসঅ্যাপ)(?:-?এ|\\s*এ)\\s+)?(.+?)\\s*(?:নামের\\s*উপর|নামটিতে|নামে)\\s*(?:ক্লিক\\s*করো|ট্যাপ\\s*করো|চাপো)$",
            RegexOption.IGNORE_CASE
        ).find(clean)
        if (bnClickName != null) {
            val rawPerson = bnClickName.groupValues[1].trim()
            val cleanedPerson = com.zoni.jarvis.assistant.service.MultilingualNameMatcher.cleanPersonQuery(rawPerson)
            if (Regex("^(?:এই\\s*)?(?:contact|কন্টাক্ট)(?:-?এর)?$", RegexOption.IGNORE_CASE).matches(rawPerson)) {
                return VoiceCommand.ClickWhatsAppContact(contactName = "", index = 1)
            }
            if (cleanedPerson.isNotBlank()) {
                return VoiceCommand.ClickWhatsAppContact(contactName = cleanedPerson)
            }
        }

        // 3. Bengali: "মায়ের Chat ওপেন করো" / "জাহিদার Chat খুলে দাও" / "WhatsApp-এ বাবাকে খুঁজে বের করো"
        val bnOpenChat = Regex(
            "^(?:(?:whatsapp|হোয়াটসঅ্যাপ|হোয়াটসঅ্যাপ)(?:-?এ|\\s*এ)\\s+)?(.+?)\\s*(?:chat|চ্যাট)\\s*(?:ওপেন\\s*করো|খুলে\\s*দাও|খোলো)$",
            RegexOption.IGNORE_CASE
        ).find(clean)
        if (bnOpenChat != null) {
            val person = com.zoni.jarvis.assistant.service.MultilingualNameMatcher.cleanPersonQuery(bnOpenChat.groupValues[1])
            if (person.isNotBlank()) return VoiceCommand.OpenWhatsAppChat(contactName = person)
        }
        val bnFindWa = Regex(
            "^(?:whatsapp|হোয়াটসঅ্যাপ|হোয়াটসঅ্যাপ)(?:-?এ|\\s*এ)\\s+(.+?)\\s*(?:খুঁজে\\s*বের\\s*করো|খুঁজে\\s*দাও|খুঁজো)$",
            RegexOption.IGNORE_CASE
        ).find(clean)
        if (bnFindWa != null) {
            val person = com.zoni.jarvis.assistant.service.MultilingualNameMatcher.cleanPersonQuery(bnFindWa.groupValues[1])
            if (person.isNotBlank()) return VoiceCommand.ClickWhatsAppContact(contactName = person)
        }

        // 4. English: "Click Rahul's name in WhatsApp", "Open my mother's chat", "Find this contact in WhatsApp"
        val enClickName = Regex(
            "^(?:click|tap|open)\\s+(?:on\\s+)?(.+?)(?:'s|’s)?\\s+(?:name|contact)(?:\\s+in\\s+whatsapp)?$",
            RegexOption.IGNORE_CASE
        ).find(clean)
        if (enClickName != null) {
            val rawPerson = enClickName.groupValues[1].trim()
            if (rawPerson.equals("this", ignoreCase = true)) {
                return VoiceCommand.ClickWhatsAppContact(contactName = "", index = 1)
            }
            val person = com.zoni.jarvis.assistant.service.MultilingualNameMatcher.cleanPersonQuery(rawPerson)
            if (person.isNotBlank()) return VoiceCommand.ClickWhatsAppContact(contactName = person)
        }
        val enOpenChat = Regex(
            "^(?:open|show)\\s+(?:my\\s+)?(.+?)(?:'s|’s)?\\s+chat(?:\\s+in\\s+whatsapp)?$",
            RegexOption.IGNORE_CASE
        ).find(clean)
        if (enOpenChat != null) {
            val person = com.zoni.jarvis.assistant.service.MultilingualNameMatcher.cleanPersonQuery(enOpenChat.groupValues[1])
            if (person.isNotBlank()) return VoiceCommand.OpenWhatsAppChat(contactName = person)
        }
        val enFindContact = Regex(
            "^(?:find|search)\\s+(?:for\\s+)?(.+?)\\s+in\\s+whatsapp$",
            RegexOption.IGNORE_CASE
        ).find(clean)
        if (enFindContact != null) {
            val rawPerson = enFindContact.groupValues[1].trim()
            if (Regex("^(?:this\\s+)?contact$", RegexOption.IGNORE_CASE).matches(rawPerson)) {
                return VoiceCommand.ClickWhatsAppContact(contactName = "", index = 1)
            }
            val person = com.zoni.jarvis.assistant.service.MultilingualNameMatcher.cleanPersonQuery(rawPerson)
            if (person.isNotBlank()) return VoiceCommand.ClickWhatsAppContact(contactName = person)
        }

        // 5. Hindi: "WhatsApp में राहुल के नाम पर क्लिक करो" / "मेरी माँ की चैट खोलो"
        val hiClickName = Regex(
            "^(?:(?:whatsapp|व्हाट्सएप)\\s*में\\s+)?(.+?)\\s*(?:के\\s*नाम\\s*पर|नाम\\s*पर)\\s*(?:क्लिक\\s*करो|टैप\\s*करो)$",
            RegexOption.IGNORE_CASE
        ).find(clean)
        if (hiClickName != null) {
            val person = com.zoni.jarvis.assistant.service.MultilingualNameMatcher.cleanPersonQuery(hiClickName.groupValues[1])
            if (person.isNotBlank()) return VoiceCommand.ClickWhatsAppContact(contactName = person)
        }
        val hiOpenChat = Regex(
            "^(?:(?:whatsapp|व्हाट्सएप)\\s*में\\s+)?(.+?)\\s*(?:की|का|के)?\\s*(?:चैट|chat)\\s*खोलो$",
            RegexOption.IGNORE_CASE
        ).find(clean)
        if (hiOpenChat != null) {
            val person = com.zoni.jarvis.assistant.service.MultilingualNameMatcher.cleanPersonQuery(hiOpenChat.groupValues[1])
            if (person.isNotBlank()) return VoiceCommand.OpenWhatsAppChat(contactName = person)
        }

        return null
    }

    private fun parseSmsCommand(raw: String): VoiceCommand.SendSms? {
        // Bengali: "বাবাকে SMS পাঠাও: আমি বাড়ি ফিরছি" / "মাকে এসএমএস পাঠিয়ে দাও আমি আসছি"
        val bnSms = Regex(
            "^(?:আমার\\s+)?(.+?)(?:কে|-কে)\\s*(?:একটা\\s+|একটি\\s+)?(?:sms|এসএমএস|এস\\.এম\\.এস)(?:-?এ|\\s*এ)?\\s*(?:মেসেজ\\s*)?(?:পাঠিয়ে\\s*দাও|পাঠিয়ে\\s*দাও|পাঠাও|করো|দাও|লিখে\\s*দাও)\\s*[:,-]?\\s*(.*)$",
            RegexOption.IGNORE_CASE
        ).find(raw)
        if (bnSms != null) {
            val recipient = bnSms.groupValues[1].trim()
            val msg = bnSms.groupValues[2].trim().trimEnd('।', '.')
            if (recipient.isNotBlank()) {
                return VoiceCommand.SendSms(recipient, msg)
            }
        }

        // English: "Send SMS to Baba: I am coming home" / "Send an SMS to Dad saying I am coming"
        val enSms = Regex(
            "^(?:please\\s+)?(?:send\\s+(?:an?\\s+)?)?(?:sms|text\\s+message)\\s+(?:message\\s+)?to\\s+(.+?)(?:\\s+(?:saying|that|message|:)\\s*(.+)|\\s*[:,-]\\s*(.+))?[.,?!]*$",
            RegexOption.IGNORE_CASE
        ).find(raw)
        if (enSms != null) {
            val recipient = enSms.groupValues[1].trim()
            val msg = (enSms.groupValues[2].ifBlank { enSms.groupValues[3] }).trim()
            if (recipient.isNotBlank()) {
                return VoiceCommand.SendSms(recipient, msg)
            }
        }

        // Hindi: "पापा को SMS भेजो: मैं घर आ रहा हूँ"
        val hiSms = Regex(
            "^(.+?)\\s*को\\s*(?:sms|एसएमएस)\\s*(?:मैसेज\\s*)?(?:भेज\\s*दो|भेजो|करो|लिखो)\\s*[:,-]?\\s*(.*)$",
            RegexOption.IGNORE_CASE
        ).find(raw)
        if (hiSms != null) {
            val recipient = hiSms.groupValues[1].trim()
            val msg = hiSms.groupValues[2].trim().trimEnd('।', '.')
            if (recipient.isNotBlank()) {
                return VoiceCommand.SendSms(recipient, msg)
            }
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
