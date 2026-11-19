package com.zoni.jarvis.assistant.domain

enum class AssistantState {
    IDLE,
    CONNECTING,
    LISTENING,
    THINKING,
    SPEAKING,
    ERROR
}

enum class CompanionMode(
    val id: String,
    val title: String,
    val subtitleBengali: String
) {
    ROMANTIC("romantic", "Romantic & Caring", "ভালোবাসাময়, মিষ্টি ও যত্নশীল সঙ্গিনী (Caring AI GF)"),
    JARVIS_GF("jarvis_gf", "Jarvis Tactical GF", "ট্যাকটিক্যাল জার্ভিস এআই + স্মার্ট পার্সোনাল গার্ডিয়ান"),
    PLAYFUL("playful", "Playful & Teasing", "মিষ্টি খুনসুটি, দুষ্টুমি ও আনন্দময় সঙ্গ"),
    LATE_NIGHT("late_night", "Late Night Cozy", "শান্ত রাতের মৃদু কণ্ঠ, মানসিক প্রশান্তি ও স্বস্তি");

    companion object {
        fun fromId(id: String?): CompanionMode =
            entries.firstOrNull { it.id.equals(id, ignoreCase = true) } ?: ROMANTIC
    }
}

enum class SupportedLanguage(
    val code: String,
    val shortLabel: String,
    val displayLabel: String
) {
    BENGALI("bn-BD", "বাংলা (BD)", "বাংলা (Bengali - BD)"),
    HINDI("hi-IN", "हिंदी (IN)", "हिंदी (Hindi - IN)"),
    ENGLISH("en-US", "English (US)", "English (US)");

    companion object {
        fun fromCode(code: String?): SupportedLanguage =
            entries.firstOrNull { it.code.equals(code, ignoreCase = true) } ?: BENGALI
    }
}

enum class VoiceProfile(
    val id: String,
    val label: String,
    val description: String
) {
    KORE("Kore", "Kore (Sweet & Warm GF)", "Lovable, affectionate, natural girlfriend tone"),
    AOEDE("Aoede", "Aoede (Melodic Whisper)", "Gentle, soothing, dreamy & soft"),
    ZEPHYR("Zephyr", "Zephyr (Jarvis Crisp)", "Smooth, analytical yet caring sci-fi assistant"),
    PUCK("Puck", "Puck (Playful & Bubbly)", "Cheeky, energetic, laughing & teasing");

    companion object {
        fun fromId(id: String?): VoiceProfile =
            entries.firstOrNull { it.id.equals(id, ignoreCase = true) } ?: KORE
    }
}

enum class WsConnectionStatus {
    DISCONNECTED,
    CONNECTING,
    CONNECTED,
    RECONNECTING,
    ERROR
}

enum class MessageRole {
    USER,
    ASSISTANT
}

data class ChatMessage(
    val id: String,
    val role: MessageRole,
    val text: String,
    val timestampMillis: Long = System.currentTimeMillis(),
    val lang: SupportedLanguage = SupportedLanguage.BENGALI
)

enum class ActionType {
    CALL,
    SMS,
    WHATSAPP,
    FLASHLIGHT,
    VIBRATE,
    BATTERY,
    NOTIFICATION,
    APP,
    SETTINGS,
    ACCESSIBILITY
}

data class AssistantAction(
    val type: ActionType,
    val target: String = "",
    val payload: String = "",
    val label: String
)

data class LanguageSwitchResult(
    val lang: SupportedLanguage,
    val label: String,
    val confirmation: String
)

data class AffectionOption(
    val value: String,
    val label: String,
    val aliases: List<String>
)

object ZoniPresets {
    val PREDEFINED_AFFECTION_OPTIONS = listOf(
        AffectionOption("Boss", "Boss", listOf("boss", "বস")),
        AffectionOption("Jaan", "জান (Jaan)", listOf("jaan", "জান", "জান (jaan)")),
        AffectionOption("Hero", "হিরো (Hero)", listOf("hero", "হিরো", "হিরো (hero)")),
        AffectionOption("Babu", "বাবু (Babu)", listOf("babu", "বাবু", "বাবু (babu)")),
        AffectionOption("Sweetheart", "Sweetheart", listOf("sweetheart", "সুইটহার্ট"))
    )
}
