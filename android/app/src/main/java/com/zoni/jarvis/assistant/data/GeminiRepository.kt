package com.zoni.jarvis.assistant.data

import android.util.Base64
import com.zoni.jarvis.assistant.domain.CompanionMode
import com.zoni.jarvis.assistant.domain.SupportedLanguage
import com.zoni.jarvis.assistant.domain.VoiceProfile
import com.zoni.jarvis.assistant.network.LiveServerEvent
import com.zoni.jarvis.assistant.network.ZoniLiveSessionClient
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
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
}
