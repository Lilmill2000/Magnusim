// @vitest-environment node
// The sketch tool's table of the refs the solver takes (src/assistant/sketch/signatures.ts, CAD
// tools spec §6.3) against the real solver (solver-api.mjs over the shipped PlaneGCS wasm, in this
// process): every row loads and solves there; every other combination of ref kinds (one to three
// refs of point, line, circle, arc) is refused by the solver as well (collinear: the Part writes it
// only from two lines, its first two refs; the tool takes exactly those two; tangent with a point:
// the solver takes any point, and there it only lines up the curves' normals, so away from an end of
// both curves the "tangent" curves miss each other: the tool takes it only at such an end, where it
// is tangency); symmetric takes point, point, point (the person's tool never makes it);
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
    // a3 starts where l1 ends; a4 starts where a3 ends.
    a3c: [10, 5],
    a3e: [15, 5],
    a4c: [20, 5],
    a4e: [25, 5],
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
    { id: 'a3', kind: 'arc', c: 'a3c', a: 'l1b', b: 'a3e' },
    { id: 'a4', kind: 'arc', c: 'a4c', a: 'a3e', b: 'a4e' },
  ];
  return { points, entities, constraints: [] };
}

/** Two curves of these kinds that share an end, and that end. */
const SHARED: Record<string, string[]> = {
  'line,line': ['l1', 'l3', 'l1b'],
  'line,arc': ['l1', 'a3', 'l1b'],
  'arc,line': ['a3', 'l1', 'l1b'],
  'arc,arc': ['a3', 'a4', 'a3e'],
};

/** Distinct refs of the kinds asked, in order (two curves that share an end when asked, and that end as a third ref). */
function refsFor(kinds: readonly SigKind[], sharedEnd = false): string[] {
  if (sharedEnd && kinds.length === 3) return SHARED[kinds.slice(0, 2).join(',')];
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
          if (kind === 'tangent' && kinds.length === 3 && kinds[2] === 'point' && kinds[0] !== 'point' && kinds[1] !== 'point') {
            // The solver takes two curves and any point; the tool only an end of both (below).
            expect(r, kinds.join(',')).toEqual({ ok: true, solved: true });
            continue;
          }
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

  it('tangent with a point away from an end of both curves is no tangency on the solver; the tool refuses it, and takes it at a shared end', async () => {
    // The solver's three-ref form at a point on neither curve: "solved", the line misses the circle.
    const g = {
      points: { la: [0, 0], lb: [10, 0], cc: [5, 8] },
      entities: [
        { id: 'l', kind: 'line', p: ['la', 'lb'] },
        { id: 'c', kind: 'circle', c: 'cc', r: 3 },
      ],
      constraints: [{ id: 'k', kind: 'tangent', refs: ['l', 'c', 'lb'] }],
    } as unknown as Pick<SketchFeature, 'points' | 'entities' | 'constraints'>;
    await solver.load(toSolverSketch(g, {}));
    const r = (await solver.solve()) as { solved: boolean; conflicting: string[]; redundant: string[]; values: { points: Record<string, Vec2>; radii: Record<string, number> } };
    expect(r).toMatchObject({ solved: true, conflicting: [], redundant: [] });
    const P = r.values.points;
    const off = Math.abs((P.lb[0] - P.la[0]) * (P.cc[1] - P.la[1]) - (P.lb[1] - P.la[1]) * (P.cc[0] - P.la[0])) / Math.hypot(P.lb[0] - P.la[0], P.lb[1] - P.la[1]);
    expect(Math.abs(off - (r.values.radii.c ?? 3))).toBeGreaterThan(1);
    // The table: never a circle, and only at an end of both.
    expect(matchSignature('tangent', ['line', 'circle', 'point'], true)).toBeNull();
    expect(matchSignature('tangent', ['line', 'arc', 'point'], true)?.stored).toBe('tangent');
    expect(matchSignature('tangent', ['line', 'arc', 'point'], false)).toBeNull();
    expect(signatureWords('tangent')).toContain('line, arc, point (the point an end of both)');
    expect(signatureWords('tangent')).not.toContain('circle, point');
    const units = createUnitsService(() => ({ length: 'mm', angle: 'deg' }));
    const compile = (entities: { id: string; kind: string; at: number[] }[], refs: string[]) =>
      compileSketch({ entities: entities.map((e) => ({ ...e, construction: false })), constraints: [{ id: 'k', kind: 'tangent', refs, value: '' }], infer: false }, { units, stored: null });
    const refused = (f: () => unknown) => {
      try {
        f();
      } catch (e) {
        return e as { message: string; hint: string };
      }
      throw new Error('not refused');
    };
    // A line's end beside a circle (a circle has no ends).
    const lc = refused(() => compile([{ id: 'l', kind: 'line', at: [0, 0, 10, 0] }, { id: 'c', kind: 'circle', at: [5, 8, 3] }], ['l', 'c', 'l.end']));
    expect(lc.message).toBe(`bad_ref: constraints[0] (k): tangent does not take line, circle, point (l, c, l.end); it takes ${signatureWords('tangent')}.`);
    expect(lc.hint).toBe(`tangent takes ${signatureWords('tangent')}; read help sketch for the others.`);
    // Two lines that meet, and a point that is not where they meet.
    const lines = [
      { id: 'a', kind: 'line', at: [0, 0, 10, 0] },
      { id: 'b', kind: 'line', at: [10, 0, 20, 5] },
      { id: 'q', kind: 'point', at: [3, 3] },
    ];
    expect(refused(() => compile(lines, ['a', 'b', 'q'])).message).toContain('constraints[0] (k): tangent (a, b, q) needs q to be an end of both a and b, where they meet; it takes');
    expect(refused(() => compile(lines, ['a', 'b', 'a.start'])).message).toContain('needs a.start to be an end of both a and b, where they meet');
    // Where they meet (a.end and b.start joined): taken, as the point the two lines share.
    const ok = compile(lines, ['a', 'b', 'a.end']);
    expect(ok.draft.constraints.find((c) => c.id === 'k')).toEqual({ id: 'k', kind: 'tangent', refs: ['a', 'b', 'a__end'] });
    // Two lines that do not meet: two refs need a shared end.
    expect(refused(() => compile([lines[0], { id: 'b', kind: 'line', at: [12, 0, 20, 5] }], ['a', 'b'])).message).toContain('tangent (a, b) needs the two lines to share an end; it takes');
  });

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
