package com.zoni.jarvis.assistant

import android.media.AudioManager
import com.zoni.jarvis.assistant.db.ConversationEntity
import com.zoni.jarvis.assistant.db.DecryptedMemoryRecord
import com.zoni.jarvis.assistant.db.LocalMemoryLogic
import com.zoni.jarvis.assistant.domain.CommandDispatcher
import com.zoni.jarvis.assistant.domain.VoiceCommand
import com.zoni.jarvis.assistant.network.NetworkQualityPolicy
import com.zoni.jarvis.assistant.network.NetworkQualityState
import com.zoni.jarvis.assistant.service.AccessibleNodeSnapshot
import com.zoni.jarvis.assistant.service.AccessibleRect
import com.zoni.jarvis.assistant.service.VisualClickIntelligenceEngine
import com.zoni.jarvis.assistant.service.VisualClickPlan
import com.zoni.jarvis.assistant.service.VisualScreenFingerprintCache
import com.zoni.jarvis.assistant.service.VisualTargetProposal
import com.zoni.jarvis.assistant.wakeword.VoiceLifecycleState
import com.zoni.jarvis.assistant.wakeword.WakeWordLifecycleGuard
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure JVM unit tests covering the six targeted Zoni AI upgrades:
 * 1. Background Wake Word lifecycle/dedup/call-yield/backoff
 * 2. Universal Accessibility & Spatial Clicking
 * 3. Visual Recognition Accessibility-first & unchanged-screen fingerprint cache
 * 4. Local Conversation Memory privacy filter, extraction, offline recall & compact context
 * 5. WhatsApp Bengali word-order parsing
 * 6. Low-Internet NetworkQualityPolicy & audio backpressure
 */
class MasterSixUpgradesTest {

    // --- Issue 01: Background Wake Word ---

    @Test
    fun wakeWordGuard_blocksDuplicateTriggersAndActiveVoiceSession() {
        assertTrue(
            WakeWordLifecycleGuard.shouldAcceptWakeTrigger(
                currentState = VoiceLifecycleState.WAKE_WORD_LISTENING,
                lastAcceptedAtMs = 1_000L,
                nowMs = 5_000L,
                cooldownMs = 2_500L
            )
        )
        assertFalse(
            WakeWordLifecycleGuard.shouldAcceptWakeTrigger(
                currentState = VoiceLifecycleState.WAKE_WORD_LISTENING,
                lastAcceptedAtMs = 4_000L,
                nowMs = 5_000L,
                cooldownMs = 2_500L
            )
        )
        assertFalse(
            WakeWordLifecycleGuard.shouldAcceptWakeTrigger(
                currentState = VoiceLifecycleState.LISTENING,
                lastAcceptedAtMs = 0L,
                nowMs = 10_000L
            )
        )
        assertTrue(WakeWordLifecycleGuard.isTelecomAudioModeBusy(AudioManager.MODE_IN_CALL))
        assertTrue(WakeWordLifecycleGuard.isTelecomAudioModeBusy(AudioManager.MODE_IN_COMMUNICATION))
        assertFalse(WakeWordLifecycleGuard.isTelecomAudioModeBusy(AudioManager.MODE_NORMAL))
        assertEquals(600L, WakeWordLifecycleGuard.computeMicRecoveryBackoffMs(0))
        assertEquals(6000L, WakeWordLifecycleGuard.computeMicRecoveryBackoffMs(10))
    }

    // --- Issue 02 & 03: Accessibility-first Spatial Clicking & Visual Fingerprint Cache ---

    @Test
    fun spatialAccessibilityResolver_resolvesRightButtonAndImageWithoutScreenshot() {
        val leftBtn = AccessibleNodeSnapshot(
            nodeId = 1,
            parentId = null,
            viewIdResourceName = "com.demo:id/btn_cancel",
            className = "android.widget.Button",
            text = "Cancel",
            contentDescription = null,
            hintText = null,
            isClickable = true,
            isEnabled = true,
            isVisibleToUser = true,
            isEditable = false,
            isPassword = false,
            bounds = AccessibleRect(40, 1800, 320, 1940)
        )
        val rightBtn = AccessibleNodeSnapshot(
            nodeId = 2,
            parentId = null,
            viewIdResourceName = "com.demo:id/btn_next",
            className = "android.widget.Button",
            text = "Next",
            contentDescription = null,
            hintText = null,
            isClickable = true,
            isEnabled = true,
            isVisibleToUser = true,
            isEditable = false,
            isPassword = false,
            bounds = AccessibleRect(760, 1800, 1040, 1940)
        )
        val photoNode = AccessibleNodeSnapshot(
            nodeId = 3,
            parentId = null,
            viewIdResourceName = "com.demo:id/photo_item",
            className = "android.widget.ImageView",
            text = null,
            contentDescription = "Sunset photo",
            hintText = null,
            isClickable = true,
            isEnabled = true,
            isVisibleToUser = true,
            isEditable = false,
            isPassword = false,
            bounds = AccessibleRect(120, 420, 960, 1180)
        )

        val rightPlan = VisualClickIntelligenceEngine.resolveSpatialAccessibilityTarget(
            nodes = listOf(leftBtn, rightBtn, photoNode),
            rawQuery = "ডান পাশের বাটন",
            screenWidth = 1080,
            screenHeight = 2400
        )
        assertTrue(rightPlan is VisualClickPlan.ClickAccessibilityNode)
        assertEquals(2, (rightPlan as VisualClickPlan.ClickAccessibilityNode).matchNode.nodeId)

        val imgPlan = VisualClickIntelligenceEngine.resolveSpatialAccessibilityTarget(
            nodes = listOf(leftBtn, rightBtn, photoNode),
            rawQuery = "এই ছবিটা",
            screenWidth = 1080,
            screenHeight = 2400
        )
        assertTrue(imgPlan is VisualClickPlan.ClickAccessibilityNode)
        assertEquals(3, (imgPlan as VisualClickPlan.ClickAccessibilityNode).matchNode.nodeId)

        // Color queries must defer to real Vision pixels rather than guessing
        val colorPlan = VisualClickIntelligenceEngine.resolveSpatialAccessibilityTarget(
            nodes = listOf(leftBtn, rightBtn),
            rawQuery = "red button",
            screenWidth = 1080,
            screenHeight = 2400
        )
        assertNull(colorPlan)
    }

