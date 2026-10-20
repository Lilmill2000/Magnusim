// The sketch tool's solve, headless and before anything changes (CAD tools spec §6.4): the solver
// always runs, on its own instance apart from sketch mode (analyzeFeature), so a sketch is never
// trusted as drawn.
//   1. every dimension's expression is evaluated first (an unevaluated one would hold the guess):
//      expr_error names the constraint;
//   2. solve and analyse;
//   3. over-defined: the tool's own inferred relations go first, those touching the over-defined
//      ones newest first (then any, newest first), solving again each time, also when the solver
//      names the model's constraint rather than the inferred one; the ones not needed come back.
//      Each one that stays out says why: it could not hold with the constraints the solver named
//      (conflicting) or repeated them (redundant);
//      Anything still conflicting or redundant is sketch_conflict, naming each constraint and what
//      it fights or repeats (a redundant one's partners are found by solving without each in turn),
//      a macro's own relation as `internal` ("r's own horizontal on r.top");
//   4. no solution: sketch_unsolved; a line, circle or arc solved to no size: sketch_collapsed;
//   5. a new driven dimension (value "driven") takes the value it measures on the solution, as the
//      person's "Make it driven" places it;
//   6. `moved`: points the solution put more than max(0.5 mm, 2% of the sketch's size) from where
//      the model drew them (the 10 farthest); `free`: what still moves (the solver's free
//      parameters by the model's names: {"of": "bo.center", "moves": ["u", "v"]}).
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { entityPoints, evaluateDimensions, isDimension, measureDimension, quantityOf, withSolved } from '../../sketch/model';
import { exprFor } from '../../sketch/mode';
import { statusOf } from '../../sketch/dof';
import type { CallCtx } from '../../types/assistant';
import type { SketchConstraint, SketchEntity, SketchFeature, Vec2 } from '../../types/doc';
import type { SketchSolverClient, SolverFeatureAnalysis, SolverSolveResult } from '../../types/sketch';
import { heartbeat } from '../busy';
import { ToolError } from '../errors';
import { len } from '../numbers';
import type { SketchGeometry } from './compile';
import { toolKindOf } from './signatures';

export interface SolveInput {
  geometry: SketchGeometry;
  /** The tool's inferred relations (they may go), oldest first. */
  inferred: readonly string[];
  /** The model's name for a stored id. */
  refOf(stored: string): string;
  /** A constraint in the model's words. */
  words(c: SketchConstraint): string;
  /** The macros' own relations in words. */
  own: ReadonlyMap<string, string>;
  /** The model's constraints: stored id -> index in its input (expr_error names constraints[i]). */
  rows: ReadonlyMap<string, number>;
  /** The input field `rows` index ('constraints'; edit_feature's 'set'). */
  rowField?: string;
  /** Where the model drew each point. */
  guess: Readonly<Record<string, Vec2>>;
}

export interface FreeRow {
  of: string;
  moves: string[];
}

export interface MovedRow {
  of: string;
  by_mm: number;
  to: number[];
}

export interface ConflictRow {
  id: string;
  kind: string;
  refs: string[];
  value: string;
  label: string;
  internal?: string;
  inferred?: true;
}

export interface Solved {
  /** The solution: what is stored. */
  geometry: SketchGeometry;
  /** Each driving dimension's value (mm, deg). */
  values: Record<string, number>;
  state: 'under' | 'fully';
  dof: number;
  free: FreeRow[];
  moved: MovedRow[];
  /** The inferred relations that went (stored ids). */
  dropped: string[];
  /** Why each went: it fought (conflicting) or repeated (redundant) these constraints (stored ids; none when the solver named only it). */
  droppedWhy: Record<string, { fought: boolean; with: string[] }>;
}

/** Solves of the partner search, at most. */
const PARTNER_SOLVES = 12;
const MOVED_MAX = 10;

const asFeature = (g: SketchGeometry) => g as unknown as SketchFeature;
const without = (g: SketchGeometry, id: string): SketchGeometry => ({ ...g, constraints: g.constraints.filter((c) => c.id !== id) });
const overOf = (st: { conflicting: string[]; redundant: string[] }) => [...st.conflicting, ...st.redundant];
const PARAM_WORDS: Record<string, string> = { a0: 'start_angle', a1: 'end_angle' };
/** Free rows a reply lists, at most. */
export const FREE_MAX = 40;

