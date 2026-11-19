/**
 * Configuration helper for API endpoints and Gemini Live WebSocket connection.
 * Seamlessly handles both web browser environment and native Capacitor Android APK environment.
 */

export function getApiBaseUrl(): string {
  if (typeof window !== 'undefined') {
    const isCapacitor =
      Boolean((window as any).Capacitor?.isNativePlatform?.()) ||
      window.location.protocol === 'capacitor:' ||
      window.location.protocol === 'ionic:' ||
      (window.location.hostname === 'localhost' && (!window.location.port || window.location.port === '80'));
    if (isCapacitor) {
      return (
        import.meta.env.VITE_BACKEND_URL ||
        window.location.origin
      );
    }
  }
  return '';
}

export function getLiveWsUrl(
  mode: string,
  nickname: string,
  voice: string,
  lang: string = 'bn-BD',
  resumptionHandle?: string
): string {
  const safeName = encodeURIComponent(nickname || 'Boss');
  let query = `mode=${encodeURIComponent(mode)}&nickname=${safeName}&selectedAffectionName=${safeName}&voice=${encodeURIComponent(voice)}&lang=${encodeURIComponent(lang)}`;
  if (resumptionHandle && resumptionHandle.trim()) {
    query += `&handle=${encodeURIComponent(resumptionHandle.trim())}`;
  }
  if (typeof window !== 'undefined') {
    const isCapacitor =
      Boolean((window as any).Capacitor?.isNativePlatform?.()) ||
      window.location.protocol === 'capacitor:' ||
      window.location.protocol === 'ionic:';
    if (isCapacitor) {
      const backend = (
        import.meta.env.VITE_BACKEND_URL ||
        window.location.origin
      ).replace(/^https?:\/\//, '');
      return `wss://${backend}/live?${query}`;
    }
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}/live?${query}`;
  }
  return `ws://localhost:3000/live?${query}`;
}
