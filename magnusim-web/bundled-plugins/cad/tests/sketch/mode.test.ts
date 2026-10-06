// @vitest-environment node
// Sketch mode end to end below the UI: the real tools on a sketch session with
// the real solver (the P3 exit flow: a rectangle from the origin has 2 DOF,
// two dimensions define it fully, a diagonal asks "Make it driven?", a fully
// defined corner refuses to drag, deleting a dimension frees it, undo inside
// the sketch), chained lines with inferred relations, tangent arcs, typed
// values, constraint commands refusing an over-definition, trim of the lens,
// and Escape never finishing the sketch.
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { isDimension } from '../../src/sketch/model';
import type { SketchDimension } from '../../src/types/doc';
import { sketchHarness, type Harness } from './harness';
import { circle, merge } from './fixtures';

let h: Harness | null = null;
afterEach(() => {
  h?.dispose();
  h = null;
});

const dims = (hh: Harness) => hh.sketch().constraints.filter(isDimension) as SketchDimension[];
const kinds = (hh: Harness) =>
  hh
    .sketch()
    .constraints.map((c) => c.kind)
    .sort();

describe('sketch mode (real solver)', () => {
  it('rectangle from the origin: 2 DOF; two dimensions: fully defined; a diagonal: Make it driven?', async () => {
    h = await sketchHarness();
    expect(h.services.mode.get().mode).toBe('sketch');
    h.tool('rectangle-corner');
    h.click([0.2, 0.1]); // snaps to the origin
    h.click([40.3, 20.2]);
    await h.idle();
    const s = h.sketch();
    expect(s.entities.filter((e) => e.kind === 'line')).toHaveLength(4);
    expect(kinds(h)).toEqual(['coincident', 'horizontal', 'horizontal', 'vertical', 'vertical']);
    expect(h.mode.state.get().status).toMatchObject({ state: 'under', dof: 2 });
    expect(s.solved).toMatchObject({ state: 'under', dof: 2 });

    // Dimension the bottom (40) and the right side (20).
    h.tool('dimension');
    h.click([20, 0]);
    h.click([20, -8]);
    await h.idle();
    const d1 = dims(h)[0];
    expect(d1).toMatchObject({ kind: 'distance', driving: true });
    expect(h.mode.view.get().editing).toBe(d1.id);
    expect((await h.mode.setDimension(d1.id, '40')).ok).toBe(true);
    h.click([40, 10]);
    h.click([50, 10]);
    await h.idle();
    const d2 = dims(h)[1];
    expect((await h.mode.setDimension(d2.id, '20')).ok).toBe(true);
    await h.idle();
    expect(h.mode.state.get().status).toMatchObject({ state: 'fully', dof: 0 });
    const p = h.sketch().points;
    const corner = Object.values(p).find((x) => Math.abs(x[0] - 40) < 1e-6 && Math.abs(x[1] - 20) < 1e-6);
    expect(corner).toBeTruthy();
    expect(h.sketch().solved.values[d1.id]).toBeCloseTo(40);

    // The diagonal would over-define it: the question, then driven at what it measures.
    h.click([0, 0]);
    h.click([40, 20]);
    h.click([55, 45]);
    await h.idle();
    const q = h.mode.view.get().prompt;
    expect(q?.title).toBe('Make it driven?');
    expect(q?.accept).toBe('Make it driven');
    q!.resolve(true);
    await h.idle();
    const diag = dims(h)[2];
    expect(diag.driving).toBe(false);
    expect(h.mode.state.get().status).toMatchObject({ state: 'fully' });
  });

  it('a fully defined corner refuses to drag; deleting a dimension gives 1 DOF and the corner drags; undo in the sketch', async () => {
    h = await sketchHarness();
    h.tool('rectangle-corner');
    h.click([0, 0]);
    h.click([40, 20]);
    await h.idle();
    h.tool('dimension');
    h.click([20, 0]);
    h.click([20, -8]);
    h.click([40, 10]);
    h.click([50, 10]);
    await h.idle();
    expect(h.mode.state.get().status?.state).toBe('fully');
    const before = JSON.stringify(h.sketch().points);
    h.tool('select');
    await h.drag([40, 20], [60, 35]);
    expect(JSON.stringify(h.sketch().points)).toBe(before);
    expect(h.mode.view.get().note).toMatch(/fully defined: change a dimension to move it/);
    // Follow-up (Daniel, 2026-10-06): never the not-allowed cursor in a sketch; the words say why.
    expect(h.mode.view.get().cursor ?? '').not.toBe('not-allowed');

    // Delete the 20 (the right side's) dimension.
    const d20 = dims(h).find((d) => d.refs[0] !== h!.sketch().entities[0].id)!;
    h.mode.select([{ what: 'constraint', id: d20.id }], false);
    await h.mode.deleteSelected();
    await h.idle();
    expect(h.mode.state.get().status).toMatchObject({ state: 'under', dof: 1 });
    await h.drag([40, 20], [40, 33]);
    const moved = Object.values(h.sketch().points).some((x) => Math.abs(x[1] - 33) < 1e-4);
    expect(moved).toBe(true);
    // Undo inside the sketch: the drag, then the delete.
    h.mode.undo();
    await h.idle();
    expect(JSON.stringify(h.sketch().points)).toBe(before);
    h.mode.undo();
    await h.idle();
    expect(dims(h)).toHaveLength(2);
    expect(h.mode.state.get().status?.state).toBe('fully');
    h.mode.redo();
    await h.idle();
    expect(dims(h)).toHaveLength(1);
  });

  it('chained lines infer horizontal and vertical and share their ends; Escape ends the chain, then the tool, never the sketch', async () => {
    h = await sketchHarness();
    h.tool('line');
    h.click([0, 50]);
    h.move([30, 50.4]);
    h.click([30, 50.4]);
    h.move([30.3, 80]);
    h.click([30.3, 80]);
    await h.idle();
    const lines = h.sketch().entities.filter((e) => e.kind === 'line') as { p: [string, string] }[];
    expect(lines).toHaveLength(2);
    expect(lines[0].p[1]).toBe(lines[1].p[0]);
    expect(kinds(h)).toEqual(['horizontal', 'vertical']);
    const pts = h.sketch().points;
    expect(pts[lines[0].p[1]][1]).toBeCloseTo(50);
    expect(pts[lines[1].p[1]][0]).toBeCloseTo(30);
    h.mode.escape();
    expect(h.mode.tool?.id).toBe('line');
    h.mode.escape();
    expect(h.mode.tool?.id).toBe('select');
    h.mode.select([{ what: 'entity', id: (h.sketch().entities[0] as { id: string }).id }], false);
    h.mode.escape();
    expect(h.mode.selected()).toEqual([]);
    h.mode.escape();
    expect(h.session.open).toBe(true);
    expect(h.services.mode.get().mode).toBe('sketch');
  });

  it('A in a line chain makes the next segment a tangent arc', async () => {
    h = await sketchHarness();
    h.tool('line');
    h.click([0, 0]);
    h.click([20, 0.3]);
    await h.idle();
    expect(h.mode.tool?.toggleArc?.()).toBe(true);
    h.move([20, 20]);
    h.click([20, 20]);
    await h.idle();
    const arc = h.sketch().entities.find((e) => e.kind === 'arc');
    expect(arc).toBeTruthy();
    expect(h.sketch().constraints.some((c) => c.kind === 'tangent')).toBe(true);
    const c = h.sketch().points[(arc as { c: string }).c];
    expect(c[0]).toBeCloseTo(20, 4);
    expect(c[1]).toBeCloseTo(10, 4);
  });

  it('typed values: a line of length 25 at 30 degrees, with its dimensions', async () => {
    h = await sketchHarness();
    h.tool('line');
    h.click([5, 5]);
    h.move([10, 7]);
    h.mode.tool!.box!('length', 'input', '25');
    h.mode.tool!.box!('angle', 'tab', '30');
    h.mode.tool!.box!('angle', 'enter', '30');
    await h.idle();
    const line = h.sketch().entities.find((e) => e.kind === 'line') as { p: [string, string]; id: string };
    const [a, b] = line.p.map((id) => h!.sketch().points[id]);
    expect(Math.hypot(b[0] - a[0], b[1] - a[1])).toBeCloseTo(25, 6);
    expect((Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI).toBeCloseTo(30, 6);
    expect(dims(h).map((d) => [d.kind, d.expr])).toEqual([
      ['distance', '25 mm'],
      ['angle', '30 deg'],
    ]);
  });

  it('a constraint whose only solution shrinks a line to nothing is refused and says so', async () => {
    h = await sketchHarness();
    h.tool('line');
    h.click([0, 0]);
    h.click([30, 0.2]);
    await h.idle();
    const id = h.sketch().entities[0].id;
    h.mode.select([{ what: 'entity', id }], false);
    expect(h.services.commands.canRun('sketch.vertical')).toBe(true);
    const r = await h.mode.apply('Vertical', (d) => ({ ...d, constraints: [...d.constraints, { id: 'cv', kind: 'vertical', refs: [id] }] }));
    expect(r.ok).toBe(false);
    expect(h.mode.view.get().note).toBe('Not applied: Vertical would shrink Line 1 to nothing');
    expect(kinds(h)).toEqual(['coincident', 'horizontal']);
  });

  it('trim the arc of a circle that bounds the lens of two circles', async () => {
    h = await sketchHarness(merge(circle('c_1', [0, 0], 20), circle('c_2', [30, 0], 20)));
    h.tool('trim');
    h.click([10, 0]);
    await h.idle();
    const c2 = h.sketch().entities.find((e) => e.id === 'c_2')!;
    expect(c2.kind).toBe('arc');
    expect(h.sketch().constraints.map((c) => c.kind)).toEqual(['point_on_circle', 'point_on_circle']);
    h.mode.undo();
    await h.idle();
    expect(h.sketch().entities.find((e) => e.id === 'c_2')!.kind).toBe('circle');
  });

  it('window selection: left to right encloses, right to left crosses', async () => {
    h = await sketchHarness(merge(circle('c_1', [0, 0], 5), circle('c_2', [30, 0], 5)));
    h.tool('select');
    await h.drag([-10, -10], [10, 10]);
    expect(h.mode.selected().map((x) => x.id)).toEqual(['c_1']);
    await h.drag([40, 10], [28, -10]);
    expect(h.mode.selected().map((x) => x.id)).toEqual(['c_2']);
  });
});

describe('the other tools (real solver)', () => {
  it('center rectangle at the origin: symmetric corners, 2 DOF', async () => {
    h = await sketchHarness();
    h.tool('rectangle-center');
    h.click([0.1, 0.1]);
    h.click([20, 10]);
    await h.idle();
    const s = h.sketch();
    expect(s.entities.filter((e) => e.kind === 'line')).toHaveLength(4);
    expect(s.entities.filter((e) => e.kind === 'point')).toHaveLength(1);
    expect(kinds(h)).toEqual(['coincident', 'horizontal', 'horizontal', 'symmetric', 'vertical', 'vertical']);
    expect(h.mode.state.get().status).toMatchObject({ state: 'under', dof: 2 });
    const xs = Object.values(s.points).map((p) => p[0]);
    expect(Math.min(...xs)).toBeCloseTo(-20, 6);
    expect(Math.max(...xs)).toBeCloseTo(20, 6);
  });

  it('3-point arc, tangent arc from a line end, a point, a centerline', async () => {
    h = await sketchHarness();
    h.tool('arc-3pt');
    h.click([10, 0]);
    h.click([-10, 0]);
    h.click([0, 10]);
    await h.idle();
    const arc = h.sketch().entities.find((e) => e.kind === 'arc') as { c: string; a: string; b: string; ccw?: boolean };
    expect(h.sketch().points[arc.c][0]).toBeCloseTo(0, 6);
    expect(h.sketch().points[arc.c][1]).toBeCloseTo(0, 6);
    expect(arc.ccw).toBeUndefined(); // from (10, 0) over the top to (-10, 0): counter-clockwise

    h.tool('line');
    h.click([30, 0]);
    h.click([50, 0.2]);
    h.mode.escape();
    await h.idle();
    h.tool('arc-tangent');
    h.click([50, 0]);
    h.click([50, 20]);
    await h.idle();
    const arcs = h.sketch().entities.filter((e) => e.kind === 'arc');
    expect(arcs).toHaveLength(2);
    expect(h.sketch().constraints.filter((c) => c.kind === 'tangent')).toHaveLength(1);

    h.tool('point');
    h.click([70, 30]);
    h.tool('centerline');
    h.click([0, -30]);
    h.click([0, 30]);
    await h.idle();
    expect(h.sketch().entities.find((e) => e.kind === 'point')).toBeTruthy();
    const cl = h.sketch().entities.find((e) => e.kind === 'line' && (e as { centerline?: boolean }).centerline);
    expect(cl).toMatchObject({ construction: true, centerline: true });
  });

  it('extend a free end to the next line; construction on and off from the command', async () => {
    h = await sketchHarness({
      points: { a: [0, 0], b: [20, 0], w1: [30, -5], w2: [30, 5] },
      entities: [
        { id: 'l', kind: 'line', p: ['a', 'b'] },
        { id: 'w', kind: 'line', p: ['w1', 'w2'] },
      ],
    });
    h.tool('extend');
    h.click([19, 0.1]);
    await h.idle();
    expect(h.sketch().points.b[0]).toBeCloseTo(30, 6);
    expect(kinds(h)).toEqual(['point_on_line']);
    h.mode.select([{ what: 'entity', id: 'l' }], false);
    expect(h.services.commands.canRun('sketch.construction')).toBe(true);
    await h.services.commands.run('sketch.construction');
    await h.idle();
    expect(h.sketch().entities.find((e) => e.id === 'l')?.construction).toBe(true);
    h.mode.select([], false);
    expect(h.services.commands.canRun('sketch.construction')).toBe('Select lines, circles or arcs');
  });

  it('constraint commands run on the selection; driven and driving; a label moves; the first dimension scales the sketch', async () => {
    h = await sketchHarness({
      points: { a: [0, 0], b: [20, 1], c: [0, 10], d: [21, 12] },
      entities: [
        { id: 'l1', kind: 'line', p: ['a', 'b'] },
        { id: 'l2', kind: 'line', p: ['c', 'd'] },
      ],
    });
    h.mode.select([{ what: 'entity', id: 'l1' }, { what: 'entity', id: 'l2' }], false);
    expect(h.services.commands.canRun('sketch.parallel')).toBe(true);
    await h.services.commands.run('sketch.parallel');
    await h.idle();
    expect(kinds(h)).toEqual(['parallel']);
    h.mode.select([{ what: 'entity', id: 'l1' }], false);
    await h.services.commands.run('sketch.horizontal');
    await h.idle();
    expect(kinds(h)).toEqual(['horizontal', 'parallel']);
    // l2 follows (parallel), its length kept.
    const p = h.sketch().points;
    expect(p.d[1] - p.c[1]).toBeCloseTo(0, 6);
    // The first length dimension scales everything: 20 -> 40 doubles the sketch.
    h.tool('dimension');
    const pa = h.sketch().points.a;
    const pb = h.sketch().points.b;
    h.click([(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2]);
    h.click([10, pa[1] - 6]);
    await h.idle();
    const id = h.sketch().constraints.find((c) => c.kind === 'distance')!.id;
    const before = h.sketch().points.d;
    const len = Math.hypot(h.sketch().points.b[0] - h.sketch().points.a[0], h.sketch().points.b[1] - h.sketch().points.a[1]);
    expect((await h.mode.setDimension(id, `${2 * len}`)).ok).toBe(true);
    await h.idle();
    expect(h.sketch().points.d[0]).toBeCloseTo(before[0] * 2, 4);
    // Driven and back.
    expect((await h.mode.toggleDriving(id)).ok).toBe(true);
    expect((h.sketch().constraints.find((c) => c.id === id) as { driving: boolean }).driving).toBe(false);
    expect((await h.mode.toggleDriving(id)).ok).toBe(true);
    expect((h.sketch().constraints.find((c) => c.id === id) as { driving: boolean }).driving).toBe(true);
    // An expression that does not evaluate is refused with its reason.
    expect((await h.mode.setDimension(id, 'nope * 2')).ok).toBe(false);
    expect(h.mode.view.get().note).toBe('Not applied: Unknown parameter "nope"');
    await h.mode.moveLabel(id, [5, -20]);
    expect((h.sketch().constraints.find((c) => c.id === id) as { at: number[] }).at).toEqual([5, -20]);
  });
});
