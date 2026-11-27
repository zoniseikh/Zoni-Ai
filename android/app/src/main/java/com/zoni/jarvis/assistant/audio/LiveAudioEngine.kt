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
import android.media.audiofx.AutomaticGainControl
import android.media.audiofx.NoiseSuppressor
import android.os.Build
import android.util.Base64
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicLong
import kotlin.math.max
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
 * Pure JVM-testable first-order 85 Hz high-pass filter for 16 kHz 16-bit PCM.
 * Removes DC offset, electrical hum, fan thump, and handling rumble without distorting speech formants.
 */
class SpeechHighPassFilter(
    private val alpha: Float = 0.967f
) {
    private var prevInput: Float = 0f
    private var prevOutput: Float = 0f

    fun reset() {
        prevInput = 0f
        prevOutput = 0f
    }

    fun processPcm16LeInPlace(pcm16Le: ByteArray, length: Int) {
        var i = 0
        while (i + 1 < length) {
            val low = pcm16Le[i].toInt() and 0xFF
            val high = pcm16Le[i + 1].toInt()
            val sample = ((high shl 8) or low).toShort().toFloat()
            val filtered = alpha * (prevOutput + sample - prevInput)
            prevInput = sample
            prevOutput = filtered
            val clamped = filtered.toInt().coerceIn(Short.MIN_VALUE.toInt(), Short.MAX_VALUE.toInt())
            pcm16Le[i] = (clamped and 0xFF).toByte()
            pcm16Le[i + 1] = ((clamped shr 8) and 0xFF).toByte()
            i += 2
        }
    }
}

/**
 * Pure JVM-testable Near-Field Speech Gate with 300ms Pre-Roll Buffer and Playback Echo-Tail Guard.
 *
 * Prevents:
 * - Streaming silence and steady ambient noise to Gemini Live.
 * - Interpreting Zoni's own TTS/Live playback (and its 260ms room reverberation tail) as user commands.
 * - First-syllable loss by flushing the buffered 300ms pre-roll frames cleanly on speech onset.
 *
 * Note: Single-microphone noise suppression & near-field gating reduce ambient noise and softer distant
 * talkers, but cannot completely isolate overlapping nearby speakers at similar loudness without optional
 * speaker verification or wake-word confirmation.
 */
data class NearFieldGateDecision(
    val shouldTransmitCurrentFrame: Boolean,
    val preRollFramesToFlush: List<ByteArray>,
    val isSpeechActive: Boolean,
    val suppressedByPlaybackEcho: Boolean,
    val shouldSignalAudioStreamEnd: Boolean,
    val shouldInterruptAssistant: Boolean = false,
    val endpointDetectionLatencyMs: Long = 0L,
    val effectiveSilenceEndMs: Long = 380L,
    val rms: Float,
    val zcr: Float,
    val noiseFloorRms: Float
)

