package com.zoni.jarvis.assistant.db

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import kotlinx.coroutines.flow.Flow

data class DateBucketSummaryRow(
    val dateBucket: String,
    val messageCount: Int,
    val firstTimestampMs: Long,
    val lastTimestampMs: Long
)

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

/**
 * Permanent conversation archive DAO.
 * Intentionally has NO automatic pruning or retention deletion methods.
 * All queries are parameterized and paginated so 10,000+ / 100,000+ records
 * can be searched and navigated without loading the entire archive into RAM.
 */
@Dao
interface ConversationDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertMessage(message: ConversationEntity): Long

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertMessages(messages: List<ConversationEntity>)

    @Query("SELECT COUNT(*) FROM conversations WHERE id = :id")
    suspend fun existsById(id: String): Int

    @Query("SELECT * FROM conversations WHERE id = :id LIMIT 1")
    suspend fun findById(id: String): ConversationEntity?

    @Query("SELECT * FROM conversations ORDER BY createdAtMs ASC LIMIT :limit OFFSET :offset")
    suspend fun getMessagesAscendingPaged(limit: Int = 200, offset: Int = 0): List<ConversationEntity>

    @Query("SELECT * FROM conversations ORDER BY createdAtMs ASC LIMIT :limit")
    suspend fun getMessages(limit: Int = 200): List<ConversationEntity>

    @Query("SELECT * FROM conversations ORDER BY createdAtMs DESC LIMIT :limit OFFSET :offset")
    suspend fun getRecentMessagesPaged(limit: Int = 50, offset: Int = 0): List<ConversationEntity>

    @Query(
        "SELECT * FROM conversations " +
            "WHERE conversationId = :conversationId " +
            "ORDER BY createdAtMs ASC LIMIT :limit OFFSET :offset"
    )
    suspend fun getMessagesByConversationIdPaged(
        conversationId: String,
        limit: Int = 100,
        offset: Int = 0
    ): List<ConversationEntity>

    @Query(
        "SELECT * FROM conversations " +
            "WHERE dateBucket = :dateBucket " +
            "ORDER BY createdAtMs ASC LIMIT :limit OFFSET :offset"
    )
    suspend fun getMessagesByDateBucketPaged(
        dateBucket: String,
        limit: Int = 100,
        offset: Int = 0
    ): List<ConversationEntity>

    @Query(
        "SELECT * FROM conversations " +
            "WHERE createdAtMs BETWEEN :startMs AND :endMs " +
            "ORDER BY createdAtMs DESC LIMIT :limit OFFSET :offset"
    )
    suspend fun getMessagesByDateRangePaged(
        startMs: Long,
        endMs: Long,
        limit: Int = 100,
        offset: Int = 0
    ): List<ConversationEntity>

    /**
     * Indexed, parameterized paginated search across normalized multilingual tokens (`searchTokens`),
     * command names, and legacy unencrypted text, optionally bounded by a date window.
     */
    @Query(
        "SELECT * FROM conversations " +
            "WHERE (:startMs <= 0 OR createdAtMs >= :startMs) " +
            "AND (:endMs <= 0 OR createdAtMs <= :endMs) " +
            "AND (:inputType = '' OR inputType = :inputType) " +
            "AND (" +
            "(:t1 != '' AND (searchTokens LIKE '%' || :t1 || '%' OR commandName LIKE '%' || :t1 || '%' OR (isEncrypted = 0 AND text LIKE '%' || :t1 || '%'))) " +
            "OR (:t2 != '' AND (searchTokens LIKE '%' || :t2 || '%' OR commandName LIKE '%' || :t2 || '%' OR (isEncrypted = 0 AND text LIKE '%' || :t2 || '%'))) " +
            "OR (:t3 != '' AND (searchTokens LIKE '%' || :t3 || '%' OR commandName LIKE '%' || :t3 || '%' OR (isEncrypted = 0 AND text LIKE '%' || :t3 || '%'))) " +
            "OR (:t4 != '' AND (searchTokens LIKE '%' || :t4 || '%' OR commandName LIKE '%' || :t4 || '%' OR (isEncrypted = 0 AND text LIKE '%' || :t4 || '%'))) " +
            "OR (:t1 = '' AND :t2 = '' AND :t3 = '' AND :t4 = '')" +
            ") " +
            "ORDER BY createdAtMs DESC LIMIT :limit OFFSET :offset"
    )
    suspend fun searchMessagesPaged(
        t1: String,
        t2: String = "",
        t3: String = "",
        t4: String = "",
        startMs: Long = 0L,
        endMs: Long = 0L,
        inputType: String = "",
        limit: Int = 50,
        offset: Int = 0
    ): List<ConversationEntity>

    @Query(
        "SELECT dateBucket, COUNT(*) AS messageCount, MIN(createdAtMs) AS firstTimestampMs, MAX(createdAtMs) AS lastTimestampMs " +
            "FROM conversations " +
            "WHERE dateBucket != '' " +
            "GROUP BY dateBucket " +
            "ORDER BY dateBucket DESC LIMIT :limit OFFSET :offset"
    )
    suspend fun getDateBucketsPaged(limit: Int = 90, offset: Int = 0): List<DateBucketSummaryRow>

    @Query("SELECT * FROM conversations WHERE searchTokens LIKE '%' || :query || '%' OR (isEncrypted = 0 AND text LIKE '%' || :query || '%') ORDER BY createdAtMs DESC LIMIT :limit")
    suspend fun searchMessages(query: String, limit: Int = 20): List<ConversationEntity>

    @Query("SELECT COUNT(*) FROM conversations")
    suspend fun getMessageCount(): Int

    @Query("SELECT MIN(createdAtMs) FROM conversations")
    suspend fun getOldestTimestampMs(): Long?

    @Query("SELECT MAX(createdAtMs) FROM conversations")
    suspend fun getNewestTimestampMs(): Long?

    @Query("DELETE FROM conversations")
    suspend fun clearAll()
}

