// A stored sketch in the sketch tool's own input form (CAD tools spec §4 "Full", §6.8), ready to
// resend with edit: its macros as macros while they are intact (each part and own relation still
// there, structured as the tool makes them; joined points allowed), everything else as primitives
// with their stored ids (a kept id keeps its points on resend, so region keys and side names stay);
// coordinates to 1e-6 mm so joins work again; the inferred relations as infer true; `on` as a
// selector ("" keeps where it lies when no selector names its face).
// What the tool cannot write makes the sketch unsupported (inputs null): projected edges, splines,
// sketch patterns or offsets, fixed points, driven dimensions, ids with characters the tool does not
// use. Past 150 entities, 200 constraints (inferred ones included) or the reply's room it is too_big.
// refOf(stored id) gives the model's name for any point or entity (free, moved, conflicts).
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { ORIGIN_PLANES, type SketchConstraint, type SketchEntity, type SketchFeature, type Vec2 } from '../../types/doc';
import type { DocState } from '../../types/doc-service';
import { LabelIndex, quoteName } from '../labels';
import { jsonBytes } from '../numbers';
import { expandEntity, type EntityKind, type Macro } from './macros';
import { toolKindOf } from './signatures';

export interface SketchForm {
  /** The tool's input for this sketch (edit set to its name), or null. */
  inputs: Record<string, unknown> | null;
  /** Why the sketch tool cannot replace it (inputs null), or null. */
  unsupported: string | null;
  /** Its input form is past the limits (inputs null). */
  tooBig: boolean;
  /** The model's name for a stored point or entity id ("r.top", "l1.start"; the id itself otherwise). */
  refOf(stored: string): string;
}

/** The most entities and constraints (inferred included) an input form holds. */
export const FORM_ENTITIES_MAX = 150;
export const FORM_CONSTRAINTS_MAX = 200;
/** Of the reply's room for one sketch, its inputs may take this much. */
export const FORM_ROOM = 0.75;
/** The cloud reply's room for one sketch (bytes), when no call says another. */
export const FORM_BUDGET = 16 * 1024;

export const UNSUPPORTED_WORDS = 'projected edges, splines or sketch patterns: sketch cannot replace it; edit_feature can change its dimension values';
export const TOO_BIG_WORDS = 'too big to resend; use edit_feature for its dimensions';

const r6 = (v: number) => {
  const x = Math.round(v * 1e6) / 1e6;
  return Object.is(x, -0) ? 0 : x;
};
const DEG = 180 / Math.PI;
const angleDeg = (c: Vec2, p: Vec2) => r6(Math.atan2(p[1] - c[1], p[0] - c[0]) * DEG);
const dist = (a: Vec2, b: Vec2) => Math.hypot(b[0] - a[0], b[1] - a[1]);
/** The characters the tool writes in ids. */
const PLAIN_ID = /^[A-Za-z0-9_]+$/;

/** Which macro a group of "<id>__<part>" entities looks like, by its parts. */
function kindOfGroup(parts: string[]): EntityKind | null {
  const set = new Set(parts);
  const is = (...want: string[]) => set.size === want.length && want.every((w) => set.has(w));
  if (is('bottom', 'right', 'top', 'left')) return 'rect';
  if (is('bottom', 'right', 'top', 'left', 'center')) return 'center_rect';
  if (is('side1', 'side2', 'arc_a', 'arc_b', 'axis')) return 'slot';
  if (is('inner', 'outer', 'start', 'end')) return 'sector';
  if (set.has('circle') && parts.length >= 4 && parts.every((p) => p === 'circle' || /^s\d+$/.test(p))) return 'polygon';
  if (parts.length && parts.every((p) => /^\d+$/.test(p))) return 'polyline';
  return null;
}

/** The point an entity uses at a slot of its own (line ends, centres, arc ends, a point entity's point). */
function pointsOf(e: SketchEntity): string[] {
  switch (e.kind) {
    case 'point':
      return [e.p];
    case 'line':
      return [e.p[0], e.p[1]];
    case 'circle':
      return [e.c];
    case 'arc':
      return [e.c, e.a, e.b];
    default:
      return [];
  }
}

