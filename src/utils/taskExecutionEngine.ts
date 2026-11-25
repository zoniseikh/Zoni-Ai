/**
 * Zoni AI — Structured, Allowlisted Voice-Controlled Task Execution Engine.
 *
 * Covers all 12 personal Android assistant command categories cleanly:
 * 1. General Gemini question (returns empty steps -> routed to Gemini AI)
 * 2. Voice conversation (routed to Gemini Live)
 * 3. Contact lookup (`contact_lookup`)
 * 4. Direct SIM calling (`sim_call` — supports both phone numbers and contact names)
 * 5. Contact-based WhatsApp messaging (`whatsapp_prepare` — draft only, NEVER claims sent)
 * 6. Installed app launching (`open_app`)
 * 7. Screen understanding (`screen_analyze`)
 * 8. Notification reading & reply prep (`notification_read`)
 * 9. Accessibility interaction (`accessibility_action`)
 * 10. Device control (`flashlight`, `vibrate`, `battery_status`, `camera_open`, `volume_control`)
 * 11. Android settings navigation (`open_settings`)
 * 12. Unsupported / dangerous shell commands (explicitly blocked)
 */

import { detectAssistantIntent } from './mobileAssistant.ts';

export type AllowedTaskTool =
  | 'open_app'
  | 'list_installed_apps'
  | 'app_search_workflow'
  | 'contact_lookup'
  | 'sim_call'
  | 'whatsapp_prepare'
  | 'sms_compose'
  | 'app_chat_prepare'
  | 'review_pending_draft'
  | 'approve_pending_action'
  | 'flashlight'
  | 'vibrate'
  | 'battery_status'
  | 'camera_open'
  | 'volume_control'
  | 'screen_analyze'
  | 'notification_read'
  | 'accessibility_action'
  | 'open_settings'
  | 'notification'
  | 'reminder'
  | 'web_search'
  | 'cancel_current_task'
  | 'click_youtube_video'
  | 'click_youtube_search_result'
  | 'click_visible_element'
  | 'click_whatsapp_contact'
  | 'open_whatsapp_chat'
  | 'type_whatsapp_message'
  | 'send_whatsapp_message'
  | 'verify_whatsapp_send'
  | 'answer_incoming_call'
  | 'reject_incoming_call'
  | 'end_active_call';

export const ALLOWED_TASK_TOOLS: ReadonlySet<AllowedTaskTool> = new Set([
  'open_app',
  'list_installed_apps',
  'app_search_workflow',
  'contact_lookup',
  'sim_call',
  'whatsapp_prepare',
  'sms_compose',
  'app_chat_prepare',
  'review_pending_draft',
  'approve_pending_action',
  'flashlight',
  'vibrate',
  'battery_status',
  'camera_open',
  'volume_control',
  'screen_analyze',
  'notification_read',
  'accessibility_action',
  'open_settings',
  'notification',
  'reminder',
  'web_search',
  'cancel_current_task',
  'click_youtube_video',
  'click_youtube_search_result',
  'click_visible_element',
  'click_whatsapp_contact',
  'open_whatsapp_chat',
  'type_whatsapp_message',
  'send_whatsapp_message',
  'verify_whatsapp_send',
  'answer_incoming_call',
  'reject_incoming_call',
  'end_active_call',
]);

export interface TaskStep {
  stepId: string;
  tool: AllowedTaskTool;
  args: Record<string, string | number | boolean>;
  requiredPermissions: string[];
  requiresUserConfirmation: boolean;
  honestOutcomeNote: string;
}

export interface TaskPlan {
  planId: string;
  rawInput: string;
  steps: TaskStep[];
  requiresConfirmation: boolean;
  blockedReason?: string;
}

export interface TaskExecutionAudit {
  planId: string;
  stepId: string;
  tool: AllowedTaskTool;
  status: 'executed' | 'awaiting_confirmation' | 'permission_missing' | 'blocked' | 'failed';
  honestSpokenReply: string;
}

