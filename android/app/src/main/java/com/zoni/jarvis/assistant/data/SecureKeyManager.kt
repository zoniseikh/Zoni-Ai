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

        private val GEMINI_KEY_PATTERN = Regex("^[A-Za-z0-9._\\-~+=]{16,512}$")
        private val INVISIBLE_CLIPBOARD_CHARS = Regex("[\\u200B-\\u200F\\u202A-\\u202E\\u2060\\uFEFF]")
        private val ENV_KEY_PREFIX_REGEX =
            Regex("^(?:export\\s+)?(?:VITE_)?(?:GEMINI|GOOGLE|ZONI)?_?API_KEY\\s*=\\s*(.+)$", RegexOption.IGNORE_CASE)
        private val INLINE_GOOGLE_KEY_REGEX = Regex("AIza[0-9A-Za-z_\\-]{12,}")
        private val INLINE_AQ_KEY_REGEX = Regex("AQ\\.[0-9A-Za-z._\\-]{12,}")
        private val QUERY_KEY_REGEX = Regex("([?&]key=)[^&\\s\"']+", RegexOption.IGNORE_CASE)

        private fun normalizePastedKey(rawKey: String?): String {
            var clean = rawKey.orEmpty()
                .replace(INVISIBLE_CLIPBOARD_CHARS, "")
                .replace('\u00A0', ' ')
                .trim()

            val envMatch = ENV_KEY_PREFIX_REGEX.matchEntire(clean)
            if (envMatch != null && envMatch.groupValues.size > 1) {
                clean = envMatch.groupValues[1].trim()
            }

            if (clean.length >= 2 && (
                    (clean.startsWith("\"") && clean.endsWith("\"")) ||
                    (clean.startsWith("'") && clean.endsWith("'")) ||
                    (clean.startsWith("`") && clean.endsWith("`")) ||
                    (clean.startsWith("\u201C") && clean.endsWith("\u201D")) ||
                    (clean.startsWith("\u2018") && clean.endsWith("\u2019"))
                )
            ) {
                clean = clean.substring(1, clean.length - 1).trim()
            }
            return clean
        }

        fun validateApiKeyFormat(rawKey: String?): ApiKeyValidationResult {
            val trimmed = normalizePastedKey(rawKey)
            if (trimmed.isBlank()) {
                return ApiKeyValidationResult(
                    valid = false,
                    error = "Please enter your Gemini API Key."
                )
            }
            if (trimmed.startsWith("http://", ignoreCase = true) ||
                trimmed.startsWith("https://", ignoreCase = true) ||
                trimmed.startsWith("ws://", ignoreCase = true) ||
                trimmed.startsWith("wss://", ignoreCase = true) ||
                trimmed.contains("://")
            ) {
                return ApiKeyValidationResult(
                    valid = false,
                    error = "Enter your Gemini API Key (e.g., AIza... or AQ....), not a server URL."
                )
            }
            if (trimmed.any { it.isWhitespace() }) {
                return ApiKeyValidationResult(
                    valid = false,
                    error = "Gemini API Key cannot contain spaces or line breaks."
                )
            }
            if (trimmed.length < 16 || trimmed.length > 512) {
                return ApiKeyValidationResult(
                    valid = false,
                    error = "Gemini API Key length looks invalid. Paste the complete key from Google AI Studio or Google Cloud."
                )
            }
            if (!GEMINI_KEY_PATTERN.matches(trimmed)) {
                return ApiKeyValidationResult(
                    valid = false,
                    error = "Gemini API Key contains invalid characters."
                )
            }
            return ApiKeyValidationResult(valid = true, normalizedKey = trimmed)
        }

        fun maskApiKey(rawKey: String?): String {
            val clean = normalizePastedKey(rawKey)
            if (clean.isEmpty()) return ""
            if (clean.length <= 8) {
                return "${clean.take(2)}••••••"
            }
            return "${clean.take(4)}••••••••${clean.takeLast(4)}"
        }

        fun sanitizeSecret(message: String?, apiKey: String? = null): String {
            var safe = message.orEmpty()
            val secret = normalizePastedKey(apiKey)
            if (secret.length >= 8) {
                safe = safe.replace(secret, "[REDACTED_API_KEY]")
            }
            safe = INLINE_GOOGLE_KEY_REGEX.replace(safe, "[REDACTED_API_KEY]")
            safe = INLINE_AQ_KEY_REGEX.replace(safe, "[REDACTED_API_KEY]")
            safe = QUERY_KEY_REGEX.replace(safe, "$1[REDACTED_API_KEY]")
            return safe
        }
    }
}
