/**
 * Zoni AI — Hybrid Gemini BYOK (Bring Your Own Key) & Server Fallback Configuration
 *
 * Supports BOTH:
 * 1. User's Own Gemini API Key (BYOK) — Works 100% standalone on Android APK
 *    (stored encrypted in Android Keystore via ZoniAndroidBridge) and in Web/PWA
 *    browsers, connecting directly to Google Gemini REST + Live WebSocket with
 *    ZERO backend server URL required.
 * 2. Managed Server Proxy (`/api/*` + `/live`) — Automatically used in hosted
 *    web preview when the user has not entered a custom key and the Zoni AI
 *    Express server is reachable with valid JSON `/api/status`.
 *
 * Security invariants:
 * - Never logs, displays, or persists the raw API key in chat history or diagnostics.
 * - Accepts official Google Gemini API key formats (`AIza...` and `AQ....`) while
 *   cleaning invisible clipboard characters, surrounding quotes, and env prefixes.
 * - Safely detects HTML (`<!doctype html>`) responses on Android WebViewAssetLoader
 *   or static hosts so `Unexpected token '<'` JSON parse errors never appear.
 */

import {
  deleteNativeGeminiApiKey,
  getNativeAndroidBridge,
  getNativeGeminiApiKeyForRequest,
  getNativeGeminiApiKeyStatus,
  saveNativeGeminiApiKey,
} from './androidBridge';

export const BYOK_BROWSER_KEY_STORAGE = 'zoni_byok_browser_gemini_api_key';
export const LEGACY_BROWSER_KEY_STORAGE = BYOK_BROWSER_KEY_STORAGE;
export const LEGACY_USER_KEY_STORAGE = 'zoni_user_gemini_key';
export const LEGACY_BACKEND_URL_STORAGE = 'zoni_backend_url';

