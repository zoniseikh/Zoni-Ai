import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PRODUCTION_BACKEND_URL,
  isValidBackendUrl,
  isLocalAndroidAssetHost,
  getApiBaseUrl,
  getLiveWsUrl,
  getBackendConfigError,
  saveCustomBackendUrl,
} from './apiConfig';

function makeMockWindow(opts: {
  hostname?: string;
  origin?: string;
  protocol?: string;
  host?: string;
  bridgeUrl?: string;
  storedUrl?: string;
}): Window {
  const storage = new Map<string, string>();
  if (opts.storedUrl) {
    storage.set('zoni_backend_url', opts.storedUrl);
  }
  const hostname = opts.hostname || 'localhost';
  const protocol = opts.protocol || 'http:';
  const host = opts.host || (hostname === 'localhost' ? 'localhost:3000' : hostname);
  const origin = opts.origin || `${protocol}//${host}`;

  return {
    location: {
      hostname,
      protocol,
      host,
      origin,
      port: host.includes(':') ? host.split(':')[1] : '',
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
    ZoniAndroidBridge:
      opts.bridgeUrl !== undefined
        ? {
            getBackendUrl: () => opts.bridgeUrl!,
            setBackendUrl: () => true,
          }
        : undefined,
  } as unknown as Window;
}

test('isValidBackendUrl accepts confirmed production URL and rejects appassets, localhost, and dead ais-pre URLs', () => {
  assert.equal(isValidBackendUrl(PRODUCTION_BACKEND_URL), true);
  assert.equal(isValidBackendUrl('http://192.168.1.50:3000/'), true);
  assert.equal(isValidBackendUrl('https://appassets.androidplatform.net'), false);
  assert.equal(isValidBackendUrl('https://appassets.androidplatform.net/index.html'), false);
  assert.equal(isValidBackendUrl('http://localhost:3000'), false);
  assert.equal(isValidBackendUrl('http://localhost:3000', { allowLocalhost: true }), true);
  assert.equal(
    isValidBackendUrl('https://ais-pre-5yp7pnjuvq2sy7cixzinuw-982211778522.asia-east1.run.app'),
    false
  );
  assert.equal(isValidBackendUrl(''), false);
  assert.equal(isValidBackendUrl('ftp://invalid.example.com'), false);
  assert.equal(isLocalAndroidAssetHost('https://appassets.androidplatform.net/assets'), true);
});

test('Android WebViewAssetLoader resolves confirmed production backend URL and ignores stale ais-pre or localhost storage', () => {
  const androidWin = makeMockWindow({
    hostname: 'appassets.androidplatform.net',
    protocol: 'https:',
    host: 'appassets.androidplatform.net',
    bridgeUrl: '',
    storedUrl: 'https://ais-pre-5yp7pnjuvq2sy7cixzinuw-982211778522.asia-east1.run.app',
  });

  assert.equal(getBackendConfigError(androidWin), null);
  assert.equal(getApiBaseUrl(androidWin), PRODUCTION_BACKEND_URL);
  const wsUrl = getLiveWsUrl('romantic', 'Boss', 'Kore', 'bn-BD', undefined, androidWin);
  assert.ok(wsUrl.startsWith(`wss://zoni-ai-675435111499.asia-southeast1.run.app/live?`));
  assert.ok(!wsUrl.includes('appassets.androidplatform.net'));
  assert.ok(!wsUrl.includes('ais-pre-'));
});

test('Android WebViewAssetLoader uses valid native bridge backend URL for both HTTP and WSS', () => {
  const androidWin = makeMockWindow({
    hostname: 'appassets.androidplatform.net',
    protocol: 'https:',
    host: 'appassets.androidplatform.net',
    bridgeUrl: 'https://zoni-prod.example.run.app/',
  });

  assert.equal(getBackendConfigError(androidWin), null);
  assert.equal(getApiBaseUrl(androidWin), 'https://zoni-prod.example.run.app');
  const wsUrl = getLiveWsUrl('romantic', 'Boss', 'Kore', 'bn-BD', undefined, androidWin);
  assert.ok(wsUrl.startsWith('wss://zoni-prod.example.run.app/live?'));
  assert.ok(!wsUrl.includes('appassets.androidplatform.net'));
});

test('Web browser uses same-origin HTTP and WebSocket by default', () => {
  const webWin = makeMockWindow({
    hostname: 'localhost',
    protocol: 'http:',
    host: 'localhost:3000',
  });

  assert.equal(getBackendConfigError(webWin), null);
  assert.equal(getApiBaseUrl(webWin), '');
  const wsUrl = getLiveWsUrl('jarvis_gf', 'Boss', 'Zephyr', 'en-US', undefined, webWin);
  assert.ok(wsUrl.startsWith('ws://localhost:3000/live?'));
});

test('saveCustomBackendUrl rejects appassets, localhost, and dead ais-pre on Android and stores valid URL', () => {
  const androidWin = makeMockWindow({
    hostname: 'appassets.androidplatform.net',
    protocol: 'https:',
    host: 'appassets.androidplatform.net',
    bridgeUrl: '',
  });

  assert.equal(saveCustomBackendUrl('https://appassets.androidplatform.net', androidWin).ok, false);
  assert.equal(saveCustomBackendUrl('http://localhost:3000', androidWin).ok, false);
  assert.equal(
    saveCustomBackendUrl('https://ais-pre-5yp7pnjuvq2sy7cixzinuw-982211778522.asia-east1.run.app', androidWin).ok,
    false
  );

  const saved = saveCustomBackendUrl('https://api.zoniserver.com///', androidWin);
  assert.equal(saved.ok, true);
  assert.equal(saved.normalizedUrl, 'https://api.zoniserver.com');
  assert.equal(getApiBaseUrl(androidWin), 'https://api.zoniserver.com');
});
