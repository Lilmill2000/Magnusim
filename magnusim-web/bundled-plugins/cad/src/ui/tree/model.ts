// What the design tree shows, as plain data (pure functions, unit-tested):
// history rows in document order with their rollback / suppressed / error
// states, where the rollback bar sits, and the bodies list.
// Owner: UI-SHELL.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { RebuildState } from '../../types/doc-service';
import type { BodyId, CadDoc, CadView, FeatureId, FeatureType } from '../../types/doc';
import type { Selection } from '../../types/selection';
import type { BodyInfo } from '../../types/kernel';

export interface HistoryRow {
  id: FeatureId;
  type: FeatureType;
  name: string;
  index: number;
  suppressed: boolean;
  /** Below the rollback bar: not built. */
  rolledBack: boolean;
  /** Rebuild outcome shown as a badge. */
  status: 'ok' | 'error' | 'warning' | 'pending';
  message: string | null;
}

/** Where the rollback bar is, as an index in [0, n] (n = at the end). */
export function rollbackIndex(view: Pick<CadView, 'rollback'>, count: number): number {
  const r = view.rollback;
  if (r == null || !Number.isFinite(r)) return count;
  return Math.max(0, Math.min(count, Math.floor(r)));
}

/** The CadView.rollback value for a bar index (null at the end). */
export function rollbackValue(index: number, count: number): number | null {
  const i = Math.max(0, Math.min(count, Math.floor(index)));
  return i >= count ? null : i;
}

export function historyRows(doc: Pick<CadDoc, 'features'>, view: Pick<CadView, 'rollback'>, rebuild: Pick<RebuildState, 'features'>): HistoryRow[] {
  const bar = rollbackIndex(view, doc.features.length);
  return doc.features.map((f, index) => {
    const st = rebuild.features[f.id];
    let status: HistoryRow['status'] = 'ok';
    let message: string | null = null;
    if (st?.state === 'error' || st?.state === 'warning') {
      status = st.state;
      message = st.message ?? (st.state === 'error' ? `${f.name} failed` : null);
    } else if (st?.state === 'pending') {
      status = 'pending';
    }
    return {
      id: f.id,
      type: f.type,
      name: f.name,
      index,
      suppressed: !!f.suppressed,
      rolledBack: index >= bar,
      status,
      message,
    };
  });
}

/**
 * The bar index for a pointer at `y`, given the vertical midpoints of the
 * feature rows in order: the bar goes after every row whose middle is above y.
 */
export function barIndexAt(y: number, mids: number[]): number {
  let i = 0;
  while (i < mids.length && mids[i] < y) i++;
  return i;
}

export interface BodyRow {
  id: BodyId;
  name: string;
  color: string;
  visible: boolean;
  feature: FeatureId;
  valid: boolean;
}

/**
 * Bodies at the rollback position, in creation order (the order the document
 * made them: Body 1, Body 2, Body 3, whatever the history did to them since),
 * with the saved names and visibility.
 */
export function bodyRows(doc: Pick<CadDoc, 'bodies'>, view: Pick<CadView, 'hiddenBodies'>, bodies: BodyInfo[]): BodyRow[] {
  const made = Object.keys(doc.bodies);
  const rank = (id: BodyId) => {
    const i = made.indexOf(id);
    return i < 0 ? made.length : i;
  };
  const ordered = bodies.map((b, i) => ({ b, i })).sort((x, y) => rank(x.b.id) - rank(y.b.id) || x.i - y.i);
  return ordered.map(({ b }) => ({
    id: b.id,
    name: doc.bodies[b.id]?.name ?? b.name,
    color: doc.bodies[b.id]?.color ?? b.color,
    visible: !view.hiddenBodies.includes(b.id),
    feature: b.feature,
    valid: b.valid,
  }));
}

/** Bodies the selection touches (a picked face, edge or vertex counts for its body). */
export function selectedBodies(sel: Selection): Set<BodyId> {
  const out = new Set<BodyId>();
  for (const it of sel.items) {
    if (it.kind === 'body' || it.kind === 'face' || it.kind === 'edge' || it.kind === 'vertex') out.add(it.body);
  }
  return out;
}

/** Features selected directly (a row click) and those whose bodies are picked (related). */
export function selectedFeatures(sel: Selection, bodies: Pick<BodyInfo, 'id' | 'feature'>[]): { direct: Set<FeatureId>; related: Set<FeatureId> } {
  const direct = new Set<FeatureId>();
  for (const it of sel.items) if (it.kind === 'feature') direct.add(it.feature);
  const picked = selectedBodies(sel);
  const related = new Set<FeatureId>();
  for (const b of bodies) if (picked.has(b.id) && !direct.has(b.feature)) related.add(b.feature);
  return { direct, related };
}
