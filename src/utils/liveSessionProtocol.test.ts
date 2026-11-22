import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildClientTextPayload,
  mergeTranscriptChunk,
  extractActionTagFromText,
  upsertAssistantTurnMessage,
  upsertUserSpeechTurnMessage,
  getReconnectDelayMs,
  shouldAutoReconnectLiveWs,
  shouldUseHttpChatFallback,
} from './liveSessionProtocol';
import { ChatMessage } from '../types';

test('buildClientTextPayload rejects empty/whitespace messages and trims valid messages', () => {
  assert.equal(buildClientTextPayload('   '), null);
  const payload = buildClientTextPayload('  কেমন আছো জনি?  ', 'msg-1');
  assert.deepEqual(payload, {
    type: 'client_text',
    text: 'কেমন আছো জনি?',
    clientMsgId: 'msg-1',
  });
});

test('mergeTranscriptChunk deduplicates identical or cumulative chunks within a turn', () => {
  assert.equal(mergeTranscriptChunk('', 'হ্যালো Boss!'), 'হ্যালো Boss!');
  assert.equal(mergeTranscriptChunk('হ্যালো Boss!', 'হ্যালো Boss!'), 'হ্যালো Boss!');
  assert.equal(
    mergeTranscriptChunk('হ্যালো Boss!', 'হ্যালো Boss! আমি ভালো আছি।'),
    'হ্যালো Boss! আমি ভালো আছি।'
  );
  assert.equal(
    mergeTranscriptChunk('হ্যালো Boss!', 'আমি ভালো আছি।'),
    'হ্যালো Boss! আমি ভালো আছি।'
  );
});

test('upsertAssistantTurnMessage updates the same turn bubble and creates a new bubble for a new turn', () => {
  const initial: ChatMessage[] = [
    {
      id: 'user-1',
      role: 'user',
      text: 'আমার নাম রাহুল',
      timestamp: new Date(),
      lang: 'bn-BD',
    },
  ];

  // Part 1 of Turn 1 arrives (e.g. modelTurn text)
  const step1 = upsertAssistantTurnMessage(initial, 'হ্যালো রাহুল!', 1, 'bn-BD');
  assert.equal(step1.messages.length, 2);
  assert.equal(step1.messages[1].text, 'হ্যালো রাহুল!');

  // Duplicate outputTranscription with same text arrives in Turn 1 -> no duplicate message
  const step2 = upsertAssistantTurnMessage(step1.messages, 'হ্যালো রাহুল!', 1, 'bn-BD');
  assert.equal(step2.messages.length, 2);
  assert.equal(step2.messages[1].text, 'হ্যালো রাহুল!');

  // Incremental continuation in Turn 1 -> appends to same assistant bubble
  const step3 = upsertAssistantTurnMessage(step2.messages, 'কেমন আছেন আপনি?', 1, 'bn-BD');
  assert.equal(step3.messages.length, 2);
  assert.equal(step3.messages[1].text, 'হ্যালো রাহুল! কেমন আছেন আপনি?');

  // Turn 2 arrives -> creates a new assistant message
  const step4 = upsertAssistantTurnMessage(step3.messages, 'আমি আপনার কথা মনে রেখেছি।', 2, 'bn-BD');
  assert.equal(step4.messages.length, 3);
  assert.equal(step4.messages[2].text, 'আমি আপনার কথা মনে রেখেছি।');
});

test('upsertUserSpeechTurnMessage maintains chronological order for spoken and typed turns', () => {
  let msgs: ChatMessage[] = [];
  msgs = upsertUserSpeechTurnMessage(msgs, 'হ্যালো জনি', 1, 'bn-BD');
  msgs = upsertUserSpeechTurnMessage(msgs, 'কেমন আছো?', 1, 'bn-BD');
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].role, 'user');
  assert.equal(msgs[0].text, 'হ্যালো জনি কেমন আছো?');

  const afterAssistant = upsertAssistantTurnMessage(msgs, 'আমি খুব ভালো আছি Boss!', 1, 'bn-BD').messages;
  assert.equal(afterAssistant.length, 2);
  assert.equal(afterAssistant[0].role, 'user');
  assert.equal(afterAssistant[1].role, 'assistant');
});

test('extractActionTagFromText parses hardware action tags and cleans visible text', () => {
  const res = extractActionTagFromText('নিশ্চয়ই Boss! [ACTION:FLASHLIGHT:ON]');
  assert.equal(res.cleanText, 'নিশ্চয়ই Boss!');
  assert.ok(res.action);
  assert.equal(res.action?.type, 'flashlight');
  assert.equal(res.action?.target, 'ON');
});

test('getReconnectDelayMs increases exponentially up to maxMs', () => {
  const d0 = getReconnectDelayMs(0, 1000, 10000);
  const d1 = getReconnectDelayMs(1, 1000, 10000);
  const d10 = getReconnectDelayMs(10, 1000, 10000);
  assert.equal(d0, 1000);
  assert.ok(d1 > d0);
  assert.equal(d10, 10000);
});

test('shouldAutoReconnectLiveWs retries recoverable disconnects indefinitely but stops on permanent config errors', () => {
  assert.equal(shouldAutoReconnectLiveWs('GEMINI_KEY_MISSING', false, 0), false);
  assert.equal(shouldAutoReconnectLiveWs('GEMINI_KEY_INVALID', undefined, 0), false);
  assert.equal(shouldAutoReconnectLiveWs('BACKEND_URL_MISSING', undefined, 0), false);
  assert.equal(shouldAutoReconnectLiveWs(undefined, true, 0), true);
  assert.equal(shouldAutoReconnectLiveWs(undefined, true, 100), true);
  assert.equal(shouldAutoReconnectLiveWs(undefined, true, 0, 5), true);
  assert.equal(shouldAutoReconnectLiveWs(undefined, true, 5, 5), false);
});

test('shouldUseHttpChatFallback falls back unless Live WS is both OPEN and server-handshake ready', () => {
  assert.equal(shouldUseHttpChatFallback(1, true, 'connected'), false);
  assert.equal(shouldUseHttpChatFallback(1, false, 'connecting'), true);
  assert.equal(shouldUseHttpChatFallback(0, false, 'connecting'), true);
  assert.equal(shouldUseHttpChatFallback(3, false, 'error'), true);
  assert.equal(shouldUseHttpChatFallback(undefined, false, 'disconnected'), true);
});
