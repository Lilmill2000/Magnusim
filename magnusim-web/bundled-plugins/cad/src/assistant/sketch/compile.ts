// The sketch tool's input as the Part's sketch geometry (CAD tools spec §6.3), checked before
// anything is solved or changes:
//   ids       the model's own: a-z, 0-9 and _ (a letter first, at most 24, no "__", not origin),
//             unique across entities and constraints; an id the edited sketch has already (pt_...,
//             e_..., a part written out) is taken as it is, and a kept entity keeps its points
//   entities  each kind with its `at` numbers (macros.ts), every problem named at once
//   joins     a point within 0.05 mm of another entity's point is that point: the nearest pair
//             first, never two points of one entity, never a chain longer than 0.05 mm; the first
//             entity's point wins and every ref follows ("joined": "p.p3 = l1.start"); pairs 0.05
//             to 0.5 mm apart stay apart with a warning; nothing joins the origin by itself, and two
//             points the edited sketch has apart stay apart (where they solved to the same place)
//   infer     lines and polyline sides whose ends share v (or u) within 0.05 mm get horizontal (or
//             vertical) with the ids <line>__h / <line>__v, marked inferred
//   refs      ids, parts (l.start, r.top, p.2, p.p2) or origin, checked against the solver's own
//             signatures in the order written (signatures.ts); a bad one lists the forms it takes
//   values    a dimension's expression ("w", "12 mm"; a bare number takes the Part's unit, stored
//             with it), always driving; a relation's value is ""
// At most 180 constraints of the model's and 200 with the inferred ones.
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { danglingRefs } from '../../sketch/edit';
import { entityEnds, refKindOf, ORIGIN } from '../../sketch/model';
import type { SketchConstraint, SketchEntity, SketchFeature, SketchRelation, Vec2 } from '../../types/doc';
import type { UnitsService } from '../../types/units';
import { ToolError } from '../errors';
import { SKETCH_CONSTRAINT_KINDS, SKETCH_ENTITY_KINDS } from '../schemas';
import { expandEntity, JOIN_TOL, type EntityKind, type Macro } from './macros';
import { isToolDimension, matchSignature, signatureWords, type SigKind, type ToolConstraintKind } from './signatures';

export interface EntityIn {
  id: string;
  kind: string;
  at: number[];
  construction: boolean;
}

export interface ConstraintIn {
  id: string;
  kind: string;
  refs: string[];
  value: string;
}

export interface SketchIn {
  entities: EntityIn[];
  constraints: ConstraintIn[];
  infer: boolean;
}

export type SketchGeometry = Pick<SketchFeature, 'points' | 'entities' | 'constraints'>;

export interface Compiled {
  draft: SketchGeometry;
  /** Each of the model's constraints: stored id -> its index in the input. */
  rows: Map<string, number>;
  /** The inferred relations' stored ids, oldest first. */
  inferred: string[];
  /** The macros' own relations in words, by stored id ("r's own horizontal on r.top"). */
  own: Map<string, string>;
  /** "p.p3 = l1.start": each point that joined another. */
  joined: string[];
  warnings: string[];
  /** Every point where the model put it (after the joins): `moved` compares the solution with it. */
  guess: Record<string, Vec2>;
  /** The model's name for a stored id (a part "r.top", an id, or the stored id itself). */
  refOf(stored: string): string;
  /** A constraint in the model's words ("horizontal r.top", "distance r.bottom = w"). */
  words(c: SketchConstraint): string;
}

/** Ids the model gives: a letter, then letters, digits and _ (at most 24), with no "__". */
export const MODEL_ID = /^[a-z][a-z0-9_]{0,23}$/;
/** Pairs closer than this but farther than JOIN_TOL stay apart with a warning. */
export const NEAR_MISS = 0.5;
/** The most constraints of the model's, and with the inferred ones. */
export const MODEL_CONSTRAINTS_MAX = 180;
export const CONSTRAINTS_MAX = 200;
/** Problems named in one message. */
const PROBLEMS_MAX = 12;

