package com.zoni.jarvis.assistant.domain

import kotlin.math.min
import kotlin.math.pow
import kotlin.math.roundToLong

/**
 * Pure intent detection, flashlight command matching, language switching,
 * action tag extraction, and turn transcript merging for Zoni AI Android.
 * 100% parity with src/utils/mobileAssistant.ts and src/utils/liveSessionProtocol.ts.
 */
object MobileAssistantEngine {

    fun normalizeSpokenCommand(text: String): String =
        text.trim()
            .replace(Regex("[.,?!;:।\\-_]"), " ")
            .replace(Regex("\\s+"), " ")
            .lowercase()

    fun isNonFlashlightLightQuery(text: String): Boolean {
        val lower = text.lowercase()
        val negativeTerms = listOf(
            "traffic light", "sun gives light", "speed of light", "light year",
            "কবিতা", "গান", "অর্থ কী", "মানে কী", "কী", "কি", "what is", "tell me about"
        )
        return negativeTerms.any { lower.contains(it) }
    }

    fun isFlashlightOnCommand(raw: String): Boolean {
        val normalized = normalizeSpokenCommand(raw)
        if (isNonFlashlightLightQuery(normalized)) return false

        val englishOnRegex = Regex(
            "^(?:(?:please\\s+)?(?:turn\\s+on|switch\\s+on)\\s+(?:the\\s+)?(?:flashlight|torch|phone\\s+light|mobile\\s+light)|(?:turn\\s+on|switch\\s+on)\\s+(?:the\\s+)?light|(?:flashlight|torch)\\s+(?:on|please\\s+on|turn\\s+on|switch\\s+on)|(?:phone|mobile)\\s+light\\s+(?:on|turn\\s+on))$",
            RegexOption.IGNORE_CASE
        )
        if (englishOnRegex.matches(normalized)) return true

        val hasTorchNoun = Regex("(?:টর্চ|টরচ|ফ্ল্যাশ\\s*লাইট|ফ্লাস\\s*লাইট|মোবাইলের\\s*লাইট|ফোনের\\s*লাইট)").containsMatchIn(normalized)
        val hasOnVerb = Regex("(?:জ্বালাও|জ্বালিয়ে\\s*দাও|জ্বালিয়ে\\s*দাও|অন\\s*করো|অন\\s*কর|চালু\\s*করো|চালু\\s*কর)").containsMatchIn(normalized)
        if (hasTorchNoun && hasOnVerb) return true

        val directLightOn = Regex("^(?:মোবাইলের\\s*)?লাইট\\s*(?:অন\\s*করো|অন\\s*কর|জ্বালাও|জ্বালিয়ে\\s*দাও|জ্বালিয়ে\\s*দাও|চালু\\s*করো)$")
        return directLightOn.matches(normalized)
    }

    fun isFlashlightOffCommand(raw: String): Boolean {
        val normalized = normalizeSpokenCommand(raw)
        if (isNonFlashlightLightQuery(normalized)) return false

        val englishOffRegex = Regex(
            "^(?:(?:please\\s+)?(?:turn\\s+off|switch\\s+off)\\s+(?:the\\s+)?(?:flashlight|torch|phone\\s+light|mobile\\s+light)|(?:turn\\s+off|switch\\s+off)\\s+(?:the\\s+)?light|(?:flashlight|torch)\\s+(?:off|please\\s+off|turn\\s+off|switch\\s+off)|(?:phone|mobile)\\s+light\\s+(?:off|turn\\s+off))$",
            RegexOption.IGNORE_CASE
        )
        if (englishOffRegex.matches(normalized)) return true

        val hasTorchNoun = Regex("(?:টর্চ|টরচ|ফ্ল্যাশ\\s*লাইট|ফ্লাস\\s*লাইট|মোবাইলের\\s*লাইট|ফোনের\\s*লাইট)").containsMatchIn(normalized)
        val hasOffVerb = Regex("(?:বন্ধ\\s*করো|বন্ধ\\s*কর|বন্ধ\\s*করে\\s*দাও|অফ\\s*করো|অফ\\s*কর|নিভিয়ে\\s*দাও|নিভিয়ে\\s*দাও|নিভাও)").containsMatchIn(normalized)
        if (hasTorchNoun && hasOffVerb) return true

        val directLightOff = Regex("^(?:মোবাইলের\\s*)?লাইট\\s*(?:অফ\\s*করো|অফ\\s*কর|বন্ধ\\s*করো|বন্ধ\\s*কর|বন্ধ\\s*করে\\s*দাও|নিভিয়ে\\s*দাও|নিভিয়ে\\s*দাও|নিভাও)$")
        return directLightOff.matches(normalized)
    }

