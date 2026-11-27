/**
 * Cross-Platform Permanent Conversation Memory Storage & Encrypted Backup Crypto
 *
 * 1. Wire-compatible with Android Kotlin `PermanentMemoryBackupCrypto` (`zoni_permanent_backup_v1`):
 *    - PBKDF2-HMAC-SHA256 (120,000 iterations, 16-byte salt)
 *    - AES-256-GCM authenticated encryption (12-byte IV, 128-bit auth tag)
 *    - Backups exported on Android APK can be decrypted/restored in Web and vice versa.
 *
 * 2. Permanent local archive store (`PermanentMemoryStore`):
 *    - ZERO automatic deletion or 200/500-message truncation.
 *    - IndexedDB-backed in browsers (`zoni_permanent_memory_db`) so tens of thousands of messages
 *      persist reliably without localStorage's small quota limit.
 *    - Non-destructive v2 -> v3 schema migration preserves every legacy record.
 *    - Verified writes with automatic recovery spool on storage failure.
 */

export const BACKUP_FORMAT_TAG = 'zoni_permanent_backup_v1';
export const BACKUP_KDF_NAME = 'PBKDF2-SHA256';
export const BACKUP_CIPHER_NAME = 'AES-256-GCM';
export const BACKUP_DEFAULT_ITERATIONS = 120_000;
export const BACKUP_MIN_PASSPHRASE_LENGTH = 8;

export interface PermanentConversationRecord {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  text: string;
  language: string;
  createdAtMs: number;
  inputType: 'voice' | 'text';
  commandName: string;
  executionStatus: string;
  dateBucket: string;
  searchTokens: string;
}

export interface PermanentMemoryRecord {
  id: string;
  category: 'language' | 'preference' | 'personal_fact' | 'frequent_command' | 'ongoing_task' | 'context';
  factKey: string;
  value: string;
  searchKeywords: string;
  usageCount: number;
  userApproved: boolean;
  createdAtMs: number;
  updatedAtMs: number;
  sourceConversationId: string;
  sourceMessageId: string;
  status: 'active' | 'corrected' | 'superseded';
  correctionHistoryJson: string;
}

export interface ConversationDateBucketSummary {
  dateBucket: string;
  messageCount: number;
  firstTimestampMs: number;
  lastTimestampMs: number;
}

export interface WriteVerificationResult {
  success: boolean;
  verified: boolean;
  messageId: string;
  conversationId: string;
  errorCode: string;
  errorMessage: string;
  queuedForRecovery: boolean;
}

export interface PermanentStorageHealth {
  healthy: boolean;
  integrityStatus: string;
  lowStorage: boolean;
  availableBytes: number;
  pendingRecoveryCount: number;
  totalConversations: number;
  totalMemories: number;
  encryptedAtRest: boolean;
  storageEngine: 'android_room_keystore' | 'web_indexeddb' | 'memory_snapshot';
  lastWriteError: string;
}

export interface PlainBackupPayload {
  formatVersion: number;
  exportedAtMs: number;
  conversations: PermanentConversationRecord[];
  memories: PermanentMemoryRecord[];
}

export interface BackupExportResult {
  success: boolean;
  encryptedArchiveJson: string;
  messageCount: number;
  memoryCount: number;
  error: string;
}

export interface BackupRestoreResult {
  success: boolean;
  restoredMessages: number;
  restoredMemories: number;
  skippedSensitive: number;
  error: string;
}

export interface LegacyV2ConversationRow {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  language?: string;
  createdAtMs: number;
}

export interface LegacyV2MemoryRow {
  id: string;
  category: string;
  factKey: string;
  value: string;
  searchKeywords?: string;
  usageCount?: number;
  userApproved?: boolean;
  createdAtMs?: number;
  updatedAtMs?: number;
}

