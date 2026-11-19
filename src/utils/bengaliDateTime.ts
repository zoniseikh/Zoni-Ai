/**
 * Zoni AI - India Time, Date and Weekday Engine (Asia/Kolkata)
 * Adheres strictly to Bengali spoken format rules:
 * - Time: Bengali 12-hour spoken format with dayparts (ভোর, সকাল, দুপুর, বিকেল, সন্ধ্যা, রাত)
 * - Date: e.g. "আজ ১৩ অক্টোবর ২০২৬।"
 * - Weekday: e.g. "আজ মঙ্গলবার।"
 */

export const BENGALI_DIGITS = ['০', '১', '২', '৩', '৪', '৫', '৬', '৭', '৮', '৯'];

export function toBengaliDigits(num: number | string): string {
  return String(num).replace(/[0-9]/g, (d) => BENGALI_DIGITS[parseInt(d, 10)]);
}

export const BENGALI_HOUR_WORDS: Record<number, string> = {
  1: 'এক',
  2: 'দুই',
  3: 'তিন',
  4: 'চার',
  5: 'পাঁচ',
  6: 'ছয়',
  7: 'সাত',
  8: 'আট',
  9: 'নয়',
  10: 'দশ',
  11: 'এগারো',
  12: 'বারো',
};

export const BENGALI_MINUTE_WORDS: Record<number, string> = {
  1: 'এক',
  2: 'দুই',
  3: 'তিন',
  4: 'চার',
  5: 'পাঁচ',
  6: 'ছয়',
  7: 'সাত',
  8: 'আট',
  9: 'নয়',
  10: 'দশ',
  11: 'এগারো',
  12: 'বারো',
  13: 'তেরো',
  14: 'চোদ্দ',
  15: 'পনেরো',
  16: 'ষোলো',
  17: 'সতেরো',
  18: 'আঠারো',
  19: 'উনিশ',
  20: 'বিশ',
  21: 'একুশ',
  22: 'বাইশ',
  23: 'তেইশ',
  24: 'চব্বিশ',
  25: 'পঁচিশ',
  26: 'ছাব্বিশ',
  27: 'সাতাশ',
  28: 'আঠাশ',
  29: 'উনত্রিশ',
  30: 'ত্রিশ',
  31: 'একত্রিশ',
  32: 'বত্রিশ',
  33: 'তেত্রিশ',
  34: 'চৌত্রিশ',
  35: 'পঁয়ত্রিশ',
  36: 'ছত্রিশ',
  37: 'সাঁইত্রিশ',
  38: 'আটত্রিশ',
  39: 'উনচল্লিশ',
  40: 'চল্লিশ',
  41: 'একচল্লিশ',
  42: 'বিয়াল্লিশ',
  43: 'তেতাল্লিশ',
  44: 'চুয়াল্লিশ',
  45: 'পঁয়তাল্লিশ',
  46: 'ছেচল্লিশ',
  47: 'সাতচল্লিশ',
  48: 'আটচল্লিশ',
  49: 'উনপঞ্চাশ',
  50: 'পঞ্চাশ',
  51: 'একান্ন',
  52: 'বায়ান্ন',
  53: 'তিপ্পান্ন',
  54: 'চুয়ান্ন',
  55: 'পঞ্চান্ন',
  56: 'ছাপ্পান্ন',
  57: 'সাতান্ন',
  58: 'আটান্ন',
  59: 'উনষাট',
};

export const BENGALI_MONTHS: Record<number, string> = {
  1: 'জানুয়ারি',
  2: 'ফেব্রুয়ারি',
  3: 'মার্চ',
  4: 'এপ্রিল',
  5: 'মে',
  6: 'জুন',
  7: 'জুলাই',
  8: 'আগস্ট',
  9: 'সেপ্টেম্বর',
  10: 'অক্টোবর',
  11: 'নভেম্বর',
  12: 'ডিসেম্বর',
};

