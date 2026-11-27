import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  answerLocalMemoryRecall,
  applyMemoryCorrection,
  buildCompactContextForGemini,
  buildDateBucketsFromRecords,
  buildIndexedSearchTokens,
  containsSensitiveSecret,
  extractUserMemoryFacts,
  formatDateBucket,
  isMemoryRecallQuery,
  parseHistoricalDateRange,
  queryPaginatedArchiveRecords,
  type LocalConversationRecord,
  type LocalMemoryRecord,
} from './localMemory';
import {
  BACKUP_FORMAT_TAG,
  PermanentMemoryStore,
  SnapshotArchiveBackend,
  decryptPermanentBackup,
  encryptPermanentBackup,
  migrateV2ToV3Archive,
  type PermanentConversationRecord,
  type PermanentMemoryRecord,
} from './permanentMemoryBackup';

const DAY_MS = 24 * 60 * 60 * 1000;

function makeRecord(
  id: string,
  text: string,
  createdAtMs: number,
  overrides: Partial<PermanentConversationRecord> = {}
): PermanentConversationRecord {
  return {
    id,
    conversationId: overrides.conversationId ?? 'conv_test_1',
    role: overrides.role ?? 'user',
    text,
    language: overrides.language ?? 'bn-BD',
    createdAtMs,
    inputType: overrides.inputType ?? 'voice',
    commandName: overrides.commandName ?? '',
    executionStatus: overrides.executionStatus ?? '',
    dateBucket: overrides.dateBucket ?? formatDateBucket(createdAtMs),
    searchTokens: overrides.searchTokens ?? buildIndexedSearchTokens(text),
  };
}

test('Permanent Memory Req 3 & 10: 15-day, 6-month, and 2-year historical recall in Bengali, Hindi, and English', () => {
  const nowMs = Date.UTC(2026, 10, 26, 12, 0, 0); // 2026-11-26T12:00:00Z
  const fifteenDaysAgo = nowMs - 15 * DAY_MS;
  const sixMonthsAgo = nowMs - 180 * DAY_MS;
  const twoYearsAgo = nowMs - 730 * DAY_MS;

  const archive: LocalConversationRecord[] = [
    makeRecord(
      'msg-15d',
      '১৫ দিন আগে ডাক্তার সেনের চেম্বারে কার্ডিওলজি চেকআপ নিয়ে কথা বলেছিলাম',
      fifteenDaysAgo,
      { language: 'bn-BD', inputType: 'voice' }
    ),
    makeRecord(
      'msg-6m',
      'We planned our Darjeeling train ticket and hotel budget six months ago',
      sixMonthsAgo,
      { language: 'en-US', inputType: 'text' }
    ),
    makeRecord(
      'msg-2y',
      'मैंने दो साल पहले नए ऑफिस प्रोजेक्ट के डेडलाइन के बारे में बताया था',
      twoYearsAgo,
      { language: 'hi-IN', inputType: 'voice' }
    ),
  ];

  // Bengali 15-day recall
  const bnQuery = '১৫ দিন আগে ডাক্তারের ব্যাপারে কী বলেছিলাম?';
  assert.equal(isMemoryRecallQuery(bnQuery), true);
  assert.ok(parseHistoricalDateRange(bnQuery, nowMs));
  const bnRecall = answerLocalMemoryRecall(bnQuery, [], archive, 'bn-BD', nowMs);
  assert.equal(bnRecall.handledOffline, true);
  assert.equal(bnRecall.foundEvidence, true);
  assert.equal(bnRecall.matchedMessages[0]?.id, 'msg-15d');
  assert.ok(bnRecall.replyText.includes('কার্ডিওলজি চেকআপ'));

  // English 6-month recall
  const enQuery = 'What did we talk about 6 months ago regarding Darjeeling travel?';
  const enRecall = answerLocalMemoryRecall(enQuery, [], archive, 'en-US', nowMs);
  assert.equal(enRecall.foundEvidence, true);
  assert.equal(enRecall.matchedMessages[0]?.id, 'msg-6m');
  assert.ok(enRecall.replyText.includes('Darjeeling'));

  // Hindi 2-year recall
  const hiQuery = '2 साल पहले प्रोजेक्ट के बारे में मैंने क्या कहा था?';
  const hiRecall = answerLocalMemoryRecall(hiQuery, [], archive, 'hi-IN', nowMs);
  assert.equal(hiRecall.foundEvidence, true);
  assert.equal(hiRecall.matchedMessages[0]?.id, 'msg-2y');
  assert.ok(hiRecall.replyText.includes('ऑफिस प्रोजेक्ट'));
});

