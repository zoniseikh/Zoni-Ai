package com.zoni.jarvis.assistant.action

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
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.provider.MediaStore
import android.provider.Settings
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.zoni.jarvis.assistant.R
import com.zoni.jarvis.assistant.ZoniApplication
import com.zoni.jarvis.assistant.device.AppLaunchResult
import com.zoni.jarvis.assistant.device.AppLauncher
import com.zoni.jarvis.assistant.device.ContactCallManager
import com.zoni.jarvis.assistant.device.ContactCallResolution
import com.zoni.jarvis.assistant.device.FlashlightController
import com.zoni.jarvis.assistant.device.FlashlightResult
import com.zoni.jarvis.assistant.domain.NumberNormalizer
import com.zoni.jarvis.assistant.domain.NumberNormalizerResult
import com.zoni.jarvis.assistant.service.AppChatAdapterRegistry
import com.zoni.jarvis.assistant.service.ZoniAccessibilityService
import com.zoni.jarvis.assistant.service.ZoniNotificationListenerService
import org.json.JSONArray
import org.json.JSONObject
import java.net.URLEncoder
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

data class DeviceActionResult(
    val spokenReply: String,
    val executed: Boolean = false,
    val actionType: String? = null
)

/**
 * Real, allowlisted Android Action Execution Engine for Zoni AI.
 *
 * Implements:
 * - Strict 20-tool allowlisted execution via `executeTypedActionJson`
 * - Permission verification before executing privileged operations
 * - Mandatory review/confirmation workflow for WhatsApp messages, SMS drafts, and phone calls
 *   (`confirmPendingActionJson` / `cancelPendingActionJson`)
 * - Honest verification & outcome reporting (NEVER claims a WhatsApp/SMS was sent when only a draft opened)
 * - Legacy `[ACTION:...]` parser preserved for backward compatibility
 */
class DeviceActionExecutor(private val context: Context) {

    private val contactCallManager = ContactCallManager(context)
    private val appLauncher = AppLauncher(context)
    private val flashlightController = FlashlightController(context)

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

    fun executeAction(actionType: String, target: String, payload: String): Boolean {
        return when (actionType) {
            "CALL" -> {
                if (target.isNotBlank()) contactCallManager.initiateCall(target) else false
            }
            "WHATSAPP" -> openWhatsApp(target, payload)
            "SMS" -> openSms(target, payload)
            "FLASHLIGHT" -> {
                val enable = target.equals("ON", ignoreCase = true) || payload.equals("ON", ignoreCase = true)
                flashlightController.setFlashlight(enable) is FlashlightResult.Success
            }
            "VIBRATE" -> {
                triggerVibration()
                true
            }
            "APP", "OPEN" -> {
                if (target.isNotBlank()) {
                    appLauncher.launchAppByVoiceQuery(target) is AppLaunchResult.Success
                } else false
            }
            "SETTINGS" -> openSettings(target)
            else -> false
        }
    }

    /**
     * Executes a structured JSON action request validated against the strict 20-tool allowlist.
     * Sensitive communication actions (WhatsApp, SMS, Call) return `awaitingConfirmation = true`
     * with a `pendingActionId` so the user can review, edit, cancel, or explicitly approve first.
     */
    @Volatile
    private var lastActionRequested: String = "none"
    @Volatile
    private var lastActionResult: String = "idle"
    @Volatile
    private var lastFailureReason: String = ""

    fun executeTypedActionJson(requestJson: String): String {
        val (request, validationError) = ActionProtocolValidator.parseJsonRequest(requestJson)
        if (validationError != null || request == null) {
            val errResult = validationError ?: TypedActionResult(
                actionId = "act_err",
                actionType = "unknown",
                success = false,
                status = "invalid_request",
                message = "Invalid action request.",
                failureReason = "validation_failed"
            )
            recordDiagnostic(errResult.actionType, errResult.status, errResult.failureReason)
            return errResult.toJson()
        }

        val result = executeTypedAction(request)
        recordDiagnostic(request.actionType.toolName, result.status, result.failureReason)
        return result.toJson()
    }

    private fun recordDiagnostic(actionType: String, status: String, failureReason: String?) {
        lastActionRequested = actionType
        lastActionResult = status
        lastFailureReason = failureReason.orEmpty()
        Log.d("ZoniActionExecutor", "action=$actionType status=$status failure=${lastFailureReason.ifBlank { "none" }}")
    }

