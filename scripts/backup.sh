#!/usr/bin/env bash
set -euo pipefail

# Backs up the SQLite database and the receipt image tree into a single
# timestamped tarball. Uses `sqlite3 .backup` rather than copying the .db
# file directly, since the server keeps it open in WAL mode.
#
# Requires the sqlite3 CLI (apt install sqlite3 / brew install sqlite3) —
# not the same thing as the better-sqlite3 npm package the app itself uses.
#
# Usage:
#   ./scripts/backup.sh
#   DATA_DIR=/app/data BACKUP_DIR=/mnt/backups ./scripts/backup.sh
#
# Cron example (daily at 2am, keep last 30 days):
#   0 2 * * * cd /opt/viewpoint-receipts && ./scripts/backup.sh >> /var/log/viewpoint-backup.log 2>&1

DATA_DIR="${DATA_DIR:-./data}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
WORKDIR=$(mktemp -d)
trap 'rm -rf "$WORKDIR"' EXIT

if [ ! -f "$DATA_DIR/receipts.db" ]; then
  echo "No database found at $DATA_DIR/receipts.db — nothing to back up." >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"

sqlite3 "$DATA_DIR/receipts.db" ".backup '$WORKDIR/receipts.db'"
cp -r "$DATA_DIR/Receipts" "$WORKDIR/Receipts" 2>/dev/null || mkdir -p "$WORKDIR/Receipts"

ARCHIVE="$BACKUP_DIR/viewpoint-receipts-$TIMESTAMP.tar.gz"
tar -czf "$ARCHIVE" -C "$WORKDIR" receipts.db Receipts

echo "Backup written to $ARCHIVE ($(du -h "$ARCHIVE" | cut -f1))"

# Prune old backups
find "$BACKUP_DIR" -name 'viewpoint-receipts-*.tar.gz' -mtime "+$RETENTION_DAYS" -delete

# Optional off-site copy — uncomment and configure one of these if you want
# backups to survive the machine itself failing:
#
#   rclone copy "$ARCHIVE" remote:viewpoint-receipts-backups
#   rsync -av "$ARCHIVE" user@backup-host:/backups/viewpoint-receipts/
