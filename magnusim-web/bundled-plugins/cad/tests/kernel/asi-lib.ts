// Shared parts and checks for the kernel API 8 tests (Analysis Situs: recognize,
// suppress_blends, debug_reshape). Every part is built in the test with kernel ops; the only
// file is fixtures/kernel/variable-fillet.step (a variable fillet no kernel op makes).
// Until the shipped kernel answers API 8, these tests run only against a dev kernel named by
// CAD_KERNEL_DIR; without it they are skipped and say so in their names. With CAD_KERNEL_DIR
// set they always run, so on an API 7 kernel they fail ("unknown op 'recognize'").
// Owner: KERNEL-HARDENING.
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe } from 'vitest';
import type { Kernel } from '../../src/kernel-worker/kernel-api';
import { call, type R } from './kernel-lib';

/** Whether the API 8 tests run against `k`, and the reason in the skipped tests' names when not. */
export function api8Gate(k: Kernel): { run: boolean; describe8: (name: string, fn: () => void) => void } {
  const api = Number(call(k, 'version').api);
  const named = !!process.env.CAD_KERNEL_DIR;
  const run = api >= 8 || named;
  const why = `needs kernel API 8 (this kernel answers ${api}): set CAD_KERNEL_DIR to a dev kernel built with kernel-build/build.sh --out`;
  if (!run) console.warn(`[kernel tests] skipping the API 8 tests: ${why}`);
  return { run, describe8: (name, fn) => (run ? describe(name, fn) : describe.skip(`${name} [skipped: ${why}]`, fn)) };
}

export const XZ = { origin: [0, 0, 0], normal: [0, -1, 0], xdir: [1, 0, 0] };
export const XY = { origin: [0, 0, 0], normal: [0, 0, 1], xdir: [1, 0, 0] };
const AXIS_Z = { origin: [0, 0, 0], dir: [0, 0, 1] };

/** A closed polygon profile (points (u, v) on `plane`). */
export const poly = (pts: number[][], plane: R = XZ): R => ({
  plane,
  loops: [pts.map((a, i) => ({ id: `s${i}`, kind: 'line', a, b: pts[(i + 1) % pts.length] }))],
});

/** Area of a closed polygon. */
export function polyArea(pts: number[][]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % pts.length];
    a += x0 * y1 - x1 * y0;
  }
  return Math.abs(a) / 2;
}

/**
 * The Step 0 family (asi-step0/asi_step0.cpp): profiles in the XZ plane (x, z), extruded
 * `depth` along y. Delete faces refuses every one of them rounded today (T, I, plus, comb, Z);
 * the L-block is the control its two-go heal already gets right.
 */
export const FAMILY: Record<string, { label: string; xz: number[][]; depth: number }> = {
  T: { label: 'T-block 60x40x10 bar on a 20x40x10 stem', xz: [[20, 0], [40, 0], [40, 10], [60, 10], [60, 20], [0, 20], [0, 10], [20, 10]], depth: 40 },
  I: {
    label: 'I-beam, flanges 60x10, web 10, height 50',
    xz: [[0, 0], [60, 0], [60, 10], [35, 10], [35, 40], [60, 40], [60, 50], [0, 50], [0, 40], [25, 40], [25, 10], [0, 10]],
    depth: 40,
  },
  plus: {
    label: 'plus, arms 20 wide, 60x60',
    xz: [[20, 0], [40, 0], [40, 20], [60, 20], [60, 40], [40, 40], [40, 60], [20, 60], [20, 40], [0, 40], [0, 20], [20, 20]],
    depth: 20,
  },
  comb: {
    label: 'comb, base 60x10, 4 teeth 6x15',
    xz: [[0, 0], [60, 0], [60, 10], [54, 10], [54, 25], [48, 25], [48, 10], [40, 10], [40, 25], [34, 25], [34, 10], [26, 10], [26, 25], [20, 25], [20, 10], [12, 10], [12, 25], [6, 25], [6, 10], [0, 10]],
    depth: 20,
  },
  Z: { label: 'Z-block, flanges 30x10, web 10, height 50', xz: [[0, 40], [20, 40], [20, 0], [50, 0], [50, 10], [30, 10], [30, 50], [0, 50]], depth: 30 },
  L: { label: 'L-block 60x40x20 minus a 30x40x10 step (control)', xz: [[0, 0], [60, 0], [60, 10], [30, 10], [30, 20], [0, 20]], depth: 40 },
};

export type Edge = { i: number; type: string; first: number[]; last: number[]; dir?: number[]; mid?: number[] };
export type Face = { i: number; type: string; normal?: number[]; radius?: number; minor_radius?: number; axis?: R; area?: number; centroid?: number[] };

