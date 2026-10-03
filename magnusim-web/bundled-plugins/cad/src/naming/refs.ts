// Making stored references from picks, and the kernel-backed lookup that
// resolution uses. A panel that keeps a picked face calls refOfFace once, when
// the user picks it (that is the re-anchoring point); a rebuild only resolves.
// Owner: DOC-CORE (naming layer).
// SPDX-License-Identifier: GPL-3.0-or-later
import type { PersistentRef, RefSemantic } from '../types/doc';
import type { KernelAdapter } from '../types/kernel';
import type { ShapeId, TopoResult } from '../types/kernel-protocol';
import type { FaceNames, NamingLookup } from '../types/naming';
import { faceSignature } from './resolve';

/** A NamingLookup over the kernel's `topo` (face_mass on, fast face boxes; edges with their faces). */
export function kernelLookup(kernel: KernelAdapter): NamingLookup {
  return {
    async faces(shape: ShapeId, indices: number[] | 'all'): Promise<TopoResult['faces']> {
      const r = await kernel.call('topo', { id: shape, faces: indices, edges: 'none', vertices: 'none', face_bbox: 'fast', face_mass: true });
      return r.result.faces;
    },
    async edges(shape: ShapeId, indices: number[] | 'all'): Promise<TopoResult['edges']> {
      const r = await kernel.call('topo', { id: shape, faces: 'none', edges: indices, vertices: 'none', edge_length: true });
      return r.result.edges;
    },
  };
}

/**
 * The stored reference for face `index` of a body: its current name, a
 * semantic hint read from the name, and its signature now. Throws when the
 * body has no names (a bug: every feature of P2/P3 names its faces).
 */
export async function refOfFace(lookup: NamingLookup, shape: ShapeId, names: FaceNames | null, index: number): Promise<PersistentRef> {
  const name = names?.faces[index];
  if (!name) throw new Error(`face ${index} of this body has no name`);
  const [topo] = await lookup.faces(shape, [index]);
  if (!topo) throw new Error(`face ${index} of this body is not there`);
  const m = /^F:([^:|]+):([^:|#]+)/.exec(name);
  const semantic: RefSemantic | undefined = m ? { feature: m[1], role: (['side', 'start', 'end', 'import', 'primitive', 'cut', 'heal', 'moved'].includes(m[2]) ? m[2] : 'other') as RefSemantic['role'] } : undefined;
  return { name, ...(semantic ? { semantic } : {}), signature: faceSignature(topo) };
}
