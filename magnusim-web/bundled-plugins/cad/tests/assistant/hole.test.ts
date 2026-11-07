// hole on the REAL kernel and solver, through the page's tool handler and the person's own sketch
// mode and Extrude panel (CAD tools spec §3.2.18, §12.1 hole.test.ts), on a 60 x 40 x 10 block
// "Base" (x -30..30, y -20..20, z 0..10):
//   - on each of the six axis faces, centres in model coordinates land where asked (the holes'
//     cylinder axes, as find measures them), with the sketch's position dimensions h1x / h1y signed
//     as the face's frame runs (on -X: u +Y, v -Z, so z "b/2" is h1y "-(b/2)");
//   - through and blind volumes; parameters drive the holes; edit_feature on the sketch's d
//     changes every hole; one step, one undo entry for the request; get_model full shows the two
//     features as sketch and extrude inputs made_by "hole", and the extrude's resent as it is;
//   - refused before anything changes (no feature, no panel, no undo entry): the fields, a curved
//     face (not_flat), a tilted face (bad_input: use sketch and extrude cut), a missing coordinate,
//     every expression problem at once, a centre off the face's plane, a centre outside the face
//     (named by its row), the same centre twice, a name taken; edit_feature of the cut's d points to
//     the hole's sketch; a hole that breaks the face's edge
//     (its centre off the face within half the diameter, or on it near an edge) is made and warned;
//   - a drill point (tip "drill", 118 deg, or the point's own angle) below a blind hole, refused on
//     a through hole; a blind hole deeper than the block goes through, the reply says so and leaves
//     out the drill point it asked for (issue 14);
//   - a value (set_params, the sketch's position dimension, with a rename too) that moves a hole
//     off its body, where it builds and cuts nothing, changes nothing (broke_downstream with the
//     diagnosis); a structural edit that leaves a scoped cut with nothing to cut is kept and warns;
//   - a person's panel opened between the sketch and the cut (between-opens, forced) is waited
//     for: the step goes back under it, and once it closes the call plans anew and keeps both
//     features as one undo group;
//   - the person's Ctrl+Z between the sketch and the cut (forced), or while "Ask each step" asks
//     "keep it?", takes the whole hole back at once (no sketch left, nothing of it stored, the
//     history as before the call; Undo's hint says so), and the call answers taken_over (undo);
//   - a hole drilled in a block that Move/copy body moved stays in it when the move is edited (its
//     distance and a turn): the sketch's face reference keeps where the block was (review fix).
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { negated } from '../../src/assistant/tools/hole';
import { runtimeOf } from '../../src/assistant/runtime';
import type { ExtrudeFeature, SketchDimension, SketchFeature } from '../../src/types/doc';
import { uiFor } from '../../src/ui/controller';
import { installUi } from '../../src/ui/commands';
import { EXTRUDE, fail, names, ok, volume } from './extrude-tools';
import { assistantHarness, type AssistantHarness } from './harness';
import { undoLabel } from './parts';
import { block, E, featureNamed, partNow, SK, type Row } from './sketch-tools';

let h: AssistantHarness | null = null;
afterEach(() => {
  h?.dispose();
  h = null;
});

/** Real-kernel tests with several features each: a generous ceiling (Linux CI runs on 2 slow cores). */
const HOLE_MS = 240_000;
const PI = Math.PI;
const BLOCK = 60 * 40 * 10;

const HOLE = (o: Row = {}): Row => ({ name: '', face: 'Base.end', centers: [], diameter: '5 mm', depth: 'through', distance: '', ...o });
const CTR = (x: string, y: string, z: string) => ({ x, y, z });
const P = (name: string, expr: string) => ({ name, kind: 'length', expr, comment: '', rename_to: '' });
const EDIT = (feature: string, o: Row = {}) => ({ feature, set: [], rename_to: '', suppress: 'keep', move: '', ...o });
const DIRECT = (o: Row = {}): Row => ({ edit: '', name: '', kind: 'press_pull', faces: [], distance: '', bodies: [], tool: '', keep_tool: false, move: [], turn: { angle: '', axis: '', pivot: [] }, copy: false, shape: 'box', padding: 'zero', sides: [], ...o });

/** A sketch's dimension expressions by id. */
function dims(x: AssistantHarness, sketch: string): Record<string, string> {
  return Object.fromEntries(featureNamed<SketchFeature>(x, sketch).constraints.filter((c): c is SketchDimension => 'expr' in c).map((c) => [c.id, c.expr]));
}

/** The round faces find lists for a selector: their axis (a point and a direction) and radius. */
async function cylinders(x: AssistantHarness, query: string): Promise<{ point: number[]; dir: number[]; radius: number; label: string }[]> {
  const r = await ok(x, 'find', { query, limit: 50 });
  const rows = (r.data.rows ?? []) as { type?: string; axis?: { point_mm: number[]; dir: number[] }; radius_mm?: number; label?: string }[];
  return rows.filter((w) => w.type === 'cylinder').map((w) => ({ point: w.axis!.point_mm, dir: w.axis!.dir, radius: w.radius_mm!, label: w.label ?? '' }));
}

