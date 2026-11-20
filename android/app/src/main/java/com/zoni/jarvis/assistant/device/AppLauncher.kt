package com.zoni.jarvis.assistant.device

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager

sealed class AppLaunchResult {
    data class Success(val appLabel: String, val packageName: String) : AppLaunchResult()
    data class AppNotFound(val query: String) : AppLaunchResult()
    data class MultipleMatches(val query: String, val matches: List<Pair<String, String>>) : AppLaunchResult()
    data class LaunchFailed(val appLabel: String, val reason: String) : AppLaunchResult()
}

class AppLauncher(private val context: Context) {

    private val packageManager: PackageManager = context.packageManager

    private val LOCALIZED_APP_NAME_MAP = mapOf(
        // Bengali aliases
        "ইউটিউব" to "YouTube",
        "হোয়াটসঅ্যাপ" to "WhatsApp",
        "হোয়াটসঅ্যাপ" to "WhatsApp",
        "ক্রোম" to "Chrome",
        "ক্যামেরা" to "Camera",
        "ক্যালকুলেটর" to "Calculator",
        "ক্যালেন্ডার" to "Calendar",
        "গ্যালারি" to "Gallery",
        "ম্যাপস" to "Maps",
        "ম্যাপ" to "Maps",
        "জিমেইল" to "Gmail",
        "প্লে স্টোর" to "Play Store",
        "ফেসবুক" to "Facebook",
        "ঘড়ি" to "Clock",
        "ঘড়ি" to "Clock",
        "মেসেজ" to "Messages",
        "সেটিংস" to "Settings",
        // Hindi aliases
        "यूट्यूब" to "YouTube",
        "व्हाट्सएप" to "WhatsApp",
        "व्हाट्सऐप" to "WhatsApp",
        "क्रोम" to "Chrome",
        "कैमरा" to "Camera",
        "कैलकुलेटर" to "Calculator",
        "कैलेंडर" to "Calendar",
        "गैलरी" to "Gallery",
        "मैप्स" to "Maps",
        "जीमेल" to "Gmail",
        "प्ले स्टोर" to "Play Store",
        "फेसबुक" to "Facebook",
        "इंस्टाग्राम" to "Instagram",
        "सेटिंग्स" to "Settings"
    )

    fun launchAppByVoiceQuery(query: String): AppLaunchResult {
        val trimmed = query.trim()
        if (trimmed.isBlank()) {
            return AppLaunchResult.AppNotFound(trimmed)
        }

        // Translate Bengali/Hindi query if mapped
        val resolvedName = LOCALIZED_APP_NAME_MAP[trimmed.lowercase()] ?: trimmed

        // Query all installed launcher activities
        val mainIntent = Intent(Intent.ACTION_MAIN, null).apply {
            addCategory(Intent.CATEGORY_LAUNCHER)
        }

        val resolveInfos = packageManager.queryIntentActivities(mainIntent, 0)
        val matchedApps = mutableListOf<Pair<String, String>>() // Label to PackageName

        for (info in resolveInfos) {
            val label = info.loadLabel(packageManager).toString()
            val packageName = info.activityInfo.packageName

            if (label.equals(resolvedName, ignoreCase = true) ||
                packageName.contains(resolvedName, ignoreCase = true)
            ) {
                matchedApps.add(Pair(label, packageName))
            } else if (label.contains(resolvedName, ignoreCase = true)) {
                matchedApps.add(Pair(label, packageName))
            }
        }

        if (matchedApps.isEmpty()) {
            return AppLaunchResult.AppNotFound(trimmed)
        }

        if (matchedApps.size == 1) {
            val (label, pkg) = matchedApps[0]
            return executeLaunch(label, pkg)
        }

        // If multiple matches, check for exact match
        val exact = matchedApps.find { it.first.equals(resolvedName, ignoreCase = true) }
        if (exact != null) {
            return executeLaunch(exact.first, exact.second)
        }

        return AppLaunchResult.MultipleMatches(trimmed, matchedApps)
    }

    fun launchAppAsJson(query: String): String {
        return when (val result = launchAppByVoiceQuery(query)) {
            is AppLaunchResult.Success -> org.json.JSONObject()
                .put("status", "success")
                .put("appLabel", result.appLabel)
                .put("packageName", result.packageName)
                .put("message", "Opened ${result.appLabel}.")
                .toString()
            is AppLaunchResult.AppNotFound -> org.json.JSONObject()
                .put("status", "not_found")
                .put("query", result.query)
                .put("message", "Could not find an installed app matching \"${result.query}\".")
                .toString()
            is AppLaunchResult.MultipleMatches -> {
                val candidates = org.json.JSONArray()
                result.matches.take(6).forEach { (label, pkg) ->
                    candidates.put(
                        org.json.JSONObject()
                            .put("label", label)
                            .put("packageName", pkg)
                    )
                }
                org.json.JSONObject()
                    .put("status", "multiple_matches")
                    .put("query", result.query)
                    .put("candidates", candidates)
                    .put("message", "Multiple apps match \"${result.query}\". Please specify which one to open.")
                    .toString()
            }
            is AppLaunchResult.LaunchFailed -> org.json.JSONObject()
                .put("status", "failed")
                .put("appLabel", result.appLabel)
                .put("message", result.reason)
                .toString()
        }
    }

    private fun executeLaunch(label: String, packageName: String): AppLaunchResult {
        val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
            ?: return AppLaunchResult.LaunchFailed(label, "Application has no launchable intent.")

        launchIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return try {
            context.startActivity(launchIntent)
            AppLaunchResult.Success(label, packageName)
        } catch (e: Exception) {
            AppLaunchResult.LaunchFailed(label, e.message ?: "Failed to start activity.")
        }
    }
}
