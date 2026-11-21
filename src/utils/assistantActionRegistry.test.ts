import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ASSISTANT_TOOL_SPECS,
  isAllowlistedAssistantTool,
  validateGeminiToolCall,
  formatLocalizedActionOutcome,
} from './assistantActionRegistry.ts';

test('Category A & C & E: Registry declares all 25 allowlisted Android personal assistant tools', () => {
  assert.equal(ASSISTANT_TOOL_SPECS.length, 25);
  const expectedTools = [
    'list_installed_apps',
    'open_app',
    'open_system_settings',
    'go_home',
    'go_back',
    'scroll_screen',
    'tap_visible_element',
    'enter_text_in_visible_field',
    'read_visible_screen',
    'read_notifications',
    'prepare_whatsapp_message',
    'prepare_sms',
    'prepare_app_chat_message',
    'request_permission',
    'flashlight_control',
    'volume_control',
    'battery_status',
    'camera_open',
    'contact_search',
    'call_contact',
    'create_reminder',
    'search_web',
    'search_youtube',
    'search_installed_app',
    'cancel_current_task',
  ];
  for (const name of expectedTools) {
    assert.equal(isAllowlistedAssistantTool(name), true, `Expected ${name} to be allowlisted`);
  }

  // Alias support: search_contacts -> contact_search, set_flashlight -> flashlight_control
  const aliasRes = validateGeminiToolCall('search_contacts', { query: 'Rahul' });
  assert.equal(aliasRes.valid, true);
  assert.equal(aliasRes.request?.actionType, 'contact_search');

  const flashAlias = validateGeminiToolCall('set_flashlight', { enable: true });
  assert.equal(flashAlias.valid, true);
  assert.equal(flashAlias.request?.actionType, 'flashlight_control');
  assert.equal(flashAlias.request?.arguments.enable, true);
});

test('Category E: Security policy strictly blocks disallowed tools, shell commands, JS eval, and arbitrary file operations', () => {
  const disallowed = ['exec_shell', 'run_adb', 'eval_js', 'read_file', 'write_file', 'send_silent_sms', 'launch_arbitrary_intent'];
  for (const tool of disallowed) {
    assert.equal(isAllowlistedAssistantTool(tool), false);
    const res = validateGeminiToolCall(tool, { cmd: 'ls' });
    assert.equal(res.valid, false);
    assert.ok(res.blockedReason && res.blockedReason.includes('Blocked disallowed tool'));
  }

  const shellPayload = validateGeminiToolCall('enter_text_in_visible_field', {
    field_hint: 'Search',
    text: 'rm -rf / && bash -c whoami',
  });
  assert.equal(shellPayload.valid, false);
  assert.ok(shellPayload.blockedReason?.includes('Blocked unsafe payload'));

  const jsPayload = validateGeminiToolCall('open_app', {
    app_name: 'javascript:eval(alert(1))',
  });
  assert.equal(jsPayload.valid, false);
});

test('Category C: Communication tools (WhatsApp, SMS, Call) ALWAYS enforce requiresConfirmation=true', () => {
  const wa = validateGeminiToolCall('prepare_whatsapp_message', {
    recipient: 'রাহুল',
    message: 'আমি আজ আসতে পারব না',
  });
  assert.equal(wa.valid, true);
  assert.equal(wa.request?.requiresConfirmation, true);
  assert.equal(wa.request?.arguments.recipient, 'রাহুল');
  assert.equal(wa.request?.arguments.message, 'আমি আজ আসতে পারব না');

  const sms = validateGeminiToolCall('prepare_sms', {
    recipient: 'Baba',
    message: 'Reaching soon',
  });
  assert.equal(sms.valid, true);
  assert.equal(sms.request?.requiresConfirmation, true);

  const call = validateGeminiToolCall('call_contact', { recipient: 'মা' });
  assert.equal(call.valid, true);
  assert.equal(call.request?.requiresConfirmation, true);

  const appChat = validateGeminiToolCall('prepare_app_chat_message', {
    app_name: 'Telegram',
    recipient: 'রাহুল',
    message: 'আমি আসছি',
  });
  assert.equal(appChat.valid, true);
  assert.equal(appChat.request?.requiresConfirmation, true);
  assert.equal(appChat.request?.arguments.app_name, 'Telegram');
});

