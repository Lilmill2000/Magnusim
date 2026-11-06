// The thread feature type (Hole's tapped hole, modelled): the ISO metric or Unified inch internal
// thread of a tapped hole cut into its wall. `hole` names the hole's own cut (an extrude with `thread`); at each
// rebuild the thread reads that cut's sketch (its circles h1, h2...: centres and the tap drill's
// radius), its direction and depth, and the thread's size, so it follows the hole.
// The groove is the basic profile's: 60 deg flanks, a flat P/8 wide at the major diameter, running
// from just inside the hole's wall out to the major diameter. Each hole's groove is one kernel
// loft_regions through that profile in planes round the axis (PER_TURN per turn, each a pitch's
// fraction further along it: a helical sweep), and every hole's groove is cut from the body in one
// boolean. Each hole's thread runs along its own wall (the cut's side face of that circle, measured
// on the body): `length` "" is the whole wall, stopping a pitch short of a blind hole's bottom and
// just inside a through hole's far face (a groove crossing that face is a boolean the kernel answers
// with nothing removed, so it never does); else that far from the face, at most that. A cut that
// removes nothing fails in words rather than passing as threaded. The hole must run along X, Y or
// Z (as Hole makes it): a wall's length is measured by its box. The body keeps its id; the groove's
// faces are F:<id>:thread:<hole>.<k>, which the Assistant's labels call "Face of <name> thread".
// Owner: ASSISTANT (the person's side of hole).
// SPDX-License-Identifier: GPL-3.0-or-later
import { newId, nextName } from '../../lib/ids';
import { faceName } from '../../naming/names';
import { namesFromResult } from '../../naming/result';
import type { ExtrudeFeature, FeatureId, SketchFeature, ThreadFeature, Vec3 } from '../../types/doc';
import type { BuildContext, BuiltBody, ExprField, FeatureBuildResult, FeatureTypeDef, ResolveResult } from '../../types/doc-service';
import type { RegionSection, ShapeId } from '../../types/kernel-protocol';
import type { FaceNames } from '../../types/naming';
import type { SketchOutput } from '../../types/sketch';
import type { UnitsService } from '../../types/units';
import { toModel } from '../sketch/plane';
import { kernelStep } from '../solids/build';
import { fastener } from './sizes';

const round3 = (v: number) => Math.round(v * 1000) / 1000;
import { bodyFor } from '../solids/local';

/** Profile planes per turn of the helix (16 holds the groove's volume within 0.2% of a true helix). */
const PER_TURN = 16;
/** The most turns one hole's thread may have (a long fine thread past it is refused with the reason). */
export const THREAD_TURNS_MAX = 120;
/** How far inside the hole's wall the groove starts (a fraction of the pitch), so its cut meets no face edge-on. */
const INSIDE = 0.02;
/** A thread with an outline (24 viewBox): a bolt's shank with its crests. */
export const THREAD_ICON = 'M9 3h6v3H9z M8 6h8 M9 9l6 2 M9 12l6 2 M9 15l6 2 M9 18l6 2 M9 6v15h6V6';

/** The thread's length in mm, or null for the whole hole. */
export interface ThreadValues {
  length: number | null;
}

/** The length's value, or the problem in words. */
export function resolveThread(f: Pick<ThreadFeature, 'length'>, units: UnitsService): ResolveResult<ThreadValues> {
  const t = typeof f.length === 'string' ? f.length.trim() : '';
  if (!t) return { ok: true, values: { length: null } };
  const r = units.evaluate(t, 'length');
  if (!r.ok) return { ok: false, message: `Length: ${r.error}` };
  if (!(r.value > 0)) return { ok: false, message: 'Length must be more than 0' };
  return { ok: true, values: { length: r.value } };
}

/** One hole of the thread: its centre on the face, the direction into the cut, and the sketch's x (where each turn starts). */
interface ThreadHole {
  c: Vec3;
  d: Vec3;
  x: Vec3;
}

