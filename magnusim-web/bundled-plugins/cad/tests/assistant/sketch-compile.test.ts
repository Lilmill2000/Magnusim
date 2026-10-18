// @vitest-environment node
// The sketch tool's input as sketch geometry (src/assistant/sketch/compile.ts, macros.ts; CAD tools
// spec §6.3), with the real solver in this process for the DOF:
//   - each kind's ids, own relations and the DOF the solver finds: point 2, line 4, circle 3, arc 5,
//     rect 4, center_rect 4, slot 5, polygon 4, sector 6, a closed L polyline 12 (6 with infer);
//   - joins at 0.049 mm, none at 0.051 mm (a near-miss warning instead), never two points of one
//     entity, never a chain longer than the tolerance; the first entity's point wins and refs follow;
//     a chip spot drawn as two arcs and two lines with numbers rounded to 0.01 mm closes;
//   - infer: horizontal and vertical with ids <line>__h / <line>__v, marked inferred;
//   - ids (a double _, origin, duplicates, a part written out twice), every problem in one message;
//   - refs: parts (l.start, r.top, p.2, p.p2), origin, a macro without a part, a part it has not;
//   - signed distance_x kept as written, every dimension driving, a bare number stored with the
//     Part's unit; at most 180 constraints of the model's and 200 with the inferred ones;
//   - an edited sketch's kept entity keeps its stored points (shared ones stay shared).
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compileSketch, type ConstraintIn, type EntityIn } from '../../src/assistant/sketch/compile';
import { expandEntity, KIND_DOF } from '../../src/assistant/sketch/macros';
import { createUnitsService } from '../../src/doc/units';
import { toSolverSketch } from '../../src/sketch/model';
import type { SketchFeature } from '../../src/types/doc';
import type { SketchSolverClient } from '../../src/types/sketch';
import type { DocUnits } from '../../src/types/units';
import { solverAnywhere } from './solver-anywhere';

let solver: SketchSolverClient;
beforeAll(async () => {
  solver = await solverAnywhere();
}, 60_000);
afterAll(() => solver?.dispose());

const mm = createUnitsService(() => ({ length: 'mm', angle: 'deg' }) as DocUnits);
const inch = createUnitsService(() => ({ length: 'in', angle: 'deg' }) as DocUnits);
const E = (id: string, kind: string, at: number[], construction = false): EntityIn => ({ id, kind, at, construction });
const C = (id: string, kind: string, refs: string[], value = ''): ConstraintIn => ({ id, kind, refs, value });
const compile = (entities: EntityIn[], constraints: ConstraintIn[] = [], infer = false, stored: SketchFeature | null = null, units = mm) => compileSketch({ entities, constraints, infer }, { units, stored });

/** The DOF the solver finds for the compiled sketch. */
async function dofOf(c: ReturnType<typeof compile>): Promise<number> {
  await solver.load(toSolverSketch(c.draft, {}));
  await solver.solve();
  const a = (await solver.analyze()) as { dof: number };
  return a.dof;
}

const errorOf = (fn: () => unknown): { reason: string; message: string; hint: string } => {
  try {
    fn();
  } catch (e) {
    const x = e as { detail: { reason: string }; message: string; hint: string };
    return { reason: x.detail.reason, message: x.message, hint: x.hint };
  }
  throw new Error('it did not throw');
};

