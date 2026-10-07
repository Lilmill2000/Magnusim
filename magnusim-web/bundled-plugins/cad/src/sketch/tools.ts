// Sketch tools (proposal §2.1-2.3 MVP rows, §3.3): Select (pick, Ctrl+pick,
// window select, drag under-defined geometry), Line (chained click-click,
// the next segment a tangent arc with A or by dragging from the chain's end;
// centerline), Rectangle (2-point corner and centre), Circle (centre-radius),
// Arc (3-point and tangent), Point, Dimension (Smart Dimension: pick, then
// place the label; "Make it driven?" when it would over-define), Trim and
// Extend. Drawing tools infer relations while drawing (src/sketch/inference)
// and show value boxes for typed lengths, angles and diameters (Fusion: Tab
// locks a value, Enter places the shape with those dimensions).
// Owner: P3-SKETCH.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { SketchFeature, Vec2 } from '../types/doc';
import type { SketchToolId } from '../types/sketch';
import type { Quantity } from '../types/units';
import { planDimension, withDisplayUnit } from './dimensions';
import { SketchBuilder, extendAt, extendPreview, trimAt, trimPiece } from './edit';
import { add, angleOf, ccwSweep, circleThrough, dist, norm, polar, scale, sub, tangentArc } from './geom';
import { infer, tangentAtEnd, type Inference } from './inference';
import { entityEnds, entityLabel, entityOf, ORIGIN, pointAt } from './model';
import { emptyPreview, storeExpr, type SketchHit, type SketchMode, type SketchPointer, type SketchPreview, type SketchTool, type ValueBox } from './mode';
import { hitTest, samples } from './pick';
import { selectTool } from './select-tool';
import { autoProjectItem, intersectTool, modelItemAt, projectTool } from './project/tools';
import { linkedRefusal } from './project/curves';
import { modelSnap, placeOnModel } from './project/snap';
import { hiddenPoles } from './project/style';
import { newId } from '../lib/ids';
// P4b (SKETCH): splines, mirror, patterns, offset, fillet, chamfer.
import { splineTool } from './tools/spline';
import { mirrorTool } from './tools/mirror';
import { patternTool } from './tools/pattern';
import { offsetTool } from './tools/offset';
import { filletTool } from './tools/fillet';

type Draft = SketchFeature;
const DRAG_PX = 4;

// ------------------------------------------------------------ shared pieces

/** Where a click lands: an existing point (joined), or a new point with the relations its snap asks for. */
export function placePoint(b: SketchBuilder, inf: Inference, id?: string): string {
  const s = inf.snap;
  // P4b SELECT: a snap on the model adds its linked reference and the relation to it.
  if (s?.kind === 'model') return placeOnModel(b, s.model, id);
  if (s?.kind === 'point' && s.id !== ORIGIN && b.points[s.id]) return s.id;
  const p = b.addPoint(inf.at, id);
  if (s?.kind === 'point') b.addRelation('coincident', [p, s.id], { inferred: true, optional: true });
  else if (s?.kind === 'midpoint') b.addRelation('midpoint', [p, s.line], { inferred: true, optional: true });
  else if (s?.kind === 'curve') onCurve(b, p, s.entity);
  else if (s?.kind === 'intersection') {
    onCurve(b, p, s.entities[0]);
    onCurve(b, p, s.entities[1]);
  }
  return p;
}

function onCurve(b: SketchBuilder, p: string, entity: string) {
  const e = entityOf(b, entity);
  if (!e) return;
  b.addRelation(e.kind === 'line' ? 'point_on_line' : 'point_on_circle', [p, entity], { inferred: true, optional: true });
}

/** The point id a snap lands on when it joins an existing point (not the origin). */
export function joinedPoint(inf: Inference): string | null {
  return inf.snap?.kind === 'point' && inf.snap.id !== ORIGIN ? inf.snap.id : null;
}

export function glyphsOf(inf: Inference | null): SketchPreview['glyphs'] {
  return inf && inf.glyphs.length ? [{ at: inf.at, kinds: inf.glyphs }] : [];
}

/** Value boxes typed while drawing (Fusion): text typed and valid = used; empty = follows the pointer. */
export class Boxes {
  private typed = new Map<string, string>();
  constructor(
    private readonly mode: SketchMode,
    private readonly defs: { id: string; label: string; quantity: Quantity }[],
  ) {}

  reset() {
    this.typed.clear();
  }

  set(id: string, text: string) {
    if (text.trim()) this.typed.set(id, text);
    else this.typed.delete(id);
  }

  /** A typed value (mm / deg), or null when the box follows the pointer (or holds an invalid entry). */
  value(id: string): number | null {
    const t = this.typed.get(id);
    if (t == null) return null;
    const def = this.defs.find((d) => d.id === id)!;
    const r = this.mode.services.doc.units.evaluate(t, def.quantity);
    return r.ok ? r.value : null;
  }

  /** The stored expression of a typed box ("40" -> "40 mm"). */
  expr(id: string): string | null {
    const t = this.typed.get(id);
    if (t == null || this.value(id) == null) return null;
    const def = this.defs.find((d) => d.id === id)!;
    return storeExpr(t, def.quantity === 'angle' ? 'angle' : 'length', this.mode.services.doc.units);
  }

  any(): boolean {
    return this.typed.size > 0;
  }

