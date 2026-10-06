// Sketch patterns and offsets as ties (P4b): a SketchTie row of the sketch says
// which entities are copies of which, and this module derives, at every solve,
// the solver constraints that hold each copy to its source:
//   linear    every copied point q of source point p: q - p = i S1 d1 + k S2 d2
//             (pattern_shift, or pattern_along when a direction follows a line);
//             a copied circle keeps its source's radius (equal);
//   circular  q = c + R(i delta) (p - c) (pattern_rotate); circles equal;
//   offset    a line copy parallel to its source at the distance; an arc copy on
//             the same centre at the distance; the chain's free ends square to
//             their sources (offset_end).
// Its values are expressions, evaluated with the dimensions (key
// `<tie id>:<name>`), so a parameter drives a pattern's spacing and the rebuild
// sees the change. Pure functions.
// Owner: P4b SKETCH.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { SketchEntity, SketchFeature, SketchTie, Vec2 } from '../../types/doc';
import type { SolverSketch } from '../../types/sketch';
import type { Quantity, UnitsService } from '../../types/units';

type F = Pick<SketchFeature, 'points' | 'entities'> & { ties?: SketchTie[] };

/** What each named value of a tie measures. */
export function tieQuantity(name: string): Quantity {
  return name.startsWith('angle') ? 'angle' : 'length';
}

/** The key a tie value has among the solved values. */
export const tieKey = (tie: Pick<SketchTie, 'id'>, name: string) => `${tie.id}:${name}`;

/** The value names a tie uses now. */
export function tieNames(t: SketchTie): string[] {
  if (t.kind === 'linear') return t.count[1] > 1 ? ['spacing1', 'angle1', 'spacing2', 'angle2'] : ['spacing1', 'angle1'];
  if (t.kind === 'circular') return t.full ? [] : ['angle'];
  return ['distance'];
}

/** Every tie's values (mm / deg), keyed `<tie>:<name>`, with the first problem per value. */
export function evaluateTies(f: { ties?: SketchTie[] }, units: UnitsService): { values: Record<string, number>; errors: Record<string, string> } {
  const values: Record<string, number> = {};
  const errors: Record<string, string> = {};
  for (const t of f.ties ?? []) {
    for (const name of tieNames(t)) {
      const expr = t.exprs[name];
      if (expr == null) continue;
      const r = units.evaluate(expr, tieQuantity(name));
      const key = tieKey(t, name);
      if (!r.ok) errors[key] = r.error;
      else if ((name.startsWith('spacing') || name === 'distance') && !(r.value > 0)) errors[key] = 'Must be more than 0';
      else values[key] = r.value;
    }
  }
  return { values, errors };
}

/** The ties with only the copies whose entities are all still there (none left: the tie goes). */
export function prunedTies(f: Pick<SketchFeature, 'entities'> & { ties?: SketchTie[] }): SketchTie[] | undefined {
  if (!f.ties?.length) return undefined;
  const have = new Set(f.entities.map((e) => e.id));
  const out: SketchTie[] = [];
  for (const t of f.ties) {
    const sources = t.sources.filter((id) => have.has(id));
    if (!sources.length) continue;
    const copies = t.copies.filter((c) => Object.values(c.entities).some((id) => have.has(id)));
    // fix1 B5: a pattern copy the user deleted is skipped from then on (SolidWorks' instances to skip),
    // so a re-layout never brings it back; the row says how many and can restore them.
    const gone = t.copies.filter((c) => !copies.includes(c)).map((c) => c.at);
    if (t.kind === 'offset' && !copies.length) continue;
    if (sources.length === t.sources.length && !gone.length) {
      out.push(t);
      continue;
    }
    const skip = t.kind === 'offset' ? t.skip : [...(t.skip ?? []), ...gone];
    out.push({ ...t, sources, copies, ...(skip?.length ? { skip } : {}) });
  }
  return out.length ? out : undefined;
}

/**
 * fix1 P6: what a delete did to the sketch's patterns and offsets, in words: a pattern (or an offset)
 * whose source geometry went is dissolved and its copies stay as free geometry. Null when none was.
 */
