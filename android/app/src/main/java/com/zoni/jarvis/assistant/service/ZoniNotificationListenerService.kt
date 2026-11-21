package com.zoni.jarvis.assistant.service

import android.app.Notification
import android.app.RemoteInput
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList

data class CapturedNotificationSummary(
    val key: String,
    val packageName: String,
    val appName: String,
    val title: String,
    val text: String,
    val isWhatsApp: Boolean,
    val canReply: Boolean,
    val timestampMillis: Long
)

/**
 * Genuine, privacy-hardened Android NotificationListenerService.
 * - Captures recent non-sensitive notifications locally in a bounded in-memory buffer ONLY
 *   after the user explicitly grants Notification Access in Android Settings.
 * - Strictly filters/redacts banking, payment, password, and OTP notifications so private
 *   authentication secrets are never captured, displayed, uploaded, or auto-replied to.
 * - Retains official Android Notification RemoteInput reply handles so explicitly approved
 *   WhatsApp/message replies or opt-in user rules execute strictly through official OS channels.
 */
class ZoniNotificationListenerService : NotificationListenerService() {

    private lateinit var autoReplyManager: AutoReplyRuleManager

    override fun onCreate() {
        super.onCreate()
        autoReplyManager = AutoReplyRuleManager(applicationContext)
    }

    override fun onNotificationPosted(sbn: StatusBarNotification?) {
        sbn ?: return
        if (sbn.packageName == packageName) return
        // Privacy guard: ignore protected banking/payment/authenticator packages
        if (AccessibilityGuard.isProtectedPackage(sbn.packageName)) return

        val notification = sbn.notification ?: return
        if ((notification.flags and Notification.FLAG_GROUP_SUMMARY) != 0) return

        val extras = notification.extras ?: return
        val rawTitle = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString()?.trim().orEmpty()
        val rawText = (extras.getCharSequence(Notification.EXTRA_BIG_TEXT)
            ?: extras.getCharSequence(Notification.EXTRA_TEXT))
            ?.toString()?.trim().orEmpty()
        if (rawTitle.isEmpty() && rawText.isEmpty()) return

        // Privacy guard: never store or auto-reply to OTPs, PINs, or password codes
        val containsSecret = AccessibilityGuard.containsOtpOrSecret(rawTitle) ||
            AccessibilityGuard.containsOtpOrSecret(rawText)
        if (containsSecret) return

        val title = AccessibilityGuard.redactSensitiveText(rawTitle)
        val text = AccessibilityGuard.redactSensitiveText(rawText)

        val isWhatsApp = sbn.packageName == "com.whatsapp" || sbn.packageName == "com.whatsapp.w4b"
        val appName = resolveAppLabel(sbn.packageName)
        val replyAction = findReplyAction(notification)
        val canReply = replyAction != null
        val key = sbn.key ?: "${sbn.packageName}:${sbn.id}:${sbn.postTime}"

        if (replyAction != null) {
            replyActionsByKey[key] = replyAction
            trimReplyActionCache()
        }

        val summary = CapturedNotificationSummary(
            key = key,
            packageName = sbn.packageName,
            appName = appName,
            title = title,
            text = text,
            isWhatsApp = isWhatsApp,
            canReply = canReply,
            timestampMillis = sbn.postTime
        )

        recentNotifications.removeAll { it.key == key }
        recentNotifications.add(0, summary)
        while (recentNotifications.size > MAX_STORED_NOTIFICATIONS) {
            recentNotifications.removeAt(recentNotifications.lastIndex)
        }

        // Optional Rule-Based Auto Reply: opt-in only (master switch defaults to FALSE),
        // strictly via official Android Notification RemoteInput reply action.
        if (canReply && ::autoReplyManager.isInitialized) {
            val matchedRule = autoReplyManager.findMatch(
                sender = title,
                messageText = text,
                isWhatsApp = isWhatsApp
            )
            if (matchedRule != null) {
                val senderCooldownKey = "${sbn.packageName}:${title.lowercase()}"
                val now = System.currentTimeMillis()
                val lastReplyAt = autoReplyCooldownBySender[senderCooldownKey] ?: 0L
                if (now - lastReplyAt >= AUTO_REPLY_COOLDOWN_MS) {
                    val sent = sendReply(applicationContext, key, matchedRule.replyText)
                    if (sent) {
                        autoReplyCooldownBySender[senderCooldownKey] = now
                    }
                }
            }
        }
    }

