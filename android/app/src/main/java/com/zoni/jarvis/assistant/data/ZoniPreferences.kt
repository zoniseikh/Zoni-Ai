package com.zoni.jarvis.assistant.data

import android.content.Context
import android.content.SharedPreferences
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.zoni.jarvis.assistant.BuildConfig
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
    val backendServerUrl: String = DEFAULT_BACKEND_URL
) {
    companion object {
        val DEFAULT_BACKEND_URL: String = BuildConfig.ZONI_BACKEND_URL
    }
}

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
        val BACKEND_URL = stringPreferencesKey("zoni_backend_url")
    }

    private val encryptedPrefs: SharedPreferences by lazy {
        try {
            val masterKey = MasterKey.Builder(context)
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .build()
            EncryptedSharedPreferences.create(
                context,
                "secure_zoni_prefs",
                masterKey,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
            )
        } catch (_: Exception) {
            context.getSharedPreferences("secure_zoni_prefs_fallback", Context.MODE_PRIVATE)
        }
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
            backendServerUrl = prefs[Keys.BACKEND_URL]?.takeIf { it.isNotBlank() }
                ?: ZoniUserSettings.DEFAULT_BACKEND_URL
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

    suspend fun setBackendServerUrl(url: String) {
        val clean = url.trim().trimEnd('/')
        if ((clean.startsWith("http://") || clean.startsWith("https://")) &&
            !clean.contains("appassets.androidplatform.net", ignoreCase = true)
        ) {
            context.zoniDataStore.edit { it[Keys.BACKEND_URL] = clean }
        }
    }

    fun getGeminiApiKey(): String =
        encryptedPrefs.getString(KEY_GEMINI_API, "")?.trim().orEmpty()

    fun saveGeminiApiKey(apiKey: String) {
        encryptedPrefs.edit().putString(KEY_GEMINI_API, apiKey.trim()).apply()
    }

    companion object {
        private const val KEY_GEMINI_API = "zoni_encrypted_gemini_api_key"
    }
}
