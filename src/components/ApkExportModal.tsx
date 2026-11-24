import React, { useState, useEffect } from 'react';
import {
  X,
  Smartphone,
  PhoneCall,
  MessageSquare,
  Share2,
  Flashlight,
  Vibrate,
  BatteryCharging,
  Download,
  ShieldCheck,
  Terminal,
  CheckCircle2,
  Copy,
  Camera,
  Volume2,
  VolumeX,
  Monitor,
  Bell,
  Sparkles,
  Plus,
  Trash2,
  ArrowUp,
  ArrowDown,
  CornerUpLeft,
  Home,
} from 'lucide-react';
import {
  executeCall,
  executeSms,
  executeWhatsApp,
  toggleFlashlight,
  triggerVibration,
  getDeviceBattery,
} from '../utils/mobileAssistant';
import {
  getNativeAndroidBridge,
  captureNativeScreenSnapshot,
  getRecentNativeNotifications,
  replyToNativeNotification,
  adjustNativeVolume,
  openNativeCamera,
  performNativeAccessibilityCommand,
  NativeNotificationItem,
} from '../utils/androidBridge';
import {
  AutoReplyConfig,
  loadAutoReplyConfig,
  saveAutoReplyConfig,
} from '../utils/autoReplyRules';
import { buildServerApiUrl, sanitizeErrorText } from '../utils/apiConfig';
import { playProceduralSfx } from '../utils/audio';

interface ApkExportModalProps {
  isOpen: boolean;
  onClose: () => void;
  soundFxEnabled: boolean;
  deferredPrompt: any;
  onInstallPwa: () => void;
  selectedAffectionName?: string;
}