  /** The boxes to draw: typed text, or the value now (display units). `problems`: a typed value the shape cannot take. */
  render(now: Record<string, number>, at: Record<string, Vec2>, problems: Record<string, string | null> = {}, along: Record<string, [Vec2, Vec2]> = {}): ValueBox[] {
    const units = this.mode.services.doc.units;
    return this.defs.map((d) => {
      const t = this.typed.get(d.id);
      let error: string | null = null;
      if (t != null) {
        const r = this.mode.services.doc.units.evaluate(t, d.quantity);
        if (!r.ok) error = r.error;
        else if (d.quantity === 'length' && !(r.value > 0)) error = 'Must be more than 0';
        else error = problems[d.id] ?? null;
      }
      const v = now[d.id] ?? 0;
      // The value now with its unit ("40 mm", "30°"): typing replaces it, and the same text parses back.
      const shown = withDisplayUnit(v, d.quantity === 'angle' ? 'angle' : 'length', units);
      return { id: d.id, label: d.label, at: at[d.id] ?? [0, 0], along: along[d.id] ?? null, text: t ?? shown, locked: t != null && !error, error, quantity: d.quantity === 'angle' ? 'angle' : 'length' };
    });
  }
}

export function base(mode: SketchMode, id: SketchToolId) {
  return {
    id,
    draft: (): Draft | null => mode.draft(),
    infer: (e: SketchPointer, extra: Partial<Parameters<typeof infer>[0]> = {}): Inference => {
      const d = mode.draft();
      // P4b SELECT: a projected spline's inner poles are never snapped to.
      const hidden = d ? hiddenPoles(d) : null;
      const exclude = hidden?.size ? new Set([...(extra.exclude ?? []), ...hidden]) : extra.exclude;
      const inf = infer({ f: d ?? { points: {}, entities: [] }, at: e.uv, px: e.px, suppress: e.ctrl, ...extra, ...(exclude ? { exclude } : {}) });
      // P4b SELECT: nothing of the sketch's own under the pointer: a vertex, an edge, a centre or a pierce point of a body.
      if (!e.ctrl && !inf.snap && !extra.suppress) {
        const plane = mode.plane();
        const ms = plane ? modelSnap(mode.services, plane, e, () => mode.repeatPointer?.()) : null;
        if (ms) return { at: ms.at, snap: { kind: 'model', model: ms }, direction: null, glyphs: [ms.glyph], guides: [] };
      }
      return inf;
    },
  };
}

// ------------------------------------------------------------ Select: src/sketch/select-tool.ts (P4b SELECT owns it)

// ------------------------------------------------------------ Line (and Centerline)

