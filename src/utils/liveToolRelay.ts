/**
 * Zoni AI — Live WebSocket Tool Relay Manager, Intent Routing Policy & Safe Diagnostics Helper.
 *
 * Pure, framework-agnostic TypeScript module shared between Express (`server.ts`)
 * and React (`src/App.tsx`) so WebSocket tool relay, timeouts, disconnects, duplicate-ID
 * protection, routing decisions, and diagnostic sanitization are 100% deterministic & unit-testable.
 */

import {
  ASSISTANT_TOOL_SPECS,
  validateGeminiToolCall,
  type ValidatedActionRequest,
} from './assistantActionRegistry.ts';
import { buildStructuredTaskPlan } from './taskExecutionEngine.ts';

export interface LiveToolCallWireMessage {
  type: 'native_tool_call';
  toolCallId: string;
  actionType: string;
  arguments: Record<string, string | boolean | number>;
  requiresConfirmation: boolean;
  requiredPermissions: string[];
  timeoutMs: number;
}

export interface LiveToolResultWirePayload {
  success: boolean;
  verified: boolean;
  awaitingConfirmation?: boolean;
  status: string;
  message: string;
  failureReason?: string;
  requiredPermissions?: string[];
  data?: Record<string, unknown>;
}

export interface LiveToolResultWireMessage {
  type: 'native_tool_result';
  toolCallId: string;
  actionType?: string;
  result: LiveToolResultWirePayload;
}

export interface GeminiFunctionCallLike {
  id?: string;
  name?: string;
  args?: Record<string, unknown>;
}

export interface GeminiFunctionResponseItem {
  id: string;
  name: string;
  response: {
    output: Record<string, unknown>;
  };
}

export interface LiveToolRelayTransport {
  sendToClient: (payload: Record<string, unknown>) => void;
  sendToolResponseToGemini: (responses: GeminiFunctionResponseItem[]) => void;
  isClientConnected: () => boolean;
}

interface PendingRelayEntry {
  toolCallId: string;
  geminiCallId: string;
  geminiCallName: string;
  validatedActionType: string;
  timer: ReturnType<typeof setTimeout>;
  createdAtMs: number;
}

/**
 * Manages bidirectional Gemini Live function calling over WebSocket:
 * Gemini Live toolCall -> validate -> client `native_tool_call` -> real Android execution
 * -> client `native_tool_result` -> `liveSession.sendToolResponse(...)`.
 *
 * Guarantees:
 * - Never fabricates success before real client execution.
 * - Rejects non-allowlisted or unsafe tools immediately without forwarding to client.
 * - Deduplicates duplicate toolCallIds safely.
 * - Handles multiple concurrent calls, client timeouts, and client disconnects cleanly.
 */
export class LiveToolRelayManager {
  private readonly pending = new Map<string, PendingRelayEntry>();
  private readonly completedIds = new Set<string>();
  private readonly transport: LiveToolRelayTransport;
  private readonly defaultGraceMs: number;
  private disposed = false;
  private seq = 1;

  constructor(transport: LiveToolRelayTransport, defaultGraceMs = 4500) {
    this.transport = transport;
    this.defaultGraceMs = defaultGraceMs;
  }

  getPendingCount(): number {
    return this.pending.size;
  }

  hasPending(toolCallId: string): boolean {
    return this.pending.has(toolCallId);
  }

