import test from 'node:test';
import assert from 'node:assert/strict';
import { NearFieldSpeechGate, SpeechHighPassFilter } from './audio.ts';
import {
  LocalCommandDeduplicator,
  formatImmediateLocalFeedback,
  isLikelyIncompletePartial,
  routeVoiceCommandLocalFirst,
} from './localCommandRouter.ts';
import { StreamingSentenceChunker, StreamingTtsQueue } from './streamingTts.ts';
import { streamDirectGeminiChat } from './geminiDirectClient.ts';
import { VoiceLatencyTracker } from './voiceLatency.ts';

function synthToneFrame(
  amplitude: number,
  freqHz: number = 320,
  sampleRate: number = 16000,
  durationMs: number = 50
): Float32Array {
  const count = Math.round((sampleRate * durationMs) / 1000);
  const samples = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    samples[i] = amplitude * Math.sin((2 * Math.PI * freqHz * i) / sampleRate);
  }
  return samples;
}

function synthSilenceFrame(sampleRate: number = 16000, durationMs: number = 50): Float32Array {
  return new Float32Array(Math.round((sampleRate * durationMs) / 1000));
}

function buildMockSseFetch(chunks: string[], delayPerChunkMs: number = 8): typeof fetch {
  return (async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const text of chunks) {
          if (delayPerChunkMs > 0) {
            await new Promise((r) => setTimeout(r, delayPerChunkMs));
          }
          const payload = JSON.stringify({
            candidates: [{ content: { parts: [{ text }] } }],
          });
          controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
        }
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  }) as unknown as typeof fetch;
}

// =========================================================================
// SCENARIO 1: Short commands (adaptive fast EOS ~260ms + immediate dispatch)
// =========================================================================
test('Scenario 1: Short command triggers fast adaptive EOS (~260ms) and local dispatch without Gemini wait', () => {
  const gate = new NearFieldSpeechGate();
  const tracker = new VoiceLatencyTracker();
  const dedup = new LocalCommandDeduplicator(2500);
  const frameMs = 50;

  // 200ms ambient quiet room
  for (let i = 0; i < 4; i++) {
    gate.processFrame(synthSilenceFrame(16000, frameMs), frameMs, false);
  }

  // 450ms crisp short user speech ("Open YouTube")
  for (let i = 0; i < 9; i++) {
    const d = gate.processFrame(synthToneFrame(0.18, 320, 16000, frameMs), frameMs, false);
    assert.equal(d.isSpeechActive, true);
    assert.equal(d.shouldSignalAudioStreamEnd, false);
  }

  // Silence until adaptive short-command EOS fires (<= 300ms)
  let eosLatencyMs = 0;
  for (let i = 0; i < 10; i++) {
    const d = gate.processFrame(synthSilenceFrame(16000, frameMs), frameMs, false);
    if (d.shouldSignalAudioStreamEnd) {
      eosLatencyMs = d.endpointDetectionLatencyMs;
      break;
    }
  }
  assert.ok(eosLatencyMs >= 260 && eosLatencyMs <= 300, `Expected fast short EOS ~260-300ms, got ${eosLatencyMs}ms`);

  tracker.beginTurn();
  tracker.recordStageDurationMs('speech_endpoint_detection', eosLatencyMs);
  tracker.markStageStart('intent_classification');
  const route = routeVoiceCommandLocalFirst('Open YouTube', { isFinal: true, deduplicator: dedup });
  const classifyMs = tracker.markStageEnd('intent_classification');
  assert.equal(route.decision, 'LOCAL_DIRECT');
  assert.equal(route.primaryLatencyStage, 'application_launch');
  assert.ok(classifyMs < 50, `Expected instant local intent classification, got ${classifyMs}ms`);
});

