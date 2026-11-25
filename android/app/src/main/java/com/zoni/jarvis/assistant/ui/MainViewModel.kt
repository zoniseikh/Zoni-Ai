package com.zoni.jarvis.assistant.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.zoni.jarvis.assistant.ZoniApplication
import com.zoni.jarvis.assistant.action.AllowedActionType
import com.zoni.jarvis.assistant.action.TypedActionRequest
import com.zoni.jarvis.assistant.audio.LiveAudioEngine
import com.zoni.jarvis.assistant.data.ZoniUserSettings
import com.zoni.jarvis.assistant.domain.ActionType
import com.zoni.jarvis.assistant.domain.AssistantState
import com.zoni.jarvis.assistant.domain.BengaliDateTimeEngine
import com.zoni.jarvis.assistant.domain.ChatMessage
import com.zoni.jarvis.assistant.domain.CommandDispatcher
import com.zoni.jarvis.assistant.domain.CompanionMode
import com.zoni.jarvis.assistant.domain.MessageRole
import com.zoni.jarvis.assistant.domain.MobileAssistantEngine
import com.zoni.jarvis.assistant.domain.SupportedLanguage
import com.zoni.jarvis.assistant.domain.VoiceCommand
import com.zoni.jarvis.assistant.domain.VoiceProfile
import com.zoni.jarvis.assistant.domain.WsConnectionStatus
import com.zoni.jarvis.assistant.hardware.AndroidPermissionsSnapshot
import com.zoni.jarvis.assistant.hardware.BatterySnapshot
import com.zoni.jarvis.assistant.network.LiveServerEvent
import com.zoni.jarvis.assistant.network.NetworkQualityMonitor
import com.zoni.jarvis.assistant.network.NetworkQualityState
import com.zoni.jarvis.assistant.network.ZoniLiveSessionClient
import com.zoni.jarvis.assistant.service.FloatingOrbService
import com.zoni.jarvis.assistant.service.ZoniForegroundService
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.UUID
import kotlin.math.sin

data class ZoniUiState(
    val settings: ZoniUserSettings = ZoniUserSettings(),
    val assistantState: AssistantState = AssistantState.IDLE,
    val wsStatus: WsConnectionStatus = WsConnectionStatus.DISCONNECTED,
    val isLiveActive: Boolean = false,
    val isMicMuted: Boolean = false,
    val latestTranscript: String = "নমস্কার Boss! Zoni AI কোর পুরোপুরি সক্রিয় আছে। আমার সাথে মন খুলে কথা বলুন ❤️",
    val messages: List<ChatMessage> = listOf(
        ChatMessage(
            id = "welcome-1",
            role = MessageRole.ASSISTANT,
            text = "নমস্কার Boss! Zoni AI সক্রিয় আছে। আপনি বাংলায় বা যেকোনো ভাষায় বলুন, আমি আপনার ভালোবাসার সাথী ও অ্যাসিস্ট্যান্ট হিসেবে সবসময় প্রস্তুত আছি ❤️"
        )
    ),
    val heartRate: Int = 74,
    val affectionLevel: Int = 100,
    val istClockText: String = BengaliDateTimeEngine.formatClock24Ist(),
    val audioAmplitude: Float = 0f,
    val isTorchOn: Boolean = false,
    val isFloatingOrbRunning: Boolean = false,
    val battery: BatterySnapshot = BatterySnapshot(100, false),
    val permissions: AndroidPermissionsSnapshot? = null,
    val geminiKeyConfigured: Boolean = false,
    val geminiKeyMasked: String? = null,
    val isKeystoreBacked: Boolean = false,
    val networkQuality: NetworkQualityState = NetworkQualityState.STRONG
)

class MainViewModel(application: Application) : AndroidViewModel(application) {

    private val app = application as ZoniApplication
    private val preferences = app.preferences
    private val hardware = app.hardwareController
    private val localMemoryRepository = app.localMemoryRepository
    private val commandDispatcher = CommandDispatcher()

    private val _uiState = MutableStateFlow(ZoniUiState())
    val uiState: StateFlow<ZoniUiState> = _uiState.asStateFlow()

    private val audioEngine = LiveAudioEngine(
        context = app,
        onAmplitudeChanged = { amp ->
            _uiState.update { it.copy(audioAmplitude = amp) }
        },
        onAudioFocusLost = {
            if (_uiState.value.isLiveActive) {
                stopLiveVoice()
            }
        }
    )

    private val liveClient = ZoniLiveSessionClient { event ->
        handleLiveEvent(event)
    }

    private val networkMonitor = NetworkQualityMonitor(app) { quality ->
        liveClient.updateNetworkQuality(quality)
        _uiState.update { it.copy(networkQuality = quality) }
    }

    private var userSpeechTurnId = 1
    private var currentAssistantTurnId = 1
    private var initializedConnection = false
    private var pendingVoiceStart = false
    private val persistedLiveMessageIds = HashSet<String>()

