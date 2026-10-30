// @vitest-environment node
// Kernel API 7 (2026-10-30): volumes. props (the chip, Mass, Measure, the Assistant, Combine's
// "Nothing to cut") and press-pull's volume check integrate B-spline, swept and offset faces by
// Gauss-Kronrod over the knot spans, the plain Gauss rule only where it is exact. Against
// independent values: a ruled loft and a wavy-topped block are their section's area (Green over
// the knot spans, sketch_regions) times their length, a revolved spline its Pappus volume
// (integrated here over the knot spans). The plain rule read them 0.2 %, 0.04 % and 0.075 % off;
// press-pull refused 0.01 mm moves of their faces with a wrong volume, and a Cut by a block that
// only touches a cap changed the volume. Review 2026-10-30: the centroid (Mass, the Assistant's
// measure, the assembly check) came from Gauss-Kronrod faces integrated without their centre (a
// pipe tee 9.3 mm off, an airfoil loft 318 mm off): now the plain rule's centre over every face;
// and a press-pull result's B-spline conversions are kept, so its volume is not converted again.
// SPDX-License-Identifier: GPL-3.0-or-later
import { beforeAll, describe, expect, it } from 'vitest';
import type { Kernel } from '../../src/kernel-worker/kernel-api';
import { call, loadKernel, rel, volume, type R } from './kernel-lib';

let k: Kernel;
beforeAll(async () => {
  k = await loadKernel();
});

type P2 = [number, number];
const TOP = { origin: [0, 0, 0], normal: [0, 0, 1], xdir: [1, 0, 0] };
const FRONT = { origin: [0, 0, 0], normal: [0, -1, 0], xdir: [1, 0, 0] };
const faces = (id: number): R[] => call(k, 'topo', { id, edges: 'none', vertices: 'none', face_bbox: 'none', face_mass: true }).faces;
const props = (id: number): R => call(k, 'props', { id, volume: true, bbox: 'none' });

/** Clamped uniform knots for n poles of degree p (OCCT form: distinct knots and multiplicities). */
function clamped(n: number, p = 3): { knots: number[]; mults: number[] } {
  const inner = n - p - 1;
  const knots = [0];
  const mults = [p + 1];
  for (let i = 1; i <= inner; i++) {
    knots.push(i / (inner + 1));
    mults.push(1);
  }
  return { knots: [...knots, 1], mults: [...mults, p + 1] };
}

/** An airfoil-like closed outline (chord, thickness, centre offset): 16 poles, the last the first. */
function airfoil(chord: number, th: number, cx = 0, cy = 0): R {
  const P: P2[] = [];
  for (let i = 0; i < 15; i++) {
    const a = (2 * Math.PI * i) / 15;
    const x = 0.5 * chord * Math.cos(a);
    const t = x / chord + 0.5;
    const y = th * chord * (0.2969 * Math.sqrt(Math.max(t, 0)) - 0.126 * t - 0.3516 * t * t + 0.2843 * t ** 3 - 0.1015 * t ** 4) * 5 * Math.sign(Math.sin(a) || 1) + 0.15 * chord * Math.sin(a);
    P.push([cx + x, cy + y]);
  }
  P.push(P[0]);
  return { kind: 'bspline', degree: 3, poles: P, ...clamped(P.length) };
}

/** A loft section at height z: the curve as one closed sketch curve, its region and the region's (exact) area. */
function section(z: number, curve: R): { plane: R; curves: R[]; regions: string[]; area: number } {
  const plane = { ...TOP, origin: [0, 0, z] };
  const curves = [{ id: `s${z}`, ...curve, pa: `q${z}`, pb: `q${z}` }];
  const r = call(k, 'sketch_regions', { plane, curves, tess: false }).regions;
  expect(r).toHaveLength(1);
  return { plane, curves, regions: [r[0].key], area: r[0].area };
}
const loft = (secs: ReturnType<typeof section>[], ruled = false) => call(k, 'loft_regions', { sections: secs.map(({ plane, curves, regions }) => ({ plane, curves, regions })), ruled }).id as number;

