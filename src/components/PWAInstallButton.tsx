import React, { useState } from 'react';
import { Download, Smartphone, WifiOff, X } from 'lucide-react';
import { usePWAInstall, useOnlineStatus } from '../utils/usePWAInstall';

export const PWAInstallButton: React.FC<{ onOpenApkModal?: () => void }> = ({
  onOpenApkModal,
}) => {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showIOSGuide, setShowIOSGuide] = useState(false);

  if (isInstalled) {
    return null;
  }

  if (isInstallable) {
    return (
      <button
        onClick={install}
        aria-label="Install Zoni AI Android App"
        className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-emerald-400/60 bg-emerald-950/60 hover:bg-emerald-900/60 text-emerald-200 text-xs font-hud font-bold tracking-wider transition-all shadow-[0_0_12px_rgba(16,185,129,0.28)]"
        title="Install Zoni AI directly onto your Android Home Screen"
      >
        <Download className="w-3.5 h-3.5 text-emerald-400" />
        <span>INSTALL</span>
      </button>
    );
  }

  if (isIOS) {
    return (
      <>
        <button
          onClick={() => setShowIOSGuide(true)}
          aria-label="Install on iPhone or iPad"
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-cyan-500/40 bg-slate-900/70 text-cyan-200 text-xs font-hud tracking-wider hover:border-cyan-400 transition-all"
        >
          <Smartphone className="w-3.5 h-3.5 text-cyan-400" />
          <span className="hidden sm:inline">INSTALL</span>
        </button>
        {showIOSGuide && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
            <div className="w-full max-w-sm rounded-2xl bg-slate-950 border border-cyan-500/40 p-5 shadow-2xl space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="font-sci-fi text-sm font-bold text-cyan-200">
                  INSTALL ZONI AI
                </h3>
                <button
                  onClick={() => setShowIOSGuide(false)}
                  aria-label="Close install guide"
                  className="p-1 rounded-lg text-cyan-400 hover:bg-cyan-950/50"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              <p className="text-xs text-slate-300 leading-relaxed">
                1. Tap the <strong>Share</strong> button in your browser toolbar.<br />
                2. Scroll down and select <strong>Add to Home Screen</strong>.
              </p>
              <button
                onClick={() => setShowIOSGuide(false)}
                className="w-full py-2 rounded-xl bg-cyan-600 hover:bg-cyan-500 text-white font-hud text-xs font-bold tracking-wider"
              >
                GOT IT
              </button>
            </div>
          </div>
        )}
      </>
    );
  }

  // On desktop / Android without deferred prompt yet, route directly to APK Hub modal
  if (onOpenApkModal) {
    return (
      <button
        onClick={onOpenApkModal}
        aria-label="Open Android App & APK Hub"
        className="flex items-center gap-1.5 px-2 sm:px-2.5 py-1 rounded-lg border border-pink-500/50 bg-pink-950/40 hover:bg-pink-900/50 text-pink-200 text-xs font-hud tracking-wider transition-all shadow-[0_0_10px_rgba(236,72,153,0.25)]"
        title="Android Native App & APK Hub"
      >
        <Smartphone className="w-3.5 h-3.5 text-pink-400 animate-pulse" />
        <span className="hidden md:inline">ANDROID APK</span>
      </button>
    );
  }

  return null;
};

export const OfflineIndicator: React.FC = () => {
  const isOnline = useOnlineStatus();
  if (isOnline) return null;

  return (
    <div
      role="status"
      className="fixed bottom-24 left-4 z-50 flex items-center gap-2 rounded-xl bg-amber-950/90 border border-amber-500/60 px-3 py-1.5 text-xs font-hud font-semibold text-amber-200 shadow-[0_0_20px_rgba(245,158,11,0.3)] backdrop-blur-md"
    >
      <WifiOff className="w-3.5 h-3.5 text-amber-400 animate-pulse" />
      <span>অফলাইন মোড — সময়, তারিখ ও ডিভাইস কন্ট্রোল সচল আছে</span>
    </div>
  );
};