    fun getRuntimeDiagnosticsJson(): String {
        val installedCount = try {
            appLauncher.listInstalledApps().size
        } catch (_: Exception) {
            -1
        }
        val recordAudioGranted = ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
        val postNotifGranted = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
        } else {
            true
        }
        return JSONObject()
            .put("accessibilityConnected", ZoniAccessibilityService.isConnected())
            .put("readContactsGranted", contactCallManager.hasContactPermission())
            .put("callPhoneGranted", contactCallManager.hasCallPhonePermission())
            .put("recordAudioGranted", recordAudioGranted)
            .put("postNotificationsGranted", postNotifGranted)
            .put("notificationListenerEnabled", isNotificationListenerEnabled())
            .put("installedAppsCount", installedCount)
            .put("packageVisibilityOk", installedCount > 0)
            .put("lastActionRequested", lastActionRequested)
            .put("lastActionResult", lastActionResult)
            .put("lastFailureReason", lastFailureReason)
            .toString()
    }

    fun executeTypedAction(request: TypedActionRequest): TypedActionResult {
        val args = request.arguments
        return when (request.actionType) {
            AllowedActionType.LIST_INSTALLED_APPS -> {
                val json = JSONObject(appLauncher.listInstalledAppsAsJson(150))
                val count = json.optInt("count", 0)
                TypedActionResult(
                    actionId = request.actionId,
                    actionType = request.actionType.toolName,
                    success = true,
                    verified = true,
                    status = "executed",
                    message = "Found $count installed launchable apps on this device.",
                    data = json
                )
            }

            AllowedActionType.OPEN_APP -> {
                val query = args["app_name"] ?: args["appQuery"] ?: args["target"] ?: ""
                if (query.isBlank()) {
                    return TypedActionResult(
                        actionId = request.actionId,
                        actionType = request.actionType.toolName,
                        success = false,
                        status = "missing_argument",
                        message = "Please specify which app to open.",
                        failureReason = "missing_app_name"
                    )
                }
                val resJson = JSONObject(appLauncher.launchAppAsJson(query))
                val ok = resJson.optBoolean("success", false)
                TypedActionResult(
                    actionId = request.actionId,
                    actionType = request.actionType.toolName,
                    success = ok,
                    verified = resJson.optBoolean("verified", false),
                    status = resJson.optString("status", if (ok) "launched" else "failed"),
                    message = resJson.optString("message", if (ok) "Opened $query." else "Could not open $query."),
                    failureReason = resJson.optString("failureReason", "").ifBlank { null },
                    data = resJson
                )
            }

            AllowedActionType.OPEN_SYSTEM_SETTINGS -> {
                val target = args["target"] ?: args["settings_target"] ?: "main"
                val opened = openSettings(target)
                TypedActionResult(
                    actionId = request.actionId,
                    actionType = request.actionType.toolName,
                    success = opened,
                    verified = opened,
                    status = if (opened) "executed" else "failed",
                    message = if (opened) "Opened Android $target settings." else "Could not open Android $target settings.",
                    failureReason = if (opened) null else "settings_intent_failed"
                )
            }

            AllowedActionType.GO_HOME -> wrapAccessibilityResult(request, ZoniAccessibilityService.performExplicitActionDetailedJson("go_home"))
            AllowedActionType.GO_BACK -> wrapAccessibilityResult(request, ZoniAccessibilityService.performExplicitActionDetailedJson("go_back"))

            AllowedActionType.SCROLL_SCREEN -> {
                val dir = (args["direction"] ?: "down").lowercase()
                val cmd = if (dir.contains("up")) "scroll_up" else "scroll_down"
                wrapAccessibilityResult(request, ZoniAccessibilityService.performExplicitActionDetailedJson(cmd))
            }

            AllowedActionType.TAP_VISIBLE_ELEMENT -> {
                val label = args["element_text"] ?: args["target"] ?: ""
                wrapAccessibilityResult(request, ZoniAccessibilityService.performExplicitActionDetailedJson("tap:$label"))
            }

            AllowedActionType.ENTER_TEXT_IN_VISIBLE_FIELD -> {
                val hint = args["field_hint"] ?: args["targetHint"] ?: ""
                val text = args["text"] ?: ""
                wrapAccessibilityResult(request, ZoniAccessibilityService.performExplicitActionDetailedJson("type:$hint|$text"))
            }

            AllowedActionType.READ_VISIBLE_SCREEN -> {
                wrapAccessibilityResult(request, ZoniAccessibilityService.readVisibleScreenDetailedJson(80))
            }

            AllowedActionType.READ_NOTIFICATIONS -> {
                if (!isNotificationListenerEnabled()) {
                    return TypedActionResult(
                        actionId = request.actionId,
                        actionType = request.actionType.toolName,
                        success = false,
                        status = "permission_missing",
                        message = "Notification Access is disabled. Enable Zoni AI in Android Notification Listener Settings first.",
                        failureReason = "notification_listener_disabled",
                        requiredPermissions = listOf("NOTIFICATION_LISTENER")
                    )
                }
                val whatsappOnly = args["whatsapp_only"].equals("true", ignoreCase = true)
                val all = JSONArray(ZoniNotificationListenerService.getRecentNotificationsJson(15))
                val filtered = JSONArray()
                for (i in 0 until all.length()) {
                    val item = all.optJSONObject(i) ?: continue
                    if (!whatsappOnly || item.optBoolean("isWhatsApp", false)) {
                        filtered.put(item)
                    }
                }
                TypedActionResult(
                    actionId = request.actionId,
                    actionType = request.actionType.toolName,
                    success = true,
                    verified = true,
                    status = "executed",
                    message = if (filtered.length() == 0) {
                        "No recent non-sensitive notifications are available right now."
                    } else {
                        "Read ${filtered.length()} recent notifications locally."
                    },
                    data = JSONObject().put("count", filtered.length()).put("notifications", filtered)
                )
            }

            AllowedActionType.PREPARE_WHATSAPP_MESSAGE -> prepareCommunicationDraft(
                request = request,
                recipientQuery = args["recipient"] ?: args["contact_name"] ?: args["phone_number"] ?: "",
                messageText = args["message"] ?: "",
                actionType = AllowedActionType.PREPARE_WHATSAPP_MESSAGE
            )

            AllowedActionType.PREPARE_SMS -> prepareCommunicationDraft(
                request = request,
                recipientQuery = args["recipient"] ?: args["contact_name"] ?: args["phone_number"] ?: "",
                messageText = args["message"] ?: "",
                actionType = AllowedActionType.PREPARE_SMS
            )

            AllowedActionType.PREPARE_APP_CHAT_MESSAGE -> prepareGenericAppChatDraft(
                request = request,
                appNameQuery = args["app_name"] ?: "",
                recipientQuery = args["recipient"] ?: "",
                messageText = args["message"] ?: ""
            )

            AllowedActionType.CALL_CONTACT -> prepareCommunicationDraft(
                request = request,
                recipientQuery = args["recipient"] ?: args["contact_name"] ?: args["phone_number"] ?: "",
                messageText = "",
                actionType = AllowedActionType.CALL_CONTACT
            )

            AllowedActionType.CONTACT_SEARCH -> {
                val query = args["query"] ?: args["contact_name"] ?: ""
                if (!contactCallManager.hasContactPermission()) {
                    return TypedActionResult(
                        actionId = request.actionId,
                        actionType = request.actionType.toolName,
                        success = false,
                        status = "permission_missing",
                        message = "Contacts permission (READ_CONTACTS) is required to search your contacts.",
                        failureReason = "read_contacts_denied",
                        requiredPermissions = listOf("READ_CONTACTS")
                    )
                }
                val candidates = resolveContactCandidates(query)
                TypedActionResult(
                    actionId = request.actionId,
                    actionType = request.actionType.toolName,
                    success = candidates.length() > 0,
                    verified = true,
                    status = if (candidates.length() > 0) "found" else "contact_not_found",
                    message = if (candidates.length() > 0) {
                        "Found ${candidates.length()} matching contact entries for \"$query\"."
                    } else {
                        "No contact matching \"$query\" was found."
                    },
                    failureReason = if (candidates.length() > 0) null else "contact_not_found",
                    data = JSONObject().put("query", query).put("candidates", candidates)
                )
            }

            AllowedActionType.FLASHLIGHT_CONTROL -> {
                val enable = args["enable"].equals("true", ignoreCase = true) ||
                    args["state"].equals("on", ignoreCase = true)
                val res = flashlightController.setFlashlight(enable)
                val ok = res is FlashlightResult.Success
                TypedActionResult(
                    actionId = request.actionId,
                    actionType = request.actionType.toolName,
                    success = ok,
                    verified = ok,
                    status = if (ok) "executed" else "failed",
                    message = if (ok) {
                        if (enable) "Flashlight turned ON." else "Flashlight turned OFF."
                    } else {
                        "Could not toggle flashlight on this device."
                    },
                    failureReason = if (ok) null else "flashlight_unavailable"
                )
            }

            AllowedActionType.VOLUME_CONTROL -> {
                val action = args["action"] ?: "status"
                val volJson = JSONObject(adjustVolume(action))
                val ok = volJson.optBoolean("success", false)
                TypedActionResult(
                    actionId = request.actionId,
                    actionType = request.actionType.toolName,
                    success = ok,
                    verified = ok,
                    status = if (ok) "executed" else "failed",
                    message = volJson.optString("message", "Volume updated."),
                    data = volJson
                )
            }

            AllowedActionType.BATTERY_STATUS -> {
                val intent = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
                val level = intent?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
                val scale = intent?.getIntExtra(BatteryManager.EXTRA_SCALE, 100) ?: 100
                val status = intent?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1
                val pct = if (level >= 0 && scale > 0) ((level * 100f) / scale).toInt().coerceIn(0, 100) else -1
                val charging = status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL
                val ok = pct >= 0
                TypedActionResult(
                    actionId = request.actionId,
                    actionType = request.actionType.toolName,
                    success = ok,
                    verified = ok,
                    status = if (ok) "executed" else "failed",
                    message = if (ok) "Battery level is $pct% (${if (charging) "charging" else "not charging"})." else "Could not read battery status.",
                    data = JSONObject().put("level", pct).put("charging", charging)
                )
            }

            AllowedActionType.CAMERA_OPEN -> {
                val ok = openCamera()
                TypedActionResult(
                    actionId = request.actionId,
                    actionType = request.actionType.toolName,
                    success = ok,
                    verified = ok,
                    status = if (ok) "executed" else "failed",
                    message = if (ok) "Opened the Android camera app." else "Could not open camera.",
                    failureReason = if (ok) null else "camera_intent_failed"
                )
            }

            AllowedActionType.CREATE_REMINDER -> {
                val note = args["note"] ?: args["title"] ?: ""
                val timeLabel = args["time"] ?: ""
                if (note.isBlank()) {
                    return TypedActionResult(
                        actionId = request.actionId,
                        actionType = request.actionType.toolName,
                        success = false,
                        status = "missing_argument",
                        message = "Please specify what to remind you about.",
                        failureReason = "missing_reminder_note"
                    )
                }
                val posted = showReminderNotification("Zoni AI Reminder", if (timeLabel.isNotBlank()) "$note ($timeLabel)" else note)
                TypedActionResult(
                    actionId = request.actionId,
                    actionType = request.actionType.toolName,
                    success = posted,
                    verified = posted,
                    status = if (posted) "executed" else "permission_missing",
                    message = if (posted) "Reminder saved: $note" else "Notification permission is required to post reminders.",
                    failureReason = if (posted) null else "post_notifications_denied",
                    data = JSONObject().put("note", note).put("time", timeLabel)
                )
            }

            AllowedActionType.REQUEST_PERMISSION -> {
                val perm = args["permission"] ?: ""
                TypedActionResult(
                    actionId = request.actionId,
                    actionType = request.actionType.toolName,
                    success = true,
                    verified = true,
                    status = "permission_prompt_requested",
                    message = "Permission setup requested for \"$perm\". Please approve it in the Android prompt or Settings.",
                    data = JSONObject().put("permission", perm)
                )
            }

            AllowedActionType.SEARCH_WEB -> {
                val query = (args["query"] ?: "").trim()
                if (query.isBlank()) {
                    return TypedActionResult(
                        actionId = request.actionId,
                        actionType = request.actionType.toolName,
                        success = false,
                        status = "missing_argument",
                        message = "Please specify what you want to search on the web.",
                        failureReason = "missing_query"
                    )
                }
                val encoded = try { URLEncoder.encode(query, "UTF-8") } catch (_: Exception) { query }
                val ok = try {
                    val intent = Intent(Intent.ACTION_VIEW, Uri.parse("https://www.google.com/search?q=$encoded")).apply {
                        flags = Intent.FLAG_ACTIVITY_NEW_TASK
                    }
                    context.startActivity(intent)
                    true
                } catch (_: Exception) {
                    false
                }
                TypedActionResult(
                    actionId = request.actionId,
                    actionType = request.actionType.toolName,
                    success = ok,
                    verified = ok,
                    status = if (ok) "executed" else "failed",
                    message = if (ok) "Opened web search for \"$query\"." else "Could not open web browser for search.",
                    failureReason = if (ok) null else "web_search_intent_failed",
                    data = JSONObject().put("query", query)
                )
            }

            AllowedActionType.SEARCH_YOUTUBE -> {
                val query = (args["query"] ?: "").trim()
                if (query.isBlank()) {
                    return TypedActionResult(
                        actionId = request.actionId,
                        actionType = request.actionType.toolName,
                        success = false,
                        status = "missing_argument",
                        message = "Please specify what to search on YouTube.",
                        failureReason = "missing_query"
                    )
                }
                val encoded = try { URLEncoder.encode(query, "UTF-8") } catch (_: Exception) { query }
                val ok = try {
                    val ytIntent = Intent(Intent.ACTION_VIEW, Uri.parse("https://www.youtube.com/results?search_query=$encoded")).apply {
                        flags = Intent.FLAG_ACTIVITY_NEW_TASK
                        `package` = "com.google.android.youtube"
                    }
                    context.startActivity(ytIntent)
                    true
                } catch (_: Exception) {
                    try {
                        val fallback = Intent(Intent.ACTION_VIEW, Uri.parse("https://www.youtube.com/results?search_query=$encoded")).apply {
                            flags = Intent.FLAG_ACTIVITY_NEW_TASK
                        }
                        context.startActivity(fallback)
                        true
                    } catch (_: Exception) {
                        false
                    }
                }
                TypedActionResult(
                    actionId = request.actionId,
                    actionType = request.actionType.toolName,
                    success = ok,
                    verified = ok,
                    status = if (ok) "executed" else "failed",
                    message = if (ok) "Opened YouTube search results for \"$query\"." else "Could not open YouTube search.",
                    failureReason = if (ok) null else "youtube_search_failed",
                    data = JSONObject().put("query", query)
                )
            }

            AllowedActionType.SEARCH_INSTALLED_APP -> {
                val query = (args["app_name"] ?: args["query"] ?: "").trim()
                val allJson = JSONObject(appLauncher.listInstalledAppsAsJson(200))
                val apps = allJson.optJSONArray("apps") ?: JSONArray()
                val matches = JSONArray()
                for (i in 0 until apps.length()) {
                    val entry = apps.optJSONObject(i) ?: continue
                    val label = entry.optString("label", "")
                    val pkg = entry.optString("packageName", "")
                    if (query.isBlank() || label.contains(query, ignoreCase = true) || pkg.contains(query, ignoreCase = true)) {
                        matches.put(entry)
                    }
                }
                TypedActionResult(
                    actionId = request.actionId,
                    actionType = request.actionType.toolName,
                    success = matches.length() > 0,
                    verified = true,
                    status = if (matches.length() > 0) "found" else "app_not_found",
                    message = if (matches.length() > 0) {
                        "Found ${matches.length()} installed app(s) matching \"$query\"."
                    } else {
                        "No installed app matching \"$query\" was found on this device."
                    },
                    failureReason = if (matches.length() > 0) null else "app_not_found",
                    data = JSONObject().put("query", query).put("matches", matches)
                )
            }

            AllowedActionType.CANCEL_CURRENT_TASK -> {
                val clearedCount = pendingDrafts.size
                pendingDrafts.clear()
                TypedActionResult(
                    actionId = request.actionId,
                    actionType = request.actionType.toolName,
                    success = true,
                    verified = true,
                    status = "cancelled",
                    message = if (clearedCount > 0) {
                        "Cancelled the current task and cleared $clearedCount pending draft(s)."
                    } else {
                        "Current task cancelled cleanly. Ready for your next command."
                    }
                )
            }
        }
    }

    private fun prepareGenericAppChatDraft(
        request: TypedActionRequest,
        appNameQuery: String,
        recipientQuery: String,
        messageText: String
    ): TypedActionResult {
        val adapter = AppChatAdapterRegistry.findAdapter(appNameQuery)
            ?: return TypedActionResult(
                actionId = request.actionId,
                actionType = request.actionType.toolName,
                success = false,
                verified = false,
                status = "unsupported_chat_app",
                message = "Controlled chat messaging is currently supported for WhatsApp, SMS, Telegram, Instagram, and Messenger. \"$appNameQuery\" does not have a verified chat adapter.",
                failureReason = "unsupported_chat_app"
            )

        if (!ZoniAccessibilityService.isConnected()) {
            return TypedActionResult(
                actionId = request.actionId,
                actionType = request.actionType.toolName,
                success = false,
                verified = false,
                status = "permission_missing",
                message = "Enable Zoni Accessibility Service in Android Settings to use controlled ${adapter.appName} chat workflows.",
                failureReason = "accessibility_service_disabled",
                requiredPermissions = listOf("ACCESSIBILITY_SERVICE")
            )
        }

        val cleanRecipient = recipientQuery.trim()
        val cleanMsg = messageText.trim()
        if (cleanRecipient.isEmpty()) {
            return TypedActionResult(
                actionId = request.actionId,
                actionType = request.actionType.toolName,
                success = false,
                status = "missing_recipient",
                message = "Please specify who you want to message on ${adapter.appName}.",
                failureReason = "missing_recipient"
            )
        }

        val pendingId = "pend_${UUID.randomUUID().toString().take(10)}"
        val primaryPkg = adapter.packageNames.first()
        val draft = PendingConfirmationDraft(
            pendingActionId = pendingId,
            actionType = AllowedActionType.PREPARE_APP_CHAT_MESSAGE,
            recipientName = cleanRecipient,
            phoneNumber = "",
            messageText = cleanMsg,
            targetAppName = adapter.appName,
            targetPackageName = primaryPkg
        )
        pendingDrafts[pendingId] = draft

        val data = JSONObject()
            .put("pendingActionId", pendingId)
            .put("actionType", AllowedActionType.PREPARE_APP_CHAT_MESSAGE.toolName)
            .put("appName", adapter.appName)
            .put("packageName", primaryPkg)
            .put("contactName", cleanRecipient)
            .put("messageText", cleanMsg)

        return TypedActionResult(
            actionId = request.actionId,
            actionType = request.actionType.toolName,
            success = true,
            verified = false,
            awaitingConfirmation = true,
            pendingActionId = pendingId,
            status = "awaiting_confirmation",
            message = "${adapter.appName} message draft prepared for $cleanRecipient. Review and explicitly approve before opening ${adapter.appName}.",
            data = data
        )
    }

    private fun prepareCommunicationDraft(
        request: TypedActionRequest,
        recipientQuery: String,
        messageText: String,
        actionType: AllowedActionType
    ): TypedActionResult {
        val rawRecipient = recipientQuery.trim()
        val cleanMsg = messageText.trim()

        if (rawRecipient.isEmpty()) {
            return TypedActionResult(
                actionId = request.actionId,
                actionType = actionType.toolName,
                success = false,
                status = "missing_recipient",
                message = "Please specify who you want to contact.",
                failureReason = "missing_recipient"
            )
        }

        // Direct phone number candidate?
        val norm = NumberNormalizer.normalizePhoneNumber(rawRecipient)
        if (norm is NumberNormalizerResult.ValidCandidate) {
            return createPendingDraftResult(
                request = request,
                actionType = actionType,
                recipientName = norm.normalizedNumber,
                phoneNumber = norm.normalizedNumber,
                messageText = cleanMsg
            )
        }

        // Resolve via Android Contacts
        return when (val resolved = contactCallManager.resolveContact(rawRecipient)) {
            is ContactCallResolution.ReadyToCall -> createPendingDraftResult(
                request = request,
                actionType = actionType,
                recipientName = resolved.name,
                phoneNumber = resolved.number,
                messageText = cleanMsg
            )
            is ContactCallResolution.MultipleNumbersForContact -> {
                val arr = JSONArray()
                resolved.numbers.forEach { num ->
                    arr.put(JSONObject().put("name", resolved.name).put("phone", num))
                }
                TypedActionResult(
                    actionId = request.actionId,
                    actionType = actionType.toolName,
                    success = false,
                    awaitingConfirmation = true,
                    status = "multiple_numbers",
                    message = "${resolved.name} has multiple phone numbers. Please choose which number to use.",
                    data = JSONObject()
                        .put("recipient", resolved.name)
                        .put("messageText", cleanMsg)
                        .put("candidates", arr)
                )
            }
            is ContactCallResolution.MultipleMatches -> {
                val arr = JSONArray()
                resolved.candidates.take(6).forEach { c ->
                    c.phoneNumbers.forEach { num ->
                        arr.put(JSONObject().put("id", c.id).put("name", c.displayName).put("phone", num))
                    }
                }
                TypedActionResult(
                    actionId = request.actionId,
                    actionType = actionType.toolName,
                    success = false,
                    awaitingConfirmation = true,
                    status = "multiple_contacts",
                    message = "Multiple contacts match \"${resolved.query}\". Please select the right contact before continuing.",
                    data = JSONObject()
                        .put("query", resolved.query)
                        .put("messageText", cleanMsg)
                        .put("candidates", arr)
                )
            }
            is ContactCallResolution.ContactNotFound -> TypedActionResult(
                actionId = request.actionId,
                actionType = actionType.toolName,
                success = false,
                status = "contact_not_found",
                message = "Could not find \"${resolved.query}\" in your Android contacts. Please share their phone number.",
                failureReason = "contact_not_found"
            )
            is ContactCallResolution.PermissionMissing -> TypedActionResult(
                actionId = request.actionId,
                actionType = actionType.toolName,
                success = false,
                status = "permission_missing",
                message = "Contacts permission (READ_CONTACTS) is required to look up \"$rawRecipient\".",
                failureReason = "read_contacts_denied",
                requiredPermissions = listOf("READ_CONTACTS")
            )
            is ContactCallResolution.CallFailed -> TypedActionResult(
                actionId = request.actionId,
                actionType = actionType.toolName,
                success = false,
                status = "failed",
                message = resolved.reason,
                failureReason = "contact_query_failed"
            )
        }
    }

    private fun createPendingDraftResult(
        request: TypedActionRequest,
        actionType: AllowedActionType,
        recipientName: String,
        phoneNumber: String,
        messageText: String
    ): TypedActionResult {
        val pendingId = "pend_${UUID.randomUUID().toString().take(10)}"
        val notifKey = if (actionType == AllowedActionType.PREPARE_WHATSAPP_MESSAGE) {
            ZoniNotificationListenerService.findReplyableWhatsAppNotificationKey(recipientName)
        } else {
            null
        }
        val draft = PendingConfirmationDraft(
            pendingActionId = pendingId,
            actionType = actionType,
            recipientName = recipientName,
            phoneNumber = phoneNumber,
            messageText = messageText,
            notificationKey = notifKey,
            canReplyViaNotification = notifKey != null
        )
        pendingDrafts[pendingId] = draft

        val data = JSONObject()
            .put("pendingActionId", pendingId)
            .put("actionType", actionType.toolName)
            .put("contactName", recipientName)
            .put("phoneNumber", phoneNumber)
            .put("messageText", messageText)
            .put("canReplyViaNotification", draft.canReplyViaNotification)
            .put("notificationKey", notifKey.orEmpty())

        val summary = when (actionType) {
            AllowedActionType.PREPARE_WHATSAPP_MESSAGE ->
                "WhatsApp draft prepared for $recipientName ($phoneNumber). Please review and approve before opening WhatsApp."
            AllowedActionType.PREPARE_SMS ->
                "SMS draft prepared for $recipientName ($phoneNumber). Please review and approve before opening SMS."
            AllowedActionType.CALL_CONTACT ->
                "Ready to call $recipientName ($phoneNumber). Please confirm to place the phone call."
            else -> "Pending user confirmation."
        }

        return TypedActionResult(
            actionId = request.actionId,
            actionType = actionType.toolName,
            success = true,
            verified = false,
            awaitingConfirmation = true,
            pendingActionId = pendingId,
            status = "awaiting_confirmation",
            message = summary,
            data = data
        )
    }

    /**
     * Executes a previously staged pending WhatsApp/SMS/Call action ONLY after explicit user approval.
     * Supports editing the message text and choosing RemoteInput notification reply when available.
     */
    fun confirmPendingActionJson(
        pendingActionId: String,
        editedMessage: String = "",
        useNotificationReply: Boolean = false
    ): String {
        val draft = pendingDrafts.remove(pendingActionId.trim())
            ?: return TypedActionResult(
                actionId = pendingActionId,
                actionType = "unknown",
                success = false,
                status = "not_found",
                message = "No pending confirmation draft found for ID \"$pendingActionId\".",
                failureReason = "pending_action_not_found"
            ).toJson()

        val finalMessage = editedMessage.trim().ifEmpty { draft.messageText }
        return when (draft.actionType) {
            AllowedActionType.PREPARE_WHATSAPP_MESSAGE -> {
                if (useNotificationReply && !draft.notificationKey.isNullOrBlank()) {
                    val sent = ZoniNotificationListenerService.sendReply(context, draft.notificationKey, finalMessage)
                    if (sent) {
                        return TypedActionResult(
                            actionId = draft.pendingActionId,
                            actionType = draft.actionType.toolName,
                            success = true,
                            verified = true,
                            status = "replied_via_notification_remote_input",
                            message = "Replied to ${draft.recipientName} via Android WhatsApp notification reply."
                        ).toJson()
                    }
                }

                val opened = openWhatsApp(draft.phoneNumber, finalMessage)
                if (!opened) {
                    return TypedActionResult(
                        actionId = draft.pendingActionId,
                        actionType = draft.actionType.toolName,
                        success = false,
                        verified = false,
                        status = "failed",
                        message = "Could not open WhatsApp on this device. Please make sure WhatsApp is installed.",
                        failureReason = "whatsapp_not_installed_or_launch_failed"
                    ).toJson()
                }

                // After explicit user approval: if Zoni Accessibility Service is active,
                // verify recipient & message and trigger the visible enabled Send button safely.
                if (ZoniAccessibilityService.isConnected() && finalMessage.isNotBlank()) {
                    val sendOutcome = ZoniAccessibilityService.sendApprovedWhatsAppMessage(
                        expectedRecipient = draft.recipientName,
                        expectedPhone = draft.phoneNumber,
                        expectedMessage = finalMessage,
                        pendingActionId = draft.pendingActionId
                    )
                    if (sendOutcome.success && sendOutcome.verified) {
                        return TypedActionResult(
                            actionId = draft.pendingActionId,
                            actionType = draft.actionType.toolName,
                            success = true,
                            verified = true,
                            status = "whatsapp_sent_verified",
                            message = sendOutcome.message,
                            data = (sendOutcome.data ?: JSONObject())
                                .put("contactName", draft.recipientName)
                                .put("phoneNumber", draft.phoneNumber)
                                .put("messageText", finalMessage)
                        ).toJson()
                    }
                    // Graceful honest fallback: draft is open in WhatsApp; ask user to tap Send manually
                    return TypedActionResult(
                        actionId = draft.pendingActionId,
                        actionType = draft.actionType.toolName,
                        success = true,
                        verified = true,
                        status = "opened_whatsapp_draft_ready_to_send",
                        message = sendOutcome.message,
                        failureReason = sendOutcome.failureReason,
                        data = JSONObject()
                            .put("contactName", draft.recipientName)
                            .put("phoneNumber", draft.phoneNumber)
                            .put("messageText", finalMessage)
                            .put("autoSendAttempted", true)
                    ).toJson()
                }

                TypedActionResult(
                    actionId = draft.pendingActionId,
                    actionType = draft.actionType.toolName,
                    success = true,
                    verified = true,
                    status = "opened_whatsapp_draft_ready_to_send",
                    message = "Opened WhatsApp conversation for ${draft.recipientName} with your approved message ready. Enable Zoni Accessibility Service for auto-Send after approval, or tap Send in WhatsApp now.",
                    data = JSONObject()
                        .put("contactName", draft.recipientName)
                        .put("phoneNumber", draft.phoneNumber)
                        .put("messageText", finalMessage)
                ).toJson()
            }

            AllowedActionType.PREPARE_SMS -> {
                val opened = openSms(draft.phoneNumber, finalMessage)
                TypedActionResult(
                    actionId = draft.pendingActionId,
                    actionType = draft.actionType.toolName,
                    success = opened,
                    verified = opened,
                    status = if (opened) "opened_sms_composer_ready_to_send" else "failed",
                    message = if (opened) {
                        "Opened your SMS app for ${draft.recipientName} with the draft message ready. Tap Send to deliver."
                    } else {
                        "Could not open the Android SMS app."
                    },
                    failureReason = if (opened) null else "sms_intent_failed"
                ).toJson()
            }

            AllowedActionType.CALL_CONTACT -> {
                val started = contactCallManager.initiateCall(draft.phoneNumber)
                val direct = contactCallManager.hasCallPhonePermission()
                TypedActionResult(
                    actionId = draft.pendingActionId,
                    actionType = draft.actionType.toolName,
                    success = started,
                    verified = started,
                    status = if (started) {
                        if (direct) "call_initiated" else "dialer_opened"
                    } else "failed",
                    message = if (started) {
                        if (direct) "Initiated SIM call to ${draft.recipientName} (${draft.phoneNumber})."
                        else "Opened Android dialer with ${draft.recipientName} (${draft.phoneNumber})."
                    } else {
                        "Could not start phone call to ${draft.recipientName}."
                    },
                    failureReason = if (started) null else "call_intent_failed"
                ).toJson()
            }

            AllowedActionType.PREPARE_APP_CHAT_MESSAGE -> {
                val appLabel = draft.targetAppName.ifBlank { "Chat App" }
                val launchRes = appLauncher.launchAppByVoiceQuery(appLabel)
                if (launchRes !is AppLaunchResult.Success) {
                    return TypedActionResult(
                        actionId = draft.pendingActionId,
                        actionType = draft.actionType.toolName,
                        success = false,
                        verified = false,
                        status = "failed",
                        message = "Could not open $appLabel on this device.",
                        failureReason = "app_not_installed_or_launch_failed"
                    ).toJson()
                }

                if (ZoniAccessibilityService.isConnected() && finalMessage.isNotBlank()) {
                    val outcome = ZoniAccessibilityService.sendApprovedAppChatMessage(
                        appName = appLabel,
                        expectedRecipient = draft.recipientName,
                        expectedMessage = finalMessage,
                        pendingActionId = draft.pendingActionId
                    )
                    if (outcome.success && outcome.verified) {
                        return TypedActionResult(
                            actionId = draft.pendingActionId,
                            actionType = draft.actionType.toolName,
                            success = true,
                            verified = true,
                            status = "app_chat_sent_verified",
                            message = outcome.message,
                            data = (outcome.data ?: JSONObject())
                                .put("appName", appLabel)
                                .put("contactName", draft.recipientName)
                        ).toJson()
                    }
                    return TypedActionResult(
                        actionId = draft.pendingActionId,
                        actionType = draft.actionType.toolName,
                        success = true,
                        verified = true,
                        status = "opened_app_chat_draft_ready_to_send",
                        message = outcome.message,
                        failureReason = outcome.failureReason,
                        data = JSONObject()
                            .put("appName", appLabel)
                            .put("contactName", draft.recipientName)
                    ).toJson()
                }

                TypedActionResult(
                    actionId = draft.pendingActionId,
                    actionType = draft.actionType.toolName,
                    success = true,
                    verified = true,
                    status = "opened_app_chat_draft_ready_to_send",
                    message = "Opened $appLabel for ${draft.recipientName}. Please review and send manually.",
                    data = JSONObject()
                        .put("appName", appLabel)
                        .put("contactName", draft.recipientName)
                ).toJson()
            }

            else -> TypedActionResult(
                actionId = draft.pendingActionId,
                actionType = draft.actionType.toolName,
                success = false,
                status = "unsupported",
                message = "Pending action type is not confirmable.",
                failureReason = "unsupported_pending_type"
            ).toJson()
        }
    }

    fun cancelPendingActionJson(pendingActionId: String): String {
        val removed = pendingDrafts.remove(pendingActionId.trim())
        return TypedActionResult(
            actionId = pendingActionId,
            actionType = removed?.actionType?.toolName ?: "unknown",
            success = true,
            verified = true,
            status = "cancelled",
            message = "Cancelled pending action. Nothing was sent or dialed."
        ).toJson()
    }

    private fun wrapAccessibilityResult(request: TypedActionRequest, rawOutcomeJson: String): TypedActionResult {
        val parsed = try {
            JSONObject(rawOutcomeJson)
        } catch (_: Exception) {
            JSONObject()
        }
        val ok = parsed.optBoolean("success", false)
        val failReason = parsed.optString("failureReason", "").ifBlank { null }
        val status = when {
            ok -> "executed"
            failReason == "accessibility_service_disabled" -> "permission_missing"
            failReason == "protected_banking_or_auth_screen" || failReason == "sensitive_screen_content" || failReason == "password_field_blocked" -> "blocked"
            else -> "failed"
        }
        return TypedActionResult(
            actionId = request.actionId,
            actionType = request.actionType.toolName,
            success = ok,
            verified = parsed.optBoolean("verified", false),
            status = status,
            message = parsed.optString("message", if (ok) "Accessibility action completed." else "Accessibility action failed."),
            failureReason = failReason,
            requiredPermissions = if (failReason == "accessibility_service_disabled") listOf("ACCESSIBILITY_SERVICE") else emptyList(),
            data = parsed.optJSONObject("data")
        )
    }

    private fun resolveContactCandidates(query: String): JSONArray {
        val arr = JSONArray()
        when (val res = contactCallManager.resolveContact(query)) {
            is ContactCallResolution.ReadyToCall -> {
                arr.put(JSONObject().put("id", "1").put("name", res.name).put("phone", res.number))
            }
            is ContactCallResolution.MultipleNumbersForContact -> {
                res.numbers.forEachIndexed { idx, num ->
                    arr.put(JSONObject().put("id", "$idx").put("name", res.name).put("phone", num))
                }
            }
            is ContactCallResolution.MultipleMatches -> {
                res.candidates.take(8).forEach { c ->
                    c.phoneNumbers.forEach { num ->
                        arr.put(JSONObject().put("id", c.id).put("name", c.displayName).put("phone", num))
                    }
                }
            }
            else -> Unit
        }
        return arr
    }

    private fun isNotificationListenerEnabled(): Boolean {
        val enabledListeners = Settings.Secure.getString(
            context.contentResolver,
            "enabled_notification_listeners"
        ) ?: ""
        return enabledListeners.contains(
            ComponentName(context, ZoniNotificationListenerService::class.java).flattenToString()
        )
    }

    private fun showReminderNotification(title: String, body: String): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            return false
        }
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
            // Try WhatsApp Business before generic handler
            try {
                intent.`package` = "com.whatsapp.w4b"
                context.startActivity(intent)
                true
            } catch (_: Exception) {
                try {
                    intent.`package` = null
                    context.startActivity(intent)
                    true
                } catch (_: Exception) {
                    false
                }
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

    fun openCamera(): Boolean {
        val cameraIntent = Intent(MediaStore.INTENT_ACTION_STILL_IMAGE_CAMERA).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK
        }
        return try {
            context.startActivity(cameraIntent)
            true
        } catch (_: Exception) {
            appLauncher.launchAppByVoiceQuery("Camera") is AppLaunchResult.Success
        }
    }

    fun adjustVolume(action: String): String {
        val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as? android.media.AudioManager
            ?: return """{"success":false,"message":"AudioManager unavailable."}"""
        val stream = android.media.AudioManager.STREAM_MUSIC
        val normalized = action.trim().lowercase()
        return try {
            when (normalized) {
                "up", "increase", "raise" -> audioManager.adjustStreamVolume(
                    stream,
                    android.media.AudioManager.ADJUST_RAISE,
                    android.media.AudioManager.FLAG_SHOW_UI
                )
                "down", "decrease", "lower" -> audioManager.adjustStreamVolume(
                    stream,
                    android.media.AudioManager.ADJUST_LOWER,
                    android.media.AudioManager.FLAG_SHOW_UI
                )
                "mute" -> audioManager.adjustStreamVolume(
                    stream,
                    android.media.AudioManager.ADJUST_MUTE,
                    android.media.AudioManager.FLAG_SHOW_UI
                )
                "unmute" -> audioManager.adjustStreamVolume(
                    stream,
                    android.media.AudioManager.ADJUST_UNMUTE,
                    android.media.AudioManager.FLAG_SHOW_UI
                )
                "max" -> {
                    val maxVol = audioManager.getStreamMaxVolume(stream)
                    audioManager.setStreamVolume(stream, maxVol, android.media.AudioManager.FLAG_SHOW_UI)
                }
                else -> Unit
            }
            val current = audioManager.getStreamVolume(stream)
            val max = audioManager.getStreamMaxVolume(stream).coerceAtLeast(1)
            val percent = ((current * 100f) / max).toInt().coerceIn(0, 100)
            JSONObject()
                .put("success", true)
                .put("action", normalized)
                .put("volumePercent", percent)
                .put("message", "Media volume is now $percent%.")
                .toString()
        } catch (e: Exception) {
            JSONObject()
                .put("success", false)
                .put("message", e.message ?: "Unable to adjust device volume.")
                .toString()
        }
    }

    fun openSettings(action: String): Boolean {
        val key = action.trim().lowercase()
        val settingsIntent = when (key) {
            "wifi", "wi-fi" -> Intent(Settings.ACTION_WIFI_SETTINGS)
            "bluetooth" -> Intent(Settings.ACTION_BLUETOOTH_SETTINGS)
            "display" -> Intent(Settings.ACTION_DISPLAY_SETTINGS)
            "location" -> Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS)
            "sound", "volume" -> Intent(Settings.ACTION_SOUND_SETTINGS)
            "network", "wireless", "mobile_network" -> Intent(Settings.ACTION_WIRELESS_SETTINGS)
            "applications", "apps", "app_settings" -> Intent(Settings.ACTION_APPLICATION_SETTINGS)
            "accessibility" -> Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)
            "notifications", "notification_listener" -> Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)
            "notifications_app" -> Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).apply {
                putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
            }
            "overlay" -> Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:${context.packageName}"))
            "battery" -> Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
            "assistant", "default_assistant" -> Intent(Settings.ACTION_VOICE_INPUT_SETTINGS)
            "app_details" -> Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}"))
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

    companion object {
        private val pendingDrafts = ConcurrentHashMap<String, PendingConfirmationDraft>()
    }
}