export function formatUtcDateBucket(timestampMs: number): string {
  const safeTs = Number.isFinite(timestampMs) && timestampMs > 0 ? timestampMs : Date.now();
  const d = new Date(safeTs);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export function formatLocalDateBucket(timestampMs: number): string {
  const safeTs = Number.isFinite(timestampMs) && timestampMs > 0 ? timestampMs : Date.now();
  const d = new Date(safeTs);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(b64, 'base64'));
  }
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function getWebCrypto(): Crypto {
  if (typeof globalThis !== 'undefined' && globalThis.crypto?.subtle) {
    return globalThis.crypto;
  }
  throw new Error('Web Crypto API (crypto.subtle) is unavailable in this runtime.');
}

async function deriveAesGcmKey(
  passphrase: string,
  salt: Uint8Array,
  iterations: number,
  usage: KeyUsage[]
): Promise<CryptoKey> {
  const cryptoApi = getWebCrypto();
  const enc = new TextEncoder();
  const baseKey = await cryptoApi.subtle.importKey(
    'raw',
    enc.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return cryptoApi.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt as unknown as BufferSource,
      iterations,
      hash: 'SHA-256',
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    usage
  );
}

/**
 * Encrypts conversations + memories using PBKDF2-HMAC-SHA256 + AES-256-GCM.
 * Wire-compatible with Android Kotlin `PermanentMemoryBackupCrypto.decryptBackupPayload`.
 */
export async function encryptPermanentBackup(
  payload: PlainBackupPayload,
  passphrase: string,
  isSensitiveFilter: (text: string) => boolean,
  iterations: number = BACKUP_DEFAULT_ITERATIONS
): Promise<BackupExportResult> {
  const cleanPass = String(passphrase || '').trim();
  if (cleanPass.length < BACKUP_MIN_PASSPHRASE_LENGTH) {
    return {
      success: false,
      encryptedArchiveJson: '',
      messageCount: 0,
      memoryCount: 0,
      error: `Passphrase must be at least ${BACKUP_MIN_PASSPHRASE_LENGTH} characters.`,
    };
  }

  try {
    const safeConversations = payload.conversations.filter((c) => !isSensitiveFilter(c.text));
    const safeMemories = payload.memories.filter((m) => !isSensitiveFilter(m.value));

    const plainObj = {
      formatVersion: payload.formatVersion || 1,
      exportedAtMs: payload.exportedAtMs || Date.now(),
      conversations: safeConversations.map((c) => ({
        id: c.id,
        conversationId: c.conversationId || 'default',
        role: c.role === 'assistant' ? 'assistant' : 'user',
        text: c.text,
        language: c.language || 'bn-BD',
        createdAtMs: c.createdAtMs,
        inputType: c.inputType === 'voice' ? 'voice' : 'text',
        commandName: c.commandName || '',
        executionStatus: c.executionStatus || '',
        dateBucket: c.dateBucket || formatUtcDateBucket(c.createdAtMs),
      })),
      memories: safeMemories.map((m) => ({
        id: m.id,
        category: m.category,
        factKey: m.factKey,
        value: m.value,
        searchKeywords: m.searchKeywords,
        usageCount: m.usageCount,
        userApproved: m.userApproved,
        createdAtMs: m.createdAtMs,
        updatedAtMs: m.updatedAtMs,
        sourceConversationId: m.sourceConversationId || '',
        sourceMessageId: m.sourceMessageId || '',
        status: m.status || 'active',
        correctionHistoryJson: m.correctionHistoryJson || '[]',
      })),
    };

    const cryptoApi = getWebCrypto();
    const salt = new Uint8Array(16);
    const iv = new Uint8Array(12);
    cryptoApi.getRandomValues(salt);
    cryptoApi.getRandomValues(iv);

    const aesKey = await deriveAesGcmKey(cleanPass, salt, iterations, ['encrypt']);
    const plainBytes = new TextEncoder().encode(JSON.stringify(plainObj));
    const cipherBuf = await cryptoApi.subtle.encrypt(
      { name: 'AES-GCM', iv: iv as unknown as BufferSource, tagLength: 128 },
      aesKey,
      plainBytes
    );

    const envelope = {
      format: BACKUP_FORMAT_TAG,
      formatVersion: plainObj.formatVersion,
      kdf: BACKUP_KDF_NAME,
      cipher: BACKUP_CIPHER_NAME,
      iterations,
      saltB64: bytesToBase64(salt),
      ivB64: bytesToBase64(iv),
      ciphertextB64: bytesToBase64(new Uint8Array(cipherBuf)),
      exportedAtMs: plainObj.exportedAtMs,
      messageCount: safeConversations.length,
      memoryCount: safeMemories.length,
    };

    return {
      success: true,
      encryptedArchiveJson: JSON.stringify(envelope, null, 2),
      messageCount: safeConversations.length,
      memoryCount: safeMemories.length,
      error: '',
    };
  } catch (err) {
    return {
      success: false,
      encryptedArchiveJson: '',
      messageCount: 0,
      memoryCount: 0,
      error: `Encrypted backup export failed: ${err instanceof Error ? err.message : 'unknown error'}`,
    };
  }
}

