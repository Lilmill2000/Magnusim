// Writing a solved sketch into the Part inside the call's Assistant step (CAD tools spec §6.2, §6.5),
// through the person's own paths, so the person sees the real Sketch panel and sketch mode:
//   - an offset plane first when the sketch needs one: the CONSTRUCT Plane panel opened for the
//     Assistant (read-only for the person), Done, the rebuild, its frame read back; or the edited
//     sketch's own plane moved to the new offset;
//   - the sketch: sketch mode's startSketch(support, {step}) for a new one, the Edit panel for an
//     edit; one apply of the headless solution (sketch mode solves it again, stores it and its
//     solved state: the stored block is always the solver's); then its honest Done.
// A checkpoint follows each open, each write and the rebuild (a stop, a take-over, a change of the
// person's: the step goes back).
// At the fast pace (or with the window hidden, or after a slow rebuild) the sketch goes in with one
// apply. At the watch pace it is drawn as a person would (§6.5, §8.2): each entity (a macro with
// its own relations) shown first as a rubber band, then added and selected; then each of the
// model's relations, then each dimension, every one an apply that sketch mode solves, so the person
// sees the dimensions pull the sketch into shape and the DOF chip count down. The entities are
// drawn where the model put them, unless the solution moves a point more than max(2 mm, 10% of the
// sketch's diagonal) from there: then where the solution has them (nothing jumps). A replace draws
// its difference: what goes in one apply, changed and new entities one by one, then the changed
// constraints. Always last, when what is stored is not the headless solution (a partial solve can
// take another path), one apply writes it exactly. An intermediate apply sketch mode refuses (a
// partial set can collapse a line) only ends the drawing early: the final apply still writes the
// solution, and the call is not reverted for it. The hold point sketch-step:<n> follows the n-th
// apply (the one apply of the fast path is sketch-step:1).
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { emptyPreview, modeFor, type ApplyResult, type SketchHit, type SketchMode, type SketchPreview } from '../../sketch/mode';
import { entityPoints } from '../../sketch/model';
import { splineSamples } from '../../sketch/tools/spline-entity';
import { conicCurve, conicPolyline, isConic } from '../../sketch/tools/conic';
import type { Feature, FeatureId, SketchConstraint, SketchEntity, SketchFeature, SketchSupport, Vec2 } from '../../types/doc';
import type { EditSession } from '../../types/doc-service';
import type { PlaneRef } from '../../types/references';
import { uiFor } from '../../ui/controller';
import { heartbeat } from '../busy';
import { ToolError } from '../errors';
import { macrotask, PACE_DELAYS, type PacePoint } from '../pace';
import { runtimeOf } from '../runtime';
import type { EditCtx } from '../step';
import type { SketchGeometry } from './compile';

export type PlaneWrite = { kind: 'create'; name: string; plane: PlaneRef; distance: string; flip: boolean } | { kind: 'update'; id: FeatureId; name: string; distance: string; flip: boolean };

export interface SketchWrite {
  target: { kind: 'new'; support: SketchSupport; name: string } | { kind: 'edit'; id: FeatureId; name: string; patch: Partial<SketchFeature> | null };
  /** The headless solution: what is stored. */
  geometry: SketchGeometry;
  /** The sketch as the model drew it (compile's draft, joins applied): the watch path draws it there first. */
  drawn?: SketchGeometry;
  /** The model's kind of each of its entity ids ("rect", "circle"): the watch path's words. */
  kinds?: Readonly<Record<string, string>>;
  /** Entities a tool made that are drawn in one step (an import's: its row id), by entity id. */
  groups?: Readonly<Record<string, string>>;
}

/** One apply of the watch path. */
export interface DrawStep {
  /** Sketch mode's label for the apply ("Draw rect r", "Dimension dw"). */
  label: string;
  /** The progress words ("rect 1 of 3", "dimension dw"). */
  words: string;
  /** The pace point after it. */
  pace: PacePoint;
  /** The rubber band shown before it (an entity's), or null. */
  preview: SketchPreview | null;
  /** What is selected once it is in. */
  select: SketchHit | null;
  /** The next geometry from what is stored now. */
  make(cur: SketchGeometry): SketchGeometry;
}

