// The sketch tool's headless solve and where its sketches lie (CAD tools spec §6.2, §6.4, §6.9), on
// the REAL kernel and solver through the page's tool handler, with sketch mode running:
//   - a rect plus the model's own horizontal on r.top: sketch_conflict naming h1 and "r's own
//     horizontal on r.top", the Part as it was (no feature, no undo step, no panel, no sketch mode);
//   - an inferred duplicate goes and is reported, also when the solver names the model's constraint;
//     only the inferred relation that repeats one goes, not the others;
//   - under-defined: kept with a warning, state under, dof and free ({of: "bo.center", moves: u, v});
//   - moved: past max(0.5 mm, 2% of the sketch's size), not under it;
//   - a collapse (a line made horizontal and vertical) and a relations-only conflict refused, and a
//     relations-only sketch stored as solved, not as drawn;
//   - an inch Part: "20" is 20 in;
//   - on each of a block's six faces the plane the guide's frame table gives (u, v, origin);
//   - "Top offset 12 mm" makes "<sketch> plane" once, the next sketch reuses it; an edit moves the
//     sketch's own plane only while nothing else uses it;
//   - the region key stays across set_params; set_params and edit_feature say `flipped` when a
//     dimension goes through zero.
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { HINTS } from '../../src/assistant/errors';
import { refOfRegion } from '../../src/features/extrude/profiles';
import type { RefPlaneFeature, SketchFeature } from '../../src/types/doc';
import { assistantHarness, REAL_KERNEL_MS, type AssistantHarness } from './harness';
import { block, C, E, featureNamed, outputOf, partNow, rectInput, SK, type Row } from './sketch-tools';

let h: AssistantHarness | null = null;
afterEach(() => {
  h?.dispose();
  h = null;
});

const ok = async (x: AssistantHarness, input: Row) => {
  const r = await x.call('sketch', input);
  if (!r.ok) throw new Error(`sketch failed: ${JSON.stringify(r.error)}`);
  return r.result as { text: string; data: Row };
};
const fail = async (x: AssistantHarness, input: Row) => {
  const r = await x.call('sketch', input);
  if (r.ok) throw new Error(`sketch did not fail: ${JSON.stringify(r.result).slice(0, 400)}`);
  return r.error as { code: string; message: string; hint: string; detail: Row };
};
const solver = (r: { data: Row }) => r.data.solver as { state: string; dof: number; free: Row[]; moved: Row[]; dropped_inferred: string[] };

