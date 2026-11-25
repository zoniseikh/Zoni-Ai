package com.zoni.jarvis.assistant.service

import java.text.Normalizer

/**
 * Pure, JVM-testable Smart Accessibility Engines for Zoni AI:
 * 1. [YouTubeClickEngine] — Advanced YouTube video card, thumbnail, search result & Play button resolver + watch-screen verifier.
 * 2. [WhatsAppSmartContactEngine] — Multilingual (Bengali/English/Hindi) visible WhatsApp contact/chat name matcher with strict ambiguity safety.
 * 3. [WhatsAppSendButtonResolver] — Dedicated multi-signal WhatsApp Send button resolver & post-send state verifier (pending/sent/delivered).
 *
 * All core selection, parent-container discovery, bounds validation, disambiguation, and
 * outcome verification algorithms operate on immutable [AccessibleNodeSnapshot] trees so they
 * are 100% deterministic and unit-testable on the JVM without Robolectric or arbitrary screen coordinates.
 */

data class AccessibleRect(
    val left: Int,
    val top: Int,
    val right: Int,
    val bottom: Int
) {
    val width: Int get() = (right - left).coerceAtLeast(0)
    val height: Int get() = (bottom - top).coerceAtLeast(0)
    val centerX: Float get() = (left + right) / 2f
    val centerY: Float get() = (top + bottom) / 2f
    val isValidVisible: Boolean get() = width > 0 && height > 0 && right > 0 && bottom > 0
}

data class AccessibleNodeSnapshot(
    val nodeId: Int,
    val parentId: Int? = null,
    val viewIdResourceName: String? = null,
    val className: String? = null,
    val text: String? = null,
    val contentDescription: String? = null,
    val hintText: String? = null,
    val isClickable: Boolean = false,
    val isEnabled: Boolean = true,
    val isVisibleToUser: Boolean = true,
    val isEditable: Boolean = false,
    val isPassword: Boolean = false,
    val bounds: AccessibleRect = AccessibleRect(0, 0, 0, 0)
) {
    val combinedLabel: String
        get() = listOfNotNull(text?.trim()?.takeIf { it.isNotEmpty() }, contentDescription?.trim()?.takeIf { it.isNotEmpty() })
            .distinct()
            .joinToString(" ")
}

object AccessibilityTreeResolver {

    /**
     * Walks up the parent hierarchy from [startNode] to find the nearest enabled, clickable ancestor.
     * Avoids climbing into full-screen root containers when a tighter clickable container exists.
     */
    fun findNearestClickableNode(
        startNode: AccessibleNodeSnapshot,
        nodesById: Map<Int, AccessibleNodeSnapshot>,
        maxDepth: Int = 8
    ): AccessibleNodeSnapshot? {
        var current: AccessibleNodeSnapshot? = startNode
        var depth = 0
        while (current != null && depth <= maxDepth) {
            if (current.isPassword) return null
            if (current.isClickable && current.isEnabled) {
                return current
            }
            val pid = current.parentId ?: break
            current = nodesById[pid]
            depth++
        }
        return null
    }

    /**
     * Collects all descendant text & contentDescription labels under [containerId] (excluding passwords).
     */
    fun collectDescendantLabels(
        containerId: Int,
        nodes: List<AccessibleNodeSnapshot>
    ): List<String> {
        val childrenByParent = nodes.groupBy { it.parentId }
        val result = mutableListOf<String>()
        val queue = ArrayDeque<Int>()
        queue.add(containerId)
        val visited = HashSet<Int>()
        val byId = nodes.associateBy { it.nodeId }

        while (queue.isNotEmpty() && result.size < 30) {
            val id = queue.removeFirst()
            if (!visited.add(id)) continue
            val node = byId[id] ?: continue
            if (node.isPassword) continue
            val txt = node.text?.trim().orEmpty()
            val desc = node.contentDescription?.trim().orEmpty()
            if (txt.isNotEmpty() && !AccessibilityGuard.containsOtpOrSecret(txt)) result.add(txt)
            if (desc.isNotEmpty() && desc != txt && !AccessibilityGuard.containsOtpOrSecret(desc)) result.add(desc)
            childrenByParent[id]?.forEach { child -> queue.add(child.nodeId) }
        }
        return result
    }
}

// ============================================================================
// PART 1 — ADVANCED YOUTUBE CLICK ENGINE
// ============================================================================

data class YouTubeCandidate(
    val matchNode: AccessibleNodeSnapshot,
    val clickableNode: AccessibleNodeSnapshot?,
    val title: String,
    val bounds: AccessibleRect,
    val isThumbnail: Boolean,
    val isPlayButton: Boolean
)

sealed class YouTubeTargetResolution {
    data class Matched(val candidate: YouTubeCandidate, val rankIndex: Int) : YouTubeTargetResolution()
    data class Ambiguous(val query: String, val candidates: List<YouTubeCandidate>) : YouTubeTargetResolution()
    data class NotFound(val reason: String, val failureCode: String) : YouTubeTargetResolution()
}

data class YouTubeVerificationResult(
    val openedWatchScreen: Boolean,
    val status: String,
    val evidence: String
)

object YouTubeClickEngine {

    private val YOUTUBE_PACKAGES = setOf(
        "com.google.android.youtube",
        "com.google.android.apps.youtube.music",
        "com.google.android.apps.youtube.kids"
    )

    private val CHROME_OR_NAV_LABELS = setOf(
        "home", "shorts", "subscriptions", "you", "library", "explore", "search",
        "search youtube", "cast", "notifications", "account", "navigate up", "back",
        "clear", "voice search", "all", "music", "gaming", "live", "news", "recently uploaded",
        "watched", "new to you", "filters", "more options", "action menu", "subscribe",
        "হোম", "শর্টস", "সাবস্ক্রিপশন", "সার্চ", "খুঁজুন"
    )

    private val PLAY_BUTTON_LABELS = setOf(
        "play", "play video", "play button", "resume", "play now",
        "প্লে", "প্লে বাটন", "চালাও", "चलाएं", "प्ले"
    )

    private val AD_MARKERS = listOf("sponsored", "ad ·", "visit advertiser", "install now", "বিজ্ঞাপন")

    fun isYouTubePackage(packageName: String?): Boolean {
        val clean = packageName?.trim()?.lowercase().orEmpty()
        return clean in YOUTUBE_PACKAGES
    }

    /**
     * Discovers visible YouTube video cards / thumbnails / search result entries sorted top-to-bottom.
     */
    fun collectVideoCandidates(nodes: List<AccessibleNodeSnapshot>): List<YouTubeCandidate> {
        val nodesById = nodes.associateBy { it.nodeId }
        val rawCandidates = mutableListOf<YouTubeCandidate>()

        for (node in nodes) {
            if (node.isPassword || !node.isVisibleToUser || !node.isEnabled) continue
            if (!node.bounds.isValidVisible) continue

            val vid = node.viewIdResourceName?.lowercase().orEmpty()
            val text = node.text?.trim().orEmpty()
            val desc = node.contentDescription?.trim().orEmpty()
            val label = text.ifEmpty { desc }
            val lowerLabel = label.lowercase()

            if (lowerLabel in CHROME_OR_NAV_LABELS) continue
            if (AD_MARKERS.any { lowerLabel.contains(it) }) continue

            val isThumbnailId = vid.contains("thumbnail") ||
                vid.contains("video_thumbnail") ||
                vid.contains("poster") ||
                vid.contains("artwork")
            val isVideoCardId = vid.contains("video_info_view") ||
                vid.contains("compact_video") ||
                vid.contains("video_with_context") ||
                vid.contains("results_item") ||
                vid.endsWith(":id/title") ||
                vid.contains("video_title")
            val looksLikeVideoDesc = desc.length >= 12 && (
                desc.contains("minute", ignoreCase = true) ||
                    desc.contains("second", ignoreCase = true) ||
                    desc.contains("hour", ignoreCase = true) ||
                    desc.contains("views", ignoreCase = true) ||
                    desc.contains("ago", ignoreCase = true) ||
                    desc.contains("ভিডিও", ignoreCase = true) ||
                    desc.contains("মিনিট", ignoreCase = true) ||
                    desc.contains("सेकंड", ignoreCase = true) ||
                    desc.contains("मिनट", ignoreCase = true) ||
                    desc.contains("go to channel", ignoreCase = true) ||
                    desc.contains("play video", ignoreCase = true)
                )
            val looksLikeThumbnailArea = node.bounds.width >= 180 && node.bounds.height >= 100 &&
                (isThumbnailId || isVideoCardId || looksLikeVideoDesc ||
                    (node.isClickable && label.length >= 10 && !node.isEditable))

            if (!isThumbnailId && !isVideoCardId && !looksLikeVideoDesc && !looksLikeThumbnailArea) continue

            val clickable = AccessibilityTreeResolver.findNearestClickableNode(node, nodesById)
            val effectiveBounds = if (node.bounds.isValidVisible) node.bounds else clickable?.bounds ?: node.bounds
            if (!effectiveBounds.isValidVisible) continue

            // Prefer meaningful title text from node or its clickable parent container
            val resolvedTitle = when {
                text.length >= 4 && text.lowercase() !in CHROME_OR_NAV_LABELS -> text
                desc.length >= 4 && desc.lowercase() !in CHROME_OR_NAV_LABELS -> desc
                clickable != null -> {
                    AccessibilityTreeResolver.collectDescendantLabels(clickable.nodeId, nodes)
                        .firstOrNull { it.length >= 4 && it.lowercase() !in CHROME_OR_NAV_LABELS }
                        .orEmpty()
                }
                else -> ""
            }

            if (resolvedTitle.isBlank() && !isThumbnailId) continue

            rawCandidates.add(
                YouTubeCandidate(
                    matchNode = node,
                    clickableNode = clickable,
                    title = resolvedTitle.ifBlank { "YouTube Video" },
                    bounds = effectiveBounds,
                    isThumbnail = isThumbnailId || (node.bounds.width >= 240 && node.bounds.height >= 140),
                    isPlayButton = false
                )
            )
        }

        // Deduplicate nodes belonging to the same clickable video card (preferring thumbnail/title with richer text)
        val groupedByCard = LinkedHashMap<String, YouTubeCandidate>()
        for (cand in rawCandidates.sortedWith(compareBy<YouTubeCandidate> { it.bounds.top }.thenBy { it.bounds.left })) {
            val cardKey = cand.clickableNode?.nodeId?.let { "click_$it" }
                ?: "band_${cand.bounds.top / 120}_${cand.title.take(24).lowercase()}"
            val existing = groupedByCard[cardKey]
            if (existing == null ||
                (cand.title.length > existing.title.length && existing.title == "YouTube Video") ||
                (cand.isThumbnail && !existing.isThumbnail && cand.title.isNotBlank())
            ) {
                groupedByCard[cardKey] = cand
            }
        }

        return groupedByCard.values
            .sortedWith(compareBy<YouTubeCandidate> { it.bounds.top }.thenBy { it.bounds.left })
    }

    private val PAUSE_BUTTON_LABELS = setOf(
        "pause", "pause video", "পজ", "ভিডিও পজ করুন", "বিরতি", "पॉज़", "वीडियो रोकें", "रोकें"
    )

