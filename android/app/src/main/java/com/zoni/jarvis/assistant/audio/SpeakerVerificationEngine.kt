package com.zoni.jarvis.assistant.audio

import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.ln
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sqrt

/**
 * Optional, consent-based, strictly on-device speaker voiceprint engine.
 *
 * Privacy & Safety Guarantees:
 * - Opt-in only: disabled by default until the primary user explicitly enrolls their voice.
 * - Strictly on-device: never transmits voiceprint features or audio embeddings to any cloud/API.
 * - Single primary user only: never identifies, tags, or tracks nearby speakers.
 * - Safe fallback: uncertain scores NEVER silently discard legitimate user commands; they fall back
 *   to standard noise suppression + wake-word confirmation.
 */
enum class SpeakerVerificationOutcome {
    DISABLED,
    NOT_ENROLLED,
    INSUFFICIENT_SPEECH,
    VERIFIED_PRIMARY,
    UNCERTAIN_FALLBACK_ALLOW,
    REJECTED_NON_PRIMARY
}

data class SpeakerVerificationConfig(
    val enabled: Boolean = false,
    val strictMode: Boolean = false,
    val acceptThreshold: Float = 0.78f,
    val uncertainThreshold: Float = 0.56f,
    val minVoicedMs: Long = 220L,
    val requiredEnrollmentSamples: Int = 3
)

data class SpeakerVoiceprint(
    val version: Int = 1,
    val sampleCount: Int,
    val meanFeatures: FloatArray,
    val stdFeatures: FloatArray,
    val meanPitchHz: Float,
    val pitchStdHz: Float,
    val enrolledAtMs: Long = System.currentTimeMillis()
) {
    fun toJson(): String {
        val meanArr = JSONArray()
        val stdArr = JSONArray()
        meanFeatures.forEach { meanArr.put(it.toDouble()) }
        stdFeatures.forEach { stdArr.put(it.toDouble()) }
        return JSONObject()
            .put("version", version)
            .put("sampleCount", sampleCount)
            .put("meanFeatures", meanArr)
            .put("stdFeatures", stdArr)
            .put("meanPitchHz", meanPitchHz.toDouble())
            .put("pitchStdHz", pitchStdHz.toDouble())
            .put("enrolledAtMs", enrolledAtMs)
            .toString()
    }

    companion object {
        fun fromJson(raw: String?): SpeakerVoiceprint? {
            if (raw.isNullOrBlank()) return null
            return try {
                val obj = JSONObject(raw)
                val meanArr = obj.optJSONArray("meanFeatures") ?: return null
                val stdArr = obj.optJSONArray("stdFeatures") ?: return null
                if (meanArr.length() != FEATURE_DIM || stdArr.length() != FEATURE_DIM) return null
                val mean = FloatArray(FEATURE_DIM) { idx -> meanArr.optDouble(idx, 0.0).toFloat() }
                val std = FloatArray(FEATURE_DIM) { idx -> stdArr.optDouble(idx, 0.15).toFloat().coerceAtLeast(0.05f) }
                SpeakerVoiceprint(
                    version = obj.optInt("version", 1),
                    sampleCount = obj.optInt("sampleCount", 0),
                    meanFeatures = mean,
                    stdFeatures = std,
                    meanPitchHz = obj.optDouble("meanPitchHz", 160.0).toFloat(),
                    pitchStdHz = obj.optDouble("pitchStdHz", 35.0).toFloat().coerceAtLeast(15f),
                    enrolledAtMs = obj.optLong("enrolledAtMs", 0L)
                )
            } catch (_: Exception) {
                null
            }
        }

        const val FEATURE_DIM = 16
    }
}

data class AcousticEmbedding(
    val features: FloatArray,
    val estimatedPitchHz: Float,
    val voicedMs: Long,
    val averageRms: Float
)

data class SpeakerVerificationResult(
    val outcome: SpeakerVerificationOutcome,
    val similarityScore: Float,
    val shouldAllowCommand: Boolean,
    val usedSafeFallback: Boolean,
    val voicedMs: Long,
    val reason: String
)

object SpeakerVerificationEngine {

    private const val SAMPLE_RATE = 16000
    private const val FRAME_SIZE = 320 // 20ms at 16kHz
    private const val NUM_BANDS = 12

    // 12 Mel-spaced center frequencies from 120 Hz to 3800 Hz capturing vocal tract formants (F1..F4)
    private val MEL_BAND_CENTERS_HZ = floatArrayOf(
        130f, 210f, 310f, 430f, 580f, 770f,
        1010f, 1310f, 1690f, 2170f, 2790f, 3550f
    )

