package com.zoni.jarvis.assistant

import com.zoni.jarvis.assistant.audio.NearFieldVoiceGate
import com.zoni.jarvis.assistant.audio.SpeakerVerificationConfig
import com.zoni.jarvis.assistant.audio.SpeakerVerificationEngine
import com.zoni.jarvis.assistant.audio.SpeakerVerificationOutcome
import com.zoni.jarvis.assistant.audio.SpeechHighPassFilter
import com.zoni.jarvis.assistant.audio.VoiceLatencyTracker
import com.zoni.jarvis.assistant.audio.VoicePipelineStage
import com.zoni.jarvis.assistant.wakeword.AcousticWakeGate
import com.zoni.jarvis.assistant.wakeword.RollingPcmRingBuffer
import com.zoni.jarvis.assistant.wakeword.VoiceLifecycleState
import com.zoni.jarvis.assistant.wakeword.WakeWordConfig
import com.zoni.jarvis.assistant.wakeword.WakeWordLifecycleGuard
import com.zoni.jarvis.assistant.wakeword.WakeWordMatcher
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.PI
import kotlin.math.roundToInt
import kotlin.math.sin

/**
 * Pure JVM unit tests for Zoni AI Master Voice Intelligence & Wake Word Fix:
 * - NearFieldVoiceGate (silence/ambient gating, 300ms pre-roll flush, 260ms playback echo-tail guard)
 * - SpeechHighPassFilter (85Hz hum/DC removal)
 * - AcousticWakeGate + RollingPcmRingBuffer (soft/distant wake detection & utterance-aligned 300ms pre-roll)
 * - WakeWordMatcher ("Zoni" / "জোনি" variants, strict unrelated rejection, cooldown)
 * - SpeakerVerificationEngine (enrollment, primary vs non-primary discrimination, safe fallback)
 * - VoiceLatencyTracker (real monotonic per-stage durations)
 */
class VoiceIntelligenceUpgradeTest {

    private fun synthesizeVoiceShorts(
        durationMs: Int,
        f0Hz: Double,
        f1Hz: Double,
        f2Hz: Double,
        f3Hz: Double,
        amplitude: Double
    ): ShortArray {
        val count = (durationMs * 16000) / 1000
        return ShortArray(count) { i ->
            val t = i / 16000.0
            val w = 0.42 * sin(2.0 * PI * f0Hz * t) +
                0.34 * sin(2.0 * PI * f1Hz * t) +
                0.22 * sin(2.0 * PI * f2Hz * t) +
                0.12 * sin(2.0 * PI * f3Hz * t)
            (w * amplitude * 32767.0).roundToInt().coerceIn(Short.MIN_VALUE.toInt(), Short.MAX_VALUE.toInt()).toShort()
        }
    }

    private fun shortsToPcm16Le(samples: ShortArray): ByteArray {
        val out = ByteArray(samples.size * 2)
        for (i in samples.indices) {
            val s = samples[i].toInt()
            out[i * 2] = (s and 0xFF).toByte()
            out[i * 2 + 1] = ((s shr 8) and 0xFF).toByte()
        }
        return out
    }

    @Test
    fun nearFieldVoiceGateSuppressesSilenceEchoAndEchoTailWhileFlushingPreRoll() {
        val gate = NearFieldVoiceGate(echoTailHoldoverMs = 260L)
        val highPass = SpeechHighPassFilter()
        val silenceBytes = ByteArray(1600) // 50ms at 16kHz
        val speechShorts = synthesizeVoiceShorts(50, 140.0, 500.0, 1420.0, 2500.0, 0.28)
        val speechBytes = shortsToPcm16Le(speechShorts)
        highPass.processPcm16LeInPlace(speechBytes, speechBytes.size)

        // 1. Silence frames are buffered in pre-roll and NOT transmitted
        for (i in 0 until 8) {
            val d = gate.processPcm16LeFrame(silenceBytes, silenceBytes.size, 50L, false)
            assertFalse(d.shouldTransmitCurrentFrame)
        }

        // 2. Speech onset flushes 6 x 50ms = 300ms pre-roll and transmits active frame
        val onset = gate.processPcm16LeFrame(speechBytes, speechBytes.size, 50L, false)
        assertTrue(onset.shouldTransmitCurrentFrame)
        assertEquals(6, onset.preRollFramesToFlush.size)

        // 3. Playback echo & 260ms tail suppressed completely
        for (i in 0 until 6) {
            val d = gate.processPcm16LeFrame(speechBytes, speechBytes.size, 50L, true)
            assertFalse(d.shouldTransmitCurrentFrame)
            assertTrue(d.suppressedByPlaybackEcho)
        }
        for (i in 0 until 5) {
            val tail = gate.processPcm16LeFrame(speechBytes, speechBytes.size, 50L, false)
            assertFalse(tail.shouldTransmitCurrentFrame)
            assertTrue(tail.suppressedByPlaybackEcho)
        }
    }

