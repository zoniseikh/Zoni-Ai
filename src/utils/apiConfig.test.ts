import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BYOK_BROWSER_KEY_STORAGE,
  LEGACY_BACKEND_URL_STORAGE,
  buildServerApiUrl,
  buildServerLiveWsUrl,
  cleanupLegacyBackendStorage,
  deleteGeminiApiKey,
  fetchServerStatus,
  getGeminiApiKeyForRequest,
  getGeminiApiKeyStatus,
  getGeminiConfigError,
  getServerBaseUrl,
  maskGeminiApiKey,
  sanitizeErrorText,
  sanitizeGeminiSecret,
  saveGeminiApiKey,
  validateGeminiApiKeyFormat,
} from './apiConfig';

const VALID_AIZA_KEY = 'AIzaSyTestKey1234567890abcdefghijklmnop';
const VALID_AQ_KEY = 'AQ.Ab8RN6TestKey1234567890abcdefgh_9876';

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
    dispatchEvent: () => true,
  } as unknown as Window;

  return { win, storage };
}

test('validateGeminiApiKeyFormat accepts AIza and AQ. keys, cleans clipboard artifacts, and rejects URLs/spaces/short keys', () => {
  const okAiza = validateGeminiApiKeyFormat(`  ${VALID_AIZA_KEY}  `);
  assert.equal(okAiza.valid, true);
  assert.equal(okAiza.normalizedKey, VALID_AIZA_KEY);

  const okAq = validateGeminiApiKeyFormat(`\uFEFF\u200B"${VALID_AQ_KEY}"\u200B`);
  assert.equal(okAq.valid, true);
  assert.equal(okAq.normalizedKey, VALID_AQ_KEY);

  const okEnv = validateGeminiApiKeyFormat(`GEMINI_API_KEY=${VALID_AQ_KEY}`);
  assert.equal(okEnv.valid, true);
  assert.equal(okEnv.normalizedKey, VALID_AQ_KEY);

  const urlReject = validateGeminiApiKeyFormat('https://zoni-backend.run.app');
  assert.equal(urlReject.valid, false);
  assert.ok(urlReject.error?.toLowerCase().includes('url'));

  const spaceReject = validateGeminiApiKeyFormat('AIzaSyInvalid Key With Spaces 12345');
  assert.equal(spaceReject.valid, false);

  const shortReject = validateGeminiApiKeyFormat('AIza123');
  assert.equal(shortReject.valid, false);
});

test('saveGeminiApiKey, getGeminiApiKeyStatus, getGeminiApiKeyForRequest, and deleteGeminiApiKey manage user BYOK key cleanly', () => {
  const { win, storage } = makeMockWindow();

  assert.equal(getGeminiApiKeyStatus(win).configured, false);
  assert.ok(getGeminiConfigError(win, 'bn-BD')?.includes('Gemini API Key'));

  const saved = saveGeminiApiKey(VALID_AQ_KEY, win);
  assert.equal(saved.ok, true);
  assert.equal(saved.maskedPreview, maskGeminiApiKey(VALID_AQ_KEY));
  assert.equal(storage.get(BYOK_BROWSER_KEY_STORAGE), VALID_AQ_KEY);

  const status = getGeminiApiKeyStatus(win);
  assert.equal(status.configured, true);
  assert.equal(status.maskedPreview, 'AQ.A••••••••9876');
  assert.equal(getGeminiApiKeyForRequest(win), VALID_AQ_KEY);
  assert.equal(getGeminiConfigError(win, 'en-US'), null);

  deleteGeminiApiKey(win);
  assert.equal(getGeminiApiKeyStatus(win).configured, false);
  assert.equal(getGeminiApiKeyForRequest(win), '');
});

