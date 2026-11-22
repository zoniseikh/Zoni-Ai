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
  wakePhrase: string;
  voiceState: VoiceLifecycleState;
  micPermissionGranted: boolean;
  notificationPermissionGranted: boolean;
  detectorEngine: string;
  lastDetectedAtMs: number;
  lastConfidence: number;
  lastError: string;
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
  ['জোনি এআই', 1.0],
  ['জনি এআই', 0.98],
  ['ज़ोनी', 1.0],
  ['जोनी', 0.96],
  ['ज़ोनी एआई', 1.0],
  ['zony', 0.92],
  ['zonie', 0.92],
  ['zoney', 0.9],
  ['joni', 0.86],
  ['jonie', 0.84],
  ['jony', 0.84],
  ['johny', 0.78],
  ['johnny', 0.76],
  ['sooni', 0.74],
  ['soni', 0.74],
];

const OPTIONAL_PREFIXES = [
  'hey ',
  'hi ',
  'ok ',
  'okay ',
  'hello ',
  'ওহে ',
  'হেই ',
  'হ্যালো ',
  'हे ',
  'ओए ',
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
      vNorm.length >= 4 &&
      /^[a-z]+$/.test(vNorm) &&
      /^[a-z]+$/.test(stripped)
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
