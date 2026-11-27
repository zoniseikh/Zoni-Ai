package com.zoni.jarvis.assistant.db

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.PBEKeySpec
import javax.crypto.spec.SecretKeySpec

/**
 * Structured write verification outcome returned for every permanent conversation save.
 * Never silently hides storage failures.
 */
data class WriteVerificationResult(
    val success: Boolean,
    val verified: Boolean,
    val messageId: String,
    val conversationId: String,
    val errorCode: String = "",
    val errorMessage: String = "",
    val queuedForRecovery: Boolean = false
)

data class DatabaseHealthSnapshot(
    val healthy: Boolean,
    val integrityStatus: String,
    val lowStorage: Boolean,
    val availableBytes: Long,
    val pendingRecoveryCount: Int,
    val totalConversations: Int,
    val totalMemories: Int,
    val encryptedAtRest: Boolean,
    val lastWriteError: String = ""
)

data class BackupExportResult(
    val success: Boolean,
    val encryptedArchiveJson: String = "",
    val messageCount: Int = 0,
    val memoryCount: Int = 0,
    val error: String = ""
)

data class BackupRestoreResult(
    val success: Boolean,
    val restoredMessages: Int = 0,
    val restoredMemories: Int = 0,
    val skippedSensitive: Int = 0,
    val error: String = ""
)

data class PlainBackupPayload(
    val formatVersion: Int = FORMAT_VERSION,
    val exportedAtMs: Long = System.currentTimeMillis(),
    val conversations: List<DecryptedConversationRecord>,
    val memories: List<DecryptedMemoryRecord>
) {
    companion object {
        const val FORMAT_VERSION = 1
    }
}

/**
 * Pure JVM-testable PBKDF2-HMAC-SHA256 + AES-256-GCM authenticated backup encryption engine.
 *
 * Uses standard `java.util.Base64` + JCE (`PBKDF2WithHmacSHA256` / `AES/GCM/NoPadding`) so it
 * executes identically in both Android runtime and pure JVM JUnit tests, and is 100% wire-compatible
 * with the TypeScript Web Crypto implementation in `src/utils/permanentMemoryBackup.ts`.
 */
object PermanentMemoryBackupCrypto {

    const val BACKUP_FORMAT_TAG = "zoni_permanent_backup_v1"
    const val KDF_NAME = "PBKDF2-SHA256"
    const val CIPHER_NAME = "AES-256-GCM"
    const val DEFAULT_ITERATIONS = 120_000
    const val MIN_PASSPHRASE_LENGTH = 8
    private const val SALT_BYTES = 16
    private const val IV_BYTES = 12
    private const val KEY_BITS = 256
    private const val GCM_TAG_BITS = 128

