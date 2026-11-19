package com.zoni.jarvis.assistant

import com.zoni.jarvis.assistant.domain.CommandDispatcher
import com.zoni.jarvis.assistant.domain.VoiceCommand
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CommandDispatcherTest {

    private val dispatcher = CommandDispatcher()

    @Test
    fun testFlashlightCommands() {
        val onCommands = listOf(
            "Flashlight on",
            "Turn on flashlight",
            "Turn on the flashlight",
            "Torch on",
            "টর্চ লাইট জ্বালাও",
            "টর্চ জ্বালিয়ে দাও",
            "ফ্ল্যাশলাইট অন করো",
            "ফ্ল্যাশ লাইট জ্বালাও",
            "লাইট অন করো"
        )
        for (cmd in onCommands) {
            val result = dispatcher.parseCommand(cmd)
            assertEquals("Expected $cmd to parse as ToggleFlashlight(enable = true)", VoiceCommand.ToggleFlashlight(enable = true), result)
        }

        val offCommands = listOf(
            "Flashlight off",
            "Turn off flashlight",
            "Turn off the flashlight",
            "Torch off",
            "টর্চ লাইট বন্ধ করো",
            "টর্চ বন্ধ করে দাও",
            "ফ্ল্যাশলাইট অফ করো",
            "ফ্ল্যাশ লাইট বন্ধ করো",
            "লাইট অফ করো"
        )
        for (cmd in offCommands) {
            val result = dispatcher.parseCommand(cmd)
            assertEquals("Expected $cmd to parse as ToggleFlashlight(enable = false)", VoiceCommand.ToggleFlashlight(enable = false), result)
        }
    }

    @Test
    fun testFlashlightNegativeQueries() {
        val negativeQueries = listOf(
            "The sun gives light",
            "traffic light",
            "লাইট নিয়ে একটা কবিতা বলো"
        )
        for (query in negativeQueries) {
            val result = dispatcher.parseCommand(query)
            assertTrue("Expected '$query' NOT to be ToggleFlashlight, was $result", result !is VoiceCommand.ToggleFlashlight)
        }
    }

    @Test
    fun testAppLaunchCommands() {
        val bengaliApp = dispatcher.parseCommand("YouTube খোলো")
        assertTrue(bengaliApp is VoiceCommand.OpenApp)
        assertEquals("YouTube", (bengaliApp as VoiceCommand.OpenApp).appQuery)

        val englishApp = dispatcher.parseCommand("Open WhatsApp")
        assertTrue(englishApp is VoiceCommand.OpenApp)
        assertEquals("WhatsApp", (englishApp as VoiceCommand.OpenApp).appQuery)
    }

    @Test
    fun testDirectNumberCallCommands() {
        val bengaliNumberCall = dispatcher.parseCommand("৯৮৭৬৫৪৩২১০ নম্বরে কল করো")
        assertTrue(bengaliNumberCall is VoiceCommand.CallDirectNumber)
        assertEquals("+919876543210", (bengaliNumberCall as VoiceCommand.CallDirectNumber).phoneNumber)

        val englishNumberCall = dispatcher.parseCommand("Call 9876543210")
        assertTrue(englishNumberCall is VoiceCommand.CallDirectNumber)
        assertEquals("+919876543210", (englishNumberCall as VoiceCommand.CallDirectNumber).phoneNumber)
    }

    @Test
    fun testContactCallCommands() {
        val bengaliContact = dispatcher.parseCommand("রাহুলকে ফোন করো")
        assertTrue(bengaliContact is VoiceCommand.CallContact)
        assertEquals("রাহুল", (bengaliContact as VoiceCommand.CallContact).contactName)

        val englishContact = dispatcher.parseCommand("Call Rahul")
        assertTrue(englishContact is VoiceCommand.CallContact)
        assertEquals("Rahul", (englishContact as VoiceCommand.CallContact).contactName)
    }

    @Test
    fun testScreenQuery() {
        val query = dispatcher.parseCommand("আমার স্ক্রিনে কী লেখা আছে?")
        assertTrue(query is VoiceCommand.ScreenQuery)
    }

    @Test
    fun testDuplicateSuppression() {
        val cmd = "টর্চ লাইট জ্বালাও"
        val firstCheck = dispatcher.isDuplicateCallback(cmd)
        assertEquals(false, firstCheck)

        val duplicateCheck = dispatcher.isDuplicateCallback(cmd)
        assertEquals(true, duplicateCheck)
    }
}
