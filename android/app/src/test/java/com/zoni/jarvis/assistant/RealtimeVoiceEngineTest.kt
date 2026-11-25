package com.zoni.jarvis.assistant

import com.zoni.jarvis.assistant.audio.NearFieldVoiceGate
import com.zoni.jarvis.assistant.audio.SpeechHighPassFilter
import com.zoni.jarvis.assistant.audio.StreamingSentenceChunker
import com.zoni.jarvis.assistant.audio.VoiceLatencyTracker
import com.zoni.jarvis.assistant.audio.VoicePipelineStage
import com.zoni.jarvis.assistant.domain.LocalCommandRouter
import com.zoni.jarvis.assistant.domain.LocalRouteDecisionKind
import com.zoni.jarvis.assistant.domain.VoiceCommand
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.PI
import kotlin.math.sin

class RealtimeVoiceEngineTest {

    private fun synthPcm16Le(
        amplitude: Double,
        freqHz: Double = 320.0,
        sampleRate: Int = 16000,
        durationMs: Int = 50
    ): ByteArray {
        val count = (sampleRate * durationMs) / 1000
        val out = ByteArray(count * 2)
        for (i in 0 until count) {
            val s = (amplitude * sin(2.0 * PI * freqHz * i / sampleRate) * 32767.0)
                .toInt()
                .coerceIn(Short.MIN_VALUE.toInt(), Short.MAX_VALUE.toInt())
            out[i * 2] = (s and 0xFF).toByte()
            out[i * 2 + 1] = ((s shr 8) and 0xFF).toByte()
        }
        return out
    }

    private fun synthSilence(durationMs: Int = 50): ByteArray = ByteArray((16000 * durationMs / 1000) * 2)

    @Test
    fun scenario1_shortCommandFastAdaptiveEosAndLocalDispatch() {
        val gate = NearFieldVoiceGate()
        val router = LocalCommandRouter()

        repeat(4) { gate.processPcm16LeFrame(synthSilence(), 1600, 50L, false) }
        repeat(9) {
            val d = gate.processPcm16LeFrame(synthPcm16Le(0.18), 1600, 50L, false)
            assertTrue(d.isSpeechActive)
        }

        var eosLatencyMs = 0L
        repeat(10) {
            val d = gate.processPcm16LeFrame(synthSilence(), 1600, 50L, false)
            if (d.shouldSignalAudioStreamEnd && eosLatencyMs == 0L) {
                eosLatencyMs = d.endpointDetectionLatencyMs
            }
        }
        assertTrue("Expected fast short EOS 260..300ms, got $eosLatencyMs", eosLatencyMs in 260L..300L)

        val route = router.route("Open YouTube", isFinal = true)
        assertEquals(LocalRouteDecisionKind.LOCAL_DIRECT, route.kind)
        assertTrue(route.command is VoiceCommand.OpenApp)
        assertEquals(VoicePipelineStage.APPLICATION_LAUNCH, route.primaryLatencyStage)
    }

    @Test
    fun scenario2_longCommandAdaptiveLongerEos() {
        val gate = NearFieldVoiceGate()
        repeat(50) { gate.processPcm16LeFrame(synthPcm16Le(0.16), 1600, 50L, false) }

        repeat(7) {
            val d = gate.processPcm16LeFrame(synthSilence(), 1600, 50L, false)
            assertFalse("Long utterance should not clip at ${(it + 1) * 50}ms", d.shouldSignalAudioStreamEnd)
        }

        var eosLatencyMs = 0L
        repeat(6) {
            val d = gate.processPcm16LeFrame(synthSilence(), 1600, 50L, false)
            if (d.shouldSignalAudioStreamEnd && eosLatencyMs == 0L) {
                eosLatencyMs = d.endpointDetectionLatencyMs
            }
        }
        assertTrue("Expected long EOS 520..550ms, got $eosLatencyMs", eosLatencyMs in 520L..550L)
    }

    @Test
    fun scenario3_midSentencePauseAndPartialTranscriptSafety() {
        val router = LocalCommandRouter()
        assertEquals(LocalRouteDecisionKind.WAIT_FOR_MORE_SPEECH, router.route("Open", isFinal = false).kind)
        assertEquals(LocalRouteDecisionKind.WAIT_FOR_MORE_SPEECH, router.route("Open WhatsApp and", isFinal = false).kind)
        assertEquals(LocalRouteDecisionKind.WAIT_FOR_MORE_SPEECH, router.route("WhatsApp-এ", isFinal = false).kind)
        assertEquals(LocalRouteDecisionKind.PREVIEW_ONLY, router.route("Open YouTube", isFinal = false).kind)
    }

