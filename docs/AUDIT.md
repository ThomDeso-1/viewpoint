# Codebase Audit — Viewpoint Receipts

**Date:** 2026-08-28
**Scope:** whole repository at `main` (receipts pipeline + the uncommitted practice-automation module)
**Baseline at audit time:** server 363 tests green, client 191 tests green, both projects typecheck clean.

This document is a point-in-time assessment. Findings are grouped by theme
and ranked **P0 → P3** within each. Each finding names the file(s), the
concrete failure it enables, and a suggested fix.

**Progress since the audit (2026-08-28):**
- §5 structure findings — **resolved** (docs + code reorg; paths below
  reflect the new layout).
- **P0-1, P0-2, P0-3 — resolved.** See the ✅ notes on each.
- `test:all` / `typecheck:all` scripts now exist (part of P2-19).
- Everything else is still open.

> **Context that shapes every finding:** the app now stores **personal
> health information** (names, DOB, contact details, Ontario health card
> numbers) and is governed by Ontario's PHIPA. It also still assumes a
> single trusted operator on a machine they control, often over plain-HTTP
> LAN. Several trade-offs that were fine for expense receipts are not fine
> for PHI, and that is where the P0s cluster.

---

## 1. Security & privacy (patient data)

### P0-1 — Raw exam-request email body is stored and served in plaintext

- **Where:** `server/practice/exam-requests.ts` (`createFromGmailMessage`
  writes `body_snippet` — up to 2000 chars of the raw email — as
  plaintext); `server/routes/practice.ts` (`toExamRequestDto` returns
  `body_snippet` to the client); `client/src/practice/Inbox.tsx:339` renders
  it.
- **Why it matters:** exam-request emails routinely contain the health
  card number, DOB, and full name in the body text. `extracted_json` is
  encrypted (good), but `body_snippet` is a second, **unencrypted** copy
  of the same PHI — on disk in `receipts.db`, in every API response for
  that request, and in the browser (and its service-worker cache, see
  P0-6). `SECURITY.md` states "extracted email content is encrypted too";
  the *source* content it was extracted from is not.
- **✅ Fixed 2026-08-28.** `body_snippet` is now `encrypt()`-ed on write
  (tolerant decrypt on read, like `extracted_json`); dropped from the
  exam-request DTO (replaced by `has_source: boolean`); reachable only via
  `GET /api/practice/exam-requests/:id/source`, which writes an
  `exam_request.source_read` audit entry. `Inbox.tsx` fetches it on
  demand. Tests: `tests/practice/routes.test.ts` "email source is PHI",
  `client/tests/practice/Inbox.test.tsx`. **Not migrated:** rows written
  before this stay plaintext until re-received (same as `extracted_json`
  did) — a one-off re-encrypt pass could be added if it matters.

### P0-2 — Nothing prevents health card numbers crossing the network in cleartext

- **Where:** `server/app.ts`, `server/platform/sessions.ts`
  (`sessionCookieOptions` sets `secure` only when `req.secure`).
- **Why it matters:** the documented and common deployment
  (`start-native.command`) serves plain HTTP on a LAN. In
  conformance/production OHIP mode the app will send and receive health
  card numbers over that connection with no transport encryption, and the
  session cookie is not `Secure`. The docs *ask* the operator to turn on
  HTTPS; nothing *enforces* it.
- **✅ Fixed 2026-08-28.** `server/platform/phi-guard.ts` →
  `assertSafeForPhi()`, called from `server/index.ts` after
  `createApp()`. Refuses to boot when `OHIP_HCV_MODE !== 'mock'` **or**
  the `patients` table is non-empty, unless HTTPS is signalled
  (`APP_PUBLIC_URL` / a redirect URI is https, or `TRUST_PROXY=1`) or
  `ALLOW_INSECURE_PHI=1` (loud warning every boot). Skipped in demo mode.
  Tests: `tests/platform/phi-guard.test.ts`. **Still worth doing:**
  surface the state in `GET /api/settings` for a UI banner.

