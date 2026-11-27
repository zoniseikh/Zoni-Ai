package com.zoni.jarvis.assistant.db

import android.content.Context
import android.os.StatFs
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase
import java.io.File

/**
 * Local Android Room Database for Zoni AI (App-Private Internal Storage).
 *
 * Guarantees:
 * - Non-destructive migrations ONLY (v1 -> v2 -> v3); NEVER uses `fallbackToDestructiveMigration()`.
 * - WAL (Write-Ahead Logging) mode enabled for safe concurrent reads/writes from UI and background service.
 * - Permanent conversation retention with zero automatic expiry or message count pruning.
 */
@Database(
    entities = [
        CallSessionEntity::class,
        CallSummaryEntity::class,
        ConversationEntity::class,
        MemoryEntity::class,
        PendingWriteEntity::class,
        TaskExecutionEntity::class,
        ConsentRecordEntity::class,
        UserPreferencesEntity::class
    ],
    version = 3,
    exportSchema = false
)
abstract class ZoniDatabase : RoomDatabase() {
    abstract fun callSessionDao(): CallSessionDao
    abstract fun conversationDao(): ConversationDao
    abstract fun memoryDao(): MemoryDao
    abstract fun pendingWriteDao(): PendingWriteDao
    abstract fun taskExecutionDao(): TaskExecutionDao
    abstract fun consentRecordDao(): ConsentRecordDao
    abstract fun userPreferencesDao(): UserPreferencesDao

    /**
     * Runs SQLite's built-in `PRAGMA quick_check` to verify structural database integrity
     * without reading or logging any private user conversation content.
     */
    fun checkIntegrity(): Pair<Boolean, String> {
        return try {
            val cursor = openHelper.readableDatabase.query("PRAGMA quick_check")
            cursor.use { c ->
                if (c.moveToFirst()) {
                    val result = c.getString(0)?.trim().orEmpty()
                    if (result.equals("ok", ignoreCase = true)) {
                        true to "ok"
                    } else {
                        false to "integrity_failed:$result"
                    }
                } else {
                    false to "integrity_empty_result"
                }
            }
        } catch (e: Exception) {
            false to "integrity_exception:${e.javaClass.simpleName}"
        }
    }

