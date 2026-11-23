import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildStructuredTaskPlan,
  formatHonestTaskOutcome,
  isToolAllowed,
} from './taskExecutionEngine.ts';

test('isToolAllowed accepts all personal assistant allowlisted tools and rejects shell/VoIP tools', () => {
  assert.equal(isToolAllowed('sim_call'), true);
  assert.equal(isToolAllowed('whatsapp_prepare'), true);
  assert.equal(isToolAllowed('screen_analyze'), true);
  assert.equal(isToolAllowed('notification_read'), true);
  assert.equal(isToolAllowed('accessibility_action'), true);
  assert.equal(isToolAllowed('camera_open'), true);
  assert.equal(isToolAllowed('volume_control'), true);
  assert.equal(isToolAllowed('ai_voip_call'), false);
  assert.equal(isToolAllowed('exec_shell'), false);
  assert.equal(isToolAllowed('bash'), false);
});

test('buildStructuredTaskPlan blocks arbitrary shell commands', () => {
  const plan = buildStructuredTaskPlan('please run rm -rf / on my device');
  assert.equal(plan.steps.length, 0);
  assert.ok(plan.blockedReason && plan.blockedReason.toLowerCase().includes('blocked'));
});

test('buildStructuredTaskPlan parses multi-step Bengali & English instructions', () => {
  const plan = buildStructuredTaskPlan('টর্চ লাইট জ্বালাও এবং YouTube খোলো');
  assert.equal(plan.steps.length, 2);
  assert.equal(plan.steps[0].tool, 'flashlight');
  assert.equal(plan.steps[0].args.enable, true);
  assert.equal(plan.steps[1].tool, 'open_app');
  assert.equal(String(plan.steps[1].args.appQuery).toLowerCase(), 'youtube');
  assert.equal(plan.requiresConfirmation, false);
});

test('buildStructuredTaskPlan routes both numeric and contact-name calls to direct SIM calling with NO routine confirmation', () => {
  const numPlan = buildStructuredTaskPlan('কল করো 01712345678');
  assert.equal(numPlan.steps.length, 1);
  assert.equal(numPlan.steps[0].tool, 'sim_call');
  assert.equal(numPlan.steps[0].args.phoneNumber, '01712345678');
  assert.equal(numPlan.requiresConfirmation, false);

  const enContact = buildStructuredTaskPlan('ZONI, call my father');
  assert.equal(enContact.steps.length, 1);
  assert.equal(enContact.steps[0].tool, 'sim_call');
  assert.equal(enContact.steps[0].args.contactQuery, 'father');
  assert.equal(enContact.requiresConfirmation, false);

  const bnContact = buildStructuredTaskPlan('বাবাকে কল করো');
  assert.equal(bnContact.steps.length, 1);
  assert.equal(bnContact.steps[0].tool, 'sim_call');
  assert.equal(bnContact.steps[0].args.contactQuery, 'বাবা');
  assert.equal(bnContact.requiresConfirmation, false);

  const bnMother = buildStructuredTaskPlan('মাকে ফোন করো');
  assert.equal(bnMother.steps.length, 1);
  assert.equal(bnMother.steps[0].tool, 'sim_call');
  assert.equal(bnMother.steps[0].args.contactQuery, 'মা');
  assert.equal(bnMother.requiresConfirmation, false);

  const bnMyMother = buildStructuredTaskPlan('আমার মাকে ফোন করো।');
  assert.equal(bnMyMother.steps.length, 1);
  assert.equal(bnMyMother.steps[0].tool, 'sim_call');
  assert.equal(bnMyMother.steps[0].args.contactQuery, 'মা');
  assert.equal(bnMyMother.requiresConfirmation, false);

  const hiContact = buildStructuredTaskPlan('पापा को कॉल करो');
  assert.equal(hiContact.steps.length, 1);
  assert.equal(hiContact.steps[0].tool, 'sim_call');
  assert.equal(hiContact.steps[0].args.contactQuery, 'पापा');
  assert.equal(hiContact.requiresConfirmation, false);
});