test('Permanent Memory Req 3: Honest recall NEVER invents or guesses missing historical conversations', () => {
  const nowMs = Date.UTC(2026, 10, 26, 12, 0, 0);
  const archive: LocalConversationRecord[] = [
    makeRecord('msg-today', 'আজ সন্ধ্যায় কফি খাব', nowMs - 2 * 60 * 60 * 1000, {
      language: 'bn-BD',
    }),
  ];

  // Ask about 15 days ago when nothing exists there
  const bnMissing = answerLocalMemoryRecall(
    '১৫ দিন আগে কী কথা হয়েছিল?',
    [],
    archive,
    'bn-BD',
    nowMs
  );
  assert.equal(bnMissing.isMemoryQuery, true);
  assert.equal(bnMissing.foundEvidence, false);
  assert.equal(bnMissing.matchedMessages.length, 0);
  assert.ok(bnMissing.replyText.includes('খুঁজে পাওয়া যায়নি'));
  assert.equal(bnMissing.replyText.includes('কফি'), false);

  // Ask about an unrelated topic in English
  const enMissing = answerLocalMemoryRecall(
    'What did we discuss about Mars rover propulsion?',
    [],
    archive,
    'en-US',
    nowMs
  );
  assert.equal(enMissing.foundEvidence, false);
  assert.equal(enMissing.matchedMessages.length, 0);
  assert.ok(enMissing.replyText.toLowerCase().includes('could not find'));
});

test('Permanent Memory Req 1 & 10: Stores 10,500+ messages with ZERO auto-deletion and fast paginated retrieval', async () => {
  const backend = new SnapshotArchiveBackend();
  const store = new PermanentMemoryStore(backend);
  const baseTs = Date.UTC(2025, 0, 1, 9, 0, 0);
  const TOTAL = 10_500;

  const batch: PermanentConversationRecord[] = [];
  for (let i = 0; i < TOTAL; i++) {
    const ts = baseTs + i * 3_600_000; // 1 hour apart across >1 year
    const text =
      i === 0
        ? 'First ever permanent anchor conversation about Kolkata book fair'
        : i === 5_250
        ? 'Mid-archive Bengali milestone: আগামী সপ্তাহে সিমলার ট্রিপ বুক করতে হবে'
        : i === TOTAL - 1
        ? 'Latest message 10499 confirming zero auto deletion'
        : `Archived conversation turn number ${i} in session ${Math.floor(i / 20)}`;
    batch.push(
      makeRecord(`bulk-${i}`, text, ts, {
        conversationId: `conv-${Math.floor(i / 20)}`,
        role: i % 2 === 0 ? 'user' : 'assistant',
        inputType: i % 3 === 0 ? 'voice' : 'text',
        language: i === 5_250 ? 'bn-BD' : 'en-US',
      })
    );
  }

  await store.bulkImport(batch, [], true);
  const health = await store.getHealth();
  assert.equal(health.totalConversations, TOTAL, 'Must retain all 10,500 messages with zero pruning');

  // Verify very first message (#0) is still present and searchable
  const all = await store.getAllConversations();
  const firstSearch = queryPaginatedArchiveRecords(all, {
    query: 'Kolkata book fair',
    limit: 20,
    offset: 0,
  });
  assert.equal(firstSearch.messages[0]?.id, 'bulk-0');

  // Verify Bengali mid-archive message (#5250) is searchable
  const midSearch = queryPaginatedArchiveRecords(all, {
    query: 'সিমলার ট্রিপ',
    limit: 20,
    offset: 0,
  });
  assert.equal(midSearch.messages[0]?.id, 'bulk-5250');

  // Verify pagination pages cleanly without duplicating rows
  const page1 = queryPaginatedArchiveRecords(all, { limit: 40, offset: 0 });
  const page2 = queryPaginatedArchiveRecords(all, { limit: 40, offset: 40 });
  assert.equal(page1.messages.length, 40);
  assert.equal(page1.hasMore, true);
  assert.equal(page2.messages.length, 40);
  assert.equal(page1.messages[0]?.id, 'bulk-10499');
  assert.notEqual(page1.messages[0]?.id, page2.messages[0]?.id);

  // Verify date bucket summary works over 10,500 rows
  const buckets = buildDateBucketsFromRecords(all, 50, 0);
  assert.equal(buckets.length, 50);
  assert.ok(buckets[0].messageCount > 0);
});

