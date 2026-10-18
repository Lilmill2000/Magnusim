// Why a join, cut or intersect met nothing (CAD tools spec §7.4): the answer an extrude or a
// revolve gives when its operation finds no body to act on, in the model's terms. Only on failure,
// with a few kernel calls on copies (nothing in the Part changes; every shape made is released):
//   join          no_overlap: the profile and the bodies' boxes, the sketch's frame in model axes
//   cut, intersect
//     wrong_side  the same regions with flip the other way meet a body (extrude_regions or
//                 revolve_regions, then boolean common per body, as extrude/def.ts does)
//     too_short   the whole sweep (an extrude through everything both ways, a full turn) meets
//                 one, but this extent stops before it: make it longer. A blind extrude is checked
//                 one way at a time (through everything along it, then the other way): a body
//                 that only the other way meets, farther than the distance, is wrong_side with
//                 how far away it starts (gap_mm), since no longer distance this way reaches it
//     off_body    neither: the profile lies beside the bodies; the frame (where u and v point in
//                 model axes, and the origin) and the profile's model box beside each body's
// A kernel that refuses one of the checks (or restarts) leaves the sub-reason out: the answer says
// the check could not be made, never a guess.
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { nothingToActOn } from '../doc/features/body-op';
import { kernelExtent, resolveExtent } from '../features/extrude/def';
import { entityParents, resolveRegionRef } from '../features/extrude/profiles';
import { resolveAxis } from '../features/refgeom/resolve';
import { resolveRevolveExtent } from '../features/revolve/def';
import { toModel, ydirOf } from '../features/sketch/plane';
import type { AppServices } from '../types/app';
import type { BodyId, ExtrudeFeature, Feature, FeatureId, RevolveFeature, SketchFeature, Vec3 } from '../types/doc';
import type { BuiltBody, EndBody, FeatureOutput } from '../types/doc-service';
import type { KernelAdapter, KernelCallError } from '../types/kernel';
import type { BBox, ShapeId } from '../types/kernel-protocol';
import type { SketchOutput } from '../types/sketch';
import { frameWords } from './model';
import { dir, len, vec } from './numbers';

/** detail.sub of a miss. */
export type MissSub = 'no_overlap' | 'wrong_side' | 'too_short' | 'off_body';

/** A body-making feature an Assistant tool makes from sketch regions. */
export type SweptFeature = ExtrudeFeature | RevolveFeature;

export interface Miss {
  /** null when a check could not be made (the kernel refused it, or restarted). */
  sub: MissSub | null;
  /** One or two sentences for the message. */
  words: string;
  /** sub, frame, profile_bbox_mm, bodies [{body, bbox_mm}], and other_way / in_line (a body's name). */
  detail: Record<string, unknown>;
  /** A hint in place of the sub-reason's fixed one, where that would mislead (flip is already true; a revolve). */
  hint?: string;
}

/** The most bodies whose boxes a miss lists. */
const BODIES_LISTED = 8;

const isSwept = (f: Feature): f is SweptFeature => f.type === 'extrude' || f.type === 'revolve';

/** The kernel's refusal of a Through all that finds nothing on its side, or no body under the profile (facade.cpp). */
const THROUGH_NOTHING = /^[^:]+ failed: Through all: (there is nothing to go through in this direction|the profile misses every body)/;

/** Whether a feature's failure is its operation meeting nothing (CAD's own words: body-op.ts, or Through all's). */
export function isMiss(f: Feature, message: string | null | undefined): f is SweptFeature {
  if (!isSwept(f) || f.op === 'new' || !message) return false;
  return message.startsWith(nothingToActOn(f.op, f.name)) || (f.type === 'extrude' && THROUGH_NOTHING.test(message));
}

