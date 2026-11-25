/**
 * Real monotonic stage-by-stage latency instrumentation for Zoni AI's voice pipeline.
 * Records actual `performance.now()` timestamps — never estimates or invents timings.
 */

export type VoicePipelineStage =
  | 'mic_capture'
  | 'audio_processing'
  | 'wake_word_detection'
  | 'speech_recognition'
  | 'command_classification'
  | 'action_execution'
  | 'voice_response';

export const ALL_VOICE_PIPELINE_STAGES: readonly VoicePipelineStage[] = [
  'mic_capture',
  'audio_processing',
  'wake_word_detection',
  'speech_recognition',
  'command_classification',
  'action_execution',
  'voice_response',
] as const;

export interface VoicePipelineTurnMetrics {
  turnId: number;
  stageDurationsMs: Partial<Record<VoicePipelineStage, number>>;
  totalEndToEndMs: number;
  executedLocally: boolean;
  completedAtMs: number;
}

export interface VoiceLatencySummary {
  sampleCount: number;
  averageEndToEndMs: number;
  averageStageDurationsMs: Partial<Record<VoicePipelineStage, number>>;
  lastTurn: VoicePipelineTurnMetrics | null;
}

export class VoiceLatencyTracker {
  private turnSeq = 0;
  private activeTurnId = 0;
  private turnStartMs = 0;
  private stageStartMs = new Map<VoicePipelineStage, number>();
  private stageDurationsMs: Partial<Record<VoicePipelineStage, number>> = {};
  private recentTurns: VoicePipelineTurnMetrics[] = [];

  constructor(
    private readonly maxHistory: number = 20,
    private readonly nowClock: () => number = () =>
      typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : Date.now()
  ) {}

  public beginTurn(): number {
    this.turnSeq += 1;
    this.activeTurnId = this.turnSeq;
    this.turnStartMs = this.nowClock();
    this.stageStartMs.clear();
    this.stageDurationsMs = {};
    return this.activeTurnId;
  }

  public markStageStart(stage: VoicePipelineStage): void {
    if (this.activeTurnId === 0) this.beginTurn();
    this.stageStartMs.set(stage, this.nowClock());
  }

  public markStageEnd(stage: VoicePipelineStage): number {
    const now = this.nowClock();
    const start = this.stageStartMs.get(stage);
    if (start === undefined) return 0;
    this.stageStartMs.delete(stage);
    const elapsedMs = Math.max(0, now - start);
    this.stageDurationsMs[stage] = (this.stageDurationsMs[stage] ?? 0) + elapsedMs;
    return elapsedMs;
  }

  public recordStageDurationMs(stage: VoicePipelineStage, durationMs: number): void {
    if (this.activeTurnId === 0) this.beginTurn();
    const safe = Math.max(0, Number.isFinite(durationMs) ? durationMs : 0);
    this.stageDurationsMs[stage] = (this.stageDurationsMs[stage] ?? 0) + safe;
  }

  public finishTurn(executedLocally: boolean = false): VoicePipelineTurnMetrics {
    const now = this.nowClock();
    const totalMs =
      this.turnStartMs > 0
        ? Math.max(0, now - this.turnStartMs)
        : Object.values(this.stageDurationsMs).reduce((acc, v) => acc + (v ?? 0), 0);

    const metrics: VoicePipelineTurnMetrics = {
      turnId: this.activeTurnId,
      stageDurationsMs: { ...this.stageDurationsMs },
      totalEndToEndMs: totalMs,
      executedLocally,
      completedAtMs: Date.now(),
    };
    this.recentTurns.push(metrics);
    while (this.recentTurns.length > this.maxHistory) {
      this.recentTurns.shift();
    }
    this.activeTurnId = 0;
    this.turnStartMs = 0;
    this.stageStartMs.clear();
    this.stageDurationsMs = {};
    return metrics;
  }

  public getLastTurn(): VoicePipelineTurnMetrics | null {
    return this.recentTurns.length > 0 ? this.recentTurns[this.recentTurns.length - 1] : null;
  }

  public getSummary(): VoiceLatencySummary {
    const averageStageDurationsMs: Partial<Record<VoicePipelineStage, number>> = {};
    for (const stage of ALL_VOICE_PIPELINE_STAGES) {
      const vals = this.recentTurns
        .map((t) => t.stageDurationsMs[stage])
        .filter((v): v is number => typeof v === 'number');
      if (vals.length > 0) {
        averageStageDurationsMs[stage] = vals.reduce((a, b) => a + b, 0) / vals.length;
      }
    }
    const averageEndToEndMs =
      this.recentTurns.length > 0
        ? this.recentTurns.reduce((a, b) => a + b.totalEndToEndMs, 0) / this.recentTurns.length
        : 0;

    return {
      sampleCount: this.recentTurns.length,
      averageEndToEndMs,
      averageStageDurationsMs,
      lastTurn: this.getLastTurn(),
    };
  }
}