    companion object {
        const val DB_NAME = "zoni_ai_local.db"
        const val MIN_SAFE_STORAGE_BYTES = 16L * 1024L * 1024L // 16 MB safety threshold

        @Volatile
        private var INSTANCE: ZoniDatabase? = null

        /**
         * Non-destructive migration from version 1 to version 2.
         * Preserves 100% of existing conversations, call history, tasks, consents, and preferences,
         * adds performance indices on conversations, and creates the encrypted local memory_entries table.
         */
        val MIGRATION_1_2 = object : Migration(1, 2) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL(
                    "CREATE INDEX IF NOT EXISTS `index_conversations_createdAtMs` ON `conversations` (`createdAtMs`)"
                )
                db.execSQL(
                    "CREATE INDEX IF NOT EXISTS `index_conversations_role` ON `conversations` (`role`)"
                )
                db.execSQL(
                    "CREATE TABLE IF NOT EXISTS `memory_entries` (" +
                        "`id` TEXT NOT NULL, " +
                        "`category` TEXT NOT NULL, " +
                        "`factKey` TEXT NOT NULL, " +
                        "`valueEncrypted` TEXT NOT NULL, " +
                        "`isEncrypted` INTEGER NOT NULL, " +
                        "`searchKeywords` TEXT NOT NULL, " +
                        "`usageCount` INTEGER NOT NULL, " +
                        "`userApproved` INTEGER NOT NULL, " +
                        "`createdAtMs` INTEGER NOT NULL, " +
                        "`updatedAtMs` INTEGER NOT NULL, " +
                        "PRIMARY KEY(`id`)" +
                        ")"
                )
                db.execSQL(
                    "CREATE UNIQUE INDEX IF NOT EXISTS `index_memory_entries_factKey` ON `memory_entries` (`factKey`)"
                )
                db.execSQL(
                    "CREATE INDEX IF NOT EXISTS `index_memory_entries_category` ON `memory_entries` (`category`)"
                )
                db.execSQL(
                    "CREATE INDEX IF NOT EXISTS `index_memory_entries_updatedAtMs` ON `memory_entries` (`updatedAtMs`)"
                )
            }
        }

        /**
         * Non-destructive migration from version 2 to version 3 (Permanent Conversation Memory System).
         * - Preserves 100% of existing conversations and memory_entries.
         * - Adds complete conversation metadata columns (`conversationId`, `inputType`, `commandName`,
         *   `executionStatus`, `dateBucket`, `searchTokens`, `isEncrypted`) with safe defaults.
         * - Backfills `dateBucket` (IST/local YYYY-MM-DD) and `searchTokens` for pre-existing v2 rows.
         * - Adds source conversation linkage & correction history columns to `memory_entries`.
         * - Creates `pending_conversation_writes` table for interrupted-session & failed-write recovery.
         * - Creates performance indices for timestamps, conversationId, dateBucket, inputType, searchTokens.
         */
        val MIGRATION_2_3 = object : Migration(2, 3) {
            override fun migrate(db: SupportSQLiteDatabase) {
                // 1. Extend conversations table non-destructively
                db.execSQL("ALTER TABLE `conversations` ADD COLUMN `conversationId` TEXT NOT NULL DEFAULT 'legacy_v2'")
                db.execSQL("ALTER TABLE `conversations` ADD COLUMN `inputType` TEXT NOT NULL DEFAULT 'text'")
                db.execSQL("ALTER TABLE `conversations` ADD COLUMN `commandName` TEXT NOT NULL DEFAULT ''")
                db.execSQL("ALTER TABLE `conversations` ADD COLUMN `executionStatus` TEXT NOT NULL DEFAULT ''")
                db.execSQL("ALTER TABLE `conversations` ADD COLUMN `dateBucket` TEXT NOT NULL DEFAULT ''")
                db.execSQL("ALTER TABLE `conversations` ADD COLUMN `searchTokens` TEXT NOT NULL DEFAULT ''")
                db.execSQL("ALTER TABLE `conversations` ADD COLUMN `isEncrypted` INTEGER NOT NULL DEFAULT 0")

                // Backfill dateBucket (IST +05:30) and lowercase searchTokens for legacy v2 rows
                db.execSQL(
                    "UPDATE `conversations` " +
                        "SET `dateBucket` = strftime('%Y-%m-%d', (`createdAtMs` / 1000) + 19800, 'unixepoch') " +
                        "WHERE `dateBucket` = '' AND `createdAtMs` > 0"
                )
                db.execSQL(
                    "UPDATE `conversations` " +
                        "SET `searchTokens` = lower(substr(`text`, 1, 512)) " +
                        "WHERE `searchTokens` = '' AND `isEncrypted` = 0"
                )

                db.execSQL("CREATE INDEX IF NOT EXISTS `index_conversations_conversationId` ON `conversations` (`conversationId`)")
                db.execSQL("CREATE INDEX IF NOT EXISTS `index_conversations_dateBucket` ON `conversations` (`dateBucket`)")
                db.execSQL("CREATE INDEX IF NOT EXISTS `index_conversations_inputType` ON `conversations` (`inputType`)")
                db.execSQL("CREATE INDEX IF NOT EXISTS `index_conversations_searchTokens` ON `conversations` (`searchTokens`)")

                // 2. Extend memory_entries with sourceConversationId, sourceMessageId, status, correctionHistoryJson
                db.execSQL("ALTER TABLE `memory_entries` ADD COLUMN `sourceConversationId` TEXT NOT NULL DEFAULT ''")
                db.execSQL("ALTER TABLE `memory_entries` ADD COLUMN `sourceMessageId` TEXT NOT NULL DEFAULT ''")
                db.execSQL("ALTER TABLE `memory_entries` ADD COLUMN `status` TEXT NOT NULL DEFAULT 'active'")
                db.execSQL("ALTER TABLE `memory_entries` ADD COLUMN `correctionHistoryJson` TEXT NOT NULL DEFAULT '[]'")
                db.execSQL("CREATE INDEX IF NOT EXISTS `index_memory_entries_sourceConversationId` ON `memory_entries` (`sourceConversationId`)")

                // 3. Create pending_conversation_writes recovery table
                db.execSQL(
                    "CREATE TABLE IF NOT EXISTS `pending_conversation_writes` (" +
                        "`id` TEXT NOT NULL, " +
                        "`payloadEncrypted` TEXT NOT NULL, " +
                        "`isEncrypted` INTEGER NOT NULL, " +
                        "`retryCount` INTEGER NOT NULL, " +
                        "`lastError` TEXT NOT NULL, " +
                        "`createdAtMs` INTEGER NOT NULL, " +
                        "PRIMARY KEY(`id`)" +
                        ")"
                )
                db.execSQL(
                    "CREATE INDEX IF NOT EXISTS `index_pending_writes_createdAtMs` ON `pending_conversation_writes` (`createdAtMs`)"
                )
            }
        }

        fun getAvailableInternalStorageBytes(context: Context): Long {
            return try {
                val stat = StatFs(context.filesDir.absolutePath)
                stat.availableBytes
            } catch (_: Exception) {
                Long.MAX_VALUE
            }
        }

        fun getDatabaseFile(context: Context): File = context.getDatabasePath(DB_NAME)

        fun getInstance(context: Context): ZoniDatabase {
            return INSTANCE ?: synchronized(this) {
                INSTANCE ?: Room.databaseBuilder(
                    context.applicationContext,
                    ZoniDatabase::class.java,
                    DB_NAME
                )
                    .addMigrations(MIGRATION_1_2, MIGRATION_2_3)
                    .setJournalMode(JournalMode.WRITE_AHEAD_LOGGING)
                    .build()
                    .also { INSTANCE = it }
            }
        }
    }
}