### P0-3 — `trust proxy: 1` is unconditional

- **Where:** `server/app.ts:34` (`app.set('trust proxy', 1)`).
- **Why it matters:** when the app runs with **no** reverse proxy (the
  LAN `start-native` case), any client that can reach port 3000 can send
  `X-Forwarded-For` to forge `req.ip` — which is what the `audit_log`
  records for every login, PHI read, eligibility check, and message sent
  (PHIPA integrity), and `X-Forwarded-Proto` to flip the cookie `Secure`
  bit. Trusting a hop that isn't there is a spoofing primitive.
- **✅ Fixed 2026-08-28.** `server/app.ts` sets `trust proxy` only when
  `TRUST_PROXY === '1'`. Documented in `.env.example` and `AGENTS.md`.
  Tests: `tests/platform/security.test.ts` "proxy trust (P0-3)".

### P1-4 — Eligibility history is cascade-deleted with the patient; audit log has no integrity guarantee

- **Where:** `server/db/migrations/003-practice.sql`
  (`eligibility_checks.patient_id … ON DELETE CASCADE`);
  `server/practice/patients.ts` (`deletePatient` = hard `DELETE`);
  `server/platform/audit.ts` (append-by-convention only).
- **Why it matters:** deleting a patient permanently erases the record of
  every OHIP check run against them — the exact thing PHIPA expects to be
  retained and auditable. `audit_log` rows can be edited or removed by
  anyone with DB access, and the docs promise an access trail.
- **Fix:** (a) change `eligibility_checks` FK to `ON DELETE SET NULL` and
  keep the rows; (b) make `deletePatient` a soft delete (`deleted_at`
  tombstone) so appointments/invoices/checks stay resolvable; (c) add a
  tamper-evident measure to `audit_log` — a per-row hash chain
  (`hash = SHA256(prev_hash || row)`) is cheap and detects edits/gaps;
  (d) document a retention period.

### P1-5 — No rate-limit / debounce on endpoints that hit the ministry or Claude

- **Where:** `server/routes/practice.ts`
  (`POST /patients/:id/check-eligibility`,
  `POST /appointments/:id/check-eligibility`,
  `POST /exam-requests/poll`); `server/routes/settings.ts`
  (`POST /validate-claude-key`, `POST /ohip/test`).
- **Why it matters:** each eligibility call discloses a health card number
  to the Ministry of Health; PHIPA data-minimization and MOH conformance
  rules both discourage redundant queries. Today a UI double-click, or a
  script, fires unlimited real checks. `poll` fans out to the Claude API
  (cost + PHI egress) with no ceiling.
- **Fix:** reuse a recent (`< 24h`) `eligibility_checks` row instead of
  re-querying unless `?force=true`; add a per-process token-bucket on the
  ministry-facing and Claude-facing routes; add a confirm step in the UI
  for a live check.

### P1-6 — Service worker caches PHI in the browser

- **Where:** `client/vite.config.ts` — `runtimeCaching`: `/api/*`
  NetworkFirst (50 entries / 5 min), `/images/*` CacheFirst (200 / 30
  days).
- **Why it matters:** `GET /api/practice/patients`,
  `/api/practice/exam-requests`, `/api/practice/audit` responses (names,
  emails, DOB, masked cards, the plaintext `body_snippet` from P0-1) and
  receipt images are written to Cache Storage on the device. On a shared
  or lost iPhone that is PHI at rest, outside the app's auth and audit.
- **Fix:** exclude `/api/practice/**` (and ideally all of `/api/**`) from
  `runtimeCaching`; drop the image cache to a short TTL or remove it. If
  offline read of receipts is a real requirement, scope it and document
  it in `SECURITY.md`.

### P2-7 — No supported path to back up the encryption key safely

