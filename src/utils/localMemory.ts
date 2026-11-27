/**
 * Permanent Local Conversation Memory & Privacy-Filtered Long-Term Memory Engine (TypeScript)
 *
 * Parity companion to Android's Room v3 + Keystore AES-256-GCM `LocalMemoryEngine.kt`:
 * - ZERO automatic deletion or retention limit (500-row & 200-row caps permanently removed).
 * - Stores complete conversation records: id, conversationId, role, text, timestamp, inputType
 *   ('voice' | 'text'), language, commandName, executionStatus, dateBucket, searchTokens.
 * - Strictly blocks passwords, OTPs, PINs, CVVs, card numbers, banking credentials, and API keys.
 * - Multilingual Bengali, English, and Hindi historical date parsing (15 days ago, 6 months ago,
 *   years ago, yesterday, last week, explicit YYYY-MM-DD), semantic topic clusters, and 3-gram similarity.
 * - Honest recall: retrieves original archive records BEFORE answering and NEVER invents or guesses
 *   historical conversations — explicitly reports when no matching record exists.
 * - Structured long-term memory linked to `sourceConversationId` & `sourceMessageId`, with ongoing
 *   tasks & user correction history that NEVER mutates or deletes the verbatim conversation archive.
 * - Automatically delegates to Android Room v3 + Keystore on APK, or permanent IndexedDB on Web.
 */

import {
  buildCompactMemoryContextViaNativeBridge,
  clearLocalConversationHistoryViaNativeBridge,
  clearLocalLongTermMemoryViaNativeBridge,
  exportEncryptedBackupViaNativeBridge,
  getDatabaseHealthViaNativeBridge,
  getLocalConversationDatesViaNativeBridge,
  getLocalConversationHistoryViaNativeBridge,
  getLocalMemorySummaryViaNativeBridge,
  recallLocalMemoryViaNativeBridge,
  recoverPendingWritesViaNativeBridge,
  restoreEncryptedBackupViaNativeBridge,
  saveLocalConversationRecordViaNativeBridge,
  searchLocalConversationsViaNativeBridge,
} from './androidBridge';
import {
  IndexedDbArchiveBackend,
  PermanentMemoryStore,
  decryptPermanentBackup,
  encryptPermanentBackup,
  formatUtcDateBucket,
  migrateV2ToV3Archive,
  type BackupExportResult,
  type BackupRestoreResult,
  type ConversationDateBucketSummary,
  type PermanentConversationRecord,
  type PermanentMemoryRecord,
  type PermanentStorageHealth,
  type WriteVerificationResult,
} from './permanentMemoryBackup';

export type LocalMemoryCategory =
  | 'language'
  | 'preference'
  | 'personal_fact'
  | 'frequent_command'
  | 'ongoing_task'
  | 'context';

export interface LocalConversationRecord {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  language: string;
  createdAtMs: number;
  conversationId?: string;
  inputType?: 'voice' | 'text';
  commandName?: string;
  executionStatus?: string;
  dateBucket?: string;
  searchTokens?: string;
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
  sourceConversationId?: string;
  sourceMessageId?: string;
  status?: 'active' | 'corrected' | 'superseded';
  correctionHistoryJson?: string;
}

export interface HistoricalDateRange {
  startMs: number;
  endMs: number;
  label: string;
  dateBucket?: string;
}

export interface LocalMemoryRecallResult {
  isMemoryQuery: boolean;
  handledOffline: boolean;
  foundEvidence: boolean;
  replyText: string;
  matchedFacts: LocalMemoryRecord[];
  matchedMessages: LocalConversationRecord[];
  dateRangeApplied?: HistoricalDateRange | null;
}

export interface PaginatedArchiveSearchParams {
  query?: string;
  dateBucket?: string;
  startMs?: number;
  endMs?: number;
  inputType?: '' | 'voice' | 'text';
  limit?: number;
  offset?: number;
  nowMs?: number;
}

export interface PaginatedArchiveSearchResult {
  messages: LocalConversationRecord[];
  totalMatched: number;
  hasMore: boolean;
  dateRangeApplied: HistoricalDateRange | null;
}

export const MAX_COMPACT_CONTEXT_CHARS = 520;
export const MAX_STORED_MESSAGE_CHARS = 16_000;

const STORAGE_KEY_HISTORY = 'zoni_local_conversations_v2';
const STORAGE_KEY_MEMORIES = 'zoni_local_memories_v2';
const STORAGE_KEY_MIGRATED_V3 = 'zoni_permanent_archive_migrated_v3';

const DAY_MS = 24 * 60 * 60 * 1000;

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
  'talked',
  'spoke',
  'know',
  'that',
  'this',
  'from',
  'when',
  'ago',
  'days',
  'day',
  'months',
  'month',
  'years',
  'year',
  'weeks',
  'week',
  'last',
  'earlier',
  'before',
  'history',
  'conversation',
  'message',
  'আমার',
  'আমি',
  'তুমি',
  'আগে',
  'বলেছিলাম',
  'বলেছি',
  'কথা',
  'হয়েছিল',
  'হয়েছিল',
  'জানো',
  'মনে',
  'আছে',
  'সম্পর্কে',
  'কী',
  'কি',
  'দিন',
  'মাস',
  'বছর',
  'সপ্তাহ',
  'গত',
  'নিয়ে',
  'নিয়ে',
  'मैंने',
  'मेरा',
  'पहले',
  'क्या',
  'कहा',
  'बात',
  'हुई',
  'थी',
  'दिन',
  'महीने',
  'साल',
  'याद',
  'है',
]);

