# Exam Bookings — Upgrade Plan & Status

Adding two workflows to Viewpoint Receipts: **Wave client invoicing with
appointment reminders**, and **OHIP eligibility checking from the
schedule** — both driven automatically off Gmail and Google Calendar.

This document tracks what has been built, what remains, and what is
blocked on things outside the codebase.

**Status: feature-complete and tested. Two external verifications remain**
— confirming the ministry message schema against the WSDL, and the Wave
mutation field names in their Playground. See [What's left](#whats-left).

Credential setup is documented separately in
[SETUP-CREDENTIALS.md](../SETUP-CREDENTIALS.md).

---

## Why this exists

Before this work, the app did exactly one thing: photograph an expense
receipt → Claude extracts vendor/date/total → you review → a background
queue posts it to Wave as an expense. Two SQLite tables, no notion of a
patient, appointment, invoice, or health card.

Every new exam request meant four manual jobs across four systems: read
the email, find the slot in Google Calendar, check OHIP coverage by hand,
and raise a Wave invoice — then remember to send a reminder.

The goal was to collapse that into **one card you approve with one tap**,
with everything drafted in advance and nothing sent until you say so.

### Decisions taken up front

| Question | Decision |
|---|---|
| Where the schedule and requests live | Google Calendar + Gmail |
| OHIP approach | Port the PHP example to a real TypeScript HCV client, behind a swappable interface with a mock |
| Wave auth | Extend the existing access-token client; build OAuth alongside it, switchable |
| Reminder channel | Gmail, behind an interface so SMS can be added later |
| PHI security | Harden as part of this work, not afterwards |
| Email triage | User-configured Gmail search + Claude extraction |
| Automation level | Draft everything, queue for one-tap approval |

---

## How the workflow now runs

```
Gmail  ──▶ exam_requests ──▶ Claude ──▶ patient matched ──▶ Calendar event
                                                                   │
                                                                   ▼
                                                          OHIP eligibility
                                                                   │
                                                                   ▼
                                          invoice drafted + reminder composed
                                                                   │
                                          ═════════ APPROVE ═══════╡  ← the only human step
                                                                   ▼
                                          Wave invoice sent · reminder scheduled
```

Everything above the line runs unattended on a 60-second poll. Nothing
below it happens without an explicit tap. A dismissed request cancels its
drafted reminder so it can never fire later.

Status machine, deliberately mirroring the receipts pipeline
(`captured → extracted → reviewed → uploaded`) so the two read alike:

```
received → extracted → drafted → approved → completed
                  ↘ needsAttention     ↘ failed
```

---

## What's been built

Roughly **4,200 lines of server code**, **860 of client**, and **2,260 of
tests**. All of it is in the working tree on `main` — **nothing has been
committed**.

### Phase 0 — Foundations ✅

| | |
|---|---|
| **Migrations** | `server/db/db.ts` re-`exec`'d `schema.sql` on every boot, so a column could never be added. Replaced with a numbered runner (`server/db/migrations/NNN-*.sql`) tracking `schema_version` in `app_config`, each migration in a transaction. Existing installs sit at v0; `001` is the original schema verbatim, so they no-op onto it and pick up `002`+ cleanly. |
| **Encryption at rest** | `server/services/crypto.ts` — AES-256-GCM on Node's built-in crypto, no new dependency. Key generated on first use into `.env` as `DATA_ENCRYPTION_KEY` (mode 0600). |

### Phase 0.3 — Security hardening ✅

The old model was documented candidly in `SECURITY.md` as fine for
receipts. It was not adequate for health card numbers.

| Was | Now |
|---|---|
| Unsalted SHA-256; the password *was* the session cookie | scrypt with a per-password salt; random 32-byte session tokens, stored only as SHA-256 (`server/services/sessions.ts`). Old hashes upgrade transparently on next login. |
| No login rate limiting | 10 failures / 15 min → 15-minute lockout with `Retry-After` |
| `/images` mounted *ahead* of the auth gate | Behind `requireAuth` |
| No audit trail | `audit_log` on logins, PHI reads/writes, card decryption, eligibility checks, and anything sent to a patient |
| `scryptSync` blocking the event loop | Async `crypto.scrypt` — ~100 ms per login no longer stalls in-flight requests |

### Phase 1 — Exam-workflow data model ✅

Migration `003-exams.sql` adds `patients`, `appointments`,
`exam_requests`, `eligibility_checks`, `reminders`, `wave_invoices`,
`oauth_tokens`. Row types in `server/db/db.ts`.

`google_event_id` and `gmail_message_id` are `UNIQUE` — the idempotency
guarantee for polling, the same role `externalId: viewpoint-<receiptId>`
already plays for Wave expenses.

`server/services/patients.ts` is the only doorway to health card numbers:
encrypted on write, decrypted only through an audited `readHealthCard()`,
and masked in every API response so an accidental `res.json(row)` cannot
leak one.

### Phase 2 — Google ✅

Bare `fetch` throughout, matching `claude.ts` and `wave.ts` — no
`googleapis` SDK for three endpoints.

- `google-auth.ts` — authorize/exchange/refresh, tokens encrypted in `oauth_tokens`
- `gmail.ts` — list, get (with nested-MIME body extraction and an HTML fallback), send
- `google-calendar.ts` — list/get events, plus `matchEvent()` which **refuses to guess** between indistinguishable candidates
- `routes/google.ts` — connect, callback, disconnect, status
- `claude.ts` — `extractExamRequest()` with its own shape guard, mirroring the existing `validateExtractionResult()`. Model IDs also refreshed from the stale mid-2025 pins.

> The OAuth callback is mounted **ahead of** the auth gate. The session
> cookie is `sameSite: strict`, so the browser does not send it on a
> top-level navigation from `accounts.google.com`; the callback is
> protected by its single-use `state` secret instead, which is what state
> is for.

### Phase 3 — Wave ✅

Added to `server/services/wave.ts`, reusing the existing GraphQL transport
and `WaveAPIError` taxonomy: `fetchProducts`, `fetchIncomeAccounts`,
`findCustomerByEmail`, `createCustomer`, `findOrCreateCustomer`,
`createInvoice`, `approveInvoice`, `sendInvoice`.

`server/services/wave-auth.ts` exposes a single `getWaveToken()`, making
the pasted token and OAuth interchangeable. `upload-queue.ts` and
`routes/settings.ts` now call it instead of reading the env var directly —
the one change that touched existing receipt behaviour, with the original
tests still green.

### Phase 4 — OHIP ✅

`server/services/ohip/` — interface, mock, real SOAP client, and a factory
keyed on `OHIP_HCV_MODE`.

`hcv-soap.ts` is a genuine port of
[mykiBoy/OHIP-HCV](https://github.com/mykiBoy/OHIP-HCV)'s `main.php`:
WS-Security envelope carrying an X.509 `BinarySecurityToken`, XML-DSig
signature over the Timestamp and Body, exclusive canonicalisation,
KeyInfo referencing the token. Uses `xml-crypto` (the two new
dependencies are `xml-crypto` and `xmlbuilder2`).

Every result carries its `mode`, and the UI labels mock results loudly —
a simulated eligibility answer must never pass for real coverage.

### Phase 5 — The automation queue ✅

`server/services/exams-queue.ts` reuses the proven `upload-queue.ts`
design rather than adding a job library: a re-entry guard, a 60 s
interval, and backoff **stored on the row rather than slept** (extracted
to the shared `server/services/backoff.ts`), so one flaky item never
blocks the batch and a restart resumes the schedule.

`reminders.ts` composes and sends via a `ReminderChannel` interface —
`GmailReminderChannel` is the only implementation, and the seam SMS would
plug into.

### Phase 6 — Client ✅

**Pages** — `Inbox.tsx` (the approval screen), `Schedule.tsx`,
`PatientDetail.tsx`, `Patients.tsx` (searchable directory), `AuditLog.tsx`
(filterable access trail).

**Components** — `GoogleSettings`, `ExamSettings`, `OhipSettings`,
`InvoiceEditor` (editable draft lines with a live total),
`AppointmentForm` (manual entry).

Plus nav icons in the receipts header, new `StatusBadge` statuses,
inline patient-linking on the schedule, and CSS matching the existing
design tokens throughout.

### Phase 7 — Setup and configuration ✅

- **OHIP is now a first-run step.** Onboarding is four steps (password →
  Claude → Wave → OHIP), each skippable. Skipping OHIP records `mock`
  *explicitly* rather than leaving it unset, so eligibility results are
  always labelled simulated rather than silently absent.
- **Every setting has a screen.** Gmail search, confidence threshold,
  invoice product/account picker, exam fee, business name, timezone,
  reminder lead time, OHIP mode and credentials, Wave auth mode. Nothing
  requires hand-editing `.env` any more.
- **OHIP credentials can be tested** before you rely on them — blank
  verifies the certificate and key load and that a signed request builds
  without contacting the ministry; with a health number it runs a real
  validation.
- **Secrets are write-only.** The server returns whether a password or
  conformance key is set, never the value, and saving a form without
  retyping them leaves them intact.
- **The session cookie now marks itself `Secure`** whenever the request
  actually arrives over HTTPS (directly or via `X-Forwarded-Proto`, with
  `trust proxy` set for the reverse-proxy case). It can't be
  unconditional — a Secure cookie is never stored over plain HTTP, which
  would lock out LAN users — so deciding per-request means enabling HTTPS
  upgrades the cookie with nothing to remember.

### Verification ✅

| | |
|---|---|
| Server tests | **345 passing** across 15 files |
| Client tests | **189 passing** across 22 files |
| Typecheck | Clean, both projects |
| Live smoke test | Server boots with both queues; auth, patients, eligibility, and the Google/Wave status endpoints all exercised against a running instance |

Confirmed directly against the SQLite file: **no plaintext health card
number anywhere on disk**, and the audit log records every decryption.

### Bugs found and fixed along the way

1. **Extracted email content was stored in plaintext.** `extracted_json`
   held the health card number, defeating the encryption in `patients`.
   The blob is now encrypted; the API masks the number.
2. **Timezone bug in calendar matching.** A requested wall-clock time was
   compared against absolute event instants. Now explicitly assumes the
   server's local zone is the business's — true for a Mac in the office,
   and flagged in the code as the line to change if that stops holding.
3. Foreign-key violation recording a check for an unknown patient.
4. Non-deterministic ordering when two checks landed in the same
   millisecond (`ORDER BY checked_at DESC, rowid DESC`).
5. Test isolation: `DATA_ENCRYPTION_KEY` leaked between test files, so
   the first generated key was silently reused everywhere.

---

## What's left

### 🔴 Needs your ministry/vendor documents

These are verifications against documents I don't have, not unfinished code.

1. **Confirm the HCV message schema.** The security header,
   canonicalisation, and signing follow the WS-Security X.509 profile and
   are standard. The *element and namespace names inside the Body* were
   written from the ministry's published structure and must be checked
   against the MOH technical specification and the WSDL issued with your
   credentials. They are collected in one `ELEMENTS` constant in
   `hcv-soap.ts`, so a correction is a one-line change.

   Since you already hold conformance credentials, the fastest route is:
   Settings → OHIP → switch to **conformance** → **Test connection** with
   a blank number (proves the certificate and key load), then with a real
   test number (proves the schema). Any mismatch comes back as a SOAP
   fault naming the element it disliked.

2. **Verify the Wave mutation field names.** Wave's developer portal
   blocks automated fetching, so `CustomerCreateInput` /
   `InvoiceCreateInput` were written from the documented schema rather
   than generated from it. Check them in the
   [API Playground](https://developer.waveapps.com/hc/en-us/articles/360018937431-API-Playground)
   before the first real invoice. Noted in the code.

### 🟠 Operational, before real patient data

3. **Turn on HTTPS** via `deploy/Caddyfile`. The session cookie now marks
   itself `Secure` automatically once it sees an HTTPS request, so there
   is nothing else to change.
4. **Back up `DATA_ENCRYPTION_KEY` separately from the database.**
   `data/` without the key is unrecoverable; both in one backup means a
   stolen backup is readable.

### ⚪ Documentation

- [ ] `GETTING-STARTED.md` still describes only the receipts workflow.
      [SETUP-CREDENTIALS.md](../SETUP-CREDENTIALS.md) now covers every
      credential, but the day-to-day walkthrough hasn't been rewritten.
- [ ] `README.md` stack list doesn't mention the exam-bookings module
- [ ] `CONVERSION-PLAN.md` is now partly historical

### Deferred by design

- **SMS reminders** — the `ReminderChannel` interface is the seam; add an
  implementation and register it.
- **Key rotation** — `DATA_ENCRYPTION_KEY` is generated once, never
  rotated, and there is no re-encryption path.
- **Multi-user** — still one password for the whole app. `audit_log`
  records *what* happened but cannot attribute it to a person.
- **Audit log integrity** — append-only by convention, not enforcement.
- **Editing an invoice after it reaches Wave** — deliberate. Once created,
  Wave holds the authoritative copy and editing belongs there; the app
  refuses rather than letting the two drift.

### Pre-existing issues (unrelated, found while exploring)

- `GET /api/receipts/queue/status` is registered *after* `GET /:id` and
  only works because `/:id` can't match two segments — fragile if anyone
  adds sub-routes.
- `GET /api/receipts` loads every row and filters in JS despite the
  indexes existing. Irrelevant at single-user scale.
- `Dockerfile` uses node:20 while `lib-node-runtime.sh` sets a Node 22
  floor for better-sqlite3's ABI.

---

## Configuration

**Everything is now entered in the app** — the four-step setup wizard on
first run, then Settings. See
[SETUP-CREDENTIALS.md](../SETUP-CREDENTIALS.md) for what each credential is
and where to get it.

`.env` is still where the app *stores* what you enter (mode 0600, written
by `server/services/env-config.ts`), and `.env.example` documents every
key — but you shouldn't need to edit it by hand any more.

The two settings that most often get missed, because nothing works
without them and neither has an obvious default:

- **Gmail search** (Settings → Exam Requests) — nothing is polled while
  it's empty.
- **Invoice product or income account** (same screen) — approving a
  request can't create an invoice without one, and says so.

---

## Where patient data goes

Worth being explicit, because "your data lives entirely on this computer"
is no longer the whole story (also covered in `SECURITY.md`):

1. **Exam-request emails go to the Anthropic API** for extraction —
   including whatever the sender wrote, health card numbers included.
   This is why `GMAIL_EXAM_REQUEST_QUERY` should be a dedicated label
   rather than a broad inbox search.
2. **Health card numbers go to the Ontario Ministry of Health** when an
   eligibility check runs. Does not happen at all in `mock` mode.
3. **Patient names and emails go to Wave** when an invoice is raised, and
   Wave emails the invoice to the patient.

Gmail and Calendar access is OAuth against the business's own mailbox;
only encrypted tokens are stored.

---

## How to verify

```bash
npm install && (cd client && npm install)

npm test              # 345 server tests
cd client && npm test # 189 client tests — the root `npm test` does NOT run these

npm run dev           # server :3000, client :5173
```

End-to-end, starting in mock mode:

1. Run through the setup wizard, or open Settings if already onboarded.
2. **Connect Google** (Settings → Google) — from a browser on the Mac.
3. Set the **Gmail search** and pick an **invoice product or income
   account** (Settings → Exam Requests).
4. Send yourself an exam-request email matching that search, and add a
   matching Calendar event.
5. Within a poll cycle — or via **Check email** on the Inbox — it appears
   with extracted details, an eligibility badge marked `mock`, a draft
   invoice, and a reminder preview.
6. **Edit lines** on the invoice; the total updates as you type.
7. Tap **Approve** → the invoice appears in Wave and the reminder is
   scheduled.
8. Settings → **View access log** shows the health card decryption and
   everything sent.

Also worth exercising:

- **Schedule → Add** enters an appointment by hand; **Link a patient** on
  an unmatched one, then **Check OHIP**.
- **Patients** lists everyone created automatically, searchable.
- Confirm receipt capture → Wave expense upload still works unchanged.

Then, with real credentials: Settings → OHIP → **conformance** → **Test
connection**, blank first, then with a ministry test number.

---

## Suggested order from here

1. **First** — Settings → OHIP → conformance → **Test connection**. That
   single step tells you whether the SOAP client's message schema matches
   the ministry's, which is the one substantive unknown left.
2. **Then** — check the Wave mutations in the Playground and raise one
   real invoice end to end.
3. **Before real patients** — HTTPS, and put the encryption key somewhere
   safe.
4. **Then** — rewrite `GETTING-STARTED.md` around the new workflow.

Phases 0–2 are worth living with for a while before leaning hard on 3–5 —
this roughly tripled the size of the codebase.