describe('conflicts and duplicates', () => {
  it(
    "refuses the model's duplicate of a rect's own horizontal, naming both, with nothing changed",
    async () => {
      h = await assistantHarness({ sketchMode: true });
      await ok(h, rectInput('Plate sketch', 60, 40));
      const before = partNow(h);
      const e = await fail(h, SK({ name: 'Twice', entities: [E('r', 'rect', [0, 0, 60, 40])], constraints: [C('h1', 'horizontal', ['r.top'])] }));
      expect(e).toMatchObject({ code: 'invalid_input', hint: HINTS.sketch_conflict, detail: { reason: 'sketch_conflict' } });
      expect(e.detail.conflicts).toEqual([
        { id: 'h1', kind: 'horizontal', refs: ['r.top'], value: '', label: 'horizontal r.top' },
        { id: 'r.h_top', kind: 'horizontal', refs: ['r.top'], value: '', label: 'horizontal r.top', internal: "r's own horizontal on r.top" },
      ]);
      expect(e.message).toBe("sketch_conflict: The sketch is over-defined: h1 (horizontal r.top) and r's own horizontal on r.top say the same thing; remove h1. Nothing changed.");
      expect(partNow(h)).toEqual(before);
      expect(before).toMatchObject({ session: false, panel: false, mode: 'model' });
      // Two of the model's dimensions that cannot both hold: both named, one of them to go.
      const two = await fail(h, SK({ name: 'Two', entities: [E('l', 'line', [0, 0, 10, 0])], constraints: [C('a', 'distance', ['l'], '10 mm'), C('b', 'distance', ['l.start', 'l.end'], '12 mm')] }));
      expect(two.detail.reason).toBe('sketch_conflict');
      expect((two.detail.conflicts as Row[]).map((x) => x.id).sort()).toEqual(['a', 'b']);
      expect(two.message).toContain('cannot all hold; remove one of');
      // Circles drawn at one centre share it (a join): the model's concentric repeats it.
      const ring = await fail(h, SK({ name: 'Ring', entities: [E('o', 'circle', [0, 0, 10]), E('i', 'circle', [0, 0, 5])], constraints: [C('k', 'concentric', ['o', 'i'])] }));
      expect(ring.detail.conflicts).toEqual([{ id: 'k', kind: 'concentric', refs: ['o', 'i'], value: '', label: 'concentric o, i' }]);
      expect(ring.message).toBe('sketch_conflict: The sketch is over-defined: k (concentric o, i) repeats what the sketch already holds (points within 0.05 mm are one point, and each shape keeps its own relations); remove k. Nothing changed.');
      expect(partNow(h)).toEqual(before);
    },
    REAL_KERNEL_MS,
  );

  it(
    'drops an inferred duplicate, even when the solver names the model\'s constraint, and only that one',
    async () => {
      h = await assistantHarness({ sketchMode: true });
      // The solver names the newer one, the model's h1, as the repeat: the inferred one still goes.
      const solverApi = h.services.apis.get().solver!;
      const probe = await solverApi.analyzeFeature(
        { points: { a: [0, 0], b: [10, 0] }, entities: [{ id: 'l1', kind: 'line', p: ['a', 'b'] }], constraints: [{ id: 'l1__h', kind: 'horizontal', refs: ['l1'], inferred: true }, { id: 'h1', kind: 'horizontal', refs: ['l1'] }] } as unknown as SketchFeature,
        {},
      );
      expect([...probe.analysis.redundant, ...probe.solve.redundant]).toContain('h1');
      const r = await ok(h, SK({ name: 'Line', entities: [E('l1', 'line', [0, 0, 10, 0])], constraints: [C('h1', 'horizontal', ['l1'])], infer: true }));
      expect(solver(r)).toMatchObject({ dropped_inferred: ['horizontal l1'], state: 'under' });
      expect(r.data.inferred).toEqual([]);
      expect(r.data.warnings).toContain('left out inferred horizontal l1: they repeated other constraints');
      expect(featureNamed(h, 'Line').constraints.map((c) => c.id)).toEqual(['h1']);
      // The L polyline with infer and the model's own horizontal on its first side: only p.1's goes.
      const L = [0, 0, 50, 0, 50, 5, 5, 5, 5, 40, 0, 40, 0, 0];
      const p = await ok(h, SK({ name: 'Bracket sketch', on: 'Front', entities: [E('p', 'polyline', L)], constraints: [C('hb', 'horizontal', ['p.1']), C('o', 'coincident', ['p.p0', 'origin'])], infer: true }));
      expect(solver(p).dropped_inferred).toEqual(['horizontal p.1']);
      expect(p.data.inferred).toEqual(['vertical p.2', 'horizontal p.3', 'vertical p.4', 'horizontal p.5', 'vertical p.6']);
      expect(solver(p).dof).toBe(4);
    },
    REAL_KERNEL_MS,
  );
});

