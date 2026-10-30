// The assembly checks: does a mechanism hold together and turn? Shared by the person's panel and
// the Assistant's check tool (src/assistant/tools/check.ts): UI-free, on the geometry kernel and the
// bodies built now, raw numbers (mm, mm³, degrees; the callers round them), words for each finding.
//   interference  every pair of bodies (or of a chosen set, or one body against every other) whose
//                 boxes meet: the kernel's minimum distance, then for pairs that meet the volume
//                 they share (boolean common, props): rows of pairs that overlap and, with a
//                 clearance, of pairs closer than it, each with a point where. An overlap that is a
//                 thin ring round a line both bodies have round faces on (a bore drawn a little under
//                 its shaft) is a press fit, counted apart from the collisions;
//   stack         every axis two bodies share (round faces on one line) or a body's own bore (its
//                 centroid on the line, or its only such line when the material goes round it):
//                 the bodies near it cut by planes square to the axis between their faces (their
//                 vertices and each face's ends along it; slices.ts), so each slab between two cuts
//                 is one shape all along it. Near: within what the axis's parts reach (a frame plate
//                 by its bores there, not its far corner). A bore round a shaft within the play is
//                 held radially, the play measured along rays from the axis (a D or hex shaft in a
//                 bore of its shape); a bore no larger than its shaft is a press fit: the two are
//                 fixed together. Along the axis each part that rides on a shaft (or a shaft that
//                 turns in a frame: a body holding shafts on two axes or more) is moved each way
//                 until it meets another body (a shoulder, a collar, a spacer, a nut, the frame) or
//                 leaves its shaft. Findings: free to slide, slides more than the play before it
//                 meets something, nothing in its bore (not a frame's hole, nor a body held on
//                 another axis). With some bodies only, the axes near them (and a frame's other axes,
//                 to know it is one);
//   sweep         bodies turned about an axis a full turn, both ways, on the same slices: the first
//                 angle each meets another body, exact for parts made along the axis (extrusions,
//                 revolves) and to a slab's middle otherwise, then the kernel's overlap of the
//                 turned copy 1 degree past it (copies with a rigid transform, boolean common).
// Past SLABS_MAX levels on an axis the axis's own parts keep theirs and the others are thinned (said
// in the result: thinned).
// Kernel shapes made here are released (not after a worker restart: the next one numbers its own).
// Long checks report progress and stop at the signal; past the time limit a check stops and says
// how far it got: an axis it could not cut to the end is left out, never half read.
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { timeoutFor, timeoutForFaces } from '../../kernel/timeouts';
import type { Vec3 } from '../../types/doc';
import type { KernelAdapter, KernelReply } from '../../types/kernel';
import type { BBox, KernelOp, KernelParams, ShapeId, TopoResult } from '../../types/kernel-protocol';
import { boreOf, firstContact, fitGap, goesRound, overlaps, radialSet, sliceOf, spanOverlap, type Slice } from './slices';

/** A body as the checks read it (BodyInfo has all of it). */
export interface AssemblyBody {
  id: string;
  name: string;
  shape: ShapeId;
  bbox: BBox;
  faces: number;
  /** 0: a surface body (no volume to overlap); unknown when not measured. */
  solids?: number | null;
}

export interface CheckEnv {
  kernel: Pick<KernelAdapter, 'call' | 'status'>;
  signal?: AbortSignal;
  /** Progress: a fraction (null when unknown) and what it does now. */
  progress?: (fraction: number | null, label: string) => void;
  /** Stop after this long (ms) and say so; checkClock.limitMs (CHECK_TIME_MS) by default. */
  timeLimitMs?: number;
  now?: () => number;
}

/** A kernel call that failed: its op and the kernel's words. */
export class CheckKernelError extends Error {
  constructor(
    readonly op: KernelOp,
    message: string,
  ) {
    super(message);
  }
}

/** How long a check may run before it stops and says how far it got (ms). */
export const CHECK_TIME_MS = 90_000;
/** The time limit a check takes when none is given (ms): CHECK_TIME_MS; an e2e shortens it (window.__CAD__.assemblyCheck). */
export const checkClock = { limitMs: CHECK_TIME_MS };
/** Two bodies closer than this (mm) meet. */
export const TOUCH_MM = 5e-5;
/** A shared volume below this (mm³) is a touch, not an overlap. */
export const OVERLAP_MIN_MM3 = 1e-3;
/** The play (mm, radial and along the axis) a part may have and still count as held, when none is given. */
export const PLAY_MM = 0.5;
/** A bore no larger than its shaft by this (mm) is a press fit: the two are fixed together. */
export const PRESS_MM = 1e-3;
/** An overlap that is a ring round both bodies' axis no thicker than this (mm) is a press fit (interference). */
export const PRESS_RING_MM = 0.25;
/** Two round faces on lines this close (mm) and this parallel (sine of the angle) share an axis. */
export const AXIS_MM = 0.02;
const AXIS_SIN = 1e-4;
/** Most slabs one axis is cut into. */
export const SLABS_MAX = 400;
/** Levels closer than this (mm) along an axis are one. */
const LEVEL_MM = 1e-4;
/** The sweep's kernel check: the copy is turned this far past the contact (degrees). */
export const SWEEP_PAST_DEG = 1;
/** Shapes made before they are released together. */
const RELEASE_BATCH = 64;
/** Most hits the sweep checks with the kernel. */
const SWEEP_CONFIRM_MAX = 12;

// ------------------------------------------------------------------ small vector helpers

const sub = (a: readonly number[], b: readonly number[]): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: readonly number[], b: readonly number[]): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: readonly number[], k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: readonly number[], b: readonly number[]): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: readonly number[]) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: readonly number[]): Vec3 => scale(a, 1 / (norm(a) || 1));

/** An axis line: a unit direction (its largest component positive) through the point nearest the origin. */
export interface AxisLine {
  point: Vec3;
  dir: Vec3;
}

/** The canonical line through `origin` along `dir`. */
export function axisLine(origin: readonly number[], dir: readonly number[]): AxisLine {
  let d = unit(dir);
  const big = [0, 1, 2].reduce((m, k) => (Math.abs(d[k]) > Math.abs(d[m]) ? k : m), 0);
  if (d[big] < 0) d = scale(d, -1);
  const p = sub(origin, scale(d, dot(origin, d)));
  return { point: p.map((x) => (Math.abs(x) < 1e-12 ? 0 : x)) as Vec3, dir: d.map((x) => (Math.abs(x) < 1e-15 ? 0 : x)) as Vec3 };
}

/** Where `p` lies along the axis (mm from its point). */
const along = (ax: AxisLine, p: readonly number[]) => dot(sub(p, ax.point), ax.dir);
/** How far `p` lies from the axis (mm). */
const off = (ax: AxisLine, p: readonly number[]) => {
  const v = sub(p, ax.point);
  return norm(sub(v, scale(ax.dir, dot(v, ax.dir))));
};

const sameLine = (a: AxisLine, b: AxisLine) => norm(cross(a.dir, b.dir)) < AXIS_SIN && off(a, b.point) < AXIS_MM;