class NearFieldVoiceGate(
    private val minSpeechRms: Float = 0.017f,
    private val snrStartMultiplier: Float = 2.65f,
    private val snrContinueMultiplier: Float = 1.75f,
    private val minSpeechMs: Long = 130L,
    private val silenceEndMs: Long = 0L, // <= 0 enables adaptive EOS timeout
    private val shortCommandSilenceMs: Long = 260L,
    private val normalSilenceMs: Long = 380L,
    private val longUtteranceSilenceMs: Long = 520L,
    private val hangoverMs: Long = 180L,
    private val echoTailHoldoverMs: Long = 260L,
    private val maxPreRollFrames: Int = 6, // 6 * 50ms = 300ms pre-roll
    private val allowBargeIn: Boolean = false,
    private val bargeInMinRms: Float = 0.085f,
    private val bargeInHoldMs: Long = 120L,
    private val primarySpeakerContinueRatio: Float = 0.25f
) {
    private var noiseFloorRms: Float = 0.005f
    private var inSpeech: Boolean = false
    private var speechAccumMs: Long = 0L
    private var silenceAccumMs: Long = 0L
    private var pauseCountInUtterance: Int = 0
    private var activePrimaryPeakRms: Float = 0f
    private var echoTailRemainingMs: Long = 0L
    private var wasAssistantSpeaking: Boolean = false
    private var bargeInAccumMs: Long = 0L
    private val preRollQueue = ArrayDeque<ByteArray>()

    fun reset() {
        inSpeech = false
        speechAccumMs = 0L
        silenceAccumMs = 0L
        pauseCountInUtterance = 0
        activePrimaryPeakRms = 0f
        bargeInAccumMs = 0L
        preRollQueue.clear()
    }

    fun getNoiseFloorRms(): Float = noiseFloorRms

    fun computeAdaptiveSilenceEndMs(): Long {
        if (silenceEndMs > 0L) return silenceEndMs
        val base = when {
            pauseCountInUtterance >= 2 || speechAccumMs >= 2400L -> longUtteranceSilenceMs
            pauseCountInUtterance >= 1 || speechAccumMs >= 900L -> normalSilenceMs
            else -> shortCommandSilenceMs
        }
        val noiseBoost = if (noiseFloorRms > 0.014f) 40L else 0L
        return base + noiseBoost
    }

    fun processPcm16LeFrame(
        pcm16Le: ByteArray,
        length: Int,
        frameDurationMs: Long,
        isAssistantSpeaking: Boolean
    ): NearFieldGateDecision {
        val safeMs = frameDurationMs.coerceAtLeast(1L)
        val (rms, zcr) = computeRmsAndZcr(pcm16Le, length)
        val speechLikeZcr = zcr in 0.008f..0.44f
        val frameCopy = if (length == pcm16Le.size) pcm16Le.copyOf() else pcm16Le.copyOf(length)

        // 1. Suppress assistant playback audio + room reverberation tail, while supporting
        //    controlled loud near-field user barge-in interruption.
        if (isAssistantSpeaking) {
            wasAssistantSpeaking = true
            echoTailRemainingMs = echoTailHoldoverMs

            val bargeInThreshold = max(bargeInMinRms, noiseFloorRms * 4.5f)
            if (allowBargeIn && rms >= bargeInThreshold && speechLikeZcr) {
                bargeInAccumMs += safeMs
                preRollQueue.addLast(frameCopy)
                while (preRollQueue.size > maxPreRollFrames) {
                    preRollQueue.removeFirst()
                }
                if (bargeInAccumMs >= bargeInHoldMs) {
                    val flushed = preRollQueue.toList()
                    preRollQueue.clear()
                    wasAssistantSpeaking = false
                    echoTailRemainingMs = 0L
                    bargeInAccumMs = 0L
                    inSpeech = true
                    speechAccumMs = bargeInHoldMs
                    silenceAccumMs = 0L
                    pauseCountInUtterance = 0
                    activePrimaryPeakRms = rms
                    return NearFieldGateDecision(
                        shouldTransmitCurrentFrame = true,
                        preRollFramesToFlush = flushed,
                        isSpeechActive = true,
                        suppressedByPlaybackEcho = false,
                        shouldSignalAudioStreamEnd = false,
                        shouldInterruptAssistant = true,
                        endpointDetectionLatencyMs = 0L,
                        effectiveSilenceEndMs = computeAdaptiveSilenceEndMs(),
                        rms = rms,
                        zcr = zcr,
                        noiseFloorRms = noiseFloorRms
                    )
                }
            } else {
                bargeInAccumMs = 0L
                preRollQueue.clear()
            }

            inSpeech = false
            speechAccumMs = 0L
            silenceAccumMs = 0L
            pauseCountInUtterance = 0
            activePrimaryPeakRms = 0f
            return NearFieldGateDecision(
                shouldTransmitCurrentFrame = false,
                preRollFramesToFlush = emptyList(),
                isSpeechActive = false,
                suppressedByPlaybackEcho = true,
                shouldSignalAudioStreamEnd = false,
                shouldInterruptAssistant = false,
                endpointDetectionLatencyMs = 0L,
                effectiveSilenceEndMs = computeAdaptiveSilenceEndMs(),
                rms = rms,
                zcr = zcr,
                noiseFloorRms = noiseFloorRms
            )
        }

        bargeInAccumMs = 0L

        if (wasAssistantSpeaking && echoTailRemainingMs > 0L) {
            echoTailRemainingMs = (echoTailRemainingMs - safeMs).coerceAtLeast(0L)
            if (echoTailRemainingMs == 0L) {
                wasAssistantSpeaking = false
            }
            reset()
            return NearFieldGateDecision(
                shouldTransmitCurrentFrame = false,
                preRollFramesToFlush = emptyList(),
                isSpeechActive = false,
                suppressedByPlaybackEcho = true,
                shouldSignalAudioStreamEnd = false,
                shouldInterruptAssistant = false,
                endpointDetectionLatencyMs = 0L,
                effectiveSilenceEndMs = computeAdaptiveSilenceEndMs(),
                rms = rms,
                zcr = zcr,
                noiseFloorRms = noiseFloorRms
            )
        }

        val startThreshold = max(minSpeechRms, noiseFloorRms * snrStartMultiplier)
        val baseContinueThreshold = max(minSpeechRms * 0.62f, noiseFloorRms * snrContinueMultiplier)
        val primaryLockedContinueThreshold = max(
            baseContinueThreshold,
            activePrimaryPeakRms * primarySpeakerContinueRatio
        )
        val effectiveSilenceMs = computeAdaptiveSilenceEndMs()

        if (!inSpeech) {
            if (rms >= startThreshold && speechLikeZcr) {
                inSpeech = true
                speechAccumMs = safeMs
                silenceAccumMs = 0L
                pauseCountInUtterance = 0
                activePrimaryPeakRms = rms
                val flushed = preRollQueue.toList()
                preRollQueue.clear()
                return NearFieldGateDecision(
                    shouldTransmitCurrentFrame = true,
                    preRollFramesToFlush = flushed,
                    isSpeechActive = true,
                    suppressedByPlaybackEcho = false,
                    shouldSignalAudioStreamEnd = false,
                    shouldInterruptAssistant = false,
                    endpointDetectionLatencyMs = 0L,
                    effectiveSilenceEndMs = computeAdaptiveSilenceEndMs(),
                    rms = rms,
                    zcr = zcr,
                    noiseFloorRms = noiseFloorRms
                )
            }

            // Idle non-speech frame: adapt ambient noise floor smoothly and retain only 300ms pre-roll
            noiseFloorRms = (noiseFloorRms * 0.94f + rms * 0.06f).coerceIn(0.002f, 0.032f)
            preRollQueue.addLast(frameCopy)
            while (preRollQueue.size > maxPreRollFrames) {
                preRollQueue.removeFirst()
            }
            return NearFieldGateDecision(
                shouldTransmitCurrentFrame = false,
                preRollFramesToFlush = emptyList(),
                isSpeechActive = false,
                suppressedByPlaybackEcho = false,
                shouldSignalAudioStreamEnd = false,
                shouldInterruptAssistant = false,
                endpointDetectionLatencyMs = 0L,
                effectiveSilenceEndMs = effectiveSilenceMs,
                rms = rms,
                zcr = zcr,
                noiseFloorRms = noiseFloorRms
            )
        }

        // Currently in active speech: primary-speaker energy lock prevents distant background talkers
        // during a pause from falsely holding the turn open.
        if (rms >= primaryLockedContinueThreshold && speechLikeZcr) {
            if (silenceAccumMs >= 140L) {
                pauseCountInUtterance += 1
            }
            speechAccumMs += safeMs
            silenceAccumMs = 0L
            activePrimaryPeakRms = max(activePrimaryPeakRms * 0.98f, rms)
            return NearFieldGateDecision(
                shouldTransmitCurrentFrame = true,
                preRollFramesToFlush = emptyList(),
                isSpeechActive = true,
                suppressedByPlaybackEcho = false,
                shouldSignalAudioStreamEnd = false,
                shouldInterruptAssistant = false,
                endpointDetectionLatencyMs = 0L,
                effectiveSilenceEndMs = computeAdaptiveSilenceEndMs(),
                rms = rms,
                zcr = zcr,
                noiseFloorRms = noiseFloorRms
            )
        }

        silenceAccumMs += safeMs
        // Keep streaming brief hangover frames so final consonants are not clipped
        val withinHangover = silenceAccumMs <= hangoverMs
        if (silenceAccumMs >= effectiveSilenceMs) {
            val hadRealSpeech = speechAccumMs >= minSpeechMs
            val detectedLatencyMs = if (hadRealSpeech) silenceAccumMs else 0L
            reset()
            return NearFieldGateDecision(
                shouldTransmitCurrentFrame = false,
                preRollFramesToFlush = emptyList(),
                isSpeechActive = false,
                suppressedByPlaybackEcho = false,
                shouldSignalAudioStreamEnd = hadRealSpeech,
                shouldInterruptAssistant = false,
                endpointDetectionLatencyMs = detectedLatencyMs,
                effectiveSilenceEndMs = effectiveSilenceMs,
                rms = rms,
                zcr = zcr,
                noiseFloorRms = noiseFloorRms
            )
        }

        return NearFieldGateDecision(
            shouldTransmitCurrentFrame = withinHangover,
            preRollFramesToFlush = emptyList(),
            isSpeechActive = withinHangover,
            suppressedByPlaybackEcho = false,
            shouldSignalAudioStreamEnd = false,
            shouldInterruptAssistant = false,
            endpointDetectionLatencyMs = 0L,
            effectiveSilenceEndMs = effectiveSilenceMs,
            rms = rms,
            zcr = zcr,
            noiseFloorRms = noiseFloorRms
        )
    }

    companion object {
        fun computeRmsAndZcr(pcm16Le: ByteArray, length: Int): Pair<Float, Float> {
            val sampleCount = length / 2
            if (sampleCount <= 0) return 0f to 0f
            var sumSq = 0.0
            var zeroCrossings = 0
            var prev = 0
            var i = 0
            var idx = 0
            while (i + 1 < length) {
                val low = pcm16Le[i].toInt() and 0xFF
                val high = pcm16Le[i + 1].toInt()
                val sample = ((high shl 8) or low).toShort().toInt()
                val norm = sample / 32768.0
                sumSq += norm * norm
                if (idx > 0 && ((sample >= 0 && prev < 0) || (sample < 0 && prev >= 0))) {
                    zeroCrossings++
                }
                prev = sample
                i += 2
                idx++
            }
            val rms = sqrt(sumSq / sampleCount).toFloat()
            val zcr = zeroCrossings.toFloat() / sampleCount.toFloat()
            return rms to zcr
        }
    }
}

