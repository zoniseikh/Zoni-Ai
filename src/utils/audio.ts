/**
 * Audio processing and futuristic Web Audio synthesizer utilities for Zoni Jarvis
 */

import { audioDiagnostics } from './audioDiagnostics';

let sharedAudioContext: AudioContext | null = null;
let sharedAnalyser: AnalyserNode | null = null;
let sharedAnalyserConnected = false;

export function getAudioContext(): AudioContext {
  if (!sharedAudioContext || sharedAudioContext.state === 'closed') {
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    try {
      sharedAudioContext = new AudioContextClass({ latencyHint: 'interactive' });
    } catch (err) {
      audioDiagnostics.recordAudioContextError('create_interactive_fallback', err);
      sharedAudioContext = new AudioContextClass();
    }
    audioDiagnostics.emit('audiocontext_created', {
      sampleRate: sharedAudioContext.sampleRate,
      state: sharedAudioContext.state,
      baseLatencyMs:
        typeof (sharedAudioContext as any).baseLatency === 'number'
          ? Math.round((sharedAudioContext as any).baseLatency * 100000) / 100
          : null,
    });
    sharedAnalyser = null;
    sharedAnalyserConnected = false;
  }
  if (sharedAudioContext.state === 'suspended') {
    sharedAudioContext.resume().catch((err) => {
      audioDiagnostics.recordAudioContextError('getAudioContext_resume', err, {
        ctxState: sharedAudioContext?.state ?? 'unknown',
      });
    });
  }
  return sharedAudioContext;
}

export function getAudioAnalyser(): AnalyserNode {
  const ctx = getAudioContext();
  if (!sharedAnalyser) {
    sharedAnalyser = ctx.createAnalyser();
    sharedAnalyser.fftSize = 64;
    sharedAnalyser.smoothingTimeConstant = 0.8;
    sharedAnalyserConnected = false;
  }
  return sharedAnalyser;
}

/**
 * Play futuristic procedural sound effects using Web Audio API oscillators
 */
export function playProceduralSfx(type: 'click' | 'boot' | 'pulse' | 'love' | 'alert' | 'heartbeat') {
  try {
    const ctx = getAudioContext();
    const now = ctx.currentTime;

    if (type === 'click') {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(1400, now);
      osc.frequency.exponentialRampToValueAtTime(800, now + 0.05);
      gain.gain.setValueAtTime(0.08, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.05);
    } else if (type === 'boot') {
      const osc1 = ctx.createOscillator();
      const osc2 = ctx.createOscillator();
      const gain = ctx.createGain();
      osc1.type = 'sine';
      osc2.type = 'triangle';
      osc1.frequency.setValueAtTime(220, now);
      osc1.frequency.exponentialRampToValueAtTime(880, now + 0.4);
      osc2.frequency.setValueAtTime(330, now);
      osc2.frequency.exponentialRampToValueAtTime(1320, now + 0.4);
      gain.gain.setValueAtTime(0.01, now);
      gain.gain.linearRampToValueAtTime(0.12, now + 0.2);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.6);
      osc1.connect(gain);
      osc2.connect(gain);
      gain.connect(ctx.destination);
      osc1.start(now);
      osc2.start(now);
      osc1.stop(now + 0.6);
      osc2.stop(now + 0.6);
    } else if (type === 'love') {
      // Warm chord chime (Major triad)
      [523.25, 659.25, 783.99, 1046.5].forEach((freq, idx) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, now + idx * 0.08);
        gain.gain.setValueAtTime(0.001, now + idx * 0.08);
        gain.gain.linearRampToValueAtTime(0.06, now + idx * 0.08 + 0.04);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + idx * 0.08 + 0.8);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + idx * 0.08);
        osc.stop(now + idx * 0.08 + 0.85);
      });
    } else if (type === 'pulse') {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(440, now);
      osc.frequency.exponentialRampToValueAtTime(220, now + 0.15);
      gain.gain.setValueAtTime(0.06, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.15);
    } else if (type === 'heartbeat') {
      // Sub-bass double thump
      [0, 0.12].forEach((offset) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(75, now + offset);
        osc.frequency.exponentialRampToValueAtTime(45, now + offset + 0.09);
        gain.gain.setValueAtTime(0.15, now + offset);
        gain.gain.exponentialRampToValueAtTime(0.001, now + offset + 0.1);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + offset);
        osc.stop(now + offset + 0.1);
      });
    }
  } catch (e) {
    // Audio context may not be unlocked yet
  }
}

