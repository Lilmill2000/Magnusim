// A DXF drawing (ASCII, R12 and R2000+) as curves (common.ts DrawingCurve), read as data: its
// group code / value pairs, never anything it names outside itself. Drawn: LINE, ARC, CIRCLE,
// ELLIPSE, POINT, LWPOLYLINE and POLYLINE/VERTEX (bulges are arcs; closed flags), SPLINE
// (degree, knots and control points exactly: degree 3 and 5 as they are, 2 and 4 as Bezier pieces
// raised a degree, 1 as lines; a rational one or one past degree 5 approximated by a fit spline
// through points of it, said in the notes; one given by fit points only made as a fit spline
// through them, said too), and INSERT of BLOCKS (nested up to 16 deep, column and row arrays),
// each with its transform; the object coordinate system of arcs, circles, polylines and inserts
// (210/220/230: a negative Z mirrors) exactly; anything off the drawing plane (Z not 0, a tilted
// plane) projected onto it, said in the notes. Units: $INSUNITS (unitless: read as mm, said).
// TEXT, MTEXT, DIMENSION, HATCH and every other entity are counted by type and left out, as are
// paper-space entities, polygon meshes and attributes. Layers are listed with their curves; the
// ones the file has off or frozen start left out.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { Vec2 } from '../../types/doc';
import { bsplineCurves, conicPiece, deBoor, DrawingRefused, finiteCurve, knotsFit, rationalAt, READ_MAX_CURVES, READ_MAX_DEGREE, READ_MAX_SPLINE_POINTS, skip, type Drawing, type DrawingCurve } from './common';

type V2 = Vec2;
type V3 = [number, number, number];
/** A 3D affine map, rows [r00 r01 r02 t0; r10 r11 r12 t1; r20 r21 r22 t2]. */
type M3 = number[];

const I3: M3 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
const TAU = 2 * Math.PI;
/** Entities visited through INSERTs (each cell of an array counts): past this the blocks expand too far. */
const READ_MAX_VISITS = 1_000_000;
/** An angle past this (degrees or radians) is not one: the file's numbers are wrong. */
const MAX_ANGLE = 1e6;

/** A counter-clockwise sweep from the start angle by `raw` radians, in (0, 2 pi], in one step whatever its size; one within `slack` past a whole turn is the whole turn. */
function turnOf(raw: number, slack = 0): number {
  const sw = ((raw % TAU) + TAU) % TAU;
  return sw === 0 || (raw > 0 && sw <= slack) ? sw + TAU : sw;
}
const mulM = (a: M3, b: M3): M3 => {
  const o: number[] = [];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 4; c++) {
      let s = 0;
      for (let k = 0; k < 3; k++) s += a[r * 4 + k] * b[k * 4 + c];
      if (c === 3) s += a[r * 4 + 3];
      o.push(s);
    }
  }
  return o;
};
const ap = (m: M3, p: V3): V3 => [m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3], m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7], m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11]];
const lin = (m: M3, v: V3): V3 => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[4] * v[0] + m[5] * v[1] + m[6] * v[2], m[8] * v[0] + m[9] * v[1] + m[10] * v[2]];
const cross3 = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm3 = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 1];
};
const scale3 = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const T = (x: number, y: number, z: number): M3 => [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z];

/** The object coordinate system of an extrusion direction (DXF's arbitrary axis algorithm): columns Ax, Ay, N. */
function ocs(n: V3): M3 {
  const N = norm3(n);
  const Ax = norm3(Math.abs(N[0]) < 1 / 64 && Math.abs(N[1]) < 1 / 64 ? cross3([0, 1, 0], N) : cross3([0, 0, 1], N));
  const Ay = norm3(cross3(N, Ax));
  return [Ax[0], Ay[0], N[0], 0, Ax[1], Ay[1], N[1], 0, Ax[2], Ay[2], N[2], 0];
}

/** $INSUNITS: mm per unit and its name. */
const INSUNITS: Readonly<Record<number, [number, string]>> = {
  1: [25.4, 'inches'],
  2: [304.8, 'feet'],
  3: [1609344, 'miles'],
  4: [1, 'mm'],
  5: [10, 'cm'],
  6: [1000, 'm'],
  7: [1e6, 'km'],
  8: [25.4e-6, 'microinches'],
  9: [0.0254, 'mils'],
  10: [914.4, 'yards'],
  11: [1e-7, 'angstroms'],
  12: [1e-6, 'nanometres'],
  13: [1e-3, 'microns'],
  14: [100, 'decimetres'],
};

