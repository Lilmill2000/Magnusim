// What the tools that make a body from sketch regions share (extrude and revolve; CAD tools spec
// §3.2.8, §3.2.9, §7.4):
//   sketch    one sketch by name (any case) or id; an edit's sketch must come before the feature
//   regions   region selectors in that sketch: "all" (every hole stays open), "r2", "at(u, v)",
//             a region key, or "<sketch> r2" naming the same sketch; each names at least one,
//             the union kept once each
//   op        new makes a body (body_name and color name and colour it after the panel's Done,
//             in the same step); join, cut and intersect act on `bodies` (body selectors), or with
//             [] on every body they meet
//   misses    an operation that meets nothing fails with CAD's own words and, from diagnose.ts,
//             which way it missed (detail.sub, the frame); a scoped cut that cut nothing away is
//             cut_removed_nothing, a scoped intersect that would leave nothing of its bodies fails
//             (a kernel restart while their volumes are read answers busy changed); after a
//             value edit, a scoped cut or intersect that acted before it and acts on nothing now
//             (it still builds) reverts the edit (scopedActing, scopedLost, scopedLostError)
// The field rules are checked in plan, every problem at once (bad_input).
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { AppServices } from '../types/app';
import { entityParents, resolveRegionRef } from '../features/extrude/profiles';
import type { BodyId, Feature, FeatureId, RegionRef, SketchFeature, Vec2 } from '../types/doc';
import type { DocState, EndBody } from '../types/doc-service';
import type { ShapeId } from '../types/kernel-protocol';
import type { SketchOutput } from '../types/sketch';
import { heartbeat } from './busy';
import { diagnoseMiss, isMiss, type Miss, type SweptFeature } from './diagnose';
import { HINTS, isToolError, ToolError } from './errors';
import { andList, bodyText, fillFeature, str, strings, type FeatureFill } from './feature-tools';
import type { JudgedPlan } from './judge';
import { featureByName } from './model';
import { len, sig6 } from './numbers';
import { regionRefOf } from './selectors/refs';
import { selectSet, type RegionHit, type Scene } from './selectors/resolve';
import type { EditCtx } from './step';
import { closestName, closestWords } from './closest';

export const OPS = ['new', 'join', 'cut', 'intersect'] as const;
export type Op = (typeof OPS)[number];

/** A body name's longest (the Part's own rename rule). */
export const BODY_NAME_MAX = 40;
const COLOR = /^#[0-9a-f]{6}$/i;
/** A scoped cut whose bodies' volume moved less than this (relative) cut nothing away. */
export const CUT_NOTHING_REL = 1e-9;

export interface OpInput {
  op: Op;
  bodies: string[];
  bodyName: string;
  color: string;
}

/** The op fields as sent, each problem added to `problems` (bad_input, all at once). */
export function readOp(input: Record<string, unknown>, problems: string[]): OpInput {
  const op = input.op as Op;
  const bodies = strings(input.bodies);
  const bodyName = str(input.body_name);
  const color = str(input.color).toLowerCase();
  if (!OPS.includes(op)) problems.push('op: new, join, cut or intersect');
  if (op === 'new' && bodies.length) problems.push('bodies: [] with op new (a new body acts on no other)');
  bodies.forEach((b, i) => {
    if (!b) problems.push(`bodies[${i}]: a body name, not ""`);
  });
  if (op !== 'new' && bodyName) problems.push(`body_name: only op new makes a body to name; send "" with op ${op}`);
  if (op !== 'new' && color) problems.push(`color: only op new makes a body to colour; send "" with op ${op}`);
  if (color && !COLOR.test(color)) problems.push(`color: "${color}" is not #rrggbb`);
  if (bodyName.length > BODY_NAME_MAX) problems.push(`body_name: at most ${BODY_NAME_MAX} characters`);
  return { op, bodies, bodyName, color };
}