    private val STOP_OR_CLOSE_LABELS = setOf(
        "stop", "stop video", "close", "close player", "minimize", "dismiss",
        "স্টপ", "বন্ধ", "প্লেয়ার বন্ধ", "बंद करें", "स्टॉप"
    )

    /**
     * Finds the visible YouTube video player container so controls can be revealed when auto-hidden.
     */
    fun findPlayerSurface(nodes: List<AccessibleNodeSnapshot>): AccessibleNodeSnapshot? {
        return nodes.firstOrNull { node ->
            !node.isPassword && node.isVisibleToUser && node.bounds.isValidVisible && (
                node.viewIdResourceName?.lowercase()?.let { vid ->
                    vid.contains("watch_player") || vid.contains("player_view") || vid.contains("player_fragment_container")
                } == true ||
                    (node.bounds.top <= 240 && node.bounds.width >= 500 && node.bounds.height >= 260 &&
                        node.contentDescription?.lowercase()?.contains("video player") == true)
                )
        }
    }

    /**
     * Finds an explicit Play button on screen (e.g. "Play Button চাপো" / "Click the Play button").
     */
    fun findPlayButton(nodes: List<AccessibleNodeSnapshot>): YouTubeCandidate? {
        return findPlaybackControl(nodes, "play")
    }

    /**
     * Finds a semantic YouTube Play, Pause, or Stop/Close player control without confusing Play vs Pause state.
     */
    fun findPlaybackControl(nodes: List<AccessibleNodeSnapshot>, controlType: String): YouTubeCandidate? {
        val kind = controlType.trim().lowercase()
        val nodesById = nodes.associateBy { it.nodeId }

        fun buildCandidate(node: AccessibleNodeSnapshot, fallbackTitle: String): YouTubeCandidate? {
            val clickable = AccessibilityTreeResolver.findNearestClickableNode(node, nodesById)
            val rect = if (node.bounds.isValidVisible) node.bounds else clickable?.bounds ?: node.bounds
            if (!rect.isValidVisible && clickable == null) return null
            return YouTubeCandidate(
                matchNode = node,
                clickableNode = clickable,
                title = node.contentDescription?.trim()?.ifEmpty { null }
                    ?: node.text?.trim()?.ifEmpty { null }
                    ?: fallbackTitle,
                bounds = rect,
                isThumbnail = false,
                isPlayButton = true
            )
        }

        if (kind == "stop") {
            // Prefer explicit Stop / Close / Minimize player controls first
            for (node in nodes) {
                if (node.isPassword || !node.isVisibleToUser || !node.isEnabled) continue
                val vid = node.viewIdResourceName?.lowercase().orEmpty()
                val desc = node.contentDescription?.trim()?.lowercase().orEmpty()
                val txt = node.text?.trim()?.lowercase().orEmpty()
                val isStop = desc in STOP_OR_CLOSE_LABELS ||
                    txt in STOP_OR_CLOSE_LABELS ||
                    desc.startsWith("close player") ||
                    desc.startsWith("minimize") ||
                    vid.contains("player_collapse") ||
                    vid.contains("close_button")
                if (isStop) {
                    buildCandidate(node, "Stop")?.let { return it }
                }
            }
            // YouTube mobile player often exposes Pause instead of Stop; fall back to Pause so playback stops cleanly
            return findPlaybackControl(nodes, "pause")
        }

        for (node in nodes) {
            if (node.isPassword || !node.isVisibleToUser || !node.isEnabled) continue
            val vid = node.viewIdResourceName?.lowercase().orEmpty()
            val desc = node.contentDescription?.trim()?.lowercase().orEmpty()
            val txt = node.text?.trim()?.lowercase().orEmpty()

            if (kind == "pause") {
                val isPauseLabel = desc in PAUSE_BUTTON_LABELS ||
                    txt in PAUSE_BUTTON_LABELS ||
                    desc.startsWith("pause video") ||
                    desc == "pause"
                val isPauseToggleId = vid.contains("player_control_play_pause") &&
                    !desc.startsWith("play") && txt != "play"
                if (isPauseLabel || (isPauseToggleId && desc.contains("pause"))) {
                    buildCandidate(node, "Pause")?.let { return it }
                }
            } else {
                // Play / Resume: do NOT tap a control explicitly labeled Pause
                if (desc.startsWith("pause") || txt == "pause") continue
                val isPlayId = vid.contains("player_control_play") ||
                    vid.endsWith(":id/play") ||
                    vid.contains("play_pause") ||
                    vid.contains("play_button")
                val isPlayLabel = desc in PLAY_BUTTON_LABELS ||
                    txt in PLAY_BUTTON_LABELS ||
                    desc.startsWith("play video") ||
                    desc == "play"
                if (isPlayId || isPlayLabel) {
                    buildCandidate(node, "Play")?.let { return it }
                }
            }
        }
        return null
    }

    /**
     * Verifies whether a Play/Pause/Stop playback control click changed player state honestly.
     */
    fun verifyPlaybackControlResult(
        controlType: String,
        afterNodes: List<AccessibleNodeSnapshot>,
        accessibilityEventObserved: Boolean
    ): YouTubeVerificationResult {
        val kind = controlType.trim().lowercase()
        val hasPauseNow = findPlaybackControl(afterNodes, "pause") != null
        val hasPlayNow = findPlaybackControl(afterNodes, "play") != null
        val confirmed = when (kind) {
            "pause" -> hasPlayNow || accessibilityEventObserved
            "play" -> hasPauseNow || accessibilityEventObserved
            "stop" -> hasPlayNow || !hasPauseNow || accessibilityEventObserved
            else -> accessibilityEventObserved
        }
        val status = when {
            confirmed && kind == "pause" -> "youtube_video_paused"
            confirmed && kind == "stop" -> "youtube_video_stopped"
            confirmed && kind == "play" -> "youtube_video_playing"
            else -> "youtube_playback_unverified"
        }
        val evidence = when {
            kind == "pause" && hasPlayNow -> "Verified YouTube player control switched to Play (video paused)."
            kind == "play" && hasPauseNow -> "Verified YouTube player control switched to Pause (video playing)."
            kind == "stop" && (hasPlayNow || !hasPauseNow) -> "Verified YouTube playback stopped/closed."
            accessibilityEventObserved -> "YouTube player accessibility state transition observed."
            else -> "Could not visually confirm YouTube playback state changed."
        }
        return YouTubeVerificationResult(openedWatchScreen = confirmed, status = status, evidence = evidence)
    }

    /**
     * Resolves a user YouTube click request (ordinal index, thumbnail, Play/Pause/Stop button, or title query).
     * Strictly stops on ambiguous title matches or missing visible targets.
     */
    fun resolveVideoTarget(
        nodes: List<AccessibleNodeSnapshot>,
        index: Int? = null,
        targetHint: String = "",
        titleQuery: String = ""
    ): YouTubeTargetResolution {
        val hintLower = targetHint.trim().lowercase()
        val queryClean = titleQuery.trim()

        // 1a. Explicit Pause control request ("ভিডিওটি Pause করো", "Pause the video")
        if (hintLower == "pause_video" || hintLower == "pause_button" || hintLower == "pause" ||
            hintLower.contains("pause") || hintLower.contains("পজ")
        ) {
            val pauseBtn = findPlaybackControl(nodes, "pause")
            if (pauseBtn != null) {
                return YouTubeTargetResolution.Matched(pauseBtn, 1)
            }
            return YouTubeTargetResolution.NotFound(
                reason = "Could not find a visible Pause control on the current YouTube screen.",
                failureCode = "pause_button_not_found"
            )
        }

        // 1b. Explicit Stop control request ("ভিডিওটি Stop করো", "Stop the video")
        if (hintLower == "stop_video" || hintLower == "stop_button" || hintLower == "stop" ||
            hintLower.contains("stop") || hintLower.contains("স্টপ")
        ) {
            val stopBtn = findPlaybackControl(nodes, "stop")
            if (stopBtn != null) {
                return YouTubeTargetResolution.Matched(stopBtn, 1)
            }
            return YouTubeTargetResolution.NotFound(
                reason = "Could not find a visible Stop or Pause control on the current YouTube screen.",
                failureCode = "stop_button_not_found"
            )
        }

        // 1c. Explicit Play button request
        if (hintLower == "play_button" || hintLower == "play_video" || hintLower == "resume_video" ||
            hintLower == "play" || hintLower.contains("play button") || hintLower.contains("প্লে বাটন")
        ) {
            val playBtn = findPlaybackControl(nodes, "play")
            if (playBtn != null) {
                return YouTubeTargetResolution.Matched(playBtn, 1)
            }
            return YouTubeTargetResolution.NotFound(
                reason = "Could not find a visible Play button on the current YouTube screen.",
                failureCode = "play_button_not_found"
            )
        }

        val videos = collectVideoCandidates(nodes)
        if (videos.isEmpty()) {
            return YouTubeTargetResolution.NotFound(
                reason = "No visible YouTube video cards or search results were found on the current screen.",
                failureCode = "youtube_videos_not_found"
            )
        }

        // 2. Title keyword query (strict ambiguity check — never guess between two matching videos)
        if (queryClean.isNotBlank()) {
            val qLower = queryClean.lowercase()
            val exactMatches = videos.filter { it.title.lowercase() == qLower }
            if (exactMatches.size == 1) {
                return YouTubeTargetResolution.Matched(exactMatches[0], videos.indexOf(exactMatches[0]) + 1)
            }
            val partialMatches = videos.filter {
                it.title.lowercase().contains(qLower) ||
                    MultilingualNameMatcher.matchesQuery(it.title, queryClean)
            }
            if (partialMatches.size == 1) {
                return YouTubeTargetResolution.Matched(partialMatches[0], videos.indexOf(partialMatches[0]) + 1)
            }
            if (partialMatches.size > 1) {
                // If user also gave an explicit ordinal index (e.g. "2nd Arijit video"), select it safely
                if (index != null && index in 1..partialMatches.size) {
                    val picked = partialMatches[index - 1]
                    return YouTubeTargetResolution.Matched(picked, videos.indexOf(picked) + 1)
                }
                return YouTubeTargetResolution.Ambiguous(queryClean, partialMatches.take(5))
            }
            return YouTubeTargetResolution.NotFound(
                reason = "Could not find a visible YouTube video matching \"$queryClean\".",
                failureCode = "youtube_video_title_not_found"
            )
        }

        // 3. Thumbnail-specific preference when user asks to click a thumbnail ("এই ভিডিওর Thumbnail-এ ক্লিক করো")
        val targetPool = if (hintLower.contains("thumbnail") || hintLower.contains("থাম্বনেইল")) {
            videos.filter { it.isThumbnail }.ifEmpty { videos }
        } else {
            videos
        }

        // 4. Explicit ordinal selection (1 = first, 2 = second, etc.)
        val requestedIndex = index ?: if (hintLower == "current_video" || hintLower == "thumbnail" || hintLower == "first_result") 1 else null
        if (requestedIndex != null) {
            if (requestedIndex < 1 || requestedIndex > targetPool.size) {
                return YouTubeTargetResolution.NotFound(
                    reason = "Requested video #$requestedIndex is not visible on screen (only ${targetPool.size} visible video(s) found). Try scrolling down first.",
                    failureCode = "video_index_out_of_range"
                )
            }
            return YouTubeTargetResolution.Matched(targetPool[requestedIndex - 1], requestedIndex)
        }

        // 5. No index and no query -> ambiguous if multiple visible videos
        if (targetPool.size == 1) {
            return YouTubeTargetResolution.Matched(targetPool[0], 1)
        }
        return YouTubeTargetResolution.Ambiguous("video", targetPool.take(5))
    }

