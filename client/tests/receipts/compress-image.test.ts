import { describe, it, expect, afterEach, vi } from 'vitest';
import { compressImage, fitWithin, MAX_EDGE_PX, SKIP_UNDER_BYTES } from '../../src/receipts/compress-image';

/**
 * Spec (receipts are kept on the laptop; files should be small, at no
 * cost): photos are shrunk in the browser to fit MAX_EDGE_PX before
 * upload, and compression never blocks an upload — any failure sends the
 * original.
 */
describe('fitWithin', () => {
  it('scales the long edge down to the limit, keeping the aspect ratio', () => {
    expect(fitWithin(4032, 3024, 2000)).toEqual({ width: 2000, height: 1500 });
    expect(fitWithin(1000, 6000, 2000)).toEqual({ width: 333, height: 2000 });
  });

  it('never scales up', () => {
    expect(fitWithin(800, 600, 2000)).toEqual({ width: 800, height: 600 });
  });
});

describe('compressImage', () => {
  afterEach(() => vi.unstubAllGlobals());

  const big = () => new File([new Uint8Array(SKIP_UNDER_BYTES + 1)], 'IMG_1.HEIC', { type: 'image/jpeg' });

  it('leaves an already-small file alone', async () => {
    const small = new File([new Uint8Array(1000)], 'a.jpg', { type: 'image/jpeg' });
    expect(await compressImage(small)).toBe(small);
  });

  it('sends the original when the browser cannot decode it', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn().mockRejectedValue(new Error('unsupported')));
    const file = big();
    expect(await compressImage(file)).toBe(file);
  });

  it('re-encodes a large photo as a smaller JPEG within the size limit', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ width: 4032, height: 3024, close: vi.fn() }));
    const drawImage = vi.fn();
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({ drawImage }),
      toBlob: (cb: (b: Blob) => void) => cb(new Blob([new Uint8Array(1000)], { type: 'image/jpeg' })),
    };
    const realCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) =>
      tag === 'canvas' ? (canvas as any) : realCreate(tag),
    );

    const out = await compressImage(big());

    expect(out.type).toBe('image/jpeg');
    expect(out.name).toBe('IMG_1.jpg');
    expect(out.size).toBe(1000);
    expect(Math.max(canvas.width, canvas.height)).toBe(MAX_EDGE_PX);
    vi.restoreAllMocks();
  });
});