    init {
        networkMonitor.start()
        liveClient.updateNetworkQuality(networkMonitor.currentQuality)
        _uiState.update { it.copy(networkQuality = networkMonitor.currentQuality) }
        refreshSystemStatus()

        // Restore persisted local conversation history from Room ZoniDatabase asynchronously
        viewModelScope.launch {
            val savedRows = localMemoryRepository.loadRecentConversations(limit = 60, offset = 0)
            if (savedRows.isNotEmpty()) {
                val restored = savedRows.map { row ->
                    ChatMessage(
                        id = row.id,
                        role = if (row.role.equals("user", ignoreCase = true)) MessageRole.USER else MessageRole.ASSISTANT,
                        text = row.text,
                        lang = when {
                            row.language.startsWith("en", ignoreCase = true) -> SupportedLanguage.ENGLISH
                            row.language.startsWith("hi", ignoreCase = true) -> SupportedLanguage.HINDI
                            else -> SupportedLanguage.BENGALI
                        },
                        timestampMillis = row.createdAtMs
                    )
                }
                _uiState.update { state ->
                    if (state.messages.size <= 1 && state.messages.firstOrNull()?.id == "welcome-1") {
                        state.copy(messages = restored)
                    } else {
                        state
                    }
                }
            }
        }

        // Observe persisted user settings
        viewModelScope.launch {
            preferences.settingsFlow.collect { userSettings ->
                audioEngine.isVoiceMuted = userSettings.voiceMuted
                _uiState.update { state ->
                    val updatedWelcome = if (!initializedConnection) {
                        "নমস্কার ${userSettings.selectedAffectionName}! Zoni AI কোর পুরোপুরি সক্রিয় আছে। আমার সাথে মন খুলে কথা বলুন ❤️"
                    } else {
                        state.latestTranscript
                    }
                    state.copy(
                        settings = userSettings,
                        latestTranscript = updatedWelcome,
                        geminiKeyConfigured = preferences.hasGeminiApiKey(),
                        geminiKeyMasked = preferences.getMaskedGeminiApiKeyPreview(),
                        isKeystoreBacked = preferences.isKeystoreBacked()
                    )
                }
                if (!initializedConnection) {
                    initializedConnection = true
                    val apiKey = preferences.getGeminiApiKey()
                    if (apiKey.isNotBlank()) {
                        liveClient.connect(
                            apiKey = apiKey,
                            mode = userSettings.activeMode,
                            affectionName = userSettings.selectedAffectionName,
                            voice = userSettings.selectedVoice,
                            language = userSettings.activeLanguage
                        )
                    } else {
                        _uiState.update {
                            it.copy(
                                wsStatus = WsConnectionStatus.DISCONNECTED,
                                latestTranscript = "Gemini API Key is not configured yet. Open Setup or Settings to add your own Gemini API Key."
                            )
                        }
                    }
                }
            }
        }

        // Observe live hardware torch state
        viewModelScope.launch {
            hardware.isTorchOn.collect { on ->
                _uiState.update { it.copy(isTorchOn = on) }
            }
        }

        // Live IST clock + heartbeat pulse loop (only emit StateFlow updates when values change)
        viewModelScope.launch {
            while (isActive) {
                val bpm = 72 + (sin(System.currentTimeMillis() / 1500.0) * 4).toInt()
                val nextClock = BengaliDateTimeEngine.formatClock24Ist()
                val nextOrb = FloatingOrbService.isRunning
                val current = _uiState.value
                if (current.istClockText != nextClock ||
                    current.heartRate != bpm ||
                    current.isFloatingOrbRunning != nextOrb
                ) {
                    _uiState.update {
                        it.copy(
                            istClockText = nextClock,
                            heartRate = bpm,
                            isFloatingOrbRunning = nextOrb
                        )
                    }
                }
                delay(1000L)
            }
        }
    }

    fun refreshSystemStatus() {
        _uiState.update {
            it.copy(
                battery = hardware.getBatteryStatus(),
                permissions = hardware.getPermissionsSnapshot(),
                isFloatingOrbRunning = FloatingOrbService.isRunning,
                geminiKeyConfigured = preferences.hasGeminiApiKey(),
                geminiKeyMasked = preferences.getMaskedGeminiApiKeyPreview(),
                isKeystoreBacked = preferences.isKeystoreBacked()
            )
        }
    }