const SEMANTIC_TOPIC_CLUSTERS: Record<string, string[]> = {
  topic_health: [
    'doctor', 'hospital', 'medicine', 'appointment', 'fever', 'clinic', 'checkup', 'health', 'pain',
    'ডাক্তার', 'হাসপাতাল', 'ওষুধ', 'অ্যাপয়েন্টমেন্ট', 'জ্বর', 'চিকিৎসা', 'স্বাস্থ্য', 'ব্যথা',
    'डॉक्टर', 'अस्पताल', 'दवाई', 'दवा', 'बुखार', 'स्वास्थ्य', 'इलाज',
  ],
  topic_travel: [
    'trip', 'travel', 'flight', 'train', 'ticket', 'hotel', 'vacation', 'journey', 'tour', 'airport',
    'ভ্রমণ', 'টিকিট', 'ট্রেন', 'ফ্লাইট', 'হোটেল', 'ঘুরতে', 'বিমান', 'যাত্রা',
    'यात्रा', 'टिकट', 'ट्रेन', 'फ्लाइट', 'होटल', 'घूमने',
  ],
  topic_finance: [
    'budget', 'salary', 'expense', 'rent', 'invoice', 'bill', 'loan', 'emi', 'savings', 'money', 'tax',
    'বাজেট', 'বেতন', 'খরচ', 'ভাড়া', 'বিল', 'টাকা', 'হিসাব', 'সঞ্চয়', 'লোন',
    'बजट', 'वेतन', 'खर्च', 'किराया', 'बिल', 'पैसा', 'हिसाब', 'बचत',
  ],
  topic_work: [
    'meeting', 'project', 'office', 'deadline', 'client', 'presentation', 'boss', 'report', 'work', 'task',
    'মিটিং', 'প্রজেক্ট', 'অফিস', 'ডেডলাইন', 'কাজ', 'রিপোর্ট', 'ক্লায়েন্ট',
    'मीटिंग', 'प्रोजेक्ट', 'ऑफिस', 'काम', 'रिपोर्ट', 'डेडलाइन',
  ],
  topic_family: [
    'family', 'mother', 'father', 'mom', 'dad', 'sister', 'brother', 'wife', 'husband', 'birthday', 'friend',
    'পরিবার', 'মা', 'বাবা', 'বোন', 'ভাই', 'বন্ধু', 'জন্মদিন', 'বাসা', 'বাড়ি',
    'परिवार', 'माँ', 'पापा', 'बहन', 'भाई', 'दोस्त', 'जन्मदिन', 'घर',
  ],
  topic_study: [
    'exam', 'study', 'college', 'university', 'school', 'homework', 'book', 'course', 'class', 'notes',
    'পরীক্ষা', 'পড়াশোনা', 'কলেজ', 'বিশ্ববিদ্যালয়', 'স্কুল', 'বই', 'ক্লাস', 'নোট',
    'परीक्षा', 'पढ़ाई', 'कॉलेज', 'स्कूल', 'किताब', 'क्लास',
  ],
  topic_shopping: [
    'market', 'grocery', 'shopping', 'buy', 'order', 'delivery', 'shop', 'price', 'amazon', 'flipkart',
    'বাজার', 'কেনাকাটা', 'কিনতে', 'অর্ডার', 'দোকান', 'ডেলিভারি', 'দাম',
    'बाजार', 'खरीदारी', 'ऑर्डर', 'दुकान', 'डिलीवरी',
  ],
  topic_food: [
    'food', 'dinner', 'lunch', 'breakfast', 'coffee', 'tea', 'restaurant', 'recipe', 'cook', 'biryani',
    'খাবার', 'ডিনার', 'লাঞ্চ', 'নাস্তা', 'কফি', 'চা', 'রেস্টুরেন্ট', 'রান্না', 'বিরিয়ানি',
    'खाना', 'चाय', 'कॉफी', 'रेस्टोरेंट', 'रेसिपी',
  ],
  topic_communication: [
    'call', 'called', 'phone', 'whatsapp', 'sms', 'message', 'email', 'contact',
    'কল', 'ফোন', 'হোয়াটসঅ্যাপ', 'মেসেজ', 'এসএমএস', 'ইমেইল', 'কন্টাক্ট',
    'कॉल', 'फोन', 'व्हाट्सएप', 'मैसेज', 'संदेश', 'ईमेल',
  ],
};

export function normalizeIndicDigits(input: string): string {
  const bnDigits = '০১২৩৪৫৬৭৮৯';
  const hiDigits = '०१२३४५६७८९';
  let out = '';
  for (const ch of input) {
    const bnIdx = bnDigits.indexOf(ch);
    if (bnIdx >= 0) {
      out += String(bnIdx);
      continue;
    }
    const hiIdx = hiDigits.indexOf(ch);
    if (hiIdx >= 0) {
      out += String(hiIdx);
      continue;
    }
    out += ch;
  }
  return out;
}

export function formatDateBucket(timestampMs: number): string {
  return formatUtcDateBucket(timestampMs);
}

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

export function detectSemanticTopics(text: string): string[] {
  const lower = normalizeIndicDigits(String(text || '')).toLowerCase();
  if (!lower.trim()) return [];
  const topics: string[] = [];
  for (const [topic, words] of Object.entries(SEMANTIC_TOPIC_CLUSTERS)) {
    if (words.some((w) => lower.includes(w))) {
      topics.push(topic);
    }
  }
  return topics;
}

