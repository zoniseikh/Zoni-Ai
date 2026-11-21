import test from 'node:test';
import assert from 'node:assert/strict';
import {
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

test('isValidBackendUrl accepts https/http remote URLs and rejects appassets.androidplatform.net', () => {
  assert.equal(isValidBackendUrl('https://zoni-api.example.com'), true);
  assert.equal(isValidBackendUrl('http://192.168.1.50:3000/'), true);
  assert.equal(isValidBackendUrl('https://appassets.androidplatform.net'), false);
  assert.equal(isValidBackendUrl('https://appassets.androidplatform.net/index.html'), false);
  assert.equal(isValidBackendUrl(''), false);
  assert.equal(isValidBackendUrl('ftp://invalid.example.com'), false);
  assert.equal(isLocalAndroidAssetHost('https://appassets.androidplatform.net/assets'), true);
});

test('Android WebViewAssetLoader without backend URL never falls back to appassets.androidplatform.net', () => {
  const androidWin = makeMockWindow({
    hostname: 'appassets.androidplatform.net',
    protocol: 'https:',
    host: 'appassets.androidplatform.net',
    bridgeUrl: '',
  });

  assert.equal(getApiBaseUrl(androidWin), '');
  assert.equal(getLiveWsUrl('romantic', 'Boss', 'Kore', 'bn-BD', undefined, androidWin), '');
  const configErr = getBackendConfigError(androidWin);
  assert.ok(configErr && configErr.includes('not configured'));
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

test('saveCustomBackendUrl rejects appassets host and stores valid URL', () => {
  const androidWin = makeMockWindow({
    hostname: 'appassets.androidplatform.net',
    protocol: 'https:',
    host: 'appassets.androidplatform.net',
    bridgeUrl: '',
  });

  const rejected = saveCustomBackendUrl('https://appassets.androidplatform.net', androidWin);
  assert.equal(rejected.ok, false);

  const saved = saveCustomBackendUrl('https://api.zoniserver.com///', androidWin);
  assert.equal(saved.ok, true);
  assert.equal(saved.normalizedUrl, 'https://api.zoniserver.com');
  assert.equal(getApiBaseUrl(androidWin), 'https://api.zoniserver.com');
});
