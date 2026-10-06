// The sketch selection filter (P4b SELECT): which sketch items a click or a
// selection box may take in sketch mode: points, curves, dimensions (empty =
// all). The viewport's Selection filter shows these chips while a sketch is
// edited (src/viewport/ViewportChrome.tsx), the model kinds otherwise. Not
// saved; it lasts while the Part is open.
// Owner: P4b SELECT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { createStateStore } from '../lib/store';
import type { StateStore } from '../types/state';

export type SketchPickKind = 'point' | 'curve' | 'dimension';

export const SKETCH_FILTERS: { kind: SketchPickKind; label: string }[] = [
  { kind: 'point', label: 'Points' },
  { kind: 'curve', label: 'Curves' },
  { kind: 'dimension', label: 'Dimensions' },
];

export interface SketchFilter {
  kinds: SketchPickKind[];
}

const stores = new WeakMap<object, StateStore<SketchFilter>>();

/** The sketch filter of these services (one per app). */
export function sketchFilterOf(services: object): StateStore<SketchFilter> {
  let s = stores.get(services);
  if (!s) {
    s = createStateStore<SketchFilter>({ kinds: [] });
    stores.set(services, s);
  }
  return s;
}
