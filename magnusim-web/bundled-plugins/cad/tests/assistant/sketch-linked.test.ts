// The sketch tool's splines, fix, driven dimensions and the person's sketch tools as rows, on the
// REAL kernel and solver through sketch mode (help sketch_tools; sketch/ops.ts):
//   - spline and control_spline store what the person's Spline tools store; their points are the
//     solver's (2 DOF each); a closed spline bounds a region that extrudes;
//   - tangent at a spline's end gives a fit spline its end handle (the person's Tangent), which
//     takes dimensions; fix holds a point (or a curve); "driven" measures; at(u, v) places a label;
//   - fillet, chamfer, trim, extend and mirror store what the person's tools store from the same
//     sketch (the ids the tools draw aside);
//   - offset and the patterns keep their ties under the row's id, and edit_feature changes their
//     values later ("p1.count", "o1.distance"): copies made or removed as in the person's row;
//   - project and intersect link the sketch to the model (fixed, followed at rebuilds); break_link
//     frees the curves;
//   - get_model's form of such a sketch resends it unchanged, ids, ties and links kept; a row left
//     out goes with what it made.
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { extendAt, trimAt, type EditOutcome } from '../../src/sketch/edit';
import { chamferCorner, filletCorner } from '../../src/sketch/tools/fillet';
import { mirrorEntities } from '../../src/sketch/tools/mirror';
import { chainOf, offsetChain, sideOf } from '../../src/sketch/tools/offset';
import { createPattern } from '../../src/sketch/tools/pattern';
import type { SketchFeature } from '../../src/types/doc';
import { HELP } from '../../src/assistant/help';
import { SKETCH_TOOL_KINDS } from '../../src/assistant/schemas';
import { assistantHarness, REAL_KERNEL_MS, type AssistantHarness } from './harness';
import { block, C, E, featureNamed, fullRegions, outputOf, SK, type Row } from './sketch-tools';

let h: AssistantHarness | null = null;
afterEach(() => {
  h?.dispose();
  h = null;
});

const ok = async (x: AssistantHarness, tool: string, input: Row) => {
  const r = await x.call(tool, input);
  if (!r.ok) throw new Error(`${tool} failed: ${JSON.stringify(r.error)}`);
  return r.result as { text: string; data: Row };
};
const fail = async (x: AssistantHarness, tool: string, input: Row) => {
  const r = await x.call(tool, input);
  if (r.ok) throw new Error(`${tool} did not fail: ${JSON.stringify(r.result).slice(0, 300)}`);
  return r.error as { code: string; message: string; hint: string; detail: Row };
};
const inputsOf = async (x: AssistantHarness, name: string) => {
  const r = await ok(x, 'get_model', { detail: 'brief', feature: name });
  return (r.data.feature as Row).inputs as Row;
};
const EDIT = (feature: string, o: Row = {}) => ({ feature, set: [], rename_to: '', suppress: 'keep', move: '', ...o });

/** A sketch as stored (what a resend must keep). */
const stored = (f: SketchFeature) => ({ points: f.points, entities: f.entities, constraints: f.constraints, ties: f.ties ?? null, links: f.links ?? null });

/**
 * A sketch with the ids the person's tools draw (random e_, pt_, c_; ties and links by order)
 * renamed in the order they are met, numbers to 1e-6: two sketches made the same way compare equal.
 */
function canon(f: SketchFeature) {
  const map = new Map<string, string>();
  let n = 0;
  const rid = (x: string) => {
    const m = /^((?:e|pt|c|t|l)_[0-9a-z]{12})(.*)$/.exec(x);
    if (!m) return x;
    if (!map.has(m[1])) map.set(m[1], `#${++n}`);
    return `${map.get(m[1])}${m[2]}`;
  };
  const tieIds = new Map((f.ties ?? []).map((t, i) => [t.id, `T${i + 1}`] as const));
  const linkIds = new Map((f.links ?? []).map((l, i) => [l.id, `L${i + 1}`] as const));
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return tieIds.get(v) ?? linkIds.get(v) ?? rid(v);
    if (typeof v === 'number') return Math.round(v * 1e6) / 1e6 + 0;
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Row).map(([k, x]) => [rid(k), walk(x)]));
    return v;
  };
  const entities = walk(f.entities);
  const constraints = walk(f.constraints);
  const ties = walk(f.ties ?? null);
  const links = walk(f.links ?? null);
  const points = walk(f.points) as Record<string, unknown>;
  return { entities, constraints, ties, links, points: Object.fromEntries(Object.entries(points).sort(([a], [b]) => (a < b ? -1 : 1))) };
}