/** The sketch a tool's `sketch` names (any case, or its id); an edit's must come before the feature it serves. */
export function sketchFor(services: AppServices, text: unknown, editing: Feature | null): SketchFeature {
  const s = services.doc.state.get();
  const name = str(text);
  const sketches = s.doc.features.filter((f) => f.type === 'sketch').map((f) => f.name);
  const list = sketches.length ? sketches.slice(0, 30).join(', ') : 'none yet';
  const f = name ? featureByName(s, name) : null;
  if (!f) {
    const near = closestName(name, sketches);
    throw new ToolError('not_found', `sketch: no sketch is called "${name}".${closestWords(near)} Sketches: ${list}.`, { detail: { field: 'sketch', names: sketches.slice(0, 30), ...(near ? { closest: near } : {}) } });
  }
  if (f.type !== 'sketch') throw new ToolError('not_found', `sketch: ${f.name} is not a sketch. Sketches: ${list}.`, { detail: { field: 'sketch', names: sketches.slice(0, 30) } });
  if (editing) {
    const at = s.doc.features.findIndex((g) => g.id === editing.id);
    if (s.doc.features.findIndex((g) => g.id === f.id) > at) throw new ToolError('later_feature', `sketch: ${f.name} comes after ${editing.name} in the history: pick a sketch made before it.`, { detail: { field: 'sketch', feature: f.name } });
  }
  return f;
}

export interface Regions {
  refs: RegionRef[];
  hits: RegionHit[];
  /** "all -> r1 (2400 mm²)" (as the selectors' echoes read). */
  words: string;
}

/** The regions of `sketch` the selectors name (inside withScene with that sketch), once each. */
export async function regionsOf(sc: Scene, sketch: SketchFeature, texts: readonly string[], tool: string): Promise<Regions> {
  const hits: RegionHit[] = [];
  for (const [i, t] of texts.entries()) {
    const field = `regions[${i}]`;
    const sel = await selectSet(sc, t, 'region', field);
    for (const h of sel.hits) {
      if (h.kind !== 'region') throw new ToolError('bad_selector', `${field}: "${t}" names ${h.kind === 'body' ? 'a body' : `a ${h.kind}`}, not a region of ${sketch.name} ("all", "r2" or "at(u, v)").`, { detail: { field, selector: t } });
      if (h.sketch.id !== sketch.id) throw new ToolError('bad_input', `${field}: "${t}" is a region of ${h.sketch.name}; this ${tool} takes regions of ${sketch.name} (one sketch per call).`, { detail: { field } });
      if (!hits.some((x) => x.row.key === h.row.key)) hits.push(h);
    }
  }
  const refs = hits.map((h) => regionRefOf(sc, h));
  const rows = hits.map((h) => `${h.row.id} (${sig6(h.row.area_mm2)} mm²)`);
  return { refs, hits, words: `${texts.join(', ')} -> ${rows.length > 8 ? `${rows.slice(0, 8).join(', ')} and ${rows.length - 8} more` : rows.join(', ')}` };
}

/** The bodies a join, cut or intersect acts on (body selectors), once each, with their names. */
export async function scopeOf(sc: Scene, texts: readonly string[]): Promise<{ ids: BodyId[]; words: string }> {
  const ids: BodyId[] = [];
  const names: string[] = [];
  for (const [i, t] of texts.entries()) {
    const sel = await selectSet(sc, t, 'body', `bodies[${i}]`);
    for (const h of sel.hits) {
      if (h.kind !== 'body' || ids.includes(h.body.id)) continue;
      ids.push(h.body.id);
      names.push(h.body.name);
    }
  }
  return { ids, words: andList(names) };
}

/** A new body's name, checked: another body by that name is name_taken (a feature's name is fine). */
export function checkBodyName(services: AppServices, name: string, own: BodyId | null): void {
  if (!name) return;
  const s = services.doc.state.get();
  const want = name.toLowerCase();
  const clash = Object.entries(s.doc.bodies).find(([id, b]) => id !== own && b.name.toLowerCase() === want) ?? s.rebuild.bodies.map((b) => [b.id, b] as const).find(([id, b]) => id !== own && b.name.toLowerCase() === want);
  if (clash) throw new ToolError('name_taken', `body_name: another body is already called ${clash[1].name}.`, { detail: { field: 'body_name' } });
}

/** The op in words for `resolved` ("new body", "cut Plate", "join every body it meets"). */
export function opWords(op: Op, scope: string): string {
  if (op === 'new') return 'new body';
  return `${op} ${scope || 'every body it meets'}`;
}

/** The diagnosis of a miss; one that could not be made at all (the feature gone meanwhile) says nothing more. */
async function missOf(services: AppServices, f: SweptFeature): Promise<Miss> {
  try {
    return await diagnoseMiss(services, f);
  } catch {
    return { sub: null, words: '', detail: {} };
  }
}

