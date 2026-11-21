package com.zoni.jarvis.assistant

import com.zoni.jarvis.assistant.action.ActionProtocolValidator
import com.zoni.jarvis.assistant.action.AllowedActionType
import com.zoni.jarvis.assistant.domain.CommandDispatcher
import com.zoni.jarvis.assistant.domain.VoiceCommand
import com.zoni.jarvis.assistant.service.AccessibilityGuard
import com.zoni.jarvis.assistant.service.AccessibleNodeSnapshot
import com.zoni.jarvis.assistant.service.AccessibleRect
import com.zoni.jarvis.assistant.service.MultilingualNameMatcher
import com.zoni.jarvis.assistant.service.WhatsAppContactResolution
import com.zoni.jarvis.assistant.service.WhatsAppDeliveryState
import com.zoni.jarvis.assistant.service.WhatsAppSendButtonResolver
import com.zoni.jarvis.assistant.service.WhatsAppSendDeduplicator
import com.zoni.jarvis.assistant.service.WhatsAppSmartContactEngine
import com.zoni.jarvis.assistant.service.YouTubeClickEngine
import com.zoni.jarvis.assistant.service.YouTubeTargetResolution
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Comprehensive JVM Unit Test Suite for:
 * PART 1 — Advanced YouTube Click Engine (All 10 YouTube test cases)
 * PART 2 — WhatsApp Smart Contact & Name Click Engine + Dedicated WhatsApp Send Button Resolver + Verification (All 18 WhatsApp test cases)
 * PART 3 — Unified 8 Smart Accessibility Actions + Privacy/Safety Guards
 */
class SmartAccessibilityEngineTest {

    private val dispatcher = CommandDispatcher()

    private fun sampleYouTubeSearchTree(): List<AccessibleNodeSnapshot> = listOf(
        // Top nav / chrome (must be ignored by video candidate collector)
        AccessibleNodeSnapshot(
            nodeId = 1, parentId = null, viewIdResourceName = "com.google.android.youtube:id/search_bar",
            className = "android.widget.EditText", text = "Bengali songs", isClickable = true, isEditable = true,
            bounds = AccessibleRect(40, 60, 900, 150)
        ),
        // Sponsored ad card (must be filtered out)
        AccessibleNodeSnapshot(
            nodeId = 2, parentId = null, viewIdResourceName = "com.google.android.youtube:id/ad_card",
            className = "android.view.ViewGroup", contentDescription = "Sponsored · Best Deal", isClickable = true,
            bounds = AccessibleRect(0, 180, 1080, 420)
        ),
        // Video Card 1 (clickable parent container + non-clickable thumbnail & title children)
        AccessibleNodeSnapshot(
            nodeId = 10, parentId = null, viewIdResourceName = "com.google.android.youtube:id/video_with_context",
            className = "android.view.ViewGroup", isClickable = true,
            bounds = AccessibleRect(0, 440, 1080, 960)
        ),
        AccessibleNodeSnapshot(
            nodeId = 11, parentId = 10, viewIdResourceName = "com.google.android.youtube:id/thumbnail",
            className = "android.widget.ImageView", contentDescription = "Arijit Singh Bengali Hit Song - 4 minutes 12 seconds - 2M views",
            isClickable = false, bounds = AccessibleRect(24, 460, 1056, 820)
        ),
        AccessibleNodeSnapshot(
            nodeId = 12, parentId = 10, viewIdResourceName = "com.google.android.youtube:id/title",
            className = "android.widget.TextView", text = "Arijit Singh Bengali Hit Song",
            isClickable = false, bounds = AccessibleRect(24, 830, 1000, 910)
        ),
        // Video Card 2 (clickable parent container + non-clickable thumbnail & title children)
        AccessibleNodeSnapshot(
            nodeId = 20, parentId = null, viewIdResourceName = "com.google.android.youtube:id/video_with_context",
            className = "android.view.ViewGroup", isClickable = true,
            bounds = AccessibleRect(0, 980, 1080, 1500)
        ),
        AccessibleNodeSnapshot(
            nodeId = 21, parentId = 20, viewIdResourceName = "com.google.android.youtube:id/thumbnail",
            className = "android.widget.ImageView", contentDescription = "Rabindra Sangeet Acoustic Live - 5 minutes 30 seconds - 850K views",
            isClickable = false, bounds = AccessibleRect(24, 1000, 1056, 1360)
        ),
        AccessibleNodeSnapshot(
            nodeId = 22, parentId = 20, viewIdResourceName = "com.google.android.youtube:id/title",
            className = "android.widget.TextView", text = "Rabindra Sangeet Acoustic Live",
            isClickable = false, bounds = AccessibleRect(24, 1370, 1000, 1450)
        ),
        // Video Card 3 (another Arijit video to test ambiguity)
        AccessibleNodeSnapshot(
            nodeId = 30, parentId = null, viewIdResourceName = "com.google.android.youtube:id/video_with_context",
            className = "android.view.ViewGroup", isClickable = true,
            bounds = AccessibleRect(0, 1520, 1080, 2040)
        ),
        AccessibleNodeSnapshot(
            nodeId = 31, parentId = 30, viewIdResourceName = "com.google.android.youtube:id/thumbnail",
            className = "android.widget.ImageView", contentDescription = "Arijit Singh Unplugged Concert - 8 minutes 10 seconds - 1M views",
            isClickable = false, bounds = AccessibleRect(24, 1540, 1056, 1900)
        ),
        AccessibleNodeSnapshot(
            nodeId = 32, parentId = 30, viewIdResourceName = "com.google.android.youtube:id/title",
            className = "android.widget.TextView", text = "Arijit Singh Unplugged Concert",
            isClickable = false, bounds = AccessibleRect(24, 1910, 1000, 1990)
        )
    )

