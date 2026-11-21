import React, { useState, useRef, useEffect } from 'react';
import { AssistantState, SupportedLanguage } from '../types';
import { playProceduralSfx } from '../utils/audio';
import { Mic, MicOff, Send, Radio, Square, Sparkles, Volume2 } from 'lucide-react';

interface ControlDockProps {
  state: AssistantState;
  isLiveActive: boolean;
  isMicMuted: boolean;
  activeLanguage?: SupportedLanguage;
  onToggleLiveMode: () => void;
  onToggleMicMute: () => void;
  onSendMessage: (text: string) => void;
  onInterrupt: () => void;
  soundFxEnabled: boolean;
}

export const ControlDock: React.FC<ControlDockProps> = ({
  state,
  isLiveActive,
  isMicMuted,
  activeLanguage = 'bn-BD',
  onToggleLiveMode,
  onToggleMicMute,
  onSendMessage,
  onInterrupt,
  soundFxEnabled,
}) => {
  const [inputText, setInputText] = useState('');
  const [isDictating, setIsDictating] = useState(false);
  const [dictationNotice, setDictationNotice] = useState<string | null>(null);
  const recognitionRef = useRef<any>(null);

  useEffect(() => {
    return () => {
      if (recognitionRef.current) {
        try {
          recognitionRef.current.abort();
        } catch {
          // ignore
        }
      }
    };
  }, []);

  const handleToggleDictation = () => {
    if (isDictating) {
      if (recognitionRef.current) {
        try {
          recognitionRef.current.stop();
        } catch {
          // ignore
        }
      }
      setIsDictating(false);
      return;
    }

    const SpeechRecClass =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    if (!SpeechRecClass) {
      const msg =
        activeLanguage === 'bn-BD'
          ? 'এই ব্রাউজারে স্পিচ ডিক্টেশন সাপোর্টেড নয় — অনুগ্রহ করে টাইপ করুন অথবা Gemini Live ভয়েস চালু করুন।'
          : 'Browser speech dictation is not supported here — type your message or use Gemini Live Voice.';
      setDictationNotice(msg);
      setTimeout(() => setDictationNotice((cur) => (cur === msg ? null : cur)), 4500);
      return;
    }

    try {
      if (soundFxEnabled) playProceduralSfx('click');
      const rec = new SpeechRecClass();
      rec.lang = activeLanguage || 'bn-BD';
      rec.continuous = false;
      rec.interimResults = false;

      rec.onstart = () => {
        setIsDictating(true);
      };

      rec.onresult = (event: any) => {
        const transcript = event.results[0]?.[0]?.transcript;
        if (transcript) {
          setInputText(transcript);
          onSendMessage(transcript);
          setInputText('');
        }
        setIsDictating(false);
      };

      rec.onerror = (e: any) => {
        console.warn('Speech recognition notice:', e.error);
        setIsDictating(false);
      };

      rec.onend = () => {
        setIsDictating(false);
      };

      recognitionRef.current = rec;
      rec.start();
    } catch (err) {
      console.warn('Failed to start speech recognition:', err);
      setIsDictating(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputText.trim()) return;
    if (soundFxEnabled) playProceduralSfx('click');
    onSendMessage(inputText.trim());
    setInputText('');
  };

  return (
    <div className="w-full max-w-4xl px-4 pb-4 pt-2 z-20">
      <div className="p-3 sm:p-4 rounded-2xl bg-slate-950/80 border border-cyan-500/25 backdrop-blur-xl shadow-[0_0_40px_rgba(6,182,212,0.15)] flex flex-col gap-3">
        {/* Main Live Audio Control Buttons Row */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* Primary Live Voice Mode Activation Button */}
          <button
            type="button"
            disabled={state === 'connecting' && !isLiveActive}
            onClick={() => {
              if (soundFxEnabled) playProceduralSfx('boot');
              onToggleLiveMode();
            }}
            className={`flex-1 min-w-[200px] py-2.5 px-4 rounded-xl font-hud font-bold text-sm tracking-wider uppercase flex items-center justify-center gap-2.5 transition-all shadow-lg select-none disabled:opacity-70 disabled:cursor-wait ${
              isLiveActive
                ? 'bg-rose-600 hover:bg-rose-500 text-white shadow-[0_0_25px_rgba(244,63,94,0.6)] border border-rose-400 animate-pulse'
                : state === 'connecting'
                ? 'bg-slate-800 text-cyan-200 border border-cyan-400/60'
                : 'bg-gradient-to-r from-cyan-600 via-pink-600 to-cyan-500 hover:from-cyan-500 hover:via-pink-500 hover:to-cyan-400 text-white shadow-[0_0_25px_rgba(6,182,212,0.4)] border border-cyan-300'
            }`}
          >
            <Radio className={`w-4 h-4 ${isLiveActive || state === 'connecting' ? 'animate-spin' : 'animate-pulse'}`} />
            <span>
              {isLiveActive
                ? 'END GEMINI LIVE CALL'
                : state === 'connecting'
                ? 'CONNECTING GEMINI LIVE...'
                : 'START GEMINI LIVE VOICE LINK'}
            </span>
          </button>

          {/* Controls: Mic Mute & Interrupt */}
          <div className="flex items-center gap-2">
            {/* Mic Mute Toggle */}
            <button
              onClick={() => {
                if (soundFxEnabled) playProceduralSfx('click');
                onToggleMicMute();
              }}
              className={`p-2.5 rounded-xl border text-xs font-hud tracking-wider flex items-center gap-1.5 transition-all ${
                isMicMuted
                  ? 'border-rose-500/60 bg-rose-950/40 text-rose-300 shadow-[0_0_15px_rgba(244,63,94,0.3)]'
                  : 'border-cyan-500/30 bg-slate-900/60 text-cyan-300 hover:border-cyan-400'
              }`}
              title={isMicMuted ? 'Mic Muted' : 'Mic Active'}
            >
              {isMicMuted ? <MicOff className="w-4 h-4 text-rose-400" /> : <Mic className="w-4 h-4 text-cyan-400" />}
              <span className="hidden sm:inline">{isMicMuted ? 'MUTED' : 'MIC ON'}</span>
            </button>

            {/* Stop / Interrupt Button (when Zoni is speaking) */}
            {state === 'speaking' && (
              <button
                onClick={() => {
                  if (soundFxEnabled) playProceduralSfx('click');
                  onInterrupt();
                }}
                className="px-3 py-2.5 rounded-xl border border-amber-500/60 bg-amber-950/40 text-amber-300 text-xs font-hud tracking-wider flex items-center gap-1.5 shadow-[0_0_15px_rgba(245,158,11,0.3)] hover:bg-amber-900/50"
                title="Interrupt Zoni"
              >
                <Square className="w-3.5 h-3.5 fill-current" />
                <span>INTERRUPT</span>
              </button>
            )}
          </div>
        </div>

        {/* Text Input Row for Hybrid Typing */}
        <form onSubmit={handleSubmit} className="relative flex items-center gap-2">
          <div className="relative flex-1">
            <input
              type="text"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              placeholder="বাংলা বা যেকোনো ভাষায় লিখুন (যেমন: 'কেমন আছো জনি?')..."
              className="w-full py-2.5 pl-4 pr-10 rounded-xl bg-slate-900/70 border border-cyan-500/25 text-cyan-100 placeholder:text-cyan-500/40 text-sm focus:outline-none focus:border-cyan-400 focus:shadow-[0_0_15px_rgba(6,182,212,0.25)] font-normal transition-all"
            />
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-pink-400/60 pointer-events-none">
              <Sparkles className="w-4 h-4" />
            </span>
          </div>

          {/* Voice Command Dictation Button */}
          <button
            type="button"
            aria-label={isDictating ? 'Stop voice dictation' : 'Start voice dictation'}
            onClick={handleToggleDictation}
            className={`p-2.5 rounded-xl border transition-all flex items-center justify-center ${
              isDictating
                ? 'border-rose-500 bg-rose-600 text-white animate-pulse shadow-[0_0_20px_rgba(244,63,94,0.7)]'
                : 'border-cyan-500/40 bg-slate-900/70 text-cyan-300 hover:border-pink-400 hover:text-pink-300 shadow-[0_0_10px_rgba(6,182,212,0.15)]'
            }`}
            title={
              isDictating
                ? 'শুনছি... কথা শেষ হলে স্বয়ংক্রিয়ভাবে পাঠানো হবে'
                : 'ভয়েস কম্যান্ড দিন (যেমন: বাংলায় কথা বলো, কয়টা বাজে)'
            }
          >
            <Mic className={`w-4 h-4 ${isDictating ? 'scale-110' : ''}`} />
          </button>

          <button
            type="submit"
            aria-label="Send message"
            disabled={!inputText.trim() || state === 'thinking'}
            className="p-2.5 rounded-xl bg-gradient-to-r from-cyan-600 to-pink-600 hover:from-cyan-500 hover:to-pink-500 disabled:opacity-40 disabled:cursor-not-allowed text-white shadow-[0_0_15px_rgba(6,182,212,0.3)] transition-all"
            title="Send Message"
          >
            <Send className="w-4 h-4" />
          </button>
        </form>
        {dictationNotice && (
          <p className="text-[11px] text-amber-300 font-hud px-1">{dictationNotice}</p>
        )}
      </div>
    </div>
  );
};
