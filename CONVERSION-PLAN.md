# Viewpoint Receipts — iOS → Webapp Conversion Plan

## Overview

Convert Viewpoint Receipts from an iOS native app (Swift/SwiftUI) to a self-hosted webapp that the end user accesses from their iPhone browser. The app photographs business receipts, extracts structured data via Claude API vision, allows review and editing, and uploads expense transactions to Wave accounting.

**Why**: Apple's distribution restrictions — code signing, $99/yr developer program, TestFlight's 90-day expiry — are excessive for a single-user app. A self-hosted webapp eliminates all of that.

**Target user**: A single person running a Canadian business. Not Thomas — the end user has their own Claude API key and Wave access token.

## Tech Stack

| Layer | iOS (was) | Webapp (now) |
|-------|-----------|--------------|
| Frontend | SwiftUI | React + TypeScript + Vite |
| Backend | On-device | Node.js + Express + TypeScript |
| Database | SwiftData (Core Data/SQLite) | SQLite via better-sqlite3 |
| Auth | None (single device) | Password-based (SHA-256 hash, cookie/bearer) |
| Image storage | App sandbox / iCloud | Server filesystem (`data/Receipts/YYYY-MM/`) |
| Credential storage | iOS Keychain | `.env` file on the server |
| Receipt extraction | Claude API (client-side) | Claude API (server-side proxy) |
| Accounting upload | Wave GraphQL API (client-side) | Wave GraphQL API (server-side) |
| Distribution | TestFlight / App Store | PWA — add to iPhone home screen |

## Architecture

```
┌──────────────────────────────┐
│  iPhone (Safari / PWA)       │
│  React SPA + Service Worker  │
└──────────┬───────────────────┘
           │ HTTPS
┌──────────▼───────────────────┐
│  Express Server (Node.js)    │
│  ├─ /api/auth/*              │
│  ├─ /api/receipts/*          │
│  ├─ /api/settings/*          │
│  ├─ /images/* (static)       │
│  └─ /* (React SPA)           │
├──────────────────────────────┤
│  SQLite (receipts.db)        │
│  File storage (data/Receipts)│
├──────────────────────────────┤
│  Claude API ◄── extraction   │
│  Wave API   ◄── upload queue │
└──────────────────────────────┘
```

## Receipt Pipeline

Status flow (unchanged from iOS):

```
captured → extracted → reviewed → uploaded
                 ↘                    ↗
            needsAttention ──────────
                 ↘
               failed
```

1. **Captured**: Image saved to `Receipts/YYYY-MM/`, DB row created, sidecar JSON written
2. **Extracted**: Claude vision API extracts vendor, date, items, subtotal, taxes, total, currency, confidence
3. **Reviewed**: User verifies/corrects fields, approves; upload queue triggered
4. **Uploaded**: Wave `moneyTransactionCreate` mutation succeeds, transaction ID stored
5. **Needs Attention**: Non-retryable error (rejected by Wave, zero amount, etc.)
6. **Failed**: Retryable error exhausted max retries (5)

## Phase 1: Capture + Archive + Server Scaffold ✅

Stand up the Express server, SQLite database, and React shell.

### Server
- Express app with TypeScript (`tsx` for dev, no compile step needed)
- SQLite database with `receipts` and `app_config` tables
- Storage service: monthly folders, JPEG save, image hash (SHA-256), sidecar JSON
- Auth middleware: password hash stored in DB, cookie + bearer token auth
- Receipt routes: upload (multer), list (grouped by month, search/filter), get, delete
- Settings route: masked key previews, Wave config, onboarding status
- Static serving: `/images/*` for receipt photos, React build for everything else

### Client
- React + Vite + TypeScript
- Router with auth gating (redirects to `/setup` or `/login`)
- Login page, first-run setup page (set password)
- Receipt list grouped by month with thumbnails, vendor, amount, status badges, search
- Floating action button: camera capture (`capture="environment"`) + photo library
- Mobile-first CSS with dark mode support
- Queue status pills (captured / pending / failed / uploaded)

### PWA
- Web app manifest (standalone, portrait, themed)
- Service worker via `vite-plugin-pwa` (Workbox)
  - Precache: all static assets
  - Runtime: NetworkFirst for `/api/*`, CacheFirst for `/images/*`
