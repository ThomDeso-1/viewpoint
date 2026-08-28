# AGENTS.md — working on Viewpoint Receipts

Instructions for anyone (human or AI agent) making changes here. Read this
before touching code. For *where things live*, see [`INDEX.md`](INDEX.md).
For *known problems*, see [`docs/AUDIT.md`](docs/AUDIT.md).

---

## 1. What this app is

A **self-hosted, single-user** web app for one Canadian optometry
practice. Two workflows share one Express server, one SQLite database, and
one React PWA:

1. **Receipts** (original) — photograph an expense receipt → Claude vision
   extracts vendor/date/total → operator reviews → a background queue
   posts it to **Wave** as an expense.
2. **Practice automation** (added later) — an exam-request email arrives →
   Claude extracts patient details → patient matched → Google Calendar
   event linked → **OHIP** eligibility checked → a **Wave** invoice and a
   **Gmail** reminder are drafted → the operator taps **Approve** once →
   the invoice is sent and the reminder is scheduled.

Both pipelines use the **same status-machine shape** on purpose:

```
receipts:  captured → extracted → reviewed  → uploaded
practice:  received  → extracted → drafted  → approved → completed
                              ↘ needsAttention      ↘ failed
```

Everything up to `reviewed` / `drafted` happens unattended on a 60-second
poll. **Nothing is sent to a patient, the ministry, or the books without
an explicit operator action.**

### The golden rules of this app

- **One human approval gate per pipeline.** Never add an automated path
  that emails a patient, submits a health card number to the ministry, or
  writes to Wave without the operator having tapped Approve (or the
  equivalent explicit action). Drafting is automatic; *committing* is not.
- **A mock OHIP result must never be mistakable for a real one.** Every
  `EligibilityResult` carries `mode` (`mock` / `conformance` /
  `production`); it is stored on the row and shown in the UI. Preserve
  that end to end.
- **Health card numbers have exactly one doorway.**
  `patients.readHealthCard(patientId, reason)` is the only function that
  returns a decrypted number, and it writes an audit row every time. Do
  not decrypt `health_card_enc` anywhere else. Hold the plaintext only for
  the duration of the one call that needs it; never write it back
  unencrypted.
- **Nothing leaves `patients.ts` as a raw row.** API responses go through
  `toPatientDto()` (masks the card) and `toExtractionDto()` (masks it in
  the extraction blob). If you add a field, decide its masking there.
- **Demo mode changes only base URLs.** `server/platform/endpoints.ts` is
  the *single* switch. Never add a per-service mock or a second toggle.

---

## 2. Architecture in one screen

```
iPhone / browser  ──HTTPS──▶  Express (server/)  ──▶  SQLite (data/receipts.db)
   React PWA (client/)                │                 receipt images (data/Receipts/)
                                      ├─▶ Claude API      (receipt + email extraction)
                                      ├─▶ Wave GraphQL     (expenses + invoices)
                                      ├─▶ Gmail API        (read exam requests, send reminders)
                                      ├─▶ Google Calendar  (mirror the schedule)
                                      └─▶ MOH HCV SOAP     (OHIP eligibility)  — mock by default
```

- **No ORM.** `better-sqlite3`, hand-written SQL, prepared statements.
  Row types in `server/db/db.ts` (receipts) and `server/practice/types.ts`
  (everything else).
- **No API-client SDKs.** Claude, Wave, Google, and OHIP are all called
  with bare `fetch` — a deliberate choice to keep the dependency list
  tiny. Each integration has its own `*APIError` / `GoogleAuthError` /
  `HcvError` class with an `isRetryable` getter that the queues read.
