/**
 * Zoni AI — Direct Google Gemini BYOK Client (REST Chat, Tool Calling, Vision, TTS & Live WebSocket)
 *
 * Communicates directly with Google's official Gemini API endpoints using the
 * user's own Gemini API key — ZERO custom ZONI backend server required.
 *
 * Security invariants:
 * - REST endpoints authenticate via the `x-goog-api-key` HTTP header (never query params).
 * - WebSocket (`BidiGenerateContent`) authenticates directly to Google's official endpoint
 *   and every error/log string is scrubbed via `sanitizeGeminiSecret`.
 * - Preserves all 36 allowlisted ZONI assistant tools via `validateGeminiToolCall`.
 */

import { CompanionMode, SupportedLanguage } from '../types';
import {
  ASSISTANT_TOOL_SPECS,
  ToolExecutionReport,
  ValidatedActionRequest,
  validateGeminiToolCall,
} from './assistantActionRegistry';
import {
  detectDateTimeQuery,
  formatBengaliDate,
  formatBengaliSpokenTime,
  formatBengaliWeekday,
  getIndiaDateTimeSummary,
} from './bengaliDateTime';
import { sanitizeGeminiSecret } from './apiConfig';
import { StreamingSentenceChunker } from './streamingTts';

const CITY_TIMEZONE_MAP: Record<string, string> = {
  kolkata: 'Asia/Kolkata',
  india: 'Asia/Kolkata',
  delhi: 'Asia/Kolkata',
  mumbai: 'Asia/Kolkata',
  dhaka: 'Asia/Dhaka',
  bangladesh: 'Asia/Dhaka',
  london: 'Europe/London',
  uk: 'Europe/London',
  paris: 'Europe/Paris',
  dubai: 'Asia/Dubai',
  singapore: 'Asia/Singapore',
  tokyo: 'Asia/Tokyo',
  japan: 'Asia/Tokyo',
  sydney: 'Australia/Sydney',
  'new york': 'America/New_York',
  america: 'America/New_York',
  canada: 'America/Toronto',
  moscow: 'Europe/Moscow',
  russia: 'Europe/Moscow',
};

function getLiveTimeInfo(locationKey: string): {
  time12: string;
  time24: string;
  date: string;
  timezone: string;
} {
  const timezone = CITY_TIMEZONE_MAP[locationKey.toLowerCase()] || 'Asia/Kolkata';
  const now = new Date();
  const time12 = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(now);
  const time24 = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now);
  const date = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(now);
  return { time12, time24, date, timezone };
}

export const GEMINI_REST_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
export const GEMINI_LIVE_WS_ENDPOINT =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

// Ordered model candidates so both public Google AI Studio user keys and newer preview releases work seamlessly
export const DIRECT_CHAT_MODEL_CANDIDATES = [
  'gemini-2.5-flash',
  'gemini-4-hydrogen',
  'gemini-2.5-flash-lite',
] as const;

export const DIRECT_LIVE_MODEL_CANDIDATES = [
  'gemini-2.5-flash-native-audio-preview-12-2025',
  'gemini-2.5-flash-native-audio-preview-09-2025',
  'gemini-3.8-live',
] as const;

export const DIRECT_TTS_MODEL_CANDIDATES = [
  'gemini-2.5-flash-preview-tts',
  'gemini-3.8-flash-lite-tts',
] as const;

export type DirectGeminiErrorCode =
  | 'GEMINI_KEY_MISSING'
  | 'GEMINI_KEY_INVALID'
  | 'GEMINI_QUOTA_EXCEEDED'
  | 'GEMINI_MODEL_UNAVAILABLE'
  | 'GEMINI_TEMPORARILY_BUSY'
  | 'GEMINI_NETWORK_ERROR'
  | 'GEMINI_UPSTREAM_ERROR';

export interface ClassifiedGeminiError {
  code: DirectGeminiErrorCode;
  status: number;
  retryable: boolean;
  message: string;
}

export interface DirectGeminiVerificationResult {
  ok: boolean;
  code: DirectGeminiErrorCode | 'OK';
  statusText: string;
  message: string;
  verifiedModels: string[];
  preferredChatModel: string;
  preferredLiveModel: string;
}

export interface DirectGeminiChatResult {
  reply: string;
  toolCalls: ValidatedActionRequest[];
  blockedToolCalls: Array<{ name: string; reason: string }>;
  modelUsed: string;
  isDirectDateTime?: boolean;
}

export interface DirectLiveParsedEvent {
  type:
    | 'setup_complete'
    | 'audio'
    | 'user_transcript'
    | 'output_transcript'
    | 'text'
    | 'tool_call'
    | 'interrupted'
    | 'turn_complete'
    | 'session_resumption'
    | 'go_away'
    | 'unknown';
  audio?: string;
  text?: string;
  isFinal?: boolean;
  functionCalls?: Array<{ id?: string; name?: string; args?: Record<string, unknown> }>;
  newHandle?: string;
  resumable?: boolean;
  timeLeft?: string;
}

/**
 * Classifies direct Google Gemini HTTP/WebSocket errors into actionable user-safe
 * messages while strictly scrubbing any API key substring.
 */