/** One edit as the person makes it: the sketch's Edit panel, the tool's edit in sketch mode, Finish. */
async function personEdits(x: AssistantHarness, name: string, edits: [label: string, make: (d: SketchFeature) => EditOutcome][]) {
  const mode = x.mode!;
  mode.edit(featureNamed(x, name).id);
  await vi.waitFor(() => expect(mode.stored()).not.toBeNull(), { timeout: 10_000 });
  await mode.idle();
  for (const [label, make] of edits) {
    const r = await mode.apply(label, make);
    expect(r.ok, `${label}: ${JSON.stringify(r)}`).toBe(true);
  }
  expect(await mode.finish()).toBeNull();
  await x.settle();
}

const RECT = [E('r', 'rect', [0, 0, 40, 20])];
const RECT_DIMS = [C('o', 'coincident', ['r.bl', 'origin']), C('w', 'distance', ['r.bottom'], '40 mm'), C('d', 'distance', ['r.left'], '20 mm')];

describe('splines', () => {
  it(
    "store what the person's Spline tools store; their points are the solver's; a closed one bounds a region that extrudes",
    async () => {
      h = await assistantHarness({ sketchMode: true });
      // A wing section: a closed fit spline through six points (the last number pair is the first again).
      const wing = [100, 0, 60, 8, 20, 6, 0, 0, 20, -3, 60, -4, 100, 0];
      const r = await ok(h, 'sketch', SK({ name: 'Wing', entities: [E('w', 'spline', wing)] }));
      expect(featureNamed(h, 'Wing').entities).toEqual([{ id: 'w', kind: 'spline', form: 'fit', pts: ['w__p0', 'w__p1', 'w__p2', 'w__p3', 'w__p4', 'w__p5'], degree: 3, closed: true }]);
      expect(r.data.solver).toMatchObject({ state: 'under', dof: 12 });
      const regions = r.data.regions as Row[];
      expect(regions).toHaveLength(1);
      expect(regions[0].area_mm2 as number).toBeGreaterThan(500);
      expect((await fullRegions(h, 'Wing'))[0].bounded_by).toEqual(['w']);
      const ex = await ok(h, 'extrude', { edit: '', name: 'Span', sketch: 'Wing', regions: ['all'], extent: 'blind', distance: '10 mm', distance2: '', to: '', flip: false, op: 'new', bodies: [], body_name: '', color: '' });
      expect(ex.data.feature).toMatchObject({ state: 'ok' });
      const vol = await ok(h, 'measure', { targets: ['Body 1'], section: '' });
      expect(vol.data.volume_mm3 as number).toBeCloseTo((regions[0].area_mm2 as number) * 10, 0);
      // Fixed at every point: fully defined (fix [p] holds a point where it is).
      const fixed = await ok(h, 'sketch', SK({ edit: 'Wing', on: '', entities: [E('w', 'spline', wing)], constraints: [0, 1, 2, 3, 4, 5].map((k) => C(`f${k}`, 'fix', [`w.p${k}`])) }));
      expect(fixed.data.solver).toMatchObject({ state: 'fully', dof: 0 });
      expect(featureNamed(h, 'Wing').constraints[0]).toEqual({ id: 'f0', kind: 'fix', refs: ['w__p0'], value: [100, 0] });
      // A control-point spline of degree 5, open, on six poles; and its refusals.
      const cs = await ok(h, 'sketch', SK({ name: 'Poles', on: 'Front', entities: [E('c', 'control_spline', [0, 0, 10, 10, 20, 10, 30, 0, 40, -10, 50, 0, 5])] }));
      expect(featureNamed(h, 'Poles').entities).toEqual([{ id: 'c', kind: 'spline', form: 'control', pts: ['c__p0', 'c__p1', 'c__p2', 'c__p3', 'c__p4', 'c__p5'], degree: 5 }]);
      expect(cs.data.solver).toMatchObject({ dof: 12 });
      const few = await fail(h, 'sketch', SK({ name: 'Few', entities: [E('c', 'control_spline', [0, 0, 10, 10, 20, 0, 5])] }));
      expect(few.message).toContain('needs 6 poles or more, not 3');
      const deg = await fail(h, 'sketch', SK({ name: 'Deg', entities: [E('c', 'control_spline', [0, 0, 10, 10, 20, 0, 30, 0, 4])] }));
      expect(deg.message).toContain('its last number is the degree, 3 or 5, not 4');
      const dim = await fail(h, 'sketch', SK({ name: 'Dim', entities: [E('s', 'spline', [0, 0, 10, 5, 20, 0])], constraints: [C('k', 'distance', ['s'], '5 mm')] }));
      expect(dim.message).toContain("a dimension does not measure a spline's curve");
    },
    REAL_KERNEL_MS,
  );

  it(
    "a tangent gives a fit spline its end handle, which takes dimensions; fix, driven and a label's place",
    async () => {
      h = await assistantHarness({ sketchMode: true });
      const input = SK({
        name: 'Nose',
        entities: [E('l', 'centerline', [0, 0, 0, 10]), E('s', 'spline', [0, 0, 30, 10, 60, 0])],
        constraints: [
          C('o', 'coincident', ['l.start', 'origin']),
          C('v', 'vertical', ['l']),
          C('ll', 'distance', ['l', 'at(-6, 5)'], '10 mm'),
          C('t', 'tangent', ['s', 'l', 'at(0, 8)']),
          C('hl', 'distance', ['s.start', 's.h0'], '8 mm'),
          C('f1', 'fix', ['s.p1']),
          C('f2', 'fix', ['s.end', 'at(60, 0)']),
          C('span', 'distance', ['s.start', 's.end'], 'driven'),
        ],
      });
      const r = await ok(h, 'sketch', input);
      expect(r.data.solver).toMatchObject({ state: 'fully', dof: 0 });
      const f = featureNamed(h, 'Nose');
      const s = f.entities.find((e) => e.id === 's')!;
      expect(s).toMatchObject({ kind: 'spline', form: 'fit', pts: ['l__start', 's__p1', 's__p2'], handles: ['s__h0', null] });
      expect(f.points.s__h0[0]).toBeCloseTo(0, 6);
      expect(f.points.s__h0[1]).toBeCloseTo(8, 6);
      expect(f.constraints.find((c) => c.id === 't')).toEqual({ id: 't', kind: 'tangent', refs: ['s', 'l'] });
      expect(f.constraints.find((c) => c.id === 'll')).toMatchObject({ kind: 'distance', at: [-6, 5], driving: true });
      expect(f.constraints.find((c) => c.id === 'span')).toEqual({ id: 'span', kind: 'distance', refs: ['l__start', 's__p2'], expr: '60 mm', driving: false });
      expect(f.constraints.find((c) => c.id === 'f2')).toEqual({ id: 'f2', kind: 'fix', refs: ['s__p2'], value: [60, 0] });
      // The handle's length is a dimension: changed later like any other.
      await ok(h, 'edit_feature', EDIT('Nose', { set: [{ field: 'hl', value: '12 mm' }] }));
      expect(featureNamed(h, 'Nose').points.s__h0[1]).toBeCloseTo(12, 6);
      // A driving dimension that over-defines it is refused; driven, the same row is kept.
      const over = await fail(h, 'sketch', { ...input, edit: 'Nose', on: '', constraints: [...(input.constraints as Row[]), C('x', 'distance', ['s.p1', 's.end'], '20 mm')] });
      expect(over.detail.reason).toBe('sketch_conflict');
      expect(over.message).toContain('or make x driven (value "driven": it shows the value without holding it)');
      await ok(h, 'sketch', { ...input, edit: 'Nose', on: '', constraints: [...(input.constraints as Row[]), C('x', 'distance', ['s.p1', 's.end'], 'driven')] });
      expect(featureNamed(h, 'Nose').constraints.find((c) => c.id === 'x')).toMatchObject({ driving: false, expr: expect.stringMatching(/ mm$/) });
    },
    REAL_KERNEL_MS,
  );
});

