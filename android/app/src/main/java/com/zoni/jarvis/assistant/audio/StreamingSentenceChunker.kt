package com.zoni.jarvis.assistant.audio

/**
 * Pure JVM-testable streaming sentence chunker for Zoni AI's Android real-time voice response path.
 * Buffers streamed text deltas and emits complete, natural sentence segments immediately
 * (English, Bengali `।`, Hindi `।`, newlines, and long-clause pauses) while preserving
 * abbreviations (`Dr.`, `Mr.`, `e.g.`) and decimals (`3.14`).
 */
class StreamingSentenceChunker(
    private val minSentenceChars: Int = 16,
    private val maxClauseFlushChars: Int = 76
) {
    private val buffer = StringBuilder()

    fun reset() {
        buffer.clear()
    }

    fun pushDelta(delta: String): List<String> {
        if (delta.isEmpty()) return emptyList()
        buffer.append(delta)
        val ready = mutableListOf<String>()

        while (buffer.isNotEmpty()) {
            val current = buffer.toString()
            val idx = findSafeBoundaryIndex(current)
            if (idx < 0) break

            val rawSegment = current.substring(0, idx + 1)
            val remaining = current.substring(idx + 1).trimStart()
            buffer.clear()
            buffer.append(remaining)

            val clean = stripActionTagsForSpeech(rawSegment)
            if (clean.isNotEmpty()) {
                ready.add(clean)
            }
        }
        return ready
    }

    fun flush(): List<String> {
        val clean = stripActionTagsForSpeech(buffer.toString())
        buffer.clear()
        return if (clean.isNotEmpty()) listOf(clean) else emptyList()
    }

    private fun findSafeBoundaryIndex(text: String): Int {
        for (i in text.indices) {
            val ch = text[i]
            val next = if (i + 1 < text.length) text[i + 1] else '\u0000'

            if (ch == '\n' || ch == '।' || ch == '!' || ch == '?') {
                if (i + 1 >= minSentenceChars) return i
                continue
            }

            if (ch == '.') {
                val prev = if (i > 0) text[i - 1] else '\u0000'
                if (prev.isDigit() && next.isDigit()) continue
                if (next == '.') continue
                if (next != '\u0000' && !next.isWhitespace()) continue
                val prefix = text.substring(0, i + 1)
                if (endsWithAbbreviation(prefix)) continue
                if (i + 1 >= minSentenceChars) return i
            }

            if ((ch == ',' || ch == ';' || ch == ':' || ch == '—') && i + 1 >= maxClauseFlushChars) {
                if (next == '\u0000' || next.isWhitespace()) return i
            }
        }
        return -1
    }

    companion object {
        private val ABBREVIATIONS = setOf(
            "dr.", "mr.", "mrs.", "ms.", "prof.", "sr.", "jr.",
            "st.", "vs.", "etc.", "e.g.", "i.e.", "no.", "fig."
        )

        private val ACTION_TAG_REGEX = Regex("\\[ACTION:[^\\]]+]", RegexOption.IGNORE_CASE)
        private val MARKDOWN_REGEX = Regex("[*_`#~]+")
        private val WHITESPACE_REGEX = Regex("\\s+")
        private val TRAILING_ABBR_REGEX = Regex("([A-Za-z]{1,4}\\.)$")

        private fun endsWithAbbreviation(text: String): Boolean {
            val match = TRAILING_ABBR_REGEX.find(text.trimEnd()) ?: return false
            return match.groupValues[1].lowercase() in ABBREVIATIONS
        }

        fun stripActionTagsForSpeech(text: String): String {
            return text
                .replace(ACTION_TAG_REGEX, " ")
                .replace(MARKDOWN_REGEX, "")
                .replace(WHITESPACE_REGEX, " ")
                .trim()
        }
    }
}