data class AudioEffectDiagnostics(
    val aecAvailable: Boolean = false,
    val aecEnabled: Boolean = false,
    val nsAvailable: Boolean = false,
    val nsEnabled: Boolean = false,
    val agcAvailable: Boolean = false,
    val agcDisabled: Boolean = false,
    val highPassFilterActive: Boolean = true,
    val nearFieldGateActive: Boolean = true,
    val audioSource: String = "VOICE_COMMUNICATION",
    val inputSampleRateHz: Int = LiveAudioEngine.INPUT_SAMPLE_RATE,
    val outputSampleRateHz: Int = LiveAudioEngine.OUTPUT_SAMPLE_RATE
) {
    fun toJson(): String = JSONObject()
        .put("aecAvailable", aecAvailable)
        .put("aecEnabled", aecEnabled)
        .put("nsAvailable", nsAvailable)
        .put("nsEnabled", nsEnabled)
        .put("agcAvailable", agcAvailable)
        .put("agcDisabled", agcDisabled)
        .put("highPassFilterActive", highPassFilterActive)
        .put("nearFieldGateActive", nearFieldGateActive)
        .put("audioSource", audioSource)
        .put("inputSampleRateHz", inputSampleRateHz)
        .put("outputSampleRateHz", outputSampleRateHz)
        .toString()
}