test('buildStructuredTaskPlan parses Bengali, English, and Hindi WhatsApp and SMS commands for direct execution without confirmation', () => {
  const plan = buildStructuredTaskPlan('ZONI, send a WhatsApp message to Rahul saying I am coming');
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0].tool, 'whatsapp_prepare');
  assert.equal(plan.steps[0].args.contactQuery, 'Rahul');
  assert.equal(plan.steps[0].args.message, 'I am coming');
  assert.equal(plan.requiresConfirmation, false);

  const enRecipientFirst = buildStructuredTaskPlan(
    'Send Rahul a WhatsApp message saying I will arrive in 10 minutes.'
  );
  assert.equal(enRecipientFirst.steps.length, 1);
  assert.equal(enRecipientFirst.steps[0].tool, 'whatsapp_prepare');
  assert.equal(enRecipientFirst.steps[0].args.contactQuery, 'Rahul');
  assert.equal(enRecipientFirst.steps[0].args.message, 'I will arrive in 10 minutes');
  assert.equal(enRecipientFirst.requiresConfirmation, false);

  const bnPlan = buildStructuredTaskPlan('রাহুলকে WhatsApp-এ মেসেজ পাঠাও: আমি আসছি');
  assert.equal(bnPlan.steps.length, 1);
  assert.equal(bnPlan.steps[0].tool, 'whatsapp_prepare');
  assert.equal(bnPlan.steps[0].args.contactQuery, 'রাহুল');
  assert.equal(bnPlan.steps[0].args.message, 'আমি আসছি');
  assert.equal(bnPlan.requiresConfirmation, false);

  const bnMotherWa = buildStructuredTaskPlan('মাকে WhatsApp-এ বলো আমি বাড়ি ফিরছি।');
  assert.equal(bnMotherWa.steps.length, 1);
  assert.equal(bnMotherWa.steps[0].tool, 'whatsapp_prepare');
  assert.equal(bnMotherWa.steps[0].args.contactQuery, 'মা');
  assert.equal(bnMotherWa.steps[0].args.message, 'আমি বাড়ি ফিরছি');
  assert.equal(bnMotherWa.requiresConfirmation, false);

  const bnDraftOnly = buildStructuredTaskPlan('রাহুলকে একটা মেসেজ লিখে দাও।');
  assert.equal(bnDraftOnly.steps.length, 1);
  assert.equal(bnDraftOnly.steps[0].tool, 'whatsapp_prepare');
  assert.equal(bnDraftOnly.steps[0].args.contactQuery, 'রাহুল');
  assert.equal(bnDraftOnly.requiresConfirmation, false);

  // Direct SMS commands (Bengali, English, Hindi) preserving exact message text
  const bnSms = buildStructuredTaskPlan('বাবাকে SMS পাঠাও: আমি বাড়ি ফিরছি');
  assert.equal(bnSms.steps.length, 1);
  assert.equal(bnSms.steps[0].tool, 'sms_compose');
  assert.equal(bnSms.steps[0].args.contactQuery, 'বাবা');
  assert.equal(bnSms.steps[0].args.message, 'আমি বাড়ি ফিরছি');
  assert.equal(bnSms.requiresConfirmation, false);

  const enSms = buildStructuredTaskPlan('Send an SMS to Baba saying I am coming home');
  assert.equal(enSms.steps.length, 1);
  assert.equal(enSms.steps[0].tool, 'sms_compose');
  assert.equal(enSms.steps[0].args.contactQuery, 'Baba');
  assert.equal(enSms.steps[0].args.message, 'I am coming home');
  assert.equal(enSms.requiresConfirmation, false);

  const hiSms = buildStructuredTaskPlan('पापा को SMS भेजो: मैं घर आ रहा हूँ');
  assert.equal(hiSms.steps.length, 1);
  assert.equal(hiSms.steps[0].tool, 'sms_compose');
  assert.equal(hiSms.steps[0].args.contactQuery, 'पापा');
  assert.equal(hiSms.steps[0].args.message, 'मैं घर आ रहा हूँ');
  assert.equal(hiSms.requiresConfirmation, false);
});

