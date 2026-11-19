package com.zoni.jarvis.assistant.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

object ZoniColors {
    val Slate950 = Color(0xFF020617)
    val Slate900 = Color(0xFF0F172A)
    val Slate800 = Color(0xFF1E293B)
    val Slate400 = Color(0xFF94A3B8)
    val Cyan50 = Color(0xFFECFEFF)
    val Cyan300 = Color(0xFF67E8F9)
    val Cyan400 = Color(0xFF22D3EE)
    val Cyan500 = Color(0xFF06B6D4)
    val Cyan950 = Color(0xFF083344)
    val Pink200 = Color(0xFFFBCFE8)
    val Pink300 = Color(0xFFF9A8D4)
    val Pink400 = Color(0xFFF472B6)
    val Pink500 = Color(0xFFEC4899)
    val Pink950 = Color(0xFF500724)
    val Amber400 = Color(0xFFFBBF24)
    val Amber500 = Color(0xFFF59E0B)
    val Amber950 = Color(0xFF451A03)
    val Emerald300 = Color(0xFF6EE7B7)
    val Emerald400 = Color(0xFF34D399)
    val Emerald500 = Color(0xFF10B981)
    val Emerald950 = Color(0xFF022C22)
    val Rose400 = Color(0xFFFB7185)
    val Rose600 = Color(0xFFE11D48)
    val Rose950 = Color(0xFF4C0519)
    val Indigo400 = Color(0xFF818CF8)
    val Indigo950 = Color(0xFF1E1B4B)
}

private val ZoniDarkColorScheme = darkColorScheme(
    primary = ZoniColors.Cyan500,
    onPrimary = ZoniColors.Slate950,
    secondary = ZoniColors.Pink500,
    onSecondary = Color.White,
    tertiary = ZoniColors.Amber500,
    background = ZoniColors.Slate950,
    onBackground = ZoniColors.Cyan50,
    surface = ZoniColors.Slate900,
    onSurface = ZoniColors.Cyan50,
    surfaceVariant = ZoniColors.Slate800,
    onSurfaceVariant = ZoniColors.Slate400,
    error = ZoniColors.Rose400
)

@Composable
fun ZoniTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = ZoniDarkColorScheme,
        content = content
    )
}