    private fun handleLiveEvent(event: LiveServerEvent) {
        when (event) {
            is LiveServerEvent.StatusChanged -> {
                val droppedWhileLive = (event.status == WsConnectionStatus.ERROR || event.status == WsConnectionStatus.DISCONNECTED) &&
                    (_uiState.value.isLiveActive || pendingVoiceStart)
                if (droppedWhileLive) {
                    pendingVoiceStart = false
                    audioEngine.stopMicrophoneCapture()
                    if (preferences.isWakeWordEnabledSync() && preferences.isBackgroundListeningEnabledSync()) {
                        ZoniForegroundService.resumeWakeWordAfterConversation(app)
                    } else {
                        ZoniForegroundService.stop(app, disablePreference = false)
                    }
                    _uiState.update {
                        it.copy(
                            wsStatus = event.status,
                            isLiveActive = false,
                            assistantState = AssistantState.ERROR,
                            latestTranscript = "Live WebSocket disconnected — microphone capture stopped."
                        )
                    }
                } else {
                    _uiState.update { it.copy(wsStatus = event.status) }
                }
            }
            is LiveServerEvent.Connected -> {
                _uiState.update { it.copy(wsStatus = WsConnectionStatus.CONNECTED) }
                if (pendingVoiceStart) {
                    pendingVoiceStart = false
                    activateMicrophoneAfterConnected()
                }
            }
            is LiveServerEvent.Flashlight -> {
                hardware.setFlashlight(event.enable)
                val lang = _uiState.value.settings.activeLanguage
                val msg = if (lang == SupportedLanguage.BENGALI) {
                    if (event.enable) "টর্চ লাইট জ্বালানো হয়েছে।" else "টর্চ লাইট বন্ধ করা হয়েছে।"
                } else {
                    if (event.enable) "Flashlight turned on." else "Flashlight turned off."
                }
                _uiState.update { it.copy(latestTranscript = msg) }
            }
            is LiveServerEvent.UserTranscript -> {
                val speechId = "live-user-speech-${event.turnId}"
                _uiState.update { state ->
                    val list = state.messages.toMutableList()
                    val idx = list.indexOfFirst { it.id == speechId }
                    if (idx >= 0) {
                        val merged = MobileAssistantEngine.mergeTranscriptChunk(list[idx].text, event.text)
                        list[idx] = list[idx].copy(text = merged)
                    } else {
                        list.add(ChatMessage(id = speechId, role = MessageRole.USER, text = event.text.trim(), lang = state.settings.activeLanguage))
                    }
                    state.copy(messages = list)
                }
                if (MobileAssistantEngine.isFlashlightOnCommand(event.text)) {
                    hardware.setFlashlight(true)
                } else if (MobileAssistantEngine.isFlashlightOffCommand(event.text)) {
                    hardware.setFlashlight(false)
                }
            }
            is LiveServerEvent.AudioChunk -> {
                val st = _uiState.value
                if (!st.settings.voiceMuted && (st.isLiveActive || st.settings.voiceAutoPlay)) {
                    audioEngine.setAssistantSpeaking(true)
                    _uiState.update { it.copy(assistantState = AssistantState.SPEAKING) }
                    audioEngine.playPcm24kBase64(event.base64Pcm24k)
                }
            }
            is LiveServerEvent.OutputTranscript -> {
                val (cleanText, action) = MobileAssistantEngine.extractActionTagFromText(event.text)
                if (action != null) {
                    hardware.executeAction(action)
                }
                val langSwitch = MobileAssistantEngine.detectLanguageSwitchCommand(
                    cleanText.ifEmpty { event.text },
                    _uiState.value.settings.selectedAffectionName
                )
                if (langSwitch != null && langSwitch.lang != _uiState.value.settings.activeLanguage) {
                    selectLanguage(langSwitch.lang, sendVoiceDirective = false)
                }
                if (cleanText.isNotEmpty()) {
                    val turnId = "live-assistant-turn-${event.turnId}"
                    _uiState.update { state ->
                        val list = state.messages.toMutableList()
                        val idx = list.indexOfFirst { it.id == turnId }
                        val latest = if (idx >= 0) {
                            val merged = MobileAssistantEngine.mergeTranscriptChunk(list[idx].text, cleanText)
                            list[idx] = list[idx].copy(text = merged)
                            merged
                        } else {
                            list.add(ChatMessage(id = turnId, role = MessageRole.ASSISTANT, text = cleanText, lang = state.settings.activeLanguage))
                            cleanText
                        }
                        state.copy(messages = list, latestTranscript = latest)
                    }
                }
            }
            is LiveServerEvent.Interrupted -> {
                audioEngine.setAssistantSpeaking(false)
                audioEngine.stopAllPlayback()
                audioEngine.resetEndOfSpeechDetector()
                currentAssistantTurnId = event.turnId + 1
                _uiState.update {
                    it.copy(assistantState = if (it.isLiveActive) AssistantState.LISTENING else AssistantState.IDLE)
                }
            }
            is LiveServerEvent.TurnComplete -> {
                audioEngine.setAssistantSpeaking(false)
                audioEngine.resetEndOfSpeechDetector()
                val finalizedTurnId = event.turnId
                val userMsgId = "live-user-speech-$finalizedTurnId"
                val assistantMsgId = "live-assistant-turn-$finalizedTurnId"
                val snapshotMessages = _uiState.value.messages
                viewModelScope.launch {
                    snapshotMessages.firstOrNull { it.id == userMsgId }?.let { msg ->
                        if (persistedLiveMessageIds.add(msg.id)) {
                            localMemoryRepository.saveMessage("user", msg.text, msg.lang.code, msg.id, msg.timestampMillis)
                        }
                    }
                    snapshotMessages.firstOrNull { it.id == assistantMsgId }?.let { msg ->
                        if (persistedLiveMessageIds.add(msg.id)) {
                            localMemoryRepository.saveMessage("assistant", msg.text, msg.lang.code, msg.id, msg.timestampMillis)
                        }
                    }
                }
                currentAssistantTurnId = event.turnId + 1
                userSpeechTurnId += 1
                _uiState.update {
                    it.copy(
                        affectionLevel = (it.affectionLevel + 1).coerceAtMost(100),
                        assistantState = if (it.isLiveActive) AssistantState.LISTENING else AssistantState.IDLE
                    )
                }
            }
            is LiveServerEvent.Error -> {
                pendingVoiceStart = false
                if (_uiState.value.isLiveActive) {
                    audioEngine.stopMicrophoneCapture()
                    if (preferences.isWakeWordEnabledSync() && preferences.isBackgroundListeningEnabledSync()) {
                        ZoniForegroundService.resumeWakeWordAfterConversation(app)
                    } else {
                        ZoniForegroundService.stop(app, disablePreference = false)
                    }
                }
                _uiState.update {
                    it.copy(
                        isLiveActive = false,
                        wsStatus = WsConnectionStatus.ERROR,
                        assistantState = AssistantState.ERROR,
                        latestTranscript = "লাইভ সেশনে সংযোগ সমস্যা: ${event.message}"
                    )
                }
            }
        }
    }