    fun encryptBackupPayload(
        payload: PlainBackupPayload,
        passphrase: String,
        iterations: Int = DEFAULT_ITERATIONS
    ): BackupExportResult {
        val cleanPass = passphrase.trim()
        if (cleanPass.length < MIN_PASSPHRASE_LENGTH) {
            return BackupExportResult(
                success = false,
                error = "Passphrase must be at least $MIN_PASSPHRASE_LENGTH characters."
            )
        }
        return try {
            val safeConversations = payload.conversations.filter {
                !LocalMemoryLogic.containsSensitiveSecret(it.text)
            }
            val safeMemories = payload.memories.filter {
                !LocalMemoryLogic.containsSensitiveSecret(it.value)
            }

            val plainJson = serializePlainPayload(
                payload.copy(conversations = safeConversations, memories = safeMemories)
            )
            val salt = ByteArray(SALT_BYTES).also { SecureRandom().nextBytes(it) }
            val iv = ByteArray(IV_BYTES).also { SecureRandom().nextBytes(it) }
            val keyBytes = deriveKey(cleanPass, salt, iterations)

            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(keyBytes, "AES"), GCMParameterSpec(GCM_TAG_BITS, iv))
            val ciphertext = cipher.doFinal(plainJson.toByteArray(Charsets.UTF_8))

            val envelope = JSONObject()
                .put("format", BACKUP_FORMAT_TAG)
                .put("formatVersion", PlainBackupPayload.FORMAT_VERSION)
                .put("kdf", KDF_NAME)
                .put("cipher", CIPHER_NAME)
                .put("iterations", iterations)
                .put("saltB64", Base64.getEncoder().encodeToString(salt))
                .put("ivB64", Base64.getEncoder().encodeToString(iv))
                .put("ciphertextB64", Base64.getEncoder().encodeToString(ciphertext))
                .put("exportedAtMs", payload.exportedAtMs)
                .put("messageCount", safeConversations.size)
                .put("memoryCount", safeMemories.size)

            BackupExportResult(
                success = true,
                encryptedArchiveJson = envelope.toString(),
                messageCount = safeConversations.size,
                memoryCount = safeMemories.size
            )
        } catch (e: Exception) {
            BackupExportResult(
                success = false,
                error = "Encrypted backup export failed: ${e.javaClass.simpleName}"
            )
        }
    }

    fun decryptBackupPayload(
        encryptedArchiveJson: String,
        passphrase: String
    ): Pair<PlainBackupPayload?, String> {
        val cleanPass = passphrase.trim()
        if (cleanPass.isEmpty()) {
            return null to "Passphrase is required to decrypt the backup."
        }
        return try {
            val envelope = JSONObject(encryptedArchiveJson)
            if (envelope.optString("format") != BACKUP_FORMAT_TAG) {
                return null to "Unrecognized backup format. Expected ZONI encrypted backup file."
            }
            val iterations = envelope.optInt("iterations", DEFAULT_ITERATIONS).coerceIn(10_000, 600_000)
            val salt = Base64.getDecoder().decode(envelope.getString("saltB64"))
            val iv = Base64.getDecoder().decode(envelope.getString("ivB64"))
            val ciphertext = Base64.getDecoder().decode(envelope.getString("ciphertextB64"))
            if (salt.size < 8 || iv.size != IV_BYTES || ciphertext.size <= 16) {
                return null to "Corrupted backup envelope metadata."
            }

            val keyBytes = deriveKey(cleanPass, salt, iterations)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(keyBytes, "AES"), GCMParameterSpec(GCM_TAG_BITS, iv))
            val plainBytes = cipher.doFinal(ciphertext)
            val payload = parsePlainPayload(String(plainBytes, Charsets.UTF_8))
            payload to ""
        } catch (_: javax.crypto.AEADBadTagException) {
            null to "Incorrect passphrase or corrupted/tampered backup file."
        } catch (e: Exception) {
            null to "Backup decryption failed: ${e.javaClass.simpleName}"
        }
    }

    private fun deriveKey(passphrase: String, salt: ByteArray, iterations: Int): ByteArray {
        val spec = PBEKeySpec(passphrase.toCharArray(), salt, iterations, KEY_BITS)
        val factory = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256")
        return factory.generateSecret(spec).encoded
    }

    fun serializePlainPayload(payload: PlainBackupPayload): String {
        val convArr = JSONArray()
        for (c in payload.conversations) {
            convArr.put(
                JSONObject()
                    .put("id", c.id)
                    .put("conversationId", c.conversationId)
                    .put("role", c.role)
                    .put("text", c.text)
                    .put("language", c.language)
                    .put("createdAtMs", c.createdAtMs)
                    .put("inputType", c.inputType)
                    .put("commandName", c.commandName)
                    .put("executionStatus", c.executionStatus)
                    .put("dateBucket", c.dateBucket)
            )
        }
        val memArr = JSONArray()
        for (m in payload.memories) {
            memArr.put(
                JSONObject()
                    .put("id", m.id)
                    .put("category", m.category)
                    .put("factKey", m.factKey)
                    .put("value", m.value)
                    .put("searchKeywords", m.searchKeywords)
                    .put("usageCount", m.usageCount)
                    .put("userApproved", m.userApproved)
                    .put("createdAtMs", m.createdAtMs)
                    .put("updatedAtMs", m.updatedAtMs)
                    .put("sourceConversationId", m.sourceConversationId)
                    .put("sourceMessageId", m.sourceMessageId)
                    .put("status", m.status)
                    .put("correctionHistoryJson", m.correctionHistoryJson)
            )
        }
        return JSONObject()
            .put("formatVersion", payload.formatVersion)
            .put("exportedAtMs", payload.exportedAtMs)
            .put("conversations", convArr)
            .put("memories", memArr)
            .toString()
    }

    fun parsePlainPayload(rawJson: String): PlainBackupPayload {
        val root = JSONObject(rawJson)
        val convArr = root.optJSONArray("conversations") ?: JSONArray()
        val conversations = mutableListOf<DecryptedConversationRecord>()
        for (i in 0 until convArr.length()) {
            val obj = convArr.optJSONObject(i) ?: continue
            val id = obj.optString("id").trim()
            val text = obj.optString("text").trim()
            if (id.isEmpty() || text.isEmpty()) continue
            val ts = obj.optLong("createdAtMs", System.currentTimeMillis())
            conversations.add(
                DecryptedConversationRecord(
                    id = id,
                    conversationId = obj.optString("conversationId", "restored").ifBlank { "restored" },
                    role = if (obj.optString("role") == "assistant") "assistant" else "user",
                    text = text,
                    language = obj.optString("language", "bn-BD").ifBlank { "bn-BD" },
                    createdAtMs = ts,
                    inputType = if (obj.optString("inputType") == "voice") "voice" else "text",
                    commandName = obj.optString("commandName", ""),
                    executionStatus = obj.optString("executionStatus", ""),
                    dateBucket = obj.optString("dateBucket", "").ifBlank { LocalMemoryLogic.formatDateBucket(ts) }
                )
            )
        }

        val memArr = root.optJSONArray("memories") ?: JSONArray()
        val memories = mutableListOf<DecryptedMemoryRecord>()
        for (i in 0 until memArr.length()) {
            val obj = memArr.optJSONObject(i) ?: continue
            val id = obj.optString("id").trim()
            val factKey = obj.optString("factKey").trim()
            val value = obj.optString("value").trim()
            if (id.isEmpty() || factKey.isEmpty() || value.isEmpty()) continue
            memories.add(
                DecryptedMemoryRecord(
                    id = id,
                    category = obj.optString("category", LocalMemoryLogic.CATEGORY_PERSONAL_FACT),
                    factKey = factKey,
                    value = value,
                    searchKeywords = obj.optString("searchKeywords", LocalMemoryLogic.buildSearchKeywords(value)),
                    usageCount = obj.optInt("usageCount", 1).coerceAtLeast(1),
                    userApproved = obj.optBoolean("userApproved", true),
                    createdAtMs = obj.optLong("createdAtMs", System.currentTimeMillis()),
                    updatedAtMs = obj.optLong("updatedAtMs", System.currentTimeMillis()),
                    sourceConversationId = obj.optString("sourceConversationId", ""),
                    sourceMessageId = obj.optString("sourceMessageId", ""),
                    status = obj.optString("status", "active"),
                    correctionHistoryJson = obj.optString("correctionHistoryJson", "[]")
                )
            )
        }

        return PlainBackupPayload(
            formatVersion = root.optInt("formatVersion", PlainBackupPayload.FORMAT_VERSION),
            exportedAtMs = root.optLong("exportedAtMs", System.currentTimeMillis()),
            conversations = conversations,
            memories = memories
        )
    }
}