/** A stored id's group: the model's entity (a macro's parts and own relations are <id>__<part>), else itself. */
export const groupOf = (id: string): string => {
  const at = id.indexOf('__');
  return at > 0 ? id.slice(0, at) : id;
};

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const dist = (a: Vec2, b: Vec2) => Math.hypot(b[0] - a[0], b[1] - a[1]);
type Circle = Extract<SketchEntity, { kind: 'circle' }>;

/** The bounding box diagonal of a set of points (mm), at least 1. */
export function diagonal(points: Readonly<Record<string, Vec2>>): number {
  const ps = Object.values(points);
  if (!ps.length) return 1;
  let u0 = Infinity;
  let v0 = Infinity;
  let u1 = -Infinity;
  let v1 = -Infinity;
  for (const [u, v] of ps) {
    u0 = Math.min(u0, u);
    v0 = Math.min(v0, v);
    u1 = Math.max(u1, u);
    v1 = Math.max(v1, v);
  }
  return Math.max(1, Math.hypot(u1 - u0, v1 - v0));
}

/**
 * Where the watch path draws: the model's own numbers (points and circle radii) when the solution
 * moves no point farther than max(2 mm, 10% of its diagonal) from them, else the solution's (§6.5).
 */
export function drawAt(target: SketchGeometry, drawn: SketchGeometry | undefined): { geometry: SketchGeometry; guesses: boolean; moved: number } {
  if (!drawn) return { geometry: target, guesses: false, moved: 0 };
  let moved = 0;
  for (const [id, p] of Object.entries(target.points)) {
    const g = drawn.points[id];
    if (g) moved = Math.max(moved, dist(p, g));
  }
  const guesses = moved <= Math.max(2, 0.1 * diagonal(target.points));
  if (!guesses) return { geometry: target, guesses, moved };
  const radius = new Map(drawn.entities.filter((e): e is Circle => e.kind === 'circle').map((e) => [e.id, e.r] as const));
  const points: Record<string, Vec2> = {};
  for (const [id, p] of Object.entries(target.points)) {
    const g = drawn.points[id];
    points[id] = g ? [g[0], g[1]] : [p[0], p[1]];
  }
  const entities = target.entities.map((e) => (e.kind === 'circle' && radius.has(e.id) ? { ...e, r: radius.get(e.id)! } : e));
  return { geometry: { points, entities, constraints: target.constraints }, guesses, moved };
}

/** Entities' rubber band at the points given. */
function previewOf(es: readonly SketchEntity[], at: (id: string) => Vec2 | null): SketchPreview {
  const p = emptyPreview();
  for (const e of es) {
    if (e.kind === 'line') {
      const a = at(e.p[0]);
      const b = at(e.p[1]);
      if (a && b) p.lines.push([a, b]);
    } else if (e.kind === 'circle') {
      const c = at(e.c);
      if (c) p.arcs.push({ c, r: e.r, a0: 0, sweep: 2 * Math.PI });
    } else if (e.kind === 'arc') {
      const c = at(e.c);
      const a = at(e.a);
      const b = at(e.b);
      if (!c || !a || !b) continue;
      const a0 = Math.atan2(a[1] - c[1], a[0] - c[0]);
      let sweep = Math.atan2(b[1] - c[1], b[0] - c[0]) - a0;
      if (e.ccw === false) {
        while (sweep >= 0) sweep -= 2 * Math.PI;
      } else {
        while (sweep <= 0) sweep += 2 * Math.PI;
      }
      p.arcs.push({ c, r: dist(c, a), a0, sweep });
    } else if (e.kind === 'point') {
      const q = at(e.p);
      if (q) p.points.push(q);
    } else if (e.kind === 'spline') {
      // The person's Spline tool shows its curve as it is drawn.
      const points: Record<string, Vec2> = {};
      for (const id of entityPoints(e)) {
        const q = at(id);
        if (q) points[id] = q;
      }
      const poly = splineSamples({ points }, e, 64);
      for (let i = 1; i < poly.length; i++) p.lines.push([poly[i - 1], poly[i]]);
    } else if (isConic(e)) {
      // The Ellipse group's tools show the curve as it is drawn.
      const points: Record<string, Vec2> = {};
      for (const id of entityPoints(e)) {
        const q = at(id);
        if (q) points[id] = q;
      }
      const c = conicCurve({ points }, e);
      const poly = c ? conicPolyline(c, 96) : [];
      for (let i = 1; i < poly.length; i++) p.lines.push([poly[i - 1], poly[i]]);
    }
  }
  return p;
}

