// @vitest-environment node
// P4b sketch tools, edit by edit, solved by the shipped solver (PlaneGCS wasm): the
// constraint tie-ups keep DOF honest and make copies follow their sources.
//  - mirror: Symmetric per point (shared on the line), Equal for circles
//  - linear / circular patterns: the ties, a count change re-lays out, sources drive copies
//  - fillet / chamfer: trims, tangents, radius, the corner kept as a virtual sharp
//  - offset: parallel + distance, concentric arcs, squared ends, both sides
//  - splines: trim against a line, trim a spline (control: exact; fit: the cut keeps the tangent)
// SPDX-License-Identifier: GPL-3.0-or-later
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createUnitsService } from '../../src/doc/units';
import { extendAt, SketchBuilder, trimAt, type EditOutcome, type SketchDraft } from '../../src/sketch/edit';
import { entityOf, evaluateDimensions, toSolverSketch, withSolved } from '../../src/sketch/model';
import { chamferCorner, filletCorner } from '../../src/sketch/tools/fillet';
import { mirrorEntities } from '../../src/sketch/tools/mirror';
import { offsetChain } from '../../src/sketch/tools/offset';
import { createPattern, updatePattern } from '../../src/sketch/tools/pattern';
import { closestOnSpline, pointAtParam } from '../../src/sketch/tools/bspline';
import { splineOf } from '../../src/sketch/tools/spline-entity';
import { dissolveTie, promoteTies, prunedTies } from '../../src/sketch/tools/ties';
import type { SketchConstraint, SketchEntity, SketchTie, Vec2 } from '../../src/types/doc';
import { merge, rectangle, sketchOf, type Geo } from './fixtures';

type V2 = [number, number];
interface Solver {
  load(sketch: unknown): void;
  solve(): { status: string; dof: number; solved: boolean; conflicting: string[]; redundant: string[]; values: { points: Record<string, V2>; radii: Record<string, number> } };
  dispose(): void;
}
const API = pathToFileURL(fileURLToPath(new URL('../../src/solver-worker/solver-api.mjs', import.meta.url))).href;
const MODULE = pathToFileURL(fileURLToPath(new URL('../../workspace/solver/planegcs.mjs', import.meta.url))).href;
const units = createUnitsService(() => ({ length: 'mm', angle: 'deg' }));

type D = SketchDraft & { ties?: SketchTie[] };

async function solve(d: D): Promise<{ dof: number; draft: D; over: string[] }> {
  const { createSolver } = (await import(/* @vite-ignore */ API)) as { createSolver(o: { moduleUrl: string }): Promise<Solver> };
  const s = await createSolver({ moduleUrl: MODULE });
  const f = sketchOf(d, { ties: d.ties } as never);
  const ev = evaluateDimensions(f, units);
  s.load(toSolverSketch(f, ev.values));
  const r = s.solve();
  s.dispose();
  expect(r.solved, `not solved: ${r.status} ${r.conflicting.join(',')}`).toBe(true);
  return { dof: r.dof, draft: { ...withSolved(f, r.values), ties: d.ties }, over: [...r.conflicting, ...r.redundant] };
}

function ok(r: EditOutcome): D {
  if (!r.ok) throw new Error(r.reason);
  return r.draft as D;
}

const fixed = (ids: string[]): SketchConstraint[] => ids.map((id) => ({ id: `fx_${id}`, kind: 'fix', refs: [id] }));
/** A fully defined W x H rectangle at (x, y): fixed corner, two dimensions. */
function block(x: number, y: number, w: number, h: number): Geo {
  const r = rectangle(x, y, w, h);
  return { ...r, constraints: [...r.constraints, ...fixed(['p1']), { id: 'dw', kind: 'distance', refs: ['e1'], expr: `${w} mm`, driving: true }, { id: 'dh', kind: 'distance', refs: ['e2'], expr: `${h} mm`, driving: true }] };
}
const pt = (d: D, id: string) => d.points[id];

