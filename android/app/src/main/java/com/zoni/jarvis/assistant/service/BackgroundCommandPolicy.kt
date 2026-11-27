package com.zoni.jarvis.assistant.service

import com.zoni.jarvis.assistant.action.AllowedActionType
import com.zoni.jarvis.assistant.action.TypedActionRequest
import com.zoni.jarvis.assistant.domain.VoiceCommand
import java.text.Normalizer
import java.util.UUID

/**
 * Pure JVM-testable background voice assistant policy, phrase matcher,
 * continuous command mode state reducer, and shared VoiceCommand -> TypedActionRequest mapper.
 *
 * Enforces all background assistant guarantees:
 * 1. Exact voice-only Bengali wake response: "হ্যাঁ, বলো শুনছি।"
 * 2. Zero wake response notifications, zero screen popups, zero auto-opening MainActivity/WebView.
 * 3. Continuous command mode stays active across consecutive commands until user says
 *    "ধন্যবাদ জোনি" / "Stop Listening" (or stops the foreground service explicitly).
 */
enum class BackgroundAssistantMode {
    STOPPED,
    WAKE_WORD_LISTENING,
    WAKE_GREETING,
    CONTINUOUS_COMMAND_MODE,
    PAUSED_FOR_FOREGROUND_APP
}

data class BackgroundModeTransition(
    val nextMode: BackgroundAssistantMode,
    val shouldOpenActivity: Boolean = false,
    val shouldPostWakeNotification: Boolean = false,
    val spokenGreeting: String? = null,
    val shouldStartContinuousMic: Boolean = false,
    val shouldResumeWakeWord: Boolean = false,
    val shouldStopBackgroundLive: Boolean = false
)

sealed class BackgroundAssistantEvent {
    data class WakeWordDetected(val remainingCommand: String = "") : BackgroundAssistantEvent()
    data object WakeGreetingCompleted : BackgroundAssistantEvent()
    data object CommandCompleted : BackgroundAssistantEvent()
    data object GeminiTurnCompleted : BackgroundAssistantEvent()
    data object StopPhraseDetected : BackgroundAssistantEvent()
    data object ForegroundVoiceStarted : BackgroundAssistantEvent()
    data object ForegroundVoiceStopped : BackgroundAssistantEvent()
    data object AudioFocusLostOrCallStarted : BackgroundAssistantEvent()
    data object UnrecoverableBackgroundError : BackgroundAssistantEvent()
    data object UserStoppedService : BackgroundAssistantEvent()
}

object BackgroundCommandPolicy {

    const val WAKE_RESPONSE_PHRASE: String = "হ্যাঁ, বলো শুনছি।"

    private val EXACT_STOP_PHRASES = setOf(
        // Bengali stop phrases
        "ধন্যবাদ জোনি",
        "ধন্যবাদ জনি",
        "ধন্যবাদ জোনী",
        "ধন্যবাদ জনী",
        "ধন্যবাদ জুনি",
        "ধন্যবাদ জোনি এআই",
        "ধন্যবাদ জনি এআই",
        "অনেক ধন্যবাদ জোনি",
        "অনেক ধন্যবাদ জনি",
        "জোনি ধন্যবাদ",
        "জনি ধন্যবাদ",
        "থ্যাংক ইউ জোনি",
        "থ্যাঙ্ক ইউ জোনি",
        "থ্যাংক ইউ জনি",
        "থ্যাঙ্ক ইউ জনি",
        "থ্যাংকস জোনি",
        "থ্যাংকস জনি",
        "শোনা বন্ধ করো",
        "শোনা বন্ধ কর",
        "জোনি শোনা বন্ধ করো",
        "জনি শোনা বন্ধ করো",
        "কমান্ড মোড বন্ধ করো",
        "কমান্ড মোড অফ করো",
        "স্টপ লিসেনিং",
        "স্টপ লিসেনিং জোনি",
        "বাই জোনি",
        "বাই জনি",
        // English stop phrases
        "stop listening",
        "stop listening zoni",
        "stop listening zoni ai",
        "zoni stop listening",
        "zoni ai stop listening",
        "please stop listening",
        "stop command mode",
        "exit command mode",
        "close command mode",
        "end command mode",
        "thank you zoni",
        "thank you zoni ai",
        "thanks zoni",
        "thanks zoni ai",
        "thank you joni",
        "thanks joni",
        "zoni thank you",
        "bye zoni",
        "goodbye zoni",
        // Hindi stop phrases
        "धन्यवाद ज़ोनी",
        "धन्यवाद जोनी",
        "शुक्रिया ज़ोनी",
        "शुक्रिया जोनी",
        "सुनना बंद करो",
        "कमांड मोड बंद करो"
    )

