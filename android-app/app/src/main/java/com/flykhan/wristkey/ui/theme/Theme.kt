package com.flykhan.wristkey.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

/** 深色薄荷绿主题（v2.0 固定深色，不使用动态取色）。 */
private val WristKeyColorScheme = darkColorScheme(
    primary = Mint,
    onPrimary = Color(0xFF06201A),
    primaryContainer = Color(0xFF1B3A32),
    onPrimaryContainer = Mint,
    secondary = SteamBlue,
    onSecondary = Color(0xFF0A1626),
    tertiary = Warning,
    onTertiary = Color(0xFF241A0C),
    background = Bg,
    onBackground = TextPrimary,
    surface = SurfaceDark,
    onSurface = TextPrimary,
    surfaceVariant = SurfaceHigh,
    onSurfaceVariant = TextDim,
    surfaceContainer = SurfaceHigh,
    surfaceContainerHigh = SurfaceHigh,
    surfaceContainerHighest = Color(0xFF213029),
    outline = OutlineColor,
    outlineVariant = OutlineColor,
    error = ErrorRed,
    onError = Color(0xFF2A0A0A),
    scrim = Color(0xCC000000),
)

@Composable
fun WristKeyTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = WristKeyColorScheme,
        typography = Typography,
        content = content,
    )
}
