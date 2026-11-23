package com.zoni.jarvis.assistant

import com.zoni.jarvis.assistant.action.VolumeControlMath
import com.zoni.jarvis.assistant.action.VolumeStreamType
import com.zoni.jarvis.assistant.network.ZoniLiveSessionClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure JVM unit tests for:
 * 1. Perfect multi-stream volume math (Bengali/Hindi/English digit normalization, 0..100 clamping,
 *    index<->percent conversion, and backward-compatible bridge JSON parsing)
 * 2. Gemini Live WebSocket close-code classification and jittered exponential backoff bounds
 */
class VolumeAndLiveReconnectTest {

    @Test
    fun volumeControlMathNormalizesMultilingualDigitsAndClampsPercentages() {
        assertEquals("50", VolumeControlMath.normalizeDigits("৫০"))
        assertEquals("75", VolumeControlMath.normalizeDigits("७५"))
        assertEquals("100", VolumeControlMath.normalizeDigits("১০০"))
        assertEquals(0, VolumeControlMath.clampPercent(-25))
        assertEquals(100, VolumeControlMath.clampPercent(180))
        assertEquals(42, VolumeControlMath.clampPercent(42))
    }

    @Test
    fun volumeControlMathConvertsPercentToStreamIndexAndBackAccurately() {
        // Typical Android STREAM_MUSIC range: 0..15
        assertEquals(0, VolumeControlMath.percentToStreamIndex(0, 0, 15))
        assertEquals(8, VolumeControlMath.percentToStreamIndex(50, 0, 15))
        assertEquals(15, VolumeControlMath.percentToStreamIndex(100, 0, 15))
        assertEquals(15, VolumeControlMath.percentToStreamIndex(150, 0, 15))

        // Typical Android STREAM_VOICE_CALL range with minIndex = 1, maxIndex = 7
        assertEquals(1, VolumeControlMath.percentToStreamIndex(0, 1, 7))
        assertEquals(4, VolumeControlMath.percentToStreamIndex(50, 1, 7))
        assertEquals(7, VolumeControlMath.percentToStreamIndex(100, 1, 7))

        assertEquals(0, VolumeControlMath.streamIndexToPercent(1, 1, 7))
        assertEquals(50, VolumeControlMath.streamIndexToPercent(4, 1, 7))
        assertEquals(100, VolumeControlMath.streamIndexToPercent(7, 1, 7))
    }

    @Test
    fun volumeControlMathParsesLegacyPlainStringsAndStructuredMultiStreamJson() {
        val legacyUp = VolumeControlMath.parseBridgeVolumeRequest("up")
        assertEquals("up", legacyUp.action)
        assertEquals(VolumeStreamType.MEDIA, legacyUp.stream)
        assertEquals(null, legacyUp.percent)

        val ringSet = VolumeControlMath.parseBridgeVolumeRequest(
            """{"action":"set","percent":80,"stream":"ring"}"""
        )
        assertEquals("set", ringSet.action)
        assertEquals(VolumeStreamType.RING, ringSet.stream)
        assertEquals(80, ringSet.percent)

        val bengaliJson = VolumeControlMath.parseBridgeVolumeRequest(
            """{"action":"set","percent":"৫০","stream":"অ্যালার্ম"}"""
        )
        assertEquals("set", bengaliJson.action)
        assertEquals(VolumeStreamType.ALARM, bengaliJson.stream)
        assertEquals(50, bengaliJson.percent)

        val clamped = VolumeControlMath.parseBridgeVolumeRequest(
            """{"action":"set","percent":250,"stream":"notification"}"""
        )
        assertEquals(VolumeStreamType.NOTIFICATION, clamped.stream)
        assertEquals(100, clamped.percent)

        assertEquals(VolumeStreamType.CALL, VolumeStreamType.fromRaw("call"))
    }

    @Test
    fun liveSessionClientClassifiesCloseCodesAndComputesBoundedJitteredBackoff() {
        val normal = ZoniLiveSessionClient.classifyCloseCode(1000, "Client closed")
        assertFalse(normal.retryable)
        assertEquals("normal", normal.category)

        val authFail = ZoniLiveSessionClient.classifyCloseCode(4001, "Missing API key")
        assertFalse(authFail.retryable)
        assertTrue(authFail.shouldClearHandle)
        assertEquals("auth_or_config", authFail.category)

        val restart = ZoniLiveSessionClient.classifyCloseCode(1012, "Upstream rotated")
        assertTrue(restart.retryable)
        assertFalse(restart.shouldClearHandle)
        assertEquals("service_restart", restart.category)

        val expired = ZoniLiveSessionClient.classifyCloseCode(1011, "Resumption handle expired")
        assertTrue(expired.retryable)
        assertTrue(expired.shouldClearHandle)

        // Deterministic backoff when jitterFraction == 0
        val base0 = ZoniLiveSessionClient.computeReconnectDelayMs(0, 1500L, 15_000L, 0.0)
        assertEquals(1500L, base0)

        // Symmetric +/-25% jitter bounds around 2400ms (attempt = 1, base = 1500, factor = 1.6)
        val low = ZoniLiveSessionClient.computeReconnectDelayMs(1, 1500L, 15_000L, 0.25, 0.0)
        val high = ZoniLiveSessionClient.computeReconnectDelayMs(1, 1500L, 15_000L, 0.25, 1.0)
        assertEquals(1800L, low)
        assertEquals(3000L, high)
    }
}