/**
 * The groove's profile planes for one hole: the basic profile (r from rIn to R, a P/8 flat at R,
 * 60 deg flanks) in the plane through the axis at each angle, a pitch per turn along it.
 */
function grooveSections(h: ThreadHole, rIn: number, R: number, P: number, turns: number, key: string): RegionSection[] {
  const { c, d, x } = h;
  const y: Vec3 = [d[1] * x[2] - d[2] * x[1], d[2] * x[0] - d[0] * x[2], d[0] * x[1] - d[1] * x[0]];
  const crest = P / 8;
  const wIn = crest + 2 * (R - rIn) * Math.tan(Math.PI / 6);
  // In each plane u runs out from the axis and v = normal x u runs against d: a point a along the axis has v = -a.
  const pts: [number, number][] = [
    [rIn, wIn / 2],
    [R, crest / 2],
    [R, -crest / 2],
    [rIn, -wIn / 2],
  ];
  const curves = pts.map((a, j) => ({ id: `t${j}`, kind: 'line' as const, a, b: pts[(j + 1) % 4] }));
  const n = Math.max(2, Math.ceil(turns * PER_TURN));
  const out: RegionSection[] = [];
  for (let i = 0; i <= n; i++) {
    const t = (turns * i) / n;
    const th = 2 * Math.PI * t;
    const cs = Math.cos(th);
    const sn = Math.sin(th);
    const xdir: Vec3 = [0, 1, 2].map((k) => cs * x[k] + sn * y[k]) as Vec3;
    const normal: Vec3 = [0, 1, 2].map((k) => -sn * x[k] + cs * y[k]) as Vec3;
    const origin: Vec3 = [0, 1, 2].map((k) => c[k] + d[k] * P * t) as Vec3;
    out.push({ plane: { origin, normal, xdir }, curves, regions: [key] });
  }
  return out;
}

/**
 * How far each hole's wall runs from its centre on the face along the hole (mm), measured on the
 * body (the cut's side face of that circle, "F:<cut>:side:<h>[..." and the pieces later features
 * split it into), or null for a hole whose wall is not there.
 */
async function wallLengths(name: string, ctx: Pick<BuildContext, 'kernel'>, body: BuiltBody, cut: FeatureId, ids: readonly string[], holes: readonly ThreadHole[]): Promise<{ ok: true; value: (number | null)[] } | { ok: false; message: string }> {
  const faces = body.names?.faces ?? [];
  const of = ids.map((id) => faces.flatMap((n, i) => (n.split('|').some((p) => p.startsWith(`F:${cut}:side:${id}[`)) ? [i] : [])));
  const all = [...new Set(of.flat())];
  if (!all.length) return { ok: true, value: ids.map(() => null) };
  const topo = await kernelStep(name, () => ctx.kernel.call('topo', { id: body.shape, faces: all, edges: 'none', vertices: 'none', face_bbox: 'exact', face_mass: false }));
  if (!topo.ok) return topo;
  const box = new Map(topo.value.result.faces.map((t) => [t.i, t.bbox ?? null]));
  const value = of.map((list, k) => {
    const { c, d } = holes[k];
    let far: number | null = null;
    for (const i of list) {
      const bb = box.get(i);
      if (!bb) continue;
      for (const x of [bb[0], bb[3]]) for (const y of [bb[1], bb[4]]) for (const z of [bb[2], bb[5]]) far = Math.max(far ?? -Infinity, (x - c[0]) * d[0] + (y - c[1]) * d[1] + (z - c[2]) * d[2]);
    }
    return far;
  });
  return { ok: true, value };
}

/** Whether a direction runs along X, Y or Z (within a degree): a wall's box then measures its length. */
const alongAxis = (d: Vec3) => Math.max(Math.abs(d[0]), Math.abs(d[1]), Math.abs(d[2])) >= Math.cos(Math.PI / 180);

