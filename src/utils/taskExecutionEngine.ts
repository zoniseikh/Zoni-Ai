/**
 * Zoni AI — Structured, Allowlisted Voice-Controlled Task Execution Engine.
 *
 * Pipeline:
 * Voice/Text Input -> Intent Detection -> Structured Task Plan -> Permission Validation
 * -> Confirmation Gate (for sensitive actions) -> Native/Backend Action -> Verification -> Voice Reply
 *
 * Security Invariants:
 * 1. Strict tool allowlist — NEVER executes arbitrary shell commands.
 * 2. WhatsApp honesty — NEVER claims a message was "sent" merely because WhatsApp opened.
 * 3. Outgoing SIM calls require user confirmation and Android Telecom permissions.
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
 * Splits a multi-step Bengali/English voice utterance into structured, allowlisted task steps.
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

  // Split chained multi-step instructions ("এবং", "তারপর", "and then", "then")
  const segments = cleaned
    .split(/\s+(?:and\s+then|then|এবং|তারপর)\s+/i)
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

function parseSingleSegmentToStep(segment: string, stepId: string): TaskStep | null {
  // 1. Reminder creation ("remind me to ...", "রিমাইন্ডার সেট করো ...")
  const reminderMatch = segment.match(/(?:remind\s+me\s+to|set\s+a?\s*reminder\s+(?:for|to)?|রিমাইন্ডার\s*(?:দাও|সেট\s*করো))\s+(.+)/i);
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

  // 3. Internet search ("search ...", "গুগলে সার্চ করো ...")
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

  // 4. Contact lookup ("find contact ...", "নম্বর খুঁজো ...")
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

  // 5. Reuse existing deterministic mobileAssistant intent parser (100% parity!)
  const detected = detectAssistantIntent(segment);
  if (!detected) return null;

  switch (detected.type) {
    case 'call':
      return {
        stepId,
        tool: 'sim_call',
        args: { phoneNumber: detected.target || '', target: detected.target || '' },
        requiredPermissions: ['CALL_PHONE', 'READ_CONTACTS'],
        requiresUserConfirmation: true,
        honestOutcomeNote: 'Initiates a standard Android SIM call via Telecom/Dialer.',
      };
    case 'whatsapp':
      return {
        stepId,
        tool: 'whatsapp_prepare',
        args: { phoneNumber: detected.target || '', message: detected.payload || '' },
        requiredPermissions: [],
        requiresUserConfirmation: true,
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
      return null;
  }
}

/**
 * Formats an honest post-action voice response (especially enforcing WhatsApp honesty).
 */
export function formatHonestTaskOutcome(tool: AllowedTaskTool, succeeded: boolean, detail?: string): string {
  if (!succeeded) {
    return detail || `কাজটি সম্পন্ন করা যায়নি (${tool})। অনুগ্রহ করে পারমিশন বা সেটিংস যাচাই করুন।`;
  }
  switch (tool) {
    case 'whatsapp_prepare':
      return 'WhatsApp-এ আপনার মেসেজ ড্রাফট প্রস্তুত করে খুলে দেওয়া হয়েছে। পাঠাতে অনুগ্রহ করে WhatsApp-এ Send চাপুন।';
    case 'sim_call':
      return detail || 'আপনার ফোনের সিম (SIM) ডায়ালারের মাধ্যমে কল শুরু করা হচ্ছে।';
    case 'sms_compose':
      return detail || 'SMS মেসেজ কম্পোজার প্রস্তুত করা হয়েছে।';
    case 'flashlight':
      return detail || 'ফ্ল্যাশলাইট আপডেট করা হয়েছে।';
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
