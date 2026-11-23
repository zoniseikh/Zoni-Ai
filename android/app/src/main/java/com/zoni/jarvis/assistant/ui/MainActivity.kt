package com.zoni.jarvis.assistant.ui

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.webkit.MimeTypeMap
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.lifecycle.lifecycleScope
import androidx.webkit.WebViewAssetLoader
import com.zoni.jarvis.assistant.BuildConfig
import com.zoni.jarvis.assistant.bridge.ZoniWebAppInterface
import com.zoni.jarvis.assistant.calling.SimCallManager
import com.zoni.jarvis.assistant.calling.ZoniInCallService
import com.zoni.jarvis.assistant.data.SecureKeyManager
import com.zoni.jarvis.assistant.data.ZoniUserSettings
import com.zoni.jarvis.assistant.hardware.AndroidHardwareController
import com.zoni.jarvis.assistant.service.ScreenCaptureService
import com.zoni.jarvis.assistant.service.ZoniForegroundService
import com.zoni.jarvis.assistant.ui.components.AndroidHardwareHubDialog
import com.zoni.jarvis.assistant.ui.components.ArcReactorView
import com.zoni.jarvis.assistant.ui.components.ChatTranscriptDialog
import com.zoni.jarvis.assistant.ui.components.ControlDockBar
import com.zoni.jarvis.assistant.ui.components.HudHeaderBar
import com.zoni.jarvis.assistant.ui.components.ZoniSettingsDialog
import com.zoni.jarvis.assistant.ui.onboarding.OnboardingActivity
import com.zoni.jarvis.assistant.ui.theme.ZoniColors
import com.zoni.jarvis.assistant.ui.theme.ZoniTheme
import kotlinx.coroutines.launch
import org.json.JSONObject

/**
 * Main Android Activity for Zoni AI (`com.zoni.jarvis.assistant`).
 *
 * RULE #1 & #3 Architecture:
 * - Preserves the EXACT original Zoni AI React/Vite Sci-Fi JARVIS Dashboard as the primary UI,
 *   packaged inside `assets/public/` and served securely via `WebViewAssetLoader`
 *   (`https://appassets.androidplatform.net/assets/public/index.html`).
 * - Exposes full native Android hardware, Contacts, SIM Telecom calling, Incoming Call Control,
 *   On-Device Wake Word, Transparent Background Listening, Room DB history, Floating Orb,
 *   and Foreground Service through `window.ZoniAndroidBridge`.
 * - Detects WebView renderer termination (`onRenderProcessGone`) and recovers cleanly instead of
 *   leaving a blank screen.
 * - Gracefully falls back to the synchronized Jetpack Compose HUD if bundled web assets
 *   are not yet synced during local Kotlin-only testing.
 */
class MainActivity : ComponentActivity() {

    private val viewModel: MainViewModel by viewModels()
    private lateinit var hardwareController: AndroidHardwareController
    private lateinit var simCallManager: SimCallManager
    private lateinit var keyManager: SecureKeyManager
    private var dashboardWebView: WebView? = null
    private var pendingWebPermissionRequest: PermissionRequest? = null
    private var pendingWakePayloadJson: String? = null
    private var webViewReloadEpoch = mutableIntStateOf(0)

