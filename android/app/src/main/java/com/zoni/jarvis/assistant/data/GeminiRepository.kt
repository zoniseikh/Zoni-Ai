package com.zoni.jarvis.assistant.data

import android.util.Base64
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.Socket
import java.net.URI
import java.net.URL
import java.net.URLEncoder
import java.security.SecureRandom
import javax.net.ssl.SSLSocketFactory
import kotlin.math.min
import kotlin.math.pow

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
 * Shared Gemini Live WebSocket Session Client for Android.
 * Connects to the backend `/live` WebSocket endpoint so both Live Voice audio
 * and Chat Box text messages share a single active Gemini Live session and context.
 * No Gemini API key is ever stored or used on the Android client.
 */
class GeminiRepository(
    private val keyManager: SecureKeyManager,
    private val scope: CoroutineScope = CoroutineScope(Dispatchers.IO)
) {
    private var socket: Socket? = null
    private var outputStream: OutputStream? = null
    private var readerJob: Job? = null
    private var reconnectJob: Job? = null
    private var heartbeatJob: Job? = null
    private var stableConnectionJob: Job? = null
    @Volatile
    private var isConnecting = false
    @Volatile
    private var lastPongAt = 0L
    @Volatile
    private var isConnected = false
    @Volatile
    private var isManuallyClosed = false
    private var reconnectAttempt = 0
    @Volatile private var activeMode = "romantic"
    @Volatile private var activeNickname = "Boss"
    @Volatile private var activeVoice = "Kore"
    @Volatile private var activeLang = "bn-BD"
    private val outgoingQueue = mutableListOf<String>()
    private var listener: LiveSessionListener? = null

    fun setListener(liveListener: LiveSessionListener) {
        this.listener = liveListener
    }

    fun isLiveConnected(): Boolean = isConnected

    /**
     * Verifies backend server reachability via `/api/status`.
     */
    suspend fun verifyBackendConnection(backendBaseUrl: String): GeminiResult = withContext(Dispatchers.IO) {
        val cleanBase = backendBaseUrl.trim().trimEnd('/')
        if (cleanBase.isBlank()) {
            return@withContext GeminiResult.GenericError("Server URL cannot be empty.")
        }
        try {
            val url = URL("$cleanBase/api/status")
            val conn = (url.openConnection() as HttpURLConnection).apply {
                connectTimeout = 6000
                readTimeout = 6000
                requestMethod = "GET"
            }
            val code = conn.responseCode
            if (code in 200..299) {
                GeminiResult.Success("Zoni Live Server verified and online.")
            } else {
                GeminiResult.GenericError("Server responded with HTTP $code")
            }
        } catch (e: Exception) {
            GeminiResult.NetworkError("Could not reach server: ${e.localizedMessage ?: "Connection failed"}")
        }
    }

    /**
     * Connects or reuses the single shared `/live` WebSocket session.
     */
    fun connectSharedSession(
        mode: String = "romantic",
        nickname: String = "Boss",
        voice: String = "Kore",
        lang: String = "bn-BD",
        forceReconnect: Boolean = false
    ) {
        if (isConnected && !forceReconnect) return
        if (isConnecting && !forceReconnect) return
        isManuallyClosed = false
        activeMode = mode
        activeNickname = nickname
        activeVoice = voice
        activeLang = lang
        reconnectJob?.cancel()
        if (forceReconnect) {
            reconnectAttempt = 0
            closeCurrentTransport()
        }

        scope.launch {
            openWebSocketInternal(activeMode, activeNickname, activeVoice, activeLang)
        }
    }

    fun connectSharedSession(forceNew: Boolean) {
        connectSharedSession(forceReconnect = forceNew)
    }

    fun disconnect() = disconnectSession()

    /**
     * Sends a typed Chat Box message over the shared Gemini Live WebSocket session.
     */
    fun sendChatBoxMessage(text: String, clientMsgId: String = "msg-${System.currentTimeMillis()}") {
        val trimmed = text.trim()
        if (trimmed.isEmpty()) return

        val json = JSONObject().apply {
            put("type", "client_text")
            put("text", trimmed.take(4000))
            put("clientMsgId", clientMsgId)
        }
        sendJsonPayload(json.toString())
    }

    /**
     * Streams a 16kHz PCM audio chunk (Base64) over the shared Gemini Live WebSocket session.
     */
    fun sendRealtimeAudioChunk(pcm16Bytes: ByteArray, length: Int) {
        if (!isConnected || length <= 0) return
        val slice = if (length == pcm16Bytes.size) pcm16Bytes else pcm16Bytes.copyOf(length)
        val base64Audio = Base64.encodeToString(slice, Base64.NO_WRAP)
        val json = JSONObject().apply {
            put("audio", base64Audio)
        }
        sendJsonPayload(json.toString(), queueIfDisconnected = false)
    }

    /**
     * Sends an interrupt signal over the shared Gemini Live WebSocket session.
     */
    fun sendInterrupt() {
        val json = JSONObject().apply {
            put("type", "interrupt")
        }
        sendJsonPayload(json.toString(), queueIfDisconnected = false)
    }

    private fun sendJsonPayload(payload: String, queueIfDisconnected: Boolean = true) {
        scope.launch {
            val out = outputStream
            if (isConnected && out != null) {
                try {
                    writeWebSocketTextFrame(out, payload)
                    return@launch
                } catch (e: Exception) {
                    isConnected = false
                }
            }
            if (queueIfDisconnected) {
                synchronized(outgoingQueue) {
                    if (outgoingQueue.size < 30) {
                        outgoingQueue.add(payload)
                    }
                }
                connectSharedSession()
            }
        }
    }

    fun disconnectSession() {
        isManuallyClosed = true
        isConnected = false
        isConnecting = false
        reconnectJob?.cancel()
        heartbeatJob?.cancel()
        stableConnectionJob?.cancel()
        readerJob?.cancel()
        closeCurrentTransport()
    }

    private suspend fun openWebSocketInternal(
        mode: String,
        nickname: String,
        voice: String,
        lang: String
    ) {
        if (isManuallyClosed || isConnected || isConnecting) return
        isConnecting = true
        try {
            listener?.onConnectionStateChanged(
                false,
                false,
                if (reconnectAttempt > 0) "reconnecting" else "connecting"
            )

            val base = keyManager.getBackendUrl()
            val wsBase = when {
                base.startsWith("https://") -> "wss://" + base.removePrefix("https://")
                base.startsWith("http://") -> "ws://" + base.removePrefix("http://")
                base.startsWith("wss://") || base.startsWith("ws://") -> base
                else -> "ws://$base"
            }

            val encodedName = URLEncoder.encode(nickname, "UTF-8")
            val handle = keyManager.getResumptionHandle()
            val handleParam = if (!handle.isNullOrBlank()) "&handle=${URLEncoder.encode(handle, "UTF-8")}" else ""
            val fullUri = URI("$wsBase/live?mode=$mode&nickname=$encodedName&selectedAffectionName=$encodedName&voice=$voice&lang=$lang$handleParam")

            val isSecure = fullUri.scheme.equals("wss", ignoreCase = true)
            val host = fullUri.host ?: "10.0.2.2"
            val port = if (fullUri.port != -1) fullUri.port else if (isSecure) 443 else 80
            val pathAndQuery = (fullUri.rawPath.ifEmpty { "/live" }) +
                (if (fullUri.rawQuery != null) "?${fullUri.rawQuery}" else "")

            val rawSocket = if (isSecure) {
                SSLSocketFactory.getDefault().createSocket(host, port)
            } else {
                Socket(host, port)
            }
            rawSocket.keepAlive = true
            socket = rawSocket

            val input = BufferedInputStream(rawSocket.getInputStream())
            val output = BufferedOutputStream(rawSocket.getOutputStream())
            outputStream = output

            // Perform RFC 6455 WebSocket Handshake
            val keyBytes = ByteArray(16)
            SecureRandom().nextBytes(keyBytes)
            val secKey = Base64.encodeToString(keyBytes, Base64.NO_WRAP)

            val requestHeader = buildString {
                append("GET $pathAndQuery HTTP/1.1\r\n")
                append("Host: $host:$port\r\n")
                append("Upgrade: websocket\r\n")
                append("Connection: Upgrade\r\n")
                append("Sec-WebSocket-Key: $secKey\r\n")
                append("Sec-WebSocket-Version: 13\r\n")
                append("\r\n")
            }
            output.write(requestHeader.toByteArray(Charsets.UTF_8))
            output.flush()

            val statusLine = readHttpLine(input)
            if (!statusLine.contains("101")) {
                throw IllegalStateException("WebSocket handshake failed: $statusLine")
            }
            while (true) {
                val line = readHttpLine(input)
                if (line.isEmpty()) break
            }

            isConnected = true
            isConnecting = false
            lastPongAt = System.currentTimeMillis()
            startHeartbeat()
            stableConnectionJob?.cancel()
            stableConnectionJob = scope.launch {
                delay(30000)
                if (isConnected && !isManuallyClosed) reconnectAttempt = 0
            }

            readerJob = scope.launch {
                readWebSocketLoop(input)
            }
        } catch (e: Exception) {
            isConnecting = false
            isConnected = false
            listener?.onConnectionStateChanged(false, false, "error")
            listener?.onError("Live WebSocket connection error: ${e.localizedMessage ?: "Disconnected"}")
            scheduleReconnect(activeMode, activeNickname, activeVoice, activeLang)
        }
    }

    private suspend fun readWebSocketLoop(input: InputStream) {
        try {
            while (scope.isActive && isConnected) {
                val b0 = input.read()
                if (b0 == -1) break
                val opcode = b0 and 0x0F
                val b1 = input.read()
                if (b1 == -1) break

                val isMasked = (b1 and 0x80) != 0
                var payloadLen = (b1 and 0x7F).toLong()
                if (payloadLen == 126L) {
                    val hi = input.read()
                    val lo = input.read()
                    payloadLen = ((hi shl 8) or lo).toLong()
                } else if (payloadLen == 127L) {
                    var len = 0L
                    for (i in 0 until 8) {
                        len = (len shl 8) or (input.read().toLong() and 0xFF)
                    }
                    payloadLen = len
                }

                val maskKey = ByteArray(4)
                if (isMasked) {
                    readFully(input, maskKey)
                }

                val payload = ByteArray(payloadLen.toInt())
                readFully(input, payload)
                if (isMasked) {
                    for (i in payload.indices) {
                        payload[i] = (payload[i].toInt() xor maskKey[i % 4].toInt()).toByte()
                    }
                }

                when (opcode) {
                    0x1 -> { // Text frame
                        val text = String(payload, Charsets.UTF_8)
                        handleIncomingJson(text)
                    }
                    0x8 -> { // Close frame
                        break
                    }
                    0x9 -> { // Server Ping -> Pong
                        outputStream?.let { writeWebSocketControlFrame(it, 0xA, payload) }
                    }
                    0xA -> { // Pong acknowledges our heartbeat
                        lastPongAt = System.currentTimeMillis()
                    }
                }
            }
        } catch (_: Exception) {
            // Connection dropped
        } finally {
            isConnected = false
            isConnecting = false
            heartbeatJob?.cancel()
            stableConnectionJob?.cancel()
            closeCurrentTransport()
            if (!isManuallyClosed) {
                listener?.onConnectionStateChanged(false, false, "reconnecting")
                scheduleReconnect(activeMode, activeNickname, activeVoice, activeLang)
            } else {
                listener?.onConnectionStateChanged(false, false, "disconnected")
            }
        }
    }

    private fun handleIncomingJson(rawText: String) {
        try {
            val msg = JSONObject(rawText)
            val type = msg.optString("type")
            val turnId = msg.optInt("turnId", 1)

            when (type) {
                "connected" -> {
                    val resumed = msg.optBoolean("resumed", false)
                    listener?.onConnectionStateChanged(true, resumed, if (resumed) "Live সেশন পুনরায় সংযুক্ত হয়েছে।" else "Zoni Live সেশন সক্রিয়।")
                    flushQueuedMessages()
                }
                "session_resumption" -> {
                    val newHandle = msg.optString("newHandle", "")
                    if (newHandle.isNotBlank()) {
                        keyManager.saveResumptionHandle(newHandle)
                    }
                }
                "user_transcript" -> {
                    val text = msg.optString("text", "")
                    if (text.isNotBlank()) {
                        listener?.onUserTranscript(text, turnId)
                    }
                }
                "output_transcript", "text" -> {
                    val text = msg.optString("text", "")
                    if (text.isNotBlank()) {
                        listener?.onAssistantTextChunk(text, turnId)
                    }
                }
                "audio" -> {
                    val audio = msg.optString("audio", "")
                    if (audio.isNotBlank()) {
                        listener?.onAssistantAudioBase64(audio, turnId)
                    }
                }
                "flashlight" -> {
                    val enable = msg.optBoolean("enable", false)
                    listener?.onFlashlightCommand(enable)
                }
                "turnComplete" -> {
                    listener?.onTurnComplete(turnId)
                }
                "interrupted" -> {
                    listener?.onInterrupted(turnId)
                }
                "go_away" -> {
                    // Gemini is retiring this Live session. Resume proactively before it closes.
                    scheduleReconnect(activeMode, activeNickname, activeVoice, activeLang, 1500L)
                }
                "session_closed" -> {
                    scheduleReconnect(activeMode, activeNickname, activeVoice, activeLang, 1000L)
                }
                "error", "live_init_failed" -> {
                    val message = msg.optString("message", "Live session error")
                    listener?.onError(message)
                    if (msg.optBoolean("retryable", true)) {
                        scheduleReconnect(activeMode, activeNickname, activeVoice, activeLang, 2000L)
                    } else {
                        isConnected = false
                        isManuallyClosed = true
                        closeCurrentTransport()
                        listener?.onConnectionStateChanged(false, false, "error")
                    }
                }
            }
        } catch (_: Exception) {}
    }

    private fun flushQueuedMessages() {
        scope.launch {
            val out = outputStream ?: return@launch
            val toSend = mutableListOf<String>()
            synchronized(outgoingQueue) {
                toSend.addAll(outgoingQueue)
                outgoingQueue.clear()
            }
            for (item in toSend) {
                try {
                    writeWebSocketTextFrame(out, item)
                } catch (_: Exception) {
                    break
                }
            }
        }
    }

    private fun scheduleReconnect(
        mode: String,
        nickname: String,
        voice: String,
        lang: String,
        overrideDelayMs: Long? = null
    ) {
        if (isManuallyClosed) return
        if (reconnectJob?.isActive == true) return
        isConnected = false
        isConnecting = false
        heartbeatJob?.cancel()
        closeCurrentTransport()
        val delayMs = overrideDelayMs
            ?: min(60000L, (1500.0 * 1.8.pow(reconnectAttempt.toDouble())).toLong())
        reconnectAttempt = (reconnectAttempt + 1).coerceAtMost(20)
        listener?.onConnectionStateChanged(false, false, "reconnecting")
        reconnectJob = scope.launch {
            delay(delayMs)
            if (!isManuallyClosed && !isConnected && !isConnecting) {
                openWebSocketInternal(mode, nickname, voice, lang)
            }
        }
    }

    private fun startHeartbeat() {
        heartbeatJob?.cancel()
        heartbeatJob = scope.launch {
            while (isConnected && !isManuallyClosed) {
                delay(20000L)
                val out = outputStream ?: break
                if (System.currentTimeMillis() - lastPongAt > 50000L) {
                    try { socket?.close() } catch (_: Exception) {}
                    break
                }
                try {
                    writeWebSocketControlFrame(out, 0x9, ByteArray(0))
                } catch (_: Exception) {
                    try { socket?.close() } catch (_: Exception) {}
                    break
                }
            }
        }
    }

    private fun closeCurrentTransport() {
        try { socket?.close() } catch (_: Exception) {}
        socket = null
        outputStream = null
    }

    @Synchronized
    private fun writeWebSocketTextFrame(out: OutputStream, text: String) {
        val payload = text.toByteArray(Charsets.UTF_8)
        writeWebSocketFrame(out, 0x1, payload)
    }

    @Synchronized
    private fun writeWebSocketControlFrame(out: OutputStream, opcode: Int, payload: ByteArray) {
        writeWebSocketFrame(out, opcode, payload)
    }

    @Synchronized
    private fun writeWebSocketFrame(out: OutputStream, opcode: Int, payload: ByteArray) {
        val finAndOpcode = 0x80 or (opcode and 0x0F)
        out.write(finAndOpcode)

        val maskKey = ByteArray(4)
        SecureRandom().nextBytes(maskKey)

        val len = payload.size
        when {
            len <= 125 -> {
                out.write(0x80 or len)
            }
            len <= 65535 -> {
                out.write(0x80 or 126)
                out.write((len shr 8) and 0xFF)
                out.write(len and 0xFF)
            }
            else -> {
                out.write(0x80 or 127)
                val longLen = len.toLong()
                for (i in 7 downTo 0) {
                    out.write(((longLen shr (i * 8)) and 0xFF).toInt())
                }
            }
        }

        out.write(maskKey)
        val masked = ByteArray(len)
        for (i in 0 until len) {
            masked[i] = (payload[i].toInt() xor maskKey[i % 4].toInt()).toByte()
        }
        out.write(masked)
        out.flush()
    }

    private fun readHttpLine(input: InputStream): String {
        val sb = StringBuilder()
        while (true) {
            val ch = input.read()
            if (ch == -1) break
            if (ch == '\r'.code) {
                val next = input.read()
                if (next == '\n'.code) break
            }
            sb.append(ch.toChar())
        }
        return sb.toString()
    }

    private fun readFully(input: InputStream, buffer: ByteArray) {
        var offset = 0
        while (offset < buffer.size) {
            val read = input.read(buffer, offset, buffer.size - offset)
            if (read == -1) throw IllegalStateException("Unexpected EOF in WebSocket stream")
            offset += read
        }
    }
}
