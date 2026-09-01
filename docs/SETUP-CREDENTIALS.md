# What you need to set up

Everything below is entered **in the app** — Setup wizard on first run, or
Settings any time after. Nothing needs to be edited by hand in a file.

Each section says whether it is required, what it unlocks, and where to
get it.

---

## Quick summary

| # | Credential | Required? | Where it's entered |
|---|---|---|---|
| 1 | App password | **Yes** | Setup, step 1 |
| 2 | Claude API key | **Yes** | Setup, step 2 |
| 3 | Wave access token | For invoicing & receipts | Setup, step 3 |
| 4 | Wave business + accounts | With #3 | Setup, step 3 |
| 5 | OHIP mode + ministry credentials | Disabled by default (`OHIP_ENABLED`) | Settings → OHIP, when on |
| 6 | Google OAuth client | For calendar & reminder emails | Settings → Google |
| 6b | Outlook / Microsoft 365 | Optional alternative to Gmail for reminders | Settings → Outlook |
| 7 | Patient files folder | For automatic intake | Settings → Exam Requests |
| 8 | Invoice product/account | For invoicing | Settings → Exam Requests |
| 9 | Business name, timezone, fee | Recommended | Settings → Exam Requests |
| 10 | Wave OAuth client | Optional alternative to #3 | Settings → Wave |

Steps 1–4 are the first-run wizard (step 5, OHIP, is skipped while
`OHIP_ENABLED` is off). Steps 6–9 are done once in Settings afterwards,
because they need a Google Cloud project.

---

## 1. App password

**Required.** Set on first launch. This is what you log in with from the
Mac and from your phone.

There is no reset — nothing syncs to the cloud. Write it down.

---

## 2. Claude API key

**Required.** Reads receipts, and reads patient files from the scanned
folder.

