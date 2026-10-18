// @vitest-environment node
// The sketch tool's table of the refs the solver takes (src/assistant/sketch/signatures.ts, CAD
// tools spec §6.3) against the real solver (solver-api.mjs over the shipped PlaneGCS wasm, in this
// process): every row loads and solves there; every other combination of ref kinds (one to three
// refs of point, line, circle, arc) is refused by the solver as well (collinear: the Part writes it
// only from two lines, its first two refs; the tool takes exactly those two); symmetric takes point, point, point (the person's tool never makes it);
// a ref the table refuses answers bad_ref with the forms its kind takes.
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createUnitsService } from '../../src/doc/units';
import { compileSketch } from '../../src/assistant/sketch/compile';
import { matchSignature, signatureWords, SIGNATURES, toolKindOf, type SigKind, type ToolConstraintKind } from '../../src/assistant/sketch/signatures';
import { SKETCH_CONSTRAINT_KINDS } from '../../src/assistant/schemas';
import { toSolverSketch } from '../../src/sketch/model';
import type { SketchConstraint, SketchEntity, SketchFeature, Vec2 } from '../../src/types/doc';
import type { SketchSolverClient } from '../../src/types/sketch';
import { solverAnywhere } from './solver-anywhere';

let solver: SketchSolverClient;
beforeAll(async () => {
  solver = await solverAnywhere();
}, 60_000);
afterAll(() => solver?.dispose());

const KINDS: SigKind[] = ['point', 'line', 'circle', 'arc'];

/** One of each kind twice (three points), in a sketch the solver can move freely. */
function fixture(): Pick<SketchFeature, 'points' | 'entities' | 'constraints'> {
  const points: Record<string, Vec2> = {
    p1: [1, 1],
    p2: [2, 3],
    p3: [5, 5],
    l1a: [0, 0],
    l1b: [10, 0],
    l2a: [0, 5],
    l2b: [10, 6],
    l3b: [15, 4],
    c1c: [5, 10],
    c2c: [20, 10],
    a1c: [30, 0],
    a1s: [34, 0],
    a1e: [30, 4],
    a2c: [40, 0],
    a2s: [43, 0],
    a2e: [37, 0],
  };
  const entities: SketchEntity[] = [
    { id: 'q1', kind: 'point', p: 'p1' },
    { id: 'q2', kind: 'point', p: 'p2' },
    { id: 'q3', kind: 'point', p: 'p3' },
    { id: 'l1', kind: 'line', p: ['l1a', 'l1b'] },
    { id: 'l2', kind: 'line', p: ['l2a', 'l2b'] },
    // l3 starts where l1 ends (tangent of two lines needs a shared end).
    { id: 'l3', kind: 'line', p: ['l1b', 'l3b'] },
    { id: 'c1', kind: 'circle', c: 'c1c', r: 3 },
    { id: 'c2', kind: 'circle', c: 'c2c', r: 2 },
    { id: 'a1', kind: 'arc', c: 'a1c', a: 'a1s', b: 'a1e' },
    { id: 'a2', kind: 'arc', c: 'a2c', a: 'a2s', b: 'a2e' },
  ];
  return { points, entities, constraints: [] };
}

/** Distinct refs of the kinds asked, in order (two lines that share an end when asked). */
function refsFor(kinds: readonly SigKind[], sharedEnd = false): string[] {
  const pools: Record<SigKind, string[]> = { point: ['q1', 'q2', 'q3'], line: sharedEnd ? ['l1', 'l3'] : ['l1', 'l2'], circle: ['c1', 'c2'], arc: ['a1', 'a2'] };
  const used: Record<SigKind, number> = { point: 0, line: 0, circle: 0, arc: 0 };
  return kinds.map((k) => pools[k][used[k]++]);
}

const VALUES: Record<string, number> = { distance: 7, distance_x: 3, distance_y: 2, radius: 2, diameter: 5, angle: 30 };

function withConstraint(kind: string, refs: string[]) {
  const f = fixture();
  const c = (kind in VALUES ? { id: 'k', kind, refs, expr: String(VALUES[kind]), driving: true } : { id: 'k', kind, refs }) as SketchConstraint;
  return { ...f, constraints: [c] };
}

