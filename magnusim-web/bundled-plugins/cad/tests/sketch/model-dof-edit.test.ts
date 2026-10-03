// The sketch model (toSolverSketch, driven dimensions measured in JS), the DOF
// mapping (status words, entity colours), the CONSTRAIN commands' rules, and
// the edits (delete with what depends on it, construction, trim and extend
// with lineage).
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { planConstraint } from '../../src/sketch/constraints';
import { colourOf, overIds, statusOf, statusText } from '../../src/sketch/dof';
import { danglingRefs, extendAt, lineageId, SketchBuilder, toggleConstruction, trimAt, trimPiece } from '../../src/sketch/edit';
import { arcGeom, constraintLabel, entityLabel, measureDimension, storedIds, toSolverSketch, withSolved } from '../../src/sketch/model';
import type { SketchEntity, Vec2 } from '../../src/types/doc';
import { circle, merge, rectangle } from './fixtures';

describe('the solver sketch', () => {
  it('locks the origin, splits collinear, gives driving dimensions their values and driven ones driving:false', () => {
    const g = merge(rectangle(0, 0, 40, 20, { origin: true }), {
      points: { q1: [50, 0], q2: [60, 0] },
      entities: [{ id: 'e5', kind: 'line', p: ['q1', 'q2'] }],
      constraints: [
        { id: 'col', kind: 'collinear', refs: ['e1', 'e5'] },
        { id: 'd1', kind: 'distance', refs: ['e1'], expr: '40 mm', driving: true },
        { id: 'd2', kind: 'distance', refs: ['p1', 'p3'], expr: '44.72 mm', driving: false },
      ],
    });
    const s = toSolverSketch(g, { d1: 41 });
    expect(s.points.origin).toEqual([0, 0]);
    expect(s.constraints[0]).toEqual({ id: '#origin', kind: 'fix', refs: ['origin'], value: [0, 0] });
    expect(s.constraints.filter((c) => c.id.startsWith('col'))).toEqual([
      { id: 'col#a', kind: 'point_on_line', refs: ['q1', 'e1'] },
      { id: 'col#b', kind: 'point_on_line', refs: ['q2', 'e1'] },
    ]);
    expect(s.constraints.find((c) => c.id === 'd1')).toEqual({ id: 'd1', kind: 'distance', refs: ['e1'], value: 41 });
    expect(s.constraints.find((c) => c.id === 'd2')).toMatchObject({ id: 'd2', driving: false });
    expect(storedIds(['#origin', 'col#a', 'col#b', 'd1'])).toEqual(['col', 'd1']);
  });

  it('measures driven dimensions on the geometry (never with PlaneGCS driving:false)', () => {
    const g = merge(rectangle(0, 0, 40, 20), circle('c1', [100, 0], 10));
    expect(measureDimension(g, { kind: 'distance', refs: ['p1', 'p3'] })).toBeCloseTo(Math.hypot(40, 20));
    expect(measureDimension(g, { kind: 'distance_x', refs: ['p3', 'p1'] })).toBe(-40);
    expect(measureDimension(g, { kind: 'diameter', refs: ['c1'] })).toBe(20);
    expect(measureDimension(g, { kind: 'distance', refs: ['p3', 'e1'] })).toBe(20);
    expect(measureDimension(g, { kind: 'angle', refs: ['e1', 'e2'] })).toBeCloseTo(90);
  });

  it('takes the solver answer into the stored geometry', () => {
    const g = merge(rectangle(0, 0, 40, 20), circle('c1', [100, 0], 10));
    const out = withSolved(g, { points: { p2: [41, 0], origin: [0, 0] }, radii: { c1: 12 } });
    expect(out.points.p2).toEqual([41, 0]);
    expect(out.points.origin).toBeUndefined();
    expect(out.entities.find((e) => e.id === 'c1')).toMatchObject({ r: 12 });
  });

  it('words for panels', () => {
    const g = rectangle(0, 0, 40, 20);
    expect(entityLabel(g, 'e3')).toBe('Line 3');
    expect(constraintLabel(g, { id: 'h', kind: 'horizontal', refs: ['e1'] })).toBe('Horizontal · Line 1');
    expect(constraintLabel(g, { id: 'd', kind: 'distance', refs: ['p1', 'p3'], expr: '44.72 mm', driving: false })).toBe('(Distance 44.72 mm) · End of Line 1, End of Line 2');
  });
});