describe('the solution', () => {
  it(
    'keeps an under-defined sketch with a warning and says what still moves',
    async () => {
      h = await assistantHarness({ sketchMode: true });
      const r = await ok(h, SK({ name: 'Boss sk', entities: [E('bo', 'circle', [0, 0, 8])], constraints: [C('bd', 'diameter', ['bo'], '16 mm')] }));
      expect(solver(r)).toEqual({ state: 'under', dof: 2, free: [{ of: 'bo.center', moves: ['u', 'v'] }], moved: [], dropped_inferred: [] });
      expect(r.data.warnings).toContain('Boss sk is under-defined (dof 2): bo.center (u, v) still move; add relations or dimensions until dof is 0');
      expect(r.text).toBe('Sketch "Boss sk" on Top: under-defined (dof 2), 1 region (201.062 mm²)');
      expect(featureNamed(h, 'Boss sk').solved).toMatchObject({ state: 'under', dof: 2 });
      // Anchored: fully defined; the region key stays.
      const key = outputOf(h, 'Boss sk').regions[0].key;
      const again = await ok(h, SK({ edit: 'Boss sk', on: '', entities: [E('bo', 'circle', [0, 0, 8])], constraints: [C('bd', 'diameter', ['bo'], '16 mm'), C('b0', 'coincident', ['bo.center', 'origin'])] }));
      expect(solver(again)).toMatchObject({ state: 'fully', dof: 0, free: [] });
      expect(outputOf(h, 'Boss sk').regions[0].key).toBe(key);
    },
    REAL_KERNEL_MS,
  );

  it(
    'lists points the solution moved past max(0.5 mm, 2% of the size), and not those under it',
    async () => {
      h = await assistantHarness({ sketchMode: true });
      const far = await ok(h, rectInput('Far', 60, 40, { constraints: [C('c0', 'coincident', ['r.center', 'origin']), C('dw', 'distance', ['r.bottom'], '100 mm'), C('dh', 'distance', ['r.left'], '40 mm')] }));
      const moved = solver(far).moved as { of: string; by_mm: number }[];
      expect(moved.map((m) => m.of).sort()).toEqual(['r.bl', 'r.br', 'r.tl', 'r.tr']);
      expect(moved[0].by_mm).toBeCloseTo(20, 3);
      const near = await ok(h, rectInput('Near', 60, 40, { constraints: [C('c0', 'coincident', ['r.center', 'origin']), C('dw', 'distance', ['r.bottom'], '61 mm'), C('dh', 'distance', ['r.left'], '40 mm')] }));
      expect(solver(near).moved).toEqual([]);
    },
    REAL_KERNEL_MS,
  );

  it(
    'refuses a collapse and a relations-only conflict; stores a relations-only sketch as solved',
    async () => {
      h = await assistantHarness({ sketchMode: true });
      const before = partNow(h);
      const c = await fail(h, SK({ name: 'Flat', entities: [E('l', 'line', [0, 0, 10, 0.5])], constraints: [C('h', 'horizontal', ['l']), C('v', 'vertical', ['l'])] }));
      expect(c.detail).toMatchObject({ reason: 'sketch_collapsed', entity: 'l' });
      expect(c.message).toBe('sketch_collapsed: l would shrink to nothing: its constraints and dimensions leave it no size. Nothing changed.');
      // Parallel and perpendicular at once leave one line no length.
      const k = await fail(h, SK({ name: 'Both', entities: [E('a', 'line', [0, 0, 10, 0]), E('b', 'line', [0, 5, 10, 6])], constraints: [C('p', 'parallel', ['a', 'b']), C('q', 'perpendicular', ['a', 'b'])] }));
      expect(k.detail.reason).toBe('sketch_collapsed');
      // Relations only, one said twice: refused, never trusted as drawn.
      const dup = await fail(h, SK({ name: 'Dup', entities: [E('a', 'line', [0, 0, 10, 0])], constraints: [C('h1', 'horizontal', ['a']), C('h2', 'horizontal', ['a'])] }));
      expect(dup.detail.reason).toBe('sketch_conflict');
      expect((dup.detail.conflicts as Row[]).map((x) => x.id).sort()).toEqual(['h1', 'h2']);
      expect(partNow(h)).toEqual(before);
      // Drawn at 80 degrees, stored perpendicular: the solver ran.
      await ok(h, SK({ name: 'Square', entities: [E('a', 'line', [0, 0, 10, 0]), E('b', 'line', [10, 0, 12, 10])], constraints: [C('q', 'perpendicular', ['a', 'b'])] }));
      const f = featureNamed(h, 'Square');
      const P = f.points;
      const [a0, a1] = [P[(f.entities[0] as { p: string[] }).p[0]], P[(f.entities[0] as { p: string[] }).p[1]]];
      const [b0, b1] = [P[(f.entities[1] as { p: string[] }).p[0]], P[(f.entities[1] as { p: string[] }).p[1]]];
      const dot = (a1[0] - a0[0]) * (b1[0] - b0[0]) + (a1[1] - a0[1]) * (b1[1] - b0[1]);
      expect(Math.abs(dot)).toBeLessThan(1e-6);
    },
    REAL_KERNEL_MS,
  );

  it(
    'reads a bare number in an inch Part as inches, and names a bad expression',
    async () => {
      h = await assistantHarness({ sketchMode: true, units: 'imperial' });
      await ok(h, SK({ name: 'Inch', entities: [E('l', 'line', [0, 0, 100, 0])], constraints: [C('o', 'coincident', ['l.start', 'origin']), C('h', 'horizontal', ['l']), C('d', 'distance', ['l'], '20')] }));
      const f = featureNamed(h, 'Inch');
      expect((f.constraints.find((c) => c.id === 'd') as { expr: string }).expr).toBe('20 in');
      expect(f.points.l__end[0]).toBeCloseTo(508, 6);
      const e = await fail(h, SK({ name: 'Bad', entities: [E('l', 'line', [0, 0, 10, 0])], constraints: [C('d', 'distance', ['l'], 'thk')] }));
      expect(e.detail).toMatchObject({ reason: 'expr_error', field: 'constraints[0].value', constraints: ['d'] });
      expect(e.message).toMatch(/^expr_error: constraints\[0\] \(d\): .*thk.*Parameters: none yet\.$/);
    },
    REAL_KERNEL_MS,
  );
});

