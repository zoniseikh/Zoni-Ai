# Zoni AI — Native Android App Build Guide

This directory (`/android`) contains the **complete, genuine native Android Kotlin + Jetpack Compose application** for **Zoni AI (`com.zoni.jarvis.assistant`)** with 100% feature parity to the web project.

## Included Native Android Modules
- **Jetpack Compose Sci-Fi UI**: Rotating Arc Reactor HUD (`ArcReactorView`), HUD Header, Control Dock, Settings Modal, Transcript Archive, and Android Hardware Hub.
- **Full-Duplex Gemini Live Audio (`LiveAudioEngine.kt`)**: Hardware `AudioRecord` (16kHz PCM16 + AcousticEchoCanceler + NoiseSuppressor) & `AudioTrack` (24kHz PCM16).
- **Shared Gemini Live WebSocket (`ZoniLiveSessionClient.kt`)**: OkHttp WebSocket connecting to `/live` with session resumption, voice + chat box unified turns, and exponential backoff reconnect.
- **Native Hardware Controller (`AndroidHardwareController.kt`)**:
  - Camera2 hardware Torch/Flashlight (`setTorchMode`)
  - Direct Phone Calls (`ACTION_CALL` / `ACTION_DIAL`) + Contacts lookup (`ContactsContract`)
  - Direct SMS (`SmsManager` / `ACTION_SENDTO`) & WhatsApp deep intent
  - `VibratorManager` haptics & `BatteryManager` status
  - `PackageManager` installed app launcher & Android System Settings intents
- **Android System Services**:
  - `ZoniForegroundService` (`foregroundServiceType="microphone"`)
  - `FloatingOrbService` (`SYSTEM_ALERT_WINDOW` draggable Arc Reactor orb)
  - `ZoniAccessibilityService` (explicitly permitted screen actions)
  - `ZoniNotificationListenerService` (on-device notification reading)
  - `ACTION_ASSIST` / `ACTION_VOICE_COMMAND` Default Digital Assistant support
- **3-Step Native Setup Wizard (`OnboardingActivity.kt`)**: Encrypted Gemini key storage (`EncryptedSharedPreferences`), real Android runtime permission requests, and real system settings shortcuts.

## Building the APK in Android Studio
1. Open the `android/` folder in **Android Studio** (Ladybug or newer, JDK 17, Android SDK 34).
2. Let Gradle sync automatically.
3. Click **Build → Build Bundle(s) / APK(s) → Build APK(s)** (or run `./gradlew assembleDebug` in `android/`).
4. Your installable APK is generated at:
   `android/app/build/outputs/apk/debug/app-debug.apk`
5. Install on any Android 8.0+ (API 26+) phone via USB (`adb install -r app/build/outputs/apk/debug/app-debug.apk`) or copy the APK directly to your device.