interface Rec {
  type: string;
  pairs: [number, string][];
  /** POLYLINE: its VERTEX records. */
  vertices?: Rec[];
}

const get = (r: Rec, code: number): string | undefined => r.pairs.find((p) => p[0] === code)?.[1];
const num = (r: Rec, code: number, dflt: number): number => {
  const v = get(r, code);
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : dflt;
};
const pt = (r: Rec, base: number): V3 => [num(r, base, 0), num(r, base + 10, 0), num(r, base + 20, 0)];
const extrusion = (r: Rec): V3 => [num(r, 210, 0), num(r, 220, 0), num(r, 230, 1)];

/** The records of a section, from pair index i (after its name) to ENDSEC; POLYLINEs gather their VERTEXes. */
function records(P: [number, string][], i: number): { recs: Rec[]; next: number } {
  const recs: Rec[] = [];
  let cur: Rec | null = null;
  for (; i < P.length; i++) {
    const [c, v] = P[i];
    if (c === 0) {
      if (v === 'ENDSEC') return { recs: cur ? [...recs, cur] : recs, next: i + 1 };
      if (cur) recs.push(cur);
      cur = { type: v, pairs: [] };
    } else if (cur) cur.pairs.push([c, v]);
  }
  if (cur) recs.push(cur);
  return { recs, next: i };
}

/** Group a list of entity records: a POLYLINE takes the VERTEXes after it, up to SEQEND; an INSERT's ATTRIBs go. */
function grouped(recs: readonly Rec[], skipped: Record<string, number>): Rec[] {
  const out: Rec[] = [];
  let poly: Rec | null = null;
  for (const r of recs) {
    if (r.type === 'VERTEX' && poly) {
      poly.vertices!.push(r);
      continue;
    }
    if (r.type === 'SEQEND') {
      poly = null;
      continue;
    }
    if (r.type === 'ATTRIB') {
      skip(skipped, 'ATTRIB');
      continue;
    }
    poly = null;
    if (r.type === 'POLYLINE') {
      poly = { ...r, vertices: [] };
      out.push(poly);
    } else out.push(r);
  }
  return out;
}

