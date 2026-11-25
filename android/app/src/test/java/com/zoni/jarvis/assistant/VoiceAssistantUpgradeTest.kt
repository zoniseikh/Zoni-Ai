package com.zoni.jarvis.assistant

import com.zoni.jarvis.assistant.audio.NativeEndOfSpeechDetector
import com.zoni.jarvis.assistant.device.ContactCallResolution
import com.zoni.jarvis.assistant.device.ContactMatch
import com.zoni.jarvis.assistant.device.SmartContactMatcher
import com.zoni.jarvis.assistant.domain.CommandDispatcher
import com.zoni.jarvis.assistant.domain.VoiceCommand
import com.zoni.jarvis.assistant.service.AccessibleNodeSnapshot
import com.zoni.jarvis.assistant.service.AccessibleRect
import com.zoni.jarvis.assistant.service.UniversalUiAutomationEngine
import com.zoni.jarvis.assistant.service.UniversalUiResolution
import com.zoni.jarvis.assistant.service.VisualClickIntelligenceEngine
import com.zoni.jarvis.assistant.service.VisualClickPlan
import com.zoni.jarvis.assistant.wakeword.AcousticWakeGate
import com.zoni.jarvis.assistant.wakeword.RollingPcmRingBuffer
import com.zoni.jarvis.assistant.wakeword.WakeWordConfig
import com.zoni.jarvis.assistant.wakeword.WakeWordMatcher
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.PI
import kotlin.math.sin

/**
 * Pure JVM unit tests covering the 5 targeted Zoni AI Voice Assistant upgrades:
 * - Issue 01: Instant Gemini Live end-of-speech detection & mid-sentence pause preservation
 * - Issue 02: Always-on Zoni wake word pre-roll PCM buffer, early onset gate & Bengali/English matching
 * - Issue 03: Universal cross-app Accessibility UI automation, horizontal swipes & post-click verification
 * - Issue 04: Visual recognition query detection, Gemini Vision JSON parsing & Accessibility safety revalidation
 * - Issue 05: Bilingual Bengali & English smart contact transliteration, fuzzy match, deduplication & disambiguation
 */
class VoiceAssistantUpgradeTest {

    // -------------------------------------------------------------------------
    // ISSUE 01 — INSTANT GEMINI LIVE VOICE RESPONSE
    // -------------------------------------------------------------------------

    @Test
    fun nativeEndOfSpeechDetectorPreservesMidSentencePausesAndFiresOnceAfterSpeechEnds() {
        val detector = NativeEndOfSpeechDetector()

        // Steady low room noise never triggers speech or EOS
        for (i in 0 until 15) {
            val d = detector.processFrame(amplitude = 0.014f, frameDurationMs = 50L, isAssistantSpeaking = false)
            assertFalse(d.isSpeech)
            assertFalse(d.shouldSignalAudioStreamEnd)
        }

        // First spoken clause (200ms)
        for (i in 0 until 4) {
            val d = detector.processFrame(amplitude = 0.22f, frameDurationMs = 50L, isAssistantSpeaking = false)
            assertTrue(d.isSpeech)
            assertFalse(d.shouldSignalAudioStreamEnd)
        }

        // Brief natural mid-sentence pause (250ms < 420ms silenceEndMs) must NOT prematurely cut off
        for (i in 0 until 5) {
            val d = detector.processFrame(amplitude = 0.012f, frameDurationMs = 50L, isAssistantSpeaking = false)
            assertFalse(d.shouldSignalAudioStreamEnd)
        }

        // User resumes speaking (150ms)
        for (i in 0 until 3) {
            val d = detector.processFrame(amplitude = 0.19f, frameDurationMs = 50L, isAssistantSpeaking = false)
            assertTrue(d.isSpeech)
            assertFalse(d.shouldSignalAudioStreamEnd)
        }

        // User stops speaking -> should emit audioStreamEnd ONCE around 420ms (9 * 50ms = 450ms)
        var eosCount = 0
        var eosFrame = -1
        for (frame in 1..15) {
            val d = detector.processFrame(amplitude = 0.010f, frameDurationMs = 50L, isAssistantSpeaking = false)
            if (d.shouldSignalAudioStreamEnd) {
                if (eosFrame == -1) eosFrame = frame
                eosCount++
            }
        }
        assertEquals(1, eosCount)
        assertTrue("Expected EOS around 420ms (frame 9), got $eosFrame", eosFrame in 8..10)

        // While assistant is speaking, detector stays suppressed and never emits spurious EOS
        detector.processFrame(amplitude = 0.35f, frameDurationMs = 50L, isAssistantSpeaking = true)
        for (i in 0 until 12) {
            val d = detector.processFrame(amplitude = 0.01f, frameDurationMs = 50L, isAssistantSpeaking = false)
            assertFalse(d.shouldSignalAudioStreamEnd)
        }
    }