test('buildStructuredTaskPlan handles all 9 Bengali personal assistant voice commands and draft review/approval', () => {
  const openWa = buildStructuredTaskPlan('জনি, WhatsApp খোলো।');
  assert.equal(openWa.steps[0]?.tool, 'open_app');
  assert.equal(String(openWa.steps[0]?.args.appQuery).toLowerCase(), 'whatsapp');

  const ytSearch = buildStructuredTaskPlan('ইউটিউবে গান খুঁজে দাও।');
  assert.equal(ytSearch.steps[0]?.tool, 'app_search_workflow');
  assert.equal(ytSearch.steps[0]?.args.appQuery, 'YouTube');
  assert.equal(ytSearch.steps[0]?.args.searchQuery, 'গান');

  const phoneSettings = buildStructuredTaskPlan('ফোনের সেটিংস খোলো।');
  assert.equal(phoneSettings.steps[0]?.tool, 'open_settings');
  assert.equal(phoneSettings.steps[0]?.args.target, 'main');

  const scrollDown = buildStructuredTaskPlan('নিচে স্ক্রল করো।');
  assert.equal(scrollDown.steps[0]?.tool, 'accessibility_action');
  assert.equal(scrollDown.steps[0]?.args.command, 'scroll_down');

  const readScreen = buildStructuredTaskPlan('এই স্ক্রিনে কী আছে পড়ে শোনাও।');
  assert.equal(readScreen.steps[0]?.tool, 'screen_analyze');

  const reviewDraft = buildStructuredTaskPlan('মেসেজটা পাঠানোর আগে আমাকে দেখাও।');
  assert.equal(reviewDraft.steps[0]?.tool, 'review_pending_draft');

  const approveDraft = buildStructuredTaskPlan('এখন পাঠানোর অনুমতি দিলাম।');
  assert.equal(approveDraft.steps[0]?.tool, 'approve_pending_action');

  const listApps = buildStructuredTaskPlan('ইনস্টলড অ্যাপ দেখাও।');
  assert.equal(listApps.steps[0]?.tool, 'list_installed_apps');

  const cancelBn = buildStructuredTaskPlan('এখন আগের কাজটা বন্ধ করো।');
  assert.equal(cancelBn.steps[0]?.tool, 'cancel_current_task');

  const cancelEn = buildStructuredTaskPlan('Cancel current task');
  assert.equal(cancelEn.steps[0]?.tool, 'cancel_current_task');
});

test('buildStructuredTaskPlan classifies screen awareness, notifications, accessibility, camera, volume, and settings', () => {
  assert.equal(buildStructuredTaskPlan('What is on my screen?').steps[0]?.tool, 'screen_analyze');
  assert.equal(buildStructuredTaskPlan('স্ক্রিনে কী আছে?').steps[0]?.tool, 'screen_analyze');
  assert.equal(buildStructuredTaskPlan('Read my notifications').steps[0]?.tool, 'notification_read');
  assert.equal(buildStructuredTaskPlan('আমার নোটিফিকেশন পড়ো').steps[0]?.tool, 'notification_read');
  assert.equal(buildStructuredTaskPlan('Scroll down').steps[0]?.tool, 'accessibility_action');
  assert.equal(buildStructuredTaskPlan('Scroll down').steps[0]?.args.command, 'scroll_down');
  assert.equal(buildStructuredTaskPlan('Go back').steps[0]?.args.command, 'back');
  assert.equal(buildStructuredTaskPlan('Open camera').steps[0]?.tool, 'camera_open');
  assert.equal(buildStructuredTaskPlan('ভলিউম বাড়াও').steps[0]?.tool, 'volume_control');
  assert.equal(buildStructuredTaskPlan('ভলিউম বাড়াও').steps[0]?.args.action, 'up');
  assert.equal(buildStructuredTaskPlan('Open location settings').steps[0]?.tool, 'open_settings');
  assert.equal(buildStructuredTaskPlan('Open location settings').steps[0]?.args.target, 'location');
  assert.equal(buildStructuredTaskPlan('সাউন্ড সেটিংস খোলো').steps[0]?.args.target, 'sound');
  assert.equal(buildStructuredTaskPlan('অ্যাপ সেটিংস খোলো').steps[0]?.args.target, 'applications');
  assert.equal(buildStructuredTaskPlan('নেটওয়ার্ক সেটিংস খোলো').steps[0]?.args.target, 'network');
});

test('buildStructuredTaskPlan leaves ordinary Bengali & English conversation empty for normal Gemini AI chat', () => {
  for (const chat of [
    'What is photosynthesis?',
    'তুমি কেমন আছো?',
    'আজকের দিনটা কেমন?',
    'আমাকে একটা মিষ্টি গল্প বলো।',
    'Tell me a motivational quote',
  ]) {
    const plan = buildStructuredTaskPlan(chat);
    assert.equal(plan.steps.length, 0, `Expected ordinary chat "${chat}" not to trigger device action`);
    assert.equal(plan.blockedReason, undefined);
  }
});

