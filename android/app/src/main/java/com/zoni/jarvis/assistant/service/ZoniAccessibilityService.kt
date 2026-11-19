package com.zoni.jarvis.assistant.service

import android.accessibilityservice.AccessibilityService
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo

/**
 * Narrowly-scoped Android AccessibilityService for Zoni AI.
 * Only performs explicit user-requested actions (Home, Back, Recents, Notifications, Quick Settings,
 * or tapping an explicitly named control). Never collects or transmits screen data in the background.
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
        val root = rootInActiveWindow ?: return false
        val matches = root.findAccessibilityNodeInfosByText(targetText)
        for (node in matches) {
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

    companion object {
        @Volatile
        private var activeInstance: ZoniAccessibilityService? = null

        fun isConnected(): Boolean = activeInstance != null

        fun performExplicitAction(command: String): Boolean {
            val service = activeInstance ?: return false
            return when (command.lowercase()) {
                "home" -> service.performGlobalAction(GLOBAL_ACTION_HOME)
                "back" -> service.performGlobalAction(GLOBAL_ACTION_BACK)
                "recents" -> service.performGlobalAction(GLOBAL_ACTION_RECENTS)
                "notifications" -> service.performGlobalAction(GLOBAL_ACTION_NOTIFICATIONS)
                "quick_settings" -> service.performGlobalAction(GLOBAL_ACTION_QUICK_SETTINGS)
                else -> service.clickNodeByText(command)
            }
        }
    }
}
