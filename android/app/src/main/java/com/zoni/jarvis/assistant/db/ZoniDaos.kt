package com.zoni.jarvis.assistant.db

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import kotlinx.coroutines.flow.Flow

@Dao
interface CallSessionDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertSession(session: CallSessionEntity)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertSummary(summary: CallSummaryEntity)

    @Query("SELECT * FROM call_sessions ORDER BY createdAtMs DESC LIMIT :limit")
    suspend fun getRecentSessions(limit: Int = 50): List<CallSessionEntity>

    @Query("SELECT * FROM call_sessions ORDER BY createdAtMs DESC LIMIT :limit")
    fun observeRecentSessions(limit: Int = 50): Flow<List<CallSessionEntity>>

    @Query("SELECT * FROM call_summaries WHERE sessionId = :sessionId LIMIT 1")
    suspend fun getSummaryForSession(sessionId: String): CallSummaryEntity?

    @Query("DELETE FROM call_sessions")
    suspend fun deleteAllSessions()
}

@Dao
interface ConversationDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertMessage(message: ConversationEntity)

    @Query("SELECT * FROM conversations ORDER BY createdAtMs ASC LIMIT :limit")
    suspend fun getMessages(limit: Int = 200): List<ConversationEntity>

    @Query("DELETE FROM conversations")
    suspend fun clearAll()
}

@Dao
interface TaskExecutionDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun logExecution(entry: TaskExecutionEntity)

    @Query("SELECT * FROM task_executions ORDER BY createdAtMs DESC LIMIT :limit")
    suspend fun getRecentTasks(limit: Int = 50): List<TaskExecutionEntity>

    @Query("DELETE FROM task_executions")
    suspend fun clearAll()
}

@Dao
interface ConsentRecordDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertConsent(record: ConsentRecordEntity)

    @Query("SELECT * FROM consent_records WHERE sessionId = :sessionId LIMIT 1")
    suspend fun getConsentForSession(sessionId: String): ConsentRecordEntity?

    @Query("DELETE FROM consent_records")
    suspend fun clearAll()
}

@Dao
interface UserPreferencesDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(prefs: UserPreferencesEntity)

    @Query("SELECT * FROM user_preferences WHERE id = 1 LIMIT 1")
    suspend fun getPreferences(): UserPreferencesEntity?
}
