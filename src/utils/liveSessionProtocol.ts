/**
 * Shared Gemini Live WebSocket Protocol & Turn-Aware Transcript Manager
 * Ensures Live Voice and Chat Box share a single WebSocket session,
 * maintain strict message ordering, and prevent duplicate assistant messages
 * when audio and text arrive as separate parts of the same response.
 */

import { ChatMessage, SupportedLanguage } from '../types';
import { AssistantAction } from './mobileAssistant';

export type WsConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'error';

export interface OutgoingClientTextMessage {
  type: 'client_text';
  text: string;
  clientMsgId: string;
}

export interface OutgoingAudioChunkMessage {
  audio: string;
}

export interface OutgoingInterruptMessage {
  type: 'interrupt';
}

export interface OutgoingUpdateConfigMessage {
  type: 'update_config';
  nickname?: string;
  selectedAffectionName?: string;
  mode?: string;
  voice?: string;
  lang?: SupportedLanguage;
}

export interface OutgoingPingMessage {
  type: 'ping';
  ts: number;
}

export type OutgoingLiveWsMessage =
  | OutgoingClientTextMessage
  | OutgoingAudioChunkMessage
  | OutgoingInterruptMessage
  | OutgoingUpdateConfigMessage
  | OutgoingPingMessage;

export interface IncomingLiveWsMessage {
  type:
    | 'connected'
    | 'audio'
    | 'text'
    | 'output_transcript'
    | 'user_transcript'
    | 'interrupted'
    | 'turnComplete'
    | 'flashlight'
    | 'session_resumption'
    | 'go_away'
    | 'session_closed'
    | 'pong'
    | 'error'
    | 'live_init_failed';
  audio?: string;
  text?: string;
  turnId?: number;
  enable?: boolean;
  newHandle?: string;
  resumable?: boolean;
  resumed?: boolean;
  sessionId?: string;
  message?: string;
  code?: string;
  retryable?: boolean;
  timeLeft?: string;
  reason?: string;
  ts?: number;
}

/**
 * Validates and builds a client_text payload for sending a Chat Box message
 * through the active Gemini Live WebSocket session.
 */
export function buildClientTextPayload(
  rawText: string,
  clientMsgId: string = `msg-${Date.now()}`
): OutgoingClientTextMessage | null {
  const trimmed = rawText.trim();
  if (!trimmed) return null;
  // Cap message length to 4000 chars for safety
  const safeText = trimmed.slice(0, 4000);
  return {
    type: 'client_text',
    text: safeText,
    clientMsgId,
  };
}

/**
 * Merges incoming transcription chunks intelligently without duplicating
 * overlapping or repeated text segments within the same turn.
 */
export function mergeTranscriptChunk(existingText: string, incomingChunk: string): string {
  const existing = existingText.trim();
  const incoming = incomingChunk.trim();
  if (!incoming) return existing;
  if (!existing) return incoming;

  // If the incoming chunk is identical to the whole existing text or already at the end, skip duplicate
  if (existing === incoming || existing.endsWith(incoming)) {
    return existing;
  }

  // If the incoming chunk is a cumulative transcript that starts with existing text
  if (incoming.startsWith(existing)) {
    return incoming;
  }

  // Join with a single space unless incoming starts with punctuation
  const needsSpace = !/^[.,!?;:।]/.test(incoming);
  return `${existing}${needsSpace ? ' ' : ''}${incoming}`;
}

/**
 * Strips action tags like [ACTION:CALL:...] from spoken/visible assistant text
 * and returns both the clean text and any parsed AssistantAction.
 */
