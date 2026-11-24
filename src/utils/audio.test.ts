import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FastEndOfSpeechDetector,
  computePcmRms,
  resampleFloat32Pcm,
} from './audio';

test('resampleFloat32Pcm downsamples Android 48kHz and 44.1kHz mic frames cleanly to exact 16kHz', () => {
  const src48k = new Float32Array(2048);
  for (let i = 0; i < src48k.length; i++) {
    src48k[i] = Math.sin((2 * Math.PI * 440 * i) / 48000);
  }
  const resampled48 = resampleFloat32Pcm(src48k, 48000, 16000);
  assert.equal(resampled48.length, Math.round(2048 / 3));
  assert.ok(computePcmRms(resampled48) > 0.6);

  const src44k = new Float32Array(2048);
  for (let i = 0; i < src44k.length; i++) {
    src44k[i] = Math.sin((2 * Math.PI * 440 * i) / 44100);
  }
  const resampled44 = resampleFloat32Pcm(src44k, 44100, 16000);
  assert.equal(resampled44.length, Math.round(2048 / (44100 / 16000)));

  // Already 16kHz returns original buffer unchanged
  const src16k = new Float32Array(1024);
  assert.strictEqual(resampleFloat32Pcm(src16k, 16000, 16000), src16k);
});

test('FastEndOfSpeechDetector ignores steady room noise and fires audioStreamEnd once right after speech ends', () => {
  const detector = new FastEndOfSpeechDetector({
    minSpeechRms: 0.015,
    minSpeechMs: 120,
    silenceEndMs: 360,
  });

  // Steady room fan noise (RMS 0.008) should NEVER trigger speech or audioStreamEnd
  for (let i = 0; i < 15; i++) {
    const res = detector.processFrame(0.008, 64, false);
    assert.equal(res.shouldSignalAudioStreamEnd, false);
  }

  // User speaks (~256ms of clear speech at RMS 0.12)
  for (let i = 0; i < 4; i++) {
    const res = detector.processFrame(0.12, 64, false);
    assert.equal(res.isSpeech, true);
    assert.equal(res.shouldSignalAudioStreamEnd, false);
  }

  // User finishes speaking -> 6 frames * 64ms = 384ms >= 360ms -> fires ONCE
  let endSignals = 0;
  for (let i = 0; i < 10; i++) {
    const res = detector.processFrame(0.006, 64, false);
    if (res.shouldSignalAudioStreamEnd) endSignals += 1;
  }
  assert.equal(endSignals, 1);

  // While assistant is speaking, detector must stay reset and never emit spurious audioStreamEnd
  detector.processFrame(0.2, 64, true);
  for (let i = 0; i < 10; i++) {
    const res = detector.processFrame(0.004, 64, false);
    assert.equal(res.shouldSignalAudioStreamEnd, false);
  }
});
