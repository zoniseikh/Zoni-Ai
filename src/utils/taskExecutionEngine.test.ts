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

test('buildStructuredTaskPlan routes both numeric and contact-name calls to direct SIM calling', () => {
  const numPlan = buildStructuredTaskPlan('কল করো 01712345678');
  assert.equal(numPlan.steps.length, 1);
  assert.equal(numPlan.steps[0].tool, 'sim_call');
  assert.equal(numPlan.steps[0].args.phoneNumber, '01712345678');
  assert.equal(numPlan.requiresConfirmation, false);

  const enContact = buildStructuredTaskPlan('ZONI, call my father');
  assert.equal(enContact.steps.length, 1);
  assert.equal(enContact.steps[0].tool, 'sim_call');
  assert.equal(enContact.steps[0].args.contactQuery, 'father');

  const bnContact = buildStructuredTaskPlan('বাবাকে কল করো');
  assert.equal(bnContact.steps.length, 1);
  assert.equal(bnContact.steps[0].tool, 'sim_call');
  assert.equal(bnContact.steps[0].args.contactQuery, 'বাবা');

  const hiContact = buildStructuredTaskPlan('पापा को कॉल करो');
  assert.equal(hiContact.steps.length, 1);
  assert.equal(hiContact.steps[0].tool, 'sim_call');
  assert.equal(hiContact.steps[0].args.contactQuery, 'पापा');
});

test('buildStructuredTaskPlan parses contact-based WhatsApp drafts without claiming sent', () => {
  const plan = buildStructuredTaskPlan('ZONI, send a WhatsApp message to Rahul saying I am coming');
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0].tool, 'whatsapp_prepare');
  assert.equal(plan.steps[0].args.contactQuery, 'Rahul');
  assert.equal(plan.steps[0].args.message, 'I am coming');

  const bnPlan = buildStructuredTaskPlan('রাহুলকে হোয়াটসঅ্যাপ মেসেজ পাঠাও আমি আসছি');
  assert.equal(bnPlan.steps.length, 1);
  assert.equal(bnPlan.steps[0].tool, 'whatsapp_prepare');
  assert.equal(bnPlan.steps[0].args.contactQuery, 'রাহুল');
  assert.equal(bnPlan.steps[0].args.message, 'আমি আসছি');
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
});

test('buildStructuredTaskPlan leaves general Gemini questions empty for normal AI chat', () => {
  const general = buildStructuredTaskPlan('What is photosynthesis?');
  assert.equal(general.steps.length, 0);
  assert.equal(general.blockedReason, undefined);
});

test('formatHonestTaskOutcome never claims WhatsApp message was automatically sent', () => {
  const msg = formatHonestTaskOutcome('whatsapp_prepare', true);
  assert.ok(msg.includes('WhatsApp'));
  assert.ok(msg.includes('Send'));
  assert.equal(msg.includes('পাঠানো হয়ে গেছে'), false);
});
