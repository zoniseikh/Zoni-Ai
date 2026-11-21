package com.zoni.jarvis.assistant.bridge

import android.content.Context
import android.content.Intent
import android.os.Build
import android.webkit.JavascriptInterface
import com.zoni.jarvis.assistant.BuildConfig
import com.zoni.jarvis.assistant.calling.SimCallManager
import com.zoni.jarvis.assistant.data.SecureKeyManager
import com.zoni.jarvis.assistant.data.ZoniUserSettings
import com.zoni.jarvis.assistant.hardware.AndroidHardwareController
import com.zoni.jarvis.assistant.screen.ScreenCaptureManager
import com.zoni.jarvis.assistant.service.AutoReplyRuleManager
import com.zoni.jarvis.assistant.service.FloatingOrbService
import com.zoni.jarvis.assistant.service.ZoniAccessibilityService
import com.zoni.jarvis.assistant.service.ZoniNotificationListenerService
import com.zoni.jarvis.assistant.ui.onboarding.OnboardingActivity
import kotlinx.coroutines.runBlocking
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
    private val onRequestDefaultAssistant: (() -> Unit)? = null
) {
    // --- Typed Allowlisted Action Engine (20 tools + explicit confirmation workflow) ---

    @JavascriptInterface
    fun executeTypedActionJson(requestJson: String): String =
        hardware.deviceActionExecutor.executeTypedActionJson(requestJson)

    @JavascriptInterface
    fun confirmPendingActionJson(pendingActionId: String, editedMessage: String, useNotificationReply: Boolean): String =
        hardware.deviceActionExecutor.confirmPendingActionJson(pendingActionId, editedMessage, useNotificationReply)

    @JavascriptInterface
    fun cancelPendingActionJson(pendingActionId: String): String =
        hardware.deviceActionExecutor.cancelPendingActionJson(pendingActionId)

    @JavascriptInterface
    fun listInstalledAppsJson(): String = hardware.listInstalledAppsJson()

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
    fun launchAppDetailedJson(appQuery: String): String = hardware.launchInstalledAppDetailedJson(appQuery)

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
            "manage_calls", "managecalls" -> arrayOf(
                android.Manifest.permission.READ_PHONE_STATE,
                android.Manifest.permission.ANSWER_PHONE_CALLS
            )
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

    // --- Onboarding, Backend Config, Floating Orb & System Status ---

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
    fun getBackendUrl(): String = keyManager.getBackendUrl()

    @JavascriptInterface
    fun setBackendUrl(url: String): Boolean {
        val clean = url.trim().trimEnd('/')
        if (!ZoniUserSettings.isValidProductionBackendUrl(clean)) {
            return false
        }
        keyManager.saveBackendUrl(clean)
        return true
    }

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
        return JSONObject()
            .put("recordAudio", snap.recordAudio)
            .put("camera", snap.camera)
            .put("callPhone", snap.callPhone)
            .put("readContacts", snap.readContacts)
            .put("sendSms", snap.sendSms)
            .put("location", snap.location)
            .put("notifications", snap.postNotifications)
            .put("bluetooth", snap.bluetooth)
            .put("batteryOptimizationIgnored", snap.batteryOptimizationIgnored)
            .put("overlayAllowed", snap.overlayAllowed)
            .put("notificationListenerEnabled", snap.notificationListenerEnabled)
            .put("accessibilityEnabled", snap.accessibilityEnabled)
            .put("defaultAssistant", snap.defaultAssistant)
            .put("screenCaptureActive", ScreenCaptureManager.isActive())
            .toString()
    }

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