describe('sketch mirror', () => {
  it('copies tied by Symmetric: fully defined stays fully defined; a point on the line is shared', async () => {
    const g = merge(block(0, 0, 10, 5), {
      points: { m1: [-5, -1], m2: [-5, 20] },
      entities: [{ id: 'ml', kind: 'line', p: ['m1', 'm2'], construction: true, centerline: true }],
      constraints: [...fixed(['m1', 'm2'])],
    });
    const out = ok(mirrorEntities(g, ['e1', 'e2', 'e3', 'e4'], 'ml'));
    expect(out.entities.length).toBe(9);
    expect(out.constraints.filter((c) => c.kind === 'symmetric')).toHaveLength(4);
    const s = await solve(out);
    expect(s.dof).toBe(0);
    // The copy of p3 (10, 5) is at (-20, 5).
    const p3copy = out.constraints.find((c) => c.kind === 'symmetric' && c.refs[0] === 'p3')!.refs[1];
    expect(pt(s.draft, p3copy)[0]).toBeCloseTo(-20, 6);
    expect(pt(s.draft, p3copy)[1]).toBeCloseTo(5, 6);
    // Editing the source moves the copy: width 10 -> 14.
    const wider = { ...s.draft, constraints: s.draft.constraints.map((c) => (c.id === 'dw' ? { ...c, expr: '14 mm' } : c)) };
    const s2 = await solve(wider);
    expect(pt(s2.draft, p3copy)[0]).toBeCloseTo(-24, 6);
  });

  it('shares points on the mirror line and skips what lies on it; a mirrored arc turns the other way; circles get Equal', async () => {
    const g: Geo = {
      points: { a: [0, 0], b: [10, 0], c: [10, 10], o: [20, 5], q: [25, 5] },
      entities: [
        { id: 'axis', kind: 'line', p: ['a', 'c'] },
        { id: 'l', kind: 'line', p: ['a', 'b'] },
        { id: 'k', kind: 'arc', c: 'b', a: 'q', b: 'c' },
        { id: 'ci', kind: 'circle', c: 'o', r: 2 },
      ],
      constraints: [],
    };
    const out = ok(mirrorEntities(g, ['axis', 'l', 'ci'], 'axis'));
    // The axis itself is not copied; 'a' (on the axis) is shared by the line's copy.
    const lc = out.entities.find((e) => e.kind === 'line' && e.id !== 'axis' && e.id !== 'l') as Extract<SketchEntity, { kind: 'line' }>;
    expect(lc.p).toContain('a');
    expect(out.constraints.some((c) => c.kind === 'equal' && c.refs[0] === 'ci')).toBe(true);
    const arcOut = ok(mirrorEntities(g, ['k'], 'axis'));
    const arcCopy = arcOut.entities.find((e) => e.kind === 'arc' && e.id !== 'k') as Extract<SketchEntity, { kind: 'arc' }>;
    expect(arcCopy.ccw).toBe(false);
  });
});

