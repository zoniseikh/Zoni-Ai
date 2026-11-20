import React, { useState, useEffect } from 'react';
import {
  X,
  Smartphone,
  PhoneCall,
  MessageSquare,
  Share2,
  Flashlight,
  Vibrate,
  BatteryCharging,
  Download,
  ShieldCheck,
  Terminal,
  CheckCircle2,
  Copy,
} from 'lucide-react';
import {
  executeCall,
  executeSms,
  executeWhatsApp,
  toggleFlashlight,
  triggerVibration,
  getDeviceBattery,
} from '../utils/mobileAssistant';
import { playProceduralSfx } from '../utils/audio';

interface ApkExportModalProps {
  isOpen: boolean;
  onClose: () => void;
  soundFxEnabled: boolean;
  deferredPrompt: any;
  onInstallPwa: () => void;
  selectedAffectionName?: string;
}

export const ApkExportModal: React.FC<ApkExportModalProps> = ({
  isOpen,
  onClose,
  soundFxEnabled,
  deferredPrompt,
  onInstallPwa,
  selectedAffectionName,
}) => {
  const currentAffection = selectedAffectionName || 'Boss';
  const [activeTab, setActiveTab] = useState<'apk' | 'actions' | 'permissions'>('apk');
  const [testNumber, setTestNumber] = useState('01700000000');
  const [testMsg, setTestMsg] = useState(`Hello ${currentAffection}, Zoni Assistant is active! ❤️`);
  const [torchActive, setTorchActive] = useState(false);
  const [batteryInfo, setBatteryInfo] = useState<{ level: number; charging: boolean } | null>(null);
  const [copiedCode, setCopiedCode] = useState(false);

  useEffect(() => {
    setTestMsg(`Hello ${selectedAffectionName || 'Boss'}, Zoni Assistant is active! ❤️`);
  }, [selectedAffectionName]);

  useEffect(() => {
    if (isOpen) {
      getDeviceBattery().then((res) => {
        if (res) setBatteryInfo(res);
      });
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleTorchToggle = async () => {
    if (soundFxEnabled) playProceduralSfx('click');
    const newState = !torchActive;
    const success = await toggleFlashlight(newState);
    if (success || !newState) {
      setTorchActive(newState);
    }
  };

  const handleVibrateTest = () => {
    if (soundFxEnabled) playProceduralSfx('heartbeat');
    triggerVibration([200, 100, 300]);
  };

  const handleCopyCli = () => {
    const cliCommands = `# Build Genuine Native Android APK (Kotlin + Jetpack Compose)
cd android
./gradlew assembleDebug

# Output APK Location:
# android/app/build/outputs/apk/debug/app-debug.apk

# Install directly onto connected Android phone via ADB:
adb install -r app/build/outputs/apk/debug/app-debug.apk`;
    navigator.clipboard.writeText(cliCommands);
    setCopiedCode(true);
    if (soundFxEnabled) playProceduralSfx('click');
    setTimeout(() => setCopiedCode(false), 2500);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-md p-3 sm:p-5 overflow-y-auto">
      <div className="w-full max-w-2xl bg-slate-950 border border-cyan-500/40 rounded-2xl shadow-[0_0_60px_rgba(6,182,212,0.3)] flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-200 my-auto">
        {/* Header */}
        <div className="flex items-center justify-between p-4 sm:p-5 border-b border-cyan-500/20 bg-slate-900/60">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-cyan-950/80 border border-cyan-400/50 flex items-center justify-center text-cyan-400">
              <Smartphone className="w-5 h-5" />
            </div>
            <div>
              <h2 className="font-sci-fi text-base font-bold text-cyan-200 tracking-wide">
                ANDROID NATIVE APK &amp; ASSISTANT HUB
              </h2>
              <p className="text-xs font-hud text-pink-400">
                পূর্ণাঙ্গ নেটিভ Android Kotlin/Compose অ্যাপ এবং মোবাইল অ্যাসিস্ট্যান্ট (APK)
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close Android Hub"
            className="p-1.5 rounded-lg border border-cyan-500/30 text-cyan-400 hover:bg-cyan-950/50 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tab Switcher */}
        <div className="flex border-b border-cyan-500/20 bg-slate-900/30 px-4 pt-2 gap-2 text-xs font-hud tracking-wider overflow-x-auto">
          <button
            onClick={() => setActiveTab('apk')}
            className={`pb-2.5 px-3 font-semibold border-b-2 transition-all shrink-0 ${
              activeTab === 'apk'
                ? 'border-cyan-400 text-cyan-300'
                : 'border-transparent text-slate-400 hover:text-cyan-200'
            }`}
          >
            📱 1. BUILD APK / INSTALL
          </button>
          <button
            onClick={() => setActiveTab('actions')}
            className={`pb-2.5 px-3 font-semibold border-b-2 transition-all shrink-0 ${
              activeTab === 'actions'
                ? 'border-pink-400 text-pink-300'
                : 'border-transparent text-slate-400 hover:text-pink-200'
            }`}
          >
            ⚡ 2. MOBILE ASSISTANT ACTIONS
          </button>
          <button
            onClick={() => setActiveTab('permissions')}
            className={`pb-2.5 px-3 font-semibold border-b-2 transition-all shrink-0 ${
              activeTab === 'permissions'
                ? 'border-amber-400 text-amber-300'
                : 'border-transparent text-slate-400 hover:text-amber-200'
            }`}
          >
            🛡️ 3. ANDROID PERMISSIONS
          </button>
        </div>

        {/* Tab Body */}
        <div className="p-4 sm:p-6 overflow-y-auto max-h-[70vh] space-y-4">
          {activeTab === 'apk' && (
            <div className="space-y-4">
              {/* Build Metadata & GitHub Actions Pipeline Banner */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px] font-mono">
                <div className="p-2.5 rounded-lg bg-slate-900/80 border border-cyan-500/25">
                  <div className="text-[9px] text-slate-400">PACKAGE ID</div>
                  <div className="text-cyan-300 font-bold truncate">com.zoni.jarvis.assistant</div>
                </div>
                <div className="p-2.5 rounded-lg bg-slate-900/80 border border-cyan-500/25">
                  <div className="text-[9px] text-slate-400">VERSION</div>
                  <div className="text-pink-300 font-bold">v1.0.0 (SDK 26–34)</div>
                </div>
                <div className="p-2.5 rounded-lg bg-slate-900/80 border border-cyan-500/25">
                  <div className="text-[9px] text-slate-400">CI WORKFLOW</div>
                  <div className="text-emerald-300 font-bold truncate">android-build.yml</div>
                </div>
                <div className="p-2.5 rounded-lg bg-slate-900/80 border border-cyan-500/25">
                  <div className="text-[9px] text-slate-400">BUILD TIME</div>
                  <div className="text-cyan-200 font-bold truncate">
                    {new Date().toISOString().slice(0, 10)}
                  </div>
                </div>
              </div>

              {/* Option A: Automated GitHub Actions APK & AAB Build */}
              <div className="p-4 rounded-xl bg-gradient-to-r from-cyan-950/60 to-slate-900/90 border border-cyan-400/50 space-y-3">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <span className="font-hud text-sm font-bold text-cyan-200 flex items-center gap-2">
                    <Terminal className="w-4 h-4 text-cyan-400" />
                    ১. জেনুইন নেটিভ Android APK &amp; AAB (GitHub Actions / Gradle)
                  </span>
                  <button
                    onClick={handleCopyCli}
                    className="flex items-center gap-1 text-[11px] font-mono text-cyan-300 hover:text-cyan-100 px-2 py-0.5 rounded bg-cyan-950/80 border border-cyan-500/40"
                  >
                    {copiedCode ? (
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                    ) : (
                      <Copy className="w-3.5 h-3.5" />
                    )}
                    <span>{copiedCode ? 'COPIED!' : 'COPY BUILD CLI'}</span>
                  </button>
                </div>
                <p className="text-xs text-slate-300 leading-relaxed">
                  মূল ZONI AI React ড্যাশবোর্ডটি সম্পূর্ণ অক্ষত রেখেই নেটিভ Android শেলের (<code>WebViewAssetLoader</code> +{' '}
                  <code>ZoniWebAppInterface</code> + Kotlin Telecom/SIM/Room DB/Camera2/Foreground Service) ভেতরে প্যাকেজ করা হয়েছে।
                  GitHub-এ পুশ করলে <code>.github/workflows/android-build.yml</code> স্বয়ংক্রিয়ভাবে আসল APK তৈরি করে:
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-[10px] font-mono">
                  <div className="p-2 rounded-lg bg-black/60 border border-cyan-500/30">
                    <div className="text-cyan-300 font-bold">DEBUG APK (NO SIGNING)</div>
                    <div className="text-slate-400 break-all mt-0.5">
                      android/app/build/outputs/apk/debug/app-debug.apk
                    </div>
                  </div>
                  <div className="p-2 rounded-lg bg-black/60 border border-pink-500/30">
                    <div className="text-pink-300 font-bold">SIGNED RELEASE APK</div>
                    <div className="text-slate-400 break-all mt-0.5">
                      android/app/build/outputs/apk/release/app-release.apk
                    </div>
                  </div>
                  <div className="p-2 rounded-lg bg-black/60 border border-emerald-500/30">
                    <div className="text-emerald-300 font-bold">PLAY STORE AAB</div>
                    <div className="text-slate-400 break-all mt-0.5">
                      android/app/build/outputs/bundle/release/app-release.aab
                    </div>
                  </div>
                </div>
                <pre className="p-3 rounded-lg bg-black/80 border border-cyan-500/30 text-[11px] font-mono text-cyan-300 overflow-x-auto leading-relaxed">
{`# 1. Build React Dashboard & Sync into Android Assets
npm run android:sync

# 2. Build Real Debug APK (JDK 17 + Android SDK 34)
cd android && ./gradlew assembleDebug

# 3. Install onto Android Phone via USB / ADB
adb install -r app/build/outputs/apk/debug/app-debug.apk`}
                </pre>
                <div className="text-[11px] text-pink-200 bg-pink-950/35 p-2.5 rounded-lg border border-pink-500/30">
                  💡 <strong>GitHub Actions:</strong> Repository &gt; <strong>Actions</strong> &gt;{' '}
                  <strong>ZONI AI Android APK Build</strong> &gt; Artifacts থেকে সরাসরি{' '}
                  <code>ZONI-AI-Debug-APK</code> বা <code>ZONI-AI-Release-APK</code> ডাউনলোড করে অ্যান্ড্রয়েডে ইনস্টল করুন।
                </div>
              </div>

              {/* Option B: Browser Home-Screen Shortcut (Explicitly NOT equivalent to Native APK) */}
              <div className="p-4 rounded-xl bg-slate-900/60 border border-amber-500/30 space-y-2.5">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <span className="font-hud text-sm font-bold text-amber-200 flex items-center gap-2">
                    <Download className="w-4 h-4 text-amber-400" />
                    ২. ব্রাউজার ওয়েব শর্টকাট (PWA — নেটিভ APK নয়)
                  </span>
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-amber-950 border border-amber-500/40 text-amber-300">
                    WEB SHORTCUT ONLY
                  </span>
                </div>
                <p className="text-xs text-slate-300 leading-relaxed">
                  <strong>গুরুত্বপূর্ণ পার্থক্য:</strong> এটি শুধুমাত্র ব্রাউজার শর্টকাট — এতে নেটিভ Android Telecom,
                  Room DB, Floating Orb বা Foreground Service কাজ করবে না। সম্পূর্ণ অ্যান্ড্রয়েড ফিচারের জন্য উপরের
                  <strong> জেনুইন নেটিভ Android APK</strong> ইনস্টল করুন।
                </p>
                <button
                  onClick={onInstallPwa}
                  className="w-full py-2 px-3 rounded-lg bg-slate-800 hover:bg-slate-700 border border-amber-500/40 text-amber-200 font-hud text-xs font-bold tracking-wider uppercase flex items-center justify-center gap-2"
                >
                  <Smartphone className="w-3.5 h-3.5" />
                  <span>
                    {deferredPrompt ? 'ADD BROWSER SHORTCUT (PWA)' : 'BROWSER HOME SCREEN SHORTCUT'}
                  </span>
                </button>
              </div>
            </div>
          )}

          {activeTab === 'actions' && (
            <div className="space-y-4">
              <p className="text-xs text-slate-300 leading-relaxed">
                আপনার মোবাইল ডিভাইস থেকে সরাসরি কল, মেসেজ বা হার্ডওয়্যার ফিচার টেস্ট করুন (Zoni এআই ভয়েস কমান্ড দিয়েও চালানো যাবে):
              </p>

              {/* Input for testing */}
              <div className="p-3 rounded-xl bg-slate-900/50 border border-cyan-500/20 space-y-2">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <div>
                    <label className="text-[10px] font-mono text-cyan-400">PHONE NUMBER / ফোন নম্বর</label>
                    <input
                      type="text"
                      value={testNumber}
                      onChange={(e) => setTestNumber(e.target.value)}
                      placeholder="e.g. 01700000000"
                      className="w-full mt-1 px-3 py-1.5 rounded-lg bg-slate-950 border border-cyan-500/30 text-xs text-cyan-100 font-mono focus:outline-none focus:border-cyan-400"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] font-mono text-pink-400">MESSAGE / বার্তা</label>
                    <input
                      type="text"
                      value={testMsg}
                      onChange={(e) => setTestMsg(e.target.value)}
                      placeholder="Type a message..."
                      className="w-full mt-1 px-3 py-1.5 rounded-lg bg-slate-950 border border-pink-500/30 text-xs text-pink-100 focus:outline-none focus:border-pink-400"
                    />
                  </div>
                </div>
              </div>

              {/* Action Buttons Matrix */}
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
                <button
                  onClick={() => {
                    if (soundFxEnabled) playProceduralSfx('click');
                    executeCall(testNumber);
                  }}
                  className="p-3 rounded-xl bg-slate-900/60 border border-cyan-500/30 hover:border-cyan-400 text-left flex flex-col gap-1 transition-all group"
                >
                  <PhoneCall className="w-5 h-5 text-cyan-400 group-hover:scale-110 transition-transform" />
                  <span className="font-hud font-bold text-xs text-cyan-200">DIRECT CALL</span>
                  <span className="text-[10px] text-slate-400">সরাসরি ফোন কল</span>
                </button>

                <button
                  onClick={() => {
                    if (soundFxEnabled) playProceduralSfx('click');
                    executeWhatsApp(testNumber, testMsg);
                  }}
                  className="p-3 rounded-xl bg-slate-900/60 border border-emerald-500/30 hover:border-emerald-400 text-left flex flex-col gap-1 transition-all group"
                >
                  <Share2 className="w-5 h-5 text-emerald-400 group-hover:scale-110 transition-transform" />
                  <span className="font-hud font-bold text-xs text-emerald-200">WHATSAPP</span>
                  <span className="text-[10px] text-slate-400">হোয়াটসঅ্যাপ বার্তা</span>
                </button>

                <button
                  onClick={() => {
                    if (soundFxEnabled) playProceduralSfx('click');
                    executeSms(testNumber, testMsg);
                  }}
                  className="p-3 rounded-xl bg-slate-900/60 border border-pink-500/30 hover:border-pink-400 text-left flex flex-col gap-1 transition-all group"
                >
                  <MessageSquare className="w-5 h-5 text-pink-400 group-hover:scale-110 transition-transform" />
                  <span className="font-hud font-bold text-xs text-pink-200">SMS MESSENGER</span>
                  <span className="text-[10px] text-slate-400">এসএমএস পাঠান</span>
                </button>

                <button
                  onClick={handleTorchToggle}
                  className={`p-3 rounded-xl border text-left flex flex-col gap-1 transition-all group ${
                    torchActive
                      ? 'bg-amber-950/60 border-amber-400 text-amber-200 shadow-[0_0_15px_rgba(245,158,11,0.4)]'
                      : 'bg-slate-900/60 border-cyan-500/30 text-slate-300 hover:border-cyan-400'
                  }`}
                >
                  <Flashlight className="w-5 h-5 text-amber-400 group-hover:scale-110 transition-transform" />
                  <span className="font-hud font-bold text-xs">
                    {torchActive ? 'TORCH ON' : 'TORCH OFF'}
                  </span>
                  <span className="text-[10px] text-slate-400">ফ্ল্যাশলাইট কন্ট্রোল</span>
                </button>

                <button
                  onClick={handleVibrateTest}
                  className="p-3 rounded-xl bg-slate-900/60 border border-cyan-500/30 hover:border-cyan-400 text-left flex flex-col gap-1 transition-all group"
                >
                  <Vibrate className="w-5 h-5 text-purple-400 group-hover:scale-110 transition-transform" />
                  <span className="font-hud font-bold text-xs text-purple-200">HAPTIC VIBRATE</span>
                  <span className="text-[10px] text-slate-400">মোবাইল ভাইব্রেশন</span>
                </button>

                <div className="p-3 rounded-xl bg-slate-900/60 border border-cyan-500/30 text-left flex flex-col gap-1">
                  <BatteryCharging className="w-5 h-5 text-emerald-400" />
                  <span className="font-hud font-bold text-xs text-emerald-200">
                    BATTERY: {batteryInfo ? `${batteryInfo.level}%` : 'ONLINE'}
                  </span>
                  <span className="text-[10px] text-slate-400">
                    {batteryInfo?.charging ? 'Charging' : 'Normal'}
                  </span>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'permissions' && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 p-2.5 rounded-lg bg-emerald-950/40 border border-emerald-500/30 text-emerald-300 text-xs">
                <ShieldCheck className="w-4 h-4 shrink-0" />
                <span>
                  প্রজেক্টের <code>AndroidManifest.xml</code>-এ সকল প্রয়োজনীয় পারমিশন কনফিগার করা আছে:
                </span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs font-mono">
                {[
                  { name: 'RECORD_AUDIO', desc: 'Gemini লাইভ অডিও রেকর্ডিং' },
                  { name: 'CALL_PHONE', desc: 'সরাসরি ফোন কল করার পারমিশন' },
                  { name: 'SEND_SMS', desc: 'সরাসরি মেসেজ পাঠানো' },
                  { name: 'READ_CONTACTS', desc: 'কন্টাক্ট লিস্ট যাচাই' },
                  { name: 'CAMERA & FLASHLIGHT', desc: 'মোবাইল ফ্ল্যাশলাইট অন/অফ' },
                  { name: 'SYSTEM_ALERT_WINDOW', desc: 'অন্যান্য অ্যাপের উপর ফ্লোটিং অ্যাসিস্ট্যান্ট' },
                  { name: 'VIBRATE', desc: 'হ্যাপটিক ভাইব্রেশন ফিডব্যাক' },
                  { name: 'POST_NOTIFICATIONS', desc: 'সিস্টেম নোটিফিকেশন অ্যালার্ট' },
                  { name: 'FOREGROUND_SERVICE', desc: 'ব্যাকগ্রাউন্ড অ্যাসিস্ট্যান্ট রানিং' },
                  { name: 'WHATSAPP QUERIES', desc: 'হোয়াটসঅ্যাপ ইন্টেন্ট হ্যান্ডলিং' },
                ].map((item, idx) => (
                  <div
                    key={idx}
                    className="p-2.5 rounded-lg bg-slate-900/60 border border-cyan-500/20 flex flex-col"
                  >
                    <span className="text-cyan-300 font-bold">{item.name}</span>
                    <span className="text-[11px] text-slate-400 font-sans mt-0.5">{item.desc}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-3 sm:p-4 border-t border-cyan-500/20 bg-slate-900/60 flex items-center justify-between">
          <span className="text-[11px] font-hud text-cyan-400/80">
            ZONI JARVIS ASSISTANT // ANDROID CAPACITOR READY
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
