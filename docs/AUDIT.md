# Codebase Audit — Viewpoint Receipts

**Date:** 2026-08-28
**Scope:** whole repository at `main` (receipts pipeline + the uncommitted practice-automation module)
**Baseline at audit time:** server 363 tests green, client 191 tests green, both projects typecheck clean.

This document is a point-in-time assessment. Findings are grouped by theme
and ranked **P0 → P3** within each. Each finding names the file(s), the
concrete failure it enables, and a suggested fix. Nothing here has been
changed — it is input for planning.

> **Context that shapes every finding:** the app now stores **personal
> health information** (names, DOB, contact details, Ontario health card
> numbers) and is governed by Ontario's PHIPA. It also still assumes a
> single trusted operator on a machine they control, often over plain-HTTP
> LAN. Several trade-offs that were fine for expense receipts are not fine
> for PHI, and that is where the P0s cluster.

---

## 1. Security & privacy (patient data)

### P0-1 — Raw exam-request email body is stored and served in plaintext

- **Where:** `server/services/exam-requests.ts` (`createFromGmailMessage`
  writes `body_snippet` — up to 2000 chars of the raw email — as
  plaintext); `server/routes/practice.ts` (`toExamRequestDto` returns
  `body_snippet` to the client); `client/src/pages/Inbox.tsx:339` renders
  it.
- **Why it matters:** exam-request emails routinely contain the health
  card number, DOB, and full name in the body text. `extracted_json` is
  encrypted (good), but `body_snippet` is a second, **unencrypted** copy
  of the same PHI — on disk in `receipts.db`, in every API response for
  that request, and in the browser (and its service-worker cache, see
  P0-6). `SECURITY.md` states "extracted email content is encrypted too";
  the *source* content it was extracted from is not.
- **Fix:** encrypt `body_snippet` at rest exactly as `extracted_json` is
  (`encrypt()` on write, tolerant decrypt on read). Drop it from the
  default DTO; expose it only through a dedicated, audited endpoint
  (`GET /exam-requests/:id/source`) that writes a `patient.read`-style
  audit entry, mirroring `readHealthCard()`. Add a regression test.

### P0-2 — Nothing prevents health card numbers crossing the network in cleartext

- **Where:** `server/app.ts`, `server/services/sessions.ts`
  (`sessionCookieOptions` sets `secure` only when `req.secure`).
- **Why it matters:** the documented and common deployment
  (`start-native.command`) serves plain HTTP on a LAN. In
  conformance/production OHIP mode the app will send and receive health
  card numbers over that connection with no transport encryption, and the
  session cookie is not `Secure`. The docs *ask* the operator to turn on
  HTTPS; nothing *enforces* it.
- **Fix:** add a startup guard in `server/index.ts` / `createApp`: if
  `OHIP_HCV_MODE` is not `mock` **or** the `patients` table is non-empty,
  refuse to start unless either (a) `GOOGLE_REDIRECT_URI` / an explicit
  `PUBLIC_HTTPS_URL` is https, or (b) `ALLOW_INSECURE_PHI=1` is set
  (logged loudly on every boot). Surface the state in `GET /api/settings`
  so the UI can show a blocking banner.

### P0-3 — `trust proxy: 1` is unconditional

- **Where:** `server/app.ts:34` (`app.set('trust proxy', 1)`).
- **Why it matters:** when the app runs with **no** reverse proxy (the
  LAN `start-native` case), any client that can reach port 3000 can send
  `X-Forwarded-For` to forge `req.ip` — which is what the `audit_log`
  records for every login, PHI read, eligibility check, and message sent
  (PHIPA integrity), and `X-Forwarded-Proto` to flip the cookie `Secure`
  bit. Trusting a hop that isn't there is a spoofing primitive.
- **Fix:** set `trust proxy` only when `process.env.TRUST_PROXY === '1'`
  (or `BEHIND_PROXY`), documented alongside the HTTPS setup. Default off.

### P1-4 — Eligibility history is cascade-deleted with the patient; audit log has no integrity guarantee

- **Where:** `server/db/migrations/003-practice.sql`
  (`eligibility_checks.patient_id … ON DELETE CASCADE`);
  `server/services/patients.ts` (`deletePatient` = hard `DELETE`);
  `server/services/audit.ts` (append-by-convention only).
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
  `verifyPassword`), `server/middleware/auth.ts` (throttle only wired
  into `/login`).