// ---- the revolved bulb: a 12-pole cubic flank between two lines, about Z (Pappus over the knot spans)

const GX = [-0.9739065285171717, -0.8650633666889845, -0.6794095682990244, -0.4333953941292472, -0.1488743389816312, 0.1488743389816312, 0.4333953941292472, 0.6794095682990244, 0.8650633666889845, 0.9739065285171717];
const GW = [0.0666713443086881, 0.1494513491505806, 0.219086362515982, 0.2692667193099963, 0.2955242247147529, 0.2955242247147529, 0.2692667193099963, 0.219086362515982, 0.1494513491505806, 0.0666713443086881];
function flat(knots: number[], mults: number[]): number[] {
  return knots.flatMap((u, i) => Array(mults[i]).fill(u));
}
function basis(U: number[], p: number, i: number, u: number): number {
  if (p === 0) return U[i] <= u && u < U[i + 1] ? 1 : 0;
  const a = U[i + p] !== U[i] ? ((u - U[i]) / (U[i + p] - U[i])) * basis(U, p - 1, i, u) : 0;
  const b = U[i + p + 1] !== U[i + 1] ? ((U[i + p + 1] - u) / (U[i + p + 1] - U[i + 1])) * basis(U, p - 1, i + 1, u) : 0;
  return a + b;
}
function evalCurve(P: P2[], p: number, U: number[], u: number): P2 {
  const uu = Math.min(u, U[U.length - 1] - 1e-14);
  let x = 0;
  let y = 0;
  P.forEach((q, i) => {
    const N = basis(U, p, i, uu);
    x += N * q[0];
    y += N * q[1];
  });
  return [x, y];
}
/** The bulb's profile (r, z) and its volume about Z: pi |closed integral of r^2 dz|, the flank over its knot spans. */
function bulb(): { curves: R[]; volume: number } {
  const n = 12;
  const P: P2[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const naca = 5 * (0.2969 * Math.sqrt(t) - 0.126 * t - 0.3516 * t * t + 0.2843 * t ** 3 - 0.1015 * t ** 4);
    P.push([150 * (1 - t) + 70 * t + (205 - 110) * naca * 2, 450 * t]);
  }
  P[0] = [150, 0];
  P[n - 1] = [70, 450];
  const { knots, mults } = clamped(n);
  const U = flat(knots, mults);
  // Derivative curve: degree 2, poles 3 (P[i+1] - P[i]) / (U[i+4] - U[i+1]).
  const Q: P2[] = P.slice(1).map((q, i) => {
    const den = U[i + 4] - U[i + 1];
    return [(3 * (q[0] - P[i][0])) / den, (3 * (q[1] - P[i][1])) / den];
  });
  const U2 = U.slice(1, -1);
  let I = 0;
  for (let s = 0; s + 1 < knots.length; s++) {
    const [a, b] = [knots[s], knots[s + 1]];
    for (let j = 0; j < 10; j++) {
      const u = (a + b) / 2 + ((b - a) / 2) * GX[j];
      const r = evalCurve(P, 3, U, u)[0];
      const dz = evalCurve(Q, 2, U2, u)[1];
      I += GW[j] * ((b - a) / 2) * r * r * dz;
    }
  }
  // The lines: bottom (r 0 -> 150 at z 0) and axis add nothing; top (r 70 -> 0 at z 450) neither (dz 0).
  const curves = [
    { id: 'b', kind: 'line', a: [0, 0], b: [150, 0], pa: 'o', pb: 'p0' },
    { id: 'f', kind: 'bspline', degree: 3, poles: P, knots, mults, pa: 'p0', pb: 'p1' },
    { id: 't', kind: 'line', a: [70, 450], b: [0, 450], pa: 'p1', pb: 'h' },
    { id: 'x', kind: 'line', a: [0, 450], b: [0, 0], pa: 'h', pb: 'o' },
  ];
  return { curves, volume: Math.PI * Math.abs(I) };
}
function revolveBulb(): { id: number; volume: number } {
  const b = bulb();
  const regions = call(k, 'sketch_regions', { plane: FRONT, curves: b.curves, tess: false }).regions;
  expect(regions).toHaveLength(1);
  const r = call(k, 'revolve_regions', { plane: FRONT, curves: b.curves, regions: [regions[0].key], axis: { origin: [0, 0, 0], dir: [0, 0, 1] }, extent: { kind: 'one', angle: 360 } });
  return { id: r.id, volume: b.volume };
}

