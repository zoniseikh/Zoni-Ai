import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DIRECT_CHAT_MODEL_CANDIDATES,
  GEMINI_LIVE_WS_ENDPOINT,
  GEMINI_REST_BASE_URL,
  analyzeScreenDirectGemini,
  buildDirectLiveAudioMessage,
  buildDirectLiveAudioStreamEndMessage,
  buildDirectLiveClientTextMessage,
  buildDirectLiveSetupMessage,
  buildDirectLiveToolResponseMessage,
  buildDirectLiveWebSocketUrl,
  buildGeminiFunctionDeclarations,
  classifyDirectGeminiError,
  decodeDirectLiveFrame,
  generateNotificationSmartRepliesDirectGemini,
  parseDirectLiveServerMessage,
  sendDirectGeminiChat,
  sendDirectGeminiToolFeedback,
  synthesizeDirectGeminiTts,
  verifyDirectGeminiApiKey,
} from './geminiDirectClient';
import { ASSISTANT_TOOL_SPECS } from './assistantActionRegistry';

const TEST_API_KEY = 'AIzaSyDirectTestKey000000000000000009876';

function mockJsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('verifyDirectGeminiApiKey calls official Google models endpoint with x-goog-api-key header and handles 200, 401, 429, and network errors', async () => {
  let capturedUrl = '';
  let capturedHeader = '';

  const okResult = await verifyDirectGeminiApiKey(TEST_API_KEY, async (input, init) => {
    capturedUrl = String(input);
    capturedHeader = new Headers(init?.headers).get('x-goog-api-key') || '';
    return mockJsonResponse(200, {
      models: [
        { name: 'models/gemini-2.5-flash' },
        { name: 'models/gemini-2.5-flash-native-audio-preview-12-2025' },
      ],
    });
  });

  assert.equal(okResult.ok, true);
  assert.equal(okResult.code, 'OK');
  assert.ok(capturedUrl.startsWith(`${GEMINI_REST_BASE_URL}/models`));
  assert.ok(!capturedUrl.includes(TEST_API_KEY), 'API key must never be in REST query string');
  assert.equal(capturedHeader, TEST_API_KEY);
  assert.equal(okResult.preferredChatModel, 'gemini-2.5-flash');
  assert.equal(okResult.preferredLiveModel, 'gemini-2.5-flash-native-audio-preview-12-2025');

  // Invalid API key (401)
  const invalidResult = await verifyDirectGeminiApiKey(TEST_API_KEY, async () =>
    mockJsonResponse(401, { error: { message: `API_KEY_INVALID for ${TEST_API_KEY}` } })
  );
  assert.equal(invalidResult.ok, false);
  assert.equal(invalidResult.code, 'GEMINI_KEY_INVALID');
  assert.ok(!invalidResult.message.includes(TEST_API_KEY));

  // Quota exceeded (429)
  const quotaResult = await verifyDirectGeminiApiKey(TEST_API_KEY, async () =>
    mockJsonResponse(429, { error: { message: 'RESOURCE_EXHAUSTED quota exceeded' } })
  );
  assert.equal(quotaResult.ok, false);
  assert.equal(quotaResult.code, 'GEMINI_QUOTA_EXCEEDED');

  // Network error
  const netResult = await verifyDirectGeminiApiKey(TEST_API_KEY, async () => {
    throw new Error(`Failed to fetch https://generativelanguage.googleapis.com?key=${TEST_API_KEY}`);
  });
  assert.equal(netResult.ok, false);
  assert.equal(netResult.code, 'GEMINI_NETWORK_ERROR');
  assert.ok(!netResult.message.includes(TEST_API_KEY));
});

test('buildGeminiFunctionDeclarations exposes all 36 ZONI assistant tools cleanly and omits empty parameter objects', () => {
  const decls = buildGeminiFunctionDeclarations();
  assert.equal(decls.length, ASSISTANT_TOOL_SPECS.length);
  assert.equal(decls.length, 36);

  const batteryTool = decls.find((d) => d.name === 'battery_status');
  assert.ok(batteryTool);
  assert.equal('parameters' in batteryTool!, false, 'Zero-arg tools must omit empty parameters block for Live API compatibility');

  const callTool = decls.find((d) => d.name === 'call_contact');
  assert.ok(callTool?.parameters);
});

test('sendDirectGeminiChat handles offline deterministic IST date/time queries without calling Gemini network', async () => {
  let networkCalled = false;
  const res = await sendDirectGeminiChat(
    {
      apiKey: '',
      message: 'এখন কয়টা বাজে?',
      lang: 'bn-BD',
    },
    async () => {
      networkCalled = true;
      throw new Error('Should not call network');
    }
  );
  assert.equal(networkCalled, false);
  assert.equal(res.isDirectDateTime, true);
  assert.ok(res.reply.includes('এখন'));
});

