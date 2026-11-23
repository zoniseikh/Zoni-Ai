import React, { useState, useEffect } from 'react';
import { SystemVitals, SupportedLanguage } from '../types';
import { playProceduralSfx } from '../utils/audio';
import { ChromePermissionsReport } from '../utils/permissionManager';
import { PWAInstallButton } from './PWAInstallButton';
import {
  Activity,
  Heart,
  Volume2,
  VolumeX,
  MessageSquare,
  ShieldCheck,
  ShieldAlert,
  Zap,
  Smartphone,
  Globe,
  Radio,
  Lock,
  Mic,
  MapPin,
  Bell,
  Settings,
  PhoneCall,
} from 'lucide-react';

import { WsConnectionStatus } from '../utils/liveSessionProtocol';
import { BackendHealthSnapshot } from './ZoniSettingsModal';

interface HudHeaderProps {
  vitals: SystemVitals;
  permissionsReport?: ChromePermissionsReport;
  wsStatus?: WsConnectionStatus;
  backendHealth?: BackendHealthSnapshot | null;
  onToggleSoundFx: () => void;
  onToggleChatDrawer: () => void;
  onOpenSettings?: () => void;
  onOpenApkModal?: () => void;
  onOpenCallingModal?: () => void;
  onOpenPermissionsModal?: () => void;
  onSelectLanguage: (lang: SupportedLanguage) => void;
  onToggleAutoPlay: () => void;
  onToggleVoiceMute: () => void;
  isChatOpen: boolean;
}