/**
 * Decrypts and authenticates a `zoni_permanent_backup_v1` archive exported from either
 * Android Kotlin or Web.
 */
export async function decryptPermanentBackup(
  encryptedArchiveJson: string,
  passphrase: string,
  tokenBuilder: (text: string) => string
): Promise<{ payload: PlainBackupPayload | null; error: string }> {
  const cleanPass = String(passphrase || '').trim();
  if (!cleanPass) {
    return { payload: null, error: 'Passphrase is required to decrypt the backup.' };
  }
  try {
    const envelope = JSON.parse(encryptedArchiveJson);
    if (!envelope || envelope.format !== BACKUP_FORMAT_TAG) {
      return {
        payload: null,
        error: 'Unrecognized backup format. Expected a ZONI encrypted backup (.zonibak / JSON).',
      };
    }

    const iterations = Math.max(
      10_000,
      Math.min(600_000, Number(envelope.iterations) || BACKUP_DEFAULT_ITERATIONS)
    );
    const salt = base64ToBytes(String(envelope.saltB64 || ''));
    const iv = base64ToBytes(String(envelope.ivB64 || ''));
    const ciphertext = base64ToBytes(String(envelope.ciphertextB64 || ''));
    if (salt.length < 8 || iv.length !== 12 || ciphertext.length <= 16) {
      return { payload: null, error: 'Corrupted backup envelope metadata.' };
    }

    const cryptoApi = getWebCrypto();
    const aesKey = await deriveAesGcmKey(cleanPass, salt, iterations, ['decrypt']);
    let plainBuf: ArrayBuffer;
    try {
      plainBuf = await cryptoApi.subtle.decrypt(
        { name: 'AES-GCM', iv: iv as unknown as BufferSource, tagLength: 128 },
        aesKey,
        ciphertext as unknown as BufferSource
      );
    } catch {
      return {
        payload: null,
        error: 'Incorrect passphrase or corrupted/tampered backup file.',
      };
    }

    const parsed = JSON.parse(new TextDecoder().decode(plainBuf));
    const rawConvs = Array.isArray(parsed?.conversations) ? parsed.conversations : [];
    const conversations: PermanentConversationRecord[] = [];
    for (const item of rawConvs) {
      if (!item || typeof item !== 'object') continue;
      const id = String(item.id || '').trim();
      const text = String(item.text || '').trim();
      if (!id || !text) continue;
      const ts = Number(item.createdAtMs) > 0 ? Number(item.createdAtMs) : Date.now();
      conversations.push({
        id,
        conversationId: String(item.conversationId || 'restored').trim() || 'restored',
        role: item.role === 'assistant' ? 'assistant' : 'user',
        text,
        language: String(item.language || 'bn-BD').trim() || 'bn-BD',
        createdAtMs: ts,
        inputType: item.inputType === 'voice' ? 'voice' : 'text',
        commandName: String(item.commandName || ''),
        executionStatus: String(item.executionStatus || ''),
        dateBucket: String(item.dateBucket || '').trim() || formatUtcDateBucket(ts),
        searchTokens: tokenBuilder(text),
      });
    }

    const rawMems = Array.isArray(parsed?.memories) ? parsed.memories : [];
    const memories: PermanentMemoryRecord[] = [];
    for (const item of rawMems) {
      if (!item || typeof item !== 'object') continue;
      const id = String(item.id || '').trim();
      const factKey = String(item.factKey || '').trim();
      const value = String(item.value || '').trim();
      if (!id || !factKey || !value) continue;
      const createdAtMs = Number(item.createdAtMs) > 0 ? Number(item.createdAtMs) : Date.now();
      const updatedAtMs = Number(item.updatedAtMs) > 0 ? Number(item.updatedAtMs) : createdAtMs;
      memories.push({
        id,
        category: (item.category || 'personal_fact') as PermanentMemoryRecord['category'],
        factKey,
        value,
        searchKeywords: String(item.searchKeywords || tokenBuilder(value)),
        usageCount: Math.max(1, Number(item.usageCount) || 1),
        userApproved: item.userApproved !== false,
        createdAtMs,
        updatedAtMs,
        sourceConversationId: String(item.sourceConversationId || ''),
        sourceMessageId: String(item.sourceMessageId || ''),
        status:
          item.status === 'corrected' || item.status === 'superseded' ? item.status : 'active',
        correctionHistoryJson: String(item.correctionHistoryJson || '[]'),
      });
    }

    return {
      payload: {
        formatVersion: Number(parsed?.formatVersion) || 1,
        exportedAtMs: Number(parsed?.exportedAtMs) || Date.now(),
        conversations,
        memories,
      },
      error: '',
    };
  } catch (err) {
    return {
      payload: null,
      error: `Backup decryption failed: ${err instanceof Error ? err.message : 'invalid archive'}`,
    };
  }
}