describe("the person's one-shot tools", () => {
  it(
    'fillet, chamfer, trim and extend store what the person\'s tools store; a fillet\'s radius changes later',
    async () => {
      h = await assistantHarness({ sketchMode: true });
      // The Assistant's rows, and the same sketch edited as the person does.
      const r = await ok(h, 'sketch', SK({ name: 'A', entities: RECT, constraints: [...RECT_DIMS, C('f1', 'fillet', ['r.tr'], '5 mm'), C('ch', 'chamfer', ['r.bottom', 'r.left'], '3 mm; 2 mm')] }));
      await ok(h, 'sketch', SK({ name: 'B', entities: RECT, constraints: RECT_DIMS }));
      await personEdits(h, 'B', [
        ['Fillet', (d) => filletCorner(d, 'r__tr', 5, '5 mm')],
        ['Chamfer', (d) => chamferCorner(d, 'r__bl', 3, 2, ['3 mm', '2 mm'], false)],
      ]);
      expect(canon(featureNamed(h, 'A'))).toEqual(canon(featureNamed(h, 'B')));
      expect(r.data.solver).toMatchObject({ state: 'fully', dof: 0 });
      const made = r.data.made as { id: string; kind: string; entities: string[]; dimensions: string[] }[];
      expect(made.map((m) => [m.id, m.kind, m.dimensions.length])).toEqual([
        ['f1', 'fillet', 1],
        ['ch', 'chamfer', 2],
      ]);
      await ok(h, 'edit_feature', EDIT('A', { set: [{ field: made[0].dimensions[0], value: '4 mm' }] }));
      expect(featureNamed(h, 'A').constraints.find((c) => c.id === made[0].dimensions[0])).toMatchObject({ kind: 'radius', expr: '4 mm' });
      // The rows after a tool read what it made: the fillet's arc is "f1" there.
      const named = await ok(h, 'sketch', SK({ name: 'A2', entities: RECT, constraints: [...RECT_DIMS, C('f1', 'fillet', ['r.tr'], '5 mm'), C('cx', 'distance_x', ['origin', 'f1.center'], 'driven')] }));
      expect(named.data.solver).toMatchObject({ state: 'fully' });
      const a2 = featureNamed(h, 'A2');
      const arc = a2.entities.find((e) => e.kind === 'arc')!;
      expect(arc.kind === 'arc' && a2.constraints.find((c) => c.id === 'cx')).toMatchObject({ refs: ['origin', arc.kind === 'arc' ? arc.c : ''], expr: '35 mm', driving: false });
      // Trim and extend.
      const lines = [E('a', 'line', [0, 0, 40, 0]), E('b', 'line', [20, -10, 20, 10]), E('c', 'line', [0, 10, 10, 10])];
      await ok(h, 'sketch', SK({ name: 'T', entities: lines, constraints: [C('t1', 'trim', ['b', 'at(20, -5)']), C('e1', 'extend', ['c', 'at(10, 10)'])] }));
      await ok(h, 'sketch', SK({ name: 'U', entities: lines }));
      await personEdits(h, 'U', [
        ['Trim', (d) => trimAt(d, 'b', [20, -5])],
        ['Extend', (d) => extendAt(d, 'c', [10, 10])],
      ]);
      expect(canon(featureNamed(h, 'T'))).toEqual(canon(featureNamed(h, 'U')));
      const bad = await fail(h, 'sketch', SK({ name: 'V', entities: lines, constraints: [C('t1', 'trim', ['b'])] }));
      expect(bad.message).toContain('trim takes one curve and the place at(u, v)');
    },
    REAL_KERNEL_MS,
  );

  it(
    "mirror keeps its copies symmetric, as the person's Mirror; a copy is \"m1.<item>\" in later rows",
    async () => {
      h = await assistantHarness({ sketchMode: true });
      const shapes = [E('ax', 'centerline', [0, -20, 0, 20]), E('h', 'circle', [10, 5, 2]), E('k', 'line', [5, -10, 15, -10])];
      const r = await ok(h, 'sketch', SK({ name: 'M', entities: shapes, constraints: [C('m1', 'mirror', ['ax', 'h', 'k']), C('cd', 'diameter', ['m1.h'], '4 mm')] }));
      await ok(h, 'sketch', SK({ name: 'N', entities: shapes, constraints: [] }));
      await personEdits(h, 'N', [['Mirror', (d) => mirrorEntities(d, ['h', 'k'], 'ax')]]);
      const m = featureNamed(h, 'M');
      const mine = canon({ ...m, constraints: m.constraints.filter((c) => c.id !== 'cd') });
      const person = canon(featureNamed(h, 'N'));
      expect({ ...mine, points: null }).toEqual({ ...person, points: null });
      expect((r.data.made as Row[])[0]).toMatchObject({ id: 'm1', kind: 'mirror' });
      // Kept symmetric: the source follows the copy's diameter (Equal).
      expect(m.entities.find((e) => e.id === 'h')).toMatchObject({ r: 2 });
    },
    REAL_KERNEL_MS,
  );
});