export const BENGALI_WEEKDAYS: Record<string, string> = {
  Sunday: 'রবিবার',
  Monday: 'সোমবার',
  Tuesday: 'মঙ্গলবার',
  Wednesday: 'বুধবার',
  Thursday: 'বৃহস্পতিবার',
  Friday: 'শুক্রবার',
  Saturday: 'শনিবার',
};

/**
 * Extracts year, month, day, hour, minute, second, weekday in Asia/Kolkata
 */
export function getKolkataTimeComponents(inputDate: Date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hour12: false,
    weekday: 'long',
  });

  const parts = formatter.formatToParts(inputDate);
  let year = 2026;
  let month = 10;
  let day = 13;
  let hour = 13;
  let minute = 0;
  let second = 0;
  let weekdayEnglish = 'Tuesday';

  for (const p of parts) {
    if (p.type === 'year') year = parseInt(p.value, 10);
    else if (p.type === 'month') month = parseInt(p.value, 10);
    else if (p.type === 'day') day = parseInt(p.value, 10);
    else if (p.type === 'hour') hour = parseInt(p.value, 10);
    else if (p.type === 'minute') minute = parseInt(p.value, 10);
    else if (p.type === 'second') second = parseInt(p.value, 10);
    else if (p.type === 'weekday') weekdayEnglish = p.value;
  }

  // Handle midnight 24 hour representation if returned as 24
  if (hour === 24) hour = 0;

  const bengaliWeekday = BENGALI_WEEKDAYS[weekdayEnglish] || 'মঙ্গলবার';

  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    weekdayEnglish,
    bengaliWeekday,
  };
}

/**
 * Determines the Bengali daypart from local hour (0-23):
 * - ভোর: 4:00 - 5:59
 * - সকাল: 6:00 - 11:59
 * - দুপুর: 12:00 - 15:59 (12:00 PM - 3:59 PM)
 * - বিকেল: 16:00 - 17:59 (4:00 PM - 5:59 PM)
 * - সন্ধ্যা: 18:00 - 19:59 (6:00 PM - 7:59 PM)
 * - রাত: 20:00 - 3:59 (8:00 PM - 3:59 AM)
 */
export function getBengaliDaypart(hour: number): 'ভোর' | 'সকাল' | 'দুপুর' | 'বিকেল' | 'সন্ধ্যা' | 'রাত' {
  if (hour >= 4 && hour < 6) return 'ভোর';
  if (hour >= 6 && hour < 12) return 'সকাল';
  if (hour >= 12 && hour < 16) return 'দুপুর';
  if (hour >= 16 && hour < 18) return 'বিকেল';
  if (hour >= 18 && hour < 20) return 'সন্ধ্যা';
  return 'রাত';
}

/**
 * Formats time in spoken 12-hour Bengali format with daypart.
 * Example at 06:00 -> "এখন সকাল ছয়টা।"
 * Example at 13:00 -> "এখন দুপুর একটা।"
 * Example at 13:48 -> "এখন দুপুর একটা বেজে আটচল্লিশ মিনিট।"
 */
export function formatBengaliSpokenTime(inputDate: Date = new Date()): string {
  const { hour, minute } = getKolkataTimeComponents(inputDate);
  const daypart = getBengaliDaypart(hour);
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  const hourWord = BENGALI_HOUR_WORDS[hour12] || 'এক';

  if (minute === 0) {
    return `এখন ${daypart} ${hourWord}টা।`;
  }

  const minuteWord = BENGALI_MINUTE_WORDS[minute] || toBengaliDigits(minute);
  return `এখন ${daypart} ${hourWord}টা বেজে ${minuteWord} মিনিট।`;
}

/**
 * Formats current date in Bengali.
 * Example -> "আজ ১৩ অক্টোবর ২০২৬।"
 */
export function formatBengaliDate(inputDate: Date = new Date()): string {
  const { year, month, day } = getKolkataTimeComponents(inputDate);
  const dayDigits = toBengaliDigits(day);
  const monthWord = BENGALI_MONTHS[month] || 'অক্টোবর';
  const yearDigits = toBengaliDigits(year);
  return `আজ ${dayDigits} ${monthWord} ${yearDigits}।`;
}