describe('sketch patterns', () => {
  it('linear: 3 x 2 copies of a fully defined square are fully defined, at the spacing; count 3 -> 4 adds a column', async () => {
    const g = block(0, 0, 5, 5);
    const out = ok(createPattern(g, { kind: 'linear', sources: ['e1', 'e2', 'e3', 'e4'], count: [3, 2], exprs: { spacing1: '20 mm', angle1: '0 deg', spacing2: '10 mm', angle2: '90 deg' } }, units));
    expect(out.entities.length).toBe(4 * 6);
    expect(out.ties![0].copies).toHaveLength(5);
    const s = await solve(out);
    expect(s.dof).toBe(0);
    const far = out.ties![0].copies.find((c) => c.at[0] === 2 && c.at[1] === 1)!;
    expect(pt(s.draft, far.points.p1)).toEqual([expect.closeTo(40, 6), expect.closeTo(10, 6)]);
    expect(pt(s.draft, far.points.p3)).toEqual([expect.closeTo(45, 6), expect.closeTo(15, 6)]);
    // The source grows: the copies follow.
    const s2 = await solve({ ...s.draft, constraints: s.draft.constraints.map((c) => (c.id === 'dw' ? { ...c, expr: '7 mm' } : c)) });
    expect(pt(s2.draft, far.points.p3)[0]).toBeCloseTo(47, 6);
    // Count 3 -> 4 along the first direction: 2 more copies (one per row).
    const more = ok(updatePattern(s.draft, out.ties![0].id, { count: [4, 2] }, units));
    expect(more.ties![0].copies).toHaveLength(7);
    expect(more.entities.length).toBe(4 * 8);
    // And back to 2 x 1: the extra copies go with their points.
    const fewer = ok(updatePattern(more, out.ties![0].id, { count: [2, 1] }, units));
    expect(fewer.entities.length).toBe(8);
    expect(Object.keys(fewer.points).length).toBe(8);
    const s3 = await solve(fewer);
    expect(s3.dof).toBe(0);
    // A spacing typed with a parameter-free expression re-lays them out.
    const spaced = ok(updatePattern(fewer, out.ties![0].id, { exprs: { spacing1: '12.5 mm' } }, units));
    const s4 = await solve(spaced);
    const c1 = spaced.ties![0].copies[0];
    expect(pt(s4.draft, c1.points.p1)[0]).toBeCloseTo(12.5, 6);
  });

  it('circular: 6 copies round the origin, full circle, a circle keeps its radius (Equal)', async () => {
    const g: Geo = {
      points: { c0: [20, 0] },
      entities: [{ id: 'ci', kind: 'circle', c: 'c0', r: 3 }],
      constraints: [...fixed(['c0']), { id: 'r', kind: 'radius', refs: ['ci'], expr: '3 mm', driving: true }],
    };
    const out = ok(createPattern(g, { kind: 'circular', sources: ['ci'], count: [6, 1], exprs: {}, centre: 'origin', full: true }, units));
    expect(out.entities.filter((e) => e.kind === 'circle')).toHaveLength(6);
    const s = await solve(out);
    expect(s.dof).toBe(0);
    const third = out.ties![0].copies.find((c) => c.at[0] === 3)!;
    expect(pt(s.draft, third.points.c0)).toEqual([expect.closeTo(-20, 6), expect.closeTo(0, 6)]);
    expect((entityOf(s.draft, third.entities.ci) as Extract<SketchEntity, { kind: 'circle' }>).r).toBeCloseTo(3, 6);
    // A set angle of 90 degrees over 3 instances: 45 degrees apart.
    const arcd = ok(updatePattern(out, out.ties![0].id, { count: [3, 1], full: false, exprs: { angle: '90 deg' } }, units));
    const s2 = await solve(arcd);
    const second = arcd.ties![0].copies.find((c) => c.at[0] === 2)!;
    expect(pt(s2.draft, second.points.c0)[0]).toBeCloseTo(0, 6);
    expect(pt(s2.draft, second.points.c0)[1]).toBeCloseTo(20, 6);
  });

  it('fix1 B1: editing a pattern of an UNDER-defined source moves only the copies (circular and linear)', async () => {
    const g: Geo = { points: { c0: [30, 0] }, entities: [{ id: 'ci', kind: 'circle', c: 'c0', r: 3 }], constraints: [] };
    let d = ok(createPattern(g, { kind: 'circular', sources: ['ci'], count: [4, 1], exprs: { angle: '90 deg' }, centre: 'origin', full: false }, units));
    d = (await solve(d)).draft;
    const id = d.ties![0].id;
    const steps: Parameters<typeof updatePattern>[2][] = [{ exprs: { angle: '60 deg' } }, { count: [7, 1] }, { full: true }, { full: false }];
    for (const patch of steps) {
      d = (await solve(ok(updatePattern(d, id, patch, units)))).draft;
      expect(d.points.c0[0]).toBeCloseTo(30, 9);
      expect(d.points.c0[1]).toBeCloseTo(0, 9);
      expect((entityOf(d, 'ci') as Extract<SketchEntity, { kind: 'circle' }>).r).toBeCloseTo(3, 9);
    }
    // The copies are where the values put them: 7 over 60 degrees = 10 degrees apart.
    const last = d.ties![0].copies.find((c) => c.at[0] === 6)!;
    const q = d.points[last.points.c0];
    expect((Math.atan2(q[1], q[0]) * 180) / Math.PI).toBeCloseTo(60, 6);
    expect(Math.hypot(q[0], q[1])).toBeCloseTo(30, 6);

    const h: Geo = { points: { c1: [-30, 0] }, entities: [{ id: 'cl', kind: 'circle', c: 'c1', r: 2 }], constraints: [] };
    let e = (await solve(ok(createPattern(h, { kind: 'linear', sources: ['cl'], count: [3, 1], exprs: { spacing1: '20 mm', angle1: '0 deg' } }, units)))).draft;
    const lid = e.ties![0].id;
    for (const patch of [{ exprs: { spacing1: '30 mm' } }, { exprs: { angle1: '90 deg' } }] as Parameters<typeof updatePattern>[2][]) {
      e = (await solve(ok(updatePattern(e, lid, patch, units)))).draft;
      expect(e.points.c1).toEqual([expect.closeTo(-30, 9), expect.closeTo(0, 9)]);
    }
    const top = e.ties![0].copies.find((c) => c.at[0] === 2)!;
    expect(e.points[top.points.c1]).toEqual([expect.closeTo(-30, 6), expect.closeTo(60, 6)]);
  });

  it('fix1 B5: a deleted copy stays deleted through a count edit; Restore brings it back', async () => {
    const g = block(0, 0, 5, 5);
    const made = ok(createPattern(g, { kind: 'linear', sources: ['e1', 'e2', 'e3', 'e4'], count: [4, 1], exprs: { spacing1: '20 mm', angle1: '0 deg' } }, units));
    const copy = made.ties![0].copies.find((c) => c.at[0] === 2)!;
    // Delete that copy's four lines (as Delete does), then the commit prunes the tie.
    const gonePts = new Set(Object.values(copy.points));
    const after = { ...made, entities: made.entities.filter((e) => !Object.values(copy.entities).includes(e.id)), points: Object.fromEntries(Object.entries(made.points).filter(([k]) => !gonePts.has(k))) };
    const ties = prunedTies(after)!;
    expect(ties[0].skip).toEqual([[2, 0]]);
    const d1: D = { ...after, ties };
    const more = ok(updatePattern(d1, ties[0].id, { count: [5, 1] }, units));
    expect(more.ties![0].copies.map((c) => c.at[0]).sort()).toEqual([1, 3, 4]);
    expect(more.entities.length).toBe(4 * 4);
    const back = ok(updatePattern(more, ties[0].id, { skip: [] }, units));
    expect(back.ties![0].copies.map((c) => c.at[0]).sort()).toEqual([1, 2, 3, 4]);
    expect((await solve(back)).dof).toBe(0);
  });

  it('deleting a copy keeps the rest of the pattern (pruned tie)', () => {
    const g = block(0, 0, 5, 5);
    const out = ok(createPattern(g, { kind: 'linear', sources: ['e1'], count: [3, 1], exprs: { spacing1: '20 mm', angle1: '0 deg' } }, units));
    const gone = out.ties![0].copies[0].entities.e1;
    const pruned = prunedTies({ entities: out.entities.filter((e) => e.id !== gone), ties: out.ties });
    expect(pruned![0].copies).toHaveLength(1);
  });
});