/**
 * Non-destructive v2 -> v3 migration helper: upgrades legacy 5-field conversation rows
 * and legacy memory rows without dropping or overwriting a single historical message.
 */
export function migrateV2ToV3Archive(
  legacyConversations: LegacyV2ConversationRow[],
  legacyMemories: LegacyV2MemoryRow[],
  tokenBuilder: (text: string) => string
): {
  conversations: PermanentConversationRecord[];
  memories: PermanentMemoryRecord[];
} {
  const conversations: PermanentConversationRecord[] = legacyConversations
    .filter((c) => c && c.id && c.text)
    .map((c) => {
      const ts = Number(c.createdAtMs) > 0 ? Number(c.createdAtMs) : Date.now();
      return {
        id: String(c.id),
        conversationId: 'legacy_v2',
        role: c.role === 'assistant' ? 'assistant' : 'user',
        text: String(c.text),
        language: String(c.language || 'bn-BD'),
        createdAtMs: ts,
        inputType: 'text',
        commandName: '',
        executionStatus: '',
        dateBucket: formatUtcDateBucket(ts),
        searchTokens: tokenBuilder(String(c.text)),
      };
    });

  const memories: PermanentMemoryRecord[] = legacyMemories
    .filter((m) => m && m.id && m.factKey && m.value)
    .map((m) => {
      const ts = Number(m.createdAtMs) > 0 ? Number(m.createdAtMs) : Date.now();
      return {
        id: String(m.id),
        category: (m.category || 'personal_fact') as PermanentMemoryRecord['category'],
        factKey: String(m.factKey),
        value: String(m.value),
        searchKeywords: String(m.searchKeywords || tokenBuilder(String(m.value))),
        usageCount: Math.max(1, Number(m.usageCount) || 1),
        userApproved: m.userApproved !== false,
        createdAtMs: ts,
        updatedAtMs: Number(m.updatedAtMs) > 0 ? Number(m.updatedAtMs) : ts,
        sourceConversationId: 'legacy_v2',
        sourceMessageId: '',
        status: 'active',
        correctionHistoryJson: '[]',
      };
    });

  return { conversations, memories };
}

