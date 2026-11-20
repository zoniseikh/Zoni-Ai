/**
 * Configuration helper for API endpoints and Gemini Live WebSocket connection.
 * Seamlessly handles web browsers, native Android WebViewAssetLoader APKs, and Capacitor environments.
 */

function resolveNativeBackendUrl(win: Window): string {
  try {
    const bridgeUrl = win.ZoniAndroidBridge?.getBackendUrl?.()?.trim();
    if (bridgeUrl && /^https?:\/\//i.test(bridgeUrl)) {
      return bridgeUrl.replace(/\/+$/, '');
    }
  } catch {
    // ignore bridge access issues
  }
  try {
    const storedUrl = win.localStorage?.getItem('zoni_backend_url')?.trim();
    if (storedUrl && /^https?:\/\//i.test(storedUrl)) {
      return storedUrl.replace(/\/+$/, '');
    }
  } catch {
    // ignore storage access issues
  }
  const envUrl = (import.meta as any).env?.VITE_BACKEND_URL?.trim();
  if (envUrl && /^https?:\/\//i.test(envUrl)) {
    return envUrl.replace(/\/+$/, '');
  }
  return '';
}

function isNativeAndroidWebShell(win: Window): boolean {
  return (
    Boolean(win.ZoniAndroidBridge) ||
    Boolean((win as any).__ZONI_ANDROID_NATIVE__) ||
    win.location?.hostname === 'appassets.androidplatform.net' ||
    Boolean(win.Capacitor?.isNativePlatform?.()) ||
    win.location?.protocol === 'capacitor:' ||
    win.location?.protocol === 'ionic:' ||
    (win.location?.hostname === 'localhost' && (!win.location?.port || win.location?.port === '80'))
  );
}

export function getApiBaseUrl(win: Window | undefined = typeof window !== 'undefined' ? window : undefined): string {
  if (win && isNativeAndroidWebShell(win)) {
    const resolved = resolveNativeBackendUrl(win);
    if (resolved) return resolved;
    if (win.location?.hostname !== 'appassets.androidplatform.net') {
      return win.location.origin;
    }
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
      const backend = resolveNativeBackendUrl(win) || win.location.origin;
      const wsBase = backend.startsWith('http://')
        ? `ws://${backend.replace(/^http:\/\//i, '')}`
        : `wss://${backend.replace(/^https?:\/\//i, '')}`;
      return `${wsBase.replace(/\/+$/, '')}/live?${query}`;
    }
    const protocol = win.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${win.location.host}/live?${query}`;
  }
  return `ws://localhost:3000/live?${query}`;
}
