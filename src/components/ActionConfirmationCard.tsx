import React, { useEffect, useRef } from 'react';
import { XCircle, MessageSquare, PhoneCall, UserCheck } from 'lucide-react';
import type { SupportedLanguage } from '../types';

export interface PendingContactCandidate {
  id?: string;
  name: string;
  phone: string;
}

export interface PendingActionDraftState {
  pendingActionId: string;
  actionType:
    | 'prepare_whatsapp_message'
    | 'prepare_sms'
    | 'call_contact'
    | 'prepare_app_chat_message';
  appName?: string;
  recipientName: string;
  phoneNumber: string;
  messageText: string;
  candidates?: PendingContactCandidate[];
  canReplyViaNotification?: boolean;
  notificationKey?: string;
  isNativePending?: boolean;
  statusNote?: string;
}

interface ActionConfirmationCardProps {
  draft: PendingActionDraftState | null;
  activeLanguage: SupportedLanguage;
  onApprove: (options: {
    pendingActionId: string;
    recipientName: string;
    phoneNumber: string;
    messageText: string;
    useNotificationReply: boolean;
  }) => void;
  onCancel: (pendingActionId: string) => void;
}

/**
 * Contact Disambiguation Picker (ONLY shown when multiple contacts or multiple phone numbers match).
 * Routine calls, WhatsApp messages, and SMS execute directly with ZERO confirmation screens.
 * Tapping a matching contact executes the requested action immediately without a second approval step.
 */
export const ActionConfirmationCard: React.FC<ActionConfirmationCardProps> = ({
  draft,
  activeLanguage,
  onApprove,
  onCancel,
}) => {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const candidates = Array.isArray(draft?.candidates) ? draft.candidates : [];
  const hasMultipleMatches = Boolean(draft && candidates.length > 1);

  useEffect(() => {
    if (!hasMultipleMatches) return;
    requestAnimationFrame(() => {
      cardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }, [hasMultipleMatches, draft?.pendingActionId]);

  // Never render routine confirmation cards — only render when multiple contacts/numbers need disambiguation.
  if (!draft || !hasMultipleMatches) return null;

  const isBengali = activeLanguage === 'bn-BD';
  const isHindi = activeLanguage === 'hi-IN';
  const isCall = draft.actionType === 'call_contact';
  const isWhatsApp = draft.actionType === 'prepare_whatsapp_message';
  const isSms = draft.actionType === 'prepare_sms';
  const targetAppLabel = draft.appName || (isWhatsApp ? 'WhatsApp' : isSms ? 'SMS' : 'App');

  const title = isBengali
    ? 'সঠিক কন্টাক্ট বেছে নিন'
    : isHindi
    ? 'सही कॉन्टैक्ट चुनें'
    : 'Select Matching Contact';

  const subtitle = isCall
    ? isBengali
      ? 'একাধিক কন্টাক্ট বা নম্বর পাওয়া গেছে — ট্যাপ করলেই সরাসরি কল শুরু হবে।'
      : isHindi
      ? 'एक से अधिक कॉन्टैक्ट या नंबर मिले — टैप करते ही सीधे कॉल शुरू होगी।'
      : 'Multiple contacts or numbers matched — tap one to call directly.'
    : isBengali
    ? `একাধিক কন্টাক্ট বা নম্বর পাওয়া গেছে — ট্যাপ করলেই সরাসরি ${targetAppLabel}-এ মেসেজ পাঠানো হবে।`
    : isHindi
    ? `एक से अधिक कॉन्टैक्ट या नंबर मिले — टैप करते ही सीधे ${targetAppLabel} पर मैसेज भेजा जाएगा।`
    : `Multiple contacts or numbers matched — tap one to send via ${targetAppLabel} immediately.`;

  return (
    <div
      ref={cardRef}
      data-testid="contact-disambiguation-card"
      role="region"
      aria-label={title}
      className="w-full max-w-2xl mt-3 rounded-2xl bg-slate-950/95 border-2 border-cyan-400/50 shadow-[0_0_35px_rgba(6,182,212,0.28)] p-4 text-cyan-50 animate-in fade-in zoom-in-95 duration-200"
    >
      <div className="flex items-start justify-between gap-3 border-b border-cyan-500/25 pb-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-9 h-9 rounded-xl bg-cyan-950/90 border border-cyan-400/50 flex items-center justify-center text-cyan-300 shrink-0">
            {isCall ? <PhoneCall className="w-4 h-4" /> : <MessageSquare className="w-4 h-4" />}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h4 className="font-sci-fi text-xs sm:text-sm font-bold tracking-wider uppercase text-cyan-200 flex items-center gap-1.5">
                <UserCheck className="w-3.5 h-3.5 text-amber-300" />
                <span>{title}</span>
              </h4>
            </div>
            <p className="text-[11px] text-slate-300 mt-0.5">{subtitle}</p>
          </div>
        </div>
        <button
          type="button"
          data-testid="cancel-disambiguation-btn"
          onClick={() => onCancel(draft.pendingActionId)}
          aria-label="Cancel contact selection"
          className="p-1 rounded-lg border border-slate-700 text-slate-400 hover:text-rose-300 hover:border-rose-500/40 cursor-pointer shrink-0"
        >
          <XCircle className="w-4 h-4" />
        </button>
      </div>

      {!isCall && draft.messageText && (
        <div className="mt-2.5 px-3 py-2 rounded-xl bg-slate-900/75 border border-cyan-500/25 text-xs text-cyan-100">
          <span className="text-[10px] font-hud uppercase tracking-wider text-slate-400 block mb-0.5">
            {isBengali ? 'মেসেজ' : isHindi ? 'मैसेज' : 'Message'}
          </span>
          <span className="break-words">{draft.messageText}</span>
        </div>
      )}

      <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
        {candidates.map((cand, idx) => (
          <button
            key={`${cand.id || idx}-${cand.phone}`}
            type="button"
            data-testid={`contact-candidate-${idx}`}
            onClick={() =>
              onApprove({
                pendingActionId: draft.pendingActionId,
                recipientName: cand.name,
                phoneNumber: cand.phone,
                messageText: draft.messageText,
                useNotificationReply: false,
              })
            }
            className="text-left px-3.5 py-2.5 rounded-xl border bg-slate-900/80 border-cyan-500/35 hover:bg-cyan-950/80 hover:border-cyan-400 text-cyan-50 transition-all cursor-pointer shadow-[0_0_12px_rgba(6,182,212,0.12)]"
          >
            <div className="font-bold text-xs sm:text-sm truncate">{cand.name}</div>
            <div className="text-[11px] font-mono text-cyan-300/85 mt-0.5">{cand.phone}</div>
          </button>
        ))}
      </div>
    </div>
  );
};
