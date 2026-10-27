// The Ellipse group's tools: Ellipse (the centre, an end of the major axis, then
// a point the minor radius reaches), Partial ellipse (the same, then where the
// arc starts and where it ends: it runs the way the pointer went), Parabola
// (the focus, the vertex, then the two ends: a point is taken across the axis)
// and Conic (its two ends, the top point where its end tangents meet, then a
// point it passes near or a typed rho). Each step previews the curve; value
// boxes take a typed major and minor radius (stored as dimensions from the
// centre to the axis ends) or a typed rho. The stored records are what the
// Assistant's sketch tool stores (src/assistant/sketch/macros.ts).
// SPDX-License-Identifier: GPL-3.0-or-later
import { newId } from '../../lib/ids';
import type { Vec2 } from '../../types/doc';
import { SketchBuilder } from '../edit';
import { dist } from '../geom';
import type { Inference } from '../inference';
import { emptyPreview, type SketchMode, type SketchPointer, type SketchPreview, type SketchTool } from '../mode';
import { base, Boxes, glyphsOf, placePoint } from '../tools';
import { conicShoulder, ellipseAngle, ellipseFrameOf, ellipsePoint, parabolaFrameOf, parabolaPoint, parabolaU, rationalQuad, rhoOk, rhoThrough, rhoWeight, type EllipseFrame } from './conic';

const TAU = Math.PI * 2;
const wrapPi = (a: number) => {
  let r = a % TAU;
  if (r <= -Math.PI) r += TAU;
  if (r > Math.PI) r -= TAU;
  return r;
};

/** A polyline as preview segments. */
function polyInto(p: SketchPreview, pts: Vec2[]) {
  for (let i = 1; i < pts.length; i++) p.lines.push([pts[i - 1], pts[i]]);
}
function ellipsePoly(g: EllipseFrame, t0 = 0, sweep = TAU, n = 96): Vec2[] {
  const k = Math.max(8, Math.ceil((n * Math.abs(sweep)) / TAU));
  return Array.from({ length: k + 1 }, (_, i) => ellipsePoint(g, t0 + (sweep * i) / k));
}

/** The canonical ellipse frame of a centre, a major end and a minor radius (the minor end on the +90 degree side). */
export function ellipseOf(c: Vec2, major: Vec2, minor: number): EllipseFrame | null {
  const d: Vec2 = [major[0] - c[0], major[1] - c[1]];
  const A = Math.hypot(d[0], d[1]);
  if (!(A > 0) || !(minor > 0)) return null;
  const ux: Vec2 = [d[0] / A, d[1] / A];
  return ellipseFrameOf(c, major, [c[0] - minor * ux[1], c[1] + minor * ux[0]]);
}

/** The ellipse steps shared by Ellipse and Partial ellipse: centre, major end, minor radius. */
function ellipseSteps(mode: SketchMode, t: ReturnType<typeof base>) {
  const boxes = new Boxes(mode, [
    { id: 'major', label: 'Major radius', quantity: 'length' },
    { id: 'minor', label: 'Minor radius', quantity: 'length' },
  ]);
  const s = {
    centre: null as Inference | null,
    major: null as { at: Vec2; inf: Inference | null } | null,
    boxes,
    /** Where the major end goes for the pointer now (a typed major radius along the pointer's direction). */
    majorAt(e: SketchPointer): { at: Vec2; inf: Inference | null } {
      const c = s.centre!.at;
      const A = boxes.value('major');
      const inf = t.infer(e);
      if (A == null) return { at: inf.at, inf };
      const d: Vec2 = [inf.at[0] - c[0], inf.at[1] - c[1]];
      const l = Math.hypot(d[0], d[1]) || 1;
      return { at: [c[0] + (A * d[0]) / l, c[1] + (A * d[1]) / l], inf: null };
    },
    /** The minor radius for the pointer now: its distance across the major axis, or the typed one. */
    minorFor(e: SketchPointer): number {
      const B = boxes.value('minor');
      if (B != null) return B;
      const c = s.centre!.at;
      const m = s.major!.at;
      const A = dist(c, m);
      return Math.abs(((e.uv[0] - c[0]) * -(m[1] - c[1]) + (e.uv[1] - c[1]) * (m[0] - c[0])) / (A || 1));
    },
    /** Why this minor radius makes no ellipse, or null. */
    minorProblem(B: number): string | null {
      const A = dist(s.centre!.at, s.major!.at);
      if (!(B > 0)) return 'Minor radius must be more than 0';
      if (B >= A * (1 - 1e-9)) return `Minor radius must be less than the major radius (${mode.services.doc.units.format(A, 'length', { digits: 2 })})`;
      return null;
    },
    /** Preview of the first steps (true when it drew something). */
    show(p: SketchPreview, e: SketchPointer): EllipseFrame | null {
      if (!s.centre) {
        const inf = t.infer(e);
        p.glyphs = glyphsOf(inf);
        p.points = [inf.at];
        return null;
      }
      const c = s.centre.at;
      if (!s.major) {
        const m = s.majorAt(e);
        const r = dist(c, m.at);
        p.guides.push([c, m.at]);
        if (r > 0) p.arcs.push({ c, r, a0: 0, sweep: TAU });
        p.points = [c, m.at];
        p.glyphs = glyphsOf(m.inf);
        p.boxes = boxes.render({ major: r, minor: 0 }, { major: m.at }).filter((b) => b.id === 'major');
        return null;
      }
      const B = s.minorFor(e);
      const g = s.minorProblem(B) ? null : ellipseOf(c, s.major.at, B);
      if (g) polyInto(p, ellipsePoly(g));
      p.guides.push([c, s.major.at]);
      if (g) p.guides.push([c, [c[0] + B * g.uy[0], c[1] + B * g.uy[1]]]);
      p.points = [c, s.major.at];
      return g;
    },
    reset() {
      s.centre = null;
      s.major = null;
      boxes.reset();
    },
  };
  return s;
}

