# Getting Started with Viewpoint Receipts

This app photographs your business receipts, reads the vendor/date/total
off them automatically, and (once you approve each one) uploads them to
Wave as expenses. It runs on a computer you keep on and connected to
Wi-Fi, and you use it from your iPhone's browser like an app.

Setup takes about 15 minutes, once.

## What you'll need

- A Mac or Windows computer that can stay on and connected to Wi-Fi
  (this is where the app actually runs — your iPhone just talks to it)
- A Claude API key ([console.anthropic.com](https://console.anthropic.com) →
  Settings → API Keys → Create Key). You'll need a payment method on that
  account — extraction costs a fraction of a cent per receipt.
- A Wave access token, if you want automatic uploads to Wave (Wave →
  Settings → API Access → Create a token). You can skip this during setup
  and add it later — receipts will just sit there until you connect Wave.

## Step 1 — Install Docker Desktop

This is the only software you need to install. It's what runs the app.

- Mac: [docker.com/products/docker-desktop](https://www.docker.com/products/docker-desktop/) → download for Mac → open it and follow the installer.
- Windows: same link → download for Windows → open it and follow the installer.

Once installed, open Docker Desktop and leave it running. In Docker Desktop's
settings, turn on **"Start Docker Desktop when you log in"** — this makes
sure the app comes back automatically after you restart your computer.

## Step 2 — Unzip the app

You should have a file called `viewpoint-receipts-bundle.zip`. Unzip it
somewhere you'll remember — your Desktop or Documents folder is fine. This
gives you a folder called `viewpoint-receipts`.

## Step 3 — Start it

**On a Mac**: open the `viewpoint-receipts` folder and double-click
**`start.command`**. A black window will open and show some text — that's
normal, leave it running. The first time, it'll take a minute or two to set
itself up.

**On Windows**: open the `viewpoint-receipts` folder and double-click
**`start.bat`**.

When it says "Started!", the app is running.

> If Windows or macOS warns that the file is from an unidentified developer,
> that's expected for a script you were sent directly (not from an app
> store) — right-click it and choose "Open" to run it anyway.

## Step 4 — Open the app and set a password

On the same computer, open a web browser and go to:

```
http://localhost:3000
```

The first thing you'll see is a screen to set a password. This is the
password you'll use to log in from your iPhone too — pick something you'll
remember.

## Step 5 — Connect Claude and Wave

Right after setting your password, the app will ask for:

1. **Your Claude API key** — paste it in, it validates automatically.
2. **Your Wave access token** — paste it in, pick which Wave business,
   which account to record expenses against, and which bank/credit card
   the expenses are "paid from."

You can hit **"Skip for now"** on either step and add it later from the
Settings page in the app.

## Step 6 — Add it to your iPhone's home screen

Your iPhone needs to be on the **same Wi-Fi network** as the computer.

1. On the computer, find its network address:
   - **Mac**: System Settings → Wi-Fi → click the (i) next to your network → note the IP address (looks like `192.168.1.42`).
   - **Windows**: open Command Prompt, type `ipconfig`, look for "IPv4 Address" (also looks like `192.168.1.42`).
2. On your iPhone, open **Safari** and go to `http://<that address>:3000` (e.g. `http://192.168.1.42:3000`).
3. Log in with the password from Step 4.
4. Tap the Share button (square with an arrow) → **Add to Home Screen**.

Now there's an app icon on your home screen. Tap it any time to open the
receipt camera.

> This works over your home Wi-Fi right away. If you also want to reach it
> from outside your Wi-Fi (e.g. capturing a receipt while out), or want the
> full offline-capable installed-app experience, that needs a one-time
> HTTPS setup — ask Thomas, it's a quick add-on covered in `DEPLOYMENT.md`.

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

## Stopping / restarting

You generally don't need to do anything — once started, the app keeps
running in the background, and Docker Desktop restarts it automatically
if your computer reboots (as long as Docker Desktop itself is set to start
at login, from Step 1).

- To stop it: double-click `stop.command` (Mac) or `stop.bat` (Windows).
- To start it again: double-click `start.command` / `start.bat` again —
  it's safe to run any time, and won't lose your password or settings.

## Troubleshooting

- **"Docker isn't installed yet"** when starting → Docker Desktop isn't
  running. Open it from Applications (Mac) or the Start Menu (Windows) and
  wait for it to say "Docker Desktop is running," then try again.
- **Can't reach it from your iPhone** → double check the iPhone is on the
  *same* Wi-Fi network as the computer, and that you're using the
  computer's IP address (not `localhost`) in Safari.
- **Forgot your password** → there's no reset button by design (nothing
  syncs to the cloud). Ask Thomas — the password can be cleared directly
  in the database.
- **Something else looks broken** → send Thomas a screenshot. The app
  keeps its own logs, so most issues can be diagnosed remotely.

Your receipts and data live entirely on this computer, in the
`viewpoint-receipts/data` folder — nothing is sent anywhere except to
Claude (to read the receipt) and Wave (to record the expense).