function lineTool(mode: SketchMode, id: 'line' | 'centerline'): SketchTool {
  const t = base(mode, id);
  const boxes = new Boxes(mode, [
    { id: 'length', label: 'Length', quantity: 'length' },
    { id: 'angle', label: 'Angle', quantity: 'angle' },
  ]);
  /**
   * The start of the segment being drawn. `point` is its id: an existing point
   * (joined), or one this tool makes with the first segment (`fresh`, placed
   * with the first click's snap).
   */
  let start: { at: Vec2; inf: Inference | null; point: string; fresh: boolean } | null = null;
  /** The previous segment of the chain, and the chain's first point (clicking it closes the chain). */
  let prev: string | null = null;
  let chainFirst: string | null = null;
  let last: SketchPointer | null = null;
  let press: { client: [number, number]; onEnd: boolean } | null = null;
  let arcDrag = false;

  function endChain() {
    start = null;
    prev = null;
    chainFirst = null;
    boxes.reset();
    arcDrag = false;
    mode.view.set({ lineArc: false });
  }

  /** Where the segment ends now: typed values first, then inference. */
  function endOf(e: SketchPointer): { at: Vec2; inf: Inference | null } {
    const s = start!.at;
    const d = t.draft();
    const sp = start!.point;
    const from = prev ? [prev] : !start!.fresh && d ? d.entities.filter((x) => entityEnds(x).includes(sp)).map((x) => x.id) : [];
    const inf = t.infer(e, { anchor: { at: s, point: start!.fresh ? null : sp }, from, directions: true, exclude: new Set([sp]) });
    const L = boxes.value('length');
    const A = boxes.value('angle');
    if (L == null && A == null) return { at: inf.at, inf };
    if (L != null && A == null && inf.direction && dist(inf.at, s) > 1e-9) {
      // Only a length typed: the direction the preview snapped to holds (horizontal, vertical,
      // parallel, perpendicular, tangent), with its relation, as a click there adds it. Review
      // P2/P3 round 2: the raw pointer direction was used, so a line previewed horizontal was
      // stored 2.86 degrees off, with no relation.
      const at = add(s, scale(norm(sub(inf.at, s)), L));
      return { at, inf: { at, snap: null, direction: inf.direction, glyphs: [inf.direction.kind], guides: [[s, at]] } };
    }
    let dir = norm(sub(e.uv, s));
    if (A != null) dir = [Math.cos((A * Math.PI) / 180), Math.sin((A * Math.PI) / 180)];
    if (!dir[0] && !dir[1]) dir = [1, 0];
    const len = L ?? Math.max(0, (e.uv[0] - s[0]) * dir[0] + (e.uv[1] - s[1]) * dir[1]);
    return { at: add(s, scale(dir, len)), inf: null };
  }

  /** The tangent arc continuing the chain to `to` (A toggled, or a drag from the chain's end). */
  function arcTo(to: Vec2): { c: Vec2; r: number; ccw: boolean } | null {
    const d = t.draft();
    if (!d || !start || !prev) return null;
    const pe = entityOf(d, prev);
    if (!pe) return null;
    const tan = tangentAtEnd(d, pe, start.point);
    return tan ? tangentArc(start.at, tan, to) : null;
  }

  const arcMode = () => (mode.view.get().lineArc || arcDrag) && !!prev && !!start;

  function show(e: SketchPointer) {
    last = e;
    const p = emptyPreview();
    if (!start) {
      const inf = t.infer(e);
      p.glyphs = glyphsOf(inf);
      p.guides = inf.guides;
      p.points = [inf.at];
      mode.setPreview(p);
      return;
    }
    if (arcMode()) {
      const inf = t.infer(e, { exclude: new Set([start.point]) });
      const arc = arcTo(inf.at);
      if (arc) {
        const a0 = angleOf(arc.c, arc.ccw ? start.at : inf.at);
        const a1 = angleOf(arc.c, arc.ccw ? inf.at : start.at);
        p.arcs.push({ c: arc.c, r: arc.r, a0, sweep: ccwSweep(a0, a1) });
      }
      p.glyphs = [{ at: start.at, kinds: ['tangent'] }, ...glyphsOf(inf)];
      p.points = [inf.at];
      mode.setPreview(p);
      return;
    }
    const end = endOf(e);
    p.lines.push([start.at, end.at]);
    p.points = [start.at, end.at];
    if (end.inf) {
      p.glyphs = glyphsOf(end.inf);
      p.guides = end.inf.guides;
    }
    const len = dist(start.at, end.at);
    const ang = (angleOf(start.at, end.at) * 180) / Math.PI;
    const m: Vec2 = [(start.at[0] + end.at[0]) / 2, (start.at[1] + end.at[1]) / 2];
    // Length beside the line (Fusion), never on it: review P2/P3 round 4, a vertical line's boxes covered it.
    p.boxes = boxes.render({ length: len, angle: ang }, { length: m, angle: start.at }, {}, { length: [start.at, end.at] });
    mode.setPreview(p);
  }

  /** Commit one straight segment ending at `end` (with the typed dimensions). False when there is none to place. */
  function commitLine(end: { at: Vec2; inf: Inference | null }): boolean {
    const s = start!;
    if (dist(s.at, end.at) < 1e-9) return false;
    const lineId = newId('e');
    const endId = (end.inf && joinedPoint(end.inf)) || newId('pt');
    const lengthExpr = boxes.expr('length');
    const angleExpr = boxes.expr('angle');
    const first = chainFirst ?? s.point;
    void mode
      .apply(id === 'centerline' ? 'Centerline' : 'Line', (d) => {
        const b = new SketchBuilder(d);
        let a = s.point;
        if (s.fresh) a = placePoint(b, s.inf ?? { at: s.at, snap: null, direction: null, glyphs: [], guides: [] }, s.point);
        else if (!b.points[a]) return { ok: false, reason: 'the line it continues from is gone' };
        const z = end.inf ? placePoint(b, end.inf, endId) : b.addPoint(end.at, endId);
        if (a === z) return { ok: false, reason: 'a line needs two different ends' };
        b.addEntity({ id: lineId, kind: 'line', p: [a, z], ...(id === 'centerline' ? { construction: true, centerline: true } : {}) });
        const dir = end.inf?.direction;
        if (dir) {
          if (dir.kind === 'horizontal' || dir.kind === 'vertical') b.addRelation(dir.kind, [lineId], { inferred: true, optional: true });
          else if (dir.kind === 'tangent') b.addRelation('tangent', [lineId, dir.curve], { inferred: true, optional: true });
          else if ('line' in dir) b.addRelation(dir.kind, [lineId, dir.line], { inferred: true, optional: true });
        }
        if (lengthExpr) b.addDimension('distance', [lineId], lengthExpr);
        if (angleExpr) b.addDimension('angle', [lineId], angleExpr);
        return b.result();
      })
      .then((r) => {
        if (!r.ok && prev === lineId) endChain();
        mode.refreshHint();
      });
    // The chain goes on from the new end (the edits run in order).
    boxes.reset();
    if (endId === first) {
      // Back at the chain's first point: the loop is closed, the next click starts a new chain.
      endChain();
      return true;
    }
    chainFirst = first;
    prev = lineId;
    start = { at: end.at, inf: null, point: endId, fresh: false };
    mode.view.set({ lineArc: false });
    return true;
  }

  function commitArc(inf: Inference) {
    const s = start!;
    const arc = arcTo(inf.at);
    if (!arc || !prev) return;
    const arcId = newId('e');
    const endId = joinedPoint(inf) || newId('pt');
    const from = prev;
    void mode
      .apply('Tangent arc', (d) => {
        const b = new SketchBuilder(d);
        if (!b.points[s.point]) return { ok: false, reason: 'the line it continues from is gone' };
        const z = placePoint(b, inf, endId);
        const c = b.addPoint(arc.c);
        b.addEntity({ id: arcId, kind: 'arc', c, a: s.point, b: z, ...(arc.ccw ? {} : { ccw: false }) });
        b.addRelation('tangent', [from, arcId], { inferred: true });
        return b.result();
      })
      .then((r) => {
        if (!r.ok && prev === arcId) endChain();
        mode.refreshHint();
      });
    if (endId === chainFirst) {
      endChain();
      return;
    }
    prev = arcId;
    start = { at: inf.at, inf: null, point: endId, fresh: false };
    mode.view.set({ lineArc: false });
  }

  return {
    id,
    hint: () =>
      !start
        ? `Click where the ${id === 'centerline' ? 'centerline' : 'line'} starts. Ctrl draws without inferred constraints.`
        : mode.view.get().lineArc && prev
          ? 'Click where the tangent arc ends (A switches back to a line).'
          : 'Click the next point, or type a length, Tab, an angle, Enter. A: tangent arc next. Double-click or Escape ends the chain.',
    cancel() {
      const had = !!start;
      endChain();
      mode.setPreview(null);
      return had;
    },
    toggleArc() {
      if (!start || !prev) return false;
      mode.view.set({ lineArc: !mode.view.get().lineArc });
      if (last) show(last);
      mode.refreshHint();
      return true;
    },
    box(bid, action, text) {
      boxes.set(bid, text);
      let placed = false;
      if (action === 'enter' && start && last) {
        // The chain's next segment starts with empty boxes that follow the pointer (commitLine resets them).
        placed = commitLine(endOf(last));
        mode.refreshHint();
      }
      if (last) show(last);
      return placed;
    },
    pointer(e) {
      if (e.type === 'move') {
        if (press && press.onEnd && prev && !arcDrag && Math.hypot(e.clientX - press.client[0], e.clientY - press.client[1]) > DRAG_PX) arcDrag = true;
        show(e);
        return;
      }
      if (e.type === 'down') {
        press = { client: [e.clientX, e.clientY], onEnd: !!start && dist(e.uv, start.at) <= 8 * e.px };
        return;
      }
      if (e.type === 'up') {
        if (arcDrag && start) {
          // Fusion: a drag from the chain's end draws a tangent arc.
          commitArc(t.infer(e, { exclude: new Set([start.point]) }));
          arcDrag = false;
          mode.refreshHint();
          show(e);
        }
        press = null;
        return;
      }
      if (e.type === 'dblclick') {
        endChain();
        mode.setPreview(null);
        mode.refreshHint();
        return;
      }
      if (e.type === 'click') {
        if (!start) {
          const inf = t.infer(e);
          const joined = joinedPoint(inf);
          start = { at: inf.at, inf, point: joined ?? newId('pt'), fresh: !joined };
          chainFirst = null;
          prev = null;
          mode.refreshHint();
          show(e);
          return;
        }
        if (mode.view.get().lineArc && prev) commitArc(t.infer(e, { exclude: new Set([start.point]) }));
        else commitLine(endOf(e));
        mode.refreshHint();
        show(e);
        return;
      }
      if (e.type === 'leave' && !start) mode.setPreview(null);
    },
  };
}

