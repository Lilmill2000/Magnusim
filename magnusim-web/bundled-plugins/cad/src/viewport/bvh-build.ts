// Building a picking BVH over a body's triangles (three-mesh-bvh, MIT). Shared
// by the picking worker (large bodies) and the main thread (small bodies, and
// tests). `indirect` keeps the index buffer untouched: face ranges stay valid
// and hits report the original triangle index.
// Owner: VIEWPORT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { BufferAttribute, BufferGeometry } from 'three';
import { MeshBVH } from 'three-mesh-bvh';

export const BVH_OPTIONS = { indirect: true, targetLeafSize: 10, verbose: false } as const;

/** The transferable parts of a built BVH (MeshBVH.serialize without the index). */
export interface BvhBuffers {
  roots: ArrayBuffer[];
  indirect: Uint32Array | Uint16Array;
}

/** Build over positions + indices (the arrays are only read). */
export function buildBvhBuffers(positions: Float32Array, indices: Uint32Array): BvhBuffers {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(positions, 3));
  g.setIndex(new BufferAttribute(indices, 1));
  const bvh = new MeshBVH(g, BVH_OPTIONS);
  const s = MeshBVH.serialize(bvh, { cloneBuffers: false });
  if (!s.indirectBuffer) throw new Error('BVH: expected an indirect build');
  return { roots: s.roots as ArrayBuffer[], indirect: s.indirectBuffer };
}

/** Attach built buffers to the body's own geometry (which must hold the same positions and indices). */
export function bvhFromBuffers(geometry: BufferGeometry, b: BvhBuffers): MeshBVH {
  // version 1 = the current serialisation format (MeshBVH.serialize writes it).
  const data = { version: 1, roots: b.roots, index: null, indirectBuffer: b.indirect };
  return MeshBVH.deserialize(data, geometry, { setIndex: false });
}

/** Build directly on the body's geometry (main thread). */
export function buildBvhSync(geometry: BufferGeometry): MeshBVH {
  return new MeshBVH(geometry, BVH_OPTIONS);
}

/** Messages of the picking worker. */
export interface BvhRequest {
  id: number;
  positions: Float32Array;
  indices: Uint32Array;
}
export type BvhReply = { id: number; ok: true; roots: ArrayBuffer[]; indirect: Uint32Array | Uint16Array; ms: number } | { id: number; ok: false; error: string };
