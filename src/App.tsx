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
import { AlertTriangle, RefreshCw, Settings2, X } from 'lucide-react';
import { OfflineIndicator } from './components/PWAInstallButton';
import {
  LiveAudioPlayer,
  pcm16ToBase64,
  playProceduralSfx,
  getAudioContext,
  stopAllBrowserSpeech,
} from './utils/audio';
import {
  detectAssistantIntent,
  detectLanguageSwitchCommand,
  executeAssistantActionDirectly,
  AssistantAction,
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
  getApiBaseUrl,
  getLiveWsUrl,
  getBackendConfigError,
  getDisplayBackendUrl,
} from './utils/apiConfig';
import {
  callContactViaNativeBridge,
  prepareWhatsAppContactViaNativeBridge,
  launchAppDetailedViaNativeBridge,
  captureNativeScreenSnapshot,
  getRecentNativeNotifications,
  adjustNativeVolume,
  openNativeCamera,
  performNativeAccessibilityCommand,
} from './utils/androidBridge';
import { buildStructuredTaskPlan } from './utils/taskExecutionEngine';
import {
  WsConnectionStatus,
  buildClientTextPayload,
  extractActionTagFromText,
  upsertAssistantTurnMessage,
  upsertUserSpeechTurnMessage,
  getReconnectDelayMs,
  shouldAutoReconnectLiveWs,
  shouldUseHttpChatFallback,
} from './utils/liveSessionProtocol';