describe('sketch fillet and chamfer', () => {
  it('fillet of a fully defined rectangle corner: tangent arc, radius dimension, still fully defined, dimensions kept on the virtual sharp', async () => {
    const g = block(0, 0, 40, 20);
    const out = ok(filletCorner(g, 'p3', 5, '5 mm'));
    const arc = out.entities.find((e) => e.kind === 'arc') as Extract<SketchEntity, { kind: 'arc' }>;
    expect(arc).toBeTruthy();
    expect(out.constraints.filter((c) => c.kind === 'tangent')).toHaveLength(2);
    expect(out.constraints.some((c) => c.kind === 'radius' && c.refs[0] === arc.id)).toBe(true);
    // e2's length (20) is now from its far end p2 to the corner p3.
    expect(out.constraints.find((c) => c.id === 'dh')!.refs).toEqual(['p2', 'p3']);
    const s = await solve(out);
    expect(s.dof).toBe(0);
    expect(pt(s.draft, arc.c)).toEqual([expect.closeTo(35, 6), expect.closeTo(15, 6)]);
    expect(pt(s.draft, 'p3')).toEqual([expect.closeTo(40, 6), expect.closeTo(20, 6)]);
    // A radius too large is refused in words.
    const big = filletCorner(g, 'p3', 25, '25 mm');
    expect(big.ok).toBe(false);
    if (!big.ok) expect(big.reason).toMatch(/radius is too large/);
  });

  it('fillet of a line and an arc meeting at a corner', async () => {
    // A line along x to (20, 0), then a ccw arc about (20, 10) radius 10 from (20, 0) to (30, 10).
    const g: Geo = {
      points: { a: [0, 0], p: [20, 0], o: [20, 10], q: [30, 10] },
      entities: [
        { id: 'l', kind: 'line', p: ['a', 'p'] },
        { id: 'k', kind: 'arc', c: 'o', a: 'p', b: 'q' },
      ],
      constraints: [],
    };
    // Tangent already (a smooth join): no corner to round, but the geometry still allows a fillet in the concave side.
    const notTangent: Geo = { ...g, points: { ...g.points, o: [25, 10], q: [35, 10] } };
    const out = ok(filletCorner(notTangent, 'p', 2, '2 mm'));
    const s = await solve(out);
    expect(s.over).toEqual([]);
    expect(out.entities.filter((e) => e.kind === 'arc')).toHaveLength(2);
  });

  it('chamfer of a corner: a line, two distances, fully defined', async () => {
    const g = block(0, 0, 40, 20);
    const out = ok(chamferCorner(g, 'p3', 4, 6, ['4 mm', '6 mm'], false));
    expect(out.entities.filter((e) => e.kind === 'line' && !e.construction)).toHaveLength(5);
    const s = await solve(out);
    expect(s.dof).toBe(0);
    const ch = out.entities.find((e) => e.kind === 'line' && !['e1', 'e2', 'e3', 'e4'].includes(e.id)) as Extract<SketchEntity, { kind: 'line' }>;
    const a = pt(s.draft, ch.p[0]);
    const b = pt(s.draft, ch.p[1]);
    // On e2 (x = 40) 4 below the corner, on e3 (y = 20) 6 left of it.
    expect(a).toEqual([expect.closeTo(40, 6), expect.closeTo(16, 6)]);
    expect(b).toEqual([expect.closeTo(34, 6), expect.closeTo(20, 6)]);
  });
});

describe('fix1 P4 / P6 / P7', () => {
  it('P7: chamfer "Same distance" is one dimension and Equal construction legs: editing it moves both cuts', async () => {
    const g = block(0, 0, 40, 20);
    const out = ok(chamferCorner(g, 'p3', 4, 4, ['4 mm', '4 mm'], true));
    const dims = out.constraints.filter((c) => c.kind === 'distance' && c.refs.includes('p3') && c.id !== 'dh' && c.id !== 'dw');
    expect(dims).toHaveLength(1);
    expect(out.constraints.filter((c) => c.kind === 'equal')).toHaveLength(1);
    const s = await solve(out);
    expect(s.dof).toBe(0);
    const s2 = await solve({ ...s.draft, constraints: s.draft.constraints.map((c) => (c.id === dims[0].id ? { ...c, expr: '6 mm' } : c)) });
    const ch = out.entities.find((e) => e.kind === 'line' && !e.construction && !['e1', 'e2', 'e3', 'e4'].includes(e.id)) as Extract<SketchEntity, { kind: 'line' }>;
    const [a, b] = ch.p.map((id) => s2.draft.points[id]);
    expect(a).toEqual([expect.closeTo(40, 6), expect.closeTo(14, 6)]);
    expect(b).toEqual([expect.closeTo(34, 6), expect.closeTo(20, 6)]);
  });

  it('P4: a length dimension moved onto the corner keeps its label outside, beside its line', () => {
    const g = block(0, 0, 40, 30);
    const out = ok(filletCorner(g, 'p3', 8, '8 mm', { labelGap: 12 }));
    const dh = out.constraints.find((c) => c.id === 'dh') as Extract<SketchConstraint, { expr: string }>;
    // Line 2 (x = 40): beside it on the right (outside), at mid height.
    expect(dh.at).toEqual([expect.closeTo(52, 9), expect.closeTo(15, 9)]);
    const dw = out.constraints.find((c) => c.id === 'dw') as Extract<SketchConstraint, { expr: string }>;
    // The top corner p3 also ends Line 3, but dw is on Line 1 (the bottom), untouched.
    expect(dw.refs).toEqual(['e1']);
  });

});