    // -------------------------------------------------------------------------
    // ISSUE 02 — ALWAYS-ON ZONI WAKE WORD
    // -------------------------------------------------------------------------

    @Test
    fun rollingPcmRingBufferWrapsCleanlyAndExportsLittleEndianPcmWithTrailingSilence() {
        val ring = RollingPcmRingBuffer(capacitySamples = 1600)
        val firstChunk = ShortArray(1000) { it.toShort() }
        val secondChunk = ShortArray(1000) { (1000 + it).toShort() }
        ring.write(firstChunk)
        ring.write(secondChunk)

        assertEquals(1600, ring.sizeSamples())
        val snap = ring.snapshotSamples()
        assertEquals(1600, snap.size)
        // Oldest 400 samples (0..399) should have been overwritten -> snap starts at 400
        assertEquals(400.toShort(), snap.first())
        assertEquals(1999.toShort(), snap.last())

        val bytes = ring.snapshotPcm16LeBytes(trailingSilenceSamples = 100)
        assertEquals((1600 + 100) * 2, bytes.size)
        // Verify little-endian encoding of first sample (400 = 0x0190)
        assertEquals(0x90.toByte(), bytes[0])
        assertEquals(0x01.toByte(), bytes[1])
        // Verify trailing silence bytes are zero
        assertEquals(0.toByte(), bytes[bytes.size - 1])
        assertEquals(0.toByte(), bytes[bytes.size - 2])

        ring.clear()
        assertEquals(0, ring.sizeSamples())
        assertArrayEquals(ShortArray(0), ring.snapshotSamples())
    }

    @Test
    fun wakeWordMatcherSupportsExpandedBengaliEnglishVariantsAndRejectsSimilarFalseTriggers() {
        val cfg = WakeWordConfig()

        val bnVariants = listOf("জোনি", "জনি", "জুনি", "হে জোনি", "ও জোনি", "শোনো জোনি", "জোনি এ আই", "Zoni", "Hey Zoni")
        for (phrase in bnVariants) {
            val res = WakeWordMatcher.evaluateCandidate(phrase, recognizerConfidence = 0.92f, config = cfg)
            assertTrue("Expected wake match for '$phrase' (rejected: ${res.rejectedReason})", res.matched)
        }

        val withCmd = WakeWordMatcher.evaluateCandidate("হে জোনি, টর্চ জ্বালাও", recognizerConfidence = 0.94f, config = cfg)
        assertTrue(withCmd.matched)
        assertEquals("টর্চ জ্বালাও", withCmd.remainingCommand)

        val falseWords = listOf("zone", "johnny", "sony", "sunny", "money", "phone", "hello world")
        for (word in falseWords) {
            val res = WakeWordMatcher.evaluateCandidate(word, recognizerConfidence = 0.95f, config = cfg)
            assertFalse("Expected strict rejection for '$word'", res.matched)
        }
    }

