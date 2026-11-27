/**
 * Zoni AI — Unified Voice Lifecycle State Machine, Wake-Word Matcher & Call-Control Contracts.
 *
 * Mirrors `ZoniWakeWordEngine.kt` and `SimCallManager.kt` 1:1 so the React frontend,
 * Android Foreground Service, and backend always speak the exact same states.
 */

export type VoiceLifecycleState =
  | 'DISABLED'
  | 'IDLE'
  | 'WAKE_WORD_LISTENING'
  | 'WAKE_WORD_DETECTED'
  | 'ACTIVATING'
  | 'CONNECTING'
  | 'CONNECTED'
  | 'LISTENING'
  | 'PROCESSING'
  | 'SPEAKING'
  | 'DISCONNECTING'
  | 'RECONNECTING'
  | 'ERROR';

export const ALL_VOICE_LIFECYCLE_STATES: readonly VoiceLifecycleState[] = [
  'DISABLED',
  'IDLE',
  'WAKE_WORD_LISTENING',
  'WAKE_WORD_DETECTED',
  'ACTIVATING',
  'CONNECTING',
  'CONNECTED',
  'LISTENING',
  'PROCESSING',
  'SPEAKING',
  'DISCONNECTING',
  'RECONNECTING',
  'ERROR',
] as const;

export interface WakeWordConfig {
  wakePhrase: string;
  confidenceThreshold: number;
  cooldownMs: number;
}

export const DEFAULT_WAKE_WORD_CONFIG: WakeWordConfig = {
  wakePhrase: 'Zoni',
  confidenceThreshold: 0.72,
  cooldownMs: 2500,
};

export interface WakeWordMatchResult {
  matched: boolean;
  confidence: number;
  matchedVariant: string;
  remainingCommand: string;
  rejectedReason: string;
}

export interface WakeWordStatusSnapshot {
  wakeWordEnabled: boolean;
  backgroundServiceRunning: boolean;
  listening: boolean;
  backgroundCommandMode?: boolean;
  wakePhrase: string;
  voiceState: VoiceLifecycleState;
  micPermissionGranted: boolean;
  notificationPermissionGranted: boolean;
  detectorEngine: string;
  recognitionMode?: string;
  lastDetectedAtMs: number;
  lastConfidence: number;
  lastVerificationLatencyMs?: number;
  lastError: string;
}

export const WAKE_RESPONSE_PHRASE_BN = 'হ্যাঁ, বলো শুনছি।';

const EXACT_STOP_COMMAND_PHRASES = new Set([
  // Bengali stop phrases
  'ধন্যবাদ জোনি',
  'ধন্যবাদ জনি',
  'ধন্যবাদ জোনী',
  'ধন্যবাদ জনী',
  'ধন্যবাদ জুনি',
  'ধন্যবাদ জোনি এআই',
  'ধন্যবাদ জনি এআই',
  'অনেক ধন্যবাদ জোনি',
  'অনেক ধন্যবাদ জনি',
  'জোনি ধন্যবাদ',
  'জনি ধন্যবাদ',
  'থ্যাংক ইউ জোনি',
  'থ্যাঙ্ক ইউ জোনি',
  'থ্যাংক ইউ জনি',
  'থ্যাঙ্ক ইউ জনি',
  'থ্যাংকস জোনি',
  'থ্যাংকস জনি',
  'শোনা বন্ধ করো',
  'শোনা বন্ধ কর',
  'জোনি শোনা বন্ধ করো',
  'জনি শোনা বন্ধ করো',
  'কমান্ড মোড বন্ধ করো',
  'কমান্ড মোড অফ করো',
  'স্টপ লিসেনিং',
  'স্টপ লিসেনিং জোনি',
  'বাই জোনি',
  'বাই জনি',
  // English stop phrases
  'stop listening',
  'stop listening zoni',
  'stop listening zoni ai',
  'zoni stop listening',
  'zoni ai stop listening',
  'please stop listening',
  'stop command mode',
  'exit command mode',
  'close command mode',
  'end command mode',
  'thank you zoni',
  'thank you zoni ai',
  'thanks zoni',
  'thanks zoni ai',
  'thank you joni',
  'thanks joni',
  'zoni thank you',
  'bye zoni',
  'goodbye zoni',
  // Hindi stop phrases
  'धन्यवाद ज़ोनी',
  'धन्यवाद जोनी',
  'शुक्रिया ज़ोनी',
  'शुक्रिया जोनी',
  'सुनना बंद करो',
  'कमांड मोड बंद करो',
]);