export function tiesDissolved(before: { ties?: SketchTie[] }, after: { ties?: SketchTie[] }): string | null {
  const now = new Set((after.ties ?? []).map((t) => t.id));
  const gone = (before.ties ?? []).filter((t) => !now.has(t.id));
  if (!gone.length) return null;
  const words = gone.map((t) => {
    const same = (before.ties ?? []).filter((x) => x.kind === t.kind);
    const word = t.kind === 'linear' ? 'Linear pattern' : t.kind === 'circular' ? 'Circular pattern' : 'Offset';
    return `${word} ${same.indexOf(t) + 1}`;
  });
  const copies = gone.reduce((n, t) => n + t.copies.length, 0);
  return `${words.join(' and ')} ${gone.length > 1 ? 'are' : 'is'} gone with ${gone.length > 1 ? 'their' : 'its'} source: ${copies === 1 ? 'its copy stays' : `the ${copies} copies stay`} as free geometry (Undo brings it back).`;
}

/** A tie's value now: evaluated (values), else what it evaluates to in plain numbers ("20 mm"), else null. */
function valueOf(t: SketchTie, name: string, values: Readonly<Record<string, number>>): number | null {
  const v = values[tieKey(t, name)];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const m = /^\s*([-+]?\d*\.?\d+(?:e[-+]?\d+)?)\s*(mm|deg|°)?\s*$/i.exec(t.exprs[name] ?? '');
  return m ? Number(m[1]) : null;
}

/** The angle step of a circular pattern (deg). */
export function circularStep(t: SketchTie, values: Readonly<Record<string, number>>): number | null {
  const n = t.count[0];
  if (n < 2) return null;
  if (t.full) return 360 / n;
  const total = valueOf(t, 'angle', values);
  return total == null ? null : total / (n - 1);
}

/** The shift of copy [i, k] of a linear pattern whose directions are angles (mm). */
export function linearShift(t: SketchTie, at: [number, number], values: Readonly<Record<string, number>>): Vec2 | null {
  const s1 = valueOf(t, 'spacing1', values);
  const a1 = valueOf(t, 'angle1', values);
  if (s1 == null || a1 == null) return null;
  let dx = at[0] * s1 * Math.cos((a1 * Math.PI) / 180);
  let dy = at[0] * s1 * Math.sin((a1 * Math.PI) / 180);
  if (at[1]) {
    const s2 = valueOf(t, 'spacing2', values);
    const a2 = valueOf(t, 'angle2', values);
    if (s2 == null || a2 == null) return null;
    dx += at[1] * s2 * Math.cos((a2 * Math.PI) / 180);
    dy += at[1] * s2 * Math.sin((a2 * Math.PI) / 180);
  }
  return [dx, dy];
}