// --- Pluggable Permanent Storage Backend (IndexedDB in Browser, Snapshot in Node Tests) ---

export interface PermanentArchiveBackend {
  readonly engine: 'web_indexeddb' | 'memory_snapshot';
  putConversation(record: PermanentConversationRecord): Promise<void>;
  putConversationsBulk(records: PermanentConversationRecord[]): Promise<void>;
  getConversationById(id: string): Promise<PermanentConversationRecord | null>;
  getAllConversations(): Promise<PermanentConversationRecord[]>;
  countConversations(): Promise<number>;
  clearConversations(): Promise<void>;

  putMemory(record: PermanentMemoryRecord): Promise<void>;
  putMemoriesBulk(records: PermanentMemoryRecord[]): Promise<void>;
  getAllMemories(): Promise<PermanentMemoryRecord[]>;
  countMemories(): Promise<number>;
  clearMemories(): Promise<void>;

  appendPendingWrite(record: PermanentConversationRecord): Promise<void>;
  getAllPendingWrites(): Promise<PermanentConversationRecord[]>;
  replacePendingWrites(records: PermanentConversationRecord[]): Promise<void>;
}

const IDB_NAME = 'zoni_permanent_memory_db';
const IDB_VERSION = 3;
const STORE_CONVERSATIONS = 'conversations';
const STORE_MEMORIES = 'memories';
const STORE_PENDING = 'pending_writes';

export class IndexedDbArchiveBackend implements PermanentArchiveBackend {
  readonly engine = 'web_indexeddb' as const;
  private dbPromise: Promise<IDBDatabase> | null = null;

  private openDb(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('IndexedDB unavailable'));
        return;
      }
      const req = indexedDB.open(IDB_NAME, IDB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_CONVERSATIONS)) {
          const convStore = db.createObjectStore(STORE_CONVERSATIONS, { keyPath: 'id' });
          convStore.createIndex('by_createdAtMs', 'createdAtMs', { unique: false });
          convStore.createIndex('by_conversationId', 'conversationId', { unique: false });
          convStore.createIndex('by_dateBucket', 'dateBucket', { unique: false });
          convStore.createIndex('by_inputType', 'inputType', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_MEMORIES)) {
          const memStore = db.createObjectStore(STORE_MEMORIES, { keyPath: 'id' });
          memStore.createIndex('by_factKey', 'factKey', { unique: true });
          memStore.createIndex('by_sourceConversationId', 'sourceConversationId', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_PENDING)) {
          db.createObjectStore(STORE_PENDING, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
    });
    return this.dbPromise;
  }

  private async runTx<T>(
    storeName: string,
    mode: IDBTransactionMode,
    op: (store: IDBObjectStore) => IDBRequest<T>
  ): Promise<T> {
    const db = await this.openDb();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const store = tx.objectStore(storeName);
      const req = op(store);
      let result: T;
      req.onsuccess = () => {
        result = req.result;
      };
      req.onerror = () => reject(req.error || new Error('IndexedDB request failed'));
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
      tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
    });
  }

  async putConversation(record: PermanentConversationRecord): Promise<void> {
    await this.runTx(STORE_CONVERSATIONS, 'readwrite', (s) => s.put(record));
  }

  async putConversationsBulk(records: PermanentConversationRecord[]): Promise<void> {
    if (records.length === 0) return;
    const db = await this.openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_CONVERSATIONS, 'readwrite');
      const store = tx.objectStore(STORE_CONVERSATIONS);
      for (const r of records) {
        store.put(r);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('Bulk conversation put failed'));
    });
  }

  async getConversationById(id: string): Promise<PermanentConversationRecord | null> {
    const row = await this.runTx<PermanentConversationRecord | undefined>(
      STORE_CONVERSATIONS,
      'readonly',
      (s) => s.get(id)
    );
    return row || null;
  }

  async getAllConversations(): Promise<PermanentConversationRecord[]> {
    const rows = await this.runTx<PermanentConversationRecord[]>(
      STORE_CONVERSATIONS,
      'readonly',
      (s) => s.getAll()
    );
    return Array.isArray(rows) ? rows : [];
  }

  async countConversations(): Promise<number> {
    return this.runTx<number>(STORE_CONVERSATIONS, 'readonly', (s) => s.count());
  }

  async clearConversations(): Promise<void> {
    await this.runTx(STORE_CONVERSATIONS, 'readwrite', (s) => s.clear());
  }

  async putMemory(record: PermanentMemoryRecord): Promise<void> {
    await this.runTx(STORE_MEMORIES, 'readwrite', (s) => s.put(record));
  }

  async putMemoriesBulk(records: PermanentMemoryRecord[]): Promise<void> {
    if (records.length === 0) return;
    const db = await this.openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_MEMORIES, 'readwrite');
      const store = tx.objectStore(STORE_MEMORIES);
      for (const r of records) {
        store.put(r);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('Bulk memory put failed'));
    });
  }

  async getAllMemories(): Promise<PermanentMemoryRecord[]> {
    const rows = await this.runTx<PermanentMemoryRecord[]>(STORE_MEMORIES, 'readonly', (s) =>
      s.getAll()
    );
    return Array.isArray(rows) ? rows : [];
  }

  async countMemories(): Promise<number> {
    return this.runTx<number>(STORE_MEMORIES, 'readonly', (s) => s.count());
  }

  async clearMemories(): Promise<void> {
    await this.runTx(STORE_MEMORIES, 'readwrite', (s) => s.clear());
  }

  async appendPendingWrite(record: PermanentConversationRecord): Promise<void> {
    await this.runTx(STORE_PENDING, 'readwrite', (s) => s.put(record));
  }

  async getAllPendingWrites(): Promise<PermanentConversationRecord[]> {
    const rows = await this.runTx<PermanentConversationRecord[]>(STORE_PENDING, 'readonly', (s) =>
      s.getAll()
    );
    return Array.isArray(rows) ? rows : [];
  }

  async replacePendingWrites(records: PermanentConversationRecord[]): Promise<void> {
    const db = await this.openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_PENDING, 'readwrite');
      const store = tx.objectStore(STORE_PENDING);
      store.clear();
      for (const r of records) {
        store.put(r);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('Replace pending writes failed'));
    });
  }
}

