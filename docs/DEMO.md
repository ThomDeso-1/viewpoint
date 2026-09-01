# Demo mode — run the whole app with no credentials

Everything works: exam requests arrive, get read, get matched to
appointments, their coverage status is pulled off the schedule, invoices
get raised, reminders get sent. **None of it touches a real service, and
none of it costs anything.**

Use this to learn the app and shake out bugs. When you hand it over, your
user swaps in real credentials and nothing else changes.

```bash
npm install && (cd client && npm install)
npm run demo
```

Then open **http://localhost:5173** and log in with the password `demo`.

Two other things worth having open:

| | |
|---|---|
| http://localhost:5173 | The app |
| http://localhost:4000 | What the fake services captured — every invoice "raised" and email "sent" |

The terminal running the demo logs every outbound call as it happens, so
you can watch the workflow move.

---

## What's fake

| Real service | Replaced by |
|---|---|
| Anthropic (Claude) | Canned extractions — receipts and patient files |
| Wave | In-memory customers, invoices and expenses |
| Patient files folder | A seeded `patient-files/upcoming-exams.csv` with three patients and a note (the app also reads Word/PDF/etc.) |
| Gmail | Send only — reminder mail is captured, not delivered |
| Google Calendar | Three appointments matching those patients |
| Google OAuth | Auto-approves, so the real connect flow still runs |
| OHIP | Disabled by default (not certified). The schedule file's "Status" column stands in. Set `OHIP_ENABLED=true` to exercise the built-in mock. |

**The app's own code is not mocked.** Only the base URLs move
(`server/services/endpoints.ts`). The same GraphQL parsing, MIME decoding,
OAuth exchange, retry and error handling run in demo mode as in
production — which is the point. A mock that bypassed those wouldn't find
the bugs that live in them.

You'll know demo mode is on: there's a banner across the top of the app,
and a box in the server logs at startup.

---

## The demo cast

Three people email in, chosen so each takes a different path:

| | Schedule "Status" column | Appointment |
|---|---|---|
| **Ada Lovelace** | `Eligible` | Soonest; her reminder is due immediately |
| **Grace Hopper** | `$180 private pay` | Next day |
| **Alan Turing** | `Not eligible` | Two days out |

Plus two patients already on file — **Katherine Johnson** (has a card) and
**Mae Jemison** (deliberately has none, so you can see that path) — and
three captured receipts waiting to be extracted.

All dates are relative to when you run it, so there's always something
upcoming and always a reminder due.

---

## A five-minute tour

1. **Open the app** → you land on Receipts. Three are waiting.
2. **Tap one** → it "extracts" instantly. Fix anything, tap
   **Approve & Upload**. Within a minute it shows as uploaded — and
   appears under *Receipt expenses* on http://localhost:4000.
3. **Tap "Exam requests"** in the top-right nav → the **exam request inbox**.
   Tap **Scan folder** (under the heading) — the seeded `upcoming-exams.csv` is read and three
   requests appear, already drafted: patient matched, appointment linked,
   coverage read off the schedule, invoice drafted, reminder written.
4. Each card's **Coverage (schedule)** line reflects that file's "Status"
   column: Ada *Covered*, Grace *Private pay*, Alan *Not covered* — tagged
   *(from the schedule)*, because nothing was actually checked with the
   ministry.
5. On Ada's card, tap **Edit lines** → add a second line, watch the total
   update, **Save invoice**.
6. Tap **Preview** on the reminder to read what would be sent.
7. Tap **Approve** → check http://localhost:4000: a customer, an invoice
   with your edited lines, and the invoice email. Ada's *reminder* email
   turns up within a minute (her appointment is inside the reminder
   window).
8. **Tap "Schedule"** in the top-right nav. Try **Add** for a walk-in, and
   **Link a patient** on anything unmatched.
9. **Settings** (gear, top-left) **→ App & privacy → View access log** →
   every health card read and everything sent, recorded.

---

## Things worth deliberately breaking

The demo is most useful for the unhappy paths:

- **Dismiss** a request instead of approving — its reminder should be
  cancelled and never send.
- Clear the **patient files folder** in Settings → scanning stops entirely.
- Clear the **invoice product/account** → approving still schedules the
  reminder, but reports that the invoice couldn't be created.
- Settings → Google → **Disconnect**, then **Connect** again. The real
  OAuth flow runs; the fake consent screen auto-approves.
- Put an odd value in the CSV's **Status** column (e.g. `407`) and
  re-scan — the card shows it verbatim with a neutral tag, not a
  covered/not-covered verdict.
- Stop the mock server (`Ctrl-C` on that pane) and use the app — you
  should get clear errors, not silent failures or crashes.

### The mock health card numbers

Only relevant with `OHIP_ENABLED=true` (off by default). When on, these
fixed numbers drive the built-in mock HCV service:

| Number | Result |
|---|---|
| `1111111111` | Valid |
| `2222222222` | Expired |
| `3333333333` | Invalid number |
| `4444444444` | Not eligible |
| `5555555555` | Reported lost or stolen |
| `9999999999` | Service unavailable (retryable) |

Anything else validates.

---

## Housekeeping

```bash
npm run demo:reset   # wipe the demo database and re-seed
```

Demo data lives in `demo-data/` (gitignored) and its settings in
`demo-data/.env` — **your real `.env` is never touched**. Clear the
captured invoices and emails with the button at the bottom of
http://localhost:4000.

Ports: app `5173`, API `3000`, fake services `4000`. Change the last with
`DEMO_MOCK_PORT`.

---

## Going live

Nothing about the app changes — demo mode is a single environment
variable, and it's off by default.

1. Run normally (`npm run dev`, or the packaged `start-native.command`)
   instead of `npm run demo`.
2. Work through [SETUP-CREDENTIALS.md](SETUP-CREDENTIALS.md).

The one thing that does **not** carry over is the data: `demo-data/` is
separate from the real `data/` directory, so nothing fictional can leak
into the real database.
