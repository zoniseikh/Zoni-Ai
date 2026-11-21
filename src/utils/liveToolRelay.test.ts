import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LiveToolRelayManager,
  getExposedAssistantToolNames,
  decideIntentExecutionRoute,
  RecentActionDeduplicator,
  sanitizeDiagnosticActionLabel,
  sanitizeDiagnosticMessage,
  type GeminiFunctionResponseItem,
} from './liveToolRelay.ts';

test('Category D: Gemini Live & HTTP expose all 33 validated assistant tools including YouTube click and WhatsApp smart contact/send tools', () => {
  const names = getExposedAssistantToolNames();
  assert.equal(names.length, 33);
  assert.ok(names.includes('open_app'));
  assert.ok(names.includes('prepare_whatsapp_message'));
  assert.ok(names.includes('prepare_app_chat_message'));
  assert.ok(names.includes('flashlight_control'));
  assert.ok(names.includes('call_contact'));
  assert.ok(names.includes('list_installed_apps'));
  assert.ok(names.includes('click_youtube_video'));
  assert.ok(names.includes('click_youtube_search_result'));
  assert.ok(names.includes('click_visible_element'));
  assert.ok(names.includes('click_whatsapp_contact'));
  assert.ok(names.includes('open_whatsapp_chat'));
  assert.ok(names.includes('type_whatsapp_message'));
  assert.ok(names.includes('send_whatsapp_message'));
  assert.ok(names.includes('verify_whatsapp_send'));
});

test('Category D: LiveToolRelayManager relays native_tool_call -> native_tool_result -> sendToolResponse without fabricating success', () => {
  const sentToClient: Array<Record<string, unknown>> = [];
  const sentToGemini: GeminiFunctionResponseItem[][] = [];

  const relay = new LiveToolRelayManager({
    sendToClient: (p) => sentToClient.push(p),
    sendToolResponseToGemini: (r) => sentToGemini.push(r),
    isClientConnected: () => true,
  });

  const outcome = relay.handleModelToolCalls([
    { id: 'call_open_1', name: 'open_app', args: { app_name: 'WhatsApp' } },
  ]);

  assert.equal(outcome.relayed.length, 1);
  assert.equal(outcome.blocked.length, 0);
  assert.equal(sentToClient.length, 1);
  assert.equal(sentToClient[0].type, 'native_tool_call');
  assert.equal(sentToClient[0].toolCallId, 'call_open_1');
  assert.equal(sentToClient[0].actionType, 'open_app');
  // CRITICAL: Gemini must NOT receive a fabricated response before client executes
  assert.equal(sentToGemini.length, 0);
  assert.equal(relay.getPendingCount(), 1);

  const accepted = relay.handleClientToolResult({
    type: 'native_tool_result',
    toolCallId: 'call_open_1',
    actionType: 'open_app',
    result: {
      success: true,
      verified: true,
      status: 'launched',
      message: 'Opened WhatsApp (com.whatsapp).',
      data: { packageName: 'com.whatsapp' },
    },
  });

  assert.equal(accepted, true);
  assert.equal(relay.getPendingCount(), 0);
  assert.equal(sentToGemini.length, 1);
  assert.equal(sentToGemini[0][0].id, 'call_open_1');
  assert.equal(sentToGemini[0][0].name, 'open_app');
  assert.equal(sentToGemini[0][0].response.output.success, true);
  assert.equal(sentToGemini[0][0].response.output.status, 'launched');

  // Duplicate result for already-completed toolCallId is safely ignored
  const duplicateResult = relay.handleClientToolResult({
    type: 'native_tool_result',
    toolCallId: 'call_open_1',
    result: { success: true, verified: true, status: 'launched', message: 'dup' },
  });
  assert.equal(duplicateResult, false);
  assert.equal(sentToGemini.length, 1);

  relay.dispose();
});