    fun detectAssistantIntent(text: String): AssistantAction? {
        val lower = text.lowercase().trim()
        val asciiDigits = NumberNormalizer.convertDigitsToAscii(lower)

        // 1. Phone Call Intent (number or contact name)
        val callNumberMatch = Regex(
            "(?:কল\\s*(?:করো|করুন)|call|phone\\s*(?:karo|lagao)|ফোন\\s*(?:করো|করুন))\\s*([+0-9\\s-]{6,16})",
            RegexOption.IGNORE_CASE
        ).find(asciiDigits)
        if (callNumberMatch != null) {
            val number = callNumberMatch.groupValues[1].replace(Regex("[\\s-]"), "")
            return AssistantAction(ActionType.CALL, target = number, label = "Phone Call to $number")
        }

        // 2. WhatsApp Intent
        val waMatch = Regex(
            "(?:হোয়াটসঅ্যাপ|whatsapp|whats\\s*app)\\s*(?:করো|karo|send)?\\s*([+0-9\\s-]{6,16})?\\s*(?:মেসেজ|message|text)?\\s*(.*)",
            RegexOption.IGNORE_CASE
        ).find(asciiDigits)
        if (waMatch != null && (waMatch.groupValues[1].isNotBlank() || lower.contains("whatsapp") || lower.contains("হোয়াটসঅ্যাপ"))) {
            val number = waMatch.groupValues[1].replace(Regex("[\\s-]"), "")
            val msg = waMatch.groupValues[2].trim().ifEmpty { "Hello from Zoni Assistant" }
            return AssistantAction(ActionType.WHATSAPP, target = number, payload = msg, label = "WhatsApp to ${number.ifEmpty { "Contact" }}")
        }

        // 3. SMS Intent
        val smsMatch = Regex(
            "(?:এসএমএস|sms|message)\\s*(?:পাঠাও|send|karo)?\\s*([+0-9\\s-]{6,16})\\s*(?:text)?\\s*(.*)",
            RegexOption.IGNORE_CASE
        ).find(asciiDigits)
        if (smsMatch != null) {
            val number = smsMatch.groupValues[1].replace(Regex("[\\s-]"), "")
            val msg = smsMatch.groupValues[2].trim().ifEmpty { "Hello" }
            return AssistantAction(ActionType.SMS, target = number, payload = msg, label = "SMS to $number")
        }

        // 4. Flashlight / Torch Intent
        if (isFlashlightOnCommand(text)) {
            return AssistantAction(ActionType.FLASHLIGHT, target = "on", payload = "on", label = "Turn ON Flashlight")
        }
        if (isFlashlightOffCommand(text)) {
            return AssistantAction(ActionType.FLASHLIGHT, target = "off", payload = "off", label = "Turn OFF Flashlight")
        }

        // 5. Vibration Intent
        if (Regex("(?:ভাইব্রেশন|vibrate|ভাইব্রেট)", RegexOption.IGNORE_CASE).containsMatchIn(lower)) {
            return AssistantAction(ActionType.VIBRATE, label = "Mobile Haptic Vibration")
        }

        // 6. Battery Intent
        if (Regex("(?:ব্যাটারি|battery|চার্জ|charge)\\s*(?:কত|check|level)?", RegexOption.IGNORE_CASE).containsMatchIn(lower)) {
            return AssistantAction(ActionType.BATTERY, label = "Check Battery Level")
        }

        // 7. System Settings Intents
        if (lower.contains("wifi settings") || lower.contains("wi-fi settings") || lower.contains("ওয়াইফাই সেটিংস")) {
            return AssistantAction(ActionType.SETTINGS, target = "wifi", label = "Open Wi-Fi Settings")
        }
        if (lower.contains("bluetooth settings") || lower.contains("ব্লুটুথ সেটিংস")) {
            return AssistantAction(ActionType.SETTINGS, target = "bluetooth", label = "Open Bluetooth Settings")
        }
        if (lower.contains("open settings") || lower.contains("phone settings") || lower.contains("সেটিংস খোলো") || lower.contains("সেটিংস ওপেন করো")) {
            return AssistantAction(ActionType.SETTINGS, target = "main", label = "Open Settings")
        }

        // 8. Android Accessibility Navigation Intents
        if (lower == "go home" || lower == "হোম স্ক্রিনে যাও") {
            return AssistantAction(ActionType.ACCESSIBILITY, target = "home", label = "Go Home")
        }
        if (lower == "go back" || lower == "পেছনে যাও") {
            return AssistantAction(ActionType.ACCESSIBILITY, target = "back", label = "Go Back")
        }

        // 9. App Launch Intent
        val openAppMatch = Regex("(?:open|launch|start)\\s+([a-z0-9\\s]+)", RegexOption.IGNORE_CASE).find(lower)
            ?: Regex("([a-z0-9\\s\\u0980-\\u09FF]+?)\\s*(?:ওপেন\\s*করো|খোলো|চালু\\s*করো)", RegexOption.IGNORE_CASE).find(lower)
        if (openAppMatch != null) {
            val candidate = openAppMatch.groupValues[1].trim()
            val excluded = listOf("settings", "সেটিংস", "flashlight", "লাইট", "টর্চ")
            if (candidate.isNotEmpty() && excluded.none { candidate.contains(it) }) {
                return AssistantAction(ActionType.APP, target = candidate, label = "Open $candidate")
            }
        }

        return null
    }

