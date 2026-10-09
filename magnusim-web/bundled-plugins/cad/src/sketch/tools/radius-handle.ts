// ux010 (DRAW): the radius arrow of a sketch fillet (Daniel: "a little arrow or something for
// me to drag and change the radius myself when I first make it"). A radial arrow on the arc at
// its mid-angle, pointing away from its centre. Dragging it along the arrow changes the radius by
// as much as the pointer moves along it (outward: bigger): the solver solves each value live (the
// trimmed lines follow, the radius label and the panel's Radius box show it), and the release
// stores it as one undo step (the radius dimension's value changes; nothing is added). A radius
// the corner can't take stops at the largest one it can, and the hint says why.
// Owner: DRAW (ux010).
// SPDX-License-Identifier: GPL-3.0-or-later
import type { SketchEntity, SketchFeature, Vec2 } from '../../types/doc';
import type { ApplyResult, SketchMode, SketchPointer, SketchPreview } from '../mode';
import { storeExpr } from '../mode';
import { SketchBuilder, type SketchDraft } from '../edit';
import { polar } from '../geom';
import { arcGeom, entityOf, evaluateDimensions, isDimension, pointAt, toSolverSketch, withSolved } from '../model';
import { filletCorner } from './fillet';

/** The grab zone around the arrow (CSS px): its grip on the arc and its 28 px shaft. */
const GRAB_PX = 9;
const ARROW_PX = 28;

/** A radius arc's handle: where it is, the way it points (u/v, unit). */
export interface RadiusHandleGeom {
  at: Vec2;
  dir: Vec2;
}

/** Where a radius arrow goes on an arc: its middle, pointing away from the centre. */
export function radiusHandleOf(d: Pick<SketchFeature, 'points' | 'entities'>, arc: string): RadiusHandleGeom | null {
  const e = entityOf(d, arc);
  if (!e || e.kind !== 'arc') return null;
  const g = arcGeom(d, e);
  if (!g || !(g.r > 0)) return null;
  const mid = g.a0 + g.sweep / 2;
  return { at: polar(g.c, g.r, mid), dir: [Math.cos(mid), Math.sin(mid)] };
}

/** The radius dimension that drives an arc (driving), or null. */
export function radiusDimensionOf(d: Pick<SketchFeature, 'constraints'>, arc: string): string | null {
  const c = d.constraints.find((x) => isDimension(x) && x.kind === 'radius' && x.refs[0] === arc && x.driving);
  return c?.id ?? null;
}

/**
 * The largest radius a fillet arc can take at its corner, and why not more: the curves either side
 * (the arc's tangent neighbours) put back to the corner they were trimmed from (the construction
 * point the fillet keeps on both), and the fillet's own geometry asked for each radius (a
 * bisection; a fillet is a few microseconds). Null when the arc is not a fillet of a corner.
 */
export function filletLimit(d: SketchDraft, arc: string): { max: number; why: string } | null {
  const e = entityOf(d, arc);
  if (!e || e.kind !== 'arc') return null;
  const ends = [e.a, e.b];
  const next = ends.map((p) => d.entities.filter((x) => x.id !== arc && (x.kind === 'line' || x.kind === 'arc') && endsOf(x).includes(p)));
  if (next.some((n) => n.length !== 1)) return null;
  const [n1, n2] = [next[0][0], next[1][0]];
  // The corner: a construction point held on both neighbours (point_on_line / point_on_circle).
  const on = (p: string, curve: string) => d.constraints.some((c) => (c.kind === 'point_on_line' || c.kind === 'point_on_circle') && c.refs[0] === p && c.refs[1] === curve);
  const corner = d.entities.find((x): x is Extract<SketchEntity, { kind: 'point' }> => x.kind === 'point' && !!x.construction && on(x.p, n1.id) && on(x.p, n2.id))?.p;
  if (!corner || !pointAt(d, corner)) return null;
  const pre: SketchDraft = {
    points: d.points,
    entities: d.entities.filter((x) => x.id !== arc && !(x.kind === 'point' && x.p === corner)).map((x) => (x.id === n1.id ? withEnd(x, e.a, corner) : x.id === n2.id ? withEnd(x, e.b, corner) : x)),
    constraints: [],
  };
  const ok = (r: number) => filletCorner(pre, corner, r, `${r} mm`).ok;
  const g = arcGeom(d, e);
  let lo = g && ok(g.r) ? g.r : 0;
  if (!lo) {
    // The arc as drawn does not fit its corner (moved by other relations): start from small.
    lo = 1e-6;
    if (!ok(lo)) return null;
  }
  let hi = lo * 2;
  for (let i = 0; i < 80 && ok(hi); i++) {
    lo = hi;
    hi *= 2;
  }
  if (ok(hi)) return null;
  for (let i = 0; i < 60; i++) {
    const m = (lo + hi) / 2;
    if (ok(m)) lo = m;
    else hi = m;
  }
  const why = n1.kind === 'line' && n2.kind === 'line' ? 'the lines are too short' : 'the line and the arc are too short';
  return { max: lo, why };
}