/**
 * The solver's free parameters ("<owner>.<param>") by the model's names, as the sketch tool and
 * get_model both give them: only those of a point or an entity (`owns`; a constraint's own helper
 * parameters, a spline's glue or a pattern's, are left out), an arc's angles as start_angle and
 * end_angle, each name once.
 */
export function freeRows(params: readonly string[], owns: (id: string) => boolean, refOf: (id: string) => string): { of: string; moves: string[] }[] {
  const free = new Map<string, string[]>();
  for (const p of params) {
    const dot = p.lastIndexOf('.');
    if (dot <= 0 || p.startsWith('#')) continue;
    const owner = p.slice(0, dot);
    if (!owns(owner)) continue;
    const of = refOf(owner);
    const name = PARAM_WORDS[p.slice(dot + 1)] ?? p.slice(dot + 1);
    const list = free.get(of) ?? [];
    if (!list.includes(name)) list.push(name);
    free.set(of, list);
  }
  return [...free.entries()].slice(0, FREE_MAX).map(([of, moves]) => ({ of, moves }));
}

/** The sketch solver of this Part, ready, or not_ready solver_starting. */
export async function solverReady(ctx: Pick<CallCtx, 'services' | 'progress'>): Promise<SketchSolverClient> {
  const solver = ctx.services.apis.get().solver;
  if (!solver) throw new ToolError('solver_starting', 'The sketch solver is not running in this Part yet.');
  try {
    await heartbeat(ctx, solver.ready(), 'Starting the sketch solver');
  } catch (e) {
    throw new ToolError('solver_starting', `The sketch solver could not start: ${e instanceof Error ? e.message : String(e)}.`);
  }
  return solver;
}

/** The solver's refusal of a sketch it was given as a tool error. */
function solverRefusal(e: unknown, refOf: (id: string) => string): ToolError {
  const msg = e instanceof Error ? e.message : String(e);
  const m = /constraint ([^:]+): (.*)$/.exec(msg);
  if (m) return new ToolError('bad_ref', `The solver refused ${refOf(m[1])}: ${m[2]}.`, { detail: { constraint: refOf(m[1]) } });
  return new ToolError('internal', `The sketch solver failed: ${msg}.`);
}

/** The refs a set of constraints ties, with the points of the entities among them. */
function touchSet(g: SketchGeometry, ids: readonly string[]): Set<string> {
  const out = new Set<string>();
  const byId = new Map(g.entities.map((e) => [e.id, e] as const));
  for (const c of g.constraints) {
    if (!ids.includes(c.id)) continue;
    for (const r of c.refs) {
      out.add(r);
      const e = byId.get(r);
      if (e) for (const p of entityPoints(e)) out.add(p);
    }
  }
  return out;
}

const touches = (g: SketchGeometry, id: string, set: ReadonlySet<string>) => {
  const c = g.constraints.find((x) => x.id === id);
  if (!c) return false;
  const byId = new Map(g.entities.map((e) => [e.id, e] as const));
  return c.refs.some((r) => set.has(r) || (byId.get(r) ? entityPoints(byId.get(r) as SketchEntity).some((p) => set.has(p)) : false));
};

/** A size of zero for a line, circle or arc that the solution shrank. */
function collapsed(g: SketchGeometry): string | null {
  let scale = 1;
  for (const p of Object.values(g.points)) scale = Math.max(scale, Math.abs(p[0]), Math.abs(p[1]));
  const tiny = 1e-7 * scale;
  const at = (id: string): Vec2 => (id === 'origin' ? [0, 0] : (g.points[id] ?? [0, 0]));
  for (const e of g.entities) {
    if (e.kind === 'line' && Math.hypot(at(e.p[1])[0] - at(e.p[0])[0], at(e.p[1])[1] - at(e.p[0])[1]) <= tiny) return e.id;
    if (e.kind === 'circle' && !(e.r > tiny)) return e.id;
    if (e.kind === 'arc' && Math.hypot(at(e.a)[0] - at(e.c)[0], at(e.a)[1] - at(e.c)[1]) <= tiny) return e.id;
  }
  return null;
}

