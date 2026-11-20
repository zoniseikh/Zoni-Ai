/**
 * Zoni AI — Rule-Based Auto Reply Engine (Pure Logic + Storage/Android Bridge Sync)
 *
 * Mirrors `AutoReplyRuleManager.kt` so users can manage rules inside the Zoni dashboard
 * and sync them directly into the native Android NotificationListenerService.
 *
 * Safety & Transparency:
 * - Master toggle defaults to FALSE (explicit opt-in required).
 * - Only triggers when master switch is ON, rule is enabled, and incoming message matches.
 */

export interface AutoReplyRule {
  id: string;
  enabled: boolean;
  keyword: string;
  senderFilter: string;
  replyText: string;
  whatsappOnly: boolean;
}

export interface AutoReplyConfig {
  enabled: boolean;
  rules: AutoReplyRule[];
}

const STORAGE_KEY = 'zoni_auto_reply_config_v1';

export const DEFAULT_AUTO_REPLY_CONFIG: AutoReplyConfig = {
  enabled: false,
  rules: [
    {
      id: 'rule_busy_default',
      enabled: true,
      keyword: 'busy',
      senderFilter: '',
      replyText: 'এখন একটু ব্যস্ত আছি, একটু পরে কল করছি।',
      whatsappOnly: true,
    },
  ],
};

export function findMatchingAutoReplyRule(
  config: AutoReplyConfig,
  sender: string,
  messageText: string,
  isWhatsApp: boolean
): AutoReplyRule | null {
  if (!config.enabled) return null;
  const cleanSender = (sender || '').trim().toLowerCase();
  const cleanMsg = (messageText || '').trim().toLowerCase();
  if (!cleanMsg) return null;

  for (const rule of config.rules) {
    if (!rule.enabled) continue;
    if (!rule.replyText || !rule.replyText.trim()) continue;
    if (rule.whatsappOnly && !isWhatsApp) continue;

    const senderReq = (rule.senderFilter || '').trim().toLowerCase();
    if (senderReq && !cleanSender.includes(senderReq)) continue;

    const keywordReq = (rule.keyword || '').trim().toLowerCase();
    if (!keywordReq || cleanMsg.includes(keywordReq)) {
      return rule;
    }
  }
  return null;
}

export function loadAutoReplyConfig(): AutoReplyConfig {
  if (typeof window === 'undefined') return DEFAULT_AUTO_REPLY_CONFIG;
  try {
    const bridge = (window as any).ZoniAndroidBridge;
    if (bridge?.getAutoReplyRulesJson) {
      const raw = bridge.getAutoReplyRulesJson();
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.rules)) {
        return {
          enabled: Boolean(parsed.enabled),
          rules: parsed.rules,
        };
      }
    }
  } catch {
    // fallback to localStorage
  }

  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      if (parsed && Array.isArray(parsed.rules)) {
        return {
          enabled: Boolean(parsed.enabled),
          rules: parsed.rules,
        };
      }
    }
  } catch {
    // ignore
  }

  return DEFAULT_AUTO_REPLY_CONFIG;
}

export function saveAutoReplyConfig(config: AutoReplyConfig): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    // ignore quota errors
  }

  try {
    const bridge = (window as any).ZoniAndroidBridge;
    if (bridge?.setAutoReplyEnabled) {
      bridge.setAutoReplyEnabled(Boolean(config.enabled));
    }
    if (bridge?.saveAutoReplyRulesJson) {
      bridge.saveAutoReplyRulesJson(JSON.stringify(config.rules));
    }
  } catch {
    // ignore bridge sync errors in web mode
  }
}
