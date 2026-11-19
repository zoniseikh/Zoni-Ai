package com.zoni.jarvis.assistant.calling

import android.telecom.Call
import android.telecom.InCallService
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

data class ActiveSimCallState(
    val isActive: Boolean = false,
    val remoteNumber: String = "",
    val stateLabel: String = "IDLE",
    val note: String = "Android OS isolates carrier SIM call audio from third-party apps."
)

/**
 * Optional Default Dialer InCallService for user-controlled SIM call state tracking.
 * Activated ONLY when the user explicitly grants ROLE_DIALER in Android Settings.
 * Respects Android security boundaries: does NOT attempt unauthorized SIM voice audio capture.
 */
class ZoniInCallService : InCallService() {

    private val callCallback = object : Call.Callback() {
        override fun onStateChanged(call: Call, state: Int) {
            updateCallState(call, state)
        }
    }

    override fun onCallAdded(call: Call) {
        super.onCallAdded(call)
        currentCall = call
        call.registerCallback(callCallback)
        updateCallState(call, call.details.state)
    }

    override fun onCallRemoved(call: Call) {
        super.onCallRemoved(call)
        call.unregisterCallback(callCallback)
        if (currentCall == call) {
            currentCall = null
        }
        _simCallState.value = ActiveSimCallState(isActive = false, stateLabel = "DISCONNECTED")
    }

    private fun updateCallState(call: Call, state: Int) {
        val number = call.details.handle?.schemeSpecificPart ?: "Unknown"
        val label = when (state) {
            Call.STATE_RINGING -> "RINGING"
            Call.STATE_DIALING, Call.STATE_CONNECTING -> "DIALING"
            Call.STATE_ACTIVE -> "ACTIVE"
            Call.STATE_HOLDING -> "HOLDING"
            Call.STATE_DISCONNECTED -> "DISCONNECTED"
            else -> "STATE_$state"
        }
        _simCallState.value = ActiveSimCallState(
            isActive = state == Call.STATE_ACTIVE || state == Call.STATE_RINGING || state == Call.STATE_DIALING,
            remoteNumber = number,
            stateLabel = label
        )
    }

    companion object {
        @Volatile
        private var currentCall: Call? = null

        private val _simCallState = MutableStateFlow(ActiveSimCallState())
        val simCallState: StateFlow<ActiveSimCallState> = _simCallState.asStateFlow()

        fun answerActiveCall(): Boolean {
            val call = currentCall ?: return false
            return try {
                call.answer(android.telecom.VideoProfile.STATE_AUDIO_ONLY)
                true
            } catch (_: Exception) {
                false
            }
        }

        fun disconnectActiveCall(): Boolean {
            val call = currentCall ?: return false
            return try {
                call.disconnect()
                true
            } catch (_: Exception) {
                false
            }
        }
    }
}
