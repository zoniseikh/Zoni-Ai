package com.zoni.jarvis.assistant.service

import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import com.zoni.jarvis.assistant.R
import com.zoni.jarvis.assistant.ZoniApplication
import com.zoni.jarvis.assistant.data.ZoniPreferences
import com.zoni.jarvis.assistant.ui.MainActivity

/**
 * Compliant Boot & App-Update Recovery Receiver for Zoni AI Background Wake Word.
 *
 * Android 14+ (targetSdk 34) strictly prohibits launching `FOREGROUND_SERVICE_TYPE_MICROPHONE`
 * directly from `ACTION_BOOT_COMPLETED` while the app is in the background.
 * Rather than crashing with `ForegroundServiceStartNotAllowedException` or attempting deceptive
 * workarounds, this receiver checks whether the user explicitly opted into Background Wake Word
 * and posts a clear notification allowing 1-tap foreground re-arming (or resumes safely on older
 * Android versions where permitted).
 */
class ZoniBootReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent?) {
        val action = intent?.action ?: return
        if (action != Intent.ACTION_BOOT_COMPLETED && action != Intent.ACTION_MY_PACKAGE_REPLACED) {
            return
        }

        val prefs = ZoniPreferences(context.applicationContext)
        if (!prefs.isBackgroundListeningEnabledSync() || !prefs.isWakeWordEnabledSync()) {
            return
        }

        val phrase = prefs.getWakePhraseSync()

        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R &&
            ZoniForegroundService.hasMicPermission(context)
        ) {
            Log.i(TAG, "Resuming Zoni wake-word service after $action on Android < 11")
            ZoniForegroundService.startWakeWordListening(context, phrase)
            return
        }

        // Android 11–14+: Post a transparent, user-controlled resume notification
        postResumeListeningNotification(context, phrase)
    }

    private fun postResumeListeningNotification(context: Context, wakePhrase: String) {
        if (!ZoniForegroundService.hasNotificationPermission(context)) return
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return

        val resumeIntent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra(MainActivity.EXTRA_RESUME_WAKE_WORD, true)
        }
        val pi = PendingIntent.getActivity(
            context,
            31,
            resumeIntent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )

        val notif = NotificationCompat.Builder(context, ZoniApplication.CHANNEL_ASSISTANT_ALERTS)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentTitle("Zoni AI Wake Word Ready to Resume")
            .setContentText("Device restarted. Tap to resume listening for \"$wakePhrase\" (Android privacy policy requires foreground start).")
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setAutoCancel(true)
            .setContentIntent(pi)
            .build()

        try {
            nm.notify(RESUME_NOTIFICATION_ID, notif)
        } catch (e: Exception) {
            Log.w(TAG, "Could not post boot resume notification: ${e.message}")
        }
    }

    companion object {
        private const val TAG = "ZoniBootReceiver"
        private const val RESUME_NOTIFICATION_ID = 7009
    }
}
