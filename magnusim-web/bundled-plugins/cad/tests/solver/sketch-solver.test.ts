// @vitest-environment node
// The shipped solver (workspace/solver/planegcs.*, src/solver-worker/solver-api.mjs)
// with sketch mode's own solver sketch (src/sketch/model.ts toSolverSketch):
// the P3 exit numbers (a rectangle from the origin has 2 DOF, two dimensions
// define it fully, a diagonal over-defines it), entity drags (a line
// translates, a circle's edge sets its radius), a fully defined point that
// does not move, and the over-defined analysis budget (P0 decision 2: about
// 1,000 parameters within 300 ms, off the main thread in the worker).
// SPDX-License-Identifier: GPL-3.0-or-later
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { toSolverSketch } from '../../src/sketch/model';
import type { SketchConstraint, SketchEntity, Vec2 } from '../../src/types/doc';
import type { SolverAnalysis, SolverSketch, SolverSolveResult, SolverValues } from '../../src/types/sketch';
import { circle, merge, rectangle } from '../sketch/fixtures';

interface Solver {
  load(sketch: SolverSketch): unknown;
  solve(): SolverSolveResult;
  analyze(): SolverAnalysis;
  dragStart(point: string): { ok: boolean; movable: boolean };
  dragStartEntity(entity: string, grab: Vec2): { ok: boolean; movable: boolean };
  dragMove(u: number, v: number): { status: string; values?: SolverValues };
  dragEnd(): SolverSolveResult;
  dispose(): void;
}

const API = pathToFileURL(fileURLToPath(new URL('../../src/solver-worker/solver-api.mjs', import.meta.url))).href;
const MODULE = pathToFileURL(fileURLToPath(new URL('../../workspace/solver/planegcs.mjs', import.meta.url))).href;

async function solver(): Promise<Solver> {
  const { createSolver } = (await import(/* @vite-ignore */ API)) as { createSolver(o: { moduleUrl: string }): Promise<Solver> };
  return createSolver({ moduleUrl: MODULE });
}

const dim = (id: string, kind: 'distance' | 'diameter', refs: string[], expr: string, driving = true): SketchConstraint => ({ id, kind, refs, expr, driving });

