package com.zoni.jarvis.assistant.network

import com.zoni.jarvis.assistant.domain.CompanionMode
import com.zoni.jarvis.assistant.domain.MobileAssistantEngine
import com.zoni.jarvis.assistant.domain.SupportedLanguage
import com.zoni.jarvis.assistant.domain.VoiceProfile
import com.zoni.jarvis.assistant.domain.WsConnectionStatus
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.net.URLEncoder
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.TimeUnit

sealed class LiveServerEvent {
    data class Connected(val resumed: Boolean) : LiveServerEvent()
    data class AudioChunk(val base64Pcm24k: String, val turnId: Int) : LiveServerEvent()
    data class OutputTranscript(val text: String, val turnId: Int) : LiveServerEvent()
    data class UserTranscript(val text: String, val turnId: Int) : LiveServerEvent()
    data class Flashlight(val enable: Boolean) : LiveServerEvent()
    data class Interrupted(val turnId: Int) : LiveServerEvent()
    data class TurnComplete(val turnId: Int) : LiveServerEvent()
    data class Error(val message: String) : LiveServerEvent()
    data class StatusChanged(val status: WsConnectionStatus) : LiveServerEvent()
}

/**
 * Shared OkHttp WebSocket client connecting Android directly to Zoni AI's /live Gemini Live backend.
 * Matches server.ts WebSocket protocol 100% (resumption handles, queueing, backoff reconnect, voice + chat box).
 */