const pointsOf = (e: SketchEntity): string[] => entityPoints(e);

/** Replace items by id, appending the new ones. */
function upsert<T extends { id: string }>(list: readonly T[], items: readonly T[]): T[] {
  const byId = new Map(items.map((x) => [x.id, x] as const));
  const out = list.map((x) => byId.get(x.id) ?? x);
  const have = new Set(list.map((x) => x.id));
  for (const x of items) if (!have.has(x.id)) out.push(x);
  return out;
}

const isDim = (c: SketchConstraint) => typeof (c as { expr?: unknown }).expr === 'string';

/** The whole sketch as sketch mode stores it: its geometry, ties (patterns, offsets) and links (none: none). */
export const whole = (g: SketchGeometry) => ({ points: g.points, entities: g.entities, constraints: g.constraints, ties: g.ties, links: g.links });

/**
 * The watch path's applies from what is stored (`start`: empty for a new sketch) to `target` (drawn
 * where drawAt says): what goes first in one apply, then each entity group (a macro with its own
 * and inferred relations), then the model's relations, then its dimensions; what is already there
 * as it should be is left out.
 */
export function drawSteps(start: SketchGeometry, target: SketchGeometry, kinds: Readonly<Record<string, string>> = {}, toolGroups: Readonly<Record<string, string>> = {}): DrawStep[] {
  // An entity's group: a macro's (its id before "__"), or the tool row that made it (an import).
  const groupIn = (id: string) => toolGroups[id] ?? groupOf(id);
  const steps: DrawStep[] = [];
  const ent = new Map(target.entities.map((e) => [e.id, e] as const));
  const con = new Map(target.constraints.map((c) => [c.id, c] as const));
  // ---- what goes (a replace): entities, constraints and points the target has not, in one apply
  const goneE = new Set(start.entities.filter((e) => !ent.has(e.id)).map((e) => e.id));
  const goneP = new Set(Object.keys(start.points).filter((id) => !target.points[id]));
  const goneC = new Set(start.constraints.filter((c) => !con.has(c.id) || c.refs.some((r) => goneE.has(r) || goneP.has(r))).map((c) => c.id));
  const gone = goneE.size + goneC.size;
  if (gone || goneP.size) {
    steps.push({
      label: 'Remove',
      words: `remove ${gone} item${gone === 1 ? '' : 's'}`,
      pace: 'add',
      preview: null,
      select: null,
      make: (cur) => {
        const points = { ...cur.points };
        for (const id of goneP) delete points[id];
        return { points, entities: cur.entities.filter((e) => !goneE.has(e.id)), constraints: cur.constraints.filter((c) => !goneC.has(c.id)) };
      },
    });
  }
  // ---- each entity group, in the target's order
  const groups: string[] = [];
  for (const e of target.entities) if (!groups.includes(groupIn(e.id))) groups.push(groupIn(e.id));
  const startE = new Map(start.entities.map((e) => [e.id, e] as const));
  const startC = new Map(start.constraints.map((c) => [c.id, c] as const));
  const entitiesOf = (g: string) => target.entities.filter((e) => groupIn(e.id) === g);
  const ownOf = (g: string) => target.constraints.filter((c) => c.id.includes('__') && groupOf(c.id) === g);
  const changed = groups.filter((g) => entitiesOf(g).some((e) => !same(startE.get(e.id), e)) || ownOf(g).some((c) => !same(startC.get(c.id), c)));
  changed.forEach((g, i) => {
    const es = entitiesOf(g);
    const cs = ownOf(g);
    const kind = kinds[g] ?? es[0]?.kind ?? 'entity';
    const lead = es.find((e) => !e.construction) ?? es[0];
    steps.push({
      label: `Draw ${kind} ${g}`,
      words: `${kind} ${i + 1} of ${changed.length}`,
      pace: 'add',
      preview: previewOf(es, (id) => target.points[id] ?? null),
      select: lead ? { what: 'entity', id: lead.id } : null,
      make: (cur) => {
        const points = { ...cur.points };
        // New points where they are drawn; points already there stay where the solver has them.
        for (const e of es) {
          for (const id of pointsOf(e)) {
            const p = target.points[id];
            if (!points[id] && p) points[id] = [p[0], p[1]];
          }
        }
        return { points, entities: upsert(cur.entities, es), constraints: upsert(cur.constraints, cs) };
      },
    });
  });
  // ---- the model's constraints: relations, then dimensions
  const own = target.constraints.filter((c) => !c.id.includes('__') && !same(startC.get(c.id), c));
  for (const c of [...own.filter((x) => !isDim(x)), ...own.filter(isDim)]) {
    const dim = isDim(c);
    steps.push({
      label: `${dim ? 'Dimension' : 'Relation'} ${c.id}`,
      words: `${dim ? 'dimension' : c.kind} ${c.id}`,
      pace: dim ? 'dimension' : 'relation',
      preview: null,
      select: { what: 'constraint', id: c.id },
      make: (cur) => ({ points: cur.points, entities: cur.entities, constraints: upsert(cur.constraints, [c]) }),
    });
  }
  return steps;
}

