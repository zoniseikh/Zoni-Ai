package com.zoni.jarvis.assistant

import com.zoni.jarvis.assistant.action.ActionProtocolValidator
import com.zoni.jarvis.assistant.action.AllowedActionType
import com.zoni.jarvis.assistant.device.AppLaunchResult
import com.zoni.jarvis.assistant.device.AppNameResolver
import com.zoni.jarvis.assistant.device.InstalledAppInfo
import com.zoni.jarvis.assistant.domain.CommandDispatcher
import com.zoni.jarvis.assistant.domain.VoiceCommand
import com.zoni.jarvis.assistant.service.AccessibilityGuard
import com.zoni.jarvis.assistant.service.AppChatAdapterRegistry
import com.zoni.jarvis.assistant.service.WhatsAppAutomationValidator
import com.zoni.jarvis.assistant.service.WhatsAppSendDeduplicator
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure JVM unit tests covering Categories A-E of the Zoni AI Android Personal Assistant Upgrade:
 * A. App Launching (AppNameResolver multilingual aliases, fuzzy match, disambiguation, uninstalled)
 * B. Accessibility & Privacy Guards (banking/UPI/bKash/Nagad/password-manager/OTP protection)
 * C. Communication & Confirmation Protocol (WhatsApp/SMS/Call confirmation enforcement)
 * D. Typed 20-Tool Allowlist Validation & Security Blocking
 * E. Bengali/English/Hindi Voice Command Dispatching & Ordinary Conversation Non-Misclassification
 */
class AssistantUpgradeUnitTest {

    private val dispatcher = CommandDispatcher()

    private val sampleInstalledApps = listOf(
        InstalledAppInfo("WhatsApp", "com.whatsapp"),
        InstalledAppInfo("YouTube", "com.google.android.youtube"),
        InstalledAppInfo("Chrome", "com.android.chrome"),
        InstalledAppInfo("Facebook", "com.facebook.katana"),
        InstalledAppInfo("Instagram", "com.instagram.android"),
        InstalledAppInfo("Settings", "com.android.settings"),
        InstalledAppInfo("Calculator", "com.google.android.calculator"),
        InstalledAppInfo("Google Photos", "com.google.android.apps.photos"),
        InstalledAppInfo("Google Maps", "com.google.android.apps.maps")
    )

    @Test
    fun categoryA_multilingualAppResolutionMatchesBengaliEnglishHindi() {
        val ytBn = AppNameResolver.resolveMatchingApps("ইউটিউব", sampleInstalledApps)
        assertTrue(ytBn is AppLaunchResult.Success)
        assertEquals("com.google.android.youtube", (ytBn as AppLaunchResult.Success).packageName)

        val waBn = AppNameResolver.resolveMatchingApps("হোয়াটসঅ্যাপ", sampleInstalledApps)
        assertTrue(waBn is AppLaunchResult.Success)
        assertEquals("com.whatsapp", (waBn as AppLaunchResult.Success).packageName)

        val chromeHi = AppNameResolver.resolveMatchingApps("क्रोम", sampleInstalledApps)
        assertTrue(chromeHi is AppLaunchResult.Success)
        assertEquals("com.android.chrome", (chromeHi as AppLaunchResult.Success).packageName)

        val calcBn = AppNameResolver.resolveMatchingApps("ক্যালকুলেটর", sampleInstalledApps)
        assertTrue(calcBn is AppLaunchResult.Success)
        assertEquals("com.google.android.calculator", (calcBn as AppLaunchResult.Success).packageName)

        // Bengali clitics & conversational phrasing
        val fbClitic = AppNameResolver.resolveMatchingApps("ফেসবুকটা", sampleInstalledApps)
        assertTrue(fbClitic is AppLaunchResult.Success)
        assertEquals("com.facebook.katana", (fbClitic as AppLaunchResult.Success).packageName)

        val chromePhrase = AppNameResolver.resolveMatchingApps("আমার ফোনে থাকা Chrome", sampleInstalledApps)
        assertTrue(chromePhrase is AppLaunchResult.Success)
        assertEquals("com.android.chrome", (chromePhrase as AppLaunchResult.Success).packageName)
    }

