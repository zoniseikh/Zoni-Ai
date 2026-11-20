package com.zoni.jarvis.assistant.hardware

import android.Manifest
import android.app.NotificationManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.Uri
import android.os.BatteryManager
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import android.telephony.SmsManager
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.zoni.jarvis.assistant.R
import com.zoni.jarvis.assistant.ZoniApplication
import com.zoni.jarvis.assistant.action.DeviceActionExecutor
import com.zoni.jarvis.assistant.device.AppLaunchResult
import com.zoni.jarvis.assistant.device.AppLauncher
import com.zoni.jarvis.assistant.device.ContactCallManager
import com.zoni.jarvis.assistant.device.ContactCallResolution
import com.zoni.jarvis.assistant.device.FlashlightController
import com.zoni.jarvis.assistant.device.FlashlightResult
import com.zoni.jarvis.assistant.domain.ActionType
import com.zoni.jarvis.assistant.domain.AssistantAction
import com.zoni.jarvis.assistant.domain.NumberNormalizer
import com.zoni.jarvis.assistant.domain.NumberNormalizerResult
import com.zoni.jarvis.assistant.service.ZoniAccessibilityService
import com.zoni.jarvis.assistant.service.ZoniNotificationListenerService
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

data class BatterySnapshot(
    val level: Int,
    val charging: Boolean
)

data class AndroidPermissionsSnapshot(
    val recordAudio: Boolean,
    val camera: Boolean,
    val callPhone: Boolean,
    val readContacts: Boolean,
    val sendSms: Boolean,
    val location: Boolean,
    val postNotifications: Boolean,
    val bluetooth: Boolean = false,
    val batteryOptimizationIgnored: Boolean,
    val overlayAllowed: Boolean,
    val notificationListenerEnabled: Boolean,
    val accessibilityEnabled: Boolean
)

/**
 * Unified Android hardware facade that composes and delegates to the original
 * Zoni native hardware modules (FlashlightController, AppLauncher, ContactCallManager,
 * DeviceActionExecutor) with zero duplicate implementations.
 */
class AndroidHardwareController(private val context: Context) {

    val flashlightController = FlashlightController(context)
    val appLauncher = AppLauncher(context)
    val contactCallManager = ContactCallManager(context)
    val deviceActionExecutor = DeviceActionExecutor(context)

    private val _isTorchOn = MutableStateFlow(flashlightController.isCurrentlyOn())
    val isTorchOn: StateFlow<Boolean> = _isTorchOn.asStateFlow()

    fun setFlashlight(enable: Boolean): Boolean {
        val result = flashlightController.setFlashlight(enable)
        val ok = result is FlashlightResult.Success
        if (ok) {
            _isTorchOn.value = enable
        }
        return ok
    }

    fun placePhoneCall(targetOrNumber: String): Boolean {
        val raw = targetOrNumber.trim()
        if (raw.isEmpty()) return false

        val normalized = NumberNormalizer.normalizePhoneNumber(raw)
        val numberToDial = when (normalized) {
            is NumberNormalizerResult.ValidCandidate -> normalized.normalizedNumber
            else -> {
                when (val resolved = contactCallManager.resolveContact(raw)) {
                    is ContactCallResolution.ReadyToCall -> resolved.number
                    is ContactCallResolution.MultipleNumbersForContact -> resolved.numbers.firstOrNull()
                    else -> null
                } ?: raw.filter { it.isDigit() || it == '+' }
            }
        }
        if (numberToDial.isBlank()) return false
        return contactCallManager.initiateCall(numberToDial)
    }