    @Test
    fun softDistantWakeWordAndUtteranceAlignedPreRollWorkReliably() {
        val gate = AcousticWakeGate(WakeWordConfig(), sampleRateHz = 16000)
        val ring = RollingPcmRingBuffer(32000)
        val silence = ShortArray(320)

        for (i in 0 until 25) {
            ring.write(silence)
            gate.processPcm16Frame(silence)
        }

        // Softly spoken 180ms wake call
        val softWake = synthesizeVoiceShorts(180, 155.0, 540.0, 1480.0, 2600.0, 0.038)
        var offset = 0
        while (offset + 320 <= softWake.size) {
            val frame = softWake.copyOfRange(offset, offset + 320)
            ring.write(frame)
            gate.processPcm16Frame(frame)
            offset += 320
        }

        var spanSamples = 0
        for (i in 0 until 14) {
            ring.write(silence)
            val analysis = gate.processPcm16Frame(silence)
            if (analysis.candidateReady) {
                spanSamples = analysis.utteranceSpanSamples
            }
        }
        assertTrue("Soft 180ms wake word must trigger Stage-1 candidate", spanSamples > 0)

        val sliced = ring.snapshotUtteranceSamples(spanSamples, preRollSamples = 4800)
        assertEquals(spanSamples + 4800, sliced.size)

        assertTrue(WakeWordMatcher.evaluateCandidate("ওহে জোনি", 0.90f).matched)
        assertTrue(WakeWordMatcher.evaluateCandidate("জোনি ইউটিউব খোলো", 0.90f).matched)
        assertEquals("ইউটিউব খোলো", WakeWordMatcher.evaluateCandidate("জোনি ইউটিউব খোলো", 0.90f).remainingCommand)
    }

    @Test
    fun speakerVerificationDistinguishesPrimaryFromImpostorWithSafeFallback() {
        val samples = listOf(
            synthesizeVoiceShorts(600, 120.0, 450.0, 1260.0, 2350.0, 0.25),
            synthesizeVoiceShorts(600, 124.0, 470.0, 1300.0, 2410.0, 0.22),
            synthesizeVoiceShorts(600, 122.0, 460.0, 1280.0, 2380.0, 0.28)
        ).mapNotNull { SpeakerVerificationEngine.extractEmbedding(it) }

        val profile = SpeakerVerificationEngine.buildVoiceprint(samples, minSamples = 3)
        assertNotNull(profile)

        val strictCfg = SpeakerVerificationConfig(enabled = true, strictMode = true)
        val primaryTest = synthesizeVoiceShorts(500, 123.0, 465.0, 1290.0, 2390.0, 0.20)
        val primaryRes = SpeakerVerificationEngine.verifyUtterance(primaryTest, profile, strictCfg)
        assertEquals(SpeakerVerificationOutcome.VERIFIED_PRIMARY, primaryRes.outcome)
        assertTrue(primaryRes.shouldAllowCommand)

        val otherSpeaker = synthesizeVoiceShorts(500, 260.0, 820.0, 2150.0, 3300.0, 0.24)
        val impostorRes = SpeakerVerificationEngine.verifyUtterance(otherSpeaker, profile, strictCfg)
        assertEquals(SpeakerVerificationOutcome.REJECTED_NON_PRIMARY, impostorRes.outcome)
        assertFalse(impostorRes.shouldAllowCommand)

        // Short utterance falls back safely instead of silently dropping command
        val shortClip = synthesizeVoiceShorts(120, 122.0, 460.0, 1280.0, 2380.0, 0.25)
        val shortRes = SpeakerVerificationEngine.verifyUtterance(shortClip, profile, strictCfg)
        assertEquals(SpeakerVerificationOutcome.INSUFFICIENT_SPEECH, shortRes.outcome)
        assertTrue(shortRes.shouldAllowCommand)
        assertTrue(shortRes.usedSafeFallback)
    }

    @Test
    fun voiceLatencyTrackerRecordsRealMonotonicStageDurationsAndLifecycleGuardBlocksDuplicates() {
        var fakeNs = 1_000_000_000L
        val tracker = VoiceLatencyTracker(nanoClock = { fakeNs })
        tracker.beginTurn()
        tracker.markStageStart(VoicePipelineStage.AUDIO_PROCESSING)
        fakeNs += 4_500_000L // 4.5ms
        tracker.markStageEnd(VoicePipelineStage.AUDIO_PROCESSING)
        tracker.markStageStart(VoicePipelineStage.COMMAND_CLASSIFICATION)
        fakeNs += 1_500_000L // 1.5ms
        tracker.markStageEnd(VoicePipelineStage.COMMAND_CLASSIFICATION)
        val turn = tracker.finishTurn(executedLocally = true)

        assertEquals(4.5, turn.stageDurationsMs[VoicePipelineStage.AUDIO_PROCESSING.key] ?: 0.0, 0.01)
        assertEquals(1.5, turn.stageDurationsMs[VoicePipelineStage.COMMAND_CLASSIFICATION.key] ?: 0.0, 0.01)
        assertEquals(6.0, turn.totalEndToEndMs, 0.01)

        assertFalse(WakeWordLifecycleGuard.shouldAcceptWakeTrigger(VoiceLifecycleState.SPEAKING, 0L, 10_000L))
        assertTrue(WakeWordLifecycleGuard.shouldAcceptWakeTrigger(VoiceLifecycleState.WAKE_WORD_LISTENING, 5_000L, 10_000L))
    }
}
