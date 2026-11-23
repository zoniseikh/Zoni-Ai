/**
 * Zoni AI — Shared Strict Allowlisted Assistant Action Registry (20 Tools).
 *
 * Client-safe single source of truth shared between Express backend (`server.ts`)
 * and React/Android WebView frontend (`src/App.tsx`).
 *
 * Security invariants:
 * - Only the 20 allowlisted Android personal assistant tools can ever be invoked.
 * - Arbitrary shell commands, JavaScript evaluation, unrestricted intents, and
 *   arbitrary file operations are strictly rejected.
 * - Communication actions (`prepare_whatsapp_message`, `prepare_sms`, `call_contact`)
 *   ALWAYS require explicit user review & confirmation before execution.
 */

export type AssistantToolName =
  | 'list_installed_apps'
  | 'open_app'
  | 'open_system_settings'
  | 'go_home'
  | 'go_back'
  | 'scroll_screen'
  | 'tap_visible_element'
  | 'enter_text_in_visible_field'
  | 'read_visible_screen'
  | 'read_notifications'
  | 'prepare_whatsapp_message'
  | 'prepare_sms'
  | 'prepare_app_chat_message'
  | 'request_permission'
  | 'flashlight_control'
  | 'volume_control'
  | 'battery_status'
  | 'camera_open'
  | 'contact_search'
  | 'call_contact'
  | 'create_reminder'
  | 'search_web'
  | 'search_youtube'
  | 'search_installed_app'
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

export interface AssistantToolParamSpec {
  type: 'STRING' | 'BOOLEAN' | 'INTEGER';
  description: string;
  enum?: string[];
}

export interface AssistantToolSpec {
  name: AssistantToolName;
  description: string;
  requiredPermissions: string[];
  requiresConfirmation: boolean;
  timeoutMs: number;
  parameters: {
    properties: Record<string, AssistantToolParamSpec>;
    required: string[];
  };
}

export interface ValidatedActionRequest {
  actionId: string;
  actionType: AssistantToolName;
  arguments: Record<string, string | boolean | number>;
  requiredPermissions: string[];
  requiresConfirmation: boolean;
  timeoutMs: number;
}

export interface ToolValidationResult {
  valid: boolean;
  request?: ValidatedActionRequest;
  blockedReason?: string;
}

export interface ToolExecutionReport {
  actionId: string;
  actionType: AssistantToolName | string;
  target?: string;
  success: boolean;
  verified: boolean;
  awaitingConfirmation?: boolean;
  pendingActionId?: string;
  status: string;
  executionStatus?: string;
  message: string;
  failureReason?: string;
  requiredPermissions?: string[];
  data?: Record<string, any>;
}

