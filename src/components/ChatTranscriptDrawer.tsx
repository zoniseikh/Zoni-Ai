import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChatMessage, SupportedLanguage } from '../types';
import {
  X,
  Volume2,
  Trash2,
  Heart,
  Bot,
  User,
  Search,
  Calendar,
  Shield,
  Download,
  Upload,
  Mic,
  MessageSquare,
  CheckCircle2,
  AlertTriangle,
  Eye,
  EyeOff,
  Database,
  RefreshCw,
} from 'lucide-react';
import {
  exportPermanentEncryptedBackup,
  getPermanentConversationDates,
  getPermanentStorageHealth,
  recoverPermanentPendingWrites,
  restorePermanentEncryptedBackup,
  searchPermanentConversationArchive,
  type LocalConversationRecord,
} from '../utils/localMemory';
import type {
  ConversationDateBucketSummary,
  PermanentStorageHealth,
} from '../utils/permanentMemoryBackup';

interface ChatTranscriptDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  messages: ChatMessage[];
  onReplayAudio: (text: string) => void;
  onClearMessages: () => void;
  onArchiveRestored?: () => void;
  activeLanguage?: SupportedLanguage;
  selectedAffectionName?: string;
  userNickname?: string;
}

const ARCHIVE_PAGE_SIZE = 30;

function formatArchiveTimestamp(ts: Date | number): string {
  const dateObj = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(dateObj.getTime())) return '';
  const datePart = dateObj.toLocaleDateString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
  const timePart = dateObj.toLocaleTimeString('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
  });
  return `${datePart} · ${timePart} IST`;
}

function recordToChatMessage(row: LocalConversationRecord): ChatMessage {
  return {
    id: row.id,
    role: row.role,
    text: row.text,
    timestamp: new Date(row.createdAtMs || Date.now()),
    lang:
      row.language === 'en-US' || row.language === 'hi-IN' || row.language === 'bn-BD'
        ? row.language
        : 'bn-BD',
    conversationId: row.conversationId,
    inputType: row.inputType,
    commandName: row.commandName,
    executionStatus: row.executionStatus,
  };
}