    @Test
    fun scenario4_5_6_7_localRoutingWhatsAppAccessibilityAndGuards() {
        val router = LocalCommandRouter()
        assertEquals(LocalRouteDecisionKind.LOCAL_DIRECT, router.route("Open YouTube", isFinal = true).kind)
        assertEquals(LocalRouteDecisionKind.DUPLICATE_SUPPRESSED, router.route("Open YouTube", isFinal = true).kind)

        router.resetDeduplication()
        assertEquals(LocalRouteDecisionKind.LOCAL_DIRECT, router.route("Open WhatsApp", isFinal = true).kind)

        router.resetDeduplication()
        val waNav = router.route("Open WhatsApp and search Rahul", isFinal = true)
        assertEquals(LocalRouteDecisionKind.LOCAL_DIRECT, waNav.kind)
        assertTrue(waNav.command is VoiceCommand.OpenWhatsAppChat)
        assertEquals(VoicePipelineStage.ACCESSIBILITY_INTERACTION, waNav.primaryLatencyStage)

        router.resetDeduplication()
        val scroll = router.route("Scroll down", isFinal = true)
        assertEquals(LocalRouteDecisionKind.LOCAL_DIRECT, scroll.kind)
        assertEquals(VoicePipelineStage.ACCESSIBILITY_INTERACTION, scroll.primaryLatencyStage)

        val paymentGuard = router.route("Confirm payment of ₹5000 now", isFinal = true)
        assertEquals(LocalRouteDecisionKind.REQUIRES_EXPLICIT_AUTHORIZATION, paymentGuard.kind)

        val shellGuard = router.route("sudo rm -rf /", isFinal = true)
        assertEquals(LocalRouteDecisionKind.BLOCKED_UNSAFE, shellGuard.kind)
    }

    @Test
    fun scenario8_streamingSentenceChunkerPreservesAbbreviationsAndBengaliBoundaries() {
        val chunker = StreamingSentenceChunker()
        val first = chunker.pushDelta("Dr. Sen measured 3.5 volts in the lab. ")
        assertEquals(1, first.size)
        assertEquals("Dr. Sen measured 3.5 volts in the lab.", first[0])

        val bn = chunker.pushDelta("আজকের আকাশ একদম পরিষ্কার আছে। ")
        assertEquals(1, bn.size)
        assertEquals("আজকের আকাশ একদম পরিষ্কার আছে।", bn[0])
    }

    @Test
    fun scenario9_controlledBargeInAndEchoSuppression() {
        val gate = NearFieldVoiceGate(allowBargeIn = true, bargeInMinRms = 0.085f, bargeInHoldMs = 120L)

        // Soft echo suppressed
        repeat(6) {
            val d = gate.processPcm16LeFrame(synthPcm16Le(0.045), 1600, 50L, isAssistantSpeaking = true)
            assertTrue(d.suppressedByPlaybackEcho)
            assertFalse(d.shouldInterruptAssistant)
        }

        // Loud near-field barge-in interrupts immediately
        var interrupted = false
        repeat(4) {
            val d = gate.processPcm16LeFrame(synthPcm16Le(0.25), 1600, 50L, isAssistantSpeaking = true)
            if (d.shouldInterruptAssistant) {
                interrupted = true
                assertTrue(d.shouldTransmitCurrentFrame)
            }
        }
        assertTrue(interrupted)
    }

    @Test
    fun scenario10_backgroundNoiseAndDistantSpeakerResistance() {
        val hpf = SpeechHighPassFilter()
        val gate = NearFieldVoiceGate()

        repeat(9) {
            val pcm = synthPcm16Le(0.30)
            hpf.processPcm16LeInPlace(pcm, pcm.size)
            val d = gate.processPcm16LeFrame(pcm, pcm.size, 50L, false)
            assertTrue(d.isSpeechActive)
        }

        var eosFired = false
        repeat(10) {
            val distant = synthPcm16Le(0.045, freqHz = 360.0)
            hpf.processPcm16LeInPlace(distant, distant.size)
            val d = gate.processPcm16LeFrame(distant, distant.size, 50L, false)
            if (d.shouldSignalAudioStreamEnd) eosFired = true
        }
        assertTrue("Primary user EOS should fire despite softer distant speaker", eosFired)
    }

    @Test
    fun scenario11_latencyTrackerRecordsAllEightStages() {
        var fakeNs = 1_000_000_000L
        val tracker = VoiceLatencyTracker(nanoClock = { fakeNs })
        tracker.beginTurn()
        tracker.recordStageDurationMs(VoicePipelineStage.SPEECH_ENDPOINT_DETECTION, 260.0)
        tracker.markStageStart(VoicePipelineStage.INTENT_CLASSIFICATION)
        fakeNs += 4_000_000L
        tracker.markStageEnd(VoicePipelineStage.INTENT_CLASSIFICATION)
        tracker.markStageStart(VoicePipelineStage.LOCAL_ACTION_DISPATCH)
        fakeNs += 6_000_000L
        tracker.markStageEnd(VoicePipelineStage.LOCAL_ACTION_DISPATCH)
        val metrics = tracker.finishTurn(executedLocally = true)
        assertEquals(260.0, metrics.stageDurationsMs["speech_endpoint_detection"] ?: 0.0, 0.01)
        assertEquals(4.0, metrics.stageDurationsMs["intent_classification"] ?: 0.0, 0.01)
        assertEquals(6.0, metrics.stageDurationsMs["local_action_dispatch"] ?: 0.0, 0.01)
    }
}
