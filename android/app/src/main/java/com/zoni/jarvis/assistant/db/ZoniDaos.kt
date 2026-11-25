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

    @Query("SELECT * FROM conversations ORDER BY createdAtMs DESC LIMIT :limit OFFSET :offset")
    suspend fun getRecentMessagesPaged(limit: Int = 50, offset: Int = 0): List<ConversationEntity>

    @Query("SELECT * FROM conversations WHERE text LIKE '%' || :query || '%' ORDER BY createdAtMs DESC LIMIT :limit")
    suspend fun searchMessages(query: String, limit: Int = 20): List<ConversationEntity>

    @Query("SELECT COUNT(*) FROM conversations")
    suspend fun getMessageCount(): Int

    @Query(
        "DELETE FROM conversations WHERE id NOT IN (" +
            "SELECT id FROM conversations ORDER BY createdAtMs DESC LIMIT :maxRows" +
            ")"
    )
    suspend fun pruneToRecent(maxRows: Int = 500)

    @Query("DELETE FROM conversations")
    suspend fun clearAll()
}

@Dao
interface MemoryDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertMemory(entry: MemoryEntity)

    @Query("SELECT * FROM memory_entries WHERE factKey = :factKey LIMIT 1")
    suspend fun findByFactKey(factKey: String): MemoryEntity?

    @Query("SELECT * FROM memory_entries WHERE userApproved = 1 ORDER BY usageCount DESC, updatedAtMs DESC LIMIT :limit")
    suspend fun getTopMemories(limit: Int = 50): List<MemoryEntity>

    @Query("SELECT * FROM memory_entries WHERE category = :category AND userApproved = 1 ORDER BY usageCount DESC, updatedAtMs DESC LIMIT :limit")
    suspend fun getByCategory(category: String, limit: Int = 30): List<MemoryEntity>

    @Query("SELECT * FROM memory_entries WHERE searchKeywords LIKE '%' || :keyword || '%' AND userApproved = 1 ORDER BY usageCount DESC, updatedAtMs DESC LIMIT :limit")
    suspend fun searchByKeyword(keyword: String, limit: Int = 20): List<MemoryEntity>

    @Query("DELETE FROM memory_entries WHERE factKey = :factKey")
    suspend fun deleteByFactKey(factKey: String)

    @Query("DELETE FROM memory_entries WHERE category = :category")
    suspend fun deleteByCategory(category: String)

    @Query("SELECT COUNT(*) FROM memory_entries")
    suspend fun getMemoryCount(): Int

    @Query("DELETE FROM memory_entries")
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
