package com.zoni.jarvis.assistant.service

/**
 * Pure, deterministic security & privacy guard for Zoni AI Accessibility and Notification services.
 *
 * Enforces non-negotiable safety boundaries:
 * 1. Never read, tap, or modify password fields.
 * 2. Never capture OTPs, PINs, CVVs, or authentication secrets.
 * 3. Never silently interact with banking, UPI, payment, or password-manager screens.
 * 4. Only execute explicitly user-requested actions on non-sensitive screens.
 */
object AccessibilityGuard {

    private val PROTECTED_PACKAGE_PREFIXES = listOf(
        // UPI, payments & wallets (India & Bangladesh & Global)
        "com.google.android.apps.nbu.paisa.user", // Google Pay
        "com.phonepe.app",
        "net.one97.paytm",
        "in.org.npci.upiapp", // BHIM
        "com.amazon.mShop.android.shopping.payments",
        "com.whatsapp.payments",
        "com.bkash.customerapp",
        "com.konasl.nagad",
        "com.dbbl.nexus.pay",
        "com.rocket.dbbl",
        "com.upay.customer",
        "com.paypal.android",
        "com.venmo",
        "com.squareup.cash",
        "com.stripe.",
        // Major Banks
        "com.sbi.",
        "com.csam.icici.",
        "com.snapwork.hdfc",
        "com.axis.mobile",
        "com.msf.kbank.mobile", // Kotak
        "com.infrasofttech.indianbank",
        "com.bankofbaroda.",
        "com.pnb.",
        "com.chase.",
        "com.wf.wellsfargomobile",
        "com.infonow.bofa",
        "com.citi.",
        "com.hsbc.",
        "com.bracbank.",
        "com.citybank.",
        "com.islamibank.",
        // Password managers & authenticators
        "com.agilebits.onepassword",
        "com.x8bit.bitwarden",
        "com.lastpass.lpandroid",
        "com.dashlane",
        "keepass2android.",
        "com.google.android.apps.authenticator2",
        "com.azure.authenticator",
        "com.authy.authy",
        // System security / credentials / lockscreen
        "com.android.keychain",
        "com.google.android.gms.auth",
        "com.samsung.android.authfw",
        "com.samsung.android.spay"
    )

    private val PROTECTED_PACKAGE_KEYWORDS = listOf(
        "bank",
        "banking",
        "upi",
        "wallet",
        "payment",
        "paytm",
        "phonepe",
        "bkash",
        "nagad",
        "authenticator",
        "password",
        "keychain",
        "biometric",
        "lockscreen"
    )

    private val SENSITIVE_SCREEN_KEYWORDS = listOf(
        "enter upi pin",
        "upi pin",
        "confirm payment",
        "pay now",
        "proceed to pay",
        "complete payment",
        "enter mpin",
        "enter tpin",
        "enter atm pin",
        "cvv",
        "card number",
        "expiry date",
        "netbanking",
        "two-factor",
        "2-step verification",
        "biometric prompt",
        "fingerprint authentication",
        "enter your password",
        "create password",
        "reset password",
        "confirm password",
        "পাসওয়ার্ড দিন",
        "পিন কোড দিন",
        "পেমেন্ট নিশ্চিত করুন",
        "ओटीपी दर्ज करें",
        "यूपीआई पिन",
        "पासवर्ड दर्ज करें"
    )

    private val OTP_OR_SECRET_PATTERNS = listOf(
        Regex("\\b(?:otp|one[-\\s]?time[-\\s]?password|verification\\s+code|security\\s+code|auth\\s+code|login\\s+code|passcode|mpin|upi\\s+pin|cvv|tpin)\\b", RegexOption.IGNORE_CASE),
        Regex("(?:ওটিপি|ভেরিফিকেশন\\s*কোড|পিন\\s*কোড|পাসওয়ার্ড|সিকিউরিটি\\s*কোড)"),
        Regex("(?:ओटीपी|वेरिफिकेशन\\s*कोड|पिन\\s*कोड|पासवर्ड)")
    )

    private val DIGIT_OTP_REGEX = Regex("\\b\\d{4,8}\\b")

    /**
     * Returns true if the active foreground package belongs to a banking, payment,
     * wallet, password manager, or system authentication surface.
     */
    fun isProtectedPackage(packageName: String?): Boolean {
        val pkg = packageName?.trim()?.lowercase().orEmpty()
        if (pkg.isEmpty()) return false
        if (PROTECTED_PACKAGE_PREFIXES.any { pkg == it || pkg.startsWith(it) }) {
            return true
        }
        return PROTECTED_PACKAGE_KEYWORDS.any { kw ->
            pkg.contains(".$kw") || pkg.contains("${kw}.") || pkg.endsWith(kw)
        }
    }

    /**
     * Returns true if visible text on screen or inside a notification indicates a
     * payment confirmation, password prompt, or authentication challenge.
     */
    fun isSensitiveScreenContent(visibleLabels: List<String>): Boolean {
        if (visibleLabels.isEmpty()) return false
        val joined = visibleLabels.joinToString(" ").lowercase()
        return SENSITIVE_SCREEN_KEYWORDS.any { joined.contains(it) }
    }

    /**
     * Returns true if a single label, field hint, or notification contains OTP/secret indicators.
     */
    fun containsOtpOrSecret(text: String?): Boolean {
        val clean = text?.trim().orEmpty()
        if (clean.isEmpty()) return false
        return OTP_OR_SECRET_PATTERNS.any { it.containsMatchIn(clean) }
    }

    /**
     * Returns true if an editable field hint/label looks like a password, PIN, CVV, or OTP input.
     */
    fun isSensitiveInputHint(hintOrLabel: String?): Boolean {
        val lower = hintOrLabel?.trim()?.lowercase().orEmpty()
        if (lower.isEmpty()) return false
        val blockedHints = listOf(
            "password", "passcode", "pin", "otp", "cvv", "cvc",
            "secret", "security code", "verification code", "card number",
            "পাসওয়ার্ড", "পিন", "ওটিপি", "पासवर्ड", "पिन", "ओटीपी"
        )
        return blockedHints.any { lower.contains(it) }
    }

    /**
     * Redacts OTP-like numeric codes from text when an OTP indicator is present so
     * private authentication secrets are never echoed or forwarded.
     */
    fun redactSensitiveText(text: String): String {
        if (text.isBlank()) return ""
        return if (containsOtpOrSecret(text)) {
            DIGIT_OTP_REGEX.replace(text, "[REDACTED]")
        } else {
            text
        }
    }
}
