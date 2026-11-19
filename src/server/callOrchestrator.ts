import crypto from 'crypto';
import { normalizePhoneNumber } from '../utils/numberNormalizer.ts';
import {
  VoipProviderAdapter,
  VoipProviderStatus,
  createVoipProviderFromEnv,
} from './voipProvider.ts';

export type CallChannel = 'sim' | 'ai_voip';
export type CallDirection = 'outgoing' | 'incoming';
export type CallLifecycleState =
  | 'prepared'
  | 'authorized'
  | 'ringing'
  | 'active'
  | 'transferred'
  | 'ended'
  | 'failed'
  | 'blocked_unconfigured';

export interface ConsentRecord {
  consentId: string;
  sessionId: string;
  authorizedByUser: boolean;
  aiIdentityDisclosed: boolean;
  recordingConsentGranted: boolean;
  disclosureText: string;
  authorizedAtIso: string;
}

export interface CallTranscriptTurn {
  speaker: 'ai' | 'remote' | 'user' | 'system';
  text: string;
  timestampIso: string;
}

export interface CallSummaryRecord {
  sessionId: string;
  summaryText: string;
  actionItems: string[];
  outcome: string;
  generatedBy: 'gemini-4-hydrogen' | 'deterministic';
  createdAtIso: string;
}

export interface CallSessionRecord {
  id: string;
  channel: CallChannel;
  direction: CallDirection;
  targetName: string;
  phoneNumber: string;
  purpose: string;
  language: string;
  state: CallLifecycleState;
  disclosureScript: string;
  recordingEnabled: boolean;
  provider: string;
  providerCallSid?: string;
  consent?: ConsentRecord;
  transcript: CallTranscriptTurn[];
  summary?: CallSummaryRecord;
  errorMessage?: string;
  createdAtIso: string;
  startedAtIso?: string;
  endedAtIso?: string;
  durationSeconds: number;
}

export interface PrepareCallInput {
  channel?: CallChannel;
  direction?: CallDirection;
  targetName?: string;
  phoneNumber: string;
  purpose?: string;
  language?: string;
  callerLabel?: string;
}

export interface AuthorizeCallInput {
  sessionId: string;
  confirmedByUser: boolean;
  aiIdentityDisclosed: boolean;
  recordingConsentGranted?: boolean;
}

export interface StartCallInput {
  sessionId: string;
  callbackBaseUrl?: string;
}

export interface EndCallInput {
  sessionId: string;
  reason?: string;
  transcript?: CallTranscriptTurn[];
}

export type SummaryGeneratorFn = (session: CallSessionRecord) => Promise<CallSummaryRecord>;

/**
 * Builds mandatory transparent AI disclosure text so Zoni AI NEVER impersonates
 * the human user on external VoIP calls.
 */
export function buildAiCallDisclosureScript(
  callerLabel: string,
  purpose: string,
  language: string = 'bn-BD'
): string {
  const safeCaller = (callerLabel || 'the user').trim();
  const safePurpose = (purpose || 'assist with a request').trim();

  if (language === 'bn-BD') {
    return `নমস্কার, আমি Zoni AI — ${safeCaller}-এর পক্ষ থেকে কথা বলা একটি কৃত্রিম বুদ্ধিমত্তা (AI) ভয়েস অ্যাসিস্ট্যান্ট। কল করার উদ্দেশ্য: ${safePurpose}। আপনি চাইলে যেকোনো সময় সরাসরি ${safeCaller}-এর সাথে কথা বলার জন্য ট্রান্সফার চাইতে পারেন।`;
  }
  if (language === 'hi-IN') {
    return `Namaste, main Zoni AI hoon — ${safeCaller} ki taraf se call karne wali ek AI voice assistant. Call ka uddeshya: ${safePurpose}. Aap kisi bhi samay seedhe ${safeCaller} se baat karne ke liye transfer maang sakte hain.`;
  }
  return `Hello, this is Zoni AI, an artificial intelligence voice assistant calling on behalf of ${safeCaller}. Purpose of this call: ${safePurpose}. You may request transfer to ${safeCaller} or hang up at any time.`;
}

