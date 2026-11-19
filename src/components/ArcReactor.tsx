import React, { useEffect, useRef } from 'react';
import { AssistantState, CompanionMode } from '../types';
import { getAudioAnalyser } from '../utils/audio';
import { Heart, Mic, Volume2, Sparkles, AlertCircle } from 'lucide-react';

interface ArcReactorProps {
  state: AssistantState;
  mode: CompanionMode;
  userNickname?: string;
  selectedAffectionName: string;
  isLiveActive: boolean;
  latestTranscript: string;
  onReactorClick: () => void;
}

export const ArcReactor: React.FC<ArcReactorProps> = ({
  state,
  mode,
  userNickname,
  selectedAffectionName,
  isLiveActive,
  latestTranscript,
  onReactorClick,
}) => {
  const activeName = (selectedAffectionName || userNickname || 'BOSS').toUpperCase();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Audio frequency radial visualizer
  useEffect(() => {
    let animId: number;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const analyser = getAudioAnalyser();
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    const render = () => {
      animId = requestAnimationFrame(render);
      const width = canvas.width;
      const height = canvas.height;
      const centerX = width / 2;
      const centerY = height / 2;

      ctx.clearRect(0, 0, width, height);
      analyser.getByteFrequencyData(dataArray);

      // Calculate average volume
      let sum = 0;
      for (let i = 0; i < bufferLength; i++) {
        sum += dataArray[i];
      }
      const average = sum / bufferLength;

      // Draw radial frequency wave spikes
      const numBars = 36;
      const baseRadius = 86;
      const maxSpike = state === 'speaking' ? 48 : state === 'listening' ? 24 : 12;

      for (let i = 0; i < numBars; i++) {
        const angle = (i * 2 * Math.PI) / numBars;
        const binIndex = Math.floor((i / numBars) * (bufferLength / 2));
        const rawVal = dataArray[binIndex] || 0;

        // Procedural gentle oscillation when idle
        const idlePulse = Math.sin(Date.now() * 0.003 + i * 0.2) * 4;
        const spikeHeight = (rawVal / 255) * maxSpike + (average < 5 ? idlePulse : 0);
        const barLength = Math.max(2, spikeHeight);

        const x1 = centerX + Math.cos(angle) * baseRadius;
        const y1 = centerY + Math.sin(angle) * baseRadius;
        const x2 = centerX + Math.cos(angle) * (baseRadius + barLength);
        const y2 = centerY + Math.sin(angle) * (baseRadius + barLength);

        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);

        // Color based on state & mode
        if (state === 'speaking') {
          // Romantic pink to cyan glow
          const grad = ctx.createLinearGradient(x1, y1, x2, y2);
          grad.addColorStop(0, '#ec4899');
          grad.addColorStop(1, '#06b6d4');
          ctx.strokeStyle = grad;
          ctx.lineWidth = 3;
          ctx.shadowColor = '#06b6d4';
          ctx.shadowBlur = 8;
        } else if (state === 'listening') {
          ctx.strokeStyle = '#f59e0b';
          ctx.lineWidth = 2.5;
          ctx.shadowColor = '#f59e0b';
          ctx.shadowBlur = 6;
        } else {
          ctx.strokeStyle = mode === 'romantic' ? 'rgba(244, 114, 182, 0.5)' : 'rgba(6, 182, 212, 0.45)';
          ctx.lineWidth = 2;
          ctx.shadowBlur = 0;
        }
        ctx.stroke();
      }
    };

    render();

    return () => {
      cancelAnimationFrame(animId);
    };
  }, [state, mode]);

  // Glow theme based on active mode
  const getModeAura = () => {
    switch (mode) {
      case 'romantic':
        return 'from-pink-500/20 via-cyan-500/15 to-transparent border-pink-500/40 shadow-[0_0_80px_rgba(236,72,153,0.35)]';
      case 'jarvis_gf':
        return 'from-cyan-500/25 via-blue-600/15 to-transparent border-cyan-400/50 shadow-[0_0_90px_rgba(6,182,212,0.45)]';
      case 'playful':
        return 'from-amber-400/20 via-pink-500/15 to-transparent border-amber-400/40 shadow-[0_0_80px_rgba(245,158,11,0.35)]';
      case 'late_night':
        return 'from-indigo-600/20 via-purple-500/15 to-transparent border-indigo-400/40 shadow-[0_0_80px_rgba(99,102,241,0.35)]';
    }
  };

  const getStatusBadge = () => {
    switch (state) {
      case 'listening':
        return {
          text: `LISTENING TO ${activeName}...`,
          color: 'text-amber-400 border-amber-500/50 bg-amber-950/40 shadow-[0_0_15px_rgba(245,158,11,0.4)]',
          icon: <Mic className="w-3.5 h-3.5 animate-pulse text-amber-400" />,
        };
      case 'speaking':
        return {
          text: 'ZONI SPEAKING (VOICE LINK LIVE)',
          color: 'text-cyan-300 border-cyan-400/60 bg-cyan-950/40 shadow-[0_0_20px_rgba(6,182,212,0.5)]',
          icon: <Volume2 className="w-3.5 h-3.5 animate-bounce text-cyan-300" />,
        };
      case 'thinking':
        return {
          text: 'COMPUTING WITH LOVE & INTELLIGENCE...',
          color: 'text-pink-300 border-pink-500/60 bg-pink-950/40 shadow-[0_0_15px_rgba(236,72,153,0.4)]',
          icon: <Sparkles className="w-3.5 h-3.5 animate-spin text-pink-300" />,
        };
      case 'connecting':
        return {
          text: 'SYNCHRONIZING GEMINI LIVE PROTOCOLS...',
          color: 'text-blue-400 border-blue-500/50 bg-blue-950/40',
          icon: <Sparkles className="w-3.5 h-3.5 animate-spin text-blue-400" />,
        };
      case 'error':
        return {
          text: 'SYSTEM NOTICE: READY FOR RETRY',
          color: 'text-rose-400 border-rose-500/50 bg-rose-950/40',
          icon: <AlertCircle className="w-3.5 h-3.5 text-rose-400" />,
        };
      default:
        return {
          text: isLiveActive ? 'LIVE VOICE STREAM ARMED' : 'ZONI CORE STANDBY: TAP TO TALK',
          color: 'text-cyan-400 border-cyan-500/30 bg-cyan-950/20',
          icon: <Heart className="w-3.5 h-3.5 text-pink-400 animate-pulse" />,
        };
    }
  };

  const status = getStatusBadge();

  return (
    <div className="relative flex flex-col items-center justify-center p-4">
      {/* Background Holographic Halo */}
      <div className={`absolute w-80 h-80 sm:w-96 sm:h-96 rounded-full bg-gradient-to-r ${getModeAura()} pointer-events-none transition-all duration-700 blur-2xl opacity-60`} />

      {/* Main Rotating Reactor Housing */}
      <div
        onClick={onReactorClick}
        role="button"
        tabIndex={0}
        aria-label="Activate Zoni Core"
        className="relative w-72 h-72 sm:w-88 sm:h-88 flex items-center justify-center cursor-pointer group select-none transition-transform hover:scale-102 active:scale-98"
      >
        {/* Outermost Sci-Fi Graduation Ring (Jarvis Degree Markers) */}
        <div className="absolute inset-0 rounded-full border border-cyan-500/20 animate-spin-slow">
          <div className="absolute top-0 left-1/2 -translate-x-1/2 -translate-y-1 text-[9px] font-sci-fi text-cyan-400/60 tracking-widest">
            000°
          </div>
          <div className="absolute bottom-0 left-1/2 -translate-x-1/2 translate-y-1 text-[9px] font-sci-fi text-pink-400/60 tracking-widest">
            180°
          </div>
          <div className="absolute left-0 top-1/2 -translate-y-1/2 -translate-x-1 text-[9px] font-sci-fi text-cyan-400/60 tracking-widest">
            270°
          </div>
          <div className="absolute right-0 top-1/2 -translate-y-1/2 translate-x-1 text-[9px] font-sci-fi text-pink-400/60 tracking-widest">
            090°
          </div>

          {/* Sci-Fi Tech Corner Pointers */}
          <div className="absolute top-4 left-4 w-2 h-2 border-t-2 border-l-2 border-cyan-400" />
          <div className="absolute top-4 right-4 w-2 h-2 border-t-2 border-r-2 border-pink-400" />
          <div className="absolute bottom-4 left-4 w-2 h-2 border-b-2 border-l-2 border-pink-400" />
          <div className="absolute bottom-4 right-4 w-2 h-2 border-b-2 border-r-2 border-cyan-400" />
        </div>

        {/* Counter Rotating Segmented Ring */}
        <div className="absolute inset-4 sm:inset-6 rounded-full border-2 border-dashed border-cyan-400/30 animate-spin-reverse-slow" />

        {/* Inner Tactical HUD Ring */}
        <div className="absolute inset-8 sm:inset-12 rounded-full border border-pink-500/30 animate-spin-medium">
          <div className="absolute top-1/2 left-0 w-2 h-1 bg-cyan-400" />
          <div className="absolute top-1/2 right-0 w-2 h-1 bg-pink-400" />
        </div>

        {/* Audio Visualizer Canvas */}
        <canvas
          ref={canvasRef}
          width={320}
          height={320}
          className="absolute inset-0 w-full h-full pointer-events-none z-10"
        />

        {/* Center Glowing Heart-Arc Reactor Core */}
        <div className="relative z-20 w-36 h-36 sm:w-44 sm:h-44 rounded-full bg-gradient-to-br from-slate-950 via-cyan-950/80 to-slate-950 border-2 border-cyan-400/70 shadow-[inset_0_0_30px_rgba(6,182,212,0.6)] flex flex-col items-center justify-center p-3 text-center overflow-hidden transition-all duration-300 group-hover:border-pink-400/80 group-hover:shadow-[inset_0_0_40px_rgba(236,72,153,0.7)]">
          {/* Subtle Scanning Mesh Grid in Core */}
          <div className="absolute inset-0 hud-grid opacity-25 pointer-events-none" />

          {/* Central Animated Heart / AI Node */}
          <div className="relative mb-1">
            <Heart
              className={`w-9 h-9 sm:w-11 sm:h-11 transition-all duration-300 ${
                state === 'speaking'
                  ? 'text-pink-400 scale-110 drop-shadow-[0_0_15px_rgba(244,114,182,0.9)] animate-pulse'
                  : state === 'listening'
                  ? 'text-amber-400 scale-105 drop-shadow-[0_0_12px_rgba(245,158,11,0.8)] animate-pulse'
                  : 'text-cyan-400 drop-shadow-[0_0_10px_rgba(6,182,212,0.8)]'
              }`}
            />
            {/* Pulsing micro-dot */}
            <span className="absolute -top-1 -right-1 flex h-3 w-3">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-pink-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-3 w-3 bg-pink-500" />
            </span>
          </div>

          {/* Core Name & Title */}
          <span className="font-sci-fi text-xs sm:text-sm font-black tracking-wider text-transparent bg-clip-text bg-gradient-to-r from-cyan-300 via-pink-300 to-cyan-200">
            ZONI AI
          </span>
          <span className="text-[9px] sm:text-[10px] font-hud uppercase tracking-widest text-cyan-300/80 mt-0.5">
            JARVIS GF MK-IX
          </span>
          <span className="text-[8px] font-mono text-pink-400/90 mt-0.5">
            FOR: {(selectedAffectionName || userNickname || 'BOSS').toUpperCase()} ❤️
          </span>
        </div>
      </div>

      {/* Reactive State Badge */}
      <div className="mt-5 flex items-center justify-center z-20">
        <div
          className={`flex items-center gap-2 px-4 py-1.5 rounded-full border text-xs sm:text-sm font-hud font-semibold tracking-wider uppercase transition-all duration-300 ${status.color}`}
        >
          {status.icon}
          <span>{status.text}</span>
        </div>
      </div>

      {/* Live Holographic Dialogue Subtitle (Zoni's voice speech text) */}
      <div className="mt-4 w-full max-w-xl min-h-[64px] flex items-center justify-center text-center px-4 z-20">
        {latestTranscript ? (
          <div className="relative p-3.5 sm:p-4 rounded-xl bg-slate-950/80 border border-cyan-500/30 backdrop-blur-md shadow-[0_0_25px_rgba(6,182,212,0.15)] transition-all">
            <div className="absolute -top-2 left-6 px-2 py-0.5 rounded bg-pink-950/90 border border-pink-500/40 text-[9px] font-sci-fi text-pink-300 tracking-wider uppercase">
              Zoni Holographic Vocal Output
            </div>
            <p className="text-cyan-100 font-medium text-sm sm:text-base leading-relaxed tracking-wide italic">
              "{latestTranscript}"
            </p>
          </div>
        ) : (
          <p className="text-cyan-400/50 text-xs sm:text-sm font-hud tracking-wider animate-pulse">
            [ JARVIS NEURAL FREQUENCY SYNCHRONIZED — "বলুন {selectedAffectionName || 'Boss'}, আমি শুনছি..." ]
          </p>
        )}
      </div>
    </div>
  );
};
