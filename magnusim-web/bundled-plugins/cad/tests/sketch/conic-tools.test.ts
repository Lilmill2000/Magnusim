// @vitest-environment node
// The Ellipse group in sketch mode and in the Assistant's sketch tool, both ways (Daniel's parity
// rule), with the real solver in this process:
//   - each kind's DOF (help sketch's numbers), and the numbers that make no curve refused;
//   - the person's Ellipse, Partial ellipse, Parabola and Conic tools, clicked, store the very
//     records the sketch tool's kinds compile to for the same numbers, point for point;
//   - Trim: an ellipse crossed twice keeps a partial ellipse, a partial ellipse and a parabola split
//     into pieces on one curve, a conic piece is the same curve (a new top point and rho);
//   - Mirror and the patterns copy them (the copies follow), Offset refuses them with the reason.
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compileSketch, type ConstraintIn, type EntityIn } from '../../src/assistant/sketch/compile';
import { KIND_DOF } from '../../src/assistant/sketch/macros';
import { createUnitsService } from '../../src/doc/units';
import { trimAt, type EditOutcome, type SketchDraft } from '../../src/sketch/edit';
import { entityOf, entityPoints, evaluateDimensions, toSolverSketch, withSolved } from '../../src/sketch/model';
import { closestOnConicCurve, conicCurve, conicPolyline } from '../../src/sketch/tools/conic';
import { mirrorEntities } from '../../src/sketch/tools/mirror';
import { offsetChain } from '../../src/sketch/tools/offset';
import { createPattern } from '../../src/sketch/tools/pattern';
import type { SketchConicEntity, SketchEntity, SketchFeature, SketchTie, Vec2 } from '../../src/types/doc';
import type { SketchSolverClient, SketchToolId } from '../../src/types/sketch';
import type { DocUnits } from '../../src/types/units';
import { solverAnywhere } from '../assistant/solver-anywhere';
import { sketchOf } from './fixtures';
import { sketchHarness } from './harness';

let solver: SketchSolverClient;
beforeAll(async () => {
  solver = await solverAnywhere();
}, 60_000);
afterAll(() => solver?.dispose());

const mm = createUnitsService(() => ({ length: 'mm', angle: 'deg' }) as DocUnits);
const Ein = (id: string, kind: string, at: number[]): EntityIn => ({ id, kind, at, construction: false });
const compile = (entities: EntityIn[], constraints: ConstraintIn[] = []) => compileSketch({ entities, constraints, infer: false }, { units: mm, stored: null });

/** An entity's record with its point ids replaced by where they are (ids differ; the record must not). */
function shape(f: Pick<SketchFeature, 'points'>, e: SketchEntity): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const pts = new Set(entityPoints(e));
  for (const [k, v] of Object.entries(e)) {
    if (k === 'id') continue;
    if (typeof v === 'string' && pts.has(v)) out[k] = f.points[v].map((x) => Math.round(x * 1e6) / 1e6);
    else out[k] = v;
  }
  return out;
}

describe('the kinds in the solver', () => {
  it('ellipse 5, ellipse_arc 7, parabola 6, conic 6 DOF, as help sketch says', async () => {
    const cases: [string, number[]][] = [
      ['ellipse', [5, 3, 30, 12, 20]],
      ['ellipse_arc', [5, 3, 30, 12, 20, 10, 200]],
      ['parabola', [5, 0, 0, 0, -10, 10]],
      ['conic', [0, 0, 40, 0, 10, 20, 0.3]],
    ];
    for (const [kind, at] of cases) {
      const c = compile([Ein('x', kind, at)]);
      expect(c.draft.entities.map((e) => e.kind), kind).toEqual([kind]);
      await solver.load(toSolverSketch(c.draft, {}));
      const r = (await solver.solve()) as { dof: number; solved: boolean };
      expect(r.solved, kind).toBe(true);
      expect(r.dof, kind).toBe(KIND_DOF[kind as keyof typeof KIND_DOF]);
    }
  });

  it('refuses numbers that make no curve, naming the form', () => {
    const problem = (kind: string, at: number[]) => {
      try {
        compile([Ein('x', kind, at)]);
      } catch (e) {
        return (e as Error).message;
      }
      return 'compiled';
    };
    expect(problem('ellipse', [0, 0, 10, 12, 0])).toMatch(/a > \|b\| > 0/);
    expect(problem('ellipse_arc', [0, 0, 20, 10, 0, 30, 30])).toMatch(/start and end angles are the same/);
    expect(problem('parabola', [0, 0, 0, 0, -5, 5])).toMatch(/focus and vertex must be apart/);
    expect(problem('conic', [0, 0, 40, 0, 10, 20, 1])).toMatch(/rho, more than 0 and less than 1/);
    expect(problem('conic', [0, 0, 40, 0, 20, 0, 0.5])).toMatch(/off the line through its ends/);
  });
});