/** The solver constraints every tie gives now (ids `<tie>#<n>`: conflicts report the tie). */
export function tiesToSolver(f: F, values: Readonly<Record<string, number>>): SolverSketch['constraints'] {
  const out: SolverSketch['constraints'] = [];
  const ents = new Map(f.entities.map((e) => [e.id, e] as const));
  const hasPoint = (id: string) => id === 'origin' || !!f.points[id];
  for (const t of f.ties ?? []) {
    let n = 0;
    const id = () => `${t.id}#${n++}`;
    if (t.kind === 'offset') {
      offsetTies(f.points, t, ents, values, hasPoint, out, id);
      continue;
    }
    for (const c of t.copies) {
      const pairs = Object.entries(c.points).filter(([p, q]) => hasPoint(p) && hasPoint(q) && p !== q);
      if (t.kind === 'linear') {
        const along = (t.along ?? [null, null]).map((l) => (l && ents.get(l)?.kind === 'line' ? l : null));
        const usesLines = (along[0] && c.at[0]) || (along[1] && c.at[1]);
        if (usesLines) {
          // The directions that follow a line go along it; an angle direction is a fixed shift.
          const shift: Vec2 = [0, 0];
          const lines: string[] = [];
          const dists: number[] = [];
          let ok = true;
          ([0, 1] as const).forEach((k) => {
            if (!c.at[k]) return;
            const s = valueOf(t, k === 0 ? 'spacing1' : 'spacing2', values);
            if (s == null) {
              ok = false;
              return;
            }
            const l = along[k];
            if (l) {
              lines.push(l);
              dists.push(c.at[k] * s);
            } else {
              const a = valueOf(t, k === 0 ? 'angle1' : 'angle2', values);
              if (a == null) {
                ok = false;
                return;
              }
              shift[0] += c.at[k] * s * Math.cos((a * Math.PI) / 180);
              shift[1] += c.at[k] * s * Math.sin((a * Math.PI) / 180);
            }
          });
          if (!ok) continue;
          for (const [p, q] of pairs) out.push({ id: id(), kind: 'pattern_along', refs: [p, q, ...lines], value: [shift[0], shift[1], ...dists] });
        } else {
          const d = linearShift(t, c.at, values);
          if (!d) continue;
          for (const [p, q] of pairs) out.push({ id: id(), kind: 'pattern_shift', refs: [p, q], value: d });
        }
      } else {
        const step = circularStep(t, values);
        if (step == null || !t.centre || !hasPoint(t.centre)) continue;
        for (const [p, q] of pairs) out.push({ id: id(), kind: 'pattern_rotate', refs: [t.centre, p, q], value: c.at[0] * step });
      }
      // A copied circle keeps its source's radius (its centre alone does not say it).
      for (const [src, cp] of Object.entries(c.entities)) {
        if (ents.get(src)?.kind === 'circle' && ents.get(cp)?.kind === 'circle') out.push({ id: id(), kind: 'equal', refs: [src, cp] });
      }
    }
  }
  return out;
}

