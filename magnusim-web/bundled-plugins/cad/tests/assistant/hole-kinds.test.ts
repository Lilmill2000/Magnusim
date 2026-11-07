// hole's sizes, steps, threads and points on the REAL kernel and solver (Magnusim CAD PR 13: the
// contributor's cases, with the volumes worked by hand), through the page's tool handler, on a
// 60 x 40 x 20 block "Base" (x -30..30, y -20..20, z 0..20) unless said:
//   - a clearance hole and its screw head from the tables: M6 normal (6.6 mm) counterbored 11 x
//     6.4 mm (ISO 4762, DIN 974-1), M5 loose (5.8 mm) countersunk 11.2 mm at 90 deg (ISO 10642),
//     through; their features, dimensions, words and the volumes they cut; a counterbore that
//     follows its sketch's dc and its cut's depth;
//   - a tapped hole: M6x1 taps 5 mm and keeps its cosmetic thread on the cut (designation, major,
//     pitch), said in get_model; M8 taps 6.8 mm; #10-32 UNF taps #21 (0.159 in), kept in inches; an
//     inch 1/4 clearance hole (0.281 in); a modelled M6x1 thread 12 mm deep cuts its groove (the
//     bore 235.62 mm3 and about 38 more: 273.9 in all, as the PR measured);
//   - holes at a sketch's points (three, 3 mm across, through): the holes follow a point its
//     parameter moves; a point taken out of the sketch leaves its hole where it was and warns that
//     it is gone from that sketch (not "from the model"); the sketch cannot be deleted while holes
//     follow it;
//   - issue 14 on a 6 mm plate: blind 20 mm says it goes through and leaves out the drill point it
//     asked for (the reply claims none); with a foot under half the plate, "2 of the 4 holes";
//   - refused before anything changes, in words: sizes the tables do not have (M7, M8x1, 1/4-21), a
//     screw head the tables do not have (M2, an inch size), a table countersink at 82 deg, a table
//     counterbore on a tapped hole, a modelled thread on a clearance hole, counterbores that would
//     overlap, a counterbore as wide as the hole or as deep as a blind one, a 179 deg countersink and
//     one whose cone is deeper than its blind hole, points with centers, a sketch's point off the face.
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import holeModule from '../../src/features/hole';
import { createModuleRegistry, registerModuleFeatures } from '../../src/modules';
import type { ExtrudeFeature, SketchDimension, SketchFeature } from '../../src/types/doc';
import { uiFor } from '../../src/ui/controller';
import { EXTRUDE, fail, names, ok, volume } from './extrude-tools';
import { assistantHarness, type AssistantHarness } from './harness';
import { undoLabel } from './parts';
import { block, C, E, featureNamed, SK, type Row } from './sketch-tools';

let h: AssistantHarness | null = null;
afterEach(() => {
  h?.dispose();
  h = null;
});

const MS = 240_000;
const PI = Math.PI;
const BLOCK = 60 * 40 * 20;

const HOLE = (o: Row = {}): Row => ({ name: '', face: 'Base.end', centers: [], points: '', diameter: '', size: '', fit: '', depth: 'through', distance: '', type: 'simple', cb_diameter: '', cb_depth: '', cs_diameter: '', cs_angle: '', tip: '', thread: 'cosmetic', ...o });
const CTR = (x: string, y: string) => ({ x, y, z: '' });
const P = (name: string, expr: string) => ({ name, kind: 'length', expr, comment: '', rename_to: '' });
const EDIT = (feature: string, o: Row = {}) => ({ feature, set: [], rename_to: '', suppress: 'keep', move: '', ...o });

/** A sketch's dimension expressions by id. */
function dims(x: AssistantHarness, sketch: string): Record<string, string> {
  return Object.fromEntries(featureNamed<SketchFeature>(x, sketch).constraints.filter((c): c is SketchDimension => 'expr' in c).map((c) => [c.id, c.expr]));
}

