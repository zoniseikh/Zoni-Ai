/**
 * Native Android System Bridge & Runtime Detector for Zoni AI
 *
 * Bridges web/WebView execution cleanly with the native Android Kotlin layer
 * (`window.ZoniAndroidBridge` exposed via @JavascriptInterface in ZoniWebAppInterface.kt),
 * Capacitor native plugins, or installed Android WebAPK / Chrome intents.
 */

export interface NativeAndroidBridge {
  setFlashlight?: (enable: boolean) => boolean;
  placeCall?: (phoneNumber: string) => boolean;
  sendSms?: (phoneNumber: string, message: string) => boolean;
  openWhatsApp?: (phoneNumber: string, message: string) => boolean;
  vibrate?: (durationMs: number) => boolean;
  getBatteryStatusJson?: () => string;
  launchApp?: (appQuery: string) => boolean;
  openSystemSettings?: (target: string) => boolean;
  setFloatingOrbEnabled?: (enable: boolean) => boolean;
  isFloatingOrbEnabled?: () => boolean;
  showNotification?: (title: string, body: string) => boolean;
  getPermissionsStatusJson?: () => string;
  requestNativePermissions?: () => boolean;
  getDeviceInfoJson?: () => string;
}

export type AndroidRuntimeMode =
  | 'native-android-apk'
  | 'capacitor-android'
  | 'android-pwa'
  | 'android-browser'
  | 'web-desktop';

export interface AndroidDeviceInfo {
  manufacturer: string;
  model: string;
  sdkInt: number;
  release: string;
  appVersion: string;
}

export interface NativePermissionSnapshot {
  recordAudio: boolean;
  camera: boolean;
  callPhone: boolean;
  readContacts: boolean;
  sendSms: boolean;
  location: boolean;
  notifications: boolean;
  batteryOptimizationIgnored: boolean;
  overlayAllowed: boolean;
  notificationListenerEnabled: boolean;
  accessibilityEnabled: boolean;
}

declare global {
  interface Window {
    ZoniAndroidBridge?: NativeAndroidBridge;
    Capacitor?: {
      isNativePlatform?: () => boolean;
      getPlatform?: () => string;
    };
  }
}

export function getNativeAndroidBridge(): NativeAndroidBridge | null {
  if (typeof window === 'undefined') return null;
  const bridge = window.ZoniAndroidBridge;
  if (bridge && typeof bridge === 'object') {
    return bridge;
  }
  return null;
}

export function detectAndroidRuntimeMode(
  win: typeof window | undefined = typeof window !== 'undefined' ? window : undefined,
  nav: Navigator | undefined = typeof navigator !== 'undefined' ? navigator : undefined
): AndroidRuntimeMode {
  if (!win) return 'web-desktop';

  if (win.ZoniAndroidBridge && typeof win.ZoniAndroidBridge === 'object') {
    return 'native-android-apk';
  }

  if (
    Boolean(win.Capacitor?.isNativePlatform?.()) ||
    win.location?.protocol === 'capacitor:' ||
    win.location?.protocol === 'ionic:'
  ) {
    return 'capacitor-android';
  }

  const ua = (nav?.userAgent || '').toLowerCase();
  const isAndroidUa = ua.includes('android');
  const isStandalone =
    typeof win.matchMedia === 'function' &&
    win.matchMedia('(display-mode: standalone)').matches;

  if (isAndroidUa && isStandalone) {
    return 'android-pwa';
  }
  if (isAndroidUa) {
    return 'android-browser';
  }
  return 'web-desktop';
}

export function isRunningOnNativeAndroid(): boolean {
  const mode = detectAndroidRuntimeMode();
  return mode === 'native-android-apk' || mode === 'capacitor-android';
}

/**
 * Known Android package names for deep intent launching from Chrome / WebAPK
 */
export const ANDROID_APP_PACKAGES: Record<string, string> = {
  youtube: 'com.google.android.youtube',
  ইউটিউব: 'com.google.android.youtube',
  whatsapp: 'com.whatsapp',
  হোয়াটসঅ্যাপ: 'com.whatsapp',
  chrome: 'com.android.chrome',
  ক্রোম: 'com.android.chrome',
  maps: 'com.google.android.apps.maps',
  ম্যাপ: 'com.google.android.apps.maps',
  gmail: 'com.google.android.gm',
  জিমেইল: 'com.google.android.gm',
  facebook: 'com.facebook.katana',
  ফেসবুক: 'com.facebook.katana',
  instagram: 'com.instagram.android',
  telegram: 'org.telegram.messenger',
  spotify: 'com.spotify.music',
  camera: 'com.android.camera',
  ক্যামেরা: 'com.android.camera',
  clock: 'com.google.android.deskclock',
  calculator: 'com.google.android.calculator',
  settings: 'com.android.settings',
  সেটিংস: 'com.android.settings',
};

export function resolveAndroidPackageForQuery(appQuery: string): string | null {
  const clean = appQuery.trim().toLowerCase();
  if (!clean) return null;
  for (const [key, pkg] of Object.entries(ANDROID_APP_PACKAGES)) {
    if (clean.includes(key)) {
      return pkg;
    }
  }
  return null;
}

export function buildAndroidIntentUrl(packageName: string, fallbackUrl?: string): string {
  const fallbackParam = fallbackUrl
    ? `;S.browser_fallback_url=${encodeURIComponent(fallbackUrl)}`
    : '';
  return `intent://#Intent;package=${packageName}${fallbackParam};end`;
}

export function parseNativeBatteryJson(
  rawJson: string | undefined | null
): { level: number; charging: boolean } | null {
  if (!rawJson) return null;
  try {
    const parsed = JSON.parse(rawJson);
    if (typeof parsed?.level === 'number') {
      return {
        level: Math.max(0, Math.min(100, Math.round(parsed.level))),
        charging: Boolean(parsed.charging),
      };
    }
  } catch {
    // ignore malformed bridge JSON
  }
  return null;
}

export function getNativePermissionsSnapshot(): NativePermissionSnapshot | null {
  const bridge = getNativeAndroidBridge();
  if (!bridge?.getPermissionsStatusJson) return null;
  try {
    const raw = bridge.getPermissionsStatusJson();
    if (!raw) return null;
    return JSON.parse(raw) as NativePermissionSnapshot;
  } catch {
    return null;
  }
}

export function getNativeDeviceInfo(): AndroidDeviceInfo | null {
  const bridge = getNativeAndroidBridge();
  if (!bridge?.getDeviceInfoJson) return null;
  try {
    const raw = bridge.getDeviceInfoJson();
    if (!raw) return null;
    return JSON.parse(raw) as AndroidDeviceInfo;
  } catch {
    return null;
  }
}

export function toggleNativeFloatingOrb(enable: boolean): boolean {
  const bridge = getNativeAndroidBridge();
  if (bridge?.setFloatingOrbEnabled) {
    try {
      return Boolean(bridge.setFloatingOrbEnabled(enable));
    } catch {
      return false;
    }
  }
  return false;
}
