/**
 * Zoni AI — Lightweight Audio Crackling & Playback Diagnostic Instrumentation
 *
 * DIAGNOSTIC-ONLY MODULE:
 * - Observes PCM integrity, Web Audio scheduling/jitter, WebSocket frame ordering,
 *   stop/interruption events, TTS queue/overlap, and turn completion timing.
 * - Never alters audio playback, scheduling, queueing, or stop behavior.
 * - Never logs API keys, user messages, contacts, microphone audio, raw PCM/base64,
 *   or screen contents.
 */

export const AUDIO_DIAG_PREFIX = '[ZONI_AUDIO_DIAG]';

export type AudioDiagLevel = 'info' | 'warn';

export interface AudioDiagEventRecord {
  ts: number;
  event: string;
  level: AudioDiagLevel;
  seq?: number;
  data: Record<string, unknown>;
}

export interface AudioDiagSessionSummary {
  sessionStartedTs: number;
  totalAudioChunksReceived: number;
  totalValidPcmChunks: number;
  totalInvalidPcmChunks: number;
  averageChunkDurationMs: number;
  maxSchedulingGapMs: number;
  lateChunkCount: number;
  frameOrderAnomalyCount: number;
  audioStopInterruptCount: number;
  ttsOverlapCount: number;
  audioContextErrorCount: number;
  prematureSpeakingFalseCount: number;
  turnCompleteWhilePlayingCount: number;
  lastAudioChunkReceivedTs: number | null;
  lastAudioChunkScheduledTs: number | null;
  lastPlaybackCompletedTs: number | null;
  lastTurnCompleteTs: number | null;
}

const MAX_RECENT_EVENTS = 250;

function roundMs(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 100) / 100;
}

function roundSec(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 10000) / 10000;
}

export class AudioDiagnosticTracker {
  private sessionStartedTs = Date.now();
  private totalAudioChunksReceived = 0;
  private totalValidPcmChunks = 0;
  private totalInvalidPcmChunks = 0;
  private totalValidDurationMs = 0;
  private maxSchedulingGapMs = 0;
  private lateChunkCount = 0;
  private frameOrderAnomalyCount = 0;
  private audioStopInterruptCount = 0;
  private ttsOverlapCount = 0;
  private audioContextErrorCount = 0;
  private prematureSpeakingFalseCount = 0;
  private turnCompleteWhilePlayingCount = 0;

  private lastAudioChunkReceivedTs: number | null = null;
  private lastAudioChunkScheduledTs: number | null = null;
  private lastPlaybackCompletedTs: number | null = null;
  private lastTurnCompleteTs: number | null = null;

  private recentEvents: AudioDiagEventRecord[] = [];

  constructor(
    private readonly logger: {
      info: (msg: string) => void;
      warn: (msg: string) => void;
    } = {
      info: (msg) => {
        if (typeof console !== 'undefined' && typeof console.info === 'function') {
          console.info(msg);
        }
      },
      warn: (msg) => {
        if (typeof console !== 'undefined' && typeof console.warn === 'function') {
          console.warn(msg);
        }
      },
    }
  ) {}

  public reset(): void {
    this.sessionStartedTs = Date.now();
    this.totalAudioChunksReceived = 0;
    this.totalValidPcmChunks = 0;
    this.totalInvalidPcmChunks = 0;
    this.totalValidDurationMs = 0;
    this.maxSchedulingGapMs = 0;
    this.lateChunkCount = 0;
    this.frameOrderAnomalyCount = 0;
    this.audioStopInterruptCount = 0;
    this.ttsOverlapCount = 0;
    this.audioContextErrorCount = 0;
    this.prematureSpeakingFalseCount = 0;
    this.turnCompleteWhilePlayingCount = 0;
    this.lastAudioChunkReceivedTs = null;
    this.lastAudioChunkScheduledTs = null;
    this.lastPlaybackCompletedTs = null;
    this.lastTurnCompleteTs = null;
    this.recentEvents = [];
  }

