# Security notes

This document tracks how Viewpoint Receipts handles authentication,
data at rest, and network exposure — and what remains to be revisited.

## Why this got stricter

The app originally held only the operator's own expense receipts, and its
auth model was sized accordingly. It now also holds **patient names,
contact details, and health card numbers** for the exam-request workflow.
That is personal health information under Ontario's PHIPA, so the
trade-offs that were reasonable for receipts no longer are.

## Current design: local, single-user

The app still assumes one trusted operator running it on their own
machine or a private server they control.

- **One password, no accounts.** `server/middleware/auth.ts` verifies a
  single password against a **scrypt** hash with a per-password salt
  (N=16384, r=8, p=1), stored in SQLite as `scrypt:<salt>:<hash>`. An
  `APP_PASSWORD` env var still takes precedence. Installs created before
  this change carry an unsalted SHA-256 hash; it is accepted once and
  transparently re-hashed on the next successful login.
- **Sessions are separate from the password.** Logging in mints a random
  32-byte token (`server/services/sessions.ts`); the `token` cookie and
  `Authorization: Bearer` header carry *that*, never the password. Only
  the SHA-256 of each token is stored, so the database file alone yields
  no usable cookies. Sessions expire after 30 days, individual sessions
  are revoked by logging out, and changing the password revokes all of
  them. The password is no longer a credential for anything after login.
- **Login is throttled.** Ten failed attempts within 15 minutes lock
  logins for 15 minutes, with a `Retry-After` header. The counter is
  in-memory and shared across source IPs, so rotating addresses buys no
  extra guesses. It resets on restart — it exists to make online guessing
  impractical, not to survive a reboot.
- **Sensitive fields are encrypted at rest.** Health card numbers, stored
  OAuth tokens, and raw OHIP responses are AES-256-GCM encrypted
  (`server/services/crypto.ts`) under a key generated on first use and
  kept in `.env` as `DATA_ENCRYPTION_KEY` (mode 0600). GCM's auth tag
  means tampering fails loudly instead of returning garbage.
- **Receipt images require a session.** `/images` is mounted behind the
  auth gate. It previously sat *ahead* of the auth middleware, i.e. was
  readable by anyone who could reach the port.
- **Access is audited.** `server/services/audit.ts` appends to an
  `audit_log` table on logins, PHI reads and writes, health card
  decryption, eligibility checks, and anything sent to a patient or
  posted to Wave on their behalf.
- **Exam-request email content is encrypted too.** Both Claude's reading
  of the email (`exam_requests.extracted_json`) and the retained slice of
  the raw email body (`exam_requests.body_snippet`) are AES-256-GCM
  encrypted — they hold the same personal health information the patients
  table protects. The raw slice is never included in an API response; it
  is served only through `GET /api/practice/exam-requests/:id/source`,
  which writes an audit entry for each access.
- **CORS is same-origin only.** The client is always served from the same
  origin as the API (proxied in dev via `client/vite.config.ts`, bundled
  together in production), so there is no cross-origin policy to
  configure.

## Personal health information leaves the machine

Three things are worth being explicit about, because "your data lives
entirely on this computer" is no longer the whole story:

1. **Exam-request emails are sent to the Anthropic API** for extraction.
   Whatever the sender wrote — including health card numbers — is in that
   request. Keep `GMAIL_EXAM_REQUEST_QUERY` narrow (a dedicated label is
   best) so unrelated mail is never sent.
2. **Health card numbers are sent to the Ontario Ministry of Health** when
   an eligibility check runs. That is the point of the check, and it does
   not happen at all in the default `mock` mode.
3. **Patient names and email addresses are sent to Wave** when an invoice
   is raised, and Wave emails the invoice to the patient.

Reading email and sending reminders both use Google OAuth against the
practice's own mailbox; the app stores only the encrypted tokens.

## Operational requirements

Because the database now holds PHI, these are no longer optional:

1. **Run it over HTTPS.** Use the `deploy/Caddyfile` example, or
   Tailscale. Health card numbers must not cross even a home LAN in the
   clear. The server **refuses to start** over plain HTTP once
   `OHIP_HCV_MODE` leaves `mock` or any patient record exists
   (`server/platform/phi-guard.ts`) — set `APP_PUBLIC_URL=https://…`, or
   `TRUST_PROXY=1` if a proxy terminates TLS, or `ALLOW_INSECURE_PHI=1`
   to override for LAN testing only. The session cookie marks itself
   `Secure` automatically once a request arrives over HTTPS (directly or
   via `X-Forwarded-Proto` when `TRUST_PROXY=1`).
2. **Back up `DATA_ENCRYPTION_KEY` with the database.** A backup of
   `data/` without the key is unrecoverable for every encrypted field.
   Conversely, storing them together means a stolen backup is readable —
   keep the key somewhere the database backups are not.
3. **Keep full-disk encryption on** for the machine running the app.

## Still to revisit

See [`AUDIT.md`](AUDIT.md) for the full list. In brief:

1. **Multi-user support.** The schema and auth layer still assume exactly
   one password for the whole app; there is no user table and no per-user
   data isolation. The `audit_log` records *what* happened but cannot
   attribute it to a person.
2. **Key rotation.** `DATA_ENCRYPTION_KEY` is generated once and never
   rotated; there is no re-encryption path.
3. **Audit log retention and integrity.** The log is append-only by
   convention, not enforcement — anyone with database access can edit it.
   (`AUDIT.md` P1-4.)
4. **Service-worker PHI cache** and **no debounce on ministry-facing
   endpoints** — `AUDIT.md` P1-5, P1-6.