/** "<what happened>. <the diagnosis>" (or the first part alone). */
const withMiss = (text: string, miss: Miss) => (miss.words ? `${text.replace(/\.$/, '')}. ${miss.words}` : text);

/**
 * The feature on the person's panel (feature-tools.ts fillFeature); an operation that meets
 * nothing answers feature_failed with its diagnosis (detail.sub, the frame, the boxes).
 */
export async function fillSwept(ctx: EditCtx, plan: JudgedPlan, fill: FeatureFill): Promise<FeatureId> {
  try {
    return await fillFeature(ctx, plan, fill);
  } catch (e) {
    if (!isToolError(e) || e.reason !== 'feature_failed' || !plan.own) throw e;
    const f = ctx.services.doc.state.get().doc.features.find((g) => g.id === plan.own);
    const message = typeof e.detail.message === 'string' ? e.detail.message : null;
    if (!f || !isMiss(f, message)) throw e;
    const miss = await missOf(ctx.services, f);
    const { reason: _r, ...detail } = e.detail;
    throw new ToolError('feature_failed', withMiss(e.message.replace(/^feature_failed: /, ''), miss), { detail: { ...detail, ...miss.detail }, ...(miss.hint ? { hint: miss.hint } : {}) });
  }
}

/** The geometry kernel restarted while the result was checked: the shapes read are gone (busy changed; the step reverts). */
const restarted = () => new ToolError('changed', 'The geometry kernel restarted while the result was checked, so nothing was kept: call get_model, then try again.');

/** A shape's volume, from the worker of `epoch` only (a respawn kills the ids; its successor's are others'). */
async function volumeOf(services: AppServices, shape: ShapeId, epoch: number): Promise<number> {
  if (services.kernel.status.get().respawns !== epoch) throw restarted();
  let r;
  try {
    r = await services.kernel.call('props', { id: shape, volume: true, bbox: 'none' });
  } catch (e) {
    if (services.kernel.status.get().respawns !== epoch) throw restarted();
    throw e;
  }
  if (services.kernel.status.get().respawns !== epoch) throw restarted();
  return typeof r.result.volume === 'number' ? r.result.volume : NaN;
}

/** The bodies just after feature `id` (the rebuild's own when it is the last one). */
async function bodiesAfter(services: AppServices, id: FeatureId): Promise<{ id: BodyId; shape: ShapeId }[]> {
  const s = services.doc.state.get();
  const at = s.doc.features.findIndex((f) => f.id === id);
  const next = s.doc.features[at + 1];
  if (next) return (await services.doc.bodiesBefore(next.id)).bodies;
  return s.rebuild.bodies.map((b) => ({ id: b.id, shape: b.shape }));
}

/**
 * After the Done of a scoped cut or intersect: one that cut nothing away from any of its bodies
 * answers cut_removed_nothing, one that would leave nothing of every one of them feature_failed,
 * each with the diagnosis. Bodies a cut did not touch while it cut others are warnings.
 */
export async function checkScoped(ctx: EditCtx, id: FeatureId): Promise<string[]> {
  const { services } = ctx;
  const f = services.doc.state.get().doc.features.find((g) => g.id === id) as SweptFeature | undefined;
  if (!f || (f.op !== 'cut' && f.op !== 'intersect') || !f.scope.length) return [];
  await heartbeat(ctx, services.doc.settled(ctx.signal), f.name);
  const epoch = services.kernel.status.get().respawns;
  const before = (await services.doc.bodiesBefore(id)).bodies.filter((b) => f.scope.includes(b.id));
  const after = await bodiesAfter(services, id);
  const rows: { body: EndBody; was: number; now: number | null }[] = [];
  for (const b of before) {
    const a = after.find((x) => x.id === b.id);
    rows.push({ body: b, was: await volumeOf(services, b.shape, epoch), now: a ? await volumeOf(services, a.shape, epoch) : null });
  }
  if (!rows.length) return [];
  const untouched = rows.filter((r) => r.now !== null && Math.abs(r.now - r.was) <= CUT_NOTHING_REL * Math.max(Math.abs(r.was), 1e-12));
  const names = andList(rows.map((r) => r.body.name));
  if (f.op === 'cut' && untouched.length === rows.length) {
    const miss = await missOf(services, f);
    throw new ToolError('cut_removed_nothing', withMiss(`${f.name} cut nothing away from ${names}.`, miss), { detail: { feature: f.name, scope: rows.map((r) => r.body.name), ...miss.detail }, ...(miss.hint ? { hint: miss.hint } : {}) });
  }
  if (f.op === 'intersect' && rows.every((r) => r.now === null)) {
    const miss = await missOf(services, f);
    throw new ToolError('feature_failed', withMiss(`${f.name} fails: it overlaps none of ${names}, so the intersect would leave nothing of ${rows.length === 1 ? 'it' : 'them'}.`, miss), { detail: { feature: f.name, message: null, actions: [], scope: rows.map((r) => r.body.name), ...miss.detail }, ...(miss.hint ? { hint: miss.hint } : {}) });
  }
  return f.op === 'cut' ? untouched.map((r) => `${f.name} cut nothing away from ${r.body.name}`) : [];
}

