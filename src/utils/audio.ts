/**
 * Audio processing and futuristic Web Audio synthesizer utilities for Zoni Jarvis
 */

let sharedAudioContext: AudioContext | null = null;
let sharedAnalyser: AnalyserNode | null = null;
let sharedAnalyserConnected = false;

export function getAudioContext(): AudioContext {
  if (!sharedAudioContext || sharedAudioContext.state === 'closed') {
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    try {
      sharedAudioContext = new AudioContextClass({ latencyHint: 'interactive' });
    } catch {
      sharedAudioContext = new AudioContextClass();
    }
    sharedAnalyser = null;
    sharedAnalyserConnected = false;
  }
  if (sharedAudioContext.state === 'suspended') {
    sharedAudioContext.resume().catch(() => {});
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
      this.audioCtx.resume().catch(() => {});
    }
    return { ctx: this.audioCtx, analyser: this.analyser };
  }

  public isPlaying(): boolean {
    return this.activeSources.length > 0;
  }

  public playPcmChunk(base64Pcm: string, sampleRate = 24000) {
    try {
      const { ctx, analyser } = this.ensureContext();
      const binary = atob(base64Pcm);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      const int16Array = new Int16Array(bytes.buffer);
      const float32Array = new Float32Array(int16Array.length);
      for (let i = 0; i < int16Array.length; i++) {
        float32Array[i] = int16Array[i] / 32768.0;
      }
      if (float32Array.length === 0) return;

      const buffer = ctx.createBuffer(1, float32Array.length, sampleRate);
      buffer.getChannelData(0).set(float32Array);

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(analyser);

      const currentTime = ctx.currentTime;
      const startTime = Math.max(currentTime, this.nextPlayTime);
      source.start(startTime);
      this.nextPlayTime = startTime + buffer.duration;

      this.activeSources.push(source);
      source.onended = () => {
        const idx = this.activeSources.indexOf(source);
        if (idx !== -1) {
          this.activeSources.splice(idx, 1);
        }
      };
    } catch (e) {
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
        };
      });
    } catch (e) {
      console.error('Error playing WAV audio:', e);
    }
  }

  public stopAll() {
    for (const src of this.activeSources) {
      try {
        src.stop();
        src.disconnect();
      } catch (e) {
        // already stopped
      }
    }
    this.activeSources = [];
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