export const ApkExportModal: React.FC<ApkExportModalProps> = ({
  isOpen,
  onClose,
  soundFxEnabled,
  deferredPrompt,
  onInstallPwa,
  selectedAffectionName,
}) => {
  const currentAffection = selectedAffectionName || 'Boss';
  const [activeTab, setActiveTab] = useState<'apk' | 'actions' | 'permissions'>('apk');
  const [testNumber, setTestNumber] = useState('01700000000');
  const [testMsg, setTestMsg] = useState(`Hello ${currentAffection}, Zoni Assistant is active! ❤️`);
  const [torchActive, setTorchActive] = useState(false);
  const [batteryInfo, setBatteryInfo] = useState<{ level: number; charging: boolean } | null>(null);
  const [copiedCode, setCopiedCode] = useState(false);

  // Extended Native Android Assistant state (Screen Awareness, Notifications, Smart Reply, Auto-Reply Rules)
  const [actionFeedback, setActionFeedback] = useState<string>('');
  const [screenAnalysis, setScreenAnalysis] = useState<string>('');
  const [isAnalyzingScreen, setIsAnalyzingScreen] = useState(false);
  const [notifications, setNotifications] = useState<NativeNotificationItem[]>([]);
  const [smartReplies, setSmartReplies] = useState<{
    key: string;
    summary: string;
    options: string[];
  } | null>(null);
  const [isGeneratingReply, setIsGeneratingReply] = useState(false);
  const [autoReplyConfig, setAutoReplyConfig] = useState<AutoReplyConfig>(() => loadAutoReplyConfig());
  const [newRuleKeyword, setNewRuleKeyword] = useState('');
  const [newRuleSender, setNewRuleSender] = useState('');
  const [newRuleReply, setNewRuleReply] = useState('');

  useEffect(() => {
    setTestMsg(`Hello ${selectedAffectionName || 'Boss'}, Zoni Assistant is active! ❤️`);
  }, [selectedAffectionName]);

  useEffect(() => {
    if (isOpen) {
      getDeviceBattery().then((res) => {
        if (res) setBatteryInfo(res);
      });
      setNotifications(getRecentNativeNotifications());
      setAutoReplyConfig(loadAutoReplyConfig());
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleTorchToggle = async () => {
    if (soundFxEnabled) playProceduralSfx('click');
    const newState = !torchActive;
    const success = await toggleFlashlight(newState);
    if (success || !newState) {
      setTorchActive(newState);
    }
  };

  const handleVibrateTest = () => {
    if (soundFxEnabled) playProceduralSfx('heartbeat');
    triggerVibration([200, 100, 300]);
  };

  const handleCopyCli = () => {
    const cliCommands = `# Build Genuine Native Android APK (Kotlin + Jetpack Compose)
cd android
./gradlew assembleDebug

# Output APK Location:
# android/app/build/outputs/apk/debug/app-debug.apk

# Install directly onto connected Android phone via ADB:
adb install -r app/build/outputs/apk/debug/app-debug.apk`;
    navigator.clipboard.writeText(cliCommands);
    setCopiedCode(true);
    if (soundFxEnabled) playProceduralSfx('click');
    setTimeout(() => setCopiedCode(false), 2500);
  };

  const handleAnalyzeScreen = async () => {
    if (soundFxEnabled) playProceduralSfx('click');
    setIsAnalyzingScreen(true);
    setActionFeedback('');
    try {
      const snap = captureNativeScreenSnapshot();
      const visibleText =
        snap.visibleText ||
        (typeof document !== 'undefined' ? document.body?.innerText?.slice(0, 2000) || '' : '');
      const res = await fetch(buildServerApiUrl('/api/screen/analyze'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageBase64: snap.imageBase64,
          visibleText,
          affectionName: currentAffection,
          lang: 'bn-BD',
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setScreenAnalysis(data?.error || `Screen analysis failed (HTTP ${res.status}).`);
        return;
      }
      setScreenAnalysis(data?.explanation || 'Screen analyzed.');
    } catch (err) {
      setScreenAnalysis(sanitizeErrorText(err) || 'Could not analyze screen.');
    } finally {
      setIsAnalyzingScreen(false);
    }
  };

  const handleRequestScreenConsent = () => {
    if (soundFxEnabled) playProceduralSfx('click');
    const bridge = getNativeAndroidBridge();
    if (bridge?.requestScreenCaptureConsent) {
      bridge.requestScreenCaptureConsent();
      setActionFeedback('Requested transparent Android MediaProjection consent.');
    } else {
      setActionFeedback('MediaProjection runs inside the native Android APK; web preview analyzes visible DOM text.');
    }
  };

  const handleRefreshNotifications = () => {
    if (soundFxEnabled) playProceduralSfx('click');
    const list = getRecentNativeNotifications();
    setNotifications(list);
    setActionFeedback(
      list.length > 0
        ? `Loaded ${list.length} recent Android notifications.`
        : 'No notifications captured yet. Enable Notification Access inside Android Settings.'
    );
  };

  const handleGenerateSmartReply = async (item: NativeNotificationItem) => {
    if (soundFxEnabled) playProceduralSfx('click');
    setIsGeneratingReply(true);
    try {
      const res = await fetch(buildServerApiUrl('/api/notifications/smart-reply'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sender: item.title,
          message: item.text,
          appName: item.appName,
          affectionName: currentAffection,
          lang: 'bn-BD',
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setActionFeedback(data?.error || `Failed to generate Smart Replies (HTTP ${res.status}).`);
        return;
      }
      setSmartReplies({
        key: item.key,
        summary: data?.summary || `${item.title}: ${item.text}`,
        options: Array.isArray(data?.suggestedReplies) ? data.suggestedReplies : [],
      });
    } catch (err) {
      setActionFeedback(sanitizeErrorText(err) || 'Failed to generate Smart Replies.');
    } finally {
      setIsGeneratingReply(false);
    }
  };

  const handleSendApprovedReply = (notificationKey: string, replyText: string) => {
    if (soundFxEnabled) playProceduralSfx('click');
    const sent = replyToNativeNotification(notificationKey, replyText);
    setActionFeedback(
      sent
        ? 'Approved reply sent via official Android Notification Reply action.'
        : 'Notification reply action is unavailable or expired.'
    );
  };

  const updateAutoReply = (next: AutoReplyConfig) => {
    setAutoReplyConfig(next);
    saveAutoReplyConfig(next);
  };

  const handleAddAutoReplyRule = () => {
    const replyText = newRuleReply.trim();
    if (!replyText) return;
    if (soundFxEnabled) playProceduralSfx('click');
    const next: AutoReplyConfig = {
      ...autoReplyConfig,
      rules: [
        ...autoReplyConfig.rules,
        {
          id: `rule_${Date.now()}`,
          enabled: true,
          keyword: newRuleKeyword.trim(),
          senderFilter: newRuleSender.trim(),
          replyText,
          whatsappOnly: true,
        },
      ],
    };
    updateAutoReply(next);
    setNewRuleKeyword('');
    setNewRuleSender('');
    setNewRuleReply('');
    setActionFeedback('Auto-reply rule saved.');
  };

  return (
    <div className="zoni-modal-backdrop bg-black/75 backdrop-blur-md" role="dialog" aria-modal="true" aria-label="Android Native APK and Assistant Hub">
      <div className="zoni-modal-card max-w-2xl bg-slate-950 border border-cyan-500/40 rounded-2xl shadow-[0_0_60px_rgba(6,182,212,0.3)] animate-in fade-in zoom-in-95 duration-200">
        {/* Header */}
        <div className="shrink-0 flex items-center justify-between p-4 sm:p-5 border-b border-cyan-500/20 bg-slate-900/60">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 shrink-0 rounded-xl bg-cyan-950/80 border border-cyan-400/50 flex items-center justify-center text-cyan-400">
              <Smartphone className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <h2 className="font-sci-fi text-base font-bold text-cyan-200 tracking-wide truncate">
                ANDROID NATIVE APK &amp; ASSISTANT HUB
              </h2>
              <p className="text-xs font-hud text-pink-400 truncate">
                পূর্ণাঙ্গ নেটিভ Android Kotlin/Compose অ্যাপ এবং মোবাইল অ্যাসিস্ট্যান্ট (APK)
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close Android Hub"
            className="shrink-0 p-1.5 rounded-lg border border-cyan-500/30 text-cyan-400 hover:bg-cyan-950/50 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tab Switcher */}
        <div className="shrink-0 flex border-b border-cyan-500/20 bg-slate-900/30 px-4 pt-2 gap-2 text-xs font-hud tracking-wider overflow-x-auto">
          <button
            type="button"
            onClick={() => setActiveTab('apk')}
            className={`pb-2.5 px-3 font-semibold border-b-2 transition-all shrink-0 ${
              activeTab === 'apk'
                ? 'border-cyan-400 text-cyan-300'
                : 'border-transparent text-slate-400 hover:text-cyan-200'
            }`}
          >
            📱 1. BUILD APK / INSTALL
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('actions')}
            className={`pb-2.5 px-3 font-semibold border-b-2 transition-all shrink-0 ${
              activeTab === 'actions'
                ? 'border-pink-400 text-pink-300'
                : 'border-transparent text-slate-400 hover:text-pink-200'
            }`}
          >
            ⚡ 2. MOBILE ASSISTANT ACTIONS
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('permissions')}
            className={`pb-2.5 px-3 font-semibold border-b-2 transition-all shrink-0 ${
              activeTab === 'permissions'
                ? 'border-amber-400 text-amber-300'
                : 'border-transparent text-slate-400 hover:text-amber-200'
            }`}
          >
            🛡️ 3. ANDROID PERMISSIONS
          </button>
        </div>

        {/* Tab Body */}
        <div className="zoni-modal-scroll p-4 sm:p-6 space-y-4">
          {activeTab === 'apk' && (
            <div className="space-y-4">
              {/* Build Metadata & GitHub Actions Pipeline Banner */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px] font-mono">
                <div className="p-2.5 rounded-lg bg-slate-900/80 border border-cyan-500/25">
                  <div className="text-[9px] text-slate-400">PACKAGE ID</div>
                  <div className="text-cyan-300 font-bold truncate">com.zoni.jarvis.assistant</div>
                </div>
                <div className="p-2.5 rounded-lg bg-slate-900/80 border border-cyan-500/25">
                  <div className="text-[9px] text-slate-400">VERSION</div>
                  <div className="text-pink-300 font-bold">v1.0.0 (SDK 26–34)</div>
                </div>
                <div className="p-2.5 rounded-lg bg-slate-900/80 border border-cyan-500/25">
                  <div className="text-[9px] text-slate-400">CI WORKFLOW</div>
                  <div className="text-emerald-300 font-bold truncate">android-build.yml</div>
                </div>
                <div className="p-2.5 rounded-lg bg-slate-900/80 border border-cyan-500/25">
                  <div className="text-[9px] text-slate-400">BUILD TIME</div>
                  <div className="text-cyan-200 font-bold truncate">
                    {new Date().toISOString().slice(0, 10)}
                  </div>
                </div>
              </div>

              {/* Option A: Automated GitHub Actions APK & AAB Build */}
              <div className="p-4 rounded-xl bg-gradient-to-r from-cyan-950/60 to-slate-900/90 border border-cyan-400/50 space-y-3">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <span className="font-hud text-sm font-bold text-cyan-200 flex items-center gap-2">
                    <Terminal className="w-4 h-4 text-cyan-400" />
                    ১. জেনুইন নেটিভ Android APK &amp; AAB (GitHub Actions / Gradle)
                  </span>
                  <button
                    onClick={handleCopyCli}
                    className="flex items-center gap-1 text-[11px] font-mono text-cyan-300 hover:text-cyan-100 px-2 py-0.5 rounded bg-cyan-950/80 border border-cyan-500/40"
                  >
                    {copiedCode ? (
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                    ) : (
                      <Copy className="w-3.5 h-3.5" />
                    )}
                    <span>{copiedCode ? 'COPIED!' : 'COPY BUILD CLI'}</span>
                  </button>
                </div>
                <p className="text-xs text-slate-300 leading-relaxed">
                  মূল ZONI AI React ড্যাশবোর্ডটি সম্পূর্ণ অক্ষত রেখেই নেটিভ Android শেলের (<code>WebViewAssetLoader</code> +{' '}
                  <code>ZoniWebAppInterface</code> + Kotlin Telecom/SIM/Room DB/Camera2/Foreground Service) ভেতরে প্যাকেজ করা হয়েছে।
                  GitHub-এ পুশ করলে <code>.github/workflows/android-build.yml</code> স্বয়ংক্রিয়ভাবে আসল APK তৈরি করে:
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-[10px] font-mono">
                  <div className="p-2 rounded-lg bg-black/60 border border-cyan-500/30">
                    <div className="text-cyan-300 font-bold">DEBUG APK (NO SIGNING)</div>
                    <div className="text-slate-400 break-all mt-0.5">
                      android/app/build/outputs/apk/debug/app-debug.apk
                    </div>
                  </div>
                  <div className="p-2 rounded-lg bg-black/60 border border-pink-500/30">
                    <div className="text-pink-300 font-bold">SIGNED RELEASE APK</div>
                    <div className="text-slate-400 break-all mt-0.5">
                      android/app/build/outputs/apk/release/app-release.apk
                    </div>
                  </div>
                  <div className="p-2 rounded-lg bg-black/60 border border-emerald-500/30">
                    <div className="text-emerald-300 font-bold">PLAY STORE AAB</div>
                    <div className="text-slate-400 break-all mt-0.5">
                      android/app/build/outputs/bundle/release/app-release.aab
                    </div>
                  </div>
                </div>
                <pre className="p-3 rounded-lg bg-black/80 border border-cyan-500/30 text-[11px] font-mono text-cyan-300 overflow-x-auto leading-relaxed">
{`# 1. Build React Dashboard & Sync into Android Assets
npm run android:sync

# 2. Build Real Debug APK (JDK 17 + Android SDK 34)
cd android && ./gradlew assembleDebug

# 3. Install onto Android Phone via USB / ADB
adb install -r app/build/outputs/apk/debug/app-debug.apk`}
                </pre>
                <div className="text-[11px] text-pink-200 bg-pink-950/35 p-2.5 rounded-lg border border-pink-500/30">
                  💡 <strong>GitHub Actions:</strong> Repository &gt; <strong>Actions</strong> &gt;{' '}
                  <strong>ZONI AI Android APK Build</strong> &gt; Artifacts থেকে সরাসরি{' '}
                  <code>ZONI-AI-Debug-APK</code> বা <code>ZONI-AI-Release-APK</code> ডাউনলোড করে অ্যান্ড্রয়েডে ইনস্টল করুন।
                </div>
              </div>

              {/* Option B: Browser Home-Screen Shortcut (Explicitly NOT equivalent to Native APK) */}
              <div className="p-4 rounded-xl bg-slate-900/60 border border-amber-500/30 space-y-2.5">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <span className="font-hud text-sm font-bold text-amber-200 flex items-center gap-2">
                    <Download className="w-4 h-4 text-amber-400" />
                    ২. ব্রাউজার ওয়েব শর্টকাট (PWA — নেটিভ APK নয়)
                  </span>
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-amber-950 border border-amber-500/40 text-amber-300">
                    WEB SHORTCUT ONLY
                  </span>
                </div>
                <p className="text-xs text-slate-300 leading-relaxed">
                  <strong>গুরুত্বপূর্ণ পার্থক্য:</strong> এটি শুধুমাত্র ব্রাউজার শর্টকাট — এতে নেটিভ Android Telecom,
                  Room DB, Floating Orb বা Foreground Service কাজ করবে না। সম্পূর্ণ অ্যান্ড্রয়েড ফিচারের জন্য উপরের
                  <strong> জেনুইন নেটিভ Android APK</strong> ইনস্টল করুন।
                </p>
                <button
                  onClick={onInstallPwa}
                  className="w-full py-2 px-3 rounded-lg bg-slate-800 hover:bg-slate-700 border border-amber-500/40 text-amber-200 font-hud text-xs font-bold tracking-wider uppercase flex items-center justify-center gap-2"
                >
                  <Smartphone className="w-3.5 h-3.5" />
                  <span>
                    {deferredPrompt ? 'ADD BROWSER SHORTCUT (PWA)' : 'BROWSER HOME SCREEN SHORTCUT'}
                  </span>
                </button>
              </div>
            </div>
          )}

          {activeTab === 'actions' && (
            <div className="space-y-4">
              <p className="text-xs text-slate-300 leading-relaxed">
                আপনার মোবাইল ডিভাইস থেকে সরাসরি কল, মেসেজ বা হার্ডওয়্যার ফিচার টেস্ট করুন (Zoni এআই ভয়েস কমান্ড দিয়েও চালানো যাবে):
              </p>

              {/* Input for testing */}
              <div className="p-3 rounded-xl bg-slate-900/50 border border-cyan-500/20 space-y-2">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <div>
                    <label className="text-[10px] font-mono text-cyan-400">PHONE NUMBER / ফোন নম্বর</label>
                    <input
                      type="text"
                      value={testNumber}
                      onChange={(e) => setTestNumber(e.target.value)}
                      placeholder="e.g. 01700000000"
                      className="w-full mt-1 px-3 py-1.5 rounded-lg bg-slate-950 border border-cyan-500/30 text-xs text-cyan-100 font-mono focus:outline-none focus:border-cyan-400"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] font-mono text-pink-400">MESSAGE / বার্তা</label>
                    <input
                      type="text"
                      value={testMsg}
                      onChange={(e) => setTestMsg(e.target.value)}
                      placeholder="Type a message..."
                      className="w-full mt-1 px-3 py-1.5 rounded-lg bg-slate-950 border border-pink-500/30 text-xs text-pink-100 focus:outline-none focus:border-pink-400"
                    />
                  </div>
                </div>
              </div>

              {/* Action Buttons Matrix */}
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
                <button
                  onClick={() => {
                    if (soundFxEnabled) playProceduralSfx('click');
                    executeCall(testNumber);
                  }}
                  className="p-3 rounded-xl bg-slate-900/60 border border-cyan-500/30 hover:border-cyan-400 text-left flex flex-col gap-1 transition-all group"
                >
                  <PhoneCall className="w-5 h-5 text-cyan-400 group-hover:scale-110 transition-transform" />
                  <span className="font-hud font-bold text-xs text-cyan-200">DIRECT CALL</span>
                  <span className="text-[10px] text-slate-400">সরাসরি ফোন কল</span>
                </button>

                <button
                  onClick={() => {
                    if (soundFxEnabled) playProceduralSfx('click');
                    executeWhatsApp(testNumber, testMsg);
                  }}
                  className="p-3 rounded-xl bg-slate-900/60 border border-emerald-500/30 hover:border-emerald-400 text-left flex flex-col gap-1 transition-all group"
                >
                  <Share2 className="w-5 h-5 text-emerald-400 group-hover:scale-110 transition-transform" />
                  <span className="font-hud font-bold text-xs text-emerald-200">WHATSAPP</span>
                  <span className="text-[10px] text-slate-400">হোয়াটসঅ্যাপ বার্তা</span>
                </button>

                <button
                  onClick={() => {
                    if (soundFxEnabled) playProceduralSfx('click');
                    executeSms(testNumber, testMsg);
                  }}
                  className="p-3 rounded-xl bg-slate-900/60 border border-pink-500/30 hover:border-pink-400 text-left flex flex-col gap-1 transition-all group"
                >
                  <MessageSquare className="w-5 h-5 text-pink-400 group-hover:scale-110 transition-transform" />
                  <span className="font-hud font-bold text-xs text-pink-200">SMS MESSENGER</span>
                  <span className="text-[10px] text-slate-400">এসএমএস পাঠান</span>
                </button>

                <button
                  onClick={handleTorchToggle}
                  className={`p-3 rounded-xl border text-left flex flex-col gap-1 transition-all group ${
                    torchActive
                      ? 'bg-amber-950/60 border-amber-400 text-amber-200 shadow-[0_0_15px_rgba(245,158,11,0.4)]'
                      : 'bg-slate-900/60 border-cyan-500/30 text-slate-300 hover:border-cyan-400'
                  }`}
                >
                  <Flashlight className="w-5 h-5 text-amber-400 group-hover:scale-110 transition-transform" />
                  <span className="font-hud font-bold text-xs">
                    {torchActive ? 'TORCH ON' : 'TORCH OFF'}
                  </span>
                  <span className="text-[10px] text-slate-400">ফ্ল্যাশলাইট কন্ট্রোল</span>
                </button>

                <button
                  onClick={handleVibrateTest}
                  className="p-3 rounded-xl bg-slate-900/60 border border-cyan-500/30 hover:border-cyan-400 text-left flex flex-col gap-1 transition-all group"
                >
                  <Vibrate className="w-5 h-5 text-purple-400 group-hover:scale-110 transition-transform" />
                  <span className="font-hud font-bold text-xs text-purple-200">HAPTIC VIBRATE</span>
                  <span className="text-[10px] text-slate-400">মোবাইল ভাইব্রেশন</span>
                </button>

                <div className="p-3 rounded-xl bg-slate-900/60 border border-cyan-500/30 text-left flex flex-col gap-1">
                  <BatteryCharging className="w-5 h-5 text-emerald-400" />
                  <span className="font-hud font-bold text-xs text-emerald-200">
                    BATTERY: {batteryInfo ? `${batteryInfo.level}%` : 'ONLINE'}
                  </span>
                  <span className="text-[10px] text-slate-400">
                    {batteryInfo?.charging ? 'Charging' : 'Normal'}
                  </span>
                </div>
              </div>

              {actionFeedback && (
                <div className="p-2.5 rounded-lg bg-cyan-950/60 border border-cyan-500/40 text-xs text-cyan-200 font-hud">
                  {actionFeedback}
                </div>
              )}

              {/* Camera, Volume & Accessibility Controls */}
              <div className="p-3.5 rounded-xl bg-slate-900/60 border border-cyan-500/25 space-y-2.5">
                <div className="text-[11px] font-hud font-bold text-cyan-300 uppercase tracking-wider">
                  Device, Camera, Volume &amp; Accessibility Control
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={() => {
                      const ok = openNativeCamera();
                      setActionFeedback(ok ? 'Opened Android Camera.' : 'Camera intent runs inside native Android APK.');
                    }}
                    className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-cyan-500/30 text-xs text-cyan-200 flex items-center gap-1.5"
                  >
                    <Camera className="w-3.5 h-3.5 text-cyan-400" />
                    <span>Open Camera</span>
                  </button>
                  <button
                    onClick={() => setActionFeedback(adjustNativeVolume('up').message)}
                    className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-cyan-500/30 text-xs text-cyan-200 flex items-center gap-1"
                  >
                    <Volume2 className="w-3.5 h-3.5 text-emerald-400" />
                    <span>Vol +</span>
                  </button>
                  <button
                    onClick={() => setActionFeedback(adjustNativeVolume('down').message)}
                    className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-cyan-500/30 text-xs text-cyan-200 flex items-center gap-1"
                  >
                    <Volume2 className="w-3.5 h-3.5 text-amber-400" />
                    <span>Vol -</span>
                  </button>
                  <button
                    onClick={() => setActionFeedback(adjustNativeVolume('mute').message)}
                    className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-cyan-500/30 text-xs text-cyan-200 flex items-center gap-1"
                  >
                    <VolumeX className="w-3.5 h-3.5 text-pink-400" />
                    <span>Mute</span>
                  </button>
                  <button
                    onClick={() =>
                      setActionFeedback(
                        performNativeAccessibilityCommand('scroll_up')
                          ? 'Scrolled up via Accessibility.'
                          : 'Enable Zoni Accessibility Service on Android to scroll.'
                      )
                    }
                    className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-pink-500/30 text-xs text-pink-200 flex items-center gap-1"
                  >
                    <ArrowUp className="w-3.5 h-3.5" />
                    <span>Scroll Up</span>
                  </button>
                  <button
                    onClick={() =>
                      setActionFeedback(
                        performNativeAccessibilityCommand('scroll_down')
                          ? 'Scrolled down via Accessibility.'
                          : 'Enable Zoni Accessibility Service on Android to scroll.'
                      )
                    }
                    className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-pink-500/30 text-xs text-pink-200 flex items-center gap-1"
                  >
                    <ArrowDown className="w-3.5 h-3.5" />
                    <span>Scroll Down</span>
                  </button>
                  <button
                    onClick={() =>
                      setActionFeedback(
                        performNativeAccessibilityCommand('back')
                          ? 'Triggered Android Back.'
                          : 'Enable Zoni Accessibility Service on Android.'
                      )
                    }
                    className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-pink-500/30 text-xs text-pink-200 flex items-center gap-1"
                  >
                    <CornerUpLeft className="w-3.5 h-3.5" />
                    <span>Back</span>
                  </button>
                  <button
                    onClick={() =>
                      setActionFeedback(
                        performNativeAccessibilityCommand('home')
                          ? 'Navigated to Home.'
                          : 'Enable Zoni Accessibility Service on Android.'
                      )
                    }
                    className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-pink-500/30 text-xs text-pink-200 flex items-center gap-1"
                  >
                    <Home className="w-3.5 h-3.5" />
                    <span>Home</span>
                  </button>
                </div>
              </div>

              {/* Screen Awareness (User-Authorized MediaProjection + Gemini Multimodal) */}
              <div className="p-3.5 rounded-xl bg-slate-900/60 border border-cyan-500/25 space-y-2.5">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <span className="text-xs font-hud font-bold text-cyan-200 flex items-center gap-1.5">
                    <Monitor className="w-4 h-4 text-cyan-400" />
                    Screen Awareness (MediaProjection + Gemini)
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={handleRequestScreenConsent}
                      className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 border border-cyan-500/40 text-[11px] font-hud text-cyan-200"
                    >
                      Authorize Screen
                    </button>
                    <button
                      onClick={handleAnalyzeScreen}
                      disabled={isAnalyzingScreen}
                      className="px-2.5 py-1 rounded-lg bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 text-[11px] font-hud font-bold text-white"
                    >
                      {isAnalyzingScreen ? 'Analyzing...' : 'Explain Screen'}
                    </button>
                  </div>
                </div>
                {screenAnalysis && (
                  <p className="text-xs text-slate-200 bg-slate-950/70 p-2.5 rounded-lg border border-cyan-500/20 leading-relaxed">
                    {screenAnalysis}
                  </p>
                )}
              </div>

              {/* Notification Reader & WhatsApp Smart Reply */}
              <div className="p-3.5 rounded-xl bg-slate-900/60 border border-emerald-500/25 space-y-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-hud font-bold text-emerald-200 flex items-center gap-1.5">
                    <Bell className="w-4 h-4 text-emerald-400" />
                    Notifications &amp; Smart Reply
                  </span>
                  <button
                    onClick={handleRefreshNotifications}
                    className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 border border-emerald-500/40 text-[11px] font-hud text-emerald-200"
                  >
                    Read Recent
                  </button>
                </div>

                {notifications.length === 0 ? (
                  <p className="text-[11px] text-slate-400">
                    Incoming WhatsApp/SMS notifications captured via Notification Access appear here with Gemini Smart Reply options.
                  </p>
                ) : (
                  <div className="space-y-2 max-h-40 overflow-y-auto">
                    {notifications.slice(0, 5).map((item) => (
                      <div
                        key={item.key}
                        className="p-2.5 rounded-lg bg-slate-950/70 border border-emerald-500/20 space-y-1.5"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs font-bold text-cyan-200 truncate">
                            {item.appName} — {item.title}
                          </span>
                          <button
                            onClick={() => handleGenerateSmartReply(item)}
                            disabled={isGeneratingReply}
                            className="px-2 py-0.5 rounded bg-pink-600/80 hover:bg-pink-500 text-[10px] font-hud text-white flex items-center gap-1 shrink-0"
                          >
                            <Sparkles className="w-3 h-3" />
                            <span>Smart Reply</span>
                          </button>
                        </div>
                        <p className="text-[11px] text-slate-300">{item.text}</p>
                        {smartReplies && smartReplies.key === item.key && (
                          <div className="pt-1 space-y-1">
                            <p className="text-[11px] text-emerald-300">{smartReplies.summary}</p>
                            <div className="flex flex-wrap gap-1.5">
                              {smartReplies.options.map((opt, idx) => (
                                <button
                                  key={idx}
                                  onClick={() => handleSendApprovedReply(item.key, opt)}
                                  className="px-2 py-1 rounded bg-emerald-950/80 hover:bg-emerald-900 border border-emerald-500/40 text-[11px] text-emerald-200 text-left"
                                >
                                  Send: {opt}
                                </button>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Rule-Based Auto Reply (Explicit User Opt-In Only) */}
              <div className="p-3.5 rounded-xl bg-slate-900/60 border border-pink-500/25 space-y-2.5">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <span className="text-xs font-hud font-bold text-pink-200 block">
                      Rule-Based Auto Reply (WhatsApp / Notification)
                    </span>
                    <span className="text-[10px] text-slate-400">
                      Off by default. Replies via official Android Notification RemoteInput only when enabled.
                    </span>
                  </div>
                  <button
                    onClick={() =>
                      updateAutoReply({ ...autoReplyConfig, enabled: !autoReplyConfig.enabled })
                    }
                    className={`px-3 py-1 rounded-lg text-[11px] font-hud font-bold border transition-all ${
                      autoReplyConfig.enabled
                        ? 'bg-emerald-950/80 border-emerald-400 text-emerald-300'
                        : 'bg-slate-800 border-slate-600 text-slate-300'
                    }`}
                  >
                    {autoReplyConfig.enabled ? 'AUTO-REPLY ON' : 'AUTO-REPLY OFF'}
                  </button>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  <input
                    type="text"
                    value={newRuleKeyword}
                    onChange={(e) => setNewRuleKeyword(e.target.value)}
                    placeholder="Keyword (e.g. busy / কোথায়)"
                    aria-label="Auto-reply keyword"
                    className="px-2.5 py-1.5 rounded-lg bg-slate-950 border border-cyan-500/30 text-xs text-cyan-100"
                  />
                  <input
                    type="text"
                    value={newRuleSender}
                    onChange={(e) => setNewRuleSender(e.target.value)}
                    placeholder="Sender filter (optional)"
                    aria-label="Auto-reply sender filter"
                    className="px-2.5 py-1.5 rounded-lg bg-slate-950 border border-cyan-500/30 text-xs text-cyan-100"
                  />
                  <div className="flex gap-1.5">
                    <input
                      type="text"
                      value={newRuleReply}
                      onChange={(e) => setNewRuleReply(e.target.value)}
                      placeholder="Auto reply text"
                      aria-label="Auto-reply response text"
                      className="flex-1 min-w-0 px-2.5 py-1.5 rounded-lg bg-slate-950 border border-pink-500/30 text-xs text-pink-100"
                    />
                    <button
                      onClick={handleAddAutoReplyRule}
                      aria-label="Add auto-reply rule"
                      className="px-2.5 py-1.5 rounded-lg bg-pink-600 hover:bg-pink-500 text-white"
                    >
                      <Plus className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                <div className="space-y-1.5">
                  {autoReplyConfig.rules.map((rule) => (
                    <div
                      key={rule.id}
                      className="flex items-center justify-between gap-2 p-2 rounded-lg bg-slate-950/70 border border-slate-800 text-[11px]"
                    >
                      <div className="min-w-0">
                        <span className="text-cyan-300 font-mono">
                          {rule.keyword ? `If "${rule.keyword}"` : 'Any message'}
                          {rule.senderFilter ? ` from ${rule.senderFilter}` : ''}
                        </span>
                        <span className="text-slate-400"> → </span>
                        <span className="text-pink-200">{rule.replyText}</span>
                      </div>
                      <button
                        onClick={() =>
                          updateAutoReply({
                            ...autoReplyConfig,
                            rules: autoReplyConfig.rules.filter((r) => r.id !== rule.id),
                          })
                        }
                        aria-label={`Delete rule ${rule.keyword || rule.id}`}
                        className="p-1 text-slate-400 hover:text-rose-400 shrink-0"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {activeTab === 'permissions' && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 p-2.5 rounded-lg bg-emerald-950/40 border border-emerald-500/30 text-emerald-300 text-xs">
                <ShieldCheck className="w-4 h-4 shrink-0" />
                <span>
                  প্রজেক্টের <code>AndroidManifest.xml</code>-এ সকল প্রয়োজনীয় পারমিশন কনফিগার করা আছে:
                </span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs font-mono">
                {[
                  { name: 'RECORD_AUDIO', desc: 'Gemini লাইভ অডিও রেকর্ডিং' },
                  { name: 'CALL_PHONE', desc: 'সরাসরি সিম ফোন কল করার পারমিশন' },
                  { name: 'SEND_SMS', desc: 'সরাসরি মেসেজ পাঠানো' },
                  { name: 'READ_CONTACTS', desc: 'কন্টাক্ট লিস্ট যাচাই (SIM ও WhatsApp)' },
                  { name: 'CAMERA & FLASHLIGHT', desc: 'ক্যামেরা ও মোবাইল ফ্ল্যাশলাইট অন/অফ' },
                  { name: 'FOREGROUND_SERVICE_MEDIA_PROJECTION', desc: 'ইউজার-অনুমোদিত স্ক্রিন অ্যাওয়ারনেস' },
                  { name: 'BIND_NOTIFICATION_LISTENER_SERVICE', desc: 'নোটিফিকেশন পড়া ও অফিসিয়াল স্মার্ট রিপ্লাই' },
                  { name: 'BIND_ACCESSIBILITY_SERVICE', desc: 'স্ক্রল, ব্যাক, ট্যাপ ও ভিজিবল স্ক্রিন রিডিং' },
                  { name: 'SYSTEM_ALERT_WINDOW', desc: 'অন্যান্য অ্যাপের উপর ফ্লোটিং অ্যাসিস্ট্যান্ট' },
                  { name: 'VIBRATE', desc: 'হ্যাপটিক ভাইব্রেশন ফিডব্যাক' },
                  { name: 'POST_NOTIFICATIONS', desc: 'সিস্টেম নোটিফিকেশন অ্যালার্ট' },
                  { name: 'WHATSAPP QUERIES', desc: 'অফিশিয়াল হোয়াটসঅ্যাপ ইন্টেন্ট হ্যান্ডলিং' },
                ].map((item, idx) => (
                  <div
                    key={idx}
                    className="p-2.5 rounded-lg bg-slate-900/60 border border-cyan-500/20 flex flex-col"
                  >
                    <span className="text-cyan-300 font-bold">{item.name}</span>
                    <span className="text-[11px] text-slate-400 font-sans mt-0.5">{item.desc}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="shrink-0 p-3 sm:p-4 border-t border-cyan-500/20 bg-slate-900/60 flex items-center justify-between gap-2">
          <span className="text-[11px] font-hud text-cyan-400/80 truncate">
            ZONI JARVIS ASSISTANT // ANDROID NATIVE READY
          </span>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 px-4 py-1.5 rounded-lg bg-cyan-600/80 hover:bg-cyan-500 text-white font-hud text-xs tracking-wider"
          >
            CLOSE
          </button>
        </div>
      </div>
    </div>
  );
};
