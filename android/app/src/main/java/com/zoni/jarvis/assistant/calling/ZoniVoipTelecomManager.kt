package com.zoni.jarvis.assistant.calling

import android.annotation.SuppressLint
import android.content.Context
import android.net.Uri
import android.telecom.DisconnectCause
import androidx.core.telecom.CallAttributesCompat
import androidx.core.telecom.CallControlResult
import androidx.core.telecom.CallsManager
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

data class VoipSessionState(
    val sessionId: String? = null,
    val displayName: String = "",
    val address: String = "",
    val direction: String = "outgoing",
    val status: String = "IDLE", // IDLE | REGISTERING | ACTIVE | HELD | TRANSFERRED | ENDED | ERROR
    val isMuted: Boolean = false,
    val aiDisclosurePlayed: Boolean = false,
    val note: String = ""
)

/**
 * Android Core-Telecom (`androidx.core.telecom.CallsManager`) manager for AI VoIP calls.
 * Integrates Zoni AI VoIP calls with Android's system audio routing (Bluetooth, Speaker,
 * Earpiece), headset controls, and telecom call focus.
 */
class ZoniVoipTelecomManager(
    context: Context,
    private val scope: CoroutineScope = CoroutineScope(Dispatchers.IO)
) {
    private val callsManager = CallsManager(context.applicationContext)
    private var activeCallJob: Job? = null
    private var disconnectSignal: CompletableDeferred<Int>? = null

    private val _voipState = MutableStateFlow(VoipSessionState())
    val voipState: StateFlow<VoipSessionState> = _voipState.asStateFlow()

    init {
        try {
            callsManager.registerAppWithTelecom(
                CallsManager.CAPABILITY_BASELINE or CallsManager.CAPABILITY_SUPPORTS_CALL_STREAMING
            )
        } catch (_: Exception) {
            // Gracefully handle devices/emulators where Core-Telecom registration is unavailable
        }
    }

    @SuppressLint("MissingPermission")
    fun startVoipTelecomSession(
        sessionId: String,
        displayName: String,
        phoneAddress: String,
        isIncoming: Boolean,
        disclosureScript: String,
        onEnded: () -> Unit = {}
    ) {
        activeCallJob?.cancel()
        val endDeferred = CompletableDeferred<Int>()
        disconnectSignal = endDeferred

        val directionCompat = if (isIncoming) {
            CallAttributesCompat.DIRECTION_INCOMING
        } else {
            CallAttributesCompat.DIRECTION_OUTGOING
        }

        val attributes = CallAttributesCompat(
            displayName = displayName.ifBlank { phoneAddress },
            address = Uri.parse("tel:$phoneAddress"),
            direction = directionCompat,
            callType = CallAttributesCompat.CALL_TYPE_AUDIO_CALL,
            callCapabilities = CallAttributesCompat.SUPPORTS_SET_INACTIVE or CallAttributesCompat.SUPPORTS_STREAM
        )

        _voipState.value = VoipSessionState(
            sessionId = sessionId,
            displayName = displayName,
            address = phoneAddress,
            direction = if (isIncoming) "incoming" else "outgoing",
            status = "REGISTERING",
            aiDisclosurePlayed = false,
            note = disclosureScript
        )

        activeCallJob = scope.launch {
            try {
                callsManager.addCall(
                    attributes,
                    onAnswer = { _ ->
                        _voipState.value = _voipState.value.copy(status = "ACTIVE", aiDisclosurePlayed = true)
                    },
                    onDisconnect = { _ ->
                        _voipState.value = _voipState.value.copy(status = "ENDED")
                        if (!endDeferred.isCompleted) endDeferred.complete(DisconnectCause.LOCAL)
                    },
                    onSetActive = {
                        _voipState.value = _voipState.value.copy(status = "ACTIVE")
                    },
                    onSetInactive = {
                        _voipState.value = _voipState.value.copy(status = "HELD")
                    }
                ) {
                    if (!isIncoming) {
                        val activeRes = setActive()
                        if (activeRes is CallControlResult.Success) {
                            _voipState.value = _voipState.value.copy(
                                status = "ACTIVE",
                                aiDisclosurePlayed = true
                            )
                        }
                    }

                    // Hold coroutine alive until user or remote ends the VoIP call
                    val causeCode = endDeferred.await()
                    disconnect(DisconnectCause(causeCode))
                }
            } catch (e: Exception) {
                _voipState.value = _voipState.value.copy(
                    status = "ERROR",
                    note = e.localizedMessage ?: "Core-Telecom VoIP session error"
                )
            } finally {
                onEnded()
            }
        }
    }

    fun toggleMute(): Boolean {
        val next = !_voipState.value.isMuted
        _voipState.value = _voipState.value.copy(isMuted = next)
        return next
    }

    fun markTransferredToHuman(humanNumber: String) {
        _voipState.value = _voipState.value.copy(
            status = "TRANSFERRED",
            note = "Transferred to human user ($humanNumber)"
        )
        endVoipTelecomSession(DisconnectCause.LOCAL)
    }

    fun endVoipTelecomSession(disconnectCauseCode: Int = DisconnectCause.LOCAL) {
        disconnectSignal?.let {
            if (!it.isCompleted) it.complete(disconnectCauseCode)
        }
        _voipState.value = _voipState.value.copy(status = "ENDED")
    }
}