const dist = (a: Vec2, b: Vec2) => Math.hypot(b[0] - a[0], b[1] - a[1]);
const fmt = (v: number) => String(Math.round(v * 1000) / 1000);

/** A value as it is stored: a bare number takes the Part's display unit and is written with it (as sketch mode stores a typed value). */
export function storeExpr(text: string, q: 'length' | 'angle', units: UnitsService): string {
  if (/^\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?\s*$/.test(text)) {
    const u = units.units();
    return `${text.trim()} ${q === 'angle' ? (u.angle === 'rad' ? 'rad' : 'deg') : u.length}`;
  }
  return text.trim();
}

/** Every problem of one kind in one error (the first twelve). */
function refuse(reason: 'bad_id' | 'bad_entity' | 'bad_ref' | 'bad_input' | 'expr_error', problems: string[], detail: Record<string, unknown> = {}, hint?: string): never {
  const list = problems.slice(0, PROBLEMS_MAX);
  const more = problems.length > list.length ? `; and ${problems.length - list.length} more` : '';
  throw new ToolError(reason, `${list.join('; ')}${more}.`, { ...(hint ? { hint } : {}), detail: { problems: list, ...detail } });
}

/** A model id's problem, or null. */
export function modelIdProblem(id: string): string | null {
  if (!id) return 'an id is needed';
  if (id === ORIGIN) return '"origin" is the sketch origin, not an id';
  if (id.includes('__')) return `"${id}" has a double _ (the tool's parts use it)`;
  if (!MODEL_ID.test(id)) return `"${id}" is not an id: a-z, 0-9 and _, a letter first, at most 24`;
  return null;
}

/** The stored point a kept entity of the edited sketch has for a part (its points stay, so names and region keys do). */
function keptPoint(stored: SketchFeature | null, id: string, kind: EntityKind, part: string): string | null {
  const e = stored?.entities.find((x) => x.id === id);
  if (!e) return null;
  switch (e.kind) {
    case 'point':
      return kind === 'point' && part === '' ? e.p : null;
    case 'line':
      if (kind !== 'line' && kind !== 'centerline') return null;
      return part === 'start' ? e.p[0] : part === 'end' ? e.p[1] : null;
    case 'circle':
      return kind === 'circle' && part === 'center' ? e.c : null;
    case 'arc': {
      if (kind !== 'arc') return null;
      const ccw = e.ccw !== false;
      if (part === 'center') return e.c;
      if (part === 'start') return ccw ? e.a : e.b;
      if (part === 'end') return ccw ? e.b : e.a;
      return null;
    }
    default:
      return null;
  }
}

interface Pt {
  id: string;
  at: Vec2;
  /** The model entities that use it (more than one when a kept point is shared). */
  owners: Set<number>;
}