describe("the person's linked tools", () => {
  it(
    'offset and the patterns keep their ties under the row id; edit_feature changes their values later',
    async () => {
      h = await assistantHarness({ sketchMode: true });
      // A circular pattern of a hole and a linear pattern in two directions, as the person's Pattern tools.
      const holes = [E('h', 'circle', [20, 0, 2]), E('s', 'circle', [-30, -10, 1])];
      const rows = [C('hc', 'distance_x', ['origin', 'h.center'], '20 mm'), C('hv', 'distance_y', ['origin', 'h.center'], '0 mm'), C('p1', 'circular_pattern', ['origin', 'h'], 'count 6'), C('p2', 'linear_pattern', ['s'], 'count 3; spacing 8 mm; angle 0 deg; count2 2; spacing2 5 mm; angle2 90 deg')];
      const r = await ok(h, 'sketch', SK({ name: 'P', entities: holes, constraints: rows }));
      await ok(h, 'sketch', SK({ name: 'Q', entities: holes, constraints: rows.slice(0, 2) }));
      const units = h.doc.units;
      await personEdits(h, 'Q', [
        ['Circular pattern', (d) => createPattern(d, { kind: 'circular', sources: ['h'], count: [6, 1], exprs: { angle: '90 deg' }, centre: 'origin', full: true }, units)],
        ['Linear pattern', (d) => createPattern(d, { kind: 'linear', sources: ['s'], count: [3, 2], exprs: { spacing1: '8 mm', angle1: '0 deg', spacing2: '5 mm', angle2: '90 deg' }, along: [null, null] }, units)],
      ]);
      expect(canon(featureNamed(h, 'P'))).toEqual(canon(featureNamed(h, 'Q')));
      const p = featureNamed(h, 'P');
      expect(p.ties!.map((t) => [t.id, t.kind, t.copies.length])).toEqual([
        ['p1', 'circular', 5],
        ['p2', 'linear', 5],
      ]);
      expect((r.data.made as Row[]).map((m) => m.id)).toEqual(['p1', 'p2']);
      expect((r.data.made as Row[])[0].entities).toContain('p1.1.h');
      expect((r.data.made as Row[])[1].entities).toContain('p2.2_1.s');
      // The pattern's values are edit_feature's fields: a new count lays the copies out again.
      await ok(h, 'edit_feature', EDIT('P', { set: [{ field: 'p1.count', value: '8' }, { field: 'p2.spacing', value: '10 mm' }] }));
      const p2 = featureNamed(h, 'P');
      expect(p2.ties!.find((t) => t.id === 'p1')).toMatchObject({ count: [8, 1] });
      expect(p2.ties!.find((t) => t.id === 'p1')!.copies).toHaveLength(7);
      expect(p2.entities.filter((e) => e.kind === 'circle')).toHaveLength(2 + 7 + 5);
      expect(p2.ties!.find((t) => t.id === 'p2')!.exprs.spacing1).toBe('10 mm');
      const bad = await fail(h, 'edit_feature', EDIT('P', { set: [{ field: 'p1.spacing', value: '3 mm' }] }));
      expect(bad.message).toContain('p1 has no value "spacing" (its values: count, angle)');
      // An offset of a closed chain to one side; its distance later.
      const plate = [E('q', 'polyline', [0, 0, 30, 0, 30, 20, 0, 20, 0, 0])];
      const held = [C('k1', 'fix', ['q.1']), C('k3', 'fix', ['q.3'])];
      await ok(h, 'sketch', SK({ name: 'O', entities: plate, constraints: [...held, C('o1', 'offset', ['q.1', 'at(15, 3)'], '2 mm')] }));
      await ok(h, 'sketch', SK({ name: 'O2', entities: plate, constraints: held }));
      await personEdits(h, 'O2', [['Offset', (d) => offsetChain(d, 'q__1', sideOf(d, chainOf(d, 'q__1')!, [15, 3]), false, '2 mm', units)]]);
      expect(canon(featureNamed(h, 'O'))).toEqual(canon(featureNamed(h, 'O2')));
      const o = outputOf(h, 'O');
      expect(o.regions).toHaveLength(2);
      await ok(h, 'edit_feature', EDIT('O', { set: [{ field: 'o1.distance', value: '3 mm' }] }));
      const areas = outputOf(h, 'O').regions.map((x) => x.area);
      expect(areas.some((x) => Math.abs(x - 24 * 14) < 1e-3), String(areas)).toBe(true);
    },
    REAL_KERNEL_MS,
  );

  it(
    'project and intersect link the sketch to the model; break_link frees the curves',
    async () => {
      h = await assistantHarness({ sketchMode: true });
      await block(h, { w: 60, d: 40, t: 10 });
      const r = await ok(h, 'sketch', SK({ name: 'Lid', on: 'Base.end', entities: [E('c', 'circle', [0, 0, 5])], constraints: [C('pr', 'project', ['Base.end'])] }));
      const f = featureNamed(h, 'Lid');
      expect(f.links).toHaveLength(1);
      expect(f.links![0]).toMatchObject({ id: 'pr', type: 'projected', source: { kind: 'face' } });
      expect(f.entities.filter((e) => e.link === 'pr')).toHaveLength(4);
      expect((r.data.made as Row[])[0].entities).toEqual(['pr.1', 'pr.2', 'pr.3', 'pr.4']);
      // The face's outline bounds a region with the circle as its hole.
      expect((r.data.regions as Row[]).map((x) => x.holes)).toEqual([1, 0]);
      expect((await fullRegions(h, 'Lid')).map((x) => [x.holes, x.depth])).toEqual([
        [1, 0],
        [0, 1],
      ]);
      // Constrained to the linked curves: fully defined (they are fixed).
      const tied = await ok(h, 'sketch', SK({ name: 'Ring', on: 'Base.end', entities: [E('c', 'circle', [0, 0, 5])], constraints: [C('pr', 'project', ['Base.end']), C('t1', 'tangent', ['c', 'pr.1']), C('cc', 'distance_x', ['origin', 'c.center'], '0 mm'), C('cv', 'distance_y', ['origin', 'c.center'], '-10 mm')] }));
      expect(tied.data.solver).toMatchObject({ state: 'fully', dof: 0 });
      // Intersect: where Front cuts the block; a silhouette from above.
      await ok(h, 'sketch', SK({ name: 'Cut', on: 'Front', entities: [E('k', 'point', [0, 30])], constraints: [C('ix', 'intersect', ['Body 1'])] }));
      expect(featureNamed(h, 'Cut').links![0]).toMatchObject({ id: 'ix', type: 'intersection', source: { kind: 'section' } });
      expect(outputOf(h, 'Cut').regions).toHaveLength(1);
      await ok(h, 'sketch', SK({ name: 'Shadow', on: 'Top offset 30 mm', entities: [E('k', 'point', [0, 50])], constraints: [C('sh', 'project', ['Body 1'])] }));
      expect(featureNamed(h, 'Shadow').links![0].source.kind).toBe('silhouette');
      // break_link: the curves stay where they are, unlinked.
      await ok(h, 'sketch', SK({ name: 'Free', on: 'Base.end', entities: [E('c', 'circle', [0, 0, 5])], constraints: [C('pr', 'project', ['Base.end']), C('b1', 'break_link', ['pr'])] }));
      const free = featureNamed(h, 'Free');
      expect(free.links ?? []).toEqual([]);
      expect(free.entities.filter((e) => e.kind === 'line')).toHaveLength(4);
      expect(free.entities.some((e) => e.link)).toBe(false);
      const twice = await fail(h, 'sketch', SK({ name: 'Two', on: 'Base.end', entities: [E('c', 'circle', [0, 0, 5])], constraints: [C('a1', 'project', ['Base.end']), C('a2', 'project', ['Base.end'])] }));
      expect(twice.message).toContain('in the sketch already (a1)');
      // An edge (one line) and a vertex (a point) of the block, on a plane above it.
      const ev = await ok(h, 'sketch', SK({ name: 'Marks', on: 'Top offset 20 mm', entities: [E('k', 'point', [0, 50])], constraints: [C('pe', 'project', ['Base.end & Base.side(r.top)']), C('pv', 'project', ['Body 1 vertices >X >Y >Z'])] }));
      const marks = featureNamed(h, 'Marks');
      expect(marks.links!.map((l) => [l.id, l.source.kind])).toEqual([
        ['pe', 'edge'],
        ['pv', 'vertex'],
      ]);
      expect(marks.entities.filter((e) => e.link).map((e) => e.kind).sort()).toEqual(['line', 'point']);
      expect((ev.data.made as Row[]).map((m) => m.entities)).toEqual([['pe'], ['pv']]);
    },
    REAL_KERNEL_MS,
  );
});