function endsOf(e: SketchEntity): string[] {
  return e.kind === 'line' ? [...e.p] : e.kind === 'arc' ? [e.a, e.b] : [];
}

function withEnd(e: SketchEntity, from: string, to: string): SketchEntity {
  if (e.kind === 'line') return { ...e, p: [e.p[0] === from ? to : e.p[0], e.p[1] === from ? to : e.p[1]] };
  if (e.kind === 'arc') return { ...e, a: e.a === from ? to : e.a, b: e.b === from ? to : e.b };
  return e;
}

/** The drag of one arc's radius arrow (one per tool; `target` changes when another fillet is made). */
export class RadiusHandle {
  /** The arc and its radius dimension; null: no handle shown. */
  target: { arc: string; dim: string } | null = null;
  /** The radius now while dragging (mm), the stored one otherwise. */
  live: number | null = null;
  /** Why the radius stopped ("The radius can't be bigger than 12.4 mm here: the lines are too short"), or null. */
  stopped: string | null = null;
  hovered = false;
  private drag: { from: Vec2; r0: number; dir: Vec2; base: SketchFeature; limit: { max: number; why: string } | null; min: number; step: number; fine: number } | null = null;
  /** The solver's work for the drag, in order; `want` is the newest radius asked for. */
  private chain: Promise<unknown> = Promise.resolve();
  private want: number | null = null;
  private busy = false;
  private lastGood: number | null = null;

  constructor(
    private readonly mode: SketchMode,
    /** The radius changed (live or stored): the tool's Radius box and hint follow. */
    private readonly changed: (r: number) => void,
  ) {}

  get dragging(): boolean {
    return !!this.drag;
  }

  /** The handle on the draft drawn now, or null (its arc or dimension is gone: an undo). */
  geom(d: SketchFeature | null = this.mode.draft()): RadiusHandleGeom | null {
    if (!this.target || !d) return null;
    if (!d.constraints.some((c) => c.id === this.target!.dim)) return null;
    return radiusHandleOf(d, this.target.arc);
  }

  /** Drop the handle when its arc or dimension is gone. */
  check(): boolean {
    if (this.target && !this.drag && !this.geom(this.mode.stored())) this.target = null;
    return !!this.target;
  }

  /** The handle for a preview. */
  previewHandles(): SketchPreview['handles'] {
    const g = this.geom();
    return g && this.target ? [{ id: this.target.arc, at: g.at, dir: g.dir, active: this.hovered || this.dragging }] : [];
  }

  /** The pointer is on the arrow (its grip or its shaft). */
  hit(e: SketchPointer): boolean {
    const g = this.geom();
    if (!g) return false;
    const rel: Vec2 = [e.uv[0] - g.at[0], e.uv[1] - g.at[1]];
    const along = rel[0] * g.dir[0] + rel[1] * g.dir[1];
    const across = Math.abs(rel[0] * -g.dir[1] + rel[1] * g.dir[0]);
    return along >= -GRAB_PX * e.px && along <= (ARROW_PX + 4) * e.px && across <= GRAB_PX * e.px;
  }

  /** A press on the arrow: the drag starts (false: not on it). */
  begin(e: SketchPointer): boolean {
    const base = this.mode.stored();
    if (!this.target || !base || !this.hit(e)) return false;
    const g = this.geom(base)!;
    const arc = entityOf(base, this.target.arc);
    const r0 = arc?.kind === 'arc' ? (arcGeom(base, arc)?.r ?? 0) : 0;
    if (!(r0 > 0)) return false;
    const units = this.mode.services.doc.units;
    const per = { mm: 1, cm: 10, m: 1000, in: 25.4, ft: 304.8 }[units.units().length];
    // The radius moves in steps a pixel can show, in round numbers of the display unit (0.1 mm at 0.06 mm per pixel).
    const step = Math.pow(10, Math.ceil(Math.log10(Math.max(1e-9, e.px / per)))) * per;
    this.drag = { from: e.uv, r0, dir: g.dir, base, limit: filletLimit(base, this.target.arc), min: step, step, fine: 0.01 * per };
    this.live = r0;
    this.lastGood = r0;
    this.stopped = null;
    this.want = null;
    // The solver starts from what is stored (after any edit still being solved).
    const ev = evaluateDimensions(base, units);
    this.chain = this.mode.queue(() => this.mode.solver.load(toSolverSketch(base, ev.values)));
    this.mode.view.set({ dragging: true });
    return true;
  }

  /** A move of the drag: the radius by how far the pointer went along the arrow. */
  move(e: SketchPointer) {
    const dr = this.drag;
    if (!dr || !this.target) return;
    const along = (e.uv[0] - dr.from[0]) * dr.dir[0] + (e.uv[1] - dr.from[1]) * dr.dir[1];
    let r = Math.round((dr.r0 + along) / dr.step) * dr.step;
    const units = this.mode.services.doc.units;
    this.stopped = null;
    if (dr.limit && r > dr.limit.max) {
      // Just under the limit (a line would be gone at it), in hundredths of the display unit.
      r = Math.floor(dr.limit.max / dr.fine) * dr.fine;
      if (!(r > 0) || r >= dr.limit.max) r = dr.limit.max * 0.999;
      this.stopped = limitWords(units, dr.limit);
    }
    if (r < dr.min) {
      r = dr.min;
      this.stopped = `Dragging stops at ${units.format(r, 'length', { digits: 2 })} at this zoom: type a smaller radius in the box`;
    }
    this.live = r;
    this.changed(r);
    this.solve(r);
  }