// ------------------------------------------------------------ Rectangles

function rectangleTool(mode: SketchMode, id: 'rectangle-corner' | 'rectangle-center'): SketchTool {
  const t = base(mode, id);
  const boxes = new Boxes(mode, [
    { id: 'width', label: 'Width', quantity: 'length' },
    { id: 'height', label: 'Height', quantity: 'length' },
  ]);
  let first: Inference | null = null;
  let last: SketchPointer | null = null;
  const center = id === 'rectangle-center';

  /** The two corners now (typed width / height first). */
  function corners(e: SketchPointer): { a: Vec2; b: Vec2; inf: Inference | null } {
    const f = first!.at;
    const W = boxes.value('width');
    const H = boxes.value('height');
    const inf = W == null && H == null ? t.infer(e) : null;
    const to = inf?.at ?? e.uv;
    const sx = Math.sign(to[0] - f[0]) || 1;
    const sy = Math.sign(to[1] - f[1]) || 1;
    if (center) {
      const hw = W != null ? W / 2 : Math.abs(to[0] - f[0]);
      const hh = H != null ? H / 2 : Math.abs(to[1] - f[1]);
      return { a: [f[0] - sx * hw, f[1] - sy * hh], b: [f[0] + sx * hw, f[1] + sy * hh], inf };
    }
    const w = W ?? Math.abs(to[0] - f[0]);
    const h = H ?? Math.abs(to[1] - f[1]);
    return { a: f, b: [f[0] + sx * w, f[1] + sy * h], inf };
  }

  function show(e: SketchPointer) {
    last = e;
    const p = emptyPreview();
    if (!first) {
      const inf = t.infer(e);
      p.glyphs = glyphsOf(inf);
      p.points = [inf.at];
      p.guides = inf.guides;
      mode.setPreview(p);
      return;
    }
    const { a, b, inf } = corners(e);
    const c: Vec2[] = [a, [b[0], a[1]], b, [a[0], b[1]]];
    for (let i = 0; i < 4; i++) p.lines.push([c[i], c[(i + 1) % 4]]);
    p.points = center ? [first.at, ...c] : c;
    if (inf) {
      p.glyphs = glyphsOf(inf);
      p.guides = inf.guides;
    }
    const u0 = Math.min(a[0], b[0]);
    const u1 = Math.max(a[0], b[0]);
    const v0 = Math.min(a[1], b[1]);
    const v1 = Math.max(a[1], b[1]);
    // Each beside the side it measures (the Height box sat on the right side).
    p.boxes = boxes.render(
      { width: u1 - u0, height: v1 - v0 },
      { width: [(u0 + u1) / 2, v0], height: [u1, (v0 + v1) / 2] },
      {},
      { width: [[u0, v0], [u1, v0]], height: [[u1, v0], [u1, v1]] },
    );
    mode.setPreview(p);
  }

  function commit(e: SketchPointer): boolean {
    const { a, b, inf } = corners(e);
    if (Math.abs(b[0] - a[0]) < 1e-9 || Math.abs(b[1] - a[1]) < 1e-9) {
      mode.note('Not applied: a rectangle needs a width and a height');
      return false;
    }
    const f0 = first!;
    const W = boxes.expr('width');
    const H = boxes.expr('height');
    void mode.apply(center ? 'Center rectangle' : 'Rectangle', (d) => {
      const bld = new SketchBuilder(d);
      // Corners counter-clockwise from the lower left: a region's boundary runs the same way every time.
      const lo: Vec2 = [Math.min(a[0], b[0]), Math.min(a[1], b[1])];
      const hi: Vec2 = [Math.max(a[0], b[0]), Math.max(a[1], b[1])];
      const pos: Vec2[] = [lo, [hi[0], lo[1]], hi, [lo[0], hi[1]]];
      const ids: string[] = [];
      for (const p of pos) {
        // The corner the user clicked (corner rectangle) or ends on keeps its snap.
        if (!center && dist(p, f0.at) < 1e-9) ids.push(placePoint(bld, f0));
        else if (!center && inf && dist(p, inf.at) < 1e-9 && inf.snap) ids.push(placePoint(bld, inf));
        else ids.push(bld.addPoint(p));
      }
      const lines = [0, 1, 2, 3].map((i) => bld.addEntity({ id: newId('e'), kind: 'line', p: [ids[i], ids[(i + 1) % 4]] }));
      bld.addRelation('horizontal', [lines[0]], { inferred: true, optional: true });
      bld.addRelation('vertical', [lines[1]], { inferred: true, optional: true });
      bld.addRelation('horizontal', [lines[2]], { inferred: true, optional: true });
      bld.addRelation('vertical', [lines[3]], { inferred: true, optional: true });
      if (center) {
        const cp = placePoint(bld, f0);
        bld.addEntity({ id: newId('e'), kind: 'point', p: cp, construction: true });
        bld.addRelation('symmetric', [ids[0], ids[2], cp], { inferred: true });
      }
      if (W) bld.addDimension('distance', [lines[0]], W);
      if (H) bld.addDimension('distance', [lines[1]], H);
      return bld.result();
    });
    first = null;
    boxes.reset();
    mode.setPreview(null);
    return true;
  }

  return {
    id,
    hint: () =>
      !first ? (center ? 'Click the centre of the rectangle.' : 'Click the first corner of the rectangle.') : 'Click the opposite corner, or type the width, Tab, the height, Enter.',
    cancel() {
      const had = !!first;
      first = null;
      boxes.reset();
      mode.setPreview(null);
      return had;
    },
    box(bid, action, text) {
      boxes.set(bid, text);
      if (action === 'enter' && first && last) {
        const placed = commit(last);
        mode.refreshHint();
        return placed;
      }
      if (last) show(last);
      return false;
    },
    pointer(e) {
      if (e.type === 'move') return show(e);
      if (e.type === 'click') {
        if (!first) {
          first = t.infer(e);
          mode.refreshHint();
          show(e);
          return;
        }
        commit(e);
        mode.refreshHint();
      }
      if (e.type === 'leave' && !first) mode.setPreview(null);
    },
  };
}