- **Where:** `scripts/backup.sh` (backs up `data/` only, never `.env`);
  `SECURITY.md` / `docs/DEPLOYMENT.md` (say "keep the key separate" but
  give no mechanism).
- **Why it matters:** following the documented backup gives an
  unrecoverable archive (no `DATA_ENCRYPTION_KEY`). The obvious
  workaround — "copy the whole folder" — puts key and ciphertext
  together, the exact thing the docs warn against. There is no middle
  path.
- **Fix:** `backup.sh` gains an opt-in `KEY_BACKUP_DEST` that writes just
  the `DATA_ENCRYPTION_KEY` line to a separate location (different bucket
  / passphrase); document a concrete key-escrow step.

### P2-8 — `change-password` is not throttled

- **Where:** `server/routes/auth.ts` (`POST /change-password` →
  `verifyPassword`), `server/platform/auth.ts` (throttle only wired
  into `/login`).
- **Why it matters:** an authenticated session can brute the current
  password through this route with no lockout. Low severity (needs a live
  session) but it's the same scrypt path `/login` protects.
- **Fix:** run `isRateLimited`/`recordFailedLogin` on this route too.

### P3-9 — Dead `Authorization: Bearer` code path

- **Where:** `server/platform/auth.ts` (`extractToken`).
- The client only ever authenticates by cookie. The bearer path is
  verified identically so it is not a vulnerability, but it is untested
  surface. Remove it, or document it as the intentional API-testing seam.

### What's already right (keep)

scrypt + per-password salt; random session tokens stored only as SHA-256;
`readHealthCard()` as the single audited decryption doorway; `toPatientDto`
masking; `extracted_json` / `raw_response_enc` / OAuth tokens encrypted
with AES-256-GCM; OAuth callbacks protected by single-use `state`; login
throttle; `/images` moved behind auth; mock HCV results stamped `mode:
'mock'` end to end.

---

## 2. Correctness gaps

### P1-10 — No centralized Express error handler; async rejections can hang

- **Where:** `server/app.ts` (no `app.use((err,…))`, no 404 handler).
- Express 4 does not forward rejected promises from `async` route
  handlers. Most handlers have local `try/catch`, but the pattern is
  applied by hand and any miss becomes a socket that never responds
  (e.g. `POST /patients/:id/check-eligibility` when the stored card
  ciphertext is corrupt — `decrypt()` throws outside any catch).
- **✅ Fixed 2026-08-28.** `server/platform/http.ts` — `apiNotFound`
  (JSON 404 for unknown `/api` routes, mounted before the SPA catch-all)
  and `errorHandler` (terminal, logs with route, returns a generic 500 —
  never the error text). `import 'express-async-errors'` in `app.ts`
  routes async rejections to it. Tests:
  `tests/http/error-handling.test.ts`.

### P1-11 — A transient failure at approval strands the request in `approved`

- **Where:** `server/practice/queue.ts`
  (`approveExamRequest` → on invoice error calls
  `recordFailure(id, err, true, MAX_RETRIES)`, which leaves `status =
  'approved'`), and `processQueue` never re-drives `approved` rows.
- A Wave blip during approval leaves the request stuck with an error and
  no retry — the operator must notice and re-approve, but the approve
  route rejects anything not in `drafted`.
- **✅ Fixed 2026-08-28.** `processQueue` gains a `retryApproved()` step
  that re-runs the commit for `approved` rows carrying an error, backing
  off each attempt. `commitInvoice()` is now **resumable** — it skips
  invoice creation if `wave_invoice_id` is already set and returns early
  if the invoice is `approved`/`sent`, so a retry never double-books.
  `retryExamRequest()` keeps an `approved` row `approved` (rather than
  rewinding to `extracted`), and the Inbox shows a retry button for
  `approved` + error. Tests: `tests/practice/queue.test.ts` "recovers a
  request stranded in approved".

### P2-12 — Fuzzy patient/appointment matches silently create duplicates

