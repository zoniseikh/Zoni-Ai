package com.zoni.jarvis.assistant.domain

import java.time.DayOfWeek
import java.time.Instant
import java.time.ZoneId
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter

/**
 * Zoni AI - India Time, Date and Weekday Engine (Asia/Kolkata)
 * 100% parity with src/utils/bengaliDateTime.ts:
 * - Time: Bengali 12-hour spoken format with dayparts (ভোর, সকাল, দুপুর, বিকেল, সন্ধ্যা, রাত)
 * - Date: e.g. "আজ ১৩ অক্টোবর ২০২৬।"
 * - Weekday: e.g. "আজ মঙ্গলবার।"
 */
object BengaliDateTimeEngine {

    private val KOLKATA_ZONE: ZoneId = ZoneId.of("Asia/Kolkata")

    private val BENGALI_DIGITS = charArrayOf('০', '১', '২', '৩', '৪', '৫', '৬', '৭', '৮', '৯')

    private val BENGALI_HOUR_WORDS = mapOf(
        1 to "এক", 2 to "দুই", 3 to "তিন", 4 to "চার", 5 to "পাঁচ", 6 to "ছয়",
        7 to "সাত", 8 to "আট", 9 to "নয়", 10 to "দশ", 11 to "এগারো", 12 to "বারো"
    )

    private val BENGALI_MINUTE_WORDS = mapOf(
        1 to "এক", 2 to "দুই", 3 to "তিন", 4 to "চার", 5 to "পাঁচ",
        6 to "ছয়", 7 to "সাত", 8 to "আট", 9 to "নয়", 10 to "দশ",
        11 to "এগারো", 12 to "বারো", 13 to "তেরো", 14 to "চোদ্দ", 15 to "পনেরো",
        16 to "ষোলো", 17 to "সতেরো", 18 to "আঠারো", 19 to "উনিশ", 20 to "বিশ",
        21 to "একুশ", 22 to "বাইশ", 23 to "তেইশ", 24 to "চব্বিশ", 25 to "পঁচিশ",
        26 to "ছাব্বিশ", 27 to "সাতাশ", 28 to "আঠাশ", 29 to "উনত্রিশ", 30 to "ত্রিশ",
        31 to "একত্রিশ", 32 to "বত্রিশ", 33 to "তেত্রিশ", 34 to "চৌত্রিশ", 35 to "পঁয়ত্রিশ",
        36 to "ছত্রিশ", 37 to "সাঁইত্রিশ", 38 to "আটত্রিশ", 39 to "উনচল্লিশ", 40 to "চল্লিশ",
        41 to "একচল্লিশ", 42 to "বিয়াল্লিশ", 43 to "তেতাল্লিশ", 44 to "চুয়াল্লিশ", 45 to "পঁয়তাল্লিশ",
        46 to "ছেচল্লিশ", 47 to "সাতচল্লিশ", 48 to "আটচল্লিশ", 49 to "উনপঞ্চাশ", 50 to "পঞ্চাশ",
        51 to "একান্ন", 52 to "বায়ান্ন", 53 to "তিপ্পান্ন", 54 to "চুয়ান্ন", 55 to "পঞ্চান্ন",
        56 to "ছাপ্পান্ন", 57 to "সাতান্ন", 58 to "আটান্ন", 59 to "উনষাট"
    )

    private val BENGALI_MONTHS = mapOf(
        1 to "জানুয়ারি", 2 to "ফেব্রুয়ারি", 3 to "মার্চ", 4 to "এপ্রিল",
        5 to "মে", 6 to "জুন", 7 to "জুলাই", 8 to "আগস্ট",
        9 to "সেপ্টেম্বর", 10 to "অক্টোবর", 11 to "নভেম্বর", 12 to "ডিসেম্বর"
    )

    private val BENGALI_WEEKDAYS = mapOf(
        DayOfWeek.SUNDAY to "রবিবার",
        DayOfWeek.MONDAY to "সোমবার",
        DayOfWeek.TUESDAY to "মঙ্গলবার",
        DayOfWeek.WEDNESDAY to "বুধবার",
        DayOfWeek.THURSDAY to "বৃহস্পতিবার",
        DayOfWeek.FRIDAY to "শুক্রবার",
        DayOfWeek.SATURDAY to "শনিবার"
    )

    private val FOREIGN_CITY_KEYWORDS = listOf(
        "london", "tokyo", "new york", "paris", "dubai", "sydney", "dhaka",
        "america", "japan", "uk", "canada", "russia", "moscow", "singapore"
    )

    fun toBengaliDigits(input: String): String {
        val sb = StringBuilder(input.length)
        for (ch in input) {
            if (ch in '0'..'9') {
                sb.append(BENGALI_DIGITS[ch - '0'])
            } else {
                sb.append(ch)
            }
        }
        return sb.toString()
    }

    fun getBengaliDaypart(hour: Int): String = when {
        hour in 4..5 -> "ভোর"
        hour in 6..11 -> "সকাল"
        hour in 12..15 -> "দুপুর"
        hour in 16..17 -> "বিকেল"
        hour in 18..19 -> "সন্ধ্যা"
        else -> "রাত"
    }

