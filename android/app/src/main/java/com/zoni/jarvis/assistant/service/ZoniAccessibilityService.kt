package com.zoni.jarvis.assistant.service

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.graphics.Path
import android.graphics.Rect
import android.os.Build
import android.os.Bundle
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

data class AccessibilityActionOutcome(
    val success: Boolean,
    val verified: Boolean,
    val actionType: String,
    val activePackage: String = "",
    val message: String,
    val failureReason: String? = null,
    val data: JSONObject? = null,
    val target: String = "",
    val executionStatus: String = if (success) "executed" else (failureReason ?: "failed")
) {
    fun toJson(): String {
        val obj = JSONObject()
            .put("success", success)
            .put("verified", verified)
            .put("actionType", actionType)
            .put("target", target)
            .put("activePackage", activePackage)
            .put("executionStatus", executionStatus)
            .put("status", executionStatus)
            .put("message", message)
        if (!failureReason.isNullOrBlank()) {
            obj.put("failureReason", failureReason)
        }
        if (data != null) {
            obj.put("data", data)
        }
        return obj.toString()
    }
}

/**
 * Genuine, security-hardened Android AccessibilityService for Zoni AI.
 *
 * Strictly executes ONLY explicitly user-requested actions:
 * - Semantic AccessibilityNodeInfo tapping (with bounded node-rect gesture fallback only when node exists)
 * - Swipe up / Swipe down via GestureDescription and container scrolling via ACTION_SCROLL_*
 * - Global Back / Home navigation
 * - Reading visible non-password screen labels (redacting OTPs/secrets)
 * - Identifying editable non-password text fields & verified text entry
 * - Multi-step verified app workflows (validates current app, target node, and safety before every step)
 *
 * Strictly NEVER:
 * - Reads, taps, or modifies password fields
 * - Captures OTPs, PINs, CVVs, or auth secrets
 * - Interacts with banking, UPI, payment, or password-manager screens
 * - Performs hidden background screen scraping
 */