async function loads(kind: string, refs: string[]): Promise<{ ok: true; solved: boolean } | { ok: false; error: string }> {
  const f = withConstraint(kind, refs);
  const sk = toSolverSketch(f, { k: VALUES[kind] ?? 0 });
  try {
    await solver.load(sk);
    const r = (await solver.solve()) as { solved: boolean };
    return { ok: true, solved: r.solved };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Every list of one to three ref kinds. */
function combos(): SigKind[][] {
  const out: SigKind[][] = [];
  for (const a of KINDS) {
    out.push([a]);
    for (const b of KINDS) {
      out.push([a, b]);
      for (const c of KINDS) out.push([a, b, c]);
    }
  }
  return out;
}

describe("the solver's signatures", () => {
  it('cover every relation and dimension the tool takes', () => {
    expect(Object.keys(SIGNATURES).sort()).toEqual([...SKETCH_CONSTRAINT_KINDS].sort());
    expect(toolKindOf('point_on_line')).toBe('point_on');
    expect(toolKindOf('point_on_circle')).toBe('point_on');
    expect(toolKindOf('fix')).toBeNull();
  });

  it('every row loads and solves on the real solver', async () => {
    for (const kind of SKETCH_CONSTRAINT_KINDS) {
      for (const sig of SIGNATURES[kind]) {
        const r = await loads(sig.stored, refsFor(sig.refs, !!sig.sharedEnd));
        expect(r, `${kind} ${sig.refs.join(',')}`).toEqual({ ok: true, solved: true });
      }
    }
  }, 60_000);

  it('every other combination of ref kinds is refused by the solver too', async () => {
    for (const kind of SKETCH_CONSTRAINT_KINDS) {
      const stored = [...new Set(SIGNATURES[kind].map((s) => s.stored))];
      for (const kinds of combos()) {
        for (const st of stored) {
          // Tangent of two lines away from a shared end is refused; at a shared end it is a row.
          if (matchSignature(kind, kinds, false)) continue;
          const own = SIGNATURES[kind].some((s) => s.stored === st && s.refs.length === kinds.length && s.refs.every((k, i) => k === kinds[i]) && !s.sharedEnd);
          if (own) continue;
          const r = await loads(st, refsFor(kinds));
          if (kind === 'collinear' && r.ok) {
            // The Part writes collinear only between two lines (from its first two refs): anything
            // else gives the solver nothing. The tool takes exactly two lines.
            const sk = toSolverSketch(withConstraint(st, refsFor(kinds)), {});
            const given = sk.constraints.filter((c) => c.id.startsWith('k'));
            if (given.length) expect(kinds.slice(0, 2), kinds.join(',')).toEqual(['line', 'line']);
            continue;
          }
          expect(r.ok, `${kind} (${st}) ${kinds.join(',')} should be refused`).toBe(false);
        }
      }
    }
  }, 120_000);

  it('symmetric takes point, point, point; bad_ref names the forms a kind takes', () => {
    expect(matchSignature('symmetric', ['point', 'point', 'point'], false)?.stored).toBe('symmetric');
    expect(signatureWords('symmetric')).toBe('point, point, line or point, point, point');
    expect(signatureWords('tangent')).toContain('line, line (sharing an end)');
    const units = createUnitsService(() => ({ length: 'mm', angle: 'deg' }));
    const bad = () =>
      compileSketch(
        {
          entities: [
            { id: 'a', kind: 'point', at: [0, 0], construction: false },
            { id: 'b', kind: 'point', at: [10, 0], construction: false },
            { id: 'c', kind: 'circle', at: [5, 5, 2], construction: false },
          ],
          constraints: [{ id: 's', kind: 'symmetric', refs: ['a', 'b', 'c'], value: '' }],
          infer: false,
        },
        { units, stored: null },
      );
    expect(bad).toThrow(/bad_ref: constraints\[0\] \(s\): symmetric does not take point, point, circle \(a, b, c\); it takes point, point, line or point, point, point/);
    try {
      bad();
    } catch (e) {
      expect((e as { hint: string }).hint).toBe('symmetric takes point, point, line or point, point, point; read help sketch for the others.');
    }
  });

  it("keeps the model's order as written: distance_x [p, q] is q.u - p.u", async () => {
    const kinds: ToolConstraintKind = 'distance_x';
    expect(matchSignature(kinds, ['point', 'point'], false)?.stored).toBe('distance_x');
    const f = withConstraint('distance_x', ['q2', 'q1']);
    await solver.load(toSolverSketch(f, { k: 4 }));
    const r = (await solver.solve()) as { values: { points: Record<string, Vec2> } };
    expect(r.values.points.p1[0] - r.values.points.p2[0]).toBeCloseTo(4, 9);
  });
});
