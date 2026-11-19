import React, { useState } from 'react';
import { CompanionMode, SystemVitals } from '../types';
import { playProceduralSfx } from '../utils/audio';
import { ChromePermissionsReport } from '../utils/permissionManager';
import { Heart, Sparkles, Shield, Moon, Smile, Check, Edit2, Mic, MapPin, Bell, ShieldCheck } from 'lucide-react';

interface GfStatusPanelProps {
  vitals: SystemVitals;
  selectedAffectionName?: string;
  permissionsReport?: ChromePermissionsReport;
  onOpenPermissionsModal?: () => void;
  onSelectMode: (mode: CompanionMode) => void;
  onUpdateNickname?: (nickname: string) => void;
  onUpdateAffectionName?: (name: string) => void;
  onBoostAffection: () => void;
}

export interface AffectionOption {
  value: string;
  label: string;
  aliases: string[];
}

export const PREDEFINED_AFFECTION_OPTIONS: AffectionOption[] = [
  { value: 'Boss', label: 'Boss', aliases: ['boss', 'বস'] },
  { value: 'Jaan', label: 'জান (Jaan)', aliases: ['jaan', 'জান', 'জান (jaan)', 'জান (Jaan)'] },
  { value: 'Hero', label: 'হিরো (Hero)', aliases: ['hero', 'হিরো', 'হিরো (hero)', 'হিরো (Hero)'] },
  { value: 'Babu', label: 'বাবু (Babu)', aliases: ['babu', 'বাবু', 'বাবু (babu)', 'বাবু (Babu)'] },
  { value: 'Sweetheart', label: 'Sweetheart', aliases: ['sweetheart', 'সুইটহার্ট'] },
];

export const PREDEFINED_AFFECTION_NAMES = PREDEFINED_AFFECTION_OPTIONS.map((o) => o.label);

