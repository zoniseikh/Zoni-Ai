import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalizeContactPhoneKey,
  deduplicateContactCandidates,
  filterContactsByPrefix,
  matchesContactNamePrefix,
  searchNativeAndroidContacts,
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

test('filterContactsByPrefix enforces strict case-insensitive English prefix matching and excludes mid/end matches', () => {
  const contacts = [
    { id: '1', name: 'Babu', phone: '9876543210' },
    { id: '2', name: 'Babu Jamai', phone: '9876543211' },
    { id: '3', name: 'Babu Mama', phone: '9876543212' },
    { id: '4', name: 'Babu Telecom', phone: '9876543213' },
    { id: '5', name: 'Deb Babu', phone: '9876543214' },
    { id: '6', name: 'Ful Babu Karandi', phone: '9876543215' },
    { id: '7', name: 'বাবু', phone: '9876543216' },
    { id: '8', name: 'বাবু মামা', phone: '9876543217' },
  ];

  const upper = filterContactsByPrefix(contacts, 'Babu');
  assert.deepEqual(
    upper.map((c) => c.name),
    ['Babu', 'Babu Jamai', 'Babu Mama', 'Babu Telecom']
  );

  const mixed = filterContactsByPrefix(contacts, '  bAbU  ');
  assert.deepEqual(
    mixed.map((c) => c.name),
    ['Babu', 'Babu Jamai', 'Babu Mama', 'Babu Telecom']
  );

  assert.equal(matchesContactNamePrefix('Deb Babu', 'Babu'), false);
  assert.equal(matchesContactNamePrefix('Ful Babu Karandi', 'Babu'), false);
  assert.equal(matchesContactNamePrefix('\u200EBabu Telecom', 'babu'), true);
});

test('filterContactsByPrefix enforces strict Bengali and Hindi prefix matching without cross-script or mid/end matches', () => {
  const contacts = [
    { id: '1', name: 'Babu', phone: '9876543210' },
    { id: '2', name: 'Babu Mama', phone: '9876543211' },
    { id: '3', name: 'বাবু', phone: '9876543212' },
    { id: '4', name: 'বাবু জামাই', phone: '9876543213' },
    { id: '5', name: 'বাবু মামা', phone: '9876543214' },
    { id: '6', name: 'দেব বাবু', phone: '9876543215' },
    { id: '7', name: 'ফুল বাবু করন্দি', phone: '9876543216' },
    { id: '8', name: 'राम', phone: '9876543217' },
    { id: '9', name: 'राम कुमार', phone: '9876543218' },
    { id: '10', name: 'श्री राम', phone: '9876543219' },
  ];

  const bn = filterContactsByPrefix(contacts, 'বাবু');
  assert.deepEqual(
    bn.map((c) => c.name),
    ['বাবু', 'বাবু জামাই', 'বাবু মামা']
  );

  const hi = filterContactsByPrefix(contacts, 'राम');
  assert.deepEqual(
    hi.map((c) => c.name),
    ['राम', 'राम कुमार']
  );

  assert.deepEqual(filterContactsByPrefix(contacts, '   '), []);
});

test('filterContactsByPrefix prevents duplicate contacts/numbers while keeping distinct same-name contacts', () => {
  const contacts = [
    { id: '1', name: 'Babu', phone: '9876543210' },
    { id: '2', name: 'babu', phone: '+91 98765-43210' },
    { id: '3', name: 'Babu SIM', phone: '09876543210' },
    { id: '4', name: 'Babu', phone: '9123456789' },
    { id: '5', name: 'Deb Babu', phone: '9000000001' },
  ];

  const res = filterContactsByPrefix(contacts, 'Babu');
  assert.equal(res.length, 2);
  assert.equal(res[0].name, 'Babu');
  assert.equal(res[0].phone, '+91 98765-43210');
  assert.equal(res[1].name, 'Babu');
  assert.equal(res[1].phone, '9123456789');
});

test('searchNativeAndroidContacts enforces prefix filtering and deduplication on bridge results', () => {
  const prevWindow = (globalThis as any).window;
  try {
    (globalThis as any).window = {
      ZoniAndroidBridge: {
        searchContactsJson: () =>
          JSON.stringify([
            { id: '1', name: 'Babu Telecom', phone: '9876543213' },
            { id: '2', name: 'Babu', phone: '9876543210' },
            { id: '3', name: 'Babu', phone: '+91 98765-43210' },
            { id: '4', name: 'Deb Babu', phone: '9876543214' },
            { id: '5', name: 'Ful Babu Karandi', phone: '9876543215' },
          ]),
      },
    };
    const results = searchNativeAndroidContacts('Babu');
    assert.deepEqual(
      results.map((r) => ({ name: r.name, phone: r.phone })),
      [
        { name: 'Babu', phone: '+91 98765-43210' },
        { name: 'Babu Telecom', phone: '9876543213' },
      ]
    );
  } finally {
    if (prevWindow === undefined) {
      delete (globalThis as any).window;
    } else {
      (globalThis as any).window = prevWindow;
    }
  }
});
