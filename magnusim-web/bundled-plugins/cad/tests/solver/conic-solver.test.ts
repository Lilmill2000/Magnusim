// @vitest-environment node
// Ellipses, partial ellipses, parabolas and rho conics in the shipped solver (PlaneGCS wasm through
// solver-api.mjs): honest DOF counts, the hidden focus and minor radius following the stored points,
// relations (on curve, tangent, horizontal axis, equal, concentric) and the major / minor radii
// driven by point-to-point distances.
// SPDX-License-Identifier: GPL-3.0-or-later
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

type V2 = [number, number];
interface Solver {
  load(sketch: unknown): unknown;
  solve(): { status: string; dof: number; solved: boolean; conflicting: string[]; redundant: string[]; values: { points: Record<string, V2> } };
  analyze(): { dof: number; perEntity: Record<string, string>; conflicting: string[]; redundant: string[] };
  dragStartEntity(id: string, grab: V2): { ok: boolean; movable: boolean };
  dragMove(u: number, v: number): { status: string };
  dragEnd(): { values: { points: Record<string, V2> } };
  dispose(): void;
}

const API = pathToFileURL(fileURLToPath(new URL('../../src/solver-worker/solver-api.mjs', import.meta.url))).href;
const MODULE = pathToFileURL(fileURLToPath(new URL('../../workspace/solver/planegcs.mjs', import.meta.url))).href;

async function solver(): Promise<Solver> {
  const { createSolver } = (await import(/* @vite-ignore */ API)) as { createSolver(o: { moduleUrl: string }): Promise<Solver> };
  return createSolver({ moduleUrl: MODULE });
}

const ORIGIN_FIX = { id: '#origin', kind: 'fix', refs: ['origin'], value: [0, 0] };
const fix = (id: string) => ({ id: `f_${id}`, kind: 'fix', refs: [id] });
const dist = (a: V2, b: V2) => Math.hypot(b[0] - a[0], b[1] - a[1]);
/** The minor end's distance across the major axis. */
const across = (c: V2, m: V2, n: V2) => Math.abs(((n[0] - c[0]) * -(m[1] - c[1]) + (n[1] - c[1]) * (m[0] - c[0])) / dist(c, m));

const ELLIPSE = {
  points: { origin: [0, 0], c: [5, 3], m: [25, 3], n: [5, 13] },
  entities: [{ id: 'e1', kind: 'ellipse', c: 'c', major: 'm', minor: 'n' }],
};