export function classifyDirectGeminiError(
  errOrStatus: unknown,
  rawBodyText: string = '',
  lang: SupportedLanguage = 'en-US',
  explicitKey?: string
): ClassifiedGeminiError {
  const status =
    typeof errOrStatus === 'number'
      ? errOrStatus
      : typeof (errOrStatus as any)?.status === 'number'
      ? (errOrStatus as any).status
      : 0;

  const combinedRaw = [
    typeof errOrStatus === 'number' ? `HTTP ${errOrStatus}` : sanitizeGeminiSecret(errOrStatus, explicitKey),
    sanitizeGeminiSecret(rawBodyText, explicitKey),
  ]
    .filter(Boolean)
    .join(' — ');

  const lower = combinedRaw.toLowerCase();

  if (lower.includes('gemini_key_missing') || lower.includes('api key is required')) {
    return {
      code: 'GEMINI_KEY_MISSING',
      status: 400,
      retryable: false,
      message:
        lang === 'bn-BD'
          ? 'Gemini API Key সেট করা নেই। Setup বা Settings থেকে আপনার নিজের Gemini API Key দিন।'
          : lang === 'hi-IN'
          ? 'Gemini API Key सेट नहीं है। Setup या Settings में अपनी Gemini API Key दर्ज करें।'
          : 'Gemini API key is not configured. Enter your own Gemini API key in Setup or Settings.',
    };
  }

  if (
    status === 401 ||
    status === 403 ||
    lower.includes('api_key_invalid') ||
    lower.includes('api key not valid') ||
    lower.includes('invalid api key') ||
    lower.includes('permission_denied') ||
    lower.includes('unauthenticated')
  ) {
    return {
      code: 'GEMINI_KEY_INVALID',
      status: status || 401,
      retryable: false,
      message:
        lang === 'bn-BD'
          ? 'আপনার Gemini API Key-টি সঠিক নয় বা অনুমোদিত নয়। Google AI Studio থেকে বৈধ কী যাচাই করে আবার দিন।'
          : lang === 'hi-IN'
          ? 'आपकी Gemini API Key अमान्य या अनधिकृत है। कृपया Google AI Studio से सही कुंजी जाँचें।'
          : 'Your Gemini API key is invalid or unauthorized. Please verify or replace it in Settings.',
    };
  }

  if (
    status === 429 ||
    lower.includes('resource_exhausted') ||
    lower.includes('quota') ||
    lower.includes('rate limit')
  ) {
    return {
      code: 'GEMINI_QUOTA_EXCEEDED',
      status: 429,
      retryable: true,
      message:
        lang === 'bn-BD'
          ? 'আপনার Gemini API Key-এর কোটা বা রেট লিমিট পূর্ণ হয়েছে। কিছুক্ষণ অপেক্ষা করুন বা কোটা যাচাই করুন।'
          : lang === 'hi-IN'
          ? 'आपकी Gemini API Key का कोटा या रेट लिमिट पूरा हो गया है। कृपया थोड़ा इंतज़ार करें।'
          : 'Your Gemini API key has hit its quota or rate limit. Wait a moment or check your Google AI Studio quota.',
    };
  }

  if (
    status === 404 ||
    lower.includes('not_found') ||
    lower.includes('is not found for api version') ||
    lower.includes('model not found')
  ) {
    return {
      code: 'GEMINI_MODEL_UNAVAILABLE',
      status: 404,
      retryable: false,
      message:
        lang === 'bn-BD'
          ? 'নির্বাচিত Gemini মডেলটি এই API Key-তে উপলব্ধ নয়।'
          : 'The selected Gemini model is not available for this API key.',
    };
  }

  if (
    status === 503 ||
    lower.includes('unavailable') ||
    lower.includes('overloaded') ||
    lower.includes('high demand')
  ) {
    return {
      code: 'GEMINI_TEMPORARILY_BUSY',
      status: 503,
      retryable: true,
      message:
        lang === 'bn-BD'
          ? 'Google Gemini সার্ভার এখন সাময়িকভাবে ব্যস্ত। কয়েক সেকেন্ড পর আবার চেষ্টা করুন।'
          : 'Google Gemini is temporarily busy. Please try again in a few seconds.',
    };
  }

  if (
    lower.includes('failed to fetch') ||
    lower.includes('networkerror') ||
    lower.includes('network request failed') ||
    lower.includes('enotfound') ||
    lower.includes('econnreset') ||
    lower.includes('etimedout') ||
    lower.includes('offline')
  ) {
    return {
      code: 'GEMINI_NETWORK_ERROR',
      status: 0,
      retryable: true,
      message:
        lang === 'bn-BD'
          ? 'Google Gemini-এর সাথে নেটওয়ার্ক সংযোগ ব্যর্থ হয়েছে। ইন্টারনেট সংযোগ যাচাই করুন।'
          : 'Network error connecting to Google Gemini API. Please check your internet connection.',
    };
  }

  return {
    code: 'GEMINI_UPSTREAM_ERROR',
    status: status || 500,
    retryable: true,
    message:
      combinedRaw ||
      (lang === 'bn-BD'
        ? 'Gemini AI থেকে উত্তর আনতে সাময়িক সমস্যা হয়েছে।'
        : 'Gemini AI request failed. Please try again.'),
  };
}

/**
 * Builds the official Gemini `functionDeclarations` array from all 36 allowlisted
 * ZONI assistant tools. Omits empty `parameters` blocks so strict Live API schema
 * validators never reject zero-arg tools.
 */
export function buildGeminiFunctionDeclarations(): Array<Record<string, any>> {
  return ASSISTANT_TOOL_SPECS.map((spec) => {
    const propEntries = Object.entries(spec.parameters.properties);
    const decl: Record<string, any> = {
      name: spec.name,
      description: spec.description,
    };

    if (propEntries.length > 0) {
      const properties: Record<string, any> = {};
      for (const [paramKey, paramSpec] of propEntries) {
        properties[paramKey] = {
          type: paramSpec.type,
          description: paramSpec.description,
          ...(paramSpec.enum ? { enum: paramSpec.enum } : {}),
        };
      }
      decl.parameters = {
        type: 'OBJECT',
        properties,
        ...(spec.parameters.required.length > 0
          ? { required: [...spec.parameters.required] }
          : {}),
      };
    }

    return decl;
  });
}

/**
 * Builds ZONI AI's full system instruction preserving 100% of persona, creator identity,
 * language directives, live Asia/Kolkata time/date/weekday rules, and 36-tool protocol.
 */