const FORBIDDEN_SHELL_PATTERNS = [
  /\b(?:rm\s+-rf|sudo|chmod|chown|mkfs|dd\s+if=|curl\s+.*\|\s*sh|wget\s+.*\|\s*sh|bash\s+-c|sh\s+-c|su\s+-c|eval\()/i,
  /(?:javascript:|new\s+Function\s*\(|file:\/\/\/etc\/|\/system\/bin\/)/i,
];

export function isToolAllowed(tool: string): tool is AllowedTaskTool {
  return ALLOWED_TASK_TOOLS.has(tool as AllowedTaskTool);
}

/**
 * Splits a multi-step Bengali/Hindi/English voice utterance into structured, allowlisted task steps.
 */
export function buildStructuredTaskPlan(rawInput: string): TaskPlan {
  const cleaned = (rawInput || '').trim();
  const planId = `plan_${Date.now()}`;

  if (!cleaned) {
    return { planId, rawInput, steps: [], requiresConfirmation: false };
  }

  for (const pattern of FORBIDDEN_SHELL_PATTERNS) {
    if (pattern.test(cleaned)) {
      return {
        planId,
        rawInput,
        steps: [],
        requiresConfirmation: false,
        blockedReason: 'Arbitrary shell commands or unsafe execution payloads are strictly blocked by Zoni AI security policy.',
      };
    }
  }

  // Do not split WhatsApp/SMS messages that contain "এবং" / "then" inside the message body
  const looksLikeMessaging =
    /(?:whats\s*app|হোয়াটসঅ্যাপ|হোয়াটসঅ্যাপ|व्हाट्सएप|\bsms\b|এসএমএস|এস\.এম\.এস|एसएमएस|মেসেজ\s*(?:পাঠাও|পাঠিয়ে\s*দাও|পাঠিয়ে\s*দাও|করো|লিখে\s*দাও)|मैसेज\s*(?:भेजो|भेज\s*दो|लिखो)|message\s+(?:to|saying))/i.test(
      cleaned
    );

  const segments = looksLikeMessaging
    ? [cleaned]
    : cleaned
        .split(/\s+(?:and\s+then|then|এবং|তারপর|और\s+फिर)\s+/i)
        .map((s) => s.trim())
        .filter(Boolean);

  const steps: TaskStep[] = [];
  let idx = 1;

  for (const segment of segments) {
    const step = parseSingleSegmentToStep(segment, `step_${idx}`);
    if (step) {
      steps.push(step);
      idx += 1;
    }
  }

  return {
    planId,
    rawInput,
    steps,
    requiresConfirmation: steps.some((s) => s.requiresUserConfirmation),
  };
}

function stripWakePrefix(text: string): string {
  return text
    .replace(
      /^(?:hey\s+|hi\s+|ok\s+|okay\s+|hello\s+|ওহে\s+|হ্যালো\s+|হেই\s+|हे\s+|ओए\s+)?(?:zoni(?:\s+ai)?|জোনি(?:\s+এআই)?|জোনী(?:\s+এআই)?|জনি(?:\s+এআই)?|ज़ोनी(?:\s+एआई)?|जोनी(?:\s+एआई)?)\s*[,:\-!।]?\s*/i,
      ''
    )
    .trim();
}

function stripTrailingPunctuation(text: string): string {
  return text.replace(/[।.!?]+$/g, '').trim();
}

function normalizeRelationName(raw: string): string {
  let clean = raw
    .trim()
    .replace(/^(?:আমার|একটু|দয়া\s*করে|দয়া\s*করে|প্লিজ|my|please|मेरे|मेरी|मेरा)\s+/i, '')
    .replace(/^(?:কে|কো)\s+/i, '')
    .replace(/(?:'s|’s)$/i, '')
    .replace(/\s+(?:का|की|के)$/i, '')
    .trim();

  if (clean === 'মায়ের' || clean === 'মায়ের' || clean === 'মাকে') return 'মা';
  if (clean === 'বাবার' || clean === 'বাবাকে') return 'বাবা';
  if (clean.endsWith('ের') && clean.length > 3) {
    clean = clean.slice(0, -2);
  } else if ((clean.endsWith('য়ের') || clean.endsWith('য়ের')) && clean.length > 4) {
    clean = clean.slice(0, -3);
  } else if (clean.endsWith('ার') && clean.length > 4) {
    clean = clean.slice(0, -1);
  } else if (clean.endsWith('কে') && clean.length > 3) {
    clean = clean.replace(/(?:-?কে|কে)$/i, '');
  }
  return clean.trim();
}

function parseMultilingualOrdinal(text: string): number | null {
  const lower = text.toLowerCase();
  if (/(?:প্রথম|পহেলা|1st|\bfirst\b|पहला|पहले|प्रथम)/i.test(lower)) return 1;
  if (/(?:দ্বিতীয়|দ্বিতীয়|2nd|\bsecond\b|दूसरा|दूसरे|दूसरी)/i.test(lower)) return 2;
  if (/(?:তৃতীয়|তৃতীয়|3rd|\bthird\b|तीसरा|तीसरे)/i.test(lower)) return 3;
  if (/(?:চতুর্থ|4th|\bfourth\b|चौथा|चौथे)/i.test(lower)) return 4;
  if (/(?:পঞ্চম|5th|\bfifth\b|पांचवा|पाँचवाँ)/i.test(lower)) return 5;
  return null;
}

function normalizeAppQueryTarget(raw: string): string {
  let clean = raw
    .trim()
    .replace(/^(?:আমার\s+ফোনে\s+থাকা|আমার\s+মোবাইলে\s+থাকা|ফোনে\s+থাকা|মোবাইলে\s+থাকা|আমার|একটু|প্লিজ|দয়া\s*করে|দয়া\s*করে)\s+/i, '')
    .replace(/^(?:mere\s+phone\s+mein|mere\s+phone\s+ka|मेरे\s+फ़ोन\s+में|मेरे\s+फोन\s+में|मेरा|मेरी|प्लीज|ज़रा)\s+/i, '')
    .replace(/^(?:please\s+|can\s+you\s+|could\s+you\s+)?(?:the\s+|my\s+)?/i, '')
    .replace(/\s+(?:for\s+me|please|app|application|অ্যাপটা|অ্যাপটি|অ্যাপ|ऐप)$/i, '')
    .trim();

  // Strip Bengali definite clitics on app names: "ফেসবুকটা" -> "ফেসবুক", "ইউটিউবটা" -> "ইউটিউব", "ক্রোমটা" -> "ক্রোম"
  if (/(?:টা|টি)$/.test(clean) && clean.length > 3) {
    clean = clean.replace(/(?:টা|টি)$/, '').trim();
  }
  return clean;
}

function normalizeSupportedChatAppName(raw: string): string | null {
  const lower = raw.trim().toLowerCase();
  if (/^(?:telegram|টেলিগ্রাম|টেলিগ্রামে|टेलीग्राम)$/.test(lower)) return 'Telegram';
  if (/^(?:instagram|ইনস্টাগ্রাম|ইন্সটাগ্রাম|ইনস্টাগ্রামে|इंस्टाग्राम|insta)$/.test(lower)) return 'Instagram';
  if (/^(?:messenger|মেসেঞ্জার|মেসেঞ্জারে|मैसेंजर)$/.test(lower)) return 'Messenger';
  return null;
}

function parseSingleSegmentToStep(rawSegment: string, stepId: string): TaskStep | null {
  const withoutWake = stripWakePrefix(rawSegment);
  const segment = stripTrailingPunctuation(withoutWake);
  if (!segment) return null;
  const lower = segment.toLowerCase();

  // 0. Cancel Current Task / Pending Draft ("এখন আগের কাজটা বন্ধ করো", "বর্তমান কাজ Cancel করো", "cancel current task")
  if (
    /(?:আগের\s*কাজ(?:টা)?\s*বন্ধ\s*করো|বর্তমান\s*কাজ\s*(?:cancel|বাতিল|বন্ধ)\s*করো|কাজ(?:টা)?\s*(?:বাতিল|বন্ধ)\s*করো|ড্রাফট\s*বাতিল\s*করো|cancel\s+(?:current\s+|pending\s+)?(?:task|action|draft)|stop\s+(?:current\s+)?task|पिछला\s*काम\s*बंद\s*करो|काम\s*रद्द\s*करो)/i.test(
      segment
    )
  ) {
    return {
      stepId,
      tool: 'cancel_current_task',
      args: {},
      requiredPermissions: [],
      requiresUserConfirmation: false,
      honestOutcomeNote: 'Cancels the active task or pending communication draft safely.',
    };
  }

  // 0a-call. Strict Incoming & Active Phone Call Control (requires explicit call-control phrase)
  if (
    /^(?:please\s+)?(?:receive|answer|accept|pick\s*up)\s+(?:the\s+|this\s+|my\s+|incoming\s+)?(?:phone\s+)?call$/i.test(
      segment
    ) ||
    /^(?:ইনকামিং\s+)?(?:কলটা|কল|ফোনটা|ফোন)\s*(?:রিসিভ\s*করো|ধরো|ধরে\s*নাও|তুলো|উঠাও|অ্যাকসেপ্ট\s*করো)$/i.test(
      segment
    ) ||
    /^(?:इनकमिंग\s+)?(?:कॉल|फ़ोन|फोन)\s*(?:उठाओ|रिसीव\s*करो|पिक\s*करो|अटेंड\s*करो)$/i.test(
      segment
    )
  ) {
    return {
      stepId,
      tool: 'answer_incoming_call',
      args: {},
      requiredPermissions: ['READ_PHONE_STATE', 'ANSWER_PHONE_CALLS'],
      requiresUserConfirmation: false,
      honestOutcomeNote: 'Verifies ringing call state and answers via supported Android Telecom APIs.',
    };
  }

  if (
    /^(?:please\s+)?(?:reject|decline|dismiss|ignore)\s+(?:the\s+|this\s+|my\s+|incoming\s+)?(?:phone\s+)?call$/i.test(
      segment
    ) ||
    /^(?:ইনকামিং\s+)?(?:কলটা|কল|ফোনটা|ফোন)\s*(?:রিজেক্ট\s*করো|বাতিল\s*করো|না\s*ধরে\s*কাটো)$/i.test(
      segment
    ) ||
    /^ইনকামিং\s+(?:কলটা|কল|ফোনটা|ফোন)\s*কেটে\s*দাও$/i.test(segment) ||
    /^(?:इनकमिंग\s+)?(?:कॉल|फ़ोन|फोन)\s*(?:रिजेक्ट\s*करो|डिक्लाइन\s*करो|अस्वीकार\s*करो)$/i.test(
      segment
    ) ||
    /^इनकमिंग\s+(?:कॉल|फ़ोन|फोन)\s*(?:काट\s*दो|काटो)$/i.test(segment)
  ) {
    return {
      stepId,
      tool: 'reject_incoming_call',
      args: {},
      requiredPermissions: ['READ_PHONE_STATE', 'ANSWER_PHONE_CALLS'],
      requiresUserConfirmation: false,
      honestOutcomeNote: 'Verifies ringing call state and rejects via supported Android Telecom APIs.',
    };
  }

  if (
    /^(?:please\s+)?(?:end|disconnect|cut|terminate|stop)\s+(?:the\s+|this\s+|my\s+|active\s+|current\s+)?(?:phone\s+)?call$/i.test(
      segment
    ) ||
    /^(?:please\s+)?hang\s*up(?:\s+(?:the\s+)?call)?$/i.test(segment) ||
    /^(?:চলমান\s+)?(?:কলটা|কল|ফোনটা|ফোন)\s*(?:কেটে\s*দাও|বন্ধ\s*করো|শেষ\s*করো|ডিসকানেক্ট\s*করো|রেখে\s*দাও)$/i.test(
      segment
    ) ||
    /^(?:कॉल|फ़ोन|फोन)\s*(?:काटो|काट\s*दो|बंद\s*करो|खत्म\s*करो|डिस्कनेक्ट\s*करो)$/i.test(
      segment
    )
  ) {
    return {
      stepId,
      tool: 'end_active_call',
      args: {},
      requiredPermissions: ['READ_PHONE_STATE', 'ANSWER_PHONE_CALLS'],
      requiresUserConfirmation: false,
      honestOutcomeNote: 'Verifies active call state and ends the call via supported Android Telecom APIs.',
    };
  }

  // 0a. Explicit Voice/Text Approval of a Pending Draft ("এখন পাঠানোর অনুমতি দিলাম", "approve and send")
  if (
    /(?:এখন\s*পাঠানোর\s*অনুমতি\s*দিলাম|পাঠানোর\s*অনুমতি\s*দিলাম|অনুমতি\s*দিলাম|অনুমোদন\s*দিলাম|এখন\s*পাঠাও|approve\s+and\s+send|confirm\s+and\s+send|i\s+approve\s+(?:sending|this)|send\s+the\s+draft\s+now|भेजने\s*की\s*अनुमति\s*देता\s*हूँ|भेजने\s*की\s*अनुमति\s*दी)/i.test(
      segment
    )
  ) {
    return {
      stepId,
      tool: 'approve_pending_action',
      args: {},
      requiredPermissions: [],
      requiresUserConfirmation: false,
      honestOutcomeNote: 'Executes the user-reviewed pending communication draft after explicit approval.',
    };
  }

  // 0b. Explicit Draft Review Request ("মেসেজটা পাঠানোর আগে আমাকে দেখাও", "show draft before sending")
  if (
    /(?:মেসেজটা\s*পাঠানোর\s*আগে\s*(?:আমাকে\s*)?দেখাও|পাঠানোর\s*আগে\s*(?:আমাকে\s*)?দেখাও|ড্রাফট\s*দেখাও|মেসেজটা\s*দেখাও|show\s+(?:me\s+)?(?:the\s+)?(?:draft|message)\s*(?:before\s+sending)?|review\s+(?:the\s+)?(?:draft|message)|मैसेज\s*भेजने\s*से\s*पहले\s*दिखाओ)/i.test(
      segment
    )
  ) {
    return {
      stepId,
      tool: 'review_pending_draft',
      args: {},
      requiredPermissions: [],
      requiresUserConfirmation: false,
      honestOutcomeNote: 'Displays the pending draft message for user review and editing.',
    };
  }

  // 0c. List Installed Apps ("ইনস্টলড অ্যাপ দেখাও", "list installed apps")
  if (
    /(?:list\s+(?:all\s+)?installed\s+apps|show\s+(?:my\s+)?installed\s+apps|what\s+apps\s+are\s+installed|ইনস্টল(?:ড|্ড)?\s*অ্যাপ\s*(?:দেখাও|বলো|তালিকা)|কোন\s*কোন\s*অ্যাপ\s*(?:আছে|ইনস্টল)|इंस्टॉल\s*ऐप\s*(?:दिखाओ|बताओ))/i.test(
      segment
    )
  ) {
    return {
      stepId,
      tool: 'list_installed_apps',
      args: {},
      requiredPermissions: [],
      requiresUserConfirmation: false,
      honestOutcomeNote: 'Lists installed launchable Android apps via PackageManager.',
    };
  }

  // 0d. Smart Verified App Search Workflow ("ইউটিউবে গান খুঁজে দাও", "search songs on YouTube", "यूट्यूब पर गाने खोजो")
  const ytSearchBn = segment.match(
    /^(?:ইউটিউবে|ইউটিউব-এ|youtube-?এ|youtube\s*এ)\s+(.+?)\s*(?:খুঁজে\s*দাও|খুঁজো|সার্চ\s*করো|চালাও|দেখাও)$/i
  );
  if (ytSearchBn && ytSearchBn[1]) {
    return {
      stepId,
      tool: 'app_search_workflow',
      args: { appQuery: 'YouTube', searchQuery: ytSearchBn[1].trim() },
      requiredPermissions: ['ACCESSIBILITY_SERVICE'],
      requiresUserConfirmation: false,
      honestOutcomeNote: 'Opens YouTube and runs a verified Accessibility search workflow.',
    };
  }
  const ytSearchEn = segment.match(
    /^(?:search|find|play)\s+(?:for\s+)?(.+?)\s+(?:on|in)\s+(youtube|chrome|spotify|instagram|maps)$/i
  );
  if (ytSearchEn && ytSearchEn[1] && ytSearchEn[2]) {
    return {
      stepId,
      tool: 'app_search_workflow',
      args: { appQuery: ytSearchEn[2].trim(), searchQuery: ytSearchEn[1].trim() },
      requiredPermissions: ['ACCESSIBILITY_SERVICE'],
      requiresUserConfirmation: false,
      honestOutcomeNote: `Opens ${ytSearchEn[2].trim()} and runs a verified Accessibility search workflow.`,
    };
  }
  const ytSearchHi = segment.match(
    /^(?:यूट्यूब|youtube)\s*(?:पर|में)\s+(.+?)\s*(?:खोजो|सर्च\s*करो|ढूंढो|चलाओ)$/i
  );
  if (ytSearchHi && ytSearchHi[1]) {
    return {
      stepId,
      tool: 'app_search_workflow',
      args: { appQuery: 'YouTube', searchQuery: ytSearchHi[1].trim() },
      requiredPermissions: ['ACCESSIBILITY_SERVICE'],
      requiresUserConfirmation: false,
      honestOutcomeNote: 'Opens YouTube and runs a verified Accessibility search workflow.',
    };
  }

  // 1. Screen Understanding ("এই স্ক্রিনে কী আছে পড়ে শোনাও", "what is on my screen", "read this page", "স্ক্রিনে কী আছে", "स्क्रीन पर क्या है")
  if (
    /(?:what(?:'s|\s+is)\s+on\s+(?:my\s+|this\s+)?screen|read\s+(?:this\s+|my\s+)?(?:screen|page)|explain\s+(?:this\s+)?(?:screen|page)|summarize\s+(?:this\s+)?(?:screen|page)|(?:এই\s*)?স্ক্রিনে\s*কী\s*আছে(?:\s*পড়ে\s*শোনাও|\s*পড়ে\s*শোনাও)?|স্ক্রিন\s*(?:পড়ে\s*শোনাও|পড়ে\s*শোনাও|পড়ো|পড়ো|বোঝাও|দেখো)|এই\s*পেজটা\s*(?:পড়ো|পড়ো|বোঝাও)|स्क्रीन\s*पर\s*क्या\s*है|स्क्रीन\s*(?:पढ़कर\s*सुनाओ|पढ़ो|समझाओ))/i.test(
      segment
    )
  ) {
    return {
      stepId,
      tool: 'screen_analyze',
      args: { question: segment },
      requiredPermissions: ['ACCESSIBILITY_SERVICE'],
      requiresUserConfirmation: false,
      honestOutcomeNote: 'Reads non-sensitive visible text on the current screen via Accessibility or MediaProjection.',
    };
  }

  // 2. Notification Reading ("read my notifications", "new WhatsApp messages", "আমার নোটিফিকেশন পড়ো", "मेरा नोटिफिकेशन पढ़ो")
  if (
    /(?:read\s+(?:my\s+)?(?:latest\s+|recent\s+|new\s+)?notifications?|check\s+(?:my\s+)?notifications?|any\s+new\s+(?:whatsapp\s+)?messages?|নোটিফিকেশন\s*(?:পড়ে\s*শোনাও|পড়ো|পড়ো|দেখাও|বলো)|নতুন\s*(?:মেসেজ|নোটিফিকেশন)|नोटिफिकेशन\s*(?:पढ़ो|बताओ|चेक))/i.test(
      segment
    )
  ) {
    return {
      stepId,
      tool: 'notification_read',
      args: { whatsappOnly: /whatsapp|হোয়াটসঅ্যাপ|হোয়াটসঅ্যাপ|व्हाट्सएप/i.test(segment) },
      requiredPermissions: ['NOTIFICATION_LISTENER'],
      requiresUserConfirmation: false,
      honestOutcomeNote: 'Reads recent local non-sensitive Android notifications captured via NotificationListenerService.',
    };
  }

  // 2b. Advanced YouTube Click Engine (Bengali / English / Hindi)
  // Play button: "Play Button চাপো", "Click the Play button", "প্লে বাটন চাপো"
  // YouTube Pause / Stop / Play playback controls ("ভিডিওটি Pause করো", "Pause the video", "ভিডিওটি Stop করো", "ভিডিওটি Play করো")
  if (
    /(?:\bpause\b|পজ|বিরতি|पॉज़|रोकें)/i.test(segment) &&
    /(?:video|ভিডিও|वीडियो|playback|প্লেব্যাক|button|বাটন|করো|करो|the)/i.test(segment)
  ) {
    return {
      stepId,
      tool: 'click_youtube_video',
      args: { target: 'pause_video' },
      requiredPermissions: ['ACCESSIBILITY_SERVICE'],
      requiresUserConfirmation: false,
      honestOutcomeNote: 'Pauses the visible YouTube video via Accessibility and verifies player state.',
    };
  }

  if (
    /(?:\bstop\b|স্টপ|বন্ধ\s*করো|बंद\s*करो)/i.test(segment) &&
    /(?:video|ভিডিও|वीडियो|playback|প্লেব্যাক)/i.test(segment)
  ) {
    return {
      stepId,
      tool: 'click_youtube_video',
      args: { target: 'stop_video' },
      requiredPermissions: ['ACCESSIBILITY_SERVICE'],
      requiresUserConfirmation: false,
      honestOutcomeNote: 'Stops/pauses the visible YouTube video via Accessibility and verifies player state.',
    };
  }

  if (
    /(?:play\s*button|প্লে\s*বাটন|प्ले\s*बटन)/i.test(segment) &&
    /(?:click|tap|press|চাপো|ক্লিক|ট্যাপ|दबाओ|क्लिक)/i.test(segment)
  ) {
    return {
      stepId,
      tool: 'click_youtube_video',
      args: { target: 'play_button' },
      requiredPermissions: ['ACCESSIBILITY_SERVICE'],
      requiresUserConfirmation: false,
      honestOutcomeNote: 'Clicks the visible YouTube Play button via Accessibility and verifies playback.',
    };
  }

  if (
    /^(?:play|resume)\s+(?:the\s+|this\s+)?video$|^ভিডিও(?:টি|টা)?\s*(?:(?:play|প্লে|রিজিউম)\s*করো|আবার\s*চালাও)$|^वीडियो\s*(?:प्ले|चलाओ|फिर\s*से\s*चलाओ)(?:\s*करो)?$/i.test(
      segment
    )
  ) {
    return {
      stepId,
      tool: 'click_youtube_video',
      args: { target: 'play_video' },
      requiredPermissions: ['ACCESSIBILITY_SERVICE'],
      requiresUserConfirmation: false,
      honestOutcomeNote: 'Plays/resumes the visible YouTube video via Accessibility and verifies playback.',
    };
  }

  // Thumbnail click: "এই ভিডিওর Thumbnail-এ ক্লিক করো", "Click this video's thumbnail"
  if (
    /(?:thumbnail|থাম্বনেইল|थंबनेल)/i.test(segment) &&
    /(?:click|tap|open|ক্লিক|ট্যাপ|খোলো|ওপেন|क्लिक)/i.test(segment)
  ) {
    return {
      stepId,
      tool: 'click_youtube_video',
      args: { index: parseMultilingualOrdinal(segment) ?? 1, target: 'thumbnail' },
      requiredPermissions: ['ACCESSIBILITY_SERVICE'],
      requiresUserConfirmation: false,
      honestOutcomeNote: 'Clicks the visible YouTube video thumbnail via semantic bounds and verifies watch screen opens.',
    };
  }

  // Search Result click: "প্রথম সার্চ রেজাল্টে ক্লিক করো", "Open the first search result"
  if (
    /(?:search\s*result|সার্চ\s*রেজাল্ট|सर्च\s*रिजल्ट|सर्च\s*परिणाम)/i.test(segment) &&
    /(?:click|tap|open|play|ক্লিক|ওপেন|খোলো|চালাও|क्लिक|खोलो)/i.test(segment)
  ) {
    return {
      stepId,
      tool: 'click_youtube_search_result',
      args: { index: parseMultilingualOrdinal(segment) ?? 1 },
      requiredPermissions: ['ACCESSIBILITY_SERVICE'],
      requiresUserConfirmation: false,
      honestOutcomeNote: 'Clicks the requested visible YouTube search result and verifies the video opens.',
    };
  }

  // Ordinal / current YouTube video click: "প্রথম ভিডিওটি চালাও", "দ্বিতীয় ভিডিওতে ক্লিক করো", "এই ভিডিওটা ওপেন করো",
  // "Play the first video", "Click the second video", "Open this video",
  // "पहला वीडियो चलाओ", "दूसरे वीडियो पर क्लिक करो", "इस वीडियो को खोलो"
  if (
    /(?:video|ভিডিও|वीडियो)/i.test(segment) &&
    /(?:play|click|tap|open|select|চালাও|ক্লিক|ট্যাপ|ওপেন|খোলো|चलाओ|क्लिक|खोलो)/i.test(segment)
  ) {
    const ord = parseMultilingualOrdinal(segment);
    if (ord !== null) {
      return {
        stepId,
        tool: 'click_youtube_video',
        args: { index: ord, target: `video_${ord}` },
        requiredPermissions: ['ACCESSIBILITY_SERVICE'],
        requiresUserConfirmation: false,
        honestOutcomeNote: `Clicks visible YouTube video #${ord} via semantic node discovery and verifies watch screen opens.`,
      };
    }
    if (/(?:এই\s*ভিডিও|this\s+video|current\s+video|इस\s*वीडियो)/i.test(segment)) {
      return {
        stepId,
        tool: 'click_youtube_video',
        args: { index: 1, target: 'current_video' },
        requiredPermissions: ['ACCESSIBILITY_SERVICE'],
        requiresUserConfirmation: false,
        honestOutcomeNote: 'Clicks the visible YouTube video on screen and verifies the watch player opens.',
      };
    }
  }

  // 2c. WhatsApp Smart Contact & Chat Name Click Engine (Bengali / English / Hindi)
  const hasWaContactContext =
    /(?:whatsapp|হোয়াটসঅ্যাপ|হোয়াটসঅ্যাপ|व्हाट्सएप|chat|চ্যাট|चैट|contact|কন্টাক্ট|कॉन्टैक्ट|নামের\s*উপর|নামটিতে)/i.test(
      segment
    );
  const isFullMessageSend =
    /(?:মেসেজ\s*(?:পাঠাও|পাঠিয়ে|পাঠিয়ে|করো|লিখে)|message\s+(?:to|saying)|मैसेज\s*(?:भेजो|भेज\s*दो|लिखो))/i.test(
      segment
    );

  if (hasWaContactContext && !isFullMessageSend) {
    // Type-only WhatsApp message ("WhatsApp-এ শুধু টাইপ করো: ...", "Type in WhatsApp: ...", "WhatsApp में टाइप करो: ...") -> NEVER auto-sends!
    const typeOnlyMatch = segment.match(
      /^(?:(?:whatsapp|হোয়াটসঅ্যাপ|হোয়াটসঅ্যাপ|व्हाट्सएप)(?:-?এ|\s*এ|\s*में)?\s+)?(?:শুধু\s*)?(?:type(?:\s+in\s+whatsapp)?|টাইপ\s*করো|লিখে\s*রাখো|टाइप\s*करो)\s*[:,-]?\s*(.+)$/i
    );
    if (typeOnlyMatch && typeOnlyMatch[1]) {
      return {
        stepId,
        tool: 'type_whatsapp_message',
        args: { message: typeOnlyMatch[1].trim() },
        requiredPermissions: ['ACCESSIBILITY_SERVICE'],
        requiresUserConfirmation: false,
        honestOutcomeNote: 'Types the exact message into WhatsApp composer without clicking Send.',
      };
    }

    // Ordinal contact/chat click ("নিচের দ্বিতীয় নামটিতে ক্লিক করো", "প্রথম Chat ওপেন করো", "Click the second contact", "Open the first chat", "दूसरा चैट खोलो")
    const ord = parseMultilingualOrdinal(segment);
    if (ord !== null && /(?:chat|চ্যাট|चैट|contact|কন্টাক্ট|নাম|name)/i.test(segment)) {
      const isChat = /(?:chat|চ্যাট|चैट)/i.test(segment);
      return {
        stepId,
        tool: isChat ? 'open_whatsapp_chat' : 'click_whatsapp_contact',
        args: { index: ord },
        requiredPermissions: ['ACCESSIBILITY_SERVICE'],
        requiresUserConfirmation: false,
        honestOutcomeNote: `Clicks visible WhatsApp ${isChat ? 'chat' : 'contact'} #${ord} and verifies the conversation opens.`,
      };
    }

    // Bengali: "WhatsApp-এ রাহুলের নামের উপর ক্লিক করো" / "এই Contact-এর নামের উপর ক্লিক করো"
    const bnClickName = segment.match(
      /^(?:(?:whatsapp|হোয়াটসঅ্যাপ|হোয়াটসঅ্যাপ)(?:-?এ|\s*এ)\s+)?(.+?)\s*(?:নামের\s*উপর|নামটিতে|নামে)\s*(?:ক্লিক\s*করো|ট্যাপ\s*করো|চাপো)$/i
    );
    if (bnClickName && bnClickName[1]) {
      const rawPerson = bnClickName[1].trim();
      if (/^(?:এই\s*)?(?:contact|কন্টাক্ট)(?:-?এর)?$/i.test(rawPerson)) {
        return {
          stepId,
          tool: 'click_whatsapp_contact',
          args: { index: 1 },
          requiredPermissions: ['ACCESSIBILITY_SERVICE'],
          requiresUserConfirmation: false,
          honestOutcomeNote: 'Clicks the visible WhatsApp contact name and verifies the conversation opens.',
        };
      }
      const contactName = normalizeRelationName(rawPerson);
      if (contactName) {
        return {
          stepId,
          tool: 'click_whatsapp_contact',
          args: { contactName },
          requiredPermissions: ['ACCESSIBILITY_SERVICE'],
          requiresUserConfirmation: false,
          honestOutcomeNote: `Clicks "${contactName}" in WhatsApp and verifies the conversation opens.`,
        };
      }
    }

    // Bengali: "মায়ের Chat ওপেন করো" / "জাহিদার Chat খুলে দাও"
    const bnOpenChat = segment.match(
      /^(?:(?:whatsapp|হোয়াটসঅ্যাপ|হোয়াটসঅ্যাপ)(?:-?এ|\s*এ)\s+)?(.+?)\s*(?:chat|চ্যাট)\s*(?:ওপেন\s*করো|খুলে\s*দাও|খোলো)$/i
    );
    if (bnOpenChat && bnOpenChat[1]) {
      const contactName = normalizeRelationName(bnOpenChat[1]);
      if (contactName) {
        return {
          stepId,
          tool: 'open_whatsapp_chat',
          args: { contactName },
          requiredPermissions: ['ACCESSIBILITY_SERVICE'],
          requiresUserConfirmation: false,
          honestOutcomeNote: `Opens "${contactName}"'s WhatsApp chat and verifies the conversation header.`,
        };
      }
    }

    // Bengali: "WhatsApp-এ বাবাকে খুঁজে বের করো"
    const bnFindWa = segment.match(
      /^(?:whatsapp|হোয়াটসঅ্যাপ|হোয়াটসঅ্যাপ)(?:-?এ|\s*এ)\s+(.+?)\s*(?:খুঁজে\s*বের\s*করো|খুঁজে\s*দাও|খুঁজো)$/i
    );
    if (bnFindWa && bnFindWa[1]) {
      const contactName = normalizeRelationName(bnFindWa[1]);
      if (contactName) {
        return {
          stepId,
          tool: 'click_whatsapp_contact',
          args: { contactName, searchIfMissing: true },
          requiredPermissions: ['ACCESSIBILITY_SERVICE'],
          requiresUserConfirmation: false,
          honestOutcomeNote: `Finds and clicks "${contactName}" inside WhatsApp.`,
        };
      }
    }

    // English: "Click Rahul's name in WhatsApp", "Open my mother's chat", "Find this contact in WhatsApp"
    const enClickName = segment.match(
      /^(?:click|tap|open)\s+(?:on\s+)?(.+?)(?:'s|’s)?\s+(?:name|contact)(?:\s+in\s+whatsapp)?$/i
    );
    if (enClickName && enClickName[1]) {
      const rawPerson = enClickName[1].trim();
      if (/^this$/i.test(rawPerson)) {
        return {
          stepId,
          tool: 'click_whatsapp_contact',
          args: { index: 1 },
          requiredPermissions: ['ACCESSIBILITY_SERVICE'],
          requiresUserConfirmation: false,
          honestOutcomeNote: 'Clicks the visible contact in WhatsApp.',
        };
      }
      const contactName = normalizeRelationName(rawPerson);
      if (contactName) {
        return {
          stepId,
          tool: 'click_whatsapp_contact',
          args: { contactName },
          requiredPermissions: ['ACCESSIBILITY_SERVICE'],
          requiresUserConfirmation: false,
          honestOutcomeNote: `Clicks "${contactName}" in WhatsApp and verifies the conversation opens.`,
        };
      }
    }

    const enOpenChat = segment.match(
      /^(?:open|show)\s+(?:my\s+)?(.+?)(?:'s|’s)?\s+chat(?:\s+in\s+whatsapp)?$/i
    );
    if (enOpenChat && enOpenChat[1]) {
      const contactName = normalizeRelationName(enOpenChat[1]);
      if (contactName) {
        return {
          stepId,
          tool: 'open_whatsapp_chat',
          args: { contactName },
          requiredPermissions: ['ACCESSIBILITY_SERVICE'],
          requiresUserConfirmation: false,
          honestOutcomeNote: `Opens "${contactName}"'s WhatsApp chat.`,
        };
      }
    }

    const enFindContact = segment.match(/^(?:find|search)\s+(?:for\s+)?(.+?)\s+in\s+whatsapp$/i);
    if (enFindContact && enFindContact[1]) {
      const rawPerson = enFindContact[1].trim();
      const isGenericThis = /^(?:this\s+)?contact$/i.test(rawPerson);
      const contactName = isGenericThis ? '' : normalizeRelationName(rawPerson);
      return {
        stepId,
        tool: 'click_whatsapp_contact',
        args: isGenericThis ? { index: 1 } : { contactName, searchIfMissing: true },
        requiredPermissions: ['ACCESSIBILITY_SERVICE'],
        requiresUserConfirmation: false,
        honestOutcomeNote: `Finds and clicks ${contactName || 'the visible contact'} in WhatsApp.`,
      };
    }

    // Hindi: "WhatsApp में राहुल के नाम पर क्लिक करो" / "मेरी माँ की चैट खोलो"
    const hiClickName = segment.match(
      /^(?:(?:whatsapp|व्हाट्सएप)\s*में\s+)?(.+?)\s*(?:के\s*नाम\s*पर|नाम\s*पर)\s*(?:क्लिक\s*करो|टैप\s*करो)$/i
    );
    if (hiClickName && hiClickName[1]) {
      const contactName = normalizeRelationName(hiClickName[1]);
      if (contactName) {
        return {
          stepId,
          tool: 'click_whatsapp_contact',
          args: { contactName },
          requiredPermissions: ['ACCESSIBILITY_SERVICE'],
          requiresUserConfirmation: false,
          honestOutcomeNote: `Clicks "${contactName}" in WhatsApp.`,
        };
      }
    }

    const hiOpenChat = segment.match(
      /^(?:(?:whatsapp|व्हाट्सएप)\s*में\s+)?(.+?)\s*(?:की|का|के)?\s*(?:चैट|chat)\s*खोलो$/i
    );
    if (hiOpenChat && hiOpenChat[1]) {
      const contactName = normalizeRelationName(hiOpenChat[1]);
      if (contactName) {
        return {
          stepId,
          tool: 'open_whatsapp_chat',
          args: { contactName },
          requiredPermissions: ['ACCESSIBILITY_SERVICE'],
          requiresUserConfirmation: false,
          honestOutcomeNote: `Opens "${contactName}"'s WhatsApp chat.`,
        };
      }
    }
  }

  // 3. Accessibility Navigation & Touch ("scroll down", "scroll up", "swipe left", "swipe right", "go back", "go home", "tap <button>")
  if (/(?:scroll\s+down|swipe\s+down|নিচে\s*স্ক্রল\s*করো|নিচের\s*দিকে\s*স্ক্রল|নিচে\s*সোয়াইপ|নিচে\s*সোয়াইপ|नीचे\s*स्क्रॉल\s*करो)/i.test(segment)) {
    return {
      stepId,
      tool: 'accessibility_action',
      args: { command: 'scroll_down' },
      requiredPermissions: ['ACCESSIBILITY_SERVICE'],
      requiresUserConfirmation: false,
      honestOutcomeNote: 'Scrolls down on the active Android screen via AccessibilityService.',
    };
  }
  if (/(?:scroll\s+up|swipe\s+up|উপরে\s*স্ক্রল\s*করো|উপরের\s*দিকে\s*স্ক্রল|উপরে\s*সোয়াইপ|উপরে\s*সোয়াইপ|ऊपर\s*स्क्रॉल\s*करो)/i.test(segment)) {
    return {
      stepId,
      tool: 'accessibility_action',
      args: { command: 'scroll_up' },
      requiredPermissions: ['ACCESSIBILITY_SERVICE'],
      requiresUserConfirmation: false,
      honestOutcomeNote: 'Scrolls up on the active Android screen via AccessibilityService.',
    };
  }
  if (/(?:swipe\s+left|scroll\s+left|বামে\s*(?:সোয়াইপ|সোয়াইপ|স্ক্রল)\s*করো|বাম\s*দিকে\s*(?:সোয়াইপ|সোয়াইপ|স্ক্রল)|बाएं\s*(?:स्वाइप|स्क्रॉल)\s*करो)/i.test(segment)) {
    return {
      stepId,
      tool: 'accessibility_action',
      args: { command: 'scroll_left' },
      requiredPermissions: ['ACCESSIBILITY_SERVICE'],
      requiresUserConfirmation: false,
      honestOutcomeNote: 'Swipes left on the active Android screen via AccessibilityService.',
    };
  }
  if (/(?:swipe\s+right|scroll\s+right|ডানে\s*(?:সোয়াইপ|সোয়াইপ|স্ক্রল)\s*করো|ডান\s*দিকে\s*(?:সোয়াইপ|সোয়াইপ|স্ক্রল)|दाएं\s*(?:स्वाइप|स्क्रॉल)\s*करो)/i.test(segment)) {
    return {
      stepId,
      tool: 'accessibility_action',
      args: { command: 'scroll_right' },
      requiredPermissions: ['ACCESSIBILITY_SERVICE'],
      requiresUserConfirmation: false,
      honestOutcomeNote: 'Swipes right on the active Android screen via AccessibilityService.',
    };
  }
  if (/^(?:go\s+back|back\s+button|পেছনে\s*যাও|পিছনে\s*যাও|ব্যাক\s*করো|वापस\s*जाओ|बैक\s*करो)$/i.test(segment)) {
    return {
      stepId,
      tool: 'accessibility_action',
      args: { command: 'back' },
      requiredPermissions: ['ACCESSIBILITY_SERVICE'],
      requiresUserConfirmation: false,
      honestOutcomeNote: 'Performs Android global Back navigation via AccessibilityService.',
    };
  }
  if (/^(?:go\s+home|home\s+screen|হোম\s*স্ক্রিনে\s*যাও|হোমে\s*যাও|होम\s*स्क्रीन\s*पर\s*जाओ)$/i.test(segment)) {
    return {
      stepId,
      tool: 'accessibility_action',
      args: { command: 'home' },
      requiredPermissions: ['ACCESSIBILITY_SERVICE'],
      requiresUserConfirmation: false,
      honestOutcomeNote: 'Returns to Android Home screen via AccessibilityService.',
    };
  }
  const tapMatch = segment.match(/^(?:tap|click|press)\s+(?:on\s+)?(.+)$/i);
  if (tapMatch && tapMatch[1]) {
    const rawTarget = tapMatch[1].trim().replace(/\s+(?:on|in)\s+facebook$/i, '').trim();
    return {
      stepId,
      tool: 'accessibility_action',
      args: { command: `tap:${rawTarget}` },
      requiredPermissions: ['ACCESSIBILITY_SERVICE'],
      requiresUserConfirmation: false,
      honestOutcomeNote: `Attempts to tap "${rawTarget}" via Android AccessibilityService.`,
    };
  }

  // Visual image / photo open ("এই ছবিটা ওপেন করো", "open this image", "open this photo")
  const openImageMatch =
    segment.match(/^(?:open|view|show)\s+(?:this|the)\s+(image|photo|picture|thumbnail)$/i) ||
    segment.match(/^(?:এই\s*)?(ছবিটা|ছবিটি|ছবি|ফটোটা|ফটো|থাম্বনেইল)\s*(?:ওপেন\s*করো|খোলো|খুলে\s*দাও|দেখাও)$/i);
  if (openImageMatch && openImageMatch[1]) {
    const imgTarget = openImageMatch[1].trim();
    return {
      stepId,
      tool: 'accessibility_action',
      args: { command: `tap:${imgTarget}` },
      requiredPermissions: ['ACCESSIBILITY_SERVICE'],
      requiresUserConfirmation: false,
      honestOutcomeNote: `Attempts to open visible "${imgTarget}" via Accessibility or visual recognition.`,
    };
  }

  // Bengali & Hindi visible button/control click ("Facebook-এ Like বাটনে ক্লিক করো", "লাল বাটনে চাপ দাও", "ডান পাশের বাটনে ক্লিক করো")
  const bnTapMatch = segment.match(
    /^(?:(?:facebook|ফেসবুক|youtube|ইউটিউব)(?:-?এ|\s*এ)\s+)?(.+?)\s*(বাটনে|বাটনটিতে|বটনে|আইকনে|অপশনে)?\s*(?:ক্লিক\s*করো|ট্যাপ\s*করো|চাপ\s*দাও|চাপো|क्लिक\s*करो|टैप\s*करो|दबाओ)$/i
  );
  if (bnTapMatch && bnTapMatch[1]) {
    const rawTarget = bnTapMatch[1].trim().replace(/(?:-এ|-তে)$/, '').trim();
    const roleSuffix = (bnTapMatch[2] || '').trim();
    const isSpatialOrColor =
      /(?:লাল|নীল|সবুজ|হলুদ|কমলা|সাদা|কালো|ডান|বাম|উপরে|নিচে|মাঝখানে|right|left|top|bottom|red|blue|green)/i.test(
        rawTarget
      );
    let normalizedTarget = /^এই$/i.test(rawTarget) ? 'button' : rawTarget;
    if (isSpatialOrColor && roleSuffix) {
      const cleanRole = roleSuffix.replace(/(?:টিতে|ে)$/, '');
      normalizedTarget = `${normalizedTarget} ${cleanRole}`.trim();
    }
    return {
      stepId,
      tool: 'accessibility_action',
      args: { command: `tap:${normalizedTarget}` },
      requiredPermissions: ['ACCESSIBILITY_SERVICE'],
      requiresUserConfirmation: false,
      honestOutcomeNote: `Attempts to tap visible "${normalizedTarget}" control via Android AccessibilityService.`,
    };
  }

  // 4. Camera Launch ("open camera", "ক্যামেরা খোলো", "कैमरा खोलो")
  if (/(?:open\s+camera|launch\s+camera|ক্যামেরা\s*(?:খোলো|ওপেন\s*করো|চালু\s*করো)|कैमरा\s*खोलो)/i.test(segment)) {
    return {
      stepId,
      tool: 'camera_open',
      args: {},
      requiredPermissions: ['CAMERA'],
      requiresUserConfirmation: false,
      honestOutcomeNote: 'Opens the Android camera app.',
    };
  }

  // 5. Perfect Volume Controls (media / ring / alarm / call / notification + percentage + mute/unmute/max/status)
  if (
    /(?:\bvolume\b|\bsound\b|\bmute\s+phone\b|\bunmute\s+phone\b|ভলিউম|ভোলিউম|সাউন্ড|আওয়াজ|আওয়াজ|वॉल्यूम|आवाज़|आवाज|রিংটোন|ringtone|\bringer\b)/i.test(
      segment
    ) &&
    !/(?:settings|সেটিংস|सेटिंग्स)/i.test(segment)
  ) {
    const normalizedDigits = segment
      .replace(/[০-৯]/g, (d) => String(d.charCodeAt(0) - '০'.charCodeAt(0)))
      .replace(/[०-९]/g, (d) => String(d.charCodeAt(0) - '०'.charCodeAt(0)));

    let stream: 'media' | 'ring' | 'alarm' | 'call' | 'notification' = 'media';
    if (/(?:\bring\b|ringtone|\bringer\b|রিংটোন|রিং|रिंगटोन|रिंग)/i.test(normalizedDigits)) {
      stream = 'ring';
    } else if (/(?:\balarm\b|অ্যালার্ম|এলার্ম|अलार्म)/i.test(normalizedDigits)) {
      stream = 'alarm';
    } else if (/(?:call\s+volume|voice\s+call\s+volume|কলের\s*ভলিউম|কল\s*ভলিউম|कॉल\s*वॉल्यूम)/i.test(normalizedDigits)) {
      stream = 'call';
    } else if (/(?:notification\s+volume|নোটিফিকেশন\s*ভলিউম|नोटिफिकेशन\s*वॉल्यूम)/i.test(normalizedDigits)) {
      stream = 'notification';
    }

    // Exact percentage ("volume ৫০ শতাংশ করো", "set volume to 50%", "ring volume 80 percent", "वॉल्यूम 50 प्रतिशत करो")
    const pctMatch = normalizedDigits.match(
      /(?:set|করো|করে\s*দাও|দাও|करो|to|at|volume|ভলিউম|ভোলিউম|সাউন্ড|আওয়াজ|वॉल्यूम)\s*(?:the\s+|my\s+)?(?:(?:media|ring|ringtone|alarm|call|notification)\s+)?(?:volume\s+)?(?:to\s+|at\s+)?(\d{1,3})\s*(?:%|percent|শতাংশ|পার্সেন্ট|পারসেন্ট|प्रतिशत|पर्सेंट)?/i
    ) || normalizedDigits.match(/(\d{1,3})\s*(?:%|percent|শতাংশ|পার্সেন্ট|পারসেন্ট|प्रतिशत|पर्सेंट)/i);

    if (pctMatch && pctMatch[1]) {
      const clampedPercent = Math.max(0, Math.min(100, Number(pctMatch[1])));
      return {
        stepId,
        tool: 'volume_control',
        args: { action: 'set', percent: clampedPercent, stream },
        requiredPermissions: [],
        requiresUserConfirmation: false,
        honestOutcomeNote: `Sets Android ${stream} volume to ${clampedPercent}% and verifies resulting level.`,
      };
    }

    if (/(?:\bunmute\b|আনমিউট|সাউন্ড\s*অন\s*করো|সাউন্ড\s*চালু\s*করো|अनम्यूट)/i.test(normalizedDigits)) {
      return {
        stepId,
        tool: 'volume_control',
        args: { action: 'unmute', stream },
        requiredPermissions: [],
        requiresUserConfirmation: false,
        honestOutcomeNote: `Unmutes Android ${stream} volume.`,
      };
    }
    if (/(?:\bmute\b|silent|মিউট|সাউন্ড\s*বন্ধ\s*করো|আওয়াজ\s*বন্ধ\s*করো|म्यूट)/i.test(normalizedDigits)) {
      return {
        stepId,
        tool: 'volume_control',
        args: { action: 'mute', stream },
        requiredPermissions: [],
        requiresUserConfirmation: false,
        honestOutcomeNote: `Mutes Android ${stream} volume.`,
      };
    }
    if (/(?:\bmax\b|\bfull\b|maximum|সর্বোচ্চ|ফুল\s*করো|पूरा\s*बढ़ाओ|फुल\s*करो)/i.test(normalizedDigits)) {
      return {
        stepId,
        tool: 'volume_control',
        args: { action: 'max', stream },
        requiredPermissions: [],
        requiresUserConfirmation: false,
        honestOutcomeNote: `Sets Android ${stream} volume to maximum.`,
      };
    }
    if (/(?:\bup\b|increase|raise|louder|বাড়াও|বাড়াও|বেশি\s*করো|बढ़ाओ)/i.test(normalizedDigits)) {
      return {
        stepId,
        tool: 'volume_control',
        args: { action: 'up', stream },
        requiredPermissions: [],
        requiresUserConfirmation: false,
        honestOutcomeNote: `Increases Android ${stream} volume.`,
      };
    }
    if (/(?:\bdown\b|decrease|lower|quieter|কমাও|কম\s*করো|कम\s*करो)/i.test(normalizedDigits)) {
      return {
        stepId,
        tool: 'volume_control',
        args: { action: 'down', stream },
        requiredPermissions: [],
        requiresUserConfirmation: false,
        honestOutcomeNote: `Decreases Android ${stream} volume.`,
      };
    }
    if (/(?:status|check|what\s+is|কত\s*আছে|কত\s*শতাংশ|कितना\s*है)/i.test(normalizedDigits)) {
      return {
        stepId,
        tool: 'volume_control',
        args: { action: 'status', stream },
        requiredPermissions: [],
        requiresUserConfirmation: false,
        honestOutcomeNote: `Checks current Android ${stream} volume level.`,
      };
    }
  }

  // 6. Android System Settings ("ফোনের সেটিংস খোলো", "location settings", "notification settings", "accessibility settings")
  if (/(?:location\s+settings|লোকেশন\s*সেটিংস|लोकेशन\s*सेटिंग्स)/i.test(segment)) {
    return {
      stepId,
      tool: 'open_settings',
      args: { target: 'location' },
      requiredPermissions: [],
      requiresUserConfirmation: false,
      honestOutcomeNote: 'Opens Android Location Settings.',
    };
  }
  if (/(?:notification\s+settings|নোটিফিকেশন\s*সেটিংস|नोटिफिकेशन\s*सेटिंग्स)/i.test(segment)) {
    return {
      stepId,
      tool: 'open_settings',
      args: { target: 'notifications' },
      requiredPermissions: [],
      requiresUserConfirmation: false,
      honestOutcomeNote: 'Opens Android Notification Settings.',
    };
  }
  if (/(?:sound\s+settings|সাউন্ড\s*সেটিংস|साउंड\s*सेटिंग्स)/i.test(segment)) {
    return {
      stepId,
      tool: 'open_settings',
      args: { target: 'sound' },
      requiredPermissions: [],
      requiresUserConfirmation: false,
      honestOutcomeNote: 'Opens Android Sound Settings.',
    };
  }
  if (/(?:app(?:lication)?\s+settings|অ্যাপ\s*সেটিংস|ऐप\s*सेटिंग्स)/i.test(segment)) {
    return {
      stepId,
      tool: 'open_settings',
      args: { target: 'applications' },
      requiredPermissions: [],
      requiresUserConfirmation: false,
      honestOutcomeNote: 'Opens Android Application Settings.',
    };
  }
  if (/(?:network\s+settings|নেটওয়ার্ক\s*সেটিংস|नेटवर्क\s*सेटिंग्स)/i.test(segment)) {
    return {
      stepId,
      tool: 'open_settings',
      args: { target: 'network' },
      requiredPermissions: [],
      requiresUserConfirmation: false,
      honestOutcomeNote: 'Opens Android Network Settings.',
    };
  }
  if (/(?:accessibility\s+settings|অ্যাক্সেসিবিলিটি\s*সেটিংস|एक्सेसिबिलिटी\s*सेटिंग्स)/i.test(segment)) {
    return {
      stepId,
      tool: 'open_settings',
      args: { target: 'accessibility' },
      requiredPermissions: [],
      requiresUserConfirmation: false,
      honestOutcomeNote: 'Opens Android Accessibility Settings.',
    };
  }
  if (
    /^(?:(?:open|launch)\s+(?:phone\s+|system\s+|android\s+)?settings|(?:ফোনের\s+|অ্যান্ড্রয়েড\s+)?সেটিংস\s*(?:খোলো|ওপেন\s*করো)|(?:फ़ोन\s*की\s+|फोन\s*की\s+)?सेटिंग्स\s*खोलो)$/i.test(
      segment
    )
  ) {
    return {
      stepId,
      tool: 'open_settings',
      args: { target: 'main' },
      requiredPermissions: [],
      requiresUserConfirmation: false,
      honestOutcomeNote: 'Opens Android System Settings.',
    };
  }

  // 7a. Controlled Generic App Chat Workflow (Telegram, Instagram, Messenger — executes directly)
  const genericAppChatBn = segment.match(
    /^(?:টেলিগ্রামে|টেলিগ্রাম-এ|টেলিগ্রাম|telegram(?:-?এ|\s*এ)?|ইনস্টাগ্রামে|ইনস্টাগ্রাম-এ|ইনস্টাগ্রাম|instagram(?:-?এ|\s*এ)?|মেসেঞ্জারে|মেসেঞ্জার-এ|মেসেঞ্জার|messenger(?:-?এ|\s*এ)?)\s+(.+?)(?:কে|-\s*কে)\s*(?:একটা\s+|একটি\s+)?(?:মেসেজ\s*)?(?:পাঠাও|পাঠিয়ে\s*দাও|পাঠিয়ে\s*দাও|করো|দাও|বলো|লিখে\s*দাও|লেখো)(?:\s*[:,-]?\s*(.+))?$/i
  );
  if (genericAppChatBn && genericAppChatBn[1]) {
    const appToken = segment.split(/\s+/)[0].replace(/-?এ$/i, '');
    const appName = normalizeSupportedChatAppName(appToken);
    if (appName) {
      const recipient = normalizeRelationName(genericAppChatBn[1]);
      return {
        stepId,
        tool: 'app_chat_prepare',
        args: {
          appName,
          contactQuery: recipient,
          message: stripTrailingPunctuation(genericAppChatBn[2] || ''),
        },
        requiredPermissions: ['ACCESSIBILITY_SERVICE'],
        requiresUserConfirmation: false,
        honestOutcomeNote: `Executes ${appName} messaging directly using the verified Accessibility adapter.`,
      };
    }
  }

  const genericAppChatEn = segment.match(
    /^(?:please\s+)?send\s+(?:a\s+)?(telegram|instagram|messenger)\s+(?:dm\s+|chat\s+|message\s+)?to\s+([^:]+?)(?:\s+(?:saying|that|message)\s+(.+)|:\s*(.+))?$/i
  );
  if (genericAppChatEn && genericAppChatEn[1] && genericAppChatEn[2]) {
    const appName = normalizeSupportedChatAppName(genericAppChatEn[1]);
    if (appName) {
      const recipient = normalizeRelationName(genericAppChatEn[2]);
      return {
        stepId,
        tool: 'app_chat_prepare',
        args: {
          appName,
          contactQuery: recipient,
          message: stripTrailingPunctuation(genericAppChatEn[3] || genericAppChatEn[4] || ''),
        },
        requiredPermissions: ['ACCESSIBILITY_SERVICE'],
        requiresUserConfirmation: false,
        honestOutcomeNote: `Executes ${appName} messaging directly using the verified Accessibility adapter.`,
      };
    }
  }

  // English: "Message Riya on Instagram saying hello" / "Send a message to Rahul on Messenger saying call me"
  const genericAppChatOnEn = segment.match(
    /^(?:please\s+)?(?:message|dm|text|send\s+(?:a\s+)?(?:dm|chat|message)\s+to)\s+(.+?)\s+(?:on|in|via)\s+(telegram|instagram|messenger)(?:\s+(?:saying|that|message)\s+(.+)|\s*[:,-]\s*(.+))?$/i
  );
  if (genericAppChatOnEn && genericAppChatOnEn[1] && genericAppChatOnEn[2]) {
    const appName = normalizeSupportedChatAppName(genericAppChatOnEn[2]);
    if (appName) {
      const recipient = normalizeRelationName(genericAppChatOnEn[1]);
      return {
        stepId,
        tool: 'app_chat_prepare',
        args: {
          appName,
          contactQuery: recipient,
          message: stripTrailingPunctuation(genericAppChatOnEn[3] || genericAppChatOnEn[4] || ''),
        },
        requiredPermissions: ['ACCESSIBILITY_SERVICE'],
        requiresUserConfirmation: false,
        honestOutcomeNote: `Executes ${appName} messaging directly using the verified Accessibility adapter.`,
      };
    }
  }

  // 7b. Direct Contact-Based SMS Messaging (Bengali, English, Hindi — executes directly with NO confirmation screen!)
  // Bengali: "বাবাকে SMS পাঠাও: আমি বাড়ি ফিরছি" / "মাকে এসএমএস পাঠিয়ে দাও: আমি আসছি"
  const smsNamedBn = segment.match(
    /^(.+?)(?:কে|-\s*কে)\s*(?:একটা\s+|একটি\s+)?(?:sms|এসএমএস|এস\.এম\.এস)(?:-?এ|\s*এ)?\s*(?:মেসেজ\s*)?(?:পাঠিয়ে\s*দাও|পাঠিয়ে\s*দাও|পাঠাও|করে\s*দাও|করো|দাও|লিখে\s*দাও|লেখো)(?:\s*[:,-]?\s*(.+))?$/i
  );
  if (smsNamedBn && smsNamedBn[1]) {
    const recipient = normalizeRelationName(smsNamedBn[1]);
    return {
      stepId,
      tool: 'sms_compose',
      args: {
        contactQuery: recipient,
        phoneNumber: recipient,
        message: stripTrailingPunctuation(smsNamedBn[2] || ''),
      },
      requiredPermissions: ['READ_CONTACTS', 'SEND_SMS'],
      requiresUserConfirmation: false,
      honestOutcomeNote: 'Sends the exact SMS directly using authorized Android SMS functionality.',
    };
  }

  // Bengali SMS-first: "SMS-এ বাবাকে পাঠাও: আমি বাড়ি ফিরছি"
  const smsAppFirstBn = segment.match(
    /^(?:sms|এসএমএস|এস\.এম\.এস)(?:-?এ|\s*এ)\s+(.+?)(?:কে|-\s*কে)\s*(?:একটা\s+|একটি\s+)?(?:মেসেজ\s*)?(?:পাঠিয়ে\s*দাও|পাঠিয়ে\s*দাও|পাঠাও|করে\s*দাও|করো|দাও|বলো|লিখে\s*দাও)(?:\s*[:,-]?\s*(.+))?$/i
  );
  if (smsAppFirstBn && smsAppFirstBn[1]) {
    const recipient = normalizeRelationName(smsAppFirstBn[1]);
    return {
      stepId,
      tool: 'sms_compose',
      args: {
        contactQuery: recipient,
        phoneNumber: recipient,
        message: stripTrailingPunctuation(smsAppFirstBn[2] || ''),
      },
      requiredPermissions: ['READ_CONTACTS', 'SEND_SMS'],
      requiresUserConfirmation: false,
      honestOutcomeNote: 'Sends the exact SMS directly using authorized Android SMS functionality.',
    };
  }

  // English SMS: "Send an SMS to Baba saying I am coming home" / "Send SMS to Dad: I am on my way" / "SMS Rahul saying hello"
  const smsEnTo = segment.match(
    /^(?:please\s+)?(?:send\s+(?:an?\s+)?)?(?:sms|text\s+message)\s+(?:message\s+)?to\s+([^:]+?)(?:\s+(?:saying|that|message)\s+(.+)|\s*[:,-]\s*(.+))?$/i
  );
  if (smsEnTo && smsEnTo[1]) {
    const recipient = normalizeRelationName(smsEnTo[1]);
    return {
      stepId,
      tool: 'sms_compose',
      args: {
        contactQuery: recipient,
        phoneNumber: recipient,
        message: stripTrailingPunctuation(smsEnTo[2] || smsEnTo[3] || ''),
      },
      requiredPermissions: ['READ_CONTACTS', 'SEND_SMS'],
      requiresUserConfirmation: false,
      honestOutcomeNote: 'Sends the exact SMS directly using authorized Android SMS functionality.',
    };
  }

  const smsEnRecipientFirst = segment.match(
    /^(?:please\s+)?(?:send\s+([a-zA-Z0-9\s.'-]{2,40}?)\s+(?:an?\s+)?sms(?:\s+message)?|sms\s+([a-zA-Z0-9\s.'-]{2,40}?))(?:\s+(?:saying|that|with\s+message)\s+(.+)|\s*[:,-]\s*(.+))?$/i
  );
  if (smsEnRecipientFirst && (smsEnRecipientFirst[1] || smsEnRecipientFirst[2])) {
    const recipient = normalizeRelationName(smsEnRecipientFirst[1] || smsEnRecipientFirst[2]);
    if (recipient && !/^(?:to|a|an)$/i.test(recipient)) {
      return {
        stepId,
        tool: 'sms_compose',
        args: {
          contactQuery: recipient,
          phoneNumber: recipient,
          message: stripTrailingPunctuation(smsEnRecipientFirst[3] || smsEnRecipientFirst[4] || ''),
        },
        requiredPermissions: ['READ_CONTACTS', 'SEND_SMS'],
        requiresUserConfirmation: false,
        honestOutcomeNote: 'Sends the exact SMS directly using authorized Android SMS functionality.',
      };
    }
  }

  // Hindi SMS: "पापा को SMS भेजो: मैं घर आ रहा हूँ" / "राहुल को एसएमएस भेजो मैं आ रहा हूँ"
  const smsNamedHi = segment.match(
    /^(.+?)\s*को\s*(?:sms|एसएमएस)\s*(?:मैसेज\s*)?(?:भेज\s*दो|भेजो|लिख\s*दो|लिखो|करो)(?:\s*(?:कि\s+|[:,-]\s*)?(.+))?$/i
  );
  if (smsNamedHi && smsNamedHi[1]) {
    const recipient = normalizeRelationName(smsNamedHi[1]);
    const rawHiBody = (smsNamedHi[2] || '').replace(/^कि\s+/i, '');
    return {
      stepId,
      tool: 'sms_compose',
      args: {
        contactQuery: recipient,
        phoneNumber: recipient,
        message: stripTrailingPunctuation(rawHiBody),
      },
      requiredPermissions: ['READ_CONTACTS', 'SEND_SMS'],
      requiresUserConfirmation: false,
      honestOutcomeNote: 'Sends the exact SMS directly using authorized Android SMS functionality.',
    };
  }

  // 7c. Direct Contact-based WhatsApp Messaging (executes directly with NO routine confirmation screen!)
  // English: "Message Rahul on WhatsApp saying I am coming" / "Send a message to Rahul on WhatsApp: hello"
  const waMessageOnEn = segment.match(
    /^(?:please\s+)?(?:message|text|send\s+(?:a\s+)?message\s+to)\s+(.+?)\s+(?:on|in|via)\s+whats\s*app(?:\s+(?:saying|that|message)\s+(.+)|\s*[:,-]\s*(.+))?$/i
  );
  if (waMessageOnEn && waMessageOnEn[1]) {
    const recipient = normalizeRelationName(waMessageOnEn[1]);
    return {
      stepId,
      tool: 'whatsapp_prepare',
      args: {
        contactQuery: recipient,
        phoneNumber: recipient,
        message: stripTrailingPunctuation(waMessageOnEn[2] || waMessageOnEn[3] || ''),
      },
      requiredPermissions: ['READ_CONTACTS'],
      requiresUserConfirmation: false,
      honestOutcomeNote:
        'Sends the exact WhatsApp message directly using Android WhatsApp and Accessibility integration.',
    };
  }

  // English: "Send Rahul a WhatsApp message saying I will arrive in 10 minutes"
  const waSendRecipientFirst = segment.match(
    /^(?:please\s+)?send\s+([a-zA-Z0-9\s.'-]{2,40}?)\s+(?:a\s+)?whats\s*app\s*(?:message\s*)?(?:saying|that|with\s+message)?\s*[:,-]?\s*(.+)?$/i
  );
  if (waSendRecipientFirst && waSendRecipientFirst[1]) {
    const recipient = normalizeRelationName(waSendRecipientFirst[1]);
    return {
      stepId,
      tool: 'whatsapp_prepare',
      args: {
        contactQuery: recipient,
        phoneNumber: recipient,
        message: stripTrailingPunctuation(waSendRecipientFirst[2] || ''),
      },
      requiredPermissions: ['READ_CONTACTS'],
      requiresUserConfirmation: false,
      honestOutcomeNote:
        'Sends the exact WhatsApp message directly using Android WhatsApp and Accessibility integration.',
    };
  }

  // English: "Send a WhatsApp message to Rahul saying I am coming"
  const waNamedEnglish = segment.match(
    /(?:send\s+(?:a\s+)?)?whats\s*app\s*(?:message\s*)?to\s+([^:]+?)(?:\s+(?:saying|that|message)\s+(.+)|:\s*(.+))?$/i
  );
  if (waNamedEnglish && waNamedEnglish[1]) {
    const recipient = normalizeRelationName(waNamedEnglish[1]);
    return {
      stepId,
      tool: 'whatsapp_prepare',
      args: {
        contactQuery: recipient,
        phoneNumber: recipient,
        message: stripTrailingPunctuation(waNamedEnglish[2] || waNamedEnglish[3] || ''),
      },
      requiredPermissions: ['READ_CONTACTS'],
      requiresUserConfirmation: false,
      honestOutcomeNote:
        'Sends the exact WhatsApp message directly using Android WhatsApp and Accessibility integration.',
    };
  }

  // Bengali WhatsApp-first phrasing:
  // "WhatsApp-এ রাহুলকে একটা মেসেজ পাঠিয়ে দাও" / "হোয়াটসঅ্যাপে রাহুলকে মেসেজ পাঠাও: আমি আসছি" / "WhatsApp-এ রহিমকে মেসেজ পাঠাও: আমি আজ বিকেলে আসব।"
  const waAppFirstBn = segment.match(
    /^(?:হোয়াটসঅ্যাপ|হোয়াটসঅ্যাপ|whatsapp)(?:-?এ|\s*এ|ে)?\s+(.+?)(?:কে|-\s*কে)\s*(?:একটা\s+|একটি\s+)?(?:মেসেজ\s*)?(?:পাঠিয়ে\s*দাও|পাঠিয়ে\s*দাও|পাঠাও|করে\s*দাও|করো|দাও|বলো|লিখে\s*দাও|লেখো)(?:\s*[:,-]?\s*(.+))?$/i
  );
  if (waAppFirstBn && waAppFirstBn[1]) {
    const recipient = normalizeRelationName(waAppFirstBn[1]);
    return {
      stepId,
      tool: 'whatsapp_prepare',
      args: {
        contactQuery: recipient,
        phoneNumber: recipient,
        message: stripTrailingPunctuation(waAppFirstBn[2] || ''),
      },
      requiredPermissions: ['READ_CONTACTS'],
      requiresUserConfirmation: false,
      honestOutcomeNote:
        'Sends the exact WhatsApp message directly using Android WhatsApp and Accessibility integration.',
    };
  }

  // Bengali Recipient-first WhatsApp phrasing:
  // "রাহুলকে WhatsApp মেসেজ পাঠাও: আমি আসছি।" / "রাহুলকে WhatsApp-এ মেসেজ পাঠাও: আমি আজ আসতে পারব না" / "মাকে WhatsApp-এ বলো আমি বাড়ি ফিরছি"
  const waNamedBn = segment.match(
    /^(.+?)(?:কে|-\s*কে)\s*(?:হোয়াটসঅ্যাপ|হোয়াটসঅ্যাপ|whatsapp)(?:-?এ|\s*এ|ে)?\s*(?:একটা\s+|একটি\s+)?(?:মেসেজ\s*)?(?:পাঠিয়ে\s*দাও|পাঠিয়ে\s*দাও|পাঠাও|করে\s*দাও|করো|দাও|বলো|লিখে\s*দাও|লেখো)(?:\s*[:,-]?\s*(.+))?$/i
  );
  if (waNamedBn && waNamedBn[1]) {
    const recipient = normalizeRelationName(waNamedBn[1]);
    return {
      stepId,
      tool: 'whatsapp_prepare',
      args: {
        contactQuery: recipient,
        phoneNumber: recipient,
        message: stripTrailingPunctuation(waNamedBn[2] || ''),
      },
      requiredPermissions: ['READ_CONTACTS'],
      requiresUserConfirmation: false,
      honestOutcomeNote:
        'Sends the exact WhatsApp message directly using Android WhatsApp and Accessibility integration.',
    };
  }

  // Bengali general message: "রাহুলকে একটা মেসেজ লিখে দাও" / "মাকে একটা মেসেজ লিখে দাও।" / "পাপাকে মেসেজ করো আমি পরে ফোন করব"
  const msgDraftBn = segment.match(
    /^(.+?)(?:কে|-\s*কে)\s*(?:একটা\s+|একটি\s+)?মেসেজ\s*(?:লিখে\s*দাও|লেখো|পাঠিয়ে\s*দাও|পাঠিয়ে\s*দাও|পাঠাও|করে\s*দাও|করো|দাও)(?:\s*[:,-]?\s*(.+))?$/i
  );
  if (msgDraftBn && msgDraftBn[1]) {
    const recipient = normalizeRelationName(msgDraftBn[1]);
    return {
      stepId,
      tool: 'whatsapp_prepare',
      args: {
        contactQuery: recipient,
        phoneNumber: recipient,
        message: stripTrailingPunctuation(msgDraftBn[2] || ''),
      },
      requiredPermissions: ['READ_CONTACTS'],
      requiresUserConfirmation: false,
      honestOutcomeNote:
        'Sends the exact WhatsApp message directly using Android WhatsApp and Accessibility integration.',
    };
  }

  // Hindi WhatsApp: "राहुल को व्हाट्सएप मैसेज भेजो मैं आज नहीं आ पाऊंगा" / "व्हाट्सएप पर राहुल को मैसेज भेजो"
  const waAppFirstHi = segment.match(
    /^(?:व्हाट्सएप|whatsapp)\s*(?:पर|में)\s+(.+?)\s*को\s*(?:एक\s*)?(?:मैसेज\s*)?(?:भेज\s*दो|भेजो|लिख\s*दो|लिखो|करो|बोलो)(?:\s*[:,-]?\s*(.+))?$/i
  );
  if (waAppFirstHi && waAppFirstHi[1]) {
    const recipient = normalizeRelationName(waAppFirstHi[1]);
    return {
      stepId,
      tool: 'whatsapp_prepare',
      args: {
        contactQuery: recipient,
        phoneNumber: recipient,
        message: stripTrailingPunctuation(waAppFirstHi[2] || ''),
      },
      requiredPermissions: ['READ_CONTACTS'],
      requiresUserConfirmation: false,
      honestOutcomeNote:
        'Sends the exact WhatsApp message directly using Android WhatsApp and Accessibility integration.',
    };
  }

  const waNamedHi = segment.match(
    /^(.+?)\s*को\s*(?:व्हाट्सएप|whatsapp)\s*(?:पर\s*)?(?:एक\s*)?(?:मैसेज\s*)?(?:भेज\s*दो|भेजो|लिख\s*दो|लिखो|करो|बोलो)(?:\s*(?:कि\s+|[:,-]\s*)?(.+))?$/i
  );
  if (waNamedHi && waNamedHi[1]) {
    const recipient = normalizeRelationName(waNamedHi[1]);
    const rawHiBody = (waNamedHi[2] || '').replace(/^कि\s+/i, '');
    return {
      stepId,
      tool: 'whatsapp_prepare',
      args: {
        contactQuery: recipient,
        phoneNumber: recipient,
        message: stripTrailingPunctuation(rawHiBody),
      },
      requiredPermissions: ['READ_CONTACTS'],
      requiresUserConfirmation: false,
      honestOutcomeNote:
        'Sends the exact WhatsApp message directly using Android WhatsApp and Accessibility integration.',
    };
  }

  // 8. Reminder creation
  const reminderMatch = segment.match(
    /(?:remind\s+me\s+to|set\s+a?\s*reminder\s+(?:for|to)?|রিমাইন্ডার\s*(?:দাও|সেট\s*করো))\s+(.+)/i
  );
  if (reminderMatch) {
    return {
      stepId,
      tool: 'reminder',
      args: { note: reminderMatch[1].trim() },
      requiredPermissions: ['POST_NOTIFICATIONS'],
      requiresUserConfirmation: false,
      honestOutcomeNote: 'Schedules a local reminder notification on device.',
    };
  }

  // 9. Internet search
  const searchMatch = segment.match(/(?:search\s+(?:google\s+)?(?:for\s+)?|গুগলে?\s*সার্চ\s*করো\s+)(.+)/i);
  if (searchMatch) {
    return {
      stepId,
      tool: 'web_search',
      args: { query: searchMatch[1].trim() },
      requiredPermissions: ['INTERNET'],
      requiresUserConfirmation: false,
      honestOutcomeNote: 'Opens web search results for the requested query.',
    };
  }

  // 10. Contact lookup
  const contactLookup = segment.match(/(?:find\s+contact|search\s+contact|কন্টাক্ট\s*খুঁজো)\s+(.+)/i);
  if (contactLookup) {
    return {
      stepId,
      tool: 'contact_lookup',
      args: { query: contactLookup[1].trim() },
      requiredPermissions: ['READ_CONTACTS'],
      requiresUserConfirmation: false,
      honestOutcomeNote: 'Searches Android contacts provider for matching entries.',
    };
  }

  // 10b. Explicit App Launch — Expanded Natural Bengali, English, Hindi & Mixed-Language Variations
  // Examples:
  // - "Open Instagram for me", "Please launch Chrome", "Start Calculator app"
  // - "WhatsApp খোলো", "WhatsApp খুলে দাও", "WhatsApp ওপেন করো", "আমার WhatsApp চালু করো",
  //   "জনি YouTube খুলে দাও", "ফেসবুকটা খুলে দাও", "আমার ফোনে থাকা Chrome চালু করো"
  // - "व्हाट्सएप खोलो", "यूट्यूब खोल दो", "कैलकुलेटर चालू करो"
  const openAppEn = segment.match(
    /^(?:(?:please|can\s+you|could\s+you)\s+)?(?:open|launch|start|run)\s+(?:up\s+)?(?:the\s+|my\s+)?(.+?)(?:\s+app)?(?:\s+for\s+me|\s+please|\s+now)?$/i
  );
  if (openAppEn && openAppEn[1]) {
    const appTarget = normalizeAppQueryTarget(openAppEn[1]);
    if (
      appTarget &&
      appTarget.split(/\s+/).length <= 4 &&
      !/^(?:it|it\s+later|this|that|them|me|him|her)$/i.test(appTarget) &&
      !/(?:settings|camera|flashlight|torch|door|window|eyes|heart)/i.test(appTarget)
    ) {
      return {
        stepId,
        tool: 'open_app',
        args: { appQuery: appTarget },
        requiredPermissions: [],
        requiresUserConfirmation: false,
        honestOutcomeNote: 'Launches the requested installed Android app.',
      };
    }
  }

  const openAppBn = segment.match(
    /^(.+?)\s*(?:খুলে\s*দাও|খোলো|খুলো|ওপেন\s*করে\s*দাও|ওপেন\s*করো|চালু\s*করে\s*দাও|চালু\s*করো|অন\s*করে\s*দাও)$/i
  );
  if (
    openAppBn &&
    openAppBn[1] &&
    !lower.includes('সেটিংস') &&
    !lower.includes('ক্যামেরা') &&
    !lower.includes('টর্চ') &&
    !lower.includes('ফ্ল্যাশলাইট') &&
    !lower.includes('লাইট') &&
    !lower.includes('দরজা') &&
    !lower.includes('জানালা')
  ) {
    const appTarget = normalizeAppQueryTarget(openAppBn[1]);
    if (appTarget && appTarget.split(/\s+/).length <= 4) {
      return {
        stepId,
        tool: 'open_app',
        args: { appQuery: appTarget },
        requiredPermissions: [],
        requiresUserConfirmation: false,
        honestOutcomeNote: 'Launches the requested installed Android app.',
      };
    }
  }

  const openAppHi = segment.match(
    /^(.+?)\s*(?:खोल\s*दो|खोलो|ओपन\s*करो|ओपन\s*कर\s*दो|चालू\s*करो|चालू\s*कर\s*दो)$/i
  );
  if (
    openAppHi &&
    openAppHi[1] &&
    !lower.includes('सेटिंग्स') &&
    !lower.includes('कैमरा') &&
    !lower.includes('टॉर्च') &&
    !lower.includes('लाइट')
  ) {
    const appTarget = normalizeAppQueryTarget(openAppHi[1]);
    if (appTarget && appTarget.split(/\s+/).length <= 4) {
      return {
        stepId,
        tool: 'open_app',
        args: { appQuery: appTarget },
        requiredPermissions: [],
        requiresUserConfirmation: false,
        honestOutcomeNote: 'Launches the requested installed Android app.',
      };
    }
  }

  // 11. Reuse deterministic mobileAssistant intent parser (numbers, flashlight, vibrate, battery, apps, settings)
  const detected = detectAssistantIntent(segment);
  if (detected) {
    switch (detected.type) {
      case 'call':
        return {
          stepId,
          tool: 'sim_call',
          args: { phoneNumber: detected.target || '', target: detected.target || '' },
          requiredPermissions: ['CALL_PHONE', 'READ_CONTACTS'],
          requiresUserConfirmation: false,
          honestOutcomeNote: 'Initiates a direct SIM phone call via Android native calling APIs.',
        };
      case 'whatsapp':
        return {
          stepId,
          tool: 'whatsapp_prepare',
          args: {
            contactQuery: detected.target || '',
            phoneNumber: detected.target || '',
            message: detected.payload || '',
          },
          requiredPermissions: ['READ_CONTACTS'],
          requiresUserConfirmation: false,
          honestOutcomeNote:
            'Sends the exact WhatsApp message directly using Android WhatsApp and Accessibility integration.',
        };
      case 'sms':
        return {
          stepId,
          tool: 'sms_compose',
          args: { phoneNumber: detected.target || '', message: detected.payload || '' },
          requiredPermissions: ['READ_CONTACTS', 'SEND_SMS'],
          requiresUserConfirmation: false,
          honestOutcomeNote: 'Sends the exact SMS directly using authorized Android SMS functionality.',
        };
      case 'flashlight': {
        const enable = detected.payload === 'on' || detected.target === 'on';
        return {
          stepId,
          tool: 'flashlight',
          args: { enable },
          requiredPermissions: ['CAMERA'],
          requiresUserConfirmation: false,
          honestOutcomeNote: enable ? 'Turns phone flashlight ON.' : 'Turns phone flashlight OFF.',
        };
      }
      case 'vibrate':
        return {
          stepId,
          tool: 'vibrate',
          args: { durationMs: 300 },
          requiredPermissions: ['VIBRATE'],
          requiresUserConfirmation: false,
          honestOutcomeNote: 'Triggers haptic vibration feedback.',
        };
      case 'battery':
        return {
          stepId,
          tool: 'battery_status',
          args: {},
          requiredPermissions: [],
          requiresUserConfirmation: false,
          honestOutcomeNote: 'Reads live device battery percentage and charging status.',
        };
      case 'app':
        return {
          stepId,
          tool: 'open_app',
          args: { appQuery: detected.target || '' },
          requiredPermissions: [],
          requiresUserConfirmation: false,
          honestOutcomeNote: 'Launches the requested installed Android app.',
        };
      case 'settings':
        return {
          stepId,
          tool: 'open_settings',
          args: { target: detected.target || 'main' },
          requiredPermissions: [],
          requiresUserConfirmation: false,
          honestOutcomeNote: 'Opens the requested Android system settings screen.',
        };
      default:
        break;
    }
  }

  // 12. Direct Contact-Name SIM Call — "call my father", "আমার মাকে ফোন করো", "বাবাকে কল করো", "पापा को कॉल करो"
  const namedCallEn = segment.match(/^(?:please\s+)?(?:call|dial|phone)\s+(?:my\s+)?([a-zA-Z0-9\s.'-]{2,40})$/i);
  if (namedCallEn && namedCallEn[1]) {
    const targetName = normalizeRelationName(namedCallEn[1]);
    if (!/\b(?:me|back|off|it|this|that)\b/i.test(targetName)) {
      return {
        stepId,
        tool: 'sim_call',
        args: { contactQuery: targetName, target: targetName },
        requiredPermissions: ['READ_CONTACTS', 'CALL_PHONE'],
        requiresUserConfirmation: false,
        honestOutcomeNote:
          'Resolves the contact from Android Contacts and initiates the SIM call directly (asking only if multiple contacts match).',
      };
    }
  }

  const namedCallBn = segment.match(/^(.+?)(?:কে|-\s*কে)\s*(?:কল\s*করো|কল\s*দাও|ফোন\s*করো|ফোন\s*দাও)$/i);
  if (namedCallBn && namedCallBn[1]) {
    const targetName = normalizeRelationName(namedCallBn[1]);
    return {
      stepId,
      tool: 'sim_call',
      args: { contactQuery: targetName, target: targetName },
      requiredPermissions: ['READ_CONTACTS', 'CALL_PHONE'],
      requiresUserConfirmation: false,
      honestOutcomeNote:
        'Resolves the contact from Android Contacts and initiates the SIM call directly (asking only if multiple contacts match).',
    };
  }

  const namedCallHi = segment.match(/^(.+?)\s*को\s*(?:कॉल\s*करो|फोन\s*करो|फ़ोन\s*करो|कॉल\s*लगाओ)$/i);
  if (namedCallHi && namedCallHi[1]) {
    const targetName = normalizeRelationName(namedCallHi[1]);
    return {
      stepId,
      tool: 'sim_call',
      args: { contactQuery: targetName, target: targetName },
      requiredPermissions: ['READ_CONTACTS', 'CALL_PHONE'],
      requiresUserConfirmation: false,
      honestOutcomeNote:
        'Resolves the contact from Android Contacts and initiates the SIM call directly (asking only if multiple contacts match).',
    };
  }

  return null;
}

/**
 * Formats an honest post-action voice response (enforcing WhatsApp, SMS, and SIM call honesty).
 */
export function formatHonestTaskOutcome(tool: AllowedTaskTool, succeeded: boolean, detail?: string): string {
  if (!succeeded) {
    return detail || `কাজটি সম্পন্ন করা যায়নি (${tool})। অনুগ্রহ করে পারমিশন বা সেটিংস যাচাই করুন।`;
  }
  switch (tool) {
    case 'whatsapp_prepare':
      return detail || 'WhatsApp-এ আপনার মেসেজ ড্রাফট প্রস্তুত করে খুলে দেওয়া হয়েছে। পাঠাতে অনুগ্রহ করে WhatsApp-এ Send চাপুন।';
    case 'sim_call':
      return detail || 'ফোনের সিম (SIM) কলিং-এর মাধ্যমে সরাসরি কল শুরু করা হয়েছে।';
    case 'sms_compose':
      return detail || 'SMS মেসেজ কম্পোজার প্রস্তুত করা হয়েছে — সরাসরি পাঠাতে SEND_SMS পারমিশন দিন বা SMS অ্যাপে Send চাপুন।';
    case 'flashlight':
      return detail || 'ফ্ল্যাশলাইট আপডেট করা হয়েছে।';
    case 'camera_open':
      return detail || 'ক্যামেরা চালু করা হয়েছে।';
    case 'volume_control':
      return detail || 'ডিভাইসের ভলিউম আপডেট করা হয়েছে।';
    case 'screen_analyze':
      return detail || 'স্ক্রিনের তথ্য বিশ্লেষণ সম্পন্ন হয়েছে।';
    case 'notification_read':
      return detail || 'সাম্প্রতিক নোটিফিকেশন পড়া হয়েছে।';
    case 'accessibility_action':
      return detail || 'অ্যাক্সেসিবিলিটি অ্যাকশন সম্পন্ন হয়েছে।';
    case 'open_app':
      return detail || 'অ্যাপটি চালু করা হয়েছে।';
    case 'list_installed_apps':
      return detail || 'ইনস্টলড অ্যাপের তালিকা পাওয়া গেছে।';
    case 'app_search_workflow':
      return detail || 'অ্যাপের ভেতর সার্চ ওয়ার্কফ্লো সম্পন্ন হয়েছে।';
    case 'open_settings':
      return detail || 'অ্যান্ড্রয়েড সেটিংস খোলা হয়েছে।';
    case 'reminder':
      return detail || 'রিমাইন্ডার সংরক্ষণ করা হয়েছে।';
    case 'answer_incoming_call':
      return detail || 'ইনকামিং কল রিসিভ করা হয়েছে।';
    case 'reject_incoming_call':
      return detail || 'ইনকামিং কল রিজেক্ট করা হয়েছে।';
    case 'end_active_call':
      return detail || 'চলমান কল বন্ধ করা হয়েছে।';
    default:
      return detail || 'কাজটি সফলভাবে সম্পন্ন হয়েছে।';
  }
}
