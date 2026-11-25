package com.zoni.jarvis.assistant

import com.zoni.jarvis.assistant.data.SecureKeyManager
import com.zoni.jarvis.assistant.domain.CompanionMode
import com.zoni.jarvis.assistant.domain.SupportedLanguage
import com.zoni.jarvis.assistant.domain.VoiceProfile
import com.zoni.jarvis.assistant.network.ZoniLiveSessionClient
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure JVM regression tests for Pure Gemini BYOK architecture on Android:
 * 1. Gemini API key validation (accepts valid keys, rejects empty/whitespace/URLs/short keys)
 * 2. Non-reversible key masking (never reveals full saved key)
 * 3. Secret redaction in logs and error strings
 * 4. Official Google Gemini Live WebSocket setup/audio/text payloads (zero custom backend URL)
 */
class GeminiByokConfigTest {

    private val sampleKey = "AIzaSyAndroidByokTestKey0000000000001234"

    @Test
    fun validateApiKeyFormatEnforcesByokKeyRulesAndRejectsBackendUrls() {
        val valid = SecureKeyManager.validateApiKeyFormat("  $sampleKey  ")
        assertTrue(valid.valid)
        assertEquals(sampleKey, valid.normalizedKey)

        // Google Cloud / Vertex Express Gemini key format (contains dot)
        val aqKey = "AQ.Ab8RN6AndroidByokTestKey000000009876"
        val validAq = SecureKeyManager.validateApiKeyFormat("\uFEFF\"$aqKey\u200B\"")
        assertTrue(validAq.valid)
        assertEquals(aqKey, validAq.normalizedKey)

        // Env-prefixed paste
        val fromEnv = SecureKeyManager.validateApiKeyFormat("GEMINI_API_KEY=$sampleKey")
        assertTrue(fromEnv.valid)
        assertEquals(sampleKey, fromEnv.normalizedKey)

        assertFalse(SecureKeyManager.validateApiKeyFormat("").valid)
        assertFalse(SecureKeyManager.validateApiKeyFormat("   ").valid)
        assertFalse(SecureKeyManager.validateApiKeyFormat("https://zoni-backend.example.run.app").valid)
        assertFalse(SecureKeyManager.validateApiKeyFormat("AIza short key").valid)
        assertFalse(SecureKeyManager.validateApiKeyFormat("AIzaShort").valid)
    }

    @Test
    fun maskApiKeyAndSanitizeSecretNeverExposeRawKey() {
        val masked = SecureKeyManager.maskApiKey(sampleKey)
        assertEquals("AIza••••••••1234", masked)
        assertFalse(masked.contains("AndroidByokTestKey"))

        val aqKey = "AQ.Ab8RN6AndroidByokTestKey000000009876"
        assertEquals("AQ.A••••••••9876", SecureKeyManager.maskApiKey(aqKey))

        val rawError = "Failed connecting to wss://generativelanguage.googleapis.com/ws?key=$sampleKey using $sampleKey and $aqKey"
        val safe = SecureKeyManager.sanitizeSecret(rawError, sampleKey)
        assertFalse(safe.contains(sampleKey))
        assertFalse(safe.contains(aqKey))
        assertTrue(safe.contains("[REDACTED_API_KEY]"))
    }

    @Test
    fun directGeminiLiveUsesOfficialGoogleEndpointAndBuildsValidSetupAudioAndTextPayloads() {
        assertTrue(ZoniLiveSessionClient.GEMINI_LIVE_WS_ENDPOINT.startsWith("wss://generativelanguage.googleapis.com/"))
        assertFalse(ZoniLiveSessionClient.GEMINI_LIVE_WS_ENDPOINT.contains("run.app"))
        assertFalse(ZoniLiveSessionClient.GEMINI_LIVE_WS_ENDPOINT.contains("?key="))

        val setupJson = JSONObject(
            ZoniLiveSessionClient.buildDirectSetupPayload(
                model = "gemini-2.5-flash-native-audio-preview-12-2025",
                mode = CompanionMode.ROMANTIC,
                affectionName = "Boss",
                voice = VoiceProfile.KORE,
                language = SupportedLanguage.BENGALI,
                resumptionHandle = "resume-123"
            )
        )
        val setup = setupJson.getJSONObject("setup")
        assertEquals("models/gemini-2.5-flash-native-audio-preview-12-2025", setup.getString("model"))
        assertEquals("resume-123", setup.getJSONObject("sessionResumption").getString("handle"))
        val aad = setup.getJSONObject("realtimeInputConfig").getJSONObject("automaticActivityDetection")
        assertFalse(aad.getBoolean("disabled"))
        assertEquals("START_SENSITIVITY_HIGH", aad.getString("startOfSpeechSensitivity"))
        assertEquals("END_SENSITIVITY_HIGH", aad.getString("endOfSpeechSensitivity"))
        assertEquals(120, aad.getInt("prefixPaddingMs"))
        assertEquals(320, aad.getInt("silenceDurationMs"))
        assertEquals(
            "Kore",
            setup.getJSONObject("generationConfig")
                .getJSONObject("speechConfig")
                .getJSONObject("voiceConfig")
                .getJSONObject("prebuiltVoiceConfig")
                .getString("voiceName")
        )

        val audioJson = JSONObject(ZoniLiveSessionClient.buildDirectAudioPayload("AAAA"))
        val audio = audioJson.getJSONObject("realtimeInput").getJSONObject("audio")
        assertEquals("audio/pcm;rate=16000", audio.getString("mimeType"))
        assertEquals("AAAA", audio.getString("data"))

        val streamEndJson = JSONObject(ZoniLiveSessionClient.buildDirectAudioStreamEndPayload())
        assertTrue(streamEndJson.getJSONObject("realtimeInput").getBoolean("audioStreamEnd"))

        val textJson = JSONObject(ZoniLiveSessionClient.buildDirectClientTextPayload("Hello Zoni"))
        val clientContent = textJson.getJSONObject("clientContent")
        assertTrue(clientContent.getBoolean("turnComplete"))
        assertEquals(
            "Hello Zoni",
            clientContent.getJSONArray("turns").getJSONObject(0).getJSONArray("parts").getJSONObject(0).getString("text")
        )
    }
}
