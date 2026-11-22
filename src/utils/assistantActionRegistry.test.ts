import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ASSISTANT_TOOL_SPECS,
  isAllowlistedAssistantTool,
  validateGeminiToolCall,
  formatLocalizedActionOutcome,
} from './assistantActionRegistry.ts';

test('Category A & C & E: Registry declares all 36 allowlisted Android personal assistant tools', () => {
  assert.equal(ASSISTANT_TOOL_SPECS.length, 36);
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
    'click_youtube_video',
    'click_youtube_search_result',
    'click_visible_element',
    'click_whatsapp_contact',
    'open_whatsapp_chat',
    'type_whatsapp_message',
    'send_whatsapp_message',
    'verify_whatsapp_send',
    'answer_incoming_call',
    'reject_incoming_call',
    'end_active_call',
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

test('Category C: Explicit communication & device tools execute directly with requiresConfirmation=false and exact message preservation', () => {
  const wa = validateGeminiToolCall('prepare_whatsapp_message', {
    recipient: 'রাহুল',
    message: 'আমি আসছি',
  });
  assert.equal(wa.valid, true);
  assert.equal(wa.request?.requiresConfirmation, false);
  assert.equal(wa.request?.arguments.recipient, 'রাহুল');
  assert.equal(wa.request?.arguments.message, 'আমি আসছি');

  const sms = validateGeminiToolCall('prepare_sms', {
    recipient: 'বাবা',
    message: 'আমি বাড়ি ফিরছি',
  });
  assert.equal(sms.valid, true);
  assert.equal(sms.request?.requiresConfirmation, false);
  assert.equal(sms.request?.arguments.recipient, 'বাবা');
  assert.equal(sms.request?.arguments.message, 'আমি বাড়ি ফিরছি');

  const call = validateGeminiToolCall('call_contact', { recipient: 'মা' });
  assert.equal(call.valid, true);
  assert.equal(call.request?.requiresConfirmation, false);

  const appChat = validateGeminiToolCall('prepare_app_chat_message', {
    app_name: 'Telegram',
    recipient: 'রাহুল',
    message: 'আমি আসছি',
  });
  assert.equal(appChat.valid, true);
  assert.equal(appChat.request?.requiresConfirmation, false);
  assert.equal(appChat.request?.arguments.app_name, 'Telegram');

  const openApp = validateGeminiToolCall('open_app', { app_name: 'YouTube' });
  assert.equal(openApp.valid, true);
  assert.equal(openApp.request?.requiresConfirmation, false);

  const settings = validateGeminiToolCall('open_system_settings', { target: 'wifi' });
  assert.equal(settings.valid, true);
  assert.equal(settings.request?.requiresConfirmation, false);

  const webSearch = validateGeminiToolCall('search_web', { query: 'Dhaka weather' });
  assert.equal(webSearch.valid, true);
  assert.equal(webSearch.request?.requiresConfirmation, false);

  const ytSearch = validateGeminiToolCall('search_youtube', { query: 'Bengali song' });
  assert.equal(ytSearch.valid, true);
  assert.equal(ytSearch.request?.requiresConfirmation, false);
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

test('Category C, D & E: formatLocalizedActionOutcome enforces honest reporting for direct calls, SMS, WhatsApp, disambiguation, permissions, blocks, and cancellations', () => {
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
  assert.equal(verifiedSendOutcome.includes('অনুমোদনের পর'), false);
  assert.ok(verifiedSendOutcome.includes('ডেলিভারি'));

  const directCallOutcome = formatLocalizedActionOutcome(
    {
      actionId: 'a_call',
      actionType: 'call_contact',
      success: true,
      verified: true,
      status: 'call_initiated',
      message: 'Call initiated',
      data: { contactName: 'মা' },
    },
    'bn-BD',
    'Boss'
  );
  assert.ok(directCallOutcome.includes('মা'));
  assert.ok(directCallOutcome.includes('সরাসরি ফোন কল'));

  const directSmsOutcome = formatLocalizedActionOutcome(
    {
      actionId: 'a_sms',
      actionType: 'prepare_sms',
      success: true,
      verified: true,
      status: 'sms_sent_direct',
      message: 'SMS sent',
      data: { contactName: 'বাবা' },
    },
    'bn-BD',
    'Boss'
  );
  assert.ok(directSmsOutcome.includes('বাবা'));
  assert.ok(directSmsOutcome.includes('SMS'));

  const multipleContactsOutcome = formatLocalizedActionOutcome(
    {
      actionId: 'a_multi',
      actionType: 'call_contact',
      success: false,
      verified: true,
      status: 'multiple_contacts',
      message: 'Multiple contacts match',
      data: { query: 'রাহুল' },
    },
    'bn-BD',
    'Boss'
  );
  assert.ok(multipleContactsOutcome.includes('একাধিক কন্টাক্ট'));

  const dupBlockedOutcome = formatLocalizedActionOutcome(
    {
      actionId: 'a_dup',
      actionType: 'prepare_whatsapp_message',
      success: false,
      verified: true,
      status: 'duplicate_blocked',
      message: 'Duplicate prevented',
    },
    'bn-BD',
    'Boss'
  );
  assert.ok(dupBlockedOutcome.includes('ডুপ্লিকেট'));

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

test('Part 1 & 2: New YouTube Click and WhatsApp Smart Contact/Send tools validate cleanly and report honest outcomes', () => {
  const ytClick = validateGeminiToolCall('click_youtube_video', { index: 1, target: 'video_1' });
  assert.equal(ytClick.valid, true);
  assert.equal(ytClick.request?.requiresConfirmation, false);

  const waContact = validateGeminiToolCall('click_whatsapp_contact', { contact_name: 'রাহুল' });
  assert.equal(waContact.valid, true);
  assert.equal(waContact.request?.requiresConfirmation, false);

  const waType = validateGeminiToolCall('type_whatsapp_message', { message: 'আমি আসছি' });
  assert.equal(waType.valid, true);
  assert.equal(waType.request?.arguments.message, 'আমি আসছি');

  const waSend = validateGeminiToolCall('send_whatsapp_message', { recipient: 'রাহুল', message: 'আমি আসছি' });
  assert.equal(waSend.valid, true);
  assert.equal(waSend.request?.requiresConfirmation, false);

  const ytOpened = formatLocalizedActionOutcome(
    {
      actionId: 'yt1',
      actionType: 'click_youtube_video',
      target: 'Arijit Singh Bengali Hit Song',
      success: true,
      verified: true,
      status: 'youtube_video_opened',
      executionStatus: 'youtube_video_opened',
      message: 'Opened video',
    },
    'bn-BD',
    'Boss'
  );
  assert.ok(ytOpened.includes('YouTube'));
  assert.ok(ytOpened.includes('Arijit Singh Bengali Hit Song'));

  const ambigOut = formatLocalizedActionOutcome(
    {
      actionId: 'yt2',
      actionType: 'click_youtube_video',
      success: false,
      verified: true,
      status: 'ambiguous_target',
      message: 'Multiple matching videos',
    },
    'bn-BD',
    'Boss'
  );
  assert.ok(ambigOut.includes('একাধিক'));

  const typedNotSent = formatLocalizedActionOutcome(
    {
      actionId: 'wa_type',
      actionType: 'type_whatsapp_message',
      success: true,
      verified: true,
      status: 'whatsapp_message_typed_not_sent',
      message: 'Typed only',
    },
    'bn-BD',
    'Boss'
  );
  assert.ok(typedNotSent.includes('লিখে'));
  assert.ok(typedNotSent.includes('Send চাপা হয়নি'));

  const deliveredOut = formatLocalizedActionOutcome(
    {
      actionId: 'wa_del',
      actionType: 'send_whatsapp_message',
      target: 'রাহুল',
      success: true,
      verified: true,
      status: 'whatsapp_delivered_confirmed',
      message: 'Delivered',
    },
    'bn-BD',
    'Boss'
  );
  assert.ok(deliveredOut.includes('Delivered'));

  const pendingOut = formatLocalizedActionOutcome(
    {
      actionId: 'wa_pend',
      actionType: 'send_whatsapp_message',
      target: 'রাহুল',
      success: true,
      verified: true,
      status: 'whatsapp_sent_pending',
      message: 'Pending',
    },
    'bn-BD',
    'Boss'
  );
  assert.ok(pendingOut.includes('Pending'));

  const sendBtnMissing = formatLocalizedActionOutcome(
    {
      actionId: 'wa_nobtn',
      actionType: 'send_whatsapp_message',
      success: false,
      verified: true,
      status: 'send_button_not_found',
      message: 'Send button not found',
    },
    'bn-BD',
    'Boss'
  );
  assert.ok(sendBtnMissing.includes('Send'));
});

test('Incoming & Active Call Control tools validate cleanly and format honest Android Telecom outcomes', () => {
  for (const tool of ['answer_incoming_call', 'reject_incoming_call', 'end_active_call']) {
    const res = validateGeminiToolCall(tool, {});
    assert.equal(res.valid, true, `Expected ${tool} to validate`);
    assert.equal(res.request?.requiresConfirmation, false);
  }

  const answeredBn = formatLocalizedActionOutcome(
    {
      actionId: 'call_ans',
      actionType: 'answer_incoming_call',
      success: true,
      verified: true,
      status: 'call_answered',
      message: 'Call answered',
    },
    'bn-BD',
    'Boss'
  );
  assert.ok(answeredBn.includes('রিসিভ') || answeredBn.includes('কল'));

  const noIncomingEn = formatLocalizedActionOutcome(
    {
      actionId: 'call_none',
      actionType: 'answer_incoming_call',
      success: false,
      verified: true,
      status: 'no_incoming_call',
      message: 'No incoming call is ringing right now.',
    },
    'en-US',
    'Boss'
  );
  assert.ok(noIncomingEn.toLowerCase().includes('no incoming') || noIncomingEn.toLowerCase().includes('ringing'));
});

