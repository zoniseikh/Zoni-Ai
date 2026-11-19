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
        TaskExecutionEntity::class,
        ConsentRecordEntity::class,
        UserPreferencesEntity::class
    ],
    version = 1,
    exportSchema = false
)
abstract class ZoniDatabase : RoomDatabase() {
    abstract fun callSessionDao(): CallSessionDao
    abstract fun conversationDao(): ConversationDao
    abstract fun taskExecutionDao(): TaskExecutionDao
    abstract fun consentRecordDao(): ConsentRecordDao
    abstract fun userPreferencesDao(): UserPreferencesDao

    companion object {
        @Volatile
        private var INSTANCE: ZoniDatabase? = null

        /**
         * Preserves existing conversations & call history across future schema upgrades.
         */
        val MIGRATION_1_2 = object : Migration(1, 2) {
            override fun migrate(db: SupportSQLiteDatabase) {
                // Non-destructive forward migration hook preserving existing conversations
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
