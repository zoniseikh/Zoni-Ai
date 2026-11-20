import React, { useState, useEffect } from 'react';
import {
  ChromePermissionsReport,
  requestMicrophoneAccess,
  requestGeolocationAccess,
  requestNotificationAccess,
  checkAllPermissions,
  PermissionState,
} from '../utils/permissionManager';
import {
  getNativeAndroidBridge,
  getNativePermissionsSnapshot,
} from '../utils/androidBridge';
import { playProceduralSfx } from '../utils/audio';
import {
  Key,
  Mic,
  Bell,
  Camera,
  PhoneCall,
  Users,
  MessageSquare,
  MapPin,
  Image,
  PhoneIncoming,
  Bluetooth,
  BatteryCharging,
  Layers,
  MessageCircle,
  Sparkles,
  Zap,
  CheckCircle2,
  AlertCircle,
  ExternalLink,
  Clipboard,
  Eye,
  EyeOff,
  X,
  ArrowRight,
  ArrowLeft,
  Check,
  Shield,
  HelpCircle,
  Monitor,
} from 'lucide-react';

interface PermissionsSetupModalProps {
  isOpen: boolean;
  onClose: () => void;
  report: ChromePermissionsReport;
  onUpdateReport: (updated: ChromePermissionsReport) => void;
  onMicInitialized?: (stream: MediaStream) => void;
  onLocationInitialized?: (coords: { latitude: number; longitude: number }) => void;
  onNotificationInitialized?: () => void;
  soundFxEnabled: boolean;
  activeLanguage?: string;
  selectedAffectionName?: string;
}