    private fun sampleWhatsAppChatListTree(): List<AccessibleNodeSnapshot> = listOf(
        // Top toolbar & search (must NOT be treated as contact rows)
        AccessibleNodeSnapshot(
            nodeId = 1, parentId = null, viewIdResourceName = "com.whatsapp:id/toolbar",
            className = "android.widget.TextView", text = "WhatsApp", isClickable = false,
            bounds = AccessibleRect(32, 60, 400, 140)
        ),
        // Row 1: Rahul Sharma
        AccessibleNodeSnapshot(
            nodeId = 10, parentId = null, viewIdResourceName = "com.whatsapp:id/contact_row_container",
            className = "android.widget.RelativeLayout", isClickable = true,
            bounds = AccessibleRect(0, 220, 1080, 400)
        ),
        AccessibleNodeSnapshot(
            nodeId = 11, parentId = 10, viewIdResourceName = "com.whatsapp:id/conversations_row_contact_name",
            className = "android.widget.TextView", text = "Rahul Sharma", isClickable = false,
            bounds = AccessibleRect(180, 240, 760, 300)
        ),
        AccessibleNodeSnapshot(
            nodeId = 12, parentId = 10, viewIdResourceName = "com.whatsapp:id/single_msg_tv",
            className = "android.widget.TextView", text = "See you soon", isClickable = false,
            bounds = AccessibleRect(180, 310, 760, 360)
        ),
        // Row 2: Mom (Ma)
        AccessibleNodeSnapshot(
            nodeId = 20, parentId = null, viewIdResourceName = "com.whatsapp:id/contact_row_container",
            className = "android.widget.RelativeLayout", isClickable = true,
            bounds = AccessibleRect(0, 410, 1080, 590)
        ),
        AccessibleNodeSnapshot(
            nodeId = 21, parentId = 20, viewIdResourceName = "com.whatsapp:id/conversations_row_contact_name",
            className = "android.widget.TextView", text = "Mom", isClickable = false,
            bounds = AccessibleRect(180, 430, 760, 490)
        ),
        // Row 3: Jahida Akter
        AccessibleNodeSnapshot(
            nodeId = 30, parentId = null, viewIdResourceName = "com.whatsapp:id/contact_row_container",
            className = "android.widget.RelativeLayout", isClickable = true,
            bounds = AccessibleRect(0, 600, 1080, 780)
        ),
        AccessibleNodeSnapshot(
            nodeId = 31, parentId = 30, viewIdResourceName = "com.whatsapp:id/conversations_row_contact_name",
            className = "android.widget.TextView", text = "Jahida Akter", isClickable = false,
            bounds = AccessibleRect(180, 620, 760, 680)
        ),
        // Row 4: Baba
        AccessibleNodeSnapshot(
            nodeId = 40, parentId = null, viewIdResourceName = "com.whatsapp:id/contact_row_container",
            className = "android.widget.RelativeLayout", isClickable = true,
            bounds = AccessibleRect(0, 790, 1080, 970)
        ),
        AccessibleNodeSnapshot(
            nodeId = 41, parentId = 40, viewIdResourceName = "com.whatsapp:id/conversations_row_contact_name",
            className = "android.widget.TextView", text = "Baba", isClickable = false,
            bounds = AccessibleRect(180, 810, 760, 870)
        )
    )

    // ========================================================================
    // PART 1 — ALL 10 YOUTUBE TEST CASES
    // ========================================================================