    @Test
    fun acousticWakeGateEmitsEarlyOnsetAndCandidateReadyForVoiceWakeUtterance() {
        val gate = AcousticWakeGate(config = WakeWordConfig(), sampleRateHz = 16000)
        val frameSize = 640 // 40ms at 16kHz
        val silence = ShortArray(frameSize)
        val voiceFrame = ShortArray(frameSize) { i ->
            // 350Hz synthetic voiced tone with natural speech RMS (~0.25) and speech-band ZCR
            (sin(2.0 * PI * 350.0 * i / 16000.0) * 11000.0).toInt().toShort()
        }

        // Prime noise floor
        repeat(5) { gate.processFrame(silence, frameSize) }

        var sawEarlyOnset = false
        repeat(10) { // 400ms voiced wake word
            val a = gate.processFrame(voiceFrame, frameSize)
            if (a.earlyOnsetDetected) sawEarlyOnset = true
        }
        assertTrue("Expected earlyOnsetDetected during voiced wake utterance", sawEarlyOnset)

        var sawCandidateReady = false
        repeat(10) { // 400ms trailing silence -> triggers candidateReady
            val a = gate.processFrame(silence, frameSize)
            if (a.candidateReady) sawCandidateReady = true
        }
        assertTrue("Expected candidateReady after wake utterance + trailing silence", sawCandidateReady)
    }

    // -------------------------------------------------------------------------
    // ISSUE 03 — UNIVERSAL VOICE-CONTROLLED APP AUTOMATION
    // -------------------------------------------------------------------------

    @Test
    fun universalUiAutomationEngineResolvesSynonymsOrdinalsAmbiguityAndBlocksSensitiveFields() {
        val nodes = listOf(
            AccessibleNodeSnapshot(
                nodeId = 1,
                className = "android.widget.FrameLayout",
                isClickable = true,
                bounds = AccessibleRect(40, 120, 480, 220)
            ),
            AccessibleNodeSnapshot(
                nodeId = 2,
                parentId = 1,
                className = "android.widget.TextView",
                text = "Settings",
                isClickable = false,
                bounds = AccessibleRect(60, 140, 300, 200)
            ),
            AccessibleNodeSnapshot(
                nodeId = 3,
                className = "android.widget.Button",
                text = "Follow",
                isClickable = true,
                bounds = AccessibleRect(700, 300, 980, 400)
            ),
            AccessibleNodeSnapshot(
                nodeId = 4,
                className = "android.widget.Button",
                text = "Follow",
                isClickable = true,
                bounds = AccessibleRect(700, 500, 980, 600)
            ),
            AccessibleNodeSnapshot(
                nodeId = 5,
                className = "android.widget.EditText",
                hintText = "Enter Password",
                isClickable = true,
                isPassword = true,
                bounds = AccessibleRect(40, 700, 1000, 820)
            )
        )

        // Bengali synonym "সেটিংস বাটন" resolves to "Settings" via clickable ancestor node 1
        val settingsRes = UniversalUiAutomationEngine.resolveTarget(nodes, "সেটিংস বাটনে")
        assertTrue(settingsRes is UniversalUiResolution.Matched)
        val matchedSettings = settingsRes as UniversalUiResolution.Matched
        assertEquals(1, matchedSettings.candidate.clickableNode?.nodeId)
        assertEquals("Settings", matchedSettings.candidate.label)

        // Two identical "Follow" buttons -> ambiguous without ordinal, exact with ordinal=2
        val ambRes = UniversalUiAutomationEngine.resolveTarget(nodes, "ফলো")
        assertTrue(ambRes is UniversalUiResolution.Ambiguous)

        val secondFollow = UniversalUiAutomationEngine.resolveTarget(nodes, "Follow", ordinalIndex = 2)
        assertTrue(secondFollow is UniversalUiResolution.Matched)
        assertEquals(4, (secondFollow as UniversalUiResolution.Matched).candidate.matchNode.nodeId)

        // Password field strictly blocked
        val pwdRes = UniversalUiAutomationEngine.resolveTarget(nodes, "Password")
        assertTrue(pwdRes is UniversalUiResolution.NotFound)
        assertEquals("sensitive_target_blocked", (pwdRes as UniversalUiResolution.NotFound).failureCode)

        // Post-click verification
        val verified = UniversalUiAutomationEngine.verifyClickOutcome(
            beforeLabels = listOf("Settings", "Follow"),
            afterNodes = listOf(AccessibleNodeSnapshot(nodeId = 9, text = "Wi-Fi & Network")),
            clickedLabel = "Settings",
            accessibilityEventObserved = true
        )
        assertTrue(verified.stateChanged)
        assertEquals("executed_verified", verified.status)
    }

