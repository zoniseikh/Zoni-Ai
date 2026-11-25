import React, { useState, useEffect } from 'react';
import { CompanionMode, SystemVitals } from '../types';
import { playProceduralSfx } from '../utils/audio';
import { PREDEFINED_AFFECTION_OPTIONS } from './GfStatusPanel';
import { WsConnectionStatus } from '../utils/liveSessionProtocol';
import {
  deleteGeminiApiKey,
  getGeminiApiKeyForRequest,
  getGeminiApiKeyStatus,
  saveGeminiApiKey,
  type ServerHealthSnapshot,
} from '../utils/apiConfig';
import { verifyDirectGeminiApiKey } from '../utils/geminiDirectClient';
import type { DeviceActionDiagnosticsState } from '../utils/liveToolRelay';
import { ASSISTANT_TOOL_SPECS } from '../utils/assistantActionRegistry';
import type { WakeWordStatusSnapshot, VoiceLifecycleState } from '../utils/voiceLifecycle';
import {
  X,
  Settings,
  Heart,
  Shield,
  Moon,
  Smile,
  Mic,
  Mic2,
  Radio,
  Check,
  Edit2,
  Volume2,
  VolumeX,
  RefreshCw,
  AlertTriangle,
  Activity,
  ExternalLink,
  Power,
  Battery,
  Bell,
  Play,
  Square,
  ShieldCheck,
  Save,
  Key,
  Eye,
  EyeOff,
  Trash2,
} from 'lucide-react';

export type GeminiConnectionSnapshot = ServerHealthSnapshot;
export type BackendHealthSnapshot = ServerHealthSnapshot;

interface ZoniSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  vitals: SystemVitals;
  selectedAffectionName: string;
  isLiveActive: boolean;
  wsStatus?: WsConnectionStatus;
  backendHealth?: GeminiConnectionSnapshot | null;
  deviceDiagnostics?: DeviceActionDiagnosticsState;
  onSelectMode: (mode: CompanionMode) => void;
  onUpdateAffectionName: (name: string) => void;
  onSelectVoice: (voice: string) => void;
  onToggleSoundFx?: () => void;
  onReconnectLive?: () => void;
  onOpenBackendSetup?: () => void;
  onRefreshDiagnostics?: () => void;
  onOpenAccessibilitySettings?: () => void;
  onGeminiKeyChanged?: () => void;
  wakeWordStatus?: WakeWordStatusSnapshot | null;
  voiceLifecycleState?: VoiceLifecycleState;
  onStartBackgroundWakeWord?: () => void;
  onStopBackgroundWakeWord?: () => void;
  onUpdateWakePhrase?: (phrase: string) => void;
  onToggleLiveMode?: () => void;
  onOpenBatterySettings?: () => void;
  onRequestMicPermission?: () => void;
}