export const threadDef: FeatureTypeDef<ThreadFeature, ThreadValues> = {
  type: 'thread',
  label: 'Thread',
  icon: THREAD_ICON,
  create(doc, init = {}) {
    return { id: newId('f'), type: 'thread', name: nextName('Thread', doc.features.map((f) => f.name)), hole: '', body: '', length: '', ...init } as ThreadFeature;
  },
  resolve: (f, units) => resolveThread(f, units),
  incomplete(f, units) {
    if (!f.hole) return 'Pick the tapped hole to thread';
    const r = resolveThread(f, units);
    return r.ok ? null : r.message;
  },
  parents: (f) => (f.hole ? [f.hole] : []),
  uses: (f) => (f.body ? [f.body] : []),
  exprs: (f) => (f.length ? [{ path: 'length', expr: f.length } as ExprField] : []),
  mapExprs: (f, fn) => (f.length ? { ...f, length: fn(f.length) } : f),
  async build(f, v, ctx): Promise<FeatureBuildResult> {
    // ---- the hole: its cut, its thread, its sketch's circles
    const hole = ctx.doc.features.find((g) => g.id === f.hole) as ExtrudeFeature | undefined;
    if (!hole || hole.type !== 'extrude') return { ok: false, message: `${f.name} failed: its tapped hole is gone` };
    const th = hole.thread;
    if (!th) return { ok: false, message: `${f.name} failed: ${hole.name} is not a tapped hole (it has no thread)` };
    const sketchId = hole.profiles[0]?.sketch;
    const sk = ctx.doc.features.find((g) => g.id === sketchId) as SketchFeature | undefined;
    const out = sketchId ? ctx.outputs.get(sketchId) : undefined;
    if (!sk || !out || out.type !== 'sketch') return { ok: false, message: `${f.name} failed: the sketch of ${hole.name} did not build` };
    const so = out as SketchOutput;
    const circles = sk.entities.flatMap((e) => (e.kind === 'circle' && /^h\d+$/.test(e.id) && so.points[e.c] ? [e] : []));
    if (!circles.length) return { ok: false, message: `${f.name} failed: ${hole.name}'s sketch has no hole circles` };
    const rHole = so.radii[circles[0].id] ?? circles[0].r;
    const n = so.plane.normal;
    const d: Vec3 = hole.flip ? [-n[0], -n[1], -n[2]] : [n[0], n[1], n[2]];
    if (!alongAxis(d)) return { ok: false, message: `${f.name} failed: ${hole.name} does not run along X, Y or Z, and a thread is cut only into such a hole` };
    const holes: ThreadHole[] = circles.map((e) => ({ c: toModel(so.plane, so.points[(e as { c: string }).c]), d, x: so.plane.xdir as Vec3 }));
    const P = th.pitch;
    const R = th.major / 2;
    if (!(R > rHole)) return { ok: false, message: `${f.name} failed: ${th.designation}'s major diameter (${th.major} mm) is not wider than ${hole.name} (${2 * rHole} mm): nothing to cut` };
    const rIn = rHole - INSIDE * P;
    if (R - rIn > 0.75 * P) return { ok: false, message: `${f.name} failed: ${hole.name} (${round3(2 * rHole)} mm) is too small for ${th.designation}: its tap drill is ${fastener(th.designation)?.tap.words ?? `${round3(th.major - P)} mm`}` };

    // ---- the body and how far each hole's thread runs: its own wall, measured on the body
    const b = bodyFor(f.name, f.body, ctx);
    if (!b.ok) return b;
    const body = b.value;
    const blind = hole.extent.kind === 'blind';
    const wIn = P / 8 + 2 * (R - rIn) * Math.tan(Math.PI / 6);
    // Clear of a blind hole's bottom by a pitch; inside a through hole's far face by the groove's half width and a little.
    const clear = blind ? P : wIn / 2 + INSIDE * P;
    const walls = await wallLengths(f.name, ctx, body, hole.id, circles.map((e) => e.id), holes);
    if (!walls.ok) return walls;
    const lengths: number[] = [];
    for (const [i, wall] of walls.value.entries()) {
      if (wall == null) return { ok: false, message: `${f.name} failed: the wall of hole ${i + 1} of ${hole.name} is not on ${ctx.bodyName(f.body)}` };
      let L = wall - clear;
      if (v.length != null) {
        if (v.length > L + 1e-9) return { ok: false, message: `${f.name} failed: a length of ${v.length} mm is more than hole ${i + 1} of ${hole.name} allows (${Math.round(L * 1000) / 1000} mm, ${blind ? 'a pitch short of its bottom' : 'inside its far face'})` };
        L = v.length;
      }
      if (!(L >= P)) return { ok: false, message: `${f.name} failed: hole ${i + 1} of ${hole.name} is too shallow for a thread of pitch ${P} mm` };
      if (L / P > THREAD_TURNS_MAX) return { ok: false, message: `${f.name} failed: ${Math.ceil(L / P)} turns of ${th.designation} is more than ${THREAD_TURNS_MAX}: give a shorter length` };
      lengths.push(L);
    }

    // ---- the grooves, then one cut
    const made: ShapeId[] = [];
    try {
      const probe = grooveSections(holes[0], rIn, R, P, 0, '');
      const regions = await kernelStep(f.name, () => ctx.kernel.call('sketch_regions', { plane: probe[0].plane, curves: probe[0].curves }));
      if (!regions.ok) return regions;
      const key = regions.value.result.regions[0]?.key;
      if (!key) return { ok: false, message: `${f.name} failed: the thread's profile made no region` };
      const tools: { shape: ShapeId; names: FaceNames }[] = [];
      for (const [i, h] of holes.entries()) {
        const lo = await kernelStep(f.name, () => ctx.kernel.call('loft_regions', { sections: grooveSections(h, rIn, R, P, lengths[i] / P, key), ruled: false }));
        if (!lo.ok) return lo;
        made.push(lo.value.result.id);
        if (lo.value.result.valid === false) return { ok: false, message: `${f.name} failed: the thread of hole ${i + 1} is not a valid solid` };
        const count = lo.value.result.faces ?? 0;
        tools.push({ shape: lo.value.result.id, names: { faces: Array.from({ length: count }, (_, k) => faceName(f.id, 'thread', `${i + 1}.${k}`)) } });
      }
      const cut = await kernelStep(f.name, () => ctx.kernel.call('boolean', { op: 'cut', targets: [body.shape], tools: tools.map((t) => t.shape) }));
      if (!cut.ok) return cut;
      const res = cut.value.result;
      if (res.valid === false) {
        await ctx.release([res.id]);
        return { ok: false, message: `${f.name} failed: cutting the thread gave an invalid solid${res.reason ? `: ${res.reason}` : ''}` };
      }
      // The kernel can answer a cut it could not do with the body unchanged: then say so, never "threaded".
      const vols = await kernelStep(f.name, () => Promise.all([body.shape, res.id].map(async (id) => (await ctx.kernel.call('props', { id, volume: true, bbox: 'none' })).result.volume ?? 0)));
      if (!vols.ok || !(vols.value[0] - vols.value[1] > 1e-6 * Math.max(1, vols.value[0]))) {
        await ctx.release([res.id]);
        return vols.ok ? { ok: false, message: `${f.name} failed: the kernel cut nothing (the thread's groove did not meet ${ctx.bodyName(f.body)}'s wall)` } : vols;
      }
      const names = namesFromResult(f.id, res, new Map<ShapeId, FaceNames | null>([[body.shape, body.names], ...tools.map((t) => [t.shape, t.names] as [ShapeId, FaceNames])]));
      return { ok: true, bodies: [{ id: f.body, shape: res.id, valid: true, names }], removed: [] };
    } finally {
      if (made.length) await ctx.release(made).catch(() => {});
    }
  },
};