// =========================================================================
// SCENARIO 2: Long commands (adaptive longer EOS ~520ms, never clips end)
// =========================================================================
test('Scenario 2: Long multi-clause command adapts EOS timeout higher (~520ms) to avoid cutting off final words', () => {
  const gate = new NearFieldSpeechGate();
  const frameMs = 50;

  // 2500ms continuous speech (long utterance)
  for (let i = 0; i < 50; i++) {
    gate.processFrame(synthToneFrame(0.16, 300, 16000, frameMs), frameMs, false);
  }

  // 350ms pause at end should NOT prematurely end a long utterance
  for (let i = 0; i < 7; i++) {
    const d = gate.processFrame(synthSilenceFrame(16000, frameMs), frameMs, false);
    assert.equal(d.shouldSignalAudioStreamEnd, false, `Premature EOS at ${(i + 1) * frameMs}ms on long utterance`);
  }

  // Continue silence past 520ms -> EOS fires cleanly
  let eosLatencyMs = 0;
  for (let i = 0; i < 6; i++) {
    const d = gate.processFrame(synthSilenceFrame(16000, frameMs), frameMs, false);
    if (d.shouldSignalAudioStreamEnd) {
      eosLatencyMs = d.endpointDetectionLatencyMs;
      break;
    }
  }
  assert.ok(eosLatencyMs >= 520 && eosLatencyMs <= 550, `Expected long utterance EOS ~520-550ms, got ${eosLatencyMs}ms`);
});

// =========================================================================
// SCENARIO 3: Commands with mid-sentence pauses (preserved, not cut off)
// =========================================================================
test('Scenario 3: Commands with a 250ms mid-sentence pause stay open and partial fragments do not execute early', () => {
  const gate = new NearFieldSpeechGate();
  const frameMs = 50;

  // Clause 1: 450ms speech ("Open WhatsApp...")
  for (let i = 0; i < 9; i++) {
    gate.processFrame(synthToneFrame(0.18, 320, 16000, frameMs), frameMs, false);
  }

  // Partial transcript while pausing mid-sentence MUST NOT execute prematurely
  const partial1 = routeVoiceCommandLocalFirst('Open', { isFinal: false });
  assert.equal(partial1.decision, 'WAIT_FOR_MORE_SPEECH');
  const partial2 = routeVoiceCommandLocalFirst('Open WhatsApp and', { isFinal: false });
  assert.equal(partial2.decision, 'WAIT_FOR_MORE_SPEECH');
  assert.equal(isLikelyIncompletePartial('WhatsApp-এ').incomplete, true);

  // 200ms mid-sentence thinking pause -> must NOT trigger EOS
  for (let i = 0; i < 4; i++) {
    const d = gate.processFrame(synthSilenceFrame(16000, frameMs), frameMs, false);
    assert.equal(d.shouldSignalAudioStreamEnd, false);
  }

  // Clause 2 resumes: 500ms speech ("...and search Rahul") -> adaptive timeout steps up to normal (~380ms)
  for (let i = 0; i < 10; i++) {
    const d = gate.processFrame(synthToneFrame(0.18, 340, 16000, frameMs), frameMs, false);
    assert.equal(d.isSpeechActive, true);
    assert.ok(d.effectiveSilenceEndMs >= 380, `Expected pause-adapted EOS >=380ms, got ${d.effectiveSilenceEndMs}ms`);
  }

  // Final silence fires EOS cleanly
  let ended = false;
  for (let i = 0; i < 10; i++) {
    const d = gate.processFrame(synthSilenceFrame(16000, frameMs), frameMs, false);
    if (d.shouldSignalAudioStreamEnd) {
      ended = true;
      break;
    }
  }
  assert.equal(ended, true);
});

// =========================================================================
// SCENARIO 4: YouTube launch (local-first, deduped, zero Gemini wait)
// =========================================================================
test('Scenario 4: YouTube launch routes locally with zero Gemini cloud wait and suppresses duplicates', () => {
  const dedup = new LocalCommandDeduplicator(2500);
  // Partial preview identifies intent early without executing
  const preview = routeVoiceCommandLocalFirst('Open YouTube', { isFinal: false });
  assert.equal(preview.decision, 'PREVIEW_ONLY');
  assert.equal(preview.earlyIntentLabel, 'open_app');

  // Final dispatch executes locally
  const finalRoute = routeVoiceCommandLocalFirst('Open YouTube', { isFinal: true, deduplicator: dedup });
  assert.equal(finalRoute.decision, 'LOCAL_DIRECT');
  assert.equal(finalRoute.plan?.steps[0].tool, 'open_app');
  const ytArg = String(
    finalRoute.plan?.steps[0].args.appQuery || finalRoute.plan?.steps[0].args.app_name || ''
  ).toLowerCase();
  assert.equal(ytArg, 'youtube');
  assert.equal(finalRoute.worksOffline, true);

  // Immediate duplicate transcript within 2.5s is suppressed
  const dupRoute = routeVoiceCommandLocalFirst('Open YouTube', { isFinal: true, deduplicator: dedup });
  assert.equal(dupRoute.decision, 'DUPLICATE_SUPPRESSED');

  // Short immediate voice feedback formatted cleanly
  assert.equal(formatImmediateLocalFeedback('open_app', 'YouTube', true, 'en-US'), 'Opening YouTube.');
  assert.equal(formatImmediateLocalFeedback('open_app', 'YouTube', true, 'bn-BD'), 'YouTube খুলছি।');
});

