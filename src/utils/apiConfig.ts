/**
 * Zoni AI — Pure Gemini BYOK (Bring Your Own Key) Configuration & Storage
 *
 * Removes all mandatory ZONI backend server URL configuration.
 * Each user provides their own Google Gemini API key directly:
 * - On Android APK: stored in Android Keystore-backed EncryptedSharedPreferences
 *   via `window.ZoniAndroidBridge` (never duplicated to WebView localStorage).
 * - In Browser Preview: stored in a clearly separated local development storage
 *   slot with an explicit notice that browser storage is not equivalent to
 *   Android Keystore security.
 *
 * Security invariants:
 * - Never embeds any developer Gemini API key.
 * - Never falls back to any developer-owned backend server URL.
 * - Never exposes the full saved API key in status snapshots, diagnostics,
 *   chat history, console logs, or error messages.
 */

import {
  deleteNativeGeminiApiKey,
  getNativeAndroidBridge,
  getNativeGeminiApiKeyForRequest,
  getNativeGeminiApiKeyStatus,
  saveNativeGeminiApiKey,
} from './androidBridge';

export const BROWSER_BYOK_STORAGE_KEY = 'zoni_byok_browser_gemini_api_key';
export const LEGACY_USER_KEY_STORAGE = 'zoni_user_gemini_key';
export const LEGACY_BACKEND_URL_STORAGE = 'zoni_backend_url';

export type GeminiKeyStorageKind =
  | 'android_keystore'
  | 'android_encrypted_fallback'
  | 'browser_preview_local_storage'
  | 'none';

export interface GeminiApiKeyStatus {
  configured: boolean;
  maskedPreview: string;
  storageKind: GeminiKeyStorageKind;
  storageLabel: string;
  securityNotice: string;
  isNativeAndroid: boolean;
}

export interface SaveGeminiKeyResult {
  ok: boolean;
  error?: string;
  status: GeminiApiKeyStatus;
}

/**
 * Detects whether the React dashboard is running inside the packaged Android APK
 * WebView shell (WebViewAssetLoader / Capacitor / native bridge).
 */
export function isNativeAndroidWebShell(
  win: Window | undefined = typeof window !== 'undefined' ? window : undefined
): boolean {
  if (!win) return false;
  const host = (win.location?.hostname || '').toLowerCase();
  const protocol = (win.location?.protocol || '').toLowerCase();
  return (
    Boolean((win as any).ZoniAndroidBridge) ||
    Boolean((win as any).__ZONI_ANDROID_NATIVE__) ||
    host === 'appassets.androidplatform.net' ||
    protocol === 'capacitor:' ||
    protocol === 'ionic:' ||
    protocol === 'file:'
  );
}

/**
 * Cleans common mobile/desktop clipboard artifacts around a pasted Gemini API key
 * (invisible zero-width chars, BOM, non-breaking spaces, surrounding quotes, or
 * `GEMINI_API_KEY=` / `API_KEY=` env prefixes) without altering valid key characters.
 */
function normalizePastedGeminiKey(rawKey: string | null | undefined): string {
  let clean = String(rawKey || '')
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, '')
    .replace(/\u00A0/g, ' ')
    .trim();

  // Strip common .env / shell variable prefixes (e.g. GEMINI_API_KEY=AIza...)
  const envPrefixMatch = /^(?:export\s+)?(?:VITE_)?(?:GEMINI|GOOGLE|ZONI)?_?API_KEY\s*=\s*(.+)$/i.exec(clean);
  if (envPrefixMatch && envPrefixMatch[1]) {
    clean = envPrefixMatch[1].trim();
  }

  // Strip matching surrounding straight/smart quotes or backticks
  if (
    clean.length >= 2 &&
    ((clean.startsWith('"') && clean.endsWith('"')) ||
      (clean.startsWith("'") && clean.endsWith("'")) ||
      (clean.startsWith('`') && clean.endsWith('`')) ||
      (clean.startsWith('“') && clean.endsWith('”')) ||
      (clean.startsWith('‘') && clean.endsWith('’')))
  ) {
    clean = clean.slice(1, -1).trim();
  }

  return clean;
}