export const GfStatusPanel: React.FC<GfStatusPanelProps> = ({
  vitals,
  selectedAffectionName,
  permissionsReport,
  onOpenPermissionsModal,
  onSelectMode,
  onUpdateNickname,
  onUpdateAffectionName,
  onBoostAffection,
}) => {
  const currentAffectionName = (selectedAffectionName || vitals.selectedAffectionName || vitals.userNickname || 'Boss').trim();
  const [isEditingCustom, setIsEditingCustom] = useState(false);
  const [customInput, setCustomInput] = useState(currentAffectionName);

  const handleApplyName = (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    if (onUpdateAffectionName) {
      onUpdateAffectionName(trimmed);
    } else if (onUpdateNickname) {
      onUpdateNickname(trimmed);
    }
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
      opt.value.toLowerCase() === currentAffectionName.toLowerCase() ||
      opt.aliases.some((a) => a.toLowerCase() === currentAffectionName.toLowerCase())
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

  return (
    <div className="w-full lg:w-72 xl:w-80 flex flex-col gap-4 p-4 rounded-2xl bg-slate-950/70 border border-cyan-500/20 backdrop-blur-md shadow-[0_0_30px_rgba(6,182,212,0.08)]">
      {/* Panel Header */}
      <div className="flex items-center justify-between pb-2 border-b border-cyan-500/20">
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-pink-400" />
          <h2 className="font-sci-fi text-xs tracking-wider text-cyan-300 uppercase">
            Zoni Soul Core & Matrix
          </h2>
        </div>
        <span className="text-[10px] font-mono text-cyan-400/70">HUD // SYS-01</span>
      </div>

      {/* Global "Zoni Calls You" Section */}
      <div className="p-3 rounded-xl bg-slate-900/60 border border-pink-500/30 shadow-[0_0_15px_rgba(236,72,153,0.1)]">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-1.5">
            <Heart className="w-3.5 h-3.5 text-pink-400 fill-pink-400" />
            <span className="text-[11px] font-hud font-bold text-pink-300 tracking-wider">
              ZONI CALLS YOU:
            </span>
          </div>
          <button
            onClick={() => {
              setIsEditingCustom(!isEditingCustom);
              setCustomInput(currentAffectionName);
            }}
            className="text-[10px] text-cyan-400 hover:text-cyan-300 flex items-center gap-1 font-hud uppercase tracking-wider"
            title="Enter a custom name for Zoni to call you"
          >
            <Edit2 className="w-3 h-3" />
            {isEditingCustom ? 'CLOSE' : 'CUSTOM'}
          </button>
        </div>

        {/* Highlighted Active Name Banner */}
        <div className="flex items-center justify-between p-2 rounded-lg bg-pink-950/40 border border-pink-500/50 mb-2.5">
          <div className="flex items-center gap-2 min-w-0">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-pink-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-pink-500" />
            </span>
            <span className="font-sci-fi text-base font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-pink-300 via-white to-cyan-300 truncate">
              "{currentAffectionName}"
            </span>
          </div>
          <span className="px-1.5 py-0.5 rounded text-[9px] font-mono font-bold bg-pink-500/20 text-pink-300 border border-pink-400/40 shrink-0">
            ACTIVE
          </span>
        </div>

        {/* Custom Input Field */}
        {isEditingCustom && (
          <form onSubmit={handleSaveCustom} className="flex gap-1.5 mb-2.5 animate-in fade-in duration-200">
            <input
              type="text"
              value={customInput}
              onChange={(e) => setCustomInput(e.target.value)}
              placeholder="Enter custom name (e.g. My Love)..."
              className="flex-1 px-2.5 py-1 text-xs rounded-lg bg-slate-950 border border-pink-500/60 text-pink-200 placeholder:text-pink-400/40 focus:outline-none focus:border-pink-400 font-medium"
              autoFocus
            />
            <button
              type="submit"
              disabled={!customInput.trim()}
              className="px-2.5 py-1 bg-pink-600 hover:bg-pink-500 disabled:opacity-40 text-white rounded-lg text-xs font-hud font-bold flex items-center gap-1 shadow-[0_0_10px_rgba(236,72,153,0.4)]"
            >
              <Check className="w-3 h-3" />
              <span>SAVE</span>
            </button>
          </form>
        )}

        {/* Predefined Name Chips with Active Highlight */}
        <div className="space-y-1">
          <span className="text-[9px] font-mono text-cyan-400/70 block uppercase">
            Available Names:
          </span>
          <div className="flex flex-wrap gap-1.5">
            {PREDEFINED_AFFECTION_OPTIONS.map((opt) => {
              const isSelected =
                currentAffectionName.toLowerCase() === opt.value.toLowerCase() ||
                opt.aliases.some((a) => a.toLowerCase() === currentAffectionName.toLowerCase());
              return (
                <button
                  key={opt.value}
                  onClick={() => handleApplyName(opt.value)}
                  className={`px-2.5 py-1 text-xs rounded-lg font-hud tracking-wide transition-all flex items-center gap-1 ${
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

            {/* If a custom name is selected that is not in the predefined list, show highlighted custom chip */}
            {isCustomNameActive && (
              <div className="px-2.5 py-1 text-xs rounded-lg font-hud tracking-wide bg-pink-600/40 border-2 border-pink-400 text-pink-100 font-bold shadow-[0_0_14px_rgba(236,72,153,0.5)] flex items-center gap-1">
                <Check className="w-3 h-3 text-pink-300" />
                <span>Custom: {currentAffectionName}</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Affection Level & Love Booster */}
      <div className="p-3 rounded-xl bg-slate-900/50 border border-pink-500/20">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[11px] font-hud text-pink-300 tracking-wider flex items-center gap-1.5">
            <Heart className="w-3.5 h-3.5 text-pink-500 fill-pink-500 animate-pulse" />
            AFFECTION CORE LEVEL
          </span>
          <span className="font-mono text-xs font-bold text-pink-400">{vitals.affectionLevel}%</span>
        </div>
        {/* Meter Bar */}
        <div className="w-full h-2 rounded-full bg-slate-950 border border-pink-500/30 overflow-hidden relative">
          <div
            className="h-full bg-gradient-to-r from-pink-500 via-rose-400 to-cyan-400 transition-all duration-500"
            style={{ width: `${Math.min(100, vitals.affectionLevel)}%` }}
          />
        </div>
        <button
          onClick={onBoostAffection}
          className="w-full mt-2.5 py-1.5 rounded-lg bg-gradient-to-r from-pink-600/70 to-rose-700/70 hover:from-pink-500 hover:to-rose-600 border border-pink-400/40 text-white text-xs font-hud tracking-wider flex items-center justify-center gap-1.5 transition-all shadow-[0_0_15px_rgba(236,72,153,0.25)] hover:shadow-[0_0_20px_rgba(236,72,153,0.5)]"
        >
          <Heart className="w-3.5 h-3.5 fill-current" />
          <span>ভালোবাসা পাঠান / SEND LOVE (+5% LOVE)</span>
        </button>
      </div>

      {/* Companion Mode Selector */}
      <div className="flex flex-col gap-2">
        <span className="text-[11px] font-hud text-cyan-400 tracking-wider">
          PERSONALITY MATRIX MODE:
        </span>
        <div className="flex flex-col gap-1.5">
          {modes.map((m) => {
            const isActive = vitals.activeMode === m.id;
            return (
              <button
                key={m.id}
                onClick={() => {
                  onSelectMode(m.id);
                  if (vitals.soundFxEnabled) playProceduralSfx('click');
                }}
                className={`p-2.5 rounded-xl border text-left transition-all ${
                  isActive
                    ? `${m.color} shadow-[0_0_15px_rgba(6,182,212,0.25)]`
                    : 'bg-slate-900/30 border-cyan-500/10 text-slate-400 hover:border-cyan-500/30 hover:text-cyan-200'
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
                <p className="text-[10px] text-slate-400 font-normal mt-0.5 ml-6 leading-tight">
                  {m.subtitle}
                </p>
              </button>
            );
          })}
        </div>
      </div>

      {/* Chrome Permissions Status Matrix */}
      <div className="p-3 rounded-xl bg-slate-900/50 border border-cyan-500/20">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-1.5">
            <ShieldCheck className="w-3.5 h-3.5 text-cyan-400" />
            <span className="text-[11px] font-hud text-cyan-300 tracking-wider">
              SYSTEM PERMISSIONS:
            </span>
          </div>
          {onOpenPermissionsModal && (
            <button
              onClick={() => {
                if (vitals.soundFxEnabled) playProceduralSfx('click');
                onOpenPermissionsModal();
              }}
              className="text-[10px] text-pink-400 hover:text-pink-300 font-hud uppercase tracking-wider"
              title="Open Chrome Permissions Hub"
            >
              SETTINGS
            </button>
          )}
        </div>

        <div className="grid grid-cols-3 gap-1.5 text-center font-mono text-[9px]">
          {/* Mic */}
          <div
            className={`p-1.5 rounded-lg border ${
              permissionsReport?.microphone === 'granted'
                ? 'bg-emerald-950/40 border-emerald-500/40 text-emerald-300'
                : permissionsReport?.microphone === 'denied'
                ? 'bg-rose-950/40 border-rose-500/40 text-rose-300'
                : 'bg-slate-950/60 border-slate-700 text-amber-300'
            }`}
          >
            <Mic className="w-3 h-3 mx-auto mb-0.5" />
            <span>MIC: {permissionsReport?.microphone === 'granted' ? 'ON' : permissionsReport?.microphone === 'denied' ? 'OFF' : 'ASK'}</span>
          </div>

          {/* Location */}
          <div
            className={`p-1.5 rounded-lg border ${
              permissionsReport?.geolocation === 'granted'
                ? 'bg-emerald-950/40 border-emerald-500/40 text-emerald-300'
                : permissionsReport?.geolocation === 'denied'
                ? 'bg-rose-950/40 border-rose-500/40 text-rose-300'
                : 'bg-slate-950/60 border-slate-700 text-amber-300'
            }`}
          >
            <MapPin className="w-3 h-3 mx-auto mb-0.5" />
            <span>LOC: {permissionsReport?.geolocation === 'granted' ? 'ON' : permissionsReport?.geolocation === 'denied' ? 'OFF' : 'ASK'}</span>
          </div>

          {/* Notifications */}
          <div
            className={`p-1.5 rounded-lg border ${
              permissionsReport?.notifications === 'granted'
                ? 'bg-emerald-950/40 border-emerald-500/40 text-emerald-300'
                : permissionsReport?.notifications === 'denied'
                ? 'bg-rose-950/40 border-rose-500/40 text-rose-300'
                : 'bg-slate-950/60 border-slate-700 text-amber-300'
            }`}
          >
            <Bell className="w-3 h-3 mx-auto mb-0.5" />
            <span>ALERT: {permissionsReport?.notifications === 'granted' ? 'ON' : permissionsReport?.notifications === 'denied' ? 'OFF' : 'ASK'}</span>
          </div>
        </div>
      </div>
    </div>
  );
};
