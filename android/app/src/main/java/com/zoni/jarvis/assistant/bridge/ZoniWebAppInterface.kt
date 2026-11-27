package com.zoni.jarvis.assistant.bridge

import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import android.webkit.JavascriptInterface
import com.zoni.jarvis.assistant.BuildConfig
import com.zoni.jarvis.assistant.calling.SimCallManager
import com.zoni.jarvis.assistant.data.SecureKeyManager
import com.zoni.jarvis.assistant.db.LocalMemoryRepository
import com.zoni.jarvis.assistant.db.ZoniDatabase
import com.zoni.jarvis.assistant.hardware.AndroidHardwareController
import com.zoni.jarvis.assistant.network.NetworkQualityMonitor
import com.zoni.jarvis.assistant.screen.ScreenCaptureManager
import com.zoni.jarvis.assistant.service.AutoReplyRuleManager
import com.zoni.jarvis.assistant.service.FloatingOrbService
import com.zoni.jarvis.assistant.service.ZoniAccessibilityService
import com.zoni.jarvis.assistant.service.ZoniNotificationListenerService
import com.zoni.jarvis.assistant.ui.onboarding.OnboardingActivity
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject

/**
 * Typed, allowlisted Android WebView @JavascriptInterface exposed as `window.ZoniAndroidBridge`,
 * connecting the preserved original Zoni AI React dashboard directly to native Android hardware,
 * Contacts, Telecom SIM calling, WhatsApp review/confirmation drafts, Installed App discovery,
 * Screen Awareness (MediaProjection + Accessibility), Multi-Step Verified Accessibility Workflows,
 * Notification Listener + RemoteInput replies, Default Digital Assistant role, and Room DB history.
 */