describe('definition state', () => {
  it('maps the solver to "Under defined · n DOF", "Fully defined" and "Over defined · n conflicting"', () => {
    const under = statusOf({ status: 'ok', solved: true, dof: 2, conflicting: [], redundant: [] });
    expect(statusText(under)).toBe('Under defined · 2 DOF');
    const fully = statusOf({ status: 'ok', solved: true, dof: 0, conflicting: [], redundant: [] });
    expect(statusText(fully)).toBe('Fully defined');
    expect(statusText(fully, true)).toBe('No geometry yet');
    const over = statusOf({ status: 'conflicting', solved: false, dof: 0, conflicting: ['d3', 'col#a', '#origin'], redundant: [] });
    expect(over).toMatchObject({ state: 'over', conflicting: ['d3', 'col'] });
    expect(statusText(over)).toBe('Over defined · 2 conflicting');
    expect(statusText(statusOf({ status: 'redundant', solved: true, dof: 0, conflicting: [], redundant: ['d9'] }))).toBe('Over defined · 1 redundant');
    expect(statusOf(null, null).state).toBe('unsolved');
  });

  it('colours: over-defined wins, then the analysis; the origin is always fully defined', () => {
    const g = rectangle(0, 0, 40, 20);
    const a = { perEntity: { e1: 'fully' as const, e2: 'under' as const }, perPoint: { p1: 'fully' as const } };
    const over = overIds({ ...g, constraints: [...g.constraints, { id: 'bad', kind: 'distance', refs: ['e2'], expr: '1 mm', driving: true }] }, ['bad']);
    expect(colourOf('e1', 'entity', a, over)).toBe('fully');
    expect(colourOf('e2', 'entity', a, over)).toBe('over');
    expect(colourOf('p2', 'point', a, over)).toBe('over');
    expect(colourOf('e4', 'entity', null, new Set())).toBe('under');
    expect(colourOf('origin', 'point', null, new Set())).toBe('fully');
  });
});

describe('CONSTRAIN commands (select first)', () => {
  const g = merge(rectangle(0, 0, 40, 20), circle('c1', [100, 0], 10), circle('c2', [130, 0], 10));
  it('takes the picks each relation needs, in the solver order', () => {
    expect(planConstraint(g, 'horizontal', ['e2', 'e4'])).toEqual({ ok: true, add: [{ kind: 'horizontal', refs: ['e2'] }, { kind: 'horizontal', refs: ['e4'] }] });
    expect(planConstraint(g, 'vertical', ['p1', 'p3'])).toEqual({ ok: true, add: [{ kind: 'vertical', refs: ['p1', 'p3'] }] });
    expect(planConstraint(g, 'coincident', ['p1', 'c1'])).toEqual({ ok: true, add: [{ kind: 'coincident', refs: ['p1', 'c1'] }] });
    expect(planConstraint(g, 'tangent', ['c1', 'e1'])).toEqual({ ok: true, add: [{ kind: 'tangent', refs: ['e1', 'c1'] }] });
    expect(planConstraint(g, 'equal', ['c1', 'c2'])).toEqual({ ok: true, add: [{ kind: 'equal', refs: ['c1', 'c2'] }] });
    expect(planConstraint(g, 'midpoint', ['e1', 'p3'])).toEqual({ ok: true, add: [{ kind: 'midpoint', refs: ['p3', 'e1'] }] });
    expect(planConstraint(g, 'symmetric', ['p1', 'e2', 'p3'])).toEqual({ ok: true, add: [{ kind: 'symmetric', refs: ['p1', 'p3', 'e2'] }] });
    expect(planConstraint(g, 'fix', ['p3'])).toEqual({ ok: true, add: [{ kind: 'fix', refs: ['p3'], value: [40, 20] }] });
    expect(planConstraint(g, 'collinear', ['e1', 'e3'])).toEqual({ ok: true, add: [{ kind: 'collinear', refs: ['e1', 'e3'] }] });
  });
  it('says what to select otherwise', () => {
    expect(planConstraint(g, 'parallel', ['e1'])).toEqual({ ok: false, reason: 'Select two lines' });
    expect(planConstraint(g, 'concentric', ['e1', 'c1'])).toEqual({ ok: false, reason: 'Select two circles or arcs' });
    expect(planConstraint(g, 'tangent', ['e1', 'e2'])).toEqual({ ok: false, reason: 'Select a line or an arc and a circle or an arc' });
    expect(planConstraint(g, 'horizontal', [])).toEqual({ ok: false, reason: 'Select lines, or two points' });
    // Review P2/P3 round 1: two points in one place were accepted, and every later edit was refused.
    const twin = merge(g, { points: { t1: [20, 0], t2: [20, 0] }, entities: [], constraints: [] });
    expect(planConstraint(twin, 'symmetric', ['t1', 't2', 'e2'])).toEqual({ ok: false, reason: 'Symmetric needs two points apart: these two are in the same place' });
  });
});