    /**
     * Verifies whether a YouTube video watch/player screen actually opened after clicking.
     */
    fun verifyWatchScreenOpened(
        beforeLabels: List<String>,
        afterNodes: List<AccessibleNodeSnapshot>,
        clickedTitle: String,
        activePackage: String,
        accessibilityEventObserved: Boolean
    ): YouTubeVerificationResult {
        if (!isYouTubePackage(activePackage)) {
            return YouTubeVerificationResult(
                openedWatchScreen = false,
                status = "youtube_left_foreground",
                evidence = "Active app changed away from YouTube ($activePackage)."
            )
        }

        val watchControlIds = listOf(
            "watch_player", "player_view", "player_control", "time_bar",
            "fullscreen_button", "like_button", "dislike_button", "comments", "subscribe_button"
        )
        val watchControlLabels = setOf(
            "pause video", "play video", "minimize", "enter fullscreen", "exit fullscreen",
            "like", "dislike", "share", "comments", "subscribe", "subscribed", "save",
            "ভিডিও পজ করুন", "সাবস্ক্রাইব", "শেয়ার", "মন্তব্য"
        )

        val hasWatchPlayerNode = afterNodes.any { node ->
            val vid = node.viewIdResourceName?.lowercase().orEmpty()
            val desc = node.contentDescription?.trim()?.lowercase().orEmpty()
            val txt = node.text?.trim()?.lowercase().orEmpty()
            watchControlIds.any { vid.contains(it) } || desc in watchControlLabels || txt in watchControlLabels
        }

        val afterLabels = afterNodes.mapNotNull { it.combinedLabel.takeIf { s -> s.isNotEmpty() } }
        val screenChanged = afterLabels.take(15) != beforeLabels.take(15)
        val titlePresent = clickedTitle.length >= 4 &&
            afterLabels.any { it.lowercase().contains(clickedTitle.take(24).lowercase()) }

        return when {
            hasWatchPlayerNode -> YouTubeVerificationResult(
                openedWatchScreen = true,
                status = "youtube_video_opened",
                evidence = "Verified YouTube watch player controls visible on screen."
            )
            accessibilityEventObserved && screenChanged && titlePresent -> YouTubeVerificationResult(
                openedWatchScreen = true,
                status = "youtube_video_opened",
                evidence = "Verified screen transitioned to \"$clickedTitle\" in YouTube."
            )
            accessibilityEventObserved && screenChanged -> YouTubeVerificationResult(
                openedWatchScreen = true,
                status = "youtube_screen_transitioned",
                evidence = "Verified YouTube screen changed after click."
            )
            else -> YouTubeVerificationResult(
                openedWatchScreen = false,
                status = "youtube_click_unverified",
                evidence = "Click was dispatched, but YouTube watch screen opening could not be confirmed."
            )
        }
    }
}

// ============================================================================
// PART 2 — MULTILINGUAL NAME MATCHER & WHATSAPP SMART CONTACT CLICK ENGINE
// ============================================================================

object MultilingualNameMatcher {

    private val KINSHIP_GROUPS: List<Set<String>> = listOf(
        setOf("মা", "আম্মু", "আম্মা", "মাম্মি", "ma", "maa", "ammu", "amma", "mom", "mum", "mummy", "mother", "माँ", "मां", "मम्मी", "ममी"),
        setOf("বাবা", "আব্বু", "আব্বা", "পাপা", "baba", "abbu", "abba", "papa", "dad", "daddy", "father", "पापा", "पिता", "अब्बा", "बाबा"),
        setOf("ভাই", "ভাইয়া", "দাদা", "bhai", "bhaiya", "dada", "brother", "bro", "भाई", "भैया"),
        setOf("বোন", "আপু", "দিদি", "bon", "apu", "didi", "sister", "sis", "बहन", "दीदी"),
        setOf("বউ", "স্ত্রী", "wife", "बिवी", "पत्नी"),
        setOf("স্বামী", "husband", "पति")
    )

    private val BENGALI_CHAR_MAP: Map<Char, String> = mapOf<Char, String>(
        'অ' to "o", 'আ' to "a", 'ই' to "i", 'ঈ' to "i", 'উ' to "u", 'ঊ' to "u",
        'এ' to "e", 'ঐ' to "oi", 'ও' to "o", 'ঔ' to "ou",
        'ক' to "k", 'খ' to "kh", 'গ' to "g", 'ঘ' to "gh", 'ঙ' to "ng",
        'চ' to "ch", 'ছ' to "ch", 'জ' to "j", 'ঝ' to "jh", 'ঞ' to "n",
        'ট' to "t", 'ঠ' to "th", 'ড' to "d", 'ঢ' to "dh", 'ণ' to "n",
        'ত' to "t", 'থ' to "th", 'দ' to "d", 'ধ' to "dh", 'ন' to "n",
        'প' to "p", 'ফ' to "f", 'ব' to "b", 'ভ' to "bh", 'ম' to "m",
        'য' to "j", 'র' to "r", 'ল' to "l", 'শ' to "sh", 'ষ' to "sh", 'স' to "s", 'হ' to "h",
        '\u09DC' to "r", '\u09DD' to "rh", '\u09DF' to "y",
        'ৎ' to "t", 'ং' to "ng", 'ঃ' to "h", 'ঁ' to "n",
        'া' to "a", 'ি' to "i", 'ী' to "i", 'ু' to "u", 'ূ' to "u",
        'ে' to "e", 'ৈ' to "oi", 'ো' to "o", 'ৌ' to "ou", '্' to ""
    )

    private val DEVANAGARI_CHAR_MAP: Map<Char, String> = mapOf<Char, String>(
        'अ' to "a", 'आ' to "a", 'इ' to "i", 'ई' to "i", 'उ' to "u", 'ऊ' to "u",
        'ए' to "e", 'ऐ' to "ai", 'ओ' to "o", 'औ' to "au",
        'क' to "k", 'ख' to "kh", 'ग' to "g", 'घ' to "gh", 'ङ' to "ng",
        'च' to "ch", 'छ' to "ch", 'ज' to "j", 'झ' to "jh", 'ञ' to "n",
        'ट' to "t", 'ठ' to "th", 'ड' to "d", 'ढ' to "dh", 'ण' to "n",
        'त' to "t", 'थ' to "th", 'द' to "d", 'ध' to "dh", 'न' to "n",
        'प' to "p", 'फ' to "f", 'ब' to "b", 'भ' to "bh", 'म' to "m",
        'य' to "y", 'र' to "r", 'ल' to "l", 'व' to "v", 'श' to "sh", 'ष' to "sh", 'स' to "s", 'ह' to "h",
        'ा' to "a", 'ि' to "i", 'ी' to "i", 'ु' to "u", 'ू' to "u",
        'े' to "e", 'ै' to "ai", 'ो' to "o", 'ौ' to "au", '्' to "", 'ं' to "n", 'ँ' to "n"
    )

    /**
     * Strips Bengali/Hindi/English possessive suffixes ("রাহুলের" -> "রাহুল", "মায়ের" -> "মা", "Rahul's" -> "Rahul").
     */
    fun cleanPersonQuery(raw: String): String {
        var clean = raw.trim()
            .replace(Regex("^(?:আমার|my|mere|meri|मेरी|मेरे|मेरा)\\s+", RegexOption.IGNORE_CASE), "")
            .replace(Regex("'s$|’s$", RegexOption.IGNORE_CASE), "")
            .replace(Regex("\\s+(?:का|की|के)$"), "")
            .trim()

        // Strip Bengali possessive/dative suffixes carefully
        if (clean == "মায়ের" || clean == "মায়ের" || clean == "মাকে") return "মা"
        if (clean == "বাবার" || clean == "বাবাকে") return "বাবা"
        if (clean.endsWith("ের") && clean.length > 3) {
            clean = clean.removeSuffix("ের")
        } else if (clean.endsWith("য়ের") && clean.length > 4) {
            clean = clean.removeSuffix("য়ের")
        } else if (clean.endsWith("য়ের") && clean.length > 4) {
            clean = clean.removeSuffix("য়ের")
        } else if (clean.endsWith("র") && clean.length > 3 && !clean.endsWith("ার")) {
            // Keep names naturally ending in "ার" unless known possessive like "জাহিদার" -> "জাহিদা"
            clean = clean.removeSuffix("র")
        } else if (clean.endsWith("ার") && clean.length > 4) {
            // "জাহিদার" -> "জাহিদা", "মীনার" -> "মীনা"
            clean = clean.removeSuffix("র")
        } else if (clean.endsWith("কে") && clean.length > 3) {
            clean = clean.removeSuffix("কে")
        }
        return clean.trim()
    }

    /**
     * Phonetic Latin skeleton so Bengali "রাহুল" / Hindi "राहुल" / English "Rahul" and
     * "জাহিদা" / "Jahida" / "Zahida" match cleanly across scripts.
     *
     * Note: Unicode NFC intentionally decomposes Bengali nukta letters (ড়, ঢ়, য়) into
     * base consonant + U+09BC (BENGALI SIGN NUKTA) because they are in the Unicode
     * Composition Exclusion Table. We explicitly match base+nukta pairs first so both
     * precomposed (U+09DC/U+09DD/U+09DF) and decomposed (ড/ঢ/য + U+09BC) inputs yield
     * identical, accurate Latin transliterations ("মায়া" -> "maya", "বাড়ি" -> "bari").
     */
    fun toPhoneticLatin(input: String): String {
        val lower = Normalizer.normalize(input.trim(), Normalizer.Form.NFC).lowercase()
        val sb = StringBuilder(lower.length * 2)
        var i = 0
        while (i < lower.length) {
            val ch = lower[i]
            val next = if (i + 1 < lower.length) lower[i + 1] else '\u0000'

            // Handle Bengali nukta digraphs produced by Unicode NFC composition exclusions
            if (next == '\u09BC') {
                val bnNukta = when (ch) {
                    'ড' -> "r"
                    'ঢ' -> "rh"
                    'য' -> "y"
                    else -> null
                }
                if (bnNukta != null) {
                    sb.append(bnNukta)
                    i += 2
                    continue
                }
            }

            // Handle Devanagari nukta digraphs (क़, ख़, ग़, ज़, ड़, ढ़, फ़)
            if (next == '\u093C') {
                val hiNukta = when (ch) {
                    'क' -> "k"
                    'ख' -> "kh"
                    'ग' -> "g"
                    'ज' -> "j"
                    'ड' -> "r"
                    'ढ' -> "rh"
                    'फ' -> "f"
                    else -> null
                }
                if (hiNukta != null) {
                    sb.append(hiNukta)
                    i += 2
                    continue
                }
            }

            val mapped = BENGALI_CHAR_MAP[ch] ?: DEVANAGARI_CHAR_MAP[ch]
            if (mapped != null) {
                sb.append(mapped)
            } else if (ch.isLetterOrDigit() || ch == ' ') {
                sb.append(ch)
            }
            i++
        }
        return sb.toString()
            .replace('z', 'j')
            .replace("ph", "f")
            .replace("ee", "i")
            .replace("oo", "u")
            .replace(Regex("\\s+"), " ")
            .trim()
    }

