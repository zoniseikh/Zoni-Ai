package com.zoni.jarvis.assistant.db

import androidx.room.Entity
import androidx.room.ForeignKey
import androidx.room.Index
import androidx.room.PrimaryKey

@Entity(tableName = "call_sessions")
data class CallSessionEntity(
    @PrimaryKey val id: String,
    val channel: String, // "sim"
    val direction: String, // "outgoing" | "incoming"
    val targetName: String,
    val phoneNumber: String,
    val purpose: String,
    val language: String,
    val state: String,
    val provider: String,
    val providerCallSid: String? = null,
    val recordingEnabled: Boolean = false, // Privacy default: NEVER record calls by default
    val durationSeconds: Int = 0,
    val createdAtMs: Long = System.currentTimeMillis(),
    val endedAtMs: Long? = null
)

@Entity(
    tableName = "call_summaries",
    foreignKeys = [
        ForeignKey(
            entity = CallSessionEntity::class,
            parentColumns = ["id"],
            childColumns = ["sessionId"],
            onDelete = ForeignKey.CASCADE
        )
    ],
    indices = [Index("sessionId")]
)
data class CallSummaryEntity(
    @PrimaryKey val sessionId: String,
    val summaryText: String,
    val outcome: String,
    val actionItemsJson: String = "[]",
    val generatedBy: String = "deterministic",
    val createdAtMs: Long = System.currentTimeMillis()
)

/**
 * Permanent conversation archive row stored in Android Room (app-private internal storage).
 * NEVER automatically pruned or expired.
 *
 * Positional compatibility note: The first 5 constructor parameters (`id`, `role`, `text`,
 * `language`, `createdAtMs`) remain in their original order so all existing callers and tests
 * continue working seamlessly.
 */
@Entity(
    tableName = "conversations",
    indices = [
        Index(value = ["createdAtMs"], name = "index_conversations_createdAtMs"),
        Index(value = ["role"], name = "index_conversations_role"),
        Index(value = ["conversationId"], name = "index_conversations_conversationId"),
        Index(value = ["dateBucket"], name = "index_conversations_dateBucket"),
        Index(value = ["inputType"], name = "index_conversations_inputType"),
        Index(value = ["searchTokens"], name = "index_conversations_searchTokens")
    ]
)
data class ConversationEntity(
    @PrimaryKey val id: String,
    val role: String, // "user" | "assistant"
    val text: String, // AES-256-GCM ciphertext (`enc:v1:...`) when isEncrypted == true
    val language: String = "bn-BD",
    val createdAtMs: Long = System.currentTimeMillis(),
    val conversationId: String = "default",
    val inputType: String = "text", // "voice" | "text"
    val commandName: String = "",
    val executionStatus: String = "",
    val dateBucket: String = "", // "YYYY-MM-DD" in local/IST calendar date
    val searchTokens: String = "", // Normalized non-secret search index tokens (bn/hi/en + topic tags)
    val isEncrypted: Boolean = false
)

/**
 * Structured long-term memory index (facts, preferences, ongoing tasks, language, frequent commands).
 * Linked back to original conversation/message IDs and supports user corrections without
 * ever replacing or deleting the original conversation archive.
 */
@Entity(
    tableName = "memory_entries",
    indices = [
        Index(value = ["factKey"], unique = true, name = "index_memory_entries_factKey"),
        Index(value = ["category"], name = "index_memory_entries_category"),
        Index(value = ["updatedAtMs"], name = "index_memory_entries_updatedAtMs"),
        Index(value = ["sourceConversationId"], name = "index_memory_entries_sourceConversationId")
    ]
)
data class MemoryEntity(
    @PrimaryKey val id: String,
    val category: String, // "language" | "preference" | "personal_fact" | "ongoing_task" | "frequent_command" | "context"
    val factKey: String,
    val valueEncrypted: String,
    val isEncrypted: Boolean = true,
    val searchKeywords: String = "",
    val usageCount: Int = 1,
    val userApproved: Boolean = true,
    val createdAtMs: Long = System.currentTimeMillis(),
    val updatedAtMs: Long = System.currentTimeMillis(),
    val sourceConversationId: String = "",
    val sourceMessageId: String = "",
    val status: String = "active", // "active" | "completed" | "superseded"
    val correctionHistoryJson: String = "[]"
)

/**
 * Reliable pending-write recovery table for interrupted Gemini Live sessions or transient DB errors.
 * Ensures no finalized conversation turn is silently lost.
 */
@Entity(
    tableName = "pending_conversation_writes",
    indices = [
        Index(value = ["createdAtMs"], name = "index_pending_writes_createdAtMs")
    ]
)
data class PendingWriteEntity(
    @PrimaryKey val id: String,
    val payloadEncrypted: String,
    val isEncrypted: Boolean = true,
    val retryCount: Int = 0,
    val lastError: String = "",
    val createdAtMs: Long = System.currentTimeMillis()
)

@Entity(tableName = "task_executions")
data class TaskExecutionEntity(
    @PrimaryKey val id: String,
    val rawInput: String,
    val toolName: String,
    val argsJson: String,
    val status: String, // "executed" | "awaiting_confirmation" | "permission_missing" | "blocked" | "failed"
    val spokenOutcome: String,
    val createdAtMs: Long = System.currentTimeMillis()
)

@Entity(tableName = "consent_records")
data class ConsentRecordEntity(
    @PrimaryKey val consentId: String,
    val sessionId: String,
    val authorizedByUser: Boolean,
    val aiIdentityDisclosed: Boolean,
    val recordingConsentGranted: Boolean = false,
    val disclosureScript: String,
    val authorizedAtMs: Long = System.currentTimeMillis()
)

@Entity(tableName = "user_preferences")
data class UserPreferencesEntity(
    @PrimaryKey val id: Int = 1,
    val selectedAffectionName: String = "Boss",
    val activeMode: String = "romantic",
    val activeLanguage: String = "bn-BD",
    val selectedVoice: String = "Kore",
    val voiceAutoPlay: Boolean = true,
    val voiceMuted: Boolean = false,
    val callRecordingDefaultOff: Boolean = true,
    val updatedAtMs: Long = System.currentTimeMillis()
)
