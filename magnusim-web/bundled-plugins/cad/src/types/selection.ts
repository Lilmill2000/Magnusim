// Selection: one shared list, written by the viewport (picks) and the tree/panels
// (row clicks, selection lists), read by everyone.
// Owner: frozen contract (scaffold). Helpers in src/lib/selection.ts.
// P2/P3 (docs/p2p3-plan.md §3.3): sketch entities, sketch constraints and
// profile regions are selectable too. Their owners draw their own highlight
// (the viewport's highlight() leaves kinds it does not draw alone).
// SPDX-License-Identifier: GPL-3.0-or-later
import type { BodyId, FeatureId, OriginRef, Vec3 } from './doc';

/** What can be picked or selected. */
export type SelectKind = 'face' | 'edge' | 'vertex' | 'body' | 'feature' | 'origin' | 'sketch' | 'region';

/**
 * One selected thing. Faces/edges/vertices are addressed by body + topology
 * index at the current rebuild (indices are stable for a given shape; the
 * naming layer turns them into stored references when a feature keeps them).
 * Sketch items are addressed by the sketch feature and their stable ids.
 */
export type SelectionItem =
  | { kind: 'face' | 'edge' | 'vertex'; body: BodyId; index: number }
  | { kind: 'body'; body: BodyId }
  | { kind: 'feature'; feature: FeatureId }
  | { kind: 'origin'; ref: OriginRef }
  /** A sketch point (id in `points`, or SKETCH_ORIGIN), entity (line, circle, arc, point) or constraint/dimension. P3-SKETCH draws its highlight. */
  | { kind: 'sketch'; feature: FeatureId; id: string; what: 'point' | 'entity' | 'constraint' }
  /** A closed profile region of a built sketch (its key). P3-PROFILES draws its highlight. */
  | { kind: 'region'; feature: FeatureId; key: string };

export interface Selection {
  items: SelectionItem[];
  /** Which kinds a click may pick (selection filter chips). Empty = all. */
  filter: SelectKind[];
}

/** A viewport hit (hover or click). `point` is in model mm; screen in frame CSS px. */
export interface PickResult {
  item: SelectionItem;
  point: Vec3;
  normal: Vec3 | null;
  /** Distance from the camera (for sorting). */
  depth: number;
  screen: [number, number];
}

/** Stable identity of an item: "face:b_1:3", "feature:f_2", "origin:origin:top", "sketch:f_3:entity:e_1", "region:f_3:<key>". */
export function selectionKey(item: SelectionItem): string {
  switch (item.kind) {
    case 'face':
    case 'edge':
    case 'vertex':
      return `${item.kind}:${item.body}:${item.index}`;
    case 'body':
      return `body:${item.body}`;
    case 'feature':
      return `feature:${item.feature}`;
    case 'origin':
      return `origin:${item.ref}`;
    case 'sketch':
      return `sketch:${item.feature}:${item.what}:${item.id}`;
    case 'region':
      return `region:${item.feature}:${item.key}`;
  }
}