/** Groups of points closer than JOIN_TOL, by the joins' rules; each point's group head. */
function joinPoints(pts: Pt[], apart: ReadonlySet<string>): { head: Map<string, string>; near: [Pt, Pt, number][] } {
  const cell = NEAR_MISS;
  const grid = new Map<string, number[]>();
  const key = (u: number, v: number) => `${Math.floor(u / cell)},${Math.floor(v / cell)}`;
  pts.forEach((p, i) => {
    const k = key(p.at[0], p.at[1]);
    let list = grid.get(k);
    if (!list) grid.set(k, (list = []));
    list.push(i);
  });
  const pairs: [number, number, number][] = [];
  pts.forEach((p, i) => {
    const cu = Math.floor(p.at[0] / cell);
    const cv = Math.floor(p.at[1] / cell);
    for (let du = -1; du <= 1; du++)
      for (let dv = -1; dv <= 1; dv++) {
        for (const j of grid.get(`${cu + du},${cv + dv}`) ?? []) {
          if (j <= i) continue;
          // Two points the edited sketch keeps apart stay apart (a resend never joins what was separate).
          if (apart.has(p.id) && apart.has(pts[j].id)) continue;
          const d = dist(p.at, pts[j].at);
          if (d <= NEAR_MISS) pairs.push([d, i, j]);
        }
      }
  });
  pairs.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  // Each group: its members (point indices) and their owners.
  const group = pts.map((_, i) => i);
  const members = new Map<number, number[]>(pts.map((_, i) => [i, [i]]));
  const owners = new Map<number, Set<number>>(pts.map((p, i) => [i, new Set(p.owners)]));
  const find = (i: number) => group[i];
  for (const [d, i, j] of pairs) {
    if (d > JOIN_TOL + 1e-9) break;
    const a = find(i);
    const b = find(j);
    if (a === b) continue;
    const oa = owners.get(a)!;
    const ob = owners.get(b)!;
    // Never two points of one entity.
    if ([...ob].some((o) => oa.has(o))) continue;
    // Never a chain: every point of the joined group within JOIN_TOL of every other.
    const ma = members.get(a)!;
    const mb = members.get(b)!;
    if (ma.some((x) => mb.some((y) => dist(pts[x].at, pts[y].at) > JOIN_TOL + 1e-9))) continue;
    const [head, tail] = a < b ? [a, b] : [b, a];
    const mt = members.get(tail)!;
    for (const m of mt) group[m] = head;
    members.set(head, [...members.get(head)!, ...mt]);
    members.delete(tail);
    for (const o of owners.get(tail)!) owners.get(head)!.add(o);
    owners.delete(tail);
  }
  const head = new Map<string, string>();
  pts.forEach((p, i) => head.set(p.id, pts[find(i)].id));
  const near: [Pt, Pt, number][] = [];
  for (const [d, i, j] of pairs) {
    if (find(i) === find(j)) continue;
    if ([...pts[i].owners].some((o) => pts[j].owners.has(o))) continue;
    near.push([pts[i], pts[j], d]);
  }
  return { head, near };
}

/**
 * The input as sketch geometry, or the honest refusal (bad_id, bad_entity, bad_ref, bad_input,
 * expr_error is the solver's step). `stored`: the sketch it replaces (edit), else null.
 */
