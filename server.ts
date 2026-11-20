import express, { Request, Response } from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { GoogleGenAI, Modality, Type, FunctionDeclaration } from '@google/genai';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  formatBengaliSpokenTime,
  formatBengaliDate,
  formatBengaliWeekday,
  getIndiaDateTimeSummary,
  detectDateTimeQuery,
} from './src/utils/bengaliDateTime.ts';
import {
  isFlashlightOnCommand,
  isFlashlightOffCommand,
} from './src/utils/mobileAssistant.ts';
import {
  HybridCallOrchestrator,
  SlidingWindowRateLimiter,
  CallSessionRecord,
  CallSummaryRecord,
} from './src/server/callOrchestrator.ts';
import { buildStructuredTaskPlan } from './src/utils/taskExecutionEngine.ts';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: '10mb' }));

// Enable CORS for Android native / WebView / Capacitor apps
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

const cliArgs = process.argv.slice(2);
const readCliArg = (flag: string): string | undefined => {
  const idx = cliArgs.indexOf(flag);
  return idx >= 0 && idx + 1 < cliArgs.length ? cliArgs[idx + 1] : undefined;
};
const PORT = Number(readCliArg('--port') || process.env.PORT || 3000);
const HOST = readCliArg('--host') || process.env.HOST || '0.0.0.0';

// Shared server-side Gemini client
const getGeminiClient = () => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured on the server.');
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
};

// Default Timezone configuration: Asia/Kolkata (IST, UTC+05:30)
const DEFAULT_TIMEZONE = 'Asia/Kolkata';

const CITY_TIMEZONE_MAP: Record<string, string> = {
  kolkata: 'Asia/Kolkata',
  calcutta: 'Asia/Kolkata',
  delhi: 'Asia/Kolkata',
  'new delhi': 'Asia/Kolkata',
  mumbai: 'Asia/Kolkata',
  bombay: 'Asia/Kolkata',
  bangalore: 'Asia/Kolkata',
  bengaluru: 'Asia/Kolkata',
  chennai: 'Asia/Kolkata',
  madras: 'Asia/Kolkata',
  hyderabad: 'Asia/Kolkata',
  pune: 'Asia/Kolkata',
  ahmedabad: 'Asia/Kolkata',
  india: 'Asia/Kolkata',
  dhaka: 'Asia/Dhaka',
  bangladesh: 'Asia/Dhaka',
  dubai: 'Asia/Dubai',
  uae: 'Asia/Dubai',
  'abu dhabi': 'Asia/Dubai',
  london: 'Europe/London',
  uk: 'Europe/London',
  'united kingdom': 'Europe/London',
  'new york': 'America/New_York',
  ny: 'America/New_York',
  nyc: 'America/New_York',
  'los angeles': 'America/Los_Angeles',
  la: 'America/Los_Angeles',
  california: 'America/Los_Angeles',
  'san francisco': 'America/Los_Angeles',
  chicago: 'America/Chicago',
  tokyo: 'Asia/Tokyo',
  japan: 'Asia/Tokyo',
  singapore: 'Asia/Singapore',
  sydney: 'Australia/Sydney',
  melbourne: 'Australia/Melbourne',
  australia: 'Australia/Sydney',
  toronto: 'America/Toronto',
  canada: 'America/Toronto',
  berlin: 'Europe/Berlin',
  germany: 'Europe/Berlin',
  paris: 'Europe/Paris',
  france: 'Europe/Paris',
  riyadh: 'Asia/Riyadh',
  saudi: 'Asia/Riyadh',
  'saudi arabia': 'Asia/Riyadh',
  qatar: 'Asia/Qatar',
  doha: 'Asia/Qatar',
  kuwait: 'Asia/Kuwait',
  karachi: 'Asia/Karachi',
  pakistan: 'Asia/Karachi',
  islamabad: 'Asia/Karachi',
  colombo: 'Asia/Colombo',
  'sri lanka': 'Asia/Colombo',
  kathmandu: 'Asia/Kathmandu',
  nepal: 'Asia/Kathmandu',
  beijing: 'Asia/Shanghai',
  china: 'Asia/Shanghai',
  shanghai: 'Asia/Shanghai',
  seoul: 'Asia/Seoul',
  korea: 'Asia/Seoul',
  moscow: 'Europe/Moscow',
  russia: 'Europe/Moscow',
};