describe('sketch offset', () => {
  it('a closed rectangle offset outward by 3: a 46 x 26 rectangle, fully defined, following the source', async () => {
    const g = block(0, 0, 40, 20);
    // The rectangle runs ccw: its outside is to the right of travel (side -1).
    const out = ok(offsetChain(g, 'e1', -1, false, '3 mm', units));
    expect(out.entities.length).toBe(8);
    const s = await solve(out);
    expect(s.dof).toBe(0);
    const m = out.ties![0].copies[0].points;
    expect(pt(s.draft, m.p1)).toEqual([expect.closeTo(-3, 6), expect.closeTo(-3, 6)]);
    expect(pt(s.draft, m.p3)).toEqual([expect.closeTo(43, 6), expect.closeTo(23, 6)]);
    // The distance from its row: 3 -> 5.
    const t = out.ties![0];
    const s2 = await solve({ ...s.draft, ties: [{ ...t, exprs: { distance: '5 mm' } }] });
    expect(pt(s2.draft, m.p3)).toEqual([expect.closeTo(45, 6), expect.closeTo(25, 6)]);
  });

  it('an open line + arc chain, both sides: squared ends, concentric arcs', async () => {
    const g: Geo = {
      points: { a: [0, 0], p: [20, 0], o: [20, 10], q: [30, 10] },
      entities: [
        { id: 'l', kind: 'line', p: ['a', 'p'] },
        { id: 'k', kind: 'arc', c: 'o', a: 'p', b: 'q' },
      ],
      constraints: [...fixed(['a', 'p', 'o', 'q'])],
    };
    const out = ok(offsetChain(g, 'l', 1, true, '2 mm', units));
    expect(out.ties![0].copies).toHaveLength(2);
    const s = await solve(out);
    expect(s.dof).toBe(0);
    const left = out.ties![0].copies.find((c) => c.at[0] === 1)!;
    // Left of travel along +x is +y: the line copy at y = 2 from x = 0, the arc copy radius 8.
    expect(pt(s.draft, left.points.a)).toEqual([expect.closeTo(0, 6), expect.closeTo(2, 6)]);
    expect(pt(s.draft, left.points.q)).toEqual([expect.closeTo(28, 6), expect.closeTo(10, 6)]);
  });
});

describe('fix1 B3: offsets of chains with smooth joints', () => {
  const tangentArc: Geo = {
    points: { a: [0, 0], p: [30, 0], o: [30, 10], q: [30, 20] },
    entities: [
      { id: 'l', kind: 'line', p: ['a', 'p'] },
      { id: 'k', kind: 'arc', c: 'o', a: 'p', b: 'q' },
    ],
    constraints: [{ id: 'co', kind: 'coincident', refs: ['a', 'origin'] }, { id: 'h', kind: 'horizontal', refs: ['l'] }, { id: 't', kind: 'tangent', refs: ['l', 'k'] }],
  };
  function rounded(): Geo {
    let g: D = block(0, 0, 40, 30);
    for (const c of ['p3', 'p1', 'p2', 'p4']) g = ok(filletCorner(g, c, 8, '8 mm'));
    return g;
  }
  const slot: Geo = {
    points: { a: [0, 0], b: [30, 0], c: [30, 10], d: [0, 10], o1: [30, 5], o2: [0, 5] },
    entities: [
      { id: 'l1', kind: 'line', p: ['a', 'b'] },
      { id: 'k1', kind: 'arc', c: 'o1', a: 'b', b: 'c' },
      { id: 'l2', kind: 'line', p: ['c', 'd'] },
      { id: 'k2', kind: 'arc', c: 'o2', a: 'd', b: 'a' },
    ],
    constraints: [
      { id: 't1', kind: 'tangent', refs: ['l1', 'k1'] },
      { id: 't2', kind: 'tangent', refs: ['k1', 'l2'] },
      { id: 't3', kind: 'tangent', refs: ['l2', 'k2'] },
      { id: 't4', kind: 'tangent', refs: ['k2', 'l1'] },
    ],
  };
  const circle2: Geo = {
    points: { a: [10, 0], b: [-10, 0], o: [0, 0] },
    entities: [
      { id: 'k1', kind: 'arc', c: 'o', a: 'a', b: 'b' },
      { id: 'k2', kind: 'arc', c: 'o', a: 'b', b: 'a' },
    ],
    constraints: [],
  };
  for (const [name, g, pick] of [['a line and a tangent arc', tangentArc, 'l'], ['a rounded rectangle', null, 'e1'], ['a slot', slot, 'l1'], ['a circle in two arcs', circle2, 'k1']] as [string, Geo | null, string][]) {
    it(`${name}: outside, inside and both sides place with nothing over-defined and the DOF unchanged`, async () => {
      const src = (g ?? rounded()) as D;
      const base = await solve(src);
      for (const side of [1, -1] as const)
        for (const both of [false, true]) {
          const r = await solve(ok(offsetChain(src, pick, side, both, '2 mm', units)));
          expect(r.over).toEqual([]);
          expect(r.dof).toBe(base.dof);
        }
    });
  }
});