/**
 * Pure deterministic snapshot-capable backend for Node.js tests (10,000+ records,
 * process restart persistence via JSON/file snapshot, and simulated DB write failure injection).
 */
export class SnapshotArchiveBackend implements PermanentArchiveBackend {
  readonly engine = 'memory_snapshot' as const;
  private conversations = new Map<string, PermanentConversationRecord>();
  private memories = new Map<string, PermanentMemoryRecord>();
  private pending = new Map<string, PermanentConversationRecord>();
  public simulateWriteFailure: string | null = null;

  constructor(initialSnapshotJson?: string) {
    if (initialSnapshotJson) {
      this.loadSnapshotJson(initialSnapshotJson);
    }
  }

  exportSnapshotJson(): string {
    return JSON.stringify({
      conversations: Array.from(this.conversations.values()),
      memories: Array.from(this.memories.values()),
      pending: Array.from(this.pending.values()),
    });
  }

  loadSnapshotJson(raw: string): void {
    const parsed = JSON.parse(raw);
    this.conversations.clear();
    this.memories.clear();
    this.pending.clear();
    for (const c of Array.isArray(parsed?.conversations) ? parsed.conversations : []) {
      if (c?.id) this.conversations.set(c.id, c);
    }
    for (const m of Array.isArray(parsed?.memories) ? parsed.memories : []) {
      if (m?.factKey) this.memories.set(m.factKey, m);
    }
    for (const p of Array.isArray(parsed?.pending) ? parsed.pending : []) {
      if (p?.id) this.pending.set(p.id, p);
    }
  }

  async putConversation(record: PermanentConversationRecord): Promise<void> {
    if (this.simulateWriteFailure) {
      throw new Error(this.simulateWriteFailure);
    }
    this.conversations.set(record.id, { ...record });
  }