describe('ellipses in the solver', () => {
  it('an ellipse has 5 freedoms; centre, major end and minor radius fixed = 0', async () => {
    const s = await solver();
    s.load({ ...ELLIPSE, constraints: [ORIGIN_FIX] });
    const r = s.solve();
    expect(r.solved).toBe(true);
    expect(r.dof).toBe(5);
    // Stored points that are an ellipse stay where they are.
    expect(dist(r.values.points.m, [25, 3])).toBeLessThan(1e-9);
    expect(dist(r.values.points.n, [5, 13])).toBeLessThan(1e-9);
    expect(s.analyze().perEntity.e1).toBe('under');
    s.load({ ...ELLIPSE, constraints: [ORIGIN_FIX, fix('c'), fix('m'), { id: 'd', kind: 'distance', refs: ['c', 'n'], value: 6 }] });
    const q = s.solve();
    expect(q.dof).toBe(0);
    expect(across(q.values.points.c, q.values.points.m, q.values.points.n)).toBeCloseTo(6, 9);
    expect(s.analyze().perEntity.e1).toBe('fully');
    s.load({ ...ELLIPSE, constraints: [ORIGIN_FIX, { id: 'fx', kind: 'fix', refs: ['e1'] }] });
    expect(s.solve().dof).toBe(0);
    s.dispose();
  });

  it('dimensions set the major and minor radii; horizontal on the ellipse turns its major axis', async () => {
    const s = await solver();
    s.load({
      points: { origin: [0, 0], c: [0, 0], m: [17, 6], n: [-2, 6] },
      entities: [{ id: 'e1', kind: 'ellipse', c: 'c', major: 'm', minor: 'n' }],
      constraints: [ORIGIN_FIX, { id: 'co', kind: 'coincident', refs: ['c', 'origin'] }, { id: 'h', kind: 'horizontal', refs: ['e1'] }, { id: 'a', kind: 'distance', refs: ['c', 'm'], value: 30 }, { id: 'b', kind: 'distance', refs: ['c', 'n'], value: 12 }],
    });
    const r = s.solve();
    expect(r.status).toBe('ok');
    expect(r.dof).toBe(0);
    const p = r.values.points;
    expect(Math.abs(p.m[1])).toBeLessThan(1e-9);
    expect(Math.abs(p.m[0])).toBeCloseTo(30, 9);
    expect(Math.abs(p.n[0])).toBeLessThan(1e-9);
    expect(Math.abs(p.n[1])).toBeCloseTo(12, 9);
    s.dispose();
  });

  it('a point on an ellipse, a line tangent to it, equal ellipses, concentric with a circle', async () => {
    const s = await solver();
    s.load({
      points: { origin: [0, 0], c: [0, 0], m: [20, 0], n: [0, 10], q: [3, 7], l1: [-30, 12], l2: [30, 13], c2: [60, 0], m2: [75, 0], n2: [60, 4], cc: [1, 1] },
      entities: [
        { id: 'e1', kind: 'ellipse', c: 'c', major: 'm', minor: 'n' },
        { id: 'p1', kind: 'point', p: 'q' },
        { id: 'ln', kind: 'line', p: ['l1', 'l2'] },
        { id: 'e2', kind: 'ellipse', c: 'c2', major: 'm2', minor: 'n2' },
        { id: 'k', kind: 'circle', c: 'cc', r: 5 },
      ],
      constraints: [ORIGIN_FIX, fix('c'), fix('m'), fix('n'), { id: 'on', kind: 'point_on_circle', refs: ['q', 'e1'] }, { id: 't', kind: 'tangent', refs: ['ln', 'e1'] }, { id: 'eq', kind: 'equal', refs: ['e1', 'e2'] }, { id: 'cn', kind: 'concentric', refs: ['k', 'e1'] }],
    });
    const r = s.solve();
    expect(r.status).toBe('ok');
    const p = r.values.points;
    // q on x^2/400 + y^2/100 = 1
    expect(p.q[0] ** 2 / 400 + p.q[1] ** 2 / 100).toBeCloseTo(1, 8);
    // The line touches the ellipse: its distance-to-centre equals the support function.
    const d: V2 = [p.l2[0] - p.l1[0], p.l2[1] - p.l1[1]];
    const L = Math.hypot(d[0], d[1]);
    const nrm: V2 = [-d[1] / L, d[0] / L];
    const h = Math.abs(p.l1[0] * nrm[0] + p.l1[1] * nrm[1]);
    expect(h).toBeCloseTo(Math.sqrt(400 * nrm[0] ** 2 + 100 * nrm[1] ** 2), 7);
    expect(dist(p.c2, p.m2)).toBeCloseTo(20, 7);
    expect(across(p.c2, p.m2, p.n2)).toBeCloseTo(10, 7);
    expect(dist(p.cc, p.c)).toBeLessThan(1e-9);
    s.dispose();
  });

  it('a whole-ellipse drag moves it as a whole', async () => {
    const s = await solver();
    s.load({ ...ELLIPSE, constraints: [ORIGIN_FIX] });
    s.solve();
    expect(s.dragStartEntity('e1', [25, 3]).ok).toBe(true);
    s.dragMove(35, 13);
    const p = s.dragEnd().values.points;
    expect(dist(p.c, [15, 13])).toBeLessThan(1e-6);
    expect(dist(p.c, p.m)).toBeCloseTo(20, 6);
    s.dispose();
  });
});

