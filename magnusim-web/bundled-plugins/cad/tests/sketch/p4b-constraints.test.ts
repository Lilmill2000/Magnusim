// P4b: what the CONSTRAIN commands do with splines (Tangent at a shared end through a
// handle, a point on a fit spline as a fit point, the others refused in words), the
// spline entity in the sketch model (points, ends, words, the solver's view, the
// kernel curve) and Smart Dimension's words for a spline.
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { planConstraint } from '../../src/sketch/constraints';
import { planDimension } from '../../src/sketch/dimensions';
import { SketchBuilder } from '../../src/sketch/edit';
import { entityEnds, entityLabel, entityPoints, refKindOf, toSolverSketch } from '../../src/sketch/model';
import { addHandle } from '../../src/sketch/tools/spline-relations';
import { curvesOf, entityGeometry } from '../../src/features/sketch/geometry';
import type { SketchEntity } from '../../src/types/doc';
import type { Geo } from './fixtures';

const g: Geo = {
  points: { a: [0, 0], b: [10, 8], c: [20, 0], q: [-10, 0], k0: [20, 0], k1: [30, 10], k2: [40, 10], k3: [50, 0], x: [10, 3] },
  entities: [
    { id: 'fit', kind: 'spline', form: 'fit', pts: ['a', 'b', 'c'], degree: 3 },
    { id: 'ctl', kind: 'spline', form: 'control', pts: ['c', 'k1', 'k2', 'k3'], degree: 3 },
    { id: 'l', kind: 'line', p: ['q', 'a'] },
    { id: 'px', kind: 'point', p: 'x' },
  ],
  constraints: [],
};

describe('splines in the sketch model', () => {
  it('points, ends, kind and words', () => {
    const fit = g.entities[0];
    expect(entityPoints(fit)).toEqual(['a', 'b', 'c']);
    expect(entityEnds(fit)).toEqual(['a', 'c']);
    expect(entityEnds({ ...fit, closed: true } as SketchEntity)).toEqual([]);
    expect(refKindOf(g, 'fit')).toBe('spline');
    expect(entityLabel(g, 'ctl')).toBe('Spline 2');
    const s = toSolverSketch(g);
    expect(s.entities.find((e) => e.id === 'fit')).toEqual({ id: 'fit', kind: 'spline', form: 'fit', pts: ['a', 'b', 'c'], degree: 3 });
  });

  it('the kernel gets a clamped bspline with its end point ids', () => {
    const geom = entityGeometry(g, g.points, {});
    const curves = curvesOf(geom);
    const c = curves.find((x) => x.id === 'ctl')!;
    expect(c).toMatchObject({ kind: 'bspline', degree: 3, knots: [0, 1], mults: [4, 4], pa: 'c', pb: 'k3', poles: [[20, 0], [30, 10], [40, 10], [50, 0]] });
    const f = curves.find((x) => x.id === 'fit')!;
    expect(f).toMatchObject({ kind: 'bspline', pa: 'a', pb: 'c' });
  });
});

describe('CONSTRAIN with splines', () => {
  it('Tangent at the shared end: a fit spline gets a handle where it heads now; a control spline goes through its second pole', () => {
    const p = planConstraint(g, 'tangent', ['l', 'fit']);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.add[0].refs).toEqual(['l', 'fit']);
    expect(p.add[0].handle).toMatchObject({ spline: 'fit', end: 0 });
    const b = new SketchBuilder(g);
    addHandle(b, p.add[0].handle!);
    const fit = b.entities.find((e) => e.id === 'fit') as Extract<SketchEntity, { kind: 'spline' }>;
    expect(fit.handles?.[0]).toBeTruthy();
    expect(fit.handles?.[1]).toBeNull();
    const c = planConstraint(g, 'tangent', ['fit', 'ctl']);
    expect(c.ok && c.add[0].handle).toMatchObject({ spline: 'fit', end: 1 });
    const apart = planConstraint(g, 'tangent', ['l', 'ctl']);
    expect(apart).toEqual({ ok: false, reason: 'A spline is tangent at an end it shares with the other curve: join them first' });
  });

  it('Coincident of a point with a spline holds it on the curve (both forms); the spline keeps its points (fix1 B2)', () => {
    expect(planConstraint(g, 'coincident', ['px', 'fit'])).toEqual({ ok: true, add: [{ kind: 'coincident', refs: ['x', 'fit'] }] });
    expect(planConstraint(g, 'coincident', ['px', 'ctl'])).toEqual({ ok: true, add: [{ kind: 'coincident', refs: ['x', 'ctl'] }] });
    const own = planConstraint(g, 'coincident', ['b', 'fit']);
    expect(own.ok).toBe(false);
  });

  it('Equal and Smart Dimension refuse a spline curve in words; Fix takes it', () => {
    expect(planConstraint(g, 'equal', ['fit', 'ctl'])).toEqual({ ok: false, reason: "Equal does not take a spline's curve: use its points" });
    expect(planConstraint(g, 'fix', ['fit'])).toEqual({ ok: true, add: [{ kind: 'fix', refs: ['fit'] }] });
    expect(planDimension(g, ['fit'], [0, 0])).toEqual({ reason: 'A spline takes dimensions on its points: pick its points (or a point and a line)' });
  });
});