test('Category A & B: buildStructuredTaskPlan handles natural Bengali, English, and Hindi app launch commands', () => {
  const cases: Array<[string, string]> = [
    ['WhatsApp খুলে দাও', 'whatsapp'],
    ['হোয়াটসঅ্যাপ ওপেন করো', 'হোয়াটসঅ্যাপ'],
    ['ফেসবুকটা খুলে দাও', 'ফেসবুক'],
    ['ইউটিউব চালু করো', 'ইউটিউব'],
    ['আমার ফোনে থাকা Chrome চালু করো', 'chrome'],
    ['Open WhatsApp', 'whatsapp'],
    ['Open Instagram for me', 'instagram'],
    ['Launch Calculator', 'calculator'],
    ['व्हाट्सएप खोलो', 'व्हाट्सएप'],
    ['यूट्यूब चालू करो', 'यूट्यूब'],
  ];

  for (const [utterance, expectedTarget] of cases) {
    const plan = buildStructuredTaskPlan(utterance);
    assert.equal(plan.steps.length, 1, `Expected 1 step for "${utterance}"`);
    assert.equal(plan.steps[0].tool, 'open_app', `Expected open_app for "${utterance}"`);
    assert.equal(
      String(plan.steps[0].args.appQuery || '').toLowerCase(),
      expectedTarget,
      `Mismatch for "${utterance}"`
    );
  }
});

test('Category C: buildStructuredTaskPlan handles natural Bengali, English, and Hindi WhatsApp messaging directly without confirmation', () => {
  const waFirstBn = buildStructuredTaskPlan('WhatsApp-এ রাহুলকে একটা মেসেজ পাঠিয়ে দাও।');
  assert.equal(waFirstBn.steps[0]?.tool, 'whatsapp_prepare');
  assert.equal(waFirstBn.steps[0]?.args.contactQuery, 'রাহুল');
  assert.equal(waFirstBn.steps[0]?.args.message, '');
  assert.equal(waFirstBn.requiresConfirmation, false);

  const waColonBn = buildStructuredTaskPlan('রাহুলকে WhatsApp মেসেজ পাঠাও: আমি আসছি');
  assert.equal(waColonBn.steps[0]?.tool, 'whatsapp_prepare');
  assert.equal(waColonBn.steps[0]?.args.contactQuery, 'রাহুল');
  assert.equal(waColonBn.steps[0]?.args.message, 'আমি আসছি');
  assert.equal(waColonBn.requiresConfirmation, false);

  const waMotherEmpty = buildStructuredTaskPlan('মাকে একটা মেসেজ লিখে দাও');
  assert.equal(waMotherEmpty.steps[0]?.tool, 'whatsapp_prepare');
  assert.equal(waMotherEmpty.steps[0]?.args.contactQuery, 'মা');
  assert.equal(waMotherEmpty.steps[0]?.args.message, '');

  const enNoBody = buildStructuredTaskPlan('Send a WhatsApp message to Rahul');
  assert.equal(enNoBody.steps[0]?.tool, 'whatsapp_prepare');
  assert.equal(enNoBody.steps[0]?.args.contactQuery, 'Rahul');
  assert.equal(enNoBody.steps[0]?.args.message, '');

  const enOnWa = buildStructuredTaskPlan('Message Rahul on WhatsApp saying I am coming');
  assert.equal(enOnWa.steps[0]?.tool, 'whatsapp_prepare');
  assert.equal(enOnWa.steps[0]?.args.contactQuery, 'Rahul');
  assert.equal(enOnWa.steps[0]?.args.message, 'I am coming');

  const hiWa = buildStructuredTaskPlan('राहुल को व्हाट्सएप मैसेज भेजो कि मैं आ रहा हूँ');
  assert.equal(hiWa.steps[0]?.tool, 'whatsapp_prepare');
  assert.equal(hiWa.steps[0]?.args.contactQuery, 'राहुल');
  assert.equal(hiWa.steps[0]?.args.message, 'मैं आ रहा हूँ');
});

