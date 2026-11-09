import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { setupTestApp, fakeImageBytes, type TestContext } from '../helpers/testApp.js';
import { StorageService } from '../../server/receipts/storage.js';
import { CLOUD_SUBFOLDER, cloudFolderOptions, getCloudError } from '../../server/receipts/cloud-folder.js';

/**
 * Spec (docs/SECURITY.md "Personal health information leaves the machine",
 * and the Receipts screen's save-location dialog):
 *  - Choices are the synced folders found on this Mac; there is no sign-in
 *    and the client never sends or sees a filesystem path.
 *  - Receipts are moved, not copied: the Mac keeps a file only until its
 *    cloud copy is verified. Uploads still land locally first, so an
 *    unavailable service can't lose one.
 *  - Switching location brings every file along, and a location that can't
 *    be read is never mistaken for an empty one.
 */
const JPG = { buffer: Buffer.from('photo'), mimetype: 'image/jpeg' };

function makeHome(): { home: string; icloud: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-home-'));
  const icloud = path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs');
  fs.mkdirSync(icloud, { recursive: true });
  return { home, icloud };
}

describe('cloud folder discovery', () => {
  const originalHome = process.env.HOME;
  let home: string;

  beforeEach(() => {
    home = makeHome().home;
    process.env.HOME = home;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('offers iCloud Drive and uses "My Drive" inside a Google Drive mount', () => {
    fs.mkdirSync(path.join(home, 'Library/CloudStorage/GoogleDrive-a@b.com/My Drive'), { recursive: true });
    const options = cloudFolderOptions();
    expect(options.map((o) => o.label)).toEqual(['iCloud Drive', 'Google Drive (a@b.com)']);
    expect(options[1].dir).toBe(
      path.join(home, 'Library/CloudStorage/GoogleDrive-a@b.com/My Drive', CLOUD_SUBFOLDER),
    );
  });

  it('skips services it does not recognise', () => {
    fs.mkdirSync(path.join(home, 'Library/CloudStorage/SomethingElse'), { recursive: true });
    expect(cloudFolderOptions().map((o) => o.id)).toEqual(['icloud']);
  });
});

describe('moving receipts to the cloud folder', () => {
  let dataDir: string;
  let parent: string;
  let cloud: string;
  let storage: StorageService;
  const date = new Date('2026-05-15T12:00:00Z');

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-cloud-data-'));
    parent = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-cloud-'));
    cloud = path.join(parent, CLOUD_SUBFOLDER);
    process.env.ENV_FILE = path.join(dataDir, '.env');
    process.env.RECEIPTS_CLOUD_DIR = cloud;
    storage = new StorageService(dataDir);
  });

  afterEach(() => {
    delete process.env.ENV_FILE;
    delete process.env.RECEIPTS_CLOUD_DIR;
    delete process.env.RECEIPTS_CLOUD_PREVIOUS_DIR;
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(parent, { recursive: true, force: true });
  });

  const local = (rel: string) => path.join(dataDir, 'Receipts', rel);
  const sidecar = (rel: string) => rel.replace('.jpg', '.json');

  function saved(): string {
    const { primaryPath } = storage.saveReceiptImages([JPG], date);
    storage.saveSidecar(primaryPath, { status: 'captured' });
    return primaryPath;
  }

  it('moves the image and sidecar, leaving nothing on the Mac', async () => {
    const rel = saved();
    expect(storage.countWaitingToMove([rel])).toBe(1);
    await storage.syncToCloud([rel]);
    expect(fs.readFileSync(path.join(cloud, rel), 'utf-8')).toBe('photo');
    expect(fs.existsSync(path.join(cloud, sidecar(rel)))).toBe(true);
    expect(fs.existsSync(local(rel))).toBe(false);
    expect(fs.existsSync(local(sidecar(rel)))).toBe(false);
    expect(fs.existsSync(path.dirname(local(rel)))).toBe(false);
    expect(storage.countWaitingToMove([rel])).toBe(0);
  });

  it('still finds a moved image', async () => {
    const rel = saved();
    await storage.syncToCloud([rel]);
    expect(storage.absolutePath(rel)).toBe(path.join(cloud, rel));
    expect(storage.computeImageHash(rel)).toBeTruthy();
  });

  it('lands a sidecar saved after the move on top of the older cloud one', async () => {
    const rel = saved();
    await storage.syncToCloud([rel]);
    storage.saveSidecar(rel, { status: 'reviewed' });
    expect(storage.loadSidecar(rel)).toEqual({ status: 'reviewed' });
    await storage.syncToCloud([rel]);
    expect(fs.readFileSync(path.join(cloud, sidecar(rel)), 'utf-8')).toContain('reviewed');
    expect(fs.existsSync(local(sidecar(rel)))).toBe(false);
  });

  it('re-files a receipt that is already in the cloud', async () => {
    const rel = saved();
    await storage.syncToCloud([rel]);
    const next = storage.refileReceipt(rel, '2026-06-02', 'Staples');
    expect(fs.existsSync(path.join(cloud, next))).toBe(true);
    expect(fs.existsSync(path.join(cloud, sidecar(next)))).toBe(true);
    expect(fs.existsSync(path.join(cloud, rel))).toBe(false);
  });

  it('deletes a receipt that is in the cloud, tidying the month folder', async () => {
    const rel = saved();
    await storage.syncToCloud([rel]);
    storage.deleteSidecarFiles(rel, []);
    storage.deleteReceiptFiles(rel, []);
    expect(fs.existsSync(path.join(cloud, path.dirname(rel)))).toBe(false);
  });

  it('keeps the local file and reports it when the service has vanished', async () => {
    const rel = saved();
    process.env.RECEIPTS_CLOUD_DIR = path.join(parent, 'signed-out', CLOUD_SUBFOLDER);
    await storage.syncToCloud([rel]);
    expect(getCloudError()).toMatch(/isn't available/);
    expect(fs.existsSync(path.join(parent, 'signed-out'))).toBe(false);
    expect(fs.existsSync(local(rel))).toBe(true);

    process.env.RECEIPTS_CLOUD_DIR = cloud;
    await storage.syncToCloud([rel]);
    expect(getCloudError()).toBeNull();
    expect(fs.existsSync(local(rel))).toBe(false);
  });

  it('keeps the receipt usable when the image cannot be reached for a re-file', () => {
    expect(storage.refileReceipt('2026-05/gone_1a2b3c4d.jpg', '2026-06-02', 'Staples')).toBe(
      '2026-05/gone_1a2b3c4d.jpg',
    );
  });

  describe('switching location', () => {
    it('moves everything back when going to this Mac only', async () => {
      const rel = saved();
      await storage.syncToCloud([rel]);

      delete process.env.RECEIPTS_CLOUD_DIR;
      process.env.RECEIPTS_CLOUD_PREVIOUS_DIR = cloud;
      expect(storage.absolutePath(rel)).toBe(path.join(cloud, rel));
      expect(storage.countWaitingToMove([rel])).toBe(1);

      await storage.syncToCloud([rel]);
      expect(fs.existsSync(local(rel))).toBe(true);
      expect(fs.existsSync(path.join(cloud, rel))).toBe(false);
      expect(process.env.RECEIPTS_CLOUD_PREVIOUS_DIR).toBe('');
    });

    it('moves between two services', async () => {
      const rel = saved();
      await storage.syncToCloud([rel]);

      const other = path.join(parent, 'other');
      fs.mkdirSync(other);
      process.env.RECEIPTS_CLOUD_DIR = path.join(other, CLOUD_SUBFOLDER);
      process.env.RECEIPTS_CLOUD_PREVIOUS_DIR = cloud;
      await storage.syncToCloud([rel]);
      expect(fs.existsSync(path.join(other, CLOUD_SUBFOLDER, rel))).toBe(true);
      expect(fs.existsSync(path.join(cloud, rel))).toBe(false);
    });

    it('does not treat a signed-out old location as finished', async () => {
      const rel = saved();
      const gone = path.join(parent, 'signed-out', CLOUD_SUBFOLDER);
      delete process.env.RECEIPTS_CLOUD_DIR;
      process.env.RECEIPTS_CLOUD_PREVIOUS_DIR = gone;
      await storage.syncToCloud([rel]);
      expect(process.env.RECEIPTS_CLOUD_PREVIOUS_DIR).toBe(gone);
      expect(getCloudError()).toMatch(/isn't available/);
    });
  });
});

describe('GET/POST /api/receipts/cloud-storage', () => {
  const originalHome = process.env.HOME;
  let ctx: TestContext;
  let home: string;
  let icloud: string;

  beforeAll(async () => {
    ({ home, icloud } = makeHome());
    ctx = await setupTestApp({ HOME: home });
  });

  afterAll(() => {
    ctx.teardown();
    process.env.HOME = originalHome;
    delete process.env.RECEIPTS_CLOUD_DIR;
    delete process.env.RECEIPTS_CLOUD_PREVIOUS_DIR;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('starts off, listing what the Mac has, with no paths exposed', async () => {
    const res = await request(ctx.app).get('/api/receipts/cloud-storage');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ enabled: false, selectedId: null, error: null });
    expect(res.body.options).toEqual([{ id: 'icloud', label: 'iCloud Drive' }]);
    expect(JSON.stringify(res.body)).not.toContain(home);
  });

  it('turns on with a known service, creating its folder', async () => {
    const res = await request(ctx.app).post('/api/receipts/cloud-storage').send({ id: 'icloud' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ enabled: true, selectedId: 'icloud' });
    expect(fs.readdirSync(path.join(icloud, CLOUD_SUBFOLDER))).toEqual([]);
  });

  it('rejects an id that is not an offered service', async () => {
    const res = await request(ctx.app).post('/api/receipts/cloud-storage').send({ id: '/etc' });
    expect(res.status).toBe(400);
    expect(process.env.RECEIPTS_CLOUD_DIR).toContain('com~apple~CloudDocs');
  });

  it('serves a receipt photo that has moved to the cloud folder', async () => {
    const upload = await request(ctx.app)
      .post('/api/receipts')
      .attach('images', fakeImageBytes('cloud'), { filename: 'a.jpg', contentType: 'image/jpeg' });
    const receipt = upload.body[0];

    const { StorageService: Fresh } = await import('../../server/receipts/storage.js');
    await new Fresh(ctx.dataDir).syncToCloud([receipt.primary_image]);
    expect(fs.existsSync(path.join(ctx.dataDir, 'Receipts', receipt.primary_image))).toBe(false);

    expect((await request(ctx.app).get(`/images/${receipt.primary_image}`)).status).toBe(200);
    expect((await request(ctx.app).get(`/api/receipts/${receipt.id}/image`)).status).toBe(200);
  });

  it('remembers the old location when turning off, and refuses another switch mid-move', async () => {
    const res = await request(ctx.app).post('/api/receipts/cloud-storage').send({ id: null });
    expect(res.body).toMatchObject({ enabled: false, selectedId: null });
    expect(process.env.RECEIPTS_CLOUD_PREVIOUS_DIR).toContain('com~apple~CloudDocs');

    const again = await request(ctx.app).post('/api/receipts/cloud-storage').send({ id: 'icloud' });
    expect(again.status).toBe(409);
  });
});