const STOP_COMMAND_REGEX =
  /^(?:(?:ok|okay|alright|please|ঠিক\s*আছে|আচ্ছা|ওকে)\s+)?(?:(?:অনেক\s+)?(?:ধন্যবাদ|থ্যাংক\s*ইউ|থ্যাঙ্ক\s*ইউ|থ্যাংকস)\s+(?:জোনি|জনি|জোনী|জনী|জুনি|zoni|joni)(?:\s*(?:এআই|ai))?|(?:জোনি|জনি|zoni)\s+(?:অনেক\s+)?(?:ধন্যবাদ|শোনা\s*বন্ধ\s*করো?|কমান্ড\s*মোড\s*(?:বন্ধ|অফ)\s*করো?|stop\s+listening)|(?:শোনা\s*বন্ধ\s*করো?|কমান্ড\s*মোড\s*(?:বন্ধ|অফ)\s*করো?|স্টপ\s*লিসেনিং(?:\s+(?:জোনি|জনি|zoni))?)|(?:stop\s+listening|stop\s+command\s+mode|exit\s+command\s+mode|close\s+command\s+mode|end\s+command\s+mode)(?:\s+(?:zoni|joni|zoni\s+ai|please))?|(?:thank\s+you|thanks|bye|goodbye)\s+(?:zoni|joni|zonie|zony)(?:\s+ai)?|(?:धन्यवाद|शुक्रिया)\s+(?:ज़ोनी|जोनी)|(?:सुनना\s*बंद\s*करो|कमांड\s*मोड\s*बंद\s*करो))$/i;

/**
 * Strictly detects explicit Continuous Command Mode exit phrases
 * ("ধন্যবাদ জোনি", "Stop Listening", etc.) while rejecting unrelated commands
 * like "Stop the video", "ভিডিওটি স্টপ করো", or "টর্চ বন্ধ করো".
 */
export function isStopCommandModePhrase(rawText: string): boolean {
  const normalized = normalizeWakeText(rawText);
  if (!normalized) return false;
  if (EXACT_STOP_COMMAND_PHRASES.has(normalized)) return true;
  return STOP_COMMAND_REGEX.test(normalized);
}

export interface IncomingCallStatusSnapshot {
  callState: 'IDLE' | 'RINGING' | 'DIALING' | 'ACTIVE' | 'HOLDING' | 'DISCONNECTED';
  isIncomingRinging: boolean;
  isActiveCall: boolean;
  callerNumber: string;
  callerDisplayName: string;
  canAnswer: boolean;
  canReject: boolean;
  canEnd: boolean;
  hasAnswerPermission: boolean;
  hasReadPhoneStatePermission: boolean;
  isDefaultDialerRoleHeld: boolean;
  source: 'in_call_service' | 'telephony_state' | 'call_screening' | 'none';
  lastError: string;
  updatedAtMs: number;
}

export interface CallControlActionResult {
  success: boolean;
  verified: boolean;
  action: 'answer' | 'reject' | 'end';
  resultingCallState: string;
  status: string;
  message: string;
  missingPermissions?: string[];
  requiresDialerRole?: boolean;
}

const DEFAULT_ZONI_VARIANTS: ReadonlyArray<readonly [string, number]> = [
  ['zoni', 1.0],
  ['zoni ai', 1.0],
  ['জোনি', 1.0],
  ['জোনী', 0.98],
  ['জনি', 0.96],
  ['জনী', 0.95],
  ['জুনি', 0.93],
  ['জুনী', 0.92],
  ['যোনি', 0.92],
  ['যনী', 0.9],
  ['জোনি এআই', 1.0],
  ['জনি এআই', 0.98],
  ['জোনি এ আই', 0.98],
  ['ज़ोनी', 1.0],
  ['जोनी', 0.96],
  ['ज़ोनी एआई', 1.0],
  ['zony', 0.92],
  ['zonie', 0.92],
  ['zoney', 0.9],
  ['zooni', 0.89],
  ['joni', 0.86],
  ['jonie', 0.84],
  ['jony', 0.84],
];

