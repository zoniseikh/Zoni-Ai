package com.zoni.jarvis.assistant.wakeword

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.util.Log
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.text.Normalizer
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

/**
 * Unified 13-state voice lifecycle shared across Android service, React frontend, and backend.
 */
enum class VoiceLifecycleState {
    DISABLED,
    IDLE,
    WAKE_WORD_LISTENING,
    WAKE_WORD_DETECTED,
    ACTIVATING,
    CONNECTING,
    CONNECTED,
    LISTENING,
    PROCESSING,
    SPEAKING,
    DISCONNECTING,
    RECONNECTING,
    ERROR;

    companion object {
        fun fromString(raw: String?): VoiceLifecycleState {
            val clean = raw?.trim()?.uppercase() ?: return IDLE
            return entries.firstOrNull { it.name == clean } ?: IDLE
        }
    }
}

data class WakeWordConfig(
    val wakePhrase: String = DEFAULT_WAKE_PHRASE,
    val confidenceThreshold: Float = 0.72f,
    val cooldownMs: Long = 2500L,
    val minUtteranceMs: Long = 220L,
    val maxUtteranceMs: Long = 1350L,
    val trailingSilenceMs: Long = 260L,
    val energyMultiplier: Float = 2.6f,
    val minRmsThreshold: Float = 0.025f
) {
    companion object {
        const val DEFAULT_WAKE_PHRASE = "Zoni"
    }
}

data class WakeWordMatchResult(
    val matched: Boolean,
    val confidence: Float,
    val matchedVariant: String = "",
    val remainingCommand: String = "",
    val rejectedReason: String = ""
)

data class WakeWordDetectionEvent(
    val wakePhrase: String,
    val matchedVariant: String,
    val confidence: Float,
    val remainingCommand: String,
    val detectedAtMs: Long = System.currentTimeMillis()
)

data class WakeWordStatusSnapshot(
    val wakeWordEnabled: Boolean = false,
    val backgroundServiceRunning: Boolean = false,
    val listening: Boolean = false,
    val wakePhrase: String = WakeWordConfig.DEFAULT_WAKE_PHRASE,
    val voiceState: VoiceLifecycleState = VoiceLifecycleState.DISABLED,
    val micPermissionGranted: Boolean = false,
    val notificationPermissionGranted: Boolean = true,
    val detectorEngine: String = "on_device_two_stage_acoustic_gate",
    val lastDetectedAtMs: Long = 0L,
    val lastConfidence: Float = 0f,
    val lastError: String = ""
) {
    fun toJson(): String = JSONObject()
        .put("wakeWordEnabled", wakeWordEnabled)
        .put("backgroundServiceRunning", backgroundServiceRunning)
        .put("listening", listening)
        .put("wakePhrase", wakePhrase)
        .put("voiceState", voiceState.name)
        .put("micPermissionGranted", micPermissionGranted)
        .put("notificationPermissionGranted", notificationPermissionGranted)
        .put("detectorEngine", detectorEngine)
        .put("lastDetectedAtMs", lastDetectedAtMs)
        .put("lastConfidence", lastConfidence.toDouble())
        .put("lastError", lastError)
        .toString()
}

/**
 * Pure JVM-testable wake-phrase matcher with Bengali, English, and Hindi pronunciation support,
 * strict unrelated-speech rejection, confidence thresholds, duplicate-trigger cooldown,
 * and wake-phrase stripping so the wake word is never executed as an ordinary user command.
 */
object WakeWordMatcher {

    private val DEFAULT_ZONI_VARIANTS = listOf(
        "zoni" to 1.00f,
        "zoni ai" to 1.00f,
        "জোনি" to 1.00f,
        "জোনী" to 0.98f,
        "জনি" to 0.96f,
        "জনী" to 0.95f,
        "জোনি এআই" to 1.00f,
        "জনি এআই" to 0.98f,
        "ज़ोनी" to 1.00f,
        "जोनी" to 0.96f,
        "ज़ोनी एआई" to 1.00f,
        "zony" to 0.92f,
        "zonie" to 0.92f,
        "zoney" to 0.90f,
        "joni" to 0.86f,
        "jonie" to 0.84f,
        "jony" to 0.84f,
        "johny" to 0.78f,
        "johnny" to 0.76f,
        "sooni" to 0.74f,
        "soni" to 0.74f
    )