- **Why it matters:** an authenticated session can brute the current
  password through this route with no lockout. Low severity (needs a live
  session) but it's the same scrypt path `/login` protects.
- **Fix:** run `isRateLimited`/`recordFailedLogin` on this route too.

### P3-9 — Dead `Authorization: Bearer` code path

- **Where:** `server/middleware/auth.ts` (`extractToken`).
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
  applied by hand and any miss becomes a socket that never responds.
- **Fix:** add a terminal error handler + JSON 404, and either an
  `asyncHandler` wrapper or the `express-async-errors` shim. (Express 5,
  which handles this natively, is a larger move — see 4-24.)

### P1-11 — A transient failure at approval strands the request in `approved`

- **Where:** `server/services/practice-queue.ts`
  (`approveExamRequest` → on invoice error calls
  `recordFailure(id, err, true, MAX_RETRIES)`, which leaves `status =
  'approved'`), and `processQueue` never re-drives `approved` rows.
- A Wave blip during approval leaves the request stuck with an error and
  no retry — the operator must notice and re-approve, but the approve
  route rejects anything not in `drafted`.
- **Fix:** add an `approved`-reprocessing step to `processQueue`, or a
  `POST /exam-requests/:id/retry-approval`, and document which path is
  authoritative.

### P2-12 — Fuzzy patient/appointment matches silently create duplicates

- **Where:** `server/services/patients.ts` (`findMatchingPatient` — exact
  email or exact case-insensitive name, else a brand-new patient);
  `server/services/practice-queue.ts` (`draftOne`).
- "Robert" vs "Bob", an accented surname, a new email address → a second
  patient record that then accrues its own appointments, invoices, and
  eligibility history. Nothing surfaces the near-match to the operator.
- **Fix:** when a non-exact candidate exists (trigram / normalized name),
  route the request to `needsAttention` with "possible match: <name>"
  instead of creating.

### P2-13 — `resolveAppointment` trusts the server clock as the clinic timezone; `reminders.ts` uses `CLINIC_TIMEZONE`

