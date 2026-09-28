/**
 * Shrink a receipt photo in the browser before it's uploaded.
 *
 * A phone camera photo is 3–5 MB; a receipt re-encoded as a JPEG at
 * 2000px on its long edge is roughly 200–500 KB and still easily legible.
 * Doing it here (canvas, no library) costs nothing, cuts upload time on
 * mobile data, and keeps the Receipts folder on disk small. Claude
 * downsizes anything over ~1568px anyway, so extraction loses nothing.
 *
 * Never blocks an upload: if the browser can't decode the image (an
 * unusual format, or no canvas support) the original file is sent as-is,
 * and a file that is already small is left alone.
 */

export const MAX_EDGE_PX = 2000;
export const JPEG_QUALITY = 0.82;
/** Below this, re-encoding would save little and risks making it worse. */
export const SKIP_UNDER_BYTES = 400 * 1024;

/** Scale (w, h) down to fit within `max` on the long edge; never scales up. */
export function fitWithin(width: number, height: number, max: number): { width: number; height: number } {
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

export async function compressImage(file: File): Promise<File> {
  if (!file.type.startsWith('image/') || file.size < SKIP_UNDER_BYTES) return file;

  try {
    // imageOrientation: honour EXIF rotation, so portrait phone photos
    // don't come out sideways once the metadata is stripped.
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const { width, height } = fitWithin(bitmap.width, bitmap.height, MAX_EDGE_PX);

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close?.();

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY),
    );
    if (!blob || blob.size >= file.size) return file;

    const name = file.name.replace(/\.[^.]+$/, '') + '.jpg';
    return new File([blob], name, { type: 'image/jpeg', lastModified: file.lastModified });
  } catch {
    return file;
  }
}
