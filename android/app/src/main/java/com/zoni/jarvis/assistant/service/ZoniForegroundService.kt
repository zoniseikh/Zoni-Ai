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
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.zoni.jarvis.assistant.R
import com.zoni.jarvis.assistant.ZoniApplication
import com.zoni.jarvis.assistant.audio.LiveAudioEngine
import com.zoni.jarvis.assistant.data.ZoniPreferences
import com.zoni.jarvis.assistant.domain.ActionType
import com.zoni.jarvis.assistant.domain.BengaliDateTimeEngine
import com.zoni.jarvis.assistant.domain.CommandDispatcher
import com.zoni.jarvis.assistant.domain.LocalCommandRouter
import com.zoni.jarvis.assistant.domain.LocalRouteDecisionKind
import com.zoni.jarvis.assistant.domain.MobileAssistantEngine
import com.zoni.jarvis.assistant.domain.SupportedLanguage
import com.zoni.jarvis.assistant.domain.VoiceCommand
import com.zoni.jarvis.assistant.domain.WsConnectionStatus
import com.zoni.jarvis.assistant.hardware.AndroidHardwareController
import com.zoni.jarvis.assistant.network.LiveServerEvent
import com.zoni.jarvis.assistant.network.NetworkQualityMonitor
import com.zoni.jarvis.assistant.network.NetworkQualityState
import com.zoni.jarvis.assistant.network.ZoniLiveSessionClient
import com.zoni.jarvis.assistant.ui.MainActivity
import com.zoni.jarvis.assistant.wakeword.VoiceLifecycleState
import com.zoni.jarvis.assistant.wakeword.WakeWordConfig
import com.zoni.jarvis.assistant.wakeword.WakeWordDetectionEvent
import com.zoni.jarvis.assistant.wakeword.WakeWordLifecycleGuard
import com.zoni.jarvis.assistant.wakeword.WakeWordStatusSnapshot
import com.zoni.jarvis.assistant.wakeword.ZoniWakeWordEngine
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap

/**
 * Single Unified Android Microphone Foreground Service (`foregroundServiceType="microphone"`).
 *
 * Implements Zoni AI's complete Android 14–16 compliant Background Voice Assistant lifecycle:
 * 1. On-device Wake-Word Listening ("Zoni" / "জোনি") while Screen is On, Off, or Locked.
 * 2. Voice-only Bengali wake response ("হ্যাঁ, বলো শুনছি।") — ZERO wake notifications,
 *    ZERO screen popups, ZERO automatic opening of MainActivity / Dashboard / WebView.
 * 3. Background Continuous Command Mode powered by native `LiveAudioEngine` + `ZoniLiveSessionClient`
 *    (Gemini Live) + existing `CommandDispatcher` / `LocalCommandRouter` / `DeviceActionExecutor`.
 * 4. Keeps listening across consecutive commands until the user says "ধন্যবাদ জোনি" or
 *    "Stop Listening" (or taps STOP LISTENING in the mandatory foreground service notification).
 * 5. Cleanly yields microphone ownership whenever the user opens the foreground UI and manually
 *    starts a foreground voice session, then resumes wake-word listening afterward.
 */
class ZoniForegroundService : Service() {

    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val serviceHandler = Handler(Looper.getMainLooper())

    private lateinit var preferences: ZoniPreferences
    private lateinit var hardwareController: AndroidHardwareController
    private var wakeWordEngine: ZoniWakeWordEngine? = null
    private var voiceSpeaker: BackgroundVoiceSpeaker? = null
    private var liveAudioEngine: LiveAudioEngine? = null
    private var liveClient: ZoniLiveSessionClient? = null
    private var networkMonitor: NetworkQualityMonitor? = null

    private val commandDispatcher = CommandDispatcher()
    private val localCommandRouter = LocalCommandRouter(commandDispatcher = commandDispatcher)

    private var wakeLock: PowerManager.WakeLock? = null
    private var wakeLockRenewRunnable: Runnable? = null
    private var connectTimeoutRunnable: Runnable? = null
    private var pendingCommandDebounceJob: Job? = null

    private val turnUserTranscripts = ConcurrentHashMap<Int, String>()
    private val turnAssistantTranscripts = ConcurrentHashMap<Int, String>()

    @Volatile
    private var backgroundMode: BackgroundAssistantMode = BackgroundAssistantMode.STOPPED

    @Volatile
    private var lastAcceptedWakeAtMs: Long = 0L

    @Volatile
    private var pendingBackgroundMicStart: Boolean = false

    @Volatile
    private var pendingInitialWakeCommand: String = ""

    @Volatile
    private var suppressedGeminiAudioTurnId: Int = -1

    @Volatile
    private var lastHandledStopAtMs: Long = 0L