test('Category A & B & E: Validation enforces required arguments and strict enum constraints', () => {
  const validScroll = validateGeminiToolCall('scroll_screen', { direction: 'down' });
  assert.equal(validScroll.valid, true);
  assert.equal(validScroll.request?.arguments.direction, 'down');

  const invalidScroll = validateGeminiToolCall('scroll_screen', { direction: 'diagonal' });
  assert.equal(invalidScroll.valid, false);
  assert.ok(invalidScroll.blockedReason?.includes('Unsupported value'));

  const missingApp = validateGeminiToolCall('open_app', {});
  assert.equal(missingApp.valid, false);
  assert.ok(missingApp.blockedReason?.includes('Missing required argument'));

  const validSettings = validateGeminiToolCall('open_system_settings', { target: 'accessibility' });
  assert.equal(validSettings.valid, true);
  assert.equal(validSettings.request?.arguments.target, 'accessibility');

  const invalidSettings = validateGeminiToolCall('open_system_settings', { target: 'root_shell' });
  assert.equal(invalidSettings.valid, false);
});

test('Category C, D & E: formatLocalizedActionOutcome enforces honest reporting for WhatsApp drafts, permissions, blocks, and cancellations', () => {
  const verifiedSendOutcome = formatLocalizedActionOutcome(
    {
      actionId: 'a0',
      actionType: 'prepare_whatsapp_message',
      success: true,
      verified: true,
      status: 'whatsapp_sent_verified',
      message: 'Send clicked & verified',
      data: { contactName: 'রাহুল' },
    },
    'bn-BD',
    'Boss'
  );
  assert.ok(verifiedSendOutcome.includes('Send'));
  assert.ok(verifiedSendOutcome.includes('অনুমোদনের পর'));
  assert.ok(verifiedSendOutcome.includes('ডেলিভারি'));

  const draftOutcome = formatLocalizedActionOutcome(
    {
      actionId: 'a1',
      actionType: 'prepare_whatsapp_message',
      success: true,
      verified: true,
      status: 'opened_whatsapp_draft_ready_to_send',
      message: 'Draft opened',
      data: { contactName: 'রাহুল' },
    },
    'bn-BD',
    'Boss'
  );
  assert.ok(draftOutcome.includes('WhatsApp'));
  assert.ok(draftOutcome.includes('Send'));
  assert.ok(draftOutcome.includes('স্বয়ংক্রিয়ভাবে পাঠানো হয়নি'));

  const remoteReplyOutcome = formatLocalizedActionOutcome(
    {
      actionId: 'a2',
      actionType: 'prepare_whatsapp_message',
      success: true,
      verified: true,
      status: 'replied_via_notification_remote_input',
      message: 'Sent via RemoteInput',
    },
    'bn-BD',
    'Boss'
  );
  assert.ok(remoteReplyOutcome.includes('নোটিফিকেশন রিপ্লাই'));

  const permMissingOutcome = formatLocalizedActionOutcome(
    {
      actionId: 'a3',
      actionType: 'scroll_screen',
      success: false,
      verified: true,
      status: 'permission_missing',
      requiredPermissions: ['ACCESSIBILITY_SERVICE'],
      message: 'Accessibility service is off',
    },
    'bn-BD',
    'Boss'
  );
  assert.ok(permMissingOutcome.includes('ACCESSIBILITY_SERVICE'));

  const blockedOutcome = formatLocalizedActionOutcome(
    {
      actionId: 'a4',
      actionType: 'read_visible_screen',
      success: false,
      verified: true,
      status: 'blocked',
      message: 'Protected banking/OTP screen',
    },
    'bn-BD',
    'Boss'
  );
  assert.ok(blockedOutcome.includes('ব্লক'));

  const cancelledOutcome = formatLocalizedActionOutcome(
    {
      actionId: 'a5',
      actionType: 'prepare_whatsapp_message',
      success: true,
      verified: true,
      status: 'cancelled',
      message: 'Cancelled',
    },
    'bn-BD',
    'Boss'
  );
  assert.ok(cancelledOutcome.includes('বাতিল'));

  const appChatSent = formatLocalizedActionOutcome(
    {
      actionId: 'a6',
      actionType: 'prepare_app_chat_message',
      success: true,
      verified: true,
      status: 'app_chat_sent_verified',
      message: 'Sent via Telegram',
      data: { appName: 'Telegram', contactName: 'রাহুল' },
    },
    'bn-BD',
    'Boss'
  );
  assert.ok(appChatSent.includes('Telegram'));
  assert.ok(appChatSent.includes('Send'));
});