/** A press-pull as the v2 feature calls it; its accepted result or the refusal. */
const pressPull = (id: number, face: number, d: number) => call(k, 'offset_faces', { id, faces: [face], d, chain: true });

describe('props volumes on B-spline bodies (API 7)', () => {
  it('a ruled airfoil loft is its section area times its length; a 3-section loft has its spans integrated', () => {
    const s = section(0, airfoil(600, 0.24));
    const straight = loft([s, section(400, airfoil(600, 0.24))], true);
    const p = props(straight);
    expect(p.integration).toBe('spans');
    // The plain rule: 5.41562e7 for 5.42634e7.
    expect(rel(p.volume, s.area * 400)).toBeLessThan(1e-9);
    const three = loft([s, section(200, airfoil(520, 0.22, 30, 10)), section(400, airfoil(420, 0.2, 60, 20))]);
    // The adaptive integration to 1e-9 is right on a fresh loft (it is not on an offset one).
    const eps = call(k, 'props', { id: three, volume: true, bbox: 'none', volume_eps: 1e-9 }).volume;
    expect(rel(volume(k, three), eps)).toBeLessThan(1e-9);
    expect(rel(volume(k, three), 39_410_235.43)).toBeLessThan(1e-9);
  });

  it('a revolved spline is its Pappus volume (the plain rule: 753 ppm low)', () => {
    const b = revolveBulb();
    expect(rel(volume(k, b.id), b.volume)).toBeLessThan(1e-10);
  });

  it('a block with a wavy B-spline top is its section area times 380', () => {
    const n = 14;
    const P: P2[] = [];
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      P.push([400 * (1 - t), 300 + 25 * Math.sin(3 * Math.PI * t) * Math.sin(Math.PI * t)]);
    }
    P[1] = [P[1][0], 300];
    P[n - 2] = [P[n - 2][0], 300];
    const wave = { kind: 'bspline', degree: 3, poles: P, ...clamped(n) };
    const sec = (z: number) => {
      const plane = { ...TOP, origin: [0, 0, z] };
      const curves = [
        { id: `a${z}`, kind: 'line', a: [0, 0], b: [400, 0], pa: `p0${z}`, pb: `p1${z}` },
        { id: `b${z}`, kind: 'line', a: [400, 0], b: [400, 300], pa: `p1${z}`, pb: `p2${z}` },
        { id: `c${z}`, ...wave, pa: `p2${z}`, pb: `p3${z}` },
        { id: `d${z}`, kind: 'line', a: [0, 300], b: [0, 0], pa: `p3${z}`, pb: `p0${z}` },
      ];
      const r = call(k, 'sketch_regions', { plane, curves, tess: false }).regions[0];
      return { plane, curves, regions: [r.key], area: r.area as number };
    };
    const s0 = sec(0);
    const block = loft([s0, sec(380)], true);
    expect(rel(volume(k, block), s0.area * 380)).toBeLessThan(1e-10);
  });

  it('a box keeps the plain rule (exact there; no integration named)', () => {
    const b = call(k, 'box', { dx: 10, dy: 20, dz: 30 }).id;
    expect(props(b)).toMatchObject({ volume: 6000 });
    expect(props(b).integration).toBeUndefined();
  });
});

