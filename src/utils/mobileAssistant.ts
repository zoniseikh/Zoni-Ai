/**
 * Mobile Assistant Execution and Hardware Intent Engine for Zoni
 * Handles Phone Calls, SMS, WhatsApp, Torch/Flashlight, Vibration, Battery, and Notifications
 */

import { SupportedLanguage } from '../types';
import {
  getNativeAndroidBridge,
  detectAndroidRuntimeMode,
  resolveAndroidPackageForQuery,
  buildAndroidIntentUrl,
  parseNativeBatteryJson,
} from './androidBridge';

export interface AssistantAction {
  type: 'call' | 'sms' | 'whatsapp' | 'flashlight' | 'vibrate' | 'battery' | 'notification' | 'language' | 'app' | 'settings' | 'weather';
  target?: string;
  payload?: string;
  label: string;
}

export interface LanguageSwitchResult {
  lang: SupportedLanguage;
  name: string;
  label: string;
  confirmation: string;
}

let activeTorchStream: MediaStream | null = null;

/**
 * Execute native phone call (Native Android CALL_PHONE/DIAL bridge -> tel: URI fallback)
 */
export function executeCall(phoneNumber: string) {
  const cleanNumber = phoneNumber.replace(/[^0-9+]/g, '');
  if (!cleanNumber) return false;
  const nativeBridge = getNativeAndroidBridge();
  if (nativeBridge?.placeCall) {
    try {
      return Boolean(nativeBridge.placeCall(cleanNumber));
    } catch {
      // fall back to tel: URI
    }
  }
  window.location.href = `tel:${cleanNumber}`;
  return true;
}

/**
 * Execute native SMS composer (Native Android SMS bridge -> sms: URI fallback)
 */
export function executeSms(phoneNumber: string, message: string = '') {
  const cleanNumber = phoneNumber.replace(/[^0-9+]/g, '');
  const nativeBridge = getNativeAndroidBridge();
  if (nativeBridge?.sendSms) {
    try {
      return Boolean(nativeBridge.sendSms(cleanNumber, message));
    } catch {
      // fall back to sms: URI
    }
  }
  const encodedBody = encodeURIComponent(message);
  window.location.href = `sms:${cleanNumber}?body=${encodedBody}`;
  return true;
}

/**
 * Execute WhatsApp message (Native Android WhatsApp intent bridge -> wa.me fallback)
 */
export function executeWhatsApp(phoneNumber: string, message: string = '') {
  let cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
  // If user provides a standard 11-digit Bangladesh number starting with 01
  if (cleanNumber.startsWith('01') && cleanNumber.length === 11) {
    cleanNumber = '88' + cleanNumber;
  }
  // If user provides a 10-digit India number starting with 6-9
  if (cleanNumber.length === 10 && /^[6-9]/.test(cleanNumber)) {
    cleanNumber = '91' + cleanNumber;
  }
  const nativeBridge = getNativeAndroidBridge();
  if (nativeBridge?.openWhatsApp) {
    try {
      return Boolean(nativeBridge.openWhatsApp(cleanNumber, message));
    } catch {
      // fall back to wa.me URL
    }
  }
  const encodedMsg = encodeURIComponent(message);
  const waUrl = cleanNumber
    ? `https://wa.me/${cleanNumber}?text=${encodedMsg}`
    : `https://wa.me/?text=${encodedMsg}`;
  const anchor = document.createElement('a');
  anchor.href = waUrl;
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
  anchor.click();
  return true;
}

/**
 * Toggle Hardware Flashlight / Torch (Native Android Camera2 setTorchMode -> Web MediaTrack torch fallback)
 */