/** Solve the sketch headless (§6.4): the solution, or the honest refusal. Nothing in the Part changes. */
export async function solveSketch(ctx: Pick<CallCtx, 'services' | 'progress' | 'signal'>, input: SolveInput): Promise<Solved> {
  const { services } = ctx;
  const solver = await solverReady(ctx);
  const { refOf } = input;
  const ev = evaluateDimensions(input.geometry, services.doc.units);
  const errs = Object.entries(ev.errors);
  if (errs.length) {
    const names = services.doc.state.get().doc.params.map((p) => p.name);
    const at = (id: string) => (input.rows.has(id) ? `${input.rowField ?? 'constraints'}[${input.rows.get(id)}]` : 'a dimension');
    const problems = errs.slice(0, 12).map(([id, why]) => `${at(id)} (${refOf(id)}): ${why}${/Unknown parameter/.test(why) ? `. Parameters: ${names.length ? names.join(', ') : 'none yet'}` : ''}`);
    const first = errs[0][0];
    throw new ToolError('expr_error', `${problems.join('; ')}.`, { detail: { field: `${at(first)}.value`, constraints: errs.map(([id]) => refOf(id)) } });
  }
  const analyze = async (g: SketchGeometry): Promise<SolverFeatureAnalysis> => {
    ctx.signal.throwIfAborted?.();
    try {
      return await heartbeat(ctx, solver.analyzeFeature(asFeature(g), ev.values), 'Solving the sketch');
    } catch (e) {
      throw solverRefusal(e, refOf);
    }
  };
  const solveOnly = async (g: SketchGeometry): Promise<SolverSolveResult> => {
    try {
      return await solver.solveFeature(asFeature(g), ev.values);
    } catch (e) {
      throw solverRefusal(e, refOf);
    }
  };
  const byId = new Map(input.geometry.constraints.map((c) => [c.id, c] as const));
  let attempt = input.geometry;
  let r = await analyze(attempt);
  let st = statusOf(r.solve, r.analysis);
  // The tool's own inferred relations go first, those that touch the over-defined ones newest first.
  const left = [...input.inferred];
  const dropped: string[] = [];
  const droppedWhy: Solved['droppedWhy'] = {};
  while (overOf(st).length && left.length) {
    const set = touchSet(attempt, overOf(st));
    let k = left.length - 1;
    for (let j = left.length - 1; j >= 0; j--) {
      if (touches(attempt, left[j], set)) {
        k = j;
        break;
      }
    }
    const [id] = left.splice(k, 1);
    dropped.push(id);
    droppedWhy[id] = { fought: st.conflicting.length > 0, with: overOf(st).filter((x) => x !== id) };
    attempt = without(attempt, id);
    r = await analyze(attempt);
    st = statusOf(r.solve, r.analysis);
  }
  // The ones that were not needed come back, oldest first.
  if (!overOf(st).length && dropped.length > 1) {
    for (const id of input.inferred.filter((x) => dropped.includes(x))) {
      const c = byId.get(id)!;
      const next: SketchGeometry = { ...attempt, constraints: [...attempt.constraints, c] };
      const rr = await analyze(next);
      const s2 = statusOf(rr.solve, rr.analysis);
      if (overOf(s2).length || !rr.solve.solved) continue;
      attempt = next;
      r = rr;
      st = s2;
      dropped.splice(dropped.indexOf(id), 1);
    }
  }
  const over = overOf(st);
  if (over.length) {
    const ids = [...over];
    // A redundant constraint repeats another: find which (solving without each one it touches).
    if (!st.conflicting.length) {
      const set = touchSet(attempt, ids);
      const candidates = attempt.constraints.filter((c) => !ids.includes(c.id) && touches(attempt, c.id, set)).slice(0, PARTNER_SOLVES);
      for (const c of candidates) {
        const rr = await solveOnly(without(attempt, c.id));
        const s2 = statusOf(rr);
        if (!overOf(s2).length) ids.push(c.id);
      }
    }
    const shown = (id: string) => (input.rows.has(id) ? id : id.replace('__', '.'));
    const rows: ConflictRow[] = ids
      .map((id) => attempt.constraints.find((c) => c.id === id))
      .filter((c): c is SketchConstraint => !!c)
      .map((c) => ({
        id: shown(c.id),
        kind: toolKindOf(c.kind) ?? c.kind,
        refs: c.refs.map(refOf),
        value: 'expr' in c && typeof c.expr === 'string' ? c.expr : '',
        label: input.words(c),
        ...(input.own.has(c.id) ? { internal: input.own.get(c.id)! } : {}),
        ...(input.inferred.includes(c.id) ? { inferred: true as const } : {}),
      }))
      // The model's own first.
      .sort((a, b) => Number(!!a.internal || !!a.inferred) - Number(!!b.internal || !!b.inferred));
    const mine = rows.filter((x) => !x.internal && !x.inferred).map((x) => x.id);
    const named = rows.map((x) => x.internal ?? `${x.id} (${x.label})`);
    const list = named.length <= 1 ? named.join('') : `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}`;
    const fix = mine.length ? `remove ${mine.length === 1 ? mine[0] : `one of ${mine.join(', ')}`}` : 'change the numbers or the shapes';
    // The person's "Make it driven?": a dimension of the model's that over-defines it can measure instead.
    const dims = rows.filter((x) => !x.internal && !x.inferred && attempt.constraints.some((c) => c.id === x.id && isDimension(c) && c.driving)).map((x) => x.id);
    const driven = dims.length ? `, or make ${dims.length === 1 ? dims[0] : `one of ${dims.join(', ')}`} driven (value "driven": it shows the value without holding it)` : '';
    // One constraint alone repeats what the sketch holds already: joined points, or a shape's own relations.
    const what = st.conflicting.length ? 'cannot all hold' : rows.length === 1 ? 'repeats what the sketch already holds (points within 0.05 mm are one point, and each shape keeps its own relations)' : 'say the same thing';
    throw new ToolError('sketch_conflict', `The sketch is over-defined: ${list} ${what}; ${fix}${driven}. Nothing changed.`, { detail: { conflicts: rows.slice(0, 20) } });
  }
  if (!r.solve.solved) throw new ToolError('sketch_unsolved', 'The solver found no shape that holds every constraint and dimension. Nothing changed.', { detail: { status: r.solve.status } });
  const solved = withSolved(asFeature(attempt), r.solve.values) as unknown as SketchGeometry;
  const shrunk = collapsed(solved);
  // A new driven dimension shows what it measures (signed as the person's are: x, y and angle).
  const constraints = attempt.constraints.map((c) => {
    if (!isDimension(c) || c.driving || c.expr) return c;
    const v = measureDimension(solved, c);
    if (v == null || !Number.isFinite(v)) return c;
    const signed = c.kind === 'distance_x' || c.kind === 'distance_y' || c.kind === 'angle';
    return { ...c, expr: exprFor(signed ? v : Math.abs(v), quantityOf(c.kind), services.doc.units) };
  });
  if (shrunk) throw new ToolError('sketch_collapsed', `${refOf(shrunk)} would shrink to nothing: its constraints and dimensions leave it no size. Nothing changed.`, { detail: { entity: refOf(shrunk) } });
  // Moved: points the solution put far from the model's guess.
  const gp = Object.values(input.guess);
  const xs = gp.map((p) => p[0]);
  const ys = gp.map((p) => p[1]);
  const diag = gp.length ? Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) : 0;
  const limit = Math.max(0.5, 0.02 * diag);
  const moved: (MovedRow & { d: number })[] = [];
  for (const [id, p] of Object.entries(solved.points)) {
    const g0 = input.guess[id];
    if (!g0) continue;
    const d = Math.hypot(p[0] - g0[0], p[1] - g0[1]);
    if (d > limit) moved.push({ of: refOf(id), by_mm: len(d), to: [len(p[0]), len(p[1])], d });
  }
  moved.sort((a, b) => b.d - a.d);
  // Free: the solver's free parameters, by the model's names.
  const entityIds = new Set(solved.entities.map((e) => e.id));
  const free = freeRows(r.analysis.dependentParams ?? [], (owner) => !!solved.points[owner] || entityIds.has(owner), refOf);
  return {
    geometry: { points: solved.points, entities: solved.entities, constraints, ...(attempt.ties ? { ties: attempt.ties } : {}), ...(attempt.links ? { links: attempt.links } : {}) },
    values: ev.values,
    state: st.state === 'fully' ? 'fully' : 'under',
    dof: st.dof,
    free,
    moved: moved.slice(0, MOVED_MAX).map(({ d: _d, ...m }) => m),
    dropped,
    droppedWhy: Object.fromEntries(dropped.map((id) => [id, droppedWhy[id]])),
  };
}
