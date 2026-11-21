package com.zoni.jarvis.assistant.device

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.max
import kotlin.math.min

data class InstalledAppInfo(
    val label: String,
    val packageName: String
)

sealed class AppLaunchResult {
    data class Success(val appLabel: String, val packageName: String) : AppLaunchResult()
    data class MultipleMatches(val query: String, val candidates: List<InstalledAppInfo>) : AppLaunchResult()
    data class AppNotFound(val query: String, val visibilityRestricted: Boolean = false) : AppLaunchResult()
    data class LaunchFailed(val reason: String, val failureCode: String = "start_activity_failed") : AppLaunchResult()
}

/**
 * Pure, unit-testable multilingual (Bengali, English, Hindi) app resolver with alias mapping,
 * substring matching, and Levenshtein fuzzy matching.
 */
object AppNameResolver {

    val LOCALIZED_APP_ALIASES: Map<String, List<String>> = mapOf(
        // YouTube
        "ইউটিউব" to listOf("youtube"),
        "यूट्यूब" to listOf("youtube"),
        "yt" to listOf("youtube"),
        // WhatsApp
        "হোয়াটসঅ্যাপ" to listOf("whatsapp"),
        "হোয়াটসঅ্যাপ" to listOf("whatsapp"),
        "ওয়াটসঅ্যাপ" to listOf("whatsapp"),
        "ওয়াতসঅ্যাপ" to listOf("whatsapp"),
        "व्हाट्सएप" to listOf("whatsapp"),
        "व्हाट्सऐप" to listOf("whatsapp"),
        "whats app" to listOf("whatsapp"),
        "whatsapp business" to listOf("whatsapp business", "com.whatsapp.w4b"),
        // Chrome
        "ক্রোম" to listOf("chrome", "google chrome"),
        "क्रोम" to listOf("chrome", "google chrome"),
        "browser" to listOf("chrome", "browser"),
        "ব্রাউজার" to listOf("chrome", "browser"),
        // Instagram
        "ইনস্টাগ্রাম" to listOf("instagram"),
        "ইন্সটাগ্রাম" to listOf("instagram"),
        "इंस्टाग्राम" to listOf("instagram"),
        "insta" to listOf("instagram"),
        // Facebook
        "ফেসবুক" to listOf("facebook"),
        "फेसबुक" to listOf("facebook"),
        "fb" to listOf("facebook"),
        // Maps
        "ম্যাপস" to listOf("maps", "google maps"),
        "ম্যাপ" to listOf("maps", "google maps"),
        "গুগল ম্যাপ" to listOf("maps", "google maps"),
        "গুগল ম্যাপস" to listOf("maps", "google maps"),
        "मैप्स" to listOf("maps", "google maps"),
        "गूगल मैप्स" to listOf("maps", "google maps"),
        // Settings
        "সেটিংস" to listOf("settings"),
        "ফোনের সেটিংস" to listOf("settings"),
        "सेटिंग्स" to listOf("settings"),
        "फोन की सेटिंग्स" to listOf("settings"),
        // Calculator
        "ক্যালকুলেটর" to listOf("calculator"),
        "ক্যালকুলেটার" to listOf("calculator"),
        "कैलकुलेटर" to listOf("calculator"),
        "calc" to listOf("calculator"),
        // Camera
        "ক্যামেরা" to listOf("camera"),
        "कैमरा" to listOf("camera"),
        // Gallery / Photos
        "গ্যালারি" to listOf("gallery", "photos"),
        "ফটো" to listOf("photos", "gallery"),
        "गैलरी" to listOf("gallery", "photos"),
        // Gmail / Mail
        "জিমেইল" to listOf("gmail"),
        "जीमेल" to listOf("gmail"),
        "ইমেইল" to listOf("gmail", "email"),
        // Messages
        "মেসেজ" to listOf("messages", "messaging"),
        "মেসেজেস" to listOf("messages", "messaging"),
        "मैसेज" to listOf("messages", "messaging"),
        // Phone / Dialer / Contacts
        "ডায়ালার" to listOf("phone", "dialer"),
        "ফোন" to listOf("phone", "dialer"),
        "কন্টাক্টস" to listOf("contacts"),
        "কন্টাক্ট" to listOf("contacts"),
        "कॉन्टैक्ट्स" to listOf("contacts"),
        // Clock / Alarm
        "ঘড়ি" to listOf("clock"),
        "ক্লক" to listOf("clock"),
        "अलार्म" to listOf("clock"),
        "घड़ी" to listOf("clock"),
        // Telegram & Spotify
        "টেলিগ্রাম" to listOf("telegram"),
        "टेलीग्राम" to listOf("telegram"),
        "স্পটিফাই" to listOf("spotify"),
        "स्पॉटिफाई" to listOf("spotify"),
        // Play Store & Calendar
        "প্লে স্টোর" to listOf("play store", "google play store"),
        "प्ले स्टोर" to listOf("play store", "google play store"),
        "ক্যালেন্ডার" to listOf("calendar"),
        "कैलेंडर" to listOf("calendar")
    )

