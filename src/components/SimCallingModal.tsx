import React, { useState, useEffect, useCallback } from 'react';
import {
  X,
  PhoneCall,
  PhoneIncoming,
  PhoneOff,
  History,
  Trash2,
  Search,
  ShieldCheck,
  ShieldAlert,
  RefreshCw,
} from 'lucide-react';
import { playProceduralSfx } from '../utils/audio';
import { executeCall } from '../utils/mobileAssistant';
import { normalizePhoneNumber } from '../utils/numberNormalizer';
import {
  NativeContactItem,
  LocalSimCallRecord,
  searchNativeAndroidContacts,
  loadLocalSimCallHistory,
  appendLocalSimCallRecord,
  clearLocalSimCallHistory,
} from '../utils/simCalling';
import { SupportedLanguage } from '../types';
import type { IncomingCallStatusSnapshot } from '../utils/voiceLifecycle';

interface SimCallingModalProps {
  isOpen: boolean;
  onClose: () => void;
  soundFxEnabled: boolean;
  selectedAffectionName: string;
  activeLanguage: SupportedLanguage;
  incomingCallStatus?: IncomingCallStatusSnapshot | null;
  onAnswerIncomingCall?: () => void;
  onRejectIncomingCall?: () => void;
  onEndActiveCall?: () => void;
  onRefreshCallStatus?: () => void;
  onRequestCallPermissions?: () => void;
  onRequestDialerRole?: () => void;
  callControlNotice?: string | null;
}