  public emit(
    event: string,
    data: Record<string, unknown> = {},
    options?: { level?: AudioDiagLevel; seq?: number; ts?: number }
  ): AudioDiagEventRecord {
    const ts = options?.ts ?? Date.now();
    const level: AudioDiagLevel = options?.level ?? 'info';
    const payload: Record<string, unknown> = {
      ts,
      event,
      ...(typeof options?.seq === 'number' ? { seq: options.seq } : {}),
      ...data,
    };

    const record: AudioDiagEventRecord = {
      ts,
      event,
      level,
      ...(typeof options?.seq === 'number' ? { seq: options.seq } : {}),
      data,
    };
    this.recentEvents.push(record);
    if (this.recentEvents.length > MAX_RECENT_EVENTS) {
      this.recentEvents.shift();
    }

    const line = `${AUDIO_DIAG_PREFIX} ${JSON.stringify(payload)}`;
    if (level === 'warn') {
      this.logger.warn(line);
    } else {
      this.logger.info(line);
    }
    return record;
  }

  public recordAudioChunkReceived(ts: number = Date.now()): void {
    this.totalAudioChunksReceived += 1;
    this.lastAudioChunkReceivedTs = ts;
  }

  public recordValidPcmScheduled(metrics: {
    seq: number;
    sourceTag: string;
    byteLength: number;
    sampleRate: number;
    channels: number;
    durationMs: number;
    isTinyChunk: boolean;
    hasRiffHeader: boolean;
    ctxState: string;
    ctxSampleRate: number;
    ctxCurrentTimeSec: number;
    prevNextPlayTimeSec: number;
    scheduledStartTimeSec: number;
    newNextPlayTimeSec: number;
    interChunkArrivalMs: number | null;
    schedulingGapMs: number;
    isLateChunk: boolean;
    queuedAheadMs: number;
    queueDepth: number;
    ts?: number;
  }): void {
    const ts = metrics.ts ?? Date.now();
    this.totalValidPcmChunks += 1;
    this.totalValidDurationMs += Math.max(0, metrics.durationMs);
    this.lastAudioChunkScheduledTs = ts;

    if (metrics.isLateChunk) {
      this.lateChunkCount += 1;
      if (metrics.schedulingGapMs > this.maxSchedulingGapMs) {
        this.maxSchedulingGapMs = metrics.schedulingGapMs;
      }
    }

    const hasAnomaly =
      metrics.isLateChunk || metrics.isTinyChunk || metrics.hasRiffHeader;

    this.emit(
      metrics.isLateChunk ? 'pcm_chunk_late' : 'pcm_chunk_scheduled',
      {
        sourceTag: metrics.sourceTag,
        byteLength: metrics.byteLength,
        sampleRate: metrics.sampleRate,
        channels: metrics.channels,
        durationMs: roundMs(metrics.durationMs),
        isTinyChunk: metrics.isTinyChunk,
        hasRiffHeader: metrics.hasRiffHeader,
        ctxState: metrics.ctxState,
        ctxSampleRate: metrics.ctxSampleRate,
        ctxCurrentTimeSec: roundSec(metrics.ctxCurrentTimeSec),
        prevNextPlayTimeSec: roundSec(metrics.prevNextPlayTimeSec),
        scheduledStartTimeSec: roundSec(metrics.scheduledStartTimeSec),
        newNextPlayTimeSec: roundSec(metrics.newNextPlayTimeSec),
        interChunkArrivalMs:
          metrics.interChunkArrivalMs !== null
            ? roundMs(metrics.interChunkArrivalMs)
            : null,
        schedulingGapMs: roundMs(metrics.schedulingGapMs),
        isLateChunk: metrics.isLateChunk,
        queuedAheadMs: roundMs(metrics.queuedAheadMs),
        queueDepth: metrics.queueDepth,
      },
      { level: hasAnomaly ? 'warn' : 'info', seq: metrics.seq, ts }
    );
  }