- Apple touch icon, meta tags for iOS home screen install

## Phase 2: Extraction + Review + Upload ✅

### Claude API Extraction Service (`server/services/claude.ts`)
- Ported from `ClaudeAPIService.swift`
- Model: `claude-sonnet-4-20250514` for extraction, `claude-haiku-3-5-20241022` for validation
- Canada-aware prompt: looks for HST/GST/PST tax breakdowns
- Endpoint: `POST /api/receipts/:id/extract`
- Reads image files from disk, base64-encodes, sends to Claude Messages API
- Parses JSON response, updates DB row (vendor, summary, total, tax, currency, extracted_json)
- Updates sidecar file with extraction result
- Error handling: invalid key, insufficient credit, rate limited, network errors

### Receipt Review Page (`client/src/pages/ReceiptReview.tsx`)
- Ported from `ReceiptReviewView.swift`
- Image preview at top
- Auto-triggers extraction for `captured` receipts; shows form for `extracted`/`reviewed`
- Editable fields: date, vendor, description, total, tax, currency
- Confidence banner (high/medium/low) from extraction result
- Reconciliation check (subtotal + tax ≈ total within $0.02)
- Duplicate detection:
  - By image hash (SHA-256 match against existing receipts)
  - By date + vendor + total (same-day same-vendor same-amount)
- Validation warnings: future date, >1yr old, non-CAD currency, zero/negative total
- Approve button → sets status to `reviewed`, updates sidecar, triggers upload queue
- Fallback: "Enter Manually" if no API key or extraction fails

### Wave API Service (`server/services/wave.ts`)
- Ported from `WaveAPIService.swift`
- GraphQL client for `https://gql.waveapps.com/graphql/public`
- Functions: fetchBusinesses, fetchAccounts, fetchExpenseAccounts, fetchAnchorAccounts, fetchSalesTaxes, fetchVendors, findVendor, createExpenseTransaction, checkTokenHealth, validateToken
- `createExpenseTransaction`: anchor (bank/CC withdrawal) + line item (expense increase), optional sales tax
- External ID format: `viewpoint-{uuid-prefix}` for idempotency

### Upload Queue (`server/services/upload-queue.ts`)
- Ported from `UploadService.swift`
- **Improvement over iOS**: runs server-side 24/7 instead of only during app foreground
- Polls every 60 seconds for `reviewed` receipts
- Exponential backoff: base 5s, max 300s, max 5 retries
- On success: status → `uploaded`, stores Wave transaction ID
- On non-retryable error: status → `needsAttention`
- On retryable error exhausted: status → `failed`
- Endpoints: `POST /api/receipts/:id/retry`, `POST /api/receipts/retry-all`

### Settings Page (`client/src/pages/Settings.tsx`)
- Claude API key status (masked preview)
- Wave connection health check
- Wave business name
- Upload queue counts (captured, pending, failed, uploaded)
- Retry All Failed button
- Sign Out button

### Settings Validation Endpoints
- `POST /api/settings/validate-claude-key` — test a Claude API key
- `POST /api/settings/validate-wave-token` — test a Wave token, return business list
- `GET /api/settings/wave/accounts` — fetch expense + anchor accounts
- `GET /api/settings/wave/taxes` — fetch sales taxes
- `GET /api/settings/wave/health` — quick token health check
- `POST /api/settings/onboard` — mark onboarding complete

## Phase 3: Onboarding Wizard (TODO)

