# Getting Started with Viewpoint Receipts

This app photographs your business receipts, reads the vendor/date/total
off them automatically, and (once you approve each one) uploads them to
Wave as expenses. It runs on a computer you keep on and connected to
Wi-Fi, and you use it from your iPhone's browser like an app.

Setup takes about 15 minutes, once.

## What you'll need

- A Mac that can stay on and connected to Wi-Fi
  (this is where the app actually runs — your iPhone just talks to it)
- A Claude API key ([console.anthropic.com](https://console.anthropic.com) →
  Settings → API Keys → Create Key). You'll need a payment method on that
  account — extraction costs a fraction of a cent per receipt.
- A Wave access token, if you want automatic uploads to Wave (Wave →
  Settings → API Access → Create a token). You can skip this during setup
  and add it later — receipts will just sit there until you connect Wave.

There's nothing to install ahead of time — the app sets up everything it
needs (including a private copy of Node.js, if your Mac doesn't already
have a current one) the first time you start it.

## Step 1 — Run the installer

You should have a file called **`ViewpointApp-installer.pkg`** (the latest
one is always on the project's GitHub "Latest build" release). Double-click
it and follow the prompts. It installs the app into
`/Applications/ViewpointApp`.

> **"Apple could not verify…" / "unidentified developer"** — expected, the
> installer isn't signed. Either **right-click** the `.pkg` → **Open**, or
> open **System Settings → Privacy & Security**, scroll down, and click
> **Open Anyway**. Then run it again.
>
> If macOS still won't open it: open Terminal and run
> `sudo installer -pkg ~/Downloads/ViewpointApp-installer.pkg -target /`
> (it'll ask for your Mac password).

## Step 2 — Let it finish setting up

At the end of the installer a **Terminal window opens by itself** and
finishes setup — the first time this takes a minute or two (it downloads a
few packages and builds the app). Leave it alone until it says
**"Started!"**, then you can close that window.

If you were already running an earlier copy of the app by hand, the
installer automatically carries over your password, settings, and all your
data.

> There's also a Docker-based version (`start.command` inside the app
> folder) if you'd rather run it in a container — see Troubleshooting.

## Step 3 — Open the app and set a password

On the same computer, open a web browser and go to:

```
http://localhost:3000
```

The first thing you'll see is a screen to set a password. This is the
password you'll use to log in from your iPhone too — pick something you'll
remember.

## Step 4 — Connect Claude and Wave

Right after setting your password, the app will ask for:

1. **Your Claude API key** — paste it in, it validates automatically.
2. **Your Wave access token** — paste it in, pick which Wave business,
   which account to record expenses against, and which bank/credit card
   the expenses are "paid from."

You can hit **"Skip for now"** on either step and add it later from the
Settings page in the app.

> If you connect (or later reconnect) **Google** for Calendar/reminders, do
> it from a browser **on the Mac** at `http://localhost:3000` — Google only
> allows the sign-in to come back to `localhost`, not the Tailscale
> address.

## Step 5 — Give it a permanent web address (Tailscale)

This gives the app one fixed `https://…` address that keeps working from
**any** network — home, the shop, or cellular — so the iPhone icon never
breaks. It's a free service called Tailscale that privately links your Mac
and your phone.

**On the Mac:**

1. Install the Tailscale app from <https://tailscale.com/download/mac>,
   open it (menu-bar icon), and **sign in** (a Google/Microsoft/email
   login — remember which account you use).
2. One-time, in your browser: go to
   <https://login.tailscale.com/admin/dns> and turn on both **MagicDNS**
   and **HTTPS Certificates**.
3. Open `/Applications/ViewpointApp` in Finder and double-click
   **`setup-tailscale.command`**. It prints the app's permanent address —
   something like `https://viewpoints-mac.tailXXXX.ts.net`. Write it down.

**On the iPhone:**

4. Install **Tailscale** from the App Store and sign in to the **same
   account** as on the Mac.
5. Open **Safari**, go to the `https://…ts.net` address from step 3, and
   log in with your password.
6. Tap the Share button (square with an arrow) → **Add to Home Screen**.

That icon now works whenever the Mac is **awake and online**, on any
network. (If the Mac is asleep or off, the app is unreachable until it
wakes — it lives on the Mac.)

> **Just want same-Wi-Fi access for now?** Skip this step. On the Mac,
> System Settings → Wi-Fi → (i) next to your network → note the IP
> (e.g. `192.168.1.42`), then on the iPhone open
> `http://192.168.1.42:3000`. This address changes when the network
> changes, so the home-screen icon may stop working later — Tailscale
> above is the permanent fix.

## Using it day to day

1. Tap the **+** button, take a photo of a receipt (or pick one from your
   photo library).
2. The app reads the vendor, date, and total automatically. Check the
   fields, fix anything that's wrong.
3. Tap **Approve & Upload**. It uploads to Wave in the background — you
   don't need to wait around or keep the app open.
4. If something fails to upload (expired Wave token, etc.), you'll see a
   banner on the main screen and can retry from Settings.

Got a stack of receipts to catch up on? On the main screen, tap
**"Review All"** to go through them one after another instead of opening
each one individually.

## Updating

When there's a new version, open `/Applications/ViewpointApp` and
double-click **`update.command`**. It downloads the latest build, keeps all
your data and settings, rebuilds, and restarts — takes about a minute.

Thomas can also run this for you remotely (over Tailscale) without you
doing anything.

## Stopping / restarting

You generally don't need to do anything — the app starts itself
automatically every time you log in to the Mac, and restarts itself on its
own if it ever crashes.

Everything below lives in `/Applications/ViewpointApp` — double-click:

- **`stop-native.command`** — stop it; it stays off until you start it again.
- **`start-native.command`** — start it again; safe to run any time, never
  loses your password or settings.
- **`uninstall.command`** — stop it for good and remove the background
  service (your data folder is left in place).

## Troubleshooting

- **The installer won't open** → see the note in Step 1 (right-click →
  Open, or Privacy & Security → Open Anyway).
- **It fails partway through, or won't start** → open
  `/Applications/ViewpointApp` and double-click `start-native.command`
  again. If it still won't start, check `server.log` in that folder, or
  send it to Thomas. As a fallback, the Docker-based version
  (`start.command` / `stop.command`) still works if you install
  [OrbStack](https://orbstack.dev/) or Docker Desktop.
- **"Something else on this computer is already using port 3000"** → if
  you previously tried the Docker version, quit Docker Desktop (menu bar
  whale icon → "Quit Docker Desktop") and try again.
- **Can't reach it from your iPhone** → make sure the Mac is awake, and
  that Tailscale is signed in and **on** (menu-bar icon) on both the Mac
  and the phone. If you skipped Tailscale, check the iPhone is on the
  *same* Wi-Fi and you're using the Mac's IP address (not `localhost`).
- **The phone address stopped working after changing Wi-Fi** → that's the
  IP-address method. Do Step 5 (Tailscale) for an address that doesn't
  change.
- **Forgot your password** → there's no reset button by design (nothing
  syncs to the cloud). Ask Thomas — the password can be cleared directly
  in the database.
- **Something else looks broken** → send Thomas a screenshot. The app
  keeps its own logs, so most issues can be diagnosed remotely.

Your receipts and data live entirely on this Mac, in
`/Applications/ViewpointApp/data` — nothing is sent anywhere except to
Claude (to read the receipt) and Wave (to record the expense).