/** A direction in model words: "+Z", or its numbers when it is no model axis. */
export function axisWords(v: readonly number[]): string {
  const i = [0, 1, 2].reduce((best, k) => (Math.abs(v[k]) > Math.abs(v[best]) ? k : best), 0);
  if (Math.abs(Math.abs(v[i]) - 1) > 1e-6) return `(${dir(v).join(', ')})`;
  return `${v[i] > 0 ? '+' : '-'}${'XYZ'[i]}`;
}

/** "x 0, y -3 to 3, z -25.5 to -19.5": a box in model words (mm). */
export function boxWords(b: readonly number[]): string {
  return ['x', 'y', 'z']
    .map((a, k) => {
      const lo = len(b[k]);
      const hi = len(b[k + 3]);
      return lo === hi ? `${a} ${lo}` : `${a} ${lo} to ${hi}`;
    })
    .join(', ');
}

const boxRow = (b: readonly number[]) => [vec(b.slice(0, 3)), vec(b.slice(3, 6))];

function unionBox(points: readonly Vec3[]): BBox | null {
  if (!points.length) return null;
  const b: BBox = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const p of points) {
    for (let k = 0; k < 3; k++) {
      b[k] = Math.min(b[k], p[k]);
      b[k + 3] = Math.max(b[k + 3], p[k]);
    }
  }
  return b;
}

function overlaps(a: BBox, b: BBox, tol: number): boolean {
  return a[0] <= b[3] + tol && b[0] <= a[3] + tol && a[1] <= b[4] + tol && b[1] <= a[4] + tol && a[2] <= b[5] + tol && b[2] <= a[5] + tol;
}

/** A kernel refusal of a shape (that way builds nothing), as opposed to a dead worker. */
const refusal = (e: unknown) => {
  const k = (e as Partial<KernelCallError> | null)?.kind;
  return k === 'input' || k === 'occt' || k === 'internal';
};

interface Scene {
  services: AppServices;
  f: SweptFeature;
  out: SketchOutput;
  sketchName: string;
  keys: string[];
  /** The bodies just before the feature, and the ones its operation may act on. */
  before: EndBody[];
  targets: EndBody[];
  made: ShapeId[];
  epoch: number;
  /** The kernel, guarded against a respawn (guarded()). */
  kernel: KernelAdapter;
}

/**
 * The kernel as the checks use it: a call made after the worker was respawned (its shape ids died,
 * and its successor numbers its own from the start) is refused, and so is the answer of one that
 * was respawned meanwhile (a shape it made is let go in the new worker).
 */
