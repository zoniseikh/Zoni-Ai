import test from 'node:test';
import assert from 'node:assert/strict';
import { getApiBaseUrl, getLiveWsUrl } from './apiConfig';

test('getApiBaseUrl returns empty string for standard web browser origin', () => {
  const mockWin = {
    location: { protocol: 'https:', hostname: 'zoni.example.com', host: 'zoni.example.com', port: '', origin: 'https://zoni.example.com' },
  } as unknown as Window;
  assert.equal(getApiBaseUrl(mockWin), '');
});

test('getApiBaseUrl resolves ZoniAndroidBridge backend URL inside Android WebViewAssetLoader', () => {
  const mockWin = {
    ZoniAndroidBridge: {
      getBackendUrl: () => 'https://zoni-backend.example.app/',
    },
    location: {
      protocol: 'https:',
      hostname: 'appassets.androidplatform.net',
      host: 'appassets.androidplatform.net',
      port: '',
      origin: 'https://appassets.androidplatform.net',
    },
  } as unknown as Window;
  assert.equal(getApiBaseUrl(mockWin), 'https://zoni-backend.example.app');
});

test('getLiveWsUrl builds wss URL from native Android backend and ws URL for http dev server', () => {
  const httpsAndroidWin = {
    ZoniAndroidBridge: {
      getBackendUrl: () => 'https://zoni-backend.example.app',
    },
    location: {
      protocol: 'https:',
      hostname: 'appassets.androidplatform.net',
      host: 'appassets.androidplatform.net',
      origin: 'https://appassets.androidplatform.net',
    },
  } as unknown as Window;

  const wsUrl = getLiveWsUrl('romantic', 'Boss', 'Kore', 'bn-BD', 'handle-123', httpsAndroidWin);
  assert.ok(wsUrl.startsWith('wss://zoni-backend.example.app/live?'));
  assert.ok(wsUrl.includes('handle=handle-123'));

  const localAndroidWin = {
    ZoniAndroidBridge: {
      getBackendUrl: () => 'http://10.0.2.2:3000',
    },
    location: {
      protocol: 'https:',
      hostname: 'appassets.androidplatform.net',
      host: 'appassets.androidplatform.net',
      origin: 'https://appassets.androidplatform.net',
    },
  } as unknown as Window;

  const localWsUrl = getLiveWsUrl('jarvis_gf', 'Jaan', 'Kore', 'bn-BD', undefined, localAndroidWin);
  assert.ok(localWsUrl.startsWith('ws://10.0.2.2:3000/live?'));
});