class ZoniAccessibilityService : AccessibilityService() {

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        // Track only lightweight foreground package & event timestamps; NEVER scrape screen content in background.
        if (event == null) return
        val now = System.currentTimeMillis()
        val pkg = event.packageName?.toString()
        if (!pkg.isNullOrBlank()) {
            lastForegroundPackage = pkg
        }
        lastEventTimestampMs = now
        lastEventType = event.eventType
        when (event.eventType) {
            AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED -> lastWindowStateChangeMs = now
            AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED,
            AccessibilityEvent.TYPE_VIEW_TEXT_CHANGED -> lastWindowContentChangeMs = now
        }
    }

    override fun onInterrupt() {
        // Required override; no-op.
    }

    override fun onDestroy() {
        if (instance === this) {
            instance = null
        }
        super.onDestroy()
    }

    fun getActivePackageName(): String {
        val rootPkg = try {
            rootInActiveWindow?.packageName?.toString()
        } catch (_: Exception) {
            null
        }
        return rootPkg?.takeIf { it.isNotBlank() } ?: lastForegroundPackage
    }

    private fun checkScreenSafety(root: AccessibilityNodeInfo?, actionType: String): AccessibilityActionOutcome? {
        val activePkg = root?.packageName?.toString()?.takeIf { it.isNotBlank() } ?: lastForegroundPackage
        if (AccessibilityGuard.isProtectedPackage(activePkg)) {
            return AccessibilityActionOutcome(
                success = false,
                verified = false,
                actionType = actionType,
                activePackage = activePkg,
                message = "Action blocked for your security: Zoni AI does not inspect or automate banking, payment, or password-manager screens.",
                failureReason = "protected_banking_or_auth_screen"
            )
        }
        if (root != null) {
            val sampleLabels = collectVisibleLabels(root, 40)
            if (AccessibilityGuard.isSensitiveScreenContent(sampleLabels)) {
                return AccessibilityActionOutcome(
                    success = false,
                    verified = false,
                    actionType = actionType,
                    activePackage = activePkg,
                    message = "Action blocked for your security: sensitive password, OTP, or payment confirmation screen detected.",
                    failureReason = "sensitive_screen_content"
                )
            }
        }
        return null
    }

    private fun collectVisibleLabels(root: AccessibilityNodeInfo, limit: Int): List<String> {
        val labels = mutableListOf<String>()
        fun traverse(node: AccessibilityNodeInfo?) {
            if (node == null || labels.size >= limit) return
            if (node.isPassword) return
            val text = node.text?.toString()?.trim()
            val desc = node.contentDescription?.toString()?.trim()
            if (!text.isNullOrEmpty()) labels.add(text)
            else if (!desc.isNullOrEmpty()) labels.add(desc)
            for (i in 0 until node.childCount) {
                traverse(node.getChild(i))
                if (labels.size >= limit) return
            }
        }
        traverse(root)
        return labels
    }

    fun readVisibleScreenDetailed(maxItems: Int = 80): AccessibilityActionOutcome {
        val root = rootInActiveWindow ?: return AccessibilityActionOutcome(
            success = false,
            verified = false,
            actionType = "read_visible_screen",
            activePackage = lastForegroundPackage,
            message = "No active window is currently accessible on screen.",
            failureReason = "no_active_window"
        )
        val activePkg = root.packageName?.toString().orEmpty()
        checkScreenSafety(root, "read_visible_screen")?.let { return it }

        val labels = LinkedHashSet<String>()
        val clickableLabels = LinkedHashSet<String>()
        val editableFields = JSONArray()

        fun traverse(node: AccessibilityNodeInfo?) {
            if (node == null || labels.size >= maxItems) return
            if (node.isPassword) return

            val rawText = node.text?.toString()?.trim().orEmpty()
            val rawDesc = node.contentDescription?.toString()?.trim().orEmpty()
            val hint = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                node.hintText?.toString()?.trim().orEmpty()
            } else {
                ""
            }

            if (node.isEditable && !AccessibilityGuard.isSensitiveInputHint(hint.ifEmpty { rawDesc })) {
                editableFields.put(
                    JSONObject()
                        .put("hint", hint.ifEmpty { rawDesc }.ifEmpty { "Text field" })
                        .put("viewId", node.viewIdResourceName.orEmpty())
                )
            }

            val candidate = when {
                rawText.isNotEmpty() -> rawText
                rawDesc.isNotEmpty() -> rawDesc
                else -> ""
            }
            if (candidate.isNotEmpty() && !AccessibilityGuard.containsOtpOrSecret(candidate)) {
                val safeLabel = AccessibilityGuard.redactSensitiveText(candidate)
                if (safeLabel.isNotBlank()) {
                    labels.add(safeLabel)
                    if (node.isClickable && clickableLabels.size < 25) {
                        clickableLabels.add(safeLabel)
                    }
                }
            }

            for (i in 0 until node.childCount) {
                traverse(node.getChild(i))
                if (labels.size >= maxItems) return
            }
        }
        traverse(root)

        val labelsArray = JSONArray()
        labels.forEach { labelsArray.put(it) }
        val clickableArray = JSONArray()
        clickableLabels.forEach { clickableArray.put(it) }

        val summaryText = labels.joinToString("\n")
        val data = JSONObject()
            .put("activePackage", activePkg)
            .put("labelCount", labels.size)
            .put("visibleText", summaryText)
            .put("labels", labelsArray)
            .put("clickableElements", clickableArray)
            .put("editableFields", editableFields)

        return AccessibilityActionOutcome(
            success = true,
            verified = labels.isNotEmpty(),
            actionType = "read_visible_screen",
            activePackage = activePkg,
            message = if (labels.isNotEmpty()) {
                "Read ${labels.size} visible non-sensitive labels from the current screen."
            } else {
                "No readable non-sensitive text labels were found on the current screen."
            },
            data = data
        )
    }

    fun tapElementByTextDetailed(targetText: String): AccessibilityActionOutcome {
        val query = targetText.trim()
        if (query.isEmpty()) {
            return AccessibilityActionOutcome(
                success = false,
                verified = false,
                actionType = "tap_visible_element",
                activePackage = getActivePackageName(),
                message = "Please specify which visible element to tap.",
                failureReason = "missing_target_text"
            )
        }
        if (AccessibilityGuard.isSensitiveInputHint(query)) {
            return AccessibilityActionOutcome(
                success = false,
                verified = false,
                actionType = "tap_visible_element",
                activePackage = getActivePackageName(),
                message = "Cannot interact with password, PIN, or OTP UI elements.",
                failureReason = "sensitive_target_blocked"
            )
        }

        val root = rootInActiveWindow ?: return AccessibilityActionOutcome(
            success = false,
            verified = false,
            actionType = "tap_visible_element",
            activePackage = lastForegroundPackage,
            message = "No active Android window is available to tap.",
            failureReason = "no_active_window"
        )
        val activePkg = root.packageName?.toString().orEmpty()
        checkScreenSafety(root, "tap_visible_element")?.let { return it }

        // 1. Semantic node lookup (exact text -> contentDescription -> partial match)
        val matchedNode = findBestSemanticNode(root, query) ?: return AccessibilityActionOutcome(
            success = false,
            verified = false,
            actionType = "tap_visible_element",
            activePackage = activePkg,
            message = "Could not find visible UI element \"$query\" on the current screen.",
            failureReason = "element_not_found"
        )

        if (matchedNode.isPassword) {
            return AccessibilityActionOutcome(
                success = false,
                verified = false,
                actionType = "tap_visible_element",
                activePackage = activePkg,
                message = "Blocked tapping a password field for security.",
                failureReason = "password_field_blocked"
            )
        }

        // 2. Walk up to clickable semantic node and invoke ACTION_CLICK
        var clickable: AccessibilityNodeInfo? = matchedNode
        while (clickable != null && !clickable.isClickable) {
            clickable = clickable.parent
        }
        if (clickable != null && clickable.performAction(AccessibilityNodeInfo.ACTION_CLICK)) {
            return AccessibilityActionOutcome(
                success = true,
                verified = true,
                actionType = "tap_visible_element",
                activePackage = activePkg,
                message = "Tapped \"$query\" via semantic Accessibility node.",
                data = JSONObject().put("method", "semantic_node_click").put("target", query)
            )
        }

        // 3. Fallback: gesture tap strictly on the discovered semantic node's real screen bounds
        val rect = Rect()
        matchedNode.getBoundsInScreen(rect)
        if (!rect.isEmpty && rect.centerX() > 0 && rect.centerY() > 0) {
            val tapped = dispatchTapGesture(rect.centerX().toFloat(), rect.centerY().toFloat())
            if (tapped) {
                return AccessibilityActionOutcome(
                    success = true,
                    verified = true,
                    actionType = "tap_visible_element",
                    activePackage = activePkg,
                    message = "Tapped \"$query\" using bounded node gesture.",
                    data = JSONObject().put("method", "bounded_node_gesture").put("target", query)
                )
            }
        }

        return AccessibilityActionOutcome(
            success = false,
            verified = false,
            actionType = "tap_visible_element",
            activePackage = activePkg,
            message = "Found \"$query\" on screen, but it could not be clicked.",
            failureReason = "click_action_rejected"
        )
    }

    private fun findBestSemanticNode(root: AccessibilityNodeInfo, query: String): AccessibilityNodeInfo? {
        val exactMatches = root.findAccessibilityNodeInfosByText(query)
        if (!exactMatches.isNullOrEmpty()) {
            val nonPassword = exactMatches.firstOrNull { !it.isPassword && it.isVisibleToUser }
                ?: exactMatches.firstOrNull { !it.isPassword }
            if (nonPassword != null) return nonPassword
        }

        val lowerQuery = query.lowercase()
        var partialFallback: AccessibilityNodeInfo? = null

        fun search(node: AccessibilityNodeInfo?): AccessibilityNodeInfo? {
            if (node == null || node.isPassword) return null
            val text = node.text?.toString()?.trim()?.lowercase().orEmpty()
            val desc = node.contentDescription?.toString()?.trim()?.lowercase().orEmpty()
            val hint = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                node.hintText?.toString()?.trim()?.lowercase().orEmpty()
            } else {
                ""
            }

            if (text == lowerQuery || desc == lowerQuery || hint == lowerQuery) {
                return node
            }
            if (partialFallback == null && (text.contains(lowerQuery) || desc.contains(lowerQuery) || hint.contains(lowerQuery))) {
                partialFallback = node
            }
            for (i in 0 until node.childCount) {
                val found = search(node.getChild(i))
                if (found != null) return found
            }
            return null
        }

        return search(root) ?: partialFallback
    }

    fun scrollScreenDetailed(direction: String): AccessibilityActionOutcome {
        val normalized = direction.trim().lowercase()
        val isUp = normalized == "up" || normalized == "scroll_up" || normalized == "backward"
        val dirLabel = if (isUp) "up" else "down"

        val root = rootInActiveWindow ?: return AccessibilityActionOutcome(
            success = false,
            verified = false,
            actionType = "scroll_screen",
            activePackage = lastForegroundPackage,
            message = "No active window available to scroll $dirLabel.",
            failureReason = "no_active_window"
        )
        val activePkg = root.packageName?.toString().orEmpty()
        checkScreenSafety(root, "scroll_screen")?.let { return it }

        val scrollAction = if (isUp) {
            AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD
        } else {
            AccessibilityNodeInfo.ACTION_SCROLL_FORWARD
        }

        fun findScrollableAndScroll(node: AccessibilityNodeInfo?): Boolean {
            if (node == null || node.isPassword) return false
            if (node.isScrollable && node.performAction(scrollAction)) {
                return true
            }
            for (i in 0 until node.childCount) {
                if (findScrollableAndScroll(node.getChild(i))) return true
            }
            return false
        }

        if (findScrollableAndScroll(root)) {
            return AccessibilityActionOutcome(
                success = true,
                verified = true,
                actionType = "scroll_screen",
                activePackage = activePkg,
                message = "Scrolled $dirLabel on the active list.",
                data = JSONObject().put("direction", dirLabel).put("method", "semantic_scroll")
            )
        }

        // Gesture swipe fallback (requires android:canPerformGestures="true")
        val swiped = dispatchSwipeGesture(isUp = isUp)
        return if (swiped) {
            AccessibilityActionOutcome(
                success = true,
                verified = true,
                actionType = "scroll_screen",
                activePackage = activePkg,
                message = "Swiped $dirLabel on the current screen.",
                data = JSONObject().put("direction", dirLabel).put("method", "dispatch_gesture_swipe")
            )
        } else {
            AccessibilityActionOutcome(
                success = false,
                verified = false,
                actionType = "scroll_screen",
                activePackage = activePkg,
                message = "Could not scroll $dirLabel on the current screen.",
                failureReason = "scroll_failed"
            )
        }
    }

    fun enterTextDetailed(targetHint: String, text: String): AccessibilityActionOutcome {
        val cleanText = text.trim()
        if (cleanText.isEmpty()) {
            return AccessibilityActionOutcome(
                success = false,
                verified = false,
                actionType = "enter_text_in_visible_field",
                activePackage = getActivePackageName(),
                message = "No text was provided to enter.",
                failureReason = "empty_text"
            )
        }
        if (AccessibilityGuard.isSensitiveInputHint(targetHint)) {
            return AccessibilityActionOutcome(
                success = false,
                verified = false,
                actionType = "enter_text_in_visible_field",
                activePackage = getActivePackageName(),
                message = "Blocked entering text into a password, PIN, or OTP field.",
                failureReason = "password_field_blocked"
            )
        }

        val root = rootInActiveWindow ?: return AccessibilityActionOutcome(
            success = false,
            verified = false,
            actionType = "enter_text_in_visible_field",
            activePackage = lastForegroundPackage,
            message = "No active window available to enter text.",
            failureReason = "no_active_window"
        )
        val activePkg = root.packageName?.toString().orEmpty()
        checkScreenSafety(root, "enter_text_in_visible_field")?.let { return it }

        val normalizedHint = targetHint.trim().lowercase()
        var fallbackEditable: AccessibilityNodeInfo? = null

        fun findEditable(node: AccessibilityNodeInfo?): AccessibilityNodeInfo? {
            if (node == null) return null
            if (node.isEditable) {
                if (node.isPassword) return null
                val hint = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    node.hintText?.toString().orEmpty()
                } else {
                    ""
                }
                val desc = node.contentDescription?.toString().orEmpty()
                val currentTxt = node.text?.toString().orEmpty()
                if (AccessibilityGuard.isSensitiveInputHint(hint) || AccessibilityGuard.isSensitiveInputHint(desc)) {
                    return null
                }
                if (fallbackEditable == null) fallbackEditable = node
                if (normalizedHint.isEmpty() ||
                    hint.lowercase().contains(normalizedHint) ||
                    desc.lowercase().contains(normalizedHint) ||
                    currentTxt.lowercase().contains(normalizedHint) ||
                    node.isFocused
                ) {
                    return node
                }
            }
            for (i in 0 until node.childCount) {
                val found = findEditable(node.getChild(i))
                if (found != null) return found
            }
            return null
        }

        val target = findEditable(root) ?: fallbackEditable ?: return AccessibilityActionOutcome(
            success = false,
            verified = false,
            actionType = "enter_text_in_visible_field",
            activePackage = activePkg,
            message = "Could not find a non-password editable text field on the current screen.",
            failureReason = "editable_field_not_found"
        )

        if (target.isPassword) {
            return AccessibilityActionOutcome(
                success = false,
                verified = false,
                actionType = "enter_text_in_visible_field",
                activePackage = activePkg,
                message = "Blocked entering text into a password field.",
                failureReason = "password_field_blocked"
            )
        }

        target.performAction(AccessibilityNodeInfo.ACTION_FOCUS)
        val args = Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, cleanText)
        }
        val setOk = target.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
        if (!setOk) {
            return AccessibilityActionOutcome(
                success = false,
                verified = false,
                actionType = "enter_text_in_visible_field",
                activePackage = activePkg,
                message = "The active input field rejected automated text entry.",
                failureReason = "set_text_rejected"
            )
        }

        target.refresh()
        val verifiedText = target.text?.toString()?.contains(cleanText, ignoreCase = true) == true
        return AccessibilityActionOutcome(
            success = true,
            verified = verifiedText,
            actionType = "enter_text_in_visible_field",
            activePackage = activePkg,
            message = if (verifiedText) {
                "Entered text into the visible input field and verified it."
            } else {
                "Submitted text to the visible input field."
            },
            data = JSONObject().put("verifiedTextMatch", verifiedText)
        )
    }

    fun performGlobalNavigationDetailed(action: String): AccessibilityActionOutcome {
        val activePkg = getActivePackageName()
        return when (action.trim().lowercase()) {
            "home", "go_home" -> {
                val ok = performGlobalAction(GLOBAL_ACTION_HOME)
                AccessibilityActionOutcome(
                    success = ok,
                    verified = ok,
                    actionType = "go_home",
                    activePackage = activePkg,
                    message = if (ok) "Returned to the Android Home screen." else "Could not navigate to Home.",
                    failureReason = if (ok) null else "global_home_failed"
                )
            }
            "back", "go_back" -> {
                val ok = performGlobalAction(GLOBAL_ACTION_BACK)
                AccessibilityActionOutcome(
                    success = ok,
                    verified = ok,
                    actionType = "go_back",
                    activePackage = activePkg,
                    message = if (ok) "Navigated Back." else "Could not perform Back navigation.",
                    failureReason = if (ok) null else "global_back_failed"
                )
            }
            "recents" -> {
                val ok = performGlobalAction(GLOBAL_ACTION_RECENTS)
                AccessibilityActionOutcome(
                    success = ok,
                    verified = ok,
                    actionType = "recents",
                    activePackage = activePkg,
                    message = if (ok) "Opened Recent Apps." else "Could not open Recent Apps.",
                    failureReason = if (ok) null else "global_recents_failed"
                )
            }
            "notifications" -> {
                val ok = performGlobalAction(GLOBAL_ACTION_NOTIFICATIONS)
                AccessibilityActionOutcome(
                    success = ok,
                    verified = ok,
                    actionType = "open_notification_shade",
                    activePackage = activePkg,
                    message = if (ok) "Opened Notification Shade." else "Could not open Notification Shade.",
                    failureReason = if (ok) null else "global_notifications_failed"
                )
            }
            else -> AccessibilityActionOutcome(
                success = false,
                verified = false,
                actionType = action,
                activePackage = activePkg,
                message = "Unsupported navigation command: $action",
                failureReason = "unsupported_navigation_command"
            )
        }
    }

    /**
     * Executes a validated multi-step UI workflow (e.g., verify active app -> tap Search -> enter query).
     * Before EVERY step verifies safety, expected active package, and target element.
     * Immediately ABORTS and reports the exact failed step if any precondition or verification fails.
     */
    fun executeVerifiedWorkflow(stepsJson: String): AccessibilityActionOutcome {
        val steps = try {
            JSONArray(stepsJson)
        } catch (_: Exception) {
            return AccessibilityActionOutcome(
                success = false,
                verified = false,
                actionType = "verified_workflow",
                activePackage = getActivePackageName(),
                message = "Invalid workflow step specification.",
                failureReason = "invalid_workflow_json"
            )
        }

        if (steps.length() == 0 || steps.length() > 8) {
            return AccessibilityActionOutcome(
                success = false,
                verified = false,
                actionType = "verified_workflow",
                activePackage = getActivePackageName(),
                message = "Workflow must contain between 1 and 8 validated steps.",
                failureReason = "invalid_workflow_length"
            )
        }

        val completedSteps = JSONArray()
        for (i in 0 until steps.length()) {
            val step = steps.optJSONObject(i) ?: continue
            val stepType = step.optString("type", "").trim().lowercase()
            val expectedPackage = step.optString("expectedPackage", "").trim()

            // Verify screen safety and expected active app BEFORE executing every step
            val currentRoot = rootInActiveWindow
            checkScreenSafety(currentRoot, "verified_workflow")?.let { blocked ->
                return blocked
            }
            if (expectedPackage.isNotEmpty()) {
                val activePkg = getActivePackageName()
                if (!activePkg.equals(expectedPackage, ignoreCase = true)) {
                    return AccessibilityActionOutcome(
                        success = false,
                        verified = false,
                        actionType = "verified_workflow",
                        activePackage = activePkg,
                        message = "Workflow stopped at step ${i + 1}: expected app \"$expectedPackage\" in foreground, found \"$activePkg\".",
                        failureReason = "unexpected_foreground_app",
                        data = JSONObject().put("completedSteps", completedSteps).put("failedStepIndex", i)
                    )
                }
            }

            val stepResult = when (stepType) {
                "wait" -> {
                    val waitMs = step.optLong("ms", 500L).coerceIn(100L, 2500L)
                    try {
                        Thread.sleep(waitMs)
                    } catch (_: InterruptedException) {
                        // ignore
                    }
                    AccessibilityActionOutcome(
                        success = true,
                        verified = true,
                        actionType = "wait",
                        activePackage = getActivePackageName(),
                        message = "Waited ${waitMs}ms for UI update."
                    )
                }
                "tap" -> tapElementByTextDetailed(step.optString("target", ""))
                "enter_text" -> enterTextDetailed(step.optString("targetHint", ""), step.optString("text", ""))
                "scroll" -> scrollScreenDetailed(step.optString("direction", "down"))
                "back" -> performGlobalNavigationDetailed("back")
                "home" -> performGlobalNavigationDetailed("home")
                "read_screen" -> readVisibleScreenDetailed(50)
                else -> AccessibilityActionOutcome(
                    success = false,
                    verified = false,
                    actionType = stepType,
                    activePackage = getActivePackageName(),
                    message = "Workflow stopped at step ${i + 1}: disallowed step type \"$stepType\".",
                    failureReason = "disallowed_workflow_step"
                )
            }

            if (!stepResult.success) {
                return AccessibilityActionOutcome(
                    success = false,
                    verified = false,
                    actionType = "verified_workflow",
                    activePackage = stepResult.activePackage,
                    message = "Workflow stopped at step ${i + 1} ($stepType): ${stepResult.message}",
                    failureReason = stepResult.failureReason ?: "workflow_step_failed",
                    data = JSONObject().put("completedSteps", completedSteps).put("failedStepIndex", i)
                )
            }

            completedSteps.put(
                JSONObject()
                    .put("stepIndex", i)
                    .put("type", stepType)
                    .put("verified", stepResult.verified)
                    .put("message", stepResult.message)
            )
        }

        return AccessibilityActionOutcome(
            success = true,
            verified = true,
            actionType = "verified_workflow",
            activePackage = getActivePackageName(),
            message = "Completed all ${completedSteps.length()} verified workflow steps.",
            data = JSONObject().put("completedSteps", completedSteps)
        )
    }

    private fun dispatchTapGesture(x: Float, y: Float): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return false
        val path = Path().apply { moveTo(x, y) }
        val gesture = GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(path, 0L, 80L))
            .build()
        return dispatchGestureBlocking(gesture)
    }

    private fun dispatchSwipeGesture(isUp: Boolean): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return false
        val metrics = resources.displayMetrics
        val centerX = metrics.widthPixels * 0.5f
        val topY = metrics.heightPixels * 0.25f
        val bottomY = metrics.heightPixels * 0.75f

        val path = Path().apply {
            if (isUp) {
                // Swipe finger down to scroll content upward
                moveTo(centerX, topY)
                lineTo(centerX, bottomY)
            } else {
                // Swipe finger up to scroll content downward
                moveTo(centerX, bottomY)
                lineTo(centerX, topY)
            }
        }
        val gesture = GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(path, 0L, 280L))
            .build()
        return dispatchGestureBlocking(gesture)
    }

    private fun dispatchGestureBlocking(gesture: GestureDescription): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return false
        val latch = CountDownLatch(1)
        val completed = AtomicBoolean(false)
        val dispatched = dispatchGesture(
            gesture,
            object : GestureResultCallback() {
                override fun onCompleted(gestureDescription: GestureDescription?) {
                    completed.set(true)
                    latch.countDown()
                }

                override fun onCancelled(gestureDescription: GestureDescription?) {
                    completed.set(false)
                    latch.countDown()
                }
            },
            null
        )
        if (!dispatched) return false
        try {
            latch.await(1200L, TimeUnit.MILLISECONDS)
        } catch (_: InterruptedException) {
            return false
        }
        return completed.get()
    }

    // ========================================================================
    // SNAPSHOT TREE & SMART CLICK HELPERS (YOUTUBE + WHATSAPP)
    // ========================================================================

    private fun captureNodeSnapshotTree(
        root: AccessibilityNodeInfo,
        maxNodes: Int = 350
    ): Pair<List<AccessibleNodeSnapshot>, Map<Int, AccessibilityNodeInfo>> {
        val snapshots = mutableListOf<AccessibleNodeSnapshot>()
        val nodeMap = HashMap<Int, AccessibilityNodeInfo>()
        var nextId = 1

        fun walk(node: AccessibilityNodeInfo?, parentId: Int?) {
            if (node == null || snapshots.size >= maxNodes) return
            if (node.isPassword) return

            val id = nextId++
            val rect = Rect()
            node.getBoundsInScreen(rect)
            val hint = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                node.hintText?.toString()
            } else {
                null
            }

            val snap = AccessibleNodeSnapshot(
                nodeId = id,
                parentId = parentId,
                viewIdResourceName = node.viewIdResourceName,
                className = node.className?.toString(),
                text = node.text?.toString(),
                contentDescription = node.contentDescription?.toString(),
                hintText = hint,
                isClickable = node.isClickable,
                isEnabled = node.isEnabled,
                isVisibleToUser = node.isVisibleToUser,
                isEditable = node.isEditable,
                isPassword = node.isPassword,
                bounds = AccessibleRect(rect.left, rect.top, rect.right, rect.bottom)
            )
            snapshots.add(snap)
            nodeMap[id] = node

            for (i in 0 until node.childCount) {
                walk(node.getChild(i), id)
                if (snapshots.size >= maxNodes) return
            }
        }
        walk(root, null)
        return Pair(snapshots, nodeMap)
    }

    /**
     * Executes semantic ACTION_CLICK first (target node -> nearest clickable parent),
     * falling back to a bounded dispatchGesture ONLY on the verified visible element's exact bounds.
     * NEVER clicks arbitrary fixed screen coordinates.
     */
    private fun performSmartClickOnResolvedTarget(
        targetNode: AccessibilityNodeInfo?,
        clickableAncestor: AccessibilityNodeInfo?,
        verifiedBounds: AccessibleRect
    ): Pair<Boolean, String> {
        if (targetNode != null && !targetNode.isPassword && targetNode.isClickable && targetNode.isEnabled) {
            if (targetNode.performAction(AccessibilityNodeInfo.ACTION_CLICK)) {
                return Pair(true, "semantic_node_click")
            }
        }
        if (clickableAncestor != null && !clickableAncestor.isPassword && clickableAncestor.isEnabled) {
            if (clickableAncestor.performAction(AccessibilityNodeInfo.ACTION_CLICK)) {
                return Pair(true, "semantic_parent_click")
            }
        }
        // Walk live parent chain as additional safety net
        var walk: AccessibilityNodeInfo? = targetNode?.parent
        var depth = 0
        while (walk != null && depth < 6) {
            if (walk.isPassword) break
            if (walk.isClickable && walk.isEnabled) {
                if (walk.performAction(AccessibilityNodeInfo.ACTION_CLICK)) {
                    return Pair(true, "semantic_parent_click")
                }
                break
            }
            walk = walk.parent
            depth++
        }
        // Bounded gesture fallback ONLY on verified visible bounds
        if (verifiedBounds.isValidVisible && verifiedBounds.centerX > 0f && verifiedBounds.centerY > 0f) {
            val tapped = dispatchTapGesture(verifiedBounds.centerX, verifiedBounds.centerY)
            if (tapped) {
                return Pair(true, "bounded_bounds_gesture")
            }
        }
        return Pair(false, "click_rejected")
    }

    private fun waitForUiTransitionEvent(sinceMs: Long, maxWaitMs: Long = 900L): Boolean {
        val deadline = System.currentTimeMillis() + maxWaitMs
        while (System.currentTimeMillis() < deadline) {
            if (lastWindowStateChangeMs > sinceMs || lastWindowContentChangeMs > sinceMs) {
                try {
                    Thread.sleep(220L)
                } catch (_: InterruptedException) {
                    // ignore
                }
                return true
            }
            try {
                Thread.sleep(90L)
            } catch (_: InterruptedException) {
                break
            }
        }
        return lastWindowStateChangeMs > sinceMs || lastWindowContentChangeMs > sinceMs
    }

    // ========================================================================
    // PART 1 — ADVANCED YOUTUBE CLICK ENGINE (LIVE EXECUTION + VERIFICATION)
    // ========================================================================

    fun clickYouTubeVideo(
        index: Int? = null,
        targetHint: String = "",
        titleQuery: String = "",
        actionTypeName: String = "click_youtube_video"
    ): AccessibilityActionOutcome {
        val root = rootInActiveWindow ?: return AccessibilityActionOutcome(
            success = false,
            verified = false,
            actionType = actionTypeName,
            activePackage = lastForegroundPackage,
            message = "No active Android window is accessible to click a YouTube video.",
            failureReason = "no_active_window",
            target = titleQuery.ifBlank { targetHint.ifBlank { index?.let { "video #$it" } ?: "youtube_video" } },
            executionStatus = "failed"
        )
        val activePkg = root.packageName?.toString().orEmpty()
        checkScreenSafety(root, actionTypeName)?.let { return it }

        if (!YouTubeClickEngine.isYouTubePackage(activePkg)) {
            return AccessibilityActionOutcome(
                success = false,
                verified = true,
                actionType = actionTypeName,
                activePackage = activePkg,
                message = "YouTube is not currently open on screen (active app: ${activePkg.ifBlank { "unknown" }}). Please open YouTube first.",
                failureReason = "youtube_not_in_foreground",
                target = titleQuery.ifBlank { targetHint },
                executionStatus = "youtube_not_in_foreground"
            )
        }

        val beforeLabels = collectVisibleLabels(root, 40)
        var (snapshots, nodeMap) = captureNodeSnapshotTree(root)
        val hintLower = targetHint.trim().lowercase()
        val playbackKind = when {
            hintLower == "pause_video" || hintLower == "pause_button" || hintLower == "pause" || hintLower.contains("pause") || hintLower.contains("পজ") -> "pause"
            hintLower == "stop_video" || hintLower == "stop_button" || hintLower == "stop" || hintLower.contains("stop") || hintLower.contains("স্টপ") -> "stop"
            hintLower == "play_button" || hintLower == "play_video" || hintLower == "resume_video" || hintLower == "play" || hintLower.contains("play button") || hintLower.contains("প্লে বাটন") -> "play"
            else -> null
        }

        val dedupTarget = titleQuery.ifBlank { targetHint.ifBlank { index?.toString().orEmpty() } }
        if (!UiActionDeduplicator.tryAcquire(activePkg, actionTypeName, dedupTarget)) {
            return AccessibilityActionOutcome(
                success = false,
                verified = true,
                actionType = actionTypeName,
                activePackage = activePkg,
                message = "Prevented accidental duplicate YouTube action for \"$dedupTarget\".",
                failureReason = "duplicate_tap_prevented",
                target = dedupTarget,
                executionStatus = "duplicate_blocked"
            )
        }

        var resolution = YouTubeClickEngine.resolveVideoTarget(snapshots, index, targetHint, titleQuery)

        // If Play/Pause/Stop overlay controls auto-hid on YouTube watch screen, tap the player surface once to reveal them
        if (resolution is YouTubeTargetResolution.NotFound && playbackKind != null) {
            val playerSurface = YouTubeClickEngine.findPlayerSurface(snapshots)
            if (playerSurface != null) {
                val liveSurface = nodeMap[playerSurface.nodeId]
                val (revealed, _) = performSmartClickOnResolvedTarget(liveSurface, liveSurface, playerSurface.bounds)
                if (revealed) {
                    try {
                        Thread.sleep(360L)
                    } catch (_: InterruptedException) {
                        // ignore
                    }
                    val refreshedRoot = rootInActiveWindow ?: root
                    val refreshedTree = captureNodeSnapshotTree(refreshedRoot)
                    snapshots = refreshedTree.first
                    nodeMap = refreshedTree.second
                    resolution = YouTubeClickEngine.resolveVideoTarget(snapshots, index, targetHint, titleQuery)
                }
            }
        }

        return when (resolution) {
            is YouTubeTargetResolution.NotFound -> AccessibilityActionOutcome(
                success = false,
                verified = true,
                actionType = actionTypeName,
                activePackage = activePkg,
                message = resolution.reason,
                failureReason = resolution.failureCode,
                target = dedupTarget,
                executionStatus = resolution.failureCode
            )
            is YouTubeTargetResolution.Ambiguous -> {
                val arr = JSONArray()
                resolution.candidates.forEachIndexed { i, c ->
                    arr.put(JSONObject().put("index", i + 1).put("title", c.title))
                }
                AccessibilityActionOutcome(
                    success = false,
                    verified = true,
                    actionType = actionTypeName,
                    activePackage = activePkg,
                    message = "Multiple visible YouTube videos match \"${resolution.query}\". Please specify which one (e.g., first or second video).",
                    failureReason = "ambiguous_target",
                    target = resolution.query,
                    executionStatus = "ambiguous_target",
                    data = JSONObject().put("candidates", arr).put("query", resolution.query)
                )
            }
            is YouTubeTargetResolution.Matched -> {
                val cand = resolution.candidate
                val liveTarget = nodeMap[cand.matchNode.nodeId]
                val liveClickable = cand.clickableNode?.let { nodeMap[it.nodeId] }
                val preClickMs = System.currentTimeMillis()

                val (clicked, method) = performSmartClickOnResolvedTarget(liveTarget, liveClickable, cand.bounds)
                if (!clicked) {
                    return AccessibilityActionOutcome(
                        success = false,
                        verified = false,
                        actionType = actionTypeName,
                        activePackage = activePkg,
                        message = "Found YouTube target \"${cand.title}\", but neither semantic click nor bounded gesture succeeded.",
                        failureReason = "youtube_click_rejected",
                        target = cand.title,
                        executionStatus = "failed"
                    )
                }

                val eventObserved = waitForUiTransitionEvent(preClickMs, 1000L)
                val postRoot = rootInActiveWindow
                val postPkg = postRoot?.packageName?.toString().orEmpty().ifBlank { getActivePackageName() }
                val postSnapshots = if (postRoot != null) captureNodeSnapshotTree(postRoot).first else emptyList()

                val verification = if (playbackKind != null) {
                    YouTubeClickEngine.verifyPlaybackControlResult(
                        controlType = playbackKind,
                        afterNodes = postSnapshots,
                        accessibilityEventObserved = eventObserved
                    )
                } else {
                    YouTubeClickEngine.verifyWatchScreenOpened(
                        beforeLabels = beforeLabels,
                        afterNodes = postSnapshots,
                        clickedTitle = cand.title,
                        activePackage = postPkg,
                        accessibilityEventObserved = eventObserved
                    )
                }

                AccessibilityActionOutcome(
                    success = true,
                    verified = verification.openedWatchScreen,
                    actionType = actionTypeName,
                    activePackage = postPkg,
                    message = if (verification.openedWatchScreen) {
                        "Clicked YouTube target \"${cand.title}\" (#${resolution.rankIndex}) via $method. ${verification.evidence}"
                    } else {
                        "Clicked YouTube target \"${cand.title}\" (#${resolution.rankIndex}) via $method, but could not verify the screen state changed. ${verification.evidence}"
                    },
                    failureReason = if (verification.openedWatchScreen) null else "watch_screen_unverified",
                    target = cand.title,
                    executionStatus = verification.status,
                    data = JSONObject()
                        .put("target", cand.title)
                        .put("title", cand.title)
                        .put("rankIndex", resolution.rankIndex)
                        .put("method", method)
                        .put("isPlayButton", cand.isPlayButton)
                        .put("isThumbnail", cand.isThumbnail)
                        .put("evidence", verification.evidence)
                )
            }
        }
    }

    fun clickFacebookControl(targetText: String, index: Int? = null): AccessibilityActionOutcome {
        val root = rootInActiveWindow ?: return AccessibilityActionOutcome(
            success = false,
            verified = false,
            actionType = "click_visible_element",
            activePackage = lastForegroundPackage,
            message = "No active Android window is accessible to tap a Facebook control.",
            failureReason = "no_active_window",
            target = targetText,
            executionStatus = "failed"
        )
        val activePkg = root.packageName?.toString().orEmpty()
        checkScreenSafety(root, "click_visible_element")?.let { return it }

        if (!UiActionDeduplicator.tryAcquire(activePkg, "click_facebook_control", "$targetText#${index ?: 0}")) {
            return AccessibilityActionOutcome(
                success = false,
                verified = true,
                actionType = "click_visible_element",
                activePackage = activePkg,
                message = "Prevented accidental duplicate tap on Facebook \"$targetText\".",
                failureReason = "duplicate_tap_prevented",
                target = targetText,
                executionStatus = "duplicate_blocked"
            )
        }

        val (snapshots, nodeMap) = captureNodeSnapshotTree(root)
        return when (val resolution = FacebookUiControlEngine.resolveControl(snapshots, targetText, index)) {
            is FacebookUiResolution.NotFound -> AccessibilityActionOutcome(
                success = false,
                verified = true,
                actionType = "click_visible_element",
                activePackage = activePkg,
                message = resolution.reason,
                failureReason = resolution.failureCode,
                target = targetText,
                executionStatus = resolution.failureCode
            )
            is FacebookUiResolution.Ambiguous -> {
                val arr = JSONArray()
                resolution.candidates.forEachIndexed { i, c ->
                    arr.put(JSONObject().put("index", i + 1).put("label", c.label).put("category", c.category))
                }
                AccessibilityActionOutcome(
                    success = false,
                    verified = true,
                    actionType = "click_visible_element",
                    activePackage = activePkg,
                    message = "Multiple visible Facebook controls match \"${resolution.query}\". Please specify which one (e.g., first or second).",
                    failureReason = "ambiguous_target",
                    target = resolution.query,
                    executionStatus = "ambiguous_target",
                    data = JSONObject().put("candidates", arr).put("query", resolution.query)
                )
            }
            is FacebookUiResolution.Matched -> {
                val cand = resolution.candidate
                val liveTarget = nodeMap[cand.matchNode.nodeId]
                val liveClickable = cand.clickableNode?.let { nodeMap[it.nodeId] }
                val preClickMs = System.currentTimeMillis()
                val (clicked, method) = performSmartClickOnResolvedTarget(liveTarget, liveClickable, cand.bounds)
                if (!clicked) {
                    return AccessibilityActionOutcome(
                        success = false,
                        verified = false,
                        actionType = "click_visible_element",
                        activePackage = activePkg,
                        message = "Found Facebook control \"${cand.label}\", but the tap was rejected.",
                        failureReason = "facebook_click_rejected",
                        target = cand.label,
                        executionStatus = "failed"
                    )
                }
                val transitioned = waitForUiTransitionEvent(preClickMs, 850L)
                AccessibilityActionOutcome(
                    success = true,
                    verified = transitioned,
                    actionType = "click_visible_element",
                    activePackage = getActivePackageName(),
                    message = if (transitioned) {
                        "Tapped Facebook \"${cand.label}\" (${cand.category}) via $method and observed UI update."
                    } else {
                        "Tapped Facebook \"${cand.label}\" (${cand.category}) via $method."
                    },
                    target = cand.label,
                    executionStatus = if (transitioned) "facebook_control_clicked" else "clicked_unverified",
                    data = JSONObject()
                        .put("label", cand.label)
                        .put("category", cand.category)
                        .put("rankIndex", resolution.rankIndex)
                        .put("method", method)
                )
            }
        }
    }

    fun clickVisibleElementAdvanced(targetText: String, index: Int? = null): AccessibilityActionOutcome {
        val activePkg = getActivePackageName()
        val lower = targetText.trim().lowercase()
        // Route YouTube-specific visible requests (thumbnail / play / pause / stop / video) to the YouTube Click Engine automatically
        if (YouTubeClickEngine.isYouTubePackage(activePkg) &&
            (lower.contains("video") || lower.contains("ভিডিও") || lower.contains("वीडियो") ||
                lower.contains("thumbnail") || lower.contains("থাম্বনেইল") ||
                lower.contains("play") || lower.contains("প্লে") ||
                lower.contains("pause") || lower.contains("পজ") ||
                lower.contains("stop") || lower.contains("স্টপ"))
        ) {
            return clickYouTubeVideo(index = index, targetHint = targetText, titleQuery = "", actionTypeName = "click_visible_element")
        }
        // Route Facebook visible controls (Like, Comment, Share, Menu, Notifications, Search, tabs) to FacebookUiControlEngine
        if (FacebookUiControlEngine.isFacebookPackage(activePkg)) {
            return clickFacebookControl(targetText, index)
        }
        if (!UiActionDeduplicator.tryAcquire(activePkg, "click_visible_element", "$targetText#${index ?: 0}")) {
            return AccessibilityActionOutcome(
                success = false,
                verified = true,
                actionType = "click_visible_element",
                activePackage = activePkg,
                message = "Prevented accidental duplicate tap on \"$targetText\".",
                failureReason = "duplicate_tap_prevented",
                target = targetText,
                executionStatus = "duplicate_blocked"
            )
        }
        return tapElementByTextDetailed(targetText).copy(actionType = "click_visible_element", target = targetText)
    }

    // ========================================================================
    // PART 2A — WHATSAPP SMART CONTACT & CHAT NAME CLICK ENGINE
    // ========================================================================

    fun clickWhatsAppContact(
        contactQuery: String = "",
        ordinalIndex: Int? = null,
        searchIfMissing: Boolean = true,
        actionTypeName: String = "click_whatsapp_contact"
    ): AccessibilityActionOutcome {
        // Wait briefly if WhatsApp was just launched
        var root: AccessibilityNodeInfo? = null
        var activePkg = ""
        for (attempt in 0 until 7) {
            val candidateRoot = rootInActiveWindow
            val pkg = candidateRoot?.packageName?.toString().orEmpty()
            if (candidateRoot != null && WhatsAppAutomationValidator.isWhatsAppPackage(pkg)) {
                root = candidateRoot
                activePkg = pkg
                break
            }
            try {
                Thread.sleep(250L)
            } catch (_: InterruptedException) {
                break
            }
        }

        val waRoot = root ?: return AccessibilityActionOutcome(
            success = false,
            verified = false,
            actionType = actionTypeName,
            activePackage = getActivePackageName(),
            message = "WhatsApp is not currently open on screen. Please open WhatsApp first.",
            failureReason = "whatsapp_not_in_foreground",
            target = contactQuery.ifBlank { ordinalIndex?.let { "contact #$it" } ?: "" },
            executionStatus = "whatsapp_not_in_foreground"
        )

        checkScreenSafety(waRoot, actionTypeName)?.let { return it }

        val cleanQuery = contactQuery.trim()
        var (snapshots, nodeMap) = captureNodeSnapshotTree(waRoot)
        var resolution = WhatsAppSmartContactEngine.resolveContactTarget(snapshots, cleanQuery, ordinalIndex)

        // If contact name is not immediately visible on main chat list and searchIfMissing=true, use WhatsApp's own visible Search field cleanly
        if (resolution is WhatsAppContactResolution.NotFound && searchIfMissing && cleanQuery.isNotBlank()) {
            val searchOpened = openWhatsAppInAppSearch(waRoot, MultilingualNameMatcher.cleanPersonQuery(cleanQuery))
            if (searchOpened) {
                try {
                    Thread.sleep(550L)
                } catch (_: InterruptedException) {
                    // ignore
                }
                val refreshedRoot = rootInActiveWindow ?: waRoot
                val refreshedTree = captureNodeSnapshotTree(refreshedRoot)
                snapshots = refreshedTree.first
                nodeMap = refreshedTree.second
                resolution = WhatsAppSmartContactEngine.resolveContactTarget(snapshots, cleanQuery, ordinalIndex)
            }
        }

        return when (resolution) {
            is WhatsAppContactResolution.NotFound -> AccessibilityActionOutcome(
                success = false,
                verified = true,
                actionType = actionTypeName,
                activePackage = activePkg,
                message = resolution.reason,
                failureReason = resolution.failureCode,
                target = cleanQuery.ifBlank { ordinalIndex?.toString().orEmpty() },
                executionStatus = resolution.failureCode
            )
            is WhatsAppContactResolution.Ambiguous -> {
                val arr = JSONArray()
                resolution.candidates.forEach { c ->
                    arr.put(JSONObject().put("name", c.displayName).put("phone", ""))
                }
                AccessibilityActionOutcome(
                    success = false,
                    verified = true,
                    actionType = actionTypeName,
                    activePackage = activePkg,
                    message = "Multiple visible WhatsApp contacts match \"${resolution.query}\". Please choose which contact to open.",
                    failureReason = "multiple_contacts",
                    target = resolution.query,
                    executionStatus = "multiple_contacts",
                    data = JSONObject()
                        .put("query", resolution.query)
                        .put("recipient", resolution.query)
                        .put("candidates", arr)
                )
            }
            is WhatsAppContactResolution.Matched -> {
                val cand = resolution.candidate
                val liveNameNode = nodeMap[cand.nameNode.nodeId]
                val liveClickable = cand.clickableNode?.let { nodeMap[it.nodeId] }
                val preClickMs = System.currentTimeMillis()

                val (clicked, method) = performSmartClickOnResolvedTarget(liveNameNode, liveClickable, cand.bounds)
                if (!clicked) {
                    return AccessibilityActionOutcome(
                        success = false,
                        verified = false,
                        actionType = actionTypeName,
                        activePackage = activePkg,
                        message = "Found WhatsApp contact \"${cand.displayName}\", but could not click it safely.",
                        failureReason = "contact_click_rejected",
                        target = cand.displayName,
                        executionStatus = "failed"
                    )
                }

                waitForUiTransitionEvent(preClickMs, 950L)
                val postRoot = rootInActiveWindow
                val postPkg = postRoot?.packageName?.toString().orEmpty().ifBlank { activePkg }
                val postSnapshots = if (postRoot != null) captureNodeSnapshotTree(postRoot).first else emptyList()
                val chatOpened = WhatsAppSmartContactEngine.verifyConversationOpened(
                    afterNodes = postSnapshots,
                    expectedName = cand.displayName,
                    expectedPhone = "",
                    activePackage = postPkg
                )

                AccessibilityActionOutcome(
                    success = true,
                    verified = chatOpened,
                    actionType = actionTypeName,
                    activePackage = postPkg,
                    message = if (chatOpened) {
                        "Clicked \"${cand.displayName}\" in WhatsApp via $method and verified the conversation opened."
                    } else {
                        "Clicked \"${cand.displayName}\" in WhatsApp via $method, but could not verify the conversation header opened."
                    },
                    failureReason = if (chatOpened) null else "conversation_open_unverified",
                    target = cand.displayName,
                    executionStatus = if (chatOpened) "whatsapp_contact_opened" else "whatsapp_click_unverified",
                    data = JSONObject()
                        .put("contactName", cand.displayName)
                        .put("target", cand.displayName)
                        .put("method", method)
                        .put("conversationVerified", chatOpened)
                )
            }
        }
    }

    private fun openWhatsAppInAppSearch(root: AccessibilityNodeInfo, query: String): Boolean {
        val searchNode = findBestSemanticNode(root, "Search")
            ?: findBestSemanticNode(root, "Ask Meta AI or Search")
            ?: findBestSemanticNode(root, "খুঁজুন")
            ?: return false

        val rect = Rect()
        searchNode.getBoundsInScreen(rect)
        val (clicked, _) = performSmartClickOnResolvedTarget(
            searchNode,
            null,
            AccessibleRect(rect.left, rect.top, rect.right, rect.bottom)
        )
        if (!clicked) return false

        try {
            Thread.sleep(320L)
        } catch (_: InterruptedException) {
            // ignore
        }
        val activeRoot = rootInActiveWindow ?: root
        val searchInput = findEditableNode(activeRoot, "Search") ?: return false
        if (searchInput.isPassword) return false
        searchInput.performAction(AccessibilityNodeInfo.ACTION_FOCUS)
        val args = Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, query)
        }
        return searchInput.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
    }

    private fun findEditableNode(root: AccessibilityNodeInfo, targetHint: String): AccessibilityNodeInfo? {
        val hintQuery = targetHint.trim().lowercase()
        var fallbackEditable: AccessibilityNodeInfo? = null

        fun search(node: AccessibilityNodeInfo?): AccessibilityNodeInfo? {
            if (node == null || node.isPassword) return null
            if (node.isEditable && node.isVisibleToUser && node.isEnabled) {
                val hint = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    node.hintText?.toString()?.lowercase().orEmpty()
                } else {
                    ""
                }
                val text = node.text?.toString()?.lowercase().orEmpty()
                val desc = node.contentDescription?.toString()?.lowercase().orEmpty()
                val vid = node.viewIdResourceName?.lowercase().orEmpty()
                if (AccessibilityGuard.isSensitiveInputHint(hint) ||
                    AccessibilityGuard.isSensitiveInputHint(desc) ||
                    AccessibilityGuard.isSensitiveInputHint(vid)
                ) {
                    return null
                }
                if (hintQuery.isNotEmpty() &&
                    (hint.contains(hintQuery) || text.contains(hintQuery) || desc.contains(hintQuery) || vid.contains(hintQuery))
                ) {
                    return node
                }
                if (fallbackEditable == null) {
                    fallbackEditable = node
                }
            }
            for (i in 0 until node.childCount) {
                val found = search(node.getChild(i))
                if (found != null) return found
            }
            return null
        }

        return search(root) ?: fallbackEditable
    }

    // ========================================================================
    // PART 2B — TYPE WHATSAPP MESSAGE ONLY (NEVER CLICKS SEND!)
    // ========================================================================

    fun typeWhatsAppMessageOnly(
        expectedRecipient: String,
        messageText: String
    ): AccessibilityActionOutcome {
        val cleanMsg = messageText.trim()
        if (cleanMsg.isEmpty()) {
            return AccessibilityActionOutcome(
                success = false,
                verified = false,
                actionType = "type_whatsapp_message",
                activePackage = getActivePackageName(),
                message = "No message text was provided to type into WhatsApp.",
                failureReason = "empty_message",
                target = expectedRecipient,
                executionStatus = "missing_message"
            )
        }

        val root = rootInActiveWindow
        val activePkg = root?.packageName?.toString().orEmpty()
        if (root == null || !WhatsAppAutomationValidator.isWhatsAppPackage(activePkg)) {
            return AccessibilityActionOutcome(
                success = false,
                verified = false,
                actionType = "type_whatsapp_message",
                activePackage = activePkg,
                message = "WhatsApp conversation must be open on screen to type your message.",
                failureReason = "whatsapp_not_in_foreground",
                target = expectedRecipient,
                executionStatus = "whatsapp_not_in_foreground"
            )
        }
        checkScreenSafety(root, "type_whatsapp_message")?.let { return it }

        if (expectedRecipient.isNotBlank()) {
            val labels = collectVisibleLabels(root, 40)
            val matched = WhatsAppAutomationValidator.matchesExpectedRecipient(labels, expectedRecipient, "") ||
                labels.take(12).any { MultilingualNameMatcher.matchesQuery(it, expectedRecipient) }
            if (!matched) {
                return AccessibilityActionOutcome(
                    success = false,
                    verified = false,
                    actionType = "type_whatsapp_message",
                    activePackage = activePkg,
                    message = "Active WhatsApp conversation header does not match \"$expectedRecipient\". Stopped before typing.",
                    failureReason = "recipient_verification_failed",
                    target = expectedRecipient,
                    executionStatus = "recipient_verification_failed"
                )
            }
        }

        val composer = findWhatsAppComposerNode(root)
        if (composer == null || composer.isPassword) {
            return AccessibilityActionOutcome(
                success = false,
                verified = false,
                actionType = "type_whatsapp_message",
                activePackage = activePkg,
                message = "Could not locate the visible WhatsApp message composer.",
                failureReason = "composer_not_found",
                target = expectedRecipient,
                executionStatus = "composer_not_found"
            )
        }

        composer.performAction(AccessibilityNodeInfo.ACTION_FOCUS)
        val args = Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, cleanMsg)
        }
        val setOk = composer.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
        try {
            Thread.sleep(220L)
        } catch (_: InterruptedException) {
            // ignore
        }
        composer.refresh()
        val refreshedText = (findWhatsAppComposerNode(rootInActiveWindow ?: root) ?: composer).text?.toString()?.trim().orEmpty()
        val verified = setOk && WhatsAppAutomationValidator.composerMatchesApprovedMessage(refreshedText, cleanMsg)

        return AccessibilityActionOutcome(
            success = verified,
            verified = verified,
            actionType = "type_whatsapp_message",
            activePackage = activePkg,
            message = if (verified) {
                "Typed your exact message in WhatsApp composer (did NOT tap Send because only typing was requested)."
            } else {
                "Could not verify the exact message text in the WhatsApp composer."
            },
            failureReason = if (verified) null else "composer_verification_failed",
            target = expectedRecipient,
            executionStatus = if (verified) "whatsapp_message_typed_not_sent" else "failed",
            data = JSONObject()
                .put("contactName", expectedRecipient)
                .put("messageText", cleanMsg)
                .put("sent", false)
        )
    }

    // ========================================================================
    // PART 2C & 2D — FIXED WHATSAPP SEND BUTTON RESOLVER + POST-SEND VERIFIER
    // ========================================================================

    fun sendApprovedWhatsAppMessage(
        expectedRecipient: String,
        expectedPhone: String,
        expectedMessage: String,
        pendingActionId: String
    ): AccessibilityActionOutcome {
        val cleanMsg = expectedMessage.trim()
        if (cleanMsg.isEmpty()) {
            return AccessibilityActionOutcome(
                success = false,
                verified = false,
                actionType = "send_whatsapp_message",
                activePackage = getActivePackageName(),
                message = "Cannot send an empty WhatsApp message.",
                failureReason = "empty_message",
                target = expectedRecipient,
                executionStatus = "empty_message"
            )
        }

        if (!WhatsAppSendDeduplicator.tryAcquire(pendingActionId)) {
            return AccessibilityActionOutcome(
                success = false,
                verified = true,
                actionType = "send_whatsapp_message",
                activePackage = getActivePackageName(),
                message = "Duplicate send prevented: this WhatsApp message was already processed.",
                failureReason = "duplicate_send_prevented",
                target = expectedRecipient,
                executionStatus = "duplicate_blocked"
            )
        }

        // 1. Wait up to ~3.0s for WhatsApp conversation window to enter foreground
        var root: AccessibilityNodeInfo? = null
        var activePkg = ""
        for (attempt in 0 until 10) {
            val candidateRoot = rootInActiveWindow
            val pkg = candidateRoot?.packageName?.toString().orEmpty()
            if (candidateRoot != null && WhatsAppAutomationValidator.isWhatsAppPackage(pkg)) {
                root = candidateRoot
                activePkg = pkg
                break
            }
            try {
                Thread.sleep(300L)
            } catch (_: InterruptedException) {
                break
            }
        }

        val waRoot = root ?: run {
            WhatsAppSendDeduplicator.release(pendingActionId)
            return AccessibilityActionOutcome(
                success = false,
                verified = false,
                actionType = "send_whatsapp_message",
                activePackage = getActivePackageName(),
                message = "WhatsApp did not reach the foreground in time. Your draft is open — please tap Send manually.",
                failureReason = "whatsapp_window_not_ready",
                target = expectedRecipient,
                executionStatus = "whatsapp_window_not_ready"
            )
        }

        checkScreenSafety(waRoot, "send_whatsapp_message")?.let { blocked ->
            WhatsAppSendDeduplicator.release(pendingActionId)
            return blocked
        }

        // 2. Verify conversation header matches expected recipient name/transliteration or phone
        val visibleLabels = collectVisibleLabels(waRoot, 45)
        val recipientVerified = (expectedRecipient.isBlank() && expectedPhone.isBlank()) ||
            WhatsAppAutomationValidator.matchesExpectedRecipient(
                visibleLabels = visibleLabels,
                expectedRecipient = expectedRecipient,
                expectedPhone = expectedPhone
            ) ||
            (expectedRecipient.isNotBlank() && visibleLabels.take(14).any {
                MultilingualNameMatcher.matchesQuery(it, expectedRecipient)
            })
        if (!recipientVerified) {
            WhatsAppSendDeduplicator.release(pendingActionId)
            return AccessibilityActionOutcome(
                success = false,
                verified = false,
                actionType = "send_whatsapp_message",
                activePackage = activePkg,
                message = "Could not verify the active WhatsApp conversation header matches \"$expectedRecipient\". Stopped before tapping Send for your safety.",
                failureReason = "recipient_verification_failed",
                target = expectedRecipient,
                executionStatus = "recipient_verification_failed"
            )
        }

        // 3. Locate WhatsApp composer and guarantee it contains EXACTLY the user's message
        var composerNode: AccessibilityNodeInfo? = null
        for (attempt in 0 until 5) {
            val liveRoot = rootInActiveWindow ?: waRoot
            composerNode = findWhatsAppComposerNode(liveRoot)
            if (composerNode != null) break
            try {
                Thread.sleep(220L)
            } catch (_: InterruptedException) {
                break
            }
        }

        if (composerNode == null || composerNode.isPassword) {
            WhatsAppSendDeduplicator.release(pendingActionId)
            return AccessibilityActionOutcome(
                success = false,
                verified = false,
                actionType = "send_whatsapp_message",
                activePackage = activePkg,
                message = "Could not locate the WhatsApp message composer safely. Please verify and tap Send manually.",
                failureReason = "composer_not_found",
                target = expectedRecipient,
                executionStatus = "composer_not_found"
            )
        }

        val existingComposerText = composerNode.text?.toString()?.trim().orEmpty()
        if (!WhatsAppAutomationValidator.composerMatchesApprovedMessage(existingComposerText, cleanMsg)) {
            composerNode.performAction(AccessibilityNodeInfo.ACTION_FOCUS)
            composerNode.performAction(AccessibilityNodeInfo.ACTION_CLICK)
            val args = Bundle().apply {
                putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, cleanMsg)
            }
            val setOk = composerNode.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
            if (!setOk) {
                WhatsAppSendDeduplicator.release(pendingActionId)
                return AccessibilityActionOutcome(
                    success = false,
                    verified = false,
                    actionType = "send_whatsapp_message",
                    activePackage = activePkg,
                    message = "Could not enter the exact message in the WhatsApp composer. Stopped before tapping Send.",
                    failureReason = "composer_set_text_failed",
                    target = expectedRecipient,
                    executionStatus = "composer_set_text_failed"
                )
            }
            try {
                Thread.sleep(260L)
            } catch (_: InterruptedException) {
                // ignore
            }
        }

        // Verify exact message text appears in composer before looking for Send button
        composerNode.refresh()
        val postTypeRoot = rootInActiveWindow ?: waRoot
        val refreshedComposer = findWhatsAppComposerNode(postTypeRoot) ?: composerNode
        val verifiedComposerText = refreshedComposer.text?.toString()?.trim().orEmpty()
        if (!WhatsAppAutomationValidator.composerMatchesApprovedMessage(verifiedComposerText, cleanMsg)) {
            WhatsAppSendDeduplicator.release(pendingActionId)
            return AccessibilityActionOutcome(
                success = false,
                verified = false,
                actionType = "send_whatsapp_message",
                activePackage = activePkg,
                message = "WhatsApp composer text did not match your exact message. Stopped before tapping Send.",
                failureReason = "composer_verification_failed",
                target = expectedRecipient,
                executionStatus = "composer_verification_failed"
            )
        }

        // 4. Dedicated WhatsApp Send Button Resolver with event-aware retry loop
        //    Handles WhatsApp's mic->Send icon swap lag after ACTION_SET_TEXT or wa.me prefill.
        val composerRawRect = Rect()
        refreshedComposer.getBoundsInScreen(composerRawRect)
        val composerBounds = AccessibleRect(
            composerRawRect.left,
            composerRawRect.top,
            composerRawRect.right,
            composerRawRect.bottom
        )

        var resolvedSendMatch: WhatsAppSendButtonMatch? = null
        var resolvedNodeMap: Map<Int, AccessibilityNodeInfo> = emptyMap()

        for (poll in 0 until 8) {
            val currentRoot = rootInActiveWindow ?: postTypeRoot
            val (snapList, snapNodeMap) = captureNodeSnapshotTree(currentRoot)
            val match = WhatsAppSendButtonResolver.resolveSendButton(snapList, composerBounds)
            if (match != null) {
                resolvedSendMatch = match
                resolvedNodeMap = snapNodeMap
                break
            }
            // On poll 2, refocus composer and re-set the exact text once to trigger WhatsApp's TextWatcher mic->Send swap
            if (poll == 2) {
                val cNode = findWhatsAppComposerNode(currentRoot)
                if (cNode != null && !cNode.isPassword) {
                    cNode.performAction(AccessibilityNodeInfo.ACTION_FOCUS)
                    val reArgs = Bundle().apply {
                        putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, cleanMsg)
                    }
                    cNode.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, reArgs)
                }
            }
            try {
                Thread.sleep(190L)
            } catch (_: InterruptedException) {
                break
            }
        }

        val sendMatch = resolvedSendMatch ?: run {
            WhatsAppSendDeduplicator.release(pendingActionId)
            return AccessibilityActionOutcome(
                success = false,
                verified = false,
                actionType = "send_whatsapp_message",
                activePackage = activePkg,
                message = "Your exact message is in the WhatsApp composer, but the visible Send button could not be reliably identified (stopped safely rather than guessing coordinates).",
                failureReason = "send_button_not_found",
                target = expectedRecipient,
                executionStatus = "send_button_not_found"
            )
        }

        // 5. Execute Send via ACTION_CLICK -> clickable parent -> bounded gesture ONLY on verified Send bounds
        val liveSendBtn = resolvedNodeMap[sendMatch.buttonNode.nodeId]
        val liveClickableSend = sendMatch.clickableNode?.let { resolvedNodeMap[it.nodeId] }
        val preSendMs = System.currentTimeMillis()
        val (clicked, clickMethod) = performSmartClickOnResolvedTarget(
            targetNode = liveSendBtn,
            clickableAncestor = liveClickableSend,
            verifiedBounds = sendMatch.bounds
        )

        if (!clicked) {
            WhatsAppSendDeduplicator.release(pendingActionId)
            return AccessibilityActionOutcome(
                success = false,
                verified = false,
                actionType = "send_whatsapp_message",
                activePackage = activePkg,
                message = "Found the WhatsApp Send button (${sendMatch.matchedBy}), but the click could not be executed. Please tap Send manually.",
                failureReason = "send_click_rejected",
                target = expectedRecipient,
                executionStatus = "send_click_rejected"
            )
        }

        // 6. Observe Accessibility events & verify outgoing message state honestly (pending / sent / delivered / unverified)
        waitForUiTransitionEvent(preSendMs, 950L)
        val verification = inspectActiveWhatsAppSendState(cleanMsg)

        // Note: Do NOT release deduplicator when click was dispatched to prevent uncertain duplicate sends!
        return AccessibilityActionOutcome(
            success = verification.verified,
            verified = verification.verified,
            actionType = "send_whatsapp_message",
            activePackage = activePkg,
            message = if (verification.verified) {
                "WhatsApp message sent to $expectedRecipient via $clickMethod (${sendMatch.matchedBy}). ${verification.evidence}"
            } else {
                "Clicked WhatsApp Send for $expectedRecipient via $clickMethod, but sending could not be verified: ${verification.evidence}"
            },
            failureReason = if (verification.verified) null else "send_verification_failed",
            target = expectedRecipient,
            executionStatus = verification.state.statusCode,
            data = JSONObject()
                .put("contactName", expectedRecipient)
                .put("phoneNumber", expectedPhone)
                .put("messageText", cleanMsg)
                .put("method", clickMethod)
                .put("sendButtonSignals", sendMatch.matchedBy)
                .put("deliveryState", verification.state.name.lowercase())
                .put("sentVerified", verification.verified)
                .put("deliveryVerified", verification.state == WhatsAppDeliveryState.DELIVERED)
                .put("readVerified", false)
                .put("evidence", verification.evidence)
        )
    }

    private fun inspectActiveWhatsAppSendState(expectedMessage: String): WhatsAppSendVerificationReport {
        val postRoot = rootInActiveWindow ?: return WhatsAppSendVerificationReport(
            verified = false,
            state = WhatsAppDeliveryState.UNVERIFIED,
            bubbleVisible = false,
            composerCleared = false,
            evidence = "No active WhatsApp window available for post-send verification."
        )
        val postSnapshots = captureNodeSnapshotTree(postRoot).first
        val postComposer = findWhatsAppComposerNode(postRoot)?.text?.toString().orEmpty()
        return WhatsAppSendButtonResolver.verifyPostSendState(
            afterNodes = postSnapshots,
            composerText = postComposer,
            expectedMessage = expectedMessage
        )
    }

    fun verifyWhatsAppSendState(
        expectedRecipient: String,
        expectedMessage: String
    ): AccessibilityActionOutcome {
        val root = rootInActiveWindow
        val activePkg = root?.packageName?.toString().orEmpty()
        if (root == null || !WhatsAppAutomationValidator.isWhatsAppPackage(activePkg)) {
            return AccessibilityActionOutcome(
                success = false,
                verified = false,
                actionType = "verify_whatsapp_send",
                activePackage = activePkg,
                message = "WhatsApp is not currently visible on screen to verify message status.",
                failureReason = "whatsapp_not_in_foreground",
                target = expectedRecipient,
                executionStatus = "whatsapp_not_in_foreground"
            )
        }
        checkScreenSafety(root, "verify_whatsapp_send")?.let { return it }

        val report = inspectActiveWhatsAppSendState(expectedMessage)
        return AccessibilityActionOutcome(
            success = report.verified,
            verified = report.verified,
            actionType = "verify_whatsapp_send",
            activePackage = activePkg,
            message = report.evidence,
            failureReason = if (report.verified) null else "send_verification_failed",
            target = expectedRecipient,
            executionStatus = report.state.statusCode,
            data = JSONObject()
                .put("contactName", expectedRecipient)
                .put("messageText", expectedMessage)
                .put("deliveryState", report.state.name.lowercase())
                .put("bubbleVisible", report.bubbleVisible)
                .put("composerCleared", report.composerCleared)
                .put("deliveryVerified", report.state == WhatsAppDeliveryState.DELIVERED)
                .put("readVerified", false)
        )
    }

    /**
     * Controlled Generic App Chat Automation for explicitly supported accessible messaging apps
     * (Telegram, Instagram, Messenger) ONLY invoked AFTER explicit user approval.
     */
    fun sendApprovedAppChatMessage(
        appName: String,
        expectedRecipient: String,
        expectedMessage: String,
        pendingActionId: String
    ): AccessibilityActionOutcome {
        val adapter = AppChatAdapterRegistry.findAdapter(appName)
            ?: return AccessibilityActionOutcome(
                success = false,
                verified = false,
                actionType = "app_chat_send_approved",
                activePackage = getActivePackageName(),
                message = "Automated chat sending is not supported for \"$appName\".",
                failureReason = "unsupported_chat_app"
            )

        val cleanMsg = expectedMessage.trim()
        if (cleanMsg.isEmpty()) {
            return AccessibilityActionOutcome(
                success = false,
                verified = false,
                actionType = "app_chat_send_approved",
                activePackage = getActivePackageName(),
                message = "Cannot send an empty message in ${adapter.appName}.",
                failureReason = "empty_message"
            )
        }

        if (!WhatsAppSendDeduplicator.tryAcquire(pendingActionId)) {
            return AccessibilityActionOutcome(
                success = false,
                verified = true,
                actionType = "app_chat_send_approved",
                activePackage = getActivePackageName(),
                message = "Duplicate send prevented: this approved ${adapter.appName} message was already processed.",
                failureReason = "duplicate_send_prevented"
            )
        }

        // Wait briefly for target messaging app to reach foreground
        var root: AccessibilityNodeInfo? = null
        var activePkg = ""
        for (attempt in 0 until 8) {
            val candidateRoot = rootInActiveWindow
            val pkg = candidateRoot?.packageName?.toString().orEmpty()
            if (candidateRoot != null && adapter.matchesPackage(pkg)) {
                root = candidateRoot
                activePkg = pkg
                break
            }
            try {
                Thread.sleep(300L)
            } catch (_: InterruptedException) {
                break
            }
        }

        val appRoot = root ?: run {
            WhatsAppSendDeduplicator.release(pendingActionId)
            return AccessibilityActionOutcome(
                success = false,
                verified = false,
                actionType = "app_chat_send_approved",
                activePackage = getActivePackageName(),
                message = "${adapter.appName} did not reach the foreground in time. Please send your message manually.",
                failureReason = "target_app_not_in_foreground"
            )
        }

        checkScreenSafety(appRoot, "app_chat_send_approved")?.let { blocked ->
            WhatsAppSendDeduplicator.release(pendingActionId)
            return blocked
        }

        // Verify expected recipient appears in visible screen labels if recipient is specified
        val visibleLabels = collectVisibleLabels(appRoot, 45)
        if (expectedRecipient.isNotBlank() && !WhatsAppAutomationValidator.matchesExpectedRecipient(visibleLabels, expectedRecipient, "")) {
            WhatsAppSendDeduplicator.release(pendingActionId)
            return AccessibilityActionOutcome(
                success = false,
                verified = false,
                actionType = "app_chat_send_approved",
                activePackage = activePkg,
                message = "Opened ${adapter.appName}, but could not verify active chat matches \"$expectedRecipient\". Open their chat and tap Send manually.",
                failureReason = "recipient_verification_failed"
            )
        }

        val composer = findComposerForAdapter(appRoot, adapter)
        if (composer == null || composer.isPassword) {
            WhatsAppSendDeduplicator.release(pendingActionId)
            return AccessibilityActionOutcome(
                success = false,
                verified = false,
                actionType = "app_chat_send_approved",
                activePackage = activePkg,
                message = "Opened ${adapter.appName}, but no visible chat composer was detected. Open the chat and send manually.",
                failureReason = "composer_not_found"
            )
        }

        composer.performAction(AccessibilityNodeInfo.ACTION_FOCUS)
        val setArgs = Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, cleanMsg)
        }
        val setOk = composer.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, setArgs)
        if (!setOk) {
            WhatsAppSendDeduplicator.release(pendingActionId)
            return AccessibilityActionOutcome(
                success = false,
                verified = false,
                actionType = "app_chat_send_approved",
                activePackage = activePkg,
                message = "Could not enter text into ${adapter.appName} composer. Please type and send manually.",
                failureReason = "composer_set_text_failed"
            )
        }
        try {
            Thread.sleep(220L)
        } catch (_: InterruptedException) {
            // ignore
        }

        composer.refresh()
        val refreshedRoot = rootInActiveWindow ?: appRoot
        val refreshedComposer = findComposerForAdapter(refreshedRoot, adapter) ?: composer
        val currentText = refreshedComposer.text?.toString()?.trim().orEmpty()
        if (!WhatsAppAutomationValidator.composerMatchesApprovedMessage(currentText, cleanMsg)) {
            WhatsAppSendDeduplicator.release(pendingActionId)
            return AccessibilityActionOutcome(
                success = false,
                verified = false,
                actionType = "app_chat_send_approved",
                activePackage = activePkg,
                message = "${adapter.appName} composer text could not be verified against your approved message. Please review and send manually.",
                failureReason = "composer_verification_failed"
            )
        }

        val sendBtn = findSendButtonForAdapter(refreshedRoot, adapter)
        if (sendBtn == null) {
            WhatsAppSendDeduplicator.release(pendingActionId)
            return AccessibilityActionOutcome(
                success = false,
                verified = false,
                actionType = "app_chat_send_approved",
                activePackage = activePkg,
                message = "Entered your approved message in ${adapter.appName}, but the Send button was not found. Please tap Send manually.",
                failureReason = "send_button_not_found"
            )
        }

        var clicked = sendBtn.performAction(AccessibilityNodeInfo.ACTION_CLICK)
        var clickMethod = "semantic_send_click"
        if (!clicked) {
            val rect = Rect()
            sendBtn.getBoundsInScreen(rect)
            if (!rect.isEmpty && rect.centerX() > 0 && rect.centerY() > 0) {
                clicked = dispatchTapGesture(rect.centerX().toFloat(), rect.centerY().toFloat())
                clickMethod = "bounded_send_gesture"
            }
        }

        if (!clicked) {
            WhatsAppSendDeduplicator.release(pendingActionId)
            return AccessibilityActionOutcome(
                success = false,
                verified = false,
                actionType = "app_chat_send_approved",
                activePackage = activePkg,
                message = "Could not trigger Send in ${adapter.appName}. Please tap Send manually.",
                failureReason = "send_click_rejected"
            )
        }

        try {
            Thread.sleep(450L)
        } catch (_: InterruptedException) {
            // ignore
        }
        val postRoot = rootInActiveWindow
        val postLabels = if (postRoot != null) collectVisibleLabels(postRoot, 60) else emptyList()
        val postComposer = if (postRoot != null) findComposerForAdapter(postRoot, adapter)?.text?.toString().orEmpty() else ""
        val sentVerified = WhatsAppAutomationValidator.verifyOutgoingMessageVisible(postLabels, postComposer, cleanMsg)

        return AccessibilityActionOutcome(
            success = true,
            verified = sentVerified,
            actionType = "app_chat_send_approved",
            activePackage = activePkg,
            message = if (sentVerified) {
                "Send clicked and verified in ${adapter.appName} for $expectedRecipient."
            } else {
                "Triggered Send in ${adapter.appName} for $expectedRecipient, please verify delivery in the app."
            },
            data = JSONObject()
                .put("appName", adapter.appName)
                .put("packageName", activePkg)
                .put("contactName", expectedRecipient)
                .put("method", clickMethod)
                .put("sentVerified", sentVerified)
                .put("deliveryVerified", false)
                .put("readVerified", false)
        )
    }

    private fun findComposerForAdapter(root: AccessibilityNodeInfo, adapter: SupportedAppChatAdapter): AccessibilityNodeInfo? {
        var fallbackEditable: AccessibilityNodeInfo? = null
        fun search(node: AccessibilityNodeInfo?): AccessibilityNodeInfo? {
            if (node == null || node.isPassword) return null
            if (node.isEditable && node.isVisibleToUser) {
                val vid = node.viewIdResourceName?.lowercase().orEmpty()
                val hint = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) node.hintText?.toString()?.lowercase().orEmpty() else ""
                if (AccessibilityGuard.isSensitiveInputHint(hint)) return null
                if (adapter.composerIdHints.any { vid.contains(it) || hint.contains(it) }) {
                    return node
                }
                if (fallbackEditable == null) fallbackEditable = node
            }
            for (i in 0 until node.childCount) {
                val found = search(node.getChild(i))
                if (found != null) return found
            }
            return null
        }
        return search(root) ?: fallbackEditable
    }

    private fun findSendButtonForAdapter(root: AccessibilityNodeInfo, adapter: SupportedAppChatAdapter): AccessibilityNodeInfo? {
        fun search(node: AccessibilityNodeInfo?): AccessibilityNodeInfo? {
            if (node == null || node.isPassword) return null
            if (adapter.matchesSendButton(
                    viewId = node.viewIdResourceName,
                    contentDescription = node.contentDescription?.toString(),
                    text = node.text?.toString(),
                    isEnabled = node.isEnabled,
                    isVisible = node.isVisibleToUser
                )
            ) {
                var target: AccessibilityNodeInfo? = node
                while (target != null && !target.isClickable) {
                    target = target.parent
                }
                return target ?: node
            }
            for (i in 0 until node.childCount) {
                val found = search(node.getChild(i))
                if (found != null) return found
            }
            return null
        }
        return search(root)
    }

    private fun findWhatsAppComposerNode(root: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        var fallbackEditable: AccessibilityNodeInfo? = null
        fun search(node: AccessibilityNodeInfo?): AccessibilityNodeInfo? {
            if (node == null || node.isPassword) return null
            val vid = node.viewIdResourceName?.lowercase().orEmpty()
            val hint = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) node.hintText?.toString()?.lowercase().orEmpty() else ""
            if (node.isEditable && node.isVisibleToUser && !AccessibilityGuard.isSensitiveInputHint(hint)) {
                if (vid.endsWith(":id/entry") || vid.contains("message") || vid.contains("compose") ||
                    hint.contains("message") || hint.contains("মেসেজ") || hint.contains("संदेश")
                ) {
                    return node
                }
                if (fallbackEditable == null && !vid.contains("search")) {
                    fallbackEditable = node
                }
            }
            for (i in 0 until node.childCount) {
                val found = search(node.getChild(i))
                if (found != null) return found
            }
            return null
        }
        return search(root) ?: fallbackEditable
    }

    private fun findWhatsAppSendButton(root: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        fun search(node: AccessibilityNodeInfo?): AccessibilityNodeInfo? {
            if (node == null || node.isPassword) return null
            val isSend = WhatsAppAutomationValidator.isSendButtonNode(
                viewId = node.viewIdResourceName,
                contentDescription = node.contentDescription?.toString(),
                text = node.text?.toString(),
                isEnabled = node.isEnabled,
                isVisible = node.isVisibleToUser
            )
            if (isSend) {
                var target: AccessibilityNodeInfo? = node
                while (target != null && !target.isClickable) {
                    target = target.parent
                }
                return target ?: node
            }
            for (i in 0 until node.childCount) {
                val found = search(node.getChild(i))
                if (found != null) return found
            }
            return null
        }
        return search(root)
    }

    // Legacy boolean helpers preserved for full backward compatibility
    fun clickNodeByText(targetText: String): Boolean = tapElementByTextDetailed(targetText).success
    fun scrollScreen(direction: String): Boolean = scrollScreenDetailed(direction).success
    fun enterTextIntoField(targetHint: String, text: String): Boolean = enterTextDetailed(targetHint, text).success
    fun dumpVisibleScreenText(maxItems: Int = 80): String {
        val outcome = readVisibleScreenDetailed(maxItems)
        return outcome.data?.optString("visibleText", "").orEmpty()
    }

    companion object {
        @Volatile
        var instance: ZoniAccessibilityService? = null
            private set

        @Volatile
        private var lastForegroundPackage: String = ""

        @Volatile
        private var lastEventTimestampMs: Long = 0L

        @Volatile
        private var lastEventType: Int = 0

        @Volatile
        private var lastWindowStateChangeMs: Long = 0L

        @Volatile
        private var lastWindowContentChangeMs: Long = 0L

        fun isConnected(): Boolean = instance != null

        fun getVisibleScreenText(maxItems: Int = 80): String =
            instance?.dumpVisibleScreenText(maxItems).orEmpty()

        fun readVisibleScreenDetailedJson(maxItems: Int = 80): String {
            val svc = instance ?: return AccessibilityActionOutcome(
                success = false,
                verified = false,
                actionType = "read_visible_screen",
                message = "Zoni Accessibility Service is not enabled. Enable it in Android Accessibility Settings.",
                failureReason = "accessibility_service_disabled"
            ).toJson()
            return svc.readVisibleScreenDetailed(maxItems).toJson()
        }

        fun performScroll(direction: String): Boolean =
            instance?.scrollScreen(direction) ?: false

        fun enterText(targetHint: String, text: String): Boolean =
            instance?.enterTextIntoField(targetHint, text) ?: false

        fun executeVerifiedWorkflowJson(stepsJson: String): String {
            val svc = instance ?: return AccessibilityActionOutcome(
                success = false,
                verified = false,
                actionType = "verified_workflow",
                message = "Zoni Accessibility Service is not enabled. Enable it in Android Accessibility Settings.",
                failureReason = "accessibility_service_disabled"
            ).toJson()
            return svc.executeVerifiedWorkflow(stepsJson).toJson()
        }

        fun clickYouTubeVideo(
            index: Int? = null,
            targetHint: String = "",
            titleQuery: String = "",
            actionTypeName: String = "click_youtube_video"
        ): AccessibilityActionOutcome {
            val svc = instance ?: return AccessibilityActionOutcome(
                success = false,
                verified = false,
                actionType = actionTypeName,
                message = "Zoni Accessibility Service is not enabled. Enable it in Android Accessibility Settings to click YouTube videos.",
                failureReason = "accessibility_service_disabled",
                target = titleQuery.ifBlank { targetHint },
                executionStatus = "permission_missing"
            )
            return svc.clickYouTubeVideo(index, targetHint, titleQuery, actionTypeName)
        }

        fun clickVisibleElementAdvanced(targetText: String, index: Int? = null): AccessibilityActionOutcome {
            val svc = instance ?: return AccessibilityActionOutcome(
                success = false,
                verified = false,
                actionType = "click_visible_element",
                message = "Zoni Accessibility Service is not enabled. Enable it in Android Accessibility Settings.",
                failureReason = "accessibility_service_disabled",
                target = targetText,
                executionStatus = "permission_missing"
            )
            return svc.clickVisibleElementAdvanced(targetText, index)
        }

        fun clickWhatsAppContact(
            contactQuery: String = "",
            ordinalIndex: Int? = null,
            searchIfMissing: Boolean = true,
            actionTypeName: String = "click_whatsapp_contact"
        ): AccessibilityActionOutcome {
            val svc = instance ?: return AccessibilityActionOutcome(
                success = false,
                verified = false,
                actionType = actionTypeName,
                message = "Zoni Accessibility Service is not enabled. Enable it in Android Accessibility Settings to click contacts in WhatsApp.",
                failureReason = "accessibility_service_disabled",
                target = contactQuery,
                executionStatus = "permission_missing"
            )
            return svc.clickWhatsAppContact(contactQuery, ordinalIndex, searchIfMissing, actionTypeName)
        }

        fun typeWhatsAppMessageOnly(expectedRecipient: String, messageText: String): AccessibilityActionOutcome {
            val svc = instance ?: return AccessibilityActionOutcome(
                success = false,
                verified = false,
                actionType = "type_whatsapp_message",
                message = "Zoni Accessibility Service is not enabled. Enable it in Android Accessibility Settings to type messages in WhatsApp.",
                failureReason = "accessibility_service_disabled",
                target = expectedRecipient,
                executionStatus = "permission_missing"
            )
            return svc.typeWhatsAppMessageOnly(expectedRecipient, messageText)
        }

        fun verifyWhatsAppSendState(expectedRecipient: String, expectedMessage: String): AccessibilityActionOutcome {
            val svc = instance ?: return AccessibilityActionOutcome(
                success = false,
                verified = false,
                actionType = "verify_whatsapp_send",
                message = "Zoni Accessibility Service is not enabled. Enable it in Android Accessibility Settings to verify WhatsApp sending.",
                failureReason = "accessibility_service_disabled",
                target = expectedRecipient,
                executionStatus = "permission_missing"
            )
            return svc.verifyWhatsAppSendState(expectedRecipient, expectedMessage)
        }

        fun sendApprovedWhatsAppMessage(
            expectedRecipient: String,
            expectedPhone: String,
            expectedMessage: String,
            pendingActionId: String
        ): AccessibilityActionOutcome {
            val svc = instance ?: return AccessibilityActionOutcome(
                success = false,
                verified = false,
                actionType = "send_whatsapp_message",
                message = "Zoni Accessibility Service is not enabled. WhatsApp draft is open — please tap Send manually.",
                failureReason = "accessibility_service_disabled",
                target = expectedRecipient,
                executionStatus = "permission_missing"
            )
            return svc.sendApprovedWhatsAppMessage(
                expectedRecipient = expectedRecipient,
                expectedPhone = expectedPhone,
                expectedMessage = expectedMessage,
                pendingActionId = pendingActionId
            )
        }

        fun sendApprovedAppChatMessage(
            appName: String,
            expectedRecipient: String,
            expectedMessage: String,
            pendingActionId: String
        ): AccessibilityActionOutcome {
            val svc = instance ?: return AccessibilityActionOutcome(
                success = false,
                verified = false,
                actionType = "app_chat_send_approved",
                message = "Zoni Accessibility Service is not enabled. Please enable Accessibility Service or send manually in $appName.",
                failureReason = "accessibility_service_disabled"
            )
            return svc.sendApprovedAppChatMessage(
                appName = appName,
                expectedRecipient = expectedRecipient,
                expectedMessage = expectedMessage,
                pendingActionId = pendingActionId
            )
        }

        fun performExplicitActionDetailedJson(command: String): String {
            val svc = instance ?: return AccessibilityActionOutcome(
                success = false,
                verified = false,
                actionType = command,
                message = "Zoni Accessibility Service is not enabled. Enable it in Android Accessibility Settings.",
                failureReason = "accessibility_service_disabled"
            ).toJson()

            val clean = command.trim()
            val lower = clean.lowercase()
            val outcome = when {
                lower == "home" || lower == "go_home" -> svc.performGlobalNavigationDetailed("home")
                lower == "back" || lower == "go_back" -> svc.performGlobalNavigationDetailed("back")
                lower == "recents" -> svc.performGlobalNavigationDetailed("recents")
                lower == "notifications" -> svc.performGlobalNavigationDetailed("notifications")
                lower == "scroll_down" || lower == "scroll down" -> svc.scrollScreenDetailed("down")
                lower == "scroll_up" || lower == "scroll up" -> svc.scrollScreenDetailed("up")
                lower == "read_screen" -> svc.readVisibleScreenDetailed(80)
                lower.startsWith("tap:") -> svc.tapElementByTextDetailed(clean.substringAfter(":").trim())
                lower.startsWith("click:") -> svc.tapElementByTextDetailed(clean.substringAfter(":").trim())
                lower.startsWith("type:") -> {
                    val rest = clean.substringAfter(":")
                    val parts = rest.split("|", limit = 2)
                    if (parts.size == 2) svc.enterTextDetailed(parts[0], parts[1])
                    else svc.enterTextDetailed("", parts[0])
                }
                else -> svc.tapElementByTextDetailed(clean)
            }
            return outcome.toJson()
        }

        fun performExplicitAction(command: String): Boolean {
            val svc = instance ?: return false
            val clean = command.trim()
            val lower = clean.lowercase()
            return when {
                lower == "home" || lower == "go_home" -> svc.performGlobalNavigationDetailed("home").success
                lower == "back" || lower == "go_back" -> svc.performGlobalNavigationDetailed("back").success
                lower == "recents" -> svc.performGlobalNavigationDetailed("recents").success
                lower == "notifications" -> svc.performGlobalNavigationDetailed("notifications").success
                lower == "scroll_down" || lower == "scroll down" -> svc.scrollScreenDetailed("down").success
                lower == "scroll_up" || lower == "scroll up" -> svc.scrollScreenDetailed("up").success
                lower.startsWith("tap:") -> svc.tapElementByTextDetailed(clean.substringAfter(":").trim()).success
                lower.startsWith("click:") -> svc.tapElementByTextDetailed(clean.substringAfter(":").trim()).success
                lower.startsWith("type:") -> {
                    val rest = clean.substringAfter(":")
                    val parts = rest.split("|", limit = 2)
                    if (parts.size == 2) svc.enterTextDetailed(parts[0], parts[1]).success
                    else svc.enterTextDetailed("", parts[0]).success
                }
                else -> svc.tapElementByTextDetailed(clean).success
            }
        }
    }
}