    @Test
    fun commandDispatcherParsesHorizontalSwipesAndReverseOrderBengaliCalls() {
        val dispatcher = CommandDispatcher()

        val left = dispatcher.parseCommand("বামে সোয়াইপ করো")
        assertTrue(left is VoiceCommand.ScrollScreen)
        assertEquals("left", (left as VoiceCommand.ScrollScreen).direction)

        val right = dispatcher.parseCommand("Swipe right")
        assertTrue(right is VoiceCommand.ScrollScreen)
        assertEquals("right", (right as VoiceCommand.ScrollScreen).direction)

        val reverseCall = dispatcher.parseCommand("কল করো রহিমকে")
        assertTrue(reverseCall is VoiceCommand.CallContact)
        assertEquals("রহিম", (reverseCall as VoiceCommand.CallContact).contactName)
    }

    // -------------------------------------------------------------------------
    // ISSUE 04 — INTELLIGENT VISUAL RECOGNITION & PRECISION CLICKING
    // -------------------------------------------------------------------------

    @Test
    fun visualClickIntelligenceParsesVisionJsonRevalidatesTreeAndEnforcesSafetyGuards() {
        assertTrue(VisualClickIntelligenceEngine.isVisualAttributeQuery("Click the red button on top right"))
        assertTrue(VisualClickIntelligenceEngine.isVisualAttributeQuery("উপরে ডান কোণায় নীল আইকনে ক্লিক করো"))
        assertFalse(VisualClickIntelligenceEngine.isVisualAttributeQuery("Settings"))

        // Parse normalized box_2d inside markdown fence
        val fencedJson = """
            ```json
            {"found": true, "confidence": 0.91, "ambiguous": false, "label": "Blue Search Icon", "box_2d": [100, 800, 200, 900]}
            ```
        """.trimIndent()
        val parsed = VisualClickIntelligenceEngine.parseGeminiVisionTargetJson(fencedJson, 1080, 2400)
        assertTrue(parsed.found)
        assertEquals(918, parsed.x) // (0.85 * 1080)
        assertEquals(360, parsed.y) // (0.15 * 2400)

        // Revalidation prefers enclosing clickable Accessibility node over raw coordinates
        val liveTree = listOf(
            AccessibleNodeSnapshot(
                nodeId = 10,
                className = "android.widget.ImageButton",
                contentDescription = "Search",
                isClickable = true,
                bounds = AccessibleRect(860, 300, 980, 420)
            ),
            AccessibleNodeSnapshot(
                nodeId = 11,
                className = "android.widget.EditText",
                hintText = "Enter OTP",
                isClickable = true,
                isPassword = true,
                bounds = AccessibleRect(100, 1000, 900, 1150)
            )
        )
        val plan = VisualClickIntelligenceEngine.revalidateTargetAgainstAccessibilityTree(
            query = "blue search icon",
            proposal = parsed,
            liveNodes = liveTree,
            screenWidth = 1080,
            screenHeight = 2400
        )
        assertTrue(plan is VisualClickPlan.ClickAccessibilityNode)
        assertEquals(10, (plan as VisualClickPlan.ClickAccessibilityNode).clickableAncestor?.nodeId)

        // Low confidence is refused safely
        val lowConf = parsed.copy(confidence = 0.48f)
        val refused = VisualClickIntelligenceEngine.revalidateTargetAgainstAccessibilityTree(
            query = "blue icon",
            proposal = lowConf,
            liveNodes = liveTree,
            screenWidth = 1080,
            screenHeight = 2400
        )
        assertTrue(refused is VisualClickPlan.RefuseLowConfidence)

        // Overlapping password/OTP field is strictly blocked
        val onPassword = parsed.copy(x = 500, y = 1075, label = "OTP box")
        val blocked = VisualClickIntelligenceEngine.revalidateTargetAgainstAccessibilityTree(
            query = "input box",
            proposal = onPassword,
            liveNodes = liveTree,
            screenWidth = 1080,
            screenHeight = 2400
        )
        assertTrue(blocked is VisualClickPlan.BlockedSensitive)

        // Ambiguous alternatives trigger clarification instead of blind click
        val ambRaw = """
            {"found": true, "confidence": 0.82, "ambiguous": false, "label": "Top Red Button", "x": 200, "y": 200,
             "alternatives": [{"label": "Bottom Red Button", "confidence": 0.78, "x": 200, "y": 1800}]}
        """.trimIndent()
        val ambProposal = VisualClickIntelligenceEngine.parseGeminiVisionTargetJson(ambRaw, 1080, 2400)
        val clarify = VisualClickIntelligenceEngine.revalidateTargetAgainstAccessibilityTree(
            query = "red button",
            proposal = ambProposal,
            liveNodes = liveTree,
            screenWidth = 1080,
            screenHeight = 2400
        )
        assertTrue(clarify is VisualClickPlan.ClarifyAmbiguous)
        assertEquals(2, (clarify as VisualClickPlan.ClarifyAmbiguous).options.size)
    }

