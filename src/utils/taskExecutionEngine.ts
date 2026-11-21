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
  | 'cancel_current_task';

export const ALLOWED_TASK_TOOLS: ReadonlySet<AllowedTaskTool> = new Set([
  'open_app',
  'list_installed_apps',
  'app_search_workflow',
  'contact_lookup',
  'sim_call',
  'whatsapp_prepare',
  'sms_compose',
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
    /(?:whats\s*app|হোয়াটসঅ্যাপ|হোয়াটসঅ্যাপ|व्हाट्सएप|মেসেজ\s*(?:পাঠাও|করো|লিখে\s*দাও)|मैसेज\s*(?:भेजो|लिखो)|message\s+(?:to|saying))/i.test(
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
    .replace(/^(?:hey\s+|ok\s+|okay\s+|হ্যালো\s+|হেই\s+)?(?:zoni(?:\s+ai)?|জনি(?:\s+এআই)?|ज़ोनी(?:\s+एआई)?)\s*[,:\-!।]?\s*/i, '')
    .trim();
}

function stripTrailingPunctuation(text: string): string {
  return text.replace(/[।.!?]+$/g, '').trim();
}

function normalizeRelationName(raw: string): string {
  return raw
    .trim()
    .replace(/^(?:আমার|my|मेरे|मेरी|मेरा)\s+/i, '')
    .replace(/^(?:কে|কো)\s+/i, '')
    .trim();
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

  // 3. Accessibility Navigation & Touch ("scroll down", "scroll up", "go back", "go home", "tap <button>")
  if (/(?:scroll\s+down|নিচে\s*স্ক্রল\s*করো|নিচের\s*দিকে\s*স্ক্রল|नीचे\s*स्क्रॉल\s*करो)/i.test(segment)) {
    return {
      stepId,
      tool: 'accessibility_action',
      args: { command: 'scroll_down' },
      requiredPermissions: ['ACCESSIBILITY_SERVICE'],
      requiresUserConfirmation: false,
      honestOutcomeNote: 'Scrolls down on the active Android screen via AccessibilityService.',
    };
  }
  if (/(?:scroll\s+up|উপরে\s*স্ক্রল\s*করো|উপরের\s*দিকে\s*স্ক্রল|ऊपर\s*स्क्रॉल\s*करो)/i.test(segment)) {
    return {
      stepId,
      tool: 'accessibility_action',
      args: { command: 'scroll_up' },
      requiredPermissions: ['ACCESSIBILITY_SERVICE'],
      requiresUserConfirmation: false,
      honestOutcomeNote: 'Scrolls up on the active Android screen via AccessibilityService.',
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
    return {
      stepId,
      tool: 'accessibility_action',
      args: { command: `tap:${tapMatch[1].trim()}` },
      requiredPermissions: ['ACCESSIBILITY_SERVICE'],
      requiresUserConfirmation: false,
      honestOutcomeNote: `Attempts to tap "${tapMatch[1].trim()}" via Android AccessibilityService.`,
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

  // 5. Volume Controls
  if (/(?:volume\s+up|increase\s+volume|turn\s+up\s+(?:the\s+)?volume|ভলিউম\s*বাড়াও|ভলিউম\s*বাড়াও|আওয়াজ\s*বাড়াও|वॉल्यूम\s*बढ़ाओ)/i.test(segment)) {
    return {
      stepId,
      tool: 'volume_control',
      args: { action: 'up' },
      requiredPermissions: [],
      requiresUserConfirmation: false,
      honestOutcomeNote: 'Increases Android media volume.',
    };
  }
  if (/(?:volume\s+down|decrease\s+volume|lower\s+volume|turn\s+down\s+(?:the\s+)?volume|ভলিউম\s*কমাও|আওয়াজ\s*কমাও|वॉल्यूम\s*कम\s*करो)/i.test(segment)) {
    return {
      stepId,
      tool: 'volume_control',
      args: { action: 'down' },
      requiredPermissions: [],
      requiresUserConfirmation: false,
      honestOutcomeNote: 'Decreases Android media volume.',
    };
  }
  if (/(?:mute\s+(?:the\s+)?volume|mute\s+phone|ভলিউম\s*মিউট\s*করো|সাউন্ড\s*বন্ধ\s*করো|वॉल्यूम\s*म्यूट\s*करो)/i.test(segment)) {
    return {
      stepId,
      tool: 'volume_control',
      args: { action: 'mute' },
      requiredPermissions: [],
      requiresUserConfirmation: false,
      honestOutcomeNote: 'Mutes Android media volume.',
    };
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

  // 7. Contact-based WhatsApp & Message Drafting (ALWAYS requires user confirmation before sending!)
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
      requiresUserConfirmation: true,
      honestOutcomeNote:
        'Prepares a WhatsApp draft for user review and approval. The message is NEVER sent silently.',
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
      requiresUserConfirmation: true,
      honestOutcomeNote:
        'Prepares a WhatsApp draft for user review and approval. The message is NEVER sent silently.',
    };
  }

  // Bengali: "রাহুলকে WhatsApp-এ মেসেজ পাঠাও: আমি আজ আসতে পারব না" / "মাকে WhatsApp-এ বলো আমি বাড়ি ফিরছি"
  const waNamedBn = segment.match(
    /^(.+?)(?:কে|-\s*কে)\s*(?:হোয়াটসঅ্যাপ|হোয়াটসঅ্যাপ|whatsapp)(?:-?এ|\s*এ)?\s*(?:একটা\s*)?(?:মেসেজ\s*)?(?:পাঠাও|করো|দাও|বলো|লিখে\s*দাও|লেখো)(?:\s*[:,-]?\s*(.+))?$/i
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
      requiresUserConfirmation: true,
      honestOutcomeNote:
        'Prepares a WhatsApp draft for user review and approval. The message is NEVER sent silently.',
    };
  }

  // Bengali general message draft: "রাহুলকে একটা মেসেজ লিখে দাও" / "পাপাকে মেসেজ করো আমি পরে ফোন করব"
  const msgDraftBn = segment.match(
    /^(.+?)(?:কে|-\s*কে)\s*(?:একটা\s+|একটি\s+)?মেসেজ\s*(?:লিখে\s*দাও|লেখো|পাঠাও|করো|দাও)(?:\s*[:,-]?\s*(.+))?$/i
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
      requiresUserConfirmation: true,
      honestOutcomeNote:
        'Prepares a message draft for user review and approval before opening WhatsApp.',
    };
  }

  // Hindi WhatsApp: "राहुल को व्हाट्सएप मैसेज भेजो मैं आज नहीं आ पाऊंगा"
  const waNamedHi = segment.match(
    /^(.+?)\s*को\s*(?:व्हाट्सएप|whatsapp)\s*(?:पर\s*)?(?:मैसेज\s*)?(?:भेजो|लिखो|करो|बोलो)(?:\s*[:,-]?\s*(.+))?$/i
  );
  if (waNamedHi && waNamedHi[1]) {
    const recipient = normalizeRelationName(waNamedHi[1]);
    return {
      stepId,
      tool: 'whatsapp_prepare',
      args: {
        contactQuery: recipient,
        phoneNumber: recipient,
        message: stripTrailingPunctuation(waNamedHi[2] || ''),
      },
      requiredPermissions: ['READ_CONTACTS'],
      requiresUserConfirmation: true,
      honestOutcomeNote:
        'Prepares a WhatsApp draft for user review and approval. The message is NEVER sent silently.',
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

  // 10b. Explicit App Launch ("WhatsApp খোলো", "Open WhatsApp", "ইউটিউব খোলো", "व्हाट्सएप खोलो")
  const openAppEn = segment.match(/^(?:please\s+)?(?:open|launch|start)\s+(?:the\s+)?([^\s]+(?:\s+[^\s]+)?)(?:\s+app)?$/i);
  if (
    openAppEn &&
    openAppEn[1] &&
    !/(?:settings|camera|flashlight|torch)/i.test(openAppEn[1])
  ) {
    return {
      stepId,
      tool: 'open_app',
      args: { appQuery: openAppEn[1].trim() },
      requiredPermissions: [],
      requiresUserConfirmation: false,
      honestOutcomeNote: 'Launches the requested installed Android app.',
    };
  }

  const openAppBn = segment.match(/^([^\s]+(?:\s+[^\s]+)?)\s*(?:খোলো|ওপেন\s*করো|চালু\s*করো)$/i);
  if (
    openAppBn &&
    openAppBn[1] &&
    !lower.includes('সেটিংস') &&
    !lower.includes('ক্যামেরা') &&
    !lower.includes('টর্চ') &&
    !lower.includes('ফ্ল্যাশলাইট') &&
    !lower.includes('লাইট')
  ) {
    return {
      stepId,
      tool: 'open_app',
      args: { appQuery: openAppBn[1].trim() },
      requiredPermissions: [],
      requiresUserConfirmation: false,
      honestOutcomeNote: 'Launches the requested installed Android app.',
    };
  }

  const openAppHi = segment.match(/^([^\s]+(?:\s+[^\s]+)?)\s*खोलो$/i);
  if (
    openAppHi &&
    openAppHi[1] &&
    !lower.includes('सेटिंग्स') &&
    !lower.includes('कैमरा') &&
    !lower.includes('टॉर्च')
  ) {
    return {
      stepId,
      tool: 'open_app',
      args: { appQuery: openAppHi[1].trim() },
      requiredPermissions: [],
      requiresUserConfirmation: false,
      honestOutcomeNote: 'Launches the requested installed Android app.',
    };
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
          requiresUserConfirmation: true,
          honestOutcomeNote: 'Stages a SIM phone call for explicit user confirmation before dialing.',
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
          requiresUserConfirmation: true,
          honestOutcomeNote:
            'Prepares a WhatsApp draft for user review and approval. The message is NEVER sent silently.',
        };
      case 'sms':
        return {
          stepId,
          tool: 'sms_compose',
          args: { phoneNumber: detected.target || '', message: detected.payload || '' },
          requiredPermissions: ['READ_CONTACTS'],
          requiresUserConfirmation: true,
          honestOutcomeNote: 'Stages an SMS draft for explicit user review before opening the SMS composer.',
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

  // 12. Contact-Name SIM Call (with confirmation) — "call my father", "আমার মাকে ফোন করো", "বাবাকে কল করো", "पापा को कॉल करो"
  const namedCallEn = segment.match(/^(?:please\s+)?(?:call|dial|phone)\s+(?:my\s+)?([a-zA-Z0-9\s.'-]{2,40})$/i);
  if (namedCallEn && namedCallEn[1]) {
    const targetName = normalizeRelationName(namedCallEn[1]);
    if (!/\b(?:me|back|off|it|this|that)\b/i.test(targetName)) {
      return {
        stepId,
        tool: 'sim_call',
        args: { contactQuery: targetName, target: targetName },
        requiredPermissions: ['READ_CONTACTS', 'CALL_PHONE'],
        requiresUserConfirmation: true,
        honestOutcomeNote:
          'Resolves the contact from Android Contacts and asks for explicit confirmation before placing a SIM call.',
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
      requiresUserConfirmation: true,
      honestOutcomeNote:
        'Resolves the contact from Android Contacts and asks for explicit confirmation before placing a SIM call.',
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
      requiresUserConfirmation: true,
      honestOutcomeNote:
        'Resolves the contact from Android Contacts and asks for explicit confirmation before placing a SIM call.',
    };
  }

  return null;
}

/**
 * Formats an honest post-action voice response (enforcing WhatsApp and SIM call honesty).
 */
export function formatHonestTaskOutcome(tool: AllowedTaskTool, succeeded: boolean, detail?: string): string {
  if (!succeeded) {
    return detail || `কাজটি সম্পন্ন করা যায়নি (${tool})। অনুগ্রহ করে পারমিশন বা সেটিংস যাচাই করুন।`;
  }
  switch (tool) {
    case 'whatsapp_prepare':
      return detail || 'WhatsApp-এ আপনার মেসেজ ড্রাফট প্রস্তুত করে খুলে দেওয়া হয়েছে। পাঠাতে অনুগ্রহ করে WhatsApp-এ Send চাপুন।';
    case 'sim_call':
      return detail || 'আপনার অনুমোদনের পর ফোনের সিম (SIM) ডায়ালারের মাধ্যমে কল শুরু করা হয়েছে।';
    case 'sms_compose':
      return detail || 'SMS মেসেজ কম্পোজার প্রস্তুত করা হয়েছে — পাঠাতে অনুগ্রহ করে SMS অ্যাপে Send চাপুন।';
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
    default:
      return detail || 'কাজটি সফলভাবে সম্পন্ন হয়েছে।';
  }
}