/**
 * Pure, JVM-testable validation helpers for Phase 6 verified WhatsApp Send automation.
 */
object WhatsAppAutomationValidator {

    private val WHATSAPP_PACKAGES = setOf("com.whatsapp", "com.whatsapp.w4b")
    private val SEND_LABELS = setOf("send", "পাঠান", "भेजें", "भेजे", "send message")

    fun isWhatsAppPackage(packageName: String?): Boolean {
        val clean = packageName?.trim()?.lowercase().orEmpty()
        return clean in WHATSAPP_PACKAGES
    }

    fun isSendButtonNode(
        viewId: String?,
        contentDescription: String?,
        text: String?,
        isEnabled: Boolean,
        isVisible: Boolean
    ): Boolean {
        if (!isEnabled || !isVisible) return false
        val vid = viewId?.trim()?.lowercase().orEmpty()
        if (vid == "com.whatsapp:id/send" ||
            vid == "com.whatsapp.w4b:id/send" ||
            vid.endsWith(":id/send") ||
            vid.endsWith(":id/send_container")
        ) {
            return true
        }
        val desc = contentDescription?.trim()?.lowercase().orEmpty()
        val txt = text?.trim()?.lowercase().orEmpty()
        return desc in SEND_LABELS || txt in SEND_LABELS
    }

