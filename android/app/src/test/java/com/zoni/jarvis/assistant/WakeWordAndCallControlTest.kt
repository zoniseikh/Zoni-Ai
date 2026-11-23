package com.zoni.jarvis.assistant

import com.zoni.jarvis.assistant.action.ActionProtocolValidator
import com.zoni.jarvis.assistant.action.AllowedActionType
import com.zoni.jarvis.assistant.domain.CommandDispatcher
import com.zoni.jarvis.assistant.domain.VoiceCommand
import com.zoni.jarvis.assistant.wakeword.AcousticWakeGate
import com.zoni.jarvis.assistant.wakeword.VoiceLifecycleState
import com.zoni.jarvis.assistant.wakeword.WakeWordConfig
import com.zoni.jarvis.assistant.wakeword.WakeWordMatcher
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.PI
import kotlin.math.sin

/**
 * Pure JVM unit tests for:
 * 1. On-Device ZONI Wake Word Matcher ("Zoni" / "জোনি" / "ज़ोनी", false-trigger rejection, cooldown, wake stripping)
 * 2. On-Device Stage-1 AcousticWakeGate (silence rejection, wake burst detection, long monologue rejection)
 * 3. Unified 13-State VoiceLifecycleState
 * 4. Incoming & Active Phone Call Control parsing and action allowlist validation
 */
class WakeWordAndCallControlTest {

    private val dispatcher = CommandDispatcher()

    @Test
    fun wakeWordMatcherAcceptsDefaultZoniInEnglishBengaliAndHindi() {
        val en = WakeWordMatcher.evaluateCandidate("Zoni", 0.92f)
        assertTrue(en.matched)
        assertTrue(en.confidence >= 0.72f)
        assertEquals("", en.remainingCommand)

        val bn = WakeWordMatcher.evaluateCandidate("জোনি", 0.90f)
        assertTrue(bn.matched)
        assertEquals("", bn.remainingCommand)

        val bnAlt = WakeWordMatcher.evaluateCandidate("জনি, ইউটিউব খোলো", 0.90f)
        assertTrue(bnAlt.matched)
        assertEquals("ইউটিউব খোলো", bnAlt.remainingCommand)

        val hi = WakeWordMatcher.evaluateCandidate("ज़ोनी", 0.90f)
        assertTrue(hi.matched)
        assertEquals("", hi.remainingCommand)

        val prefixed = WakeWordMatcher.evaluateCandidate("Hey Zoni open WhatsApp", 0.92f)
        assertTrue(prefixed.matched)
        assertEquals("open whatsapp", prefixed.remainingCommand)
    }

    @Test
    fun wakeWordMatcherRejectsUnrelatedSpeechLowConfidenceAndCooldownDuplicates() {
        val unrelatedAndConfusable = listOf(
            "Hello how are you today",
            "What is the weather in Dhaka",
            "তুমি কেমন আছো",
            "আজকের খবর বলো",
            "Open YouTube please",
            "johnny",
            "johny",
            "soni",
            "sooni",
            "zone",
            "tony",
            "sony",
            "pony",
            "sunny",
            "honey",
            "money",
            "Hey Johnny open YouTube"
        )
        for (phrase in unrelatedAndConfusable) {
            val res = WakeWordMatcher.evaluateCandidate(phrase, 0.99f)
            assertFalse("Must NOT wake on '$phrase'", res.matched)
            assertEquals("wake_phrase_not_present", res.rejectedReason)
        }

        // Low confidence rejected on a valid variant
        val lowConf = WakeWordMatcher.evaluateCandidate(
            rawTranscript = "zonie",
            recognizerConfidence = 0.25f,
            config = WakeWordConfig(confidenceThreshold = 0.72f)
        )
        assertFalse(lowConf.matched)
        assertEquals("below_confidence_threshold", lowConf.rejectedReason)

        // Cooldown prevents duplicate triggers
        val duringCooldown = WakeWordMatcher.evaluateCandidate(
            rawTranscript = "Zoni",
            recognizerConfidence = 0.95f,
            config = WakeWordConfig(cooldownMs = 2500L),
            lastTriggerAtMs = 10_000L,
            nowMs = 11_200L
        )
        assertFalse(duringCooldown.matched)
        assertEquals("cooldown_active", duringCooldown.rejectedReason)

        // Allowed once cooldown expires
        val afterCooldown = WakeWordMatcher.evaluateCandidate(
            rawTranscript = "Zoni",
            recognizerConfidence = 0.95f,
            config = WakeWordConfig(cooldownMs = 2500L),
            lastTriggerAtMs = 10_000L,
            nowMs = 13_000L
        )
        assertTrue(afterCooldown.matched)
    }

