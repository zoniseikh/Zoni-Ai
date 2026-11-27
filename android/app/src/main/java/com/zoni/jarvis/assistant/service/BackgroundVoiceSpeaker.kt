package com.zoni.jarvis.assistant.service

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Log
import java.util.Locale
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Lightweight, loudspeaker-safe native Android TextToSpeech speaker for ZoniForegroundService.
 *
 * Used strictly for voice-only background responses (such as the exact Bengali wake response
 * "হ্যাঁ, বলো শুনছি।" and verified offline/local action confirmations) with ZERO notifications,
 * ZERO popups, and guaranteed completion callbacks even when the screen is OFF or LOCKED.
 */
class BackgroundVoiceSpeaker(private val context: Context) {

    private val mainHandler = Handler(Looper.getMainLooper())
    private val audioManager: AudioManager? =
        context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager

    @Volatile
    private var tts: TextToSpeech? = null

    @Volatile
    private var isInitialized: Boolean = false

    @Volatile
    private var isInitializing: Boolean = false

    @Volatile
    private var isReleased: Boolean = false

    private var focusRequest: AudioFocusRequest? = null
    private val pendingCallbacks = ConcurrentHashMap<String, () -> Unit>()
    private val pendingTimeouts = ConcurrentHashMap<String, Runnable>()
    private var queuedPendingSpeak: Triple<String, Locale?, () -> Unit>? = null

