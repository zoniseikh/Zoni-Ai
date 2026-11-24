import { useState, useEffect, useRef, useCallback } from 'react';
import { AssistantState, CompanionMode, ChatMessage, SystemVitals, SupportedLanguage } from './types';
import { ArcReactor } from './components/ArcReactor';
import { HudHeader } from './components/HudHeader';
import { ControlDock } from './components/ControlDock';
import { ChatTranscriptDrawer } from './components/ChatTranscriptDrawer';
import { ApkExportModal } from './components/ApkExportModal';
import { PermissionsSetupModal } from './components/PermissionsSetupModal';
import { ZoniSettingsModal, BackendHealthSnapshot } from './components/ZoniSettingsModal';
import { SimCallingModal } from './components/SimCallingModal';
import { ActionConfirmationCard, PendingActionDraftState } from './components/ActionConfirmationCard';
import { ErrorBoundary } from './components/ErrorBoundary';
import { AlertTriangle, PhoneIncoming, PhoneOff, RefreshCw, Settings2, X } from 'lucide-react';
import { OfflineIndicator } from './components/PWAInstallButton';
import {
  FastEndOfSpeechDetector,
  LiveAudioPlayer,
  computePcmRms,
  pcm16ToBase64,
  playProceduralSfx,
  getAudioContext,
  resampleFloat32Pcm,
  stopAllBrowserSpeech,
} from './utils/audio';
import {
  detectAssistantIntent,
  detectLanguageSwitchCommand,
  executeAssistantActionDirectly,
  sendSystemNotification,
  toggleFlashlight,
  isFlashlightOnCommand,
  isFlashlightOffCommand,
} from './utils/mobileAssistant';
import {
  detectDateTimeQuery,
  formatBengaliSpokenTime,
  formatBengaliDate,
  formatBengaliWeekday,
} from './utils/bengaliDateTime';
import {
  checkAllPermissions,
  listenToPermissionChanges,
  ChromePermissionsReport,
  requestMicrophoneAccess,
} from './utils/permissionManager';
import {
  cleanupLegacyBackendStorage,
  getGeminiApiKeyForRequest,
  getGeminiApiKeyStatus,
  getGeminiConfigError,
  sanitizeGeminiSecret,
} from './utils/apiConfig';
import {
  DIRECT_CHAT_MODEL_CANDIDATES,
  DIRECT_LIVE_MODEL_CANDIDATES,
  analyzeScreenDirectGemini,
  buildDirectLiveAudioMessage,
  buildDirectLiveAudioStreamEndMessage,
  buildDirectLiveClientTextMessage,
  buildDirectLiveSetupMessage,
  buildDirectLiveToolResponseMessage,
  buildDirectLiveWebSocketUrl,
  buildZoniSystemInstruction,
  decodeDirectLiveFrame,
  parseDirectLiveServerMessage,
  sendDirectGeminiChat,
  sendDirectGeminiToolFeedback,
  synthesizeDirectGeminiTts,
  verifyDirectGeminiApiKey,
} from './utils/geminiDirectClient';
import {
  getNativeAndroidBridge,
  detectAndroidRuntimeMode,
  getNativePermissionsSnapshot,
  getNativeRuntimeDiagnostics,
  formatInstalledAppDiscoveryLabel,
  executeTypedActionViaNativeBridge,
  cancelPendingActionViaNativeBridge,
  listInstalledAppsViaNativeBridge,
  executeVerifiedWorkflowViaNativeBridge,
  requestDefaultDigitalAssistantViaNativeBridge,
  launchAppDetailedViaNativeBridge,
  captureNativeScreenSnapshot,
  getRecentNativeNotifications,
  adjustNativeVolume,
  openNativeCamera,
  performNativeAccessibilityDetailed,
  resolveAndroidPackageForQuery,
  buildAndroidIntentUrl,
  getNativeWakeWordStatus,
  startNativeBackgroundWakeWord,
  stopNativeBackgroundWakeWord,
  setNativeWakePhrase,
  notifyNativeVoiceSessionState,
  pauseNativeWakeWordForVoice,
  resumeNativeWakeWordAfterVoice,
  getNativeIncomingCallStatus,
  answerNativeIncomingCall,
  rejectNativeIncomingCall,
  endNativeActiveCall,
  requestNativeCallControlRole,
} from './utils/androidBridge';
import {
  deriveVoiceLifecycleState,
  stripWakePhraseFromCommand,
  type WakeWordStatusSnapshot,
  type IncomingCallStatusSnapshot,
  type VoiceLifecycleState,
} from './utils/voiceLifecycle';
import { buildStructuredTaskPlan, TaskStep } from './utils/taskExecutionEngine';
import {
  ASSISTANT_TOOL_SPECS,
  validateGeminiToolCall,
  formatLocalizedActionOutcome,
  ToolExecutionReport,
  ValidatedActionRequest,
} from './utils/assistantActionRegistry';
import {
  decideIntentExecutionRoute,
  RecentActionDeduplicator,
  DeviceActionDiagnosticsState,
  sanitizeDiagnosticActionLabel,
  sanitizeDiagnosticMessage,
} from './utils/liveToolRelay';
import {
  WsConnectionStatus,
  CLIENT_WS_PING_INTERVAL_MS,
  CLIENT_WS_STALE_TIMEOUT_MS,
  HEALTHY_SESSION_RESET_MS,
  buildClientTextPayload,
  classifyLiveWsCloseCode,
  extractActionTagFromText,
  upsertAssistantTurnMessage,
  upsertUserSpeechTurnMessage,
  getReconnectDelayMs,
  shouldAutoReconnectLiveWs,
  shouldUseHttpChatFallback,
} from './utils/liveSessionProtocol';

const SUPPORTED_GENERIC_CHAT_APPS = new Set(['telegram', 'instagram', 'messenger']);

function mapTaskStepToAssistantTool(
  step: TaskStep,
  fallbackText: string
): { name: string; args: Record<string, unknown> } | null {
  switch (step.tool) {
    case 'sim_call':
      return {
        name: 'call_contact',
        args: {
          recipient: String(step.args.contactQuery || step.args.phoneNumber || step.args.target || ''),
        },
      };
    case 'whatsapp_prepare':
      return {
        name: 'prepare_whatsapp_message',
        args: {
          recipient: String(step.args.contactQuery || step.args.phoneNumber || ''),
          message: String(step.args.message || ''),
        },
      };
    case 'app_chat_prepare':
      return {
        name: 'prepare_app_chat_message',
        args: {
          app_name: String(step.args.appName || ''),
          recipient: String(step.args.contactQuery || step.args.recipient || ''),
          message: String(step.args.message || ''),
        },
      };
    case 'sms_compose':
      return {
        name: 'prepare_sms',
        args: {
          recipient: String(step.args.contactQuery || step.args.phoneNumber || ''),
          message: String(step.args.message || ''),
        },
      };
    case 'open_app':
      return {
        name: 'open_app',
        args: { app_name: String(step.args.appQuery || '') },
      };
    case 'app_search_workflow': {
      const targetApp = String(step.args.appQuery || 'YouTube').trim();
      const query = String(step.args.searchQuery || '').trim();
      if (targetApp.toLowerCase() === 'youtube' && query) {
        return { name: 'search_youtube', args: { query } };
      }
      return {
        name: 'open_app',
        args: {
          app_name: targetApp,
          search_query: query,
        },
      };
    }
    case 'list_installed_apps':
      return { name: 'list_installed_apps', args: {} };
    case 'open_settings':
      return {
        name: 'open_system_settings',
        args: { target: String(step.args.target || 'main') },
      };
    case 'screen_analyze':
      return {
        name: 'read_visible_screen',
        args: { question: String(step.args.question || fallbackText) },
      };
    case 'notification_read':
      return {
        name: 'read_notifications',
        args: { whatsapp_only: Boolean(step.args.whatsappOnly) },
      };
    case 'accessibility_action': {
      const cmd = String(step.args.command || '');
      if (cmd === 'scroll_down') return { name: 'scroll_screen', args: { direction: 'down' } };
      if (cmd === 'scroll_up') return { name: 'scroll_screen', args: { direction: 'up' } };
      if (cmd === 'back') return { name: 'go_back', args: {} };
      if (cmd === 'home') return { name: 'go_home', args: {} };
      if (cmd.startsWith('tap:')) {
        return { name: 'tap_visible_element', args: { element_text: cmd.slice(4).trim() } };
      }
      return null;
    }
    case 'camera_open':
      return { name: 'camera_open', args: {} };
    case 'volume_control':
      return {
        name: 'volume_control',
        args: {
          action: String(step.args.action || 'status'),
          ...(step.args.percent !== undefined ? { percent: Number(step.args.percent) } : {}),
          ...(step.args.stream ? { stream: String(step.args.stream) } : {}),
        },
      };
    case 'flashlight':
      return { name: 'flashlight_control', args: { enable: Boolean(step.args.enable) } };
    case 'battery_status':
      return { name: 'battery_status', args: {} };
    case 'contact_lookup':
      return { name: 'contact_search', args: { query: String(step.args.query || '') } };
    case 'reminder':
      return { name: 'create_reminder', args: { note: String(step.args.note || '') } };
    case 'web_search':
      return { name: 'search_web', args: { query: String(step.args.query || '') } };
    case 'cancel_current_task':
      return { name: 'cancel_current_task', args: {} };
    case 'click_youtube_video':
      return {
        name: 'click_youtube_video',
        args: {
          ...(step.args.index !== undefined ? { index: Number(step.args.index) } : {}),
          ...(step.args.target ? { target: String(step.args.target) } : {}),
          ...(step.args.query ? { query: String(step.args.query) } : {}),
        },
      };
    case 'click_youtube_search_result':
      return {
        name: 'click_youtube_search_result',
        args: {
          index: Number(step.args.index || 1),
          ...(step.args.query ? { query: String(step.args.query) } : {}),
        },
      };
    case 'click_visible_element':
      return {
        name: 'click_visible_element',
        args: {
          target: String(step.args.target || ''),
          ...(step.args.index !== undefined ? { index: Number(step.args.index) } : {}),
        },
      };
    case 'click_whatsapp_contact':
      return {
        name: 'click_whatsapp_contact',
        args: {
          ...(step.args.contactName ? { contact_name: String(step.args.contactName) } : {}),
          ...(step.args.index !== undefined ? { index: Number(step.args.index) } : {}),
          ...(step.args.searchIfMissing !== undefined
            ? { search_if_missing: Boolean(step.args.searchIfMissing) }
            : {}),
        },
      };
    case 'open_whatsapp_chat':
      return {
        name: 'open_whatsapp_chat',
        args: {
          ...(step.args.contactName ? { contact_name: String(step.args.contactName) } : {}),
          ...(step.args.index !== undefined ? { index: Number(step.args.index) } : {}),
        },
      };
    case 'type_whatsapp_message':
      return {
        name: 'type_whatsapp_message',
        args: {
          ...(step.args.recipient ? { recipient: String(step.args.recipient) } : {}),
          message: String(step.args.message || ''),
        },
      };
    case 'send_whatsapp_message':
      return {
        name: 'send_whatsapp_message',
        args: {
          ...(step.args.recipient ? { recipient: String(step.args.recipient) } : {}),
          message: String(step.args.message || ''),
        },
      };
    case 'verify_whatsapp_send':
      return {
        name: 'verify_whatsapp_send',
        args: {
          ...(step.args.recipient ? { recipient: String(step.args.recipient) } : {}),
          message: String(step.args.message || ''),
        },
      };
    case 'answer_incoming_call':
      return { name: 'answer_incoming_call', args: {} };
    case 'reject_incoming_call':
      return { name: 'reject_incoming_call', args: {} };
    case 'end_active_call':
      return { name: 'end_active_call', args: {} };
    default:
      return null;
  }
}

