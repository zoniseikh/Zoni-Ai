package com.zoni.jarvis.assistant.db

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

/**
 * Local Android Room Database for Zoni AI.
 * Preserves conversations across upgrades (NEVER uses destructive migration in production)
 * and enforces privacy-by-default (callRecordingDefaultOff = true).
 */
@Database(
    entities = [
        CallSessionEntity::class,
        CallSummaryEntity::class,
        ConversationEntity::class,
        MemoryEntity::class,
        TaskExecutionEntity::class,
        ConsentRecordEntity::class,
        UserPreferencesEntity::class
    ],
    version = 2,
    exportSchema = false
)
abstract class ZoniDatabase : RoomDatabase() {
    abstract fun callSessionDao(): CallSessionDao
    abstract fun conversationDao(): ConversationDao
    abstract fun memoryDao(): MemoryDao
    abstract fun taskExecutionDao(): TaskExecutionDao
    abstract fun consentRecordDao(): ConsentRecordDao
    abstract fun userPreferencesDao(): UserPreferencesDao

    companion object {
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

        fun getInstance(context: Context): ZoniDatabase {
            return INSTANCE ?: synchronized(this) {
                INSTANCE ?: Room.databaseBuilder(
                    context.applicationContext,
                    ZoniDatabase::class.java,
                    "zoni_ai_local.db"
                )
                    .addMigrations(MIGRATION_1_2)
                    .build()
                    .also { INSTANCE = it }
            }
        }
    }
}
