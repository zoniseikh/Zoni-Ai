package com.zoni.jarvis.assistant.calling

import android.content.Context
import com.zoni.jarvis.assistant.db.CallSessionEntity
import com.zoni.jarvis.assistant.db.CallSummaryEntity
import com.zoni.jarvis.assistant.db.ConsentRecordEntity
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
 * Unified Android Hybrid Call Orchestrator:
 * - SIM Calling: delegates to original ContactCallManager (ContactsContract + Telecom/Dialer)
 * - AI VoIP Calling: delegates to ZoniVoipTelecomManager (Android Core-Telecom) + consent records
 * - Persistence: logs every session, consent record, and summary into Room ZoniDatabase
 */
class HybridCallOrchestrator(
    context: Context,
    private val contactCallManager: ContactCallManager = ContactCallManager(context),
    private val voipTelecomManager: ZoniVoipTelecomManager = ZoniVoipTelecomManager(context),
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
        val norm = NumberNormalizer.normalizePhoneNumber(targetOrNumber)
        val numberToDial = when (norm) {
            is NumberNormalizerResult.ValidCandidate -> norm.normalizedNumber
            else -> targetOrNumber.trim()
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

    fun recordConsentAndStartVoip(
        sessionId: String,
        targetName: String,
        phoneNumber: String,
        purpose: String,
        disclosureScript: String,
        authorizedByUser: Boolean,
        aiIdentityDisclosed: Boolean,
        recordingConsentGranted: Boolean = false
    ): Boolean {
        if (!authorizedByUser || !aiIdentityDisclosed) {
            return false
        }

        scope.launch {
            database.consentRecordDao().insertConsent(
                ConsentRecordEntity(
                    consentId = "cns_${UUID.randomUUID().toString().take(10)}",
                    sessionId = sessionId,
                    authorizedByUser = true,
                    aiIdentityDisclosed = true,
                    recordingConsentGranted = recordingConsentGranted,
                    disclosureScript = disclosureScript
                )
            )
            database.callSessionDao().upsertSession(
                CallSessionEntity(
                    id = sessionId,
                    channel = "ai_voip",
                    direction = "outgoing",
                    targetName = targetName,
                    phoneNumber = phoneNumber,
                    purpose = purpose,
                    language = "bn-BD",
                    state = "active",
                    provider = "core_telecom_voip",
                    recordingEnabled = recordingConsentGranted
                )
            )
        }

        voipTelecomManager.startVoipTelecomSession(
            sessionId = sessionId,
            displayName = targetName,
            phoneAddress = phoneNumber,
            isIncoming = false,
            disclosureScript = disclosureScript
        ) {
            scope.launch {
                database.callSessionDao().upsertSummary(
                    CallSummaryEntity(
                        sessionId = sessionId,
                        summaryText = "AI VoIP call to $targetName ($phoneNumber) ended.",
                        outcome = "ENDED"
                    )
                )
            }
        }
        return true
    }

    fun endActiveVoipCall() {
        voipTelecomManager.endVoipTelecomSession()
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
                    .put("recordingEnabled", s.recordingEnabled)
                    .put("durationSeconds", s.durationSeconds)
                    .put("createdAtMs", s.createdAtMs)
            )
        }
        return arr.toString()
    }

    fun clearLocalCallHistory() {
        scope.launch {
            database.callSessionDao().deleteAllSessions()
            database.consentRecordDao().clearAll()
        }
    }
}