const REJECTED_SIMILAR_WORDS = new Set([
  'zone',
  'zones',
  'zoom',
  'zero',
  'johnny',
  'johny',
  'soni',
  'sooni',
  'sony',
  'tony',
  'pony',
  'bony',
  'bonny',
  'donny',
  'bonnie',
  'ronnie',
  'moni',
  'mini',
  'boni',
  'roni',
  'sunny',
  'honey',
  'money',
  'funny',
  'bunny',
  'phone',
  'done',
  'gone',
  'none',
  'bone',
  'cone',
  'tone',
  'lone',
]);

const OPTIONAL_PREFIXES = [
  'hey ',
  'hi ',
  'ok ',
  'okay ',
  'hello ',
  'ওহে ',
  'হেই ',
  'হে ',
  'হ্যালো ',
  'ও ',
  'এই ',
  'অ্যাই ',
  'শোনো ',
  'আরে ',
  'हे ',
  'ओए ',
  'अरे ',
];

export function normalizeWakeText(raw: string): string {
  return String(raw || '')
    .normalize('NFC')
    .trim()
    .toLowerCase()
    .replace(/[,.:;!?।\-_"'()]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshtein(a: string, b: string): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0)
  );
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[a.length][b.length];
}

export function evaluateWakeWordCandidate(
  rawTranscript: string,
  recognizerConfidence: number = 0.88,
  config: WakeWordConfig = DEFAULT_WAKE_WORD_CONFIG,
  lastTriggerAtMs: number = 0,
  nowMs: number = Date.now()
): WakeWordMatchResult {
  const clean = normalizeWakeText(rawTranscript);
  if (!clean) {
    return {
      matched: false,
      confidence: 0,
      matchedVariant: '',
      remainingCommand: '',
      rejectedReason: 'empty_transcript',
    };
  }

  if (lastTriggerAtMs > 0 && nowMs - lastTriggerAtMs < config.cooldownMs) {
    return {
      matched: false,
      confidence: 0,
      matchedVariant: '',
      remainingCommand: '',
      rejectedReason: 'cooldown_active',
    };
  }

  let stripped = clean;
  for (const prefix of OPTIONAL_PREFIXES) {
    if (stripped.startsWith(prefix)) {
      stripped = stripped.slice(prefix.length).trim();
      break;
    }
  }

  const configuredNorm = normalizeWakeText(config.wakePhrase) || 'zoni';
  const firstToken = stripped.split(' ')[0] || '';
  if (configuredNorm === 'zoni' && REJECTED_SIMILAR_WORDS.has(firstToken)) {
    return {
      matched: false,
      confidence: 0,
      matchedVariant: '',
      remainingCommand: '',
      rejectedReason: 'wake_phrase_not_present',
    };
  }

  const variants: ReadonlyArray<readonly [string, number]> =
    configuredNorm === 'zoni' ? DEFAULT_ZONI_VARIANTS : [[configuredNorm, 1.0]];

  const safeRecConf =
    recognizerConfidence >= 0.01 && recognizerConfidence <= 1.0 ? recognizerConfidence : 0.85;

  let bestVariant = '';
  let bestScore = 0;
  let remainder = '';

  for (const [variant, baseWeight] of variants) {
    const vNorm = normalizeWakeText(variant);
    if (!vNorm) continue;

    if (stripped === vNorm) {
      const score = Math.min(1, baseWeight * (0.5 + 0.5 * safeRecConf));
      if (score > bestScore) {
        bestScore = score;
        bestVariant = variant;
        remainder = '';
      }
      continue;
    }

    if (stripped.startsWith(`${vNorm} `)) {
      const score = Math.min(1, baseWeight * (0.48 + 0.52 * safeRecConf));
      if (score > bestScore) {
        bestScore = score;
        bestVariant = variant;
        remainder = stripped.slice(vNorm.length).trim();
      }
      continue;
    }

    const words = stripped.split(' ');
    if (
      words.length === 1 &&
      vNorm === configuredNorm &&
      vNorm.length >= 4 &&
      /^[a-z]+$/.test(vNorm) &&
      /^[a-z]+$/.test(stripped) &&
      stripped[0] === vNorm[0] &&
      !REJECTED_SIMILAR_WORDS.has(stripped)
    ) {
      if (levenshtein(stripped, vNorm) === 1) {
        const score = Math.min(1, 0.8 * safeRecConf);
        if (score > bestScore) {
          bestScore = score;
          bestVariant = variant;
          remainder = '';
        }
      }
    }
  }

  if (!bestVariant) {
    return {
      matched: false,
      confidence: 0,
      matchedVariant: '',
      remainingCommand: '',
      rejectedReason: 'wake_phrase_not_present',
    };
  }

  if (bestScore < config.confidenceThreshold) {
    return {
      matched: false,
      confidence: bestScore,
      matchedVariant: bestVariant,
      remainingCommand: '',
      rejectedReason: 'below_confidence_threshold',
    };
  }

  return {
    matched: true,
    confidence: bestScore,
    matchedVariant: bestVariant,
    remainingCommand: remainder,
    rejectedReason: '',
  };
}

export function stripWakePhraseFromCommand(
  rawText: string,
  wakePhrase: string = DEFAULT_WAKE_WORD_CONFIG.wakePhrase
): string {
  const res = evaluateWakeWordCandidate(
    rawText,
    1.0,
    { wakePhrase, confidenceThreshold: 0.5, cooldownMs: 0 },
    0
  );
  return res.matched ? res.remainingCommand : rawText.trim();
}

export function normalizeVoiceLifecycleState(raw: string | undefined | null): VoiceLifecycleState {
  const upper = String(raw || '')
    .trim()
    .toUpperCase() as VoiceLifecycleState;
  return (ALL_VOICE_LIFECYCLE_STATES as readonly string[]).includes(upper) ? upper : 'IDLE';
}

/**
 * Derives the honest unified 13-state VoiceLifecycleState from actual runtime signals.
 * Never returns CONNECTED unless the live WebSocket is truly connected.
 */
export function deriveVoiceLifecycleState(params: {
  wsStatus: 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error';
  assistantState: 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking' | 'error';
  isLiveActive: boolean;
  isDisconnecting?: boolean;
  wakeWordStatus?: WakeWordStatusSnapshot | null;
}): VoiceLifecycleState {
  const { wsStatus, assistantState, isLiveActive, isDisconnecting, wakeWordStatus } = params;

  if (isDisconnecting) return 'DISCONNECTING';
  if (assistantState === 'error' || wsStatus === 'error') return 'ERROR';
  if (wsStatus === 'reconnecting') return 'RECONNECTING';

  if (isLiveActive) {
    if (wsStatus !== 'connected') {
      return 'CONNECTING';
    }
    if (assistantState === 'speaking') return 'SPEAKING';
    if (assistantState === 'thinking') return 'PROCESSING';
    if (assistantState === 'listening') return 'LISTENING';
    return 'CONNECTED';
  }

  if (assistantState === 'connecting' || wsStatus === 'connecting') {
    return 'CONNECTING';
  }

  if (wakeWordStatus) {
    if (wakeWordStatus.backgroundCommandMode) {
      if (
        wakeWordStatus.voiceState === 'SPEAKING' ||
        wakeWordStatus.voiceState === 'LISTENING' ||
        wakeWordStatus.voiceState === 'PROCESSING' ||
        wakeWordStatus.voiceState === 'CONNECTING' ||
        wakeWordStatus.voiceState === 'ACTIVATING' ||
        wakeWordStatus.voiceState === 'WAKE_WORD_DETECTED'
      ) {
        return wakeWordStatus.voiceState;
      }
      return 'LISTENING';
    }
    if (wakeWordStatus.voiceState === 'WAKE_WORD_DETECTED') return 'WAKE_WORD_DETECTED';
    if (wakeWordStatus.voiceState === 'ACTIVATING') return 'ACTIVATING';
    if (wakeWordStatus.wakeWordEnabled && wakeWordStatus.listening) {
      return 'WAKE_WORD_LISTENING';
    }
    if (!wakeWordStatus.wakeWordEnabled && wsStatus === 'disconnected') {
      return 'DISABLED';
    }
  }

  if (wsStatus === 'connected') return 'CONNECTED';
  return 'IDLE';
}

/**
 * Pure TypeScript mirror of `RollingPcmRingBuffer` in `ZoniWakeWordEngine.kt`.
 * Maintains a rolling 2.0s 16kHz PCM buffer and slices strictly `[preRoll + utterance]`
 * so preceding room conversation does not contaminate wake-word transcription.
 */
export class RollingPcmRingBuffer {
  private readonly buffer: Int16Array;
  private writeIndex = 0;
  private filledSamples = 0;

  constructor(capacitySamples: number = 32000) {
    this.buffer = new Int16Array(Math.max(1600, capacitySamples));
  }

  public clear(): void {
    this.writeIndex = 0;
    this.filledSamples = 0;
  }

  public write(samples: Int16Array, count: number = samples.length): void {
    const safeCount = Math.max(0, Math.min(count, samples.length));
    for (let i = 0; i < safeCount; i++) {
      this.buffer[this.writeIndex] = samples[i];
      this.writeIndex = (this.writeIndex + 1) % this.buffer.length;
      if (this.filledSamples < this.buffer.length) this.filledSamples++;
    }
  }

  public snapshotSamples(maxSamples: number = this.filledSamples): Int16Array {
    const take = Math.max(0, Math.min(maxSamples, this.filledSamples));
    if (take === 0) return new Int16Array(0);
    const out = new Int16Array(take);
    const start = (this.writeIndex - take + this.buffer.length) % this.buffer.length;
    for (let i = 0; i < take; i++) {
      out[i] = this.buffer[(start + i) % this.buffer.length];
    }
    return out;
  }

  public snapshotUtteranceSamples(
    utteranceWithTrailingSamples: number,
    preRollSamples: number = 4800 // 300ms at 16kHz
  ): Int16Array {
    const desired = Math.min(
      this.filledSamples,
      Math.max(0, utteranceWithTrailingSamples) + Math.max(0, preRollSamples)
    );
    return this.snapshotSamples(desired);
  }

  public sizeSamples(): number {
    return this.filledSamples;
  }
}

export interface AcousticWakeGateConfig {
  minUtteranceMs: number;
  maxUtteranceMs: number;
  trailingSilenceMs: number;
  energyMultiplier: number;
  minRmsThreshold: number;
}

export const DEFAULT_ACOUSTIC_WAKE_GATE_CONFIG: AcousticWakeGateConfig = {
  minUtteranceMs: 150,
  maxUtteranceMs: 1450,
  trailingSilenceMs: 220,
  energyMultiplier: 2.15,
  minRmsThreshold: 0.013,
};

export interface AcousticFrameAnalysis {
  rms: number;
  zcr: number;
  isVoiceFrame: boolean;
  candidateReady: boolean;
  utteranceDurationMs: number;
  earlyOnsetDetected: boolean;
  utteranceSpanSamples: number;
}

/**
 * Pure TypeScript mirror of Stage-1 `AcousticWakeGate` in `ZoniWakeWordEngine.kt`.
 */
export class AcousticWakeGate {
  private noiseFloorRms = 0.008;
  private inSpeech = false;
  private speechDurationMs = 0;
  private silenceDurationMs = 0;
  private totalSpanSamples = 0;
  private peakRms = 0;
  private voicedFrames = 0;
  private earlyOnsetFired = false;

  constructor(
    private readonly config: AcousticWakeGateConfig = DEFAULT_ACOUSTIC_WAKE_GATE_CONFIG,
    private readonly sampleRateHz: number = 16000
  ) {}

  public reset(): void {
    this.inSpeech = false;
    this.speechDurationMs = 0;
    this.silenceDurationMs = 0;
    this.totalSpanSamples = 0;
    this.peakRms = 0;
    this.voicedFrames = 0;
    this.earlyOnsetFired = false;
  }

  public processPcm16Frame(samples: Int16Array, count: number = samples.length): AcousticFrameAnalysis {
    if (count <= 0) {
      return {
        rms: 0,
        zcr: 0,
        isVoiceFrame: false,
        candidateReady: false,
        utteranceDurationMs: 0,
        earlyOnsetDetected: false,
        utteranceSpanSamples: 0,
      };
    }

    const frameMs = Math.max(1, Math.floor((count * 1000) / this.sampleRateHz));
    let sumSq = 0;
    let zeroCrossings = 0;
    let prev = samples[0];
    for (let i = 0; i < count; i++) {
      const s = samples[i];
      const norm = s / 32768;
      sumSq += norm * norm;
      if ((s >= 0 && prev < 0) || (s < 0 && prev >= 0)) {
        zeroCrossings++;
      }
      prev = s;
    }

    const rms = Math.sqrt(sumSq / count);
    const zcr = zeroCrossings / count;
    const speechLikeZcr = zcr >= 0.01 && zcr <= 0.42;
    const dynamicThreshold = Math.max(
      this.config.minRmsThreshold,
      this.noiseFloorRms * this.config.energyMultiplier
    );
    const isVoice = rms >= dynamicThreshold && speechLikeZcr;

    if (!isVoice) {
      this.noiseFloorRms = Math.max(0.003, Math.min(0.08, this.noiseFloorRms * 0.94 + rms * 0.06));
    }

    let candidateReady = false;
    let completedDuration = 0;
    let completedSpanSamples = 0;
    let earlyOnset = false;

    if (isVoice) {
      if (!this.inSpeech) {
        this.inSpeech = true;
        this.speechDurationMs = 0;
        this.silenceDurationMs = 0;
        this.totalSpanSamples = 0;
        this.peakRms = rms;
        this.voicedFrames = 0;
        this.earlyOnsetFired = false;
      }
      this.speechDurationMs += frameMs;
      this.silenceDurationMs = 0;
      this.totalSpanSamples += count;
      this.peakRms = Math.max(this.peakRms, rms);
      this.voicedFrames++;

      if (
        !this.earlyOnsetFired &&
        this.speechDurationMs >= 80 &&
        this.voicedFrames >= 2 &&
        this.peakRms >= dynamicThreshold * 1.1
      ) {
        this.earlyOnsetFired = true;
        earlyOnset = true;
      }
    } else if (this.inSpeech) {
      this.silenceDurationMs += frameMs;
      this.totalSpanSamples += count;
      if (this.silenceDurationMs >= this.config.trailingSilenceMs) {
        const dur = this.speechDurationMs;
        const validDuration =
          dur >= this.config.minUtteranceMs && dur <= this.config.maxUtteranceMs;
        const strongEnough = this.peakRms >= dynamicThreshold * 1.08 && this.voicedFrames >= 3;
        if (validDuration && strongEnough) {
          candidateReady = true;
          completedDuration = dur;
          completedSpanSamples = this.totalSpanSamples;
        }
        this.reset();
      } else if (this.speechDurationMs > this.config.maxUtteranceMs) {
        this.reset();
      }
    }

    return {
      rms,
      zcr,
      isVoiceFrame: isVoice,
      candidateReady,
      utteranceDurationMs: completedDuration,
      earlyOnsetDetected: earlyOnset,
      utteranceSpanSamples: completedSpanSamples,
    };
  }
}

const ACTIVE_CONVERSATION_STATES = new Set<VoiceLifecycleState>([
  'WAKE_WORD_DETECTED',
  'ACTIVATING',
  'CONNECTING',
  'CONNECTED',
  'LISTENING',
  'PROCESSING',
  'SPEAKING',
]);

export function shouldAcceptWakeTrigger(
  currentState: VoiceLifecycleState,
  lastAcceptedAtMs: number,
  nowMs: number = Date.now(),
  cooldownMs: number = 2800
): boolean {
  if (ACTIVE_CONVERSATION_STATES.has(currentState)) return false;
  if (lastAcceptedAtMs > 0 && nowMs - lastAcceptedAtMs < cooldownMs) return false;
  return true;
}

export function computeMicRecoveryBackoffMs(consecutiveFailures: number): number {
  const step = Math.max(1, Math.min(5, Math.floor(consecutiveFailures)));
  switch (step) {
    case 1:
      return 600;
    case 2:
      return 1200;
    case 3:
      return 2500;
    case 4:
      return 4500;
    default:
      return 6000;
  }
}

