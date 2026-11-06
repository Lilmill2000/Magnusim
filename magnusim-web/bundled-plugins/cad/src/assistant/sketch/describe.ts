// A stored sketch in the sketch tool's own input form (CAD tools spec §4 "Full", §6.8), ready to
// resend with edit: its macros as macros while they are intact (each part and own relation still
// there, structured as the tool makes them; joined points allowed), everything else as primitives
// with their stored ids (a kept id keeps its points on resend, so region keys and side names stay);
// coordinates to 1e-6 mm so joins work again; the inferred relations as infer true; `on` as a
// selector ("" keeps where it lies when no selector names its face).
// Splines as spline or control_spline (their stored handles and a trimmed piece's knots stay with a
// kept id); fix rows; driven dimensions as value "driven"; a dimension's label as its last ref
// at(u, v); the sketch's patterns and offsets, and its links (projected and intersected curves), as
// the rows of the person's tools that make them, first (ops.ts keeps them by id: their copies and
// curves are not entities of the form, and are named as names.ts says). Every sketch the person
// can make has a form. Past 150 entities, 200 constraints (inferred ones included) or the reply's
// room it is too_big.
// refOf(stored id) gives the model's name for any point or entity (free, moved, conflicts).
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { sourceWords } from '../../sketch/project/source';
import { ORIGIN_PLANES, type SketchConstraint, type SketchEntity, type SketchFeature, type SketchLink, type Vec2 } from '../../types/doc';
import type { DocState } from '../../types/doc-service';
import { LabelIndex, quoteName } from '../labels';
import { jsonBytes } from '../numbers';
import { expandEntity, type EntityKind, type Macro } from './macros';
import { linkEntityNames, offsetSidePlace, ownedEntities, partsOfEntity, tieCopyNames, tieValue } from './names';
import { toolKindOf } from './signatures';
import { conicPointIds, ellipseAngle, ellipseFrameOf, parabolaFrameOf, parabolaU } from '../../sketch/tools/conic';

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

export const TOO_BIG_WORDS = 'too big to resend; use edit_feature for its dimensions';

const r6 = (v: number) => {
  const x = Math.round(v * 1e6) / 1e6;
  return Object.is(x, -0) ? 0 : x;
};
const DEG = 180 / Math.PI;
const angleDeg = (c: Vec2, p: Vec2) => r6(Math.atan2(p[1] - c[1], p[0] - c[0]) * DEG);
const dist = (a: Vec2, b: Vec2) => Math.hypot(b[0] - a[0], b[1] - a[1]);
/** A place ref: "at(u, v)" to 1e-6 mm. */
const placeRef = (p: Vec2) => `at(${r6(p[0])}, ${r6(p[1])})`;

/** The macros a group of "<id>__<part>" entities may be, by its parts (the first that matches exactly wins). */
function kindsOfGroup(parts: string[]): EntityKind[] {
  const set = new Set(parts);
  const is = (...want: string[]) => set.size === want.length && want.every((w) => set.has(w));
  if (is('s1', 's2', 's3', 's4')) return ['rect_3pt', 'parallelogram'];
  if (is('s1', 's2', 's3', 's4', 'center')) return ['center_rect_3pt'];
  if (is('line', 'center')) return ['midpoint_line'];
  const one = kindOfGroup(set, is, parts);
  return one ? [one] : [];
}