    @Test
    fun yt01_and_yt02_openYouTubeAndSearchCommandsRouteCleanly() {
        val openBn = dispatcher.parseCommand("ইউটিউব খোলো")
        assertTrue(openBn is VoiceCommand.OpenApp)
        assertEquals("ইউটিউব", (openBn as VoiceCommand.OpenApp).appQuery)

        val searchBn = dispatcher.parseCommand("ইউটিউবে গান খুঁজে দাও।")
        assertTrue(searchBn is VoiceCommand.AppSearchWorkflow)
        assertEquals("YouTube", (searchBn as VoiceCommand.AppSearchWorkflow).appQuery)
        assertEquals("গান", searchBn.searchQuery)

        val searchEn = dispatcher.parseCommand("Search Bengali songs on YouTube")
        assertTrue(searchEn is VoiceCommand.AppSearchWorkflow)
        assertEquals("YouTube", (searchEn as VoiceCommand.AppSearchWorkflow).appQuery)
    }

    @Test
    fun yt03_and_yt04_clickFirstAndSecondVideoResolvesClickableParentAndBounds() {
        // Command parsing in Bengali, English & Hindi
        val c1Bn = dispatcher.parseCommand("প্রথম ভিডিওটি চালাও।")
        assertTrue(c1Bn is VoiceCommand.ClickYouTubeVideo)
        assertEquals(1, (c1Bn as VoiceCommand.ClickYouTubeVideo).index)

        val c2Bn = dispatcher.parseCommand("দ্বিতীয় ভিডিওতে ক্লিক করো।")
        assertTrue(c2Bn is VoiceCommand.ClickYouTubeVideo)
        assertEquals(2, (c2Bn as VoiceCommand.ClickYouTubeVideo).index)

        val c1En = dispatcher.parseCommand("Play the first video")
        assertTrue(c1En is VoiceCommand.ClickYouTubeVideo)
        assertEquals(1, (c1En as VoiceCommand.ClickYouTubeVideo).index)

        val c2Hi = dispatcher.parseCommand("दूसरे वीडियो पर क्लिक करो")
        assertTrue(c2Hi is VoiceCommand.ClickYouTubeVideo)
        assertEquals(2, (c2Hi as VoiceCommand.ClickYouTubeVideo).index)

        // Engine resolves clickable parent container (node 10 & node 20) from non-clickable children
        val tree = sampleYouTubeSearchTree()
        val res1 = YouTubeClickEngine.resolveVideoTarget(tree, index = 1)
        assertTrue(res1 is YouTubeTargetResolution.Matched)
        val cand1 = (res1 as YouTubeTargetResolution.Matched).candidate
        assertEquals(10, cand1.clickableNode?.nodeId)
        assertTrue(cand1.title.contains("Arijit Singh Bengali Hit Song"))
        assertTrue(cand1.bounds.isValidVisible)

        val res2 = YouTubeClickEngine.resolveVideoTarget(tree, index = 2)
        assertTrue(res2 is YouTubeTargetResolution.Matched)
        val cand2 = (res2 as YouTubeTargetResolution.Matched).candidate
        assertEquals(20, cand2.clickableNode?.nodeId)
        assertTrue(cand2.title.contains("Rabindra Sangeet"))
    }

    @Test
    fun yt05_and_yt06_and_yt07_playButtonThumbnailAndFirstSearchResult() {
        // 5. Play Button click
        val playCmdBn = dispatcher.parseCommand("Play Button চাপো।")
        assertTrue(playCmdBn is VoiceCommand.ClickYouTubeVideo)
        assertEquals("play_button", (playCmdBn as VoiceCommand.ClickYouTubeVideo).targetHint)

        val playCmdEn = dispatcher.parseCommand("Click the Play button")
        assertTrue(playCmdEn is VoiceCommand.ClickYouTubeVideo)
        assertEquals("play_button", (playCmdEn as VoiceCommand.ClickYouTubeVideo).targetHint)

        val playerNodes = listOf(
            AccessibleNodeSnapshot(
                nodeId = 100, parentId = null, viewIdResourceName = "com.google.android.youtube:id/player_control_play_pause_replay_button",
                className = "android.widget.ImageView", contentDescription = "Play video",
                isClickable = true, bounds = AccessibleRect(460, 260, 620, 420)
            )
        )
        val playRes = YouTubeClickEngine.resolveVideoTarget(playerNodes, targetHint = "play_button")
        assertTrue(playRes is YouTubeTargetResolution.Matched)
        assertTrue((playRes as YouTubeTargetResolution.Matched).candidate.isPlayButton)

        // 6. Thumbnail click
        val thumbCmd = dispatcher.parseCommand("এই ভিডিওর Thumbnail-এ ক্লিক করো।")
        assertTrue(thumbCmd is VoiceCommand.ClickYouTubeVideo)
        assertEquals("thumbnail", (thumbCmd as VoiceCommand.ClickYouTubeVideo).targetHint)

        val thumbRes = YouTubeClickEngine.resolveVideoTarget(sampleYouTubeSearchTree(), index = 1, targetHint = "thumbnail")
        assertTrue(thumbRes is YouTubeTargetResolution.Matched)
        assertTrue((thumbRes as YouTubeTargetResolution.Matched).candidate.isThumbnail)

        // 7. First search result click
        val srCmdBn = dispatcher.parseCommand("প্রথম সার্চ রেজাল্টে ক্লিক করো।")
        assertTrue(srCmdBn is VoiceCommand.ClickYouTubeSearchResult)
        assertEquals(1, (srCmdBn as VoiceCommand.ClickYouTubeSearchResult).index)

        val srCmdEn = dispatcher.parseCommand("Open the first search result")
        assertTrue(srCmdEn is VoiceCommand.ClickYouTubeSearchResult)
        assertEquals(1, (srCmdEn as VoiceCommand.ClickYouTubeSearchResult).index)
    }

