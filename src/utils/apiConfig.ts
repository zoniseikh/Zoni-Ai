/**
 * Configuration helper for API endpoints and Gemini Live WebSocket connection.
 *
 * Security & Reliability Rules:
 * - Gemini API keys remain strictly on the backend server (never in browser/APK bundles).
 * - In normal web browsers, API and WebSocket requests target the same origin unless overridden.
 * - Inside Android WebViewAssetLoader (`https://appassets.androidplatform.net`) or Capacitor shells,
 *   a valid remote `http(s)://` backend URL MUST be configured; we NEVER silently fall back to
 *   `appassets.androidplatform.net` as a Gemini API or WebSocket backend.
 */

export const ANDROID_LOCAL_ASSET_HOST = 'appassets.androidplatform.net';
export const PRODUCTION_BACKEND_URL = 'https://zoni-ai-675435111499.asia-southeast1.run.app';

export function isLocalAndroidAssetHost(urlOrHost: string): boolean {
  const trimmed = urlOrHost.trim().toLowerCase();
  if (!trimmed) return false;
  try {
    const parsed = trimmed.includes('://') ? new URL(trimmed) : new URL(`https://${trimmed}`);
    return parsed.hostname === ANDROID_LOCAL_ASSET_HOST;
  } catch {
    return trimmed.includes(ANDROID_LOCAL_ASSET_HOST);
  }
}

export function isStaleOrLocalDeviceHost(urlOrHost: string): boolean {
  const trimmed = urlOrHost.trim().toLowerCase();
  if (!trimmed) return true;
  if (trimmed.includes('ais-pre-')) return true;
  try {
    const parsed = trimmed.includes('://') ? new URL(trimmed) : new URL(`https://${trimmed}`);
    const host = parsed.hostname.toLowerCase();
    return (
      host === ANDROID_LOCAL_ASSET_HOST ||
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '0.0.0.0' ||
      host === '[::1]'
    );
  } catch {
    return true;
  }
}

export function isValidBackendUrl(
  url: string | null | undefined,
  options?: { allowLocalhost?: boolean }
): boolean {
  if (!url) return false;
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) return false;
  try {
    const parsed = new URL(trimmed);
    const host = parsed.hostname.toLowerCase();
    if (!host || host === ANDROID_LOCAL_ASSET_HOST) {
      return false;
    }
    if (host.includes('ais-pre-')) {
      return false;
    }
    if (
      !options?.allowLocalhost &&
      (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '[::1]')
    ) {
      return false;
    }
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function normalizeBackendUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

export function isNativeAndroidWebShell(
  win: Window | undefined = typeof window !== 'undefined' ? window : undefined
): boolean {
  if (!win) return false;
  return (
    Boolean(win.ZoniAndroidBridge) ||
    Boolean((win as any).__ZONI_ANDROID_NATIVE__) ||
    win.location?.hostname === ANDROID_LOCAL_ASSET_HOST ||
    Boolean(win.Capacitor?.isNativePlatform?.()) ||
    win.location?.protocol === 'capacitor:' ||
    win.location?.protocol === 'ionic:' ||
    (win.location?.hostname === 'localhost' && (!win.location?.port || win.location?.port === '80'))
  );
}

export function resolveNativeBackendUrl(win: Window): string {
  try {
    const bridgeUrl = win.ZoniAndroidBridge?.getBackendUrl?.()?.trim();
    if (isValidBackendUrl(bridgeUrl)) {
      return normalizeBackendUrl(bridgeUrl!);
    }
  } catch {
    // ignore bridge access issues
  }
  try {
    const storedUrl = win.localStorage?.getItem('zoni_backend_url')?.trim();
    if (isValidBackendUrl(storedUrl)) {
      return normalizeBackendUrl(storedUrl!);
    }
    if (storedUrl && isStaleOrLocalDeviceHost(storedUrl)) {
      win.localStorage?.removeItem('zoni_backend_url');
    }
  } catch {
    // ignore storage access issues
  }
  const envUrl = (import.meta as any).env?.VITE_BACKEND_URL?.trim();
  if (isValidBackendUrl(envUrl)) {
    return normalizeBackendUrl(envUrl);
  }
  return PRODUCTION_BACKEND_URL;
}

export function saveCustomBackendUrl(
  rawUrl: string,
  win: Window | undefined = typeof window !== 'undefined' ? window : undefined
): { ok: boolean; normalizedUrl?: string; error?: string } {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return { ok: false, error: 'Please enter a valid backend server URL starting with https:// or http://.' };
  }
  if (isLocalAndroidAssetHost(trimmed)) {
    return {
      ok: false,
      error: `Cannot use ${ANDROID_LOCAL_ASSET_HOST} as a Gemini backend. Enter your deployed Zoni backend server URL.`,
    };
  }
  const allowLocalhost = win ? !isNativeAndroidWebShell(win) : true;
  if (!isValidBackendUrl(trimmed, { allowLocalhost })) {
    return {
      ok: false,
      error: isStaleOrLocalDeviceHost(trimmed)
        ? `Invalid or unreachable device/legacy host. Use your production Cloud Run URL (${PRODUCTION_BACKEND_URL}).`
        : `Invalid backend URL. Use a full URL like ${PRODUCTION_BACKEND_URL}.`,
    };
  }
  const normalized = normalizeBackendUrl(trimmed);
  if (win) {
    try {
      win.localStorage?.setItem('zoni_backend_url', normalized);
    } catch {
      // ignore storage errors
    }
    try {
      win.ZoniAndroidBridge?.setBackendUrl?.(normalized);
    } catch {
      // ignore native bridge errors
    }
  }
  return { ok: true, normalizedUrl: normalized };
}