describe("the person's Ellipse group tools store what the sketch tool stores", () => {
  async function drawn(tool: SketchToolId, clicks: Vec2[], moves: Vec2[][] = []): Promise<SketchFeature> {
    const s = await sketchHarness();
    s.tool(tool);
    clicks.forEach((p, i) => {
      for (const m of moves[i] ?? []) s.move(m);
      s.click(p);
    });
    await s.idle();
    const f = s.sketch();
    s.dispose();
    return f;
  }
  const one = (f: SketchFeature) => {
    const curves = f.entities.filter((e) => e.kind !== 'point');
    expect(curves).toHaveLength(1);
    return shape(f, curves[0]);
  };
  const ai = (kind: string, at: number[]) => {
    const c = compile([Ein('x', kind, at)]);
    return shape(c.draft, c.draft.entities[0]);
  };

  it('Ellipse: centre, major end, minor radius', async () => {
    const f = await drawn('ellipse', [
      [10, 5],
      [40, 5],
      [12, 17],
    ]);
    expect(one(f)).toEqual(ai('ellipse', [10, 5, 30, 12, 0]));
    expect(one(f)).toEqual({ kind: 'ellipse', c: [10, 5], major: [40, 5], minor: [10, 17] });
  });

  it('Partial ellipse: the arc runs the way the pointer went (stored counter-clockwise)', async () => {
    const A = 30;
    const B = 12;
    const P = (t: number): Vec2 => [10 + A * Math.cos((t * Math.PI) / 180), 5 + B * Math.sin((t * Math.PI) / 180)];
    const sweep = (from: number, to: number) => Array.from({ length: 9 }, (_, i) => P(from + ((to - from) * (i + 1)) / 10));
    const ccw = await drawn('ellipse-partial', [[10, 5], [40, 5], [12, 17], P(20), P(200)], [[], [], [], [], sweep(20, 200)]);
    expect(one(ccw)).toEqual(ai('ellipse_arc', [10, 5, 30, 12, 0, 20, 200]));
    // Drawn clockwise from 200 down to 20 degrees: the same piece.
    const cw = await drawn('ellipse-partial', [[10, 5], [40, 5], [12, 17], P(200), P(20)], [[], [], [], [], sweep(200, 20)]);
    expect(one(cw)).toEqual(ai('ellipse_arc', [10, 5, 30, 12, 0, 20, 200]));
  });

  it('Parabola: focus, vertex, the two ends across its axis', async () => {
    const f = await drawn('parabola', [
      [25, 10],
      [20, 10],
      [33, 0],
      [33, 20],
    ]);
    expect(one(f)).toEqual(ai('parabola', [25, 10, 20, 10, -10, 10]));
  });

  it('Conic: two ends, the top point, a point it passes (rho)', async () => {
    // The shoulder for rho 0.4: the chord's midpoint (25, 5) plus 0.4 of the way to the top (15, 25).
    const f = await drawn('conic', [
      [5, 5],
      [45, 5],
      [15, 25],
      [21, 13],
    ]);
    const mine = one(f);
    expect(mine.rho as number).toBeCloseTo(0.4, 9);
    expect({ ...mine, rho: 0.4 }).toEqual(ai('conic', [5, 5, 45, 5, 15, 25, 0.4]));
  });
});


type D = SketchDraft & { ties?: SketchTie[] };