  handleModelToolCalls(rawCalls: GeminiFunctionCallLike[]): {
    relayed: ValidatedActionRequest[];
    blocked: Array<{ id: string; name: string; reason: string }>;
    duplicatesSkipped: string[];
  } {
    const relayed: ValidatedActionRequest[] = [];
    const blocked: Array<{ id: string; name: string; reason: string }> = [];
    const duplicatesSkipped: string[] = [];

    if (this.disposed || !Array.isArray(rawCalls) || rawCalls.length === 0) {
      return { relayed, blocked, duplicatesSkipped };
    }

    const immediateResponses: GeminiFunctionResponseItem[] = [];

    for (const call of rawCalls) {
      const rawName = String(call?.name || '').trim();
      const geminiCallId =
        typeof call?.id === 'string' && call.id.trim()
          ? call.id.trim()
          : `live_tc_${Date.now()}_${this.seq++}`;

      // Duplicate ID guard (prevents double-execution on retransmitted toolCall frames)
      if (this.pending.has(geminiCallId) || this.completedIds.has(geminiCallId)) {
        duplicatesSkipped.push(geminiCallId);
        continue;
      }

      const validation = validateGeminiToolCall(
        rawName,
        (call?.args as Record<string, unknown>) || {},
        geminiCallId
      );

      if (!validation.valid || !validation.request) {
        const reason = validation.blockedReason || 'Blocked by Zoni AI allowlist policy.';
        blocked.push({ id: geminiCallId, name: rawName || 'unknown', reason });
        this.recordCompleted(geminiCallId);
        immediateResponses.push({
          id: geminiCallId,
          name: rawName || 'unknown',
          response: {
            output: {
              success: false,
              verified: false,
              status: 'blocked',
              failureReason: 'tool_validation_failed',
              message: reason,
            },
          },
        });
        continue;
      }

      const req = validation.request;
      if (!this.transport.isClientConnected()) {
        this.recordCompleted(geminiCallId);
        immediateResponses.push({
          id: geminiCallId,
          name: rawName || req.actionType,
          response: {
            output: {
              success: false,
              verified: false,
              status: 'failed',
              failureReason: 'client_disconnected',
              message: 'Client device is disconnected and could not execute the requested action.',
            },
          },
        });
        continue;
      }

      const effectiveTimeoutMs = Math.max(1500, req.timeoutMs + this.defaultGraceMs);
      const timer = setTimeout(() => {
        this.handleTimeout(geminiCallId);
      }, effectiveTimeoutMs);
      if (typeof (timer as any).unref === 'function') {
        (timer as any).unref();
      }

      this.pending.set(geminiCallId, {
        toolCallId: geminiCallId,
        geminiCallId,
        geminiCallName: rawName || req.actionType,
        validatedActionType: req.actionType,
        timer,
        createdAtMs: Date.now(),
      });

      const wireMsg: LiveToolCallWireMessage = {
        type: 'native_tool_call',
        toolCallId: geminiCallId,
        actionType: req.actionType,
        arguments: req.arguments,
        requiresConfirmation: req.requiresConfirmation,
        requiredPermissions: req.requiredPermissions,
        timeoutMs: req.timeoutMs,
      };
      this.transport.sendToClient(wireMsg as unknown as Record<string, unknown>);
      relayed.push(req);
    }

    if (immediateResponses.length > 0 && !this.disposed) {
      this.transport.sendToolResponseToGemini(immediateResponses);
    }

    return { relayed, blocked, duplicatesSkipped };
  }

  handleClientToolResult(msg: LiveToolResultWireMessage): boolean {
    if (this.disposed) return false;
    const toolCallId = String(msg?.toolCallId || '').trim();
    if (!toolCallId) return false;

    const entry = this.pending.get(toolCallId);
    if (!entry) {
      // Late or duplicate result after timeout/completion — safely ignored
      return false;
    }

    clearTimeout(entry.timer);
    this.pending.delete(toolCallId);
    this.recordCompleted(toolCallId);

    const r = msg.result || ({} as LiveToolResultWirePayload);
    const sanitizedOutput: Record<string, unknown> = {
      success: Boolean(r.success),
      verified: Boolean(r.verified),
      awaitingConfirmation: Boolean(r.awaitingConfirmation),
      status: String(r.status || (r.success ? 'executed' : 'failed')).slice(0, 80),
      message: String(r.message || '').slice(0, 900),
      ...(r.failureReason ? { failureReason: String(r.failureReason).slice(0, 300) } : {}),
      ...(Array.isArray(r.requiredPermissions) && r.requiredPermissions.length > 0
        ? { requiredPermissions: r.requiredPermissions.map((p) => String(p).slice(0, 64)) }
        : {}),
      ...(r.data && typeof r.data === 'object' ? { data: sanitizeToolResultData(r.data) } : {}),
    };

    this.transport.sendToolResponseToGemini([
      {
        id: entry.geminiCallId,
        name: entry.geminiCallName,
        response: {
          output: sanitizedOutput,
        },
      },
    ]);

    return true;
  }

