package com.zoni.jarvis.assistant.network

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.Build

enum class NetworkQualityState {
    OFFLINE,
    WEAK,
    STRONG
}

/**
 * Pure JVM-testable network quality classification and low-bandwidth backpressure policy.
 */
object NetworkQualityPolicy {
    const val WEAK_DOWNSTREAM_THRESHOLD_KBPS = 1200
    const val MAX_AUDIO_QUEUE_BYTES_STRONG = 160_000L
    const val MAX_AUDIO_QUEUE_BYTES_WEAK = 64_000L

    fun classify(
        hasInternet: Boolean,
        isValidated: Boolean,
        downstreamKbps: Int,
        isMetered: Boolean
    ): NetworkQualityState {
        if (!hasInternet) return NetworkQualityState.OFFLINE
        if (!isValidated && downstreamKbps <= 0) return NetworkQualityState.OFFLINE
        if (downstreamKbps in 1..WEAK_DOWNSTREAM_THRESHOLD_KBPS) return NetworkQualityState.WEAK
        if (!isValidated && isMetered) return NetworkQualityState.WEAK
        return NetworkQualityState.STRONG
    }

    fun maxAudioQueueBytesFor(quality: NetworkQualityState): Long {
        return when (quality) {
            NetworkQualityState.OFFLINE -> 0L
            NetworkQualityState.WEAK -> MAX_AUDIO_QUEUE_BYTES_WEAK
            NetworkQualityState.STRONG -> MAX_AUDIO_QUEUE_BYTES_STRONG
        }
    }

    fun shouldDropAudioChunkForBackpressure(
        queuedBytes: Long,
        quality: NetworkQualityState
    ): Boolean {
        if (quality == NetworkQualityState.OFFLINE) return true
        return queuedBytes > maxAudioQueueBytesFor(quality)
    }
}

/**
 * Lightweight, event-driven Android connectivity monitor (zero polling).
 * Reports OFFLINE / WEAK / STRONG state transitions to pause/resume cloud retries cleanly.
 */
class NetworkQualityMonitor(
    context: Context,
    private val onQualityChanged: (NetworkQualityState) -> Unit
) {
    private val appContext = context.applicationContext
    private val connectivityManager =
        appContext.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager

    @Volatile
    var currentQuality: NetworkQualityState = NetworkQualityState.STRONG
        private set

    private var registered = false

    private val callback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            updateCurrentState()
        }

        override fun onLost(network: Network) {
            updateCurrentState()
        }

        override fun onCapabilitiesChanged(network: Network, networkCapabilities: NetworkCapabilities) {
            updateFromCapabilities(networkCapabilities)
        }
    }

    fun start() {
        updateCurrentState()
        val cm = connectivityManager ?: return
        if (registered) return
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                cm.registerDefaultNetworkCallback(callback)
            } else {
                val request = NetworkRequest.Builder()
                    .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                    .build()
                cm.registerNetworkCallback(request, callback)
            }
            registered = true
        } catch (_: Exception) {
            registered = false
        }
    }

    fun stop() {
        val cm = connectivityManager ?: return
        if (!registered) return
        try {
            cm.unregisterNetworkCallback(callback)
        } catch (_: Exception) {
            // ignore
        } finally {
            registered = false
        }
    }

    fun refreshNow(): NetworkQualityState {
        updateCurrentState()
        return currentQuality
    }

    private fun updateCurrentState() {
        val cm = connectivityManager
        if (cm == null) {
            publish(NetworkQualityState.STRONG)
            return
        }
        val activeNetwork = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            cm.activeNetwork
        } else {
            null
        }
        val caps = if (activeNetwork != null) {
            try {
                cm.getNetworkCapabilities(activeNetwork)
            } catch (_: Exception) {
                null
            }
        } else {
            null
        }
        updateFromCapabilities(caps)
    }

    private fun updateFromCapabilities(caps: NetworkCapabilities?) {
        if (caps == null) {
            publish(NetworkQualityState.OFFLINE)
            return
        }
        val hasInternet = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
        val isValidated = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
        } else {
            hasInternet
        }
        val downstreamKbps = try {
            caps.linkDownstreamBandwidthKbps
        } catch (_: Exception) {
            0
        }
        val isMetered = !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
        val next = NetworkQualityPolicy.classify(
            hasInternet = hasInternet,
            isValidated = isValidated,
            downstreamKbps = downstreamKbps,
            isMetered = isMetered
        )
        publish(next)
    }

    private fun publish(next: NetworkQualityState) {
        val prev = currentQuality
        currentQuality = next
        if (prev != next) {
            onQualityChanged(next)
        }
    }

    companion object {
        fun snapshotQuality(context: Context): NetworkQualityState {
            val cm = context.applicationContext.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
                ?: return NetworkQualityState.STRONG
            val active = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) cm.activeNetwork else null
            val caps = active?.let {
                try {
                    cm.getNetworkCapabilities(it)
                } catch (_: Exception) {
                    null
                }
            } ?: return NetworkQualityState.OFFLINE
            val hasInternet = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            val isValidated = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
            } else {
                hasInternet
            }
            val kbps = try {
                caps.linkDownstreamBandwidthKbps
            } catch (_: Exception) {
                0
            }
            val isMetered = !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
            return NetworkQualityPolicy.classify(hasInternet, isValidated, kbps, isMetered)
        }
    }
}
