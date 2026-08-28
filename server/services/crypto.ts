import crypto from 'crypto';
import { updateEnvConfig } from './env-config.js';

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
 * Returns the install's encryption key, generating and persisting one the
 * first time it's needed.
 *
 * Regenerating this key makes every existing encrypted value permanently
 * unreadable, so it is only ever created when absent — never rotated
 * implicitly.
 */
export function getEncryptionKey(): Buffer {
  if (cachedKey) return cachedKey;

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
    cachedKey = key;
    return key;
  }

  const generated = crypto.randomBytes(KEY_BYTES);
  const encoded = generated.toString('base64');
  // Writes .env and sets process.env in one step, so the rest of this boot
  // uses the same key that later boots will read back.
  updateEnvConfig({ [KEY_ENV_VAR]: encoded });
  cachedKey = generated;
  return generated;
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
