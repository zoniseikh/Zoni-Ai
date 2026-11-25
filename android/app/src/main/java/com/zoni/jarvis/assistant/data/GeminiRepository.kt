package com.zoni.jarvis.assistant.data

import android.util.Base64
import com.zoni.jarvis.assistant.domain.CompanionMode
import com.zoni.jarvis.assistant.domain.SupportedLanguage
import com.zoni.jarvis.assistant.domain.VoiceProfile
import com.zoni.jarvis.assistant.network.LiveServerEvent
import com.zoni.jarvis.assistant.network.ZoniLiveSessionClient
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL

sealed class GeminiResult {
    data class Success(val text: String) : GeminiResult()
    data class NetworkError(val message: String) : GeminiResult()
    data class GenericError(val message: String) : GeminiResult()
}

interface LiveSessionListener {
    fun onConnectionStateChanged(connected: Boolean, resumed: Boolean, statusMessage: String)
    fun onUserTranscript(text: String, turnId: Int)
    fun onAssistantTextChunk(text: String, turnId: Int)
    fun onAssistantAudioBase64(base64Pcm24kHz: String, turnId: Int)
    fun onFlashlightCommand(enable: Boolean)
    fun onTurnComplete(turnId: Int)
    fun onInterrupted(turnId: Int)
    fun onError(sanitizedMessage: String)
}

/**
 * Pure Gemini BYOK Repository for Android.
 * Verifies the user's own Gemini API Key directly against Google's official REST API
 * (`https://generativelanguage.googleapis.com/v1beta/models`) using the `x-goog-api-key`
 * header and delegates Live audio/text streaming directly to `ZoniLiveSessionClient`.
 */