    @Test
    fun categoryA_fuzzyMatchDisambiguationAndUninstalledAppReporting() {
        // Typo fuzzy match ("WhtsApp" -> WhatsApp)
        val fuzzy = AppNameResolver.resolveMatchingApps("WhtsApp", sampleInstalledApps)
        assertTrue(fuzzy is AppLaunchResult.Success)
        assertEquals("com.whatsapp", (fuzzy as AppLaunchResult.Success).packageName)

        // Multiple matches disambiguation ("Google" matches Google Photos & Google Maps)
        val ambiguous = AppNameResolver.resolveMatchingApps("Google", sampleInstalledApps)
        assertTrue(ambiguous is AppLaunchResult.MultipleMatches)
        assertEquals(2, (ambiguous as AppLaunchResult.MultipleMatches).candidates.size)

        // Uninstalled app returns AppNotFound honestly
        val missing = AppNameResolver.resolveMatchingApps("Spotify", sampleInstalledApps)
        assertTrue(missing is AppLaunchResult.AppNotFound)
        assertEquals("Spotify", (missing as AppLaunchResult.AppNotFound).query)
    }

    @Test
    fun categoryB_accessibilityGuardBlocksBankingUpiPasswordsAndOtps() {
        // Protected banking, UPI, wallet & password manager packages
        assertTrue(AccessibilityGuard.isProtectedPackage("com.google.android.apps.nbu.paisa.user"))
        assertTrue(AccessibilityGuard.isProtectedPackage("com.phonepe.app"))
        assertTrue(AccessibilityGuard.isProtectedPackage("net.one97.paytm"))
        assertTrue(AccessibilityGuard.isProtectedPackage("com.bkash.customerapp"))
        assertTrue(AccessibilityGuard.isProtectedPackage("com.konasl.nagad"))
        assertTrue(AccessibilityGuard.isProtectedPackage("com.x8bit.bitwarden"))
        assertTrue(AccessibilityGuard.isProtectedPackage("com.sbi.lotusintouch"))

        // Normal everyday apps are allowed
        assertFalse(AccessibilityGuard.isProtectedPackage("com.google.android.youtube"))
        assertFalse(AccessibilityGuard.isProtectedPackage("com.whatsapp"))
        assertFalse(AccessibilityGuard.isProtectedPackage("com.android.settings"))

        // Sensitive screen labels & password/PIN hints blocked
        assertTrue(AccessibilityGuard.isSensitiveScreenContent(listOf("Enter UPI PIN", "Proceed")))
        assertTrue(AccessibilityGuard.isSensitiveScreenContent(listOf("পাসওয়ার্ড দিন", "লগইন")))
        assertFalse(AccessibilityGuard.isSensitiveScreenContent(listOf("YouTube", "Search", "Trending")))

        assertTrue(AccessibilityGuard.isSensitiveInputHint("Enter Password"))
        assertTrue(AccessibilityGuard.isSensitiveInputHint("OTP Code"))
        assertFalse(AccessibilityGuard.isSensitiveInputHint("Search YouTube"))

        // OTP redaction never leaks numeric verification codes
        assertTrue(AccessibilityGuard.containsOtpOrSecret("Your OTP is 482910 for login"))
        val redacted = AccessibilityGuard.redactSensitiveText("Your OTP is 482910 for login")
        assertFalse(redacted.contains("482910"))
        assertTrue(redacted.contains("[REDACTED]"))
    }