- **Where:** `server/services/practice-queue.ts` (`resolveAppointment`
  parses `"${date}T${time}:00"` in server-local time) vs.
  `server/services/reminders.ts` (`formatAppointmentTime` uses
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
- **Fix:** bump `Dockerfile` (build and runtime stages) to `node:22` /
  `node:22-slim`; note the floor in `docs/DEPLOYMENT.md`.

### P1-18 — CI publishes a user-facing release with no test gate

- **Where:** `.github/workflows/bundle.yml` — every push to `main` runs
  `make-bundle.sh` and uploads `viewpoint-receipts-bundle.zip` to the
  `latest` GitHub release. No `npm test`, no `tsc`, no client tests, no
  `npm run build` check.
- A broken commit ships straight to the person who double-clicks
  `start-native.command`.
- **Fix:** add `typecheck` + `test` (both suites) + `build` jobs and make
  `bundle` `needs:` them.

### P2-19 — `npm test` at the root silently skips the client suite

- **Where:** root `package.json` (`"test": "vitest run"` → `tests/**`
  only); `client/package.json` has its own. Documented, but a contributor
  or agent running `npm test` gets a false green.
- **Fix:** add `"test:all"`, `"typecheck"`, `"typecheck:all"` scripts;
  reference them in `AGENTS.md`.

### P2-20 — Stale `allowScripts` version pins

- **Where:** root `package.json` `allowScripts:
  {"better-sqlite3@11.10.0": true, "esbuild@0.28.2": true}` while the
  dependency is `better-sqlite3@^13.0.3`; `client/package.json` pins
  `esbuild@0.25.12`. Version-keyed allow-script entries rot on every
  bump and silently stop matching.
- **Fix:** reconcile to the installed versions now; add a note to the
  upgrade checklist in `AGENTS.md` to update them on any bump of these
  two.

### P2-21 — `claude-haiku-4-5-20251001` carries a date suffix

- **Where:** `server/services/claude.ts:16` (`VALIDATION_MODEL`).
- Current Anthropic model IDs for the 4.5 / 5 families are used **bare**
  (`claude-haiku-4-5`); the date-suffixed form is not the documented
  identifier and risks a 400 as snapshots age. `EXTRACTION_MODEL =
  'claude-sonnet-5'` is correct.
- **Fix:** use `claude-haiku-4-5`. If snapshot-pinning is wanted for
  reproducibility, do it deliberately for *both* models and note why.
  Consider the official `@anthropic-ai/sdk` (typed errors, retries) —
  though the repo's deliberate "bare fetch everywhere" policy for Wave /
  Google / OHIP is a legitimate reason to keep it as is; if so, say so in
  `AGENTS.md`.

### P3-22 — `client/tsconfig.json` disables unused-symbol checks

`noUnusedLocals: false`, `noUnusedParameters: false` — dead code
accumulates with no signal. Turn on (server tsconfig is stricter).

### P3-23 — `.DS_Store` not in `.gitignore`

`.DS_Store` files are in the tree; add the line.

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

- **Where:** `server/services/upload-queue.ts` and
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

## 5. Structure & navigability (input for the reorg)

**Symptoms:** the repo root has ~35 entries (8 markdown guides + ~10
shell / `.command` scripts + configs). `server/services/` holds 25 files
spanning four domains. `client/src/pages` and `components` interleave the
receipts and practice features. `docs/history/conversion-plan.md` carries
a file tree that no longer matches reality; there is no single
architecture map.

The **target structure** and an **ordered migration** live in
[`../INDEX.md`](../INDEX.md). Summary of the moves:

| Area | Now | Target |
|---|---|---|
| Guides | 8 `*.md` at root | `docs/` (+ `docs/history/` for the two plans) |
| Shell impl | `start-native.sh`, `run-server.sh`, `lib-node-runtime.sh`, `stop*.sh` at root | `scripts/` — but the `.command` shims stay at root (users double-click them; `GETTING-STARTED` names them) and the launchd plist path + sibling `source` lines move in lockstep |
| Server platform | `db/`, `middleware/auth.ts`, `services/{crypto,audit,sessions,env-config,endpoints,backoff}.ts` | `server/platform/` |
| Server domains | `services/*` mixed | `server/receipts/`, `server/practice/` |
| Server integrations | `services/{wave*,google*,gmail,claude,ohip/}` | `server/integrations/{wave,google,ohip,claude}/` |
| Server HTTP | `app.ts`, `routes/` | `server/http/` |
| Client | flat `pages/` + `components/` | `client/src/{receipts,practice,shared}/` |
| Tests | `tests/`, `client/tests/` | mirror the new source tree |

**Risk note:** this is a large mechanical change (100+ import rewrites
plus `tsconfig` includes, `vitest` includes, `Dockerfile` COPY paths,
`app.ts` static path, `make-bundle.sh`, the launchd plist). It should be
its own commit, done **after** the current practice-module work is
committed, with `npm run test:all` + `typecheck:all` green before and
after. Doing it on top of ~7,000 uncommitted lines makes both changes
unreviewable and hard to revert.

---

## 6. Testing gaps

- **P1:** no CI job runs either test suite (see P1-18).
- **P2:** no end-to-end test of `approveExamRequest` against the demo
  mock (happy path + Wave-failure path from P1-11). `tests/demo-mode.test.ts`
  exists but is narrower.
- **P2:** no regression test asserting a health card number / raw email
  body never appears in an API response (would lock in P0-1's fix and
  guard `toPatientDto` / `toExtractionDto`).
- **P3:** `client/tests` has good page coverage; add one for `Inbox`'s
  "show email" toggle once `body_snippet` is gated.
- **Keep:** `tests/security.test.ts` covers auth, sessions, throttle, and
  the `/images` gate well.

---

## 7. Suggested order of operations

1. **P0-1** (encrypt `body_snippet`, gate it) — smallest change, largest
   exposure reduction, and it's PHI already on disk today.
2. **P0-2 / P0-3** (HTTPS start-guard, conditional `trust proxy`) — before
   any real patient data.
3. **P1-18** (CI test gate) — cheap, stops regressions shipping.
4. **P1-10 / P1-11** (error handler, stuck-`approved` retry) — correctness.
5. **P1-4 / P1-5 / P1-6** (retention, ministry debounce, SW cache) — the
   remaining PHI-handling items.
6. **P1-17, P2-19, P2-20, P2-21** — the drift cluster, one small PR.
7. **The reorg** (§5) — as its own commit, after the above land and the
   practice module is committed.
8. **§4 dedup** (OAuth flow, `wave.ts` split, poller helper) — folds
   naturally into the reorg commit or follows it.