test('cleanupLegacyBackendStorage removes legacy backend URL while preserving user BYOK key', () => {
  const { win, storage } = makeMockWindow({
    initialStorage: {
      [BYOK_BROWSER_KEY_STORAGE]: VALID_AIZA_KEY,
      [LEGACY_BACKEND_URL_STORAGE]: 'https://old.example.run.app',
      keep_me: 'preserved',
    },
  });

  cleanupLegacyBackendStorage(win);
  assert.equal(storage.has(LEGACY_BACKEND_URL_STORAGE), false);
  assert.equal(storage.get(BYOK_BROWSER_KEY_STORAGE), VALID_AIZA_KEY);
  assert.equal(storage.get('keep_me'), 'preserved');
});

test('buildServerApiUrl and buildServerLiveWsUrl build same-origin server endpoints without keys', () => {
  const { win: httpsWin } = makeMockWindow({
    protocol: 'https:',
    host: 'ais-pre-example.run.app',
  });
  assert.equal(getServerBaseUrl(httpsWin), 'https://ais-pre-example.run.app');
  assert.equal(buildServerApiUrl('/api/chat', httpsWin), 'https://ais-pre-example.run.app/api/chat');

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
  assert.ok(!wsUrl.includes('key='));
});

test('fetchServerStatus handles Android WebViewAssetLoader HTML <!doctype> fallback without JSON parse crash', async () => {
  const { win: androidWin } = makeMockWindow({
    protocol: 'https:',
    host: 'appassets.androidplatform.net',
  });
  const shouldNotFetch = (async () => {
    throw new Error('Should not call /api/status on appassets.androidplatform.net');
  }) as typeof fetch;

  const androidSnap = await fetchServerStatus(shouldNotFetch, androidWin, 'en-US');
  assert.equal(androidSnap.reachable, false);
  assert.equal(androidSnap.isStandaloneClient, true);
  assert.equal(androidSnap.statusText, 'API KEY REQUIRED');
  assert.ok(!String(androidSnap.configurationError || '').includes('Unexpected token'));

  // Even on a generic static host that returns index.html for /api/status
  const { win: staticWin } = makeMockWindow({
    protocol: 'https:',
    host: 'static-apk-host.local',
  });
  const htmlFallbackFetch = (async () =>
    new Response('<!doctype html><html><body>Zoni AI</body></html>', {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    })) as typeof fetch;

  const htmlSnap = await fetchServerStatus(htmlFallbackFetch, staticWin, 'en-US');
  assert.equal(htmlSnap.reachable, false);
  assert.equal(htmlSnap.isStandaloneClient, true);
  assert.equal(htmlSnap.statusText, 'API KEY REQUIRED');
  assert.ok(!String(htmlSnap.configurationError || '').includes('Unexpected token'));
  assert.ok(!String(htmlSnap.configurationError || '').includes('<!doctype'));

  // Healthy Express server still works seamlessly in web preview
  const { win: webWin } = makeMockWindow({ protocol: 'http:', host: 'localhost:3000' });
  const healthyFetch = (async () =>
    new Response(
      JSON.stringify({
        status: 'online',
        geminiConfigured: true,
        geminiLiveSupported: true,
        assistantToolsCount: 36,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )) as typeof fetch;

  const healthySnap = await fetchServerStatus(healthyFetch, webWin);
  assert.equal(healthySnap.reachable, true);
  assert.equal(healthySnap.geminiConfigured, true);
  assert.equal(healthySnap.connectionMode, 'server_managed');
  assert.equal(healthySnap.statusText, 'SERVER AI READY');
  assert.equal(healthySnap.toolsCount, 36);
});

test('sanitizeErrorText and sanitizeGeminiSecret redact AIza, AQ., query keys, and explicit secrets', () => {
  const raw = `Error calling endpoint?key=${VALID_AIZA_KEY} and ${VALID_AQ_KEY}`;
  const safe = sanitizeErrorText(raw);
  assert.ok(!safe.includes('AIzaSyTestKey'));
  assert.ok(!safe.includes('AQ.Ab8RN6TestKey'));
  assert.ok(safe.includes('[REDACTED]'));

  const explicit = sanitizeGeminiSecret('Secret leaked: customSecretToken999', 'customSecretToken999');
  assert.ok(!explicit.includes('customSecretToken999'));
  assert.ok(explicit.includes('[REDACTED]'));
});