test('sendDirectGeminiChat falls back across models on 404, validates allowlisted tool calls, and blocks unknown tools', async () => {
  const calledUrls: string[] = [];
  const res = await sendDirectGeminiChat(
    {
      apiKey: TEST_API_KEY,
      message: 'Turn on the flashlight and run secret_shell',
      lang: 'en-US',
      selectedAffectionName: 'Boss',
    },
    async (input, init) => {
      const url = String(input);
      calledUrls.push(url);
      assert.equal(new Headers(init?.headers).get('x-goog-api-key'), TEST_API_KEY);
      if (calledUrls.length === 1) {
        return mockJsonResponse(404, { error: { message: 'Model not found' } });
      }
      return mockJsonResponse(200, {
        candidates: [
          {
            content: {
              parts: [
                { text: 'Turning on your flashlight right now, Boss!' },
                { functionCall: { name: 'flashlight_control', args: { enable: true } } },
                { functionCall: { name: 'secret_shell_exec', args: { cmd: 'rm -rf' } } },
              ],
            },
          },
        ],
      });
    }
  );

  assert.equal(calledUrls.length, 2);
  assert.ok(calledUrls[0].includes(DIRECT_CHAT_MODEL_CANDIDATES[0]));
  assert.ok(calledUrls[1].includes(DIRECT_CHAT_MODEL_CANDIDATES[1]));
  assert.equal(res.modelUsed, DIRECT_CHAT_MODEL_CANDIDATES[1]);
  assert.equal(res.toolCalls.length, 1);
  assert.equal(res.toolCalls[0].actionType, 'flashlight_control');
  assert.equal(res.blockedToolCalls.length, 1);
  assert.equal(res.blockedToolCalls[0].name, 'secret_shell_exec');
});

test('direct tool feedback, screen analysis, TTS, and notification smart reply call Google Gemini directly without backend URLs', async () => {
  const feedback = await sendDirectGeminiToolFeedback(
    {
      apiKey: TEST_API_KEY,
      originalMessage: 'Turn on torch',
      toolResults: [
        {
          actionId: 'a1',
          actionType: 'toggle_flashlight',
          target: 'on',
          success: true,
          verified: true,
          status: 'executed',
          message: 'Flashlight turned on.',
        },
      ],
      lang: 'en-US',
    },
    async () =>
      mockJsonResponse(200, {
        candidates: [{ content: { parts: [{ text: 'Your flashlight is now on, Boss!' }] } }],
      })
  );
  assert.equal(feedback, 'Your flashlight is now on, Boss!');

  const screenText = await analyzeScreenDirectGemini(
    {
      apiKey: TEST_API_KEY,
      visibleText: 'Settings > Wi-Fi Connected',
      lang: 'en-US',
    },
    async () =>
      mockJsonResponse(200, {
        candidates: [{ content: { parts: [{ text: 'Your screen shows Wi-Fi Settings connected.' }] } }],
      })
  );
  assert.ok(screenText.includes('Wi-Fi'));

  const ttsB64 = await synthesizeDirectGeminiTts(
    {
      apiKey: TEST_API_KEY,
      text: 'Hello Boss',
      voice: 'Kore',
      lang: 'en-US',
    },
    async () =>
      mockJsonResponse(200, {
        candidates: [{ content: { parts: [{ inlineData: { data: 'AAECAw==' } }] } }],
      })
  );
  assert.equal(ttsB64, 'AAECAw==');

  const smart = await generateNotificationSmartRepliesDirectGemini(
    {
      apiKey: TEST_API_KEY,
      sender: 'Rafi',
      message: 'Are you free at 6?',
      appName: 'WhatsApp',
      lang: 'en-US',
    },
    async () =>
      mockJsonResponse(200, {
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    summary: 'Rafi asked if you are free at 6.',
                    suggestedReplies: ['Yes, I am free!', 'Sorry, busy at 6.'],
                  }),
                },
              ],
            },
          },
        ],
      })
  );
  assert.equal(smart.summary, 'Rafi asked if you are free at 6.');
  assert.deepEqual(smart.suggestedReplies, ['Yes, I am free!', 'Sorry, busy at 6.']);
});

