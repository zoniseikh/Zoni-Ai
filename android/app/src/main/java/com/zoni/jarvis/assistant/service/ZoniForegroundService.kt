package com.zoni.jarvis.assistant.service

import android.Manifest
import android.app.ForegroundServiceStartNotAllowedException
import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.zoni.jarvis.assistant.R
import com.zoni.jarvis.assistant.ZoniApplication
import com.zoni.jarvis.assistant.data.ZoniPreferences
import com.zoni.jarvis.assistant.ui.MainActivity
import com.zoni.jarvis.assistant.wakeword.VoiceLifecycleState
import com.zoni.jarvis.assistant.wakeword.WakeWordConfig
import com.zoni.jarvis.assistant.wakeword.WakeWordDetectionEvent
import com.zoni.jarvis.assistant.wakeword.WakeWordStatusSnapshot
import com.zoni.jarvis.assistant.wakeword.ZoniWakeWordEngine
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import org.json.JSONObject

/**
 * Single Unified Android Microphone Foreground Service (`foregroundServiceType="microphone"`).
 *
 * Serves BOTH:
 * 1. Transparent 24-hour user-opted-in Background Wake-Word Listening (`"Zoni"` / `"জোনি"`).
 * 2. Active Gemini Live voice conversation foreground availability.
 *
 * Strict privacy & Android 12–14 compliance:
 * - Never starts silently without explicit user opt-in and `RECORD_AUDIO` permission.
 * - Always displays a persistent, visible foreground notification with an immediate **STOP LISTENING** button.
 * - Releases the wake-word microphone before Gemini Live or phone calls use audio, preventing duplicate sessions or mic leaks.
 * - Handles `ForegroundServiceStartNotAllowedException` & `SecurityException` gracefully with honest error reporting.
 */
class ZoniForegroundService : Service() {

    private var wakeWordEngine: ZoniWakeWordEngine? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private lateinit var preferences: ZoniPreferences

    override fun onCreate() {
        super.onCreate()
        preferences = ZoniPreferences(applicationContext)
        wakeWordEngine = ZoniWakeWordEngine(applicationContext)
        isServiceRunning = true
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val action = intent?.action ?: ACTION_START
        Log.i(TAG, "onStartCommand action=$action")

        when (action) {
            ACTION_STOP -> {
                stopAllAndShutdown(disablePersistedPreference = intent?.getBooleanExtra(EXTRA_DISABLE_PREF, true) ?: true)
                return START_NOT_STICKY
            }

            ACTION_PAUSE_WAKE_WORD -> {
                val reasonState = VoiceLifecycleState.fromString(intent?.getStringExtra(EXTRA_VOICE_STATE))
                wakeWordEngine?.pauseForConversation()
                releaseWakeLock()
                updateSnapshot(
                    listening = false,
                    voiceState = if (reasonState == VoiceLifecycleState.IDLE) VoiceLifecycleState.ACTIVATING else reasonState,
                    lastError = ""
                )
                updateNotificationIfForeground("Zoni AI সক্রিয় — ভয়েস সেশন চলছে (STOP চাপুন বন্ধ করতে)")
                return START_STICKY
            }

            ACTION_RESUME_WAKE_WORD -> {
                val wakeEnabled = preferences.isWakeWordEnabledSync()
                val bgEnabled = preferences.isBackgroundListeningEnabledSync()
                if (!wakeEnabled && !bgEnabled) {
                    stopAllAndShutdown(disablePersistedPreference = false)
                    return START_NOT_STICKY
                }
                if (!hasMicPermission(this)) {
                    reportErrorAndStop("Microphone permission (RECORD_AUDIO) is missing.")
                    return START_NOT_STICKY
                }
                val phrase = preferences.getWakePhraseSync()
                if (promoteToMicrophoneForeground("Zoni AI Wake Word সক্রিয় — \"$phrase\" বলুন (মাইক্রোফোন শুনছে)")) {
                    startWakeWordDetectorInternal(phrase)
                }
                return START_STICKY
            }

            ACTION_UPDATE_VOICE_STATE -> {
                val newState = VoiceLifecycleState.fromString(intent?.getStringExtra(EXTRA_VOICE_STATE))
                val cur = _statusFlow.value
                _statusFlow.value = cur.copy(voiceState = newState)
                return START_STICKY
            }

            ACTION_START_WAKE_WORD -> {
                if (!hasMicPermission(this)) {
                    reportErrorAndStop("Microphone permission (RECORD_AUDIO) is required to start background wake-word listening.")
                    return START_NOT_STICKY
                }
                val phrase = intent?.getStringExtra(EXTRA_WAKE_PHRASE)?.trim()?.ifBlank { null }
                    ?: preferences.getWakePhraseSync()
                preferences.setWakeWordEnabledSync(true)
                preferences.setBackgroundListeningEnabledSync(true)
                preferences.setWakePhraseSync(phrase)

                val notifText = "Zoni AI Wake Word সক্রিয় — \"$phrase\" বলুন (মাইক্রোফোন চালু আছে)"
                if (!promoteToMicrophoneForeground(notifText)) {
                    return START_NOT_STICKY
                }
                startWakeWordDetectorInternal(phrase)
                return START_STICKY
            }

            else -> {
                // Standard ACTION_START for active Gemini Live voice session
                if (!hasMicPermission(this)) {
                    reportErrorAndStop("Microphone permission (RECORD_AUDIO) is required for live voice service.")
                    return START_NOT_STICKY
                }
                val statusText = intent?.getStringExtra(EXTRA_STATUS_TEXT)
                    ?: "Zoni AI Live Voice Link সক্রিয় আছে — কথা বলার জন্য প্রস্তুত"
                // Pause wake-word detector so Gemini Live owns the microphone cleanly
                wakeWordEngine?.pauseForConversation()
                if (!promoteToMicrophoneForeground(statusText)) {
                    return START_NOT_STICKY
                }
                updateSnapshot(
                    backgroundServiceRunning = true,
                    listening = false,
                    voiceState = VoiceLifecycleState.LISTENING,
                    lastError = ""
                )
                return START_STICKY
            }
        }
    }

