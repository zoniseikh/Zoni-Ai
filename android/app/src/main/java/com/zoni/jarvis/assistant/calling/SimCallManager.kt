package com.zoni.jarvis.assistant.calling

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import androidx.core.content.ContextCompat
import com.zoni.jarvis.assistant.action.DeviceActionExecutor
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
 * Native Android SIM Call & Contact-Based WhatsApp Manager:
 * - Outgoing SIM calls & contact resolution via ContactCallManager (ContactsContract + Telecom/Dialer)
 * - Direct SIM calling when 1 contact + 1 valid phone number matches (no unnecessary confirmation)
 * - Honest disambiguation for missing contacts, multiple matching contacts, or multiple phone numbers
 * - Contact-based WhatsApp draft preparation via official WhatsApp intent (never claiming message was sent)
 * - Local SIM call session history persisted in Room ZoniDatabase
 */
class SimCallManager(
    private val context: Context,
    private val contactCallManager: ContactCallManager = ContactCallManager(context),
    private val deviceActionExecutor: DeviceActionExecutor = DeviceActionExecutor(context),
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

    /**
     * Resolves a contact name or phone number and places a direct SIM call when unambiguous.
     * Never claims the call connected — honestly reports whether ACTION_CALL or dialer was launched.
     */
    fun resolveAndCallContactAsJson(queryOrNumber: String): String {
        val raw = queryOrNumber.trim()
        if (raw.isEmpty()) {
            return JSONObject()
                .put("status", "missing_target")
                .put("message", "Please provide a contact name or phone number to call.")
                .toString()
        }

        val hasDirectCallPerm = ContextCompat.checkSelfPermission(
            context,
            Manifest.permission.CALL_PHONE
        ) == PackageManager.PERMISSION_GRANTED

        val norm = NumberNormalizer.normalizePhoneNumber(raw)
        if (norm is NumberNormalizerResult.ValidCandidate) {
            val started = initiateSimCallAndLog(norm.normalizedNumber, norm.normalizedNumber)
            return JSONObject()
                .put("status", if (started) "call_initiated" else "failed")
                .put("usedDirectCall", hasDirectCallPerm)
                .put("contactName", norm.normalizedNumber)
                .put("phoneNumber", norm.normalizedNumber)
                .put(
                    "message",
                    if (started) {
                        if (hasDirectCallPerm) "Initiating SIM call to ${norm.normalizedNumber}."
                        else "Opened Android dialer with ${norm.normalizedNumber}."
                    } else "Could not start the Android phone dialer."
                )
                .toString()
        }

        return when (val resolved = contactCallManager.resolveContact(raw)) {
            is ContactCallResolution.ReadyToCall -> {
                val started = initiateSimCallAndLog(resolved.number, resolved.name)
                JSONObject()
                    .put("status", if (started) "call_initiated" else "failed")
                    .put("usedDirectCall", hasDirectCallPerm)
                    .put("contactName", resolved.name)
                    .put("phoneNumber", resolved.number)
                    .put(
                        "message",
                        if (started) {
                            if (hasDirectCallPerm) "Initiating SIM call to ${resolved.name} (${resolved.number})."
                            else "Opened Android dialer for ${resolved.name} (${resolved.number})."
                        } else "Could not initiate call to ${resolved.name}."
                    )
                    .toString()
            }
            is ContactCallResolution.MultipleNumbersForContact -> {
                val nums = JSONArray()
                resolved.numbers.forEach { nums.put(it) }
                JSONObject()
                    .put("status", "multiple_numbers")
                    .put("contactName", resolved.name)
                    .put("numbers", nums)
                    .put("message", "${resolved.name} has multiple phone numbers. Which number should I call?")
                    .toString()
            }
            is ContactCallResolution.MultipleMatches -> {
                val candidates = JSONArray()
                resolved.candidates.take(6).forEach { c ->
                    candidates.put(
                        JSONObject()
                            .put("id", c.id)
                            .put("name", c.displayName)
                            .put("phone", c.phoneNumbers.firstOrNull().orEmpty())
                    )
                }
                JSONObject()
                    .put("status", "multiple_contacts")
                    .put("query", resolved.query)
                    .put("candidates", candidates)
                    .put("message", "Multiple contacts match \"${resolved.query}\". Please clarify who to call.")
                    .toString()
            }
            is ContactCallResolution.ContactNotFound -> JSONObject()
                .put("status", "contact_not_found")
                .put("query", resolved.query)
                .put("message", "I could not find \"${resolved.query}\" in your Android contacts. Please share the phone number.")
                .toString()
            is ContactCallResolution.PermissionMissing -> JSONObject()
                .put("status", "permission_missing")
                .put("permission", Manifest.permission.READ_CONTACTS)
                .put("message", "Contacts permission (READ_CONTACTS) is needed to look up \"${raw}\".")
                .toString()
            is ContactCallResolution.CallFailed -> JSONObject()
                .put("status", "failed")
                .put("message", resolved.reason)
                .toString()
        }
    }

    /**
     * Resolves a contact name or number and opens WhatsApp with a prefilled draft message.
     * NEVER claims the message was sent automatically — the user reviews and taps Send.
     */
    fun prepareWhatsAppForContactAsJson(contactOrNumber: String, message: String): String {
        val raw = contactOrNumber.trim()
        val draft = message.trim()

        val norm = NumberNormalizer.normalizePhoneNumber(raw)
        if (norm is NumberNormalizerResult.ValidCandidate) {
            val opened = deviceActionExecutor.openWhatsApp(norm.normalizedNumber, draft)
            return JSONObject()
                .put("status", if (opened) "draft_opened" else "failed")
                .put("contactName", norm.normalizedNumber)
                .put("phoneNumber", norm.normalizedNumber)
                .put("messageText", draft)
                .put(
                    "message",
                    if (opened) "Prepared your WhatsApp draft for ${norm.normalizedNumber}. Review and tap Send in WhatsApp."
                    else "Could not open WhatsApp on this device."
                )
                .toString()
        }

        if (raw.isEmpty()) {
            val opened = deviceActionExecutor.openWhatsApp("", draft)
            return JSONObject()
                .put("status", if (opened) "draft_opened" else "failed")
                .put("messageText", draft)
                .put(
                    "message",
                    if (opened) "Opened WhatsApp with your draft message. Choose a contact and tap Send."
                    else "Could not open WhatsApp."
                )
                .toString()
        }

        return when (val resolved = contactCallManager.resolveContact(raw)) {
            is ContactCallResolution.ReadyToCall -> {
                val opened = deviceActionExecutor.openWhatsApp(resolved.number, draft)
                JSONObject()
                    .put("status", if (opened) "draft_opened" else "failed")
                    .put("contactName", resolved.name)
                    .put("phoneNumber", resolved.number)
                    .put("messageText", draft)
                    .put(
                        "message",
                        if (opened) "Prepared your WhatsApp message for ${resolved.name}. Please review and tap Send."
                        else "Could not open WhatsApp for ${resolved.name}."
                    )
                    .toString()
            }
            is ContactCallResolution.MultipleNumbersForContact -> {
                val nums = JSONArray()
                resolved.numbers.forEach { nums.put(it) }
                JSONObject()
                    .put("status", "multiple_numbers")
                    .put("contactName", resolved.name)
                    .put("numbers", nums)
                    .put("message", "${resolved.name} has multiple numbers. Which one should I open in WhatsApp?")
                    .toString()
            }
            is ContactCallResolution.MultipleMatches -> {
                val candidates = JSONArray()
                resolved.candidates.take(6).forEach { c ->
                    candidates.put(
                        JSONObject()
                            .put("id", c.id)
                            .put("name", c.displayName)
                            .put("phone", c.phoneNumbers.firstOrNull().orEmpty())
                    )
                }
                JSONObject()
                    .put("status", "multiple_contacts")
                    .put("query", resolved.query)
                    .put("candidates", candidates)
                    .put("message", "Multiple contacts match \"${resolved.query}\". Please choose which recipient to message on WhatsApp.")
                    .toString()
            }
            is ContactCallResolution.ContactNotFound -> JSONObject()
                .put("status", "contact_not_found")
                .put("query", resolved.query)
                .put("message", "I could not find \"${resolved.query}\" in your contacts. Please share their phone number.")
                .toString()
            is ContactCallResolution.PermissionMissing -> JSONObject()
                .put("status", "permission_missing")
                .put("permission", Manifest.permission.READ_CONTACTS)
                .put("message", "Contacts permission (READ_CONTACTS) is needed to look up \"${raw}\" for WhatsApp.")
                .toString()
            is ContactCallResolution.CallFailed -> JSONObject()
                .put("status", "failed")
                .put("message", resolved.reason)
                .toString()
        }
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
                        state = "dialed",
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