    private fun activateMicrophoneAfterConnected(): Boolean {
        val s = _uiState.value.settings
        if (!liveClient.isConnected()) {
            _uiState.update {
                it.copy(
                    isLiveActive = false,
                    assistantState = AssistantState.ERROR,
                    latestTranscript = "Gemini Live session is not connected yet."
                )
            }
            return false
        }
        val started = audioEngine.startMicrophoneCapture(
            onSpeechEnded = { liveClient.sendAudioStreamEnd() }
        ) { base64Chunk ->
            liveClient.sendAudioChunk(base64Chunk)
        }
        if (started) {
            ZoniForegroundService.start(
                app,
                "Zoni AI শুনছে — ${s.selectedAffectionName}, কথা বলুন ❤️"
            )
            val msg = if (s.activeLanguage == SupportedLanguage.BENGALI) {
                "Zoni AI লাইভ ভয়েস সংযোগ স্থাপিত! বলুন ${s.selectedAffectionName}, আমি শুনছি ❤️"
            } else {
                "Zoni AI Live Link connected! Speak freely with me, ${s.selectedAffectionName} ❤️"
            }
            _uiState.update {
                it.copy(
                    isLiveActive = true,
                    assistantState = AssistantState.LISTENING,
                    latestTranscript = msg
                )
            }
        } else {
            _uiState.update {
                it.copy(
                    isLiveActive = false,
                    assistantState = AssistantState.ERROR,
                    latestTranscript = "Microphone initialization failed. Check RECORD_AUDIO permission."
                )
            }
        }
        return started
    }

    fun startLiveVoice(): Boolean {
        val perms = hardware.getPermissionsSnapshot()
        if (!perms.recordAudio) return false

        // Prevent duplicate simultaneous Gemini Live sessions
        if (_uiState.value.isLiveActive || pendingVoiceStart) {
            return true
        }

        val s = _uiState.value.settings
        val apiKey = preferences.getGeminiApiKey()
        if (apiKey.isBlank()) {
            _uiState.update {
                it.copy(
                    isLiveActive = false,
                    wsStatus = WsConnectionStatus.ERROR,
                    assistantState = AssistantState.ERROR,
                    latestTranscript = "Gemini API Key is not configured. Open Setup or Settings to enter your own Gemini API Key."
                )
            }
            return false
        }

        // Release wake-word microphone cleanly before Gemini Live takes over audio
        ZoniForegroundService.pauseWakeWordForConversation(
            app,
            com.zoni.jarvis.assistant.wakeword.VoiceLifecycleState.CONNECTING
        )

        if (liveClient.isConnected()) {
            return activateMicrophoneAfterConnected()
        }

        // Wait for authoritative LiveServerEvent.Connected before starting AudioRecord or showing LISTENING
        pendingVoiceStart = true
        _uiState.update {
            it.copy(
                isLiveActive = false,
                assistantState = AssistantState.CONNECTING,
                latestTranscript = if (s.activeLanguage == SupportedLanguage.BENGALI) {
                    "Google Gemini Live-এর সাথে সরাসরি সংযোগ করা হচ্ছে ${s.selectedAffectionName}..."
                } else {
                    "Connecting directly to Google Gemini Live, ${s.selectedAffectionName}..."
                }
            )
        }
        liveClient.connect(
            apiKey = apiKey,
            mode = s.activeMode,
            affectionName = s.selectedAffectionName,
            voice = s.selectedVoice,
            language = s.activeLanguage,
            forceReconnect = _uiState.value.wsStatus == WsConnectionStatus.ERROR
        )
        return true
    }