- **Two background pollers**, started only in `server/index.ts` (never in
  `createApp()`, so tests don't spawn timers):
  `server/receipts/upload-queue.ts` (Wave expenses) and
  `server/practice/queue.ts` (the whole exam-request pipeline).
- **Backoff is stored, not slept** (`server/platform/backoff.ts`): a
  failed row records `retry_count` + `updated_at`; each pass skips rows
  that aren't due. One flaky item never blocks the batch; a restart
  resumes the schedule.
- **Idempotency keys:** `receipts` → Wave `externalId:
  viewpoint-<id>`; `appointments.google_event_id` UNIQUE;
  `exam_requests.gmail_message_id` UNIQUE. Re-polling can only ever
  update, never duplicate.
- **Auth:** one password (scrypt + salt). Login mints a random 32-byte
  session token; only its SHA-256 is stored. The password is not a
  credential after login. `server/platform/auth.ts`.
- **Encryption at rest:** AES-256-GCM (`server/platform/crypto.ts`) under
  `DATA_ENCRYPTION_KEY`, generated once into `.env`. Encrypts health card
  numbers, OAuth tokens, raw OHIP responses, and the extraction blob.
- **Migrations:** numbered `server/db/migrations/NNN-*.sql`, each in a
  transaction, version tracked in `app_config.schema_version`. The runner
  is in `server/db/db.ts`.
- **Config:** everything is entered in the app (Setup wizard →
  Settings) and written to `.env` (mode 0600) by
  `server/platform/env-config.ts`. `.env.example` documents every key.
  `APP_PASSWORD` and a few others still act as env overrides.

---

## 3. Commands

```bash
npm install && (cd client && npm install)   # first time

npm run dev                # server :3000, client (Vite) :5173 with API proxy
npm run demo               # whole app against local fakes, no credentials — see docs/DEMO.md

npm test                   # SERVER tests only (vitest + supertest) — 363 at last audit
npm run test:client        # CLIENT tests (vitest + testing-library) — 191 at last audit
npm run test:all           # both suites
npm run typecheck:all      # both projects (tsc --noEmit)

npm run build              # builds client/dist (server runs from source via tsx)
```

> **`npm test` alone does NOT run the client suite** — use `npm run
> test:all`. Any change touching `client/` must have the client suite
> green; any change touching `server/` must have the server suite green. A
> change touching shared contracts (the `/api` shapes in
> `client/src/shared/api.ts` ↔ the route handlers) needs both.

---

## 4. Rules for changes

### Always

- **Match the surrounding code.** Snake_case DB columns mirrored exactly
  in row types; `| null` for every nullable column; JSON blobs typed as
  `TEXT` and parsed at the edge; heavy doc-comments explaining *why*.
- **Run the relevant test suite(s) and the typecheck before saying
  done.** State the actual result.
- **Add a test with the change.** The suite is the spec — test files cite
  the doc section they enforce (`Spec (CONVERSION-PLAN.md …)`).
- **Keep the two status machines legible against each other.** If you add
  a status, ask whether the other pipeline needs the mirror.
- **Put new outbound URLs in `server/platform/endpoints.ts`** with a
  `DEMO_PATHS` entry, or demo mode breaks.

### Never (without a very good, stated reason)

- Add an automated send/submit/commit that bypasses the approval gate.
- Decrypt `health_card_enc` outside `readHealthCard()`.
- Return a raw patient/extraction row from a route.
- Log a health card number, a full email body, or a decrypted OAuth
  token — including in `audit_log.detail` and in `console.error`.
- Add a second "is this real or mock" signal, or a per-service demo
  toggle.
- Introduce an API-client SDK or an ORM without raising it first.
- Widen `GMAIL_EXAM_REQUEST_QUERY`'s blast radius — every matched email
  goes to Claude.

### Database changes

1. New file `server/db/migrations/NNN-name.sql` (next number, 3 digits).
   Never edit an applied migration.
2. Each migration must be safe inside one transaction.
3. Update / add the row interface in `server/practice/types.ts` (or
   `db.ts`).
4. Existing installs may sit at any prior version — write additive SQL
   (`ADD COLUMN`, new tables); avoid destructive changes.
5. `CASCADE` deletes on anything PHI-adjacent (eligibility, audit) are a
   red flag — prefer `SET NULL` and keep history (see audit P1-4).

### API contract changes

`server/routes/*.ts` and `client/src/shared/api.ts` are two halves of one
contract. Change both in the same commit, update the `interface` in
`api.ts`, and run `npm run test:all`.

---

## 5. Adding a feature — worked patterns

### A new external integration

Follow the shape of `server/integrations/google/gmail.ts`:
- Bare `fetch`; base URL from `endpoint('name')`.
- Its own `FooError extends Error` with `code` and `get isRetryable()`.
- Map HTTP status → error code (`401` → not-connected, `429`/`5xx` →
  retryable, else bad-request).
- `AbortSignal.timeout(...)` on every call.
- Add `DEMO_PATHS` entries and teach `demo/mock-server.ts` the routes.
- Tests use `tests/helpers/fetchMock.ts`.

### A new reminder channel (e.g. SMS)

The seam already exists: implement `ReminderChannel` in
`server/practice/reminders.ts`, call `registerChannel(new SmsChannel())`,
add `'sms'` handling where `channel` is chosen. No queue changes.

### A new automated step in the exam-request pipeline

Add it inside `draftOne()` in `server/practice/queue.ts` **above**
`setStatus(row.id, 'drafted')` — i.e. in the pre-approval, nothing-sent
zone. If the step can fail transiently, throw a `*APIError` with
`isRetryable` so `draftPending`'s catch does the right thing. If it sends
anything, it belongs in `commitInvoice` / `approveExamRequest` instead,
behind the gate.

### A new setting

1. `.env.example` — document the key.
2. `GET`/`POST /api/settings/...` — read from `process.env`, write via
   `updateEnvConfig`. Secrets are **write-only**: return `hasX: boolean`,
   never the value; don't overwrite on a save that omits them.
3. Client form — `client/src/practice/*Settings.tsx`, or
   `client/src/receipts/Settings.tsx` for the top-level hub.
4. Validate ranges server-side.

---

## 6. Upgrade & maintenance processes

### Before shipping a bundle / release

The CI (`.github/workflows/bundle.yml`) currently publishes on every push
to `main` **with no test gate** (audit P1-18 — fix this first). Until it
does, before merging to `main`:

```bash
npm run test:all && npm run typecheck:all && npm run build
```

### Bumping the Claude models

- Models live in `server/integrations/claude.ts` (`EXTRACTION_MODEL`,
  `VALIDATION_MODEL`).
- Use the **bare** model ID from Anthropic's current model list
  (`claude-sonnet-5`, `claude-haiku-4-5`) — **no date suffix** on the
  4.5 / 5 families unless you are deliberately snapshot-pinning both.
- Re-check `EXTRACTION_PROMPT` / `EXAM_REQUEST_PROMPT` still produce
  strict JSON with the new model; the `validate*Extraction` guards will
  catch a reshape but not a subtle quality drop — spot-check
  `tests/receipts-extract.test.ts` fixtures.
- `anthropic-version` (`API_VERSION`) only changes if Anthropic
  deprecates the current one.

### Bumping `better-sqlite3` (native module)

- Keep `Dockerfile` Node major ≥ the floor in `lib-node-runtime.sh`
  (currently 22). Bump both together.
- Update the `allowScripts` version key in root `package.json` to match.
- `rm -rf node_modules && npm install`, then run the **server** suite —
  a wrong ABI segfaults rather than erroring.
- The native start path rebuilds automatically when Node changes
  (`.node-version-used` marker in `start-native.sh`).

### Bumping the client stack (React / Vite / router)

- `client/package.json`; update the `esbuild` `allowScripts` key.
- `(cd client && npm test && npx tsc -b --noEmit && npm run build)`.
- Check the PWA manifest / service worker still generate
  (`client/dist/sw.js`).

### OHIP: going from mock → conformance → production

This is the one integration with real-world gates. In order:
1. Obtain ministry conformance credentials (GO Secure account with the
   *Health Service HCV* role, conformance key, X.509 keystore).
2. Convert the `.p12` keystore to PEM (Node can't read PKCS#12) — see
   `docs/SETUP-CREDENTIALS.md` §5.
3. **Verify the message schema** — the element/namespace names in
   `ELEMENTS` in `server/integrations/ohip/hcv-soap.ts` were written from the
   published spec, not generated from the WSDL. Settings → OHIP → Test
   connection (blank = credentials load; with a test number = real
   validation). A schema mismatch comes back as a SOAP fault naming the
   element.
4. Replace the regex response parsing (audit P3-30) before production.
5. Only after conformance passes: `OHIP_HCV_MODE=production`.

### Wave: first real invoice

`CustomerCreateInput` / `InvoiceCreateInput` field names in
`server/integrations/wave/wave.ts` were written from Wave's docs, not verified in
their Playground. Check them before the first real invoice
(`docs/history/upgrade-plan.md` "What's left" #2).

### Turning on HTTPS (required before real patient data)

`docs/DEPLOYMENT.md` + `deploy/Caddyfile`. The session cookie marks itself
`Secure` automatically once a request arrives over HTTPS. Also: set
`TRUST_PROXY=1` only when actually behind a proxy (audit P0-3), and back
up `DATA_ENCRYPTION_KEY` separately from `data/` (audit P2-7).

### Dependency review cadence

Quarterly: `npm outdated` in both projects; review `express` (5.x),
`multer` (2.x), and the `xml-crypto` line specifically. Record any
deliberate "not yet" in `docs/AUDIT.md` §3 so the decision stays visible.

---

## 7. Where to look when…

| Symptom | Start at |
|---|---|
| A receipt won't upload | `server/receipts/upload-queue.ts`, the receipt's `last_error` / `status` / `retry_count` |
| An exam request is stuck | `server/practice/queue.ts` + `exam-requests.ts`; check `status`, `last_error`, `retry_count`; `isReadyForRetry` gating |
| Eligibility always says "mock" | `OHIP_HCV_MODE` unset/`mock`; `server/integrations/ohip/index.ts` |
| Gmail/Calendar calls 401 | token refresh in `server/integrations/google/auth.ts` → `oauth-store.ts`; reconnect in Settings |
| "Nothing is being polled" | `GMAIL_EXAM_REQUEST_QUERY` empty, or Google not connected |
| Approving does nothing to the invoice | no `WAVE_INCOME_ACCOUNT_ID` / `WAVE_SERVICE_PRODUCT_ID` set |
| Login loop / stuck on `/login` | `client/src/App.tsx` `gateTarget` race; auth status endpoint |
| Tests fail at random | DB handle leak — a test missing `teardown()` / `closeDb()`; see `tests/helpers/testApp.ts` |
| A health card number appeared somewhere it shouldn't | `toPatientDto` / `toExtractionDto` masking; `body_snippet` (audit P0-1) |

---

## 8. Documentation map

| File | Purpose |
|---|---|
| [`README.md`](README.md) | Entry point, stack, local dev |
| `AGENTS.md` (this file) | How to work on it, rules, upgrade processes |
| [`INDEX.md`](INDEX.md) | Living file/directory map + subsystem index |
| [`docs/AUDIT.md`](docs/AUDIT.md) | Known issues, prioritized |
| [`docs/GETTING-STARTED.md`](docs/GETTING-STARTED.md) | Non-technical setup (receipts) — needs a practice-workflow rewrite |
| [`docs/SETUP-CREDENTIALS.md`](docs/SETUP-CREDENTIALS.md) | Every credential, where to get it |
| [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) | Where to run it, HTTPS, backups |
| [`docs/SECURITY.md`](docs/SECURITY.md) | Auth model, data at rest, where PHI leaves the machine |
| [`docs/DEMO.md`](docs/DEMO.md) | Credential-free full-app demo |
| [`docs/history/`](docs/history/) | `conversion-plan.md`, `upgrade-plan.md` — historical, partly stale, still useful for rationale |

The guides moved into `docs/`, and `server/` + `client/` were regrouped by
domain, on 2026-08-28. Paths above reflect that layout. Remaining
refactors (OAuth-route dedup, `wave.ts` split, `makePoller`, the error
handler, the `api.ts` split) are listed in
[`INDEX.md`](INDEX.md) §"Deferred follow-ups".
