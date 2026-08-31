# Demo mode — run the whole app with no credentials

Everything works: exam requests arrive, get read, get matched to
appointments, eligibility gets checked, invoices get raised, reminders get
sent. **None of it touches a real service, and none of it costs anything.**

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
| OHIP | The app's own mock mode, which was always built in |

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

| | Health card outcome | Appointment |
|---|---|---|
| **Ada Lovelace** | Valid — covered | Soonest; her reminder is due immediately |
| **Grace Hopper** | Card expired | Next day |
| **Alan Turing** | Not eligible for OHIP | Two days out |

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
3. **Tap the envelope icon** (top right) → the **exam request inbox**.
   Tap **Scan folder** — the seeded `upcoming-exams.csv` is read and three
   requests appear, already drafted: patient matched, appointment linked,
   OHIP checked, invoice drafted, reminder written.
4. Notice **Grace** and **Alan** show as *not covered* — that's the
   eligibility check doing its job. Every result is tagged `mock`.
5. On Ada's card, tap **Edit lines** → add a second line, watch the total
   update, **Save invoice**.
6. Tap **Preview** on the reminder to read what would be sent.
7. Tap **Approve** → check http://localhost:4000: a customer, an invoice
   with your edited lines, and the invoice email. Ada's *reminder* email
   turns up within a minute (her appointment is inside the reminder
   window).
8. **Calendar icon** → the **Schedule**. Try **Add** for a walk-in, and
   **Link a patient** on anything unmatched, then **Check OHIP**.
9. **Settings → View access log** → every health card read and everything
   sent, recorded.

---

## Things worth deliberately breaking

The demo is most useful for the unhappy paths:

- **Dismiss** a request instead of approving — its reminder should be
  cancelled and never send.
- Clear the **patient files folder** in Settings → scanning stops entirely.
- Clear the **invoice product/account** → approving still checks
  eligibility and schedules the reminder, but reports that the invoice
  couldn't be created.
- Settings → Google → **Disconnect**, then **Connect** again. The real
  OAuth flow runs; the fake consent screen auto-approves.
- Edit a patient's health card to `9999999999` and re-check — that's the
  mock's "service unavailable", so you get a retryable failure.
- Stop the mock server (`Ctrl-C` on that pane) and use the app — you
  should get clear errors, not silent failures or crashes.

### The mock health card numbers

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