    fun sendSms(phoneNumber: String, message: String): Boolean {
        val cleanNumber = when (val norm = NumberNormalizer.normalizePhoneNumber(phoneNumber)) {
            is NumberNormalizerResult.ValidCandidate -> norm.normalizedNumber
            else -> phoneNumber.filter { it.isDigit() || it == '+' }
        }
        val canDirectSend = ContextCompat.checkSelfPermission(
            context,
            Manifest.permission.SEND_SMS
        ) == PackageManager.PERMISSION_GRANTED

        if (canDirectSend && cleanNumber.isNotBlank() && message.isNotBlank()) {
            try {
                val smsManager = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    context.getSystemService(SmsManager::class.java)
                } else {
                    @Suppress("DEPRECATION")
                    SmsManager.getDefault()
                }
                smsManager.sendTextMessage(cleanNumber, null, message, null, null)
                return true
            } catch (_: Exception) {
                // Fall back to SMS composer intent
            }
        }
        return deviceActionExecutor.openSms(cleanNumber, message)
    }

    /**
     * Opens WhatsApp with a pre-filled draft message.
     * Note: WhatsApp requires the user to tap Send inside WhatsApp.
     */
    fun openWhatsApp(phoneNumber: String, message: String): Boolean {
        val clean = when (val norm = NumberNormalizer.normalizePhoneNumber(phoneNumber)) {
            is NumberNormalizerResult.ValidCandidate -> norm.normalizedNumber
            else -> phoneNumber
        }
        return deviceActionExecutor.openWhatsApp(clean, message)
    }

    fun vibrate(durationMs: Long = 300L): Boolean {
        deviceActionExecutor.triggerVibration(durationMs)
        return true
    }

    fun getBatteryStatus(): BatterySnapshot {
        val intent = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val level = intent?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
        val scale = intent?.getIntExtra(BatteryManager.EXTRA_SCALE, 100) ?: 100
        val status = intent?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1
        val pct = if (level >= 0 && scale > 0) ((level * 100f) / scale).toInt() else 100
        val charging = status == BatteryManager.BATTERY_STATUS_CHARGING ||
            status == BatteryManager.BATTERY_STATUS_FULL
        return BatterySnapshot(level = pct.coerceIn(0, 100), charging = charging)
    }

    fun launchInstalledApp(appQuery: String): Boolean {
        return appLauncher.launchAppByVoiceQuery(appQuery) is AppLaunchResult.Success
    }

    fun launchInstalledAppDetailedJson(appQuery: String): String {
        return appLauncher.launchAppAsJson(appQuery)
    }

    fun openCamera(): Boolean = deviceActionExecutor.openCamera()

    fun adjustVolume(action: String): String = deviceActionExecutor.adjustVolume(action)

    fun openSystemSettings(target: String): Boolean {
        val key = target.trim().lowercase()
        val intent = when {
            key == "overlay" -> Intent(
                Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                Uri.parse("package:${context.packageName}")
            )
            key == "accessibility" -> Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)
            key == "notifications" || key == "notification_listener" ->
                Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)
            key == "assistant" || key == "default_assistant" -> Intent(Settings.ACTION_VOICE_INPUT_SETTINGS)
            key == "battery" -> Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
            key == "location" -> Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS)
            key == "app_details" -> Intent(
                Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                Uri.parse("package:${context.packageName}")
            )
            else -> return deviceActionExecutor.openSettings(key)
        }.apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        return try {
            context.startActivity(intent)
            true
        } catch (_: Exception) {
            deviceActionExecutor.openSettings("main")
        }
    }

    fun showNotification(title: String, body: String): Boolean {
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return false
        val notif = NotificationCompat.Builder(context, ZoniApplication.CHANNEL_ASSISTANT_ALERTS)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentTitle(title)
            .setContentText(body)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .build()
        nm.notify((System.currentTimeMillis() % Int.MAX_VALUE).toInt(), notif)
        return true
    }

    fun executeAction(action: AssistantAction): Boolean = when (action.type) {
        ActionType.CALL -> placePhoneCall(action.target)
        ActionType.SMS -> sendSms(action.target, action.payload)
        ActionType.WHATSAPP -> openWhatsApp(action.target, action.payload)
        ActionType.FLASHLIGHT -> {
            val enable = action.payload.equals("on", ignoreCase = true) ||
                action.target.equals("on", ignoreCase = true)
            setFlashlight(enable)
        }
        ActionType.VIBRATE -> vibrate(action.payload.toLongOrNull() ?: 300L)
        ActionType.BATTERY -> {
            val bat = getBatteryStatus()
            showNotification(
                "Zoni AI Battery",
                "Battery: ${bat.level}% (${if (bat.charging) "Charging" else "Not charging"})"
            )
        }
        ActionType.NOTIFICATION -> showNotification(
            action.target.ifBlank { "Zoni AI" },
            action.payload.ifBlank { action.label }
        )
        ActionType.APP -> launchInstalledApp(action.target)
        ActionType.SETTINGS -> openSystemSettings(action.target.ifBlank { "main" })
        ActionType.ACCESSIBILITY -> ZoniAccessibilityService.performExplicitAction(
            action.target.ifBlank { action.payload }
        )
    }

    fun getPermissionsSnapshot(): AndroidPermissionsSnapshot {
        fun granted(perm: String): Boolean =
            ContextCompat.checkSelfPermission(context, perm) == PackageManager.PERMISSION_GRANTED

        val pm = context.getSystemService(Context.POWER_SERVICE) as? PowerManager
        val batteryIgnored = pm?.isIgnoringBatteryOptimizations(context.packageName) == true
        val overlayAllowed = Settings.canDrawOverlays(context)

        val enabledListeners = Settings.Secure.getString(
            context.contentResolver,
            "enabled_notification_listeners"
        ) ?: ""
        val notifListener = enabledListeners.contains(
            ComponentName(context, ZoniNotificationListenerService::class.java).flattenToString()
        )

        val enabledA11y = Settings.Secure.getString(
            context.contentResolver,
            Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
        ) ?: ""
        val a11yEnabled = enabledA11y.contains(
            ComponentName(context, ZoniAccessibilityService::class.java).flattenToString()
        )

        val postNotif = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            granted(Manifest.permission.POST_NOTIFICATIONS)
        } else {
            true
        }

        val bluetoothGranted = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            granted(Manifest.permission.BLUETOOTH_CONNECT)
        } else {
            true
        }

        return AndroidPermissionsSnapshot(
            recordAudio = granted(Manifest.permission.RECORD_AUDIO),
            camera = granted(Manifest.permission.CAMERA),
            callPhone = granted(Manifest.permission.CALL_PHONE),
            readContacts = granted(Manifest.permission.READ_CONTACTS),
            sendSms = granted(Manifest.permission.SEND_SMS),
            location = granted(Manifest.permission.ACCESS_FINE_LOCATION) ||
                granted(Manifest.permission.ACCESS_COARSE_LOCATION),
            postNotifications = postNotif,
            bluetooth = bluetoothGranted,
            batteryOptimizationIgnored = batteryIgnored,
            overlayAllowed = overlayAllowed,
            notificationListenerEnabled = notifListener,
            accessibilityEnabled = a11yEnabled
        )
    }
}