    fun composerMatchesApprovedMessage(composerText: String?, approvedMessage: String): Boolean {
        val actual = composerText?.trim()?.replace(Regex("\\s+"), " ").orEmpty()
        val expected = approvedMessage.trim().replace(Regex("\\s+"), " ")
        if (expected.isEmpty()) return false
        return actual == expected
    }

    fun matchesExpectedRecipient(
        visibleLabels: List<String>,
        expectedRecipient: String,
        expectedPhone: String
    ): Boolean {
        val cleanName = expectedRecipient.trim().lowercase()
        val phoneDigits = expectedPhone.filter { it.isDigit() }
        val tailDigits = if (phoneDigits.length >= 7) phoneDigits.takeLast(7) else phoneDigits

        if (cleanName.isEmpty() && tailDigits.isEmpty()) return false

        val headerSlice = visibleLabels.take(12)
        for (label in headerSlice) {
            val lower = label.trim().lowercase()
            if (cleanName.isNotEmpty() && lower.contains(cleanName)) {
                return true
            }
            if (tailDigits.length >= 7) {
                val labelDigits = label.filter { it.isDigit() }
                if (labelDigits.contains(tailDigits)) {
                    return true
                }
            }
        }
        return false
    }

    fun verifyOutgoingMessageVisible(
        visibleChatLabels: List<String>,
        composerText: String,
        expectedMessage: String
    ): Boolean {
        val cleanExpected = expectedMessage.trim()
        if (cleanExpected.isEmpty()) return false
        val snippet = cleanExpected.take(40).lowercase()
        val foundInChat = visibleChatLabels.any { it.lowercase().contains(snippet) }
        val composerCleared = composerText.trim().isEmpty() || !composerText.trim().equals(cleanExpected, ignoreCase = true)
        return foundInChat && composerCleared
    }
}

