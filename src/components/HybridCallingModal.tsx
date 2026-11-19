import React, { useState, useEffect, useCallback } from 'react';
import {
  X,
  PhoneCall,
  PhoneForwarded,
  Radio,
  ShieldCheck,
  ShieldAlert,
  History,
  Trash2,
  Search,
  CheckCircle2,
  AlertTriangle,
  Bot,
  PhoneOff,
} from 'lucide-react';
import { playProceduralSfx } from '../utils/audio';
import { executeCall } from '../utils/mobileAssistant';
import { normalizePhoneNumber } from '../utils/numberNormalizer';
import {
  HybridCallSession,
  VoipProviderReadiness,
  NativeContactItem,
  fetchHybridStatus,
  prepareHybridCall,
  authorizeHybridCall,
  startHybridCall,
  endHybridCall,
  fetchCallHistory,
  clearBackendCallHistory,
  searchNativeAndroidContacts,
  buildCarrierForwardingCode,
} from '../utils/hybridCalling';
import { SupportedLanguage } from '../types';

interface HybridCallingModalProps {
  isOpen: boolean;
  onClose: () => void;
  soundFxEnabled: boolean;
  selectedAffectionName: string;
  activeLanguage: SupportedLanguage;
}

export const HybridCallingModal: React.FC<HybridCallingModalProps> = ({
  isOpen,
  onClose,
  soundFxEnabled,
  selectedAffectionName,
  activeLanguage,
}) => {
  const [activeTab, setActiveTab] = useState<'sim' | 'voip' | 'history'>('sim');
  const [voipStatus, setVoipStatus] = useState<VoipProviderReadiness | null>(null);

  // SIM Calling & Contacts state
  const [simTargetName, setSimTargetName] = useState('');
  const [simNumberInput, setSimNumberInput] = useState('');
  const [contactResults, setContactResults] = useState<NativeContactItem[]>([]);
  const [forwardingDid, setForwardingDid] = useState('');
  const [simNotice, setSimNotice] = useState<string | null>(null);

  // AI VoIP Calling state (consent-gated)
  const [voipTargetName, setVoipTargetName] = useState('');
  const [voipNumberInput, setVoipNumberInput] = useState('');
  const [voipPurpose, setVoipPurpose] = useState('Appointment confirmation');
  const [preparedSession, setPreparedSession] = useState<HybridCallSession | null>(null);
  const [userAuthorized, setUserAuthorized] = useState(false);
  const [aiDisclosureChecked, setAiDisclosureChecked] = useState(true);
  const [recordingConsent, setRecordingConsent] = useState(false);
  const [voipError, setVoipError] = useState<string | null>(null);
  const [voipLoading, setVoipLoading] = useState(false);

  // History & Privacy state
  const [historyList, setHistoryList] = useState<HybridCallSession[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const loadStatusAndHistory = useCallback(async () => {
    setHistoryLoading(true);
    const [statusRes, hist] = await Promise.all([fetchHybridStatus(), fetchCallHistory()]);
    setVoipStatus(statusRes.voipProvider);
    setHistoryList(hist);
    setHistoryLoading(false);
  }, []);

  useEffect(() => {
    if (isOpen) {
      loadStatusAndHistory();
    }
  }, [isOpen, loadStatusAndHistory]);

  if (!isOpen) return null;

  const simNormalized = simNumberInput.trim() ? normalizePhoneNumber(simNumberInput) : null;

  const handleSearchContacts = (q: string) => {
    setSimTargetName(q);
    if (q.trim().length >= 2) {
      const results = searchNativeAndroidContacts(q.trim());
      setContactResults(results);
    } else {
      setContactResults([]);
    }
  };

  const handleLaunchSimCall = async () => {
    if (soundFxEnabled) playProceduralSfx('click');
    setSimNotice(null);
    const norm = normalizePhoneNumber(simNumberInput);
    if (norm.status !== 'valid' || !norm.normalizedNumber) {
      const errMsg = 'reason' in norm && norm.reason ? norm.reason : 'সঠিক ফোন নম্বর দিন (যেমন: 01712345678 বা +919876543210)।';
      setSimNotice(errMsg);
      return;
    }

    const prep = await prepareHybridCall({
      channel: 'sim',
      targetName: simTargetName || norm.formatted || norm.normalizedNumber,
      phoneNumber: norm.normalizedNumber,
      purpose: 'Direct SIM call via Android Telecom',
      language: activeLanguage,
      callerLabel: selectedAffectionName,
    });

    if (prep.ok && prep.session) {
      await authorizeHybridCall({
        sessionId: prep.session.id,
        confirmedByUser: true,
        aiIdentityDisclosed: true,
        recordingConsentGranted: false,
      });
      await startHybridCall(prep.session.id);
    }

    executeCall(norm.normalizedNumber);
    setSimNotice(`SIM কল চালু হচ্ছে: ${norm.normalizedNumber} (Android Telecom / Dialer)`);
    loadStatusAndHistory();
  };

  const handleDialForwardingCode = (condition: 'no_answer' | 'busy' | 'unreachable' | 'cancel_all') => {
    if (soundFxEnabled) playProceduralSfx('click');
    const code = buildCarrierForwardingCode(condition, forwardingDid);
    if (!code) {
      setSimNotice('কল ফরোয়ার্ডিং কোড তৈরি করতে আপনার VoIP/SIP DID নম্বর লিখুন।');
      return;
    }
    executeCall(code);
    setSimNotice(`Carrier MMI কোড ডায়ালারে পাঠানো হয়েছে: ${code}`);
  };

  const handlePrepareVoipCall = async () => {
    if (soundFxEnabled) playProceduralSfx('click');
    setVoipError(null);
    setVoipLoading(true);
    try {
      const res = await prepareHybridCall({
        channel: 'ai_voip',
        targetName: voipTargetName || voipNumberInput,
        phoneNumber: voipNumberInput,
        purpose: voipPurpose,
        language: activeLanguage,
        callerLabel: selectedAffectionName,
      });
      if (!res.ok || !res.session) {
        setVoipError(res.error || 'কল প্রস্তুত করা যায়নি।');
        setPreparedSession(null);
      } else {
        setPreparedSession(res.session);
        setUserAuthorized(false);
        setAiDisclosureChecked(true);
        setRecordingConsent(false);
      }
    } finally {
      setVoipLoading(false);
    }
  };

  const handleAuthorizeAndStartVoip = async () => {
    if (!preparedSession) return;
    if (soundFxEnabled) playProceduralSfx('click');
    setVoipError(null);
    setVoipLoading(true);
    try {
      const authRes = await authorizeHybridCall({
        sessionId: preparedSession.id,
        confirmedByUser: userAuthorized,
        aiIdentityDisclosed: aiDisclosureChecked,
        recordingConsentGranted: recordingConsent,
      });
      if (!authRes.ok || !authRes.session) {
        setVoipError(authRes.error || 'অনুমতি যাচাই ব্যর্থ হয়েছে।');
        return;
      }

      const startRes = await startHybridCall(preparedSession.id);
      if (!startRes.ok) {
        setPreparedSession(startRes.session || authRes.session);
        setVoipError(startRes.error || 'VoIP কল শুরু করা যায়নি।');
      } else if (startRes.session) {
        setPreparedSession(startRes.session);
      }
      loadStatusAndHistory();
    } finally {
      setVoipLoading(false);
    }
  };

  const handleEndVoipSession = async () => {
    if (!preparedSession) return;
    if (soundFxEnabled) playProceduralSfx('click');
    setVoipLoading(true);
    try {
      const endRes = await endHybridCall(preparedSession.id, 'User ended call');
      if (endRes.ok && endRes.session) {
        setPreparedSession(endRes.session);
      }
      loadStatusAndHistory();
    } finally {
      setVoipLoading(false);
    }
  };

  const handleClearHistory = async () => {
    if (soundFxEnabled) playProceduralSfx('click');
    await clearBackendCallHistory();
    if (typeof window !== 'undefined' && (window as any).ZoniAndroidBridge?.clearLocalCallHistory) {
      try {
        (window as any).ZoniAndroidBridge.clearLocalCallHistory();
      } catch {
        // ignore
      }
    }
    setHistoryList([]);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-md p-3 sm:p-5 overflow-y-auto">
      <div className="w-full max-w-2xl bg-slate-950 border border-cyan-500/40 rounded-2xl shadow-[0_0_60px_rgba(6,182,212,0.3)] flex flex-col overflow-hidden my-auto">
        {/* Header */}
        <div className="flex items-center justify-between p-4 sm:p-5 border-b border-cyan-500/20 bg-slate-900/60">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-cyan-950/80 border border-cyan-400/50 flex items-center justify-center text-cyan-400">
              <PhoneCall className="w-5 h-5" />
            </div>
            <div>
              <h2 className="font-sci-fi text-base font-bold text-cyan-200 tracking-wide">
                HYBRID SIM &amp; AI VOIP CALLING HUB
              </h2>
              <p className="text-xs font-hud text-pink-400">
                Android Telecom SIM কলিং + অনুমতি-ভিত্তিক (Consent-Gated) AI VoIP কল সিস্টেম
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close Hybrid Calling Hub"
            className="p-1.5 rounded-lg border border-cyan-500/30 text-cyan-400 hover:bg-cyan-950/50 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-cyan-500/20 bg-slate-900/30 px-4 pt-2 gap-2 text-xs font-hud tracking-wider overflow-x-auto">
          <button
            onClick={() => setActiveTab('sim')}
            className={`pb-2.5 px-3 font-semibold border-b-2 transition-all shrink-0 ${
              activeTab === 'sim'
                ? 'border-cyan-400 text-cyan-300'
                : 'border-transparent text-slate-400 hover:text-cyan-200'
            }`}
          >
            📞 1. SIM CALLING &amp; ROUTING
          </button>
          <button
            onClick={() => setActiveTab('voip')}
            className={`pb-2.5 px-3 font-semibold border-b-2 transition-all shrink-0 ${
              activeTab === 'voip'
                ? 'border-pink-400 text-pink-300'
                : 'border-transparent text-slate-400 hover:text-pink-200'
            }`}
          >
            🤖 2. AI VOIP CALLING
          </button>
          <button
            onClick={() => setActiveTab('history')}
            className={`pb-2.5 px-3 font-semibold border-b-2 transition-all shrink-0 ${
              activeTab === 'history'
                ? 'border-emerald-400 text-emerald-300'
                : 'border-transparent text-slate-400 hover:text-emerald-200'
            }`}
          >
            📜 3. CALL HISTORY &amp; PRIVACY
          </button>
        </div>

        {/* Body */}
        <div className="p-4 sm:p-6 overflow-y-auto max-h-[70vh] space-y-4">
          {activeTab === 'sim' && (
            <div className="space-y-4">
              <div className="p-4 rounded-xl bg-slate-900/70 border border-cyan-500/30 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="font-hud text-sm font-bold text-cyan-200 flex items-center gap-2">
                    <PhoneCall className="w-4 h-4 text-cyan-400" />
                    Direct Android SIM Call &amp; Bengali Number Normalizer
                  </span>
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-cyan-950 border border-cyan-500/40 text-cyan-300">
                    TELECOM API
                  </span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  <div>
                    <label className="text-[10px] font-mono text-cyan-400 flex items-center gap-1">
                      <Search className="w-3 h-3" /> CONTACT NAME (ANDROID CONTACTS)
                    </label>
                    <input
                      type="text"
                      value={simTargetName}
                      onChange={(e) => handleSearchContacts(e.target.value)}
                      placeholder="e.g. Rahul / রাহুল"
                      className="w-full mt-1 px-3 py-2 rounded-lg bg-slate-950 border border-cyan-500/30 text-xs text-cyan-100 focus:outline-none focus:border-cyan-400"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] font-mono text-pink-400">
                      PHONE NUMBER (বাংলা / ENGLISH / E.164)
                    </label>
                    <input
                      type="text"
                      value={simNumberInput}
                      onChange={(e) => setSimNumberInput(e.target.value)}
                      placeholder="যেমন: ০১৭১২৩৪৫৬৭৮ বা 9876543210"
                      className="w-full mt-1 px-3 py-2 rounded-lg bg-slate-950 border border-pink-500/30 text-xs text-pink-100 font-mono focus:outline-none focus:border-pink-400"
                    />
                  </div>
                </div>

                {contactResults.length > 0 && (
                  <div className="space-y-1 max-h-28 overflow-y-auto">
                    {contactResults.map((c) => (
                      <button
                        key={`${c.id}-${c.phone}`}
                        onClick={() => {
                          setSimTargetName(c.name);
                          setSimNumberInput(c.phone);
                          setContactResults([]);
                        }}
                        className="w-full text-left px-3 py-1.5 rounded-lg bg-slate-950 border border-cyan-500/20 hover:border-cyan-400 text-xs flex justify-between"
                      >
                        <span className="text-cyan-200 font-semibold">{c.name}</span>
                        <span className="font-mono text-pink-300">{c.phone}</span>
                      </button>
                    ))}
                  </div>
                )}

                {simNormalized && (
                  <div
                    className={`p-2 rounded-lg text-[11px] font-mono border ${
                      simNormalized.status === 'valid'
                        ? 'bg-emerald-950/30 border-emerald-500/40 text-emerald-300'
                        : 'bg-amber-950/30 border-amber-500/40 text-amber-300'
                    }`}
                  >
                    {simNormalized.status === 'valid'
                      ? `Normalized: ${simNormalized.normalizedNumber} (${simNormalized.country || 'INTL'})`
                      : ('reason' in simNormalized && simNormalized.reason) || 'Number appears incomplete'}
                  </div>
                )}

                <button
                  onClick={handleLaunchSimCall}
                  className="w-full py-2.5 px-4 rounded-xl bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white font-hud text-xs font-bold tracking-wider uppercase flex items-center justify-center gap-2"
                >
                  <PhoneCall className="w-4 h-4" />
                  <span>PLACE ANDROID SIM CALL</span>
                </button>

                {simNotice && (
                  <p className="text-xs text-cyan-200 bg-cyan-950/40 border border-cyan-500/30 rounded-lg p-2.5">
                    {simNotice}
                  </p>
                )}
              </div>

              {/* Lawful SIM-to-AI Call Routing (Carrier Forwarding) */}
              <div className="p-4 rounded-xl bg-slate-900/50 border border-amber-500/30 space-y-2.5">
                <div className="flex items-center gap-2 text-amber-300 font-hud text-xs font-bold">
                  <PhoneForwarded className="w-4 h-4" />
                  <span>SIM-TO-AI CALL ROUTING (CARRIER CONDITIONAL FORWARDING)</span>
                </div>
                <p className="text-[11px] text-slate-300 leading-relaxed">
                  Android OS নিরাপত্তার কারণে সাধারণ অ্যাপ সরাসরি SIM কল অডিওতে প্রবেশ করতে পারে না। আইনসম্মতভাবে
                  অনুত্তরিত SIM কল AI VoIP নম্বরে পাঠাতে আপনার VoIP/SIP DID নম্বরে Carrier Forwarding সেট করুন:
                </p>
                <input
                  type="text"
                  value={forwardingDid}
                  onChange={(e) => setForwardingDid(e.target.value)}
                  placeholder="Your Twilio / SIP DID Number (e.g. +15551234567)"
                  className="w-full px-3 py-1.5 rounded-lg bg-slate-950 border border-amber-500/30 text-xs text-amber-100 font-mono focus:outline-none focus:border-amber-400"
                />
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px] font-mono">
                  <button
                    onClick={() => handleDialForwardingCode('no_answer')}
                    className="py-1.5 px-2 rounded-lg bg-slate-950 border border-amber-500/30 text-amber-200 hover:border-amber-400"
                  >
                    *61* No Answer
                  </button>
                  <button
                    onClick={() => handleDialForwardingCode('busy')}
                    className="py-1.5 px-2 rounded-lg bg-slate-950 border border-amber-500/30 text-amber-200 hover:border-amber-400"
                  >
                    *67* Busy
                  </button>
                  <button
                    onClick={() => handleDialForwardingCode('unreachable')}
                    className="py-1.5 px-2 rounded-lg bg-slate-950 border border-amber-500/30 text-amber-200 hover:border-amber-400"
                  >
                    *62* Offline
                  </button>
                  <button
                    onClick={() => handleDialForwardingCode('cancel_all')}
                    className="py-1.5 px-2 rounded-lg bg-rose-950/40 border border-rose-500/30 text-rose-200 hover:border-rose-400"
                  >
                    ##002# Cancel
                  </button>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'voip' && (
            <div className="space-y-4">
              {/* Provider Status Banner */}
              <div
                className={`p-3 rounded-xl border text-xs flex items-start gap-2.5 ${
                  voipStatus?.configured
                    ? 'bg-emerald-950/30 border-emerald-500/40 text-emerald-200'
                    : 'bg-amber-950/30 border-amber-500/40 text-amber-200'
                }`}
              >
                {voipStatus?.configured ? (
                  <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                ) : (
                  <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                )}
                <div className="space-y-1">
                  <div className="font-hud font-bold">
                    VOIP PROVIDER: {(voipStatus?.provider || 'UNCONFIGURED').toUpperCase()}
                  </div>
                  {voipStatus?.configured ? (
                    <p className="text-[11px] text-emerald-300/90">
                      Backend VoIP gateway configured ({voipStatus.callerId || voipStatus.sipTrunkUri}). Explicit user
                      authorization &amp; transparent AI disclosure remain mandatory before dialing.
                    </p>
                  ) : (
                    <p className="text-[11px] text-amber-200/90 leading-relaxed">
                      External Twilio/SIP credentials are not yet configured in backend <code>.env</code>. You can still
                      prepare &amp; review the AI disclosure consent flow below; starting an external call will honestly
                      return <code>provider_not_configured</code> rather than fabricating a call.
                    </p>
                  )}
                </div>
              </div>

              {/* Step 1: Prepare AI VoIP Call */}
              <div className="p-4 rounded-xl bg-slate-900/70 border border-pink-500/30 space-y-3">
                <span className="font-hud text-xs font-bold text-pink-300 flex items-center gap-1.5">
                  <Bot className="w-4 h-4 text-pink-400" />
                  STEP 1: PREPARE AI VOIP CALL
                </span>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  <input
                    type="text"
                    value={voipTargetName}
                    onChange={(e) => setVoipTargetName(e.target.value)}
                    placeholder="Recipient Name (e.g. Clinic Reception)"
                    className="px-3 py-2 rounded-lg bg-slate-950 border border-cyan-500/30 text-xs text-cyan-100 focus:outline-none focus:border-cyan-400"
                  />
                  <input
                    type="text"
                    value={voipNumberInput}
                    onChange={(e) => setVoipNumberInput(e.target.value)}
                    placeholder="Destination E.164 / Local Number"
                    className="px-3 py-2 rounded-lg bg-slate-950 border border-pink-500/30 text-xs text-pink-100 font-mono focus:outline-none focus:border-pink-400"
                  />
                </div>
                <input
                  type="text"
                  value={voipPurpose}
                  onChange={(e) => setVoipPurpose(e.target.value)}
                  placeholder="Call Purpose (e.g. Confirm tomorrow's 5 PM appointment)"
                  className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-cyan-500/30 text-xs text-cyan-100 focus:outline-none focus:border-cyan-400"
                />
                <button
                  onClick={handlePrepareVoipCall}
                  disabled={voipLoading || !voipNumberInput.trim()}
                  className="w-full py-2 px-4 rounded-xl bg-pink-600/80 hover:bg-pink-500 disabled:opacity-40 text-white font-hud text-xs font-bold tracking-wider uppercase"
                >
                  {voipLoading ? 'PREPARING...' : 'PREPARE AI CALL & GENERATE DISCLOSURE'}
                </button>
              </div>

              {/* Step 2: Explicit Authorization & AI Identity Disclosure */}
              {preparedSession && (
                <div className="p-4 rounded-xl bg-slate-900/80 border border-cyan-400/50 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="font-hud text-xs font-bold text-cyan-200 flex items-center gap-1.5">
                      <ShieldCheck className="w-4 h-4 text-cyan-400" />
                      STEP 2: USER AUTHORIZATION &amp; AI DISCLOSURE
                    </span>
                    <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-slate-950 border border-cyan-500/30 text-cyan-300 uppercase">
                      {preparedSession.state}
                    </span>
                  </div>

                  <div className="p-2.5 rounded-lg bg-slate-950 border border-pink-500/30 text-xs text-pink-100 leading-relaxed">
                    <div className="text-[10px] font-mono text-pink-400 mb-1">MANDATORY OPENING AI DISCLOSURE:</div>
                    &ldquo;{preparedSession.disclosureScript}&rdquo;
                  </div>

                  <label className="flex items-start gap-2 text-xs text-slate-200 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={userAuthorized}
                      onChange={(e) => setUserAuthorized(e.target.checked)}
                      className="mt-0.5 accent-pink-500"
                    />
                    <span>I explicitly authorize Zoni AI to place this call to {preparedSession.phoneNumber}.</span>
                  </label>

                  <label className="flex items-start gap-2 text-xs text-slate-200 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={aiDisclosureChecked}
                      onChange={(e) => setAiDisclosureChecked(e.target.checked)}
                      className="mt-0.5 accent-cyan-500"
                    />
                    <span>Zoni AI will transparently identify itself as an AI assistant (never impersonating me).</span>
                  </label>

                  <label className="flex items-start gap-2 text-xs text-slate-400 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={recordingConsent}
                      onChange={(e) => setRecordingConsent(e.target.checked)}
                      className="mt-0.5 accent-amber-500"
                    />
                    <span>Optional: Enable call recording only if permitted by local law (OFF by default).</span>
                  </label>

                  <div className="flex gap-2">
                    <button
                      onClick={handleAuthorizeAndStartVoip}
                      disabled={voipLoading || !userAuthorized || !aiDisclosureChecked}
                      className="flex-1 py-2.5 px-3 rounded-xl bg-gradient-to-r from-cyan-600 to-pink-600 hover:from-cyan-500 hover:to-pink-500 disabled:opacity-40 text-white font-hud text-xs font-bold uppercase flex items-center justify-center gap-1.5"
                    >
                      <Radio className="w-3.5 h-3.5" />
                      <span>AUTHORIZE &amp; START AI VOIP CALL</span>
                    </button>
                    {preparedSession.state === 'active' && (
                      <button
                        onClick={handleEndVoipSession}
                        className="px-4 py-2.5 rounded-xl bg-rose-600 hover:bg-rose-500 text-white font-hud text-xs font-bold uppercase flex items-center gap-1.5"
                      >
                        <PhoneOff className="w-3.5 h-3.5" />
                        <span>END</span>
                      </button>
                    )}
                  </div>
                </div>
              )}

              {voipError && (
                <div className="p-3 rounded-xl bg-rose-950/40 border border-rose-500/40 text-xs text-rose-200 flex items-start gap-2">
                  <ShieldAlert className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                  <span>{voipError}</span>
                </div>
              )}
            </div>
          )}

          {activeTab === 'history' && (
            <div className="space-y-3">
              <div className="flex items-center justify-between p-3 rounded-xl bg-slate-900/60 border border-emerald-500/30">
                <div className="text-xs text-emerald-200">
                  <strong>Privacy Default:</strong> Call recording is <strong>OFF</strong> by default. Consent records
                  and summaries can be deleted anytime.
                </div>
                <button
                  onClick={handleClearHistory}
                  className="px-2.5 py-1.5 rounded-lg bg-rose-950/60 border border-rose-500/40 text-rose-300 hover:bg-rose-900/60 text-xs font-hud flex items-center gap-1 shrink-0"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>CLEAR</span>
                </button>
              </div>

              {historyLoading ? (
                <p className="text-xs text-slate-400 font-mono text-center py-4">Loading call sessions...</p>
              ) : historyList.length === 0 ? (
                <div className="p-6 rounded-xl bg-slate-900/40 border border-cyan-500/20 text-center space-y-1">
                  <History className="w-6 h-6 text-cyan-400/60 mx-auto" />
                  <p className="text-xs text-slate-300">No hybrid call sessions recorded yet.</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {historyList.map((call) => (
                    <div
                      key={call.id}
                      className="p-3 rounded-xl bg-slate-900/70 border border-cyan-500/25 space-y-1.5"
                    >
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-hud font-bold text-cyan-200">
                          {call.channel === 'sim' ? '📞 SIM' : '🤖 AI VOIP'} — {call.targetName}
                        </span>
                        <span className="font-mono text-[10px] px-2 py-0.5 rounded bg-slate-950 border border-cyan-500/30 text-pink-300 uppercase">
                          {call.state}
                        </span>
                      </div>
                      <div className="text-[11px] font-mono text-slate-400 flex justify-between">
                        <span>{call.phoneNumber}</span>
                        <span>{new Date(call.createdAtIso).toLocaleString()}</span>
                      </div>
                      <p className="text-xs text-slate-300">Purpose: {call.purpose}</p>
                      {call.summary && (
                        <div className="p-2 rounded-lg bg-slate-950/80 border border-emerald-500/25 text-[11px] text-emerald-200">
                          <strong>Summary:</strong> {call.summary.summaryText}
                        </div>
                      )}
                      {call.errorMessage && (
                        <div className="text-[11px] text-amber-300">{call.errorMessage}</div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-3 sm:p-4 border-t border-cyan-500/20 bg-slate-900/60 flex items-center justify-between">
          <span className="text-[11px] font-hud text-cyan-400/80">
            ZONI HYBRID TELECOM // SIM + CORE-TELECOM VOIP
          </span>
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg bg-cyan-600/80 hover:bg-cyan-500 text-white font-hud text-xs tracking-wider"
          >
            CLOSE
          </button>
        </div>
      </div>
    </div>
  );
};