describe('the watch pace', () => {
  it(
    'draws what the tools made one by one, and stores the ties and links as the fast pace does',
    async () => {
      const rows = [C('hc', 'distance_x', ['origin', 'h.center'], '20 mm'), C('hv', 'distance_y', ['origin', 'h.center'], '0 mm'), C('p1', 'circular_pattern', ['origin', 'h'], 'count 4'), C('f1', 'fillet', ['r.tr'], '3 mm')];
      const input = SK({ name: 'W', entities: [E('r', 'rect', [-40, -40, 40, 40]), E('h', 'circle', [20, 0, 2])], constraints: rows });
      h = await assistantHarness({ sketchMode: true });
      await ok(h, 'sketch', input);
      const fast = canon(featureNamed(h, 'W'));
      h.dispose();
      h = await assistantHarness({ sketchMode: true, pace: 'watch' });
      await ok(h, 'sketch', input);
      const watched = featureNamed(h, 'W');
      expect(watched.ties!.map((t) => [t.id, t.copies.length])).toEqual([['p1', 3]]);
      expect(canon(watched)).toEqual(fast);
    },
    REAL_KERNEL_MS,
  );
});

describe('help sketch_tools', () => {
  it('documents every one of the tool kinds the rows take', () => {
    const text = JSON.stringify(HELP.sketch_tools);
    for (const k of SKETCH_TOOL_KINDS) expect(text, k).toContain(k);
    for (const k of ['spline', 'control_spline']) expect(HELP.sketch.some((r) => r.about === k)).toBe(true);
  });
});