  private solve(r: number) {
    this.want = r;
    if (this.busy) return;
    this.busy = true;
    const step = () => {
      const dr = this.drag;
      const target = this.target;
      const v = this.want;
      this.want = null;
      if (!dr || !target || v == null) {
        this.busy = false;
        return;
      }
      // In the sketch's edit queue, so an edit asked meanwhile never runs between two solver calls.
      this.chain = this.mode
        .queue(() => this.mode.solver.setValue(target.dim, v))
        .then((res) => {
          // Only the newest asked for is drawn (a move that came meanwhile solves next).
          if (this.drag !== dr || this.want != null) return;
          if (!res.solved) {
            this.stopped = this.stopped ?? `The radius can't be ${this.mode.services.doc.units.format(v, 'length', { digits: 2 })} here: the sketch can't be solved with it`;
            return;
          }
          this.lastGood = v;
          const expr = this.expr(v);
          const draft = withSolved(dr.base, res.values);
          this.mode.view.set({ draft: { ...draft, constraints: draft.constraints.map((c) => (c.id === target.dim && isDimension(c) ? { ...c, expr } : c)) } });
        })
        .catch(() => {})
        .then(step);
    };
    step();
  }

  /** The release: the radius stored (one undo step). */
  async end(): Promise<ApplyResult | null> {
    const dr = this.drag;
    const target = this.target;
    if (!dr || !target) return null;
    this.want = null;
    // Let the last solve land, then store the value the drawing showed.
    await this.chain.catch(() => {});
    this.drag = null;
    this.mode.view.set({ dragging: false });
    const r = this.lastGood ?? dr.r0;
    if (Math.abs(r - dr.r0) < 1e-12) {
      this.mode.view.set({ draft: this.mode.stored() });
      this.live = dr.r0;
      return null;
    }
    return this.setRadius(this.expr(r));
  }

  /** Esc or another tool during a drag: what is stored comes back. */
  cancel() {
    if (!this.drag) return;
    this.drag = null;
    this.want = null;
    this.stopped = null;
    this.mode.view.set({ dragging: false, draft: this.mode.stored() });
  }

  /** Set the radius of the current fillet (the drag's release, or the Radius box typed): one undo step. */
  setRadius(expr: string): Promise<ApplyResult> {
    const target = this.target;
    if (!target) return Promise.resolve({ ok: false, reason: 'no fillet' });
    return this.mode.apply('Fillet radius', (cur) => {
      const dim = cur.constraints.find((c) => c.id === target.dim);
      if (!dim || !isDimension(dim)) return { ok: false, reason: 'that fillet is gone' };
      const b = new SketchBuilder(cur);
      b.constraints = b.constraints.map((c) => (c.id === target.dim ? { ...dim, expr } : c));
      return b.result();
    });
  }

  /** The stored radius expression of the current fillet ("5 mm"), or null. */
  stored(): string | null {
    const d = this.mode.stored();
    if (!this.target || !d) return null;
    const c = d.constraints.find((x) => x.id === this.target!.dim);
    return c && isDimension(c) ? c.expr : null;
  }

  /** Why a typed radius can't be used on the current fillet (too big for its corner), or null. */
  refusal(value: number): string | null {
    const d = this.mode.stored();
    if (!this.target || !d) return null;
    const lim = filletLimit(d, this.target.arc);
    if (lim && value >= lim.max) return limitWords(this.mode.services.doc.units, lim);
    return null;
  }

  private expr(r: number): string {
    const units = this.mode.services.doc.units;
    const per = { mm: 1, cm: 10, m: 1000, in: 25.4, ft: 304.8 }[units.units().length];
    return storeExpr(String(+(r / per).toPrecision(6)), 'length', units);
  }
}

/** "The radius can't be bigger than 20 mm here: the lines are too short" (the limit itself is not reached: a line would be gone). */
function limitWords(units: SketchMode['services']['doc']['units'], lim: { max: number; why: string }): string {
  return `The radius can't be bigger than ${units.format(lim.max, 'length', { digits: 2 })} here: ${lim.why}`;
}

/** The fillet arc an edit added (the new arc with a radius dimension), with that dimension. */
export function newFilletArc(before: SketchDraft, after: SketchDraft): { arc: string; dim: string } | null {
  const had = new Set(before.entities.map((e) => e.id));
  for (const e of after.entities) {
    if (had.has(e.id) || e.kind !== 'arc') continue;
    const dim = radiusDimensionOf(after, e.id);
    if (dim) return { arc: e.id, dim };
  }
  return null;
}