export default function App() {
  const [assistantState, setAssistantState] = useState<AssistantState>('idle');
  const [isLiveActive, setIsLiveActive] = useState(false);
  const [isMicMuted, setIsMicMuted] = useState(false);
  const [wsStatus, setWsStatus] = useState<WsConnectionStatus>('disconnected');
  const [sessionResumed, setSessionResumed] = useState<boolean>(false);
  const [backendHealth, setBackendHealth] = useState<BackendHealthSnapshot | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);

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
  const hadConnectedOnceRef = useRef<boolean>(false);
  const reconnectAttemptRef = useRef<number>(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
  const lastFlashlightActionRef = useRef<{ payload: string; time: number } | null>(null);

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

  // Probe live backend health & server-side Gemini API key status
  const checkBackendHealth = useCallback(async (): Promise<BackendHealthSnapshot> => {
    const backendUrl = getDisplayBackendUrl();
    const configError = getBackendConfigError();
    if (configError) {
      const snap: BackendHealthSnapshot = {
        checked: true,
        reachable: false,
        geminiConfigured: false,
        statusText: 'UNCONFIGURED',
        configurationError: configError,
        backendUrl,
      };
      setBackendHealth(snap);
      setConnectionError(configError);
      setWsStatus('error');
      return snap;
    }

    try {
      const base = getApiBaseUrl();
      const res = await fetch(`${base}/api/status`, { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      const geminiConfigured = Boolean(data.geminiConfigured);
      const errMsg =
        data.configurationError ||
        (!res.ok ? `Backend returned HTTP ${res.status}` : null);
      const snap: BackendHealthSnapshot = {
        checked: true,
        reachable: res.ok,
        geminiConfigured,
        statusText: res.ok
          ? geminiConfigured
            ? 'ONLINE (READY)'
            : 'DEGRADED (KEY MISSING)'
          : 'OFFLINE',
        configurationError: errMsg,
        backendUrl,
      };
      setBackendHealth(snap);
      if (!snap.reachable || !snap.geminiConfigured) {
        setConnectionError(errMsg || 'ZONI backend requires configuration.');
      } else {
        setConnectionError((prev) =>
          prev && prev.includes('Backend') ? null : prev
        );
      }
      return snap;
    } catch (err: any) {
      const message =
        err?.message || 'Unable to reach the ZONI AI backend server.';
      const snap: BackendHealthSnapshot = {
        checked: true,
        reachable: false,
        geminiConfigured: false,
        statusText: 'OFFLINE',
        configurationError: message,
        backendUrl,
      };
      setBackendHealth(snap);
      setConnectionError(message);
      return snap;
    }
  }, []);

  // Stop only microphone audio capture while keeping the shared Gemini Live WebSocket session open
  const stopVoiceCapture = useCallback((preserveErrorState = false) => {
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
    if (!preserveErrorState) {
      setAssistantState('idle');
    }
  }, []);

  // Reliable HTTP /api/chat fallback whenever Gemini Live WebSocket is unavailable, disconnected, or times out
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

      const configError = getBackendConfigError();
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
        const base = getApiBaseUrl();
        const res = await fetch(`${base}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: cleanText,
            history: historySnapshot,
            mode: activeModeRef.current,
            nickname: selectedAffectionNameRef.current,
            selectedAffectionName: selectedAffectionNameRef.current,
            lang: activeLanguageRef.current,
          }),
        });

        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          const errMessage =
            data?.error ||
            `ZONI AI backend error (HTTP ${res.status}). Check server GEMINI_API_KEY configuration.`;
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
          return;
        }

        const rawReply = typeof data.reply === 'string' ? data.reply.trim() : '';
        if (!rawReply) {
          throw new Error('Empty response returned by /api/chat.');
        }

        const { cleanText: replyClean, action } = extractActionTagFromText(rawReply);
        if (action) {
          executeAssistantActionDirectly(action);
        }
        const finalReply = replyClean || rawReply;

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
          err?.message ||
          'Failed to reach ZONI AI backend (/api/chat). Please verify your server connection.';
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
    [clearTurnTimeout]
  );

  // Connect or reuse the single shared Gemini Live WebSocket session, resolving ONLY after server 'connected' handshake
  const connectSharedLiveWs = useCallback(
    (forceReconnect = false): Promise<void> => {
      if (isUnmountedRef.current) {
        return Promise.reject(new Error('Component unmounted'));
      }

      const configError = getBackendConfigError();
      if (configError) {
        setWsStatus('error');
        setConnectionError(configError);
        if (isLiveActiveRef.current) {
          stopVoiceCapture(true);
          setAssistantState('error');
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

      settlePendingHandshake(new Error('Replaced by newer Live WebSocket connection attempt.'));

      if (wsRef.current) {
        try {
          wsRef.current.onclose = null;
          wsRef.current.onerror = null;
          wsRef.current.close();
        } catch {
          // ignore
        }
        wsRef.current = null;
      }

      isSessionReadyRef.current = false;
      setWsStatus(reconnectAttemptRef.current > 0 ? 'reconnecting' : 'connecting');

      const wsUrl = getLiveWsUrl(
        activeModeRef.current,
        selectedAffectionNameRef.current,
        selectedVoiceRef.current,
        activeLanguageRef.current,
        resumptionHandleRef.current
      );

      if (!wsUrl) {
        const errText =
          getBackendConfigError() || 'Backend WebSocket URL is not configured.';
        setWsStatus('error');
        setConnectionError(errText);
        return Promise.reject(new Error(errText));
      }

      const connectPromise = new Promise<void>((resolve, reject) => {
        const handshakeTimer = setTimeout(() => {
          if (wsHandshakeResolverRef.current) {
            const timeoutErr = new Error(
              'Timed out waiting for Gemini Live server handshake (/live).'
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
            // Wait for server 'connected' event confirming Gemini Live upstream handshake
          };

          ws.onmessage = (event) => {
            if (isUnmountedRef.current || wsRef.current !== ws) return;
            try {
              const msg = JSON.parse(event.data);

              if (msg.type === 'connected') {
                isSessionReadyRef.current = true;
                reconnectAttemptRef.current = 0;
                liveNonRetryableErrorRef.current = null;
                setWsStatus('connected');
                setConnectionError(null);
                const wasResumed = Boolean(msg.resumed);
                setSessionResumed(wasResumed);
                settlePendingHandshake();

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

                // Flush any queued messages (e.g. typed Chat Box messages sent while connecting)
                while (
                  outgoingQueueRef.current.length > 0 &&
                  ws.readyState === WebSocket.OPEN
                ) {
                  const queuedPayload = outgoingQueueRef.current.shift();
                  if (queuedPayload) {
                    ws.send(queuedPayload);
                  }
                }
                return;
              }

              if (msg.type === 'session_resumption') {
                if (msg.newHandle && typeof msg.newHandle === 'string') {
                  resumptionHandleRef.current = msg.newHandle;
                }
                return;
              }

              if (msg.type === 'flashlight') {
                const turnOn = Boolean(msg.enable);
                toggleFlashlight(turnOn);
                const feedback =
                  activeLanguageRef.current === 'bn-BD'
                    ? turnOn
                      ? 'টর্চ লাইট জ্বালানো হয়েছে।'
                      : 'টর্চ লাইট বন্ধ করা হয়েছে।'
                    : turnOn
                    ? 'Flashlight turned on.'
                    : 'Flashlight turned off.';
                setLatestTranscript(feedback);
                return;
              }

              if (msg.type === 'user_transcript' && msg.text) {
                const speechTurnId =
                  typeof msg.turnId === 'number'
                    ? msg.turnId
                    : userSpeechTurnIdRef.current;

                setMessages((prev) =>
                  upsertUserSpeechTurnMessage(
                    prev,
                    msg.text,
                    speechTurnId,
                    activeLanguageRef.current
                  )
                );

                if (isFlashlightOnCommand(msg.text)) {
                  toggleFlashlight(true);
                  const feedback =
                    activeLanguageRef.current === 'bn-BD'
                      ? 'টর্চ লাইট জ্বালানো হয়েছে।'
                      : 'Flashlight turned on.';
                  setLatestTranscript(feedback);
                } else if (isFlashlightOffCommand(msg.text)) {
                  toggleFlashlight(false);
                  const feedback =
                    activeLanguageRef.current === 'bn-BD'
                      ? 'টর্চ লাইট বন্ধ করা হয়েছে।'
                      : 'Flashlight turned off.';
                  setLatestTranscript(feedback);
                }
                return;
              }

              if (msg.type === 'audio' && msg.audio) {
                clearTurnTimeout();
                receivedAudioInTurnRef.current = true;
                if (pendingChatFallbackRef.current) {
                  pendingChatFallbackRef.current.answered = true;
                }
                if (
                  !voiceMutedRef.current &&
                  (isLiveActiveRef.current || voiceAutoPlayRef.current)
                ) {
                  setAssistantState('speaking');
                  liveAudioPlayerRef.current?.playPcmChunk(msg.audio, 24000);
                }
                return;
              }

              if ((msg.type === 'output_transcript' || msg.type === 'text') && msg.text) {
                clearTurnTimeout();
                if (pendingChatFallbackRef.current) {
                  pendingChatFallbackRef.current.answered = true;
                }
                const turnId =
                  typeof msg.turnId === 'number'
                    ? msg.turnId
                    : currentTurnIdRef.current;

                const { cleanText, action } = extractActionTagFromText(msg.text);
                if (action) {
                  executeAssistantActionDirectly(action);
                }

                const liveLangSwitch = detectLanguageSwitchCommand(
                  cleanText || msg.text,
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
                      msg.text,
                      turnId,
                      activeLanguageRef.current
                    );
                  if (latestFullText) {
                    setLatestTranscript(latestFullText);
                  }
                  return updated;
                });

                return;
              }

              if (msg.type === 'interrupted') {
                clearTurnTimeout();
                stopAllSpeechPlayback();
                receivedAudioInTurnRef.current = false;
                currentTurnIdRef.current =
                  typeof msg.turnId === 'number'
                    ? msg.turnId + 1
                    : currentTurnIdRef.current + 1;
                setAssistantState(isLiveActiveRef.current ? 'listening' : 'idle');
                return;
              }

              if (msg.type === 'turnComplete') {
                clearTurnTimeout();
                const completedTurnId =
                  typeof msg.turnId === 'number'
                    ? msg.turnId
                    : currentTurnIdRef.current;
                currentTurnIdRef.current = completedTurnId + 1;
                userSpeechTurnIdRef.current += 1;
                receivedAudioInTurnRef.current = false;
                pendingChatFallbackRef.current = null;

                setVitals((prev) => ({
                  ...prev,
                  totalInteractions: prev.totalInteractions + 1,
                  affectionLevel: Math.min(100, prev.affectionLevel + 1),
                }));

                setTimeout(() => {
                  setAssistantState(isLiveActiveRef.current ? 'listening' : 'idle');
                }, 400);
                return;
              }

              if (msg.type === 'error' || msg.type === 'live_init_failed') {
                clearTurnTimeout();
                isSessionReadyRef.current = false;
                const serverErr =
                  msg.message || 'Gemini Live session could not initialize.';
                console.warn('Live API event:', serverErr, msg.code || '');
                setWsStatus('error');
                setConnectionError(serverErr);

                if (
                  !shouldAutoReconnectLiveWs(
                    msg.code,
                    msg.retryable,
                    reconnectAttemptRef.current
                  )
                ) {
                  liveNonRetryableErrorRef.current = serverErr;
                }

                // Immediately halt mic capture so UI never falsely displays LISTENING
                if (isLiveActiveRef.current) {
                  stopVoiceCapture(true);
                }
                setAssistantState('error');
                setLatestTranscript(serverErr);
                settlePendingHandshake(new Error(serverErr));

                // If a typed chat turn was awaiting this Live WS, fall back once to /api/chat
                const pendingChat = pendingChatFallbackRef.current;
                if (pendingChat && !pendingChat.answered && !pendingChat.fallbackStarted) {
                  void sendViaHttpChatFallback(
                    pendingChat.text,
                    pendingChat.clientMsgId,
                    pendingChat.historySnapshot
                  );
                }
              }
            } catch (e) {
              console.warn('Live message parse notice:', e);
            }
          };

          ws.onerror = () => {
            if (isUnmountedRef.current || wsRef.current !== ws) return;
            setWsStatus('error');
          };

          ws.onclose = () => {
            if (isUnmountedRef.current || wsRef.current !== ws) return;
            isSessionReadyRef.current = false;
            wsRef.current = null;

            const disconnectReason =
              liveNonRetryableErrorRef.current ||
              'Gemini Live WebSocket disconnected. Chat messages will automatically use /api/chat fallback.';

            settlePendingHandshake(new Error(disconnectReason));

            // Never leave microphone active / UI showing LISTENING after WS disconnects
            if (isLiveActiveRef.current) {
              stopVoiceCapture(true);
              setAssistantState('error');
              setConnectionError(disconnectReason);
              setLatestTranscript(
                activeLanguageRef.current === 'bn-BD'
                  ? `লাইভ ভয়েস সংযোগ বিচ্ছিন্ন হয়েছে: ${disconnectReason}`
                  : `Live voice disconnected: ${disconnectReason}`
              );
            }

            // If a typed chat turn was awaiting this Live WS, immediately fall back to /api/chat
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
              shouldAutoReconnectLiveWs(undefined, true, reconnectAttemptRef.current)
            ) {
              setWsStatus('reconnecting');
              const delay = getReconnectDelayMs(reconnectAttemptRef.current);
              reconnectAttemptRef.current += 1;
              reconnectTimerRef.current = setTimeout(() => {
                if (!isUnmountedRef.current) {
                  connectSharedLiveWs(false).catch(() => {
                    // Handled via wsStatus & connectionError
                  });
                }
              }, delay);
            } else {
              setWsStatus('error');
              if (liveNonRetryableErrorRef.current) {
                setConnectionError(liveNonRetryableErrorRef.current);
              }
            }
          };
        } catch (err: any) {
          const msg = err?.message || 'WebSocket creation failed.';
          console.warn('WebSocket creation failed:', err);
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
      sendViaHttpChatFallback,
      settlePendingHandshake,
      stopAllSpeechPlayback,
      stopVoiceCapture,
    ]
  );

  // Send a JSON payload over the shared Gemini Live WebSocket (queueing if connecting)
  const sendOverSharedWs = useCallback(
    (payload: Record<string, any>): boolean => {
      const serialized = JSON.stringify(payload);
      if (
        wsRef.current &&
        wsRef.current.readyState === WebSocket.OPEN &&
        isSessionReadyRef.current
      ) {
        try {
          wsRef.current.send(serialized);
          return true;
        } catch (err) {
          console.warn('Failed to send over active WebSocket, queueing for reconnect:', err);
        }
      }

      if (getBackendConfigError() || liveNonRetryableErrorRef.current) {
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

  // Initialize Audio Player, Backend Health Check, Shared Live WebSocket & Online/Offline listeners
  useEffect(() => {
    isUnmountedRef.current = false;
    liveAudioPlayerRef.current = new LiveAudioPlayer();
    void checkBackendHealth();
    connectSharedLiveWs().catch(() => {
      // Surfacing via connectionError & wsStatus
    });

    const handleBeforeInstall = (e: any) => {
      e.preventDefault();
      setDeferredPrompt(e);
    };

    const handleOnline = () => {
      reconnectAttemptRef.current = 0;
      liveNonRetryableErrorRef.current = null;
      void checkBackendHealth();
      connectSharedLiveWs(true).catch(() => {
        // Surfacing via connectionError
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

    const handleBackendUrlUpdated = () => {
      liveNonRetryableErrorRef.current = null;
      reconnectAttemptRef.current = 0;
      void checkBackendHealth();
      connectSharedLiveWs(true).catch(() => {
        // Handled via connectionError
      });
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstall);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    window.addEventListener('zoni:backend-url-updated', handleBackendUrlUpdated);

    return () => {
      isUnmountedRef.current = true;
      window.removeEventListener('beforeinstallprompt', handleBeforeInstall);
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('zoni:backend-url-updated', handleBackendUrlUpdated);
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
      }
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
    stopVoiceCapture();
    const configError = getBackendConfigError();
    if (configError) {
      setAssistantState('error');
      setConnectionError(configError);
      setLatestTranscript(configError);
      return;
    }

    setAssistantState('connecting');
    setConnectionError(null);
    setLatestTranscript(
      activeLanguageRef.current === 'bn-BD'
        ? `Gemini Live সার্ভারের সাথে সংযোগ করা হচ্ছে ${selectedAffectionNameRef.current}...`
        : `Connecting to Gemini Live server, ${selectedAffectionNameRef.current}...`
    );
    getAudioContext();

    // 1. Await real server 'connected' handshake BEFORE activating mic or showing LISTENING
    try {
      await connectSharedLiveWs(wsStatusRef.current === 'error');
    } catch (wsErr: any) {
      const wsMsg =
        wsErr?.message ||
        'Could not establish Gemini Live WebSocket session. Verify backend health and server GEMINI_API_KEY.';
      setAssistantState('error');
      setConnectionError(wsMsg);
      setLatestTranscript(wsMsg);
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
        return;
      }

      mediaStreamRef.current = stream;

      const AudioCtxClass = window.AudioContext || (window as any).webkitAudioContext;
      const inputCtx = new AudioCtxClass({ sampleRate: 16000 });
      inputAudioCtxRef.current = inputCtx;
      const source = inputCtx.createMediaStreamSource(stream);
      const processor = inputCtx.createScriptProcessor(4096, 1, 1);
      scriptProcessorRef.current = processor;

      processor.onaudioprocess = (e) => {
        if (isMicMutedRef.current) return;
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
        const channelData = e.inputBuffer.getChannelData(0);
        const base64Audio = pcm16ToBase64(channelData);
        try {
          wsRef.current.send(JSON.stringify({ audio: base64Audio }));
        } catch {
          stopVoiceCapture(true);
          setAssistantState('error');
          setConnectionError('Failed sending microphone audio to Gemini Live.');
        }
      };

      source.connect(processor);
      processor.connect(inputCtx.destination);

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

      if (taskPlan.steps.length === 1) {
        const step = taskPlan.steps[0];
        const appendDirectTurn = (replyText: string) => {
          setMessages((prev) => [
            ...prev,
            { id: clientMsgId, role: 'user', text: cleanText, timestamp: new Date(), lang: activeLanguage },
            { id: `${clientMsgId}-reply`, role: 'assistant', text: replyText, timestamp: new Date(), lang: activeLanguage },
          ]);
          setLatestTranscript(replyText);
          setAssistantState('idle');
        };

        if (step.tool === 'sim_call') {
          const target = String(step.args.contactQuery || step.args.phoneNumber || step.args.target || '').trim();
          const nativeRes = callContactViaNativeBridge(target);
          if (nativeRes) {
            appendDirectTurn(nativeRes.message);
            return;
          }
        } else if (step.tool === 'whatsapp_prepare') {
          const contact = String(step.args.contactQuery || step.args.phoneNumber || '').trim();
          const msgBody = String(step.args.message || '').trim();
          const nativeRes = prepareWhatsAppContactViaNativeBridge(contact, msgBody);
          if (nativeRes) {
            appendDirectTurn(nativeRes.message);
            return;
          }
        } else if (step.tool === 'open_app') {
          const appQuery = String(step.args.appQuery || '').trim();
          const nativeRes = launchAppDetailedViaNativeBridge(appQuery);
          if (nativeRes) {
            appendDirectTurn(nativeRes.message);
            return;
          }
        } else if (step.tool === 'screen_analyze') {
          setMessages((prev) => [
            ...prev,
            { id: clientMsgId, role: 'user', text: cleanText, timestamp: new Date(), lang: activeLanguage },
          ]);
          setAssistantState('thinking');
          try {
            const snap = captureNativeScreenSnapshot();
            const visibleText =
              snap.visibleText ||
              (typeof document !== 'undefined' ? document.body?.innerText?.slice(0, 2000) || '' : '');
            const res = await fetch(`${getApiBaseUrl()}/api/screen/analyze`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                imageBase64: snap.imageBase64,
                visibleText,
                question: cleanText,
                lang: activeLanguage,
                affectionName: selectedAffectionName,
              }),
            });
            const data = await res.json();
            const replyText = res.ok
              ? data.explanation
              : data.error || 'Could not analyze the current screen.';
            setMessages((prev) => [
              ...prev,
              { id: `${clientMsgId}-screen`, role: 'assistant', text: replyText, timestamp: new Date(), lang: activeLanguage },
            ]);
            setLatestTranscript(replyText);
          } catch {
            setLatestTranscript('Network error while analyzing the screen.');
          } finally {
            setAssistantState('idle');
          }
          return;
        } else if (step.tool === 'notification_read') {
          const list = getRecentNativeNotifications();
          const filtered = step.args.whatsappOnly ? list.filter((n) => n.isWhatsApp) : list;
          const summaryText =
            filtered.length === 0
              ? activeLanguage === 'bn-BD'
                ? `${selectedAffectionName}, এখন কোনো নতুন নোটিফিকেশন নেই অথবা অ্যান্ড্রয়েড Notification Access চালু করা নেই।`
                : `No recent notifications found, ${selectedAffectionName}. Make sure Notification Access is enabled in Android settings.`
              : filtered
                  .slice(0, 4)
                  .map((n) => `${n.appName} (${n.title}): ${n.text}`)
                  .join(' | ');
          appendDirectTurn(summaryText);
          return;
        } else if (step.tool === 'accessibility_action') {
          const cmd = String(step.args.command || '');
          const ok = performNativeAccessibilityCommand(cmd);
          appendDirectTurn(
            ok
              ? `Accessibility action "${cmd}" completed.`
              : `Please enable Zoni Accessibility Service in Android settings to perform "${cmd}".`
          );
          return;
        } else if (step.tool === 'camera_open') {
          const ok = openNativeCamera();
          appendDirectTurn(
            ok
              ? activeLanguage === 'bn-BD'
                ? `${selectedAffectionName}, ক্যামেরা চালু করা হয়েছে।`
                : `Opened your Android camera, ${selectedAffectionName}.`
              : 'Camera launch requires the native Android APK.'
          );
          return;
        } else if (step.tool === 'volume_control') {
          const volRes = adjustNativeVolume(String(step.args.action || 'status') as any);
          appendDirectTurn(volRes.message);
          return;
        }
      }

      // Direct execution fallback for web/PWA hardware intents (flashlight, numeric dial, wa.me, battery, settings)
      const detectedIntent = detectAssistantIntent(cleanText);
      if (detectedIntent) {
        if (detectedIntent.type === 'flashlight') {
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
        } else {
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

      // Check backend URL configuration before sending remote chat requests
      const configError = getBackendConfigError();
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

      // 4. Route via /api/chat immediately when Live WS is unavailable/error; otherwise send over Live WS with automatic /api/chat fallback
      const useFallbackImmediately =
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
    ]
  );

  // Replay speech audio from transcript (uses active Live WS or /api/tts fallback)
  const handleReplayAudio = async (text: string) => {
    if (vitals.soundFxEnabled) playProceduralSfx('click');
    stopAllSpeechPlayback();

    const configError = getBackendConfigError();
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

    // Fallback to HTTP /api/tts when Live WS is offline
    setAssistantState('speaking');
    try {
      const res = await fetch(`${getApiBaseUrl()}/api/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          voice: vitals.selectedVoice,
          lang: activeLanguage,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.audioBase64) {
        throw new Error(data?.error || `Audio replay unavailable (HTTP ${res.status})`);
      }
      liveAudioPlayerRef.current?.playPcmChunk(data.audioBase64, 24000);
      setTimeout(() => {
        setAssistantState(isLiveActiveRef.current ? 'listening' : 'idle');
      }, 1200);
    } catch (err: any) {
      setAssistantState(isLiveActiveRef.current ? 'listening' : 'idle');
      setConnectionError(err?.message || 'Unable to replay voice audio.');
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
    void checkBackendHealth();
    connectSharedLiveWs(true).catch(() => {
      // Surfacing via connectionError
    });
  }, [checkBackendHealth, connectSharedLiveWs]);

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

      {/* Clean Zoni Jarvis Settings Modal (Soul Core, Personality Matrix, Voice Modulator, Telemetry) */}
      <ZoniSettingsModal
        isOpen={isSettingsModalOpen}
        onClose={() => setIsSettingsModalOpen(false)}
        vitals={vitals}
        selectedAffectionName={selectedAffectionName}
        isLiveActive={isLiveActive}
        wsStatus={wsStatus}
        backendHealth={backendHealth}
        onSelectMode={handleSelectMode}
        onUpdateAffectionName={handleUpdateAffectionName}
        onSelectVoice={handleSelectVoice}
        onToggleSoundFx={handleToggleSoundFx}
        onReconnectLive={handleManualReconnectLive}
        onOpenBackendSetup={() => {
          setIsSettingsModalOpen(false);
          setIsPermissionsModalOpen(true);
        }}
      />

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
