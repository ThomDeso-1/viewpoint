import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let db: Database.Database;

export function getDb(): Database.Database {
  if (db) return db;

  const dataDir = process.env.DATA_DIR || './data';
  fs.mkdirSync(dataDir, { recursive: true });

  const dbPath = path.join(dataDir, 'receipts.db');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Run schema
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
  db.exec(schema);

  return db;
}

// ── Receipt types ──

export interface ReceiptRow {
  id: string;
  primary_image: string;
  additional_images: string; // JSON array
  receipt_date: string;
  capture_date: string;
  month_folder: string;
  status: string;
  vendor: string | null;
  summary: string | null;
  total_amount: number | null;
  tax_amount: number | null;
  currency: string;
  extracted_json: string | null;
  wave_txn_id: string | null;
  last_error: string | null;
  retry_count: number;
  image_hash: string | null;
  created_at: string;
  updated_at: string;
}

export type ReceiptStatus =
  | 'captured'
  | 'extracted'
  | 'reviewed'
  | 'uploaded'
  | 'needsAttention'
  | 'failed';

// ── Config helpers ──

export function getConfig(key: string): string | undefined {
  const row = getDb().prepare('SELECT value FROM app_config WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

export function setConfig(key: string, value: string): void {
  getDb()
    .prepare('INSERT INTO app_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?')
    .run(key, value, value);
}
