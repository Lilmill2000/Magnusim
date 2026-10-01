// @vitest-environment node
// The shipped solver (workspace/solver/planegcs.*) through src/solver-worker/solver-api.mjs:
// a rectangle with two dimensions is fully defined; with one it has 1 DOF.
// Owner: the P3 sketcher (extend with the P0 reference sketches).
// SPDX-License-Identifier: GPL-3.0-or-later
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

interface Solver {
  load(sketch: unknown): void;
  solve(): { status: string; dof: number };
  analyze(): { dof: number };
  dispose(): void;
}

const API = pathToFileURL(fileURLToPath(new URL('../../src/solver-worker/solver-api.mjs', import.meta.url))).href;
const MODULE = pathToFileURL(fileURLToPath(new URL('../../workspace/solver/planegcs.mjs', import.meta.url))).href;

function rectangle(dims: number) {
  const constraints: unknown[] = [
    { id: 'c1', kind: 'coincident', refs: ['p1', 'o'] },
    { id: 'c2', kind: 'horizontal', refs: ['l1'] },
    { id: 'c3', kind: 'horizontal', refs: ['l3'] },
    { id: 'c4', kind: 'vertical', refs: ['l2'] },
    { id: 'c5', kind: 'vertical', refs: ['l4'] },
    { id: 'c6', kind: 'fix', refs: ['o'] },
  ];
  if (dims >= 1) constraints.push({ id: 'd1', kind: 'distance', refs: ['p1', 'p2'], value: 40 });
  if (dims >= 2) constraints.push({ id: 'd2', kind: 'distance', refs: ['p2', 'p3'], value: 20 });
  return {
    points: { o: [0, 0], p1: [0.5, 0.2], p2: [38, 1], p3: [39, 22], p4: [1, 19] },
    entities: [
      { id: 'po', kind: 'point', p: 'o' },
      { id: 'l1', kind: 'line', p: ['p1', 'p2'] },
      { id: 'l2', kind: 'line', p: ['p2', 'p3'] },
      { id: 'l3', kind: 'line', p: ['p3', 'p4'] },
      { id: 'l4', kind: 'line', p: ['p4', 'p1'] },
    ],
    constraints,
  };
}

describe('solver (PlaneGCS wasm, Node)', () => {
  it('solves a dimensioned rectangle and reports DOF', async () => {
    const { createSolver } = (await import(/* @vite-ignore */ API)) as { createSolver(o: { moduleUrl: string }): Promise<Solver> };
    const s = await createSolver({ moduleUrl: MODULE });
    s.load(rectangle(2));
    const full = s.solve();
    expect(['ok', 'success']).toContain(String(full.status).toLowerCase());
    expect(s.analyze().dof).toBe(0);
    s.load(rectangle(1));
    s.solve();
    expect(s.analyze().dof).toBe(1);
    s.dispose();
  });
});