/** The macro's `at` from the stored geometry, or null when it does not read as one. */
function atOfGroup(f: SketchFeature, id: string, kind: EntityKind, byId: Map<string, SketchEntity>): number[] | null {
  const P = (pid: string): Vec2 | null => (pid === 'origin' ? [0, 0] : (f.points[pid] ?? null));
  const ent = (part: string) => byId.get(`${id}__${part}`) ?? null;
  const line = (part: string) => {
    const e = ent(part);
    return e?.kind === 'line' ? e : null;
  };
  switch (kind) {
    case 'rect':
    case 'center_rect': {
      const bottom = line('bottom');
      const right = line('right');
      if (!bottom || !right) return null;
      const bl = P(bottom.p[0]);
      const tr = P(right.p[1]);
      if (!bl || !tr) return null;
      if (kind === 'rect') return [bl[0], bl[1], tr[0], tr[1]].map(r6);
      const c = ent('center');
      const cp = c?.kind === 'point' ? P(c.p) : null;
      if (!cp) return null;
      return [cp[0], cp[1], Math.abs(tr[0] - bl[0]), Math.abs(tr[1] - bl[1])].map(r6);
    }
    case 'slot': {
      const axis = line('axis');
      const side1 = line('side1');
      if (!axis || !side1) return null;
      const a = P(axis.p[0]);
      const b = P(axis.p[1]);
      const p1 = P(side1.p[0]);
      if (!a || !b || !p1) return null;
      return [a[0], a[1], b[0], b[1], dist(a, p1)].map(r6);
    }
    case 'polygon': {
      const circle = ent('circle');
      if (circle?.kind !== 'circle') return null;
      const c = P(circle.c);
      if (!c) return null;
      const n = [...byId.keys()].filter((k) => k.startsWith(`${id}__s`) && /^\d+$/.test(k.slice(id.length + 3))).length;
      return [r6(c[0]), r6(c[1]), r6(circle.r), n];
    }
    case 'sector': {
      const inner = ent('inner');
      const outer = ent('outer');
      if (inner?.kind !== 'arc' || outer?.kind !== 'arc' || inner.ccw === false) return null;
      const c = P(inner.c);
      const is = P(inner.a);
      const ie = P(inner.b);
      const os = P(outer.a);
      if (!c || !is || !ie || !os) return null;
      return [r6(c[0]), r6(c[1]), r6(dist(c, is)), r6(dist(c, os)), angleDeg(c, is), angleDeg(c, ie)];
    }
    case 'polyline': {
      const sides: SketchEntity[] = [];
      for (let k = 1; ; k++) {
        const e = line(String(k));
        if (!e) break;
        sides.push(e);
      }
      if (!sides.length) return null;
      const ids = [(sides[0] as Extract<SketchEntity, { kind: 'line' }>).p[0], ...sides.map((s) => (s as Extract<SketchEntity, { kind: 'line' }>).p[1])];
      const out: number[] = [];
      for (const pid of ids) {
        const p = P(pid);
        if (!p) return null;
        out.push(r6(p[0]), r6(p[1]));
      }
      return out;
    }
    default:
      return null;
  }
}

/**
 * Whether `actual` (the group's stored entities and the sketch's constraints) is the macro `m`
 * exactly, points allowed to be other ids (joins): the expected point -> stored point map, or null.
 */