export function buildMemoryKeywords(text: string): string {
  const normalized = normalizeIndicDigits(String(text || '')).trim().toLowerCase();
  const tokens = normalized
    .replace(/[^\p{L}\p{M}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2);
  const topics = detectSemanticTopics(normalized);
  return Array.from(new Set([...tokens, ...topics])).slice(0, 24).join(' ');
}

export function buildIndexedSearchTokens(text: string): string {
  const normalized = normalizeIndicDigits(String(text || '')).trim().toLowerCase();
  const tokens = normalized
    .replace(/[^\p{L}\p{M}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
  const topics = detectSemanticTopics(normalized);
  return Array.from(new Set([...tokens, ...topics])).slice(0, 48).join(' ');
}

function tokenizeQuery(query: string): string[] {
  const normalized = normalizeIndicDigits(String(query || '')).toLowerCase();
  const tokens = normalized
    .replace(/[^\p{L}\p{M}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t) && !/^\d+$/.test(t));
  return Array.from(new Set(tokens)).slice(0, 12);
}

function buildCharTrigrams(input: string): Set<string> {
  const clean = normalizeIndicDigits(input)
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, '');
  const set = new Set<string>();
  if (clean.length < 3) {
    if (clean.length > 0) set.add(clean);
    return set;
  }
  for (let i = 0; i <= clean.length - 3; i++) {
    set.add(clean.slice(i, i + 3));
  }
  return set;
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const x of a) {
    if (b.has(x)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Parses Bengali, English, and Hindi historical date references into a bounded UTC window:
 * - Explicit ISO date `YYYY-MM-DD`
 * - Relative N days ago ("15 days ago", "১৫ দিন আগে", "15 दिन पहले")
 * - Relative N weeks ago ("2 weeks ago", "২ সপ্তাহ আগে", "2 हफ्ते पहले")
 * - Relative N months ago ("6 months ago", "৬ মাস আগে", "6 महीने पहले")
 * - Relative N years ago ("2 years ago", "২ বছর আগে", "2 साल पहले")
 * - Yesterday / last week / last month / last year
 */
export function parseHistoricalDateRange(
  query: string,
  nowMs: number = Date.now()
): HistoricalDateRange | null {
  const norm = normalizeIndicDigits(String(query || '')).trim().toLowerCase();
  if (!norm) return null;

  // 1. Explicit ISO date YYYY-MM-DD
  const isoMatch = norm.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (isoMatch) {
    const year = Number(isoMatch[1]);
    const month = Number(isoMatch[2]);
    const day = Number(isoMatch[3]);
    if (year >= 2000 && year <= 2100 && month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const startMs = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
      const endMs = startMs + DAY_MS - 1;
      const bucket = `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
      return { startMs, endMs, label: bucket, dateBucket: bucket };
    }
  }

  // 2. Relative N days ago (English / Bengali / Hindi — avoid trailing \b for Unicode Indic scripts)
  const daysMatch = norm.match(
    /(?:^|[^\p{L}\p{N}])(\d{1,4})\s*(?:days?\s*ago\b|দিন\s*আগে|দিনের\s*আগে|दिन\s*पहले)/iu
  );
  if (daysMatch) {
    const n = Math.max(1, Math.min(3650, Number(daysMatch[1])));
    const center = nowMs - n * DAY_MS;
    const windowPad = n <= 3 ? 1.5 * DAY_MS : 2 * DAY_MS;
    return {
      startMs: Math.floor(center - windowPad),
      endMs: Math.ceil(center + windowPad),
      label: `${n} days ago`,
    };
  }

  // 3. Relative N weeks ago
  const weeksMatch = norm.match(
    /(?:^|[^\p{L}\p{N}])(\d{1,3})\s*(?:weeks?\s*ago\b|সপ্তাহ\s*আগে|हफ्ते\s*पहले|सप्ताह\s*पहले)/iu
  );
  if (weeksMatch) {
    const n = Math.max(1, Math.min(520, Number(weeksMatch[1])));
    const center = nowMs - n * 7 * DAY_MS;
    return {
      startMs: Math.floor(center - 4 * DAY_MS),
      endMs: Math.ceil(center + 4 * DAY_MS),
      label: `${n} weeks ago`,
    };
  }

  // 4. Relative N months ago
  const monthsMatch = norm.match(
    /(?:^|[^\p{L}\p{N}])(\d{1,3})\s*(?:months?\s*ago\b|মাস\s*আগে|महीने\s*पहले|माह\s*पहले)/iu
  );
  if (monthsMatch) {
    const n = Math.max(1, Math.min(240, Number(monthsMatch[1])));
    const center = nowMs - n * 30 * DAY_MS;
    return {
      startMs: Math.floor(center - 16 * DAY_MS),
      endMs: Math.ceil(center + 16 * DAY_MS),
      label: `${n} months ago`,
    };
  }

  // 5. Relative N years ago
  const yearsMatch = norm.match(
    /(?:^|[^\p{L}\p{N}])(\d{1,2})\s*(?:years?\s*ago\b|বছর\s*আগে|সাল\s*আগে|साल\s*पहले|वर्ष\s*पहले)/iu
  );
  if (yearsMatch) {
    const n = Math.max(1, Math.min(50, Number(yearsMatch[1])));
    const center = nowMs - n * 365 * DAY_MS;
    return {
      startMs: Math.floor(center - 45 * DAY_MS),
      endMs: Math.ceil(center + 45 * DAY_MS),
      label: `${n} years ago`,
    };
  }

  // 6. Named relative windows
  if (norm.includes('yesterday') || norm.includes('গতকাল') || norm.includes('कल')) {
    const center = nowMs - DAY_MS;
    const bucket = formatUtcDateBucket(center);
    return {
      startMs: center - DAY_MS,
      endMs: center + DAY_MS,
      label: 'yesterday',
      dateBucket: bucket,
    };
  }
  if (norm.includes('last week') || norm.includes('গত সপ্তাহ') || norm.includes('पिछले हफ्ते')) {
    return {
      startMs: nowMs - 11 * DAY_MS,
      endMs: nowMs - 3 * DAY_MS,
      label: 'last week',
    };
  }
  if (norm.includes('last month') || norm.includes('গত মাস') || norm.includes('पिछले महीने')) {
    return {
      startMs: nowMs - 46 * DAY_MS,
      endMs: nowMs - 15 * DAY_MS,
      label: 'last month',
    };
  }
  if (norm.includes('last year') || norm.includes('গত বছর') || norm.includes('पिछले साल')) {
    return {
      startMs: nowMs - 410 * DAY_MS,
      endMs: nowMs - 320 * DAY_MS,
      label: 'last year',
    };
  }

  return null;
}

export function scoreConversationMatch(
  query: string,
  record: LocalConversationRecord,
  dateRange: HistoricalDateRange | null
): number {
  let score = 0;
  if (dateRange) {
    if (record.createdAtMs < dateRange.startMs || record.createdAtMs > dateRange.endMs) {
      return 0;
    }
    score += 35;
  }

  const queryTokens = tokenizeQuery(query);
  const queryTopics = detectSemanticTopics(query);
  const hay = `${record.text} ${record.searchTokens || ''} ${record.commandName || ''}`.toLowerCase();
  const hayTopics = detectSemanticTopics(record.text);

  let keywordHits = 0;
  for (const tok of queryTokens) {
    if (hay.includes(tok)) {
      keywordHits++;
      score += 24;
    }
  }

  let topicHits = 0;
  for (const t of queryTopics) {
    if (hayTopics.includes(t)) {
      topicHits++;
      score += 18;
    }
  }

  if (queryTokens.length > 0 && keywordHits === 0) {
    const sim = jaccardSimilarity(buildCharTrigrams(queryTokens.join(' ')), buildCharTrigrams(record.text));
    if (sim >= 0.22) {
      score += Math.round(sim * 40);
    }
  }

  // If query specified content keywords/topics AND zero content matched, require dateRange alone only if no specific topic was asked
  if ((queryTokens.length > 0 || queryTopics.length > 0) && keywordHits === 0 && topicHits === 0 && score <= (dateRange ? 35 : 0)) {
    if (!dateRange) return 0;
    // With a date range AND specific query keywords that didn't match, keep score low (0) so unrelated date rows aren't false positives
    if (queryTokens.length >= 2) return 0;
  }

  return score;
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
  let matchedExplicitNote = false;
  const rememberPatterns = [
    /(?:মনে\s*রাখো|মনে\s*রেখো|সেভ\s*করে\s*রাখো)\s*(?:যে)?\s*[:,-]?\s*(.+)/i,
    /(?:remember\s+that|remember\s+this|save\s+this\s+to\s+memory|keep\s+in\s+mind\s+that)\s*[:,-]?\s*(.+)/i,
    /(?:याद\s*रखो|याद\s*रखना)\s*(?:कि)?\s*[:,-]?\s*(.+)/i,
  ];
  for (const rx of rememberPatterns) {
    const match = clean.match(rx);
    const note = (match?.[1] || '').trim().replace(/[.।!?]+$/, '');
    if (note.length >= 3 && note.length <= 180 && !containsSensitiveSecret(note)) {
      matchedExplicitNote = true;
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
    /(?:मुझे)\s+(.{3,90}?)\s+(?:पसंद\s*है)/i,
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

  // 5. Ongoing tasks / projects (only when not already captured as an explicit remember note)
  if (!matchedExplicitNote) {
    const taskPatterns = [
      /(?:i\s+am\s+working\s+on|my\s+ongoing\s+task\s+is|todo\s*:|need\s+to\s+finish)\s+(.{4,120}?)(?:\.|!|$)/i,
      /(?:আমি\s+এখন)\s+(.{4,120}?)\s+(?:কাজ\s*করছি|প্রজেক্টে\s*কাজ\s*করছি)/i,
      /(?:मैं\s+अभी)\s+(.{4,120}?)\s+(?:पर\s*काम\s*कर\s*रहा|काम\s*कर\s*रही)/i,
    ];
    for (const rx of taskPatterns) {
      const match = clean.match(rx);
      const task = (match?.[1] || '').trim().replace(/[.।!?]+$/, '');
      if (task.length >= 4 && task.length <= 120 && !containsSensitiveSecret(task)) {
        facts.push({
          category: 'ongoing_task',
          factKey: `task_${normalizeMemorySlug(task).slice(0, 36)}`,
          value: task,
          searchKeywords: buildMemoryKeywords(`task project কাজ কাজকর্ম ${task}`),
        });
        break;
      }
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
  const lower = normalizeIndicDigits(String(userText || '')).trim().toLowerCase();
  if (!lower) return false;
  if (parseHistoricalDateRange(lower) !== null) {
    const historicalVerb =
      lower.includes('বলেছিলাম') ||
      lower.includes('কথা') ||
      lower.includes('আলোচনা') ||
      lower.includes('মনে আছে') ||
      lower.includes('said') ||
      lower.includes('talk') ||
      lower.includes('discuss') ||
      lower.includes('remember') ||
      lower.includes('history') ||
      lower.includes('कहा') ||
      lower.includes('बात') ||
      lower.includes('याद');
    if (historicalVerb) return true;
  }
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
    lower.includes('what did we discuss') ||
    lower.includes('what do you remember') ||
    lower.includes('what do you know about me') ||
    lower.includes('what is my name') ||
    lower.includes('do you remember') ||
    lower.includes('my previous message') ||
    lower.includes('conversation history') ||
    lower.includes('मेरा नाम क्या है') ||
    lower.includes('मैंने पहले क्या कहा') ||
    lower.includes('हमने क्या बात की') ||
    lower.includes('तुम्हें क्या याद है')
  );
}

/**
 * Answers historical / personal memory recall queries STRICTLY from archived records.
 * NEVER invents or guesses historical conversations — explicitly says when no record is found.
 */
export function answerLocalMemoryRecall(
  query: string,
  memories: LocalMemoryRecord[],
  archivedMessages: LocalConversationRecord[],
  language: string = 'bn-BD',
  nowMs: number = Date.now()
): LocalMemoryRecallResult {
  if (!isMemoryRecallQuery(query)) {
    return {
      isMemoryQuery: false,
      handledOffline: false,
      foundEvidence: false,
      replyText: '',
      matchedFacts: [],
      matchedMessages: [],
      dateRangeApplied: null,
    };
  }

  const isBn = language.toLowerCase().startsWith('bn') || /[\u0980-\u09FF]/.test(query);
  const isHi = !isBn && (language.toLowerCase().startsWith('hi') || /[\u0900-\u097F]/.test(query));
  const lower = normalizeIndicDigits(query).toLowerCase();

  if (lower.includes('আমার নাম') || lower.includes('my name') || lower.includes('मेरा नाम')) {
    const nameFact = memories.find((m) => m.factKey === 'user_name' && m.status !== 'superseded');
    if (nameFact) {
      return {
        isMemoryQuery: true,
        handledOffline: true,
        foundEvidence: true,
        replyText: isBn
          ? `আপনার নাম ${nameFact.value}।`
          : isHi
          ? `आपका नाम ${nameFact.value} है।`
          : `Your name is ${nameFact.value}.`,
        matchedFacts: [nameFact],
        matchedMessages: [],
        dateRangeApplied: null,
      };
    }
    return {
      isMemoryQuery: true,
      handledOffline: true,
      foundEvidence: false,
      replyText: isBn
        ? 'লোকাল আর্কাইভে আপনার নাম এখনো সংরক্ষিত নেই।'
        : isHi
        ? 'लोकल मेमोरी में आपका नाम अभी सेव नहीं है।'
        : 'Your name is not saved in the local archive yet.',
      matchedFacts: [],
      matchedMessages: [],
      dateRangeApplied: null,
    };
  }

  const dateRange = parseHistoricalDateRange(query, nowMs);
  const tokens = tokenizeQuery(query);
  const topics = detectSemanticTopics(query);
  const isBroadOverviewQuery =
    !dateRange && tokens.length === 0 && topics.length === 0;

  const rankedMemories = memories
    .filter(
      (m) =>
        m.userApproved &&
        m.status !== 'superseded' &&
        m.value.trim().length > 0 &&
        !containsSensitiveSecret(m.value)
    )
    .map((rec) => {
      const hay = `${rec.value} ${rec.searchKeywords} ${rec.category}`.toLowerCase();
      const hits = tokens.filter((t) => hay.includes(t)).length;
      const topicHits = topics.filter((t) => hay.includes(t) || detectSemanticTopics(rec.value).includes(t)).length;
      const score = hits * 24 + topicHits * 16 + (isBroadOverviewQuery ? Math.min(rec.usageCount, 10) : 0);
      return { rec, score };
    })
    .filter((x) => (isBroadOverviewQuery ? x.score >= 0 : x.score > 0))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((x) => x.rec);

  const priorMessages = archivedMessages
    .filter(
      (m) =>
        !containsSensitiveSecret(m.text) &&
        m.text.trim().toLowerCase() !== query.trim().toLowerCase()
    )
    .sort((a, b) => b.createdAtMs - a.createdAtMs);

  let matchedMessages: LocalConversationRecord[] = [];
  if (isBroadOverviewQuery) {
    matchedMessages = priorMessages.filter((m) => m.role === 'user').slice(0, 3);
    if (matchedMessages.length === 0) {
      matchedMessages = priorMessages.slice(0, 3);
    }
  } else {
    matchedMessages = priorMessages
      .map((m) => ({ m, score: scoreConversationMatch(query, m, dateRange) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || b.m.createdAtMs - a.m.createdAtMs)
      .slice(0, 4)
      .map((x) => x.m);
  }

  // Strict honesty: if a date range or specific query matched nothing, NEVER guess or fall back!
  if ((dateRange && matchedMessages.length === 0) || (rankedMemories.length === 0 && matchedMessages.length === 0)) {
    const rangeHint = dateRange ? ` (${dateRange.label})` : '';
    return {
      isMemoryQuery: true,
      handledOffline: true,
      foundEvidence: false,
      replyText: isBn
        ? `দুঃখিত, লোকাল আর্কাইভে${rangeHint} এই বিষয়ে কোনো সংরক্ষিত কথোপকথন খুঁজে পাওয়া যায়নি।`
        : isHi
        ? `माफ़ कीजिए, लोकल आर्काइव में${rangeHint} इस विषय पर कोई सेव की गई बातचीत नहीं मिली।`
        : `I could not find any saved conversation matching that query${rangeHint} in your local archive.`,
      matchedFacts: [],
      matchedMessages: [],
      dateRangeApplied: dateRange,
    };
  }

  const parts: string[] = [];
  if (rankedMemories.length > 0 && !dateRange) {
    const summary = rankedMemories.map((m) => m.value).join('; ');
    parts.push(
      isBn
        ? `লোকাল মেমোরিতে যা মনে আছে: ${summary}।`
        : isHi
        ? `लोकल मेमोरी में सेव जानकारी: ${summary}।`
        : `From local memory: ${summary}.`
    );
  }
  if (matchedMessages.length > 0) {
    const top = matchedMessages[0];
    const dateStr = top.dateBucket || formatUtcDateBucket(top.createdAtMs);
    const snippet = top.text.slice(0, 140);
    parts.push(
      isBn
        ? `[${dateStr}] আগে আপনি বলেছিলেন: "${snippet}"।`
        : isHi
        ? `[${dateStr}] पहले आपने कहा था: "${snippet}"।`
        : `[${dateStr}] Earlier you said: "${snippet}".`
    );
  }

  return {
    isMemoryQuery: true,
    handledOffline: true,
    foundEvidence: true,
    replyText: parts.join(' '),
    matchedFacts: rankedMemories,
    matchedMessages,
    dateRangeApplied: dateRange,
  };
}

export function buildCompactContextForGemini(
  query: string,
  memories: LocalMemoryRecord[],
  archivedMessages: LocalConversationRecord[],
  maxChars: number = MAX_COMPACT_CONTEXT_CHARS,
  nowMs: number = Date.now()
): string {
  const tokens = tokenizeQuery(query);
  const dateRange = parseHistoricalDateRange(query, nowMs);
  const priorityMap: Record<LocalMemoryCategory, number> = {
    personal_fact: 10,
    ongoing_task: 9,
    language: 8,
    preference: 6,
    frequent_command: 3,
    context: 2,
  };

  const topMemories = memories
    .filter(
      (m) =>
        m.userApproved &&
        m.status !== 'superseded' &&
        m.value.trim().length > 0 &&
        !containsSensitiveSecret(m.value)
    )
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

  // If the query references history/date/topic, prioritize relevant historical archive records BEFORE recent turns
  const historicalHits =
    dateRange || tokens.length > 0
      ? archivedMessages
          .filter((m) => !containsSensitiveSecret(m.text))
          .map((m) => ({ m, score: scoreConversationMatch(query, m, dateRange) }))
          .filter((x) => x.score > 0)
          .sort((a, b) => b.score - a.score || b.m.createdAtMs - a.m.createdAtMs)
          .slice(0, 3)
          .map((x) => x.m)
      : [];

  const chosenMessages =
    historicalHits.length > 0
      ? historicalHits
      : archivedMessages
          .filter((m) => !containsSensitiveSecret(m.text))
          .sort((a, b) => b.createdAtMs - a.createdAtMs)
          .slice(0, 3)
          .reverse();

  if (chosenMessages.length > 0) {
    const tag = historicalHits.length > 0 ? '[ArchiveHits]' : '[Recent]';
    lines.push(
      `${tag} ${chosenMessages
        .map((m) => `${m.dateBucket || formatUtcDateBucket(m.createdAtMs)} ${m.role}:${m.text.slice(0, 60)}`)
        .join(' / ')}`
    );
  }

  const combined = lines.join('\n').trim();
  return combined.length <= maxChars ? combined : combined.slice(0, maxChars).trimEnd();
}

/**
 * Pure paginated search helper usable over any archive array (browser IndexedDB, tests, or memory store).
 * Never mutates the archive.
 */
export function queryPaginatedArchiveRecords(
  allRecords: LocalConversationRecord[],
  params: PaginatedArchiveSearchParams = {}
): PaginatedArchiveSearchResult {
  const limit = Math.max(1, Math.min(200, params.limit ?? 40));
  const offset = Math.max(0, params.offset ?? 0);
  const query = String(params.query || '').trim();
  const dateBucket = String(params.dateBucket || '').trim();
  const inputType = params.inputType || '';
  const nowMs = params.nowMs ?? Date.now();

  let dateRange: HistoricalDateRange | null = null;
  if (params.startMs && params.endMs && params.endMs >= params.startMs) {
    dateRange = {
      startMs: params.startMs,
      endMs: params.endMs,
      label: `${formatUtcDateBucket(params.startMs)} to ${formatUtcDateBucket(params.endMs)}`,
    };
  } else if (query) {
    dateRange = parseHistoricalDateRange(query, nowMs);
  }

  const filtered = allRecords.filter((rec) => {
    if (containsSensitiveSecret(rec.text)) return false;
    if (inputType && (rec.inputType || 'text') !== inputType) return false;
    if (dateBucket && (rec.dateBucket || formatUtcDateBucket(rec.createdAtMs)) !== dateBucket) {
      return false;
    }
    if (dateRange && (rec.createdAtMs < dateRange.startMs || rec.createdAtMs > dateRange.endMs)) {
      return false;
    }
    return true;
  });

  let ranked: LocalConversationRecord[];
  if (query) {
    ranked = filtered
      .map((rec) => ({ rec, score: scoreConversationMatch(query, rec, dateRange) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || b.rec.createdAtMs - a.rec.createdAtMs)
      .map((x) => x.rec);
  } else {
    ranked = [...filtered].sort((a, b) => b.createdAtMs - a.createdAtMs);
  }

  const page = ranked.slice(offset, offset + limit);
  return {
    messages: page,
    totalMatched: ranked.length,
    hasMore: offset + page.length < ranked.length,
    dateRangeApplied: dateRange,
  };
}

export function buildDateBucketsFromRecords(
  records: LocalConversationRecord[],
  limit: number = 90,
  offset: number = 0
): ConversationDateBucketSummary[] {
  const map = new Map<string, ConversationDateBucketSummary>();
  for (const r of records) {
    const bucket = r.dateBucket || formatUtcDateBucket(r.createdAtMs);
    const existing = map.get(bucket);
    if (!existing) {
      map.set(bucket, {
        dateBucket: bucket,
        messageCount: 1,
        firstTimestampMs: r.createdAtMs,
        lastTimestampMs: r.createdAtMs,
      });
    } else {
      existing.messageCount += 1;
      existing.firstTimestampMs = Math.min(existing.firstTimestampMs, r.createdAtMs);
      existing.lastTimestampMs = Math.max(existing.lastTimestampMs, r.createdAtMs);
    }
  }
  return Array.from(map.values())
    .sort((a, b) => (a.dateBucket < b.dateBucket ? 1 : a.dateBucket > b.dateBucket ? -1 : 0))
    .slice(offset, offset + limit);
}

/**
 * Applies a user correction to a structured long-term memory entry while recording
 * previous values in `correctionHistoryJson` and keeping the original verbatim conversation archive intact.
 */
export function applyMemoryCorrection(
  memories: LocalMemoryRecord[],
  factKey: string,
  newValue: string,
  sourceConversationId: string = '',
  sourceMessageId: string = '',
  nowMs: number = Date.now()
): LocalMemoryRecord[] {
  const safeVal = sanitizeForLocalStorage(newValue);
  if (!safeVal) return memories;

  const next = [...memories];
  const idx = next.findIndex((m) => m.factKey === factKey);
  if (idx >= 0) {
    const existing = next[idx];
    let historyArr: Array<{ previousValue: string; correctedAtMs: number; sourceMessageId: string }> = [];
    try {
      const parsed = JSON.parse(existing.correctionHistoryJson || '[]');
      if (Array.isArray(parsed)) historyArr = parsed;
    } catch {
      historyArr = [];
    }
    historyArr.push({
      previousValue: existing.value,
      correctedAtMs: nowMs,
      sourceMessageId,
    });
    next[idx] = {
      ...existing,
      value: safeVal,
      searchKeywords: buildMemoryKeywords(`${existing.factKey} ${safeVal}`),
      updatedAtMs: nowMs,
      sourceConversationId: sourceConversationId || existing.sourceConversationId,
      sourceMessageId: sourceMessageId || existing.sourceMessageId,
      status: 'corrected',
      correctionHistoryJson: JSON.stringify(historyArr),
    };
  } else {
    next.push({
      id: `mem_${nowMs}_${Math.random().toString(36).slice(2, 7)}`,
      category: 'personal_fact',
      factKey,
      value: safeVal,
      searchKeywords: buildMemoryKeywords(`${factKey} ${safeVal}`),
      usageCount: 1,
      userApproved: true,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
      sourceConversationId,
      sourceMessageId,
      status: 'corrected',
      correctionHistoryJson: '[]',
    });
  }
  return next;
}

// --- Web IndexedDB Permanent Store + Sync Cache Mirror ---

let webStoreInstance: PermanentMemoryStore | null = null;
let cachedWebConversations: PermanentConversationRecord[] | null = null;
let cachedWebMemories: PermanentMemoryRecord[] | null = null;
let webHydrationPromise: Promise<void> | null = null;

function getWebPermanentStore(): PermanentMemoryStore | null {
  if (typeof indexedDB === 'undefined') return null;
  if (!webStoreInstance) {
    webStoreInstance = new PermanentMemoryStore(new IndexedDbArchiveBackend());
  }
  return webStoreInstance;
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

function writeLocalJsonSafe(key: string, value: unknown): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // IndexedDB holds the permanent unlimited archive; ignore localStorage quota overflow gracefully
  }
}

function toPermanentConversation(rec: LocalConversationRecord): PermanentConversationRecord {
  const ts = Number(rec.createdAtMs) > 0 ? rec.createdAtMs : Date.now();
  return {
    id: rec.id,
    conversationId: rec.conversationId || 'default',
    role: rec.role === 'assistant' ? 'assistant' : 'user',
    text: rec.text,
    language: rec.language || 'bn-BD',
    createdAtMs: ts,
    inputType: rec.inputType === 'voice' ? 'voice' : 'text',
    commandName: rec.commandName || '',
    executionStatus: rec.executionStatus || '',
    dateBucket: rec.dateBucket || formatUtcDateBucket(ts),
    searchTokens: rec.searchTokens || buildIndexedSearchTokens(rec.text),
  };
}

function toPermanentMemory(rec: LocalMemoryRecord): PermanentMemoryRecord {
  const createdAtMs = Number(rec.createdAtMs) > 0 ? rec.createdAtMs : Date.now();
  const updatedAtMs = Number(rec.updatedAtMs) > 0 ? rec.updatedAtMs : createdAtMs;
  return {
    id: rec.id,
    category: rec.category,
    factKey: rec.factKey,
    value: rec.value,
    searchKeywords: rec.searchKeywords,
    usageCount: Math.max(1, Number(rec.usageCount) || 1),
    userApproved: rec.userApproved !== false,
    createdAtMs,
    updatedAtMs,
    sourceConversationId: rec.sourceConversationId || '',
    sourceMessageId: rec.sourceMessageId || '',
    status: rec.status || 'active',
    correctionHistoryJson: rec.correctionHistoryJson || '[]',
  };
}

function getSyncWebConversations(): PermanentConversationRecord[] {
  if (cachedWebConversations !== null) return cachedWebConversations;
  const legacy = readLocalJson<LocalConversationRecord[]>(STORAGE_KEY_HISTORY, []);
  return legacy.map(toPermanentConversation);
}

function getSyncWebMemories(): PermanentMemoryRecord[] {
  if (cachedWebMemories !== null) return cachedWebMemories;
  const legacy = readLocalJson<LocalMemoryRecord[]>(STORAGE_KEY_MEMORIES, []);
  return legacy.map(toPermanentMemory);
}

/**
 * Hydrates the Web IndexedDB permanent archive on startup, performs one-time non-destructive
 * migration from legacy v2 localStorage rows, and flushes any pending recovery writes.
 */
export async function hydrateWebPermanentArchiveCache(): Promise<void> {
  if (webHydrationPromise) return webHydrationPromise;
  webHydrationPromise = (async () => {
    const store = getWebPermanentStore();
    if (!store) return;

    try {
      const migratedFlag =
        typeof window !== 'undefined' && window.localStorage
          ? window.localStorage.getItem(STORAGE_KEY_MIGRATED_V3)
          : '1';
      if (!migratedFlag) {
        const legacyConvs = readLocalJson<LocalConversationRecord[]>(STORAGE_KEY_HISTORY, []);
        const legacyMems = readLocalJson<LocalMemoryRecord[]>(STORAGE_KEY_MEMORIES, []);
        if (legacyConvs.length > 0 || legacyMems.length > 0) {
          const upgraded = migrateV2ToV3Archive(legacyConvs, legacyMems, buildIndexedSearchTokens);
          await store.bulkImport(upgraded.conversations, upgraded.memories, false);
        }
        if (typeof window !== 'undefined' && window.localStorage) {
          window.localStorage.setItem(STORAGE_KEY_MIGRATED_V3, '1');
        }
      }

      await store.recoverPendingWrites(containsSensitiveSecret);
      cachedWebConversations = await store.getAllConversations();
      cachedWebMemories = await store.getAllMemories();
    } catch {
      // Keep localStorage fallback cache if IndexedDB is blocked in private mode
    }
  })();
  return webHydrationPromise;
}

export interface PersistConversationOptions {
  id?: string;
  conversationId?: string;
  role: 'user' | 'assistant';
  text: string;
  language?: string;
  createdAtMs?: number;
  inputType?: 'voice' | 'text';
  commandName?: string;
  executionStatus?: string;
}

/**
 * Transactional, read-back verified permanent conversation write.
 * Delegates to Android Room v3 + Keystore on APK, or permanent IndexedDB on Web.
 * NEVER auto-deletes or truncates older conversations.
 */
export async function persistVerifiedConversationRecord(
  options: PersistConversationOptions
): Promise<WriteVerificationResult> {
  const safeText = sanitizeForLocalStorage(options.text);
  const msgId = options.id || `conv_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const convId = options.conversationId || 'default';

  if (!safeText) {
    return {
      success: false,
      verified: false,
      messageId: msgId,
      conversationId: convId,
      errorCode: containsSensitiveSecret(options.text) ? 'SENSITIVE_BLOCKED' : 'EMPTY_TEXT',
      errorMessage: containsSensitiveSecret(options.text)
        ? 'Sensitive credential/secret blocked from permanent storage.'
        : 'Empty message skipped.',
      queuedForRecovery: false,
    };
  }

  const ts = options.createdAtMs && options.createdAtMs > 0 ? options.createdAtMs : Date.now();
  const lang = options.language || 'bn-BD';
  const inputType = options.inputType === 'voice' ? 'voice' : 'text';

  // 1. Native Android APK Room v3 path
  const nativeRes = saveLocalConversationRecordViaNativeBridge({
    id: msgId,
    conversationId: convId,
    role: options.role,
    text: safeText,
    language: lang,
    createdAtMs: ts,
    inputType,
    commandName: options.commandName || '',
    executionStatus: options.executionStatus || '',
  });
  if (nativeRes !== null) return nativeRes;

  // 2. Web permanent IndexedDB + unlimited memory cache path (ZERO truncation)
  await hydrateWebPermanentArchiveCache();
  const record: PermanentConversationRecord = {
    id: msgId,
    conversationId: convId,
    role: options.role,
    text: safeText,
    language: lang,
    createdAtMs: ts,
    inputType,
    commandName: options.commandName || '',
    executionStatus: options.executionStatus || '',
    dateBucket: formatUtcDateBucket(ts),
    searchTokens: buildIndexedSearchTokens(safeText),
  };

  const store = getWebPermanentStore();
  let result: WriteVerificationResult;
  if (store) {
    result = await store.saveConversationVerified(record, containsSensitiveSecret);
    if (result.verified) {
      const current = cachedWebConversations ?? [];
      const existingIdx = current.findIndex((c) => c.id === record.id);
      if (existingIdx >= 0) {
        current[existingIdx] = record;
      } else {
        current.push(record);
      }
      cachedWebConversations = current;
    }
  } else {
    const history = getSyncWebConversations();
    const existingIdx = history.findIndex((c) => c.id === record.id);
    if (existingIdx >= 0) {
      history[existingIdx] = record;
    } else {
      history.push(record);
    }
    cachedWebConversations = history;
    writeLocalJsonSafe(STORAGE_KEY_HISTORY, history);
    result = {
      success: true,
      verified: true,
      messageId: record.id,
      conversationId: record.conversationId,
      errorCode: '',
      errorMessage: '',
      queuedForRecovery: false,
    };
  }

  // Extract linked structured memories from user messages (never replaces original archive)
  if (options.role === 'user' && result.verified) {
    const facts = extractUserMemoryFacts(safeText);
    if (facts.length > 0) {
      const existing = [...getSyncWebMemories()];
      for (const fact of facts) {
        const idx = existing.findIndex((m) => m.factKey === fact.factKey);
        let updatedMem: PermanentMemoryRecord;
        if (idx >= 0) {
          updatedMem = {
            ...existing[idx],
            category: fact.category,
            value: fact.value,
            searchKeywords: fact.searchKeywords,
            usageCount: existing[idx].usageCount + 1,
            updatedAtMs: ts,
            sourceConversationId: convId,
            sourceMessageId: msgId,
            status: 'active',
          };
          existing[idx] = updatedMem;
        } else {
          updatedMem = {
            id: `mem_${ts}_${Math.random().toString(36).slice(2, 7)}`,
            category: fact.category,
            factKey: fact.factKey,
            value: fact.value,
            searchKeywords: fact.searchKeywords,
            usageCount: 1,
            userApproved: true,
            createdAtMs: ts,
            updatedAtMs: ts,
            sourceConversationId: convId,
            sourceMessageId: msgId,
            status: 'active',
            correctionHistoryJson: '[]',
          };
          existing.push(updatedMem);
        }
        if (store) {
          await store.upsertMemory(updatedMem).catch(() => {});
        }
      }
      cachedWebMemories = existing;
      writeLocalJsonSafe(STORAGE_KEY_MEMORIES, existing);
    }
  }

  return result;
}

/**
 * Backward-compatible synchronous helper (kept for existing callers; fires verified permanent write
 * without ever truncating old history).
 */
export function persistLocalConversationTurn(
  role: 'user' | 'assistant',
  text: string,
  language: string = 'bn-BD',
  meta?: {
    id?: string;
    conversationId?: string;
    inputType?: 'voice' | 'text';
    commandName?: string;
    executionStatus?: string;
    createdAtMs?: number;
  }
): boolean {
  const safeText = sanitizeForLocalStorage(text);
  if (!safeText) return false;

  const nativeRes = saveLocalConversationRecordViaNativeBridge({
    id: meta?.id,
    conversationId: meta?.conversationId || 'default',
    role,
    text: safeText,
    language,
    createdAtMs: meta?.createdAtMs,
    inputType: meta?.inputType || 'text',
    commandName: meta?.commandName || '',
    executionStatus: meta?.executionStatus || '',
  });
  if (nativeRes !== null) return nativeRes.success;

  // Fire-and-forget verified IndexedDB write while updating in-memory cache immediately
  void persistVerifiedConversationRecord({
    id: meta?.id,
    conversationId: meta?.conversationId || 'default',
    role,
    text: safeText,
    language,
    createdAtMs: meta?.createdAtMs,
    inputType: meta?.inputType || 'text',
    commandName: meta?.commandName || '',
    executionStatus: meta?.executionStatus || '',
  });

  return true;
}

export function loadLocalConversationHistory(
  limit: number = 60,
  offset: number = 0
): LocalConversationRecord[] {
  const nativeRows = getLocalConversationHistoryViaNativeBridge(limit, offset);
  if (nativeRows !== null) return nativeRows;
  const history = [...getSyncWebConversations()].sort((a, b) => a.createdAtMs - b.createdAtMs);
  if (offset <= 0) {
    return history.slice(-limit);
  }
  const end = Math.max(0, history.length - offset);
  const start = Math.max(0, end - limit);
  return history.slice(start, end);
}

export async function searchPermanentConversationArchive(
  params: PaginatedArchiveSearchParams = {}
): Promise<PaginatedArchiveSearchResult> {
  const nativeRes = searchLocalConversationsViaNativeBridge({
    query: params.query,
    dateBucket: params.dateBucket,
    startMs: params.startMs,
    endMs: params.endMs,
    inputType: params.inputType,
    limit: params.limit ?? 40,
    offset: params.offset ?? 0,
  });
  if (nativeRes !== null) {
    return {
      messages: nativeRes.messages,
      totalMatched: nativeRes.count,
      hasMore: nativeRes.hasMore,
      dateRangeApplied: nativeRes.dateRangeLabel
        ? {
            startMs: params.startMs || 0,
            endMs: params.endMs || 0,
            label: nativeRes.dateRangeLabel,
          }
        : null,
    };
  }

  await hydrateWebPermanentArchiveCache();
  return queryPaginatedArchiveRecords(getSyncWebConversations(), params);
}

export async function getPermanentConversationDates(
  limit: number = 90,
  offset: number = 0
): Promise<ConversationDateBucketSummary[]> {
  const nativeDates = getLocalConversationDatesViaNativeBridge(limit, offset);
  if (nativeDates !== null) return nativeDates;

  await hydrateWebPermanentArchiveCache();
  return buildDateBucketsFromRecords(getSyncWebConversations(), limit, offset);
}

export async function exportPermanentEncryptedBackup(
  passphrase: string
): Promise<BackupExportResult> {
  const nativeExport = exportEncryptedBackupViaNativeBridge(passphrase);
  if (nativeExport !== null) return nativeExport;

  await hydrateWebPermanentArchiveCache();
  const conversations = getSyncWebConversations();
  const memories = getSyncWebMemories();
  return encryptPermanentBackup(
    {
      formatVersion: 1,
      exportedAtMs: Date.now(),
      conversations,
      memories,
    },
    passphrase,
    containsSensitiveSecret
  );
}

export async function restorePermanentEncryptedBackup(
  encryptedArchiveJson: string,
  passphrase: string,
  replaceExisting: boolean = false
): Promise<BackupRestoreResult> {
  const nativeRestore = restoreEncryptedBackupViaNativeBridge(
    encryptedArchiveJson,
    passphrase,
    replaceExisting
  );
  if (nativeRestore !== null) return nativeRestore;

  await hydrateWebPermanentArchiveCache();
  const { payload, error } = await decryptPermanentBackup(
    encryptedArchiveJson,
    passphrase,
    buildIndexedSearchTokens
  );
  if (!payload) {
    return {
      success: false,
      restoredMessages: 0,
      restoredMemories: 0,
      skippedSensitive: 0,
      error: error || 'Backup decryption failed.',
    };
  }

  let skippedSensitive = 0;
  const safeConvs = payload.conversations.filter((c) => {
    if (containsSensitiveSecret(c.text)) {
      skippedSensitive++;
      return false;
    }
    return true;
  });
  const safeMems = payload.memories.filter((m) => {
    if (containsSensitiveSecret(m.value)) {
      skippedSensitive++;
      return false;
    }
    return true;
  });

  const store = getWebPermanentStore();
  if (store) {
    await store.bulkImport(safeConvs, safeMems, replaceExisting);
    cachedWebConversations = await store.getAllConversations();
    cachedWebMemories = await store.getAllMemories();
  } else {
    const convMap = new Map<string, PermanentConversationRecord>();
    if (!replaceExisting) {
      for (const existing of getSyncWebConversations()) convMap.set(existing.id, existing);
    }
    for (const c of safeConvs) convMap.set(c.id, c);

    const memMap = new Map<string, PermanentMemoryRecord>();
    if (!replaceExisting) {
      for (const existing of getSyncWebMemories()) memMap.set(existing.factKey, existing);
    }
    for (const m of safeMems) memMap.set(m.factKey, m);

    cachedWebConversations = Array.from(convMap.values());
    cachedWebMemories = Array.from(memMap.values());
    writeLocalJsonSafe(STORAGE_KEY_HISTORY, cachedWebConversations);
    writeLocalJsonSafe(STORAGE_KEY_MEMORIES, cachedWebMemories);
  }

  return {
    success: true,
    restoredMessages: safeConvs.length,
    restoredMemories: safeMems.length,
    skippedSensitive,
    error: '',
  };
}

export async function getPermanentStorageHealth(): Promise<PermanentStorageHealth> {
  const nativeHealth = getDatabaseHealthViaNativeBridge();
  if (nativeHealth !== null) {
    return {
      ...nativeHealth,
      storageEngine: 'android_room_keystore',
    };
  }

  await hydrateWebPermanentArchiveCache();
  const store = getWebPermanentStore();
  if (store) {
    return store.getHealth();
  }
  return {
    healthy: true,
    integrityStatus: 'ok',
    lowStorage: false,
    availableBytes: -1,
    pendingRecoveryCount: 0,
    totalConversations: getSyncWebConversations().length,
    totalMemories: getSyncWebMemories().length,
    encryptedAtRest: false,
    storageEngine: 'memory_snapshot',
    lastWriteError: '',
  };
}

export async function recoverPermanentPendingWrites(): Promise<number> {
  const nativeCount = recoverPendingWritesViaNativeBridge();
  if (nativeCount !== null) return nativeCount;

  await hydrateWebPermanentArchiveCache();
  const store = getWebPermanentStore();
  if (!store) return 0;
  const recovered = await store.recoverPendingWrites(containsSensitiveSecret);
  if (recovered > 0) {
    cachedWebConversations = await store.getAllConversations();
  }
  return recovered;
}

export function tryOfflineLocalMemoryRecall(
  query: string,
  language: string = 'bn-BD'
): LocalMemoryRecallResult {
  const nativeRes = recallLocalMemoryViaNativeBridge(query, language);
  if (nativeRes !== null) {
    return {
      isMemoryQuery: nativeRes.isMemoryQuery,
      handledOffline: nativeRes.handledOffline,
      foundEvidence: nativeRes.foundEvidence ?? true,
      replyText: nativeRes.replyText,
      matchedFacts: [],
      matchedMessages: [],
      dateRangeApplied: null,
    };
  }
  const memories = getSyncWebMemories();
  const history = getSyncWebConversations();
  return answerLocalMemoryRecall(query, memories, history, language);
}

export function getCompactLocalMemoryContext(query: string): string {
  const nativeCtx = buildCompactMemoryContextViaNativeBridge(query);
  if (nativeCtx !== null) return nativeCtx;
  const memories = getSyncWebMemories();
  const history = getSyncWebConversations();
  return buildCompactContextForGemini(query, memories, history);
}

export function clearAllLocalConversationHistory(): boolean {
  const nativeOk = clearLocalConversationHistoryViaNativeBridge();
  cachedWebConversations = [];
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.removeItem(STORAGE_KEY_HISTORY);
  }
  const store = getWebPermanentStore();
  if (store) {
    void store.clearConversations().catch(() => {});
  }
  return nativeOk !== null ? nativeOk : true;
}

export function clearAllLocalLongTermMemory(): boolean {
  const nativeOk = clearLocalLongTermMemoryViaNativeBridge();
  cachedWebMemories = [];
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.removeItem(STORAGE_KEY_MEMORIES);
  }
  const store = getWebPermanentStore();
  if (store) {
    void store.clearMemories().catch(() => {});
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
  return {
    conversationCount: getSyncWebConversations().length,
    memoryCount: getSyncWebMemories().length,
    encryptedAtRest: false,
  };
}
