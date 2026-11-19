/**
 * Chrome Permissions & Feature Initialization Manager for ZONI AI
 * Manages checking, requesting, listening to changes, and initializing:
 * 1. Microphone (Gemini Live Duplex & Voice Dictation)
 * 2. Geolocation (Local Timezone Asia/Kolkata verification, Local Context & Sunrise/Sunset)
 * 3. Notifications (Zoni AI reminders & Love check-ins)
 */

export type PermissionState = 'granted' | 'denied' | 'prompt' | 'unsupported';

export interface FeaturePermissionInfo {
  id: 'microphone' | 'geolocation' | 'notifications';
  name: string;
  nameBengali: string;
  description: string;
  descriptionBengali: string;
  status: PermissionState;
  isRequired: boolean;
  chromeSettingPath: string;
}

export interface ChromePermissionsReport {
  microphone: PermissionState;
  geolocation: PermissionState;
  notifications: PermissionState;
  isSecureContext: boolean;
  hasChecked: boolean;
  userLocation?: {
    latitude: number;
    longitude: number;
    resolvedName?: string;
  };
}

/**
 * Check if the current window environment is a secure context (HTTPS or localhost)
 */
export function checkIsSecureContext(): boolean {
  if (typeof window === 'undefined') return true;
  return Boolean(window.isSecureContext);
}

/**
 * Query a specific browser permission state with defensive fallbacks
 */
export async function queryPermission(
  name: 'microphone' | 'geolocation' | 'notifications'
): Promise<PermissionState> {
  if (typeof window === 'undefined') return 'unsupported';

  // Notifications specific fallback check
  if (name === 'notifications' && 'Notification' in window) {
    const notifPerm = Notification.permission;
    if (notifPerm === 'granted') return 'granted';
    if (notifPerm === 'denied') return 'denied';
    if (notifPerm === 'default') return 'prompt';
  }

  // Check Permissions API
  if (navigator.permissions && typeof navigator.permissions.query === 'function') {
    try {
      const permissionName = name as PermissionName;
      const status = await navigator.permissions.query({ name: permissionName });
      return (status.state as PermissionState) || 'prompt';
    } catch {
      // Some browsers throw for 'microphone' in permissions.query
      if (name === 'microphone') {
        if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
          return 'unsupported';
        }
        return 'prompt';
      }
    }
  }

  // Feature detection fallbacks
  if (name === 'microphone') {
    return navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function'
      ? 'prompt'
      : 'unsupported';
  }
  if (name === 'geolocation') {
    return navigator.geolocation ? 'prompt' : 'unsupported';
  }
  if (name === 'notifications') {
    return 'Notification' in window ? 'prompt' : 'unsupported';
  }

  return 'unsupported';
}

/**
 * Check status of all required browser features
 */
export async function checkAllPermissions(): Promise<ChromePermissionsReport> {
  const isSecure = checkIsSecureContext();

  const [micState, geoState, notifState] = await Promise.all([
    queryPermission('microphone'),
    queryPermission('geolocation'),
    queryPermission('notifications'),
  ]);

  return {
    microphone: micState,
    geolocation: geoState,
    notifications: notifState,
    isSecureContext: isSecure,
    hasChecked: true,
  };
}

/**
 * Listen to live permission changes if supported by Chrome
 */
export function listenToPermissionChanges(
  onUpdate: (report: Partial<ChromePermissionsReport>) => void
): () => void {
  if (typeof window === 'undefined' || !navigator.permissions || !navigator.permissions.query) {
    return () => {};
  }

  const cleanupFns: Array<() => void> = [];

  const attachListener = async (permName: 'microphone' | 'geolocation' | 'notifications') => {
    try {
      const status = await navigator.permissions.query({ name: permName as PermissionName });
      const handler = () => {
        onUpdate({
          [permName]: status.state as PermissionState,
        });
      };
      status.addEventListener('change', handler);
      cleanupFns.push(() => {
        status.removeEventListener('change', handler);
      });
    } catch {
      // Ignore unsupported query names
    }
  };

  attachListener('microphone');
  attachListener('geolocation');
  attachListener('notifications');

  return () => {
    cleanupFns.forEach((fn) => fn());
  };
}

/**
 * Request Microphone permission with explicit user consent
 */