    @Test
    fun yt08_yt09_yt10_scrollAmbiguousMissingAndWatchVerification() {
        val tree = sampleYouTubeSearchTree()

        // 8. Scroll then select 3rd visible video
        val scrollCmd = dispatcher.parseCommand("নিচে স্ক্রল করো।")
        assertTrue(scrollCmd is VoiceCommand.ScrollScreen)
        val res3 = YouTubeClickEngine.resolveVideoTarget(tree, index = 3)
        assertTrue(res3 is YouTubeTargetResolution.Matched)
        assertEquals(30, (res3 as YouTubeTargetResolution.Matched).candidate.clickableNode?.nodeId)

        // 9. Ambiguous video target ("Arijit" matches 2 cards) MUST return Ambiguous (never guess!)
        val ambig = YouTubeClickEngine.resolveVideoTarget(tree, titleQuery = "Arijit")
        assertTrue(ambig is YouTubeTargetResolution.Ambiguous)
        assertEquals(2, (ambig as YouTubeTargetResolution.Ambiguous).candidates.size)

        // 10. Missing / out-of-range element reports honest NotFound
        val missingIdx = YouTubeClickEngine.resolveVideoTarget(tree, index = 7)
        assertTrue(missingIdx is YouTubeTargetResolution.NotFound)
        assertEquals("video_index_out_of_range", (missingIdx as YouTubeTargetResolution.NotFound).failureCode)

        val missingPlay = YouTubeClickEngine.resolveVideoTarget(tree, targetHint = "play_button")
        assertTrue(missingPlay is YouTubeTargetResolution.NotFound)
        assertEquals("play_button_not_found", (missingPlay as YouTubeTargetResolution.NotFound).failureCode)

        // Watch screen verification: confirms true ONLY when watch controls or transition evidence exists
        val watchNodes = listOf(
            AccessibleNodeSnapshot(
                nodeId = 500, viewIdResourceName = "com.google.android.youtube:id/watch_player",
                contentDescription = "Pause video", bounds = AccessibleRect(0, 80, 1080, 680)
            ),
            AccessibleNodeSnapshot(
                nodeId = 501, text = "Arijit Singh Bengali Hit Song", bounds = AccessibleRect(24, 700, 1000, 780)
            )
        )
        val verified = YouTubeClickEngine.verifyWatchScreenOpened(
            beforeLabels = listOf("Bengali songs", "Arijit Singh Bengali Hit Song", "Rabindra Sangeet Acoustic Live"),
            afterNodes = watchNodes,
            clickedTitle = "Arijit Singh Bengali Hit Song",
            activePackage = "com.google.android.youtube",
            accessibilityEventObserved = true
        )
        assertTrue(verified.openedWatchScreen)
        assertEquals("youtube_video_opened", verified.status)

        // Unchanged screen with no event -> honestly unverified
        val unverified = YouTubeClickEngine.verifyWatchScreenOpened(
            beforeLabels = listOf("Bengali songs", "Arijit Singh Bengali Hit Song"),
            afterNodes = listOf(
                AccessibleNodeSnapshot(nodeId = 1, text = "Bengali songs", bounds = AccessibleRect(0, 0, 100, 50)),
                AccessibleNodeSnapshot(nodeId = 2, text = "Arijit Singh Bengali Hit Song", bounds = AccessibleRect(0, 100, 100, 150))
            ),
            clickedTitle = "Arijit Singh Bengali Hit Song",
            activePackage = "com.google.android.youtube",
            accessibilityEventObserved = false
        )
        assertFalse(unverified.openedWatchScreen)
        assertEquals("youtube_click_unverified", unverified.status)
    }

