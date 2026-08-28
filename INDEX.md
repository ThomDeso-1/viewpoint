# INDEX.md — repository map

A living map of what lives where. Update it in the same commit as any
structural change. Companion to [`AGENTS.md`](AGENTS.md) (how to work here)
and [`docs/AUDIT.md`](docs/AUDIT.md) (what's wrong).

- [Structure](#structure)
- [Subsystem index](#subsystem-index) — "I need to change X → these files"
- [Deferred follow-ups](#deferred-follow-ups)
- [Conventions](#conventions)

The docs reorg (→ `docs/`) and the code reorg (domain-grouped `server/`
and `client/`) both landed on **2026-08-28**.

---

## Structure

```
viewpoint-receipts/
├── README.md  AGENTS.md  INDEX.md
├── package.json                    server deps + scripts (dev, demo, test, build, typecheck)
├── tsconfig.json  vitest.config.ts
│
├── docs/
│   ├── AUDIT.md                    known issues, prioritized
│   ├── GETTING-STARTED.md          non-technical setup — receipts only, needs rewrite
│   ├── SETUP-CREDENTIALS.md        every credential, where to get it
│   ├── DEPLOYMENT.md               hosting, HTTPS, backups
│   ├── SECURITY.md                 auth model, data at rest, PHI egress
│   ├── DEMO.md                     credential-free demo
│   └── history/  conversion-plan.md  upgrade-plan.md   (partly stale; kept for rationale)
│
├── App launchers (repo root — peers of Dockerfile, users double-click .command)
│   ├── start-native.command / .sh  Node path, no Docker; installs a launchd agent
│   ├── run-server.sh               what the launchd agent runs
│   ├── lib-node-runtime.sh         sourced by the above; vendors Node 22 if needed
│   ├── stop-native.sh              unloads the launchd agent
│   ├── start.command / .sh  stop.command / .sh   Docker variants
│   ├── Dockerfile  docker-compose.yml
│   └── scripts/                    maintenance / CI helpers only
│       ├── make-bundle.sh          zips a clean copy for hand-off (run by CI)
│       └── backup.sh               sqlite .backup + Receipts/ → tarball (see audit P2-7)
│
├── .github/workflows/bundle.yml    push→main: rebuild bundle, publish `latest` release
│                                   ⚠ no test/typecheck gate (audit P1-18)
├── deploy/  Caddyfile  nginx.conf.example  viewpoint-receipts.service
│
├── server/                         Express + TypeScript, run via tsx (no build step)
│   ├── index.ts                    process entrypoint; loads .env, starts BOTH pollers
│   ├── app.ts                      createApp(): middleware, route mounts, static SPA
│   ├── db/
│   │   ├── db.ts                   connection, migration runner, ReceiptRow, config helpers
│   │   └── migrations/             001-initial · 002-security · 003-practice
│   │                               004-invoice-line-items · 005-retention
│   ├── platform/                   things every feature uses
│   │   ├── auth.ts                 scrypt, login throttle, authMiddleware, requireAuth
│   │   ├── sessions.ts             random tokens, SHA-256 storage, cookie options
│   │   ├── crypto.ts               AES-256-GCM at rest; DATA_ENCRYPTION_KEY
│   │   ├── audit.ts                append-only audit_log writer
│   │   ├── oauth-store.ts          encrypted OAuth token storage (Google + Wave)
│   │   ├── env-config.ts           writes credential updates to .env at runtime
│   │   ├── endpoints.ts            THE demo-mode switch — real vs mock base URLs
│   │   ├── backoff.ts              stored-not-slept retry pacing, shared by both queues
│   │   ├── poller.ts               makePoller: re-entry guard + interval + trigger, shared by both queues
│   │   ├── failure.ts              applyFailure: the "retryable? bump; exhausted? give up" transition
│   │   ├── escape.ts               escapeHtml / escapeXml (OAuth result page, HCV SOAP)
│   │   ├── http.ts                 apiNotFound (JSON 404) + errorHandler (terminal 500)
│   │   ├── rate-limit.ts           fixed-window limiter for paid-API / ministry routes
│   │   └── phi-guard.ts            refuses to boot over plain HTTP once PHI is in play
│   ├── receipts/
│   │   ├── storage.ts              monthly folders, image hash, sidecars, re-filing
│   │   └── upload-queue.ts         background poller → Wave expenses
│   ├── practice/
│   │   ├── types.ts                all practice row types + status unions + extraction shape
│   │   ├── patients.ts             ⚠ ONLY doorway to health card numbers (readHealthCard)
│   │   ├── appointments.ts         mirrored from Google Calendar
│   │   ├── exam-requests.ts        one row per incoming booking email; encrypted extraction
│   │   ├── eligibility.ts          runs OHIP checks, records outcomes
│   │   ├── reminders.ts            ReminderChannel interface (email today, SMS later)
│   │   └── queue.ts                the automation orchestrator (was practice-queue.ts)
│   ├── integrations/               one folder per external service, bare fetch
│   │   ├── claude.ts               receipt + exam-request extraction; prompts; model IDs
│   │   ├── oauth/   state-store.ts (pending `state` map)  callback.ts (shared result page + router factory)
│   │   ├── wave/    index.ts (barrel)  transport.ts  reference.ts  expenses.ts
│   │   │            customers.ts  invoices.ts  auth.ts (token ↔ OAuth)
│   │   ├── google/  auth.ts  gmail.ts  calendar.ts
│   │   └── ohip/    index.ts (factory)  hcv-client.ts (interface + response codes)
│   │                hcv-mock.ts  hcv-soap.ts (WS-Security SOAP, schema unverified)
│   └── routes/                     HTTP layer — thin, delegate to the domains above
│       ├── auth.ts  settings.ts
│       ├── receipts.ts  practice.ts
│       └── google.ts  wave-oauth.ts   provider specifics only; flow shared via integrations/oauth/
│
├── client/  React 19 + Vite 6 + react-router 7, PWA
│   ├── vite.config.ts              dev proxy → :3000; PWA/Workbox caching (audit P1-6)
│   └── src/
│       ├── main.tsx  App.tsx  styles.css  vite-env.d.ts
│       ├── shared/   api.ts (the whole /api surface, typed)  StatusBadge  Toast  AddToHomeScreenTip
│       ├── auth/     Login  Setup  Onboarding
│       ├── receipts/ ReceiptList  ReceiptReview  BatchReview  Settings
│       │             CaptureButton  ReceiptRow  ReceiptReviewForm  UploadStatusBar
│       └── practice/ Inbox  Schedule  Patients  PatientDetail  AuditLog
│                     GoogleSettings  PracticeSettings  OhipSettings  InvoiceEditor  AppointmentForm
│
├── tests/                          server suite (vitest + supertest) — mirrors server/
│   ├── helpers/  testApp.ts (isolated temp DB + cwd per file)  fetchMock.ts
│   ├── platform/  auth  security  phi-guard  rate-limit  audit-chain
│   ├── receipts/  receipts  receipts-extract  storage  upload-queue
│   ├── practice/  patients  queue  routes
│   ├── integrations/  claude  wave  wave-oauth  google  ohip  demo-mode
│   └── http/  settings  error-handling
│
├── client/tests/                   mirrors client/src — App.test.tsx + {shared,auth,receipts,practice}/
│
├── demo/  mock-server.ts  seed.ts  fixtures.ts     credential-free full-app demo
└── data/  (gitignored, runtime)    receipts.db  +  Receipts/YYYY-MM/{jpg,json}
```

---

## Subsystem index

| I need to change… | Files |
|---|---|
| **Auth / login / sessions** | `server/platform/auth.ts`, `server/platform/sessions.ts`, `server/routes/auth.ts`, `client/src/auth/{Login,Setup}.tsx` |
| **Encryption at rest** | `server/platform/crypto.ts` (+ every `*_enc` column in `db/migrations/003-practice.sql`) |
| **Audit trail** | `server/platform/audit.ts` (`audit()`, `verifyAuditChain()`), `server/routes/practice.ts` (`GET /audit`, `/audit/verify`), `client/src/practice/AuditLog.tsx` |
| **The receipts pipeline** | `server/routes/receipts.ts`, `server/receipts/{storage,upload-queue}.ts`, `server/integrations/claude.ts`, `server/integrations/wave/{transport,expenses}.ts`, `client/src/receipts/*` |
| **The exam-request pipeline** | `server/practice/queue.ts` (orchestrator) + `exam-requests.ts`, `patients.ts`, `appointments.ts`, `eligibility.ts`, `reminders.ts`; `server/routes/practice.ts`; `client/src/practice/{Inbox,Schedule,Patients,PatientDetail}.tsx` |
| **Claude prompts / models** | `server/integrations/claude.ts` |
| **Wave (expenses + invoices)** | `server/integrations/wave/` (`index.ts` barrel over `transport` / `reference` / `expenses` / `customers` / `invoices`; `auth.ts` for token ↔ OAuth), `server/routes/wave-oauth.ts` |
| **Google (Gmail + Calendar)** | `server/integrations/google/{auth,gmail,calendar}.ts`, `server/platform/oauth-store.ts`, `server/routes/google.ts`, `client/src/practice/GoogleSettings.tsx` |
| **OAuth flow plumbing (both providers)** | `server/integrations/oauth/{state-store,callback}.ts` — `state` map + the callback router factory / result page |
| **OHIP eligibility** | `server/integrations/ohip/*`, `server/practice/eligibility.ts`, `client/src/practice/OhipSettings.tsx` |
| **Reminders (+ future SMS)** | `server/practice/reminders.ts` (`ReminderChannel` interface) |
| **Background queues / retry** | `server/receipts/upload-queue.ts`, `server/practice/queue.ts`, `server/platform/{backoff,poller}.ts` |
| **Settings screens** | `server/routes/settings.ts`, `client/src/receipts/Settings.tsx`, `client/src/auth/Onboarding.tsx`, `client/src/practice/*Settings.tsx` |
| **DB schema** | `server/db/migrations/` (new file only) + `server/db/db.ts` / `server/practice/types.ts` |
| **Demo mode** | `server/platform/endpoints.ts`, `demo/*` |
| **The `/api` contract** | `client/src/shared/api.ts` ↔ `server/routes/*.ts` (change both) |
| **Deploy / hosting** | `Dockerfile`, `docker-compose.yml`, `deploy/*`, `docs/DEPLOYMENT.md` |
| **Hand-off bundle** | `scripts/make-bundle.sh`, `.github/workflows/bundle.yml` |

---

## Deferred follow-ups

The reorg was kept to **moves + import rewrites** (fully mechanical,
verified by `typecheck:all` + `test:all`). These refactors were
deliberately left out and should each be their own small commit — see
[`docs/AUDIT.md`](docs/AUDIT.md) §4:

- ~~**P2-25**~~ — ✅ done. `server/integrations/oauth/` holds the shared
  `state-store.ts` + `callback.ts` (result page + `makeCallbackRouter`
  factory); each route file keeps only its `buildAuthorizeUrl` /
  `exchange` wiring.
- ~~**P2-26**~~ — ✅ done. `server/integrations/wave/wave.ts` (691 lines)
  → `transport` / `reference` / `expenses` / `customers` / `invoices`
  + an `index.ts` barrel.
- ~~**P2-27**~~ — ✅ done. `server/platform/poller.ts` (`makePoller`);
  both queues keep only their `processQueue` pass + a one-line
  `makePoller({ name, intervalMs, pass })`.
- ~~**P3-28**~~ — ✅ done. `server/platform/failure.ts` (`applyFailure`);
  the three `recordFailure` / inline sites pass a policy.
- ~~**P3-29**~~ — ✅ done. One `server/platform/escape.ts`
  (`escapeHtml` / `escapeXml`).

**§4 dedup is complete.** Still open, and not part of §4:

- **Client** — split `client/src/shared/api.ts` into
  `api/{auth,receipts,practice,settings}.ts` + a barrel.
- Sweep the stale `Spec (CONVERSION-PLAN.md …)` citations in test-file
  header comments.

---

## Conventions

- **Server imports** use `.js` extensions (`moduleResolution: bundler`,
  run via `tsx`). Relative paths only — no path aliases.
- **`server/db/` stays put** — `db.ts` is the connection + migration
  runner; migrations are SQL files it reads at boot. Practice *row types*
  live in `server/practice/types.ts` (domain, not infra).
- **`server/routes/` is the HTTP layer** — thin handlers that validate,
  call into `platform/` / `receipts/` / `practice/` / `integrations/`,
  and shape the response. No business logic.
- **App launchers stay at the repo root** (`start*.command/.sh`,
  `run-server.sh`, `lib-node-runtime.sh`) — they resolve `APP_DIR` from
  their own location and the launchd plist hardcodes those paths.
  `scripts/` is for maintenance/CI helpers only.
- **Tests mirror source.** A new `server/practice/foo.ts` gets
  `tests/practice/foo.test.ts`; a new `client/src/receipts/Bar.tsx` gets
  `client/tests/receipts/Bar.test.tsx`.
