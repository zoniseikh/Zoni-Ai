package com.zoni.jarvis.assistant.action

import android.media.AudioManager
import org.json.JSONObject
import kotlin.math.roundToInt

/**
 * Pure JVM-testable volume math, stream resolution, and bridge payload parsing for Zoni AI.
 *
 * Supports separate Android audio streams (media, ring, alarm, call, notification),
 * Bengali/Hindi/English digit normalization, strict percentage clamping (0..100),
 * accurate index<->percent conversion, and backward-compatible bridge payloads.
 */
enum class VolumeStreamType(
    val id: String,
    val androidStream: Int,
    val displayLabel: String
) {
    MEDIA("media", AudioManager.STREAM_MUSIC, "Media"),
    RING("ring", AudioManager.STREAM_RING, "Ring"),
    ALARM("alarm", AudioManager.STREAM_ALARM, "Alarm"),
    CALL("call", AudioManager.STREAM_VOICE_CALL, "Call"),
    NOTIFICATION("notification", AudioManager.STREAM_NOTIFICATION, "Notification");

    companion object {
        fun fromRaw(raw: String?): VolumeStreamType {
            val clean = raw?.trim()?.lowercase().orEmpty()
            return when {
                clean in setOf("ring", "ringtone", "ringer", "রিং", "রিংটোন", "रिंग", "रिंगटोन") -> RING
                clean in setOf("alarm", "অ্যালার্ম", "এলার্ম", "अलार्म") -> ALARM
                clean in setOf("call", "voice_call", "voice", "incall", "কল", "कॉल") -> CALL
                clean in setOf("notification", "notifications", "notif", "নোটিফিকেশন", "नोटिफिकेशन") -> NOTIFICATION
                else -> MEDIA
            }
        }
    }
}

data class ParsedVolumeRequest(
    val action: String,
    val stream: VolumeStreamType = VolumeStreamType.MEDIA,
    val percent: Int? = null
)

object VolumeControlMath {

    fun normalizeDigits(input: String): String {
        val sb = StringBuilder(input.length)
        for (ch in input) {
            when (ch) {
                in '০'..'৯' -> sb.append(('0'.code + (ch.code - '০'.code)).toChar())
                in '०'..'९' -> sb.append(('0'.code + (ch.code - '०'.code)).toChar())
                else -> sb.append(ch)
            }
        }
        return sb.toString()
    }

    fun clampPercent(percent: Int): Int = percent.coerceIn(0, 100)

    fun percentToStreamIndex(percent: Int, minIndex: Int, maxIndex: Int): Int {
        val safeMin = minIndex.coerceAtLeast(0)
        val safeMax = maxIndex.coerceAtLeast(safeMin)
        if (safeMax == safeMin) return safeMin
        val clamped = clampPercent(percent)
        val raw = safeMin + ((safeMax - safeMin) * (clamped / 100.0))
        return raw.roundToInt().coerceIn(safeMin, safeMax)
    }

    fun streamIndexToPercent(index: Int, minIndex: Int, maxIndex: Int): Int {
        val safeMin = minIndex.coerceAtLeast(0)
        val safeMax = maxIndex.coerceAtLeast(safeMin)
        if (safeMax == safeMin) return if (index > 0) 100 else 0
        val clampedIndex = index.coerceIn(safeMin, safeMax)
        val pct = ((clampedIndex - safeMin) * 100.0) / (safeMax - safeMin)
        return pct.roundToInt().coerceIn(0, 100)
    }

    fun normalizeAction(raw: String?): String {
        return when (raw?.trim()?.lowercase().orEmpty()) {
            "up", "increase", "raise", "louder", "higher" -> "up"
            "down", "decrease", "lower", "quieter", "softer" -> "down"
            "set", "percent", "level", "exact" -> "set"
            "mute", "silent", "silence" -> "mute"
            "unmute", "restore" -> "unmute"
            "max", "full", "maximum" -> "max"
            "status", "check", "get" -> "status"
            else -> "status"
        }
    }

    /**
     * Backward-compatible parser supporting both legacy plain actions ("up", "down", "mute")
     * and structured JSON payloads ({"action":"set","percent":50,"stream":"ring"}).
     */
    fun parseBridgeVolumeRequest(
        actionOrJson: String,
        streamOverride: String? = null,
        percentOverride: Int? = null
    ): ParsedVolumeRequest {
        val trimmed = actionOrJson.trim()
        if (trimmed.startsWith("{")) {
            try {
                val obj = JSONObject(trimmed)
                val rawAction = obj.optString("action", "status")
                val rawStream = streamOverride?.ifBlank { null } ?: obj.optString("stream", "media")
                val parsedPct: Int? = when {
                    percentOverride != null -> clampPercent(percentOverride)
                    obj.has("percent") && !obj.isNull("percent") -> {
                        val strVal = normalizeDigits(obj.opt("percent")?.toString().orEmpty()).trim()
                        strVal.toIntOrNull()?.let { clampPercent(it) }
                    }
                    else -> null
                }
                val normAction = if (parsedPct != null && rawAction.isBlank()) "set" else normalizeAction(rawAction)
                return ParsedVolumeRequest(
                    action = normAction,
                    stream = VolumeStreamType.fromRaw(rawStream),
                    percent = parsedPct
                )
            } catch (_: Exception) {
                // Fall through to plain action parsing
            }
        }

        val normalizedInput = normalizeDigits(trimmed)
        val inlinePct = Regex("\\b(\\d{1,3})\\s*%?\\b").find(normalizedInput)?.groupValues?.getOrNull(1)?.toIntOrNull()
        val finalPct = (percentOverride ?: inlinePct)?.let { clampPercent(it) }
        val action = if (finalPct != null && (trimmed.lowercase().startsWith("set") || inlinePct != null)) {
            "set"
        } else {
            normalizeAction(trimmed)
        }
        return ParsedVolumeRequest(
            action = action,
            stream = VolumeStreamType.fromRaw(streamOverride),
            percent = finalPct
        )
    }
}