// ------------------------------------------------------------ Circle

function circleTool(mode: SketchMode): SketchTool {
  const t = base(mode, 'circle');
  const boxes = new Boxes(mode, [{ id: 'diameter', label: 'Diameter', quantity: 'length' }]);
  let centre: Inference | null = null;
  let last: SketchPointer | null = null;
  const radius = (e: SketchPointer) => {
    const D = boxes.value('diameter');
    return D != null ? D / 2 : dist(centre!.at, e.uv);
  };
  function show(e: SketchPointer) {
    last = e;
    const p = emptyPreview();
    if (!centre) {
      const inf = t.infer(e);
      p.glyphs = glyphsOf(inf);
      p.points = [inf.at];
      mode.setPreview(p);
      return;
    }
    const r = radius(e);
    p.arcs.push({ c: centre.at, r, a0: 0, sweep: Math.PI * 2 });
    p.points = [centre.at];
    p.boxes = boxes.render({ diameter: 2 * r }, { diameter: polar(centre.at, r, Math.PI / 4) });
    mode.setPreview(p);
  }
  function commit(e: SketchPointer): boolean {
    const r = radius(e);
    if (!(r > 0)) return false;
    const c0 = centre!;
    const D = boxes.expr('diameter');
    void mode.apply('Circle', (d) => {
      const b = new SketchBuilder(d);
      const c = placePoint(b, c0);
      const id = b.addEntity({ id: newId('e'), kind: 'circle', c, r });
      if (D) b.addDimension('diameter', [id], D);
      return b.result();
    });
    centre = null;
    boxes.reset();
    mode.setPreview(null);
    return true;
  }
  return {
    id: 'circle',
    hint: () => (!centre ? 'Click the centre of the circle.' : 'Click a point on the circle, or type the diameter and Enter.'),
    cancel() {
      const had = !!centre;
      centre = null;
      boxes.reset();
      mode.setPreview(null);
      return had;
    },
    box(bid, action, text) {
      boxes.set(bid, text);
      if (action === 'enter' && centre && last) {
        const placed = commit(last);
        mode.refreshHint();
        return placed;
      }
      if (last) show(last);
      return false;
    },
    pointer(e) {
      if (e.type === 'move') return show(e);
      if (e.type === 'click') {
        if (!centre) {
          centre = t.infer(e);
          mode.refreshHint();
          show(e);
          return;
        }
        commit(e);
        mode.refreshHint();
      }
      if (e.type === 'leave' && !centre) mode.setPreview(null);
    },
  };
}

// ------------------------------------------------------------ Arcs

