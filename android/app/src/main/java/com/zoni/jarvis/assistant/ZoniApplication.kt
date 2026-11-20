package com.zoni.jarvis.assistant

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.os.Build
import com.zoni.jarvis.assistant.data.ZoniPreferences
import com.zoni.jarvis.assistant.hardware.AndroidHardwareController

class ZoniApplication : Application() {

    lateinit var preferences: ZoniPreferences
        private set

    lateinit var hardwareController: AndroidHardwareController
        private set

    override fun onCreate() {
        super.onCreate()
        instance = this
        preferences = ZoniPreferences(this)
        hardwareController = AndroidHardwareController(this)
        createNotificationChannels()
    }

    private fun createNotificationChannels() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val manager = getSystemService(NotificationManager::class.java) ?: return

            val serviceChannel = NotificationChannel(
                CHANNEL_FOREGROUND_SERVICE,
                getString(R.string.foreground_service_channel_name),
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = getString(R.string.foreground_service_channel_desc)
                setShowBadge(false)
            }

            val alertsChannel = NotificationChannel(
                CHANNEL_ASSISTANT_ALERTS,
                "Zoni AI Alerts & Reminders",
                NotificationManager.IMPORTANCE_DEFAULT
            ).apply {
                description = "Assistant check-ins, timers, and system action notifications."
            }

            manager.createNotificationChannel(serviceChannel)
            manager.createNotificationChannel(alertsChannel)
        }
    }

    companion object {
        const val CHANNEL_FOREGROUND_SERVICE = "zoni_foreground_service_channel"
        const val CHANNEL_ASSISTANT_ALERTS = "zoni_alerts_channel"
        const val CHANNEL_ALERTS = CHANNEL_ASSISTANT_ALERTS

        @Volatile
        lateinit var instance: ZoniApplication
            private set
    }
}