/**
 * Genuine Native Android Full-Duplex PCM Audio Engine for Gemini Live:
 * - Capture: 16,000 Hz Mono 16-bit PCM (with hardware AEC + NS enabled, hardware AGC disabled
 *   when supported so distant voices aren't boosted during pauses, 85Hz high-pass filter, and
 *   NearFieldVoiceGate with 300ms pre-roll + 260ms playback echo-tail suppression)
 * - Playback: 24,000 Hz Mono 16-bit PCM low-latency streaming via AudioTrack
 * - Manages Android AudioFocus (gain, transient loss / phone call interruption, clean abandon)
 * - Emits normalized audio amplitude (0f..1f) for real-time Arc Reactor visualization
 */
class LiveAudioEngine(
    private val context: Context? = null,
    private val onAmplitudeChanged: (Float) -> Unit = {},
    private val onAudioFocusLost: (Int) -> Unit = {},
    private val preferSpeakerAssistantUsage: Boolean = false
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    private val playbackDispatcher = Dispatchers.IO.limitedParallelism(1)
    private val audioManager: AudioManager? =
        context?.getSystemService(Context.AUDIO_SERVICE) as? AudioManager

    private var audioRecord: AudioRecord? = null
    private var echoCanceler: AcousticEchoCanceler? = null
    private var noiseSuppressor: NoiseSuppressor? = null
    private var automaticGainControl: AutomaticGainControl? = null
    private var captureJob: Job? = null

    private var audioTrack: AudioTrack? = null
    private val playbackLock = Any()
    private val playbackGeneration = AtomicLong(0L)

    @Volatile
    private var isAssistantSpeakingNow: Boolean = false

    @Volatile
    private var resetEosRequested: Boolean = false

    @Volatile
    private var effectDiagnostics: AudioEffectDiagnostics = AudioEffectDiagnostics()

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

    fun getAudioEffectDiagnostics(): AudioEffectDiagnostics = effectDiagnostics

    fun requestVoiceAudioFocus(): Boolean {
        val am = audioManager ?: return true
        if (hasAudioFocus) return true
        return try {
            val result = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val usage = if (preferSpeakerAssistantUsage) {
                    AudioAttributes.USAGE_ASSISTANT
                } else {
                    AudioAttributes.USAGE_VOICE_COMMUNICATION
                }
                val focusGain = if (preferSpeakerAssistantUsage) {
                    AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK
                } else {
                    AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE
                }
                val attrs = AudioAttributes.Builder()
                    .setUsage(usage)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build()
                val req = AudioFocusRequest.Builder(focusGain)
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
                    if (preferSpeakerAssistantUsage) AudioManager.STREAM_MUSIC else AudioManager.STREAM_VOICE_CALL,
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
        onSpeechEndedWithLatency: ((Long) -> Unit)? = null,
        onBargeInDetected: () -> Unit = {},
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

            // Configure hardware audio effects honestly and record actual availability
            val sessionId = recorder.audioSessionId
            val aecAvail = AcousticEchoCanceler.isAvailable()
            if (aecAvail) {
                echoCanceler = try {
                    AcousticEchoCanceler.create(sessionId)?.apply { enabled = true }
                } catch (_: Exception) {
                    null
                }
            }
            val nsAvail = NoiseSuppressor.isAvailable()
            if (nsAvail) {
                noiseSuppressor = try {
                    NoiseSuppressor.create(sessionId)?.apply { enabled = true }
                } catch (_: Exception) {
                    null
                }
            }
            val agcAvail = AutomaticGainControl.isAvailable()
            if (agcAvail) {
                // Disable hardware AGC when supported so quiet pauses do NOT boost distant nearby voices
                automaticGainControl = try {
                    AutomaticGainControl.create(sessionId)?.apply { enabled = false }
                } catch (_: Exception) {
                    null
                }
            }
            effectDiagnostics = AudioEffectDiagnostics(
                aecAvailable = aecAvail,
                aecEnabled = echoCanceler?.enabled == true,
                nsAvailable = nsAvail,
                nsEnabled = noiseSuppressor?.enabled == true,
                agcAvailable = agcAvail,
                agcDisabled = automaticGainControl != null && automaticGainControl?.enabled == false,
                highPassFilterActive = true,
                nearFieldGateActive = true,
                audioSource = "VOICE_COMMUNICATION",
                inputSampleRateHz = INPUT_SAMPLE_RATE,
                outputSampleRateHz = OUTPUT_SAMPLE_RATE
            )

            audioRecord = recorder
            recorder.startRecording()

            captureJob = scope.launch {
                val readBuffer = ByteArray(CHUNK_BYTES)
                val highPass = SpeechHighPassFilter()
                val nearFieldGate = NearFieldVoiceGate(
                    allowBargeIn = (echoCanceler?.enabled == true)
                )

                while (isActive) {
                    val read = recorder.read(readBuffer, 0, readBuffer.size)
                    if (read > 0 && !isMicMuted) {
                        val frameMs = ((read / 2) * 1000L) / INPUT_SAMPLE_RATE
                        if (resetEosRequested) {
                            nearFieldGate.reset()
                            highPass.reset()
                            resetEosRequested = false
                        }

                        // Remove DC offset and low-frequency rumble (<85 Hz) without damaging speech
                        highPass.processPcm16LeInPlace(readBuffer, read)

                        val gateDecision = nearFieldGate.processPcm16LeFrame(
                            pcm16Le = readBuffer,
                            length = read,
                            frameDurationMs = frameMs,
                            isAssistantSpeaking = isAssistantSpeakingNow
                        )

                        // Controlled near-field barge-in: immediately stop assistant playback so user speaks cleanly
                        if (gateDecision.shouldInterruptAssistant) {
                            isAssistantSpeakingNow = false
                            synchronized(playbackLock) {
                                try {
                                    audioTrack?.pause()
                                    audioTrack?.flush()
                                } catch (_: Exception) {
                                }
                            }
                            onBargeInDetected()
                        }

                        // Drive Arc Reactor visual level only when not suppressed by playback echo
                        onAmplitudeChanged(
                            if (gateDecision.suppressedByPlaybackEcho) 0f
                            else min(1f, gateDecision.rms * 3.8f)
                        )

                        // Flush 300ms pre-roll frames on speech onset so first syllables are preserved
                        if (gateDecision.preRollFramesToFlush.isNotEmpty()) {
                            for (preFrame in gateDecision.preRollFramesToFlush) {
                                onBase64PcmChunk(Base64.encodeToString(preFrame, Base64.NO_WRAP))
                            }
                        }

                        // Only transmit active near-field speech / brief consonant hangover frames
                        if (gateDecision.shouldTransmitCurrentFrame) {
                            val chunk = if (read == readBuffer.size) readBuffer else readBuffer.copyOf(read)
                            onBase64PcmChunk(Base64.encodeToString(chunk, Base64.NO_WRAP))
                        }

                        if (gateDecision.shouldSignalAudioStreamEnd) {
                            onSpeechEndedWithLatency?.invoke(gateDecision.endpointDetectionLatencyMs)
                            onSpeechEnded()
                        }
                    } else if (isMicMuted) {
                        nearFieldGate.reset()
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
            automaticGainControl?.release()
        } catch (_: Exception) {
        }
        automaticGainControl = null
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

            // Pair USAGE_VOICE_COMMUNICATION with VOICE_COMMUNICATION AudioRecord for foreground HAL AEC,
            // or USAGE_ASSISTANT for background/screen-locked voice so audio routes clearly to loudspeaker
            // (or connected Bluetooth/wired headset) instead of the quiet earpiece.
            val playbackUsage = if (preferSpeakerAssistantUsage) {
                AudioAttributes.USAGE_ASSISTANT
            } else {
                AudioAttributes.USAGE_VOICE_COMMUNICATION
            }
            val trackBuilder = AudioTrack.Builder()
                .setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(playbackUsage)
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
        val expectedGen = playbackGeneration.get()
        scope.launch(playbackDispatcher) {
            if (playbackGeneration.get() != expectedGen) return@launch
            try {
                val pcmBytes = Base64.decode(base64Pcm, Base64.DEFAULT)
                if (pcmBytes.isEmpty() || playbackGeneration.get() != expectedGen) return@launch
                onAmplitudeChanged(computeRmsAmplitude(pcmBytes, pcmBytes.size))
                val track = ensureAudioTrack() ?: return@launch
                synchronized(playbackLock) {
                    if (!isVoiceMuted &&
                        playbackGeneration.get() == expectedGen &&
                        track.state == AudioTrack.STATE_INITIALIZED
                    ) {
                        track.write(pcmBytes, 0, pcmBytes.size, AudioTrack.WRITE_BLOCKING)
                    }
                }
            } catch (_: Exception) {
                // Ignore transient decode/playback issues
            }
        }
    }

    /**
     * Waits strictly in FIFO order on [playbackDispatcher] until all previously queued PCM chunks
     * finish writing to AudioTrack, plus a short hardware buffer drain cushion, before notifying
     * that assistant speech has actually completed.
     */
    fun notifyTurnCompleteWhenDrained(onDrained: () -> Unit) {
        val expectedGen = playbackGeneration.get()
        scope.launch(playbackDispatcher) {
            if (playbackGeneration.get() != expectedGen) return@launch
            delay(140L)
            if (playbackGeneration.get() != expectedGen) return@launch
            isAssistantSpeakingNow = false
            resetEosRequested = true
            onAmplitudeChanged(0f)
            onDrained()
        }
    }

    fun stopAllPlayback() {
        playbackGeneration.incrementAndGet()
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
