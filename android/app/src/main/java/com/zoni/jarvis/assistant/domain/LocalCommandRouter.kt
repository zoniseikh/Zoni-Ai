package com.zoni.jarvis.assistant.domain

import com.zoni.jarvis.assistant.audio.VoicePipelineStage

/**
 * Real-Time Local-First Command Router & Partial-Transcript Guard for Android.
 *
 * Guarantees:
 * 1. Streaming partial transcripts are inspected early WITHOUT executing incomplete fragments.
 * 2. Completed locally supported commands (YouTube, WhatsApp launch & contact navigation,
 *    installed apps, Contacts, Accessibility clicks/scrolls/navigation, Flashlight, Settings)
 *    dispatch directly on-device via DeviceActionExecutor / AppLauncher / ZoniAccessibilityService
 *    without waiting for Gemini Cloud (and work offline / on weak networks).
 * 3. Consequential actions (purchases, payments, money transfers) are explicitly guarded.
 * 4. Duplicate dispatches across partial -> final transcript transitions are suppressed within 2.5s.
 */
enum class LocalRouteDecisionKind {
    WAIT_FOR_MORE_SPEECH,
    PREVIEW_ONLY,
    LOCAL_DIRECT,
    LOCAL_DATETIME,
    CLOUD_GEMINI_STREAMING,
    BLOCKED_UNSAFE,
    REQUIRES_EXPLICIT_AUTHORIZATION,
    DUPLICATE_SUPPRESSED
}

data class LocalRouteDecision(
    val kind: LocalRouteDecisionKind,
    val normalizedText: String,
    val isPartial: Boolean,
    val command: VoiceCommand? = null,
    val dateTimeQuery: BengaliDateTimeEngine.DateTimeQueryType? = null,
    val primaryLatencyStage: VoicePipelineStage? = null,
    val incompleteReason: String? = null,
    val blockedReason: String? = null,
    val worksOffline: Boolean = false
)