test('Permanent Memory Req 5 & 10: Process termination & restart persistence via disk snapshot', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zoni-perm-test-'));
  const snapshotPath = path.join(tmpDir, 'zoni_archive_snapshot.json');

  try {
    // Session 1: write voice + text messages with command metadata & save to disk before exit
    const backend1 = new SnapshotArchiveBackend();
    const store1 = new PermanentMemoryStore(backend1);
    const ts1 = Date.UTC(2026, 10, 10, 14, 30, 0);

    const w1 = await store1.saveConversationVerified(
      makeRecord('voice-1', 'জোনি, বাবাকে কল করো', ts1, {
        conversationId: 'bg_session_99',
        role: 'user',
        inputType: 'voice',
        commandName: 'call_contact',
        executionStatus: 'executed',
      }),
      containsSensitiveSecret
    );
    assert.equal(w1.success, true);
    assert.equal(w1.verified, true);

    const w2 = await store1.saveConversationVerified(
      makeRecord('voice-2', 'বাবাকে কল করা হচ্ছে।', ts1 + 1200, {
        conversationId: 'bg_session_99',
        role: 'assistant',
        inputType: 'voice',
        commandName: 'call_contact',
        executionStatus: 'executed',
      }),
      containsSensitiveSecret
    );
    assert.equal(w2.verified, true);

    // Persist to disk & simulate full process termination
    fs.writeFileSync(snapshotPath, backend1.exportSnapshotJson(), 'utf8');

    // Session 2 (fresh instances after restart)
    const rawDisk = fs.readFileSync(snapshotPath, 'utf8');
    const backend2 = new SnapshotArchiveBackend(rawDisk);
    const store2 = new PermanentMemoryStore(backend2);
    const restored = await store2.getAllConversations();

    assert.equal(restored.length, 2);
    const recoveredUser = restored.find((r) => r.id === 'voice-1');
    assert.ok(recoveredUser);
    assert.equal(recoveredUser.conversationId, 'bg_session_99');
    assert.equal(recoveredUser.inputType, 'voice');
    assert.equal(recoveredUser.commandName, 'call_contact');
    assert.equal(recoveredUser.executionStatus, 'executed');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Permanent Memory Req 7 & 10: Non-destructive v2 -> v3 migration preserves every legacy record', () => {
  const legacyConvs = [
    {
      id: 'legacy-1',
      role: 'user' as const,
      text: 'আমার পুরনো v2 মেসেজ',
      language: 'bn-BD',
      createdAtMs: Date.UTC(2026, 4, 1, 10, 0, 0),
    },
    {
      id: 'legacy-2',
      role: 'assistant' as const,
      text: 'Old v2 reply that must survive migration',
      language: 'en-US',
      createdAtMs: Date.UTC(2026, 4, 1, 10, 1, 0),
    },
  ];
  const legacyMems = [
    {
      id: 'mem-v2-1',
      category: 'personal_fact',
      factKey: 'user_name',
      value: 'রহিম',
      usageCount: 3,
      createdAtMs: Date.UTC(2026, 4, 1, 10, 0, 0),
    },
  ];

  const upgraded = migrateV2ToV3Archive(legacyConvs, legacyMems, buildIndexedSearchTokens);
  assert.equal(upgraded.conversations.length, 2);
  assert.equal(upgraded.conversations[0].dateBucket, '2026-05-01');
  assert.equal(upgraded.conversations[0].conversationId, 'legacy_v2');
  assert.ok(upgraded.conversations[0].searchTokens.includes('পুরনো'));
  assert.equal(upgraded.memories.length, 1);
  assert.equal(upgraded.memories[0].status, 'active');
  assert.equal(upgraded.memories[0].correctionHistoryJson, '[]');
});