async function solve(d: D): Promise<{ dof: number; draft: D }> {
  const f = sketchOf(d, { ties: d.ties } as never);
  const ev = evaluateDimensions(f, mm);
  await solver.load(toSolverSketch(f, ev.values));
  const r = (await solver.solve()) as { dof: number; solved: boolean; status: string; values: { points: Record<string, Vec2>; radii: Record<string, number>; measures: Record<string, number | null> } };
  expect(r.solved, r.status).toBe(true);
  return { dof: r.dof, draft: { ...withSolved(f, r.values), ties: d.ties } };
}
function ok(r: EditOutcome): D {
  if (!r.ok) throw new Error(r.reason);
  return r.draft as D;
}
const conicOf = (d: D, id: string) => entityOf(d, id) as SketchConicEntity;
/** The largest distance from the samples of `piece` to the curve of `whole` (in `was`). */
function offCurve(d: D, piece: SketchConicEntity, was: D, whole: SketchConicEntity): number {
  const c = conicCurve(was, whole)!;
  return Math.max(...conicPolyline(conicCurve(d, piece)!, 64).map((q) => closestOnConicCurve(c, q).d));
}
const near = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6;

describe('trim with ellipses, parabolas and conics', () => {
  const E0: D = {
    points: { c: [0, 0], m: [20, 0], n: [0, 10], l1: [-30, 5], l2: [30, 5] },
    entities: [
      { id: 'e', kind: 'ellipse', c: 'c', major: 'm', minor: 'n' },
      { id: 'l', kind: 'line', p: ['l1', 'l2'] },
    ],
    constraints: [],
  };

  it('an ellipse crossed twice keeps the partial ellipse away from the pick, its ends on the line', async () => {
    const out = ok(trimAt(E0, 'e', [0, 10]));
    const e = conicOf(out, 'e');
    expect(e.kind).toBe('ellipse_arc');
    if (e.kind !== 'ellipse_arc') return;
    expect([e.c, e.major, e.minor]).toEqual(['c', 'm', 'n']);
    const x = 20 * Math.sqrt(0.75);
    // Counter-clockwise from the left crossing round the bottom to the right one.
    expect(near(out.points[e.a], [-x, 5])).toBe(true);
    expect(near(out.points[e.b], [x, 5])).toBe(true);
    expect(out.constraints.filter((c) => c.kind === 'point_on_line').map((c) => c.refs[0]).sort()).toEqual([e.a, e.b].sort());
    expect(offCurve(out, e, E0, conicOf(E0, 'e'))).toBeLessThan(1e-9);
    const s = await solve(out);
    expect(s.dof).toBe(5 + 2 + 4 - 2);
  });

  it('a partial ellipse and a parabola split into pieces on one curve (their axis points shared)', async () => {
    const d: D = {
      points: { c: [0, 0], m: [20, 0], n: [0, 10], s: [20, 0], e: [-20, 0], a1: [5, -5], a2: [5, 20], b1: [-5, -5], b2: [-5, 20] },
      entities: [
        { id: 'ea', kind: 'ellipse_arc', c: 'c', major: 'm', minor: 'n', a: 's', b: 'e' },
        { id: 'la', kind: 'line', p: ['a1', 'a2'] },
        { id: 'lb', kind: 'line', p: ['b1', 'b2'] },
      ],
      constraints: [],
    };
    const out = ok(trimAt(d, 'ea', [0, 10]));
    const pieces = out.entities.filter((x) => x.kind === 'ellipse_arc') as Extract<SketchEntity, { kind: 'ellipse_arc' }>[];
    expect(pieces.map((x) => x.id)).toEqual(['ea', 'ea.b']);
    for (const p of pieces) {
      expect([p.c, p.major, p.minor]).toEqual(['c', 'm', 'n']);
      expect(offCurve(out, p, d, conicOf(d, 'ea'))).toBeLessThan(1e-9);
    }
    expect(pieces[1].parent).toBe('ea');
    await solve(out);

    const pd: D = {
      points: { f: [5, 0], v: [0, 0], a: [5, -10], b: [5, 10], q1: [2, -20], q2: [2, 20] },
      entities: [
        { id: 'pb', kind: 'parabola', f: 'f', v: 'v', a: 'a', b: 'b' },
        { id: 'q', kind: 'line', p: ['q1', 'q2'] },
      ],
      constraints: [],
    };
    const po = ok(trimAt(pd, 'pb', [0.01, 0]));
    const pp = po.entities.filter((x) => x.kind === 'parabola') as Extract<SketchEntity, { kind: 'parabola' }>[];
    expect(pp).toHaveLength(2);
    for (const p of pp) {
      expect([p.f, p.v]).toEqual(['f', 'v']);
      expect(offCurve(po, p, pd, conicOf(pd, 'pb'))).toBeLessThan(1e-9);
    }
    await solve(po);
  });

  it('a conic piece is the same curve: a new top point and rho', async () => {
    const d: D = {
      points: { a: [0, 0], b: [40, 0], t: [10, 20], q1: [20, -5], q2: [20, 30] },
      entities: [
        { id: 'k', kind: 'conic', a: 'a', b: 'b', t: 't', rho: 0.4 },
        { id: 'q', kind: 'line', p: ['q1', 'q2'] },
      ],
      constraints: [],
    };
    const out = ok(trimAt(d, 'k', [35, 3]));
    const k = conicOf(out, 'k');
    expect(k.kind).toBe('conic');
    if (k.kind !== 'conic') return;
    expect(k.a).toBe('a');
    expect(out.points[k.b][0]).toBeCloseTo(20, 9);
    expect(k.t).not.toBe('t');
    expect(out.points.t).toBeUndefined();
    expect(k.rho).toBeGreaterThan(0);
    expect(k.rho).toBeLessThan(1);
    expect(offCurve(out, k, d, conicOf(d, 'k'))).toBeLessThan(1e-9);
    await solve(out);
  });
});