/**
 * Validates the syntax/shape of a user-provided Google Gemini API key before saving.
 * Accepts all official Google Gemini API key formats (both Google AI Studio `AIza...`
 * keys and Google Cloud / Vertex Express `AQ....` keys containing dots).
 * Does NOT call the network; live key verification happens in `verifyDirectGeminiApiKey`.
 */
export function validateGeminiApiKeyFormat(rawKey: string | null | undefined): {
  valid: boolean;
  normalizedKey?: string;
  error?: string;
} {
  const trimmed = normalizePastedGeminiKey(rawKey);
  if (!trimmed) {
    return {
      valid: false,
      error: 'Please enter your Gemini API key.',
    };
  }
  if (/^(?:https?|wss?):\/\//i.test(trimmed) || trimmed.includes('://')) {
    return {
      valid: false,
      error: 'Enter your Gemini API key (e.g., AIza... or AQ....), not a server URL.',
    };
  }
  if (/\s/.test(trimmed)) {
    return {
      valid: false,
      error: 'Gemini API keys cannot contain spaces or line breaks.',
    };
  }
  if (trimmed.length < 16 || trimmed.length > 512) {
    return {
      valid: false,
      error: 'Gemini API key length looks invalid. Paste the full key from Google AI Studio or Google Cloud.',
    };
  }
  if (!/^[A-Za-z0-9._\-~+=]+$/.test(trimmed)) {
    return {
      valid: false,
      error: 'Gemini API key contains invalid characters.',
    };
  }
  return {
    valid: true,
    normalizedKey: trimmed,
  };
}

/**
 * Produces a non-reversible masked preview (e.g. `AIza••••••9aBc`) so the full
 * saved API key is never shown in UI, diagnostics, or logs after saving.
 */
export function maskGeminiApiKey(rawKey: string | null | undefined): string {
  const clean = normalizePastedGeminiKey(rawKey);
  if (!clean) return '';
  if (clean.length <= 8) {
    return `${clean.slice(0, 2)}••••`;
  }
  return `${clean.slice(0, 4)}••••••••${clean.slice(-4)}`;
}

/**
 * Redacts Gemini API keys and query credentials from any error message, log line,
 * or diagnostic payload so user secrets can never leak.
 */