  dispose(reason = 'session_closed'): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
    }
    this.pending.clear();
    void reason;
  }

  private handleTimeout(toolCallId: string): void {
    const entry = this.pending.get(toolCallId);
    if (!entry || this.disposed) return;
    this.pending.delete(toolCallId);
    this.recordCompleted(toolCallId);

    this.transport.sendToolResponseToGemini([
      {
        id: entry.geminiCallId,
        name: entry.geminiCallName,
        response: {
          output: {
            success: false,
            verified: false,
            status: 'timeout',
            failureReason: 'client_tool_timeout',
            message: `Timed out waiting for device execution result for ${entry.validatedActionType}. Do not claim it succeeded.`,
          },
        },
      },
    ]);
  }

  private recordCompleted(toolCallId: string): void {
    this.completedIds.add(toolCallId);
    // Keep bounded memory for long sessions
    if (this.completedIds.size > 300) {
      const oldest = this.completedIds.values().next().value;
      if (oldest) this.completedIds.delete(oldest);
    }
  }
}

function sanitizeToolResultData(raw: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'string') {
      safe[k] = v.slice(0, 400);
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      safe[k] = v;
    } else if (Array.isArray(v)) {
      safe[k] = v.slice(0, 15);
    }
  }
  return safe;
}

/**
 * Returns the canonical list of tool names exposed to both HTTP /api/chat and Gemini Live /live.
 */
export function getExposedAssistantToolNames(): string[] {
  return ASSISTANT_TOOL_SPECS.map((s) => s.name);
}

/**
 * Explicit Action-Intent Routing Policy (Root Cause 4).
 * Separates deterministic native commands, recognizable non-deterministic device-action intents,
 * and ordinary conversational chat cleanly.
 */
export type IntentExecutionRoute =
  | 'deterministic_native'
  | 'live_tool_relay'
  | 'http_function_calling'
  | 'gemini_conversation';

const ACTION_INTENT_SIGNALS = [
  // Bengali device/app/messaging action signals
  /(?:খোলো|খুলে\s*দাও|ওপেন\s*করো|ওপেন\s*করে\s*দাও|চালু\s*করো|চালু\s*করে\s*দাও|কল\s*করো|ফোন\s*করো|মেসেজ\s*(?:পাঠাও|পাঠিয়ে\s*দাও|পাঠিয়ে\s*দাও|লিখে\s*দাও|করো)|হোয়াটসঅ্যাপ|হোয়াটসঅ্যাপ|টেলিগ্রাম|ইনস্টাগ্রাম|ফেসবুক|ইউটিউব|ক্রোম|ক্যালকুলেটর|সেটিংস|টর্চ|ফ্ল্যাশলাইট|ভলিউম|ব্যাটারি|ক্যামেরা|স্ক্রল\s*করো|স্ক্রিনে\s*কী\s*আছে|নোটিফিকেশন|রিমাইন্ডার|কন্টাক্ট|অ্যাক্সেসিবিলিটি)/i,
  // English device/app/messaging action signals
  /\b(?:open|launch|start|call|dial|whatsapp|telegram|instagram|messenger|sms|text\s+message|send\s+(?:a\s+)?message|flashlight|torch|volume|battery|camera|settings|scroll\s+(?:up|down)|go\s+(?:home|back)|read\s+(?:my\s+)?(?:screen|notifications?)|installed\s+apps?|remind\s+me|search\s+youtube|cancel\s+(?:current\s+)?task)\b/i,
  // Hindi device/app/messaging action signals
  /(?:खोलो|खोल\s*दो|चालू\s*करो|कॉल\s*करो|फ़ोन\s*करो|फोन\s*करो|व्हाट्सएप|मैसेज\s*(?:भेजो|लिखो)|सेटिंग्स|टॉर्च|फ्लैशलाइट|वॉल्यूम|बैटरी|कैमरा|स्क्रॉल|स्क्रीन\s*पर|नोटिफिकेशन|कैलकुलेटर)/i,
];

export function looksLikeDeviceActionIntent(text: string): boolean {
  const clean = (text || '').trim();
  if (!clean || clean.length > 500) return false;
  return ACTION_INTENT_SIGNALS.some((re) => re.test(clean));
}

export function decideIntentExecutionRoute(
  text: string,
  options: { liveWsReadyWithTools: boolean; isDateTimeQuery?: boolean }
): IntentExecutionRoute {
  const clean = (text || '').trim();
  if (!clean) return 'gemini_conversation';
  if (options.isDateTimeQuery) return 'gemini_conversation';

  const plan = buildStructuredTaskPlan(clean);
  if (plan.blockedReason || plan.steps.length > 0) {
    return 'deterministic_native';
  }

  if (looksLikeDeviceActionIntent(clean)) {
    return options.liveWsReadyWithTools ? 'live_tool_relay' : 'http_function_calling';
  }

  return 'gemini_conversation';
}