/** Whether what is stored is the target exactly: the same entities and constraints in order, every point and radius within `tol`. */
export function isExactly(cur: SketchGeometry, target: SketchGeometry, tol: number): boolean {
  const shape = (es: readonly SketchEntity[]) => es.map((e) => (e.kind === 'circle' ? { ...e, r: 0 } : e));
  if (!same(shape(cur.entities), shape(target.entities)) || !same(cur.constraints, target.constraints)) return false;
  if (!same(cur.ties ?? null, target.ties ?? null) || !same(cur.links ?? null, target.links ?? null)) return false;
  const ids = Object.keys(target.points);
  if (Object.keys(cur.points).length !== ids.length) return false;
  for (const id of ids) {
    const p = cur.points[id];
    if (!p || dist(p, target.points[id]) > tol) return false;
  }
  for (const e of target.entities) {
    if (e.kind !== 'circle') continue;
    const c = cur.entities.find((x): x is Circle => x.id === e.id && x.kind === 'circle');
    if (!c || Math.abs(c.r - e.r) > tol) return false;
  }
  return true;
}

/** What a watched drawing waits in all (the call's 6 s cap scales each delay to fit). */
function paceOf(steps: readonly DrawStep[]): number {
  let ms = PACE_DELAYS.open + PACE_DELAYS.commit;
  for (const st of steps) ms += PACE_DELAYS[st.pace] + (st.preview ? PACE_DELAYS.preview : 0);
  return ms;
}