function guarded(sc: Scene): KernelAdapter {
  const kernel = sc.services.kernel;
  const gone = () => new Error('the geometry kernel restarted');
  const call: KernelAdapter['call'] = async (op, params, opts) => {
    if (kernel.status.get().respawns !== sc.epoch) throw gone();
    let r;
    try {
      r = await kernel.call(op, params, opts);
    } catch (e) {
      // Refused by a worker that no longer knows the ids ("unknown shape id"), or cut short by the respawn.
      if (kernel.status.get().respawns !== sc.epoch) throw gone();
      throw e;
    }
    if (kernel.status.get().respawns !== sc.epoch) {
      const id = (r.result as { id?: ShapeId }).id;
      if (typeof id === 'number') void kernel.call('release', { ids: [id] }).catch(() => {});
      throw gone();
    }
    return r;
  };
  return new Proxy(kernel, {
    get(t, prop) {
      if (prop === 'call') return call;
      const v = Reflect.get(t, prop, t);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
}

/** What the build context gives the extents and axes (the bodies just before the feature). */
function buildCtx(sc: Scene) {
  const s = sc.services.doc.state.get();
  const names = new Map(s.doc.features.map((g) => [g.id, g.name]));
  return {
    kernel: sc.kernel,
    bodies: new Map<BodyId, BuiltBody>(sc.before.map((b) => [b.id, b])),
    outputs: new Map<FeatureId, FeatureOutput>(Object.entries(s.rebuild.outputs)),
    doc: s.doc,
    bodyName: (id: BodyId) => sc.before.find((b) => b.id === id)?.name ?? s.doc.bodies[id]?.name ?? 'a removed body',
    featureName: (id: FeatureId) => names.get(id) ?? 'a deleted feature',
  };
}

async function bboxOf(sc: Scene, shape: ShapeId, exact = false): Promise<BBox> {
  const r = await sc.kernel.call('props', { id: shape, bbox: exact ? 'exact' : 'fast', bbox_mode: exact ? 'optimal' : 'fast' });
  return r.result.bbox ?? [0, 0, 0, 0, 0, 0];
}

/**
 * The feature's tool shape made another way (flip turned; the whole sweep; an extrude through
 * everything its own way, `ahead`, or the other way, `behind`), or null when that way makes
 * nothing (the kernel refuses it). The shape is released with the scene.
 */
async function toolShape(sc: Scene, how: 'flip' | 'whole' | 'ahead' | 'behind'): Promise<ShapeId | null> {
  const { f, out, keys, services, kernel } = sc;
  const units = services.doc.units;
  const section = { plane: out.plane, curves: out.curves, regions: keys };
  try {
    let id: ShapeId;
    if (f.type === 'extrude') {
      let extent;
      if (how !== 'flip') extent = { kind: 'through_all' as const, targets: sc.targets.map((b) => b.shape), both: how === 'whole' };
      else {
        const v = resolveExtent(f, units);
        if (!v.ok) return null;
        const k = await kernelExtent(f, v.values, buildCtx(sc));
        if (!k.ok) return null;
        extent = k.extent;
      }
      id = (await kernel.call('extrude_regions', { ...section, extent, flip: how === 'flip' || how === 'behind' ? !f.flip : !!f.flip })).result.id;
    } else {
      if (!f.axis) return null;
      const axis = await resolveAxis(f.axis, buildCtx(sc));
      if (!axis.ok) return null;
      const v = resolveRevolveExtent(f, units);
      if (!v.ok) return null;
      const extent = how === 'whole' ? { kind: 'one' as const, angle: 360 } : v.values;
      id = (await kernel.call('revolve_regions', { ...section, axis: axis.value, extent, flip: how === 'flip' ? !f.flip : !!f.flip })).result.id;
    }
    sc.made.push(id);
    return id;
  } catch (e) {
    if (refusal(e)) return null;
    throw e;
  }
}

/** The first target body `tool` overlaps (more than touching), or null. */
async function firstOverlap(sc: Scene, tool: ShapeId): Promise<EndBody | null> {
  const tb = await bboxOf(sc, tool);
  const tol = 1e-7 * Math.max(1, Math.hypot(tb[3] - tb[0], tb[4] - tb[1], tb[5] - tb[2]));
  for (const body of sc.targets) {
    if (!overlaps(tb, await bboxOf(sc, body.shape), tol)) continue;
    const c = (await sc.kernel.call('boolean', { op: 'common', targets: [body.shape], tools: [tool], keep_tools: true })).result;
    sc.made.push(c.id);
    if (!c.empty) return body;
  }
  return null;
}

/** The first target body an extrude through everything one way meets (`ahead`: its own way, `behind`: the other), or null. */
async function firstWay(sc: Scene, how: 'ahead' | 'behind'): Promise<EndBody | null> {
  const tool = await toolShape(sc, how);
  return tool !== null ? firstOverlap(sc, tool) : null;
}

/** Whether flipping changes the shape at all (symmetric extents and equal two-sided ones do not). */
function flipMatters(sc: Scene): boolean {
  const { f } = sc;
  const units = sc.services.doc.units;
  if (f.type === 'extrude') {
    const v = resolveExtent(f, units);
    if (!v.ok) return false;
    const e = v.values;
    if (e.kind === 'symmetric') return false;
    if (e.kind === 'through_all') return !e.both;
    if (e.kind === 'two') return Math.abs(e.d1 - e.d2) > 1e-9;
    return true;
  }
  const v = resolveRevolveExtent(f, units);
  if (!v.ok) return false;
  const e = v.values;
  if (e.kind === 'symmetric') return false;
  if (e.kind === 'two') return Math.abs(e.angle - e.angle2) > 1e-9;
  return e.angle < 360 - 1e-9;
}

/** Free the shapes the checks made, unless the worker that made them died (its successor's ids are others'). */
async function release(sc: Scene): Promise<void> {
  if (!sc.made.length || sc.services.kernel.status.get().respawns !== sc.epoch) return;
  try {
    await sc.services.kernel.call('release', { ids: sc.made });
  } catch {
    // The worker was respawned: its shapes are gone anyway.
  }
}

const VERB: Record<'join' | 'cut' | 'intersect', string> = { join: 'join', cut: 'cut', intersect: 'intersect' };

/**
 * Why `f` (a join, cut or intersect in the Part now, its draft included) acts on nothing. `scope`:
 * the bodies to check against (the feature's scope by default; every body before it when empty).
 */
export async function diagnoseMiss(services: AppServices, f: SweptFeature, o: { scope?: readonly BodyId[] } = {}): Promise<Miss> {
  const s = services.doc.state.get();
  const sketchId = f.profiles[0]?.sketch;
  const out = sketchId ? (s.rebuild.outputs[sketchId] as SketchOutput | undefined) : undefined;
  const sketch = s.doc.features.find((g) => g.id === sketchId) as SketchFeature | undefined;
  const sketchName = sketch?.name ?? 'its sketch';
  if (!out || out.type !== 'sketch') return { sub: null, words: `${sketchName} is not built, so the miss could not be checked.`, detail: {} };
  const parents = entityParents(sketch?.entities);
  const keys: string[] = [];
  const corners: Vec3[] = [];
  for (const ref of f.profiles) {
    const r = resolveRegionRef(ref, out.regions, parents);
    if (!r.ok || keys.includes(r.key)) continue;
    keys.push(r.key);
    const [u0, v0, u1, v1] = r.region.bbox;
    for (const uv of [
      [u0, v0],
      [u1, v0],
      [u1, v1],
      [u0, v1],
    ] as [number, number][])
      corners.push(toModel(out.plane, uv));
  }
  const plane = out.plane;
  const frame = { origin_mm: vec(plane.origin), u: dir(plane.xdir), v: dir(ydirOf(plane)), normal: dir(plane.normal), words: frameWords(plane) };
  // The bodies' shapes belong to the worker that built them: a respawn meanwhile leaves the checks out.
  const epoch = services.kernel.status.get().respawns;
  const before = (await services.doc.bodiesBefore(f.id)).bodies;
  if (services.kernel.status.get().respawns !== epoch) return { sub: null, words: `Which way it missed could not be checked (the geometry kernel restarted). On ${sketchName}, ${frame.words}.`, detail: { frame } };
  const scope = o.scope ?? f.scope;
  const targets = scope.length ? before.filter((b) => scope.includes(b.id)) : before;
  const sc: Scene = { services, f, out, sketchName, keys, before, targets, made: [], epoch, kernel: services.kernel };
  sc.kernel = guarded(sc);
  const profile = unionBox(corners);
  const verb = VERB[f.op as 'join' | 'cut' | 'intersect'];
  const tool = f.type === 'extrude' ? 'extrude' : 'revolve';
  try {
    const boxes: { body: string; bbox: BBox }[] = [];
    for (const b of targets.slice(0, BODIES_LISTED)) boxes.push({ body: b.name, bbox: await bboxOf(sc, b.shape, true) });
    const detail: Record<string, unknown> = {
      frame,
      ...(profile ? { profile_bbox_mm: boxRow(profile) } : {}),
      bodies: boxes.map((b) => ({ body: b.body, bbox_mm: boxRow(b.bbox) })),
      ...(targets.length > BODIES_LISTED ? { bodies_more: targets.length - BODIES_LISTED } : {}),
    };
    const spans = [...(profile ? [`the profile spans ${boxWords(profile)} mm`] : []), ...boxes.map((b) => `${b.body} spans ${boxWords(b.bbox)} mm`)];
    const where = `On ${sketchName}, ${frame.words}${spans.length ? `; ${spans.join('; ')}` : ''}.`;
    if (!targets.length) return { sub: null, words: `There is no body ${scope.length ? 'of its bodies ' : ''}before it to ${verb}.`, detail };
    if (f.op === 'join') return { sub: 'no_overlap', words: `It touches no body. ${where}`, detail: { sub: 'no_overlap', ...detail } };
    if (flipMatters(sc)) {
      const flipped = await toolShape(sc, 'flip');
      const hit = flipped !== null ? await firstOverlap(sc, flipped) : null;
      if (hit) {
        const words = f.type === 'extrude' ? `It points away from the body: with flip ${!f.flip} it would ${verb} ${hit.name}.` : `It turns away from the body: with flip ${!f.flip} it would ${verb} ${hit.name}.`;
        const hint = f.type === 'revolve' ? `The ${verb} turns away from the body: set flip ${!f.flip}.` : f.flip ? `The ${verb} points away from the body: set flip false, or use hole.` : undefined;
        return { sub: 'wrong_side', words, detail: { sub: 'wrong_side', other_way: hit.name, ...detail }, ...(hint ? { hint } : {}) };
      }
    }
    // A blind extrude: its own way (any length), then the other way (flip and length both wrong).
    const blind = f.type === 'extrude' && (() => {
      const v = resolveExtent(f, sc.services.doc.units);
      return v.ok && v.values.kind === 'blind';
    })();
    if (blind) {
      const behind = (await firstWay(sc, 'ahead')) ? null : await firstWay(sc, 'behind');
      if (behind) {
        // How far the body starts from the sketch plane, the other way.
        const away: Vec3 = (f.flip ? [...plane.normal] : plane.normal.map((c) => -c)) as Vec3;
        const b = await bboxOf(sc, behind.shape, true);
        let near = Infinity;
        for (const x of [b[0], b[3]]) for (const y of [b[1], b[4]]) for (const z of [b[2], b[5]]) near = Math.min(near, (x - plane.origin[0]) * away[0] + (y - plane.origin[1]) * away[1] + (z - plane.origin[2]) * away[2]);
        const gap = Math.max(0, near);
        const words = `It points away from the body, and ${behind.name} starts ${len(gap)} mm away on the other side: with flip ${!f.flip} and a distance over ${len(gap)} mm it would ${verb} ${behind.name}. ${where}`;
        return { sub: 'wrong_side', words, detail: { sub: 'wrong_side', other_way: behind.name, gap_mm: len(gap), ...detail }, hint: `The ${verb} points away from the body: set flip ${!f.flip} and a distance over ${len(gap)} mm (or extent through), or use hole.` };
      }
    }
    const whole = await toolShape(sc, 'whole');
    const inLine = whole !== null ? await firstOverlap(sc, whole) : null;
    if (inLine) {
      const words = f.type === 'extrude' ? `The profile is in line with ${inLine.name}, but the ${tool} stops before it reaches it. ${where}` : `A full turn would meet ${inLine.name}, but this angle stops before it. ${where}`;
      return { sub: 'too_short', words, detail: { sub: 'too_short', in_line: inLine.name, ...detail } };
    }
    return { sub: 'off_body', words: `The profile lies beside ${targets.length === 1 ? targets[0].name : 'the bodies'}, so no way of this ${tool} meets ${targets.length === 1 ? 'it' : 'them'}. ${where}`, detail: { sub: 'off_body', ...detail } };
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    return { sub: null, words: `Which way it missed could not be checked (${why}). On ${sketchName}, ${frame.words}.`, detail: { frame } };
  } finally {
    await release(sc);
  }
}