    fun consonantSkeleton(latin: String): String {
        return latin.replace(Regex("[aeiou\\s]+"), "")
    }

    fun matchesKinshipAlias(candidateName: String, query: String): Boolean {
        val cClean = cleanPersonQuery(candidateName).lowercase()
        val qClean = cleanPersonQuery(query).lowercase()
        for (group in KINSHIP_GROUPS) {
            if (qClean in group && (cClean in group || group.any { alias -> cClean.split(" ").contains(alias) })) {
                return true
            }
        }
        return false
    }

    /**
     * Returns a match score: 100 = exact, 90 = exact phonetic/kinship, 75 = word-boundary/prefix,
     * 60 = substring/phonetic partial, 0 = no match.
     */
    fun scoreNameMatch(candidateName: String, rawQuery: String): Int {
        val cand = candidateName.trim()
        val query = cleanPersonQuery(rawQuery)
        if (cand.isEmpty() || query.isEmpty()) return 0

        val cLower = cand.lowercase()
        val qLower = query.lowercase()

        if (cLower == qLower) return 100
        if (matchesKinshipAlias(cand, query)) return 92

        val cPhonetic = toPhoneticLatin(cand)
        val qPhonetic = toPhoneticLatin(query)
        if (cPhonetic.isNotEmpty() && cPhonetic == qPhonetic) return 90

        // Word-level exact match ("Rahul" matches "Rahul Sharma")
        val cWords = cLower.split(Regex("\\s+")).filter { it.isNotEmpty() }
        val cPhoneticWords = cPhonetic.split(Regex("\\s+")).filter { it.isNotEmpty() }
        if (qLower in cWords || (qPhonetic.isNotEmpty() && qPhonetic in cPhoneticWords)) return 82

        // Direct or phonetic prefix / contains
        if (cLower.startsWith(qLower) || (qPhonetic.length >= 2 && cPhonetic.startsWith(qPhonetic))) return 75
        if (qLower.length >= 2 && cLower.contains(qLower)) return 68
        if (qPhonetic.length >= 3 && cPhonetic.contains(qPhonetic)) return 65

        // Consonant skeleton match for Bengali/Hindi inherent vowel differences ("রাহুল" -> "rhl" vs "rahul" -> "rhl")
        val cSkel = consonantSkeleton(cPhonetic)
        val qSkel = consonantSkeleton(qPhonetic)
        if (qSkel.length >= 3 && (cSkel == qSkel || cPhoneticWords.any { consonantSkeleton(it) == qSkel })) {
            return 80
        }

        return 0
    }

    fun matchesQuery(candidateName: String, rawQuery: String): Boolean =
        scoreNameMatch(candidateName, rawQuery) >= 65
}

data class WhatsAppContactRowCandidate(
    val nameNode: AccessibleNodeSnapshot,
    val clickableNode: AccessibleNodeSnapshot?,
    val displayName: String,
    val bounds: AccessibleRect,
    val matchScore: Int
)

sealed class WhatsAppContactResolution {
    data class Matched(val candidate: WhatsAppContactRowCandidate) : WhatsAppContactResolution()
    data class Ambiguous(val query: String, val candidates: List<WhatsAppContactRowCandidate>) : WhatsAppContactResolution()
    data class NotFound(val reason: String, val failureCode: String) : WhatsAppContactResolution()
}

object WhatsAppSmartContactEngine {

    private val NON_CONTACT_UI_LABELS = setOf(
        "whatsapp", "whatsapp business", "search", "ask meta ai or search", "meta ai",
        "chats", "updates", "communities", "calls", "status", "archived", "unread",
        "favorites", "favourites", "groups", "all", "new chat", "new group", "new contact",
        "new community", "camera", "more options", "navigate up", "back", "settings",
        "type a message", "message", "send", "voice message", "attach", "emoji",
        "চ্যাট", "আপডেট", "কল", "খুঁজুন", "সার্চ", "মেসেজ", "পাঠান",
        "चैट", "अपडेट", "कॉल", "खोजें", "संदेश", "भेजें"
    )

    private val CONTACT_NAME_VIEW_IDS = listOf(
        "conversations_row_contact_name",
        "contactpicker_row_name",
        "row_contact_name",
        "contact_name",
        "chat_title",
        "group_chat_title",
        "result_title"
    )

    private val TIMESTAMP_REGEX = Regex("^\\d{1,2}:\\d{2}(?:\\s*(?:am|pm))?$|^yesterday$|^today$|^\\d{1,2}/\\d{1,2}/\\d{2,4}$", RegexOption.IGNORE_CASE)

    /**
     * Collects all visible WhatsApp chat/contact row candidates sorted visually top-to-bottom.
     */
    fun collectVisibleChatRows(nodes: List<AccessibleNodeSnapshot>): List<WhatsAppContactRowCandidate> {
        val nodesById = nodes.associateBy { it.nodeId }
        val rawRows = mutableListOf<WhatsAppContactRowCandidate>()

        for (node in nodes) {
            if (node.isPassword || node.isEditable || !node.isVisibleToUser || !node.isEnabled) continue
            val text = node.text?.trim().orEmpty()
            val desc = node.contentDescription?.trim().orEmpty()
            val label = text.ifEmpty { desc }
            if (label.isEmpty() || label.length > 80) continue

            val lower = label.lowercase()
            if (lower in NON_CONTACT_UI_LABELS) continue
            if (TIMESTAMP_REGEX.matches(lower)) continue
            if (AccessibilityGuard.containsOtpOrSecret(label)) continue

            val vid = node.viewIdResourceName?.lowercase().orEmpty()
            val isExplicitContactId = CONTACT_NAME_VIEW_IDS.any { vid.contains(it) }
            val clickable = AccessibilityTreeResolver.findNearestClickableNode(node, nodesById)
            val clickableVid = clickable?.viewIdResourceName?.lowercase().orEmpty()
            val inContactContainer = clickableVid.contains("contact_row_container") ||
                clickableVid.contains("conversations_row") ||
                clickableVid.contains("contactpicker_row") ||
                clickableVid.contains("row_container") ||
                clickableVid.contains("chat_row")

            // Reject top toolbar/header title when we are inspecting a chat list unless explicitly a row
            val isHeaderTitle = vid.contains("conversation_contact_name") || vid.contains("toolbar")
            if (isHeaderTitle) continue

            // Reject message preview / subtitle nodes when explicit IDs indicate preview text
            val isSubtitleOrPreview = vid.contains("single_msg_tv") ||
                vid.contains("conversations_row_date") ||
                vid.contains("conversations_row_message_count") ||
                vid.contains("status") ||
                vid.contains("badge")
            if (isSubtitleOrPreview) continue

            val isLikelyContactRow = isExplicitContactId || inContactContainer ||
                (clickable != null && node.bounds.isValidVisible && node.bounds.top >= 120 && clickable.bounds.height in 60..320)

            if (!isLikelyContactRow) continue

            val effectiveBounds = if (node.bounds.isValidVisible) node.bounds else clickable?.bounds ?: node.bounds
            if (!effectiveBounds.isValidVisible) continue

            rawRows.add(
                WhatsAppContactRowCandidate(
                    nameNode = node,
                    clickableNode = clickable,
                    displayName = label,
                    bounds = effectiveBounds,
                    matchScore = 0
                )
            )
        }

        // Deduplicate by clickable row container (keep primary contact name node, top-most within each row)
        val deduped = LinkedHashMap<String, WhatsAppContactRowCandidate>()
        for (row in rawRows.sortedWith(compareBy<WhatsAppContactRowCandidate> { it.bounds.top }.thenBy { it.bounds.left })) {
            val key = row.clickableNode?.nodeId?.let { "row_$it" }
                ?: "y_${row.bounds.top / 90}_${row.displayName.lowercase()}"
            val existing = deduped[key]
            val rowHasExplicitId = CONTACT_NAME_VIEW_IDS.any { row.nameNode.viewIdResourceName?.lowercase()?.contains(it) == true }
            val existingHasExplicitId = existing != null && CONTACT_NAME_VIEW_IDS.any { existing.nameNode.viewIdResourceName?.lowercase()?.contains(it) == true }
            if (existing == null || (rowHasExplicitId && !existingHasExplicitId)) {
                deduped[key] = row
            }
        }

        return deduped.values.sortedWith(compareBy<WhatsAppContactRowCandidate> { it.bounds.top }.thenBy { it.bounds.left })
    }

    /**
     * Resolves a visible WhatsApp contact/chat target by multilingual name OR explicit ordinal index.
     * STRICT SAFETY:
     * - If multiple contacts match ambiguously, returns [WhatsAppContactResolution.Ambiguous] (NEVER guesses).
     * - Never substitutes screen position when a specific contact name was requested.
     */
    fun resolveContactTarget(
        nodes: List<AccessibleNodeSnapshot>,
        contactQuery: String = "",
        ordinalIndex: Int? = null
    ): WhatsAppContactResolution {
        val rows = collectVisibleChatRows(nodes)
        if (rows.isEmpty()) {
            return WhatsAppContactResolution.NotFound(
                reason = "No visible WhatsApp contacts or chat rows were detected on the current screen.",
                failureCode = "whatsapp_contacts_not_visible"
            )
        }

        val cleanQuery = contactQuery.trim()
        if (cleanQuery.isNotEmpty()) {
            val scored = rows
                .map { it.copy(matchScore = MultilingualNameMatcher.scoreNameMatch(it.displayName, cleanQuery)) }
                .filter { it.matchScore >= 65 }
                .sortedByDescending { it.matchScore }

            if (scored.isEmpty()) {
                return WhatsAppContactResolution.NotFound(
                    reason = "Could not find \"$cleanQuery\" among the currently visible WhatsApp chats.",
                    failureCode = "whatsapp_contact_not_visible"
                )
            }

            // Check for multiple exact or equally-ranked matches (e.g., two contacts named "Rahul" or "Rahul Das" & "Rahul Roy")
            val topScore = scored.first().matchScore
            val topTier = scored.filter { it.matchScore >= topScore - 8 }
            if (topTier.size > 1) {
                return WhatsAppContactResolution.Ambiguous(cleanQuery, topTier.take(6))
            }

            return WhatsAppContactResolution.Matched(scored.first())
        }

        if (ordinalIndex != null) {
            if (ordinalIndex < 1 || ordinalIndex > rows.size) {
                return WhatsAppContactResolution.NotFound(
                    reason = "Requested contact/chat #$ordinalIndex is not visible (only ${rows.size} visible row(s) found).",
                    failureCode = "contact_index_out_of_range"
                )
            }
            return WhatsAppContactResolution.Matched(rows[ordinalIndex - 1])
        }

        return WhatsAppContactResolution.NotFound(
            reason = "Please specify a contact name or chat position to open in WhatsApp.",
            failureCode = "missing_contact_target"
        )
    }

