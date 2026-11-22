package com.zoni.jarvis.assistant.calling

import android.app.NotificationManager
import android.content.Context
import android.os.Build
import android.telecom.Call
import android.telecom.CallScreeningService
import androidx.annotation.RequiresApi
import androidx.core.app.NotificationCompat
import com.zoni.jarvis.assistant.R
import com.zoni.jarvis.assistant.ZoniApplication

/**
 * Android Telecom CallScreeningService for incoming SIM calls.
 * Detects incoming SIM calls legally via supported Android Telecom APIs and surfaces
 * a user-controlled call notification without intercepting or recording SIM voice audio.
 */
@RequiresApi(Build.VERSION_CODES.N)
class ZoniCallScreeningService : CallScreeningService() {

    override fun onScreenCall(callDetails: Call.Details) {
        val number = callDetails.handle?.schemeSpecificPart ?: "Unknown"
        val direction = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            callDetails.callDirection
        } else {
            Call.Details.DIRECTION_INCOMING
        }

        if (direction == Call.Details.DIRECTION_INCOMING) {
            CallStateHub.reportScreenedIncomingCall(number)
            postIncomingCallNotification(number)
        }

        // Never silently reject incoming calls during screening
        val response = CallResponse.Builder()
            .setDisallowCall(false)
            .setRejectCall(false)
            .setSilenceCall(false)
            .setSkipCallLog(false)
            .setSkipNotification(false)
            .build()

        respondToCall(callDetails, response)
    }

    private fun postIncomingCallNotification(number: String) {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
        val notif = NotificationCompat.Builder(this, ZoniApplication.CHANNEL_ASSISTANT_ALERTS)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentTitle("Zoni AI — Incoming SIM Call")
            .setContentText("Incoming call from $number")
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .build()
        nm.notify(number.hashCode(), notif)
    }
}