function arcThreePointTool(mode: SketchMode): SketchTool {
  const t = base(mode, 'arc-3pt');
  const boxes = new Boxes(mode, [{ id: 'radius', label: 'Radius', quantity: 'length' }]);
  let a: Inference | null = null;
  let b: Inference | null = null;
  let last: SketchPointer | null = null;
  /** The last arc shown that could be placed (kept on screen while a typed radius is too small). */
  let lastArc: { c: Vec2; r: number; ccw: boolean } | null = null;

  /**
   * Why a typed radius cannot make an arc between the two ends ("Radius must be at least 20 mm"), or
   * null. The least is said to 2 decimals in the display unit, and a radius that rounds to it is taken
   * (a half circle): ends clicked 40.0001 mm apart still take "20".
   */
  function radiusProblem(): string | null {
    const R = boxes.value('radius');
    if (R == null || !a || !b) return null;
    const half = dist(a.at, b.at) / 2;
    const units = mode.services.doc.units;
    const per = { mm: 1, cm: 10, m: 1000, in: 25.4, ft: 304.8 }[units.units().length];
    if (R >= half - 0.005 * per) return null;
    return `Radius must be at least ${units.format(half, 'length', { digits: 2 })}`;
  }

  /** The arc from a to b through (or bulging towards) the pointer; a typed radius keeps the pointer's side. */
  function arcNow(e: SketchPointer): { c: Vec2; r: number; ccw: boolean } | null {
    const R = boxes.value('radius');
    const through = circleThrough(a!.at, e.uv, b!.at);
    if (R == null) return through;
    const half = dist(a!.at, b!.at) / 2;
    if (radiusProblem()) return null;
    const Rv = Math.max(R, half);
    const m: Vec2 = [(a!.at[0] + b!.at[0]) / 2, (a!.at[1] + b!.at[1]) / 2];
    const n = norm([-(b!.at[1] - a!.at[1]), b!.at[0] - a!.at[0]]);
    const side = (e.uv[0] - m[0]) * n[0] + (e.uv[1] - m[1]) * n[1] >= 0 ? 1 : -1;
    const h = Math.sqrt(Math.max(0, Rv * Rv - half * half));
    // The centre lies opposite the bulge for an arc shorter than half the circle.
    const c = add(m, scale(n, -side * h));
    return { c, r: Rv, ccw: side < 0 };
  }

  function show(e: SketchPointer) {
    last = e;
    const p = emptyPreview();
    if (!a || !b) {
      const inf = t.infer(e);
      p.glyphs = glyphsOf(inf);
      p.points = a ? [a.at, inf.at] : [inf.at];
      if (a) p.guides = [[a.at, inf.at]];
      mode.setPreview(p);
      return;
    }
    // The Radius box stays while the arc cannot be drawn (a typed radius too small, the pointer on the
    // chord): it holds the keyboard. (Review P2/P3 round 1: it vanished at the first digit, so the next
    // keys ran shortcuts: '5' Top view, Enter Finish sketch.)
    const problem = radiusProblem();
    const now = arcNow(e);
    if (now) lastArc = now;
    const arc = now ?? lastArc;
    if (arc) {
      const s = angleOf(arc.c, arc.ccw ? a.at : b.at);
      const en = angleOf(arc.c, arc.ccw ? b.at : a.at);
      p.arcs.push({ c: arc.c, r: arc.r, a0: s, sweep: ccwSweep(s, en) });
    }
    p.boxes = boxes.render({ radius: arc ? arc.r : dist(a.at, b.at) / 2 }, { radius: e.uv }, { radius: problem });
    p.points = [a.at, b.at];
    mode.setPreview(p);
  }

  function commit(e: SketchPointer): boolean {
    const problem = radiusProblem();
    if (problem) {
      mode.note(`Not applied: ${problem}`);
      return false;
    }
    const arc = arcNow(e);
    if (!arc) {
      mode.note('Not applied: the three points of an arc must not lie on one line');
      return false;
    }
    const a0 = a!;
    const b0 = b!;
    const R = boxes.expr('radius');
    void mode.apply('Arc', (d) => {
      const bld = new SketchBuilder(d);
      const pa = placePoint(bld, a0);
      const pb = placePoint(bld, b0);
      if (pa === pb) return { ok: false, reason: 'an arc needs two different ends' };
      const c = bld.addPoint(arc.c);
      const id = bld.addEntity({ id: newId('e'), kind: 'arc', c, a: pa, b: pb, ...(arc.ccw ? {} : { ccw: false }) });
      if (R) bld.addDimension('radius', [id], R);
      return bld.result();
    });
    a = b = null;
    lastArc = null;
    boxes.reset();
    mode.setPreview(null);
    mode.note(null);
    return true;
  }

  return {
    id: 'arc-3pt',
    hint: () => (!a ? 'Click where the arc starts.' : !b ? 'Click where the arc ends.' : 'Click a point the arc passes through, or type its radius and Enter.'),
    cancel() {
      const had = !!a;
      a = b = null;
      lastArc = null;
      boxes.reset();
      mode.setPreview(null);
      return had;
    },
    box(bid, action, text) {
      boxes.set(bid, text);
      if (action === 'enter' && a && b && last) {
        const placed = commit(last);
        mode.refreshHint();
        if (!placed) show(last);
        return placed;
      }
      if (last) show(last);
      return false;
    },
    pointer(e) {
      if (e.type === 'move') return show(e);
      if (e.type === 'click') {
        if (!a) a = t.infer(e);
        else if (!b) {
          const inf = t.infer(e);
          if (dist(inf.at, a.at) < 1e-9) return;
          b = inf;
        } else commit(e);
        mode.refreshHint();
        show(e);
      }
      if (e.type === 'leave' && !a) mode.setPreview(null);
    },
  };
}

