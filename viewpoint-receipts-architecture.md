# Viewpoint Receipts — System Architecture Plan

**Date:** 2026-08-21 (rev. 2) · **Status:** Plan approved decisions baked in, no code written yet

An iOS app for photographing business receipts, extracting the accounting data (date, item purchased, total, taxes), filing images **and** structured data into monthly folders, and pushing the transaction to Wave accounting.

**Who it's for:** a single end user (not Thomas) who runs their business on Wave. They bring their own two credentials — a Claude API key and a Wave access token — entered once during onboarding. The app must be self-sustaining for them after setup: no server, no companion computer, no developer involvement in day-to-day use.

## Confirmed decisions

Platform is native iOS (Swift/SwiftUI). Receipt extraction uses AI vision via the Claude API. On first launch the user chooses where receipts live: **on-device** or **iCloud Drive**. The app talks to Wave's GraphQL API directly, using the [wave_mcp](https://github.com/vinnividivicci/wave_mcp) project as the reference implementation rather than as a runtime dependency — wave_mcp is an MCP server built to be driven by a Claude client, so a standalone app reuses its API logic instead of calling it.

## Key constraint discovered during research

Wave's public GraphQL API (and therefore wave_mcp) supports creating **transactions** — `moneyTransactionCreate` with date, description, amount, account, and sales tax — but does **not** support attaching the receipt image to the transaction, and does not support creating vendors (only searching existing ones). Consequences for the design:

