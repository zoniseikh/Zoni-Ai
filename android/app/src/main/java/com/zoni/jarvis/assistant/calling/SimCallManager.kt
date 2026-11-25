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
import com.zoni.jarvis.assistant.device.SmartContactMatcher
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
        val seenPhoneKeys = HashSet<String>()
        val matches = contactCallManager.searchContactsByPrefix(query)
        for (contact in matches) {
            SmartContactMatcher.deduplicatePhoneNumbers(contact.phoneNumbers).forEach { num ->
                val phoneKey = SmartContactMatcher.canonicalPhoneKey(num)
                if (phoneKey.isNotEmpty() && seenPhoneKeys.add(phoneKey)) {
                    array.put(
                        JSONObject()
                            .put("id", contact.id)
                            .put("name", contact.displayName)
                            .put("phone", num)
                    )
                }
            }
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

    // ============================================================================================
    // INCOMING & ACTIVE PHONE CALL CONTROL (TelecomManager + ZoniInCallService + TelephonyManager)
    // Least-privileged compliant implementation — NO duplicate call services.
    // ============================================================================================

    @Volatile
    private var telephonyCallbackRegistered = false
    private var activeTelephonyCallback: Any? = null

    fun hasReadPhoneStatePermission(): Boolean =
        ContextCompat.checkSelfPermission(context, Manifest.permission.READ_PHONE_STATE) ==
            PackageManager.PERMISSION_GRANTED

    fun hasAnswerPhoneCallsPermission(): Boolean =
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
            ContextCompat.checkSelfPermission(context, Manifest.permission.ANSWER_PHONE_CALLS) ==
                PackageManager.PERMISSION_GRANTED
        } else {
            true
        }

    fun isDefaultDialerRoleHeld(): Boolean {
        return try {
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.Q) {
                val roleManager = context.getSystemService(Context.ROLE_SERVICE) as? android.app.role.RoleManager
                roleManager?.isRoleHeld(android.app.role.RoleManager.ROLE_DIALER) == true
            } else {
                val tm = context.getSystemService(Context.TELECOM_SERVICE) as? android.telecom.TelecomManager
                tm?.defaultDialerPackage == context.packageName
            }
        } catch (_: Exception) {
            false
        }
    }

    fun createDialerRoleRequestIntent(): android.content.Intent? {
        return try {
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.Q) {
                val roleManager = context.getSystemService(Context.ROLE_SERVICE) as? android.app.role.RoleManager
                if (roleManager != null && roleManager.isRoleAvailable(android.app.role.RoleManager.ROLE_DIALER)) {
                    roleManager.createRequestRoleIntent(android.app.role.RoleManager.ROLE_DIALER)
                } else null
            } else {
                android.content.Intent(android.telecom.TelecomManager.ACTION_CHANGE_DEFAULT_DIALER).apply {
                    putExtra(android.telecom.TelecomManager.EXTRA_CHANGE_DEFAULT_DIALER_PACKAGE_NAME, context.packageName)
                }
            }
        } catch (_: Exception) {
            null
        }
    }

    /**
     * Registers a real-time Android Telephony call-state listener (guarded by READ_PHONE_STATE)
     * to detect RINGING / OFFHOOK / IDLE transitions and pause wake-word audio cleanly during calls.
     */
    fun startCallStateMonitoring(onStateChanged: ((String) -> Unit)? = null) {
        if (telephonyCallbackRegistered || !hasReadPhoneStatePermission()) return
        val tm = context.getSystemService(Context.TELEPHONY_SERVICE) as? android.telephony.TelephonyManager ?: return
        try {
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.S) {
                val cb = object : android.telephony.TelephonyCallback(),
                    android.telephony.TelephonyCallback.CallStateListener {
                    override fun onCallStateChanged(state: Int) {
                        handleTelephonyCallStateInt(state, onStateChanged)
                    }
                }
                tm.registerTelephonyCallback(context.mainExecutor, cb)
                activeTelephonyCallback = cb
                telephonyCallbackRegistered = true
            } else {
                @Suppress("DEPRECATION")
                val listener = object : android.telephony.PhoneStateListener() {
                    @Deprecated("Deprecated in Java")
                    override fun onCallStateChanged(state: Int, phoneNumber: String?) {
                        val label = mapTelephonyState(state)
                        CallStateHub.reportTelephonyState(label, phoneNumber.orEmpty())
                        coordinateWakeWordWithCallState(label)
                        onStateChanged?.invoke(getIncomingCallStatusAsJson())
                    }
                }
                @Suppress("DEPRECATION")
                tm.listen(listener, android.telephony.PhoneStateListener.LISTEN_CALL_STATE)
                activeTelephonyCallback = listener
                telephonyCallbackRegistered = true
            }
        } catch (_: Exception) {
            telephonyCallbackRegistered = false
        }
    }

    fun stopCallStateMonitoring() {
        if (!telephonyCallbackRegistered) return
        val tm = context.getSystemService(Context.TELEPHONY_SERVICE) as? android.telephony.TelephonyManager ?: return
        try {
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.S) {
                val cb = activeTelephonyCallback as? android.telephony.TelephonyCallback
                if (cb != null) tm.unregisterTelephonyCallback(cb)
            } else {
                @Suppress("DEPRECATION")
                val listener = activeTelephonyCallback as? android.telephony.PhoneStateListener
                if (listener != null) {
                    @Suppress("DEPRECATION")
                    tm.listen(listener, android.telephony.PhoneStateListener.LISTEN_NONE)
                }
            }
        } catch (_: Exception) {
        }
        activeTelephonyCallback = null
        telephonyCallbackRegistered = false
    }

    private fun mapTelephonyState(state: Int): String = when (state) {
        android.telephony.TelephonyManager.CALL_STATE_RINGING -> "RINGING"
        android.telephony.TelephonyManager.CALL_STATE_OFFHOOK -> "ACTIVE"
        else -> "IDLE"
    }

    private fun handleTelephonyCallStateInt(state: Int, onStateChanged: ((String) -> Unit)?) {
        val label = mapTelephonyState(state)
        CallStateHub.reportTelephonyState(label)
        coordinateWakeWordWithCallState(label)
        onStateChanged?.invoke(getIncomingCallStatusAsJson())
    }

    private fun coordinateWakeWordWithCallState(stateLabel: String) {
        if (stateLabel == "RINGING" || stateLabel == "ACTIVE") {
            com.zoni.jarvis.assistant.service.ZoniForegroundService.pauseWakeWordForConversation(
                context,
                com.zoni.jarvis.assistant.wakeword.VoiceLifecycleState.IDLE
            )
        } else if (stateLabel == "IDLE" || stateLabel == "DISCONNECTED") {
            com.zoni.jarvis.assistant.service.ZoniForegroundService.resumeWakeWordAfterConversation(context)
        }
    }

    private fun queryCurrentCallStateLabel(): Pair<String, String> {
        val inCall = ZoniInCallService.simCallState.value
        if (ZoniInCallService.isServiceBound && inCall.stateLabel != "IDLE" && inCall.stateLabel != "DISCONNECTED") {
            return Pair(inCall.stateLabel, "in_call_service")
        }
        if (hasReadPhoneStatePermission()) {
            val tm = context.getSystemService(Context.TELEPHONY_SERVICE) as? android.telephony.TelephonyManager
            val rawState = try {
                if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.S) {
                    tm?.callStateForSubscription ?: android.telephony.TelephonyManager.CALL_STATE_IDLE
                } else {
                    @Suppress("DEPRECATION")
                    tm?.callState ?: android.telephony.TelephonyManager.CALL_STATE_IDLE
                }
            } catch (_: SecurityException) {
                android.telephony.TelephonyManager.CALL_STATE_IDLE
            }
            val label = mapTelephonyState(rawState)
            if (label != "IDLE") {
                return Pair(label, "telephony_state")
            }
        }
        val hubState = CallStateHub.telephonyCallState.value
        if (hubState == "RINGING" || hubState == "ACTIVE") {
            return Pair(hubState, "telephony_state")
        }
        val screenedAt = CallStateHub.screenedTimestampMs.value
        if (screenedAt > 0L && (System.currentTimeMillis() - screenedAt) < 20_000L && CallStateHub.screenedIncomingNumber.value.isNotBlank()) {
            return Pair("RINGING", "call_screening")
        }
        return Pair("IDLE", "none")
    }

    fun getIncomingCallStatusAsJson(lastError: String = ""): String {
        val hasReadState = hasReadPhoneStatePermission()
        val hasAnswer = hasAnswerPhoneCallsPermission()
        val isDialer = isDefaultDialerRoleHeld()
        val inCall = ZoniInCallService.simCallState.value
        val (stateLabel, source) = queryCurrentCallStateLabel()

        val isRinging = stateLabel == "RINGING"
        val isActive = stateLabel == "ACTIVE" || stateLabel == "DIALING" || stateLabel == "HOLDING"

        // Only expose caller info where permission / Telecom binding explicitly permits it
        val callerNumber = when {
            ZoniInCallService.isServiceBound && inCall.remoteNumber.isNotBlank() -> inCall.remoteNumber
            hasReadState && CallStateHub.screenedIncomingNumber.value.isNotBlank() -> CallStateHub.screenedIncomingNumber.value
            hasReadState && CallStateHub.telephonyNumber.value.isNotBlank() -> CallStateHub.telephonyNumber.value
            else -> ""
        }
        val callerName = if (ZoniInCallService.isServiceBound) inCall.callerDisplayName else ""

        val canAnswerByApi = ZoniInCallService.isServiceBound ||
            (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O && hasAnswer)
        val canEndByApi = ZoniInCallService.isServiceBound ||
            (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.P && hasAnswer)

        return JSONObject()
            .put("callState", stateLabel)
            .put("isIncomingRinging", isRinging)
            .put("isActiveCall", isActive)
            .put("callerNumber", callerNumber)
            .put("callerDisplayName", callerName)
            .put("canAnswer", isRinging && canAnswerByApi)
            .put("canReject", isRinging && canEndByApi)
            .put("canEnd", isActive && canEndByApi)
            .put("hasAnswerPermission", hasAnswer)
            .put("hasReadPhoneStatePermission", hasReadState)
            .put("isDefaultDialerRoleHeld", isDialer)
            .put("source", source)
            .put("lastError", lastError)
            .put("updatedAtMs", System.currentTimeMillis())
            .toString()
    }

    @android.annotation.SuppressLint("MissingPermission")
    fun answerIncomingCallAsJson(): String {
        val (currentState, _) = queryCurrentCallStateLabel()
        if (currentState != "RINGING") {
            return buildCallControlResultJson(
                success = false,
                verified = true,
                action = "answer",
                resultingCallState = currentState,
                status = "no_ringing_call",
                message = "No incoming ringing call is currently detected (current call state: $currentState)."
            )
        }

        // Path 1: Bound ZoniInCallService (when user granted ROLE_DIALER)
        if (ZoniInCallService.isServiceBound && ZoniInCallService.answerActiveCall()) {
            val (afterState, _) = queryCurrentCallStateLabel()
            return buildCallControlResultJson(
                success = true,
                verified = afterState == "ACTIVE" || afterState == "RINGING",
                action = "answer",
                resultingCallState = afterState,
                status = "call_answered",
                message = "Incoming call answered via Android InCallService."
            )
        }

        // Path 2: Least-privileged official Android TelecomManager.acceptRingingCall() (API 26+)
        if (!hasAnswerPhoneCallsPermission()) {
            return buildCallControlResultJson(
                success = false,
                verified = true,
                action = "answer",
                resultingCallState = currentState,
                status = "permission_missing",
                message = "Android ANSWER_PHONE_CALLS permission is required to answer incoming calls.",
                missingPermissions = listOf("ANSWER_PHONE_CALLS")
            )
        }

        if (android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.O) {
            return buildCallControlResultJson(
                success = false,
                verified = true,
                action = "answer",
                resultingCallState = currentState,
                status = "unsupported_android_version",
                message = "Programmatic call answering requires Android 8.0 (API 26) or higher."
            )
        }

        val tm = context.getSystemService(Context.TELECOM_SERVICE) as? android.telecom.TelecomManager
            ?: return buildCallControlResultJson(
                success = false,
                verified = false,
                action = "answer",
                resultingCallState = currentState,
                status = "telecom_unavailable",
                message = "Android TelecomManager is unavailable on this device."
            )

        return try {
            @Suppress("DEPRECATION")
            tm.acceptRingingCall()
            val (afterState, _) = queryCurrentCallStateLabel()
            buildCallControlResultJson(
                success = true,
                verified = true,
                action = "answer",
                resultingCallState = afterState,
                status = "call_answered",
                message = "Incoming call answered via Android TelecomManager."
            )
        } catch (e: SecurityException) {
            buildCallControlResultJson(
                success = false,
                verified = true,
                action = "answer",
                resultingCallState = currentState,
                status = "permission_missing",
                message = "Android denied answering the call: ${e.message}. Grant ANSWER_PHONE_CALLS or set Zoni AI as Default Dialer.",
                missingPermissions = listOf("ANSWER_PHONE_CALLS"),
                requiresDialerRole = true
            )
        } catch (e: Exception) {
            buildCallControlResultJson(
                success = false,
                verified = false,
                action = "answer",
                resultingCallState = currentState,
                status = "failed",
                message = "Failed to answer incoming call: ${e.message}"
            )
        }
    }

    @android.annotation.SuppressLint("MissingPermission")
    fun rejectIncomingCallAsJson(): String {
        val (currentState, _) = queryCurrentCallStateLabel()
        if (currentState != "RINGING") {
            return buildCallControlResultJson(
                success = false,
                verified = true,
                action = "reject",
                resultingCallState = currentState,
                status = "no_ringing_call",
                message = "No incoming ringing call is currently detected to reject (current state: $currentState)."
            )
        }

        // Path 1: Bound ZoniInCallService (ROLE_DIALER)
        if (ZoniInCallService.isServiceBound && ZoniInCallService.rejectIncomingCall()) {
            val (afterState, _) = queryCurrentCallStateLabel()
            return buildCallControlResultJson(
                success = true,
                verified = true,
                action = "reject",
                resultingCallState = afterState,
                status = "call_rejected",
                message = "Incoming call rejected via Android InCallService."
            )
        }

        // Path 2: Official TelecomManager.endCall() (API 28+, ANSWER_PHONE_CALLS)
        return endOrRejectViaTelecomManager(action = "reject", expectedCurrentState = currentState)
    }

    @android.annotation.SuppressLint("MissingPermission")
    fun endActiveCallAsJson(): String {
        val (currentState, _) = queryCurrentCallStateLabel()
        val eligible = currentState == "ACTIVE" || currentState == "DIALING" || currentState == "HOLDING"
        if (!eligible) {
            return buildCallControlResultJson(
                success = false,
                verified = true,
                action = "end",
                resultingCallState = currentState,
                status = "no_active_call",
                message = "No active phone call is currently in progress to end (current state: $currentState)."
            )
        }

        // Path 1: Bound ZoniInCallService (ROLE_DIALER)
        if (ZoniInCallService.isServiceBound && ZoniInCallService.disconnectActiveCall()) {
            val (afterState, _) = queryCurrentCallStateLabel()
            return buildCallControlResultJson(
                success = true,
                verified = true,
                action = "end",
                resultingCallState = afterState,
                status = "call_ended",
                message = "Active phone call ended via Android InCallService."
            )
        }

        // Path 2: Official TelecomManager.endCall() (API 28+, ANSWER_PHONE_CALLS)
        return endOrRejectViaTelecomManager(action = "end", expectedCurrentState = currentState)
    }

    @android.annotation.SuppressLint("MissingPermission")
    private fun endOrRejectViaTelecomManager(action: String, expectedCurrentState: String): String {
        if (!hasAnswerPhoneCallsPermission()) {
            return buildCallControlResultJson(
                success = false,
                verified = true,
                action = action,
                resultingCallState = expectedCurrentState,
                status = "permission_missing",
                message = "Android ANSWER_PHONE_CALLS permission is required to ${if (action == "reject") "reject" else "end"} calls.",
                missingPermissions = listOf("ANSWER_PHONE_CALLS")
            )
        }

        if (android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.P) {
            return buildCallControlResultJson(
                success = false,
                verified = true,
                action = action,
                resultingCallState = expectedCurrentState,
                status = "unsupported_android_version",
                message = "Rejecting or ending calls via TelecomManager requires Android 9.0 (API 28) or setting Zoni AI as Default Dialer.",
                requiresDialerRole = true
            )
        }

        val tm = context.getSystemService(Context.TELECOM_SERVICE) as? android.telecom.TelecomManager
            ?: return buildCallControlResultJson(
                success = false,
                verified = false,
                action = action,
                resultingCallState = expectedCurrentState,
                status = "telecom_unavailable",
                message = "Android TelecomManager is unavailable on this device."
            )

        return try {
            @Suppress("DEPRECATION")
            val ended = tm.endCall()
            val (afterState, _) = queryCurrentCallStateLabel()
            if (ended) {
                buildCallControlResultJson(
                    success = true,
                    verified = true,
                    action = action,
                    resultingCallState = afterState,
                    status = if (action == "reject") "call_rejected" else "call_ended",
                    message = if (action == "reject") {
                        "Incoming call rejected via Android TelecomManager."
                    } else {
                        "Active call ended via Android TelecomManager."
                    }
                )
            } else {
                buildCallControlResultJson(
                    success = false,
                    verified = true,
                    action = action,
                    resultingCallState = afterState,
                    status = "telecom_declined",
                    message = "Android TelecomManager returned false for $action. On some Android versions/OEMs, Default Dialer role (ROLE_DIALER) is required.",
                    requiresDialerRole = true
                )
            }
        } catch (e: SecurityException) {
            buildCallControlResultJson(
                success = false,
                verified = true,
                action = action,
                resultingCallState = expectedCurrentState,
                status = "permission_missing",
                message = "Android denied call $action: ${e.message}. Grant ANSWER_PHONE_CALLS or Default Dialer role.",
                missingPermissions = listOf("ANSWER_PHONE_CALLS"),
                requiresDialerRole = true
            )
        } catch (e: Exception) {
            buildCallControlResultJson(
                success = false,
                verified = false,
                action = action,
                resultingCallState = expectedCurrentState,
                status = "failed",
                message = "Failed to $action call: ${e.message}"
            )
        }
    }

    private fun buildCallControlResultJson(
        success: Boolean,
        verified: Boolean,
        action: String,
        resultingCallState: String,
        status: String,
        message: String,
        missingPermissions: List<String> = emptyList(),
        requiresDialerRole: Boolean = false
    ): String {
        val permsArr = JSONArray()
        missingPermissions.forEach { permsArr.put(it) }
        return JSONObject()
            .put("success", success)
            .put("verified", verified)
            .put("action", action)
            .put("resultingCallState", resultingCallState)
            .put("status", status)
            .put("message", message)
            .put("missingPermissions", permsArr)
            .put("requiresDialerRole", requiresDialerRole)
            .toString()
    }
}