    val KNOWN_DECLARED_PACKAGES: Map<String, List<String>> = mapOf(
        "whatsapp" to listOf("com.whatsapp", "com.whatsapp.w4b"),
        "youtube" to listOf("com.google.android.youtube"),
        "chrome" to listOf("com.android.chrome"),
        "instagram" to listOf("com.instagram.android"),
        "facebook" to listOf("com.facebook.katana"),
        "messenger" to listOf("com.facebook.orca"),
        "telegram" to listOf("org.telegram.messenger"),
        "spotify" to listOf("com.spotify.music"),
        "maps" to listOf("com.google.android.apps.maps"),
        "gmail" to listOf("com.google.android.gm"),
        "calculator" to listOf("com.google.android.calculator", "com.android.calculator2"),
        "settings" to listOf("com.android.settings")
    )

    fun expandQueryVariants(rawQuery: String): List<String> {
        var cleaned = rawQuery.trim()
            .replace(Regex("[.,?!।]"), "")
            .replace(Regex("^(?:আমার\\s+ফোনে\\s+থাকা|ফোনে\\s+থাকা|আমার|প্লিজ|please|my|the)\\s+", RegexOption.IGNORE_CASE), "")
            .replace(Regex("\\s+(?:app|অ্যাপটা|অ্যাপটি|অ্যাপ|for\\s+me)$", RegexOption.IGNORE_CASE), "")
            .replace(Regex("\\s+"), " ")
            .lowercase()
        if ((cleaned.endsWith("টা") || cleaned.endsWith("টি")) && cleaned.length > 3) {
            cleaned = cleaned.dropLast(2).trim()
        }
        if (cleaned.isEmpty()) return emptyList()

        val variants = LinkedHashSet<String>()
        variants.add(cleaned)
        LOCALIZED_APP_ALIASES[cleaned]?.forEach { variants.add(it) }
        for ((alias, targets) in LOCALIZED_APP_ALIASES) {
            if (cleaned.contains(alias)) {
                targets.forEach { variants.add(it) }
            }
        }
        return variants.toList()
    }

    fun resolveMatchingApps(rawQuery: String, installedApps: List<InstalledAppInfo>): AppLaunchResult {
        val query = rawQuery.trim()
        if (query.isEmpty()) {
            return AppLaunchResult.AppNotFound(query)
        }
        val variants = expandQueryVariants(query)
        if (variants.isEmpty()) {
            return AppLaunchResult.AppNotFound(query)
        }

        // 1. Exact label or exact packageName match
        val exactMatches = installedApps.filter { app ->
            val labelLower = app.label.trim().lowercase()
            val pkgLower = app.packageName.trim().lowercase()
            variants.any { v -> labelLower == v || pkgLower == v }
        }
        if (exactMatches.size == 1) {
            return AppLaunchResult.Success(exactMatches[0].label, exactMatches[0].packageName)
        }
        if (exactMatches.size > 1) {
            return AppLaunchResult.MultipleMatches(query, exactMatches.take(5))
        }

        // 2. Prefix match (e.g., "WhatsApp" matches "WhatsApp" & "WhatsApp Business")
        val prefixMatches = installedApps.filter { app ->
            val labelLower = app.label.trim().lowercase()
            variants.any { v -> labelLower.startsWith(v) }
        }
        if (prefixMatches.size == 1) {
            return AppLaunchResult.Success(prefixMatches[0].label, prefixMatches[0].packageName)
        }
        if (prefixMatches.size > 1) {
            return AppLaunchResult.MultipleMatches(query, prefixMatches.take(5))
        }

        // 3. Substring match on label or package tail
        val partialMatches = installedApps.filter { app ->
            val labelLower = app.label.trim().lowercase()
            val pkgLower = app.packageName.trim().lowercase()
            variants.any { v ->
                v.length >= 2 && (labelLower.contains(v) || pkgLower.substringAfterLast('.').contains(v))
            }
        }
        if (partialMatches.size == 1) {
            return AppLaunchResult.Success(partialMatches[0].label, partialMatches[0].packageName)
        }
        if (partialMatches.size > 1) {
            return AppLaunchResult.MultipleMatches(query, partialMatches.take(5))
        }

        // 4. Fuzzy Levenshtein similarity match (handles minor voice transcription typos)
        val fuzzyScored = installedApps.mapNotNull { app ->
            val labelLower = app.label.trim().lowercase()
            val bestScore = variants.maxOfOrNull { v -> similarityScore(v, labelLower) } ?: 0.0
            if (bestScore >= 0.72) Pair(app, bestScore) else null
        }.sortedByDescending { it.second }

        if (fuzzyScored.size == 1) {
            val winner = fuzzyScored[0].first
            return AppLaunchResult.Success(winner.label, winner.packageName)
        }
        if (fuzzyScored.size > 1) {
            // If top match is significantly clearer than second, choose it; otherwise disambiguate
            if (fuzzyScored[0].second - fuzzyScored[1].second >= 0.12) {
                val winner = fuzzyScored[0].first
                return AppLaunchResult.Success(winner.label, winner.packageName)
            }
            return AppLaunchResult.MultipleMatches(query, fuzzyScored.take(5).map { it.first })
        }

        return AppLaunchResult.AppNotFound(query)
    }