/**
 * Resamples Float32 mono PCM to targetSampleRate (default 16000 Hz).
 * Crucial for Android WebView where `new AudioContext({ sampleRate: 16000 })`
 * frequently falls back to hardware 48000 Hz or 44100 Hz; without resampling,
 * Gemini Live receives 3x stretched slow-motion audio and cannot detect
 * end-of-speech promptly.
 */
export function resampleFloat32Pcm(
  samples: Float32Array,
  sourceSampleRate: number,
  targetSampleRate: number = 16000
): Float32Array {
  if (
    !samples.length ||
    !Number.isFinite(sourceSampleRate) ||
    sourceSampleRate <= 0 ||
    Math.abs(sourceSampleRate - targetSampleRate) < 1
  ) {
    return samples;
  }

  const ratio = sourceSampleRate / targetSampleRate;
  const outputLength = Math.max(1, Math.round(samples.length / ratio));
  const result = new Float32Array(outputLength);

  for (let i = 0; i < outputLength; i++) {
    const srcPos = i * ratio;
    const idx0 = Math.floor(srcPos);
    const idx1 = Math.min(idx0 + 1, samples.length - 1);
    const frac = srcPos - idx0;
    result[i] = samples[idx0] * (1 - frac) + samples[idx1] * frac;
  }

  return result;
}

/**
 * Computes normalized RMS energy (0..1) of a Float32 PCM buffer.
 */
export function computePcmRms(samples: Float32Array): number {
  if (!samples.length) return 0;
  let sumSq = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    sumSq += s * s;
  }
  return Math.sqrt(sumSq / samples.length);
}

/**
 * Lightweight adaptive end-of-speech detector for Gemini Live voice turns.
 * Tracks room ambient noise floor and fires `shouldSignalAudioStreamEnd: true`
 * once per user utterance as soon as ~400ms of post-speech silence occurs so
 * Gemini Live flushes its buffer and starts replying immediately.
 */
export class FastEndOfSpeechDetector {
  private noiseFloor = 0.004;
  private inSpeech = false;
  private speechAccumMs = 0;
  private silenceAccumMs = 0;

  constructor(
    private readonly options: {
      minSpeechRms?: number;
      minSpeechMs?: number;
      silenceEndMs?: number;
    } = {}
  ) {}

  public reset(): void {
    this.inSpeech = false;
    this.speechAccumMs = 0;
    this.silenceAccumMs = 0;
  }

  public processFrame(
    rms: number,
    frameDurationMs: number,
    isAssistantSpeaking: boolean
  ): { isSpeech: boolean; shouldSignalAudioStreamEnd: boolean } {
    if (isAssistantSpeaking) {
      this.reset();
      return { isSpeech: false, shouldSignalAudioStreamEnd: false };
    }

    const minSpeechRms = this.options.minSpeechRms ?? 0.015;
    const minSpeechMs = this.options.minSpeechMs ?? 130;
    const silenceEndMs = this.options.silenceEndMs ?? 420;

    const startThreshold = Math.max(minSpeechRms, this.noiseFloor * 2.8);
    const continueThreshold = Math.max(minSpeechRms * 0.65, this.noiseFloor * 1.85);

    if (!this.inSpeech) {
      if (rms >= startThreshold) {
        this.inSpeech = true;
        this.speechAccumMs = frameDurationMs;
        this.silenceAccumMs = 0;
        return { isSpeech: true, shouldSignalAudioStreamEnd: false };
      }
      // Adapt ambient noise floor slowly when idle (clamped so loud spikes don't desensitize)
      this.noiseFloor = Math.min(
        0.025,
        Math.max(0.002, this.noiseFloor * 0.94 + rms * 0.06)
      );
      return { isSpeech: false, shouldSignalAudioStreamEnd: false };
    }

    if (rms >= continueThreshold) {
      this.speechAccumMs += frameDurationMs;
      this.silenceAccumMs = 0;
      return { isSpeech: true, shouldSignalAudioStreamEnd: false };
    }

    // Speech dropped to silence
    this.silenceAccumMs += frameDurationMs;
    if (this.silenceAccumMs >= silenceEndMs) {
      const hadRealSpeech = this.speechAccumMs >= minSpeechMs;
      this.reset();
      return { isSpeech: false, shouldSignalAudioStreamEnd: hadRealSpeech };
    }

    return { isSpeech: false, shouldSignalAudioStreamEnd: false };
  }
}

