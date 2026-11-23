package com.zoni.jarvis.assistant.ui.onboarding

import android.Manifest
import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.lifecycleScope
import com.zoni.jarvis.assistant.ZoniApplication
import com.zoni.jarvis.assistant.data.SecureKeyManager
import com.zoni.jarvis.assistant.hardware.AndroidPermissionsSnapshot
import com.zoni.jarvis.assistant.ui.theme.ZoniColors
import com.zoni.jarvis.assistant.ui.theme.ZoniTheme
import kotlinx.coroutines.launch

/**
 * Genuine 3-Step Native Android Setup Wizard aligned with PermissionsSetupModal.tsx:
 * - Step 1: User's Own Gemini API Key (BYOK, stored encrypted via Android Keystore)
 * - Step 2: Real Android Runtime Permissions (RECORD_AUDIO required + optional phone permissions)
 * - Step 3: Real Android Background Availability System Screens (Battery, Overlay, Notification Listener, Accessibility, Default Assistant)
 */
class OnboardingActivity : ComponentActivity() {

    private lateinit var app: ZoniApplication
    private lateinit var keyManager: SecureKeyManager
    private var permissionsState by mutableStateOf<AndroidPermissionsSnapshot?>(null)
    private var maskedKeyState by mutableStateOf<String?>(null)
    private var keystoreBackedState by mutableStateOf(false)

    private val requestPermissionsLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) {
        permissionsState = app.hardwareController.getPermissionsSnapshot()
    }

    private val requestDefaultAssistantLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) {
        permissionsState = app.hardwareController.getPermissionsSnapshot()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        app = application as ZoniApplication
        keyManager = SecureKeyManager(applicationContext)
        permissionsState = app.hardwareController.getPermissionsSnapshot()
        maskedKeyState = keyManager.getMaskedApiKeyPreview()
        keystoreBackedState = keyManager.isUsingAndroidKeystore()

        setContent {
            ZoniTheme {
                OnboardingScreen(
                    maskedSavedKey = maskedKeyState,
                    isKeystoreBacked = keystoreBackedState,
                    permissions = permissionsState ?: app.hardwareController.getPermissionsSnapshot(),
                    onReadClipboard = {
                        val cm = getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
                        cm?.primaryClip?.getItemAt(0)?.text?.toString()?.trim().orEmpty()
                    },
                    onSaveGeminiApiKey = { rawKey ->
                        val validation = SecureKeyManager.validateApiKeyFormat(rawKey)
                        if (!validation.valid) {
                            validation.error ?: "Invalid Gemini API Key format."
                        } else if (keyManager.saveApiKey(validation.normalizedKey)) {
                            maskedKeyState = keyManager.getMaskedApiKeyPreview()
                            null
                        } else {
                            "Could not save Gemini API Key."
                        }
                    },
                    onDeleteGeminiApiKey = {
                        keyManager.deleteApiKey()
                        maskedKeyState = null
                    },
                    onRequestPermission = { perms ->
                        requestPermissionsLauncher.launch(perms)
                    },
                    onRequestAllPermissions = {
                        requestPermissionsLauncher.launch(buildAllRuntimePermissions())
                    },
                    onOpenSystemScreen = { target ->
                        if (target == "default_assistant") {
                            try {
                                requestDefaultAssistantLauncher.launch(app.hardwareController.createDefaultAssistantRoleIntent())
                            } catch (_: Exception) {
                                app.hardwareController.openSystemSettings(target)
                            }
                        } else {
                            app.hardwareController.openSystemSettings(target)
                        }
                    },
                    onFinish = {
                        lifecycleScope.launch {
                            app.preferences.setOnboardingCompleted(true)
                            keyManager.setOnboardingCompleted(true)
                            finish()
                        }
                    }
                )
            }
        }
    }

    override fun onResume() {
        super.onResume()
        permissionsState = app.hardwareController.getPermissionsSnapshot()
        maskedKeyState = keyManager.getMaskedApiKeyPreview()
    }

    private fun buildAllRuntimePermissions(): Array<String> {
        val list = mutableListOf(
            Manifest.permission.RECORD_AUDIO,
            Manifest.permission.CAMERA,
            Manifest.permission.CALL_PHONE,
            Manifest.permission.READ_CONTACTS,
            Manifest.permission.SEND_SMS,
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.READ_PHONE_STATE
        )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            list.add(Manifest.permission.ANSWER_PHONE_CALLS)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            list.add(Manifest.permission.BLUETOOTH_CONNECT)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            list.add(Manifest.permission.POST_NOTIFICATIONS)
            list.add(Manifest.permission.READ_MEDIA_IMAGES)
        }
        return list.toTypedArray()
    }
}