class ZoniLiveSessionClient(
    private val onEvent: (LiveServerEvent) -> Unit
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private val okHttpClient = OkHttpClient.Builder()
        .pingInterval(25, TimeUnit.SECONDS)
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build()

    private var webSocket: WebSocket? = null
    private var reconnectJob: Job? = null
    private var reconnectAttempt = 0
    private var isClosedManually = false

    @Volatile
    private var isSessionReady = false

    @Volatile
    private var resumptionHandle: String? = null

    private var lastBackendUrl: String = ""
    private var lastMode: CompanionMode = CompanionMode.ROMANTIC
    private var lastAffectionName: String = "Boss"
    private var lastVoice: VoiceProfile = VoiceProfile.KORE
    private var lastLanguage: SupportedLanguage = SupportedLanguage.BENGALI

    private val outgoingQueue = ConcurrentLinkedQueue<String>()

    fun connect(
        backendBaseUrl: String,
        mode: CompanionMode,
        affectionName: String,
        voice: VoiceProfile,
        language: SupportedLanguage,
        forceReconnect: Boolean = false
    ) {
        isClosedManually = false
        lastBackendUrl = backendBaseUrl
        lastMode = mode
        lastAffectionName = affectionName
        lastVoice = voice
        lastLanguage = language

        if (!forceReconnect && webSocket != null && isSessionReady) return

        reconnectJob?.cancel()
        webSocket?.close(1000, "Reconnecting")
        webSocket = null
        isSessionReady = false

        onEvent(
            LiveServerEvent.StatusChanged(
                if (reconnectAttempt > 0) WsConnectionStatus.RECONNECTING else WsConnectionStatus.CONNECTING
            )
        )

        val wsUrl = buildLiveWsUrl(
            backendBaseUrl = backendBaseUrl,
            mode = mode.id,
            nickname = affectionName,
            voice = voice.id,
            lang = language.code,
            handle = resumptionHandle
        )

        val request = Request.Builder().url(wsUrl).build()
        webSocket = okHttpClient.newWebSocket(request, object : WebSocketListener() {
            override fun onMessage(ws: WebSocket, text: String) {
                handleIncomingJson(text)
            }

            override fun onFailure(ws: WebSocket, t: Throwable, response: Response?) {
                if (ws != webSocket) return
                isSessionReady = false
                webSocket = null
                onEvent(LiveServerEvent.StatusChanged(WsConnectionStatus.ERROR))
                scheduleReconnect()
            }

            override fun onClosed(ws: WebSocket, code: Int, reason: String) {
                if (ws != webSocket) return
                isSessionReady = false
                webSocket = null
                if (!isClosedManually) {
                    scheduleReconnect()
                } else {
                    onEvent(LiveServerEvent.StatusChanged(WsConnectionStatus.DISCONNECTED))
                }
            }
        })
    }

    private fun scheduleReconnect() {
        if (isClosedManually || lastBackendUrl.isBlank()) return
        onEvent(LiveServerEvent.StatusChanged(WsConnectionStatus.RECONNECTING))
        val delayMs = MobileAssistantEngine.getReconnectDelayMs(reconnectAttempt)
        reconnectAttempt += 1
        reconnectJob?.cancel()
        reconnectJob = scope.launch {
            delay(delayMs)
            if (!isClosedManually) {
                connect(lastBackendUrl, lastMode, lastAffectionName, lastVoice, lastLanguage, forceReconnect = true)
            }
        }
    }

    private fun handleIncomingJson(raw: String) {
        try {
            val json = JSONObject(raw)
            when (json.optString("type")) {
                "connected" -> {
                    isSessionReady = true
                    reconnectAttempt = 0
                    onEvent(LiveServerEvent.StatusChanged(WsConnectionStatus.CONNECTED))
                    onEvent(LiveServerEvent.Connected(json.optBoolean("resumed", false)))
                    flushQueue()
                }
                "session_resumption" -> {
                    val handle = json.optString("newHandle", "")
                    if (handle.isNotBlank()) resumptionHandle = handle
                }
                "flashlight" -> {
                    onEvent(LiveServerEvent.Flashlight(json.optBoolean("enable", false)))
                }
                "audio" -> {
                    val b64 = json.optString("audio", "")
                    if (b64.isNotEmpty()) {
                        onEvent(LiveServerEvent.AudioChunk(b64, json.optInt("turnId", 1)))
                    }
                }
                "output_transcript", "text" -> {
                    val text = json.optString("text", "")
                    if (text.isNotEmpty()) {
                        onEvent(LiveServerEvent.OutputTranscript(text, json.optInt("turnId", 1)))
                    }
                }
                "user_transcript" -> {
                    val text = json.optString("text", "")
                    if (text.isNotEmpty()) {
                        onEvent(LiveServerEvent.UserTranscript(text, json.optInt("turnId", 1)))
                    }
                }
                "interrupted" -> {
                    onEvent(LiveServerEvent.Interrupted(json.optInt("turnId", 1)))
                }
                "turnComplete" -> {
                    onEvent(LiveServerEvent.TurnComplete(json.optInt("turnId", 1)))
                }
                "error", "live_init_failed" -> {
                    onEvent(LiveServerEvent.Error(json.optString("message", "Live connection error")))
                }
            }
        } catch (_: Exception) {
            // Ignore malformed JSON frames
        }
    }

    fun sendAudioChunk(base64Pcm16k: String) {
        if (!isSessionReady) return
        val payload = JSONObject().put("audio", base64Pcm16k).toString()
        webSocket?.send(payload)
    }

    fun sendClientText(text: String, clientMsgId: String = "msg-${System.currentTimeMillis()}") {
        val trimmed = text.trim().take(4000)
        if (trimmed.isEmpty()) return
        val payload = JSONObject()
            .put("type", "client_text")
            .put("text", trimmed)
            .put("clientMsgId", clientMsgId)
            .toString()
        sendOrQueue(payload)
    }

    fun sendConfigUpdate(
        affectionName: String? = null,
        mode: CompanionMode? = null,
        lang: SupportedLanguage? = null
    ) {
        val json = JSONObject().put("type", "update_config")
        affectionName?.let {
            json.put("nickname", it)
            json.put("selectedAffectionName", it)
        }
        mode?.let { json.put("mode", it.id) }
        lang?.let { json.put("lang", it.code) }
        sendOrQueue(json.toString())
    }

    fun sendInterrupt() {
        val payload = JSONObject().put("type", "interrupt").toString()
        sendOrQueue(payload)
    }

    private fun sendOrQueue(serialized: String) {
        val ws = webSocket
        if (ws != null && isSessionReady && ws.send(serialized)) {
            return
        }
        if (outgoingQueue.size < 30) {
            outgoingQueue.offer(serialized)
        }
        if (lastBackendUrl.isNotBlank() && ws == null) {
            connect(lastBackendUrl, lastMode, lastAffectionName, lastVoice, lastLanguage)
        }
    }

    private fun flushQueue() {
        val ws = webSocket ?: return
        while (outgoingQueue.isNotEmpty()) {
            val next = outgoingQueue.poll() ?: break
            ws.send(next)
        }
    }

    fun disconnect() {
        isClosedManually = true
        reconnectJob?.cancel()
        isSessionReady = false
        webSocket?.close(1000, "Client closed")
        webSocket = null
        onEvent(LiveServerEvent.StatusChanged(WsConnectionStatus.DISCONNECTED))
    }

    companion object {
        fun buildLiveWsUrl(
            backendBaseUrl: String,
            mode: String,
            nickname: String,
            voice: String,
            lang: String,
            handle: String?
        ): String {
            val cleanBase = backendBaseUrl.trim().trimEnd('/')
            val wsBase = when {
                cleanBase.startsWith("https://") -> "wss://${cleanBase.removePrefix("https://")}"
                cleanBase.startsWith("http://") -> "ws://${cleanBase.removePrefix("http://")}"
                else -> "wss://$cleanBase"
            }
            val encName = URLEncoder.encode(nickname.ifBlank { "Boss" }, "UTF-8")
            val encMode = URLEncoder.encode(mode, "UTF-8")
            val encVoice = URLEncoder.encode(voice, "UTF-8")
            val encLang = URLEncoder.encode(lang, "UTF-8")
            val handleParam = if (!handle.isNullOrBlank()) {
                "&handle=${URLEncoder.encode(handle.trim(), "UTF-8")}"
            } else {
                ""
            }
            return "$wsBase/live?mode=$encMode&nickname=$encName&selectedAffectionName=$encName&voice=$encVoice&lang=$encLang$handleParam"
        }
    }
}
