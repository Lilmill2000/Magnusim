// Picking sketch geometry on the sketch plane: points first (the origin too),
// then curves, within 8 px (proposal §4.7); window selection (left to right
// encloses, right to left crosses: proposal §2.14). Pure (unit-tested).
// Owner: P3-SKETCH.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { SketchEntity, SketchFeature, Vec2 } from '../types/doc';
import { dist, polar } from './geom';
import { arcGeom, distanceTo, entityPoints, lineEnds, ORIGIN, pointAt } from './model';
import type { SketchHit } from './mode';
import { splineSamples } from './tools/spline-entity';
import { hiddenPoles } from './project/style';

export const PICK_PX = 8;

type F = Pick<SketchFeature, 'points' | 'entities'>;

/** Points that are drawn (used by an entity, or a point entity's), and the origin. */
export function drawnPoints(f: F): string[] {
  const out = new Set<string>();
  for (const e of f.entities) for (const p of entityPoints(e)) out.add(p);
  // P4b SELECT: a projected spline's inner poles are not points the user sees or picks.
  for (const p of hiddenPoles(f)) out.delete(p);
  return [...out];
}

/** The sketch item under the pointer: the nearest point within 8 px, else the nearest curve. */
export function hitTest(f: F, at: Vec2, px: number, opts: { points?: boolean; entities?: boolean; exclude?: ReadonlySet<string>; origin?: boolean } = {}): SketchHit | null {
  const tol = PICK_PX * px;
  const ex = opts.exclude ?? new Set<string>();
  if (opts.points !== false) {
    let best: { id: string; d: number } | null = null;
    const cands = [...drawnPoints(f), ...(opts.origin !== false ? [ORIGIN] : [])];
    for (const id of cands) {
      if (ex.has(id)) continue;
      const p = pointAt(f, id);
      if (!p) continue;
      const d = dist(p, at);
      if (d <= tol && (!best || d < best.d)) best = { id, d };
    }
    if (best) {
      // A point entity is picked as the entity (it is what the user drew).
      const pe = f.entities.find((e) => e.kind === 'point' && e.p === best!.id);
      return pe ? { what: 'entity', id: pe.id } : { what: 'point', id: best.id };
    }
  }
  if (opts.entities !== false) {
    let best: { id: string; d: number } | null = null;
    for (const e of f.entities) {
      if (e.kind === 'point' || ex.has(e.id)) continue;
      const d = distanceTo(f, e, at);
      if (d <= tol && (!best || d < best.d)) best = { id: e.id, d };
    }
    if (best) return { what: 'entity', id: best.id };
  }
  return null;
}

/** Points along an entity (polyline) for window tests and drawing (arcs and circles sampled). */
export function samples(f: F, e: SketchEntity, n = 48): Vec2[] {
  switch (e.kind) {
    case 'point': {
      const p = pointAt(f, e.p);
      return p ? [p] : [];
    }
    case 'line': {
      const ends = lineEnds(f, e.id);
      return ends ? [ends[0], ends[1]] : [];
    }
    case 'circle': {
      const c = pointAt(f, e.c);
      if (!c) return [];
      return Array.from({ length: n + 1 }, (_, i) => polar(c, e.r, (2 * Math.PI * i) / n));
    }
    case 'arc': {
      const g = arcGeom(f, e);
      if (!g) return [];
      const k = Math.max(4, Math.ceil((n * g.sweep) / (2 * Math.PI)));
      return Array.from({ length: k + 1 }, (_, i) => polar(g.c, g.r, g.a0 + (g.sweep * i) / k));
    }
    case 'spline':
      return splineSamples(f, e, n);
  }
}

/**
 * Window selection between two corners: `crossing` (dragged right to left)
 * takes everything the window touches, otherwise only what lies wholly inside.
 */
export function windowSelect(f: F, a: Vec2, b: Vec2, crossing: boolean): SketchHit[] {
  const lo: Vec2 = [Math.min(a[0], b[0]), Math.min(a[1], b[1])];
  const hi: Vec2 = [Math.max(a[0], b[0]), Math.max(a[1], b[1])];
  const inside = (p: Vec2) => p[0] >= lo[0] && p[0] <= hi[0] && p[1] >= lo[1] && p[1] <= hi[1];
  const out: SketchHit[] = [];
  for (const e of f.entities) {
    const pts = samples(f, e);
    if (!pts.length) continue;
    const all = pts.every(inside);
    const any = crossing && (pts.some(inside) || segmentsCross(pts, lo, hi));
    if (all || any) out.push({ what: 'entity', id: e.id });
  }
  return out;
}

/** A polyline that passes through the window without a sample inside it (a long line): Liang-Barsky clipping. */
function segmentsCross(pts: Vec2[], lo: Vec2, hi: Vec2): boolean {
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1];
    const dx = pts[i][0] - x0;
    const dy = pts[i][1] - y0;
    let t0 = 0;
    let t1 = 1;
    let ok = true;
    for (const [p, q] of [
      [-dx, x0 - lo[0]],
      [dx, hi[0] - x0],
      [-dy, y0 - lo[1]],
      [dy, hi[1] - y0],
    ] as [number, number][]) {
      if (p === 0) {
        if (q < 0) ok = false;
        continue;
      }
      const r = q / p;
      if (p < 0) t0 = Math.max(t0, r);
      else t1 = Math.min(t1, r);
    }
    if (ok && t0 <= t1) return true;
  }
  return false;
}