test('Permanent Memory Req 7 & 10: Failed DB write is queued in recovery spool and recovered automatically', async () => {
  const backend = new SnapshotArchiveBackend();
  const store = new PermanentMemoryStore(backend);

  // Inject database storage error
  backend.simulateWriteFailure = 'SQLITE_FULL: database or disk is full';
  const rec = makeRecord(
    'fail-rec-1',
    'এই গুরুত্বপূর্ণ ভয়েস মেসেজটি হারানো যাবে না',
    Date.UTC(2026, 10, 26, 10, 0, 0)
  );

  const failedRes = await store.saveConversationVerified(rec, containsSensitiveSecret);
  assert.equal(failedRes.success, false);
  assert.equal(failedRes.verified, false);
  assert.equal(failedRes.errorCode, 'WRITE_FAILED');
  assert.equal(failedRes.queuedForRecovery, true);

  const unhealthy = await store.getHealth();
  assert.equal(unhealthy.healthy, false);
  assert.equal(unhealthy.pendingRecoveryCount, 1);
  assert.equal(unhealthy.totalConversations, 0);

  // Storage recovers -> flush recovery spool
  backend.simulateWriteFailure = null;
  const recoveredCount = await store.recoverPendingWrites(containsSensitiveSecret);
  assert.equal(recoveredCount, 1);

  const healthy = await store.getHealth();
  assert.equal(healthy.healthy, true);
  assert.equal(healthy.pendingRecoveryCount, 0);
  assert.equal(healthy.totalConversations, 1);

  const saved = await backend.getConversationById('fail-rec-1');
  assert.equal(saved?.text, rec.text);
});

test('Permanent Memory Req 4: Structured long-term memory links to source & supports corrections without mutating archive', () => {
  const origMsg = makeRecord(
    'src-msg-1',
    'আমার নাম অমিত। আমি এখন অ্যান্ড্রয়েড অ্যাপ প্রজেক্টে কাজ করছি।',
    Date.UTC(2026, 9, 10, 9, 0, 0),
    { conversationId: 'conv-oct-10' }
  );

  const extracted = extractUserMemoryFacts(origMsg.text);
  assert.ok(extracted.some((f) => f.factKey === 'user_name' && f.value === 'অমিত'));
  assert.ok(extracted.some((f) => f.category === 'ongoing_task'));

  const initialMemories: LocalMemoryRecord[] = [
    {
      id: 'mem-name-1',
      category: 'personal_fact',
      factKey: 'user_name',
      value: 'অমিত',
      searchKeywords: 'name অমিত',
      usageCount: 1,
      userApproved: true,
      createdAtMs: origMsg.createdAtMs,
      updatedAtMs: origMsg.createdAtMs,
      sourceConversationId: origMsg.conversationId,
      sourceMessageId: origMsg.id,
      status: 'active',
      correctionHistoryJson: '[]',
    },
  ];

  // User corrects their name later
  const corrected = applyMemoryCorrection(
    initialMemories,
    'user_name',
    'রাহুল',
    'conv-nov-26',
    'src-msg-2',
    Date.UTC(2026, 10, 26, 11, 0, 0)
  );
  const nameEntry = corrected.find((m) => m.factKey === 'user_name');
  assert.ok(nameEntry);
  assert.equal(nameEntry.value, 'রাহুল');
  assert.equal(nameEntry.status, 'corrected');
  assert.equal(nameEntry.sourceConversationId, 'conv-nov-26');
  assert.equal(nameEntry.sourceMessageId, 'src-msg-2');
  const history = JSON.parse(nameEntry.correctionHistoryJson || '[]');
  assert.equal(history.length, 1);
  assert.equal(history[0].previousValue, 'অমিত');

  // Original verbatim conversation message remains completely unmodified
  assert.ok(origMsg.text.includes('আমার নাম অমিত'));

  // Compact Gemini context reflects corrected memory
  const ctx = buildCompactContextForGemini('আমার নাম কী?', corrected, [origMsg]);
  assert.ok(ctx.includes('রাহুল'));
});

