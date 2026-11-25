import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NearFieldSpeechGate,
  SpeechHighPassFilter,
  computePcmRms,
  resampleFloat32Pcm,
} from './audio.ts';
import {
  AcousticWakeGate,
  DEFAULT_ACOUSTIC_WAKE_GATE_CONFIG,
  DEFAULT_WAKE_WORD_CONFIG,
  RollingPcmRingBuffer,
  computeMicRecoveryBackoffMs,
  deriveVoiceLifecycleState,
  evaluateWakeWordCandidate,
  shouldAcceptWakeTrigger,
  stripWakePhraseFromCommand,
} from './voiceLifecycle.ts';
import {
  DEFAULT_SPEAKER_VERIFICATION_CONFIG,
  SPEAKER_SAMPLE_RATE,
  buildSpeakerVoiceprint,
  extractSpeakerEmbedding,
  verifySpeakerUtterance,
} from './speakerVerification.ts';
import { VoiceLatencyTracker } from './voiceLatency.ts';
import { detectAssistantIntent } from './mobileAssistant.ts';

/**
 * Deterministic synthetic vocal-tract speech generator (harmonics + formant resonance + optional room noise)
 * for repeatable 16 kHz mono DSP testing without external audio files.
 */
function synthesizeVoicePcmInt16(opts: {
  durationMs: number;
  f0Hz: number;
  formantsHz: [number, number, number];
  amplitude: number; // 0..1
  noiseAmp?: number;
  seed?: number;
}): Int16Array {
  const sampleCount = Math.floor((opts.durationMs * SPEAKER_SAMPLE_RATE) / 1000);
  const out = new Int16Array(sampleCount);
  let rng = (opts.seed ?? 1337) >>> 0;
  const nextRand = () => {
    rng = (1664525 * rng + 1013904223) >>> 0;
    return (rng / 0xffffffff) * 2 - 1;
  };
  const [f1, f2, f3] = opts.formantsHz;
  const noiseAmp = opts.noiseAmp ?? 0;

  for (let i = 0; i < sampleCount; i++) {
    const t = i / SPEAKER_SAMPLE_RATE;
    // Glottal pulse harmonics weighted by vocal-tract formants
    const wave =
      0.42 * Math.sin(2 * Math.PI * opts.f0Hz * t) +
      0.34 * Math.sin(2 * Math.PI * f1 * t) +
      0.22 * Math.sin(2 * Math.PI * f2 * t) +
      0.12 * Math.sin(2 * Math.PI * f3 * t);
    const val = Math.max(-1, Math.min(1, wave * opts.amplitude + nextRand() * noiseAmp));
    out[i] = Math.round(val * 32767);
  }
  return out;
}

function int16ToFloat32(pcm: Int16Array): Float32Array {
  const f = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) f[i] = pcm[i] / 32768;
  return f;
}

function makeNoiseFrameFloat32(samples: number, amp: number, seed: number): Float32Array {
  const out = new Float32Array(samples);
  let rng = seed >>> 0;
  for (let i = 0; i < samples; i++) {
    rng = (1664525 * rng + 1013904223) >>> 0;
    out[i] = ((rng / 0xffffffff) * 2 - 1) * amp;
  }
  return out;
}