@Composable
private fun OnboardingScreen(
    maskedSavedKey: String?,
    isKeystoreBacked: Boolean,
    permissions: AndroidPermissionsSnapshot,
    onReadClipboard: () -> String,
    onSaveGeminiApiKey: (String) -> String?,
    onDeleteGeminiApiKey: () -> Unit,
    onRequestPermission: (Array<String>) -> Unit,
    onRequestAllPermissions: () -> Unit,
    onOpenSystemScreen: (String) -> Unit,
    onFinish: () -> Unit
) {
    var step by remember { mutableIntStateOf(1) }
    var apiKeyDraft by remember { mutableStateOf("") }
    var keyError by remember { mutableStateOf<String?>(null) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(ZoniColors.Slate950)
            .safeDrawingPadding()
            .padding(16.dp)
    ) {
        Text(
            text = "ZONI AI ANDROID SETUP — STEP $step OF 3",
            color = ZoniColors.Cyan300,
            fontSize = 15.sp,
            fontWeight = FontWeight.Black,
            letterSpacing = 1.sp
        )
        Spacer(Modifier.height(12.dp))

        Column(
            modifier = Modifier
                .weight(1f)
                .verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            when (step) {
                1 -> {
                    Text(
                        "Connect Your Gemini API Key",
                        color = ZoniColors.Cyan50,
                        fontSize = 20.sp,
                        fontWeight = FontWeight.Bold
                    )
                    Text(
                        "Zoni AI connects directly to Google Gemini using your own API key (BYOK). No custom backend URL is required. Your key is stored locally using ${if (isKeystoreBacked) "Android Keystore EncryptedSharedPreferences" else "Android private encrypted preferences"} and is never revealed after saving.",
                        color = ZoniColors.Slate400,
                        fontSize = 13.sp
                    )
                    if (!maskedSavedKey.isNullOrBlank()) {
                        Surface(
                            modifier = Modifier.fillMaxWidth(),
                            shape = RoundedCornerShape(12.dp),
                            color = ZoniColors.Emerald950,
                            border = BorderStroke(1.dp, ZoniColors.Emerald400.copy(alpha = 0.6f))
                        ) {
                            Column(modifier = Modifier.padding(12.dp)) {
                                Text(
                                    text = "SAVED KEY: $maskedSavedKey",
                                    color = ZoniColors.Emerald300,
                                    fontSize = 12.sp,
                                    fontWeight = FontWeight.Bold
                                )
                                Text(
                                    text = "Paste a new key below to replace it, or delete it at any time.",
                                    color = ZoniColors.Slate400,
                                    fontSize = 11.sp
                                )
                            }
                        }
                    }
                    OutlinedTextField(
                        value = apiKeyDraft,
                        onValueChange = {
                            apiKeyDraft = it
                            keyError = null
                        },
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true,
                        visualTransformation = PasswordVisualTransformation(),
                        label = { Text(if (maskedSavedKey != null) "Replace Gemini API Key (AIza...)" else "Gemini API Key (AIza...)") },
                        placeholder = { Text("AIzaSy...") },
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedBorderColor = ZoniColors.Cyan400,
                            unfocusedBorderColor = ZoniColors.Slate800,
                            focusedTextColor = ZoniColors.Cyan50,
                            unfocusedTextColor = ZoniColors.Cyan50
                        )
                    )
                    if (keyError != null) {
                        Text(
                            text = keyError ?: "",
                            color = ZoniColors.Rose400,
                            fontSize = 12.sp
                        )
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        OutlinedButton(onClick = {
                            apiKeyDraft = onReadClipboard()
                            keyError = null
                        }) {
                            Text("PASTE API KEY", color = ZoniColors.Pink300)
                        }
                        if (!maskedSavedKey.isNullOrBlank()) {
                            OutlinedButton(onClick = {
                                onDeleteGeminiApiKey()
                                apiKeyDraft = ""
                                keyError = null
                            }) {
                                Text("DELETE SAVED KEY", color = ZoniColors.Rose400)
                            }
                        }
                    }
                    Spacer(Modifier.height(10.dp))
                    Button(
                        onClick = {
                            if (apiKeyDraft.isBlank() && !maskedSavedKey.isNullOrBlank()) {
                                step = 2
                            } else {
                                val err = onSaveGeminiApiKey(apiKeyDraft)
                                if (err == null) {
                                    apiKeyDraft = ""
                                    keyError = null
                                    step = 2
                                } else {
                                    keyError = err
                                }
                            }
                        },
                        modifier = Modifier.fillMaxWidth(),
                        colors = ButtonDefaults.buttonColors(containerColor = ZoniColors.Pink500)
                    ) {
                        Text(
                            if (apiKeyDraft.isBlank() && !maskedSavedKey.isNullOrBlank()) {
                                "KEEP SAVED KEY & CONTINUE"
                            } else {
                                "SAVE GEMINI API KEY & CONTINUE"
                            },
                            color = Color.White,
                            fontWeight = FontWeight.Bold
                        )
                    }
                    OutlinedButton(
                        onClick = { step = 2 },
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Text("SKIP FOR NOW (CONFIGURE LATER)", color = ZoniColors.Slate400)
                    }
                }

                2 -> {
                    Text("Let Zoni AI use your phone", color = ZoniColors.Pink200, fontSize = 20.sp, fontWeight = FontWeight.Bold)
                    Text(
                        "Only Microphone is required; the rest unlock native calls, contacts, SMS, camera torch, location, and Bluetooth audio.",
                        color = ZoniColors.Slate400,
                        fontSize = 13.sp
                    )
                    Button(
                        onClick = onRequestAllPermissions,
                        modifier = Modifier.fillMaxWidth(),
                        colors = ButtonDefaults.buttonColors(containerColor = ZoniColors.Pink500)
                    ) {
                        Text("ALLOW ALL PERMISSIONS", color = Color.White, fontWeight = FontWeight.Bold)
                    }

                    PermissionRow("Microphone (Required)", "Talk to Zoni AI in real time", permissions.recordAudio) {
                        onRequestPermission(arrayOf(Manifest.permission.RECORD_AUDIO))
                    }
                    PermissionRow("Notifications", "Keeps Zoni AI alive in background", permissions.postNotifications) {
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                            onRequestPermission(arrayOf(Manifest.permission.POST_NOTIFICATIONS))
                        }
                    }
                    PermissionRow("Camera & Flashlight", "Hardware torch light control", permissions.camera) {
                        onRequestPermission(arrayOf(Manifest.permission.CAMERA))
                    }
                    PermissionRow("Phone Calls", "Place direct phone calls", permissions.callPhone) {
                        onRequestPermission(arrayOf(Manifest.permission.CALL_PHONE))
                    }
                    PermissionRow("Contacts", "Find phone numbers by contact name", permissions.readContacts) {
                        onRequestPermission(arrayOf(Manifest.permission.READ_CONTACTS))
                    }
                    PermissionRow("SMS", "Send text messages directly", permissions.sendSms) {
                        onRequestPermission(arrayOf(Manifest.permission.SEND_SMS))
                    }
                    PermissionRow("Location", "Weather & regional context", permissions.location) {
                        onRequestPermission(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION))
                    }
                    PermissionRow("Bluetooth", "Play voice on earbuds or speaker", permissions.bluetooth) {
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                            onRequestPermission(arrayOf(Manifest.permission.BLUETOOTH_CONNECT))
                        }
                    }

                    Row(
                        modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
                        horizontalArrangement = Arrangement.SpaceBetween
                    ) {
                        OutlinedButton(onClick = { step = 1 }) { Text("BACK", color = ZoniColors.Cyan300) }
                        Button(
                            onClick = { step = 3 },
                            enabled = permissions.recordAudio,
                            colors = ButtonDefaults.buttonColors(containerColor = ZoniColors.Cyan500)
                        ) {
                            Text("CONTINUE →", color = ZoniColors.Slate950, fontWeight = FontWeight.Bold)
                        }
                    }
                }

                3 -> {
                    Text("Keep Zoni AI alive in background", color = ZoniColors.Amber400, fontSize = 20.sp, fontWeight = FontWeight.Bold)
                    Text(
                        "Tap any row to open its genuine Android system screen, then return here.",
                        color = ZoniColors.Slate400,
                        fontSize = 13.sp
                    )

                    PermissionRow(
                        "Battery — No optimisation",
                        "Prevents Android from killing Zoni AI when screen is off.",
                        permissions.batteryOptimizationIgnored
                    ) { onOpenSystemScreen("battery") }

                    PermissionRow(
                        "Display over other apps",
                        "Allows Zoni's Floating Arc Reactor Orb over any app.",
                        permissions.overlayAllowed
                    ) { onOpenSystemScreen("overlay") }

                    PermissionRow(
                        "Notification access",
                        "Read incoming WhatsApp/SMS notifications on request.",
                        permissions.notificationListenerEnabled
                    ) { onOpenSystemScreen("notification_listener") }

                    PermissionRow(
                        "Accessibility service",
                        "Perform explicit screen navigation actions (Home/Back).",
                        permissions.accessibilityEnabled
                    ) { onOpenSystemScreen("accessibility") }

                    PermissionRow(
                        "Default assistant",
                        "Long-press power button or corner swipe to summon Zoni AI (requires Android system selection).",
                        permissions.defaultAssistant
                    ) { onOpenSystemScreen("default_assistant") }

                    Row(
                        modifier = Modifier.fillMaxWidth().padding(top = 12.dp),
                        horizontalArrangement = Arrangement.SpaceBetween
                    ) {
                        OutlinedButton(onClick = { step = 2 }) { Text("BACK", color = ZoniColors.Cyan300) }
                        Button(
                            onClick = onFinish,
                            colors = ButtonDefaults.buttonColors(containerColor = ZoniColors.Emerald500)
                        ) {
                            Text("FINISH SETUP", color = ZoniColors.Slate950, fontWeight = FontWeight.Bold)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun PermissionRow(
    title: String,
    subtitle: String,
    granted: Boolean,
    onAction: () -> Unit
) {
    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onAction),
        shape = RoundedCornerShape(12.dp),
        color = ZoniColors.Slate900,
        border = BorderStroke(
            1.dp,
            if (granted) ZoniColors.Emerald400.copy(alpha = 0.5f) else ZoniColors.Cyan500.copy(alpha = 0.3f)
        )
    ) {
        Row(
            modifier = Modifier.padding(12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(title, color = ZoniColors.Cyan50, fontSize = 13.sp, fontWeight = FontWeight.Bold)
                Text(subtitle, color = ZoniColors.Slate400, fontSize = 11.sp)
            }
            Surface(
                shape = RoundedCornerShape(8.dp),
                color = if (granted) ZoniColors.Emerald950 else ZoniColors.Cyan950,
                border = BorderStroke(1.dp, if (granted) ZoniColors.Emerald400 else ZoniColors.Cyan400)
            ) {
                Text(
                    text = if (granted) "ALLOWED" else "ALLOW",
                    color = if (granted) ZoniColors.Emerald300 else ZoniColors.Cyan300,
                    fontSize = 11.sp,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier.padding(horizontal = 10.dp, vertical = 5.dp)
                )
            }
        }
    }
}
