import { getApiBaseUrl } from './apiConfig';

export interface HybridCallSession {
  id: string;
  channel: 'sim' | 'ai_voip';
  direction: 'outgoing' | 'incoming';
  targetName: string;
  phoneNumber: string;
  purpose: string;
  language: string;
  state: string;
  disclosureScript: string;
  recordingEnabled: boolean;
  provider: string;
  providerCallSid?: string;
  errorMessage?: string;
  createdAtIso: string;
  startedAtIso?: string;
  endedAtIso?: string;
  durationSeconds: number;
  summary?: {
    sessionId: string;
    summaryText: string;
    actionItems: string[];
    outcome: string;
    generatedBy: string;
    createdAtIso: string;
  };
}

export interface VoipProviderReadiness {
  provider: string;
  configured: boolean;
  callerId?: string;
  sipTrunkUri?: string;
  missingEnvVars: string[];
  legalDisclosureRequired: boolean;
}

export interface NativeContactItem {
  id: string;
  name: string;
  phone: string;
}

export async function fetchHybridStatus(): Promise<{
  voipProvider: VoipProviderReadiness | null;
  status: string;
}> {
  try {
    const res = await fetch(`${getApiBaseUrl()}/api/status`);
    if (!res.ok) return { voipProvider: null, status: 'offline' };
    const data = await res.json();
    return {
      voipProvider: data.voipProvider || null,
      status: data.status || 'online',
    };
  } catch {
    return { voipProvider: null, status: 'offline' };
  }
}

export async function prepareHybridCall(payload: {
  channel: 'sim' | 'ai_voip';
  targetName?: string;
  phoneNumber: string;
  purpose?: string;
  language?: string;
  callerLabel?: string;
}): Promise<{ ok: boolean; session?: HybridCallSession; error?: string }> {
  const res = await fetch(`${getApiBaseUrl()}/api/calls/prepare`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return { ok: false, error: data.error || `HTTP ${res.status}` };
  }
  return { ok: true, session: data.session };
}

export async function authorizeHybridCall(payload: {
  sessionId: string;
  confirmedByUser: boolean;
  aiIdentityDisclosed: boolean;
  recordingConsentGranted?: boolean;
}): Promise<{ ok: boolean; session?: HybridCallSession; error?: string }> {
  const res = await fetch(`${getApiBaseUrl()}/api/calls/authorize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return { ok: false, error: data.error || `HTTP ${res.status}` };
  }
  return { ok: true, session: data.session };
}

export async function startHybridCall(sessionId: string): Promise<{
  ok: boolean;
  session?: HybridCallSession;
  simDialUri?: string;
  error?: string;
  errorCode?: string;
  missingEnvVars?: string[];
}> {
  const res = await fetch(`${getApiBaseUrl()}/api/calls/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return {
      ok: false,
      error: data.error || `HTTP ${res.status}`,
      errorCode: data.errorCode,
      missingEnvVars: data.missingEnvVars,
      session: data.session,
    };
  }
  return { ok: true, session: data.session, simDialUri: data.simDialUri };
}

export async function endHybridCall(sessionId: string, reason?: string): Promise<{
  ok: boolean;
  session?: HybridCallSession;
  error?: string;
}> {
  const res = await fetch(`${getApiBaseUrl()}/api/calls/end`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, reason }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return { ok: false, error: data.error || `HTTP ${res.status}` };
  }
  return { ok: true, session: data.session };
}

export async function fetchCallHistory(): Promise<HybridCallSession[]> {
  try {
    const res = await fetch(`${getApiBaseUrl()}/api/calls/history`);
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.calls) ? data.calls : [];
  } catch {
    return [];
  }
}

export async function clearBackendCallHistory(): Promise<boolean> {
  try {
    const res = await fetch(`${getApiBaseUrl()}/api/calls/history`, { method: 'DELETE' });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Queries native Android Contacts via window.ZoniAndroidBridge when running inside the APK.
 */
export function searchNativeAndroidContacts(query: string): NativeContactItem[] {
  if (typeof window === 'undefined') return [];
  const bridge = (window as any).ZoniAndroidBridge;
  if (!bridge || typeof bridge.searchContactsJson !== 'function') return [];
  try {
    const raw = bridge.searchContactsJson(query);
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((c) => c && typeof c.name === 'string' && typeof c.phone === 'string');
  } catch {
    return [];
  }
}

/**
 * Generates GSM MMI conditional call forwarding code (lawful carrier-side SIM-to-VoIP routing).
 * Example: *61*+15551234567# forwards unanswered SIM calls to your VoIP/SIP DID.
 */
export function buildCarrierForwardingCode(
  condition: 'no_answer' | 'busy' | 'unreachable' | 'cancel_all',
  voipDidNumber?: string
): string {
  if (condition === 'cancel_all') return '##002#';
  const clean = (voipDidNumber || '').replace(/[^\d+]/g, '');
  if (!clean) return '';
  const prefix = condition === 'no_answer' ? '*61*' : condition === 'busy' ? '*67*' : '*62*';
  return `${prefix}${clean}#`;
}
