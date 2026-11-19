import React, { useEffect, useRef } from 'react';
import { ChatMessage } from '../types';
import { X, Volume2, Trash2, Heart, Bot, User } from 'lucide-react';

interface ChatTranscriptDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  messages: ChatMessage[];
  onReplayAudio: (text: string) => void;
  onClearMessages: () => void;
  selectedAffectionName?: string;
  userNickname?: string;
}

export const ChatTranscriptDrawer: React.FC<ChatTranscriptDrawerProps> = ({
  isOpen,
  onClose,
  messages,
  onReplayAudio,
  onClearMessages,
  selectedAffectionName,
  userNickname,
}) => {
  const activeName = (selectedAffectionName || userNickname || 'BOSS').toUpperCase();
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, isOpen]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-end bg-black/60 backdrop-blur-sm transition-all p-2 sm:p-4">
      <div className="w-full max-w-lg h-full max-h-[90vh] rounded-2xl bg-slate-950/95 border border-cyan-500/30 flex flex-col shadow-[0_0_50px_rgba(6,182,212,0.3)] overflow-hidden animate-in fade-in slide-in-from-right duration-300">
        {/* Drawer Header */}
        <div className="flex items-center justify-between p-4 border-b border-cyan-500/20 bg-slate-900/40">
          <div className="flex items-center gap-2">
            <Heart className="w-4 h-4 text-pink-400 fill-pink-500" />
            <div>
              <h3 className="font-sci-fi text-sm font-bold tracking-wider text-cyan-200">
                TRANSCRIPT ARCHIVE
              </h3>
              <p className="text-[10px] font-mono text-cyan-400/70">
                ZONI & {activeName} LOGS
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {messages.length > 0 && (
              <button
                onClick={onClearMessages}
                className="p-1.5 rounded-lg border border-rose-500/30 text-rose-400 hover:bg-rose-950/40 transition-colors"
                title="Clear History"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            )}
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg border border-cyan-500/30 text-cyan-400 hover:bg-cyan-950/40 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Message Log */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3.5 hud-scanline">
          {messages.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center p-6 text-slate-500">
              <Bot className="w-8 h-8 text-cyan-500/40 mb-2 animate-pulse" />
              <p className="font-hud text-sm text-cyan-400/60">No transcripts recorded yet.</p>
              <p className="text-xs text-slate-500 mt-1">
                Start talking to Zoni via the live voice link or text input!
              </p>
            </div>
          ) : (
            messages.map((m) => {
              const isAssistant = m.role === 'assistant';
              return (
                <div
                  key={m.id}
                  className={`flex flex-col ${isAssistant ? 'items-start' : 'items-end'}`}
                >
                  <div className="flex items-center gap-1.5 mb-1 px-1 text-[10px] font-mono">
                    {isAssistant ? (
                      <>
                        <Heart className="w-3 h-3 text-pink-400 fill-pink-400" />
                        <span className="text-pink-300 font-semibold">ZONI (GIRLFRIEND)</span>
                      </>
                    ) : (
                      <>
                        <User className="w-3 h-3 text-cyan-400" />
                        <span className="text-cyan-300 font-semibold">{activeName}</span>
                      </>
                    )}
                    <span className="text-slate-500">
                      {new Date(m.timestamp).toLocaleTimeString('en-IN', {
                        timeZone: 'Asia/Kolkata',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}{' '}
                      IST
                    </span>
                  </div>

                  <div
                    className={`max-w-[88%] p-3 rounded-2xl text-xs sm:text-sm leading-relaxed backdrop-blur-md ${
                      isAssistant
                        ? 'bg-slate-900/80 border border-pink-500/30 text-pink-50 rounded-tl-sm shadow-[0_0_15px_rgba(236,72,153,0.15)]'
                        : 'bg-cyan-950/50 border border-cyan-400/40 text-cyan-50 rounded-tr-sm shadow-[0_0_15px_rgba(6,182,212,0.15)]'
                    }`}
                  >
                    <p className="whitespace-pre-wrap">{m.text}</p>
                    {isAssistant && (
                      <div className="mt-2 pt-1 border-t border-pink-500/20 flex justify-end">
                        <button
                          onClick={() => onReplayAudio(m.text)}
                          className="flex items-center gap-1 text-[10px] font-hud text-pink-300 hover:text-pink-200 transition-colors"
                        >
                          <Volume2 className="w-3 h-3" />
                          <span>REPLAY VOICE</span>
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};