    private val OPTIONAL_PREFIXES = listOf("hey ", "hi ", "ok ", "okay ", "hello ", "ওহে ", "হেই ", "হ্যালো ", "हे ", "ओए ")

    fun normalizeText(raw: String): String {
        val nfc = Normalizer.normalize(raw, Normalizer.Form.NFC)
        return nfc.trim()
            .lowercase()
            .replace(Regex("[,.:;!?।\\-_\"'()]+"), " ")
            .replace(Regex("\\s+"), " ")
            .trim()
    }

    /**
     * Evaluates a local recognition candidate against the configured wake phrase.
     * Applies strict prefix/exact matching, confidence thresholds, and duplicate-trigger cooldown.
     */
    fun evaluateCandidate(
        rawTranscript: String,
        recognizerConfidence: Float = 0.88f,
        config: WakeWordConfig = WakeWordConfig(),
        lastTriggerAtMs: Long = 0L,
        nowMs: Long = System.currentTimeMillis()
    ): WakeWordMatchResult {
        val clean = normalizeText(rawTranscript)
        if (clean.isEmpty()) {
            return WakeWordMatchResult(matched = false, confidence = 0f, rejectedReason = "empty_transcript")
        }

        if (lastTriggerAtMs > 0L && (nowMs - lastTriggerAtMs) < config.cooldownMs) {
            return WakeWordMatchResult(matched = false, confidence = 0f, rejectedReason = "cooldown_active")
        }

        var stripped = clean
        for (prefix in OPTIONAL_PREFIXES) {
            if (stripped.startsWith(prefix)) {
                stripped = stripped.removePrefix(prefix).trim()
                break
            }
        }

        val configuredNorm = normalizeText(config.wakePhrase).ifBlank { "zoni" }
        val variants: List<Pair<String, Float>> = if (configuredNorm == "zoni") {
            DEFAULT_ZONI_VARIANTS
        } else {
            listOf(configuredNorm to 1.0f)
        }

        val safeRecConf = if (recognizerConfidence in 0.01f..1.0f) recognizerConfidence else 0.85f

        var bestVariant = ""
        var bestScore = 0f
        var remainder = ""

        for ((variant, baseWeight) in variants) {
            val vNorm = normalizeText(variant)
            if (vNorm.isEmpty()) continue

            // Exact wake phrase match (e.g., "Zoni" / "জোনি")
            if (stripped == vNorm) {
                val score = min(1f, baseWeight * (0.5f + 0.5f * safeRecConf))
                if (score > bestScore) {
                    bestScore = score
                    bestVariant = variant
                    remainder = ""
                }
                continue
            }

            // Wake phrase at start followed by command (e.g., "Zoni open YouTube", "জোনি ইউটিউব খোলো")
            if (stripped.startsWith("$vNorm ")) {
                val score = min(1f, baseWeight * (0.48f + 0.52f * safeRecConf))
                if (score > bestScore) {
                    bestScore = score
                    bestVariant = variant
                    remainder = stripped.removePrefix(vNorm).trim()
                }
                continue
            }

            // Single-token edit distance <= 1 for short Latin variants ("zon" / "zonni") ONLY if whole utterance is 1 word
            val words = stripped.split(" ")
            if (words.size == 1 && vNorm.length >= 4 && vNorm.all { it in 'a'..'z' } && stripped.all { it in 'a'..'z' }) {
                val dist = levenshtein(stripped, vNorm)
                if (dist == 1) {
                    val score = min(1f, 0.80f * safeRecConf)
                    if (score > bestScore) {
                        bestScore = score
                        bestVariant = variant
                        remainder = ""
                    }
                }
            }
        }

        if (bestVariant.isEmpty()) {
            return WakeWordMatchResult(
                matched = false,
                confidence = 0f,
                rejectedReason = "wake_phrase_not_present"
            )
        }

        if (bestScore < config.confidenceThreshold) {
            return WakeWordMatchResult(
                matched = false,
                confidence = bestScore,
                matchedVariant = bestVariant,
                rejectedReason = "below_confidence_threshold"
            )
        }

        return WakeWordMatchResult(
            matched = true,
            confidence = bestScore,
            matchedVariant = bestVariant,
            remainingCommand = remainder
        )
    }