/** How far `p` is from the line through `a` along `d`. */
function offAxis(p: number[], a: number[], d: number[]): number {
  const n = Math.hypot(d[0], d[1], d[2]);
  const u = d.map((v) => v / n);
  const w = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
  const t = w[0] * u[0] + w[1] * u[1] + w[2] * u[2];
  return Math.hypot(w[0] - t * u[0], w[1] - t * u[1], w[2] - t * u[2]);
}

describe('hole', () => {
  it('negates an expression as plainly as it reads', () => {
    expect(negated('12 mm')).toBe('-12 mm');
    expect(negated('-12 mm')).toBe('12 mm');
    expect(negated('+2.5 in')).toBe('-2.5 in');
    expect(negated('0 mm')).toBe('0 mm');
    expect(negated('b/2')).toBe('-(b/2)');
    expect(negated('-(b/2)')).toBe('b/2');
    expect(negated('-(a) + (b)')).toBe('-(-(a) + (b))');
    expect(negated('-w/2')).toBe('-(-w/2)');
  });

  it(
    'on each of the six axis faces, the centres land where asked, the positions signed as the face frame runs',
    async () => {
      h = await assistantHarness({ sketchMode: true });
      await block(h);
      await ok(h, 'set_params', { set: [P('b', '14 mm'), P('t', '10 mm')], remove: [] });
      // Each face: the selector, the centre as sent, where it is in the model, the h1x / h1y the sketch keeps.
      const faces: { face: string; c: { x: string; y: string; z: string }; at: number[]; n: number[]; hx: string; hy: string }[] = [
        { face: 'Base.end', c: CTR('12 mm', '-7 mm', ''), at: [12, -7, 10], n: [0, 0, 1], hx: '12 mm', hy: '-7 mm' },
        { face: 'Base.start', c: CTR('-9 mm', '6 mm', ''), at: [-9, 6, 0], n: [0, 0, -1], hx: '-9 mm', hy: '-6 mm' },
        { face: 'Base.side(r.top)', c: CTR('14 mm', '', 't/2 - 1 mm'), at: [14, 20, 4], n: [0, 1, 0], hx: '14 mm', hy: '-(t/2 - 1 mm)' },
        { face: 'Base.side(r.bottom)', c: CTR('-11 mm', '', '6 mm'), at: [-11, -20, 6], n: [0, -1, 0], hx: '-11 mm', hy: '6 mm' },
        // The coordinate along the normal may be given as the face lies.
        { face: 'Base.side(r.right)', c: CTR('30 mm', '8 mm', '3 mm'), at: [30, 8, 3], n: [1, 0, 0], hx: '8 mm', hy: '3 mm' },
        { face: 'Base.side(r.left)', c: CTR('', '-6 mm', 'b/2'), at: [-30, -6, 7], n: [-1, 0, 0], hx: '-6 mm', hy: '-(b/2)' },
      ];
      for (const [i, f] of faces.entries()) {
        const name = `Hole ${i + 1}`;
        const r = await ok(h, 'hole', HOLE({ face: f.face, centers: [f.c], diameter: '3 mm', depth: 'blind', distance: '2 mm' }));
        expect(r.data, f.face).toMatchObject({ feature: { name, type: 'extrude', state: 'ok' }, made: [`${name} sketch`, name], centers_mm: [f.at], diameter_mm: 3, depth_mm: 2, broke: [] });
        expect(dims(h, `${name} sketch`), f.face).toEqual({ d: '3 mm', h1x: f.hx, h1y: f.hy });
        expect(featureNamed<SketchFeature>(h, `${name} sketch`).solved, f.face).toMatchObject({ state: 'fully', dof: 0 });
        // The hole's round face: its axis through the centre asked, along the face's normal, radius 1.5.
        const [cyl] = await cylinders(h, `${name}.side(h1)`);
        expect(cyl, f.face).toMatchObject({ radius: 1.5 });
        expect(offAxis(f.at, cyl.point, cyl.dir), `${f.face} axis`).toBeLessThan(1e-6);
        expect(Math.abs(cyl.dir[0] * f.n[0] + cyl.dir[1] * f.n[1] + cyl.dir[2] * f.n[2]), `${f.face} direction`).toBeCloseTo(1, 9);
      }
      // Six blind holes, each pi * 1.5^2 * 2 into the block, one body.
      expect(volume(h)).toBeCloseTo(BLOCK - 6 * PI * 2.25 * 2, 4);
      expect(h.doc.state.get().rebuild.bodies).toHaveLength(1);
    },
    HOLE_MS,
  );

  it(
    'cuts through or blind, follows its parameters, d changes every hole; one undo entry; get_model shows a sketch and an extrude made by hole',
    async () => {
      h = await assistantHarness({ sketchMode: true });
      await block(h);
      h.fake.emitTurn({ id: 't-test', title: 'A plate with holes' });
      const before = undoLabel(h);
      await ok(h, 'set_params', { set: [P('hd', '5 mm'), P('e', '10 mm'), P('w', '60 mm'), P('dd', '40 mm')], remove: [] });
      // Four through holes, e from the long edges and 20 mm from the short ones (the guide's plate).
      const corners = [CTR('w/2 - e', 'dd/2 - e', ''), CTR('-(w/2 - e)', 'dd/2 - e', ''), CTR('-(w/2 - e)', '-(dd/2 - e)', ''), CTR('w/2 - e', '-(dd/2 - e)', '')];
      const r = await ok(h, 'hole', HOLE({ centers: corners, diameter: 'hd' }));
      expect(r.text).toBe('Hole 1 ok: 4 holes 5 mm across, through, in Base.end · Body 1 24000 → 23215 mm³');
      expect(r.data).toMatchObject({
        step: 3,
        feature: { name: 'Hole 1', type: 'extrude', state: 'ok', message: null },
        resolved: { face: 'Base.end (faces +Z)', frame: 'u runs +X, v runs +Y, origin (0, 0, 10)', diameter: 'hd (5 mm)', depth: 'through Body 1', op: 'cut Body 1' },
        made: ['Hole 1 sketch', 'Hole 1'],
        centers_mm: [
          [20, 10, 10],
          [-20, 10, 10],
          [-20, -10, 10],
          [20, -10, 10],
        ],
        diameter_mm: 5,
        depth_mm: null,
        dimensions: { d: 'hd', h1x: 'w/2 - e', h1y: 'dd/2 - e', h2x: '-(w/2 - e)', h2y: 'dd/2 - e', h3x: '-(w/2 - e)', h3y: '-(dd/2 - e)', h4x: 'w/2 - e', h4y: '-(dd/2 - e)' },
        bodies: { created: [], changed: [{ body: 'Body 1', volume_mm3: [24000, expect.closeTo(BLOCK - 4 * PI * 6.25 * 10, 1)] }], removed: [] },
        broke: [],
        warnings: [],
      });
      expect(r.data.created).toEqual(expect.arrayContaining(['Hole 1.side(h1)', 'Hole 1.side(h2)', 'Hole 1.side(h3)', 'Hole 1.side(h4)']));
      expect(volume(h)).toBeCloseTo(BLOCK - 4 * PI * 6.25 * 10, 4);
      const hole = featureNamed<ExtrudeFeature>(h, 'Hole 1');
      expect(hole).toMatchObject({ op: 'cut', flip: true, scope: [h.doc.state.get().rebuild.bodies[0].id], extent: { kind: 'through_all', both: false } });
      expect(hole.profiles).toHaveLength(4);
      expect(featureNamed<SketchFeature>(h, 'Hole 1 sketch')).toMatchObject({ support: { kind: 'face' }, solved: { state: 'fully', dof: 0 } });
      // One step: the two features, no session or panel left open, one undo entry for the request.
      expect(partNow(h)).toEqual({ features: ['Base sketch', 'Base', 'Hole 1 sketch', 'Hole 1'], undo: 'Assistant: A plate with holes', session: false, panel: false, mode: 'model' });
      const rt = runtimeOf(h.services)!;
      expect(rt.madeBy.has(hole.id) && rt.madeBy.has(featureNamed(h, 'Hole 1 sketch').id)).toBe(true);

      // The parameters drive the holes; edit_feature on the sketch's d changes every one.
      await ok(h, 'set_params', { set: [P('hd', '6 mm')], remove: [] });
      expect(volume(h)).toBeCloseTo(BLOCK - 4 * PI * 9 * 10, 4);
      await ok(h, 'edit_feature', EDIT('Hole 1 sketch', { set: [{ field: 'd', value: '8 mm' }] }));
      expect(volume(h)).toBeCloseTo(BLOCK - 4 * PI * 16 * 10, 4);
      expect((await cylinders(h, 'Hole 1.side')).map((c) => c.radius)).toEqual([4, 4, 4, 4]);
      // A position by its dimension: h1 moves 2 mm along x.
      await ok(h, 'edit_feature', EDIT('Hole 1 sketch', { set: [{ field: 'h1x', value: 'w/2 - e - 2 mm' }] }));
      const moved = (await cylinders(h, 'Hole 1.side(h1)'))[0];
      expect(offAxis([18, 10, 10], moved.point, moved.dir)).toBeLessThan(1e-6);

      // Two blind holes from the bottom face, 3 mm deep: the -Z face's v runs -Y. A bare number takes the Part's unit.
      const blind = await ok(h, 'hole', HOLE({ name: 'Pins', face: 'Base.start', centers: [CTR('0 mm', '10 mm', ''), CTR('0 mm', '-10 mm', '')], diameter: '4 mm', depth: 'blind', distance: '3' }));
      expect(blind.data).toMatchObject({
        feature: { name: 'Pins' },
        made: ['Pins sketch', 'Pins'],
        centers_mm: [
          [0, 10, 0],
          [0, -10, 0],
        ],
        depth_mm: 3,
        dimensions: { d: '4 mm', h1x: '0 mm', h1y: '-10 mm', h2x: '0 mm', h2y: '10 mm' },
        resolved: { depth: 'blind 3 into Body 1' },
      });
      expect(featureNamed<ExtrudeFeature>(h, 'Pins').extent).toEqual({ kind: 'blind', distance: '3 mm' });
      expect(volume(h)).toBeCloseTo(BLOCK - 4 * PI * 16 * 10 - 2 * PI * 4 * 3, 4);

      // get_model full: a sketch and an extrude, each made_by hole, in their own tools' inputs.
      const sketch = (await ok(h, 'get_model', { detail: 'full', feature: 'Hole 1 sketch' })).data.feature as Row;
      expect(sketch).toMatchObject({ name: 'Hole 1 sketch', type: 'sketch', by: 'assistant', made_by: 'hole', inputs: { edit: 'Hole 1 sketch', on: 'Base.end' } });
      expect((sketch.inputs as { entities: Row[] }).entities.map((e) => e.id)).toEqual(['h1', 'h2', 'h3', 'h4']);
      const full = (await ok(h, 'get_model', { detail: 'full', feature: 'Hole 1' })).data.feature as Row;
      expect(full).toMatchObject({ name: 'Hole 1', type: 'extrude', by: 'assistant', made_by: 'hole', inputs: EXTRUDE({ edit: 'Hole 1', sketch: 'Hole 1 sketch', regions: expect.any(Array), extent: 'through', flip: true, op: 'cut', bodies: ['Body 1'] }) });
      // The extrude resent as get_model gives it stays as it was (each region's inside point is its
      // own now: the holes grew and moved since they were made).
      const kept = () => {
        const { id: _i, profiles, ...rest } = featureNamed<ExtrudeFeature>(h!, 'Hole 1');
        return { ...rest, profiles: profiles.map(({ sample: _s, ...p }) => p) };
      };
      const was = kept();
      await ok(h, 'extrude', full.inputs as Row);
      expect(kept()).toEqual(was);
      expect(volume(h)).toBeCloseTo(BLOCK - 4 * PI * 16 * 10 - 2 * PI * 4 * 3, 4);
      // The person's own features have no made_by.
      expect((await ok(h, 'get_model', { detail: 'full', feature: 'Base' })).data.feature).not.toHaveProperty('made_by');

      // The request's one undo entry: the Part as before it.
      h.fake.emitTurn({ id: 't-test', title: 'A plate with holes', state: 'ended', end: { state: 'done', reason: 'done' } });
      h.doc.undo();
      expect(names(h)).toEqual(['Base sketch', 'Base']);
      await h.settle();
      expect(volume(h)).toBeCloseTo(BLOCK, 6);
      expect(undoLabel(h)).toBe(before);
    },
    HOLE_MS,
  );

  it(
    'refuses bad inputs before anything changes: fields, curved and tilted faces, coordinates, expressions, centres off the face',
    async () => {
      h = await assistantHarness({ sketchMode: true });
      await block(h);
      await ok(h, 'hole', HOLE({ centers: [CTR('0 mm', '0 mm', '')], diameter: '6 mm' }));
      // A wedge beside the block: its sloped face is tilted (its normal is not along an axis).
      await ok(h, 'sketch', SK({ name: 'Wedge sketch', on: 'Front', entities: [E('p', 'polyline', [40, 0, 60, 0, 40, 10, 40, 0])] }));
      await ok(h, 'extrude', EXTRUDE({ name: 'Wedge', sketch: 'Wedge sketch', extent: 'symmetric', distance: '10 mm' }));
      const doc = h.doc.state.get().doc;
      const label = undoLabel(h);

      const fields = await fail(h, 'hole', HOLE({ face: '', centers: [], diameter: '', depth: 'through', distance: '3 mm' }));
      expect(fields).toMatchObject({ code: 'invalid_input', detail: { reason: 'bad_input' } });
      expect(fields.message).toBe(
        'bad_input: face: one flat face facing along X, Y or Z ("Plate.end", "Body 1 faces >Z"); centers: at least one centre (or points: a sketch whose points are the centres); diameter: an expression such as "5 mm" or "hd" (or size and fit); distance: "" with depth through (the holes go through the face\'s body).',
      );
      expect((await fail(h, 'hole', HOLE({ centers: [CTR('0 mm', '0 mm', '')], depth: 'blind' }))).message).toBe('bad_input: distance: the depth, such as "6 mm" or "t".');
      // A round face, and a tilted one.
      expect(await fail(h, 'hole', HOLE({ face: 'Hole 1.side(h1)', centers: [CTR('0 mm', '3 mm', '5 mm')] }))).toMatchObject({ message: 'not_flat: face: Hole 1.side(h1) is round: hole drills into one flat face.', detail: { reason: 'not_flat', field: 'face' } });
      const tilted = await fail(h, 'hole', HOLE({ face: 'Wedge.side(p.2)', centers: [CTR('50 mm', '0 mm', '')] }));
      expect(tilted).toMatchObject({ code: 'invalid_input', detail: { reason: 'bad_input', field: 'face' }, hint: 'Sketch the circles on that face (sketch on it), then extrude them with op cut and flip true.' });
      expect(tilted.message).toMatch(/^bad_input: face: Wedge\.side\(p\.2\) faces \([-\d.]+, 0, [-\d.]+\); hole needs a face facing along X, Y or Z: use sketch on it and extrude cut\.$/);
      // Missing coordinates (a +Z face needs x and y), then every expression problem at once.
      const missing = await fail(h, 'hole', HOLE({ centers: [CTR('1 mm', '', ''), CTR('', '2 mm', '10 mm')] }));
      expect(missing).toMatchObject({ detail: { reason: 'bad_input', field: 'centers[0].y' } });
      expect(missing.message).toBe('bad_input: centers[0].y: the centre\'s Y is needed (Base.end faces +Z: give x and y, z ""); centers[1].x: the centre\'s X is needed (Base.end faces +Z: give x and y, z "").');
      const exprs = await fail(h, 'hole', HOLE({ centers: [CTR('zz', '1 mm', '')], diameter: 'qq', depth: 'blind', distance: '2 mm' }));
      expect(exprs).toMatchObject({ code: 'invalid_input', detail: { reason: 'expr_error', field: 'diameter', problems: [expect.stringMatching(/^diameter: /), expect.stringMatching(/^centers\[0\]\.x: /)] } });
      // Where the centres are: off the face's plane, outside the face, twice the same.
      const where = await fail(h, 'hole', HOLE({ centers: [CTR('5 mm', '5 mm', '4 mm'), CTR('60 mm', '12 mm', ''), CTR('10 mm', '0 mm', ''), CTR('10.01 mm', '0 mm', '')] }));
      expect(where).toMatchObject({ code: 'invalid_input', detail: { reason: 'bad_input', field: 'centers[0].z', face: 'Base.end' } });
      expect(where.message).toBe(
        'bad_input: centers[0].z: 4 mm is not on Base.end, which lies at z = 10 mm: send "" for z; centers[1] (60, 12, 10) is 30 mm outside Base.end (a hole 5 mm across needs its centre within 2.5 mm of the face); centers[3] is the same centre as centers[2] (10, 0, 10).',
      );
      // A centre inside the first hole (which is 6 mm across, this one 4 mm) is off the face too.
      expect((await fail(h, 'hole', HOLE({ centers: [CTR('0 mm', '0 mm', '')], diameter: '4 mm' }))).message).toMatch(/^bad_input: centers\[0\] \(0, 0, 10\) is 3 mm outside Base\.end /);
      expect((await fail(h, 'hole', HOLE({ centers: [CTR('5 mm', '5 mm', '')], diameter: '0 mm' }))).message).toBe('bad_input: diameter: more than 0 (it is 0 mm).');
      // Names: taken by a feature, or the sketch's name taken.
      expect(await fail(h, 'hole', HOLE({ name: 'Base', centers: [CTR('5 mm', '5 mm', '')] }))).toMatchObject({ message: 'name_taken: name: another feature is already called Base.', detail: { reason: 'name_taken', field: 'name' } });
      expect((await fail(h, 'hole', HOLE({ name: 'wedge', centers: [CTR('5 mm', '5 mm', '')] }))).detail).toMatchObject({ reason: 'name_taken' });
      // The face as one face: a selector naming several lists candidates.
      expect((await fail(h, 'hole', HOLE({ face: 'Base faces |Z', centers: [CTR('5 mm', '5 mm', '')] }))).detail).toMatchObject({ reason: 'selector_ambiguous', field: 'face' });
      // The diameter sent to the cut: it is a dimension of the hole's sketch, and the answer says which.
      const onCut = await fail(h, 'edit_feature', EDIT('Hole 1', { set: [{ field: 'd', value: '8 mm' }] }));
      expect(onCut).toMatchObject({ code: 'invalid_input', detail: { reason: 'bad_input', sketch: 'Hole 1 sketch' }, hint: 'Call edit_feature with feature "Hole 1 sketch" and the same set rows.' });
      expect(onCut.message).toBe("bad_input: set[0].field: d is a dimension of Hole 1 sketch, the sketch Hole 1 is made from: edit_feature Hole 1 sketch with it (Hole 1's own fields: flip, op).");
      expect(h.doc.state.get().doc).toBe(doc);
      expect(undoLabel(h)).toBe(label);
      expect(uiFor(h.services).state.get().panel).toBeNull();
      expect(h.doc.session()).toBeNull();
      // The next free names skip a sketch name that is taken.
      await ok(h, 'sketch', SK({ name: 'Hole 2 sketch', entities: [E('c', 'circle', [100, 100, 1])] }));
      const next = await ok(h, 'hole', HOLE({ centers: [CTR('15 mm', '5 mm', '')] }));
      expect(next.data).toMatchObject({ made: ['Hole 3 sketch', 'Hole 3'] });
    },
    HOLE_MS,
  );

  it(
    'a drill point: tip "drill" (118 deg) or the point\'s angle; refused on a through hole; a blind hole deeper than the block goes through, says so and leaves the point out (issue 14)',
    async () => {
      h = await assistantHarness({ sketchMode: true });
      await block(h);
      // The cone below a hole 4 mm across: radius 2, 2 / tan(angle / 2) deep.
      const cone = (deg: number) => (PI * 4 * (2 / Math.tan((deg * PI) / 360))) / 3;
      const a = await ok(h, 'hole', HOLE({ centers: [CTR('10 mm', '0 mm', '')], diameter: '4 mm', depth: 'blind', distance: '3 mm', tip: 'drill' }));
      expect(a.text).toMatch(/^Hole 1 ok: 1 hole 4 mm across, 3 mm deep with a drill point, in Base\.end /);
      expect(a.data).toMatchObject({ made: ['Hole 1 sketch', 'Hole 1', 'Hole 1 tip sketch', 'Hole 1 tip'], tip: { angle_deg: 118, depth_mm: expect.closeTo(2 / Math.tan((59 * PI) / 180), 3) }, warnings: [] });
      expect(featureNamed<ExtrudeFeature>(h, 'Hole 1 tip')).toMatchObject({ extent: { kind: 'blind', distance: '(4 mm) / 2 / tan((118 deg) / 2)' }, taper: '(118 deg) / 2' });
      expect(volume(h)).toBeCloseTo(BLOCK - PI * 4 * 3 - cone(118), 3);
      // The point's own angle in tip.
      const b = await ok(h, 'hole', HOLE({ centers: [CTR('-10 mm', '0 mm', '')], diameter: '4 mm', depth: 'blind', distance: '3 mm', tip: '135 deg' }));
      expect(b.data).toMatchObject({ made: ['Hole 2 sketch', 'Hole 2', 'Hole 2 tip sketch', 'Hole 2 tip'], tip: { angle_deg: 135 } });
      expect(volume(h)).toBeCloseTo(BLOCK - 2 * PI * 4 * 3 - cone(118) - cone(135), 3);
      // Refused before anything changes: a drill point on a through hole, an angle past Extrude's draft limit (twice 89 deg).
      const doc = h.doc.state.get().doc;
      expect((await fail(h, 'hole', HOLE({ centers: [CTR('0 mm', '10 mm', '')], diameter: '4 mm', tip: 'drill' }))).message).toBe('bad_input: tip: a drill point only with depth blind (a through hole has no bottom); send "".');
      expect((await fail(h, 'hole', HOLE({ centers: [CTR('0 mm', '10 mm', '')], diameter: '4 mm', depth: 'blind', distance: '3 mm', tip: '200 deg' }))).message).toBe("bad_input: tip: the drill point's angle more than 0 and at most 178 deg (it is 200 deg).");
      expect(h.doc.state.get().doc).toBe(doc);
      // Issue 14: blind 20 mm into the 10 mm block cuts through. The reply says so, and leaves out the drill point it cannot make.
      const deep = await ok(h, 'hole', HOLE({ centers: [CTR('0 mm', '10 mm', '')], diameter: '4 mm', depth: 'blind', distance: '20 mm', tip: 'drill' }));
      expect(deep.data.made).toEqual(['Hole 3 sketch', 'Hole 3']);
      expect(deep.data.warnings).toEqual(['Hole 3 is 20 mm deep, deeper than Body 1 there, so it goes through (set depth through, or a smaller distance); the drill tip was left out']);
      expect(deep.text).not.toContain('drill point');
      expect(deep.data).not.toHaveProperty('tip');
      expect(volume(h)).toBeCloseTo(BLOCK - 2 * PI * 4 * 3 - cone(118) - cone(135) - PI * 4 * 10, 3);
    },
    HOLE_MS,
  );

  it(
    "a person's panel opened between the sketch and the cut is waited for; the step goes back under it, then makes both as one undo group",
    async () => {
      h = await assistantHarness({ sketchMode: true });
      const b = await block(h);
      const rt = runtimeOf(h.services)!;
      const ui = uiFor(h.services);
      const label = undoLabel(h);
      rt.holds.hold('between-opens');
      const r = h.call('hole', HOLE({ centers: [CTR('10 mm', '5 mm', '')] }));
      await vi.waitFor(() => expect(rt.holds.waiting()).toEqual(['between-opens']), { timeout: 60_000 });
      // The sketch is made; the person opens Base before the cut's panel opens.
      expect(names(h)).toEqual(['Base sketch', 'Base', 'Hole 1 sketch']);
      ui.openEdit(b.extrude);
      const session = h.doc.session()!;
      rt.holds.release('between-opens');
      await vi.waitFor(() => expect(rt.store.get()).toMatchObject({ phase: 'waiting', note: 'close the Base panel' }), { timeout: 60_000 });
      // The step went back under the person's panel: no sketch, the panel open and theirs.
      expect(names(h)).toEqual(['Base sketch', 'Base']);
      expect(h.doc.session()).toBe(session);
      expect(session.open).toBe(true);
      expect(session.owner).toBeUndefined();
      ui.closePanel();
      expect(await r).toMatchObject({ ok: true, result: { data: { made: ['Hole 1 sketch', 'Hole 1'], feature: { name: 'Hole 1', state: 'ok' } } } });
      expect(volume(h)).toBeCloseTo(BLOCK - PI * 6.25 * 10, 4);
      // One undo group for the call: the sketch and the cut go together.
      h.doc.undo();
      expect(names(h)).toEqual(['Base sketch', 'Base']);
      expect(undoLabel(h)).toBe(label);
    },
    HOLE_MS,
  );

  for (const when of ['between-opens', 'keep it?'] as const) {
    it(
      `the person's Ctrl+Z ${when === 'between-opens' ? 'between the sketch and the cut' : 'while Ask each step asks "keep it?"'} takes the whole hole back at once: no sketch left, the history as before`,
      async () => {
        h = await assistantHarness({ sketchMode: true });
        await block(h);
        const offUi = installUi(h.services);
        const rt = runtimeOf(h.services)!;
        h.fake.emitTurn({ id: 't-1', title: 'A hole' });
        const before = h.doc.state.get().doc;
        const hist = h.doc.state.get().history;
        if (when === 'between-opens') rt.holds.hold('between-opens');
        else rt.askEach.force(true);
        const r = h.call('hole', HOLE({ centers: [CTR('10 mm', '5 mm', '')] }), { turn: 't-1' });
        if (when === 'between-opens') await vi.waitFor(() => expect(rt.holds.waiting()).toEqual(['between-opens']), { timeout: 60_000 });
        else await vi.waitFor(() => expect(rt.approvals.pending()).toMatchObject({ part: 'Hole 1' }), { timeout: 60_000 });
        expect(names(h)).toEqual(when === 'between-opens' ? ['Base sketch', 'Base', 'Hole 1 sketch'] : ['Base sketch', 'Base', 'Hole 1 sketch', 'Hole 1']);
        // No panel is open: Undo's hint says it takes the Assistant's step over, not its newest piece.
        expect(uiFor(h.services).state.get().panel).toBeNull();
        expect(h.services.commands.get('edit.undo')!.hint).toBe('Take over from the Assistant: its step is discarded (nothing else is undone)');
        h.doc.undo();
        // At once: every piece of the step gone, the history as before the call.
        expect(h.doc.state.get().doc).toBe(before);
        expect(h.doc.state.get().history).toEqual(hist);
        if (when === 'between-opens') rt.holds.release('between-opens');
        expect(await r).toMatchObject({ ok: false, error: { code: 'busy', message: 'taken_over: You took over (Undo): Hole 1 was not kept.', detail: { reason: 'taken_over', why: 'undo' } } });
        expect(((await r) as { error: { detail: Record<string, unknown> } }).error.detail.kept).toBeUndefined();
        expect(h.doc.state.get().doc).toBe(before);
        expect(h.doc.state.get().history).toEqual(hist);
        expect(rt.approvals.pending()).toBeNull();
        expect(rt.pause.get()).toMatchObject({ why: 'take_over', turn: 't-1' });
        // Nothing of it was stored, and the next Ctrl+Z is the person's own again.
        await h.doc.flush();
        expect(h.ws.json('studies/st-test/model.json')).toMatchObject({ doc: { features: [{ name: 'Base sketch' }, { name: 'Base' }] } });
        expect(h.services.commands.get('edit.undo')!.hint).toBe(`Undo ${hist.undoLabel}`);
        offUi();
      },
      HOLE_MS,
    );
  }

  it(
    "a hole that breaks the face's edge is made and warned of: off the face within half the diameter, or on it near an edge",
    async () => {
      h = await assistantHarness({ sketchMode: true });
      await block(h);
      const r = await ok(h, 'hole', HOLE({ centers: [CTR('31 mm', '0 mm', ''), CTR('0 mm', '19 mm', ''), CTR('0 mm', '0 mm', '')] }));
      expect(r.data.warnings).toEqual([
        'centers[0] (31, 0, 10) is 1 mm outside Base.end: the hole 5 mm across breaks its edge (a notch)',
        'centers[1] (0, 19, 10) is 1 mm from an edge of Base.end: the hole 5 mm across breaks that edge (a notch)',
      ]);
      expect(r.text).toMatch(/^Hole 1 ok: 3 holes 5 mm across, through, in Base\.end/);
    },
    HOLE_MS,
  );

  it(
    'a value that moves a hole off its body (it still builds, cutting nothing) changes nothing; a structural edit that does warns',
    async () => {
      h = await assistantHarness({ sketchMode: true });
      await block(h);
      await ok(h, 'set_params', { set: [P('hx', '10 mm')], remove: [] });
      await ok(h, 'hole', HOLE({ centers: [CTR('hx', '0 mm', '')] }));
      expect(volume(h)).toBeCloseTo(BLOCK - PI * 6.25 * 10, 4);
      const doc = h.doc.state.get().doc;
      const label = undoLabel(h);
      // set_params moves the hole past the block's +X side: the cut builds and removes nothing.
      const param = await fail(h, 'set_params', { set: [P('hx', '40 mm')], remove: [] });
      expect(param).toMatchObject({ code: 'failed', detail: { reason: 'broke_downstream', broke: [{ feature: 'Hole 1', message: 'Hole 1 cuts nothing away from Body 1' }], sub: 'off_body' }, hint: 'Nothing changed: pick a value that keeps the features in detail.broke working.' });
      expect(param.message).toMatch(/^broke_downstream: Nothing changed: after it Hole 1 cuts nothing away from Body 1\. The profile lies beside Body 1/);
      // The sketch's position dimension, as the hole tool's description sends the model to change it.
      const dim = await fail(h, 'edit_feature', EDIT('Hole 1 sketch', { set: [{ field: 'h1x', value: '40 mm' }] }));
      expect(dim).toMatchObject({ detail: { reason: 'broke_downstream', broke: [{ feature: 'Hole 1' }] } });
      // With a rename in the same call: the value is still judged as a value.
      expect(await fail(h, 'edit_feature', EDIT('Hole 1 sketch', { set: [{ field: 'h1x', value: '40 mm' }], rename_to: 'Moved' }))).toMatchObject({ detail: { reason: 'broke_downstream' } });
      expect(h.doc.state.get().doc).toBe(doc);
      expect(undoLabel(h)).toBe(label);
      await h.settle();
      expect(volume(h)).toBeCloseTo(BLOCK - PI * 6.25 * 10, 4);
      // A tab joined at x 30..50 and a scoped cut into it from above; suppressing the tab (structural)
      // leaves the cut building with nothing to cut: kept, and said.
      await ok(h, 'sketch', SK({ name: 'Tab sketch', entities: [E('t', 'rect', [30, -10, 50, 10])] }));
      await ok(h, 'extrude', EXTRUDE({ name: 'Tab', sketch: 'Tab sketch', distance: '10 mm', op: 'join' }));
      await ok(h, 'sketch', SK({ name: 'Notch sketch', on: 'Top offset 10 mm', entities: [E('c', 'circle', [40, 0, 3])] }));
      await ok(h, 'extrude', EXTRUDE({ name: 'Notch', sketch: 'Notch sketch', extent: 'through', flip: true, op: 'cut', bodies: ['Body 1'] }));
      const kept = await ok(h, 'edit_feature', EDIT('Tab', { suppress: 'suppress' }));
      expect(kept.data.warnings).toContain('Notch cuts nothing away from Body 1');
      expect(names(h)).toContain('Notch');
    },
    HOLE_MS,
  );

  it(
    'a hole in a block Move/copy body moved stays in it when the move is edited and turned: its sketch and cut stay ok, the volume keeps it',
    async () => {
      h = await assistantHarness({ sketchMode: true });
      await block(h);
      await ok(h, 'direct', DIRECT({ kind: 'move_body', bodies: ['Body 1'], move: ['100 mm', '0 mm', '0 mm'] }));
      // On the moved top face, 12 mm along X and -7 mm along Y from the block's middle (100, 0).
      const r = await ok(h, 'hole', HOLE({ centers: [CTR('112 mm', '-7 mm', '')], diameter: '3 mm', depth: 'blind', distance: '2 mm' }));
      expect(r.data).toMatchObject({ feature: { name: 'Hole 1', state: 'ok' }, centers_mm: [[112, -7, 10]] });
      const holed = BLOCK - PI * 2.25 * 2;
      expect(volume(h)).toBeCloseTo(holed, 4);
      // The move edited: 50 mm, turned 90 deg about Z through the block's centre (0, 0, 5) first. The
      // hole goes with it: (12, -7) from the middle turns to (7, 12), then 50 along X.
      await ok(h, 'direct', DIRECT({ edit: 'Body-Move 1', kind: 'move_body', bodies: ['Body 1'], move: ['50 mm', '0 mm', '0 mm'], turn: { angle: '90 deg', axis: 'Z', pivot: [] } }));
      const st = h.doc.state.get();
      for (const name of ['Body-Move 1', 'Hole 1 sketch', 'Hole 1']) expect(st.rebuild.features[featureNamed(h, name).id], name).toMatchObject({ state: 'ok' });
      expect(volume(h)).toBeCloseTo(holed, 4);
      const [cyl] = await cylinders(h, 'Hole 1.side(h1)');
      expect(offAxis([57, 12, 9], cyl.point, cyl.dir)).toBeLessThan(1e-6);
      expect(Math.abs(cyl.dir[2])).toBeCloseTo(1, 9);
    },
    HOLE_MS,
  );
});