// =========================================================================
// SCENARIO 1 & 2: Quiet room saying "Zoni" and "জোনি"
// =========================================================================
test('Scenario 1 & 2: Quiet room wake-word detection for "Zoni" and "জোনি" with 300ms utterance-aligned pre-roll', () => {
  const gate = new AcousticWakeGate(DEFAULT_ACOUSTIC_WAKE_GATE_CONFIG, 16000);
  const ring = new RollingPcmRingBuffer(32000);
  const frameSamples = 320; // 20ms at 16kHz
  const silenceFrame = new Int16Array(frameSamples);

  // Feed 600ms preceding quiet room ambient before wake word
  for (let i = 0; i < 30; i++) {
    ring.write(silenceFrame);
    const a = gate.processPcm16Frame(silenceFrame);
    assert.equal(a.candidateReady, false);
  }

  // Feed 360ms clear "Zoni" / "জোনি" utterance
  const wakeAudio = synthesizeVoicePcmInt16({
    durationMs: 360,
    f0Hz: 145,
    formantsHz: [520, 1450, 2550],
    amplitude: 0.25,
  });
  let readySpanSamples = 0;
  for (let off = 0; off + frameSamples <= wakeAudio.length; off += frameSamples) {
    const slice = wakeAudio.subarray(off, off + frameSamples);
    ring.write(slice);
    const a = gate.processPcm16Frame(slice);
    assert.equal(a.isVoiceFrame, true);
    assert.equal(a.candidateReady, false);
  }

  // Feed 260ms trailing silence -> triggers Stage-1 candidateReady
  for (let i = 0; i < 13; i++) {
    ring.write(silenceFrame);
    const a = gate.processPcm16Frame(silenceFrame);
    if (a.candidateReady) {
      readySpanSamples = a.utteranceSpanSamples;
    }
  }
  assert.ok(readySpanSamples > 0, 'Stage-1 acoustic gate must trigger candidateReady after trailing silence');

  // Utterance-aligned pre-roll slice must include 300ms (4800 samples) + exact utterance span (not the whole 2s ring)
  const preRollSlice = ring.snapshotUtteranceSamples(readySpanSamples, 4800);
  assert.equal(preRollSlice.length, readySpanSamples + 4800);

  // Stage-2 matcher accepts English "Zoni" and Bengali "জোনি" / "জোনী" / "জনি" / "ওহে জোনি"
  for (const phrase of ['Zoni', 'zoni', 'Hey Zoni', 'জোনি', 'জোনী', 'জনি', 'ওহে জোনি', 'এই জোনি']) {
    const res = evaluateWakeWordCandidate(phrase, 0.9, DEFAULT_WAKE_WORD_CONFIG, 0, 50000);
    assert.equal(res.matched, true, `Expected wake word match for "${phrase}"`);
    assert.equal(stripWakePhraseFromCommand(phrase), '', `Bare wake phrase "${phrase}" must strip to empty`);
  }

  const bnCmd = evaluateWakeWordCandidate('জোনি ইউটিউব খোলো', 0.9, DEFAULT_WAKE_WORD_CONFIG, 0, 50000);
  assert.equal(bnCmd.matched, true);
  assert.equal(bnCmd.remainingCommand, 'ইউটিউব খোলো');
});

// =========================================================================
// SCENARIO 3: User speaking while another person talks nearby
// =========================================================================
test('Scenario 3: NearFieldSpeechGate gates distant low-SNR chatter and preserves primary near-field speech with 300ms pre-roll', () => {
  const highPass = new SpeechHighPassFilter();
  const gate = new NearFieldSpeechGate();
  const frameLen = 800; // 50ms at 16kHz

  // 1. Steady room ambient + distant quiet talker (RMS ~0.008) must NOT be transmitted to Gemini Live
  let transmittedAmbient = 0;
  for (let i = 0; i < 14; i++) {
    const distant = int16ToFloat32(
      synthesizeVoicePcmInt16({
        durationMs: 50,
        f0Hz: 210,
        formantsHz: [700, 1800, 2900],
        amplitude: 0.011,
        noiseAmp: 0.002,
        seed: 100 + i,
      })
    );
    const filtered = highPass.process(distant);
    const decision = gate.processFrame(filtered, 50, false);
    if (decision.shouldTransmitCurrentFrame) transmittedAmbient++;
  }
  assert.equal(transmittedAmbient, 0, 'Low-SNR distant ambient chatter should not stream to Gemini Live');

  // 2. Primary near-field user speaks (RMS ~0.18) -> gate flushes 300ms pre-roll + streams speech cleanly
  let preRollFlushedCount = 0;
  let speechFramesSent = 0;
  for (let i = 0; i < 8; i++) {
    const primary = int16ToFloat32(
      synthesizeVoicePcmInt16({
        durationMs: 50,
        f0Hz: 135,
        formantsHz: [500, 1400, 2500],
        amplitude: 0.28,
        seed: 200 + i,
      })
    );
    const filtered = highPass.process(primary);
    const decision = gate.processFrame(filtered, 50, false);
    preRollFlushedCount += decision.preRollFramesToFlush.length;
    if (decision.shouldTransmitCurrentFrame) speechFramesSent++;
  }
  assert.equal(preRollFlushedCount, 6, 'Should flush 6 x 50ms = 300ms pre-roll frames on speech onset');
  assert.equal(speechFramesSent, 8, 'All active primary near-field speech frames must transmit');

  // 3. Post-speech silence (450ms) triggers audio_stream_end exactly once
  let eosCount = 0;
  const quiet = new Float32Array(frameLen);
  for (let i = 0; i < 10; i++) {
    const d = gate.processFrame(quiet, 50, false);
    if (d.shouldSignalAudioStreamEnd) eosCount++;
  }
  assert.equal(eosCount, 1, 'audio_stream_end must fire exactly once after user finishes speaking');
});

