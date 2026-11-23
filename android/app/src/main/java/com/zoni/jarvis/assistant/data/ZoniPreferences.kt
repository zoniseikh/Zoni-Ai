package com.zoni.jarvis.assistant.data

import android.content.Context
import android.content.SharedPreferences
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.zoni.jarvis.assistant.domain.CompanionMode
import com.zoni.jarvis.assistant.domain.SupportedLanguage
import com.zoni.jarvis.assistant.domain.VoiceProfile
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

private val Context.zoniDataStore: DataStore<Preferences> by preferencesDataStore(name = "zoni_ai_prefs")

data class ZoniUserSettings(
    val selectedAffectionName: String = "Boss",
    val activeLanguage: SupportedLanguage = SupportedLanguage.BENGALI,
    val activeMode: CompanionMode = CompanionMode.ROMANTIC,
    val selectedVoice: VoiceProfile = VoiceProfile.KORE,
    val voiceAutoPlay: Boolean = true,
    val voiceMuted: Boolean = false,
    val soundFxEnabled: Boolean = true,
    val onboardingCompleted: Boolean = false,
    val floatingOrbEnabled: Boolean = false,
    val wakeWordEnabled: Boolean = false,
    val backgroundListeningEnabled: Boolean = false,
    val wakePhrase: String = "Zoni"
)

class ZoniPreferences(private val context: Context) {

    private object Keys {
        val AFFECTION_NAME = stringPreferencesKey("zoni_selected_affection_name")
        val ACTIVE_LANGUAGE = stringPreferencesKey("zoni_active_language")
        val ACTIVE_MODE = stringPreferencesKey("zoni_companion_mode")
        val SELECTED_VOICE = stringPreferencesKey("zoni_selected_voice")
        val VOICE_AUTO_PLAY = booleanPreferencesKey("zoni_voice_autoplay")
        val VOICE_MUTED = booleanPreferencesKey("zoni_voice_muted")
        val SOUND_FX = booleanPreferencesKey("zoni_sound_fx")
        val ONBOARDING_DONE = booleanPreferencesKey("zoni_onboarding_completed")
        val FLOATING_ORB = booleanPreferencesKey("zoni_floating_orb_enabled")
        val WAKE_WORD_ENABLED = booleanPreferencesKey("zoni_wake_word_enabled")
        val BACKGROUND_LISTENING_ENABLED = booleanPreferencesKey("zoni_background_listening_enabled")
        val WAKE_PHRASE = stringPreferencesKey("zoni_wake_phrase")
    }

    private val syncPrefs: SharedPreferences by lazy {
        context.getSharedPreferences("zoni_wake_sync_prefs", Context.MODE_PRIVATE)
    }

    private val secureKeyManager: SecureKeyManager by lazy {
        SecureKeyManager(context.applicationContext)
    }

    val settingsFlow: Flow<ZoniUserSettings> = context.zoniDataStore.data.map { prefs ->
        ZoniUserSettings(
            selectedAffectionName = prefs[Keys.AFFECTION_NAME]?.takeIf { it.isNotBlank() } ?: "Boss",
            activeLanguage = SupportedLanguage.fromCode(prefs[Keys.ACTIVE_LANGUAGE]),
            activeMode = CompanionMode.fromId(prefs[Keys.ACTIVE_MODE]),
            selectedVoice = VoiceProfile.fromId(prefs[Keys.SELECTED_VOICE]),
            voiceAutoPlay = prefs[Keys.VOICE_AUTO_PLAY] ?: true,
            voiceMuted = prefs[Keys.VOICE_MUTED] ?: false,
            soundFxEnabled = prefs[Keys.SOUND_FX] ?: true,
            onboardingCompleted = prefs[Keys.ONBOARDING_DONE] ?: false,
            floatingOrbEnabled = prefs[Keys.FLOATING_ORB] ?: false,
            wakeWordEnabled = prefs[Keys.WAKE_WORD_ENABLED] ?: isWakeWordEnabledSync(),
            backgroundListeningEnabled = prefs[Keys.BACKGROUND_LISTENING_ENABLED] ?: isBackgroundListeningEnabledSync(),
            wakePhrase = prefs[Keys.WAKE_PHRASE]?.takeIf { it.isNotBlank() } ?: getWakePhraseSync()
        )
    }