/** The watch path: the sketch drawn step by step, then the headless solution exactly (§6.5). */
async function drawWatched(ctx: EditCtx, mode: SketchMode, session: EditSession, w: SketchWrite, refOf: (id: string) => string, name: string): Promise<void> {
  const target = w.geometry;
  const cur0 = mode.stored();
  const start: SketchGeometry = cur0 ? { points: cur0.points, entities: cur0.entities, constraints: cur0.constraints, ...(cur0.ties ? { ties: cur0.ties } : {}), ...(cur0.links ? { links: cur0.links } : {}) } : { points: {}, entities: [], constraints: [] };
  const steps = drawSteps(start, drawAt(target, w.drawn).geometry, w.kinds, w.groups);
  ctx.pacer.plan(paceOf(steps));
  let n = 0;
  for (const st of steps) {
    n += 1;
    const label = `Sketch "${name}" · ${st.words}`;
    if (st.preview) {
      mode.setPreview(st.preview);
      await ctx.checkpoint({ pace: 'preview', label });
    }
    const r = await mode.apply(st.label, (cur) => st.make({ points: cur.points, entities: cur.entities, constraints: cur.constraints }), { by: ctx.step });
    if (st.preview) mode.setPreview(null);
    if (!r.ok) {
      // A take-over or a stop shows first; else the drawing ends here and the final apply writes the solution.
      await ctx.checkpoint();
      break;
    }
    ctx.wrote(session);
    if (st.select) {
      const hit = st.select;
      ctx.quietly(() => mode.select([hit], false));
    }
    await ctx.checkpoint({ hold: `sketch-step:${n}`, pace: st.pace, label, fraction: n / (steps.length + 1) });
  }
  ctx.quietly(() => mode.select([], false));
  // Always last: the headless solution, exactly (a partial solve can take another path).
  const now = mode.stored();
  if (now && isExactly(now, target, 1e-6 * diagonal(target.points))) return;
  const r = await mode.apply('Solve', () => whole(target), { by: ctx.step });
  await mode.idle();
  if (!r.ok) {
    await ctx.checkpoint();
    throw applyRefused(r, refOf);
  }
  ctx.wrote(session);
  if (!steps.length) await ctx.checkpoint({ hold: 'sketch-step:1', label: `Sketch "${name}"` });
}

/** The feature `id`'s failure in the rebuild now (before its Done), as the call's. */
function failedNow(ctx: EditCtx, id: FeatureId, name: string): ToolError | null {
  const st = ctx.services.doc.state.get().rebuild.features[id];
  if (st?.state !== 'error') return null;
  return new ToolError('feature_failed', `${name} fails: ${st.message ?? 'it did not build'}`, { detail: { feature: name, message: st.message ?? null, actions: [...(st.actions ?? [])] } });
}

/** Make or move the offset plane a sketch goes on, inside the step: its id. */
export async function writePlane(ctx: EditCtx, p: PlaneWrite): Promise<FeatureId> {
  const { services } = ctx;
  const { doc } = services;
  const ui = uiFor(services);
  const label = `Plane ${p.name}`;
  let session: EditSession;
  if (p.kind === 'create') {
    const s = ui.openForAssistant(ctx.step, 'ref_plane', { name: p.name, method: 'offset', plane: p.plane, distance: p.distance, flip: p.flip } as Partial<Feature>);
    if (typeof s === 'string') throw new ToolError('bad_input', `on: the plane ${p.name} could not be made: ${s}.`, { detail: { field: 'on' } });
    session = s;
    await macrotask();
    await ctx.checkpoint({ hold: 'after-open', pace: 'open', label });
  } else {
    const s = ui.openEditForAssistant(ctx.step, p.id);
    if (typeof s === 'string') throw new ToolError('bad_input', `on: the plane ${p.name} could not be moved: ${s}.`, { detail: { field: 'on' } });
    session = s;
    await macrotask();
    await ctx.checkpoint({ hold: 'after-open', pace: 'open', label });
    s.update({ distance: p.distance, flip: p.flip } as Partial<Feature>);
    ctx.wrote(s);
  }
  const id = session.feature;
  await heartbeat(ctx, doc.settled(ctx.signal), label);
  await ctx.checkpoint({ pace: 'commit', label });
  const failed = failedNow(ctx, id, p.name);
  if (failed) throw failed;
  const why = ui.doneForAssistant(ctx.step);
  if (why) throw new ToolError('incomplete', `${p.name}: ${why}.`);
  await heartbeat(ctx, doc.settled(ctx.signal), label);
  if (doc.state.get().rebuild.outputs[id]?.type !== 'plane') throw new ToolError('feature_failed', `${p.name} did not build.`, { detail: { feature: p.name } });
  if (p.kind === 'create') runtimeOf(services)?.madeBy.add(id);
  // Between the plane and the sketch: a change of the person's here makes the step unclean.
  await ctx.checkpoint({ hold: 'between-opens' });
  return id;
}