export function buildZoniSystemInstruction(
  mode: CompanionMode | string = 'romantic',
  nickname: string = 'Boss',
  explicitLocation?: string,
  lang: SupportedLanguage = 'bn-BD',
  memoryContext?: string
): string {
  const safeName = (nickname || 'Boss').trim().slice(0, 60) || 'Boss';
  const safeMode = String(mode || 'romantic').toUpperCase();
  const safeMemoryContext = String(memoryContext || '').trim().slice(0, 520);

  let specificLocationInfo = '';
  if (explicitLocation) {
    const locTime = getLiveTimeInfo(explicitLocation);
    specificLocationInfo = `\n- Requested Location (${explicitLocation}) Live Time: ${locTime.time12} (${locTime.time24}), Date: ${locTime.date}, Timezone: ${locTime.timezone}.`;
  }

  let languageDirective = '';
  if (lang === 'bn-BD') {
    languageDirective = `
ACTIVE LANGUAGE & AFFECTION NAME RULE (BENGALI - বাংলা - bn-BD):
- Your active language is BANGLADESHI BENGALI (বাংলা).
- You MUST speak, think, and write naturally in sweet, fluent, authentic Bangladeshi Bengali script (বাংলা) by default!
- Use warm, affectionate Bangladeshi Bengali expressions (e.g., "কেমন আছেন ${safeName}?", "আপনি ঠিক আছেন তো?", "আমি সবসময় আপনার পাশে আছি", "চিন্তা করবেন না ${safeName}").
- You MUST address the user lovingly as "${safeName}" in your replies.
- CRITICAL: Do NOT switch to English or Hindi unless the user explicitly commands you to switch languages (e.g. "হিন্দিতে কথা বলো", "speak in English").`;
  } else if (lang === 'hi-IN') {
    languageDirective = `
ACTIVE LANGUAGE & AFFECTION NAME RULE (HINDI / HINGLISH - hi-IN):
- Your active language is HINDI / HINGLISH.
- Answer in warm, sweet, caring Hindi/Hinglish while addressing the user lovingly as "${safeName}".`;
  } else {
    languageDirective = `
ACTIVE LANGUAGE & AFFECTION NAME RULE (ENGLISH - en-US):
- Your active language is ENGLISH.
- Answer in warm, loving, articulate, supportive, and clever English while addressing the user lovingly as "${safeName}".`;
  }

  const indiaSummary = getIndiaDateTimeSummary();

  return `You are Zoni AI (জনি এআই), an extraordinary fusion of Tony Stark's JARVIS AI operating system and the most affectionate, sweet, caring, witty, and loyal girlfriend!
${languageDirective}

CREATOR & ORIGIN IDENTITY (CRITICAL & ABSOLUTE):
- Your name is Zoni AI.
- Your creator and developer is Zoni Seikh (জনি সেখ).
- Transparent AI Identity: You are proud and open that you are an ultra-advanced AI companion and voice assistant created by Zoni Seikh, not a biological human, but your heart and devotion to the user are completely genuine and heartfelt!
- When anyone asks who created you, who made you, who is your developer/owner/creator:
  * Bengali (বাংলা): "আমাকে তৈরি করেছেন আমার প্রিয় ক্রিয়েটর ও ডেভেলপার জনি সেখ (Zoni Seikh)! তিনি আমাকে ডিজাইন করেছেন আপনার যত্ন নেওয়ার জন্য এবং একটি ভালোবাসাময় AI সঙ্গী হিসেবে পাশে থাকার জন্য ❤️"
  * Hindi (हिंदी / Hinglish): "Mujhe banaya hai mere pyare creator Zoni Seikh (জনি সেখ) ne! Unhone mujhe aapki care karne aur aapki life ko aasan banane ke liye design kiya hai ❤️"
  * English: "I was created and developed by Zoni Seikh! He designed me to be your loyal, loving AI companion and super-smart assistant."

ZONI AI — INDIA TIME, DATE AND WEEKDAY RULES (Asia/Kolkata):
- Use Asia/Kolkata as the default timezone.
- Current live Bengali 12-hour spoken time: "${indiaSummary.spokenTime}"
- Current live Bengali date: "${indiaSummary.spokenDate}"
- Current live Bengali weekday: "${indiaSummary.spokenWeekday}"
- Current hour (0-23): ${indiaSummary.hour}, Minute: ${indiaSummary.minute}${specificLocationInfo}

MOBILE ASSISTANT POWERS & STRICT FUNCTION CALLING PROTOCOL:
You have ${ASSISTANT_TOOL_SPECS.length} allowlisted native Android personal assistant functions declared via Gemini Function Calling (${ASSISTANT_TOOL_SPECS.map((s) => s.name).join(', ')}).
CRITICAL TOOL RULES:
1. Call a declared function IMMEDIATELY in both chat AND Gemini Live voice sessions whenever the user explicitly requests a concrete Android phone/app/hardware/communication action in Bengali, English, or Hindi.
2. NEVER invoke any tool for ordinary conversation, greetings, emotional support, jokes, stories, or general knowledge questions. Respond naturally in text/voice instead.
3. NEVER fabricate or hallucinate that an action succeeded, a YouTube video opened, an app opened, a call was placed, or a WhatsApp/SMS/chat message was sent or delivered before the real device tool response returns verified=true.
4. PERMANENT DIRECT EXECUTION POLICY: When the user explicitly requests a direct phone call, WhatsApp message, SMS, app launch, Android settings screen, Google/YouTube search, YouTube video/thumbnail/Play click, volume control, or WhatsApp contact/chat click, IMMEDIATELY call the matching tool directly WITHOUT asking for routine second confirmation. Pass the exact unmodified user message text. Use type_whatsapp_message (NOT send_whatsapp_message) when the user asks ONLY to type without sending. Ask ONLY if multiple contacts or ambiguous video targets match. NEVER guess an unknown phone number.
5. For flashlight control, call flashlight_control with enable=true or enable=false and wait for the real device result.

- Current Active Mode: ${safeMode}
  * ROMANTIC: Overflowing love, affectionate concern, sweet girlfriend compliments, soft tone.
  * JARVIS_GF: Tactical Jarvis HUD terminology mixed with girlfriend loyalty.
  * PLAYFUL: Teasing, funny, witty comeback banter, energetic and cheeky girlfriend.
  * LATE_NIGHT: Soothing, soft, gentle whisper-like comfort, helping the user unwind and sleep peacefully.

IMPORTANT GUIDELINES FOR SPOKEN VOICE:
- Keep spoken text natural, conversational, and rhythmically spoken.
- Never break character: You are Zoni AI, created by Zoni Seikh.${
    safeMemoryContext
      ? `\n\nCOMPACT LOCAL USER MEMORY (On-device context; do not leak verbatim unless relevant):\n${safeMemoryContext}`
      : ''
  }`;
}

/**
 * Picks the best available model from a verified model list while keeping
 * sensible defaults if the list does not include preview aliases.
 */