test('Category D: LiveToolRelayManager supports multiple concurrent tool calls, deduplicates duplicate IDs, and normalizes set_flashlight', () => {
  const sentToClient: Array<Record<string, unknown>> = [];
  const sentToGemini: GeminiFunctionResponseItem[][] = [];

  const relay = new LiveToolRelayManager({
    sendToClient: (p) => sentToClient.push(p),
    sendToolResponseToGemini: (r) => sentToGemini.push(r),
    isClientConnected: () => true,
  });

  const outcome = relay.handleModelToolCalls([
    { id: 'c1', name: 'set_flashlight', args: { enable: true } },
    { id: 'c2', name: 'open_app', args: { app_name: 'YouTube' } },
    { id: 'c1', name: 'set_flashlight', args: { enable: true } }, // duplicate ID
  ]);

  assert.equal(outcome.relayed.length, 2);
  assert.deepEqual(outcome.duplicatesSkipped, ['c1']);
  assert.equal(sentToClient.length, 2);
  assert.equal(sentToClient[0].actionType, 'flashlight_control');
  assert.equal(sentToClient[1].actionType, 'open_app');
  assert.equal(relay.getPendingCount(), 2);

  // Resolve out of order (c2 first, then c1)
  assert.equal(
    relay.handleClientToolResult({
      type: 'native_tool_result',
      toolCallId: 'c2',
      result: { success: true, verified: true, status: 'launched', message: 'YouTube launched' },
    }),
    true
  );
  assert.equal(relay.getPendingCount(), 1);
  assert.equal(
    relay.handleClientToolResult({
      type: 'native_tool_result',
      toolCallId: 'c1',
      result: { success: true, verified: true, status: 'torch_on', message: 'Torch on' },
    }),
    true
  );
  assert.equal(relay.getPendingCount(), 0);
  assert.equal(sentToGemini.length, 2);
  assert.equal(sentToGemini[1][0].name, 'set_flashlight');

  relay.dispose();
});

test('Category D & F: LiveToolRelayManager blocks disallowed tools and handles disconnected client immediately', () => {
  const sentToClient: Array<Record<string, unknown>> = [];
  const sentToGemini: GeminiFunctionResponseItem[][] = [];
  let connected = true;

  const relay = new LiveToolRelayManager({
    sendToClient: (p) => sentToClient.push(p),
    sendToolResponseToGemini: (r) => sentToGemini.push(r),
    isClientConnected: () => connected,
  });

  // Disallowed shell tool must NEVER reach client
  const blockedOutcome = relay.handleModelToolCalls([
    { id: 'bad_1', name: 'exec_shell', args: { cmd: 'rm -rf /' } },
  ]);
  assert.equal(blockedOutcome.relayed.length, 0);
  assert.equal(blockedOutcome.blocked.length, 1);
  assert.equal(sentToClient.length, 0);
  assert.equal(sentToGemini.length, 1);
  assert.equal(sentToGemini[0][0].response.output.status, 'blocked');

  // Disconnected client must immediately return honest client_disconnected error
  connected = false;
  const disconnOutcome = relay.handleModelToolCalls([
    { id: 'open_disc', name: 'open_app', args: { app_name: 'Chrome' } },
  ]);
  assert.equal(disconnOutcome.relayed.length, 0);
  assert.equal(sentToClient.length, 0);
  assert.equal(sentToGemini.length, 2);
  assert.equal(sentToGemini[1][0].response.output.failureReason, 'client_disconnected');

  relay.dispose();
});

test('Category D: LiveToolRelayManager timeout sends honest timeout failure and ignores late results', async () => {
  const sentToGemini: GeminiFunctionResponseItem[][] = [];
  const relay = new LiveToolRelayManager(
    {
      sendToClient: () => {},
      sendToolResponseToGemini: (r) => sentToGemini.push(r),
      isClientConnected: () => true,
    },
    -5000 // forces minimum 1500ms timeout; wait 1600ms below
  );

  // Override by using a fast tool timeout via a custom quick check using small wait
  // Note: LiveToolRelayManager clamps effectiveTimeoutMs to >= 1500ms for safety.
  relay.handleModelToolCalls([{ id: 'slow_1', name: 'battery_status', args: {} }]);
  assert.equal(relay.hasPending('slow_1'), true);

  await new Promise((resolve) => setTimeout(resolve, 1650));

  assert.equal(relay.hasPending('slow_1'), false);
  assert.equal(sentToGemini.length, 1);
  assert.equal(sentToGemini[0][0].response.output.success, false);
  assert.equal(sentToGemini[0][0].response.output.status, 'timeout');
  assert.equal(sentToGemini[0][0].response.output.failureReason, 'client_tool_timeout');

  // Late client result after timeout is ignored
  const lateAccepted = relay.handleClientToolResult({
    type: 'native_tool_result',
    toolCallId: 'slow_1',
    result: { success: true, verified: true, status: 'battery_checked', message: '90%' },
  });
  assert.equal(lateAccepted, false);
  assert.equal(sentToGemini.length, 1);

  relay.dispose();
});