    fun stopLiveVoice() {
        pendingVoiceStart = false
        audioEngine.stopMicrophoneCapture()
        if (preferences.isWakeWordEnabledSync() && preferences.isBackgroundListeningEnabledSync()) {
            ZoniForegroundService.resumeWakeWordAfterConversation(app)
        } else {
            ZoniForegroundService.stop(app, disablePreference = false)
        }
        _uiState.update {
            it.copy(
                isLiveActive = false,
                assistantState = AssistantState.IDLE
            )
        }
    }

    fun toggleMicMute() {
        val next = !_uiState.value.isMicMuted
        audioEngine.isMicMuted = next
        _uiState.update { it.copy(isMicMuted = next) }
    }

    fun interruptSpeech() {
        audioEngine.stopAllPlayback()
        liveClient.sendInterrupt()
        _uiState.update {
            it.copy(assistantState = if (it.isLiveActive) AssistantState.LISTENING else AssistantState.IDLE)
        }
    }

    fun sendTextMessage(rawInput: String) {
        val text = rawInput.trim()
        if (text.isEmpty()) return
        val settings = _uiState.value.settings

        // 1. Check language switch command
        val langSwitch = MobileAssistantEngine.detectLanguageSwitchCommand(text, settings.selectedAffectionName)
        if (langSwitch != null) {
            appendMessage(MessageRole.USER, text, settings.activeLanguage)
            appendMessage(MessageRole.ASSISTANT, langSwitch.confirmation, langSwitch.lang)
            selectLanguage(langSwitch.lang, customConfirmation = langSwitch.confirmation)
            return
        }

        // 2. Direct Android hardware / intent execution
        val action = MobileAssistantEngine.detectAssistantIntent(text)
        if (action != null) {
            if (action.type == ActionType.BATTERY) {
                val bat = hardware.getBatteryStatus()
                val batMsg = if (settings.activeLanguage == SupportedLanguage.BENGALI) {
                    "আপনার ফোনের ব্যাটারি এখন ${BengaliDateTimeEngine.toBengaliDigits(bat.level.toString())}% (${if (bat.charging) "চার্জ হচ্ছে" else "নরমাল"}) ${settings.selectedAffectionName} 🔋"
                } else {
                    "Your battery is currently at ${bat.level}% (${if (bat.charging) "Charging" else "Normal"}), ${settings.selectedAffectionName} 🔋"
                }
                appendMessage(MessageRole.USER, text, settings.activeLanguage)
                appendMessage(MessageRole.ASSISTANT, batMsg, settings.activeLanguage)
                _uiState.update { it.copy(battery = bat, latestTranscript = batMsg) }
                return
            }
            hardware.executeAction(action)
        }

        // 3. Deterministic Asia/Kolkata time, date, weekday answers (instant even offline!)
        val dtQuery = BengaliDateTimeEngine.detectDateTimeQuery(text)
        if (dtQuery != null) {
            val reply = when (dtQuery) {
                BengaliDateTimeEngine.DateTimeQueryType.TIME -> BengaliDateTimeEngine.formatBengaliSpokenTime()
                BengaliDateTimeEngine.DateTimeQueryType.DATE -> BengaliDateTimeEngine.formatBengaliDate()
                BengaliDateTimeEngine.DateTimeQueryType.WEEKDAY -> BengaliDateTimeEngine.formatBengaliWeekday()
            }
            appendMessage(MessageRole.USER, text, settings.activeLanguage)
            appendMessage(MessageRole.ASSISTANT, reply, SupportedLanguage.BENGALI)
            _uiState.update { it.copy(latestTranscript = reply, assistantState = AssistantState.IDLE) }
            return
        }

        // 4. Local-first offline memory recall & deterministic on-device command execution (zero Gemini wait!)
        appendMessage(MessageRole.USER, text, settings.activeLanguage)
        audioEngine.stopAllPlayback()

        viewModelScope.launch {
            // 4a. Check offline local memory recall first
            val recall = localMemoryRepository.tryLocalMemoryRecall(text, settings.activeLanguage.code)
            if (recall.handledOffline && recall.replyText.isNotBlank()) {
                appendMessage(MessageRole.ASSISTANT, recall.replyText, settings.activeLanguage)
                _uiState.update { it.copy(latestTranscript = recall.replyText, assistantState = AssistantState.IDLE) }
                return@launch
            }

            // 4b. Execute deterministic local device/app/accessibility/WhatsApp/call commands WITHOUT waiting for Gemini Cloud
            val localRequest = mapVoiceCommandToLocalTypedRequest(commandDispatcher.parseCommand(text))
            if (localRequest != null) {
                val result = withContext(Dispatchers.IO) {
                    hardware.deviceActionExecutor.executeTypedAction(localRequest)
                }
                localMemoryRepository.recordFrequentCommand(text)
                appendMessage(MessageRole.ASSISTANT, result.message, settings.activeLanguage)
                _uiState.update { it.copy(latestTranscript = result.message, assistantState = AssistantState.IDLE) }
                return@launch
            }

            // 5. Cloud Gemini Live path: honestly detect offline state instead of hanging
            val currentQuality = networkMonitor.refreshNow()
            if (currentQuality == NetworkQualityState.OFFLINE) {
                val offlineMsg = when (settings.activeLanguage) {
                    SupportedLanguage.BENGALI -> "এখন ইন্টারনেট সংযোগ নেই। লোকাল কমান্ড (অ্যাপ খোলা, কল, টর্চ, ক্লিক, লোকাল মেমোরি) চালু আছে, তবে Gemini AI উত্তরের জন্য ইন্টারনেট প্রয়োজন।"
                    SupportedLanguage.HINDI -> "अभी इंटरनेट कनेक्शन नहीं है। लोकल कमांड चल सकते हैं, लेकिन Gemini AI उत्तर के लिए इंटरनेट ज़रूरी है।"
                    SupportedLanguage.ENGLISH -> "You are currently offline. Local device actions and local memory recall still work, while Gemini AI replies require an internet connection."
                }
                appendMessage(MessageRole.ASSISTANT, offlineMsg, settings.activeLanguage)
                _uiState.update {
                    it.copy(
                        networkQuality = currentQuality,
                        latestTranscript = offlineMsg,
                        assistantState = AssistantState.IDLE
                    )
                }
                return@launch
            }

            // Inject only a compact bounded local-memory snippet (never full history)
            val compactContext = localMemoryRepository.buildCompactContextForQuery(text)
            val outboundPayload = if (compactContext.isNotBlank()) {
                "$compactContext\nUser: $text"
            } else {
                text
            }
            _uiState.update { it.copy(assistantState = AssistantState.THINKING) }
            liveClient.sendClientText(outboundPayload, clientMsgId = "txt-${text.hashCode()}-${System.currentTimeMillis() / 3000L}")
        }
    }