    @Test
    fun visualFingerprintCache_reusesProposalOnUnchangedScreenAndExpires() {
        VisualScreenFingerprintCache.clearForTests()
        val fp = VisualScreenFingerprintCache.buildScreenFingerprint(
            activePackage = "com.demo.app",
            lastWindowStateChangeMs = 1000L,
            lastWindowContentChangeMs = 2000L,
            visibleLabels = listOf("Home", "Red Button")
        )
        val proposal = VisualTargetProposal(
            found = true,
            x = 800,
            y = 1200,
            confidence = 0.92f,
            label = "Red Button",
            ambiguous = false
        )
        VisualScreenFingerprintCache.put(fp, "red button", proposal, nowMs = 5_000L)
        assertNotNull(VisualScreenFingerprintCache.get(fp, "red button", nowMs = 10_000L))
        assertNull(VisualScreenFingerprintCache.get(fp, "red button", nowMs = 20_000L))
    }

    // --- Issue 04: Local Conversation Memory ---

    @Test
    fun localMemoryLogic_blocksSecretsAndRecallsOfflineCompactly() {
        assertTrue(LocalMemoryLogic.containsSensitiveSecret("My OTP is 492011"))
        assertTrue(LocalMemoryLogic.containsSensitiveSecret("আমার বিকাশ পিন 12345"))
        assertTrue(LocalMemoryLogic.containsSensitiveSecret("AIzaSyA1234567890abcdefXYZ"))
        assertNull(LocalMemoryLogic.sanitizeForStorage("password: mySecret123"))

        val extracted = LocalMemoryLogic.extractUserMemories("আমার নাম করিম।")
        assertTrue(extracted.any { it.factKey == "user_name" && it.value == "করিম" })

        val memories = listOf(
            DecryptedMemoryRecord(
                id = "m1",
                category = LocalMemoryLogic.CATEGORY_PERSONAL_FACT,
                factKey = "user_name",
                value = "করিম",
                searchKeywords = "name নাম করিম",
                usageCount = 3,
                userApproved = true,
                createdAtMs = 1000L,
                updatedAtMs = 2000L
            )
        )
        val history = listOf(
            ConversationEntity("c1", "user", "আজ বিকেলে বাজার করব", "bn-BD", 3000L)
        )

        val recall = LocalMemoryLogic.answerMemoryRecallLocally("আমার নাম কী?", memories, history, "bn-BD")
        assertTrue(recall.handledOffline)
        assertTrue(recall.replyText.contains("করিম"))

        val compact = LocalMemoryLogic.buildCompactContextForGemini("হ্যালো", memories, history)
        assertTrue(compact.length <= LocalMemoryLogic.MAX_COMPACT_CONTEXT_CHARS)
        assertTrue(compact.contains("করিম"))
    }

    // --- Issue 05: Bengali WhatsApp-First Phrasing & Image Open ---

    @Test
    fun commandDispatcher_parsesBengaliWhatsAppFirstAndImageOpenCommands() {
        val dispatcher = CommandDispatcher()

        val wa = dispatcher.parseCommand("জোনি, WhatsApp-এ রহিমকে মেসেজ পাঠাও: আমি আজ বিকেলে আসব।")
        assertTrue(wa is VoiceCommand.PrepareWhatsAppMessage)
        val waCmd = wa as VoiceCommand.PrepareWhatsAppMessage
        assertEquals("রহিম", waCmd.recipient)
        assertEquals("আমি আজ বিকেলে আসব", waCmd.message)

        val img = dispatcher.parseCommand("এই ছবিটা ওপেন করো")
        assertTrue(img is VoiceCommand.TapVisibleElement)

        val rightBtn = dispatcher.parseCommand("জোনি, ডান পাশের বাটনে ক্লিক করো")
        assertTrue(rightBtn is VoiceCommand.TapVisibleElement)
        assertTrue((rightBtn as VoiceCommand.TapVisibleElement).targetLabel.contains("ডান পাশের"))
    }

    // --- Issue 06: Low-Internet Network Policy ---

    @Test
    fun networkQualityPolicy_classifiesOfflineWeakStrongAndBackpressure() {
        assertEquals(
            NetworkQualityState.OFFLINE,
            NetworkQualityPolicy.classify(hasInternet = false, isValidated = false, downstreamKbps = 0, isMetered = true)
        )
        assertEquals(
            NetworkQualityState.WEAK,
            NetworkQualityPolicy.classify(hasInternet = true, isValidated = true, downstreamKbps = 600, isMetered = true)
        )
        assertEquals(
            NetworkQualityState.STRONG,
            NetworkQualityPolicy.classify(hasInternet = true, isValidated = true, downstreamKbps = 25_000, isMetered = false)
        )
        assertTrue(NetworkQualityPolicy.shouldDropAudioChunkForBackpressure(70_000L, NetworkQualityState.WEAK))
        assertFalse(NetworkQualityPolicy.shouldDropAudioChunkForBackpressure(70_000L, NetworkQualityState.STRONG))
        assertTrue(NetworkQualityPolicy.shouldDropAudioChunkForBackpressure(10L, NetworkQualityState.OFFLINE))
    }
}
