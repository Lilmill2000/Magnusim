// Minimal PNG reader for pixel assertions on page screenshots (8-bit RGB/RGBA,
// non-interlaced, as Chromium writes them). No dependency.
// SPDX-License-Identifier: GPL-3.0-or-later
import { inflateSync } from 'node:zlib';

export interface Image {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel. */
  data: Uint8Array;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

export const PNG = {
  decode(buf: Buffer): Image {
    if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
    let pos = 8;
    let width = 0;
    let height = 0;
    let channels = 0;
    const idat: Buffer[] = [];
    while (pos < buf.length) {
      const len = buf.readUInt32BE(pos);
      const type = buf.toString('latin1', pos + 4, pos + 8);
      const body = buf.subarray(pos + 8, pos + 8 + len);
      if (type === 'IHDR') {
        width = body.readUInt32BE(0);
        height = body.readUInt32BE(4);
        const depth = body[8];
        const color = body[9];
        if (depth !== 8 || body[12] !== 0) throw new Error('only 8-bit non-interlaced PNGs');
        channels = color === 6 ? 4 : color === 2 ? 3 : 0;
        if (!channels) throw new Error(`unsupported PNG colour type ${color}`);
      } else if (type === 'IDAT') idat.push(body);
      else if (type === 'IEND') break;
      pos += 12 + len;
    }
    const raw = inflateSync(Buffer.concat(idat));
    const stride = width * channels;
    const out = new Uint8Array(width * height * 4);
    const prev = new Uint8Array(stride);
    const cur = new Uint8Array(stride);
    let r = 0;
    for (let y = 0; y < height; y++) {
      const filter = raw[r++];
      for (let x = 0; x < stride; x++) {
        const v = raw[r++];
        const a = x >= channels ? cur[x - channels] : 0;
        const b = prev[x];
        const c = x >= channels ? prev[x - channels] : 0;
        cur[x] = (filter === 0 ? v : filter === 1 ? v + a : filter === 2 ? v + b : filter === 3 ? v + ((a + b) >> 1) : v + paeth(a, b, c)) & 255;
      }
      for (let x = 0; x < width; x++) {
        const o = (y * width + x) * 4;
        out[o] = cur[x * channels];
        out[o + 1] = cur[x * channels + 1];
        out[o + 2] = cur[x * channels + 2];
        out[o + 3] = channels === 4 ? cur[x * channels + 3] : 255;
      }
      prev.set(cur);
    }
    return { width, height, data: out };
  },
  /** RGB of pixel (x, y). */
  at(img: Image, x: number, y: number): [number, number, number] {
    const o = (y * img.width + x) * 4;
    return [img.data[o], img.data[o + 1], img.data[o + 2]];
  },
  /** RGB of the centre pixel of a screenshot buffer. */
  center(buf: Buffer): [number, number, number] {
    const img = PNG.decode(buf);
    return PNG.at(img, Math.floor(img.width / 2), Math.floor(img.height / 2));
  },
};