export const PermissionsSetupModal: React.FC<PermissionsSetupModalProps> = ({
  isOpen,
  onClose,
  report,
  onUpdateReport,
  onMicInitialized,
  onLocationInitialized,
  onNotificationInitialized,
  soundFxEnabled,
  selectedAffectionName = 'Boss',
}) => {
  const [activeStep, setActiveStep] = useState<1 | 2 | 3>(1);

  // Step 1: Gemini Key State
  const [apiKey, setApiKey] = useState<string>(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('zoni_user_gemini_key') || '';
    }
    return '';
  });
  const [isKeyVisible, setIsKeyVisible] = useState(false);
  const [keyNotice, setKeyNotice] = useState<string | null>(null);

  // Step 2: Permissions State
  const [extraPermissions, setExtraPermissions] = useState<Record<string, boolean>>(() => {
    if (typeof window !== 'undefined') {
      try {
        const saved = localStorage.getItem('zoni_allowed_extra_permissions');
        if (saved) return JSON.parse(saved);
      } catch {
        // ignore
      }
    }
    return {
      camera: false,
      calls: false,
      contacts: false,
      sms: false,
      gallery: false,
      manageCalls: false,
      bluetooth: false,
    };
  });

  // Step 3: Background Availability State
  const [batteryOptimisationOff, setBatteryOptimisationOff] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('zoni_battery_unconstrained') === 'true';
    }
    return false;
  });
  const [displayOverApps, setDisplayOverApps] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('zoni_display_over_apps');
      return saved !== 'false'; // Default enabled
    }
    return true;
  });
  const [notificationAccess, setNotificationAccess] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('zoni_notif_access_enabled') === 'true';
    }
    return false;
  });
  const [accessibilityService, setAccessibilityService] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('zoni_accessibility_service_enabled') === 'true';
    }
    return false;
  });
  const [defaultAssistant, setDefaultAssistant] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('zoni_default_assistant_enabled') === 'true';
    }
    return false;
  });
  const [screenCaptureEnabled, setScreenCaptureEnabled] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('zoni_screen_capture_enabled') === 'true';
    }
    return false;
  });

  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Sync live native Android permission statuses when running inside the Android APK
  useEffect(() => {
    if (!isOpen) return;
    const syncNative = () => {
      const snap = getNativePermissionsSnapshot();
      if (!snap) return;
      setExtraPermissions((prev) => ({
        ...prev,
        camera: snap.camera,
        calls: snap.callPhone,
        contacts: snap.readContacts,
        sms: snap.sendSms,
        bluetooth: Boolean(snap.bluetooth),
      }));
      setBatteryOptimisationOff(snap.batteryOptimizationIgnored);
      setDisplayOverApps(snap.overlayAllowed);
      setNotificationAccess(snap.notificationListenerEnabled);
      setAccessibilityService(snap.accessibilityEnabled);
      setScreenCaptureEnabled(Boolean(snap.screenCaptureActive));
    };
    syncNative();
    const handleScreenEvent = (e: Event) => {
      const active = Boolean((e as CustomEvent)?.detail?.active);
      setScreenCaptureEnabled(active);
      localStorage.setItem('zoni_screen_capture_enabled', String(active));
    };
    window.addEventListener('zoni:native-permissions-updated', syncNative);
    window.addEventListener('zoni:screen-capture-changed', handleScreenEvent);
    window.addEventListener('focus', syncNative);
    return () => {
      window.removeEventListener('zoni:native-permissions-updated', syncNative);
      window.removeEventListener('zoni:screen-capture-changed', handleScreenEvent);
      window.removeEventListener('focus', syncNative);
    };
  }, [isOpen]);

  // Persist extra permissions on change
  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('zoni_allowed_extra_permissions', JSON.stringify(extraPermissions));
    }
  }, [extraPermissions]);

  if (!isOpen) return null;

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => {
      setToastMessage((current) => (current === msg ? null : current));
    }, 3000);
  };

  // --- Step 1 Handlers ---
  const handleGetFreeKey = () => {
    if (soundFxEnabled) playProceduralSfx('click');
    window.open('https://aistudio.google.com/app/apikey', '_blank');
  };

  const handlePasteKey = async () => {
    if (soundFxEnabled) playProceduralSfx('click');
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        setApiKey(text.trim());
        setKeyNotice('Key pasted from clipboard!');
        setTimeout(() => setKeyNotice(null), 2500);
      } else {
        setKeyNotice('Clipboard was empty.');
        setTimeout(() => setKeyNotice(null), 2500);
      }
    } catch {
      setKeyNotice('Please paste using Ctrl+V or Long-Press in the box.');
      setTimeout(() => setKeyNotice(null), 3500);
    }
  };

  const handleSaveAndContinueKey = () => {
    if (soundFxEnabled) playProceduralSfx('click');
    const trimmed = apiKey.trim();
    if (trimmed) {
      localStorage.setItem('zoni_user_gemini_key', trimmed);
      showToast('Key saved securely!');
    }
    setActiveStep(2);
  };

  const handleAlreadyAddedKey = () => {
    if (soundFxEnabled) playProceduralSfx('click');
    setActiveStep(2);
  };

  const handleSkipKey = () => {
    if (soundFxEnabled) playProceduralSfx('click');
    setActiveStep(2);
  };

  // --- Step 2 Handlers ---
  const handleRequestMic = async () => {
    if (soundFxEnabled) playProceduralSfx('click');
    const res = await requestMicrophoneAccess();
    const fresh = await checkAllPermissions();
    onUpdateReport(fresh);
    if (res.status === 'granted' && res.stream) {
      onMicInitialized?.(res.stream);
      showToast('Microphone allowed! Continue is now unlocked.');
    } else {
      showToast('Microphone access was denied. Please allow it to continue.');
    }
  };

  const handleRequestNotif = async () => {
    if (soundFxEnabled) playProceduralSfx('click');
    const res = await requestNotificationAccess();
    const fresh = await checkAllPermissions();
    onUpdateReport(fresh);
    if (res.status === 'granted') {
      onNotificationInitialized?.();
      showToast('Notifications allowed!');
    }
  };

  const handleRequestLocation = async () => {
    if (soundFxEnabled) playProceduralSfx('click');
    const res = await requestGeolocationAccess();
    const fresh = await checkAllPermissions();
    onUpdateReport(fresh);
    if (res.status === 'granted' && res.coords) {
      onLocationInitialized?.(res.coords);
      showToast('Location allowed!');
    }
  };

  const handleToggleExtraPerm = (key: string, name: string) => {
    if (soundFxEnabled) playProceduralSfx('click');
    const bridge = getNativeAndroidBridge();
    if (bridge?.requestRuntimePermission) {
      bridge.requestRuntimePermission(key);
      showToast(`Requested Android ${name} permission.`);
      return;
    }
    setExtraPermissions((prev) => {
      const nextVal = !prev[key];
      showToast(`${name} ${nextVal ? 'allowed' : 'disabled'}`);
      return { ...prev, [key]: nextVal };
    });
  };

  const handleAllowAllPermissions = async () => {
    if (soundFxEnabled) playProceduralSfx('boot');
    showToast('Authorizing all permissions for Zoni Ai...');

    const bridge = getNativeAndroidBridge();
    if (bridge?.requestRuntimePermission) {
      bridge.requestRuntimePermission('all');
    }

    // 1. Microphone
    const micRes = await requestMicrophoneAccess();
    if (micRes.status === 'granted' && micRes.stream) {
      onMicInitialized?.(micRes.stream);
    }

    // 2. Notifications
    await requestNotificationAccess();

    // 3. Geolocation
    const geoRes = await requestGeolocationAccess();
    if (geoRes.status === 'granted' && geoRes.coords) {
      onLocationInitialized?.(geoRes.coords);
    }

    // 4. Mark all mobile/hardware features as allowed (in web preview)
    if (!bridge?.requestRuntimePermission) {
      setExtraPermissions({
        camera: true,
        calls: true,
        contacts: true,
        sms: true,
        gallery: true,
        manageCalls: true,
        bluetooth: true,
      });
    }

    const fresh = await checkAllPermissions();
    onUpdateReport(fresh);
    showToast('All available permissions authorized!');
  };

  const isMicAllowed = report.microphone === 'granted';

  // --- Step 3 Handlers ---
  const handleToggleBattery = () => {
    if (soundFxEnabled) playProceduralSfx('click');
    const bridge = getNativeAndroidBridge();
    if (bridge?.openSystemSettings) {
      bridge.openSystemSettings('battery');
      showToast('Opening Android Battery Optimization settings for Zoni Ai.');
      return;
    }
    const nextVal = !batteryOptimisationOff;
    setBatteryOptimisationOff(nextVal);
    localStorage.setItem('zoni_battery_unconstrained', String(nextVal));
    if (nextVal) {
      showToast('Battery optimization disabled for Zoni Ai. Finish is now unlocked!');
    } else {
      showToast('Battery optimization re-enabled.');
    }
  };

  const handleToggleOverlay = () => {
    if (soundFxEnabled) playProceduralSfx('click');
    const bridge = getNativeAndroidBridge();
    if (bridge?.openSystemSettings) {
      bridge.openSystemSettings('overlay');
      showToast('Opening Display over other apps settings.');
      return;
    }
    const nextVal = !displayOverApps;
    setDisplayOverApps(nextVal);
    localStorage.setItem('zoni_display_over_apps', String(nextVal));
    showToast(`Display over other apps ${nextVal ? 'allowed' : 'disabled'}`);
  };

  const handleToggleNotifAccess = () => {
    if (soundFxEnabled) playProceduralSfx('click');
    const bridge = getNativeAndroidBridge();
    if (bridge?.openSystemSettings) {
      bridge.openSystemSettings('notifications');
      showToast('Opening Android Notification Listener settings.');
      return;
    }
    const nextVal = !notificationAccess;
    setNotificationAccess(nextVal);
    localStorage.setItem('zoni_notif_access_enabled', String(nextVal));
    showToast(`Notification access ${nextVal ? 'allowed' : 'disabled'}`);
  };

  const handleToggleAccessibility = () => {
    if (soundFxEnabled) playProceduralSfx('click');
    const bridge = getNativeAndroidBridge();
    if (bridge?.openSystemSettings) {
      bridge.openSystemSettings('accessibility');
      showToast('Opening Android Accessibility settings.');
      return;
    }
    const nextVal = !accessibilityService;
    setAccessibilityService(nextVal);
    localStorage.setItem('zoni_accessibility_service_enabled', String(nextVal));
    showToast(`Accessibility service ${nextVal ? 'allowed' : 'disabled'}`);
  };

  const handleToggleDefaultAssistant = () => {
    if (soundFxEnabled) playProceduralSfx('click');
    const bridge = getNativeAndroidBridge();
    if (bridge?.openSystemSettings) {
      bridge.openSystemSettings('default_assistant');
      showToast('Opening Android Default Digital Assistant settings.');
      return;
    }
    const nextVal = !defaultAssistant;
    setDefaultAssistant(nextVal);
    localStorage.setItem('zoni_default_assistant_enabled', String(nextVal));
    showToast(`Default assistant ${nextVal ? 'assigned to Zoni Ai' : 'disabled'}`);
  };

  const handleToggleScreenCapture = () => {
    if (soundFxEnabled) playProceduralSfx('click');
    const bridge = getNativeAndroidBridge();
    if (bridge?.requestScreenCaptureConsent && bridge?.stopScreenCapture) {
      if (screenCaptureEnabled) {
        bridge.stopScreenCapture();
        setScreenCaptureEnabled(false);
        showToast('Screen capture stopped.');
      } else {
        bridge.requestScreenCaptureConsent();
        showToast('Requesting transparent Android MediaProjection screen consent.');
      }
      return;
    }
    const nextVal = !screenCaptureEnabled;
    setScreenCaptureEnabled(nextVal);
    localStorage.setItem('zoni_screen_capture_enabled', String(nextVal));
    showToast(`Screen awareness consent ${nextVal ? 'ready (native APK MediaProjection)' : 'disabled'}`);
  };

  const handleFinish = () => {
    if (!batteryOptimisationOff) {
      if (soundFxEnabled) playProceduralSfx('alert');
      showToast('Battery - no optimisation is required before finishing. Tap the Battery row.');
      return;
    }
    if (soundFxEnabled) playProceduralSfx('love');
    localStorage.setItem('zoni_onboarding_completed', 'true');
    localStorage.setItem('zoni_perm_setup_seen', 'true');
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-md p-3 sm:p-5 overflow-y-auto">
      <div className="w-full max-w-2xl bg-slate-950 border-2 border-cyan-500/40 rounded-2xl shadow-[0_0_60px_rgba(6,182,212,0.3)] flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-200 my-auto text-cyan-50">
        {/* Header */}
        <div className="flex items-center justify-between p-4 sm:p-5 border-b border-cyan-500/20 bg-slate-900/80">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-cyan-950/80 border border-cyan-400/50 flex items-center justify-center text-cyan-400 shadow-[0_0_15px_rgba(6,182,212,0.4)]">
              <Zap className="w-5 h-5 text-cyan-300" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="font-sci-fi text-sm sm:text-base font-bold tracking-wider text-cyan-100 uppercase">
                  ZONI AI SETUP
                </h3>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-cyan-950 border border-cyan-400/40 text-cyan-300 font-bold">
                  STEP {activeStep} OF 3
                </span>
              </div>
              <p className="text-xs text-pink-300/80 font-hud tracking-wide mt-0.5">
                {activeStep === 1 && 'Add your Gemini key'}
                {activeStep === 2 && 'Let Zoni Ai use your phone'}
                {activeStep === 3 && 'Keep Zoni Ai alive in the background'}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close setup modal"
            className="p-1.5 rounded-lg border border-cyan-500/30 text-cyan-400 hover:bg-cyan-950/50 hover:text-cyan-200 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Step Indicator Tabs */}
        <div className="flex border-b border-cyan-500/20 bg-slate-900/40 px-4 pt-2 gap-2 text-xs font-hud tracking-wider overflow-x-auto">
          <button
            onClick={() => setActiveStep(1)}
            className={`pb-2.5 px-3 font-semibold border-b-2 transition-all flex items-center gap-1.5 shrink-0 ${
              activeStep === 1
                ? 'border-cyan-400 text-cyan-300'
                : 'border-transparent text-slate-400 hover:text-cyan-200'
            }`}
          >
            <Key className="w-3.5 h-3.5" />
            <span>1. GEMINI KEY</span>
          </button>
          <button
            onClick={() => setActiveStep(2)}
            className={`pb-2.5 px-3 font-semibold border-b-2 transition-all flex items-center gap-1.5 shrink-0 ${
              activeStep === 2
                ? 'border-pink-400 text-pink-300'
                : 'border-transparent text-slate-400 hover:text-pink-200'
            }`}
          >
            <Shield className="w-3.5 h-3.5" />
            <span>2. PHONE PERMISSIONS</span>
          </button>
          <button
            onClick={() => setActiveStep(3)}
            className={`pb-2.5 px-3 font-semibold border-b-2 transition-all flex items-center gap-1.5 shrink-0 ${
              activeStep === 3
                ? 'border-amber-400 text-amber-300'
                : 'border-transparent text-slate-400 hover:text-amber-200'
            }`}
          >
            <BatteryCharging className="w-3.5 h-3.5" />
            <span>3. KEEP ALIVE IN BACKGROUND</span>
          </button>
        </div>

        {/* Dynamic Toast Notice */}
        {toastMessage && (
          <div className="bg-emerald-950/80 border-b border-emerald-500/50 px-4 py-2 flex items-center gap-2 text-xs text-emerald-200 font-hud animate-in fade-in">
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
            <span>{toastMessage}</span>
          </div>
        )}

        {/* Modal Scrollable Content */}
        <div className="p-4 sm:p-6 space-y-4 max-h-[66vh] overflow-y-auto">
          {/* ======================================================== */}
          {/* STEP 1: Add your Gemini key */}
          {/* ======================================================== */}
          {activeStep === 1 && (
            <div className="space-y-4 animate-in fade-in duration-200">
              <div className="space-y-2">
                <h4 className="font-sci-fi text-lg sm:text-xl font-bold text-cyan-200 tracking-wide">
                  Add your Gemini key
                </h4>
                <p className="text-sm text-slate-300 leading-relaxed">
                  Zoni Ai&apos;s voice and brain run on Google&apos;s Gemini. Without a key she cannot hear you or answer. The key is free and takes about a minute.
                </p>
              </div>

              {/* Step-by-step instructions box */}
              <div className="p-4 rounded-xl bg-slate-900/60 border border-cyan-500/25 space-y-2.5">
                <div className="flex items-start gap-2.5 text-xs text-slate-300 leading-relaxed">
                  <span className="w-5 h-5 rounded-full bg-cyan-950 border border-cyan-400 text-cyan-300 font-mono text-[11px] font-bold flex items-center justify-center shrink-0">
                    1
                  </span>
                  <span>
                    Tap <strong className="text-cyan-300">&quot;Get a free key&quot;</strong> below. Google AI Studio opens.
                  </span>
                </div>
                <div className="flex items-start gap-2.5 text-xs text-slate-300 leading-relaxed">
                  <span className="w-5 h-5 rounded-full bg-cyan-950 border border-cyan-400 text-cyan-300 font-mono text-[11px] font-bold flex items-center justify-center shrink-0">
                    2
                  </span>
                  <span>
                    Sign in with your Google account.
                  </span>
                </div>
                <div className="flex items-start gap-2.5 text-xs text-slate-300 leading-relaxed">
                  <span className="w-5 h-5 rounded-full bg-cyan-950 border border-cyan-400 text-cyan-300 font-mono text-[11px] font-bold flex items-center justify-center shrink-0">
                    3
                  </span>
                  <span>
                    Tap <strong className="text-cyan-300">&quot;Create API key&quot;</strong>. Pick any project. Then tap <strong className="text-pink-300">copy</strong>.
                  </span>
                </div>
                <div className="flex items-start gap-2.5 text-xs text-slate-300 leading-relaxed">
                  <span className="w-5 h-5 rounded-full bg-cyan-950 border border-cyan-400 text-cyan-300 font-mono text-[11px] font-bold flex items-center justify-center shrink-0">
                    4
                  </span>
                  <span>
                    Come back to Zoni Ai and tap <strong className="text-pink-300">&quot;Paste&quot;</strong>.
                  </span>
                </div>
              </div>

              {/* Get a Free Key Button */}
              <div>
                <button
                  onClick={handleGetFreeKey}
                  className="w-full sm:w-auto px-5 py-2.5 rounded-xl bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white font-hud text-xs font-bold tracking-wider uppercase flex items-center justify-center gap-2 shadow-[0_0_15px_rgba(6,182,212,0.35)] transition-all"
                >
                  <ExternalLink className="w-4 h-4" />
                  <span>Get a free key</span>
                </button>
              </div>

              {/* Key Input Field with Paste & Visibility Toggle */}
              <div className="space-y-2 pt-1">
                <div className="relative">
                  <input
                    type={isKeyVisible ? 'text' : 'password'}
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder="Your key goes here"
                    className="w-full py-3 pl-3.5 pr-24 rounded-xl bg-slate-900 border border-cyan-500/40 text-sm text-cyan-100 font-mono placeholder:text-slate-500 focus:outline-none focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400/50"
                  />
                  <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => setIsKeyVisible(!isKeyVisible)}
                      className="p-1.5 text-slate-400 hover:text-cyan-300 rounded"
                      title={isKeyVisible ? 'Hide Key' : 'Show Key'}
                    >
                      {isKeyVisible ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                    <button
                      type="button"
                      onClick={handlePasteKey}
                      className="px-2.5 py-1 rounded-lg bg-pink-950/80 border border-pink-500/50 hover:bg-pink-900/60 text-pink-300 text-xs font-hud font-bold flex items-center gap-1 transition-all"
                      title="Paste from clipboard"
                    >
                      <Clipboard className="w-3.5 h-3.5" />
                      <span>Paste</span>
                    </button>
                  </div>
                </div>

                {keyNotice && (
                  <p className="text-xs text-pink-400 font-hud">{keyNotice}</p>
                )}

                <p className="text-xs text-slate-400 font-hud leading-relaxed">
                  The key is free. It is stored encrypted and used only to run Zoni Ai for you.
                </p>
              </div>

              {/* Action Buttons */}
              <div className="pt-3 space-y-2.5">
                <button
                  onClick={handleSaveAndContinueKey}
                  className="w-full py-3 rounded-xl bg-gradient-to-r from-cyan-600 via-pink-600 to-cyan-500 hover:from-cyan-500 hover:via-pink-500 hover:to-cyan-400 text-white font-hud text-sm font-bold tracking-wider uppercase flex items-center justify-center gap-2 shadow-[0_0_20px_rgba(6,182,212,0.4)] transition-all"
                >
                  <span>Save & continue</span>
                  <ArrowRight className="w-4 h-4" />
                </button>

                <div className="flex flex-col sm:flex-row gap-2">
                  <button
                    onClick={handleAlreadyAddedKey}
                    className="flex-1 py-2 px-3 rounded-lg border border-slate-700 bg-slate-900/60 text-slate-300 hover:bg-slate-800 text-xs font-hud tracking-wider transition-all"
                  >
                    I already added a key
                  </button>
                  <button
                    onClick={handleSkipKey}
                    className="flex-1 py-2 px-3 rounded-lg border border-slate-700 bg-slate-900/60 text-slate-400 hover:text-slate-200 hover:bg-slate-800 text-xs font-hud tracking-wider transition-all"
                  >
                    Skip for now
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ======================================================== */}
          {/* STEP 2: Let Zoni Ai use your phone */}
          {/* ======================================================== */}
          {activeStep === 2 && (
            <div className="space-y-4 animate-in fade-in duration-200">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div className="space-y-1">
                  <h4 className="font-sci-fi text-lg sm:text-xl font-bold text-pink-200 tracking-wide">
                    Let Zoni Ai use your phone
                  </h4>
                  <p className="text-xs sm:text-sm text-slate-300 leading-relaxed">
                    One tap - Android asks for each in turn. Only the microphone is required; the rest make her useful.
                  </p>
                </div>

                <button
                  onClick={handleAllowAllPermissions}
                  className="shrink-0 px-4 py-2 rounded-xl bg-gradient-to-r from-pink-600 to-cyan-600 hover:from-pink-500 hover:to-cyan-500 text-white font-hud text-xs font-bold tracking-wider uppercase flex items-center gap-1.5 shadow-[0_0_15px_rgba(236,72,153,0.4)] transition-all"
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  <span>Allow all</span>
                </button>
              </div>

              {/* 10 Permissions List */}
              <div className="space-y-2">
                {/* 1. Microphone */}
                <div className="p-3 rounded-xl bg-slate-900/60 border border-cyan-500/25 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div className="p-2.5 rounded-lg bg-cyan-950/80 border border-cyan-400/50 text-cyan-300 shrink-0">
                      <Mic className="w-4 h-4" />
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-hud font-bold text-sm text-cyan-100">Microphone</span>
                        <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-pink-950 border border-pink-400 text-pink-300 font-bold">
                          REQUIRED
                        </span>
                      </div>
                      <p className="text-xs text-slate-400 mt-0.5">So you can talk to Zoni Ai. Required.</p>
                    </div>
                  </div>
                  {isMicAllowed ? (
                    <span className="inline-flex items-center gap-1 px-3 py-1 rounded-lg text-xs font-hud font-bold bg-emerald-950/80 border border-emerald-500/50 text-emerald-300">
                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                      ALLOWED
                    </span>
                  ) : (
                    <button
                      onClick={handleRequestMic}
                      className="px-3.5 py-1 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white font-hud text-xs font-bold transition-all shadow-[0_0_10px_rgba(6,182,212,0.3)]"
                    >
                      ALLOW
                    </button>
                  )}
                </div>

                {/* 2. Notifications */}
                <div className="p-3 rounded-xl bg-slate-900/50 border border-cyan-500/20 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div className="p-2.5 rounded-lg bg-cyan-950/60 border border-cyan-400/40 text-cyan-300 shrink-0">
                      <Bell className="w-4 h-4" />
                    </div>
                    <div>
                      <span className="font-hud font-bold text-sm text-cyan-100 block">Notifications</span>
                      <p className="text-xs text-slate-400 mt-0.5">Zoni Ai own notification, which keeps her running in the background.</p>
                    </div>
                  </div>
                  {report.notifications === 'granted' ? (
                    <span className="inline-flex items-center gap-1 px-3 py-1 rounded-lg text-xs font-hud font-bold bg-emerald-950/80 border border-emerald-500/50 text-emerald-300">
                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                      ALLOWED
                    </span>
                  ) : (
                    <button
                      onClick={handleRequestNotif}
                      className="px-3.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-cyan-300 border border-cyan-500/40 font-hud text-xs font-bold transition-all"
                    >
                      ALLOW
                    </button>
                  )}
                </div>

                {/* 3. Camera */}
                <div className="p-3 rounded-xl bg-slate-900/50 border border-cyan-500/20 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div className="p-2.5 rounded-lg bg-cyan-950/60 border border-cyan-400/40 text-cyan-300 shrink-0">
                      <Camera className="w-4 h-4" />
                    </div>
                    <div>
                      <span className="font-hud font-bold text-sm text-cyan-100 block">Camera</span>
                      <p className="text-xs text-slate-400 mt-0.5">So she can take a photo or look at what you point the phone at.</p>
                    </div>
                  </div>
                  {extraPermissions.camera ? (
                    <span className="inline-flex items-center gap-1 px-3 py-1 rounded-lg text-xs font-hud font-bold bg-emerald-950/80 border border-emerald-500/50 text-emerald-300">
                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                      ALLOWED
                    </span>
                  ) : (
                    <button
                      onClick={() => handleToggleExtraPerm('camera', 'Camera')}
                      className="px-3.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-cyan-300 border border-cyan-500/40 font-hud text-xs font-bold transition-all"
                    >
                      ALLOW
                    </button>
                  )}
                </div>

                {/* 4. Phone calls */}
                <div className="p-3 rounded-xl bg-slate-900/50 border border-cyan-500/20 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div className="p-2.5 rounded-lg bg-cyan-950/60 border border-cyan-400/40 text-cyan-300 shrink-0">
                      <PhoneCall className="w-4 h-4" />
                    </div>
                    <div>
                      <span className="font-hud font-bold text-sm text-cyan-100 block">Phone calls</span>
                      <p className="text-xs text-slate-400 mt-0.5">So she can place a call for you.</p>
                    </div>
                  </div>
                  {extraPermissions.calls ? (
                    <span className="inline-flex items-center gap-1 px-3 py-1 rounded-lg text-xs font-hud font-bold bg-emerald-950/80 border border-emerald-500/50 text-emerald-300">
                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                      ALLOWED
                    </span>
                  ) : (
                    <button
                      onClick={() => handleToggleExtraPerm('calls', 'Phone calls')}
                      className="px-3.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-cyan-300 border border-cyan-500/40 font-hud text-xs font-bold transition-all"
                    >
                      ALLOW
                    </button>
                  )}
                </div>

                {/* 5. Contacts */}
                <div className="p-3 rounded-xl bg-slate-900/50 border border-cyan-500/20 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div className="p-2.5 rounded-lg bg-cyan-950/60 border border-cyan-400/40 text-cyan-300 shrink-0">
                      <Users className="w-4 h-4" />
                    </div>
                    <div>
                      <span className="font-hud font-bold text-sm text-cyan-100 block">Contacts</span>
                      <p className="text-xs text-slate-400 mt-0.5">So a name is enough she looks up the number.</p>
                    </div>
                  </div>
                  {extraPermissions.contacts ? (
                    <span className="inline-flex items-center gap-1 px-3 py-1 rounded-lg text-xs font-hud font-bold bg-emerald-950/80 border border-emerald-500/50 text-emerald-300">
                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                      ALLOWED
                    </span>
                  ) : (
                    <button
                      onClick={() => handleToggleExtraPerm('contacts', 'Contacts')}
                      className="px-3.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-cyan-300 border border-cyan-500/40 font-hud text-xs font-bold transition-all"
                    >
                      ALLOW
                    </button>
                  )}
                </div>

                {/* 6. SMS */}
                <div className="p-3 rounded-xl bg-slate-900/50 border border-cyan-500/20 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div className="p-2.5 rounded-lg bg-cyan-950/60 border border-cyan-400/40 text-cyan-300 shrink-0">
                      <MessageSquare className="w-4 h-4" />
                    </div>
                    <div>
                      <span className="font-hud font-bold text-sm text-cyan-100 block">SMS</span>
                      <p className="text-xs text-slate-400 mt-0.5">So she can send a text message.</p>
                    </div>
                  </div>
                  {extraPermissions.sms ? (
                    <span className="inline-flex items-center gap-1 px-3 py-1 rounded-lg text-xs font-hud font-bold bg-emerald-950/80 border border-emerald-500/50 text-emerald-300">
                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                      ALLOWED
                    </span>
                  ) : (
                    <button
                      onClick={() => handleToggleExtraPerm('sms', 'SMS')}
                      className="px-3.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-cyan-300 border border-cyan-500/40 font-hud text-xs font-bold transition-all"
                    >
                      ALLOW
                    </button>
                  )}
                </div>

                {/* 7. Location */}
                <div className="p-3 rounded-xl bg-slate-900/50 border border-cyan-500/20 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div className="p-2.5 rounded-lg bg-cyan-950/60 border border-cyan-400/40 text-cyan-300 shrink-0">
                      <MapPin className="w-4 h-4" />
                    </div>
                    <div>
                      <span className="font-hud font-bold text-sm text-cyan-100 block">Location</span>
                      <p className="text-xs text-slate-400 mt-0.5">Weather, navigation, and where you are.</p>
                    </div>
                  </div>
                  {report.geolocation === 'granted' ? (
                    <span className="inline-flex items-center gap-1 px-3 py-1 rounded-lg text-xs font-hud font-bold bg-emerald-950/80 border border-emerald-500/50 text-emerald-300">
                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                      ALLOWED
                    </span>
                  ) : (
                    <button
                      onClick={handleRequestLocation}
                      className="px-3.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-cyan-300 border border-cyan-500/40 font-hud text-xs font-bold transition-all"
                    >
                      ALLOW
                    </button>
                  )}
                </div>

                {/* 8. Gallery & files */}
                <div className="p-3 rounded-xl bg-slate-900/50 border border-cyan-500/20 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div className="p-2.5 rounded-lg bg-cyan-950/60 border border-cyan-400/40 text-cyan-300 shrink-0">
                      <Image className="w-4 h-4" />
                    </div>
                    <div>
                      <span className="font-hud font-bold text-sm text-cyan-100 block">Gallery &amp; files</span>
                      <p className="text-xs text-slate-400 mt-0.5">So she can find a photo or file and send it.</p>
                    </div>
                  </div>
                  {extraPermissions.gallery ? (
                    <span className="inline-flex items-center gap-1 px-3 py-1 rounded-lg text-xs font-hud font-bold bg-emerald-950/80 border border-emerald-500/50 text-emerald-300">
                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                      ALLOWED
                    </span>
                  ) : (
                    <button
                      onClick={() => handleToggleExtraPerm('gallery', 'Gallery & files')}
                      className="px-3.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-cyan-300 border border-cyan-500/40 font-hud text-xs font-bold transition-all"
                    >
                      ALLOW
                    </button>
                  )}
                </div>

                {/* 9. Answer & manage calls */}
                <div className="p-3 rounded-xl bg-slate-900/50 border border-cyan-500/20 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div className="p-2.5 rounded-lg bg-cyan-950/60 border border-cyan-400/40 text-cyan-300 shrink-0">
                      <PhoneIncoming className="w-4 h-4" />
                    </div>
                    <div>
                      <span className="font-hud font-bold text-sm text-cyan-100 block">Answer &amp; manage calls</span>
                      <p className="text-xs text-slate-400 mt-0.5">So she can announce who is calling and answer or reject it.</p>
                    </div>
                  </div>
                  {extraPermissions.manageCalls ? (
                    <span className="inline-flex items-center gap-1 px-3 py-1 rounded-lg text-xs font-hud font-bold bg-emerald-950/80 border border-emerald-500/50 text-emerald-300">
                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                      ALLOWED
                    </span>
                  ) : (
                    <button
                      onClick={() => handleToggleExtraPerm('manageCalls', 'Answer & manage calls')}
                      className="px-3.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-cyan-300 border border-cyan-500/40 font-hud text-xs font-bold transition-all"
                    >
                      ALLOW
                    </button>
                  )}
                </div>

                {/* 10. Bluetooth */}
                <div className="p-3 rounded-xl bg-slate-900/50 border border-cyan-500/20 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div className="p-2.5 rounded-lg bg-cyan-950/60 border border-cyan-400/40 text-cyan-300 shrink-0">
                      <Bluetooth className="w-4 h-4" />
                    </div>
                    <div>
                      <span className="font-hud font-bold text-sm text-cyan-100 block">Bluetooth</span>
                      <p className="text-xs text-slate-400 mt-0.5">So her voice plays on your earbuds or speaker.</p>
                    </div>
                  </div>
                  {extraPermissions.bluetooth ? (
                    <span className="inline-flex items-center gap-1 px-3 py-1 rounded-lg text-xs font-hud font-bold bg-emerald-950/80 border border-emerald-500/50 text-emerald-300">
                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                      ALLOWED
                    </span>
                  ) : (
                    <button
                      onClick={() => handleToggleExtraPerm('bluetooth', 'Bluetooth')}
                      className="px-3.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-cyan-300 border border-cyan-500/40 font-hud text-xs font-bold transition-all"
                    >
                      ALLOW
                    </button>
                  )}
                </div>
              </div>

              {/* Step 2 Bottom Navigation */}
              <div className="pt-2 space-y-2">
                {!isMicAllowed && (
                  <p className="text-xs text-amber-300 font-hud flex items-center gap-1.5">
                    <AlertCircle className="w-4 h-4 shrink-0 text-amber-400" />
                    <span>Continue unlocks once the microphone is allowed.</span>
                  </p>
                )}

                <div className="flex items-center justify-between gap-3">
                  <button
                    onClick={() => setActiveStep(1)}
                    className="py-2.5 px-4 rounded-xl border border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800 text-xs font-hud flex items-center gap-1.5"
                  >
                    <ArrowLeft className="w-3.5 h-3.5" />
                    <span>Back</span>
                  </button>

                  <button
                    onClick={() => {
                      if (isMicAllowed) {
                        if (soundFxEnabled) playProceduralSfx('click');
                        setActiveStep(3);
                      }
                    }}
                    disabled={!isMicAllowed}
                    className={`py-2.5 px-6 rounded-xl font-hud text-xs font-bold tracking-wider uppercase flex items-center gap-2 transition-all ${
                      isMicAllowed
                        ? 'bg-gradient-to-r from-cyan-600 to-pink-600 hover:from-cyan-500 hover:to-pink-500 text-white shadow-[0_0_15px_rgba(6,182,212,0.4)] cursor-pointer'
                        : 'bg-slate-800 text-slate-500 border border-slate-700 cursor-not-allowed opacity-60'
                    }`}
                  >
                    <span>→ Continue</span>
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ======================================================== */}
          {/* STEP 3: Keep Zoni Ai alive in the background */}
          {/* ======================================================== */}
          {activeStep === 3 && (
            <div className="space-y-4 animate-in fade-in duration-200">
              <div className="space-y-1">
                <h4 className="font-sci-fi text-lg sm:text-xl font-bold text-amber-200 tracking-wide">
                  Keep Zoni Ai alive in the background
                </h4>
                <p className="text-xs sm:text-sm text-slate-300 leading-relaxed">
                  Battery is required it is what stops her going quiet when the screen is off. The rest are optional but make her far more useful.
                </p>
              </div>

              {/* 5 Background Availability Rows */}
              <div className="space-y-2.5">
                {/* 1. Battery - no optimisation (Required) */}
                <div
                  onClick={handleToggleBattery}
                  role="button"
                  tabIndex={0}
                  className={`p-3.5 rounded-xl border transition-all cursor-pointer flex items-center justify-between gap-3 ${
                    batteryOptimisationOff
                      ? 'bg-emerald-950/40 border-emerald-500/50 shadow-[0_0_15px_rgba(16,185,129,0.15)]'
                      : 'bg-slate-900/60 border-amber-500/40 hover:border-amber-400'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <div className="p-2.5 rounded-lg bg-cyan-950/80 border border-cyan-400/50 text-cyan-300 shrink-0">
                      <BatteryCharging className="w-4 h-4" />
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-hud font-bold text-sm text-cyan-100">Battery - no optimisation</span>
                        <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-amber-950 border border-amber-400 text-amber-300 font-bold">
                          REQUIRED
                        </span>
                      </div>
                      <p className="text-xs text-slate-300 mt-0.5">
                        Required. Without it the phone kills Zoni Ai in the background and she goes quiet. Tap, then choose Allow.
                      </p>
                    </div>
                  </div>
                  <div>
                    {batteryOptimisationOff ? (
                      <span className="inline-flex items-center gap-1 px-3 py-1 rounded-lg text-xs font-hud font-bold bg-emerald-950/80 border border-emerald-500/50 text-emerald-300">
                        <Check className="w-3.5 h-3.5 text-emerald-400" />
                        ALLOWED
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 px-3 py-1 rounded-lg text-xs font-hud font-bold bg-amber-950/80 border border-amber-500/50 text-amber-300 animate-pulse">
                        PENDING
                      </span>
                    )}
                  </div>
                </div>

                {/* 2. Display over other apps */}
                <div
                  onClick={handleToggleOverlay}
                  role="button"
                  tabIndex={0}
                  className={`p-3.5 rounded-xl border transition-all cursor-pointer flex items-center justify-between gap-3 ${
                    displayOverApps
                      ? 'bg-slate-900/60 border-cyan-500/40'
                      : 'bg-slate-900/40 border-slate-700'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <div className="p-2.5 rounded-lg bg-cyan-950/60 border border-cyan-400/40 text-cyan-300 shrink-0">
                      <Layers className="w-4 h-4" />
                    </div>
                    <div>
                      <span className="font-hud font-bold text-sm text-cyan-100 block">Display over other apps</span>
                      <p className="text-xs text-slate-400 mt-0.5">So her orb can float on top of whatever you are doing.</p>
                    </div>
                  </div>
                  <div>
                    {displayOverApps ? (
                      <span className="inline-flex items-center gap-1 px-3 py-1 rounded-lg text-xs font-hud font-bold bg-emerald-950/80 border border-emerald-500/50 text-emerald-300">
                        <Check className="w-3.5 h-3.5 text-emerald-400" />
                        ALLOWED
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 px-3 py-1 rounded-lg text-xs font-hud font-bold bg-slate-800 border border-slate-700 text-slate-400">
                        PENDING
                      </span>
                    )}
                  </div>
                </div>

                {/* 3. Notification access */}
                <div
                  onClick={handleToggleNotifAccess}
                  role="button"
                  tabIndex={0}
                  className={`p-3.5 rounded-xl border transition-all cursor-pointer flex items-center justify-between gap-3 ${
                    notificationAccess
                      ? 'bg-slate-900/60 border-cyan-500/40'
                      : 'bg-slate-900/40 border-slate-700'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <div className="p-2.5 rounded-lg bg-cyan-950/60 border border-cyan-400/40 text-cyan-300 shrink-0">
                      <MessageCircle className="w-4 h-4" />
                    </div>
                    <div>
                      <span className="font-hud font-bold text-sm text-cyan-100 block">Notification access</span>
                      <p className="text-xs text-slate-400 mt-0.5">To read WhatsApp messages and know who is calling. Turn on &quot;Zoni Ai&quot; in the list.</p>
                    </div>
                  </div>
                  <div>
                    {notificationAccess ? (
                      <span className="inline-flex items-center gap-1 px-3 py-1 rounded-lg text-xs font-hud font-bold bg-emerald-950/80 border border-emerald-500/50 text-emerald-300">
                        <Check className="w-3.5 h-3.5 text-emerald-400" />
                        ALLOWED
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 px-3 py-1 rounded-lg text-xs font-hud font-bold bg-slate-800 border border-slate-700 text-slate-400">
                        PENDING
                      </span>
                    )}
                  </div>
                </div>

                {/* 4. Accessibility service */}
                <div
                  onClick={handleToggleAccessibility}
                  role="button"
                  tabIndex={0}
                  className={`p-3.5 rounded-xl border transition-all cursor-pointer flex items-center justify-between gap-3 ${
                    accessibilityService
                      ? 'bg-slate-900/60 border-cyan-500/40'
                      : 'bg-slate-900/40 border-slate-700'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <div className="p-2.5 rounded-lg bg-cyan-950/60 border border-cyan-400/40 text-cyan-300 shrink-0">
                      <Sparkles className="w-4 h-4" />
                    </div>
                    <div>
                      <span className="font-hud font-bold text-sm text-cyan-100 block">Accessibility service</span>
                      <p className="text-xs text-slate-400 mt-0.5">So she can open apps, tap, and read the screen for you. Turn on &quot;Zoni Ai&quot; in the list.</p>
                    </div>
                  </div>
                  <div>
                    {accessibilityService ? (
                      <span className="inline-flex items-center gap-1 px-3 py-1 rounded-lg text-xs font-hud font-bold bg-emerald-950/80 border border-emerald-500/50 text-emerald-300">
                        <Check className="w-3.5 h-3.5 text-emerald-400" />
                        ALLOWED
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 px-3 py-1 rounded-lg text-xs font-hud font-bold bg-slate-800 border border-slate-700 text-slate-400">
                        PENDING
                      </span>
                    )}
                  </div>
                </div>

                {/* 5. Default assistant */}
                <div
                  onClick={handleToggleDefaultAssistant}
                  role="button"
                  tabIndex={0}
                  className={`p-3.5 rounded-xl border transition-all cursor-pointer flex items-center justify-between gap-3 ${
                    defaultAssistant
                      ? 'bg-slate-900/60 border-cyan-500/40'
                      : 'bg-slate-900/40 border-slate-700'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <div className="p-2.5 rounded-lg bg-cyan-950/60 border border-cyan-400/40 text-cyan-300 shrink-0">
                      <Zap className="w-4 h-4" />
                    </div>
                    <div>
                      <span className="font-hud font-bold text-sm text-cyan-100 block">Default assistant</span>
                      <p className="text-xs text-slate-400 mt-0.5">Long-press the power button or swipe from a corner to call her, even on the lock screen. Pick &quot;Zoni Ai&quot;.</p>
                    </div>
                  </div>
                  <div>
                    {defaultAssistant ? (
                      <span className="inline-flex items-center gap-1 px-3 py-1 rounded-lg text-xs font-hud font-bold bg-emerald-950/80 border border-emerald-500/50 text-emerald-300">
                        <Check className="w-3.5 h-3.5 text-emerald-400" />
                        ALLOWED
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 px-3 py-1 rounded-lg text-xs font-hud font-bold bg-slate-800 border border-slate-700 text-slate-400">
                        PENDING
                      </span>
                    )}
                  </div>
                </div>

                {/* 6. Screen Awareness (Optional MediaProjection) */}
                <div
                  onClick={handleToggleScreenCapture}
                  role="button"
                  tabIndex={0}
                  className={`p-3.5 rounded-xl border transition-all cursor-pointer flex items-center justify-between gap-3 ${
                    screenCaptureEnabled
                      ? 'bg-slate-900/60 border-cyan-500/40'
                      : 'bg-slate-900/40 border-slate-700'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <div className="p-2.5 rounded-lg bg-cyan-950/60 border border-cyan-400/40 text-cyan-300 shrink-0">
                      <Monitor className="w-4 h-4" />
                    </div>
                    <div>
                      <span className="font-hud font-bold text-sm text-cyan-100 block">
                        Screen awareness (MediaProjection)
                      </span>
                      <p className="text-xs text-slate-400 mt-0.5">
                        Optional. Transparently lets Zoni read or explain your current screen only when you ask.
                      </p>
                    </div>
                  </div>
                  <div>
                    {screenCaptureEnabled ? (
                      <span className="inline-flex items-center gap-1 px-3 py-1 rounded-lg text-xs font-hud font-bold bg-emerald-950/80 border border-emerald-500/50 text-emerald-300">
                        <Check className="w-3.5 h-3.5 text-emerald-400" />
                        ACTIVE
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 px-3 py-1 rounded-lg text-xs font-hud font-bold bg-slate-800 border border-slate-700 text-slate-400">
                        OPTIONAL
                      </span>
                    )}
                  </div>
                </div>
              </div>

              {/* Footer instruction note */}
              <div className="p-3 rounded-lg bg-slate-900/80 border border-cyan-500/20 text-xs text-slate-400 font-hud leading-relaxed">
                Tap a Pending row to open its system screen - come back here when you are done. You can change any of them later in Settings → Advanced → Permissions.
              </div>

              {/* Finish Button Area */}
              <div className="pt-2 space-y-2">
                {!batteryOptimisationOff && (
                  <p className="text-xs text-amber-300 font-hud flex items-center gap-1.5">
                    <AlertCircle className="w-4 h-4 shrink-0 text-amber-400" />
                    <span>Finish unlocks once battery optimisation is off for Zoni Ai — tap the Battery row.</span>
                  </p>
                )}

                <div className="flex items-center justify-between gap-3">
                  <button
                    onClick={() => setActiveStep(2)}
                    className="py-2.5 px-4 rounded-xl border border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800 text-xs font-hud flex items-center gap-1.5"
                  >
                    <ArrowLeft className="w-3.5 h-3.5" />
                    <span>Back</span>
                  </button>

                  <button
                    onClick={handleFinish}
                    disabled={!batteryOptimisationOff}
                    className={`py-3 px-8 rounded-xl font-hud text-xs font-bold tracking-wider uppercase flex items-center gap-2 transition-all ${
                      batteryOptimisationOff
                        ? 'bg-gradient-to-r from-cyan-600 via-pink-600 to-cyan-500 hover:from-cyan-500 hover:via-pink-500 hover:to-cyan-400 text-white shadow-[0_0_20px_rgba(6,182,212,0.4)] cursor-pointer'
                        : 'bg-slate-800 text-slate-500 border border-slate-700 cursor-not-allowed opacity-60'
                    }`}
                  >
                    <CheckCircle2 className="w-4 h-4" />
                    <span>Finish</span>
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
