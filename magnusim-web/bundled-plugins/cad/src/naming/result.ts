// Names of a kernel result, when they can be made honestly: the result says
// its face count (API 3 ShapeResult.faces) and its history, and every input
// the history can name has names. Otherwise null (the body is unnamed; a later
// reference to it fails loudly instead of resolving through unstable names).
// Owner: DOC-CORE (naming layer).
// SPDX-License-Identifier: GPL-3.0-or-later
import type { FeatureId } from '../types/doc';
import type { OpHistory, ShapeId, TopoResult } from '../types/kernel-protocol';
import type { FaceNames } from '../types/naming';
import { namesAfter } from './names';

export function namesFromResult(
  feature: FeatureId,
  result: { faces?: number; history?: OpHistory | null },
  inputs: ReadonlyMap<ShapeId, FaceNames | null>,
  opts: { role?: string; topo?: Pick<TopoResult, 'faces'> | null; edgeFaces?: (shape: ShapeId, edge: number) => [number, number] | null } = {},
): FaceNames | null {
  if (typeof result.faces !== 'number' || !result.history) return null;
  const named = new Map<ShapeId, FaceNames>();
  for (const [shape, names] of inputs) {
    if (!names) return null;
    named.set(shape, names);
  }
  return namesAfter({ feature, faces: result.faces, history: result.history, inputs: named, role: opts.role, topo: opts.topo ?? null }, opts.edgeFaces).names;
}
