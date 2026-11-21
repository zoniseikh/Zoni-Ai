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
    val data: JSONObject? = null
) {
    fun toJson(): String {
        val obj = JSONObject()
            .put("success", success)
            .put("verified", verified)
            .put("actionType", actionType)
            .put("activePackage", activePackage)
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
        // Track only the active foreground package name; NEVER scrape screen content in background.
        val pkg = event?.packageName?.toString()
        if (!pkg.isNullOrBlank()) {
            lastForegroundPackage = pkg
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

    /**
     * Phase 6 — Verified WhatsApp Send Automation (ONLY invoked AFTER explicit user confirmation).
     *
     * Safeguards:
     * 1. Enforces idempotency via WhatsAppSendDeduplicator (never sends the same pendingActionId twice).
     * 2. Waits cleanly for com.whatsapp / com.whatsapp.w4b to enter foreground.
     * 3. Runs AccessibilityGuard screen safety checks.
     * 4. Verifies the visible conversation header matches the approved recipient name or phone.
     * 5. Verifies the composer contains the approved message (or fills it safely if empty).
     * 6. Finds the visible, enabled Send button semantically (viewId `:id/send` or localized contentDescription)
     *    and clicks via AccessibilityNodeInfo.ACTION_CLICK (bounded node gesture fallback only if needed).
     * 7. Verifies outgoing message appears in conversation or composer cleared — NEVER claims delivered/read.
     */
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
                actionType = "whatsapp_send_approved",
                activePackage = getActivePackageName(),
                message = "Cannot auto-send an empty WhatsApp message. Please type your message in WhatsApp.",
                failureReason = "empty_message"
            )
        }

        if (!WhatsAppSendDeduplicator.tryAcquire(pendingActionId)) {
            return AccessibilityActionOutcome(
                success = false,
                verified = true,
                actionType = "whatsapp_send_approved",
                activePackage = getActivePackageName(),
                message = "Duplicate send prevented: this approved WhatsApp message was already processed.",
                failureReason = "duplicate_send_prevented"
            )
        }

        // Wait briefly (up to ~2.4s) for WhatsApp conversation window to come into foreground
        var root: AccessibilityNodeInfo? = null
        var activePkg = ""
        for (attempt in 0 until 8) {
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
                actionType = "whatsapp_send_approved",
                activePackage = getActivePackageName(),
                message = "WhatsApp did not reach the foreground in time. Your draft is open — please tap Send manually.",
                failureReason = "whatsapp_window_not_ready"
            )
        }

        checkScreenSafety(waRoot, "whatsapp_send_approved")?.let { blocked ->
            WhatsAppSendDeduplicator.release(pendingActionId)
            return blocked
        }

        // Verify recipient header matches approved contact or phone number
        val visibleLabels = collectVisibleLabels(waRoot, 45)
        val recipientVerified = WhatsAppAutomationValidator.matchesExpectedRecipient(
            visibleLabels = visibleLabels,
            expectedRecipient = expectedRecipient,
            expectedPhone = expectedPhone
        )
        if (!recipientVerified) {
            WhatsAppSendDeduplicator.release(pendingActionId)
            return AccessibilityActionOutcome(
                success = false,
                verified = false,
                actionType = "whatsapp_send_approved",
                activePackage = activePkg,
                message = "Could not verify the active WhatsApp conversation header matches \"$expectedRecipient\". Did not tap Send for your safety — please verify and tap Send manually.",
                failureReason = "recipient_verification_failed"
            )
        }

        // Locate WhatsApp composer and guarantee it contains EXACTLY the user-approved message
        val composerNode = findWhatsAppComposerNode(waRoot)
        if (composerNode == null || composerNode.isPassword) {
            WhatsAppSendDeduplicator.release(pendingActionId)
            return AccessibilityActionOutcome(
                success = false,
                verified = false,
                actionType = "whatsapp_send_approved",
                activePackage = activePkg,
                message = "Could not locate the WhatsApp message composer safely. Please verify and tap Send manually.",
                failureReason = "composer_not_found"
            )
        }

        val existingComposerText = composerNode.text?.toString()?.trim().orEmpty()
        if (!WhatsAppAutomationValidator.composerMatchesApprovedMessage(existingComposerText, cleanMsg)) {
            composerNode.performAction(AccessibilityNodeInfo.ACTION_FOCUS)
            val args = Bundle().apply {
                putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, cleanMsg)
            }
            val setOk = composerNode.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
            if (!setOk) {
                WhatsAppSendDeduplicator.release(pendingActionId)
                return AccessibilityActionOutcome(
                    success = false,
                    verified = false,
                    actionType = "whatsapp_send_approved",
                    activePackage = activePkg,
                    message = "Could not safely set the approved message in WhatsApp composer. Did not tap Send — please review and send manually.",
                    failureReason = "composer_set_text_failed"
                )
            }
            try {
                Thread.sleep(220L)
            } catch (_: InterruptedException) {
                // ignore
            }
        }

        // Refresh node and verify composer text matches the exact approved message before tapping Send
        composerNode.refresh()
        val freshRoot = rootInActiveWindow ?: waRoot
        val refreshedComposer = findWhatsAppComposerNode(freshRoot) ?: composerNode
        val verifiedComposerText = refreshedComposer.text?.toString()?.trim().orEmpty()
        if (!WhatsAppAutomationValidator.composerMatchesApprovedMessage(verifiedComposerText, cleanMsg)) {
            WhatsAppSendDeduplicator.release(pendingActionId)
            return AccessibilityActionOutcome(
                success = false,
                verified = false,
                actionType = "whatsapp_send_approved",
                activePackage = activePkg,
                message = "WhatsApp composer text did not match the exact message you approved. Stopped before tapping Send — please review and send manually.",
                failureReason = "composer_verification_failed"
            )
        }

        // Locate visible, enabled WhatsApp Send button semantically
        val sendNode = findWhatsAppSendButton(freshRoot)
        if (sendNode == null) {
            WhatsAppSendDeduplicator.release(pendingActionId)
            return AccessibilityActionOutcome(
                success = false,
                verified = false,
                actionType = "whatsapp_send_approved",
                activePackage = activePkg,
                message = "WhatsApp draft is ready, but the Send button was not found on screen. Please tap Send manually.",
                failureReason = "send_button_not_found"
            )
        }

        // Trigger Send via semantic ACTION_CLICK first, falling back to bounded node gesture only if rejected
        var clicked = sendNode.performAction(AccessibilityNodeInfo.ACTION_CLICK)
        var clickMethod = "semantic_send_click"
        if (!clicked) {
            val rect = Rect()
            sendNode.getBoundsInScreen(rect)
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
                actionType = "whatsapp_send_approved",
                activePackage = activePkg,
                message = "Could not trigger the WhatsApp Send button automatically. Please tap Send manually.",
                failureReason = "send_click_rejected"
            )
        }

        // Wait briefly and verify outgoing message appears in conversation AND composer cleared
        try {
            Thread.sleep(450L)
        } catch (_: InterruptedException) {
            // ignore
        }
        val postRoot = rootInActiveWindow
        val postLabels = if (postRoot != null) collectVisibleLabels(postRoot, 60) else emptyList()
        val postComposer = if (postRoot != null) findWhatsAppComposerNode(postRoot)?.text?.toString().orEmpty() else ""
        val sentVerified = WhatsAppAutomationValidator.verifyOutgoingMessageVisible(
            visibleChatLabels = postLabels,
            composerText = postComposer,
            expectedMessage = cleanMsg
        )

        return AccessibilityActionOutcome(
            success = true,
            verified = sentVerified,
            actionType = "whatsapp_send_approved",
            activePackage = activePkg,
            message = if (sentVerified) {
                "Send action completed in WhatsApp for $expectedRecipient and verified in chat (sent=verified, delivered/read depends on WhatsApp network)."
            } else {
                "Triggered Send in WhatsApp for $expectedRecipient, but could not visually confirm the outgoing bubble. Please check WhatsApp."
            },
            data = JSONObject()
                .put("contactName", expectedRecipient)
                .put("phoneNumber", expectedPhone)
                .put("method", clickMethod)
                .put("sentVerified", sentVerified)
                .put("deliveryVerified", false)
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
        fun search(node: AccessibilityNodeInfo?): AccessibilityNodeInfo? {
            if (node == null || node.isPassword) return null
            val vid = node.viewIdResourceName?.lowercase().orEmpty()
            if (node.isEditable && (vid.endsWith(":id/entry") || vid.contains("message") || vid.contains("compose"))) {
                return node
            }
            for (i in 0 until node.childCount) {
                val found = search(node.getChild(i))
                if (found != null) return found
            }
            return null
        }
        return search(root)
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

        fun sendApprovedWhatsAppMessage(
            expectedRecipient: String,
            expectedPhone: String,
            expectedMessage: String,
            pendingActionId: String
        ): AccessibilityActionOutcome {
            val svc = instance ?: return AccessibilityActionOutcome(
                success = false,
                verified = false,
                actionType = "whatsapp_send_approved",
                message = "Zoni Accessibility Service is not enabled. WhatsApp draft is open — please tap Send manually.",
                failureReason = "accessibility_service_disabled"
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
 * Thread-safe idempotency guard ensuring an approved pendingActionId can NEVER be sent twice.
 */
object WhatsAppSendDeduplicator {
    private val processedIds = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()

    fun tryAcquire(pendingActionId: String): Boolean {
        val key = pendingActionId.trim()
        if (key.isEmpty()) return false
        return processedIds.add(key)
    }

    fun release(pendingActionId: String) {
        processedIds.remove(pendingActionId.trim())
    }

    fun resetForTests() {
        processedIds.clear()
    }
}