describe('splines in trim', () => {
  it('a line crossing a control spline is trimmed to it; the spline is cut exactly', async () => {
    const g: Geo = {
      points: { s0: [0, 0], s1: [10, 20], s2: [30, 20], s3: [40, 0], l0: [20, -5], l1: [20, 30] },
      entities: [
        { id: 'sp', kind: 'spline', form: 'control', pts: ['s0', 's1', 's2', 's3'], degree: 3 },
        { id: 'ln', kind: 'line', p: ['l0', 'l1'] },
      ],
      constraints: [],
    };
    // Trim the line's top part (above the spline at y = 15).
    const t1 = ok(trimAt(g, 'ln', [20, 25]));
    const ln = entityOf(t1, 'ln') as Extract<SketchEntity, { kind: 'line' }>;
    expect(t1.points[ln.p[1]][1]).toBeCloseTo(15, 6);
    // Trim the spline's right part (x > 20): the kept piece is exactly the left half.
    const t2 = ok(trimAt(g, 'sp', [35, 8]));
    const sp = entityOf(t2, 'sp') as Extract<SketchEntity, { kind: 'spline' }>;
    expect(sp.knots).toBeTruthy();
    const b = splineOf(t2, sp)!;
    const orig = splineOf(g, entityOf(g, 'sp') as Extract<SketchEntity, { kind: 'spline' }>)!;
    for (const u of [0, 0.2, 0.45]) {
      const p = pointAtParam(b, u);
      const q = pointAtParam(orig, u);
      expect(Math.hypot(p[0] - q[0], p[1] - q[1])).toBeLessThan(1e-9);
    }
    // DOF: its poles (now 4 new ones but the first) are solver points: solvable.
    const s = await solve(t2);
    expect(s.over).toEqual([]);
  });

  it('fix1 B2/B4: a line trimmed against a fit spline ends ON it (the spline untouched); the spline trimmed at the line is exactly the curve it was', async () => {
    const g: Geo = {
      points: { a: [-45, 0], b: [-15, 25], c: [15, -25], d: [45, 0], l0: [-35, -12], l1: [-35, 30] },
      entities: [
        { id: 'sp', kind: 'spline', form: 'fit', pts: ['a', 'b', 'c', 'd'], degree: 3 },
        { id: 'ln', kind: 'line', p: ['l0', 'l1'] },
      ],
      constraints: [],
    };
    const orig = splineOf(g, entityOf(g, 'sp') as Extract<SketchEntity, { kind: 'spline' }>)!;
    // The line above the spline goes: its end lies on the curve with On curve; the spline keeps its 4 fit points.
    const t1 = ok(trimAt(g, 'ln', [-35, 28]));
    const sp1 = entityOf(t1, 'sp') as Extract<SketchEntity, { kind: 'spline' }>;
    const ln = entityOf(t1, 'ln') as Extract<SketchEntity, { kind: 'line' }>;
    expect(sp1.pts).toEqual(['a', 'b', 'c', 'd']);
    const end = ln.p[1];
    expect(t1.constraints).toContainEqual(expect.objectContaining({ kind: 'point_on_circle', refs: [end, 'sp'] }));
    expect(closestOnSpline(orig, t1.points[end]).d).toBeLessThan(1e-9);
    const s1 = await solve(t1);
    expect(s1.over).toEqual([]);
    expect(closestOnSpline(orig, s1.draft.points[end]).d).toBeLessThan(1e-8);
    // Now the spline's left tail: it is cut at the line's end (the same point), exactly.
    const t2 = ok(trimAt(s1.draft, 'sp', [-42, 4.5]));
    const sp2 = entityOf(t2, 'sp') as Extract<SketchEntity, { kind: 'spline' }>;
    expect(sp2.pts[0]).toBe(end);
    expect(sp2.spans).toBeTruthy();
    expect(t2.constraints.some((c) => c.kind === 'point_on_circle' && c.refs[0] === end)).toBe(false);
    const cut = splineOf(t2, sp2)!;
    let worst = 0;
    for (let i = 0; i <= 400; i++) {
      const p = pointAtParam(cut, cut.knots[0] + ((cut.knots[cut.knots.length - 1] - cut.knots[0]) * i) / 400);
      worst = Math.max(worst, closestOnSpline(orig, p).d);
    }
    expect(worst).toBeLessThan(1e-7);
    const s2 = await solve(t2);
    expect(s2.over).toEqual([]);
  });

  it('fix1 B4: a closed fit spline trimmed between two crossings keeps the exact curve', () => {
    const g: Geo = {
      points: { a: [0, 0], b: [20, -5], c: [30, 10], d: [10, 20], l0: [15, -20], l1: [15, 30] },
      entities: [
        { id: 'sp', kind: 'spline', form: 'fit', pts: ['a', 'b', 'c', 'd'], degree: 3, closed: true },
        { id: 'ln', kind: 'line', p: ['l0', 'l1'] },
      ],
      constraints: [],
    };
    const orig = splineOf(g, entityOf(g, 'sp') as Extract<SketchEntity, { kind: 'spline' }>)!;
    const t = ok(trimAt(g, 'sp', [-1, 10]));
    const sp = entityOf(t, 'sp') as Extract<SketchEntity, { kind: 'spline' }>;
    expect(sp.closed).toBeFalsy();
    const cut = splineOf(t, sp)!;
    let worst = 0;
    for (let i = 0; i <= 400; i++) worst = Math.max(worst, closestOnSpline(orig, pointAtParam(cut, (i / 400) * cut.knots[cut.knots.length - 1])).d);
    expect(worst).toBeLessThan(1e-7);
  });

  it('a line extends to a spline it points at', () => {
    const g: Geo = {
      points: { s0: [0, 0], s1: [10, 20], s2: [30, 20], s3: [40, 0], a: [-10, 10], b: [-5, 10] },
      entities: [
        { id: 'sp', kind: 'spline', form: 'control', pts: ['s0', 's1', 's2', 's3'], degree: 3 },
        { id: 'ln', kind: 'line', p: ['a', 'b'] },
      ],
      constraints: [],
    };
    const r = ok(extendAt(g, 'ln', [-5, 10]));
    const end = r.points.b;
    expect(end[1]).toBeCloseTo(10, 9);
    const b = splineOf(r, entityOf(r, 'sp') as Extract<SketchEntity, { kind: 'spline' }>)!;
    expect(sampleDist(b, end)).toBeLessThan(1e-6);
  });
});