    fun detectLanguageSwitchCommand(text: String, affectionName: String = "Boss"): LanguageSwitchResult? {
        val clean = text.trim().lowercase()
        val name = affectionName.trim().ifEmpty { "Boss" }

        val bengaliMatch = listOf(
            Regex("(?:বাংলায়|বাংলায়|বাংলা\\s*ভাষায়|বাংলা)\\s*(?:কথা\\s*বলো|কথা\\s*বলুন|বলো|বলুন)"),
            Regex("bangla[yi]?\\s*kotha\\s*bolo", RegexOption.IGNORE_CASE),
            Regex("(?:speak|talk)\\s*(?:in\\s*)?bengali", RegexOption.IGNORE_CASE),
            Regex("(?:switch|change\\s*(?:language\\s*)?)\\s*(?:to\\s*)?bengali", RegexOption.IGNORE_CASE)
        ).any { it.containsMatchIn(clean) }
        if (bengaliMatch) {
            return LanguageSwitchResult(
                lang = SupportedLanguage.BENGALI,
                label = "ভাষা পরিবর্তন: বাংলা (bn-BD)",
                confirmation = "ঠিক আছে $name! এখন থেকে আমি আপনার সাথে সবসময় মিষ্টি বাংলায় কথা বলব। বলুন $name, কেমন আছেন? ❤️"
            )
        }

        val hindiMatch = listOf(
            Regex("(?:হিন্দিতে|হিন্দি\\s*তে|হিন্দি\\s*ভাষায়|হিন্দি)\\s*(?:কথা\\s*বলো|কথা\\s*বলুন|বলো|বলুন)"),
            Regex("(?:हिंदी|हिन्दी)\\s*(?:में)?\\s*(?:बात\\s*करो|बात\\s*कीजिए|बोलो)"),
            Regex("hindi\\s*(?:me|mein)\\s*(?:baat\\s*karo|bolo)", RegexOption.IGNORE_CASE),
            Regex("hindite\\s*kotha\\s*bolo", RegexOption.IGNORE_CASE),
            Regex("(?:speak|talk|switch\\s*to|change\\s*(?:language\\s*)?to)\\s*(?:in\\s*)?hindi", RegexOption.IGNORE_CASE)
        ).any { it.containsMatchIn(clean) }
        if (hindiMatch) {
            return LanguageSwitchResult(
                lang = SupportedLanguage.HINDI,
                label = "ভাষা পরিবর্তন: হিন্দি (hi-IN)",
                confirmation = "Theek hai mere $name! Ab se main aapke saath Hindi mein baat karungi. Boliye $name, main aapke liye kya kar sakti hoon? ❤️"
            )
        }

        val englishMatch = listOf(
            Regex("(?:ইংরেজিতে|ইংরেজি\\s*তে|ইংরেজি\\s*ভাষায়|ইংরেজি)\\s*(?:কথা\\s*বলো|কথা\\s*বলুন|বলো|বলুন)"),
            Regex("ingrijite\\s*kotha\\s*bolo", RegexOption.IGNORE_CASE),
            Regex("english\\s*(?:me|mein)\\s*(?:baat\\s*karo|bolo)", RegexOption.IGNORE_CASE),
            Regex("(?:speak|talk|switch\\s*to|change\\s*(?:language\\s*)?to)\\s*(?:in\\s*)?english", RegexOption.IGNORE_CASE)
        ).any { it.containsMatchIn(clean) }
        if (englishMatch) {
            return LanguageSwitchResult(
                lang = SupportedLanguage.ENGLISH,
                label = "Language Switched: English (en-US)",
                confirmation = "Understood, $name! I'll speak with you in English from now on. How are you feeling today, $name? ❤️"
            )
        }

        return null
    }

