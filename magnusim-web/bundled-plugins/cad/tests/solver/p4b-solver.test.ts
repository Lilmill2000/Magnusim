// @vitest-environment node
// P4b sketch tools in the shipped solver (PlaneGCS wasm through solver-api.mjs): a spline's
// freedoms are its points' (DOF honest), tangency at a spline's end through its neighbour,
// a whole-spline drag, and the pattern ties (pattern_translate, pattern_rotate) that make a
// copy follow its source.
// SPDX-License-Identifier: GPL-3.0-or-later
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

type V2 = [number, number];
interface Solver {
  load(sketch: unknown): void;
  solve(): { status: string; dof: number; solved: boolean; values: { points: Record<string, V2> } };
  analyze(): { dof: number; perEntity: Record<string, string> };
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
const fixAll = (ids: string[]) => ids.map((id) => ({ id: `f_${id}`, kind: 'fix', refs: [id] }));

describe('P4b in the solver', () => {
  it('a spline has its points\' freedoms only: 4 fit points = 8 DOF, fixed = 0', async () => {
    const s = await solver();
    const sk = {
      points: { origin: [0, 0], a: [0, 0], b: [10, 5], c: [20, -5], d: [30, 0] },
      entities: [{ id: 's1', kind: 'spline', form: 'fit', pts: ['a', 'b', 'c', 'd'], degree: 3 }],
      constraints: [ORIGIN_FIX],
    };
    s.load(sk);
    expect(s.solve().dof).toBe(8);
    expect(s.analyze().perEntity.s1).toBe('under');
    s.load({ ...sk, constraints: [ORIGIN_FIX, ...fixAll(['a', 'b', 'c', 'd'])] });
    expect(s.solve().dof).toBe(0);
    expect(s.analyze().perEntity.s1).toBe('fully');
    s.load({ ...sk, constraints: [ORIGIN_FIX, { id: 'fx', kind: 'fix', refs: ['s1'] }] });
    expect(s.solve().dof).toBe(0);
    s.dispose();
  });

  it('a line tangent to a control spline at their shared end turns the line along the first leg', async () => {
    const s = await solver();
    s.load({
      points: { origin: [0, 0], p0: [0, 0], p1: [10, 10], p2: [20, 10], p3: [30, 0], q: [-10, 3] },
      entities: [
        { id: 's1', kind: 'spline', form: 'control', pts: ['p0', 'p1', 'p2', 'p3'], degree: 3 },
        { id: 'l1', kind: 'line', p: ['q', 'p0'] },
      ],
      constraints: [ORIGIN_FIX, ...fixAll(['p0', 'p1', 'p2', 'p3']), { id: 't', kind: 'tangent', refs: ['l1', 's1'] }],
    });
    const r = s.solve();
    expect(r.solved).toBe(true);
    const q = r.values.points.q;
    // q on the line through p0 along (p1 - p0) = (1, 1): q.x == q.y.
    expect(q[0]).toBeCloseTo(q[1], 6);
    s.dispose();
  });

  it('a fit spline is tangent at an end only through its handle', async () => {
    const s = await solver();
    const base = {
      points: { origin: [0, 0], a: [0, 0], b: [20, 10], c: [40, 0], h: [5, 5], q: [-10, 0] },
      entities: [
        { id: 's1', kind: 'spline', form: 'fit', pts: ['a', 'b', 'c'], degree: 3, handles: ['h', null] },
        { id: 'l1', kind: 'line', p: ['q', 'a'] },
      ],
      constraints: [ORIGIN_FIX, ...fixAll(['a', 'b', 'c', 'h']), { id: 't', kind: 'tangent', refs: ['l1', 's1'] }],
    };
    s.load(base);
    const r = s.solve();
    expect(r.values.points.q[0]).toBeCloseTo(r.values.points.q[1], 6);
    const noHandle = { ...base, entities: [{ ...base.entities[0], handles: undefined }, base.entities[1]] };
    expect(() => s.load(noHandle)).toThrow(/tangent handle/);
    s.dispose();
  });

  it('a whole spline drags (every point follows the pointer)', async () => {
    const s = await solver();
    s.load({
      points: { origin: [0, 0], a: [0, 0], b: [10, 5], c: [20, 0] },
      entities: [{ id: 's1', kind: 'spline', form: 'fit', pts: ['a', 'b', 'c'], degree: 3 }],
      constraints: [ORIGIN_FIX],
    });
    s.solve();
    expect(s.dragStartEntity('s1', [10, 5]).movable).toBe(true);
    s.dragMove(13, 9);
    const end = s.dragEnd();
    expect(end.values.points.a[0]).toBeCloseTo(3, 6);
    expect(end.values.points.c[1]).toBeCloseTo(4, 6);
    s.dispose();
  });

  it('pattern_shift and pattern_along: copies follow their sources (two directions, one along a line)', async () => {
    const s = await solver();
    s.load({
      points: { origin: [0, 0], a: [0, 0], b: [5, 2], a3: [29, 1], b3: [36, 2], ab: [12, 1], d0: [0, -10], d1: [1, -5], bb: [9, 19] },
      entities: [
        { id: 'l', kind: 'line', p: ['a', 'b'] },
        { id: 'l3', kind: 'line', p: ['a3', 'b3'] },
        { id: 'dir', kind: 'line', p: ['d0', 'd1'] },
      ],
      constraints: [
        ORIGIN_FIX,
        ...fixAll(['a', 'b', 'd0']),
        { id: 'v', kind: 'vertical', refs: ['dir'] },
        { id: 'p#0', kind: 'pattern_shift', refs: ['a', 'a3'], value: [30, 0] },
        { id: 'p#1', kind: 'pattern_shift', refs: ['b', 'b3'], value: [30, 0] },
        // 10 along the vertical line (its side kept: up), after a shift of (2, 0).
        { id: 'p#2', kind: 'pattern_along', refs: ['a', 'ab', 'dir'], value: [12, 0, 10] },
        { id: 'p#3', kind: 'pattern_along', refs: ['b', 'bb', 'dir'], value: [0, 0, 17] },
      ],
    });
    const r = s.solve();
    expect(r.solved).toBe(true);
    const P = r.values.points;
    expect(P.a3).toEqual([expect.closeTo(30, 6), expect.closeTo(0, 6)]);
    expect(P.b3).toEqual([expect.closeTo(35, 6), expect.closeTo(2, 6)]);
    expect(P.ab[0]).toBeCloseTo(12, 6);
    expect(P.ab[1]).toBeCloseTo(10, 6);
    expect(P.bb[0]).toBeCloseTo(5, 6);
    expect(P.bb[1]).toBeCloseTo(19, 6);
    s.dispose();
  });

  it('offset: a line copy parallel at the distance with its ends squared; an arc copy on the same centre', async () => {
    const s = await solver();
    s.load({
      points: { origin: [0, 0], a: [0, 0], b: [20, 0], c: [3, 4], d: [22, 6], o: [40, 0], s: [50, 0], e: [40, 10], s2: [53, 1], e2: [41, 13] },
      entities: [
        { id: 'src', kind: 'line', p: ['a', 'b'] },
        { id: 'cp', kind: 'line', p: ['c', 'd'] },
        { id: 'arc', kind: 'arc', c: 'o', a: 's', b: 'e' },
        { id: 'arc2', kind: 'arc', c: 'o', a: 's2', b: 'e2' },
      ],
      constraints: [
        ORIGIN_FIX,
        ...fixAll(['a', 'b', 'o', 's', 'e']),
        { id: 'o#0', kind: 'parallel', refs: ['cp', 'src'] },
        { id: 'o#1', kind: 'distance', refs: ['c', 'src'], value: 5 },
        { id: 'o#2', kind: 'offset_end', refs: ['a', 'c', 'src'] },
        { id: 'o#3', kind: 'offset_end', refs: ['b', 'd', 'src'] },
        { id: 'o#4', kind: 'distance', refs: ['s2', 'arc'], value: 3 },
        { id: 'o#5', kind: 'offset_end', refs: ['s', 's2', 'arc'] },
        { id: 'o#6', kind: 'offset_end', refs: ['e', 'e2', 'arc'] },
      ],
    });
    const r = s.solve();
    expect(r.solved).toBe(true);
    expect(r.dof).toBe(0);
    const P = r.values.points;
    expect(P.c[0]).toBeCloseTo(0, 6);
    expect(P.c[1]).toBeCloseTo(5, 6);
    expect(P.d[0]).toBeCloseTo(20, 6);
    expect(P.d[1]).toBeCloseTo(5, 6);
    expect(P.s2[0]).toBeCloseTo(53, 6);
    expect(P.s2[1]).toBeCloseTo(0, 6);
    expect(P.e2[0]).toBeCloseTo(40, 6);
    expect(P.e2[1]).toBeCloseTo(13, 6);
    s.dispose();
  });

  it('two concentric circles at a distance (offset of a circle)', async () => {
    const s = await solver();
    s.load({
      points: { origin: [0, 0], c: [0, 0] },
      entities: [
        { id: 'c1', kind: 'circle', c: 'c', r: 10 },
        { id: 'c2', kind: 'circle', c: 'c', r: 12.5 },
      ],
      constraints: [ORIGIN_FIX, { id: 'cc', kind: 'coincident', refs: ['c', 'origin'] }, { id: 'r', kind: 'radius', refs: ['c1'], value: 10 }, { id: 'o#0', kind: 'distance', refs: ['c2', 'c1'], value: 4 }],
    });
    const r = s.solve();
    expect(r.solved).toBe(true);
    expect(r.dof).toBe(0);
    expect((r.values as unknown as { radii: Record<string, number> }).radii.c2).toBeCloseTo(14, 6);
    s.dispose();
  });

  it('pattern_rotate: a copy at 90 degrees about a centre', async () => {
    const s = await solver();
    s.load({
      points: { origin: [0, 0], p: [10, 0], q: [1, 9], c: [0, 0] },
      entities: [
        { id: 'pp', kind: 'point', p: 'p' },
        { id: 'pq', kind: 'point', p: 'q' },
      ],
      constraints: [ORIGIN_FIX, { id: 'cc', kind: 'coincident', refs: ['c', 'origin'] }, ...fixAll(['p']), { id: 'r#q', kind: 'pattern_rotate', refs: ['c', 'p', 'q'], value: 90 }],
    });
    const r = s.solve();
    expect(r.solved).toBe(true);
    expect(r.dof).toBe(0);
    expect(r.values.points.q[0]).toBeCloseTo(0, 6);
    expect(r.values.points.q[1]).toBeCloseTo(10, 6);
    s.dispose();
  });
});

describe('P4b fix 1: a point on a spline (sliding)', () => {
  it('a point held on a control spline slides along it (1 DOF), and follows when a pole moves', async () => {
    const s = await solver();
    const base = {
      points: { origin: [0, 0], s0: [0, 0], s1: [10, 20], s2: [30, 20], s3: [40, 0], p: [20, 15.2] },
      entities: [
        { id: 'sp', kind: 'spline', form: 'control', pts: ['s0', 's1', 's2', 's3'], degree: 3 },
        { id: 'pp', kind: 'point', p: 'p' },
      ],
      constraints: [ORIGIN_FIX, ...fixAll(['s0', 's1', 's2', 's3']), { id: 'on', kind: 'point_on_circle', refs: ['p', 'sp'] }],
    };
    s.load(base);
    const r = s.solve();
    expect(r.solved).toBe(true);
    expect(r.dof).toBe(1);
    // On the curve: the cubic Bezier at x = 20 is y = 15.
    expect(r.values.points.p[1]).toBeCloseTo(15, 6);
    // Pole s1 up 6 (y 20 -> 26, a fixed point): the point stays on the new curve.
    s.load({ ...base, points: { ...base.points, s1: [10, 26] } });
    const r2 = s.solve();
    const x = r2.values.points.p[0];
    const t = solveBezierT(x, [0, 10, 30, 40]);
    const y = (1 - t) ** 3 * 0 + 3 * (1 - t) ** 2 * t * 26 + 3 * (1 - t) * t ** 2 * 20 + t ** 3 * 0;
    expect(r2.values.points.p[1]).toBeCloseTo(y, 6);
    s.dispose();
  });

  it('a point held on a fit spline stays on it after the fit points move (the frozen parameters are refreshed)', async () => {
    const s = await solver();
    s.load({
      points: { origin: [0, 0], a: [0, 0], b: [15, 12], c: [30, -4], d: [45, 8], p: [22, 3], q: [22, 40] },
      entities: [
        { id: 'sp', kind: 'spline', form: 'fit', pts: ['a', 'b', 'c', 'd'], degree: 3 },
        { id: 'l', kind: 'line', p: ['q', 'p'] },
      ],
      constraints: [ORIGIN_FIX, ...fixAll(['a', 'c', 'd', 'q']), { id: 'v', kind: 'vertical', refs: ['l'] }, { id: 'on', kind: 'coincident', refs: ['p', 'sp'] }, { id: 'by', kind: 'distance_y', refs: ['b'], value: 20 }, { id: 'bx', kind: 'distance_x', refs: ['b'], value: 15 }],
    });
    const r = s.solve();
    expect(r.solved).toBe(true);
    expect(r.dof).toBe(0);
    const P = r.values.points;
    const { fitSpline, closestOnSpline } = await import('../../src/sketch/tools/bspline');
    const curve = fitSpline([P.a, P.b, P.c, P.d] as V2[]);
    expect(closestOnSpline(curve, P.p).d).toBeLessThan(1e-8);
    expect(P.p[0]).toBeCloseTo(22, 9);
    s.dispose();
  });
});

function solveBezierT(x: number, xs: number[]): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 80; i++) {
    const t = (lo + hi) / 2;
    const v = (1 - t) ** 3 * xs[0] + 3 * (1 - t) ** 2 * t * xs[1] + 3 * (1 - t) * t ** 2 * xs[2] + t ** 3 * xs[3];
    if (v < x) lo = t;
    else hi = t;
  }
  return (lo + hi) / 2;
}