    override fun onCreate() {
        super.onCreate()
        val zoniApp = application as? ZoniApplication
        preferences = zoniApp?.preferences ?: ZoniPreferences(applicationContext)
        hardwareController = zoniApp?.hardwareController ?: AndroidHardwareController(applicationContext)

        wakeWordEngine = ZoniWakeWordEngine(
            context = applicationContext,
            speakerProfileProvider = {
                preferences.getSpeakerVoiceprintSync() to preferences.getSpeakerVerificationConfigSync()
            }
        )

        voiceSpeaker = BackgroundVoiceSpeaker(applicationContext).also { it.warmUp() }

        liveAudioEngine = LiveAudioEngine(
            context = applicationContext,
            preferSpeakerAssistantUsage = true,
            onAudioFocusLost = {
                Log.i(TAG, "Audio focus lost during background command mode; yielding mic cleanly.")
                serviceHandler.post {
                    if (isInBackgroundCommandLifecycle()) {
                        exitBackgroundCommandModeToWakeWord(reason = "audio_focus_lost")
                    }
                }
            }
        )

        liveClient = ZoniLiveSessionClient { event ->
            handleBackgroundLiveEvent(event)
        }

        networkMonitor = NetworkQualityMonitor(applicationContext) { quality ->
            liveClient?.updateNetworkQuality(quality)
        }.also {
            it.start()
            liveClient?.updateNetworkQuality(it.currentQuality)
        }

        isServiceRunning = true
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val action = intent?.action ?: ACTION_START
        Log.i(TAG, "onStartCommand action=$action mode=$backgroundMode")

        when (action) {
            ACTION_STOP -> {
                stopAllAndShutdown(
                    disablePersistedPreference = intent?.getBooleanExtra(EXTRA_DISABLE_PREF, true) ?: true
                )
                return START_NOT_STICKY
            }

            ACTION_PAUSE_WAKE_WORD -> {
                val reasonState = VoiceLifecycleState.fromString(intent?.getStringExtra(EXTRA_VOICE_STATE))
                val transition = BackgroundCommandPolicy.reduce(
                    backgroundMode,
                    BackgroundAssistantEvent.ForegroundVoiceStarted
                )
                backgroundMode = transition.nextMode
                if (transition.shouldStopBackgroundLive) {
                    teardownBackgroundLiveAndAudio()
                }
                wakeWordEngine?.pauseForConversation()
                releaseWakeLock()
                updateSnapshot(
                    listening = false,
                    backgroundCommandMode = false,
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
                // If already actively executing background command mode, do not interrupt it on passive resume
                if (isInBackgroundCommandLifecycle()) {
                    return START_STICKY
                }
                val phrase = preferences.getWakePhraseSync()
                val ready = if (isInForeground) {
                    updateNotificationIfForeground("Zoni AI Wake Word সক্রিয় — \"$phrase\" বলুন (মাইক্রোফোন শুনছে)")
                    true
                } else {
                    promoteToMicrophoneForeground("Zoni AI Wake Word সক্রিয় — \"$phrase\" বলুন (মাইক্রোফোন শুনছে)")
                }
                if (ready) {
                    startWakeWordDetectorInternal(phrase)
                }
                return START_STICKY
            }

            ACTION_UPDATE_VOICE_STATE -> {
                val newState = VoiceLifecycleState.fromString(intent?.getStringExtra(EXTRA_VOICE_STATE))
                // Never allow passive WebView IDLE updates to overwrite an active native background command session
                if (isInBackgroundCommandLifecycle() &&
                    (newState == VoiceLifecycleState.IDLE || newState == VoiceLifecycleState.DISABLED)
                ) {
                    return START_STICKY
                }
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

                teardownBackgroundLiveAndAudio()
                val notifText = "Zoni AI Wake Word সক্রিয় — \"$phrase\" বলুন (মাইক্রোফোন চালু আছে)"
                val ready = if (isInForeground) {
                    updateNotificationIfForeground(notifText)
                    true
                } else {
                    promoteToMicrophoneForeground(notifText)
                }
                if (!ready) {
                    return START_NOT_STICKY
                }
                startWakeWordDetectorInternal(phrase)
                return START_STICKY
            }

            else -> {
                // Standard ACTION_START for manual foreground Live Voice session
                if (!hasMicPermission(this)) {
                    reportErrorAndStop("Microphone permission (RECORD_AUDIO) is required for live voice service.")
                    return START_NOT_STICKY
                }
                val statusText = intent?.getStringExtra(EXTRA_STATUS_TEXT)
                    ?: "Zoni AI Live Voice Link সক্রিয় আছে — কথা বলার জন্য প্রস্তুত"
                backgroundMode = BackgroundAssistantMode.PAUSED_FOR_FOREGROUND_APP
                teardownBackgroundLiveAndAudio()
                wakeWordEngine?.pauseForConversation()
                releaseWakeLock()
                if (!promoteToMicrophoneForeground(statusText)) {
                    return START_NOT_STICKY
                }
                updateSnapshot(
                    backgroundServiceRunning = true,
                    listening = false,
                    backgroundCommandMode = false,
                    voiceState = VoiceLifecycleState.LISTENING,
                    lastError = ""
                )
                return START_STICKY
            }
        }
    }

    private fun isInBackgroundCommandLifecycle(): Boolean =
        backgroundMode == BackgroundAssistantMode.WAKE_GREETING ||
            backgroundMode == BackgroundAssistantMode.CONTINUOUS_COMMAND_MODE

    private fun startWakeWordDetectorInternal(phrase: String) {
        cancelConnectTimeout()
        teardownBackgroundLiveAndAudio()
        backgroundMode = BackgroundAssistantMode.WAKE_WORD_LISTENING
        acquirePartialWakeLock()

        val cfg = WakeWordConfig(wakePhrase = phrase)
        val started = wakeWordEngine?.start(
            config = cfg,
            onDetected = { event -> handleWakeWordDetected(event) },
            onError = { err ->
                Log.w(TAG, "WakeWordEngine error: $err")
                updateSnapshot(
                    listening = false,
                    backgroundCommandMode = false,
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
                backgroundCommandMode = false,
                wakePhrase = phrase,
                voiceState = VoiceLifecycleState.WAKE_WORD_LISTENING,
                lastError = ""
            )
            updateNotificationIfForeground("Zoni AI Wake Word সক্রিয় — \"$phrase\" বলুন (অন-ডিভাইস শুনছে)")
        } else {
            backgroundMode = BackgroundAssistantMode.STOPPED
            releaseWakeLock()
            updateSnapshot(
                backgroundServiceRunning = true,
                listening = false,
                backgroundCommandMode = false,
                voiceState = VoiceLifecycleState.ERROR
            )
        }
    }

    /**
     * Triggered when on-device Wake Word ("Zoni" / "জোনি") is detected.
     *
     * Strictly follows Requirements 1–9:
     * - Speaks ONLY via voice: "হ্যাঁ, বলো শুনছি।"
     * - NEVER posts a wake response notification or screen popup.
     * - NEVER launches MainActivity, Dashboard, or WebView.
     * - Starts Continuous Command Mode directly inside this authorized Foreground Service.
     */
    @Synchronized
    private fun handleWakeWordDetected(event: WakeWordDetectionEvent) {
        val currentState = _statusFlow.value.voiceState
        val nowMs = System.currentTimeMillis()
        if (!WakeWordLifecycleGuard.shouldAcceptWakeTrigger(currentState, lastAcceptedWakeAtMs, nowMs)) {
            Log.d(TAG, "Ignoring duplicate/overlapping wake trigger while voiceState=$currentState")
            return
        }
        val transition = BackgroundCommandPolicy.reduce(
            backgroundMode,
            BackgroundAssistantEvent.WakeWordDetected(event.remainingCommand)
        )
        if (transition.nextMode != BackgroundAssistantMode.WAKE_GREETING) {
            Log.d(TAG, "Ignoring wake trigger in backgroundMode=$backgroundMode")
            return
        }

        lastAcceptedWakeAtMs = nowMs
        backgroundMode = transition.nextMode
        pendingInitialWakeCommand = event.remainingCommand.trim()
        suppressedGeminiAudioTurnId = -1
        turnUserTranscripts.clear()
        turnAssistantTranscripts.clear()
        localCommandRouter.resetDeduplication()

        // Keep partial CPU wake lock active throughout greeting + continuous command mode
        // so Screen Off / Locked operation remains responsive.
        acquirePartialWakeLock()

        Log.i(TAG, "ZONI wake word triggered in background: ${event.matchedVariant} (${event.confidence})")
        updateSnapshot(
            listening = false,
            backgroundCommandMode = true,
            voiceState = VoiceLifecycleState.WAKE_WORD_DETECTED,
            lastDetectedAtMs = event.detectedAtMs,
            lastConfidence = event.confidence,
            lastVerificationLatencyMs = event.verificationLatencyMs,
            lastError = ""
        )
        // Notify any already-open UI passively; NEVER trigger WebView mic capture or launch MainActivity
        _wakeWordEvents.tryEmit(event.copy(handledInBackgroundService = true))

        updateSnapshot(
            listening = false,
            backgroundCommandMode = true,
            voiceState = VoiceLifecycleState.ACTIVATING
        )
        updateNotificationIfForeground("Zoni কমান্ড মোড সক্রিয় — নির্দেশ বলুন (\"ধন্যবাদ জোনি\" বা \"Stop Listening\" বললে বন্ধ হবে)")

        // Pre-connect Gemini Live in parallel while speaking "হ্যাঁ, বলো শুনছি।" for minimal latency
        val userSettings = preferences.getUserSettingsSync()
        val apiKey = preferences.getGeminiApiKey()
        liveAudioEngine?.isVoiceMuted = userSettings.voiceMuted

        val canConnectGemini = apiKey.isNotBlank() &&
            (networkMonitor?.refreshNow() ?: NetworkQualityState.STRONG) != NetworkQualityState.OFFLINE
        if (canConnectGemini) {
            liveClient?.connect(
                apiKey = apiKey,
                mode = userSettings.activeMode,
                affectionName = userSettings.selectedAffectionName,
                voice = userSettings.selectedVoice,
                language = userSettings.activeLanguage,
                forceReconnect = false
            )
        }

        // Speak exact voice-only greeting: "হ্যাঁ, বলো শুনছি।" (no notification, no popup, no Activity launch)
        val greeting = transition.spokenGreeting ?: BackgroundCommandPolicy.WAKE_RESPONSE_PHRASE
        updateSnapshot(
            listening = false,
            backgroundCommandMode = true,
            voiceState = VoiceLifecycleState.SPEAKING
        )
        voiceSpeaker?.speak(
            text = greeting,
            preferredLocale = Locale("bn", "BD"),
            timeoutMs = GREETING_TTS_TIMEOUT_MS
        ) {
            // Brief acoustic echo-tail settle so the mic does not capture the end of "শুনছি।"
            serviceHandler.postDelayed({
                onWakeGreetingFinished(apiKey = apiKey)
            }, GREETING_ECHO_SETTLE_MS)
        } ?: run {
            serviceHandler.postDelayed({
                onWakeGreetingFinished(apiKey = apiKey)
            }, GREETING_ECHO_SETTLE_MS)
        }
    }

    private fun onWakeGreetingFinished(apiKey: String) {
        if (!isServiceRunning || backgroundMode != BackgroundAssistantMode.WAKE_GREETING) return

        val transition = BackgroundCommandPolicy.reduce(
            backgroundMode,
            BackgroundAssistantEvent.WakeGreetingCompleted
        )
        backgroundMode = transition.nextMode

        if (apiKey.isBlank()) {
            Log.w(TAG, "Gemini API Key missing in background command mode; notifying user by voice.")
            speakNoticeAndReturnToWakeWord(
                "জেমিনি এপিআই কী সেট করা নেই। অনুগ্রহ করে অ্যাপের সেটিংস থেকে কী যোগ করুন।"
            )
            return
        }

        val initialCommand = pendingInitialWakeCommand
        pendingInitialWakeCommand = ""

        val quality = networkMonitor?.refreshNow() ?: NetworkQualityState.STRONG
        if (quality == NetworkQualityState.OFFLINE) {
            if (initialCommand.isNotBlank()) {
                serviceScope.launch {
                    val handledLocally = tryExecuteLocalCommandOnly(initialCommand, turnId = -1)
                    if (!handledLocally) {
                        serviceHandler.post {
                            speakNoticeAndReturnToWakeWord(
                                "এখন ইন্টারনেট সংযোগ নেই। ইন্টারনেট চালু হলে আবার ডাকুন।"
                            )
                        }
                    } else {
                        serviceHandler.post {
                            exitBackgroundCommandModeToWakeWord(reason = "offline_after_local_command")
                        }
                    }
                }
            } else {
                speakNoticeAndReturnToWakeWord(
                    "এখন ইন্টারনেট সংযোগ নেই। জেমিনি লাইভের জন্য ইন্টারনেট প্রয়োজন।"
                )
            }
            return
        }

        val client = liveClient
        if (client != null && client.isConnected()) {
            pendingBackgroundMicStart = false
            activateBackgroundCommandMicrophone()
            if (initialCommand.isNotBlank()) {
                dispatchInitialCommandInContinuousMode(initialCommand)
            }
        } else {
            pendingBackgroundMicStart = true
            updateSnapshot(
                listening = false,
                backgroundCommandMode = true,
                voiceState = VoiceLifecycleState.CONNECTING
            )
            val userSettings = preferences.getUserSettingsSync()
            client?.connect(
                apiKey = apiKey,
                mode = userSettings.activeMode,
                affectionName = userSettings.selectedAffectionName,
                voice = userSettings.selectedVoice,
                language = userSettings.activeLanguage,
                forceReconnect = false
            )
            if (initialCommand.isNotBlank()) {
                pendingInitialWakeCommand = initialCommand
            }
            scheduleConnectTimeout()
        }
    }

    private fun activateBackgroundCommandMicrophone() {
        if (!isServiceRunning || backgroundMode != BackgroundAssistantMode.CONTINUOUS_COMMAND_MODE) return
        if (!hasMicPermission(this)) {
            reportErrorAndStop("Microphone permission (RECORD_AUDIO) is missing.")
            return
        }

        cancelConnectTimeout()
        val engine = liveAudioEngine ?: return
        engine.isMicMuted = false
        engine.setAssistantSpeaking(false)
        engine.resetEndOfSpeechDetector()

        val started = engine.startMicrophoneCapture(
            onSpeechEnded = {
                if (backgroundMode == BackgroundAssistantMode.CONTINUOUS_COMMAND_MODE) {
                    updateSnapshot(
                        listening = false,
                        backgroundCommandMode = true,
                        voiceState = VoiceLifecycleState.PROCESSING
                    )
                    liveClient?.sendAudioStreamEnd()
                }
            },
            onBargeInDetected = {
                if (backgroundMode == BackgroundAssistantMode.CONTINUOUS_COMMAND_MODE) {
                    voiceSpeaker?.stop()
                    liveClient?.sendInterrupt()
                    updateSnapshot(
                        listening = false,
                        backgroundCommandMode = true,
                        voiceState = VoiceLifecycleState.LISTENING
                    )
                }
            }
        ) { base64Chunk ->
            if (backgroundMode == BackgroundAssistantMode.CONTINUOUS_COMMAND_MODE) {
                liveClient?.sendAudioChunk(base64Chunk)
            }
        }

        if (started) {
            updateSnapshot(
                listening = false,
                backgroundCommandMode = true,
                voiceState = VoiceLifecycleState.LISTENING,
                lastError = ""
            )
            updateNotificationIfForeground("Zoni কমান্ড মোড শুনছে — পরপর নির্দেশ দিন (\"ধন্যবাদ জোনি\" বললে বন্ধ হবে)")
        } else {
            Log.w(TAG, "LiveAudioEngine failed to start microphone in background command mode.")
            exitBackgroundCommandModeToWakeWord(reason = "mic_init_failed")
        }
    }

    private fun dispatchInitialCommandInContinuousMode(commandText: String) {
        val clean = commandText.trim()
        if (clean.isEmpty()) return
        if (BackgroundCommandPolicy.isStopCommandModePhrase(clean)) {
            exitBackgroundCommandModeToWakeWord(reason = "stop_phrase_in_wake_tail")
            return
        }
        serviceScope.launch {
            val handledLocally = tryExecuteLocalCommandOnly(clean, turnId = -1)
            if (!handledLocally) {
                val outbound = buildMemoryEnrichedPayload(clean)
                liveClient?.sendClientText(outbound, clientMsgId = "bg-init-${System.currentTimeMillis()}")
            }
        }
    }

    private fun handleBackgroundLiveEvent(event: LiveServerEvent) {
        if (!isInBackgroundCommandLifecycle()) return

        when (event) {
            is LiveServerEvent.Connected -> {
                cancelConnectTimeout()
                if (backgroundMode == BackgroundAssistantMode.CONTINUOUS_COMMAND_MODE) {
                    if (pendingBackgroundMicStart) {
                        pendingBackgroundMicStart = false
                        serviceHandler.post {
                            activateBackgroundCommandMicrophone()
                            val queuedInitial = pendingInitialWakeCommand
                            pendingInitialWakeCommand = ""
                            if (queuedInitial.isNotBlank()) {
                                dispatchInitialCommandInContinuousMode(queuedInitial)
                            }
                        }
                    } else {
                        updateSnapshot(
                            listening = false,
                            backgroundCommandMode = true,
                            voiceState = VoiceLifecycleState.CONNECTED
                        )
                    }
                }
            }

            is LiveServerEvent.UserTranscript -> {
                val prev = turnUserTranscripts[event.turnId].orEmpty()
                val merged = if (prev.isEmpty()) {
                    event.text.trim()
                } else {
                    MobileAssistantEngine.mergeTranscriptChunk(prev, event.text)
                }
                if (merged.isBlank()) return
                turnUserTranscripts[event.turnId] = merged

                // Requirement 8: Immediate stop-phrase exit ("ধন্যবাদ জোনি" / "Stop Listening")
                if (BackgroundCommandPolicy.isStopCommandModePhrase(merged)) {
                    val now = System.currentTimeMillis()
                    if (now - lastHandledStopAtMs > 1200L) {
                        lastHandledStopAtMs = now
                        pendingCommandDebounceJob?.cancel()
                        Log.i(TAG, "Stop phrase detected in background command mode: returning to wake word.")
                        serviceHandler.post {
                            exitBackgroundCommandModeToWakeWord(reason = "stop_phrase")
                        }
                    }
                    return
                }

                // Stage 1: Safe partial-transcript check via existing LocalCommandRouter
                val previewRoute = localCommandRouter.route(merged, isFinal = false)
                if (previewRoute.kind == LocalRouteDecisionKind.REQUIRES_EXPLICIT_AUTHORIZATION ||
                    previewRoute.kind == LocalRouteDecisionKind.BLOCKED_UNSAFE
                ) {
                    pendingCommandDebounceJob?.cancel()
                    suppressGeminiTurnAndSpeakOutcome(
                        turnId = event.turnId,
                        message = previewRoute.blockedReason
                            ?: "এই কাজটির জন্য সরাসরি অনুমতি প্রয়োজন।"
                    )
                    return
                }

                pendingCommandDebounceJob?.cancel()
                if (previewRoute.kind == LocalRouteDecisionKind.WAIT_FOR_MORE_SPEECH) {
                    return
                }

                val capturedTranscript = merged
                val capturedTurnId = event.turnId
                pendingCommandDebounceJob = serviceScope.launch {
                    delay(140L)
                    if (backgroundMode != BackgroundAssistantMode.CONTINUOUS_COMMAND_MODE) return@launch
                    tryExecuteLocalCommandOnly(capturedTranscript, capturedTurnId)
                }
            }

            is LiveServerEvent.AudioChunk -> {
                if (backgroundMode != BackgroundAssistantMode.CONTINUOUS_COMMAND_MODE) return
                if (event.turnId == suppressedGeminiAudioTurnId) return
                if (preferences.getUserSettingsSync().voiceMuted) return

                liveAudioEngine?.setAssistantSpeaking(true)
                updateSnapshot(
                    listening = false,
                    backgroundCommandMode = true,
                    voiceState = VoiceLifecycleState.SPEAKING
                )
                liveAudioEngine?.playPcm24kBase64(event.base64Pcm24k)
            }

            is LiveServerEvent.OutputTranscript -> {
                if (backgroundMode != BackgroundAssistantMode.CONTINUOUS_COMMAND_MODE) return
                if (event.turnId == suppressedGeminiAudioTurnId) return

                val (cleanText, action) = MobileAssistantEngine.extractActionTagFromText(event.text)
                if (action != null) {
                    serviceScope.launch {
                        try {
                            hardwareController.executeAction(action)
                        } catch (e: Exception) {
                            Log.w(TAG, "Background action tag execution failed: ${e.message}")
                        }
                    }
                }
                if (cleanText.isNotBlank()) {
                    val prev = turnAssistantTranscripts[event.turnId].orEmpty()
                    turnAssistantTranscripts[event.turnId] = if (prev.isEmpty()) {
                        cleanText
                    } else {
                        MobileAssistantEngine.mergeTranscriptChunk(prev, cleanText)
                    }
                }
            }

            is LiveServerEvent.Interrupted -> {
                if (backgroundMode != BackgroundAssistantMode.CONTINUOUS_COMMAND_MODE) return
                liveAudioEngine?.stopAllPlayback()
                updateSnapshot(
                    listening = false,
                    backgroundCommandMode = true,
                    voiceState = VoiceLifecycleState.LISTENING
                )
            }

            is LiveServerEvent.TurnComplete -> {
                if (backgroundMode != BackgroundAssistantMode.CONTINUOUS_COMMAND_MODE) return

                val userText = turnUserTranscripts.remove(event.turnId).orEmpty()
                val assistantText = turnAssistantTranscripts.remove(event.turnId).orEmpty()
                persistTurnToLocalMemory(userText, assistantText)

                // Wait for AudioTrack buffer drain before reopening near-field speech gate,
                // then STAY in Continuous Command Mode ready for the next command.
                val wasSuppressed = (event.turnId == suppressedGeminiAudioTurnId)
                if (!wasSuppressed) {
                    liveAudioEngine?.notifyTurnCompleteWhenDrained {
                        if (backgroundMode == BackgroundAssistantMode.CONTINUOUS_COMMAND_MODE) {
                            val transition = BackgroundCommandPolicy.reduce(
                                backgroundMode,
                                BackgroundAssistantEvent.GeminiTurnCompleted
                            )
                            backgroundMode = transition.nextMode
                            updateSnapshot(
                                listening = false,
                                backgroundCommandMode = true,
                                voiceState = VoiceLifecycleState.LISTENING
                            )
                        }
                    }
                }
            }

            is LiveServerEvent.StatusChanged -> {
                when (event.status) {
                    WsConnectionStatus.RECONNECTING -> {
                        if (backgroundMode == BackgroundAssistantMode.CONTINUOUS_COMMAND_MODE) {
                            updateSnapshot(
                                listening = false,
                                backgroundCommandMode = true,
                                voiceState = VoiceLifecycleState.RECONNECTING
                            )
                        }
                    }
                    WsConnectionStatus.ERROR -> {
                        if (backgroundMode == BackgroundAssistantMode.CONTINUOUS_COMMAND_MODE) {
                            serviceHandler.post {
                                exitBackgroundCommandModeToWakeWord(reason = "ws_error")
                            }
                        }
                    }
                    else -> Unit
                }
            }

            is LiveServerEvent.Error -> {
                Log.w(TAG, "Background Gemini Live error (retryable=${event.retryable}, code=${event.code}): ${event.message}")
                if (!event.retryable && isInBackgroundCommandLifecycle()) {
                    val voiceMsg = when (event.code) {
                        "GEMINI_KEY_MISSING", "GEMINI_KEY_INVALID" ->
                            "জেমিনি এপিআই কী সঠিক নয়। অনুগ্রহ করে সেটিংসে কী পরীক্ষা করুন।"
                        "GEMINI_QUOTA_EXCEEDED" ->
                            "জেমিনি এপিআই সীমা শেষ হয়ে গেছে। পরে আবার চেষ্টা করুন।"
                        else ->
                            "জেমিনি লাইভ সংযোগ বিচ্ছিন্ন হয়েছে। আবার জোনি বলে ডাকুন।"
                    }
                    serviceHandler.post {
                        speakNoticeAndReturnToWakeWord(voiceMsg)
                    }
                }
            }
        }
    }

    /**
     * Routes a completed spoken transcript through the existing [CommandDispatcher],
     * [LocalCommandRouter], [BengaliDateTimeEngine], [AndroidHardwareController], and
     * [LocalMemoryRepository]. Returns true if executed deterministically on-device.
     */
    private suspend fun tryExecuteLocalCommandOnly(transcript: String, turnId: Int): Boolean {
        val clean = transcript.trim()
        if (clean.isEmpty()) return false

        // Belt-and-suspenders check through CommandDispatcher
        val parsedDirect = commandDispatcher.parseCommand(clean)
        if (parsedDirect is VoiceCommand.StopCommandMode) {
            serviceHandler.post {
                exitBackgroundCommandModeToWakeWord(reason = "dispatcher_stop_command")
            }
            return true
        }

        // Direct battery status shortcut
        val directIntent = MobileAssistantEngine.detectAssistantIntent(clean)
        if (directIntent?.type == ActionType.BATTERY) {
            val settings = preferences.getUserSettingsSync()
            val bat = hardwareController.getBatteryStatus()
            val batMsg = if (settings.activeLanguage == SupportedLanguage.BENGALI) {
                "আপনার ফোনের ব্যাটারি এখন ${BengaliDateTimeEngine.toBengaliDigits(bat.level.toString())} শতাংশ (${if (bat.charging) "চার্জ হচ্ছে" else "নরমাল"})।"
            } else {
                "Your battery is currently at ${bat.level}% (${if (bat.charging) "charging" else "not charging"})."
            }
            persistTurnToLocalMemory(clean, batMsg)
            suppressGeminiTurnAndSpeakOutcome(turnId, batMsg)
            return true
        }

        // Route via existing LocalCommandRouter (consequential guards + dedup + deterministic actions)
        val finalRoute = localCommandRouter.route(clean, isFinal = true)
        when (finalRoute.kind) {
            LocalRouteDecisionKind.DUPLICATE_SUPPRESSED -> return true

            LocalRouteDecisionKind.REQUIRES_EXPLICIT_AUTHORIZATION,
            LocalRouteDecisionKind.BLOCKED_UNSAFE -> {
                val msg = finalRoute.blockedReason
                    ?: "এই কাজটির জন্য সরাসরি অনুমোদন প্রয়োজন।"
                suppressGeminiTurnAndSpeakOutcome(turnId, msg)
                return true
            }

            LocalRouteDecisionKind.LOCAL_DATETIME -> {
                val dt = finalRoute.dateTimeQuery ?: return false
                val reply = when (dt) {
                    BengaliDateTimeEngine.DateTimeQueryType.TIME -> BengaliDateTimeEngine.formatBengaliSpokenTime()
                    BengaliDateTimeEngine.DateTimeQueryType.DATE -> BengaliDateTimeEngine.formatBengaliDate()
                    BengaliDateTimeEngine.DateTimeQueryType.WEEKDAY -> BengaliDateTimeEngine.formatBengaliWeekday()
                }
                persistTurnToLocalMemory(clean, reply)
                suppressGeminiTurnAndSpeakOutcome(turnId, reply)
                return true
            }

            LocalRouteDecisionKind.LOCAL_DIRECT -> {
                val cmd = finalRoute.command ?: return false
                val typedReq = VoiceCommandActionMapper.toTypedActionRequest(cmd) ?: return false
                val result = withContext(Dispatchers.IO) {
                    hardwareController.deviceActionExecutor.executeTypedAction(typedReq)
                }
                recordFrequentCommandSafe(clean)
                persistTurnToLocalMemory(clean, result.message)
                suppressGeminiTurnAndSpeakOutcome(turnId, result.message)
                return true
            }

            else -> {
                // Also support AppSearchWorkflow via CommandDispatcher even if not in LocalCommandRouter's direct set
                if (parsedDirect is VoiceCommand.AppSearchWorkflow) {
                    val typedReq = VoiceCommandActionMapper.toTypedActionRequest(parsedDirect)
                    if (typedReq != null) {
                        val result = withContext(Dispatchers.IO) {
                            hardwareController.deviceActionExecutor.executeTypedAction(typedReq)
                        }
                        recordFrequentCommandSafe(clean)
                        persistTurnToLocalMemory(clean, result.message)
                        suppressGeminiTurnAndSpeakOutcome(turnId, result.message)
                        return true
                    }
                }
                return false
            }
        }
    }

    /**
     * Suppresses speculative Gemini audio for a locally executed command turn, speaks the
     * honest verified outcome via voice-only TTS, and keeps Continuous Command Mode listening
     * for the next command immediately after speaking finishes.
     */
    private fun suppressGeminiTurnAndSpeakOutcome(turnId: Int, message: String) {
        if (turnId >= 0) {
            suppressedGeminiAudioTurnId = turnId
        }
        liveAudioEngine?.stopAllPlayback()
        liveAudioEngine?.setAssistantSpeaking(true)
        liveClient?.sendInterrupt()

        val settings = preferences.getUserSettingsSync()
        val locale = when (settings.activeLanguage) {
            SupportedLanguage.ENGLISH -> Locale.US
            SupportedLanguage.HINDI -> Locale("hi", "IN")
            SupportedLanguage.BENGALI -> Locale("bn", "BD")
        }

        val cleanOutcome = message.trim()
        if (cleanOutcome.isEmpty() || settings.voiceMuted) {
            liveAudioEngine?.setAssistantSpeaking(false)
            liveAudioEngine?.resetEndOfSpeechDetector()
            if (backgroundMode == BackgroundAssistantMode.CONTINUOUS_COMMAND_MODE) {
                updateSnapshot(
                    listening = false,
                    backgroundCommandMode = true,
                    voiceState = VoiceLifecycleState.LISTENING
                )
            }
            return
        }

        updateSnapshot(
            listening = false,
            backgroundCommandMode = true,
            voiceState = VoiceLifecycleState.SPEAKING
        )

        val onOutcomeSpoken = {
            serviceHandler.postDelayed({
                if (backgroundMode == BackgroundAssistantMode.CONTINUOUS_COMMAND_MODE) {
                    val transition = BackgroundCommandPolicy.reduce(
                        backgroundMode,
                        BackgroundAssistantEvent.CommandCompleted
                    )
                    backgroundMode = transition.nextMode
                    liveAudioEngine?.setAssistantSpeaking(false)
                    liveAudioEngine?.resetEndOfSpeechDetector()
                    updateSnapshot(
                        listening = false,
                        backgroundCommandMode = true,
                        voiceState = VoiceLifecycleState.LISTENING
                    )
                }
            }, GREETING_ECHO_SETTLE_MS)
        }

        val speaker = voiceSpeaker
        if (speaker != null) {
            speaker.speak(
                text = cleanOutcome,
                preferredLocale = locale,
                timeoutMs = ACTION_TTS_TIMEOUT_MS,
                onFinished = onOutcomeSpoken
            )
        } else {
            onOutcomeSpoken()
        }
    }

    private fun speakNoticeAndReturnToWakeWord(notice: String) {
        teardownBackgroundLiveAndAudio()
        val speaker = voiceSpeaker
        if (speaker == null || preferences.getUserSettingsSync().voiceMuted) {
            exitBackgroundCommandModeToWakeWord(reason = "notice_skipped")
            return
        }
        speaker.speak(
            text = notice,
            preferredLocale = Locale("bn", "BD"),
            timeoutMs = ACTION_TTS_TIMEOUT_MS
        ) {
            serviceHandler.postDelayed({
                exitBackgroundCommandModeToWakeWord(reason = "notice_completed")
            }, GREETING_ECHO_SETTLE_MS)
        }
    }

    private fun exitBackgroundCommandModeToWakeWord(reason: String) {
        Log.i(TAG, "Exiting background command mode (reason=$reason) -> returning to wake word listening.")
        cancelConnectTimeout()
        val transition = BackgroundCommandPolicy.reduce(
            backgroundMode,
            BackgroundAssistantEvent.StopPhraseDetected
        )
        teardownBackgroundLiveAndAudio()

        if (!isServiceRunning) return
        val shouldKeepWakeWord = preferences.isWakeWordEnabledSync() || preferences.isBackgroundListeningEnabledSync()
        if (transition.shouldResumeWakeWord && shouldKeepWakeWord && hasMicPermission(this)) {
            startWakeWordDetectorInternal(preferences.getWakePhraseSync())
        } else {
            backgroundMode = BackgroundAssistantMode.STOPPED
            releaseWakeLock()
            updateSnapshot(
                listening = false,
                backgroundCommandMode = false,
                voiceState = VoiceLifecycleState.IDLE
            )
        }
    }

    private fun teardownBackgroundLiveAndAudio() {
        cancelConnectTimeout()
        pendingBackgroundMicStart = false
        pendingInitialWakeCommand = ""
        suppressedGeminiAudioTurnId = -1
        pendingCommandDebounceJob?.cancel()
        pendingCommandDebounceJob = null
        turnUserTranscripts.clear()
        turnAssistantTranscripts.clear()
        voiceSpeaker?.stop()
        liveAudioEngine?.stopAllPlayback()
        liveAudioEngine?.stopMicrophoneCapture()
        liveClient?.disconnect(clearApiKey = false)
    }

    private suspend fun buildMemoryEnrichedPayload(userText: String): String {
        val repo = (application as? ZoniApplication)?.localMemoryRepository ?: return userText
        return try {
            val compact = repo.buildCompactContextForQuery(userText)
            if (compact.isNotBlank()) "$compact\nUser: $userText" else userText
        } catch (_: Exception) {
            userText
        }
    }

    private fun persistTurnToLocalMemory(userText: String, assistantText: String) {
        val repo = (application as? ZoniApplication)?.localMemoryRepository ?: return
        val langCode = preferences.getUserSettingsSync().activeLanguage.code
        serviceScope.launch {
            try {
                if (userText.isNotBlank()) {
                    repo.saveMessage("user", userText, langCode)
                }
                if (assistantText.isNotBlank()) {
                    repo.saveMessage("assistant", assistantText, langCode)
                }
            } catch (_: Exception) {
            }
        }
    }

    private fun recordFrequentCommandSafe(commandText: String) {
        val repo = (application as? ZoniApplication)?.localMemoryRepository ?: return
        serviceScope.launch {
            try {
                repo.recordFrequentCommand(commandText)
            } catch (_: Exception) {
            }
        }
    }

    private fun scheduleConnectTimeout() {
        cancelConnectTimeout()
        val runnable = Runnable {
            if (isServiceRunning &&
                backgroundMode == BackgroundAssistantMode.CONTINUOUS_COMMAND_MODE &&
                pendingBackgroundMicStart
            ) {
                Log.w(TAG, "Background Gemini Live connection timed out after ${BACKGROUND_CONNECT_TIMEOUT_MS}ms.")
                speakNoticeAndReturnToWakeWord(
                    "জেমিনি লাইভে সংযোগ করা যায়নি। আবার জোনি বলে চেষ্টা করুন।"
                )
            }
        }
        connectTimeoutRunnable = runnable
        serviceHandler.postDelayed(runnable, BACKGROUND_CONNECT_TIMEOUT_MS)
    }

    private fun cancelConnectTimeout() {
        connectTimeoutRunnable?.let { serviceHandler.removeCallbacks(it) }
        connectTimeoutRunnable = null
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
            val pm = getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return
            val existing = wakeLock
            if (existing == null) {
                wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "zoni:WakeWordListeningLock").apply {
                    setReferenceCounted(false)
                    acquire(WAKE_LOCK_WINDOW_MS)
                }
            } else {
                existing.acquire(WAKE_LOCK_WINDOW_MS)
            }
            scheduleWakeLockRenewal()
        } catch (e: Exception) {
            Log.w(TAG, "WakeLock acquisition skipped: ${e.message}")
        }
    }

