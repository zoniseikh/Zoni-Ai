package com.zoni.jarvis.assistant

import com.zoni.jarvis.assistant.action.AllowedActionType
import com.zoni.jarvis.assistant.domain.CommandDispatcher
import com.zoni.jarvis.assistant.domain.VoiceCommand
import com.zoni.jarvis.assistant.service.BackgroundAssistantEvent
import com.zoni.jarvis.assistant.service.BackgroundAssistantMode
import com.zoni.jarvis.assistant.service.BackgroundCommandPolicy
import com.zoni.jarvis.assistant.service.VoiceCommandActionMapper
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * JVM unit tests verifying ZONI AI's Background Voice Assistant lifecycle,
 * voice-only Bengali wake response, zero-popup/zero-Activity-launch guarantee,
 * Continuous Command Mode state transitions, stop phrases, and CommandDispatcher integration.
 */
class BackgroundVoiceAssistantTest {

    private val dispatcher = CommandDispatcher()

    @Test
    fun wakeResponsePhraseMatchesExactBengaliRequirement() {
        assertEquals("হ্যাঁ, বলো শুনছি।", BackgroundCommandPolicy.WAKE_RESPONSE_PHRASE)
    }

    @Test
    fun wakeWordTransitionsToVoiceOnlyGreetingWithoutOpeningActivityOrPostingNotification() {
        val t1 = BackgroundCommandPolicy.reduce(
            BackgroundAssistantMode.WAKE_WORD_LISTENING,
            BackgroundAssistantEvent.WakeWordDetected()
        )
        assertEquals(BackgroundAssistantMode.WAKE_GREETING, t1.nextMode)
        assertEquals("হ্যাঁ, বলো শুনছি।", t1.spokenGreeting)
        assertFalse("MainActivity must NEVER auto-open on wake word", t1.shouldOpenActivity)
        assertFalse("Wake response notification must NEVER be posted", t1.shouldPostWakeNotification)
        assertFalse(t1.shouldStartContinuousMic)

        val t2 = BackgroundCommandPolicy.reduce(
            t1.nextMode,
            BackgroundAssistantEvent.WakeGreetingCompleted
        )
        assertEquals(BackgroundAssistantMode.CONTINUOUS_COMMAND_MODE, t2.nextMode)
        assertFalse(t2.shouldOpenActivity)
        assertFalse(t2.shouldPostWakeNotification)
        assertTrue("Continuous command mode mic must start after greeting", t2.shouldStartContinuousMic)
    }

    @Test
    fun continuousCommandModeStaysActiveAcrossConsecutiveCommandsUntilStopPhrase() {
        var mode = BackgroundAssistantMode.CONTINUOUS_COMMAND_MODE

        val afterCmd1 = BackgroundCommandPolicy.reduce(mode, BackgroundAssistantEvent.CommandCompleted)
        assertEquals(BackgroundAssistantMode.CONTINUOUS_COMMAND_MODE, afterCmd1.nextMode)
        assertTrue(afterCmd1.shouldStartContinuousMic)
        assertFalse(afterCmd1.shouldResumeWakeWord)
        assertFalse(afterCmd1.shouldOpenActivity)
        mode = afterCmd1.nextMode

        val afterGeminiTurn = BackgroundCommandPolicy.reduce(mode, BackgroundAssistantEvent.GeminiTurnCompleted)
        assertEquals(BackgroundAssistantMode.CONTINUOUS_COMMAND_MODE, afterGeminiTurn.nextMode)
        assertTrue(afterGeminiTurn.shouldStartContinuousMic)
        assertFalse(afterGeminiTurn.shouldResumeWakeWord)
        mode = afterGeminiTurn.nextMode

        val afterStop = BackgroundCommandPolicy.reduce(mode, BackgroundAssistantEvent.StopPhraseDetected)
        assertEquals(BackgroundAssistantMode.WAKE_WORD_LISTENING, afterStop.nextMode)
        assertTrue("Background Gemini Live must stop on stop phrase", afterStop.shouldStopBackgroundLive)
        assertTrue("Wake word listening must resume on stop phrase", afterStop.shouldResumeWakeWord)
        assertFalse(afterStop.shouldOpenActivity)
        assertFalse(afterStop.shouldPostWakeNotification)
    }