    private val speechAttributes: AudioAttributes = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_ASSISTANT)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
        .build()

    fun warmUp() {
        if (isReleased || isInitialized || isInitializing) return
        isInitializing = true
        mainHandler.post {
            if (isReleased) {
                isInitializing = false
                return@post
            }
            try {
                tts = TextToSpeech(context.applicationContext) { status ->
                    isInitializing = false
                    if (isReleased) {
                        shutdownInternal()
                        return@TextToSpeech
                    }
                    if (status == TextToSpeech.SUCCESS) {
                        isInitialized = true
                        configureEngine(Locale("bn", "BD"))
                        val pending = synchronized(this@BackgroundVoiceSpeaker) {
                            val p = queuedPendingSpeak
                            queuedPendingSpeak = null
                            p
                        }
                        if (pending != null) {
                            speakNowInternal(pending.first, pending.second, pending.third)
                        }
                    } else {
                        Log.w(TAG, "TextToSpeech initialization failed with status=$status")
                        isInitialized = false
                        val pending = synchronized(this@BackgroundVoiceSpeaker) {
                            val p = queuedPendingSpeak
                            queuedPendingSpeak = null
                            p
                        }
                        pending?.third?.invoke()
                    }
                }
            } catch (e: Exception) {
                isInitializing = false
                Log.w(TAG, "TextToSpeech construction failed: ${e.message}")
                val pending = synchronized(this@BackgroundVoiceSpeaker) {
                    val p = queuedPendingSpeak
                    queuedPendingSpeak = null
                    p
                }
                pending?.third?.invoke()
            }
        }
    }

    /**
     * Speaks [text] through Android's Assistant speech audio stream (loudspeaker or connected
     * Bluetooth/wired headset) and invokes [onFinished] exactly once after speech ends or on
     * error/timeout, so callers never hang waiting for audio completion.
     */
    fun speak(
        text: String,
        preferredLocale: Locale? = Locale("bn", "BD"),
        timeoutMs: Long = DEFAULT_UTTERANCE_TIMEOUT_MS,
        onFinished: () -> Unit
    ) {
        val cleanText = text.trim()
        val invoked = AtomicBoolean(false)
        val safeCallback = {
            if (invoked.compareAndSet(false, true)) {
                abandonSpeechFocus()
                onFinished()
            }
        }

        if (isReleased || cleanText.isEmpty()) {
            safeCallback()
            return
        }

        if (!isInitialized) {
            synchronized(this) {
                queuedPendingSpeak?.third?.invoke()
                queuedPendingSpeak = Triple(cleanText, preferredLocale, safeCallback)
            }
            warmUp()
            // Guard against TTS engine never invoking OnInitListener on degraded devices
            mainHandler.postDelayed({
                val stillQueued = synchronized(this) {
                    if (queuedPendingSpeak?.third === safeCallback) {
                        queuedPendingSpeak = null
                        true
                    } else {
                        false
                    }
                }
                if (stillQueued) {
                    Log.w(TAG, "TTS init timeout reached; proceeding without blocking command mode.")
                    safeCallback()
                }
            }, timeoutMs.coerceAtMost(INIT_TIMEOUT_MS))
            return
        }

        speakNowInternal(cleanText, preferredLocale, safeCallback, timeoutMs)
    }

    fun stop() {
        synchronized(this) {
            queuedPendingSpeak = null
        }
        val callbacks = pendingCallbacks.values.toList()
        pendingCallbacks.clear()
        pendingTimeouts.values.forEach { mainHandler.removeCallbacks(it) }
        pendingTimeouts.clear()
        try {
            tts?.stop()
        } catch (_: Exception) {
        }
        abandonSpeechFocus()
        callbacks.forEach { cb ->
            try {
                cb.invoke()
            } catch (_: Exception) {
            }
        }
    }

    fun release() {
        isReleased = true
        stop()
        shutdownInternal()
    }

    private fun shutdownInternal() {
        val engine = tts
        tts = null
        isInitialized = false
        isInitializing = false
        if (engine != null) {
            try {
                engine.stop()
            } catch (_: Exception) {
            }
            try {
                engine.shutdown()
            } catch (_: Exception) {
            }
        }
    }

    private fun configureEngine(preferredLocale: Locale?) {
        val engine = tts ?: return
        try {
            engine.setAudioAttributes(speechAttributes)
            engine.setSpeechRate(1.02f)
            engine.setPitch(1.02f)
            selectBestLanguage(engine, preferredLocale)
            engine.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                override fun onStart(utteranceId: String?) = Unit

                override fun onDone(utteranceId: String?) {
                    completeUtterance(utteranceId)
                }

                @Deprecated("Deprecated in Java")
                override fun onError(utteranceId: String?) {
                    completeUtterance(utteranceId)
                }

                override fun onError(utteranceId: String?, errorCode: Int) {
                    Log.w(TAG, "TTS utterance error code=$errorCode id=$utteranceId")
                    completeUtterance(utteranceId)
                }
            })
        } catch (e: Exception) {
            Log.w(TAG, "TTS configuration warning: ${e.message}")
        }
    }

    private fun selectBestLanguage(engine: TextToSpeech, preferred: Locale?) {
        val candidates = buildList {
            if (preferred != null) add(preferred)
            add(Locale("bn", "BD"))
            add(Locale("bn", "IN"))
            add(Locale("bn"))
            add(Locale.getDefault())
        }
        for (loc in candidates) {
            try {
                val res = engine.isLanguageAvailable(loc)
                if (res != TextToSpeech.LANG_MISSING_DATA && res != TextToSpeech.LANG_NOT_SUPPORTED) {
                    engine.language = loc
                    return
                }
            } catch (_: Exception) {
            }
        }
    }

    private fun speakNowInternal(
        text: String,
        preferredLocale: Locale?,
        onFinished: () -> Unit,
        timeoutMs: Long = DEFAULT_UTTERANCE_TIMEOUT_MS
    ) {
        val engine = tts
        if (engine == null || !isInitialized || isReleased) {
            onFinished()
            return
        }

        val utteranceId = "zoni_bg_${UUID.randomUUID().toString().take(8)}"
        pendingCallbacks[utteranceId] = onFinished

        val timeoutRunnable = Runnable {
            Log.w(TAG, "TTS utterance timed out after ${timeoutMs}ms (id=$utteranceId)")
            completeUtterance(utteranceId)
        }
        pendingTimeouts[utteranceId] = timeoutRunnable
        mainHandler.postDelayed(timeoutRunnable, timeoutMs)

        try {
            requestSpeechFocus()
            if (preferredLocale != null) {
                selectBestLanguage(engine, preferredLocale)
            }
            val params = Bundle().apply {
                putFloat(TextToSpeech.Engine.KEY_PARAM_VOLUME, 1.0f)
            }
            val result = engine.speak(text, TextToSpeech.QUEUE_FLUSH, params, utteranceId)
            if (result != TextToSpeech.SUCCESS) {
                Log.w(TAG, "TTS speak returned error status=$result")
                completeUtterance(utteranceId)
            }
        } catch (e: Exception) {
            Log.w(TAG, "TTS speak exception: ${e.message}")
            completeUtterance(utteranceId)
        }
    }

    private fun completeUtterance(utteranceId: String?) {
        if (utteranceId == null) return
        pendingTimeouts.remove(utteranceId)?.let { mainHandler.removeCallbacks(it) }
        val cb = pendingCallbacks.remove(utteranceId)
        if (cb != null) {
            mainHandler.post { cb.invoke() }
        }
    }

    private fun requestSpeechFocus() {
        val am = audioManager ?: return
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val req = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
                    .setAudioAttributes(speechAttributes)
                    .setAcceptsDelayedFocusGain(false)
                    .setOnAudioFocusChangeListener { }
                    .build()
                focusRequest = req
                am.requestAudioFocus(req)
            }
        } catch (_: Exception) {
        }
    }

    private fun abandonSpeechFocus() {
        val am = audioManager ?: return
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                focusRequest?.let { am.abandonAudioFocusRequest(it) }
                focusRequest = null
            }
        } catch (_: Exception) {
        }
    }

    companion object {
        private const val TAG = "BackgroundVoiceSpeaker"
        private const val INIT_TIMEOUT_MS = 2200L
        private const val DEFAULT_UTTERANCE_TIMEOUT_MS = 4500L
    }
}
