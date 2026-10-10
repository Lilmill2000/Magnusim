// The banana's mesh (workspace/models/banana.bin, made by scripts/make-banana.mjs with our own
// kernel; the file layout is described there). Read once, when the banana is first shown.
// Owner: TOOLBAR builder (ux010).
// SPDX-License-Identifier: GPL-3.0-or-later
import type { Vec3 } from '../../types/doc';

/** Where the build puts the mesh, relative to the workspace page. */
export const BANANA_PATH = 'models/banana.bin';

export interface BananaMesh {
  /** mm, the banana lying on Z = 0, centred on X and Y, its long axis along Y. */
  positions: Float32Array;
  normals: Float32Array;
  /** sRGB, 0..1, three per vertex. */
  colors: Float32Array;
  indices: Uint16Array;
  min: Vec3;
  max: Vec3;
  /** End to end along its long axis (mm). */
  length: number;
}

/** The mesh from the file's bytes; throws when they are not a banana file. */
export function decodeBanana(buf: ArrayBuffer): BananaMesh {
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== 'BNA1') throw new Error('not a banana mesh file');
  const V = dv.getUint32(4, true);
  const I = dv.getUint32(8, true);
  const length = dv.getFloat32(12, true);
  const unit = dv.getFloat32(16, true);
  const box = Array.from({ length: 6 }, (_, i) => dv.getFloat32(20 + 4 * i, true));
  let o = 44;
  const indices = new Uint16Array(I);
  for (let i = 0; i < I; i++) indices[i] = dv.getUint16(o + 2 * i, true);
  o += Math.ceil((I * 2) / 4) * 4;
  const positions = new Float32Array(3 * V);
  for (let i = 0; i < 3 * V; i++) positions[i] = dv.getInt16(o + 2 * i, true) * unit;
  o += 6 * V;
  const normals = new Float32Array(3 * V);
  for (let i = 0; i < 3 * V; i++) normals[i] = dv.getInt16(o + 2 * i, true) / 32767;
  o += 6 * V;
  const colors = new Float32Array(3 * V);
  for (let i = 0; i < 3 * V; i++) colors[i] = dv.getUint8(o + i) / 255;
  if (o + 3 * V !== buf.byteLength) throw new Error('the banana mesh file is cut short or too long');
  return { positions, normals, colors, indices, min: [box[0], box[1], box[2]], max: [box[3], box[4], box[5]], length };
}

let loading: Promise<BananaMesh> | null = null;

/** The banana's mesh, fetched next to the workspace page once (a failed fetch is tried again next time). */
export function loadBanana(): Promise<BananaMesh> {
  if (!loading) {
    loading = (async () => {
      const r = await fetch(new URL(BANANA_PATH, document.baseURI).href);
      if (!r.ok) throw new Error(`${BANANA_PATH}: HTTP ${r.status}`);
      return decodeBanana(await r.arrayBuffer());
    })();
    loading.catch(() => {
      loading = null;
    });
  }
  return loading;
}
