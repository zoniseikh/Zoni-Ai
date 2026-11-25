/**
 * Zoni AI — Real-Time Local-First Command Router & Partial-Transcript Guard.
 *
 * Implements:
 * 1. Partial-transcript completeness safety: classifies early intent on streaming partial
 *    transcripts WITHOUT executing incomplete commands.
 * 2. Local-first routing: dispatches locally supported Android/device commands (YouTube,
 *    WhatsApp launch & contact navigation, installed apps, Contacts, Accessibility clicks/scrolls,
 *    Settings, Flashlight, Volume, Camera, Battery, Date/Time, Local Memory) immediately on
 *    completion WITHOUT waiting for Gemini Cloud — works offline and on weak networks.
 * 3. Consequential action guard: blocks unauthorized purchases, payments, or unconfirmed sends.
 * 4. 2.5s duplicate-execution suppression across partial -> final transcript transitions.
 * 5. Short immediate localized voice confirmation formatting (Bengali, English, Hindi).
 */

import {
  buildStructuredTaskPlan,
  type AllowedTaskTool,
  type TaskPlan,
  type TaskStep,
} from './taskExecutionEngine.ts';
import { detectDateTimeQuery } from './bengaliDateTime.ts';
import type { SupportedLanguage } from '../types.ts';

export type LocalRouteDecisionKind =
  | 'WAIT_FOR_MORE_SPEECH'
  | 'PREVIEW_ONLY'
  | 'LOCAL_DIRECT'
  | 'LOCAL_DATETIME'
  | 'CLOUD_GEMINI_STREAMING'
  | 'BLOCKED_UNSAFE'
  | 'REQUIRES_EXPLICIT_AUTHORIZATION'
  | 'DUPLICATE_SUPPRESSED';

export interface LocalRouteResult {
  decision: LocalRouteDecisionKind;
  normalizedText: string;
  isPartial: boolean;
  incompleteReason?: string;
  plan?: TaskPlan;
  earlyIntentLabel?: string;
  primaryLatencyStage?: 'application_launch' | 'accessibility_interaction' | 'local_action_dispatch';
  blockedReason?: string;
  dateTimeQuery?: 'time' | 'date' | 'weekday';
  worksOffline: boolean;
}

const INCOMPLETE_SINGLE_WORDS = new Set([
  'open',
  'launch',
  'start',
  'play',
  'call',
  'dial',
  'message',
  'send',
  'whatsapp',
  'youtube',
  'click',
  'tap',
  'press',
  'scroll',
  'go',
  'search',
  'find',
  'turn',
  'set',
  'volume',
  'flashlight',
  'torch',
  'settings',
  'zoni',
  'জোনি',
  'খোলো',
  'খুলো',
  'কল',
  'মেসেজ',
  'ক্লিক',
  'স্ক্রল',
  'সার্চ',
  'হোয়াটসঅ্যাপ',
  'ইউটিউব',
  'खोलो',
  'कॉल',
  'मैसेज',
]);

const TRAILING_INCOMPLETE_TOKENS = new Set([
  'to',
  'on',
  'in',
  'at',
  'for',
  'with',
  'from',
  'the',
  'a',
  'an',
  'and',
  'then',
  'or',
  'saying',
  'that',
  'my',
  'এবং',
  'তারপর',
  'আর',
  'কে',
  'এ',
  'তে',
  'থেকে',
  'দিয়ে',
  'করে',
  'বলো',
  'और',
  'को',
  'में',
  'पर',
  'से',
]);