/**
 * Computes zero-crossing rate (0..1) for a Float32 mono PCM buffer.
 */
export function computePcmZeroCrossingRate(samples: Float32Array): number {
  if (samples.length < 2) return 0;
  let crossings = 0;
  let prev = samples[0];
  for (let i = 1; i < samples.length; i++) {
    const cur = samples[i];
    if ((cur >= 0 && prev < 0) || (cur < 0 && prev >= 0)) {
      crossings++;
    }
    prev = cur;
  }
  return crossings / samples.length;
}

/**
 * First-order 85 Hz high-pass filter for 16 kHz Float32 PCM.
 * Removes DC offset, electrical hum, and wind/fan rumble without distorting speech formants.
 */
export class SpeechHighPassFilter {
  private prevInput = 0;
  private prevOutput = 0;

  constructor(private readonly alpha: number = 0.967) {}

  public reset(): void {
    this.prevInput = 0;
    this.prevOutput = 0;
  }

  public process(samples: Float32Array): Float32Array {
    const out = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      const x = samples[i];
      const y = this.alpha * (this.prevOutput + x - this.prevInput);
      this.prevInput = x;
      this.prevOutput = y;
      out[i] = Math.max(-1, Math.min(1, y));
    }
    return out;
  }
}

export interface NearFieldSpeechGateDecision {
  shouldTransmitCurrentFrame: boolean;
  preRollFramesToFlush: Float32Array[];
  isSpeechActive: boolean;
  suppressedByPlaybackEcho: boolean;
  shouldSignalAudioStreamEnd: boolean;
  shouldInterruptAssistant: boolean;
  endpointDetectionLatencyMs: number;
  effectiveSilenceEndMs: number;
  rms: number;
  zcr: number;
  noiseFloorRms: number;
}

/**
 * Adaptive Near-Field Speech Gate with:
 * - 300ms pre-roll buffer (preserves opening syllables)
 * - Adaptive End-of-Speech (EOS) timeout: crisp short commands finish fast (~260ms),
 *   normal commands settle cleanly (~380ms), and long/multi-clause utterances get extra
 *   pause headroom (~520ms) so mid-sentence pauses never clip final words.
 * - Background-speaker resistance during active user speech: once the near-field user
 *   establishes a peak voice level, softer distant chatter during a pause does not
 *   falsely extend or corrupt the user's endpoint timer.
 * - Playback echo suppression (+260ms room-reverb tail) with optional controlled near-field
 *   barge-in: sustained loud near-field speech while Zoni is talking triggers immediate
 *   interruption (`shouldInterruptAssistant: true`) without allowing assistant echo to
 *   trigger false commands.
 */
export class NearFieldSpeechGate {
  private noiseFloorRms = 0.005;
  private inSpeech = false;
  private speechAccumMs = 0;
  private silenceAccumMs = 0;
  private pauseCountInUtterance = 0;
  private activePrimaryPeakRms = 0;
  private echoTailRemainingMs = 0;
  private wasAssistantSpeaking = false;
  private bargeInAccumMs = 0;
  private preRollQueue: Float32Array[] = [];

