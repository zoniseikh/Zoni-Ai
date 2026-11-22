package com.zoni.jarvis.assistant.calling

import android.os.Build
import android.telecom.Call
import android.telecom.InCallService
import android.telecom.VideoProfile
import com.zoni.jarvis.assistant.service.ZoniForegroundService
import com.zoni.jarvis.assistant.wakeword.VoiceLifecycleState
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

data class ActiveSimCallState(
    val isActive: Boolean = false,
    val isIncomingRinging: Boolean = false,
    val remoteNumber: String = "",
    val callerDisplayName: String = "",
    val stateLabel: String = "IDLE",
    val canAnswer: Boolean = false,
    val canReject: Boolean = false,
    val canEnd: Boolean = false,
    val updatedAtMs: Long = System.currentTimeMillis(),
    val note: String = "Android OS isolates carrier SIM call audio from third-party apps."
)

/**
 * Shared observable incoming/active call snapshot updated by ZoniInCallService,
 * ZoniCallScreeningService, and SimCallManager's TelephonyCallback without creating duplicate services.
 */
object CallStateHub {
    private val _screenedIncomingNumber = MutableStateFlow("")
    val screenedIncomingNumber: StateFlow<String> = _screenedIncomingNumber.asStateFlow()

    private val _screenedTimestampMs = MutableStateFlow(0L)
    val screenedTimestampMs: StateFlow<Long> = _screenedTimestampMs.asStateFlow()

    private val _telephonyCallState = MutableStateFlow("IDLE")
    val telephonyCallState: StateFlow<String> = _telephonyCallState.asStateFlow()

    private val _telephonyNumber = MutableStateFlow("")
    val telephonyNumber: StateFlow<String> = _telephonyNumber.asStateFlow()

    fun reportScreenedIncomingCall(number: String) {
        _screenedIncomingNumber.value = number
        _screenedTimestampMs.value = System.currentTimeMillis()
    }

    fun reportTelephonyState(stateLabel: String, number: String = "") {
        _telephonyCallState.value = stateLabel
        if (number.isNotBlank()) {
            _telephonyNumber.value = number
        } else if (stateLabel == "IDLE" || stateLabel == "DISCONNECTED") {
            _telephonyNumber.value = ""
            _screenedIncomingNumber.value = ""
        }
    }
}

/**
 * Optional Default Dialer InCallService for verified user-controlled SIM call management.
 * Activated ONLY when the user explicitly grants ROLE_DIALER in Android Settings.
 * - Verifies exact call state (RINGING vs ACTIVE) before answering, rejecting, or disconnecting.
 * - Automatically pauses Zoni wake-word microphone during phone calls and resumes afterward.
 * - Never intercepts or records carrier SIM call audio.
 */
class ZoniInCallService : InCallService() {

    private val callCallback = object : Call.Callback() {
        override fun onStateChanged(call: Call, state: Int) {
            updateCallState(call, state)
        }
    }

    override fun onBind(intent: android.content.Intent?): android.os.IBinder? {
        isServiceBound = true
        return super.onBind(intent)
    }

    override fun onUnbind(intent: android.content.Intent?): Boolean {
        isServiceBound = false
        return super.onUnbind(intent)
    }

    override fun onCallAdded(call: Call) {
        super.onCallAdded(call)
        currentCall = call
        call.registerCallback(callCallback)
        val initialState = readCallState(call)
        updateCallState(call, initialState)
    }

    override fun onCallRemoved(call: Call) {
        super.onCallRemoved(call)
        call.unregisterCallback(callCallback)
        if (currentCall == call) {
            currentCall = null
        }
        _simCallState.value = ActiveSimCallState(
            isActive = false,
            isIncomingRinging = false,
            stateLabel = "DISCONNECTED",
            updatedAtMs = System.currentTimeMillis()
        )
        // Safely resume wake-word listening after call ends if user opted in
        ZoniForegroundService.resumeWakeWordAfterConversation(applicationContext)
    }

    private fun updateCallState(call: Call, state: Int) {
        val number = call.details?.handle?.schemeSpecificPart.orEmpty()
        val displayName = call.details?.callerDisplayName.orEmpty()
        val label = when (state) {
            Call.STATE_RINGING -> "RINGING"
            Call.STATE_DIALING, Call.STATE_CONNECTING -> "DIALING"
            Call.STATE_ACTIVE -> "ACTIVE"
            Call.STATE_HOLDING -> "HOLDING"
            Call.STATE_DISCONNECTED -> "DISCONNECTED"
            else -> "STATE_$state"
        }

        val isRinging = state == Call.STATE_RINGING
        val isLiveCall = state == Call.STATE_ACTIVE || state == Call.STATE_DIALING ||
            state == Call.STATE_CONNECTING || state == Call.STATE_HOLDING

        if (isRinging || isLiveCall) {
            // Pause wake-word mic cleanly so call audio and wake-word detector never fight
            ZoniForegroundService.pauseWakeWordForConversation(applicationContext, VoiceLifecycleState.IDLE)
        } else if (state == Call.STATE_DISCONNECTED) {
            ZoniForegroundService.resumeWakeWordAfterConversation(applicationContext)
        }

        _simCallState.value = ActiveSimCallState(
            isActive = isLiveCall,
            isIncomingRinging = isRinging,
            remoteNumber = number,
            callerDisplayName = displayName,
            stateLabel = label,
            canAnswer = isRinging,
            canReject = isRinging,
            canEnd = isLiveCall,
            updatedAtMs = System.currentTimeMillis()
        )
    }

    companion object {
        @Volatile
        private var currentCall: Call? = null

        @Volatile
        var isServiceBound: Boolean = false
            private set

        private val _simCallState = MutableStateFlow(ActiveSimCallState())
        val simCallState: StateFlow<ActiveSimCallState> = _simCallState.asStateFlow()

        private fun readCallState(call: Call): Int {
            return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                call.details.state
            } else {
                @Suppress("DEPRECATION")
                call.state
            }
        }

        fun answerActiveCall(): Boolean {
            val call = currentCall ?: return false
            if (readCallState(call) != Call.STATE_RINGING) return false
            return try {
                call.answer(VideoProfile.STATE_AUDIO_ONLY)
                true
            } catch (_: Exception) {
                false
            }
        }

        fun rejectIncomingCall(): Boolean {
            val call = currentCall ?: return false
            if (readCallState(call) != Call.STATE_RINGING) return false
            return try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    call.reject(Call.REJECT_REASON_DECLINED)
                } else {
                    @Suppress("DEPRECATION")
                    call.reject(false, null)
                }
                true
            } catch (_: Exception) {
                false
            }
        }

        fun disconnectActiveCall(): Boolean {
            val call = currentCall ?: return false
            val state = readCallState(call)
            val eligible = state == Call.STATE_ACTIVE ||
                state == Call.STATE_DIALING ||
                state == Call.STATE_CONNECTING ||
                state == Call.STATE_HOLDING
            if (!eligible) return false
            return try {
                call.disconnect()
                true
            } catch (_: Exception) {
                false
            }
        }
    }
}
