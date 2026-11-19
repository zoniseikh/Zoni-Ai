package com.zoni.jarvis.assistant.ui.components

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ErrorOutline
import androidx.compose.material.icons.filled.Favorite
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.VolumeUp
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.zoni.jarvis.assistant.domain.AssistantState
import com.zoni.jarvis.assistant.domain.CompanionMode
import com.zoni.jarvis.assistant.ui.theme.ZoniColors
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin

@Composable
fun ArcReactorView(
    state: AssistantState,
    mode: CompanionMode,
    selectedAffectionName: String,
    isLiveActive: Boolean,
    latestTranscript: String,
    audioAmplitude: Float,
    onReactorClick: () -> Unit,
    modifier: Modifier = Modifier
) {
    val infiniteTransition = rememberInfiniteTransition(label = "arc_reactor")
    val outerAngle by infiniteTransition.animateFloat(
        initialValue = 0f,
        targetValue = 360f,
        animationSpec = infiniteRepeatable(tween(26000, easing = LinearEasing)),
        label = "outer_angle"
    )
    val midAngle by infiniteTransition.animateFloat(
        initialValue = 360f,
        targetValue = 0f,
        animationSpec = infiniteRepeatable(tween(20000, easing = LinearEasing)),
        label = "mid_angle"
    )
    val innerAngle by infiniteTransition.animateFloat(
        initialValue = 0f,
        targetValue = 360f,
        animationSpec = infiniteRepeatable(tween(13000, easing = LinearEasing)),
        label = "inner_angle"
    )
    val idleWavePhase by infiniteTransition.animateFloat(
        initialValue = 0f,
        targetValue = (2 * PI).toFloat(),
        animationSpec = infiniteRepeatable(tween(3600, easing = LinearEasing), RepeatMode.Restart),
        label = "idle_wave"
    )

    val auraColor = when (mode) {
        CompanionMode.ROMANTIC -> ZoniColors.Pink500
        CompanionMode.JARVIS_GF -> ZoniColors.Cyan500
        CompanionMode.PLAYFUL -> ZoniColors.Amber500
        CompanionMode.LATE_NIGHT -> ZoniColors.Indigo400
    }

    val coreIconColor = when (state) {
        AssistantState.SPEAKING -> ZoniColors.Pink400
        AssistantState.LISTENING -> ZoniColors.Amber400
        AssistantState.ERROR -> ZoniColors.Rose400
        else -> ZoniColors.Cyan400
    }

    val activeNameUpper = selectedAffectionName.ifBlank { "BOSS" }.uppercase()

    Column(
        modifier = modifier.fillMaxWidth().padding(horizontal = 16.dp),
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Box(
            modifier = Modifier
                .size(276.dp)
                .clip(CircleShape)
                .clickable(onClick = onReactorClick),
            contentAlignment = Alignment.Center
        ) {
            // Rotating Holographic HUD Rings + 36 Radial Audio Spectrum Bars
            Canvas(modifier = Modifier.size(276.dp)) {
                val center = Offset(size.width / 2f, size.height / 2f)
                val maxRadius = size.minDimension / 2f

                // Ambient Radial Glow
                drawCircle(
                    brush = Brush.radialGradient(
                        colors = listOf(auraColor.copy(alpha = 0.28f), Color.Transparent),
                        center = center,
                        radius = maxRadius
                    ),
                    radius = maxRadius,
                    center = center
                )

                // Outer Graduation Ring
                rotate(outerAngle, pivot = center) {
                    drawCircle(
                        color = ZoniColors.Cyan500.copy(alpha = 0.28f),
                        radius = maxRadius - 4.dp.toPx(),
                        center = center,
                        style = Stroke(width = 1.5.dp.toPx())
                    )
                }

                // Counter-rotating Dashed Segmented Ring
                rotate(midAngle, pivot = center) {
                    drawCircle(
                        color = ZoniColors.Cyan400.copy(alpha = 0.4f),
                        radius = maxRadius - 18.dp.toPx(),
                        center = center,
                        style = Stroke(
                            width = 2.dp.toPx(),
                            pathEffect = PathEffect.dashPathEffect(floatArrayOf(18f, 12f), 0f)
                        )
                    )
                }

                // Inner Pink Tactical Ring
                rotate(innerAngle, pivot = center) {
                    drawCircle(
                        color = ZoniColors.Pink500.copy(alpha = 0.42f),
                        radius = maxRadius - 34.dp.toPx(),
                        center = center,
                        style = Stroke(width = 1.5.dp.toPx())
                    )
                }

                // 36 Radial Frequency Bars driven by Live Audio Amplitude
                val numBars = 36
                val baseRadius = maxRadius * 0.56f
                val maxSpike = when (state) {
                    AssistantState.SPEAKING -> 38.dp.toPx()
                    AssistantState.LISTENING -> 24.dp.toPx()
                    else -> 12.dp.toPx()
                }
                val barColor = when (state) {
                    AssistantState.SPEAKING -> ZoniColors.Pink400
                    AssistantState.LISTENING -> ZoniColors.Amber400
                    else -> if (mode == CompanionMode.ROMANTIC) {
                        ZoniColors.Pink400.copy(alpha = 0.55f)
                    } else {
                        ZoniColors.Cyan400.copy(alpha = 0.55f)
                    }
                }

                for (i in 0 until numBars) {
                    val angle = (i * 2.0 * PI) / numBars
                    val wave = ((sin(idleWavePhase + i * 0.45f) + 1f) * 0.5f)
                    val reactive = (audioAmplitude * 0.85f + wave * 0.35f).coerceIn(0.12f, 1f)
                    val len = (reactive * maxSpike).coerceAtLeast(3.dp.toPx())

                    val start = Offset(
                        center.x + (cos(angle) * baseRadius).toFloat(),
                        center.y + (sin(angle) * baseRadius).toFloat()
                    )
                    val end = Offset(
                        center.x + (cos(angle) * (baseRadius + len)).toFloat(),
                        center.y + (sin(angle) * (baseRadius + len)).toFloat()
                    )
                    drawLine(
                        color = barColor,
                        start = start,
                        end = end,
                        strokeWidth = if (state == AssistantState.SPEAKING) 3.dp.toPx() else 2.dp.toPx(),
                        cap = StrokeCap.Round
                    )
                }
            }

            // Center Glowing Heart-Arc Reactor Core
            Box(
                modifier = Modifier
                    .size(148.dp)
                    .clip(CircleShape)
                    .background(
                        Brush.radialGradient(
                            colors = listOf(ZoniColors.Cyan950, ZoniColors.Slate950)
                        )
                    )
                    .border(2.dp, ZoniColors.Cyan400.copy(alpha = 0.8f), CircleShape),
                contentAlignment = Alignment.Center
            ) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Icon(
                        imageVector = Icons.Default.Favorite,
                        contentDescription = "Zoni AI Core",
                        tint = coreIconColor,
                        modifier = Modifier.size(36.dp)
                    )
                    Spacer(Modifier.height(4.dp))
                    Text(
                        text = "ZONI AI",
                        color = ZoniColors.Cyan300,
                        fontSize = 14.sp,
                        fontWeight = FontWeight.Black,
                        letterSpacing = 1.5.sp
                    )
                    Text(
                        text = "JARVIS GF MK-IX",
                        color = ZoniColors.Cyan400.copy(alpha = 0.8f),
                        fontSize = 9.sp,
                        letterSpacing = 1.2.sp
                    )
                    Text(
                        text = "FOR: $activeNameUpper ❤️",
                        color = ZoniColors.Pink400,
                        fontSize = 9.sp,
                        fontWeight = FontWeight.SemiBold
                    )
                }
            }
        }

        Spacer(Modifier.height(14.dp))

        // Reactive State Badge
        val (badgeText, badgeColor, badgeBg, badgeIcon) = when (state) {
            AssistantState.LISTENING -> Quadruple(
                "LISTENING TO $activeNameUpper...",
                ZoniColors.Amber400,
                ZoniColors.Amber950.copy(alpha = 0.65f),
                Icons.Default.Mic
            )
            AssistantState.SPEAKING -> Quadruple(
                "ZONI SPEAKING (VOICE LINK LIVE)",
                ZoniColors.Cyan300,
                ZoniColors.Cyan950.copy(alpha = 0.7f),
                Icons.Default.VolumeUp
            )
            AssistantState.THINKING -> Quadruple(
                "COMPUTING WITH LOVE & INTELLIGENCE...",
                ZoniColors.Pink300,
                ZoniColors.Pink950.copy(alpha = 0.65f),
                Icons.Default.AutoAwesome
            )
            AssistantState.CONNECTING -> Quadruple(
                "SYNCHRONIZING GEMINI LIVE PROTOCOLS...",
                ZoniColors.Cyan300,
                ZoniColors.Cyan950.copy(alpha = 0.5f),
                Icons.Default.AutoAwesome
            )
            AssistantState.ERROR -> Quadruple(
                "SYSTEM NOTICE: READY FOR RETRY",
                ZoniColors.Rose400,
                ZoniColors.Rose950.copy(alpha = 0.65f),
                Icons.Default.ErrorOutline
            )
            AssistantState.IDLE -> Quadruple(
                if (isLiveActive) "LIVE VOICE STREAM ARMED" else "ZONI CORE STANDBY: TAP TO TALK",
                ZoniColors.Cyan400,
                ZoniColors.Cyan950.copy(alpha = 0.35f),
                Icons.Default.Favorite
            )
        }

        Surface(
            shape = RoundedCornerShape(999.dp),
            color = badgeBg,
            border = BorderStroke(1.dp, badgeColor.copy(alpha = 0.55f))
        ) {
            Row(
                modifier = Modifier.padding(horizontal = 14.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.Center
            ) {
                Icon(
                    imageVector = badgeIcon,
                    contentDescription = null,
                    tint = badgeColor,
                    modifier = Modifier.size(14.dp)
                )
                Spacer(Modifier.width(6.dp))
                Text(
                    text = badgeText,
                    color = badgeColor,
                    fontSize = 11.sp,
                    fontWeight = FontWeight.Bold,
                    letterSpacing = 0.8.sp
                )
            }
        }

        Spacer(Modifier.height(14.dp))

        // Live Holographic Dialogue Subtitle Box
        Surface(
            modifier = Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(14.dp),
            color = ZoniColors.Slate900.copy(alpha = 0.85f),
            border = BorderStroke(1.dp, ZoniColors.Cyan500.copy(alpha = 0.32f))
        ) {
            Column(
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp),
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                Text(
                    text = "ZONI HOLOGRAPHIC VOCAL OUTPUT",
                    color = ZoniColors.Pink300,
                    fontSize = 9.sp,
                    fontWeight = FontWeight.Bold,
                    letterSpacing = 1.2.sp
                )
                Spacer(Modifier.height(4.dp))
                Text(
                    text = "\"$latestTranscript\"",
                    color = ZoniColors.Cyan50,
                    fontSize = 14.sp,
                    fontStyle = FontStyle.Italic,
                    textAlign = TextAlign.Center,
                    lineHeight = 20.sp
                )
            }
        }
    }
}

private data class Quadruple<A, B, C, D>(val first: A, val second: B, val third: C, val fourth: D)
