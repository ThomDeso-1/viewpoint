import crypto from 'crypto';
import { updateEnvConfig } from './env-config.js';
import { getConfig, getDb, setConfig } from '../db/db.js';

/**
 * Symmetric encryption for data at rest.
 *
 * Used for the fields that must never sit in the SQLite file as plaintext:
 * patient health card numbers, stored OAuth access/refresh tokens, and raw
 * OHIP responses. Everything is AES-256-GCM, so each value carries its own
 * authentication tag and tampering is detected on decrypt rather than
 * silently returning garbage.
 *
 * The key lives in `.env` as DATA_ENCRYPTION_KEY alongside every other
 * credential (mode 0600, written by env-config.ts) and is generated on
 * first use. Deliberately Node's built-in crypto — no new dependency.
 */

const ALGORITHM = 'aes-256-gcm';
const KEY_ENV_VAR = 'DATA_ENCRYPTION_KEY';
const KEY_BYTES = 32;
const IV_BYTES = 12; // 96-bit nonce, the size GCM is specified for
const VERSION = 'v1'; // lets the format change later without ambiguity

let cachedKey: Buffer | null = null;

/**
 * app_config key holding an HMAC of the encryption key — enough to tell
 * "same key" from "different key", useless for recovering the key itself.
 */
const FINGERPRINT_CONFIG_KEY = 'encryption_key_fingerprint';

function fingerprint(key: Buffer): string {
  return crypto.createHmac('sha256', key).update('viewpoint:key-check:v1').digest('hex');
}

/**
 * True if any `*_enc` column in the database holds a value. Catches
 * installs that encrypted data before fingerprints were recorded.
 */
function databaseHasEncryptedData(): boolean {
  const db = getDb();
  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
    .all() as { name: string }[];
  for (const { name } of tables) {
    const cols = db.prepare(`PRAGMA table_info("${name}")`).all() as { name: string }[];
    for (const col of cols.filter((c) => c.name.endsWith('_enc'))) {
      if (db.prepare(`SELECT 1 FROM "${name}" WHERE "${col.name}" IS NOT NULL LIMIT 1`).get()) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Returns the install's encryption key, generating and persisting one the
 * first time it's needed.
 *
 * Regenerating this key makes every existing encrypted value permanently
 * unreadable, so it is only ever created when absent — never rotated
 * implicitly. And "absent" is checked against the database, not just
 * `.env`: if `.env` was lost, restored from an old copy, or the server was
 * started with a different one, the database's stored fingerprint (or its
 * encrypted data) says a key already exists. Minting a fresh key then
 * would effectively wipe every health card number, token and extraction —
 * and new rows written under it would leave the database split across two
 * keys — so this throws instead, and the fix is to restore `.env`.
 */
export function getEncryptionKey(): Buffer {
  if (cachedKey) return cachedKey;

  const stored = getConfig(FINGERPRINT_CONFIG_KEY);
  const existing = process.env[KEY_ENV_VAR];
  if (existing) {
    const key = Buffer.from(existing, 'base64');
    if (key.length !== KEY_BYTES) {
      throw new Error(
        `${KEY_ENV_VAR} must be ${KEY_BYTES} base64-encoded bytes (got ${key.length}). ` +
          `If this was truncated or edited by hand, restore the original value — ` +
          `a different key cannot decrypt existing data.`,
      );
    }
    const fp = fingerprint(key);
    if (stored && stored !== fp) {
      throw new Error(
        `${KEY_ENV_VAR} in .env is not the key this database was encrypted with. ` +
          `Restore the original .env (or the original DATA_ENCRYPTION_KEY line) — ` +
          `nothing has been changed, and the existing data is intact.`,
      );
    }
    if (!stored) setConfig(FINGERPRINT_CONFIG_KEY, fp);
    cachedKey = key;
    return key;
  }

  if (stored || databaseHasEncryptedData()) {
    throw new Error(
      `${KEY_ENV_VAR} is missing from .env, but this database already holds data encrypted ` +
        `with it. Refusing to generate a new key, which would make that data unreadable. ` +
        `Restore .env from a backup (it must contain the original ${KEY_ENV_VAR}) and restart.`,
    );
  }

  const generated = crypto.randomBytes(KEY_BYTES);
  const encoded = generated.toString('base64');
  // Writes .env and sets process.env in one step, so the rest of this boot
  // uses the same key that later boots will read back.
  updateEnvConfig({ [KEY_ENV_VAR]: encoded });
  setConfig(FINGERPRINT_CONFIG_KEY, fingerprint(generated));
  cachedKey = generated;
  return generated;
}

/**
 * Boot-time check (`server/index.ts`): loads the key now so a missing or
 * mismatched one stops the server with a clear message at startup, rather
 * than on the first patient read — and records the fingerprint for an
 * install that predates it.
 */
export function verifyEncryptionKey(): void {
  getEncryptionKey();
}

/** Encrypts a string to `v1:<iv>:<tag>:<ciphertext>`, all base64. */
export function encrypt(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    VERSION,
    iv.toString('base64'),
    tag.toString('base64'),
    ciphertext.toString('base64'),
  ].join(':');
}

/** Reverses `encrypt`. Throws if the blob was tampered with or truncated. */
export function decrypt(blob: string): string {
  const parts = blob.split(':');
  if (parts.length !== 4) {
    throw new Error('Encrypted value is malformed.');
  }

  const [version, ivB64, tagB64, ciphertextB64] = parts;
  if (version !== VERSION) {
    throw new Error(`Unsupported encrypted value version: ${version}`);
  }

  const key = getEncryptionKey();
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));

  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

/** Encrypts only when there's something to encrypt. */
export function encryptOptional(plaintext: string | null | undefined): string | null {
  return plaintext ? encrypt(plaintext) : null;
}

/** Decrypts only when there's something to decrypt. */
export function decryptOptional(blob: string | null | undefined): string | null {
  return blob ? decrypt(blob) : null;
}

/**
 * Drops the in-process key cache. Tests rebuild the module graph between
 * cases and need the next getEncryptionKey() to re-read the environment.
 */
export function resetKeyCache(): void {
  cachedKey = null;
}
