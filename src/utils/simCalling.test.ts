import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalizeContactPhoneKey,
  deduplicateContactCandidates,
} from './simCalling';

test('canonicalizeContactPhoneKey normalizes formatting, country codes, trunk 0, 00 prefix, and BiDi marks', () => {
  assert.equal(canonicalizeContactPhoneKey('9876543210'), '9876543210');
  assert.equal(canonicalizeContactPhoneKey('+91 98765-43210'), '9876543210');
  assert.equal(canonicalizeContactPhoneKey('09876543210'), '9876543210');
  assert.equal(canonicalizeContactPhoneKey('0091 98765 43210'), '9876543210');
  assert.equal(canonicalizeContactPhoneKey('\u202A+91 (987) 654-3210\u202C'), '9876543210');
  assert.equal(canonicalizeContactPhoneKey('৯৮৭৬৫৪৩২১০'), '9876543210');
  assert.equal(canonicalizeContactPhoneKey('+880 1711-223344'), '1711223344');
  assert.equal(canonicalizeContactPhoneKey('01711223344'), '1711223344');
});

test('deduplicateContactCandidates collapses duplicate single-number contact entries into one', () => {
  const result = deduplicateContactCandidates([
    { id: '42', name: 'Rahim', phone: '9876543210' },
    { id: '109', name: 'Rahim', phone: '9876543210' },
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'Rahim');
  assert.equal(result[0].phone, '9876543210');
});

test('deduplicateContactCandidates collapses equivalent differently-formatted phone numbers and prefers + format', () => {
  const result = deduplicateContactCandidates([
    { id: '42', name: 'Rahim', phone: '9876543210' },
    { id: '109', name: 'rahim', phone: '+91 98765-43210' },
    { id: '110', name: 'Rahim ', phone: '09876543210' },
    { id: '111', name: 'Rahim', phone: '0091-98765-43210' },
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].phone, '+91 98765-43210');
});

test('deduplicateContactCandidates preserves two genuinely distinct numbers for the same contact', () => {
  const result = deduplicateContactCandidates([
    { id: '42', name: 'Rahim', phone: '+919876543210' },
    { id: '42', name: 'Rahim', phone: '+919123456789' },
    { id: '109', name: 'Rahim', phone: '98765-43210' },
  ]);
  assert.equal(result.length, 2);
  assert.deepEqual(
    result.map((r) => canonicalizeContactPhoneKey(r.phone)),
    ['9876543210', '9123456789']
  );
});

test('deduplicateContactCandidates preserves two distinct contacts with the same name and different numbers', () => {
  const result = deduplicateContactCandidates([
    { id: '10', name: 'Rahim', phone: '9876543210' },
    { id: '11', name: 'Rahim', phone: '9123456789' },
  ]);
  assert.equal(result.length, 2);
  assert.equal(result[0].id, '10');
  assert.equal(result[1].id, '11');
});