    private val HANN_WINDOW = FloatArray(FRAME_SIZE) { i ->
        (0.5 * (1.0 - cos(2.0 * PI * i / (FRAME_SIZE - 1)))).toFloat()
    }

    /**
     * Extracts a compact 16-D vocal-tract & prosodic embedding from 16kHz 16-bit mono PCM.
     * Pure deterministic DSP (Goertzel mel-filterbank + autocorrelation F0 + spectral centroid/rolloff/ZCR).
     */
    fun extractEmbedding(samples: ShortArray, count: Int = samples.size): AcousticEmbedding? {
        val safeCount = count.coerceIn(0, samples.size)
        if (safeCount < FRAME_SIZE) return null

        val bandAccum = DoubleArray(NUM_BANDS)
        var weightSum = 0.0
        var pitchSum = 0.0
        var pitchWeight = 0.0
        var centroidSum = 0.0
        var rolloffSum = 0.0
        var zcrSum = 0.0
        var rmsSum = 0.0
        var voicedFrames = 0

        val frameFloats = FloatArray(FRAME_SIZE)
        var offset = 0
        while (offset + FRAME_SIZE <= safeCount) {
            var sumSq = 0.0
            var zeroCrossings = 0
            var prev = samples[offset].toInt()
            for (i in 0 until FRAME_SIZE) {
                val s = samples[offset + i].toInt()
                val f = s / 32768.0f
                frameFloats[i] = f
                sumSq += (f * f).toDouble()
                if ((s >= 0 && prev < 0) || (s < 0 && prev >= 0)) {
                    zeroCrossings++
                }
                prev = s
            }
            val rms = sqrt(sumSq / FRAME_SIZE)
            val zcr = zeroCrossings.toDouble() / FRAME_SIZE.toDouble()

            // Voiced frame check (speech energy + speech-like ZCR)
            if (rms >= 0.012 && zcr in 0.008..0.42) {
                voicedFrames++
                rmsSum += rms
                val frameWeight = rms
                weightSum += frameWeight

                val bandEnergies = DoubleArray(NUM_BANDS)
                var totalBandEnergy = 1e-12
                for (b in 0 until NUM_BANDS) {
                    val e = computeGoertzelPower(frameFloats, MEL_BAND_CENTERS_HZ[b])
                    bandEnergies[b] = e
                    totalBandEnergy += e
                }

                // Log-normalized spectral envelope (level-invariant so distance/loudness doesn't break match)
                var weightedFreqSum = 0.0
                var cumulative = 0.0
                var rolloffHz = MEL_BAND_CENTERS_HZ.last().toDouble()
                var rolloffFound = false
                for (b in 0 until NUM_BANDS) {
                    val rel = bandEnergies[b] / totalBandEnergy
                    val logRel = ln(rel + 1e-6)
                    bandAccum[b] += logRel * frameWeight
                    weightedFreqSum += rel * MEL_BAND_CENTERS_HZ[b]
                    cumulative += rel
                    if (!rolloffFound && cumulative >= 0.85) {
                        rolloffHz = MEL_BAND_CENTERS_HZ[b].toDouble()
                        rolloffFound = true
                    }
                }

                centroidSum += (weightedFreqSum / 4000.0) * frameWeight
                rolloffSum += (rolloffHz / 4000.0) * frameWeight
                zcrSum += (zcr / 0.5) * frameWeight

                val pitchHz = estimatePitchHz(frameFloats)
                if (pitchHz in 75f..380f) {
                    pitchSum += pitchHz * frameWeight
                    pitchWeight += frameWeight
                }
            }
            offset += FRAME_SIZE
        }

        val voicedMs = (voicedFrames * FRAME_SIZE * 1000L) / SAMPLE_RATE
        if (voicedFrames < 3 || weightSum <= 0.0) {
            return null
        }

        val features = FloatArray(SpeakerVoiceprint.FEATURE_DIM)
        // Mean-normalize the 12 log-filterbank bands (cepstral mean subtraction for channel/mic invariance)
        var bandMean = 0.0
        val avgBands = DoubleArray(NUM_BANDS) { b ->
            val v = bandAccum[b] / weightSum
            bandMean += v
            v
        }
        bandMean /= NUM_BANDS.toDouble()
        var bandVar = 1e-6
        for (b in 0 until NUM_BANDS) {
            val d = avgBands[b] - bandMean
            bandVar += d * d
        }
        val bandStd = sqrt(bandVar / NUM_BANDS.toDouble()).coerceAtLeast(0.25)
        for (b in 0 until NUM_BANDS) {
            features[b] = ((avgBands[b] - bandMean) / bandStd).toFloat()
        }

        val estPitch = if (pitchWeight > 0.0) (pitchSum / pitchWeight).toFloat() else 160f
        features[12] = ((estPitch - 75f) / 305f).coerceIn(0f, 1f)
        features[13] = (centroidSum / weightSum).toFloat().coerceIn(0f, 1f)
        features[14] = (rolloffSum / weightSum).toFloat().coerceIn(0f, 1f)
        features[15] = (zcrSum / weightSum).toFloat().coerceIn(0f, 1f)

        return AcousticEmbedding(
            features = features,
            estimatedPitchHz = estPitch,
            voicedMs = voicedMs,
            averageRms = (rmsSum / voicedFrames).toFloat()
        )
    }