describe('mirror, patterns and offset with ellipses', () => {
  it('a mirrored partial ellipse is the mirror image and follows its source; a pattern copies it', async () => {
    const d: D = {
      points: { c: [10, 0], m: [30, 0], n: [10, 8], s: [30, 0], e: [10, 8], k1: [0, -20], k2: [0, 20] },
      entities: [
        { id: 'ea', kind: 'ellipse_arc', c: 'c', major: 'm', minor: 'n', a: 's', b: 'e' },
        { id: 'ax', kind: 'line', p: ['k1', 'k2'], construction: true, centerline: true },
      ],
      constraints: [
        { id: 'f1', kind: 'fix', refs: ['k1'] },
        { id: 'f2', kind: 'fix', refs: ['k2'] },
      ],
    };
    const out = ok(mirrorEntities(d, ['ea'], 'ax'));
    const copy = out.entities.find((x) => x.kind === 'ellipse_arc' && x.id !== 'ea') as Extract<SketchEntity, { kind: 'ellipse_arc' }>;
    expect(copy.ccw).toBe(false);
    const s = await solve(out);
    // The copy adds nothing: the source's 7 freedoms.
    expect(s.dof).toBe(7);
    const mirrored = conicPolyline(conicCurve(s.draft, copy)!, 32);
    const src = conicCurve(s.draft, conicOf(s.draft, 'ea'))!;
    for (const q of mirrored) expect(closestOnConicCurve(src, [-q[0], q[1]]).d).toBeLessThan(1e-7);

    const units = mm;
    const g: D = { points: { c: [0, 0], m: [10, 0], n: [0, 4] }, entities: [{ id: 'el', kind: 'ellipse', c: 'c', major: 'm', minor: 'n' }], constraints: [] };
    const pat = ok(createPattern(g, { kind: 'linear', sources: ['el'], count: [3, 1], exprs: { spacing1: '30 mm', angle1: '0 deg' } }, units));
    expect(pat.entities.filter((x) => x.kind === 'ellipse')).toHaveLength(3);
    const ps = await solve(pat);
    expect(ps.dof).toBe(5);
  });

  it('offset refuses an ellipse, a parabola and a conic with the reason', () => {
    const g: D = { points: { c: [0, 0], m: [10, 0], n: [0, 4] }, entities: [{ id: 'el', kind: 'ellipse', c: 'c', major: 'm', minor: 'n' }], constraints: [] };
    const r = offsetChain(g, 'el', 1, false, '2 mm', mm);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/offset of an ellipse, a parabola or a conic is no such curve/);
  });
});

