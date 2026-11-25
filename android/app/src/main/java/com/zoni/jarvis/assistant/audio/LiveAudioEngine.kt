package com.zoni.jarvis.assistant.audio

import android.annotation.SuppressLint
import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.NoiseSuppressor
import android.os.Build
import android.util.Base64
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlin.math.min
import kotlin.math.sqrt

/**
 * Pure, JVM-testable adaptive end-of-speech detector for Android Gemini Live voice turns.
 * - Adapts to ambient room noise floor without desensitizing on loud spikes.
 * - Preserves short mid-sentence pauses (~200-350ms) without cutting the user off.
 * - Emits [EndOfSpeechDecision.shouldSignalAudioStreamEnd] exactly once per spoken utterance
 *   after [silenceEndMs] of post-speech silence so Gemini Live replies immediately.
 * - Suppresses triggers while the assistant is speaking to avoid audio-overlap / echo loops.
 */
data class EndOfSpeechDecision(
    val isSpeech: Boolean,
    val shouldSignalAudioStreamEnd: Boolean
)

class NativeEndOfSpeechDetector(
    private val minSpeechAmp: Float = 0.055f,
    private val minSpeechMs: Long = 130L,
    private val silenceEndMs: Long = 420L
) {
    private var noiseFloor: Float = 0.015f
    private var inSpeech: Boolean = false
    private var speechAccumMs: Long = 0L
    private var silenceAccumMs: Long = 0L

    fun reset() {
        inSpeech = false
        speechAccumMs = 0L
        silenceAccumMs = 0L
    }

    fun processFrame(
        amplitude: Float,
        frameDurationMs: Long,
        isAssistantSpeaking: Boolean
    ): EndOfSpeechDecision {
        if (isAssistantSpeaking) {
            reset()
            return EndOfSpeechDecision(isSpeech = false, shouldSignalAudioStreamEnd = false)
        }
        val safeAmp = amplitude.coerceIn(0f, 1f)
        val safeFrameMs = frameDurationMs.coerceAtLeast(1L)
        val startThreshold = maxOf(minSpeechAmp, noiseFloor * 2.8f)
        val continueThreshold = maxOf(minSpeechAmp * 0.64f, noiseFloor * 1.85f)

        if (!inSpeech) {
            if (safeAmp >= startThreshold) {
                inSpeech = true
                speechAccumMs = safeFrameMs
                silenceAccumMs = 0L
                return EndOfSpeechDecision(isSpeech = true, shouldSignalAudioStreamEnd = false)
            }
            noiseFloor = (noiseFloor * 0.94f + safeAmp * 0.06f).coerceIn(0.008f, 0.09f)
            return EndOfSpeechDecision(isSpeech = false, shouldSignalAudioStreamEnd = false)
        }

        if (safeAmp >= continueThreshold) {
            speechAccumMs += safeFrameMs
            silenceAccumMs = 0L
            return EndOfSpeechDecision(isSpeech = true, shouldSignalAudioStreamEnd = false)
        }

        silenceAccumMs += safeFrameMs
        if (silenceAccumMs >= silenceEndMs) {
            val hadRealSpeech = speechAccumMs >= minSpeechMs
            reset()
            return EndOfSpeechDecision(isSpeech = false, shouldSignalAudioStreamEnd = hadRealSpeech)
        }

        return EndOfSpeechDecision(isSpeech = false, shouldSignalAudioStreamEnd = false)
    }
}

/**
 * Genuine Native Android Full-Duplex PCM Audio Engine for Gemini Live:
 * - Capture: 16,000 Hz Mono 16-bit PCM (with hardware AEC + Noise Suppression)
 * - Playback: 24,000 Hz Mono 16-bit PCM low-latency streaming via AudioTrack
 * - Manages Android AudioFocus (gain, transient loss / phone call interruption, clean abandon)
 * - Emits normalized audio amplitude (0f..1f) for real-time Arc Reactor visualization
 */
