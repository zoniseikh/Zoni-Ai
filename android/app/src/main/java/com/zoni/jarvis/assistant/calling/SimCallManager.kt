package com.zoni.jarvis.assistant.calling

import android.content.Context
import com.zoni.jarvis.assistant.db.CallSessionEntity
import com.zoni.jarvis.assistant.db.ZoniDatabase
import com.zoni.jarvis.assistant.device.ContactCallManager
import com.zoni.jarvis.assistant.device.ContactCallResolution
import com.zoni.jarvis.assistant.domain.NumberNormalizer
import com.zoni.jarvis.assistant.domain.NumberNormalizerResult
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/**
 * Native Android SIM Call Manager:
 * - Outgoing SIM calls & contact resolution via ContactCallManager (ContactsContract + Telecom/Dialer)
 * - Local SIM call session history persisted in Room ZoniDatabase
 */
class SimCallManager(
    context: Context,
    private val contactCallManager: ContactCallManager = ContactCallManager(context),
    private val database: ZoniDatabase = ZoniDatabase.getInstance(context),
    private val scope: CoroutineScope = CoroutineScope(Dispatchers.IO)
) {
    fun searchContactsAsJson(query: String): String {
        val array = JSONArray()
        when (val res = contactCallManager.resolveContact(query)) {
            is ContactCallResolution.ReadyToCall -> {
                array.put(JSONObject().put("id", "1").put("name", res.name).put("phone", res.number))
            }
            is ContactCallResolution.MultipleNumbersForContact -> {
                res.numbers.forEachIndexed { idx, num ->
                    array.put(JSONObject().put("id", "$idx").put("name", res.name).put("phone", num))
                }
            }
            is ContactCallResolution.MultipleMatches -> {
                res.candidates.forEach { contact ->
                    contact.phoneNumbers.forEach { num ->
                        array.put(
                            JSONObject()
                                .put("id", contact.id)
                                .put("name", contact.displayName)
                                .put("phone", num)
                        )
                    }
                }
            }
            else -> Unit
        }
        return array.toString()
    }

    fun initiateSimCallAndLog(targetOrNumber: String, displayName: String = ""): Boolean {
        val raw = targetOrNumber.trim()
        if (raw.isEmpty()) return false

        val norm = NumberNormalizer.normalizePhoneNumber(raw)
        val numberToDial = when (norm) {
            is NumberNormalizerResult.ValidCandidate -> norm.normalizedNumber
            else -> {
                when (val resolved = contactCallManager.resolveContact(raw)) {
                    is ContactCallResolution.ReadyToCall -> resolved.number
                    is ContactCallResolution.MultipleNumbersForContact -> resolved.numbers.firstOrNull()
                    else -> null
                } ?: raw
            }
        }

        val started = contactCallManager.initiateCall(numberToDial)
        if (started) {
            val sessionId = "sim_${UUID.randomUUID().toString().take(12)}"
            scope.launch {
                database.callSessionDao().upsertSession(
                    CallSessionEntity(
                        id = sessionId,
                        channel = "sim",
                        direction = "outgoing",
                        targetName = displayName.ifBlank { numberToDial },
                        phoneNumber = numberToDial,
                        purpose = "Direct Android SIM call",
                        language = "bn-BD",
                        state = "active",
                        provider = "android_sim_telecom",
                        recordingEnabled = false
                    )
                )
            }
        }
        return started
    }

    suspend fun getLocalCallHistoryJson(limit: Int = 50): String {
        val sessions = database.callSessionDao().getRecentSessions(limit)
        val arr = JSONArray()
        for (s in sessions) {
            arr.put(
                JSONObject()
                    .put("id", s.id)
                    .put("channel", s.channel)
                    .put("direction", s.direction)
                    .put("targetName", s.targetName)
                    .put("phoneNumber", s.phoneNumber)
                    .put("purpose", s.purpose)
                    .put("state", s.state)
                    .put("provider", s.provider)
                    .put("durationSeconds", s.durationSeconds)
                    .put("createdAtMs", s.createdAtMs)
            )
        }
        return arr.toString()
    }

    fun clearLocalCallHistory() {
        scope.launch {
            database.callSessionDao().deleteAllSessions()
        }
    }
}
