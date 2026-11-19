package com.zoni.jarvis.assistant.service

import android.app.Notification
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import java.util.concurrent.CopyOnWriteArrayList

data class CapturedNotificationSummary(
    val packageName: String,
    val title: String,
    val text: String,
    val timestampMillis: Long
)

/**
 * Genuine Android NotificationListenerService.
 * Keeps a small in-memory buffer of recent notifications locally on-device so Zoni AI
 * can read incoming WhatsApp/SMS messages aloud only when the user explicitly asks.
 */
class ZoniNotificationListenerService : NotificationListenerService() {

    override fun onNotificationPosted(sbn: StatusBarNotification?) {
        sbn ?: return
        if (sbn.packageName == packageName) return
        val extras = sbn.notification?.extras ?: return
        val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString()?.trim().orEmpty()
        val text = extras.getCharSequence(Notification.EXTRA_TEXT)?.toString()?.trim().orEmpty()
        if (title.isEmpty() && text.isEmpty()) return

        recentNotifications.add(
            0,
            CapturedNotificationSummary(
                packageName = sbn.packageName,
                title = title,
                text = text,
                timestampMillis = sbn.postTime
            )
        )
        while (recentNotifications.size > 15) {
            recentNotifications.removeAt(recentNotifications.lastIndex)
        }
    }

    companion object {
        val recentNotifications = CopyOnWriteArrayList<CapturedNotificationSummary>()
    }
}