test('Category E: buildStructuredTaskPlan parses supported generic app chat commands (Telegram, Instagram, Messenger) directly without confirmation', () => {
  const tgBn = buildStructuredTaskPlan('টেলিগ্রামে রাহুলকে মেসেজ পাঠাও: আমি আসছি');
  assert.equal(tgBn.steps[0]?.tool, 'app_chat_prepare');
  assert.equal(tgBn.steps[0]?.args.appName, 'Telegram');
  assert.equal(tgBn.steps[0]?.args.contactQuery, 'রাহুল');
  assert.equal(tgBn.steps[0]?.args.message, 'আমি আসছি');
  assert.equal(tgBn.requiresConfirmation, false);

  const igEn = buildStructuredTaskPlan('Message Riya on Instagram saying hello there');
  assert.equal(igEn.steps[0]?.tool, 'app_chat_prepare');
  assert.equal(igEn.steps[0]?.args.appName, 'Instagram');
  assert.equal(igEn.steps[0]?.args.contactQuery, 'Riya');
  assert.equal(igEn.steps[0]?.args.message, 'hello there');
  assert.equal(igEn.requiresConfirmation, false);

  const msEn = buildStructuredTaskPlan('Send a message to Rahul on Messenger saying call me');
  assert.equal(msEn.steps[0]?.tool, 'app_chat_prepare');
  assert.equal(msEn.steps[0]?.args.appName, 'Messenger');
  assert.equal(msEn.steps[0]?.args.contactQuery, 'Rahul');
  assert.equal(msEn.steps[0]?.args.message, 'call me');
  assert.equal(msEn.requiresConfirmation, false);
});

test('formatHonestTaskOutcome never claims WhatsApp message was automatically sent', () => {
  const msg = formatHonestTaskOutcome('whatsapp_prepare', true);
  assert.ok(msg.includes('WhatsApp'));
  assert.ok(msg.includes('Send'));
  assert.equal(msg.includes('পাঠানো হয়ে গেছে'), false);
});

test('Part 1: buildStructuredTaskPlan parses all Bengali, English, and Hindi YouTube click commands cleanly', () => {
  // Bengali commands
  const bn1 = buildStructuredTaskPlan('প্রথম ভিডিওটি চালাও।');
  assert.equal(bn1.steps[0]?.tool, 'click_youtube_video');
  assert.equal(bn1.steps[0]?.args.index, 1);
  assert.equal(bn1.requiresConfirmation, false);

  const bn2 = buildStructuredTaskPlan('দ্বিতীয় ভিডিওতে ক্লিক করো।');
  assert.equal(bn2.steps[0]?.tool, 'click_youtube_video');
  assert.equal(bn2.steps[0]?.args.index, 2);

  const bnThis = buildStructuredTaskPlan('এই ভিডিওটা ওপেন করো।');
  assert.equal(bnThis.steps[0]?.tool, 'click_youtube_video');
  assert.equal(bnThis.steps[0]?.args.target, 'current_video');

  const bnPlay = buildStructuredTaskPlan('Play Button চাপো।');
  assert.equal(bnPlay.steps[0]?.tool, 'click_youtube_video');
  assert.equal(bnPlay.steps[0]?.args.target, 'play_button');

  const bnSearchRes = buildStructuredTaskPlan('প্রথম সার্চ রেজাল্টে ক্লিক করো।');
  assert.equal(bnSearchRes.steps[0]?.tool, 'click_youtube_search_result');
  assert.equal(bnSearchRes.steps[0]?.args.index, 1);

  const bnThumb = buildStructuredTaskPlan('এই ভিডিওর Thumbnail-এ ক্লিক করো।');
  assert.equal(bnThumb.steps[0]?.tool, 'click_youtube_video');
  assert.equal(bnThumb.steps[0]?.args.target, 'thumbnail');

  // English commands
  const en1 = buildStructuredTaskPlan('Play the first video');
  assert.equal(en1.steps[0]?.tool, 'click_youtube_video');
  assert.equal(en1.steps[0]?.args.index, 1);

  const en2 = buildStructuredTaskPlan('Click the second video');
  assert.equal(en2.steps[0]?.tool, 'click_youtube_video');
  assert.equal(en2.steps[0]?.args.index, 2);

  const enThis = buildStructuredTaskPlan('Open this video');
  assert.equal(enThis.steps[0]?.tool, 'click_youtube_video');
  assert.equal(enThis.steps[0]?.args.target, 'current_video');

  const enPlay = buildStructuredTaskPlan('Click the Play button');
  assert.equal(enPlay.steps[0]?.tool, 'click_youtube_video');
  assert.equal(enPlay.steps[0]?.args.target, 'play_button');

  const enSearchRes = buildStructuredTaskPlan('Open the first search result');
  assert.equal(enSearchRes.steps[0]?.tool, 'click_youtube_search_result');
  assert.equal(enSearchRes.steps[0]?.args.index, 1);

  // Hindi commands
  const hi1 = buildStructuredTaskPlan('पहला वीडियो चलाओ');
  assert.equal(hi1.steps[0]?.tool, 'click_youtube_video');
  assert.equal(hi1.steps[0]?.args.index, 1);

  const hi2 = buildStructuredTaskPlan('दूसरे वीडियो पर क्लिक करो');
  assert.equal(hi2.steps[0]?.tool, 'click_youtube_video');
  assert.equal(hi2.steps[0]?.args.index, 2);

  const hiThis = buildStructuredTaskPlan('इस वीडियो को खोलो');
  assert.equal(hiThis.steps[0]?.tool, 'click_youtube_video');
  assert.equal(hiThis.steps[0]?.args.target, 'current_video');
});