    private fun scheduleWakeLockRenewal() {
        wakeLockRenewRunnable?.let { serviceHandler.removeCallbacks(it) }
        val runnable = object : Runnable {
            override fun run() {
                if (isServiceRunning && (_statusFlow.value.listening || isInBackgroundCommandLifecycle())) {
                    try {
                        wakeLock?.acquire(WAKE_LOCK_WINDOW_MS)
                    } catch (_: Exception) {
                    }
                    serviceHandler.postDelayed(this, WAKE_LOCK_RENEW_INTERVAL_MS)
                }
            }
        }
        wakeLockRenewRunnable = runnable
        serviceHandler.postDelayed(runnable, WAKE_LOCK_RENEW_INTERVAL_MS)
    }

    private fun releaseWakeLock() {
        wakeLockRenewRunnable?.let { serviceHandler.removeCallbacks(it) }
        wakeLockRenewRunnable = null
        try {
            if (wakeLock?.isHeld == true) {
                wakeLock?.release()
            }
        } catch (_: Exception) {
        }
        wakeLock = null
    }

    private fun reportErrorAndStop(errorMessage: String) {
        backgroundMode = BackgroundAssistantMode.STOPPED
        teardownBackgroundLiveAndAudio()
        wakeWordEngine?.stop()
        releaseWakeLock()
        isInForeground = false
        isServiceRunning = false
        updateSnapshot(
            backgroundServiceRunning = false,
            listening = false,
            backgroundCommandMode = false,
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
        backgroundMode = BackgroundAssistantMode.STOPPED
        teardownBackgroundLiveAndAudio()
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
            backgroundCommandMode = false,
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
        backgroundCommandMode: Boolean = _statusFlow.value.backgroundCommandMode,
        wakePhrase: String = _statusFlow.value.wakePhrase,
        voiceState: VoiceLifecycleState = _statusFlow.value.voiceState,
        lastDetectedAtMs: Long = _statusFlow.value.lastDetectedAtMs,
        lastConfidence: Float = _statusFlow.value.lastConfidence,
        lastVerificationLatencyMs: Double = _statusFlow.value.lastVerificationLatencyMs,
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
            recognitionMode = wakeWordEngine?.currentRecognitionMode ?: ZoniWakeWordEngine.MODE_ON_DEVICE_OFFLINE,
            lastDetectedAtMs = lastDetectedAtMs,
            lastConfidence = lastConfidence,
            lastVerificationLatencyMs = lastVerificationLatencyMs,
            lastError = lastError,
            backgroundCommandMode = backgroundCommandMode
        )
    }