- **Where:** `server/practice/patients.ts` (`findMatchingPatient` — exact
  email or exact case-insensitive name, else a brand-new patient);
  `server/practice/queue.ts` (`draftOne`).
- "Robert" vs "Bob", an accented surname, a new email address → a second
  patient record that then accrues its own appointments, invoices, and
  eligibility history. Nothing surfaces the near-match to the operator.
- **Fix:** when a non-exact candidate exists (trigram / normalized name),
  route the request to `needsAttention` with "possible match: <name>"
  instead of creating.

### P2-13 — `resolveAppointment` trusts the server clock as the clinic timezone; `reminders.ts` uses `CLINIC_TIMEZONE`

- **Where:** `server/practice/queue.ts` (`resolveAppointment`
  parses `"${date}T${time}:00"` in server-local time) vs.
  `server/practice/reminders.ts` (`formatAppointmentTime` uses
  `CLINIC_TIMEZONE`).
- Two code paths, two different notions of "the clinic's timezone". On a
  server whose clock isn't the clinic's, calendar matching silently
  drifts by the offset while reminders stay correct.
- **Fix:** resolve `requested_date`/`requested_time` against
  `CLINIC_TIMEZONE` too (`Intl.DateTimeFormat` parts, or a tz lib), and
  make `CLINIC_TIMEZONE` a required setting.

### P2-14 — Literal routes registered after parameterized ones

- **Where:** `server/routes/receipts.ts` — `GET /queue/status` and
  `GET /:id/duplicates` sit after `GET /:id`; works only because `/:id`
  can't match two segments. `retry-all` similarly. (Already noted in
  `docs/history/upgrade-plan.md`.)
- **Fix:** move all literal paths above the `/:id` block. Same sweep for
  `practice.ts` (already partly done — `exam-requests/counts` is above
  `:id`).

### P3-15 — `GET /api/receipts` loads every row and filters in JS

- **Where:** `server/routes/receipts.ts` (`selectAll.all()` then JS
  `.filter`/group), despite `idx_receipts_status` / `idx_receipts_month`.
- Irrelevant at single-user volume; note it so it isn't copied into a
  path that matters.

### P3-16 — `express.json()` runs for multipart upload routes

Harmless (multer owns the body), but the ordering means every request
pays JSON parsing. Mount `express.json()` only on `/api` sub-routers that
need it, or accept it.

---

## 3. Tech debt & tech drift

### P1-17 — Dockerfile is Node 20; `better-sqlite3` needs Node 22