    /**
     * Verifies that the active WhatsApp screen is now a conversation with the expected contact.
     */
    fun verifyConversationOpened(
        afterNodes: List<AccessibleNodeSnapshot>,
        expectedName: String,
        expectedPhone: String,
        activePackage: String
    ): Boolean {
        if (!WhatsAppAutomationValidator.isWhatsAppPackage(activePackage)) return false

        val hasComposer = afterNodes.any { node ->
            !node.isPassword && node.isEditable && node.isVisibleToUser
        }
        val headerLabels = afterNodes
            .filter { !it.isPassword && it.isVisibleToUser }
            .filter { node ->
                val vid = node.viewIdResourceName?.lowercase().orEmpty()
                vid.contains("conversation_contact_name") || vid.contains("toolbar") || node.bounds.top < 280
            }
            .mapNotNull { it.text?.trim()?.takeIf { s -> s.isNotEmpty() } ?: it.contentDescription?.trim()?.takeIf { s -> s.isNotEmpty() } }

        val allLabels = if (headerLabels.isNotEmpty()) headerLabels else afterNodes.take(15).mapNotNull { it.combinedLabel.takeIf { s -> s.isNotEmpty() } }

        val nameMatched = expectedName.isBlank() ||
            allLabels.any { MultilingualNameMatcher.matchesQuery(it, expectedName) } ||
            WhatsAppAutomationValidator.matchesExpectedRecipient(allLabels, expectedName, expectedPhone)

        return hasComposer && nameMatched
    }
}

// ============================================================================
// PART 2C & 2D — DEDICATED WHATSAPP SEND BUTTON RESOLVER & DELIVERY VERIFIER
// ============================================================================

data class WhatsAppSendButtonMatch(
    val buttonNode: AccessibleNodeSnapshot,
    val clickableNode: AccessibleNodeSnapshot?,
    val bounds: AccessibleRect,
    val score: Int,
    val matchedBy: String
)

enum class WhatsAppDeliveryState(val statusCode: String) {
    DELIVERED("whatsapp_delivered_confirmed"),
    SENT("whatsapp_sent_confirmed"),
    PENDING("whatsapp_sent_pending"),
    SENT_BUBBLE_VISIBLE("whatsapp_sent_verified"),
    UNVERIFIED("whatsapp_send_unverified")
}

data class WhatsAppSendVerificationReport(
    val verified: Boolean,
    val state: WhatsAppDeliveryState,
    val bubbleVisible: Boolean,
    val composerCleared: Boolean,
    val evidence: String
)

object WhatsAppSendButtonResolver {

    private val SEND_EXACT_LABELS = setOf(
        "send", "send message", "send now",
        "পাঠান", "মেসেজ পাঠান", "বার্তা পাঠান",
        "भेजें", "भेजे", "संदेश भेजें", "मैसेज भेजें"
    )

    private val SEND_VIEW_IDS = listOf(
        ":id/send",
        ":id/send_container",
        ":id/send_btn",
        ":id/conversation_send",
        ":id/btn_send",
        ":id/send_button"
    )

    // Strictly reject mic/voice-note/attach/camera/emoji/call buttons!
    private val FORBIDDEN_ACTION_KEYWORDS = listOf(
        "voice", "mic", "microphone", "record", "audio", "camera", "attach",
        "emoji", "sticker", "gif", "call", "video call", "search", "more options",
        "ভয়েস", "মাইক", "ক্যামেরা", "অ্যাটাচ", "ইমোজি", "কল",
        "वॉइस", "माइक", "कैमरा", "अटैच", "इमोजी", "कॉल"
    )

    private val FORBIDDEN_VIEW_ID_KEYWORDS = listOf(
        "voice_note", "mic", "camera", "attach", "emoji", "input_attach", "call", "video"
    )

    /**
     * Resolves the real visible & enabled WhatsApp Send button using multi-signal semantic analysis
     * (text, contentDescription, viewIdResourceName, className, isClickable, isEnabled,
     * isVisibleToUser, boundsInScreen, parent node hierarchy) — never depends on one hardcoded ID
     * and never selects voice-note/mic buttons.
     */
    fun resolveSendButton(
        nodes: List<AccessibleNodeSnapshot>,
        composerBounds: AccessibleRect? = null
    ): WhatsAppSendButtonMatch? {
        val nodesById = nodes.associateBy { it.nodeId }
        val candidates = mutableListOf<WhatsAppSendButtonMatch>()

        for (node in nodes) {
            if (node.isPassword || node.isEditable) continue
            if (!node.isEnabled || !node.isVisibleToUser) continue

            val vid = node.viewIdResourceName?.trim()?.lowercase().orEmpty()
            val desc = node.contentDescription?.trim()?.lowercase().orEmpty()
            val txt = node.text?.trim()?.lowercase().orEmpty()
            val cls = node.className?.trim()?.lowercase().orEmpty()

            // Strict safety filter: never treat voice-note/mic/camera/attach/emoji/call as Send
            if (FORBIDDEN_VIEW_ID_KEYWORDS.any { vid.contains(it) }) continue
            if (FORBIDDEN_ACTION_KEYWORDS.any { desc.contains(it) || txt.contains(it) }) continue

            var score = 0
            val signals = mutableListOf<String>()

            if (SEND_EXACT_LABELS.any { desc == it || txt == it }) {
                score += 60
                signals.add("exact_send_label")
            } else if (SEND_EXACT_LABELS.any { desc.startsWith(it) || txt.startsWith(it) }) {
                score += 45
                signals.add("prefix_send_label")
            }

            if (SEND_VIEW_IDS.any { vid.endsWith(it) || vid.contains(it) }) {
                score += 50
                signals.add("send_view_id")
            }

            if (score == 0) continue

            if (cls.contains("imagebutton") || cls.contains("button") || cls.contains("imageview")) {
                score += 10
                signals.add("button_class")
            }

            val clickable = AccessibilityTreeResolver.findNearestClickableNode(node, nodesById, maxDepth = 4)
            if (node.isClickable) {
                score += 15
                signals.add("directly_clickable")
            } else if (clickable != null) {
                score += 10
                signals.add("clickable_parent")
            }

            val effectiveBounds = if (node.bounds.isValidVisible) node.bounds else clickable?.bounds ?: node.bounds
            if (effectiveBounds.isValidVisible) {
                score += 10
                // Geometric consistency bonus: Send button sits to the right of / aligned vertically with composer
                if (composerBounds != null && composerBounds.isValidVisible) {
                    val nearComposerY = kotlin.math.abs(effectiveBounds.centerY - composerBounds.centerY) <= (composerBounds.height * 2.2f + 120f)
                    val toRightOfComposer = effectiveBounds.left >= composerBounds.left
                    if (nearComposerY && toRightOfComposer) {
                        score += 15
                        signals.add("composer_aligned")
                    }
                }
            }

            // Must have either a semantic clickable node OR valid visible bounds for bounded fallback
            if (clickable == null && !effectiveBounds.isValidVisible) continue

            candidates.add(
                WhatsAppSendButtonMatch(
                    buttonNode = node,
                    clickableNode = clickable,
                    bounds = effectiveBounds,
                    score = score,
                    matchedBy = signals.joinToString("+")
                )
            )
        }

        return candidates.maxByOrNull { it.score }
    }

    /**
     * Inspects updated WhatsApp conversation nodes after Send to verify the outgoing message
     * and honestly distinguish pending vs sent vs delivered states when visible.
     * NEVER claims delivery or read status without explicit visible evidence.
     */
    fun verifyPostSendState(
        afterNodes: List<AccessibleNodeSnapshot>,
        composerText: String,
        expectedMessage: String
    ): WhatsAppSendVerificationReport {
        val cleanExpected = expectedMessage.trim()
        if (cleanExpected.isEmpty()) {
            return WhatsAppSendVerificationReport(
                verified = false,
                state = WhatsAppDeliveryState.UNVERIFIED,
                bubbleVisible = false,
                composerCleared = composerText.trim().isEmpty(),
                evidence = "Expected message was empty."
            )
        }

        val normalizedExpected = cleanExpected.replace(Regex("\\s+"), " ").lowercase()
        val snippet = normalizedExpected.take(48)

        val nonEditableNodes = afterNodes.filter { !it.isPassword && !it.isEditable && it.isVisibleToUser }
        val matchingBubbleNode = nonEditableNodes.lastOrNull { node ->
            val combined = node.combinedLabel.replace(Regex("\\s+"), " ").lowercase()
            combined.contains(snippet)
        }

        val composerNormalized = composerText.trim().replace(Regex("\\s+"), " ").lowercase()
        val composerCleared = composerNormalized.isEmpty() || composerNormalized != normalizedExpected

        if (matchingBubbleNode == null || !composerCleared) {
            val reason = when {
                !composerCleared -> "Message text is still present in the WhatsApp composer — Send was not confirmed."
                else -> "Outgoing message bubble could not be visually verified in the WhatsApp conversation."
            }
            return WhatsAppSendVerificationReport(
                verified = false,
                state = WhatsAppDeliveryState.UNVERIFIED,
                bubbleVisible = matchingBubbleNode != null,
                composerCleared = composerCleared,
                evidence = reason
            )
        }

        // Inspect nearby status indicators (sibling/parent/recent status nodes) for explicit tick descriptions
        val nodesById = afterNodes.associateBy { it.nodeId }
        val bubbleParentId = matchingBubbleNode.parentId
        val statusContextNodes = afterNodes.filter { node ->
            !node.isPassword && node.isVisibleToUser && (
                node.parentId == bubbleParentId ||
                    (bubbleParentId != null && node.parentId == nodesById[bubbleParentId]?.parentId) ||
                    node.viewIdResourceName?.lowercase()?.contains("status") == true
                )
        }
        val statusLabels = statusContextNodes.mapNotNull {
            it.contentDescription?.trim()?.lowercase()?.takeIf { s -> s.isNotEmpty() }
        }

        return when {
            statusLabels.any { it == "delivered" || it.contains("delivered") || it.contains("ডেলিভার") || it.contains("डिलीवर") } ->
                WhatsAppSendVerificationReport(
                    verified = true,
                    state = WhatsAppDeliveryState.DELIVERED,
                    bubbleVisible = true,
                    composerCleared = true,
                    evidence = "Verified outgoing message bubble, cleared composer, and visible Delivered status indicator."
                )
            statusLabels.any { it == "sent" || it.contains("sent") || it.contains("পাঠানো হয়েছে") || it.contains("भेजा गया") } ->
                WhatsAppSendVerificationReport(
                    verified = true,
                    state = WhatsAppDeliveryState.SENT,
                    bubbleVisible = true,
                    composerCleared = true,
                    evidence = "Verified outgoing message bubble, cleared composer, and visible Sent status indicator (delivery not yet confirmed)."
                )
            statusLabels.any { it.contains("pending") || it.contains("sending") || it.contains("waiting") || it.contains("clock") } ->
                WhatsAppSendVerificationReport(
                    verified = true,
                    state = WhatsAppDeliveryState.PENDING,
                    bubbleVisible = true,
                    composerCleared = true,
                    evidence = "Verified outgoing message bubble in chat with Pending/Sending status (waiting for network)."
                )
            else ->
                WhatsAppSendVerificationReport(
                    verified = true,
                    state = WhatsAppDeliveryState.SENT_BUBBLE_VISIBLE,
                    bubbleVisible = true,
                    composerCleared = true,
                    evidence = "Verified outgoing message appeared in conversation and composer cleared (delivery/read status not exposed by WhatsApp UI)."
                )
        }
    }
}