function tangentArcTool(mode: SketchMode): SketchTool {
  const t = base(mode, 'arc-tangent');
  let from: { point: string; at: Vec2; curve: string; tan: Vec2 } | null = null;

  function startAt(e: SketchPointer): typeof from | string {
    const d = mode.draft();
    if (!d) return 'The sketch is closed';
    const h = hitTest(d, e.uv, e.px, { entities: false });
    const pid = h?.what === 'point' ? h.id : null;
    if (!pid) return 'Start a tangent arc at the end of a line or an arc';
    const curve = d.entities.find((x) => (x.kind === 'line' || x.kind === 'arc') && entityEnds(x).includes(pid));
    if (!curve) return 'Start a tangent arc at the end of a line or an arc';
    const tan = tangentAtEnd(d, curve, pid);
    const at = pointAt(d, pid);
    if (!tan || !at) return 'Start a tangent arc at the end of a line or an arc';
    return { point: pid, at, curve: curve.id, tan };
  }

  function show(e: SketchPointer) {
    const p = emptyPreview();
    if (!from) {
      const d = mode.draft();
      const h = d ? hitTest(d, e.uv, e.px, { entities: false }) : null;
      if (h) p.points = [pointAt(d!, h.id) ?? e.uv];
      mode.setPreview(p);
      return;
    }
    const inf = t.infer(e, { exclude: new Set([from.point]) });
    const arc = tangentArc(from.at, from.tan, inf.at);
    if (arc) {
      const s = angleOf(arc.c, arc.ccw ? from.at : inf.at);
      const en = angleOf(arc.c, arc.ccw ? inf.at : from.at);
      p.arcs.push({ c: arc.c, r: arc.r, a0: s, sweep: ccwSweep(s, en) });
    }
    p.glyphs = [{ at: from.at, kinds: ['tangent'] }, ...glyphsOf(inf)];
    p.points = [from.at, inf.at];
    mode.setPreview(p);
  }

  return {
    id: 'arc-tangent',
    hint: () => (!from ? 'Click the end of a line or an arc to start a tangent arc.' : 'Click where the tangent arc ends.'),
    cancel() {
      const had = !!from;
      from = null;
      mode.setPreview(null);
      return had;
    },
    pointer(e) {
      if (e.type === 'move') return show(e);
      if (e.type !== 'click') return;
      if (!from) {
        const s = startAt(e);
        if (typeof s === 'string') {
          mode.note(s);
          return;
        }
        from = s;
        mode.note(null);
        mode.refreshHint();
        return;
      }
      const inf = t.infer(e, { exclude: new Set([from.point]) });
      const arc = tangentArc(from.at, from.tan, inf.at);
      if (!arc) {
        mode.note('Not applied: that end lies on the tangent line: draw a line instead');
        return;
      }
      const f0 = from;
      const endId = joinedPoint(inf) ?? newId('pt');
      void mode.apply('Tangent arc', (d) => {
        const b = new SketchBuilder(d);
        if (!b.points[f0.point]) return { ok: false, reason: 'the end it starts from is gone' };
        const z = placePoint(b, inf, b.points[endId] ? undefined : endId);
        const c = b.addPoint(arc.c);
        const id = b.addEntity({ id: newId('e'), kind: 'arc', c, a: f0.point, b: z, ...(arc.ccw ? {} : { ccw: false }) });
        b.addRelation('tangent', [f0.curve, id], { inferred: true });
        return b.result();
      });
      from = null;
      mode.setPreview(null);
      mode.refreshHint();
    },
  };
}

// ------------------------------------------------------------ Point

function pointTool(mode: SketchMode): SketchTool {
  const t = base(mode, 'point');
  return {
    id: 'point',
    hint: () => 'Click to place a point.',
    cancel: () => false,
    pointer(e) {
      if (e.type === 'move') {
        const inf = t.infer(e);
        const p = emptyPreview();
        p.points = [inf.at];
        p.glyphs = glyphsOf(inf);
        p.guides = inf.guides;
        mode.setPreview(p);
        return;
      }
      if (e.type !== 'click') return;
      const inf = t.infer(e);
      if (joinedPoint(inf)) {
        mode.note('There is a point here already');
        return;
      }
      void mode.apply('Point', (d) => {
        const b = new SketchBuilder(d);
        const p = placePoint(b, inf);
        b.addEntity({ id: newId('e'), kind: 'point', p });
        return b.result();
      });
    },
  };
}

// ------------------------------------------------------------ Dimension (Smart Dimension)

function dimensionTool(mode: SketchMode): SketchTool {
  let picks: string[] = [];
  const refOf = (h: SketchHit, d: Draft): string => {
    if (h.what === 'entity') {
      const e = entityOf(d, h.id);
      return e?.kind === 'point' ? e.p : h.id;
    }
    return h.id;
  };
  function highlight() {
    const f = mode.feature;
    if (!f) return;
    const d = mode.draft();
    mode.select(
      picks.map((id) => ({ what: d?.points[id] || id === ORIGIN ? 'point' : 'entity', id })),
      false,
    );
  }
  return {
    id: 'dimension',
    // ci2: a label or glyph clicked keeps the picks (src/sketch/mode.ts refusesPick); a double-click still edits a value.
    refusesPick: (what) =>
      what === 'dimension'
        ? "A dimension can't be dimensioned: pick a line, a circle, an arc or points (double-click a dimension to edit it)"
        : "A relation can't be dimensioned: pick a line, a circle, an arc or points",
    hint: () =>
      !picks.length
        ? 'Pick a line, a circle, an arc, or two points, lines or curves to dimension.'
        : 'Pick one more, or click an empty place to put the dimension there.',
    cancel() {
      const had = picks.length > 0;
      picks = [];
      mode.setPreview(null);
      if (had) mode.select([], false);
      return had;
    },
    pointer(e) {
      const d = mode.draft();
      if (!d) return;
      if (e.type === 'move') {
        const h = hitTest(d, e.uv, e.px);
        mode.setHover(h);
        if (picks.length && !h) {
          const plan = planDimension(d, picks, e.uv);
          const p = emptyPreview();
          if ('kind' in plan) p.dimension = { kind: plan.kind, refs: plan.refs, at: e.uv };
          mode.setPreview(p);
        } else mode.setPreview(null);
        return;
      }
      if (e.type !== 'click') return;
      const h = hitTest(d, e.uv, e.px);
      if (h && h.what !== 'constraint') {
        const ref = refOf(h, d);
        if (picks.includes(ref)) return;
        picks = picks.length >= 2 ? [ref] : [...picks, ref];
        highlight();
        mode.note(null);
        mode.refreshHint();
        return;
      }
      if (!picks.length) return;
      // P4b SELECT: a body vertex or edge as the second pick: auto-projected, then dimensioned to.
      const onModel = picks.length === 1 ? modelItemAt(mode, e) : null;
      if (onModel) {
        const first = picks[0];
        void autoProjectItem(mode, onModel).then((r) => {
          if (!r || picks.length !== 1 || picks[0] !== first) return;
          picks = [first, r.point ?? r.id];
          highlight();
          mode.refreshHint();
        });
        return;
      }
      const plan = planDimension(d, picks, e.uv);
      if (!('kind' in plan)) {
        mode.note(plan.reason);
        return;
      }
      picks = [];
      mode.setPreview(null);
      mode.select([], false);
      mode.refreshHint();
      void mode.placeDimension(plan.kind, plan.refs, e.uv).then((id) => {
        // Fusion: the new dimension's value box opens at once (type the size you want).
        if (id) {
          const c = mode.stored()?.constraints.find((x) => x.id === id);
          if (c && 'driving' in c && c.driving) mode.view.set({ editing: id });
        }
      });
    },
  };
}