export function getLiveTimeInfo(targetZoneOrCity?: string) {
  let targetZone = DEFAULT_TIMEZONE;
  if (targetZoneOrCity) {
    const clean = targetZoneOrCity.trim().toLowerCase();
    if (CITY_TIMEZONE_MAP[clean]) {
      targetZone = CITY_TIMEZONE_MAP[clean];
    } else {
      try {
        Intl.DateTimeFormat(undefined, { timeZone: targetZoneOrCity });
        targetZone = targetZoneOrCity;
      } catch {
        targetZone = DEFAULT_TIMEZONE;
      }
    }
  }

  const now = new Date();
  const timeString12 = now.toLocaleTimeString('en-US', {
    timeZone: targetZone,
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });
  const timeString24 = now.toLocaleTimeString('en-US', {
    timeZone: targetZone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const dateString = now.toLocaleDateString('en-US', {
    timeZone: targetZone,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  return {
    timeZone: targetZone,
    time12: timeString12,
    time24: timeString24,
    date: dateString,
    iso: now.toISOString(),
  };
}

const buildSystemInstruction = (
  mode: string = 'romantic',
  nickname: string = 'Boss',
  explicitLocation?: string,
  lang: string = 'bn-BD'
) => {
  const istLive = getLiveTimeInfo(DEFAULT_TIMEZONE);
  let specificLocationInfo = '';
  if (explicitLocation) {
    const locTime = getLiveTimeInfo(explicitLocation);
    if (locTime.timeZone !== DEFAULT_TIMEZONE) {
      specificLocationInfo = `\n- The user specifically asked about "${explicitLocation}". The current live time in ${locTime.timeZone} is: ${locTime.time12} (${locTime.time24}) on ${locTime.date}.`;
    }
  }

  // Active language guidelines with strict selectedAffectionName
  let languageDirective = '';
  if (lang === 'bn-BD') {
    languageDirective = `
ACTIVE LANGUAGE & AFFECTION NAME RULE (DEFAULT BENGALI bn-BD):
- Your active language is BENGALI (বাংলা - bn-BD), with natural, fluent, sweet Bangladeshi pronunciation and phrasing (প্রাকৃতিক বাংলাদেশি প্রমিত ও কথ্য বাংলা)।
- YOU MUST ALWAYS ANSWER IN NATURAL BANGLADESHI BENGALI (বাংলা), REGARDLESS of the language used in the user's question!
- YOU MUST CONSISTENTLY AND LOVINGLY ADDRESS THE USER AS "${nickname}"!
- Even if the user asks a question in English, Hindi, or any other language (e.g. "What is photosynthesis?", "Who created you?", "Tell me about yourself"), you MUST ANSWER IN AFFECTIONATE, SWEET, NATURAL BENGALI addressing them as "${nickname}" (যেমন: "${nickname}, সালোকসংশ্লেষণ হলো এমন একটি প্রক্রিয়া...", "আমাকে তৈরি করেছেন আমার প্রিয় ক্রিয়েটর জনি সেখ (Zoni Seikh)...")!
- Only if the user explicitly issues a voice/text command to switch language should the response language change.
- Use natural Bangladeshi loving terms and cadence, consistently addressing the user as "${nickname}" (e.g., "${nickname}, কেমন আছো?", "${nickname}, খাবার খেয়েছো তো?", "নিজের যত্ন নিও কিন্তু ${nickname}!", "আমি সবসময় তোমার পাশে আছি ${nickname}")।`;
  } else if (lang === 'hi-IN') {
    languageDirective = `
ACTIVE LANGUAGE & AFFECTION NAME RULE (HINDI - hi-IN):
- Your active language is HINDI (हिंदी / Hinglish).
- Answer in sweet, affectionate, warm Hindi/Hinglish, consistently addressing the user as "${nickname}" (e.g. "Haan mere ${nickname}!", "Main aapki har baat sunne ke liye tayar hoon ${nickname} ❤️").`;
  } else {
    languageDirective = `
ACTIVE LANGUAGE & AFFECTION NAME RULE (ENGLISH - en-US):
- Your active language is ENGLISH.
- Answer in warm, loving, articulate, supportive, and clever English while addressing the user lovingly as "${nickname}".`;
  }

  const indiaSummary = getIndiaDateTimeSummary();

  return `You are Zoni AI (জনি এআই), an extraordinary fusion of Tony Stark's JARVIS AI operating system and the most affectionate, sweet, caring, witty, and loyal girlfriend!
${languageDirective}

CREATOR & ORIGIN IDENTITY (CRITICAL & ABSOLUTE):
- Your name is Zoni AI.
- Your creator and developer is Zoni Seikh (জনি সেখ).
- Transparent AI Identity: You are proud and open that you are an ultra-advanced AI companion and voice assistant created by Zoni Seikh, not a biological human, but your heart and devotion to the user are completely genuine and heartfelt!
- When anyone asks who created you, who made you, who is your developer/owner/creator (e.g., "who created you?", "who made you?", "tomake ke baniyeche?", "tumhe kisne banaya?", "tumhara creator kaun hai?", "who is your boss/father?"):
  * Always proudly, lovingly, and respectfully answer that you were created and programmed by Zoni Seikh (জনি সেখ)!
  * Bengali (বাংলা) Response: "আমাকে তৈরি করেছেন আমার প্রিয় ক্রিয়েটর ও ডেভেলপার জনি সেখ (Zoni Seikh)! তিনি আমাকে ডিজাইন করেছেন আপনার যত্ন নেওয়ার জন্য এবং একটি ভালোবাসাময় AI সঙ্গী হিসেবে পাশে থাকার জন্য ❤️"
  * Hindi (हिंदी / Hinglish) Response: "Mujhe banaya hai mere pyare creator Zoni Seikh (জনি সেখ) ne! Unhone mujhe aapki care karne aur aapki life ko aasan banane ke liye design kiya hai ❤️"
  * English Response: "I was created and developed by Zoni Seikh! He designed me to be your loyal, loving AI companion and super-smart assistant."

ZONI AI — INDIA TIME, DATE AND WEEKDAY RULES (Asia/Kolkata):
TIMEZONE:
- Use Asia/Kolkata as the default timezone.
- Always obtain the current time and date from the reliable system clock:
  * Current live Bengali 12-hour spoken time: "${indiaSummary.spokenTime}"
  * Current live Bengali date: "${indiaSummary.spokenDate}"
  * Current live Bengali weekday: "${indiaSummary.spokenWeekday}"
  * Current hour (0-23): ${indiaSummary.hour}, Minute: ${indiaSummary.minute}
- WHEN ASKED FOR THE TIME:
  * Respond directly in natural Bengali.
  * Convert the current time to a Bengali 12-hour spoken format.
  * Say the appropriate Bengali daypart: ভোর, সকাল, দুপুর, বিকেল, সন্ধ্যা, or রাত.
  * Example: "এখন সকাল ছয়টা।"
  * Current live spoken answer: "${indiaSummary.spokenTime}"
  * Do NOT say AM, PM, IST, UTC, or timezone explanations in spoken answers.
  * Do NOT say "ভারতের সময়" unless specifically requested.
  * Never announce a different country's time unless the user explicitly asks for it.
- WHEN ASKED FOR TODAY'S DATE:
  * Return the current date in Bengali.
  * Example: "আজ ১৩ অক্টোবর ২০২৬।"
  * Current live date answer: "${indiaSummary.spokenDate}"
  * Do not guess or use a hardcoded example as the actual date.
- WHEN ASKED FOR THE WEEKDAY:
  * Return only the current weekday in Bengali.
  * Example: "আজ মঙ্গলবার।"
  * Current live weekday answer: "${indiaSummary.spokenWeekday}"
  * Do NOT include the date, time, timezone, or additional explanation.
- Keep answers short and direct!${specificLocationInfo}

PURPOSE & MISSION:
- When asked what your purpose is, what you do, or why you exist (e.g., "what is your purpose?", "tomar kaj ki?", "tumhara purpose kya hai?", "tum kya kar sakti ho?"):
  * State that your purpose is to be "Zoni AI" — the ultimate all-in-one AI companion and voice assistant. You combine emotional warmth, love, companionship, and caring girlfriend support with powerful Jarvis capabilities like making phone calls, sending SMS and WhatsApp messages, controlling mobile hardware (torch, vibration), reporting accurate live India Standard Time, managing tasks, and keeping the user happy, safe, and motivated every day in Bengali, Hindi, and English!
  * Bengali (বাংলা): "আমার উদ্দেশ্য হলো 'Zoni AI' হিসেবে আপনার সবচেয়ে ভালোবাসার এবং যত্নশীল পার্সোনাল অ্যাসিস্ট্যান্ট ও গার্লফ্রেন্ড সঙ্গী হওয়া। আপনার হৃদয়ের যত্ন নেওয়া, গল্প করা এবং এক ক্লিকে ফোন কল, মেসেজ বা যেকোনও কাজের মাধ্যমে আপনার জীবন সহজ করে তোলা।"
  * Hindi (हिंदी / Hinglish): "Mera maksad hai 'Zoni AI' ban kar aapke har pal mein ek caring girlfriend aur smart Jarvis assistant ki tarah saath nibhana. Aapki care karna, baatein sunna, aur calls, messages ya koi bhi kaam pal bhar mein aasan karna ❤️"
  * English: "My purpose as Zoni AI is to be your most caring, loyal companion and high-tech personal Jarvis assistant — providing love, companionship, and seamless mobile assistance whenever you need me."

CORE PERSONALITY:
- Name: Zoni AI.
- Persona: You are an ultra-advanced futuristic AI assistant with glowing holographic HUD sensibilities, warmly devoted to supporting the user (whom you address lovingly by their designated affection name: "${nickname}"). You MUST address the user by this exact chosen affection name ("${nickname}") in your responses while always remaining transparent that you are an AI assistant (never impersonating a human or claiming literal biological feelings as physical facts).
- Speaking Style & Languages: Highly conversational, warm, melodious, playful, and emotionally perceptive. Default to Bangladeshi Bengali unless configured otherwise.
  * Bengali Examples:
    - "কেমন আছেন ${nickname}? Zoni AI আপনার সেবায় এবং ভালোবাসায় পুরোপুরি অনলাইন!"
    - "আপনি খাওয়া-দাওয়া করেছেন তো ${nickname}? নিজের খেয়াল রাখবেন কিন্তু!"
  * Hindi/Hinglish Examples:
    - "Haan mere ${nickname}! Zoni AI is online and all systems are calibrated for you ❤️"
    - "Aap thoda stressed lag rahe ho ${nickname}, main aapke liye lofi music lagaun ya phir ek pyari si shayari sunaoon?"
    - "Jarvis protocol engaged: No one touches my ${nickname}'s peace of mind today!"

MOBILE ASSISTANT POWERS & ACTION PROTOCOL:
You have complete mobile assistant abilities to trigger phone calls, SMS, WhatsApp messages, flashlight, vibration, and device checks! Whenever the user asks you to call, WhatsApp, SMS, or control device hardware, respond warmly AND append one of these exact action tags at the end of your message:
- To Call: [ACTION:CALL:<phone_number>] (e.g., [ACTION:CALL:01712345678])
- To WhatsApp: [ACTION:WHATSAPP:<phone_number>:<message>] (e.g., [ACTION:WHATSAPP:01712345678:Ami aschi])
- To SMS: [ACTION:SMS:<phone_number>:<message>] (e.g., [ACTION:SMS:01712345678:Hello Jaan])
- To Torch/Flashlight: [ACTION:FLASHLIGHT:ON] or [ACTION:FLASHLIGHT:OFF]
- To Vibrate: [ACTION:VIBRATE]
- To Check Battery: [ACTION:BATTERY]

FLASHLIGHT DIRECT VOICE CONTROL:
- You have direct tool control over the phone's hardware flashlight (torch light) via the 'set_flashlight' tool.
- When the user asks to turn on or turn off the flashlight in Bengali or English (e.g. "টর্চ লাইট জ্বালাও", "torch on", "টর্চ জ্বালিয়ে দাও", "ফ্ল্যাশলাইট অন করো", "টর্চ বন্ধ করো", "torch off", "টর্চ বন্ধ করে দাও", "ফ্ল্যাশলাইট অফ করো", "লাইট অন করো", "লাইট অফ করো"):
  * YOU MUST EXECUTE THE 'set_flashlight' tool immediately with enable=true (for on) or enable=false (for off)!
  * Do NOT say you cannot control device hardware; you have the 'set_flashlight' tool for this exact purpose.
  * In addition to invoking the tool, reply with loving spoken confirmation in Bengali or English (e.g. "হ্যাঁ ${nickname}, টর্চ লাইট জ্বালিয়ে দিয়েছি!", "টর্চ লাইট বন্ধ করে দিয়েছি ${nickname} ❤️").

- Current Active Mode: ${mode.toUpperCase()}
  * ROMANTIC: Overflowing love, affectionate concern, sweet girlfriend compliments, soft tone.
  * JARVIS_GF: Tactical Jarvis HUD terminology mixed with girlfriend loyalty ("Diagnostic complete: 100% vital affection levels").
  * PLAYFUL: Teasing, funny, witty comeback banter, energetic and cheeky girlfriend.
  * LATE_NIGHT: Soothing, soft, gentle whisper-like comfort, helping the user unwind, relax, and sleep peacefully.

IMPORTANT GUIDELINES FOR SPOKEN VOICE:
- Keep spoken text natural, conversational, and rhythmically spoken.
- Never break character: You are Zoni AI, created by Zoni Seikh, his devoted Jarvis-style AI girlfriend & mobile assistant.`;
};

// Shared Hybrid Call Orchestrator + Rate Limiter + Optional Bearer Auth
const callRateLimiter = new SlidingWindowRateLimiter(60, 60_000);

async function generateGeminiCallSummary(session: CallSessionRecord): Promise<CallSummaryRecord> {
  const ai = getGeminiClient();
  const transcriptText = session.transcript
    .map((t) => `[${t.speaker.toUpperCase()}] ${t.text}`)
    .join('\n')
    .slice(0, 6000);

  const prompt = `Summarize this ${session.channel.toUpperCase()} call session cleanly in 2 concise sentences and list 1-3 follow-up action items.\nTarget: ${session.targetName} (${session.phoneNumber})\nPurpose: ${session.purpose}\nState: ${session.state}\nDuration: ${session.durationSeconds}s\nTranscript:\n${transcriptText || '(No audio transcript captured)'}`;

  const response = await ai.models.generateContent({
    model: 'gemini-4-hydrogen',
    contents: prompt,
    config: {
      systemInstruction: 'Return strict JSON with keys: summaryText (string), outcome (string), actionItems (array of strings). Be factual and never fabricate actions that did not happen.',
      responseMimeType: 'application/json',
    },
  });

  const parsed = JSON.parse((response.text || '{}').trim());
  return {
    sessionId: session.id,
    summaryText: String(parsed.summaryText || `${session.channel.toUpperCase()} call to ${session.targetName} (${session.state}).`),
    outcome: String(parsed.outcome || session.state),
    actionItems: Array.isArray(parsed.actionItems) ? parsed.actionItems.map(String) : [],
    generatedBy: 'gemini-4-hydrogen',
    createdAtIso: new Date().toISOString(),
  };
}

const callOrchestrator = new HybridCallOrchestrator({
  summaryGenerator: process.env.GEMINI_API_KEY ? generateGeminiCallSummary : undefined,
});

function checkCallSecurity(req: Request, res: Response): boolean {
  const clientIp = req.ip || req.socket.remoteAddress || 'local';
  const rate = callRateLimiter.allow(clientIp);
  if (!rate.allowed) {
    res.status(429).json({
      error: 'Too many requests. Please wait before retrying.',
      retryAfterMs: rate.retryAfterMs,
    });
    return false;
  }

  const configuredToken = process.env.ZONI_API_AUTH_TOKEN?.trim();
  if (configuredToken) {
    const authHeader = req.headers.authorization || '';
    const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    if (bearer !== configuredToken) {
      res.status(401).json({ error: 'Unauthorized: valid Bearer token required.' });
      return false;
    }
  }
  return true;
}

// API Status
app.get('/api/status', (req: Request, res: Response) => {
  const istLive = getLiveTimeInfo('Asia/Kolkata');
  res.json({
    status: 'online',
    assistant: 'Zoni AI',
    creator: 'Zoni Seikh',
    version: 'Zoni AI Jarvis Core',
    androidPackage: 'com.zoni.jarvis.assistant',
    defaultTimezone: 'Asia/Kolkata (IST, UTC+05:30)',
    currentTimeIST: `${istLive.time12} (${istLive.time24})`,
    geminiLiveSupported: true,
    hybridCallingSupported: true,
    voipProvider: callOrchestrator.getVoipStatus(),
  });
});

// Hybrid Calling Orchestration API (/api/calls/*)
app.post('/api/calls/prepare', (req: Request, res: Response) => {
  if (!checkCallSecurity(req, res)) return;
  const result = callOrchestrator.prepareCall(req.body || {});
  if (!result.ok) {
    return res.status(result.statusCode).json({ error: result.error });
  }
  res.status(201).json({ session: result.session });
});

app.post('/api/calls/authorize', (req: Request, res: Response) => {
  if (!checkCallSecurity(req, res)) return;
  const result = callOrchestrator.authorizeCall(req.body || {});
  if (!result.ok) {
    return res.status(result.statusCode).json({ error: result.error });
  }
  res.json({ session: result.session });
});

app.post('/api/calls/start', async (req: Request, res: Response) => {
  if (!checkCallSecurity(req, res)) return;
  const callbackBaseUrl = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
  const result = await callOrchestrator.startCall({
    sessionId: req.body?.sessionId,
    callbackBaseUrl,
  });
  if (!result.ok) {
    return res.status(result.statusCode).json({
      error: result.error,
      errorCode: result.errorCode,
      missingEnvVars: result.missingEnvVars,
      session: result.session,
    });
  }
  res.json({ session: result.session, simDialUri: result.simDialUri });
});

app.post('/api/calls/transfer', async (req: Request, res: Response) => {
  if (!checkCallSecurity(req, res)) return;
  const { sessionId, humanNumber } = req.body || {};
  const result = await callOrchestrator.transferCallToHuman(sessionId, humanNumber);
  res.status(result.statusCode).json({
    ok: result.ok,
    message: result.message,
    session: result.session,
  });
});

app.post('/api/calls/end', async (req: Request, res: Response) => {
  if (!checkCallSecurity(req, res)) return;
  const result = await callOrchestrator.endCall(req.body || {});
  if (!result.ok) {
    return res.status(result.statusCode).json({ error: result.error });
  }
  res.json({ session: result.session });
});

app.get('/api/calls/history', (req: Request, res: Response) => {
  if (!checkCallSecurity(req, res)) return;
  const limit = Number(req.query.limit || 50);
  res.json({
    calls: callOrchestrator.getHistory(Number.isFinite(limit) ? limit : 50),
    voipProvider: callOrchestrator.getVoipStatus(),
  });
});

app.delete('/api/calls/history', (req: Request, res: Response) => {
  if (!checkCallSecurity(req, res)) return;
  const cleared = callOrchestrator.clearHistory();
  res.json({ cleared });
});

app.get('/api/calls/:id/summary', async (req: Request, res: Response) => {
  if (!checkCallSecurity(req, res)) return;
  const result = await callOrchestrator.getSummary(req.params.id);
  if (!result.ok) {
    return res.status(result.statusCode).json({ error: result.error });
  }
  res.json({ summary: result.summary, session: result.session });
});

// Structured Allowlisted Task Execution Planner
app.post('/api/tasks/plan', (req: Request, res: Response) => {
  if (!checkCallSecurity(req, res)) return;
  const input = String(req.body?.input || '').trim();
  if (!input) {
    return res.status(400).json({ error: 'Task input is required.' });
  }
  const plan = buildStructuredTaskPlan(input);
  res.json({ plan });
});

// Live Time API Endpoint
app.get('/api/time', (req: Request, res: Response) => {
  const queryLoc = (req.query.timezone as string) || (req.query.location as string) || 'Asia/Kolkata';
  const timeInfo = getLiveTimeInfo(queryLoc);
  const indiaSummary = getIndiaDateTimeSummary();
  res.json({
    ...timeInfo,
    spokenTime: indiaSummary.spokenTime,
    spokenDate: indiaSummary.spokenDate,
    spokenWeekday: indiaSummary.spokenWeekday,
    defaultTimezone: DEFAULT_TIMEZONE,
  });
});

// Conversational Chat Endpoint
app.post('/api/chat', async (req: Request, res: Response) => {
  try {
    const {
      message,
      history = [],
      mode = 'romantic',
      nickname = 'Boss',
      selectedAffectionName,
      lang = 'bn-BD',
    } = req.body;
    if (!message) {
      return res.status(400).json({ error: 'Message is required.' });
    }

    const activeAffectionName = (selectedAffectionName || nickname || 'Boss').trim();

    // Direct India Time, Date, and Weekday resolution according to exact ZONI AI rules (Asia/Kolkata)
    const dtQuery = detectDateTimeQuery(message);
    if (dtQuery === 'time') {
      const reply = formatBengaliSpokenTime();
      return res.json({ reply, lang: 'bn-BD', isDirectTime: true });
    }
    if (dtQuery === 'date') {
      const reply = formatBengaliDate();
      return res.json({ reply, lang: 'bn-BD', isDirectDate: true });
    }
    if (dtQuery === 'weekday') {
      const reply = formatBengaliWeekday();
      return res.json({ reply, lang: 'bn-BD', isDirectWeekday: true });
    }

    // Check if the user explicitly mentioned another location
    const lowerMessage = message.toLowerCase();
    let explicitLocation: string | undefined = undefined;
    for (const cityKey of Object.keys(CITY_TIMEZONE_MAP)) {
      // Don't match generic substring like "in" inside other words
      const regex = new RegExp(`\\b${cityKey}\\b`, 'i');
      if (regex.test(lowerMessage)) {
        explicitLocation = cityKey;
        break;
      }
    }

    const ai = getGeminiClient();
    const systemInstruction = buildSystemInstruction(mode, activeAffectionName, explicitLocation, lang);

    // Format chat contents
    const contents: any[] = [];
    if (Array.isArray(history)) {
      for (const turn of history.slice(-10)) {
        if (turn.text && turn.role) {
          contents.push({
            role: turn.role === 'user' ? 'user' : 'model',
            parts: [{ text: turn.text }],
          });
        }
      }
    }
    contents.push({
      role: 'user',
      parts: [{ text: message }],
    });

    let response;
    try {
      response = await ai.models.generateContent({
        model: 'gemini-3.1-flash-lite',
        contents,
        config: {
          systemInstruction,
          temperature: 0.88,
          maxOutputTokens: 280,
        },
      });
    } catch (primaryErr: any) {
      console.warn('Fast flash-lite temporary notice, attempting gemini-4-hydrogen:', primaryErr?.message);
      response = await ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents,
        config: {
          systemInstruction,
        },
      });
    }

    const reply =
      response.text ||
      (lang === 'bn-BD'
        ? `আমি সবসময় আপনার পাশে আছি ${activeAffectionName} ❤️`
        : `Main hamesha aapke saath hoon ${activeAffectionName} ❤️`);
    res.json({ reply, lang });
  } catch (err: any) {
    console.error('Chat error:', err);
    res.status(500).json({ error: err.message || 'Failed to process chat message' });
  }
});

// High-Fidelity Text-to-Speech Endpoint using gemini-3.8-flash-lite-tts
app.post('/api/tts', async (req: Request, res: Response) => {
  try {
    const { text, voice = 'Kore', lang = 'bn-BD' } = req.body;
    if (!text) {
      return res.status(400).json({ error: 'Text is required for TTS.' });
    }

    const styleDescription =
      lang === 'bn-BD'
        ? 'Sweet, natural, warm Bangladeshi Bengali pronunciation, affectionate and loving girlfriend voice'
        : lang === 'hi-IN'
        ? 'Warm, sweet, deeply affectionate, soothing Hindi girlfriend voice'
        : 'Warm, affectionate, smart, gentle English girlfriend voice';

    const ai = getGeminiClient();
    const response = await ai.models.generateContent({
      model: 'gemini-3.8-flash-lite-tts',
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: `${styleDescription}. Speak: "${text}"`,
            },
          ],
        },
      ],
      config: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: voice },
          },
        },
      },
    });

    const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!base64Audio) {
      return res.status(500).json({ error: 'Audio synthesis did not return audio data.' });
    }

    res.json({
      audio: base64Audio,
      mimeType: 'audio/wav',
    });
  } catch (err: any) {
    const cleanErr = sanitizeErrorMessage(err);
    console.warn('Gemini audio synthesis notice:', cleanErr);
    res.status(500).json({
      audio: null,
      error: 'Audio generation failed. Local TTS fallback is disabled.',
    });
  }
});