@Dao
interface MemoryDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertMemory(entry: MemoryEntity)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertMemories(entries: List<MemoryEntity>)

    @Query("SELECT * FROM memory_entries WHERE factKey = :factKey LIMIT 1")
    suspend fun findByFactKey(factKey: String): MemoryEntity?

    @Query("SELECT * FROM memory_entries WHERE userApproved = 1 ORDER BY usageCount DESC, updatedAtMs DESC LIMIT :limit OFFSET :offset")
    suspend fun getTopMemoriesPaged(limit: Int = 50, offset: Int = 0): List<MemoryEntity>

    @Query("SELECT * FROM memory_entries WHERE userApproved = 1 ORDER BY usageCount DESC, updatedAtMs DESC LIMIT :limit")
    suspend fun getTopMemories(limit: Int = 50): List<MemoryEntity>

    @Query("SELECT * FROM memory_entries WHERE category = :category AND userApproved = 1 ORDER BY usageCount DESC, updatedAtMs DESC LIMIT :limit")
    suspend fun getByCategory(category: String, limit: Int = 30): List<MemoryEntity>

    @Query("SELECT * FROM memory_entries WHERE sourceConversationId = :conversationId ORDER BY updatedAtMs DESC LIMIT :limit")
    suspend fun getBySourceConversationId(conversationId: String, limit: Int = 30): List<MemoryEntity>

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
interface PendingWriteDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun enqueue(entry: PendingWriteEntity)

    @Query("SELECT * FROM pending_conversation_writes ORDER BY createdAtMs ASC LIMIT :limit")
    suspend fun getPendingBatch(limit: Int = 50): List<PendingWriteEntity>

    @Query("SELECT COUNT(*) FROM pending_conversation_writes")
    suspend fun getPendingCount(): Int

    @Query("DELETE FROM pending_conversation_writes WHERE id = :id")
    suspend fun deleteById(id: String)

    @Query("DELETE FROM pending_conversation_writes")
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
