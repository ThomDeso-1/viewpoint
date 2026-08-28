# INDEX.md — repository map

A living map of what lives where. Update it in the same commit as any
structural change. Companion to [`AGENTS.md`](AGENTS.md) (how to work here)
and [`docs/AUDIT.md`](docs/AUDIT.md) (what's wrong).

- [Current structure](#current-structure) — as of 2026-08-28
- [Subsystem index](#subsystem-index) — "I need to change X → these files"
- [Target structure](#target-structure) — where this is heading
- [Migration](#migration) — ordered steps to get there

---

## Current structure

```
viewpoint-receipts/
├── README.md  AGENTS.md  INDEX.md
├── package.json                    server deps + scripts (dev, demo, test, build)
├── tsconfig.json  vitest.config.ts  server configs
│
├── docs/                           ✅ guides moved here 2026-08-28
│   ├── AUDIT.md                    known issues, prioritized
│   ├── GETTING-STARTED.md          non-technical setup — receipts only, needs rewrite
│   ├── SETUP-CREDENTIALS.md        every credential, where to get it
│   ├── DEPLOYMENT.md               hosting, HTTPS, backups
│   ├── SECURITY.md                 auth model, data at rest, PHI egress
│   ├── DEMO.md                     credential-free demo
│   └── history/
│       ├── conversion-plan.md      iOS→web port history (stale file tree)
│       └── upgrade-plan.md         practice-module build log + "what's left"
│
├── Entry-point scripts (root — users double-click the .command files)
│   ├── start-native.command / .sh  Node path, no Docker; installs a launchd agent
│   ├── run-server.sh               what the launchd agent runs (build already done)
│   ├── lib-node-runtime.sh         sourced by the above; vendors Node 22 if needed
│   ├── stop-native.sh              unloads the launchd agent
│   ├── start.command / .sh  stop.command / .sh   Docker variants
│   ├── Dockerfile  docker-compose.yml
│   └── scripts/
│       ├── make-bundle.sh          zips a clean copy for hand-off (run by CI)
│       └── backup.sh               sqlite .backup + Receipts/ → tarball (see audit P2-7)
│
├── .github/workflows/bundle.yml    push→main: rebuild bundle, publish to `latest` release
│                                   ⚠ no test/typecheck gate (audit P1-18)
├── deploy/
│   ├── Caddyfile                   auto-HTTPS reverse proxy example
│   ├── nginx.conf.example
│   └── viewpoint-receipts.service  systemd unit (hardcodes /opt path)
│
├── server/                         Express + TypeScript, run via tsx (no build step)
│   ├── index.ts                    process entrypoint; loads .env, starts BOTH pollers
│   ├── app.ts                      createApp(): middleware, route mounts, static SPA
│   ├── db/
│   │   ├── db.ts                   connection, migration runner, ReceiptRow, config helpers
│   │   ├── practice.ts             all practice row types + status unions + extraction shape
│   │   └── migrations/
│   │       ├── 001-initial.sql     receipts + app_config (verbatim original schema)
│   │       ├── 002-security.sql    sessions, audit_log
│   │       ├── 003-practice.sql    patients, appointments, exam_requests, eligibility_checks,
│   │       │                       reminders, wave_invoices, oauth_tokens
│   │       └── 004-invoice-line-items.sql   wave_invoices.line_items (JSON)
│   ├── middleware/
│   │   └── auth.ts                 scrypt, login throttle, authMiddleware, requireAuth
│   ├── routes/
│   │   ├── auth.ts                 setup / login / logout / change-password / status
│   │   ├── receipts.ts             CRUD + extract + review + retry + duplicates + queue/status
│   │   ├── settings.ts             config read/write, credential validation, health, OHIP test
│   │   ├── google.ts               connect/disconnect/status + OAuth callback (2 routers)
│   │   ├── wave-oauth.ts           same shape as google.ts  ← ~120 lines duplicated (audit P2-25)
│   │   └── practice.ts             exam-requests, patients, appointments, eligibility, audit
│   └── services/                   ⚠ 25 files, four domains mixed together
│       ├── platform-ish:  crypto.ts  sessions.ts  audit.ts  env-config.ts  endpoints.ts  backoff.ts  storage.ts
│       ├── receipts:      claude.ts (also does exam-request extraction)  upload-queue.ts
│       ├── practice:      patients.ts  appointments.ts  exam-requests.ts  eligibility.ts
│       │                  reminders.ts  practice-queue.ts
│       ├── wave:          wave.ts (691 lines, audit P2-26)  wave-auth.ts
│       ├── google:        google-auth.ts  gmail.ts  google-calendar.ts  oauth-store.ts
│       └── ohip/          index.ts (factory)  hcv-client.ts (interface + response codes)
│                          hcv-mock.ts  hcv-soap.ts (WS-Security SOAP, unverified schema)
│
├── client/                         React 19 + Vite 6 + react-router 7, PWA
│   ├── vite.config.ts              dev proxy /api,/images → :3000; PWA/Workbox caching (audit P1-6)
│   ├── src/
│   │   ├── main.tsx  App.tsx        App.tsx = router + auth gate (gateTarget race workaround)
│   │   ├── styles.css              all styling, design tokens, dark mode
│   │   ├── api/client.ts           the entire /api surface as typed functions ← contract half
│   │   ├── pages/                  ⚠ receipts + practice interleaved
│   │   │   receipts:  ReceiptList  ReceiptReview  BatchReview  Settings
│   │   │   practice:  Inbox  Schedule  Patients  PatientDetail  AuditLog
│   │   │   auth:      Login  Setup  Onboarding
│   │   └── components/             ⚠ same interleaving
│   │       receipts:  CaptureButton  ReceiptRow  ReceiptReviewForm  UploadStatusBar
│   │       practice:  GoogleSettings  PracticeSettings  OhipSettings  InvoiceEditor  AppointmentForm
│   │       shared:    StatusBadge  Toast  AddToHomeScreenTip
│   └── tests/                      mirrors src/ (components/, pages/) + helpers/fixtures.ts
│
├── tests/                          server suite (vitest + supertest), flat
│   ├── helpers/  testApp.ts (isolated temp DB + cwd per file)  fetchMock.ts
│   └── *.test.ts                   auth, security, receipts, receipts-extract, storage,
│                                   upload-queue, wave-service, wave-oauth, claude-service,
│                                   settings, patients, ohip, practice-queue, practice-routes,
│                                   google, demo-mode
│
├── demo/                           credential-free full-app demo
│   ├── mock-server.ts              one server faking Claude + Wave + Gmail + Calendar + Google OAuth
│   ├── seed.ts  fixtures.ts        3 patients, 3 emails, 3 calendar events, 3 receipts
│
└── data/  (gitignored, runtime)    receipts.db  +  Receipts/YYYY-MM/{jpg,json}
```

---

## Subsystem index

| I need to change… | Files |
|---|---|
| **Auth / login / sessions** | `server/middleware/auth.ts`, `server/services/sessions.ts`, `server/routes/auth.ts`, `client/src/pages/{Login,Setup}.tsx` |
| **Encryption at rest** | `server/services/crypto.ts` (+ every `*_enc` column in `003-practice.sql`) |
| **Audit trail** | `server/services/audit.ts`, `server/routes/practice.ts` (`GET /audit`), `client/src/pages/AuditLog.tsx` |
| **The receipts pipeline** | `server/routes/receipts.ts`, `server/services/{claude,upload-queue,wave,storage}.ts`, `client/src/pages/{ReceiptList,ReceiptReview,BatchReview}.tsx`, `client/src/components/{CaptureButton,ReceiptReviewForm,ReceiptRow}.tsx` |
| **The exam-request pipeline** | `server/services/practice-queue.ts` (orchestrator), `exam-requests.ts`, `patients.ts`, `appointments.ts`, `eligibility.ts`, `reminders.ts`; `server/routes/practice.ts`; `client/src/pages/{Inbox,Schedule,Patients,PatientDetail}.tsx` |
| **Claude prompts / models** | `server/services/claude.ts` |
| **Wave (expenses + invoices)** | `server/services/wave.ts`, `wave-auth.ts`, `server/routes/wave-oauth.ts` |
| **Google (Gmail + Calendar)** | `server/services/{google-auth,gmail,google-calendar,oauth-store}.ts`, `server/routes/google.ts`, `client/src/components/GoogleSettings.tsx` |
| **OHIP eligibility** | `server/services/ohip/*`, `server/services/eligibility.ts`, `client/src/components/OhipSettings.tsx` |
| **Reminders (+ future SMS)** | `server/services/reminders.ts` (`ReminderChannel` interface) |
| **Background queues / retry** | `server/services/{upload-queue,practice-queue,backoff}.ts` |
| **Settings screens** | `server/routes/settings.ts`, `client/src/pages/{Settings,Onboarding}.tsx`, `client/src/components/*Settings.tsx` |
| **DB schema** | `server/db/migrations/` (new file only) + `server/db/{db,practice}.ts` types |
| **Demo mode** | `server/services/endpoints.ts`, `demo/*` |
| **The `/api` contract** | `client/src/api/client.ts` ↔ `server/routes/*.ts` (change both) |
| **Deploy / hosting** | `Dockerfile`, `docker-compose.yml`, `deploy/*`, `docs/DEPLOYMENT.md` |
| **Hand-off bundle** | `scripts/make-bundle.sh`, `.github/workflows/bundle.yml` |

---

## Target structure

The reorg is **not yet done**. This is where it goes (rationale in
`docs/AUDIT.md` §5). The organizing idea: separate **platform** (things
every feature uses) from **domains** (receipts, practice) from
**integrations** (one folder per external service), and mirror that in the
client and the tests.

```
viewpoint-receipts/
├── README.md  AGENTS.md  INDEX.md
├── docs/
│   ├── AUDIT.md  GETTING-STARTED.md  SETUP-CREDENTIALS.md
│   ├── DEPLOYMENT.md  SECURITY.md  DEMO.md
│   └── history/  conversion-plan.md  upgrade-plan.md
├── scripts/
│   ├── start-native.sh  run-server.sh  lib-node-runtime.sh  stop-native.sh
│   ├── start.sh  stop.sh  make-bundle.sh  backup.sh
│   └── (*.command shims stay at repo root, calling scripts/)
├── deploy/                          unchanged
│
├── server/
│   ├── index.ts                     entrypoint + poller startup
│   ├── platform/
│   │   ├── db.ts  migrations/       connection + runner (+ move migrations here)
│   │   ├── auth.ts  sessions.ts
│   │   ├── crypto.ts  audit.ts
│   │   ├── env-config.ts  endpoints.ts  escape.ts
│   │   └── poller.ts  backoff.ts    shared queue scaffolding (audit P2-27)
│   ├── receipts/
│   │   ├── receipts.repo.ts  storage.ts  upload-queue.ts
│   │   └── routes.ts
│   ├── practice/
│   │   ├── patients.ts  appointments.ts  exam-requests.ts
│   │   ├── eligibility.ts  reminders.ts  queue.ts
│   │   ├── types.ts                 (was db/practice.ts)
│   │   └── routes.ts
│   ├── integrations/
│   │   ├── claude/                  client.ts  prompts.ts
│   │   ├── wave/                    transport.ts  expenses.ts  invoices.ts  customers.ts  reference.ts  auth.ts  index.ts
│   │   ├── google/                  auth.ts  gmail.ts  calendar.ts  token-store.ts
│   │   ├── ohip/                    (unchanged internals) + real XML parse
│   │   └── oauth/                   state-store.ts  callback.ts   (dedupes google/wave routes)
│   └── http/
│       ├── app.ts                   createApp()
│       ├── error-handler.ts         terminal handler + 404 (audit P1-10)
│       └── routes/                  auth.ts  settings.ts  (+ re-export domain routers)
│
├── client/src/
│   ├── main.tsx  App.tsx  styles.css
│   ├── api/                         client.ts split → receipts.ts  practice.ts  auth.ts  settings.ts
│   ├── shared/                      StatusBadge  Toast  AddToHomeScreenTip  hooks
│   ├── auth/                        Login  Setup  Onboarding
│   ├── receipts/                    pages + components together
│   └── practice/                    pages + components together
│
├── tests/  (server)                 platform/  receipts/  practice/  integrations/  http/
└── client/tests/                    shared/  auth/  receipts/  practice/
```

Also folded into (or immediately after) the reorg commit:

- **`wave.ts` split** (audit P2-26) → `integrations/wave/*`.
- **OAuth route dedup** (audit P2-25) → `integrations/oauth/*`; `routes/google.ts`
  and `routes/wave-oauth.ts` shrink to provider specifics.
- **`makePoller`** (audit P2-27) — `upload-queue.ts` and `practice/queue.ts`
  keep only their `pass()`.
- **`applyFailure` helper** (audit P3-28).
- **`escape.ts`** (audit P3-29).
- **`test:all` / `typecheck:all`** scripts in root `package.json`.

---

## Migration

Do this as **one dedicated commit**, only after the practice module is
committed, with `npm test`, `(cd client && npm test)`, and both
typechecks green immediately before and immediately after. `git mv` every
move so history follows.

1. **Prep**
   - `git add -A && git commit` the practice module (or stash-free clean
     tree). The reorg diff must stand alone.
   - Add `test:all`, `typecheck`, `typecheck:all` scripts. Verify green.

2. **Docs** — ✅ done 2026-08-28.
   - Guides moved to `docs/`, the 2 plans to `docs/history/` (lowercase).
   - Links fixed in `README.md`, the moved docs, `hcv-soap.ts`, and the
     `start*.sh` echoes.
   - The `Spec (…)` citations in test-file comments still say
     `CONVERSION-PLAN.md` etc. — prose only, sweep opportunistically.

3. **Scripts**
   - `git mv` the `*.sh` + `lib-node-runtime.sh` → `scripts/`.
   - Update: `start-native.sh` / `run-server.sh` `source` lines
     (`"$APP_DIR/lib-node-runtime.sh"` → `"$APP_DIR/scripts/lib-node-runtime.sh"`
     — or keep them resolving relative to their own dir),
     the launchd plist heredoc in `start-native.sh`
     (`${APP_DIR}/run-server.sh` → `${APP_DIR}/scripts/run-server.sh`),
     `scripts/make-bundle.sh` (paths still relative to repo root — check),
     and the `.command` shims at root (`./start-native.sh` →
     `./scripts/start-native.sh`).
   - Test: run `start-native.sh` on a Mac end to end (launchd load, port
     comes up, stop unloads). This is the highest-risk step — the
     entry-point contract users depend on.

4. **Server** (do in this order; typecheck after each folder)
   - `mkdir server/platform` — `git mv` `services/{crypto,sessions,audit,env-config,endpoints,backoff,storage}.ts`,
     `middleware/auth.ts`, `db/db.ts`. Add `escape.ts`, `poller.ts`.
   - `server/practice/` — `git mv` `services/{patients,appointments,exam-requests,eligibility,reminders,practice-queue}.ts`
     (→ `queue.ts`), `db/practice.ts` (→ `types.ts`).
   - `server/receipts/` — `services/{upload-queue,storage… }`, split
     `receipts.ts` route.
   - `server/integrations/{claude,wave,google,ohip,oauth}/` — move, then
     split `wave.ts` and dedupe the OAuth routers.
   - `server/http/` — `app.ts`, `routes/{auth,settings}.ts`, new
     `error-handler.ts`.
   - Rewrite imports. `tsconfig.json` `include` is `server/**/*` already —
     no change. Update `Dockerfile` `COPY --from=build /app/server` (path
     unchanged) and the static-SPA path in `app.ts` if `app.ts` moved
     depth (it does: `server/http/app.ts` → `'..','..','client','dist'`).
   - `server/index.ts` import paths for `createApp` and the two pollers.

5. **Server tests** — `git mv` into `tests/{platform,receipts,practice,integrations,http}/`;
   fix `import` paths (they reach into `../../server/...`). `vitest.config.ts`
   `include: ['tests/**/*.test.ts']` already recurses — no change.

6. **Client**
   - `client/src/{shared,auth,receipts,practice}/` — `git mv` pages +
     components together per domain.
   - Split `api/client.ts` into `api/{auth,receipts,practice,settings}.ts`
     + a barrel; update every import.
   - `App.tsx` route imports.
   - `client/tests/` mirror-move; fix imports and `fixtures.ts` path.

7. **Verify**
   - `npm run test:all` + `npm run typecheck:all` green.
   - `npm run build` produces `client/dist`.
   - `npm run demo` boots; walk the 5-minute tour in `docs/DEMO.md`.
   - `scripts/make-bundle.sh` produces a zip that unzips and starts.
   - Update this file's [Current structure](#current-structure) to match,
     and delete this Migration section's "not yet done" note.