/**
 * Simple in-memory sliding-window rate limiter for backend endpoints.
 */
export class SlidingWindowRateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly maxRequests: number = 60,
    private readonly windowMs: number = 60_000
  ) {}

  allow(clientKey: string, nowMs: number = Date.now()): { allowed: boolean; remaining: number; retryAfterMs: number } {
    const key = clientKey || 'unknown';
    const cutoff = nowMs - this.windowMs;
    const recent = (this.hits.get(key) || []).filter((ts) => ts > cutoff);

    if (recent.length >= this.maxRequests) {
      const oldest = recent[0];
      const retryAfterMs = Math.max(1000, this.windowMs - (nowMs - oldest));
      this.hits.set(key, recent);
      return { allowed: false, remaining: 0, retryAfterMs };
    }

    recent.push(nowMs);
    this.hits.set(key, recent);
    return { allowed: true, remaining: Math.max(0, this.maxRequests - recent.length), retryAfterMs: 0 };
  }
}

export class HybridCallOrchestrator {
  private readonly sessions = new Map<string, CallSessionRecord>();
  private readonly provider: VoipProviderAdapter;
  private readonly summaryGenerator?: SummaryGeneratorFn;

  constructor(options?: {
    provider?: VoipProviderAdapter;
    summaryGenerator?: SummaryGeneratorFn;
  }) {
    this.provider = options?.provider ?? createVoipProviderFromEnv();
    this.summaryGenerator = options?.summaryGenerator;
  }

  getVoipStatus(): VoipProviderStatus {
    return this.provider.getStatus();
  }

  prepareCall(input: PrepareCallInput): { ok: true; session: CallSessionRecord } | { ok: false; error: string; statusCode: number } {
    const channel: CallChannel = input.channel === 'sim' ? 'sim' : 'ai_voip';
    const direction: CallDirection = input.direction === 'incoming' ? 'incoming' : 'outgoing';
    const rawNumber = (input.phoneNumber || '').trim();

    if (!rawNumber) {
      return { ok: false, error: 'Destination phone number is required.', statusCode: 400 };
    }

    const norm = normalizePhoneNumber(rawNumber);
    if (norm.status !== 'valid' || !norm.normalizedNumber) {
      return {
        ok: false,
        error: ('reason' in norm && norm.reason) || 'Phone number is incomplete or invalid.',
        statusCode: 400,
      };
    }

    const language = (input.language || 'bn-BD').trim();
    const purpose = (input.purpose || 'General assistance').trim().slice(0, 300);
    const callerLabel = (input.callerLabel || 'Boss').trim().slice(0, 80);
    const id = `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 14)}`;
    const nowIso = new Date().toISOString();

    const session: CallSessionRecord = {
      id,
      channel,
      direction,
      targetName: (input.targetName || norm.formatted || norm.normalizedNumber).trim().slice(0, 120),
      phoneNumber: norm.normalizedNumber,
      purpose,
      language,
      state: 'prepared',
      disclosureScript: buildAiCallDisclosureScript(callerLabel, purpose, language),
      recordingEnabled: false, // Privacy rule: NEVER record calls by default
      provider: channel === 'sim' ? 'android_sim_telecom' : this.provider.getStatus().provider,
      transcript: [],
      createdAtIso: nowIso,
      durationSeconds: 0,
    };

    this.sessions.set(id, session);
    return { ok: true, session };
  }

