/**
 * Local-first Conversation Memory & Privacy-Filtered Personal Memory Engine (TypeScript companion).
 *
 * Mirrors Android's Room-backed `LocalMemoryLogic` for WebView + browser parity:
 * - Strictly blocks storing passwords, OTPs, PINs, CVVs, card numbers, banking credentials, or API keys.
 * - Extracts bounded, deduplicated user facts, preferences, language choices, and frequent commands.
 * - Supports instant offline memory recall and compact bounded context generation for Gemini
 *   (never dumps full conversation history).
 * - Automatically delegates to native Android Room (`ZoniDatabase` v2) when running inside the APK.
 */

import {
  buildCompactMemoryContextViaNativeBridge,
  clearLocalConversationHistoryViaNativeBridge,
  clearLocalLongTermMemoryViaNativeBridge,
  getLocalConversationHistoryViaNativeBridge,
  getLocalMemorySummaryViaNativeBridge,
  recallLocalMemoryViaNativeBridge,
  saveLocalConversationMessageViaNativeBridge,
} from './androidBridge';

export type LocalMemoryCategory =
  | 'language'
  | 'preference'
  | 'personal_fact'
  | 'frequent_command'
  | 'context';

export interface LocalConversationRecord {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  language: string;
  createdAtMs: number;
}

export interface LocalMemoryRecord {
  id: string;
  category: LocalMemoryCategory;
  factKey: string;
  value: string;
  searchKeywords: string;
  usageCount: number;
  userApproved: boolean;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface LocalMemoryRecallResult {
  isMemoryQuery: boolean;
  handledOffline: boolean;
  replyText: string;
  matchedFacts: LocalMemoryRecord[];
  matchedMessages: LocalConversationRecord[];
}

export const MAX_COMPACT_CONTEXT_CHARS = 520;
export const MAX_STORED_MESSAGE_CHARS = 1600;

const STORAGE_KEY_HISTORY = 'zoni_local_conversations_v2';
const STORAGE_KEY_MEMORIES = 'zoni_local_memories_v2';
const MAX_WEB_HISTORY_ROWS = 200;

const SENSITIVE_KEYWORDS = [
  'password',
  'passwd',
  'passcode',
  'পাসওয়ার্ড',
  'পাসওয়ার্ড',
  'पासवर्ड',
  'otp',
  'ওটিপি',
  'ओटीपी',
  'one time password',
  'verification code',
  'ভেরিফিকেশন কোড',
  'pin ',
  ' pin',
  'পিন',
  'mpin',
  'upi pin',
  'atm pin',
  'বিকাশ পিন',
  'নগদ পিন',
  'cvv',
  'cvc',
  'সিভিভি',
  'card number',
  'কার্ড নম্বর',
  'debit card',
  'credit card',
  'bank account',
  'ব্যাংক একাউন্ট',
  'routing number',
  'ifsc',
  'swift code',
  'secret key',
  'private key',
  'recovery phrase',
  'seed phrase',
  'api key',
];

const OTP_PATTERN = /(?:otp|code|pin|পিন|ওটিপি|কোড)\s*(?:is|হলো|হল|:|=|-)?\s*\d{4,8}\b/i;
const CARD_NUMBER_PATTERN = /\b(?:\d[ -]*?){13,19}\b/;
const API_KEY_PATTERN = /(?:AIza[0-9A-Za-z_-]{12,}|AQ\.[0-9A-Za-z._-]{12,}|sk-[0-9A-Za-z]{16,})/;

const STOP_WORDS = new Set([
  'what',
  'did',
  'you',
  'the',
  'about',
  'remember',
  'say',
  'said',
  'talk',
  'know',
  'that',
  'this',
  'আমার',
  'আমি',
  'তুমি',
  'আগে',
  'বলেছিলাম',
  'জানো',
  'মনে',
  'আছে',
  'সম্পর্কে',
  'কী',
  'কি',
]);

export function containsSensitiveSecret(text: string | null | undefined): boolean {
  const clean = String(text || '').trim();
  if (!clean) return false;
  const lower = ` ${clean.toLowerCase()} `;
  if (API_KEY_PATTERN.test(clean)) return true;
  if (OTP_PATTERN.test(clean)) return true;
  if (CARD_NUMBER_PATTERN.test(clean)) {
    const digits = clean.replace(/\D/g, '');
    if (digits.length >= 13 && digits.length <= 19) return true;
  }
  return SENSITIVE_KEYWORDS.some((kw) => lower.includes(kw));
}

export function sanitizeForLocalStorage(text: string | null | undefined): string | null {
  const clean = String(text || '').trim();
  if (!clean || containsSensitiveSecret(clean)) return null;
  return clean.length > MAX_STORED_MESSAGE_CHARS
    ? clean.slice(0, MAX_STORED_MESSAGE_CHARS).trimEnd()
    : clean;
}

export function normalizeMemorySlug(input: string): string {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '');
  return slug || 'entry';
}

