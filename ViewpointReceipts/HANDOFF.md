# Viewpoint Receipts — Handoff Guide

## What the app does

Viewpoint Receipts photographs business receipts, extracts structured data (date, vendor, total, taxes) using Claude's vision API, organizes images and JSON sidecars into monthly folders, and uploads transactions to Wave accounting. The end user brings their own Claude API key and Wave access token — no server or developer involvement needed after setup.

## Building the project

### Prerequisites

- **Xcode 15+** (for iOS 17 / Swift 5.9 support)
- **XcodeGen** — install via Homebrew: `brew install xcodegen`
- **Apple Developer Program** ($99/yr) for signing and distribution

### First-time setup

```bash
cd ViewpointReceipts
xcodegen generate       # creates ViewpointReceipts.xcodeproj from project.yml
open ViewpointReceipts.xcodeproj
```

In Xcode, set your **Team** under Signing & Capabilities (the `DEVELOPMENT_TEAM` field in `project.yml` is blank — Xcode fills it from your Apple ID).

Build target: **iPhone** (physical device or simulator). The app is iPhone-only, portrait.

### Project structure

```
ViewpointReceipts/
  App/                    ViewpointReceiptsApp.swift (entry point)
  Models/                 Receipt.swift, AppSettings.swift, ExtractionResult.swift
  Services/               StorageService, ClaudeAPIService, WaveAPIService,
                          UploadService, NotificationService, HealthCheckService,
                          KeychainService
  Views/
    Capture/              DocumentScannerView (VisionKit wrapper)
    Onboarding/           StorageChoiceView, APIKeySetupView, WaveSetupView
    Receipts/             ReceiptListView, ReceiptDetailView
    Review/               ReceiptReviewView
    Settings/             SettingsView
  Resources/              Info.plist, entitlements, asset catalog
project.yml               XcodeGen spec
```

## Distributing to the end user

### Option A: TestFlight (recommended for early use)

1. In Xcode: Product → Archive.
2. In the Organizer: Distribute App → App Store Connect (even for TestFlight).
3. In App Store Connect, add the end user as a tester (internal or external).
4. They install via the TestFlight app on their iPhone.

**Limitation:** each build expires after 90 days. Push a fresh archive a few times a year, or move to Option B.

### Option B: Unlisted App Store (set-and-forget)

1. Create the app in App Store Connect.
2. Under Distribution → Availability, set it to **Unlisted** — it won't appear in App Store search but installs via a direct link.
3. Submit for review. Once approved, share the install link with the end user.
4. Updates only happen when you choose to push a new version.

This is the only option where the app never expires and requires no recurring action.

## What the end user needs

1. An iPhone (iOS 17+, so iPhone XS/XR or newer).
2. A **Claude API key** with billing enabled — roughly 1–2 cents per receipt.
3. A **Wave full-access token** for their business account.
4. Optionally, an iCloud account if they choose iCloud storage.
5. Optionally, vendors pre-created in Wave's web UI (Wave's API can't create vendors; the app falls back to putting the vendor name in the transaction description).

## How the app works for the end user

**First launch:** three-step onboarding — choose storage (device or iCloud), paste Claude API key, paste Wave token. The app validates each credential, discovers the Wave business/accounts/tax, and lands on the receipt list.

**Day-to-day:** tap the camera button, scan a receipt, review the extracted data (all fields editable), tap Approve. The app queues the transaction for Wave upload automatically. A status bar at the bottom shows uploaded/pending/failed counts. Failed uploads retry with exponential backoff and send a push notification if retries are exhausted.

**Settings:** gear icon → view connection status, retry failed uploads, disconnect Wave, remove Claude key.

## Architecture notes

- **Images are saved before extraction** — no network failure can lose a receipt.
- **SwiftData** backs the local receipt index. The monthly folder archive (images + JSON sidecars) is the source of truth and can rebuild the index.
- **Keychain** stores both API credentials with `kSecAttrAccessibleAfterFirstUnlock`.
- **Wave transactions** use `externalId` for idempotency — the same receipt won't create duplicate transactions.
- **Health checks** run on every app foreground: validates both API credentials and iCloud availability, surfaces a dismissable banner if anything is degraded.
- **Duplicate detection** warns (but doesn't block) when a receipt matches an existing one by image hash or by date+vendor+total.

## Bundle identifiers

- App: `com.viewpoint.receipts`
- iCloud container: `iCloud.com.viewpoint.receipts`

## What's not included

- **Receipt image attachment to Wave transactions** — Wave's API doesn't support this. The monthly folder archive is the image record.
- **Vendor creation** — Wave's API is read-only for vendors. The end user creates vendors in Wave's web UI; the app matches by name.
- **Background refresh** — health checks and upload queue processing run on app foreground. iOS background tasks could be added later for fully offline-first upload queueing.
- **iPad / landscape** — iPhone-only, portrait, by design.