describe("the person's relations and Smart Dimension on the curves", () => {
  const g = {
    points: { c: [0, 0], m: [20, 0], n: [0, 8], q: [3, 7], l1: [-30, 9], l2: [30, 9], a: [50, 0], b: [90, 0], t: [60, 20], c2: [0, 40], m2: [30, 40], n2: [0, 45] } as Record<string, Vec2>,
    entities: [
      { id: 'e', kind: 'ellipse', c: 'c', major: 'm', minor: 'n' },
      { id: 'e2', kind: 'ellipse', c: 'c2', major: 'm2', minor: 'n2' },
      { id: 'p', kind: 'point', p: 'q' },
      { id: 'l', kind: 'line', p: ['l1', 'l2'] },
      { id: 'k', kind: 'conic', a: 'a', b: 'b', t: 't', rho: 0.5 },
      { id: 'lk', kind: 'line', p: ['b', 'l2'] },
    ] as SketchEntity[],
  };
  it('take Coincident, Horizontal, Tangent, Equal and Concentric by the solver\'s rules, and say why not', async () => {
    const { planConstraint } = await import('../../src/sketch/constraints');
    const { planDimension } = await import('../../src/sketch/dimensions');
    expect(planConstraint(g, 'coincident', ['p', 'e'])).toEqual({ ok: true, add: [{ kind: 'coincident', refs: ['q', 'e'] }] });
    expect(planConstraint(g, 'horizontal', ['e', 'l'])).toEqual({ ok: true, add: [{ kind: 'horizontal', refs: ['e'] }, { kind: 'horizontal', refs: ['l'] }] });
    expect(planConstraint(g, 'tangent', ['e', 'l'])).toEqual({ ok: true, add: [{ kind: 'tangent', refs: ['l', 'e'] }] });
    expect(planConstraint(g, 'equal', ['e', 'e2'])).toEqual({ ok: true, add: [{ kind: 'equal', refs: ['e', 'e2'] }] });
    expect(planConstraint(g, 'tangent', ['k', 'lk'])).toEqual({ ok: true, add: [{ kind: 'tangent', refs: ['k', 'lk'] }] });
    expect(planConstraint(g, 'tangent', ['k', 'l'])).toMatchObject({ ok: false, reason: expect.stringMatching(/A conic is tangent to a line, or to a curve at an end they share/) });
    expect(planConstraint(g, 'coincident', ['p', 'k'])).toMatchObject({ ok: false, reason: expect.stringMatching(/only at its ends/) });
    expect(planConstraint(g, 'parallel', ['e', 'l'])).toMatchObject({ ok: false });
    expect(planDimension(g, ['e'], [0, 20])).toEqual({ reason: expect.stringMatching(/its centre and its major or minor axis end/) });
    expect(planDimension(g, ['c', 'm'], [10, 5])).toMatchObject({ kind: 'distance', value: 20 });
  });
});

describe("a conic's rho, set by the person after drawing", () => {
  it('Select with one conic picked offers Rho; a value between 0 and 1 changes the curve, others are refused', async () => {
    const s = await sketchHarness();
    s.tool('conic');
    for (const p of [[5, 5], [45, 5], [15, 25], [21, 13]] as Vec2[]) s.click(p);
    await s.idle();
    const k = s.sketch().entities.find((e) => e.kind === 'conic')!;
    s.tool('select');
    expect(s.mode.tool!.options!()).toEqual([]);
    s.mode.select([{ what: 'entity', id: k.id }], false);
    const opt = s.mode.tool!.options!();
    expect(opt).toMatchObject([{ kind: 'number', id: 'rho', label: 'Rho', expr: '0.4' }]);
    const rho = opt[0] as Extract<(typeof opt)[number], { kind: 'number' }>;
    expect(rho.set('1', 1)).toMatch(/more than 0 and less than 1/);
    expect(rho.set('0.7', 0.7)).toBeNull();
    await s.idle();
    expect((s.sketch().entities.find((e) => e.id === k.id) as { rho: number }).rho).toBe(0.7);
    s.dispose();
  });
});