/**
 * Controlled App-Specific Adapter Registry for Generic Messaging Apps (Root Cause 7).
 * Never assumes all messaging apps share the same UI — only explicitly tested adapters are allowed.
 */
data class SupportedAppChatAdapter(
    val appName: String,
    val aliases: Set<String>,
    val packageNames: Set<String>,
    val composerIdHints: List<String>,
    val sendIdHints: List<String>,
    val sendDescriptions: Set<String>
) {
    fun matchesPackage(pkg: String?): Boolean {
        val clean = pkg?.trim()?.lowercase().orEmpty()
        return clean in packageNames
    }

    fun matchesSendButton(
        viewId: String?,
        contentDescription: String?,
        text: String?,
        isEnabled: Boolean,
        isVisible: Boolean
    ): Boolean {
        if (!isEnabled || !isVisible) return false
        val vid = viewId?.trim()?.lowercase().orEmpty()
        if (sendIdHints.any { vid.contains(it) }) return true
        val desc = contentDescription?.trim()?.lowercase().orEmpty()
        val txt = text?.trim()?.lowercase().orEmpty()
        return desc in sendDescriptions || txt in sendDescriptions
    }
}

object AppChatAdapterRegistry {
    private val SEND_COMMON = setOf("send", "পাঠান", "भेजें", "भेजे", "send message")