/** Sketch mode's refusal of the step's apply as the call's error. */
export function applyRefused(r: Extract<ApplyResult, { ok: false }>, refOf: (id: string) => string): ToolError {
  if (r.over) {
    const ids = [...(r.conflicting ?? []), ...(r.redundant ?? [])].map(refOf);
    return new ToolError('sketch_conflict', `Sketch mode found the sketch over-defined: ${ids.join(', ') || 'by its constraints'}. Nothing changed.`, { detail: { conflicts: ids.map((id) => ({ id })) } });
  }
  if (/cannot be solved/.test(r.reason)) return new ToolError('sketch_unsolved', `Sketch mode found no solution: ${r.reason}. Nothing changed.`);
  if (/shrink/.test(r.reason)) return new ToolError('sketch_collapsed', `Sketch mode: ${r.reason}. Nothing changed.`);
  return new ToolError('feature_failed', `The sketch could not be written: ${r.reason || 'sketch mode refused it'}.`);
}

/** Write the solved sketch inside the step (§6.5, fast or watched): its feature id. */
export async function writeSketch(ctx: EditCtx, w: SketchWrite, refOf: (id: string) => string = (id) => id): Promise<FeatureId> {
  const { services } = ctx;
  const { doc } = services;
  const mode = modeFor(services);
  if (!mode) throw new ToolError('internal', 'Sketch mode is not running in this Part.');
  const name = w.target.name;
  const label = `Sketch ${name}`;
  let session: EditSession;
  if (w.target.kind === 'new') {
    const r = await mode.startSketch(w.target.support, { step: ctx.step });
    if (r !== true) {
      if (/flat faces|curved/.test(r)) throw new ToolError('not_flat', `on: ${r}.`, { detail: { field: 'on' } });
      if (/no name/.test(r)) throw new ToolError('not_named', `on: ${r}.`, { detail: { field: 'on' } });
      throw new ToolError('bad_input', `on: the sketch could not start there: ${r}.`, { detail: { field: 'on' } });
    }
    const s = mode.session;
    if (!s || !s.open || s.owner !== ctx.owner) throw new ToolError('internal', 'The sketch did not open for the Assistant.');
    session = s;
    if (s.draft.name !== name) s.update({ name } as Partial<Feature>);
  } else {
    const s = uiFor(services).openEditForAssistant(ctx.step, w.target.id);
    if (typeof s === 'string') throw new ToolError('bad_input', `edit: ${name} cannot be edited here: ${s}.`, { detail: { field: 'edit' } });
    session = s;
    if (w.target.patch) s.update(w.target.patch as Partial<Feature>);
  }
  await macrotask();
  await ctx.checkpoint({ hold: 'after-open', pace: 'open', label });
  if (runtimeOf(services)?.pace.watching()) {
    // Watched: drawn as a person would, then the solution exactly.
    await drawWatched(ctx, mode, session, w, refOf, name);
  } else {
    const g = w.geometry;
    const r = await mode.apply('Sketch', () => whole(g), { by: ctx.step });
    await mode.idle();
    if (!r.ok) {
      // A take-over or a stop shows first.
      await ctx.checkpoint();
      throw applyRefused(r, refOf);
    }
    ctx.wrote(session);
    await ctx.checkpoint({ hold: 'sketch-step:1', label });
  }
  await heartbeat(ctx, doc.settled(ctx.signal), label);
  await ctx.checkpoint({ pace: 'commit', hold: 'before-commit', label });
  const failed = failedNow(ctx, session.feature, name);
  if (failed) throw failed;
  const why = await mode.finish({ step: ctx.step });
  if (why) {
    await ctx.checkpoint();
    throw new ToolError('incomplete', `${name}: ${why}.`);
  }
  return session.feature;
}
