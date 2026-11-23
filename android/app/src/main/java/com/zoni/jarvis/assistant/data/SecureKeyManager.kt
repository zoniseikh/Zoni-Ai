package com.zoni.jarvis.assistant.data

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * Android Keystore-backed BYOK secret manager for Zoni AI.
 * Stores ONLY the user's own Gemini API Key and Live session resumption handle
 * using AES256-GCM MasterKey + EncryptedSharedPreferences.
 *
 * No developer API key and no mandatory backend server URL exist in this app.
 */
class SecureKeyManager(context: Context) {

    private var keystoreBacked: Boolean = false

    private val securePrefs: SharedPreferences = try {
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        val prefs = EncryptedSharedPreferences.create(
            context,
            PREFS_FILE_NAME,
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
        keystoreBacked = true
        prefs
    } catch (_: Exception) {
        keystoreBacked = false
        context.getSharedPreferences(FALLBACK_PREFS_FILE, Context.MODE_PRIVATE)
    }

    init {
        // Purge any legacy backend URL and unify legacy Gemini API key slot
        try {
            val editor = securePrefs.edit()
            var dirty = false
            if (securePrefs.contains(LEGACY_KEY_BACKEND_URL)) {
                editor.remove(LEGACY_KEY_BACKEND_URL)
                dirty = true
            }
            val current = securePrefs.getString(KEY_GEMINI_API_KEY, null)?.trim().orEmpty()
            val legacyKey = securePrefs.getString(LEGACY_KEY_GEMINI_API, null)?.trim().orEmpty()
            if (current.isBlank() && legacyKey.isNotBlank()) {
                editor.putString(KEY_GEMINI_API_KEY, legacyKey)
                editor.remove(LEGACY_KEY_GEMINI_API)
                dirty = true
            } else if (legacyKey.isNotBlank()) {
                editor.remove(LEGACY_KEY_GEMINI_API)
                dirty = true
            }
            if (dirty) editor.apply()
        } catch (_: Exception) {
            // Ignore cleanup errors on locked storage
        }
    }

    fun isUsingAndroidKeystore(): Boolean = keystoreBacked

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

    fun saveApiKey(key: String): Boolean {
        val validation = validateApiKeyFormat(key)
        if (!validation.valid) return false
        securePrefs.edit()
            .putString(KEY_GEMINI_API_KEY, validation.normalizedKey)
            .remove(LEGACY_KEY_GEMINI_API)
            .remove(KEY_RESUMPTION_HANDLE)
            .apply()
        return true
    }

    fun getApiKey(): String? {
        val saved = securePrefs.getString(KEY_GEMINI_API_KEY, null)?.trim()
            ?: securePrefs.getString(LEGACY_KEY_GEMINI_API, null)?.trim()
        return if (saved.isNullOrBlank()) null else saved
    }

    fun deleteApiKey(): Boolean {
        securePrefs.edit()
            .remove(KEY_GEMINI_API_KEY)
            .remove(LEGACY_KEY_GEMINI_API)
            .remove(KEY_RESUMPTION_HANDLE)
            .apply()
        return true
    }

    fun hasApiKey(): Boolean {
        return !getApiKey().isNullOrBlank()
    }

    fun getMaskedApiKeyPreview(): String? {
        val key = getApiKey() ?: return null
        return maskApiKey(key)
    }

    fun setOnboardingCompleted(completed: Boolean) {
        securePrefs.edit().putBoolean(KEY_ONBOARDING_COMPLETED, completed).apply()
    }

    fun isOnboardingCompleted(): Boolean {
        return securePrefs.getBoolean(KEY_ONBOARDING_COMPLETED, false)
    }

    data class ApiKeyValidationResult(
        val valid: Boolean,
        val normalizedKey: String = "",
        val error: String? = null
    )

    companion object {
        private const val PREFS_FILE_NAME = "secure_zoni_prefs"
        private const val FALLBACK_PREFS_FILE = "fallback_zoni_prefs"
        private const val LEGACY_KEY_BACKEND_URL = "zoni_backend_url"
        private const val LEGACY_KEY_GEMINI_API = "zoni_encrypted_gemini_api_key"
        private const val KEY_RESUMPTION_HANDLE = "zoni_live_resumption_handle"
        private const val KEY_GEMINI_API_KEY = "gemini_api_key_encrypted"
        private const val KEY_ONBOARDING_COMPLETED = "zoni_onboarding_completed"

        private val GEMINI_KEY_PATTERN = Regex("^[A-Za-z0-9_\\-]{20,256}$")
        private val INLINE_GOOGLE_KEY_REGEX = Regex("AIza[0-9A-Za-z_\\-]{16,}")
        private val QUERY_KEY_REGEX = Regex("([?&]key=)[^&\\s\"']+", RegexOption.IGNORE_CASE)

        fun validateApiKeyFormat(rawKey: String?): ApiKeyValidationResult {
            val trimmed = rawKey?.trim().orEmpty()
            if (trimmed.isBlank()) {
                return ApiKeyValidationResult(
                    valid = false,
                    error = "Please enter your Gemini API Key."
                )
            }
            if (trimmed.any { it.isWhitespace() }) {
                return ApiKeyValidationResult(
                    valid = false,
                    error = "Gemini API Key cannot contain spaces or line breaks."
                )
            }
            if (trimmed.startsWith("http://", ignoreCase = true) ||
                trimmed.startsWith("https://", ignoreCase = true)
            ) {
                return ApiKeyValidationResult(
                    valid = false,
                    error = "Enter your Gemini API Key (starts with AIza...), not a server URL."
                )
            }
            if (trimmed.length < 20) {
                return ApiKeyValidationResult(
                    valid = false,
                    error = "Gemini API Key looks too short. Paste the complete key from Google AI Studio."
                )
            }
            if (!GEMINI_KEY_PATTERN.matches(trimmed)) {
                return ApiKeyValidationResult(
                    valid = false,
                    error = "Gemini API Key contains unexpected characters."
                )
            }
            return ApiKeyValidationResult(valid = true, normalizedKey = trimmed)
        }

        fun maskApiKey(rawKey: String?): String {
            val clean = rawKey?.trim().orEmpty()
            if (clean.isEmpty()) return ""
            if (clean.length <= 8) {
                return "${clean.take(2)}••••••"
            }
            return "${clean.take(4)}••••••••${clean.takeLast(4)}"
        }

        fun sanitizeSecret(message: String?, apiKey: String? = null): String {
            var safe = message.orEmpty()
            val secret = apiKey?.trim().orEmpty()
            if (secret.length >= 8) {
                safe = safe.replace(secret, "[REDACTED_API_KEY]")
            }
            safe = INLINE_GOOGLE_KEY_REGEX.replace(safe, "[REDACTED_API_KEY]")
            safe = QUERY_KEY_REGEX.replace(safe, "$1[REDACTED_API_KEY]")
            return safe
        }
    }
}