Three-step first-run wizard (simplified from iOS's four steps — no storage location choice needed):

1. **Set password** — already implemented via `/setup`
2. **Claude API key** — paste key, validate, save to `.env`
3. **Wave connection** — paste token, select business, select expense account, anchor account, sales tax

The wizard should write credentials to `.env` (or a server endpoint that updates the running config). Currently credentials must be set in `.env` before starting the server.

## Phase 4: Polish + Deployment (TODO)

- Health check banner on receipt list (Wave token expired, API key invalid)
- Batch review queue (swipe through multiple captured receipts)
- Image re-filing when receipt date changes months (move files between `YYYY-MM/` folders)
- Better error toasts instead of `alert()`
- Deployment guide: Docker container, reverse proxy (nginx/Caddy), HTTPS, systemd service
- Backup strategy for `data/` directory

## File Structure

```
viewpoint-receipts/
├── .env                          # Credentials (not committed)
├── .gitignore
├── package.json                  # Root: server deps + scripts
├── tsconfig.json                 # Server TypeScript config
├── server/
│   ├── index.ts                  # Express app entry
│   ├── db/
│   │   ├── db.ts                 # SQLite wrapper + types
│   │   └── schema.sql            # Table definitions
│   ├── middleware/
│   │   └── auth.ts               # Password auth
│   ├── routes/
│   │   ├── auth.ts               # Login / setup / logout
│   │   ├── receipts.ts           # CRUD + extract + review + retry
│   │   └── settings.ts           # Config + validation + health
│   └── services/
│       ├── storage.ts            # File management (monthly folders, sidecars)
│       ├── claude.ts             # Claude API vision extraction
│       ├── wave.ts               # Wave GraphQL API client
│       └── upload-queue.ts       # Background upload processor
├── client/
│   ├── index.html
│   ├── package.json              # React deps
│   ├── tsconfig.json
│   ├── vite.config.ts            # Vite + PWA plugin
│   ├── public/
│   │   ├── icon-192.png
│   │   └── icon-512.png
│   └── src/
│       ├── main.tsx
│       ├── App.tsx               # Router + auth gating
│       ├── styles.css            # Mobile-first + dark mode
│       ├── vite-env.d.ts
│       ├── api/
│       │   └── client.ts         # Fetch wrapper for all endpoints
│       ├── components/
│       │   ├── CaptureButton.tsx  # Camera + photo library FAB
│       │   ├── ReceiptRow.tsx     # List item with thumbnail
│       │   ├── StatusBadge.tsx    # Colored status pill
│       │   └── UploadStatusBar.tsx
│       └── pages/
│           ├── Login.tsx
│           ├── Setup.tsx          # First-run password
│           ├── ReceiptList.tsx    # Main list view
│           ├── ReceiptReview.tsx  # Extract + review + approve
│           └── Settings.tsx
└── data/                         # Created at runtime (gitignored)
    ├── receipts.db               # SQLite database
    └── Receipts/
        └── YYYY-MM/              # Monthly folders
            ├── date_batchid.jpg  # Receipt images
            └── date_batchid.json # Sidecar metadata
```

## Running

```bash
# Development (hot reload for both server and client)
cd ~/viewpoint-receipts
npm install
cd client && npm install && cd ..
npm run dev

# Production
npm run build      # builds client to client/dist/
npm start          # serves everything from port 3000
```

## iOS Feature Parity Checklist

| Feature | iOS | Webapp | Notes |
|---------|-----|--------|-------|
| Camera capture | ✅ VisionKit | ✅ `<input capture>` | No document scanning, but Claude handles imperfect photos |
| Photo library import | ✅ PhotosPicker | ✅ `<input multiple>` | |
| Monthly folder organization | ✅ | ✅ | Identical `YYYY-MM/` structure |
| Sidecar JSON files | ✅ | ✅ | Same format |
| Image hash dedup | ✅ SHA-256 | ✅ SHA-256 | |
| Claude extraction | ✅ Client-side | ✅ Server-side | Same prompt, same models |
| Review + edit form | ✅ | ✅ | Same fields, same validations |
| Confidence banner | ✅ | ✅ | |
| Duplicate detection | ✅ | ✅ | Hash + date/vendor/total |
| Validation warnings | ✅ | ✅ | Future date, old, non-CAD, zero total |
| Wave upload | ✅ Client-side | ✅ Server-side | Same GraphQL mutations |
| Upload queue + backoff | ✅ Foreground only | ✅ 24/7 server-side | **Improvement** |
| Retry failed uploads | ✅ | ✅ | Single + retry-all |
| Password auth | ❌ (device lock) | ✅ | Cookie-based, 1yr expiry |
| PWA home screen install | ❌ (native) | ✅ | Standalone, themed |
| iCloud storage option | ✅ | ❌ | Not needed — server is the single location |
| Local notifications | ✅ | ❌ | TODO: could add web push |
| Batch review queue | ✅ | ❌ | TODO: Phase 4 |
| Health check banner | ✅ | ❌ | TODO: Phase 4 |