    fun extractActionTagFromText(rawText: String): Pair<String, AssistantAction?> {
        val tagRegex = Regex("\\[ACTION:([A-Z]+)(?::([^:\\]]+))?(?::([^\\]]+))?\\]")
        val match = tagRegex.find(rawText)
        val action = match?.let {
            val typeStr = it.groupValues[1].uppercase()
            val target = it.groupValues[2]
            val payload = it.groupValues[3]
            val actionType = when (typeStr) {
                "CALL" -> ActionType.CALL
                "WHATSAPP" -> ActionType.WHATSAPP
                "SMS" -> ActionType.SMS
                "FLASHLIGHT" -> ActionType.FLASHLIGHT
                "VIBRATE" -> ActionType.VIBRATE
                "BATTERY" -> ActionType.BATTERY
                "APP", "OPEN" -> ActionType.APP
                "SETTINGS" -> ActionType.SETTINGS
                else -> null
            }
            actionType?.let { t ->
                AssistantAction(
                    type = t,
                    target = target,
                    payload = payload.ifEmpty { target.lowercase() },
                    label = "$typeStr $target".trim()
                )
            }
        }
        val cleanText = rawText.replace(Regex("\\[ACTION:[^\\]]+\\]"), "").trim()
        return cleanText to action
    }

    fun mergeTranscriptChunk(existingText: String, incomingChunk: String): String {
        val existing = existingText.trim()
        val incoming = incomingChunk.trim()
        if (incoming.isEmpty()) return existing
        if (existing.isEmpty()) return incoming
        if (existing == incoming || existing.endsWith(incoming)) return existing
        if (incoming.startsWith(existing)) return incoming
        val needsSpace = !Regex("^[.,!?;:।]").containsMatchIn(incoming)
        return "$existing${if (needsSpace) " " else ""}$incoming"
    }

    fun getReconnectDelayMs(attempt: Int, baseMs: Long = 1500L, maxMs: Long = 15000L): Long {
        val safeAttempt = attempt.coerceIn(0, 10)
        val delay = (baseMs * 1.6.pow(safeAttempt.toDouble())).roundToLong()
        return min(maxMs, delay)
    }
}
