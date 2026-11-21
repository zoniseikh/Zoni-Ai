import React, { useState, useEffect, useRef } from 'react';
import {
  CheckCircle2,
  XCircle,
  MessageSquare,
  PhoneCall,
  Send,
  ShieldCheck,
  UserCheck,
  Edit3,
  Bell,
} from 'lucide-react';
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

export const ActionConfirmationCard: React.FC<ActionConfirmationCardProps> = ({
  draft,
  activeLanguage,
  onApprove,
  onCancel,
}) => {
  const [selectedName, setSelectedName] = useState('');
  const [selectedPhone, setSelectedPhone] = useState('');
  const [editedMessage, setEditedMessage] = useState('');
  const [useNotificationReply, setUseNotificationReply] = useState(false);
  const cardRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!draft) return;
    setSelectedName(draft.recipientName || '');
    setSelectedPhone(draft.phoneNumber || '');
    setEditedMessage(draft.messageText || '');
    setUseNotificationReply(Boolean(draft.canReplyViaNotification && draft.notificationKey));
    requestAnimationFrame(() => {
      cardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }, [draft]);

  if (!draft) return null;

  const isBengali = activeLanguage === 'bn-BD';
  const isHindi = activeLanguage === 'hi-IN';
  const isCall = draft.actionType === 'call_contact';
  const isWhatsApp = draft.actionType === 'prepare_whatsapp_message';
  const isAppChat = draft.actionType === 'prepare_app_chat_message';
  const targetAppLabel = draft.appName || 'App Chat';
  const hasCandidates = Array.isArray(draft.candidates) && draft.candidates.length > 1;
  const needsSelection = hasCandidates && !selectedPhone;
  const needsMessageBody = !isCall && editedMessage.trim().length === 0;

  const title = isCall
    ? isBengali
      ? 'ফোন কল নিশ্চিত করুন'
      : isHindi
      ? 'कॉल की पुष्टि करें'
      : 'Confirm Phone Call'
    : isWhatsApp
    ? isBengali
      ? 'WhatsApp মেসেজ রিভিউ ও অনুমতি'
      : isHindi
      ? 'WhatsApp मैसेज समीक्षा और अनुमति'
      : 'Review & Approve WhatsApp Draft'
    : isAppChat
    ? isBengali
      ? `${targetAppLabel} মেসেজ রিভিউ ও অনুমতি`
      : isHindi
      ? `${targetAppLabel} मैसेज समीक्षा और अनुमति`
      : `Review & Approve ${targetAppLabel} Draft`
    : isBengali
    ? 'SMS মেসেজ রিভিউ ও অনুমতি'
    : isHindi
    ? 'SMS मैसेज समीक्षा और अनुमति'
    : 'Review & Approve SMS Draft';

  const safetyNotice = isCall
    ? isBengali
      ? 'আপনার অনুমোদনের আগে কোনো কল করা হবে না।'
      : isHindi
      ? 'आपकी अनुमति के बिना कोई कॉल नहीं की जाएगी।'
      : 'No call will be placed until you explicitly approve.'
    : isWhatsApp
    ? useNotificationReply
      ? isBengali
        ? 'অনুমোদন দিলে অ্যান্ড্রয়েড নোটিফিকেশন রিপ্লাই-এর মাধ্যমে উত্তর পাঠানো হবে।'
        : 'Approving will reply directly via the active Android WhatsApp notification.'
      : isBengali
      ? 'অনুমোদনের আগে মেসেজ পাঠানো হবে না। অনুমোদন দিলে Zoni প্রাপক ও মেসেজ যাচাই করে WhatsApp-এ পাঠাবে (অথবা Accessibility বন্ধ থাকলে ড্রাফট খুলে দেবে)।'
      : isHindi
      ? 'अनुमति से पहले मैसेज नहीं भेजा जाएगा। अनुमति देने पर Zoni रिसीवर व मैसेज जांचकर WhatsApp में भेजेगा (या Accessibility बंद होने पर ड्राफ्ट खोलेगा)।'
      : 'Nothing is sent before your approval. After approving, Zoni verifies the chat & taps Send via Accessibility (or opens the draft for manual Send).'
    : isAppChat
    ? isBengali
      ? `অনুমোদনের আগে ${targetAppLabel}-এ মেসেজ পাঠানো হবে না। অনুমোদন দিলে Zoni শুধুমাত্র যাচাইকৃত ${targetAppLabel} অ্যাডাপ্টারে এই মেসেজটি পাঠাবে।`
      : isHindi
      ? `अनुमति से पहले ${targetAppLabel} में मैसेज नहीं भेजा जाएगा। अनुमति देने पर Zoni सत्यापित ${targetAppLabel} एडैप्टर से भेजेगा।`
      : `Nothing is sent before your approval. Approving runs the verified ${targetAppLabel} Accessibility adapter only after confirming recipient and message.`
    : isBengali
    ? 'অনুমোদন দিলে আপনার SMS অ্যাপ এই মেসেজসহ খুলে যাবে — স্বয়ংক্রিয়ভাবে পাঠানো হবে না।'
    : 'Approving opens your SMS composer with this exact draft — never sent silently.';

  return (
    <div
      ref={cardRef}
      data-testid="action-confirmation-card"
      role="region"
      aria-label={title}
      className="w-full max-w-2xl mt-3 rounded-2xl bg-slate-950/95 border-2 border-cyan-400/50 shadow-[0_0_35px_rgba(6,182,212,0.28)] p-4 text-cyan-50 animate-in fade-in zoom-in-95 duration-200"
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-3 border-b border-cyan-500/25 pb-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-9 h-9 rounded-xl bg-cyan-950/90 border border-cyan-400/50 flex items-center justify-center text-cyan-300 shrink-0">
            {isCall ? <PhoneCall className="w-4 h-4" /> : <MessageSquare className="w-4 h-4" />}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h4 className="font-sci-fi text-xs sm:text-sm font-bold tracking-wider uppercase text-cyan-200">
                {title}
              </h4>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-pink-950/80 border border-pink-400/50 text-pink-300 font-bold">
                REVIEW REQUIRED
              </span>
            </div>
            <p className="text-[11px] text-slate-300 mt-0.5 flex items-center gap-1">
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
              <span>{draft.statusNote || safetyNotice}</span>
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => onCancel(draft.pendingActionId)}
          aria-label="Cancel pending action"
          className="p-1 rounded-lg border border-slate-700 text-slate-400 hover:text-rose-300 hover:border-rose-500/40 cursor-pointer shrink-0"
        >
          <XCircle className="w-4 h-4" />
        </button>
      </div>

      {/* Multiple Contact Disambiguation Picker */}
      {hasCandidates && draft.candidates && (
        <div className="mt-3 space-y-1.5">
          <p className="text-[11px] font-hud uppercase tracking-wider text-amber-300 flex items-center gap-1.5">
            <UserCheck className="w-3.5 h-3.5" />
            <span>
              {isBengali
                ? 'একাধিক কন্টাক্ট পাওয়া গেছে — সঠিক জনকে বেছে নিন:'
                : 'Multiple matching contacts found — select the right recipient:'}
            </span>
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
            {draft.candidates.map((cand, idx) => {
              const isSelected = selectedPhone === cand.phone && selectedName === cand.name;
              return (
                <button
                  key={`${cand.id || idx}-${cand.phone}`}
                  type="button"
                  onClick={() => {
                    setSelectedName(cand.name);
                    setSelectedPhone(cand.phone);
                  }}
                  className={`text-left px-3 py-2 rounded-xl border text-xs font-hud transition-all cursor-pointer ${
                    isSelected
                      ? 'bg-cyan-950/80 border-cyan-400 text-cyan-100 shadow-[0_0_12px_rgba(6,182,212,0.25)]'
                      : 'bg-slate-900/70 border-slate-700 text-slate-300 hover:border-cyan-500/40'
                  }`}
                >
                  <div className="font-bold truncate">{cand.name}</div>
                  <div className="text-[11px] font-mono text-cyan-300/80">{cand.phone}</div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Recipient + Phone Row */}
      <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2.5">
        <div className="p-2.5 rounded-xl bg-slate-900/75 border border-cyan-500/25">
          <label
            htmlFor="zoni-confirm-recipient"
            className="text-[10px] font-hud uppercase tracking-wider text-slate-400 block"
          >
            {isBengali ? 'প্রাপক (Recipient)' : 'Recipient'}
          </label>
          <input
            id="zoni-confirm-recipient"
            type="text"
            value={selectedName}
            onChange={(e) => setSelectedName(e.target.value)}
            className="w-full mt-1 bg-transparent text-xs sm:text-sm font-bold text-cyan-100 focus:outline-none"
          />
        </div>
        <div className="p-2.5 rounded-xl bg-slate-900/75 border border-cyan-500/25">
          <label
            htmlFor="zoni-confirm-phone"
            className="text-[10px] font-hud uppercase tracking-wider text-slate-400 block"
          >
            {isBengali ? 'ফোন নম্বর (Phone)' : 'Phone Number'}
          </label>
          <input
            id="zoni-confirm-phone"
            type="tel"
            value={selectedPhone}
            onChange={(e) => setSelectedPhone(e.target.value)}
            placeholder="+880 / +91..."
            className="w-full mt-1 bg-transparent text-xs sm:text-sm font-mono text-cyan-200 placeholder:text-slate-500 focus:outline-none"
          />
        </div>
      </div>

      {/* Editable Message Body (WhatsApp / SMS / Supported App Chat) */}
      {!isCall && (
        <div className="mt-3">
          <label
            htmlFor="zoni-confirm-message"
            className="text-[10px] font-hud uppercase tracking-wider text-cyan-300 flex items-center gap-1 mb-1"
          >
            <Edit3 className="w-3 h-3" />
            <span>
              {isBengali ? 'মেসেজ টেক্সট (পাঠানোর আগে এডিট করতে পারবেন)' : 'Message Text (Editable Before Approving)'}
            </span>
          </label>
          <textarea
            id="zoni-confirm-message"
            rows={2}
            value={editedMessage}
            onChange={(e) => setEditedMessage(e.target.value)}
            placeholder={
              isBengali
                ? 'কী মেসেজ পাঠাতে চান তা এখানে লিখুন...'
                : isHindi
                ? 'आप क्या मैसेज भेजना चाहते हैं यहाँ लिखें...'
                : 'Type the exact message you want to send...'
            }
            className="w-full rounded-xl bg-slate-900/90 border border-cyan-500/40 px-3 py-2 text-xs sm:text-sm text-cyan-50 placeholder:text-slate-500 focus:outline-none focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400/50 resize-none"
          />
          {needsMessageBody && (
            <p className="mt-1 text-[11px] text-amber-300 font-hud">
              {isBengali
                ? 'পাঠানোর আগে অনুগ্রহ করে মেসেজের টেক্সট লিখুন।'
                : isHindi
                ? 'भेजने से पहले कृपया मैसेज लिखें।'
                : 'Please enter the message text before approving.'}
            </p>
          )}
        </div>
      )}

      {/* Optional RemoteInput Notification Reply toggle when active WhatsApp notification exists */}
      {isWhatsApp && draft.canReplyViaNotification && draft.notificationKey && (
        <label className="mt-2.5 flex items-center gap-2 text-xs text-emerald-300 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={useNotificationReply}
            onChange={(e) => setUseNotificationReply(e.target.checked)}
            className="accent-emerald-500"
          />
          <Bell className="w-3.5 h-3.5 shrink-0" />
          <span>
            {isBengali
              ? 'সক্রিয় WhatsApp নোটিফিকেশনে সরাসরি RemoteInput রিপ্লাই ব্যবহার করুন'
              : 'Send via active Android WhatsApp Notification RemoteInput reply'}
          </span>
        </label>
      )}

      {/* Footer Actions */}
      <div className="mt-3.5 flex flex-wrap items-center justify-between gap-2">
        <span className="text-[11px] text-slate-400 font-hud">
          {isBengali
            ? 'ভয়েস অনুমতি: বলুন "এখন পাঠানোর অনুমতি দিলাম"'
            : 'Voice approval: say "Approve and send" or "এখন পাঠানোর অনুমতি দিলাম"'}
        </span>
        <div className="flex items-center gap-2 ml-auto">
          <button
            type="button"
            data-testid="cancel-pending-action-btn"
            onClick={() => onCancel(draft.pendingActionId)}
            className="px-3.5 py-2 rounded-xl border border-rose-500/40 bg-rose-950/50 hover:bg-rose-900/60 text-rose-200 text-xs font-hud font-bold uppercase tracking-wider cursor-pointer transition-colors"
          >
            {isBengali ? 'বাতিল করুন' : 'Cancel'}
          </button>
          <button
            type="button"
            data-testid="approve-pending-action-btn"
            disabled={needsSelection || needsMessageBody}
            onClick={() =>
              onApprove({
                pendingActionId: draft.pendingActionId,
                recipientName: selectedName.trim() || draft.recipientName,
                phoneNumber: selectedPhone.trim(),
                messageText: editedMessage.trim(),
                useNotificationReply,
              })
            }
            className={`px-4 py-2 rounded-xl text-xs font-hud font-bold uppercase tracking-wider flex items-center gap-1.5 transition-all ${
              needsSelection || needsMessageBody
                ? 'bg-slate-800 text-slate-500 border border-slate-700 cursor-not-allowed'
                : 'bg-gradient-to-r from-cyan-600 to-pink-600 hover:from-cyan-500 hover:to-pink-500 text-white shadow-[0_0_16px_rgba(6,182,212,0.35)] cursor-pointer'
            }`}
          >
            {isCall ? (
              <>
                <CheckCircle2 className="w-3.5 h-3.5" />
                <span>{isBengali ? 'কল নিশ্চিত করুন' : 'Approve & Call'}</span>
              </>
            ) : (
              <>
                <Send className="w-3.5 h-3.5" />
                <span>
                  {isBengali
                    ? useNotificationReply
                      ? 'অনুমতি দিন ও রিপ্লাই পাঠান'
                      : isWhatsApp
                      ? 'অনুমতি দিন ও WhatsApp-এ পাঠান'
                      : isAppChat
                      ? `অনুমতি দিন ও ${targetAppLabel}-এ পাঠান`
                      : 'অনুমতি দিন ও SMS খুলুন'
                    : isHindi
                    ? useNotificationReply
                      ? 'अनुमति दें और रिप्लाई भेजें'
                      : isWhatsApp
                      ? 'अनुमति दें और WhatsApp भेजें'
                      : isAppChat
                      ? `अनुमति दें और ${targetAppLabel} भेजें`
                      : 'अनुमति दें और SMS खोलें'
                    : useNotificationReply
                    ? 'Approve & Reply'
                    : isWhatsApp
                    ? 'Approve & Send via WhatsApp'
                    : isAppChat
                    ? `Approve & Send via ${targetAppLabel}`
                    : 'Approve & Open SMS'}
                </span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};