/**
 * App-private encrypted file fallback spool used ONLY if Room SQLite fails (e.g., disk full,
 * transient lock, or database corruption) so a finalized conversation message is NEVER silently
 * discarded. Recovered automatically on next successful repository write or startup.
 */
class EncryptedPendingWriteSpool(
    private val spoolFile: File,
    private val encryptor: (String) -> Pair<String, Boolean>,
    private val decryptor: (String, Boolean) -> String
) {
    @Synchronized
    fun append(record: DecryptedConversationRecord): Boolean {
        return try {
            if (LocalMemoryLogic.containsSensitiveSecret(record.text)) return false
            val json = JSONObject()
                .put("id", record.id)
                .put("conversationId", record.conversationId)
                .put("role", record.role)
                .put("text", record.text)
                .put("language", record.language)
                .put("createdAtMs", record.createdAtMs)
                .put("inputType", record.inputType)
                .put("commandName", record.commandName)
                .put("executionStatus", record.executionStatus)
                .put("dateBucket", record.dateBucket)
                .toString()
            val (stored, encrypted) = encryptor(json)
            val line = JSONObject()
                .put("encrypted", encrypted)
                .put("payload", stored)
                .toString()
            spoolFile.parentFile?.mkdirs()
            spoolFile.appendText("$line\n", Charsets.UTF_8)
            true
        } catch (_: Exception) {
            false
        }
    }

    @Synchronized
    fun readAll(): List<DecryptedConversationRecord> {
        if (!spoolFile.exists()) return emptyList()
        return try {
            spoolFile.readLines(Charsets.UTF_8).mapNotNull { line ->
                val trimmed = line.trim()
                if (trimmed.isEmpty()) return@mapNotNull null
                val wrapper = JSONObject(trimmed)
                val encrypted = wrapper.optBoolean("encrypted", false)
                val payload = wrapper.optString("payload", "")
                val plainJson = decryptor(payload, encrypted)
                if (plainJson.isBlank()) return@mapNotNull null
                val obj = JSONObject(plainJson)
                val ts = obj.optLong("createdAtMs", System.currentTimeMillis())
                DecryptedConversationRecord(
                    id = obj.optString("id"),
                    conversationId = obj.optString("conversationId", "recovered"),
                    role = obj.optString("role", "user"),
                    text = obj.optString("text"),
                    language = obj.optString("language", "bn-BD"),
                    createdAtMs = ts,
                    inputType = obj.optString("inputType", "voice"),
                    commandName = obj.optString("commandName", ""),
                    executionStatus = obj.optString("executionStatus", ""),
                    dateBucket = obj.optString("dateBucket", LocalMemoryLogic.formatDateBucket(ts))
                )
            }
        } catch (_: Exception) {
            emptyList()
        }
    }

    @Synchronized
    fun count(): Int {
        if (!spoolFile.exists()) return 0
        return try {
            spoolFile.readLines(Charsets.UTF_8).count { it.isNotBlank() }
        } catch (_: Exception) {
            0
        }
    }

    @Synchronized
    fun rewriteRemaining(remaining: List<DecryptedConversationRecord>) {
        try {
            if (remaining.isEmpty()) {
                if (spoolFile.exists()) spoolFile.delete()
                return
            }
            val tmp = File(spoolFile.parentFile, "${spoolFile.name}.tmp")
            tmp.writeText("", Charsets.UTF_8)
            for (rec in remaining) {
                val json = JSONObject()
                    .put("id", rec.id)
                    .put("conversationId", rec.conversationId)
                    .put("role", rec.role)
                    .put("text", rec.text)
                    .put("language", rec.language)
                    .put("createdAtMs", rec.createdAtMs)
                    .put("inputType", rec.inputType)
                    .put("commandName", rec.commandName)
                    .put("executionStatus", rec.executionStatus)
                    .put("dateBucket", rec.dateBucket)
                    .toString()
                val (stored, encrypted) = encryptor(json)
                val line = JSONObject()
                    .put("encrypted", encrypted)
                    .put("payload", stored)
                    .toString()
                tmp.appendText("$line\n", Charsets.UTF_8)
            }
            tmp.renameTo(spoolFile)
        } catch (_: Exception) {
            // Preserve existing spool if atomic rewrite fails
        }
    }
}