- The monthly folder archive is the **system of record for the images and extracted data**; Wave holds only the transaction. This makes the local archive a first-class feature, not a convenience.
- Any vendor the user wants transactions associated with must already exist in Wave (created once in Wave's web UI). The app matches against existing vendors and falls back to putting the vendor name in the transaction description.

## System components

```
┌─────────────────────────── iPhone ───────────────────────────┐
│                                                              │
│  Onboarding (first run only)                                 │
│  storage choice → API keys → Wave setup → health check       │
│  ────────────────────────────────────────────────────────    │
│                                                              │
│  Capture          Extraction        Review        Upload     │
│  (VisionKit    →  (Claude API    →  (confirm/  →  (Wave      │
│   doc scanner)     vision call)      correct)      GraphQL)  │
│        │               │                              │      │
│        └── every failure path → flagged receipt +            │
│            in-app banner / local notification                │
│                                                              │
│      Local index: SQLite/SwiftData (status, queue, errors)   │
│      Files: user-chosen root (On My iPhone | iCloud Drive)   │
│             Receipts/YYYY-MM/… (image + JSON sidecar)        │
└───────────────────────────────┬──────────────────────────────┘
                                │ (iCloud choice only)
                                ▼
                  Any of the user's other devices / Mac
```

**1. First-run onboarding wizard.** Four steps, then never seen again:

1. **Storage location** — "On My iPhone" or "iCloud Drive". Both use the same `Receipts/YYYY-MM/` layout; iCloud additionally syncs the archive to the user's other devices and survives phone loss. Changeable later in Settings, and the app migrates the existing archive when switched.
2. **Claude API key** — pasted in, stored in the iOS Keychain, validated immediately with a minimal test call. A clear error ("key invalid" vs "no billing/credit on the account") if validation fails.
3. **Wave access token** — pasted in, stored in Keychain, validated by fetching the business list. The user then picks their business, and the app auto-discovers the sales tax (HST) id and default expense account, with a picker if there's more than one candidate.
4. **Health check + permissions** — camera and notification permissions requested, one end-to-end dry run confirmed (Claude reachable, Wave reachable, storage writable). The user lands on the capture screen ready to snap their first receipt.

Because credentials are user-supplied at onboarding, nothing secret ships in the app binary.

**2. Capture module.** Apple's `VNDocumentCameraViewController` (VisionKit) gives edge detection, perspective correction, de-skew, and lighting correction for free — this is the image-processing step, done on-device before anything is sent anywhere. The image is saved to the archive **immediately**, before extraction is attempted, so a failure later in the pipeline can never lose a receipt.

**3. Extraction module.** The cleaned image goes to the Claude API (vision) with a structured-output prompt returning JSON:

```json
{
  "receipt_date": "2026-08-14",
  "vendor": "Home Depot",
  "items": [{"description": "Drill bits", "amount": 22.99}],
  "summary_description": "Drill bits and fasteners",
  "subtotal": 40.02,
  "taxes": [{"type": "HST", "rate": 0.13, "amount": 5.20}],
  "total": 45.22,
  "currency": "CAD",
  "confidence": "high"
}
```

The prompt is Canada-aware (HST/GST/PST breakdowns). Low confidence, or arithmetic that doesn't reconcile (subtotal + taxes ≠ total), flags the receipt for closer review rather than failing.

**4. Review screen.** Extracted fields shown beside the image; every field editable; one tap to approve. This is a deliberate human checkpoint before anything reaches the books. Correcting the date here also determines which monthly folder the receipt files into.

**5. Archive + monthly organization.** Both the image and its structured data (JSON sidecar) live in the user-chosen root. With iCloud selected, the app's container is exposed via `LSSupportsOpeningDocumentsInPlace`, so the folder tree is browsable in the Files app and on any Mac signed into the same iCloud account — no custom sync code. Layout:

```
Receipts/
  2026-07/
    2026-07-03_canadian-tire_31.63.heic
    2026-07-03_canadian-tire_31.63.json     ← extraction sidecar + upload status
  2026-08/
    2026-08-14_home-depot_45.22.heic
    2026-08-14_home-depot_45.22.json
```

Foldering is by **receipt date** (from the extraction), not capture date — a receipt photographed Sept 2 for an Aug 30 purchase files under `2026-08`. If the date is edited at review, the app re-files automatically.

*Testing arrangement:* during development on Thomas's own devices, the iCloud option makes the archive appear in iCloud Drive on the Mac, and a symlink (or moving the container) points it at `Documents/Claude/Viewpoint` so this session can see the results. The end user never needs this.

**6. Local index (SQLite via SwiftData).** One row per receipt: id, file path, receipt date, vendor, total, tax, status (`captured → extracted → reviewed → uploaded / needs-attention / failed`), last error message, retry count, Wave transaction id, image hash (duplicate detection). The index drives the history list, the upload queue, and the "needs attention" badge; files + sidecars alone can rebuild it, so the folder archive stays the source of truth.

**7. Wave upload module.** A Swift port of wave_mcp's core calls against Wave's public GraphQL endpoint: `businesses` query (business picked at onboarding), `salesTaxes` query (HST id cached), expense-accounts query (default account, overridable per receipt), `vendors` search (optional match on extracted vendor), and `moneyTransactionCreate` (date, description, total, expense account, sales tax id). A receipt is marked `uploaded` only when Wave returns a transaction id, which is stored in the index and sidecar for traceability.

## Error handling, checks, and notifications

This is a core feature, not polish — the user must always know if a receipt didn't make it into Wave, without having to go looking.

**Principles.** The image is persisted before any network step, so no failure loses a receipt. Every receipt has an explicit status, and anything not `uploaded` is visible. Errors are shown in plain language with a one-tap retry — never a raw API error alone.

**Extraction (Claude API) failures.** No connectivity → receipt waits in `captured` state and retries automatically when the network returns. API errors are distinguished and explained: invalid/expired key ("check your Claude API key in Settings"), out of credit ("your Claude account needs a top-up"), rate limit (auto-retry with backoff), unreadable image ("couldn't read this receipt — retake or enter manually"). Manual entry is always available as a fallback, so a Claude outage never blocks bookkeeping.

**Validation checks before upload.** Arithmetic reconciliation (subtotal + taxes = total, within a cent), date sanity (not in the future, warn if >1 year old), duplicate warning (same hash, or same date+vendor+total already recorded), currency check (non-CAD flagged rather than silently uploaded).

**Wave upload failures.** Uploads run through a persistent queue with exponential backoff, so receipts snapped offline all week upload when connectivity returns. Failures are classified: expired/revoked token ("reconnect Wave in Settings"), Wave API outage (keep retrying quietly), rejected transaction (surface Wave's reason, hold for review). When automatic retries are exhausted, the app sends a **local push notification** ("1 receipt failed to upload to Wave — tap to review") and badges the app icon. A status line on the home screen always shows the queue at a glance: *"12 uploaded · 1 pending · 1 needs attention."*

**Background self-checks.** On each app open (and periodically via background refresh): Wave token still valid, Claude key still valid, storage location reachable (iCloud signed in, disk not full). Any degraded check shows a persistent, dismissable banner naming the fix.

## What the end user needs (out-of-the-box requirements)

The app is self-contained — no server, no Mac, no developer tools for the user. Their complete list:

1. **An iPhone** on a recent iOS (target iOS 17+, which covers iPhone XS/XR and newer).
2. **A Claude API key** with billing enabled — they have this. Running cost is roughly a cent or two per receipt. The key is pasted once at onboarding.
3. **A Wave full-access token** — they have this. Pasted once at onboarding; the app discovers their business, tax, and accounts by itself.
4. **Optionally, an iCloud account** with free space, only if they choose iCloud storage.
5. **Optionally, vendors created in Wave's web UI** for any merchants they want transactions formally linked to a vendor record (Wave's API can't create vendors). Skipping this still works — the vendor name goes in the transaction description.

**The one requirement that falls on Thomas, not the user: app distribution.** An iOS app must be signed to run on someone else's phone, and this is the main obstacle to "install once and forget":

- **Free Apple account + Xcode install:** app expires every **7 days**. Not viable.
- **Apple Developer Program (US$99/yr) + TestFlight:** easy installs and updates, but each build expires after **90 days**, so Thomas must push a fresh build a few times a year — mostly self-sustaining, not fully.
- **Apple Developer Program + App Store (can be "unlisted" — real store install via a private link, invisible in search):** passes review once, then **never expires** and updates only when Thomas chooses. This is the only truly set-and-forget option and the recommended end state.

Practical path: TestFlight during development and early use, then an unlisted App Store release once the app is stable. Either way the Developer Program membership (US$99/yr) is required.

## Build phases (for when we start coding)

1. **Capture + archive + onboarding storage choice** — scanner, monthly foldering, Files/iCloud visibility. Usable on day one as a filing tool.
2. **Extraction + review** — Claude key onboarding step, vision integration, sidecar JSONs, re-file by receipt date, extraction error handling.
3. **Wave upload + notifications** — Wave onboarding step, transaction creation, persistent retry queue, failure notifications, home-screen status line, background health checks.
4. **Polish + handoff** — duplicate detection, history/search, monthly totals, Settings (change storage/keys), TestFlight distribution to the end user.

Each phase leaves a working app; the end user's credentials and API costs only enter at their own onboarding.

## Open decisions (not blocking)

Whether to categorize expenses beyond one default account (Wave supports per-transaction accounts — a vendor→category mapping could come later); whether receipts should ever auto-upload without the review tap once extraction confidence is trusted (recommend keeping the review tap permanently for accounting hygiene); and when to make the TestFlight→unlisted-App-Store jump.