/** Add the ellipse's points (the centre and major end placed with their snaps, the minor end new) and its typed dimensions. */
function placeEllipse(b: SketchBuilder, centre: Inference, major: { at: Vec2; inf: Inference | null }, g: EllipseFrame, dims: { major: string | null; minor: string | null }) {
  const c = placePoint(b, centre);
  const m = major.inf ? placePoint(b, major.inf) : b.addPoint(major.at);
  const n = b.addPoint([g.c[0] + g.minor * g.uy[0], g.c[1] + g.minor * g.uy[1]]);
  if (dims.major) b.addDimension('distance', [c, m], dims.major);
  if (dims.minor) b.addDimension('distance', [c, n], dims.minor);
  return { c, m, n };
}

export function ellipseTool(mode: SketchMode): SketchTool {
  const t = base(mode, 'ellipse');
  const st = ellipseSteps(mode, t);
  let last: SketchPointer | null = null;
  function show(e: SketchPointer) {
    last = e;
    const p = emptyPreview();
    const g = st.show(p, e);
    if (st.major) {
      const B = st.minorFor(e);
      p.boxes = st.boxes.render({ major: dist(st.centre!.at, st.major.at), minor: B }, { major: st.major.at, minor: g ? [g.c[0] + B * g.uy[0], g.c[1] + B * g.uy[1]] : e.uv }, { minor: st.minorProblem(B) });
    }
    mode.setPreview(p);
  }
  function commit(e: SketchPointer): boolean {
    const B = st.minorFor(e);
    const problem = st.minorProblem(B);
    if (problem) {
      mode.note(`Not applied: ${problem}`);
      return false;
    }
    const c0 = st.centre!;
    const m0 = st.major!;
    const g = ellipseOf(c0.at, m0.at, B)!;
    const dims = { major: st.boxes.expr('major'), minor: st.boxes.expr('minor') };
    void mode.apply('Ellipse', (d) => {
      const b = new SketchBuilder(d);
      const { c, m, n } = placeEllipse(b, c0, m0, g, dims);
      if (c === m) return { ok: false, reason: 'an ellipse needs its major end away from its centre' };
      b.addEntity({ id: newId('e'), kind: 'ellipse', c, major: m, minor: n });
      return b.result();
    });
    st.reset();
    mode.setPreview(null);
    mode.note(null);
    return true;
  }
  function majorClick(e: SketchPointer): boolean {
    const m = st.majorAt(e);
    if (!(dist(m.at, st.centre!.at) > 1e-9)) return false;
    st.major = m;
    return true;
  }
  return {
    id: 'ellipse',
    // ux010 (DRAW): a click-drag places the centre at the press and the major end at the release.
    dragDraw: () => !st.centre,
    hint: () => (!st.centre ? 'Click the centre of the ellipse.' : !st.major ? 'Click an end of the major axis, or type the major radius and Enter.' : 'Click where the minor radius reaches, or type the minor radius and Enter.'),
    cancel() {
      const had = !!st.centre;
      st.reset();
      mode.setPreview(null);
      return had;
    },
    box(bid, action, text) {
      st.boxes.set(bid, text);
      if (action === 'enter' && st.centre && last) {
        if (!st.major) {
          if (majorClick(last)) mode.refreshHint();
          show(last);
          return false;
        }
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
      if (e.type === 'leave' && !st.centre) mode.setPreview(null);
      if (e.type !== 'click') return;
      if (!st.centre) st.centre = t.infer(e);
      else if (!st.major) majorClick(e);
      else commit(e);
      mode.refreshHint();
      if (st.centre) show(e);
    },
  };
}

export function partialEllipseTool(mode: SketchMode): SketchTool {
  const t = base(mode, 'ellipse-partial');
  const st = ellipseSteps(mode, t);
  let frame: EllipseFrame | null = null;
  let start: number | null = null;
  /** The sweep the pointer has made from the start (signed: positive counter-clockwise). */
  let swept = 0;
  let lastT: number | null = null;
  let last: SketchPointer | null = null;
  function resetAll() {
    st.reset();
    frame = null;
    start = null;
    swept = 0;
    lastT = null;
  }
  function show(e: SketchPointer) {
    last = e;
    const p = emptyPreview();
    if (!frame) {
      const g = st.show(p, e);
      if (st.major) {
        const B = st.minorFor(e);
        p.boxes = st.boxes.render({ major: dist(st.centre!.at, st.major.at), minor: B }, { major: st.major.at, minor: g ? [g.c[0] + B * g.uy[0], g.c[1] + B * g.uy[1]] : e.uv }, { minor: st.minorProblem(B) });
      }
      mode.setPreview(p);
      return;
    }
    const tp = ellipseAngle(frame, e.uv);
    // The whole ellipse dashed, the piece drawn so far solid.
    const full = ellipsePoly(frame);
    for (let i = 1; i < full.length; i++) p.guides.push([full[i - 1], full[i]]);
    if (start == null) {
      p.points = [frame.c, ellipsePoint(frame, tp)];
    } else {
      if (lastT != null) swept += wrapPi(tp - lastT);
      lastT = tp;
      polyInto(p, ellipsePoly(frame, start, swept));
      p.points = [frame.c, ellipsePoint(frame, start), ellipsePoint(frame, start + swept)];
    }
    mode.setPreview(p);
  }
  function commit() {
    const g = frame!;
    if (Math.abs(swept) < 1e-6 || Math.abs(swept) > TAU - 1e-6) {
      mode.note('Not applied: a partial ellipse needs its two ends apart (draw an Ellipse for a whole one)');
      return;
    }
    const c0 = st.centre!;
    const m0 = st.major!;
    const dims = { major: st.boxes.expr('major'), minor: st.boxes.expr('minor') };
    // Stored counter-clockwise (as the Assistant's ellipse_arc): drawn clockwise, its ends swap.
    const ends = [ellipsePoint(g, start!), ellipsePoint(g, start! + swept)];
    const [s0, s1] = swept > 0 ? ends : [ends[1], ends[0]];
    void mode.apply('Partial ellipse', (d) => {
      const b = new SketchBuilder(d);
      // Its ends first: a later snap on an end that lies on an axis end takes the end.
      const a = b.addPoint(s0);
      const z = b.addPoint(s1);
      const { c, m, n } = placeEllipse(b, c0, m0, g, dims);
      if (c === m) return { ok: false, reason: 'an ellipse needs its major end away from its centre' };
      b.addEntity({ id: newId('e'), kind: 'ellipse_arc', c, major: m, minor: n, a, b: z });
      return b.result();
    });
    resetAll();
    mode.setPreview(null);
    mode.note(null);
  }
  function minorStep(e: SketchPointer): boolean {
    const B = st.minorFor(e);
    const problem = st.minorProblem(B);
    if (problem) {
      mode.note(`Not applied: ${problem}`);
      return false;
    }
    frame = ellipseOf(st.centre!.at, st.major!.at, B);
    mode.note(null);
    return !!frame;
  }
  return {
    id: 'ellipse-partial',
    dragDraw: () => !st.centre,
    hint: () =>
      !st.centre
        ? 'Click the centre of the ellipse.'
        : !st.major
          ? 'Click an end of the major axis, or type the major radius and Enter.'
          : !frame
            ? 'Click where the minor radius reaches, or type the minor radius and Enter.'
            : start == null
              ? 'Click where the partial ellipse starts.'
              : 'Move round the way it goes, then click where it ends.',
    cancel() {
      const had = !!st.centre;
      resetAll();
      mode.setPreview(null);
      return had;
    },
    box(bid, action, text) {
      st.boxes.set(bid, text);
      if (action === 'enter' && st.centre && last && !frame) {
        if (!st.major) {
          const m = st.majorAt(last);
          if (dist(m.at, st.centre.at) > 1e-9) st.major = m;
        } else minorStep(last);
        mode.refreshHint();
        show(last);
        return !!frame;
      }
      if (last) show(last);
      return false;
    },
    pointer(e) {
      if (e.type === 'move') return show(e);
      if (e.type === 'leave' && !st.centre) mode.setPreview(null);
      if (e.type !== 'click') return;
      if (!st.centre) st.centre = t.infer(e);
      else if (!st.major) {
        const m = st.majorAt(e);
        if (dist(m.at, st.centre.at) > 1e-9) st.major = m;
      } else if (!frame) minorStep(e);
      else if (start == null) {
        start = ellipseAngle(frame, e.uv);
        lastT = start;
        swept = 0;
      } else {
        show(e);
        commit();
      }
      mode.refreshHint();
      if (st.centre) show(e);
    },
  };
}

export function parabolaTool(mode: SketchMode): SketchTool {
  const t = base(mode, 'parabola');
  let focus: Inference | null = null;
  let vertex: Inference | null = null;
  let u0: number | null = null;
  function frame() {
    return focus && vertex ? parabolaFrameOf(focus.at, vertex.at) : null;
  }
  function piece(g: NonNullable<ReturnType<typeof frame>>, a: number, b: number): Vec2[] {
    const n = 64;
    return Array.from({ length: n + 1 }, (_, i) => parabolaPoint(g, a + ((b - a) * i) / n));
  }
  function show(e: SketchPointer) {
    const p = emptyPreview();
    if (!focus || !vertex) {
      const inf = t.infer(e);
      p.glyphs = glyphsOf(inf);
      p.points = focus ? [focus.at, inf.at] : [inf.at];
      if (focus) p.guides.push([focus.at, inf.at]);
      mode.setPreview(p);
      return;
    }
    const g = frame()!;
    const u = parabolaU(g, e.uv);
    if (u0 == null) {
      // The parabola out to where the pointer is across its axis, both sides.
      const w = Math.max(Math.abs(u), 1e-6);
      polyInto(p, piece(g, -w, w));
      p.points = [focus.at, vertex.at, parabolaPoint(g, u)];
    } else {
      const span = Math.max(Math.abs(u0), Math.abs(u), 1e-6);
      const full = piece(g, -span, span);
      for (let i = 1; i < full.length; i++) p.guides.push([full[i - 1], full[i]]);
      polyInto(p, piece(g, u0, u));
      p.points = [focus.at, vertex.at, parabolaPoint(g, u0), parabolaPoint(g, u)];
    }
    p.guides.push([vertex.at, focus.at]);
    mode.setPreview(p);
  }
  function commit(u1: number) {
    const g = frame()!;
    if (Math.abs(u1 - u0!) < 1e-9 * Math.max(1, g.p)) {
      mode.note('Not applied: a parabola needs its two ends apart');
      return;
    }
    const f0 = focus!;
    const v0 = vertex!;
    const a0 = parabolaPoint(g, u0!);
    const b0 = parabolaPoint(g, u1);
    void mode.apply('Parabola', (d) => {
      const b = new SketchBuilder(d);
      const f = placePoint(b, f0);
      const v = placePoint(b, v0);
      if (f === v) return { ok: false, reason: 'a parabola needs its focus away from its vertex' };
      const a = b.addPoint(a0);
      const z = b.addPoint(b0);
      b.addEntity({ id: newId('e'), kind: 'parabola', f, v, a, b: z });
      return b.result();
    });
    focus = vertex = null;
    u0 = null;
    mode.setPreview(null);
    mode.note(null);
  }
  return {
    id: 'parabola',
    dragDraw: () => !focus,
    hint: () => (!focus ? 'Click the focus of the parabola.' : !vertex ? 'Click its vertex (the apex).' : u0 == null ? 'Click where the parabola starts.' : 'Click where it ends.'),
    cancel() {
      const had = !!focus;
      focus = vertex = null;
      u0 = null;
      mode.setPreview(null);
      return had;
    },
    pointer(e) {
      if (e.type === 'move') return show(e);
      if (e.type === 'leave' && !focus) mode.setPreview(null);
      if (e.type !== 'click') return;
      if (!focus) focus = t.infer(e);
      else if (!vertex) {
        const inf = t.infer(e);
        if (dist(inf.at, focus.at) < 1e-9) return;
        vertex = inf;
      } else if (u0 == null) u0 = parabolaU(frame()!, e.uv);
      else commit(parabolaU(frame()!, e.uv));
      mode.refreshHint();
      if (focus) show(e);
    },
  };
}

/** rho from the pointer, kept strictly inside (0, 1). */
const clampRho = (r: number) => Math.min(0.99, Math.max(0.01, Number.isFinite(r) ? r : 0.5));

export function conicTool(mode: SketchMode): SketchTool {
  const t = base(mode, 'conic');
  const boxes = new Boxes(mode, [{ id: 'rho', label: 'Rho', quantity: 'scalar' }]);
  let a: Inference | null = null;
  let b: Inference | null = null;
  let top: Inference | null = null;
  let last: SketchPointer | null = null;
  const rhoNow = (e: SketchPointer) => boxes.value('rho') ?? clampRho(rhoThrough(a!.at, b!.at, top!.at, e.uv));
  const rhoProblem = () => {
    const r = boxes.value('rho');
    return r != null && !rhoOk(r) ? 'Rho must be more than 0 and less than 1' : null;
  };
  function reset() {
    a = b = top = null;
    boxes.reset();
  }
  function show(e: SketchPointer) {
    last = e;
    const p = emptyPreview();
    if (!a || !b || !top) {
      const inf = t.infer(e);
      p.glyphs = glyphsOf(inf);
      const pts = [a?.at, b?.at, inf.at].filter((x): x is Vec2 => !!x);
      p.points = pts;
      if (a && !b) p.guides.push([a.at, inf.at]);
      if (a && b) p.guides.push([a.at, inf.at], [inf.at, b.at]);
      mode.setPreview(p);
      return;
    }
    const rho = rhoNow(e);
    const problem = rhoProblem();
    const w = rhoWeight(rhoOk(rho) ? rho : 0.5);
    polyInto(p, Array.from({ length: 65 }, (_, i) => rationalQuad(a!.at, top!.at, b!.at, w, i / 64)[0]));
    p.guides.push([a.at, top.at], [top.at, b.at]);
    const shoulder = conicShoulder(a.at, b.at, top.at, rhoOk(rho) ? rho : 0.5);
    p.points = [a.at, b.at, top.at, shoulder];
    p.boxes = boxes.render({ rho }, { rho: shoulder }, { rho: problem });
    mode.setPreview(p);
  }
  function commit(e: SketchPointer): boolean {
    const problem = rhoProblem();
    if (problem) {
      mode.note(`Not applied: ${problem}`);
      return false;
    }
    const rho = rhoNow(e);
    const [a0, b0, t0] = [a!, b!, top!];
    void mode.apply('Conic', (d) => {
      const bld = new SketchBuilder(d);
      const pa = placePoint(bld, a0);
      const pb = placePoint(bld, b0);
      const pt = placePoint(bld, t0);
      if (new Set([pa, pb, pt]).size < 3) return { ok: false, reason: 'a conic needs its two ends and its top point apart' };
      bld.addEntity({ id: newId('e'), kind: 'conic', a: pa, b: pb, t: pt, rho });
      return bld.result();
    });
    reset();
    mode.setPreview(null);
    mode.note(null);
    return true;
  }
  return {
    id: 'conic',
    dragDraw: () => !a,
    hint: () => (!a ? 'Click where the conic starts.' : !b ? 'Click where it ends.' : !top ? 'Click its top point, where the tangents at its ends meet.' : 'Click where it passes (that sets rho), or type rho (0 to 1) and Enter.'),
    cancel() {
      const had = !!a;
      reset();
      mode.setPreview(null);
      return had;
    },
    box(bid, action, text) {
      boxes.set(bid, text);
      if (action === 'enter' && a && b && top && last) {
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
      if (e.type === 'leave' && !a) mode.setPreview(null);
      if (e.type !== 'click') return;
      if (!a) a = t.infer(e);
      else if (!b) {
        const inf = t.infer(e);
        if (dist(inf.at, a.at) < 1e-9) return;
        b = inf;
      } else if (!top) {
        const inf = t.infer(e);
        const cr = (inf.at[0] - a.at[0]) * (b.at[1] - a.at[1]) - (inf.at[1] - a.at[1]) * (b.at[0] - a.at[0]);
        if (Math.abs(cr) < 1e-9 * Math.max(1, dist(a.at, b.at) ** 2)) {
          mode.note('Not applied: the top point must be off the line through the ends');
          return;
        }
        mode.note(null);
        top = inf;
      } else commit(e);
      mode.refreshHint();
      if (a) show(e);
    },
  };
}
