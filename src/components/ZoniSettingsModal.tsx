import React, { useState } from 'react';
import { CompanionMode, SystemVitals } from '../types';
import { playProceduralSfx } from '../utils/audio';
import { PREDEFINED_AFFECTION_OPTIONS } from './GfStatusPanel';
import {
  X,
  Settings,
  Heart,
  Shield,
  Moon,
  Smile,
  Mic2,
  Radio,
  Check,
  Edit2,
} from 'lucide-react';

interface ZoniSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  vitals: SystemVitals;
  selectedAffectionName: string;
  isLiveActive: boolean;
  onSelectMode: (mode: CompanionMode) => void;
  onUpdateAffectionName: (name: string) => void;
  onSelectVoice: (voice: string) => void;
}

export const ZoniSettingsModal: React.FC<ZoniSettingsModalProps> = ({
  isOpen,
  onClose,
  vitals,
  selectedAffectionName,
  isLiveActive,
  onSelectMode,
  onUpdateAffectionName,
  onSelectVoice,
}) => {
  const [isEditingCustom, setIsEditingCustom] = useState(false);
  const [customInput, setCustomInput] = useState(selectedAffectionName || 'Boss');

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

  const isPredefinedMatch = PREDEFINED_AFFECTION_OPTIONS.some(
    (opt) =>
      opt.value.toLowerCase() === selectedAffectionName.toLowerCase() ||
      opt.aliases.some((a) => a.toLowerCase() === selectedAffectionName.toLowerCase())
  );
  const isCustomNameActive = !isPredefinedMatch;

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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md p-3 sm:p-5 overflow-y-auto">
      <div className="w-full max-w-2xl bg-slate-950 border-2 border-cyan-500/40 rounded-2xl shadow-[0_0_60px_rgba(6,182,212,0.3)] flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-200 my-auto">
        {/* Modal Header */}
        <div className="flex items-center justify-between p-4 sm:p-5 border-b border-cyan-500/20 bg-slate-900/70">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-cyan-950/80 border border-cyan-400/50 flex items-center justify-center text-cyan-400 shadow-[0_0_15px_rgba(6,182,212,0.4)]">
              <Settings className="w-5 h-5 text-cyan-300" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="font-sci-fi text-sm sm:text-base font-bold tracking-wider text-cyan-100 uppercase">
                  ZONI AI — JARVIS CORE SETTINGS
                </h3>
                <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-cyan-950 border border-cyan-400/40 text-cyan-300">
                  SYS CONFIG
                </span>
              </div>
              <p className="text-xs text-pink-300/80 font-hud tracking-wide mt-0.5">
                সোল কোর, পার্সোনালিটি ম্যাট্রিক্স ও ভয়েস মডুলেটর কনফিগারেশন
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg border border-cyan-500/30 text-cyan-400 hover:bg-cyan-950/50 hover:text-cyan-200 transition-colors"
            title="Close Settings"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Scrollable Settings Body */}
        <div className="p-4 sm:p-6 space-y-5 max-h-[70vh] overflow-y-auto">
          {/* SECTION 1: Zoni Soul Core & Matrix */}
          <div className="p-4 rounded-xl bg-slate-900/60 border border-pink-500/30 shadow-[0_0_20px_rgba(236,72,153,0.1)] space-y-3">
            <div className="flex items-center justify-between pb-2 border-b border-pink-500/20">
              <div className="flex items-center gap-2">
                <Heart className="w-4 h-4 text-pink-400 fill-pink-400" />
                <h4 className="font-sci-fi text-xs tracking-wider text-pink-300 uppercase">
                  1. Zoni Soul Core & Matrix (জনি আপনাকে যে নামে ডাকবে)
                </h4>
              </div>
              <button
                onClick={() => {
                  setIsEditingCustom(!isEditingCustom);
                  setCustomInput(selectedAffectionName);
                }}
                className="text-[10px] text-cyan-400 hover:text-cyan-300 flex items-center gap-1 font-hud uppercase tracking-wider"
              >
                <Edit2 className="w-3 h-3" />
                {isEditingCustom ? 'CLOSE' : 'CUSTOM NAME'}
              </button>
            </div>

            {/* Active Name Banner */}
            <div className="flex items-center justify-between p-2.5 rounded-lg bg-pink-950/40 border border-pink-500/50">
              <div className="flex items-center gap-2 min-w-0">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-pink-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-pink-500" />
                </span>
                <span className="text-xs font-hud text-pink-300">বর্তমান নাম:</span>
                <span className="font-sci-fi text-base font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-pink-300 via-white to-cyan-300 truncate">
                  "{selectedAffectionName}"
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
                  placeholder="Enter custom name (e.g. My Love)..."
                  className="flex-1 px-3 py-1.5 text-xs rounded-lg bg-slate-950 border border-pink-500/60 text-pink-200 placeholder:text-pink-400/40 focus:outline-none focus:border-pink-400 font-medium"
                  autoFocus
                />
                <button
                  type="submit"
                  disabled={!customInput.trim()}
                  className="px-3 py-1.5 bg-pink-600 hover:bg-pink-500 disabled:opacity-40 text-white rounded-lg text-xs font-hud font-bold flex items-center gap-1"
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
                    selectedAffectionName.toLowerCase() === opt.value.toLowerCase() ||
                    opt.aliases.some((a) => a.toLowerCase() === selectedAffectionName.toLowerCase());
                  return (
                    <button
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
                    <span>Custom: {selectedAffectionName}</span>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* SECTION 2: PERSONALITY MATRIX MODE */}
          <div className="p-4 rounded-xl bg-slate-900/50 border border-cyan-500/25 space-y-3">
            <span className="text-xs font-hud text-cyan-300 tracking-wider font-bold block">
              2. PERSONALITY MATRIX MODE (পার্সোনালিটি ম্যাট্রিক্স মোড):
            </span>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              {modes.map((m) => {
                const isActive = vitals.activeMode === m.id;
                return (
                  <button
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
          </div>

          {/* SECTION 3: Voice Matrix & Telemetry */}
          <div className="p-4 rounded-xl bg-slate-900/50 border border-cyan-500/25 space-y-3">
            <div className="flex items-center justify-between pb-2 border-b border-cyan-500/20">
              <div className="flex items-center gap-2">
                <Mic2 className="w-4 h-4 text-cyan-400" />
                <h4 className="font-sci-fi text-xs tracking-wider text-cyan-300 uppercase">
                  3. Voice Matrix & Telemetry (ভয়েস মডুলেটর)
                </h4>
              </div>
              <span className="text-[10px] font-mono text-cyan-400/70">GEMINI LIVE AUDIO</span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {voices.map((v) => {
                const isSelected = vitals.selectedVoice === v.id;
                return (
                  <button
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
                    <div className="flex items-center justify-between">
                      <span className="font-hud font-bold text-xs tracking-wide">{v.label}</span>
                      {isSelected && (
                        <span className="text-[9px] font-mono text-pink-400 px-1 rounded bg-pink-950 border border-pink-500/40">
                          EQUIPPED
                        </span>
                      )}
                    </div>
                    <p className="text-[10px] text-slate-400 font-normal mt-0.5 leading-tight">{v.desc}</p>
                  </button>
                );
              })}
            </div>
          </div>

          {/* SECTION 4: PROTOCOL & TELEMETRY SPECS */}
          <div className="p-4 rounded-xl bg-slate-900/60 border border-cyan-500/30 space-y-2.5 font-mono text-xs">
            <span className="font-sci-fi text-[11px] text-cyan-300 tracking-wider uppercase block pb-1 border-b border-cyan-500/20">
              System Telemetry & Protocol Specifications:
            </span>
            <div className="flex items-center justify-between py-1 border-b border-cyan-500/10">
              <span className="text-slate-400">PROTOCOL:</span>
              <span className="text-cyan-300 flex items-center gap-1.5 font-bold">
                <Radio className="w-3.5 h-3.5 text-cyan-400 animate-pulse" />
                WSS // GEMINI-3.8-LIVE
              </span>
            </div>
            <div className="flex items-center justify-between py-1 border-b border-cyan-500/10">
              <span className="text-slate-400">AUDIO IN / OUT:</span>
              <span className="text-pink-300 font-bold">16kHz PCM ⇄ 24kHz PCM</span>
            </div>
            <div className="flex items-center justify-between py-1">
              <span className="text-slate-400">DUPLEX STATUS:</span>
              <span className={isLiveActive ? 'text-emerald-400 font-bold' : 'text-amber-400 font-bold'}>
                {isLiveActive ? 'STREAMING (LIVE LINK ACTIVE)' : 'READY / PUSH-TO-TALK'}
              </span>
            </div>
          </div>
        </div>

        {/* Modal Footer */}
        <div className="p-4 border-t border-cyan-500/20 bg-slate-900/80 flex items-center justify-between">
          <span className="text-[11px] font-hud text-cyan-400/80">
            ZONI AI JARVIS SYSTEM CORE // ACTIVE
          </span>
          <button
            onClick={onClose}
            className="px-5 py-2 rounded-xl bg-gradient-to-r from-cyan-600 via-pink-600 to-cyan-600 hover:from-cyan-500 hover:to-pink-500 text-white font-hud text-xs font-bold tracking-wider shadow-[0_0_15px_rgba(6,182,212,0.4)]"
          >
            CLOSE SETTINGS
          </button>
        </div>
      </div>
    </div>
  );
};