    private fun startWakeWordDetectorInternal(phrase: String) {
        acquirePartialWakeLock()
        val cfg = WakeWordConfig(wakePhrase = phrase)
        val started = wakeWordEngine?.start(
            config = cfg,
            onDetected = { event -> handleWakeWordDetected(event) },
            onError = { err ->
                Log.w(TAG, "WakeWordEngine error: $err")
                updateSnapshot(
                    listening = false,
                    voiceState = VoiceLifecycleState.ERROR,
                    lastError = err
                )
            }
        ) ?: false

        if (started) {
            updateSnapshot(
                wakeWordEnabled = true,
                backgroundServiceRunning = true,
                listening = true,
                wakePhrase = phrase,
                voiceState = VoiceLifecycleState.WAKE_WORD_LISTENING,
                lastError = ""
            )
            updateNotificationIfForeground("Zoni AI Wake Word সক্রিয় — \"$phrase\" বলুন (অন-ডিভাইস শুনছে)")
        } else {
            releaseWakeLock()
            updateSnapshot(
                backgroundServiceRunning = true,
                listening = false,
                voiceState = VoiceLifecycleState.ERROR
            )
        }
    }

    private fun handleWakeWordDetected(event: WakeWordDetectionEvent) {
        Log.i(TAG, "ZONI wake word triggered: ${event.matchedVariant} (${event.confidence})")
        updateSnapshot(
            listening = false,
            voiceState = VoiceLifecycleState.WAKE_WORD_DETECTED,
            lastDetectedAtMs = event.detectedAtMs,
            lastConfidence = event.confidence,
            lastError = ""
        )
        _wakeWordEvents.tryEmit(event)

        updateSnapshot(
            listening = false,
            voiceState = VoiceLifecycleState.ACTIVATING
        )
        updateNotificationIfForeground("Zoni শনাক্ত হয়েছে! অ্যাসিস্ট্যান্ট চালু হচ্ছে...")

        // Bring MainActivity forward safely. On Android 10+ (API 29+), startActivity from background
        // may be silently blocked without throwing, so we also post a high-priority wake notification
        // whenever MainActivity is not already in foreground (MainActivity.onResume cancels it immediately
        // if startActivity succeeds).
        val appAlreadyVisible = MainActivity.isActivityInForeground
        if (!appAlreadyVisible && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            postWakeActivationFallbackNotification(event.remainingCommand)
        }
        try {
            val launchIntent = Intent(this, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or
                    Intent.FLAG_ACTIVITY_SINGLE_TOP or
                    Intent.FLAG_ACTIVITY_CLEAR_TOP
                putExtra(MainActivity.EXTRA_AUTO_VOICE, true)
                putExtra(MainActivity.EXTRA_WAKE_WORD_TRIGGERED, true)
                putExtra(MainActivity.EXTRA_WAKE_REMAINING_COMMAND, event.remainingCommand)
            }
            startActivity(launchIntent)
        } catch (e: Exception) {
            Log.w(TAG, "Background activity launch restricted by Android OS; posting wake notification: ${e.message}")
            postWakeActivationFallbackNotification(event.remainingCommand)
        }
    }

