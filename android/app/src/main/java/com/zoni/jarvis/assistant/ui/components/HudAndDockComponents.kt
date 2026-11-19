package com.zoni.jarvis.assistant.ui.components

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.automirrored.filled.VolumeOff
import androidx.compose.material.icons.automirrored.filled.VolumeUp
import androidx.compose.material.icons.filled.Bolt
import androidx.compose.material.icons.filled.ChatBubbleOutline
import androidx.compose.material.icons.filled.Favorite
import androidx.compose.material.icons.filled.Language
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.MicOff
import androidx.compose.material.icons.filled.PhoneAndroid
import androidx.compose.material.icons.filled.Radio
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Shield
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
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
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.zoni.jarvis.assistant.domain.AssistantState
import com.zoni.jarvis.assistant.domain.SupportedLanguage
import com.zoni.jarvis.assistant.ui.ZoniUiState
import com.zoni.jarvis.assistant.ui.theme.ZoniColors

@Composable
fun HudHeaderBar(
    uiState: ZoniUiState,
    onSelectLanguage: (SupportedLanguage) -> Unit,
    onToggleAutoPlay: () -> Unit,
    onToggleVoiceMute: () -> Unit,
    onOpenPermissions: () -> Unit,
    onOpenHardwareHub: () -> Unit,
    onOpenSettings: () -> Unit,
    onOpenTranscript: () -> Unit
) {
    var langMenuOpen by remember { mutableStateOf(false) }

    Surface(
        modifier = Modifier.fillMaxWidth(),
        color = ZoniColors.Slate950.copy(alpha = 0.94f),
        border = BorderStroke(1.dp, ZoniColors.Cyan500.copy(alpha = 0.22f))
    ) {
        Column(modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween
            ) {
                // Brand & Active Calling Designation
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Surface(
                        shape = RoundedCornerShape(10.dp),
                        color = ZoniColors.Cyan950,
                        border = BorderStroke(1.dp, ZoniColors.Cyan400.copy(alpha = 0.6f))
                    ) {
                        Box(
                            modifier = Modifier.size(34.dp),
                            contentAlignment = Alignment.Center
                        ) {
                            Icon(
                                imageVector = Icons.Default.Bolt,
                                contentDescription = "Zoni AI",
                                tint = ZoniColors.Cyan400,
                                modifier = Modifier.size(18.dp)
                            )
                        }
                    }
                    Spacer(Modifier.width(10.dp))
                    Column {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(
                                text = "ZONI AI",
                                color = ZoniColors.Cyan300,
                                fontSize = 15.sp,
                                fontWeight = FontWeight.Black,
                                letterSpacing = 1.sp
                            )
                            Spacer(Modifier.width(6.dp))
                            Surface(
                                shape = RoundedCornerShape(4.dp),
                                color = ZoniColors.Cyan950,
                                border = BorderStroke(1.dp, ZoniColors.Cyan500.copy(alpha = 0.4f))
                            ) {
                                Text(
                                    text = "ANDROID MK-IX",
                                    color = ZoniColors.Cyan300,
                                    fontSize = 9.sp,
                                    fontWeight = FontWeight.Bold,
                                    modifier = Modifier.padding(horizontal = 5.dp, vertical = 2.dp)
                                )
                            }
                        }
                        Text(
                            text = "CALLING: ${uiState.settings.selectedAffectionName} • ${uiState.istClockText} IST",
                            color = ZoniColors.Pink300,
                            fontSize = 11.sp,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis
                        )
                    }
                }

                // Heartbeat BPM Mini Pill
                Surface(
                    shape = RoundedCornerShape(8.dp),
                    color = ZoniColors.Slate900,
                    border = BorderStroke(1.dp, ZoniColors.Pink500.copy(alpha = 0.35f))
                ) {
                    Row(
                        modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Icon(
                            imageVector = Icons.Default.Favorite,
                            contentDescription = null,
                            tint = ZoniColors.Pink500,
                            modifier = Modifier.size(12.dp)
                        )
                        Spacer(Modifier.width(4.dp))
                        Text(
                            text = "${uiState.heartRate} BPM",
                            color = ZoniColors.Pink200,
                            fontSize = 10.sp,
                            fontWeight = FontWeight.Bold
                        )
                    }
                }
            }

            Spacer(Modifier.height(8.dp))

            // Action Controls Row (Horizontally scrollable for compact Android screens)
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                // Language Dropdown
                Box {
                    HudChipButton(
                        icon = Icons.Default.Language,
                        label = uiState.settings.activeLanguage.shortLabel,
                        accent = ZoniColors.Cyan400,
                        onClick = { langMenuOpen = true }
                    )
                    DropdownMenu(
                        expanded = langMenuOpen,
                        onDismissRequest = { langMenuOpen = false },
                        modifier = Modifier.background(ZoniColors.Slate900)
                    ) {
                        SupportedLanguage.entries.forEach { lang ->
                            DropdownMenuItem(
                                text = {
                                    Text(
                                        text = lang.displayLabel,
                                        color = if (lang == uiState.settings.activeLanguage) ZoniColors.Pink300 else ZoniColors.Cyan50,
                                        fontWeight = if (lang == uiState.settings.activeLanguage) FontWeight.Bold else FontWeight.Normal
                                    )
                                },
                                onClick = {
                                    langMenuOpen = false
                                    onSelectLanguage(lang)
                                }
                            )
                        }
                    }
                }

                HudChipButton(
                    icon = Icons.Default.Radio,
                    label = if (uiState.settings.voiceAutoPlay) "AUTO-VOICE" else "MANUAL",
                    accent = if (uiState.settings.voiceAutoPlay) ZoniColors.Emerald400 else ZoniColors.Slate400,
                    onClick = onToggleAutoPlay
                )

                HudChipButton(
                    icon = if (uiState.settings.voiceMuted) Icons.AutoMirrored.Filled.VolumeOff else Icons.AutoMirrored.Filled.VolumeUp,
                    label = if (uiState.settings.voiceMuted) "MUTED" else "AUDIO",
                    accent = if (uiState.settings.voiceMuted) ZoniColors.Rose400 else ZoniColors.Cyan400,
                    onClick = onToggleVoiceMute
                )

                HudChipButton(
                    icon = Icons.Default.Shield,
                    label = "SETUP",
                    accent = if (uiState.permissions?.recordAudio == true) ZoniColors.Emerald400 else ZoniColors.Amber400,
                    onClick = onOpenPermissions
                )

                HudChipButton(
                    icon = Icons.Default.PhoneAndroid,
                    label = "ANDROID HUB",
                    accent = ZoniColors.Pink400,
                    onClick = onOpenHardwareHub
                )

                HudChipButton(
                    icon = Icons.Default.Settings,
                    label = "Setting",
                    accent = ZoniColors.Cyan300,
                    onClick = onOpenSettings
                )

                HudChipButton(
                    icon = Icons.Default.ChatBubbleOutline,
                    label = "LOGS (${uiState.messages.size})",
                    accent = ZoniColors.Cyan400,
                    onClick = onOpenTranscript
                )
            }
        }
    }
}

