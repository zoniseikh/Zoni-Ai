package com.zoni.jarvis.assistant.service

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

data class AutoReplyRule(
    val id: String,
    val enabled: Boolean,
    val keyword: String,
    val senderFilter: String = "",
    val replyText: String,
    val whatsappOnly: Boolean = true
)

/**
 * Pure, deterministic rule-based auto-reply engine for incoming notifications.
 *
 * Safety & Transparency:
 * - Master toggle defaults to FALSE (disabled until explicitly enabled by the user).
 * - Only matches when master switch is ON, rule is enabled, and reply text is non-blank.
 * - Executes strictly through Android's official Notification RemoteInput action.
 */
object AutoReplyRuleMatcher {
    fun findMatchingRule(
        rules: List<AutoReplyRule>,
        masterEnabled: Boolean,
        sender: String,
        messageText: String,
        isWhatsApp: Boolean
    ): AutoReplyRule? {
        if (!masterEnabled) return null
        val cleanSender = sender.trim().lowercase()
        val cleanMsg = messageText.trim().lowercase()
        if (cleanMsg.isEmpty()) return null

        for (rule in rules) {
            if (!rule.enabled) continue
            if (rule.replyText.isBlank()) continue
            if (rule.whatsappOnly && !isWhatsApp) continue

            val senderReq = rule.senderFilter.trim().lowercase()
            if (senderReq.isNotEmpty() && !cleanSender.contains(senderReq)) {
                continue
            }

            val keywordReq = rule.keyword.trim().lowercase()
            if (keywordReq.isEmpty() || cleanMsg.contains(keywordReq)) {
                return rule
            }
        }
        return null
    }
}

class AutoReplyRuleManager(context: Context) {

    private val prefs = context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    fun isMasterEnabled(): Boolean = prefs.getBoolean(KEY_MASTER_ENABLED, false)

    fun setMasterEnabled(enabled: Boolean) {
        prefs.edit().putBoolean(KEY_MASTER_ENABLED, enabled).apply()
    }

    fun getRules(): List<AutoReplyRule> {
        val raw = prefs.getString(KEY_RULES_JSON, "[]") ?: "[]"
        return parseRulesJson(raw)
    }

    fun getRulesJson(): String {
        val root = JSONObject()
        root.put("enabled", isMasterEnabled())
        val arr = JSONArray()
        for (rule in getRules()) {
            arr.put(
                JSONObject()
                    .put("id", rule.id)
                    .put("enabled", rule.enabled)
                    .put("keyword", rule.keyword)
                    .put("senderFilter", rule.senderFilter)
                    .put("replyText", rule.replyText)
                    .put("whatsappOnly", rule.whatsappOnly)
            )
        }
        root.put("rules", arr)
        return root.toString()
    }

    fun saveRulesJson(rawJson: String): Boolean {
        return try {
            val rules = parseRulesJson(rawJson)
            val arr = JSONArray()
            for (rule in rules) {
                arr.put(
                    JSONObject()
                        .put("id", rule.id)
                        .put("enabled", rule.enabled)
                        .put("keyword", rule.keyword)
                        .put("senderFilter", rule.senderFilter)
                        .put("replyText", rule.replyText)
                        .put("whatsappOnly", rule.whatsappOnly)
                )
            }
            prefs.edit().putString(KEY_RULES_JSON, arr.toString()).apply()
            true
        } catch (_: Exception) {
            false
        }
    }

    fun findMatch(sender: String, messageText: String, isWhatsApp: Boolean): AutoReplyRule? {
        return AutoReplyRuleMatcher.findMatchingRule(
            rules = getRules(),
            masterEnabled = isMasterEnabled(),
            sender = sender,
            messageText = messageText,
            isWhatsApp = isWhatsApp
        )
    }

    companion object {
        private const val PREFS_NAME = "zoni_auto_reply_rules"
        private const val KEY_MASTER_ENABLED = "master_enabled"
        private const val KEY_RULES_JSON = "rules_json"

        fun parseRulesJson(rawJson: String): List<AutoReplyRule> {
            val trimmed = rawJson.trim()
            if (trimmed.isEmpty()) return emptyList()
            val array = if (trimmed.startsWith("{")) {
                JSONObject(trimmed).optJSONArray("rules") ?: JSONArray()
            } else {
                JSONArray(trimmed)
            }
            val result = mutableListOf<AutoReplyRule>()
            for (i in 0 until array.length()) {
                val obj = array.optJSONObject(i) ?: continue
                val replyText = obj.optString("replyText", "").trim()
                if (replyText.isEmpty()) continue
                result.add(
                    AutoReplyRule(
                        id = obj.optString("id", "rule_$i"),
                        enabled = obj.optBoolean("enabled", true),
                        keyword = obj.optString("keyword", "").trim(),
                        senderFilter = obj.optString("senderFilter", "").trim(),
                        replyText = replyText,
                        whatsappOnly = obj.optBoolean("whatsappOnly", true)
                    )
                )
            }
            return result
        }
    }
}
