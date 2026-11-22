/**
 * Native Android System Bridge & Runtime Detector for Zoni AI
 *
 * Bridges web/WebView execution cleanly with the native Android Kotlin layer
 * (`window.ZoniAndroidBridge` exposed via @JavascriptInterface in ZoniWebAppInterface.kt),
 * Capacitor native plugins, or installed Android WebAPK / Chrome intents.
 */

import type { ToolExecutionReport } from './assistantActionRegistry';
import type {
  CallControlActionResult,
  IncomingCallStatusSnapshot,
  VoiceLifecycleState,
  WakeWordStatusSnapshot,
} from './voiceLifecycle';

export interface NativeAndroidBridge {
  // Typed 36-tool allowlisted action engine
  executeTypedActionJson?: (requestJson: string) => string;
  confirmPendingActionJson?: (
    pendingActionId: string,
    editedMessage: string,
    useNotificationReply: boolean
  ) => string;
  cancelPendingActionJson?: (pendingActionId: string) => string;
  listInstalledAppsJson?: () => string;
  getRuntimeDiagnosticsJson?: () => string;

  // On-Device ZONI Wake Word & 24-Hour Transparent Background Listening
  getWakeWordStatusJson?: () => string;
  setWakeWordEnabled?: (enabled: boolean) => string;
  setWakePhrase?: (phrase: string) => string;
  startBackgroundWakeWordJson?: () => string;
  stopBackgroundWakeWordJson?: () => string;
  notifyVoiceSessionState?: (state: string) => boolean;
  pauseWakeWordForVoiceSession?: () => boolean;
  resumeWakeWordAfterVoiceSession?: () => boolean;

  // Incoming & Active Phone Call Control (TelecomManager / InCallService)
  getIncomingCallStatusJson?: () => string;
  answerIncomingCallJson?: () => string;
  rejectIncomingCallJson?: () => string;
  endActiveCallJson?: () => string;
  requestCallControlRole?: () => boolean;

