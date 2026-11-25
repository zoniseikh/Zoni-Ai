import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_COMPACT_CONTEXT_CHARS,
  answerLocalMemoryRecall,
  buildCompactContextForGemini,
  containsSensitiveSecret,
  extractUserMemoryFacts,
  isMemoryRecallQuery,
  sanitizeForLocalStorage,
  type LocalConversationRecord,
  type LocalMemoryRecord,
} from './localMemory';
import { buildStructuredTaskPlan } from './taskExecutionEngine';
import {
  buildZoniSystemInstruction,
  shouldDropLiveAudioForBackpressure,
} from './geminiDirectClient';

test('Issue 04: Privacy filter strictly blocks passwords, OTPs, PINs, card numbers, and API keys', () => {
  assert.equal(containsSensitiveSecret('My OTP is 482910'), true);
  assert.equal(containsSensitiveSecret('আমার বিকাশ পিন 12345'), true);
  assert.equal(containsSensitiveSecret('password is supersecret'), true);
  assert.equal(containsSensitiveSecret('4532 1234 5678 9012'), true);
  assert.equal(containsSensitiveSecret('AIzaSyA1234567890abcdefXYZ'), true);
  assert.equal(sanitizeForLocalStorage('My OTP is 987654'), null);
  assert.equal(sanitizeForLocalStorage('আমার নাম রহিম'), 'আমার নাম রহিম');
});

test('Issue 04: Extracts deduplicated personal facts, preferences, and language without sensitive leaks', () => {
  const nameFacts = extractUserMemoryFacts('আমার নাম তানভীর।');
  assert.ok(nameFacts.some((f) => f.factKey === 'user_name' && f.value === 'তানভীর'));

  const noteFacts = extractUserMemoryFacts('মনে রাখো যে আমার মিটিং বিকাল ৫টায়।');
  assert.equal(noteFacts.length, 1);
  assert.ok(noteFacts[0].value.includes('মিটিং'));

  const secretFacts = extractUserMemoryFacts('মনে রাখো আমার পাসওয়ার্ড 998877');
  assert.equal(secretFacts.length, 0);
});

test('Issue 04: Offline local memory recall answers Bengali and English queries locally', () => {
  const memories: LocalMemoryRecord[] = [
    {
      id: 'm1',
      category: 'personal_fact',
      factKey: 'user_name',
      value: 'রহিম',
      searchKeywords: 'name নাম user_name রহিম',
      usageCount: 2,
      userApproved: true,
      createdAtMs: 1000,
      updatedAtMs: 2000,
    },
    {
      id: 'm2',
      category: 'preference',
      factKey: 'pref_coffee',
      value: 'black coffee',
      searchKeywords: 'preference coffee',
      usageCount: 1,
      userApproved: true,
      createdAtMs: 1500,
      updatedAtMs: 2500,
    },
  ];
  const history: LocalConversationRecord[] = [
    {
      id: 'c1',
      role: 'user',
      text: 'আগামীকাল সকাল ৯টায় ডাক্তারের অ্যাপয়েন্টমেন্ট আছে',
      language: 'bn-BD',
      createdAtMs: 3000,
    },
  ];

  assert.equal(isMemoryRecallQuery('আমার নাম কী?'), true);
  const nameRecall = answerLocalMemoryRecall('আমার নাম কী?', memories, history, 'bn-BD');
  assert.equal(nameRecall.handledOffline, true);
  assert.ok(nameRecall.replyText.includes('রহিম'));

  const prevRecall = answerLocalMemoryRecall('আগে কী বলেছিলাম?', memories, history, 'bn-BD');
  assert.equal(prevRecall.handledOffline, true);
  assert.ok(prevRecall.replyText.includes('ডাক্তারের অ্যাপয়েন্টমেন্ট'));
});

test('Issue 04: Compact Gemini context stays strictly bounded and excludes secrets', () => {
  const memories: LocalMemoryRecord[] = [
    {
      id: 'm1',
      category: 'personal_fact',
      factKey: 'user_name',
      value: 'Zoni Boss',
      searchKeywords: 'name zoni',
      usageCount: 5,
      userApproved: true,
      createdAtMs: 1000,
      updatedAtMs: 2000,
    },
    {
      id: 'm2',
      category: 'personal_fact',
      factKey: 'bad',
      value: 'My OTP is 123456',
      searchKeywords: 'otp',
      usageCount: 1,
      userApproved: true,
      createdAtMs: 1000,
      updatedAtMs: 2000,
    },
  ];
  const longHistory: LocalConversationRecord[] = Array.from({ length: 30 }, (_, i) => ({
    id: `c${i}`,
    role: i % 2 === 0 ? 'user' : 'assistant',
    text: `Conversation turn number ${i} with some extra text content`,
    language: 'en-US',
    createdAtMs: 1000 + i * 100,
  }));

  const compact = buildCompactContextForGemini('hello', memories, longHistory);
  assert.ok(compact.length <= MAX_COMPACT_CONTEXT_CHARS);
  assert.ok(compact.includes('Zoni Boss'));
  assert.equal(compact.includes('123456'), false);

  const sysPrompt = buildZoniSystemInstruction('romantic', 'Boss', undefined, 'bn-BD', compact);
  assert.ok(sysPrompt.includes('COMPACT LOCAL USER MEMORY'));
  assert.ok(sysPrompt.includes('Zoni Boss'));
});

test('Issue 02, 03, 05: Bengali WhatsApp-first messaging, spatial button click, and image open parsing', () => {
  const waPlan = buildStructuredTaskPlan('জোনি, WhatsApp-এ রহিমকে মেসেজ পাঠাও: আমি আজ বিকেলে আসব।');
  assert.equal(waPlan.steps.length, 1);
  assert.equal(waPlan.steps[0]?.tool, 'whatsapp_prepare');
  assert.equal(waPlan.steps[0]?.args.contactQuery, 'রহিম');
  assert.equal(waPlan.steps[0]?.args.message, 'আমি আজ বিকেলে আসব');

  const waBnAppPlan = buildStructuredTaskPlan('জোনি, হোয়াটসঅ্যাপে করিমকে মেসেজ পাঠাও: ভালো আছো?');
  assert.equal(waBnAppPlan.steps[0]?.tool, 'whatsapp_prepare');
  assert.equal(waBnAppPlan.steps[0]?.args.contactQuery, 'করিম');

  const spatialBtn = buildStructuredTaskPlan('জোনি, ডান পাশের বাটনে ক্লিক করো');
  assert.equal(spatialBtn.steps[0]?.tool, 'accessibility_action');
  assert.ok(String(spatialBtn.steps[0]?.args.command || '').includes('ডান পাশের'));

  const imgOpen = buildStructuredTaskPlan('এই ছবিটা ওপেন করো');
  assert.equal(imgOpen.steps[0]?.tool, 'accessibility_action');
  assert.ok(String(imgOpen.steps[0]?.args.command || '').includes('ছবি'));
});

test('Issue 06: Low-internet WebSocket audio backpressure drops congested frames earlier on weak networks', () => {
  assert.equal(shouldDropLiveAudioForBackpressure(40_000, true), false);
  assert.equal(shouldDropLiveAudioForBackpressure(70_000, true), true);
  assert.equal(shouldDropLiveAudioForBackpressure(70_000, false), false);
  assert.equal(shouldDropLiveAudioForBackpressure(180_000, false), true);
});