  constructor(
    private readonly options: {
      minSpeechRms?: number;
      snrStartMultiplier?: number;
      snrContinueMultiplier?: number;
      minSpeechMs?: number;
      /** Explicit fixed silence end override (preserves legacy caller configuration). */
      silenceEndMs?: number;
      /** Adaptive EOS timeout for short crisp commands (<900ms speech). */
      shortCommandSilenceMs?: number;
      /** Adaptive EOS timeout for normal commands (900ms..2400ms speech). */
      normalSilenceMs?: number;
      /** Adaptive EOS timeout for long or multi-pause utterances (>=2400ms or >=2 pauses). */
      longUtteranceSilenceMs?: number;
      hangoverMs?: number;
      echoTailHoldoverMs?: number;
      maxPreRollFrames?: number;
      /** Enable controlled near-field user barge-in during assistant playback. */
      allowBargeIn?: boolean;
      /** Minimum sustained RMS required for loud near-field barge-in above playback echo. */
      bargeInMinRms?: number;
      /** Continuous near-field speech duration required to trigger barge-in. */
      bargeInHoldMs?: number;
      /** Background-speaker floor ratio relative to the primary user's utterance peak RMS. */
      primarySpeakerContinueRatio?: number;
    } = {}
  ) {}

  public reset(): void {
    this.inSpeech = false;
    this.speechAccumMs = 0;
    this.silenceAccumMs = 0;
    this.pauseCountInUtterance = 0;
    this.activePrimaryPeakRms = 0;
    this.bargeInAccumMs = 0;
    this.preRollQueue = [];
  }

  public getNoiseFloorRms(): number {
    return this.noiseFloorRms;
  }

  /**
   * Computes adaptive end-of-speech silence window based on speaking duration,
   * mid-sentence pauses, and ambient noise floor.
   */
  public computeAdaptiveSilenceEndMs(): number {
    if (typeof this.options.silenceEndMs === 'number' && this.options.silenceEndMs > 0) {
      return this.options.silenceEndMs;
    }
    const shortMs = this.options.shortCommandSilenceMs ?? 260;
    const normalMs = this.options.normalSilenceMs ?? 380;
    const longMs = this.options.longUtteranceSilenceMs ?? 520;

    let target: number;
    if (this.pauseCountInUtterance >= 2 || this.speechAccumMs >= 2400) {
      target = longMs;
    } else if (this.pauseCountInUtterance >= 1 || this.speechAccumMs >= 900) {
      target = normalMs;
    } else {
      target = shortMs;
    }

    // In noisier rooms, add slight stability headroom (up to +40ms) without hurting quiet latency
    const noiseBoost = this.noiseFloorRms > 0.014 ? 40 : 0;
    return target + noiseBoost;
  }