    private fun mapVoiceCommandToLocalTypedRequest(cmd: VoiceCommand): TypedActionRequest? {
        fun build(type: AllowedActionType, args: Map<String, String> = emptyMap()) = TypedActionRequest(
            actionId = "loc_${UUID.randomUUID().toString().take(10)}",
            actionType = type,
            arguments = args,
            requiredPermissions = type.requiredPermissions,
            requiresConfirmation = false,
            timeoutMs = type.defaultTimeoutMs
        )
        return when (cmd) {
            is VoiceCommand.OpenApp -> build(AllowedActionType.OPEN_APP, mapOf("app_name" to cmd.appQuery))
            is VoiceCommand.ScrollScreen -> build(AllowedActionType.SCROLL_SCREEN, mapOf("direction" to cmd.direction))
            is VoiceCommand.NavigateGlobal -> when (cmd.action.lowercase()) {
                "home", "go_home" -> build(AllowedActionType.GO_HOME)
                "back", "go_back" -> build(AllowedActionType.GO_BACK)
                else -> null
            }
            is VoiceCommand.TapVisibleElement -> build(AllowedActionType.CLICK_VISIBLE_ELEMENT, mapOf("target" to cmd.targetLabel))
            is VoiceCommand.ClickYouTubeVideo -> build(
                AllowedActionType.CLICK_YOUTUBE_VIDEO,
                buildMap {
                    cmd.index?.let { put("index", it.toString()) }
                    if (cmd.targetHint.isNotBlank()) put("target", cmd.targetHint)
                    if (cmd.query.isNotBlank()) put("query", cmd.query)
                }
            )
            is VoiceCommand.ClickYouTubeSearchResult -> build(
                AllowedActionType.CLICK_YOUTUBE_SEARCH_RESULT,
                mapOf("index" to cmd.index.toString(), "query" to cmd.query)
            )
            is VoiceCommand.ClickWhatsAppContact -> build(
                AllowedActionType.CLICK_WHATSAPP_CONTACT,
                buildMap {
                    if (cmd.contactName.isNotBlank()) put("contact_name", cmd.contactName)
                    cmd.index?.let { put("index", it.toString()) }
                }
            )
            is VoiceCommand.OpenWhatsAppChat -> build(
                AllowedActionType.OPEN_WHATSAPP_CHAT,
                buildMap {
                    if (cmd.contactName.isNotBlank()) put("contact_name", cmd.contactName)
                    cmd.index?.let { put("index", it.toString()) }
                }
            )
            is VoiceCommand.TypeWhatsAppMessage -> build(
                AllowedActionType.TYPE_WHATSAPP_MESSAGE,
                mapOf("recipient" to cmd.recipient, "message" to cmd.message)
            )
            is VoiceCommand.PrepareWhatsAppMessage -> build(
                AllowedActionType.SEND_WHATSAPP_MESSAGE,
                mapOf("recipient" to cmd.recipient, "message" to cmd.message)
            )
            is VoiceCommand.VerifyWhatsAppSend -> build(
                AllowedActionType.VERIFY_WHATSAPP_SEND,
                mapOf("recipient" to cmd.recipient, "message" to cmd.message)
            )
            is VoiceCommand.SendSms -> build(
                AllowedActionType.PREPARE_SMS,
                mapOf("recipient" to cmd.recipient, "message" to cmd.message)
            )
            is VoiceCommand.CallContact -> build(AllowedActionType.CALL_CONTACT, mapOf("recipient" to cmd.contactName))
            is VoiceCommand.CallDirectNumber -> build(AllowedActionType.CALL_CONTACT, mapOf("phone_number" to cmd.phoneNumber))
            is VoiceCommand.AnswerIncomingCall -> build(AllowedActionType.ANSWER_INCOMING_CALL)
            is VoiceCommand.RejectIncomingCall -> build(AllowedActionType.REJECT_INCOMING_CALL)
            is VoiceCommand.EndActiveCall -> build(AllowedActionType.END_ACTIVE_CALL)
            is VoiceCommand.ToggleFlashlight -> build(AllowedActionType.FLASHLIGHT_CONTROL, mapOf("enable" to cmd.enable.toString()))
            is VoiceCommand.OpenSettings -> build(AllowedActionType.OPEN_SYSTEM_SETTINGS, mapOf("target" to cmd.label))
            else -> null
        }
    }

