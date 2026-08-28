CREATE TABLE IF NOT EXISTS receipts (
  id              TEXT PRIMARY KEY,
  primary_image   TEXT NOT NULL,
  additional_images TEXT DEFAULT '[]',
  receipt_date    TEXT NOT NULL,
  capture_date    TEXT NOT NULL,
  month_folder    TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'captured',
  vendor          TEXT,
  summary         TEXT,
  total_amount    REAL,
  tax_amount      REAL,
  currency        TEXT DEFAULT 'CAD',
  extracted_json  TEXT,
  wave_txn_id     TEXT,
  last_error      TEXT,
  retry_count     INTEGER DEFAULT 0,
  image_hash      TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_receipts_status ON receipts(status);
CREATE INDEX IF NOT EXISTS idx_receipts_month  ON receipts(month_folder);
CREATE INDEX IF NOT EXISTS idx_receipts_hash   ON receipts(image_hash);

CREATE TABLE IF NOT EXISTS app_config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