class ZoniWebAppInterface(
    private val context: Context,
    private val hardware: AndroidHardwareController,
    private val simCallManager: SimCallManager = SimCallManager(context),
    private val keyManager: SecureKeyManager = SecureKeyManager(context),
    private val autoReplyManager: AutoReplyRuleManager = AutoReplyRuleManager(context),
    private val onRequestRuntimePermissions: ((Array<String>) -> Unit)? = null,
    private val onRequestScreenCaptureConsent: (() -> Unit)? = null,
    private val onRequestDefaultAssistant: (() -> Unit)? = null,
    private val onRequestCallControlRole: (() -> Unit)? = null
) {
    private val preferences by lazy { com.zoni.jarvis.assistant.data.ZoniPreferences(context.applicationContext) }
    private val localMemoryRepo by lazy {
        (context.applicationContext as? com.zoni.jarvis.assistant.ZoniApplication)?.localMemoryRepository
            ?: LocalMemoryRepository(
                ZoniDatabase.getInstance(context.applicationContext),
                keyManager,
                context.applicationContext
            )
    }

    // --- Typed Allowlisted Action Engine (36 tools) ---

    @JavascriptInterface
    fun executeTypedActionJson(requestJson: String): String {
        val resultJson = hardware.deviceActionExecutor.executeTypedActionJson(requestJson)
        try {
            val parsed = JSONObject(resultJson)
            Log.d(
                "ZoniBridge",
                "executeTypedAction: action=${parsed.optString("actionType")} status=${parsed.optString("status")} failure=${parsed.optString("failureReason")}"
            )
        } catch (_: Exception) {
            // ignore diagnostic parse issue
        }
        return resultJson
    }

    @JavascriptInterface
    fun getRuntimeDiagnosticsJson(): String = hardware.deviceActionExecutor.getRuntimeDiagnosticsJson()

    @JavascriptInterface
    fun confirmPendingActionJson(pendingActionId: String, editedMessage: String, useNotificationReply: Boolean): String =
        hardware.deviceActionExecutor.confirmPendingActionJson(pendingActionId, editedMessage, useNotificationReply)

    @JavascriptInterface
    fun cancelPendingActionJson(pendingActionId: String): String =
        hardware.deviceActionExecutor.cancelPendingActionJson(pendingActionId)

    @JavascriptInterface
    fun listInstalledAppsJson(): String = hardware.listInstalledAppsJson()

    // --- On-Device ZONI Wake Word & 24-Hour Transparent Background Listening ---

    @JavascriptInterface
    fun getWakeWordStatusJson(): String =
        com.zoni.jarvis.assistant.service.ZoniForegroundService.getCurrentStatusSnapshot(context).toJson()

    @JavascriptInterface
    fun setWakeWordEnabled(enabled: Boolean): String {
        return if (enabled) {
            com.zoni.jarvis.assistant.service.ZoniForegroundService.startWakeWordListening(
                context,
                preferences.getWakePhraseSync()
            )
        } else {
            com.zoni.jarvis.assistant.service.ZoniForegroundService.stop(context, disablePreference = true)
        }
    }

    @JavascriptInterface
    fun setWakePhrase(phrase: String): String {
        val clean = phrase.trim().take(32).ifBlank {
            com.zoni.jarvis.assistant.wakeword.WakeWordConfig.DEFAULT_WAKE_PHRASE
        }
        preferences.setWakePhraseSync(clean)
        if (com.zoni.jarvis.assistant.service.ZoniForegroundService.isServiceRunning &&
            preferences.isWakeWordEnabledSync()
        ) {
            return com.zoni.jarvis.assistant.service.ZoniForegroundService.startWakeWordListening(context, clean)
        }
        val snap = com.zoni.jarvis.assistant.service.ZoniForegroundService.getCurrentStatusSnapshot(context)
        return JSONObject()
            .put("success", true)
            .put("status", "wake_phrase_updated")
            .put("wakePhrase", clean)
            .put("message", "Wake phrase updated to \"$clean\".")
            .put("snapshot", JSONObject(snap.toJson()))
            .toString()
    }

    @JavascriptInterface
    fun startBackgroundWakeWordJson(): String =
        com.zoni.jarvis.assistant.service.ZoniForegroundService.startWakeWordListening(
            context,
            preferences.getWakePhraseSync()
        )

    @JavascriptInterface
    fun stopBackgroundWakeWordJson(): String =
        com.zoni.jarvis.assistant.service.ZoniForegroundService.stop(context, disablePreference = true)

    @JavascriptInterface
    fun notifyVoiceSessionState(state: String): Boolean {
        val parsed = com.zoni.jarvis.assistant.wakeword.VoiceLifecycleState.fromString(state)
        val bgCommandActive = com.zoni.jarvis.assistant.service.ZoniForegroundService.isBackgroundCommandModeActive()
        when (parsed) {
            com.zoni.jarvis.assistant.wakeword.VoiceLifecycleState.CONNECTING,
            com.zoni.jarvis.assistant.wakeword.VoiceLifecycleState.LISTENING,
            com.zoni.jarvis.assistant.wakeword.VoiceLifecycleState.PROCESSING,
            com.zoni.jarvis.assistant.wakeword.VoiceLifecycleState.SPEAKING -> {
                if (!bgCommandActive) {
                    com.zoni.jarvis.assistant.service.ZoniForegroundService.pauseWakeWordForConversation(context, parsed)
                }
            }
            com.zoni.jarvis.assistant.wakeword.VoiceLifecycleState.IDLE -> {
                if (!bgCommandActive) {
                    com.zoni.jarvis.assistant.service.ZoniForegroundService.updateVoiceState(context, parsed)
                    if (preferences.isWakeWordEnabledSync() && preferences.isBackgroundListeningEnabledSync()) {
                        com.zoni.jarvis.assistant.service.ZoniForegroundService.resumeWakeWordAfterConversation(context)
                    }
                }
            }
            else -> {
                if (!bgCommandActive) {
                    com.zoni.jarvis.assistant.service.ZoniForegroundService.updateVoiceState(context, parsed)
                }
            }
        }
        return true
    }

    @JavascriptInterface
    fun syncAssistantSettingsJson(settingsJson: String): Boolean {
        return try {
            val obj = JSONObject(settingsJson)
            preferences.syncAssistantSettingsSync(
                affectionName = obj.optString("affectionName", "").takeIf { it.isNotBlank() },
                languageCode = obj.optString("languageCode", "").takeIf { it.isNotBlank() },
                modeId = obj.optString("modeId", "").takeIf { it.isNotBlank() },
                voiceId = obj.optString("voiceId", "").takeIf { it.isNotBlank() },
                voiceMuted = if (obj.has("voiceMuted")) obj.optBoolean("voiceMuted", false) else null
            )
            true
        } catch (_: Exception) {
            false
        }
    }

    @JavascriptInterface
    fun pauseWakeWordForVoiceSession(): Boolean {
        com.zoni.jarvis.assistant.service.ZoniForegroundService.pauseWakeWordForConversation(
            context,
            com.zoni.jarvis.assistant.wakeword.VoiceLifecycleState.ACTIVATING
        )
        return true
    }

    @JavascriptInterface
    fun resumeWakeWordAfterVoiceSession(): Boolean {
        com.zoni.jarvis.assistant.service.ZoniForegroundService.resumeWakeWordAfterConversation(context)
        return true
    }

    // --- Incoming & Active Phone Call Control (Android Telecom / InCallService) ---

    @JavascriptInterface
    fun getIncomingCallStatusJson(): String = simCallManager.getIncomingCallStatusAsJson()

    @JavascriptInterface
    fun answerIncomingCallJson(): String = simCallManager.answerIncomingCallAsJson()

    @JavascriptInterface
    fun rejectIncomingCallJson(): String = simCallManager.rejectIncomingCallAsJson()

    @JavascriptInterface
    fun endActiveCallJson(): String = simCallManager.endActiveCallAsJson()

    @JavascriptInterface
    fun requestCallControlRole(): Boolean {
        val cb = onRequestCallControlRole
        if (cb != null) {
            cb.invoke()
            return true
        }
        return false
    }

    // --- Hardware, Calls, Contacts, SMS, WhatsApp ---

    @JavascriptInterface
    fun setFlashlight(enable: Boolean): Boolean = hardware.setFlashlight(enable)

    @JavascriptInterface
    fun placeCall(phoneNumber: String): Boolean = simCallManager.initiateSimCallAndLog(phoneNumber)

    @JavascriptInterface
    fun callContactDetailedJson(queryOrNumber: String): String =
        simCallManager.resolveAndCallContactAsJson(queryOrNumber)

    @JavascriptInterface
    fun searchContactsJson(query: String): String = simCallManager.searchContactsAsJson(query)

    @JavascriptInterface
    fun getLocalCallHistoryJson(): String = runBlocking {
        simCallManager.getLocalCallHistoryJson(50)
    }

    @JavascriptInterface
    fun clearLocalCallHistory(): Boolean {
        simCallManager.clearLocalCallHistory()
        return true
    }

    @JavascriptInterface
    fun sendSms(phoneNumber: String, message: String): Boolean = hardware.sendSms(phoneNumber, message)

    @JavascriptInterface
    fun openWhatsApp(phoneNumber: String, message: String): Boolean = hardware.openWhatsApp(phoneNumber, message)

    @JavascriptInterface
    fun prepareWhatsAppContactJson(contactOrNumber: String, message: String): String =
        simCallManager.prepareWhatsAppForContactAsJson(contactOrNumber, message)

    @JavascriptInterface
    fun vibrate(durationMs: Long): Boolean = hardware.vibrate(durationMs)

    @JavascriptInterface
    fun openCamera(): Boolean = hardware.openCamera()

    @JavascriptInterface
    fun adjustVolumeJson(action: String): String = hardware.adjustVolume(action)

    @JavascriptInterface
    fun getBatteryStatusJson(): String {
        val snap = hardware.getBatteryStatus()
        return JSONObject()
            .put("level", snap.level)
            .put("charging", snap.charging)
            .toString()
    }

    @JavascriptInterface
    fun launchApp(appQuery: String): Boolean = hardware.launchInstalledApp(appQuery)

    @JavascriptInterface
    fun launchAppDetailedJson(appQuery: String): String {
        val res = hardware.launchInstalledAppDetailedJson(appQuery)
        try {
            val parsed = JSONObject(res)
            Log.d(
                "ZoniBridge",
                "launchAppDetailed: status=${parsed.optString("status")} pkg=${parsed.optString("packageName")} failure=${parsed.optString("failureReason")}"
            )
        } catch (_: Exception) {
            // ignore
        }
        return res
    }

    @JavascriptInterface
    fun openSystemSettings(target: String): Boolean = hardware.openSystemSettings(target)

    // --- Default Digital Assistant Integration ---

    @JavascriptInterface
    fun isDefaultDigitalAssistant(): Boolean = hardware.isDefaultDigitalAssistant()

    @JavascriptInterface
    fun requestDefaultDigitalAssistant(): Boolean {
        val cb = onRequestDefaultAssistant
        if (cb != null) {
            cb.invoke()
            return true
        }
        return hardware.openSystemSettings("default_assistant")
    }

    // --- Runtime Permissions ---

    @JavascriptInterface
    fun requestRuntimePermission(permissionKey: String): Boolean {
        val cb = onRequestRuntimePermissions ?: return false
        val perms = when (permissionKey.trim().lowercase()) {
            "microphone", "audio", "record_audio" -> arrayOf(android.Manifest.permission.RECORD_AUDIO)
            "camera" -> arrayOf(android.Manifest.permission.CAMERA)
            "calls", "call_phone" -> arrayOf(android.Manifest.permission.CALL_PHONE)
            "contacts", "read_contacts" -> arrayOf(android.Manifest.permission.READ_CONTACTS)
            "sms", "send_sms" -> arrayOf(android.Manifest.permission.SEND_SMS)
            "location" -> arrayOf(
                android.Manifest.permission.ACCESS_FINE_LOCATION,
                android.Manifest.permission.ACCESS_COARSE_LOCATION
            )
            "notifications", "post_notifications" -> if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                arrayOf(android.Manifest.permission.POST_NOTIFICATIONS)
            } else {
                emptyArray()
            }
            "bluetooth" -> if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                arrayOf(android.Manifest.permission.BLUETOOTH_CONNECT)
            } else {
                emptyArray()
            }
            "manage_calls", "managecalls", "call_control", "answer_phone_calls", "read_phone_state" -> buildList {
                add(android.Manifest.permission.READ_PHONE_STATE)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    add(android.Manifest.permission.ANSWER_PHONE_CALLS)
                }
            }.toTypedArray()
            "gallery" -> if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                arrayOf(android.Manifest.permission.READ_MEDIA_IMAGES)
            } else {
                emptyArray()
            }
            "all" -> buildList {
                add(android.Manifest.permission.RECORD_AUDIO)
                add(android.Manifest.permission.CAMERA)
                add(android.Manifest.permission.CALL_PHONE)
                add(android.Manifest.permission.READ_CONTACTS)
                add(android.Manifest.permission.SEND_SMS)
                add(android.Manifest.permission.ACCESS_FINE_LOCATION)
                add(android.Manifest.permission.READ_PHONE_STATE)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    add(android.Manifest.permission.ANSWER_PHONE_CALLS)
                }
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    add(android.Manifest.permission.POST_NOTIFICATIONS)
                    add(android.Manifest.permission.READ_MEDIA_IMAGES)
                }
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    add(android.Manifest.permission.BLUETOOTH_CONNECT)
                }
            }.toTypedArray()
            else -> emptyArray()
        }
        if (perms.isEmpty()) return false
        cb.invoke(perms)
        return true
    }

    // --- Screen Awareness (User-Authorized MediaProjection + Accessibility Text) ---

    @JavascriptInterface
    fun requestScreenCaptureConsent(): Boolean {
        val cb = onRequestScreenCaptureConsent ?: return false
        cb.invoke()
        return true
    }

    @JavascriptInterface
    fun isScreenCaptureActive(): Boolean = ScreenCaptureManager.isActive()

    @JavascriptInterface
    fun captureScreenFrameJson(): String {
        // Strict privacy guard: NEVER capture pixels on banking, payment, OTP, or password screens
        val (isProtected, blockReason) = ZoniAccessibilityService.isCurrentScreenProtected()
        if (isProtected) {
            return JSONObject()
                .put("success", false)
                .put("base64Jpeg", "")
                .put("width", 0)
                .put("height", 0)
                .put("blockedSensitive", true)
                .put("error", blockReason.ifBlank { "Blocked screen capture on protected banking, payment, or password screen." })
                .toString()
        }
        val res = ScreenCaptureManager.captureSingleFrameBase64(context)
        return JSONObject()
            .put("success", res.success)
            .put("base64Jpeg", res.base64Jpeg)
            .put("width", res.width)
            .put("height", res.height)
            .put("error", res.error)
            .toString()
    }

    @JavascriptInterface
    fun stopScreenCapture(): Boolean {
        ScreenCaptureManager.stopCapture(context)
        return true
    }

    @JavascriptInterface
    fun getVisibleScreenText(): String = ZoniAccessibilityService.getVisibleScreenText(80)

    @JavascriptInterface
    fun readVisibleScreenDetailedJson(): String = ZoniAccessibilityService.readVisibleScreenDetailedJson(80)

    // --- Accessibility Actions & Verified Multi-Step Workflows ---

    @JavascriptInterface
    fun performAccessibilityAction(command: String): Boolean =
        ZoniAccessibilityService.performExplicitAction(command)

    @JavascriptInterface
    fun performAccessibilityActionDetailedJson(command: String): String =
        ZoniAccessibilityService.performExplicitActionDetailedJson(command)

    @JavascriptInterface
    fun executeVerifiedWorkflowJson(stepsJson: String): String =
        ZoniAccessibilityService.executeVerifiedWorkflowJson(stepsJson)

    @JavascriptInterface
    fun scrollScreen(direction: String): Boolean =
        ZoniAccessibilityService.performScroll(direction)

    @JavascriptInterface
    fun enterAccessibleText(targetHint: String, text: String): Boolean =
        ZoniAccessibilityService.enterText(targetHint, text)

    @JavascriptInterface
    fun clickVisualElementJson(query: String): String =
        ZoniAccessibilityService.clickVisualTargetWithRevalidation(
            query = query,
            context = context,
            apiKey = keyManager.getApiKey().orEmpty()
        ).toJson()

    // --- Notification Awareness, Official RemoteInput Reply & Rule-Based Auto Reply ---

    @JavascriptInterface
    fun getRecentNotificationsJson(): String =
        ZoniNotificationListenerService.getRecentNotificationsJson(15)

    @JavascriptInterface
    fun clearRecentNotifications(): Boolean {
        ZoniNotificationListenerService.clearRecentNotifications()
        return true
    }

    @JavascriptInterface
    fun replyToNotification(notificationKey: String, replyText: String): Boolean =
        ZoniNotificationListenerService.sendReply(context, notificationKey, replyText)

    @JavascriptInterface
    fun getAutoReplyRulesJson(): String = autoReplyManager.getRulesJson()

    @JavascriptInterface
    fun saveAutoReplyRulesJson(rulesJson: String): Boolean = autoReplyManager.saveRulesJson(rulesJson)

    @JavascriptInterface
    fun setAutoReplyEnabled(enabled: Boolean): Boolean {
        autoReplyManager.setMasterEnabled(enabled)
        return true
    }

    // --- Onboarding, Gemini API Key (BYOK Keystore), Floating Orb & System Status ---

    @JavascriptInterface
    fun openOnboardingWizard(): Boolean {
        return try {
            val intent = Intent(context, OnboardingActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(intent)
            true
        } catch (_: Exception) {
            false
        }
    }

    @JavascriptInterface
    fun saveGeminiApiKey(apiKey: String): Boolean = keyManager.saveApiKey(apiKey)

    @JavascriptInterface
    fun deleteGeminiApiKey(): Boolean = keyManager.deleteApiKey()

    @JavascriptInterface
    fun getGeminiApiKeyStatusJson(): String {
        val configured = keyManager.hasApiKey()
        val masked = keyManager.getMaskedApiKeyPreview()
        val keystoreBacked = keyManager.isUsingAndroidKeystore()
        return JSONObject()
            .put("configured", configured)
            .put("maskedPreview", masked ?: JSONObject.NULL)
            .put(
                "storageKind",
                if (keystoreBacked) "android_keystore" else "android_private_prefs"
            )
            .put("keystoreBacked", keystoreBacked)
            .put("isKeystoreBacked", keystoreBacked)
            .put("isNativeAndroid", true)
            .toString()
    }

    @JavascriptInterface
    fun getGeminiApiKeyForRequest(): String = keyManager.getApiKey().orEmpty()

    @JavascriptInterface
    fun setFloatingOrbEnabled(enable: Boolean): Boolean {
        return if (enable) {
            FloatingOrbService.start(context)
        } else {
            FloatingOrbService.stop(context)
            true
        }
    }

    @JavascriptInterface
    fun isFloatingOrbEnabled(): Boolean = FloatingOrbService.isRunning

    @JavascriptInterface
    fun showNotification(title: String, body: String): Boolean = hardware.showNotification(title, body)

    @JavascriptInterface
    fun getPermissionsStatusJson(): String {
        val snap = hardware.getPermissionsSnapshot()
        val wakeSnap = com.zoni.jarvis.assistant.service.ZoniForegroundService.getCurrentStatusSnapshot(context)
        return JSONObject()
            .put("recordAudio", snap.recordAudio)
            .put("camera", snap.camera)
            .put("callPhone", snap.callPhone)
            .put("readContacts", snap.readContacts)
            .put("sendSms", snap.sendSms)
            .put("location", snap.location)
            .put("notifications", snap.postNotifications)
            .put("bluetooth", snap.bluetooth)
            .put("readPhoneState", simCallManager.hasReadPhoneStatePermission())
            .put("answerPhoneCalls", simCallManager.hasAnswerPhoneCallsPermission())
            .put("defaultDialerRole", simCallManager.isDefaultDialerRoleHeld())
            .put("wakeWordEnabled", wakeSnap.wakeWordEnabled)
            .put("backgroundWakeWordRunning", wakeSnap.backgroundServiceRunning)
            .put("batteryOptimizationIgnored", snap.batteryOptimizationIgnored)
            .put("overlayAllowed", snap.overlayAllowed)
            .put("notificationListenerEnabled", snap.notificationListenerEnabled)
            .put("accessibilityEnabled", snap.accessibilityEnabled)
            .put("defaultAssistant", snap.defaultAssistant)
            .put("screenCaptureActive", ScreenCaptureManager.isActive())
            .toString()
    }

    // --- Permanent Local Conversation Memory & Encrypted Long-Term Memory (Room ZoniDatabase v3) ---

    @JavascriptInterface
    fun saveLocalConversationMessage(role: String, text: String, language: String): Boolean = runBlocking {
        localMemoryRepo.saveMessage(
            role = role.ifBlank { "user" },
            text = text,
            language = language.ifBlank { "bn-BD" }
        )
    }

    @JavascriptInterface
    fun saveLocalConversationRecordJson(recordJson: String): String = runBlocking {
        try {
            val obj = JSONObject(recordJson)
            val res = localMemoryRepo.saveMessageVerified(
                role = obj.optString("role", "user").ifBlank { "user" },
                text = obj.optString("text", ""),
                language = obj.optString("language", "bn-BD").ifBlank { "bn-BD" },
                id = obj.optString("id", "").ifBlank { java.util.UUID.randomUUID().toString() },
                createdAtMs = obj.optLong("createdAtMs", System.currentTimeMillis()).let {
                    if (it > 0L) it else System.currentTimeMillis()
                },
                conversationId = obj.optString("conversationId", "default").ifBlank { "default" },
                inputType = obj.optString("inputType", "text").ifBlank { "text" },
                commandName = obj.optString("commandName", ""),
                executionStatus = obj.optString("executionStatus", "")
            )
            JSONObject()
                .put("success", res.success)
                .put("verified", res.verified)
                .put("messageId", res.messageId)
                .put("conversationId", res.conversationId)
                .put("errorCode", res.errorCode)
                .put("errorMessage", res.errorMessage)
                .put("queuedForRecovery", res.queuedForRecovery)
                .toString()
        } catch (e: Exception) {
            JSONObject()
                .put("success", false)
                .put("verified", false)
                .put("errorCode", "INVALID_PAYLOAD")
                .put("errorMessage", e.javaClass.simpleName)
                .toString()
        }
    }

    @JavascriptInterface
    fun getLocalConversationHistoryJson(limit: Int, offset: Int): String = runBlocking {
        val rows = localMemoryRepo.loadRecentConversations(limit.coerceIn(1, 200), offset.coerceAtLeast(0))
        val arr = JSONArray()
        rows.forEach { row ->
            arr.put(
                JSONObject()
                    .put("id", row.id)
                    .put("conversationId", row.conversationId)
                    .put("role", row.role)
                    .put("text", row.text)
                    .put("language", row.language)
                    .put("createdAtMs", row.createdAtMs)
                    .put("inputType", row.inputType)
                    .put("commandName", row.commandName)
                    .put("executionStatus", row.executionStatus)
                    .put("dateBucket", row.dateBucket)
            )
        }
        JSONObject()
            .put("success", true)
            .put("count", rows.size)
            .put("messages", arr)
            .toString()
    }

    @JavascriptInterface
    fun searchLocalConversationsJson(paramsJson: String): String = runBlocking {
        try {
            val obj = JSONObject(paramsJson.ifBlank { "{}" })
            val res = localMemoryRepo.searchConversationsPaged(
                query = obj.optString("query", ""),
                dateBucket = obj.optString("dateBucket", ""),
                startMs = obj.optLong("startMs", 0L),
                endMs = obj.optLong("endMs", 0L),
                inputType = obj.optString("inputType", ""),
                limit = obj.optInt("limit", 40).coerceIn(1, 100),
                offset = obj.optInt("offset", 0).coerceAtLeast(0)
            )
            val arr = JSONArray()
            res.messages.forEach { row ->
                arr.put(
                    JSONObject()
                        .put("id", row.id)
                        .put("conversationId", row.conversationId)
                        .put("role", row.role)
                        .put("text", row.text)
                        .put("language", row.language)
                        .put("createdAtMs", row.createdAtMs)
                        .put("inputType", row.inputType)
                        .put("commandName", row.commandName)
                        .put("executionStatus", row.executionStatus)
                        .put("dateBucket", row.dateBucket)
                )
            }
            JSONObject()
                .put("success", true)
                .put("count", res.totalReturned)
                .put("hasMore", res.hasMore)
                .put("dateRangeLabel", res.dateRangeApplied?.label ?: "")
                .put("messages", arr)
                .toString()
        } catch (e: Exception) {
            JSONObject()
                .put("success", false)
                .put("count", 0)
                .put("hasMore", false)
                .put("error", e.javaClass.simpleName)
                .put("messages", JSONArray())
                .toString()
        }
    }

    @JavascriptInterface
    fun getLocalConversationDatesJson(limit: Int, offset: Int): String = runBlocking {
        val rows = localMemoryRepo.getConversationDateBuckets(limit.coerceIn(1, 365), offset.coerceAtLeast(0))
        val arr = JSONArray()
        rows.forEach { row ->
            arr.put(
                JSONObject()
                    .put("dateBucket", row.dateBucket)
                    .put("messageCount", row.messageCount)
                    .put("firstTimestampMs", row.firstTimestampMs)
                    .put("lastTimestampMs", row.lastTimestampMs)
            )
        }
        JSONObject()
            .put("success", true)
            .put("dates", arr)
            .toString()
    }

    @JavascriptInterface
    fun exportEncryptedBackupJson(passphrase: String): String = runBlocking {
        val res = localMemoryRepo.exportEncryptedBackup(passphrase)
        JSONObject()
            .put("success", res.success)
            .put("encryptedArchiveJson", res.encryptedArchiveJson)
            .put("messageCount", res.messageCount)
            .put("memoryCount", res.memoryCount)
            .put("error", res.error)
            .toString()
    }

    @JavascriptInterface
    fun restoreEncryptedBackupJson(
        encryptedArchiveJson: String,
        passphrase: String,
        replaceExisting: Boolean
    ): String = runBlocking {
        val res = localMemoryRepo.restoreEncryptedBackup(encryptedArchiveJson, passphrase, replaceExisting)
        JSONObject()
            .put("success", res.success)
            .put("restoredMessages", res.restoredMessages)
            .put("restoredMemories", res.restoredMemories)
            .put("skippedSensitive", res.skippedSensitive)
            .put("error", res.error)
            .toString()
    }

    @JavascriptInterface
    fun getDatabaseHealthJson(): String = runBlocking {
        val h = localMemoryRepo.getDatabaseHealth()
        JSONObject()
            .put("healthy", h.healthy)
            .put("integrityStatus", h.integrityStatus)
            .put("lowStorage", h.lowStorage)
            .put("availableBytes", h.availableBytes)
            .put("pendingRecoveryCount", h.pendingRecoveryCount)
            .put("totalConversations", h.totalConversations)
            .put("totalMemories", h.totalMemories)
            .put("encryptedAtRest", h.encryptedAtRest)
            .put("lastWriteError", h.lastWriteError)
            .toString()
    }

    @JavascriptInterface
    fun recoverPendingWritesJson(): String = runBlocking {
        val recovered = localMemoryRepo.recoverPendingWrites()
        JSONObject()
            .put("success", true)
            .put("recoveredCount", recovered)
            .toString()
    }

    @JavascriptInterface
    fun getLocalMemorySummaryJson(): String = runBlocking {
        localMemoryRepo.getMemorySummaryJson(40)
    }

    @JavascriptInterface
    fun recallLocalMemoryJson(query: String, language: String): String = runBlocking {
        val res = localMemoryRepo.tryLocalMemoryRecall(query, language.ifBlank { "bn-BD" })
        JSONObject()
            .put("isMemoryQuery", res.isMemoryQuery)
            .put("handledOffline", res.handledOffline)
            .put("foundEvidence", res.foundEvidence)
            .put("replyText", res.replyText)
            .put("matchedFactCount", res.matchedFacts.size)
            .put("matchedMessageCount", res.matchedMessages.size)
            .toString()
    }

    @JavascriptInterface
    fun buildCompactMemoryContext(query: String): String = runBlocking {
        localMemoryRepo.buildCompactContextForQuery(query)
    }

    @JavascriptInterface
    fun clearLocalConversationHistory(): Boolean = runBlocking {
        localMemoryRepo.clearConversationHistory()
    }

    @JavascriptInterface
    fun clearLocalLongTermMemory(): Boolean = runBlocking {
        localMemoryRepo.clearLongTermMemory()
    }

    // --- Network Quality Snapshot (Low-Internet Optimization) ---

    @JavascriptInterface
    fun getNetworkQualityJson(): String {
        val state = NetworkQualityMonitor.snapshotQuality(context)
        return JSONObject()
            .put("quality", state.name.lowercase())
            .put("online", state != com.zoni.jarvis.assistant.network.NetworkQualityState.OFFLINE)
            .put("weak", state == com.zoni.jarvis.assistant.network.NetworkQualityState.WEAK)
            .toString()
    }

    // --- Optional Consent-Based On-Device Speaker Verification (Local AES-256-GCM Encrypted Only) ---

    @JavascriptInterface
    fun getSpeakerVerificationStatusJson(): String {
        val cfg = preferences.getSpeakerVerificationConfigSync()
        val profile = preferences.getSpeakerVoiceprintSync()
        return JSONObject()
            .put("enabled", cfg.enabled)
            .put("strictMode", cfg.strictMode)
            .put("acceptThreshold", cfg.acceptThreshold.toDouble())
            .put("uncertainThreshold", cfg.uncertainThreshold.toDouble())
            .put("enrolled", profile != null && profile.sampleCount >= cfg.requiredEnrollmentSamples)
            .put("sampleCount", profile?.sampleCount ?: 0)
            .put("enrolledAtMs", profile?.enrolledAtMs ?: 0L)
            .put("encryptedLocalOnly", preferences.isKeystoreBacked())
            .toString()
    }

    @JavascriptInterface
    fun saveSpeakerVoiceprintJson(voiceprintJson: String): Boolean {
        val parsed = com.zoni.jarvis.assistant.audio.SpeakerVoiceprint.fromJson(voiceprintJson)
            ?: return false
        return preferences.saveSpeakerVoiceprintSync(parsed)
    }

    @JavascriptInterface
    fun setSpeakerVerificationConfigJson(configJson: String): String {
        return try {
            val obj = JSONObject(configJson)
            val enabled = obj.optBoolean("enabled", false)
            val strictMode = obj.optBoolean("strictMode", false)
            val acceptThreshold = obj.optDouble("acceptThreshold", 0.78).toFloat()
            val uncertainThreshold = obj.optDouble("uncertainThreshold", 0.56).toFloat()
            preferences.setSpeakerVerificationConfigSync(
                enabled = enabled,
                strictMode = strictMode,
                acceptThreshold = acceptThreshold,
                uncertainThreshold = uncertainThreshold
            )
            getSpeakerVerificationStatusJson()
        } catch (_: Exception) {
            getSpeakerVerificationStatusJson()
        }
    }

    @JavascriptInterface
    fun clearSpeakerVoiceprint(): Boolean = preferences.clearSpeakerVoiceprintSync()

    @JavascriptInterface
    fun getDeviceInfoJson(): String = JSONObject()
        .put("manufacturer", Build.MANUFACTURER)
        .put("model", Build.MODEL)
        .put("sdkInt", Build.VERSION.SDK_INT)
        .put("release", Build.VERSION.RELEASE)
        .put("appVersion", BuildConfig.VERSION_NAME)
        .put("packageName", BuildConfig.APPLICATION_ID)
        .toString()
}