  public recordInvalidPcmChunk(metrics: {
    seq: number;
    sourceTag: string;
    reason: string;
    byteLength: number;
    sampleRate: number;
    channels: number;
    isOddByteLength?: boolean;
    hasRiffHeader?: boolean;
    errorName?: string;
    errorMessage?: string;
    ts?: number;
  }): void {
    this.totalInvalidPcmChunks += 1;
    this.emit(
      'pcm_chunk_invalid',
      {
        sourceTag: metrics.sourceTag,
        reason: metrics.reason,
        byteLength: metrics.byteLength,
        sampleRate: metrics.sampleRate,
        channels: metrics.channels,
        isOddByteLength: Boolean(metrics.isOddByteLength),
        hasRiffHeader: Boolean(metrics.hasRiffHeader),
        ...(metrics.errorName ? { errorName: metrics.errorName } : {}),
        ...(metrics.errorMessage ? { errorMessage: metrics.errorMessage } : {}),
      },
      { level: 'warn', seq: metrics.seq, ts: metrics.ts }
    );
  }

  public recordAudioContextError(
    stage: string,
    err: unknown,
    extra: Record<string, unknown> = {}
  ): void {
    this.audioContextErrorCount += 1;
    const errorName = err instanceof Error ? err.name : 'UnknownError';
    const errorMessage = err instanceof Error ? err.message : String(err ?? '');
    this.emit(
      'audiocontext_error',
      {
        stage,
        errorName,
        errorMessage,
        ...extra,
      },
      { level: 'warn' }
    );
  }

  public recordFrameOrderAnomaly(
    eventName: 'ws_frame_order_anomaly' | 'ws_audio_order_anomaly',
    details: Record<string, unknown>,
    seq: number
  ): void {
    this.frameOrderAnomalyCount += 1;
    this.emit(eventName, details, { level: 'warn', seq });
  }

  public recordAudioStop(details: {
    reason: string;
    activeSourceCount: number;
    wasPlaying: boolean;
    ctxCurrentTimeSec: number;
    remainingScheduledMs: number;
    interruptedActiveResponse: boolean;
    ts?: number;
  }): void {
    this.audioStopInterruptCount += 1;
    this.emit(
      'audio_stop_all',
      {
        reason: details.reason,
        activeSourceCount: details.activeSourceCount,
        wasPlaying: details.wasPlaying,
        ctxCurrentTimeSec: roundSec(details.ctxCurrentTimeSec),
        remainingScheduledMs: roundMs(details.remainingScheduledMs),
        interruptedActiveResponse: details.interruptedActiveResponse,
      },
      {
        level: details.interruptedActiveResponse ? 'warn' : 'info',
        ts: details.ts,
      }
    );
  }

  public recordTtsOverlap(details: Record<string, unknown>, seq?: number): void {
    this.ttsOverlapCount += 1;
    this.emit('tts_overlap_detected', details, { level: 'warn', seq });
  }

  public recordSpeakingStateTransition(details: {
    source: string;
    prevSpeaking: boolean;
    nextSpeaking: boolean;
    activeSourceCount: number;
    queuedAheadMs: number;
    ts?: number;
  }): void {
    const prematureFalse =
      !details.nextSpeaking &&
      (details.activeSourceCount > 0 || details.queuedAheadMs > 0);
    if (prematureFalse) {
      this.prematureSpeakingFalseCount += 1;
    }
    this.emit(
      prematureFalse
        ? 'speaking_state_premature_false'
        : 'assistant_speaking_state_change',
      {
        source: details.source,
        prevSpeaking: details.prevSpeaking,
        nextSpeaking: details.nextSpeaking,
        activeSourceCount: details.activeSourceCount,
        queuedAheadMs: roundMs(details.queuedAheadMs),
        prematureFalse,
      },
      { level: prematureFalse ? 'warn' : 'info', ts: details.ts }
    );
  }

  public recordPlaybackDrained(details: {
    ctxCurrentTimeSec: number;
    ts?: number;
  }): void {
    const ts = details.ts ?? Date.now();
    this.lastPlaybackCompletedTs = ts;
    this.emit(
      'playback_drained',
      {
        ctxCurrentTimeSec: roundSec(details.ctxCurrentTimeSec),
        sinceLastChunkReceivedMs:
          this.lastAudioChunkReceivedTs !== null
            ? ts - this.lastAudioChunkReceivedTs
            : null,
        sinceLastChunkScheduledMs:
          this.lastAudioChunkScheduledTs !== null
            ? ts - this.lastAudioChunkScheduledTs
            : null,
        sinceTurnCompleteMs:
          this.lastTurnCompleteTs !== null ? ts - this.lastTurnCompleteTs : null,
      },
      { level: 'info', ts }
    );
  }

