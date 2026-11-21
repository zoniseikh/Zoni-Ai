package com.zoni.jarvis.assistant.data

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * Android Keystore-backed configuration manager for Zoni AI.
 * Stores the Zoni Live Backend Server URL and session resumption handle.
 * Gemini API credentials remain strictly on the backend server and are never stored in client code.
 */
class SecureKeyManager(context: Context) {

    private val masterKey: MasterKey = MasterKey.Builder(context)
        .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
        .build()

    private val securePrefs: SharedPreferences = try {
        EncryptedSharedPreferences.create(
            context,
            PREFS_FILE_NAME,
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
    } catch (e: Exception) {
        context.getSharedPreferences(FALLBACK_PREFS_FILE, Context.MODE_PRIVATE)
    }

    fun saveBackendUrl(url: String) {
        val trimmed = url.trim().trimEnd('/')
        if (trimmed.isBlank()) {
            securePrefs.edit().remove(KEY_BACKEND_URL).apply()
            return
        }
        if (ZoniUserSettings.isValidProductionBackendUrl(trimmed)) {
            securePrefs.edit().putString(KEY_BACKEND_URL, trimmed).apply()
        }
    }

    fun getBackendUrl(): String {
        val saved = securePrefs.getString(KEY_BACKEND_URL, null)?.trim().orEmpty()
        if (ZoniUserSettings.isValidProductionBackendUrl(saved)) {
            return saved
        }
        // Auto-migrate stale/invalid persisted URL (e.g., dead ais-pre, localhost, or appassets)
        if (saved.isNotBlank()) {
            securePrefs.edit().remove(KEY_BACKEND_URL).apply()
        }
        return DEFAULT_BACKEND_URL
    }

    fun saveResumptionHandle(handle: String?) {
        if (handle.isNullOrBlank()) {
            securePrefs.edit().remove(KEY_RESUMPTION_HANDLE).apply()
        } else {
            securePrefs.edit().putString(KEY_RESUMPTION_HANDLE, handle.trim()).apply()
        }
    }

    fun getResumptionHandle(): String? {
        val handle = securePrefs.getString(KEY_RESUMPTION_HANDLE, null)
        return if (handle.isNullOrBlank()) null else handle
    }

    fun saveApiKey(key: String) {
        val trimmed = key.trim()
        securePrefs.edit().putString(KEY_GEMINI_API_KEY, trimmed).apply()
    }

    fun getApiKey(): String? {
        val saved = securePrefs.getString(KEY_GEMINI_API_KEY, null)
        return if (saved.isNullOrBlank()) null else saved
    }

    fun hasApiKey(): Boolean {
        return !getApiKey().isNullOrBlank()
    }

    fun setOnboardingCompleted(completed: Boolean) {
        securePrefs.edit().putBoolean(KEY_ONBOARDING_COMPLETED, completed).apply()
    }

    fun isOnboardingCompleted(): Boolean {
        return securePrefs.getBoolean(KEY_ONBOARDING_COMPLETED, false)
    }

    companion object {
        private const val PREFS_FILE_NAME = "secure_zoni_prefs"
        private const val FALLBACK_PREFS_FILE = "fallback_zoni_prefs"
        private const val KEY_BACKEND_URL = "zoni_backend_url"
        private const val KEY_RESUMPTION_HANDLE = "zoni_live_resumption_handle"
        private const val KEY_GEMINI_API_KEY = "gemini_api_key_encrypted"
        private const val KEY_ONBOARDING_COMPLETED = "zoni_onboarding_completed"
        val DEFAULT_BACKEND_URL: String = ZoniUserSettings.DEFAULT_BACKEND_URL
    }
}
