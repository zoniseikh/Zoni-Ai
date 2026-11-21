package com.zoni.jarvis.assistant.action

import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/**
 * Strict Allowlisted Typed Action Execution Protocol for Zoni AI Android.
 *
 * Every action is validated against the 20 allowlisted tool types with explicit permissions,
 * confirmation rules, timeout bounds, and structured honest outcomes.
 *
 * Strictly forbids:
 * - arbitrary shell commands
 * - arbitrary JavaScript execution
 * - unrestricted intents
 * - arbitrary file operations
 */
enum class AllowedActionType(
    val toolName: String,
    val requiredPermissions: List<String>,
    val requiresConfirmation: Boolean,
    val defaultTimeoutMs: Long
) {
    LIST_INSTALLED_APPS("list_installed_apps", emptyList(), false, 4000L),
    OPEN_APP("open_app", emptyList(), false, 4000L),
    OPEN_SYSTEM_SETTINGS("open_system_settings", emptyList(), false, 4000L),
    GO_HOME("go_home", listOf("ACCESSIBILITY_SERVICE"), false, 3000L),
    GO_BACK("go_back", listOf("ACCESSIBILITY_SERVICE"), false, 3000L),
    SCROLL_SCREEN("scroll_screen", listOf("ACCESSIBILITY_SERVICE"), false, 4000L),
    TAP_VISIBLE_ELEMENT("tap_visible_element", listOf("ACCESSIBILITY_SERVICE"), false, 4000L),
    ENTER_TEXT_IN_VISIBLE_FIELD("enter_text_in_visible_field", listOf("ACCESSIBILITY_SERVICE"), false, 4000L),
    READ_VISIBLE_SCREEN("read_visible_screen", listOf("ACCESSIBILITY_SERVICE"), false, 4000L),
    READ_NOTIFICATIONS("read_notifications", listOf("NOTIFICATION_LISTENER"), false, 3000L),
    PREPARE_WHATSAPP_MESSAGE("prepare_whatsapp_message", listOf("READ_CONTACTS"), true, 6000L),
    PREPARE_SMS("prepare_sms", listOf("READ_CONTACTS"), true, 6000L),
    PREPARE_APP_CHAT_MESSAGE("prepare_app_chat_message", listOf("ACCESSIBILITY_SERVICE"), true, 6000L),
    REQUEST_PERMISSION("request_permission", emptyList(), false, 5000L),
    FLASHLIGHT_CONTROL("flashlight_control", listOf("CAMERA"), false, 3000L),
    VOLUME_CONTROL("volume_control", emptyList(), false, 3000L),
    BATTERY_STATUS("battery_status", emptyList(), false, 2000L),
    CAMERA_OPEN("camera_open", listOf("CAMERA"), false, 4000L),
    CONTACT_SEARCH("contact_search", listOf("READ_CONTACTS"), false, 4000L),
    CALL_CONTACT("call_contact", listOf("READ_CONTACTS", "CALL_PHONE"), true, 6000L),
    CREATE_REMINDER("create_reminder", listOf("POST_NOTIFICATIONS"), false, 4000L),
    SEARCH_WEB("search_web", emptyList(), false, 4000L),
    SEARCH_YOUTUBE("search_youtube", emptyList(), false, 5000L),
    SEARCH_INSTALLED_APP("search_installed_app", emptyList(), false, 3000L),
    CANCEL_CURRENT_TASK("cancel_current_task", emptyList(), false, 2000L);

    companion object {
        fun fromToolName(name: String?): AllowedActionType? {
            val clean = name?.trim()?.lowercase() ?: return null
            if (clean == "search_contacts") return CONTACT_SEARCH
            if (clean == "set_flashlight") return FLASHLIGHT_CONTROL
            return entries.firstOrNull { it.toolName == clean }
        }
    }
}

data class TypedActionRequest(
    val actionId: String,
    val actionType: AllowedActionType,
    val arguments: Map<String, String>,
    val requiredPermissions: List<String>,
    val requiresConfirmation: Boolean,
    val timeoutMs: Long
)

data class PendingConfirmationDraft(
    val pendingActionId: String,
    val actionType: AllowedActionType,
    val recipientName: String,
    val phoneNumber: String,
    val messageText: String = "",
    val targetAppName: String = "",
    val targetPackageName: String = "",
    val notificationKey: String? = null,
    val canReplyViaNotification: Boolean = false,
    val createdAtMs: Long = System.currentTimeMillis()
)