    /**
     * Builds an encrypted-ready local [SpeakerVoiceprint] from explicitly enrolled voice samples.
     */
    fun buildVoiceprint(
        embeddings: List<AcousticEmbedding>,
        minSamples: Int = 3
    ): SpeakerVoiceprint? {
        if (embeddings.size < minSamples) return null
        val dim = SpeakerVoiceprint.FEATURE_DIM
        val mean = FloatArray(dim)
        val std = FloatArray(dim)
        var pitchMean = 0f

        for (emb in embeddings) {
            for (i in 0 until dim) {
                mean[i] += emb.features[i]
            }
            pitchMean += emb.estimatedPitchHz
        }
        val n = embeddings.size.toFloat()
        for (i in 0 until dim) mean[i] /= n
        pitchMean /= n

        var pitchVar = 0f
        for (emb in embeddings) {
            for (i in 0 until dim) {
                val diff = emb.features[i] - mean[i]
                std[i] += diff * diff
            }
            val pDiff = emb.estimatedPitchHz - pitchMean
            pitchVar += pDiff * pDiff
        }
        for (i in 0 until dim) {
            std[i] = sqrt((std[i] / n).toDouble()).toFloat().coerceAtLeast(0.18f)
        }
        val pitchStd = sqrt((pitchVar / n).toDouble()).toFloat().coerceIn(18f, 65f)

        return SpeakerVoiceprint(
            sampleCount = embeddings.size,
            meanFeatures = mean,
            stdFeatures = std,
            meanPitchHz = pitchMean,
            pitchStdHz = pitchStd
        )
    }

    /**
     * Computes a bounded [0..1] similarity score combining spectral-envelope cosine similarity,
     * variance-normalized feature distance, and pitch proximity.
     */
    fun computeSimilarity(profile: SpeakerVoiceprint, candidate: AcousticEmbedding): Float {
        // 1. Cosine similarity over the 12-band normalized vocal-tract envelope
        var dot = 0.0
        var normA = 0.0
        var normB = 0.0
        for (i in 0 until NUM_BANDS) {
            val a = profile.meanFeatures[i].toDouble()
            val b = candidate.features[i].toDouble()
            dot += a * b
            normA += a * a
            normB += b * b
        }
        val cosine = if (normA > 1e-9 && normB > 1e-9) {
            (dot / (sqrt(normA) * sqrt(normB))).coerceIn(-1.0, 1.0)
        } else {
            0.0
        }
        val spectralCosineScore = ((cosine + 1.0) * 0.5).coerceIn(0.0, 1.0)

        // 2. Standardized Gaussian proximity over spectral centroid, rolloff, and ZCR
        var sqDist = 0.0
        for (i in 13 until SpeakerVoiceprint.FEATURE_DIM) {
            val denom = max(profile.stdFeatures[i].toDouble(), 0.14)
            val z = (candidate.features[i] - profile.meanFeatures[i]) / denom
            sqDist += z * z
        }
        val timbreProximity = exp(-sqDist / 6.0)

        // 3. Fundamental frequency (pitch F0) proximity
        val pitchDiff = abs(candidate.estimatedPitchHz - profile.meanPitchHz).toDouble()
        val pitchScale = max(profile.pitchStdHz.toDouble() * 1.6, 38.0)
        val pitchScore = exp(-((pitchDiff / pitchScale).pow(2.0)))

        val combined = 0.55 * spectralCosineScore + 0.25 * pitchScore + 0.20 * timbreProximity
        return combined.toFloat().coerceIn(0f, 1f)
    }

