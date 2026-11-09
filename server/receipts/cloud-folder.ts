import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Where receipts are stored when the operator picks their own cloud service.
 *
 * Deliberately not a cloud integration: iCloud has no API a server can
 * call, and the desktop apps for iCloud Drive, Google Drive, Dropbox and
 * OneDrive all sync an ordinary folder on this Mac. So the app copies
 * files into that folder and the operator's already-signed-in Mac does the
 * rest. No sign-in screen, no tokens, nothing to expire, and no credential
 * of theirs ever reaches this app.
 *
 * Only folders found here can be chosen — the route takes an option id,
 * never a path — so a request can't aim file writes elsewhere on the disk.
 */

/** Our folder inside the chosen service, so we never scatter files at its root. */
export const CLOUD_SUBFOLDER = 'Viewpoint Receipts';

export interface CloudOption {
  id: string;
  label: string;
  /** Absolute path of our folder inside the service. Never sent to the client. */
  dir: string;
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** "GoogleDrive-a@b.com" → label and the folder within it that is writable. */
function describeCloudStorageEntry(name: string): { label: string; inner: string } | null {
  const [provider, ...rest] = name.split('-');
  const account = rest.join('-');
  const suffix = account ? ` (${account})` : '';
  switch (provider) {
    case 'GoogleDrive':
      // The root of a Google Drive mount is read-only; files go in "My Drive".
      return { label: `Google Drive${suffix}`, inner: 'My Drive' };
    case 'OneDrive':
      return { label: `OneDrive${suffix}`, inner: '' };
    case 'Dropbox':
      return { label: `Dropbox${suffix}`, inner: '' };
    case 'Box':
      return { label: 'Box', inner: '' };
    default:
      return null;
  }
}

/** The cloud services set up on this Mac. Resolved per call: one may appear later. */
export function cloudFolderOptions(): CloudOption[] {
  const options: CloudOption[] = [];
  const library = path.join(os.homedir(), 'Library');

  const icloud = path.join(library, 'Mobile Documents', 'com~apple~CloudDocs');
  if (isDirectory(icloud)) {
    options.push({ id: 'icloud', label: 'iCloud Drive', dir: path.join(icloud, CLOUD_SUBFOLDER) });
  }

  const cloudStorage = path.join(library, 'CloudStorage');
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(cloudStorage).sort();
  } catch {
    // No such folder on this machine — iCloud (or nothing) is the whole list.
  }
  for (const name of entries) {
    const described = describeCloudStorageEntry(name);
    if (!described) continue;
    const root = path.join(cloudStorage, name, described.inner);
    if (isDirectory(root)) {
      options.push({ id: name, label: described.label, dir: path.join(root, CLOUD_SUBFOLDER) });
    }
  }
  return options;
}

/** The chosen folder, or null while receipts stay on this Mac only. */
export function cloudDir(): string | null {
  return process.env.RECEIPTS_CLOUD_DIR || null;
}

/** The folder receipts are still being moved out of after a switch, if any. */
export function previousCloudDir(): string | null {
  return process.env.RECEIPTS_CLOUD_PREVIOUS_DIR || null;
}

/**
 * Before macOS 14 (Darwin 23) iCloud swapped offloaded files for hidden
 * `.icloud` stubs that can't be opened. With iCloud as the only copy, the
 * app couldn't show those receipts, so that combination is refused.
 */
export function icloudStorageSupported(): boolean {
  return process.platform !== 'darwin' || Number(os.release().split('.')[0]) >= 23;
}

/**
 * Create our folder inside the service and confirm it can be read.
 * Refuses when the service's own folder has gone (signed out of iCloud,
 * app removed) rather than recreating that path as a plain folder nothing
 * would ever sync.
 */
export function ensureCloudFolder(dir: string): void {
  if (!isDirectory(path.dirname(dir))) {
    throw Object.assign(new Error('cloud folder missing'), { code: 'ENOENT' });
  }
  fs.mkdirSync(dir, { recursive: true });
  // A privacy block makes existsSync say "not there", so test it directly.
  fs.readdirSync(dir);
}

/** Prove we can write there. Returns an operator-readable problem, or null. */
export function probeCloudFolder(dir: string): string | null {
  const probe = path.join(dir, `.viewpoint-write-test-${process.pid}`);
  try {
    ensureCloudFolder(dir);
    fs.writeFileSync(probe, '');
    fs.rmSync(probe, { force: true });
    return null;
  } catch (err) {
    return describeCloudError(err);
  }
}

/** Plain-language cause, so the raw file path and errno stay off the screen. */
export function describeCloudError(err: unknown): string {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'EPERM' || code === 'EACCES') {
    return 'This Mac is blocking Viewpoint from that folder. In System Settings → Privacy & Security → Files & Folders, allow node to use it, then try again.';
  }
  if (code === 'ENOSPC' || code === 'EDQUOT') {
    return 'There is not enough space to move the receipts.';
  }
  if (code === 'ENOENT') {
    return "That cloud folder isn't available on this Mac. Check that you're still signed in to the service.";
  }
  return "Receipts couldn't be moved to the cloud folder. Viewpoint will keep trying.";
}

// Module-level because the poller and the routes hold separate
// StorageService instances, and the routes are what report it.
let lastCloudError: string | null = null;

export function getCloudError(): string | null {
  return lastCloudError;
}

export function setCloudError(message: string | null): void {
  lastCloudError = message;
}