  authorizeCall(input: AuthorizeCallInput): { ok: true; session: CallSessionRecord } | { ok: false; error: string; statusCode: number } {
    const session = this.sessions.get(input.sessionId);
    if (!session) {
      return { ok: false, error: 'Call session not found.', statusCode: 404 };
    }
    if (!input.confirmedByUser) {
      return { ok: false, error: 'Explicit user authorization is required before placing an AI call.', statusCode: 403 };
    }
    if (session.channel === 'ai_voip' && !input.aiIdentityDisclosed) {
      return {
        ok: false,
        error: 'Transparent AI identity disclosure must be acknowledged before starting an AI VoIP call.',
        statusCode: 400,
      };
    }

    const consent: ConsentRecord = {
      consentId: `cns_${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`,
      sessionId: session.id,
      authorizedByUser: true,
      aiIdentityDisclosed: Boolean(input.aiIdentityDisclosed),
      recordingConsentGranted: Boolean(input.recordingConsentGranted),
      disclosureText: session.disclosureScript,
      authorizedAtIso: new Date().toISOString(),
    };

    session.consent = consent;
    session.recordingEnabled = Boolean(input.recordingConsentGranted);
    session.state = 'authorized';
    this.sessions.set(session.id, session);

    return { ok: true, session };
  }

  async startCall(input: StartCallInput): Promise<
    | { ok: true; session: CallSessionRecord; simDialUri?: string }
    | { ok: false; error: string; errorCode?: string; missingEnvVars?: string[]; statusCode: number; session?: CallSessionRecord }
  > {
    const session = this.sessions.get(input.sessionId);
    if (!session) {
      return { ok: false, error: 'Call session not found.', statusCode: 404 };
    }

    if (!session.consent?.authorizedByUser) {
      return {
        ok: false,
        error: 'Call cannot start without explicit user authorization (call /api/calls/authorize first).',
        errorCode: 'authorization_required',
        statusCode: 403,
      };
    }

    // SIM calls are handed off cleanly to Android Telecom / Dialer on-device
    if (session.channel === 'sim') {
      session.state = 'active';
      session.startedAtIso = new Date().toISOString();
      session.transcript.push({
        speaker: 'system',
        text: `SIM call initiated via Android Telecom to ${session.targetName} (${session.phoneNumber}). Note: Android OS isolates SIM voice audio from third-party apps.`,
        timestampIso: session.startedAtIso,
      });
      this.sessions.set(session.id, session);
      return {
        ok: true,
        session,
        simDialUri: `tel:${session.phoneNumber}`,
      };
    }

    // AI VoIP calls require a real configured VoIP/SIP provider — NEVER fabricate success!
    const startResult = await this.provider.startOutboundCall({
      sessionId: session.id,
      toNumber: session.phoneNumber,
      purpose: session.purpose,
      disclosureScript: session.disclosureScript,
      callbackBaseUrl: input.callbackBaseUrl || '',
      language: session.language,
    });

    if (!startResult.started) {
      session.state = startResult.errorCode === 'provider_not_configured' ? 'blocked_unconfigured' : 'failed';
      session.errorMessage = startResult.errorMessage || 'VoIP call start failed.';
      this.sessions.set(session.id, session);
      return {
        ok: false,
        error: session.errorMessage,
        errorCode: startResult.errorCode,
        missingEnvVars: startResult.missingEnvVars,
        statusCode: startResult.errorCode === 'provider_not_configured' ? 503 : 502,
        session,
      };
    }

    session.provider = startResult.provider;
    session.providerCallSid = startResult.providerCallSid;
    session.state = 'active';
    session.startedAtIso = new Date().toISOString();
    session.transcript.push({
      speaker: 'ai',
      text: session.disclosureScript,
      timestampIso: session.startedAtIso,
    });
    this.sessions.set(session.id, session);

    return { ok: true, session };
  }