describe('sketch mode on the real solver', () => {
  it('a rectangle from the origin: 2 DOF; 40 x 20 fully defined; a diagonal is redundant; driven it is measured', async () => {
    const s = await solver();
    const rect = rectangle(0.3, 0.2, 38, 21, { origin: true });
    s.load(toSolverSketch(rect));
    const a = s.solve();
    expect(a.solved).toBe(true);
    expect(a.dof).toBe(2);
    expect(s.analyze().dof).toBe(2);
    expect(a.values.points.p1[0]).toBeCloseTo(0, 9);

    const dims = { ...rect, constraints: [...rect.constraints, dim('d40', 'distance', ['e1'], '40 mm'), dim('d20', 'distance', ['e2'], '20 mm')] };
    s.load(toSolverSketch(dims, { d40: 40, d20: 20 }));
    const b = s.solve();
    expect(b.dof).toBe(0);
    const an = s.analyze();
    expect(an.dof).toBe(0);
    expect(Object.values(an.perEntity).every((x) => x === 'fully')).toBe(true);
    expect(b.values.points.p3[0]).toBeCloseTo(40, 9);
    expect(b.values.points.p3[1]).toBeCloseTo(20, 9);

    // The diagonal at the value it measures: redundant (the "Make it driven?" case).
    const geo = { ...dims, points: { ...dims.points, ...b.values.points } };
    delete (geo.points as Record<string, Vec2>).origin;
    const diag = { ...geo, constraints: [...geo.constraints, dim('dd', 'distance', ['p1', 'p3'], '44.72 mm')] };
    s.load(toSolverSketch(diag, { d40: 40, d20: 20 }));
    const c = s.solve();
    expect([...c.redundant, ...c.conflicting].length).toBeGreaterThan(0);
    // Driven: not given to the solver, measured from the geometry.
    const driven = { ...geo, constraints: [...geo.constraints, dim('dd', 'distance', ['p1', 'p3'], '44.72 mm', false)] };
    s.load(toSolverSketch(driven, { d40: 40, d20: 20 }));
    const d = s.solve();
    expect(d.status).toBe('ok');
    expect(d.dof).toBe(0);
    expect(d.values.measures.dd).toBeCloseTo(Math.hypot(40, 20), 9);
    s.dispose();
  });

  it('a fully defined corner does not drag; with one dimension less it does', async () => {
    const s = await solver();
    const rect = rectangle(0, 0, 40, 20, { origin: true });
    const full = { ...rect, constraints: [...rect.constraints, dim('d40', 'distance', ['e1'], '40 mm'), dim('d20', 'distance', ['e2'], '20 mm')] };
    s.load(toSolverSketch(full, { d40: 40, d20: 20 }));
    s.solve();
    expect(s.dragStart('p3').movable).toBe(false);
    s.dragEnd();
    const one = { ...rect, constraints: [...rect.constraints, dim('d40', 'distance', ['e1'], '40 mm')] };
    s.load(toSolverSketch(one, { d40: 40 }));
    expect(s.solve().dof).toBe(1);
    expect(s.dragStart('p3').movable).toBe(true);
    s.dragMove(40, 33);
    const end = s.dragEnd();
    expect(end.values.points.p3[0]).toBeCloseTo(40, 6);
    expect(end.values.points.p3[1]).toBeCloseTo(33, 6);
    expect(end.values.points.p4[1]).toBeCloseTo(33, 6);
    s.dispose();
  });

  it('dragging a line translates it; dragging a circle edge sets its radius', async () => {
    const s = await solver();
    const g = merge(
      { points: { a: [0, 0], b: [10, 5] }, entities: [{ id: 'l', kind: 'line', p: ['a', 'b'] } as SketchEntity], constraints: [] },
      circle('c', [50, 0], 10),
    );
    s.load(toSolverSketch(g));
    s.solve();
    expect(s.dragStartEntity('l', [5, 2.5]).movable).toBe(true);
    s.dragMove(8, 6.5);
    const moved = s.dragEnd().values.points;
    expect(moved.a[0]).toBeCloseTo(3, 5);
    expect(moved.a[1]).toBeCloseTo(4, 5);
    expect(moved.b[0]).toBeCloseTo(13, 5);
    expect(moved.b[1]).toBeCloseTo(9, 5);
    s.load(toSolverSketch(g));
    s.solve();
    expect(s.dragStartEntity('c', [60, 0]).movable).toBe(true);
    s.dragMove(65, 0);
    const r = s.dragEnd();
    expect(r.values.radii.c).toBeCloseTo(15, 4);
    expect(r.values.points.cc[0]).toBeCloseTo(50, 4);
    s.dispose();
  });

  it('drags a point of a 200-entity sketch within 4 ms a move (plan §3.5)', async () => {
    const s = await solver();
    const parts = Array.from({ length: 50 }, (_, i) => {
      const r = rectangle(i * 50, 0, 40, 20);
      const ren = (id: string) => `${id}_${i}`;
      return {
        points: Object.fromEntries(Object.entries(r.points).map(([k, v]) => [ren(k), v])),
        entities: r.entities.map((e) => ({ ...e, id: ren(e.id), p: (e as { p: [string, string] }).p.map(ren) as [string, string] }) as SketchEntity),
        constraints: r.constraints.map((c) => ({ ...c, id: ren(c.id), refs: c.refs.map(ren) })),
      };
    });
    const g = merge(...parts);
    expect(g.entities).toHaveLength(200);
    s.load(toSolverSketch(g));
    s.solve();
    expect(s.dragStart('p3_25').movable).toBe(true);
    const times: number[] = [];
    for (let k = 1; k <= 30; k++) {
      const t0 = performance.now();
      const r = s.dragMove(1290 + k * 0.5, 20 + k * 0.3);
      times.push(performance.now() - t0);
      expect(r.status).toBe('ok');
    }
    s.dragEnd();
    times.sort((a, b) => a - b);
    console.log(`[solver] drag move, 200 entities: median ${times[15].toFixed(2)} ms, max ${times[29].toFixed(2)} ms`);
    expect(times[15]).toBeLessThanOrEqual(4);
    s.dispose();
  });

  it('analyses an over-defined sketch of about 1,000 parameters within 300 ms', async () => {
    const s = await solver();
    // A chain of 160 rectangles sharing edges (about 1,000 parameters), dimensioned, plus conflicting dimensions.
    const points: Record<string, Vec2> = {};
    const entities: SketchEntity[] = [];
    const constraints: SketchConstraint[] = [];
    const n = 160;
    for (let i = 0; i <= n; i++) {
      points[`b${i}`] = [i * 10 + 0.1 * (i % 3), 0.05 * (i % 2)];
      points[`t${i}`] = [i * 10, 8 + 0.1 * (i % 2)];
      entities.push({ id: `v${i}`, kind: 'line', p: [`b${i}`, `t${i}`] });
      constraints.push({ id: `vv${i}`, kind: 'vertical', refs: [`v${i}`] }, dim(`dv${i}`, 'distance', [`v${i}`], '8 mm'));
      if (i > 0) {
        entities.push({ id: `hb${i}`, kind: 'line', p: [`b${i - 1}`, `b${i}`] }, { id: `ht${i}`, kind: 'line', p: [`t${i - 1}`, `t${i}`] });
        constraints.push({ id: `hh${i}`, kind: 'horizontal', refs: [`hb${i}`] }, dim(`dh${i}`, 'distance', [`hb${i}`], '10 mm'));
      }
    }
    constraints.push({ id: 'pin', kind: 'coincident', refs: ['b0', 'origin'] });
    // Over-define: the top edges are horizontal too (redundant with the verticals' equal heights),
    // and one height is given twice with another value (conflicting).
    for (let i = 1; i <= n; i += 7) constraints.push({ id: `hx${i}`, kind: 'horizontal', refs: [`ht${i}`] });
    constraints.push(dim('bad', 'distance', ['v5'], '9 mm'));
    const values: Record<string, number> = {};
    for (const c of constraints) if ('expr' in c) values[c.id] = parseFloat(c.expr);
    const info = s.load(toSolverSketch({ points, entities, constraints }, values)) as { params: number };
    expect(info.params).toBeGreaterThanOrEqual(900);
    const times: number[] = [];
    let a: SolverAnalysis | null = null;
    for (let k = 0; k < 3; k++) {
      a = s.analyze();
      times.push(a.ms);
    }
    times.sort((x, y) => x - y);
    console.log(`[solver] over-defined analysis of ${info.params} parameters: ${times.map((t) => t.toFixed(0)).join(', ')} ms`);
    expect(a!.conflicting.length + a!.redundant.length).toBeGreaterThan(0);
    expect(times[1]).toBeLessThanOrEqual(300);
    s.dispose();
  });
});