    fun nowKolkata(instant: Instant = Instant.now()): ZonedDateTime =
        instant.atZone(KOLKATA_ZONE)

    fun formatClock24Ist(instant: Instant = Instant.now()): String =
        nowKolkata(instant).format(DateTimeFormatter.ofPattern("HH:mm:ss"))

    fun formatShortTimeIst(timestampMillis: Long): String =
        Instant.ofEpochMilli(timestampMillis)
            .atZone(KOLKATA_ZONE)
            .format(DateTimeFormatter.ofPattern("hh:mm a"))

    fun formatBengaliSpokenTime(instant: Instant = Instant.now()): String {
        val dt = nowKolkata(instant)
        val hour = dt.hour
        val minute = dt.minute
        val daypart = getBengaliDaypart(hour)
        val hour12 = if (hour % 12 == 0) 12 else hour % 12
        val hourWord = BENGALI_HOUR_WORDS[hour12] ?: "এক"

        if (minute == 0) {
            return "এখন $daypart ${hourWord}টা।"
        }
        val minuteWord = BENGALI_MINUTE_WORDS[minute] ?: toBengaliDigits(minute.toString())
        return "এখন $daypart ${hourWord}টা বেজে $minuteWord মিনিট।"
    }

    fun formatBengaliDate(instant: Instant = Instant.now()): String {
        val dt = nowKolkata(instant)
        val dayDigits = toBengaliDigits(dt.dayOfMonth.toString())
        val monthWord = BENGALI_MONTHS[dt.monthValue] ?: "অক্টোবর"
        val yearDigits = toBengaliDigits(dt.year.toString())
        return "আজ $dayDigits $monthWord $yearDigits।"
    }

    fun formatBengaliWeekday(instant: Instant = Instant.now()): String {
        val dt = nowKolkata(instant)
        val weekday = BENGALI_WEEKDAYS[dt.dayOfWeek] ?: "মঙ্গলবার"
        return "আজ $weekday।"
    }

    enum class DateTimeQueryType {
        TIME, DATE, WEEKDAY
    }

    fun detectDateTimeQuery(text: String): DateTimeQueryType? {
        val clean = text.trim().lowercase()
        if (FOREIGN_CITY_KEYWORDS.any { clean.contains(it) }) {
            return null
        }

        val weekdayPatterns = listOf(
            Regex("(?:আজ|আজকে|আজকের)\\s*(?:কি|কী|কোন)\\s*বার"),
            Regex("\\bwhat\\s*(?:week)?day\\s*(?:is\\s*(?:it\\s*)?today|is\\s*it)\\b"),
            Regex("\\bwhich\\s*day\\s*is\\s*(?:it\\s*)?today\\b"),
            Regex("\\baaj\\s*(?:kya|kaun\\s*sa|konsa)\\s*din\\s*hai\\b"),
            Regex("\\btoday['’]?s?\\s*weekday\\b")
        )
        if (weekdayPatterns.any { it.containsMatchIn(clean) }) {
            return DateTimeQueryType.WEEKDAY
        }

        val datePatterns = listOf(
            Regex("(?:আজ|আজকে|আজকের)\\s*(?:কত|কি|কী)?\\s*তারিখ"),
            Regex("(?:তারিখ)\\s*(?:কত|কি|কী|বলো|বলুন)"),
            Regex("\\bwhat\\s*(?:is\\s*)?(?:today['’]?s?\\s*date|the\\s*date\\s*(?:is\\s*)?today)\\b"),
            Regex("\\btoday['’]?s?\\s*date\\b"),
            Regex("\\bcurrent\\s*date\\b"),
            Regex("\\baaj\\s*(?:kya|kitni|kaun\\s*si)\\s*t(?:aa)?rikh\\b"),
            Regex("\\baaj\\s*k[ie]\\s*date\\b")
        )
        if (datePatterns.any { it.containsMatchIn(clean) }) {
            return DateTimeQueryType.DATE
        }

        val timePatterns = listOf(
            Regex("(?:কয়টা|কয়টা)\\s*বাজে"),
            Regex("(?:সময়|সময়|shomoy)\\s*(?:কত|koto|বলো|বলুন)"),
            Regex("এখন\\s*(?:কয়টা|কয়টা|সময়|সময়)"),
            Regex("\\bwhat\\s*time\\s*is\\s*it\\b"),
            Regex("\\bwhat\\s*(?:is\\s*the\\s*|['’]s\\s*the\\s*|is\\s*)time\\b"),
            Regex("\\bcurrent\\s*time\\b"),
            Regex("\\btell\\s*(?:me\\s*)?(?:the\\s*)?time\\b"),
            Regex("\\btime\\s*(?:kya|batao|please)\\b"),
            Regex("\\bsamay\\s*(?:kya|batao)\\b"),
            Regex("\\bkitne\\s*baje\\b")
        )
        if (timePatterns.any { it.containsMatchIn(clean) }) {
            return DateTimeQueryType.TIME
        }

        return null
    }
}
