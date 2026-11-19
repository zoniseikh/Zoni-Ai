import React from 'react';
import { SystemVitals } from '../types';
import { playProceduralSfx } from '../utils/audio';
import { Mic2, Radio, Sparkles, MessageCircleHeart, Terminal, Zap, Clock } from 'lucide-react';

interface VoiceTelemetryPanelProps {
  vitals: SystemVitals;
  onSelectVoice: (voice: string) => void;
  onTriggerPrompt: (promptText: string) => void;
  isLiveActive: boolean;
}

export const VoiceTelemetryPanel: React.FC<VoiceTelemetryPanelProps> = ({
  vitals,
  onSelectVoice,
  onTriggerPrompt,
  isLiveActive,
}) => {
  const voices = [
    { id: 'Kore', label: 'Kore (Sweet & Warm GF)', desc: 'Lovable, affectionate, natural girlfriend tone' },
    { id: 'Aoede', label: 'Aoede (Melodic Whisper)', desc: 'Gentle, soothing, dreamy & soft' },
    { id: 'Zephyr', label: 'Zephyr (Jarvis Crisp)', desc: 'Smooth, analytical yet caring sci-fi assistant' },
    { id: 'Puck', label: 'Puck (Playful & Bubbly)', desc: 'Cheeky, energetic, laughing & teasing' },
  ];

  const quickPrompts = [
    {
      text: 'বাংলায় কথা বলো',
      icon: <Sparkles className="w-3.5 h-3.5 text-cyan-400" />,
      tag: 'ভাষা: বাংলা',
    },
    {
      text: 'হিন্দিতে কথা বলো',
      icon: <Sparkles className="w-3.5 h-3.5 text-pink-400" />,
      tag: 'भाषा: हिंदी',
    },
    {
      text: 'ইংরেজিতে কথা বলো',
      icon: <Sparkles className="w-3.5 h-3.5 text-amber-400" />,
      tag: 'Lang: English',
    },
    {
      text: 'জনি, এখন কয়টা বাজে? (Current Time IST)',
      icon: <Clock className="w-3.5 h-3.5 text-cyan-300" />,
      tag: 'সময় (IST)',
    },
    {
      text: 'জনি, তুমি আমাকে কতটা ভালোবাসো? ❤️',
      icon: <MessageCircleHeart className="w-3.5 h-3.5 text-rose-400" />,
      tag: 'রোমান্স',
    },
    {
      text: 'What is photosynthesis? (Answer in Bengali)',
      icon: <Terminal className="w-3.5 h-3.5 text-emerald-400" />,
      tag: 'Smart AI',
    },
    {
      text: 'Jarvis protocol: Run diagnostic check on my heart!',
      icon: <Zap className="w-3.5 h-3.5 text-cyan-400" />,
      tag: 'Jarvis GF',
    },
  ];

  return (
    <div className="w-full lg:w-72 xl:w-80 flex flex-col gap-4 p-4 rounded-2xl bg-slate-950/70 border border-cyan-500/20 backdrop-blur-md shadow-[0_0_30px_rgba(6,182,212,0.08)]">
      {/* Panel Header */}
      <div className="flex items-center justify-between pb-2 border-b border-cyan-500/20">
        <div className="flex items-center gap-2">
          <Mic2 className="w-4 h-4 text-cyan-400" />
          <h2 className="font-sci-fi text-xs tracking-wider text-cyan-300 uppercase">
            Voice Matrix & Telemetry
          </h2>
        </div>
        <span className="text-[10px] font-mono text-cyan-400/70">HUD // SYS-02</span>
      </div>

      {/* Voice Modulator Selector */}
      <div className="p-3 rounded-xl bg-slate-900/50 border border-cyan-500/20">
        <span className="text-[11px] font-hud text-cyan-400 tracking-wider block mb-2">
          GEMINI LIVE VOICE MODULATOR:
        </span>
        <div className="flex flex-col gap-1.5">
          {voices.map((v) => {
            const isSelected = vitals.selectedVoice === v.id;
            return (
              <button
                key={v.id}
                onClick={() => {
                  onSelectVoice(v.id);
                  if (vitals.soundFxEnabled) playProceduralSfx('click');
                }}
                className={`p-2 rounded-lg border text-left transition-all ${
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

      {/* Live Stream Telemetry Specs */}
      <div className="p-3 rounded-xl bg-slate-900/50 border border-cyan-500/20 font-mono text-[11px] flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <span className="text-slate-400">PROTOCOL:</span>
          <span className="text-cyan-300 flex items-center gap-1">
            <Radio className="w-3 h-3 text-cyan-400 animate-pulse" />
            WSS // GEMINI-3.8-LIVE
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-slate-400">AUDIO IN / OUT:</span>
          <span className="text-pink-300">16kHz PCM ⇄ 24kHz PCM</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-slate-400">DUPLEX STATUS:</span>
          <span className={isLiveActive ? 'text-emerald-400 font-bold' : 'text-amber-400'}>
            {isLiveActive ? 'STREAMING' : 'READY / PUSH-TO-TALK'}
          </span>
        </div>
      </div>

      {/* Quick Spoken Voice Starters */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-hud text-pink-300 tracking-wider">
            QUICK VOICE STARTERS:
          </span>
          <span className="text-[9px] font-mono text-pink-400/70">TAP TO SPEAK</span>
        </div>
        <div className="flex flex-col gap-1.5">
          {quickPrompts.map((item, idx) => (
            <button
              key={idx}
              onClick={() => {
                onTriggerPrompt(item.text);
                if (vitals.soundFxEnabled) playProceduralSfx('click');
              }}
              className="p-2 rounded-xl bg-slate-900/40 border border-cyan-500/15 hover:border-pink-500/40 hover:bg-slate-900/80 text-left transition-all group flex items-start gap-2"
            >
              <div className="mt-0.5">{item.icon}</div>
              <div className="flex-1">
                <p className="text-xs text-cyan-100 group-hover:text-pink-200 line-clamp-1 leading-snug">
                  {item.text}
                </p>
                <span className="text-[9px] font-mono text-cyan-400/60 uppercase">
                  [{item.tag}]
                </span>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};
