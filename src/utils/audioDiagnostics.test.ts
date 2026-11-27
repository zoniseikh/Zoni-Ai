import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AUDIO_DIAG_PREFIX,
  AudioDiagnosticTracker,
  audioDiagnostics,
} from './audioDiagnostics';
import { StreamingTtsQueue } from './streamingTts';

test('AudioDiagnosticTracker formats logs with [ZONI_AUDIO_DIAG] prefix and computes session summary accurately', () => {
  const infoLogs: string[] = [];
  const warnLogs: string[] = [];
  const tracker = new AudioDiagnosticTracker({
    info: (msg) => infoLogs.push(msg),
    warn: (msg) => warnLogs.push(msg),
  });

  tracker.recordAudioChunkReceived(1000);
  tracker.recordValidPcmScheduled({
    seq: 1,
    sourceTag: 'live_ws',
    byteLength: 4800,
    sampleRate: 24000,
    channels: 1,
    durationMs: 100,
    isTinyChunk: false,
    hasRiffHeader: false,
    ctxState: 'running',
    ctxSampleRate: 48000,
    ctxCurrentTimeSec: 1.0,
    prevNextPlayTimeSec: 0,
    scheduledStartTimeSec: 1.0,
    newNextPlayTimeSec: 1.1,
    interChunkArrivalMs: null,
    schedulingGapMs: 0,
    isLateChunk: false,
    queuedAheadMs: 0,
    queueDepth: 1,
    ts: 1000,
  });

  tracker.recordAudioChunkReceived(1145);
  tracker.recordValidPcmScheduled({
    seq: 2,
    sourceTag: 'live_ws',
    byteLength: 9600,
    sampleRate: 24000,
    channels: 1,
    durationMs: 200,
    isTinyChunk: false,
    hasRiffHeader: false,
    ctxState: 'running',
    ctxSampleRate: 48000,
    ctxCurrentTimeSec: 1.145,
    prevNextPlayTimeSec: 1.1,
    scheduledStartTimeSec: 1.145,
    newNextPlayTimeSec: 1.345,
    interChunkArrivalMs: 145,
    schedulingGapMs: 45,
    isLateChunk: true,
    queuedAheadMs: 0,
    queueDepth: 1,
    ts: 1145,
  });

  tracker.recordInvalidPcmChunk({
    seq: 3,
    sourceTag: 'live_ws',
    reason: 'pcm_int16_conversion',
    byteLength: 4801,
    sampleRate: 24000,
    channels: 1,
    isOddByteLength: true,
    errorName: 'RangeError',
    errorMessage: 'byte length of Int16Array should be a multiple of 2',
    ts: 1200,
  });

  tracker.recordFrameOrderAnomaly(
    'ws_audio_order_anomaly',
    { frameSeq: 4, prevMaxAudioFrameSeq: 5 },
    4
  );

  tracker.recordAudioStop({
    reason: 'user_barge_in',
    activeSourceCount: 2,
    wasPlaying: true,
    ctxCurrentTimeSec: 1.2,
    remainingScheduledMs: 145,
    interruptedActiveResponse: true,
    ts: 1250,
  });

  tracker.recordTtsOverlap({ source: 'streaming_tts_playAudioBase64' });
  tracker.recordAudioContextError('ensureContext_resume', new Error('NotAllowedError'));

  tracker.recordTurnComplete({
    turnId: 1,
    prevSpeaking: true,
    activeSourceCount: 1,
    queuedAheadMs: 180,
    ts: 1300,
  });
  tracker.recordSpeakingStateTransition({
    source: 'turn_complete',
    prevSpeaking: true,
    nextSpeaking: false,
    activeSourceCount: 1,
    queuedAheadMs: 180,
    ts: 1300,
  });
  tracker.recordPlaybackDrained({ ctxCurrentTimeSec: 1.48, ts: 1480 });

  const summary = tracker.logSessionSummary('unit_test');

  assert.equal(summary.totalAudioChunksReceived, 2);
  assert.equal(summary.totalValidPcmChunks, 2);
  assert.equal(summary.totalInvalidPcmChunks, 1);
  assert.equal(summary.averageChunkDurationMs, 150);
  assert.equal(summary.maxSchedulingGapMs, 45);
  assert.equal(summary.lateChunkCount, 1);
  assert.equal(summary.frameOrderAnomalyCount, 1);
  assert.equal(summary.audioStopInterruptCount, 1);
  assert.equal(summary.ttsOverlapCount, 1);
  assert.equal(summary.audioContextErrorCount, 1);
  assert.equal(summary.turnCompleteWhilePlayingCount, 1);
  assert.equal(summary.prematureSpeakingFalseCount, 1);
  assert.equal(summary.lastAudioChunkReceivedTs, 1145);
  assert.equal(summary.lastAudioChunkScheduledTs, 1145);
  assert.equal(summary.lastTurnCompleteTs, 1300);
  assert.equal(summary.lastPlaybackCompletedTs, 1480);

  for (const line of [...infoLogs, ...warnLogs]) {
    assert.ok(line.startsWith(`${AUDIO_DIAG_PREFIX} `));
    const parsed = JSON.parse(line.slice(AUDIO_DIAG_PREFIX.length + 1));
    assert.equal(typeof parsed.ts, 'number');
    assert.equal(typeof parsed.event, 'string');
  }
});

test('StreamingTtsQueue emits queue diagnostic events without altering playback order or logging spoken text', async () => {
  audioDiagnostics.reset();
  const played: string[] = [];
  const speakingTransitions: boolean[] = [];
  const secretPhrase = 'PRIVATE OTP 994411 DO NOT LOG';

  const queue = new StreamingTtsQueue({
    synthesizeSegment: async (text) => `b64:${text.length}`,
    playAudioBase64: async (audio) => {
      played.push(audio);
    },
    stopAudioPlayback: () => {},
    onSpeakingStateChange: (s) => speakingTransitions.push(s),
  });

  queue.beginTurn(0);
  queue.enqueue(secretPhrase);
  queue.enqueue('Second segment');

  // Wait for microtask drain
  await new Promise((r) => setTimeout(r, 20));

  assert.deepEqual(played, [`b64:${secretPhrase.length}`, 'b64:14']);
  assert.equal(speakingTransitions[0], false); // beginTurn -> interrupt
  assert.ok(speakingTransitions.includes(true));
  assert.equal(speakingTransitions[speakingTransitions.length - 1], false);

  const recent = audioDiagnostics.getRecentEvents();
  const eventsText = JSON.stringify(recent);
  assert.equal(eventsText.includes(secretPhrase), false);
  assert.equal(eventsText.includes('PRIVATE OTP'), false);
  assert.equal(eventsText.includes('994411'), false);
  assert.ok(recent.some((e) => e.event === 'tts_queue_enqueue'));
  assert.ok(recent.some((e) => e.event === 'tts_queue_dequeue'));
  assert.ok(recent.some((e) => e.event === 'tts_segment_play_start'));
  assert.ok(recent.some((e) => e.event === 'tts_segment_play_complete'));
});