// ============================================================================
// PART 3 — FACEBOOK ACCESSIBILITY UI CONTROL ENGINE (SEMANTIC + SAFE)
// ============================================================================

data class FacebookControlCandidate(
    val matchNode: AccessibleNodeSnapshot,
    val clickableNode: AccessibleNodeSnapshot?,
    val label: String,
    val category: String,
    val bounds: AccessibleRect,
    val score: Int
)

sealed class FacebookUiResolution {
    data class Matched(val candidate: FacebookControlCandidate, val rankIndex: Int) : FacebookUiResolution()
    data class Ambiguous(val query: String, val candidates: List<FacebookControlCandidate>) : FacebookUiResolution()
    data class NotFound(val reason: String, val failureCode: String) : FacebookUiResolution()
}

object FacebookUiControlEngine {

    private val FACEBOOK_PACKAGES = setOf(
        "com.facebook.katana",
        "com.facebook.lite",
        "com.facebook.mlite"
    )

    private val CONTROL_SYNONYMS: Map<String, Pair<String, Set<String>>> = mapOf(
        "like" to ("feed_control" to setOf("like", "like button", "লাইক", "लाइक")),
        "comment" to ("feed_control" to setOf("comment", "comments", "কমেন্ট", "মন্তব্য", "कमेंट")),
        "share" to ("feed_control" to setOf("share", "শেয়ার", "শেয়ার", "शेयर")),
        "save" to ("feed_control" to setOf("save", "save post", "সেভ", "सेव")),
        "follow" to ("feed_control" to setOf("follow", "ফলো", "फॉलो")),
        "home" to ("nav_tab" to setOf("home", "home, tab", "feed", "হোম", "होम")),
        "video" to ("nav_tab" to setOf("video", "watch", "reels", "ভিডিও", "রিলস", "वीडियो", "रील्स")),
        "friends" to ("nav_tab" to setOf("friends", "ফ্রেন্ডস", "বন্ধু", "फ्रेंड्स")),
        "notifications" to ("nav_tab" to setOf("notifications", "notification", "নোটিফিকেশন", "नोटिफिकेशन")),
        "menu" to ("menu" to setOf("menu", "more", "more options", "মেনু", "মেইন মেনু", "मेनू")),
        "profile" to ("nav_tab" to setOf("profile", "প্রোফাইল", "प्रोफ़ाइल")),
        "search" to ("search" to setOf("search", "search facebook", "সার্চ", "খুঁজুন", "सर्च"))
    )

    fun isFacebookPackage(pkg: String?): Boolean {
        val clean = pkg?.trim()?.lowercase().orEmpty()
        return clean in FACEBOOK_PACKAGES
    }

    /**
     * Resolves a visible accessible Facebook UI control (buttons, feed actions, nav tabs, menus).
     * Never clicks password/disabled/hidden nodes and reports ambiguity honestly when multiple controls match.
     */
    fun resolveControl(
        nodes: List<AccessibleNodeSnapshot>,
        rawQuery: String,
        ordinalIndex: Int? = null
    ): FacebookUiResolution {
        val cleanQuery = rawQuery.trim()
            .replace(Regex("^(?:facebook(?:-?এ|\\s*এ|\\s*on|\\s*in|\\s*में)?\\s+)", RegexOption.IGNORE_CASE), "")
            .replace(Regex("\\s*(?:button|tab|icon|বাটনে|বাটন|বটন|बटन)$", RegexOption.IGNORE_CASE), "")
            .trim()
        if (cleanQuery.isEmpty()) {
            return FacebookUiResolution.NotFound(
                reason = "Please specify which visible Facebook button or tab to tap.",
                failureCode = "empty_facebook_target"
            )
        }

        val lowerQuery = cleanQuery.lowercase()
        val matchedCanonical = CONTROL_SYNONYMS.entries.firstOrNull { (key, pair) ->
            lowerQuery == key || pair.second.any { lowerQuery == it || lowerQuery.contains(it) }
        }
        val acceptedTerms = matchedCanonical?.value?.second ?: setOf(lowerQuery)
        val category = matchedCanonical?.value?.first ?: "visible_control"

        val nodesById = nodes.associateBy { it.nodeId }
        val rawMatches = mutableListOf<FacebookControlCandidate>()

        for (node in nodes) {
            if (node.isPassword || !node.isVisibleToUser || !node.isEnabled) continue
            val txt = node.text?.trim().orEmpty()
            val desc = node.contentDescription?.trim().orEmpty()
            val label = txt.ifEmpty { desc }
            if (label.isEmpty()) continue
            val lowerTxt = txt.lowercase()
            val lowerDesc = desc.lowercase()
            val lowerLabel = label.lowercase()

            var score = 0
            for (term in acceptedTerms) {
                when {
                    lowerTxt == term || lowerDesc == term -> score = maxOf(score, 100)
                    lowerDesc.startsWith("$term,") || lowerDesc.startsWith("$term ") || lowerTxt.startsWith("$term ") ->
                        score = maxOf(score, 88)
                    lowerLabel.contains(term) -> score = maxOf(score, 72)
                }
            }
            if (score == 0 && MultilingualNameMatcher.matchesQuery(label, cleanQuery)) {
                score = 68
            }
            if (score == 0) continue

            val clickable = AccessibilityTreeResolver.findNearestClickableNode(node, nodesById, maxDepth = 4)
            val bounds = if (node.bounds.isValidVisible) node.bounds else clickable?.bounds ?: node.bounds
            if (clickable == null && !bounds.isValidVisible) continue
            if (clickable != null) score += 10

            rawMatches.add(
                FacebookControlCandidate(
                    matchNode = node,
                    clickableNode = clickable,
                    label = label,
                    category = category,
                    bounds = bounds,
                    score = score
                )
            )
        }

        if (rawMatches.isEmpty()) {
            return FacebookUiResolution.NotFound(
                reason = "Could not find a visible \"$cleanQuery\" control on the current Facebook screen.",
                failureCode = "facebook_control_not_found"
            )
        }

        // Deduplicate by clickable container ID and sort visually top-to-bottom
        val deduped = LinkedHashMap<String, FacebookControlCandidate>()
        for (cand in rawMatches.sortedWith(compareByDescending<FacebookControlCandidate> { it.score }
            .thenBy { it.bounds.top }.thenBy { it.bounds.left })) {
            val key = cand.clickableNode?.nodeId?.let { "fb_click_$it" }
                ?: "fb_pos_${cand.bounds.top / 40}_${cand.bounds.left / 40}"
            if (!deduped.containsKey(key)) {
                deduped[key] = cand
            }
        }
        val ordered = deduped.values.sortedWith(compareBy<FacebookControlCandidate> { it.bounds.top }.thenBy { it.bounds.left })

        if (ordinalIndex != null) {
            if (ordinalIndex < 1 || ordinalIndex > ordered.size) {
                return FacebookUiResolution.NotFound(
                    reason = "Requested Facebook \"$cleanQuery\" #$ordinalIndex is not visible (only ${ordered.size} visible match(es)).",
                    failureCode = "facebook_index_out_of_range"
                )
            }
            return FacebookUiResolution.Matched(ordered[ordinalIndex - 1], ordinalIndex)
        }

        val topScore = ordered.maxOf { it.score }
        val topTier = ordered.filter { it.score >= topScore - 6 }
        if (topTier.size == 1) {
            return FacebookUiResolution.Matched(topTier[0], ordered.indexOf(topTier[0]) + 1)
        }
        return FacebookUiResolution.Ambiguous(cleanQuery, topTier.take(5))
    }
}

// ============================================================================
// PART 4 — GENERAL UI ACTION DUPLICATE-TAP GUARD (PURE JVM-TESTABLE)
// ============================================================================

object UiActionDeduplicator {
    private val recentClicks = java.util.concurrent.ConcurrentHashMap<String, Long>()
    private const val DEFAULT_COOLDOWN_MS = 1200L

    fun tryAcquire(
        packageName: String,
        actionType: String,
        target: String,
        nowMs: Long = System.currentTimeMillis(),
        cooldownMs: Long = DEFAULT_COOLDOWN_MS
    ): Boolean {
        val key = "${packageName.trim().lowercase()}|${actionType.trim().lowercase()}|${target.trim().lowercase()}"
        val previous = recentClicks[key]
        if (previous != null && (nowMs - previous) < cooldownMs) {
            return false
        }
        recentClicks[key] = nowMs
        if (recentClicks.size > 120) {
            val cutoff = nowMs - (cooldownMs * 4L)
            recentClicks.entries.removeIf { it.value < cutoff }
        }
        return true
    }

    fun resetForTests() {
        recentClicks.clear()
    }
}

// ============================================================================
// PART 5 — UNIVERSAL CROSS-APP UI AUTOMATION ENGINE (PURE JVM-TESTABLE)
// ============================================================================

data class UniversalUiCandidate(
    val matchNode: AccessibleNodeSnapshot,
    val clickableNode: AccessibleNodeSnapshot?,
    val label: String,
    val bounds: AccessibleRect,
    val score: Int
)

sealed class UniversalUiResolution {
    data class Matched(val candidate: UniversalUiCandidate, val rankIndex: Int) : UniversalUiResolution()
    data class Ambiguous(val query: String, val candidates: List<UniversalUiCandidate>) : UniversalUiResolution()
    data class NotFound(val reason: String, val failureCode: String) : UniversalUiResolution()
}

data class UniversalClickVerification(
    val stateChanged: Boolean,
    val status: String,
    val evidence: String
)

object UniversalUiAutomationEngine {