    val SUPPORTED_ADAPTERS: List<SupportedAppChatAdapter> = listOf(
        SupportedAppChatAdapter(
            appName = "Telegram",
            aliases = setOf("telegram", "টেলিগ্রাম", "टेलीग्राम"),
            packageNames = setOf("org.telegram.messenger", "org.telegram.messenger.web"),
            composerIdHints = listOf("message", "chat_edit", "edit"),
            sendIdHints = listOf(":id/send", "send_button"),
            sendDescriptions = SEND_COMMON
        ),
        SupportedAppChatAdapter(
            appName = "Instagram",
            aliases = setOf("instagram", "insta", "ইনস্টাগ্রাম", "ইন্সটাগ্রাম", "इंस्टाग्राम"),
            packageNames = setOf("com.instagram.android"),
            composerIdHints = listOf("row_thread_composer_edittext", "message"),
            sendIdHints = listOf("row_thread_composer_button_send", ":id/send"),
            sendDescriptions = SEND_COMMON
        ),
        SupportedAppChatAdapter(
            appName = "Messenger",
            aliases = setOf("messenger", "মেসেঞ্জার", "मैसेंजर"),
            packageNames = setOf("com.facebook.orca"),
            composerIdHints = listOf("composer", "message", "text_input"),
            sendIdHints = listOf(":id/send", "send_button"),
            sendDescriptions = SEND_COMMON
        )
    )