    private val STOP_COMMAND_REGEX = Regex(
        "^(?:(?:ok|okay|alright|please|ঠিক\\s*আছে|আচ্ছা|ওকে)\\s+)?(?:" +
            "(?:অনেক\\s+)?(?:ধন্যবাদ|থ্যাংক\\s*ইউ|থ্যাঙ্ক\\s*ইউ|থ্যাংকস)\\s+(?:জোনি|জনি|জোনী|জনী|জুনি|zoni|joni)(?:\\s*(?:এআই|ai))?|" +
            "(?:জোনি|জনি|zoni)\\s+(?:অনেক\\s+)?(?:ধন্যবাদ|শোনা\\s*বন্ধ\\s*করো?|কমান্ড\\s*মোড\\s*(?:বন্ধ|অফ)\\s*করো?|stop\\s+listening)|" +
            "(?:শোনা\\s*বন্ধ\\s*করো?|কমান্ড\\s*মোড\\s*(?:বন্ধ|অফ)\\s*করো?|স্টপ\\s*লিসেনিং(?:\\s+(?:জোনি|জনি|zoni))?)|" +
            "(?:stop\\s+listening|stop\\s+command\\s+mode|exit\\s+command\\s+mode|close\\s+command\\s+mode|end\\s+command\\s+mode)(?:\\s+(?:zoni|joni|zoni\\s+ai|please))?|" +
            "(?:thank\\s+you|thanks|bye|goodbye)\\s+(?:zoni|joni|zonie|zony)(?:\\s+ai)?|" +
            "(?:धन्यवाद|शुक्रिया)\\s+(?:ज़ोनी|जोनी)|" +
            "(?:सुनना\\s*बंद\\s*करो|कमांड\\s*मोड\\s*बंद\\s*करो)" +
            ")$",
        RegexOption.IGNORE_CASE
    )

    fun normalizeSpokenText(raw: String): String {
        val nfc = Normalizer.normalize(raw, Normalizer.Form.NFC)
        return nfc.trim()
            .lowercase()
            .replace(Regex("[,.:;!?।\\-_\"'()]+"), " ")
            .replace(Regex("\\s+"), " ")
            .trim()
    }

    /**
     * Strictly matches explicit stop/exit phrases ("ধন্যবাদ জোনি", "Stop Listening", etc.)
     * while rejecting unrelated device/media commands like "Stop the video" or "গান বন্ধ করো".
     */
    fun isStopCommandModePhrase(rawText: String): Boolean {
        val normalized = normalizeSpokenText(rawText)
        if (normalized.isEmpty()) return false
        if (normalized in EXACT_STOP_PHRASES) return true
        return STOP_COMMAND_REGEX.matches(normalized)
    }