  async putConversationsBulk(records: PermanentConversationRecord[]): Promise<void> {
    if (this.simulateWriteFailure) {
      throw new Error(this.simulateWriteFailure);
    }
    for (const r of records) {
      this.conversations.set(r.id, { ...r });
    }
  }

  async getConversationById(id: string): Promise<PermanentConversationRecord | null> {
    return this.conversations.get(id) || null;
  }

  async getAllConversations(): Promise<PermanentConversationRecord[]> {
    return Array.from(this.conversations.values());
  }

  async countConversations(): Promise<number> {
    return this.conversations.size;
  }

  async clearConversations(): Promise<void> {
    this.conversations.clear();
  }

  async putMemory(record: PermanentMemoryRecord): Promise<void> {
    if (this.simulateWriteFailure) {
      throw new Error(this.simulateWriteFailure);
    }
    this.memories.set(record.factKey, { ...record });
  }

  async putMemoriesBulk(records: PermanentMemoryRecord[]): Promise<void> {
    if (this.simulateWriteFailure) {
      throw new Error(this.simulateWriteFailure);
    }
    for (const r of records) {
      this.memories.set(r.factKey, { ...r });
    }
  }

  async getAllMemories(): Promise<PermanentMemoryRecord[]> {
    return Array.from(this.memories.values());
  }

  async countMemories(): Promise<number> {
    return this.memories.size;
  }

  async clearMemories(): Promise<void> {
    this.memories.clear();
  }

  async appendPendingWrite(record: PermanentConversationRecord): Promise<void> {
    this.pending.set(record.id, { ...record });
  }

  async getAllPendingWrites(): Promise<PermanentConversationRecord[]> {
    return Array.from(this.pending.values());
  }

  async replacePendingWrites(records: PermanentConversationRecord[]): Promise<void> {
    this.pending.clear();
    for (const r of records) {
      this.pending.set(r.id, { ...r });
    }
  }
}

/**
 * Verified, zero-auto-deletion repository wrapper over a `PermanentArchiveBackend`.
 * Performs read-back verification (`getConversationById`) and spools failed writes into
 * `pending_writes` so no finalized message is ever silently dropped.
 */
export class PermanentMemoryStore {
  private lastWriteError = '';
  private fallbackSpool: PermanentConversationRecord[] = [];

  constructor(private readonly backend: PermanentArchiveBackend) {}