describe('macros', () => {
  it("each kind's ids and own relations", () => {
    const rect = compile([E('r', 'rect', [0, 0, 60, 40])]);
    expect(Object.keys(rect.draft.points)).toEqual(['r__bl', 'r__br', 'r__tr', 'r__tl']);
    expect(rect.draft.entities.map((e) => e.id)).toEqual(['r__bottom', 'r__right', 'r__top', 'r__left']);
    expect(rect.draft.constraints.map((c) => `${c.id} ${c.kind} ${c.refs.join(',')}`)).toEqual(['r__h_bottom horizontal r__bottom', 'r__v_right vertical r__right', 'r__h_top horizontal r__top', 'r__v_left vertical r__left']);
    expect(rect.own.get('r__h_top')).toBe("r's own horizontal on r.top");
    // Opposite corners in any order: corners counter-clockwise from the lower left.
    expect(compile([E('r', 'rect', [60, 40, 0, 0])]).draft.points.r__bl).toEqual([0, 0]);
    const cr = compile([E('r', 'center_rect', [5, 5, 20, 10])]);
    expect(cr.draft.points.r__bl).toEqual([-5, 0]);
    expect(cr.draft.entities.find((e) => e.id === 'r__center')).toEqual({ id: 'r__center', kind: 'point', p: 'r__center__p', construction: true });
    expect(cr.draft.constraints.find((c) => c.id === 'r__sym')).toEqual({ id: 'r__sym', kind: 'symmetric', refs: ['r__bl', 'r__tr', 'r__center'] });
    const slot = compile([E('s', 'slot', [0, 0, 30, 0, 5])]);
    expect(slot.draft.entities.map((e) => `${e.id}:${e.kind}${e.construction ? ' (construction)' : ''}`)).toEqual(['s__side1:line', 's__arc_b:arc', 's__side2:line', 's__arc_a:arc', 's__axis:line (construction)']);
    expect(slot.draft.points.s__p1).toEqual([0, 5]);
    const poly = compile([E('g', 'polygon', [0, 0, 10, 6])]);
    expect(poly.draft.entities).toHaveLength(7);
    expect(poly.draft.points.g__p1).toEqual([10, 0]);
    expect(poly.draft.constraints.filter((c) => c.kind === 'point_on_circle')).toHaveLength(6);
    expect(poly.draft.constraints.filter((c) => c.kind === 'equal')).toHaveLength(5);
    const sec = compile([E('t', 'sector', [0, 0, 10, 20, 0, 90])]);
    expect(sec.draft.points.t__outer_end[1]).toBeCloseTo(20, 12);
    expect(sec.draft.constraints.map((c) => c.id)).toEqual(['t__on_start', 't__on_end']);
    const pl = compile([E('p', 'polyline', [0, 0, 50, 0, 50, 5, 0, 0])]);
    // Closed (it ends where it starts): 3 corners p0..p2, sides 1..3, side k from p(k-1) to pk.
    expect(Object.keys(pl.draft.points)).toEqual(['p__p0', 'p__p1', 'p__p2']);
    expect(pl.draft.entities.map((e) => (e.kind === 'line' ? `${e.id}:${e.p.join('>')}` : e.id))).toEqual(['p__1:p__p0>p__p1', 'p__2:p__p1>p__p2', 'p__3:p__p2>p__p0']);
    const cl = compile([E('ax', 'centerline', [0, -10, 0, 10])]);
    expect(cl.draft.entities[0]).toEqual({ id: 'ax', kind: 'line', p: ['ax__start', 'ax__end'], construction: true, centerline: true });
  });

  it('gives each kind its DOF on the real solver', async () => {
    const cases: [string, number[], number][] = [
      ['point', [1, 2], 2],
      ['line', [0, 0, 10, 3], 4],
      ['centerline', [0, 0, 0, 10], 4],
      ['circle', [0, 0, 5], 3],
      ['arc', [0, 0, 5, 10, 120], 5],
      ['rect', [0, 0, 60, 40], 4],
      ['center_rect', [0, 0, 60, 40], 4],
      ['slot', [0, 0, 30, 10, 4], 5],
      ['polygon', [0, 0, 10, 6], 4],
      ['polygon', [3, 1, 7, 3], 4],
      ['sector', [0, 0, 10, 15, 20, 80], 6],
    ];
    for (const [kind, at, dof] of cases) {
      expect(await dofOf(compile([E('e', kind, at)])), kind).toBe(dof);
      if (KIND_DOF[kind as keyof typeof KIND_DOF] !== null) expect(KIND_DOF[kind as keyof typeof KIND_DOF], kind).toBe(dof);
    }
    // The L bracket of the guide: 6 corners, 12 DOF; infer makes its 6 sides horizontal or vertical.
    const L = [0, 0, 50, 0, 50, 5, 5, 5, 5, 40, 0, 40, 0, 0];
    expect(await dofOf(compile([E('p', 'polyline', L)]))).toBe(12);
    const inferred = compile([E('p', 'polyline', L)], [], true);
    expect(inferred.inferred).toEqual(['p__1__h', 'p__2__v', 'p__3__h', 'p__4__v', 'p__5__h', 'p__6__v']);
    expect(await dofOf(inferred)).toBe(6);
    // Anchored and dimensioned as the guide's example 2: fully defined.
    const full = compile([E('p', 'polyline', L)], [C('o', 'coincident', ['p.p0', 'origin']), C('a', 'distance', ['p.1'], '50 mm'), C('b', 'distance', ['p.6'], '40 mm'), C('t1', 'distance', ['p.2'], '5 mm'), C('t2', 'distance', ['p.5'], '5 mm')], true);
    expect(await dofOf(full)).toBe(0);
  });

  it('refuses numbers that make no shape, every problem in one message', () => {
    const e = errorOf(() => compile([E('a', 'circle', [0, 0, -1]), E('b', 'rect', [0, 0, 0, 10]), E('c', 'polygon', [0, 0, 5, 2.5]), E('d', 'arc', [0, 0, 5, 30, 30]), E('f', 'line', [1, 1])]));
    expect(e.reason).toBe('bad_entity');
    expect(e.message).toContain('entities[0] (a, circle): its radius must be more than 0');
    expect(e.message).toContain('entities[1] (b, rect): a rect needs a width and a height');
    expect(e.message).toContain('entities[2] (c, polygon): its last number is the side count, a whole number from 3 to 24, not 2.5');
    expect(e.message).toContain('entities[3] (d, arc): its start and end angles are the same');
    expect(e.message).toContain('entities[4] (f, line): a line takes 4 numbers [u1, v1, u2, v2], not 2');
    expect(e.hint).toBe('Give the entity kind the numbers its at needs (help sketch).');
    expect(expandEntity('s', 'sector', [0, 0, 10, 5, 0, 90], false)).toEqual({ ok: false, problem: 'its radii must be 0 < r1 < r2' });
  });
});

