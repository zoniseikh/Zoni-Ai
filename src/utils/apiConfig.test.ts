import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BROWSER_BYOK_STORAGE_KEY,
  LEGACY_BACKEND_URL_STORAGE,
  cleanupLegacyBackendStorage,
  deleteGeminiApiKey,
  getGeminiApiKeyForRequest,
  getGeminiApiKeyStatus,
  getGeminiConfigError,
  isNativeAndroidWebShell,
  maskGeminiApiKey,
  sanitizeGeminiSecret,
  saveGeminiApiKey,
  validateGeminiApiKeyFormat,
} from './apiConfig';

const VALID_TEST_KEY_1 = 'AIzaSyTestExampleKey00000000000000001234';
const VALID_TEST_KEY_2 = 'AIzaSyReplacementKey99999999999999995678';

function makeMockWindow(opts: {
  hostname?: string;
  protocol?: string;
  storedBrowserKey?: string;
  legacyBackendUrl?: string;
  nativeAndroidBridge?: boolean;
  initialNativeKey?: string;
  keystoreBacked?: boolean;
} = {}): {
  win: Window;
  storage: Map<string, string>;
  events: string[];
  getNativeKey: () => string;
} {
  const storage = new Map<string, string>();
  if (opts.storedBrowserKey) {
    storage.set(BROWSER_BYOK_STORAGE_KEY, opts.storedBrowserKey);
  }
  if (opts.legacyBackendUrl) {
    storage.set(LEGACY_BACKEND_URL_STORAGE, opts.legacyBackendUrl);
  }

  let nativeKey = opts.initialNativeKey || '';
  const events: string[] = [];
  const hostname = opts.hostname || 'localhost';
  const protocol = opts.protocol || 'http:';

  const bridge = opts.nativeAndroidBridge
    ? {
        saveGeminiApiKey: (key: string) => {
          nativeKey = key.trim();
          return true;
        },
        deleteGeminiApiKey: () => {
          nativeKey = '';
          return true;
        },
        getGeminiApiKeyForRequest: () => nativeKey,
        getGeminiApiKeyStatusJson: () =>
          JSON.stringify({
            configured: Boolean(nativeKey),
            maskedPreview: nativeKey ? maskGeminiApiKey(nativeKey) : '',
            keystoreBacked: opts.keystoreBacked !== false,
            isKeystoreBacked: opts.keystoreBacked !== false,
            storageKind: opts.keystoreBacked !== false ? 'android_keystore' : 'android_private_prefs',
          }),
      }
    : undefined;

  const win = {
    location: {
      hostname,
      protocol,
      host: hostname === 'localhost' ? 'localhost:3000' : hostname,
      origin: `${protocol}//${hostname}`,
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
    dispatchEvent: (ev: Event) => {
      events.push(ev.type);
      return true;
    },
    ZoniAndroidBridge: bridge,
  } as unknown as Window;

  return { win, storage, events, getNativeKey: () => nativeKey };
}

test('validateGeminiApiKeyFormat accepts AIza and AQ. keys, cleans clipboard artifacts, and rejects URLs/spaces/short keys', () => {
  const ok = validateGeminiApiKeyFormat(`  ${VALID_TEST_KEY_1}  `);
  assert.equal(ok.valid, true);
  assert.equal(ok.normalizedKey, VALID_TEST_KEY_1);

  // Google Cloud / Vertex Express Gemini API key format (starts with AQ. and contains a dot)
  const aqKey = 'AQ.Ab8RN6TestExpressGeminiKey0000000000009876';
  const okAq = validateGeminiApiKeyFormat(aqKey);
  assert.equal(okAq.valid, true);
  assert.equal(okAq.normalizedKey, aqKey);

  // Mobile clipboard artifacts: zero-width spaces, BOM, quotes, and GEMINI_API_KEY= prefix
  const withBomAndQuotes = validateGeminiApiKeyFormat(`\uFEFF"${VALID_TEST_KEY_1}\u200B"`);
  assert.equal(withBomAndQuotes.valid, true);
  assert.equal(withBomAndQuotes.normalizedKey, VALID_TEST_KEY_1);

  const withEnvPrefix = validateGeminiApiKeyFormat(`GEMINI_API_KEY="${aqKey}"`);
  assert.equal(withEnvPrefix.valid, true);
  assert.equal(withEnvPrefix.normalizedKey, aqKey);

  // Reject empty, internal spaces, server URLs, short strings, and invalid symbols
  assert.equal(validateGeminiApiKeyFormat('').valid, false);
  assert.equal(validateGeminiApiKeyFormat('   ').valid, false);
  assert.equal(validateGeminiApiKeyFormat('AIzaSyWith Space Inside 123456789').valid, false);

  const urlErr = validateGeminiApiKeyFormat('https://zoni-backend.example.run.app');
  assert.equal(urlErr.valid, false);
  assert.ok(urlErr.error && /not a server URL/i.test(urlErr.error));

  assert.equal(validateGeminiApiKeyFormat('AIzaShort').valid, false);
  assert.equal(validateGeminiApiKeyFormat('AIzaSyInvalid$Chars<>1234567890').valid, false);
});

test('maskGeminiApiKey and sanitizeGeminiSecret never reveal the full saved API key (AIza or AQ.)', () => {
  const masked = maskGeminiApiKey(VALID_TEST_KEY_1);
  assert.equal(masked, 'AIza••••••••1234');
  assert.ok(!masked.includes('TestExampleKey'));

  const aqKey = 'AQ.Ab8RN6TestExpressGeminiKey0000000000009876';
  assert.equal(maskGeminiApiKey(aqKey), 'AQ.A••••••••9876');

  const rawErr = `WebSocket wss://generativelanguage.googleapis.com/ws?key=${VALID_TEST_KEY_1} failed with x-goog-api-key: ${VALID_TEST_KEY_1} (${VALID_TEST_KEY_2}) and ${aqKey}`;
  const scrubbed = sanitizeGeminiSecret(rawErr, VALID_TEST_KEY_1);
  assert.ok(!scrubbed.includes(VALID_TEST_KEY_1));
  assert.ok(!scrubbed.includes(VALID_TEST_KEY_2));
  assert.ok(!scrubbed.includes(aqKey));
  assert.ok(scrubbed.includes('[REDACTED_API_KEY]'));
});

test('fresh startup with missing key requires ONLY Gemini API key and never requires any backend URL', () => {
  const { win } = makeMockWindow();
  const status = getGeminiApiKeyStatus(win);
  assert.equal(status.configured, false);
  assert.equal(status.maskedPreview, '');
  assert.equal(status.storageKind, 'none');

  const configErr = getGeminiConfigError(win, 'en-US');
  assert.ok(configErr && configErr.includes('Gemini API Key'));
  assert.ok(configErr && configErr.includes('No backend server URL is required'));
  assert.equal(getGeminiApiKeyForRequest(win), '');
});

test('browser preview save -> replace -> delete lifecycle enforces explicit security notice and purges legacy backend URL', () => {
  const { win, storage, events } = makeMockWindow({
    legacyBackendUrl: 'https://legacy.example.run.app',
  });

  // Save valid key
  const saved = saveGeminiApiKey(VALID_TEST_KEY_1, win);
  assert.equal(saved.ok, true);
  assert.equal(saved.status.configured, true);
  assert.equal(saved.status.maskedPreview, 'AIza••••••••1234');
  assert.equal(saved.status.storageKind, 'browser_preview_local_storage');
  assert.ok(saved.status.securityNotice.includes('NOT equivalent to Android Keystore'));
  assert.equal(storage.has(LEGACY_BACKEND_URL_STORAGE), false);
  assert.equal(getGeminiConfigError(win), null);
  assert.equal(getGeminiApiKeyForRequest(win), VALID_TEST_KEY_1);

  // Replace key
  const replaced = saveGeminiApiKey(VALID_TEST_KEY_2, win);
  assert.equal(replaced.ok, true);
  assert.equal(replaced.status.maskedPreview, 'AIza••••••••5678');
  assert.equal(getGeminiApiKeyForRequest(win), VALID_TEST_KEY_2);

  // Reject invalid replacement without losing existing key
  const bad = saveGeminiApiKey('https://not-an-api-key.run.app', win);
  assert.equal(bad.ok, false);
  assert.equal(getGeminiApiKeyForRequest(win), VALID_TEST_KEY_2);

  // Delete key
  const afterDelete = deleteGeminiApiKey(win);
  assert.equal(afterDelete.configured, false);
  assert.equal(afterDelete.maskedPreview, '');
  assert.equal(getGeminiApiKeyForRequest(win), '');
  assert.ok(events.filter((e) => e === 'zoni:gemini-key-updated').length >= 3);
});

test('Android native bridge stores key in Android Keystore and purges WebView localStorage copies', () => {
  const { win, storage, getNativeKey } = makeMockWindow({
    hostname: 'appassets.androidplatform.net',
    protocol: 'https:',
    nativeAndroidBridge: true,
    storedBrowserKey: VALID_TEST_KEY_1,
    legacyBackendUrl: 'https://legacy.example.run.app',
    keystoreBacked: true,
  });

  assert.equal(isNativeAndroidWebShell(win), true);
  cleanupLegacyBackendStorage(win);
  assert.equal(storage.has(LEGACY_BACKEND_URL_STORAGE), false);

  const saved = saveGeminiApiKey(VALID_TEST_KEY_2, win);
  assert.equal(saved.ok, true);
  assert.equal(saved.status.storageKind, 'android_keystore');
  assert.equal(saved.status.maskedPreview, 'AIza••••••••5678');
  assert.equal(saved.status.isNativeAndroid, true);
  assert.equal(getNativeKey(), VALID_TEST_KEY_2);
  // Must purge WebView localStorage copy so raw key only lives in Android Keystore
  assert.equal(storage.has(BROWSER_BYOK_STORAGE_KEY), false);

  const afterDelete = deleteGeminiApiKey(win);
  assert.equal(afterDelete.configured, false);
  assert.equal(getNativeKey(), '');
});