describe('edits', () => {
  it('deleting a line takes its constraints and its unshared points; a point takes its lines', () => {
    const b = new SketchBuilder(rectangle(0, 0, 40, 20));
    b.remove(['e1']);
    const d = b.result();
    expect(d.entities.map((e) => e.id)).toEqual(['e2', 'e3', 'e4']);
    expect(d.constraints.map((c) => c.id)).toEqual(['v2', 'h3', 'v4']);
    expect(Object.keys(d.points).sort()).toEqual(['p1', 'p2', 'p3', 'p4']);
    const b2 = new SketchBuilder(rectangle(0, 0, 40, 20));
    b2.remove(['p2']);
    expect(b2.result().entities.map((e) => e.id)).toEqual(['e3', 'e4']);
    expect(b2.result().points.p2).toBeUndefined();
    expect(danglingRefs(b2.result())).toEqual([]);
  });

  it('construction on for the picked curves, off when they all are', () => {
    const on = toggleConstruction(rectangle(0, 0, 40, 20), ['e1', 'e2'])!;
    expect(on.entities.filter((e) => e.construction).map((e) => e.id)).toEqual(['e1', 'e2']);
    const off = toggleConstruction(on, ['e1', 'e2'])!;
    expect(off.entities.some((e) => e.construction)).toBe(false);
    expect(toggleConstruction(on, ['nope'])).toBeNull();
  });

  it('lineage ids for split pieces', () => {
    const ents: SketchEntity[] = [{ id: 'e_1', kind: 'line', p: ['a', 'b'] }, { id: 'e_1.b', kind: 'line', p: ['c', 'd'] }];
    expect(lineageId(ents, 'e_1')).toBe('e_1.c');
    expect(lineageId(ents, 'e_1.b')).toBe('e_1.b.b');
  });

  // A horizontal line crossed by two verticals at x = 10 and x = 30.
  const crossed = {
    points: { a: [0, 0] as Vec2, b: [40, 0] as Vec2, u1: [10, -5] as Vec2, u2: [10, 5] as Vec2, w1: [30, -5] as Vec2, w2: [30, 5] as Vec2 },
    entities: [
      { id: 'e_1', kind: 'line', p: ['a', 'b'] },
      { id: 'v1', kind: 'line', p: ['u1', 'u2'] },
      { id: 'v2', kind: 'line', p: ['w1', 'w2'] },
    ] as SketchEntity[],
    constraints: [
      { id: 'h', kind: 'horizontal' as const, refs: ['e_1'] },
      { id: 'len', kind: 'distance' as const, refs: ['e_1'], expr: '40 mm', driving: true },
    ],
  };

  it('trim in the middle splits: the start keeps the id, the end piece is <id>.b with parent, both stay one line', () => {
    const r = trimAt(crossed, 'e_1', [20, 0.1]);
    if (!r.ok) throw new Error(r.reason);
    const d = r.draft;
    const keep = d.entities.find((e) => e.id === 'e_1') as Extract<SketchEntity, { kind: 'line' }>;
    const piece = d.entities.find((e) => e.id === 'e_1.b') as Extract<SketchEntity, { kind: 'line' }>;
    expect(piece.parent).toBe('e_1');
    expect(d.points[keep.p[0]]).toEqual([0, 0]);
    expect(d.points[keep.p[1]][0]).toBeCloseTo(10);
    expect(d.points[piece.p[0]][0]).toBeCloseTo(30);
    expect(d.points[piece.p[1]]).toEqual([40, 0]);
    // The length no longer holds; the pieces stay collinear; the cut ends sit on the cutters.
    expect(d.constraints.find((c) => c.id === 'len')).toBeUndefined();
    expect(d.constraints.find((c) => c.kind === 'collinear')?.refs).toEqual(['e_1', 'e_1.b']);
    expect(d.constraints.filter((c) => c.kind === 'point_on_line').map((c) => c.refs[1]).sort()).toEqual(['v1', 'v2']);
    expect(r.optional.length).toBe(3);
    expect(danglingRefs(d)).toEqual([]);
    // The red preview is that middle piece.
    const piece2 = trimPiece(crossed, 'e_1', [20, 0.1])!;
    expect(piece2[0][0]).toBeCloseTo(10);
    expect(piece2[1][0]).toBeCloseTo(30);
  });

  // Review P2/P3 round 1: "On line: End of Arc 1, Line 1" for a point on the other piece (Line 4).
  it('trim in the middle: a point on the line beyond the cut is on the new piece; one before it stays on the old one', () => {
    const g = {
      ...crossed,
      points: { ...crossed.points, q: [35, 0] as Vec2, r: [5, 0] as Vec2, s1: [35, 8] as Vec2, s2: [5, 8] as Vec2 },
      entities: [...crossed.entities, { id: 'k1', kind: 'line', p: ['q', 's1'] }, { id: 'k2', kind: 'line', p: ['r', 's2'] }] as SketchEntity[],
      constraints: [...crossed.constraints, { id: 'on1', kind: 'point_on_line' as const, refs: ['q', 'e_1'] }, { id: 'on2', kind: 'point_on_line' as const, refs: ['r', 'e_1'] }],
    };
    const r = trimAt(g, 'e_1', [20, 0.1]);
    if (!r.ok) throw new Error(r.reason);
    expect(r.draft.constraints.find((c) => c.id === 'on1')!.refs).toEqual(['q', 'e_1.b']);
    expect(r.draft.constraints.find((c) => c.id === 'on2')!.refs).toEqual(['r', 'e_1']);
  });

  it('trim at an end shortens the line to the crossing; with no crossing the entity goes', () => {
    const r = trimAt(crossed, 'e_1', [35, 0]);
    if (!r.ok) throw new Error(r.reason);
    const e = r.draft.entities.find((x) => x.id === 'e_1') as Extract<SketchEntity, { kind: 'line' }>;
    expect(r.draft.points[e.p[1]][0]).toBeCloseTo(30);
    expect(r.draft.points.b).toBeUndefined();
    const lone = trimAt(rectangle(0, 0, 40, 20), 'e1', [20, 0]);
    if (!lone.ok) throw new Error(lone.reason);
    expect(lone.removed).toEqual(['e1']);
  });

  it('trim of a circle between two crossings leaves an arc (the lens of two circles goes)', () => {
    const g = merge(circle('c_1', [0, 0], 20), circle('c_2', [30, 0], 20));
    // The piece of c_2 inside c_1 (around x = 10).
    const r = trimAt(g, 'c_2', [10, 0]);
    if (!r.ok) throw new Error(r.reason);
    const arc = r.draft.entities.find((e) => e.id === 'c_2') as Extract<SketchEntity, { kind: 'arc' }>;
    expect(arc.kind).toBe('arc');
    const geo = arcGeom(r.draft, arc)!;
    expect(geo.r).toBeCloseTo(20);
    // What stays is the outside part: it passes through (50, 0), not (10, 0).
    const mid = geo.a0 + geo.sweep / 2;
    expect(30 + 20 * Math.cos(mid)).toBeCloseTo(50);
    expect(danglingRefs(r.draft)).toEqual([]);
  });

  it('extend moves a free end to the next curve; a joined end is refused', () => {
    const g = {
      points: { a: [0, 0] as Vec2, b: [20, 0] as Vec2, w1: [30, -5] as Vec2, w2: [30, 5] as Vec2 },
      entities: [
        { id: 'l', kind: 'line', p: ['a', 'b'] },
        { id: 'w', kind: 'line', p: ['w1', 'w2'] },
      ] as SketchEntity[],
      constraints: [{ id: 'len', kind: 'distance' as const, refs: ['l'], expr: '20 mm', driving: true }],
    };
    const r = extendAt(g, 'l', [19, 0]);
    if (!r.ok) throw new Error(r.reason);
    expect(r.draft.points.b[0]).toBeCloseTo(30);
    expect(r.draft.constraints.map((c) => c.kind)).toEqual(['point_on_line']);
    const joined = extendAt(rectangle(0, 0, 40, 20), 'e1', [39, 0]);
    expect(joined).toEqual({ ok: false, reason: 'Extend works on a free end: this end joins other geometry' });
  });
});
