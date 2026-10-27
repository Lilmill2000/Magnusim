// Ellipses, partial ellipses, parabolas and rho conics in the Assistant's sketch tool on the REAL
// kernel and solver: an ellipse sketched, held by the person's relations and dimensions, extruded to
// pi a b h, and get_model's input form resending the same sketch; a partial ellipse closed by a line
// (joined at its end, not its axis end), a parabola and a conic making regions of the closed-form
// areas; the curves taking the person's relation rules and saying so when they do not.
// (The records against the person's tools, and each kind's DOF: tests/sketch/conic-tools.test.ts.)
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import type { SketchEntity } from '../../src/types/doc';
import { EXTRUDE, fail, ok } from './extrude-tools';
import { assistantHarness, REAL_KERNEL_MS, type AssistantHarness } from './harness';
import { C, E, featureNamed, outputOf, SK, type Row } from './sketch-tools';

let h: AssistantHarness | null = null;
afterEach(() => {
  h?.dispose();
  h = null;
});

describe('the sketch tool with ellipses on the real kernel and solver', () => {
  it(
    "an ellipse held by the person's relations and dimensions extrudes to pi a b h; its form resends the same sketch",
    async () => {
      h = await assistantHarness({ sketchMode: true });
      h.fake.emitTurn({ id: 't-test', title: 'An elliptic boss' });
      const r = await ok(
        h,
        'sketch',
        SK({
          name: 'Oval',
          entities: [E('e', 'ellipse', [1, 2, 28, 11, 10])],
          constraints: [C('o', 'coincident', ['e.center', 'origin']), C('h', 'horizontal', ['e']), C('a', 'distance', ['e.center', 'e.major'], '30 mm'), C('b', 'distance', ['e.center', 'e.minor'], '12 mm')],
        }),
      );
      expect(r.data).toMatchObject({ feature: { name: 'Oval', type: 'sketch', state: 'ok' } });
      const oval = featureNamed(h, 'Oval');
      expect(oval.solved.dof).toBe(0);
      expect(oval.entities.map((e) => e.kind)).toEqual(['ellipse']);
      const out = outputOf(h, 'Oval');
      expect(out.regions).toHaveLength(1);
      expect(out.regions[0].area).toBeCloseTo(Math.PI * 30 * 12, 6);
      const x = await ok(h, 'extrude', EXTRUDE({ name: 'Boss', sketch: 'Oval', distance: '5 mm' }));
      const created = (x.data.bodies as { created: { volume_mm3: number }[] }).created;
      // The reply rounds volumes to 0.01 mm3.
      expect(Math.abs(created[0].volume_mm3 - Math.PI * 30 * 12 * 5)).toBeLessThan(0.006);
      // get_model's input form, resent as it is, gives the same sketch.
      const form = (await ok(h, 'get_model', { detail: 'brief', feature: 'Oval' })).data.feature as Row;
      const inputs = form.inputs as Row;
      expect((inputs.entities as Row[])[0]).toMatchObject({ id: 'e', kind: 'ellipse' });
      const before = { points: oval.points, entities: oval.entities, constraints: oval.constraints };
      await ok(h, 'sketch', { ...inputs, edit: 'Oval' });
      const after = featureNamed(h, 'Oval');
      expect({ entities: after.entities, constraints: after.constraints }).toEqual({ entities: before.entities, constraints: before.constraints });
      // The points where they were (the solve's round-off aside).
      expect(Object.keys(after.points).sort()).toEqual(Object.keys(before.points).sort());
      for (const [id, p] of Object.entries(before.points)) expect(Math.hypot(after.points[id][0] - p[0], after.points[id][1] - p[1]), id).toBeLessThan(1e-9);
    },
    REAL_KERNEL_MS,
  );

  it(
    'a partial ellipse closed by a line, a parabola and a conic make regions; their curves take the person\'s rules',
    async () => {
      h = await assistantHarness({ sketchMode: true });
      h.fake.emitTurn({ id: 't-test', title: 'Curves' });
      await ok(
        h,
        'sketch',
        SK({
          name: 'Half',
          entities: [E('e', 'ellipse_arc', [0, 0, 20, 8, 0, 0, 180]), E('l', 'line', [-20, 0, 20, 0]), E('p', 'parabola', [65, 0, 60, 0, -10, 10]), E('q', 'line', [65, 10, 65, -10]), E('k', 'conic', [100, 0, 140, 0, 110, 20, 0.5]), E('m', 'line', [140, 0, 100, 0])],
          constraints: [C('hz', 'horizontal', ['p'])],
        }),
      );
      // The line's end on the arc's end (not on its major axis end, which is in the same place).
      const half = featureNamed(h, 'Half');
      const arc = half.entities.find((x) => x.id === 'e') as Extract<SketchEntity, { kind: 'ellipse_arc' }>;
      const line = half.entities.find((x) => x.id === 'l') as Extract<SketchEntity, { kind: 'line' }>;
      expect([...line.p].sort()).toEqual([arc.a, arc.b].sort());
      const out = outputOf(h, 'Half');
      const areas = out.regions.map((x) => x.area).sort((a, b) => a - b);
      expect(areas).toHaveLength(3);
      expect(areas[0]).toBeCloseTo((2 / 3) * 20 * 5, 6);
      expect(areas[1]).toBeCloseTo((Math.PI * 160) / 2, 6);
      expect(areas[2]).toBeCloseTo((2 / 3) * 400, 6);
      // A dimension on the curve, a point on a conic: refused with the person's words.
      const dim = await fail(h, 'sketch', SK({ name: 'Bad', entities: [E('e', 'ellipse', [0, 0, 20, 8, 0])], constraints: [C('r', 'radius', ['e'], '5 mm')] }));
      expect(dim.message).toMatch(/dimension its points \(e\.center to e\.major is the major radius/);
      const on = await fail(h, 'sketch', SK({ name: 'Bad', entities: [E('k', 'conic', [0, 0, 40, 0, 10, 20, 0.5]), E('p', 'point', [20, 9])], constraints: [C('c', 'point_on', ['p', 'k'])] }));
      expect(on.message).toMatch(/A point lies on a conic only at its ends/);
      // A line tangent to an ellipse anywhere; a point on it.
      await ok(
        h,
        'sketch',
        SK({
          name: 'Touch',
          entities: [E('e', 'ellipse', [0, 0, 20, 8, 0]), E('l', 'line', [-30, 9, 30, 10]), E('p', 'point', [3, 7])],
          constraints: [C('t', 'tangent', ['l', 'e']), C('on', 'point_on', ['p', 'e'])],
        }),
      );
      const touch = featureNamed(h, 'Touch');
      expect(touch.constraints.map((c) => [c.kind, c.refs])).toEqual([
        ['tangent', ['l', 'e']],
        ['coincident', ['p__p', 'e']],
      ]);
    },
    REAL_KERNEL_MS,
  );
});
