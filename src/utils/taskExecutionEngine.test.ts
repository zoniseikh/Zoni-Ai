import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildStructuredTaskPlan,
  formatHonestTaskOutcome,
  isToolAllowed,
} from './taskExecutionEngine.ts';

test('isToolAllowed accepts allowlisted tools and rejects arbitrary shell tools', () => {
  assert.equal(isToolAllowed('sim_call'), true);
  assert.equal(isToolAllowed('ai_voip_call'), true);
  assert.equal(isToolAllowed('whatsapp_prepare'), true);
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

test('buildStructuredTaskPlan marks AI VoIP calls as requiring confirmation', () => {
  const plan = buildStructuredTaskPlan('AI call 01712345678 for doctor appointment');
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0].tool, 'ai_voip_call');
  assert.equal(plan.steps[0].args.normalizedNumber, '+8801712345678');
  assert.equal(plan.requiresConfirmation, true);
});

test('formatHonestTaskOutcome never claims WhatsApp message was automatically sent', () => {
  const msg = formatHonestTaskOutcome('whatsapp_prepare', true);
  assert.ok(msg.includes('WhatsApp'));
  assert.ok(msg.includes('Send'));
  assert.equal(msg.includes('পাঠানো হয়ে গেছে'), false);
});