    /**
     * Pure deterministic reducer for the background voice assistant lifecycle.
     * Guarantees Activity and Wake Notifications are NEVER opened on wake word,
     * and Continuous Command Mode persists until an explicit stop phrase or user stop.
     */
    fun reduce(
        currentMode: BackgroundAssistantMode,
        event: BackgroundAssistantEvent
    ): BackgroundModeTransition {
        return when (event) {
            is BackgroundAssistantEvent.UserStoppedService -> BackgroundModeTransition(
                nextMode = BackgroundAssistantMode.STOPPED,
                shouldOpenActivity = false,
                shouldPostWakeNotification = false,
                shouldStopBackgroundLive = true
            )

            is BackgroundAssistantEvent.WakeWordDetected -> {
                if (currentMode != BackgroundAssistantMode.WAKE_WORD_LISTENING) {
                    BackgroundModeTransition(nextMode = currentMode)
                } else {
                    BackgroundModeTransition(
                        nextMode = BackgroundAssistantMode.WAKE_GREETING,
                        shouldOpenActivity = false,
                        shouldPostWakeNotification = false,
                        spokenGreeting = WAKE_RESPONSE_PHRASE,
                        shouldStartContinuousMic = false,
                        shouldResumeWakeWord = false
                    )
                }
            }

            is BackgroundAssistantEvent.WakeGreetingCompleted -> {
                if (currentMode != BackgroundAssistantMode.WAKE_GREETING) {
                    BackgroundModeTransition(nextMode = currentMode)
                } else {
                    BackgroundModeTransition(
                        nextMode = BackgroundAssistantMode.CONTINUOUS_COMMAND_MODE,
                        shouldOpenActivity = false,
                        shouldPostWakeNotification = false,
                        shouldStartContinuousMic = true
                    )
                }
            }

            is BackgroundAssistantEvent.CommandCompleted,
            is BackgroundAssistantEvent.GeminiTurnCompleted -> {
                if (currentMode == BackgroundAssistantMode.CONTINUOUS_COMMAND_MODE) {
                    // Stay in continuous command mode ready for subsequent commands
                    BackgroundModeTransition(
                        nextMode = BackgroundAssistantMode.CONTINUOUS_COMMAND_MODE,
                        shouldOpenActivity = false,
                        shouldPostWakeNotification = false,
                        shouldStartContinuousMic = true
                    )
                } else {
                    BackgroundModeTransition(nextMode = currentMode)
                }
            }

            is BackgroundAssistantEvent.StopPhraseDetected,
            is BackgroundAssistantEvent.AudioFocusLostOrCallStarted,
            is BackgroundAssistantEvent.UnrecoverableBackgroundError -> {
                if (currentMode == BackgroundAssistantMode.STOPPED ||
                    currentMode == BackgroundAssistantMode.PAUSED_FOR_FOREGROUND_APP
                ) {
                    BackgroundModeTransition(nextMode = currentMode)
                } else {
                    BackgroundModeTransition(
                        nextMode = BackgroundAssistantMode.WAKE_WORD_LISTENING,
                        shouldOpenActivity = false,
                        shouldPostWakeNotification = false,
                        shouldStopBackgroundLive = true,
                        shouldResumeWakeWord = true
                    )
                }
            }

            is BackgroundAssistantEvent.ForegroundVoiceStarted -> {
                if (currentMode == BackgroundAssistantMode.STOPPED) {
                    BackgroundModeTransition(nextMode = BackgroundAssistantMode.PAUSED_FOR_FOREGROUND_APP)
                } else {
                    BackgroundModeTransition(
                        nextMode = BackgroundAssistantMode.PAUSED_FOR_FOREGROUND_APP,
                        shouldOpenActivity = false,
                        shouldPostWakeNotification = false,
                        shouldStopBackgroundLive = true
                    )
                }
            }

            is BackgroundAssistantEvent.ForegroundVoiceStopped -> {
                if (currentMode == BackgroundAssistantMode.PAUSED_FOR_FOREGROUND_APP) {
                    BackgroundModeTransition(
                        nextMode = BackgroundAssistantMode.WAKE_WORD_LISTENING,
                        shouldOpenActivity = false,
                        shouldPostWakeNotification = false,
                        shouldResumeWakeWord = true
                    )
                } else {
                    BackgroundModeTransition(nextMode = currentMode)
                }
            }
        }
    }
}

/**
 * Shared mapper converting deterministic [VoiceCommand] outputs from [CommandDispatcher]
 * into allowlisted [TypedActionRequest] payloads for [DeviceActionExecutor].
 * Reused identically by both MainViewModel and ZoniForegroundService.
 */
object VoiceCommandActionMapper {