  async transferCallToHuman(sessionId: string, humanNumber: string): Promise<{ ok: boolean; message: string; statusCode: number; session?: CallSessionRecord }> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { ok: false, message: 'Call session not found.', statusCode: 404 };
    }
    if (!session.providerCallSid) {
      return { ok: false, message: 'No active external VoIP call SID to transfer.', statusCode: 409, session };
    }
    const norm = normalizePhoneNumber(humanNumber);
    if (norm.status !== 'valid' || !norm.normalizedNumber) {
      return { ok: false, message: 'Invalid transfer target number.', statusCode: 400, session };
    }

    const res = await this.provider.transferToHuman(session.providerCallSid, norm.normalizedNumber);
    if (!res.success) {
      return { ok: false, message: res.message, statusCode: 502, session };
    }
    session.state = 'transferred';
    session.transcript.push({
      speaker: 'system',
      text: `Call transferred to human user (${norm.normalizedNumber}).`,
      timestampIso: new Date().toISOString(),
    });
    this.sessions.set(session.id, session);
    return { ok: true, message: res.message, statusCode: 200, session };
  }

  async endCall(input: EndCallInput): Promise<{ ok: true; session: CallSessionRecord } | { ok: false; error: string; statusCode: number }> {
    const session = this.sessions.get(input.sessionId);
    if (!session) {
      return { ok: false, error: 'Call session not found.', statusCode: 404 };
    }

    if (session.channel === 'ai_voip' && session.providerCallSid) {
      await this.provider.endCall(session.providerCallSid);
    }

    if (Array.isArray(input.transcript) && input.transcript.length > 0) {
      session.transcript.push(...input.transcript);
    }

    const endedAt = new Date();
    session.endedAtIso = endedAt.toISOString();
    if (session.startedAtIso) {
      session.durationSeconds = Math.max(
        0,
        Math.round((endedAt.getTime() - new Date(session.startedAtIso).getTime()) / 1000)
      );
    }
    if (session.state !== 'blocked_unconfigured' && session.state !== 'failed') {
      session.state = 'ended';
    }

    if (input.reason) {
      session.transcript.push({
        speaker: 'system',
        text: `Call ended: ${input.reason}`,
        timestampIso: session.endedAtIso,
      });
    }

    session.summary = await this.buildSummary(session);
    this.sessions.set(session.id, session);
    return { ok: true, session };
  }

  getHistory(limit: number = 50): CallSessionRecord[] {
    return Array.from(this.sessions.values())
      .sort((a, b) => b.createdAtIso.localeCompare(a.createdAtIso))
      .slice(0, Math.max(1, Math.min(limit, 200)));
  }

  getSession(sessionId: string): CallSessionRecord | undefined {
    return this.sessions.get(sessionId);
  }

  async getSummary(sessionId: string): Promise<{ ok: true; summary: CallSummaryRecord; session: CallSessionRecord } | { ok: false; error: string; statusCode: number }> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { ok: false, error: 'Call session not found.', statusCode: 404 };
    }
    if (!session.summary) {
      session.summary = await this.buildSummary(session);
      this.sessions.set(session.id, session);
    }
    return { ok: true, summary: session.summary, session };
  }

  clearHistory(): number {
    const count = this.sessions.size;
    this.sessions.clear();
    return count;
  }

  private async buildSummary(session: CallSessionRecord): Promise<CallSummaryRecord> {
    if (this.summaryGenerator) {
      try {
        return await this.summaryGenerator(session);
      } catch {
        // Fall through to deterministic summary if Gemini is unreachable
      }
    }

    const turnCount = session.transcript.length;
    const outcome =
      session.state === 'blocked_unconfigured'
        ? 'Blocked: External VoIP provider credentials not configured'
        : session.state === 'failed'
        ? `Failed: ${session.errorMessage || 'Provider error'}`
        : session.state === 'transferred'
        ? 'Transferred to human user'
        : session.state === 'ended'
        ? `Completed (${session.durationSeconds}s)`
        : `Status: ${session.state}`;

    return {
      sessionId: session.id,
      summaryText: `${session.channel === 'sim' ? 'SIM' : 'AI VoIP'} ${session.direction} call to ${session.targetName} (${session.phoneNumber}) for "${session.purpose}". ${outcome}. Captured ${turnCount} event/transcript entries.`,
      actionItems:
        session.state === 'blocked_unconfigured'
          ? ['Configure VOIP_PROVIDER + Twilio/SIP credentials in backend .env to enable live external AI VoIP calls.']
          : session.channel === 'sim'
          ? ['Review native Android Phone call log for carrier call duration.']
          : ['Review call transcript and follow up if required.'],
      outcome,
      generatedBy: 'deterministic',
      createdAtIso: new Date().toISOString(),
    };
  }
}