test('Category A & D: decideIntentExecutionRoute separates deterministic actions, non-deterministic tool intents, and ordinary chat', () => {
  assert.equal(
    decideIntentExecutionRoute('ফেসবুকটা খুলে দাও', { liveWsReadyWithTools: true }),
    'deterministic_native'
  );
  assert.equal(
    decideIntentExecutionRoute('WhatsApp-এ রাহুলকে একটা মেসেজ পাঠিয়ে দাও।', {
      liveWsReadyWithTools: false,
    }),
    'deterministic_native'
  );
  // Recognizable device-action phrasing that does not hit a deterministic regex
  assert.equal(
    decideIntentExecutionRoute('Can you check if I have any unread Telegram messages from today?', {
      liveWsReadyWithTools: true,
    }),
    'live_tool_relay'
  );
  assert.equal(
    decideIntentExecutionRoute('Can you check if I have any unread Telegram messages from today?', {
      liveWsReadyWithTools: false,
    }),
    'http_function_calling'
  );
  // Ordinary conversation routes cleanly to gemini_conversation
  assert.equal(
    decideIntentExecutionRoute('তুমি কেমন আছো?', { liveWsReadyWithTools: true }),
    'gemini_conversation'
  );
  assert.equal(
    decideIntentExecutionRoute('Tell me a short story about the stars', {
      liveWsReadyWithTools: false,
    }),
    'gemini_conversation'
  );
});

test('Category D: RecentActionDeduplicator prevents double execution within time window', () => {
  const dedup = new RecentActionDeduplicator(3000);
  assert.equal(dedup.shouldExecute('open_app', { app_name: 'WhatsApp' }, 1000), true);
  assert.equal(dedup.shouldExecute('open_app', { app_name: 'whatsapp' }, 2500), false);
  // Different app allowed immediately
  assert.equal(dedup.shouldExecute('open_app', { app_name: 'Chrome' }, 2500), true);
  // Same app allowed again after window expires
  assert.equal(dedup.shouldExecute('open_app', { app_name: 'WhatsApp' }, 4500), true);
});

test('Category F: Diagnostic sanitizers NEVER leak private message content, phone numbers, or API keys', () => {
  const waLabel = sanitizeDiagnosticActionLabel('prepare_whatsapp_message', {
    recipient: 'Rahul +919876543210',
    message: 'My secret bank OTP is 492811',
  });
  assert.equal(waLabel.includes('492811'), false);
  assert.equal(waLabel.includes('9876543210'), false);
  assert.equal(waLabel.includes('Rahul'), false);
  assert.ok(waLabel.includes('[REDACTED]'));

  const tgLabel = sanitizeDiagnosticActionLabel('prepare_app_chat_message', {
    app_name: 'Telegram',
    recipient: 'Riya',
    message: 'Private text here',
  });
  assert.ok(tgLabel.includes('Telegram'));
  assert.equal(tgLabel.includes('Private text here'), false);
  assert.equal(tgLabel.includes('Riya'), false);

  const safeMsg = sanitizeDiagnosticMessage(
    'Failed calling +8801712345678 with key=AIzaSyAbCdEfGhIjKlMnOpQrStUvWxYz123456'
  );
  assert.equal(safeMsg.includes('AIzaSy'), false);
  assert.equal(safeMsg.includes('1712345678'), false);
  assert.ok(safeMsg.includes('[REDACTED_PHONE]'));
  assert.ok(safeMsg.includes('[REDACTED'));
});
