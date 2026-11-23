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
    data class Error(
        val message: String,
        val code: String? = null,
        val retryable: Boolean = true
    ) : LiveServerEvent()
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
    private var healthyResetJob: Job? = null
    private var reconnectAttempt = 0
    private var isClosedManually = false

    @Volatile
    private var isConnecting = false

    @Volatile
    private var isSessionReady = false

    @Volatile
    private var isRotatingSession = false

    @Volatile
    private var nonRetryableError: String? = null

    @Volatile
    private var resumptionHandle: String? = null

    fun isConnected(): Boolean = webSocket != null && isSessionReady

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
        if (forceReconnect) {
            nonRetryableError = null
            reconnectAttempt = 0
        }
        lastBackendUrl = backendBaseUrl
        lastMode = mode
        lastAffectionName = affectionName
        lastVoice = voice
        lastLanguage = language

        if (!forceReconnect && ((webSocket != null && isSessionReady) || isConnecting)) return

        reconnectJob?.cancel()
        healthyResetJob?.cancel()
        val previousSocket = webSocket
        webSocket = null
        isSessionReady = false
        isConnecting = true
        previousSocket?.close(1000, "Reconnecting")

        onEvent(
            LiveServerEvent.StatusChanged(
                if (reconnectAttempt > 0 || isRotatingSession) WsConnectionStatus.RECONNECTING else WsConnectionStatus.CONNECTING
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
                if (ws != webSocket) return
                handleIncomingJson(text)
            }

            override fun onClosing(ws: WebSocket, code: Int, reason: String) {
                if (ws != webSocket) return
                ws.close(code, reason)
            }

            override fun onFailure(ws: WebSocket, t: Throwable, response: Response?) {
                if (ws != webSocket) return
                isConnecting = false
                isSessionReady = false
                healthyResetJob?.cancel()
                webSocket = null
                onEvent(LiveServerEvent.StatusChanged(WsConnectionStatus.ERROR))
                scheduleReconnect(isGracefulRotation = isRotatingSession)
            }

            override fun onClosed(ws: WebSocket, code: Int, reason: String) {
                if (ws != webSocket) return
                isConnecting = false
                isSessionReady = false
                healthyResetJob?.cancel()
                webSocket = null

                val classification = classifyCloseCode(code, reason)
                if (classification.shouldClearHandle) {
                    resumptionHandle = null
                }
                if (!classification.retryable && classification.category == "auth_or_config") {
                    nonRetryableError = classification.summary
                }

                if (isClosedManually || classification.category == "normal") {
                    isRotatingSession = false
                    onEvent(LiveServerEvent.StatusChanged(WsConnectionStatus.DISCONNECTED))
                } else if (classification.retryable) {
                    scheduleReconnect(isGracefulRotation = isRotatingSession || classification.category == "service_restart")
                } else {
                    isRotatingSession = false
                    onEvent(LiveServerEvent.StatusChanged(WsConnectionStatus.ERROR))
                }
            }
        })
    }

    private fun scheduleReconnect(isGracefulRotation: Boolean = false) {
        if (isClosedManually || lastBackendUrl.isBlank() || nonRetryableError != null) {
            isRotatingSession = false
            onEvent(LiveServerEvent.StatusChanged(WsConnectionStatus.ERROR))
            return
        }
        if (!isGracefulRotation && reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
            isRotatingSession = false
            onEvent(LiveServerEvent.StatusChanged(WsConnectionStatus.ERROR))
            onEvent(
                LiveServerEvent.Error(
                    message = "Unable to reconnect to Gemini Live after $MAX_RECONNECT_ATTEMPTS attempts.",
                    code = "WS_MAX_RETRIES",
                    retryable = false
                )
            )
            return
        }
        onEvent(LiveServerEvent.StatusChanged(WsConnectionStatus.RECONNECTING))
        val delayMs = if (isGracefulRotation) {
            350L
        } else {
            val computed = computeReconnectDelayMs(reconnectAttempt, jitterFraction = 0.2)
            reconnectAttempt += 1
            computed
        }
        reconnectJob?.cancel()
        reconnectJob = scope.launch {
            delay(delayMs)
            if (!isClosedManually && nonRetryableError == null) {
                connect(
                    lastBackendUrl,
                    lastMode,
                    lastAffectionName,
                    lastVoice,
                    lastLanguage,
                    forceReconnect = isGracefulRotation
                )
            }
        }
    }

    private fun handleIncomingJson(raw: String) {
        try {
            val json = JSONObject(raw)
            when (json.optString("type")) {
                "pong" -> Unit
                "connected" -> {
                    isConnecting = false
                    isSessionReady = true
                    isRotatingSession = false
                    nonRetryableError = null
                    onEvent(LiveServerEvent.StatusChanged(WsConnectionStatus.CONNECTED))
                    onEvent(LiveServerEvent.Connected(json.optBoolean("resumed", false)))
                    healthyResetJob?.cancel()
                    healthyResetJob = scope.launch {
                        delay(HEALTHY_SESSION_RESET_MS)
                        if (isSessionReady) {
                            reconnectAttempt = 0
                        }
                    }
                    flushQueue()
                }
                "session_resumption" -> {
                    val resumable = json.optBoolean("resumable", true)
                    val handle = json.optString("newHandle", "")
                    if (!resumable) {
                        resumptionHandle = null
                    } else if (handle.isNotBlank()) {
                        resumptionHandle = handle
                    }
                }
                "go_away" -> {
                    if (!isRotatingSession) {
                        isRotatingSession = true
                        scheduleReconnect(isGracefulRotation = true)
                    }
                }
                "session_closed" -> {
                    isSessionReady = false
                    isConnecting = false
                    healthyResetJob?.cancel()
                    if (!isRotatingSession) {
                        isRotatingSession = true
                        scheduleReconnect(isGracefulRotation = true)
                    }
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
                    isConnecting = false
                    isSessionReady = false
                    healthyResetJob?.cancel()
                    val errMsg = json.optString("message", "Live connection error")
                    val errCode = json.optString("code", "").ifBlank { null }
                    val retryable = json.optBoolean("retryable", errCode != "GEMINI_KEY_MISSING" && errCode != "GEMINI_KEY_INVALID")
                    if (!retryable) {
                        nonRetryableError = errMsg
                    }
                    onEvent(LiveServerEvent.StatusChanged(WsConnectionStatus.ERROR))
                    onEvent(LiveServerEvent.Error(message = errMsg, code = errCode, retryable = retryable))
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
        if (lastBackendUrl.isNotBlank() && ws == null && !isConnecting) {
            connect(lastBackendUrl, lastMode, lastAffectionName, lastVoice, lastLanguage)
        }
    }

    private fun flushQueue() {
        val ws = webSocket ?: return
        val seenIds = HashSet<String>()
        while (outgoingQueue.isNotEmpty()) {
            val next = outgoingQueue.poll() ?: break
            val msgId = try {
                JSONObject(next).optString("clientMsgId", "")
            } catch (_: Exception) {
                ""
            }
            if (msgId.isNotEmpty() && !seenIds.add(msgId)) continue
            ws.send(next)
        }
    }

    fun disconnect() {
        isClosedManually = true
        isConnecting = false
        isRotatingSession = false
        reconnectJob?.cancel()
        healthyResetJob?.cancel()
        isSessionReady = false
        webSocket?.close(1000, "Client closed")
        webSocket = null
        onEvent(LiveServerEvent.StatusChanged(WsConnectionStatus.DISCONNECTED))
    }

    data class CloseClassification(
        val retryable: Boolean,
        val shouldClearHandle: Boolean,
        val category: String,
        val summary: String
    )

    companion object {
        private const val MAX_RECONNECT_ATTEMPTS = 5
        const val HEALTHY_SESSION_RESET_MS = 10_000L

        fun computeReconnectDelayMs(
            attempt: Int,
            baseMs: Long = 1500L,
            maxMs: Long = 15_000L,
            jitterFraction: Double = 0.0,
            randomUnit: Double = Math.random()
        ): Long {
            val raw = MobileAssistantEngine.getReconnectDelayMs(attempt, baseMs, maxMs)
            val safeJitter = jitterFraction.coerceIn(0.0, 0.5)
            if (safeJitter <= 0.0) return raw
            val offset = (randomUnit.coerceIn(0.0, 1.0) * 2.0 - 1.0) * safeJitter * raw.toDouble()
            return (raw.toDouble() + offset).toLong().coerceIn(250L, maxMs)
        }

        fun classifyCloseCode(code: Int, reason: String = ""): CloseClassification {
            val clean = reason.trim()
            return when (code) {
                4001, 4003, 1008 -> CloseClassification(
                    retryable = false,
                    shouldClearHandle = true,
                    category = "auth_or_config",
                    summary = clean.ifBlank { "Connection rejected by server (code $code)." }
                )
                1012, 1013, 1001 -> CloseClassification(
                    retryable = true,
                    shouldClearHandle = false,
                    category = "service_restart",
                    summary = clean.ifBlank { "Live session rotated by server (code $code)." }
                )
                1000 -> CloseClassification(
                    retryable = false,
                    shouldClearHandle = false,
                    category = "normal",
                    summary = clean.ifBlank { "Closed normally." }
                )
                else -> CloseClassification(
                    retryable = true,
                    shouldClearHandle = clean.contains("handle", ignoreCase = true) ||
                        clean.contains("expired", ignoreCase = true),
                    category = "transient_drop",
                    summary = clean.ifBlank { "Transient WebSocket disconnect (code $code)." }
                )
            }
        }

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