/**
 * Prevents duplicate action execution when the same spoken/typed command is processed
 * by both Live WebSocket tool calling and transcript/HTTP fallback within a short window.
 */
export class RecentActionDeduplicator {
  private readonly seen = new Map<string, number>();
  private readonly windowMs: number;

  constructor(windowMs = 4500) {
    this.windowMs = windowMs;
  }

  buildSignature(actionType: string, args: Record<string, unknown>): string {
    const sortedKeys = Object.keys(args || {}).sort();
    const pairs = sortedKeys.map((k) => `${k}=${String(args[k] ?? '').trim().toLowerCase()}`);
    return `${actionType.trim().toLowerCase()}::${pairs.join('&')}`;
  }

  shouldExecute(actionType: string, args: Record<string, unknown>, nowMs = Date.now()): boolean {
    this.prune(nowMs);
    const sig = this.buildSignature(actionType, args);
    const prev = this.seen.get(sig);
    if (prev !== undefined && nowMs - prev < this.windowMs) {
      return false;
    }
    this.seen.set(sig, nowMs);
    return true;
  }

  markExecuted(actionType: string, args: Record<string, unknown>, nowMs = Date.now()): void {
    this.prune(nowMs);
    const sig = this.buildSignature(actionType, args);
    this.seen.set(sig, nowMs);
  }

  clear(): void {
    this.seen.clear();
  }

  private prune(nowMs: number): void {
    for (const [k, ts] of this.seen.entries()) {
      if (nowMs - ts >= this.windowMs) {
        this.seen.delete(k);
      }
    }
  }
}

/**
 * Sanitizes diagnostic metadata so private message bodies, phone numbers, and auth secrets
 * are NEVER stored in the Device Action Diagnostics UI or console logs (Root Cause 9).
 */
export interface DeviceActionDiagnosticsState {
  bridgeConnected: boolean;
  runtimeMode: string;
  executionPath: 'live_ws' | 'http_chat' | 'deterministic_native' | 'idle';
  geminiToolCallingAvailable: boolean;
  declaredToolsCount: number;
  accessibilityEnabled: boolean | null;
  contactsPermissionGranted: boolean | null;
  callPhonePermissionGranted: boolean | null;
  recordAudioPermissionGranted: boolean | null;
  notificationListenerEnabled: boolean | null;
  installedAppDiscoveryStatus: string;
  lastActionRequested: string;
  lastActionResult: string;
  lastFailureReason: string;
  updatedAtIso: string;
}

export function sanitizeDiagnosticActionLabel(
  actionType: string,
  args?: Record<string, unknown>
): string {
  const cleanType = String(actionType || 'none').trim();
  if (!args || typeof args !== 'object') return cleanType;

  // Never include private message body, phone numbers, or API keys in diagnostics
  if (cleanType === 'open_app' || cleanType === 'search_installed_app') {
    const app = String(args.app_name || args.appQuery || '').trim().slice(0, 40);
    return app ? `${cleanType}(app="${app}")` : cleanType;
  }
  if (cleanType === 'open_system_settings') {
    const target = String(args.target || 'main').trim().slice(0, 30);
    return `${cleanType}(target="${target}")`;
  }
  if (cleanType === 'prepare_whatsapp_message' || cleanType === 'prepare_sms' || cleanType === 'prepare_app_chat_message') {
    const app = args.app_name ? `app="${String(args.app_name).trim().slice(0, 24)}", ` : '';
    return `${cleanType}(${app}message=[REDACTED])`;
  }
  if (cleanType === 'call_contact' || cleanType === 'contact_search') {
    return `${cleanType}(contact=[REDACTED])`;
  }
  if (cleanType === 'flashlight_control') {
    return `${cleanType}(enable=${Boolean(args.enable)})`;
  }
  if (cleanType === 'volume_control') {
    return `${cleanType}(action="${String(args.action || 'status').slice(0, 16)}")`;
  }
  return cleanType;
}

export function sanitizeDiagnosticMessage(raw: string): string {
  return String(raw || '')
    .replace(/AIza[0-9A-Za-z_\-]{10,}/g, '[REDACTED_KEY]')
    .replace(/key=[A-Za-z0-9_\-]+/gi, 'key=[REDACTED]')
    .replace(/\+?\d[\d\s\-()]{7,}\d/g, '[REDACTED_PHONE]')
    .slice(0, 240);
}
