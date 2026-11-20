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
  callContactDetailedJson?: (queryOrNumber: string) => string;
  searchContactsJson?: (query: string) => string;
  getLocalCallHistoryJson?: () => string;
  clearLocalCallHistory?: () => boolean;
  sendSms?: (phoneNumber: string, message: string) => boolean;
  openWhatsApp?: (phoneNumber: string, message: string) => boolean;
  prepareWhatsAppContactJson?: (contactOrNumber: string, message: string) => string;
  vibrate?: (durationMs: number) => boolean;
  openCamera?: () => boolean;
  adjustVolumeJson?: (action: string) => string;
  getBatteryStatusJson?: () => string;
  launchApp?: (appQuery: string) => boolean;
  launchAppDetailedJson?: (appQuery: string) => string;
  openSystemSettings?: (target: string) => boolean;
  requestRuntimePermission?: (permissionKey: string) => boolean;
  requestScreenCaptureConsent?: () => boolean;
  isScreenCaptureActive?: () => boolean;
  captureScreenFrameJson?: () => string;
  stopScreenCapture?: () => boolean;
  getVisibleScreenText?: () => string;
  performAccessibilityAction?: (command: string) => boolean;
  scrollScreen?: (direction: string) => boolean;
  enterAccessibleText?: (targetHint: string, text: string) => boolean;
  getRecentNotificationsJson?: () => string;
  replyToNotification?: (notificationKey: string, replyText: string) => boolean;
  getAutoReplyRulesJson?: () => string;
  saveAutoReplyRulesJson?: (rulesJson: string) => boolean;
  setAutoReplyEnabled?: (enabled: boolean) => boolean;
  setFloatingOrbEnabled?: (enable: boolean) => boolean;
  isFloatingOrbEnabled?: () => boolean;
  showNotification?: (title: string, body: string) => boolean;
  getPermissionsStatusJson?: () => string;
  requestNativePermissions?: () => boolean;
  getDeviceInfoJson?: () => string;
  getBackendUrl?: () => string;
  setBackendUrl?: (url: string) => boolean;
  openOnboardingWizard?: () => boolean;
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
  packageName?: string;
}

export interface NativePermissionSnapshot {
  recordAudio: boolean;
  camera: boolean;
  callPhone: boolean;
  readContacts: boolean;
  sendSms: boolean;
  location: boolean;
  notifications: boolean;
  bluetooth?: boolean;
  batteryOptimizationIgnored: boolean;
  overlayAllowed: boolean;
  notificationListenerEnabled: boolean;
  accessibilityEnabled: boolean;
  screenCaptureActive?: boolean;
}

export interface NativeNotificationItem {
  key: string;
  packageName: string;
  appName: string;
  title: string;
  text: string;
  isWhatsApp: boolean;
  canReply: boolean;
  timestampMillis: number;
}

