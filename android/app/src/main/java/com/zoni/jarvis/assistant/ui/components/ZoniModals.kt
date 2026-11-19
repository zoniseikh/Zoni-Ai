package com.zoni.jarvis.assistant.ui.components

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.VolumeUp
import androidx.compose.material.icons.filled.BatteryChargingFull
import androidx.compose.material.icons.filled.BubbleChart
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Favorite
import androidx.compose.material.icons.filled.FlashlightOff
import androidx.compose.material.icons.filled.FlashlightOn
import androidx.compose.material.icons.filled.Forum
import androidx.compose.material.icons.filled.Sms
import androidx.compose.material.icons.filled.Vibration
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.zoni.jarvis.assistant.domain.BengaliDateTimeEngine
import com.zoni.jarvis.assistant.domain.ChatMessage
import com.zoni.jarvis.assistant.domain.CompanionMode
import com.zoni.jarvis.assistant.domain.MessageRole
import com.zoni.jarvis.assistant.domain.VoiceProfile
import com.zoni.jarvis.assistant.domain.ZoniPresets
import com.zoni.jarvis.assistant.ui.ZoniUiState
import com.zoni.jarvis.assistant.ui.theme.ZoniColors

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ZoniSettingsDialog(
    uiState: ZoniUiState,
    onDismiss: () -> Unit,
    onUpdateAffectionName: (String) -> Unit,
    onSelectMode: (CompanionMode) -> Unit,
    onSelectVoice: (VoiceProfile) -> Unit,
    onUpdateBackendUrl: (String) -> Unit
) {
    var customName by remember { mutableStateOf(uiState.settings.selectedAffectionName) }
    var serverUrlInput by remember { mutableStateOf(uiState.settings.backendServerUrl) }

    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false)
    ) {
        Surface(
            modifier = Modifier
                .fillMaxWidth(0.94f)
                .heightIn(max = 680.dp),
            shape = RoundedCornerShape(20.dp),
            color = ZoniColors.Slate950,
            border = BorderStroke(1.5.dp, ZoniColors.Cyan500.copy(alpha = 0.5f))
        ) {
            Column {
                // Header
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(ZoniColors.Slate900)
                        .padding(horizontal = 16.dp, vertical = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween
                ) {
                    Column {
                        Text(
                            text = "ZONI AI — JARVIS CORE SETTINGS",
                            color = ZoniColors.Cyan300,
                            fontSize = 14.sp,
                            fontWeight = FontWeight.Bold
                        )
                        Text(
                            text = "সোল কোর, পার্সোনালিটি ম্যাট্রিক্স ও ভয়েস মডুলেটর",
                            color = ZoniColors.Pink300,
                            fontSize = 11.sp
                        )
                    }
                    IconButton(onClick = onDismiss) {
                        Icon(Icons.Default.Close, contentDescription = "Close", tint = ZoniColors.Cyan400)
                    }
                }

                Column(
                    modifier = Modifier
                        .weight(1f)
                        .verticalScroll(rememberScrollState())
                        .padding(16.dp),
                    verticalArrangement = Arrangement.spacedBy(16.dp)
                ) {
                    // 1. Zoni Soul Core (Affection Name)
                    SectionCard(title = "1. ZONI CALLS YOU (জনি আপনাকে যে নামে ডাকবে)", accent = ZoniColors.Pink400) {
                        FlowRow(
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                            verticalArrangement = Arrangement.spacedBy(8.dp)
                        ) {
                            ZoniPresets.PREDEFINED_AFFECTION_OPTIONS.forEach { opt ->
                                val selected = uiState.settings.selectedAffectionName.equals(opt.value, ignoreCase = true)
                                Surface(
                                    shape = RoundedCornerShape(10.dp),
                                    color = if (selected) ZoniColors.Pink950 else ZoniColors.Slate950,
                                    border = BorderStroke(
                                        1.dp,
                                        if (selected) ZoniColors.Pink400 else ZoniColors.Cyan500.copy(alpha = 0.3f)
                                    ),
                                    modifier = Modifier.clickable {
                                        customName = opt.value
                                        onUpdateAffectionName(opt.value)
                                    }
                                ) {
                                    Text(
                                        text = opt.label,
                                        color = if (selected) ZoniColors.Pink200 else ZoniColors.Cyan300,
                                        fontSize = 12.sp,
                                        fontWeight = if (selected) FontWeight.Bold else FontWeight.Medium,
                                        modifier = Modifier.padding(horizontal = 12.dp, vertical = 7.dp)
                                    )
                                }
                            }
                        }
                        Spacer(Modifier.height(10.dp))
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(8.dp)
                        ) {
                            OutlinedTextField(
                                value = customName,
                                onValueChange = { customName = it },
                                modifier = Modifier.weight(1f),
                                singleLine = true,
                                label = { Text("Custom Name", fontSize = 11.sp) },
                                colors = OutlinedTextFieldDefaults.colors(
                                    focusedBorderColor = ZoniColors.Pink400,
                                    unfocusedBorderColor = ZoniColors.Cyan500.copy(alpha = 0.35f),
                                    focusedTextColor = ZoniColors.Cyan50,
                                    unfocusedTextColor = ZoniColors.Cyan50
                                )
                            )
                            Button(
                                onClick = { onUpdateAffectionName(customName) },
                                colors = ButtonDefaults.buttonColors(containerColor = ZoniColors.Pink500)
                            ) {
                                Text("SAVE", fontSize = 12.sp, fontWeight = FontWeight.Bold)
                            }
                        }
                    }

                    // 2. Personality Matrix Mode
                    SectionCard(title = "2. PERSONALITY MATRIX MODE", accent = ZoniColors.Cyan400) {
                        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            CompanionMode.entries.forEach { mode ->
                                val active = uiState.settings.activeMode == mode
                                Surface(
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .clickable { onSelectMode(mode) },
                                    shape = RoundedCornerShape(12.dp),
                                    color = if (active) ZoniColors.Cyan950 else ZoniColors.Slate950,
                                    border = BorderStroke(
                                        1.dp,
                                        if (active) ZoniColors.Cyan400 else ZoniColors.Slate800
                                    )
                                ) {
                                    Column(modifier = Modifier.padding(12.dp)) {
                                        Text(
                                            text = mode.title + if (active) "  [ACTIVE]" else "",
                                            color = if (active) ZoniColors.Cyan300 else ZoniColors.Cyan50,
                                            fontSize = 13.sp,
                                            fontWeight = FontWeight.Bold
                                        )
                                        Text(
                                            text = mode.subtitleBengali,
                                            color = ZoniColors.Slate400,
                                            fontSize = 11.sp
                                        )
                                    }
                                }
                            }
                        }
                    }

                    // 3. Voice Matrix Modulator
                    SectionCard(title = "3. VOICE MATRIX (GEMINI LIVE AUDIO)", accent = ZoniColors.Cyan400) {
                        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            VoiceProfile.entries.forEach { voice ->
                                val selected = uiState.settings.selectedVoice == voice
                                Surface(
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .clickable { onSelectVoice(voice) },
                                    shape = RoundedCornerShape(12.dp),
                                    color = if (selected) ZoniColors.Pink950.copy(alpha = 0.6f) else ZoniColors.Slate950,
                                    border = BorderStroke(
                                        1.dp,
                                        if (selected) ZoniColors.Pink400 else ZoniColors.Slate800
                                    )
                                ) {
                                    Column(modifier = Modifier.padding(10.dp)) {
                                        Text(
                                            text = voice.label + if (selected) "  [EQUIPPED]" else "",
                                            color = if (selected) ZoniColors.Pink200 else ZoniColors.Cyan50,
                                            fontSize = 12.sp,
                                            fontWeight = FontWeight.Bold
                                        )
                                        Text(
                                            text = voice.description,
                                            color = ZoniColors.Slate400,
                                            fontSize = 11.sp
                                        )
                                    }
                                }
                            }
                        }
                    }

                    // 4. Gemini Live Server Link & Protocol Telemetry
                    SectionCard(title = "4. ANDROID BACKEND SERVER & PROTOCOL", accent = ZoniColors.Cyan400) {
                        Text(
                            text = "PROTOCOL: WSS // GEMINI-3.8-LIVE (16kHz PCM ⇄ 24kHz PCM)",
                            color = ZoniColors.Cyan300,
                            fontSize = 11.sp,
                            fontWeight = FontWeight.SemiBold
                        )
                        Spacer(Modifier.height(8.dp))
                        OutlinedTextField(
                            value = serverUrlInput,
                            onValueChange = { serverUrlInput = it },
                            modifier = Modifier.fillMaxWidth(),
                            singleLine = true,
                            label = { Text("Zoni Server URL (https://...)", fontSize = 11.sp) },
                            colors = OutlinedTextFieldDefaults.colors(
                                focusedBorderColor = ZoniColors.Cyan400,
                                unfocusedBorderColor = ZoniColors.Slate800,
                                focusedTextColor = ZoniColors.Cyan50,
                                unfocusedTextColor = ZoniColors.Cyan50
                            )
                        )
                        Spacer(Modifier.height(6.dp))
                        Button(
                            onClick = { onUpdateBackendUrl(serverUrlInput) },
                            modifier = Modifier.fillMaxWidth(),
                            colors = ButtonDefaults.buttonColors(containerColor = ZoniColors.Cyan500)
                        ) {
                            Text("RECONNECT SERVER", color = ZoniColors.Slate950, fontWeight = FontWeight.Bold)
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun AndroidHardwareHubDialog(
    uiState: ZoniUiState,
    onDismiss: () -> Unit,
    onToggleTorch: () -> Unit,
    onVibrate: () -> Unit,
    onCall: (String) -> Unit,
    onSms: (String, String) -> Unit,
    onWhatsApp: (String, String) -> Unit,
    onToggleFloatingOrb: () -> Unit,
    onOpenSettingsTarget: (String) -> Unit
) {
    var phoneNumber by remember { mutableStateOf("01700000000") }
    var messageText by remember {
        mutableStateOf("Hello ${uiState.settings.selectedAffectionName}, Zoni Assistant is active! ❤️")
    }

    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false)
    ) {
        Surface(
            modifier = Modifier
                .fillMaxWidth(0.94f)
                .heightIn(max = 660.dp),
            shape = RoundedCornerShape(20.dp),
            color = ZoniColors.Slate950,
            border = BorderStroke(1.5.dp, ZoniColors.Pink500.copy(alpha = 0.55f))
        ) {
            Column {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(ZoniColors.Slate900)
                        .padding(horizontal = 16.dp, vertical = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween
                ) {
                    Column {
                        Text(
                            text = "ANDROID NATIVE HARDWARE HUB",
                            color = ZoniColors.Cyan300,
                            fontSize = 14.sp,
                            fontWeight = FontWeight.Bold
                        )
                        Text(
                            text = "সরাসরি অ্যান্ড্রয়েড সিস্টেম ও হার্ডওয়্যার কন্ট্রোল",
                            color = ZoniColors.Pink300,
                            fontSize = 11.sp
                        )
                    }
                    IconButton(onClick = onDismiss) {
                        Icon(Icons.Default.Close, contentDescription = "Close", tint = ZoniColors.Cyan400)
                    }
                }

                Column(
                    modifier = Modifier
                        .weight(1f)
                        .verticalScroll(rememberScrollState())
                        .padding(16.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp)
                ) {
                    OutlinedTextField(
                        value = phoneNumber,
                        onValueChange = { phoneNumber = it },
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true,
                        label = { Text("Phone Number / ফোন নম্বর") },
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedBorderColor = ZoniColors.Cyan400,
                            unfocusedBorderColor = ZoniColors.Slate800,
                            focusedTextColor = ZoniColors.Cyan50,
                            unfocusedTextColor = ZoniColors.Cyan50
                        )
                    )
                    OutlinedTextField(
                        value = messageText,
                        onValueChange = { messageText = it },
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true,
                        label = { Text("Message / বার্তা") },
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedBorderColor = ZoniColors.Pink400,
                            unfocusedBorderColor = ZoniColors.Slate800,
                            focusedTextColor = ZoniColors.Cyan50,
                            unfocusedTextColor = ZoniColors.Cyan50
                        )
                    )

                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        HardwareActionTile(
                            modifier = Modifier.weight(1f),
                            icon = Icons.Default.Call,
                            title = "DIRECT CALL",
                            subtitle = "সরাসরি কল",
                            accent = ZoniColors.Cyan400,
                            onClick = { onCall(phoneNumber) }
                        )
                        HardwareActionTile(
                            modifier = Modifier.weight(1f),
                            icon = Icons.Default.Forum,
                            title = "WHATSAPP",
                            subtitle = "হোয়াটসঅ্যাপ",
                            accent = ZoniColors.Emerald400,
                            onClick = { onWhatsApp(phoneNumber, messageText) }
                        )
                    }

                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        HardwareActionTile(
                            modifier = Modifier.weight(1f),
                            icon = Icons.Default.Sms,
                            title = "SEND SMS",
                            subtitle = "এসএমএস",
                            accent = ZoniColors.Pink400,
                            onClick = { onSms(phoneNumber, messageText) }
                        )
                        HardwareActionTile(
                            modifier = Modifier.weight(1f),
                            icon = if (uiState.isTorchOn) Icons.Default.FlashlightOn else Icons.Default.FlashlightOff,
                            title = if (uiState.isTorchOn) "TORCH ON" else "TORCH OFF",
                            subtitle = "Camera2 ফ্ল্যাশ",
                            accent = ZoniColors.Amber400,
                            onClick = onToggleTorch
                        )
                    }

                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        HardwareActionTile(
                            modifier = Modifier.weight(1f),
                            icon = Icons.Default.Vibration,
                            title = "VIBRATE",
                            subtitle = "হ্যাপটিক ফিডব্যাক",
                            accent = ZoniColors.Indigo400,
                            onClick = onVibrate
                        )
                        HardwareActionTile(
                            modifier = Modifier.weight(1f),
                            icon = Icons.Default.BubbleChart,
                            title = if (uiState.isFloatingOrbRunning) "ORB ACTIVE" else "FLOAT ORB",
                            subtitle = "ওভারলে বাবল",
                            accent = if (uiState.isFloatingOrbRunning) ZoniColors.Emerald400 else ZoniColors.Cyan400,
                            onClick = onToggleFloatingOrb
                        )
                    }

                    Surface(
                        modifier = Modifier.fillMaxWidth(),
                        shape = RoundedCornerShape(12.dp),
                        color = ZoniColors.Slate900,
                        border = BorderStroke(1.dp, ZoniColors.Emerald400.copy(alpha = 0.4f))
                    ) {
                        Row(
                            modifier = Modifier.padding(14.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.SpaceBetween
                        ) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Icon(
                                    Icons.Default.BatteryChargingFull,
                                    contentDescription = null,
                                    tint = ZoniColors.Emerald400
                                )
                                Spacer(Modifier.width(8.dp))
                                Text(
                                    text = "BATTERY: ${uiState.battery.level}% (${if (uiState.battery.charging) "Charging" else "Normal"})",
                                    color = ZoniColors.Emerald300,
                                    fontSize = 13.sp,
                                    fontWeight = FontWeight.Bold
                                )
                            }
                            Text(
                                text = "WIFI",
                                color = ZoniColors.Cyan300,
                                fontSize = 11.sp,
                                fontWeight = FontWeight.Bold,
                                modifier = Modifier.clickable { onOpenSettingsTarget("wifi") }
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun ChatTranscriptDialog(
    messages: List<ChatMessage>,
    affectionName: String,
    onDismiss: () -> Unit,
    onReplay: (String) -> Unit,
    onClear: () -> Unit
) {
    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false)
    ) {
        Surface(
            modifier = Modifier
                .fillMaxWidth(0.94f)
                .heightIn(max = 660.dp),
            shape = RoundedCornerShape(20.dp),
            color = ZoniColors.Slate950,
            border = BorderStroke(1.5.dp, ZoniColors.Cyan500.copy(alpha = 0.45f))
        ) {
            Column {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(ZoniColors.Slate900)
                        .padding(horizontal = 16.dp, vertical = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Default.Favorite, contentDescription = null, tint = ZoniColors.Pink400, modifier = Modifier.size(18.dp))
                        Spacer(Modifier.width(8.dp))
                        Column {
                            Text("TRANSCRIPT ARCHIVE", color = ZoniColors.Cyan300, fontSize = 14.sp, fontWeight = FontWeight.Bold)
                            Text("ZONI & ${affectionName.uppercase()} LOGS", color = ZoniColors.Slate400, fontSize = 10.sp)
                        }
                    }
                    Row {
                        if (messages.isNotEmpty()) {
                            IconButton(onClick = onClear) {
                                Icon(Icons.Default.Delete, contentDescription = "Clear", tint = ZoniColors.Rose400)
                            }
                        }
                        IconButton(onClick = onDismiss) {
                            Icon(Icons.Default.Close, contentDescription = "Close", tint = ZoniColors.Cyan400)
                        }
                    }
                }

                LazyColumn(
                    modifier = Modifier
                        .weight(1f)
                        .padding(14.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp)
                ) {
                    items(messages, key = { it.id }) { msg ->
                        val isAssistant = msg.role == MessageRole.ASSISTANT
                        Column(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalAlignment = if (isAssistant) Alignment.Start else Alignment.End
                        ) {
                            Text(
                                text = "${if (isAssistant) "ZONI" else affectionName.uppercase()} • ${BengaliDateTimeEngine.formatShortTimeIst(msg.timestampMillis)} IST",
                                color = if (isAssistant) ZoniColors.Pink300 else ZoniColors.Cyan300,
                                fontSize = 10.sp,
                                fontWeight = FontWeight.SemiBold
                            )
                            Spacer(Modifier.height(3.dp))
                            Surface(
                                shape = RoundedCornerShape(14.dp),
                                color = if (isAssistant) ZoniColors.Slate900 else ZoniColors.Cyan950,
                                border = BorderStroke(
                                    1.dp,
                                    if (isAssistant) ZoniColors.Pink500.copy(alpha = 0.35f) else ZoniColors.Cyan400.copy(alpha = 0.4f)
                                )
                            ) {
                                Column(modifier = Modifier.padding(12.dp)) {
                                    Text(text = msg.text, color = ZoniColors.Cyan50, fontSize = 13.sp, lineHeight = 19.sp)
                                    if (isAssistant) {
                                        Spacer(Modifier.height(6.dp))
                                        Row(
                                            modifier = Modifier.clickable { onReplay(msg.text) },
                                            verticalAlignment = Alignment.CenterVertically
                                        ) {
                                            Icon(
                                                Icons.AutoMirrored.Filled.VolumeUp,
                                                contentDescription = "Replay",
                                                tint = ZoniColors.Pink300,
                                                modifier = Modifier.size(14.dp)
                                            )
                                            Spacer(Modifier.width(4.dp))
                                            Text("REPLAY VOICE", color = ZoniColors.Pink300, fontSize = 10.sp, fontWeight = FontWeight.Bold)
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun SectionCard(
    title: String,
    accent: Color,
    content: @Composable () -> Unit
) {
    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(14.dp),
        color = ZoniColors.Slate900.copy(alpha = 0.85f),
        border = BorderStroke(1.dp, accent.copy(alpha = 0.35f))
    ) {
        Column(modifier = Modifier.padding(14.dp)) {
            Text(text = title, color = accent, fontSize = 11.sp, fontWeight = FontWeight.Bold, letterSpacing = 0.7.sp)
            Spacer(Modifier.height(10.dp))
            content()
        }
    }
}

@Composable
private fun HardwareActionTile(
    modifier: Modifier = Modifier,
    icon: ImageVector,
    title: String,
    subtitle: String,
    accent: Color,
    onClick: () -> Unit
) {
    Surface(
        modifier = modifier.clickable(onClick = onClick),
        shape = RoundedCornerShape(14.dp),
        color = ZoniColors.Slate900,
        border = BorderStroke(1.dp, accent.copy(alpha = 0.45f))
    ) {
        Column(modifier = Modifier.padding(12.dp)) {
            Icon(imageVector = icon, contentDescription = title, tint = accent, modifier = Modifier.size(22.dp))
            Spacer(Modifier.height(6.dp))
            Text(text = title, color = ZoniColors.Cyan50, fontSize = 12.sp, fontWeight = FontWeight.Bold)
            Text(text = subtitle, color = ZoniColors.Slate400, fontSize = 10.sp)
        }
    }
}