    fun findAdapter(appQuery: String?): SupportedAppChatAdapter? {
        val clean = appQuery?.trim()?.lowercase().orEmpty()
        if (clean.isEmpty()) return null
        return SUPPORTED_ADAPTERS.firstOrNull { adapter ->
            adapter.appName.equals(clean, ignoreCase = true) ||
                clean in adapter.aliases ||
                clean in adapter.packageNames
        }
    }
}

/**
 * Thread-safe idempotency and duplicate-send guard ensuring the same actionId or the same
 * recipient+message cannot be double-sent by rapid voice/tool triggers.
 */
object WhatsAppSendDeduplicator {
    private val processedIds = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()
    private val recentContentSends = java.util.concurrent.ConcurrentHashMap<String, Long>()

    fun tryAcquire(pendingActionId: String): Boolean {
        val key = pendingActionId.trim()
        if (key.isEmpty()) return false
        return processedIds.add(key)
    }

    fun release(pendingActionId: String) {
        processedIds.remove(pendingActionId.trim())
    }

    private fun buildContentKey(channel: String, recipientKey: String, message: String): String {
        val cleanChannel = channel.trim().lowercase()
        val cleanRecipient = recipientKey.trim().lowercase().replace(Regex("\\s+"), "")
        val cleanMessage = message.trim().replace(Regex("\\s+"), " ").lowercase()
        return "$cleanChannel|$cleanRecipient|$cleanMessage"
    }

    /**
     * Prevents duplicate direct sends to the same recipient with the same message within [windowMs].
     */
    @Synchronized
    fun tryAcquireDirectSend(
        channel: String,
        recipientKey: String,
        message: String,
        nowMs: Long = System.currentTimeMillis(),
        windowMs: Long = 8000L
    ): Boolean {
        val key = buildContentKey(channel, recipientKey, message)
        val lastSent = recentContentSends[key]
        if (lastSent != null && (nowMs - lastSent) < windowMs) {
            return false
        }
        recentContentSends[key] = nowMs
        // Prune stale entries older than 60s
        if (recentContentSends.size > 64) {
            val cutoff = nowMs - 60_000L
            recentContentSends.entries.removeIf { it.value < cutoff }
        }
        return true
    }

    @Synchronized
    fun releaseDirectSend(channel: String, recipientKey: String, message: String) {
        recentContentSends.remove(buildContentKey(channel, recipientKey, message))
    }

    fun resetForTests() {
        processedIds.clear()
        recentContentSends.clear()
    }
}