test('Permanent Memory Req 6 & 8: PBKDF2-SHA256 + AES-256-GCM backup round-trip, secret filtering, and tamper rejection', async () => {
  const ts = Date.UTC(2026, 10, 11, 8, 15, 0);
  const conversations: PermanentConversationRecord[] = [
    makeRecord('bk-1', 'আমার বাংলা ভয়েস মেসেজ সংরক্ষণ করো', ts, { inputType: 'voice' }),
    makeRecord('bk-2', 'My OTP is 492817 do not save', ts + 500, { inputType: 'text' }),
    makeRecord('bk-3', 'हिन्दी में मीटिंग नोट सेव किया गया', ts + 1000, { language: 'hi-IN' }),
  ];
  const memories: PermanentMemoryRecord[] = [
    {
      id: 'bm-1',
      category: 'personal_fact',
      factKey: 'user_name',
      value: 'তানভীর',
      searchKeywords: 'name তানভীর',
      usageCount: 4,
      userApproved: true,
      createdAtMs: ts,
      updatedAtMs: ts,
      sourceConversationId: 'conv_test_1',
      sourceMessageId: 'bk-1',
      status: 'active',
      correctionHistoryJson: '[]',
    },
  ];

  // Short passphrase rejected
  const shortRes = await encryptPermanentBackup(
    { formatVersion: 1, exportedAtMs: ts, conversations, memories },
    '1234',
    containsSensitiveSecret,
    10_000
  );
  assert.equal(shortRes.success, false);

  // Valid export strips sensitive OTP message & encrypts payload
  const exported = await encryptPermanentBackup(
    { formatVersion: 1, exportedAtMs: ts, conversations, memories },
    'Zoni-Strong-Passphrase-2026!',
    containsSensitiveSecret,
    10_000
  );
  assert.equal(exported.success, true);
  assert.equal(exported.messageCount, 2, 'Sensitive OTP message must be excluded from backup');
  assert.equal(exported.memoryCount, 1);
  assert.equal(exported.encryptedArchiveJson.includes('বাংলা ভয়েস মেসেজ'), false, 'Ciphertext must not expose plaintext');
  assert.equal(exported.encryptedArchiveJson.includes('492817'), false);

  const envelope = JSON.parse(exported.encryptedArchiveJson);
  assert.equal(envelope.format, BACKUP_FORMAT_TAG);
  assert.equal(envelope.kdf, 'PBKDF2-SHA256');
  assert.equal(envelope.cipher, 'AES-256-GCM');

  // Round-trip decrypt with correct passphrase succeeds
  const decrypted = await decryptPermanentBackup(
    exported.encryptedArchiveJson,
    'Zoni-Strong-Passphrase-2026!',
    buildIndexedSearchTokens
  );
  assert.equal(decrypted.error, '');
  assert.ok(decrypted.payload);
  assert.equal(decrypted.payload.conversations.length, 2);
  assert.equal(decrypted.payload.conversations[0].text, 'আমার বাংলা ভয়েস মেসেজ সংরক্ষণ করো');
  assert.equal(decrypted.payload.conversations[1].text, 'हिन्दी में मीटिंग नोट सेव किया गया');
  assert.equal(decrypted.payload.memories[0].value, 'তানভীর');

  // Wrong passphrase fails authentically
  const wrongPass = await decryptPermanentBackup(
    exported.encryptedArchiveJson,
    'Wrong-Passphrase-9999!',
    buildIndexedSearchTokens
  );
  assert.equal(wrongPass.payload, null);
  assert.ok(wrongPass.error.toLowerCase().includes('incorrect passphrase'));

  // Tampered ciphertext fails GCM authentication
  const tamperedEnvelope = {
    ...envelope,
    ciphertextB64:
      envelope.ciphertextB64.slice(0, -4) +
      (envelope.ciphertextB64.endsWith('AAAA') ? 'BBBB' : 'AAAA'),
  };
  const tamperedRes = await decryptPermanentBackup(
    JSON.stringify(tamperedEnvelope),
    'Zoni-Strong-Passphrase-2026!',
    buildIndexedSearchTokens
  );
  assert.equal(tamperedRes.payload, null);
  assert.ok(tamperedRes.error.length > 0);
});