// =========================================================================
// SCENARIO 5: WhatsApp launch (local-first, multilingual)
// =========================================================================
test('Scenario 5: WhatsApp launch routes locally in English and Bengali without waiting for Gemini', () => {
  const dedup = new LocalCommandDeduplicator(2500);
  const en = routeVoiceCommandLocalFirst('Open WhatsApp', { isFinal: true, deduplicator: dedup });
  assert.equal(en.decision, 'LOCAL_DIRECT');
  assert.equal(en.plan?.steps[0].tool, 'open_app');
  const waArg = String(
    en.plan?.steps[0].args.appQuery || en.plan?.steps[0].args.app_name || ''
  ).toLowerCase();
  assert.equal(waArg, 'whatsapp');

  dedup.reset();
  const bn = routeVoiceCommandLocalFirst('হোয়াটসঅ্যাপ খোলো', { isFinal: true, deduplicator: dedup });
  assert.equal(bn.decision, 'LOCAL_DIRECT');
  assert.equal(bn.plan?.steps[0].tool, 'open_app');
});

// =========================================================================
// SCENARIO 6: WhatsApp contact navigation (opens chat, NEVER sends unauthorized)
// =========================================================================
test('Scenario 6: WhatsApp contact navigation opens conversation locally and guards unauthorized payments/sends', () => {
  const dedup = new LocalCommandDeduplicator(2500);

  const navEn = routeVoiceCommandLocalFirst('Open WhatsApp and search Rahul', {
    isFinal: true,
    deduplicator: dedup,
  });
  assert.equal(navEn.decision, 'LOCAL_DIRECT');
  assert.equal(navEn.primaryLatencyStage, 'accessibility_interaction');
  assert.ok(
    navEn.plan?.steps.some(
      (s) => s.tool === 'open_whatsapp_chat' || s.tool === 'click_whatsapp_contact'
    ),
    'Expected WhatsApp chat navigation step'
  );
  // MUST NOT contain an unauthorized send step
  assert.equal(
    navEn.plan?.steps.some((s) => s.tool === 'send_whatsapp_message'),
    false
  );

  // Consequential financial action is explicitly blocked without manual authorization
  const payGuard = routeVoiceCommandLocalFirst('Confirm payment of ₹5000 now', {
    isFinal: true,
    deduplicator: dedup,
  });
  assert.equal(payGuard.decision, 'REQUIRES_EXPLICIT_AUTHORIZATION');
});

// =========================================================================
// SCENARIO 7: Accessibility clicking & scrolling (AccessibilityNodeInfo-first)
// =========================================================================
test('Scenario 7: Accessibility click and scroll commands route locally with accessibility_interaction stage', () => {
  const dedup = new LocalCommandDeduplicator(2500);

  const clickRes = routeVoiceCommandLocalFirst('Click Subscribe', {
    isFinal: true,
    deduplicator: dedup,
  });
  assert.equal(clickRes.decision, 'LOCAL_DIRECT');
  assert.equal(clickRes.primaryLatencyStage, 'accessibility_interaction');

  const scrollRes = routeVoiceCommandLocalFirst('Scroll down', {
    isFinal: true,
    deduplicator: dedup,
  });
  assert.equal(scrollRes.decision, 'LOCAL_DIRECT');
  assert.equal(scrollRes.primaryLatencyStage, 'accessibility_interaction');

  const unsafeShell = routeVoiceCommandLocalFirst('sudo rm -rf /', {
    isFinal: true,
    deduplicator: dedup,
  });
  assert.equal(unsafeShell.decision, 'BLOCKED_UNSAFE');
});