/** The material a call took away from Body 1 (mm3). */
async function cut(x: AssistantHarness, input: Row): Promise<{ r: { text: string; data: Row }; removed: number }> {
  const before = volume(x)!;
  const r = await ok(x, 'hole', input);
  return { r, removed: before - volume(x)! };
}

/** The axis point of a hole's round face (find's row), as [x, y]. */
async function axisAt(x: AssistantHarness, query: string): Promise<number[]> {
  const rows = (await ok(x, 'find', { query, limit: 10 })).data.rows as { type?: string; axis?: { point_mm: number[] } }[];
  const cyl = rows.find((w) => w.type === 'cylinder');
  if (!cyl) throw new Error(`no round face for ${query}`);
  return cyl.axis!.point_mm.slice(0, 2);
}

/** The hole module's thread feature and its panel, as the app installs them (a modelled thread). */
function withThreads(x: AssistantHarness) {
  registerModuleFeatures(x.doc.features, [holeModule]);
  x.services.modules = createModuleRegistry([...x.services.modules.all(), holeModule]);
}

describe('hole sizes, screw heads, threads and points', () => {
  it(
    'a clearance hole and its screw head from the tables: M6 normal counterbored 11 x 6.4, M5 loose countersunk 11.2 at 90 deg, through',
    async () => {
      h = await assistantHarness({ sketchMode: true });
      await block(h, { t: 20 });
      // M6 normal: 6.6 mm (ISO 273); its socket head's counterbore 11 x 6.4 (the step), then the hole below it.
      const bored = await cut(h, HOLE({ centers: [CTR('-15 mm', '0 mm')], size: 'M6', fit: 'normal', type: 'counterbore' }));
      expect(bored.r.text).toMatch(/^Hole 1 ok: 1 counterbored hole 6\.6 mm across, through, in Base\.end /);
      expect(bored.r.data).toMatchObject({
        made: ['Hole 1 sketch', 'Hole 1 counterbore', 'Hole 1'],
        diameter_mm: 6.6,
        counterbore: { diameter_mm: 11, depth_mm: 6.4 },
        size: 'M6 clearance, normal fit (ISO 273): 6.6 mm',
        resolved: { counterbore: '11 mm across, 6.4 mm deep for an M6 socket head cap screw (ISO 4762, DIN 974-1)' },
        warnings: [],
      });
      expect(dims(h, 'Hole 1 sketch')).toEqual({ d: '6.6 mm', h1x: '-15 mm', h1y: '0 mm', dc: '11 mm' });
      expect(featureNamed<ExtrudeFeature>(h, 'Hole 1 counterbore')).toMatchObject({ op: 'cut', flip: true, extent: { kind: 'blind', distance: '6.4 mm' }, profiles: [expect.anything(), expect.anything()] });
      expect(featureNamed<ExtrudeFeature>(h, 'Hole 1')).toMatchObject({ extent: { kind: 'through_all' }, profiles: [expect.anything()] });
      // pi 5.5^2 6.4 + pi 3.3^2 (20 - 6.4) = 1073.50 (the PR's hand value).
      expect(bored.removed).toBeCloseTo(PI * 30.25 * 6.4 + PI * 10.89 * 13.6, 2);
      expect(bored.removed).toBeCloseTo(1073.5, 1);
      // The counterbore follows its sketch's dc and its own cut's depth.
      await ok(h, 'edit_feature', EDIT('Hole 1 sketch', { set: [{ field: 'dc', value: '12 mm' }] }));
      await ok(h, 'edit_feature', EDIT('Hole 1 counterbore', { set: [{ field: 'distance', value: '8 mm' }] }));
      expect(BLOCK - volume(h)!).toBeCloseTo(PI * 36 * 8 + PI * 10.89 * 12, 2);

      // M5 loose: 5.8 mm; its countersunk head's 11.2 mm at 90 deg, (11.2 - 5.8) / 2 = 2.7 mm deep where it meets the hole.
      const sunk = await cut(h, HOLE({ centers: [CTR('15 mm', '0 mm')], size: 'M5', fit: 'loose', type: 'countersink' }));
      expect(sunk.r.text).toMatch(/^Hole 2 ok: 1 countersunk hole 5\.8 mm across, through, in Base\.end /);
      expect(sunk.r.data).toMatchObject({
        made: ['Hole 2 sketch', 'Hole 2 countersink', 'Hole 2'],
        diameter_mm: 5.8,
        countersink: { diameter_mm: 11.2, depth_mm: 2.7, angle_deg: 90 },
        resolved: { countersink: '11.2 mm across at 90 deg (2.7 mm deep) for an M5 countersunk head screw (ISO 10642)' },
      });
      expect(dims(h, 'Hole 2 sketch')).toMatchObject({ d: '5.8 mm', dc: '11.2 mm' });
      expect(featureNamed<ExtrudeFeature>(h, 'Hole 2 countersink')).toMatchObject({ taper: '(90 deg) / 2', extent: { kind: 'blind', distance: '' } });
      // The cone 5.6 to 2.9 mm in radius over 2.7 mm, and the hole below: 615.45 (the PR's hand value).
      expect(sunk.removed).toBeCloseTo((PI * 2.7 * (5.6 * 5.6 + 5.6 * 2.9 + 2.9 * 2.9)) / 3 + PI * 8.41 * 17.3, 2);
      expect(sunk.removed).toBeCloseTo(615.45, 1);
      expect(h.doc.state.get().rebuild.bodies).toHaveLength(1);
    },
    MS,
  );

  it(
    "a tapped hole keeps its thread on the cut, said in get_model; M8 taps 6.8, #10-32 UNF #21 in inches, 1/4 clears 0.281 in; a modelled M6x1 12 deep cuts its groove (273.9 mm3)",
    async () => {
      h = await assistantHarness({ sketchMode: true });
      withThreads(h);
      await block(h, { t: 20 });
      // M6x1 tapped, through: the 5 mm tap drill, and the thread kept on the hole's cut (the solid is not threaded).
      const tapped = await cut(h, HOLE({ centers: [CTR('-20 mm', '10 mm')], size: 'M6', fit: 'tapped' }));
      expect(tapped.r.text).toMatch(/^Hole 1 ok: 1 M6x1 tapped hole 5 mm across, through, in Base\.end /);
      expect(tapped.r.data).toMatchObject({ made: ['Hole 1 sketch', 'Hole 1'], diameter_mm: 5, thread: 'M6x1', size: 'M6x1 tap drill 5 mm (its thread is drawn and listed, not modelled)', resolved: { thread: "M6x1 cosmetic thread over the hole's depth (drawn and listed, not modelled)" } });
      expect(featureNamed<ExtrudeFeature>(h, 'Hole 1').thread).toEqual({ designation: 'M6x1', major: 6, pitch: 1 });
      expect(tapped.removed).toBeCloseTo(PI * 6.25 * 20, 3);
      const row = ((await ok(h, 'get_model', { detail: 'brief' })).data.features as Row[]).find((f) => f.name === 'Hole 1');
      expect(row).toMatchObject({ thread: 'M6x1 thread, the whole hole (cosmetic: drawn and listed, not modelled)' });
      // M8 tapped 15 deep: ISO 2306's 6.8 mm drill, not 8 - 1.25.
      const m8 = await cut(h, HOLE({ centers: [CTR('-20 mm', '-10 mm')], size: 'M8', fit: 'tapped', depth: 'blind', distance: '15 mm' }));
      expect(m8.r.data).toMatchObject({ diameter_mm: 6.8, thread: 'M8x1.25' });
      expect(m8.removed).toBeCloseTo(PI * 3.4 * 3.4 * 15, 3);
      // #10-32 UNF tapped 10 deep: the #21 drill, 0.159 in, kept in inches in the sketch.
      const unf = await cut(h, HOLE({ centers: [CTR('0 mm', '10 mm')], size: '#10-32', fit: 'tapped', depth: 'blind', distance: '10 mm' }));
      expect(unf.r.data).toMatchObject({ thread: '#10-32 UNF', size: '#10-32 UNF tap drill #21, 0.159 in (its thread is drawn and listed, not modelled)' });
      expect(dims(h, 'Hole 3 sketch').d).toBe('0.159 in');
      expect(unf.removed).toBeCloseTo(PI * (0.159 * 12.7) ** 2 * 10, 2);
      expect(unf.removed).toBeCloseTo(128.1, 1);
      // An inch clearance hole: 1/4 normal is 0.281 in (ASME B18.2.8), through.
      const inch = await cut(h, HOLE({ centers: [CTR('0 mm', '-10 mm')], size: '1/4', fit: 'normal' }));
      expect(inch.r.data).toMatchObject({ size: '1/4 clearance, normal fit (ASME B18.2.8): 0.281 in' });
      expect(dims(h, 'Hole 4 sketch').d).toBe('0.281 in');
      expect(inch.removed).toBeCloseTo(800.2, 1);

      // Modelled: the thread cut into the wall of an M6x1 hole 12 mm deep. The bore is pi 2.5^2 12 = 235.62;
      // the groove takes about 38 more (the PR's 273.90 by its own run, 273.894 through the panel).
      const modelled = await cut(h, HOLE({ centers: [CTR('20 mm', '0 mm')], size: 'M6', fit: 'tapped', depth: 'blind', distance: '12 mm', thread: 'modelled' }));
      expect(modelled.r.text).toMatch(/^Hole 5 ok: 1 M6x1 tapped \(threaded\) hole 5 mm across, 12 mm deep, in Base\.end /);
      expect(modelled.r.data).toMatchObject({ made: ['Hole 5 sketch', 'Hole 5', 'Hole 5 thread'], thread: 'M6x1', resolved: { thread: 'M6x1 thread cut into the wall ("Hole 5 thread", following the hole)' } });
      expect(h.doc.state.get().rebuild.features[featureNamed(h, 'Hole 5 thread').id]).toMatchObject({ state: 'ok' });
      expect(modelled.removed).toBeGreaterThan(PI * 6.25 * 12 + 30);
      expect(modelled.removed).toBeCloseTo(273.9, 0);
      const modelledRow = ((await ok(h, 'get_model', { detail: 'brief' })).data.features as Row[]).find((f) => f.name === 'Hole 5');
      expect(modelledRow).toMatchObject({ thread: 'M6x1 thread, 12 mm deep, cut into the wall (Hole 5 thread)' });
    },
    MS,
  );

  it(
    "holes at a sketch's points follow them: a point moved by its parameter moves its hole; a point taken out leaves its hole and warns; the sketch is kept while they follow it",
    async () => {
      h = await assistantHarness({ sketchMode: true });
      await block(h, { t: 20 });
      await ok(h, 'set_params', { set: [P('px', '0 mm')], remove: [] });
      // Three points on Top (below the block: seen along the top face's normal), the first at (px, 10).
      const layout = (more: Row[] = [E('c', 'point', [15, -10])]) =>
        SK({
          name: 'Layout',
          entities: [E('a', 'point', [0, 10]), E('b', 'point', [-15, -10]), ...more],
          constraints: [C('ax', 'distance_x', ['origin', 'a'], 'px'), C('ay', 'distance_y', ['origin', 'a'], '10 mm'), C('fb', 'fix', ['b']), ...(more.length ? [C('fc', 'fix', ['c'])] : [])],
        });
      await ok(h, 'sketch', layout());
      const holes = await cut(h, HOLE({ points: 'Layout', diameter: '3 mm' }));
      expect(holes.r.data).toMatchObject({
        made: ['Hole 1 sketch', 'Hole 1'],
        centers_mm: [
          [0, 10, 20],
          [-15, -10, 20],
          [15, -10, 20],
        ],
        resolved: { centers: "3 at Layout's points, following them: (0, 10, 20), (-15, -10, 20), (15, -10, 20)" },
      });
      // Three holes 3 mm across through 20 mm: 424.12 (the PR's hand value).
      expect(holes.removed).toBeCloseTo(3 * PI * 2.25 * 20, 3);
      expect(holes.removed).toBeCloseTo(424.12, 1);
      // The holes' sketch holds each centre by a link to Layout's point, not by its own dimensions.
      const sk = featureNamed<SketchFeature>(h, 'Hole 1 sketch');
      expect(sk.links).toMatchObject([{ source: { kind: 'points', feature: featureNamed(h, 'Layout').id } }]);
      expect(Object.keys(dims(h, 'Hole 1 sketch'))).toEqual(['d']);

      // px 0 -> 5 mm: the first hole's wall is centred at x 5 now, the others stay.
      await ok(h, 'set_params', { set: [P('px', '5 mm')], remove: [] });
      expect((await axisAt(h, 'Hole 1.side(h1)')).map((v) => Math.round(v * 1e6) / 1e6)).toEqual([5, 10]);
      expect((await axisAt(h, 'Hole 1.side(h2)')).map((v) => Math.round(v * 1e6) / 1e6)).toEqual([-15, -10]);
      expect(BLOCK - volume(h)!).toBeCloseTo(3 * PI * 2.25 * 20, 3);
      for (const n of ['Layout', 'Hole 1 sketch', 'Hole 1']) expect(h.doc.state.get().rebuild.features[featureNamed(h, n).id], n).toMatchObject({ state: 'ok' });

      // Layout cannot be deleted while the holes follow it: refused, the user named, nothing changed.
      const doc = h.doc.state.get().doc;
      const del = await fail(h, 'delete', { features: ['Layout'] });
      expect(del.message).toContain('Hole 1 sketch');
      expect(h.doc.state.get().doc).toBe(doc);

      // Its third point taken out: that hole stays where it was, and the holes' sketch says which
      // point is gone from Layout (not "from the model": the source is a sketch).
      await ok(h, 'sketch', { ...layout([]), edit: 'Layout' });
      const st = () => h!.doc.state.get().rebuild.features[featureNamed(h!, 'Hole 1 sketch').id];
      expect(st()).toMatchObject({ state: 'warning', message: 'Lost reference: Point 3 no longer in Layout' });
      expect((await axisAt(h, 'Hole 1.side(h3)')).map((v) => Math.round(v * 1e6) / 1e6)).toEqual([15, -10]);
      expect(BLOCK - volume(h)!).toBeCloseTo(3 * PI * 2.25 * 20, 3);
      // Two points gone: counted as points.
      await ok(h, 'sketch', SK({ edit: 'Layout', name: 'Layout', entities: [E('a', 'point', [5, 10])], constraints: [C('ax', 'distance_x', ['origin', 'a'], 'px'), C('ay', 'distance_y', ['origin', 'a'], '10 mm')] }));
      expect(st()).toMatchObject({ state: 'warning', message: 'Lost reference: 2 points no longer in Layout' });
      expect(BLOCK - volume(h)!).toBeCloseTo(3 * PI * 2.25 * 20, 3);
    },
    MS,
  );

  it(
    'issue 14 on a 6 mm plate: blind 20 mm goes through, says so and leaves out its drill point; over a foot, "2 of the 4 holes"',
    async () => {
      h = await assistantHarness({ sketchMode: true });
      await block(h, { t: 6 });
      // The issue: a blind 20 mm hole in a 6 mm plate was reported as "20 mm deep" alone.
      const deep = await cut(h, HOLE({ centers: [CTR('-15 mm', '0 mm')], diameter: '5 mm', depth: 'blind', distance: '20 mm', tip: 'drill' }));
      expect(deep.r.data.warnings).toEqual(['Hole 1 is 20 mm deep, at least as deep as Body 1 there, so it goes through (set depth through, or a smaller distance); the drill tip was left out']);
      // The drill point it could not make: not made, and not claimed.
      expect(deep.r.data.made).toEqual(['Hole 1 sketch', 'Hole 1']);
      expect(deep.r.text).not.toContain('drill point');
      expect(deep.r.data).not.toHaveProperty('tip');
      expect(names(h)).not.toContain('Hole 1 tip');
      expect(deep.removed).toBeCloseTo(PI * 6.25 * 6, 3);
      // A foot 6 mm deep under the plate's +X half: two holes over it keep a bottom, two at -X go through.
      await ok(h, 'sketch', SK({ name: 'Foot sketch', entities: [E('r', 'rect', [0, -20, 30, 20])] }));
      await ok(h, 'extrude', EXTRUDE({ name: 'Foot', sketch: 'Foot sketch', distance: '6 mm', flip: true, op: 'join' }));
      const four = await cut(h, HOLE({ centers: [CTR('10 mm', '10 mm'), CTR('20 mm', '-10 mm'), CTR('-10 mm', '10 mm'), CTR('-20 mm', '-10 mm')], diameter: '4 mm', depth: 'blind', distance: '10 mm' }));
      expect(four.r.data.warnings).toEqual(['2 of the 4 holes of Hole 2 are at least as deep as Body 1 there, so they go through (10 mm deep)']);
      expect(four.removed).toBeCloseTo(2 * PI * 4 * 10 + 2 * PI * 4 * 6, 3);
    },
    MS,
  );

  it(
    'refused before anything changes, in words: sizes and screw heads the tables do not have, steps that do not fit, a modelled thread with no tap, points with centers or off the face',
    async () => {
      h = await assistantHarness({ sketchMode: true });
      await block(h, { t: 20 });
      // A sketch with a point 70 mm outside the top face (a hole there would miss it).
      await ok(h, 'sketch', SK({ name: 'Far', entities: [E('p', 'point', [100, 0])], constraints: [C('f', 'fix', ['p'])] }));
      const doc = h.doc.state.get().doc;
      const label = undoLabel(h);
      const at = [CTR('0 mm', '0 mm')];
      const cases: [Row, string][] = [
        [HOLE({ centers: at, size: 'M7', fit: 'normal' }), 'bad_input: size: "M7" is not a size Hole knows: metric coarse M1.6, M2, M2.5, M3, M4, M5, M6, M8, M10, M12, M14, M16, M20, M24, M30, M36, M42, M48, M56, M60, M64 ("M6", "M6x1"), or Unified inch #0 to 1 in ("1/4-20", "#10-32", "1/4-28 UNF").'],
        [HOLE({ centers: at, size: 'M8x1', fit: 'tapped' }), 'bad_input: size: "M8x1" is not a size Hole knows: metric coarse M1.6, M2, M2.5, M3, M4, M5, M6, M8, M10, M12, M14, M16, M20, M24, M30, M36, M42, M48, M56, M60, M64 ("M6", "M6x1"), or Unified inch #0 to 1 in ("1/4-20", "#10-32", "1/4-28 UNF").'],
        [HOLE({ centers: at, size: '1/4-21', fit: 'tapped' }), 'bad_input: size: "1/4-21" is not a size Hole knows: metric coarse M1.6, M2, M2.5, M3, M4, M5, M6, M8, M10, M12, M14, M16, M20, M24, M30, M36, M42, M48, M56, M60, M64 ("M6", "M6x1"), or Unified inch #0 to 1 in ("1/4-20", "#10-32", "1/4-28 UNF").'],
        [HOLE({ centers: at, size: 'M6' }), 'bad_input: fit: close, normal or loose (a clearance hole for the bolt), or tapped (the tap drill).'],
        [HOLE({ centers: at, size: 'M6', fit: 'normal', diameter: '6 mm' }), 'bad_input: diameter: "" with size (the size gives it).'],
        [HOLE({ centers: at, size: 'M2', fit: 'normal', type: 'counterbore' }), 'bad_input: cb_diameter, cb_depth: the socket head screw table has M3 to M30; give both for M2.'],
        [HOLE({ centers: at, size: '1/4', fit: 'normal', type: 'counterbore' }), 'bad_input: cb_diameter, cb_depth: the socket head screw table has M3 to M30 (metric only); give both for 1/4.'],
        [HOLE({ centers: at, size: 'M6', fit: 'normal', type: 'countersink', cs_angle: '82 deg' }), 'bad_input: cs_diameter: the countersink\'s diameter at the face, wider than the hole (or "" with a clearance size and a 90 deg angle: the screw table\'s).'],
        [HOLE({ centers: at, size: 'M6', fit: 'tapped', type: 'counterbore' }), 'bad_input: cb_diameter: the counterbore\'s diameter, wider than the hole (or "" with a clearance size: the screw table\'s); cb_depth: the counterbore\'s depth (or "" with a clearance size: the screw table\'s).'],
        [HOLE({ centers: at, size: 'M6', fit: 'normal', thread: 'modelled' }), "bad_input: thread: modelled only with fit tapped (a size's tapped hole)."],
        [HOLE({ centers: [CTR('-5 mm', '0 mm'), CTR('5 mm', '0 mm')], diameter: '5 mm', type: 'counterbore', cb_diameter: '11 mm', cb_depth: '4 mm' }), 'bad_input: centers[0] and centers[1] are 10 mm apart: their counterbores 11 mm across would overlap (keep the centres at least 11 mm apart).'],
        [HOLE({ centers: at, diameter: '5 mm', depth: 'blind', distance: '4 mm', type: 'counterbore', cb_diameter: '5 mm', cb_depth: '4 mm' }), "bad_input: cb_diameter: wider than the hole (5 mm, the hole is 5 mm); cb_depth: less than the hole's depth (4 mm, the hole is 4 mm deep)."],
        [HOLE({ centers: at, diameter: '5 mm', type: 'countersink', cs_diameter: '10 mm', cs_angle: '179 deg' }), 'bad_input: cs_angle: more than 0 and at most 178 deg (it is 179 deg).'],
        [HOLE({ centers: at, diameter: '5 mm', depth: 'blind', distance: '5 mm', type: 'countersink', cs_diameter: '20 mm' }), "bad_input: cs_diameter: its cone is 7.5 mm deep, more than the hole's 5 mm."],
        [HOLE({ centers: at, points: 'Far', diameter: '5 mm' }), "bad_input: centers: [] with points (the sketch's points are the centres)."],
        [HOLE({ points: 'Nowhere', diameter: '5 mm' }), 'not_found: points: no sketch is called "Nowhere". Sketches: Base sketch, Far.'],
      ];
      for (const [input, message] of cases) expect((await fail(h, 'hole', input)).message, message).toBe(message);
      // The sketch's point off the face, named as the sketch's.
      const far = await fail(h, 'hole', HOLE({ points: 'Far', diameter: '5 mm' }));
      expect(far.message).toMatch(/^bad_input: points\[0\] \(Far's point 1\) \(100, 0, 20\) is 70 mm outside Base\.end /);
      // Nothing changed: no feature, no undo entry, no panel, no sketch session.
      expect(h.doc.state.get().doc).toBe(doc);
      expect(undoLabel(h)).toBe(label);
      expect(uiFor(h.services).state.get().panel).toBeNull();
      expect(h.doc.session()).toBeNull();
    },
    MS,
  );
});
