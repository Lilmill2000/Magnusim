// The sketch tool's input as the Part's sketch geometry (CAD tools spec §6.3), checked before
// anything is solved or changes:
//   ids       the model's own: a-z, 0-9 and _ (a letter first, at most 24, no "__", not origin),
//             unique across entities and constraints; an id the edited sketch has already (pt_...,
//             e_..., e_3.b, a part written out) is taken as it is, and a kept entity keeps its points
//             (a kept spline also its handles and a trimmed piece's knots, an entity its lineage)
//   entities  each kind with its `at` numbers (macros.ts), every problem named at once
//   joins     a point within 0.05 mm of another entity's point is that point: the nearest pair
//             first, never two points of one entity, never a chain longer than 0.05 mm; the first
//             entity's point wins and every ref follows ("joined": "p.p3 = l1.start"); pairs 0.05
//             to 0.5 mm apart stay apart with a warning; nothing joins the origin by itself, and two
//             points the edited sketch has apart stay apart (where they solved to the same place)
//   infer     lines and polyline sides whose ends share v (or u) within 0.05 mm get horizontal (or
//             vertical) with the ids <line>__h / <line>__v, marked inferred
//   rows      the constraints in the order written: relations and dimensions, fix, and the
//             person's sketch tools (ops.ts runs those: trim, offset, fillet, patterns, project...),
//             each row's refs read against the sketch as the rows before it left it
//   refs      ids, parts (l.start, r.top, p.2, p.p2), the parts of any entity (e_3.start, f1.center,
//             s.h0), the names of what the tools made (p1.2.c1, pr.1) or origin, checked against
//             the solver's own signatures in the order written (signatures.ts); a bad one lists the
//             forms it takes; tangent of two lines needs a shared end, and tangent's third ref an
//             end of both curves. "at(u, v)" is a place: a dimension's label, a fix's spot, a
//             tangent handle's spot, a trim's or an offset's pick
//   splines   tangent and coincident with a spline's curve take the person's rules
//             (sketch/constraints.ts): tangent at an end it shares with the other curve (a fit
//             spline gets its end handle there first, as the person's Tangent gives it), a point
//             on the curve; anything else names the spline's points instead
//   ellipses  an ellipse's, a parabola's or a conic's curve takes the person's rules
//             (sketch/constraints.ts): coincident / point_on (a point on an ellipse or a parabola),
//             horizontal / vertical (its axis), tangent (a line and an ellipse; any two curves at an
//             end they share), equal, concentric; dimensions take its points (e.center, e.major)
//   values    a dimension's expression ("w", "12 mm"; a bare number takes the Part's unit, stored
//             with it), driving; "driven" makes it driven (measured, never held: the person's
//             "Make it driven"); a relation's value is ""
// At most 180 constraints of the model's and 200 with the inferred ones.
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { planConstraint } from '../../sketch/constraints';
import { danglingRefs } from '../../sketch/edit';
import { entityEnds, entityOf, entityPoints, pointAt, pointIdOf, refKindOf, ORIGIN } from '../../sketch/model';
import { isConic } from '../../sketch/tools/conic';
import type { SketchConstraint, SketchEntity, SketchFeature, SketchRelation, SketchSplineEntity, Vec2 } from '../../types/doc';
import type { UnitsService } from '../../types/units';
import { ToolError } from '../errors';
import { SKETCH_CONSTRAINT_KINDS, SKETCH_ENTITY_KINDS, SKETCH_TOOL_KINDS } from '../schemas';
import { expandEntity, JOIN_TOL, type EntityKind, type Macro } from './macros';
import { partsOfEntity, pointOfPart } from './names';
import { isToolDimension, matchSignature, signatureWords, toolKindOf, type SigKind, type ToolConstraintKind } from './signatures';

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

/** A sketch's geometry with its ties (pattern copies, offsets) and links (projected curves): what the solver and sketch mode take. */
export type SketchGeometry = Pick<SketchFeature, 'points' | 'entities' | 'constraints' | 'ties' | 'links'>;

/** What one of the person's sketch tools made (the reply's `made`). */
export interface MadeRow {
  id: string;
  kind: string;
  /** The entities it made, by the names refs take. */
  entities: string[];
  /** The dimensions it made (stored ids: edit_feature takes them). */
  dimensions?: string[];
  /** A tie's or link's values (count, spacing...; or what it reads). */
  values?: Record<string, string | number>;
}

