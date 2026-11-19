package com.zoni.jarvis.assistant.action

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.provider.Settings
import com.zoni.jarvis.assistant.device.AppLauncher
import com.zoni.jarvis.assistant.device.ContactCallManager
import com.zoni.jarvis.assistant.device.FlashlightController
import java.net.URLEncoder

data class DeviceActionResult(
    val spokenReply: String,
    val executed: Boolean = false,
    val actionType: String? = null
)

/**
 * Direct execution engine for Zoni AI on Android.
 * Eliminates all unnecessary confirmation dialogs and popups,
 * directly executing calls, SMS, WhatsApp, flashlight, vibration,
 * app launches, and settings intents upon command recognition.
 */
class DeviceActionExecutor(private val context: Context) {

    private val contactCallManager = ContactCallManager(context)
    private val appLauncher = AppLauncher(context)
    private val flashlightController = FlashlightController(context)

    /**
     * Parses and directly executes any action tags embedded in text:
     * e.g., [ACTION:CALL:017...], [ACTION:WHATSAPP:017...:hello], [ACTION:SMS:017...:hello],
     * [ACTION:FLASHLIGHT:ON], [ACTION:VIBRATE], [ACTION:APP:YouTube], [ACTION:SETTINGS:wifi]
     *
     * Returns a [DeviceActionResult] with the action stripped so spoken vocal audio remains completely natural.
     */
    fun parseAndExecute(fullText: String): DeviceActionResult {
        val actionRegex = Regex("\\[ACTION:([A-Z]+)(?::([^:\\]]+))?(?::([^\\]]+))?\\]", RegexOption.IGNORE_CASE)
        val match = actionRegex.find(fullText)
        val cleanReply = fullText.replace(actionRegex, "").trim()

        if (match == null) {
            return DeviceActionResult(spokenReply = cleanReply, executed = false)
        }

        val actionType = match.groupValues[1].uppercase()
        val target = match.groupValues.getOrNull(2) ?: ""
        val payload = match.groupValues.getOrNull(3) ?: ""

        val executed = executeAction(actionType, target, payload)
        return DeviceActionResult(spokenReply = cleanReply, executed = executed, actionType = actionType)
    }

    /**
     * Directly executes an action without displaying any confirmation popup.
     */
    fun executeAction(actionType: String, target: String, payload: String): Boolean {
        return when (actionType) {
            "CALL" -> {
                if (target.isNotBlank()) {
                    contactCallManager.initiateCall(target)
                } else false
            }
            "WHATSAPP" -> {
                openWhatsApp(target, payload)
            }
            "SMS" -> {
                openSms(target, payload)
            }
            "FLASHLIGHT" -> {
                val enable = target.equals("ON", ignoreCase = true) || payload.equals("ON", ignoreCase = true)
                flashlightController.setFlashlight(enable)
                true
            }
            "VIBRATE" -> {
                triggerVibration()
                true
            }
            "APP", "OPEN" -> {
                if (target.isNotBlank()) {
                    appLauncher.launchAppByVoiceQuery(target)
                    true
                } else false
            }
            "SETTINGS" -> {
                openSettings(target)
            }
            else -> false
        }
    }

    fun openWhatsApp(phoneNumber: String, message: String): Boolean {
        val cleanNumber = phoneNumber.filter { it.isDigit() }
        val encodedMsg = try {
            URLEncoder.encode(message, "UTF-8")
        } catch (_: Exception) {
            message
        }
        val uri = if (cleanNumber.isNotBlank()) {
            Uri.parse("https://api.whatsapp.com/send?phone=$cleanNumber&text=$encodedMsg")
        } else {
            Uri.parse("https://api.whatsapp.com/send?text=$encodedMsg")
        }
        val intent = Intent(Intent.ACTION_VIEW, uri).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK
            `package` = "com.whatsapp"
        }
        return try {
            context.startActivity(intent)
            true
        } catch (_: Exception) {
            // Fallback without package restriction (e.g. browser WhatsApp web)
            try {
                intent.`package` = null
                context.startActivity(intent)
                true
            } catch (_: Exception) {
                false
            }
        }
    }

    fun openSms(phoneNumber: String, message: String): Boolean {
        val cleanNumber = phoneNumber.filter { it.isDigit() || it == '+' }
        val uri = if (cleanNumber.isNotBlank()) Uri.parse("smsto:$cleanNumber") else Uri.parse("smsto:")
        val intent = Intent(Intent.ACTION_SENDTO, uri).apply {
            putExtra("sms_body", message)
            flags = Intent.FLAG_ACTIVITY_NEW_TASK
        }
        return try {
            context.startActivity(intent)
            true
        } catch (_: Exception) {
            false
        }
    }

    fun triggerVibration(durationMs: Long = 300L) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                val vibratorManager = context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager
                vibratorManager?.defaultVibrator?.vibrate(
                    VibrationEffect.createOneShot(durationMs, VibrationEffect.DEFAULT_AMPLITUDE)
                )
            } else {
                @Suppress("DEPRECATION")
                val vibrator = context.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    vibrator?.vibrate(VibrationEffect.createOneShot(durationMs, VibrationEffect.DEFAULT_AMPLITUDE))
                } else {
                    @Suppress("DEPRECATION")
                    vibrator?.vibrate(durationMs)
                }
            }
        } catch (_: Exception) {}
    }

    fun openSettings(action: String): Boolean {
        val settingsIntent = when (action.lowercase()) {
            "wifi" -> Intent(Settings.ACTION_WIFI_SETTINGS)
            "bluetooth" -> Intent(Settings.ACTION_BLUETOOTH_SETTINGS)
            "display" -> Intent(Settings.ACTION_DISPLAY_SETTINGS)
            else -> Intent(Settings.ACTION_SETTINGS)
        }.apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK
        }
        return try {
            context.startActivity(settingsIntent)
            true
        } catch (_: Exception) {
            false
        }
    }
}