    @Test
    fun wakeWordMatcherSupportsFutureCustomPhraseAndStripsWakePhrase() {
        val customConfig = WakeWordConfig(wakePhrase = "Jarvis")
        assertTrue(WakeWordMatcher.evaluateCandidate("Jarvis", 0.95f, customConfig).matched)
        assertFalse(WakeWordMatcher.evaluateCandidate("Zoni", 0.95f, customConfig).matched)

        // Bare wake phrase strips to empty so it is NEVER executed as an ordinary command
        assertEquals("", WakeWordMatcher.stripWakePhrase("Zoni"))
        assertEquals("", WakeWordMatcher.stripWakePhrase("জোনি"))
        assertEquals("call mom", WakeWordMatcher.stripWakePhrase("Zoni call mom"))
    }

    @Test
    fun acousticWakeGateRejectsSilenceAndDetectsShortVoiceBurst() {
        val gate = AcousticWakeGate(WakeWordConfig())
        val frameSize = 320 // 20ms at 16kHz
        val silence = ShortArray(frameSize) { 0 }

        // 300ms of pure silence should never trigger
        for (i in 0 until 15) {
            val analysis = gate.processPcm16Frame(silence)
            assertFalse(analysis.candidateReady)
        }

        // Synthesize a 440Hz speech-like tone (ZCR ~0.055 at 16kHz, well inside 0.012..0.42)
        val voiceFrame = ShortArray(frameSize) { idx ->
            (sin(2.0 * PI * 440.0 * idx / 16000.0) * 14000.0).toInt().toShort()
        }

        // Feed 400ms of voiced frames (20 frames x 20ms)
        var detected = false
        for (i in 0 until 20) {
            val a = gate.processPcm16Frame(voiceFrame)
            assertTrue("Expected voiced frame", a.isVoiceFrame)
            if (a.candidateReady) detected = true
        }
        assertFalse("Should wait for trailing silence before firing candidate", detected)

        // Feed 320ms of trailing silence (16 frames x 20ms >= 260ms)
        for (i in 0 until 16) {
            val a = gate.processPcm16Frame(silence)
            if (a.candidateReady) detected = true
        }
        assertTrue("Expected wake-length voice burst + trailing silence to trigger candidate", detected)
    }

    @Test
    fun voiceLifecycleStateDeclaresAll13UnifiedStates() {
        assertEquals(13, VoiceLifecycleState.entries.size)
        assertEquals(VoiceLifecycleState.WAKE_WORD_LISTENING, VoiceLifecycleState.fromString("wake_word_listening"))
        assertEquals(VoiceLifecycleState.IDLE, VoiceLifecycleState.fromString("unknown_state"))
    }

    @Test
    fun commandDispatcherAndValidatorHandleCallControlSafely() {
        // Answer incoming call
        assertTrue(dispatcher.parseCommand("কল রিসিভ করো") is VoiceCommand.AnswerIncomingCall)
        assertTrue(dispatcher.parseCommand("ফোন ধরো") is VoiceCommand.AnswerIncomingCall)
        assertTrue(dispatcher.parseCommand("Answer the call") is VoiceCommand.AnswerIncomingCall)
        assertTrue(dispatcher.parseCommand("कॉल उठाओ") is VoiceCommand.AnswerIncomingCall)

        // Reject incoming call
        assertTrue(dispatcher.parseCommand("ইনকামিং কল কেটে দাও") is VoiceCommand.RejectIncomingCall)
        assertTrue(dispatcher.parseCommand("Reject the call") is VoiceCommand.RejectIncomingCall)
        assertTrue(dispatcher.parseCommand("इनकमिंग कॉल काट दो") is VoiceCommand.RejectIncomingCall)

        // End active call
        assertTrue(dispatcher.parseCommand("কল কেটে দাও") is VoiceCommand.EndActiveCall)
        assertTrue(dispatcher.parseCommand("End the call") is VoiceCommand.EndActiveCall)
        assertTrue(dispatcher.parseCommand("Hang up") is VoiceCommand.EndActiveCall)

        // Unrelated speech must NOT trigger call control
        assertTrue(dispatcher.parseCommand("Tell me about phone calls") is VoiceCommand.GeminiGeneralQuery)
        assertTrue(dispatcher.parseCommand("আজকে অনেক কল এসেছে") is VoiceCommand.GeminiGeneralQuery)

        // ActionProtocolValidator allowlists all 3 call-control actions without routine confirmation
        for (toolName in listOf("answer_incoming_call", "reject_incoming_call", "end_active_call")) {
            assertNotNull(AllowedActionType.fromToolName(toolName))
            val (req, err) = ActionProtocolValidator.validate(toolName, emptyMap())
            assertNull(err)
            assertNotNull(req)
            assertFalse(req!!.requiresConfirmation)
        }
    }
}