    // ========================================================================
    // PART 2 — ALL 18 WHATSAPP TEST CASES
    // ========================================================================

    @Test
    fun wa01_to_wa06_openWhatsAppFindMultilingualContactClickNameAndVerifyChatOpened() {
        // 1. Open WhatsApp
        val openWa = dispatcher.parseCommand("WhatsApp খোলো")
        assertTrue(openWa is VoiceCommand.OpenApp)

        // 2-5. Bengali, English & Hindi contact/chat click commands
        val bnClick = dispatcher.parseCommand("WhatsApp-এ রাহুলের নামের উপর ক্লিক করো।")
        assertTrue(bnClick is VoiceCommand.ClickWhatsAppContact)
        assertEquals("রাহুল", (bnClick as VoiceCommand.ClickWhatsAppContact).contactName)

        val bnMa = dispatcher.parseCommand("মায়ের Chat ওপেন করো।")
        assertTrue(bnMa is VoiceCommand.OpenWhatsAppChat)
        assertEquals("মা", (bnMa as VoiceCommand.OpenWhatsAppChat).contactName)

        val bnJahida = dispatcher.parseCommand("জাহিদার Chat খুলে দাও।")
        assertTrue(bnJahida is VoiceCommand.OpenWhatsAppChat)
        assertEquals("জাহিদা", (bnJahida as VoiceCommand.OpenWhatsAppChat).contactName)

        val enClick = dispatcher.parseCommand("Click Rahul's name in WhatsApp")
        assertTrue(enClick is VoiceCommand.ClickWhatsAppContact)
        assertEquals("Rahul", (enClick as VoiceCommand.ClickWhatsAppContact).contactName)

        val hiClick = dispatcher.parseCommand("WhatsApp में राहुल के नाम पर क्लिक करो")
        assertTrue(hiClick is VoiceCommand.ClickWhatsAppContact)
        assertEquals("राहुल", (hiClick as VoiceCommand.ClickWhatsAppContact).contactName)

        val hiMa = dispatcher.parseCommand("मेरी माँ की चैट खोलो")
        assertTrue(hiMa is VoiceCommand.OpenWhatsAppChat)
        assertEquals("माँ", (hiMa as VoiceCommand.OpenWhatsAppChat).contactName)

        val ordContact = dispatcher.parseCommand("নিচের দ্বিতীয় নামটিতে ক্লিক করো।")
        assertTrue(ordContact is VoiceCommand.ClickWhatsAppContact)
        assertEquals(2, (ordContact as VoiceCommand.ClickWhatsAppContact).index)

        // Engine matches cross-script Bengali/Hindi names to English WhatsApp rows & resolves clickable row container
        val chatList = sampleWhatsAppChatListTree()

        val matchRahulBn = WhatsAppSmartContactEngine.resolveContactTarget(chatList, contactQuery = "রাহুলের")
        assertTrue(matchRahulBn is WhatsAppContactResolution.Matched)
        assertEquals("Rahul Sharma", (matchRahulBn as WhatsAppContactResolution.Matched).candidate.displayName)
        assertEquals(10, matchRahulBn.candidate.clickableNode?.nodeId)

        val matchRahulHi = WhatsAppSmartContactEngine.resolveContactTarget(chatList, contactQuery = "राहुल")
        assertTrue(matchRahulHi is WhatsAppContactResolution.Matched)
        assertEquals("Rahul Sharma", (matchRahulHi as WhatsAppContactResolution.Matched).candidate.displayName)

        val matchMaBn = WhatsAppSmartContactEngine.resolveContactTarget(chatList, contactQuery = "মায়ের")
        assertTrue(matchMaBn is WhatsAppContactResolution.Matched)
        assertEquals("Mom", (matchMaBn as WhatsAppContactResolution.Matched).candidate.displayName)
        assertEquals(20, matchMaBn.candidate.clickableNode?.nodeId)

        val matchJahidaBn = WhatsAppSmartContactEngine.resolveContactTarget(chatList, contactQuery = "জাহিদার")
        assertTrue(matchJahidaBn is WhatsAppContactResolution.Matched)
        assertEquals("Jahida Akter", (matchJahidaBn as WhatsAppContactResolution.Matched).candidate.displayName)

        val matchSecond = WhatsAppSmartContactEngine.resolveContactTarget(chatList, ordinalIndex = 2)
        assertTrue(matchSecond is WhatsAppContactResolution.Matched)
        assertEquals("Mom", (matchSecond as WhatsAppContactResolution.Matched).candidate.displayName)

        // Verify conversation screen actually opened (header + composer)
        val openConversationNodes = listOf(
            AccessibleNodeSnapshot(
                nodeId = 1, viewIdResourceName = "com.whatsapp:id/conversation_contact_name",
                text = "Rahul Sharma", bounds = AccessibleRect(140, 80, 620, 150)
            ),
            AccessibleNodeSnapshot(
                nodeId = 2, viewIdResourceName = "com.whatsapp:id/entry",
                className = "android.widget.EditText", hintText = "Message", isEditable = true,
                bounds = AccessibleRect(100, 1920, 880, 2040)
            )
        )
        assertTrue(
            WhatsAppSmartContactEngine.verifyConversationOpened(
                afterNodes = openConversationNodes,
                expectedName = "রাহুল",
                expectedPhone = "",
                activePackage = "com.whatsapp"
            )
        )
        assertFalse(
            WhatsAppSmartContactEngine.verifyConversationOpened(
                afterNodes = openConversationNodes,
                expectedName = "Jahida",
                expectedPhone = "",
                activePackage = "com.whatsapp"
            )
        )
    }