Get it at [console.anthropic.com](https://console.anthropic.com) →
Settings → API Keys → Create Key. Needs a payment method; extraction costs
a fraction of a cent per receipt or file.

Starts with `sk-ant-`.

---

## 3. Wave access token

**Required for uploading receipts and raising invoices.** Skippable —
receipts queue up until it's added.

Wave → Settings → API Access → Create a token.

> **Alternative:** Wave OAuth (see #10). The token is simpler and is the
> default; OAuth additionally needs a Wave Pro subscription and an HTTPS
> address, so only switch if you have a reason to.

---

## 4. Wave business and accounts

Chosen from dropdowns immediately after the token — the app fetches them
from your Wave account. You'll pick:

- **Business** — which Wave business to post to
- **Expense account** — where receipt expenses are recorded
- **Paid-from account** — the bank or credit card they came out of
- **Sales tax** *(optional)*

---

## 5. OHIP Health Card Validation

> **Disabled by default.** The ministry HCV integration is not certified
> for production, so `OHIP_ENABLED` is `false` and every OHIP surface
> (this settings panel, the onboarding step, the eligibility tags and
> "Check OHIP" buttons) is hidden. While it is off, the schedule file's
> **Status** column is captured and shown on each request instead — see
> §"Reading the schedule file" below.
>
> To bring it back once conformance testing is complete and credentials
> are issued: set `OHIP_ENABLED=true` in `.env` and restart. Everything
> below then applies.

### Mode

| Mode | What it does |
|---|---|
| **Mock** (default) | Simulated results, labelled **mock** everywhere they appear. Nothing contacts the ministry. |
| **Conformance** | The ministry's test environment. Needs a conformance key. |
| **Production** | The live ministry service. Needs a production key. |

Mock mode has fixed test numbers, so you can try each outcome:

| Number | Result |
|---|---|
| `1111111111` | Valid |
| `2222222222` | Expired |
| `3333333333` | Invalid number |
| `4444444444` | Not eligible |
| `5555555555` | Reported lost or stolen |
| `9999999999` | Service unavailable |

### For conformance or production, you need

1. **Private key + certificate**, as PEM files. Node can't read a `.p12`
   keystore, so convert yours once:
   ```bash
   openssl pkcs12 -in yourStore.p12 -nocerts -nodes -out ohip-key.pem
   openssl pkcs12 -in yourStore.p12 -clcerts -nokeys -out ohip-cert.pem
   ```
   In Settings → OHIP, **paste the contents** of each file (or use the file
   picker). The app stores them under `data/ohip/` — you don't need to keep
   the files or know where they live. (Absolute paths still work too, via
   `OHIP_PRIVATE_KEY_PATH` etc.)
2. **GO Secure username and password** — the account carrying the
   *Health Service HCV* role.
3. **MOH ID** — your OHIP billing number.
4. **Conformance key**, or **production key** once you've passed
   conformance testing. This is embedded in every transaction.
5. **CA bundle** *(optional)* — `cacert.pem`, if the ministry supplied one.

> **Test it before relying on it.** Settings → OHIP → **Test connection**.
> Left blank, it verifies your certificate and key load and that a signed
> request builds, without contacting the ministry. Give it a health number
> and it runs a real validation.

---

## 6. Google OAuth client

**Required for calendar matching and sending reminder emails.** Settings →
Google. The app does not read your inbox.

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and
   create a project (or reuse one).
2. Enable the **Gmail API** and the **Google Calendar API**.
3. Credentials → Create Credentials → **OAuth client ID** → type
   **Web application**.
4. Under *Authorized redirect URIs*, add exactly the URI the Settings
   screen shows you — normally `http://localhost:3000/api/google/callback`.
5. Copy the **client ID** and **client secret** into Settings and save.
6. Click **Connect Google** and grant access.

> Do the connect step **in a browser on the Mac running the app**. The
> redirect address is a localhost one and won't resolve from your phone.

The app asks for: send email as you, and manage calendar events.

---

## 6b. Outlook / Microsoft 365 *(optional — alternative to Gmail for reminders)*

**Only needed if you want reminder emails to send from an Outlook or
Microsoft 365 mailbox instead of Gmail.** Calendar matching still uses
Google. Settings → Outlook / Microsoft 365.

1. Go to [portal.azure.com](https://portal.azure.com) → **Azure Active
   Directory** → **App registrations** → **New registration**.
2. Set the redirect URI type to **Web** and enter exactly the URI the
   Settings screen shows — normally
   `http://localhost:3000/api/microsoft/callback`.
3. Under **API permissions**, add Microsoft Graph → **Delegated** →
   `Mail.Send` (and `User.Read`, usually there by default).
4. Under **Certificates & secrets**, create a **client secret**.
5. Copy the **Application (client) ID** and the secret value into Settings
   and save. Leave the tenant field blank unless you need to lock it to one
   organisation.
6. Click **Connect Outlook** and grant access, then pick **Outlook** under
   *Reminder email account*.

> Do the connect step **in a browser on the Mac running the app** — same
> localhost-redirect reason as Google.

---

## 7. Patient files folder

**Required for automatic intake.** Settings → Exam Requests.

The app scans this folder every minute for `.docx`, `.xlsx`, `.csv`,
`.pdf`, `.txt` and `.eml` files, reads the patients and appointments out
of each one, and drafts an approval card per patient. It merges each
patient's schedule row with any notes elsewhere in the file that name
them (including corrections). A file is re-read only if its contents
change. Nothing is scanned while the folder is empty/unset.

The OHIP "Status" column in a schedule is captured verbatim and shown on
the request (interpreted as covered / not covered / private pay where the
wording is clear). It is advisory — what the file said, not a live check.
If `OHIP_ENABLED=true`, the app also runs its own eligibility check and
shows that alongside. When Google is connected, approving a card also
writes the appointment to your calendar, and you can change that patient's
reminder time on the card before approving.

Point it at an absolute path on the Mac — typically a folder that a
Dropbox, iCloud or Google Drive desktop app keeps synced, so your user can
drop files in from any device. Use the **Test folder** button to confirm
the app can see it.

> **Keep it dedicated.** Every supported file in the folder (recursively)
> is sent to Claude to read. Put only patient/appointment files there.

---

## 8. Invoice product or income account

**Required for invoicing.** Settings → Exam Requests → Invoicing.

Pick **one**:

- a **service product** you've saved in Wave (carries its own name and price), or
- an **income account** (simpler, if you don't keep products)

Not both — the invoice line would be ambiguous.

Until one is chosen, approving a request will still schedule the reminder
(and run the eligibility check, if OHIP is enabled) but report that the
invoice couldn't be created.

---

## 9. Business details

Settings → Exam Requests. Not strictly required, but reminder emails read
poorly without them.

| Setting | Default | What it affects |
|---|---|---|
| Business name | — | Signature line of reminder emails |
| Timezone | `America/Toronto` | How appointment times are written |
| Reminder lead time | 24 hours | How far ahead reminders go out |
| Default exam fee | — | First line of a drafted invoice |
| Minimum confidence | 0.6 | Below this, a request waits for manual review |

---

## 10. Wave OAuth *(optional)*

An alternative to the pasted token in #3. Settings → Wave.

Only worth it if you specifically want it, because it additionally
requires:

- an active **Wave Pro** (or Advisors) subscription on the connected
  business, and
- an **HTTPS** redirect URI — so the app must already be served over
  HTTPS, not plain LAN HTTP

You'd enter a Wave client ID and secret from
[developer.waveapps.com](https://developer.waveapps.com), then switch the
mode from *token* to *OAuth*. Token mode keeps working throughout.

---

## Before real patient data

Two things that aren't credentials but matter just as much:

1. **Turn on HTTPS.** See `DEPLOYMENT.md` and `deploy/Caddyfile`. Health
   card numbers shouldn't cross even your own LAN in the clear. The login
   cookie marks itself `Secure` automatically once you're on HTTPS.
2. **Back up your encryption key.** The app generates
   `DATA_ENCRYPTION_KEY` in `.env` on first run. Health card numbers,
   OAuth tokens, and OHIP responses are encrypted with it — a backup of
   `data/` **without** this key can't be read. Keep a copy somewhere your
   database backups aren't.

`SECURITY.md` covers the rest, including exactly where patient data leaves
the machine.