export function buildMemoryKeywords(text: string): string {
  const tokens = text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2);
  return Array.from(new Set(tokens)).slice(0, 18).join(' ');
}

function tokenizeQuery(query: string): string[] {
  const tokens = query
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
  return Array.from(new Set(tokens)).slice(0, 8);
}

export function extractUserMemoryFacts(
  userText: string
): Array<{ category: LocalMemoryCategory; factKey: string; value: string; searchKeywords: string }> {
  const clean = String(userText || '').trim();
  if (!clean || containsSensitiveSecret(clean)) return [];

  const facts: Array<{
    category: LocalMemoryCategory;
    factKey: string;
    value: string;
    searchKeywords: string;
  }> = [];

  // 1. User's own name
  const namePatterns = [
    /(?:আমার\s+নাম|আমাকে\s+ডাকবে|আমার\s+নামটা)\s*[:,-]?\s*([\p{L}\p{M}][\p{L}\p{M}\s.'-]{1,36}?)(?:\s*(?:বলে|নামে|।|\.|!|$))/iu,
    /(?:my\s+name\s+is|call\s+me)\s+([A-Za-z][A-Za-z\s.'-]{1,36}?)(?:\s*(?:\.|!|,|$))/i,
    /(?:मेरा\s+नाम)\s+([\p{L}\p{M}][\p{L}\p{M}\s.'-]{1,36}?)(?:\s*(?:है|।|\.|!|$))/iu,
  ];
  for (const rx of namePatterns) {
    const match = clean.match(rx);
    const candidate = match?.[1]?.trim() || '';
    if (candidate.length >= 2 && candidate.length <= 36 && !containsSensitiveSecret(candidate)) {
      facts.push({
        category: 'personal_fact',
        factKey: 'user_name',
        value: candidate,
        searchKeywords: `name নাম user_name ${candidate.toLowerCase()}`,
      });
      break;
    }
  }

  // 2. Explicit remember instruction
  const rememberPatterns = [
    /(?:মনে\s*রাখো|মনে\s*রেখো|সেভ\s*করে\s*রাখো)\s*(?:যে)?\s*[:,-]?\s*(.+)/i,
    /(?:remember\s+that|remember\s+this|save\s+this\s+to\s+memory|keep\s+in\s+mind\s+that)\s*[:,-]?\s*(.+)/i,
    /(?:याद\s*रखो|याद\s*रखना)\s*(?:कि)?\s*[:,-]?\s*(.+)/i,
  ];
  for (const rx of rememberPatterns) {
    const match = clean.match(rx);
    const note = (match?.[1] || '').trim().replace(/[.।!?]+$/, '');
    if (note.length >= 3 && note.length <= 180 && !containsSensitiveSecret(note)) {
      facts.push({
        category: 'personal_fact',
        factKey: `note_${normalizeMemorySlug(note).slice(0, 40)}`,
        value: note,
        searchKeywords: buildMemoryKeywords(`remember মনে note ${note}`),
      });
      break;
    }
  }

  // 3. Language preference
  const lower = clean.toLowerCase();
  if (
    lower.includes('বাংলায় কথা বল') ||
    lower.includes('বাংলায় কথা বল') ||
    lower.includes('speak in bengali') ||
    lower.includes('talk in bangla')
  ) {
    facts.push({
      category: 'language',
      factKey: 'preferred_language',
      value: 'bn-BD (Bengali)',
      searchKeywords: 'language ভাষা bengali bangla বাংলা bn-bd',
    });
  } else if (
    lower.includes('speak in english') ||
    lower.includes('talk in english') ||
    lower.includes('ইংরেজিতে কথা বল')
  ) {
    facts.push({
      category: 'language',
      factKey: 'preferred_language',
      value: 'en-US (English)',
      searchKeywords: 'language ভাষা english ইংরেজি en-us',
    });
  } else if (
    lower.includes('speak in hindi') ||
    lower.includes('हिंदी में बात') ||
    lower.includes('হিন্দিতে কথা বল')
  ) {
    facts.push({
      category: 'language',
      factKey: 'preferred_language',
      value: 'hi-IN (Hindi)',
      searchKeywords: 'language ভাষা hindi হিন্দি हिंदी hi-in',
    });
  }

  // 4. User preferences
  const prefPatterns = [
    /(?:আমি)\s+(.{3,90}?)\s+(?:পছন্দ\s*করি|ভালোবাসি)/i,
    /(?:i\s+prefer|i\s+really\s+like|my\s+favorite\s+[a-z]+\s+is)\s+(.{3,90}?)(?:\.|!|$)/i,
  ];
  for (const rx of prefPatterns) {
    const match = clean.match(rx);
    const pref = match?.[1]?.trim() || '';
    if (pref.length >= 3 && pref.length <= 90 && !containsSensitiveSecret(pref)) {
      facts.push({
        category: 'preference',
        factKey: `pref_${normalizeMemorySlug(pref).slice(0, 36)}`,
        value: pref,
        searchKeywords: buildMemoryKeywords(`preference পছন্দ favorite ${pref}`),
      });
      break;
    }
  }

  const seen = new Set<string>();
  return facts.filter((f) => {
    if (seen.has(f.factKey)) return false;
    seen.add(f.factKey);
    return true;
  });
}

export function isMemoryRecallQuery(userText: string): boolean {
  const lower = String(userText || '').trim().toLowerCase();
  if (!lower) return false;
  return (
    lower.includes('আগে কী বলেছিলাম') ||
    lower.includes('আগে কি বলেছিলাম') ||
    lower.includes('গতবার কী বলেছিলাম') ||
    lower.includes('আমার সম্পর্কে কী জানো') ||
    lower.includes('আমার সম্পর্কে কি জানো') ||
    lower.includes('আমার নাম কী') ||
    lower.includes('আমার নাম কি') ||
    lower.includes('তুমি কী মনে রেখেছ') ||
    lower.includes('তুমি কি মনে রেখেছ') ||
    lower.includes('মনে আছে কি') ||
    lower.includes('মেমোরিতে কী আছে') ||
    lower.includes('what did i say') ||
    lower.includes('what did we talk about') ||
    lower.includes('what do you remember') ||
    lower.includes('what do you know about me') ||
    lower.includes('what is my name') ||
    lower.includes('do you remember') ||
    lower.includes('my previous message') ||
    lower.includes('conversation history') ||
    lower.includes('मेरा नाम क्या है') ||
    lower.includes('मैंने पहले क्या कहा')
  );
}

export function answerLocalMemoryRecall(
  query: string,
  memories: LocalMemoryRecord[],
  recentMessages: LocalConversationRecord[],
  language: string = 'bn-BD'
): LocalMemoryRecallResult {
  if (!isMemoryRecallQuery(query)) {
    return {
      isMemoryQuery: false,
      handledOffline: false,
      replyText: '',
      matchedFacts: [],
      matchedMessages: [],
    };
  }

  const isBn = language.toLowerCase().startsWith('bn') || /[\u0980-\u09FF]/.test(query);
  const lower = query.toLowerCase();

  if (lower.includes('আমার নাম') || lower.includes('my name') || lower.includes('मेरा नाम')) {
    const nameFact = memories.find((m) => m.factKey === 'user_name');
    if (nameFact) {
      return {
        isMemoryQuery: true,
        handledOffline: true,
        replyText: isBn ? `আপনার নাম ${nameFact.value}।` : `Your name is ${nameFact.value}.`,
        matchedFacts: [nameFact],
        matchedMessages: [],
      };
    }
  }

  const tokens = tokenizeQuery(query);
  const rankedMemories = memories
    .filter((m) => m.userApproved && m.value.trim().length > 0 && !containsSensitiveSecret(m.value))
    .map((rec) => {
      const hay = `${rec.value} ${rec.searchKeywords} ${rec.category}`.toLowerCase();
      const hits = tokens.filter((t) => hay.includes(t)).length;
      return { rec, score: hits * 20 + Math.min(rec.usageCount, 10) };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((x) => x.rec);

  const priorUserMessages = recentMessages
    .filter((m) => m.role === 'user' && m.text.trim().toLowerCase() !== query.trim().toLowerCase())
    .sort((a, b) => b.createdAtMs - a.createdAtMs);

  const matchedMessages =
    tokens.length > 0
      ? (() => {
          const hits = priorUserMessages.filter((m) =>
            tokens.some((t) => m.text.toLowerCase().includes(t))
          );
          return hits.length > 0 ? hits.slice(0, 3) : priorUserMessages.slice(0, 3);
        })()
      : priorUserMessages.slice(0, 3);

  if (rankedMemories.length === 0 && matchedMessages.length === 0) {
    return {
      isMemoryQuery: true,
      handledOffline: true,
      replyText: isBn
        ? 'এখনো লোকাল মেমোরিতে সংরক্ষিত কোনো তথ্য বা আগের কথোপকথন নেই।'
        : 'There are no saved local memories or previous conversations yet.',
      matchedFacts: [],
      matchedMessages: [],
    };
  }

  const parts: string[] = [];
  if (rankedMemories.length > 0) {
    const summary = rankedMemories.map((m) => m.value).join('; ');
    parts.push(
      isBn ? `লোকাল মেমোরিতে যা মনে আছে: ${summary}।` : `From local memory: ${summary}.`
    );
  }
  if (matchedMessages.length > 0) {
    const snippet = matchedMessages[0].text.slice(0, 120);
    parts.push(
      isBn ? `আগে আপনি বলেছিলেন: "${snippet}"।` : `Earlier you said: "${snippet}".`
    );
  }

  return {
    isMemoryQuery: true,
    handledOffline: true,
    replyText: parts.join(' '),
    matchedFacts: rankedMemories,
    matchedMessages,
  };
}

export function buildCompactContextForGemini(
  query: string,
  memories: LocalMemoryRecord[],
  recentMessages: LocalConversationRecord[],
  maxChars: number = MAX_COMPACT_CONTEXT_CHARS
): string {
  const tokens = tokenizeQuery(query);
  const priorityMap: Record<LocalMemoryCategory, number> = {
    personal_fact: 10,
    language: 8,
    preference: 6,
    frequent_command: 3,
    context: 2,
  };

  const topMemories = memories
    .filter((m) => m.userApproved && m.value.trim().length > 0 && !containsSensitiveSecret(m.value))
    .map((rec) => {
      const hay = `${rec.value} ${rec.searchKeywords}`.toLowerCase();
      const relevance = tokens.filter((t) => hay.includes(t)).length * 15;
      const score = relevance + (priorityMap[rec.category] || 2) + Math.min(rec.usageCount, 8);
      return { rec, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 4)
    .map((x) => x.rec);

  const lines: string[] = [];
  if (topMemories.length > 0) {
    lines.push(
      `[LocalMemory] ${topMemories.map((m) => `${m.category}:${m.value.slice(0, 70)}`).join(' | ')}`
    );
  }

  const relevantRecent = recentMessages
    .filter((m) => !containsSensitiveSecret(m.text))
    .sort((a, b) => b.createdAtMs - a.createdAtMs)
    .slice(0, 3)
    .reverse();

  if (relevantRecent.length > 0) {
    lines.push(
      `[Recent] ${relevantRecent.map((m) => `${m.role}:${m.text.slice(0, 60)}`).join(' / ')}`
    );
  }

  const combined = lines.join('\n').trim();
  return combined.length <= maxChars ? combined : combined.slice(0, maxChars).trimEnd();
}

function readLocalJson<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined' || !window.localStorage) return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeLocalJson(key: string, value: unknown): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore quota errors
  }
}

export function persistLocalConversationTurn(
  role: 'user' | 'assistant',
  text: string,
  language: string = 'bn-BD'
): boolean {
  const safeText = sanitizeForLocalStorage(text);
  if (!safeText) return false;

  const nativeSaved = saveLocalConversationMessageViaNativeBridge(role, safeText, language);
  if (nativeSaved !== null) return nativeSaved;

  const now = Date.now();
  const history = readLocalJson<LocalConversationRecord[]>(STORAGE_KEY_HISTORY, []);
  history.push({
    id: `conv_${now}_${Math.random().toString(36).slice(2, 7)}`,
    role,
    text: safeText,
    language,
    createdAtMs: now,
  });
  writeLocalJson(STORAGE_KEY_HISTORY, history.slice(-MAX_WEB_HISTORY_ROWS));

  if (role === 'user') {
    const facts = extractUserMemoryFacts(safeText);
    if (facts.length > 0) {
      const existing = readLocalJson<LocalMemoryRecord[]>(STORAGE_KEY_MEMORIES, []);
      for (const fact of facts) {
        const idx = existing.findIndex((m) => m.factKey === fact.factKey);
        if (idx >= 0) {
          existing[idx] = {
            ...existing[idx],
            category: fact.category,
            value: fact.value,
            searchKeywords: fact.searchKeywords,
            usageCount: existing[idx].usageCount + 1,
            updatedAtMs: now,
          };
        } else {
          existing.push({
            id: `mem_${now}_${Math.random().toString(36).slice(2, 7)}`,
            category: fact.category,
            factKey: fact.factKey,
            value: fact.value,
            searchKeywords: fact.searchKeywords,
            usageCount: 1,
            userApproved: true,
            createdAtMs: now,
            updatedAtMs: now,
          });
        }
      }
      writeLocalJson(STORAGE_KEY_MEMORIES, existing.slice(-100));
    }
  }
  return true;
}

export function loadLocalConversationHistory(limit: number = 60, offset: number = 0): LocalConversationRecord[] {
  const nativeRows = getLocalConversationHistoryViaNativeBridge(limit, offset);
  if (nativeRows !== null) return nativeRows;
  const history = readLocalJson<LocalConversationRecord[]>(STORAGE_KEY_HISTORY, []);
  return history.slice(-limit);
}

export function tryOfflineLocalMemoryRecall(query: string, language: string = 'bn-BD'): LocalMemoryRecallResult {
  const nativeRes = recallLocalMemoryViaNativeBridge(query, language);
  if (nativeRes !== null) {
    return {
      isMemoryQuery: nativeRes.isMemoryQuery,
      handledOffline: nativeRes.handledOffline,
      replyText: nativeRes.replyText,
      matchedFacts: [],
      matchedMessages: [],
    };
  }
  const memories = readLocalJson<LocalMemoryRecord[]>(STORAGE_KEY_MEMORIES, []);
  const history = readLocalJson<LocalConversationRecord[]>(STORAGE_KEY_HISTORY, []);
  return answerLocalMemoryRecall(query, memories, history, language);
}

export function getCompactLocalMemoryContext(query: string): string {
  const nativeCtx = buildCompactMemoryContextViaNativeBridge(query);
  if (nativeCtx !== null) return nativeCtx;
  const memories = readLocalJson<LocalMemoryRecord[]>(STORAGE_KEY_MEMORIES, []);
  const history = readLocalJson<LocalConversationRecord[]>(STORAGE_KEY_HISTORY, []);
  return buildCompactContextForGemini(query, memories, history);
}

export function clearAllLocalConversationHistory(): boolean {
  const nativeOk = clearLocalConversationHistoryViaNativeBridge();
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.removeItem(STORAGE_KEY_HISTORY);
  }
  return nativeOk !== null ? nativeOk : true;
}

export function clearAllLocalLongTermMemory(): boolean {
  const nativeOk = clearLocalLongTermMemoryViaNativeBridge();
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.removeItem(STORAGE_KEY_MEMORIES);
  }
  return nativeOk !== null ? nativeOk : true;
}

export function getLocalMemorySummary(): {
  conversationCount: number;
  memoryCount: number;
  encryptedAtRest: boolean;
} {
  const nativeSummary = getLocalMemorySummaryViaNativeBridge();
  if (nativeSummary !== null) {
    return {
      conversationCount: nativeSummary.conversationCount,
      memoryCount: nativeSummary.memoryCount,
      encryptedAtRest: nativeSummary.encryptedAtRest,
    };
  }
  const memories = readLocalJson<LocalMemoryRecord[]>(STORAGE_KEY_MEMORIES, []);
  const history = readLocalJson<LocalConversationRecord[]>(STORAGE_KEY_HISTORY, []);
  return {
    conversationCount: history.length,
    memoryCount: memories.length,
    encryptedAtRest: false,
  };
}