    @Test
    fun wa07_multipleIdenticalOrAmbiguousContactsMustStopAndAsk() {
        val ambiguousList = listOf(
            AccessibleNodeSnapshot(
                nodeId = 10, viewIdResourceName = "com.whatsapp:id/contact_row_container",
                isClickable = true, bounds = AccessibleRect(0, 220, 1080, 400)
            ),
            AccessibleNodeSnapshot(
                nodeId = 11, parentId = 10, viewIdResourceName = "com.whatsapp:id/conversations_row_contact_name",
                text = "Rahul Das", bounds = AccessibleRect(180, 240, 760, 300)
            ),
            AccessibleNodeSnapshot(
                nodeId = 20, viewIdResourceName = "com.whatsapp:id/contact_row_container",
                isClickable = true, bounds = AccessibleRect(0, 410, 1080, 590)
            ),
            AccessibleNodeSnapshot(
                nodeId = 21, parentId = 20, viewIdResourceName = "com.whatsapp:id/conversations_row_contact_name",
                text = "Rahul Roy", bounds = AccessibleRect(180, 430, 760, 490)
            )
        )
        val res = WhatsAppSmartContactEngine.resolveContactTarget(ambiguousList, contactQuery = "রাহুল")
        assertTrue("Multiple matching contacts MUST return Ambiguous", res is WhatsAppContactResolution.Ambiguous)
        assertEquals(2, (res as WhatsAppContactResolution.Ambiguous).candidates.size)
    }

