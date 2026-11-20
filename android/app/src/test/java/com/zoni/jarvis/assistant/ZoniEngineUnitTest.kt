package com.zoni.jarvis.assistant

import com.zoni.jarvis.assistant.calling.ActiveSimCallState
import com.zoni.jarvis.assistant.db.CallSessionEntity
import com.zoni.jarvis.assistant.db.UserPreferencesEntity
import com.zoni.jarvis.assistant.domain.ActionType
import com.zoni.jarvis.assistant.domain.BengaliDateTimeEngine
import com.zoni.jarvis.assistant.domain.MobileAssistantEngine
import com.zoni.jarvis.assistant.domain.NumberNormalizer
import com.zoni.jarvis.assistant.domain.NumberNormalizerResult
import com.zoni.jarvis.assistant.domain.SupportedLanguage
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ZoniEngineUnitTest {

    @Test
    fun bengaliDateTimeEngineDetectsTimeDateWeekday() {
        assertEquals(
            BengaliDateTimeEngine.DateTimeQueryType.TIME,
            BengaliDateTimeEngine.detectDateTimeQuery("এখন কয়টা বাজে?")
        )
        assertEquals(
            BengaliDateTimeEngine.DateTimeQueryType.DATE,
            BengaliDateTimeEngine.detectDateTimeQuery("আজ কত তারিখ?")
        )
        assertEquals(
            BengaliDateTimeEngine.DateTimeQueryType.WEEKDAY,
            BengaliDateTimeEngine.detectDateTimeQuery("আজ কী বার?")
        )
        assertNull(BengaliDateTimeEngine.detectDateTimeQuery("তোমার নাম কী?"))
    }

    @Test
    fun bengaliDigitsAndDaypartsWorkCorrectly() {
        assertEquals("২০২৬", BengaliDateTimeEngine.toBengaliDigits("2026"))
        assertEquals("সকাল", BengaliDateTimeEngine.getBengaliDaypart(9))
        assertEquals("দুপুর", BengaliDateTimeEngine.getBengaliDaypart(13))
        assertEquals("রাত", BengaliDateTimeEngine.getBengaliDaypart(22))
    }

    @Test
    fun flashlightCommandsRespectPositiveAndNegativeCases() {
        assertTrue(MobileAssistantEngine.isFlashlightOnCommand("টর্চ লাইট জ্বালাও"))
        assertTrue(MobileAssistantEngine.isFlashlightOnCommand("torch on"))
        assertTrue(MobileAssistantEngine.isFlashlightOffCommand("ফ্ল্যাশলাইট অফ করো"))
        assertTrue(MobileAssistantEngine.isFlashlightOffCommand("turn off flashlight"))
        assertFalse(MobileAssistantEngine.isFlashlightOnCommand("what is speed of light"))
        assertFalse(MobileAssistantEngine.isFlashlightOffCommand("traffic light"))
    }

    @Test
    fun phoneNumberNormalizerHandlesBengaliIndianAndBangladeshNumbers() {
        val bd = NumberNormalizer.normalizePhoneNumber("০১৭১২৩৪৫৬৭৮")
        assertTrue(bd is NumberNormalizerResult.ValidCandidate)
        assertEquals("+8801712345678", (bd as NumberNormalizerResult.ValidCandidate).normalizedNumber)

        val india = NumberNormalizer.normalizePhoneNumber("987 654 3210")
        assertTrue(india is NumberNormalizerResult.ValidCandidate)
        assertEquals("+919876543210", (india as NumberNormalizerResult.ValidCandidate).normalizedNumber)
    }

    @Test
    fun languageSwitchAndActionTagExtractionWork() {
        val hi = MobileAssistantEngine.detectLanguageSwitchCommand("হিন্দিতে কথা বলো", "Jaan")
        assertNotNull(hi)
        assertEquals(SupportedLanguage.HINDI, hi?.lang)

        val (clean, action) = MobileAssistantEngine.extractActionTagFromText("কল করছি Boss [ACTION:CALL:01712345678]")
        assertEquals("কল করছি Boss", clean)
        assertEquals(ActionType.CALL, action?.type)
        assertEquals("01712345678", action?.target)
    }

    @Test
    fun simTelecomAndRoomPrivacyDefaultsAreEnforced() {
        val simState = ActiveSimCallState()
        assertFalse(simState.isActive)
        assertTrue(simState.note.contains("Android OS"))

        val prefs = UserPreferencesEntity()
        assertTrue(prefs.callRecordingDefaultOff)

        val session = CallSessionEntity(
            id = "sim_1",
            channel = "sim",
            direction = "outgoing",
            targetName = "Clinic",
            phoneNumber = "+8801712345678",
            purpose = "Direct Android SIM call",
            language = "bn-BD",
            state = "active",
            provider = "android_sim_telecom"
        )
        assertEquals("sim", session.channel)
        assertFalse(session.recordingEnabled)
    }

    @Test
    fun autoReplyRuleMatcherEnforcesMasterToggleAndFilters() {
        val rules = listOf(
            com.zoni.jarvis.assistant.service.AutoReplyRule(
                id = "r1",
                enabled = true,
                keyword = "busy",
                senderFilter = "rahul",
                replyText = "I am in a meeting, will call back soon.",
                whatsappOnly = true
            )
        )

        // Master switch OFF -> never triggers
        assertNull(
            com.zoni.jarvis.assistant.service.AutoReplyRuleMatcher.findMatchingRule(
                rules = rules,
                masterEnabled = false,
                sender = "Rahul Sharma",
                messageText = "Are you busy?",
                isWhatsApp = true
            )
        )

        // Non-WhatsApp message with whatsappOnly=true -> skipped
        assertNull(
            com.zoni.jarvis.assistant.service.AutoReplyRuleMatcher.findMatchingRule(
                rules = rules,
                masterEnabled = true,
                sender = "Rahul Sharma",
                messageText = "Are you busy?",
                isWhatsApp = false
            )
        )

        // Exact match when master switch ON -> returns rule
        val matched = com.zoni.jarvis.assistant.service.AutoReplyRuleMatcher.findMatchingRule(
            rules = rules,
            masterEnabled = true,
            sender = "Rahul Sharma",
            messageText = "Are you busy right now?",
            isWhatsApp = true
        )
        assertNotNull(matched)
        assertEquals("r1", matched?.id)
    }
}