  // Hardware, Calls, Contacts, SMS, WhatsApp
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
  isDefaultDigitalAssistant?: () => boolean;
  requestDefaultDigitalAssistant?: () => boolean;
  requestRuntimePermission?: (permissionKey: string) => boolean;
  requestScreenCaptureConsent?: () => boolean;
  isScreenCaptureActive?: () => boolean;
  captureScreenFrameJson?: () => string;
  stopScreenCapture?: () => boolean;
  getVisibleScreenText?: () => string;
  readVisibleScreenDetailedJson?: () => string;
  performAccessibilityAction?: (command: string) => boolean;
  performAccessibilityActionDetailedJson?: (command: string) => string;
  executeVerifiedWorkflowJson?: (stepsJson: string) => string;
  scrollScreen?: (direction: string) => boolean;
  enterAccessibleText?: (targetHint: string, text: string) => boolean;
  getRecentNotificationsJson?: () => string;
  clearRecentNotifications?: () => boolean;
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
  readPhoneState?: boolean;
  answerPhoneCalls?: boolean;
  defaultDialerRole?: boolean;
  wakeWordEnabled?: boolean;
  backgroundWakeWordRunning?: boolean;
  batteryOptimizationIgnored: boolean;
  overlayAllowed: boolean;
  notificationListenerEnabled: boolean;
  accessibilityEnabled: boolean;
  defaultAssistant?: boolean;
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

export interface InstalledAppEntry {
  label: string;
  packageName: string;
}

export interface NativeDetailedActionResponse {
  status: string;
  message: string;
  success?: boolean;
  verified?: boolean;
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
  হোয়াটসঅ্যাপ: 'com.whatsapp',
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
  ইনস্টাগ্রাম: 'com.instagram.android',
  इंस्टाग्राम: 'com.instagram.android',
  telegram: 'org.telegram.messenger',
  টেলিগ্রাম: 'org.telegram.messenger',
  spotify: 'com.spotify.music',
  স্পটিফাই: 'com.spotify.music',
  camera: 'com.android.camera',
  ক্যামেরা: 'com.android.camera',
  कैमरा: 'com.android.camera',
  clock: 'com.google.android.deskclock',
  calculator: 'com.google.android.calculator',
  ক্যালকুলেটর: 'com.google.android.calculator',
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

export function executeTypedActionViaNativeBridge(
  actionType: string,
  args: Record<string, string | boolean | number>,
  actionId?: string
): ToolExecutionReport | null {
  const bridge = getNativeAndroidBridge();
  if (!bridge?.executeTypedActionJson) return null;
  try {
    const payload = JSON.stringify({
      actionId: actionId || `act_${Date.now()}`,
      actionType,
      arguments: args,
    });
    const raw = bridge.executeTypedActionJson(payload);
    const parsed = JSON.parse(raw) as ToolExecutionReport;
    return {
      ...parsed,
      target:
        parsed.target ||
        String(parsed.data?.target || parsed.data?.contactName || parsed.data?.title || ''),
      executionStatus: parsed.executionStatus || parsed.status || 'unknown',
      status: parsed.status || parsed.executionStatus || 'unknown',
    };
  } catch {
    return null;
  }
}

export function confirmPendingActionViaNativeBridge(
  pendingActionId: string,
  editedMessage: string = '',
  useNotificationReply: boolean = false
): ToolExecutionReport | null {
  const bridge = getNativeAndroidBridge();
  if (!bridge?.confirmPendingActionJson) return null;
  try {
    return JSON.parse(
      bridge.confirmPendingActionJson(pendingActionId, editedMessage, useNotificationReply)
    ) as ToolExecutionReport;
  } catch {
    return null;
  }
}

export function cancelPendingActionViaNativeBridge(pendingActionId: string): ToolExecutionReport | null {
  const bridge = getNativeAndroidBridge();
  if (!bridge?.cancelPendingActionJson) return null;
  try {
    return JSON.parse(bridge.cancelPendingActionJson(pendingActionId)) as ToolExecutionReport;
  } catch {
    return null;
  }
}

export function listInstalledAppsViaNativeBridge(): InstalledAppEntry[] | null {
  const bridge = getNativeAndroidBridge();
  if (!bridge?.listInstalledAppsJson) return null;
  try {
    const parsed = JSON.parse(bridge.listInstalledAppsJson());
    return Array.isArray(parsed?.apps) ? (parsed.apps as InstalledAppEntry[]) : [];
  } catch {
    return null;
  }
}

export interface NativeRuntimeDiagnostics {
  bridgeConnected: boolean;
  accessibilityEnabled: boolean | null;
  contactsPermissionGranted: boolean | null;
  callPhonePermissionGranted?: boolean | null;
  recordAudioPermissionGranted?: boolean | null;
  notificationsPermissionGranted?: boolean | null;
  notificationListenerEnabled?: boolean | null;
  installedAppDiscoveryStatus: string;
  installedAppCount: number | null;
  lastActionRequested: string;
  lastActionResult: string;
  lastFailureReason: string;
}

function readOptionalBoolean(
  obj: Record<string, unknown>,
  ...keys: string[]
): boolean | null {
  for (const key of keys) {
    if (typeof obj[key] === 'boolean') {
      return obj[key] as boolean;
    }
  }
  return null;
}

function readOptionalFiniteNumber(
  obj: Record<string, unknown>,
  ...keys: string[]
): number | null {
  for (const key of keys) {
    const val = obj[key];
    if (typeof val === 'number' && Number.isFinite(val)) {
      return val;
    }
  }
  return null;
}

function readOptionalString(
  obj: Record<string, unknown>,
  ...keys: string[]
): string {
  for (const key of keys) {
    const val = obj[key];
    if (typeof val === 'string' && val.trim().length > 0) {
      return val.trim();
    }
  }
  return '';
}

/**
 * Validates and normalizes JSON returned by Android's `getRuntimeDiagnosticsJson()`.
 * Handles both the canonical schema (`accessibilityEnabled`, `installedAppDiscoveryStatus`, `installedAppCount`)
 * and legacy Android APK payloads (`accessibilityConnected`, `readContactsGranted`, `installedAppsCount`, `packageVisibilityOk`)
 * without fabricating missing values or throwing on omitted optional keys.
 */
export function parseNativeRuntimeDiagnosticsJson(
  rawJson: string | undefined | null
): NativeRuntimeDiagnostics | null {
  if (!rawJson || typeof rawJson !== 'string') return null;
  try {
    const parsed = JSON.parse(rawJson);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const record = parsed as Record<string, unknown>;

    const installedCount = readOptionalFiniteNumber(
      record,
      'installedAppCount',
      'installedAppsCount'
    );
    const packageVisibilityOk = readOptionalBoolean(record, 'packageVisibilityOk');
    const explicitDiscoveryStatus = readOptionalString(
      record,
      'installedAppDiscoveryStatus'
    );

    const installedAppDiscoveryStatus =
      explicitDiscoveryStatus ||
      (installedCount !== null && installedCount < 0
        ? 'error'
        : packageVisibilityOk === true || (installedCount !== null && installedCount > 0)
        ? 'ready'
        : packageVisibilityOk === false || installedCount === 0
        ? 'restricted_or_empty'
        : 'unavailable');

    return {
      bridgeConnected: readOptionalBoolean(record, 'bridgeConnected') ?? true,
      accessibilityEnabled: readOptionalBoolean(
        record,
        'accessibilityEnabled',
        'accessibilityConnected'
      ),
      contactsPermissionGranted: readOptionalBoolean(
        record,
        'contactsPermissionGranted',
        'readContactsGranted'
      ),
      callPhonePermissionGranted: readOptionalBoolean(
        record,
        'callPhonePermissionGranted',
        'callPhoneGranted'
      ),
      recordAudioPermissionGranted: readOptionalBoolean(
        record,
        'recordAudioPermissionGranted',
        'recordAudioGranted'
      ),
      notificationsPermissionGranted: readOptionalBoolean(
        record,
        'notificationsPermissionGranted',
        'postNotificationsGranted'
      ),
      notificationListenerEnabled: readOptionalBoolean(
        record,
        'notificationListenerEnabled'
      ),
      installedAppDiscoveryStatus,
      installedAppCount: installedCount,
      lastActionRequested: readOptionalString(record, 'lastActionRequested') || 'none',
      lastActionResult: readOptionalString(record, 'lastActionResult') || 'idle',
      lastFailureReason: readOptionalString(record, 'lastFailureReason'),
    };
  } catch {
    return null;
  }
}

/**
 * Formats the Settings Diagnostics "APP DISCOVERY" status label safely without ever calling
 * `.toUpperCase()` on undefined or printing `undefined APPS`.
 */
export function formatInstalledAppDiscoveryLabel(
  nativeDiag: Partial<NativeRuntimeDiagnostics> | null | undefined,
  fallbackAppCount: number | null,
  hasBridge: boolean
): string {
  if (nativeDiag) {
    const rawStatus =
      typeof nativeDiag.installedAppDiscoveryStatus === 'string'
        ? nativeDiag.installedAppDiscoveryStatus.trim()
        : '';
    const count =
      typeof nativeDiag.installedAppCount === 'number' &&
      Number.isFinite(nativeDiag.installedAppCount)
        ? nativeDiag.installedAppCount
        : fallbackAppCount;

    const statusLabel = (
      rawStatus ||
      (count !== null && count < 0
        ? 'error'
        : count !== null && count > 0
        ? 'ready'
        : count === 0
        ? 'restricted_or_empty'
        : 'unavailable')
    )
      .replace(/_/g, ' ')
      .toUpperCase();

    return count !== null && count >= 0
      ? `${statusLabel} (${count} APPS)`
      : statusLabel;
  }

  if (hasBridge) {
    return fallbackAppCount !== null && fallbackAppCount > 0
      ? `READY (${fallbackAppCount} APPS)`
      : 'RESTRICTED OR EMPTY';
  }

  return 'WEB PREVIEW (APK REQUIRED)';
}

export function getNativeRuntimeDiagnostics(): NativeRuntimeDiagnostics | null {
  const bridge = getNativeAndroidBridge();
  if (!bridge?.getRuntimeDiagnosticsJson) return null;
  try {
    const raw = bridge.getRuntimeDiagnosticsJson();
    return parseNativeRuntimeDiagnosticsJson(raw);
  } catch {
    return null;
  }
}

export function executeVerifiedWorkflowViaNativeBridge(
  steps: Array<Record<string, string | number>>
): ToolExecutionReport | null {
  const bridge = getNativeAndroidBridge();
  if (!bridge?.executeVerifiedWorkflowJson) return null;
  try {
    return JSON.parse(bridge.executeVerifiedWorkflowJson(JSON.stringify(steps))) as ToolExecutionReport;
  } catch {
    return null;
  }
}

export function isDefaultDigitalAssistantViaNativeBridge(): boolean | null {
  const bridge = getNativeAndroidBridge();
  if (!bridge?.isDefaultDigitalAssistant) return null;
  try {
    return Boolean(bridge.isDefaultDigitalAssistant());
  } catch {
    return null;
  }
}

export function requestDefaultDigitalAssistantViaNativeBridge(): boolean {
  const bridge = getNativeAndroidBridge();
  if (bridge?.requestDefaultDigitalAssistant) {
    try {
      return Boolean(bridge.requestDefaultDigitalAssistant());
    } catch {
      return false;
    }
  }
  if (bridge?.openSystemSettings) {
    try {
      return Boolean(bridge.openSystemSettings('default_assistant'));
    } catch {
      return false;
    }
  }
  return false;
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

export function performNativeAccessibilityDetailed(command: string): ToolExecutionReport | null {
  const bridge = getNativeAndroidBridge();
  if (!bridge?.performAccessibilityActionDetailedJson) return null;
  try {
    return JSON.parse(bridge.performAccessibilityActionDetailedJson(command)) as ToolExecutionReport;
  } catch {
    return null;
  }
}

// --- Wake Word, Background Service & Unified Voice Lifecycle Helpers ---

export interface WakeWordBridgeResponse {
  success: boolean;
  status: string;
  message: string;
  wakePhrase?: string;
  snapshot?: WakeWordStatusSnapshot;
}

export function getNativeWakeWordStatus(): WakeWordStatusSnapshot | null {
  const bridge = getNativeAndroidBridge();
  if (!bridge?.getWakeWordStatusJson) return null;
  try {
    return JSON.parse(bridge.getWakeWordStatusJson()) as WakeWordStatusSnapshot;
  } catch {
    return null;
  }
}

export function startNativeBackgroundWakeWord(): WakeWordBridgeResponse {
  const bridge = getNativeAndroidBridge();
  if (!bridge?.startBackgroundWakeWordJson) {
    return {
      success: false,
      status: 'native_bridge_unavailable',
      message: '24-hour background microphone wake-word service is available inside the installed Android APK.',
    };
  }
  try {
    return JSON.parse(bridge.startBackgroundWakeWordJson()) as WakeWordBridgeResponse;
  } catch {
    return {
      success: false,
      status: 'parse_error',
      message: 'Failed to parse native wake-word start response.',
    };
  }
}

export function stopNativeBackgroundWakeWord(): WakeWordBridgeResponse {
  const bridge = getNativeAndroidBridge();
  if (!bridge?.stopBackgroundWakeWordJson) {
    return {
      success: false,
      status: 'native_bridge_unavailable',
      message: 'Background wake-word service is not running in browser preview.',
    };
  }
  try {
    return JSON.parse(bridge.stopBackgroundWakeWordJson()) as WakeWordBridgeResponse;
  } catch {
    return {
      success: false,
      status: 'parse_error',
      message: 'Failed to parse native wake-word stop response.',
    };
  }
}

export function setNativeWakePhrase(phrase: string): WakeWordBridgeResponse {
  const clean = phrase.trim().slice(0, 32) || 'Zoni';
  const bridge = getNativeAndroidBridge();
  if (!bridge?.setWakePhrase) {
    return {
      success: true,
      status: 'saved_locally',
      wakePhrase: clean,
      message: `Wake phrase saved as "${clean}" (active inside Android APK).`,
    };
  }
  try {
    return JSON.parse(bridge.setWakePhrase(clean)) as WakeWordBridgeResponse;
  } catch {
    return {
      success: false,
      status: 'parse_error',
      message: 'Failed to update wake phrase on Android bridge.',
    };
  }
}

export function notifyNativeVoiceSessionState(state: VoiceLifecycleState): boolean {
  const bridge = getNativeAndroidBridge();
  if (!bridge?.notifyVoiceSessionState) return false;
  try {
    return Boolean(bridge.notifyVoiceSessionState(state));
  } catch {
    return false;
  }
}

export function pauseNativeWakeWordForVoice(): boolean {
  const bridge = getNativeAndroidBridge();
  if (!bridge?.pauseWakeWordForVoiceSession) return false;
  try {
    return Boolean(bridge.pauseWakeWordForVoiceSession());
  } catch {
    return false;
  }
}

export function resumeNativeWakeWordAfterVoice(): boolean {
  const bridge = getNativeAndroidBridge();
  if (!bridge?.resumeWakeWordAfterVoiceSession) return false;
  try {
    return Boolean(bridge.resumeWakeWordAfterVoiceSession());
  } catch {
    return false;
  }
}

// --- Incoming & Active Phone Call Control Helpers ---

export function getNativeIncomingCallStatus(): IncomingCallStatusSnapshot | null {
  const bridge = getNativeAndroidBridge();
  if (!bridge?.getIncomingCallStatusJson) return null;
  try {
    return JSON.parse(bridge.getIncomingCallStatusJson()) as IncomingCallStatusSnapshot;
  } catch {
    return null;
  }
}

export function answerNativeIncomingCall(): CallControlActionResult {
  const bridge = getNativeAndroidBridge();
  if (!bridge?.answerIncomingCallJson) {
    return {
      success: false,
      verified: false,
      action: 'answer',
      resultingCallState: 'IDLE',
      status: 'native_bridge_unavailable',
      message: 'Incoming call control requires the installed Android APK with Telecom permissions.',
    };
  }
  try {
    return JSON.parse(bridge.answerIncomingCallJson()) as CallControlActionResult;
  } catch {
    return {
      success: false,
      verified: false,
      action: 'answer',
      resultingCallState: 'IDLE',
      status: 'parse_error',
      message: 'Could not parse Android answer-call result.',
    };
  }
}

export function rejectNativeIncomingCall(): CallControlActionResult {
  const bridge = getNativeAndroidBridge();
  if (!bridge?.rejectIncomingCallJson) {
    return {
      success: false,
      verified: false,
      action: 'reject',
      resultingCallState: 'IDLE',
      status: 'native_bridge_unavailable',
      message: 'Incoming call rejection requires the installed Android APK with Telecom permissions.',
    };
  }
  try {
    return JSON.parse(bridge.rejectIncomingCallJson()) as CallControlActionResult;
  } catch {
    return {
      success: false,
      verified: false,
      action: 'reject',
      resultingCallState: 'IDLE',
      status: 'parse_error',
      message: 'Could not parse Android reject-call result.',
    };
  }
}

export function endNativeActiveCall(): CallControlActionResult {
  const bridge = getNativeAndroidBridge();
  if (!bridge?.endActiveCallJson) {
    return {
      success: false,
      verified: false,
      action: 'end',
      resultingCallState: 'IDLE',
      status: 'native_bridge_unavailable',
      message: 'Ending an active phone call requires the installed Android APK with Telecom permissions.',
    };
  }
  try {
    return JSON.parse(bridge.endActiveCallJson()) as CallControlActionResult;
  } catch {
    return {
      success: false,
      verified: false,
      action: 'end',
      resultingCallState: 'IDLE',
      status: 'parse_error',
      message: 'Could not parse Android end-call result.',
    };
  }
}

export function requestNativeCallControlRole(): boolean {
  const bridge = getNativeAndroidBridge();
  if (!bridge?.requestCallControlRole) return false;
  try {
    return Boolean(bridge.requestCallControlRole());
  } catch {
    return false;
  }
}
