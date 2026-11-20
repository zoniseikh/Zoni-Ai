# Zoni AI — Jarvis MK-IX (Original Dashboard + Complete Native Android App)

Zoni AI is a full-stack Bengali / Hindi / English AI companion & voice assistant created by **Zoni Seikh**, combining the **preserved original Sci-Fi / JARVIS React Dashboard** (Neon Cyan & Pink HUD, Arc Reactor, Gemini Live bidirectional voice, custom affection names, personality modes) with a **complete native Android application (`com.zoni.jarvis.assistant`)**, **native Android SIM Calling**, **Room local database**, and an automated **GitHub Actions APK build pipeline**.

---

## Architecture Overview

1. **Preserved Original React Dashboard (`src/`)**
   - React 19 + TypeScript + Vite + Tailwind CSS + Motion + Lucide icons.
   - All original components preserved intact: `ArcReactor`, `HudHeader`, `ControlDock`, `GfStatusPanel`, `VoiceTelemetryPanel`, `ChatTranscriptDrawer`, `ActionPromptCard`, `PermissionsSetupModal`, `ZoniSettingsModal`, `ApkExportModal`.
   - Native Android SIM Calling Hub (`SimCallingModal`) with contact search, Bengali/English/Indian/Bangladesh number normalization, user confirmation, and local SIM call history.

2. **Native Android Application Shell (`android/`)**
   - Package ID: `com.zoni.jarvis.assistant` (`minSdk 26`, `targetSdk 34`, Kotlin 2.0, Jetpack Compose, Material 3, `android.useAndroidX=true`).
   - **Original Dashboard Hosting**: `MainActivity.kt` loads the compiled React dashboard from `android/app/src/main/assets/public/` via `androidx.webkit.WebViewAssetLoader` (`https://appassets.androidplatform.net/assets/public/index.html`) and bridges native Android APIs through `window.ZoniAndroidBridge` (`ZoniWebAppInterface.kt`), with a synchronized Jetpack Compose HUD fallback.
   - **Native SIM Calling & Android Telecom**: `ContactCallManager` (`ContactsContract` + `ACTION_CALL` / `ACTION_DIAL`), `SimCallManager`, `ZoniCallScreeningService` (`CallScreeningService`), and `ZoniInCallService` (optional Default Dialer `InCallService`).
   - **Native Hardware & Services**: `FlashlightController` (Camera2), `AppLauncher` (PackageManager), `DeviceActionExecutor`, `FloatingOrbService`, `ZoniForegroundService`, `ZoniAccessibilityService`, `ZoniNotificationListenerService`, `OnboardingActivity`.
   - **Local Database**: Room (`ZoniDatabase`) storing local SIM call logs, conversations, task executions, and preferences.

3. **Express + WebSocket Backend (`server.ts`)**
   - Real-time `/live` WebSocket bridge to **Gemini 3.8 Live (`gemini-3.8-live`)** (16kHz PCM in / 24kHz PCM out).
   - Conversational `/api/chat` (`gemini-3.1-flash-lite` / `gemini-4-hydrogen`), `/api/tts` (`gemini-3.8-flash-lite-tts`), `/api/time` (Asia/Kolkata deterministic Bengali time/date/weekday), `/api/tasks/plan`, and `/api/status`.
   - Only requires `GEMINI_API_KEY` — no Twilio, SIP, or external VoIP backend credentials required.

---

## Local Development

```bash
# 1. Install dependencies
npm install

# 2. Configure .env (copy from .env.example and set GEMINI_API_KEY)
cp .env.example .env

# 3. Run unit tests
npm test

# 4. Start full-stack dev server on http://localhost:3000
npm run dev
```

---

## Building the Real Android APK

### Option 1: GitHub Actions (Recommended — Automated)
Push to `main` / `master` (or trigger **Actions → ZONI AI Android APK Build → Run workflow**):
- Automatically runs `npm test`, `npm run lint`, `npm run android:sync`, `./android/gradlew :app:testDebugUnitTest`, `:app:assembleDebug`, and `:app:assembleRelease`.
- Uploads Debug APK artifact **`ZONI-AI-Debug-APK`** (`app-debug.apk` — no signing secrets needed) and Release APK artifact **`ZONI-AI-Release-APK`**.
- Optional Release Signing GitHub Repository Secrets:
  - `ANDROID_KEY_BASE64` (base64 of `.jks` keystore)
  - `ANDROID_KEY_ALIAS`
  - `ANDROID_KEY_PASSWORD` (and `ANDROID_KEYSTORE_PASSWORD` if different)

### Option 2: Local Android Studio / Gradle CLI (Requires JDK 17 + Android SDK 34)
```bash
# 1. Build original React dashboard & copy into android/app/src/main/assets/public/
npm run android:sync

# 2. Build Debug APK using the included Gradle 8.7 wrapper
cd android
./gradlew assembleDebug

# 3. Install onto connected Android phone
adb install -r app/build/outputs/apk/debug/app-debug.apk
```