function offsetTies(
  points: Record<string, Vec2>,
  t: SketchTie,
  ents: Map<string, SketchEntity>,
  values: Readonly<Record<string, number>>,
  hasPoint: (id: string) => boolean,
  out: SolverSketch['constraints'],
  id: () => string,
) {
  const d = valueOf(t, 'distance', values);
  if (d == null) return;
  // The chain in order (chainOf gives the sources in travel order): the joint before each one, and
  // whether it is smooth (tangent, or two lines in line). A run of curves joined smoothly is ONE
  // offset: only its first curve gets the distance; each smooth joint holds the next curve to it
  // (Tangent between the copies, or the copy's joint squared for two lines in line). A distance per
  // curve there is redundant (fix1 B3: every offset of a rounded rectangle was refused as over-defining).
  const srcs = t.sources.map((sid) => ents.get(sid));
  const n = srcs.length;
  const jointAt = (i: number): { point: string; smooth: boolean; square: boolean } | null => {
    const a = srcs[(i - 1 + n) % n];
    const b = srcs[i];
    if (!a || !b || n < 2 || (i === 0 && !closedChain)) return null;
    const shared = endsOf(a).find((p) => endsOf(b).includes(p));
    if (!shared) return null;
    const ta = tangentDir(points, a, shared);
    const tb = tangentDir(points, b, shared);
    const smooth = !!ta && !!tb && Math.abs(ta[0] * tb[1] - ta[1] * tb[0]) <= 1e-9;
    // Two lines in line, or two arcs on one centre: the copy's joint is squared to the source (Tangent
    // would always hold there and fix nothing).
    const square = (a.kind === 'line' && b.kind === 'line') || (a.kind === 'arc' && b.kind === 'arc' && a.c === b.c);
    return { point: shared, smooth, square };
  };
  let closedChain = false;
  if (n > 2 && srcs[0] && srcs[n - 1]) closedChain = endsOf(srcs[n - 1]!).some((p) => endsOf(srcs[0]!).includes(p));
  // Two curves closing on each other (two arcs making a circle): both ends are joints.
  if (n === 2 && srcs[0] && srcs[1]) closedChain = endsOf(srcs[0]).length === 2 && endsOf(srcs[0]).every((p) => endsOf(srcs[1]!).includes(p));
  const joints = srcs.map((_, i) => jointAt(i));
  // Where a closed chain's runs start: right after a sharp joint (all smooth: anywhere, and its closing joint is implied).
  const allSmooth = closedChain && joints.every((x) => x?.smooth);
  const start = closedChain && !allSmooth ? Math.max(0, joints.findIndex((x) => x && !x.smooth)) : 0;
  let lastLine = -1;
  for (let k = 0; k < n; k++) if (srcs[(start + k) % n]?.kind === 'line') lastLine = (start + k) % n;
  for (const c of t.copies) {
    // Ends of the source chain that no other source entity shares: the copy's end is squared there.
    const endUse = new Map<string, number>();
    for (const e of srcs) {
      const ends = e?.kind === 'line' ? e.p : e?.kind === 'arc' ? [e.a, e.b] : e?.kind === 'spline' && !e.closed ? [e.pts[0], e.pts[e.pts.length - 1]] : [];
      for (const p of ends) endUse.set(p, (endUse.get(p) ?? 0) + 1);
    }
    for (let k = 0; k < n; k++) {
      const i = (start + k) % n;
      const src = srcs[i];
      const cp = ents.get(c.entities[t.sources[i]] ?? '');
      if (!src || !cp) continue;
      const joint = joints[i];
      // The run's first curve (after a sharp joint, or the chain's start) carries the distance.
      const first = k === 0 || !joint || !joint.smooth;
      // All smooth with no line: the closing joint follows from the others.
      if (joint?.smooth && (joint.square || !(allSmooth && lastLine < 0 && k === 0))) {
        const prev = srcs[(i - 1 + n) % n]!;
        const cprev = ents.get(c.entities[prev.id] ?? '');
        const q = c.points[joint.point];
        if (cprev && q && hasPoint(q)) {
          if (joint.square) out.push({ id: id(), kind: 'offset_end', refs: [joint.point, q, prev.id] });
          else out.push({ id: id(), kind: 'tangent', refs: [cprev.id, cp.id] });
        }
      }
      if (src.kind === 'line' && cp.kind === 'line') {
        // A closed chain joined smoothly all round: the last line's direction follows from the joints.
        if (!(allSmooth && i === lastLine)) out.push({ id: id(), kind: 'parallel', refs: [cp.id, src.id] });
        if (first) out.push({ id: id(), kind: 'distance', refs: [cp.p[0], src.id], value: d });
        for (const p of src.p) {
          const q = c.points[p];
          if (q && endUse.get(p) === 1 && hasPoint(q)) out.push({ id: id(), kind: 'offset_end', refs: [p, q, src.id] });
        }
      } else if (src.kind === 'arc' && cp.kind === 'arc') {
        if (first) out.push({ id: id(), kind: 'distance', refs: [cp.a, src.id], value: d });
        for (const p of [src.a, src.b]) {
          const q = c.points[p];
          if (q && endUse.get(p) === 1 && hasPoint(q)) out.push({ id: id(), kind: 'offset_end', refs: [p, q, src.id] });
        }
      } else if (src.kind === 'circle' && cp.kind === 'circle') {
        out.push({ id: id(), kind: 'distance', refs: [cp.id, src.id], value: d });
      }
    }
  }
}

const endsOf = (e: SketchEntity): string[] => (e.kind === 'line' ? [e.p[0], e.p[1]] : e.kind === 'arc' ? [e.a, e.b] : []);

/** A line's or an arc's unit direction at one of its points (either sense). */
function tangentDir(points: Record<string, Vec2>, e: SketchEntity, at: string): Vec2 | null {
  const P = (id: string): Vec2 | null => (id === 'origin' ? [0, 0] : (points[id] ?? null));
  if (e.kind === 'line') {
    const a = P(e.p[0]);
    const b = P(e.p[1]);
    if (!a || !b) return null;
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    return l > 0 ? [(b[0] - a[0]) / l, (b[1] - a[1]) / l] : null;
  }
  if (e.kind === 'arc') {
    const c = P(e.c);
    const p = P(at);
    if (!c || !p) return null;
    const l = Math.hypot(p[0] - c[0], p[1] - c[1]);
    return l > 0 ? [-(p[1] - c[1]) / l, (p[0] - c[0]) / l] : null;
  }
  return null;
}
