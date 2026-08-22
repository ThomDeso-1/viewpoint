# Deployment Guide

Viewpoint Receipts is a single-user app — one server, one person, no scaling
concerns. This guide covers running it somewhere it'll stay reachable from
your phone, with HTTPS (required for full PWA install on iOS) and a backup
plan for the data it accumulates.

## Where to run it

Pick one:

- **A spare always-on machine** (Raspberry Pi, old laptop, Mac mini) on your
  home network, reachable via [Tailscale](https://tailscale.com) from
  anywhere. No public ports, and Tailscale can issue you a real HTTPS cert
  for your `*.ts.net` hostname (`tailscale cert`) — no domain needed.
- **A cheap VPS** ($5/mo tier from any provider) with a domain pointed at it.
  Simplest path to "just works from anywhere."
- **Your own laptop**, if you only ever capture receipts on your home Wi-Fi.
  Works, but the app is only usable while the laptop is on and running the
  server.

Either way you need: Node.js 20+, and a way to keep the process running
(Docker, or systemd — both covered below).

## Option A: Docker

```bash
git clone <this repo> viewpoint-receipts
cd viewpoint-receipts
touch .env                # credentials get written here by the setup wizard
docker compose up -d --build
```

The `docker-compose.yml` mounts `./data` (the SQLite DB + receipt photos)
and `./.env` (credentials) from the host, so both survive container
rebuilds. Check logs with `docker compose logs -f`.

To update after pulling new code: `docker compose up -d --build`.

## Option B: systemd (no Docker)

See [`deploy/viewpoint-receipts.service`](deploy/viewpoint-receipts.service)
for the full unit file and setup commands. In short:

```bash
sudo useradd --system --home /opt/viewpoint-receipts --shell /usr/sbin/nologin viewpoint
sudo cp -r . /opt/viewpoint-receipts && cd /opt/viewpoint-receipts
sudo -u viewpoint npm install
sudo -u viewpoint bash -c "cd client && npm install"
sudo -u viewpoint npm run build
sudo chown -R viewpoint:viewpoint /opt/viewpoint-receipts
sudo cp deploy/viewpoint-receipts.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now viewpoint-receipts
```

`systemctl status viewpoint-receipts` and `journalctl -u viewpoint-receipts -f`
for logs.

## HTTPS (reverse proxy)

The server listens on plain HTTP on port 3000. iOS Safari requires HTTPS
(or `localhost`) for the service worker and full "Add to Home Screen"
behavior, so put a reverse proxy in front of it in any deployment reachable
by anything other than `localhost`.

**Caddy** (recommended — automatic cert issuance and renewal, ~5 lines of
config): see [`deploy/Caddyfile`](deploy/Caddyfile). Point a domain's A
record at the server, install Caddy, drop in the Caddyfile, done.

**nginx + certbot**: see
[`deploy/nginx.conf.example`](deploy/nginx.conf.example) for a config plus
the certbot commands to obtain the cert.

**Tailscale**: if you're not exposing the server publicly, `tailscale cert`
gets you a real Let's Encrypt certificate for your Tailnet hostname with no
reverse proxy needed at all — point the app directly at
`https://<machine>.<tailnet>.ts.net:443` (Tailscale Serve can also forward
443 → 3000 for you: `tailscale serve --bg 3000`).

Whichever proxy you use, make sure it allows request bodies up to ~25MB —
receipt photo uploads can be several MB each and multer's default limit is
20MB per file, 10 files per request.

## Backups

Two things need backing up: `data/receipts.db` (the SQLite database) and
`data/Receipts/` (the actual photos). Losing either one is bad — the DB
without the photos is useless, and the photos without the DB lose all
extracted/reviewed data.

Requires the `sqlite3` CLI (`apt install sqlite3` / `brew install sqlite3`)
— if you're running under Docker, run the script on the **host**, not
inside the container; `docker-compose.yml` bind-mounts `./data` from the
host, so the default `DATA_DIR=./data` already points at the same files.

[`scripts/backup.sh`](scripts/backup.sh) does both in one shot:

```bash
./scripts/backup.sh
# → backups/viewpoint-receipts-20260821-140000.tar.gz
```

It uses `sqlite3 <db> ".backup ..."` rather than copying the `.db` file
directly — the server runs SQLite in WAL mode, so a raw file copy can grab
the database mid-write. `.backup` is safe to run against a live database.

Run it on a schedule with cron:

```bash
# crontab -e
0 2 * * * cd /opt/viewpoint-receipts && ./scripts/backup.sh >> /var/log/viewpoint-backup.log 2>&1
```

By default it keeps 30 days of local backups and prunes older ones. For
real durability (surviving the machine itself failing), uncomment one of
the off-site copy lines at the bottom of the script — `rclone` (to
S3/Backblaze/Drive/etc.) or `rsync` to another machine both work.

**Restoring**: stop the server, extract the tarball, replace
`data/receipts.db` and `data/Receipts/` with the extracted copies, restart.

```bash
tar -xzf backups/viewpoint-receipts-20260821-140000.tar.gz -C /tmp/restore
cp /tmp/restore/receipts.db data/receipts.db
rsync -a --delete /tmp/restore/Receipts/ data/Receipts/
```
