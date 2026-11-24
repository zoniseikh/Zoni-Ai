/**
 * Zoni AI — Server-Side Gemini API Endpoint & Live WebSocket Routing Helpers
 *
 * All Gemini API calls (chat, tool-calling feedback, multimodal screen analysis,
 * notification smart replies, TTS, and bidirectional Gemini Live audio) run on
 * the Express + WebSocket server (`server.ts`) using `process.env.GEMINI_API_KEY`.
 *
 * The browser client never calls Google Gemini endpoints directly and never
 * stores or prompts for a Gemini API key.
 */

export const LEGACY_BROWSER_KEY_STORAGE = 'zoni_byok_browser_gemini_api_key';
export const LEGACY_USER_KEY_STORAGE = 'zoni_user_gemini_key';
export const LEGACY_BACKEND_URL_STORAGE = 'zoni_backend_url';

export interface ServerHealthSnapshot {
  checked: boolean;
  reachable: boolean;
  geminiConfigured: boolean;
  statusText: string;
  configurationError?: string | null;
  liveSupported?: boolean;
  toolsCount?: number;
  serverTimeIST?: string;
}

export interface LiveWsUrlParams {
  mode?: string;
  selectedAffectionName?: string;
  voice?: string;
  lang?: string;
  handle?: string;
}

/**
 * Cleans up any legacy client-side key or backend URL entries left over in browser storage.
 */
export function cleanupLegacyClientStorage(
  win: Window | undefined = typeof window !== 'undefined' ? window : undefined
): void {
  if (!win) return;
  try {
    win.localStorage?.removeItem(LEGACY_BROWSER_KEY_STORAGE);
    win.localStorage?.removeItem(LEGACY_USER_KEY_STORAGE);
    win.localStorage?.removeItem(LEGACY_BACKEND_URL_STORAGE);
  } catch {
    // ignore storage restrictions
  }
}

/**
 * Resolves the base HTTP origin for the Zoni AI server.
 * Uses the current same-origin server automatically in browsers.
 */
export function getServerBaseUrl(
  win: Window | undefined = typeof window !== 'undefined' ? window : undefined
): string {
  const envUrl =
    typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_SERVER_URL
      ? String((import.meta as any).env.VITE_SERVER_URL).trim()
      : '';
  if (envUrl && /^https?:\/\//i.test(envUrl)) {
    return envUrl.replace(/\/+$/, '');
  }
  if (win?.location?.origin && /^https?:\/\//i.test(win.location.origin)) {
    return win.location.origin.replace(/\/+$/, '');
  }
  return '';
}

/**
 * Builds a server API endpoint URL (e.g. `/api/chat`, `/api/status`, `/api/tts`).
 */
export function buildServerApiUrl(
  endpointPath: string,
  win: Window | undefined = typeof window !== 'undefined' ? window : undefined
): string {
  const normalizedPath = endpointPath.startsWith('/') ? endpointPath : `/${endpointPath}`;
  const base = getServerBaseUrl(win);
  return base ? `${base}${normalizedPath}` : normalizedPath;
}

/**
 * Builds the server-side Gemini Live WebSocket URL (`ws(s)://<host>/live?...`).
 * Authentication happens exclusively on the server via `process.env.GEMINI_API_KEY`.
 */
export function buildServerLiveWsUrl(
  params: LiveWsUrlParams = {},
  win: Window | undefined = typeof window !== 'undefined' ? window : undefined
): string {
  const base = getServerBaseUrl(win);
  let wsBase = '';

  if (base) {
    wsBase = base.replace(/^https:\/\//i, 'wss://').replace(/^http:\/\//i, 'ws://');
  } else if (win?.location?.host) {
    const protocol = win.location.protocol === 'https:' ? 'wss:' : 'ws:';
    wsBase = `${protocol}//${win.location.host}`;
  } else {
    wsBase = 'ws://localhost:3000';
  }

  const query = new URLSearchParams();
  if (params.mode) query.set('mode', params.mode);
  if (params.selectedAffectionName) {
    query.set('selectedAffectionName', params.selectedAffectionName);
    query.set('nickname', params.selectedAffectionName);
  }
  if (params.voice) query.set('voice', params.voice);
  if (params.lang) query.set('lang', params.lang);
  if (params.handle) query.set('handle', params.handle);

  const qs = query.toString();
  return `${wsBase}/live${qs ? `?${qs}` : ''}`;
}

/**
 * Sanitizes any client-side error text so credentials are never echoed in UI or logs.
 */
export function sanitizeErrorText(input: unknown): string {
  let text =
    input instanceof Error
      ? input.message || String(input)
      : typeof input === 'string'
      ? input
      : input && typeof input === 'object' && 'message' in (input as any)
      ? String((input as any).message || '')
      : String(input ?? '');

  text = text.replace(/AIza[0-9A-Za-z_\-]{12,}/g, '[REDACTED]');
  text = text.replace(/AQ\.[0-9A-Za-z._\-]{12,}/g, '[REDACTED]');
  text = text.replace(/([?&]key=)[^&\s"'`]+/gi, '$1[REDACTED]');
  return text.trim();
}

/**
 * Queries the Zoni AI server's `/api/status` health endpoint to verify server
 * availability and server-side Gemini readiness.
 */
export async function fetchServerStatus(
  fetchImpl: typeof fetch = fetch,
  win: Window | undefined = typeof window !== 'undefined' ? window : undefined
): Promise<ServerHealthSnapshot> {
  try {
    const res = await fetchImpl(buildServerApiUrl('/api/status', win), {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      return {
        checked: true,
        reachable: false,
        geminiConfigured: false,
        statusText: `SERVER HTTP ${res.status}`,
        configurationError: `Server returned status ${res.status}. Please retry shortly.`,
      };
    }
    const data = await res.json();
    const configured = Boolean(data?.geminiConfigured);
    return {
      checked: true,
      reachable: true,
      geminiConfigured: configured,
      statusText: configured ? 'SERVER AI READY' : 'AI SERVICE STANDBY',
      configurationError: configured
        ? null
        : String(
            data?.configurationError ||
              'Gemini API key is not configured on the server. Check Settings > Secrets.'
          ),
      liveSupported: Boolean(data?.geminiLiveSupported ?? configured),
      toolsCount: typeof data?.assistantToolsCount === 'number' ? data.assistantToolsCount : undefined,
      serverTimeIST: typeof data?.currentTimeIST === 'string' ? data.currentTimeIST : undefined,
    };
  } catch (err) {
    return {
      checked: true,
      reachable: false,
      geminiConfigured: false,
      statusText: 'SERVER OFFLINE',
      configurationError:
        sanitizeErrorText(err) || 'Could not reach the Zoni AI server. Please check your connection.',
    };
  }
}
