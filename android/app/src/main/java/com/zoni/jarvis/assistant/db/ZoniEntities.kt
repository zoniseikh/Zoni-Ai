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

@Entity(tableName = "conversations")
data class ConversationEntity(
    @PrimaryKey val id: String,
    val role: String, // "user" | "assistant"
    val text: String,
    val language: String = "bn-BD",
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