export const ASSISTANT_TOOL_SPECS: readonly AssistantToolSpec[] = [
  {
    name: 'list_installed_apps',
    description: 'List installed launchable apps on the Android phone so the assistant can verify what apps exist.',
    requiredPermissions: [],
    requiresConfirmation: false,
    timeoutMs: 4000,
    parameters: {
      properties: {},
      required: [],
    },
  },
  {
    name: 'open_app',
    description: 'Launch an installed Android app by name (English, Bengali, or Hindi, e.g., WhatsApp, YouTube, Chrome, Instagram, Calculator). Optionally pass search_query for a verified search workflow.',
    requiredPermissions: [],
    requiresConfirmation: false,
    timeoutMs: 4000,
    parameters: {
      properties: {
        app_name: {
          type: 'STRING',
          description: 'Name of the installed app to open (e.g., WhatsApp, YouTube, Chrome, Instagram, Calculator).',
        },
        search_query: {
          type: 'STRING',
          description: 'Optional query to search inside the app using verified accessibility workflow (e.g., songs on YouTube).',
        },
      },
      required: ['app_name'],
    },
  },
  {
    name: 'open_system_settings',
    description: 'Open an Android system settings screen (main, wifi, bluetooth, display, location, sound, accessibility, notifications, battery, overlay, default_assistant).',
    requiredPermissions: [],
    requiresConfirmation: false,
    timeoutMs: 4000,
    parameters: {
      properties: {
        target: {
          type: 'STRING',
          description: 'Target Android settings section.',
          enum: [
            'main',
            'wifi',
            'bluetooth',
            'display',
            'location',
            'sound',
            'network',
            'applications',
            'app_details',
            'accessibility',
            'notifications',
            'battery',
            'overlay',
            'default_assistant',
          ],
        },
      },
      required: ['target'],
    },
  },
  {
    name: 'go_home',
    description: 'Navigate to the Android Home screen via Accessibility Service.',
    requiredPermissions: ['ACCESSIBILITY_SERVICE'],
    requiresConfirmation: false,
    timeoutMs: 3000,
    parameters: {
      properties: {},
      required: [],
    },
  },
  {
    name: 'go_back',
    description: 'Navigate Back on Android via Accessibility Service.',
    requiredPermissions: ['ACCESSIBILITY_SERVICE'],
    requiresConfirmation: false,
    timeoutMs: 3000,
    parameters: {
      properties: {},
      required: [],
    },
  },
  {
    name: 'scroll_screen',
    description: 'Scroll the active Android screen up or down via Accessibility Service.',
    requiredPermissions: ['ACCESSIBILITY_SERVICE'],
    requiresConfirmation: false,
    timeoutMs: 4000,
    parameters: {
      properties: {
        direction: {
          type: 'STRING',
          description: 'Scroll direction: "down" or "up".',
          enum: ['down', 'up'],
        },
      },
      required: ['direction'],
    },
  },
  {
    name: 'tap_visible_element',
    description: 'Tap a visible non-password UI button or label on the current Android screen via Accessibility Service.',
    requiredPermissions: ['ACCESSIBILITY_SERVICE'],
    requiresConfirmation: false,
    timeoutMs: 4000,
    parameters: {
      properties: {
        element_text: {
          type: 'STRING',
          description: 'Exact or partial visible text/label of the UI button to tap.',
        },
      },
      required: ['element_text'],
    },
  },
  {
    name: 'enter_text_in_visible_field',
    description: 'Enter user-requested text into a visible non-password editable text field on the current screen.',
    requiredPermissions: ['ACCESSIBILITY_SERVICE'],
    requiresConfirmation: false,
    timeoutMs: 4000,
    parameters: {
      properties: {
        field_hint: {
          type: 'STRING',
          description: 'Visible hint or label of the target input field (e.g., Search).',
        },
        text: {
          type: 'STRING',
          description: 'The exact text to enter into the non-password input field.',
        },
      },
      required: ['text'],
    },
  },
  {
    name: 'read_visible_screen',
    description: 'Read non-sensitive visible text labels from the current Android screen when the user asks what is on their screen.',
    requiredPermissions: ['ACCESSIBILITY_SERVICE'],
    requiresConfirmation: false,
    timeoutMs: 4000,
    parameters: {
      properties: {
        question: {
          type: 'STRING',
          description: 'Optional user question about the current screen.',
        },
      },
      required: [],
    },
  },
  {
    name: 'read_notifications',
    description: 'Read recent non-sensitive local Android notifications (WhatsApp/SMS/apps) when Notification Listener access is enabled.',
    requiredPermissions: ['NOTIFICATION_LISTENER'],
    requiresConfirmation: false,
    timeoutMs: 3000,
    parameters: {
      properties: {
        whatsapp_only: {
          type: 'BOOLEAN',
          description: 'Set to true if the user asked specifically for WhatsApp notifications.',
        },
      },
      required: [],
    },
  },
  {
    name: 'prepare_whatsapp_message',
    description: 'Send a WhatsApp message directly to an explicitly requested contact or phone number using native Android WhatsApp and Accessibility integration. Do NOT ask for routine confirmation when the user explicitly instructed to send a message. Ask ONLY if multiple contacts match or the message body is missing. Never guess an unknown phone number, never alter the user message, and never fabricate delivery.',
    requiredPermissions: ['READ_CONTACTS'],
    requiresConfirmation: false,
    timeoutMs: 6000,
    parameters: {
      properties: {
        recipient: {
          type: 'STRING',
          description: 'Contact name (e.g., Rahul, Ma, Baba) or exact phone number.',
        },
        recipient_name: {
          type: 'STRING',
          description: 'Optional display contact name when recipient is a resolved phone number.',
        },
        message: {
          type: 'STRING',
          description: 'The exact unmodified message body requested by the user in Bengali, English, or Hindi.',
        },
      },
      required: ['recipient'],
    },
  },
  {
    name: 'prepare_sms',
    description: 'Send an SMS directly to an explicitly requested contact or phone number using authorized Android SMS functionality (SmsManager when SEND_SMS is granted, or Android SMS composer fallback when permission is missing). Do NOT ask for routine confirmation. Ask ONLY when multiple contacts match or message text is missing. Never guess unknown numbers or alter the message.',
    requiredPermissions: ['READ_CONTACTS', 'SEND_SMS'],
    requiresConfirmation: false,
    timeoutMs: 6000,
    parameters: {
      properties: {
        recipient: {
          type: 'STRING',
          description: 'Contact name or exact phone number.',
        },
        recipient_name: {
          type: 'STRING',
          description: 'Optional display contact name when recipient is a resolved phone number.',
        },
        message: {
          type: 'STRING',
          description: 'The exact unmodified SMS text body requested by the user.',
        },
      },
      required: ['recipient'],
    },
  },
  {
    name: 'prepare_app_chat_message',
    description: 'Send a chat message directly in a supported messaging app (Telegram, Instagram, Messenger) using verified Accessibility adapters when explicitly requested by the user. Do NOT ask for routine confirmation. Never alter the message or fabricate delivery.',
    requiredPermissions: ['ACCESSIBILITY_SERVICE'],
    requiresConfirmation: false,
    timeoutMs: 6000,
    parameters: {
      properties: {
        app_name: {
          type: 'STRING',
          description: 'Supported messaging app name (Telegram, Instagram, or Messenger).',
        },
        recipient: {
          type: 'STRING',
          description: 'Target chat recipient name or username.',
        },
        message: {
          type: 'STRING',
          description: 'Exact unmodified message text requested by the user.',
        },
      },
      required: ['app_name', 'recipient'],
    },
  },
  {
    name: 'request_permission',
    description: 'Prompt the user or open the Android permission setup screen for a specific missing permission.',
    requiredPermissions: [],
    requiresConfirmation: false,
    timeoutMs: 5000,
    parameters: {
      properties: {
        permission: {
          type: 'STRING',
          description: 'Permission key to request (microphone, contacts, notifications, notification_listener, accessibility, screen_capture, overlay, battery, default_assistant, camera, calls).',
        },
      },
      required: ['permission'],
    },
  },
  {
    name: 'flashlight_control',
    description: 'Turn the Android phone hardware flashlight (torch light) ON or OFF.',
    requiredPermissions: ['CAMERA'],
    requiresConfirmation: false,
    timeoutMs: 3000,
    parameters: {
      properties: {
        enable: {
          type: 'BOOLEAN',
          description: 'True to turn ON flashlight, False to turn OFF flashlight.',
        },
      },
      required: ['enable'],
    },
  },
  {
    name: 'volume_control',
    description:
      'Adjust Android device volume accurately across media, ring, alarm, call, or notification streams (up, down, set percentage 0-100, mute, unmute, max, status).',
    requiredPermissions: [],
    requiresConfirmation: false,
    timeoutMs: 3000,
    parameters: {
      properties: {
        action: {
          type: 'STRING',
          description: 'Volume control action (use "set" with percent for exact percentage).',
          enum: ['up', 'down', 'set', 'mute', 'unmute', 'max', 'status'],
        },
        percent: {
          type: 'INTEGER',
          description: 'Target volume percentage from 0 to 100 (used when action is "set").',
        },
        stream: {
          type: 'STRING',
          description: 'Android audio stream to adjust (defaults to "media").',
          enum: ['media', 'ring', 'alarm', 'call', 'notification'],
        },
      },
      required: ['action'],
    },
  },
  {
    name: 'battery_status',
    description: 'Check the current Android device battery percentage and charging status.',
    requiredPermissions: [],
    requiresConfirmation: false,
    timeoutMs: 2000,
    parameters: {
      properties: {},
      required: [],
    },
  },
  {
    name: 'camera_open',
    description: 'Open the Android device camera app.',
    requiredPermissions: ['CAMERA'],
    requiresConfirmation: false,
    timeoutMs: 4000,
    parameters: {
      properties: {},
      required: [],
    },
  },
  {
    name: 'contact_search',
    description: 'Search Android Contacts by name (requires READ_CONTACTS permission).',
    requiredPermissions: ['READ_CONTACTS'],
    requiresConfirmation: false,
    timeoutMs: 4000,
    parameters: {
      properties: {
        query: {
          type: 'STRING',
          description: 'Contact name to search for (e.g., Rahul, Ma, Baba).',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'call_contact',
    description: 'Resolve a contact or phone number and initiate a direct SIM phone call immediately via Android native calling APIs. Do NOT ask for routine confirmation. Ask ONLY when multiple contacts or multiple phone numbers match. Never guess an unknown phone number.',
    requiredPermissions: ['READ_CONTACTS', 'CALL_PHONE'],
    requiresConfirmation: false,
    timeoutMs: 6000,
    parameters: {
      properties: {
        recipient: {
          type: 'STRING',
          description: 'Contact name or exact phone number to call.',
        },
        recipient_name: {
          type: 'STRING',
          description: 'Optional display contact name when recipient is a resolved phone number.',
        },
      },
      required: ['recipient'],
    },
  },
  {
    name: 'create_reminder',
    description: 'Create a local Android reminder notification with a note and optional time.',
    requiredPermissions: ['POST_NOTIFICATIONS'],
    requiresConfirmation: false,
    timeoutMs: 4000,
    parameters: {
      properties: {
        note: {
          type: 'STRING',
          description: 'Reminder text/note.',
        },
        time: {
          type: 'STRING',
          description: 'Optional time description for the reminder.',
        },
      },
      required: ['note'],
    },
  },
  {
    name: 'search_web',
    description: 'Search the web for the user query in the browser or Google Search.',
    requiredPermissions: [],
    requiresConfirmation: false,
    timeoutMs: 4000,
    parameters: {
      properties: {
        query: {
          type: 'STRING',
          description: 'Search query text.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'search_youtube',
    description: 'Search videos or songs on YouTube.',
    requiredPermissions: [],
    requiresConfirmation: false,
    timeoutMs: 5000,
    parameters: {
      properties: {
        query: {
          type: 'STRING',
          description: 'Video, song, or channel query to search on YouTube.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'search_installed_app',
    description: 'Check whether an app is installed on the Android device by name or package.',
    requiredPermissions: [],
    requiresConfirmation: false,
    timeoutMs: 3000,
    parameters: {
      properties: {
        app_name: {
          type: 'STRING',
          description: 'App name or keyword to search among installed apps.',
        },
      },
      required: ['app_name'],
    },
  },
  {
    name: 'cancel_current_task',
    description: 'Cancel any currently active task, speech playback, or pending communication draft.',
    requiredPermissions: [],
    requiresConfirmation: false,
    timeoutMs: 2000,
    parameters: {
      properties: {},
      required: [],
    },
  },
  {
    name: 'click_youtube_video',
    description:
      'Click or play a visible YouTube video card, thumbnail, or Play button on screen (e.g., 1st video, 2nd video, this video, thumbnail, Play button) via Accessibility semantic click & bounded gesture fallback, and verify the watch screen opens.',
    requiredPermissions: ['ACCESSIBILITY_SERVICE'],
    requiresConfirmation: false,
    timeoutMs: 5000,
    parameters: {
      properties: {
        index: {
          type: 'INTEGER',
          description: '1-based visible video position (e.g., 1 for first video, 2 for second video).',
        },
        target: {
          type: 'STRING',
          description: 'Target hint such as "play_button", "thumbnail", "current_video", or button label.',
        },
        query: {
          type: 'STRING',
          description: 'Optional visible video title keywords to match unambiguously.',
        },
      },
      required: [],
    },
  },
  {
    name: 'click_youtube_search_result',
    description:
      'Click a visible YouTube search result entry (e.g., first search result, second search result) and verify the video screen opens.',
    requiredPermissions: ['ACCESSIBILITY_SERVICE'],
    requiresConfirmation: false,
    timeoutMs: 5000,
    parameters: {
      properties: {
        index: {
          type: 'INTEGER',
          description: '1-based visible search result position (defaults to 1).',
        },
        query: {
          type: 'STRING',
          description: 'Optional video title keywords inside the search results.',
        },
      },
      required: [],
    },
  },
  {
    name: 'click_visible_element',
    description:
      'Find and click any clearly identified visible UI element, thumbnail, or button on screen using semantic Accessibility nodes and bounded visible bounds.',
    requiredPermissions: ['ACCESSIBILITY_SERVICE'],
    requiresConfirmation: false,
    timeoutMs: 4500,
    parameters: {
      properties: {
        target: {
          type: 'STRING',
          description: 'Visible label, button name, or thumbnail hint to click.',
        },
        index: {
          type: 'INTEGER',
          description: 'Optional 1-based ordinal index when selecting from visible items.',
        },
      },
      required: ['target'],
    },
  },
  {
    name: 'click_whatsapp_contact',
    description:
      'Find and click a clearly identified visible contact name, chat name, or ordinal contact row inside WhatsApp (supports Bengali, English, and Hindi names; asks if multiple contacts match).',
    requiredPermissions: ['ACCESSIBILITY_SERVICE'],
    requiresConfirmation: false,
    timeoutMs: 6000,
    parameters: {
      properties: {
        contact_name: {
          type: 'STRING',
          description: 'Contact, person, or group chat name in Bengali, English, or Hindi (e.g., রাহুল, Rahul, মা, জাহিদা).',
        },
        index: {
          type: 'INTEGER',
          description: 'Optional 1-based visible contact row index (e.g., 2 for second contact).',
        },
        search_if_missing: {
          type: 'BOOLEAN',
          description: 'Whether to search in WhatsApp if the contact is not currently visible in the chat list.',
        },
      },
      required: [],
    },
  },
  {
    name: 'open_whatsapp_chat',
    description:
      'Open a specific WhatsApp conversation by contact name (Bengali, English, or Hindi) or ordinal chat position and verify the conversation opened.',
    requiredPermissions: ['ACCESSIBILITY_SERVICE'],
    requiresConfirmation: false,
    timeoutMs: 6000,
    parameters: {
      properties: {
        contact_name: {
          type: 'STRING',
          description: 'Contact or chat name to open in WhatsApp.',
        },
        index: {
          type: 'INTEGER',
          description: 'Optional 1-based chat index (e.g., 1 for first chat, 2 for second chat).',
        },
      },
      required: [],
    },
  },
  {
    name: 'type_whatsapp_message',
    description:
      'Type an exact user-provided message into the visible WhatsApp composer WITHOUT tapping Send (typing alone does not authorize sending).',
    requiredPermissions: ['ACCESSIBILITY_SERVICE'],
    requiresConfirmation: false,
    timeoutMs: 6000,
    parameters: {
      properties: {
        recipient: {
          type: 'STRING',
          description: 'Optional expected recipient name to verify before typing.',
        },
        message: {
          type: 'STRING',
          description: 'Exact unmodified message text to enter into the WhatsApp composer.',
        },
      },
      required: ['message'],
    },
  },
  {
    name: 'send_whatsapp_message',
    description:
      'Directly send an explicitly user-authorized WhatsApp message: resolves recipient safely (asks only on multiple matches), verifies conversation and exact message text, clicks the real visible Send button via semantic Accessibility, and verifies the outgoing message state.',
    requiredPermissions: ['ACCESSIBILITY_SERVICE'],
    requiresConfirmation: false,
    timeoutMs: 8000,
    parameters: {
      properties: {
        recipient: {
          type: 'STRING',
          description: 'Recipient name or phone number (optional if already inside the target WhatsApp chat).',
        },
        recipient_name: {
          type: 'STRING',
          description: 'Optional verified recipient display name.',
        },
        message: {
          type: 'STRING',
          description: 'Exact unmodified message text to send.',
        },
      },
      required: ['message'],
    },
  },
  {
    name: 'verify_whatsapp_send',
    description:
      'Inspect the active WhatsApp conversation screen to verify whether an outgoing message appeared and distinguish pending, sent, or delivered status honestly.',
    requiredPermissions: ['ACCESSIBILITY_SERVICE'],
    requiresConfirmation: false,
    timeoutMs: 4000,
    parameters: {
      properties: {
        recipient: {
          type: 'STRING',
          description: 'Optional recipient name for reporting.',
        },
        message: {
          type: 'STRING',
          description: 'Exact outgoing message text to verify in the visible conversation.',
        },
      },
      required: ['message'],
    },
  },
  {
    name: 'answer_incoming_call',
    description:
      'Answer a currently ringing incoming SIM phone call via supported Android TelecomManager / InCallService APIs ONLY when the user explicitly requests receiving or answering the call. Verifies call state and reports real success or missing permission honestly.',
    requiredPermissions: ['READ_PHONE_STATE', 'ANSWER_PHONE_CALLS'],
    requiresConfirmation: false,
    timeoutMs: 4000,
    parameters: {
      properties: {},
      required: [],
    },
  },
  {
    name: 'reject_incoming_call',
    description:
      'Reject a currently ringing incoming SIM phone call via supported Android TelecomManager / InCallService APIs ONLY when the user explicitly requests rejecting or declining the call. Verifies call state and reports real outcome honestly.',
    requiredPermissions: ['READ_PHONE_STATE', 'ANSWER_PHONE_CALLS'],
    requiresConfirmation: false,
    timeoutMs: 4000,
    parameters: {
      properties: {},
      required: [],
    },
  },
  {
    name: 'end_active_call',
    description:
      'End an active or dialing SIM phone call via supported Android TelecomManager / InCallService APIs ONLY when the user explicitly requests ending or hanging up the call. Verifies disconnected state honestly.',
    requiredPermissions: ['READ_PHONE_STATE', 'ANSWER_PHONE_CALLS'],
    requiresConfirmation: false,
    timeoutMs: 4000,
    parameters: {
      properties: {},
      required: [],
    },
  },
] as const;

export const ASSISTANT_TOOL_MAP: ReadonlyMap<AssistantToolName, AssistantToolSpec> = new Map(
  ASSISTANT_TOOL_SPECS.map((spec) => [spec.name, spec])
);

const FORBIDDEN_ARGUMENT_PATTERNS = [
  /\b(?:rm\s+-rf|sudo|chmod|chown|mkfs|dd\s+if=|curl\s+.*\|\s*sh|wget\s+.*\|\s*sh|bash\s+-c|sh\s+-c|su\s+-c)\b/i,
  /(?:javascript:|eval\s*\(|new\s+Function\s*\(|file:\/\/\/etc\/|\/system\/bin\/)/i,
];

let actionSeq = 1;

export function isAllowlistedAssistantTool(name: string): name is AssistantToolName {
  return ASSISTANT_TOOL_MAP.has(name as AssistantToolName);
}

/**
 * Validates any Gemini FunctionCall or client-planned tool call against the strict 20-tool allowlist.
 * Rejects disallowed tools, shell/JS/file payloads, and missing required arguments.
 */
export function validateGeminiToolCall(
  rawName: string,
  rawArgs: Record<string, unknown> | undefined | null,
  providedId?: string
): ToolValidationResult {
  const rawClean = String(rawName || '').trim().toLowerCase();
  const cleanName =
    rawClean === 'search_contacts'
      ? 'contact_search'
      : rawClean === 'set_flashlight'
      ? 'flashlight_control'
      : rawClean;
  if (!isAllowlistedAssistantTool(cleanName)) {
    return {
      valid: false,
      blockedReason: `Blocked disallowed tool "${rawClean}". Only allowlisted Android assistant tools are permitted.`,
    };
  }

  const spec = ASSISTANT_TOOL_MAP.get(cleanName)!;
  const argsInput = rawArgs && typeof rawArgs === 'object' ? rawArgs : {};
  const sanitizedArgs: Record<string, string | boolean | number> = {};

  for (const [key, paramSpec] of Object.entries(spec.parameters.properties)) {
    const val = argsInput[key];
    if (val === undefined || val === null || val === '') continue;

    if (paramSpec.type === 'BOOLEAN') {
      sanitizedArgs[key] =
        typeof val === 'boolean' ? val : String(val).trim().toLowerCase() === 'true';
    } else if (paramSpec.type === 'INTEGER') {
      const parsed = Number(val);
      if (!Number.isFinite(parsed)) {
        return { valid: false, blockedReason: `Invalid numeric argument "${key}" for ${cleanName}.` };
      }
      sanitizedArgs[key] = Math.round(parsed);
    } else {
      const strVal = String(val).trim().slice(0, 1000);
      for (const pattern of FORBIDDEN_ARGUMENT_PATTERNS) {
        if (pattern.test(strVal)) {
          return {
            valid: false,
            blockedReason: `Blocked unsafe payload in "${key}" for ${cleanName} by Zoni AI security policy.`,
          };
        }
      }
      if (paramSpec.enum && !paramSpec.enum.includes(strVal.toLowerCase())) {
        return {
          valid: false,
          blockedReason: `Unsupported value "${strVal}" for "${key}" in ${cleanName}.`,
        };
      }
      sanitizedArgs[key] = paramSpec.enum ? strVal.toLowerCase() : strVal;
    }
  }

  for (const reqKey of spec.parameters.required) {
    const val = sanitizedArgs[reqKey];
    if (val === undefined || val === '') {
      return {
        valid: false,
        blockedReason: `Missing required argument "${reqKey}" for ${cleanName}.`,
      };
    }
  }

  const actionId =
    providedId && providedId.trim()
      ? providedId.trim()
      : `act_${Date.now()}_${actionSeq++}`;

  return {
    valid: true,
    request: {
      actionId,
      actionType: cleanName,
      arguments: sanitizedArgs,
      requiredPermissions: [...spec.requiredPermissions],
      requiresConfirmation: spec.requiresConfirmation,
      timeoutMs: spec.timeoutMs,
    },
  };
}

/**
 * Formats an honest localized (Bengali/Hindi/English) user-facing summary of a verified tool result.
 * Enforces strict honesty: NEVER claims a WhatsApp/SMS was sent if only a draft was opened.
 */
export function formatLocalizedActionOutcome(
  report: ToolExecutionReport,
  lang: string = 'bn-BD',
  affectionName: string = 'Boss'
): string {
  const name = affectionName || 'Boss';
  if (report.status === 'permission_missing') {
    const perms = (report.requiredPermissions || []).join(', ');
    if (lang === 'bn-BD') {
      return `${name}, এই কাজটির জন্য অ্যান্ড্রয়েড পারমিশন প্রয়োজন (${perms || 'Permission'})। অনুগ্রহ করে Setup থেকে অনুমতি দিন। (${report.message})`;
    }
    if (lang === 'hi-IN') {
      return `${name}, इस काम के लिए Android अनुमति आवश्यक है (${perms || 'Permission'})। कृपया Setup से अनुमति दें। (${report.message})`;
    }
    return `${name}, Android permission is required (${perms || 'Permission'}): ${report.message}`;
  }

  if (report.status === 'blocked') {
    if (lang === 'bn-BD') {
      return `${name}, নিরাপত্তার কারণে এই কাজটি ব্লক করা হয়েছে: ${report.message}`;
    }
    if (lang === 'hi-IN') {
      return `${name}, सुरक्षा कारणों से यह कार्रवाई रोकी गई है: ${report.message}`;
    }
    return `Blocked for your security, ${name}: ${report.message}`;
  }

  if (report.status === 'multiple_contacts' || report.status === 'multiple_numbers') {
    const query = String(report.data?.recipient || report.data?.query || '');
    if (lang === 'bn-BD') {
      return `${name}, ${query ? `"${query}" নামে ` : ''}একাধিক কন্টাক্ট বা নম্বর পাওয়া গেছে। সঠিক কন্টাক্টটি নিচে থেকে বেছে নিন — সাথে সাথেই কাজটি সম্পন্ন হবে।`;
    }
    if (lang === 'hi-IN') {
      return `${name}, ${query ? `"${query}" नाम से ` : ''}एक से अधिक कॉन्टैक्ट या नंबर मिले हैं। कृपया नीचे से सही कॉन्टैक्ट चुनें — कार्रवाई तुरंत हो जाएगी।`;
    }
    return `${name}, multiple matching contacts or numbers were found${query ? ` for "${query}"` : ''}. Please pick the right contact below to proceed immediately.`;
  }

  if (report.status === 'contact_not_found') {
    if (lang === 'bn-BD') {
      return `${name}, আপনার ফোনের কন্টাক্টে এই নামটি খুঁজে পাওয়া যায়নি। সঠিক ফোন নম্বর বললে আমি সরাসরি কাজটি করে দিতে পারব।`;
    }
    if (lang === 'hi-IN') {
      return `${name}, आपके कॉन्टैक्ट्स में यह नाम नहीं मिला। कृपया सही फ़ोन नंबर बताएं।`;
    }
    return `${name}, I could not find that contact in your phonebook. Please share the exact phone number instead.`;
  }

  if (report.status === 'duplicate_blocked') {
    if (lang === 'bn-BD') {
      return `${name}, একই মেসেজ বা কল ডুপ্লিকেট হওয়া আটকাতে এটি আবার পাঠানো হয়নি।`;
    }
    if (lang === 'hi-IN') {
      return `${name}, डुप्लीकेट भेजने से रोकने के लिए वही कार्रवाई दोबारा नहीं की गई।`;
    }
    return `${name}, duplicate send prevented — that exact action was just executed.`;
  }

  if (report.status === 'call_initiated') {
    const recipient = String(report.data?.contactName || report.data?.phoneNumber || '');
    if (lang === 'bn-BD') {
      return `${name}, ${recipient ? `${recipient}-কে ` : ''}সরাসরি ফোন কল শুরু করা হয়েছে।`;
    }
    if (lang === 'hi-IN') {
      return `${name}, ${recipient ? `${recipient} को ` : ''}सीधा फ़ोन कॉल शुरू कर दिया गया है।`;
    }
    return `${name}, direct phone call initiated${recipient ? ` to ${recipient}` : ''}.`;
  }

  if (report.status === 'dialer_opened') {
    const recipient = String(report.data?.contactName || report.data?.phoneNumber || '');
    if (lang === 'bn-BD') {
      return `${name}, ${recipient ? `${recipient}-এর নম্বরসহ ` : ''}ফোনের ডায়ালার খোলা হয়েছে (সরাসরি কল করার জন্য Android-এ CALL_PHONE পারমিশন চালু রাখুন)।`;
    }
    if (lang === 'hi-IN') {
      return `${name}, ${recipient ? `${recipient} के नंबर के साथ ` : ''}डायलर खोला गया है (सीधी कॉल के लिए CALL_PHONE अनुमति दें)।`;
    }
    return `${name}, opened the phone dialer${recipient ? ` for ${recipient}` : ''} (grant CALL_PHONE permission for direct 1-step dialing).`;
  }

  if (report.status === 'sms_sent_direct') {
    const recipient = String(report.data?.contactName || report.data?.phoneNumber || '');
    if (lang === 'bn-BD') {
      return `${name}, ${recipient ? `${recipient}-কে ` : ''}আপনার SMS সরাসরি Android SMS সার্ভিসের মাধ্যমে পাঠানো হয়েছে (নেটওয়ার্ক ডেলিভারি আপনার সিম ও অপারেটরের উপর নির্ভরশীল)।`;
    }
    if (lang === 'hi-IN') {
      return `${name}, ${recipient ? `${recipient} को ` : ''}आपका SMS सीधे Android SMS सेवा के माध्यम से भेज दिया गया है।`;
    }
    return `${name}, your SMS${recipient ? ` to ${recipient}` : ''} was submitted directly via Android SMS (delivery depends on carrier network).`;
  }

  if (report.status === 'opened_sms_composer_ready_to_send' || report.status === 'opened_sms_composer') {
    const recipient = String(report.data?.contactName || report.data?.phoneNumber || '');
    if (lang === 'bn-BD') {
      return `${name}, ${recipient ? `${recipient}-এর জন্য ` : ''}SMS অ্যাপে আপনার মেসেজ প্রস্তুত করে খোলা হয়েছে। সরাসরি SMS পাঠাতে Android-এ SEND_SMS পারমিশন দিন, অথবা এখন SMS অ্যাপে Send চাপুন।`;
    }
    if (lang === 'hi-IN') {
      return `${name}, ${recipient ? `${recipient} के लिए ` : ''}SMS ऐप में आपका मैसेज तैयार करके खोला गया है। सीधे भेजने के लिए SEND_SMS अनुमति दें या Send दबाएं।`;
    }
    return `${name}, opened your SMS app${recipient ? ` for ${recipient}` : ''} with the exact message ready (grant SEND_SMS permission for direct sending, or tap Send now).`;
  }

  if (report.status === 'youtube_video_opened' || report.status === 'youtube_screen_transitioned') {
    const title = String(report.data?.title || report.target || '');
    if (lang === 'bn-BD') {
      return `${name}, YouTube-এ ${title ? `"${title}" ` : ''}ভিডিওটি ক্লিক করে ওপেন করা হয়েছে এবং প্লেয়ার স্ক্রিন যাচাই করা হয়েছে।`;
    }
    if (lang === 'hi-IN') {
      return `${name}, YouTube पर ${title ? `"${title}" ` : ''}वीडियो क्लिक करके खोल दिया गया है और प्लेयर स्क्रीन सत्यापित हो गई है।`;
    }
    return `${name}, clicked and verified opening ${title ? `"${title}"` : 'the requested video'} on YouTube.`;
  }

  if (report.status === 'youtube_click_unverified') {
    if (lang === 'bn-BD') {
      return `${name}, YouTube ভিডিওতে ক্লিক করা হয়েছে, কিন্তু প্লেয়ার স্ক্রিন খুলেছে কি না তা নিশ্চিতভাবে যাচাই করা যায়নি।`;
    }
    if (lang === 'hi-IN') {
      return `${name}, YouTube वीडियो पर क्लिक किया गया, लेकिन वीडियो प्लेयर खुलने की पुष्टि नहीं हो सकी।`;
    }
    return `${name}, I dispatched the click on YouTube, but could not verify that the video player opened.`;
  }

  if (report.status === 'ambiguous_target') {
    if (lang === 'bn-BD') {
      return `${name}, স্ক্রিনে একাধিক মিল পাওয়া গেছে — ভুল আইটেমে ক্লিক না করতে অনুগ্রহ করে নির্দিষ্ট করে বলুন (যেমন প্রথম বা দ্বিতীয়)।`;
    }
    if (lang === 'hi-IN') {
      return `${name}, स्क्रीन पर एक से अधिक मिलते-जुलते विकल्प हैं — कृपया स्पष्ट बताएं (जैसे पहला या दूसरा)।`;
    }
    return `${name}, multiple matching items are visible on screen — please clarify which one (e.g., first or second) so I do not click the wrong item.`;
  }

  if (report.status === 'whatsapp_contact_opened') {
    const contact = String(report.data?.contactName || report.target || '');
    if (lang === 'bn-BD') {
      return `${name}, WhatsApp-এ ${contact ? `${contact}-এর ` : ''}চ্যাট ক্লিক করে ওপেন করা হয়েছে এবং কনভার্সেশন হেডার যাচাই করা হয়েছে।`;
    }
    if (lang === 'hi-IN') {
      return `${name}, WhatsApp में ${contact ? `${contact} की ` : ''}चैट क्लिक करके खोल दी गई है और सत्यापित हो गई है।`;
    }
    return `${name}, clicked and opened ${contact ? `${contact}'s` : 'the requested'} WhatsApp chat and verified the conversation header.`;
  }

  if (report.status === 'whatsapp_message_typed_not_sent') {
    if (lang === 'bn-BD') {
      return `${name}, আপনার সম্পূর্ণ মেসেজটি WhatsApp কম্পোজারে লিখে যাচাই করা হয়েছে — শুধু লেখার নির্দেশ থাকায় Send চাপা হয়নি।`;
    }
    if (lang === 'hi-IN') {
      return `${name}, आपका पूरा मैसेज WhatsApp कंपोज़र में लिखकर सत्यापित किया गया है — भेजने का आदेश न होने के कारण Send नहीं दबाया गया।`;
    }
    return `${name}, typed and verified your exact message in the WhatsApp composer without tapping Send (typing alone does not authorize sending).`;
  }

  if (report.status === 'whatsapp_delivered_confirmed') {
    const recipient = report.data?.contactName || report.target || '';
    if (lang === 'bn-BD') {
      return `${name}, ${recipient ? `${recipient}-এর ` : ''}WhatsApp চ্যাটে আপনার মেসেজটি পাঠানো সম্পন্ন হয়েছে এবং চ্যাটে Delivered স্ট্যাটাস দেখা গেছে।`;
    }
    if (lang === 'hi-IN') {
      return `${name}, ${recipient ? `${recipient} की ` : ''}WhatsApp चैट में आपका मैसेज भेजा गया है और Delivered स्थिति दिखाई दे रही है।`;
    }
    return `${name}, your WhatsApp message${recipient ? ` to ${recipient}` : ''} was sent and the Delivered indicator is visible in chat.`;
  }

  if (report.status === 'whatsapp_sent_confirmed' || report.status === 'whatsapp_sent_verified') {
    const recipient = report.data?.contactName || report.data?.phoneNumber || report.target || '';
    if (lang === 'bn-BD') {
      return `${name}, ${recipient ? `${recipient}-এর ` : ''}WhatsApp চ্যাটে Send বাটন চাপানো সম্পন্ন ও আউটগোয়িং মেসেজ যাচাই করা হয়েছে (ডেলিভারি/রিড স্ট্যাটাস WhatsApp নেটওয়ার্কের উপর নির্ভরশীল)।`;
    }
    if (lang === 'hi-IN') {
      return `${name}, ${recipient ? `${recipient} की ` : ''}WhatsApp चैट में Send बटन दबाया और आउटगोइंग मैसेज सत्यापित किया गया है (डिलीवरी/रीड स्थिति WhatsApp नेटवर्क पर निर्भर करती है)।`;
    }
    return `${name}, WhatsApp Send was clicked and the outgoing message is verified in chat${recipient ? ` for ${recipient}` : ''} (delivery/read status depends on WhatsApp network).`;
  }

  if (report.status === 'whatsapp_sent_pending') {
    const recipient = report.data?.contactName || report.target || '';
    if (lang === 'bn-BD') {
      return `${name}, ${recipient ? `${recipient}-এর ` : ''}WhatsApp চ্যাটে মেসেজটি পাঠানো হয়েছে এবং বর্তমানে Pending/Sending অবস্থায় আছে।`;
    }
    if (lang === 'hi-IN') {
      return `${name}, ${recipient ? `${recipient} की ` : ''}WhatsApp चैट में मैसेज सबमिट हो गया है और अभी Pending/Sending स्थिति में है।`;
    }
    return `${name}, your WhatsApp message${recipient ? ` to ${recipient}` : ''} appears in chat with Pending/Sending status while waiting for network.`;
  }

  if (report.status === 'send_button_not_found' || report.status === 'whatsapp_send_unverified') {
    if (lang === 'bn-BD') {
      return `${name}, মেসেজটি WhatsApp-এ প্রস্তুত রয়েছে, তবে Send বাটন শনাক্ত বা পাঠানো নিশ্চিতভাবে যাচাই করা যায়নি। ডুপ্লিকেট এড়াতে অনুগ্রহ করে WhatsApp-এ দেখে নিন।`;
    }
    if (lang === 'hi-IN') {
      return `${name}, मैसेज WhatsApp में तैयार है, लेकिन Send बटन या भेजने की पुष्टि नहीं हो सकी। कृपया WhatsApp में जांच लें।`;
    }
    return `${name}, the message was prepared in WhatsApp, but the Send button or outgoing message could not be verified — please check WhatsApp so no duplicate is sent.`;
  }

  if (report.status === 'opened_whatsapp_draft_ready_to_send') {
    const recipient = report.data?.contactName || report.data?.phoneNumber || '';
    if (lang === 'bn-BD') {
      return `${name}, ${recipient ? `${recipient}-এর জন্য ` : ''}WhatsApp চ্যাটে আপনার মেসেজ ড্রাফট খুলে দেওয়া হয়েছে। মেসেজটি এখনো স্বয়ংক্রিয়ভাবে পাঠানো হয়নি — সরাসরি পাঠাতে Accessibility চালু রাখুন বা WhatsApp-এ Send চাপুন।`;
    }
    if (lang === 'hi-IN') {
      return `${name}, ${recipient ? `${recipient} के लिए ` : ''}WhatsApp में आपका मैसेज ड्राफ्ट खोल दिया गया है। यह अपने आप नहीं भेजा गया है — कृपया WhatsApp में Send दबाएं।`;
    }
    return `${name}, I opened your WhatsApp draft${recipient ? ` for ${recipient}` : ''}. It was NOT auto-sent — enable Accessibility for direct send or tap Send in WhatsApp.`;
  }

  if (report.status === 'app_chat_sent_verified') {
    const appLabel = report.data?.appName || 'app';
    const recipient = report.data?.contactName || report.data?.recipient || '';
    if (lang === 'bn-BD') {
      return `${name}, ${appLabel}-এ ${recipient ? `${recipient}-কে ` : ''}মেসেজ পাঠানোর Send বাটন চাপানো ও যাচাই করা হয়েছে।`;
    }
    if (lang === 'hi-IN') {
      return `${name}, ${appLabel} में ${recipient ? `${recipient} को ` : ''}मैसेज का Send बटन दबाया और सत्यापित किया गया है।`;
    }
    return `${name}, Send was clicked and verified in ${appLabel}${recipient ? ` for ${recipient}` : ''}.`;
  }

  if (report.status === 'opened_app_chat_draft_ready_to_send') {
    const appLabel = report.data?.appName || 'the app';
    if (lang === 'bn-BD') {
      return `${name}, ${appLabel} খোলা হয়েছে, তবে স্বয়ংক্রিয় Send সম্পন্ন হয়নি। অনুগ্রহ করে ${appLabel}-এ মেসেজটি যাচাই করে Send চাপুন।`;
    }
    if (lang === 'hi-IN') {
      return `${name}, ${appLabel} खोला गया है, लेकिन अपने आप Send नहीं हुआ। कृपया ${appLabel} में मैसेज जांचकर Send दबाएं।`;
    }
    return `${name}, ${appLabel} was opened, but automated Send could not be verified — please review and tap Send manually.`;
  }

  if (report.status === 'replied_via_notification_remote_input') {
    if (lang === 'bn-BD') {
      return `${name}, আপনার উত্তরটি অ্যান্ড্রয়েড নোটিফিকেশন রিপ্লাই-এর মাধ্যমে পাঠানো হয়েছে।`;
    }
    if (lang === 'hi-IN') {
      return `${name}, आपका उत्तर Android नोटिफिकेशन रिप्लाई के ज़रिए भेज दिया गया है।`;
    }
    return `${name}, your reply was sent through Android Notification Reply.`;
  }

  if (report.status === 'call_answered') {
    if (lang === 'bn-BD') {
      return `${name}, ইনকামিং ফোন কলটি রিসিভ করা হয়েছে।`;
    }
    if (lang === 'hi-IN') {
      return `${name}, इनकमिंग फ़ोन कॉल रिसीव कर लिया गया है।`;
    }
    return `${name}, the incoming phone call has been answered.`;
  }

  if (report.status === 'call_rejected') {
    if (lang === 'bn-BD') {
      return `${name}, ইনকামিং ফোন কলটি রিজেক্ট করা হয়েছে।`;
    }
    if (lang === 'hi-IN') {
      return `${name}, इनकमिंग फ़ोन कॉल रिजेक्ट कर दिया गया है।`;
    }
    return `${name}, the incoming phone call has been rejected.`;
  }

  if (report.status === 'call_ended') {
    if (lang === 'bn-BD') {
      return `${name}, চলমান ফোন কলটি বন্ধ করা হয়েছে।`;
    }
    if (lang === 'hi-IN') {
      return `${name}, चल रहा फ़ोन कॉल समाप्त कर दिया गया है।`;
    }
    return `${name}, the active phone call has been ended.`;
  }

  if (report.status === 'no_ringing_call') {
    if (lang === 'bn-BD') {
      return `${name}, এই মুহূর্তে কোনো ইনকামিং রিং হওয়া কল শনাক্ত হয়নি।`;
    }
    if (lang === 'hi-IN') {
      return `${name}, इस समय कोई इनकमिंग कॉल रिंग नहीं हो रहा है।`;
    }
    return `${name}, no incoming ringing call is currently detected.`;
  }

  if (report.status === 'no_active_call') {
    if (lang === 'bn-BD') {
      return `${name}, এই মুহূর্তে কোনো চলমান কল পাওয়া যায়নি।`;
    }
    if (lang === 'hi-IN') {
      return `${name}, इस समय कोई सक्रिय कॉल नहीं चल रहा है।`;
    }
    return `${name}, no active phone call is currently in progress.`;
  }

  if (report.status === 'telecom_declined') {
    if (lang === 'bn-BD') {
      return `${name}, Android Telecom সিস্টেম কল কন্ট্রোল প্রত্যাখ্যান করেছে। এই ডিভাইসে কাজ করার জন্য Zoni AI-কে Default Dialer রোল দিতে হতে পারে।`;
    }
    if (lang === 'hi-IN') {
      return `${name}, Android Telecom ने कॉल कंट्रोल अस्वीकार किया है। इस डिवाइस पर Default Dialer रोल आवश्यक हो सकता है।`;
    }
    return `${name}, Android Telecom declined the call-control request. On this device, granting Default Dialer role (ROLE_DIALER) may be required.`;
  }

  if (report.status === 'cancelled') {
    if (lang === 'bn-BD') {
      return `ঠিক আছে ${name}, কাজটি বাতিল করা হয়েছে — কোনো মেসেজ বা কল করা হয়নি।`;
    }
    if (lang === 'hi-IN') {
      return `ठीक है ${name}, कार्रवाई रद्द कर दी गई है — कोई मैसेज या कॉल नहीं किया गया।`;
    }
    return `Cancelled, ${name}. Nothing was sent or dialed.`;
  }

  if (!report.success) {
    if (lang === 'bn-BD') {
      return `${name}, কাজটি সম্পন্ন করা যায়নি: ${report.message}`;
    }
    if (lang === 'hi-IN') {
      return `${name}, यह काम पूरा नहीं हो सका: ${report.message}`;
    }
    return `${name}, I could not complete that action: ${report.message}`;
  }

  return report.message;
}
