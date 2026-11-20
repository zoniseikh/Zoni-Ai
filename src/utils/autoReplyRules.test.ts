import test from 'node:test';
import assert from 'node:assert/strict';
import { findMatchingAutoReplyRule, AutoReplyConfig } from './autoReplyRules.ts';

const sampleConfig: AutoReplyConfig = {
  enabled: true,
  rules: [
    {
      id: 'r1',
      enabled: true,
      keyword: 'কোথায়',
      senderFilter: '',
      replyText: 'রাস্তায় আছি, ১০ মিনিটে পৌঁছাচ্ছি।',
      whatsappOnly: true,
    },
    {
      id: 'r2',
      enabled: true,
      keyword: 'urgent',
      senderFilter: 'rahul',
      replyText: 'Got it Rahul, calling you right back.',
      whatsappOnly: false,
    },
    {
      id: 'r3',
      enabled: false,
      keyword: 'hello',
      senderFilter: '',
      replyText: 'Hi there!',
      whatsappOnly: false,
    },
  ],
};

test('findMatchingAutoReplyRule never triggers when master switch is off', () => {
  const offConfig: AutoReplyConfig = { ...sampleConfig, enabled: false };
  assert.equal(findMatchingAutoReplyRule(offConfig, 'Mom', 'তুমি কোথায় আছো?', true), null);
});

test('findMatchingAutoReplyRule matches Bengali WhatsApp keyword and enforces whatsappOnly filter', () => {
  const matched = findMatchingAutoReplyRule(sampleConfig, 'Mom', 'তুমি এখন কোথায়?', true);
  assert.equal(matched?.id, 'r1');

  const blockedNonWa = findMatchingAutoReplyRule(sampleConfig, 'Mom', 'তুমি এখন কোথায়?', false);
  assert.equal(blockedNonWa, null);
});

test('findMatchingAutoReplyRule enforces sender filter and skips disabled rules', () => {
  const matchedRahul = findMatchingAutoReplyRule(sampleConfig, 'Rahul Sen', 'Very URGENT work', false);
  assert.equal(matchedRahul?.id, 'r2');

  const wrongSender = findMatchingAutoReplyRule(sampleConfig, 'Amit', 'Very URGENT work', false);
  assert.equal(wrongSender, null);

  const disabledRule = findMatchingAutoReplyRule(sampleConfig, 'Anyone', 'hello there', true);
  assert.equal(disabledRule, null);
});
