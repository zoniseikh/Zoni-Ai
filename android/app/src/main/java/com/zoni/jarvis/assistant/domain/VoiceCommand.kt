package com.zoni.jarvis.assistant.domain

/**
 * Deterministic typed command models for Zoni AI.
 */
sealed class VoiceCommand {
    data class CallContact(val contactName: String) : VoiceCommand()
    data class CallDirectNumber(val phoneNumber: String, val formatted: String) : VoiceCommand()
    data class OpenApp(val appQuery: String, val packageName: String? = null) : VoiceCommand()
    data class ToggleFlashlight(val enable: Boolean) : VoiceCommand()
    data class OpenSettings(val settingsAction: String, val label: String) : VoiceCommand()
    data class ScreenQuery(val question: String) : VoiceCommand()
    data class SwitchLanguage(val languageCode: String, val label: String) : VoiceCommand()
    data class GeminiGeneralQuery(val rawQuery: String) : VoiceCommand()
    data class Unknown(val rawText: String) : VoiceCommand()
}