    @Test
    fun categoryCD_actionProtocolAllowlistAndConfirmationEnforcement() {
        assertEquals(36, AllowedActionType.entries.size)
        assertEquals(AllowedActionType.CONTACT_SEARCH, AllowedActionType.fromToolName("search_contacts"))
        assertEquals(AllowedActionType.FLASHLIGHT_CONTROL, AllowedActionType.fromToolName("set_flashlight"))
        assertEquals(AllowedActionType.PREPARE_APP_CHAT_MESSAGE, AllowedActionType.fromToolName("prepare_app_chat_message"))
        assertEquals(AllowedActionType.SEARCH_YOUTUBE, AllowedActionType.fromToolName("search_youtube"))
        assertEquals(AllowedActionType.CANCEL_CURRENT_TASK, AllowedActionType.fromToolName("cancel_current_task"))
        assertEquals(AllowedActionType.CLICK_YOUTUBE_VIDEO, AllowedActionType.fromToolName("click_youtube_video"))
        assertEquals(AllowedActionType.CLICK_YOUTUBE_SEARCH_RESULT, AllowedActionType.fromToolName("click_youtube_search_result"))
        assertEquals(AllowedActionType.CLICK_VISIBLE_ELEMENT, AllowedActionType.fromToolName("click_visible_element"))
        assertEquals(AllowedActionType.CLICK_WHATSAPP_CONTACT, AllowedActionType.fromToolName("click_whatsapp_contact"))
        assertEquals(AllowedActionType.OPEN_WHATSAPP_CHAT, AllowedActionType.fromToolName("open_whatsapp_chat"))
        assertEquals(AllowedActionType.TYPE_WHATSAPP_MESSAGE, AllowedActionType.fromToolName("type_whatsapp_message"))
        assertEquals(AllowedActionType.SEND_WHATSAPP_MESSAGE, AllowedActionType.fromToolName("send_whatsapp_message"))
        assertEquals(AllowedActionType.VERIFY_WHATSAPP_SEND, AllowedActionType.fromToolName("verify_whatsapp_send"))
        assertEquals(AllowedActionType.ANSWER_INCOMING_CALL, AllowedActionType.fromToolName("answer_incoming_call"))
        assertEquals(AllowedActionType.REJECT_INCOMING_CALL, AllowedActionType.fromToolName("reject_incoming_call"))
        assertEquals(AllowedActionType.END_ACTIVE_CALL, AllowedActionType.fromToolName("end_active_call"))

        // Explicit communication actions execute directly without routine confirmation gates
        val (waReq, waErr) = ActionProtocolValidator.validate(
            "prepare_whatsapp_message",
            mapOf("recipient" to "রাহুল", "message" to "আমি আসছি")
        )
        assertNull(waErr)
        assertNotNull(waReq)
        assertFalse(waReq!!.requiresConfirmation)
        assertEquals("আমি আসছি", waReq.arguments["message"])

        val (callReq, callErr) = ActionProtocolValidator.validate(
            "call_contact",
            mapOf("recipient" to "মা")
        )
        assertNull(callErr)
        assertFalse(callReq!!.requiresConfirmation)

        val (smsReq, smsErr) = ActionProtocolValidator.validate(
            "prepare_sms",
            mapOf("recipient" to "বাবা", "message" to "আমি বাড়ি ফিরছি")
        )
        assertNull(smsErr)
        assertFalse(smsReq!!.requiresConfirmation)
        assertEquals("আমি বাড়ি ফিরছি", smsReq.arguments["message"])

        val (appChatReq, appChatErr) = ActionProtocolValidator.validate(
            "prepare_app_chat_message",
            mapOf("app_name" to "Telegram", "recipient" to "Rahul", "message" to "On my way")
        )
        assertNull(appChatErr)
        assertNotNull(appChatReq)
        assertFalse(appChatReq!!.requiresConfirmation)

        // Disallowed tools & shell/JS injection payloads strictly blocked
        val (shellReq, shellErr) = ActionProtocolValidator.validate("exec_shell", mapOf("cmd" to "ls"))
        assertNull(shellReq)
        assertNotNull(shellErr)
        assertEquals("blocked", shellErr!!.status)

        val (injectReq, injectErr) = ActionProtocolValidator.validate(
            "enter_text_in_visible_field",
            mapOf("text" to "rm -rf / && bash -c id")
        )
        assertNull(injectReq)
        assertNotNull(injectErr)
        assertEquals("blocked", injectErr!!.status)
    }