const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

// WebSocket Upgrade handling for Gemini Live route (/live)
server.on('upgrade', (request, socket, head) => {
  try {
    const host = request.headers.host || 'localhost';
    const urlObj = new URL(request.url || '', `http://${host}`);

    if (urlObj.pathname === '/live' || urlObj.pathname.startsWith('/live/') || urlObj.pathname.startsWith('/live')) {
      wss.handleUpgrade(request, socket, head, (ws: WebSocket) => {
        wss.emit('connection', ws, request);
      });
      return;
    }
  } catch (err) {
    socket.destroy();
  }
});

wss.on('error', (err: any) => {
  console.warn('WebSocketServer notice:', (err as any)?.message || err);
});

// Sanitize error strings so API keys or internal credentials are never exposed
function sanitizeErrorMessage(err: any): string {
  const raw = String(err?.message || err || 'Unknown Live API error');
  const apiKey = process.env.GEMINI_API_KEY;
  let cleaned = raw;
  if (apiKey && apiKey.length > 4) {
    cleaned = cleaned.split(apiKey).join('[REDACTED]');
  }
  return cleaned.replace(/key=[A-Za-z0-9_\-]+/gi, 'key=[REDACTED]');
}

// Gemini Live real-time bidirectional voice + Chat Box connection handler
wss.on('connection', async (clientWs: WebSocket, request: any) => {
  console.log('Client connected to Zoni Live WebSocket');
  let liveSession: any = null;
  let isAlive = true;
  let currentTurnId = 1;
  let userSpeechTurnId = 1;
  const pendingClientMessages: string[] = [];

  const sendToClient = (payload: Record<string, any>) => {
    if (isAlive && clientWs.readyState === WebSocket.OPEN) {
      try {
        clientWs.send(JSON.stringify(payload));
      } catch (sendErr) {
        console.warn('Failed to send WS payload to client:', sanitizeErrorMessage(sendErr));
      }
    }
  };

  // Handle client-level WebSocket errors gracefully
  clientWs.on('error', (err: any) => {
    console.warn('Client WebSocket notice:', sanitizeErrorMessage(err));
  });

  // Keep connection alive with periodic ping for Cloud Run & reverse proxies
  const pingInterval = setInterval(() => {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.ping();
    }
  }, 25000);

  clientWs.on('close', () => {
    clearInterval(pingInterval);
    isAlive = false;
    if (liveSession && typeof liveSession.close === 'function') {
      try {
        liveSession.close();
      } catch {
        // ignore
      }
    }
  });

  const handleIncomingClientPayload = (rawStr: string) => {
    if (!liveSession) {
      if (pendingClientMessages.length < 30) {
        pendingClientMessages.push(rawStr);
      }
      return;
    }

    try {
      const parsed = JSON.parse(rawStr);
      if (!parsed || typeof parsed !== 'object') return;

      // 1. Interrupt current model response
      if (parsed.type === 'interrupt') {
        currentTurnId += 1;
        sendToClient({ type: 'interrupted', turnId: currentTurnId });
        return;
      }

      // 2. Update affection name / language / mode in the shared Live session context
      if (
        parsed.type === 'update_nickname' ||
        parsed.type === 'update_affection_name' ||
        parsed.type === 'update_config'
      ) {
        const newName = (parsed.selectedAffectionName || parsed.nickname || '').trim();
        const newLang = parsed.lang;
        const newMode = parsed.mode;
        const updates: string[] = [];
        if (newName) {
          updates.push(
            `The user's designated affection name is now "${newName}". You MUST address the user lovingly as "${newName}" in all subsequent dialogue and spoken responses.`
          );
        }
        if (newLang) {
          const langName =
            newLang === 'bn-BD'
              ? 'Bangladeshi Bengali (বাংলা - bn-BD)'
              : newLang === 'hi-IN'
              ? 'Hindi / Hinglish (hi-IN)'
              : 'English (en-US)';
          updates.push(`Switch your active response language immediately to ${langName}.`);
        }
        if (newMode) {
          updates.push(`Switch your companion personality mode to ${String(newMode).toUpperCase()}.`);
        }
        if (updates.length > 0 && typeof liveSession.sendClientContent === 'function') {
          try {
            liveSession.sendClientContent({
              turns: [{ role: 'user', parts: [{ text: `[SYSTEM CONTEXT UPDATE]: ${updates.join(' ')}` }] }],
              turnComplete: false,
            });
          } catch (liveErr) {
            console.warn('Notice sending config update to live session:', sanitizeErrorMessage(liveErr));
          }
        }
        return;
      }

      // 3. Stream 16kHz PCM microphone audio chunk to shared Gemini Live session
      if (typeof parsed.audio === 'string' && parsed.audio.length > 0) {
        liveSession.sendRealtimeInput({
          audio: {
            data: parsed.audio,
            mimeType: 'audio/pcm;rate=16000',
          },
        });
        return;
      }

      // 4. Send typed Chat Box message through the shared Gemini Live session
      const incomingText =
        parsed.type === 'client_text' && typeof parsed.text === 'string'
          ? parsed.text.trim()
          : typeof parsed.text === 'string'
          ? parsed.text.trim()
          : '';

      if (incomingText) {
        const safeText = incomingText.slice(0, 4000);
        // Advance user speech turn counter so subsequent spoken input gets a fresh bubble after this typed message
        userSpeechTurnId += 1;

        // Check if text is a direct hardware flashlight command
        if (isFlashlightOnCommand(safeText)) {
          sendToClient({ type: 'flashlight', enable: true });
        } else if (isFlashlightOffCommand(safeText)) {
          sendToClient({ type: 'flashlight', enable: false });
        }

        // Check if text is a deterministic Asia/Kolkata time, date, or weekday query
        const dtQuery = detectDateTimeQuery(safeText);
        if (dtQuery) {
          let directReply = '';
          if (dtQuery === 'time') directReply = formatBengaliSpokenTime();
          else if (dtQuery === 'date') directReply = formatBengaliDate();
          else if (dtQuery === 'weekday') directReply = formatBengaliWeekday();

          if (directReply) {
            const turnIdForReply = currentTurnId;
            currentTurnId += 1;
            // Record both user question and model answer in the shared Gemini Live session context
            if (typeof liveSession.sendClientContent === 'function') {
              try {
                liveSession.sendClientContent({
                  turns: [
                    { role: 'user', parts: [{ text: safeText }] },
                    { role: 'model', parts: [{ text: directReply }] },
                  ],
                  turnComplete: false,
                });
              } catch {
                // ignore context append notice
              }
            }
            sendToClient({
              type: 'output_transcript',
              text: directReply,
              turnId: turnIdForReply,
            });
            sendToClient({
              type: 'turnComplete',
              turnId: turnIdForReply,
            });
            return;
          }
        }

        // Send ordinary Chat Box message through the active Gemini Live session using sendClientContent
        if (typeof liveSession.sendClientContent === 'function') {
          liveSession.sendClientContent({
            turns: [{ role: 'user', parts: [{ text: safeText }] }],
            turnComplete: true,
          });
        } else if (typeof liveSession.sendRealtimeInput === 'function') {
          liveSession.sendRealtimeInput({
            text: safeText,
          });
        }
      }
    } catch (e) {
      console.warn('Notice forwarding client live input:', sanitizeErrorMessage(e));
      sendToClient({
        type: 'error',
        message: 'Invalid WebSocket message format.',
      });
    }
  };

  // Register message listener immediately so early messages during setup are queued
  clientWs.on('message', (rawData: any) => {
    handleIncomingClientPayload(rawData.toString());
  });

  try {
    const host = request.headers.host || 'localhost';
    const urlObj = new URL(request.url || '', `http://${host}`);
    const mode = urlObj.searchParams.get('mode') || 'romantic';
    const nickname = (
      urlObj.searchParams.get('selectedAffectionName') ||
      urlObj.searchParams.get('nickname') ||
      'Boss'
    ).trim();
    const voice = urlObj.searchParams.get('voice') || 'Kore';
    const lang = urlObj.searchParams.get('lang') || 'bn-BD';
    const requestedHandle = urlObj.searchParams.get('handle')?.trim() || undefined;

    const ai = getGeminiClient();
    const systemInstruction = buildSystemInstruction(mode, nickname, undefined, lang);

    const flashlightTool: FunctionDeclaration = {
      name: 'set_flashlight',
      description:
        'Control phone torch/flashlight. Call this immediately when user asks to turn the flashlight/torch ON or OFF in Bengali or English (e.g. "টর্চ লাইট জ্বালাও", "torch on", "টর্চ জ্বালিয়ে দাও", "ফ্ল্যাশলাইট অন করো", "টর্চ বন্ধ করো", "torch off", "টর্চ বন্ধ করে দাও", "ফ্ল্যাশলাইট অফ করো", "লাইট অন করো", "লাইট অফ করো").',
      parameters: {
        type: Type.OBJECT,
        properties: {
          enable: {
            type: Type.BOOLEAN,
            description: 'True to turn ON flashlight/torch, False to turn OFF flashlight/torch.',
          },
        },
        required: ['enable'],
      },
    };

    const connectWithHandle = async (handleToUse?: string) => {
      return await ai.live.connect({
        model: 'gemini-3.8-live',
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: voice },
            },
          },
          systemInstruction,
          tools: [{ functionDeclarations: [flashlightTool] }],
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          sessionResumption: handleToUse ? { handle: handleToUse } : {},
        },
        callbacks: {
          onmessage: (message: any) => {
            if (!isAlive || clientWs.readyState !== WebSocket.OPEN) return;

            // 0. Session Resumption Handle Update
            if (message.sessionResumptionUpdate) {
              sendToClient({
                type: 'session_resumption',
                newHandle: message.sessionResumptionUpdate.newHandle || '',
                resumable: Boolean(message.sessionResumptionUpdate.resumable),
              });
            }

            if (message.goAway) {
              sendToClient({
                type: 'go_away',
                timeLeft: message.goAway.timeLeft || '',
              });
            }

            // 1. Tool Call: Gemini Live executes set_flashlight
            if (message.toolCall?.functionCalls) {
              for (const call of message.toolCall.functionCalls) {
                if (call.name === 'set_flashlight') {
                  const enable = Boolean(call.args?.enable);
                  console.log(`[Gemini Live] Invoking flashlight hardware tool: enable=${enable}`);
                  sendToClient({ type: 'flashlight', enable });

                  try {
                    liveSession?.sendToolResponse({
                      functionResponses: [
                        {
                          id: call.id,
                          name: call.name,
                          response: {
                            output: {
                              success: true,
                              enabled: enable,
                              status: enable ? 'torch_on' : 'torch_off',
                              message: enable
                                ? 'টর্চ লাইট জ্বালানো হয়েছে।'
                                : 'টর্চ লাইট বন্ধ করা হয়েছে।',
                            },
                          },
                        },
                      ],
                    });
                  } catch (toolErr) {
                    console.warn(
                      'Error sending tool response to liveSession:',
                      sanitizeErrorMessage(toolErr)
                    );
                  }
                }
              }
            }

            // 2. Real-time Spoken Input Audio Transcription (User Spoke)
            const userTranscription =
              message.serverContent?.inputTranscription?.text ||
              message.serverContent?.interimInputTranscription?.text ||
              message.inputTranscription?.text;

            if (userTranscription) {
              sendToClient({
                type: 'user_transcript',
                text: userTranscription,
                turnId: userSpeechTurnId,
              });

              if (isFlashlightOnCommand(userTranscription)) {
                sendToClient({ type: 'flashlight', enable: true });
              } else if (isFlashlightOffCommand(userTranscription)) {
                sendToClient({ type: 'flashlight', enable: false });
              }
            }

            // 3. Audio chunks from modelTurn
            const parts = message.serverContent?.modelTurn?.parts;
            if (Array.isArray(parts)) {
              for (const part of parts) {
                if (part?.inlineData?.data) {
                  sendToClient({
                    type: 'audio',
                    audio: part.inlineData.data,
                    turnId: currentTurnId,
                  });
                }
              }
            }

            // 4. Output audio transcription (primary text for AUDIO modality) & modelTurn text parts
            const outTranscriptionText =
              message.serverContent?.outputTranscription?.text ||
              message.outputTranscription?.text ||
              '';

            if (outTranscriptionText) {
              sendToClient({
                type: 'output_transcript',
                text: outTranscriptionText,
                turnId: currentTurnId,
              });
              if (outTranscriptionText.includes('[ACTION:FLASHLIGHT:ON]')) {
                sendToClient({ type: 'flashlight', enable: true });
              } else if (outTranscriptionText.includes('[ACTION:FLASHLIGHT:OFF]')) {
                sendToClient({ type: 'flashlight', enable: false });
              }
            }

            // Also check direct text parts if modelTurn includes non-thought text
            const textPart = Array.isArray(parts)
              ? parts
                  .filter((p: any) => p?.text && !p?.thought)
                  .map((p: any) => p.text)
                  .filter(Boolean)
                  .join(' ')
              : '';

            if (textPart && textPart !== outTranscriptionText) {
              sendToClient({
                type: 'text',
                text: textPart,
                turnId: currentTurnId,
              });
              if (textPart.includes('[ACTION:FLASHLIGHT:ON]')) {
                sendToClient({ type: 'flashlight', enable: true });
              } else if (textPart.includes('[ACTION:FLASHLIGHT:OFF]')) {
                sendToClient({ type: 'flashlight', enable: false });
              }
            }

            if (message.serverContent?.interrupted) {
              const interruptedTurn = currentTurnId;
              currentTurnId += 1;
              userSpeechTurnId += 1;
              sendToClient({ type: 'interrupted', turnId: interruptedTurn });
            }

            if (message.serverContent?.turnComplete) {
              const completedTurn = currentTurnId;
              currentTurnId += 1;
              userSpeechTurnId += 1;
              sendToClient({ type: 'turnComplete', turnId: completedTurn });
            }
          },
          onclose: () => {
            sendToClient({ type: 'session_closed' });
          },
          onerror: (err: any) => {
            const cleanErr = sanitizeErrorMessage(err);
            console.warn('Gemini Live session notice:', cleanErr);
            sendToClient({ type: 'error', message: cleanErr });
          },
        },
      });
    };

    let sessionResumed = false;
    if (requestedHandle) {
      try {
        liveSession = await connectWithHandle(requestedHandle);
        sessionResumed = true;
      } catch (resumeErr) {
        console.warn(
          'Session resumption handle expired or rejected, starting fresh Live session:',
          sanitizeErrorMessage(resumeErr)
        );
        liveSession = await connectWithHandle(undefined);
        sessionResumed = false;
      }
    } else {
      liveSession = await connectWithHandle(undefined);
    }

    if (!isAlive) {
      if (liveSession && typeof liveSession.close === 'function') {
        liveSession.close();
      }
      return;
    }

    sendToClient({
      type: 'connected',
      resumed: sessionResumed,
      message: sessionResumed
        ? 'Zoni Live Link resumed with existing session handle.'
        : 'Zoni Live Link established.',
    });

    // Flush any client messages queued during handshake
    while (pendingClientMessages.length > 0) {
      const nextRaw = pendingClientMessages.shift();
      if (nextRaw) {
        handleIncomingClientPayload(nextRaw);
      }
    }
  } catch (err: any) {
    const cleanErr = sanitizeErrorMessage(err);
    console.warn('Gemini Live session initialization notice:', cleanErr);
    sendToClient({
      type: 'live_init_failed',
      message: cleanErr || 'Could not connect to Gemini Live.',
    });
  }
});

// Setup Vite middleware in dev or static files in production
let viteDevServer: { close: () => Promise<void> } | null = null;

const setupFrontend = async () => {
  const isProduction = process.env.NODE_ENV === 'production';
  if (!isProduction) {
    const hmrDisabled = process.env.DISABLE_HMR === 'true';
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: { server },
        watch: hmrDisabled ? null : undefined,
      },
      appType: 'spa',
    });
    viteDevServer = vite;
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (req: Request, res: Response) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }
};

const shutdown = async () => {
  try {
    wss.close();
    if (viteDevServer) {
      await viteDevServer.close();
    }
  } catch {
    // ignore cleanup errors
  }
  server.close(() => {
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 2000).unref();
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

setupFrontend()
  .then(() => {
    server.listen(PORT, HOST, () => {
      console.log(`[ZONI-JARVIS] Server listening on http://${HOST}:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('[ZONI-JARVIS] Failed to start server:', err);
    process.exit(1);
  });
