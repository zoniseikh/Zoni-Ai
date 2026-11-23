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

        val rawError = "Failed connecting to wss://generativelanguage.googleapis.com/ws?key=$sampleKey using $sampleKey"
        val safe = SecureKeyManager.sanitizeSecret(rawError, sampleKey)
        assertFalse(safe.contains(sampleKey))
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
        assertEquals(
            "Kore",
            setup.getJSONObject("generationConfig")
                .getJSONObject("speechConfig")
                .getJSONObject("voiceConfig")
                .getJSONObject("prebuiltVoiceConfig")
                .getString("voiceName")
        )

        val audioJson = JSONObject(ZoniLiveSessionClient.buildDirectAudioPayload("AAAA"))
        val mediaChunk = audioJson.getJSONObject("realtimeInput").getJSONArray("mediaChunks").getJSONObject(0)
        assertEquals("audio/pcm;rate=16000", mediaChunk.getString("mimeType"))
        assertEquals("AAAA", mediaChunk.getString("data"))

        val textJson = JSONObject(ZoniLiveSessionClient.buildDirectClientTextPayload("Hello Zoni"))
        val clientContent = textJson.getJSONObject("clientContent")
        assertTrue(clientContent.getBoolean("turnComplete"))
        assertEquals(
            "Hello Zoni",
            clientContent.getJSONArray("turns").getJSONObject(0).getJSONArray("parts").getJSONObject(0).getString("text")
        )
    }
}