    @Test
    fun wa08_to_wa14_sendButtonResolverRejectsMicMatchesLocalizedLabelsAndSeparatesTypeVsSend() {
        val composerBounds = AccessibleRect(110, 1920, 890, 2050)

        // Case A: Only Voice Note / Mic / Camera / Attach buttons visible -> MUST return null (NEVER tap mic!)
        val micOnlyNodes = listOf(
            AccessibleNodeSnapshot(
                nodeId = 1, viewIdResourceName = "com.whatsapp:id/entry",
                className = "android.widget.EditText", text = "", isEditable = true, bounds = composerBounds
            ),
            AccessibleNodeSnapshot(
                nodeId = 2, viewIdResourceName = "com.whatsapp:id/voice_note_btn",
                className = "android.widget.ImageButton", contentDescription = "Voice message",
                isClickable = true, bounds = AccessibleRect(910, 1920, 1050, 2050)
            ),
            AccessibleNodeSnapshot(
                nodeId = 3, viewIdResourceName = "com.whatsapp:id/camera_btn",
                className = "android.widget.ImageButton", contentDescription = "Camera",
                isClickable = true, bounds = AccessibleRect(780, 1920, 880, 2050)
            ),
            AccessibleNodeSnapshot(
                nodeId = 4, viewIdResourceName = "com.whatsapp:id/input_attach_button",
                className = "android.widget.ImageButton", contentDescription = "Attach",
                isClickable = true, bounds = AccessibleRect(680, 1920, 770, 2050)
            )
        )
        assertNull(WhatsAppSendButtonResolver.resolveSendButton(micOnlyNodes, composerBounds))

        // Case B: Localized Bengali "পাঠান" Send button with custom/obfuscated viewId & clickable parent
        val bengaliSendNodes = listOf(
            AccessibleNodeSnapshot(
                nodeId = 10, viewIdResourceName = "com.whatsapp:id/action_wrapper",
                className = "android.widget.FrameLayout", isClickable = true,
                bounds = AccessibleRect(910, 1920, 1050, 2050)
            ),
            AccessibleNodeSnapshot(
                nodeId = 11, parentId = 10, viewIdResourceName = "com.whatsapp:id/obfuscated_icon_42",
                className = "android.widget.ImageView", contentDescription = "পাঠান",
                isClickable = false, bounds = AccessibleRect(930, 1940, 1030, 2030)
            )
        )
        val bnMatch = WhatsAppSendButtonResolver.resolveSendButton(bengaliSendNodes, composerBounds)
        assertNotNull(bnMatch)
        assertEquals(10, bnMatch!!.clickableNode?.nodeId)
        assertTrue(bnMatch.matchedBy.contains("exact_send_label"))
        assertTrue(bnMatch.matchedBy.contains("clickable_parent"))

        // Case C: Localized Hindi "संदेश भेजें" Send button
        val hindiSendNodes = listOf(
            AccessibleNodeSnapshot(
                nodeId = 20, viewIdResourceName = "com.whatsapp:id/send_btn",
                className = "android.widget.ImageButton", contentDescription = "संदेश भेजें",
                isClickable = true, bounds = AccessibleRect(910, 1920, 1050, 2050)
            )
        )
        val hiMatch = WhatsAppSendButtonResolver.resolveSendButton(hindiSendNodes, composerBounds)
        assertNotNull(hiMatch)
        assertEquals(20, hiMatch!!.clickableNode?.nodeId)

        // Case D: Disabled or invisible Send button MUST be rejected
        val disabledSendNodes = listOf(
            AccessibleNodeSnapshot(
                nodeId = 30, viewIdResourceName = "com.whatsapp:id/send",
                className = "android.widget.ImageButton", contentDescription = "Send",
                isClickable = true, isEnabled = false, isVisibleToUser = true,
                bounds = AccessibleRect(910, 1920, 1050, 2050)
            )
        )
        assertNull(WhatsAppSendButtonResolver.resolveSendButton(disabledSendNodes, composerBounds))

        // Case E: Explicit validation of Bengali/English/Hindi message text preservation + Type vs Send action separation
        val (typeReq, typeErr) = ActionProtocolValidator.validate(
            "type_whatsapp_message",
            mapOf("message" to "আমি আসছি")
        )
        assertNull(typeErr)
        assertEquals(AllowedActionType.TYPE_WHATSAPP_MESSAGE, typeReq!!.actionType)
        assertEquals("আমি আসছি", typeReq.arguments["message"])

        val (sendReq, sendErr) = ActionProtocolValidator.validate(
            "send_whatsapp_message",
            mapOf("recipient" to "রাহুল", "message" to "আমি আসছি")
        )
        assertNull(sendErr)
        assertEquals(AllowedActionType.SEND_WHATSAPP_MESSAGE, sendReq!!.actionType)
        assertEquals("আমি আসছি", sendReq.arguments["message"])
    }