  public processFrame(
    pcm16k: Float32Array,
    frameDurationMs: number,
    isAssistantSpeaking: boolean
  ): NearFieldSpeechGateDecision {
    const safeMs = Math.max(1, frameDurationMs);
    const rms = computePcmRms(pcm16k);
    const zcr = computePcmZeroCrossingRate(pcm16k);
    const echoTailHoldoverMs = this.options.echoTailHoldoverMs ?? 260;
    const speechLikeZcr = zcr >= 0.008 && zcr <= 0.44;
    const allowBargeIn = this.options.allowBargeIn ?? false;
    const bargeInMinRms = this.options.bargeInMinRms ?? 0.085;
    const bargeInHoldMs = this.options.bargeInHoldMs ?? 120;

    if (isAssistantSpeaking) {
      this.wasAssistantSpeaking = true;
      this.echoTailRemainingMs = echoTailHoldoverMs;

      // Controlled near-field user barge-in: only sustained loud near-field speech
      // well above ambient + playback echo can interrupt assistant playback.
      const bargeInThreshold = Math.max(bargeInMinRms, this.noiseFloorRms * 4.5);
      if (allowBargeIn && rms >= bargeInThreshold && speechLikeZcr) {
        this.bargeInAccumMs += safeMs;
        this.preRollQueue.push(new Float32Array(pcm16k));
        while (this.preRollQueue.length > (this.options.maxPreRollFrames ?? 6)) {
          this.preRollQueue.shift();
        }
        if (this.bargeInAccumMs >= bargeInHoldMs) {
          const flushed = this.preRollQueue.slice();
          this.preRollQueue = [];
          this.wasAssistantSpeaking = false;
          this.echoTailRemainingMs = 0;
          this.bargeInAccumMs = 0;
          this.inSpeech = true;
          this.speechAccumMs = bargeInHoldMs;
          this.silenceAccumMs = 0;
          this.pauseCountInUtterance = 0;
          this.activePrimaryPeakRms = rms;
          return {
            shouldTransmitCurrentFrame: true,
            preRollFramesToFlush: flushed,
            isSpeechActive: true,
            suppressedByPlaybackEcho: false,
            shouldSignalAudioStreamEnd: false,
            shouldInterruptAssistant: true,
            endpointDetectionLatencyMs: 0,
            effectiveSilenceEndMs: this.computeAdaptiveSilenceEndMs(),
            rms,
            zcr,
            noiseFloorRms: this.noiseFloorRms,
          };
        }
      } else {
        this.bargeInAccumMs = 0;
        this.preRollQueue = [];
      }

      this.inSpeech = false;
      this.speechAccumMs = 0;
      this.silenceAccumMs = 0;
      this.pauseCountInUtterance = 0;
      this.activePrimaryPeakRms = 0;
      return {
        shouldTransmitCurrentFrame: false,
        preRollFramesToFlush: [],
        isSpeechActive: false,
        suppressedByPlaybackEcho: true,
        shouldSignalAudioStreamEnd: false,
        shouldInterruptAssistant: false,
        endpointDetectionLatencyMs: 0,
        effectiveSilenceEndMs: this.computeAdaptiveSilenceEndMs(),
        rms,
        zcr,
        noiseFloorRms: this.noiseFloorRms,
      };
    }

    this.bargeInAccumMs = 0;

    if (this.wasAssistantSpeaking && this.echoTailRemainingMs > 0) {
      this.echoTailRemainingMs = Math.max(0, this.echoTailRemainingMs - safeMs);
      if (this.echoTailRemainingMs === 0) {
        this.wasAssistantSpeaking = false;
      }
      this.reset();
      return {
        shouldTransmitCurrentFrame: false,
        preRollFramesToFlush: [],
        isSpeechActive: false,
        suppressedByPlaybackEcho: true,
        shouldSignalAudioStreamEnd: false,
        shouldInterruptAssistant: false,
        endpointDetectionLatencyMs: 0,
        effectiveSilenceEndMs: this.computeAdaptiveSilenceEndMs(),
        rms,
        zcr,
        noiseFloorRms: this.noiseFloorRms,
      };
    }

    const minSpeechRms = this.options.minSpeechRms ?? 0.017;
    const snrStartMultiplier = this.options.snrStartMultiplier ?? 2.65;
    const snrContinueMultiplier = this.options.snrContinueMultiplier ?? 1.75;
    const minSpeechMs = this.options.minSpeechMs ?? 130;
    const hangoverMs = this.options.hangoverMs ?? 180;
    const maxPreRollFrames = this.options.maxPreRollFrames ?? 6;
    const primarySpeakerContinueRatio = this.options.primarySpeakerContinueRatio ?? 0.25;

    const startThreshold = Math.max(minSpeechRms, this.noiseFloorRms * snrStartMultiplier);
    const baseContinueThreshold = Math.max(
      minSpeechRms * 0.62,
      this.noiseFloorRms * snrContinueMultiplier
    );
    const primaryLockedContinueThreshold = Math.max(
      baseContinueThreshold,
      this.activePrimaryPeakRms * primarySpeakerContinueRatio
    );
    const effectiveSilenceEndMs = this.computeAdaptiveSilenceEndMs();

    if (!this.inSpeech) {
      if (rms >= startThreshold && speechLikeZcr) {
        this.inSpeech = true;
        this.speechAccumMs = safeMs;
        this.silenceAccumMs = 0;
        this.pauseCountInUtterance = 0;
        this.activePrimaryPeakRms = rms;
        const flushed = this.preRollQueue.slice();
        this.preRollQueue = [];
        return {
          shouldTransmitCurrentFrame: true,
          preRollFramesToFlush: flushed,
          isSpeechActive: true,
          suppressedByPlaybackEcho: false,
          shouldSignalAudioStreamEnd: false,
          shouldInterruptAssistant: false,
          endpointDetectionLatencyMs: 0,
          effectiveSilenceEndMs: this.computeAdaptiveSilenceEndMs(),
          rms,
          zcr,
          noiseFloorRms: this.noiseFloorRms,
        };
      }

      this.noiseFloorRms = Math.min(
        0.032,
        Math.max(0.002, this.noiseFloorRms * 0.94 + rms * 0.06)
      );
      this.preRollQueue.push(new Float32Array(pcm16k));
      while (this.preRollQueue.length > maxPreRollFrames) {
        this.preRollQueue.shift();
      }
      return {
        shouldTransmitCurrentFrame: false,
        preRollFramesToFlush: [],
        isSpeechActive: false,
        suppressedByPlaybackEcho: false,
        shouldSignalAudioStreamEnd: false,
        shouldInterruptAssistant: false,
        endpointDetectionLatencyMs: 0,
        effectiveSilenceEndMs,
        rms,
        zcr,
        noiseFloorRms: this.noiseFloorRms,
      };
    }

    // Active user speech: require energy consistent with the primary near-field speaker so
    // distant background voices during a pause do not falsely keep the turn open forever.
    if (rms >= primaryLockedContinueThreshold && speechLikeZcr) {
      if (this.silenceAccumMs >= 140) {
        this.pauseCountInUtterance += 1;
      }
      this.speechAccumMs += safeMs;
      this.silenceAccumMs = 0;
      this.activePrimaryPeakRms = Math.max(this.activePrimaryPeakRms * 0.98, rms);
      return {
        shouldTransmitCurrentFrame: true,
        preRollFramesToFlush: [],
        isSpeechActive: true,
        suppressedByPlaybackEcho: false,
        shouldSignalAudioStreamEnd: false,
        shouldInterruptAssistant: false,
        endpointDetectionLatencyMs: 0,
        effectiveSilenceEndMs: this.computeAdaptiveSilenceEndMs(),
        rms,
        zcr,
        noiseFloorRms: this.noiseFloorRms,
      };
    }

    this.silenceAccumMs += safeMs;
    const withinHangover = this.silenceAccumMs <= hangoverMs;
    if (this.silenceAccumMs >= effectiveSilenceEndMs) {
      const hadRealSpeech = this.speechAccumMs >= minSpeechMs;
      const detectedLatencyMs = hadRealSpeech ? this.silenceAccumMs : 0;
      this.reset();
      return {
        shouldTransmitCurrentFrame: false,
        preRollFramesToFlush: [],
        isSpeechActive: false,
        suppressedByPlaybackEcho: false,
        shouldSignalAudioStreamEnd: hadRealSpeech,
        shouldInterruptAssistant: false,
        endpointDetectionLatencyMs: detectedLatencyMs,
        effectiveSilenceEndMs,
        rms,
        zcr,
        noiseFloorRms: this.noiseFloorRms,
      };
    }

    return {
      shouldTransmitCurrentFrame: withinHangover,
      preRollFramesToFlush: [],
      isSpeechActive: withinHangover,
      suppressedByPlaybackEcho: false,
      shouldSignalAudioStreamEnd: false,
      shouldInterruptAssistant: false,
      endpointDetectionLatencyMs: 0,
      effectiveSilenceEndMs,
      rms,
      zcr,
      noiseFloorRms: this.noiseFloorRms,
    };
  }
}