    /**
     * Verifies a candidate audio utterance against the enrolled primary user voiceprint.
     * Enforces safe fallback: uncertain results NEVER silently drop a legitimate user command.
     */
    fun verifyUtterance(
        samples: ShortArray,
        profile: SpeakerVoiceprint?,
        config: SpeakerVerificationConfig = SpeakerVerificationConfig(),
        count: Int = samples.size
    ): SpeakerVerificationResult {
        if (!config.enabled) {
            return SpeakerVerificationResult(
                outcome = SpeakerVerificationOutcome.DISABLED,
                similarityScore = 1f,
                shouldAllowCommand = true,
                usedSafeFallback = false,
                voicedMs = 0L,
                reason = "speaker_verification_disabled"
            )
        }
        if (profile == null || profile.sampleCount < config.requiredEnrollmentSamples) {
            return SpeakerVerificationResult(
                outcome = SpeakerVerificationOutcome.NOT_ENROLLED,
                similarityScore = 1f,
                shouldAllowCommand = true,
                usedSafeFallback = true,
                voicedMs = 0L,
                reason = "primary_speaker_not_enrolled"
            )
        }

        val embedding = extractEmbedding(samples, count)
        if (embedding == null || embedding.voicedMs < config.minVoicedMs) {
            // Safe fallback: short utterance (e.g. quick "Yes" / "Stop") should not be silently dropped
            return SpeakerVerificationResult(
                outcome = SpeakerVerificationOutcome.INSUFFICIENT_SPEECH,
                similarityScore = 0f,
                shouldAllowCommand = true,
                usedSafeFallback = true,
                voicedMs = embedding?.voicedMs ?: 0L,
                reason = "insufficient_voiced_duration_fallback_allow"
            )
        }

        val score = computeSimilarity(profile, embedding)
        return when {
            score >= config.acceptThreshold -> SpeakerVerificationResult(
                outcome = SpeakerVerificationOutcome.VERIFIED_PRIMARY,
                similarityScore = score,
                shouldAllowCommand = true,
                usedSafeFallback = false,
                voicedMs = embedding.voicedMs,
                reason = "verified_primary_speaker"
            )
            score >= config.uncertainThreshold -> SpeakerVerificationResult(
                outcome = SpeakerVerificationOutcome.UNCERTAIN_FALLBACK_ALLOW,
                similarityScore = score,
                shouldAllowCommand = true,
                usedSafeFallback = true,
                voicedMs = embedding.voicedMs,
                reason = "uncertain_similarity_safe_fallback_allow"
            )
            else -> SpeakerVerificationResult(
                outcome = SpeakerVerificationOutcome.REJECTED_NON_PRIMARY,
                similarityScore = score,
                shouldAllowCommand = !config.strictMode,
                usedSafeFallback = !config.strictMode,
                voicedMs = embedding.voicedMs,
                reason = if (config.strictMode) "non_primary_speaker_rejected" else "non_primary_speaker_soft_fallback"
            )
        }
    }

    private fun computeGoertzelPower(frame: FloatArray, targetFreqHz: Float): Double {
        val omega = 2.0 * PI * targetFreqHz / SAMPLE_RATE.toDouble()
        val coeff = 2.0 * cos(omega)
        var q0: Double
        var q1 = 0.0
        var q2 = 0.0
        for (i in frame.indices) {
            val windowed = (frame[i] * HANN_WINDOW[i]).toDouble()
            q0 = coeff * q1 - q2 + windowed
            q2 = q1
            q1 = q0
        }
        val power = q1 * q1 + q2 * q2 - q1 * q2 * coeff
        return max(0.0, power)
    }

    private fun estimatePitchHz(frame: FloatArray): Float {
        // Autocorrelation lag bounds for human pitch 75 Hz .. 380 Hz at 16 kHz
        val minLag = (SAMPLE_RATE / 380).coerceAtLeast(20) // ~42 samples
        val maxLag = (SAMPLE_RATE / 75).coerceAtMost(frame.size - 1) // ~213 samples

        var zeroLagEnergy = 0.0
        for (s in frame) {
            zeroLagEnergy += (s * s).toDouble()
        }
        if (zeroLagEnergy < 1e-6) return 0f

        var bestLag = -1
        var bestCorr = 0.0
        for (lag in minLag..maxLag) {
            var corr = 0.0
            var idx = 0
            val limit = frame.size - lag
            while (idx < limit) {
                corr += (frame[idx] * frame[idx + lag]).toDouble()
                idx++
            }
            val normalized = corr / zeroLagEnergy
            if (normalized > bestCorr) {
                bestCorr = normalized
                bestLag = lag
            }
        }
        return if (bestLag > 0 && bestCorr >= 0.25) {
            (SAMPLE_RATE.toFloat() / bestLag.toFloat())
        } else {
            0f
        }
    }
}