export interface NativeDetailedActionResponse {
  status: string;
  message: string;
  contactName?: string;
  phoneNumber?: string;
  usedDirectCall?: boolean;
  appLabel?: string;
  packageName?: string;
  numbers?: string[];
  candidates?: Array<{ id?: string; name?: string; label?: string; phone?: string; packageName?: string }>;
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
  यूट्यूब: 'com.google.android.youtube',
  whatsapp: 'com.whatsapp',
  হোয়াটসঅ্যাপ: 'com.whatsapp',
  व्हाट्सएप: 'com.whatsapp',
  chrome: 'com.android.chrome',
  ক্রোম: 'com.android.chrome',
  क्रोम: 'com.android.chrome',
  maps: 'com.google.android.apps.maps',
  ম্যাপ: 'com.google.android.apps.maps',
  मैप्स: 'com.google.android.apps.maps',
  gmail: 'com.google.android.gm',
  জিমেইল: 'com.google.android.gm',
  जीमेल: 'com.google.android.gm',
  facebook: 'com.facebook.katana',
  ফেসবুক: 'com.facebook.katana',
  फेसबुक: 'com.facebook.katana',
  instagram: 'com.instagram.android',
  telegram: 'org.telegram.messenger',
  spotify: 'com.spotify.music',
  camera: 'com.android.camera',
  ক্যামেরা: 'com.android.camera',
  कैमरा: 'com.android.camera',
  clock: 'com.google.android.deskclock',
  calculator: 'com.google.android.calculator',
  settings: 'com.android.settings',
  সেটিংস: 'com.android.settings',
  सेटिंग्स: 'com.android.settings',
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

export function callContactViaNativeBridge(queryOrNumber: string): NativeDetailedActionResponse | null {
  const bridge = getNativeAndroidBridge();
  if (!bridge?.callContactDetailedJson) return null;
  try {
    return JSON.parse(bridge.callContactDetailedJson(queryOrNumber)) as NativeDetailedActionResponse;
  } catch {
    return null;
  }
}

export function prepareWhatsAppContactViaNativeBridge(
  contactOrNumber: string,
  message: string
): NativeDetailedActionResponse | null {
  const bridge = getNativeAndroidBridge();
  if (!bridge?.prepareWhatsAppContactJson) return null;
  try {
    return JSON.parse(
      bridge.prepareWhatsAppContactJson(contactOrNumber, message)
    ) as NativeDetailedActionResponse;
  } catch {
    return null;
  }
}

export function launchAppDetailedViaNativeBridge(appQuery: string): NativeDetailedActionResponse | null {
  const bridge = getNativeAndroidBridge();
  if (!bridge?.launchAppDetailedJson) return null;
  try {
    return JSON.parse(bridge.launchAppDetailedJson(appQuery)) as NativeDetailedActionResponse;
  } catch {
    return null;
  }
}

export function getRecentNativeNotifications(): NativeNotificationItem[] {
  const bridge = getNativeAndroidBridge();
  if (!bridge?.getRecentNotificationsJson) return [];
  try {
    const parsed = JSON.parse(bridge.getRecentNotificationsJson());
    return Array.isArray(parsed) ? (parsed as NativeNotificationItem[]) : [];
  } catch {
    return [];
  }
}

export function replyToNativeNotification(notificationKey: string, replyText: string): boolean {
  const bridge = getNativeAndroidBridge();
  if (!bridge?.replyToNotification) return false;
  try {
    return Boolean(bridge.replyToNotification(notificationKey, replyText));
  } catch {
    return false;
  }
}

export function captureNativeScreenSnapshot(): {
  imageBase64: string;
  visibleText: string;
  error?: string;
} {
  const bridge = getNativeAndroidBridge();
  const visibleText = bridge?.getVisibleScreenText ? String(bridge.getVisibleScreenText() || '') : '';
  let imageBase64 = '';
  let error: string | undefined;

  if (bridge?.captureScreenFrameJson) {
    try {
      const parsed = JSON.parse(bridge.captureScreenFrameJson());
      if (parsed?.success && parsed.base64Jpeg) {
        imageBase64 = parsed.base64Jpeg;
      } else if (parsed?.error) {
        error = parsed.error;
      }
    } catch {
      error = 'Could not parse native screen capture result.';
    }
  }

  return { imageBase64, visibleText, error };
}

export function adjustNativeVolume(action: 'up' | 'down' | 'mute' | 'unmute' | 'max' | 'status'): {
  success: boolean;
  volumePercent?: number;
  message: string;
} {
  const bridge = getNativeAndroidBridge();
  if (bridge?.adjustVolumeJson) {
    try {
      return JSON.parse(bridge.adjustVolumeJson(action));
    } catch {
      return { success: false, message: 'Failed to parse native volume response.' };
    }
  }
  return {
    success: false,
    message: 'Hardware volume control is available inside the native Android APK.',
  };
}

export function openNativeCamera(): boolean {
  const bridge = getNativeAndroidBridge();
  if (bridge?.openCamera) {
    try {
      return Boolean(bridge.openCamera());
    } catch {
      return false;
    }
  }
  return false;
}

export function performNativeAccessibilityCommand(command: string): boolean {
  const bridge = getNativeAndroidBridge();
  if (bridge?.performAccessibilityAction) {
    try {
      return Boolean(bridge.performAccessibilityAction(command));
    } catch {
      return false;
    }
  }
  return false;
}