/** The most scoped cuts and intersects an edit checks (the earliest ones from its start). */
export const SCOPED_CHECK_MAX = 40;

/** A scoped cut or intersect that acted on its bodies before an edit (scopedActing), by id. */
export type ScopedActing = { id: FeatureId; name: string }[];

/** A scoped cut or intersect that no longer acts after an edit: its name and the words. */
export interface ScopedLost {
  id: FeatureId;
  name: string;
  words: string;
}

/** A feature that cuts or intersects only the bodies it names (holes, an extrude cut with bodies [...]), built now. */
function scopedFeature(s: DocState, f: Feature): (Feature & { op: 'cut' | 'intersect'; scope: BodyId[] }) | null {
  const g = f as Feature & { op?: unknown; scope?: unknown };
  if ((g.op !== 'cut' && g.op !== 'intersect') || !Array.isArray(g.scope) || !g.scope.length || f.suppressed) return null;
  const st = s.rebuild.features[f.id]?.state;
  return st === 'ok' || st === 'warning' ? (g as Feature & { op: 'cut' | 'intersect'; scope: BodyId[] }) : null;
}

/**
 * Whether a scoped cut still takes something away from one of its bodies (an intersect: still
 * leaves something of one), from the bodies just before and just after it; null when it has no
 * body of its scope before it. `vols` keeps each shape's volume once.
 */
async function scopedActs(services: AppServices, f: Feature & { op: 'cut' | 'intersect'; scope: BodyId[] }, epoch: number, vols: Map<ShapeId, number>): Promise<{ acts: boolean; names: string[] } | null> {
  const before = (await services.doc.bodiesBefore(f.id)).bodies.filter((b) => f.scope.includes(b.id));
  if (!before.length) return null;
  const after = await bodiesAfter(services, f.id);
  const vol = async (shape: ShapeId) => {
    if (!vols.has(shape)) vols.set(shape, await volumeOf(services, shape, epoch));
    return vols.get(shape)!;
  };
  const names = before.map((b) => b.name);
  for (const b of before) {
    const a = after.find((x) => x.id === b.id);
    if (f.op === 'intersect') {
      if (a) return { acts: true, names };
      continue;
    }
    // A cut that took the whole body away acted on it.
    if (!a) return { acts: true, names };
    const was = await vol(b.shape);
    if (Math.abs((await vol(a.shape)) - was) > CUT_NOTHING_REL * Math.max(Math.abs(was), 1e-12)) return { acts: true, names };
  }
  return { acts: false, names };
}

/**
 * Before a value edit (CAD tools spec §7.4): the scoped cuts and intersects from feature index
 * `from` on that act on their bodies now (a kernel restart meanwhile answers busy changed).
 */
export async function scopedActing(ctx: Pick<EditCtx, 'services'>, from: number): Promise<ScopedActing> {
  const { services } = ctx;
  const s = services.doc.state.get();
  const epoch = services.kernel.status.get().respawns;
  const vols = new Map<ShapeId, number>();
  const out: ScopedActing = [];
  const list = s.doc.features.slice(Math.max(0, from)).map((f) => scopedFeature(s, f)).filter((f) => f !== null).slice(0, SCOPED_CHECK_MAX);
  for (const f of list) {
    const r = await scopedActs(services, f, epoch, vols);
    if (r?.acts) out.push({ id: f.id, name: f.name });
  }
  return out;
}