describe('props centroids (review 2026-10-30)', () => {
  const centroid = (id: number) => props(id).centroid as number[];
  const exact = (id: number) => call(k, 'props', { id, volume: true, bbox: 'none', volume_eps: 1e-9 }).centroid as number[];
  const off = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

  it('a pipe tee (an R10 bar and an R8 branch fused: B-spline edges) has its centroid on its symmetry planes, as the adaptive rule at 1e-9 says', () => {
    const run = call(k, 'cylinder', { r: 10, h: 100, origin: [-50, 0, 0], axis: [1, 0, 0] }).id;
    const branch = call(k, 'cylinder', { r: 8, h: 50, origin: [0, 0, 0], axis: [0, 0, 1] }).id;
    const tee = call(k, 'boolean', { op: 'fuse', targets: [run], tools: [branch] }).id;
    expect(props(tee).integration).toBe('spans');
    const c = centroid(tee);
    // Was 1.1250, 0, 15.3718 (9.3 mm off): the Gauss-Kronrod faces' volume counted at one point.
    expect(Math.abs(c[0])).toBeLessThan(1e-6);
    expect(Math.abs(c[1])).toBeLessThan(1e-6);
    expect(off(c, exact(tee))).toBeLessThan(1e-4);
  });

  it('a cross-drilled block centred on the origin has its centroid there', () => {
    const box = call(k, 'box', { dx: 40, dy: 40, dz: 40, origin: [-20, -20, -20] }).id;
    const hx = call(k, 'cylinder', { r: 5, h: 60, origin: [-30, 0, 0], axis: [1, 0, 0] }).id;
    const hy = call(k, 'cylinder', { r: 5, h: 60, origin: [0, -30, 0], axis: [0, 1, 0] }).id;
    const drilled = call(k, 'boolean', { op: 'cut', targets: [box], tools: [hx, hy] }).id;
    expect(off(centroid(drilled), [0, 0, 0])).toBeLessThan(1e-6);
  });

  it('a straight airfoil loft 0..400 has its centroid at z 200 and within 0.1 mm of the adaptive rule (was 318 mm off)', () => {
    const straight = loft([section(0, airfoil(600, 0.24)), section(400, airfoil(600, 0.24))]);
    const c = centroid(straight);
    expect(Math.abs(c[2] - 200)).toBeLessThan(1e-6);
    expect(off(c, exact(straight))).toBeLessThan(0.1);
  });

  it('a revolved spline (300 mm across) has its centroid within 0.05 mm of its axis', () => {
    const b = revolveBulb();
    const c = centroid(b.id);
    expect(Math.hypot(c[0], c[1])).toBeLessThan(0.05);
    expect(Math.abs(c[2] - exact(b.id)[2])).toBeLessThan(0.05);
  });
});

describe('a press-pull result of a B-spline part (review 2026-10-30)', () => {
  it("is measured without converting its untouched B-spline faces again: 16 lofted pins on a plate, a pin cap +0.5: the result's volume within 5 times the plate's (was 13 times)", () => {
    const pin = call(k, 'loft_regions', { sections: [section(-2, airfoil(8, 0.24)), section(6, airfoil(7, 0.22, 0.5, 0.2)), section(14, airfoil(5, 0.2, 1, 0.4))].map(({ plane, curves, regions }) => ({ plane, curves, regions })), check: false }).id;
    const transforms = Array.from({ length: 16 }, (_, i) => ({ matrix: [1, 0, 0, 10 + 12 * (i % 4), 0, 1, 0, 10 + 12 * Math.floor(i / 4), 0, 0, 1, 0] }));
    const copies = call(k, 'copies', { id: pin, transforms, check: false }).ids as number[];
    const plate = call(k, 'box', { dx: 68, dy: 68, dz: 5, origin: [0, 0, -5], check: false }).id;
    const body = call(k, 'boolean', { op: 'fuse', targets: [plate], tools: copies, check: false }).id;
    const t = call(k, 'topo', { id: body, faces: 'all', edges: 'all', vertices: 'none', face_bbox: 'none' });
    const side = t.faces.find((f: R) => f.type === 'bspline').i;
    const cap = t.edges.filter((e: R) => e.faces.includes(side)).flatMap((e: R) => e.faces).find((i: number) => i !== side && t.faces[i].type === 'plane' && t.faces[i].area < 100);
    const timed = (id: number) => {
      const t0 = performance.now();
      const v = volume(k, id);
      return { v, ms: performance.now() - t0 };
    };
    const before = timed(body);
    const r = pressPull(body, cap, 0.5);
    expect(r.refused).toBeUndefined();
    const after = timed(r.id);
    const again = timed(r.id);
    expect(again.v).toBe(after.v);
    expect(rel(after.v - before.v, t.faces[cap].area * 0.5)).toBeLessThan(5e-2);
    expect(after.ms).toBeLessThan(5 * Math.max(before.ms, 20));
  });
});