export function compileSketch(input: SketchIn, o: { units: UnitsService; stored: SketchFeature | null }): Compiled {
  const { stored } = o;
  const entitiesIn = input.entities ?? [];
  const constraintsIn = input.constraints ?? [];
  if (!entitiesIn.length) refuse('bad_input', ['entities: give at least one shape']);
  if (constraintsIn.length > MODEL_CONSTRAINTS_MAX) refuse('bad_input', [`constraints: at most ${MODEL_CONSTRAINTS_MAX}, not ${constraintsIn.length}: split the sketch`]);
  const storedIds = new Set<string>(stored ? [...Object.keys(stored.points), ...stored.entities.map((e) => e.id), ...stored.constraints.map((c) => c.id)] : []);

  // ---- ids
  const idProblems: string[] = [];
  const seen = new Map<string, string>();
  const checkId = (id: string, at: string) => {
    if (!storedIds.has(id)) {
      const p = modelIdProblem(id);
      if (p) idProblems.push(`${at}.id: ${p}`);
    }
    const was = seen.get(id);
    if (was) idProblems.push(`${at}.id: "${id}" is used by ${was} too`);
    else seen.set(id, at);
  };
  entitiesIn.forEach((e, i) => checkId(String(e?.id ?? ''), `entities[${i}]`));
  constraintsIn.forEach((c, i) => checkId(String(c?.id ?? ''), `constraints[${i}]`));
  if (idProblems.length) refuse('bad_id', idProblems);

  // ---- entities
  const macros: Macro[] = [];
  const entityProblems: string[] = [];
  entitiesIn.forEach((e, i) => {
    const kind = String(e.kind) as EntityKind;
    if (!(SKETCH_ENTITY_KINDS as readonly string[]).includes(kind)) {
      entityProblems.push(`entities[${i}].kind: "${kind}" is not one of ${SKETCH_ENTITY_KINDS.join(', ')}`);
      return;
    }
    const at = Array.isArray(e.at) ? e.at.map(Number) : [];
    const r = expandEntity(e.id, kind, at, !!e.construction);
    if (!r.ok) entityProblems.push(`entities[${i}] (${e.id}, ${kind}): ${r.problem}`);
    else macros.push(r.macro);
  });
  if (entityProblems.length) refuse('bad_entity', entityProblems);

  // ---- points: a kept entity keeps its stored points (shared ones stay shared while they agree)
  const pts: Pt[] = [];
  const byId = new Map<string, Pt>();
  const rename = macros.map(() => new Map<string, string>());
  const idClash: string[] = [];
  macros.forEach((m, i) => {
    for (const mp of m.points) {
      const kept = keptPoint(stored, m.id, m.kind, mp.part);
      let id = kept ?? mp.id;
      const have = byId.get(id);
      if (have && (have.owners.has(i) || dist(have.at, mp.at) > JOIN_TOL)) id = mp.id;
      const again = byId.get(id);
      if (again) {
        if (id === mp.id && !kept) idClash.push(`entities[${i}] (${m.id}): its point ${mp.id} clashes with another id`);
        else again.owners.add(i);
      } else {
        const p: Pt = { id, at: [mp.at[0], mp.at[1]], owners: new Set([i]) };
        pts.push(p);
        byId.set(id, p);
      }
      rename[i].set(mp.id, id);
    }
  });
  if (idClash.length) refuse('bad_id', idClash);

  // ---- joins
  const { head, near } = joinPoints(pts, new Set(stored ? Object.keys(stored.points) : []));
  const finalOf = (id: string) => head.get(id) ?? id;
  const points: Record<string, Vec2> = {};
  for (const p of pts) if (finalOf(p.id) === p.id) points[p.id] = [p.at[0], p.at[1]];

  // The model's names: parts in input order (a joined point keeps its first entity's name).
  const names = new Map<string, string>();
  const name = (stored: string, model: string) => {
    if (!names.has(stored)) names.set(stored, model);
  };
  macros.forEach((m, i) => {
    for (const [part, id] of Object.entries(m.parts)) name(finalOf(rename[i].get(id) ?? id), part ? `${m.id}.${part}` : m.id);
    for (const mp of m.points) name(finalOf(rename[i].get(mp.id)!), mp.part ? `${m.id}.${mp.part}` : m.id);
  });
  const refOf = (s: string) => (s === ORIGIN ? ORIGIN : (names.get(s) ?? s));

  /** A point's own name: its first entity's part (a joined point keeps that name in `joined`). */
  const ownName = (p: Pt) => {
    const i = Math.min(...p.owners);
    const m = macros[i];
    const mp = m.points.find((q) => rename[i].get(q.id) === p.id);
    return mp ? (mp.part ? `${m.id}.${mp.part}` : m.id) : p.id;
  };
  const joined: string[] = [];
  for (const p of pts) {
    const h = finalOf(p.id);
    if (h !== p.id) joined.push(`${refOf(h)} = ${ownName(p)}`);
  }
  const warnings: string[] = [];
  for (const [a, b, d] of near.slice(0, 10)) warnings.push(`${ownName(a)} is ${fmt(d)} mm from ${ownName(b)}: not joined; add coincident or fix the numbers`);

  // ---- entities and the macros' own relations, on the final points
  const mapPt = (i: number, id: string) => finalOf(rename[i].get(id) ?? id);
  const entities: SketchEntity[] = [];
  const constraints: SketchConstraint[] = [];
  const own = new Map<string, string>();
  macros.forEach((m, i) => {
    for (const e of m.entities) {
      const x = { ...e } as SketchEntity;
      if (x.kind === 'point') x.p = mapPt(i, x.p);
      else if (x.kind === 'line') x.p = [mapPt(i, x.p[0]), mapPt(i, x.p[1])];
      else if (x.kind === 'circle') x.c = mapPt(i, x.c);
      else if (x.kind === 'arc') {
        x.c = mapPt(i, x.c);
        x.a = mapPt(i, x.a);
        x.b = mapPt(i, x.b);
      }
      entities.push(x);
    }
    for (const r of m.relations) {
      constraints.push({ ...r, refs: r.refs.map((ref) => mapPt(i, ref)) });
      own.set(r.id, m.words[r.id]);
    }
  });
  const degenerate = entities.filter((e) => (e.kind === 'line' && e.p[0] === e.p[1]) || (e.kind === 'arc' && (e.a === e.b || e.a === e.c || e.b === e.c)));
  if (degenerate.length) refuse('bad_entity', degenerate.map((e) => `${refOf(e.id)}: its points joined into one: move them apart`));

  // ---- every id once (a part written out as an entity of its own clashes with the macro's)
  const all = new Map<string, number>();
  for (const id of [...Object.keys(points), ...entities.map((e) => e.id), ...constraints.map((c) => c.id), ...constraintsIn.map((c) => c.id)]) all.set(id, (all.get(id) ?? 0) + 1);
  const twice = [...all.entries()].filter(([, n]) => n > 1).map(([id]) => `"${refOf(id)}" names two things (an id and a part of another entity)`);
  if (twice.length) refuse('bad_id', twice);

  const geometry: SketchGeometry = { points, entities, constraints };
  const pointAt = (id: string): Vec2 | null => (id === ORIGIN ? [0, 0] : (points[id] ?? null));

  // ---- infer
  const inferred: string[] = [];
  if (input.infer) {
    macros.forEach((m) => {
      for (const lineId of m.inferLines) {
        const e = entities.find((x) => x.id === lineId);
        if (e?.kind !== 'line') continue;
        const a = pointAt(e.p[0]);
        const b = pointAt(e.p[1]);
        if (!a || !b) continue;
        const du = Math.abs(b[0] - a[0]);
        const dv = Math.abs(b[1] - a[1]);
        let kind: 'horizontal' | 'vertical' | null = null;
        if (dv <= JOIN_TOL && du > JOIN_TOL) kind = 'horizontal';
        else if (du <= JOIN_TOL && dv > JOIN_TOL) kind = 'vertical';
        if (!kind) continue;
        const id = `${lineId}__${kind === 'horizontal' ? 'h' : 'v'}`;
        constraints.push({ id, kind, refs: [lineId], inferred: true } as SketchRelation);
        inferred.push(id);
      }
    });
  }

  // ---- the model's constraints
  const partsOf = new Map<string, { m: Macro; i: number }>();
  macros.forEach((m, i) => partsOf.set(m.id, { m, i }));
  const refProblems: string[] = [];
  const otherProblems: string[] = [];
  const rows = new Map<string, number>();
  const resolveRef = (text: string): { id: string } | { problem: string } => {
    const t = text.trim();
    if (t === ORIGIN) return { id: ORIGIN };
    const dot = t.indexOf('.');
    const head0 = dot < 0 ? t : t.slice(0, dot);
    const part = dot < 0 ? '' : t.slice(dot + 1);
    const mm = partsOf.get(head0);
    if (mm) {
      const sid = mm.m.parts[part];
      if (sid) return { id: mapPt(mm.i, sid) };
      const list = Object.keys(mm.m.parts).filter(Boolean).map((p) => `${mm.m.id}.${p}`);
      if (!part) return { problem: `${mm.m.id} is a ${mm.m.kind}: name one of its parts (${list.slice(0, 12).join(', ')})` };
      return { problem: `${mm.m.id} (${mm.m.kind}) has no part "${part}"; its parts: ${list.slice(0, 16).join(', ')}` };
    }
    // An id the edited sketch has (a point pt_..., an entity), as it is.
    const raw = finalOf(t);
    if (storedIds.has(t) && (points[raw] || entities.some((e) => e.id === raw))) return { id: raw };
    return { problem: `no entity, part or point is called "${t}"` };
  };
  constraintsIn.forEach((c, i) => {
    const at = `constraints[${i}]`;
    const kind = String(c.kind) as ToolConstraintKind;
    if (!(SKETCH_CONSTRAINT_KINDS as readonly string[]).includes(kind)) {
      otherProblems.push(`${at}.kind: "${kind}" is not one of ${SKETCH_CONSTRAINT_KINDS.join(', ')}`);
      return;
    }
    const refsIn = Array.isArray(c.refs) ? c.refs.map(String) : [];
    if (!refsIn.length) {
      refProblems.push(`${at} (${c.id}): give its refs`);
      return;
    }
    const refs: string[] = [];
    let bad = false;
    refsIn.forEach((r, j) => {
      const x = resolveRef(r);
      if ('problem' in x) {
        refProblems.push(`${at}.refs[${j}] (${c.id}): ${x.problem}`);
        bad = true;
      } else refs.push(x.id);
    });
    if (bad) return;
    if (new Set(refs).size !== refs.length) {
      refProblems.push(`${at} (${c.id}): its refs name one thing twice (${refsIn.join(', ')})`);
      return;
    }
    const kinds = refs.map((r) => refKindOf(geometry, r)) as (SigKind | 'spline' | null)[];
    const shares = (() => {
      const a = entities.find((e) => e.id === refs[0]);
      const b = entities.find((e) => e.id === refs[1]);
      if (!a || !b) return false;
      const ea = entityEnds(a);
      return entityEnds(b).some((p) => ea.includes(p));
    })();
    const sig = kinds.every((k) => k && k !== 'spline') ? matchSignature(kind, kinds as SigKind[], shares) : null;
    if (!sig) {
      refProblems.push(`${at} (${c.id}): ${kind} does not take ${kinds.map((k) => k ?? '?').join(', ')} (${refsIn.join(', ')}); it takes ${signatureWords(kind)}`);
      return;
    }
    const value = typeof c.value === 'string' ? c.value.trim() : '';
    if (isToolDimension(kind)) {
      if (!value) {
        otherProblems.push(`${at}.value (${c.id}): a ${kind} takes an expression ("12 mm", "w/2")`);
        return;
      }
      const q = kind === 'angle' ? 'angle' : 'length';
      constraints.push({ id: c.id, kind: sig.stored as SketchConstraint['kind'], refs, expr: storeExpr(value, q, o.units), driving: true } as SketchConstraint);
    } else {
      if (value) {
        otherProblems.push(`${at}.value (${c.id}): ${kind} is a relation: its value is "", not "${value}"`);
        return;
      }
      constraints.push({ id: c.id, kind: sig.stored as SketchRelation['kind'], refs } as SketchRelation);
    }
    rows.set(c.id, i);
  });
  if (refProblems.length) {
    const kinds = [...new Set(constraintsIn.map((c) => String(c.kind)).filter((k) => (SKETCH_CONSTRAINT_KINDS as readonly string[]).includes(k)))] as ToolConstraintKind[];
    const hint = kinds.length === 1 ? `${kinds[0]} takes ${signatureWords(kinds[0])}; read help sketch for the others.` : undefined;
    refuse('bad_ref', refProblems, {}, hint);
  }
  if (otherProblems.length) refuse('bad_input', otherProblems);
  if (rows.size + inferred.length > CONSTRAINTS_MAX) refuse('bad_input', [`constraints: ${rows.size} and ${inferred.length} inferred make more than ${CONSTRAINTS_MAX}: split the sketch`]);
  const dangling = danglingRefs(geometry);
  if (dangling.length) throw new ToolError('internal', `The sketch's refs do not resolve: ${dangling.slice(0, 6).join(', ')}.`);

  const words = (c: SketchConstraint) => {
    const k = c.kind === 'point_on_line' || c.kind === 'point_on_circle' ? 'point_on' : c.kind;
    const v = 'expr' in c && typeof c.expr === 'string' ? ` = ${c.expr}` : '';
    return `${k} ${c.refs.map(refOf).join(', ')}${v}`;
  };
  const guess: Record<string, Vec2> = {};
  for (const [id, p] of Object.entries(points)) guess[id] = [p[0], p[1]];
  return { draft: geometry, rows, inferred, own, joined, warnings, guess, refOf, words };
}