  async saveConversationVerified(
    record: PermanentConversationRecord,
    isSensitiveFilter: (text: string) => boolean
  ): Promise<WriteVerificationResult> {
    if (!record.text.trim()) {
      return {
        success: false,
        verified: false,
        messageId: record.id,
        conversationId: record.conversationId,
        errorCode: 'EMPTY_TEXT',
        errorMessage: 'Empty message skipped.',
        queuedForRecovery: false,
      };
    }
    if (isSensitiveFilter(record.text)) {
      return {
        success: false,
        verified: false,
        messageId: record.id,
        conversationId: record.conversationId,
        errorCode: 'SENSITIVE_BLOCKED',
        errorMessage: 'Sensitive credential/secret blocked from permanent storage.',
        queuedForRecovery: false,
      };
    }

    try {
      await this.backend.putConversation(record);
      const readBack = await this.backend.getConversationById(record.id);
      if (!readBack || readBack.id !== record.id) {
        throw new Error('Read-back verification failed after write');
      }
      this.lastWriteError = '';
      return {
        success: true,
        verified: true,
        messageId: record.id,
        conversationId: record.conversationId,
        errorCode: '',
        errorMessage: '',
        queuedForRecovery: false,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Storage write failed';
      this.lastWriteError = msg;
      let queued = false;
      try {
        await this.backend.appendPendingWrite(record);
        queued = true;
      } catch {
        // Secondary in-memory recovery queue if even pending store is unavailable
        if (!this.fallbackSpool.some((x) => x.id === record.id)) {
          this.fallbackSpool.push({ ...record });
        }
        queued = true;
      }
      return {
        success: false,
        verified: false,
        messageId: record.id,
        conversationId: record.conversationId,
        errorCode: 'WRITE_FAILED',
        errorMessage: msg,
        queuedForRecovery: queued,
      };
    }
  }

  async recoverPendingWrites(isSensitiveFilter: (text: string) => boolean): Promise<number> {
    const dbPending = await this.backend.getAllPendingWrites().catch(() => []);
    const mergedMap = new Map<string, PermanentConversationRecord>();
    for (const item of [...dbPending, ...this.fallbackSpool]) {
      mergedMap.set(item.id, item);
    }
    const candidates = Array.from(mergedMap.values()).sort(
      (a, b) => a.createdAtMs - b.createdAtMs
    );
    if (candidates.length === 0) return 0;

    let recovered = 0;
    const stillPending: PermanentConversationRecord[] = [];
    for (const item of candidates) {
      if (isSensitiveFilter(item.text)) continue;
      try {
        await this.backend.putConversation(item);
        const verified = await this.backend.getConversationById(item.id);
        if (verified) {
          recovered++;
        } else {
          stillPending.push(item);
        }
      } catch {
        stillPending.push(item);
      }
    }

    this.fallbackSpool = [];
    try {
      await this.backend.replacePendingWrites(stillPending);
    } catch {
      this.fallbackSpool = stillPending;
    }

    if (recovered > 0 && stillPending.length === 0) {
      this.lastWriteError = '';
    }
    return recovered;
  }

  async upsertMemory(record: PermanentMemoryRecord): Promise<void> {
    await this.backend.putMemory(record);
  }

  async getAllConversations(): Promise<PermanentConversationRecord[]> {
    return this.backend.getAllConversations();
  }

  async getAllMemories(): Promise<PermanentMemoryRecord[]> {
    return this.backend.getAllMemories();
  }

  async bulkImport(
    conversations: PermanentConversationRecord[],
    memories: PermanentMemoryRecord[],
    replaceExisting: boolean
  ): Promise<void> {
    if (replaceExisting) {
      await this.backend.clearConversations();
      await this.backend.clearMemories();
    }
    await this.backend.putConversationsBulk(conversations);
    await this.backend.putMemoriesBulk(memories);
  }

  async clearConversations(): Promise<void> {
    await this.backend.clearConversations();
  }

  async clearMemories(): Promise<void> {
    await this.backend.clearMemories();
  }

  async getHealth(): Promise<PermanentStorageHealth> {
    try {
      const [totalConversations, totalMemories, pendingDb] = await Promise.all([
        this.backend.countConversations(),
        this.backend.countMemories(),
        this.backend.getAllPendingWrites().catch(() => []),
      ]);
      let availableBytes = -1;
      let lowStorage = false;
      if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
        try {
          const est = await navigator.storage.estimate();
          if (typeof est.quota === 'number' && typeof est.usage === 'number') {
            availableBytes = Math.max(0, est.quota - est.usage);
            lowStorage = availableBytes < 20 * 1024 * 1024;
          }
        } catch {
          // ignore estimate failure
        }
      }
      const pendingCount = pendingDb.length + this.fallbackSpool.length;
      return {
        healthy: !this.lastWriteError && pendingCount === 0,
        integrityStatus: 'ok',
        lowStorage,
        availableBytes,
        pendingRecoveryCount: pendingCount,
        totalConversations,
        totalMemories,
        encryptedAtRest: false,
        storageEngine: this.backend.engine,
        lastWriteError: this.lastWriteError,
      };
    } catch (err) {
      return {
        healthy: false,
        integrityStatus: 'error',
        lowStorage: false,
        availableBytes: -1,
        pendingRecoveryCount: this.fallbackSpool.length,
        totalConversations: 0,
        totalMemories: 0,
        encryptedAtRest: false,
        storageEngine: this.backend.engine,
        lastWriteError: err instanceof Error ? err.message : 'Health check failed',
      };
    }
  }
}
