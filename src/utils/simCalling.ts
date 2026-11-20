export interface NativeContactItem {
  id: string;
  name: string;
  phone: string;
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
    return parsed.filter((c) => c && typeof c.name === 'string' && typeof c.phone === 'string');
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
