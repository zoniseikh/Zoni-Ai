import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ALL_VOICE_LIFECYCLE_STATES,
  DEFAULT_WAKE_WORD_CONFIG,
  WAKE_RESPONSE_PHRASE_BN,
  deriveVoiceLifecycleState,
  evaluateWakeWordCandidate,
  isStopCommandModePhrase,
  stripWakePhraseFromCommand,
} from './voiceLifecycle.ts';

test('WakeWordMatcher activates on Zoni in English, Bengali, and Hindi', () => {
  const en = evaluateWakeWordCandidate('Zoni', 0.92);
  assert.equal(en.matched, true);
  assert.equal(en.remainingCommand, '');

  const bn = evaluateWakeWordCandidate('জোনি', 0.9);
  assert.equal(bn.matched, true);
  assert.equal(bn.remainingCommand, '');

  const bnWithCmd = evaluateWakeWordCandidate('জোনি, ইউটিউব খোলো', 0.9);
  assert.equal(bnWithCmd.matched, true);
  assert.equal(bnWithCmd.remainingCommand, 'ইউটিউব খোলো');

  const hi = evaluateWakeWordCandidate('ज़ोनी', 0.9);
  assert.equal(hi.matched, true);

  const heyEn = evaluateWakeWordCandidate('Hey Zoni, open WhatsApp', 0.9);
  assert.equal(heyEn.matched, true);
  assert.equal(heyEn.remainingCommand, 'open whatsapp');
});

test('WakeWordMatcher strictly rejects unrelated and similar-sounding speech (false-activation prevention)', () => {
  const unrelatedAndConfusable = [
    'Hello how are you today',
    'Open YouTube please',
    'আজকের আবহাওয়া কেমন আছে',
    'মাকে ফোন করো',
    'Please turn on the flashlight',
    'Receive the call',
    'johnny',
    'johny',
    'soni',
    'sooni',
    'zone',
    'tony',
    'sony',
    'pony',
    'sunny',
    'honey',
    'money',
    'funny',
    'bonnie',
    'ronnie',
    'Hey Johnny open YouTube',
    'Sony TV price',
  ];
  for (const sample of unrelatedAndConfusable) {
    const res = evaluateWakeWordCandidate(sample, 0.99);
    assert.equal(res.matched, false, `Should reject unrelated/similar speech: ${sample}`);
    assert.equal(res.rejectedReason, 'wake_phrase_not_present');
  }
});

test('WakeWordMatcher enforces confidence threshold and duplicate-trigger cooldown', () => {
  const lowConf = evaluateWakeWordCandidate('zonie', 0.35, DEFAULT_WAKE_WORD_CONFIG, 0, 10000);
  assert.equal(lowConf.matched, false);
  assert.equal(lowConf.rejectedReason, 'below_confidence_threshold');

  const cooled = evaluateWakeWordCandidate('Zoni', 0.95, DEFAULT_WAKE_WORD_CONFIG, 10000, 11000);
  assert.equal(cooled.matched, false);
  assert.equal(cooled.rejectedReason, 'cooldown_active');

  const afterCooldown = evaluateWakeWordCandidate(
    'Zoni',
    0.95,
    DEFAULT_WAKE_WORD_CONFIG,
    10000,
    13000
  );
  assert.equal(afterCooldown.matched, true);
});

test('WakeWordMatcher strips wake phrase so wake word alone is never treated as a command', () => {
  assert.equal(stripWakePhraseFromCommand('Zoni'), '');
  assert.equal(stripWakePhraseFromCommand('জোনি'), '');
  assert.equal(stripWakePhraseFromCommand('Zoni, open YouTube'), 'open youtube');
});

test('WakeWordMatcher supports future custom configurable wake phrase', () => {
  const customCfg = { wakePhrase: 'Jarvis', confidenceThreshold: 0.72, cooldownMs: 2500 };
  assert.equal(evaluateWakeWordCandidate('Jarvis', 0.9, customCfg).matched, true);
  assert.equal(evaluateWakeWordCandidate('Zoni', 0.9, customCfg).matched, false);
});