function matchMacro(f: SketchFeature, m: Macro, group: SketchEntity[]): Map<string, string> | null {
  if (m.entities.length !== group.length) return null;
  const byId = new Map(group.map((e) => [e.id, e] as const));
  const map = new Map<string, string>();
  const taken = new Map<string, string>();
  const bind = (want: string, got: string) => {
    const had = map.get(want);
    if (had !== undefined) return had === got;
    const by = taken.get(got);
    if (by !== undefined && by !== want) return false;
    map.set(want, got);
    taken.set(got, want);
    return true;
  };
  for (const e of m.entities) {
    const a = byId.get(e.id);
    if (!a || a.kind !== e.kind) return null;
    if (!!a.construction !== !!e.construction) return null;
    if (a.kind === 'line' && !!a.centerline !== !!(e as { centerline?: boolean }).centerline) return null;
    if (a.kind === 'arc' && a.ccw === false) return null;
    const want = pointsOf(e);
    const got = pointsOf(a);
    if (want.length !== got.length || !want.every((w, i) => bind(w, got[i]))) return null;
  }
  const cons = new Map(f.constraints.map((c) => [c.id, c] as const));
  for (const r of m.relations) {
    const c = cons.get(r.id);
    if (!c || c.kind !== r.kind || c.refs.length !== r.refs.length) return null;
    if (!r.refs.every((ref, i) => (map.get(ref) ?? ref) === c.refs[i])) return null;
  }
  return map;
}

/** Why the sketch tool cannot write this sketch, or null. */
export function unsupportedWhy(f: SketchFeature): string | null {
  if (f.links?.length || f.ties?.length || f.entities.some((e) => e.kind === 'spline')) return UNSUPPORTED_WORDS;
  if (f.constraints.some((c) => c.kind === 'fix')) return 'fixed points: sketch cannot replace it; edit_feature can change its dimension values';
  if (f.constraints.some((c) => 'driving' in c && c.driving === false)) return 'driven dimensions: sketch cannot replace it; edit_feature can change its dimension values';
  const ids = [...Object.keys(f.points), ...f.entities.map((e) => e.id), ...f.constraints.map((c) => c.id)];
  if (ids.some((id) => !PLAIN_ID.test(id))) return 'trimmed or split pieces (ids the tool does not write): sketch cannot replace it; edit_feature can change its dimension values';
  return null;
}

/** Where the sketch lies, as the tool's `on` takes it ("" keeps it when no selector names its face). */
function onOf(f: SketchFeature, s: DocState): string {
  const sup = f.support;
  if (sup.kind === 'plane') return (ORIGIN_PLANES[sup.plane]?.label ?? '').replace(/ plane$/, '');
  if (sup.kind === 'feature') {
    const p = s.doc.features.find((g) => g.id === sup.feature);
    return p ? quoteName(p.name) : '';
  }
  const bodies = s.rebuild.bodies;
  const bi = bodies.findIndex((b) => b.id === sup.body);
  const fi = bi >= 0 ? (bodies[bi].names?.faces.indexOf(sup.face.name) ?? -1) : -1;
  if (fi < 0) return '';
  const names = new Map(s.doc.features.map((g) => [g.id, g.name] as const));
  const labels = new LabelIndex(bodies, { featureName: (id) => names.get(id) ?? null });
  return labels.of(bi, fi).label ?? '';
}