export async function toggleFlashlight(turnOn: boolean): Promise<boolean> {
  const nativeBridge = getNativeAndroidBridge();
  if (nativeBridge?.setFlashlight) {
    try {
      return Boolean(nativeBridge.setFlashlight(turnOn));
    } catch (err) {
      console.warn('Native Android flashlight bridge notice:', err);
    }
  }

  try {
    if (!turnOn) {
      if (activeTorchStream) {
        activeTorchStream.getTracks().forEach((track) => track.stop());
        activeTorchStream = null;
      }
      return true;
    }
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'environment',
        },
      });
      const track = stream.getVideoTracks()[0];
      const capabilities: any = track.getCapabilities ? track.getCapabilities() : {};
      if (capabilities.torch) {
        await (track as any).applyConstraints({
          advanced: [{ torch: true }],
        });
        activeTorchStream = stream;
        return true;
      } else {
        track.stop();
        return false;
      }
    }
  } catch (err) {
    console.warn('Flashlight error or not supported:', err);
  }
  return false;
}

/**
 * Trigger Haptic Vibration (Native Android VibratorManager -> Web Vibration API)
 */
export function triggerVibration(pattern: number[] = [150, 80, 200]): boolean {
  const nativeBridge = getNativeAndroidBridge();
  if (nativeBridge?.vibrate) {
    try {
      const totalMs = pattern.reduce((acc, n) => acc + n, 0) || 200;
      return Boolean(nativeBridge.vibrate(totalMs));
    } catch {
      // fallback
    }
  }
  if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
    try {
      return navigator.vibrate(pattern);
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Send System Notification (Native Android NotificationManager -> Web Notification API)
 */
export async function sendSystemNotification(title: string, body: string): Promise<boolean> {
  const nativeBridge = getNativeAndroidBridge();
  if (nativeBridge?.showNotification) {
    try {
      return Boolean(nativeBridge.showNotification(title, body));
    } catch {
      // fallback
    }
  }

  if (!('Notification' in window)) return false;
  try {
    let permission = Notification.permission;
    if (permission !== 'granted') {
      permission = await Notification.requestPermission();
    }
    if (permission === 'granted') {
      new Notification(title, {
        body,
        icon: '/pwa-192x192.png',
        badge: '/pwa-192x192.png',
      });
      return true;
    }
  } catch (e) {
    console.warn('Notification failed:', e);
  }
  return false;
}

/**
 * Read Battery Status (Native Android BatteryManager -> Web Battery API)
 */
export async function getDeviceBattery(): Promise<{ level: number; charging: boolean } | null> {
  const nativeBridge = getNativeAndroidBridge();
  if (nativeBridge?.getBatteryStatusJson) {
    const parsed = parseNativeBatteryJson(nativeBridge.getBatteryStatusJson());
    if (parsed) return parsed;
  }

  if (typeof navigator !== 'undefined' && 'getBattery' in (navigator as any)) {
    try {
      const battery = await (navigator as any).getBattery();
      return {
        level: Math.round(battery.level * 100),
        charging: battery.charging,
      };
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Directly launches supported apps using Native Android PackageManager, Android Chrome intent://, or web URLs
 */
export function launchAppDirectly(appQuery: string): boolean {
  const nativeBridge = getNativeAndroidBridge();
  if (nativeBridge?.launchApp) {
    try {
      if (nativeBridge.launchApp(appQuery)) {
        return true;
      }
    } catch {
      // fall through
    }
  }

  const clean = appQuery.trim().toLowerCase();
  const APP_URL_MAP: Record<string, string> = {
    youtube: 'https://www.youtube.com',
    ইউটিউব: 'https://www.youtube.com',
    whatsapp: 'https://web.whatsapp.com',
    হোয়াটসঅ্যাপ: 'https://web.whatsapp.com',
    chrome: 'https://www.google.com',
    maps: 'https://maps.google.com',
    gmail: 'https://mail.google.com',
    camera: '',
    facebook: 'https://www.facebook.com',
    ফেসবুক: 'https://www.facebook.com',
    clock: '',
    calculator: '',
    settings: '',
  };

  const matched = Object.keys(APP_URL_MAP).find((k) => clean.includes(k));
  const fallbackUrl = matched ? APP_URL_MAP[matched] : undefined;

  // On Android Chrome / WebAPK, launch native installed app via Android intent:// URI
  const runtime = detectAndroidRuntimeMode();
  const androidPkg = resolveAndroidPackageForQuery(clean);
  if ((runtime === 'android-pwa' || runtime === 'android-browser') && androidPkg) {
    try {
      window.location.href = buildAndroidIntentUrl(androidPkg, fallbackUrl);
      return true;
    } catch {
      // fall back to URL below
    }
  }

  const targetUrl =
    fallbackUrl || `https://www.google.com/search?q=${encodeURIComponent(appQuery)}`;
  try {
    const anchor = document.createElement('a');
    anchor.href = targetUrl;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    anchor.click();
    return true;
  } catch {
    return false;
  }
}

/**
 * Directly opens Android system settings via native bridge or dispatches custom settings event
 */
export function openSettingsDirectly(settingsAction: string = ''): boolean {
  const nativeBridge = getNativeAndroidBridge();
  if (nativeBridge?.openSystemSettings) {
    try {
      if (nativeBridge.openSystemSettings(settingsAction || 'main')) {
        return true;
      }
    } catch {
      // fall through
    }
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent('zoni:open-settings', { detail: { action: settingsAction } })
    );
  }
  return true;
}

/**
 * Directly executes supported assistant actions immediately without displaying
 * any intermediate confirmation dialog, ActionPromptCard, or EXECUTE/CANCEL popup.
 */
export function executeAssistantActionDirectly(action: AssistantAction): boolean {
  switch (action.type) {
    case 'call':
      if (action.target) {
        return executeCall(action.target);
      }
      break;
    case 'whatsapp':
      return executeWhatsApp(action.target || '', action.payload || '');
    case 'sms':
      if (action.target) {
        return executeSms(action.target, action.payload || '');
      }
      break;
    case 'flashlight': {
      const turnOn = action.payload === 'on' || action.target?.toLowerCase() === 'on';
      toggleFlashlight(turnOn);
      return true;
    }
    case 'vibrate':
      return triggerVibration();
    case 'battery':
      getDeviceBattery().then((battery) => {
        if (typeof window !== 'undefined') {
          window.dispatchEvent(
            new CustomEvent('zoni:battery-update', { detail: battery })
          );
        }
      });
      return true;
    case 'app':
      if (action.target) {
        return launchAppDirectly(action.target);
      }
      break;
    case 'settings':
      return openSettingsDirectly(action.target || '');
    default:
      break;
  }
  return false;
}

/**
 * Normalize spoken input by stripping punctuation and collapsing whitespace
 */
export function normalizeSpokenCommand(text: string): string {
  return text
    .trim()
    .replace(/[.,?!;:।\-_]/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/**
 * Filter out queries that use 'light' or Bengali 'লাইট' in non-torch contexts
 */
export function isNonFlashlightLightQuery(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes('traffic light') ||
    lower.includes('sun gives light') ||
    lower.includes('speed of light') ||
    lower.includes('light year') ||
    lower.includes('কবিতা') ||
    lower.includes('গান') ||
    lower.includes('অর্থ কী') ||
    lower.includes('মানে কী') ||
    lower.includes('কী') ||
    lower.includes('কি') ||
    lower.includes('what is') ||
    lower.includes('tell me about')
  );
}

/**
 * Detect explicit Flashlight ON commands
 */
export function isFlashlightOnCommand(raw: string): boolean {
  const normalized = normalizeSpokenCommand(raw);
  if (isNonFlashlightLightQuery(normalized)) {
    return false;
  }

  // Explicit English ON commands
  const englishOnRegex =
    /^(?:(?:please\s+)?(?:turn\s+on|switch\s+on)\s+(?:the\s+)?(?:flashlight|torch|phone\s+light|mobile\s+light)|(?:turn\s+on|switch\s+on)\s+(?:the\s+)?light|(?:flashlight|torch)\s+(?:on|please\s+on|turn\s+on|switch\s+on)|(?:phone|mobile)\s+light\s+(?:on|turn\s+on))$/i;
  if (englishOnRegex.test(normalized)) return true;

  // Explicit Bengali ON commands
  const hasTorchNoun = /(?:টর্চ|টরচ|ফ্ল্যাশ\s*লাইট|ফ্লাস\s*লাইট|মোবাইলের\s*লাইট|ফোনের\s*লাইট)/.test(normalized);
  const hasOnVerb = /(?:জ্বালাও|জ্বালিয়ে\s*দাও|জ্বালিয়ে\s*দাও|অন\s*করো|অন\s*কর|চালু\s*করো|চালু\s*কর)/.test(normalized);

  if (hasTorchNoun && hasOnVerb) return true;

  // Standalone direct command: "লাইট অন করো", "লাইট জ্বালাও", "লাইট জ্বালিয়ে দাও"
  const directLightOn = /^(?:মোবাইলের\s*)?লাইট\s*(?:অন\s*করো|অন\s*কর|জ্বালাও|জ্বালিয়ে\s*দাও|জ্বালিয়ে\s*দাও|চালু\s*করো)$/;
  if (directLightOn.test(normalized)) return true;

  return false;
}

/**
 * Detect explicit Flashlight OFF commands
 */
export function isFlashlightOffCommand(raw: string): boolean {
  const normalized = normalizeSpokenCommand(raw);
  if (isNonFlashlightLightQuery(normalized)) {
    return false;
  }

  // Explicit English OFF commands
  const englishOffRegex =
    /^(?:(?:please\s+)?(?:turn\s+off|switch\s+off)\s+(?:the\s+)?(?:flashlight|torch|phone\s+light|mobile\s+light)|(?:turn\s+off|switch\s+off)\s+(?:the\s+)?light|(?:flashlight|torch)\s+(?:off|please\s+off|turn\s+off|switch\s+off)|(?:phone|mobile)\s+light\s+(?:off|turn\s+off))$/i;
  if (englishOffRegex.test(normalized)) return true;

  // Explicit Bengali OFF commands
  const hasTorchNoun = /(?:টর্চ|টরচ|ফ্ল্যাশ\s*লাইট|ফ্লাস\s*লাইট|মোবাইলের\s*লাইট|ফোনের\s*লাইট)/.test(normalized);
  const hasOffVerb = /(?:বন্ধ\s*করো|বন্ধ\s*কর|বন্ধ\s*করে\s*দাও|অফ\s*করো|অফ\s*কর|নিভিয়ে\s*দাও|নিভিয়ে\s*দাও|নিভাও)/.test(normalized);

  if (hasTorchNoun && hasOffVerb) return true;

  // Standalone direct command: "লাইট অফ করো", "লাইট বন্ধ করো", "লাইট নিভিয়ে দাও"
  const directLightOff = /^(?:মোবাইলের\s*)?লাইট\s*(?:অফ\s*করো|অফ\s*কর|বন্ধ\s*করো|বন্ধ\s*কর|বন্ধ\s*করে\s*দাও|নিভিয়ে\s*দাও|নিভিয়ে\s*দাও|নিভাও)$/;
  if (directLightOff.test(normalized)) return true;

  return false;
}

/**
 * Parse Voice or Text input to detect Assistant action intents (Bengali, Hindi, English)
 */
export function detectAssistantIntent(text: string): AssistantAction | null {
  const lower = text.toLowerCase().trim();

  // 1. Phone Call Intent: "কল করো 017...", "call 01...", "phone lagao", "call karo"
  const callRegex = /(?:কল\s*(?:করো|করুন)|call|phone\s*(?:karo|lagao)|ফোন\s*(?:করো|করুন))\s*([+0-9\s-]{6,16})/i;
  const callMatch = lower.match(callRegex);
  if (callMatch && callMatch[1]) {
    const number = callMatch[1].replace(/[\s-]/g, '');
    return {
      type: 'call',
      target: number,
      label: `📞 Phone Call to ${number}`,
    };
  }

  // 2. WhatsApp Intent: "হোয়াটসঅ্যাপ করো 017...", "whatsapp 017... text"
  const waRegex = /(?:হোয়াটসঅ্যাপ|whatsapp|whats\s*app)\s*(?:করো|karo|send)?\s*([+0-9\s-]{6,16})?\s*(?:মেসেজ|message|text)?\s*(.*)?/i;
  const waMatch = lower.match(waRegex);
  if (waMatch && (waMatch[1] || lower.includes('whatsapp') || lower.includes('হোয়াটসঅ্যাপ'))) {
    const number = (waMatch[1] || '').replace(/[\s-]/g, '');
    const msg = (waMatch[2] || '').trim();
    return {
      type: 'whatsapp',
      target: number || '',
      payload: msg || 'Hello from Zoni Assistant',
      label: `💬 WhatsApp to ${number || 'Contact'}`,
    };
  }

  // 3. SMS Intent: "এসএমএস করো 017...", "sms 017...", "message send"
  const smsRegex = /(?:এসএমএস|sms|message)\s*(?:পাঠাও|send|karo)?\s*([+0-9\s-]{6,16})?\s*(?:text)?\s*(.*)?/i;
  const smsMatch = lower.match(smsRegex);
  if (smsMatch && smsMatch[1]) {
    const number = smsMatch[1].replace(/[\s-]/g, '');
    const msg = (smsMatch[2] || '').trim();
    return {
      type: 'sms',
      target: number,
      payload: msg || 'Hello',
      label: `✉️ SMS to ${number}`,
    };
  }

  // 4. Flashlight / Torch Intent: Normalization and direct command matching
  if (isFlashlightOnCommand(text)) {
    return {
      type: 'flashlight',
      payload: 'on',
      label: '🔦 Turn ON Flashlight',
    };
  }
  if (isFlashlightOffCommand(text)) {
    return {
      type: 'flashlight',
      payload: 'off',
      label: '🔦 Turn OFF Flashlight',
    };
  }

  // 5. Vibration Intent: "ভাইব্রেট করো", "vibrate mobile"
  if (/(?:ভাইব্রেশন|vibrate|ভাইব্রেট)/i.test(lower)) {
    return {
      type: 'vibrate',
      label: '📳 Mobile Haptic Vibration',
    };
  }

  // 6. Battery Intent: "ব্যাটারি কত", "battery check", "চার্জ কত"
  if (/(?:ব্যাটারি|battery|চার্জ|charge)\s*(?:কত|check|level)?/i.test(lower)) {
    return {
      type: 'battery',
      label: '🔋 Check Battery Level',
    };
  }

  // 7. App Launch Intent (e.g. "open YouTube", "ইউটিউব খোলো", "open WhatsApp", etc.)
  const openAppMatch =
    lower.match(/(?:open|launch|start)\s+([a-z0-9\s]+)/i) ||
    lower.match(/([a-z0-9\s\u0980-\u09FF]+?)\s*(?:ওপেন\s*করো|খোলো|চালু\s*করো)/i);
  if (openAppMatch && openAppMatch[1]) {
    const candidate = openAppMatch[1].trim();
    if (
      candidate &&
      !candidate.includes('settings') &&
      !candidate.includes('সেটিংস') &&
      !candidate.includes('flashlight') &&
      !candidate.includes('লাইট') &&
      !candidate.includes('টর্চ')
    ) {
      return {
        type: 'app',
        target: candidate,
        label: `📱 Open ${candidate}`,
      };
    }
  }

  // 8. Settings Intent
  if (
    lower.includes('wifi settings') ||
    lower.includes('wi-fi settings') ||
    lower.includes('ওয়াইফাই সেটিংস')
  ) {
    return {
      type: 'settings',
      target: 'wifi',
      label: '⚙️ Open Wi-Fi Settings',
    };
  }
  if (lower.includes('bluetooth settings') || lower.includes('ব্লুটুথ সেটিংস')) {
    return {
      type: 'settings',
      target: 'bluetooth',
      label: '⚙️ Open Bluetooth Settings',
    };
  }
  if (
    lower.includes('open settings') ||
    lower.includes('phone settings') ||
    lower.includes('সেটিংস খোলো') ||
    lower.includes('সেটিংস ওপেন করো')
  ) {
    return {
      type: 'settings',
      target: 'main',
      label: '⚙️ Open Settings',
    };
  }

  return null;
}

/**
 * Detect language-switch voice or text commands before normal conversation:
 * - "বাংলায় কথা বলো" -> bn-BD
 * - "হিন্দিতে কথা বলো" -> hi-IN
 * - "ইংরেজিতে কথা বলো" -> en-US
 */
export function detectLanguageSwitchCommand(
  text: string,
  affectionName: string = 'Boss'
): LanguageSwitchResult | null {
  const clean = text.trim().toLowerCase();
  const name = (affectionName || 'Boss').trim();

  // 1. Bengali Switch Command
  if (
    /(?:বাংলায়|বাংলায়|বাংলা\s*ভাষায়|বাংলা)\s*(?:কথা\s*বলো|কথা\s*বলুন|বলো|বলুন)/.test(clean) ||
    /bangla[yi]?\s*kotha\s*bolo/i.test(clean) ||
    /speak\s*(?:in\s*)?bengali/i.test(clean) ||
    /talk\s*(?:in\s*)?bengali/i.test(clean) ||
    /switch\s*to\s*bengali/i.test(clean) ||
    /change\s*(?:language\s*)?(?:to\s*)?bengali/i.test(clean)
  ) {
    return {
      lang: 'bn-BD',
      name: 'বাংলা (Bengali)',
      label: '🗣️ ভাষা পরিবর্তন: বাংলা (bn-BD)',
      confirmation: `ঠিক আছে ${name}! এখন থেকে আমি আপনার সাথে সবসময় মিষ্টি বাংলায় কথা বলব। বলুন ${name}, কেমন আছেন? ❤️`,
    };
  }

  // 2. Hindi Switch Command
  if (
    /(?:হিন্দিতে|হিন্দি\s*তে|হিন্দি\s*ভাষায়|হিন্দি)\s*(?:কথা\s*বলো|কথা\s*বলুন|বলো|বলুন)/.test(clean) ||
    /(?:हिंदी|हिन्दी)\s*(?:में)?\s*(?:बात\s*करো|बात\s*कीजिए|बोलो)/.test(clean) ||
    /hindi\s*(?:me|mein)\s*(?:baat\s*karo|bolo)/i.test(clean) ||
    /hindite\s*kotha\s*bolo/i.test(clean) ||
    /speak\s*(?:in\s*)?hindi/i.test(clean) ||
    /talk\s*(?:in\s*)?hindi/i.test(clean) ||
    /switch\s*to\s*hindi/i.test(clean) ||
    /change\s*(?:language\s*)?(?:to\s*)?hindi/i.test(clean)
  ) {
    return {
      lang: 'hi-IN',
      name: 'हिंदी (Hindi)',
      label: '🗣️ ভাষা পরিবর্তন: হিন্দি (hi-IN)',
      confirmation: `Theek hai mere ${name}! Ab se main aapke saath Hindi mein baat karungi. Boliye ${name}, main aapke liye kya kar sakti hoon? ❤️`,
    };
  }

  // 3. English Switch Command
  if (
    /(?:ইংরেজিতে|ইংরেজি\s*তে|ইংরেজি\s*ভাষায়|ইংরেজি)\s*(?:কথা\s*বলো|কথা\s*বলুন|বলো|বলুন)/.test(clean) ||
    /ingrijite\s*kotha\s*bolo/i.test(clean) ||
    /english\s*(?:me|mein)\s*(?:baat\s*karo|bolo)/i.test(clean) ||
    /speak\s*(?:in\s*)?english/i.test(clean) ||
    /talk\s*(?:in\s*)?english/i.test(clean) ||
    /switch\s*to\s*english/i.test(clean) ||
    /change\s*(?:language\s*)?(?:to\s*)?english/i.test(clean)
  ) {
    return {
      lang: 'en-US',
      name: 'English (US)',
      label: '🗣️ Language Switched: English (en-US)',
      confirmation: `Understood, ${name}! I'll speak with you in English from now on. How are you feeling today, ${name}? ❤️`,
    };
  }

  return null;
}