/** After the edit: those of `acting` that still build but no longer act on their bodies, with the words. */
export async function scopedLost(ctx: Pick<EditCtx, 'services'>, acting: ScopedActing): Promise<ScopedLost[]> {
  const { services } = ctx;
  if (!acting.length) return [];
  const s = services.doc.state.get();
  const epoch = services.kernel.status.get().respawns;
  const vols = new Map<ShapeId, number>();
  const out: ScopedLost[] = [];
  for (const a of acting) {
    const g = s.doc.features.find((x) => x.id === a.id);
    const f = g ? scopedFeature(s, g) : null;
    if (!f) continue;
    const r = await scopedActs(services, f, epoch, vols);
    if (!r || r.acts) continue;
    const words = f.op === 'cut' ? `${f.name} cuts nothing away from ${andList(r.names)}` : `${f.name} leaves nothing of ${andList(r.names)}`;
    out.push({ id: f.id, name: f.name, words });
  }
  return out;
}

/**
 * The answer of a value edit after which scoped cuts or intersects no longer act on their bodies
 * (broke_downstream; the call reverts), with the first one's diagnosis (which way it misses now).
 */
export async function scopedLostError(services: AppServices, lost: readonly ScopedLost[]): Promise<ToolError> {
  const f = services.doc.state.get().doc.features.find((g) => g.id === lost[0].id);
  const miss: Miss = f && (f.type === 'extrude' || f.type === 'revolve') ? await missOf(services, f as SweptFeature) : { sub: null, words: '', detail: {} };
  const list = andList(lost.map((l) => l.words));
  const broke = lost.slice(0, 20).map((l) => ({ feature: l.name, message: l.words }));
  // The value is what to change, not the profile: the reason's own hint, whatever way it misses.
  return new ToolError('broke_downstream', withMiss(`Nothing changed: after it ${list}.`, miss), { detail: { broke, ...miss.detail }, hint: HINTS.broke_downstream });
}

/** After the Done of a new body: its name and colour, inside the step (one-shot edits). */
export async function nameNewBody(ctx: EditCtx, id: FeatureId, name: string, color: string): Promise<void> {
  if (!name && !color) return;
  const { doc } = ctx.services;
  const f = doc.state.get().doc.features.find((g) => g.id === id) as SweptFeature | undefined;
  const body = f && f.op === 'new' ? f.creates : null;
  if (!body) return;
  await ctx.checkpoint({ label: 'Body' });
  if (name) {
    const r = ctx.step.run(() => doc.renameBody(body, name));
    if (!r.ok) throw new ToolError(/already called/.test(r.reason) ? 'name_taken' : 'bad_input', `body_name: ${r.reason}.`, { detail: { field: 'body_name' } });
  }
  if (color) {
    const r = ctx.step.run(() => doc.setBodyColor(body, color));
    if (!r.ok) throw new ToolError('bad_input', `color: ${r.reason}.`, { detail: { field: 'color' } });
  }
}

/**
 * A kept region's inside point now: the region it resolves to in its sketch's output (by key, as
 * the feature builds it), so a parameter that moved or shrank it since it was picked is followed;
 * the stored point only when it resolves to none.
 */
export function regionPointNow(s: DocState, r: RegionRef): Vec2 {
  const sketch = s.doc.features.find((f) => f.id === r.sketch) as SketchFeature | undefined;
  const out = s.rebuild.outputs[r.sketch] as SketchOutput | undefined;
  if (out?.type === 'sketch') {
    const found = resolveRegionRef(r, out.regions, entityParents(sketch?.entities));
    if (found.ok) return found.region.sample;
  }
  return r.sample;
}

/** A feature's regions as get_model full writes them: each kept region's inside point now, "at(u, v)". */
export function regionTexts(s: DocState, profiles: readonly RegionRef[]): string[] {
  return profiles.map((p) => {
    const at = regionPointNow(s, p);
    return `at(${len(at[0])}, ${len(at[1])})`;
  });
}

/** A feature's bodies (its scope) by name, as a body list writes them. */
export function scopeTexts(services: AppServices, scope: readonly BodyId[]): string[] {
  const s = services.doc.state.get();
  return scope.map((id) => bodyText(s, id));
}