    /**
     * Strips the wake phrase prefix so the wake phrase alone is NEVER sent as a user command.
     */
    fun stripWakePhrase(rawText: String, wakePhrase: String = WakeWordConfig.DEFAULT_WAKE_PHRASE): String {
        val result = evaluateCandidate(
            rawTranscript = rawText,
            recognizerConfidence = 1.0f,
            config = WakeWordConfig(wakePhrase = wakePhrase, confidenceThreshold = 0.5f, cooldownMs = 0L)
        )
        return if (result.matched) result.remainingCommand else rawText.trim()
    }

    private fun levenshtein(a: String, b: String): Int {
        val dp = Array(a.length + 1) { IntArray(b.length + 1) }
        for (i in 0..a.length) dp[i][0] = i
        for (j in 0..b.length) dp[0][j] = j
        for (i in 1..a.length) {
            for (j in 1..b.length) {
                val cost = if (a[i - 1] == b[j - 1]) 0 else 1
                dp[i][j] = min(
                    min(dp[i - 1][j] + 1, dp[i][j - 1] + 1),
                    dp[i - 1][j - 1] + cost
                )
            }
        }
        return dp[a.length][b.length]
    }
}

/**
 * Pure JVM-testable Stage-1 On-Device Acoustic Voice Activity & Wake-Length Gate.
 *
 * Inspects 16kHz 16-bit mono PCM frames locally without sending a single byte over the network:
 * - Tracks an adaptive ambient noise floor (handles fan/room noise).
 * - Checks voice-band Zero-Crossing Rate (ZCR) to filter impulsive clicks/knocks.
 * - Triggers a local verification candidate ONLY when a short speech burst matching the
 *   duration profile of "Zoni" / "জোনি" (220ms–1350ms) finishes with brief trailing silence.
 */
class AcousticWakeGate(
    private val config: WakeWordConfig = WakeWordConfig(),
    private val sampleRateHz: Int = 16000
) {
    private var noiseFloorRms: Float = 0.012f
    private var inSpeech: Boolean = false
    private var speechDurationMs: Long = 0L
    private var silenceDurationMs: Long = 0L
    private var peakRms: Float = 0f
    private var voicedFrames: Int = 0

    data class FrameAnalysis(
        val rms: Float,
        val zcr: Float,
        val isVoiceFrame: Boolean,
        val candidateReady: Boolean,
        val utteranceDurationMs: Long
    )

    fun reset() {
        inSpeech = false
        speechDurationMs = 0L
        silenceDurationMs = 0L
        peakRms = 0f
        voicedFrames = 0
    }

    fun processPcm16Frame(samples: ShortArray, count: Int = samples.size): FrameAnalysis {
        if (count <= 0) {
            return FrameAnalysis(0f, 0f, false, false, 0L)
        }
        val frameMs = max(1L, (count * 1000L) / sampleRateHz)

        var sumSq = 0.0
        var zeroCrossings = 0
        var prev = samples[0].toInt()
        for (i in 0 until count) {
            val s = samples[i].toInt()
            val norm = s / 32768.0
            sumSq += norm * norm
            if ((s >= 0 && prev < 0) || (s < 0 && prev >= 0)) {
                zeroCrossings++
            }
            prev = s
        }
        val rms = sqrt(sumSq / count).toFloat()
        val zcr = zeroCrossings.toFloat() / count.toFloat()

        // Human vowel/consonant ZCR at 16kHz typically falls within 0.015..0.38
        val speechLikeZcr = zcr in 0.012f..0.42f
        val dynamicThreshold = max(config.minRmsThreshold, noiseFloorRms * config.energyMultiplier)
        val isVoice = rms >= dynamicThreshold && speechLikeZcr

        if (!isVoice) {
            // Smoothly adapt ambient noise floor during non-speech
            noiseFloorRms = (noiseFloorRms * 0.94f) + (rms * 0.06f)
            noiseFloorRms = noiseFloorRms.coerceIn(0.004f, 0.12f)
        }

        var candidateReady = false
        var completedDuration = 0L

        if (isVoice) {
            if (!inSpeech) {
                inSpeech = true
                speechDurationMs = 0L
                silenceDurationMs = 0L
                peakRms = rms
                voicedFrames = 0
            }
            speechDurationMs += frameMs
            silenceDurationMs = 0L
            peakRms = max(peakRms, rms)
            voicedFrames++
        } else if (inSpeech) {
            silenceDurationMs += frameMs
            if (silenceDurationMs >= config.trailingSilenceMs) {
                val dur = speechDurationMs
                val validDuration = dur in config.minUtteranceMs..config.maxUtteranceMs
                val strongEnough = peakRms >= dynamicThreshold * 1.15f && voicedFrames >= 3
                if (validDuration && strongEnough) {
                    candidateReady = true
                    completedDuration = dur
                }
                reset()
            } else if (speechDurationMs > config.maxUtteranceMs) {
                // Continuous monologue — ignore until silence resets
                reset()
            }
        }

        return FrameAnalysis(
            rms = rms,
            zcr = zcr,
            isVoiceFrame = isVoice,
            candidateReady = candidateReady,
            utteranceDurationMs = completedDuration
        )
    }
}