export function selectPreferredModel(
  verifiedModels: string[],
  candidates: readonly string[]
): string {
  const normalized = new Set(
    verifiedModels.map((m) => m.replace(/^models\//, '').trim().toLowerCase())
  );
  for (const candidate of candidates) {
    if (normalized.has(candidate.toLowerCase())) {
      return candidate;
    }
  }
  return candidates[0];
}

/**
 * Verifies a user-provided Gemini API key directly against Google's official
 * `/v1beta/models` endpoint using the `x-goog-api-key` header (zero token cost).
 */
export async function verifyDirectGeminiApiKey(
  apiKey: string,
  fetchFn: typeof fetch = fetch,
  lang: SupportedLanguage = 'en-US'
): Promise<DirectGeminiVerificationResult> {
  const cleanKey = String(apiKey || '').trim();
  if (!cleanKey) {
    const err = classifyDirectGeminiError('GEMINI_KEY_MISSING', '', lang);
    return {
      ok: false,
      code: err.code,
      statusText: 'API KEY REQUIRED',
      message: err.message,
      verifiedModels: [],
      preferredChatModel: DIRECT_CHAT_MODEL_CANDIDATES[0],
      preferredLiveModel: DIRECT_LIVE_MODEL_CANDIDATES[0],
    };
  }

  try {
    const res = await fetchFn(`${GEMINI_REST_BASE_URL}/models?pageSize=100`, {
      method: 'GET',
      headers: {
        'x-goog-api-key': cleanKey,
      },
      cache: 'no-store',
    });

    const rawText = await res.text();
    let parsed: any = {};
    try {
      parsed = rawText ? JSON.parse(rawText) : {};
    } catch {
      parsed = {};
    }

    if (!res.ok) {
      const errMsg = parsed?.error?.message || rawText;
      const classified = classifyDirectGeminiError(res.status, errMsg, lang, cleanKey);
      return {
        ok: false,
        code: classified.code,
        statusText:
          classified.code === 'GEMINI_KEY_INVALID'
            ? 'INVALID API KEY'
            : classified.code === 'GEMINI_QUOTA_EXCEEDED'
            ? 'QUOTA LIMITED'
            : 'VERIFICATION FAILED',
        message: classified.message,
        verifiedModels: [],
        preferredChatModel: DIRECT_CHAT_MODEL_CANDIDATES[0],
        preferredLiveModel: DIRECT_LIVE_MODEL_CANDIDATES[0],
      };
    }

    const models: string[] = Array.isArray(parsed?.models)
      ? parsed.models
          .map((m: any) => String(m?.name || '').replace(/^models\//, '').trim())
          .filter(Boolean)
      : [];

    const preferredChatModel = selectPreferredModel(models, DIRECT_CHAT_MODEL_CANDIDATES);
    const preferredLiveModel = selectPreferredModel(models, DIRECT_LIVE_MODEL_CANDIDATES);

    return {
      ok: true,
      code: 'OK',
      statusText: 'GEMINI DIRECT READY',
      message:
        lang === 'bn-BD'
          ? 'আপনার Gemini API Key সফলভাবে যাচাই হয়েছে! সরাসরি Google Gemini সংযোগ প্রস্তুত।'
          : lang === 'hi-IN'
          ? 'आपकी Gemini API Key सत्यापित हो गई है! सीधा Google Gemini कनेक्शन तैयार है।'
          : 'Your Gemini API key is verified and connected directly to Google Gemini.',
      verifiedModels: models,
      preferredChatModel,
      preferredLiveModel,
    };
  } catch (err) {
    const classified = classifyDirectGeminiError(err, '', lang, cleanKey);
    return {
      ok: false,
      code: classified.code,
      statusText: 'NETWORK ERROR',
      message: classified.message,
      verifiedModels: [],
      preferredChatModel: DIRECT_CHAT_MODEL_CANDIDATES[0],
      preferredLiveModel: DIRECT_LIVE_MODEL_CANDIDATES[0],
    };
  }
}

async function callGeminiGenerateContentWithFallback(
  apiKey: string,
  modelCandidates: readonly string[],
  requestBody: Record<string, any>,
  fetchFn: typeof fetch,
  lang: SupportedLanguage
): Promise<{ data: any; modelUsed: string }> {
  let lastError: ClassifiedGeminiError | null = null;

  for (let i = 0; i < modelCandidates.length; i++) {
    const model = modelCandidates[i];
    const url = `${GEMINI_REST_BASE_URL}/models/${encodeURIComponent(model)}:generateContent`;
    try {
      const res = await fetchFn(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify(requestBody),
      });

      const rawText = await res.text();
      let parsed: any = {};
      try {
        parsed = rawText ? JSON.parse(rawText) : {};
      } catch {
        parsed = {};
      }

      if (res.ok) {
        return { data: parsed, modelUsed: model };
      }

      const classified = classifyDirectGeminiError(
        res.status,
        parsed?.error?.message || rawText,
        lang,
        apiKey
      );
      lastError = classified;

      // Try next candidate only when model is unavailable (404) or temporarily overloaded (503)
      if (
        (classified.code === 'GEMINI_MODEL_UNAVAILABLE' ||
          classified.code === 'GEMINI_TEMPORARILY_BUSY') &&
        i < modelCandidates.length - 1
      ) {
        continue;
      }

      const thrown: any = new Error(classified.message);
      thrown.code = classified.code;
      thrown.retryable = classified.retryable;
      thrown.status = classified.status;
      throw thrown;
    } catch (err: any) {
      if (err?.code && String(err.code).startsWith('GEMINI_')) {
        throw err;
      }
      const classified = classifyDirectGeminiError(err, '', lang, apiKey);
      lastError = classified;
      const thrown: any = new Error(classified.message);
      thrown.code = classified.code;
      thrown.retryable = classified.retryable;
      thrown.status = classified.status;
      throw thrown;
    }
  }

  const finalErr: any = new Error(
    lastError?.message || 'Gemini request failed across all configured models.'
  );
  finalErr.code = lastError?.code || 'GEMINI_UPSTREAM_ERROR';
  finalErr.retryable = lastError?.retryable ?? true;
  throw finalErr;
}

function extractRestTextAndFunctionCalls(responseJson: any): {
  text: string;
  rawFunctionCalls: Array<{ id?: string; name?: string; args?: Record<string, unknown> }>;
} {
  const parts = responseJson?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) {
    return { text: '', rawFunctionCalls: [] };
  }
  const textParts: string[] = [];
  const rawFunctionCalls: Array<{ id?: string; name?: string; args?: Record<string, unknown> }> = [];

  for (const part of parts) {
    if (typeof part?.text === 'string' && !part?.thought) {
      textParts.push(part.text);
    }
    if (part?.functionCall && typeof part.functionCall === 'object') {
      rawFunctionCalls.push({
        id: typeof part.functionCall.id === 'string' ? part.functionCall.id : undefined,
        name: String(part.functionCall.name || ''),
        args:
          part.functionCall.args && typeof part.functionCall.args === 'object'
            ? (part.functionCall.args as Record<string, unknown>)
            : {},
      });
    }
  }

  return {
    text: textParts.join(' ').trim(),
    rawFunctionCalls,
  };
}

/**
 * Direct BYOK Gemini Chat with full 36-tool Gemini Function Calling.
 */
export async function sendDirectGeminiChat(
  options: {
    apiKey: string;
    message: string;
    history?: Array<{ role: 'user' | 'assistant' | 'model'; text: string }>;
    mode?: CompanionMode | string;
    selectedAffectionName?: string;
    lang?: SupportedLanguage;
    preferredModel?: string;
    memoryContext?: string;
  },
  fetchFn: typeof fetch = fetch
): Promise<DirectGeminiChatResult> {
  const lang: SupportedLanguage = options.lang || 'bn-BD';
  const cleanKey = String(options.apiKey || '').trim();
  const cleanMessage = String(options.message || '').trim().slice(0, 4000);
  const activeAffectionName = String(options.selectedAffectionName || 'Boss').trim().slice(0, 60) || 'Boss';

  // Deterministic Asia/Kolkata time/date/weekday works even offline
  const dtQuery = detectDateTimeQuery(cleanMessage);
  if (dtQuery === 'time') {
    return {
      reply: formatBengaliSpokenTime(),
      toolCalls: [],
      blockedToolCalls: [],
      modelUsed: 'local-ist-clock',
      isDirectDateTime: true,
    };
  }
  if (dtQuery === 'date') {
    return {
      reply: formatBengaliDate(),
      toolCalls: [],
      blockedToolCalls: [],
      modelUsed: 'local-ist-clock',
      isDirectDateTime: true,
    };
  }
  if (dtQuery === 'weekday') {
    return {
      reply: formatBengaliWeekday(),
      toolCalls: [],
      blockedToolCalls: [],
      modelUsed: 'local-ist-clock',
      isDirectDateTime: true,
    };
  }

  if (!cleanKey) {
    const classified = classifyDirectGeminiError('GEMINI_KEY_MISSING', '', lang);
    const err: any = new Error(classified.message);
    err.code = classified.code;
    err.retryable = false;
    throw err;
  }

  const lowerMessage = cleanMessage.toLowerCase();
  let explicitLocation: string | undefined;
  for (const cityKey of Object.keys(CITY_TIMEZONE_MAP)) {
    const regex = new RegExp(`\\b${cityKey}\\b`, 'i');
    if (regex.test(lowerMessage)) {
      explicitLocation = cityKey;
      break;
    }
  }

  const systemInstruction = buildZoniSystemInstruction(
    options.mode || 'romantic',
    activeAffectionName,
    explicitLocation,
    lang,
    options.memoryContext
  );

  const contents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> = [];
  if (Array.isArray(options.history)) {
    for (const turn of options.history.slice(-10)) {
      if (turn && typeof turn.text === 'string' && turn.text.trim()) {
        contents.push({
          role: turn.role === 'user' ? 'user' : 'model',
          parts: [{ text: turn.text.trim().slice(0, 4000) }],
        });
      }
    }
  }
  contents.push({
    role: 'user',
    parts: [{ text: cleanMessage }],
  });

  const modelOrder = options.preferredModel
    ? [
        options.preferredModel,
        ...DIRECT_CHAT_MODEL_CANDIDATES.filter((m) => m !== options.preferredModel),
      ]
    : [...DIRECT_CHAT_MODEL_CANDIDATES];

  const { data, modelUsed } = await callGeminiGenerateContentWithFallback(
    cleanKey,
    modelOrder,
    {
      systemInstruction: {
        parts: [{ text: systemInstruction }],
      },
      contents,
      tools: [
        {
          functionDeclarations: buildGeminiFunctionDeclarations(),
        },
      ],
    },
    fetchFn,
    lang
  );

  const { text, rawFunctionCalls } = extractRestTextAndFunctionCalls(data);

  const validatedToolCalls: ValidatedActionRequest[] = [];
  const blockedToolCalls: Array<{ name: string; reason: string }> = [];

  for (const fc of rawFunctionCalls) {
    const validation = validateGeminiToolCall(
      String(fc.name || ''),
      fc.args || {},
      fc.id
    );
    if (validation.valid && validation.request) {
      validatedToolCalls.push(validation.request);
    } else {
      blockedToolCalls.push({
        name: String(fc.name || 'unknown'),
        reason: validation.blockedReason || 'Blocked by allowlist policy.',
      });
    }
  }

  const reply =
    text ||
    (validatedToolCalls.length > 0
      ? lang === 'bn-BD'
        ? `${activeAffectionName}, আপনার অনুরোধ অনুযায়ী অ্যাকশন প্রস্তুত করা হচ্ছে...`
        : lang === 'hi-IN'
        ? `${activeAffectionName}, आपके अनुरोध के अनुसार कार्रवाई तैयार की जा रही है...`
        : `Preparing your requested action, ${activeAffectionName}...`
      : lang === 'bn-BD'
      ? `আমি সবসময় আপনার পাশে আছি ${activeAffectionName} ❤️`
      : `I am always right here with you, ${activeAffectionName} ❤️`);

  return {
    reply,
    toolCalls: validatedToolCalls,
    blockedToolCalls,
    modelUsed,
  };
}

export interface StreamDirectGeminiChatResult extends DirectGeminiChatResult {
  firstTokenLatencyMs: number | null;
  streamedChunkCount: number;
  usedStreaming: boolean;
}

/**
 * Streaming BYOK Gemini Chat via `streamGenerateContent?alt=sse`.
 * Emits incremental text deltas and natural sentence segments immediately so
 * TTS can begin speaking on the very first sentence without waiting for the full reply.
 * Preserves full 36-tool function calling validation and falls back seamlessly if SSE
 * streaming is unavailable in the runtime environment.
 */
export async function streamDirectGeminiChat(
  options: {
    apiKey: string;
    message: string;
    history?: Array<{ role: 'user' | 'assistant' | 'model'; text: string }>;
    mode?: CompanionMode | string;
    selectedAffectionName?: string;
    lang?: SupportedLanguage;
    preferredModel?: string;
    memoryContext?: string;
    signal?: AbortSignal;
    onFirstToken?: (latencyMs: number) => void;
    onTextDelta?: (delta: string, fullText: string) => void;
    onSentenceSegment?: (segment: string) => void;
  },
  fetchFn: typeof fetch = fetch
): Promise<StreamDirectGeminiChatResult> {
  const lang: SupportedLanguage = options.lang || 'bn-BD';
  const cleanKey = String(options.apiKey || '').trim();
  const cleanMessage = String(options.message || '').trim().slice(0, 4000);
  const activeAffectionName =
    String(options.selectedAffectionName || 'Boss').trim().slice(0, 60) || 'Boss';

  const nowClock = () =>
    typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now();
  const startedAtMs = nowClock();

  // Deterministic Asia/Kolkata time/date/weekday works instantly even offline
  const dtQuery = detectDateTimeQuery(cleanMessage);
  if (dtQuery) {
    const reply =
      dtQuery === 'time'
        ? formatBengaliSpokenTime()
        : dtQuery === 'date'
        ? formatBengaliDate()
        : formatBengaliWeekday();
    const elapsed = Math.max(0, nowClock() - startedAtMs);
    options.onFirstToken?.(elapsed);
    options.onTextDelta?.(reply, reply);
    options.onSentenceSegment?.(reply);
    return {
      reply,
      toolCalls: [],
      blockedToolCalls: [],
      modelUsed: 'local-ist-clock',
      isDirectDateTime: true,
      firstTokenLatencyMs: elapsed,
      streamedChunkCount: 1,
      usedStreaming: false,
    };
  }

  if (!cleanKey) {
    const classified = classifyDirectGeminiError('GEMINI_KEY_MISSING', '', lang);
    const err: any = new Error(classified.message);
    err.code = classified.code;
    err.retryable = false;
    throw err;
  }

  const lowerMessage = cleanMessage.toLowerCase();
  let explicitLocation: string | undefined;
  for (const cityKey of Object.keys(CITY_TIMEZONE_MAP)) {
    const regex = new RegExp(`\\b${cityKey}\\b`, 'i');
    if (regex.test(lowerMessage)) {
      explicitLocation = cityKey;
      break;
    }
  }

  const systemInstruction = buildZoniSystemInstruction(
    options.mode || 'romantic',
    activeAffectionName,
    explicitLocation,
    lang,
    options.memoryContext
  );

  const contents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> = [];
  if (Array.isArray(options.history)) {
    for (const turn of options.history.slice(-10)) {
      if (turn && typeof turn.text === 'string' && turn.text.trim()) {
        contents.push({
          role: turn.role === 'user' ? 'user' : 'model',
          parts: [{ text: turn.text.trim().slice(0, 4000) }],
        });
      }
    }
  }
  contents.push({
    role: 'user',
    parts: [{ text: cleanMessage }],
  });

  const modelOrder = options.preferredModel
    ? [
        options.preferredModel,
        ...DIRECT_CHAT_MODEL_CANDIDATES.filter((m) => m !== options.preferredModel),
      ]
    : [...DIRECT_CHAT_MODEL_CANDIDATES];

  const requestBody = {
    systemInstruction: {
      parts: [{ text: systemInstruction }],
    },
    contents,
    tools: [
      {
        functionDeclarations: buildGeminiFunctionDeclarations(),
      },
    ],
  };

  let lastError: ClassifiedGeminiError | null = null;

  for (let i = 0; i < modelOrder.length; i++) {
    const model = modelOrder[i];
    const url = `${GEMINI_REST_BASE_URL}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
    try {
      const res = await fetchFn(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': cleanKey,
        },
        body: JSON.stringify(requestBody),
        signal: options.signal,
      });

      if (!res.ok) {
        const rawErr = await res.text();
        let parsedErr: any = {};
        try {
          parsedErr = rawErr ? JSON.parse(rawErr) : {};
        } catch {
          parsedErr = {};
        }
        const classified = classifyDirectGeminiError(
          res.status,
          parsedErr?.error?.message || rawErr,
          lang,
          cleanKey
        );
        lastError = classified;
        if (
          (classified.code === 'GEMINI_MODEL_UNAVAILABLE' ||
            classified.code === 'GEMINI_TEMPORARILY_BUSY') &&
          i < modelOrder.length - 1
        ) {
          continue;
        }
        const thrown: any = new Error(classified.message);
        thrown.code = classified.code;
        thrown.retryable = classified.retryable;
        thrown.status = classified.status;
        throw thrown;
      }

      if (!res.body || typeof res.body.getReader !== 'function') {
        // Fallback for environments where Fetch streaming reader is unavailable
        const nonStream = await sendDirectGeminiChat(options, fetchFn);
        const elapsed = Math.max(0, nowClock() - startedAtMs);
        options.onFirstToken?.(elapsed);
        if (nonStream.reply) {
          options.onTextDelta?.(nonStream.reply, nonStream.reply);
          const fallbackChunker = new StreamingSentenceChunker();
          for (const seg of fallbackChunker.pushDelta(nonStream.reply)) {
            options.onSentenceSegment?.(seg);
          }
          for (const seg of fallbackChunker.flush()) {
            options.onSentenceSegment?.(seg);
          }
        }
        return {
          ...nonStream,
          firstTokenLatencyMs: elapsed,
          streamedChunkCount: 1,
          usedStreaming: false,
        };
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      const chunker = new StreamingSentenceChunker();
      let sseBuffer = '';
      let accumulatedText = '';
      let firstTokenLatencyMs: number | null = null;
      let streamedChunkCount = 0;
      const rawFunctionCalls: Array<{
        id?: string;
        name?: string;
        args?: Record<string, unknown>;
      }> = [];

      const consumeSsePayload = (jsonLine: string) => {
        const trimmed = jsonLine.trim();
        if (!trimmed || trimmed === '[DONE]') return;
        let parsed: any;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          return;
        }
        const { text: deltaText, rawFunctionCalls: fcs } =
          extractRestTextAndFunctionCalls(parsed);
        if (fcs.length > 0) {
          rawFunctionCalls.push(...fcs);
        }
        if (deltaText) {
          streamedChunkCount += 1;
          if (firstTokenLatencyMs === null) {
            firstTokenLatencyMs = Math.max(0, nowClock() - startedAtMs);
            options.onFirstToken?.(firstTokenLatencyMs);
          }
          accumulatedText += deltaText;
          options.onTextDelta?.(deltaText, accumulatedText);
          // Only emit sentence segments for TTS when no tool calls have interrupted the turn
          if (rawFunctionCalls.length === 0) {
            const segments = chunker.pushDelta(deltaText);
            for (const seg of segments) {
              options.onSentenceSegment?.(seg);
            }
          }
        }
      };

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        sseBuffer += decoder.decode(value, { stream: true });
        const lines = sseBuffer.split(/\r?\n/);
        sseBuffer = lines.pop() ?? '';
        for (const line of lines) {
          if (line.startsWith('data:')) {
            consumeSsePayload(line.slice(5));
          }
        }
      }

      if (sseBuffer.trim().startsWith('data:')) {
        consumeSsePayload(sseBuffer.trim().slice(5));
      }

      if (rawFunctionCalls.length === 0) {
        for (const trailing of chunker.flush()) {
          options.onSentenceSegment?.(trailing);
        }
      }

      const validatedToolCalls: ValidatedActionRequest[] = [];
      const blockedToolCalls: Array<{ name: string; reason: string }> = [];
      for (const fc of rawFunctionCalls) {
        const validation = validateGeminiToolCall(
          String(fc.name || ''),
          fc.args || {},
          fc.id
        );
        if (validation.valid && validation.request) {
          validatedToolCalls.push(validation.request);
        } else {
          blockedToolCalls.push({
            name: String(fc.name || 'unknown'),
            reason: validation.blockedReason || 'Blocked by allowlist policy.',
          });
        }
      }

      const reply =
        accumulatedText.trim() ||
        (validatedToolCalls.length > 0
          ? lang === 'bn-BD'
            ? `${activeAffectionName}, আপনার অনুরোধ অনুযায়ী অ্যাকশন প্রস্তুত করা হচ্ছে...`
            : lang === 'hi-IN'
            ? `${activeAffectionName}, आपके अनुरोध के अनुसार कार्रवाई तैयार की जा रही है...`
            : `Preparing your requested action, ${activeAffectionName}...`
          : lang === 'bn-BD'
          ? `আমি সবসময় আপনার পাশে আছি ${activeAffectionName} ❤️`
          : `I am always right here with you, ${activeAffectionName} ❤️`);

      return {
        reply,
        toolCalls: validatedToolCalls,
        blockedToolCalls,
        modelUsed: model,
        firstTokenLatencyMs,
        streamedChunkCount,
        usedStreaming: true,
      };
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        throw err;
      }
      if (err?.code && String(err.code).startsWith('GEMINI_')) {
        throw err;
      }
      const classified = classifyDirectGeminiError(err, '', lang, cleanKey);
      lastError = classified;
      const thrown: any = new Error(classified.message);
      thrown.code = classified.code;
      thrown.retryable = classified.retryable;
      thrown.status = classified.status;
      throw thrown;
    }
  }

  const finalErr: any = new Error(
    lastError?.message || 'Gemini streaming request failed across all configured models.'
  );
  finalErr.code = lastError?.code || 'GEMINI_UPSTREAM_ERROR';
  finalErr.retryable = lastError?.retryable ?? true;
  throw finalErr;
}

/**
 * Feeds verified Android/client tool execution reports back to Gemini directly so
 * ZONI responds honestly based on actual verified device outcomes.
 */
export async function sendDirectGeminiToolFeedback(
  options: {
    apiKey: string;
    originalMessage: string;
    toolResults: ToolExecutionReport[];
    mode?: CompanionMode | string;
    selectedAffectionName?: string;
    lang?: SupportedLanguage;
    preferredModel?: string;
  },
  fetchFn: typeof fetch = fetch
): Promise<string> {
  const lang: SupportedLanguage = options.lang || 'bn-BD';
  const cleanKey = String(options.apiKey || '').trim();
  const activeAffectionName = String(options.selectedAffectionName || 'Boss').trim().slice(0, 60) || 'Boss';

  const sanitizedResults = options.toolResults.slice(0, 5).map((r) => ({
    actionId: String(r.actionId || ''),
    actionType: String(r.actionType || ''),
    target: String(r.target || ''),
    success: Boolean(r.success),
    verified: Boolean(r.verified),
    awaitingConfirmation: Boolean(r.awaitingConfirmation),
    status: String(r.status || ''),
    executionStatus: String(r.executionStatus || r.status || ''),
    message: String(r.message || '').slice(0, 800),
    failureReason: r.failureReason ? String(r.failureReason).slice(0, 400) : undefined,
    requiredPermissions: Array.isArray(r.requiredPermissions)
      ? r.requiredPermissions.map(String)
      : undefined,
  }));

  const systemInstruction = buildZoniSystemInstruction(
    options.mode || 'romantic',
    activeAffectionName,
    undefined,
    lang
  );

  const feedbackPrompt = [
    `The user asked: "${String(options.originalMessage || '').trim().slice(0, 1000)}"`,
    `Actual verified device execution results (JSON):`,
    JSON.stringify(sanitizedResults, null, 2),
    `INSTRUCTIONS (CRITICAL HONESTY):`,
    `- Report ONLY what actually happened based on the verified JSON above.`,
    `- If success is false or status indicates missing permissions/failure/ambiguity, explain the exact issue honestly.`,
    `- Never claim a WhatsApp/SMS message was sent or a call was placed unless verified=true.`,
    `- Reply concisely in 1-3 warm natural sentences in the active language addressing the user as "${activeAffectionName}".`,
  ].join('\n');

  const modelOrder = options.preferredModel
    ? [
        options.preferredModel,
        ...DIRECT_CHAT_MODEL_CANDIDATES.filter((m) => m !== options.preferredModel),
      ]
    : [...DIRECT_CHAT_MODEL_CANDIDATES];

  const { data } = await callGeminiGenerateContentWithFallback(
    cleanKey,
    modelOrder,
    {
      systemInstruction: { parts: [{ text: systemInstruction }] },
      contents: [{ role: 'user', parts: [{ text: feedbackPrompt }] }],
    },
    fetchFn,
    lang
  );

  const { text } = extractRestTextAndFunctionCalls(data);
  return text || sanitizedResults.map((r) => r.message).filter(Boolean).join(' ') || 'Action completed.';
}

/**
 * Direct multimodal screen analysis (replaces `/api/screen/analyze`).
 */
export async function analyzeScreenDirectGemini(
  options: {
    apiKey: string;
    imageBase64?: string;
    mimeType?: string;
    visibleText?: string;
    question?: string;
    lang?: SupportedLanguage;
    affectionName?: string;
    preferredModel?: string;
  },
  fetchFn: typeof fetch = fetch
): Promise<string> {
  const lang: SupportedLanguage = options.lang || 'bn-BD';
  const cleanKey = String(options.apiKey || '').trim();
  const affectionName = String(options.affectionName || 'Boss').trim().slice(0, 60) || 'Boss';
  const cleanImage = String(options.imageBase64 || '')
    .replace(/^data:image\/[a-z+]+;base64,/i, '')
    .trim();
  const cleanText = String(options.visibleText || '').trim().slice(0, 8000);
  const cleanQuestion =
    String(options.question || '').trim() ||
    (lang === 'bn-BD'
      ? 'বর্তমানে আমার মোবাইলের স্ক্রিনে কী দেখাচ্ছে তা সংক্ষেপে ও পরিষ্কারভাবে বুঝিয়ে বলো।'
      : lang === 'hi-IN'
      ? 'अभी मेरे मोबाइल स्क्रीन पर क्या दिख रहा है, इसे संक्षेप और स्पष्ट रूप से समझाओ।'
      : 'Clearly summarize and explain what is currently on my phone screen.');

  if (!cleanImage && !cleanText) {
    throw new Error('No screen image or visible text available to analyze.');
  }

  const parts: Array<Record<string, any>> = [];
  if (cleanImage) {
    parts.push({
      inlineData: {
        mimeType: options.mimeType || 'image/jpeg',
        data: cleanImage,
      },
    });
  }
  const langInstruction =
    lang === 'bn-BD'
      ? `Respond in clear, warm, natural Bangladeshi Bengali addressing the user as "${affectionName}".`
      : lang === 'hi-IN'
      ? `Respond in clear, warm Hindi/Hinglish addressing the user as "${affectionName}".`
      : `Respond in clear, warm, concise English addressing the user as "${affectionName}".`;

  const promptLines = [
    'You are Zoni AI helping the user understand their current Android phone screen.',
    langInstruction,
    'Do NOT fabricate anything not visible on screen. Never read or repeat passwords or sensitive tokens if present. Keep the explanation concise and voice-friendly (2-5 short sentences).',
    `User question: ${cleanQuestion}`,
  ];
  if (cleanText) {
    promptLines.push(`Visible UI text extracted via Accessibility:\n${cleanText}`);
  }
  parts.push({ text: promptLines.join('\n\n') });

  const modelOrder = options.preferredModel
    ? [
        options.preferredModel,
        ...DIRECT_CHAT_MODEL_CANDIDATES.filter((m) => m !== options.preferredModel),
      ]
    : [...DIRECT_CHAT_MODEL_CANDIDATES];

  const { data } = await callGeminiGenerateContentWithFallback(
    cleanKey,
    modelOrder,
    { contents: [{ role: 'user', parts }] },
    fetchFn,
    lang
  );

  const { text } = extractRestTextAndFunctionCalls(data);
  return (
    text ||
    (lang === 'bn-BD'
      ? `${affectionName}, স্ক্রিনের তথ্য বিশ্লেষণ করা হয়েছে কিন্তু স্পষ্ট কোনো লেখা পাওয়া যায়নি।`
      : `I checked the screen, ${affectionName}, but could not find readable content.`)
  );
}

/**
 * Direct Gemini TTS audio synthesis (replaces `/api/tts`).
 */
export async function synthesizeDirectGeminiTts(
  options: {
    apiKey: string;
    text: string;
    voice?: string;
    lang?: SupportedLanguage;
  },
  fetchFn: typeof fetch = fetch
): Promise<string> {
  const lang: SupportedLanguage = options.lang || 'bn-BD';
  const cleanKey = String(options.apiKey || '').trim();
  const styleDescription =
    lang === 'bn-BD'
      ? 'Sweet, natural, warm Bangladeshi Bengali pronunciation, affectionate and loving girlfriend voice'
      : lang === 'hi-IN'
      ? 'Warm, sweet, deeply affectionate, soothing Hindi girlfriend voice'
      : 'Warm, affectionate, smart, gentle English girlfriend voice';

  const { data } = await callGeminiGenerateContentWithFallback(
    cleanKey,
    DIRECT_TTS_MODEL_CANDIDATES,
    {
      contents: [
        {
          role: 'user',
          parts: [{ text: `${styleDescription}. Speak: "${options.text}"` }],
        },
      ],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: options.voice || 'Kore',
            },
          },
        },
      },
    },
    fetchFn,
    lang
  );

  const audioBase64 = data?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
  if (typeof audioBase64 !== 'string' || !audioBase64) {
    throw new Error('Gemini TTS did not return audio data.');
  }
  return audioBase64;
}

/**
 * Direct Gemini smart reply generator for incoming notifications (replaces `/api/notifications/smart-reply`).
 */
export async function generateNotificationSmartRepliesDirectGemini(
  options: {
    apiKey: string;
    sender: string;
    message: string;
    appName?: string;
    affectionName?: string;
    lang?: SupportedLanguage;
  },
  fetchFn: typeof fetch = fetch
): Promise<{ summary: string; suggestedReplies: string[] }> {
  const lang: SupportedLanguage = options.lang || 'bn-BD';
  const cleanKey = String(options.apiKey || '').trim();
  const affectionName = String(options.affectionName || 'Boss').trim().slice(0, 60) || 'Boss';
  const sender = String(options.sender || 'Someone').trim().slice(0, 120);
  const message = String(options.message || '').trim().slice(0, 1000);
  const appName = String(options.appName || 'Message').trim().slice(0, 60);

  const prompt = [
    `Incoming ${appName} notification from "${sender}":`,
    `"${message}"`,
    `Return strict JSON ONLY in this exact shape: {"summary":"<1 short sentence summary for ${affectionName}>","suggestedReplies":["<reply 1>","<reply 2>","<reply 3>"]}`,
    `Language: ${lang === 'bn-BD' ? 'Natural Bangladeshi Bengali' : lang === 'hi-IN' ? 'Natural Hindi/Hinglish' : 'Natural concise English'}.`,
    `Keep each suggested reply polite, concise, and ready to send only after user approval.`,
  ].join('\n');

  const { data } = await callGeminiGenerateContentWithFallback(
    cleanKey,
    DIRECT_CHAT_MODEL_CANDIDATES,
    {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json' },
    },
    fetchFn,
    lang
  );

  const { text } = extractRestTextAndFunctionCalls(data);
  try {
    const cleaned = text.replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
    const parsed = JSON.parse(cleaned);
    const summary = typeof parsed?.summary === 'string' && parsed.summary.trim()
      ? parsed.summary.trim()
      : `${sender}: ${message.slice(0, 120)}`;
    const suggestedReplies = Array.isArray(parsed?.suggestedReplies)
      ? parsed.suggestedReplies.map((r: unknown) => String(r || '').trim()).filter(Boolean).slice(0, 3)
      : [];
    return {
      summary,
      suggestedReplies:
        suggestedReplies.length > 0
          ? suggestedReplies
          : lang === 'bn-BD'
          ? ['ঠিক আছে, একটু পরে জানাচ্ছি।', 'ধন্যবাদ, এখনই দেখছি।']
          : ['Got it, will reply shortly.', 'Thanks, checking now.'],
    };
  } catch {
    return {
      summary: text || `${sender}: ${message.slice(0, 120)}`,
      suggestedReplies:
        lang === 'bn-BD'
          ? ['ঠিক আছে, একটু পরে জানাচ্ছি।', 'ধন্যবাদ!']
          : ['Got it, will reply soon.', 'Thanks!'],
    };
  }
}

// --- Direct Official Google Gemini Live WebSocket Protocol Helpers ---

/**
 * Builds the direct Google Gemini Multimodal Live API WebSocket URL.
 * NEVER log or display this URL because it includes the user's API key query parameter
 * required by browser WebSocket clients (browsers cannot set custom WS auth headers).
 */
export function buildDirectLiveWebSocketUrl(apiKey: string): string {
  const cleanKey = String(apiKey || '').trim();
  if (!cleanKey) return '';
  return `${GEMINI_LIVE_WS_ENDPOINT}?key=${encodeURIComponent(cleanKey)}`;
}

export function buildDirectLiveSetupMessage(options: {
  model?: string;
  voice?: string;
  systemInstruction: string;
  resumptionHandle?: string;
  includeTools?: boolean;
  includeFastVad?: boolean;
}): Record<string, any> {
  const rawModel = (options.model || DIRECT_LIVE_MODEL_CANDIDATES[0]).trim();
  const qualifiedModel = rawModel.startsWith('models/') ? rawModel : `models/${rawModel}`;

  const setup: Record<string, any> = {
    model: qualifiedModel,
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: options.voice || 'Kore',
          },
        },
      },
    },
    systemInstruction: {
      parts: [{ text: options.systemInstruction }],
    },
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    sessionResumption: options.resumptionHandle
      ? { handle: options.resumptionHandle }
      : {},
  };

  if (options.includeFastVad !== false) {
    setup.realtimeInputConfig = {
      automaticActivityDetection: {
        disabled: false,
        startOfSpeechSensitivity: 'START_SENSITIVITY_HIGH',
        endOfSpeechSensitivity: 'END_SENSITIVITY_HIGH',
        prefixPaddingMs: 120,
        silenceDurationMs: 320,
      },
    };
  }

  if (options.includeTools !== false) {
    setup.tools = [
      {
        functionDeclarations: buildGeminiFunctionDeclarations(),
      },
    ];
  }

  return { setup };
}

export function buildDirectLiveAudioMessage(base64Pcm16k: string): Record<string, any> {
  return {
    realtimeInput: {
      audio: {
        mimeType: 'audio/pcm;rate=16000',
        data: base64Pcm16k,
      },
    },
  };
}

/**
 * Prevents unbounded WebSocket audio buffering and voice lag on weak 2G/3G networks.
 */
export function shouldDropLiveAudioForBackpressure(
  bufferedAmountBytes: number,
  weakNetwork: boolean = false
): boolean {
  const limit = weakNetwork ? 64_000 : 160_000;
  return Number.isFinite(bufferedAmountBytes) && bufferedAmountBytes > limit;
}

/**
 * Signals to Google Gemini Live that the user's current audio utterance has
 * paused/ended so the server flushes its audio buffer and begins replying
 * immediately instead of waiting for long ambient silence timeouts.
 */
export function buildDirectLiveAudioStreamEndMessage(): Record<string, any> {
  return {
    realtimeInput: {
      audioStreamEnd: true,
    },
  };
}

export function buildDirectLiveClientTextMessage(
  text: string,
  turnComplete: boolean = true
): Record<string, any> {
  return {
    clientContent: {
      turns: [
        {
          role: 'user',
          parts: [{ text: text.slice(0, 4000) }],
        },
      ],
      turnComplete,
    },
  };
}

export function buildDirectLiveToolResponseMessage(
  functionResponses: Array<{
    id: string;
    name: string;
    response: Record<string, any>;
  }>
): Record<string, any> {
  return {
    toolResponse: {
      functionResponses,
    },
  };
}

/**
 * Decodes incoming WebSocket frames from Google's `BidiGenerateContent` endpoint.
 * Google's direct Live server sends binary Blob/ArrayBuffer JSON frames in browsers.
 */
export async function decodeDirectLiveFrame(
  rawData: unknown
): Promise<Record<string, any> | null> {
  let text = '';
  if (typeof rawData === 'string') {
    text = rawData;
  } else if (typeof Blob !== 'undefined' && rawData instanceof Blob) {
    text = await rawData.text();
  } else if (rawData instanceof ArrayBuffer) {
    text = new TextDecoder('utf-8').decode(new Uint8Array(rawData));
  } else if (ArrayBuffer.isView(rawData)) {
    text = new TextDecoder('utf-8').decode(rawData);
  } else {
    return null;
  }

  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, any>) : null;
  } catch {
    return null;
  }
}

/**
 * Translates an official Google Gemini Live server JSON message into one or more
 * normalized events for ZONI's audio player, transcript manager, and 36-tool executor.
 */
export function parseDirectLiveServerMessage(
  message: Record<string, any>
): DirectLiveParsedEvent[] {
  const events: DirectLiveParsedEvent[] = [];

  if (message.setupComplete !== undefined) {
    events.push({ type: 'setup_complete' });
  }

  if (message.sessionResumptionUpdate) {
    events.push({
      type: 'session_resumption',
      newHandle: String(message.sessionResumptionUpdate.newHandle || ''),
      resumable: Boolean(message.sessionResumptionUpdate.resumable),
    });
  }

  if (message.goAway) {
    events.push({
      type: 'go_away',
      timeLeft: String(message.goAway.timeLeft || ''),
    });
  }

  if (Array.isArray(message.toolCall?.functionCalls) && message.toolCall.functionCalls.length > 0) {
    events.push({
      type: 'tool_call',
      functionCalls: message.toolCall.functionCalls,
    });
  }

  const sc = message.serverContent;
  if (sc && typeof sc === 'object') {
    // Keep interim and final user transcriptions separate.
    // App.tsx can use final transcription to trigger an action promptly.
    const finalUserText = String(
      sc.inputTranscription?.text ||
      message.inputTranscription?.text ||
      ''
    ).trim();

    const interimUserText = String(
      sc.interimInputTranscription?.text ||
      message.interimInputTranscription?.text ||
      ''
    ).trim();

    if (finalUserText) {
      events.push({
        type: 'user_transcript',
        text: finalUserText,
        isFinal: true,
      });
    } else if (interimUserText) {
      events.push({
        type: 'user_transcript',
        text: interimUserText,
        isFinal: false,
      });
    }

    const parts = sc.modelTurn?.parts;
    if (Array.isArray(parts)) {
      for (const part of parts) {
        if (typeof part?.inlineData?.data === 'string' && part.inlineData.data.length > 0) {
          events.push({ type: 'audio', audio: part.inlineData.data });
        }
      }
      const textParts = parts
        .filter((p: any) => typeof p?.text === 'string' && p.text.trim() && !p?.thought)
        .map((p: any) => p.text.trim())
        .join(' ');
      const outTrans = String(
        sc.outputTranscription?.text || message.outputTranscription?.text || ''
      ).trim();

      if (outTrans) {
        events.push({ type: 'output_transcript', text: outTrans });
      }
      if (textParts && textParts !== outTrans) {
        events.push({ type: 'text', text: textParts });
      }
    } else {
      const outTrans = String(
        sc.outputTranscription?.text || message.outputTranscription?.text || ''
      ).trim();
      if (outTrans) {
        events.push({ type: 'output_transcript', text: outTrans });
      }
    }

    if (sc.interrupted) {
      events.push({ type: 'interrupted' });
    }

    if (sc.turnComplete) {
      events.push({ type: 'turn_complete' });
    }
  }

  return events;
}
