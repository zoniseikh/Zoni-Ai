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

test('buildStructuredTaskPlan routes both numeric and contact-name calls to SIM calling with mandatory confirmation', () => {
  const numPlan = buildStructuredTaskPlan('কল করো 01712345678');
  assert.equal(numPlan.steps.length, 1);
  assert.equal(numPlan.steps[0].tool, 'sim_call');
  assert.equal(numPlan.steps[0].args.phoneNumber, '01712345678');
  assert.equal(numPlan.requiresConfirmation, true);

  const enContact = buildStructuredTaskPlan('ZONI, call my father');
  assert.equal(enContact.steps.length, 1);
  assert.equal(enContact.steps[0].tool, 'sim_call');
  assert.equal(enContact.steps[0].args.contactQuery, 'father');
  assert.equal(enContact.requiresConfirmation, true);

  const bnContact = buildStructuredTaskPlan('বাবাকে কল করো');
  assert.equal(bnContact.steps.length, 1);
  assert.equal(bnContact.steps[0].tool, 'sim_call');
  assert.equal(bnContact.steps[0].args.contactQuery, 'বাবা');

  const bnMother = buildStructuredTaskPlan('আমার মাকে ফোন করো।');
  assert.equal(bnMother.steps.length, 1);
  assert.equal(bnMother.steps[0].tool, 'sim_call');
  assert.equal(bnMother.steps[0].args.contactQuery, 'মা');
  assert.equal(bnMother.requiresConfirmation, true);

  const hiContact = buildStructuredTaskPlan('पापा को कॉल करो');
  assert.equal(hiContact.steps.length, 1);
  assert.equal(hiContact.steps[0].tool, 'sim_call');
  assert.equal(hiContact.steps[0].args.contactQuery, 'पापा');
});

test('buildStructuredTaskPlan parses Bengali, English, and Hindi WhatsApp drafts with mandatory confirmation', () => {
  const plan = buildStructuredTaskPlan('ZONI, send a WhatsApp message to Rahul saying I am coming');
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0].tool, 'whatsapp_prepare');
  assert.equal(plan.steps[0].args.contactQuery, 'Rahul');
  assert.equal(plan.steps[0].args.message, 'I am coming');
  assert.equal(plan.requiresConfirmation, true);

  const enRecipientFirst = buildStructuredTaskPlan(
    'Send Rahul a WhatsApp message saying I will arrive in 10 minutes.'
  );
  assert.equal(enRecipientFirst.steps.length, 1);
  assert.equal(enRecipientFirst.steps[0].tool, 'whatsapp_prepare');
  assert.equal(enRecipientFirst.steps[0].args.contactQuery, 'Rahul');
  assert.equal(enRecipientFirst.steps[0].args.message, 'I will arrive in 10 minutes');
  assert.equal(enRecipientFirst.requiresConfirmation, true);

  const bnPlan = buildStructuredTaskPlan('রাহুলকে WhatsApp-এ মেসেজ পাঠাও: আমি আজ আসতে পারব না।');
  assert.equal(bnPlan.steps.length, 1);
  assert.equal(bnPlan.steps[0].tool, 'whatsapp_prepare');
  assert.equal(bnPlan.steps[0].args.contactQuery, 'রাহুল');
  assert.equal(bnPlan.steps[0].args.message, 'আমি আজ আসতে পারব না');
  assert.equal(bnPlan.requiresConfirmation, true);

  const bnMotherWa = buildStructuredTaskPlan('মাকে WhatsApp-এ বলো আমি বাড়ি ফিরছি।');
  assert.equal(bnMotherWa.steps.length, 1);
  assert.equal(bnMotherWa.steps[0].tool, 'whatsapp_prepare');
  assert.equal(bnMotherWa.steps[0].args.contactQuery, 'মা');
  assert.equal(bnMotherWa.steps[0].args.message, 'আমি বাড়ি ফিরছি');

  const bnDraftOnly = buildStructuredTaskPlan('রাহুলকে একটা মেসেজ লিখে দাও।');
  assert.equal(bnDraftOnly.steps.length, 1);
  assert.equal(bnDraftOnly.steps[0].tool, 'whatsapp_prepare');
  assert.equal(bnDraftOnly.steps[0].args.contactQuery, 'রাহুল');
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

test('Category C: buildStructuredTaskPlan handles natural Bengali, English, and Hindi WhatsApp messaging including empty bodies', () => {
  const waFirstBn = buildStructuredTaskPlan('WhatsApp-এ রাহুলকে একটা মেসেজ পাঠিয়ে দাও।');
  assert.equal(waFirstBn.steps[0]?.tool, 'whatsapp_prepare');
  assert.equal(waFirstBn.steps[0]?.args.contactQuery, 'রাহুল');
  assert.equal(waFirstBn.steps[0]?.args.message, '');
  assert.equal(waFirstBn.requiresConfirmation, true);

  const waColonBn = buildStructuredTaskPlan('রাহুলকে WhatsApp মেসেজ পাঠাও: আমি আসছি');
  assert.equal(waColonBn.steps[0]?.tool, 'whatsapp_prepare');
  assert.equal(waColonBn.steps[0]?.args.contactQuery, 'রাহুল');
  assert.equal(waColonBn.steps[0]?.args.message, 'আমি আসছি');

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

test('Category E: buildStructuredTaskPlan parses supported generic app chat commands (Telegram, Instagram, Messenger) with mandatory confirmation', () => {
  const tgBn = buildStructuredTaskPlan('টেলিগ্রামে রাহুলকে মেসেজ পাঠাও: আমি আসছি');
  assert.equal(tgBn.steps[0]?.tool, 'app_chat_prepare');
  assert.equal(tgBn.steps[0]?.args.appName, 'Telegram');
  assert.equal(tgBn.steps[0]?.args.contactQuery, 'রাহুল');
  assert.equal(tgBn.steps[0]?.args.message, 'আমি আসছি');
  assert.equal(tgBn.requiresConfirmation, true);

  const igEn = buildStructuredTaskPlan('Message Riya on Instagram saying hello there');
  assert.equal(igEn.steps[0]?.tool, 'app_chat_prepare');
  assert.equal(igEn.steps[0]?.args.appName, 'Instagram');
  assert.equal(igEn.steps[0]?.args.contactQuery, 'Riya');
  assert.equal(igEn.steps[0]?.args.message, 'hello there');
  assert.equal(igEn.requiresConfirmation, true);

  const msEn = buildStructuredTaskPlan('Send a message to Rahul on Messenger saying call me');
  assert.equal(msEn.steps[0]?.tool, 'app_chat_prepare');
  assert.equal(msEn.steps[0]?.args.appName, 'Messenger');
  assert.equal(msEn.steps[0]?.args.contactQuery, 'Rahul');
  assert.equal(msEn.steps[0]?.args.message, 'call me');
  assert.equal(msEn.requiresConfirmation, true);
});

test('formatHonestTaskOutcome never claims WhatsApp message was automatically sent', () => {
  const msg = formatHonestTaskOutcome('whatsapp_prepare', true);
  assert.ok(msg.includes('WhatsApp'));
  assert.ok(msg.includes('Send'));
  assert.equal(msg.includes('পাঠানো হয়ে গেছে'), false);
});