export function partKit(k: Kernel) {
  const c = (op: string, params: R = {}) => call(k, op, params);
  const ok = (op: string, params: R) => {
    const r = c(op, params);
    if (r.valid === false) throw new Error(`${op} gave an invalid shape: ${r.reason}`);
    return r;
  };
  const id = (op: string, params: R) => ok(op, params).id as number;
  const box = (dx: number, dy: number, dz: number, origin = [0, 0, 0]) => id('box', { dx, dy, dz, origin });
  const cyl = (r: number, h: number, origin: number[], axis = [0, 0, 1]) => id('cylinder', { r, h, origin, axis });
  const cut = (a: number, ...tools: number[]) => id('boolean', { op: 'cut', targets: [a], tools });
  const fuse = (a: number, ...tools: number[]) => id('boolean', { op: 'fuse', targets: [a], tools });
  const prism = (xz: number[][], depth: number) => id('extrude', { profile: poly(xz), extent: { kind: 'blind', d: depth } });
  const revolveZ = (xz: number[][]) => id('revolve', { profile: poly(xz), axis: AXIS_Z, angle_deg: 360 });
  const faces = (s: number): Face[] => c('topo', { id: s, edges: 'none', vertices: 'none' }).faces;
  const edges = (s: number): Edge[] => c('topo', { id: s, faces: 'none', vertices: 'none', edge_ends: true }).edges;
  const vol = (s: number): number => c('props', { id: s, volume: true, bbox: 'none' }).volume;
  const nFaces = (s: number): number => c('props', { id: s, bbox: 'none' }).faces;
  /** Fillet edges of s at r: the result id and the faces the fillet made (no modified or same source). */
  const fillet = (s: number, es: number[], r: number) => {
    const res = ok('fillet', { id: s, edges: es, r });
    return { id: res.id as number, made: newFaces(res), res };
  };
  const filletAll = (s: number, r: number) => fillet(s, edges(s).map((e) => e.i), r);
  const release = (...ids: number[]) => void c('release', { ids });
  return { c, ok, id, box, cyl, cut, fuse, prism, revolveZ, faces, edges, vol, nFaces, fillet, filletAll, release };
}
export type Kit = ReturnType<typeof partKit>;

/** Result faces with no modified or same source in the op's history: what the op made. */
export function newFaces(res: R): number[] {
  const kept = new Set<number>();
  for (const f of res.history.faces as R[]) if ((f.from as R[]).some((x) => x.how === 'modified' || x.how === 'same')) kept.add(f.out);
  const out: number[] = [];
  for (let i = 0; i < res.faces; i++) if (!kept.has(i)) out.push(i);
  return out;
}

/** The result faces that `faces` of input shape `shape` became (modified or same). */
export function imagesOf(res: R, shape: number, faces: number[]): number[] {
  const want = new Set(faces);
  const out = new Set<number>();
  for (const f of res.history.faces as R[])
    if ((f.from as R[]).some((x) => x.shape === shape && (x.how === 'modified' || x.how === 'same') && want.has(x.face))) out.add(f.out);
  return [...out].sort((a, b) => a - b);
}

const near = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) <= tol;
const isLateral = (e: Edge) => near(e.first[0], e.last[0]) && near(e.first[2], e.last[2]);

/** A Step 0 part: the sharp prism, rounded R on every edge ('every'), or on the edges along the extrusion only ('lat'). */
export function familyPart(kit: Kit, name: string, r: number, mode: 'every' | 'lat' = 'every') {
  const d = FAMILY[name];
  const sharp = kit.prism(d.xz, d.depth);
  const es = kit.edges(sharp).filter((e) => mode === 'every' || isLateral(e)).map((e) => e.i);
  const f = kit.fillet(sharp, es, r);
  return { id: f.id, truth: f.made, sharp, sharpVolume: polyArea(d.xz) * d.depth, sharpFaces: d.xz.length + 2 };
}

/**
 * The proof's part A (2026-10-29): a 60 x 40 x 20 box, R5 on its 4 vertical edges, a chain of
 * radius rTop round the top face (none for rTop 0), then a 6 mm through hole at (15, 20) and an
 * 8 mm hole 10 deep at (45, 20). Fillet truth from the fillets' history.
 */
export function proofA(kit: Kit, rTop = 3) {
  const b = kit.box(60, 40, 20);
  const vertical = kit.edges(b).filter((e) => near(e.first[0], e.last[0]) && near(e.first[1], e.last[1])).map((e) => e.i);
  const f1 = kit.fillet(b, vertical, 5);
  const top = kit.edges(f1.id).filter((e) => near(e.first[2], 20) && near(e.last[2], 20)).map((e) => e.i);
  const f2 = rTop > 0 ? kit.fillet(f1.id, top, rTop) : null;
  const base = f2 ? f2.id : f1.id;
  const r5 = f2 ? imagesOf(f2.res, f1.id, f1.made) : f1.made;
  const rt = f2 ? f2.made : [];
  const cutRes = kit.ok('boolean', { op: 'cut', targets: [base], tools: [kit.cyl(3, 22, [15, 20, -1]), kit.cyl(4, 11, [45, 20, 10])] });
  return { id: cutRes.id as number, r5: imagesOf(cutRes, base, r5), rTop: imagesOf(cutRes, base, rt) };
}

/** The sharp reference of part A: the box with its two holes (no fillets). */
export const PROOF_A_SHARP = 60 * 40 * 20 - Math.PI * 9 * 20 - Math.PI * 16 * 10;

/** A 60 x 40 x 10 plate with a boss r 10, 10 high: R3 concave ring at its foot, R2 convex ring on its rim (the proof's case F). */
export function ringBoss(kit: Kit) {
  const plate = kit.fuse(kit.box(60, 40, 10), kit.cyl(10, 10, [30, 20, 10]));
  const circles = kit.edges(plate).filter((e) => e.type === 'circle');
  const foot = circles.filter((e) => near(e.first[2], 10) && near(e.last[2], 10)).map((e) => e.i);
  const rim = circles.filter((e) => near(e.first[2], 20) && near(e.last[2], 20)).map((e) => e.i);
  const a = kit.fillet(plate, foot, 3);
  const rimNow = kit.edges(a.id).filter((e) => e.type === 'circle' && near(e.first[2], 20) && near(e.last[2], 20)).map((e) => e.i);
  const b = kit.fillet(a.id, rimNow, 2);
  return { id: b.id, foot: imagesOf(b.res, a.id, a.made), rim: b.made, rimEdges: rim.length };
}

/** Recognition without the timings (for comparing two runs). */
export function noTimings(r: R): R {
  const { timings: _t, ...rest } = r;
  return rest;
}
