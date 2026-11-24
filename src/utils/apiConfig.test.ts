import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LEGACY_BACKEND_URL_STORAGE,
  LEGACY_BROWSER_KEY_STORAGE,
  LEGACY_USER_KEY_STORAGE,
  buildServerApiUrl,
  buildServerLiveWsUrl,
  cleanupLegacyClientStorage,
  fetchServerStatus,
  getServerBaseUrl,
  sanitizeErrorText,
} from './apiConfig';

function makeMockWindow(opts: {
  origin?: string;
  host?: string;
  protocol?: string;
  initialStorage?: Record<string, string>;
} = {}): { win: Window; storage: Map<string, string> } {
  const storage = new Map<string, string>(Object.entries(opts.initialStorage || {}));
  const protocol = opts.protocol || 'https:';
  const host = opts.host || 'zoni.example.run.app';
  const origin = opts.origin || `${protocol}//${host}`;

  const win = {
    location: {
      origin,
      host,
      protocol,
    },
    localStorage: {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => {
        storage.set(k, v);
      },
      removeItem: (k: string) => {
        storage.delete(k);
      },
    },
  } as unknown as Window;

  return { win, storage };
}

test('buildServerApiUrl and buildServerLiveWsUrl route all Gemini REST and Live traffic through the server with zero API keys', () => {
  const { win: httpsWin } = makeMockWindow({
    protocol: 'https:',
    host: 'ais-pre-example.run.app',
  });
  assert.equal(getServerBaseUrl(httpsWin), 'https://ais-pre-example.run.app');
  assert.equal(buildServerApiUrl('/api/chat', httpsWin), 'https://ais-pre-example.run.app/api/chat');
  assert.equal(buildServerApiUrl('api/tts', httpsWin), 'https://ais-pre-example.run.app/api/tts');

  const wsUrl = buildServerLiveWsUrl(
    {
      mode: 'romantic',
      selectedAffectionName: 'Boss',
      voice: 'Kore',
      lang: 'bn-BD',
      handle: 'resume-abc',
    },
    httpsWin
  );
  assert.ok(wsUrl.startsWith('wss://ais-pre-example.run.app/live?'));
  assert.ok(wsUrl.includes('mode=romantic'));
  assert.ok(wsUrl.includes('selectedAffectionName=Boss'));
  assert.ok(wsUrl.includes('voice=Kore'));
  assert.ok(wsUrl.includes('lang=bn-BD'));
  assert.ok(wsUrl.includes('handle=resume-abc'));
  assert.ok(!wsUrl.includes('generativelanguage.googleapis.com'));
  assert.ok(!wsUrl.includes('key='));

  const { win: httpWin } = makeMockWindow({
    protocol: 'http:',
    host: 'localhost:3000',
  });
  assert.equal(
    buildServerLiveWsUrl({ mode: 'playful' }, httpWin),
    'ws://localhost:3000/live?mode=playful'
  );
});

test('cleanupLegacyClientStorage clears any old browser API key or backend URL entries', () => {
  const { win, storage } = makeMockWindow({
    initialStorage: {
      [LEGACY_BROWSER_KEY_STORAGE]: 'old-key',
      [LEGACY_USER_KEY_STORAGE]: 'old-user-key',
      [LEGACY_BACKEND_URL_STORAGE]: 'https://old.example.run.app',
      keep_me: 'preserved',
    },
  });

  cleanupLegacyClientStorage(win);
  assert.equal(storage.has(LEGACY_BROWSER_KEY_STORAGE), false);
  assert.equal(storage.has(LEGACY_USER_KEY_STORAGE), false);
  assert.equal(storage.has(LEGACY_BACKEND_URL_STORAGE), false);
  assert.equal(storage.get('keep_me'), 'preserved');
});

test('fetchServerStatus reports healthy server-side Gemini readiness and handles unreachable/unconfigured states', async () => {
  const { win } = makeMockWindow({ protocol: 'http:', host: 'localhost:3000' });

  const healthyFetch = (async (input: RequestInfo | URL) => {
    assert.equal(String(input), 'http://localhost:3000/api/status');
    return new Response(
      JSON.stringify({
        status: 'online',
        geminiConfigured: true,
        geminiLiveSupported: true,
        assistantToolsCount: 36,
        currentTimeIST: '12:00:00 PM (12:00:00)',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }) as typeof fetch;

  const healthy = await fetchServerStatus(healthyFetch, win);
  assert.equal(healthy.checked, true);
  assert.equal(healthy.reachable, true);
  assert.equal(healthy.geminiConfigured, true);
  assert.equal(healthy.statusText, 'SERVER AI READY');
  assert.equal(healthy.toolsCount, 36);

  const missingKeyFetch = (async () =>
    new Response(
      JSON.stringify({
        status: 'degraded',
        geminiConfigured: false,
        configurationError: 'GEMINI_API_KEY is not configured on this backend server.',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )) as typeof fetch;

  const missing = await fetchServerStatus(missingKeyFetch, win);
  assert.equal(missing.reachable, true);
  assert.equal(missing.geminiConfigured, false);
  assert.ok(missing.configurationError?.includes('GEMINI_API_KEY'));

  const offlineFetch = (async () => {
    throw new Error('Failed to fetch');
  }) as typeof fetch;

  const offline = await fetchServerStatus(offlineFetch, win);
  assert.equal(offline.reachable, false);
  assert.equal(offline.statusText, 'SERVER OFFLINE');
});

test('sanitizeErrorText scrubs any accidental key patterns', () => {
  const raw = 'Error calling endpoint?key=AIzaSySecret00000000000000001234 and AQ.Ab8RN6Secret0000000000009876';
  const safe = sanitizeErrorText(raw);
  assert.ok(!safe.includes('AIzaSySecret'));
  assert.ok(!safe.includes('AQ.Ab8RN6Secret'));
  assert.ok(safe.includes('[REDACTED]'));
});