    override fun onDestroy() {
        backgroundMode = BackgroundAssistantMode.STOPPED
        teardownBackgroundLiveAndAudio()
        voiceSpeaker?.release()
        voiceSpeaker = null
        liveAudioEngine?.release()
        liveAudioEngine = null
        networkMonitor?.stop()
        networkMonitor = null
        wakeWordEngine?.stop()
        releaseWakeLock()
        serviceScope.cancel()
        isInForeground = false
        isServiceRunning = false
        val cur = _statusFlow.value
        _statusFlow.value = cur.copy(
            backgroundServiceRunning = false,
            listening = false,
            backgroundCommandMode = false,
            voiceState = if (cur.wakeWordEnabled) VoiceLifecycleState.IDLE else VoiceLifecycleState.DISABLED
        )
        super.onDestroy()
    }

    companion object {
        private const val TAG = "ZoniForegroundService"
        private const val WAKE_LOCK_WINDOW_MS = 30L * 60L * 1000L
        private const val WAKE_LOCK_RENEW_INTERVAL_MS = 20L * 60L * 1000L
        private const val GREETING_TTS_TIMEOUT_MS = 3800L
        private const val ACTION_TTS_TIMEOUT_MS = 6500L
        private const val GREETING_ECHO_SETTLE_MS = 220L
        private const val BACKGROUND_CONNECT_TIMEOUT_MS = 12_000L
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

        fun isBackgroundCommandModeActive(): Boolean =
            isServiceRunning && _statusFlow.value.backgroundCommandMode

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
                    backgroundCommandMode = false,
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
            if (isServiceRunning && isInForeground) {
                try {
                    context.startService(intent)
                    return
                } catch (_: Exception) {
                }
            }
            dispatchForegroundServiceIntent(context, intent)
        }

        fun updateVoiceState(context: Context, state: VoiceLifecycleState) {
            if (isBackgroundCommandModeActive() &&
                (state == VoiceLifecycleState.IDLE || state == VoiceLifecycleState.DISABLED)
            ) {
                return
            }
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
                backgroundCommandMode = false,
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
                    backgroundCommandMode = false,
                    voiceState = VoiceLifecycleState.ERROR,
                    lastError = msg
                )
                false
            }
        }
    }
}