export function clearCustomBackendUrl(
  win: Window | undefined = typeof window !== 'undefined' ? window : undefined
): void {
  if (!win) return;
  try {
    win.localStorage?.removeItem('zoni_backend_url');
  } catch {
    // ignore
  }
}

/**
 * Returns an explicit configuration error message when running in an Android WebView/Capacitor
 * shell without a valid backend server URL, or null when the backend target is properly configured.
 */
export function getBackendConfigError(
  win: Window | undefined = typeof window !== 'undefined' ? window : undefined
): string | null {
  if (!win) return null;
  if (isNativeAndroidWebShell(win)) {
    const resolved = resolveNativeBackendUrl(win);
    if (!isValidBackendUrl(resolved)) {
      return `Android backend server URL is not configured. Open Zoni Setup → Step 1 (Backend Link) and set ${PRODUCTION_BACKEND_URL}.`;
    }
  }
  return null;
}

/**
 * Returns the displayable active backend base URL (origin in web browser, configured remote URL in Android APK).
 */
export function getDisplayBackendUrl(
  win: Window | undefined = typeof window !== 'undefined' ? window : undefined
): string {
  if (!win) return PRODUCTION_BACKEND_URL;
  if (isNativeAndroidWebShell(win)) {
    return resolveNativeBackendUrl(win);
  }
  try {
    const stored = win.localStorage?.getItem('zoni_backend_url')?.trim();
    if (isValidBackendUrl(stored, { allowLocalhost: true })) {
      return normalizeBackendUrl(stored!);
    }
  } catch {
    // ignore
  }
  return win.location?.origin || '';
}

export function getApiBaseUrl(
  win: Window | undefined = typeof window !== 'undefined' ? window : undefined
): string {
  if (!win) return '';
  if (isNativeAndroidWebShell(win)) {
    // Never silently fall back to appassets.androidplatform.net or localhost
    return resolveNativeBackendUrl(win);
  }
  try {
    const stored = win.localStorage?.getItem('zoni_backend_url')?.trim();
    if (isValidBackendUrl(stored, { allowLocalhost: true })) {
      return normalizeBackendUrl(stored!);
    }
  } catch {
    // ignore
  }
  return '';
}

export function getLiveWsUrl(
  mode: string,
  nickname: string,
  voice: string,
  lang: string = 'bn-BD',
  resumptionHandle?: string,
  win: Window | undefined = typeof window !== 'undefined' ? window : undefined
): string {
  const safeName = encodeURIComponent(nickname || 'Boss');
  let query = `mode=${encodeURIComponent(mode)}&nickname=${safeName}&selectedAffectionName=${safeName}&voice=${encodeURIComponent(voice)}&lang=${encodeURIComponent(lang)}`;
  if (resumptionHandle && resumptionHandle.trim()) {
    query += `&handle=${encodeURIComponent(resumptionHandle.trim())}`;
  }
  if (win) {
    if (isNativeAndroidWebShell(win)) {
      const backend = resolveNativeBackendUrl(win);
      if (!backend) {
        // Explicit empty string signals missing backend URL instead of targeting appassets.androidplatform.net
        return '';
      }
      const wsBase = backend.startsWith('http://')
        ? `ws://${backend.replace(/^http:\/\//i, '')}`
        : `wss://${backend.replace(/^https?:\/\//i, '')}`;
      return `${wsBase.replace(/\/+$/, '')}/live?${query}`;
    }

    try {
      const stored = win.localStorage?.getItem('zoni_backend_url')?.trim();
      if (isValidBackendUrl(stored)) {
        const normalized = normalizeBackendUrl(stored!);
        const wsBase = normalized.startsWith('http://')
          ? `ws://${normalized.replace(/^http:\/\//i, '')}`
          : `wss://${normalized.replace(/^https?:\/\//i, '')}`;
        return `${wsBase}/live?${query}`;
      }
    } catch {
      // ignore
    }

    const protocol = win.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${win.location.host}/live?${query}`;
  }
  return `ws://localhost:3000/live?${query}`;
}
