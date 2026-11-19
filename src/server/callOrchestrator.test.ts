import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HybridCallOrchestrator,
  SlidingWindowRateLimiter,
  buildAiCallDisclosureScript,
} from './callOrchestrator.ts';
import {
  UnconfiguredVoipProvider,
  VoipProviderAdapter,
  VoipProviderStatus,
  VoipCallStartResult,
  VoipCallActionResult,
} from './voipProvider.ts';

class FakeConfiguredVoipProvider implements VoipProviderAdapter {
  getStatus(): VoipProviderStatus {
    return {
      provider: 'twilio',
      configured: true,
      callerId: '+15550001111',
      missingEnvVars: [],
      legalDisclosureRequired: true,
    };
  }
  async startOutboundCall(): Promise<VoipCallStartResult> {
    return { started: true, provider: 'twilio', providerCallSid: 'CA_TEST_999' };
  }
  async transferToHuman(): Promise<VoipCallActionResult> {
    return { success: true, provider: 'twilio', message: 'Transferred' };
  }
  async endCall(): Promise<VoipCallActionResult> {
    return { success: true, provider: 'twilio', message: 'Ended' };
  }
}

test('buildAiCallDisclosureScript always identifies Zoni as an AI assistant', () => {
  const bn = buildAiCallDisclosureScript('Boss', 'ডাক্তার অ্যাপয়েন্টমেন্ট', 'bn-BD');
  assert.ok(bn.includes('Zoni AI'));
  assert.ok(bn.includes('AI'));
  const en = buildAiCallDisclosureScript('Boss', 'table reservation', 'en-US');
  assert.ok(en.toLowerCase().includes('artificial intelligence'));
});

test('HybridCallOrchestrator enforces user authorization before starting any call', async () => {
  const orch = new HybridCallOrchestrator({ provider: new FakeConfiguredVoipProvider() });
  const prep = orch.prepareCall({
    channel: 'ai_voip',
    phoneNumber: '০১৭১২৩৪৫৬৭৮',
    purpose: 'Confirm booking',
  });
  assert.equal(prep.ok, true);
  if (!prep.ok) return;

  assert.equal(prep.session.phoneNumber, '+8801712345678');
  assert.equal(prep.session.recordingEnabled, false);

  // Starting without authorization must be rejected with 403
  const blockedStart = await orch.startCall({ sessionId: prep.session.id });
  assert.equal(blockedStart.ok, false);
  if (!blockedStart.ok) {
    assert.equal(blockedStart.statusCode, 403);
    assert.equal(blockedStart.errorCode, 'authorization_required');
  }

  // Authorize and start
  const auth = orch.authorizeCall({
    sessionId: prep.session.id,
    confirmedByUser: true,
    aiIdentityDisclosed: true,
    recordingConsentGranted: false,
  });
  assert.equal(auth.ok, true);

  const started = await orch.startCall({ sessionId: prep.session.id });
  assert.equal(started.ok, true);
  if (started.ok) {
    assert.equal(started.session.providerCallSid, 'CA_TEST_999');
    assert.equal(started.session.state, 'active');
  }

  // End and verify summary + history
  const ended = await orch.endCall({ sessionId: prep.session.id, reason: 'Completed' });
  assert.equal(ended.ok, true);
  if (ended.ok) {
    assert.ok(ended.session.summary?.summaryText.includes('+8801712345678'));
  }

  const history = orch.getHistory();
  assert.equal(history.length, 1);
});

test('UnconfiguredVoipProvider NEVER fabricates external VoIP calls', async () => {
  const orch = new HybridCallOrchestrator({ provider: new UnconfiguredVoipProvider() });
  const prep = orch.prepareCall({
    channel: 'ai_voip',
    phoneNumber: '9876543210',
    purpose: 'Test call',
  });
  assert.equal(prep.ok, true);
  if (!prep.ok) return;

  orch.authorizeCall({
    sessionId: prep.session.id,
    confirmedByUser: true,
    aiIdentityDisclosed: true,
  });

  const startRes = await orch.startCall({ sessionId: prep.session.id });
  assert.equal(startRes.ok, false);
  if (!startRes.ok) {
    assert.equal(startRes.statusCode, 503);
    assert.equal(startRes.errorCode, 'provider_not_configured');
    assert.equal(startRes.session?.state, 'blocked_unconfigured');
  }
});

test('SlidingWindowRateLimiter enforces request limits cleanly', () => {
  const limiter = new SlidingWindowRateLimiter(2, 10_000);
  assert.equal(limiter.allow('1.2.3.4', 1000).allowed, true);
  assert.equal(limiter.allow('1.2.3.4', 2000).allowed, true);
  assert.equal(limiter.allow('1.2.3.4', 3000).allowed, false);
  assert.equal(limiter.allow('1.2.3.4', 12000).allowed, true);
});