class LiveAudioEngine(
    private val context: Context? = null,
    private val onAmplitudeChanged: (Float) -> Unit = {},
    private val onAudioFocusLost: (Int) -> Unit = {}
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    private val playbackDispatcher = Dispatchers.IO.limitedParallelism(1)
    private val audioManager: AudioManager? =
        context?.getSystemService(Context.AUDIO_SERVICE) as? AudioManager

    private var audioRecord: AudioRecord? = null
    private var echoCanceler: AcousticEchoCanceler? = null
    private var noiseSuppressor: NoiseSuppressor? = null
    private var captureJob: Job? = null

    private var audioTrack: AudioTrack? = null
    private val playbackLock = Any()

    @Volatile
    private var isAssistantSpeakingNow: Boolean = false

    @Volatile
    private var resetEosRequested: Boolean = false

    private var focusRequest: AudioFocusRequest? = null
    private var hasAudioFocus: Boolean = false

    private val focusChangeListener = AudioManager.OnAudioFocusChangeListener { focusChange ->
        when (focusChange) {
            AudioManager.AUDIOFOCUS_LOSS,
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> {
                hasAudioFocus = false
                stopAllPlayback()
                onAudioFocusLost(focusChange)
            }
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> {
                // Lower transient interference gently without crashing
            }
            AudioManager.AUDIOFOCUS_GAIN -> {
                hasAudioFocus = true
            }
        }
    }

    @Volatile
    var isMicMuted: Boolean = false

    @Volatile
    var isVoiceMuted: Boolean = false

    fun requestVoiceAudioFocus(): Boolean {
        val am = audioManager ?: return true
        if (hasAudioFocus) return true
        return try {
            val result = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val attrs = AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_ASSISTANT)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build()
                val req = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE)
                    .setAudioAttributes(attrs)
                    .setAcceptsDelayedFocusGain(false)
                    .setOnAudioFocusChangeListener(focusChangeListener)
                    .build()
                focusRequest = req
                am.requestAudioFocus(req)
            } else {
                @Suppress("DEPRECATION")
                am.requestAudioFocus(
                    focusChangeListener,
                    AudioManager.STREAM_VOICE_CALL,
                    AudioManager.AUDIOFOCUS_GAIN_TRANSIENT
                )
            }
            hasAudioFocus = (result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED)
            hasAudioFocus
        } catch (_: Exception) {
            true
        }
    }

    fun abandonVoiceAudioFocus() {
        val am = audioManager ?: return
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                focusRequest?.let { am.abandonAudioFocusRequest(it) }
                focusRequest = null
            } else {
                @Suppress("DEPRECATION")
                am.abandonAudioFocus(focusChangeListener)
            }
        } catch (_: Exception) {
        }
        hasAudioFocus = false
    }

    fun setAssistantSpeaking(speaking: Boolean) {
        isAssistantSpeakingNow = speaking
        if (speaking) {
            resetEosRequested = true
        }
    }

    fun resetEndOfSpeechDetector() {
        resetEosRequested = true
    }

    @SuppressLint("MissingPermission")
    fun startMicrophoneCapture(
        onSpeechEnded: () -> Unit = {},
        onBase64PcmChunk: (String) -> Unit
    ): Boolean {
        stopMicrophoneCapture()
        requestVoiceAudioFocus()

        val minBuf = AudioRecord.getMinBufferSize(
            INPUT_SAMPLE_RATE,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT
        )
        if (minBuf <= 0) return false
        val bufferSize = maxOf(minBuf * 2, CHUNK_BYTES * 2)

        return try {
            val recorder = AudioRecord(
                MediaRecorder.AudioSource.VOICE_COMMUNICATION,
                INPUT_SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
                bufferSize
            )
            if (recorder.state != AudioRecord.STATE_INITIALIZED) {
                recorder.release()
                abandonVoiceAudioFocus()
                return false
            }

            // Enable hardware Acoustic Echo Cancellation & Noise Suppression where supported
            val sessionId = recorder.audioSessionId
            if (AcousticEchoCanceler.isAvailable()) {
                echoCanceler = AcousticEchoCanceler.create(sessionId)?.apply { enabled = true }
            }
            if (NoiseSuppressor.isAvailable()) {
                noiseSuppressor = NoiseSuppressor.create(sessionId)?.apply { enabled = true }
            }

            audioRecord = recorder
            recorder.startRecording()

            captureJob = scope.launch {
                val readBuffer = ByteArray(CHUNK_BYTES)
                val eosDetector = NativeEndOfSpeechDetector()

                while (isActive) {
                    val read = recorder.read(readBuffer, 0, readBuffer.size)
                    if (read > 0 && !isMicMuted) {
                        val amp = computeRmsAmplitude(readBuffer, read)
                        onAmplitudeChanged(amp)
                        val chunk = if (read == readBuffer.size) readBuffer else readBuffer.copyOf(read)
                        val b64 = Base64.encodeToString(chunk, Base64.NO_WRAP)
                        onBase64PcmChunk(b64)

                        // Fast adaptive end-of-speech detection (~420ms post-speech silence)
                        val frameMs = ((read / 2) * 1000L) / INPUT_SAMPLE_RATE
                        if (resetEosRequested) {
                            eosDetector.reset()
                            resetEosRequested = false
                        }
                        val decision = eosDetector.processFrame(
                            amplitude = amp,
                            frameDurationMs = frameMs,
                            isAssistantSpeaking = isAssistantSpeakingNow
                        )
                        if (decision.shouldSignalAudioStreamEnd) {
                            onSpeechEnded()
                        }
                    } else if (isMicMuted) {
                        eosDetector.reset()
                        onAmplitudeChanged(0f)
                    }
                }
            }
            true
        } catch (_: Exception) {
            stopMicrophoneCapture()
            false
        }
    }

    fun stopMicrophoneCapture() {
        captureJob?.cancel()
        captureJob = null
        try {
            echoCanceler?.release()
        } catch (_: Exception) {
        }
        echoCanceler = null
        try {
            noiseSuppressor?.release()
        } catch (_: Exception) {
        }
        noiseSuppressor = null
        try {
            audioRecord?.stop()
        } catch (_: Exception) {
        }
        try {
            audioRecord?.release()
        } catch (_: Exception) {
        }
        audioRecord = null
        isAssistantSpeakingNow = false
        resetEosRequested = true
        abandonVoiceAudioFocus()
        onAmplitudeChanged(0f)
    }

    private fun ensureAudioTrack(): AudioTrack? {
        synchronized(playbackLock) {
            audioTrack?.let {
                if (it.state == AudioTrack.STATE_INITIALIZED) {
                    if (it.playState != AudioTrack.PLAYSTATE_PLAYING) {
                        it.play()
                    }
                    return it
                }
            }
            val minBuf = AudioTrack.getMinBufferSize(
                OUTPUT_SAMPLE_RATE,
                AudioFormat.CHANNEL_OUT_MONO,
                AudioFormat.ENCODING_PCM_16BIT
            )
            if (minBuf <= 0) return null

            val trackBuilder = AudioTrack.Builder()
                .setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_ASSISTANT)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build()
                )
                .setAudioFormat(
                    AudioFormat.Builder()
                        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                        .setSampleRate(OUTPUT_SAMPLE_RATE)
                        .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                        .build()
                )
                .setBufferSizeInBytes(maxOf(minBuf, 4800))
                .setTransferMode(AudioTrack.MODE_STREAM)

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                trackBuilder.setPerformanceMode(AudioTrack.PERFORMANCE_MODE_LOW_LATENCY)
            }

            val track = trackBuilder.build()

            track.play()
            audioTrack = track
            return track
        }
    }

    fun playPcm24kBase64(base64Pcm: String) {
        if (isVoiceMuted || base64Pcm.isBlank()) return
        scope.launch(playbackDispatcher) {
            try {
                val pcmBytes = Base64.decode(base64Pcm, Base64.DEFAULT)
                if (pcmBytes.isEmpty()) return@launch
                onAmplitudeChanged(computeRmsAmplitude(pcmBytes, pcmBytes.size))
                val track = ensureAudioTrack() ?: return@launch
                synchronized(playbackLock) {
                    if (!isVoiceMuted && track.state == AudioTrack.STATE_INITIALIZED) {
                        track.write(pcmBytes, 0, pcmBytes.size, AudioTrack.WRITE_BLOCKING)
                    }
                }
            } catch (_: Exception) {
                // Ignore transient decode/playback issues
            }
        }
    }

    fun stopAllPlayback() {
        isAssistantSpeakingNow = false
        resetEosRequested = true
        synchronized(playbackLock) {
            try {
                audioTrack?.pause()
                audioTrack?.flush()
            } catch (_: Exception) {
            }
        }
        onAmplitudeChanged(0f)
    }

    fun release() {
        stopMicrophoneCapture()
        synchronized(playbackLock) {
            try {
                audioTrack?.stop()
                audioTrack?.release()
            } catch (_: Exception) {
            }
            audioTrack = null
        }
    }

    private fun computeRmsAmplitude(pcm16Le: ByteArray, length: Int): Float {
        val sampleCount = length / 2
        if (sampleCount == 0) return 0f
        var sumSquares = 0.0
        var i = 0
        while (i + 1 < length) {
            val low = pcm16Le[i].toInt() and 0xFF
            val high = pcm16Le[i + 1].toInt()
            val sample = (high shl 8) or low
            val normalized = sample / 32768.0
            sumSquares += normalized * normalized
            i += 2
        }
        val rms = sqrt(sumSquares / sampleCount).toFloat()
        return min(1f, rms * 3.8f)
    }

    companion object {
        const val INPUT_SAMPLE_RATE = 16000
        const val OUTPUT_SAMPLE_RATE = 24000
        // 50ms low-latency capture chunks at 16kHz 16-bit mono (1600 bytes)
        const val CHUNK_BYTES = 1600
    }
}
