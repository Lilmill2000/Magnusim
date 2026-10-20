/**
 * The person's reference pictures for a message (phase 4 spec 3.2), within the server's own
 * limits (sanitize.ts IMAGE_CAPS, the turn's `images`): at most 4 per message; PNG, JPEG or
 * WebP by their first bytes; at most 1.5 MB and 2000 px a side.
 *
 * preparePicture(file): reads the bytes and sniffs them; reads the size (createImageBitmap);
 * a picture over 2000 px a side or 1.5 MB is drawn on a canvas scaled to fit 2000 px and
 * encoded as WebP at 0.9, then 0.8, then 0.7 until it fits ("Shrunk to <w> × <h> px to fit");
 * still too big, it is refused with its name. Pure but for those browser calls, which tests
 * hand in (jsdom has neither).
 */
import { AT_MOST_FOUR, ONLY_IMAGES, tooLargeAfterShrinking } from './copy';

export const PICTURE_LIMITS = Object.freeze({ count: 4, bytes: 1.5 * 1024 * 1024, side: 2000 });
/** The WebP qualities tried in turn when a picture must shrink. */
export const SHRINK_QUALITIES = [0.9, 0.8, 0.7] as const;

export type PictureType = 'image/png' | 'image/jpeg' | 'image/webp';

export interface PreparedPicture {
  media_type: PictureType;
  /** The bytes as base64 (what POST /turns takes). */
  data: string;
  width: number;
  height: number;
  name: string;
  /** Drawn smaller (or re-encoded) to fit the limits. */
  shrunk: boolean;
  /** The bytes, for this tab's own thumbnail (a blob: URL). */
  blob: Blob;
}

/** The browser calls preparePicture needs (tests hand in their own). */
export interface PictureDeps {
  size(blob: Blob): Promise<{ width: number; height: number; draw: (w: number, h: number, quality: number) => Promise<Blob>; close?: () => void }>;
}

/** The type the bytes say, by their first bytes only. */
export function sniff(b: Uint8Array): PictureType | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  if (b.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** Base64 of bytes, in pieces (a large picture must not overflow the call stack). */
export function toBase64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

async function bytesOf(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

/** The browser's: createImageBitmap for the size, a canvas (OffscreenCanvas when there is one) to shrink. */
export const browserPictureDeps: PictureDeps = {
  async size(blob) {
    const bitmap = await createImageBitmap(blob);
    const width = bitmap.width;
    const height = bitmap.height;
    return {
      width,
      height,
      async draw(w, h, quality) {
        if (typeof OffscreenCanvas !== 'undefined') {
          const c = new OffscreenCanvas(w, h);
          const ctx = c.getContext('2d');
          if (!ctx) throw new Error('no canvas');
          ctx.drawImage(bitmap, 0, 0, w, h);
          return c.convertToBlob({ type: 'image/webp', quality });
        }
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const ctx = c.getContext('2d');
        if (!ctx) throw new Error('no canvas');
        ctx.drawImage(bitmap, 0, 0, w, h);
        return new Promise<Blob>((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('no blob'))), 'image/webp', quality));
      },
      close: () => bitmap.close(),
    };
  },
};

/** A file as the message carries it, or the line that says why it can't be attached. */
export async function preparePicture(file: File, deps: PictureDeps = browserPictureDeps): Promise<PreparedPicture | { error: string }> {
  const name = file.name || 'Picture';
  const bytes = await bytesOf(file);
  const type = sniff(bytes);
  if (!type) return { error: ONLY_IMAGES };
  let img;
  try {
    img = await deps.size(new Blob([bytes as BlobPart], { type }));
  } catch {
    return { error: ONLY_IMAGES };
  }
  try {
    return await fit(name, type, bytes, img);
  } finally {
    img.close?.();
  }
}

async function fit(name: string, type: PictureType, bytes: Uint8Array, img: Awaited<ReturnType<PictureDeps['size']>>): Promise<PreparedPicture | { error: string }> {
  const { width, height } = img;
  if (width <= PICTURE_LIMITS.side && height <= PICTURE_LIMITS.side && bytes.length <= PICTURE_LIMITS.bytes) {
    return { media_type: type, data: toBase64(bytes), width, height, name, shrunk: false, blob: new Blob([bytes as BlobPart], { type }) };
  }
  const scale = Math.min(1, PICTURE_LIMITS.side / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  for (const q of SHRINK_QUALITIES) {
    let out: Blob;
    try {
      out = await img.draw(w, h, q);
    } catch {
      return { error: tooLargeAfterShrinking(name) };
    }
    if (out.size <= PICTURE_LIMITS.bytes) {
      const b = await bytesOf(out);
      if (sniff(b) !== 'image/webp') return { error: tooLargeAfterShrinking(name) };
      return { media_type: 'image/webp', data: toBase64(b), width: w, height: h, name, shrunk: true, blob: out };
    }
  }
  return { error: tooLargeAfterShrinking(name) };
}

/** The picture files of a paste or a drop (its files, else its items of an image type). */
export function picturesFrom(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  const files = Array.from(dt.files || []);
  if (files.length) return files;
  const out: File[] = [];
  for (const item of Array.from(dt.items || [])) {
    if (item.kind !== 'file' || !/^image\//.test(item.type)) continue;
    const f = item.getAsFile();
    if (f) out.push(f);
  }
  return out;
}

/** Whether a drag carries files (the drop overlay shows only then). */
export function dragHasFiles(dt: DataTransfer | null): boolean {
  return !!dt && Array.from(dt.types || []).includes('Files');
}

/**
 * Adds `files` to the `have` pictures: each prepared in turn; past the fourth the rest are
 * refused with "At most 4 pictures per message." Answers the new list and the lines to show.
 */
export async function addPictures(have: readonly PreparedPicture[], files: readonly File[], deps?: PictureDeps): Promise<{ pictures: PreparedPicture[]; errors: string[] }> {
  const pictures = [...have];
  const errors: string[] = [];
  for (const f of files) {
    if (pictures.length >= PICTURE_LIMITS.count) {
      if (!errors.includes(AT_MOST_FOUR)) errors.push(AT_MOST_FOUR);
      continue;
    }
    const p = await preparePicture(f, deps);
    if ('error' in p) errors.push(p.error);
    else pictures.push(p);
  }
  return { pictures, errors };
}