export const SimCallingModal: React.FC<SimCallingModalProps> = ({
  isOpen,
  onClose,
  soundFxEnabled,
  selectedAffectionName,
  incomingCallStatus,
  onAnswerIncomingCall,
  onRejectIncomingCall,
  onEndActiveCall,
  onRefreshCallStatus,
  onRequestCallPermissions,
  onRequestDialerRole,
  callControlNotice,
}) => {
  const [activeTab, setActiveTab] = useState<'sim' | 'history'>('sim');

  // SIM Calling & Contacts state
  const [simTargetName, setSimTargetName] = useState('');
  const [simNumberInput, setSimNumberInput] = useState('');
  const [contactResults, setContactResults] = useState<NativeContactItem[]>([]);
  const [confirmBeforeDial, setConfirmBeforeDial] = useState(true);
  const [pendingDialNumber, setPendingDialNumber] = useState<string | null>(null);
  const [simNotice, setSimNotice] = useState<string | null>(null);

  // Local SIM Call History state
  const [historyList, setHistoryList] = useState<LocalSimCallRecord[]>([]);

  const refreshHistory = useCallback(() => {
    setHistoryList(loadLocalSimCallHistory());
  }, []);

  useEffect(() => {
    if (isOpen) {
      refreshHistory();
      setPendingDialNumber(null);
      setSimNotice(null);
    }
  }, [isOpen, refreshHistory]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

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

  const executeVerifiedSimCall = (normalizedNumber: string) => {
    const label = simTargetName.trim() || normalizedNumber;
    const record: LocalSimCallRecord = {
      id: `sim_${Date.now()}`,
      targetName: label,
      phoneNumber: normalizedNumber,
      createdAtIso: new Date().toISOString(),
      status: 'initiated',
    };
    appendLocalSimCallRecord(record);
    executeCall(normalizedNumber);
    setPendingDialNumber(null);
    setSimNotice(`SIM কল চালু হচ্ছে: ${normalizedNumber} (Android Telecom / Dialer)`);
    refreshHistory();
  };

  const handleLaunchSimCall = () => {
    if (soundFxEnabled) playProceduralSfx('click');
    setSimNotice(null);
    const norm = normalizePhoneNumber(simNumberInput);
    if (norm.status !== 'valid' || !norm.normalizedNumber) {
      const errMsg =
        'reason' in norm && norm.reason
          ? norm.reason
          : 'সঠিক ফোন নম্বর দিন (যেমন: 01712345678 বা +919876543210)।';
      setSimNotice(errMsg);
      return;
    }

    if (confirmBeforeDial && pendingDialNumber !== norm.normalizedNumber) {
      setPendingDialNumber(norm.normalizedNumber);
      return;
    }

    executeVerifiedSimCall(norm.normalizedNumber);
  };

  const handleClearHistory = () => {
    if (soundFxEnabled) playProceduralSfx('click');
    clearLocalSimCallHistory();
    setHistoryList([]);
  };

  return (
    <div className="zoni-modal-backdrop bg-black/75 backdrop-blur-md" role="dialog" aria-modal="true" aria-label="Android SIM Calling Hub">
      <div className="zoni-modal-card max-w-2xl bg-slate-950 border border-cyan-500/40 rounded-2xl shadow-[0_0_60px_rgba(6,182,212,0.3)]">
        {/* Header */}
        <div className="shrink-0 flex items-center justify-between p-4 sm:p-5 border-b border-cyan-500/20 bg-slate-900/60">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 shrink-0 rounded-xl bg-cyan-950/80 border border-cyan-400/50 flex items-center justify-center text-cyan-400">
              <PhoneCall className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <h2 className="font-sci-fi text-base font-bold text-cyan-200 tracking-wide truncate">
                ANDROID SIM CALLING HUB
              </h2>
              <p className="text-xs font-hud text-pink-400 truncate">
                নেটিভ Android SIM কলিং, কন্টাক্ট সার্চ এবং বাংলা/ইংরেজি নম্বর নরমালাইজার ({selectedAffectionName})
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close SIM Calling Hub"
            className="shrink-0 p-1.5 rounded-lg border border-cyan-500/30 text-cyan-400 hover:bg-cyan-950/50 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tabs */}
        <div className="shrink-0 flex border-b border-cyan-500/20 bg-slate-900/30 px-4 pt-2 gap-2 text-xs font-hud tracking-wider overflow-x-auto">
          <button
            type="button"
            onClick={() => setActiveTab('sim')}
            className={`pb-2.5 px-3 font-semibold border-b-2 transition-all shrink-0 ${
              activeTab === 'sim'
                ? 'border-cyan-400 text-cyan-300'
                : 'border-transparent text-slate-400 hover:text-cyan-200'
            }`}
          >
            📞 1. SIM CALLING &amp; CONTACTS
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('history')}
            className={`pb-2.5 px-3 font-semibold border-b-2 transition-all shrink-0 ${
              activeTab === 'history'
                ? 'border-emerald-400 text-emerald-300'
                : 'border-transparent text-slate-400 hover:text-emerald-200'
            }`}
          >
            📜 2. SIM CALL HISTORY
          </button>
        </div>

        {/* Body */}
        <div className="zoni-modal-scroll p-4 sm:p-6 space-y-4">
          {activeTab === 'sim' && (
            <div className="space-y-4">
              {/* Incoming & Active Call Control Panel */}
              <div
                data-testid="incoming-call-control-panel"
                className="p-4 rounded-xl bg-slate-900/70 border border-emerald-500/30 space-y-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-hud text-sm font-bold text-emerald-200 flex items-center gap-2">
                    <PhoneIncoming className="w-4 h-4 text-emerald-400" />
                    Incoming &amp; Active Call Control
                  </span>
                  <div className="flex items-center gap-2">
                    <span
                      data-testid="call-control-live-state"
                      className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded border ${
                        incomingCallStatus?.isIncomingRinging
                          ? 'bg-emerald-950 border-emerald-400 text-emerald-300'
                          : incomingCallStatus?.isActiveCall
                          ? 'bg-cyan-950 border-cyan-400 text-cyan-300'
                          : 'bg-slate-950 border-slate-700 text-slate-300'
                      }`}
                    >
                      {incomingCallStatus?.callState || 'IDLE'}
                    </span>
                    {onRefreshCallStatus && (
                      <button
                        type="button"
                        onClick={onRefreshCallStatus}
                        aria-label="Refresh Call Status"
                        className="p-1 rounded-md border border-emerald-500/30 text-emerald-300 hover:bg-emerald-950/60 cursor-pointer"
                      >
                        <RefreshCw className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </div>

                {(incomingCallStatus?.isIncomingRinging || incomingCallStatus?.isActiveCall) && (
                  <div className="p-2.5 rounded-lg bg-emerald-950/30 border border-emerald-500/30 text-xs flex items-center justify-between gap-2">
                    <span className="text-emerald-200 font-semibold truncate">
                      {incomingCallStatus.callerDisplayName ||
                        incomingCallStatus.callerNumber ||
                        (incomingCallStatus.isIncomingRinging ? 'Incoming Phone Call' : 'Active Phone Call')}
                    </span>
                    <span className="font-mono text-[10px] text-emerald-300 shrink-0">
                      {incomingCallStatus.isIncomingRinging ? 'RINGING' : 'IN CALL'}
                    </span>
                  </div>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  <button
                    type="button"
                    onClick={onAnswerIncomingCall}
                    className="py-2 px-3 rounded-lg bg-emerald-600/80 hover:bg-emerald-500 text-white font-hud text-xs font-bold uppercase flex items-center justify-center gap-1.5 cursor-pointer"
                  >
                    <PhoneIncoming className="w-3.5 h-3.5" />
                    <span>ANSWER CALL</span>
                  </button>
                  <button
                    type="button"
                    onClick={onRejectIncomingCall}
                    className="py-2 px-3 rounded-lg bg-amber-600/80 hover:bg-amber-500 text-white font-hud text-xs font-bold uppercase flex items-center justify-center gap-1.5 cursor-pointer"
                  >
                    <PhoneOff className="w-3.5 h-3.5" />
                    <span>REJECT CALL</span>
                  </button>
                  <button
                    type="button"
                    onClick={onEndActiveCall}
                    className="py-2 px-3 rounded-lg bg-rose-600/80 hover:bg-rose-500 text-white font-hud text-xs font-bold uppercase flex items-center justify-center gap-1.5 cursor-pointer"
                  >
                    <PhoneOff className="w-3.5 h-3.5" />
                    <span>END CALL</span>
                  </button>
                </div>

                <div className="flex flex-wrap items-center gap-2 text-[10px] font-mono">
                  <span
                    className={`px-2 py-0.5 rounded border ${
                      incomingCallStatus?.hasReadPhoneStatePermission
                        ? 'bg-emerald-950/50 border-emerald-500/40 text-emerald-300'
                        : 'bg-slate-950 border-slate-700 text-slate-400'
                    }`}
                  >
                    READ_PHONE_STATE: {incomingCallStatus?.hasReadPhoneStatePermission ? 'OK' : 'MISSING'}
                  </span>
                  <span
                    className={`px-2 py-0.5 rounded border ${
                      incomingCallStatus?.hasAnswerPermission
                        ? 'bg-emerald-950/50 border-emerald-500/40 text-emerald-300'
                        : 'bg-slate-950 border-slate-700 text-slate-400'
                    }`}
                  >
                    ANSWER_PHONE_CALLS: {incomingCallStatus?.hasAnswerPermission ? 'OK' : 'MISSING'}
                  </span>
                  <span
                    className={`px-2 py-0.5 rounded border ${
                      incomingCallStatus?.isDefaultDialerRoleHeld
                        ? 'bg-emerald-950/50 border-emerald-500/40 text-emerald-300'
                        : 'bg-slate-950 border-slate-700 text-slate-400'
                    }`}
                  >
                    DIALER ROLE: {incomingCallStatus?.isDefaultDialerRoleHeld ? 'ACTIVE' : 'OPTIONAL'}
                  </span>
                </div>

                {(onRequestCallPermissions || onRequestDialerRole) && (
                  <div className="flex flex-wrap gap-2">
                    {onRequestCallPermissions && (
                      <button
                        type="button"
                        onClick={onRequestCallPermissions}
                        className="px-3 py-1.5 rounded-lg border border-cyan-500/40 bg-cyan-950/50 hover:bg-cyan-900/60 text-cyan-200 font-hud text-[11px] font-bold flex items-center gap-1.5 cursor-pointer"
                      >
                        <ShieldCheck className="w-3.5 h-3.5" />
                        <span>GRANT CALL PERMISSIONS</span>
                      </button>
                    )}
                    {onRequestDialerRole && (
                      <button
                        type="button"
                        onClick={onRequestDialerRole}
                        className="px-3 py-1.5 rounded-lg border border-amber-500/40 bg-amber-950/50 hover:bg-amber-900/60 text-amber-200 font-hud text-[11px] font-bold flex items-center gap-1.5 cursor-pointer"
                      >
                        <ShieldAlert className="w-3.5 h-3.5" />
                        <span>REQUEST DIALER ROLE</span>
                      </button>
                    )}
                  </div>
                )}

                {(callControlNotice || incomingCallStatus?.lastError) && (
                  <p className="text-xs text-amber-200 bg-amber-950/40 border border-amber-500/30 rounded-lg p-2.5">
                    {callControlNotice || incomingCallStatus?.lastError}
                  </p>
                )}

                <p className="text-[11px] text-slate-400 leading-relaxed">
                  Voice commands: <code>&ldquo;কল রিসিভ করো&rdquo;</code>, <code>&ldquo;কল কেটে দাও&rdquo;</code>,{' '}
                  <code>&ldquo;Answer the call&rdquo;</code>, <code>&ldquo;Reject the call&rdquo;</code>,{' '}
                  <code>&ldquo;End the call&rdquo;</code>, <code>&ldquo;कॉल उठाओ&rdquo;</code>. Uses native Android Telecom
                  and verifies real ringing/active state.
                </p>
              </div>

              <div className="p-4 rounded-xl bg-slate-900/70 border border-cyan-500/30 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="font-hud text-sm font-bold text-cyan-200 flex items-center gap-2">
                    <PhoneCall className="w-4 h-4 text-cyan-400" />
                    Direct Android SIM Call &amp; Bengali Number Normalizer
                  </span>
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-cyan-950 border border-cyan-500/40 text-cyan-300">
                    NATIVE TELECOM
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
                      onChange={(e) => {
                        setSimNumberInput(e.target.value);
                        setPendingDialNumber(null);
                      }}
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
                          setPendingDialNumber(null);
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

                <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={confirmBeforeDial}
                    onChange={(e) => {
                      setConfirmBeforeDial(e.target.checked);
                      setPendingDialNumber(null);
                    }}
                    className="accent-cyan-500"
                  />
                  <ShieldCheck className="w-3.5 h-3.5 text-cyan-400" />
                  <span>Require confirmation before placing SIM call</span>
                </label>

                {pendingDialNumber ? (
                  <div className="p-3 rounded-xl bg-amber-950/30 border border-amber-500/40 space-y-2.5">
                    <p className="text-xs text-amber-200">
                      Confirm SIM call to <strong>{simTargetName || pendingDialNumber}</strong> (
                      <span className="font-mono">{pendingDialNumber}</span>) via your device&apos;s native Android
                      Telecom SIM dialer?
                    </p>
                    <div className="flex gap-2">
                      <button
                        onClick={() => executeVerifiedSimCall(pendingDialNumber)}
                        className="flex-1 py-2 px-3 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-hud text-xs font-bold uppercase flex items-center justify-center gap-1.5"
                      >
                        <PhoneCall className="w-3.5 h-3.5" />
                        <span>CONFIRM &amp; DIAL SIM</span>
                      </button>
                      <button
                        onClick={() => setPendingDialNumber(null)}
                        className="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 font-hud text-xs uppercase"
                      >
                        CANCEL
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    onClick={handleLaunchSimCall}
                    className="w-full py-2.5 px-4 rounded-xl bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white font-hud text-xs font-bold tracking-wider uppercase flex items-center justify-center gap-2"
                  >
                    <PhoneCall className="w-4 h-4" />
                    <span>PLACE ANDROID SIM CALL</span>
                  </button>
                )}

                {simNotice && (
                  <p className="text-xs text-cyan-200 bg-cyan-950/40 border border-cyan-500/30 rounded-lg p-2.5">
                    {simNotice}
                  </p>
                )}
              </div>

              <div className="p-3.5 rounded-xl bg-slate-900/50 border border-cyan-500/20 text-xs text-slate-300 leading-relaxed">
                <strong className="text-cyan-300">Voice Call Commands:</strong> আপনি সরাসরি Zoni-কে বলতে পারেন —{' '}
                <code>&ldquo;কল করো 01712345678&rdquo;</code> বা <code>&ldquo;Call 9876543210&rdquo;</code> — Zoni
                নেটিভ Android <code>ContactCallManager</code> ও Telecom ডায়ালার ব্যবহার করে SIM কল শুরু করবে।
              </div>
            </div>
          )}

          {activeTab === 'history' && (
            <div className="space-y-3">
              <div className="flex items-center justify-between p-3 rounded-xl bg-slate-900/60 border border-emerald-500/30">
                <div className="text-xs text-emerald-200">
                  <strong>Local SIM Call Log:</strong> Stored locally on device only. Clear anytime.
                </div>
                <button
                  onClick={handleClearHistory}
                  className="px-2.5 py-1.5 rounded-lg bg-rose-950/60 border border-rose-500/40 text-rose-300 hover:bg-rose-900/60 text-xs font-hud flex items-center gap-1 shrink-0"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>CLEAR</span>
                </button>
              </div>

              {historyList.length === 0 ? (
                <div className="p-6 rounded-xl bg-slate-900/40 border border-cyan-500/20 text-center space-y-1">
                  <History className="w-6 h-6 text-cyan-400/60 mx-auto" />
                  <p className="text-xs text-slate-300">No SIM calls logged yet.</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {historyList.map((call) => (
                    <div
                      key={call.id}
                      className="p-3 rounded-xl bg-slate-900/70 border border-cyan-500/25 space-y-1"
                    >
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-hud font-bold text-cyan-200">
                          📞 SIM — {call.targetName}
                        </span>
                        <span className="font-mono text-[10px] px-2 py-0.5 rounded bg-slate-950 border border-cyan-500/30 text-emerald-300 uppercase">
                          {call.status}
                        </span>
                      </div>
                      <div className="text-[11px] font-mono text-slate-400 flex justify-between">
                        <span>{call.phoneNumber}</span>
                        <span>{new Date(call.createdAtIso).toLocaleString()}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="shrink-0 p-3 sm:p-4 border-t border-cyan-500/20 bg-slate-900/60 flex items-center justify-between gap-2">
          <span className="text-[11px] font-hud text-cyan-400/80 truncate">
            ZONI ANDROID TELECOM // NATIVE SIM CALLING
          </span>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 px-4 py-1.5 rounded-lg bg-cyan-600/80 hover:bg-cyan-500 text-white font-hud text-xs tracking-wider"
          >
            CLOSE
          </button>
        </div>
      </div>
    </div>
  );
};