    fun similarityScore(a: String, b: String): Double {
        if (a.isEmpty() || b.isEmpty()) return 0.0
        if (a == b) return 1.0
        val dist = levenshteinDistance(a, b)
        val maxLen = max(a.length, b.length)
        return 1.0 - (dist.toDouble() / maxLen.toDouble())
    }

    private fun levenshteinDistance(a: String, b: String): Int {
        val m = a.length
        val n = b.length
        val prev = IntArray(n + 1) { it }
        val curr = IntArray(n + 1)
        for (i in 1..m) {
            curr[0] = i
            for (j in 1..n) {
                val cost = if (a[i - 1] == b[j - 1]) 0 else 1
                curr[j] = min(min(curr[j - 1] + 1, prev[j] + 1), prev[j - 1] + cost)
            }
            System.arraycopy(curr, 0, prev, 0, n + 1)
        }
        return prev[n]
    }
}

class AppLauncher(private val context: Context) {

    /**
     * Discovers all installed launchable Android apps using PackageManager
     * (`ACTION_MAIN` + `CATEGORY_LAUNCHER`), without requiring QUERY_ALL_PACKAGES.
     */
    fun listInstalledApps(): List<InstalledAppInfo> {
        val pm = context.packageManager
        val mainIntent = Intent(Intent.ACTION_MAIN, null).apply {
            addCategory(Intent.CATEGORY_LAUNCHER)
        }
        val resolvedInfos = try {
            pm.queryIntentActivities(mainIntent, 0)
        } catch (_: Exception) {
            emptyList()
        }

        val deduped = LinkedHashMap<String, InstalledAppInfo>()
        for (info in resolvedInfos) {
            val pkg = info.activityInfo?.packageName?.trim().orEmpty()
            if (pkg.isEmpty() || pkg == context.packageName) continue
            val label = info.loadLabel(pm)?.toString()?.trim().orEmpty().ifEmpty { pkg }
            if (!deduped.containsKey(pkg)) {
                deduped[pkg] = InstalledAppInfo(label = label, packageName = pkg)
            }
        }
        return deduped.values.sortedBy { it.label.lowercase() }
    }

    fun listInstalledAppsAsJson(limit: Int = 150): String {
        val apps = listInstalledApps()
        val arr = JSONArray()
        apps.take(limit.coerceIn(1, 300)).forEach { app ->
            arr.put(
                JSONObject()
                    .put("label", app.label)
                    .put("packageName", app.packageName)
            )
        }
        return JSONObject()
            .put("success", true)
            .put("count", apps.size)
            .put("apps", arr)
            .toString()
    }