export interface Compiled {
  draft: SketchGeometry;
  /** Each of the model's constraints: stored id -> its index in the input. */
  rows: Map<string, number>;
  /** The inferred relations' stored ids, oldest first. */
  inferred: string[];
  /** Constraints the person's tools made that may go when they over-define it (their own "optional"), oldest first. */
  optional: string[];
  /** The macros' own relations in words, by stored id ("r's own horizontal on r.top"). */
  own: Map<string, string>;
  /** "p.p3 = l1.start": each point that joined another. */
  joined: string[];
  warnings: string[];
  /** Every point where the model put it (after the joins): `moved` compares the solution with it. */
  guess: Record<string, Vec2>;
  /** What each of the person's tools made, in row order. */
  made: MadeRow[];
  /** Entities a tool made that the watch path draws as one step, by entity id: the step's name (an import row's id). */
  drawGroups: Record<string, string>;
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
/** A dimension's value that makes it driven. */
export const DRIVEN = 'driven';

const dist = (a: Vec2, b: Vec2) => Math.hypot(b[0] - a[0], b[1] - a[1]);
const fmt = (v: number) => String(Math.round(v * 1000) / 1000);

/** The person's sketch tools as rows (fix is a relation; ops.ts runs the others). */
export const isToolRow = (kind: string) => (SKETCH_TOOL_KINDS as readonly string[]).includes(kind) && kind !== 'fix';

/** "at(u, v)": a place, or null. */
export function placeOf(text: string): Vec2 | null {
  const m = /^\s*at\(\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)\s*,\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)\s*\)\s*$/.exec(text);
  return m ? [Number(m[1]), Number(m[2])] : null;
}
const looksLikePlace = (text: string) => /^\s*at\s*\(/.test(text);

/** A value as it is stored: a bare number takes the Part's display unit and is written with it (as sketch mode stores a typed value). */
export function storeExpr(text: string, q: 'length' | 'angle', units: UnitsService): string {
  if (/^\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?\s*$/.test(text)) {
    const u = units.units();
    return `${text.trim()} ${q === 'angle' ? (u.angle === 'rad' ? 'rad' : 'deg') : u.length}`;
  }
  return text.trim();
}

/** Every problem of one kind in one error (the first twelve). */
export function refuse(reason: 'bad_id' | 'bad_entity' | 'bad_ref' | 'bad_input' | 'expr_error', problems: string[], detail: Record<string, unknown> = {}, hint?: string): never {
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
    case 'spline': {
      if (kind !== (e.form === 'fit' ? 'spline' : 'control_spline')) return null;
      const m = /^p(\d+)$/.exec(part);
      return m ? (e.pts[Number(m[1])] ?? null) : null;
    }
    // The Ellipse group: a part of the same kind.
    case 'ellipse':
    case 'ellipse_arc':
    case 'parabola':
    case 'conic':
      return kind === e.kind ? (partsOfEntity(e).find(([p]) => p === part)?.[1] ?? null) : null;
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

/** Runs the person's sketch tools for the compiler (ops.ts), in row order. */
export interface ToolHost {
  run(c: SketchCompiler, row: ConstraintIn, i: number): Promise<void>;
}

/**
 * The input as sketch geometry, or the honest refusal (bad_id, bad_entity, bad_ref, bad_input,
 * expr_error is the solver's step). `stored`: the sketch it replaces (edit), else null. The
 * entities, joins and inferred relations at once; then the rows in order (addRow, or a ToolHost
 * for the person's tools); then finish().
 */
export class SketchCompiler {
  readonly units: UnitsService;
  readonly stored: SketchFeature | null;
  /** The sketch as the rows so far leave it (ops.ts changes it through set()). */
  g: SketchGeometry;
  readonly rows = new Map<string, number>();
  readonly inferred: string[] = [];
  readonly optional: string[] = [];
  readonly own = new Map<string, string>();
  readonly joined: string[] = [];
  readonly warnings: string[] = [];
  readonly made: MadeRow[] = [];
  readonly guess: Record<string, Vec2> = {};
  /** Stored id -> the model's name (the first one given wins). */
  private readonly names = new Map<string, string>();
  /** A name the model may write -> the stored id (what the tools made; their copies and curves). */
  private readonly alias = new Map<string, string>();
  private readonly storedIds: Set<string>;
  private readonly macros: Macro[] = [];
  private readonly partsOf = new Map<string, { m: Macro; i: number }>();
  private readonly finalOf: (id: string) => string;
  private readonly mapPt: (i: number, id: string) => string;
  readonly refProblems: string[] = [];
  readonly otherProblems: string[] = [];
  /** New driven dimensions: their expressions are what they measure once solved (solve.ts). */
  readonly driven: string[] = [];
  /** Entities a tool made that the watch path draws in one step (an import's), by entity id. */
  readonly drawGroups: Record<string, string> = {};
  private readonly input: SketchIn;

  constructor(input: SketchIn, o: { units: UnitsService; stored: SketchFeature | null }) {
    this.input = input;
    this.units = o.units;
    const { stored } = o;
    this.stored = stored;
    const entitiesIn = input.entities ?? [];
    const constraintsIn = input.constraints ?? [];
    // An import or copy row brings its own shapes (ops.ts): entities may be [] with one.
    if (!entitiesIn.length && !constraintsIn.some((r) => r?.kind === 'import' || r?.kind === 'copy')) refuse('bad_input', ['entities: give at least one shape (or an import or copy row)']);
    if (constraintsIn.length > MODEL_CONSTRAINTS_MAX) refuse('bad_input', [`constraints: at most ${MODEL_CONSTRAINTS_MAX}, not ${constraintsIn.length}: split the sketch`]);
    const storedIds = new Set<string>(
      stored ? [...Object.keys(stored.points), ...stored.entities.map((e) => e.id), ...stored.constraints.map((c) => c.id), ...(stored.ties ?? []).map((t) => t.id), ...(stored.links ?? []).map((l) => l.id)] : [],
    );
    this.storedIds = storedIds;

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
    const macros = this.macros;
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
    this.finalOf = finalOf;
    const points: Record<string, Vec2> = {};
    for (const p of pts) if (finalOf(p.id) === p.id) points[p.id] = [p.at[0], p.at[1]];

    // The model's names: parts in input order (a joined point keeps its first entity's name).
    const name = (s: string, model: string) => this.name(s, model);
    macros.forEach((m, i) => {
      for (const [part, id] of Object.entries(m.parts)) name(finalOf(rename[i].get(id) ?? id), part ? `${m.id}.${part}` : m.id);
      for (const mp of m.points) name(finalOf(rename[i].get(mp.id)!), mp.part ? `${m.id}.${mp.part}` : m.id);
    });

    /** A point's own name: its first entity's part (a joined point keeps that name in `joined`). */
    const ownName = (p: Pt) => {
      const i = Math.min(...p.owners);
      const m = macros[i];
      const mp = m.points.find((q) => rename[i].get(q.id) === p.id);
      return mp ? (mp.part ? `${m.id}.${mp.part}` : m.id) : p.id;
    };
    for (const p of pts) {
      const h = finalOf(p.id);
      if (h !== p.id) this.joined.push(`${this.refOf(h)} = ${ownName(p)}`);
    }
    for (const [a, b, d] of near.slice(0, 10)) this.warnings.push(`${ownName(a)} is ${fmt(d)} mm from ${ownName(b)}: not joined; add coincident or fix the numbers`);

    // ---- entities and the macros' own relations, on the final points
    const mapPt = (i: number, id: string) => finalOf(rename[i].get(id) ?? id);
    this.mapPt = mapPt;
    const entities: SketchEntity[] = [];
    const constraints: SketchConstraint[] = [];
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
        } else if (x.kind === 'spline') x.pts = x.pts.map((p) => mapPt(i, p));
        else if (x.kind === 'ellipse' || x.kind === 'ellipse_arc') {
          x.c = mapPt(i, x.c);
          x.major = mapPt(i, x.major);
          x.minor = mapPt(i, x.minor);
          if (x.kind === 'ellipse_arc') {
            x.a = mapPt(i, x.a);
            x.b = mapPt(i, x.b);
          }
        } else if (x.kind === 'parabola') {
          x.f = mapPt(i, x.f);
          x.v = mapPt(i, x.v);
          x.a = mapPt(i, x.a);
          x.b = mapPt(i, x.b);
        } else if (x.kind === 'conic') {
          x.a = mapPt(i, x.a);
          x.b = mapPt(i, x.b);
          x.t = mapPt(i, x.t);
        }
        // A kept entity keeps its lineage; a kept spline its handles and a trimmed piece's exact curve.
        const was = stored?.entities.find((s) => s.id === x.id && s.kind === x.kind);
        if (was?.parent) x.parent = was.parent;
        if (x.kind === 'spline' && was?.kind === 'spline' && was.form === x.form && was.pts.length === x.pts.length && !!was.closed === !!x.closed) {
          if (was.handles) {
            const hs = was.handles.map((h) => (h && stored!.points[h] ? h : null)) as [string | null, string | null];
            for (const h of hs) if (h && !points[h]) points[h] = [stored!.points[h][0], stored!.points[h][1]];
            if (hs[0] || hs[1]) x.handles = hs;
          }
          if (was.knots && was.mults) {
            x.knots = [...was.knots];
            x.mults = [...was.mults];
          }
          if (was.spans) x.spans = [was.spans[0], was.spans[1]];
        }
        entities.push(x);
      }
      for (const r of m.relations) {
        constraints.push({ ...r, refs: r.refs.map((ref) => mapPt(i, ref)) });
        this.own.set(r.id, m.words[r.id]);
      }
    });
    const degenerate = entities.filter((e) => (e.kind === 'line' && e.p[0] === e.p[1]) || (e.kind === 'arc' && (e.a === e.b || e.a === e.c || e.b === e.c)) || (e.kind === 'spline' && new Set(e.pts).size !== e.pts.length) || (isConic(e) && new Set(entityPoints(e)).size !== entityPoints(e).length));
    if (degenerate.length) refuse('bad_entity', degenerate.map((e) => `${this.refOf(e.id)}: its points joined into one: move them apart`));

    // ---- every id once (a part written out as an entity of its own clashes with the macro's)
    const all = new Map<string, number>();
    for (const id of [...Object.keys(points), ...entities.map((e) => e.id), ...constraints.map((c) => c.id), ...constraintsIn.map((c) => c.id)]) all.set(id, (all.get(id) ?? 0) + 1);
    const twice = [...all.entries()].filter(([, n]) => n > 1).map(([id]) => `"${this.refOf(id)}" names two things (an id and a part of another entity)`);
    if (twice.length) refuse('bad_id', twice);

    this.g = { points, entities, constraints };
    const pointAtNow = (id: string): Vec2 | null => (id === ORIGIN ? [0, 0] : (points[id] ?? null));

    // ---- infer
    if (input.infer) {
      macros.forEach((m) => {
        for (const lineId of m.inferLines) {
          const e = entities.find((x) => x.id === lineId);
          if (e?.kind !== 'line') continue;
          const a = pointAtNow(e.p[0]);
          const b = pointAtNow(e.p[1]);
          if (!a || !b) continue;
          const du = Math.abs(b[0] - a[0]);
          const dv = Math.abs(b[1] - a[1]);
          let kind: 'horizontal' | 'vertical' | null = null;
          if (dv <= JOIN_TOL && du > JOIN_TOL) kind = 'horizontal';
          else if (du <= JOIN_TOL && dv > JOIN_TOL) kind = 'vertical';
          if (!kind) continue;
          const id = `${lineId}__${kind === 'horizontal' ? 'h' : 'v'}`;
          constraints.push({ id, kind, refs: [lineId], inferred: true } as SketchRelation);
          this.inferred.push(id);
        }
      });
    }
    macros.forEach((m, i) => this.partsOf.set(m.id, { m, i }));
    for (const [id, p] of Object.entries(points)) this.guess[id] = [p[0], p[1]];
  }

  /** Name a stored id (the first name given wins). */
  name(stored: string, model: string): void {
    if (!this.names.has(stored)) this.names.set(stored, model);
  }

  /** A name the model may write for what a tool made (and, `named`, the name replies use). */
  aliasOf(model: string, stored: string, named = false): void {
    this.alias.set(model, stored);
    if (named) this.names.set(stored, model);
  }

  refOf = (s: string): string => (s === ORIGIN ? ORIGIN : (this.names.get(s) ?? s));

  /** Whether an id is in the sketch now (a point or an entity). */
  has(id: string): boolean {
    return id === ORIGIN || !!this.g.points[id] || this.g.entities.some((e) => e.id === id);
  }

  /** The sketch after a tool (ops.ts): its geometry, ties and links. */
  set(next: SketchGeometry): void {
    this.g = next;
  }

  /** A position the sketch has now (the origin, a point). */
  at(id: string): Vec2 | null {
    return pointAt(this.g, id);
  }

  /** The stored id a ref names now, or why it names nothing. */
  resolve(text: string): { id: string } | { problem: string } {
    const t = text.trim();
    if (t === ORIGIN) return { id: ORIGIN };
    const a = this.alias.get(t);
    if (a && this.has(a)) return { id: a };
    // An id the sketch has (an entity id, e_3.b; a point of the edited sketch, pt_...), as it is.
    const raw = this.finalOf(t);
    if ((this.storedIds.has(t) || this.g.entities.some((e) => e.id === t)) && this.has(raw)) return { id: raw };
    const dot = t.indexOf('.');
    const head0 = dot < 0 ? t : t.slice(0, dot);
    const part = dot < 0 ? '' : t.slice(dot + 1);
    const mm = this.partsOf.get(head0);
    if (mm) {
      const sid = mm.m.parts[part];
      if (sid && this.has(this.mapPt(mm.i, sid))) return { id: this.mapPt(mm.i, sid) };
    }
    // A part of any entity, as it is now ("l1.end" after a trim, "f1.center", "p1.2.c1.center", "s.h0").
    const last = t.lastIndexOf('.');
    if (last > 0) {
      const head = this.resolve(t.slice(0, last));
      if ('id' in head) {
        const e = entityOf(this.g, head.id);
        const p = e ? pointOfPart(e, t.slice(last + 1)) : null;
        if (p && this.has(p)) return { id: p };
      }
    }
    if (mm) {
      const list = Object.keys(mm.m.parts).filter(Boolean).map((p) => `${mm.m.id}.${p}`);
      if (!part) return { problem: `${mm.m.id} is a ${mm.m.kind}: name one of its parts (${list.slice(0, 12).join(', ')})` };
      return { problem: `${mm.m.id} (${mm.m.kind}) has no part "${part}"; its parts: ${list.slice(0, 16).join(', ')}` };
    }
    return { problem: `no entity, part or point is called "${t}"` };
  }

  /** A ref that may name a whole macro (mirror, patterns): its entities now. */
  resolveItems(text: string): { ids: string[] } | { problem: string } {
    const t = text.trim();
    const mm = this.partsOf.get(t);
    if (mm && !mm.m.parts['']) {
      const ids = this.g.entities.filter((e) => e.id === t || e.id.startsWith(`${t}__`) || e.parent?.startsWith(`${t}__`)).map((e) => e.id);
      if (ids.length) return { ids };
    }
    const r = this.resolve(t);
    if ('problem' in r) return r;
    if (!this.g.entities.some((e) => e.id === r.id)) {
      const owner = this.g.entities.find((e) => e.kind === 'point' && e.p === r.id);
      if (owner) return { ids: [owner.id] };
      return { problem: `"${t}" is a point: name curves or point entities` };
    }
    return { ids: [r.id] };
  }

  /** One relation, dimension or fix row, read against the sketch now. */
  addRow(c: ConstraintIn, i: number): void {
    const at = `constraints[${i}]`;
    const kind = String(c.kind) as ToolConstraintKind | 'fix';
    if (kind !== 'fix' && !(SKETCH_CONSTRAINT_KINDS as readonly string[]).includes(kind)) {
      this.otherProblems.push(`${at}.kind: "${kind}" is not one of ${[...SKETCH_CONSTRAINT_KINDS, ...SKETCH_TOOL_KINDS].join(', ')}`);
      return;
    }
    const refsAll = Array.isArray(c.refs) ? c.refs.map(String) : [];
    const places = refsAll.filter((r) => looksLikePlace(r));
    const refsIn = refsAll.filter((r) => !looksLikePlace(r));
    if (!refsIn.length) {
      this.refProblems.push(`${at} (${c.id}): give its refs`);
      return;
    }
    for (const p of places) if (!placeOf(p)) this.refProblems.push(`${at} (${c.id}): "${p}" is not a place: write at(u, v) in mm`);
    const dimension = kind !== 'fix' && isToolDimension(kind);
    const takesPlace = dimension || kind === 'fix' || kind === 'tangent';
    if (places.length > 1 || (places.length && !takesPlace)) {
      this.refProblems.push(`${at} (${c.id}): ${takesPlace ? 'one at(u, v) at most' : `${kind} takes no at(u, v)`}`);
      return;
    }
    const place = places.length ? placeOf(places[0]) : null;
    const refs: string[] = [];
    let bad = false;
    refsIn.forEach((r) => {
      const x = this.resolve(r);
      if ('problem' in x) {
        this.refProblems.push(`${at}.refs[${refsAll.indexOf(r)}] (${c.id}): ${x.problem}`);
        bad = true;
      } else refs.push(x.id);
    });
    if (bad) return;
    if (new Set(refs).size !== refs.length) {
      this.refProblems.push(`${at} (${c.id}): its refs name one thing twice (${refsIn.join(', ')})`);
      return;
    }
    const value = typeof c.value === 'string' ? c.value.trim() : '';
    const g = this.g;
    // A kept constraint keeps its stored refs where they name the same (a point, or the point entity on it).
    const was = this.stored?.constraints.find((x) => x.id === c.id);
    if (was && was.refs.length === refs.length && refs.every((r, k) => r === was.refs[k] || pointIdOf(g, r) === was.refs[k] || pointIdOf(g, was.refs[k]) === r)) refs.splice(0, refs.length, ...was.refs);
    const kinds = refs.map((r) => refKindOf(g, r));
    // ---- fix: the person's Fix (a point where it is, or at the place; a curve where it is)
    if (kind === 'fix') {
      if (value) {
        this.otherProblems.push(`${at}.value (${c.id}): fix is a relation: its value is "", not "${value}"`);
        return;
      }
      if (refs.length !== 1) {
        this.refProblems.push(`${at} (${c.id}): fix takes one point or curve (and at(u, v) for a point's spot)`);
        return;
      }
      const plan = planConstraint(g, 'fix', refs);
      if (!plan.ok || plan.add.length !== 1) {
        this.refProblems.push(`${at} (${c.id}): ${plan.ok ? 'fix takes one point or curve' : plan.reason}`);
        return;
      }
      const r = plan.add[0];
      if (place && !r.value) {
        this.refProblems.push(`${at} (${c.id}): at(u, v) places a fixed point, not a curve`);
        return;
      }
      g.constraints.push({ id: c.id, kind: 'fix', refs: r.refs, ...(r.value ? { value: place ?? r.value } : {}) } as SketchRelation);
      // Fixed at a place: the point starts there.
      if (place && g.points[r.refs[0]]) g.points[r.refs[0]] = [place[0], place[1]];
      this.rows.set(c.id, i);
      return;
    }
    // ---- a spline's curve: the person's Tangent (an end handle first) and Coincident (on the curve)
    if (kinds.includes('spline')) {
      if (dimension) {
        this.refProblems.push(`${at} (${c.id}): a dimension does not measure a spline's curve: dimension its points (s.p0, s.end, s.h0)`);
        return;
      }
      if (value) {
        this.otherProblems.push(`${at}.value (${c.id}): ${kind} is a relation: its value is "", not "${value}"`);
        return;
      }
      // A kept relation on a spline's curve stays as stored (a trim's end "on" the spline it was cut by).
      if (was && 'refs' in was && !('expr' in was) && JSON.stringify(was.refs) === JSON.stringify(refs) && (toolKindOf(was.kind) === kind || (kind === 'coincident' && was.kind === 'point_on_circle'))) {
        g.constraints.push({ ...was } as SketchRelation);
        this.rows.set(c.id, i);
        return;
      }
      const stored = kind === 'point_on' ? 'coincident' : kind;
      if (stored !== 'tangent' && stored !== 'coincident') {
        this.refProblems.push(`${at} (${c.id}): ${kind} does not take a spline's curve: use its points (s.p0, s.end), or tangent and coincident`);
        return;
      }
      const plan = planConstraint(g, stored, refs);
      if (!plan.ok || plan.add.length !== 1) {
        this.refProblems.push(`${at} (${c.id}): ${plan.ok ? `${kind} takes a spline and one other curve or point` : plan.reason}`);
        return;
      }
      const r = plan.add[0];
      if (r.handle) this.addHandle(r.handle.spline, r.handle.end, place ?? r.handle.at);
      else if (place) {
        // The handle is there already (a kept spline's, a resend): it starts at the place.
        const h = this.handleAtShared(refs);
        if (!h) {
          this.refProblems.push(`${at} (${c.id}): at(u, v) places a fit spline's end handle; this tangent has none`);
          return;
        }
        g.points[h] = [place[0], place[1]];
      }
      g.constraints.push({ id: c.id, kind: r.kind, refs: r.refs } as SketchRelation);
      this.rows.set(c.id, i);
      return;
    }
    // ---- an ellipse's, a parabola's or a conic's curve: the person's rules (sketch/constraints.ts)
    if (kinds.some((k) => k === 'ellipse' || k === 'ellipse_arc' || k === 'parabola' || k === 'conic')) {
      if (dimension) {
        this.refProblems.push(`${at} (${c.id}): a dimension does not measure an ellipse's, a parabola's or a conic's curve: dimension its points (e.center to e.major is the major radius, e.minor the minor; p.vertex to p.focus the focal length)`);
        return;
      }
      if (value) {
        this.otherProblems.push(`${at}.value (${c.id}): ${kind} is a relation: its value is "", not "${value}"`);
        return;
      }
      if (was && 'refs' in was && !('expr' in was) && JSON.stringify(was.refs) === JSON.stringify(refs) && (toolKindOf(was.kind) === kind || (kind === 'coincident' && was.kind === 'point_on_circle'))) {
        g.constraints.push({ ...was } as SketchRelation);
        this.rows.set(c.id, i);
        return;
      }
      if (place) {
        this.refProblems.push(`${at} (${c.id}): at(u, v) places a dimension's label or a fit spline's handle, not a ${kind}`);
        return;
      }
      const stored = kind === 'point_on' ? 'coincident' : kind;
      const plan = planConstraint(g, stored as SketchRelation['kind'], refs);
      if (!plan.ok || plan.add.length !== 1) {
        this.refProblems.push(`${at} (${c.id}): ${plan.ok ? `${kind} takes one relation here: name two curves, or a point and a curve` : plan.reason}`);
        return;
      }
      const r = plan.add[0];
      g.constraints.push({ id: c.id, kind: r.kind, refs: r.refs } as SketchRelation);
      this.rows.set(c.id, i);
      return;
    }
    // The first two refs share an end; with three, the third is an end of both (after the joins).
    const shares = (() => {
      const a = g.entities.find((e) => e.id === refs[0]);
      const b = g.entities.find((e) => e.id === refs[1]);
      if (!a || !b) return false;
      const ea = entityEnds(a);
      const eb = entityEnds(b);
      if (refs.length === 3) {
        const p = pointIdOf(g, refs[2]);
        return !!p && ea.includes(p) && eb.includes(p);
      }
      return eb.some((p) => ea.includes(p));
    })();
    const known = kinds.every((k) => k && k !== 'spline');
    const sig = known ? matchSignature(kind, kinds as SigKind[], shares) : null;
    if (!sig) {
      // The kinds fit a row that needs a shared end: say so.
      const needsEnd = known && !!matchSignature(kind, kinds as SigKind[], true);
      const problem = !needsEnd
        ? `${kind} does not take ${kinds.map((k) => k ?? '?').join(', ')} (${refsIn.join(', ')})`
        : refs.length === 3
          ? `${kind} (${refsIn.join(', ')}) needs ${refsIn[2]} to be an end of both ${refsIn[0]} and ${refsIn[1]}, where they meet`
          : `${kind} (${refsIn.join(', ')}) needs the two lines to share an end`;
      this.refProblems.push(`${at} (${c.id}): ${problem}; it takes ${signatureWords(kind)}`);
      return;
    }
    if (place && !dimension) {
      this.refProblems.push(`${at} (${c.id}): at(u, v) places a dimension's label or a tangent's new spline handle, not a ${kind}`);
      return;
    }
    if (dimension) {
      if (!value) {
        this.otherProblems.push(`${at}.value (${c.id}): a ${kind} takes an expression ("12 mm", "w/2") or "driven"`);
        return;
      }
      // A kept label within 1e-6 mm of where it is stays exactly there (the form writes it to 1e-6).
      const wasAt = was && 'at' in was && was.at && place && dist(was.at, place) <= 1e-6 ? was.at : place;
      const label = wasAt ? { at: [wasAt[0], wasAt[1]] as Vec2 } : {};
      if (value.toLowerCase() === DRIVEN) {
        // The person's "Make it driven": it measures, never holds. A kept driven dimension keeps the value it showed.
        const was = this.stored?.constraints.find((x) => x.id === c.id);
        const expr = was && 'driving' in was && was.driving === false ? was.expr : '';
        if (!expr) this.driven.push(c.id);
        g.constraints.push({ id: c.id, kind: sig.stored as SketchConstraint['kind'], refs, expr, driving: false, ...label } as SketchConstraint);
      } else {
        const q = kind === 'angle' ? 'angle' : 'length';
        g.constraints.push({ id: c.id, kind: sig.stored as SketchConstraint['kind'], refs, expr: storeExpr(value, q, this.units), driving: true, ...label } as SketchConstraint);
      }
    } else {
      if (value) {
        this.otherProblems.push(`${at}.value (${c.id}): ${kind} is a relation: its value is "", not "${value}"`);
        return;
      }
      g.constraints.push({ id: c.id, kind: sig.stored as SketchRelation['kind'], refs } as SketchRelation);
    }
    this.rows.set(c.id, i);
  }

  /** The end handle a fit spline among `refs` has where the two curves meet, or null. */
  private handleAtShared(refs: readonly string[]): string | null {
    const es = refs.map((r) => entityOf(this.g, r));
    const ends = (e: SketchEntity | null) => (e ? entityEnds(e) : []);
    const shared = ends(es[0]).find((p) => ends(es[1]).includes(p));
    for (const e of es) {
      if (e?.kind !== 'spline' || e.form !== 'fit' || !shared) continue;
      const h = e.pts[0] === shared ? e.handles?.[0] : e.pts[e.pts.length - 1] === shared ? e.handles?.[1] : null;
      if (h) return h;
    }
    return null;
  }

  /** A fit spline's end handle (the person's Tangent gives one: src/sketch/tools/spline-relations.ts). */
  private addHandle(spline: string, end: 0 | 1, at: Vec2): void {
    const e = entityOf(this.g, spline) as SketchSplineEntity | null;
    if (e?.kind !== 'spline' || e.form !== 'fit') return;
    let id = `${spline}__h${end}`;
    for (let k = 2; this.g.points[id]; k++) id = `${spline}__h${end}_${k}`;
    this.g.points[id] = [at[0], at[1]];
    this.guess[id] = [at[0], at[1]];
    const handles: [string | null, string | null] = [e.handles?.[0] ?? null, e.handles?.[1] ?? null];
    handles[end] = id;
    this.g.entities = this.g.entities.map((x) => (x.id === spline ? { ...e, handles } : x));
    this.name(id, `${this.refOf(spline)}.h${end}`);
  }

  /** Whether any row so far was refused (the tools after it do not run). */
  get failed(): boolean {
    return this.refProblems.length > 0 || this.otherProblems.length > 0;
  }

  /** The compiled sketch, or the refusal of every problem found. */
  finish(): Compiled {
    const constraintsIn = this.input.constraints ?? [];
    if (this.refProblems.length) {
      const kinds = [...new Set(constraintsIn.map((c) => String(c.kind)).filter((k) => (SKETCH_CONSTRAINT_KINDS as readonly string[]).includes(k)))] as ToolConstraintKind[];
      const hint = kinds.length === 1 ? `${kinds[0]} takes ${signatureWords(kinds[0])}; read help sketch for the others.` : undefined;
      refuse('bad_ref', this.refProblems, {}, hint);
    }
    if (this.otherProblems.length) refuse('bad_input', this.otherProblems);
    if (this.rows.size + this.inferred.length > CONSTRAINTS_MAX) refuse('bad_input', [`constraints: ${this.rows.size} and ${this.inferred.length} inferred make more than ${CONSTRAINTS_MAX}: split the sketch`]);
    // A replace keeps the edited sketch's order (the panel's "Line 3" stays Line 3); new items after.
    if (this.stored) {
      const order = <T extends { id: string }>(list: readonly T[], was: readonly { id: string }[]): T[] => {
        const at = new Map(was.map((x, i) => [x.id, i] as const));
        return list.map((x, i) => ({ x, k: at.get(x.id) ?? was.length + i })).sort((a, b) => a.k - b.k).map((r) => r.x);
      };
      this.g = { ...this.g, entities: order(this.g.entities, this.stored.entities), constraints: order(this.g.constraints, this.stored.constraints) };
    }
    const g = this.g;
    const dangling = danglingRefs(g);
    if (dangling.length) throw new ToolError('internal', `The sketch's refs do not resolve: ${dangling.slice(0, 6).join(', ')}.`);
    // Every point by its entity's part when nothing named it (a trimmed end, a tool's new points).
    for (const e of g.entities) {
      const n = this.refOf(e.id);
      for (const [part, p] of partsOfEntity(e)) if (p !== ORIGIN) this.name(p, part ? `${n}.${part}` : n);
    }
    for (const [id, p] of Object.entries(g.points)) if (!this.guess[id]) this.guess[id] = [p[0], p[1]];
    const refOf = this.refOf;
    const words = (c: SketchConstraint) => {
      const k = c.kind === 'point_on_line' || c.kind === 'point_on_circle' ? 'point_on' : c.kind;
      const v = 'expr' in c && typeof c.expr === 'string' ? ` = ${'driving' in c && c.driving === false ? DRIVEN : c.expr}` : '';
      return `${k} ${c.refs.map(refOf).join(', ')}${v}`;
    };
    return { draft: g, rows: this.rows, inferred: this.inferred, optional: this.optional, own: this.own, joined: this.joined, warnings: this.warnings, guess: this.guess, made: this.made, drawGroups: this.drawGroups, refOf, words };
  }
}

/** The input as sketch geometry with relations and dimensions only (the hole tool's sketch, tests). */
export function compileSketch(input: SketchIn, o: { units: UnitsService; stored: SketchFeature | null }): Compiled {
  const c = new SketchCompiler(input, o);
  (input.constraints ?? []).forEach((row, i) => {
    if (isToolRow(String(row.kind))) c.otherProblems.push(`constraints[${i}] (${row.id}): ${row.kind} runs only in the sketch tool`);
    else c.addRow(row, i);
  });
  return c.finish();
}

/** The input as sketch geometry, the person's sketch tools run by `host` in row order. */
export async function compileSketchRows(input: SketchIn, o: { units: UnitsService; stored: SketchFeature | null }, host: ToolHost): Promise<Compiled> {
  const c = new SketchCompiler(input, o);
  const rows = input.constraints ?? [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!isToolRow(String(row.kind))) c.addRow(row, i);
    // A tool after a refused row would read a sketch that is not the model's: the refusal comes first.
    else if (!c.failed) await host.run(c, row, i);
  }
  return c.finish();
}
