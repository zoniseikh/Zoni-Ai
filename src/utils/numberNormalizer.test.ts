import test from 'node:test';
import assert from 'node:assert/strict';
import {
  convertDigitsToAscii,
  normalizePhoneNumber,
} from './numberNormalizer';

test('convertDigitsToAscii converts Bengali numerals to ASCII', () => {
  assert.equal(convertDigitsToAscii('০১২৩৪৫৬৭৮৯'), '0123456789');
  assert.equal(convertDigitsToAscii('৯৮৭ ৬৫৪ ৩২১০'), '987 654 3210');
});

test('normalizePhoneNumber normalizes Indian 10-digit number with spaces', () => {
  const res = normalizePhoneNumber('৯৮৭ ৬৫৪ ৩২১০');
  assert.equal(res.status, 'valid');
  if (res.status === 'valid') {
    assert.equal(res.normalizedNumber, '+919876543210');
    assert.equal(res.country, 'IN');
  }
});

test('normalizePhoneNumber normalizes Bangladesh 11-digit number', () => {
  const res = normalizePhoneNumber('০১৭১২৩৪৫৬৭৮');
  assert.equal(res.status, 'valid');
  if (res.status === 'valid') {
    assert.equal(res.normalizedNumber, '+8801712345678');
    assert.equal(res.country, 'BD');
  }
});

test('normalizePhoneNumber flags incomplete numbers', () => {
  const res = normalizePhoneNumber('১২৩৪');
  assert.equal(res.status, 'incomplete');
  if (res.status === 'incomplete') {
    assert.equal(res.currentLength, 4);
  }
});

test('normalizePhoneNumber flags invalid empty string', () => {
  const res = normalizePhoneNumber('   ');
  assert.equal(res.status, 'invalid');
});
