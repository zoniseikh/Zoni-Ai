import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getBengaliDaypart,
  toBengaliDigits,
  detectDateTimeQuery,
  getKolkataTimeComponents,
  formatBengaliSpokenTime,
  formatBengaliDate,
  formatBengaliWeekday,
} from './bengaliDateTime';

test('toBengaliDigits converts English numerals to Bengali digits', () => {
  assert.equal(toBengaliDigits(12345), '১২৩৪৫');
  assert.equal(toBengaliDigits(67890), '৬৭৮৯০');
});

test('getBengaliDaypart returns correct Bengali dayparts based on 24h hour', () => {
  assert.equal(getBengaliDaypart(5), 'ভোর');
  assert.equal(getBengaliDaypart(9), 'সকাল');
  assert.equal(getBengaliDaypart(13), 'দুপুর');
  assert.equal(getBengaliDaypart(17), 'বিকেল');
  assert.equal(getBengaliDaypart(19), 'সন্ধ্যা');
  assert.equal(getBengaliDaypart(22), 'রাত');
  assert.equal(getBengaliDaypart(2), 'রাত');
});

test('detectDateTimeQuery detects time, date, and weekday requests', () => {
  assert.equal(detectDateTimeQuery('এখন কয়টা বাজে?'), 'time');
  assert.equal(detectDateTimeQuery('what time is it'), 'time');
  assert.equal(detectDateTimeQuery('আজকে কত তারিখ?'), 'date');
  assert.equal(detectDateTimeQuery('what is today date'), 'date');
  assert.equal(detectDateTimeQuery('আজ কি বার?'), 'weekday');
  assert.equal(detectDateTimeQuery('which day is it today'), 'weekday');
  // Should return null for international cities (delegated to LLM)
  assert.equal(detectDateTimeQuery('what time is it in Tokyo?'), null);
});

test('format functions return non-empty strings with Kolkata time', () => {
  const spokenTime = formatBengaliSpokenTime();
  const spokenDate = formatBengaliDate();
  const spokenWeekday = formatBengaliWeekday();

  assert.ok(spokenTime.includes('এখন'));
  assert.ok(spokenDate.includes('আজ'));
  assert.ok(spokenWeekday.includes('আজ'));
});