// =========================================================================
// SCENARIO 4: Nearby people talking without saying the wake word
// =========================================================================
test('Scenario 4: Nearby conversation without wake word & long monologues produce zero false activations', () => {
  // Stage-1 rejects continuous nearby monologue (> maxUtteranceMs 1450ms)
  const gate = new AcousticWakeGate(DEFAULT_ACOUSTIC_WAKE_GATE_CONFIG, 16000);
  const monologue = synthesizeVoicePcmInt16({
    durationMs: 2200,
    f0Hz: 185,
    formantsHz: [620, 1650, 2750],
    amplitude: 0.24,
  });
  const frameSamples = 320;
  const silence = new Int16Array(frameSamples);
  let falseStage1Triggers = 0;
  for (let off = 0; off + frameSamples <= monologue.length; off += frameSamples) {
    if (gate.processPcm16Frame(monologue.subarray(off, off + frameSamples)).candidateReady) {
      falseStage1Triggers++;
    }
  }
  for (let i = 0; i < 20; i++) {
    if (gate.processPcm16Frame(silence).candidateReady) falseStage1Triggers++;
  }
  assert.equal(falseStage1Triggers, 0, 'Continuous nearby monologue must not trigger Stage-1 wake candidate');

  // Stage-2 strictly rejects unrelated & confusable nearby conversation
  const nearbyPhrases = [
    'আমি আজকে বাজারে যাচ্ছি',
    'তুমি কখন বাসায় ফিরবে',
    'Hey Johnny did you see the match',
    'My Sony TV is working fine',
    'This danger zone is loud',
    'Honey please pass the water',
    'Money transfer complete',
    'Tony called me yesterday',
    'Sunny weather in Kolkata',
  ];
  for (const phrase of nearbyPhrases) {
    const res = evaluateWakeWordCandidate(phrase, 0.98, DEFAULT_WAKE_WORD_CONFIG, 0, 60000);
    assert.equal(res.matched, false, `Must NOT falsely trigger on nearby speech: "${phrase}"`);
  }
});

// =========================================================================
// SCENARIO 5: Assistant speaking while microphone is active (echo + tail guard)
// =========================================================================
test('Scenario 5: Assistant playback audio and 260ms room echo tail are suppressed from triggering user commands', () => {
  const gate = new NearFieldSpeechGate({ echoTailHoldoverMs: 260 });
  const loudPlaybackEcho = int16ToFloat32(
    synthesizeVoicePcmInt16({
      durationMs: 50,
      f0Hz: 220,
      formantsHz: [720, 1850, 2950],
      amplitude: 0.45,
    })
  );

  // While assistant is speaking: 0 frames transmitted, suppressedByPlaybackEcho = true
  for (let i = 0; i < 10; i++) {
    const d = gate.processFrame(loudPlaybackEcho, 50, true);
    assert.equal(d.shouldTransmitCurrentFrame, false);
    assert.equal(d.suppressedByPlaybackEcho, true);
    assert.equal(d.shouldSignalAudioStreamEnd, false);
  }

  // Immediately after playback ends (first 250ms echo tail): still suppressed!
  for (let i = 0; i < 5; i++) {
    const d = gate.processFrame(loudPlaybackEcho, 50, false);
    assert.equal(d.shouldTransmitCurrentFrame, false, `Echo tail frame ${i} must be suppressed`);
    assert.equal(d.suppressedByPlaybackEcho, true);
  }
  // 6th frame (300ms after playback ends) finishes echo tail (remaining 10ms -> 0ms), 7th allows real user speech
  gate.processFrame(loudPlaybackEcho, 50, false);
  const realUserSpeech = gate.processFrame(loudPlaybackEcho, 50, false);
  assert.equal(realUserSpeech.suppressedByPlaybackEcho, false);
  assert.equal(realUserSpeech.shouldTransmitCurrentFrame, true);
});

