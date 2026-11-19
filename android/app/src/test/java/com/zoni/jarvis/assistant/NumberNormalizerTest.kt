package com.zoni.jarvis.assistant

import com.zoni.jarvis.assistant.domain.NumberNormalizer
import com.zoni.jarvis.assistant.domain.NumberNormalizerResult
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class NumberNormalizerTest {

    @Test
    fun testBengaliDigitConversion() {
        val bengaliDigits = "০১২৩৪৫৬৭৮৯"
        val ascii = NumberNormalizer.convertDigitsToAscii(bengaliDigits)
        assertEquals("0123456789", ascii)
    }

    @Test
    fun testMixedDigitsAndSpacing() {
        val mixed = "৯৮৭ 654 ৩২১০"
        val ascii = NumberNormalizer.convertDigitsToAscii(mixed)
        assertEquals("987 654 3210", ascii)

        val result = NumberNormalizer.normalizePhoneNumber(mixed)
        assertTrue(result is NumberNormalizerResult.ValidCandidate)
        val valid = result as NumberNormalizerResult.ValidCandidate
        assertEquals("+919876543210", valid.normalizedNumber)
        assertEquals("IN", valid.country)
    }

    @Test
    fun testBangladeshFormat() {
        val rawBd = "০১৭১২৩৪৫৬৭৮"
        val result = NumberNormalizer.normalizePhoneNumber(rawBd)
        assertTrue(result is NumberNormalizerResult.ValidCandidate)
        val valid = result as NumberNormalizerResult.ValidCandidate
        assertEquals("+8801712345678", valid.normalizedNumber)
        assertEquals("BD", valid.country)
    }

    @Test
    fun testIncompleteNumber() {
        val incomplete = "১২৩৪"
        val result = NumberNormalizer.normalizePhoneNumber(incomplete)
        assertTrue(result is NumberNormalizerResult.IncompleteNumber)
        val inc = result as NumberNormalizerResult.IncompleteNumber
        assertEquals(4, inc.currentLength)
    }

    @Test
    fun testInvalidEmptyNumber() {
        val result = NumberNormalizer.normalizePhoneNumber("   ")
        assertTrue(result is NumberNormalizerResult.InvalidNumber)
    }
}