    fun updateAffectionName(newName: String) {
        val clean = newName.trim().ifEmpty { return }
        viewModelScope.launch {
            preferences.setAffectionName(clean)
        }
        val lang = _uiState.value.settings.activeLanguage
        val confirm = when (lang) {
            SupportedLanguage.BENGALI -> "ঠিক আছে! এখন থেকে আমি আপনাকে সবসময় \"$clean\" বলে ডাকব ❤️"
            SupportedLanguage.HINDI -> "Theek hai! Ab se main aapko hamesha \"$clean\" keh kar pukaarungi ❤️"
            SupportedLanguage.ENGLISH -> "Understood! From now on, I will always lovingly call you \"$clean\" ❤️"
        }
        appendMessage(MessageRole.ASSISTANT, confirm, lang)
        _uiState.update { it.copy(latestTranscript = confirm) }
        liveClient.sendConfigUpdate(affectionName = clean)
    }

    fun selectLanguage(
        newLang: SupportedLanguage,
        customConfirmation: String? = null,
        sendVoiceDirective: Boolean = true
    ) {
        viewModelScope.launch {
            preferences.setLanguage(newLang)
        }
        val name = _uiState.value.settings.selectedAffectionName
        val confirm = customConfirmation ?: when (newLang) {
            SupportedLanguage.BENGALI -> "ঠিক আছে $name! এখন থেকে আমি সবসময় মিষ্টি বাংলায় কথা বলব ❤️"
            SupportedLanguage.HINDI -> "Theek hai $name! Ab se main aapke saath Hindi mein baat karungi ❤️"
            SupportedLanguage.ENGLISH -> "Understood $name! I'll speak with you in English from now on ❤️"
        }
        _uiState.update { it.copy(latestTranscript = confirm) }
        liveClient.sendConfigUpdate(lang = newLang)
        if (sendVoiceDirective && _uiState.value.settings.voiceAutoPlay && !_uiState.value.settings.voiceMuted) {
            liveClient.sendClientText("[System directive: Language is now ${newLang.displayLabel}. Warmly confirm in 1 short sentence to $name.]")
        }
    }

    fun selectMode(mode: CompanionMode) {
        viewModelScope.launch {
            preferences.setMode(mode)
        }
        val confirm = "${mode.title} সক্রিয় করা হয়েছে। ${mode.subtitleBengali}"
        _uiState.update { it.copy(latestTranscript = confirm) }
        liveClient.sendConfigUpdate(mode = mode)
    }