describe('replace', () => {
  it(
    'a trimmed spline and a split line resend as they are: pieces, lineage, handles and exact knots kept',
    async () => {
      h = await assistantHarness({ sketchMode: true });
      const shapes = [E('s', 'spline', [0, 0, 20, 10, 40, -5, 60, 0]), E('c', 'control_spline', [0, -10, 15, 10, 30, -10, 45, 10, 3]), E('k', 'line', [30, -20, 30, 20]), E('m', 'line', [0, 15, 60, 15])];
      await ok(h, 'sketch', SK({ name: 'Cut', entities: shapes, constraints: [C('t1', 'trim', ['s', 'at(55, -1)']), C('t2', 'trim', ['c', 'at(40, 3)']), C('t3', 'trim', ['k', 'at(30, 12)'])] }));
      const before = stored(featureNamed(h, 'Cut'));
      const s = before.entities.find((e) => e.id === 's')!;
      expect(s.kind === 'spline' && (s.handles || s.spans)).toBeTruthy();
      expect(before.entities.some((e) => e.kind === 'spline' && e.form === 'control' && !!e.knots)).toBe(true);
      expect(before.entities.some((e) => e.parent === 'k')).toBe(true);
      const form = await inputsOf(h, 'Cut');
      await ok(h, 'sketch', form);
      const again = stored(featureNamed(h, 'Cut'));
      expect(again.entities).toEqual(before.entities);
      expect(again.constraints).toEqual(before.constraints);
    },
    REAL_KERNEL_MS,
  );

  it(
    "get_model's form of a sketch with splines, links, ties, fix and driven dimensions resends it unchanged; a row left out goes",
    async () => {
      h = await assistantHarness({ sketchMode: true });
      await block(h, { w: 60, d: 40, t: 10 });
      const input = SK({
        name: 'All',
        on: 'Base.end',
        entities: [E('l', 'centerline', [-20, 0, -20, 10]), E('s', 'spline', [-20, 0, 0, 8, 20, 0]), E('r', 'rect', [-25, -15, -5, -5]), E('h', 'circle', [10, -10, 2])],
        constraints: [
          C('t', 'tangent', ['s', 'l']),
          C('fx', 'fix', ['s.p1']),
          C('dr', 'distance', ['s.start', 's.end'], 'driven'),
          C('lw', 'distance', ['r.bottom', 'at(-15, -18)'], '20 mm'),
          C('f1', 'fillet', ['r.tr'], '2 mm'),
          C('p1', 'linear_pattern', ['h'], 'count 3; spacing 6 mm; angle 0 deg'),
          C('o1', 'offset', ['r.bottom', 'at(-15, -10)'], '1 mm'),
          C('pr', 'project', ['Base.end']),
          C('m1', 'mirror', ['l', 'h']),
        ],
      });
      await ok(h, 'sketch', input);
      const before = stored(featureNamed(h, 'All'));
      const form = await inputsOf(h, 'All');
      expect(form).not.toBeNull();
      expect((form.entities as Row[]).map((e) => e.kind)).toContain('spline');
      const rows = form.constraints as Row[];
      expect(rows.slice(0, 3).map((x) => [x.id, x.kind])).toEqual([
        ['pr', 'project'],
        ['p1', 'linear_pattern'],
        ['o1', 'offset'],
      ]);
      expect(rows.find((x) => x.id === 'p1')).toMatchObject({ refs: ['h'], value: 'count 3; spacing 6 mm; angle 0 deg' });
      expect(rows.find((x) => x.id === 'dr')).toMatchObject({ value: 'driven' });
      // The fillet changed the rect's corner: its sides are lines of their own now.
      expect(rows.find((x) => x.id === 'lw')).toMatchObject({ refs: ['r__bottom', 'at(-15, -18)'] });
      // Resent as it is: the same sketch, ids, ties and links kept.
      await ok(h, 'sketch', form);
      const again = stored(featureNamed(h, 'All'));
      for (const k of ['entities', 'constraints', 'ties', 'links'] as const) expect(again[k], k).toEqual(before[k]);
      // Under-defined, it is solved again from the form's numbers (to 1e-6 mm): the points stay within that.
      expect(Object.keys(again.points).sort()).toEqual(Object.keys(before.points).sort());
      for (const [id, p] of Object.entries(before.points)) expect(Math.hypot(again.points[id][0] - p[0], again.points[id][1] - p[1]), id).toBeLessThan(1e-5);
      // New values lay a kept pattern out again; a row left out goes with its copies.
      await ok(h, 'sketch', { ...form, constraints: rows.filter((x) => x.id !== 'o1').map((x) => (x.id === 'p1' ? { ...x, value: 'count 4; spacing 6 mm; angle 0 deg' } : x)) });
      const after = featureNamed(h, 'All');
      expect(after.ties!.map((t) => [t.id, t.copies.length])).toEqual([['p1', 3]]);
      expect(after.links!.map((l) => l.id)).toEqual(['pr']);
      expect(after.links![0].entities.map((x) => x.entity)).toEqual(before.links![0].entities.map((x) => x.entity));
      const kept = before.ties!.find((t) => t.id === 'p1')!.copies.flatMap((c) => Object.values(c.entities));
      for (const id of kept) expect(after.entities.some((e) => e.id === id)).toBe(true);
    },
    REAL_KERNEL_MS,
  );
});