describe('partial ellipses, parabolas and conics in the solver', () => {
  it('a partial ellipse has 7 freedoms; its ends stay on its ellipse', async () => {
    const s = await solver();
    const a = 20, b = 10;
    const P = (t: number): V2 => [a * Math.cos(t), b * Math.sin(t)];
    const sk = {
      points: { origin: [0, 0], c: [0, 0], m: [a, 0], n: [0, b], s: P(0.3), e: P(2.5) },
      entities: [{ id: 'ea', kind: 'ellipse_arc', c: 'c', major: 'm', minor: 'n', a: 's', b: 'e' }],
    };
    s.load({ ...sk, constraints: [ORIGIN_FIX] });
    const r = s.solve();
    expect(r.solved).toBe(true);
    expect(r.dof).toBe(7);
    expect(dist(r.values.points.s, P(0.3))).toBeLessThan(1e-9);
    // Fixed centre and axes, then the ends pulled to x = 10 and x = -15: they slide on the ellipse.
    s.load({ ...sk, constraints: [ORIGIN_FIX, fix('c'), fix('m'), fix('n'), { id: 'x1', kind: 'distance_x', refs: ['s'], value: 10 }, { id: 'x2', kind: 'distance_x', refs: ['e'], value: -15 }] });
    const q = s.solve();
    expect(q.dof).toBe(0);
    for (const k of ['s', 'e']) {
      const p = q.values.points[k];
      expect(p[0] ** 2 / 400 + p[1] ** 2 / 100).toBeCloseTo(1, 8);
    }
    s.dispose();
  });

  it('a line tangent to a partial ellipse at their shared end', async () => {
    const s = await solver();
    s.load({
      points: { origin: [0, 0], c: [0, 0], m: [20, 0], n: [0, 10], s: [20, 0], e: [0, 10], q: [21, -15] },
      entities: [
        { id: 'ea', kind: 'ellipse_arc', c: 'c', major: 'm', minor: 'n', a: 's', b: 'e' },
        { id: 'ln', kind: 'line', p: ['q', 's'] },
      ],
      constraints: [ORIGIN_FIX, fix('c'), fix('m'), fix('n'), fix('s'), { id: 't', kind: 'tangent', refs: ['ln', 'ea'] }],
    });
    const r = s.solve();
    expect(r.status).toBe('ok');
    // The tangent at the major end is vertical.
    expect(Math.abs(r.values.points.q[0] - 20)).toBeLessThan(1e-7);
    s.dispose();
  });

  it('a parabola has 6 freedoms; a point on it; horizontal turns its axis', async () => {
    const s = await solver();
    const sk = {
      points: { origin: [0, 0], f: [5, 0], v: [0, 0], a: [5, -10], b: [5, 10], q: [2, 5] },
      entities: [{ id: 'pb', kind: 'parabola', f: 'f', v: 'v', a: 'a', b: 'b' }, { id: 'pq', kind: 'point', p: 'q' }],
    };
    s.load({ ...sk, entities: [sk.entities[0]], points: { origin: [0, 0], f: [5, 0], v: [0, 0], a: [5, -10], b: [5, 10] }, constraints: [ORIGIN_FIX] });
    const r = s.solve();
    expect(r.solved).toBe(true);
    expect(r.dof).toBe(6);
    s.load({ ...sk, constraints: [ORIGIN_FIX, fix('v'), { id: 'fd', kind: 'distance', refs: ['v', 'f'], value: 5 }, { id: 'h', kind: 'horizontal', refs: ['pb'] }, { id: 'on', kind: 'coincident', refs: ['q', 'pb'] }] });
    const q = s.solve();
    expect(q.status).toBe('ok');
    const p = q.values.points;
    expect(Math.abs(p.f[1])).toBeLessThan(1e-9);
    // y^2 = 4 p x with p = 5 (the axis along +x or -x)
    expect(p.q[1] ** 2).toBeCloseTo(20 * Math.abs(p.q[0]), 7);
    for (const k of ['a', 'b']) expect(p[k][1] ** 2).toBeCloseTo(20 * Math.abs(p[k][0]), 7);
    s.dispose();
  });

  it('a conic has its points\' 6 freedoms; a line tangent at its end runs to its top point; on-curve refused', async () => {
    const s = await solver();
    const sk = {
      points: { origin: [0, 0], a: [0, 0], b: [40, 0], t: [10, 20], q: [-20, -7] },
      entities: [{ id: 'cn', kind: 'conic', a: 'a', b: 'b', t: 't', rho: 0.4 }, { id: 'ln', kind: 'line', p: ['q', 'a'] }],
    };
    s.load({ ...sk, points: { origin: [0, 0], a: [0, 0], b: [40, 0], t: [10, 20] }, entities: [sk.entities[0]], constraints: [ORIGIN_FIX] });
    expect(s.solve().dof).toBe(6);
    s.load({ ...sk, constraints: [ORIGIN_FIX, fix('a'), fix('b'), fix('t'), { id: 't1', kind: 'tangent', refs: ['ln', 'cn'] }] });
    const r = s.solve();
    expect(r.status).toBe('ok');
    const p = r.values.points;
    // q - a parallel to t - a
    expect(Math.abs(p.q[0] * 20 - p.q[1] * 10)).toBeLessThan(1e-6);
    expect(() => s.load({ ...sk, points: { ...sk.points, r: [5, 5] }, entities: [...sk.entities, { id: 'pr', kind: 'point', p: 'r' }], constraints: [ORIGIN_FIX, { id: 'on', kind: 'coincident', refs: ['r', 'cn'] }] })).toThrow(/only at its ends/);
    expect(() => s.load({ ...sk, entities: [{ ...sk.entities[0], rho: 1 }], constraints: [ORIGIN_FIX] })).toThrow(/rho/);
    s.dispose();
  });
});