export function extractActionTagFromText(rawText: string): {
  cleanText: string;
  action: AssistantAction | null;
} {
  const actionTagMatch = rawText.match(/\[ACTION:([A-Z]+)(?::([^:\]]+))?(?::([^\]]+))?\]/);
  let action: AssistantAction | null = null;

  if (actionTagMatch) {
    const actType = actionTagMatch[1].toLowerCase() as AssistantAction['type'];
    const target = actionTagMatch[2];
    const payload = actionTagMatch[3];

    let label = 'Assistant Action';
    if (actType === 'call') label = `📞 Call to ${target}`;
    else if (actType === 'whatsapp') label = `💬 WhatsApp to ${target}`;
    else if (actType === 'sms') label = `✉️ SMS to ${target}`;
    else if (actType === 'flashlight') label = `🔦 Flashlight ${target || 'Toggle'}`;
    else if (actType === 'vibrate') label = `📳 Mobile Vibration`;
    else if (actType === 'battery') label = `🔋 Check Battery`;
    else if (actType === 'app' || (actType as string) === 'open') label = `📱 Open ${target}`;
    else if (actType === 'settings') label = `⚙️ Settings: ${target}`;

    action = {
      type: actType,
      target,
      payload,
      label,
    };
  }

  const cleanText = rawText.replace(/\[ACTION:[^\]]+\]/g, '').trim();
  return { cleanText, action };
}

/**
 * Updates the ordered conversation message list with an incoming assistant text/transcript chunk
 * for a given turnId, preventing duplicate assistant bubbles when text and audio transcription
 * arrive as separate events in the same turn.
 */
export function upsertAssistantTurnMessage(
  messages: ChatMessage[],
  chunkText: string,
  turnId: number,
  lang: SupportedLanguage
): { messages: ChatMessage[]; latestFullText: string } {
  const { cleanText } = extractActionTagFromText(chunkText);
  if (!cleanText) {
    const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
    return { messages, latestFullText: lastAssistant?.text || '' };
  }

  const turnMessageId = `live-assistant-turn-${turnId}`;
  const existingIdx = messages.findIndex((m) => m.id === turnMessageId);

  if (existingIdx !== -1) {
    const existingMsg = messages[existingIdx];
    const mergedText = mergeTranscriptChunk(existingMsg.text, cleanText);
    const updatedMsg: ChatMessage = {
      ...existingMsg,
      text: mergedText,
    };
    const nextMessages = [...messages];
    nextMessages[existingIdx] = updatedMsg;
    return { messages: nextMessages, latestFullText: mergedText };
  }

  const newMsg: ChatMessage = {
    id: turnMessageId,
    role: 'assistant',
    text: cleanText,
    timestamp: new Date(),
    lang,
  };

  return {
    messages: [...messages, newMsg],
    latestFullText: cleanText,
  };
}

/**
 * Updates or inserts a live spoken user transcript message for the active user speech turn
 * so spoken voice messages and typed Chat Box messages appear in chronological order.
 */
export function upsertUserSpeechTurnMessage(
  messages: ChatMessage[],
  transcriptChunk: string,
  speechTurnId: number,
  lang: SupportedLanguage
): ChatMessage[] {
  const clean = transcriptChunk.trim();
  if (!clean) return messages;

  const speechMsgId = `live-user-speech-${speechTurnId}`;
  const existingIdx = messages.findIndex((m) => m.id === speechMsgId);

  if (existingIdx !== -1) {
    const existingMsg = messages[existingIdx];
    const merged = mergeTranscriptChunk(existingMsg.text, clean);
    const next = [...messages];
    next[existingIdx] = {
      ...existingMsg,
      text: merged,
    };
    return next;
  }

  const newUserMsg: ChatMessage = {
    id: speechMsgId,
    role: 'user',
    text: clean,
    timestamp: new Date(),
    lang,
  };

  return [...messages, newUserMsg];
}

export const HEALTHY_SESSION_RESET_MS = 10_000;
export const CLIENT_WS_PING_INTERVAL_MS = 25_000;
export const CLIENT_WS_STALE_TIMEOUT_MS = 60_000;

/**
 * Calculates exponential backoff delay in ms for WebSocket reconnection.
 * Optional jitterFraction (0..0.5) adds bounded symmetric jitter to prevent reconnect storms.
 */