- **Where:** `Dockerfile` (`FROM node:20`), `lib-node-runtime.sh`
  (`NODE_MIN_MAJOR=22`, comment: "older Node ABI builds cause a silent
  crash rather than a clean error").
- The native path is pinned to 22; the container path ships 20. Either
  the Docker build is on borrowed time or the native floor is
  over-strict — they must agree.
- **✅ Fixed 2026-08-28.** `Dockerfile` build + runtime stages →
  `node:22` / `node:22-slim`. CI already pins Node 22. Floor noted in
  `docs/DEPLOYMENT.md`.

### P1-18 — CI publishes a user-facing release with no test gate

- **Where:** `.github/workflows/bundle.yml` — every push to `main` runs
  `make-bundle.sh` and uploads `viewpoint-receipts-bundle.zip` to the
  `latest` GitHub release. No `npm test`, no `tsc`, no client tests, no
  `npm run build` check.
- A broken commit ships straight to the person who double-clicks
  `start-native.command`.
- **✅ Fixed 2026-08-28.** Renamed `.github/workflows/ci.yml`. A `verify`
  job (Node 22, `npm ci` both projects, `typecheck:all` + `test:all` +
  `build`) runs on every push and PR; the `bundle` job now `needs:
  verify` and is gated to `push` on `main`.

### P2-19 — `npm test` at the root silently skips the client suite

- **Where:** root `package.json` (`"test": "vitest run"` → `tests/**`
  only); `client/package.json` has its own. Documented, but a contributor
  or agent running `npm test` gets a false green.
- **Fix:** add `"test:all"`, `"typecheck"`, `"typecheck:all"` scripts;
  reference them in `AGENTS.md`.

### P2-20 — Stale `allowScripts` version pins

- **Where:** root `package.json` `allowScripts:
  {"better-sqlite3@11.10.0": true, "esbuild@0.28.2": true}` while the
  dependency is `better-sqlite3@^13.0.3`. On **npm 11** (the script
  allowlist) the stale key means `better-sqlite3`'s native build is
  skipped with only a warning on a clean `npm ci` — every server test
  then crashes on `require('better-sqlite3')`. (npm ≤10 ignores the key
  and runs scripts, so Docker / current CI images are unaffected — but
  the repo owner's machine is on npm 11.)
- **✅ Fixed 2026-08-28.** Both `package.json` files now use name-only
  keys (`"better-sqlite3": true`), which don't rot on a version bump.

### P2-21 — `claude-haiku-4-5-20251001` carries a date suffix

- **Where:** `server/integrations/claude.ts:16` (`VALIDATION_MODEL`).
- Current Anthropic model IDs for the 4.5 / 5 families are used **bare**
  (`claude-haiku-4-5`); the date-suffixed form is not the documented
  identifier and risks a 400 as snapshots age. `EXTRACTION_MODEL =
  'claude-sonnet-5'` is correct.
- **✅ Fixed 2026-08-28.** `VALIDATION_MODEL = 'claude-haiku-4-5'` (bare).
  The bare-`fetch` choice (over `@anthropic-ai/sdk`) is deliberate and
  consistent with Wave / Google / OHIP — recorded in `AGENTS.md` §6.

### P3-22 — `client/tsconfig.json` disables unused-symbol checks

`noUnusedLocals: false`, `noUnusedParameters: false` — dead code
accumulates with no signal. Turn on (server tsconfig is stricter).

### P3-23 — `.DS_Store` not in `.gitignore`

`.DS_Store` files are in the tree; add the line.

### P3-23b — `uuid@10` has a moderate advisory (GHSA-w5hq-g745-h8pq)

`npm audit` flags `uuid <11.1.1` — a missing buffer bounds check in v3/v5/v6
when a caller passes its own `buf`. This codebase only ever calls bare
`v4()` / `uuid()`, so it is **not reachable**, but bump to `uuid@11`+ on
the next dependency pass to clear the audit. Surfaced 2026-08-28 when
`express-async-errors` was added (P1-10) triggered a fresh `npm audit`.

### P3-24 — Framework currency

`express@4` (Express 5 GA — native async errors, would resolve P1-10),
`multer@1.4.5-lts.1` (maintenance-only; 2.x exists). Both are deliberate
"if it works" holds; record them so the decision is visible, revisit
yearly.

---

## 4. Redundancy & over-complexity

### P2-25 — The two OAuth route files are ~120 lines of copy-paste

- **Where:** `server/routes/google.ts` and `server/routes/wave-oauth.ts`
  — identical `issueState` / `consumeState` / `pruneStates` /
  `resetPendingStates`, and a byte-for-byte identical `renderResult`
  HTML template (only "Google" ↔ "Wave" differ).
- **Fix:** `server/integrations/oauth/state-store.ts` (the pending-state
  map) + `server/integrations/oauth/callback.ts` (shared result page +
  a `makeCallbackRouter({ provider, exchange })` factory). Each provider
  keeps only its `buildAuthorizeUrl` / `exchangeCode`.

### P2-26 — `wave.ts` is 691 lines mixing five concerns

- Transport + `WaveAPIError` taxonomy, expense transactions, invoices,
  customers, and reference-data fetches (products / accounts / taxes) all
  in one module.
- **Fix:** `integrations/wave/{transport,expenses,invoices,customers,reference}.ts`
  with a barrel `index.ts`. Pure mechanical split; tests should move with
  the code they cover.

### P2-27 — Queue scaffolding duplicated between the two pollers

- **Where:** `server/receipts/upload-queue.ts` and
  `practice-queue.ts` — `running` guard, `pollTimer`, `triggerQueue`,
  `startPolling`, `stopPolling` are copy-pasted (backoff is already
  shared via `backoff.ts`, good).
- **Fix:** `server/platform/poller.ts` → `makePoller({ intervalMs, pass
  }): { trigger, start, stop }`.

### P3-28 — `recordFailure` state machine written three times

`exam-requests.ts`, `reminders.ts`, and inline in `upload-queue.ts` each
re-implement "retryable? bump count; count ≥ max? → failed/needsAttention".
Extract `applyFailure(row, { retryable, maxRetries })`.

### P3-29 — Escaping helpers duplicated

`escapeXml` in `hcv-soap.ts`, HTML-escape in `google.ts` and
`wave-oauth.ts`. One `server/platform/escape.ts`.

### P3-30 — Regex "XML parsing" in the HCV client

`firstTagValue` / `extractFault` in `hcv-soap.ts` parse the ministry
response with regexes — fragile against CDATA, attributes containing `>`,
and repeated namespaced tags. Acceptable while the whole SOAP path is
flagged unverified, but replace with a real parse (`xmlbuilder2` is
already a dependency) before conformance testing.

---

## 5. Structure & navigability — ✅ done 2026-08-28

The docs reorg (→ `docs/`) and the code reorg (`server/` and `client/`
regrouped by domain: `platform/` `receipts/` `practice/` `integrations/`,
tests mirrored) landed as their own commit. `typecheck:all` + `test:all`
green before and after. The current map is [`../INDEX.md`](../INDEX.md).

The reorg was kept to **moves + import rewrites only**. The structural
refactors it enables — deduping the two OAuth route files, splitting the
691-line `wave.ts`, extracting a shared `makePoller`, the terminal error
handler (P1-10), splitting `client/src/shared/api.ts` — are listed as
[deferred follow-ups](../INDEX.md#deferred-follow-ups) and in §4 below,
each its own small commit.

---

## 6. Testing gaps

- **P1:** no CI job runs either test suite (see P1-18).
- **P2:** no end-to-end test of `approveExamRequest` against the demo
  mock (happy path + Wave-failure path from P1-11). `tests/demo-mode.test.ts`
  exists but is narrower.
- ~~**P2:** regression test that the raw email body never appears in a
  DTO~~ — ✅ added (`tests/practice/routes.test.ts`). A broader
  "no health card number in any response" sweep would still be worth it.
- ~~**P3:** `Inbox` "show email" toggle test~~ — ✅ added.
- **Keep:** `tests/security.test.ts` covers auth, sessions, throttle, and
  the `/images` gate well.

---

## 7. Suggested order of operations

1. ~~**P0-1** (encrypt `body_snippet`, gate it)~~ — ✅ done.
2. ~~**P0-2 / P0-3** (HTTPS start-guard, conditional `trust proxy`)~~ — ✅ done.
3. ~~**P1-18** (CI test gate) + P2-20 (allowScripts)~~ — ✅ done.
4. ~~**P1-10 / P1-11** (error handler, stuck-`approved` retry)~~ — ✅ done.
5. **P1-4 / P1-5 / P1-6** (retention, ministry debounce, SW cache) — the
   remaining PHI-handling items. ← next
6. ~~**P1-17, P2-21** — Dockerfile Node 22, model ID~~ — ✅ done. (P2-19 done.)
7. **The reorg** (§5) — ✅ done.
8. **§4 dedup** (OAuth flow, `wave.ts` split, poller helper) — now
   unblocked by the reorg; see
   [deferred follow-ups](../INDEX.md#deferred-follow-ups).
