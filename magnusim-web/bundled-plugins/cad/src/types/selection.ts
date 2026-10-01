// Selection: one shared list, written by the viewport (picks) and the tree/panels
// (row clicks, selection lists), read by everyone.
// Owner: frozen contract (scaffold). Helpers in src/lib/selection.ts.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { BodyId, FeatureId, OriginRef, Vec3 } from './doc';

/** What can be picked or selected. */
export type SelectKind = 'face' | 'edge' | 'vertex' | 'body' | 'feature' | 'origin';

/**
 * One selected thing. Faces/edges/vertices are addressed by body + topology
 * index at the current rebuild (indices are stable for a given shape; the
 * naming layer turns them into stored references when a feature keeps them).
 */
export type SelectionItem =
  | { kind: 'face' | 'edge' | 'vertex'; body: BodyId; index: number }
  | { kind: 'body'; body: BodyId }
  | { kind: 'feature'; feature: FeatureId }
  | { kind: 'origin'; ref: OriginRef };

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

/** Stable identity of an item: "face:b_1:3", "feature:f_2", "origin:origin:top". */
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
  }
}
