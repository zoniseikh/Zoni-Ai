export interface NativeContactItem {
  id: string;
  name: string;
  phone: string;
}

const INVISIBLE_PHONE_CHARS = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;
const BENGALI_DIGITS: Record<string, string> = {
  '০': '0',
  '১': '1',
  '২': '2',
  '৩': '3',
  '৪': '4',
  '৫': '5',
  '৬': '6',
  '৭': '7',
  '৮': '8',
  '৯': '9',
};

/**
 * Produces a canonical comparison key for phone numbers regardless of formatting,
 * spaces, hyphens, parentheses, invisible BiDi marks, leading trunk '0', '00' prefix,
 * or country codes (e.g., "9876543210", "098765-43210", "+91 98765 43210", "00919876543210").
 */
export function canonicalizeContactPhoneKey(rawPhone: string): string {
  const cleaned = String(rawPhone || '')
    .replace(INVISIBLE_PHONE_CHARS, '')
    .replace(/[০-৯]/g, (d) => BENGALI_DIGITS[d] || d)
    .trim();
  if (!cleaned) return '';
  const digitsOnly = cleaned.replace(/\D/g, '');
  if (digitsOnly.length < 3) return '';
  if (digitsOnly.length >= 10) return digitsOnly.slice(-10);
  const trimmed = digitsOnly.replace(/^0+/, '');
  return trimmed.length >= 3 ? trimmed : digitsOnly;
}

/**
 * Deduplicates contact search / disambiguation candidates by (normalized contact name + canonical phone key).
 * - Collapses duplicate entries for the same person + same phone number across Android accounts/formatting.
 * - Preserves genuinely distinct phone numbers for the same person.
 * - Preserves genuinely distinct contacts that share the same name but have different phone numbers.
 */
export function deduplicateContactCandidates<
  T extends { id?: string; name?: string; phone?: string }
>(candidates: T[]): T[] {
  const byKey = new Map<string, T>();
  for (const item of candidates) {
    if (!item || typeof item.name !== 'string' || typeof item.phone !== 'string') continue;
    const normName = item.name
      .normalize('NFC')
      .replace(INVISIBLE_PHONE_CHARS, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
    const phoneKey = canonicalizeContactPhoneKey(item.phone);
    if (!normName || !phoneKey) continue;
    const dedupKey = `${normName}|${phoneKey}`;
    const existing = byKey.get(dedupKey);
    const trimmedPhone = item.phone.replace(INVISIBLE_PHONE_CHARS, '').trim();
    if (!existing) {
      byKey.set(dedupKey, item);
    } else {
      const existingPhone = String(existing.phone || '').replace(INVISIBLE_PHONE_CHARS, '').trim();
      if (trimmedPhone.startsWith('+') && !existingPhone.startsWith('+')) {
        byKey.set(dedupKey, item);
      }
    }
  }
  return Array.from(byKey.values());
}

export interface LocalSimCallRecord {
  id: string;
  targetName: string;
  phoneNumber: string;
  createdAtIso: string;
  status: string;
}

const LOCAL_SIM_HISTORY_KEY = 'zoni_sim_call_history_v1';

/**
 * Queries native Android Contacts via window.ZoniAndroidBridge when running inside the APK.
 */
export function searchNativeAndroidContacts(query: string): NativeContactItem[] {
  if (typeof window === 'undefined') return [];
  const bridge = (window as any).ZoniAndroidBridge;
  if (!bridge || typeof bridge.searchContactsJson !== 'function') return [];
  try {
    const raw = bridge.searchContactsJson(query);
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const valid = parsed.filter(
      (c): c is NativeContactItem => Boolean(c && typeof c.name === 'string' && typeof c.phone === 'string')
    );
    return deduplicateContactCandidates(valid);
  } catch {
    return [];
  }
}

/**
 * Reads local SIM call history from Android Room DB bridge (when in APK) or localStorage.
 */
export function loadLocalSimCallHistory(): LocalSimCallRecord[] {
  if (typeof window === 'undefined') return [];

  const bridge = (window as any).ZoniAndroidBridge;
  if (bridge && typeof bridge.getLocalCallHistoryJson === 'function') {
    try {
      const raw = bridge.getLocalCallHistoryJson();
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.map((item: any) => ({
          id: String(item.id || `sim_${Date.now()}`),
          targetName: String(item.targetName || item.phoneNumber || 'Unknown'),
          phoneNumber: String(item.phoneNumber || ''),
          createdAtIso: item.createdAtMs
            ? new Date(Number(item.createdAtMs)).toISOString()
            : new Date().toISOString(),
          status: String(item.state || 'initiated'),
        }));
      }
    } catch {
      // Fall back to localStorage below
    }
  }

  try {
    const stored = window.localStorage.getItem(LOCAL_SIM_HISTORY_KEY);
    if (!stored) return [];
    const parsed = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function appendLocalSimCallRecord(record: LocalSimCallRecord): LocalSimCallRecord[] {
  const existing = loadLocalSimCallHistory().filter((r) => r.id !== record.id);
  const next = [record, ...existing].slice(0, 50);
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(LOCAL_SIM_HISTORY_KEY, JSON.stringify(next));
    } catch {
      // ignore quota errors
    }
  }
  return next;
}

export function clearLocalSimCallHistory(): void {
  if (typeof window === 'undefined') return;
  const bridge = (window as any).ZoniAndroidBridge;
  if (bridge && typeof bridge.clearLocalCallHistory === 'function') {
    try {
      bridge.clearLocalCallHistory();
    } catch {
      // ignore
    }
  }
  try {
    window.localStorage.removeItem(LOCAL_SIM_HISTORY_KEY);
  } catch {
    // ignore
  }
}