test('Part 2: buildStructuredTaskPlan parses all Bengali, English, and Hindi WhatsApp Smart Contact Click & Type-Only commands', () => {
  // Bengali
  const bnRahul = buildStructuredTaskPlan('WhatsApp-এ রাহুলের নামের উপর ক্লিক করো।');
  assert.equal(bnRahul.steps[0]?.tool, 'click_whatsapp_contact');
  assert.equal(bnRahul.steps[0]?.args.contactName, 'রাহুল');
  assert.equal(bnRahul.requiresConfirmation, false);

  const bnMaChat = buildStructuredTaskPlan('মায়ের Chat ওপেন করো।');
  assert.equal(bnMaChat.steps[0]?.tool, 'open_whatsapp_chat');
  assert.equal(bnMaChat.steps[0]?.args.contactName, 'মা');

  const bnBabaFind = buildStructuredTaskPlan('WhatsApp-এ বাবাকে খুঁজে বের করো।');
  assert.equal(bnBabaFind.steps[0]?.tool, 'click_whatsapp_contact');
  assert.equal(bnBabaFind.steps[0]?.args.contactName, 'বাবা');

  const bnThisContact = buildStructuredTaskPlan('এই Contact-এর নামের উপর ক্লিক করো।');
  assert.equal(bnThisContact.steps[0]?.tool, 'click_whatsapp_contact');
  assert.equal(bnThisContact.steps[0]?.args.index, 1);

  const bnSecondName = buildStructuredTaskPlan('নিচের দ্বিতীয় নামটিতে ক্লিক করো।');
  assert.equal(bnSecondName.steps[0]?.tool, 'click_whatsapp_contact');
  assert.equal(bnSecondName.steps[0]?.args.index, 2);

  const bnFirstChat = buildStructuredTaskPlan('প্রথম Chat ওপেন করো।');
  assert.equal(bnFirstChat.steps[0]?.tool, 'open_whatsapp_chat');
  assert.equal(bnFirstChat.steps[0]?.args.index, 1);

  const bnJahida = buildStructuredTaskPlan('জাহিদার Chat খুলে দাও।');
  assert.equal(bnJahida.steps[0]?.tool, 'open_whatsapp_chat');
  assert.equal(bnJahida.steps[0]?.args.contactName, 'জাহিদা');

  // English
  const enRahul = buildStructuredTaskPlan("Click Rahul's name in WhatsApp");
  assert.equal(enRahul.steps[0]?.tool, 'click_whatsapp_contact');
  assert.equal(enRahul.steps[0]?.args.contactName, 'Rahul');

  const enMother = buildStructuredTaskPlan("Open my mother's chat");
  assert.equal(enMother.steps[0]?.tool, 'open_whatsapp_chat');
  assert.equal(enMother.steps[0]?.args.contactName, 'mother');

  const enFind = buildStructuredTaskPlan('Find this contact in WhatsApp');
  assert.equal(enFind.steps[0]?.tool, 'click_whatsapp_contact');
  assert.equal(enFind.steps[0]?.args.index, 1);

  const enSecond = buildStructuredTaskPlan('Click the second contact');
  assert.equal(enSecond.steps[0]?.tool, 'click_whatsapp_contact');
  assert.equal(enSecond.steps[0]?.args.index, 2);

  const enFirstChat = buildStructuredTaskPlan('Open the first chat');
  assert.equal(enFirstChat.steps[0]?.tool, 'open_whatsapp_chat');
  assert.equal(enFirstChat.steps[0]?.args.index, 1);

  // Hindi
  const hiRahul = buildStructuredTaskPlan('WhatsApp में राहुल के नाम पर क्लिक करो');
  assert.equal(hiRahul.steps[0]?.tool, 'click_whatsapp_contact');
  assert.equal(hiRahul.steps[0]?.args.contactName, 'राहुल');

  const hiMa = buildStructuredTaskPlan('मेरी माँ की चैट खोलो');
  assert.equal(hiMa.steps[0]?.tool, 'open_whatsapp_chat');
  assert.equal(hiMa.steps[0]?.args.contactName, 'माँ');

  const hiSecondChat = buildStructuredTaskPlan('दूसरा चैट खोलो');
  assert.equal(hiSecondChat.steps[0]?.tool, 'open_whatsapp_chat');
  assert.equal(hiSecondChat.steps[0]?.args.index, 2);

  // Type-only separation (typing alone must NOT invoke send)
  const bnTypeOnly = buildStructuredTaskPlan('WhatsApp-এ শুধু টাইপ করো: আমি আসছি');
  assert.equal(bnTypeOnly.steps[0]?.tool, 'type_whatsapp_message');
  assert.equal(bnTypeOnly.steps[0]?.args.message, 'আমি আসছি');

  const enTypeOnly = buildStructuredTaskPlan('Type in WhatsApp: On my way');
  assert.equal(enTypeOnly.steps[0]?.tool, 'type_whatsapp_message');
  assert.equal(enTypeOnly.steps[0]?.args.message, 'On my way');
});

