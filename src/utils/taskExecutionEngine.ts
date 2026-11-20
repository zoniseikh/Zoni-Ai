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
  | 'contact_lookup'
  | 'sim_call'
  | 'whatsapp_prepare'
  | 'sms_compose'
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
  | 'web_search';

export const ALLOWED_TASK_TOOLS: ReadonlySet<AllowedTaskTool> = new Set([
  'open_app',
  'contact_lookup',
  'sim_call',
  'whatsapp_prepare',
  'sms_compose',
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
  /\b(?:rm\s+-rf|sudo|chmod|chown|mkfs|dd\s+if=|curl\s+.*\|\s*sh|wget\s+.*\|\s*sh|bash\s+-c|sh\s+-c|eval\()/i,
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
        blockedReason: 'Arbitrary shell commands are strictly blocked by Zoni AI security policy.',
      };
    }
  }

  // Split chained multi-step instructions ("এবং", "তারপর", "और फिर", "and then", "then")
  const segments = cleaned
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
  return text.replace(/^(?:hey\s+)?(?:zoni|জনি|ज़ोनी)\s*[,:\-!]?\s*/i, '').trim();
}

function parseSingleSegmentToStep(rawSegment: string, stepId: string): TaskStep | null {
  const segment = stripWakePrefix(rawSegment);
  const lower = segment.toLowerCase();

  // 1. Screen Understanding ("what is on my screen", "read this page", "explain this screen", "স্ক্রিনে কী আছে", "स्क्रीन पर क्या है")
  if (
    /(?:what(?:'s|\s+is)\s+on\s+(?:my\s+)?screen|read\s+(?:this\s+)?(?:screen|page)|explain\s+(?:this\s+)?(?:screen|page)|summarize\s+(?:this\s+)?(?:screen|page)|স্ক্রিনে\s*কী\s*আছে|স্ক্রিন\s*(?:পড়ো|পড়ো|বোঝাও|দেখো)|এই\s*পেজটা\s*(?:পড়ো|বোঝাও)|स्क्रीन\s*पर\s*क्या\s*है|स्क्रीन\s*(?:पढ़ो|समझाओ))/i.test(
      segment
    )
  ) {
    return {
      stepId,
      tool: 'screen_analyze',
      args: { question: segment },
      requiredPermissions: ['MEDIA_PROJECTION_OR_ACCESSIBILITY'],
      requiresUserConfirmation: false,
      honestOutcomeNote: 'Analyzes the current screen using user-authorized MediaProjection or Accessibility text.',
    };
  }

  // 2. Notification Reading ("read my notifications", "new WhatsApp messages", "আমার নোটিফিকেশন পড়ো", "मेरा नोटिफिकेशन पढ़ो")
  if (
    /(?:read\s+(?:my\s+)?(?:latest\s+|recent\s+|new\s+)?notifications?|check\s+(?:my\s+)?notifications?|any\s+new\s+(?:whatsapp\s+)?messages?|নোটিফিকেশন\s*(?:পড়ো|পড়ো|দেখাও|বলো)|নতুন\s*(?:মেসেজ|নোটিফিকেশন)|नोटिफिकेशन\s*(?:पढ़ो|बताओ|चेक))/i.test(
      segment
    )
  ) {
    return {
      stepId,
      tool: 'notification_read',
      args: { whatsappOnly: /whatsapp|হোয়াটসঅ্যাপ|व्हाट्सएप/i.test(segment) },
      requiredPermissions: ['NOTIFICATION_LISTENER'],
      requiresUserConfirmation: false,
      honestOutcomeNote: 'Reads recent Android notifications captured via NotificationListenerService.',
    };
  }

  // 3. Accessibility Navigation & Touch ("scroll down", "scroll up", "go back", "go home", "tap <button>")
  if (/(?:scroll\s+down|নিচে\s*স্ক্রল\s*করো|नीचे\s*स्क्रॉल\s*करो)/i.test(segment)) {
    return {
      stepId,
      tool: 'accessibility_action',
      args: { command: 'scroll_down' },
      requiredPermissions: ['ACCESSIBILITY_SERVICE'],
      requiresUserConfirmation: false,
      honestOutcomeNote: 'Scrolls down on the active Android screen via AccessibilityService.',
    };
  }
  if (/(?:scroll\s+up|উপরে\s*স্ক্রল\s*করো|ऊपर\s*स्क्रॉल\s*करो)/i.test(segment)) {
    return {
      stepId,
      tool: 'accessibility_action',
      args: { command: 'scroll_up' },
      requiredPermissions: ['ACCESSIBILITY_SERVICE'],
      requiresUserConfirmation: false,
      honestOutcomeNote: 'Scrolls up on the active Android screen via AccessibilityService.',
    };
  }
  if (/^(?:go\s+back|back\s+button|পেছনে\s*যাও|ব্যাক\s*করো|वापस\s*जाओ)$/i.test(segment)) {
    return {
      stepId,
      tool: 'accessibility_action',
      args: { command: 'back' },
      requiredPermissions: ['ACCESSIBILITY_SERVICE'],
      requiresUserConfirmation: false,
      honestOutcomeNote: 'Performs Android global Back navigation via AccessibilityService.',
    };
  }
  if (/^(?:go\s+home|home\s+screen|হোম\s*স্ক্রিনে\s*যাও|होम\s*स्क्रीन\s*पर\s*जाओ)$/i.test(segment)) {
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

  // 5. Volume Controls ("volume up", "volume down", "mute volume", "ভলিউম বাড়াও", "ভলিউম কমাও", "वॉल्यूम बढ़ाओ")
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

  // 6. Location & Notification Android Settings
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

  // 7. Contact-based WhatsApp messaging ("send a WhatsApp message to Rahul saying I am coming")
  const waNamedEnglish = segment.match(
    /(?:send\s+(?:a\s+)?)?whats\s*app\s*(?:message\s*)?to\s+([^:]+?)(?:\s+(?:saying|that|message)\s+(.+))?$/i
  );
  if (waNamedEnglish && waNamedEnglish[1]) {
    return {
      stepId,
      tool: 'whatsapp_prepare',
      args: {
        contactQuery: waNamedEnglish[1].trim(),
        phoneNumber: waNamedEnglish[1].trim(),
        message: (waNamedEnglish[2] || '').trim(),
      },
      requiredPermissions: ['READ_CONTACTS'],
      requiresUserConfirmation: false,
      honestOutcomeNote:
        'Resolves the contact and opens WhatsApp with a pre-filled draft message. The message is NOT sent automatically — review and tap Send inside WhatsApp.',
    };
  }

  const waNamedBn = segment.match(
    /(.+?)(?:কে|-\s*কে)\s*(?:হোয়াটসঅ্যাপ|হোয়াটসঅ্যাপ|whatsapp)\s*(?:মেসেজ\s*)?(?:পাঠাও|করো|দাও)(?:\s*[:,-]?\s*(.+))?$/i
  );
  if (waNamedBn && waNamedBn[1]) {
    return {
      stepId,
      tool: 'whatsapp_prepare',
      args: {
        contactQuery: waNamedBn[1].trim(),
        phoneNumber: waNamedBn[1].trim(),
        message: (waNamedBn[2] || '').trim(),
      },
      requiredPermissions: ['READ_CONTACTS'],
      requiresUserConfirmation: false,
      honestOutcomeNote:
        'Resolves the contact and opens WhatsApp with a pre-filled draft message. The message is NOT sent automatically — review and tap Send inside WhatsApp.',
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
          honestOutcomeNote: 'Initiates a direct Android SIM call via ContactCallManager/Telecom without unnecessary confirmation.',
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
          requiredPermissions: [],
          requiresUserConfirmation: false,
          honestOutcomeNote:
            'Opens WhatsApp with a pre-filled draft message. The message is NOT sent automatically — tap Send inside WhatsApp.',
        };
      case 'sms':
        return {
          stepId,
          tool: 'sms_compose',
          args: { phoneNumber: detected.target || '', message: detected.payload || '' },
          requiredPermissions: ['SEND_SMS'],
          requiresUserConfirmation: true,
          honestOutcomeNote: 'Opens the SMS composer or sends SMS when explicitly authorized by the user.',
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

  // 12. Contact-Name Direct SIM Call ("call my father", "call Rahul", "বাবাকে কল করো", "पापा को कॉल करो")
  const namedCallEn = segment.match(/^(?:please\s+)?(?:call|dial|phone)\s+(?:my\s+)?([a-zA-Z0-9\s.'-]{2,40})$/i);
  if (namedCallEn && namedCallEn[1]) {
    const targetName = namedCallEn[1].trim();
    if (!/\b(?:me|back|off|it|this|that)\b/i.test(targetName)) {
      return {
        stepId,
        tool: 'sim_call',
        args: { contactQuery: targetName, target: targetName },
        requiredPermissions: ['READ_CONTACTS', 'CALL_PHONE'],
        requiresUserConfirmation: false,
        honestOutcomeNote:
          'Resolves the contact from Android Contacts and places a direct SIM call when 1 match and 1 number exist.',
      };
    }
  }

  const namedCallBn = segment.match(/^(.+?)(?:কে|-\s*কে)\s*(?:কল\s*করো|কল\s*দাও|ফোন\s*করো|ফোন\s*দাও)$/i);
  if (namedCallBn && namedCallBn[1]) {
    const targetName = namedCallBn[1].trim();
    return {
      stepId,
      tool: 'sim_call',
      args: { contactQuery: targetName, target: targetName },
      requiredPermissions: ['READ_CONTACTS', 'CALL_PHONE'],
      requiresUserConfirmation: false,
      honestOutcomeNote:
        'Resolves the contact from Android Contacts and places a direct SIM call when 1 match and 1 number exist.',
    };
  }

  const namedCallHi = segment.match(/^(.+?)\s*को\s*(?:कॉल\s*करो|फोन\s*करो|फ़ोन\s*करो|कॉल\s*लगाओ)$/i);
  if (namedCallHi && namedCallHi[1]) {
    const targetName = namedCallHi[1].trim();
    return {
      stepId,
      tool: 'sim_call',
      args: { contactQuery: targetName, target: targetName },
      requiredPermissions: ['READ_CONTACTS', 'CALL_PHONE'],
      requiresUserConfirmation: false,
      honestOutcomeNote:
        'Resolves the contact from Android Contacts and places a direct SIM call when 1 match and 1 number exist.',
    };
  }

  // Hindi app open ("यूट्यूब खोलो", "व्हाट्सएप खोलो")
  const openAppHi = segment.match(/^([^\s]+(?:\s+[^\s]+)?)\s*खोलो$/i);
  if (openAppHi && openAppHi[1] && !lower.includes('सेटिंग्स') && !lower.includes('कैमरा')) {
    return {
      stepId,
      tool: 'open_app',
      args: { appQuery: openAppHi[1].trim() },
      requiredPermissions: [],
      requiresUserConfirmation: false,
      honestOutcomeNote: 'Launches the requested installed Android app.',
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
      return detail || 'আপনার ফোনের সিম (SIM) ডায়ালারের মাধ্যমে কল শুরু করা হয়েছে।';
    case 'sms_compose':
      return detail || 'SMS মেসেজ কম্পোজার প্রস্তুত করা হয়েছে।';
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
    case 'open_settings':
      return detail || 'অ্যান্ড্রয়েড সেটিংস খোলা হয়েছে।';
    case 'reminder':
      return detail || 'রিমাইন্ডার সংরক্ষণ করা হয়েছে।';
    default:
      return detail || 'কাজটি সফলভাবে সম্পন্ন হয়েছে।';
  }
}