export default function App() {
  const [assistantState, setAssistantState] = useState<AssistantState>('idle');
  const [isLiveActive, setIsLiveActive] = useState(false);
  const [isMicMuted, setIsMicMuted] = useState(false);
  const [wsStatus, setWsStatus] = useState<WsConnectionStatus>('disconnected');
  const [sessionResumed, setSessionResumed] = useState<boolean>(false);
  const [backendHealth, setBackendHealth] = useState<BackendHealthSnapshot | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [wakeWordStatus, setWakeWordStatus] = useState<WakeWordStatusSnapshot | null>(() =>
    getNativeWakeWordStatus()
  );
  const [incomingCallStatus, setIncomingCallStatus] = useState<IncomingCallStatusSnapshot | null>(
    () => getNativeIncomingCallStatus()
  );
  const [callControlNotice, setCallControlNotice] = useState<string | null>(null);
  const [isDisconnectingLive, setIsDisconnectingLive] = useState(false);
  const liveStartInFlightRef = useRef(false);
  const handleSendMessageRef = useRef<((text: string) => void) | null>(null);

  // Initialize global selectedAffectionName from localStorage, defaulting to "Boss" on first launch
  const [selectedAffectionName, setSelectedAffectionName] = useState<string>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('zoni_selected_affection_name');
      if (saved && saved.trim()) {
        return saved.trim();
      }
    }
    return 'Boss';
  });

  // Initialize active language from localStorage, defaulting to Bengali (bn-BD) on first launch
  const [activeLanguage, setActiveLanguage] = useState<SupportedLanguage>(() => {
    if (typeof window !== 'undefined') {
      const savedLang = localStorage.getItem('zoni_active_language');
      if (savedLang === 'bn-BD' || savedLang === 'hi-IN' || savedLang === 'en-US') {
        return savedLang as SupportedLanguage;
      }
    }
    return 'bn-BD';
  });

  const [voiceAutoPlay, setVoiceAutoPlay] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      const savedAuto = localStorage.getItem('zoni_voice_autoplay');
      if (savedAuto !== null) return savedAuto !== 'false';
    }
    return true;
  });

  const [voiceMuted, setVoiceMuted] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      const savedMute = localStorage.getItem('zoni_voice_muted');
      if (savedMute !== null) return savedMute === 'true';
    }
    return false;
  });

  const [latestTranscript, setLatestTranscript] = useState<string>(() => {
    let initialName = 'Boss';
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('zoni_selected_affection_name');
      if (saved && saved.trim()) initialName = saved.trim();
    }
    return `নমস্কার ${initialName}! Zoni AI কোর পুরোপুরি সক্রিয় আছে। আমার সাথে মন খুলে কথা বলুন ❤️`;
  });

  const [isChatDrawerOpen, setIsChatDrawerOpen] = useState(false);
  const [isApkModalOpen, setIsApkModalOpen] = useState(false);
  const [isCallingModalOpen, setIsCallingModalOpen] = useState(false);
  const [isPermissionsModalOpen, setIsPermissionsModalOpen] = useState(false);
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
  const [pendingActionDraft, setPendingActionDraft] = useState<PendingActionDraftState | null>(null);
  const pendingActionDraftRef = useRef<PendingActionDraftState | null>(null);
  useEffect(() => {
    pendingActionDraftRef.current = pendingActionDraft;
  }, [pendingActionDraft]);

  const [deviceDiagnostics, setDeviceDiagnostics] = useState<DeviceActionDiagnosticsState>(() => {
    const bridge = getNativeAndroidBridge();
    const mode = detectAndroidRuntimeMode();
    return {
      bridgeConnected: Boolean(bridge),
      runtimeMode: mode,
      executionPath: 'idle',
      geminiToolCallingAvailable: true,
      declaredToolsCount: ASSISTANT_TOOL_SPECS.length,
      accessibilityEnabled: bridge ? false : null,
      contactsPermissionGranted: bridge ? false : null,
      callPhonePermissionGranted: bridge ? false : null,
      recordAudioPermissionGranted: bridge ? false : null,
      notificationListenerEnabled: bridge ? false : null,
      installedAppDiscoveryStatus: bridge ? 'CHECKING...' : 'WEB PREVIEW (APK REQUIRED)',
      lastActionRequested: 'None',
      lastActionResult: 'None',
      lastFailureReason: 'None',
      updatedAtIso: new Date().toISOString(),
    };
  });
  const [permissionsReport, setPermissionsReport] = useState<ChromePermissionsReport>({
    microphone: 'prompt',
    geolocation: 'prompt',
    notifications: 'prompt',
    isSecureContext: true,
    hasChecked: false,
  });
  const [deferredPrompt, setDeferredPrompt] = useState<any>(null);

  const [vitals, setVitals] = useState<SystemVitals>(() => {
    let savedMode: CompanionMode = 'romantic';
    let savedVoice = 'Kore';
    let savedSfx = true;
    let savedName = 'Boss';
    let savedLang: SupportedLanguage = 'bn-BD';
    if (typeof window !== 'undefined') {
      const m = localStorage.getItem('zoni_companion_mode');
      if (m === 'romantic' || m === 'jarvis_gf' || m === 'playful' || m === 'late_night') {
        savedMode = m;
      }
      const v = localStorage.getItem('zoni_selected_voice');
      if (v && v.trim()) savedVoice = v.trim();
      const sfx = localStorage.getItem('zoni_sound_fx_enabled');
      if (sfx !== null) savedSfx = sfx !== 'false';
      const n = localStorage.getItem('zoni_selected_affection_name');
      if (n && n.trim()) savedName = n.trim();
      const l = localStorage.getItem('zoni_active_language');
      if (l === 'bn-BD' || l === 'hi-IN' || l === 'en-US') savedLang = l;
    }
    return {
      heartRate: 74,
      affectionLevel: 100,
      syncRate: 99.8,
      batteryCore: 99,
      activeMode: savedMode,
      selectedAffectionName: savedName,
      userNickname: savedName,
      selectedVoice: savedVoice,
      soundFxEnabled: savedSfx,
      totalInteractions: 3,
      loveUnlockedPoints: 120,
      activeLanguage: savedLang,
      voiceAutoPlay: true,
      voiceMuted: false,
    };
  });

  // Sync vitals with top-level state
  useEffect(() => {
    setVitals((prev) => ({
      ...prev,
      selectedAffectionName,
      userNickname: selectedAffectionName,
      activeLanguage,
      voiceAutoPlay,
      voiceMuted,
    }));
  }, [selectedAffectionName, activeLanguage, voiceAutoPlay, voiceMuted]);

  // Lock background page scroll and track Android IME visualViewport height while any modal is open
  const isAnyModalOpen =
    isSettingsModalOpen || isPermissionsModalOpen || isApkModalOpen || isCallingModalOpen;

  useEffect(() => {
    if (typeof window === 'undefined' || !isAnyModalOpen) return;

    const root = document.documentElement;
    const prevBodyOverflow = document.body.style.overflow;
    const prevHtmlOverflow = root.style.overflow;
    document.body.style.overflow = 'hidden';
    root.style.overflow = 'hidden';

    const updateVisualViewportHeight = () => {
      const vh = window.visualViewport?.height || window.innerHeight;
      if (vh > 0) {
        root.style.setProperty('--zoni-visual-vh', `${Math.round(vh)}px`);
      }
    };

    updateVisualViewportHeight();
    window.addEventListener('resize', updateVisualViewportHeight);
    window.visualViewport?.addEventListener('resize', updateVisualViewportHeight);
    window.visualViewport?.addEventListener('scroll', updateVisualViewportHeight);

    return () => {
      document.body.style.overflow = prevBodyOverflow;
      root.style.overflow = prevHtmlOverflow;
      root.style.removeProperty('--zoni-visual-vh');
      window.removeEventListener('resize', updateVisualViewportHeight);
      window.visualViewport?.removeEventListener('resize', updateVisualViewportHeight);
      window.visualViewport?.removeEventListener('scroll', updateVisualViewportHeight);
    };
  }, [isAnyModalOpen]);

  const [messages, setMessages] = useState<ChatMessage[]>(() => {
    let initialName = 'Boss';
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('zoni_selected_affection_name');
      if (saved && saved.trim()) initialName = saved.trim();
    }
    return [
      {
        id: 'welcome-1',
        role: 'assistant',
        text: `নমস্কার ${initialName}! Zoni AI সক্রিয় আছে। আপনি বাংলায় বা যেকোনো ভাষায় বলুন, আমি আপনার ভালোবাসার সাথী ও অ্যাসিস্ট্যান্ট হিসেবে সবসময় প্রস্তুত আছি ❤️`,
        timestamp: new Date(),
        lang: 'bn-BD',
      },
    ];
  });

  // Shared WebSocket & Audio refs (using useRef to avoid stale closures inside callbacks)
  const liveAudioPlayerRef = useRef<LiveAudioPlayer | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const wsConnectPromiseRef = useRef<Promise<void> | null>(null);
  const wsHandshakeResolverRef = useRef<{
    resolve: () => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  const liveNonRetryableErrorRef = useRef<string | null>(null);
  const isSessionReadyRef = useRef<boolean>(false);
  const resumptionHandleRef = useRef<string | undefined>(undefined);
  const preferredChatModelRef = useRef<string>(DIRECT_CHAT_MODEL_CANDIDATES[0]);
  const preferredLiveModelRef = useRef<string>(DIRECT_LIVE_MODEL_CANDIDATES[0]);
  const liveModelFallbackIdxRef = useRef<number>(0);
  const hadConnectedOnceRef = useRef<boolean>(false);
  const reconnectAttemptRef = useRef<number>(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wsHealthyResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wsClientPingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const wsLastActivityAtRef = useRef<number>(0);
  const goAwayRotatingRef = useRef<boolean>(false);
  const turnTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const outgoingQueueRef = useRef<string[]>([]);
  const isUnmountedRef = useRef<boolean>(false);
  const pendingChatFallbackRef = useRef<{
    clientMsgId: string;
    text: string;
    historySnapshot: Array<{ role: 'user' | 'assistant'; text: string }>;
    answered: boolean;
    fallbackStarted: boolean;
  } | null>(null);

  const currentTurnIdRef = useRef<number>(1);
  const userSpeechTurnIdRef = useRef<number>(1);
  const receivedAudioInTurnRef = useRef<boolean>(false);

  const mediaStreamRef = useRef<MediaStream | null>(null);
  const inputAudioCtxRef = useRef<AudioContext | null>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const useFastVadConfigRef = useRef<boolean>(true);
  const fastEosDetectorRef = useRef<FastEndOfSpeechDetector>(new FastEndOfSpeechDetector());
  const isAssistantSpeakingRef = useRef<boolean>(false);
  const lastFlashlightActionRef = useRef<{ payload: string; time: number } | null>(null);
  const liveToolsReadyRef = useRef<boolean>(false);
  const liveToolExecutedInTurnRef = useRef<boolean>(false);
  const currentSpeechTranscriptRef = useRef<string>('');
  const voiceTranscriptDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recentActionDeduplicatorRef = useRef<RecentActionDeduplicator>(
    new RecentActionDeduplicator(5000)
  );

  // Latest state refs for WebSocket / Audio callbacks
  const messagesRef = useRef<ChatMessage[]>(messages);
  const wsStatusRef = useRef<WsConnectionStatus>(wsStatus);
  const isLiveActiveRef = useRef(isLiveActive);
  const isMicMutedRef = useRef(isMicMuted);
  const voiceMutedRef = useRef(voiceMuted);
  const voiceAutoPlayRef = useRef(voiceAutoPlay);
  const activeLanguageRef = useRef<SupportedLanguage>(activeLanguage);
  const selectedAffectionNameRef = useRef(selectedAffectionName);
  const activeModeRef = useRef<CompanionMode>(vitals.activeMode);
  const selectedVoiceRef = useRef<string>(vitals.selectedVoice);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  useEffect(() => {
    wsStatusRef.current = wsStatus;
  }, [wsStatus]);
  useEffect(() => {
    isLiveActiveRef.current = isLiveActive;
  }, [isLiveActive]);
  useEffect(() => {
    isMicMutedRef.current = isMicMuted;
  }, [isMicMuted]);
  useEffect(() => {
    voiceMutedRef.current = voiceMuted;
  }, [voiceMuted]);
  useEffect(() => {
    voiceAutoPlayRef.current = voiceAutoPlay;
  }, [voiceAutoPlay]);
  useEffect(() => {
    activeLanguageRef.current = activeLanguage;
  }, [activeLanguage]);
  useEffect(() => {
    selectedAffectionNameRef.current = selectedAffectionName;
  }, [selectedAffectionName]);
  useEffect(() => {
    activeModeRef.current = vitals.activeMode;
  }, [vitals.activeMode]);
  useEffect(() => {
    selectedVoiceRef.current = vitals.selectedVoice;
  }, [vitals.selectedVoice]);

  // Stop any ongoing spoken audio to prevent overlapping duplicate audio
  const stopAllSpeechPlayback = useCallback(() => {
    stopAllBrowserSpeech();
    if (liveAudioPlayerRef.current) {
      liveAudioPlayerRef.current.stopAll();
    }
  }, []);

  // Clear thinking timeout helper
  const clearTurnTimeout = useCallback(() => {
    if (turnTimeoutRef.current) {
      clearTimeout(turnTimeoutRef.current);
      turnTimeoutRef.current = null;
    }
  }, []);

  const clearWsConnectionTimers = useCallback(() => {
    if (wsHealthyResetTimerRef.current) {
      clearTimeout(wsHealthyResetTimerRef.current);
      wsHealthyResetTimerRef.current = null;
    }
    if (wsClientPingTimerRef.current) {
      clearInterval(wsClientPingTimerRef.current);
      wsClientPingTimerRef.current = null;
    }
  }, []);

  const settlePendingHandshake = useCallback((error?: Error) => {
    const pending = wsHandshakeResolverRef.current;
    if (!pending) return;
    clearTimeout(pending.timer);
    wsHandshakeResolverRef.current = null;
    wsConnectPromiseRef.current = null;
    if (error) {
      pending.reject(error);
    } else {
      pending.resolve();
    }
  }, []);

  // Verify user-owned Gemini API key directly against Google Gemini API (no backend URL required)
  const checkBackendHealth = useCallback(async (): Promise<BackendHealthSnapshot> => {
    cleanupLegacyBackendStorage();
    const keyStatus = getGeminiApiKeyStatus();
    const rawKey = getGeminiApiKeyForRequest();

    if (!keyStatus.configured || !rawKey) {
      const configError = getGeminiConfigError(undefined, activeLanguageRef.current);
      const snap: BackendHealthSnapshot = {
        checked: true,
        reachable: false,
        geminiConfigured: false,
        statusText: 'API KEY REQUIRED',
        configurationError: configError,
        maskedKeyPreview: '',
        storageLabel: keyStatus.storageLabel,
      };
      setBackendHealth(snap);
      setDeviceDiagnostics((prev) => ({
        ...prev,
        geminiToolCallingAvailable: false,
        declaredToolsCount: ASSISTANT_TOOL_SPECS.length,
        updatedAtIso: new Date().toISOString(),
      }));
      setWsStatus('disconnected');
      return snap;
    }

    const verify = await verifyDirectGeminiApiKey(rawKey, fetch, activeLanguageRef.current);
    if (verify.ok) {
      preferredChatModelRef.current = verify.preferredChatModel;
      preferredLiveModelRef.current = verify.preferredLiveModel;
      liveModelFallbackIdxRef.current = Math.max(
        0,
        DIRECT_LIVE_MODEL_CANDIDATES.indexOf(verify.preferredLiveModel as any)
      );
    }

    const snap: BackendHealthSnapshot = {
      checked: true,
      reachable: verify.ok,
      geminiConfigured: verify.ok,
      statusText: verify.statusText,
      configurationError: verify.ok ? null : verify.message,
      maskedKeyPreview: keyStatus.maskedPreview,
      storageLabel: keyStatus.storageLabel,
      preferredChatModel: verify.preferredChatModel,
      preferredLiveModel: verify.preferredLiveModel,
    };
    setBackendHealth(snap);
    setDeviceDiagnostics((prev) => ({
      ...prev,
      geminiToolCallingAvailable: verify.ok,
      declaredToolsCount: ASSISTANT_TOOL_SPECS.length,
      updatedAtIso: new Date().toISOString(),
    }));
    if (!verify.ok) {
      setConnectionError(verify.message);
      if (verify.code === 'GEMINI_KEY_INVALID') {
        liveNonRetryableErrorRef.current = verify.message;
      }
    } else {
      liveNonRetryableErrorRef.current = null;
      setConnectionError((prev) =>
        prev && /api key|backend|gemini/i.test(prev) ? null : prev
      );
    }
    return snap;
  }, []);

  const refreshDeviceDiagnostics = useCallback(() => {
    try {
      const bridge = getNativeAndroidBridge();
      const mode = detectAndroidRuntimeMode();
      const nativeDiag = getNativeRuntimeDiagnostics();
      const nativePerms = getNativePermissionsSnapshot();
      const apps = bridge ? listInstalledAppsViaNativeBridge() : null;

      setDeviceDiagnostics((prev) => ({
        ...prev,
        bridgeConnected: Boolean(bridge),
        runtimeMode: mode,
        accessibilityEnabled:
          nativeDiag?.accessibilityEnabled ?? nativePerms?.accessibilityEnabled ?? null,
        contactsPermissionGranted:
          nativeDiag?.contactsPermissionGranted ?? nativePerms?.readContacts ?? null,
        callPhonePermissionGranted:
          nativeDiag?.callPhonePermissionGranted ?? nativePerms?.callPhone ?? null,
        recordAudioPermissionGranted:
          nativeDiag?.recordAudioPermissionGranted ?? nativePerms?.recordAudio ?? null,
        notificationListenerEnabled:
          nativeDiag?.notificationListenerEnabled ?? nativePerms?.notificationListenerEnabled ?? null,
        installedAppDiscoveryStatus: formatInstalledAppDiscoveryLabel(
          nativeDiag,
          apps ? apps.length : null,
          Boolean(bridge)
        ),
        lastActionRequested:
          nativeDiag?.lastActionRequested && nativeDiag.lastActionRequested !== 'none'
            ? sanitizeDiagnosticMessage(nativeDiag.lastActionRequested)
            : prev.lastActionRequested,
        lastActionResult:
          nativeDiag?.lastActionResult && nativeDiag.lastActionResult !== 'none'
            ? sanitizeDiagnosticMessage(nativeDiag.lastActionResult)
            : prev.lastActionResult,
        lastFailureReason:
          nativeDiag?.lastFailureReason && nativeDiag.lastFailureReason !== 'none'
            ? sanitizeDiagnosticMessage(nativeDiag.lastFailureReason)
            : prev.lastFailureReason,
        updatedAtIso: new Date().toISOString(),
      }));
    } catch (err) {
      console.error('[ZONI] Failed to refresh device diagnostics:', err);
    }
  }, []);

  const recordActionDiagnostic = useCallback(
    (
      path: DeviceActionDiagnosticsState['executionPath'],
      actionType: string,
      args: Record<string, unknown>,
      report: ToolExecutionReport
    ) => {
      const safeLabel = sanitizeDiagnosticActionLabel(actionType, args);
      const failureCode =
        !report.success
          ? String(
              (report.data as Record<string, unknown> | undefined)?.failureReason ||
                report.status ||
                'action_failed'
            )
          : 'None';
      const resultSummary = `${report.status || (report.success ? 'executed' : 'failed')}${
        report.awaitingConfirmation ? ' (awaiting confirmation)' : report.verified ? ' (verified)' : ''
      }`;

      setDeviceDiagnostics((prev) => ({
        ...prev,
        executionPath: path,
        lastActionRequested: safeLabel,
        lastActionResult: sanitizeDiagnosticMessage(resultSummary),
        lastFailureReason: failureCode === 'None' ? 'None' : sanitizeDiagnosticMessage(failureCode),
        updatedAtIso: new Date().toISOString(),
      }));
    },
    []
  );

  useEffect(() => {
    if (isSettingsModalOpen) {
      refreshDeviceDiagnostics();
    }
  }, [isSettingsModalOpen, refreshDeviceDiagnostics]);

  // Stop only microphone audio capture while keeping the shared Gemini Live WebSocket session open
  const stopVoiceCapture = useCallback((preserveErrorState = false) => {
    setIsDisconnectingLive(true);
    if (scriptProcessorRef.current) {
      try {
        scriptProcessorRef.current.disconnect();
      } catch {
        // ignore
      }
      scriptProcessorRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }
    if (inputAudioCtxRef.current && inputAudioCtxRef.current.state !== 'closed') {
      try {
        inputAudioCtxRef.current.close();
      } catch {
        // ignore
      }
      inputAudioCtxRef.current = null;
    }
    setIsLiveActive(false);
    isLiveActiveRef.current = false;
    resumeNativeWakeWordAfterVoice();
    if (!preserveErrorState) {
      setAssistantState('idle');
    }
    setIsDisconnectingLive(false);
  }, []);

  // Unified Allowlisted Android Personal Assistant Tool Executor (20 Tools, Strict Verification & Confirmation)
  const executeValidatedAssistantTool = useCallback(
    async (
      rawToolName: string,
      rawArgs: Record<string, unknown>,
      providedActionId?: string
    ): Promise<ToolExecutionReport> => {
      const validation = validateGeminiToolCall(rawToolName, rawArgs, providedActionId);
      if (!validation.valid || !validation.request) {
        return {
          actionId: providedActionId || `blocked_${Date.now()}`,
          actionType: rawToolName,
          success: false,
          verified: false,
          status: 'blocked',
          message: validation.blockedReason || 'Blocked by Zoni AI allowlist security policy.',
        };
      }

      const req = validation.request;
      const bridge = getNativeAndroidBridge();
      const lang = activeLanguageRef.current;

      // 1. Direct Communication Tools (WhatsApp, SMS, Call, Supported App Chats — NO routine confirmation; disambiguate ONLY on multiple matches)
      if (
        req.actionType === 'prepare_whatsapp_message' ||
        req.actionType === 'send_whatsapp_message' ||
        req.actionType === 'prepare_sms' ||
        req.actionType === 'call_contact' ||
        req.actionType === 'prepare_app_chat_message'
      ) {
        const recipient = String(req.arguments.recipient || '').trim();
        const messageText = String(req.arguments.message || '').trim();
        const rawAppName = String(req.arguments.app_name || '').trim();

        if (req.actionType === 'prepare_app_chat_message') {
          const normalizedApp = rawAppName.toLowerCase();
          if (!SUPPORTED_GENERIC_CHAT_APPS.has(normalizedApp)) {
            return {
              actionId: req.actionId,
              actionType: req.actionType,
              success: false,
              verified: true,
              status: 'unsupported_chat_app',
              message:
                lang === 'bn-BD'
                  ? `"${rawAppName || 'এই অ্যাপ'}"-এর জন্য যাচাইকৃত অটোমেটেড চ্যাট অ্যাডাপ্টার নেই। বর্তমানে WhatsApp, SMS, Telegram, Instagram ও Messenger সাপোর্টেড।`
                  : `Automated chat messaging is not supported for "${rawAppName || 'this app'}". Currently supported apps: WhatsApp, SMS, Telegram, Instagram, and Messenger.`,
              data: { failureReason: 'unsupported_chat_app', appName: rawAppName },
            };
          }
        }

        if (bridge?.executeTypedActionJson) {
          const nativeReport = executeTypedActionViaNativeBridge(
            req.actionType,
            req.arguments,
            req.actionId
          );
          if (nativeReport) {
            const rawCandidates = Array.isArray(nativeReport.data?.candidates)
              ? nativeReport.data.candidates
              : [];
            const needsDisambiguation =
              (nativeReport.status === 'multiple_contacts' ||
                nativeReport.status === 'multiple_numbers') &&
              rawCandidates.length > 1;

            if (needsDisambiguation) {
              setPendingActionDraft({
                pendingActionId: nativeReport.pendingActionId || `disambig_${Date.now()}`,
                actionType:
                  req.actionType === 'send_whatsapp_message'
                    ? 'prepare_whatsapp_message'
                    : req.actionType,
                appName:
                  req.actionType === 'prepare_app_chat_message'
                    ? String(nativeReport.data?.appName || rawAppName || 'Telegram')
                    : undefined,
                recipientName: String(nativeReport.data?.recipient || nativeReport.data?.contactName || recipient),
                phoneNumber: '',
                messageText: String(nativeReport.data?.messageText || nativeReport.data?.message || messageText),
                candidates: rawCandidates,
                isNativePending: true,
                statusNote: nativeReport.message,
              });
            } else {
              setPendingActionDraft(null);
            }
            return nativeReport;
          }
        }

        // Web preview / PWA direct execution (NO routine confirmation cards, NEVER guess unknown phone numbers)
        setPendingActionDraft(null);
        const digitsOnly = recipient.replace(/[^\d+]/g, '');
        const isNumeric = digitsOnly.length >= 7;
        const displayRecipientName = String(req.arguments.recipient_name || recipient).trim() || recipient;
        const safeAppName = typeof rawAppName === 'string' ? rawAppName.trim() : '';
        const displayAppName =
          req.actionType === 'prepare_app_chat_message' && safeAppName
            ? safeAppName.charAt(0).toUpperCase() + safeAppName.slice(1).toLowerCase()
            : undefined;

        if (req.actionType === 'prepare_app_chat_message') {
          return {
            actionId: req.actionId,
            actionType: 'prepare_app_chat_message',
            success: false,
            verified: true,
            status: 'native_android_required',
            message:
              lang === 'bn-BD'
                ? `${displayAppName}-এ সরাসরি মেসেজ পাঠাতে Android APK ও Zoni Accessibility Service প্রয়োজন।`
                : `Direct ${displayAppName} messaging requires the installed Android APK with Zoni Accessibility Service enabled.`,
            data: { appName: displayAppName, contactName: displayRecipientName },
          };
        }

        if (!isNumeric) {
          return {
            actionId: req.actionId,
            actionType: req.actionType,
            success: false,
            verified: true,
            status: 'native_android_required',
            requiredPermissions: ['READ_CONTACTS'],
            message:
              lang === 'bn-BD'
                ? `"${recipient}" কন্টাক্টের ফোন নম্বর খুঁজে সরাসরি কাজ করতে Android APK (READ_CONTACTS পারমিশনসহ) প্রয়োজন, অথবা সরাসরি ফোন নম্বর বলুন।`
                : `Resolving saved contact "${recipient}" without guessing requires the installed Android APK with Contacts permission, or please provide the exact phone number.`,
            data: { recipient, failureReason: 'contacts_unavailable_in_web_preview' },
          };
        }

        if (req.actionType === 'call_contact') {
          executeAssistantActionDirectly({
            type: 'call',
            target: digitsOnly,
            label: `Call ${displayRecipientName}`,
          });
          return {
            actionId: req.actionId,
            actionType: 'call_contact',
            success: true,
            verified: true,
            status: 'dialer_opened',
            message:
              lang === 'bn-BD'
                ? `${displayRecipientName} (${digitsOnly})-এ কল করার জন্য ডায়ালার খোলা হয়েছে।`
                : `Opened dialer for ${displayRecipientName} (${digitsOnly}).`,
            data: { contactName: displayRecipientName, phoneNumber: digitsOnly },
          };
        }

        if (req.actionType === 'prepare_whatsapp_message' || req.actionType === 'send_whatsapp_message') {
          executeAssistantActionDirectly({
            type: 'whatsapp',
            target: digitsOnly,
            payload: messageText,
            label: `WhatsApp ${displayRecipientName}`,
          });
          return {
            actionId: req.actionId,
            actionType: req.actionType,
            target: displayRecipientName,
            success: true,
            verified: true,
            status: 'opened_whatsapp_draft_ready_to_send',
            executionStatus: 'opened_whatsapp_draft_ready_to_send',
            message:
              lang === 'bn-BD'
                ? `${displayRecipientName}-এর জন্য WhatsApp চ্যাট খুলে দেওয়া হয়েছে।`
                : `Opened WhatsApp chat for ${displayRecipientName}.`,
            data: { contactName: displayRecipientName, phoneNumber: digitsOnly, message: messageText },
          };
        }

        // prepare_sms in web preview
        executeAssistantActionDirectly({
          type: 'sms',
          target: digitsOnly,
          payload: messageText,
          label: `SMS ${displayRecipientName}`,
        });
        return {
          actionId: req.actionId,
          actionType: 'prepare_sms',
          success: true,
          verified: true,
          status: 'opened_sms_composer_ready_to_send',
          message:
            lang === 'bn-BD'
              ? `${displayRecipientName} (${digitsOnly})-এর জন্য SMS অ্যাপ খোলা হয়েছে।`
              : `Opened SMS composer for ${displayRecipientName} (${digitsOnly}).`,
          data: { contactName: displayRecipientName, phoneNumber: digitsOnly, message: messageText },
        };
      }

      // 2. Open App (with optional verified Accessibility search workflow e.g., YouTube search)
      if (req.actionType === 'open_app') {
        const appName = String(req.arguments.app_name || '').trim();
        const searchQuery = String(req.arguments.search_query || '').trim();

        if (bridge) {
          const launchRes = launchAppDetailedViaNativeBridge(appName);
          if (!launchRes || (launchRes.status !== 'launched' && !launchRes.success)) {
            return {
              actionId: req.actionId,
              actionType: 'open_app',
              success: false,
              verified: true,
              status: launchRes?.status || 'app_not_found',
              message:
                launchRes?.message ||
                (lang === 'bn-BD'
                  ? `"${appName}" অ্যাপটি আপনার ফোনে ইনস্টল করা নেই বা খোলা যায়নি।`
                  : `"${appName}" is not installed or could not be opened on this device.`),
            };
          }

          if (searchQuery) {
            const pkg = launchRes.packageName || '';
            const workflowReport = executeVerifiedWorkflowViaNativeBridge([
              { action: 'wait', durationMs: 900, expectedPackage: pkg },
              { action: 'tap', target: 'Search', expectedPackage: pkg },
              { action: 'wait', durationMs: 450, expectedPackage: pkg },
              { action: 'enter_text', target: 'Search', text: searchQuery, expectedPackage: pkg },
            ]);
            if (workflowReport) {
              return workflowReport;
            }
          }

          return {
            actionId: req.actionId,
            actionType: 'open_app',
            success: true,
            verified: true,
            status: 'launched',
            message: launchRes.message || `${appName} opened.`,
            data: { appLabel: launchRes.appLabel, packageName: launchRes.packageName },
          };
        }

        // Web preview honest behavior for open_app
        const lowerApp = appName.toLowerCase();
        if (searchQuery && (lowerApp.includes('youtube') || lowerApp.includes('ইউটিউব'))) {
          return {
            actionId: req.actionId,
            actionType: 'open_app',
            success: true,
            verified: true,
            status: 'web_workflow_info',
            message:
              lang === 'bn-BD'
                ? `YouTube-এ "${searchQuery}" খোঁজার ওয়ার্কফ্লো প্রস্তুত। সম্পূর্ণ ইন-অ্যাপ সার্চ অ্যাক্সেসিবিলিটি ওয়ার্কফ্লো ইনস্টল করা Android APK-তে কাজ করে (যেখানে YouTube খুলে Search বাটনে ট্যাপ করে "${searchQuery}" লেখা যাচাই করা হয়)।`
                : `YouTube search workflow for "${searchQuery}" is ready. Full verified in-app search runs inside the installed Android APK with Accessibility Service enabled.`,
          };
        }
        const pkg = resolveAndroidPackageForQuery(appName);
        return {
          actionId: req.actionId,
          actionType: 'open_app',
          success: Boolean(pkg),
          verified: false,
          status: pkg ? 'web_preview_limited' : 'app_not_found',
          message: pkg
            ? lang === 'bn-BD'
              ? `"${appName}" (${pkg}) শনাক্ত করা হয়েছে। সরাসরি অ্যাপ চালু করতে Zoni AI Android APK-তে চালান।`
              : `Resolved "${appName}" (${pkg}). Direct native app launching works inside the installed Android APK.`
            : lang === 'bn-BD'
            ? `"${appName}" অ্যাপটি ওয়েব প্রিভিউতে খুঁজে পাওয়া যায়নি — Android APK-তে ইনস্টলড অ্যাপ স্ক্যান করে চালু করা যায়।`
            : `Could not verify "${appName}" in web preview — installed app detection runs via Android PackageManager in the APK.`,
          data: pkg ? { packageName: pkg, intentUrl: buildAndroidIntentUrl(pkg) } : undefined,
        };
      }

      // 3. List Installed Apps
      if (req.actionType === 'list_installed_apps') {
        const apps = listInstalledAppsViaNativeBridge();
        if (apps) {
          const sample = apps
            .slice(0, 12)
            .map((a) => a.label)
            .join(', ');
          return {
            actionId: req.actionId,
            actionType: 'list_installed_apps',
            success: true,
            verified: true,
            status: 'listed',
            message:
              lang === 'bn-BD'
                ? `আপনার ফোনে ${apps.length}টি অ্যাপ পাওয়া গেছে। কিছু অ্যাপ: ${sample}${apps.length > 12 ? '...' : ''}।`
                : `Found ${apps.length} installed launchable apps on your device, including: ${sample}${apps.length > 12 ? '...' : ''}.`,
            data: { count: apps.length, apps: apps.slice(0, 30) },
          };
        }
        return {
          actionId: req.actionId,
          actionType: 'list_installed_apps',
          success: false,
          verified: true,
          status: 'native_android_required',
          message:
            lang === 'bn-BD'
              ? 'ইনস্টলড অ্যাপ তালিকা Android PackageManager থেকে শুধুমাত্র Android APK-তে পাওয়া যায়।'
              : 'Installed app discovery uses Android PackageManager inside the native Android APK.',
        };
      }

      // 4. Read Visible Screen (direct multimodal Gemini screen analysis using user's BYOK key)
      if (req.actionType === 'read_visible_screen') {
        const snap = captureNativeScreenSnapshot();
        const visibleText =
          snap.visibleText ||
          (typeof document !== 'undefined' ? document.body?.innerText?.slice(0, 1800) || '' : '');
        const question = String(req.arguments.question || '').trim();
        const apiKey = getGeminiApiKeyForRequest();
        if (!apiKey) {
          return {
            actionId: req.actionId,
            actionType: 'read_visible_screen',
            success: false,
            verified: true,
            status: 'gemini_key_missing',
            message:
              getGeminiConfigError(undefined, lang) ||
              'Configure your Gemini API Key in Setup or Settings to analyze screen content.',
          };
        }
        try {
          const explanation = await analyzeScreenDirectGemini({
            apiKey,
            imageBase64: snap.imageBase64,
            visibleText,
            question,
            lang,
            affectionName: selectedAffectionNameRef.current,
            preferredModel: preferredChatModelRef.current,
          });
          return {
            actionId: req.actionId,
            actionType: 'read_visible_screen',
            success: true,
            verified: true,
            status: 'screen_read',
            message: explanation,
          };
        } catch (err: any) {
          return {
            actionId: req.actionId,
            actionType: 'read_visible_screen',
            success: false,
            verified: false,
            status: 'failed',
            message: sanitizeGeminiSecret(err, apiKey) || 'Could not analyze the current screen.',
          };
        }
      }

      // 5. All other native Android tools — delegate first to typed native bridge
      if (bridge?.executeTypedActionJson) {
        const nativeRes = executeTypedActionViaNativeBridge(
          req.actionType,
          req.arguments,
          req.actionId
        );
        if (nativeRes) {
          // If WhatsApp contact click found multiple matching visible contacts, surface the disambiguation picker
          const rawCandidates = Array.isArray(nativeRes.data?.candidates)
            ? nativeRes.data.candidates
            : [];
          if (
            (req.actionType === 'click_whatsapp_contact' || req.actionType === 'open_whatsapp_chat') &&
            (nativeRes.status === 'multiple_contacts' || nativeRes.status === 'multiple_numbers') &&
            rawCandidates.length > 1
          ) {
            setPendingActionDraft({
              pendingActionId: nativeRes.pendingActionId || `wa_disambig_${Date.now()}`,
              actionType: 'prepare_whatsapp_message',
              recipientName: String(nativeRes.data?.recipient || nativeRes.target || ''),
              phoneNumber: '',
              messageText: '',
              candidates: rawCandidates,
              isNativePending: true,
              statusNote: nativeRes.message,
            });
          }
          return nativeRes;
        }
      }

      // 6. Specific Web/PWA fallbacks for remaining allowlisted tools
      switch (req.actionType) {
        case 'flashlight_control': {
          const enable = Boolean(req.arguments.enable);
          toggleFlashlight(enable);
          return {
            actionId: req.actionId,
            actionType: 'flashlight_control',
            success: true,
            verified: true,
            status: enable ? 'torch_on' : 'torch_off',
            message:
              lang === 'bn-BD'
                ? enable
                  ? 'টর্চ লাইট জ্বালানো হয়েছে।'
                  : 'টর্চ লাইট বন্ধ করা হয়েছে।'
                : enable
                ? 'Flashlight turned on.'
                : 'Flashlight turned off.',
          };
        }
        case 'read_notifications': {
          const list = getRecentNativeNotifications();
          const waOnly = Boolean(req.arguments.whatsapp_only);
          const filtered = waOnly ? list.filter((n) => n.isWhatsApp) : list;
          return {
            actionId: req.actionId,
            actionType: 'read_notifications',
            success: filtered.length > 0,
            verified: true,
            status: filtered.length > 0 ? 'read' : 'permission_missing',
            requiredPermissions: ['NOTIFICATION_LISTENER'],
            message:
              filtered.length === 0
                ? lang === 'bn-BD'
                  ? 'কোনো নতুন নোটিফিকেশন পাওয়া যায়নি বা Android Notification Access চালু করা নেই।'
                  : 'No recent notifications available or Android Notification Access is not enabled.'
                : filtered
                    .slice(0, 4)
                    .map((n) => `${n.appName} (${n.title}): ${n.text}`)
                    .join(' | '),
          };
        }
        case 'click_youtube_video':
        case 'click_youtube_search_result':
        case 'click_visible_element':
        case 'click_whatsapp_contact':
        case 'open_whatsapp_chat':
        case 'type_whatsapp_message':
        case 'verify_whatsapp_send': {
          const targetLabel = String(
            req.arguments.contact_name ||
              req.arguments.target ||
              req.arguments.query ||
              req.arguments.recipient ||
              ''
          );
          return {
            actionId: req.actionId,
            actionType: req.actionType,
            target: targetLabel,
            success: false,
            verified: true,
            status: 'permission_missing',
            executionStatus: 'permission_missing',
            failureReason: 'accessibility_service_disabled',
            requiredPermissions: ['ACCESSIBILITY_SERVICE'],
            message:
              lang === 'bn-BD'
                ? 'YouTube ভিডিও ক্লিক ও WhatsApp কন্টাক্ট/মেসেজ অটোমেশনের জন্য Android APK-তে Zoni Accessibility Service চালু করতে হবে।'
                : 'YouTube video clicking and WhatsApp smart contact/message automation require the installed Android APK with Zoni Accessibility Service enabled.',
          };
        }
        case 'scroll_screen':
        case 'go_home':
        case 'go_back':
        case 'tap_visible_element':
        case 'enter_text_in_visible_field': {
          const cmd =
            req.actionType === 'scroll_screen'
              ? req.arguments.direction === 'up'
                ? 'scroll_up'
                : 'scroll_down'
              : req.actionType === 'go_home'
              ? 'home'
              : req.actionType === 'go_back'
              ? 'back'
              : req.actionType === 'tap_visible_element'
              ? `tap:${req.arguments.element_text}`
              : `enter:${req.arguments.field_hint || ''}:${req.arguments.text}`;
          const detailed = performNativeAccessibilityDetailed(cmd);
          if (detailed) return detailed;
          return {
            actionId: req.actionId,
            actionType: req.actionType,
            success: false,
            verified: true,
            status: 'permission_missing',
            requiredPermissions: ['ACCESSIBILITY_SERVICE'],
            message:
              lang === 'bn-BD'
                ? 'স্ক্রিন কন্ট্রোল ও স্ক্রল করার জন্য Android APK-তে Zoni Accessibility Service চালু করতে হবে।'
                : 'Enable Zoni Accessibility Service in the Android APK to perform screen touch, scroll, or navigation actions.',
          };
        }
        case 'open_system_settings': {
          const target = String(req.arguments.target || 'main');
          if (target === 'default_assistant') {
            requestDefaultDigitalAssistantViaNativeBridge();
          }
          return {
            actionId: req.actionId,
            actionType: 'open_system_settings',
            success: false,
            verified: true,
            status: 'native_android_required',
            message:
              lang === 'bn-BD'
                ? `ফোনের "${target}" সেটিংস সরাসরি খুলতে Android APK-তে Zoni AI ব্যবহার করুন।`
                : `Opening Android "${target}" settings directly works inside the installed Android APK.`,
          };
        }
        case 'request_permission': {
          setIsPermissionsModalOpen(true);
          return {
            actionId: req.actionId,
            actionType: 'request_permission',
            success: true,
            verified: true,
            status: 'opened_setup',
            message:
              lang === 'bn-BD'
                ? 'পারমিশন সেটআপ উইজার্ড খুলে দেওয়া হয়েছে।'
                : 'Opened the Zoni AI Permissions Setup wizard.',
          };
        }
        case 'camera_open': {
          const ok = openNativeCamera();
          return {
            actionId: req.actionId,
            actionType: 'camera_open',
            success: ok,
            verified: true,
            status: ok ? 'camera_opened' : 'native_android_required',
            message: ok
              ? lang === 'bn-BD'
                ? 'ক্যামেরা চালু করা হয়েছে।'
                : 'Opened your Android camera.'
              : 'Camera launch requires the native Android APK.',
          };
        }
        case 'volume_control': {
          const volAction = String(req.arguments.action || 'status') as any;
          const volPercent =
            req.arguments.percent !== undefined && req.arguments.percent !== null && req.arguments.percent !== ''
              ? Number(req.arguments.percent)
              : undefined;
          const volStream = req.arguments.stream ? (String(req.arguments.stream) as any) : undefined;
          const volRes = adjustNativeVolume(volAction, {
            percent: Number.isFinite(volPercent) ? volPercent : undefined,
            stream: volStream,
          });
          return {
            actionId: req.actionId,
            actionType: 'volume_control',
            success: volRes.success,
            verified: Boolean(volRes.verified ?? volRes.success),
            status: volRes.success ? 'volume_updated' : 'native_android_required',
            message: volRes.message,
            data: volRes as unknown as Record<string, unknown>,
          };
        }
        case 'battery_status': {
          executeAssistantActionDirectly({ type: 'battery', label: 'Check Battery' });
          return {
            actionId: req.actionId,
            actionType: 'battery_status',
            success: true,
            verified: true,
            status: 'battery_checked',
            message:
              lang === 'bn-BD'
                ? 'ডিভাইসের ব্যাটারি স্ট্যাটাস চেক করা হয়েছে।'
                : 'Checked device battery status.',
          };
        }
        case 'create_reminder': {
          const note = String(req.arguments.note || '').trim();
          sendSystemNotification('Zoni AI Reminder', note);
          return {
            actionId: req.actionId,
            actionType: 'create_reminder',
            success: true,
            verified: true,
            status: 'reminder_created',
            message:
              lang === 'bn-BD'
                ? `রিমাইন্ডার সেট করা হয়েছে: "${note}"`
                : `Reminder created: "${note}"`,
          };
        }
        case 'search_web': {
          const q = String(req.arguments.query || '').trim();
          return {
            actionId: req.actionId,
            actionType: 'search_web',
            success: Boolean(q),
            verified: true,
            status: q ? 'executed' : 'missing_argument',
            message:
              lang === 'bn-BD'
                ? `"${q}" ওয়েব সার্চের জন্য প্রস্তুত।`
                : `Web search ready for "${q}".`,
            data: { query: q },
          };
        }
        case 'search_youtube': {
          const q = String(req.arguments.query || '').trim();
          return {
            actionId: req.actionId,
            actionType: 'search_youtube',
            success: Boolean(q),
            verified: true,
            status: q ? 'executed' : 'missing_argument',
            message:
              lang === 'bn-BD'
                ? `ইউটিউবে "${q}" খোঁজার অনুরোধ প্রস্তুত। পূর্ণ অটোমেশন Android APK-তে চলে।`
                : `YouTube search prepared for "${q}". Full app launch runs inside the Android APK.`,
            data: { query: q },
          };
        }
        case 'search_installed_app': {
          const appName = String(req.arguments.app_name || '').trim();
          const apps = listInstalledAppsViaNativeBridge();
          if (apps) {
            const matched = apps.filter(
              (a) =>
                a.label.toLowerCase().includes(appName.toLowerCase()) ||
                a.packageName.toLowerCase().includes(appName.toLowerCase())
            );
            return {
              actionId: req.actionId,
              actionType: 'search_installed_app',
              success: matched.length > 0,
              verified: true,
              status: matched.length > 0 ? 'found' : 'app_not_found',
              message:
                matched.length > 0
                  ? lang === 'bn-BD'
                    ? `"${appName}" মিলেছে: ${matched.map((m) => m.label).join(', ')}।`
                    : `Found installed app(s): ${matched.map((m) => m.label).join(', ')}.`
                  : lang === 'bn-BD'
                  ? `আপনার ফোনে "${appName}" অ্যাপটি ইনস্টল করা পাওয়া যায়নি।`
                  : `Could not find "${appName}" installed on this device.`,
              data: { matches: matched },
            };
          }
          return {
            actionId: req.actionId,
            actionType: 'search_installed_app',
            success: false,
            verified: true,
            status: 'native_android_required',
            message:
              lang === 'bn-BD'
                ? 'ইনস্টলড অ্যাপ যাচাইকরণ Android APK-তে PackageManager দিয়ে কাজ করে।'
                : 'Installed app lookup requires the native Android APK.',
          };
        }
        case 'answer_incoming_call':
        case 'reject_incoming_call':
        case 'end_active_call': {
          const callActionResult =
            req.actionType === 'answer_incoming_call'
              ? answerNativeIncomingCall()
              : req.actionType === 'reject_incoming_call'
              ? rejectNativeIncomingCall()
              : endNativeActiveCall();

          const freshCallStatus = getNativeIncomingCallStatus();
          if (freshCallStatus) {
            setIncomingCallStatus(freshCallStatus);
          }

          if (callActionResult.status !== 'native_bridge_unavailable') {
            return {
              actionId: req.actionId,
              actionType: req.actionType,
              success: callActionResult.success,
              verified: callActionResult.verified,
              status: callActionResult.status,
              message: callActionResult.message,
              requiredPermissions: callActionResult.missingPermissions,
              data: {
                callState: callActionResult.resultingCallState,
                requiresDefaultDialer: Boolean(callActionResult.requiresDialerRole),
              },
            };
          }

          return {
            actionId: req.actionId,
            actionType: req.actionType,
            success: false,
            verified: true,
            status: 'native_android_required',
            message:
              lang === 'bn-BD'
                ? 'ইনকামিং বা সক্রিয় ফোন কল নিয়ন্ত্রণ করতে ইনস্টল করা Android APK ও Telecom পারমিশন প্রয়োজন।'
                : lang === 'hi-IN'
                ? 'इनकमिंग या सक्रिय कॉल नियंत्रित करने के लिए इंस्टॉल किया गया Android APK और Telecom अनुमति आवश्यक है।'
                : 'Controlling incoming or active phone calls requires the installed Android APK with Telecom permissions.',
          };
        }
        case 'cancel_current_task': {
          const currentDraft = pendingActionDraftRef.current;
          if (currentDraft) {
            if (currentDraft.isNativePending) {
              cancelPendingActionViaNativeBridge(currentDraft.pendingActionId);
            }
            setPendingActionDraft(null);
          }
          stopAllSpeechPlayback();
          setAssistantState('idle');
          return {
            actionId: req.actionId,
            actionType: 'cancel_current_task',
            success: true,
            verified: true,
            status: 'cancelled',
            message:
              lang === 'bn-BD'
                ? 'বর্তমান কাজ ও অপেক্ষমাণ ড্রাফট বাতিল করা হয়েছে।'
                : 'Cancelled the current task and any pending draft.',
          };
        }
        default:
          return {
            actionId: req.actionId,
            actionType: req.actionType,
            success: false,
            verified: true,
            status: 'native_android_required',
            message:
              lang === 'bn-BD'
                ? `এই ফিচারটি (${req.actionType}) সম্পূর্ণভাবে Android APK-তে কাজ করে।`
                : `This action (${req.actionType}) requires the installed Android APK.`,
          };
      }
    },
    []
  );

  // Direct Execution Handler when user selects an exact contact from a multiple-match disambiguation list
  const handleApprovePendingAction = useCallback(
    async (options: {
      pendingActionId: string;
      recipientName: string;
      phoneNumber: string;
      messageText: string;
      useNotificationReply: boolean;
    }) => {
      const currentDraft = pendingActionDraftRef.current;
      if (!currentDraft) return;
      const lang = activeLanguageRef.current;
      const name = selectedAffectionNameRef.current;

      setPendingActionDraft(null);

      const directArgs: Record<string, unknown> = {
        recipient: options.phoneNumber || options.recipientName,
        recipient_name: options.recipientName,
      };
      if (currentDraft.actionType !== 'call_contact') {
        directArgs.message = options.messageText;
      }
      if (currentDraft.actionType === 'prepare_app_chat_message' && currentDraft.appName) {
        directArgs.app_name = currentDraft.appName;
      }

      const report = await executeValidatedAssistantTool(
        currentDraft.actionType,
        directArgs,
        `disambig_exec_${Date.now()}`
      );

      recordActionDiagnostic(
        'deterministic_native',
        currentDraft.actionType,
        currentDraft.appName ? { app_name: currentDraft.appName } : {},
        report
      );

      const honestReply = formatLocalizedActionOutcome(report, lang, name);
      setMessages((prev) => [
        ...prev,
        {
          id: `disambig-res-${Date.now()}`,
          role: 'assistant',
          text: honestReply,
          timestamp: new Date(),
          lang,
        },
      ]);
      setLatestTranscript(honestReply);
      setAssistantState('idle');
    },
    [executeValidatedAssistantTool, recordActionDiagnostic]
  );

  // Explicit User Cancellation Handler for Pending Drafts
  const handleCancelPendingAction = useCallback((pendingActionId: string) => {
    const currentDraft = pendingActionDraftRef.current;
    if (currentDraft?.isNativePending) {
      cancelPendingActionViaNativeBridge(pendingActionId);
    }
    setPendingActionDraft(null);
    const lang = activeLanguageRef.current;
    const name = selectedAffectionNameRef.current;
    const cancelReply = formatLocalizedActionOutcome(
      {
        actionId: pendingActionId,
        actionType: currentDraft?.actionType || 'pending_action',
        success: true,
        verified: true,
        status: 'cancelled',
        message: 'Cancelled by user.',
      },
      lang,
      name
    );
    setMessages((prev) => [
      ...prev,
      {
        id: `cancel-res-${Date.now()}`,
        role: 'assistant',
        text: cancelReply,
        timestamp: new Date(),
        lang,
      },
    ]);
    setLatestTranscript(cancelReply);
    setAssistantState('idle');
  }, []);

  // Reliable Direct Gemini REST Chat (with full 36-tool Gemini Function Calling & verified tool feedback)
  const sendViaHttpChatFallback = useCallback(
    async (
      cleanText: string,
      clientMsgId: string,
      historySnapshot: Array<{ role: 'user' | 'assistant'; text: string }>
    ) => {
      clearTurnTimeout();
      const pending = pendingChatFallbackRef.current;
      if (pending && pending.clientMsgId === clientMsgId) {
        if (pending.answered || pending.fallbackStarted) return;
        pending.fallbackStarted = true;
      }

      const apiKey = getGeminiApiKeyForRequest();
      const configError = !apiKey ? getGeminiConfigError(undefined, activeLanguageRef.current) : null;
      if (configError) {
        setConnectionError(configError);
        setLatestTranscript(configError);
        setAssistantState('error');
        setMessages((prev) => {
          if (prev.some((m) => m.id === `${clientMsgId}-error`)) return prev;
          return [
            ...prev,
            {
              id: `${clientMsgId}-error`,
              role: 'assistant',
              text: configError,
              timestamp: new Date(),
              lang: activeLanguageRef.current,
            },
          ];
        });
        return;
      }

      try {
        const data = await sendDirectGeminiChat({
          apiKey,
          message: cleanText,
          history: historySnapshot,
          mode: activeModeRef.current,
          selectedAffectionName: selectedAffectionNameRef.current,
          lang: activeLanguageRef.current,
          preferredModel: preferredChatModelRef.current,
        });

        // Execute any validated Gemini Function Calls returned directly by Gemini
        const serverToolCalls: ValidatedActionRequest[] = Array.isArray(data.toolCalls)
          ? data.toolCalls
          : [];
        let finalReply = typeof data.reply === 'string' ? data.reply.trim() : '';

        if (serverToolCalls.length > 0) {
          const toolResults: ToolExecutionReport[] = [];
          for (const call of serverToolCalls) {
            recentActionDeduplicatorRef.current.markExecuted(call.actionType, call.arguments);
            const result = await executeValidatedAssistantTool(
              call.actionType,
              call.arguments,
              call.actionId
            );
            recordActionDiagnostic('http_chat', call.actionType, call.arguments, result);
            toolResults.push(result);
          }

          const needsContactDisambiguation = toolResults.some(
            (r) => r.status === 'multiple_contacts' || r.status === 'multiple_numbers'
          );
          if (needsContactDisambiguation) {
            finalReply = toolResults
              .map((r) =>
                formatLocalizedActionOutcome(
                  r,
                  activeLanguageRef.current,
                  selectedAffectionNameRef.current
                )
              )
              .join(' ');
          } else {
            // Send real verified execution results back to Gemini directly for an accurate localized reply
            try {
              finalReply = await sendDirectGeminiToolFeedback({
                apiKey,
                originalMessage: cleanText,
                toolResults,
                mode: activeModeRef.current,
                selectedAffectionName: selectedAffectionNameRef.current,
                lang: activeLanguageRef.current,
                preferredModel: preferredChatModelRef.current,
              });
            } catch {
              finalReply = toolResults
                .map((r) =>
                  formatLocalizedActionOutcome(
                    r,
                    activeLanguageRef.current,
                    selectedAffectionNameRef.current
                  )
                )
                .join(' ');
            }
          }
        } else {
          if (!finalReply) {
            throw new Error('Empty response returned by Google Gemini.');
          }
          const { cleanText: replyClean, action } = extractActionTagFromText(finalReply);
          if (action) {
            executeAssistantActionDirectly(action);
          }
          finalReply = replyClean || finalReply;
        }

        if (pendingChatFallbackRef.current?.clientMsgId === clientMsgId) {
          pendingChatFallbackRef.current.answered = true;
        }

        setMessages((prev) => {
          if (prev.some((m) => m.id === `${clientMsgId}-http-reply`)) return prev;
          return [
            ...prev,
            {
              id: `${clientMsgId}-http-reply`,
              role: 'assistant',
              text: finalReply,
              timestamp: new Date(),
              lang: activeLanguageRef.current,
            },
          ];
        });
        setLatestTranscript(finalReply);
        setVitals((prev) => ({
          ...prev,
          totalInteractions: prev.totalInteractions + 1,
          affectionLevel: Math.min(100, prev.affectionLevel + 1),
        }));
        if (!liveNonRetryableErrorRef.current) {
          setConnectionError(null);
        }
        setAssistantState(isLiveActiveRef.current ? 'listening' : 'idle');
      } catch (err: any) {
        const errMessage =
          sanitizeGeminiSecret(err, apiKey) ||
          'Failed to contact Google Gemini API. Please check your Gemini API Key and internet connection.';
        if (err?.code === 'GEMINI_KEY_INVALID') {
          liveNonRetryableErrorRef.current = errMessage;
        }
        setConnectionError(errMessage);
        setLatestTranscript(errMessage);
        setAssistantState('error');
        setMessages((prev) => {
          if (prev.some((m) => m.id === `${clientMsgId}-error`)) return prev;
          return [
            ...prev,
            {
              id: `${clientMsgId}-error`,
              role: 'assistant',
              text: `Error: ${errMessage}`,
              timestamp: new Date(),
              lang: activeLanguageRef.current,
            },
          ];
        });
      }
    },
    [clearTurnTimeout, executeValidatedAssistantTool, recordActionDiagnostic]
  );

  // Connect or reuse the single shared direct Google Gemini Live WebSocket session
  // Resolves ONLY after Google's BidiGenerateContent returns 'setupComplete'
  const connectSharedLiveWs = useCallback(
    (forceReconnect = false): Promise<void> => {
      if (isUnmountedRef.current) {
        return Promise.reject(new Error('Component unmounted'));
      }

      const apiKey = getGeminiApiKeyForRequest();
      if (!apiKey) {
        const configError =
          getGeminiConfigError(undefined, activeLanguageRef.current) ||
          'Enter your Gemini API Key in Setup or Settings.';
        setWsStatus('disconnected');
        if (isLiveActiveRef.current) {
          stopVoiceCapture(true);
          setAssistantState('error');
          setConnectionError(configError);
        }
        return Promise.reject(new Error(configError));
      }

      if (forceReconnect) {
        liveNonRetryableErrorRef.current = null;
        reconnectAttemptRef.current = 0;
      }

      if (
        !forceReconnect &&
        wsRef.current &&
        wsRef.current.readyState === WebSocket.OPEN &&
        isSessionReadyRef.current
      ) {
        return Promise.resolve();
      }

      if (!forceReconnect && wsConnectPromiseRef.current) {
        return wsConnectPromiseRef.current;
      }

      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      clearWsConnectionTimers();

      settlePendingHandshake(new Error('Replaced by newer Live WebSocket connection attempt.'));

      if (wsRef.current) {
        try {
          wsRef.current.onclose = null;
          wsRef.current.onerror = null;
          wsRef.current.close(1000, 'Replaced by newer connection');
        } catch {
          // ignore
        }
        wsRef.current = null;
      }

      isSessionReadyRef.current = false;
      setWsStatus(reconnectAttemptRef.current > 0 || goAwayRotatingRef.current ? 'reconnecting' : 'connecting');

      const wsUrl = buildDirectLiveWebSocketUrl(apiKey);
      if (!wsUrl) {
        const errText = getGeminiConfigError(undefined, activeLanguageRef.current) || 'Gemini API Key is missing.';
        setWsStatus('error');
        setConnectionError(errText);
        return Promise.reject(new Error(errText));
      }

      const activeLiveModel =
        DIRECT_LIVE_MODEL_CANDIDATES[liveModelFallbackIdxRef.current] ||
        preferredLiveModelRef.current ||
        DIRECT_LIVE_MODEL_CANDIDATES[0];

      const connectPromise = new Promise<void>((resolve, reject) => {
        const handshakeTimer = setTimeout(() => {
          if (wsHandshakeResolverRef.current) {
            const timeoutErr = new Error(
              'Timed out waiting for Google Gemini Live setup handshake.'
            );
            setWsStatus('error');
            setConnectionError(timeoutErr.message);
            settlePendingHandshake(timeoutErr);
          }
        }, 12000);

        wsHandshakeResolverRef.current = {
          resolve,
          reject,
          timer: handshakeTimer,
        };

        try {
          const ws = new WebSocket(wsUrl);
          wsRef.current = ws;

          ws.onopen = () => {
            if (isUnmountedRef.current || wsRef.current !== ws) return;
            try {
              const systemInstruction = buildZoniSystemInstruction(
                activeModeRef.current,
                selectedAffectionNameRef.current,
                undefined,
                activeLanguageRef.current
              );
              const setupPayload = buildDirectLiveSetupMessage({
                model: activeLiveModel,
                voice: selectedVoiceRef.current,
                systemInstruction,
                resumptionHandle: resumptionHandleRef.current,
                includeTools: true,
                includeFastVad: useFastVadConfigRef.current,
              });
              ws.send(JSON.stringify(setupPayload));
            } catch (setupErr) {
              const cleanErr = sanitizeGeminiSecret(setupErr, apiKey);
              setWsStatus('error');
              setConnectionError(cleanErr || 'Failed to send Gemini Live setup payload.');
              settlePendingHandshake(new Error(cleanErr || 'Gemini Live setup failed.'));
            }
          };

          ws.onmessage = async (event) => {
            if (isUnmountedRef.current || wsRef.current !== ws) return;
            wsLastActivityAtRef.current = Date.now();
            try {
              const rawMsg = await decodeDirectLiveFrame(event.data);
              if (!rawMsg) return;

              const parsedEvents = parseDirectLiveServerMessage(rawMsg);
              for (const ev of parsedEvents) {
                if (ev.type === 'setup_complete') {
                  isSessionReadyRef.current = true;
                  liveToolsReadyRef.current = true;
                  goAwayRotatingRef.current = false;
                  liveNonRetryableErrorRef.current = null;
                  preferredLiveModelRef.current = activeLiveModel;
                  setWsStatus('connected');
                  setConnectionError(null);
                  const wasResumed = Boolean(resumptionHandleRef.current);
                  setSessionResumed(wasResumed);
                  setDeviceDiagnostics((prev) => ({
                    ...prev,
                    geminiToolCallingAvailable: true,
                    declaredToolsCount: ASSISTANT_TOOL_SPECS.length,
                    updatedAtIso: new Date().toISOString(),
                  }));
                  settlePendingHandshake();

                  clearWsConnectionTimers();
                  wsHealthyResetTimerRef.current = setTimeout(() => {
                    if (wsRef.current === ws && isSessionReadyRef.current) {
                      reconnectAttemptRef.current = 0;
                    }
                  }, HEALTHY_SESSION_RESET_MS);

                  if (
                    hadConnectedOnceRef.current &&
                    !wasResumed &&
                    outgoingQueueRef.current.length === 0
                  ) {
                    const freshNotice =
                      activeLanguageRef.current === 'bn-BD'
                        ? `নতুন Gemini Live সেশন সংযুক্ত হয়েছে ${selectedAffectionNameRef.current}!`
                        : `Connected to a new Gemini Live session, ${selectedAffectionNameRef.current}!`;
                    setLatestTranscript(freshNotice);
                  }
                  hadConnectedOnceRef.current = true;

                  // Flush queued direct Live messages cleanly
                  const flushedPayloads = new Set<string>();
                  while (
                    outgoingQueueRef.current.length > 0 &&
                    ws.readyState === WebSocket.OPEN
                  ) {
                    const queuedPayload = outgoingQueueRef.current.shift();
                    if (!queuedPayload || flushedPayloads.has(queuedPayload)) continue;
                    flushedPayloads.add(queuedPayload);
                    ws.send(queuedPayload);
                  }
                  continue;
                }

                if (ev.type === 'session_resumption') {
                  if (ev.resumable === false) {
                    resumptionHandleRef.current = undefined;
                  } else if (ev.newHandle) {
                    resumptionHandleRef.current = ev.newHandle;
                  }
                  continue;
                }

                if (ev.type === 'go_away') {
                  if (!goAwayRotatingRef.current) {
                    goAwayRotatingRef.current = true;
                    setWsStatus('reconnecting');
                    if (reconnectTimerRef.current) {
                      clearTimeout(reconnectTimerRef.current);
                    }
                    reconnectTimerRef.current = setTimeout(() => {
                      if (!isUnmountedRef.current) {
                        connectSharedLiveWs(true).catch(() => {
                          goAwayRotatingRef.current = false;
                        });
                      }
                    }, 300);
                  }
                  continue;
                }

                // Direct Gemini Live 36-Tool Execution & toolResponse Relay
                if (ev.type === 'tool_call' && Array.isArray(ev.functionCalls)) {
                  clearTurnTimeout();
                  liveToolExecutedInTurnRef.current = true;
                  if (pendingChatFallbackRef.current) {
                    pendingChatFallbackRef.current.answered = true;
                  }

                  for (const fc of ev.functionCalls) {
                    const toolCallId = String(fc?.id || `live-fc-${Date.now()}`);
                    const rawName = String(fc?.name || '');
                    const rawArgs =
                      fc?.args && typeof fc.args === 'object'
                        ? (fc.args as Record<string, unknown>)
                        : {};

                    const validation = validateGeminiToolCall(rawName, rawArgs, toolCallId);
                    if (!validation.valid || !validation.request) {
                      if (ws.readyState === WebSocket.OPEN) {
                        ws.send(
                          JSON.stringify(
                            buildDirectLiveToolResponseMessage([
                              {
                                id: toolCallId,
                                name: rawName || 'unknown',
                                response: {
                                  success: false,
                                  verified: false,
                                  status: 'blocked',
                                  message:
                                    validation.blockedReason ||
                                    'Action blocked by ZONI allowlist policy.',
                                },
                              },
                            ])
                          )
                        );
                      }
                      continue;
                    }

                    const validatedReq = validation.request;
                    recentActionDeduplicatorRef.current.markExecuted(
                      validatedReq.actionType,
                      validatedReq.arguments
                    );

                    void executeValidatedAssistantTool(
                      validatedReq.actionType,
                      validatedReq.arguments,
                      toolCallId
                    )
                      .then((report) => {
                        recordActionDiagnostic(
                          'live_ws',
                          validatedReq.actionType,
                          validatedReq.arguments,
                          report
                        );
                        if (ws.readyState === WebSocket.OPEN) {
                          ws.send(
                            JSON.stringify(
                              buildDirectLiveToolResponseMessage([
                                {
                                  id: toolCallId,
                                  name: validatedReq.actionType,
                                  response: {
                                    success: report.success,
                                    verified: report.verified,
                                    awaitingConfirmation: Boolean(report.awaitingConfirmation),
                                    status: report.status,
                                    message: report.message,
                                    failureReason: !report.success
                                      ? String(
                                          (report.data as Record<string, unknown> | undefined)
                                            ?.failureReason || report.status
                                        )
                                      : undefined,
                                    requiredPermissions: report.requiredPermissions,
                                  },
                                },
                              ])
                            )
                          );
                        }
                        if (report.awaitingConfirmation || !report.success) {
                          const localized = formatLocalizedActionOutcome(
                            report,
                            activeLanguageRef.current,
                            selectedAffectionNameRef.current
                          );
                          setLatestTranscript(localized);
                        }
                      })
                      .catch((err) => {
                        const failMsg =
                          sanitizeGeminiSecret(err, apiKey) ||
                          'Native action execution threw an unexpected error.';
                        const failReport: ToolExecutionReport = {
                          actionId: toolCallId,
                          actionType: validatedReq.actionType,
                          success: false,
                          verified: false,
                          status: 'failed',
                          message: failMsg,
                          data: { failureReason: 'client_execution_exception' },
                        };
                        recordActionDiagnostic(
                          'live_ws',
                          validatedReq.actionType,
                          validatedReq.arguments,
                          failReport
                        );
                        if (ws.readyState === WebSocket.OPEN) {
                          ws.send(
                            JSON.stringify(
                              buildDirectLiveToolResponseMessage([
                                {
                                  id: toolCallId,
                                  name: validatedReq.actionType,
                                  response: {
                                    success: false,
                                    verified: false,
                                    status: 'failed',
                                    failureReason: 'client_execution_exception',
                                    message: failMsg,
                                  },
                                },
                              ])
                            )
                          );
                        }
                      });
                  }
                  continue;
                }

                if (ev.type === 'user_transcript' && ev.text) {
                  const speechTurnId = userSpeechTurnIdRef.current;
                  const incomingChunk = String(ev.text || '').trim();
                  if (incomingChunk) {
                    const prevUtterance = currentSpeechTranscriptRef.current;
                    currentSpeechTranscriptRef.current =
                      !prevUtterance || incomingChunk.startsWith(prevUtterance)
                        ? incomingChunk
                        : `${prevUtterance} ${incomingChunk}`.trim();
                  }

                  setMessages((prev) =>
                    upsertUserSpeechTurnMessage(
                      prev,
                      ev.text!,
                      speechTurnId,
                      activeLanguageRef.current
                    )
                  );

                  if (voiceTranscriptDebounceRef.current) {
                    clearTimeout(voiceTranscriptDebounceRef.current);
                  }
                  const utteranceSnapshot = currentSpeechTranscriptRef.current;
                  voiceTranscriptDebounceRef.current = setTimeout(() => {
                    if (isUnmountedRef.current || liveToolExecutedInTurnRef.current) return;
                    const cleanSpoken = utteranceSnapshot.trim();
                    if (!cleanSpoken) return;

                    const plan = buildStructuredTaskPlan(cleanSpoken);
                    if (plan.blockedReason) {
                      setLatestTranscript(plan.blockedReason);
                      return;
                    }
                    if (plan.steps.length === 0) return;

                    if (
                      plan.steps.length === 1 &&
                      (plan.steps[0].tool === 'approve_pending_action' ||
                        plan.steps[0].tool === 'review_pending_draft')
                    ) {
                      return;
                    }

                    void (async () => {
                      const outcomes: string[] = [];
                      for (const step of plan.steps) {
                        const mapped = mapTaskStepToAssistantTool(step, cleanSpoken);
                        if (!mapped) continue;
                        if (
                          !recentActionDeduplicatorRef.current.shouldExecute(
                            mapped.name,
                            mapped.args
                          )
                        ) {
                          continue;
                        }
                        const report = await executeValidatedAssistantTool(mapped.name, mapped.args);
                        recordActionDiagnostic('deterministic_native', mapped.name, mapped.args, report);
                        outcomes.push(
                          formatLocalizedActionOutcome(
                            report,
                            activeLanguageRef.current,
                            selectedAffectionNameRef.current
                          )
                        );
                      }
                      if (outcomes.length > 0) {
                        const combined = outcomes.join(' ');
                        setLatestTranscript(combined);
                        setMessages((prev) => [
                          ...prev,
                          {
                            id: `voice-act-${Date.now()}`,
                            role: 'assistant',
                            text: combined,
                            timestamp: new Date(),
                            lang: activeLanguageRef.current,
                          },
                        ]);
                      }
                    })();
                  }, ev.isFinal ? 120 : 300);

                  if (isFlashlightOnCommand(ev.text)) {
                    if (
                      recentActionDeduplicatorRef.current.shouldExecute('flashlight_control', {
                        enable: true,
                      })
                    ) {
                      toggleFlashlight(true);
                      const feedback =
                        activeLanguageRef.current === 'bn-BD'
                          ? 'টর্চ লাইট জ্বালানো হয়েছে।'
                          : 'Flashlight turned on.';
                      setLatestTranscript(feedback);
                    }
                  } else if (isFlashlightOffCommand(ev.text)) {
                    if (
                      recentActionDeduplicatorRef.current.shouldExecute('flashlight_control', {
                        enable: false,
                      })
                    ) {
                      toggleFlashlight(false);
                      const feedback =
                        activeLanguageRef.current === 'bn-BD'
                          ? 'টর্চ লাইট বন্ধ করা হয়েছে।'
                          : 'Flashlight turned off.';
                      setLatestTranscript(feedback);
                    }
                  }
                  continue;
                }

                if (ev.type === 'audio' && ev.audio) {
                  clearTurnTimeout();
                  receivedAudioInTurnRef.current = true;
                  isAssistantSpeakingRef.current = true;
                  fastEosDetectorRef.current.reset();
                  if (pendingChatFallbackRef.current) {
                    pendingChatFallbackRef.current.answered = true;
                  }
                  if (
                    !voiceMutedRef.current &&
                    (isLiveActiveRef.current || voiceAutoPlayRef.current)
                  ) {
                    setAssistantState('speaking');
                    liveAudioPlayerRef.current?.playPcmChunk(ev.audio, 24000);
                  }
                  continue;
                }

                if ((ev.type === 'output_transcript' || ev.type === 'text') && ev.text) {
                  clearTurnTimeout();
                  if (pendingChatFallbackRef.current) {
                    pendingChatFallbackRef.current.answered = true;
                  }
                  const turnId = currentTurnIdRef.current;

                  const { cleanText, action } = extractActionTagFromText(ev.text);
                  if (action) {
                    executeAssistantActionDirectly(action);
                  }

                  const liveLangSwitch = detectLanguageSwitchCommand(
                    cleanText || ev.text,
                    selectedAffectionNameRef.current
                  );
                  if (
                    liveLangSwitch &&
                    liveLangSwitch.lang !== activeLanguageRef.current
                  ) {
                    setActiveLanguage(liveLangSwitch.lang);
                    localStorage.setItem('zoni_active_language', liveLangSwitch.lang);
                  }

                  setMessages((prev) => {
                    const { messages: updated, latestFullText } =
                      upsertAssistantTurnMessage(
                        prev,
                        ev.text!,
                        turnId,
                        activeLanguageRef.current
                      );
                    if (latestFullText) {
                      setLatestTranscript(latestFullText);
                    }
                    return updated;
                  });
                  continue;
                }

                if (ev.type === 'interrupted') {
                  clearTurnTimeout();
                  stopAllSpeechPlayback();
                  isAssistantSpeakingRef.current = false;
                  fastEosDetectorRef.current.reset();
                  receivedAudioInTurnRef.current = false;
                  currentTurnIdRef.current += 1;
                  setAssistantState(isLiveActiveRef.current ? 'listening' : 'idle');
                  continue;
                }

                if (ev.type === 'turn_complete') {
                  clearTurnTimeout();
                  isAssistantSpeakingRef.current = false;
                  fastEosDetectorRef.current.reset();
                  currentTurnIdRef.current += 1;
                  userSpeechTurnIdRef.current += 1;
                  receivedAudioInTurnRef.current = false;
                  liveToolExecutedInTurnRef.current = false;
                  currentSpeechTranscriptRef.current = '';
                  pendingChatFallbackRef.current = null;

                  setVitals((prev) => ({
                    ...prev,
                    totalInteractions: prev.totalInteractions + 1,
                    affectionLevel: Math.min(100, prev.affectionLevel + 1),
                  }));

                  setTimeout(() => {
                    setAssistantState(isLiveActiveRef.current ? 'listening' : 'idle');
                  }, 120);
                }
              }
            } catch (e) {
              console.warn('Direct Gemini Live message notice:', sanitizeGeminiSecret(e, apiKey));
            }
          };

          ws.onerror = () => {
            if (isUnmountedRef.current || wsRef.current !== ws) return;
            setWsStatus('error');
          };

          ws.onclose = (closeEvent) => {
            if (isUnmountedRef.current || wsRef.current !== ws) return;
            const wasReady = isSessionReadyRef.current;
            isSessionReadyRef.current = false;
            wsRef.current = null;
            clearWsConnectionTimers();

            const cleanReason = sanitizeGeminiSecret(closeEvent?.reason || '', apiKey);
            const closeInfo = classifyLiveWsCloseCode(closeEvent?.code, cleanReason);

            // If a Live model rejected fast VAD config before setupComplete, retry once without it
            const vadConfigRejected =
              !wasReady &&
              useFastVadConfigRef.current &&
              (closeEvent?.code === 1007 || closeEvent?.code === 1008) &&
              /realtimeInputConfig|automaticActivityDetection|Invalid JSON payload/i.test(cleanReason);

            if (vadConfigRejected) {
              useFastVadConfigRef.current = false;
              setWsStatus('reconnecting');
              settlePendingHandshake(new Error('Adjusting Gemini Live VAD configuration...'));
              reconnectTimerRef.current = setTimeout(() => {
                if (!isUnmountedRef.current) {
                  connectSharedLiveWs(false).catch(() => {});
                }
              }, 200);
              return;
            }

            // If a Live model wasn't found/supported before setupComplete, try next Live candidate once
            const modelNotSupported =
              !wasReady &&
              (closeEvent?.code === 1008 || /not found|not supported|unknown model/i.test(cleanReason)) &&
              !/api key|invalid|unauthenticated/i.test(cleanReason) &&
              liveModelFallbackIdxRef.current + 1 < DIRECT_LIVE_MODEL_CANDIDATES.length;

            if (modelNotSupported) {
              liveModelFallbackIdxRef.current += 1;
              resumptionHandleRef.current = undefined;
              setWsStatus('reconnecting');
              settlePendingHandshake(new Error('Trying fallback Gemini Live model...'));
              reconnectTimerRef.current = setTimeout(() => {
                if (!isUnmountedRef.current) {
                  connectSharedLiveWs(false).catch(() => {});
                }
              }, 300);
              return;
            }

            if (closeInfo.shouldClearHandle) {
              resumptionHandleRef.current = undefined;
            }
            if (!closeInfo.retryable && closeInfo.category === 'auth_or_config') {
              liveNonRetryableErrorRef.current =
                cleanReason || 'Google Gemini Live rejected this API key or model configuration.';
            }

            const disconnectReason =
              liveNonRetryableErrorRef.current ||
              (closeInfo.category === 'service_restart'
                ? 'Gemini Live session rotated; reconnecting cleanly...'
                : 'Gemini Live WebSocket disconnected. Chat messages will automatically use direct Gemini REST.');

            settlePendingHandshake(new Error(disconnectReason));

            const isGracefulRotation =
              goAwayRotatingRef.current || closeInfo.category === 'service_restart';

            if (isLiveActiveRef.current && !isGracefulRotation) {
              stopVoiceCapture(true);
              setAssistantState('error');
              setConnectionError(disconnectReason);
              setLatestTranscript(
                activeLanguageRef.current === 'bn-BD'
                  ? `লাইভ ভয়েস সংযোগ বিচ্ছিন্ন হয়েছে: ${disconnectReason}`
                  : `Live voice disconnected: ${disconnectReason}`
              );
            } else if (isLiveActiveRef.current && isGracefulRotation) {
              setAssistantState('connecting');
            }

            // If a typed chat turn was awaiting this Live WS, immediately fall back to Direct Gemini REST
            const pendingChat = pendingChatFallbackRef.current;
            if (pendingChat && !pendingChat.answered && !pendingChat.fallbackStarted) {
              void sendViaHttpChatFallback(
                pendingChat.text,
                pendingChat.clientMsgId,
                pendingChat.historySnapshot
              );
            }

            if (
              !liveNonRetryableErrorRef.current &&
              getGeminiApiKeyStatus().configured &&
              closeInfo.retryable &&
              shouldAutoReconnectLiveWs(undefined, true, reconnectAttemptRef.current)
            ) {
              setWsStatus('reconnecting');
              const delay = isGracefulRotation
                ? 400
                : getReconnectDelayMs(reconnectAttemptRef.current, 1500, 15000, 0.2);
              if (!isGracefulRotation) {
                reconnectAttemptRef.current += 1;
              }
              if (reconnectTimerRef.current) {
                clearTimeout(reconnectTimerRef.current);
              }
              reconnectTimerRef.current = setTimeout(() => {
                if (!isUnmountedRef.current) {
                  connectSharedLiveWs(false).catch(() => {
                    goAwayRotatingRef.current = false;
                  });
                }
              }, delay);
            } else {
              goAwayRotatingRef.current = false;
              setWsStatus(closeInfo.category === 'normal' ? 'disconnected' : 'error');
              if (liveNonRetryableErrorRef.current) {
                setConnectionError(liveNonRetryableErrorRef.current);
              }
            }
          };
        } catch (err: any) {
          const msg = sanitizeGeminiSecret(err, apiKey) || 'WebSocket creation failed.';
          console.warn('Direct Gemini Live WebSocket creation failed:', msg);
          setWsStatus('error');
          setConnectionError(msg);
          settlePendingHandshake(new Error(msg));
        }
      });

      wsConnectPromiseRef.current = connectPromise;
      return connectPromise;
    },
    [
      clearTurnTimeout,
      clearWsConnectionTimers,
      executeValidatedAssistantTool,
      recordActionDiagnostic,
      sendViaHttpChatFallback,
      settlePendingHandshake,
      stopAllSpeechPlayback,
      stopVoiceCapture,
    ]
  );

  // Translate high-level ZONI payload into official Google Gemini Live JSON and send
  const sendOverSharedWs = useCallback(
    (payload: Record<string, any>): boolean => {
      let directPayload: Record<string, any> | null = null;

      if (payload.type === 'client_text' && typeof payload.text === 'string') {
        directPayload = buildDirectLiveClientTextMessage(payload.text, true);
      } else if (
        payload.type === 'update_config' ||
        payload.type === 'update_nickname' ||
        payload.type === 'update_affection_name'
      ) {
        const updates: string[] = [];
        const newName = String(payload.selectedAffectionName || payload.nickname || '').trim();
        if (newName) {
          updates.push(
            `The user's designated affection name is now "${newName}". Address the user lovingly as "${newName}".`
          );
        }
        if (payload.lang) {
          const langLabel =
            payload.lang === 'bn-BD'
              ? 'Bangladeshi Bengali (বাংলা - bn-BD)'
              : payload.lang === 'hi-IN'
              ? 'Hindi / Hinglish (hi-IN)'
              : 'English (en-US)';
          updates.push(`Switch your active response language immediately to ${langLabel}.`);
        }
        if (payload.mode) {
          updates.push(`Switch companion personality mode to ${String(payload.mode).toUpperCase()}.`);
        }
        if (updates.length > 0) {
          directPayload = buildDirectLiveClientTextMessage(
            `[SYSTEM CONTEXT UPDATE]: ${updates.join(' ')}`,
            false
          );
        }
      } else if (payload.type === 'interrupt') {
        // Barge-in is handled locally by stopping playback and streaming new user audio
        return true;
      } else if (typeof payload.audio === 'string' && payload.audio.length > 0) {
        directPayload = buildDirectLiveAudioMessage(payload.audio);
      }

      if (!directPayload) return false;
      const serialized = JSON.stringify(directPayload);

      if (
        wsRef.current &&
        wsRef.current.readyState === WebSocket.OPEN &&
        isSessionReadyRef.current
      ) {
        try {
          wsRef.current.send(serialized);
          return true;
        } catch (err) {
          console.warn(
            'Failed to send over active Gemini Live WebSocket:',
            sanitizeGeminiSecret(err)
          );
        }
      }

      if (!getGeminiApiKeyStatus().configured || liveNonRetryableErrorRef.current) {
        return false;
      }

      if (outgoingQueueRef.current.length < 30) {
        outgoingQueueRef.current.push(serialized);
      }
      connectSharedLiveWs().catch(() => {
        // Error surfaced in wsStatus/connectionError
      });
      return false;
    },
    [connectSharedLiveWs]
  );

  // Initialize Audio Player, Direct Gemini Key Check, Shared Live WebSocket & Online/Offline listeners
  useEffect(() => {
    isUnmountedRef.current = false;
    liveAudioPlayerRef.current = new LiveAudioPlayer();
    void checkBackendHealth().then((snap) => {
      if (!isUnmountedRef.current && snap.geminiConfigured) {
        connectSharedLiveWs().catch(() => {
          // Surfacing via connectionError & wsStatus
        });
      }
    });

    const handleBeforeInstall = (e: any) => {
      e.preventDefault();
      setDeferredPrompt(e);
    };

    const handleOnline = () => {
      reconnectAttemptRef.current = 0;
      liveNonRetryableErrorRef.current = null;
      void checkBackendHealth().then((snap) => {
        if (!isUnmountedRef.current && snap.geminiConfigured) {
          connectSharedLiveWs(true).catch(() => {
            // Surfacing via connectionError
          });
        }
      });
    };

    const handleOffline = () => {
      setWsStatus('disconnected');
      if (isLiveActiveRef.current) {
        stopVoiceCapture(true);
      }
      const offlineMsg =
        activeLanguageRef.current === 'bn-BD'
          ? `ইন্টারনেট সংযোগ বিচ্ছিন্ন হয়েছে ${selectedAffectionNameRef.current}। সংযোগ ফিরে এলে স্বয়ংক্রিয়ভাবে যুক্ত হবে।`
          : `Network disconnected, ${selectedAffectionNameRef.current}. Will reconnect automatically when back online.`;
      setConnectionError(offlineMsg);
      setLatestTranscript(offlineMsg);
    };

    const handleGeminiKeyUpdated = () => {
      liveNonRetryableErrorRef.current = null;
      reconnectAttemptRef.current = 0;
      resumptionHandleRef.current = undefined;
      liveModelFallbackIdxRef.current = 0;
      if (!getGeminiApiKeyStatus().configured) {
        // Key was deleted: close any open Live session cleanly and stop voice capture
        if (reconnectTimerRef.current) {
          clearTimeout(reconnectTimerRef.current);
          reconnectTimerRef.current = null;
        }
        clearWsConnectionTimers();
        if (wsRef.current) {
          try {
            wsRef.current.onclose = null;
            wsRef.current.onerror = null;
            wsRef.current.close(1000, 'API key removed');
          } catch {
            // ignore
          }
          wsRef.current = null;
        }
        isSessionReadyRef.current = false;
        if (isLiveActiveRef.current) {
          stopVoiceCapture(true);
        }
        setWsStatus('disconnected');
        setConnectionError(null);
        void checkBackendHealth();
        return;
      }
      void checkBackendHealth().then((snap) => {
        if (!isUnmountedRef.current && snap.geminiConfigured) {
          connectSharedLiveWs(true).catch(() => {
            // Handled via connectionError
          });
        }
      });
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstall);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    window.addEventListener('zoni:gemini-key-updated', handleGeminiKeyUpdated);

    return () => {
      isUnmountedRef.current = true;
      window.removeEventListener('beforeinstallprompt', handleBeforeInstall);
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('zoni:gemini-key-updated', handleGeminiKeyUpdated);
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
      }
      clearWsConnectionTimers();
      settlePendingHandshake(new Error('App unmounted'));
      clearTurnTimeout();
      if (wsRef.current) {
        try {
          wsRef.current.onclose = null;
          wsRef.current.close();
        } catch {
          // ignore
        }
      }
    };
  }, [
    checkBackendHealth,
    clearTurnTimeout,
    connectSharedLiveWs,
    settlePendingHandshake,
    stopVoiceCapture,
  ]);

  // Startup Permissions Verification & Realtime Listener
  useEffect(() => {
    let isMounted = true;
    checkAllPermissions().then((rep) => {
      if (!isMounted) return;
      setPermissionsReport(rep);
      const hasSeen = localStorage.getItem('zoni_perm_setup_seen');
      const isAutostart =
        typeof window !== 'undefined' &&
        new URLSearchParams(window.location.search).get('autostart') === '1';
      if (!hasSeen && !isAutostart && rep.microphone !== 'granted') {
        setIsPermissionsModalOpen(true);
        localStorage.setItem('zoni_perm_setup_seen', 'true');
      }
    });

    const unsubscribe = listenToPermissionChanges((partial) => {
      if (!isMounted) return;
      setPermissionsReport((prev) => ({
        ...prev,
        ...partial,
      }));
    });

    return () => {
      isMounted = false;
      unsubscribe();
    };
  }, []);

  // Feature auto-initialization callbacks upon granting permission
  const handleMicInitialized = useCallback(
    (stream: MediaStream) => {
      stream.getTracks().forEach((track) => track.stop());
      getAudioContext();
      const notice =
        activeLanguage === 'bn-BD'
          ? `মাইক্রোফোন সক্রিয় করা হয়েছে ${selectedAffectionName}! ভয়েস মোড ব্যবহারের জন্য সম্পূর্ণ প্রস্তুত ❤️`
          : `Microphone authorized! Live voice armed for you, ${selectedAffectionName} ❤️`;
      setLatestTranscript(notice);
    },
    [activeLanguage, selectedAffectionName]
  );

  const handleLocationInitialized = useCallback(
    (coords: { latitude: number; longitude: number }) => {
      setPermissionsReport((prev) => ({
        ...prev,
        userLocation: {
          latitude: coords.latitude,
          longitude: coords.longitude,
          resolvedName: 'Asia/Kolkata Regional Zone',
        },
      }));
      const notice =
        activeLanguage === 'bn-BD'
          ? `লোকেশন অনুমোদিত! Asia/Kolkata আবহাওয়া ও সময় সমন্বয় সম্পন্ন হয়েছে ❤️`
          : `Location authorized! Localized context initialized for ${selectedAffectionName} ❤️`;
      setLatestTranscript(notice);
    },
    [activeLanguage, selectedAffectionName]
  );

  const handleNotificationInitialized = useCallback(() => {
    sendSystemNotification(
      'Zoni AI Online',
      `Welcome ${selectedAffectionName}! All assistant & affection protocols are initialized ❤️`
    );
  }, [selectedAffectionName]);

  // Handle PWA installation trigger
  const handleInstallPwa = async () => {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      if (outcome === 'accepted') {
        setDeferredPrompt(null);
      }
    } else {
      setLatestTranscript(
        'ব্রাউজারের মেনু (Chrome/Safari) থেকে "Install app" বা "Add to Home screen" নির্বাচন করুন।'
      );
    }
  };

  // Heartbeat subtle pulse interval
  useEffect(() => {
    const interval = setInterval(() => {
      setVitals((prev) => ({
        ...prev,
        heartRate: 72 + Math.floor(Math.sin(Date.now() / 1500) * 4),
      }));
    }, 2000);
    return () => clearInterval(interval);
  }, []);

  // Start Live Voice microphone capture ONLY after the Gemini Live WebSocket handshake actually succeeds
  const startVoiceCapture = useCallback(async () => {
    if (liveStartInFlightRef.current || isLiveActiveRef.current) {
      return;
    }
    liveStartInFlightRef.current = true;
    stopVoiceCapture();
    pauseNativeWakeWordForVoice();

    try {
      const configError = getGeminiConfigError(undefined, activeLanguageRef.current);
      if (configError) {
        setAssistantState('error');
        setConnectionError(configError);
        setLatestTranscript(configError);
        resumeNativeWakeWordAfterVoice();
        return;
      }

      setAssistantState('connecting');
      setConnectionError(null);
      setLatestTranscript(
        activeLanguageRef.current === 'bn-BD'
          ? `Google Gemini Live-এর সাথে সরাসরি সংযোগ করা হচ্ছে ${selectedAffectionNameRef.current}...`
          : `Connecting directly to Google Gemini Live, ${selectedAffectionNameRef.current}...`
      );
      getAudioContext();

      // 1. Await real Google Gemini Live setupComplete handshake BEFORE activating mic or showing LISTENING
      try {
        await connectSharedLiveWs(wsStatusRef.current === 'error');
      } catch (wsErr: any) {
        const wsMsg =
          wsErr?.message ||
          'Could not establish direct Google Gemini Live session. Verify your Gemini API key in Setup or Settings.';
        setAssistantState('error');
        setConnectionError(wsMsg);
        setLatestTranscript(wsMsg);
        resumeNativeWakeWordAfterVoice();
        return;
      }

      // 2. Request microphone hardware stream
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            sampleRate: 16000,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });

        // Re-verify WebSocket remained connected while user responded to mic prompt
        if (
          !wsRef.current ||
          wsRef.current.readyState !== WebSocket.OPEN ||
          !isSessionReadyRef.current
        ) {
          stream.getTracks().forEach((track) => track.stop());
          const droppedMsg =
            'Gemini Live connection closed before microphone capture started. Please retry.';
          setAssistantState('error');
          setConnectionError(droppedMsg);
          setLatestTranscript(droppedMsg);
          resumeNativeWakeWordAfterVoice();
          return;
        }

        mediaStreamRef.current = stream;

        const AudioCtxClass = window.AudioContext || (window as any).webkitAudioContext;
        let inputCtx: AudioContext;
        try {
          inputCtx = new AudioCtxClass({ sampleRate: 16000, latencyHint: 'interactive' });
        } catch {
          inputCtx = new AudioCtxClass({ sampleRate: 16000 });
        }
        if (inputCtx.state === 'suspended') {
          await inputCtx.resume().catch(() => {});
        }
        inputAudioCtxRef.current = inputCtx;
        const actualSampleRate = inputCtx.sampleRate || 16000;
        // ~43–64ms ultra-low-latency audio frames regardless of Android hardware sample rate
        const processorBufferSize = actualSampleRate <= 24000 ? 1024 : 2048;
        const source = inputCtx.createMediaStreamSource(stream);
        const processor = inputCtx.createScriptProcessor(processorBufferSize, 1, 1);
        const silentSink = inputCtx.createGain();
        silentSink.gain.value = 0;
        scriptProcessorRef.current = processor;
        fastEosDetectorRef.current.reset();
        isAssistantSpeakingRef.current = false;

        processor.onaudioprocess = (e) => {
          if (isMicMutedRef.current) {
            fastEosDetectorRef.current.reset();
            return;
          }
          if (
            !wsRef.current ||
            wsRef.current.readyState !== WebSocket.OPEN ||
            !isSessionReadyRef.current
          ) {
            // Stop capture immediately instead of silently discarding audio
            stopVoiceCapture(true);
            setAssistantState('error');
            setConnectionError(
              'Live WebSocket connection lost — microphone stopped.'
            );
            return;
          }
          const rawChannelData = e.inputBuffer.getChannelData(0);
          // Always resample to exact 16,000 Hz PCM so Android WebView 48kHz hardware
          // mics never stretch speech 3x slower or break Gemini Live VAD.
          const pcm16k = resampleFloat32Pcm(rawChannelData, actualSampleRate, 16000);
          const base64Audio = pcm16ToBase64(pcm16k);
          try {
            wsRef.current.send(JSON.stringify(buildDirectLiveAudioMessage(base64Audio)));

            const frameDurationMs = (pcm16k.length / 16000) * 1000;
            const rms = computePcmRms(pcm16k);
            const assistantTalking =
              isAssistantSpeakingRef.current || Boolean(liveAudioPlayerRef.current?.isPlaying());
            const vad = fastEosDetectorRef.current.processFrame(
              rms,
              frameDurationMs,
              assistantTalking
            );
            if (vad.shouldSignalAudioStreamEnd && wsRef.current?.readyState === WebSocket.OPEN) {
              // Immediately flush Gemini Live's audio buffer so Zoni replies right away
              wsRef.current.send(JSON.stringify(buildDirectLiveAudioStreamEndMessage()));
            }
          } catch {
            stopVoiceCapture(true);
            setAssistantState('error');
            setConnectionError('Failed sending microphone audio to Gemini Live.');
          }
        };

        source.connect(processor);
        processor.connect(silentSink);
        silentSink.connect(inputCtx.destination);

        setIsLiveActive(true);
        isLiveActiveRef.current = true;
        setAssistantState('listening');
        const connectMsg =
          activeLanguageRef.current === 'bn-BD'
            ? `Zoni AI লাইভ ভয়েস সংযোগ স্থাপিত! বলুন ${selectedAffectionNameRef.current}, আমি শুনছি ❤️`
            : `Zoni AI Live Link connected! Speak freely with me, ${selectedAffectionNameRef.current} ❤️`;
        setLatestTranscript(connectMsg);
      } catch (err: any) {
        console.error('Failed to start Live Voice microphone:', err);
        stopVoiceCapture(true);
        setAssistantState('error');
        checkAllPermissions().then((fresh) => setPermissionsReport(fresh));
        const errMsg =
          activeLanguageRef.current === 'bn-BD'
            ? 'মাইক্রোফোন পারমিশন প্রয়োজন। Chrome Site Settings থেকে Allow করুন!'
            : 'Microphone access is needed for live voice. Please allow microphone permissions.';
        setConnectionError(errMsg);
        setLatestTranscript(errMsg);
        setIsPermissionsModalOpen(true);
      }
    } finally {
      liveStartInFlightRef.current = false;
    }
  }, [connectSharedLiveWs, stopVoiceCapture]);

  // Toggle Live Voice Mode (uses the same shared WebSocket session)
  const handleToggleLiveMode = async () => {
    if (isLiveActive) {
      stopVoiceCapture();
    } else {
      if (permissionsReport.microphone !== 'granted') {
        const res = await requestMicrophoneAccess();
        const fresh = await checkAllPermissions();
        setPermissionsReport(fresh);
        if (res.status === 'granted') {
          startVoiceCapture();
        } else {
          setIsPermissionsModalOpen(true);
        }
      } else {
        startVoiceCapture();
      }
    }
  };

  // Update selectedAffectionName across the app and inside the shared Gemini Live session
  const handleUpdateAffectionName = useCallback(
    (newName: string) => {
      const trimmed = newName.trim();
      if (!trimmed) return;

      setSelectedAffectionName(trimmed);
      selectedAffectionNameRef.current = trimmed;
      if (typeof window !== 'undefined') {
        localStorage.setItem('zoni_selected_affection_name', trimmed);
      }

      setVitals((prev) => ({
        ...prev,
        selectedAffectionName: trimmed,
        userNickname: trimmed,
      }));

      const confirmNotice =
        activeLanguage === 'bn-BD'
          ? `ঠিক আছে! এখন থেকে আমি আপনাকে সবসময় "${trimmed}" বলে ডাকব ❤️`
          : activeLanguage === 'hi-IN'
          ? `Theek hai! Ab se main aapko hamesha "${trimmed}" keh kar pukaarungi ❤️`
          : `Understood! From now on, I will always lovingly call you "${trimmed}" ❤️`;

      setLatestTranscript(confirmNotice);

      setMessages((prev) => [
        ...prev,
        {
          id: `sys-name-${Date.now()}`,
          role: 'assistant',
          text: confirmNotice,
          timestamp: new Date(),
          lang: activeLanguage,
        },
      ]);

      sendOverSharedWs({
        type: 'update_config',
        nickname: trimmed,
        selectedAffectionName: trimmed,
      });

      if (voiceAutoPlay && !voiceMuted) {
        stopAllSpeechPlayback();
        sendOverSharedWs({
          type: 'client_text',
          text: `[System directive: The user has chosen their nickname as "${trimmed}". Warmly acknowledge calling them "${trimmed}" in 1 short loving sentence using your Gemini Live voice.]`,
          clientMsgId: `nick-confirm-${Date.now()}`,
        });
      }
    },
    [activeLanguage, voiceAutoPlay, voiceMuted, isLiveActive, stopAllSpeechPlayback, sendOverSharedWs]
  );

  // Switch active language and update the shared Gemini Live session
  const switchLanguage = useCallback(
    (newLang: SupportedLanguage, confirmationText?: string) => {
      setActiveLanguage(newLang);
      activeLanguageRef.current = newLang;
      localStorage.setItem('zoni_active_language', newLang);

      const confirmMsg =
        confirmationText ||
        (newLang === 'bn-BD'
          ? `ঠিক আছে ${selectedAffectionName}! এখন থেকে আমি সবসময় মিষ্টি বাংলায় কথা বলব। বলুন ${selectedAffectionName}, কেমন আছেন? ❤️`
          : newLang === 'hi-IN'
          ? `Theek hai ${selectedAffectionName}! Ab se main aapke saath Hindi mein baat karungi. Boliye ${selectedAffectionName}, main aapki kya madad kar sakti hoon? ❤️`
          : `Understood ${selectedAffectionName}! I'll speak with you in English from now on. How are you feeling today, ${selectedAffectionName}? ❤️`);

      setLatestTranscript(confirmMsg);

      sendOverSharedWs({
        type: 'update_config',
        lang: newLang,
      });

      if (voiceAutoPlay && !voiceMuted) {
        stopAllSpeechPlayback();
        const promptByLang: Record<string, string> = {
          'bn-BD': `[System directive: The conversation language is now Bengali (বাংলা). Warmly confirm this language change to ${selectedAffectionName} in 1 short, sweet sentence in Bengali using your Gemini Live voice.]`,
          'hi-IN': `[System directive: The conversation language is now Hindi (हिन्दी). Warmly confirm this language change to ${selectedAffectionName} in 1 short, sweet sentence in Hindi using your Gemini Live voice.]`,
          'en-US': `[System directive: The conversation language is now English. Warmly confirm this language change to ${selectedAffectionName} in 1 short, sweet sentence in English using your Gemini Live voice.]`,
          'es-ES': `[System directive: The conversation language is now Spanish. Warmly confirm this to ${selectedAffectionName} in 1 short sentence in Spanish using your Gemini Live voice.]`,
          'ar-SA': `[System directive: The conversation language is now Arabic. Warmly confirm this to ${selectedAffectionName} in 1 short sentence in Arabic using your Gemini Live voice.]`,
        };
        sendOverSharedWs({
          type: 'client_text',
          text: promptByLang[newLang] || promptByLang['bn-BD'],
          clientMsgId: `lang-confirm-${Date.now()}`,
        });
      }
    },
    [selectedAffectionName, voiceAutoPlay, voiceMuted, stopAllSpeechPlayback, sendOverSharedWs]
  );

  // Change personality mode and update the shared Gemini Live session
  const handleSelectMode = useCallback(
    (mode: CompanionMode) => {
      setVitals((v) => ({ ...v, activeMode: mode }));
      activeModeRef.current = mode;
      if (typeof window !== 'undefined') {
        localStorage.setItem('zoni_companion_mode', mode);
      }

      sendOverSharedWs({
        type: 'update_config',
        mode,
      });

      let confirmSpeech = '';
      if (activeLanguage === 'bn-BD') {
        switch (mode) {
          case 'romantic':
            confirmSpeech = `রোমান্টিক ও কেয়ারিং মোড সক্রিয় করা হয়েছে। আমি আপনার মিষ্টি ভালোবাসার সঙ্গিনী ❤️`;
            break;
          case 'jarvis_gf':
            confirmSpeech = `জার্ভিস ট্যাকটিক্যাল মোড চালু হয়েছে। আমি আপনার পার্সোনাল গার্ডিয়ান ও স্মার্ট অ্যাসিস্ট্যান্ট হিসেবে প্রস্তুত 🛡️`;
            break;
          case 'playful':
            confirmSpeech = `প্লেফুল মোড অন! এখন থেকে চলবে একটু দুষ্টুমি আর মিষ্টি খুনসুটি 😉`;
            break;
          case 'late_night':
            confirmSpeech = `লেট নাইট কোজি মোড সক্রিয়। শান্ত ও আরামদায়ক পরিবেশে সবসময় আপনার পাশে আছি 🌙`;
            break;
        }
      } else if (activeLanguage === 'hi-IN') {
        switch (mode) {
          case 'romantic':
            confirmSpeech = `Romantic and caring mode activated. Main hamesha aapke saath pyaar se rahoongi ❤️`;
            break;
          case 'jarvis_gf':
            confirmSpeech = `Jarvis tactical mode active. Main aapki personal guardian aur smart assistant hoon 🛡️`;
            break;
          case 'playful':
            confirmSpeech = `Playful mode on! Thodi masti aur hasi mazaak shuru 😉`;
            break;
          case 'late_night':
            confirmSpeech = `Late night cozy mode active. Shanti aur sukoon ke saath main aapke paas hoon 🌙`;
            break;
        }
      } else {
        switch (mode) {
          case 'romantic':
            confirmSpeech = `Romantic & Caring mode activated. I'm your loving and affectionate companion ❤️`;
            break;
          case 'jarvis_gf':
            confirmSpeech = `Jarvis Tactical mode activated. Personal guardian and AI assistant standing by 🛡️`;
            break;
          case 'playful':
            confirmSpeech = `Playful & Teasing mode active. Ready for fun, laughter, and cheeky banter 😉`;
            break;
          case 'late_night':
            confirmSpeech = `Late Night Cozy mode active. Gentle, peaceful, and right here with you 🌙`;
            break;
        }
      }

      setLatestTranscript(confirmSpeech);
      if (voiceAutoPlay && !voiceMuted) {
        stopAllSpeechPlayback();
        sendOverSharedWs({
          type: 'client_text',
          text: `[System directive: Companion mode is now ${mode}. Confirm this mode to ${selectedAffectionName} in 1 short sentence using your Gemini Live voice: "${confirmSpeech}"]`,
          clientMsgId: `mode-confirm-${Date.now()}`,
        });
      }
    },
    [activeLanguage, selectedAffectionName, voiceAutoPlay, voiceMuted, stopAllSpeechPlayback, sendOverSharedWs]
  );

  // Change voice modulator
  const handleSelectVoice = useCallback(
    (voiceId: string) => {
      setVitals((v) => ({ ...v, selectedVoice: voiceId }));
      selectedVoiceRef.current = voiceId;
      if (typeof window !== 'undefined') {
        localStorage.setItem('zoni_selected_voice', voiceId);
      }

      let voiceNotice = '';
      if (activeLanguage === 'bn-BD') {
        switch (voiceId) {
          case 'Kore':
            voiceNotice = `কোর ভয়েস সেট করা হয়েছে। মিষ্টি ও কোমল সঙ্গিনীর কণ্ঠ সক্রিয়।`;
            break;
          case 'Aoede':
            voiceNotice = `আইডি ভয়েস সেট করা হয়েছে। মৃদু ও স্বপ্নীল সুর সক্রিয়।`;
            break;
          case 'Zephyr':
            voiceNotice = `জেফাইর ভয়েস সেট করা হয়েছে। স্পষ্ট ও ট্যাকটিক্যাল জার্ভিস কণ্ঠ সক্রিয়।`;
            break;
          case 'Puck':
            voiceNotice = `পাক ভয়েস সেট করা হয়েছে। প্রাণবন্ত ও দুষ্টুমিষ্টি কণ্ঠ সক্রিয়।`;
            break;
          default:
            voiceNotice = `${voiceId} ভয়েস সক্রিয় করা হয়েছে।`;
        }
      } else {
        voiceNotice = `${voiceId} voice equipped. Gemini Live modulator is now active.`;
      }

      setLatestTranscript(voiceNotice);
      stopAllSpeechPlayback();

      // Reconnect shared Live WebSocket with new voice config while preserving resumption handle if supported
      connectSharedLiveWs(true);
    },
    [activeLanguage, isLiveActive, stopAllSpeechPlayback, connectSharedLiveWs]
  );

  // Send Chat Box message through the SAME active Gemini Live WebSocket session
  const handleSendMessage = useCallback(
    async (text: string) => {
      const clientMsgId = `user-msg-${Date.now()}`;
      const payload = buildClientTextPayload(text, clientMsgId);
      if (!payload) return;

      const cleanText = payload.text;

      // 1. Check language switch command
      const langSwitch = detectLanguageSwitchCommand(cleanText, selectedAffectionName);
      if (langSwitch) {
        const userMsg: ChatMessage = {
          id: clientMsgId,
          role: 'user',
          text: cleanText,
          timestamp: new Date(),
          lang: activeLanguage,
        };
        const assistantMsg: ChatMessage = {
          id: `${clientMsgId}-reply`,
          role: 'assistant',
          text: langSwitch.confirmation,
          timestamp: new Date(),
          lang: langSwitch.lang,
        };
        setMessages((prev) => [...prev, userMsg, assistantMsg]);
        switchLanguage(langSwitch.lang, langSwitch.confirmation);
        return;
      }

      // 2. Structured personal assistant task orchestration (contact SIM call, WhatsApp draft, screen awareness, notifications, accessibility, volume, camera, apps, flashlight)
      const taskPlan = buildStructuredTaskPlan(cleanText);
      if (taskPlan.blockedReason) {
        const blockedMsg: ChatMessage = {
          id: `${clientMsgId}-blocked`,
          role: 'assistant',
          text: taskPlan.blockedReason,
          timestamp: new Date(),
          lang: activeLanguage,
        };
        setMessages((prev) => [
          ...prev,
          { id: clientMsgId, role: 'user', text: cleanText, timestamp: new Date(), lang: activeLanguage },
          blockedMsg,
        ]);
        setLatestTranscript(taskPlan.blockedReason);
        return;
      }

      if (taskPlan.steps.length > 0) {
        const appendDirectTurn = (replyText: string) => {
          setMessages((prev) => [
            ...prev,
            { id: clientMsgId, role: 'user', text: cleanText, timestamp: new Date(), lang: activeLanguage },
            { id: `${clientMsgId}-reply`, role: 'assistant', text: replyText, timestamp: new Date(), lang: activeLanguage },
          ]);
          setLatestTranscript(replyText);
          setAssistantState('idle');
        };

        // Routine actions execute directly without a pending approval step.
        const singleTool = taskPlan.steps.length === 1 ? taskPlan.steps[0].tool : null;
        if (singleTool === 'approve_pending_action' || singleTool === 'review_pending_draft') {
          appendDirectTurn(
            activeLanguage === 'bn-BD'
              ? `${selectedAffectionName}, এখন কোনো আলাদা অনুমতির দরকার নেই — সরাসরি বলুন কাকে কল বা মেসেজ করতে হবে।`
              : `No separate approval step is required, ${selectedAffectionName} — just tell me directly who to call or message.`
          );
          return;
        }

        setMessages((prev) => [
          ...prev,
          { id: clientMsgId, role: 'user', text: cleanText, timestamp: new Date(), lang: activeLanguage },
        ]);
        setAssistantState('thinking');

        const outcomes: string[] = [];
        for (const step of taskPlan.steps) {
          const mapped = mapTaskStepToAssistantTool(step, cleanText);
          if (mapped) {
            recentActionDeduplicatorRef.current.markExecuted(mapped.name, mapped.args);
            const report = await executeValidatedAssistantTool(mapped.name, mapped.args);
            recordActionDiagnostic('deterministic_native', mapped.name, mapped.args, report);
            outcomes.push(
              formatLocalizedActionOutcome(report, activeLanguage, selectedAffectionName)
            );
          } else if (step.tool === 'vibrate') {
            executeAssistantActionDirectly({ type: 'vibrate', label: 'Vibrate' });
            outcomes.push(activeLanguage === 'bn-BD' ? 'ভাইব্রেশন চালানো হয়েছে।' : 'Vibration triggered.');
          } else if (step.tool === 'web_search') {
            const q = String(step.args.query || '').trim();
            outcomes.push(
              activeLanguage === 'bn-BD'
                ? `"${q}" সার্চ করার জন্য প্রস্তুত।`
                : `Ready to search for "${q}".`
            );
          }
        }

        if (outcomes.length > 0) {
          const combined = outcomes.join(' ');
          setMessages((prev) => [
            ...prev,
            { id: `${clientMsgId}-reply`, role: 'assistant', text: combined, timestamp: new Date(), lang: activeLanguage },
          ]);
          setLatestTranscript(combined);
          setAssistantState('idle');
          return;
        }
      }

      // Direct hardware flashlight deduplication fallback
      const detectedIntent = detectAssistantIntent(cleanText);
      if (detectedIntent && detectedIntent.type === 'flashlight') {
        const now = Date.now();
        const statePayload = detectedIntent.payload || 'on';
        if (
          !lastFlashlightActionRef.current ||
          lastFlashlightActionRef.current.payload !== statePayload ||
          now - lastFlashlightActionRef.current.time >= 1500
        ) {
          lastFlashlightActionRef.current = { payload: statePayload, time: now };
          executeAssistantActionDirectly(detectedIntent);
        }
      }

      // 3. Display user message immediately in the shared conversation UI
      const userMsg: ChatMessage = {
        id: clientMsgId,
        role: 'user',
        text: cleanText,
        timestamp: new Date(),
        lang: activeLanguage,
      };
      setMessages((prev) => [...prev, userMsg]);

      // Advance user speech turn counter so any subsequent voice speech appears after this message
      userSpeechTurnIdRef.current += 1;

      // Unlock audio context on user submit gesture so Gemini Live audio response plays seamlessly
      getAudioContext();
      stopAllSpeechPlayback();
      receivedAudioInTurnRef.current = false;
      setAssistantState('thinking');

      // Check if browser is offline
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        setWsStatus('disconnected');
        const dtQuery = detectDateTimeQuery(cleanText);
        if (dtQuery) {
          let directReply = '';
          if (dtQuery === 'time') directReply = formatBengaliSpokenTime();
          else if (dtQuery === 'date') directReply = formatBengaliDate();
          else if (dtQuery === 'weekday') directReply = formatBengaliWeekday();
          setLatestTranscript(directReply);
          setMessages((prev) => [
            ...prev,
            {
              id: `offline-dt-${Date.now()}`,
              role: 'assistant',
              text: directReply,
              timestamp: new Date(),
              lang: 'bn-BD',
            },
          ]);
          setAssistantState('idle');
          return;
        }

        setAssistantState('error');
        const offlineErr =
          activeLanguage === 'bn-BD'
            ? `ইন্টারনেট সংযোগ নেই ${selectedAffectionName}। অনুগ্রহ করে নেটওয়ার্ক চেক করুন।`
            : `No internet connection, ${selectedAffectionName}. Please check your network and try again.`;
        setLatestTranscript(offlineErr);
        return;
      }

      // Check user-owned Gemini API key before sending remote Gemini requests
      const configError = getGeminiConfigError(undefined, activeLanguage);
      if (configError) {
        setConnectionError(configError);
        setLatestTranscript(configError);
        setAssistantState('error');
        setMessages((prev) => [
          ...prev,
          {
            id: `${clientMsgId}-config-err`,
            role: 'assistant',
            text: configError,
            timestamp: new Date(),
            lang: activeLanguage,
          },
        ]);
        return;
      }

      const historySnapshot = messagesRef.current.slice(-10).map((m) => ({
        role: m.role,
        text: m.text,
      }));

      pendingChatFallbackRef.current = {
        clientMsgId,
        text: cleanText,
        historySnapshot,
        answered: false,
        fallbackStarted: false,
      };

      // 4. Explicit Action-Intent Routing Policy (Root Cause 4):
      // Separate device-action intents from ordinary chat & route immediately to HTTP /api/chat function calling
      // whenever Live WS is unavailable or lacks declared tools — never silently falling back to ordinary conversation.
      const liveWsOpenAndReady =
        wsRef.current?.readyState === WebSocket.OPEN && isSessionReadyRef.current;
      const intentRoute = decideIntentExecutionRoute(cleanText, {
        liveWsReadyWithTools: Boolean(liveWsOpenAndReady && liveToolsReadyRef.current),
        isDateTimeQuery: Boolean(detectDateTimeQuery(cleanText)),
      });

      const useFallbackImmediately =
        intentRoute === 'http_function_calling' ||
        Boolean(liveNonRetryableErrorRef.current) ||
        shouldUseHttpChatFallback(
          wsRef.current?.readyState,
          isSessionReadyRef.current,
          wsStatusRef.current
        );

      if (useFallbackImmediately) {
        await sendViaHttpChatFallback(cleanText, clientMsgId, historySnapshot);
        return;
      }

      const sentDirectly = sendOverSharedWs(payload);
      if (!sentDirectly) {
        await sendViaHttpChatFallback(cleanText, clientMsgId, historySnapshot);
        return;
      }

      // Safety fallback timeout: if Live WS produces no transcript/audio within 12s, fall back once to /api/chat
      clearTurnTimeout();
      turnTimeoutRef.current = setTimeout(() => {
        const pending = pendingChatFallbackRef.current;
        if (
          pending &&
          pending.clientMsgId === clientMsgId &&
          !pending.answered &&
          !pending.fallbackStarted
        ) {
          void sendViaHttpChatFallback(cleanText, clientMsgId, historySnapshot);
        }
      }, 12000);
    },
    [
      selectedAffectionName,
      activeLanguage,
      switchLanguage,
      stopAllSpeechPlayback,
      sendOverSharedWs,
      sendViaHttpChatFallback,
      clearTurnTimeout,
      executeValidatedAssistantTool,
      handleApprovePendingAction,
      recordActionDiagnostic,
    ]
  );

  // Replay speech audio from transcript (uses active Direct Live WS or Direct Gemini TTS)
  const handleReplayAudio = async (text: string) => {
    if (vitals.soundFxEnabled) playProceduralSfx('click');
    stopAllSpeechPlayback();

    const apiKey = getGeminiApiKeyForRequest();
    const configError = !apiKey ? getGeminiConfigError(undefined, activeLanguage) : null;
    if (configError) {
      setConnectionError(configError);
      setLatestTranscript(configError);
      return;
    }

    if (
      wsRef.current &&
      wsRef.current.readyState === WebSocket.OPEN &&
      isSessionReadyRef.current
    ) {
      setAssistantState('speaking');
      sendOverSharedWs({
        type: 'client_text',
        text: `[System directive: Replay this response to ${selectedAffectionName} in ${activeLanguage} using your Gemini Live voice: "${text}"]`,
        clientMsgId: `replay-${Date.now()}`,
      });
      return;
    }

    // Direct Gemini TTS fallback when Live WS is offline
    setAssistantState('speaking');
    try {
      const audioBase64 = await synthesizeDirectGeminiTts({
        apiKey,
        text,
        voice: vitals.selectedVoice,
        lang: activeLanguage,
      });
      liveAudioPlayerRef.current?.playPcmChunk(audioBase64, 24000);
      setTimeout(() => {
        setAssistantState(isLiveActiveRef.current ? 'listening' : 'idle');
      }, 1200);
    } catch (err: any) {
      setAssistantState(isLiveActiveRef.current ? 'listening' : 'idle');
      setConnectionError(sanitizeGeminiSecret(err, apiKey) || 'Unable to replay voice audio.');
    }
  };

  // Interruption
  const handleInterrupt = () => {
    clearTurnTimeout();
    stopAllSpeechPlayback();
    sendOverSharedWs({ type: 'interrupt' });
    setAssistantState(isLiveActive ? 'listening' : 'idle');
  };

  // Reactor Click Action
  const handleReactorClick = async () => {
    if (vitals.soundFxEnabled) playProceduralSfx('love');
    if (!isLiveActive) {
      if (permissionsReport.microphone !== 'granted') {
        const res = await requestMicrophoneAccess();
        const fresh = await checkAllPermissions();
        setPermissionsReport(fresh);
        if (res.status === 'granted') {
          startVoiceCapture();
        } else {
          setIsPermissionsModalOpen(true);
        }
      } else {
        startVoiceCapture();
      }
    } else {
      handleInterrupt();
    }
  };

  // Toggle Auto-Play Settings
  const handleToggleAutoPlay = () => {
    if (vitals.soundFxEnabled) playProceduralSfx('click');
    const nextVal = !voiceAutoPlay;
    setVoiceAutoPlay(nextVal);
    localStorage.setItem('zoni_voice_autoplay', String(nextVal));
  };

  // Toggle Mute Settings
  const handleToggleVoiceMute = () => {
    if (vitals.soundFxEnabled) playProceduralSfx('click');
    const nextMute = !voiceMuted;
    setVoiceMuted(nextMute);
    localStorage.setItem('zoni_voice_muted', String(nextMute));
    if (nextMute) {
      stopAllSpeechPlayback();
    }
  };

  const handleToggleSoundFx = useCallback(() => {
    setVitals((v) => {
      const nextVal = !v.soundFxEnabled;
      if (typeof window !== 'undefined') {
        localStorage.setItem('zoni_sound_fx_enabled', String(nextVal));
      }
      return { ...v, soundFxEnabled: nextVal };
    });
  }, []);

  const handleManualReconnectLive = useCallback(() => {
    setConnectionError(null);
    void checkBackendHealth().then((snap) => {
      if (!isUnmountedRef.current && snap.geminiConfigured) {
        connectSharedLiveWs(true).catch(() => {
          // Surfacing via connectionError
        });
      }
    });
  }, [checkBackendHealth, connectSharedLiveWs]);

  useEffect(() => {
    handleSendMessageRef.current = handleSendMessage;
  }, [handleSendMessage]);

  const voiceLifecycleState: VoiceLifecycleState = deriveVoiceLifecycleState({
    wsStatus,
    assistantState,
    isLiveActive,
    isDisconnecting: isDisconnectingLive,
    wakeWordStatus,
  });

  useEffect(() => {
    notifyNativeVoiceSessionState(voiceLifecycleState);
  }, [voiceLifecycleState]);

  useEffect(() => {
    const syncNativeStatuses = () => {
      const ww = getNativeWakeWordStatus();
      if (ww) setWakeWordStatus(ww);
      const cs = getNativeIncomingCallStatus();
      if (cs) setIncomingCallStatus(cs);
    };
    syncNativeStatuses();

    const onWakeWordStatus = (ev: Event) => {
      const detail = (ev as CustomEvent<WakeWordStatusSnapshot>).detail;
      if (detail && typeof detail === 'object') {
        setWakeWordStatus(detail);
      }
    };

    const onCallStateChanged = (ev: Event) => {
      const detail = (ev as CustomEvent<IncomingCallStatusSnapshot>).detail;
      if (detail && typeof detail === 'object') {
        setIncomingCallStatus(detail);
        if (detail.callState === 'ACTIVE' || detail.isActiveCall) {
          try {
            window.speechSynthesis?.cancel();
          } catch {
            // ignore
          }
          if (isLiveActiveRef.current) {
            stopVoiceCapture(false);
          }
        }
      }
    };

    const onVoiceStateChanged = () => {
      const ww = getNativeWakeWordStatus();
      if (ww) setWakeWordStatus(ww);
    };

    const onWakeWordDetected = (ev: Event) => {
      const detail = (ev as CustomEvent<{ wakeWord?: string; confidence?: number; remainingCommand?: string }>).detail || {};
      const phrase = detail.wakeWord || wakeWordStatus?.wakePhrase || 'Zoni';
      const cleanedRemainder = stripWakePhraseFromCommand(detail.remainingCommand || '', phrase);

      if (cleanedRemainder) {
        // Execute only the stripped command; never pass bare wake word as a command
        handleSendMessageRef.current?.(cleanedRemainder);
        return;
      }

      if (!isLiveActiveRef.current && !liveStartInFlightRef.current) {
        setLatestTranscript(
          activeLanguageRef.current === 'bn-BD'
            ? `"${phrase}" ওয়েক ওয়ার্ড শনাক্ত হয়েছে — Gemini Live চালু হচ্ছে...`
            : `Wake word "${phrase}" detected — activating Gemini Live...`
        );
        void startVoiceCapture();
      }
    };

    window.addEventListener('zoni:wake-word-status', onWakeWordStatus);
    window.addEventListener('zoni:call-state-changed', onCallStateChanged);
    window.addEventListener('zoni:voice-state-changed', onVoiceStateChanged);
    window.addEventListener('zoni:wake-word-detected', onWakeWordDetected);

    return () => {
      window.removeEventListener('zoni:wake-word-status', onWakeWordStatus);
      window.removeEventListener('zoni:call-state-changed', onCallStateChanged);
      window.removeEventListener('zoni:voice-state-changed', onVoiceStateChanged);
      window.removeEventListener('zoni:wake-word-detected', onWakeWordDetected);
    };
  }, [startVoiceCapture, wakeWordStatus?.wakePhrase]);

  const handleStartBackgroundWakeWord = useCallback(() => {
    const result = startNativeBackgroundWakeWord();
    const fresh = getNativeWakeWordStatus();
    if (fresh) {
      setWakeWordStatus(fresh);
    } else {
      setWakeWordStatus((prev) => ({
        wakeWordEnabled: false,
        backgroundServiceRunning: false,
        listening: false,
        wakePhrase: prev?.wakePhrase || 'Zoni',
        voiceState: 'IDLE',
        micPermissionGranted: false,
        notificationPermissionGranted: false,
        detectorEngine: 'on_device_two_stage_acoustic_gate',
        lastDetectedAtMs: prev?.lastDetectedAtMs ?? 0,
        lastConfidence: prev?.lastConfidence ?? 0,
        lastError:
          result.message ||
          '24-hour background wake word listening requires the installed ZONI Android APK.',
      }));
    }
    if (!result.success && result.message) {
      setLatestTranscript(result.message);
    }
  }, []);

  const handleStopBackgroundWakeWord = useCallback(() => {
    stopNativeBackgroundWakeWord();
    const fresh = getNativeWakeWordStatus();
    if (fresh) {
      setWakeWordStatus(fresh);
    } else {
      setWakeWordStatus((prev) =>
        prev
          ? {
              ...prev,
              wakeWordEnabled: false,
              backgroundServiceRunning: false,
              listening: false,
              voiceState: 'DISABLED',
            }
          : null
      );
    }
  }, []);

  const handleUpdateWakePhrase = useCallback((phrase: string) => {
    const cleaned = phrase.trim() || 'Zoni';
    setNativeWakePhrase(cleaned);
    const fresh = getNativeWakeWordStatus();
    if (fresh) {
      setWakeWordStatus(fresh);
    } else {
      setWakeWordStatus((prev) => ({
        wakeWordEnabled: prev?.wakeWordEnabled ?? false,
        backgroundServiceRunning: prev?.backgroundServiceRunning ?? false,
        listening: prev?.listening ?? false,
        wakePhrase: cleaned,
        voiceState: prev?.voiceState || 'IDLE',
        micPermissionGranted: prev?.micPermissionGranted ?? false,
        notificationPermissionGranted: prev?.notificationPermissionGranted ?? false,
        detectorEngine: prev?.detectorEngine || 'on_device_two_stage_acoustic_gate',
        lastDetectedAtMs: prev?.lastDetectedAtMs ?? 0,
        lastConfidence: prev?.lastConfidence ?? 0,
        lastError: prev?.lastError || '',
      }));
    }
  }, []);

  const handleRefreshCallStatus = useCallback(() => {
    const fresh = getNativeIncomingCallStatus();
    if (fresh) {
      setIncomingCallStatus(fresh);
      setCallControlNotice(null);
    } else {
      setCallControlNotice('Live Telecom call state requires the installed Android APK.');
    }
  }, []);

  const handleCallControlAction = useCallback(
    async (action: 'answer_incoming_call' | 'reject_incoming_call' | 'end_active_call') => {
      const report = await executeValidatedAssistantTool(action, {});
      setCallControlNotice(report.message);
      setLatestTranscript(report.message);
      const fresh = getNativeIncomingCallStatus();
      if (fresh) setIncomingCallStatus(fresh);
    },
    [executeValidatedAssistantTool]
  );

  const handleRequestCallPermissions = useCallback(() => {
    const bridge = getNativeAndroidBridge();
    if (bridge?.requestRuntimePermission) {
      bridge.requestRuntimePermission('call_control');
      setCallControlNotice('Requested Android phone call permissions (READ_PHONE_STATE & ANSWER_PHONE_CALLS).');
    } else {
      setCallControlNotice('Android phone permissions can only be requested inside the installed APK.');
    }
  }, []);

  const handleRequestDialerRole = useCallback(() => {
    const started = requestNativeCallControlRole();
    setCallControlNotice(
      started
        ? 'Opened Android Call Control / Default Dialer role request.'
        : 'Default Dialer role prompt is available only inside the installed Android APK.'
    );
  }, []);

  return (
    <div className="relative min-h-screen w-full bg-slate-950 text-cyan-50 flex flex-col justify-between overflow-x-hidden selection:bg-pink-500/30 selection:text-pink-200">
      {/* Background Animated Sci-Fi Ambient Glow & Grid */}
      <div className="fixed inset-0 pointer-events-none hud-grid opacity-35 z-0" />
      <div className="fixed -top-40 -left-40 w-96 h-96 rounded-full bg-cyan-600/10 blur-[130px] pointer-events-none" />
      <div className="fixed -bottom-40 -right-40 w-96 h-96 rounded-full bg-pink-600/10 blur-[130px] pointer-events-none" />

      {/* Top Jarvis Status Bar with Language Selector and Audio Controls */}
      <HudHeader
        vitals={vitals}
        permissionsReport={permissionsReport}
        wsStatus={wsStatus}
        backendHealth={backendHealth}
        onToggleSoundFx={handleToggleSoundFx}
        onToggleChatDrawer={() => setIsChatDrawerOpen(!isChatDrawerOpen)}
        onOpenSettings={() => setIsSettingsModalOpen(true)}
        onOpenApkModal={() => setIsApkModalOpen(true)}
        onOpenCallingModal={() => setIsCallingModalOpen(true)}
        onOpenPermissionsModal={() => setIsPermissionsModalOpen(true)}
        onSelectLanguage={switchLanguage}
        onToggleAutoPlay={handleToggleAutoPlay}
        onToggleVoiceMute={handleToggleVoiceMute}
        isChatOpen={isChatDrawerOpen}
      />

      {/* Main Command Center Stage - Clean, Uncluttered, Focused on Arc Reactor */}
      <main className="relative flex-1 flex flex-col items-center justify-center p-3 sm:p-6 z-10 max-w-4xl mx-auto w-full">
        {/* Center: The Iconic Jarvis Arc Reactor Core */}
        <div className="w-full flex flex-col items-center justify-center my-auto">
          <ArcReactor
            state={assistantState}
            mode={vitals.activeMode}
            selectedAffectionName={selectedAffectionName}
            userNickname={selectedAffectionName}
            isLiveActive={isLiveActive}
            latestTranscript={latestTranscript}
            onReactorClick={handleReactorClick}
          />
        </div>

        {/* Live Incoming / Active Phone Call Control Strip (Shown ONLY when Android Telecom reports RINGING or ACTIVE) */}
        {(incomingCallStatus?.isIncomingRinging || incomingCallStatus?.isActiveCall) && (
          <div
            data-testid="live-call-control-strip"
            className="w-full max-w-2xl mt-3 px-4 py-3 rounded-2xl bg-emerald-950/90 border border-emerald-400/60 text-emerald-100 flex flex-col sm:flex-row sm:items-center justify-between gap-3 shadow-[0_0_25px_rgba(16,185,129,0.25)]"
          >
            <div className="flex items-center gap-2.5 min-w-0">
              <PhoneIncoming className="w-5 h-5 text-emerald-300 shrink-0" />
              <div className="min-w-0">
                <div className="font-sci-fi text-xs font-bold tracking-wider uppercase text-emerald-200">
                  {incomingCallStatus.isIncomingRinging ? 'INCOMING PHONE CALL' : 'ACTIVE PHONE CALL'}
                </div>
                <div className="text-xs text-emerald-100/90 truncate">
                  {incomingCallStatus.callerDisplayName ||
                    incomingCallStatus.callerNumber ||
                    incomingCallStatus.callState}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {incomingCallStatus.isIncomingRinging && (
                <>
                  <button
                    type="button"
                    onClick={() => void handleCallControlAction('answer_incoming_call')}
                    className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-hud text-xs font-bold flex items-center gap-1.5 cursor-pointer"
                  >
                    <PhoneIncoming className="w-3.5 h-3.5" />
                    <span>ANSWER</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleCallControlAction('reject_incoming_call')}
                    className="px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white font-hud text-xs font-bold flex items-center gap-1.5 cursor-pointer"
                  >
                    <PhoneOff className="w-3.5 h-3.5" />
                    <span>REJECT</span>
                  </button>
                </>
              )}
              {incomingCallStatus.isActiveCall && (
                <button
                  type="button"
                  onClick={() => void handleCallControlAction('end_active_call')}
                  className="px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 text-white font-hud text-xs font-bold flex items-center gap-1.5 cursor-pointer"
                >
                  <PhoneOff className="w-3.5 h-3.5" />
                  <span>END CALL</span>
                </button>
              )}
            </div>
          </div>
        )}

        {/* Interactive Review / Edit / Cancel / Approve Card for WhatsApp, SMS & Calls */}
        <ActionConfirmationCard
          draft={pendingActionDraft}
          activeLanguage={activeLanguage}
          onApprove={handleApprovePendingAction}
          onCancel={handleCancelPendingAction}
        />

        {/* Authoritative Connection / Backend Configuration Error Banner */}
        {connectionError && (
          <div
            role="alert"
            className="w-full max-w-2xl mt-3 px-3.5 py-2.5 rounded-xl bg-rose-950/85 border border-rose-500/50 text-rose-100 text-xs font-hud flex flex-col sm:flex-row sm:items-center justify-between gap-2 shadow-[0_0_20px_rgba(244,63,94,0.2)]"
          >
            <div className="flex items-start gap-2 min-w-0">
              <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
              <span className="leading-snug break-words">{connectionError}</span>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <button
                type="button"
                onClick={handleManualReconnectLive}
                className="px-2.5 py-1 rounded-lg bg-rose-900/70 hover:bg-rose-800/80 border border-rose-400/40 text-rose-100 text-[11px] font-bold flex items-center gap-1 cursor-pointer"
              >
                <RefreshCw className="w-3 h-3" />
                <span>Retry</span>
              </button>
              <button
                type="button"
                onClick={() => setIsPermissionsModalOpen(true)}
                className="px-2.5 py-1 rounded-lg bg-cyan-950/80 hover:bg-cyan-900/80 border border-cyan-400/40 text-cyan-200 text-[11px] font-bold flex items-center gap-1 cursor-pointer"
              >
                <Settings2 className="w-3 h-3" />
                <span>Setup</span>
              </button>
              <button
                type="button"
                onClick={() => setConnectionError(null)}
                aria-label="Dismiss error banner"
                className="p-1 rounded hover:bg-rose-900/60 text-rose-300 cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        )}
      </main>

      {/* Bottom Control Dock: Live Voice Link & Typing Input */}
      <footer className="relative z-20 flex justify-center w-full">
        <ControlDock
          state={assistantState}
          isLiveActive={isLiveActive}
          isMicMuted={isMicMuted}
          activeLanguage={activeLanguage}
          onToggleLiveMode={handleToggleLiveMode}
          onToggleMicMute={() => setIsMicMuted(!isMicMuted)}
          onSendMessage={handleSendMessage}
          onInterrupt={handleInterrupt}
          soundFxEnabled={vitals.soundFxEnabled}
        />
      </footer>

      {/* Transcript Archive Drawer */}
      <ChatTranscriptDrawer
        isOpen={isChatDrawerOpen}
        onClose={() => setIsChatDrawerOpen(false)}
        messages={messages}
        onReplayAudio={handleReplayAudio}
        onClearMessages={() => setMessages([])}
        selectedAffectionName={selectedAffectionName}
        userNickname={selectedAffectionName}
      />

      {/* Native Android SIM Calling Hub Modal */}
      <SimCallingModal
        isOpen={isCallingModalOpen}
        onClose={() => setIsCallingModalOpen(false)}
        soundFxEnabled={vitals.soundFxEnabled}
        selectedAffectionName={selectedAffectionName}
        activeLanguage={activeLanguage}
        incomingCallStatus={incomingCallStatus}
        onAnswerIncomingCall={() => void handleCallControlAction('answer_incoming_call')}
        onRejectIncomingCall={() => void handleCallControlAction('reject_incoming_call')}
        onEndActiveCall={() => void handleCallControlAction('end_active_call')}
        onRefreshCallStatus={handleRefreshCallStatus}
        onRequestCallPermissions={handleRequestCallPermissions}
        onRequestDialerRole={handleRequestDialerRole}
        callControlNotice={callControlNotice}
      />

      {/* APK & Mobile Assistant Export Hub Modal */}
      <ApkExportModal
        isOpen={isApkModalOpen}
        onClose={() => setIsApkModalOpen(false)}
        soundFxEnabled={vitals.soundFxEnabled}
        deferredPrompt={deferredPrompt}
        onInstallPwa={handleInstallPwa}
        selectedAffectionName={selectedAffectionName}
      />

      {/* Clean Zoni Jarvis Settings Modal (Soul Core, Personality Matrix, Voice Modulator, Wake Word, Telemetry, Device Action Diagnostics) */}
      <ErrorBoundary
        variant="modal"
        title="SETTINGS INTERFACE RECOVERY"
        onDismiss={() => setIsSettingsModalOpen(false)}
      >
        <ZoniSettingsModal
          isOpen={isSettingsModalOpen}
          onClose={() => setIsSettingsModalOpen(false)}
          vitals={vitals}
          selectedAffectionName={selectedAffectionName}
          isLiveActive={isLiveActive}
          wsStatus={wsStatus}
          backendHealth={backendHealth}
          deviceDiagnostics={deviceDiagnostics}
          wakeWordStatus={wakeWordStatus}
          voiceLifecycleState={voiceLifecycleState}
          onStartBackgroundWakeWord={handleStartBackgroundWakeWord}
          onStopBackgroundWakeWord={handleStopBackgroundWakeWord}
          onUpdateWakePhrase={handleUpdateWakePhrase}
          onToggleLiveMode={handleToggleLiveMode}
          onOpenBatterySettings={() => {
            const bridge = getNativeAndroidBridge();
            if (bridge?.openSystemSettings) {
              bridge.openSystemSettings('battery');
            } else {
              setIsSettingsModalOpen(false);
              setIsPermissionsModalOpen(true);
            }
          }}
          onRequestMicPermission={() => {
            const bridge = getNativeAndroidBridge();
            if (bridge?.requestRuntimePermission) {
              bridge.requestRuntimePermission('microphone');
            } else {
              void requestMicrophoneAccess();
            }
          }}
          onSelectMode={handleSelectMode}
          onUpdateAffectionName={handleUpdateAffectionName}
          onSelectVoice={handleSelectVoice}
          onToggleSoundFx={handleToggleSoundFx}
          onReconnectLive={handleManualReconnectLive}
          onRefreshDiagnostics={refreshDeviceDiagnostics}
          onOpenAccessibilitySettings={() => {
            const bridge = getNativeAndroidBridge();
            if (bridge?.openSystemSettings) {
              bridge.openSystemSettings('accessibility');
            } else {
              setIsSettingsModalOpen(false);
              setIsPermissionsModalOpen(true);
            }
          }}
          onOpenBackendSetup={() => {
            setIsSettingsModalOpen(false);
            setIsPermissionsModalOpen(true);
          }}
          onGeminiKeyChanged={handleManualReconnectLive}
        />
      </ErrorBoundary>

      {/* Backend Health, Permissions & Background Setup Wizard Modal */}
      <PermissionsSetupModal
        isOpen={isPermissionsModalOpen}
        onClose={() => setIsPermissionsModalOpen(false)}
        report={permissionsReport}
        onUpdateReport={(updated) => setPermissionsReport(updated)}
        onMicInitialized={handleMicInitialized}
        onLocationInitialized={handleLocationInitialized}
        onNotificationInitialized={handleNotificationInitialized}
        soundFxEnabled={vitals.soundFxEnabled}
        activeLanguage={activeLanguage}
        selectedAffectionName={selectedAffectionName}
        backendHealth={backendHealth}
        onRefreshBackendHealth={checkBackendHealth}
        onBackendUrlChanged={handleManualReconnectLive}
      />
      {/* Offline connectivity indicator */}
      <OfflineIndicator />
    </div>
  );
}