test('Background Command Mode wake response constant and stop-phrase detection', () => {
  assert.equal(WAKE_RESPONSE_PHRASE_BN, 'হ্যাঁ, বলো শুনছি।');

  const validStopPhrases = [
    'ধন্যবাদ জোনি',
    'ধন্যবাদ জোনি।',
    'অনেক ধন্যবাদ জোনি',
    'ঠিক আছে ধন্যবাদ জনি',
    'Stop Listening',
    'stop listening zoni',
    'Please stop listening',
    'Thank you Zoni',
    'শোনা বন্ধ করো',
    'কমান্ড মোড বন্ধ করো',
    'धन्यवाद ज़ोनी',
  ];
  for (const phrase of validStopPhrases) {
    assert.equal(isStopCommandModePhrase(phrase), true, `Expected stop phrase: ${phrase}`);
  }

  const nonStopCommands = [
    '',
    'Stop the video',
    'Stop music',
    'ভিডিওটি স্টপ করো',
    'টর্চ বন্ধ করো',
    'ইউটিউব খোলো',
    'রহিমকে কল করো',
    'Thank you for sending the message to Rahim',
  ];
  for (const cmd of nonStopCommands) {
    assert.equal(isStopCommandModePhrase(cmd), false, `Should NOT stop command mode: ${cmd}`);
  }
});

test('VoiceLifecycleState contains all 13 required states and never fakes CONNECTED', () => {
  assert.equal(ALL_VOICE_LIFECYCLE_STATES.length, 13);
  const notConnected = deriveVoiceLifecycleState({
    wsStatus: 'disconnected',
    assistantState: 'listening',
    isLiveActive: true,
  });
  assert.equal(notConnected, 'CONNECTING');

  const connectedListening = deriveVoiceLifecycleState({
    wsStatus: 'connected',
    assistantState: 'listening',
    isLiveActive: true,
  });
  assert.equal(connectedListening, 'LISTENING');

  const wakeArmed = deriveVoiceLifecycleState({
    wsStatus: 'disconnected',
    assistantState: 'idle',
    isLiveActive: false,
    wakeWordStatus: {
      wakeWordEnabled: true,
      backgroundServiceRunning: true,
      listening: true,
      backgroundCommandMode: false,
      wakePhrase: 'Zoni',
      voiceState: 'WAKE_WORD_LISTENING',
      micPermissionGranted: true,
      notificationPermissionGranted: true,
      detectorEngine: 'on_device_two_stage_acoustic_gate',
      lastDetectedAtMs: 0,
      lastConfidence: 0,
      lastError: '',
    },
  });
  assert.equal(wakeArmed, 'WAKE_WORD_LISTENING');

  const bgCommandListening = deriveVoiceLifecycleState({
    wsStatus: 'disconnected',
    assistantState: 'idle',
    isLiveActive: false,
    wakeWordStatus: {
      wakeWordEnabled: true,
      backgroundServiceRunning: true,
      listening: false,
      backgroundCommandMode: true,
      wakePhrase: 'Zoni',
      voiceState: 'LISTENING',
      micPermissionGranted: true,
      notificationPermissionGranted: true,
      detectorEngine: 'on_device_two_stage_acoustic_gate',
      lastDetectedAtMs: 12345,
      lastConfidence: 0.94,
      lastError: '',
    },
  });
  assert.equal(bgCommandListening, 'LISTENING');

  const bgCommandSpeaking = deriveVoiceLifecycleState({
    wsStatus: 'disconnected',
    assistantState: 'idle',
    isLiveActive: false,
    wakeWordStatus: {
      wakeWordEnabled: true,
      backgroundServiceRunning: true,
      listening: false,
      backgroundCommandMode: true,
      wakePhrase: 'Zoni',
      voiceState: 'SPEAKING',
      micPermissionGranted: true,
      notificationPermissionGranted: true,
      detectorEngine: 'on_device_two_stage_acoustic_gate',
      lastDetectedAtMs: 12345,
      lastConfidence: 0.94,
      lastError: '',
    },
  });
  assert.equal(bgCommandSpeaking, 'SPEAKING');
});
