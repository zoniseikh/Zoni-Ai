# ZONI AI — Production Backend Deployment Guide

The **ZONI AI** Android APK (`com.zoni.jarvis.assistant`) and Web dashboard connect to the **ZONI AI Express + WebSocket backend (`server.ts`)** for all Gemini AI requests (`POST /api/chat`, `POST /api/tts`, `POST /api/screen/analyze`, `POST /api/notifications/smart-reply`, and bidirectional WebSocket `WSS /live`).

> **Security Architecture**: `GEMINI_API_KEY` stays strictly on the backend server (`process.env.GEMINI_API_KEY`). It is never bundled into the Android APK or frontend JavaScript, and end users are never asked to paste API keys into browser `localStorage`.

---

## 1. Prerequisites

- A valid Google Gemini API key (server-side secret `GEMINI_API_KEY`).
- A hosting platform that supports **HTTPS** and **WebSockets (`wss://`)** on a single Node.js HTTP server:
  - Google Cloud Run (recommended — native WebSocket support + automatic HTTPS)
  - Render Web Service
  - Railway
  - Any Linux VPS / Docker host behind Nginx or Caddy with WebSocket upgrade headers.

---

## 2. Option A — Redeploy / Update Confirmed Google Cloud Run Service (`zoni-ai`)

Your confirmed production backend service is:

- **URL**: `https://zoni-ai-675435111499.asia-southeast1.run.app`
- **Service Name**: `zoni-ai`
- **Region**: `asia-southeast1`

To deploy updated `server.ts` routes (enhanced `/api/status` diagnostics, `/api/chat` structured errors, and `/live` WebSocket session cleanup) directly to the existing Cloud Run service:

```bash
gcloud run deploy zoni-ai \
  --source . \
  --region asia-southeast1 \
  --allow-unauthenticated \
  --port 3000 \
  --timeout 3600 \
  --set-env-vars "NODE_ENV=production" \
  --set-secrets "GEMINI_API_KEY=GEMINI_API_KEY:latest"
```

*(Or pass `--set-env-vars "NODE_ENV=production,GEMINI_API_KEY=YOUR_KEY"` if you are not using Secret Manager.)*

---

## 3. Option B — Deploy with Docker (VPS / Render / Railway)

```bash
docker build -t zoni-ai .
docker run -d \
  --name zoni-ai \
  -p 3000:3000 \
  -e NODE_ENV=production \
  -e GEMINI_API_KEY="YOUR_SERVER_SIDE_GEMINI_API_KEY" \
  zoni-ai
```

If deploying behind **Nginx**, ensure WebSocket upgrade headers are forwarded for `/live`:

```nginx
location /live {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 3600s;
}
```

---

## 4. Verify the Deployed Backend

1. **Health & Configuration Check**:
   ```bash
   curl -s https://zoni-ai-675435111499.asia-southeast1.run.app/api/status
   ```
   Confirm the JSON response includes:
   - `"status": "online"`
   - `"geminiLiveSupported": true`
   - `"geminiConfigured": true` (present after redeploying updated `server.ts`)
   - `"liveWsPath": "/live"`
   - `"chatEndpoint": "/api/chat"`

2. **Chat Endpoint Check**:
   ```bash
   curl -s -X POST https://zoni-ai-675435111499.asia-southeast1.run.app/api/chat \
     -H "Content-Type: application/json" \
     -d '{"message":"হ্যালো জনি","lang":"bn-BD","selectedAffectionName":"Boss"}'
   ```

3. **Live WebSocket Check**:
   Connect to `wss://zoni-ai-675435111499.asia-southeast1.run.app/live?mode=romantic&nickname=Boss&voice=Kore&lang=bn-BD` and confirm the server returns `{"type":"connected",...}`.

---

## 5. Connect the Android APK to Your Deployed Backend

The Android APK defaults out-of-the-box to **`https://zoni-ai-675435111499.asia-southeast1.run.app`** (and automatically migrates any stale `ais-pre-`, `localhost`, or `appassets.androidplatform.net` saved URLs):

1. **At Runtime (No APK rebuild needed)**:
   Open ZONI AI on Android → tap **PERMISSIONS / SETUP** → **Step 1: Backend & Gemini Link** → verify or update the HTTPS URL → tap **Save & Verify**. The URL is persisted via Android `SecureKeyManager` (AES-256 EncryptedSharedPreferences) and immediately verified against `/api/status`.
2. **Optional Build-Time Override in GitHub Actions**:
   `.github/workflows/android-build.yml` defaults `ZONI_BACKEND_URL` and `VITE_BACKEND_URL` to `https://zoni-ai-675435111499.asia-southeast1.run.app`. You can override it anytime by setting the repository variable `ZONI_BACKEND_URL` in GitHub Settings → Secrets and variables → Actions → Variables.