// =========================================================================
// SCENARIO 6: Softly spoken or slightly distant wake word
// =========================================================================
test('Scenario 6: Soft/distant wake word (RMS ~0.016, 180ms) is reliably captured by tuned AcousticWakeGate', () => {
  const gate = new AcousticWakeGate(DEFAULT_ACOUSTIC_WAKE_GATE_CONFIG, 16000);
  const frameSamples = 320;
  const quietNoise = new Int16Array(frameSamples);

  // Calibrate quiet room floor (~0.004)
  for (let i = 0; i < 20; i++) {
    gate.processPcm16Frame(quietNoise);
  }

  // Softly spoken / slightly distant "Zoni" / "জোনি" (~180ms, amplitude 0.038 -> RMS ~0.017)
  const softWake = synthesizeVoicePcmInt16({
    durationMs: 180,
    f0Hz: 155,
    formantsHz: [540, 1480, 2600],
    amplitude: 0.038,
  });
  const measuredRms = computePcmRms(int16ToFloat32(softWake));
  assert.ok(measuredRms >= 0.014 && measuredRms <= 0.024, `Expected soft RMS 0.014..0.024, got ${measuredRms}`);

  let triggered = false;
  for (let off = 0; off + frameSamples <= softWake.length; off += frameSamples) {
    gate.processPcm16Frame(softWake.subarray(off, off + frameSamples));
  }
  for (let i = 0; i < 14; i++) {
    if (gate.processPcm16Frame(quietNoise).candidateReady) triggered = true;
  }
  assert.equal(triggered, true, 'Softly spoken 180ms wake word must reliably pass Stage-1 acoustic gate');
});

// =========================================================================
// SCENARIO 7: Repeated wake calls & cooldown deduplication
// =========================================================================
test('Scenario 7: Repeated wake calls respect cooldown and prevent overlapping activations', () => {
  const t0 = 100_000;
  const first = evaluateWakeWordCandidate('Zoni', 0.93, DEFAULT_WAKE_WORD_CONFIG, 0, t0);
  assert.equal(first.matched, true);

  // Immediate repeat 500ms later rejected by cooldown
  const repeatSoon = evaluateWakeWordCandidate('Zoni', 0.95, DEFAULT_WAKE_WORD_CONFIG, t0, t0 + 500);
  assert.equal(repeatSoon.matched, false);
  assert.equal(repeatSoon.rejectedReason, 'cooldown_active');

  // Lifecycle guard also rejects triggers while activating/listening/speaking
  assert.equal(shouldAcceptWakeTrigger('ACTIVATING', 0, t0 + 5000), false);
  assert.equal(shouldAcceptWakeTrigger('LISTENING', 0, t0 + 5000), false);
  assert.equal(shouldAcceptWakeTrigger('SPEAKING', 0, t0 + 5000), false);

  // After cooldown expires in WAKE_WORD_LISTENING state, second call succeeds cleanly
  assert.equal(shouldAcceptWakeTrigger('WAKE_WORD_LISTENING', t0, t0 + 3000), true);
  const second = evaluateWakeWordCandidate('জোনি', 0.93, DEFAULT_WAKE_WORD_CONFIG, t0, t0 + 3000);
  assert.equal(second.matched, true);
});