@Composable
private fun HudChipButton(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    label: String,
    accent: Color,
    onClick: () -> Unit
) {
    Surface(
        shape = RoundedCornerShape(8.dp),
        color = ZoniColors.Slate900,
        border = BorderStroke(1.dp, accent.copy(alpha = 0.45f)),
        modifier = Modifier.clickable(onClick = onClick)
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 9.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Icon(
                imageVector = icon,
                contentDescription = label,
                tint = accent,
                modifier = Modifier.size(14.dp)
            )
            Spacer(Modifier.width(5.dp))
            Text(
                text = label,
                color = ZoniColors.Cyan50,
                fontSize = 11.sp,
                fontWeight = FontWeight.SemiBold
            )
        }
    }
}

@Composable
fun ControlDockBar(
    state: AssistantState,
    isLiveActive: Boolean,
    isMicMuted: Boolean,
    onToggleLiveMode: () -> Unit,
    onToggleMicMute: () -> Unit,
    onInterrupt: () -> Unit,
    onSendMessage: (String) -> Unit
) {
    var inputText by remember { mutableStateOf("") }

    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 10.dp),
        shape = RoundedCornerShape(18.dp),
        color = ZoniColors.Slate900.copy(alpha = 0.92f),
        border = BorderStroke(1.dp, ZoniColors.Cyan500.copy(alpha = 0.3f))
    ) {
        Column(
            modifier = Modifier.padding(12.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            // Primary Voice Call Controls
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Button(
                    onClick = onToggleLiveMode,
                    modifier = Modifier
                        .weight(1f)
                        .height(44.dp),
                    shape = RoundedCornerShape(12.dp),
                    contentPadding = PaddingValues(0.dp),
                    colors = ButtonDefaults.buttonColors(containerColor = Color.Transparent)
                ) {
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(44.dp)
                            .background(
                                if (isLiveActive) {
                                    Brush.horizontalGradient(listOf(ZoniColors.Rose600, ZoniColors.Pink500))
                                } else {
                                    Brush.horizontalGradient(listOf(ZoniColors.Cyan500, ZoniColors.Pink500, ZoniColors.Cyan400))
                                },
                                RoundedCornerShape(12.dp)
                            ),
                        contentAlignment = Alignment.Center
                    ) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Icon(
                                imageVector = Icons.Default.Radio,
                                contentDescription = null,
                                tint = Color.White,
                                modifier = Modifier.size(16.dp)
                            )
                            Spacer(Modifier.width(8.dp))
                            Text(
                                text = if (isLiveActive) "END GEMINI LIVE CALL" else "START GEMINI LIVE VOICE",
                                color = Color.White,
                                fontSize = 12.sp,
                                fontWeight = FontWeight.Bold,
                                letterSpacing = 0.8.sp
                            )
                        }
                    }
                }

                // Mic Mute Button
                Surface(
                    shape = RoundedCornerShape(12.dp),
                    color = if (isMicMuted) ZoniColors.Rose950 else ZoniColors.Slate950,
                    border = BorderStroke(
                        1.dp,
                        if (isMicMuted) ZoniColors.Rose400 else ZoniColors.Cyan500.copy(alpha = 0.4f)
                    )
                ) {
                    IconButton(onClick = onToggleMicMute, modifier = Modifier.size(44.dp)) {
                        Icon(
                            imageVector = if (isMicMuted) Icons.Default.MicOff else Icons.Default.Mic,
                            contentDescription = if (isMicMuted) "Unmute Mic" else "Mute Mic",
                            tint = if (isMicMuted) ZoniColors.Rose400 else ZoniColors.Cyan400
                        )
                    }
                }

                // Interrupt Button when Speaking
                if (state == AssistantState.SPEAKING) {
                    Surface(
                        shape = RoundedCornerShape(12.dp),
                        color = ZoniColors.Amber950,
                        border = BorderStroke(1.dp, ZoniColors.Amber400)
                    ) {
                        IconButton(onClick = onInterrupt, modifier = Modifier.size(44.dp)) {
                            Icon(
                                imageVector = Icons.Default.Stop,
                                contentDescription = "Interrupt Zoni",
                                tint = ZoniColors.Amber400
                            )
                        }
                    }
                }
            }

            // Hybrid Chat Box Row (shares exact same Gemini Live session!)
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                OutlinedTextField(
                    value = inputText,
                    onValueChange = { inputText = it },
                    modifier = Modifier.weight(1f),
                    singleLine = true,
                    placeholder = {
                        Text(
                            text = "বাংলা বা যেকোনো ভাষায় লিখুন...",
                            color = ZoniColors.Slate400,
                            fontSize = 13.sp
                        )
                    },
                    shape = RoundedCornerShape(12.dp),
                    colors = OutlinedTextFieldDefaults.colors(
                        focusedBorderColor = ZoniColors.Cyan400,
                        unfocusedBorderColor = ZoniColors.Cyan500.copy(alpha = 0.3f),
                        focusedTextColor = ZoniColors.Cyan50,
                        unfocusedTextColor = ZoniColors.Cyan50,
                        focusedContainerColor = ZoniColors.Slate950,
                        unfocusedContainerColor = ZoniColors.Slate950
                    ),
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                    keyboardActions = KeyboardActions(
                        onSend = {
                            if (inputText.isNotBlank()) {
                                onSendMessage(inputText)
                                inputText = ""
                            }
                        }
                    )
                )

                Surface(
                    shape = RoundedCornerShape(12.dp),
                    color = if (inputText.isNotBlank()) ZoniColors.Pink500 else ZoniColors.Slate800
                ) {
                    IconButton(
                        enabled = inputText.isNotBlank() && state != AssistantState.THINKING,
                        onClick = {
                            onSendMessage(inputText)
                            inputText = ""
                        },
                        modifier = Modifier.size(48.dp)
                    ) {
                        Icon(
                            imageVector = Icons.AutoMirrored.Filled.Send,
                            contentDescription = "Send Message",
                            tint = Color.White
                        )
                    }
                }
            }
        }
    }
}