export function getReconnectDelayMs(
  attempt: number,
  baseMs = 1500,
  maxMs = 15000,
  jitterFraction = 0,
  randomFn: () => number = Math.random
): number {
  const safeAttempt = Math.max(0, Math.min(10, attempt));
  const rawDelay = Math.min(maxMs, Math.round(baseMs * Math.pow(1.6, safeAttempt)));
  const safeJitter = Math.max(0, Math.min(0.5, jitterFraction));
  if (safeJitter <= 0) {
    return rawDelay;
  }
  const offset = (randomFn() * 2 - 1) * safeJitter * rawDelay;
  return Math.max(250, Math.min(maxMs, Math.round(rawDelay + offset)));
}

/**
 * Only reset the reconnect attempt counter after the session remained healthy
 * long enough to avoid tight rapid-drop reconnect loops.
 */
export function shouldResetReconnectAttempts(
  connectedDurationMs: number,
  thresholdMs: number = HEALTHY_SESSION_RESET_MS
): boolean {
  return Number.isFinite(connectedDurationMs) && connectedDurationMs >= thresholdMs;
}

export interface LiveWsCloseClassification {
  retryable: boolean;
  shouldClearHandle: boolean;
  category: 'normal' | 'service_restart' | 'transient_drop' | 'auth_or_config' | 'unknown';
  diagnosticSummary: string;
}

/**
 * Classifies a WebSocket close code and reason to decide whether automatic
 * reconnection is safe and whether a stale resumption handle should be discarded.
 */
export function classifyLiveWsCloseCode(
  code?: number,
  reason?: string
): LiveWsCloseClassification {
  const cleanReason = String(reason || '').trim();
  if (code === 4001 || code === 4003 || code === 1008) {
    return {
      retryable: false,
      shouldClearHandle: true,
      category: 'auth_or_config',
      diagnosticSummary: cleanReason || `Connection rejected by server (code ${code}).`,
    };
  }
  if (code === 1012 || code === 1013 || code === 1001) {
    return {
      retryable: true,
      shouldClearHandle: false,
      category: 'service_restart',
      diagnosticSummary: cleanReason || `Live session rotated by server (code ${code}).`,
    };
  }
  if (code === 1000) {
    return {
      retryable: false,
      shouldClearHandle: false,
      category: 'normal',
      diagnosticSummary: cleanReason || 'Session closed normally.',
    };
  }
  if (code === 1006 || code === 1011 || code === 1014 || code === undefined) {
    return {
      retryable: true,
      shouldClearHandle: /handle|expired|resume/i.test(cleanReason),
      category: 'transient_drop',
      diagnosticSummary:
        cleanReason || `Transient WebSocket disconnect (code ${code ?? 'unknown'}).`,
    };
  }
  return {
    retryable: true,
    shouldClearHandle: /handle|expired|resume/i.test(cleanReason),
    category: 'unknown',
    diagnosticSummary: cleanReason || `WebSocket closed (code ${code}).`,
  };
}

/**
 * Determines whether the client should schedule an automatic WebSocket reconnect.
 * Stops futile retry loops on non-retryable auth/config failures or after maxAttempts.
 */
export function shouldAutoReconnectLiveWs(
  errorCode: string | undefined,
  retryable: boolean | undefined,
  attempt: number,
  maxAttempts: number = 5
): boolean {
  if (retryable === false) return false;
  if (errorCode === 'GEMINI_KEY_MISSING' || errorCode === 'GEMINI_KEY_INVALID' || errorCode === 'BACKEND_URL_MISSING') {
    return false;
  }
  return attempt < maxAttempts;
}

/**
 * Determines whether a typed chat message should immediately use the HTTP /api/chat
 * fallback rather than waiting on an unavailable/failed Gemini Live WebSocket.
 */
export function shouldUseHttpChatFallback(
  wsReadyState: number | undefined,
  isSessionReady: boolean,
  wsStatus: WsConnectionStatus
): boolean {
  const WS_OPEN = 1;
  if (wsReadyState === WS_OPEN && isSessionReady && wsStatus === 'connected') {
    return false;
  }
  return true;
}

