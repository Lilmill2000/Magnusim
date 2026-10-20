// The person's pictures for a message (phase 4 spec 3.2), with createImageBitmap and the canvas
// handed in (jsdom has neither).
import { describe, expect, it, vi } from 'vitest';
import { addPictures, dragHasFiles, PICTURE_LIMITS, picturesFrom, preparePicture, sniff, toBase64, type PictureDeps } from './pictures';

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff, 0xe0];
const WEBP = [...'RIFF'].map((c) => c.charCodeAt(0)).concat([0, 0, 0, 0], [...'WEBP'].map((c) => c.charCodeAt(0)));
const file = (head: number[], name: string, size = 64) => {
  const b = new Uint8Array(Math.max(size, head.length));
  b.set(head);
  return new File([b], name);
};
const webpBlob = (size: number) => {
  const b = new Uint8Array(size);
  b.set(WEBP);
  return new Blob([b], { type: 'image/webp' });
};

/** A picture of `w` × `h`; its draws answer WebP blobs of the given sizes in turn. */
function deps(w: number, h: number, sizes: number[] = []): PictureDeps & { draws: Array<[number, number, number]>; closed: number } {
  const d = {
    draws: [] as Array<[number, number, number]>,
    closed: 0,
    async size() {
      return {
        width: w,
        height: h,
        draw: async (dw: number, dh: number, q: number) => {
          d.draws.push([dw, dh, q]);
          return webpBlob(sizes.shift() ?? 100);
        },
        close: () => {
          d.closed += 1;
        },
      };
    },
  };
  return d;
}

describe('sniff', () => {
  it('PNG, JPEG and WebP by their first bytes; nothing else', () => {
    expect(sniff(new Uint8Array(PNG))).toBe('image/png');
    expect(sniff(new Uint8Array(JPEG))).toBe('image/jpeg');
    expect(sniff(new Uint8Array(WEBP))).toBe('image/webp');
    expect(sniff(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBeNull();
    expect(sniff(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
  });
  it('base64 in pieces', () => {
    const big = new Uint8Array(100_000).map((_, i) => i % 251);
    expect(toBase64(big)).toBe(Buffer.from(big).toString('base64'));
  });
});

describe('preparePicture', () => {
  it('a picture within the limits goes as it is', async () => {
    const d = deps(640, 480);
    const p = await preparePicture(file(PNG, 'part.png'), d);
    expect(p).toMatchObject({ media_type: 'image/png', width: 640, height: 480, name: 'part.png', shrunk: false });
    expect(d.draws).toEqual([]);
    expect(d.closed).toBe(1);
  });

  it('refuses anything but PNG, JPEG and WebP, by its bytes (whatever its name says)', async () => {
    expect(await preparePicture(file([0x47, 0x49, 0x46, 0x38], 'fake.png'), deps(10, 10))).toEqual({ error: 'Only PNG, JPEG and WebP pictures can be attached.' });
  });

  it('over 2000 px a side: drawn to fit 2000 px as WebP', async () => {
    const d = deps(2600, 1300);
    const p = await preparePicture(file(PNG, 'wide.png'), d);
    expect(p).toMatchObject({ media_type: 'image/webp', width: 2000, height: 1000, shrunk: true });
    expect(d.draws).toEqual([[2000, 1000, 0.9]]);
  });

  it('over 1.5 MB: WebP at 0.9, then 0.8, then 0.7 until it fits; else refused by name', async () => {
    const tooBig = PICTURE_LIMITS.bytes + 1;
    const d = deps(1200, 900, [tooBig, tooBig, 1000]);
    const p = await preparePicture(file(JPEG, 'photo.jpg', tooBig), d);
    expect(p).toMatchObject({ media_type: 'image/webp', width: 1200, height: 900, shrunk: true });
    expect(d.draws.map((x) => x[2])).toEqual([0.9, 0.8, 0.7]);
    const never = deps(1200, 900, [tooBig, tooBig, tooBig]);
    expect(await preparePicture(file(JPEG, 'photo.jpg', tooBig), never)).toEqual({ error: 'photo.jpg is larger than 1.5 MB even after shrinking it.' });
    expect(never.closed).toBe(1);
  });
});

describe('adding pictures', () => {
  it('at most 4; the rest refused once with its line; a bad one says why and the others still come', async () => {
    const d = deps(10, 10);
    const four = await addPictures([], [1, 2, 3].map((i) => file(PNG, `${i}.png`)).concat(file([0, 1, 2], 'x.gif')), d);
    expect(four.pictures.map((p) => p.name)).toEqual(['1.png', '2.png', '3.png']);
    expect(four.errors).toEqual(['Only PNG, JPEG and WebP pictures can be attached.']);
    const five = await addPictures(four.pictures, [file(PNG, '4.png'), file(PNG, '5.png'), file(PNG, '6.png')], d);
    expect(five.pictures.map((p) => p.name)).toEqual(['1.png', '2.png', '3.png', '4.png']);
    expect(five.errors).toEqual(['At most 4 pictures per message.']);
  });

  it("a paste's or drop's files, else its image items; a drag of files", () => {
    const f = file(PNG, 'a.png');
    expect(picturesFrom({ files: [f], items: [] } as unknown as DataTransfer)).toEqual([f]);
    const getAsFile = vi.fn(() => f);
    const items = [
      { kind: 'string', type: 'text/plain', getAsFile },
      { kind: 'file', type: 'image/png', getAsFile },
    ];
    expect(picturesFrom({ files: [], items } as unknown as DataTransfer)).toEqual([f]);
    expect(getAsFile).toHaveBeenCalledTimes(1);
    expect(picturesFrom(null)).toEqual([]);
    expect(dragHasFiles({ types: ['Files'] } as unknown as DataTransfer)).toBe(true);
    expect(dragHasFiles({ types: ['text/plain'] } as unknown as DataTransfer)).toBe(false);
  });
});