test('Incoming & Active Call Control: parses strict Bengali, English, and Hindi call-control commands without false triggers', () => {
  // Answer incoming call
  assert.equal(buildStructuredTaskPlan('কল রিসিভ করো').steps[0]?.tool, 'answer_incoming_call');
  assert.equal(buildStructuredTaskPlan('ফোন ধরো').steps[0]?.tool, 'answer_incoming_call');
  assert.equal(buildStructuredTaskPlan('Answer the call').steps[0]?.tool, 'answer_incoming_call');
  assert.equal(buildStructuredTaskPlan('Pick up the call').steps[0]?.tool, 'answer_incoming_call');
  assert.equal(buildStructuredTaskPlan('कॉल उठाओ').steps[0]?.tool, 'answer_incoming_call');

  // Reject incoming call
  assert.equal(buildStructuredTaskPlan('ইনকামিং কল কেটে দাও').steps[0]?.tool, 'reject_incoming_call');
  assert.equal(buildStructuredTaskPlan('Reject the call').steps[0]?.tool, 'reject_incoming_call');
  assert.equal(buildStructuredTaskPlan('Decline incoming call').steps[0]?.tool, 'reject_incoming_call');
  assert.equal(buildStructuredTaskPlan('इनकमिंग कॉल काट दो').steps[0]?.tool, 'reject_incoming_call');

  // End active call
  assert.equal(buildStructuredTaskPlan('কল কেটে দাও').steps[0]?.tool, 'end_active_call');
  assert.equal(buildStructuredTaskPlan('End the call').steps[0]?.tool, 'end_active_call');
  assert.equal(buildStructuredTaskPlan('Hang up').steps[0]?.tool, 'end_active_call');
  assert.equal(buildStructuredTaskPlan('कॉल बंद करो').steps[0]?.tool, 'end_active_call');

  // Wake prefix "জোনি" stripped cleanly before command
  const wakeCall = buildStructuredTaskPlan('জোনি, কল রিসিভ করো');
  assert.equal(wakeCall.steps[0]?.tool, 'answer_incoming_call');

  // Ordinary unrelated sentences must NOT trigger call control
  assert.equal(buildStructuredTaskPlan('Tell me about how phone calls work').steps.length, 0);
  assert.equal(buildStructuredTaskPlan('আজকে অনেক কল এসেছে').steps.length, 0);
});