class GeminiRepository(
    private val keyManager: SecureKeyManager
) {
    private var listener: LiveSessionListener? = null

    private val liveClient = ZoniLiveSessionClient { event ->
        when (event) {
            is LiveServerEvent.Connected -> {
                listener?.onConnectionStateChanged(
                    true,
                    event.resumed,
                    if (event.resumed) "Gemini Live resumed." else "Gemini Live active."
                )
            }
            is LiveServerEvent.UserTranscript -> {
                listener?.onUserTranscript(event.text, event.turnId)
            }
            is LiveServerEvent.OutputTranscript -> {
                listener?.onAssistantTextChunk(event.text, event.turnId)
            }
            is LiveServerEvent.AudioChunk -> {
                listener?.onAssistantAudioBase64(event.base64Pcm24k, event.turnId)
            }
            is LiveServerEvent.Flashlight -> {
                listener?.onFlashlightCommand(event.enable)
            }
            is LiveServerEvent.TurnComplete -> {
                listener?.onTurnComplete(event.turnId)
            }
            is LiveServerEvent.Interrupted -> {
                listener?.onInterrupted(event.turnId)
            }
            is LiveServerEvent.Error -> {
                listener?.onError(SecureKeyManager.sanitizeSecret(event.message, keyManager.getApiKey()))
            }
            is LiveServerEvent.StatusChanged -> {
                if (event.status.name != "CONNECTED") {
                    listener?.onConnectionStateChanged(false, false, event.status.name.lowercase())
                }
            }
        }
    }

    fun setListener(liveListener: LiveSessionListener) {
        this.listener = liveListener
    }

    fun isLiveConnected(): Boolean = liveClient.isConnected()

    /**
     * Verifies the user's Gemini API Key directly against Google's official models endpoint.
     */
    suspend fun verifyGeminiApiKey(rawApiKey: String): GeminiResult = withContext(Dispatchers.IO) {
        val validation = SecureKeyManager.validateApiKeyFormat(rawApiKey)
        if (!validation.valid) {
            return@withContext GeminiResult.GenericError(validation.error ?: "Invalid Gemini API Key format.")
        }
        val key = validation.normalizedKey
        try {
            val url = URL("https://generativelanguage.googleapis.com/v1beta/models?pageSize=20")
            val conn = (url.openConnection() as HttpURLConnection).apply {
                connectTimeout = 8000
                readTimeout = 8000
                requestMethod = "GET"
                setRequestProperty("x-goog-api-key", key)
                setRequestProperty("Accept", "application/json")
            }
            val code = conn.responseCode
            conn.disconnect()
            when {
                code in 200..299 -> GeminiResult.Success("Gemini API Key verified with Google Gemini.")
                code == 400 || code == 401 || code == 403 ->
                    GeminiResult.GenericError("Invalid or unauthorized Gemini API Key (HTTP $code).")
                code == 429 ->
                    GeminiResult.GenericError("Gemini API Key quota exceeded or rate limited (HTTP 429).")
                else ->
                    GeminiResult.GenericError("Google Gemini responded with HTTP $code.")
            }
        } catch (e: Exception) {
            val safeMsg = SecureKeyManager.sanitizeSecret(e.localizedMessage ?: "Network error", key)
            GeminiResult.NetworkError("Could not reach Google Gemini API: $safeMsg")
        }
    }

    fun connectSharedSession(
        mode: String = "romantic",
        nickname: String = "Boss",
        voice: String = "Kore",
        lang: String = "bn-BD",
        forceReconnect: Boolean = false
    ) {
        val apiKey = keyManager.getApiKey().orEmpty()
        if (apiKey.isBlank()) {
            listener?.onError("Gemini API Key is not configured. Add your key in Setup or Settings.")
            return
        }
        liveClient.connect(
            apiKey = apiKey,
            mode = CompanionMode.fromId(mode),
            affectionName = nickname,
            voice = VoiceProfile.fromId(voice),
            language = SupportedLanguage.fromCode(lang),
            forceReconnect = forceReconnect
        )
    }

    fun connectSharedSession(forceNew: Boolean) {
        connectSharedSession(forceReconnect = forceNew)
    }

    fun disconnect() = disconnectSession()

    fun disconnectSession() {
        liveClient.disconnect()
    }

    fun sendChatBoxMessage(text: String, clientMsgId: String = "msg-${System.currentTimeMillis()}") {
        liveClient.sendClientText(text, clientMsgId)
    }

    fun sendRealtimeAudioChunk(pcm16Bytes: ByteArray, length: Int) {
        if (!liveClient.isConnected() || length <= 0) return
        val slice = if (length == pcm16Bytes.size) pcm16Bytes else pcm16Bytes.copyOf(length)
        val base64Audio = Base64.encodeToString(slice, Base64.NO_WRAP)
        liveClient.sendAudioChunk(base64Audio)
    }

    fun sendInterrupt() {
        liveClient.sendInterrupt()
    }

    companion object {
        private const val VISION_MODEL = "gemini-2.5-flash"

        /**
         * On-demand visual UI target localization using the user's own BYOK Gemini API key.
         * Sends a single user-requested screenshot frame + screen dimensions and requests strict JSON
         * coordinates + confidence + ambiguity detection. Never leaks the API key in errors.
         */
        fun locateVisualTargetOnScreenBlocking(
            apiKey: String,
            base64Jpeg: String,
            userQuery: String,
            screenWidth: Int,
            screenHeight: Int,
            visibleLabelsHint: List<String> = emptyList()
        ): GeminiResult {
            val validation = SecureKeyManager.validateApiKeyFormat(apiKey)
            if (!validation.valid) {
                return GeminiResult.GenericError(validation.error ?: "Gemini API Key is missing or invalid.")
            }
            if (base64Jpeg.isBlank()) {
                return GeminiResult.GenericError("Screen frame is empty.")
            }
            val key = validation.normalizedKey
            val safeW = screenWidth.coerceAtLeast(100)
            val safeH = screenHeight.coerceAtLeast(100)
            val hintsText = visibleLabelsHint.take(25).joinToString(" | ")

            val prompt = buildString {
                append("You are an Android UI precision click locator. ")
                append("The screenshot is ${safeW}x${safeH} pixels. ")
                append("Locate the EXACT UI element the user asked to tap: \"")
                append(userQuery.replace("\"", "'"))
                append("\".\n")
                if (hintsText.isNotBlank()) {
                    append("Visible accessibility text hints on screen: ")
                    append(hintsText)
                    append("\n")
                }
                append("Rules:\n")
                append("1. Return ONLY a single JSON object with keys: found (boolean), confidence (0.0-1.0), ambiguous (boolean), label (string), x (int pixel 0..$safeW), y (int pixel 0..$safeH), xNorm (int 0..1000), yNorm (int 0..1000), reason (string), alternatives (array of {label, confidence, x, y}).\n")
                append("2. If the requested element is NOT visible, set found=false and confidence=0.\n")
                append("3. If multiple similar elements match and it is unclear which one the user wants, set ambiguous=true and list them in alternatives.\n")
                append("4. NEVER target password, PIN, OTP, CVV, or banking payment confirmation buttons — if requested, set found=false and reason=\"sensitive_blocked\".\n")
                append("5. Point x,y to the exact visual center of the clickable button/icon/card.")
            }

            val requestBody = JSONObject().apply {
                put(
                    "contents",
                    JSONArray().put(
                        JSONObject().apply {
                            put("role", "user")
                            put(
                                "parts",
                                JSONArray()
                                    .put(JSONObject().put("text", prompt))
                                    .put(
                                        JSONObject().put(
                                            "inline_data",
                                            JSONObject()
                                                .put("mime_type", "image/jpeg")
                                                .put("data", base64Jpeg)
                                        )
                                    )
                            )
                        }
                    )
                )
                put(
                    "generationConfig",
                    JSONObject()
                        .put("temperature", 0.1)
                        .put("maxOutputTokens", 384)
                        .put("responseMimeType", "application/json")
                )
            }

            var conn: HttpURLConnection? = null
            return try {
                val url = URL("https://generativelanguage.googleapis.com/v1beta/models/$VISION_MODEL:generateContent")
                conn = (url.openConnection() as HttpURLConnection).apply {
                    connectTimeout = 9000
                    readTimeout = 14000
                    requestMethod = "POST"
                    doOutput = true
                    setRequestProperty("x-goog-api-key", key)
                    setRequestProperty("Content-Type", "application/json; charset=UTF-8")
                    setRequestProperty("Accept", "application/json")
                }
                OutputStreamWriter(conn.outputStream, Charsets.UTF_8).use { writer ->
                    writer.write(requestBody.toString())
                    writer.flush()
                }
                val code = conn.responseCode
                val stream = if (code in 200..299) conn.inputStream else conn.errorStream
                val rawBody = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }.orEmpty()

                if (code !in 200..299) {
                    val safeErr = SecureKeyManager.sanitizeSecret(rawBody.take(240), key)
                    return GeminiResult.GenericError("Gemini Vision request failed (HTTP $code): $safeErr")
                }

                val root = JSONObject(rawBody)
                val candidates = root.optJSONArray("candidates")
                val parts = candidates?.optJSONObject(0)?.optJSONObject("content")?.optJSONArray("parts")
                val text = buildString {
                    if (parts != null) {
                        for (i in 0 until parts.length()) {
                            val t = parts.optJSONObject(i)?.optString("text", "").orEmpty()
                            if (t.isNotBlank()) append(t)
                        }
                    }
                }.trim()
                if (text.isEmpty()) {
                    GeminiResult.GenericError("Gemini Vision returned an empty response.")
                } else {
                    GeminiResult.Success(text)
                }
            } catch (e: Exception) {
                val safeMsg = SecureKeyManager.sanitizeSecret(e.localizedMessage ?: "Network error", key)
                GeminiResult.NetworkError("Gemini Vision network error: $safeMsg")
            } finally {
                try { conn?.disconnect() } catch (_: Exception) {}
            }
        }
    }
}
