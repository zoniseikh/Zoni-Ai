package com.zoni.jarvis.assistant.audio

import org.json.JSONObject

/**
 * Lightweight, zero-overhead monotonic latency instrumentation for the Zoni AI voice pipeline.
 * Records real wall-clock monotonic timestamps (`System.nanoTime()`) for each pipeline stage —
 * never estimates or fabricates measurements.
 */
enum class VoicePipelineStage(val key: String) {
    MIC_CAPTURE("mic_capture"),
    AUDIO_PROCESSING("audio_processing"),
    WAKE_WORD_DETECTION("wake_word_detection"),
    SPEECH_ENDPOINT_DETECTION("speech_endpoint_detection"),
    SPEECH_RECOGNITION("speech_recognition"),
    INTENT_CLASSIFICATION("intent_classification"),
    COMMAND_CLASSIFICATION("command_classification"),
    LOCAL_ACTION_DISPATCH("local_action_dispatch"),
    APPLICATION_LAUNCH("application_launch"),
    ACCESSIBILITY_INTERACTION("accessibility_interaction"),
    ACTION_EXECUTION("action_execution"),
    GEMINI_FIRST_TOKEN("gemini_first_token"),
    FIRST_AUDIBLE_TTS("first_audible_tts"),
    VOICE_RESPONSE("voice_response")
}

data class VoicePipelineTurnMetrics(
    val turnId: Long,
    val stageDurationsMs: Map<String, Double>,
    val totalEndToEndMs: Double,
    val executedLocally: Boolean,
    val completedAtMs: Long
) {
    fun toJson(): String {
        val stagesObj = JSONObject()
        stageDurationsMs.forEach { (k, v) -> stagesObj.put(k, v) }
        return JSONObject()
            .put("turnId", turnId)
            .put("stageDurationsMs", stagesObj)
            .put("totalEndToEndMs", totalEndToEndMs)
            .put("executedLocally", executedLocally)
            .put("completedAtMs", completedAtMs)
            .toString()
    }
}

class VoiceLatencyTracker(
    private val maxHistory: Int = 20,
    private val nanoClock: () -> Long = { System.nanoTime() }
) {
    private var turnSeq: Long = 0L
    private var activeTurnId: Long = 0L
    private var turnStartNs: Long = 0L
    private val stageStartNs = LinkedHashMap<VoicePipelineStage, Long>()
    private val stageDurationsMs = LinkedHashMap<String, Double>()
    private val recentTurns = ArrayDeque<VoicePipelineTurnMetrics>()

    @Synchronized
    fun beginTurn(): Long {
        turnSeq++
        activeTurnId = turnSeq
        turnStartNs = nanoClock()
        stageStartNs.clear()
        stageDurationsMs.clear()
        return activeTurnId
    }

    @Synchronized
    fun markStageStart(stage: VoicePipelineStage) {
        if (activeTurnId == 0L) beginTurn()
        stageStartNs[stage] = nanoClock()
    }

    @Synchronized
    fun markStageEnd(stage: VoicePipelineStage): Double {
        val now = nanoClock()
        val start = stageStartNs.remove(stage) ?: return 0.0
        val elapsedMs = ((now - start).coerceAtLeast(0L)) / 1_000_000.0
        val existing = stageDurationsMs[stage.key] ?: 0.0
        val updated = existing + elapsedMs
        stageDurationsMs[stage.key] = updated
        return elapsedMs
    }

    @Synchronized
    fun recordStageDurationMs(stage: VoicePipelineStage, durationMs: Double) {
        if (activeTurnId == 0L) beginTurn()
        val safe = durationMs.coerceAtLeast(0.0)
        stageDurationsMs[stage.key] = (stageDurationsMs[stage.key] ?: 0.0) + safe
    }

    @Synchronized
    fun finishTurn(executedLocally: Boolean = false): VoicePipelineTurnMetrics {
        val now = nanoClock()
        val totalMs = if (turnStartNs > 0L) {
            ((now - turnStartNs).coerceAtLeast(0L)) / 1_000_000.0
        } else {
            stageDurationsMs.values.sum()
        }
        val metrics = VoicePipelineTurnMetrics(
            turnId = activeTurnId,
            stageDurationsMs = LinkedHashMap(stageDurationsMs),
            totalEndToEndMs = totalMs,
            executedLocally = executedLocally,
            completedAtMs = System.currentTimeMillis()
        )
        recentTurns.addLast(metrics)
        while (recentTurns.size > maxHistory) {
            recentTurns.removeFirst()
        }
        activeTurnId = 0L
        turnStartNs = 0L
        stageStartNs.clear()
        stageDurationsMs.clear()
        return metrics
    }

    @Synchronized
    fun getLastTurn(): VoicePipelineTurnMetrics? = recentTurns.lastOrNull()

    @Synchronized
    fun getRecentTurns(): List<VoicePipelineTurnMetrics> = recentTurns.toList()

    @Synchronized
    fun getSummaryJson(): String {
        val last = recentTurns.lastOrNull()
        val avgStages = JSONObject()
        for (stage in VoicePipelineStage.entries) {
            val vals = recentTurns.mapNotNull { it.stageDurationsMs[stage.key] }
            if (vals.isNotEmpty()) {
                avgStages.put(stage.key, vals.average())
            }
        }
        val avgTotal = if (recentTurns.isNotEmpty()) {
            recentTurns.map { it.totalEndToEndMs }.average()
        } else {
            0.0
        }
        return JSONObject()
            .put("sampleCount", recentTurns.size)
            .put("averageEndToEndMs", avgTotal)
            .put("averageStageDurationsMs", avgStages)
            .put("lastTurn", last?.let { JSONObject(it.toJson()) } ?: JSONObject.NULL)
            .toString()
    }
}
