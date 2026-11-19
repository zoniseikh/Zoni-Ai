package com.zoni.jarvis.assistant.bridge

import android.content.Context
import android.content.Intent
import android.os.Build
import android.webkit.JavascriptInterface
import com.zoni.jarvis.assistant.BuildConfig
import com.zoni.jarvis.assistant.calling.HybridCallOrchestrator
import com.zoni.jarvis.assistant.data.SecureKeyManager
import com.zoni.jarvis.assistant.hardware.AndroidHardwareController
import com.zoni.jarvis.assistant.service.FloatingOrbService
import com.zoni.jarvis.assistant.ui.onboarding.OnboardingActivity
import kotlinx.coroutines.runBlocking
import org.json.JSONObject

/**
 * Typed, allowlisted Android WebView @JavascriptInterface exposed as `window.ZoniAndroidBridge`,
 * connecting the preserved original Zoni AI React dashboard directly to native Android hardware,
 * Contacts, Telecom SIM calling, Core-Telecom VoIP, Room DB history, and system services.
 */
class ZoniWebAppInterface(
    private val context: Context,
    private val hardware: AndroidHardwareController,
    private val callOrchestrator: HybridCallOrchestrator = HybridCallOrchestrator(context),
    private val keyManager: SecureKeyManager = SecureKeyManager(context)
) {
    @JavascriptInterface
    fun setFlashlight(enable: Boolean): Boolean = hardware.setFlashlight(enable)

    @JavascriptInterface
    fun placeCall(phoneNumber: String): Boolean = callOrchestrator.initiateSimCallAndLog(phoneNumber)

    @JavascriptInterface
    fun searchContactsJson(query: String): String = callOrchestrator.searchContactsAsJson(query)

    @JavascriptInterface
    fun startVoipTelecomSession(
        sessionId: String,
        targetName: String,
        phoneNumber: String,
        purpose: String,
        disclosureScript: String,
        authorizedByUser: Boolean,
        aiIdentityDisclosed: Boolean,
        recordingConsentGranted: Boolean
    ): Boolean = callOrchestrator.recordConsentAndStartVoip(
        sessionId = sessionId,
        targetName = targetName,
        phoneNumber = phoneNumber,
        purpose = purpose,
        disclosureScript = disclosureScript,
        authorizedByUser = authorizedByUser,
        aiIdentityDisclosed = aiIdentityDisclosed,
        recordingConsentGranted = recordingConsentGranted
    )

    @JavascriptInterface
    fun endActiveVoipCall(): Boolean {
        callOrchestrator.endActiveVoipCall()
        return true
    }

    @JavascriptInterface
    fun getLocalCallHistoryJson(): String = runBlocking {
        callOrchestrator.getLocalCallHistoryJson(50)
    }

    @JavascriptInterface
    fun clearLocalCallHistory(): Boolean {
        callOrchestrator.clearLocalCallHistory()
        return true
    }

    @JavascriptInterface
    fun sendSms(phoneNumber: String, message: String): Boolean = hardware.sendSms(phoneNumber, message)

    @JavascriptInterface
    fun openWhatsApp(phoneNumber: String, message: String): Boolean = hardware.openWhatsApp(phoneNumber, message)

    @JavascriptInterface
    fun vibrate(durationMs: Long): Boolean = hardware.vibrate(durationMs)

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
    fun openSystemSettings(target: String): Boolean = hardware.openSystemSettings(target)

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
        if (url.isBlank()) return false
        keyManager.saveBackendUrl(url)
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
            .put("batteryOptimizationIgnored", snap.batteryOptimizationIgnored)
            .put("overlayAllowed", snap.overlayAllowed)
            .put("notificationListenerEnabled", snap.notificationListenerEnabled)
            .put("accessibilityEnabled", snap.accessibilityEnabled)
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