// =========================================================================
// SCENARIO 8 & 9: Mic interruption recovery backoff & background/screen-off lifecycle guards
// =========================================================================
test('Scenario 8 & 9: Mic interruption exponential backoff and background lifecycle state transitions', () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6].map((attempt) => computeMicRecoveryBackoffMs(attempt)),
    [600, 1200, 2500, 4500, 6000, 6000]
  );

  // Background wake-word armed state never fakes CONNECTED while WS is disconnected
  const bgState = deriveVoiceLifecycleState({
    wsStatus: 'disconnected',
    assistantState: 'idle',
    isLiveActive: false,
    wakeWordStatus: {
      wakeWordEnabled: true,
      backgroundServiceRunning: true,
      listening: true,
      wakePhrase: 'Zoni',
      voiceState: 'WAKE_WORD_LISTENING',
      micPermissionGranted: true,
      notificationPermissionGranted: true,
      detectorEngine: 'on_device_two_stage_acoustic_gate',
      recognitionMode: 'on_device_offline',
      lastDetectedAtMs: 0,
      lastConfidence: 0,
      lastError: '',
    },
  });
  assert.equal(bgState, 'WAKE_WORD_LISTENING');

  // Live voice requested before WS opens honestly reports CONNECTING (not CONNECTED)
  assert.equal(
    deriveVoiceLifecycleState({
      wsStatus: 'connecting',
      assistantState: 'listening',
      isLiveActive: true,
    }),
    'CONNECTING'
  );
});

// =========================================================================
// SCENARIO 10: REAL Measured Per-Stage Latency Benchmark (ms)
// =========================================================================
test('Scenario 10: Real measured per-stage pipeline latency in ms (DSP + wake gate + classification + resampling)', () => {
  const tracker = new VoiceLatencyTracker();
  const highPass = new SpeechHighPassFilter();
  const gate = new NearFieldSpeechGate();
  const wakeGate = new AcousticWakeGate();

  const raw48kFrame = makeNoiseFrameFloat32(2400, 0.2, 42); // 50ms at 48kHz
  const wakePcm = synthesizeVoicePcmInt16({
    durationMs: 320,
    f0Hz: 145,
    formantsHz: [520, 1450, 2550],
    amplitude: 0.25,
  });

  // Measure 10 real turns using monotonic performance.now()
  for (let turn = 0; turn < 10; turn++) {
    tracker.beginTurn();

    tracker.markStageStart('mic_capture');
    const pcm16k = resampleFloat32Pcm(raw48kFrame, 48000, 16000);
    tracker.markStageEnd('mic_capture');

    tracker.markStageStart('audio_processing');
    const filtered = highPass.process(pcm16k);
    gate.processFrame(filtered, 50, false);
    tracker.markStageEnd('audio_processing');

    tracker.markStageStart('wake_word_detection');
    wakeGate.processPcm16Frame(wakePcm.subarray(0, 640));
    evaluateWakeWordCandidate('জোনি টর্চ লাইট জ্বালাও', 0.92, DEFAULT_WAKE_WORD_CONFIG, 0, 100000 + turn * 5000);
    tracker.markStageEnd('wake_word_detection');

    tracker.markStageStart('command_classification');
    const intent = detectAssistantIntent('টর্চ লাইট জ্বালাও');
    tracker.markStageEnd('command_classification');

    tracker.markStageStart('action_execution');
    assert.ok(intent !== null, 'Local flashlight command should classify deterministically');
    tracker.markStageEnd('action_execution');

    tracker.finishTurn(true);
  }

  const summary = tracker.getSummary();
  assert.equal(summary.sampleCount, 10);
  assert.ok(summary.averageEndToEndMs >= 0 && summary.averageEndToEndMs < 200);
  console.log(
    '[MEASURED_TS_PIPELINE_LATENCY_MS]',
    JSON.stringify({
      sampleCount: summary.sampleCount,
      averageEndToEndMs: Number(summary.averageEndToEndMs.toFixed(3)),
      averageStageDurationsMs: Object.fromEntries(
        Object.entries(summary.averageStageDurationsMs).map(([k, v]) => [k, Number((v ?? 0).toFixed(3))])
      ),
    })
  );
});