export function sanitizeGeminiSecret(
  input: unknown,
  explicitKey?: string | null
): string {
  let text =
    input instanceof Error
      ? input.message || String(input)
      : typeof input === 'string'
      ? input
      : input && typeof input === 'object' && 'message' in (input as any)
      ? String((input as any).message || '')
      : String(input ?? '');

  if (explicitKey && explicitKey.trim().length >= 8) {
    text = text.split(explicitKey.trim()).join('[REDACTED_API_KEY]');
  }

  // Redact Google AI Studio (AIza...) and Google Cloud / Express (AQ....) API key patterns
  text = text.replace(/AIza[0-9A-Za-z_\-]{12,}/g, '[REDACTED_API_KEY]');
  text = text.replace(/AQ\.[0-9A-Za-z._\-]{12,}/g, '[REDACTED_API_KEY]');
  // Redact key=... query parameter values
  text = text.replace(/([?&]key=)[^&\s"'`]+/gi, '$1[REDACTED_API_KEY]');
  // Redact x-goog-api-key headers if ever echoed
  text = text.replace(/(x-goog-api-key\s*[:=]\s*)[^\s,;'"`]+/gi, '$1[REDACTED_API_KEY]');

  return text;
}

/**
 * Cleans up obsolete backend URL storage left over from pre-BYOK builds.
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

function readBrowserPreviewKey(win: Window | undefined): string {
  if (!win) return '';
  try {
    const primary = (win.localStorage?.getItem(BROWSER_BYOK_STORAGE_KEY) || '').trim();
    if (primary) return primary;
    // Migrate legacy key if present in browser preview
    const legacy = (win.localStorage?.getItem(LEGACY_USER_KEY_STORAGE) || '').trim();
    if (legacy && validateGeminiApiKeyFormat(legacy).valid) {
      win.localStorage?.setItem(BROWSER_BYOK_STORAGE_KEY, legacy);
      win.localStorage?.removeItem(LEGACY_USER_KEY_STORAGE);
      return legacy;
    }
  } catch {
    // ignore storage errors
  }
  return '';
}

function dispatchGeminiKeyUpdated(win: Window | undefined): void {
  if (!win || typeof win.dispatchEvent !== 'function') return;
  try {
    win.dispatchEvent(new CustomEvent('zoni:gemini-key-updated'));
  } catch {
    // ignore in minimal mock window environments
  }
}

/**
 * Returns safe non-secret configuration metadata for UI & diagnostics.
 * NEVER returns the raw saved API key.
 */
export function getGeminiApiKeyStatus(
  win: Window | undefined = typeof window !== 'undefined' ? window : undefined
): GeminiApiKeyStatus {
  const isNative = isNativeAndroidWebShell(win);
  const bridge =
    win && (win as any).ZoniAndroidBridge
      ? ((win as any).ZoniAndroidBridge as ReturnType<typeof getNativeAndroidBridge>)
      : getNativeAndroidBridge();

  if (bridge?.getGeminiApiKeyStatusJson) {
    try {
      const nativeStatus =
        win === (typeof window !== 'undefined' ? window : undefined)
          ? getNativeGeminiApiKeyStatus()
          : JSON.parse(bridge.getGeminiApiKeyStatusJson());
      if (nativeStatus && typeof nativeStatus === 'object') {
        const configured = Boolean(nativeStatus.configured);
        const keystoreBacked = nativeStatus.keystoreBacked !== false;
        const storageKind: GeminiKeyStorageKind = !configured
          ? 'none'
          : keystoreBacked
          ? 'android_keystore'
          : 'android_encrypted_fallback';
        return {
          configured,
          maskedPreview: configured
            ? String(nativeStatus.maskedPreview || 'AIza••••••••')
            : '',
          storageKind,
          storageLabel: configured
            ? keystoreBacked
              ? 'Android Keystore (EncryptedSharedPreferences)'
              : 'Android Private App Storage'
            : 'Not Configured',
          securityNotice:
            'Stored locally on this Android device using Android Keystore encryption. Never uploaded to any ZONI server.',
          isNativeAndroid: true,
        };
      }
    } catch {
      // Fall through safely
    }
  }

  const browserKey = readBrowserPreviewKey(win);
  if (browserKey) {
    return {
      configured: true,
      maskedPreview: maskGeminiApiKey(browserKey),
      storageKind: 'browser_preview_local_storage',
      storageLabel: 'Browser Preview Storage (Local Dev)',
      securityNotice:
        'Browser preview uses local browser storage for development convenience. It is NOT equivalent to Android Keystore hardware-backed encryption.',
      isNativeAndroid: isNative,
    };
  }

  return {
    configured: false,
    maskedPreview: '',
    storageKind: 'none',
    storageLabel: 'Not Configured',
    securityNotice: isNative
      ? 'Your Gemini API key will be encrypted on-device with Android Keystore. No backend server URL is required.'
      : 'Browser preview stores your key in local browser storage only (not equivalent to Android Keystore security). Use your own Gemini API key with billing/quota controls.',
    isNativeAndroid: isNative,
  };
}

/**
 * Retrieves the raw user-owned Gemini API key strictly for outbound requests
 * to Google's official Gemini API endpoints.
 * NEVER pass the return value into logs, UI text, chat messages, or diagnostics.
 */
export function getGeminiApiKeyForRequest(
  win: Window | undefined = typeof window !== 'undefined' ? window : undefined
): string {
  const bridge =
    win && (win as any).ZoniAndroidBridge
      ? ((win as any).ZoniAndroidBridge as ReturnType<typeof getNativeAndroidBridge>)
      : getNativeAndroidBridge();

  if (bridge?.getGeminiApiKeyForRequest) {
    try {
      const nativeKey =
        win === (typeof window !== 'undefined' ? window : undefined)
          ? getNativeGeminiApiKeyForRequest()
          : String(bridge.getGeminiApiKeyForRequest() || '').trim();
      if (nativeKey) return nativeKey;
    } catch {
      // Fall through
    }
  }

  return readBrowserPreviewKey(win);
}

/**
 * Validates and persists the user's own Gemini API key.
 * On Android APK: persists via native Android Keystore bridge and purges any browser copy.
 * On Web Browser: persists in clearly separated browser preview storage.
 */
export function saveGeminiApiKey(
  rawKey: string,
  win: Window | undefined = typeof window !== 'undefined' ? window : undefined
): SaveGeminiKeyResult {
  const validation = validateGeminiApiKeyFormat(rawKey);
  if (!validation.valid || !validation.normalizedKey) {
    return {
      ok: false,
      error: validation.error || 'Invalid Gemini API key.',
      status: getGeminiApiKeyStatus(win),
    };
  }

  const cleanKey = validation.normalizedKey;
  cleanupLegacyBackendStorage(win);

  const bridge =
    win && (win as any).ZoniAndroidBridge
      ? ((win as any).ZoniAndroidBridge as ReturnType<typeof getNativeAndroidBridge>)
      : getNativeAndroidBridge();

  if (bridge?.saveGeminiApiKey) {
    const savedNatively =
      win === (typeof window !== 'undefined' ? window : undefined)
        ? saveNativeGeminiApiKey(cleanKey)
        : Boolean(bridge.saveGeminiApiKey(cleanKey));
    if (!savedNatively) {
      return {
        ok: false,
        error: 'Android Keystore could not save the Gemini API key. Please try again.',
        status: getGeminiApiKeyStatus(win),
      };
    }
    // Ensure key is never duplicated into WebView localStorage when stored in Keystore
    try {
      win?.localStorage?.removeItem(BROWSER_BYOK_STORAGE_KEY);
      win?.localStorage?.removeItem(LEGACY_USER_KEY_STORAGE);
    } catch {
      // ignore
    }
    dispatchGeminiKeyUpdated(win);
    return {
      ok: true,
      status: getGeminiApiKeyStatus(win),
    };
  }

  try {
    win?.localStorage?.setItem(BROWSER_BYOK_STORAGE_KEY, cleanKey);
    win?.localStorage?.removeItem(LEGACY_USER_KEY_STORAGE);
  } catch {
    return {
      ok: false,
      error: 'Unable to save Gemini API key in browser storage.',
      status: getGeminiApiKeyStatus(win),
    };
  }

  dispatchGeminiKeyUpdated(win);
  return {
    ok: true,
    status: getGeminiApiKeyStatus(win),
  };
}

/**
 * Permanently deletes the user's saved Gemini API key from Android Keystore
 * and/or browser preview storage.
 */
export function deleteGeminiApiKey(
  win: Window | undefined = typeof window !== 'undefined' ? window : undefined
): GeminiApiKeyStatus {
  const bridge =
    win && (win as any).ZoniAndroidBridge
      ? ((win as any).ZoniAndroidBridge as ReturnType<typeof getNativeAndroidBridge>)
      : getNativeAndroidBridge();

  if (bridge?.deleteGeminiApiKey) {
    try {
      if (win === (typeof window !== 'undefined' ? window : undefined)) {
        deleteNativeGeminiApiKey();
      } else {
        bridge.deleteGeminiApiKey();
      }
    } catch {
      // continue clearing any fallback storage
    }
  }

  try {
    win?.localStorage?.removeItem(BROWSER_BYOK_STORAGE_KEY);
    win?.localStorage?.removeItem(LEGACY_USER_KEY_STORAGE);
    win?.localStorage?.removeItem(LEGACY_BACKEND_URL_STORAGE);
  } catch {
    // ignore
  }

  dispatchGeminiKeyUpdated(win);
  return getGeminiApiKeyStatus(win);
}

/**
 * Returns a helpful configuration message ONLY when the user has not saved their
 * own Gemini API key yet. Never checks or requires any backend server URL.
 */
export function getGeminiConfigError(
  win: Window | undefined = typeof window !== 'undefined' ? window : undefined,
  lang: 'bn-BD' | 'hi-IN' | 'en-US' = 'en-US'
): string | null {
  const status = getGeminiApiKeyStatus(win);
  if (status.configured) {
    return null;
  }
  if (lang === 'bn-BD') {
    return 'Gemini AI ব্যবহার করতে Setup বা Settings থেকে আপনার নিজের Gemini API Key দিন। কোনো ব্যাকএন্ড সার্ভার URL প্রয়োজন নেই।';
  }
  if (lang === 'hi-IN') {
    return 'Gemini AI इस्तेमाल करने के लिए Setup या Settings में अपनी Gemini API Key दर्ज करें। किसी बैकएंड सर्वर URL की आवश्यकता नहीं है।';
  }
  return 'Enter your own Gemini API Key in Setup or Settings to activate ZONI AI. No backend server URL is required.';
}
