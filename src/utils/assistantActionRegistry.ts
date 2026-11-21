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
  | 'cancel_current_task';

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
  success: boolean;
  verified: boolean;
  awaitingConfirmation?: boolean;
  pendingActionId?: string;
  status: string;
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
    description: 'Prepare a WhatsApp message draft for a contact or phone number so the user can review, edit, cancel, or explicitly approve before opening WhatsApp. NEVER claim the message is already sent.',
    requiredPermissions: ['READ_CONTACTS'],
    requiresConfirmation: true,
    timeoutMs: 6000,
    parameters: {
      properties: {
        recipient: {
          type: 'STRING',
          description: 'Contact name (e.g., Rahul, Ma, Baba) or phone number.',
        },
        message: {
          type: 'STRING',
          description: 'The exact message body to prepare in Bengali, English, or Hindi.',
        },
      },
      required: ['recipient'],
    },
  },
  {
    name: 'prepare_sms',
    description: 'Prepare an SMS text message draft for a contact or phone number for explicit user review and approval before opening the SMS composer.',
    requiredPermissions: ['READ_CONTACTS'],
    requiresConfirmation: true,
    timeoutMs: 6000,
    parameters: {
      properties: {
        recipient: {
          type: 'STRING',
          description: 'Contact name or phone number.',
        },
        message: {
          type: 'STRING',
          description: 'The SMS text body to prepare.',
        },
      },
      required: ['recipient'],
    },
  },
  {
    name: 'prepare_app_chat_message',
    description: 'Prepare a chat message draft for a supported accessible messaging app (Telegram, Instagram, Messenger) so the user can review, edit, and explicitly approve before sending. NEVER sends silently.',
    requiredPermissions: ['ACCESSIBILITY_SERVICE'],
    requiresConfirmation: true,
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
          description: 'Exact message text to review and approve before sending.',
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
    description: 'Adjust Android media volume (up, down, mute, unmute, max, status).',
    requiredPermissions: [],
    requiresConfirmation: false,
    timeoutMs: 3000,
    parameters: {
      properties: {
        action: {
          type: 'STRING',
          description: 'Volume control action.',
          enum: ['up', 'down', 'mute', 'unmute', 'max', 'status'],
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
    description: 'Resolve a contact or phone number and request user confirmation before placing a SIM phone call.',
    requiredPermissions: ['READ_CONTACTS', 'CALL_PHONE'],
    requiresConfirmation: true,
    timeoutMs: 6000,
    parameters: {
      properties: {
        recipient: {
          type: 'STRING',
          description: 'Contact name or phone number to call.',
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

  if (report.status === 'whatsapp_sent_verified') {
    const recipient = report.data?.contactName || report.data?.phoneNumber || '';
    if (lang === 'bn-BD') {
      return `${name}, আপনার অনুমোদনের পর ${recipient ? `${recipient}-এর ` : ''}WhatsApp চ্যাটে Send বাটন চাপানো সম্পন্ন ও চ্যাটে যাচাই করা হয়েছে (ডেলিভারি/রিড স্ট্যাটাস WhatsApp নেটওয়ার্কের উপর নির্ভরশীল)।`;
    }
    if (lang === 'hi-IN') {
      return `${name}, आपकी अनुमति के बाद ${recipient ? `${recipient} की ` : ''}WhatsApp चैट में Send बटन दबाया और सत्यापित किया गया है (डिलीवरी/रीड स्थिति WhatsApp नेटवर्क पर निर्भर करती है)।`;
    }
    return `${name}, after your approval, WhatsApp Send was clicked and verified in chat${recipient ? ` for ${recipient}` : ''} (delivery/read status depends on WhatsApp network).`;
  }

  if (report.status === 'opened_whatsapp_draft_ready_to_send') {
    const recipient = report.data?.contactName || report.data?.phoneNumber || '';
    if (lang === 'bn-BD') {
      return `${name}, ${recipient ? `${recipient}-এর জন্য ` : ''}WhatsApp চ্যাটে আপনার মেসেজ ড্রাফট খুলে দেওয়া হয়েছে। মেসেজটি এখনো স্বয়ংক্রিয়ভাবে পাঠানো হয়নি — অনুগ্রহ করে WhatsApp-এ Send বাটন চাপুন।`;
    }
    if (lang === 'hi-IN') {
      return `${name}, ${recipient ? `${recipient} के लिए ` : ''}WhatsApp में आपका मैसेज ड्राफ्ट खोल दिया गया है। यह अपने आप नहीं भेजा गया है — कृपया WhatsApp में Send दबाएं।`;
    }
    return `${name}, I opened your WhatsApp draft${recipient ? ` for ${recipient}` : ''}. It has NOT been auto-sent — please review and tap Send in WhatsApp.`;
  }

  if (report.status === 'app_chat_sent_verified') {
    const appLabel = report.data?.appName || 'app';
    const recipient = report.data?.contactName || report.data?.recipient || '';
    if (lang === 'bn-BD') {
      return `${name}, আপনার অনুমোদনের পর ${appLabel}-এ ${recipient ? `${recipient}-কে ` : ''}মেসেজ পাঠানোর Send বাটন চাপানো ও যাচাই করা হয়েছে।`;
    }
    if (lang === 'hi-IN') {
      return `${name}, आपकी अनुमति के बाद ${appLabel} में ${recipient ? `${recipient} को ` : ''}मैसेज का Send बटन दबाया और सत्यापित किया गया है।`;
    }
    return `${name}, after your approval, Send was clicked and verified in ${appLabel}${recipient ? ` for ${recipient}` : ''}.`;
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
      return `${name}, আপনার অনুমোদিত উত্তরটি অ্যান্ড্রয়েড নোটিফিকেশন রিপ্লাই-এর মাধ্যমে পাঠানো হয়েছে।`;
    }
    if (lang === 'hi-IN') {
      return `${name}, आपका अनुमोदित उत्तर Android नोटिफिकेशन रिप्लाई के ज़रिए भेज दिया गया है।`;
    }
    return `${name}, your approved reply was sent through Android Notification Reply.`;
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