describe('joins', () => {
  it('joins ends within 0.05 mm (the first point wins, refs follow), and warns of near misses', () => {
    const j = compile([E('l1', 'line', [0, 0, 10, 0]), E('l2', 'line', [10.049, 0, 10, 10])], [C('d', 'distance', ['l2.start', 'origin'], '10 mm')]);
    expect(j.joined).toEqual(['l1.end = l2.start']);
    expect(j.draft.entities[1]).toMatchObject({ id: 'l2', p: ['l1__end', 'l2__end'] });
    expect(j.draft.points.l1__end).toEqual([10, 0]);
    expect(j.draft.points.l2__start).toBeUndefined();
    // A ref to the joined point follows it.
    expect(j.draft.constraints.find((c) => c.id === 'd')!.refs).toEqual(['l1__end', 'origin']);
    expect(j.refOf('l1__end')).toBe('l1.end');
    const n = compile([E('l1', 'line', [0, 0, 10, 0]), E('l2', 'line', [10.051, 0, 10, 10])]);
    expect(n.joined).toEqual([]);
    expect(n.warnings).toEqual(['l1.end is 0.051 mm from l2.start: not joined; add coincident or fix the numbers']);
    // Never two points of one entity; nothing joins the origin by itself.
    const own = compile([E('p', 'polyline', [0, 0, 10, 0, 0.03, 0.03])]);
    expect(own.joined).toEqual([]);
    const zero = compile([E('l1', 'line', [0.01, 0, 10, 0])]);
    expect(zero.draft.points.l1__start).toEqual([0.01, 0]);
    expect(zero.joined).toEqual([]);
  });

  it('never makes a chain longer than the tolerance; three ends at one place join as one', () => {
    // a.end, b.start and c.start within 0.03 of each other: one point.
    const three = compile([E('a', 'line', [0, 0, 10, 0]), E('b', 'line', [10.02, 0, 10, 10]), E('c', 'line', [10, 0.02, 20, 5])]);
    expect(new Set(three.draft.entities.map((e) => (e.kind === 'line' ? e.p[0] : '')).slice(1))).toEqual(new Set(['a__end']));
    // A chain: x.end to y.start 0.04, y.start to z.start 0.04, x.end to z.start 0.08: x joins y, z stays.
    const chain = compile([E('x', 'line', [0, 0, 10, 0]), E('y', 'line', [10.04, 0, 10, 10]), E('z', 'line', [10.08, 0, 20, 0])]);
    expect(chain.joined).toEqual(['x.end = y.start']);
    expect(chain.draft.entities[2]).toMatchObject({ id: 'z', p: ['z__start', 'z__end'] });
    expect(chain.warnings).toEqual(['y.start is 0.04 mm from z.start: not joined; add coincident or fix the numbers', 'x.end is 0.08 mm from z.start: not joined; add coincident or fix the numbers']);
  });

  it('closes a chip spot drawn as two arcs and two lines with numbers rounded to 0.01 mm', () => {
    const r1 = 15;
    const r2 = 19.5;
    const at = (r: number, deg: number) => [Math.round(r * Math.cos((deg * Math.PI) / 180) * 100) / 100, Math.round(r * Math.sin((deg * Math.PI) / 180) * 100) / 100];
    const c = compile([
      E('inner', 'arc', [0, 0, r1, 10, 25]),
      E('outer', 'arc', [0, 0, r2, 10, 25]),
      E('s', 'line', [...at(r1, 10), ...at(r2, 10)]),
      E('e', 'line', [...at(r1, 25), ...at(r2, 25)]),
    ]);
    // The two centres are one point too (the arcs are concentric by it).
    expect(c.joined.sort()).toEqual(['inner.center = outer.center', 'inner.end = e.start', 'inner.start = s.start', 'outer.end = e.end', 'outer.start = s.end']);
    // Every end is shared by two curves: a closed loop.
    const uses = new Map<string, number>();
    for (const e of c.draft.entities) {
      const ends = e.kind === 'line' ? e.p : e.kind === 'arc' ? [e.a, e.b] : [];
      for (const p of ends) uses.set(p, (uses.get(p) ?? 0) + 1);
    }
    expect([...uses.values()]).toEqual([2, 2, 2, 2]);
  });
});