describe('where a sketch lies', () => {
  it(
    "gives each of a block's six faces the frame of the guide's table",
    async () => {
      h = await assistantHarness({ sketchMode: true });
      await block(h, { w: 60, d: 40, t: 10 });
      const faces: [string, number[], number[], number[], number[]][] = [
        // on, normal, u, v, origin
        ['Base.end', [0, 0, 1], [1, 0, 0], [0, 1, 0], [0, 0, 10]],
        ['Base.start', [0, 0, -1], [1, 0, 0], [0, -1, 0], [0, 0, 0]],
        ['Base.side(r.top)', [0, 1, 0], [1, 0, 0], [0, 0, -1], [0, 20, 0]],
        ['Base.side(r.bottom)', [0, -1, 0], [1, 0, 0], [0, 0, 1], [0, -20, 0]],
        ['Base.side(r.right)', [1, 0, 0], [0, 1, 0], [0, 0, 1], [30, 0, 0]],
        ['Base.side(r.left)', [-1, 0, 0], [0, 1, 0], [0, 0, -1], [-30, 0, 0]],
      ];
      for (const [on, normal, u, v, origin] of faces) {
        const r = await ok(h, SK({ name: `On ${on}`, on, entities: [E('c', 'circle', [0, 3, 1])] }));
        expect(r.data.plane, on).toMatchObject({ normal, u, v, origin_mm: origin });
        expect(featureNamed(h, `On ${on}`).support.kind).toBe('face');
      }
      const top = featureNamed(h, 'On Base.end');
      expect(top.support).toMatchObject({ kind: 'face', face: { name: expect.stringMatching(/:end$/) } });
      // A curved face is no support.
      await ok(h, SK({ name: 'Peg sk', entities: [E('c', 'circle', [100, 0, 5])] }));
      await h.add('extrude', { name: 'Peg', profiles: [refOfRegion(featureNamed(h, 'Peg sk').id, outputOf(h, 'Peg sk').regions[0])], extent: { kind: 'blind', distance: '10 mm' }, op: 'new' });
      const before = partNow(h);
      const e = await fail(h, SK({ name: 'Nope', on: 'Peg.side(c)', entities: [E('c', 'circle', [0, 0, 1])] }));
      expect(e.detail.reason).toBe('not_flat');
      expect(partNow(h)).toEqual(before);
    },
    REAL_KERNEL_MS,
  );

  it(
    'makes "<sketch> plane" for an offset once, reuses an identical one, and moves only its own plane',
    async () => {
      h = await assistantHarness({ sketchMode: true });
      const a = await ok(h, SK({ name: 'Pocket sk', on: 'Top offset 12 mm', entities: [E('c', 'circle', [0, 0, 5])] }));
      expect(a.data.plane).toMatchObject({ origin_mm: [0, 0, 12], normal: [0, 0, 1] });
      const plane = featureNamed<RefPlaneFeature>(h, 'Pocket sk plane');
      expect(plane).toMatchObject({ type: 'ref_plane', method: 'offset', plane: { kind: 'origin', plane: 'origin:top' }, distance: '12 mm', flip: false });
      expect(featureNamed(h, 'Pocket sk').support).toEqual({ kind: 'feature', feature: plane.id });
      // One step: one undo entry for the plane and the sketch together.
      expect(h.doc.state.get().history.undoLabel).toBe('Assistant: Sketch Pocket sk');
      // Its own plane moves with an edit while only it uses it.
      await ok(h, SK({ edit: 'Pocket sk', on: 'Top offset 15 mm', entities: [E('c', 'circle', [0, 0, 5])] }));
      expect(featureNamed<RefPlaneFeature>(h, 'Pocket sk plane').distance).toBe('15 mm');
      expect(h.doc.state.get().doc.features.filter((f) => f.type === 'ref_plane')).toHaveLength(1);
      // Another sketch on the same offset reuses the plane.
      const b = await ok(h, SK({ name: 'Second', on: 'Top offset 15 mm', entities: [E('c', 'circle', [0, 0, 3])] }));
      expect(b.data.plane).toMatchObject({ origin_mm: [0, 0, 15] });
      expect(featureNamed(h, 'Second').support).toEqual({ kind: 'feature', feature: plane.id });
      expect(h.doc.state.get().doc.features.filter((f) => f.type === 'ref_plane')).toHaveLength(1);
      // Now two sketches use it: moving the first makes a plane of its own.
      await ok(h, SK({ edit: 'Pocket sk', on: 'Top offset 20 mm flip', entities: [E('c', 'circle', [0, 0, 5])] }));
      expect(featureNamed<RefPlaneFeature>(h, 'Pocket sk plane').distance).toBe('15 mm');
      const own = featureNamed<RefPlaneFeature>(h, 'Pocket sk plane 2');
      expect(own).toMatchObject({ distance: '20 mm', flip: true });
      expect(outputOf(h, 'Pocket sk').plane.origin).toEqual([0, 0, -20]);
    },
    REAL_KERNEL_MS,
  );
});