    private val UNIVERSAL_SYNONYMS: Map<String, Set<String>> = mapOf(
        "search" to setOf("search", "find", "সার্চ", "খুঁজুন", "খোঁজ", "खोजें", "सर्च"),
        "settings" to setOf("settings", "setting", "সেটিংস", "সেটিং", "सेटिंग्स"),
        "send" to setOf("send", "submit", "post", "পাঠান", "পাঠাও", "সাবমিট", "পোস্ট", "भेजें", "सबमिट"),
        "play" to setOf("play", "resume", "start", "প্লে", "চালাও", "শুরু", "प्ले", "चलाएं"),
        "pause" to setOf("pause", "পজ", "বিরতি", "থামাও", "पॉज़"),
        "stop" to setOf("stop", "স্টপ", "বন্ধ", "बंद"),
        "back" to setOf("back", "navigate up", "return", "ব্যাক", "পেছনে", "পিছনে", "ফিরে", "वापस"),
        "home" to setOf("home", "হোম", "होम"),
        "next" to setOf("next", "continue", "proceed", "forward", "পরবর্তী", "নেক্সট", "এগিয়ে", "अगला", "आगे"),
        "previous" to setOf("previous", "prev", "আগের", "পূর্ববর্তী", "पिछला"),
        "close" to setOf("close", "dismiss", "exit", "ক্লোজ", "বন্ধ", "बंद करें"),
        "cancel" to setOf("cancel", "বাতিল", "ক্যানসেল", "রদ্দ", "रद्द"),
        "ok" to setOf("ok", "okay", "done", "confirm", "accept", "agree", "allow", "ঠিক আছে", "ওকে", "ডান", "অনুমতি", "स्वीकार"),
        "save" to setOf("save", "সেভ", "সংরক্ষণ", "सेव"),
        "share" to setOf("share", "শেয়ার", "শেয়ার", "शेयर"),
        "like" to setOf("like", "লাইক", "পছন্দ", "लाइक"),
        "comment" to setOf("comment", "comments", "reply", "কমেন্ট", "মন্তব্য", "রিপ্লাই", "कमेंट"),
        "subscribe" to setOf("subscribe", "সাবস্ক্রাইব", "सब्सक्राइब"),
        "follow" to setOf("follow", "ফলো", "অনুসরণ", "फॉलो"),
        "delete" to setOf("delete", "remove", "trash", "ডিলিট", "মুছুন", "হटाएं", "डिलीट"),
        "edit" to setOf("edit", "এডিট", "সম্পাদনা", "एडिट"),
        "add" to setOf("add", "new", "create", "plus", "যোগ", "নতুন", "অ্যাড", "जोड़ें"),
        "download" to setOf("download", "ডাউনলোড", "डाउनलोड"),
        "menu" to setOf("menu", "more", "more options", "options", "মেনু", "আরও", "मेनू"),
        "profile" to setOf("profile", "account", "me", "প্রোফাইল", "অ্যাকাউন্ট", "प्रोफ़ाइल"),
        "notifications" to setOf("notifications", "notification", "alerts", "নোটিফিকেশন", "বিজ্ঞপ্তি", "नोटिफिकेशन"),
        "camera" to setOf("camera", "ক্যামেরা", "कैमरा"),
        "call" to setOf("call", "voice call", "audio call", "কল", "ফোন", "कॉल"),
        "video_call" to setOf("video call", "ভিডিও কল", "वीडियो कॉल"),
        "mute" to setOf("mute", "মিউট", "म्यूट"),
        "unmute" to setOf("unmute", "আনমিউট", "अनम्यूट"),
        "skip" to setOf("skip", "skip ad", "স্কিপ", "এড়িয়ে যান", "स्किप"),
        "refresh" to setOf("refresh", "reload", "রিফ্রেশ", "रिफ्रेश")
    )

    fun cleanTargetQuery(rawQuery: String): String {
        var clean = Normalizer.normalize(rawQuery, Normalizer.Form.NFC).trim()
        clean = clean
            .replace(Regex("^(?:please\\s+|click\\s+|tap\\s+|press\\s+|open\\s+)(?:on\\s+)?", RegexOption.IGNORE_CASE), "")
            .replace(Regex("^(?:the\\s+|this\\s+|that\\s+|এই\\s+|ওই\\s+)", RegexOption.IGNORE_CASE), "")
            .replace(Regex("\\s*(?:button|tab|icon|option|item|link|বাটনে|বাটনটিতে|বাটন|বটনে|বটন|আইকনে|আইকন|অপশনে|অপশন|बटन|आइकन)$", RegexOption.IGNORE_CASE), "")
            .replace(Regex("(?:-এ|-তে)$"), "")
            .trim()
        return clean
    }

    fun resolveTarget(
        nodes: List<AccessibleNodeSnapshot>,
        rawQuery: String,
        ordinalIndex: Int? = null
    ): UniversalUiResolution {
        val cleanQuery = cleanTargetQuery(rawQuery)
        if (cleanQuery.isEmpty()) {
            return UniversalUiResolution.NotFound(
                reason = "Please specify which visible element to tap.",
                failureCode = "missing_target_text"
            )
        }
        if (AccessibilityGuard.isSensitiveInputHint(cleanQuery)) {
            return UniversalUiResolution.NotFound(
                reason = "Cannot interact with password, PIN, or OTP UI elements.",
                failureCode = "sensitive_target_blocked"
            )
        }

        val lowerQuery = cleanQuery.lowercase()
        val matchedSynGroup = UNIVERSAL_SYNONYMS.entries.firstOrNull { (key, terms) ->
            lowerQuery == key || terms.any { lowerQuery == it }
        }
        val acceptedTerms = matchedSynGroup?.value ?: setOf(lowerQuery)

        val nodesById = nodes.associateBy { it.nodeId }
        val rawMatches = mutableListOf<UniversalUiCandidate>()

        for (node in nodes) {
            if (node.isPassword || !node.isVisibleToUser || !node.isEnabled) continue
            val txt = node.text?.trim().orEmpty()
            val desc = node.contentDescription?.trim().orEmpty()
            val hint = node.hintText?.trim().orEmpty()
            val vidTail = node.viewIdResourceName?.substringAfterLast("/")?.replace('_', ' ')?.trim().orEmpty()
            val primaryLabel = txt.ifEmpty { desc.ifEmpty { hint.ifEmpty { vidTail } } }
            if (primaryLabel.isEmpty()) continue
            if (AccessibilityGuard.isSensitiveInputHint(primaryLabel)) continue

            val lowerTxt = txt.lowercase()
            val lowerDesc = desc.lowercase()
            val lowerHint = hint.lowercase()
            val lowerVid = vidTail.lowercase()
            val lowerPrimary = primaryLabel.lowercase()

            var score = 0
            for (term in acceptedTerms) {
                when {
                    lowerTxt == term || lowerDesc == term -> score = maxOf(score, 100)
                    lowerHint == term || lowerVid == term -> score = maxOf(score, 92)
                    lowerTxt.startsWith("$term ") || lowerDesc.startsWith("$term ") || lowerDesc.startsWith("$term,") ->
                        score = maxOf(score, 88)
                    lowerTxt.contains(term) || lowerDesc.contains(term) -> score = maxOf(score, 76)
                    lowerHint.contains(term) || lowerVid.contains(term) -> score = maxOf(score, 68)
                }
            }

            if (score == 0) {
                val crossScriptScore = MultilingualNameMatcher.scoreNameMatch(primaryLabel, cleanQuery)
                if (crossScriptScore >= 75) {
                    score = crossScriptScore - 4
                } else if (lowerPrimary.contains(lowerQuery) && lowerQuery.length >= 2) {
                    score = 70
                }
            }

            if (score < 68) continue

            val clickable = AccessibilityTreeResolver.findNearestClickableNode(node, nodesById, maxDepth = 5)
            val effectiveBounds = if (node.bounds.isValidVisible) node.bounds else clickable?.bounds ?: node.bounds
            if (clickable == null && !effectiveBounds.isValidVisible) continue
            if (clickable != null) score += 12

            val classLower = node.className?.lowercase().orEmpty()
            if (classLower.contains("button") || classLower.contains("tab") || classLower.contains("switch") || classLower.contains("checkbox")) {
                score += 4
            }

            rawMatches.add(
                UniversalUiCandidate(
                    matchNode = node,
                    clickableNode = clickable,
                    label = primaryLabel,
                    bounds = effectiveBounds,
                    score = score
                )
            )
        }

        if (rawMatches.isEmpty()) {
            return UniversalUiResolution.NotFound(
                reason = "Could not find visible UI element \"$cleanQuery\" on the current screen.",
                failureCode = "element_not_found"
            )
        }

        // Deduplicate by clickable container ID or tight spatial bucket
        val deduped = LinkedHashMap<String, UniversalUiCandidate>()
        for (cand in rawMatches.sortedWith(compareByDescending<UniversalUiCandidate> { it.score }
            .thenBy { it.bounds.top }.thenBy { it.bounds.left })) {
            val key = cand.clickableNode?.nodeId?.let { "u_click_$it" }
                ?: "u_pos_${cand.bounds.top / 48}_${cand.bounds.left / 48}_${cand.label.lowercase().take(20)}"
            if (!deduped.containsKey(key)) {
                deduped[key] = cand
            }
        }
        val ordered = deduped.values.sortedWith(compareBy<UniversalUiCandidate> { it.bounds.top }.thenBy { it.bounds.left })

        if (ordinalIndex != null) {
            if (ordinalIndex < 1 || ordinalIndex > ordered.size) {
                return UniversalUiResolution.NotFound(
                    reason = "Requested \"$cleanQuery\" #$ordinalIndex is not visible on screen (only ${ordered.size} match(es)).",
                    failureCode = "element_index_out_of_range"
                )
            }
            return UniversalUiResolution.Matched(ordered[ordinalIndex - 1], ordinalIndex)
        }

        val topScore = ordered.maxOf { it.score }
        val topTier = ordered.filter { it.score >= topScore - 6 }
        if (topTier.size == 1) {
            val winner = topTier[0]
            return UniversalUiResolution.Matched(winner, ordered.indexOf(winner) + 1)
        }
        return UniversalUiResolution.Ambiguous(cleanQuery, topTier.take(5))
    }

    fun verifyClickOutcome(
        beforeLabels: List<String>,
        afterNodes: List<AccessibleNodeSnapshot>,
        clickedLabel: String,
        accessibilityEventObserved: Boolean
    ): UniversalClickVerification {
        val afterLabels = afterNodes.mapNotNull { it.combinedLabel.takeIf { s -> s.isNotEmpty() } }
        val changed = afterLabels.take(20) != beforeLabels.take(20)
        return when {
            accessibilityEventObserved && changed -> UniversalClickVerification(
                stateChanged = true,
                status = "executed_verified",
                evidence = "Tapped \"$clickedLabel\" and verified screen updated."
            )
            accessibilityEventObserved -> UniversalClickVerification(
                stateChanged = true,
                status = "executed_event_verified",
                evidence = "Tapped \"$clickedLabel\" and observed Accessibility UI response."
            )
            changed -> UniversalClickVerification(
                stateChanged = true,
                status = "executed_content_changed",
                evidence = "Tapped \"$clickedLabel\" and observed visible UI content change."
            )
            else -> UniversalClickVerification(
                stateChanged = false,
                status = "executed_unverified",
                evidence = "Dispatched click on \"$clickedLabel\", but no screen state change was detected."
            )
        }
    }
}

// ============================================================================
// PART 6 — INTELLIGENT VISUAL RECOGNITION & PRECISION CLICK ENGINE (PURE JVM)
// ============================================================================

data class VisualTargetAlternative(
    val label: String,
    val confidence: Float,
    val x: Int,
    val y: Int
)

data class VisualTargetProposal(
    val found: Boolean,
    val confidence: Float,
    val ambiguous: Boolean,
    val label: String,
    val x: Int,
    val y: Int,
    val reason: String = "",
    val alternatives: List<VisualTargetAlternative> = emptyList()
)

sealed class VisualClickPlan {
    data class ClickAccessibilityNode(
        val matchNode: AccessibleNodeSnapshot,
        val clickableAncestor: AccessibleNodeSnapshot?,
        val resolvedBounds: AccessibleRect,
        val label: String,
        val confidence: Float
    ) : VisualClickPlan()