function kindOfGroup(set: Set<string>, is: (...want: string[]) => boolean, parts: string[]): EntityKind | null {
  if (is('bottom', 'right', 'top', 'left')) return 'rect';
  if (is('bottom', 'right', 'top', 'left', 'center')) return 'center_rect';
  if (is('side1', 'side2', 'arc_a', 'arc_b', 'axis')) return 'slot';
  if (is('inner', 'outer', 'start', 'end') || is('outer', 'start', 'end')) return 'sector';
  if (is('outer', 'inner', 'cap_a', 'cap_b')) return 'arc_slot';
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
    case 'spline':
      return [...e.pts];
    case 'ellipse':
    case 'ellipse_arc':
    case 'parabola':
    case 'conic':
      return conicPointIds(e);
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
    case 'midpoint_line': {
      const l = line('line');
      const c = ent('center');
      const cp = c?.kind === 'point' ? P(c.p) : null;
      const e = l ? P(l.p[1]) : null;
      if (!cp || !e) return null;
      return [cp[0], cp[1], e[0], e[1]].map(r6);
    }
    case 'rect_3pt':
    case 'center_rect_3pt':
    case 'parallelogram': {
      const s1 = line('s1');
      const s2 = line('s2');
      const s4 = line('s4');
      if (!s1 || !s2 || !s4) return null;
      const p1 = P(s1.p[0]);
      const p2 = P(s1.p[1]);
      const p3 = P(s2.p[1]);
      const p4 = P(s4.p[0]);
      if (!p1 || !p2 || !p3 || !p4) return null;
      const L = dist(p1, p2);
      if (!(L > 0)) return null;
      if (kind === 'parallelogram') return [p1[0], p1[1], p2[0], p2[1], p3[0], p3[1]].map(r6);
      if (kind === 'rect_3pt') {
        const h = ((p2[0] - p1[0]) * (p4[1] - p1[1]) - (p2[1] - p1[1]) * (p4[0] - p1[0])) / L;
        return [p1[0], p1[1], p2[0], p2[1], h].map(r6);
      }
      const c = ent('center');
      const cp = c?.kind === 'point' ? P(c.p) : null;
      if (!cp) return null;
      return [r6(cp[0]), r6(cp[1]), r6(L), r6(dist(p2, p3)), angleDeg(p1, p2)];
    }
    case 'arc_slot': {
      const outer = ent('outer');
      const capA = ent('cap_a');
      const capB = ent('cap_b');
      if (outer?.kind !== 'arc' || capA?.kind !== 'arc' || capB?.kind !== 'arc' || outer.ccw === false) return null;
      const c = P(outer.c);
      const a = P(capA.c);
      const b = P(capB.c);
      const os = P(outer.a);
      if (!c || !a || !b || !os) return null;
      return [r6(c[0]), r6(c[1]), r6(dist(c, a)), r6(dist(a, os)), angleDeg(c, a), angleDeg(c, b)];
    }
    case 'polygon': {
      const circle = ent('circle');
      if (circle?.kind !== 'circle') return null;
      const c = P(circle.c);
      if (!c) return null;
      const n = [...byId.keys()].filter((k) => k.startsWith(`${id}__s`) && /^\d+$/.test(k.slice(id.length + 3))).length;
      // The first corner's turn from +u (left out at 0, as the tool takes it).
      const s1 = line('s1');
      const p1 = s1 ? P(s1.p[0]) : null;
      const turn = p1 ? angleDeg(c, p1) : 0;
      return Math.abs(turn) < 1e-6 ? [r6(c[0]), r6(c[1]), r6(circle.r), n] : [r6(c[0]), r6(c[1]), r6(circle.r), n, turn];
    }
    case 'sector': {
      const inner = ent('inner');
      const outer = ent('outer');
      if (!inner && outer?.kind === 'arc' && outer.ccw !== false) {
        // A pie slice (r1 0).
        const c = P(outer.c);
        const os = P(outer.a);
        const oe = P(outer.b);
        if (!c || !os || !oe) return null;
        return [r6(c[0]), r6(c[1]), 0, r6(dist(c, os)), angleDeg(c, os), angleDeg(c, oe)];
      }
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

/** Why the sketch tool cannot write this sketch, or null (every sketch the person can make has a form now). */
export function unsupportedWhy(_f: SketchFeature): string | null {
  return null;
}

const SHOWN_LABELS = new WeakMap<object, LabelIndex>();

/** What a link reads, as a selector where one says it (a body, a face's label), else the person's words. */
function linkRef(l: SketchLink, s: DocState): string {
  const src = l.source;
  // Another sketch's points: that sketch, by name.
  if (src.kind === 'points') return `points of ${quoteName(s.doc.features.find((g) => g.id === src.feature)?.name ?? 'a deleted sketch')}`;
  const body = s.rebuild.bodies.find((b) => b.id === src.body);
  const bodyName = body?.name ?? s.doc.bodies[src.body]?.name ?? 'a body';
  if (src.kind === 'silhouette' || src.kind === 'section') return quoteName(bodyName);
  if (src.kind === 'face' && body) {
    const label = labelOfFace(s, body.id, src.ref.name);
    if (label) return label;
  }
  const bodies = new Map(s.rebuild.bodies.map((b) => [b.id, { shape: b.shape, names: b.names ?? null }] as const));
  return sourceWords(src, { bodies, bodyName: () => bodyName, featureName: (id) => s.doc.features.find((g) => g.id === id)?.name ?? null });
}

/** A face's label on the shown bodies (a body built now, its stored face name), or "". */
export function labelOfFace(s: DocState, bodyId: string, face: string): string {
  const bodies = s.rebuild.bodies;
  const bi = bodies.findIndex((b) => b.id === bodyId);
  const fi = bi >= 0 ? (bodies[bi].names?.faces.indexOf(face) ?? -1) : -1;
  if (fi < 0) return '';
  let labels = SHOWN_LABELS.get(s.rebuild);
  if (!labels) {
    const names = new Map(s.doc.features.map((g) => [g.id, g.name] as const));
    labels = new LabelIndex(bodies, { featureName: (id) => names.get(id) ?? null });
    SHOWN_LABELS.set(s.rebuild, labels);
  }
  return labels.of(bi, fi).label ?? '';
}

/**
 * Where the sketch lies as a plane selector (the sketch tool's `on`, a hole's `face`): Top, a
 * construction plane's name, or its face's label on the shown bodies; "" when no selector names
 * its face (the tool's `on` "" keeps it).
 */
export function supportSelector(f: SketchFeature, s: DocState): string {
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
  let labels = SHOWN_LABELS.get(s.rebuild);
  if (!labels) {
    const names = new Map(s.doc.features.map((g) => [g.id, g.name] as const));
    labels = new LabelIndex(bodies, { featureName: (id) => names.get(id) ?? null });
    SHOWN_LABELS.set(s.rebuild, labels);
  }
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
  // Pattern and offset copies and linked curves come with their rows, not as entities.
  const owned = ownedEntities(f);
  for (const e of f.entities) {
    if (owned.has(e.id)) continue;
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
      case 'spline': {
        name(e.id, e.id);
        for (const [part, p] of partsOfEntity(e)) name(p, `${e.id}.${part}`);
        const at = e.pts.flatMap((p) => P(p).map(r6));
        if (e.closed) at.push(...P(e.pts[0]).map(r6));
        if (e.form === 'control') at.push(e.degree);
        entities.push({ id: e.id, kind: e.form === 'fit' ? 'spline' : 'control_spline', at, construction });
        return;
      }
      // The Ellipse group, in macros.ts's forms (an ellipse's b signed by its minor end's side).
      case 'ellipse':
      case 'ellipse_arc': {
        const c = P(e.c);
        const g = ellipseFrameOf(c, P(e.major), P(e.minor));
        if (!g) return;
        name(e.id, e.id);
        for (const [part, p] of partsOfEntity(e)) name(p, `${e.id}.${part}`);
        const at = [c[0], c[1], g.major, g.side * g.minor].map(r6);
        at.push(r6(Math.atan2(g.ux[1], g.ux[0]) * DEG));
        if (e.kind === 'ellipse_arc') {
          const ccw = e.ccw !== false;
          const t0 = ellipseAngle(g, P(ccw ? e.a : e.b)) * DEG;
          const t1 = ellipseAngle(g, P(ccw ? e.b : e.a)) * DEG;
          at.push(...(g.side > 0 ? [t0, t1] : [-t1, -t0]).map(r6));
        }
        entities.push({ id: e.id, kind: e.kind, at, construction });
        return;
      }
      case 'parabola': {
        const F = P(e.f);
        const V = P(e.v);
        const g = parabolaFrameOf(F, V);
        if (!g) return;
        name(e.id, e.id);
        for (const [part, p] of partsOfEntity(e)) name(p, `${e.id}.${part}`);
        entities.push({ id: e.id, kind: 'parabola', at: [F[0], F[1], V[0], V[1], parabolaU(g, P(e.a)), parabolaU(g, P(e.b))].map(r6), construction });
        return;
      }
      case 'conic': {
        name(e.id, e.id);
        for (const [part, p] of partsOfEntity(e)) name(p, `${e.id}.${part}`);
        entities.push({ id: e.id, kind: 'conic', at: [...P(e.a), ...P(e.b), ...P(e.t)].map(r6).concat([e.rho]), construction });
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
    const construction = !!group.find((e) => !/__(center|axis|circle)$/.test(e.id))?.construction;
    let kind: EntityKind | null = null;
    let at: number[] | null = null;
    let r: ReturnType<typeof expandEntity> | null = null;
    let map: Map<string, string> | null = null;
    for (const k of kindsOfGroup(group.map((e) => e.id.slice(st.id.length + 2)))) {
      const a = atOfGroup(f, st.id, k, byId);
      const x = a ? expandEntity(st.id, k, a, construction) : null;
      const m = x?.ok ? matchMacro(f, x.macro, group) : null;
      if (m) {
        kind = k;
        at = a;
        r = x;
        map = m;
        break;
      }
    }
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
  // ---- links and ties first (their copies and curves are named before a row uses them)
  const rowsFirst: Record<string, unknown>[] = [];
  const nameEntity = (id: string, n: string) => {
    name(id, n);
    const e = byId.get(id);
    if (e) for (const [part, p] of partsOfEntity(e)) name(p, part ? `${n}.${part}` : n);
  };
  for (const l of f.links ?? []) {
    for (const [id, n] of linkEntityNames(l)) nameEntity(id, n);
    rowsFirst.push({ id: l.id, kind: l.type === 'intersection' ? 'intersect' : 'project', refs: [linkRef(l, s)], value: '' });
  }
  for (const t of f.ties ?? []) {
    for (const [id, n] of tieCopyNames(t, refOf)) nameEntity(id, n);
    const sources = t.sources.map(refOf);
    if (t.kind === 'offset') {
      const side = offsetSidePlace(f, t);
      rowsFirst.push({ id: t.id, kind: 'offset', refs: [sources[0], ...(side ? [placeRef(side)] : [])], value: tieValue(t, refOf) });
    } else if (t.kind === 'circular') rowsFirst.push({ id: t.id, kind: 'circular_pattern', refs: [refOf(t.centre ?? 'origin'), ...sources], value: tieValue(t, refOf) });
    else rowsFirst.push({ id: t.id, kind: 'linear_pattern', refs: sources, value: tieValue(t, refOf) });
  }
  // Every other point by its entity's part (a trimmed end, a tool's new points).
  for (const e of f.entities) {
    const n = refOf(e.id);
    for (const [part, p] of partsOfEntity(e)) if (p !== 'origin') name(p, part ? `${n}.${part}` : n);
  }
  // The tool's own inferred relations come back from infer true.
  const lines = new Set(f.entities.filter((e) => e.kind === 'line').map((e) => e.id));
  const isInferred = (c: SketchConstraint) => 'inferred' in c && !!c.inferred && /__[hv]$/.test(c.id) && lines.has(c.id.slice(0, -3)) && (c.kind === 'horizontal' || c.kind === 'vertical');
  const constraints: Record<string, unknown>[] = [...rowsFirst];
  let inferred = 0;
  for (const c of f.constraints) {
    if (own.has(c.id)) continue;
    if (isInferred(c)) {
      inferred++;
      continue;
    }
    const kind = toolKindOf(c.kind) ?? c.kind;
    const refs = c.refs.map(refOf);
    let value = '';
    if ('expr' in c && typeof c.expr === 'string') {
      value = c.driving === false ? 'driven' : c.expr;
      if (c.at) refs.push(placeRef(c.at));
    } else if (c.kind === 'fix' && 'value' in c && c.value) {
      // A point fixed away from where it is (it was dragged off): its spot.
      const here: Vec2 | undefined = c.refs[0] === 'origin' ? [0, 0] : f.points[c.refs[0]];
      if (!here || dist(here, c.value) > 1e-9) refs.push(placeRef(c.value));
    }
    constraints.push({ id: c.id, kind, refs, value });
  }
  const inputs = { edit: f.name, name: f.name, on: supportSelector(f, s), entities, constraints, infer: inferred > 0 };
  const budget = o.budget ?? FORM_BUDGET;
  const tooBig = entities.length > FORM_ENTITIES_MAX || constraints.length + inferred > FORM_CONSTRAINTS_MAX || jsonBytes(inputs) > budget * FORM_ROOM;
  return { inputs: tooBig ? null : inputs, unsupported: null, tooBig, refOf };
}
