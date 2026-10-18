// The facts the Assistant's evaluation set scores (CAD tools spec §2.1 eval-facts, §12.5): the
// Part as it is built now, in raw numbers (mm, mm², mm³, degrees), for eval/score.mjs. The
// harness reads them through window.__CAD__.assistant.evalFacts(ask) after each turn; the vitest
// files read them through evalFacts(services, ask) on the real kernel.
//   params, features (state, message, each expression field evaluated), sketches (dof analysed
//   again by the solver apart from sketch mode, and their driving dimensions), bodies (exact:
//   volume, area, centre, box, solids, shells, voids), faces (type, area, centre, normal or axis
//   and radius; round faces as hole or boss, and for a hole how far its axis passes from the
//   centre of each flat face it opens into), the Part's health (the chip's words);
//   on request (`ask`, which eval/score.mjs factsAsk derives from a task's checks): pairs of
//   bodies (their overlap and their union's solids and voids), the union of every body, sections
//   (each piece's area, holes, centre and box, and the holes' boxes) and probe columns (a thin
//   square prism through the bodies at points of one body's section, `common` with each body,
//   then the intervals along the prism each body fills).
// Nothing here changes the Part; every kernel shape made here is released. A part that cannot be
// read (a kernel failure) goes into `errors`, never thrown, so a run still records what it got.
// evalSetParam is the parameter walk's one change (as the person's Parameters panel makes it);
// evalPicture the run's final picture (drawn off screen, as view draws it).
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { faceFrame, ydirOf } from '../features/sketch/plane';
import { statusOf } from '../sketch/dof';
import { evaluateDimensions, isDimension } from '../sketch/model';
import type { AppServices } from '../types/app';
import type { PlaneFrame, SketchDimension, SketchFeature, Vec3 } from '../types/doc';
import type { BodyInfo } from '../types/kernel';
import type { BBox, KernelOp, KernelParams, ShapeId } from '../types/kernel-protocol';
import { valuesOf } from './features-io';
import { healthOf } from './health';
import type { EvalAsk, EvalFace, EvalFacts, EvalSectionPiece } from './eval-types';
import { bodyFacts, overlapFacts } from './measure';
import { runtimeOf } from './runtime';
import { holeOrBoss } from './selectors/geometry';
import { topoCacheOf } from './selectors/topo-cache';
import { regionRows } from './sketch/regions';
import { encodePicture, LABEL_FONT_PX } from './view';

export type { EvalAsk, EvalBody, EvalFace, EvalFacts, EvalProbe, EvalProbeAsk, EvalSection, EvalSectionAsk, EvalSectionPiece } from './eval-types';

/** Faces listed (the rest counted): every face of the eval's parts fits. */
export const FACES_MAX = 2000;
/** Most probe columns per ask, and the column's side (mm). */
export const PROBE_COLUMNS = 16;
export const PROBE_SIZE = 0.2;

const sub = (a: readonly number[], b: readonly number[]): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: readonly number[], b: readonly number[]): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: readonly number[]) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: readonly number[]): Vec3 => {
  const l = norm(a);
  return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 1];
};
const words = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The distance from p to the line through `point` along `dir`. */
function axisDistance(axis: { point: readonly number[]; dir: readonly number[] }, p: readonly number[]): number {
  return norm(cross(sub(p, axis.point), unit(axis.dir)));
}

async function kcall<Op extends KernelOp>(services: AppServices, op: Op, params: KernelParams<Op>) {
  return services.kernel.call(op, params);
}

/** Free kernel shapes made here, unless their worker died meanwhile (its successor numbers its own). */
async function release(services: AppServices, ids: ShapeId[], epoch: number): Promise<void> {
  if (!ids.length || services.kernel.status.get().respawns !== epoch) return;
  try {
    await services.kernel.call('release', { ids });
  } catch {
    // The worker went: its shapes went with it.
  }
}

/** A plane through `origin` with `normal`, framed as a sketch on it would be. */
function planeOf(origin: readonly number[], normal: readonly number[]): PlaneFrame {
  return faceFrame(unit(normal), [origin[0], origin[1], origin[2]]);
}