data class TypedActionResult(
    val actionId: String,
    val actionType: String,
    val success: Boolean,
    val verified: Boolean = false,
    val awaitingConfirmation: Boolean = false,
    val pendingActionId: String? = null,
    val status: String,
    val message: String,
    val failureReason: String? = null,
    val requiredPermissions: List<String> = emptyList(),
    val data: JSONObject? = null
) {
    fun toJson(): String {
        val perms = JSONArray()
        requiredPermissions.forEach { perms.put(it) }
        val obj = JSONObject()
            .put("actionId", actionId)
            .put("actionType", actionType)
            .put("success", success)
            .put("verified", verified)
            .put("awaitingConfirmation", awaitingConfirmation)
            .put("status", status)
            .put("message", message)
            .put("requiredPermissions", perms)
        if (!pendingActionId.isNullOrBlank()) obj.put("pendingActionId", pendingActionId)
        if (!failureReason.isNullOrBlank()) obj.put("failureReason", failureReason)
        if (data != null) obj.put("data", data)
        return obj.toString()
    }
}

object ActionProtocolValidator {

    private val FORBIDDEN_ARG_PATTERNS = listOf(
        Regex("\\b(?:rm\\s+-rf|sudo|chmod|chown|mkfs|dd\\s+if=|bash\\s+-c|sh\\s+-c|su\\s+-c)\\b", RegexOption.IGNORE_CASE),
        Regex("(?:javascript:|eval\\(|new\\s+Function\\(|file:///etc/|/system/bin/)", RegexOption.IGNORE_CASE)
    )

    fun validate(rawActionType: String?, rawArgs: Map<String, String>, providedActionId: String? = null): Pair<TypedActionRequest?, TypedActionResult?> {
        val actionId = providedActionId?.takeIf { it.isNotBlank() } ?: "act_${UUID.randomUUID().toString().take(10)}"
        val resolvedType = AllowedActionType.fromToolName(rawActionType)
            ?: return Pair(
                null,
                TypedActionResult(
                    actionId = actionId,
                    actionType = rawActionType.orEmpty(),
                    success = false,
                    status = "blocked",
                    message = "Blocked disallowed action \"${rawActionType.orEmpty()}\". Only allowlisted Android assistant actions are permitted.",
                    failureReason = "action_not_allowlisted"
                )
            )

        // Check arguments for forbidden shell / JS / file injection payloads
        for ((k, v) in rawArgs) {
            if (FORBIDDEN_ARG_PATTERNS.any { it.containsMatchIn(v) }) {
                return Pair(
                    null,
                    TypedActionResult(
                        actionId = actionId,
                        actionType = resolvedType.toolName,
                        success = false,
                        status = "blocked",
                        message = "Blocked unsafe argument in \"$k\" by Zoni AI security policy.",
                        failureReason = "forbidden_payload_detected"
                    )
                )
            }
        }

        val sanitizedArgs = rawArgs.mapValues { (_, v) -> v.trim().take(1000) }
        val request = TypedActionRequest(
            actionId = actionId,
            actionType = resolvedType,
            arguments = sanitizedArgs,
            requiredPermissions = resolvedType.requiredPermissions,
            requiresConfirmation = resolvedType.requiresConfirmation,
            timeoutMs = resolvedType.defaultTimeoutMs
        )
        return Pair(request, null)
    }

    fun parseJsonRequest(requestJson: String): Pair<TypedActionRequest?, TypedActionResult?> {
        return try {
            val root = JSONObject(requestJson)
            val actionId = root.optString("actionId", "")
            val actionType = root.optString("actionType", root.optString("name", ""))
            val argsObj = root.optJSONObject("arguments") ?: root.optJSONObject("args") ?: JSONObject()
            val argsMap = mutableMapOf<String, String>()
            val keys = argsObj.keys()
            while (keys.hasNext()) {
                val key = keys.next()
                argsMap[key] = argsObj.opt(key)?.toString().orEmpty()
            }
            validate(actionType, argsMap, actionId)
        } catch (e: Exception) {
            Pair(
                null,
                TypedActionResult(
                    actionId = "act_invalid",
                    actionType = "unknown",
                    success = false,
                    status = "invalid_request",
                    message = "Malformed action request JSON.",
                    failureReason = e.message ?: "invalid_json"
                )
            )
        }
    }
}