    @Test
    fun stopCommandModePhrasesRecognizedInBengaliEnglishAndHindi() {
        val validStops = listOf(
            "ধন্যবাদ জোনি",
            "ধন্যবাদ জোনি।",
            "অনেক ধন্যবাদ জোনি",
            "ঠিক আছে ধন্যবাদ জনি",
            "Stop Listening",
            "stop listening zoni",
            "Please stop listening",
            "Thank you Zoni",
            "শোনা বন্ধ করো",
            "কমান্ড মোড বন্ধ করো",
            "धन्यवाद ज़ोनी"
        )
        for (phrase in validStops) {
            assertTrue("Expected stop phrase to match: $phrase", BackgroundCommandPolicy.isStopCommandModePhrase(phrase))
            val parsed = dispatcher.parseCommand(phrase)
            assertTrue("CommandDispatcher must parse '$phrase' as StopCommandMode", parsed is VoiceCommand.StopCommandMode)
        }
    }

    @Test
    fun normalDeviceCommandsAreNeverMistakenForStopCommandMode() {
        val normalCommands = listOf(
            "Stop the video",
            "ভিডিওটি স্টপ করো",
            "টর্চ বন্ধ করো",
            "ইউটিউব খোলো",
            "রহিমকে কল করো",
            "Open WhatsApp",
            "Turn on flashlight"
        )
        for (cmd in normalCommands) {
            assertFalse("Command must NOT stop continuous command mode: $cmd", BackgroundCommandPolicy.isStopCommandModePhrase(cmd))
            val parsed = dispatcher.parseCommand(cmd)
            assertFalse("CommandDispatcher must NOT classify '$cmd' as StopCommandMode", parsed is VoiceCommand.StopCommandMode)
        }
    }

    @Test
    fun foregroundVoiceHandoffPausesBackgroundAndResumesWakeWordAfterward() {
        val paused = BackgroundCommandPolicy.reduce(
            BackgroundAssistantMode.CONTINUOUS_COMMAND_MODE,
            BackgroundAssistantEvent.ForegroundVoiceStarted
        )
        assertEquals(BackgroundAssistantMode.PAUSED_FOR_FOREGROUND_APP, paused.nextMode)
        assertTrue(paused.shouldStopBackgroundLive)
        assertFalse(paused.shouldOpenActivity)

        val resumed = BackgroundCommandPolicy.reduce(
            paused.nextMode,
            BackgroundAssistantEvent.ForegroundVoiceStopped
        )
        assertEquals(BackgroundAssistantMode.WAKE_WORD_LISTENING, resumed.nextMode)
        assertTrue(resumed.shouldResumeWakeWord)
        assertFalse(resumed.shouldOpenActivity)
    }

    @Test
    fun sharedVoiceCommandActionMapperCoversCoreDeviceActions() {
        val torchReq = VoiceCommandActionMapper.toTypedActionRequest(VoiceCommand.ToggleFlashlight(true))
        assertNotNull(torchReq)
        assertEquals(AllowedActionType.FLASHLIGHT_CONTROL, torchReq?.actionType)
        assertEquals("true", torchReq?.arguments?.get("enable"))

        val ytReq = VoiceCommandActionMapper.toTypedActionRequest(
            VoiceCommand.AppSearchWorkflow("YouTube", "Rabindra Sangeet")
        )
        assertNotNull(ytReq)
        assertEquals(AllowedActionType.SEARCH_YOUTUBE, ytReq?.actionType)
        assertEquals("Rabindra Sangeet", ytReq?.arguments?.get("query"))

        val webReq = VoiceCommandActionMapper.toTypedActionRequest(
            VoiceCommand.AppSearchWorkflow("Chrome", "weather Kolkata")
        )
        assertNotNull(webReq)
        assertEquals(AllowedActionType.SEARCH_WEB, webReq?.actionType)
        assertEquals("weather Kolkata", webReq?.arguments?.get("query"))

        val stopReq = VoiceCommandActionMapper.toTypedActionRequest(VoiceCommand.StopCommandMode("ধন্যবাদ জোনি"))
        assertNull("StopCommandMode is handled by lifecycle state machine, not DeviceActionExecutor", stopReq)
    }
}