    suspend fun setAffectionName(name: String) {
        val clean = name.trim().ifEmpty { return }
        context.zoniDataStore.edit { it[Keys.AFFECTION_NAME] = clean }
    }

    suspend fun setLanguage(lang: SupportedLanguage) {
        context.zoniDataStore.edit { it[Keys.ACTIVE_LANGUAGE] = lang.code }
    }

    suspend fun setMode(mode: CompanionMode) {
        context.zoniDataStore.edit { it[Keys.ACTIVE_MODE] = mode.id }
    }

    suspend fun setVoice(voice: VoiceProfile) {
        context.zoniDataStore.edit { it[Keys.SELECTED_VOICE] = voice.id }
    }

    suspend fun setVoiceAutoPlay(enabled: Boolean) {
        context.zoniDataStore.edit { it[Keys.VOICE_AUTO_PLAY] = enabled }
    }

    suspend fun setVoiceMuted(muted: Boolean) {
        context.zoniDataStore.edit { it[Keys.VOICE_MUTED] = muted }
    }

    suspend fun setSoundFxEnabled(enabled: Boolean) {
        context.zoniDataStore.edit { it[Keys.SOUND_FX] = enabled }
    }

    suspend fun setOnboardingCompleted(completed: Boolean) {
        context.zoniDataStore.edit { it[Keys.ONBOARDING_DONE] = completed }
    }

    suspend fun setFloatingOrbEnabled(enabled: Boolean) {
        context.zoniDataStore.edit { it[Keys.FLOATING_ORB] = enabled }
    }

    suspend fun setWakeWordEnabled(enabled: Boolean) {
        setWakeWordEnabledSync(enabled)
        context.zoniDataStore.edit { it[Keys.WAKE_WORD_ENABLED] = enabled }
    }

    suspend fun setBackgroundListeningEnabled(enabled: Boolean) {
        setBackgroundListeningEnabledSync(enabled)
        context.zoniDataStore.edit { it[Keys.BACKGROUND_LISTENING_ENABLED] = enabled }
    }

    suspend fun setWakePhrase(phrase: String) {
        val clean = phrase.trim().ifBlank { "Zoni" }
        setWakePhraseSync(clean)
        context.zoniDataStore.edit { it[Keys.WAKE_PHRASE] = clean }
    }

    fun isWakeWordEnabledSync(): Boolean = syncPrefs.getBoolean(SYNC_WAKE_WORD_ENABLED, false)

    fun setWakeWordEnabledSync(enabled: Boolean) {
        syncPrefs.edit().putBoolean(SYNC_WAKE_WORD_ENABLED, enabled).apply()
    }

    fun isBackgroundListeningEnabledSync(): Boolean = syncPrefs.getBoolean(SYNC_BG_LISTENING_ENABLED, false)

    fun setBackgroundListeningEnabledSync(enabled: Boolean) {
        syncPrefs.edit().putBoolean(SYNC_BG_LISTENING_ENABLED, enabled).apply()
    }

    fun getWakePhraseSync(): String =
        syncPrefs.getString(SYNC_WAKE_PHRASE, "Zoni")?.trim()?.ifBlank { "Zoni" } ?: "Zoni"

    fun setWakePhraseSync(phrase: String) {
        val clean = phrase.trim().ifBlank { "Zoni" }
        syncPrefs.edit().putString(SYNC_WAKE_PHRASE, clean).apply()
    }

    fun getGeminiApiKey(): String = secureKeyManager.getApiKey().orEmpty()

    fun saveGeminiApiKey(apiKey: String): Boolean = secureKeyManager.saveApiKey(apiKey)

    fun deleteGeminiApiKey(): Boolean = secureKeyManager.deleteApiKey()

    fun hasGeminiApiKey(): Boolean = secureKeyManager.hasApiKey()

    fun getMaskedGeminiApiKeyPreview(): String? = secureKeyManager.getMaskedApiKeyPreview()

    fun isKeystoreBacked(): Boolean = secureKeyManager.isUsingAndroidKeystore()

    companion object {
        private const val SYNC_WAKE_WORD_ENABLED = "zoni_sync_wake_word_enabled"
        private const val SYNC_BG_LISTENING_ENABLED = "zoni_sync_bg_listening_enabled"
        private const val SYNC_WAKE_PHRASE = "zoni_sync_wake_phrase"
    }
}