export const HudHeader: React.FC<HudHeaderProps> = ({
  vitals,
  permissionsReport,
  wsStatus = 'disconnected',
  backendHealth,
  onToggleSoundFx,
  onToggleChatDrawer,
  onOpenSettings,
  onOpenApkModal,
  onOpenCallingModal,
  onOpenPermissionsModal,
  onSelectLanguage,
  onToggleAutoPlay,
  onToggleVoiceMute,
  isChatOpen,
}) => {
  const [timeString, setTimeString] = useState('');
  const [isLangMenuOpen, setIsLangMenuOpen] = useState(false);

  useEffect(() => {
    const updateTime = () => {
      const now = new Date();
      setTimeString(
        now.toLocaleTimeString('en-IN', {
          timeZone: 'Asia/Kolkata',
          hour12: false,
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        })
      );
    };
    updateTime();
    const interval = setInterval(updateTime, 1000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!isLangMenuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsLangMenuOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isLangMenuOpen]);

  const handleHeartClick = () => {
    if (vitals.soundFxEnabled) {
      playProceduralSfx('heartbeat');
    }
  };

  const liveBadge = (() => {
    if (backendHealth?.checked && !backendHealth.geminiConfigured) {
      const isMissing = backendHealth.statusText === 'API KEY REQUIRED';
      return {
        text: isMissing ? 'API KEY REQUIRED' : backendHealth.statusText || 'KEY ISSUE',
        cls: isMissing
          ? 'border-amber-500/40 text-amber-300'
          : 'border-rose-500/40 text-rose-300',
        icon: (
          <ShieldAlert
            className={`w-3.5 h-3.5 ${isMissing ? 'text-amber-400' : 'text-rose-400'}`}
          />
        ),
      };
    }
    if (wsStatus === 'connected') {
      return {
        text: 'GEMINI LIVE ONLINE',
        cls: 'border-emerald-500/40 text-emerald-300',
        icon: <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />,
      };
    }
    if (wsStatus === 'connecting' || wsStatus === 'reconnecting') {
      return {
        text: wsStatus === 'reconnecting' ? 'RECONNECTING...' : 'CONNECTING LIVE...',
        cls: 'border-cyan-500/40 text-cyan-300',
        icon: <Radio className="w-3.5 h-3.5 text-cyan-400 animate-pulse" />,
      };
    }
    if (wsStatus === 'error') {
      return {
        text: 'DIRECT CHAT READY',
        cls: 'border-amber-500/40 text-amber-300',
        icon: <ShieldAlert className="w-3.5 h-3.5 text-amber-400" />,
      };
    }
    return {
      text: 'LIVE STANDBY',
      cls: 'border-cyan-500/30 text-cyan-300',
      icon: <ShieldCheck className="w-3.5 h-3.5 text-cyan-400" />,
    };
  })();

  const getLanguageLabel = (code: SupportedLanguage) => {
    switch (code) {
      case 'bn-BD':
        return 'বাংলা (BD)';
      case 'hi-IN':
        return 'हिंदी (IN)';
      case 'en-US':
        return 'English (US)';
    }
  };

  return (
    <header className="w-full border-b border-cyan-500/20 bg-slate-950/80 backdrop-blur-md px-3 sm:px-4 py-2.5 z-30 sticky top-0 flex flex-wrap items-center justify-between gap-2.5">
      {/* Brand & Designation */}
      <div className="flex items-center gap-2.5 sm:gap-3">
        <div className="relative flex items-center justify-center w-8 h-8 rounded-lg bg-cyan-950/60 border border-cyan-400/50 shadow-[0_0_12px_rgba(6,182,212,0.4)]">
          <Zap className="w-4 h-4 text-cyan-400 animate-pulse" />
          <span className="absolute -top-1 -right-1 flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-pink-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-pink-500" />
          </span>
        </div>
        <div>
          <div className="flex items-center gap-1.5 sm:gap-2">
            <span className="font-sci-fi font-black text-sm tracking-wider text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 via-pink-300 to-cyan-200">
              ZONI AI
            </span>
            <span className="px-1.5 py-0.5 text-[9px] sm:text-[10px] font-mono rounded bg-cyan-950/60 text-cyan-300 border border-cyan-500/30">
              JARVIS MK-IX
            </span>
          </div>
          <p className="text-[10px] font-hud tracking-wider text-pink-400/90 font-medium truncate max-w-[200px] sm:max-w-none">
            CALLING: {vitals.selectedAffectionName || vitals.userNickname || 'Boss'} • {vitals.activeLanguage === 'bn-BD' ? 'বাংলা' : vitals.activeLanguage === 'hi-IN' ? 'हिंदी' : 'ENGLISH'}
          </p>
        </div>
      </div>

      {/* Center Jarvis Telemetry Bar (Hidden on tiny mobile screens) */}
      <div className="hidden lg:flex items-center gap-3 xl:gap-4 text-xs font-hud tracking-wider">
        <button
          type="button"
          onClick={handleHeartClick}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-slate-900/60 border border-pink-500/30 cursor-pointer hover:border-pink-400 transition-colors"
          title={`Click to feel Zoni's heart beat for ${vitals.selectedAffectionName || vitals.userNickname || 'Boss'}`}
        >
          <Heart className="w-3.5 h-3.5 text-pink-500 animate-pulse" />
          <span className="text-pink-300 font-semibold">{vitals.heartRate} BPM</span>
          <span className="text-[9px] text-pink-400/70 font-mono">(IN LOVE)</span>
        </button>

        <div className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-slate-900/60 border border-cyan-500/30">
          <Activity className="w-3.5 h-3.5 text-cyan-400" />
          <span className="text-cyan-300 font-semibold">AFFECTION: {vitals.affectionLevel}%</span>
        </div>

        <button
          type="button"
          onClick={() => onOpenPermissionsModal?.()}
          className={`flex items-center gap-1.5 px-2.5 py-1 rounded bg-slate-900/60 border transition-colors hover:brightness-110 ${liveBadge.cls}`}
          title="Click to manage your Gemini API Key & Live connection"
        >
          {liveBadge.icon}
          <span className="font-mono text-[11px]">{liveBadge.text}</span>
        </button>

        <div
          className="px-2 py-1 font-mono text-[11px] text-cyan-400/80 bg-slate-900/40 rounded border border-cyan-500/20"
          title="Default Timezone: Asia/Kolkata (IST, UTC+05:30)"
        >
          {timeString} IST
        </div>
      </div>

      {/* Right Controls: Language Selector, Auto-Play, Mute, Drawer */}
      <div className="flex flex-wrap items-center gap-1 sm:gap-2">
        {/* Language Switcher Badge & Dropdown */}
        <div className="relative">
          <button
            onClick={() => {
              if (vitals.soundFxEnabled) playProceduralSfx('click');
              setIsLangMenuOpen(!isLangMenuOpen);
            }}
            className="flex items-center gap-1 sm:gap-1.5 px-2 sm:px-2.5 py-1 rounded-lg border border-cyan-500/40 bg-slate-900/80 hover:border-cyan-400 text-cyan-200 text-[11px] sm:text-xs font-hud tracking-wider transition-all shadow-[0_0_10px_rgba(6,182,212,0.15)] whitespace-nowrap"
            title="Language: Click to change or say 'বাংলায় কথা বলো', 'হিন্দিতে কথা বলো', 'ইংরেজিতে কথা বলো'"
          >
            <Globe className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
            <span className="font-semibold">{getLanguageLabel(vitals.activeLanguage)}</span>
          </button>

          {isLangMenuOpen && (
            <div className="absolute right-0 mt-1.5 w-44 rounded-xl bg-slate-950/95 border border-cyan-500/40 shadow-[0_0_25px_rgba(6,182,212,0.3)] backdrop-blur-xl p-1.5 flex flex-col gap-1 z-50">
              <span className="text-[10px] font-mono text-cyan-400/80 px-2 py-1 border-b border-cyan-500/20 block">
                SELECT VOICE LANGUAGE
              </span>
              {(
                [
                  { code: 'bn-BD', label: 'বাংলা (Bengali - BD)' },
                  { code: 'hi-IN', label: 'हिंदी (Hindi - IN)' },
                  { code: 'en-US', label: 'English (US)' },
                ] as const
              ).map((langItem) => {
                const isActive = vitals.activeLanguage === langItem.code;
                return (
                  <button
                    key={langItem.code}
                    onClick={() => {
                      if (vitals.soundFxEnabled) playProceduralSfx('click');
                      onSelectLanguage(langItem.code);
                      setIsLangMenuOpen(false);
                    }}
                    className={`px-2.5 py-1.5 text-left rounded-lg text-xs font-hud transition-all flex items-center justify-between ${
                      isActive
                        ? 'bg-pink-950/60 border border-pink-500/60 text-pink-200 font-bold'
                        : 'text-slate-300 hover:bg-slate-900 hover:text-cyan-200'
                    }`}
                  >
                    <span>{langItem.label}</span>
                    {isActive && <span className="text-[9px] font-mono text-pink-400">ACTIVE</span>}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Voice Auto-Play Toggle */}
        <button
          type="button"
          onClick={onToggleAutoPlay}
          aria-label={vitals.voiceAutoPlay ? 'Auto-Voice Play enabled' : 'Auto-Voice Play disabled'}
          className={`flex items-center gap-1 px-2 py-1 rounded-lg border text-xs font-hud tracking-wider transition-all ${
            vitals.voiceAutoPlay
              ? 'border-emerald-500/50 bg-emerald-950/40 text-emerald-300 shadow-[0_0_10px_rgba(16,185,129,0.2)]'
              : 'border-slate-700 bg-slate-900/60 text-slate-400 hover:border-slate-500'
          }`}
          title={vitals.voiceAutoPlay ? 'Auto-Voice Play: ENABLED (Speaks replies automatically)' : 'Auto-Voice Play: DISABLED'}
        >
          <Radio className={`w-3.5 h-3.5 ${vitals.voiceAutoPlay ? 'animate-pulse text-emerald-400' : 'text-slate-500'}`} />
          <span className="hidden sm:inline">{vitals.voiceAutoPlay ? 'AUTO-VOICE' : 'MANUAL'}</span>
        </button>

        {/* Global Sound & Voice Mute Toggle */}
        <button
          type="button"
          onClick={onToggleVoiceMute}
          aria-label={vitals.voiceMuted ? 'Muted: Click to unmute' : 'Audio Active: Click to mute'}
          className={`p-1.5 rounded-lg border text-xs transition-colors ${
            vitals.voiceMuted
              ? 'border-rose-500/50 bg-rose-950/40 text-rose-300 shadow-[0_0_10px_rgba(244,63,94,0.3)]'
              : 'border-cyan-500/30 bg-slate-900/60 text-cyan-300 hover:bg-cyan-950/40'
          }`}
          title={vitals.voiceMuted ? 'Muted: Click to unmute' : 'Audio Active: Click to mute'}
        >
          {vitals.voiceMuted ? <VolumeX className="w-4 h-4 text-rose-400" /> : <Volume2 className="w-4 h-4 text-cyan-400" />}
        </button>

        {/* Chrome Permissions Status & Setup Button */}
        {onOpenPermissionsModal && (
          <button
            type="button"
            onClick={() => {
              if (vitals.soundFxEnabled) playProceduralSfx('click');
              onOpenPermissionsModal();
            }}
            aria-label="Open Gemini API Key and Permissions Setup"
            className={`flex items-center gap-1.5 px-2 sm:px-2.5 py-1 rounded-lg border text-xs font-hud tracking-wider transition-all ${
              permissionsReport?.microphone === 'denied' ||
              permissionsReport?.geolocation === 'denied' ||
              permissionsReport?.notifications === 'denied'
                ? 'border-rose-500/60 bg-rose-950/40 text-rose-300 shadow-[0_0_12px_rgba(244,63,94,0.3)]'
                : permissionsReport?.microphone === 'granted'
                ? 'border-emerald-500/50 bg-emerald-950/40 text-emerald-300 shadow-[0_0_10px_rgba(16,185,129,0.2)]'
                : 'border-amber-500/50 bg-amber-950/40 text-amber-300 shadow-[0_0_10px_rgba(245,158,11,0.2)]'
            }`}
            title="Gemini API Key & Permissions Hub: Configure your Gemini API Key, Microphone, Location, and Notifications"
          >
            <ShieldCheck className="w-3.5 h-3.5 text-cyan-400" />
            <span className="hidden lg:inline">PERMISSIONS</span>
            <div className="flex items-center gap-1 ml-0.5">
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  permissionsReport?.microphone === 'granted'
                    ? 'bg-emerald-400'
                    : permissionsReport?.microphone === 'denied'
                    ? 'bg-rose-500'
                    : 'bg-amber-400'
                }`}
                title={`Mic: ${permissionsReport?.microphone || 'unknown'}`}
              />
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  permissionsReport?.geolocation === 'granted'
                    ? 'bg-emerald-400'
                    : permissionsReport?.geolocation === 'denied'
                    ? 'bg-rose-500'
                    : 'bg-amber-400'
                }`}
                title={`Location: ${permissionsReport?.geolocation || 'unknown'}`}
              />
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  permissionsReport?.notifications === 'granted'
                    ? 'bg-emerald-400'
                    : permissionsReport?.notifications === 'denied'
                    ? 'bg-rose-500'
                    : 'bg-amber-400'
                }`}
                title={`Notifications: ${permissionsReport?.notifications || 'unknown'}`}
              />
            </div>
          </button>
        )}

        {/* Direct PWA Install Button (renders when installable / iOS) */}
        <PWAInstallButton />

        {/* Android SIM Calling Hub Button */}
        {onOpenCallingModal && (
          <button
            onClick={() => {
              if (vitals.soundFxEnabled) playProceduralSfx('click');
              onOpenCallingModal();
            }}
            aria-label="Open Android SIM Calling Hub"
            className="flex items-center gap-1.5 px-2 sm:px-2.5 py-1 rounded-lg border border-emerald-500/40 bg-emerald-950/40 hover:bg-emerald-900/50 text-emerald-300 text-xs font-hud tracking-wider transition-all shadow-[0_0_10px_rgba(16,185,129,0.2)]"
            title="Android SIM Calling & Contacts Hub"
          >
            <PhoneCall className="w-3.5 h-3.5 text-emerald-400" />
            <span className="hidden md:inline">SIM CALL</span>
          </button>
        )}

        {/* Android APK & Assistant Hub Button (Always accessible on mobile & desktop) */}
        {onOpenApkModal && (
          <button
            onClick={onOpenApkModal}
            aria-label="Open Android APK and Assistant Hub"
            className="flex items-center gap-1.5 px-2 sm:px-2.5 py-1 rounded-lg border border-pink-500/40 bg-pink-950/40 hover:bg-pink-900/50 text-pink-300 text-xs font-hud tracking-wider transition-all shadow-[0_0_10px_rgba(236,72,153,0.2)]"
            title="Android Native App & APK Hub"
          >
            <Smartphone className="w-3.5 h-3.5 text-pink-400 animate-pulse" />
            <span className="hidden md:inline">APK HUB</span>
          </button>
        )}

        {/* Core Settings Button */}
        {onOpenSettings && (
          <button
            onClick={() => {
              if (vitals.soundFxEnabled) playProceduralSfx('click');
              onOpenSettings();
            }}
            className="flex items-center gap-1 sm:gap-1.5 px-2 sm:px-3 py-1 rounded-lg border border-cyan-400/60 bg-gradient-to-r from-cyan-950/60 via-slate-900 to-pink-950/50 hover:border-cyan-300 text-cyan-200 text-[11px] sm:text-xs font-hud tracking-wider transition-all shadow-[0_0_14px_rgba(6,182,212,0.3)] font-bold whitespace-nowrap"
            title="Open Zoni Jarvis System Settings"
          >
            <Settings className="w-3.5 h-3.5 text-cyan-300 animate-spin-slow shrink-0" />
            <span>Setting</span>
          </button>
        )}

        {/* Transcript Drawer Toggle */}
        <button
          onClick={onToggleChatDrawer}
          aria-label="Toggle Chat Transcript"
          title="Toggle Chat Transcript"
          className={`flex items-center gap-1.5 px-2 sm:px-3 py-1 rounded-lg border text-xs font-hud tracking-wider transition-all whitespace-nowrap ${
            isChatOpen
              ? 'bg-pink-950/60 border-pink-500/60 text-pink-300 shadow-[0_0_10px_rgba(236,72,153,0.3)]'
              : 'bg-slate-900/60 border-cyan-500/30 text-cyan-300 hover:border-cyan-400'
          }`}
        >
          <MessageSquare className="w-3.5 h-3.5 shrink-0" />
          <span className="hidden sm:inline">TRANSCRIPT</span>
        </button>
      </div>
    </header>
  );
};