const toModel = (plane: PlaneFrame, u: number, v: number): Vec3 => {
  const y = ydirOf(plane);
  return [plane.origin[0] + u * plane.xdir[0] + v * y[0], plane.origin[1] + u * plane.xdir[1] + v * y[1], plane.origin[2] + u * plane.xdir[2] + v * y[2]];
};

interface CutPiece extends EvalSectionPiece {
  /** Its shading triangles' centres (model mm), for the probe columns. */
  spots: Vec3[];
}

/** One shape cut by `plane`: every piece (material and holes) with its centre, box and triangles. */
async function cutShape(services: AppServices, shape: ShapeId, plane: PlaneFrame): Promise<{ loops: number; open: number; pieces: CutPiece[] }> {
  const cut = (await kcall(services, 'section', { plane, ids: [shape] })).result;
  const loops = cut.bodies[0]?.loops ?? [];
  const curves: unknown[] = [];
  let open = 0;
  for (const loop of loops) {
    if (!loop.closed) open++;
    for (const c of loop.curves) {
      const id = `s${curves.length}`;
      if (c.kind === 'line') curves.push({ id, kind: 'line', a: [...c.a], b: [...c.b] });
      else if (c.kind === 'arc') curves.push({ id, kind: 'arc', c: [...c.c], r: c.r, a0: c.a0, a1: c.a1, ccw: c.ccw });
      else if (c.kind === 'circle') curves.push({ id, kind: 'circle', c: [...c.c], r: c.r });
      else if (c.kind === 'bspline') curves.push({ id, kind: 'bspline', degree: c.degree, poles: c.poles.map((p) => [...p]), knots: [...c.knots], mults: [...c.mults], ...(c.weights ? { weights: [...c.weights] } : {}) });
    }
  }
  const closed = loops.length - open;
  if (!curves.length) return { loops: 0, open, pieces: [] };
  const reply = await kcall(services, 'sketch_regions', { plane, curves: curves as KernelParams<'sketch_regions'>['curves'], tess: true });
  const found = reply.result.regions;
  const uv = reply.buffers.tri_uv ? new Float32Array(reply.buffers.tri_uv) : new Float32Array(0);
  const idx = reply.buffers.tri_idx ? new Uint32Array(reply.buffers.tri_idx) : new Uint32Array(0);
  const ranges = reply.buffers.tri_ranges ? new Uint32Array(reply.buffers.tri_ranges) : new Uint32Array(0);
  const tri = new Map<string, { area: number; c: [number, number] }[]>();
  found.forEach((r, k) => {
    const start = ranges[2 * k] ?? 0;
    const count = ranges[2 * k + 1] ?? 0;
    const list: { area: number; c: [number, number] }[] = [];
    if (start + count <= idx.length) {
      for (let t = start; t + 2 < start + count; t += 3) {
        const [a, b, c] = [idx[t], idx[t + 1], idx[t + 2]];
        const ax = uv[2 * a];
        const ay = uv[2 * a + 1];
        const bx = uv[2 * b];
        const by = uv[2 * b + 1];
        const cx = uv[2 * c];
        const cy = uv[2 * c + 1];
        const area = Math.abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)) / 2;
        if (area > 0) list.push({ area, c: [(ax + bx + cx) / 3, (ay + by + cy) / 3] });
      }
    }
    tri.set(r.key, list);
  });
  const raw = new Map(found.map((r) => [r.key, r]));
  const rows = regionRows({ regions: found.map((r) => ({ ...r, tri: { uv: new Float32Array(0), idx: new Uint32Array(0) } })) });
  const pieces = rows.map((row): CutPiece => {
    const r = raw.get(row.key)!;
    const ts = tri.get(row.key) ?? [];
    const total = ts.reduce((s, t) => s + t.area, 0);
    const c = total > 0 ? ([ts.reduce((s, t) => s + t.area * t.c[0], 0) / total, ts.reduce((s, t) => s + t.area * t.c[1], 0) / total] as [number, number]) : null;
    return {
      depth: row.depth,
      area: r.area,
      holes: row.holes,
      centroid: c ? toModel(plane, c[0], c[1]) : null,
      bbox: [...r.bbox] as [number, number, number, number],
      sample: toModel(plane, r.sample[0], r.sample[1]),
      spots: ts.map((t) => toModel(plane, t.c[0], t.c[1])),
    };
  });
  return { loops: closed, open, pieces };
}