    fun selectVoice(voice: VoiceProfile) {
        viewModelScope.launch {
            preferences.setVoice(voice)
        }
        val s = _uiState.value.settings
        _uiState.update { it.copy(latestTranscript = "${voice.id} ভয়েস সক্রিয় করা হয়েছে।") }
        audioEngine.stopAllPlayback()
        val apiKey = preferences.getGeminiApiKey()
        if (apiKey.isNotBlank()) {
            liveClient.connect(
                apiKey = apiKey,
                mode = s.activeMode,
                affectionName = s.selectedAffectionName,
                voice = voice,
                language = s.activeLanguage,
                forceReconnect = true
            )
        }
    }

    fun toggleAutoPlay() {
        val next = !_uiState.value.settings.voiceAutoPlay
        viewModelScope.launch { preferences.setVoiceAutoPlay(next) }
    }

    fun toggleVoiceMute() {
        val next = !_uiState.value.settings.voiceMuted
        audioEngine.isVoiceMuted = next
        if (next) audioEngine.stopAllPlayback()
        viewModelScope.launch { preferences.setVoiceMuted(next) }
    }

    fun saveGeminiApiKey(rawKey: String): Boolean {
        val saved = preferences.saveGeminiApiKey(rawKey)
        if (!saved) return false
        val s = _uiState.value.settings
        val cleanKey = preferences.getGeminiApiKey()
        _uiState.update {
            it.copy(
                geminiKeyConfigured = true,
                geminiKeyMasked = preferences.getMaskedGeminiApiKeyPreview(),
                isKeystoreBacked = preferences.isKeystoreBacked(),
                latestTranscript = "Gemini API Key saved securely. Connecting directly to Google Gemini Live..."
            )
        }
        if (cleanKey.isNotBlank()) {
            liveClient.connect(
                apiKey = cleanKey,
                mode = s.activeMode,
                affectionName = s.selectedAffectionName,
                voice = s.selectedVoice,
                language = s.activeLanguage,
                forceReconnect = true
            )
        }
        return true
    }

    fun deleteGeminiApiKey() {
        stopLiveVoice()
        liveClient.disconnect(clearApiKey = true)
        preferences.deleteGeminiApiKey()
        _uiState.update {
            it.copy(
                geminiKeyConfigured = false,
                geminiKeyMasked = null,
                wsStatus = WsConnectionStatus.DISCONNECTED,
                assistantState = AssistantState.IDLE,
                latestTranscript = "Saved Gemini API Key deleted. Add your own Gemini API Key in Setup or Settings to resume AI chat and voice."
            )
        }
    }

    fun replayAssistantText(text: String) {
        audioEngine.stopAllPlayback()
        _uiState.update { it.copy(assistantState = AssistantState.SPEAKING) }
        liveClient.sendClientText(
            "[System directive: Replay this response in ${_uiState.value.settings.activeLanguage.code} using your Gemini Live voice: \"$text\"]"
        )
    }

    fun clearMessages() {
        _uiState.update { it.copy(messages = emptyList()) }
        viewModelScope.launch {
            localMemoryRepository.clearConversationHistory()
        }
    }

    fun clearLongTermMemory() {
        viewModelScope.launch {
            localMemoryRepository.clearLongTermMemory()
        }
    }

    // Native Hardware Actions exposed to Android Hardware Hub
    fun toggleTorch(): Boolean = hardware.setFlashlight(!_uiState.value.isTorchOn)
    fun vibrateDevice(): Boolean = hardware.vibrate(250L)
    fun placeCall(number: String): Boolean = hardware.placePhoneCall(number)
    fun sendSms(number: String, body: String): Boolean = hardware.sendSms(number, body)
    fun openWhatsApp(number: String, body: String): Boolean = hardware.openWhatsApp(number, body)
    fun launchApp(query: String): Boolean = hardware.launchInstalledApp(query)
    fun openSystemSettings(target: String): Boolean = hardware.openSystemSettings(target)

    fun toggleFloatingOrb(): Boolean {
        val currentlyRunning = FloatingOrbService.isRunning
        val result = if (currentlyRunning) {
            FloatingOrbService.stop(app)
            true
        } else {
            FloatingOrbService.start(app)
        }
        _uiState.update { it.copy(isFloatingOrbRunning = FloatingOrbService.isRunning) }
        return result
    }

    private fun appendMessage(role: MessageRole, text: String, lang: SupportedLanguage) {
        val now = System.currentTimeMillis()
        val msgId = "msg-$now-${UUID.randomUUID().toString().take(6)}"
        _uiState.update { state ->
            state.copy(
                messages = state.messages + ChatMessage(
                    id = msgId,
                    role = role,
                    text = text,
                    lang = lang,
                    timestampMillis = now
                )
            )
        }
        viewModelScope.launch {
            localMemoryRepository.saveMessage(
                role = if (role == MessageRole.USER) "user" else "assistant",
                text = text,
                language = lang.code,
                id = msgId,
                createdAtMs = now
            )
        }
    }

    override fun onCleared() {
        networkMonitor.stop()
        audioEngine.release()
        liveClient.disconnect()
        super.onCleared()
    }
}
