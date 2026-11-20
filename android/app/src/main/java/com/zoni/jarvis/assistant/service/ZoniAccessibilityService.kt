package com.zoni.jarvis.assistant.service

import android.accessibilityservice.AccessibilityService
import android.os.Bundle
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo

/**
 * Narrowly-scoped Android AccessibilityService for Zoni AI.
 *
 * Supported explicit user-requested actions:
 * - Global navigation: Home, Back, Recents, Notifications, Quick Settings
 * - Scrolling: Scroll Up / Scroll Down on scrollable containers
 * - Tap by visible text label
 * - Enter text into focused or labeled non-password editable fields
 * - On-demand visible UI text extraction for screen awareness (strictly excluding password fields)
 *
 * Privacy Guarantee: Passive event handler performs zero background scraping or logging.
 */
class ZoniAccessibilityService : AccessibilityService() {

    override fun onServiceConnected() {
        super.onServiceConnected()
        activeInstance = this
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        // Intentionally passive: no background scraping or logging.
    }

    override fun onInterrupt() {
        // No-op
    }

    override fun onDestroy() {
        if (activeInstance == this) {
            activeInstance = null
        }
        super.onDestroy()
    }

    fun clickNodeByText(targetText: String): Boolean {
        val clean = targetText.trim()
        if (clean.isEmpty()) return false
        val root = rootInActiveWindow ?: return false
        val matches = root.findAccessibilityNodeInfosByText(clean)
        for (node in matches) {
            if (node.isPassword) continue
            var current: AccessibilityNodeInfo? = node
            while (current != null) {
                if (current.isClickable) {
                    return current.performAction(AccessibilityNodeInfo.ACTION_CLICK)
                }
                current = current.parent
            }
        }
        return false
    }

    fun scrollScreen(direction: String): Boolean {
        val root = rootInActiveWindow ?: return false
        val action = when (direction.trim().lowercase()) {
            "up", "backward", "top" -> AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD
            else -> AccessibilityNodeInfo.ACTION_SCROLL_FORWARD
        }
        val scrollable = findFirstScrollable(root) ?: return false
        return scrollable.performAction(action)
    }

    fun enterTextIntoField(targetHintOrEmpty: String, textToEnter: String): Boolean {
        val root = rootInActiveWindow ?: return false
        val targetNode = if (targetHintOrEmpty.isNotBlank()) {
            findEditableByHintOrText(root, targetHintOrEmpty.trim())
        } else {
            root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT) ?: findFirstEditable(root)
        } ?: return false

        // Security invariant: never read or write into password fields automatically
        if (targetNode.isPassword) return false

        val args = Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, textToEnter)
        }
        return targetNode.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
    }

    /**
     * Extracts visible non-password text from the active screen on explicit user request
     * so Gemini can explain or summarize the current screen cleanly.
     */
    fun dumpVisibleScreenText(maxItems: Int = 80): String {
        val root = rootInActiveWindow ?: return ""
        val lines = LinkedHashSet<String>()
        val pkg = root.packageName?.toString().orEmpty()
        if (pkg.isNotEmpty()) {
            lines.add("Active App Package: $pkg")
        }
        collectVisibleText(root, lines, maxItems)
        return lines.joinToString("\n")
    }

    private fun collectVisibleText(
        node: AccessibilityNodeInfo?,
        output: LinkedHashSet<String>,
        maxItems: Int
    ) {
        if (node == null || output.size >= maxItems) return
        if (node.isPassword) return

        val text = node.text?.toString()?.trim().orEmpty()
        val desc = node.contentDescription?.toString()?.trim().orEmpty()

        if (text.isNotEmpty()) {
            output.add(if (node.isClickable) "[Button/Item] $text" else text)
        } else if (desc.isNotEmpty()) {
            output.add(if (node.isClickable) "[Button/Icon] $desc" else desc)
        }

        for (i in 0 until node.childCount) {
            if (output.size >= maxItems) break
            collectVisibleText(node.getChild(i), output, maxItems)
        }
    }

    private fun findFirstScrollable(node: AccessibilityNodeInfo?): AccessibilityNodeInfo? {
        if (node == null) return null
        if (node.isScrollable) return node
        for (i in 0 until node.childCount) {
            val found = findFirstScrollable(node.getChild(i))
            if (found != null) return found
        }
        return null
    }

    private fun findFirstEditable(node: AccessibilityNodeInfo?): AccessibilityNodeInfo? {
        if (node == null) return null
        if (node.isEditable && !node.isPassword) return node
        for (i in 0 until node.childCount) {
            val found = findFirstEditable(node.getChild(i))
            if (found != null) return found
        }
        return null
    }

    private fun findEditableByHintOrText(
        node: AccessibilityNodeInfo?,
        query: String
    ): AccessibilityNodeInfo? {
        if (node == null) return null
        if (node.isEditable && !node.isPassword) {
            val hint = node.hintText?.toString().orEmpty()
            val text = node.text?.toString().orEmpty()
            val desc = node.contentDescription?.toString().orEmpty()
            if (hint.contains(query, ignoreCase = true) ||
                text.contains(query, ignoreCase = true) ||
                desc.contains(query, ignoreCase = true)
            ) {
                return node
            }
        }
        for (i in 0 until node.childCount) {
            val found = findEditableByHintOrText(node.getChild(i), query)
            if (found != null) return found
        }
        return null
    }

    companion object {
        @Volatile
        private var activeInstance: ZoniAccessibilityService? = null

        fun isConnected(): Boolean = activeInstance != null

        fun getVisibleScreenText(maxItems: Int = 80): String {
            val service = activeInstance ?: return ""
            return try {
                service.dumpVisibleScreenText(maxItems)
            } catch (_: Exception) {
                ""
            }
        }

        fun performScroll(direction: String): Boolean {
            val service = activeInstance ?: return false
            return service.scrollScreen(direction)
        }

        fun enterText(targetHint: String, text: String): Boolean {
            val service = activeInstance ?: return false
            return service.enterTextIntoField(targetHint, text)
        }

        fun performExplicitAction(command: String): Boolean {
            val service = activeInstance ?: return false
            return when (val normalized = command.trim().lowercase()) {
                "home" -> service.performGlobalAction(GLOBAL_ACTION_HOME)
                "back" -> service.performGlobalAction(GLOBAL_ACTION_BACK)
                "recents" -> service.performGlobalAction(GLOBAL_ACTION_RECENTS)
                "notifications" -> service.performGlobalAction(GLOBAL_ACTION_NOTIFICATIONS)
                "quick_settings" -> service.performGlobalAction(GLOBAL_ACTION_QUICK_SETTINGS)
                "scroll_down", "scroll down" -> service.scrollScreen("down")
                "scroll_up", "scroll up" -> service.scrollScreen("up")
                else -> {
                    val target = if (normalized.startsWith("tap:")) {
                        command.substringAfter(":").trim()
                    } else {
                        command.trim()
                    }
                    service.clickNodeByText(target)
                }
            }
        }
    }
}