    @Test
    fun categoryE_bengaliCommandsAndOrdinaryConversationRouting() {
        // 1. "জনি, WhatsApp খোলো।"
        val c1 = dispatcher.parseCommand("জনি, WhatsApp খোলো।")
        assertTrue("Expected OpenApp, got $c1", c1 is VoiceCommand.OpenApp)
        assertEquals("WhatsApp", (c1 as VoiceCommand.OpenApp).appQuery)

        // 2. "আমার মাকে ফোন করো।"
        val c2 = dispatcher.parseCommand("আমার মাকে ফোন করো।")
        assertTrue("Expected CallContact, got $c2", c2 is VoiceCommand.CallContact)
        assertEquals("মা", (c2 as VoiceCommand.CallContact).contactName)

        // 3. "ইউটিউবে গান খুঁজে দাও।"
        val c3 = dispatcher.parseCommand("ইউটিউবে গান খুঁজে দাও।")
        assertTrue("Expected AppSearchWorkflow, got $c3", c3 is VoiceCommand.AppSearchWorkflow)
        assertEquals("YouTube", (c3 as VoiceCommand.AppSearchWorkflow).appQuery)
        assertEquals("গান", c3.searchQuery)

        // 4. "ফোনের সেটিংস খোলো।"
        val c4 = dispatcher.parseCommand("ফোনের সেটিংস খোলো।")
        assertTrue("Expected OpenSettings, got $c4", c4 is VoiceCommand.OpenSettings)

        // 5. "নিচে স্ক্রল করো।"
        val c5 = dispatcher.parseCommand("নিচে স্ক্রল করো।")
        assertTrue("Expected ScrollScreen, got $c5", c5 is VoiceCommand.ScrollScreen)
        assertEquals("down", (c5 as VoiceCommand.ScrollScreen).direction)

        // 6. "এই স্ক্রিনে কী আছে পড়ে শোনাও।"
        val c6 = dispatcher.parseCommand("এই স্ক্রিনে কী আছে পড়ে শোনাও।")
        assertTrue("Expected ScreenQuery, got $c6", c6 is VoiceCommand.ScreenQuery)

        // 7. "রাহুলকে WhatsApp-এ মেসেজ পাঠাও: আমি আজ আসতে পারব না।"
        val c7 = dispatcher.parseCommand("রাহুলকে WhatsApp-এ মেসেজ পাঠাও: আমি আজ আসতে পারব না।")
        assertTrue("Expected PrepareWhatsAppMessage, got $c7", c7 is VoiceCommand.PrepareWhatsAppMessage)
        assertEquals("রাহুল", (c7 as VoiceCommand.PrepareWhatsAppMessage).recipient)
        assertEquals("আমি আজ আসতে পারব না", c7.message)

        // 7b. "বাবাকে SMS পাঠাও: আমি বাড়ি ফিরছি"
        val c7Sms = dispatcher.parseCommand("বাবাকে SMS পাঠাও: আমি বাড়ি ফিরছি")
        assertTrue("Expected SendSms, got $c7Sms", c7Sms is VoiceCommand.SendSms)
        assertEquals("বাবা", (c7Sms as VoiceCommand.SendSms).recipient)
        assertEquals("আমি বাড়ি ফিরছি", c7Sms.message)

        val c7SmsEn = dispatcher.parseCommand("Send an SMS to Baba saying I am coming home")
        assertTrue("Expected SendSms, got $c7SmsEn", c7SmsEn is VoiceCommand.SendSms)
        assertEquals("Baba", (c7SmsEn as VoiceCommand.SendSms).recipient)
        assertEquals("I am coming home", c7SmsEn.message)

        // 8. "মেসেজটা পাঠানোর আগে আমাকে দেখাও।"
        val c8 = dispatcher.parseCommand("মেসেজটা পাঠানোর আগে আমাকে দেখাও।")
        assertTrue("Expected ReviewPendingDraft, got $c8", c8 is VoiceCommand.ReviewPendingDraft)

        // 9. "এখন পাঠানোর অনুমতি দিলাম।"
        val c9 = dispatcher.parseCommand("এখন পাঠানোর অনুমতি দিলাম।")
        assertTrue("Expected ApprovePendingAction, got $c9", c9 is VoiceCommand.ApprovePendingAction)

        // 10. "এখন আগের কাজটা বন্ধ করো।"
        val c10 = dispatcher.parseCommand("এখন আগের কাজটা বন্ধ করো।")
        assertTrue("Expected CancelCurrentTask, got $c10", c10 is VoiceCommand.CancelCurrentTask)

        // Ordinary Bengali conversation MUST NOT be misclassified as device actions
        val ordinaryChats = listOf(
            "তুমি কেমন আছো?",
            "আজকের দিনটা কেমন?",
            "আমাকে একটা গল্প বলো।"
        )
        for (chat in ordinaryChats) {
            val parsed = dispatcher.parseCommand(chat)
            assertTrue("Expected GeminiGeneralQuery for '$chat', got $parsed", parsed is VoiceCommand.GeminiGeneralQuery)
        }
    }