describe('press-pull and Combine read the same volumes (API 7)', () => {
  it("press-pull moves a lofted body's caps by 0.01 and 0.1 mm: accepted, the volume changes by the cap's area times d", () => {
    const s = section(0, airfoil(600, 0.24));
    const three = loft([s, section(200, airfoil(520, 0.22, 30, 10)), section(400, airfoil(420, 0.2, 60, 20))]);
    const v0 = volume(k, three);
    for (const f of faces(three).filter((x) => x.type === 'plane')) {
      for (const d of [0.01, -0.01, 0.1, -0.1]) {
        const r = pressPull(three, f.i, d);
        // Refused before: "its volume would change by 35,083.5 mm3 instead of about -13,565.7 mm3".
        expect(r.refused, `cap ${f.i} by ${d}`).toBeUndefined();
        expect(r.method).toBe('offset');
        expect(rel(volume(k, r.id) - v0, f.area * d)).toBeLessThan(2e-3);
        call(k, 'release', { ids: [r.id] });
      }
    }
  });

  it("press-pull of a revolved spline's caps and flank by 0.01 and 0.1 mm: accepted, and the volume after it is right", () => {
    const b = revolveBulb();
    const fs = faces(b.id);
    for (const f of fs) {
      for (const d of [0.01, -0.1]) {
        const r = pressPull(b.id, f.i, d);
        expect(r.refused, `face ${f.i} (${f.type}) by ${d}`).toBeUndefined();
        // Within 1 %: a cap's sloping neighbour adds its own sliver (0.7 % at 0.01 mm).
        expect(rel(volume(k, r.id) - b.volume, f.area * d)).toBeLessThan(1e-2);
        // The result's volume is integrated as accurately as the body's (it fell back to the plain rule: 34,800 mm3 low).
        expect(props(r.id).integration).toBe('spans');
        call(k, 'release', { ids: [r.id] });
      }
    }
  });

  it("a Cut by a block that only touches a loft's top cap leaves the volume as it was (Nothing to cut); a 0.001 mm bite takes 0.001 x its area", () => {
    const s = section(0, airfoil(600, 0.24));
    const three = loft([s, section(200, airfoil(520, 0.22, 30, 10)), section(400, airfoil(420, 0.2, 60, 20))]);
    const v0 = volume(k, three);
    const touch = call(k, 'combine', { op: 'cut', targets: [three], tools: [call(k, 'box', { dx: 200, dy: 100, dz: 50, origin: [0, 0, 400] }).id] }).results[0].id;
    // Combine's rule: within 1e-9 of the volume is "Nothing to cut" (the plain rule: +17,755.6 mm3).
    expect(Math.abs(volume(k, touch) - v0)).toBeLessThan(1e-9 * v0);
    const bite = call(k, 'combine', { op: 'cut', targets: [three], tools: [call(k, 'box', { dx: 300, dy: 200, dz: 50.001, origin: [-150, -100, -50] }).id] }).results[0].id;
    expect(rel(v0 - volume(k, bite), 300 * 200 * 0.001)).toBeLessThan(1e-4);
  });
});