  public recordTurnComplete(details: {
    turnId: number;
    prevSpeaking: boolean;
    activeSourceCount: number;
    queuedAheadMs: number;
    ts?: number;
  }): void {
    const ts = details.ts ?? Date.now();
    this.lastTurnCompleteTs = ts;
    const stillPlaying =
      details.activeSourceCount > 0 || details.queuedAheadMs > 0;
    if (stillPlaying) {
      this.turnCompleteWhilePlayingCount += 1;
    }
    this.emit(
      stillPlaying ? 'turn_complete_while_playing' : 'turn_complete',
      {
        turnId: details.turnId,
        turnCompleteTs: ts,
        lastAudioChunkReceivedTs: this.lastAudioChunkReceivedTs,
        lastAudioChunkScheduledTs: this.lastAudioChunkScheduledTs,
        lastPlaybackCompletedTs: this.lastPlaybackCompletedTs,
        msSinceLastChunkReceived:
          this.lastAudioChunkReceivedTs !== null
            ? ts - this.lastAudioChunkReceivedTs
            : null,
        msSinceLastChunkScheduled:
          this.lastAudioChunkScheduledTs !== null
            ? ts - this.lastAudioChunkScheduledTs
            : null,
        prevSpeaking: details.prevSpeaking,
        nextSpeaking: false,
        activeSourceCount: details.activeSourceCount,
        queuedAheadMs: roundMs(details.queuedAheadMs),
        treatedAsPlaybackCompleteWhilePlaying: stillPlaying,
      },
      { level: stillPlaying ? 'warn' : 'info', ts }
    );
  }

  public getSummary(): AudioDiagSessionSummary {
    const averageChunkDurationMs =
      this.totalValidPcmChunks > 0
        ? roundMs(this.totalValidDurationMs / this.totalValidPcmChunks)
        : 0;

    return {
      sessionStartedTs: this.sessionStartedTs,
      totalAudioChunksReceived: this.totalAudioChunksReceived,
      totalValidPcmChunks: this.totalValidPcmChunks,
      totalInvalidPcmChunks: this.totalInvalidPcmChunks,
      averageChunkDurationMs,
      maxSchedulingGapMs: roundMs(this.maxSchedulingGapMs),
      lateChunkCount: this.lateChunkCount,
      frameOrderAnomalyCount: this.frameOrderAnomalyCount,
      audioStopInterruptCount: this.audioStopInterruptCount,
      ttsOverlapCount: this.ttsOverlapCount,
      audioContextErrorCount: this.audioContextErrorCount,
      prematureSpeakingFalseCount: this.prematureSpeakingFalseCount,
      turnCompleteWhilePlayingCount: this.turnCompleteWhilePlayingCount,
      lastAudioChunkReceivedTs: this.lastAudioChunkReceivedTs,
      lastAudioChunkScheduledTs: this.lastAudioChunkScheduledTs,
      lastPlaybackCompletedTs: this.lastPlaybackCompletedTs,
      lastTurnCompleteTs: this.lastTurnCompleteTs,
    };
  }

  public logSessionSummary(trigger: string): AudioDiagSessionSummary {
    const summary = this.getSummary();
    this.emit('session_summary', { trigger, ...summary }, { level: 'info' });
    return summary;
  }

  public getRecentEvents(): AudioDiagEventRecord[] {
    return this.recentEvents.slice();
  }
}

export const audioDiagnostics = new AudioDiagnosticTracker();

// Expose read-only diagnostic console helper on window without adding any UI
if (typeof window !== 'undefined') {
  (window as any).__ZONI_AUDIO_DIAG__ = {
    getSummary: () => audioDiagnostics.getSummary(),
    printSummary: (trigger = 'manual_inspect') =>
      audioDiagnostics.logSessionSummary(trigger),
    getRecentEvents: () => audioDiagnostics.getRecentEvents(),
    reset: () => audioDiagnostics.reset(),
  };
}