    @Test
    fun categoryF_whatsAppAutomationValidatorAndDuplicateSendPrevention() {
        WhatsAppSendDeduplicator.resetForTests()

        // Package check allows only WhatsApp / WhatsApp Business
        assertTrue(WhatsAppAutomationValidator.isWhatsAppPackage("com.whatsapp"))
        assertTrue(WhatsAppAutomationValidator.isWhatsAppPackage("com.whatsapp.w4b"))
        assertFalse(WhatsAppAutomationValidator.isWhatsAppPackage("com.bkash.customerapp"))

        // Send button semantic matching (resource ID + English/Bengali/Hindi labels + visible/enabled enforcement)
        assertTrue(WhatsAppAutomationValidator.isSendButtonNode("com.whatsapp:id/send", null, null, true, true))
        assertTrue(WhatsAppAutomationValidator.isSendButtonNode(null, "Send", null, true, true))
        assertTrue(WhatsAppAutomationValidator.isSendButtonNode(null, "পাঠান", null, true, true))
        assertTrue(WhatsAppAutomationValidator.isSendButtonNode(null, "भेजें", null, true, true))
        assertFalse(WhatsAppAutomationValidator.isSendButtonNode("com.whatsapp:id/send", "Send", null, false, true))
        assertFalse(WhatsAppAutomationValidator.isSendButtonNode("com.whatsapp:id/send", "Send", null, true, false))

        // Recipient header verification
        assertTrue(
            WhatsAppAutomationValidator.matchesExpectedRecipient(
                listOf("Navigate up", "Rahul Sharma", "online", "Type a message"),
                "Rahul",
                "+919876543210"
            )
        )
        assertFalse(
            WhatsAppAutomationValidator.matchesExpectedRecipient(
                listOf("Navigate up", "Amit Das", "online"),
                "Rahul",
                "+919876543210"
            )
        )

        // Outgoing message verification requires visible chat bubble AND cleared composer
        assertTrue(
            WhatsAppAutomationValidator.verifyOutgoingMessageVisible(
                listOf("Rahul", "আমি আজ আসতে পারব না", "10:15 AM"),
                "",
                "আমি আজ আসতে পারব না"
            )
        )
        assertFalse(
            WhatsAppAutomationValidator.verifyOutgoingMessageVisible(
                listOf("Rahul", "আমি আজ আসতে পারব না"),
                "আমি আজ আসতে পারব না",
                "আমি আজ আসতে পারব না"
            )
        )

        // Composer strict match validation before Send
        assertTrue(
            WhatsAppAutomationValidator.composerMatchesApprovedMessage(
                "আমি আজ আসতে পারব না",
                "আমি আজ আসতে পারব না"
            )
        )
        assertFalse(
            WhatsAppAutomationValidator.composerMatchesApprovedMessage(
                "wrong text",
                "আমি আজ আসতে পারব না"
            )
        )
        assertFalse(
            WhatsAppAutomationValidator.composerMatchesApprovedMessage(
                "",
                "আমি আজ আসতে পারব না"
            )
        )

        // Duplicate send prevention via idempotency token
        assertTrue(WhatsAppSendDeduplicator.tryAcquire("pend_wa_001"))
        assertFalse(WhatsAppSendDeduplicator.tryAcquire("pend_wa_001"))
        WhatsAppSendDeduplicator.release("pend_wa_001")
        assertTrue(WhatsAppSendDeduplicator.tryAcquire("pend_wa_001"))

        // Short-window direct send duplicate prevention across rapid triggers (WhatsApp & SMS)
        assertTrue(WhatsAppSendDeduplicator.tryAcquireDirectSend("whatsapp", "+8801712345678", "আমি আসছি", nowMs = 1000L))
        assertFalse(WhatsAppSendDeduplicator.tryAcquireDirectSend("whatsapp", "+8801712345678", "আমি আসছি", nowMs = 4000L))
        // Different channel or different message allowed immediately
        assertTrue(WhatsAppSendDeduplicator.tryAcquireDirectSend("sms", "+8801712345678", "আমি আসছি", nowMs = 4000L))
        assertTrue(WhatsAppSendDeduplicator.tryAcquireDirectSend("whatsapp", "+8801712345678", "পৌঁছে গেছি", nowMs = 4000L))
        // Allowed again after deduplication window expires
        assertTrue(WhatsAppSendDeduplicator.tryAcquireDirectSend("whatsapp", "+8801712345678", "আমি আসছি", nowMs = 10_500L))
    }

    @Test
    fun categoryE_genericAppChatAdapterRegistrySupportsOnlyVerifiedApps() {
        val tg = AppChatAdapterRegistry.findAdapter("Telegram")
        assertNotNull(tg)
        assertEquals("Telegram", tg!!.appName)
        assertTrue(tg.packageNames.contains("org.telegram.messenger"))
        assertTrue(tg.matchesPackage("org.telegram.messenger"))

        val tgBn = AppChatAdapterRegistry.findAdapter("টেলিগ্রাম")
        assertNotNull(tgBn)
        assertEquals("Telegram", tgBn!!.appName)

        val ig = AppChatAdapterRegistry.findAdapter("Instagram")
        assertNotNull(ig)
        assertEquals("Instagram", ig!!.appName)
        assertTrue(ig.packageNames.contains("com.instagram.android"))
        assertTrue(ig.matchesPackage("com.instagram.android"))

        val msg = AppChatAdapterRegistry.findAdapter("Messenger")
        assertNotNull(msg)
        assertEquals("Messenger", msg!!.appName)
        assertTrue(msg.packageNames.contains("com.facebook.orca"))
        assertTrue(msg.matchesPackage("com.facebook.orca"))

        // Untested or sensitive apps must NOT have a generic chat adapter
        assertNull(AppChatAdapterRegistry.findAdapter("RandomUntestedChatApp"))
        assertNull(AppChatAdapterRegistry.findAdapter("bKash"))
    }
}