    private val micPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        viewModel.refreshSystemStatus()
        pendingWebPermissionRequest?.let { req ->
            if (granted) req.grant(req.resources) else req.deny()
            pendingWebPermissionRequest = null
        }
        dispatchNativeEvent("zoni:native-permissions-updated", "{}")
        dispatchNativeEvent(
            "zoni:wake-word-status",
            ZoniForegroundService.getCurrentStatusSnapshot(applicationContext).toJson()
        )
        if (granted && !hasBundledReactDashboard()) {
            viewModel.startLiveVoice()
        }
    }

    private val multiPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) {
        viewModel.refreshSystemStatus()
        simCallManager.startCallStateMonitoring { callJson ->
            dispatchNativeEvent("zoni:call-state-changed", callJson)
        }
        dispatchNativeEvent("zoni:native-permissions-updated", "{}")
        dispatchNativeEvent(
            "zoni:wake-word-status",
            ZoniForegroundService.getCurrentStatusSnapshot(applicationContext).toJson()
        )
        dispatchNativeEvent("zoni:call-state-changed", simCallManager.getIncomingCallStatusAsJson())
    }

    private val screenCaptureConsentLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val data = result.data
        if (result.resultCode == Activity.RESULT_OK && data != null) {
            ScreenCaptureService.startWithConsent(applicationContext, result.resultCode, data)
            dispatchNativeEvent("zoni:screen-capture-changed", JSONObject().put("active", true).toString())
        } else {
            dispatchNativeEvent("zoni:screen-capture-changed", JSONObject().put("active", false).toString())
        }
    }

    private val defaultAssistantRoleLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) {
        viewModel.refreshSystemStatus()
        val isDefault = hardwareController.isDefaultDigitalAssistant()
        dispatchNativeEvent("zoni:native-permissions-updated", "{}")
        dispatchNativeEvent(
            "zoni:default-assistant-changed",
            JSONObject().put("isDefault", isDefault).put("active", isDefault).toString()
        )
    }

    private val dialerRoleLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) {
        viewModel.refreshSystemStatus()
        dispatchNativeEvent("zoni:native-permissions-updated", "{}")
        dispatchNativeEvent("zoni:call-state-changed", simCallManager.getIncomingCallStatusAsJson())
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        installSplashScreen()
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        hardwareController = AndroidHardwareController(applicationContext)
        simCallManager = SimCallManager(applicationContext)
        keyManager = SecureKeyManager(applicationContext)

        simCallManager.startCallStateMonitoring { callJson ->
            dispatchNativeEvent("zoni:call-state-changed", callJson)
        }
        observeNativeLifecycleStreams()

        // Back button navigates inside the original Zoni React dashboard before exiting
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                val wv = dashboardWebView
                if (wv != null && wv.canGoBack()) {
                    wv.goBack()
                } else {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                }
            }
        })

        handleLaunchIntent(intent)

        val useBundledOriginalDashboard = hasBundledReactDashboard()

        setContent {
            ZoniTheme {
                if (useBundledOriginalDashboard) {
                    val reloadKey = webViewReloadEpoch.intValue
                    key(reloadKey) {
                        OriginalDashboardWebShell()
                    }
                } else {
                    NativeComposeFallbackHud()
                }
            }
        }
    }

    private fun observeNativeLifecycleStreams() {
        lifecycleScope.launch {
            ZoniForegroundService.statusFlow.collect { snap ->
                val json = snap.toJson()
                dispatchNativeEvent("zoni:wake-word-status", json)
                dispatchNativeEvent(
                    "zoni:voice-state-changed",
                    JSONObject().put("voiceState", snap.voiceState.name).toString()
                )
            }
        }
        lifecycleScope.launch {
            ZoniForegroundService.wakeWordEvents.collect { event ->
                val payload = JSONObject()
                    .put("wakePhrase", event.wakePhrase)
                    .put("matchedVariant", event.matchedVariant)
                    .put("confidence", event.confidence.toDouble())
                    .put("remainingCommand", event.remainingCommand)
                    .put("detectedAtMs", event.detectedAtMs)
                    .toString()
                dispatchNativeEvent("zoni:wake-word-detected", payload)
            }
        }
        lifecycleScope.launch {
            ZoniInCallService.simCallState.collect {
                dispatchNativeEvent("zoni:call-state-changed", simCallManager.getIncomingCallStatusAsJson())
            }
        }
    }

    private fun dispatchNativeEvent(eventName: String, jsonDetail: String) {
        val wv = dashboardWebView ?: return
        val safeDetail = jsonDetail.ifBlank { "{}" }
        val js = "(function(){ try { window.dispatchEvent(new CustomEvent(${JSONObject.quote(eventName)}, { detail: $safeDetail })); } catch(e) {} })();"
        wv.post {
            try {
                wv.evaluateJavascript(js, null)
            } catch (_: Exception) {
            }
        }
    }

    private fun hasBundledReactDashboard(): Boolean {
        return try {
            assets.open("public/index.html").use { true }
        } catch (_: Exception) {
            false
        }
    }

    private fun resolveMimeType(assetPath: String): String {
        val ext = assetPath.substringAfterLast('.', "").lowercase()
        return when (ext) {
            "html", "htm" -> "text/html"
            "js", "mjs" -> "application/javascript"
            "css" -> "text/css"
            "json", "webmanifest" -> "application/json"
            "svg" -> "image/svg+xml"
            "png" -> "image/png"
            "jpg", "jpeg" -> "image/jpeg"
            "webp" -> "image/webp"
            "ico" -> "image/x-icon"
            "woff2" -> "font/woff2"
            "woff" -> "font/woff"
            else -> MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext) ?: "application/octet-stream"
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    @androidx.compose.runtime.Composable
    private fun OriginalDashboardWebShell() {
        val assetLoader = remember {
            val publicAssetsHandler = WebViewAssetLoader.PathHandler { rawPath ->
                val clean = rawPath.trimStart('/')
                if (clean.contains("..")) return@PathHandler null
                val target = if (clean.isEmpty()) "index.html" else clean
                val assetFullPath = "public/$target"
                try {
                    val stream = assets.open(assetFullPath)
                    WebResourceResponse(resolveMimeType(target), "UTF-8", stream)
                } catch (_: Exception) {
                    // SPA route fallback for extensionless client routes
                    if (!target.contains('.')) {
                        try {
                            WebResourceResponse("text/html", "UTF-8", assets.open("public/index.html"))
                        } catch (_: Exception) {
                            null
                        }
                    } else {
                        null
                    }
                }
            }
            WebViewAssetLoader.Builder()
                .addPathHandler("/", publicAssetsHandler)
                .build()
        }

        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(ZoniColors.Slate950)
                .safeDrawingPadding()
                .imePadding()
        ) {
            AndroidView(
                modifier = Modifier.fillMaxSize(),
                factory = { ctx ->
                    WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
                    WebView(ctx).apply {
                        setBackgroundColor(android.graphics.Color.parseColor("#020617"))
                        settings.javaScriptEnabled = true
                        settings.domStorageEnabled = true
                        settings.databaseEnabled = true
                        settings.useWideViewPort = true
                        settings.loadWithOverviewMode = true
                        settings.setSupportZoom(false)
                        settings.builtInZoomControls = false
                        settings.displayZoomControls = false
                        settings.mediaPlaybackRequiresUserGesture = false
                        settings.allowFileAccess = false
                        settings.allowContentAccess = false
                        @Suppress("DEPRECATION")
                        settings.allowFileAccessFromFileURLs = false
                        @Suppress("DEPRECATION")
                        settings.allowUniversalAccessFromFileURLs = false
                        settings.mixedContentMode = if (BuildConfig.DEBUG) {
                            WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
                        } else {
                            WebSettings.MIXED_CONTENT_NEVER_ALLOW
                        }

                        addJavascriptInterface(
                            ZoniWebAppInterface(
                                context = applicationContext,
                                hardware = hardwareController,
                                simCallManager = simCallManager,
                                keyManager = keyManager,
                                onRequestRuntimePermissions = { perms ->
                                    runOnUiThread {
                                        if (perms.isNotEmpty()) {
                                            multiPermissionLauncher.launch(perms)
                                        }
                                    }
                                },
                                onRequestScreenCaptureConsent = {
                                    runOnUiThread {
                                        val mgr = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as? MediaProjectionManager
                                        if (mgr != null) {
                                            screenCaptureConsentLauncher.launch(mgr.createScreenCaptureIntent())
                                        }
                                    }
                                },
                                onRequestDefaultAssistant = {
                                    runOnUiThread {
                                        try {
                                            val roleIntent = hardwareController.createDefaultAssistantRoleIntent()
                                            defaultAssistantRoleLauncher.launch(roleIntent)
                                        } catch (_: Exception) {
                                            hardwareController.openSystemSettings("default_assistant")
                                        }
                                    }
                                },
                                onRequestCallControlRole = {
                                    runOnUiThread {
                                        try {
                                            val roleIntent = simCallManager.createDialerRoleRequestIntent()
                                            if (roleIntent != null) {
                                                dialerRoleLauncher.launch(roleIntent)
                                            } else {
                                                hardwareController.openSystemSettings("applications")
                                            }
                                        } catch (_: Exception) {
                                            hardwareController.openSystemSettings("applications")
                                        }
                                    }
                                }
                            ),
                            "ZoniAndroidBridge"
                        )

                        webViewClient = object : WebViewClient() {
                            override fun shouldInterceptRequest(
                                view: WebView?,
                                request: WebResourceRequest
                            ): WebResourceResponse? {
                                return assetLoader.shouldInterceptRequest(request.url)
                            }

                            override fun onRenderProcessGone(
                                view: WebView?,
                                detail: RenderProcessGoneDetail?
                            ): Boolean {
                                val didCrash = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                                    detail?.didCrash() == true
                                } else {
                                    true
                                }
                                Log.e(TAG, "WebView render process terminated (didCrash=$didCrash) — recovering cleanly.")
                                runOnUiThread {
                                    if (dashboardWebView == view) {
                                        dashboardWebView = null
                                    }
                                    try {
                                        view?.destroy()
                                    } catch (_: Exception) {
                                    }
                                    // Trigger Compose recreation of a fresh WebView instance instead of leaving a blank screen
                                    webViewReloadEpoch.intValue += 1
                                }
                                return true
                            }

                            override fun onPageFinished(view: WebView?, url: String?) {
                                super.onPageFinished(view, url)
                                val savedBackend = keyManager.getBackendUrl().trim()
                                val hasValidBackend = ZoniUserSettings.isValidProductionBackendUrl(savedBackend)
                                val quotedBackendUrl = JSONObject.quote(if (hasValidBackend) savedBackend else ZoniUserSettings.DEFAULT_BACKEND_URL)
                                view?.evaluateJavascript(
                                    "(function(){ " +
                                        "window.__ZONI_ANDROID_NATIVE__ = true; " +
                                        "var cur = (localStorage.getItem('zoni_backend_url') || '').trim(); " +
                                        "var stale = !cur || cur.indexOf('ais-pre-') !== -1 || cur.indexOf('appassets.androidplatform.net') !== -1 || cur.indexOf('://localhost') !== -1 || cur.indexOf('://127.0.0.1') !== -1; " +
                                        "if (stale && $quotedBackendUrl) { " +
                                        "localStorage.setItem('zoni_backend_url', $quotedBackendUrl); " +
                                        "if (cur !== $quotedBackendUrl) { window.dispatchEvent(new CustomEvent('zoni:backend-url-updated')); } " +
                                        "} })();",
                                    null
                                )
                                // Push fresh native wake-word & call status on initial load
                                dispatchNativeEvent(
                                    "zoni:wake-word-status",
                                    ZoniForegroundService.getCurrentStatusSnapshot(applicationContext).toJson()
                                )
                                dispatchNativeEvent("zoni:call-state-changed", simCallManager.getIncomingCallStatusAsJson())

                                val pendingWake = pendingWakePayloadJson
                                if (pendingWake != null) {
                                    pendingWakePayloadJson = null
                                    dispatchNativeEvent("zoni:wake-word-detected", pendingWake)
                                }
                            }
                        }

                        webChromeClient = object : WebChromeClient() {
                            override fun onPermissionRequest(request: PermissionRequest) {
                                runOnUiThread {
                                    val originHost = request.origin?.host
                                    if (originHost != "appassets.androidplatform.net") {
                                        request.deny()
                                        return@runOnUiThread
                                    }
                                    val needsAudio = request.resources.contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE)
                                    val hasMic = ContextCompat.checkSelfPermission(
                                        this@MainActivity,
                                        Manifest.permission.RECORD_AUDIO
                                    ) == PackageManager.PERMISSION_GRANTED

                                    if (!needsAudio || hasMic) {
                                        request.grant(request.resources)
                                    } else {
                                        pendingWebPermissionRequest = request
                                        micPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
                                    }
                                }
                            }
                        }

                        val startUrl = "https://appassets.androidplatform.net/index.html"
                        loadUrl(startUrl)
                        dashboardWebView = this
                    }
                }
            )
        }
    }

    @androidx.compose.runtime.Composable
    private fun NativeComposeFallbackHud() {
        val uiState by viewModel.uiState.collectAsState()
        var showSettings by remember { mutableStateOf(false) }
        var showHardwareHub by remember { mutableStateOf(false) }
        var showTranscript by remember { mutableStateOf(false) }

        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(
                    Brush.verticalGradient(
                        colors = listOf(ZoniColors.Slate950, ZoniColors.Slate900, ZoniColors.Slate950)
                    )
                )
                .safeDrawingPadding()
        ) {
            Column(
                modifier = Modifier.fillMaxSize(),
                verticalArrangement = Arrangement.SpaceBetween,
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                HudHeaderBar(
                    uiState = uiState,
                    onSelectLanguage = { viewModel.selectLanguage(it) },
                    onToggleAutoPlay = { viewModel.toggleAutoPlay() },
                    onToggleVoiceMute = { viewModel.toggleVoiceMute() },
                    onOpenPermissions = {
                        startActivity(Intent(this@MainActivity, OnboardingActivity::class.java))
                    },
                    onOpenHardwareHub = {
                        viewModel.refreshSystemStatus()
                        showHardwareHub = true
                    },
                    onOpenSettings = { showSettings = true },
                    onOpenTranscript = { showTranscript = true }
                )

                ArcReactorView(
                    state = uiState.assistantState,
                    mode = uiState.settings.activeMode,
                    selectedAffectionName = uiState.settings.selectedAffectionName,
                    isLiveActive = uiState.isLiveActive,
                    latestTranscript = uiState.latestTranscript,
                    audioAmplitude = uiState.audioAmplitude,
                    onReactorClick = {
                        if (!uiState.isLiveActive) {
                            triggerVoiceStartWithPermission()
                        } else {
                            viewModel.interruptSpeech()
                        }
                    }
                )

                ControlDockBar(
                    state = uiState.assistantState,
                    isLiveActive = uiState.isLiveActive,
                    isMicMuted = uiState.isMicMuted,
                    onToggleLiveMode = {
                        if (uiState.isLiveActive) {
                            viewModel.stopLiveVoice()
                        } else {
                            triggerVoiceStartWithPermission()
                        }
                    },
                    onToggleMicMute = { viewModel.toggleMicMute() },
                    onInterrupt = { viewModel.interruptSpeech() },
                    onSendMessage = { viewModel.sendTextMessage(it) }
                )
            }

            if (showSettings) {
                ZoniSettingsDialog(
                    uiState = uiState,
                    onDismiss = { showSettings = false },
                    onUpdateAffectionName = { viewModel.updateAffectionName(it) },
                    onSelectMode = { viewModel.selectMode(it) },
                    onSelectVoice = { viewModel.selectVoice(it) },
                    onUpdateBackendUrl = { viewModel.updateBackendUrl(it) }
                )
            }

            if (showHardwareHub) {
                AndroidHardwareHubDialog(
                    uiState = uiState,
                    onDismiss = { showHardwareHub = false },
                    onToggleTorch = { viewModel.toggleTorch() },
                    onVibrate = { viewModel.vibrateDevice() },
                    onCall = { viewModel.placeCall(it) },
                    onSms = { num, msg -> viewModel.sendSms(num, msg) },
                    onWhatsApp = { num, msg -> viewModel.openWhatsApp(num, msg) },
                    onToggleFloatingOrb = {
                        if (!viewModel.toggleFloatingOrb()) {
                            viewModel.openSystemSettings("overlay")
                        }
                    },
                    onOpenSettingsTarget = { viewModel.openSystemSettings(it) }
                )
            }

            if (showTranscript) {
                ChatTranscriptDialog(
                    messages = uiState.messages,
                    affectionName = uiState.settings.selectedAffectionName,
                    onDismiss = { showTranscript = false },
                    onReplay = { viewModel.replayAssistantText(it) },
                    onClear = { viewModel.clearMessages() }
                )
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleLaunchIntent(intent)
    }

    override fun onResume() {
        super.onResume()
        isActivityInForeground = true
        ZoniForegroundService.cancelWakeActivationNotification(applicationContext)
        viewModel.refreshSystemStatus()
        simCallManager.startCallStateMonitoring { callJson ->
            dispatchNativeEvent("zoni:call-state-changed", callJson)
        }
        dispatchNativeEvent(
            "zoni:wake-word-status",
            ZoniForegroundService.getCurrentStatusSnapshot(applicationContext).toJson()
        )
        dispatchNativeEvent("zoni:call-state-changed", simCallManager.getIncomingCallStatusAsJson())
    }

    override fun onPause() {
        isActivityInForeground = false
        super.onPause()
    }

    override fun onDestroy() {
        simCallManager.stopCallStateMonitoring()
        try {
            dashboardWebView?.destroy()
        } catch (_: Exception) {
        }
        dashboardWebView = null
        super.onDestroy()
    }

    private fun handleLaunchIntent(intent: Intent?) {
        intent ?: return

        if (intent.getBooleanExtra(EXTRA_RESUME_WAKE_WORD, false)) {
            ZoniForegroundService.startWakeWordListening(applicationContext)
        }

        val wakeTriggered = intent.getBooleanExtra(EXTRA_WAKE_WORD_TRIGGERED, false)
        val remainingCmd = intent.getStringExtra(EXTRA_WAKE_REMAINING_COMMAND).orEmpty()
        val shouldAutoVoice = intent.action == Intent.ACTION_ASSIST ||
            intent.action == Intent.ACTION_VOICE_COMMAND ||
            intent.getBooleanExtra(EXTRA_AUTO_VOICE, false) ||
            wakeTriggered

        if (shouldAutoVoice) {
            if (hasBundledReactDashboard()) {
                val payload = JSONObject()
                    .put("wakePhrase", "Zoni")
                    .put("matchedVariant", if (wakeTriggered) "zoni" else "assist_intent")
                    .put("confidence", 1.0)
                    .put("remainingCommand", remainingCmd)
                    .put("detectedAtMs", System.currentTimeMillis())
                    .toString()
                if (dashboardWebView != null) {
                    dispatchNativeEvent("zoni:wake-word-detected", payload)
                } else {
                    pendingWakePayloadJson = payload
                }
            } else {
                triggerVoiceStartWithPermission()
                if (remainingCmd.isNotBlank()) {
                    viewModel.sendTextMessage(remainingCmd)
                }
            }
        }
    }

    private fun triggerVoiceStartWithPermission() {
        if (!viewModel.startLiveVoice()) {
            micPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
        }
    }

    companion object {
        private const val TAG = "ZoniMainActivity"
        @Volatile
        var isActivityInForeground: Boolean = false
            private set

        const val EXTRA_AUTO_VOICE = "extra_auto_voice"
        const val EXTRA_WAKE_WORD_TRIGGERED = "extra_wake_word_triggered"
        const val EXTRA_WAKE_REMAINING_COMMAND = "extra_wake_remaining_command"
        const val EXTRA_RESUME_WAKE_WORD = "extra_resume_wake_word"
    }
}
