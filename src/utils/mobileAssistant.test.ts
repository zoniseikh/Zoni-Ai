import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectAssistantIntent,
  detectLanguageSwitchCommand,
} from './mobileAssistant';

test('detectAssistantIntent parses call intent with phone number', () => {
  const intent = detectAssistantIntent('Call 01712345678');
  assert.ok(intent);
  assert.equal(intent?.type, 'call');
  assert.equal(intent?.target, '01712345678');
});

test('detectAssistantIntent parses all required flashlight ON commands', () => {
  const onCommands = [
    'Flashlight on',
    'Turn on flashlight',
    'Turn on the flashlight',
    'Torch on',
    'টর্চ লাইট জ্বালাও',
    'টর্চ জ্বালিয়ে দাও',
    'ফ্ল্যাশলাইট অন করো',
    'ফ্ল্যাশ লাইট জ্বালাও',
    'লাইট অন করো',
  ];

  for (const cmd of onCommands) {
    const intent = detectAssistantIntent(cmd);
    assert.ok(intent, `Expected intent for "${cmd}"`);
    assert.equal(intent?.type, 'flashlight', `Expected type flashlight for "${cmd}"`);
    assert.equal(intent?.payload, 'on', `Expected payload on for "${cmd}"`);
  }
});

test('detectAssistantIntent parses all required flashlight OFF commands', () => {
  const offCommands = [
    'Flashlight off',
    'Turn off flashlight',
    'Turn off the flashlight',
    'Torch off',
    'টর্চ লাইট বন্ধ করো',
    'টর্চ বন্ধ করে দাও',
    'ফ্ল্যাশলাইট অফ করো',
    'ফ্ল্যাশ লাইট বন্ধ করো',
    'লাইট অফ করো',
  ];

  for (const cmd of offCommands) {
    const intent = detectAssistantIntent(cmd);
    assert.ok(intent, `Expected intent for "${cmd}"`);
    assert.equal(intent?.type, 'flashlight', `Expected type flashlight for "${cmd}"`);
    assert.equal(intent?.payload, 'off', `Expected payload off for "${cmd}"`);
  }
});

test('detectAssistantIntent does not trigger flashlight for negative non-torch light queries', () => {
  const negativeQueries = [
    'The sun gives light',
    'traffic light',
    'লাইট নিয়ে একটা কবিতা বলো',
    'speed of light',
  ];

  for (const query of negativeQueries) {
    const intent = detectAssistantIntent(query);
    assert.notEqual(intent?.type, 'flashlight', `Query "${query}" should not be flashlight intent`);
  }
});

test('detectAssistantIntent parses vibration intent', () => {
  const intent = detectAssistantIntent('vibrate mobile');
  assert.ok(intent);
  assert.equal(intent?.type, 'vibrate');
});

test('detectAssistantIntent parses battery intent', () => {
  const intent = detectAssistantIntent('check battery level');
  assert.ok(intent);
  assert.equal(intent?.type, 'battery');
});

test('detectLanguageSwitchCommand detects Bengali, Hindi, and English triggers', () => {
  const bn = detectLanguageSwitchCommand('বাংলায় কথা বলো', 'Boss');
  assert.ok(bn);
  assert.equal(bn?.lang, 'bn-BD');

  const hi = detectLanguageSwitchCommand('hindi me baat karo', 'Boss');
  assert.ok(hi);
  assert.equal(hi?.lang, 'hi-IN');

  const en = detectLanguageSwitchCommand('speak in english', 'Boss');
  assert.ok(en);
  assert.equal(en?.lang, 'en-US');
});

test('detectAssistantIntent parses app launch intent in English and Bengali', () => {
  const ytEng = detectAssistantIntent('Open YouTube');
  assert.ok(ytEng);
  assert.equal(ytEng?.type, 'app');
  assert.equal(ytEng?.target?.toLowerCase(), 'youtube');

  const camBn = detectAssistantIntent('ক্যামেরা ওপেন করো');
  assert.ok(camBn);
  assert.equal(camBn?.type, 'app');
  assert.equal(camBn?.target, 'ক্যামেরা');
});

test('detectAssistantIntent parses settings intent in English and Bengali', () => {
  const wifi = detectAssistantIntent('open wifi settings');
  assert.ok(wifi);
  assert.equal(wifi?.type, 'settings');

  const bt = detectAssistantIntent('ব্লুটুথ সেটিংস');
  assert.ok(bt);
  assert.equal(bt?.type, 'settings');
});