    private fun postWakeActivationFallbackNotification(remainingCommand: String) {
        if (!hasNotificationPermission(this)) return
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
        val openIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra(MainActivity.EXTRA_AUTO_VOICE, true)
            putExtra(MainActivity.EXTRA_WAKE_WORD_TRIGGERED, true)
            putExtra(MainActivity.EXTRA_WAKE_REMAINING_COMMAND, remainingCommand)
        }
        val pi = PendingIntent.getActivity(
            this,
            21,
            openIntent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val notif = NotificationCompat.Builder(this, ZoniApplication.CHANNEL_ASSISTANT_ALERTS)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentTitle("Zoni AI Activated")
            .setContentText("Tap to continue your voice session with Zoni AI.")
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setAutoCancel(true)
            .setContentIntent(pi)
            .build()
        try {
            nm.notify(WAKE_ALERT_NOTIFICATION_ID, notif)
        } catch (e: Exception) {
            Log.w(TAG, "Could not post wake activation fallback notification: ${e.message}")
        }
    }

    private fun promoteToMicrophoneForeground(statusText: String): Boolean {
        val notification = buildForegroundNotification(statusText)
        return try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(
                    NOTIFICATION_ID,
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
                )
            } else {
                startForeground(NOTIFICATION_ID, notification)
            }
            isInForeground = true
            true
        } catch (e: SecurityException) {
            Log.e(TAG, "Microphone foreground service blocked by SecurityException", e)
            reportErrorAndStop("Android blocked microphone foreground service (check RECORD_AUDIO permission & foreground state): ${e.message}")
            false
        } catch (e: Exception) {
            val restricted = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
                e is ForegroundServiceStartNotAllowedException
            val reason = if (restricted) {
                "Android ${Build.VERSION.RELEASE} restricts starting microphone foreground service while app is in background. Open Zoni AI and enable Background Listening from foreground."
            } else {
                "Could not start Zoni foreground microphone service: ${e.message}"
            }
            Log.e(TAG, reason, e)
            reportErrorAndStop(reason)
            false
        }
    }

    private fun updateNotificationIfForeground(statusText: String) {
        if (!isInForeground) return
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
        try {
            nm.notify(NOTIFICATION_ID, buildForegroundNotification(statusText))
        } catch (_: Exception) {
        }
    }

    private fun buildForegroundNotification(statusText: String): Notification {
        val openAppIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val openPending = PendingIntent.getActivity(
            this,
            10,
            openAppIntent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )

        val stopIntent = Intent(this, ZoniForegroundService::class.java).apply {
            action = ACTION_STOP
            putExtra(EXTRA_DISABLE_PREF, true)
        }
        val stopPending = PendingIntent.getService(
            this,
            11,
            stopIntent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )

        return NotificationCompat.Builder(this, ZoniApplication.CHANNEL_FOREGROUND_SERVICE)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentTitle("Zoni AI — Microphone Listening Active")
            .setContentText(statusText)
            .setOngoing(true)
            .setSilent(true)
            .setContentIntent(openPending)
            .addAction(0, "OPEN ZONI", openPending)
            .addAction(0, "STOP LISTENING", stopPending)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build()
    }

    private fun acquirePartialWakeLock() {
        try {
            if (wakeLock?.isHeld == true) return
            val pm = getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "zoni:WakeWordListeningLock").apply {
                setReferenceCounted(false)
                // Acquire with 30-minute safety window, renewed when detector re-arms
                acquire(30L * 60L * 1000L)
            }
        } catch (e: Exception) {
            Log.w(TAG, "WakeLock acquisition skipped: ${e.message}")
        }
    }

    private fun releaseWakeLock() {
        try {
            if (wakeLock?.isHeld == true) {
                wakeLock?.release()
            }
        } catch (_: Exception) {
        }
        wakeLock = null
    }

    private fun reportErrorAndStop(errorMessage: String) {
        wakeWordEngine?.stop()
        releaseWakeLock()
        isInForeground = false
        isServiceRunning = false
        updateSnapshot(
            backgroundServiceRunning = false,
            listening = false,
            voiceState = VoiceLifecycleState.ERROR,
            lastError = errorMessage
        )
        try {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } catch (_: Exception) {
        }
        stopSelf()
    }

    private fun stopAllAndShutdown(disablePersistedPreference: Boolean) {
        wakeWordEngine?.stop()
        releaseWakeLock()
        if (disablePersistedPreference && ::preferences.isInitialized) {
            preferences.setBackgroundListeningEnabledSync(false)
            preferences.setWakeWordEnabledSync(false)
        }
        isInForeground = false
        isServiceRunning = false
        updateSnapshot(
            wakeWordEnabled = if (disablePersistedPreference) false else _statusFlow.value.wakeWordEnabled,
            backgroundServiceRunning = false,
            listening = false,
            voiceState = if (disablePersistedPreference) VoiceLifecycleState.DISABLED else VoiceLifecycleState.IDLE,
            lastError = ""
        )
        try {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } catch (_: Exception) {
        }
        stopSelf()
    }

    private fun updateSnapshot(
        wakeWordEnabled: Boolean = _statusFlow.value.wakeWordEnabled,
        backgroundServiceRunning: Boolean = isServiceRunning,
        listening: Boolean = _statusFlow.value.listening,
        wakePhrase: String = _statusFlow.value.wakePhrase,
        voiceState: VoiceLifecycleState = _statusFlow.value.voiceState,
        lastDetectedAtMs: Long = _statusFlow.value.lastDetectedAtMs,
        lastConfidence: Float = _statusFlow.value.lastConfidence,
        lastError: String = _statusFlow.value.lastError
    ) {
        _statusFlow.value = WakeWordStatusSnapshot(
            wakeWordEnabled = wakeWordEnabled,
            backgroundServiceRunning = backgroundServiceRunning,
            listening = listening,
            wakePhrase = wakePhrase,
            voiceState = voiceState,
            micPermissionGranted = hasMicPermission(this),
            notificationPermissionGranted = hasNotificationPermission(this),
            detectorEngine = wakeWordEngine?.engineName ?: "on_device_two_stage_acoustic_gate",
            lastDetectedAtMs = lastDetectedAtMs,
            lastConfidence = lastConfidence,
            lastError = lastError
        )
    }

    override fun onDestroy() {
        wakeWordEngine?.stop()
        releaseWakeLock()
        isInForeground = false
        isServiceRunning = false
        val cur = _statusFlow.value
        _statusFlow.value = cur.copy(
            backgroundServiceRunning = false,
            listening = false,
            voiceState = if (cur.wakeWordEnabled) VoiceLifecycleState.IDLE else VoiceLifecycleState.DISABLED
        )
        super.onDestroy()
    }

    companion object {
        private const val TAG = "ZoniForegroundService"
        const val NOTIFICATION_ID = 7001
        const val WAKE_ALERT_NOTIFICATION_ID = 7002
        const val ACTION_START = "com.zoni.jarvis.assistant.ACTION_START_SERVICE"
        const val ACTION_START_WAKE_WORD = "com.zoni.jarvis.assistant.ACTION_START_WAKE_WORD"
        const val ACTION_PAUSE_WAKE_WORD = "com.zoni.jarvis.assistant.ACTION_PAUSE_WAKE_WORD"
        const val ACTION_RESUME_WAKE_WORD = "com.zoni.jarvis.assistant.ACTION_RESUME_WAKE_WORD"
        const val ACTION_UPDATE_VOICE_STATE = "com.zoni.jarvis.assistant.ACTION_UPDATE_VOICE_STATE"
        const val ACTION_STOP = "com.zoni.jarvis.assistant.ACTION_STOP_SERVICE"
        const val EXTRA_STATUS_TEXT = "extra_status_text"
        const val EXTRA_WAKE_PHRASE = "extra_wake_phrase"
        const val EXTRA_VOICE_STATE = "extra_voice_state"
        const val EXTRA_DISABLE_PREF = "extra_disable_pref"

        @Volatile
        var isServiceRunning: Boolean = false
            private set

        @Volatile
        private var isInForeground: Boolean = false

        private val _statusFlow = MutableStateFlow(WakeWordStatusSnapshot())
        val statusFlow: StateFlow<WakeWordStatusSnapshot> = _statusFlow.asStateFlow()

        private val _wakeWordEvents = MutableSharedFlow<WakeWordDetectionEvent>(extraBufferCapacity = 8)
        val wakeWordEvents: SharedFlow<WakeWordDetectionEvent> = _wakeWordEvents.asSharedFlow()

        fun hasMicPermission(context: Context): Boolean =
            ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
                PackageManager.PERMISSION_GRANTED

        fun hasNotificationPermission(context: Context): Boolean =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) ==
                    PackageManager.PERMISSION_GRANTED
            } else {
                true
            }

        fun cancelWakeActivationNotification(context: Context) {
            try {
                val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
                nm?.cancel(WAKE_ALERT_NOTIFICATION_ID)
            } catch (_: Exception) {
            }
        }

        fun getCurrentStatusSnapshot(context: Context): WakeWordStatusSnapshot {
            val prefs = ZoniPreferences(context.applicationContext)
            val cur = _statusFlow.value
            val enabled = prefs.isWakeWordEnabledSync() || cur.wakeWordEnabled
            val phrase = prefs.getWakePhraseSync()
            return cur.copy(
                wakeWordEnabled = enabled,
                backgroundServiceRunning = isServiceRunning,
                wakePhrase = phrase,
                micPermissionGranted = hasMicPermission(context),
                notificationPermissionGranted = hasNotificationPermission(context),
                voiceState = if (!enabled && !isServiceRunning && cur.voiceState == VoiceLifecycleState.WAKE_WORD_LISTENING) {
                    VoiceLifecycleState.DISABLED
                } else {
                    cur.voiceState
                }
            )
        }

        fun start(context: Context, statusText: String? = null): Boolean {
            if (!hasMicPermission(context)) {
                _statusFlow.value = getCurrentStatusSnapshot(context).copy(
                    voiceState = VoiceLifecycleState.ERROR,
                    lastError = "Microphone permission (RECORD_AUDIO) is required."
                )
                return false
            }
            val intent = Intent(context, ZoniForegroundService::class.java).apply {
                action = ACTION_START
                statusText?.let { putExtra(EXTRA_STATUS_TEXT, it) }
            }
            return dispatchForegroundServiceIntent(context, intent)
        }

        fun startWakeWordListening(context: Context, wakePhrase: String? = null): String {
            if (!hasMicPermission(context)) {
                val err = "Microphone permission (RECORD_AUDIO) is required before enabling Zoni wake-word listening."
                _statusFlow.value = getCurrentStatusSnapshot(context).copy(
                    wakeWordEnabled = false,
                    backgroundServiceRunning = false,
                    listening = false,
                    voiceState = VoiceLifecycleState.ERROR,
                    lastError = err
                )
                return JSONObject()
                    .put("success", false)
                    .put("status", "permission_missing")
                    .put("message", err)
                    .put("snapshot", JSONObject(_statusFlow.value.toJson()))
                    .toString()
            }

            val prefs = ZoniPreferences(context.applicationContext)
            val phrase = wakePhrase?.trim()?.ifBlank { null } ?: prefs.getWakePhraseSync()
            prefs.setWakeWordEnabledSync(true)
            prefs.setBackgroundListeningEnabledSync(true)
            prefs.setWakePhraseSync(phrase)

            val intent = Intent(context, ZoniForegroundService::class.java).apply {
                action = ACTION_START_WAKE_WORD
                putExtra(EXTRA_WAKE_PHRASE, phrase)
            }
            val ok = dispatchForegroundServiceIntent(context, intent)
            val snap = getCurrentStatusSnapshot(context)
            return JSONObject()
                .put("success", ok)
                .put("status", if (ok) "wake_word_starting" else "foreground_start_blocked")
                .put(
                    "message",
                    if (ok) "Zoni AI background wake-word listening started for \"$phrase\"."
                    else snap.lastError.ifBlank { "Android prevented starting microphone foreground service." }
                )
                .put("snapshot", JSONObject(snap.toJson()))
                .toString()
        }

        fun pauseWakeWordForConversation(context: Context, state: VoiceLifecycleState = VoiceLifecycleState.ACTIVATING) {
            if (!isServiceRunning) return
            val intent = Intent(context, ZoniForegroundService::class.java).apply {
                action = ACTION_PAUSE_WAKE_WORD
                putExtra(EXTRA_VOICE_STATE, state.name)
            }
            try {
                context.startService(intent)
            } catch (_: Exception) {
            }
        }

        fun resumeWakeWordAfterConversation(context: Context) {
            val prefs = ZoniPreferences(context.applicationContext)
            if (!prefs.isWakeWordEnabledSync() && !prefs.isBackgroundListeningEnabledSync()) return
            if (!hasMicPermission(context)) return
            val intent = Intent(context, ZoniForegroundService::class.java).apply {
                action = ACTION_RESUME_WAKE_WORD
            }
            dispatchForegroundServiceIntent(context, intent)
        }

        fun updateVoiceState(context: Context, state: VoiceLifecycleState) {
            val cur = getCurrentStatusSnapshot(context)
            _statusFlow.value = cur.copy(voiceState = state)
            if (isServiceRunning) {
                val intent = Intent(context, ZoniForegroundService::class.java).apply {
                    action = ACTION_UPDATE_VOICE_STATE
                    putExtra(EXTRA_VOICE_STATE, state.name)
                }
                try {
                    context.startService(intent)
                } catch (_: Exception) {
                }
            }
        }

        fun stop(context: Context, disablePreference: Boolean = false): String {
            if (disablePreference) {
                val prefs = ZoniPreferences(context.applicationContext)
                prefs.setWakeWordEnabledSync(false)
                prefs.setBackgroundListeningEnabledSync(false)
            }
            if (isServiceRunning) {
                val intent = Intent(context, ZoniForegroundService::class.java).apply {
                    action = ACTION_STOP
                    putExtra(EXTRA_DISABLE_PREF, disablePreference)
                }
                try {
                    context.startService(intent)
                } catch (_: Exception) {
                    context.stopService(Intent(context, ZoniForegroundService::class.java))
                }
            }
            val snap = getCurrentStatusSnapshot(context).copy(
                wakeWordEnabled = if (disablePreference) false else _statusFlow.value.wakeWordEnabled,
                backgroundServiceRunning = false,
                listening = false,
                voiceState = if (disablePreference) VoiceLifecycleState.DISABLED else VoiceLifecycleState.IDLE,
                lastError = ""
            )
            _statusFlow.value = snap
            return JSONObject()
                .put("success", true)
                .put("status", "stopped")
                .put("message", "Zoni AI microphone listening service stopped.")
                .put("snapshot", JSONObject(snap.toJson()))
                .toString()
        }

        private fun dispatchForegroundServiceIntent(context: Context, intent: Intent): Boolean {
            return try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    context.startForegroundService(intent)
                } else {
                    context.startService(intent)
                }
                true
            } catch (e: Exception) {
                val msg = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
                    e is ForegroundServiceStartNotAllowedException
                ) {
                    "Android ${Build.VERSION.RELEASE} restricts starting microphone foreground service from background. Open Zoni AI to re-arm listening."
                } else {
                    "Could not start Zoni foreground service: ${e.message}"
                }
                Log.e(TAG, msg, e)
                _statusFlow.value = getCurrentStatusSnapshot(context).copy(
                    backgroundServiceRunning = false,
                    listening = false,
                    voiceState = VoiceLifecycleState.ERROR,
                    lastError = msg
                )
                false
            }
        }
    }
}