const CONSEQUENTIAL_ACTION_PATTERNS = [
  /\b(?:buy\s+now|place\s+(?:the\s+)?order|confirm\s+(?:the\s+)?(?:payment|purchase|transfer|order)|pay\s+(?:now|\$|₹|rs\.?|rupees|taka|\d+)|send\s+money|transfer\s+(?:money|funds|\$|₹|\d+)|upi\s+pay|checkout\s+now)\b/i,
  /(?:পেমেন্ট\s*(?:করো|করে\s*দাও|কনফার্ম)|টাকা\s*(?:পাঠাও|ট্রান্সফার)|অর্ডার\s*(?:কনফার্ম|প্লেস)|কিনে\s*ফেলো)/i,
  /(?:पेमेंट\s*(?:करो|कर\s*दो)|पैसे\s*(?:भेजो|ट्रांसफर)|ऑर्डर\s*कन्फर्म)/i,
];

/**
 * Checks whether a streaming partial transcript looks syntactically incomplete so we
 * never execute half-spoken commands ("open", "whatsapp-এ", "call to", "open youtube and").
 */
export function isLikelyIncompletePartial(rawText: string): {
  incomplete: boolean;
  reason?: string;
} {
  const clean = (rawText || '').trim().replace(/[।.,!?]+$/, '').trim();
  if (!clean) {
    return { incomplete: true, reason: 'empty_transcript' };
  }

  const tokens = clean.split(/\s+/).filter(Boolean);
  const lowerClean = clean.toLowerCase();

  if (tokens.length === 1 && INCOMPLETE_SINGLE_WORDS.has(lowerClean)) {
    return { incomplete: true, reason: 'single_leading_command_word' };
  }

  // Bengali locative partial like "whatsapp-এ" or "হোয়াটসঅ্যাপে" without target/verb
  if (
    tokens.length === 1 &&
    /(?:whatsapp[- ]?এ|হোয়াটসঅ্যাপে|হোয়াটসঅ্যাপে|youtube[- ]?এ|ইউটিউবে)$/i.test(clean)
  ) {
    return { incomplete: true, reason: 'incomplete_app_context_prefix' };
  }

  const lastToken = tokens[tokens.length - 1].toLowerCase().replace(/^["'`]+|["'`]+$/g, '');
  if (TRAILING_INCOMPLETE_TOKENS.has(lastToken)) {
    return { incomplete: true, reason: 'dangling_trailing_connector' };
  }

  // "open the" / "click on" / "search for" / "call my"
  if (/^(?:open|launch|click|tap|call|search|scroll|turn|set)\s+(?:the|a|on|for|to|my)$/i.test(lowerClean)) {
    return { incomplete: true, reason: 'incomplete_verb_phrase' };
  }

  return { incomplete: false };
}

/**
 * Detects financial, purchase, or other high-consequence intents that MUST NOT execute
 * automatically without explicit user authorization.
 */
export function requiresExplicitConsequentialAuthorization(rawText: string): string | null {
  const clean = (rawText || '').trim();
  if (!clean) return null;
  for (const pattern of CONSEQUENTIAL_ACTION_PATTERNS) {
    if (pattern.test(clean)) {
      return 'Purchases, payments, and financial transfers require explicit manual authorization and are never executed automatically.';
    }
  }
  return null;
}

export function classifyStepLatencyStage(
  steps: readonly TaskStep[]
): 'application_launch' | 'accessibility_interaction' | 'local_action_dispatch' {
  const accessibilityTools = new Set<AllowedTaskTool>([
    'accessibility_action',
    'click_visible_element',
    'click_youtube_video',
    'click_youtube_search_result',
    'click_whatsapp_contact',
    'open_whatsapp_chat',
    'type_whatsapp_message',
    'send_whatsapp_message',
    'verify_whatsapp_send',
  ]);
  if (steps.some((s) => accessibilityTools.has(s.tool))) {
    return 'accessibility_interaction';
  }
  if (steps.some((s) => s.tool === 'open_app' || s.tool === 'app_search_workflow')) {
    return 'application_launch';
  }
  return 'local_action_dispatch';
}

/**
 * Normalizes phrasing like "Open WhatsApp and search Rahul" or "WhatsApp-এ রাহুলকে খুঁজো"
 * into deterministic contact-navigation steps without authorizing any message sending.
 */
export function buildEnhancedLocalTaskPlan(rawText: string): TaskPlan {
  const clean = (rawText || '').trim();

  // Check explicit WhatsApp contact navigation BEFORE generic "and" multi-step splitting so
  // "Open WhatsApp and search Rahul" routes directly to `open_whatsapp_chat` (never web_search).
  const waSearchEn = clean.match(
    /^(?:open\s+)?whatsapp(?:\s+and)?\s+(?:search|find|open|go\s+to)\s+(?:contact\s+|chat\s+(?:with\s+)?)?(.+?)(?:\s+chat|\s+conversation)?$/i
  );
  if (waSearchEn && waSearchEn[1]) {
    const contactName = waSearchEn[1].trim();
    if (contactName.length > 0) {
      return {
        planId: `wa_nav_${Date.now()}`,
        rawInput: clean,
        requiresConfirmation: false,
        steps: [
          {
            stepId: 'step_wa_open_chat',
            tool: 'open_whatsapp_chat',
            args: { contact_name: contactName },
            requiredPermissions: ['ACCESSIBILITY_SERVICE'],
            requiresUserConfirmation: false,
            honestOutcomeNote: `Opening WhatsApp and navigating to ${contactName} without sending any message.`,
          },
        ],
      };
    }
  }

  const waSearchBn = clean.match(
    /^(?:হোয়াটসঅ্যাপ|হোয়াটসঅ্যাপ|whatsapp)(?:-?এ|ে|\s+খুলে|\s+ওপেন\s+করে)?\s+(.+?)(?:কে|-কে|\s+এর\s+চ্যাট|\s+চ্যাট)?\s*(?:খুঁজো|খোঁজো|সার্চ\s*করো|চ্যাট\s*খোলো|খোলো|ওপেন\s*করো)$/i
  );
  if (waSearchBn && waSearchBn[1]) {
    const contactName = waSearchBn[1].trim();
    if (contactName.length > 0) {
      return {
        planId: `wa_nav_bn_${Date.now()}`,
        rawInput: clean,
        requiresConfirmation: false,
        steps: [
          {
            stepId: 'step_wa_open_chat_bn',
            tool: 'open_whatsapp_chat',
            args: { contact_name: contactName },
            requiredPermissions: ['ACCESSIBILITY_SERVICE'],
            requiresUserConfirmation: false,
            honestOutcomeNote: `Opening WhatsApp and searching for ${contactName} without sending any message.`,
          },
        ],
      };
    }
  }

  return buildStructuredTaskPlan(clean);
}

/**
 * Sliding-window deduplicator preventing duplicate local dispatch across partial -> final
 * speech transcripts or Gemini tool echoes.
 */
export class LocalCommandDeduplicator {
  private lastKey = '';
  private lastTimestampMs = 0;

  constructor(
    private readonly windowMs: number = 2500,
    private readonly nowClock: () => number = () => Date.now()
  ) {}

  public reset(): void {
    this.lastKey = '';
    this.lastTimestampMs = 0;
  }

  public computeKey(plan: TaskPlan): string {
    return plan.steps
      .map((s) => `${s.tool}:${JSON.stringify(s.args)}`)
      .join('|')
      .toLowerCase();
  }

  public isDuplicate(key: string): boolean {
    if (!key) return false;
    const now = this.nowClock();
    return key === this.lastKey && now - this.lastTimestampMs < this.windowMs;
  }

  public markExecuted(key: string): void {
    if (!key) return;
    this.lastKey = key;
    this.lastTimestampMs = this.nowClock();
  }

  public tryClaim(key: string): boolean {
    if (this.isDuplicate(key)) return false;
    this.markExecuted(key);
    return true;
  }
}

/**
 * Classifies an incoming partial or completed transcript using the Local-First Routing Policy:
 * - Partial transcripts NEVER dispatch actions (they return `WAIT_FOR_MORE_SPEECH` or `PREVIEW_ONLY`).
 * - Completed local commands dispatch immediately (`LOCAL_DIRECT` / `LOCAL_DATETIME`) with zero Gemini wait.
 * - Unsafe payloads & unauthorized consequential actions are explicitly blocked.
 * - General knowledge/conversational queries route to `CLOUD_GEMINI_STREAMING`.
 */
export function routeVoiceCommandLocalFirst(
  rawText: string,
  options: {
    isFinal: boolean;
    deduplicator?: LocalCommandDeduplicator;
  }
): LocalRouteResult {
  const normalizedText = (rawText || '').trim();
  if (!normalizedText) {
    return {
      decision: 'WAIT_FOR_MORE_SPEECH',
      normalizedText: '',
      isPartial: !options.isFinal,
      incompleteReason: 'empty_transcript',
      worksOffline: true,
    };
  }

  // 1. Consequential authorization check (purchases / payments / transfers)
  const consequentialReason = requiresExplicitConsequentialAuthorization(normalizedText);
  if (consequentialReason) {
    return {
      decision: 'REQUIRES_EXPLICIT_AUTHORIZATION',
      normalizedText,
      isPartial: !options.isFinal,
      blockedReason: consequentialReason,
      worksOffline: true,
    };
  }

  // 2. Partial-transcript completeness guard (never execute incomplete streaming partials)
  const partialCheck = isLikelyIncompletePartial(normalizedText);
  if (!options.isFinal) {
    if (partialCheck.incomplete) {
      return {
        decision: 'WAIT_FOR_MORE_SPEECH',
        normalizedText,
        isPartial: true,
        incompleteReason: partialCheck.reason,
        worksOffline: true,
      };
    }
    // Early safe intent classification preview ONLY (no execution until speech completes)
    const previewPlan = buildEnhancedLocalTaskPlan(normalizedText);
    if (previewPlan.blockedReason) {
      return {
        decision: 'BLOCKED_UNSAFE',
        normalizedText,
        isPartial: true,
        blockedReason: previewPlan.blockedReason,
        worksOffline: true,
      };
    }
    const previewDt = detectDateTimeQuery(normalizedText);
    return {
      decision: 'PREVIEW_ONLY',
      normalizedText,
      isPartial: true,
      plan: previewPlan.steps.length > 0 ? previewPlan : undefined,
      earlyIntentLabel:
        previewPlan.steps.length > 0
          ? previewPlan.steps.map((s) => s.tool).join('+')
          : previewDt
          ? `local_datetime:${previewDt}`
          : 'cloud_gemini_streaming',
      primaryLatencyStage:
        previewPlan.steps.length > 0 ? classifyStepLatencyStage(previewPlan.steps) : undefined,
      dateTimeQuery: previewDt ?? undefined,
      worksOffline: previewPlan.steps.length > 0 || Boolean(previewDt),
    };
  }

  // 3. Final / Completed utterance: deterministic local-first dispatch
  const plan = buildEnhancedLocalTaskPlan(normalizedText);
  if (plan.blockedReason) {
    return {
      decision: 'BLOCKED_UNSAFE',
      normalizedText,
      isPartial: false,
      blockedReason: plan.blockedReason,
      worksOffline: true,
    };
  }

  if (plan.steps.length > 0) {
    const dedupKey = options.deduplicator?.computeKey(plan) ?? '';
    if (options.deduplicator && !options.deduplicator.tryClaim(dedupKey)) {
      return {
        decision: 'DUPLICATE_SUPPRESSED',
        normalizedText,
        isPartial: false,
        plan,
        earlyIntentLabel: plan.steps.map((s) => s.tool).join('+'),
        primaryLatencyStage: classifyStepLatencyStage(plan.steps),
        worksOffline: true,
      };
    }
    return {
      decision: 'LOCAL_DIRECT',
      normalizedText,
      isPartial: false,
      plan,
      earlyIntentLabel: plan.steps.map((s) => s.tool).join('+'),
      primaryLatencyStage: classifyStepLatencyStage(plan.steps),
      worksOffline: true,
    };
  }

  const dtQuery = detectDateTimeQuery(normalizedText);
  if (dtQuery) {
    return {
      decision: 'LOCAL_DATETIME',
      normalizedText,
      isPartial: false,
      dateTimeQuery: dtQuery,
      earlyIntentLabel: `local_datetime:${dtQuery}`,
      primaryLatencyStage: 'local_action_dispatch',
      worksOffline: true,
    };
  }

  return {
    decision: 'CLOUD_GEMINI_STREAMING',
    normalizedText,
    isPartial: false,
    earlyIntentLabel: 'cloud_gemini_streaming',
    worksOffline: false,
  };
}

/**
 * Formats concise immediate spoken confirmation for verified local actions so voice feedback
 * feels crisp and natural without waiting for a cloud LLM rewrite.
 */
export function formatImmediateLocalFeedback(
  toolName: string,
  target: string,
  verifiedSuccess: boolean,
  lang: SupportedLanguage = 'bn-BD'
): string {
  const cleanTarget = (target || '').trim();
  if (!verifiedSuccess) {
    if (lang === 'bn-BD') {
      return cleanTarget
        ? `${cleanTarget} চালু বা সম্পন্ন করা যায়নি।`
        : 'কাজটি সম্পন্ন করা যায়নি।';
    }
    if (lang === 'hi-IN') {
      return cleanTarget
        ? `${cleanTarget} पूरा नहीं हो सका।`
        : 'कार्रवाई पूरी नहीं हो सकी।';
    }
    return cleanTarget ? `Could not complete ${cleanTarget}.` : 'Could not complete that action.';
  }

  switch (toolName) {
    case 'open_app':
      if (lang === 'bn-BD') return cleanTarget ? `${cleanTarget} খুলছি।` : 'অ্যাপ খুলছি।';
      if (lang === 'hi-IN') return cleanTarget ? `${cleanTarget} खोल रही हूँ।` : 'ऐप खोल रही हूँ।';
      return cleanTarget ? `Opening ${cleanTarget}.` : 'Opening app.';
    case 'open_whatsapp_chat':
    case 'click_whatsapp_contact':
      if (lang === 'bn-BD') {
        return cleanTarget ? `হোয়াটসঅ্যাপে ${cleanTarget}-এর চ্যাট খুলছি।` : 'হোয়াটসঅ্যাপ চ্যাট খুলছি।';
      }
      if (lang === 'hi-IN') {
        return cleanTarget ? `व्हाट्सएप पर ${cleanTarget} की चैट खोल रही हूँ।` : 'व्हाट्सएप चैट खोल रही हूँ।';
      }
      return cleanTarget ? `Opening ${cleanTarget} on WhatsApp.` : 'Opening WhatsApp chat.';
    case 'click_visible_element':
    case 'click_youtube_video':
    case 'click_youtube_search_result':
    case 'accessibility_action':
      if (lang === 'bn-BD') return cleanTarget ? `${cleanTarget} ক্লিক করা হয়েছে।` : 'স্ক্রিন অ্যাকশন সম্পন্ন হয়েছে।';
      if (lang === 'hi-IN') return cleanTarget ? `${cleanTarget} पर क्लिक किया गया।` : 'स्क्रीन एक्शन पूरा हुआ।';
      return cleanTarget ? `Clicked ${cleanTarget}.` : 'Screen action done.';
    case 'flashlight_control':
    case 'flashlight':
      if (lang === 'bn-BD') return 'টর্চ আপডেট করা হয়েছে।';
      if (lang === 'hi-IN') return 'टॉर्च अपडेट कर दी गई है।';
      return 'Flashlight updated.';
    default:
      if (lang === 'bn-BD') return 'হয়ে গেছে।';
      if (lang === 'hi-IN') return 'हो गया।';
      return 'Done.';
  }
}
