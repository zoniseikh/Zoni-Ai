package com.zoni.jarvis.assistant.domain

/**
 * Deterministic typed command models for Zoni AI (Bengali, English, Hindi).
 */
sealed class VoiceCommand {
    data class CallContact(val contactName: String) : VoiceCommand()
    data class CallDirectNumber(val phoneNumber: String, val formatted: String) : VoiceCommand()
    data class OpenApp(val appQuery: String, val packageName: String? = null) : VoiceCommand()
    data class AppSearchWorkflow(val appQuery: String, val searchQuery: String) : VoiceCommand()
    data class PrepareWhatsAppMessage(val recipient: String, val message: String) : VoiceCommand()
    data class SendSms(val recipient: String, val message: String) : VoiceCommand()
    data class ReviewPendingDraft(val rawText: String) : VoiceCommand()
    data class ApprovePendingAction(val rawText: String) : VoiceCommand()
    data class CancelCurrentTask(val rawText: String) : VoiceCommand()
    data class ScrollScreen(val direction: String) : VoiceCommand()
    data class NavigateGlobal(val action: String) : VoiceCommand()
    data class TapVisibleElement(val targetLabel: String) : VoiceCommand()
    data class ClickYouTubeVideo(val index: Int? = null, val targetHint: String = "", val query: String = "") : VoiceCommand()
    data class ClickYouTubeSearchResult(val index: Int = 1, val query: String = "") : VoiceCommand()
    data class ClickWhatsAppContact(val contactName: String = "", val index: Int? = null) : VoiceCommand()
    data class OpenWhatsAppChat(val contactName: String = "", val index: Int? = null) : VoiceCommand()
    data class TypeWhatsAppMessage(val recipient: String = "", val message: String) : VoiceCommand()
    data class VerifyWhatsAppSend(val recipient: String = "", val message: String = "") : VoiceCommand()
    data class AnswerIncomingCall(val rawText: String) : VoiceCommand()
    data class RejectIncomingCall(val rawText: String) : VoiceCommand()
    data class EndActiveCall(val rawText: String) : VoiceCommand()
    data class ToggleFlashlight(val enable: Boolean) : VoiceCommand()
    data class OpenSettings(val settingsAction: String, val label: String) : VoiceCommand()
    data class ScreenQuery(val question: String) : VoiceCommand()
    data class SwitchLanguage(val languageCode: String, val label: String) : VoiceCommand()
    data class GeminiGeneralQuery(val rawQuery: String) : VoiceCommand()
    data class Unknown(val rawText: String) : VoiceCommand()
}