    fun toTypedActionRequest(cmd: VoiceCommand): TypedActionRequest? {
        fun build(type: AllowedActionType, args: Map<String, String> = emptyMap()) = TypedActionRequest(
            actionId = "loc_${UUID.randomUUID().toString().take(10)}",
            actionType = type,
            arguments = args,
            requiredPermissions = type.requiredPermissions,
            requiresConfirmation = false,
            timeoutMs = type.defaultTimeoutMs
        )

        return when (cmd) {
            is VoiceCommand.OpenApp -> build(AllowedActionType.OPEN_APP, mapOf("app_name" to cmd.appQuery))
            is VoiceCommand.AppSearchWorkflow -> when (cmd.appQuery.trim().lowercase()) {
                "youtube", "ইউটিউব", "यूट्यूब" -> build(
                    AllowedActionType.SEARCH_YOUTUBE,
                    mapOf("query" to cmd.searchQuery)
                )
                "chrome", "google", "web" -> build(
                    AllowedActionType.SEARCH_WEB,
                    mapOf("query" to cmd.searchQuery)
                )
                else -> build(AllowedActionType.OPEN_APP, mapOf("app_name" to cmd.appQuery))
            }
            is VoiceCommand.ScrollScreen -> build(AllowedActionType.SCROLL_SCREEN, mapOf("direction" to cmd.direction))
            is VoiceCommand.NavigateGlobal -> when (cmd.action.lowercase()) {
                "home", "go_home" -> build(AllowedActionType.GO_HOME)
                "back", "go_back" -> build(AllowedActionType.GO_BACK)
                else -> null
            }
            is VoiceCommand.TapVisibleElement -> build(AllowedActionType.CLICK_VISIBLE_ELEMENT, mapOf("target" to cmd.targetLabel))
            is VoiceCommand.ClickYouTubeVideo -> build(
                AllowedActionType.CLICK_YOUTUBE_VIDEO,
                buildMap {
                    cmd.index?.let { put("index", it.toString()) }
                    if (cmd.targetHint.isNotBlank()) put("target", cmd.targetHint)
                    if (cmd.query.isNotBlank()) put("query", cmd.query)
                }
            )
            is VoiceCommand.ClickYouTubeSearchResult -> build(
                AllowedActionType.CLICK_YOUTUBE_SEARCH_RESULT,
                mapOf("index" to cmd.index.toString(), "query" to cmd.query)
            )
            is VoiceCommand.ClickWhatsAppContact -> build(
                AllowedActionType.CLICK_WHATSAPP_CONTACT,
                buildMap {
                    if (cmd.contactName.isNotBlank()) put("contact_name", cmd.contactName)
                    cmd.index?.let { put("index", it.toString()) }
                }
            )
            is VoiceCommand.OpenWhatsAppChat -> build(
                AllowedActionType.OPEN_WHATSAPP_CHAT,
                buildMap {
                    if (cmd.contactName.isNotBlank()) put("contact_name", cmd.contactName)
                    cmd.index?.let { put("index", it.toString()) }
                }
            )
            is VoiceCommand.TypeWhatsAppMessage -> build(
                AllowedActionType.TYPE_WHATSAPP_MESSAGE,
                mapOf("recipient" to cmd.recipient, "message" to cmd.message)
            )
            is VoiceCommand.PrepareWhatsAppMessage -> build(
                AllowedActionType.SEND_WHATSAPP_MESSAGE,
                mapOf("recipient" to cmd.recipient, "message" to cmd.message)
            )
            is VoiceCommand.VerifyWhatsAppSend -> build(
                AllowedActionType.VERIFY_WHATSAPP_SEND,
                mapOf("recipient" to cmd.recipient, "message" to cmd.message)
            )
            is VoiceCommand.SendSms -> build(
                AllowedActionType.PREPARE_SMS,
                mapOf("recipient" to cmd.recipient, "message" to cmd.message)
            )
            is VoiceCommand.CallContact -> build(AllowedActionType.CALL_CONTACT, mapOf("recipient" to cmd.contactName))
            is VoiceCommand.CallDirectNumber -> build(AllowedActionType.CALL_CONTACT, mapOf("phone_number" to cmd.phoneNumber))
            is VoiceCommand.AnswerIncomingCall -> build(AllowedActionType.ANSWER_INCOMING_CALL)
            is VoiceCommand.RejectIncomingCall -> build(AllowedActionType.REJECT_INCOMING_CALL)
            is VoiceCommand.EndActiveCall -> build(AllowedActionType.END_ACTIVE_CALL)
            is VoiceCommand.ToggleFlashlight -> build(AllowedActionType.FLASHLIGHT_CONTROL, mapOf("enable" to cmd.enable.toString()))
            is VoiceCommand.OpenSettings -> build(AllowedActionType.OPEN_SYSTEM_SETTINGS, mapOf("target" to cmd.label))
            else -> null
        }
    }
}