/** Up to `n` points spread over the material's triangles (every k-th), its inside points first. */
function columnPoints(pieces: readonly CutPiece[], n: number): Vec3[] {
  const material = pieces.filter((p) => p.depth % 2 === 0);
  const out: Vec3[] = material.map((p) => p.sample);
  const spots = material.flatMap((p) => p.spots);
  const room = Math.max(0, n - out.length);
  if (room > 0 && spots.length) {
    const step = spots.length / room;
    for (let k = 0; k < room && Math.floor(k * step) < spots.length; k++) out.push(spots[Math.floor(k * step)]);
  }
  return out.slice(0, n);
}

/** The intervals along `dir` (distances from `at`) that a shape fills: the loops of its cut by a plane holding the column. */
async function intervalsOf(services: AppServices, shape: ShapeId, at: Vec3, dir: Vec3): Promise<[number, number][]> {
  // A plane through the column's axis: its v runs along dir.
  const seed: Vec3 = Math.abs(dir[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const normal = unit(cross(dir, seed));
  const xdir = unit(cross(dir, normal));
  const plane: PlaneFrame = { origin: [...at], normal, xdir };
  const cut = (await kcall(services, 'section', { plane, ids: [shape] })).result;
  const ydir = ydirOf(plane);
  const sign = dot(ydir, dir) >= 0 ? 1 : -1;
  const out: [number, number][] = [];
  for (const loop of cut.bodies[0]?.loops ?? []) {
    let lo = Infinity;
    let hi = -Infinity;
    const take = (v: number) => {
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    };
    for (const c of loop.curves) {
      if (c.kind === 'line') {
        take(c.a[1]);
        take(c.b[1]);
      } else if (c.kind === 'circle' || c.kind === 'arc') {
        // Sampled along the curve (a column's walls are lines; a curved end is rare and small).
        const a0 = c.kind === 'arc' ? c.a0 : 0;
        const turn = (x: number) => ((x % 360) + 360) % 360;
        const sweep = c.kind === 'circle' ? 360 : c.ccw ? turn(c.a1 - a0) : -turn(a0 - c.a1);
        for (let k = 0; k <= 32; k++) take(c.c[1] + c.r * Math.sin(((a0 + (sweep * k) / 32) * Math.PI) / 180));
      } else if (c.kind === 'bspline') for (const p of c.poles) take(p[1]);
      else if (c.kind === 'point') take(c.p[1]);
    }
    if (lo <= hi) out.push(sign > 0 ? [lo, hi] : [-hi, -lo]);
  }
  out.sort((a, b) => a[0] - b[0]);
  return out;
}

/** One column: `common` of each body with the prism, then the intervals each fills. */
async function probeColumn(services: AppServices, bodies: readonly BodyInfo[], at: Vec3, dir: Vec3, size: number, span: [number, number]): Promise<Record<string, [number, number][]>> {
  const made: ShapeId[] = [];
  const epoch = services.kernel.status.get().respawns;
  try {
    // A square prism along dir from span[0] to span[1] (distances along dir from `at`): a box, so
    // only along X, Y or Z.
    const k = dir.findIndex((c) => Math.abs(Math.abs(c) - 1) < 1e-9);
    if (k < 0) throw new Error('a probe column runs along X, Y or Z');
    const lo: Vec3 = [at[0] - size / 2, at[1] - size / 2, at[2] - size / 2];
    lo[k] = at[k] + Math.min(span[0] * dir[k], span[1] * dir[k]);
    const dims: Vec3 = [size, size, size];
    dims[k] = Math.abs(span[1] - span[0]);
    const prism = (await kcall(services, 'box', { dx: dims[0], dy: dims[1], dz: dims[2], origin: lo, check: false })).result;
    made.push(prism.id);
    const out: Record<string, [number, number][]> = {};
    for (const b of bodies) {
      const common = (await kcall(services, 'boolean', { op: 'common', targets: [b.shape], tools: [prism.id], keep_tools: true, check: false })).result;
      made.push(common.id);
      out[b.name] = common.empty ? [] : await intervalsOf(services, common.id, at, dir);
    }
    return out;
  } finally {
    await release(services, made, epoch);
  }
}

/** The union of `bodies` as one shape (a copy; released by the caller), or the only body's own shape. */
async function joined(services: AppServices, bodies: readonly BodyInfo[], made: ShapeId[]): Promise<ShapeId> {
  if (bodies.length === 1) return bodies[0].shape;
  const r = (await kcall(services, 'boolean', { op: 'fuse', targets: [bodies[0].shape], tools: bodies.slice(1).map((b) => b.shape), keep_tools: true, check: false })).result;
  made.push(r.id);
  return r.id;
}

const findBody = (bodies: readonly BodyInfo[], name: string) => {
  const want = name.trim().toLowerCase();
  return bodies.find((b) => b.name.toLowerCase() === want) ?? null;
};

/** The Part's facts now (after its rebuild caught up), and what `ask` asks for. */
export async function evalFacts(services: AppServices, ask: EvalAsk = {}): Promise<EvalFacts> {
  const errors: string[] = [];
  try {
    await services.doc.settled();
  } catch (e) {
    errors.push(`the rebuild did not settle: ${words(e)}`);
  }
  const s = services.doc.state.get();
  const units = services.doc.units;
  const rt = runtimeOf(services);
  const evaluate = (expr: string): number | null => {
    for (const q of ['length', 'angle', 'scalar'] as const) {
      const r = units.evaluate(expr, q);
      if (r.ok) return r.value;
    }
    return null;
  };
  const facts: EvalFacts = {
    version: 1,
    units: { length: s.doc.units.length, angle: s.doc.units.angle },
    status: s.status,
    rebuild: { status: s.rebuild.status, message: s.rebuild.message ?? null },
    undo_label: s.history.undoLabel ?? null,
    params: s.doc.params.map((p) => {
      const r = units.evaluate(p.expr, p.quantity);
      return { name: p.name, kind: p.quantity === 'scalar' ? 'number' : p.quantity, expr: p.expr, value: r.ok ? r.value : null, ...(r.ok ? {} : { error: r.error }) };
    }),
    features: s.doc.features.map((f) => {
      const st = s.rebuild.features[f.id];
      return {
        name: f.name,
        type: f.type,
        state: f.suppressed ? 'suppressed' : (st?.state ?? 'pending'),
        message: st?.message ?? null,
        suppressed: !!f.suppressed,
        by_assistant: !!rt?.madeBy.has(f.id),
        values: valuesOf(f, services).map((v) => ({ field: v.field, expr: v.expr, value: evaluate(v.expr) })),
      };
    }),
    sketches: [],
    bodies: [],
    faces: [],
    faces_more: 0,
    pairs: [],
    union: null,
    sections: [],
    probes: [],
    health: { health: 'ok', words: [] },
    errors,
  };
  const health = healthOf(s);
  facts.health = { health: health.health, words: health.words };

  // Sketches: their definition now, from the solver apart from sketch mode (a stored state is never trusted).
  const solver = services.apis.get().solver;
  for (const f of s.doc.features) {
    if (f.type !== 'sketch') continue;
    const sk = f as SketchFeature;
    const ev = evaluateDimensions(sk, units);
    const dims = sk.constraints
      .filter((c) => isDimension(c) && (c as SketchDimension).driving)
      .map((c) => {
        const d = c as SketchDimension;
        return { id: d.id, kind: d.kind, expr: d.expr, value: typeof ev.values[d.id] === 'number' ? ev.values[d.id] : null };
      });
    const row = { name: sk.name, state: sk.solved.state, dof: sk.solved.dof as number | null, source: 'stored' as 'solver' | 'stored', conflicting: [] as string[], redundant: [] as string[], dims };
    if (solver && !Object.keys(ev.errors).length) {
      try {
        await solver.ready();
        const { solve, analysis } = await solver.analyzeFeature(sk, ev.values);
        const st = statusOf(solve, analysis);
        Object.assign(row, { state: st.state, dof: st.dof, source: 'solver', conflicting: [...st.conflicting], redundant: [...st.redundant] });
      } catch (e) {
        errors.push(`${sk.name}: the solver could not analyse it: ${words(e)}`);
      }
    }
    facts.sketches.push(row);
  }

  // Bodies, exact.
  const bodies = s.rebuild.bodies;
  for (const b of bodies) {
    try {
      const p = await bodyFacts(services, b);
      facts.bodies.push({
        name: b.name,
        color: b.color,
        valid: b.valid,
        volume: p.volume,
        area: p.area,
        centroid: p.centroid,
        bbox: p.bbox,
        solids: p.solids,
        shells: p.shells,
        voids: p.voids,
        faces: p.faces,
        edges: p.edges,
      });
    } catch (e) {
      errors.push(`${b.name}: ${words(e)}`);
    }
  }

  // Faces: what each is, round faces as holes or bosses, and where a hole sits on its flat faces.
  const cache = topoCacheOf(services);
  for (const b of bodies) {
    if (facts.faces.length >= FACES_MAX) {
      facts.faces_more += b.faces;
      continue;
    }
    try {
      const topo = await cache.topo(b.shape, { faces: b.faces });
      const diag = Math.hypot(b.bbox[3] - b.bbox[0], b.bbox[4] - b.bbox[1], b.bbox[5] - b.bbox[2]);
      const tess = b.tess ?? (await cache.tess(b.shape, Math.max(1, diag)));
      const flat = new Map(topo.faces.filter((f) => f.type === 'plane' && f.centroid).map((f) => [f.i, f.centroid as Vec3]));
      for (const f of topo.faces) {
        if (facts.faces.length >= FACES_MAX) {
          facts.faces_more++;
          continue;
        }
        const row: EvalFace = { body: b.name, i: f.i, type: f.type, area: f.area ?? null, centroid: f.centroid ? ([...f.centroid] as Vec3) : null };
        if (f.type === 'plane' && f.normal) row.normal = [...f.normal] as Vec3;
        if (f.axis) row.axis = { point: [...f.axis.origin] as Vec3, dir: [...f.axis.dir] as Vec3 };
        if (typeof f.radius === 'number') row.radius = f.radius;
        if (f.type === 'cylinder' || f.type === 'cone') {
          row.kind = holeOrBoss(tess, f.i, f);
          if (row.kind === 'hole' && row.axis) {
            const near = new Set<number>();
            for (const e of topo.edges) if (e.faces.includes(f.i)) for (const g of e.faces) if (g !== f.i && flat.has(g)) near.add(g);
            row.centred_mm = [...near].map((g) => axisDistance(row.axis!, flat.get(g)!)).sort((x, y) => x - y);
          }
        }
        facts.faces.push(row);
      }
    } catch (e) {
      errors.push(`${b.name}'s faces: ${words(e)}`);
    }
  }

  // Pairs: overlap and union.
  for (const [an, bn] of ask.pairs ?? []) {
    const a = findBody(bodies, an);
    const b = findBody(bodies, bn);
    if (!a || !b) {
      facts.pairs.push({ a: an, b: bn, overlap: null, union_solids: null, union_voids: null, distance: null, note: `no body named ${!a ? an : bn}` });
      continue;
    }
    try {
      const fa = facts.bodies.find((x) => x.name === a.name);
      const fb = facts.bodies.find((x) => x.name === b.name);
      const o = await overlapFacts(services, a, b, { a: fa?.solids ?? 1, b: fb?.solids ?? 1 });
      const d = (await kcall(services, 'measure', { a: { id: a.shape }, b: { id: b.shape } })).result;
      facts.pairs.push({ a: a.name, b: b.name, overlap: o.overlap, union_solids: o.unionSolids, union_voids: o.unionVoids, distance: d.distance ?? null, ...(o.note ? { note: o.note } : {}) });
    } catch (e) {
      errors.push(`${a.name} and ${b.name}: ${words(e)}`);
    }
  }

  // The union of every body.
  if (ask.union && bodies.length) {
    const made: ShapeId[] = [];
    const epoch = services.kernel.status.get().respawns;
    try {
      const id = await joined(services, bodies, made);
      const p = (await kcall(services, 'props', { id, volume: true, bbox: 'exact' })).result;
      facts.union = { solids: p.solids, shells: p.shells, voids: p.solids > 0 ? Math.max(0, p.shells - p.solids) : 0, volume: p.volume ?? 0, bbox: p.bbox ? ([...p.bbox] as BBox) : null };
    } catch (e) {
      errors.push(`the union of every body: ${words(e)}`);
    } finally {
      await release(services, made, epoch);
    }
  }

  // Sections.
  for (const sec of ask.sections ?? []) {
    const plane = planeOf(sec.origin, sec.normal);
    const made: ShapeId[] = [];
    const epoch = services.kernel.status.get().respawns;
    try {
      const of = sec.body === '*' ? [...bodies] : [findBody(bodies, sec.body)].filter((b): b is BodyInfo => !!b);
      if (!of.length) {
        errors.push(`section: no body named ${sec.body}`);
        continue;
      }
      const shape = await joined(services, of, made);
      const cut = await cutShape(services, shape, plane);
      const material = cut.pieces.filter((p) => p.depth % 2 === 0);
      facts.sections.push({
        body: sec.body,
        plane,
        area: material.reduce((sum, p) => sum + p.area, 0),
        loops: cut.loops,
        holes: material.reduce((sum, p) => sum + p.holes, 0),
        open: cut.open,
        pieces: cut.pieces.map(({ spots: _spots, ...p }) => p),
      });
    } catch (e) {
      errors.push(`section of ${sec.body}: ${words(e)}`);
    } finally {
      await release(services, made, epoch);
    }
  }

  // Probe columns.
  for (const pr of ask.probes ?? []) {
    const inner = findBody(bodies, pr.inner);
    const through = [...new Set([pr.inner, ...pr.bodies])].map((n) => findBody(bodies, n)).filter((b): b is BodyInfo => !!b);
    if (!inner) {
      errors.push(`probe: no body named ${pr.inner}`);
      continue;
    }
    try {
      const plane = planeOf(pr.origin, pr.normal);
      const dir = unit(pr.normal);
      const cut = await cutShape(services, inner.shape, plane);
      // The columns run past every body they go through.
      const all = through.map((b) => b.bbox);
      const lo = Math.min(...all.map((bb) => Math.min(dot([bb[0], bb[1], bb[2]], dir), dot([bb[3], bb[4], bb[5]], dir))));
      const hi = Math.max(...all.map((bb) => Math.max(dot([bb[0], bb[1], bb[2]], dir), dot([bb[3], bb[4], bb[5]], dir))));
      for (const at of columnPoints(cut.pieces, pr.columns ?? PROBE_COLUMNS)) {
        const here = dot(at, dir);
        const intervals = await probeColumn(services, through, at, dir, pr.size ?? PROBE_SIZE, [lo - here - 1, hi - here + 1]);
        facts.probes.push({ inner: inner.name, at, dir, intervals });
      }
    } catch (e) {
      errors.push(`probe through ${pr.inner}: ${words(e)}`);
    }
  }
  return facts;
}

/**
 * The parameter walk's change: parameter `name` set to `expr` as the person's Parameters panel
 * sets it (one undo step), then the rebuild caught up. Refused (with why) when there is no such
 * parameter or the Part refuses the value.
 */
export async function evalSetParam(services: AppServices, name: string, expr: string): Promise<{ ok: boolean; reason?: string }> {
  const p = services.doc.state.get().doc.params.find((x) => x.name === name);
  if (!p) return { ok: false, reason: `no parameter named ${name}` };
  const r = services.doc.editParams({ add: [], change: [{ id: p.id, patch: { expr } }], remove: [] }, `Set ${name}`);
  if (!r.ok) return { ok: false, reason: r.reason ?? 'refused' };
  try {
    await services.doc.settled();
  } catch (e) {
    return { ok: false, reason: `the rebuild did not settle: ${words(e)}` };
  }
  return { ok: true };
}

/** The run's last picture: the Part from iso, drawn off screen (the person's camera never moves), as base64; null with no 3D view. */
export async function evalPicture(services: AppServices, width = 1024, height = 768): Promise<{ mediaType: string; base64: string } | null> {
  const handle = services.viewport.get().handle;
  if (!handle?.snapshot) return null;
  const shot = handle.snapshot({ view: 'iso', width, height, hide: [], section: null });
  const pic = await encodePicture(shot.rgba, shot.width, shot.height, [], LABEL_FONT_PX.large);
  const bytes = new Uint8Array(await pic.data.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { mediaType: pic.mediaType, base64: btoa(bin) };
}