// =========================================================================
// SCENARIO 8: General questions with streaming SSE + first-segment TTS
// =========================================================================
test('Scenario 8: General question streams tokens via SSE and starts first-segment TTS before full reply completes', async () => {
  const tracker = new VoiceLatencyTracker();
  const route = routeVoiceCommandLocalFirst('What causes a solar eclipse?', { isFinal: true });
  assert.equal(route.decision, 'CLOUD_GEMINI_STREAMING');

  const spokenSegments: string[] = [];
  let firstTokenMs: number | null = null;
  let firstAudibleMs: number | null = null;
  let firstAudibleTriggeredBeforeStreamEnd = false;
  let streamFinished = false;

  const ttsQueue = new StreamingTtsQueue({
    synthesizeSegment: async (segmentText) => {
      // Simulate fast segment synthesis
      await new Promise((r) => setTimeout(r, 4));
      return Buffer.from(segmentText).toString('base64');
    },
    playAudioBase64: async (b64) => {
      spokenSegments.push(Buffer.from(b64, 'base64').toString('utf8'));
      await new Promise((r) => setTimeout(r, 5));
    },
    stopAudioPlayback: () => {},
    onFirstAudibleSegment: (_seg, elapsedMs) => {
      firstAudibleMs = elapsedMs;
      if (!streamFinished) {
        firstAudibleTriggeredBeforeStreamEnd = true;
      }
      tracker.recordStageDurationMs('first_audible_tts', elapsedMs);
    },
  });

  tracker.beginTurn();
  ttsQueue.beginTurn();

  const mockFetch = buildMockSseFetch(
    [
      'A solar eclipse happens when the Moon moves directly between Earth and the Sun. ',
      'During totality, the Moon blocks sunlight across a narrow shadow path. ',
      'Dr. Patel notes that totality lasts around 3.5 minutes on average.',
    ],
    20
  );

  const res = await streamDirectGeminiChat(
    {
      apiKey: 'AIzaSyTestFakeKey1234567890',
      message: 'What causes a solar eclipse?',
      lang: 'en-US',
      onFirstToken: (ms) => {
        firstTokenMs = ms;
        tracker.recordStageDurationMs('gemini_first_token', ms);
      },
      onSentenceSegment: (seg) => {
        ttsQueue.enqueue(seg);
      },
    },
    mockFetch
  );
  streamFinished = true;

  // Wait briefly for remaining queued segments to finish playback
  await new Promise((r) => setTimeout(r, 60));

  assert.equal(res.usedStreaming, true);
  assert.ok(firstTokenMs !== null && firstTokenMs >= 0);
  assert.ok(firstAudibleMs !== null && firstAudibleMs >= 0);
  assert.equal(
    firstAudibleTriggeredBeforeStreamEnd,
    true,
    'First TTS segment must start speaking before the entire Gemini SSE stream finishes'
  );
  assert.equal(spokenSegments.length, 3);
  assert.ok(spokenSegments[2].includes('Dr. Patel') && spokenSegments[2].includes('3.5 minutes'));

  const metrics = tracker.finishTurn(false);
  assert.ok(typeof metrics.stageDurationsMs.gemini_first_token === 'number');
  assert.ok(typeof metrics.stageDurationsMs.first_audible_tts === 'number');
});

// =========================================================================
// SCENARIO 9: User interruption (barge-in) during assistant speech
// =========================================================================
test('Scenario 9: Controlled near-field barge-in stops assistant playback immediately while soft playback echo stays suppressed', async () => {
  const gate = new NearFieldSpeechGate({ allowBargeIn: true, bargeInMinRms: 0.085, bargeInHoldMs: 120 });
  const frameMs = 50;

  // Soft assistant speaker echo leaking into mic (amplitude 0.045 -> rms ~0.032 < 0.085) MUST stay suppressed
  for (let i = 0; i < 6; i++) {
    const d = gate.processFrame(synthToneFrame(0.045, 340, 16000, frameMs), frameMs, true);
    assert.equal(d.suppressedByPlaybackEcho, true);
    assert.equal(d.shouldInterruptAssistant, false);
    assert.equal(d.shouldTransmitCurrentFrame, false);
  }

  // Sustained loud near-field user barge-in (amplitude 0.25 -> rms ~0.177 >= 0.085 for >= 120ms)
  let interrupted = false;
  for (let i = 0; i < 4; i++) {
    const d = gate.processFrame(synthToneFrame(0.25, 320, 16000, frameMs), frameMs, true);
    if (d.shouldInterruptAssistant) {
      interrupted = true;
      assert.equal(d.shouldTransmitCurrentFrame, true);
      assert.ok(d.preRollFramesToFlush.length >= 2, 'Barge-in should flush opening pre-roll frames');
      break;
    }
  }
  assert.equal(interrupted, true, 'Loud near-field user speech must interrupt assistant playback');

  // Verify StreamingTtsQueue stops playback immediately on interrupt()
  let stopCalled = false;
  let speakingState = false;
  const played: string[] = [];
  const queue = new StreamingTtsQueue({
    synthesizeSegment: async (seg) => {
      await new Promise((r) => setTimeout(r, 10));
      return Buffer.from(seg).toString('base64');
    },
    playAudioBase64: async (b64) => {
      played.push(Buffer.from(b64, 'base64').toString('utf8'));
      await new Promise((r) => setTimeout(r, 80));
    },
    stopAudioPlayback: () => {
      stopCalled = true;
    },
    onSpeakingStateChange: (s) => {
      speakingState = s;
    },
  });

  queue.beginTurn();
  queue.enqueue('First sentence playing now.');
  queue.enqueue('Second sentence that must be cancelled.');
  await new Promise((r) => setTimeout(r, 25));
  queue.interrupt();
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(stopCalled, true);
  assert.equal(speakingState, false);
  assert.equal(played.length <= 1, true, 'Second queued sentence must never play after barge-in interrupt');
});

