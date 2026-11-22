package com.zoni.jarvis.assistant.ui

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.projection.MediaProjectionManager
import android.os.Bundle
import android.webkit.MimeTypeMap
import android.webkit.PermissionRequest
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
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.webkit.WebViewAssetLoader
import com.zoni.jarvis.assistant.BuildConfig
import com.zoni.jarvis.assistant.bridge.ZoniWebAppInterface
import com.zoni.jarvis.assistant.calling.SimCallManager
import com.zoni.jarvis.assistant.data.SecureKeyManager
import com.zoni.jarvis.assistant.data.ZoniUserSettings
import com.zoni.jarvis.assistant.hardware.AndroidHardwareController
import com.zoni.jarvis.assistant.service.ScreenCaptureService
import com.zoni.jarvis.assistant.ui.components.AndroidHardwareHubDialog
import com.zoni.jarvis.assistant.ui.components.ArcReactorView
import com.zoni.jarvis.assistant.ui.components.ChatTranscriptDialog
import com.zoni.jarvis.assistant.ui.components.ControlDockBar
import com.zoni.jarvis.assistant.ui.components.HudHeaderBar
import com.zoni.jarvis.assistant.ui.components.ZoniSettingsDialog
import com.zoni.jarvis.assistant.ui.onboarding.OnboardingActivity
import com.zoni.jarvis.assistant.ui.theme.ZoniColors
import com.zoni.jarvis.assistant.ui.theme.ZoniTheme
import org.json.JSONObject

/**
 * Main Android Activity for Zoni AI (`com.zoni.jarvis.assistant`).
 *
 * RULE #1 & #3 Architecture:
 * - Preserves the EXACT original Zoni AI React/Vite Sci-Fi JARVIS Dashboard as the primary UI,
 *   packaged inside `assets/public/` and served securely via `WebViewAssetLoader`
 *   (`https://appassets.androidplatform.net/assets/public/index.html`).
 * - Exposes full native Android hardware, Contacts, SIM Telecom calling,
 *   Room DB history, Floating Orb, and Foreground Service through `window.ZoniAndroidBridge`.
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

    private val micPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        viewModel.refreshSystemStatus()
        pendingWebPermissionRequest?.let { req ->
            if (granted) req.grant(req.resources) else req.deny()
            pendingWebPermissionRequest = null
        }
        if (granted && !hasBundledReactDashboard()) {
            viewModel.startLiveVoice()
        }
    }

    private val multiPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) {
        viewModel.refreshSystemStatus()
        dashboardWebView?.post {
            dashboardWebView?.evaluateJavascript(
                "window.dispatchEvent(new CustomEvent('zoni:native-permissions-updated'));",
                null
            )
        }
    }

    private val screenCaptureConsentLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val data = result.data
        if (result.resultCode == Activity.RESULT_OK && data != null) {
            ScreenCaptureService.startWithConsent(applicationContext, result.resultCode, data)
            dashboardWebView?.post {
                dashboardWebView?.evaluateJavascript(
                    "window.dispatchEvent(new CustomEvent('zoni:screen-capture-changed', { detail: { active: true } }));",
                    null
                )
            }
        } else {
            dashboardWebView?.post {
                dashboardWebView?.evaluateJavascript(
                    "window.dispatchEvent(new CustomEvent('zoni:screen-capture-changed', { detail: { active: false } }));",
                    null
                )
            }
        }
    }

    private val defaultAssistantRoleLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) {
        viewModel.refreshSystemStatus()
        val isDefault = hardwareController.isDefaultDigitalAssistant()
        dashboardWebView?.post {
            dashboardWebView?.evaluateJavascript(
                "window.dispatchEvent(new CustomEvent('zoni:native-permissions-updated'));" +
                    "window.dispatchEvent(new CustomEvent('zoni:default-assistant-changed', { detail: { isDefault: $isDefault } }));",
                null
            )
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        installSplashScreen()
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        hardwareController = AndroidHardwareController(applicationContext)
        simCallManager = SimCallManager(applicationContext)
        keyManager = SecureKeyManager(applicationContext)

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
                    OriginalDashboardWebShell()
                } else {
                    NativeComposeFallbackHud()
                }
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
        handleLaunchIntent(intent)
    }

    override fun onResume() {
        super.onResume()
        viewModel.refreshSystemStatus()
    }

    override fun onDestroy() {
        dashboardWebView?.destroy()
        dashboardWebView = null
        super.onDestroy()
    }

    private fun handleLaunchIntent(intent: Intent?) {
        intent ?: return
        val shouldAutoVoice = intent.action == Intent.ACTION_ASSIST ||
            intent.action == Intent.ACTION_VOICE_COMMAND ||
            intent.getBooleanExtra(EXTRA_AUTO_VOICE, false)
        if (shouldAutoVoice && !hasBundledReactDashboard()) {
            triggerVoiceStartWithPermission()
        }
    }

    private fun triggerVoiceStartWithPermission() {
        if (!viewModel.startLiveVoice()) {
            micPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
        }
    }

    companion object {
        const val EXTRA_AUTO_VOICE = "extra_auto_voice"
    }
}