test('Direct Gemini Live WebSocket helpers build official setup/audio/text/tool frames and decode binary Blob/ArrayBuffer server events', async () => {
  const wsUrl = buildDirectLiveWebSocketUrl(TEST_API_KEY);
  assert.ok(wsUrl.startsWith(`${GEMINI_LIVE_WS_ENDPOINT}?key=`));

  const setup = buildDirectLiveSetupMessage({
    model: 'gemini-2.5-flash-native-audio-preview-12-2025',
    voice: 'Kore',
    systemInstruction: 'You are Zoni AI.',
    resumptionHandle: 'handle-xyz',
  });
  assert.equal(setup.setup.model, 'models/gemini-2.5-flash-native-audio-preview-12-2025');
  assert.equal(setup.setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Kore');
  assert.equal(setup.setup.sessionResumption.handle, 'handle-xyz');
  assert.equal(setup.setup.realtimeInputConfig.automaticActivityDetection.endOfSpeechSensitivity, 'END_SENSITIVITY_HIGH');
  assert.equal(setup.setup.realtimeInputConfig.automaticActivityDetection.silenceDurationMs, 300);
  assert.equal(setup.setup.tools[0].functionDeclarations.length, 36);

  const setupNoVad = buildDirectLiveSetupMessage({
    model: 'gemini-2.5-flash-native-audio-preview-12-2025',
    systemInstruction: 'You are Zoni AI.',
    includeFastVad: false,
  });
  assert.equal(setupNoVad.setup.realtimeInputConfig, undefined);

  const audioMsg = buildDirectLiveAudioMessage('AAAA');
  assert.equal(audioMsg.realtimeInput.audio.mimeType, 'audio/pcm;rate=16000');
  assert.equal(audioMsg.realtimeInput.audio.data, 'AAAA');

  const streamEndMsg = buildDirectLiveAudioStreamEndMessage();
  assert.equal(streamEndMsg.realtimeInput.audioStreamEnd, true);

  const textMsg = buildDirectLiveClientTextMessage('Hello Zoni');
  assert.equal(textMsg.clientContent.turnComplete, true);
  assert.equal(textMsg.clientContent.turns[0].parts[0].text, 'Hello Zoni');

  const toolResp = buildDirectLiveToolResponseMessage([
    { id: 'fc-1', name: 'toggle_flashlight', response: { success: true } },
  ]);
  assert.equal(toolResp.toolResponse.functionResponses[0].id, 'fc-1');

  // Decode string, ArrayBuffer, and Blob binary frames from BidiGenerateContent
  const sampleServerPayload = {
    setupComplete: {},
    sessionResumptionUpdate: { newHandle: 'h2', resumable: true },
    goAway: { timeLeft: '30s' },
    toolCall: { functionCalls: [{ id: 'tc-1', name: 'get_battery_status', args: {} }] },
    serverContent: {
      inputTranscription: { text: 'Check battery' },
      outputTranscription: { text: 'Checking your battery now!' },
      modelTurn: {
        parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'PCM24K==' } }],
      },
      interrupted: true,
      turnComplete: true,
    },
  };
  const encodedStr = JSON.stringify(sampleServerPayload);
  const encodedBytes = new TextEncoder().encode(encodedStr);

  const fromStr = await decodeDirectLiveFrame(encodedStr);
  const fromBuf = await decodeDirectLiveFrame(encodedBytes.buffer);
  const fromBlob = await decodeDirectLiveFrame(new Blob([encodedStr], { type: 'application/json' }));
  assert.ok(fromStr && fromBuf && fromBlob);

  const events = parseDirectLiveServerMessage(fromBlob!);
  assert.ok(events.some((e) => e.type === 'setup_complete'));
  assert.ok(events.some((e) => e.type === 'session_resumption' && e.newHandle === 'h2'));
  assert.ok(events.some((e) => e.type === 'go_away' && e.timeLeft === '30s'));
  assert.ok(events.some((e) => e.type === 'tool_call' && e.functionCalls?.[0]?.name === 'get_battery_status'));
  assert.ok(events.some((e) => e.type === 'user_transcript' && e.text === 'Check battery'));
  assert.ok(events.some((e) => e.type === 'output_transcript' && e.text === 'Checking your battery now!'));
  assert.ok(events.some((e) => e.type === 'audio' && e.audio === 'PCM24K=='));
  assert.ok(events.some((e) => e.type === 'interrupted'));
  assert.ok(events.some((e) => e.type === 'turn_complete'));
});

test('classifyDirectGeminiError never leaks raw user API keys in any language', () => {
  const err = classifyDirectGeminiError(
    new Error(`Unexpected failure using ${TEST_API_KEY}`),
    `x-goog-api-key: ${TEST_API_KEY}`,
    'bn-BD',
    TEST_API_KEY
  );
  assert.ok(!err.message.includes(TEST_API_KEY));
});