export async function requestMicrophoneAccess(): Promise<{
  status: PermissionState;
  stream?: MediaStream;
  error?: string;
}> {
  if (!checkIsSecureContext()) {
    return {
      status: 'unsupported',
      error: 'Microphone requires a secure HTTPS origin or localhost.',
    };
  }

  if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
    return {
      status: 'unsupported',
      error: 'MediaDevices API is not supported in this browser.',
    };
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        channelCount: 1,
      },
    });
    return {
      status: 'granted',
      stream,
    };
  } catch (err: any) {
    const isDenied =
      err.name === 'NotAllowedError' ||
      err.name === 'PermissionDeniedError' ||
      String(err).includes('Permission denied');
    return {
      status: isDenied ? 'denied' : 'unsupported',
      error: err.message || 'Microphone access could not be acquired.',
    };
  }
}

/**
 * Request Geolocation permission with explicit user consent
 */
export async function requestGeolocationAccess(): Promise<{
  status: PermissionState;
  coords?: { latitude: number; longitude: number };
  error?: string;
}> {
  if (!checkIsSecureContext()) {
    return {
      status: 'unsupported',
      error: 'Geolocation requires a secure HTTPS origin or localhost.',
    };
  }

  if (!navigator.geolocation) {
    return {
      status: 'unsupported',
      error: 'Geolocation is not supported in this browser.',
    };
  }

  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        resolve({
          status: 'granted',
          coords: {
            latitude: pos.coords.latitude,
            longitude: pos.coords.longitude,
          },
        });
      },
      (err) => {
        const isDenied = err.code === err.PERMISSION_DENIED;
        resolve({
          status: isDenied ? 'denied' : 'prompt',
          error: err.message || 'Location access was not granted.',
        });
      },
      { timeout: 10000, enableHighAccuracy: false }
    );
  });
}

/**
 * Request Notification permission with explicit user consent
 */
export async function requestNotificationAccess(): Promise<{
  status: PermissionState;
  error?: string;
}> {
  if (!('Notification' in window)) {
    return {
      status: 'unsupported',
      error: 'Notifications API is not supported in this browser.',
    };
  }

  try {
    const res = await Notification.requestPermission();
    if (res === 'granted') {
      return { status: 'granted' };
    } else if (res === 'denied') {
      return { status: 'denied' };
    }
    return { status: 'prompt' };
  } catch (err: any) {
    return {
      status: 'prompt',
      error: err.message,
    };
  }
}

/**
 * Chrome Site Settings Step-by-Step Instructions for Denied Permissions
 */
export const CHROME_PERMISSION_INSTRUCTIONS = [
  {
    step: 1,
    title: 'Look at Chrome Address Bar',
    titleBengali: 'ক্রোম অ্যাড্রেস বারের বাম পাশে দেখুন',
    desc: 'Tap or click the Site Settings / Tune icon or Padlock (🔒) on the left side of the URL bar.',
    descBengali: 'ইউআরএল (URL) বারের বাম পাশে থাকা প্যাডলক (🔒) বা সাইট সেটিংস আইকনে ক্লিক করুন।',
  },
  {
    step: 2,
    title: 'Open Permissions / Site Settings',
    titleBengali: 'পারমিশন বা সাইট সেটিংস খুলুন',
    desc: 'Click on "Site settings" or view the "Permissions" section in the menu.',
    descBengali: '"Site settings" এ ক্লিক করুন বা পারমিশন তালিকা দেখুন।',
  },
  {
    step: 3,
    title: 'Change Block to Allow',
    titleBengali: 'ব্লক থেকে পরিবর্তন করে অ্যালাউ (Allow) করুন',
    desc: 'Locate Microphone, Location, or Notifications and change the dropdown from "Block" to "Allow".',
    descBengali: 'মাইক্রোফোন, লোকেশন বা নোটিফিকেশন খুঁজে নিয়ে "Block" এর জায়গায় "Allow" নির্বাচন করুন।',
  },
  {
    step: 4,
    title: 'Refresh Status',
    titleBengali: 'স্ট্যাটাস রিফ্রেশ করুন',
    desc: 'Click "Check Permissions Again" or reload the page to initialize ZONI AI.',
    descBengali: 'এখানে "পুনরায় পরীক্ষা করুন (Check Again)" বাটনে ক্লিক করুন অথবা পেজটি রিফ্রেশ করুন।',
  },
];
