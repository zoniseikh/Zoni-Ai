# Zoni AI — Jarvis MK-IX (Original Dashboard + Complete Native Android App)

Zoni AI is a full-stack Bengali / Hindi / English AI companion & voice assistant created by **Zoni Seikh**, combining the **preserved original Sci-Fi / JARVIS React Dashboard** (Neon Cyan & Pink HUD, Arc Reactor, Gemini Live bidirectional voice, custom affection names, personality modes) with a **complete native Android application (`com.zoni.jarvis.assistant`)**, **Hybrid SIM + AI VoIP Calling**, **Room local database**, and an automated **GitHub Actions APK/AAB build pipeline**.

---

## Architecture Overview

1. **Preserved Original React Dashboard (`src/`)**
   - React 19 + TypeScript + Vite + Tailwind CSS + Motion + Lucide icons.
   - All original components preserved intact: `ArcReactor`, `HudHeader`, `ControlDock`, `GfStatusPanel`, `VoiceTelemetryPanel`, `ChatTranscriptDrawer`, `ActionPromptCard`, `PermissionsSetupModal`, `ZoniSettingsModal`, `ApkExportModal`.
   - Extended seamlessly with `HybridCallingModal` (`CALL HUB`) and allowlisted `TaskExecutionEngine`.

2. **Native Android Application Shell (`android/`)**
   - Package ID: `com.zoni.jarvis.assistant` (`minSdk 26`, `targetSdk 34`, Kotlin 2.0, Jetpack Compose, Material 3).
   - **Original Dashboard Hosting**: `MainActivity.kt` loads the compiled React dashboard from `android/app/src/main/assets/public/` via `androidx.webkit.WebViewAssetLoader` (`https://appassets.androidplatform.net/assets/public/index.html`) and bridges native Android APIs through `window.ZoniAndroidBridge` (`ZoniWebAppInterface.kt`), with a synchronized Jetpack Compose HUD fallback.
   - **Native Hardware & Services**: `FlashlightController` (Camera2), `AppLauncher` (PackageManager), `ContactCallManager` (ContactsContract + Telecom), `DeviceActionExecutor`, `FloatingOrbService`, `ZoniForegroundService`, `ZoniAccessibilityService`, `ZoniNotificationListenerService`, `OnboardingActivity`.
   - **Hybrid Calling System**:
     - **SIM Calling**: `ContactCallManager`, `ZoniCallScreeningService` (`CallScreeningService`), `ZoniInCallService` (optional Default Dialer `InCallService`), plus lawful GSM carrier conditional forwarding helper (`*61*`, `*62*`, `*67*`, `##002#`).
     - **AI VoIP Calling**: `ZoniVoipTelecomManager` (`androidx.core:core-telecom` `CallsManager`) + `HybridCallOrchestrator` with mandatory user authorization & transparent AI identity disclosure.
   - **Local Database & Privacy**: Room (`ZoniDatabase`) storing `CallSessionEntity`, `CallSummaryEntity`, `ConversationEntity`, `TaskExecutionEntity`, `ConsentRecordEntity`, and `UserPreferencesEntity` with non-destructive migrations and **call recording OFF by default**.

3. **Express + WebSocket Backend (`server.ts`, `src/server/`)**
   - Real-time `/live` WebSocket bridge to **Gemini 3.8 Live (`gemini-3.8-live`)** (16kHz PCM in / 24kHz PCM out).
   - Conversational `/api/chat` (`gemini-3.1-flash-lite` / `gemini-4-hydrogen`), `/api/tts` (`gemini-3.8-flash-lite-tts`), `/api/time` (Asia/Kolkata deterministic Bengali time/date/weekday).
   - Hybrid calling & task endpoints: `POST /api/calls/prepare`, `POST /api/calls/authorize`, `POST /api/calls/start`, `POST /api/calls/transfer`, `POST /api/calls/end`, `GET /api/calls/history`, `DELETE /api/calls/history`, `GET /api/calls/:id/summary`, `POST /api/tasks/plan`, `GET /api/status`.
   - VoIP provider abstraction (`TwilioVoipProvider`, `SipWebhookVoipProvider`, and honest `UnconfiguredVoipProvider` that never fabricates external calls).

---

## Local Development

```bash
# 1. Install dependencies
npm install

# 2. Configure .env (copy from .env.example and set GEMINI_API_KEY)
cp .env.example .env

# 3. Run unit tests (frontend, Bengali normalizer, task engine, backend call orchestrator)
npm test

# 4. Start full-stack dev server on http://localhost:3000
npm run dev
```

---

## Building the Real Android APK & AAB

### Option 1: GitHub Actions (Recommended — Automated)
Push to `main` (or trigger **Actions > Build Zoni AI Android APK & AAB > Run workflow**):
- Automatically runs `npm test`, `npm run lint`, `npm run android:sync`, Gradle `testDebugUnitTest`, `lintDebug`, and `assembleDebug`.
- Uploads installable Debug APK artifact: `android/app/build/outputs/apk/debug/app-debug.apk` (no signing secrets needed).
- When these GitHub Repository Secrets are configured, it also builds and uploads the signed Release APK (`app-release.apk`) and Play Store AAB (`app-release.aab`):
  - `ANDROID_KEYSTORE_BASE64`
  - `ANDROID_KEYSTORE_PASSWORD`
  - `ANDROID_KEY_ALIAS`
  - `ANDROID_KEY_PASSWORD`

### Option 2: Local Android Studio / Gradle CLI (Requires JDK 17 + Android SDK 34)
```bash
# 1. Build original React dashboard & copy into android/app/src/main/assets/public/
npm run android:sync

# 2. Build Debug APK
cd android
gradle assembleDebug

# 3. Install onto connected Android phone
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

---

## External VoIP Provider Setup & Legal/Platform Notes

- **SIM Call Audio Restriction**: Standard Android applications cannot access or inject carrier SIM voice audio (`VOICE_CALL` audio is isolated by Android OS). Use **AI VoIP Calling** (Twilio / SIP) for AI voice conversations, or configure carrier conditional call forwarding (`*61*<VOIP_DID>#`) so unanswered SIM calls route to your VoIP/SIP number.
- **Twilio / SIP Setup**: Set `VOIP_PROVIDER=twilio` plus `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_PHONE_NUMBER` (or `VOIP_PROVIDER=sip_webhook` + `SIP_TRUNK_URI` + `SIP_GATEWAY_WEBHOOK_URL`) in the backend `.env`.
- **Transparent AI Identity & Consent**: External AI calls require explicit user authorization before dialing and play a mandatory AI identity disclosure. Call recording is disabled by default.
