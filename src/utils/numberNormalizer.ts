/**
 * Dedicated, testable phone-number normalization component for Zoni AI.
 * Handles:
 * - Bengali digits: ০১২৩৪৫৬৭৮৯
 * - ASCII digits: 0123456789
 * - Mixed Bengali and English digits
 * - Speech-recognition spacing errors (e.g. 987 654 3210)
 * - Country-code normalization (+880 / +91)
 * - Explicit distinction between incomplete number and valid candidate
 */

export interface ValidCandidateResult {
  status: 'valid';
  original: string;
  normalizedNumber: string;
  formatted: string;
  country?: string;
}

export interface IncompleteNumberResult {
  status: 'incomplete';
  original: string;
  currentDigits: string;
  currentLength: number;
}

export interface InvalidNumberResult {
  status: 'invalid';
  original: string;
  reason: string;
}

export interface AmbiguousResult {
  status: 'ambiguous';
  original: string;
  candidates: string[];
}

export type NormalizerResult =
  | ValidCandidateResult
  | IncompleteNumberResult
  | InvalidNumberResult
  | AmbiguousResult;

const BENGALI_DIGIT_MAP: Record<string, string> = {
  '০': '0',
  '১': '1',
  '২': '2',
  '৩': '3',
  '৪': '4',
  '৫': '5',
  '৬': '6',
  '৭': '7',
  '৮': '8',
  '৯': '9',
};

const WORD_TO_DIGIT: Record<string, string> = {
  zero: '0',
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
  শূণ্য: '0',
  শূন্য: '0',
  এক: '1',
  দুই: '2',
  তিন: '3',
  চার: '4',
  পাঁচ: '5',
  ছয়: '6',
  ছয়: '6',
  সাত: '7',
  আট: '8',
  নয়: '9',
  নয়: '9',
};

export function convertDigitsToAscii(input: string): string {
  let processed = input.trim();

  // Convert unambiguous word numbers
  for (const [word, digit] of Object.entries(WORD_TO_DIGIT)) {
    const regex = new RegExp(`\\b${word}\\b`, 'gi');
    processed = processed.replace(regex, digit);
  }

  // Convert Bengali characters
  return processed.replace(/[০-৯]/g, (ch) => BENGALI_DIGIT_MAP[ch] || ch);
}

export function normalizePhoneNumber(input: string): NormalizerResult {
  const trimmed = input.trim();
  if (!trimmed) {
    return {
      status: 'invalid',
      original: trimmed,
      reason: 'Number input is empty.',
    };
  }

  const converted = convertDigitsToAscii(trimmed);
  const hasLeadingPlus = converted.startsWith('+');
  const digitsOnly = converted.replace(/[^0-9]/g, '');

  if (!digitsOnly) {
    return {
      status: 'invalid',
      original: trimmed,
      reason: 'No digits recognized in input.',
    };
  }

  // Fewer than 7 digits is incomplete
  if (digitsOnly.length < 7) {
    return {
      status: 'incomplete',
      original: trimmed,
      currentDigits: digitsOnly,
      currentLength: digitsOnly.length,
    };
  }

  // Bangladesh 11-digit mobile: starts with 01
  if (digitsOnly.length === 11 && digitsOnly.startsWith('01')) {
    const formatted = `+88${digitsOnly}`;
    return {
      status: 'valid',
      original: trimmed,
      normalizedNumber: formatted,
      formatted,
      country: 'BD',
    };
  }

  // Bangladesh 13-digit: 8801...
  if (digitsOnly.length === 13 && digitsOnly.startsWith('8801')) {
    const formatted = `+${digitsOnly}`;
    return {
      status: 'valid',
      original: trimmed,
      normalizedNumber: formatted,
      formatted,
      country: 'BD',
    };
  }

  // India 10-digit mobile: starts with 6-9
  if (digitsOnly.length === 10 && /^[6-9]/.test(digitsOnly)) {
    const formatted = `+91${digitsOnly}`;
    return {
      status: 'valid',
      original: trimmed,
      normalizedNumber: formatted,
      formatted,
      country: 'IN',
    };
  }

  // India 12-digit: 91 + 10 digits
  if (digitsOnly.length === 12 && digitsOnly.startsWith('91') && /^[6-9]/.test(digitsOnly.substring(2))) {
    const formatted = `+${digitsOnly}`;
    return {
      status: 'valid',
      original: trimmed,
      normalizedNumber: formatted,
      formatted,
      country: 'IN',
    };
  }

  // E.164 standard candidate (10 to 15 digits)
  if (digitsOnly.length >= 10 && digitsOnly.length <= 15) {
    const normalized = hasLeadingPlus ? `+${digitsOnly}` : digitsOnly;
    return {
      status: 'valid',
      original: trimmed,
      normalizedNumber: normalized,
      formatted: normalized,
    };
  }

  if (digitsOnly.length >= 7 && digitsOnly.length <= 9) {
    return {
      status: 'incomplete',
      original: trimmed,
      currentDigits: digitsOnly,
      currentLength: digitsOnly.length,
    };
  }

  return {
    status: 'invalid',
    original: trimmed,
    reason: `Digit count (${digitsOnly.length}) does not match valid phone number formats.`,
  };
}
