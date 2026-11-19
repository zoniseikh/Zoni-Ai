import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectAndroidRuntimeMode,
  resolveAndroidPackageForQuery,
  buildAndroidIntentUrl,
  parseNativeBatteryJson,
} from './androidBridge';

test('detectAndroidRuntimeMode identifies native Android APK bridge', () => {
  const fakeWin = {
    ZoniAndroidBridge: { setFlashlight: () => true },
    location: { protocol: 'https:' },
  } as unknown as typeof window;
  assert.equal(detectAndroidRuntimeMode(fakeWin), 'native-android-apk');
});

test('detectAndroidRuntimeMode identifies Capacitor Android runtime', () => {
  const fakeWin = {
    Capacitor: { isNativePlatform: () => true },
    location: { protocol: 'capacitor:' },
  } as unknown as typeof window;
  assert.equal(detectAndroidRuntimeMode(fakeWin), 'capacitor-android');
});

test('detectAndroidRuntimeMode identifies Android standalone PWA vs browser', () => {
  const androidNav = {
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/125.0.0.0 Mobile',
  } as Navigator;

  const pwaWin = {
    location: { protocol: 'https:' },
    matchMedia: (q: string) => ({ matches: q.includes('standalone') }),
  } as unknown as typeof window;

  const browserWin = {
    location: { protocol: 'https:' },
    matchMedia: () => ({ matches: false }),
  } as unknown as typeof window;

  assert.equal(detectAndroidRuntimeMode(pwaWin, androidNav), 'android-pwa');
  assert.equal(detectAndroidRuntimeMode(browserWin, androidNav), 'android-browser');
});

test('resolveAndroidPackageForQuery matches English and Bengali app names', () => {
  assert.equal(resolveAndroidPackageForQuery('open YouTube'), 'com.google.android.youtube');
  assert.equal(resolveAndroidPackageForQuery('ইউটিউব'), 'com.google.android.youtube');
  assert.equal(resolveAndroidPackageForQuery('হোয়াটসঅ্যাপ'), 'com.whatsapp');
  assert.equal(resolveAndroidPackageForQuery('unknown-app-xyz'), null);
});

test('buildAndroidIntentUrl produces valid Android Chrome intent URI', () => {
  const url = buildAndroidIntentUrl('com.google.android.youtube', 'https://www.youtube.com');
  assert.ok(url.startsWith('intent://#Intent;package=com.google.android.youtube'));
  assert.ok(url.includes('S.browser_fallback_url=https%3A%2F%2Fwww.youtube.com'));
  assert.ok(url.endsWith(';end'));
});

test('parseNativeBatteryJson parses valid native battery JSON and rejects malformed input', () => {
  assert.deepEqual(parseNativeBatteryJson('{"level":87,"charging":true}'), {
    level: 87,
    charging: true,
  });
  assert.equal(parseNativeBatteryJson('not-json'), null);
  assert.equal(parseNativeBatteryJson(null), null);
});