test('Perfect Volume Control: parses exact percentages (Bengali/Hindi/English), clamping, all 5 streams, mute/unmute/max/status', () => {
  const bnPct = buildStructuredTaskPlan('ভলিউম ৫০ শতাংশ করো');
  assert.equal(bnPct.steps[0]?.tool, 'volume_control');
  assert.equal(bnPct.steps[0]?.args.action, 'set');
  assert.equal(bnPct.steps[0]?.args.percent, 50);
  assert.equal(bnPct.steps[0]?.args.stream, 'media');

  const enRingPct = buildStructuredTaskPlan('Set ring volume to 80%');
  assert.equal(enRingPct.steps[0]?.tool, 'volume_control');
  assert.equal(enRingPct.steps[0]?.args.action, 'set');
  assert.equal(enRingPct.steps[0]?.args.percent, 80);
  assert.equal(enRingPct.steps[0]?.args.stream, 'ring');

  const hiAlarmPct = buildStructuredTaskPlan('अलार्म वॉल्यूम ७५% करो');
  assert.equal(hiAlarmPct.steps[0]?.tool, 'volume_control');
  assert.equal(hiAlarmPct.steps[0]?.args.action, 'set');
  assert.equal(hiAlarmPct.steps[0]?.args.percent, 75);
  assert.equal(hiAlarmPct.steps[0]?.args.stream, 'alarm');

  const clampedOver = buildStructuredTaskPlan('Set media volume to 140%');
  assert.equal(clampedOver.steps[0]?.tool, 'volume_control');
  assert.equal(clampedOver.steps[0]?.args.action, 'set');
  assert.equal(clampedOver.steps[0]?.args.percent, 100);

  const callVolUp = buildStructuredTaskPlan('Increase call volume');
  assert.equal(callVolUp.steps[0]?.tool, 'volume_control');
  assert.equal(callVolUp.steps[0]?.args.action, 'up');
  assert.equal(callVolUp.steps[0]?.args.stream, 'call');

  const notifMute = buildStructuredTaskPlan('Mute notification volume');
  assert.equal(notifMute.steps[0]?.tool, 'volume_control');
  assert.equal(notifMute.steps[0]?.args.action, 'mute');
  assert.equal(notifMute.steps[0]?.args.stream, 'notification');

  const unmutePhone = buildStructuredTaskPlan('Unmute phone');
  assert.equal(unmutePhone.steps[0]?.tool, 'volume_control');
  assert.equal(unmutePhone.steps[0]?.args.action, 'unmute');

  const maxVol = buildStructuredTaskPlan('ভলিউম ফুল করো');
  assert.equal(maxVol.steps[0]?.tool, 'volume_control');
  assert.equal(maxVol.steps[0]?.args.action, 'max');
});

test('Advanced App UI Control: parses YouTube Play/Pause/Stop and Facebook/Bengali button clicks cleanly', () => {
  const bnPause = buildStructuredTaskPlan('ভিডিওটি Pause করো');
  assert.equal(bnPause.steps[0]?.tool, 'click_youtube_video');
  assert.equal(bnPause.steps[0]?.args.target, 'pause_video');

  const enPause = buildStructuredTaskPlan('Pause the video');
  assert.equal(enPause.steps[0]?.tool, 'click_youtube_video');
  assert.equal(enPause.steps[0]?.args.target, 'pause_video');

  const bnStop = buildStructuredTaskPlan('ভিডিওটি Stop করো');
  assert.equal(bnStop.steps[0]?.tool, 'click_youtube_video');
  assert.equal(bnStop.steps[0]?.args.target, 'stop_video');

  const enStop = buildStructuredTaskPlan('Stop the video');
  assert.equal(enStop.steps[0]?.tool, 'click_youtube_video');
  assert.equal(enStop.steps[0]?.args.target, 'stop_video');

  const bnResume = buildStructuredTaskPlan('ভিডিও আবার চালাও');
  assert.equal(bnResume.steps[0]?.tool, 'click_youtube_video');
  assert.equal(bnResume.steps[0]?.args.target, 'play_video');

  const fbLikeBn = buildStructuredTaskPlan('Facebook-এ Like বাটনে ক্লিক করো');
  assert.equal(fbLikeBn.steps[0]?.tool, 'accessibility_action');
  assert.equal(fbLikeBn.steps[0]?.args.command, 'tap:Like');

  const fbCommentEn = buildStructuredTaskPlan('Tap Comment on Facebook');
  assert.equal(fbCommentEn.steps[0]?.tool, 'accessibility_action');
  assert.equal(fbCommentEn.steps[0]?.args.command, 'tap:Comment');
});