export interface ServerHealthSnapshot {
  checked: boolean;
  reachable: boolean;
  geminiConfigured: boolean;
  statusText: string;
  configurationError?: string | null;
  connectionMode?: 'byok_direct' | 'server_managed' | 'unconfigured';
  isStandaloneClient?: boolean;
  maskedKeyPreview?: string;
  storageLabel?: string;
  preferredChatModel?: string;
  preferredLiveModel?: string;
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

export interface GeminiApiKeyValidationResult {
  valid: boolean;
  normalizedKey: string;
  error?: string;
}

export interface GeminiApiKeyStatus {
  configured: boolean;
  maskedPreview: string;
  storageKind: 'android_keystore' | 'browser_local' | 'none';
  storageLabel: string;
}

export interface SaveGeminiApiKeyResult {
  ok: boolean;
  maskedPreview?: string;
  storageKind?: GeminiApiKeyStatus['storageKind'];
  error?: string;
}

const GEMINI_KEY_PATTERN = /^[A-Za-z0-9._\-~+=]{16,512}$/;
const INVISIBLE_CLIPBOARD_CHARS = /[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g;
const ENV_KEY_PREFIX_REGEX =
  /^(?:export\s+)?(?:VITE_)?(?:GEMINI|GOOGLE|ZONI)?_?API_KEY\s*=\s*(.+)$/i;

/**
 * Returns true when running inside the native Android APK WebView with ZoniAndroidBridge.
 */
export function isNativeAndroidApkRuntime(): boolean {
  return Boolean(getNativeAndroidBridge());
}

/**
 * Cleans up obsolete legacy backend URL entries without deleting the user's saved BYOK Gemini API key.
 */
export function cleanupLegacyBackendStorage(
  win: Window | undefined = typeof window !== 'undefined' ? window : undefined
): void {
  if (!win) return;
  try {
    win.localStorage?.removeItem(LEGACY_BACKEND_URL_STORAGE);
  } catch {
    // ignore storage restrictions
  }
}

/**
 * Backward-compatible alias for cleaning obsolete backend URL storage.
 */
export function cleanupLegacyClientStorage(
  win: Window | undefined = typeof window !== 'undefined' ? window : undefined
): void {
  cleanupLegacyBackendStorage(win);
}

/**
 * Cleans common mobile/desktop clipboard artifacts around a pasted Gemini API key
 * (invisible zero-width chars, BOM, non-breaking spaces, surrounding quotes, or
 * `GEMINI_API_KEY=` / `API_KEY=` env prefixes) without altering valid key characters.
 */
export function normalizePastedGeminiKey(rawKey: string | null | undefined): string {
  let clean = String(rawKey ?? '')
    .replace(INVISIBLE_CLIPBOARD_CHARS, '')
    .replace(/\u00A0/g, ' ')
    .trim();

  const envMatch = ENV_KEY_PREFIX_REGEX.exec(clean);
  if (envMatch && envMatch[1]) {
    clean = envMatch[1].trim();
  }

  if (
    clean.length >= 2 &&
    ((clean.startsWith('"') && clean.endsWith('"')) ||
      (clean.startsWith("'") && clean.endsWith("'")) ||
      (clean.startsWith('`') && clean.endsWith('`')) ||
      (clean.startsWith('\u201C') && clean.endsWith('\u201D')) ||
      (clean.startsWith('\u2018') && clean.endsWith('\u2019')))
  ) {
    clean = clean.slice(1, -1).trim();
  }

  return clean;
}

/**
 * Validates the syntax/shape of a user-provided Google Gemini API key before saving.
 * Accepts both AI Studio (`AIza...`) and Google Cloud / Vertex Express (`AQ....`) keys.
 */
export function validateGeminiApiKeyFormat(
  rawKey: string | null | undefined
): GeminiApiKeyValidationResult {
  const trimmed = normalizePastedGeminiKey(rawKey);
  if (!trimmed) {
    return {
      valid: false,
      normalizedKey: '',
      error: 'Please enter your Gemini API Key.',
    };
  }
  if (/^(?:https?|wss?):\/\//i.test(trimmed) || trimmed.includes('://')) {
    return {
      valid: false,
      normalizedKey: '',
      error: 'Enter your Gemini API Key (e.g., AIza... or AQ....), not a server URL.',
    };
  }
  if (/\s/.test(trimmed)) {
    return {
      valid: false,
      normalizedKey: '',
      error: 'Gemini API Key cannot contain spaces or line breaks.',
    };
  }
  if (trimmed.length < 16 || trimmed.length > 512) {
    return {
      valid: false,
      normalizedKey: '',
      error:
        'Gemini API Key length looks invalid. Paste the complete key from Google AI Studio or Google Cloud.',
    };
  }
  if (!GEMINI_KEY_PATTERN.test(trimmed)) {
    return {
      valid: false,
      normalizedKey: '',
      error: 'Gemini API Key contains invalid characters.',
    };
  }
  return {
    valid: true,
    normalizedKey: trimmed,
  };
}

/**
 * Masks a Gemini API key so the full secret is never displayed back in the UI.
 */
export function maskGeminiApiKey(rawKey: string | null | undefined): string {
  const clean = normalizePastedGeminiKey(rawKey);
  if (!clean) return '';
  if (clean.length <= 8) {
    return `${clean.slice(0, 2)}••••••`;
  }
  return `${clean.slice(0, 4)}••••••••${clean.slice(-4)}`;
}

/**
 * Returns the current status of the user's saved BYOK Gemini API key
 * (checks Android Keystore first on APK, then local browser storage).
 */
export function getGeminiApiKeyStatus(
  win: Window | undefined = typeof window !== 'undefined' ? window : undefined
): GeminiApiKeyStatus {
  const nativeStatus = getNativeGeminiApiKeyStatus();
  if (nativeStatus) {
    if (nativeStatus.configured) {
      return {
        configured: true,
        maskedPreview: nativeStatus.maskedPreview || '••••••••••••',
        storageKind: 'android_keystore',
        storageLabel: nativeStatus.keystoreBacked
          ? 'Android Keystore (Encrypted)'
          : 'Android Local Secure Storage',
      };
    }
    // Fall through only if browser localStorage also holds a key; otherwise report Android Keystore ready
  }

  if (win) {
    try {
      const saved =
        win.localStorage?.getItem(BYOK_BROWSER_KEY_STORAGE) ||
        win.localStorage?.getItem(LEGACY_USER_KEY_STORAGE) ||
        '';
      const cleaned = normalizePastedGeminiKey(saved);
      if (cleaned) {
        return {
          configured: true,
          maskedPreview: maskGeminiApiKey(cleaned),
          storageKind: 'browser_local',
          storageLabel: 'Local Browser Storage',
        };
      }
    } catch {
      // ignore storage errors
    }
  }

  return {
    configured: false,
    maskedPreview: '',
    storageKind: 'none',
    storageLabel: nativeStatus ? 'Android Keystore (Not Set)' : 'Not Configured',
  };
}

/**
 * Retrieves the user's own Gemini API key strictly for direct Google Gemini API requests.
 * Never log or display the returned string.
 */
export function getGeminiApiKeyForRequest(
  win: Window | undefined = typeof window !== 'undefined' ? window : undefined
): string {
  const nativeKey = normalizePastedGeminiKey(getNativeGeminiApiKeyForRequest());
  if (nativeKey) return nativeKey;

  if (!win) return '';
  try {
    const saved =
      win.localStorage?.getItem(BYOK_BROWSER_KEY_STORAGE) ||
      win.localStorage?.getItem(LEGACY_USER_KEY_STORAGE) ||
      '';
    return normalizePastedGeminiKey(saved);
  } catch {
    return '';
  }
}

/**
 * Validates and saves the user's own Gemini API key locally (Android Keystore on APK,
 * localStorage on web) and dispatches `zoni:gemini-key-updated`.
 */
export function saveGeminiApiKey(
  rawKey: string,
  win: Window | undefined = typeof window !== 'undefined' ? window : undefined
): SaveGeminiApiKeyResult {
  const validation = validateGeminiApiKeyFormat(rawKey);
  if (!validation.valid) {
    return {
      ok: false,
      error: validation.error || 'Invalid Gemini API Key.',
    };
  }

  const normalized = validation.normalizedKey;
  let storageKind: GeminiApiKeyStatus['storageKind'] = 'browser_local';

  if (getNativeAndroidBridge()?.saveGeminiApiKey) {
    const savedNative = saveNativeGeminiApiKey(normalized);
    if (!savedNative) {
      return {
        ok: false,
        error: 'Could not save Gemini API Key in Android Keystore. Please check key format and retry.',
      };
    }
    storageKind = 'android_keystore';
    // Remove any duplicate plain localStorage copy when Android Keystore holds the key
    try {
      win?.localStorage?.removeItem(BYOK_BROWSER_KEY_STORAGE);
      win?.localStorage?.removeItem(LEGACY_USER_KEY_STORAGE);
    } catch {
      // ignore
    }
  } else if (win) {
    try {
      win.localStorage?.setItem(BYOK_BROWSER_KEY_STORAGE, normalized);
      win.localStorage?.removeItem(LEGACY_USER_KEY_STORAGE);
      storageKind = 'browser_local';
    } catch {
      return {
        ok: false,
        error: 'Unable to save Gemini API Key in browser storage.',
      };
    }
  }

  try {
    win?.dispatchEvent?.(new CustomEvent('zoni:gemini-key-updated', { detail: { configured: true } }));
  } catch {
    // ignore event errors in non-DOM test environments
  }

  return {
    ok: true,
    maskedPreview: maskGeminiApiKey(normalized),
    storageKind,
  };
}

/**
 * Deletes the user's saved Gemini API key from Android Keystore and browser storage.
 */
export function deleteGeminiApiKey(
  win: Window | undefined = typeof window !== 'undefined' ? window : undefined
): void {
  if (getNativeAndroidBridge()?.deleteGeminiApiKey) {
    deleteNativeGeminiApiKey();
  }
  if (win) {
    try {
      win.localStorage?.removeItem(BYOK_BROWSER_KEY_STORAGE);
      win.localStorage?.removeItem(LEGACY_USER_KEY_STORAGE);
    } catch {
      // ignore
    }
  }
  try {
    win?.dispatchEvent?.(new CustomEvent('zoni:gemini-key-updated', { detail: { configured: false } }));
  } catch {
    // ignore
  }
}

/**
 * Returns a localized guidance message when no Gemini API key is configured, or `null` when configured.
 */
export function getGeminiConfigError(
  win: Window | undefined = typeof window !== 'undefined' ? window : undefined,
  lang: string = 'bn-BD'
): string | null {
  if (getGeminiApiKeyStatus(win).configured) {
    return null;
  }
  if (lang === 'hi-IN') {
    return 'Gemini AI उपयोग करने के लिए Setup या Settings में अपनी Gemini API Key दर्ज करें। किसी बैकएंड सर्वर URL की आवश्यकता नहीं है।';
  }
  if (lang === 'en-US') {
    return 'Enter your own Gemini API Key in Setup or Settings to connect directly to Google Gemini. No backend server URL is needed.';
  }
  return 'Gemini AI ব্যবহার করতে Setup বা Settings থেকে আপনার নিজের Gemini API Key দিন। কোনো ব্যাকএন্ড সার্ভার URL প্রয়োজন নেই।';
}

/**
 * Resolves the base HTTP origin for the Zoni AI server (used in hosted web preview).
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
 * Redacts an explicit secret token (if provided) and any accidental Google API key
 * patterns from error or diagnostic strings.
 */
export function sanitizeGeminiSecret(input: unknown, explicitKey?: string): string {
  let cleaned = sanitizeErrorText(input);
  const trimmedKey = typeof explicitKey === 'string' ? explicitKey.trim() : '';
  if (trimmedKey && trimmedKey.length >= 6) {
    cleaned = cleaned.split(trimmedKey).join('[REDACTED]');
  }
  return cleaned;
}

/**
 * Queries the Zoni AI server's `/api/status` health endpoint when running on a hosted web server.
 * Safely detects Android APK / static HTML fallbacks (`<!doctype html>`) and NEVER throws
 * `Unexpected token '<', "<!doctype "... is not valid JSON`.
 */
export async function fetchServerStatus(
  fetchImpl: typeof fetch = fetch,
  win: Window | undefined = typeof window !== 'undefined' ? window : undefined,
  lang: string = 'bn-BD'
): Promise<ServerHealthSnapshot> {
  // On native Android APK WebViewAssetLoader (`appassets.androidplatform.net`), there is no local Express server.
  const host = win?.location?.host || '';
  const isAndroidAssetOrigin =
    isNativeAndroidApkRuntime() ||
    host.includes('appassets.androidplatform.net') ||
    win?.location?.protocol === 'file:';

  if (isAndroidAssetOrigin) {
    return {
      checked: true,
      reachable: false,
      geminiConfigured: false,
      connectionMode: 'unconfigured',
      isStandaloneClient: true,
      statusText: 'API KEY REQUIRED',
      configurationError: getGeminiConfigError(win, lang),
      storageLabel: getGeminiApiKeyStatus(win).storageLabel,
    };
  }

  try {
    const res = await fetchImpl(buildServerApiUrl('/api/status', win), {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });

    const contentType = (res.headers?.get('content-type') || '').toLowerCase();
    const rawBody = await res.text();
    const looksLikeHtml =
      contentType.includes('text/html') ||
      /^\s*<!doctype\s+html|^\s*<html/i.test(rawBody);

    if (looksLikeHtml) {
      return {
        checked: true,
        reachable: false,
        geminiConfigured: false,
        connectionMode: 'unconfigured',
        isStandaloneClient: true,
        statusText: 'API KEY REQUIRED',
        configurationError: getGeminiConfigError(win, lang),
        storageLabel: getGeminiApiKeyStatus(win).storageLabel,
      };
    }

    if (!res.ok) {
      return {
        checked: true,
        reachable: false,
        geminiConfigured: false,
        connectionMode: 'unconfigured',
        isStandaloneClient: false,
        statusText: `SERVER HTTP ${res.status}`,
        configurationError: getGeminiConfigError(win, lang),
      };
    }

    let data: any = null;
    try {
      data = JSON.parse(rawBody);
    } catch {
      return {
        checked: true,
        reachable: false,
        geminiConfigured: false,
        connectionMode: 'unconfigured',
        isStandaloneClient: true,
        statusText: 'API KEY REQUIRED',
        configurationError: getGeminiConfigError(win, lang),
      };
    }

    const configured = Boolean(data?.geminiConfigured);
    return {
      checked: true,
      reachable: true,
      geminiConfigured: configured,
      connectionMode: configured ? 'server_managed' : 'unconfigured',
      isStandaloneClient: false,
      statusText: configured ? 'SERVER AI READY' : 'API KEY REQUIRED',
      configurationError: configured ? null : getGeminiConfigError(win, lang),
      liveSupported: Boolean(data?.geminiLiveSupported ?? configured),
      toolsCount: typeof data?.assistantToolsCount === 'number' ? data.assistantToolsCount : undefined,
      serverTimeIST: typeof data?.currentTimeIST === 'string' ? data.currentTimeIST : undefined,
    };
  } catch {
    return {
      checked: true,
      reachable: false,
      geminiConfigured: false,
      connectionMode: 'unconfigured',
      isStandaloneClient: true,
      statusText: 'API KEY REQUIRED',
      configurationError: getGeminiConfigError(win, lang),
    };
  }
}
