package com.zoni.jarvis.assistant.audio

import android.annotation.SuppressLint
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.NoiseSuppressor
import android.util.Base64
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlin.math.min
import kotlin.math.sqrt

/**
 * Genuine Native Android Full-Duplex PCM Audio Engine for Gemini Live:
 * - Capture: 16,000 Hz Mono 16-bit PCM (with hardware AEC + Noise Suppression)
 * - Playback: 24,000 Hz Mono 16-bit PCM low-latency streaming via AudioTrack
 * - Emits normalized audio amplitude (0f..1f) for real-time Arc Reactor visualization
 */
class LiveAudioEngine(
    private val onAmplitudeChanged: (Float) -> Unit = {}
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private var audioRecord: AudioRecord? = null
    private var echoCanceler: AcousticEchoCanceler? = null
    private var noiseSuppressor: NoiseSuppressor? = null
    private var captureJob: Job? = null

    private var audioTrack: AudioTrack? = null
    private val playbackLock = Any()

    @Volatile
    var isMicMuted: Boolean = false

    @Volatile
    var isVoiceMuted: Boolean = false

    @SuppressLint("MissingPermission")
    fun startMicrophoneCapture(onBase64PcmChunk: (String) -> Unit): Boolean {
        stopMicrophoneCapture()

        val minBuf = AudioRecord.getMinBufferSize(
            INPUT_SAMPLE_RATE,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT
        )
        if (minBuf <= 0) return false
        val bufferSize = maxOf(minBuf * 2, CHUNK_BYTES * 2)

        return try {
            val recorder = AudioRecord(
                MediaRecorder.AudioSource.VOICE_COMMUNICATION,
                INPUT_SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
                bufferSize
            )
            if (recorder.state != AudioRecord.STATE_INITIALIZED) {
                recorder.release()
                return false
            }

            // Enable hardware Acoustic Echo Cancellation & Noise Suppression where supported
            val sessionId = recorder.audioSessionId
            if (AcousticEchoCanceler.isAvailable()) {
                echoCanceler = AcousticEchoCanceler.create(sessionId)?.apply { enabled = true }
            }
            if (NoiseSuppressor.isAvailable()) {
                noiseSuppressor = NoiseSuppressor.create(sessionId)?.apply { enabled = true }
            }

            audioRecord = recorder
            recorder.startRecording()

            captureJob = scope.launch {
                val readBuffer = ByteArray(CHUNK_BYTES)
                while (isActive) {
                    val read = recorder.read(readBuffer, 0, readBuffer.size)
                    if (read > 0 && !isMicMuted) {
                        val amp = computeRmsAmplitude(readBuffer, read)
                        onAmplitudeChanged(amp)
                        val chunk = if (read == readBuffer.size) readBuffer else readBuffer.copyOf(read)
                        val b64 = Base64.encodeToString(chunk, Base64.NO_WRAP)
                        onBase64PcmChunk(b64)
                    } else if (isMicMuted) {
                        onAmplitudeChanged(0f)
                    }
                }
            }
            true
        } catch (_: Exception) {
            stopMicrophoneCapture()
            false
        }
    }

    fun stopMicrophoneCapture() {
        captureJob?.cancel()
        captureJob = null
        try {
            echoCanceler?.release()
        } catch (_: Exception) {
        }
        echoCanceler = null
        try {
            noiseSuppressor?.release()
        } catch (_: Exception) {
        }
        noiseSuppressor = null
        try {
            audioRecord?.stop()
        } catch (_: Exception) {
        }
        try {
            audioRecord?.release()
        } catch (_: Exception) {
        }
        audioRecord = null
        onAmplitudeChanged(0f)
    }

    private fun ensureAudioTrack(): AudioTrack? {
        synchronized(playbackLock) {
            audioTrack?.let {
                if (it.state == AudioTrack.STATE_INITIALIZED) {
                    if (it.playState != AudioTrack.PLAYSTATE_PLAYING) {
                        it.play()
                    }
                    return it
                }
            }
            val minBuf = AudioTrack.getMinBufferSize(
                OUTPUT_SAMPLE_RATE,
                AudioFormat.CHANNEL_OUT_MONO,
                AudioFormat.ENCODING_PCM_16BIT
            )
            if (minBuf <= 0) return null

            val track = AudioTrack.Builder()
                .setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_MEDIA)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build()
                )
                .setAudioFormat(
                    AudioFormat.Builder()
                        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                        .setSampleRate(OUTPUT_SAMPLE_RATE)
                        .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                        .build()
                )
                .setBufferSizeInBytes(maxOf(minBuf * 2, 16384))
                .setTransferMode(AudioTrack.MODE_STREAM)
                .build()

            track.play()
            audioTrack = track
            return track
        }
    }

    fun playPcm24kBase64(base64Pcm: String) {
        if (isVoiceMuted || base64Pcm.isBlank()) return
        scope.launch {
            try {
                val pcmBytes = Base64.decode(base64Pcm, Base64.DEFAULT)
                if (pcmBytes.isEmpty()) return@launch
                onAmplitudeChanged(computeRmsAmplitude(pcmBytes, pcmBytes.size))
                val track = ensureAudioTrack() ?: return@launch
                synchronized(playbackLock) {
                    if (!isVoiceMuted && track.state == AudioTrack.STATE_INITIALIZED) {
                        track.write(pcmBytes, 0, pcmBytes.size, AudioTrack.WRITE_BLOCKING)
                    }
                }
            } catch (_: Exception) {
                // Ignore transient decode/playback issues
            }
        }
    }

    fun stopAllPlayback() {
        synchronized(playbackLock) {
            try {
                audioTrack?.pause()
                audioTrack?.flush()
            } catch (_: Exception) {
            }
        }
        onAmplitudeChanged(0f)
    }

    fun release() {
        stopMicrophoneCapture()
        synchronized(playbackLock) {
            try {
                audioTrack?.stop()
                audioTrack?.release()
            } catch (_: Exception) {
            }
            audioTrack = null
        }
    }

    private fun computeRmsAmplitude(pcm16Le: ByteArray, length: Int): Float {
        val sampleCount = length / 2
        if (sampleCount == 0) return 0f
        var sumSquares = 0.0
        var i = 0
        while (i + 1 < length) {
            val low = pcm16Le[i].toInt() and 0xFF
            val high = pcm16Le[i + 1].toInt()
            val sample = (high shl 8) or low
            val normalized = sample / 32768.0
            sumSquares += normalized * normalized
            i += 2
        }
        val rms = sqrt(sumSquares / sampleCount).toFloat()
        return min(1f, rms * 3.8f)
    }

    companion object {
        const val INPUT_SAMPLE_RATE = 16000
        const val OUTPUT_SAMPLE_RATE = 24000
        // ~128ms chunks at 16kHz 16-bit mono (4096 bytes)
        const val CHUNK_BYTES = 4096
    }
}