describe('ids, refs and values', () => {
  it('refuses ids with a double _, origin, duplicates and bad characters, all at once', () => {
    const e = errorOf(() => compile([E('a__b', 'point', [0, 0]), E('origin', 'point', [1, 1]), E('Big', 'point', [2, 2]), E('dup', 'point', [3, 3])], [C('dup', 'horizontal', ['a__b', 'origin'])]));
    expect(e.reason).toBe('bad_id');
    expect(e.message).toContain('entities[0].id: "a__b" has a double _');
    expect(e.message).toContain('entities[1].id: "origin" is the sketch origin, not an id');
    expect(e.message).toContain('entities[2].id: "Big" is not an id');
    expect(e.message).toContain('constraints[0].id: "dup" is used by entities[3] too');
  });

  it('resolves parts, origin and ids; a macro needs a part; an unknown part lists the parts', () => {
    const c = compile(
      [E('r', 'rect', [0, 0, 60, 40]), E('p', 'polyline', [0, 50, 10, 50, 10, 60]), E('c', 'circle', [30, 20, 5]), E('q', 'point', [1, 1])],
      [C('a', 'coincident', ['r.bl', 'origin']), C('b', 'horizontal', ['p.1']), C('k', 'coincident', ['p.p2', 'c.center']), C('m', 'distance', ['q', 'c'], '3 mm')],
    );
    expect(c.draft.constraints.slice(-4).map((x) => x.refs)).toEqual([['r__bl', 'origin'], ['p__1'], ['p__p2', 'c__center'], ['q', 'c']]);
    const e = errorOf(() => compile([E('r', 'rect', [0, 0, 60, 40])], [C('a', 'horizontal', ['r']), C('b', 'horizontal', ['r.middle']), C('d', 'vertical', ['nope'])]));
    expect(e.reason).toBe('bad_ref');
    expect(e.message).toContain('constraints[0].refs[0] (a): r is a rect: name one of its parts (r.bl, r.br, r.tr, r.tl, r.bottom, r.right, r.top, r.left)');
    expect(e.message).toContain('constraints[1].refs[0] (b): r (rect) has no part "middle"; its parts: r.bl, r.br');
    expect(e.message).toContain('constraints[2].refs[0] (d): no entity, part or point is called "nope"');
    const twice = errorOf(() => compile([E('l', 'line', [0, 0, 5, 5])], [C('x', 'coincident', ['l.start', 'l.start'])]));
    expect(twice.message).toContain('its refs name one thing twice');
  });

  it("keeps a signed distance_x as written, every dimension driving, a bare number in the Part's unit", () => {
    const c = compile([E('a', 'point', [0, 0]), E('b', 'point', [-10, 0])], [C('dx', 'distance_x', ['a', 'b'], '-10 mm'), C('dy', 'distance_y', ['a', 'b'], '0 mm')]);
    expect(c.draft.constraints).toEqual([
      { id: 'dx', kind: 'distance_x', refs: ['a', 'b'], expr: '-10 mm', driving: true },
      { id: 'dy', kind: 'distance_y', refs: ['a', 'b'], expr: '0 mm', driving: true },
    ]);
    const i = compile([E('l', 'line', [0, 0, 100, 0])], [C('d', 'distance', ['l'], '20'), C('g', 'angle', ['l'], '0')], false, null, inch);
    expect(i.draft.constraints.map((x) => ('expr' in x ? x.expr : null))).toEqual(['20 in', '0 deg']);
    const e = errorOf(() => compile([E('l', 'line', [0, 0, 5, 0])], [C('h', 'horizontal', ['l'], '5 mm'), C('d', 'distance', ['l'], '')]));
    expect(e.reason).toBe('bad_input');
    expect(e.message).toContain('constraints[0].value (h): horizontal is a relation: its value is "", not "5 mm"');
    expect(e.message).toContain('constraints[1].value (d): a distance takes an expression');
  });

  it('allows 180 constraints of the model and 200 with the inferred ones', () => {
    const lines = Array.from({ length: 30 }, (_, k) => E(`l${k}`, 'line', [0, k * 10, 20, k * 10]));
    const rows = Array.from({ length: 180 }, (_, k) => C(`c${k}`, 'distance', [`l${k % 30}`], `${20 + k} mm`));
    // 180 + 30 inferred is past 200.
    const e = errorOf(() => compile(lines, rows, true));
    expect(e.message).toContain('constraints: 180 and 30 inferred make more than 200: split the sketch');
    expect(() => compile(lines, rows, false)).not.toThrow();
    expect(errorOf(() => compile(lines, [...rows, C('x', 'horizontal', ['l0'])])).message).toContain('constraints: at most 180, not 181');
  });

  it("keeps a kept entity's stored points when it is resent (shared points stay shared)", () => {
    const stored = {
      points: { pt_a: [0, 0], pt_b: [10, 0], pt_c: [10, 10] },
      entities: [
        { id: 'e_1', kind: 'line', p: ['pt_a', 'pt_b'] },
        { id: 'e_2', kind: 'line', p: ['pt_b', 'pt_c'] },
      ],
      constraints: [{ id: 'c_1', kind: 'horizontal', refs: ['e_1'] }],
    } as unknown as SketchFeature;
    const c = compile([E('e_1', 'line', [0, 0, 10, 0]), E('e_2', 'line', [10, 0, 10, 10])], [C('c_1', 'horizontal', ['e_1']), C('d', 'coincident', ['pt_a', 'origin'])], false, stored);
    expect(c.draft.entities).toEqual([
      { id: 'e_1', kind: 'line', p: ['pt_a', 'pt_b'] },
      { id: 'e_2', kind: 'line', p: ['pt_b', 'pt_c'] },
    ]);
    expect(c.draft.constraints.find((x) => x.id === 'd')!.refs).toEqual(['pt_a', 'origin']);
    // Moved apart on resend: the shared point is not kept for the second line.
    const apart = compile([E('e_1', 'line', [0, 0, 10, 0]), E('e_2', 'line', [12, 0, 10, 10])], [], false, stored);
    expect(apart.draft.entities[1]).toMatchObject({ p: ['e_2__start', 'pt_c'] });
  });
});