    data class ClickVerifiedCoordinates(
        val x: Int,
        val y: Int,
        val label: String,
        val confidence: Float
    ) : VisualClickPlan()

    data class ClarifyAmbiguous(
        val query: String,
        val options: List<String>,
        val reason: String
    ) : VisualClickPlan()

    data class RefuseLowConfidence(
        val query: String,
        val confidence: Float,
        val reason: String
    ) : VisualClickPlan()

    data class BlockedSensitive(
        val reason: String
    ) : VisualClickPlan()

    data class NotFound(
        val reason: String
    ) : VisualClickPlan()
}

object VisualClickIntelligenceEngine {

    const val MIN_CONFIDENCE: Float = 0.68f
    const val AMBIGUITY_CONFIDENCE_DELTA: Float = 0.12f

    private val VISUAL_QUERY_REGEX = Regex(
        "(?:\\b(?:red|blue|green|yellow|orange|white|black|purple|pink|grey|gray|dark|light|round|circular|square|" +
            "icon|logo|symbol|image|photo|picture|thumbnail|avatar|banner|card|badge|dot|gear|bell|heart|star|arrow|plus|minus|cross|" +
            "top[-\\s]?right|top[-\\s]?left|bottom[-\\s]?right|bottom[-\\s]?left|upper|lower|middle|center|corner|left\\s+side|right\\s+side)\\b|" +
            "লাল|নীল|সবুজ|হলুদ|কমলা|সাদা|কালো|বেগুনি|গোলাপি|আইকন|লোগো|ছবি|থাম্বনেইল|তীর|চিহ্ন|" +
            "উপরে\\s*ডান|উপরে\\s*বাম|নিচে\\s*ডান|নিচে\\s*বাম|ডান\\s*পাশ|বাম\\s*পাশ|ডানদিকে|বামদিকে|মাঝখানে|কোণায়|কোণায়|" +
            "लाल|नीला|हरा|पीला|सफेद|काला|आइकन|लोगो|तस्वीर|ऊपर\\s*दाएं|नीचे\\s*बाएं)",
        RegexOption.IGNORE_CASE
    )

    fun isVisualAttributeQuery(query: String): Boolean {
        val clean = query.trim()
        if (clean.isEmpty()) return false
        return VISUAL_QUERY_REGEX.containsMatchIn(clean)
    }

    /**
     * Parses structured JSON returned by Gemini Vision (supports optional markdown fences,
     * pixel coordinates `x`/`y`, or normalized 0..1000 coordinates `xNorm`/`yNorm` or `box_2d`).
     */
    fun parseGeminiVisionTargetJson(
        rawResponse: String,
        screenWidth: Int,
        screenHeight: Int
    ): VisualTargetProposal {
        val safeW = screenWidth.coerceAtLeast(100)
        val safeH = screenHeight.coerceAtLeast(100)
        val cleaned = rawResponse.trim()
            .removePrefix("```json")
            .removePrefix("```")
            .removeSuffix("```")
            .trim()
        val jsonStart = cleaned.indexOf('{')
        val jsonEnd = cleaned.lastIndexOf('}')
        if (jsonStart < 0 || jsonEnd <= jsonStart) {
            return VisualTargetProposal(
                found = false,
                confidence = 0f,
                ambiguous = false,
                label = "",
                x = -1,
                y = -1,
                reason = "Vision model returned non-JSON response."
            )
        }
        val slice = cleaned.substring(jsonStart, jsonEnd + 1)
        return try {
            val obj = org.json.JSONObject(slice)
            val found = obj.optBoolean("found", false)
            val confidence = obj.optDouble("confidence", 0.0).toFloat().coerceIn(0f, 1f)
            val ambiguous = obj.optBoolean("ambiguous", false)
            val label = obj.optString("label", "").trim()
            val reason = obj.optString("reason", "").trim()

            var resolvedX = -1
            var resolvedY = -1

            // Prefer resolution-independent normalized 0..1000 coordinates (xNorm/yNorm or box_2d [ymin, xmin, ymax, xmax])
            // because MediaProjection JPEGs are downscaled to maxDimension=1080 while Accessibility bounds use real display pixels.
            if (obj.has("xNorm") && obj.has("yNorm")) {
                val xNorm = obj.optDouble("xNorm", -1.0)
                val yNorm = obj.optDouble("yNorm", -1.0)
                if (xNorm in 0.0..1000.0 && yNorm in 0.0..1000.0) {
                    resolvedX = ((xNorm / 1000.0) * safeW).toInt()
                    resolvedY = ((yNorm / 1000.0) * safeH).toInt()
                }
            }
            if ((resolvedX < 0 || resolvedY < 0) && obj.has("box_2d")) {
                val box = obj.optJSONArray("box_2d")
                if (box != null && box.length() == 4) {
                    val yMin = box.optDouble(0, -1.0)
                    val xMin = box.optDouble(1, -1.0)
                    val yMax = box.optDouble(2, -1.0)
                    val xMax = box.optDouble(3, -1.0)
                    if (yMin >= 0 && xMin >= 0 && yMax > yMin && xMax > xMin) {
                        resolvedX = ((((xMin + xMax) / 2.0) / 1000.0) * safeW).toInt()
                        resolvedY = ((((yMin + yMax) / 2.0) / 1000.0) * safeH).toInt()
                    }
                }
            }
            if (resolvedX < 0 || resolvedY < 0) {
                resolvedX = obj.optInt("x", -1)
                resolvedY = obj.optInt("y", -1)
            }

            val validCoords = resolvedX in 1 until safeW && resolvedY in 1 until safeH
            val alternatives = mutableListOf<VisualTargetAlternative>()
            val altArr = obj.optJSONArray("alternatives")
            if (altArr != null) {
                for (i in 0 until altArr.length()) {
                    val item = altArr.optJSONObject(i) ?: continue
                    val altLabel = item.optString("label", "").trim()
                    val altConf = item.optDouble("confidence", 0.0).toFloat().coerceIn(0f, 1f)
                    val ax = item.optInt("x", -1)
                    val ay = item.optInt("y", -1)
                    if (altLabel.isNotEmpty()) {
                        alternatives.add(VisualTargetAlternative(altLabel, altConf, ax, ay))
                    }
                }
            }

            VisualTargetProposal(
                found = found && validCoords,
                confidence = if (found && validCoords) confidence else 0f,
                ambiguous = ambiguous,
                label = label,
                x = if (validCoords) resolvedX else -1,
                y = if (validCoords) resolvedY else -1,
                reason = reason,
                alternatives = alternatives
            )
        } catch (e: Exception) {
            VisualTargetProposal(
                found = false,
                confidence = 0f,
                ambiguous = false,
                label = "",
                x = -1,
                y = -1,
                reason = "Could not parse visual target JSON: ${e.message}"
            )
        }
    }

    /**
     * Revalidates a Gemini Vision target proposal against the live Accessibility hierarchy:
     * - Refuses low-confidence guesses (< MIN_CONFIDENCE).
     * - Clarifies ambiguous targets instead of blindly clicking.
     * - Strictly blocks password or sensitive nodes overlapping the target point.
     * - Prefers clicking the enclosing clickable Accessibility node over raw coordinates.
     */
    fun revalidateTargetAgainstAccessibilityTree(
        query: String,
        proposal: VisualTargetProposal,
        liveNodes: List<AccessibleNodeSnapshot>,
        screenWidth: Int,
        screenHeight: Int,
        minConfidence: Float = MIN_CONFIDENCE
    ): VisualClickPlan {
        if (!proposal.found) {
            return VisualClickPlan.NotFound(
                proposal.reason.ifBlank { "Could not visually locate \"$query\" on the current screen." }
            )
        }

        val closeAlternatives = proposal.alternatives.filter {
            it.confidence >= minConfidence * 0.85f &&
                (proposal.confidence - it.confidence) <= AMBIGUITY_CONFIDENCE_DELTA &&
                !it.label.equals(proposal.label, ignoreCase = true)
        }
        if (proposal.ambiguous || closeAlternatives.isNotEmpty()) {
            val options = buildList {
                if (proposal.label.isNotBlank()) add(proposal.label)
                closeAlternatives.forEach { if (it.label.isNotBlank()) add(it.label) }
            }.distinct().take(4)
            return VisualClickPlan.ClarifyAmbiguous(
                query = query,
                options = options,
                reason = "Multiple visual elements match \"$query\". Please specify which one to tap."
            )
        }

        if (proposal.confidence < minConfidence) {
            return VisualClickPlan.RefuseLowConfidence(
                query = query,
                confidence = proposal.confidence,
                reason = "Visual match confidence (${(proposal.confidence * 100).toInt()}%) is too low to click safely."
            )
        }

        if (proposal.x !in 1 until screenWidth || proposal.y !in 1 until screenHeight) {
            return VisualClickPlan.NotFound("Proposed visual coordinates (${proposal.x}, ${proposal.y}) are outside screen bounds.")
        }

        // Security check: block if ANY password or sensitive node overlaps the target point
        val containingAll = liveNodes.filter { node ->
            node.bounds.isValidVisible &&
                proposal.x in node.bounds.left..node.bounds.right &&
                proposal.y in node.bounds.top..node.bounds.bottom
        }
        if (containingAll.any { it.isPassword || AccessibilityGuard.isSensitiveInputHint(it.combinedLabel.ifEmpty { it.hintText.orEmpty() }) }) {
            return VisualClickPlan.BlockedSensitive(
                "Blocked visual click because the target overlaps a password, PIN, or OTP field."
            )
        }

        // Prefer tightest visible, enabled clickable node (or nearest clickable ancestor) covering (x, y)
        val nodesById = liveNodes.associateBy { it.nodeId }
        val visibleContaining = containingAll
            .filter { it.isVisibleToUser && it.isEnabled && !it.isPassword }
            .sortedBy { it.bounds.width.toLong() * it.bounds.height.toLong() }

        for (node in visibleContaining) {
            val clickable = AccessibilityTreeResolver.findNearestClickableNode(node, nodesById, maxDepth = 4)
            if (clickable != null && !clickable.isPassword && clickable.isEnabled) {
                // Avoid clicking a full-screen root container (> 85% of screen area)
                val areaRatio = (clickable.bounds.width.toLong() * clickable.bounds.height.toLong()).toDouble() /
                    (screenWidth.toLong() * screenHeight.toLong()).coerceAtLeast(1L).toDouble()
                if (areaRatio <= 0.85) {
                    val resolvedLabel = proposal.label.ifBlank { node.combinedLabel.ifBlank { clickable.combinedLabel.ifBlank { query } } }
                    return VisualClickPlan.ClickAccessibilityNode(
                        matchNode = node,
                        clickableAncestor = clickable,
                        resolvedBounds = clickable.bounds,
                        label = resolvedLabel,
                        confidence = proposal.confidence
                    )
                }
            }
        }

        return VisualClickPlan.ClickVerifiedCoordinates(
            x = proposal.x,
            y = proposal.y,
            label = proposal.label.ifBlank { query },
            confidence = proposal.confidence
        )
    }
}