/**
 * Formats current weekday only in Bengali.
 * Example -> "আজ মঙ্গলবার।"
 */
export function formatBengaliWeekday(inputDate: Date = new Date()): string {
  const { bengaliWeekday } = getKolkataTimeComponents(inputDate);
  return `আজ ${bengaliWeekday}।`;
}

/**
 * Returns complete India / Kolkata date-time package for system instruction and endpoints
 */
export function getIndiaDateTimeSummary(inputDate: Date = new Date()) {
  const comps = getKolkataTimeComponents(inputDate);
  const spokenTime = formatBengaliSpokenTime(inputDate);
  const spokenDate = formatBengaliDate(inputDate);
  const spokenWeekday = formatBengaliWeekday(inputDate);

  return {
    ...comps,
    spokenTime,
    spokenDate,
    spokenWeekday,
    timezone: 'Asia/Kolkata',
  };
}

/**
 * Detects if user is asking for time, date, or weekday
 */
export function detectDateTimeQuery(text: string): 'time' | 'date' | 'weekday' | null {
  const clean = text.trim().toLowerCase();

  // If user explicitly asks for another city or country, let LLM handle the location query
  const cityNames = [
    'london',
    'tokyo',
    'new york',
    'paris',
    'dubai',
    'sydney',
    'dhaka',
    'america',
    'japan',
    'uk',
    'canada',
    'russia',
    'moscow',
    'singapore',
  ];
  for (const city of cityNames) {
    if (clean.includes(city)) return null;
  }

  // Weekday query detection
  if (
    /(?:আজ|আজকে|আজকের)\s*(?:কি|কী|কোন)\s*বার/.test(clean) ||
    /\bwhat\s*(?:week)?day\s*(?:is\s*(?:it\s*)?today|is\s*it)\b/i.test(clean) ||
    /\bwhich\s*day\s*is\s*(?:it\s*)?today\b/i.test(clean) ||
    /\baaj\s*(?:kya|kaun\s*sa|konsa)\s*din\s*hai\b/i.test(clean) ||
    /\btoday['’]?s?\s*weekday\b/i.test(clean)
  ) {
    return 'weekday';
  }

  // Date query detection
  if (
    /(?:আজ|আজকে|আজকের)\s*(?:কত|কি|কী)?\s*তারিখ/.test(clean) ||
    /(?:তারিখ)\s*(?:কত|কি|কী|বলো|বলুন)/.test(clean) ||
    /\bwhat\s*(?:is\s*)?(?:today['’]?s?\s*date|the\s*date\s*(?:is\s*)?today)\b/i.test(clean) ||
    /\btoday['’]?s?\s*date\b/i.test(clean) ||
    /\bcurrent\s*date\b/i.test(clean) ||
    /\baaj\s*(?:kya|kitni|kaun\s*si)\s*t(?:aa)?rikh\b/i.test(clean) ||
    /\baaj\s*k[ie]\s*date\b/i.test(clean)
  ) {
    return 'date';
  }

  // Time query detection
  if (
    /(?:কয়টা|কয়টা)\s*বাজে/.test(clean) ||
    /(?:সময়|সময়|shomoy)\s*(?:কত|koto|বলো|বলুন)/.test(clean) ||
    /এখন\s*(?:কয়টা|কয়টা|সময়|সময়)/.test(clean) ||
    /\bwhat\s*time\s*is\s*it\b/i.test(clean) ||
    /\bwhat\s*(?:is\s*the\s*|['’]s\s*the\s*|is\s*)time\b/i.test(clean) ||
    /\bcurrent\s*time\b/i.test(clean) ||
    /\btell\s*(?:me\s*)?(?:the\s*)?time\b/i.test(clean) ||
    /\btime\s*(?:kya|batao|please)\b/i.test(clean) ||
    /\bsamay\s*(?:kya|batao)\b/i.test(clean) ||
    /\bkitne\s*baje\b/i.test(clean)
  ) {
    return 'time';
  }

  return null;
}