/**
 * Converts Float32 audio buffer from microphone into 16-bit PCM Base64 string
 */
export function pcm16ToBase64(float32Array: Float32Array): string {
  const int16Array = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i++) {
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  const bytes = new Uint8Array(int16Array.buffer);
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Audio playback scheduler for raw 24kHz PCM chunks streamed from Gemini Live
 */
export class LiveAudioPlayer {
  private audioCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private nextPlayTime: number = 0;
  private activeSources: AudioBufferSourceNode[] = [];
  private diagChunkSeq: number = 0;
  private diagLastChunkArrivalTs: number | null = null;
  private diagHasScheduledChunk: boolean = false;

  private ensureContext(): { ctx: AudioContext; analyser: AnalyserNode } {
    if (!this.audioCtx || this.audioCtx.state === 'closed') {
      this.audioCtx = getAudioContext();
      this.analyser = null;
    }
    if (!this.analyser) {
      this.analyser = getAudioAnalyser();
    }
    if (!sharedAnalyserConnected) {
      try {
        this.analyser.connect(this.audioCtx.destination);
        sharedAnalyserConnected = true;
      } catch {
        // already connected
      }
    }
    if (this.audioCtx.state === 'suspended') {
      this.audioCtx.resume().catch((err) => {
        audioDiagnostics.recordAudioContextError('ensureContext_resume', err, {
          ctxState: this.audioCtx?.state ?? 'unknown',
        });
      });
    }
    return { ctx: this.audioCtx, analyser: this.analyser };
  }

  public isPlaying(): boolean {
    return this.activeSources.length > 0;
  }

  public getActiveSourceCount(): number {
    return this.activeSources.length;
  }

  public getQueuedAheadMs(): number {
    if (!this.audioCtx) return 0;
    const remainingSec = this.nextPlayTime - this.audioCtx.currentTime;
    return remainingSec > 0 ? Math.round(remainingSec * 100000) / 100 : 0;
  }

  public playPcmChunk(base64Pcm: string, sampleRate = 24000, sourceTag = 'unknown') {
    const arrivalTs = Date.now();
    const seq = ++this.diagChunkSeq;
    const interChunkArrivalMs =
      this.diagLastChunkArrivalTs !== null ? arrivalTs - this.diagLastChunkArrivalTs : null;
    this.diagLastChunkArrivalTs = arrivalTs;

    let stage = 'ensure_context';
    let decodedByteLength = 0;
    let isOddByteLength = false;
    let hasRiffHeader = false;

    try {
      const { ctx, analyser } = this.ensureContext();
      stage = 'base64_decode';
      const binary = atob(base64Pcm);
      decodedByteLength = binary.length;
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }

      isOddByteLength = bytes.byteLength % 2 !== 0;
      hasRiffHeader =
        bytes.byteLength >= 4 &&
        bytes[0] === 0x52 &&
        bytes[1] === 0x49 &&
        bytes[2] === 0x46 &&
        bytes[3] === 0x46;

      if (bytes.byteLength === 0) {
        audioDiagnostics.recordInvalidPcmChunk({
          seq,
          sourceTag,
          reason: 'empty_pcm_chunk',
          byteLength: 0,
          sampleRate,
          channels: 1,
          isOddByteLength: false,
          hasRiffHeader: false,
          ts: arrivalTs,
        });
      } else if (isOddByteLength) {
        audioDiagnostics.emit(
          'pcm_odd_byte_length_detected',
          {
            sourceTag,
            byteLength: bytes.byteLength,
            sampleRate,
            channels: 1,
            hasRiffHeader,
          },
          { level: 'warn', seq, ts: arrivalTs }
        );
      }

      stage = 'pcm_int16_conversion';
      const int16Array = new Int16Array(bytes.buffer);
      const float32Array = new Float32Array(int16Array.length);
      for (let i = 0; i < int16Array.length; i++) {
        float32Array[i] = int16Array[i] / 32768.0;
      }
      if (float32Array.length === 0) {
        if (bytes.byteLength > 0) {
          audioDiagnostics.recordInvalidPcmChunk({
            seq,
            sourceTag,
            reason: 'zero_float32_samples',
            byteLength: bytes.byteLength,
            sampleRate,
            channels: 1,
            isOddByteLength,
            hasRiffHeader,
            ts: arrivalTs,
          });
        }
        return;
      }

      stage = 'audiobuffer_create';
      const buffer = ctx.createBuffer(1, float32Array.length, sampleRate);
      buffer.getChannelData(0).set(float32Array);

      stage = 'schedule_source';
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(analyser);

      const currentTime = ctx.currentTime;
      const prevNextPlayTime = this.nextPlayTime;
      const startTime = Math.max(currentTime, this.nextPlayTime);
      const isLateChunk =
        this.diagHasScheduledChunk && prevNextPlayTime > 0 && currentTime > prevNextPlayTime;
      const schedulingGapMs = isLateChunk ? (currentTime - prevNextPlayTime) * 1000 : 0;
      const queuedAheadMs = Math.max(0, (prevNextPlayTime - currentTime) * 1000);
      const durationMs = buffer.duration * 1000;
      const isTinyChunk = durationMs < 20;

      source.start(startTime);
      this.nextPlayTime = startTime + buffer.duration;
      this.diagHasScheduledChunk = true;

      this.activeSources.push(source);
      audioDiagnostics.recordValidPcmScheduled({
        seq,
        sourceTag,
        byteLength: bytes.byteLength,
        sampleRate,
        channels: buffer.numberOfChannels,
        durationMs,
        isTinyChunk,
        hasRiffHeader,
        ctxState: ctx.state,
        ctxSampleRate: ctx.sampleRate,
        ctxCurrentTimeSec: currentTime,
        prevNextPlayTimeSec: prevNextPlayTime,
        scheduledStartTimeSec: startTime,
        newNextPlayTimeSec: this.nextPlayTime,
        interChunkArrivalMs,
        schedulingGapMs,
        isLateChunk,
        queuedAheadMs,
        queueDepth: this.activeSources.length,
        ts: arrivalTs,
      });

      source.onended = () => {
        const idx = this.activeSources.indexOf(source);
        if (idx !== -1) {
          this.activeSources.splice(idx, 1);
        }
        if (this.activeSources.length === 0) {
          audioDiagnostics.recordPlaybackDrained({
            ctxCurrentTimeSec: this.audioCtx?.currentTime ?? 0,
          });
        }
      };
    } catch (e) {
      audioDiagnostics.recordInvalidPcmChunk({
        seq,
        sourceTag,
        reason: stage,
        byteLength: decodedByteLength,
        sampleRate,
        channels: 1,
        isOddByteLength,
        hasRiffHeader,
        errorName: e instanceof Error ? e.name : 'Error',
        errorMessage: e instanceof Error ? e.message : String(e),
        ts: arrivalTs,
      });
      if (stage === 'ensure_context' || stage === 'audiobuffer_create') {
        audioDiagnostics.recordAudioContextError(stage, e, {
          sampleRate,
          byteLength: decodedByteLength,
        });
      }
      console.error('Error playing raw PCM chunk:', e);
    }
  }

  public playWavBase64(base64Wav: string) {
    try {
      const { ctx, analyser } = this.ensureContext();
      const binary = atob(base64Wav);
      const len = binary.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binary.charCodeAt(i);
      }

      ctx.decodeAudioData(bytes.buffer.slice(0), (buffer) => {
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(analyser);
        source.start(0);
        this.activeSources.push(source);
        source.onended = () => {
          const idx = this.activeSources.indexOf(source);
          if (idx !== -1) this.activeSources.splice(idx, 1);
          if (this.activeSources.length === 0) {
            audioDiagnostics.recordPlaybackDrained({
              ctxCurrentTimeSec: this.audioCtx?.currentTime ?? 0,
            });
          }
        };
      });
    } catch (e) {
      console.error('Error playing WAV audio:', e);
    }
  }

  public stopAll(reason: string = 'unspecified') {
    const activeCount = this.activeSources.length;
    const ctxCurrentTime = this.audioCtx?.currentTime ?? 0;
    const remainingScheduledMs =
      this.audioCtx && this.nextPlayTime > ctxCurrentTime
        ? (this.nextPlayTime - ctxCurrentTime) * 1000
        : 0;
    const wasPlaying = activeCount > 0;
    const interruptedActiveResponse = wasPlaying || remainingScheduledMs > 0;

    audioDiagnostics.recordAudioStop({
      reason,
      activeSourceCount: activeCount,
      wasPlaying,
      ctxCurrentTimeSec: ctxCurrentTime,
      remainingScheduledMs,
      interruptedActiveResponse,
    });

    for (const src of this.activeSources) {
      try {
        src.stop();
        src.disconnect();
      } catch (e) {
        // already stopped
      }
    }
    this.activeSources = [];
    this.diagHasScheduledChunk = false;
    if (this.audioCtx) {
      this.nextPlayTime = this.audioCtx.currentTime;
    }
  }
}

/**
 * Stop any ongoing browser speech synthesis immediately
 */
export function stopAllBrowserSpeech() {
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    try {
      window.speechSynthesis.cancel();
    } catch {
      // ignore
    }
  }
}

/**
 * High-quality Browser SpeechSynthesis engine for voice playback
 */
export function speakWithBrowserTts(
  _text?: string,
  _onStart?: () => void,
  _onEnd?: () => void,
  _lang?: string
): boolean {
  return false;
}