function sampleDist(b: ReturnType<typeof splineOf> & object, p: Vec2): number {
  return closestOnSpline(b, p).d;
}

describe('fu2: deleting the source of a sketch pattern (Daniel 2026-10-06, item 3)', () => {
  /** What sketch mode does on Delete: remove, then promote (apply), then prune (commit). */
  function del(d: D, ids: string[]) {
    const b = new SketchBuilder(d);
    b.remove(ids);
    const r = promoteTies(d, { ...d, ...b.result() });
    return { draft: { ...r.draft, ties: prunedTies(r.draft) } as D, notice: r.notice };
  }
  function circleRow(n: number): D {
    const g: Geo = {
      points: { c0: [0, 0] },
      entities: [{ id: 'ci', kind: 'circle', c: 'c0', r: 5 }],
      constraints: [
        { id: 'co', kind: 'coincident', refs: ['c0', 'origin'] },
        { id: 'dia', kind: 'diameter', refs: ['ci'], expr: '10 mm', driving: true, at: [8, 8] },
      ],
    };
    return ok(createPattern(g, { kind: 'linear', sources: ['ci'], count: [n, 1], exprs: { spacing1: '20 mm', angle1: '0 deg' } }, units));
  }
  const centres = (d: D) =>
    d.entities
      .filter((e) => e.kind === 'circle')
      .map((e) => d.points[(e as { c: string }).c][0])
      .sort((a, b) => a - b);

  it('the next copy becomes the source; the copies stay tied; its diameter goes with it, its place on the origin does not; DOF honest', async () => {
    const d0 = (await solve(circleRow(4))).draft;
    expect((await solve(d0)).dof).toBe(0);
    const { draft, notice } = del(d0, ['ci']);
    expect(notice).toEqual({ text: 'Linear pattern 1 now starts from Circle 1', tie: d0.ties![0].id });
    const t = draft.ties![0];
    expect(t.base).toEqual([1, 0]);
    expect(t.skip).toEqual([[0, 0]]);
    expect(t.copies.map((c) => c.at[0])).toEqual([2, 3]);
    expect(draft.constraints.filter((c) => c.kind === 'diameter')).toHaveLength(1);
    expect(draft.constraints.some((c) => c.kind === 'coincident')).toBe(false);
    const s = await solve(draft);
    expect(s.over).toEqual([]);
    // The new source's centre is free (2 DOF); its copies follow it.
    expect(s.dof).toBe(2);
    expect(centres(s.draft)).toEqual([20, 40, 60].map((x) => expect.closeTo(x, 9)));
    // The row's count: 5 adds an instance at 80 (three steps from the new source).
    const more = ok(updatePattern(s.draft, t.id, { count: [5, 1] }, units));
    expect(centres((await solve(more)).draft)).toEqual([20, 40, 60, 80].map((x) => expect.closeTo(x, 9)));
    // It cannot drop below the new source's place.
    expect(updatePattern(s.draft, t.id, { count: [1, 1] }, units).ok).toBe(false);
  });

  it('a skipped next instance is passed over; a two-direction grid keeps every copy where it was', async () => {
    let d = (await solve(circleRow(4))).draft;
    const second = d.ties![0].copies.find((c) => c.at[0] === 1)!;
    d = del(d, [second.entities.ci]).draft;
    expect(d.ties![0].skip).toEqual([[1, 0]]);
    const r = del(d, ['ci']);
    expect(r.draft.ties![0].base).toEqual([2, 0]);
    expect(centres((await solve(r.draft)).draft)).toEqual([40, 60].map((x) => expect.closeTo(x, 9)));

    const g: Geo = { points: { c0: [0, 0] }, entities: [{ id: 'ci', kind: 'circle', c: 'c0', r: 3 }], constraints: [] };
    const grid = (await solve(ok(createPattern(g, { kind: 'linear', sources: ['ci'], count: [2, 2], exprs: { spacing1: '20 mm', angle1: '0 deg', spacing2: '15 mm', angle2: '90 deg' } }, units)))).draft;
    const before = grid.entities.filter((e) => e.kind === 'circle' && e.id !== 'ci').map((e) => grid.points[(e as { c: string }).c]);
    const p = del(grid, ['ci']);
    expect(p.draft.ties![0].base).toEqual([1, 0]);
    const s = await solve(p.draft);
    expect(s.over).toEqual([]);
    const after = s.draft.entities.filter((e) => e.kind === 'circle').map((e) => s.draft.points[(e as { c: string }).c]);
    for (const q of before) expect(after.some((a) => Math.hypot(a[0] - q[0], a[1] - q[1]) < 1e-9)).toBe(true);
  });

  it('a source of several entities: one going leaves the pattern; all going promote the next copy', async () => {
    const g = block(0, 0, 5, 5);
    const d = (await solve(ok(createPattern(g, { kind: 'linear', sources: ['e1', 'e2', 'e3', 'e4'], count: [3, 1], exprs: { spacing1: '20 mm', angle1: '0 deg' } }, units)))).draft;
    const one = del(d, ['e2']);
    expect(one.notice?.text).toBe('Line 2 is no longer in Linear pattern 1; its copies stay where they are.');
    expect(one.draft.ties![0].sources).toEqual(['e1', 'e3', 'e4']);
    expect((await solve(one.draft)).over).toEqual([]);
    const all = del(d, ['e1', 'e2', 'e3', 'e4']);
    expect(all.notice?.text).toBe('Linear pattern 1 now starts from Line 1 and 3 more');
    expect(all.draft.ties![0].sources).toHaveLength(4);
    // Its width and height (on its own lines) and its H / V went with it: fully defined but for its place.
    expect(all.draft.constraints.filter((c) => c.kind === 'distance')).toHaveLength(2);
    const s = await solve(all.draft);
    expect(s.over).toEqual([]);
    expect(s.dof).toBe(2);
  });

  it('down to one instance: it is no longer a pattern, and says so (source deleted, or the last copy deleted)', () => {
    const d = circleRow(2);
    const a = del(d, ['ci']);
    expect(a.draft.ties).toBeUndefined();
    expect(a.notice).toEqual({ text: 'Linear pattern 1 is no longer a pattern: Circle 1 was its last copy.' });
    const copy = d.ties![0].copies[0].entities.ci;
    const b = del(d, [copy]);
    expect(b.draft.ties).toBeUndefined();
    expect(b.notice?.text).toBe('Linear pattern 1 is no longer a pattern: its last copy was deleted.');
  });

  it('circular: the next copy leads; a Horizontal of the old source is not carried (a rotation turns it)', async () => {
    const g: Geo = {
      points: { a: [20, 0], b: [30, 0] },
      entities: [{ id: 'ln', kind: 'line', p: ['a', 'b'] }],
      constraints: [
        { id: 'h', kind: 'horizontal', refs: ['ln'] },
        { id: 'len', kind: 'distance', refs: ['ln'], expr: '10 mm', driving: true },
      ],
    };
    const d = (await solve(ok(createPattern(g, { kind: 'circular', sources: ['ln'], count: [4, 1], exprs: {}, centre: 'origin', full: true }, units)))).draft;
    const r = del(d, ['ln']);
    expect(r.draft.constraints.map((c) => c.kind)).toEqual(['distance']);
    const s = await solve(r.draft);
    expect(s.over).toEqual([]);
    // The new source (at 90 degrees) keeps its length; its place and direction are free: 3 DOF.
    expect(s.dof).toBe(3);
  });

  it('Dissolve frees the copies where they stand', async () => {
    const d = (await solve(circleRow(3))).draft;
    const r = dissolveTie(d, d.ties![0].id);
    if (!r.ok) throw new Error(r.reason);
    expect(r.draft.ties).toBeUndefined();
    const s = await solve(r.draft);
    expect(centres(s.draft)).toEqual([0, 20, 40].map((x) => expect.closeTo(x, 9)));
    expect(s.dof).toBe(6);
  });
});