/** Read a DXF file's text. */
export function readDxf(name: string, text: string): Drawing {
  // Its pairs, line by line from the text (no array of every line beside them).
  const P: [number, string][] = [];
  const n = text.length;
  let pos = 0;
  let nl = -2;
  let cr = -2;
  const nextLine = (): string | null => {
    if (pos > n) return null;
    if (nl !== -1 && nl < pos) nl = text.indexOf('\n', pos);
    if (cr !== -1 && cr < pos) cr = text.indexOf('\r', pos);
    const e = Math.min(nl < 0 ? n : nl, cr < 0 ? n : cr);
    const line = text.slice(pos, e);
    pos = e < n && text[e] === '\r' && text[e + 1] === '\n' ? e + 2 : e + 1;
    return line;
  };
  for (let line = 1; ; line += 2) {
    const c = nextLine();
    const v = c === null ? null : nextLine();
    if (c === null || v === null) break;
    const s = c.trim();
    if (s === '' && !text.slice(pos).trim()) break;
    const code = Number(s);
    if (!/^-?\d+$/.test(s) || !Number.isInteger(code)) throw new DrawingRefused(`${name} is not an ASCII DXF drawing (line ${line} is "${s.slice(0, 20)}", not a group code)`);
    P.push([code, v.trim()]);
  }
  const skipped: Record<string, number> = {};
  const notes: string[] = [];
  let insunits: number | null = null;
  const layerTable = new Map<string, boolean>();
  const blocks = new Map<string, { base: V3; recs: Rec[] }>();
  let entities: Rec[] = [];
  let sawSection = false;
  for (let i = 0; i < P.length; ) {
    const [c, v] = P[i];
    if (c === 0 && v === 'EOF') break;
    if (!(c === 0 && v === 'SECTION')) {
      i++;
      continue;
    }
    sawSection = true;
    const sec = P[i + 1]?.[0] === 2 ? P[i + 1][1] : '';
    if (sec === 'HEADER') {
      // Variables (9 $NAME, then its values) up to ENDSEC: $INSUNITS's value is its 70.
      let k = i + 2;
      for (; k < P.length && !(P[k][0] === 0 && P[k][1] === 'ENDSEC'); k++) {
        if (P[k][0] === 9 && P[k][1] === '$INSUNITS' && P[k + 1]?.[0] === 70) insunits = Number(P[k + 1][1]);
      }
      i = k + 1;
      continue;
    }
    const { recs, next } = records(P, i + 2);
    i = next;
    if (sec === 'TABLES') {
      for (const r of recs) {
        if (r.type !== 'LAYER') continue;
        const n = get(r, 2);
        if (n === undefined) continue;
        const flags = num(r, 70, 0);
        layerTable.set(n, (flags & 1) !== 0 || num(r, 62, 7) < 0);
      }
    } else if (sec === 'BLOCKS') {
      let cur: { name: string; base: V3; recs: Rec[] } | null = null;
      for (const r of recs) {
        if (r.type === 'BLOCK') {
          cur = { name: get(r, 2) ?? '', base: pt(r, 10), recs: [] };
        } else if (r.type === 'ENDBLK') {
          if (cur) blocks.set(cur.name, { base: cur.base, recs: grouped(cur.recs, skipped) });
          cur = null;
        } else if (cur) cur.recs.push(r);
      }
    } else if (sec === 'ENTITIES') {
      entities = grouped(recs, skipped);
    }
  }
  if (!sawSection) throw new DrawingRefused(`${name} is not a DXF drawing (it has no SECTION)`);

  const curves: DrawingCurve[] = [];
  const counts = new Map<string, number>();
  let projected = 0;
  let approximated = 0;
  let fitOnly = 0;
  let span = 1;
  const emit = (c: DrawingCurve, layer: string) => {
    // Numbers that overflow (a block scaled 1e200 in one scaled 1e200) draw nothing readable.
    if (!finiteCurve(c)) {
      skip(skipped, 'unreadable');
      return;
    }
    curves.push({ ...c, layer });
    counts.set(layer, (counts.get(layer) ?? 0) + 1);
    if (curves.length > READ_MAX_CURVES) throw new DrawingRefused(`${name} has more than ${READ_MAX_CURVES.toLocaleString('en-US')} curves: too many to import`);
  };
  const off = (p: V3) => Math.abs(p[2]) > 1e-9 * Math.max(span, Math.abs(p[0]), Math.abs(p[1]));
  const proj = (p: V3): V2 => [p[0], p[1]];

  /** A circle piece c + U cos t + V sin t (model space, before M) as a curve. */
  const conic = (M: M3, c: V3, U: V3, V: V3, t0: number, sweep: number, ends: [V3, V3] | null, layer: string) => {
    const cc = ap(M, c);
    const UU = lin(M, U);
    const VV = lin(M, V);
    if (off(cc) || Math.abs(UU[2]) > 1e-9 * Math.hypot(...UU) || Math.abs(VV[2]) > 1e-9 * Math.hypot(...VV)) projected++;
    const e = ends ? ([proj(ap(M, ends[0])), proj(ap(M, ends[1]))] as [V2, V2]) : null;
    const piece = conicPiece(proj(cc), proj(UU), proj(VV), t0, sweep, e);
    if (piece) emit(piece, layer);
    else skip(skipped, 'edgeOn');
  };
  const line = (M: M3, a: V3, b: V3, layer: string) => {
    const A = ap(M, a);
    const B = ap(M, b);
    if (off(A) || off(B)) projected++;
    emit({ kind: 'line', a: proj(A), b: proj(B) }, layer);
  };
  /** A polyline's vertices (object coordinates, with bulges) as lines and arcs. */
  const poly = (M: M3, O: M3, verts: { p: V3; bulge: number }[], closed: boolean, layer: string) => {
    const n = verts.length;
    const segs = closed ? n : n - 1;
    const Ax: V3 = [O[0], O[4], O[8]];
    const Ay: V3 = [O[1], O[5], O[9]];
    for (let i = 0; i < segs; i++) {
      const a = verts[i];
      const b = verts[(i + 1) % n];
      if (a.p[0] === b.p[0] && a.p[1] === b.p[1] && a.p[2] === b.p[2]) continue;
      const bu = a.bulge;
      if (!bu) {
        line(M, ap(O, a.p), ap(O, b.p), layer);
        continue;
      }
      const dx = b.p[0] - a.p[0];
      const dy = b.p[1] - a.p[1];
      const L = Math.hypot(dx, dy);
      const k = (1 - bu * bu) / (4 * bu);
      const c: V3 = [(a.p[0] + b.p[0]) / 2 - dy * k, (a.p[1] + b.p[1]) / 2 + dx * k, a.p[2]];
      const r = (L * (1 + bu * bu)) / (4 * Math.abs(bu));
      const t0 = Math.atan2(a.p[1] - c[1], a.p[0] - c[0]);
      conic(M, ap(O, c), scale3(Ax, r), scale3(Ay, r), t0, 4 * Math.atan(bu), [ap(O, a.p), ap(O, b.p)], layer);
    }
  };

  let visits = 0;
  const visit = () => {
    if (++visits > READ_MAX_VISITS) throw new DrawingRefused(`${name}'s blocks expand too far: its INSERTs place more than ${READ_MAX_VISITS.toLocaleString('en-US')} entities (blocks in blocks, or arrays of many rows and columns)`);
  };
  /** The entities under M; `within`: the blocks being drawn now (one that inserts itself is left out, counted once each time). */
  const draw = (recs: readonly Rec[], M: M3, depth: number, insertLayer: string | null, within: ReadonlySet<string> = new Set()) => {
    for (const r of recs) {
      visit();
      if (num(r, 67, 0) === 1) {
        skip(skipped, 'paper');
        continue;
      }
      const own = get(r, 8) ?? '0';
      // Inside a block, layer 0 is the INSERT's layer.
      const layer = insertLayer !== null && own === '0' ? insertLayer : own;
      switch (r.type) {
        case 'LINE':
          line(M, pt(r, 10), pt(r, 11), layer);
          break;
        case 'POINT': {
          const p = ap(M, pt(r, 10));
          if (off(p)) projected++;
          emit({ kind: 'point', p: proj(p) }, layer);
          break;
        }
        case 'CIRCLE':
        case 'ARC': {
          const O = ocs(extrusion(r));
          const c = ap(O, pt(r, 10));
          const rad = num(r, 40, 0);
          if (!(rad > 0)) {
            skip(skipped, 'unreadable');
            break;
          }
          const U = scale3([O[0], O[4], O[8]], rad);
          const V = scale3([O[1], O[5], O[9]], rad);
          if (r.type === 'CIRCLE') {
            conic(M, c, U, V, 0, 2 * Math.PI, null, layer);
            break;
          }
          const d0 = num(r, 50, 0);
          const d1 = num(r, 51, 360);
          if (Math.abs(d0) > MAX_ANGLE || Math.abs(d1) > MAX_ANGLE) {
            skip(skipped, 'unreadable');
            break;
          }
          const a0 = (d0 * Math.PI) / 180;
          const sw = turnOf(((d1 - d0) * Math.PI) / 180);
          const at = (t: number): V3 => [c[0] + U[0] * Math.cos(t) + V[0] * Math.sin(t), c[1] + U[1] * Math.cos(t) + V[1] * Math.sin(t), c[2] + U[2] * Math.cos(t) + V[2] * Math.sin(t)];
          conic(M, c, U, V, a0, sw, sw >= 2 * Math.PI - 1e-12 ? null : [at(a0), at(a0 + sw)], layer);
          break;
        }
        case 'ELLIPSE': {
          const c = pt(r, 10);
          const U = pt(r, 11);
          const ratio = num(r, 40, 1);
          if (!(ratio > 0) || !(Math.hypot(...U) > 0)) {
            skip(skipped, 'unreadable');
            break;
          }
          const V = scale3(cross3(norm3(extrusion(r)), U), ratio);
          const p0 = num(r, 41, 0);
          const p1 = num(r, 42, 2 * Math.PI);
          if (Math.abs(p0) > MAX_ANGLE || Math.abs(p1) > MAX_ANGLE) {
            skip(skipped, 'unreadable');
            break;
          }
          const sw = turnOf(p1 - p0, 1e-12);
          const whole = Math.abs(sw - 2 * Math.PI) < 1e-9;
          conic(M, c, U, V, p0, whole ? 2 * Math.PI : sw, null, layer);
          break;
        }
        case 'LWPOLYLINE': {
          const O = ocs(extrusion(r));
          const elev = num(r, 38, 0);
          const verts: { p: V3; bulge: number }[] = [];
          for (const [c, v] of r.pairs) {
            if (c === 10) verts.push({ p: [Number(v), 0, elev], bulge: 0 });
            else if (c === 20 && verts.length) verts[verts.length - 1].p[1] = Number(v);
            else if (c === 42 && verts.length) verts[verts.length - 1].bulge = Number(v) || 0;
          }
          if (verts.some((x) => !x.p.every(Number.isFinite))) {
            skip(skipped, 'unreadable');
            break;
          }
          if (verts.length >= 2) poly(M, O, verts, (num(r, 70, 0) & 1) !== 0, layer);
          break;
        }
        case 'POLYLINE': {
          const flags = num(r, 70, 0);
          if (flags & (16 | 64)) {
            skip(skipped, 'mesh');
            break;
          }
          const three = (flags & 8) !== 0;
          const O = three ? I3 : ocs(extrusion(r));
          const elev = num(r, 30, 0);
          // Spline-frame control points are not on the curve: the fitted vertices are.
          const verts = (r.vertices ?? []).filter((v) => (num(v, 70, 0) & 16) === 0).map((v) => ({ p: [num(v, 10, 0), num(v, 20, 0), three ? num(v, 30, 0) : elev] as V3, bulge: three ? 0 : num(v, 42, 0) }));
          if (verts.length >= 2) poly(M, O, verts, (flags & 1) !== 0, layer);
          break;
        }
        case 'SPLINE':
          spline(r, M, layer);
          break;
        case 'INSERT': {
          const bn = get(r, 2) ?? '';
          const b = blocks.get(bn);
          if (!b) {
            skip(skipped, 'missingBlock');
            break;
          }
          if (within.has(bn)) {
            skip(skipped, 'selfInsert');
            break;
          }
          if (depth >= 16) {
            skip(skipped, 'nested');
            break;
          }
          const O = ocs(extrusion(r));
          const ins = pt(r, 10);
          const rot = (num(r, 50, 0) * Math.PI) / 180;
          const cs = Math.cos(rot);
          const sn = Math.sin(rot);
          const R: M3 = [cs, -sn, 0, 0, sn, cs, 0, 0, 0, 0, 1, 0];
          const S: M3 = [num(r, 41, 1), 0, 0, 0, 0, num(r, 42, 1), 0, 0, 0, 0, num(r, 43, 1), 0];
          const cols = Math.max(1, Math.floor(num(r, 70, 1)));
          const rows = Math.max(1, Math.floor(num(r, 71, 1)));
          const head = mulM(M, mulM(O, mulM(T(...ins), R)));
          const tail = mulM(S, T(-b.base[0], -b.base[1], -b.base[2]));
          const inner = new Set(within).add(bn);
          for (let row = 0; row < rows; row++) {
            for (let col = 0; col < cols; col++) {
              // Each cell counts (an array of an empty block is work too).
              visit();
              draw(b.recs, mulM(head, mulM(T(col * num(r, 44, 0), row * num(r, 45, 0), 0), tail)), depth + 1, layer, inner);
            }
          }
          break;
        }
        default:
          skip(skipped, r.type || 'unnamed entity');
      }
    }
  };

  const spline = (r: Rec, M: M3, layer: string) => {
    const flags = num(r, 70, 0);
    const p = Math.floor(num(r, 71, 3));
    if (p > READ_MAX_DEGREE) return skip(skipped, 'highDegree');
    const knots: number[] = [];
    const weights: number[] = [];
    const ctrl: V3[] = [];
    const fit: V3[] = [];
    for (const [c, v] of r.pairs) {
      const x = Number(v);
      if (c === 40) knots.push(x);
      else if (c === 41) weights.push(x);
      else if (c === 10) ctrl.push([x, 0, 0]);
      else if (c === 20 && ctrl.length) ctrl[ctrl.length - 1][1] = x;
      else if (c === 30 && ctrl.length) ctrl[ctrl.length - 1][2] = x;
      else if (c === 11) fit.push([x, 0, 0]);
      else if (c === 21 && fit.length) fit[fit.length - 1][1] = x;
      else if (c === 31 && fit.length) fit[fit.length - 1][2] = x;
    }
    const flat = (list: V3[]): V2[] | null => {
      if (!list.every((q) => q.every(Number.isFinite))) return null;
      const m = list.map((q) => ap(M, q));
      if (m.some(off)) projected++;
      return m.map(proj);
    };
    const asFit = (pts: V2[]) => {
      const closed = pts.length > 2 && Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) <= 1e-9 * Math.max(1, span);
      emit({ kind: 'fit', pts: closed ? pts.slice(0, -1) : pts, closed: closed || ((flags & 1) !== 0 && pts.length > 2) }, layer);
    };
    if (ctrl.length > READ_MAX_SPLINE_POINTS || fit.length > READ_MAX_SPLINE_POINTS) return skip(skipped, 'longSpline');
    if (ctrl.length >= 2 && knots.length === ctrl.length + p + 1 && knots.every(Number.isFinite)) {
      const P2 = flat(ctrl);
      if (!P2 || !knotsFit(p, ctrl.length, knots)) return skip(skipped, 'badSpline');
      const rational = weights.length === ctrl.length && weights.some((w) => Math.abs(w - weights[0]) > 1e-12 * Math.abs(weights[0]));
      const exact = rational ? 'approx' : bsplineCurves(p, P2, knots);
      if (exact === null) return skip(skipped, 'badSpline');
      if (exact !== 'approx') {
        for (const c of exact) emit(c, layer);
        return;
      }
      // Rational, or past degree 5: a fit spline through points of it.
      if (rational && !(weights.every((w) => w > 0) && p >= 1)) return skip(skipped, 'badSpline');
      const a = knots[p];
      const z = knots[ctrl.length];
      if (!(z > a)) return skip(skipped, 'badSpline');
      const n = Math.min(400, Math.max(16, 8 * (ctrl.length - p + 1)));
      const at = rational ? rationalAt(p, P2, weights, knots) : (u: number) => deBoor(p, P2, knots, u);
      const pts = Array.from({ length: n + 1 }, (_, k) => at(a + ((z - a) * k) / n));
      approximated++;
      asFit(pts);
      return;
    }
    if (fit.length >= 2) {
      const pts = flat(fit);
      if (!pts) return skip(skipped, 'badSpline');
      fitOnly++;
      asFit(pts);
      return;
    }
    skip(skipped, 'badSpline');
  };

  // The drawing's span (what "Z is not 0" is measured against): its entities' first points.
  for (const r of entities) {
    const q = pt(r, 10);
    span = Math.max(span, Math.abs(q[0]), Math.abs(q[1]));
  }
  draw(entities, I3, 0, null);

  if (projected) notes.push(`${projected} curve${projected === 1 ? ' lies' : 's lie'} off the drawing plane (Z not 0, or a tilted plane): projected onto it`);
  if (approximated) notes.push(`${approximated} spline${approximated === 1 ? ' is' : 's are'} rational or past degree 5: each made as a fit spline through points of it (close, not exact)`);
  if (fitOnly) notes.push(`${fitOnly} spline${fitOnly === 1 ? ' has' : 's have'} fit points only: each made as a fit spline through them (between them it may differ a little from the CAD program's)`);
  let mmPerUnit = 1;
  let units: string;
  const u = insunits !== null ? INSUNITS[insunits] : undefined;
  if (u) {
    mmPerUnit = u[0];
    units = `$INSUNITS ${insunits}: ${u[1]}`;
  } else if (insunits !== null && insunits !== 0) {
    units = `$INSUNITS ${insunits}: not a length unit read here, so read as mm`;
    notes.push(`Its $INSUNITS ${insunits} is not a length unit read here: read as mm (set the scale)`);
  } else {
    units = 'unitless: read as mm';
    notes.push('It says no units ($INSUNITS): read as mm (set the scale if it is not)');
  }
  const layers = [...counts.entries()].map(([n, count]) => ({ name: n, count, off: layerTable.get(n) === true }));
  if (layers.some((l) => l.off)) notes.push(`Layers the file has off or frozen are left out: ${layers.filter((l) => l.off).map((l) => l.name).join(', ')}`);
  return { format: 'dxf', name, curves, mmPerUnit, units, skipped, notes, layers };
}