describe('parameters', () => {
  it(
    'keeps the region key across set_params, and says flipped when a dimension goes through zero',
    async () => {
      h = await assistantHarness({ sketchMode: true });
      await h.call('set_params', { set: [{ name: 'w', kind: 'length', expr: '60 mm', comment: '', rename_to: '' }, { name: 'a', kind: 'length', expr: '10 mm', comment: '', rename_to: '' }], remove: [] });
      await ok(h, rectInput('Plate sketch', 'w', 40));
      const key = outputOf(h, 'Plate sketch').regions[0].key;
      const w = await h.ok('set_params', { set: [{ name: 'w', kind: 'length', expr: '80 mm', comment: '', rename_to: '' }], remove: [] });
      expect(w.data.flipped).toEqual([]);
      expect(outputOf(h, 'Plate sketch').regions[0].key).toBe(key);
      expect(outputOf(h, 'Plate sketch').regions[0].area).toBeCloseTo(3200, 6);
      // A triangle whose tip is a to the right of its base start: a through zero mirrors it.
      await ok(h, SK({ name: 'Tri', entities: [E('p', 'polyline', [0, 0, 20, 0, 10, 15, 0, 0])], constraints: [C('o', 'coincident', ['p.p0', 'origin']), C('h', 'horizontal', ['p.1']), C('b', 'distance', ['p.1'], '20 mm'), C('t', 'distance_x', ['p.p0', 'p.p2'], 'a'), C('ty', 'distance_y', ['p.p0', 'p.p2'], '15 mm')] }));
      const flip = await h.ok('set_params', { set: [{ name: 'a', kind: 'length', expr: '-10 mm', comment: '', rename_to: '' }], remove: [] });
      expect(flip.data.flipped).toEqual(['Tri']);
      expect(flip.data.warnings).toContain('Tri turned over: a dimension went through zero; check it with get_model or view');
      // edit_feature on the sketch's own dimension says so too.
      const back = await h.ok('edit_feature', { feature: 'Tri', set: [{ field: 't', value: '5 mm' }], rename_to: '', suppress: 'keep', move: '' });
      expect(back.data.flipped).toEqual(['Tri']);
    },
    REAL_KERNEL_MS,
  );
});
