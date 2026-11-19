package com.zoni.jarvis.assistant.service

import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import com.zoni.jarvis.assistant.R
import com.zoni.jarvis.assistant.ZoniApplication
import com.zoni.jarvis.assistant.ui.MainActivity

/**
 * Genuine Android Foreground Service (foregroundServiceType="microphone")
 * Keeps Zoni AI's Gemini Live voice link alive reliably in the background and with screen off.
 */
class ZoniForegroundService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }

        val statusText = intent?.getStringExtra(EXTRA_STATUS_TEXT)
            ?: "Zoni AI Live Voice Link সক্রিয় আছে — কথা বলার জন্য প্রস্তুত ❤️"

        val openAppIntent = Intent(this, MainActivity::class.java).apply {
            this.flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val openPending = PendingIntent.getActivity(
            this,
            10,
            openAppIntent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )

        val stopIntent = Intent(this, ZoniForegroundService::class.java).apply {
            action = ACTION_STOP
        }
        val stopPending = PendingIntent.getService(
            this,
            11,
            stopIntent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )

        val notification = NotificationCompat.Builder(this, ZoniApplication.CHANNEL_FOREGROUND_SERVICE)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentTitle("Zoni AI — Jarvis Core Active")
            .setContentText(statusText)
            .setOngoing(true)
            .setContentIntent(openPending)
            .addAction(0, "STOP", stopPending)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }

        return START_STICKY
    }

    companion object {
        const val NOTIFICATION_ID = 7001
        const val ACTION_START = "com.zoni.jarvis.assistant.ACTION_START_SERVICE"
        const val ACTION_STOP = "com.zoni.jarvis.assistant.ACTION_STOP_SERVICE"
        const val EXTRA_STATUS_TEXT = "extra_status_text"

        fun start(context: Context, statusText: String? = null) {
            val intent = Intent(context, ZoniForegroundService::class.java).apply {
                action = ACTION_START
                statusText?.let { putExtra(EXTRA_STATUS_TEXT, it) }
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stop(context: Context) {
            val intent = Intent(context, ZoniForegroundService::class.java).apply {
                action = ACTION_STOP
            }
            context.startService(intent)
        }
    }
}