// =========================================================================
// SCENARIO 10: Background noise and nearby softer speakers
// =========================================================================
test('Scenario 10: High-pass filter + primary-speaker energy lock prevents distant background speech from extending user turn', () => {
  const hpf = new SpeechHighPassFilter();
  const gate = new NearFieldSpeechGate();
  const frameMs = 50;

  // Ambient low-frequency fan rumble (40 Hz) + quiet room baseline
  for (let i = 0; i < 6; i++) {
    const raw = synthToneFrame(0.02, 40, 16000, frameMs);
    const filtered = hpf.process(raw);
    const d = gate.processFrame(filtered, frameMs, false);
    assert.equal(d.isSpeechActive, false);
  }

  // Primary user speaks loudly near mic (amp 0.30 -> rms ~0.212) for 450ms
  for (let i = 0; i < 9; i++) {
    const filtered = hpf.process(synthToneFrame(0.30, 320, 16000, frameMs));
    const d = gate.processFrame(filtered, frameMs, false);
    assert.equal(d.isSpeechActive, true);
  }

  // Primary user stops speaking, while a distant nearby person talks softly (amp 0.045 -> rms ~0.032 < 0.212 * 0.25 = 0.053)
  let eosFiredDespiteBackgroundChatter = false;
  for (let i = 0; i < 10; i++) {
    const distantVoice = hpf.process(synthToneFrame(0.045, 360, 16000, frameMs));
    const d = gate.processFrame(distantVoice, frameMs, false);
    if (d.shouldSignalAudioStreamEnd) {
      eosFiredDespiteBackgroundChatter = true;
      break;
    }
  }
  assert.equal(
    eosFiredDespiteBackgroundChatter,
    true,
    'Primary user EOS must still fire cleanly despite softer distant background chatter'
  );
});

// =========================================================================
// SCENARIO 11: Weak network & offline local commands
// =========================================================================
test('Scenario 11: Local-first commands (YouTube, WhatsApp, Accessibility, Time/Date) execute offline with zero network calls', async () => {
  const dedup = new LocalCommandDeduplicator(2500);

  const offlineCommands = [
    'Open YouTube',
    'Open WhatsApp',
    'Open WhatsApp and search Rahul',
    'Scroll down',
    'Click Play',
    'Turn on flashlight',
    'এখন কটা বাজে?',
  ];

  for (const cmd of offlineCommands) {
    dedup.reset();
    const res = routeVoiceCommandLocalFirst(cmd, { isFinal: true, deduplicator: dedup });
    assert.equal(res.worksOffline, true, `Expected "${cmd}" to work offline`);
    assert.ok(
      res.decision === 'LOCAL_DIRECT' || res.decision === 'LOCAL_DATETIME',
      `Expected local offline route for "${cmd}", got ${res.decision}`
    );
  }

  // Also verify Bengali sentence chunking works offline with zero network
  const chunker = new StreamingSentenceChunker();
  const s1 = chunker.pushDelta('আজকের আবহাওয়া বেশ সুন্দর। ');
  const s2 = chunker.pushDelta('আকাশ একদম পরিষ্কার আছে।');
  assert.equal(s1.length, 1);
  assert.equal(s1[0], 'আজকের আবহাওয়া বেশ সুন্দর।');
  assert.equal(s2.length, 1);
  assert.equal(s2[0], 'আকাশ একদম পরিষ্কার আছে।');
});