    fun launchAppByVoiceQuery(rawQuery: String): AppLaunchResult {
        val query = rawQuery.trim()
        if (query.isEmpty()) {
            return AppLaunchResult.AppNotFound(query)
        }

        val installedApps = listInstalledApps()
        Log.d(TAG, "launchAppByVoiceQuery: query='$query', discoveredApps=${installedApps.size}")
        val resolved = AppNameResolver.resolveMatchingApps(query, installedApps)

        return when (resolved) {
            is AppLaunchResult.Success -> launchPackage(resolved.packageName, resolved.appLabel)
            is AppLaunchResult.MultipleMatches -> {
                Log.w(TAG, "launchAppByVoiceQuery: multiple matches (${resolved.candidates.size}) for '$query'")
                resolved
            }
            is AppLaunchResult.AppNotFound -> {
                // Direct lookup fallback for explicitly declared <queries> packages on Android 11+
                val variants = AppNameResolver.expandQueryVariants(query)
                for (variant in variants) {
                    val candidatePkgs = AppNameResolver.KNOWN_DECLARED_PACKAGES[variant].orEmpty()
                    for (pkg in candidatePkgs) {
                        val intent = try {
                            context.packageManager.getLaunchIntentForPackage(pkg)
                        } catch (_: Exception) {
                            null
                        }
                        if (intent != null) {
                            Log.d(TAG, "launchAppByVoiceQuery: resolved declared package '$pkg' for '$query'")
                            return launchPackage(pkg, variant.replaceFirstChar { it.uppercase() })
                        }
                    }
                }
                val visibilityRestricted = installedApps.isEmpty()
                if (visibilityRestricted) {
                    Log.w(TAG, "launchAppByVoiceQuery: PackageManager returned 0 launchable apps (Android 11+ visibility restriction)")
                }
                AppLaunchResult.AppNotFound(query, visibilityRestricted = visibilityRestricted)
            }
            is AppLaunchResult.LaunchFailed -> resolved
        }
    }

    fun launchAppAsJson(rawQuery: String): String {
        return when (val res = launchAppByVoiceQuery(rawQuery)) {
            is AppLaunchResult.Success -> JSONObject()
                .put("status", "launched")
                .put("success", true)
                .put("verified", true)
                .put("appLabel", res.appLabel)
                .put("packageName", res.packageName)
                .put("message", "Opened ${res.appLabel}.")
                .toString()
            is AppLaunchResult.MultipleMatches -> {
                val arr = JSONArray()
                res.candidates.forEach {
                    arr.put(JSONObject().put("label", it.label).put("packageName", it.packageName))
                }
                JSONObject()
                    .put("status", "multiple_matches")
                    .put("success", false)
                    .put("verified", false)
                    .put("query", res.query)
                    .put("failureReason", "multiple_matches")
                    .put("candidates", arr)
                    .put("message", "Multiple installed apps match \"${res.query}\": ${res.candidates.joinToString(", ") { it.label }}. Which one would you like to open?")
                    .toString()
            }
            is AppLaunchResult.AppNotFound -> JSONObject()
                .put("status", if (res.visibilityRestricted) "package_visibility_restricted" else "not_found")
                .put("success", false)
                .put("verified", false)
                .put("query", res.query)
                .put("failureReason", if (res.visibilityRestricted) "package_visibility_restricted" else "app_not_installed")
                .put(
                    "message",
                    if (res.visibilityRestricted) {
                        "Android package visibility prevented discovering installed apps for \"${res.query}\"."
                    } else {
                        "App \"${res.query}\" is not installed on this device."
                    }
                )
                .toString()
            is AppLaunchResult.LaunchFailed -> JSONObject()
                .put("status", "failed")
                .put("success", false)
                .put("verified", false)
                .put("failureReason", res.failureCode)
                .put("message", res.reason)
                .toString()
        }
    }

    fun launchPackage(packageName: String, appLabel: String): AppLaunchResult {
        val pm: PackageManager = context.packageManager
        val launchIntent = try {
            pm.getLaunchIntentForPackage(packageName)
        } catch (e: Exception) {
            Log.e(TAG, "launchPackage: getLaunchIntentForPackage failed for $packageName: ${e.message}")
            null
        } ?: return AppLaunchResult.LaunchFailed(
            reason = "No launchable launcher activity is available for $appLabel ($packageName).",
            failureCode = "launch_intent_unavailable"
        )
        launchIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return try {
            context.startActivity(launchIntent)
            Log.d(TAG, "launchPackage: startActivity succeeded for $appLabel ($packageName)")
            AppLaunchResult.Success(appLabel, packageName)
        } catch (e: Exception) {
            Log.e(TAG, "launchPackage: startActivity failed for $appLabel ($packageName): ${e.message}")
            AppLaunchResult.LaunchFailed(
                reason = "startActivity failed for $appLabel ($packageName): ${e.message ?: "unknown error"}",
                failureCode = "start_activity_failed"
            )
        }
    }

    companion object {
        private const val TAG = "ZoniAppLauncher"
    }
}