    override fun onNotificationRemoved(sbn: StatusBarNotification?) {
        val key = sbn?.key ?: return
        replyActionsByKey.remove(key)
    }

    private fun resolveAppLabel(pkg: String): String {
        return when (pkg) {
            "com.whatsapp" -> "WhatsApp"
            "com.whatsapp.w4b" -> "WhatsApp Business"
            "com.google.android.apps.messaging" -> "Messages"
            "com.google.android.gm" -> "Gmail"
            "org.telegram.messenger" -> "Telegram"
            else -> try {
                val appInfo = packageManager.getApplicationInfo(pkg, 0)
                packageManager.getApplicationLabel(appInfo).toString()
            } catch (_: Exception) {
                pkg
            }
        }
    }

    private fun findReplyAction(notification: Notification): Notification.Action? {
        val actions = notification.actions ?: return null
        for (action in actions) {
            val remoteInputs = action.remoteInputs
            if (remoteInputs != null && remoteInputs.isNotEmpty() && action.actionIntent != null) {
                return action
            }
        }
        return null
    }

    private fun trimReplyActionCache() {
        if (replyActionsByKey.size <= MAX_STORED_NOTIFICATIONS * 2) return
        val activeKeys = recentNotifications.map { it.key }.toSet()
        replyActionsByKey.keys.retainAll(activeKeys)
    }

    companion object {
        private const val MAX_STORED_NOTIFICATIONS = 25
        private const val AUTO_REPLY_COOLDOWN_MS = 30_000L

        val recentNotifications = CopyOnWriteArrayList<CapturedNotificationSummary>()
        private val replyActionsByKey = ConcurrentHashMap<String, Notification.Action>()
        private val autoReplyCooldownBySender = ConcurrentHashMap<String, Long>()

        fun clearRecentNotifications() {
            recentNotifications.clear()
            replyActionsByKey.clear()
        }

        /**
         * Finds an active, reply-capable WhatsApp notification key matching the sender name
         * so the user can optionally send an explicitly approved reply via RemoteInput.
         */
        fun findReplyableWhatsAppNotificationKey(senderQuery: String): String? {
            val clean = senderQuery.trim().lowercase()
            if (clean.isEmpty()) return null
            val match = recentNotifications.firstOrNull { item ->
                item.isWhatsApp &&
                    item.canReply &&
                    replyActionsByKey.containsKey(item.key) &&
                    item.title.lowercase().contains(clean)
            }
            return match?.key
        }

        fun getRecentNotificationsJson(limit: Int = 15): String {
            val arr = JSONArray()
            for (item in recentNotifications.take(limit.coerceIn(1, MAX_STORED_NOTIFICATIONS))) {
                arr.put(
                    JSONObject()
                        .put("key", item.key)
                        .put("packageName", item.packageName)
                        .put("appName", item.appName)
                        .put("title", item.title)
                        .put("text", item.text)
                        .put("isWhatsApp", item.isWhatsApp)
                        .put("canReply", item.canReply && replyActionsByKey.containsKey(item.key))
                        .put("timestampMillis", item.timestampMillis)
                )
            }
            return arr.toString()
        }

        /**
         * Sends a reply through the official Android Notification RemoteInput PendingIntent.
         * Returns false if the notification does not expose an active reply action.
         */
        fun sendReply(context: Context, notificationKey: String, replyText: String): Boolean {
            val cleanReply = replyText.trim()
            if (notificationKey.isBlank() || cleanReply.isEmpty()) return false
            val action = replyActionsByKey[notificationKey] ?: return false
            val remoteInputs = action.remoteInputs ?: return false
            if (remoteInputs.isEmpty()) return false

            return try {
                val fillInIntent = Intent()
                val bundle = Bundle()
                for (input in remoteInputs) {
                    bundle.putCharSequence(input.resultKey, cleanReply)
                }
                RemoteInput.addResultsToIntent(remoteInputs, fillInIntent, bundle)
                action.actionIntent.send(context, 0, fillInIntent)
                true
            } catch (_: Exception) {
                false
            }
        }
    }
}