export const ChatTranscriptDrawer: React.FC<ChatTranscriptDrawerProps> = ({
  isOpen,
  onClose,
  messages,
  onReplayAudio,
  onClearMessages,
  onArchiveRestored,
  activeLanguage = 'bn-BD',
  selectedAffectionName,
  userNickname,
}) => {
  const activeName = (selectedAffectionName || userNickname || 'BOSS').toUpperCase();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [activeTab, setActiveTab] = useState<'archive' | 'backup'>('archive');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedDateBucket, setSelectedDateBucket] = useState('');
  const [inputFilter, setInputFilter] = useState<'' | 'voice' | 'text'>('');
  const [dateBuckets, setDateBuckets] = useState<ConversationDateBucketSummary[]>([]);
  const [archiveResults, setArchiveResults] = useState<ChatMessage[]>([]);
  const [archiveTotalMatched, setArchiveTotalMatched] = useState(0);
  const [archiveHasMore, setArchiveHasMore] = useState(false);
  const [archiveRangeLabel, setArchiveRangeLabel] = useState('');
  const [isSearchingArchive, setIsSearchingArchive] = useState(false);
  const [showFullArchiveBrowse, setShowFullArchiveBrowse] = useState(false);

  // Health & Encrypted Backup state
  const [health, setHealth] = useState<PermanentStorageHealth | null>(null);
  const [exportPassphrase, setExportPassphrase] = useState('');
  const [showExportPass, setShowExportPass] = useState(false);
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupFeedback, setBackupFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const [restorePassphrase, setRestorePassphrase] = useState('');
  const [showRestorePass, setShowRestorePass] = useState(false);
  const [restoreFileName, setRestoreFileName] = useState('');
  const [restoreRawJson, setRestoreRawJson] = useState('');
  const [replaceOnRestore, setReplaceOnRestore] = useState(false);

  const isArchiveFilterActive =
    showFullArchiveBrowse ||
    searchQuery.trim().length > 0 ||
    selectedDateBucket.length > 0 ||
    inputFilter !== '';

  const refreshHealthAndDates = useCallback(async () => {
    const [h, dates] = await Promise.all([
      getPermanentStorageHealth(),
      getPermanentConversationDates(90, 0),
    ]);
    setHealth(h);
    setDateBuckets(dates);
  }, []);

  const runArchiveSearch = useCallback(
    async (offset: number = 0, append: boolean = false) => {
      setIsSearchingArchive(true);
      try {
        const res = await searchPermanentConversationArchive({
          query: searchQuery.trim(),
          dateBucket: selectedDateBucket,
          inputType: inputFilter,
          limit: ARCHIVE_PAGE_SIZE,
          offset,
        });
        const mapped = res.messages.map(recordToChatMessage);
        setArchiveResults((prev) => (append ? [...prev, ...mapped] : mapped));
        setArchiveTotalMatched(res.totalMatched);
        setArchiveHasMore(res.hasMore);
        setArchiveRangeLabel(res.dateRangeApplied?.label || '');
      } finally {
        setIsSearchingArchive(false);
      }
    },
    [searchQuery, selectedDateBucket, inputFilter]
  );

  useEffect(() => {
    if (!isOpen) return;
    void refreshHealthAndDates();
  }, [isOpen, messages.length, refreshHealthAndDates]);

  useEffect(() => {
    if (!isOpen || activeTab !== 'archive') return;
    if (!isArchiveFilterActive) return;
    const timer = setTimeout(() => {
      void runArchiveSearch(0, false);
    }, 150);
    return () => clearTimeout(timer);
  }, [isOpen, activeTab, isArchiveFilterActive, runArchiveSearch]);

  useEffect(() => {
    if (scrollRef.current && activeTab === 'archive' && !isArchiveFilterActive) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, isOpen, activeTab, isArchiveFilterActive]);

  const handleExportBackup = async () => {
    setBackupFeedback(null);
    setBackupBusy(true);
    try {
      const res = await exportPermanentEncryptedBackup(exportPassphrase);
      if (!res.success || !res.encryptedArchiveJson) {
        setBackupFeedback({
          ok: false,
          text: res.error || 'Encrypted backup export failed.',
        });
        return;
      }
      const stamp = new Date().toISOString().slice(0, 10);
      const fileName = `zoni-permanent-backup-${stamp}.zonibak`;
      const blob = new Blob([res.encryptedArchiveJson], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1500);

      setBackupFeedback({
        ok: true,
        text: `Encrypted backup exported (${res.messageCount} messages, ${res.memoryCount} memories) to ${fileName}.`,
      });
      setExportPassphrase('');
    } finally {
      setBackupBusy(false);
    }
  };

  const handleBackupFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setRestoreFileName(file.name);
    setBackupFeedback(null);
    try {
      const text = await file.text();
      setRestoreRawJson(text);
    } catch {
      setRestoreRawJson('');
      setBackupFeedback({ ok: false, text: 'Could not read the selected backup file.' });
    }
  };

  const handleRestoreBackup = async () => {
    setBackupFeedback(null);
    if (!restoreRawJson.trim()) {
      setBackupFeedback({ ok: false, text: 'Select a .zonibak encrypted backup file first.' });
      return;
    }
    setBackupBusy(true);
    try {
      const res = await restorePermanentEncryptedBackup(
        restoreRawJson,
        restorePassphrase,
        replaceOnRestore
      );
      if (!res.success) {
        setBackupFeedback({ ok: false, text: res.error || 'Restore failed.' });
        return;
      }
      setBackupFeedback({
        ok: true,
        text: `Restored ${res.restoredMessages} messages and ${res.restoredMemories} long-term memories${
          res.skippedSensitive > 0 ? ` (${res.skippedSensitive} sensitive entries filtered)` : ''
        }.`,
      });
      setRestorePassphrase('');
      await refreshHealthAndDates();
      if (isArchiveFilterActive) {
        await runArchiveSearch(0, false);
      }
      onArchiveRestored?.();
    } finally {
      setBackupBusy(false);
    }
  };

  const handleRecoverPending = async () => {
    setBackupBusy(true);
    try {
      const count = await recoverPermanentPendingWrites();
      await refreshHealthAndDates();
      setBackupFeedback({
        ok: true,
        text:
          count > 0
            ? `Recovered ${count} pending conversation record(s) into permanent storage.`
            : 'No pending recovery writes remaining.',
      });
    } finally {
      setBackupBusy(false);
    }
  };

  if (!isOpen) return null;

  const displayedMessages = isArchiveFilterActive ? archiveResults : messages;
  const totalArchivedCount = health?.totalConversations ?? messages.length;

  return (
    <div
      data-testid="transcript-archive-drawer"
      className="fixed inset-0 z-50 flex items-center justify-end bg-black/60 backdrop-blur-sm transition-all p-2 sm:p-4"
    >
      <div className="w-full max-w-xl h-full max-h-[92vh] rounded-2xl bg-slate-950/95 border border-cyan-500/30 flex flex-col shadow-[0_0_50px_rgba(6,182,212,0.3)] overflow-hidden animate-in fade-in slide-in-from-right duration-300">
        {/* Drawer Header */}
        <div className="flex items-center justify-between gap-3 p-4 border-b border-cyan-500/20 bg-slate-900/50 shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <Heart className="w-4 h-4 text-pink-400 fill-pink-500 shrink-0" />
            <div className="min-w-0">
              <h3 className="font-sci-fi text-xs sm:text-sm font-bold tracking-wider text-cyan-200 truncate">
                TRANSCRIPT ARCHIVE
              </h3>
              <p className="text-[10px] font-mono text-cyan-400/75 truncate">
                ZONI &amp; {activeName} · {totalArchivedCount} SAVED · PERMANENT
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <div className="flex rounded-lg border border-cyan-500/30 bg-slate-950/80 p-0.5 text-[10px] font-hud">
              <button
                type="button"
                data-testid="archive-tab-history"
                onClick={() => setActiveTab('archive')}
                className={`px-2.5 py-1 rounded-md transition-colors cursor-pointer ${
                  activeTab === 'archive'
                    ? 'bg-cyan-500/25 text-cyan-100 font-bold'
                    : 'text-slate-400 hover:text-cyan-200'
                }`}
              >
                HISTORY
              </button>
              <button
                type="button"
                data-testid="archive-tab-backup"
                onClick={() => setActiveTab('backup')}
                className={`px-2.5 py-1 rounded-md flex items-center gap-1 transition-colors cursor-pointer ${
                  activeTab === 'backup'
                    ? 'bg-emerald-500/25 text-emerald-100 font-bold'
                    : 'text-slate-400 hover:text-emerald-200'
                }`}
              >
                <Shield className="w-3 h-3" />
                <span>BACKUP</span>
              </button>
            </div>
            {messages.length > 0 && activeTab === 'archive' && (
              <button
                type="button"
                onClick={() => {
                  onClearMessages();
                  setArchiveResults([]);
                  setDateBuckets([]);
                  setTimeout(() => void refreshHealthAndDates(), 150);
                }}
                className="p-1.5 rounded-lg border border-rose-500/30 text-rose-400 hover:bg-rose-950/40 transition-colors cursor-pointer"
                title="Clear Local Archive"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            )}
            <button
              type="button"
              data-testid="close-archive-drawer"
              onClick={onClose}
              className="p-1.5 rounded-lg border border-cyan-500/30 text-cyan-400 hover:bg-cyan-950/40 transition-colors cursor-pointer"
              aria-label="Close Archive"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {activeTab === 'archive' ? (
          <>
            {/* Search & Date Navigation Bar */}
            <div className="p-3 border-b border-cyan-500/15 bg-slate-900/35 space-y-2 shrink-0">
              <div className="flex items-center gap-2">
                <div className="relative flex-1">
                  <Search className="w-3.5 h-3.5 text-cyan-400/70 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    type="text"
                    data-testid="archive-search-input"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder={
                      activeLanguage === 'bn-BD'
                        ? 'খুঁজুন: কীওয়ার্ড, বিষয় বা তারিখ (যেমন: ১৫ দিন আগে, doctor)...'
                        : 'Search archive by keyword, topic, or date (e.g., 15 days ago)...'
                    }
                    className="w-full pl-8 pr-7 py-1.5 rounded-lg bg-slate-950/90 border border-cyan-500/30 text-xs text-cyan-50 placeholder:text-slate-500 focus:outline-none focus:border-cyan-400"
                  />
                  {searchQuery && (
                    <button
                      type="button"
                      onClick={() => setSearchQuery('')}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-cyan-200 cursor-pointer"
                      aria-label="Clear search"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
                <div className="flex items-center rounded-lg border border-cyan-500/25 bg-slate-950/80 p-0.5 text-[10px] font-mono shrink-0">
                  {(['', 'voice', 'text'] as const).map((kind) => (
                    <button
                      key={kind || 'all'}
                      type="button"
                      onClick={() => setInputFilter(kind)}
                      className={`px-2 py-1 rounded transition-colors cursor-pointer ${
                        inputFilter === kind
                          ? 'bg-cyan-500/25 text-cyan-100 font-bold'
                          : 'text-slate-400 hover:text-cyan-200'
                      }`}
                    >
                      {kind === '' ? 'ALL' : kind.toUpperCase()}
                    </button>
                  ))}
                </div>
              </div>

              {/* Date Picker + Quick Date Buckets */}
              <div className="flex items-center gap-2 overflow-x-auto pb-0.5">
                <label className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-slate-950/85 border border-cyan-500/25 text-[10px] font-mono text-cyan-300 shrink-0">
                  <Calendar className="w-3 h-3 text-cyan-400" />
                  <input
                    type="date"
                    data-testid="archive-date-input"
                    value={selectedDateBucket}
                    onChange={(e) => setSelectedDateBucket(e.target.value)}
                    className="bg-transparent text-cyan-100 focus:outline-none text-[10px] cursor-pointer [color-scheme:dark]"
                  />
                </label>

                {(selectedDateBucket || showFullArchiveBrowse || searchQuery || inputFilter) && (
                  <button
                    type="button"
                    onClick={() => {
                      setSearchQuery('');
                      setSelectedDateBucket('');
                      setInputFilter('');
                      setShowFullArchiveBrowse(false);
                    }}
                    className="px-2 py-1 rounded-lg border border-pink-500/30 bg-pink-950/30 text-[10px] font-mono text-pink-200 hover:bg-pink-900/40 shrink-0 cursor-pointer"
                  >
                    RESET
                  </button>
                )}

                {dateBuckets.slice(0, 12).map((bucket) => {
                  const active = selectedDateBucket === bucket.dateBucket;
                  return (
                    <button
                      key={bucket.dateBucket}
                      type="button"
                      onClick={() =>
                        setSelectedDateBucket(active ? '' : bucket.dateBucket)
                      }
                      className={`px-2 py-1 rounded-lg border text-[10px] font-mono shrink-0 transition-colors cursor-pointer ${
                        active
                          ? 'border-cyan-400 bg-cyan-500/25 text-cyan-100 font-bold'
                          : 'border-slate-700/80 bg-slate-900/70 text-slate-300 hover:border-cyan-500/40'
                      }`}
                    >
                      {bucket.dateBucket} ({bucket.messageCount})
                    </button>
                  );
                })}
              </div>

              {isArchiveFilterActive && (
                <div className="flex items-center justify-between text-[10px] font-mono text-cyan-300/80">
                  <span>
                    {isSearchingArchive
                      ? 'Searching permanent archive...'
                      : `Matched ${archiveTotalMatched} archived record(s)${
                          archiveRangeLabel ? ` · window: ${archiveRangeLabel}` : ''
                        }`}
                  </span>
                  {selectedDateBucket && (
                    <span className="text-pink-300">DATE: {selectedDateBucket}</span>
                  )}
                </div>
              )}
            </div>

            {/* Message Log */}
            <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3.5 hud-scanline">
              {!isArchiveFilterActive && totalArchivedCount > messages.length && (
                <div className="flex justify-center">
                  <button
                    type="button"
                    onClick={() => setShowFullArchiveBrowse(true)}
                    className="px-3 py-1.5 rounded-lg border border-cyan-500/35 bg-cyan-950/40 hover:bg-cyan-900/50 text-[11px] font-mono text-cyan-200 transition-colors cursor-pointer"
                  >
                    BROWSE ALL {totalArchivedCount} ARCHIVED MESSAGES
                  </button>
                </div>
              )}

              {displayedMessages.length === 0 ? (
                <div
                  data-testid="archive-empty-state"
                  className="h-full flex flex-col items-center justify-center text-center p-6 text-slate-400"
                >
                  <Bot className="w-8 h-8 text-cyan-500/40 mb-2 animate-pulse" />
                  <p className="font-hud text-sm text-cyan-300/80">
                    {isArchiveFilterActive
                      ? 'No matching archived conversations found.'
                      : 'No transcripts recorded yet.'}
                  </p>
                  <p className="text-xs text-slate-500 mt-1 max-w-xs">
                    {isArchiveFilterActive
                      ? 'ZONI strictly reports only verified records stored in your local archive and never guesses missing history.'
                      : 'Start talking to Zoni via the live voice link or text input! Every finalized turn is archived permanently.'}
                  </p>
                </div>
              ) : (
                <>
                  {displayedMessages.map((m) => {
                    const isAssistant = m.role === 'assistant';
                    const isVoice = m.inputType === 'voice';
                    return (
                      <div
                        key={m.id}
                        data-testid="archive-message-row"
                        className={`flex flex-col ${isAssistant ? 'items-start' : 'items-end'}`}
                      >
                        <div className="flex flex-wrap items-center gap-1.5 mb-1 px-1 text-[10px] font-mono">
                          {isAssistant ? (
                            <>
                              <Heart className="w-3 h-3 text-pink-400 fill-pink-400" />
                              <span className="text-pink-300 font-semibold">ZONI</span>
                            </>
                          ) : (
                            <>
                              <User className="w-3 h-3 text-cyan-400" />
                              <span className="text-cyan-300 font-semibold">{activeName}</span>
                            </>
                          )}
                          <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-slate-900/90 border border-slate-700/70 text-[9px] text-slate-300">
                            {isVoice ? (
                              <Mic className="w-2.5 h-2.5 text-cyan-400" />
                            ) : (
                              <MessageSquare className="w-2.5 h-2.5 text-slate-400" />
                            )}
                            {isVoice ? 'VOICE' : 'TEXT'}
                          </span>
                          {m.commandName && (
                            <span className="px-1.5 py-0.5 rounded bg-emerald-950/70 border border-emerald-500/30 text-[9px] text-emerald-300">
                              {m.commandName}
                              {m.executionStatus ? `:${m.executionStatus}` : ''}
                            </span>
                          )}
                          <span className="text-slate-500">
                            {formatArchiveTimestamp(m.timestamp)}
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
                                type="button"
                                onClick={() => onReplayAudio(m.text)}
                                className="flex items-center gap-1 text-[10px] font-hud text-pink-300 hover:text-pink-200 transition-colors cursor-pointer"
                              >
                                <Volume2 className="w-3 h-3" />
                                <span>REPLAY VOICE</span>
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}

                  {isArchiveFilterActive && archiveHasMore && (
                    <div className="flex justify-center pt-2">
                      <button
                        type="button"
                        disabled={isSearchingArchive}
                        onClick={() => void runArchiveSearch(archiveResults.length, true)}
                        className="px-4 py-1.5 rounded-lg border border-cyan-500/40 bg-slate-900/80 hover:bg-cyan-950/60 text-xs font-mono text-cyan-200 disabled:opacity-50 cursor-pointer"
                      >
                        {isSearchingArchive ? 'LOADING...' : 'LOAD OLDER ARCHIVED MESSAGES'}
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          </>
        ) : (
          /* Encrypted Backup & Restore Panel */
          <div
            data-testid="archive-backup-panel"
            className="flex-1 overflow-y-auto p-4 space-y-4 text-xs"
          >
            {/* Storage Health Summary */}
            <div className="p-3.5 rounded-xl bg-slate-900/75 border border-cyan-500/25 space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-cyan-200 font-hud font-bold">
                  <Database className="w-4 h-4 text-cyan-400" />
                  <span>PERMANENT LOCAL ARCHIVE STATUS</span>
                </div>
                <button
                  type="button"
                  onClick={() => void refreshHealthAndDates()}
                  className="p-1 rounded border border-cyan-500/30 text-cyan-300 hover:bg-cyan-950/50 cursor-pointer"
                  title="Refresh storage status"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                </button>
              </div>

              <div className="grid grid-cols-2 gap-2 font-mono text-[11px]">
                <div className="p-2 rounded-lg bg-slate-950/80 border border-slate-800">
                  <div className="text-slate-400 text-[10px]">ARCHIVED MESSAGES</div>
                  <div className="text-cyan-200 font-bold text-sm">
                    {health?.totalConversations ?? messages.length}
                  </div>
                </div>
                <div className="p-2 rounded-lg bg-slate-950/80 border border-slate-800">
                  <div className="text-slate-400 text-[10px]">LONG-TERM MEMORIES</div>
                  <div className="text-pink-200 font-bold text-sm">
                    {health?.totalMemories ?? 0}
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] font-mono text-slate-300 pt-1">
                <span>
                  AT-REST PROTECTION:{' '}
                  <strong className="text-emerald-300">
                    {health?.encryptedAtRest
                      ? 'ANDROID KEYSTORE AES-256-GCM'
                      : 'PRIVATE INDEXEDDB (EXPORT USES AES-256-GCM)'}
                  </strong>
                </span>
                <span>
                  INTEGRITY:{' '}
                  <strong className={health?.healthy ? 'text-emerald-300' : 'text-amber-300'}>
                    {(health?.integrityStatus || 'OK').toUpperCase()}
                  </strong>
                </span>
              </div>

              {(health?.pendingRecoveryCount ?? 0) > 0 && (
                <div className="flex items-center justify-between p-2 rounded-lg bg-amber-950/50 border border-amber-500/40 text-amber-200 text-[11px]">
                  <span>{health?.pendingRecoveryCount} pending write(s) queued for recovery.</span>
                  <button
                    type="button"
                    disabled={backupBusy}
                    onClick={() => void handleRecoverPending()}
                    className="px-2.5 py-1 rounded bg-amber-600/40 hover:bg-amber-600/60 font-bold cursor-pointer"
                  >
                    RECOVER NOW
                  </button>
                </div>
              )}
            </div>

            {/* Honest Durability Notice */}
            <div className="p-3 rounded-xl bg-amber-950/30 border border-amber-500/30 text-amber-100/90 space-y-1">
              <div className="flex items-center gap-1.5 font-hud font-bold text-amber-300 text-[11px]">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                <span>IMPORTANT: UNINSTALL &amp; DEVICE MIGRATION NOTICE</span>
              </div>
              <p className="text-[11px] leading-relaxed text-amber-100/80">
                ZONI permanently retains all finalized voice and text conversations in local storage
                with zero automatic deletion. However, local app storage alone cannot survive
                uninstalling the app, tapping &ldquo;Clear Data&rdquo;, or phone hardware failure.
                Export an encrypted backup file regularly to safely restore after reinstall or on a
                new phone.
              </p>
            </div>

            {backupFeedback && (
              <div
                data-testid="backup-feedback-banner"
                className={`p-3 rounded-xl border flex items-start gap-2 text-[11px] ${
                  backupFeedback.ok
                    ? 'bg-emerald-950/45 border-emerald-500/40 text-emerald-200'
                    : 'bg-rose-950/45 border-rose-500/40 text-rose-200'
                }`}
              >
                {backupFeedback.ok ? (
                  <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5 text-emerald-400" />
                ) : (
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-rose-400" />
                )}
                <span>{backupFeedback.text}</span>
              </div>
            )}

            {/* Export Encrypted Backup */}
            <div className="p-3.5 rounded-xl bg-slate-900/75 border border-emerald-500/25 space-y-2.5">
              <div className="flex items-center gap-2 font-hud font-bold text-emerald-200">
                <Download className="w-4 h-4 text-emerald-400" />
                <span>EXPORT ENCRYPTED BACKUP (AES-256-GCM)</span>
              </div>
              <p className="text-[11px] text-slate-400">
                Protected with PBKDF2-SHA256 + AES-256-GCM. Sensitive passwords, OTPs, PINs, and
                card numbers are never included.
              </p>
              <div className="relative">
                <input
                  type={showExportPass ? 'text' : 'password'}
                  data-testid="backup-export-passphrase"
                  value={exportPassphrase}
                  onChange={(e) => setExportPassphrase(e.target.value)}
                  placeholder="Enter backup passphrase (min 8 characters)"
                  className="w-full px-3 py-2 pr-9 rounded-lg bg-slate-950 border border-emerald-500/30 text-xs text-emerald-50 placeholder:text-slate-500 focus:outline-none focus:border-emerald-400"
                />
                <button
                  type="button"
                  onClick={() => setShowExportPass((v) => !v)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-emerald-200 cursor-pointer"
                  aria-label="Toggle passphrase visibility"
                >
                  {showExportPass ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              <button
                type="button"
                data-testid="backup-export-button"
                disabled={backupBusy || exportPassphrase.trim().length < 8}
                onClick={() => void handleExportBackup()}
                className="w-full py-2 rounded-lg bg-emerald-600/80 hover:bg-emerald-500 disabled:opacity-40 text-white font-hud font-bold text-xs tracking-wider transition-colors flex items-center justify-center gap-2 cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" />
                <span>{backupBusy ? 'ENCRYPTING...' : 'EXPORT ENCRYPTED BACKUP (.ZONIBAK)'}</span>
              </button>
            </div>

            {/* Restore Encrypted Backup */}
            <div className="p-3.5 rounded-xl bg-slate-900/75 border border-cyan-500/25 space-y-2.5">
              <div className="flex items-center gap-2 font-hud font-bold text-cyan-200">
                <Upload className="w-4 h-4 text-cyan-400" />
                <span>RESTORE ENCRYPTED BACKUP</span>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".zonibak,.json,application/json"
                onChange={(e) => void handleBackupFileSelected(e)}
                className="hidden"
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="w-full py-2 px-3 rounded-lg border border-dashed border-cyan-500/40 bg-slate-950/70 hover:bg-cyan-950/35 text-cyan-200 text-xs font-mono truncate cursor-pointer"
              >
                {restoreFileName ? `Selected: ${restoreFileName}` : 'CHOOSE .ZONIBAK BACKUP FILE'}
              </button>
              <div className="relative">
                <input
                  type={showRestorePass ? 'text' : 'password'}
                  data-testid="backup-restore-passphrase"
                  value={restorePassphrase}
                  onChange={(e) => setRestorePassphrase(e.target.value)}
                  placeholder="Enter passphrase used when creating backup"
                  className="w-full px-3 py-2 pr-9 rounded-lg bg-slate-950 border border-cyan-500/30 text-xs text-cyan-50 placeholder:text-slate-500 focus:outline-none focus:border-cyan-400"
                />
                <button
                  type="button"
                  onClick={() => setShowRestorePass((v) => !v)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-cyan-200 cursor-pointer"
                  aria-label="Toggle restore passphrase visibility"
                >
                  {showRestorePass ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              <label className="flex items-center gap-2 text-[11px] text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={replaceOnRestore}
                  onChange={(e) => setReplaceOnRestore(e.target.checked)}
                  className="accent-cyan-500"
                />
                <span>Replace existing local history instead of merging</span>
              </label>
              <button
                type="button"
                data-testid="backup-restore-button"
                disabled={backupBusy || !restoreRawJson || !restorePassphrase.trim()}
                onClick={() => void handleRestoreBackup()}
                className="w-full py-2 rounded-lg bg-cyan-600/80 hover:bg-cyan-500 disabled:opacity-40 text-white font-hud font-bold text-xs tracking-wider transition-colors flex items-center justify-center gap-2 cursor-pointer"
              >
                <Upload className="w-3.5 h-3.5" />
                <span>{backupBusy ? 'DECRYPTING & RESTORING...' : 'DECRYPT & RESTORE ARCHIVE'}</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