    // -------------------------------------------------------------------------
    // ISSUE 05 — BENGALI & ENGLISH SMART CONTACT SEARCH & CALLING
    // -------------------------------------------------------------------------

    @Test
    fun smartContactMatcherResolvesBengaliEnglishTransliterationDedupAndDisambiguation() {
        val contacts = listOf(
            ContactMatch("1", "Rahim", listOf("+8801711223344", "01711-223344")),
            ContactMatch("2", "Amit", listOf("01812345678")),
            ContactMatch("3", "Sumon", listOf("01911223344")),
            ContactMatch("4", "করিম", listOf("01611223344")),
            ContactMatch("5", "Mom", listOf("01511223344", "01599887766"))
        )

        // Bengali voice query -> English saved contact + equivalent phone deduplication
        val bnRahim = SmartContactMatcher.resolveFromContacts("রহিমকে", contacts, useDirectCall = true)
        assertTrue(bnRahim is ContactCallResolution.ReadyToCall)
        assertEquals("Rahim", (bnRahim as ContactCallResolution.ReadyToCall).name)
        assertEquals("+8801711223344", bnRahim.number)

        val bnAmit = SmartContactMatcher.resolveFromContacts("অমিত", contacts, useDirectCall = true)
        assertTrue(bnAmit is ContactCallResolution.ReadyToCall)
        assertEquals("Amit", (bnAmit as ContactCallResolution.ReadyToCall).name)

        val bnSumon = SmartContactMatcher.resolveFromContacts("সুমনকে", contacts, useDirectCall = true)
        assertTrue(bnSumon is ContactCallResolution.ReadyToCall)
        assertEquals("Sumon", (bnSumon as ContactCallResolution.ReadyToCall).name)

        // English voice query -> Bengali saved contact
        val enKarim = SmartContactMatcher.resolveFromContacts("Karim", contacts, useDirectCall = true)
        assertTrue(enKarim is ContactCallResolution.ReadyToCall)
        assertEquals("করিম", (enKarim as ContactCallResolution.ReadyToCall).name)

        // Kinship alias + multiple distinct numbers prompts number selection
        val bnMom = SmartContactMatcher.resolveFromContacts("মাকে", contacts, useDirectCall = true)
        assertTrue(bnMom is ContactCallResolution.MultipleNumbersForContact)
        assertEquals(2, (bnMom as ContactCallResolution.MultipleNumbersForContact).numbers.size)

        // Ambiguous duplicate contacts safely return MultipleMatches instead of wrong call
        val dupContacts = listOf(
            ContactMatch("10", "Rahim Office", listOf("01700000001")),
            ContactMatch("11", "Rahim Home", listOf("01700000002"))
        )
        val amb = SmartContactMatcher.resolveFromContacts("রহিম", dupContacts, useDirectCall = true)
        assertTrue(amb is ContactCallResolution.MultipleMatches)
        assertEquals(2, (amb as ContactCallResolution.MultipleMatches).candidates.size)

        // Unrelated query returns ContactNotFound
        val missing = SmartContactMatcher.resolveFromContacts("জাহানারা", contacts, useDirectCall = true)
        assertTrue(missing is ContactCallResolution.ContactNotFound)
    }
}