/**
 * Pluggable backend interface so an external neural keyword model (.tflite/.ppn) can be attached
 * cleanly without altering ZoniForegroundService or UI callers.
 */
interface WakeWordDetectorBackend {
    val engineName: String
    fun start(config: WakeWordConfig, onDetected: (WakeWordDetectionEvent) -> Unit, onError: (String) -> Unit): Boolean
    fun pauseForConversation()
    fun resumeAfterConversation()
    fun stop()
}

/**
 * Production On-Device Two-Stage ZONI Wake-Word Engine:
 *
 * Stage 1 (Always-on Local Acoustic Gate):
 *   Reads 16kHz 16-bit mono PCM locally via `AudioRecord` (zero remote network upload).
 *   Filters ambient silence, steady noise, clicks, and long continuous monologues.
 *
 * Stage 2 (Bounded On-Device Wake-Phrase Verification):
 *   ONLY when Stage 1 detects a wake-sized speech burst (220ms–1350ms), releases `AudioRecord`
 *   briefly and verifies whether the spoken phrase matches `"Zoni"` / `"জোনি"` using Android's
 *   on-device SpeechRecognizer (`EXTRA_PREFER_OFFLINE = true` / `createOnDeviceSpeechRecognizer` on API 31+)
 *   strictly gated by [WakeWordMatcher] confidence thresholds and cooldown protection.
 *   Never streams ambient audio to Gemini Live.
 */
