// What other areas ask about CONSTRUCT features (no React, no three.js): which
// kind a feature is, and its built geometry at the latest rebuild. A reference
// Plane, Axis or Point is selected as `{ kind: 'feature', feature }` (its tree
// row, or a click on it in the view).
// Owner: REFERENCE (P4a).
// SPDX-License-Identifier: GPL-3.0-or-later
import type { AppServices } from '../../types/app';
import type { FeatureId, FeatureType } from '../../types/doc';
import type { DocState } from '../../types/doc-service';
import type { ConstructOutput } from '../../types/references';
import type { SelectionItem } from '../../types/selection';

export type ConstructKind = 'plane' | 'axis' | 'point';

export const CONSTRUCT_TYPES: Record<string, ConstructKind> = { ref_plane: 'plane', ref_axis: 'axis', ref_point: 'point' };

export function constructKindOfType(type: FeatureType | string): ConstructKind | null {
  return CONSTRUCT_TYPES[type] ?? null;
}

/** The kind of a CONSTRUCT feature (by id), or null for any other feature. */
export function constructKind(state: Pick<DocState, 'doc'>, id: FeatureId): ConstructKind | null {
  const f = state.doc.features.find((g) => g.id === id);
  return f ? constructKindOfType(f.type) : null;
}

/** The built geometry of a CONSTRUCT feature at the latest rebuild, or null (failed, suppressed, rolled back). */
export function constructOutput(state: Pick<DocState, 'rebuild'>, id: FeatureId): ConstructOutput | null {
  const o = state.rebuild.outputs[id];
  return o && (o.type === 'plane' || o.type === 'axis' || o.type === 'point') ? o : null;
}

/** The CONSTRUCT feature a selection item is, with its kind, or null. */
export function constructOf(services: Pick<AppServices, 'doc'>, item: SelectionItem): { feature: FeatureId; kind: ConstructKind } | null {
  if (item.kind !== 'feature') return null;
  const kind = constructKind(services.doc.state.get(), item.feature);
  return kind ? { feature: item.feature, kind } : null;
}