// =========================================================================
// SCENARIO 11: On-Device Speaker Verification FAR, FRR & Safe Fallback
// =========================================================================
test('Scenario 11: Speaker verification enrollment, FAR/FRR evaluation, and guaranteed safe fallback', () => {
  // Primary user vocal profile (e.g. adult male F0 ~122 Hz, formants [460, 1280, 2380])
  const enrollEmbeddings = [
    extractSpeakerEmbedding(
      synthesizeVoicePcmInt16({ durationMs: 600, f0Hz: 120, formantsHz: [450, 1260, 2350], amplitude: 0.25, seed: 1 })
    )!,
    extractSpeakerEmbedding(
      synthesizeVoicePcmInt16({ durationMs: 600, f0Hz: 124, formantsHz: [470, 1300, 2410], amplitude: 0.22, seed: 2 })
    )!,
    extractSpeakerEmbedding(
      synthesizeVoicePcmInt16({ durationMs: 600, f0Hz: 122, formantsHz: [460, 1280, 2380], amplitude: 0.28, seed: 3 })
    )!,
  ];
  assert.ok(enrollEmbeddings.every(Boolean));
  const voiceprint = buildSpeakerVoiceprint(enrollEmbeddings, 3);
  assert.ok(voiceprint !== null);

  const strictConfig = {
    ...DEFAULT_SPEAKER_VERIFICATION_CONFIG,
    enabled: true,
    strictMode: true,
  };

  // Measure FRR across 10 varied primary-user utterances (different loudness, mild room noise, slight pitch drift)
  let primaryTotal = 10;
  let primaryRejected = 0;
  for (let i = 0; i < primaryTotal; i++) {
    const sample = synthesizeVoicePcmInt16({
      durationMs: 500,
      f0Hz: 118 + (i % 5) * 2.5,
      formantsHz: [450 + (i % 3) * 12, 1265 + (i % 4) * 15, 2360 + (i % 3) * 20],
      amplitude: 0.14 + (i % 4) * 0.05,
      noiseAmp: 0.008,
      seed: 300 + i,
    });
    const res = verifySpeakerUtterance(sample, voiceprint, strictConfig);
    if (!res.shouldAllowCommand) primaryRejected++;
  }
  const frr = primaryRejected / primaryTotal;

  // Measure FAR across 10 distinct non-primary speakers (higher pitch & shifted vocal tract formants)
  let impostorTotal = 10;
  let impostorAcceptedStrict = 0;
  for (let i = 0; i < impostorTotal; i++) {
    const impostor = synthesizeVoicePcmInt16({
      durationMs: 500,
      f0Hz: 225 + (i % 5) * 18,
      formantsHz: [780 + (i % 3) * 40, 2050 + (i % 4) * 60, 3250 + (i % 3) * 45],
      amplitude: 0.24,
      noiseAmp: 0.005,
      seed: 500 + i,
    });
    const res = verifySpeakerUtterance(impostor, voiceprint, strictConfig);
    if (res.outcome === 'VERIFIED_PRIMARY') impostorAcceptedStrict++;
  }
  const far = impostorAcceptedStrict / impostorTotal;

  console.log(
    '[MEASURED_SPEAKER_VERIFICATION_SYNTHETIC]',
    JSON.stringify({ primaryTotal, primaryRejected, frr, impostorTotal, impostorAcceptedStrict, far })
  );

  assert.equal(frr, 0, `Synthetic primary-speaker FRR must be 0, got ${frr}`);
  assert.equal(far, 0, `Synthetic impostor FAR must be 0, got ${far}`);

  // Safe fallback verification: short utterance OR uncertain score NEVER silently discards user command
  const shortClip = synthesizeVoicePcmInt16({
    durationMs: 120,
    f0Hz: 122,
    formantsHz: [460, 1280, 2380],
    amplitude: 0.25,
  });
  const shortRes = verifySpeakerUtterance(shortClip, voiceprint, strictConfig);
  assert.equal(shortRes.outcome, 'INSUFFICIENT_SPEECH');
  assert.equal(shortRes.shouldAllowCommand, true);
  assert.equal(shortRes.usedSafeFallback, true);

  // Disabled by default -> allows command without enrolling
  const disabledRes = verifySpeakerUtterance(shortClip, null, DEFAULT_SPEAKER_VERIFICATION_CONFIG);
  assert.equal(disabledRes.outcome, 'DISABLED');
  assert.equal(disabledRes.shouldAllowCommand, true);
});