class LocalCommandRouter(
    private val commandDispatcher: CommandDispatcher = CommandDispatcher(),
    private val dedupWindowMs: Long = 2500L,
    private val clockMs: () -> Long = { System.currentTimeMillis() }
) {
    private var lastExecutedKey: String = ""
    private var lastExecutedAtMs: Long = 0L

    fun resetDeduplication() {
        lastExecutedKey = ""
        lastExecutedAtMs = 0L
    }

    fun route(rawText: String, isFinal: Boolean): LocalRouteDecision {
        val clean = rawText.trim()
        if (clean.isEmpty()) {
            return LocalRouteDecision(
                kind = LocalRouteDecisionKind.WAIT_FOR_MORE_SPEECH,
                normalizedText = "",
                isPartial = !isFinal,
                incompleteReason = "empty_transcript",
                worksOffline = true
            )
        }

        // 1. Guard financial/purchase consequential actions
        val consequentialReason = checkConsequentialAuthorization(clean)
        if (consequentialReason != null) {
            return LocalRouteDecision(
                kind = LocalRouteDecisionKind.REQUIRES_EXPLICIT_AUTHORIZATION,
                normalizedText = clean,
                isPartial = !isFinal,
                blockedReason = consequentialReason,
                worksOffline = true
            )
        }

        // 2. Guard shell / unsafe payloads
        if (FORBIDDEN_SHELL_PATTERNS.any { it.containsMatchIn(clean) }) {
            return LocalRouteDecision(
                kind = LocalRouteDecisionKind.BLOCKED_UNSAFE,
                normalizedText = clean,
                isPartial = !isFinal,
                blockedReason = "Arbitrary shell commands or unsafe execution payloads are strictly blocked by Zoni AI security policy.",
                worksOffline = true
            )
        }

        // 3. Partial transcript safety: NEVER execute on incomplete partials
        val incompleteReason = detectIncompletePartialReason(clean)
        if (!isFinal) {
            if (incompleteReason != null) {
                return LocalRouteDecision(
                    kind = LocalRouteDecisionKind.WAIT_FOR_MORE_SPEECH,
                    normalizedText = clean,
                    isPartial = true,
                    incompleteReason = incompleteReason,
                    worksOffline = true
                )
            }
            val previewCmd = parseWithWhatsAppNavigationBoost(clean)
            val previewDt = BengaliDateTimeEngine.detectDateTimeQuery(clean)
            val isLocalPreview = isLocalDirectCommand(previewCmd)
            return LocalRouteDecision(
                kind = LocalRouteDecisionKind.PREVIEW_ONLY,
                normalizedText = clean,
                isPartial = true,
                command = if (isLocalPreview) previewCmd else null,
                dateTimeQuery = previewDt,
                primaryLatencyStage = if (isLocalPreview) classifyLatencyStage(previewCmd) else null,
                worksOffline = isLocalPreview || previewDt != null
            )
        }

        // 4. Final / completed utterance -> local-first dispatch
        val parsed = parseWithWhatsAppNavigationBoost(clean)
        if (isLocalDirectCommand(parsed)) {
            val key = "${parsed::class.simpleName}:${clean.lowercase()}"
            val now = clockMs()
            if (key == lastExecutedKey && (now - lastExecutedAtMs) < dedupWindowMs) {
                return LocalRouteDecision(
                    kind = LocalRouteDecisionKind.DUPLICATE_SUPPRESSED,
                    normalizedText = clean,
                    isPartial = false,
                    command = parsed,
                    primaryLatencyStage = classifyLatencyStage(parsed),
                    worksOffline = true
                )
            }
            lastExecutedKey = key
            lastExecutedAtMs = now
            return LocalRouteDecision(
                kind = LocalRouteDecisionKind.LOCAL_DIRECT,
                normalizedText = clean,
                isPartial = false,
                command = parsed,
                primaryLatencyStage = classifyLatencyStage(parsed),
                worksOffline = true
            )
        }

        val dtQuery = BengaliDateTimeEngine.detectDateTimeQuery(clean)
        if (dtQuery != null) {
            return LocalRouteDecision(
                kind = LocalRouteDecisionKind.LOCAL_DATETIME,
                normalizedText = clean,
                isPartial = false,
                dateTimeQuery = dtQuery,
                primaryLatencyStage = VoicePipelineStage.LOCAL_ACTION_DISPATCH,
                worksOffline = true
            )
        }

        return LocalRouteDecision(
            kind = LocalRouteDecisionKind.CLOUD_GEMINI_STREAMING,
            normalizedText = clean,
            isPartial = false,
            command = parsed,
            worksOffline = false
        )
    }

    private fun parseWithWhatsAppNavigationBoost(clean: String): VoiceCommand {
        WA_SEARCH_EN_REGEX.matchEntire(clean)?.let { match ->
            val contact = match.groupValues[1].trim()
            if (contact.isNotBlank()) return VoiceCommand.OpenWhatsAppChat(contactName = contact)
        }
        WA_SEARCH_BN_REGEX.matchEntire(clean)?.let { match ->
            val contact = match.groupValues[1].trim()
            if (contact.isNotBlank()) return VoiceCommand.OpenWhatsAppChat(contactName = contact)
        }
        return commandDispatcher.parseCommand(clean)
    }

    companion object {
        private val INCOMPLETE_SINGLE_WORDS = setOf(
            "open", "launch", "start", "play", "call", "dial", "message", "send",
            "whatsapp", "youtube", "click", "tap", "press", "scroll", "go",
            "search", "find", "turn", "set", "volume", "flashlight", "torch",
            "settings", "zoni", "জোনি", "খোলো", "খুলো", "কল", "মেসেজ", "ক্লিক",
            "স্ক্রল", "সার্চ", "হোয়াটসঅ্যাপ", "ইউটিউব", "खोलो", "कॉल", "मैसेज"
        )

        private val TRAILING_CONNECTORS = setOf(
            "to", "on", "in", "at", "for", "with", "from", "the", "a", "an",
            "and", "then", "or", "saying", "that", "my",
            "এবং", "তারপর", "আর", "কে", "এ", "তে", "থেকে", "দিয়ে", "করে", "বলো",
            "और", "को", "में", "पर", "से"
        )

        private val INCOMPLETE_VERB_PHRASE_REGEX = Regex(
            "^(?:open|launch|click|tap|call|search|scroll|turn|set)\\s+(?:the|a|on|for|to|my)$",
            RegexOption.IGNORE_CASE
        )

        private val INCOMPLETE_APP_LOCATIVE_REGEX = Regex(
            "(?:whatsapp[- ]?এ|হোয়াটসঅ্যাপে|হোয়াটসঅ্যাপে|youtube[- ]?এ|ইউটিউবে)$",
            RegexOption.IGNORE_CASE
        )

        private val CONSEQUENTIAL_PATTERNS = listOf(
            Regex(
                "\\b(?:buy\\s+now|place\\s+(?:the\\s+)?order|confirm\\s+(?:the\\s+)?(?:payment|purchase|transfer|order)|pay\\s+(?:now|\\$|₹|rs\\.?|rupees|taka|\\d+)|send\\s+money|transfer\\s+(?:money|funds|\\$|₹|\\d+)|upi\\s+pay|checkout\\s+now)\\b",
                RegexOption.IGNORE_CASE
            ),
            Regex("(?:পেমেন্ট\\s*(?:করো|করে\\s*দাও|কনফার্ম)|টাকা\\s*(?:পাঠাও|ট্রান্সফার)|অর্ডার\\s*(?:কনফার্ম|প্লেস)|কিনে\\s*ফেলো)"),
            Regex("(?:पेमेंट\\s*(?:करो|कर\\s*दो)|पैसे\\s*(?:भेजो|ट्रांसफर)|ऑर्डर\\s*कन्फर्म)")
        )

        private val FORBIDDEN_SHELL_PATTERNS = listOf(
            Regex("\\b(?:rm\\s+-rf|sudo|chmod|chown|mkfs|dd\\s+if=|bash\\s+-c|sh\\s+-c|su\\s+-c|eval\\()\\b", RegexOption.IGNORE_CASE),
            Regex("(?:javascript:|/system/bin/)", RegexOption.IGNORE_CASE)
        )

        private val WA_SEARCH_EN_REGEX = Regex(
            "^(?:open\\s+)?whatsapp(?:\\s+and)?\\s+(?:search|find|open|go\\s+to)\\s+(?:contact\\s+|chat\\s+(?:with\\s+)?)?(.+?)(?:\\s+chat|\\s+conversation)?$",
            RegexOption.IGNORE_CASE
        )

        private val WA_SEARCH_BN_REGEX = Regex(
            "^(?:হোয়াটসঅ্যাপ|হোয়াটসঅ্যাপ|whatsapp)(?:-?এ|ে|\\s+খুলে|\\s+ওপেন\\s+করে)?\\s+(.+?)(?:কে|-কে|\\s+এর\\s+চ্যাট|\\s+চ্যাট)?\\s*(?:খুঁজো|খোঁজো|সার্চ\\s*করো|চ্যাট\\s*খোলো|খোলো|ওপেন\\s*করো)$",
            RegexOption.IGNORE_CASE
        )

        fun detectIncompletePartialReason(rawText: String): String? {
            val clean = rawText.trim().trimEnd('।', '.', ',', '!', '?').trim()
            if (clean.isEmpty()) return "empty_transcript"
            val tokens = clean.split(Regex("\\s+")).filter { it.isNotBlank() }
            val lower = clean.lowercase()
            if (tokens.size == 1 && lower in INCOMPLETE_SINGLE_WORDS) {
                return "single_leading_command_word"
            }
            if (tokens.size == 1 && INCOMPLETE_APP_LOCATIVE_REGEX.containsMatchIn(clean)) {
                return "incomplete_app_context_prefix"
            }
            val last = tokens.last().lowercase().trim('"', '\'', '`')
            if (last in TRAILING_CONNECTORS) {
                return "dangling_trailing_connector"
            }
            if (INCOMPLETE_VERB_PHRASE_REGEX.matches(lower)) {
                return "incomplete_verb_phrase"
            }
            return null
        }

        fun checkConsequentialAuthorization(rawText: String): String? {
            if (CONSEQUENTIAL_PATTERNS.any { it.containsMatchIn(rawText) }) {
                return "Purchases, payments, and financial transfers require explicit manual authorization and are never executed automatically."
            }
            return null
        }

        fun isLocalDirectCommand(cmd: VoiceCommand): Boolean = when (cmd) {
            is VoiceCommand.OpenApp,
            is VoiceCommand.ScrollScreen,
            is VoiceCommand.NavigateGlobal,
            is VoiceCommand.TapVisibleElement,
            is VoiceCommand.ClickYouTubeVideo,
            is VoiceCommand.ClickYouTubeSearchResult,
            is VoiceCommand.ClickWhatsAppContact,
            is VoiceCommand.OpenWhatsAppChat,
            is VoiceCommand.TypeWhatsAppMessage,
            is VoiceCommand.PrepareWhatsAppMessage,
            is VoiceCommand.VerifyWhatsAppSend,
            is VoiceCommand.SendSms,
            is VoiceCommand.CallContact,
            is VoiceCommand.CallDirectNumber,
            is VoiceCommand.AnswerIncomingCall,
            is VoiceCommand.RejectIncomingCall,
            is VoiceCommand.EndActiveCall,
            is VoiceCommand.ToggleFlashlight,
            is VoiceCommand.OpenSettings -> true
            else -> false
        }

        fun classifyLatencyStage(cmd: VoiceCommand): VoicePipelineStage = when (cmd) {
            is VoiceCommand.OpenApp -> VoicePipelineStage.APPLICATION_LAUNCH
            is VoiceCommand.ScrollScreen,
            is VoiceCommand.NavigateGlobal,
            is VoiceCommand.TapVisibleElement,
            is VoiceCommand.ClickYouTubeVideo,
            is VoiceCommand.ClickYouTubeSearchResult,
            is VoiceCommand.ClickWhatsAppContact,
            is VoiceCommand.OpenWhatsAppChat,
            is VoiceCommand.TypeWhatsAppMessage,
            is VoiceCommand.VerifyWhatsAppSend -> VoicePipelineStage.ACCESSIBILITY_INTERACTION
            else -> VoicePipelineStage.LOCAL_ACTION_DISPATCH
        }
    }
}