/** "+Z" / "-Z" along an axis of the model, else the direction's numbers (and "the other way"). */
export function sideWords(ax: AxisLine, side: 1 | -1): string {
  const k = [0, 1, 2].find((i) => Math.abs(Math.abs(ax.dir[i]) - 1) < 1e-9);
  if (k !== undefined) return `${side > 0 ? '+' : '-'}${'XYZ'[k]}`;
  const d = scale(ax.dir, side).map((x) => Math.round(x * 1e4) / 1e4 || 0);
  return `(${d.join(', ')})`;
}

/** The axis in words: "along Z through (0, 0, 0)". */
export function axisWords(ax: AxisLine): string {
  const k = [0, 1, 2].find((i) => Math.abs(Math.abs(ax.dir[i]) - 1) < 1e-9);
  const p = ax.point.map((x) => Math.round(x * 1e4) / 1e4 || 0);
  return `${k !== undefined ? `along ${'XYZ'[k]}` : `along (${ax.dir.map((x) => Math.round(x * 1e4) / 1e4 || 0).join(', ')})`} through (${p.join(', ')})`;
}

/** The plane square to the axis at `s` along it (u, v: the slices' own coordinates). */
function frameAt(ax: AxisLine, s: number) {
  const seed: Vec3 = Math.abs(ax.dir[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = unit(sub(seed, scale(ax.dir, dot(seed, ax.dir))));
  return { origin: add(ax.point, scale(ax.dir, s)), normal: [...ax.dir] as Vec3, xdir: u, v: cross(ax.dir, u) };
}

/**
 * A box's span along the axis and its nearest and farthest distance from it: the nearest is the
 * distance from the axis to the box's outline seen along the axis (the hull of its corners there).
 */
function boxAbout(ax: AxisLine, b: BBox): { s0: number; s1: number; rNear: number; rFar: number } {
  let s0 = Infinity;
  let s1 = -Infinity;
  let rFar = 0;
  const f = frameAt(ax, 0);
  const flat: [number, number][] = [];
  for (let i = 0; i < 8; i++) {
    const p: Vec3 = [i & 1 ? b[3] : b[0], i & 2 ? b[4] : b[1], i & 4 ? b[5] : b[2]];
    const s = along(ax, p);
    s0 = Math.min(s0, s);
    s1 = Math.max(s1, s);
    rFar = Math.max(rFar, off(ax, p));
    const q = sub(p, ax.point);
    flat.push([dot(q, f.xdir), dot(q, f.v)]);
  }
  return { s0, s1, rNear: hullDistance(flat), rFar };
}

/** The distance from (0, 0) to the convex hull of `pts` (0 inside it). */
function hullDistance(pts: [number, number][]): number {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const turn = (o: number[], a: number[], c: number[]) => (a[0] - o[0]) * (c[1] - o[1]) - (a[1] - o[1]) * (c[0] - o[0]);
  const half = (list: [number, number][]) => {
    const h: [number, number][] = [];
    for (const q of list) {
      while (h.length >= 2 && turn(h[h.length - 2], h[h.length - 1], q) <= 1e-12) h.pop();
      h.push(q);
    }
    h.pop();
    return h;
  };
  const hull = [...half(p), ...half([...p].reverse())];
  if (hull.length < 3) {
    // Seen end on: a point or a segment.
    let d = Infinity;
    for (let i = 0; i < p.length; i++) for (let j = i; j < p.length; j++) d = Math.min(d, segDistance(p[i], p[j]));
    return d;
  }
  let inside = true;
  let d = Infinity;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const c = hull[(i + 1) % hull.length];
    if (turn(a, c, [0, 0]) < 0) inside = false;
    d = Math.min(d, segDistance(a, c));
  }
  return inside ? 0 : d;
}

/** The distance from (0, 0) to the segment a-c. */
function segDistance(a: [number, number], c: [number, number]): number {
  const dx = c[0] - a[0];
  const dy = c[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 < 1e-24 ? 0 : Math.max(0, Math.min(1, -(a[0] * dx + a[1] * dy) / l2));
  return Math.hypot(a[0] + t * dx, a[1] + t * dy);
}

// ------------------------------------------------------------------ the kernel, the clock, the stop

class Run {
  private readonly made: ShapeId[] = [];
  private readonly epoch: number;
  private readonly start: number;
  private readonly now: () => number;
  private readonly limit: number;
  /** Set when the time limit stopped the check. */
  timedOut = false;

  constructor(readonly env: CheckEnv) {
    this.epoch = env.kernel.status.get().respawns;
    this.now = env.now ?? (() => performance.now());
    this.start = this.now();
    this.limit = env.timeLimitMs ?? checkClock.limitMs;
  }

  /** Throws the signal's stop when it aborted. */
  stopCheck(): void {
    const s = this.env.signal;
    if (s?.aborted) throw s.reason ?? new DOMException('The check was stopped.', 'AbortError');
  }

  /** True once the time limit is past (the check stops where it is and says so). */
  overTime(): boolean {
    if (this.now() - this.start > this.limit) this.timedOut = true;
    return this.timedOut;
  }

  progress(fraction: number | null, label: string): void {
    this.env.progress?.(fraction, label);
  }

  async call<Op extends KernelOp>(op: Op, params: KernelParams<Op>, what: string, faces = 0): Promise<KernelReply<Op>> {
    this.stopCheck();
    try {
      return await this.env.kernel.call(op, params, { timeoutMs: timeoutForFaces(op, faces) ?? timeoutFor(op) });
    } catch (e) {
      this.stopCheck();
      throw new CheckKernelError(op, `The geometry kernel could not ${what}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** A shape made here, to release at the end. */
  keep(id: ShapeId): ShapeId {
    this.made.push(id);
    return id;
  }

  /** Release the shapes made so far once there are RELEASE_BATCH of them. */
  async trim(): Promise<void> {
    if (this.made.length >= RELEASE_BATCH) await this.release();
  }

  async release(ids?: ShapeId[]): Promise<void> {
    const list = ids ?? this.made.splice(0);
    if (ids) {
      for (const id of ids) {
        const k = this.made.indexOf(id);
        if (k >= 0) this.made.splice(k, 1);
      }
    }
    if (!list.length || this.env.kernel.status.get().respawns !== this.epoch) return;
    try {
      await this.env.kernel.call('release', { ids: list });
    } catch {
      // The worker was respawned: its shapes are gone anyway.
    }
  }
}

// ------------------------------------------------------------------ interference

export interface InterferenceRow {
  a: string;
  b: string;
  /** The volume they share (mm³), or null for a pair that only comes close. */
  overlap: number | null;
  /** The overlap is a thin ring round a line both have round faces on: a bore drawn under its shaft (a press fit), not a collision. */
  press: boolean;
  /** Their distance (mm) when they do not overlap: below the clearance (0: they touch). */
  gap: number | null;
  /** Where: the middle of what they share, or halfway between their nearest points. */
  at: Vec3;
}

export interface InterferenceResult {
  bodies: number;
  /** The one body checked against every other, or null (every pair of the bodies). */
  one: string | null;
  /** Every pair of the bodies (with one: each other body with it). */
  pairs: number;
  /** Pairs whose boxes (grown by the clearance) meet: the ones measured. */
  boxPairs: number;
  /** Of those, how many were measured before the end (all, unless the time limit stopped it). */
  checked: number;
  /** Overlaps first (largest first; press fits after the collisions), then gaps (smallest first). */
  rows: InterferenceRow[];
  /** Pairs that touch without overlapping. */
  touching: number;
  /** Surface bodies (no volume to overlap), left out. */
  surfaces: string[];
  complete: boolean;
}

/** Pairs of boxes that meet when grown by `grow` (sweep and prune along x). */
function boxPairs(bodies: readonly AssemblyBody[], grow: number): [number, number][] {
  const idx = bodies.map((_, i) => i).sort((p, q) => bodies[p].bbox[0] - bodies[q].bbox[0]);
  const out: [number, number][] = [];
  for (let a = 0; a < idx.length; a++) {
    const A = bodies[idx[a]].bbox;
    for (let b = a + 1; b < idx.length; b++) {
      const B = bodies[idx[b]].bbox;
      if (B[0] - grow > A[3] + grow) break;
      if (B[1] - grow > A[4] + grow || A[1] - grow > B[4] + grow || B[2] - grow > A[5] + grow || A[2] - grow > B[5] + grow) continue;
      out.push(idx[a] < idx[b] ? [idx[a], idx[b]] : [idx[b], idx[a]]);
    }
  }
  return out.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
}

/** A little room round a box, for boxes read from a tessellation (mm). */
const boxSlack = (bodies: readonly AssemblyBody[]) => {
  let size = 0;
  for (const b of bodies) size = Math.max(size, Math.hypot(b.bbox[3] - b.bbox[0], b.bbox[4] - b.bbox[1], b.bbox[5] - b.bbox[2]));
  return 0.01 + 1e-4 * size;
};

/** Every pair of `bodies` that overlaps, or (clearance > 0) comes closer than `clearance` mm; with `one` (an index), only the pairs with that body. */
export async function checkInterference(env: CheckEnv, bodies: readonly AssemblyBody[], o: { clearance: number; one?: number }): Promise<InterferenceResult> {
  const run = new Run(env);
  const surfaces = bodies.filter((b) => b.solids === 0).map((b) => b.name);
  const solid = bodies.filter((b) => b.solids !== 0);
  const one = o.one === undefined ? null : bodies[o.one];
  const k = one ? solid.indexOf(one) : -1;
  const pairs = boxPairs(solid, o.clearance + boxSlack(solid)).filter(([i, j]) => !one || i === k || j === k);
  const rows: InterferenceRow[] = [];
  const topo = new Map<string, BodyTopo>();
  let touching = 0;
  let checked = 0;
  try {
    for (const [i, j] of pairs) {
      if (run.overTime()) break;
      run.progress(pairs.length ? checked / pairs.length : null, `Checking ${solid[i].name} and ${solid[j].name}`);
      const a = solid[i];
      const b = solid[j];
      const faces = a.faces + b.faces;
      const m = (await run.call('measure', { a: { id: a.shape }, b: { id: b.shape } }, `measure ${a.name} against ${b.name}`, faces)).result;
      const d = m.distance ?? 0;
      const mid: Vec3 = m.p1 && m.p2 ? scale(add(m.p1, m.p2), 0.5) : [0, 0, 0];
      if (d > TOUCH_MM) {
        if (d < o.clearance) rows.push({ a: a.name, b: b.name, overlap: null, press: false, gap: d, at: mid });
        checked++;
        continue;
      }
      // They meet: what do they share?
      const common = (await run.call('boolean', { op: 'common', targets: [a.shape], tools: [b.shape], keep_tools: true }, `intersect ${a.name} with ${b.name}`, faces)).result;
      run.keep(common.id);
      let volume = 0;
      let at = mid;
      if (!common.empty) {
        const p = (await run.call('props', { id: common.id, volume: true, bbox: 'none' }, `measure what ${a.name} and ${b.name} share`, faces)).result;
        volume = Math.max(0, p.volume ?? 0);
        if (p.centroid) at = [...p.centroid] as Vec3;
      }
      const press = volume > OVERLAP_MIN_MM3 && (await pressRing(run, a, b, common.id, topo));
      // Released in batches: one call less per pair that meets.
      await run.trim();
      if (volume > OVERLAP_MIN_MM3) rows.push({ a: a.name, b: b.name, overlap: volume, press, gap: null, at });
      else {
        touching++;
        if (o.clearance > 0) rows.push({ a: a.name, b: b.name, overlap: null, press: false, gap: 0, at: mid });
      }
      checked++;
    }
  } finally {
    await run.release();
  }
  const rank = (x: InterferenceRow) => (x.overlap === null ? 2 : x.press ? 1 : 0);
  rows.sort((p, q) => rank(p) - rank(q) || (q.overlap ?? -1) - (p.overlap ?? -1) || (p.gap ?? 0) - (q.gap ?? 0));
  const n = solid.length;
  return { bodies: bodies.length, one: one?.name ?? null, pairs: one ? Math.max(0, n - 1) : (n * (n - 1)) / 2, boxPairs: pairs.length, checked, rows, touching, surfaces, complete: checked === pairs.length };
}

/**
 * Whether what two bodies share (`common`) is a press fit: a ring round a line both have round faces
 * on, no thicker than PRESS_RING_MM (a bore drawn a little under its shaft). The ring's round faces
 * lie on that line, and all its corners between their radii.
 */
async function pressRing(run: Run, a: AssemblyBody, b: AssemblyBody, common: ShapeId, topo: Map<string, BodyTopo>): Promise<boolean> {
  await topoAll(run, [a, b], topo, 'Reading round faces');
  const lines = (topo.get(a.id)?.round ?? []).filter((f) => (topo.get(b.id)?.round ?? []).some((g) => sameLine(f.line, g.line))).map((f) => f.line);
  if (!lines.length) return false;
  const t = topoOf((await run.call('topo', { id: common, faces: 'all', edges: 'none', vertices: 'all', face_bbox: 'none', face_mass: false }, `read what ${a.name} and ${b.name} share`, a.faces + b.faces)).result);
  return lines.some((line) => {
    const radii = t.round.filter((f) => sameLine(f.line, line)).map((f) => f.r);
    if (radii.length < 2) return false;
    const r0 = Math.min(...radii);
    const r1 = Math.max(...radii);
    return r1 - r0 <= PRESS_RING_MM && t.vertices.every((p) => off(line, p) >= r0 - AXIS_MM && off(line, p) <= r1 + AXIS_MM);
  });
}

// ------------------------------------------------------------------ axes and slices

interface BodyTopo {
  /** Round faces: radius, axis line and the face's box. */
  round: { r: number; line: AxisLine; box: BBox | null }[];
  /** Every vertex. */
  vertices: Vec3[];
  /** Each face's box (the kernel's fast one): where a face starts and ends along an axis. */
  boxes: BBox[];
}

/** A shape's round faces, vertices and face boxes. */
function topoOf(t: TopoResult): BodyTopo {
  const round = t.faces.filter((f) => f.type === 'cylinder' && f.axis && typeof f.radius === 'number').map((f) => ({ r: f.radius!, line: axisLine(f.axis!.origin, f.axis!.dir), box: f.bbox ?? null }));
  return { round, vertices: t.vertices.map((v) => [...v.p] as Vec3), boxes: t.faces.map((f) => f.bbox).filter((b): b is BBox => !!b) };
}

/** Each body's round faces, vertices and face boxes (one kernel topo call each, kept for the check). */
async function topoAll(run: Run, bodies: readonly AssemblyBody[], cache: Map<string, BodyTopo>, label: string): Promise<void> {
  let n = 0;
  for (const b of bodies) {
    n++;
    if (cache.has(b.id)) continue;
    run.progress(n / bodies.length, label);
    const t: TopoResult = (await run.call('topo', { id: b.shape, faces: 'all', edges: 'none', vertices: 'all', face_bbox: 'fast', face_mass: false }, `read the faces of ${b.name}`, b.faces)).result;
    cache.set(b.id, topoOf(t));
  }
}

/** A box's span along the axis. */
function spanAlong(ax: AxisLine, b: BBox): [number, number] {
  let s0 = Infinity;
  let s1 = -Infinity;
  for (let i = 0; i < 8; i++) {
    const s = along(ax, [i & 1 ? b[3] : b[0], i & 2 ? b[4] : b[1], i & 4 ? b[5] : b[2]]);
    s0 = Math.min(s0, s);
    s1 = Math.max(s1, s);
  }
  return [s0, s1];
}

/**
 * Where bodies' shapes change along the axis: their vertices, then each face's ends (a rod lying
 * across the axis has no vertex at its lowest line; exact along X, Y and Z, the fast boxes padded by
 * the tolerance, so a vertex wins over a face's end beside it).
 */
function levelsAlong(ax: AxisLine, list: readonly (BodyTopo | undefined)[]): number[][] {
  const at = list.flatMap((t) => t?.vertices.map((p) => along(ax, p)) ?? []);
  const ends = list.flatMap((t) => t?.boxes.flatMap((b) => spanAlong(ax, b)) ?? []);
  return [at, ends];
}

/** An axis bodies share (or one body's own): its line and the bodies with round faces on it. */
export interface SharedAxis {
  line: AxisLine;
  /** Indices into the bodies, in order. */
  members: number[];
}

/** The lines of every round face, grouped: each with the bodies that have a round face on it. */
function groupAxes(bodies: readonly AssemblyBody[], topo: Map<string, BodyTopo>): SharedAxis[] {
  const out: SharedAxis[] = [];
  bodies.forEach((b, i) => {
    for (const f of topo.get(b.id)?.round ?? []) {
      const g = out.find((x) => sameLine(x.line, f.line));
      if (!g) out.push({ line: f.line, members: [i] });
      else if (!g.members.includes(i)) g.members.push(i);
    }
  });
  return out;
}

/** Every line a round face of the bodies lies on, each with the bodies that have one there (one body's own too). */
export async function roundAxes(env: CheckEnv, bodies: readonly AssemblyBody[]): Promise<SharedAxis[]> {
  const run = new Run(env);
  const topo = new Map<string, BodyTopo>();
  await topoAll(run, bodies, topo, 'Reading round faces');
  return groupAxes(bodies, topo);
}

/** The axes two bodies or more share (shafts in bores, wheels on shafts), each with its bodies. */
export async function sharedAxes(env: CheckEnv, bodies: readonly AssemblyBody[]): Promise<SharedAxis[]> {
  return (await roundAxes(env, bodies)).filter((g) => g.members.length >= 2);
}

/** One slab between two cuts along an axis, and each body's slice through its middle. */
interface Slab {
  s0: number;
  s1: number;
  slices: Map<number, Slice>;
}

/**
 * The levels along the axis where the bodies' shapes change, within [lo, hi], at most SLABS_MAX
 * slabs: `tiers` in order of need (the axis's own parts, then bodies at the axis, then the rest),
 * each in parts (vertices, then faces' ends), each part kept whole while it fits, the first that
 * does not thinned evenly and the later ones left out. thinned: some level was left out; lost: one
 * of the first tier's own.
 */
function levelsOf(tiers: readonly (readonly (readonly number[])[])[], lo: number, hi: number): { levels: number[]; thinned: boolean; lost: boolean } {
  const kept: number[] = [];
  let thinned = false;
  let lost = false;
  tiers.forEach((parts, t) => parts.forEach((tier) => {
    const s = tier.filter((x) => x > lo + LEVEL_MM && x < hi - LEVEL_MM).sort((a, b) => a - b);
    const have = [...kept].sort((a, b) => a - b);
    const fresh: number[] = [];
    let j = 0;
    for (const x of s) {
      while (j < have.length && have[j] < x - LEVEL_MM) j++;
      if (j < have.length && Math.abs(have[j] - x) <= LEVEL_MM) continue;
      if (fresh.length && x - fresh[fresh.length - 1] <= LEVEL_MM) continue;
      fresh.push(x);
    }
    const room = SLABS_MAX - 1 - kept.length;
    if (fresh.length <= room) kept.push(...fresh);
    else {
      thinned = true;
      if (t === 0) lost = true;
      const step = fresh.length / Math.max(1, room);
      for (let i = 0; i < room; i++) kept.push(fresh[Math.floor(i * step)]);
    }
  }));
  return { levels: [lo, ...kept.sort((a, b) => a - b), hi], thinned, lost };
}

/** The bodies `idx` cut through the middle of each slab between `levels` (one kernel section per slab). */
async function slabsOf(run: Run, ax: AxisLine, bodies: readonly AssemblyBody[], idx: readonly number[], levels: readonly number[], label: string, from: number, share: number): Promise<Slab[]> {
  const out: Slab[] = [];
  const faces = idx.reduce((n, i) => n + bodies[i].faces, 0);
  const n = levels.length - 1;
  for (let k = 0; k < n; k++) {
    if (run.overTime()) break;
    run.progress(from + (share * k) / Math.max(1, n), label);
    const s0 = levels[k];
    const s1 = levels[k + 1];
    const f = frameAt(ax, (s0 + s1) / 2);
    const r = (await run.call('section', { plane: { origin: f.origin, normal: f.normal, xdir: f.xdir }, ids: idx.map((i) => bodies[i].shape) }, 'cut the bodies across their axis', faces)).result;
    const slices = new Map<number, Slice>();
    r.bodies.forEach((b, j) => {
      if (!b.loops.length) return;
      const sl = sliceOf(b.loops);
      if (sl.loops.length) slices.set(idx[j], sl);
    });
    out.push({ s0, s1, slices });
  }
  return out;
}

/** The bodies whose boxes come within `reach` of the axis (and along it within [lo, hi] when given). */
function nearAxis(ax: AxisLine, bodies: readonly AssemblyBody[], reach: number, span?: [number, number]): number[] {
  const out: number[] = [];
  bodies.forEach((b, i) => {
    const r = boxAbout(ax, b.bbox);
    if (r.rNear > reach) return;
    if (span && (r.s1 < span[0] || r.s0 > span[1])) return;
    out.push(i);
  });
  return out;
}

// ------------------------------------------------------------------ stack

/** What stops a part along its axis on one side. */
export interface StackSide {
  /** The body it meets, or null: nothing (it slides off, or on for ever). */
  by: string | null;
  /** How far it moves before it meets it (mm); null with nothing. */
  gap: number | null;
  /** It leaves the shaft it rides on before meeting anything. */
  off: boolean;
}

export interface StackPart {
  body: string;
  /** Its span along the axis (mm from the axis point). */
  from: number;
  to: number;
  /** The radius of its bore round the axis, when it has one. */
  bore: number | null;
  /** What holds it radially: the shaft it rides on, or the bore it turns in; null when nothing. */
  on: string | null;
  /** In a frame's bore (the shaft turns in it) rather than on a shaft. */
  inBore: boolean;
  /** The radial play there (mm; bore minus shaft). */
  play: number | null;
  /** The bodies fixed to it by a press fit (a bore no larger than its shaft). */
  fixed: string[];
  /** Along the axis, each side: null when this part is not checked (a shaft, a frame). */
  neg: StackSide | null;
  pos: StackSide | null;
}

export interface StackAxis {
  line: AxisLine;
  words: string;
  /** The direction words of each side ("-Z", "+Z"). */
  negWords: string;
  posWords: string;
  /** The bodies there in order along it. */
  parts: StackPart[];
}

export interface StackFinding {
  body: string;
  /** Index into axes. */
  axis: number;
  /** free: nothing stops it on a side; slides: it moves more than the play first; bore: nothing holds it radially. */
  kind: 'free' | 'slides' | 'bore';
  side: 'neg' | 'pos' | null;
  /** slides: how far (mm). */
  gap: number | null;
  words: string;
}

export interface StackResult {
  /** The axes checked to the end (an axis the time limit cut short is left out). */
  axes: StackAxis[];
  /** The axes there were to check (all of them, or those near the bodies asked about). */
  axesTotal: number;
  findings: StackFinding[];
  /** The play counted as held (mm). */
  play: number;
  /** Some axis had more levels than SLABS_MAX: others' were left out, so a thin part away from its own may be missed. */
  thinned: boolean;
  complete: boolean;
}

/** Disjoint sets of body indices (press fits join them). */
class Groups {
  private readonly parent = new Map<number, number>();
  root(i: number): number {
    let r = i;
    while ((this.parent.get(r) ?? r) !== r) r = this.parent.get(r)!;
    this.parent.set(i, r);
    return r;
  }
  join(a: number, b: number): void {
    const ra = this.root(a);
    const rb = this.root(b);
    if (ra !== rb) this.parent.set(Math.max(ra, rb), Math.min(ra, rb));
  }
}

/** A bore round a shaft in one slab: the outer body, the inner one, the radial play. */
interface Fit {
  outer: number;
  inner: number;
  play: number;
  slab: number;
}

/** The nearest thing inside a bore: its body, its largest radius there, and the gap between them (mm). */
interface Inside {
  body: number;
  r: number;
  gap: number;
}

/** What one axis holds: its slabs, its fits, its bores with nothing in them. */
interface AxisWork {
  ax: AxisLine;
  members: number[];
  idx: number[];
  slabs: Slab[];
  fits: Fit[];
  /** Members with a bore here that no shaft holds: the bore and the nearest thing inside it. */
  empty: { body: number; bore: number; nearest: Inside | null }[];
  /** Levels were left out (too many): thin parts away from the axis's own may be missed. */
  thinned: boolean;
}

/**
 * The fits of one slab: each bore with the nearest thing inside it that goes round the axis, within
 * the play. The play is the gap along rays from the axis (slices.ts fitGap): a D or hex shaft in a
 * bore of its shape has its clearance, though the largest circle in the bore is smaller than the
 * smallest round the shaft. Slices that share material are a press fit.
 */
function fitsOf(slab: Slab, k: number, play: number, members: ReadonlySet<number>, empty: Map<number, { bore: number; nearest: Inside | null }>): Fit[] {
  const out: Fit[] = [];
  for (const [o, so] of slab.slices) {
    const bore = boreOf(so);
    if (bore === null) continue;
    let best: Inside | null = null;
    for (const [x, sx] of slab.slices) {
      if (x === o || !goesRound(sx)) continue;
      let r = -Infinity;
      for (const [a, b] of radialSet(sx)) if (a < bore - 1e-7) r = Math.max(r, b);
      if (r === -Infinity) continue;
      // Between two circles: a lower bound (the bore's edge is no nearer than `bore`, the material inside no farther than r).
      const circles = bore - r;
      const gap = overlaps(so, sx) ? Math.min(circles, 0) : Math.max(circles, fitGap(so, sx) ?? circles);
      if (!best || gap < best.gap) best = { body: x, r, gap };
    }
    if (best && best.gap <= play) out.push({ outer: o, inner: best.body, play: best.gap, slab: k });
    else if (members.has(o)) {
      const was = empty.get(o);
      if (!was || (best && (!was.nearest || best.gap < was.nearest.gap))) empty.set(o, { bore, nearest: best });
    }
  }
  return out;
}

/** One axis to cut: its line and members, how far from it its parts reach, and the bodies near it. */
interface AxisPlan {
  g: SharedAxis;
  reach: number;
  idx: number[];
}

/** The bodies near one axis, cut into slabs, and the fits there; null when the time limit stopped it before its last slab. */
async function axisWork(run: Run, bodies: readonly AssemblyBody[], topo: Map<string, BodyTopo>, plan: AxisPlan, play: number, from: number, share: number): Promise<AxisWork | null> {
  const { g, idx } = plan;
  const ax = g.line;
  let lo = Infinity;
  let hi = -Infinity;
  for (const i of idx) {
    const r = boxAbout(ax, bodies[i].bbox);
    lo = Math.min(lo, r.s0);
    hi = Math.max(hi, r.s1);
  }
  // The axis's own parts keep every level; then the bodies at the axis (a pin across it); then the rest.
  const members = new Set(g.members);
  const core = axisCore(topo, bodies, g);
  const atAxis = (i: number) => boxAbout(ax, bodies[i].bbox).rNear <= core;
  const tier = (pick: (i: number) => boolean) => levelsAlong(ax, idx.filter(pick).map((i) => topo.get(bodies[i].id)));
  const { levels, thinned } = levelsOf([tier((i) => members.has(i)), tier((i) => !members.has(i) && atAxis(i)), tier((i) => !members.has(i) && !atAxis(i))], lo, hi);
  const slabs = await slabsOf(run, ax, bodies, idx, levels, `Cutting the bodies ${axisWords(ax)}`, from, share);
  if (slabs.length < levels.length - 1) return null;
  const empty = new Map<number, { bore: number; nearest: Inside | null }>();
  const fits = slabs.flatMap((s, k) => fitsOf(s, k, play, members, empty));
  const outers = new Set(fits.map((f) => f.outer));
  return { ax, members: g.members, idx, slabs, fits, empty: [...empty].filter(([b]) => !outers.has(b)).map(([body, e]) => ({ body, ...e })), thinned };
}

/** The smallest round face the axis's members have on it (a shaft, a bore): a body whose box comes within it is at the axis. */
function axisCore(topo: Map<string, BodyTopo>, bodies: readonly AssemblyBody[], g: SharedAxis): number {
  let r = Infinity;
  for (const m of g.members) for (const f of topo.get(bodies[m].id)?.round ?? []) if (sameLine(f.line, g.line)) r = Math.min(r, f.r);
  return Number.isFinite(r) ? r : 0;
}

/**
 * How far from an axis its parts reach: each member's box, but a body with round faces on two
 * shared axes or more (a frame plate, whose far corner covers the whole frame) only by its round
 * faces on this one.
 */
function reachOf(topo: Map<string, BodyTopo>, bodies: readonly AssemblyBody[], g: SharedAxis, axesOfBody: ReadonlyMap<number, number>): number {
  let reach = 0;
  for (const m of g.members) {
    if ((axesOfBody.get(m) ?? 0) >= 2) {
      for (const f of topo.get(bodies[m].id)?.round ?? []) if (sameLine(f.line, g.line)) reach = Math.max(reach, f.r);
    } else reach = Math.max(reach, boxAbout(g.line, bodies[m].bbox).rFar);
  }
  return reach;
}

/** How far a group moves along the axis (side +1 or -1) before it meets another body, and which. */
function stopOf(w: AxisWork, group: ReadonlySet<number>, side: 1 | -1): { t: number; by: number } | null {
  const n = w.slabs.length;
  let best: { t: number; by: number } | null = null;
  const order = Array.from({ length: n }, (_, j) => (side > 0 ? n - 1 - j : j));
  for (const j of order) {
    const mine = [...group].map((g) => w.slabs[j].slices.get(g)).filter((x): x is Slice => !!x);
    if (!mine.length) continue;
    const mineSpans = mine.flatMap((s) => radialSet(s));
    for (let k = j + side; k >= 0 && k < n; k += side) {
      const t = side > 0 ? w.slabs[k].s0 - w.slabs[j].s1 : w.slabs[j].s0 - w.slabs[k].s1;
      if (best && t >= best.t) break;
      let hit: number | null = null;
      for (const [x, sx] of w.slabs[k].slices) {
        if (group.has(x)) continue;
        if (!spanOverlap(mineSpans, radialSet(sx)).length) continue;
        if (mine.some((m) => overlaps(m, sx))) {
          hit = x;
          break;
        }
      }
      if (hit !== null) {
        best = { t: Math.max(0, t), by: hit };
        break;
      }
    }
  }
  return best;
}

/** Where along the axis `body` holds the bore of radius `bore` (within the play): its first and last slab there. */
function holdingSpan(w: AxisWork, body: number, bore: number, play: number, near: number): [number, number] | null {
  const holds = (k: number) => {
    const s = w.slabs[k].slices.get(body);
    if (!s || !goesRound(s)) return false;
    return radialSet(s).some(([a, b]) => a < bore - 1e-7 && bore - b <= play);
  };
  if (!holds(near)) return null;
  let a = near;
  let b = near;
  while (a > 0 && holds(a - 1)) a--;
  while (b + 1 < w.slabs.length && holds(b + 1)) b++;
  return [w.slabs[a].s0, w.slabs[b].s1];
}

/** Whether every body on each shared axis is held radially and along it (see the file's notes). */
export async function checkStack(env: CheckEnv, bodies: readonly AssemblyBody[], o: { play: number; only?: readonly number[] }): Promise<StackResult> {
  const run = new Run(env);
  const play = o.play;
  const inScope = o.only ? new Set(o.only) : null;
  const topo = new Map<string, BodyTopo>();
  await topoAll(run, bodies, topo, 'Reading round faces');
  const groups = groupAxes(bodies, topo);
  const shared = groups.filter((g) => g.members.length >= 2);
  const axesOfBody = new Map<number, number>();
  for (const g of shared) for (const m of g.members) axesOfBody.set(m, (axesOfBody.get(m) ?? 0) + 1);
  // A body's own bore (a wheel or a hand alone: is anything in it?): a line only its round faces lie
  // on, with its centroid on it (a wheel with lightening holes), else its only such line when its
  // material goes all the way round it there (a hand, a crank; a fillet's line never has that).
  const own = new Map<number, SharedAxis[]>();
  for (const g of groups) {
    const b = g.members[0];
    if (g.members.length !== 1 || bodies[b].solids === 0 || (inScope && !inScope.has(b))) continue;
    own.set(b, [...(own.get(b) ?? []), g]);
  }
  const centred: SharedAxis[] = [];
  for (const [i, lines] of own) {
    if (run.overTime()) break;
    const b = bodies[i];
    const p = (await run.call('props', { id: b.shape, volume: true, bbox: 'none' }, `measure ${b.name}`, b.faces)).result;
    const size = Math.hypot(b.bbox[3] - b.bbox[0], b.bbox[4] - b.bbox[1], b.bbox[5] - b.bbox[2]);
    const on = p.centroid ? lines.find((g) => off(g.line, p.centroid!) <= 0.01 + 1e-4 * size) : undefined;
    if (on) {
      centred.push(on);
      continue;
    }
    if (lines.length !== 1) continue;
    const g = lines[0];
    const spans = (topo.get(b.id)?.round ?? []).filter((f) => f.box && sameLine(f.line, g.line)).map((f) => spanAlong(g.line, f.box!));
    const [s0, s1] = spans.length ? [Math.min(...spans.map((s) => s[0])), Math.max(...spans.map((s) => s[1]))] : spanAlong(g.line, b.bbox);
    const f = frameAt(g.line, (s0 + s1) / 2);
    const sec = (await run.call('section', { plane: { origin: f.origin, normal: f.normal, xdir: f.xdir }, ids: [b.shape] }, 'cut the bodies across their axis', b.faces)).result;
    const loops = sec.bodies[0]?.loops ?? [];
    if (loops.length && boreOf(sliceOf(loops)) !== null) centred.push(g);
  }
  const axes = [...shared, ...centred];
  const plans: AxisPlan[] = axes.map((g) => {
    const reach = reachOf(topo, bodies, g, axesOfBody);
    return { g, reach, idx: nearAxis(g.line, bodies, reach) };
  });
  // With some bodies only, the axes near them.
  const wanted = plans.map((_, i) => i).filter((i) => !inScope || plans[i].idx.some((b) => inScope.has(b)));
  const works = new Map<number, AxisWork>();
  const cut = async (i: number, k: number, n: number) => {
    const w = await axisWork(run, bodies, topo, plans[i], play, k / n, 1 / n);
    if (w) works.set(i, w);
  };
  for (let k = 0; k < wanted.length; k++) {
    if (run.overTime()) break;
    await cut(wanted[k], k, wanted.length);
  }
  // A body holding a shaft on one axis checked may be a frame (two axes or more): with some bodies
  // only, its other shared axes are cut too until that is known (not listed).
  if (inScope) {
    const tried = new Set(wanted);
    for (;;) {
      if (run.overTime()) break;
      const holds = new Map<number, Set<number>>();
      for (const [a, w] of works) for (const f of w.fits) if (f.play > PRESS_MM) holds.set(f.outer, (holds.get(f.outer) ?? new Set()).add(a));
      const next = [...holds].filter(([, on]) => on.size === 1).flatMap(([b]) => shared.map((g) => axes.indexOf(g)).filter((i) => !tried.has(i) && axes[i].members.includes(b)))[0];
      if (next === undefined) break;
      tried.add(next);
      await cut(next, 0, 1);
    }
  }
  // Press fits join bodies; a group holding shafts on two axes or more is a frame (it does not turn).
  const groupsOf = new Groups();
  for (const w of works.values()) for (const f of w.fits) if (f.play <= PRESS_MM) groupsOf.join(f.outer, f.inner);
  const outerAxes = new Map<number, Set<number>>();
  for (const [a, w] of works) {
    for (const f of w.fits) {
      if (f.play <= PRESS_MM) continue;
      const r = groupsOf.root(f.outer);
      if (!outerAxes.has(r)) outerAxes.set(r, new Set());
      outerAxes.get(r)!.add(a);
    }
  }
  const isFrame = (i: number) => (outerAxes.get(groupsOf.root(i))?.size ?? 0) >= 2;
  const groupOf = (i: number) => new Set(bodies.map((_, k) => k).filter((k) => groupsOf.root(k) === groupsOf.root(i)));
  /** The body (or what it is pressed onto) rides, or holds a shaft, on another axis: it is held there (a press fit inside its own group is not). */
  const heldElsewhere = (i: number, a: number) => [...works].some(([b, w]) => b !== a && w.fits.some((f) => f.play > PRESS_MM && (groupsOf.root(f.outer) === groupsOf.root(i) || groupsOf.root(f.inner) === groupsOf.root(i))));

  const out: StackAxis[] = [];
  const findings: StackFinding[] = [];
  let thinned = false;
  for (const a of wanted) {
    const w = works.get(a);
    if (!w) continue;
    thinned ||= w.thinned;
    const at = out.length;
    const negWords = sideWords(w.ax, -1);
    const posWords = sideWords(w.ax, 1);
    // The riders: the bore's body rides on its shaft, unless the bore is a frame's (then the shaft turns in it).
    const riders = new Map<number, { body: number; holder: number; inBore: boolean; play: number; slab: number; bore: number }>();
    for (const f of w.fits) {
      if (f.play <= PRESS_MM || groupsOf.root(f.outer) === groupsOf.root(f.inner)) continue;
      const inBore = isFrame(f.outer);
      const body = inBore ? f.inner : f.outer;
      const root = groupsOf.root(body);
      const was = riders.get(root);
      const bore = boreOf(w.slabs[f.slab].slices.get(f.outer)!) ?? 0;
      if (!was || f.play < was.play) riders.set(root, { body, holder: inBore ? f.outer : f.inner, inBore, play: f.play, slab: f.slab, bore });
    }
    const checked = new Map<number, { neg: StackSide; pos: StackSide; holder: number; inBore: boolean; play: number }>();
    for (const r of riders.values()) {
      const group = groupOf(r.body);
      // With some bodies only: a part asked about, or what it is pressed onto (a wheel on its arbor).
      if (isFrame(r.body) || (inScope && ![...group].some((k) => inScope.has(k)))) continue;
      // Riding on a shaft, it may slide off its end first.
      const span = r.inBore ? null : holdingSpan(w, r.holder, r.bore, play, r.slab);
      const engaged = w.fits.filter((f) => f.outer === r.body && f.inner === r.holder).map((f) => w.slabs[f.slab]);
      const e0 = Math.min(...engaged.map((s) => s.s0));
      const e1 = Math.max(...engaged.map((s) => s.s1));
      const sideOf = (side: 1 | -1): StackSide => {
        const stop = stopOf(w, group, side);
        const offAt = span ? (side > 0 ? span[1] - e0 : e1 - span[0]) : Infinity;
        if (!stop || stop.t > offAt) return { by: null, gap: null, off: Number.isFinite(offAt) };
        return { by: bodies[stop.by].name, gap: stop.t, off: false };
      };
      checked.set(r.body, { neg: sideOf(-1), pos: sideOf(1), holder: r.holder, inBore: r.inBore, play: r.play });
    }
    // The parts in order along the axis.
    const present = new Map<number, [number, number]>();
    for (const s of w.slabs) {
      for (const i of s.slices.keys()) {
        if (!w.members.includes(i)) continue;
        const p = present.get(i);
        present.set(i, p ? [Math.min(p[0], s.s0), Math.max(p[1], s.s1)] : [s.s0, s.s1]);
      }
    }
    const parts: StackPart[] = [...present]
      .sort((p, q) => p[1][0] - q[1][0] || p[1][1] - q[1][1])
      .map(([i, [from, to]]) => {
        const c = checked.get(i);
        const bores = w.slabs.map((s) => s.slices.get(i)).filter((x): x is Slice => !!x).map(boreOf).filter((x): x is number => x !== null);
        const fixed = [...groupOf(i)].filter((k) => k !== i && w.idx.includes(k)).map((k) => bodies[k].name);
        return {
          body: bodies[i].name,
          from,
          to,
          bore: bores.length ? Math.min(...bores) : null,
          on: c ? bodies[c.holder].name : null,
          inBore: c?.inBore ?? false,
          play: c ? c.play : null,
          fixed,
          neg: c?.neg ?? null,
          pos: c?.pos ?? null,
        };
      });
    out.push({ line: w.ax, words: axisWords(w.ax), negWords, posWords, parts });
    // Findings: each side of each part checked, then bores nothing holds.
    for (const [i, c] of checked) {
      const name = bodies[i].name;
      const holder = bodies[c.holder].name;
      const how = c.inBore ? `in ${holder}` : `along ${holder}`;
      for (const [side, s] of [['neg', c.neg], ['pos', c.pos]] as const) {
        const dir = side === 'neg' ? negWords : posWords;
        if (s.by === null) {
          findings.push({ body: name, axis: at, kind: 'free', side, gap: null, words: `${name} can slide ${how} toward ${dir}: nothing stops it${s.off ? ` before it comes off ${holder}` : ''}` });
        } else if ((s.gap ?? 0) > play) {
          findings.push({ body: name, axis: at, kind: 'slides', side, gap: s.gap, words: `${name} can slide ${round(s.gap!)} mm ${how} toward ${dir} before it meets ${s.by}` });
        }
      }
    }
    // A frame's hole (a pipe passing through a plate) and a body held on another axis need nothing here.
    for (const e of w.empty) {
      if ((inScope && !inScope.has(e.body)) || isFrame(e.body) || heldElsewhere(e.body, a)) continue;
      const name = bodies[e.body].name;
      const what = e.nearest ? `is ${round(e.nearest.gap)} mm wider than ${bodies[e.nearest.body].name} (radius ${round(e.nearest.r)} mm) inside it` : 'is empty';
      findings.push({ body: name, axis: at, kind: 'bore', side: null, gap: null, words: `Nothing holds ${name} radially: its bore ${axisWords(w.ax)} (radius ${round(e.bore)} mm) ${what}` });
    }
  }
  await run.release();
  return { axes: out, axesTotal: wanted.length, findings, play, thinned, complete: !run.timedOut };
}

const round = (v: number) => Math.round(v * 1e4) / 1e4;

// ------------------------------------------------------------------ sweep

export interface SweepHit {
  turning: string;
  hits: string;
  /** The first angle it meets it turning counter-clockwise about the axis direction (degrees), or null. */
  pos: number | null;
  /** Turning the other way. */
  neg: number | null;
  /** Where they meet first (counter-clockwise, else the other way). */
  at: Vec3;
  /** The kernel's overlap of the turned copy SWEEP_PAST_DEG past the first contact (mm³; null when not checked). */
  overlap: number | null;
}

export interface SweepResult {
  line: AxisLine;
  words: string;
  turning: string[];
  hits: SweepHit[];
  /** Pairs that share material before turning (the interference check lists them). */
  already: { turning: string; with: string }[];
  /** Bodies near enough to be hit, all looked at. */
  near: number;
  /** More levels than SLABS_MAX: the others' were left out, so a thin body may be missed. */
  thinned: boolean;
  /** False when the time limit stopped it: the slabs or the pairs it did not reach are not checked. */
  complete: boolean;
}

/** The rigid turn about the axis by `deg` (the kernel's row-major 3x4). */
export function turnAbout(ax: AxisLine, deg: number): number[] {
  const t = (deg * Math.PI) / 180;
  const [x, y, z] = ax.dir;
  const c = Math.cos(t);
  const s = Math.sin(t);
  const C = 1 - c;
  const R = [
    [c + x * x * C, x * y * C - z * s, x * z * C + y * s],
    [y * x * C + z * s, c + y * y * C, y * z * C - x * s],
    [z * x * C - y * s, z * y * C + x * s, c + z * z * C],
  ];
  const p = ax.point;
  const tr = [0, 1, 2].map((i) => p[i] - (R[i][0] * p[0] + R[i][1] * p[1] + R[i][2] * p[2]));
  return [...R[0], tr[0], ...R[1], tr[1], ...R[2], tr[2]];
}

/** Turning `turning` (indices) about `line` a full turn each way: the first angle each meets another body. */
export async function checkSweep(env: CheckEnv, bodies: readonly AssemblyBody[], turning: readonly number[], line: AxisLine): Promise<SweepResult> {
  const run = new Run(env);
  const ax = line;
  const set = new Set(turning);
  let reach = 0;
  let lo = Infinity;
  let hi = -Infinity;
  for (const t of turning) {
    const r = boxAbout(ax, bodies[t].bbox);
    reach = Math.max(reach, r.rFar);
    lo = Math.min(lo, r.s0);
    hi = Math.max(hi, r.s1);
  }
  const near = nearAxis(ax, bodies, reach, [lo, hi]).filter((i) => !set.has(i) && bodies[i].solids !== 0);
  const idx = [...turning, ...near];
  const topo = new Map<string, BodyTopo>();
  await topoAll(run, idx.map((i) => bodies[i]), topo, 'Reading the bodies');
  // The turning bodies keep every level; then the bodies at the axis; then the rest.
  const tier = (list: readonly number[]) => levelsAlong(ax, list.map((i) => topo.get(bodies[i].id)));
  const core = Math.min(...turning.map((t) => (topo.get(bodies[t].id)?.round ?? []).filter((f) => sameLine(f.line, ax)).reduce((m, f) => Math.min(m, f.r), Infinity)));
  const atAxis = (i: number) => boxAbout(ax, bodies[i].bbox).rNear <= (Number.isFinite(core) ? core : 0);
  const { levels, thinned } = levelsOf([tier(turning), tier(near.filter(atAxis)), tier(near.filter((i) => !atAxis(i)))], lo, hi);
  const slabs = near.length ? await slabsOf(run, ax, bodies, idx, levels, `Cutting the bodies ${axisWords(ax)}`, 0.1, 0.6) : [];
  const hits: SweepHit[] = [];
  const already: { turning: string; with: string }[] = [];
  const frame = (s: number) => frameAt(ax, s);
  for (const t of turning) {
    for (const x of near) {
      if (run.overTime()) break;
      let pos: { deg: number; at: Vec3 } | null = null;
      let neg: { deg: number; at: Vec3 } | null = null;
      let over = false;
      for (const s of slabs) {
        const a = s.slices.get(t);
        const b = s.slices.get(x);
        if (!a || !b || !spanOverlap(radialSet(a), radialSet(b)).length) continue;
        const c = firstContact(a, b);
        if (c.already) {
          over = true;
          break;
        }
        const f = frame((s.s0 + s.s1) / 2);
        const at = (rho: number, th: number): Vec3 => add(f.origin, add(scale(f.xdir, rho * Math.cos(th)), scale(f.v, rho * Math.sin(th))));
        if (c.pos && (!pos || (c.pos.turn * 180) / Math.PI < pos.deg)) pos = { deg: (c.pos.turn * 180) / Math.PI, at: at(c.pos.rho, c.pos.theta) };
        if (c.neg && (!neg || (c.neg.turn * 180) / Math.PI < neg.deg)) neg = { deg: (c.neg.turn * 180) / Math.PI, at: at(c.neg.rho, c.neg.theta) };
      }
      if (over) already.push({ turning: bodies[t].name, with: bodies[x].name });
      else if (pos || neg) hits.push({ turning: bodies[t].name, hits: bodies[x].name, pos: pos?.deg ?? null, neg: neg?.deg ?? null, at: (pos ?? neg)!.at, overlap: null });
    }
  }
  hits.sort((p, q) => (p.pos ?? 360) - (q.pos ?? 360));
  // The kernel's word on each hit: the turned copy just past the contact overlaps the body it meets.
  try {
    for (let i = 0; i < Math.min(hits.length, SWEEP_CONFIRM_MAX); i++) {
      if (run.overTime()) break;
      const h = hits[i];
      run.progress(0.7 + (0.3 * i) / hits.length, `Turning ${h.turning} to ${h.hits}`);
      const t = bodies.find((b) => b.name === h.turning)!;
      const x = bodies.find((b) => b.name === h.hits)!;
      const deg = h.pos !== null ? h.pos + SWEEP_PAST_DEG : -((h.neg ?? 0) + SWEEP_PAST_DEG);
      const copy = (await run.call('copies', { id: t.shape, transforms: [{ matrix: turnAbout(ax, deg) }], check: false }, `turn a copy of ${t.name}`, t.faces)).result;
      for (const id of copy.ids) run.keep(id);
      const common = (await run.call('boolean', { op: 'common', targets: [copy.ids[0]], tools: [x.shape], keep_tools: true }, `intersect ${t.name} turned with ${x.name}`, t.faces + x.faces)).result;
      run.keep(common.id);
      let v = 0;
      if (!common.empty) v = Math.max(0, (await run.call('props', { id: common.id, volume: true, bbox: 'none' }, `measure what ${t.name} turned and ${x.name} share`, t.faces + x.faces)).result.volume ?? 0);
      h.overlap = v;
      await run.release([...copy.ids, common.id]);
    }
  } finally {
    await run.release();
  }
  return { line: ax, words: axisWords(ax), turning: turning.map((t) => bodies[t].name), hits, already, near: near.length, thinned: near.length > 0 && thinned, complete: !run.timedOut };
}