// ------------------------------------------------------------ Trim and Extend

function trimTool(mode: SketchMode): SketchTool {
  let trimmedInDrag = new Set<string>();
  let pressed = false;
  function trimHere(e: SketchPointer) {
    const d = mode.draft();
    if (!d) return;
    const h = hitTest(d, e.uv, e.px, { points: false });
    if (!h) return;
    const ent = entityOf(d, h.id);
    if (!ent || ent.kind === 'point') return;
    const at = e.uv;
    // P4b SELECT: a linked (projected) curve follows the model: trimming it needs Break link first.
    void mode.apply('Trim', (cur) => (linkedRefusal(cur, h.id, entityLabel(cur, h.id)) ? { ok: false, reason: linkedRefusal(cur, h.id, entityLabel(cur, h.id))! } : trimAt(cur, h.id, at))).then(() => mode.select([], false));
  }
  return {
    id: 'trim',
    hint: () => 'Click the piece of a curve to remove (up to where other curves cross it), or drag across pieces.',
    cancel: () => false,
    pointer(e) {
      const d = mode.draft();
      if (!d) return;
      if (e.type === 'down') {
        pressed = true;
        trimmedInDrag = new Set();
        return;
      }
      if (e.type === 'up') {
        pressed = false;
        return;
      }
      if (e.type === 'move') {
        const h = hitTest(d, e.uv, e.px, { points: false });
        const p = emptyPreview();
        if (h) {
          const piece = trimPiece(d, h.id, e.uv);
          if (piece) for (let i = 1; i < piece.length; i++) p.doomed.push([piece[i - 1], piece[i]]);
        }
        mode.setPreview(p);
        // Power trim: dragging across pieces trims each one it passes.
        if (pressed && h && !trimmedInDrag.has(h.id)) {
          trimmedInDrag.add(h.id);
          trimHere(e);
        }
        return;
      }
      if (e.type === 'click') trimHere(e);
    },
  };
}

function extendTool(mode: SketchMode): SketchTool {
  return {
    id: 'extend',
    hint: () => 'Click near the end of a line or an arc to extend it to the next curve.',
    cancel: () => false,
    pointer(e) {
      const d = mode.draft();
      if (!d) return;
      const h = hitTest(d, e.uv, e.px, { points: false });
      if (e.type === 'move') {
        const p = emptyPreview();
        if (h) {
          const seg = extendPreview(d, h.id, e.uv);
          if (seg) p.guides.push(seg);
        }
        mode.setPreview(p);
        return;
      }
      if (e.type !== 'click' || !h) return;
      const at = e.uv;
      // P4b SELECT: a linked curve cannot be extended (Break link first).
      void mode.apply('Extend', (cur) => (linkedRefusal(cur, h.id, entityLabel(cur, h.id)) ? { ok: false, reason: linkedRefusal(cur, h.id, entityLabel(cur, h.id))! } : extendAt(cur, h.id, at)));
    },
  };
}

// ------------------------------------------------------------ factory

export function makeTool(mode: SketchMode, id: SketchToolId): SketchTool {
  switch (id) {
    case 'line':
    case 'centerline':
      return lineTool(mode, id);
    case 'rectangle-corner':
    case 'rectangle-center':
      return rectangleTool(mode, id);
    case 'circle':
      return circleTool(mode);
    case 'arc-3pt':
      return arcThreePointTool(mode);
    case 'arc-tangent':
      return tangentArcTool(mode);
    case 'point':
      return pointTool(mode);
    case 'dimension':
      return dimensionTool(mode);
    case 'trim':
      return trimTool(mode);
    case 'extend':
      return extendTool(mode);
    // P4b (SELECT): linked geometry.
    case 'project':
      return projectTool(mode);
    case 'intersect':
      return intersectTool(mode);
    // P4b (SKETCH)
    case 'spline-fit':
      return splineTool(mode, 'fit');
    case 'spline-control':
      return splineTool(mode, 'control');
    case 'mirror':
      return mirrorTool(mode);
    case 'pattern-linear':
      return patternTool(mode, 'linear');
    case 'pattern-circular':
      return patternTool(mode, 'circular');
    case 'offset':
      return offsetTool(mode);
    case 'fillet':
      return filletTool(mode, 'fillet');
    case 'chamfer':
      return filletTool(mode, 'chamfer');
    case 'select':
    default:
      return selectTool(mode);
  }
}

/** Sampled points of a sketch entity (re-exported for the overlay). */
export { samples };