    @Test
    fun wa15_to_wa18_postSendVerificationDistinguishesStatesDuplicatePreventionAndPrivacyGuard() {
        // 15a. Delivered tick explicitly visible -> DELIVERED
        val deliveredNodes = listOf(
            AccessibleNodeSnapshot(nodeId = 100, className = "android.widget.LinearLayout", bounds = AccessibleRect(200, 1500, 1040, 1650)),
            AccessibleNodeSnapshot(nodeId = 101, parentId = 100, text = "আমি আসছি", bounds = AccessibleRect(220, 1520, 900, 1600)),
            AccessibleNodeSnapshot(nodeId = 102, parentId = 100, viewIdResourceName = "com.whatsapp:id/status", contentDescription = "Delivered", bounds = AccessibleRect(940, 1580, 1010, 1630))
        )
        val repDelivered = WhatsAppSendButtonResolver.verifyPostSendState(deliveredNodes, composerText = "", expectedMessage = "আমি আসছি")
        assertTrue(repDelivered.verified)
        assertEquals(WhatsAppDeliveryState.DELIVERED, repDelivered.state)

        // 15b. Single Sent tick visible -> SENT (does NOT claim delivered)
        val sentNodes = listOf(
            AccessibleNodeSnapshot(nodeId = 100, className = "android.widget.LinearLayout", bounds = AccessibleRect(200, 1500, 1040, 1650)),
            AccessibleNodeSnapshot(nodeId = 101, parentId = 100, text = "On my way", bounds = AccessibleRect(220, 1520, 900, 1600)),
            AccessibleNodeSnapshot(nodeId = 102, parentId = 100, viewIdResourceName = "com.whatsapp:id/status", contentDescription = "Sent", bounds = AccessibleRect(940, 1580, 1010, 1630))
        )
        val repSent = WhatsAppSendButtonResolver.verifyPostSendState(sentNodes, composerText = "", expectedMessage = "On my way")
        assertTrue(repSent.verified)
        assertEquals(WhatsAppDeliveryState.SENT, repSent.state)

        // 15c. Pending/Clock icon visible -> PENDING
        val pendingNodes = listOf(
            AccessibleNodeSnapshot(nodeId = 100, className = "android.widget.LinearLayout", bounds = AccessibleRect(200, 1500, 1040, 1650)),
            AccessibleNodeSnapshot(nodeId = 101, parentId = 100, text = "मैं आ रहा हूँ", bounds = AccessibleRect(220, 1520, 900, 1600)),
            AccessibleNodeSnapshot(nodeId = 102, parentId = 100, viewIdResourceName = "com.whatsapp:id/status", contentDescription = "Pending", bounds = AccessibleRect(940, 1580, 1010, 1630))
        )
        val repPending = WhatsAppSendButtonResolver.verifyPostSendState(pendingNodes, composerText = "", expectedMessage = "मैं आ रहा हूँ")
        assertTrue(repPending.verified)
        assertEquals(WhatsAppDeliveryState.PENDING, repPending.state)

        // 15d. Bubble visible & composer cleared without tick exposure -> SENT_BUBBLE_VISIBLE
        val bubbleOnlyNodes = listOf(
            AccessibleNodeSnapshot(nodeId = 101, text = "আমি আসছি", bounds = AccessibleRect(220, 1520, 900, 1600))
        )
        val repBubble = WhatsAppSendButtonResolver.verifyPostSendState(bubbleOnlyNodes, composerText = "", expectedMessage = "আমি আসছি")
        assertTrue(repBubble.verified)
        assertEquals(WhatsAppDeliveryState.SENT_BUBBLE_VISIBLE, repBubble.state)

        // 16. Composer NOT cleared (Send failed or button unavailable) -> UNVERIFIED
        val repNotCleared = WhatsAppSendButtonResolver.verifyPostSendState(bubbleOnlyNodes, composerText = "আমি আসছি", expectedMessage = "আমি আসছি")
        assertFalse(repNotCleared.verified)
        assertEquals(WhatsAppDeliveryState.UNVERIFIED, repNotCleared.state)

        // 17. Duplicate send prevention
        WhatsAppSendDeduplicator.resetForTests()
        assertTrue(WhatsAppSendDeduplicator.tryAcquireDirectSend("whatsapp", "Rahul", "আমি আসছি", nowMs = 2000L))
        assertFalse(WhatsAppSendDeduplicator.tryAcquireDirectSend("whatsapp", "Rahul", "আমি আসছি", nowMs = 3500L))

        // 18. Inaccessible / password / banking UI strictly blocked
        assertTrue(AccessibilityGuard.isProtectedPackage("com.bkash.customerapp"))
        assertTrue(AccessibilityGuard.isProtectedPackage("com.google.android.apps.nbu.paisa.user"))
        val passwordSendNode = listOf(
            AccessibleNodeSnapshot(
                nodeId = 1, viewIdResourceName = "com.whatsapp:id/send",
                contentDescription = "Send", isClickable = true, isPassword = true,
                bounds = AccessibleRect(910, 1920, 1050, 2050)
            )
        )
        assertNull(WhatsAppSendButtonResolver.resolveSendButton(passwordSendNode))
        assertEquals("রাহুল", MultilingualNameMatcher.cleanPersonQuery("রাহুলের"))
        assertEquals("মা", MultilingualNameMatcher.cleanPersonQuery("মায়ের"))
        assertEquals("জাহিদা", MultilingualNameMatcher.cleanPersonQuery("জাহিদার"))
        // Verify both NFC and NFD Bengali nukta characters (ড়/ড়, ঢ়/ঢ়, য়/য়) transliterate cleanly
        assertEquals(
            MultilingualNameMatcher.toPhoneticLatin("মায়া"),
            MultilingualNameMatcher.toPhoneticLatin("মায়া")
        )
        assertEquals("maya", MultilingualNameMatcher.toPhoneticLatin("মায়া"))
        assertEquals("bari", MultilingualNameMatcher.toPhoneticLatin("বাড়ি"))
    }
}