/** The sketch in the tool's input form (§6.8), with the model's names of its points and entities. */
export function describeSketch(f: SketchFeature, s: DocState, o: { budget?: number } = {}): SketchForm {
  const names = new Map<string, string>();
  const name = (stored: string, model: string) => {
    if (!names.has(stored)) names.set(stored, model);
  };
  const refOf = (stored: string) => (stored === 'origin' ? 'origin' : (names.get(stored) ?? stored));
  const byId = new Map(f.entities.map((e) => [e.id, e] as const));
  // Groups of "<id>__<part>" entities, in the order they first appear.
  const groups = new Map<string, SketchEntity[]>();
  const steps: ({ kind: 'group'; id: string } | { kind: 'one'; e: SketchEntity })[] = [];
  for (const e of f.entities) {
    const k = e.id.indexOf('__');
    if (k <= 0) {
      steps.push({ kind: 'one', e });
      continue;
    }
    const id = e.id.slice(0, k);
    if (!groups.has(id)) {
      groups.set(id, []);
      steps.push({ kind: 'group', id });
    }
    groups.get(id)!.push(e);
  }
  const own = new Set<string>();
  const entities: Record<string, unknown>[] = [];
  const one = (e: SketchEntity) => {
    const P = (pid: string): Vec2 => (pid === 'origin' ? [0, 0] : (f.points[pid] ?? [0, 0]));
    const construction = !!e.construction;
    switch (e.kind) {
      case 'point': {
        const p = P(e.p);
        name(e.p, e.id);
        name(e.id, e.id);
        entities.push({ id: e.id, kind: 'point', at: [r6(p[0]), r6(p[1])], construction });
        return;
      }
      case 'line': {
        const a = P(e.p[0]);
        const b = P(e.p[1]);
        name(e.id, e.id);
        name(e.p[0], `${e.id}.start`);
        name(e.p[1], `${e.id}.end`);
        entities.push({ id: e.id, kind: e.centerline ? 'centerline' : 'line', at: [a[0], a[1], b[0], b[1]].map(r6), construction });
        return;
      }
      case 'circle': {
        const c = P(e.c);
        name(e.id, e.id);
        name(e.c, `${e.id}.center`);
        entities.push({ id: e.id, kind: 'circle', at: [r6(c[0]), r6(c[1]), r6(e.r)], construction });
        return;
      }
      case 'arc': {
        const c = P(e.c);
        const ccw = e.ccw !== false;
        const start = ccw ? e.a : e.b;
        const end = ccw ? e.b : e.a;
        name(e.id, e.id);
        name(e.c, `${e.id}.center`);
        name(start, `${e.id}.start`);
        name(end, `${e.id}.end`);
        entities.push({ id: e.id, kind: 'arc', at: [r6(c[0]), r6(c[1]), r6(dist(c, P(start))), angleDeg(c, P(start)), angleDeg(c, P(end))], construction });
        return;
      }
      default:
        return;
    }
  };
  for (const st of steps) {
    if (st.kind === 'one') {
      one(st.e);
      continue;
    }
    const group = groups.get(st.id)!;
    const kind = kindOfGroup(group.map((e) => e.id.slice(st.id.length + 2)));
    const at = kind ? atOfGroup(f, st.id, kind, byId) : null;
    const construction = !!group.find((e) => !/__(center|axis|circle)$/.test(e.id))?.construction;
    const r = kind && at ? expandEntity(st.id, kind, at, construction) : null;
    const map = r?.ok ? matchMacro(f, r.macro, group) : null;
    if (!r?.ok || !map || !kind || !at) {
      for (const e of group) one(e);
      continue;
    }
    const m = r.macro;
    for (const rel of m.relations) own.add(rel.id);
    for (const [part, sid] of Object.entries(m.parts)) name(map.get(sid) ?? sid, part ? `${m.id}.${part}` : m.id);
    for (const mp of m.points) {
      const actual = map.get(mp.id);
      if (actual) name(actual, mp.part ? `${m.id}.${mp.part}` : m.id);
    }
    entities.push({ id: st.id, kind, at, construction });
  }
  const unsupported = unsupportedWhy(f);
  if (unsupported) return { inputs: null, unsupported, tooBig: false, refOf };
  // The tool's own inferred relations come back from infer true.
  const lines = new Set(f.entities.filter((e) => e.kind === 'line').map((e) => e.id));
  const isInferred = (c: SketchConstraint) => 'inferred' in c && !!c.inferred && /__[hv]$/.test(c.id) && lines.has(c.id.slice(0, -3)) && (c.kind === 'horizontal' || c.kind === 'vertical');
  const constraints: Record<string, unknown>[] = [];
  let inferred = 0;
  for (const c of f.constraints) {
    if (own.has(c.id)) continue;
    if (isInferred(c)) {
      inferred++;
      continue;
    }
    const kind = toolKindOf(c.kind) ?? c.kind;
    constraints.push({ id: c.id, kind, refs: c.refs.map(refOf), value: 'expr' in c && typeof c.expr === 'string' ? c.expr : '' });
  }
  const inputs = { edit: f.name, name: f.name, on: onOf(f, s), entities, constraints, infer: inferred > 0 };
  const budget = o.budget ?? FORM_BUDGET;
  const tooBig = entities.length > FORM_ENTITIES_MAX || constraints.length + inferred > FORM_CONSTRAINTS_MAX || jsonBytes(inputs) > budget * FORM_ROOM;
  return { inputs: tooBig ? null : inputs, unsupported: null, tooBig, refOf };
}