export const ZoniSettingsModal: React.FC<ZoniSettingsModalProps> = ({
  isOpen,
  onClose,
  vitals,
  selectedAffectionName,
  isLiveActive,
  wsStatus = 'disconnected',
  backendHealth,
  deviceDiagnostics,
  onSelectMode,
  onUpdateAffectionName,
  onSelectVoice,
  onToggleSoundFx,
  onReconnectLive,
  onOpenBackendSetup,
  onRefreshDiagnostics,
  onOpenAccessibilitySettings,
  onGeminiKeyChanged,
  wakeWordStatus,
  voiceLifecycleState = 'IDLE',
  onStartBackgroundWakeWord,
  onStopBackgroundWakeWord,
  onUpdateWakePhrase,
  onToggleLiveMode,
  onOpenBatterySettings,
  onRequestMicPermission,
}) => {
  const [isEditingCustom, setIsEditingCustom] = useState(false);
  const [customInput, setCustomInput] = useState(selectedAffectionName || 'Boss');
  const [wakePhraseInput, setWakePhraseInput] = useState(wakeWordStatus?.wakePhrase || 'Zoni');
  const [wakePhraseSavedNotice, setWakePhraseSavedNotice] = useState<string | null>(null);
  const [geminiKeyDraft, setGeminiKeyDraft] = useState('');
  const [showDraftKey, setShowDraftKey] = useState(false);
  const [isEditingKey, setIsEditingKey] = useState(false);
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyFeedback, setKeyFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const [keyStatusVersion, setKeyStatusVersion] = useState(0);

  useEffect(() => {
    setCustomInput(selectedAffectionName || 'Boss');
  }, [selectedAffectionName]);

  useEffect(() => {
    if (wakeWordStatus?.wakePhrase) {
      setWakePhraseInput(wakeWordStatus.wakePhrase);
    }
  }, [wakeWordStatus?.wakePhrase]);

  useEffect(() => {
    if (!isOpen) {
      setGeminiKeyDraft('');
      setShowDraftKey(false);
      setIsEditingKey(false);
      setKeyFeedback(null);
      return;
    }
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const handleKeyUpdated = () => setKeyStatusVersion((v) => v + 1);
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('zoni:gemini-key-updated', handleKeyUpdated);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('zoni:gemini-key-updated', handleKeyUpdated);
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleApplyName = (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    onUpdateAffectionName(trimmed);
    if (vitals.soundFxEnabled) playProceduralSfx('click');
  };

  const handleSaveCustom = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (customInput.trim()) {
      handleApplyName(customInput.trim());
      setIsEditingCustom(false);
    }
  };

  const safeAffectionName =
    typeof selectedAffectionName === 'string' && selectedAffectionName.trim()
      ? selectedAffectionName.trim()
      : 'Boss';

  const isPredefinedMatch = PREDEFINED_AFFECTION_OPTIONS.some(
    (opt) =>
      opt.value.toLowerCase() === safeAffectionName.toLowerCase() ||
      opt.aliases.some((a) => a.toLowerCase() === safeAffectionName.toLowerCase())
  );
  const isCustomNameActive = !isPredefinedMatch;

  void keyStatusVersion;
  const geminiKeyStatus = getGeminiApiKeyStatus();

  const handleSaveGeminiKeyInline = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (vitals.soundFxEnabled) playProceduralSfx('click');
    setKeyBusy(true);
    setKeyFeedback(null);
    const saved = saveGeminiApiKey(geminiKeyDraft);
    if (!saved.ok) {
      setKeyBusy(false);
      setKeyFeedback({ ok: false, text: saved.error || 'Invalid Gemini API Key.' });
      return;
    }
    const verifyRes = await verifyDirectGeminiApiKey(
      getGeminiApiKeyForRequest(),
      fetch,
      vitals.activeLanguage
    );
    setGeminiKeyDraft('');
    setShowDraftKey(false);
    setIsEditingKey(false);
    setKeyStatusVersion((v) => v + 1);
    setKeyBusy(false);
    setKeyFeedback({ ok: verifyRes.ok, text: verifyRes.message });
    onGeminiKeyChanged?.();
  };

  const handleTestSavedGeminiKey = async () => {
    if (vitals.soundFxEnabled) playProceduralSfx('click');
    setKeyBusy(true);
    setKeyFeedback(null);
    const verifyRes = await verifyDirectGeminiApiKey(
      getGeminiApiKeyForRequest(),
      fetch,
      vitals.activeLanguage
    );
    setKeyBusy(false);
    setKeyFeedback({ ok: verifyRes.ok, text: verifyRes.message });
    onGeminiKeyChanged?.();
  };

  const handleDeleteGeminiKeyInline = () => {
    if (vitals.soundFxEnabled) playProceduralSfx('click');
    deleteGeminiApiKey();
    setGeminiKeyDraft('');
    setShowDraftKey(false);
    setIsEditingKey(false);
    setKeyStatusVersion((v) => v + 1);
    setKeyFeedback({
      ok: true,
      text: 'Saved Gemini API Key deleted.',
    });
    onGeminiKeyChanged?.();
  };

  const wsBadge = (() => {
    if (!geminiKeyStatus.configured && backendHealth?.checked && !backendHealth.geminiConfigured) {
      return { label: backendHealth.statusText || 'API KEY REQUIRED', cls: 'text-amber-400' };
    }
    if (geminiKeyStatus.configured && backendHealth?.checked && !backendHealth.geminiConfigured) {
      return { label: backendHealth.statusText || 'INVALID API KEY', cls: 'text-rose-400' };
    }
    switch (wsStatus) {
      case 'connected':
        return {
          label: isLiveActive ? 'CONNECTED & STREAMING MIC' : 'CONNECTED (STANDBY)',
          cls: 'text-emerald-400',
        };
      case 'connecting':
        return { label: 'CONNECTING TO GEMINI LIVE...', cls: 'text-cyan-300' };
      case 'reconnecting':
        return { label: 'RECONNECTING...', cls: 'text-amber-300' };
      case 'error':
        return { label: 'LIVE STANDBY (CHAT READY)', cls: 'text-amber-300' };
      default:
        return { label: 'DISCONNECTED', cls: 'text-slate-400' };
    }
  })();

  const modes: { id: CompanionMode; name: string; subtitle: string; icon: React.ReactNode; color: string }[] = [
    {
      id: 'romantic',
      name: 'Romantic & Caring',
      subtitle: 'ভালোবাসাময়, মিষ্টি ও যত্নশীল সঙ্গিনী (Caring AI GF)',
      icon: <Heart className="w-4 h-4 text-pink-400" />,
      color: 'border-pink-500/50 bg-pink-950/30 text-pink-200',
    },
    {
      id: 'jarvis_gf',
      name: 'Jarvis Tactical GF',
      subtitle: 'ট্যাকটিক্যাল জার্ভিস এআই + স্মার্ট পার্সোনাল গার্ডিয়ান',
      icon: <Shield className="w-4 h-4 text-cyan-400" />,
      color: 'border-cyan-500/50 bg-cyan-950/30 text-cyan-200',
    },
    {
      id: 'playful',
      name: 'Playful & Teasing',
      subtitle: 'মিষ্টি খুনসুটি, দুষ্টুমি ও আনন্দময় সঙ্গ',
      icon: <Smile className="w-4 h-4 text-amber-400" />,
      color: 'border-amber-500/50 bg-amber-950/30 text-amber-200',
    },
    {
      id: 'late_night',
      name: 'Late Night Cozy',
      subtitle: 'শান্ত রাতের মৃদু কণ্ঠ, মানসিক প্রশান্তি ও স্বস্তি',
      icon: <Moon className="w-4 h-4 text-indigo-400" />,
      color: 'border-indigo-500/50 bg-indigo-950/30 text-indigo-200',
    },
  ];

  const voices = [
    { id: 'Kore', label: 'Kore (Sweet & Warm GF)', desc: 'Lovable, affectionate, natural girlfriend tone' },
    { id: 'Aoede', label: 'Aoede (Melodic Whisper)', desc: 'Gentle, soothing, dreamy & soft' },
    { id: 'Zephyr', label: 'Zephyr (Jarvis Crisp)', desc: 'Smooth, analytical yet caring sci-fi assistant' },
    { id: 'Puck', label: 'Puck (Playful & Bubbly)', desc: 'Cheeky, energetic, laughing & teasing' },
  ];

  return (
    <div
      className="zoni-modal-backdrop bg-black/80 backdrop-blur-md"
      role="dialog"
      aria-modal="true"
      aria-labelledby="zoni-settings-modal-title"
    >
      <div className="zoni-modal-card max-w-2xl bg-slate-950 border-2 border-cyan-500/40 rounded-2xl shadow-[0_0_60px_rgba(6,182,212,0.3)] animate-in fade-in zoom-in-95 duration-200">
        {/* Modal Header (Fixed / Non-scrolling) */}
        <div className="shrink-0 flex items-center justify-between p-4 sm:p-5 border-b border-cyan-500/20 bg-slate-900/70">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 shrink-0 rounded-xl bg-cyan-950/80 border border-cyan-400/50 flex items-center justify-center text-cyan-400 shadow-[0_0_15px_rgba(6,182,212,0.4)]">
              <Settings className="w-5 h-5 text-cyan-300" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h3
                  id="zoni-settings-modal-title"
                  className="font-sci-fi text-sm sm:text-base font-bold tracking-wider text-cyan-100 uppercase truncate"
                >
                  ZONI AI — JARVIS CORE SETTINGS
                </h3>
                <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-cyan-950 border border-cyan-400/40 text-cyan-300 shrink-0">
                  SYS CONFIG
                </span>
              </div>
              <p className="text-xs text-pink-300/80 font-hud tracking-wide mt-0.5 truncate">
                সোল কোর, পার্সোনালিটি ম্যাট্রিক্স ও ভয়েস মডুলেটর কনফিগারেশন
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close Settings"
            className="shrink-0 p-1.5 rounded-lg border border-cyan-500/30 text-cyan-400 hover:bg-cyan-950/50 hover:text-cyan-200 transition-colors"
            title="Close Settings"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Single Responsive Scrollable Settings Body */}
        <div
          data-testid="settings-scroll-body"
          className="zoni-modal-scroll p-4 sm:p-6 space-y-5"
        >
          {/* SECTION 1: Zoni Soul Core & Matrix */}
          <section className="p-4 rounded-xl bg-slate-900/60 border border-pink-500/30 shadow-[0_0_20px_rgba(236,72,153,0.1)] space-y-3">
            <div className="flex items-center justify-between gap-2 pb-2 border-b border-pink-500/20">
              <div className="flex items-center gap-2 min-w-0">
                <Heart className="w-4 h-4 text-pink-400 fill-pink-400 shrink-0" />
                <h4 className="font-sci-fi text-xs tracking-wider text-pink-300 uppercase">
                  1. Zoni Soul Core &amp; Matrix (জনি আপনাকে যে নামে ডাকবে)
                </h4>
              </div>
              <button
                type="button"
                onClick={() => {
                  setIsEditingCustom(!isEditingCustom);
                  setCustomInput(safeAffectionName);
                }}
                className="shrink-0 text-[10px] text-cyan-400 hover:text-cyan-300 flex items-center gap-1 font-hud uppercase tracking-wider"
              >
                <Edit2 className="w-3 h-3" />
                {isEditingCustom ? 'CLOSE' : 'CUSTOM NAME'}
              </button>
            </div>

            {/* Active Name Banner */}
            <div className="flex items-center justify-between p-2.5 rounded-lg bg-pink-950/40 border border-pink-500/50">
              <div className="flex items-center gap-2 min-w-0">
                <span className="relative flex h-2 w-2 shrink-0">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-pink-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-pink-500" />
                </span>
                <span className="text-xs font-hud text-pink-300 shrink-0">বর্তমান নাম:</span>
                <span className="font-sci-fi text-base font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-pink-300 via-white to-cyan-300 truncate">
                  &quot;{safeAffectionName}&quot;
                </span>
              </div>
              <span className="px-2 py-0.5 rounded text-[9px] font-mono font-bold bg-pink-500/20 text-pink-300 border border-pink-400/40 shrink-0">
                ACTIVE
              </span>
            </div>

            {/* Custom Input */}
            {isEditingCustom && (
              <form onSubmit={handleSaveCustom} className="flex gap-2 animate-in fade-in duration-200">
                <input
                  type="text"
                  value={customInput}
                  onChange={(e) => setCustomInput(e.target.value)}
                  onFocus={(e) => {
                    const target = e.currentTarget;
                    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    window.setTimeout(() => {
                      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    }, 250);
                  }}
                  placeholder="Enter custom name (e.g. My Love)..."
                  aria-label="Custom affection name"
                  className="flex-1 min-w-0 px-3 py-1.5 text-xs rounded-lg bg-slate-950 border border-pink-500/60 text-pink-200 placeholder:text-pink-400/40 focus:outline-none focus:border-pink-400 font-medium"
                  autoFocus
                />
                <button
                  type="submit"
                  disabled={!customInput.trim()}
                  className="shrink-0 px-3 py-1.5 bg-pink-600 hover:bg-pink-500 disabled:opacity-40 text-white rounded-lg text-xs font-hud font-bold flex items-center gap-1"
                >
                  <Check className="w-3.5 h-3.5" />
                  <span>SAVE</span>
                </button>
              </form>
            )}

            {/* Predefined Name Chips */}
            <div className="space-y-1.5">
              <span className="text-[10px] font-mono text-cyan-400/80 block uppercase">
                Available Names (ক্লিক করলে সরাসরি পরিবর্তন হবে এবং ভয়েসে জানাবে):
              </span>
              <div className="flex flex-wrap gap-2">
                {PREDEFINED_AFFECTION_OPTIONS.map((opt) => {
                  const isSelected =
                    safeAffectionName.toLowerCase() === opt.value.toLowerCase() ||
                    opt.aliases.some((a) => a.toLowerCase() === safeAffectionName.toLowerCase());
                  return (
                    <button
                      type="button"
                      key={opt.value}
                      onClick={() => handleApplyName(opt.value)}
                      className={`px-3 py-1.5 text-xs rounded-lg font-hud tracking-wide transition-all flex items-center gap-1.5 ${
                        isSelected
                          ? 'bg-pink-600/40 border-2 border-pink-400 text-pink-100 font-bold shadow-[0_0_14px_rgba(236,72,153,0.5)] scale-105'
                          : 'bg-slate-950/70 border border-cyan-500/25 text-cyan-300/80 hover:border-cyan-400 hover:text-cyan-100'
                      }`}
                    >
                      {isSelected && <Check className="w-3 h-3 text-pink-300" />}
                      <span>{opt.label}</span>
                    </button>
                  );
                })}
                {isCustomNameActive && (
                  <div className="px-3 py-1.5 text-xs rounded-lg font-hud tracking-wide bg-pink-600/40 border-2 border-pink-400 text-pink-100 font-bold shadow-[0_0_14px_rgba(236,72,153,0.5)] flex items-center gap-1.5">
                    <Check className="w-3 h-3 text-pink-300" />
                    <span>Custom: {safeAffectionName}</span>
                  </div>
                )}
              </div>
            </div>
          </section>

          {/* SECTION 2: PERSONALITY MATRIX MODE */}
          <section className="p-4 rounded-xl bg-slate-900/50 border border-cyan-500/25 space-y-3">
            <h4 className="text-xs font-hud text-cyan-300 tracking-wider font-bold block">
              2. PERSONALITY MATRIX MODE (পার্সোনালিটি ম্যাট্রিক্স মোড):
            </h4>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              {modes.map((m) => {
                const isActive = vitals.activeMode === m.id;
                return (
                  <button
                    type="button"
                    key={m.id}
                    onClick={() => {
                      onSelectMode(m.id);
                      if (vitals.soundFxEnabled) playProceduralSfx('click');
                    }}
                    className={`p-3 rounded-xl border text-left transition-all ${
                      isActive
                        ? `${m.color} shadow-[0_0_15px_rgba(6,182,212,0.3)]`
                        : 'bg-slate-950/50 border-cyan-500/10 text-slate-400 hover:border-cyan-500/30 hover:text-cyan-200'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      {m.icon}
                      <span className="font-hud font-bold text-xs tracking-wider">{m.name}</span>
                      {isActive && (
                        <span className="ml-auto text-[9px] font-mono uppercase px-1.5 py-0.2 rounded bg-cyan-950 border border-cyan-400/40 text-cyan-300">
                          ACTIVE
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-slate-400 font-normal mt-1 leading-snug">
                      {m.subtitle}
                    </p>
                  </button>
                );
              })}
            </div>
          </section>

          {/* SECTION 3: Voice Matrix & Telemetry */}
          <section className="p-4 rounded-xl bg-slate-900/50 border border-cyan-500/25 space-y-3">
            <div className="flex items-center justify-between gap-2 pb-2 border-b border-cyan-500/20">
              <div className="flex items-center gap-2">
                <Mic2 className="w-4 h-4 text-cyan-400 shrink-0" />
                <h4 className="font-sci-fi text-xs tracking-wider text-cyan-300 uppercase">
                  3. Voice Matrix &amp; Telemetry (ভয়েস মডুলেটর)
                </h4>
              </div>
              <span className="text-[10px] font-mono text-cyan-400/70 shrink-0">GEMINI LIVE AUDIO</span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {voices.map((v) => {
                const isSelected = vitals.selectedVoice === v.id;
                return (
                  <button
                    type="button"
                    key={v.id}
                    onClick={() => {
                      onSelectVoice(v.id);
                      if (vitals.soundFxEnabled) playProceduralSfx('click');
                    }}
                    className={`p-2.5 rounded-xl border text-left transition-all ${
                      isSelected
                        ? 'border-pink-500/60 bg-pink-950/30 text-pink-200 shadow-[0_0_10px_rgba(236,72,153,0.3)]'
                        : 'border-cyan-500/10 bg-slate-950/40 text-slate-400 hover:border-cyan-500/30 hover:text-cyan-200'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-1">
                      <span className="font-hud font-bold text-xs tracking-wide">{v.label}</span>
                      {isSelected && (
                        <span className="text-[9px] font-mono text-pink-400 px-1 rounded bg-pink-950 border border-pink-500/40 shrink-0">
                          EQUIPPED
                        </span>
                      )}
                    </div>
                    <p className="text-[10px] text-slate-400 font-normal mt-0.5 leading-tight">{v.desc}</p>
                  </button>
                );
              })}
            </div>

            {onToggleSoundFx && (
              <div className="pt-2 border-t border-cyan-500/15 flex items-center justify-between gap-3">
                <div className="text-xs text-slate-300 font-hud">
                  HUD Interface Sound Effects (Clicks &amp; Alerts)
                </div>
                <button
                  type="button"
                  onClick={onToggleSoundFx}
                  className={`px-3 py-1 rounded-lg border text-xs font-hud font-bold flex items-center gap-1.5 transition-all ${
                    vitals.soundFxEnabled
                      ? 'border-emerald-500/50 bg-emerald-950/50 text-emerald-300'
                      : 'border-slate-700 bg-slate-900 text-slate-400'
                  }`}
                >
                  {vitals.soundFxEnabled ? <Volume2 className="w-3.5 h-3.5" /> : <VolumeX className="w-3.5 h-3.5" />}
                  <span>{vitals.soundFxEnabled ? 'SFX ON' : 'SFX OFF'}</span>
                </button>
              </div>
            )}
          </section>

          {/* SECTION 4: WAKE WORD & 24-HOUR BACKGROUND LISTENING */}
          <section
            data-testid="wake-word-settings-section"
            className="p-4 rounded-xl bg-slate-900/60 border border-pink-500/30 space-y-3 font-mono text-xs"
          >
            <div className="flex items-center justify-between gap-2 pb-1.5 border-b border-pink-500/20">
              <div className="flex items-center gap-2 min-w-0">
                <Mic className="w-4 h-4 text-pink-400 shrink-0" />
                <h4 className="font-sci-fi text-[11px] text-pink-300 tracking-wider uppercase truncate">
                  4. On-Device Wake Word &amp; Background Service (&quot;Zoni&quot;)
                </h4>
              </div>
              <span
                data-testid="wake-word-voice-state"
                className={`text-[10px] font-bold px-2 py-0.5 rounded border shrink-0 ${
                  voiceLifecycleState === 'ERROR'
                    ? 'bg-rose-950/60 border-rose-500/50 text-rose-300'
                    : voiceLifecycleState === 'WAKE_WORD_LISTENING' ||
                      voiceLifecycleState === 'LISTENING' ||
                      voiceLifecycleState === 'CONNECTED'
                    ? 'bg-emerald-950/60 border-emerald-500/50 text-emerald-300'
                    : voiceLifecycleState === 'SPEAKING' ||
                      voiceLifecycleState === 'PROCESSING' ||
                      voiceLifecycleState === 'WAKE_WORD_DETECTED'
                    ? 'bg-cyan-950/60 border-cyan-500/50 text-cyan-300'
                    : 'bg-slate-950 border-slate-700 text-slate-300'
                }`}
              >
                {voiceLifecycleState}
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <div className="p-2.5 rounded-lg bg-slate-950/70 border border-cyan-500/15 flex items-center justify-between gap-2">
                <span className="text-slate-400">WAKE WORD:</span>
                <span
                  data-testid="wake-word-enabled-status"
                  className={
                    wakeWordStatus?.wakeWordEnabled ? 'text-emerald-400 font-bold' : 'text-slate-400 font-bold'
                  }
                >
                  {wakeWordStatus?.wakeWordEnabled ? 'ENABLED' : 'DISABLED'}
                </span>
              </div>
              <div className="p-2.5 rounded-lg bg-slate-950/70 border border-cyan-500/15 flex items-center justify-between gap-2">
                <span className="text-slate-400">DETECTOR:</span>
                <span
                  data-testid="wake-word-listening-status"
                  className={
                    wakeWordStatus?.listening
                      ? 'text-emerald-400 font-bold'
                      : isLiveActive
                      ? 'text-cyan-300 font-bold'
                      : 'text-slate-400 font-bold'
                  }
                >
                  {wakeWordStatus?.listening
                    ? 'LISTENING (ON-DEVICE)'
                    : isLiveActive
                    ? 'PAUSED FOR LIVE VOICE'
                    : 'NOT LISTENING'}
                </span>
              </div>
              <div className="p-2.5 rounded-lg bg-slate-950/70 border border-cyan-500/15 flex items-center justify-between gap-2">
                <span className="text-slate-400">MIC PERMISSION:</span>
                <span
                  className={
                    wakeWordStatus?.micPermissionGranted
                      ? 'text-emerald-400 font-bold'
                      : deviceDiagnostics?.bridgeConnected
                      ? 'text-amber-300 font-bold'
                      : 'text-slate-400 font-bold'
                  }
                >
                  {wakeWordStatus?.micPermissionGranted
                    ? 'GRANTED'
                    : deviceDiagnostics?.bridgeConnected
                    ? 'REQUIRED'
                    : 'ANDROID APK ONLY'}
                </span>
              </div>
              <div className="p-2.5 rounded-lg bg-slate-950/70 border border-cyan-500/15 flex items-center justify-between gap-2">
                <span className="text-slate-400">FOREGROUND SERVICE:</span>
                <span
                  className={
                    wakeWordStatus?.backgroundServiceRunning
                      ? 'text-emerald-400 font-bold'
                      : 'text-slate-400 font-bold'
                  }
                >
                  {wakeWordStatus?.backgroundServiceRunning
                    ? 'RUNNING (VISIBLE NOTIFICATION)'
                    : 'STOPPED'}
                </span>
              </div>
            </div>

            <div className="flex items-center justify-between gap-2 py-1 border-b border-pink-500/10">
              <span className="text-slate-400 flex items-center gap-1.5">
                <Bell className="w-3.5 h-3.5 text-cyan-400" />
                <span>NOTIFICATION STATUS:</span>
              </span>
              <span className="text-cyan-200 font-bold text-right">
                {wakeWordStatus?.backgroundServiceRunning
                  ? 'VISIBLE (OPEN ZONI / STOP LISTENING)'
                  : !deviceDiagnostics?.bridgeConnected
                  ? 'ANDROID APK ONLY'
                  : wakeWordStatus?.notificationPermissionGranted === false
                  ? 'POST_NOTIFICATIONS NEEDED'
                  : 'INACTIVE'}
              </span>
            </div>

            {/* Configurable Wake Phrase (Default: Zoni) */}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const cleaned = wakePhraseInput.trim() || 'Zoni';
                setWakePhraseInput(cleaned);
                if (onUpdateWakePhrase) {
                  onUpdateWakePhrase(cleaned);
                  setWakePhraseSavedNotice(`Wake word set to "${cleaned}"`);
                  window.setTimeout(() => setWakePhraseSavedNotice(null), 2500);
                }
              }}
              className="flex items-center gap-2 pt-1"
            >
              <label htmlFor="zoni-wake-phrase-input" className="text-slate-400 shrink-0">
                WAKE PHRASE:
              </label>
              <input
                id="zoni-wake-phrase-input"
                type="text"
                value={wakePhraseInput}
                onChange={(e) => setWakePhraseInput(e.target.value)}
                placeholder="Zoni"
                className="flex-1 min-w-0 px-2.5 py-1.5 rounded-lg bg-slate-950 border border-pink-500/40 text-xs text-pink-100 focus:outline-none focus:border-pink-400"
              />
              <button
                type="submit"
                className="shrink-0 px-3 py-1.5 rounded-lg bg-pink-600 hover:bg-pink-500 text-white font-hud text-[11px] font-bold flex items-center gap-1 cursor-pointer"
              >
                <Save className="w-3.5 h-3.5" />
                <span>SAVE</span>
              </button>
            </form>

            {wakePhraseSavedNotice && (
              <p className="text-[11px] font-sans text-emerald-300">{wakePhraseSavedNotice}</p>
            )}

            {wakeWordStatus?.lastError && (
              <div className="p-2 rounded-lg bg-amber-950/40 border border-amber-500/40 text-amber-200 font-sans text-[11px] flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                <span>{wakeWordStatus.lastError}</span>
              </div>
            )}

            <div className="flex flex-wrap gap-2 pt-1 font-hud">
              {wakeWordStatus?.backgroundServiceRunning || wakeWordStatus?.wakeWordEnabled ? (
                <button
                  type="button"
                  onClick={onStopBackgroundWakeWord}
                  className="px-3 py-1.5 rounded-lg border border-rose-500/50 bg-rose-950/60 hover:bg-rose-900/60 text-rose-200 text-xs font-bold flex items-center gap-1.5 cursor-pointer"
                >
                  <Power className="w-3.5 h-3.5" />
                  <span>STOP BACKGROUND LISTENING</span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={onStartBackgroundWakeWord}
                  className="px-3 py-1.5 rounded-lg border border-emerald-500/50 bg-emerald-950/60 hover:bg-emerald-900/60 text-emerald-200 text-xs font-bold flex items-center gap-1.5 cursor-pointer"
                >
                  <Power className="w-3.5 h-3.5" />
                  <span>ENABLE 24H BACKGROUND &quot;ZONI&quot;</span>
                </button>
              )}

              {onToggleLiveMode && (
                <button
                  type="button"
                  onClick={onToggleLiveMode}
                  className="px-3 py-1.5 rounded-lg border border-cyan-500/40 bg-cyan-950/50 hover:bg-cyan-900/60 text-cyan-200 text-xs font-bold flex items-center gap-1.5 cursor-pointer"
                >
                  {isLiveActive ? <Square className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                  <span>{isLiveActive ? 'STOP ASSISTANT' : 'START ASSISTANT'}</span>
                </button>
              )}

              {onOpenBatterySettings && (
                <button
                  type="button"
                  onClick={onOpenBatterySettings}
                  className="px-3 py-1.5 rounded-lg border border-amber-500/40 bg-amber-950/50 hover:bg-amber-900/60 text-amber-200 text-xs font-bold flex items-center gap-1.5 cursor-pointer"
                >
                  <Battery className="w-3.5 h-3.5" />
                  <span>BATTERY OPTIMIZATION</span>
                </button>
              )}

              {onRequestMicPermission &&
                deviceDiagnostics?.bridgeConnected &&
                wakeWordStatus &&
                !wakeWordStatus.micPermissionGranted && (
                  <button
                    type="button"
                    onClick={onRequestMicPermission}
                    className="px-3 py-1.5 rounded-lg border border-pink-500/40 bg-pink-950/50 hover:bg-pink-900/60 text-pink-200 text-xs font-bold flex items-center gap-1.5 cursor-pointer"
                  >
                    <Mic className="w-3.5 h-3.5" />
                    <span>GRANT MIC PERMISSION</span>
                  </button>
                )}
            </div>

            <p className="text-[10px] font-sans text-slate-400 leading-relaxed">
              On-device wake word detection listens locally only for &ldquo;{wakeWordStatus?.wakePhrase || 'Zoni'}&rdquo; (জোনি)
              with a persistent Android microphone notification and never streams ambient audio to Gemini until triggered.
              On Android 12–14+, disable battery optimization for reliable background uptime.
            </p>
          </section>

          {/* SECTION 5: GEMINI API KEY (BYOK) & LIVE CONNECTION */}
          <section
            data-testid="gemini-server-settings-section"
            className="p-4 rounded-xl bg-slate-900/60 border border-cyan-500/30 space-y-2.5 font-mono text-xs"
          >
            <h4 className="font-sci-fi text-[11px] text-cyan-300 tracking-wider uppercase block pb-1 border-b border-cyan-500/20">
              5. Gemini API Key &amp; Live Connection:
            </h4>
            <div className="flex items-center justify-between gap-2 py-1 border-b border-cyan-500/10">
              <span className="text-slate-400 shrink-0">CONNECTION MODE:</span>
              <span className="text-cyan-300 flex items-center gap-1.5 font-bold text-right">
                {geminiKeyStatus.configured ? (
                  <>
                    <Key className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                    DIRECT GOOGLE GEMINI (YOUR API KEY)
                  </>
                ) : backendHealth?.geminiConfigured ? (
                  <>
                    <Radio className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                    MANAGED SERVER-SIDE GEMINI API
                  </>
                ) : (
                  <>
                    <Key className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                    GEMINI API KEY REQUIRED
                  </>
                )}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2 py-1 border-b border-cyan-500/10">
              <span className="text-slate-400 shrink-0">MASKED API KEY:</span>
              <span
                data-testid="settings-masked-key"
                className={geminiKeyStatus.configured ? 'text-emerald-300 font-bold text-right' : 'text-slate-400 text-right'}
              >
                {geminiKeyStatus.configured ? geminiKeyStatus.maskedPreview : 'NOT CONFIGURED'}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2 py-1 border-b border-cyan-500/10">
              <span className="text-slate-400 shrink-0">KEY STORAGE:</span>
              <span className="text-cyan-200 text-right flex items-center gap-1">
                <ShieldCheck className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                <span>{geminiKeyStatus.storageLabel}</span>
              </span>
            </div>
            <div className="flex items-center justify-between gap-2 py-1 border-b border-cyan-500/10">
              <span className="text-slate-400 shrink-0">AUDIO IN / OUT:</span>
              <span className="text-pink-300 font-bold text-right">16kHz PCM ⇄ 24kHz PCM</span>
            </div>
            <div className="flex items-center justify-between gap-2 py-1 border-b border-cyan-500/10">
              <span className="text-slate-400 shrink-0">LIVE LINK STATUS:</span>
              <span className={`${wsBadge.cls} font-bold text-right`}>{wsBadge.label}</span>
            </div>
            <div className="flex items-center justify-between gap-2 py-1">
              <span className="text-slate-400 shrink-0">AI SERVICE STATUS:</span>
              <span
                data-testid="settings-gemini-service-status"
                className={
                  backendHealth?.geminiConfigured
                    ? 'text-emerald-400 font-bold text-right'
                    : backendHealth?.checked
                    ? 'text-amber-400 font-bold text-right'
                    : 'text-cyan-300 font-bold text-right'
                }
              >
                {geminiKeyStatus.configured && backendHealth?.geminiConfigured
                  ? 'READY (YOUR GEMINI KEY)'
                  : backendHealth?.geminiConfigured
                  ? 'READY (SERVER MANAGED)'
                  : backendHealth?.checked
                  ? backendHealth.statusText
                  : 'CHECKING...'}
              </span>
            </div>

            {keyFeedback && (
              <div
                className={`p-2.5 rounded-lg border font-sans text-[11px] flex items-start gap-2 ${
                  keyFeedback.ok
                    ? 'bg-emerald-950/40 border-emerald-500/40 text-emerald-200'
                    : 'bg-rose-950/40 border-rose-500/40 text-rose-200'
                }`}
              >
                <span>{keyFeedback.text}</span>
              </div>
            )}

            {backendHealth?.checked && !backendHealth.geminiConfigured && backendHealth.configurationError && (
              <div className="p-2.5 rounded-lg bg-amber-950/40 border border-amber-500/40 text-amber-200 font-sans text-[11px] flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                <span>{backendHealth.configurationError}</span>
              </div>
            )}

            {/* Inline BYOK Gemini API Key Editor */}
            {(!geminiKeyStatus.configured || isEditingKey) && (
              <form
                onSubmit={handleSaveGeminiKeyInline}
                className="pt-2 space-y-2 border-t border-cyan-500/15"
              >
                <label
                  htmlFor="settings-gemini-api-key-input"
                  className="block text-[11px] font-hud text-cyan-200 font-bold uppercase tracking-wider"
                >
                  {geminiKeyStatus.configured ? 'Enter New Gemini API Key' : 'Enter Your Own Gemini API Key'}
                </label>
                <div className="relative flex items-center">
                  <input
                    id="settings-gemini-api-key-input"
                    data-testid="settings-gemini-key-input"
                    type={showDraftKey ? 'text' : 'password'}
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    value={geminiKeyDraft}
                    onChange={(e) => setGeminiKeyDraft(e.target.value)}
                    placeholder="Paste your Gemini API Key (AIza... or AQ....)"
                    className="w-full pr-9 pl-3 py-2 rounded-lg bg-slate-950 border border-cyan-500/40 text-xs font-mono text-cyan-100 placeholder:text-slate-500 focus:outline-none focus:border-cyan-400"
                  />
                  <button
                    type="button"
                    onClick={() => setShowDraftKey((prev) => !prev)}
                    aria-label={showDraftKey ? 'Hide Gemini API key' : 'Show Gemini API key'}
                    className="absolute right-2 p-1 text-slate-400 hover:text-cyan-300 cursor-pointer"
                  >
                    {showDraftKey ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                  </button>
                </div>
                <div className="flex flex-wrap gap-2 font-hud">
                  <button
                    type="submit"
                    disabled={keyBusy}
                    data-testid="settings-save-verify-key-btn"
                    className="px-3 py-1.5 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-xs font-bold flex items-center gap-1.5 cursor-pointer disabled:opacity-60"
                  >
                    <Save className="w-3.5 h-3.5" />
                    <span>{keyBusy ? 'VERIFYING...' : 'SAVE & VERIFY KEY'}</span>
                  </button>
                  {isEditingKey && (
                    <button
                      type="button"
                      onClick={() => {
                        setIsEditingKey(false);
                        setGeminiKeyDraft('');
                        setShowDraftKey(false);
                      }}
                      className="px-3 py-1.5 rounded-lg border border-slate-600 bg-slate-800/60 text-slate-300 text-xs font-bold cursor-pointer"
                    >
                      CANCEL
                    </button>
                  )}
                </div>
              </form>
            )}

            <p className="text-[10px] font-sans text-slate-400 leading-relaxed">
              Every user can connect Zoni AI using their own Google Gemini API Key (stored locally / encrypted in Android Keystore on APK—no backend server URL required).
            </p>

            <div className="pt-1 flex flex-wrap gap-2 font-hud">
              {geminiKeyStatus.configured && !isEditingKey && (
                <>
                  <button
                    type="button"
                    onClick={() => setIsEditingKey(true)}
                    data-testid="settings-replace-key-btn"
                    className="px-3 py-1.5 rounded-lg border border-cyan-500/40 bg-cyan-950/50 hover:bg-cyan-900/60 text-cyan-200 text-xs font-bold flex items-center gap-1.5 cursor-pointer"
                  >
                    <Key className="w-3.5 h-3.5" />
                    <span>REPLACE KEY</span>
                  </button>
                  <button
                    type="button"
                    disabled={keyBusy}
                    onClick={() => void handleTestSavedGeminiKey()}
                    className="px-3 py-1.5 rounded-lg border border-emerald-500/40 bg-emerald-950/50 hover:bg-emerald-900/60 text-emerald-200 text-xs font-bold flex items-center gap-1.5 cursor-pointer disabled:opacity-60"
                  >
                    <ShieldCheck className="w-3.5 h-3.5" />
                    <span>{keyBusy ? 'TESTING...' : 'VERIFY KEY'}</span>
                  </button>
                  <button
                    type="button"
                    onClick={handleDeleteGeminiKeyInline}
                    data-testid="settings-delete-key-btn"
                    className="px-3 py-1.5 rounded-lg border border-rose-500/40 bg-rose-950/50 hover:bg-rose-900/60 text-rose-200 text-xs font-bold flex items-center gap-1.5 cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>DELETE KEY</span>
                  </button>
                </>
              )}
              {onReconnectLive && (
                <button
                  type="button"
                  onClick={onReconnectLive}
                  className="px-3 py-1.5 rounded-lg border border-cyan-500/40 bg-cyan-950/50 hover:bg-cyan-900/60 text-cyan-200 text-xs font-bold flex items-center gap-1.5 cursor-pointer"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  <span>RECONNECT LIVE</span>
                </button>
              )}
              {onOpenBackendSetup && (
                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    onOpenBackendSetup();
                  }}
                  className="px-3 py-1.5 rounded-lg border border-pink-500/40 bg-pink-950/50 hover:bg-pink-900/60 text-pink-200 text-xs font-bold flex items-center gap-1.5 cursor-pointer"
                >
                  <ShieldCheck className="w-3.5 h-3.5" />
                  <span>SETUP WIZARD</span>
                </button>
              )}
            </div>
          </section>

          {/* SECTION 5: REAL-TIME DEVICE ACTION DIAGNOSTICS */}
          <section
            data-testid="device-action-diagnostics"
            className="p-4 rounded-xl bg-slate-900/60 border border-emerald-500/30 space-y-2.5 font-mono text-xs"
          >
            <div className="flex items-center justify-between gap-2 pb-1.5 border-b border-emerald-500/20">
              <div className="flex items-center gap-2 min-w-0">
                <Activity className="w-4 h-4 text-emerald-400 shrink-0" />
                <h4 className="font-sci-fi text-[11px] text-emerald-300 tracking-wider uppercase truncate">
                  6. Device Action Diagnostics (রিয়েল-টাইম ডায়াগনস্টিক্স)
                </h4>
              </div>
              {onRefreshDiagnostics && (
                <button
                  type="button"
                  onClick={onRefreshDiagnostics}
                  className="shrink-0 px-2 py-1 rounded-md border border-emerald-500/40 bg-emerald-950/50 hover:bg-emerald-900/60 text-emerald-200 text-[10px] font-hud font-bold flex items-center gap-1 cursor-pointer"
                >
                  <RefreshCw className="w-3 h-3" />
                  <span>REFRESH</span>
                </button>
              )}
            </div>

            <div className="flex items-center justify-between gap-2 py-1 border-b border-emerald-500/10">
              <span className="text-slate-400 shrink-0">ANDROID BRIDGE:</span>
              <span
                className={
                  deviceDiagnostics?.bridgeConnected
                    ? 'text-emerald-400 font-bold text-right'
                    : 'text-amber-300 font-bold text-right'
                }
              >
                {deviceDiagnostics?.bridgeConnected
                  ? 'CONNECTED (NATIVE APK)'
                  : 'DISCONNECTED (WEB PREVIEW)'}
              </span>
            </div>

            <div className="flex items-center justify-between gap-2 py-1 border-b border-emerald-500/10">
              <span className="text-slate-400 shrink-0">EXECUTION PATH:</span>
              <span className="text-cyan-300 font-bold text-right">
                {deviceDiagnostics?.executionPath === 'live_ws'
                  ? 'DIRECT GEMINI LIVE TOOL RELAY'
                  : deviceDiagnostics?.executionPath === 'http_chat'
                  ? 'DIRECT GEMINI REST FUNCTION CALLING'
                  : deviceDiagnostics?.executionPath === 'deterministic_native'
                  ? 'DETERMINISTIC NATIVE ENGINE'
                  : 'IDLE (READY)'}
              </span>
            </div>

            <div className="flex items-center justify-between gap-2 py-1 border-b border-emerald-500/10">
              <span className="text-slate-400 shrink-0">GEMINI TOOL CALLING:</span>
              <span
                className={
                  deviceDiagnostics?.geminiToolCallingAvailable
                    ? 'text-emerald-400 font-bold text-right'
                    : 'text-amber-300 font-bold text-right'
                }
              >
                {deviceDiagnostics?.geminiToolCallingAvailable
                  ? `AVAILABLE (${deviceDiagnostics.declaredToolsCount || ASSISTANT_TOOL_SPECS.length} TOOLS)`
                  : 'UNAVAILABLE'}
              </span>
            </div>

            <div className="flex items-center justify-between gap-2 py-1 border-b border-emerald-500/10">
              <span className="text-slate-400 shrink-0">ACCESSIBILITY SERVICE:</span>
              <span
                className={
                  deviceDiagnostics?.accessibilityEnabled
                    ? 'text-emerald-400 font-bold text-right'
                    : 'text-amber-300 font-bold text-right'
                }
              >
                {deviceDiagnostics?.accessibilityEnabled
                  ? 'CONNECTED & ENABLED'
                  : deviceDiagnostics?.bridgeConnected
                  ? 'DISABLED (OPEN SETTINGS)'
                  : 'APK REQUIRED'}
              </span>
            </div>

            <div className="flex items-center justify-between gap-2 py-1 border-b border-emerald-500/10">
              <span className="text-slate-400 shrink-0">CONTACTS PERMISSION:</span>
              <span
                className={
                  deviceDiagnostics?.contactsPermissionGranted
                    ? 'text-emerald-400 font-bold text-right'
                    : 'text-amber-300 font-bold text-right'
                }
              >
                {deviceDiagnostics?.contactsPermissionGranted
                  ? 'GRANTED'
                  : deviceDiagnostics?.bridgeConnected
                  ? 'DENIED'
                  : 'APK REQUIRED'}
              </span>
            </div>

            <div className="flex items-center justify-between gap-2 py-1 border-b border-emerald-500/10">
              <span className="text-slate-400 shrink-0">APP DISCOVERY:</span>
              <span className="text-cyan-200 font-bold text-right">
                {deviceDiagnostics?.installedAppDiscoveryStatus || 'APK REQUIRED'}
              </span>
            </div>

            <div className="flex items-center justify-between gap-2 py-1 border-b border-emerald-500/10">
              <span className="text-slate-400 shrink-0">LAST ACTION:</span>
              <span
                data-testid="diag-last-action"
                className="text-cyan-100 truncate text-right"
                title={deviceDiagnostics?.lastActionRequested || 'None'}
              >
                {deviceDiagnostics?.lastActionRequested || 'None'}
              </span>
            </div>

            <div className="flex items-center justify-between gap-2 py-1 border-b border-emerald-500/10">
              <span className="text-slate-400 shrink-0">LAST RESULT:</span>
              <span
                data-testid="diag-last-result"
                className="text-emerald-200 truncate text-right"
                title={deviceDiagnostics?.lastActionResult || 'None'}
              >
                {deviceDiagnostics?.lastActionResult || 'None'}
              </span>
            </div>

            <div className="flex items-center justify-between gap-2 py-1">
              <span className="text-slate-400 shrink-0">FAILURE REASON:</span>
              <span
                data-testid="diag-failure-reason"
                className={
                  deviceDiagnostics?.lastFailureReason &&
                  deviceDiagnostics.lastFailureReason !== 'None'
                    ? 'text-rose-300 font-bold truncate text-right'
                    : 'text-slate-400 text-right'
                }
                title={deviceDiagnostics?.lastFailureReason || 'None'}
              >
                {deviceDiagnostics?.lastFailureReason || 'None'}
              </span>
            </div>

            <p className="text-[10px] font-sans text-slate-400 pt-1">
              Privacy protection: diagnostics never display or log private message contents, phone numbers, or API secrets.
            </p>

            {onOpenAccessibilitySettings && !deviceDiagnostics?.accessibilityEnabled && (
              <div className="pt-1 font-hud">
                <button
                  type="button"
                  onClick={onOpenAccessibilitySettings}
                  className="px-3 py-1.5 rounded-lg border border-amber-500/40 bg-amber-950/50 hover:bg-amber-900/60 text-amber-200 text-xs font-bold flex items-center gap-1.5 cursor-pointer"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  <span>OPEN ACCESSIBILITY SETTINGS</span>
                </button>
              </div>
            )}
          </section>
        </div>

        {/* Modal Footer (Fixed / Non-scrolling) */}
        <div className="shrink-0 p-3.5 sm:p-4 border-t border-cyan-500/20 bg-slate-900/80 flex items-center justify-between gap-2">
          <span className="text-[11px] font-hud text-cyan-400/80 truncate">
            ZONI AI JARVIS SYSTEM CORE // ACTIVE
          </span>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 px-5 py-2 rounded-xl bg-gradient-to-r from-cyan-600 via-pink-600 to-cyan-600 hover:from-cyan-500 hover:to-pink-500 text-white font-hud text-xs font-bold tracking-wider shadow-[0_0_15px_rgba(6,182,212,0.4)]"
          >
            CLOSE SETTINGS
          </button>
        </div>
      </div>
    </div>
  );
};