class ZoniWakeWordEngine(
    private val context: Context
) : WakeWordDetectorBackend {

    override val engineName: String = "on_device_two_stage_acoustic_gate"

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val mainHandler = Handler(Looper.getMainLooper())

    @Volatile
    private var config: WakeWordConfig = WakeWordConfig()

    @Volatile
    private var isRunning: Boolean = false

    @Volatile
    private var isPausedForConversation: Boolean = false

    @Volatile
    private var isVerifyingPhrase: Boolean = false

    @Volatile
    private var lastTriggerAtMs: Long = 0L

    private var captureJob: Job? = null
    private var audioRecord: AudioRecord? = null
    private var speechRecognizer: SpeechRecognizer? = null
    private var onDetectedCallback: ((WakeWordDetectionEvent) -> Unit)? = null
    private var onErrorCallback: ((String) -> Unit)? = null

    private val _isListening = MutableStateFlow(false)
    val isListening: StateFlow<Boolean> = _isListening.asStateFlow()

    override fun start(
        config: WakeWordConfig,
        onDetected: (WakeWordDetectionEvent) -> Unit,
        onError: (String) -> Unit
    ): Boolean {
        val hasMic = ContextCompat.checkSelfPermission(
            context,
            Manifest.permission.RECORD_AUDIO
        ) == PackageManager.PERMISSION_GRANTED
        if (!hasMic) {
            onError("Microphone permission (RECORD_AUDIO) is required for ZONI wake-word listening.")
            return false
        }

        stop()
        this.config = config
        this.onDetectedCallback = onDetected
        this.onErrorCallback = onError
        this.isRunning = true
        this.isPausedForConversation = false
        this.isVerifyingPhrase = false

        return startAcousticGateLoop()
    }

    override fun pauseForConversation() {
        isPausedForConversation = true
        _isListening.value = false
        stopAcousticRecorderOnly()
        cancelVerifierOnMain()
    }

    override fun resumeAfterConversation() {
        if (!isRunning) return
        isPausedForConversation = false
        isVerifyingPhrase = false
        startAcousticGateLoop()
    }

    override fun stop() {
        isRunning = false
        isPausedForConversation = false
        isVerifyingPhrase = false
        _isListening.value = false
        stopAcousticRecorderOnly()
        cancelVerifierOnMain()
        onDetectedCallback = null
        onErrorCallback = null
    }

    @SuppressLint("MissingPermission")
    private fun startAcousticGateLoop(): Boolean {
        if (!isRunning || isPausedForConversation) return false
        stopAcousticRecorderOnly()

        val minBuf = AudioRecord.getMinBufferSize(
            SAMPLE_RATE,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT
        )
        if (minBuf <= 0) {
            onErrorCallback?.invoke("AudioRecord buffer initialization failed on this device.")
            return false
        }

        val bufferBytes = max(minBuf * 2, FRAME_SAMPLES * 4)
        val recorder = try {
            AudioRecord(
                MediaRecorder.AudioSource.VOICE_RECOGNITION,
                SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
                bufferBytes
            )
        } catch (e: Exception) {
            Log.e(TAG, "Failed to create AudioRecord for wake-word gate", e)
            onErrorCallback?.invoke("Unable to initialize microphone for wake-word listening: ${e.message}")
            return false
        }

        if (recorder.state != AudioRecord.STATE_INITIALIZED) {
            try { recorder.release() } catch (_: Exception) {}
            onErrorCallback?.invoke("Microphone hardware is busy or unavailable for wake-word detection.")
            return false
        }

        audioRecord = recorder
        return try {
            recorder.startRecording()
            _isListening.value = true
            val gate = AcousticWakeGate(config = config, sampleRateHz = SAMPLE_RATE)

            captureJob = scope.launch {
                val frame = ShortArray(FRAME_SAMPLES)
                while (isActive && isRunning && !isPausedForConversation && !isVerifyingPhrase) {
                    val read = try {
                        recorder.read(frame, 0, frame.size)
                    } catch (_: Exception) {
                        -1
                    }
                    if (read <= 0) {
                        delay(40L)
                        continue
                    }
                    val analysis = gate.processPcm16Frame(frame, read)
                    if (analysis.candidateReady) {
                        val now = System.currentTimeMillis()
                        if (now - lastTriggerAtMs >= config.cooldownMs) {
                            isVerifyingPhrase = true
                            stopAcousticRecorderOnly()
                            triggerBoundedOnDeviceVerification()
                            break
                        }
                    }
                }
            }
            true
        } catch (e: Exception) {
            Log.e(TAG, "Failed to start AudioRecord recording", e)
            stopAcousticRecorderOnly()
            onErrorCallback?.invoke("Microphone capture failed: ${e.message}")
            false
        }
    }

    private fun stopAcousticRecorderOnly() {
        captureJob?.cancel()
        captureJob = null
        val rec = audioRecord
        audioRecord = null
        if (rec != null) {
            try { rec.stop() } catch (_: Exception) {}
            try { rec.release() } catch (_: Exception) {}
        }
    }

    private fun triggerBoundedOnDeviceVerification() {
        mainHandler.post {
            if (!isRunning || isPausedForConversation) {
                isVerifyingPhrase = false
                return@post
            }

            val recognizer = createPreferredOnDeviceRecognizer()
            if (recognizer == null) {
                isVerifyingPhrase = false
                onErrorCallback?.invoke("On-device SpeechRecognizer is unavailable on this Android device.")
                // Resume Stage-1 listening after brief pause rather than crashing
                scope.launch {
                    delay(1200L)
                    if (isRunning && !isPausedForConversation) startAcousticGateLoop()
                }
                return@post
            }

            speechRecognizer = recognizer

            // Hard safety timeout so verification never stays stuck open
            val timeoutRunnable = Runnable {
                if (isVerifyingPhrase) {
                    cancelVerifierOnMain()
                    isVerifyingPhrase = false
                    if (isRunning && !isPausedForConversation) {
                        startAcousticGateLoop()
                    }
                }
            }
            mainHandler.postDelayed(timeoutRunnable, VERIFY_WINDOW_MS)

            recognizer.setRecognitionListener(object : RecognitionListener {
                override fun onReadyForSpeech(params: Bundle?) = Unit
                override fun onBeginningOfSpeech() = Unit
                override fun onRmsChanged(rmsdB: Float) = Unit
                override fun onBufferReceived(buffer: ByteArray?) = Unit
                override fun onEndOfSpeech() = Unit

                override fun onResults(results: Bundle?) {
                    mainHandler.removeCallbacks(timeoutRunnable)
                    val matches = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION).orEmpty()
                    val scores = results?.getFloatArray(SpeechRecognizer.CONFIDENCE_SCORES)
                    handleVerificationCandidates(matches, scores)
                }

                override fun onPartialResults(partialResults: Bundle?) {
                    val partials = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION).orEmpty()
                    for (candidate in partials) {
                        val res = WakeWordMatcher.evaluateCandidate(
                            rawTranscript = candidate,
                            recognizerConfidence = 0.85f,
                            config = config,
                            lastTriggerAtMs = lastTriggerAtMs
                        )
                        if (res.matched) {
                            mainHandler.removeCallbacks(timeoutRunnable)
                            handleMatchedWakeWord(res)
                            return
                        }
                    }
                }

                override fun onError(error: Int) {
                    mainHandler.removeCallbacks(timeoutRunnable)
                    cancelVerifierOnMain()
                    isVerifyingPhrase = false
                    if (isRunning && !isPausedForConversation) {
                        scope.launch {
                            delay(250L)
                            if (isRunning && !isPausedForConversation) startAcousticGateLoop()
                        }
                    }
                }

                override fun onEvent(eventType: Int, params: Bundle?) = Unit
            })

            val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
                putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
                putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 5)
                putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 700L)
                putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 600L)
            }

            try {
                recognizer.startListening(intent)
            } catch (e: Exception) {
                mainHandler.removeCallbacks(timeoutRunnable)
                Log.w(TAG, "Verifier startListening failed: ${e.message}")
                cancelVerifierOnMain()
                isVerifyingPhrase = false
                if (isRunning && !isPausedForConversation) {
                    scope.launch {
                        delay(400L)
                        if (isRunning && !isPausedForConversation) startAcousticGateLoop()
                    }
                }
            }
        }
    }

    private fun handleVerificationCandidates(matches: List<String>, scores: FloatArray?) {
        var matchedResult: WakeWordMatchResult? = null
        matches.forEachIndexed { idx, transcript ->
            val conf = scores?.getOrNull(idx)?.takeIf { it > 0f } ?: 0.85f
            val eval = WakeWordMatcher.evaluateCandidate(
                rawTranscript = transcript,
                recognizerConfidence = conf,
                config = config,
                lastTriggerAtMs = lastTriggerAtMs
            )
            if (eval.matched && (matchedResult == null || eval.confidence > matchedResult!!.confidence)) {
                matchedResult = eval
            }
        }

        val winner = matchedResult
        if (winner != null) {
            handleMatchedWakeWord(winner)
        } else {
            cancelVerifierOnMain()
            isVerifyingPhrase = false
            if (isRunning && !isPausedForConversation) {
                scope.launch {
                    delay(200L)
                    if (isRunning && !isPausedForConversation) startAcousticGateLoop()
                }
            }
        }
    }

    private fun handleMatchedWakeWord(match: WakeWordMatchResult) {
        val now = System.currentTimeMillis()
        lastTriggerAtMs = now
        isPausedForConversation = true
        isVerifyingPhrase = false
        _isListening.value = false
        cancelVerifierOnMain()

        val event = WakeWordDetectionEvent(
            wakePhrase = config.wakePhrase,
            matchedVariant = match.matchedVariant,
            confidence = match.confidence,
            remainingCommand = match.remainingCommand,
            detectedAtMs = now
        )
        Log.i(TAG, "Wake word detected: phrase=${event.wakePhrase} variant=${event.matchedVariant} conf=${event.confidence}")
        onDetectedCallback?.invoke(event)
    }

    private fun createPreferredOnDeviceRecognizer(): SpeechRecognizer? {
        return try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
                SpeechRecognizer.isOnDeviceRecognitionAvailable(context)
            ) {
                SpeechRecognizer.createOnDeviceSpeechRecognizer(context)
            } else if (SpeechRecognizer.isRecognitionAvailable(context)) {
                SpeechRecognizer.createSpeechRecognizer(context)
            } else {
                null
            }
        } catch (e: Exception) {
            Log.w(TAG, "Could not instantiate SpeechRecognizer: ${e.message}")
            null
        }
    }

    private fun cancelVerifierOnMain() {
        mainHandler.post {
            val sr = speechRecognizer
            speechRecognizer = null
            if (sr != null) {
                try { sr.cancel() } catch (_: Exception) {}
                try { sr.destroy() } catch (_: Exception) {}
            }
        }
    }

    companion object {
        private const val TAG = "ZoniWakeWordEngine"
        private const val SAMPLE_RATE = 16000
        // 40ms frames at 16kHz = 640 samples
        private const val FRAME_SAMPLES = 640
        private const val VERIFY_WINDOW_MS = 2300L
    }
}
