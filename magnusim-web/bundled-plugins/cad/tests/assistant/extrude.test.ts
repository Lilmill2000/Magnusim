// extrude and revolve on the REAL kernel and solver, through the page's tool handler and the
// person's own panels (CAD tools spec §3.2.8, §3.2.9, §4 full, §7.5, §7.7):
//   - extrude a sketch the tool drew: a body named and coloured in the same step, its faces as
//     labels, the extent in words, one undo entry for the request, get_model's by: "assistant";
//     its inputs come back as this tool's input and, resent with edit, replace it as they were;
//     edit_feature sets distance; each region comes back by its point inside it now, so after a
//     parameter shrank the profile, or moved a hole over the point it was picked at, the resend
//     still keeps the same regions; the person's Ctrl+Z while "Ask each step" asks about an
//     extrude that named and coloured its body (three undo entries of the step's) takes all of it
//     back;
//   - a draft angle: refused round a hole in the profile (+ and -, a plate's and a ring's) and with
//     symmetric or two, nothing changed; the plate with its disc drafts whole; a rib's walls that
//     meet before the distance end it there with a warning; distance "" runs until they meet (a
//     pyramid), resent as it is; one that widens with no distance is refused; a 10 mm square 10 mm
//     high at 5 deg is its frustum (835.23 mm3), the angle a parameter and edit_feature set, refused
//     with through and up to;
//   - regions in every form: "all" keeps a plate's hole open (even-odd), "r2", "at(u, v)", another
//     sketch's region refused; join, cut through given bodies, up to a face and a vertex, two sides,
//     symmetric, through both ways;
//   - refused before anything changes (no feature, no panel, no undo entry): every field problem
//     at once, a bad distance named by its field, a missing region (the regions listed), an open
//     profile, a missing sketch, a name or body name taken (a feature's name is fine for a body),
//     an edit of another type, a sketch made after the extrude it edits;
//   - revolve: a full turn, one side, symmetric and two sides by volume, about an origin axis and a
//     sketch's centerline; a profile across the axis fails with CAD's words and changes nothing;
//     its inputs come back; edit_feature sets angle.
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runtimeOf } from '../../src/assistant/runtime';
import type { ExtrudeFeature, RevolveFeature } from '../../src/types/doc';
import { uiFor } from '../../src/ui/controller';
import { EXTRUDE, fail, names, ok, REVOLVE, volume } from './extrude-tools';
import { assistantHarness, REAL_KERNEL_MS, type AssistantHarness } from './harness';
import { undoLabel } from './parts';
import { C, E, featureNamed, partNow, rectInput, SK, type Row } from './sketch-tools';

let h: AssistantHarness | null = null;
afterEach(() => {
  h?.dispose();
  h = null;
});

const EDIT = (feature: string, o: Row = {}) => ({ feature, set: [], rename_to: '', suppress: 'keep', move: '', ...o });

const bodies = (x: AssistantHarness) => x.doc.state.get().rebuild.bodies.map((b) => b.name);
const fullOf = async (x: AssistantHarness, name: string) => (await ok(x, 'get_model', { detail: 'full', feature: name })).data.feature as Row;
/** A feature as stored, without its id and name (what a resend keeps). */
const kept = (f: ExtrudeFeature | RevolveFeature) => {
  const { id: _i, name: _n, ...rest } = f;
  return rest;
};
const PI = Math.PI;

/** A 60 x 40 rectangle on Top with a circle of radius 5 in it at (15, 0): r1 the plate with its hole, r2 the disc. */
const PLATE_WITH_HOLE = SK({
  name: 'Plate sketch',
  entities: [E('r', 'center_rect', [0, 0, 60, 40]), E('c', 'circle', [15, 0, 5])],
  constraints: [C('o', 'coincident', ['r.center', 'origin']), C('w', 'distance', ['r.bottom'], '60 mm'), C('d', 'distance', ['r.left'], '40 mm')],
});

describe('extrude', () => {
  it(
    'makes a named, coloured body from a sketch in one step; its inputs come back and replace it as they were',
    async () => {
      h = await assistantHarness({ sketchMode: true });
      h.fake.emitTurn({ id: 't-test', title: 'A plate' });
      const before = undoLabel(h);
      await ok(h, 'set_params', { set: [{ name: 't', kind: 'length', expr: '6 mm', comment: '', rename_to: '' }], remove: [] });
      await ok(h, 'sketch', rectInput('Plate sketch', 60, 40));
      const r = await ok(h, 'extrude', EXTRUDE({ name: 'Plate', sketch: 'Plate sketch', distance: 't', body_name: 'Plate', color: '#336699' }));
      expect(r.text).toBe('Extrude Plate ok · Plate made (14400 mm³)');
      expect(r.data).toMatchObject({
        step: 3,
        feature: { name: 'Plate', type: 'extrude', state: 'ok', message: null },
        resolved: { sketch: 'Plate sketch', regions: 'all -> r1 (2400 mm²)', extent: 'blind t (6 mm) along +Z', op: 'new body' },
        bodies: { created: [{ body: 'Plate', volume_mm3: 14400, bbox_mm: [[-30, -20, 0], [30, 20, 6]], solids: 1 }], changed: [], removed: [] },
        broke: [],
        warnings: [],
      });
      expect([...(r.data.created as string[])].sort()).toEqual(['Plate.end', 'Plate.side(r.bottom)', 'Plate.side(r.left)', 'Plate.side(r.right)', 'Plate.side(r.top)', 'Plate.start']);
      const plate = featureNamed<ExtrudeFeature>(h, 'Plate');
      expect(plate).toMatchObject({ op: 'new', scope: [], flip: false, extent: { kind: 'blind', distance: 't' } });
      expect(h.doc.state.get().doc.bodies[plate.creates!]).toMatchObject({ name: 'Plate', color: '#336699' });
      expect(runtimeOf(h.services)!.madeBy.has(plate.id)).toBe(true);
      expect(partNow(h)).toEqual({ features: ['Plate sketch', 'Plate'], undo: 'Assistant: A plate', session: false, panel: false, mode: 'model' });
      // get_model full: the extrude as this tool's input, and its value fields.
      const full = await fullOf(h, 'Plate');
      expect(full).toMatchObject({ by: 'assistant', inputs: EXTRUDE({ edit: 'Plate', sketch: 'Plate sketch', regions: [expect.stringMatching(/^at\(-?[\d.]+, -?[\d.]+\)$/)], distance: 't' }), values: [{ field: 'distance', expr: 't' }] });
      // Resent with edit as they are, the extrude stays as it was.
      const was = kept(plate);
      const again = await ok(h, 'extrude', full.inputs as Row);
      expect(again.text).toBe('Extrude Plate ok (replaced)');
      expect(kept(featureNamed<ExtrudeFeature>(h, 'Plate'))).toEqual(was);
      // edit_feature by the tool's field name.
      await ok(h, 'edit_feature', EDIT('Plate', { set: [{ field: 'distance', value: '8 mm' }] }));
      expect(volume(h, 'Plate')).toBeCloseTo(19200, 6);
      // One undo entry for the request: the Part as before it.
      h.fake.emitTurn({ id: 't-test', title: 'A plate', state: 'ended', end: { state: 'done', reason: 'done' } });
      h.doc.undo();
      expect(names(h)).toEqual([]);
      expect(undoLabel(h)).toBe(before);
    },
    REAL_KERNEL_MS,
  );

  it(
    "an open polyline's ends are named as the model names its parts (p.2, not the stored p__2)",
    async () => {
      h = await assistantHarness({ sketchMode: true });
      await ok(h, 'sketch', SK({ name: 'Open L', entities: [E('p', 'polyline', [0, 0, 40, 0, 40, 20])] }));
      const open = await fail(h, 'extrude', EXTRUDE({ sketch: 'Open L', distance: '1 mm' }));
      expect(open).toMatchObject({ detail: { reason: 'open_profile' } });
      const ends = (open.detail.open as { entity: string }[]).map((o) => o.entity).sort();
      expect(ends).toEqual(['p.1', 'p.2']);
      expect(open.message).not.toContain('__');
      expect(open.message).toMatch(/p\.1 at \(0, 0\)/);
    },
    REAL_KERNEL_MS,
  );

  it(
    'a draft angle: never round a hole in the profile, Blind only; walls that meet before the distance end the body and warn; distance "" runs until they meet',
    async () => {
      h = await assistantHarness({ sketchMode: true });
      await ok(h, 'sketch', PLATE_WITH_HOLE);
      // A ring 20 / 10 across, beside the plate.
      await ok(h, 'sketch', SK({ name: 'Ring sketch', entities: [E('a', 'circle', [100, 0, 10]), E('b', 'circle', [100, 0, 5])] }));
      const doc = h.doc.state.get().doc;
      // The plate round its hole (r1 alone): the kernel filled the hole at +5 deg and made no valid
      // solid at -5 deg; the ring trapped it. Refused in words, nothing changes.
      for (const [sketch, regions, taper] of [
        ['Plate sketch', ['r1'], '5 deg'],
        ['Plate sketch', ['r1'], '-5 deg'],
        ['Ring sketch', ['at(107.5, 0)'], '5 deg'],
        ['Ring sketch', ['at(107.5, 0)'], '-5 deg'],
      ] as const) {
        const r = await fail(h, 'extrude', EXTRUDE({ sketch, regions: [...regions], distance: '4 mm', taper }));
        expect(r.message, `${sketch} ${taper}`).toContain(`a draft angle needs a profile with no hole in it, and the profile picked in ${sketch} goes round a region left out: pick that region too, or set the draft angle to 0 and cut the hole after`);
      }
      // Symmetric and two sides (the kernel drafts one prism from the far end): refused.
      for (const extent of ['symmetric', 'two'] as const) {
        const r = await fail(h, 'extrude', EXTRUDE({ sketch: 'Plate sketch', regions: ['r1', 'r2'], extent, distance: '4 mm', distance2: extent === 'two' ? '4 mm' : '', taper: '5 deg' }));
        expect(r.message, extent).toBe('bad_input: taper: A draft angle goes only with Blind (set it to 0).');
      }
      expect(h.doc.state.get().doc).toBe(doc);
      // Its disc picked too, the plate drafts whole: 60 x 40 narrowing by 2 * tan(5 deg) a side each mm, 2 mm up.
      await ok(h, 'extrude', EXTRUDE({ name: 'Plate', sketch: 'Plate sketch', regions: ['r1', 'r2'], distance: '2 mm', taper: '5 deg' }));
      const t = Math.tan((5 * PI) / 180);
      const frustum = (2 / 3) * (60 * 40 + (60 - 4 * t) * (40 - 4 * t) + Math.sqrt(60 * 40 * (60 - 4 * t) * (40 - 4 * t)));
      expect(volume(h)).toBeCloseTo(frustum, 0);
      // A rib 2 mm wide, 20 mm at 5 deg: its walls meet 1 / tan(5 deg) = 11.43 mm up, and it says so.
      await ok(h, 'sketch', SK({ name: 'Rib sketch', entities: [E('r', 'rect', [-1, 40, 1, 80])] }));
      const rib = await ok(h, 'extrude', EXTRUDE({ name: 'Rib', sketch: 'Rib sketch', distance: '20 mm', taper: '5 deg', body_name: 'Rib' }));
      expect(rib.data.warnings).toEqual(["Rib: the draft walls meet 11.43 mm out, before the 20 mm distance: the body ends there (a draft angle of at most 2.862° reaches 20 mm; an empty distance goes until the walls meet)"]);
      expect(h.doc.state.get().rebuild.features[featureNamed(h, 'Rib').id]).toMatchObject({ state: 'warning' });
      // 5 mm stays below where they meet: no word.
      await ok(h, 'edit_feature', EDIT('Rib', { set: [{ field: 'distance', value: '5 mm' }] }));
      expect(h.doc.state.get().rebuild.features[featureNamed(h, 'Rib').id]).toMatchObject({ state: 'ok' });
      // distance "" with a draft that narrows: a 10 mm square at 30 deg runs to a point 5 / tan(30 deg) up.
      await ok(h, 'sketch', SK({ name: 'Square sketch', entities: [E('s', 'rect', [200, 0, 210, 10])] }));
      const sq = await ok(h, 'extrude', EXTRUDE({ name: 'Peak', sketch: 'Square sketch', distance: '', taper: '30 deg', body_name: 'Peak' }));
      expect(sq.data).toMatchObject({ resolved: { extent: 'blind along +Z, until the walls meet', taper: '30 deg' }, warnings: [] });
      expect(featureNamed<ExtrudeFeature>(h, 'Peak').extent).toEqual({ kind: 'blind', distance: '' });
      expect(volume(h, 'Peak')).toBeCloseTo((100 * (5 / Math.tan(PI / 6))) / 3, 3);
      const peak = await fullOf(h, 'Peak');
      expect(peak.inputs).toMatchObject({ extent: 'blind', distance: '', taper: '30 deg' });
      // One that widens never meets: refused.
      const wide = await fail(h, 'extrude', EXTRUDE({ sketch: 'Square sketch', distance: '', taper: '-5 deg' }));
      expect(wide.message).toBe('bad_input: taper: A draft angle that widens never meets: give the distance (until the walls meet needs a draft angle more than 0).');
    },
    REAL_KERNEL_MS,
  );

  it(
    'a draft angle of 5 deg on a 10 mm square 10 mm high is its frustum (835.23 mm3, as worked by hand); a parameter and edit_feature set it; through and up to are refused',
    async () => {
      h = await assistantHarness({ sketchMode: true });
      const P = (name: string, expr: string) => ({ name, kind: 'angle', expr, comment: '', rename_to: '' });
      await ok(h, 'set_params', { set: [P('dr', '5 deg')], remove: [] });
      await ok(h, 'sketch', rectInput('Square sketch', 10, 10));
      // The top is 10 - 2 * 10 tan(angle) across: h / 3 (A + a + sqrt(A a)).
      const frustum = (deg: number) => {
        const top = (10 - 20 * Math.tan((deg * PI) / 180)) ** 2;
        return (10 / 3) * (100 + top + Math.sqrt(100 * top));
      };
      const r = await ok(h, 'extrude', EXTRUDE({ name: 'Boss', sketch: 'Square sketch', distance: '10 mm', taper: 'dr' }));
      expect(r.data).toMatchObject({ resolved: { taper: 'dr (5 deg)' }, warnings: [] });
      expect(featureNamed<ExtrudeFeature>(h, 'Boss').taper).toBe('dr');
      expect(volume(h)).toBeCloseTo(frustum(5), 3);
      expect(volume(h)).toBeCloseTo(835.23, 2);
      // The parameter drives it, and edit_feature sets it.
      await ok(h, 'set_params', { set: [P('dr', '10 deg')], remove: [] });
      expect(volume(h)).toBeCloseTo(frustum(10), 3);
      await ok(h, 'edit_feature', EDIT('Boss', { set: [{ field: 'taper', value: '3 deg' }] }));
      expect(volume(h)).toBeCloseTo(frustum(3), 3);
      // Through all and up to a face take no draft: refused, nothing changed.
      const doc = h.doc.state.get().doc;
      expect((await fail(h, 'extrude', EXTRUDE({ sketch: 'Square sketch', extent: 'through', taper: '5 deg', op: 'cut', bodies: ['Body 1'] }))).message).toBe('bad_input: taper: A draft angle goes only with Blind (set it to 0).');
      expect((await fail(h, 'extrude', EXTRUDE({ sketch: 'Square sketch', extent: 'to', to: 'Boss.end', taper: '5 deg', op: 'join', bodies: ['Body 1'] }))).message).toBe('bad_input: taper: A draft angle goes only with Blind (set it to 0).');
      expect(h.doc.state.get().doc).toBe(doc);
    },
    REAL_KERNEL_MS,
  );

  it(
    'writes each region by its point inside it now: resent after a parameter shrank the profile or moved a hole over its old point, it keeps the same regions',
    async () => {
      h = await assistantHarness({ sketchMode: true });
      const P = (name: string, expr: string) => ({ name, kind: 'length', expr, comment: '', rename_to: '' });
      await ok(h, 'set_params', { set: [P('w', '60 mm'), P('hx', '15 mm')], remove: [] });
      // A w x 40 plate with a 6 mm hole hx from the origin: "all" is the plate with its hole.
      await ok(
        h,
        'sketch',
        SK({
          name: 'Plate sketch',
          entities: [E('r', 'center_rect', [0, 0, 60, 40]), E('c', 'circle', [15, 0, 3])],
          constraints: [
            C('o', 'coincident', ['r.center', 'origin']),
            C('dw', 'distance', ['r.bottom'], 'w'),
            C('dh', 'distance', ['r.left'], '40 mm'),
            C('cx', 'distance_x', ['origin', 'c.center'], 'hx'),
            C('cy', 'distance_y', ['origin', 'c.center'], '0 mm'),
            C('cd', 'diameter', ['c'], '6 mm'),
          ],
        }),
      );
      await ok(h, 'extrude', EXTRUDE({ name: 'Plate', sketch: 'Plate sketch', distance: '6 mm' }));
      const plateWithHole = (w: number) => (w * 40 - PI * 9) * 6;
      expect(volume(h)).toBeCloseTo(plateWithHole(60), 3);
      const was = () => {
        const { id: _i, name: _n, profiles, ...rest } = featureNamed<ExtrudeFeature>(h!, 'Plate');
        return { ...rest, profiles: profiles.map(({ sample: _s, ...p }) => p) };
      };
      const kept = was();
      // The hole moves to x -16 mm, over the point inside the plate the region was picked at.
      await ok(h, 'set_params', { set: [P('hx', '-16 mm')], remove: [] });
      const moved = await fullOf(h, 'Plate');
      const again = await ok(h, 'extrude', moved.inputs as Row);
      expect(again.text).toBe('Extrude Plate ok (replaced)');
      expect(was()).toEqual(kept);
      expect(volume(h)).toBeCloseTo(plateWithHole(60), 3);
      // The plate shrinks to 40 mm wide: its old point is outside it now.
      await ok(h, 'set_params', { set: [P('w', '40 mm'), P('hx', '5 mm')], remove: [] });
      const shrunk = await fullOf(h, 'Plate');
      await ok(h, 'extrude', shrunk.inputs as Row);
      expect(was()).toEqual(kept);
      expect(volume(h)).toBeCloseTo(plateWithHole(40), 3);
    },
    REAL_KERNEL_MS,
  );

  it(
    'takes regions as all (holes stay open), r2 and at(u, v); joins, cuts given bodies and goes up to a face or a vertex',
    async () => {
      h = await assistantHarness({ sketchMode: true });
      await ok(h, 'sketch', PLATE_WITH_HOLE);
      const plate = await ok(h, 'extrude', EXTRUDE({ name: 'Plate', sketch: 'Plate sketch', distance: '6' }));
      // "all": the regions at even depth, the hole left open.
      expect(plate.data.resolved).toMatchObject({ regions: 'all -> r1 (2321.46 mm²)' });
      expect(volume(h)).toBeCloseTo((2400 - 25 * PI) * 6, 3);
      // The bare number is stored with the Part's unit.
      expect(featureNamed<ExtrudeFeature>(h, 'Plate').extent).toEqual({ kind: 'blind', distance: '6 mm' });
      // r2 (the disc) and the same disc by a point in it: one region, joined back into the plate, flush in its hole.
      const plug = await ok(h, 'extrude', EXTRUDE({ name: 'Plug', sketch: 'Plate sketch', regions: ['r2', 'at(15, 1)'], distance: '6 mm', op: 'join' }));
      expect(plug.data).toMatchObject({ resolved: { regions: 'r2, at(15, 1) -> r2 (78.5398 mm²)', op: 'join every body it meets' }, bodies: { changed: [{ body: 'Body 1', solids: [1, 1] }] } });
      expect(volume(h)).toBeCloseTo(2400 * 6, 3);
      // A boss sketched 20 mm above, extruded down to the plate's top face (flip: against the normal), joined.
      await ok(h, 'sketch', SK({ name: 'Boss sketch', on: 'Top offset 20 mm', entities: [E('b', 'circle', [-15, 0, 4])] }));
      const boss = await ok(h, 'extrude', EXTRUDE({ name: 'Boss', sketch: 'Boss sketch', extent: 'to', to: 'Plate.end', flip: true, op: 'join' }));
      // The plate's top face is merged with the plug's now: it reads by the first of its labels, and Plate.end still names it.
      expect(boss.data).toMatchObject({ resolved: { to: expect.stringMatching(/^(Plate|Plug).end$/), extent: expect.stringMatching(/^up to (Plate|Plug).end$/) } });
      expect(volume(h)).toBeCloseTo(2400 * 6 + 16 * PI * 14, 3);
      // A second one up to a vertex of the plate (the plane through it parallel to the sketch), 1 mm further: into the plate.
      await ok(h, 'sketch', SK({ name: 'Peg sketch', on: 'Top offset 20 mm', entities: [E('p', 'circle', [-25, 15, 2])] }));
      const peg = await ok(h, 'extrude', EXTRUDE({ name: 'Peg', sketch: 'Peg sketch', extent: 'to', to: 'Body 1 vertex at (30, 20, 6)', distance: '1 mm', flip: true, op: 'join' }));
      expect(peg.data.resolved).toMatchObject({ extent: expect.stringMatching(/^up to .+, then 1 mm further$/) });
      expect(volume(h)).toBeCloseTo(2400 * 6 + 16 * PI * 14 + 4 * PI * 14, 2);
      // A hole through the given body, from the sketch above, both ways.
      await ok(h, 'sketch', SK({ name: 'Bore sketch', on: 'Top offset 3 mm', entities: [E('q', 'circle', [0, 10, 3])] }));
      const bore = await ok(h, 'extrude', EXTRUDE({ name: 'Bore', sketch: 'Bore sketch', extent: 'through_both', op: 'cut', bodies: ['Body 1'] }));
      expect(bore.data).toMatchObject({ resolved: { extent: 'through every body both ways (±Z)', op: 'cut Body 1' } });
      expect(volume(h)).toBeCloseTo(2400 * 6 + 16 * PI * 14 + 4 * PI * 14 - 9 * PI * 6, 2);
      expect(names(h)).toEqual(['Plate sketch', 'Plate', 'Plug', 'Boss sketch plane', 'Boss sketch', 'Boss', 'Peg sketch', 'Peg', 'Bore sketch plane', 'Bore sketch', 'Bore']);
    },
    REAL_KERNEL_MS,
  );

  it(
    'goes two ways, symmetric, and through one side',
    async () => {
      h = await assistantHarness({ sketchMode: true });
      await ok(h, 'sketch', rectInput('Plate sketch', 60, 40));
      const two = await ok(h, 'extrude', EXTRUDE({ name: 'Two', sketch: 'Plate sketch', extent: 'two', distance: '6 mm', distance2: '2 mm' }));
      expect(two.data).toMatchObject({ resolved: { extent: '6 mm along +Z, 2 mm along -Z' }, bodies: { created: [{ volume_mm3: 19200, bbox_mm: [[-30, -20, -2], [30, 20, 6]] }] } });
      const sym = await ok(h, 'extrude', EXTRUDE({ name: 'Sym', sketch: 'Plate sketch', extent: 'symmetric', distance: '4 mm', body_name: 'Thin' }));
      expect(sym.data).toMatchObject({ resolved: { extent: 'symmetric 4 mm in all, half each side, along ±Z' }, bodies: { created: [{ body: 'Thin', bbox_mm: [[-30, -20, -2], [30, 20, 2]] }] } });
      await ok(h, 'sketch', SK({ name: 'Slot sketch', on: 'Top offset 10 mm', entities: [E('s', 'circle', [0, 0, 2])] }));
      const thru = await ok(h, 'extrude', EXTRUDE({ name: 'Down', sketch: 'Slot sketch', extent: 'through', flip: true, op: 'cut' }));
      expect(thru.data).toMatchObject({ resolved: { extent: 'through every body along -Z', op: 'cut every body it meets' } });
      expect(volume(h)).toBeCloseTo(19200 - 4 * PI * 8, 3);
      expect(volume(h, 'Thin')).toBeCloseTo(9600 - 4 * PI * 4, 3);
      expect(featureNamed<ExtrudeFeature>(h, 'Down').extent).toEqual({ kind: 'through_all', both: false, distance: '10 mm' });
    },
    REAL_KERNEL_MS,
  );

  it(
    'refuses bad inputs before anything changes, every field problem at once',
    async () => {
      h = await assistantHarness({ sketchMode: true });
      await ok(h, 'sketch', rectInput('Plate sketch', 60, 40));
      await ok(h, 'extrude', EXTRUDE({ name: 'Plate', sketch: 'Plate sketch', distance: '6 mm' }));
      // A round post on the plate (its side is a cylinder), and an open sketch.
      await ok(h, 'sketch', SK({ name: 'Post sketch', on: 'Plate.end', entities: [E('c', 'circle', [0, 0, 3])] }));
      await ok(h, 'extrude', EXTRUDE({ name: 'Post', sketch: 'Post sketch', distance: '4 mm', op: 'join' }));
      await ok(h, 'sketch', SK({ name: 'Open sketch', entities: [E('l', 'line', [0, 0, 10, 0])] }));
      const doc = h.doc.state.get().doc;
      const label = undoLabel(h);
      const fields = await fail(h, 'extrude', EXTRUDE({ sketch: 'Plate sketch', extent: 'through', distance: '5 mm', distance2: '1 mm', to: 'Plate.end', bodies: ['Body 1'], body_name: 'X', color: 'blue' }));
      expect(fields).toMatchObject({ code: 'invalid_input', detail: { reason: 'bad_input' } });
      expect(fields.message).toBe(
        'bad_input: distance: "" with through (it goes past every body); distance2: only with extent two; send ""; to: only with extent to; send ""; bodies: [] with op new (a new body acts on no other); color: "blue" is not #rrggbb.',
      );
      const cut = await fail(h, 'extrude', EXTRUDE({ sketch: 'Plate sketch', extent: 'two', distance: '', op: 'cut', body_name: 'X', color: '#ffffff' }));
      expect(cut.message).toBe('bad_input: distance: the length (along the sketch normal), such as "10 mm" or "t"; distance2: the length against the sketch normal; body_name: only op new makes a body to name; send "" with op cut; color: only op new makes a body to colour; send "" with op cut.');
      expect(await fail(h, 'extrude', EXTRUDE({ sketch: 'Plate sketch', distance: 'tt' }))).toMatchObject({ code: 'invalid_input', message: 'expr_error: distance: Distance: Unknown parameter "tt".', detail: { reason: 'expr_error', field: 'distance' } });
      expect(await fail(h, 'extrude', EXTRUDE({ sketch: 'Plate sketch', distance: '0 mm' }))).toMatchObject({ detail: { reason: 'bad_input', field: 'distance' } });
      expect(await fail(h, 'extrude', EXTRUDE({ sketch: 'Plate sketch', regions: ['r5'], distance: '1 mm' }))).toMatchObject({ detail: { reason: 'region_not_found', regions: [{ id: 'r1', area_mm2: 2400 }] } });
      expect(await fail(h, 'extrude', EXTRUDE({ sketch: 'Open sketch', distance: '1 mm' }))).toMatchObject({ detail: { reason: 'open_profile', open: [{ at: [0, 0] }, { at: [10, 0] }] } });
      expect(await fail(h, 'extrude', EXTRUDE({ sketch: 'Plate sketch', regions: ['Open sketch r1'], distance: '1 mm' }))).toMatchObject({ detail: { reason: 'open_profile' } });
      expect(await fail(h, 'extrude', EXTRUDE({ sketch: 'Nope', distance: '1 mm' }))).toMatchObject({ detail: { reason: 'not_found', field: 'sketch', names: ['Plate sketch', 'Post sketch', 'Open sketch'] } });
      expect(await fail(h, 'extrude', EXTRUDE({ sketch: 'Plate', distance: '1 mm' }))).toMatchObject({ message: 'not_found: sketch: Plate is not a sketch. Sketches: Plate sketch, Post sketch, Open sketch.' });
      expect(await fail(h, 'extrude', EXTRUDE({ name: 'Plate sketch', sketch: 'Plate sketch', distance: '1 mm' }))).toMatchObject({ detail: { reason: 'name_taken', field: 'name' } });
      expect(await fail(h, 'extrude', EXTRUDE({ sketch: 'Plate sketch', distance: '1 mm', body_name: 'body 1' }))).toMatchObject({ detail: { reason: 'name_taken', field: 'body_name' } });
      expect(await fail(h, 'extrude', EXTRUDE({ edit: 'Plate sketch', sketch: 'Plate sketch', distance: '1 mm' }))).toMatchObject({ detail: { reason: 'wrong_feature_type', field: 'edit' } });
      expect(await fail(h, 'extrude', EXTRUDE({ edit: 'Plate', sketch: 'Open sketch', distance: '1 mm' }))).toMatchObject({ detail: { reason: 'later_feature', field: 'sketch' } });
      expect(await fail(h, 'extrude', EXTRUDE({ sketch: 'Plate sketch', extent: 'to', to: 'Plate.side(r.top) & Plate.end', distance: '' }))).toMatchObject({ detail: { reason: 'bad_selector', field: 'to' } });
      expect(await fail(h, 'extrude', EXTRUDE({ sketch: 'Plate sketch', extent: 'to', to: 'Post.side(c)', distance: '' }))).toMatchObject({ message: 'not_flat: to: Post.side(c) is round: up to takes a flat face or a vertex.', detail: { reason: 'not_flat', field: 'to' } });
      expect(h.doc.state.get().doc).toBe(doc);
      expect(undoLabel(h)).toBe(label);
      expect(uiFor(h.services).state.get().panel).toBeNull();
      // A body may share a feature's name.
      const same = await ok(h, 'extrude', EXTRUDE({ name: 'Lid', sketch: 'Plate sketch', extent: 'blind', distance: '2 mm', flip: true, body_name: 'Plate' }));
      expect(same.data).toMatchObject({ bodies: { created: [{ body: 'Plate' }] } });
      expect(bodies(h)).toEqual(['Body 1', 'Plate']);
    },
    REAL_KERNEL_MS,
  );
});

describe("the person's Ctrl+Z during an extrude that names its body", () => {
  it(
    'while Ask each step asks "keep it?": the feature, the name and the colour all go at once, the history as before',
    async () => {
      h = await assistantHarness({ sketchMode: true });
      h.fake.emitTurn({ id: 't-test', title: 'A plate' });
      await ok(h, 'sketch', rectInput('Plate sketch', 60, 40));
      const rt = runtimeOf(h.services)!;
      const before = h.doc.state.get().doc;
      const hist = h.doc.state.get().history;
      rt.askEach.force(true);
      const r = h.call('extrude', EXTRUDE({ name: 'Plate', sketch: 'Plate sketch', distance: '6 mm', body_name: 'Slab', color: '#336699' }));
      await vi.waitFor(() => expect(rt.approvals.pending()).toMatchObject({ part: 'Extrude Plate' }), { timeout: 60_000 });
      expect(bodies(h)).toEqual(['Slab']);
      h.doc.undo();
      expect(h.doc.state.get().doc).toBe(before);
      expect(h.doc.state.get().history).toEqual(hist);
      expect(await r).toMatchObject({ ok: false, error: { code: 'busy', message: 'taken_over: You took over (Undo): Extrude Plate was not kept.', detail: { reason: 'taken_over', why: 'undo' } } });
      expect(names(h)).toEqual(['Plate sketch']);
      expect(h.doc.state.get().history).toEqual(hist);
    },
    REAL_KERNEL_MS,
  );
});

describe('revolve', () => {
  // A 30 x 8 rectangle on Front from u 10 to 40 (x), v 0 to 8 (z): about Z, a ring of bore 20, OD 80.
  const RING = (name = 'Ring sketch', more: Row[] = []) =>
    SK({ name, on: 'Front', entities: [E('r', 'rect', [10, 0, 40, 8]), ...more], constraints: [C('o', 'horizontal', ['r.bl', 'origin']), C('b', 'distance_x', ['origin', 'r.bl'], '10 mm'), C('a', 'distance_x', ['origin', 'r.br'], '40 mm'), C('t', 'distance', ['r.left'], '8 mm')] });
  const RING_V = PI * (40 * 40 - 10 * 10) * 8;

  it(
    'turns a profile all round, one way, symmetric and two ways; its inputs come back; edit_feature sets angle',
    async () => {
      h = await assistantHarness({ sketchMode: true });
      h.fake.emitTurn({ id: 't-test', title: 'A ring' });
      await ok(h, 'sketch', RING());
      const full = await ok(h, 'revolve', REVOLVE({ name: 'Ring', sketch: 'Ring sketch', body_name: 'Ring' }));
      expect(full.text).toMatch(/^Revolve Ring ok · Ring made \(37699 mm³\)$/);
      expect(full.data).toMatchObject({ feature: { name: 'Ring', type: 'revolve', state: 'ok' }, resolved: { axis: 'Z axis', extent: 'a full turn', op: 'new body', regions: 'all -> r1 (240 mm²)' } });
      expect(volume(h, 'Ring')).toBeCloseTo(RING_V, 2);
      expect(featureNamed<RevolveFeature>(h, 'Ring')).toMatchObject({ axis: { kind: 'origin', axis: 'origin:z' }, extent: { kind: 'one', angle: '360 deg' } });
      const inputs = (await fullOf(h, 'Ring')).inputs as Row;
      expect(inputs).toEqual(REVOLVE({ edit: 'Ring', sketch: 'Ring sketch', regions: [expect.stringMatching(/^at\(/)], axis: 'Z axis', extent: 'full' }));
      const was = kept(featureNamed<RevolveFeature>(h, 'Ring'));
      await ok(h, 'revolve', inputs);
      expect(kept(featureNamed<RevolveFeature>(h, 'Ring'))).toEqual(was);
      // One way 90 deg, symmetric 90 deg, 30 and 60 deg: each a quarter ring.
      const one = await ok(h, 'revolve', { ...inputs, extent: 'one', angle: '90' });
      expect(one.data.resolved).toMatchObject({ extent: '90 deg' });
      expect(volume(h, 'Ring')).toBeCloseTo(RING_V / 4, 2);
      expect(featureNamed<RevolveFeature>(h, 'Ring').extent).toEqual({ kind: 'one', angle: '90 deg' });
      await ok(h, 'revolve', { ...inputs, extent: 'symmetric', angle: '90 deg' });
      expect(volume(h, 'Ring')).toBeCloseTo(RING_V / 4, 2);
      const two = await ok(h, 'revolve', { ...inputs, extent: 'two', angle: '30 deg', angle2: '60 deg' });
      expect(two.data.resolved).toMatchObject({ extent: '30 deg one way, 60 deg the other' });
      expect(volume(h, 'Ring')).toBeCloseTo(RING_V / 4, 2);
      expect((await fullOf(h, 'Ring')).values).toEqual([
        { field: 'angle', expr: '30 deg' },
        { field: 'angle2', expr: '60 deg' },
      ]);
      await ok(h, 'edit_feature', EDIT('Ring', { set: [{ field: 'angle2', value: '150 deg' }] }));
      expect(volume(h, 'Ring')).toBeCloseTo(RING_V / 2, 2);
      expect(undoLabel(h)).toBe('Assistant: A ring');
    },
    REAL_KERNEL_MS,
  );

  it(
    'turns about a sketch centerline; a profile across the axis fails with CAD\'s words and changes nothing',
    async () => {
      h = await assistantHarness({ sketchMode: true });
      // The same ring about its own centerline on the v axis.
      await ok(h, 'sketch', RING('Ring sketch', [E('ax', 'centerline', [0, -10, 0, 20])]));
      const r = await ok(h, 'revolve', REVOLVE({ sketch: 'Ring sketch', axis: 'Ring sketch.ax', extent: 'one', angle: '180 deg' }));
      expect(r.data).toMatchObject({ feature: { name: 'Revolve 1', state: 'ok' }, resolved: { axis: expect.stringContaining('ax') } });
      expect(featureNamed<RevolveFeature>(h, 'Revolve 1').axis).toMatchObject({ kind: 'sketch-line', entity: 'ax' });
      expect(volume(h)).toBeCloseTo(RING_V / 2, 2);
      // A square across the X axis (the axis runs through it in the sketch's plane): CAD refuses it.
      await ok(h, 'sketch', SK({ name: 'Across', on: 'Front', entities: [E('q', 'rect', [-5, -5, 5, 5])] }));
      const doc = h.doc.state.get().doc;
      const label = undoLabel(h);
      const across = await fail(h, 'revolve', REVOLVE({ sketch: 'Across', axis: 'X axis', extent: 'full' }));
      expect(across).toMatchObject({ code: 'failed', detail: { reason: 'feature_failed', feature: 'Revolve 2', message: expect.stringMatching(/^Revolve 2 failed: /) } });
      expect(h.doc.state.get().doc).toBe(doc);
      expect(undoLabel(h)).toBe(label);
      expect(uiFor(h.services).state.get().panel).toBeNull();
      // Refused before anything changes.
      const bad = await fail(h, 'revolve', REVOLVE({ sketch: 'Across', extent: 'full', angle: '90 deg', angle2: '1 deg', axis: '' }));
      expect(bad.message).toBe('bad_input: axis: the axis to turn about ("Z axis", "Profile.ax", an edge, "axis of <round face>"); angle: "" with extent full (a whole turn); angle2: only with extent two; send "".');
      expect(await fail(h, 'revolve', REVOLVE({ sketch: 'Across', extent: 'one', angle: '400 deg' }))).toMatchObject({ detail: { reason: 'bad_input', field: 'angle' } });
      expect(await fail(h, 'revolve', REVOLVE({ sketch: 'Across', extent: 'two', angle: '10 deg', angle2: 'zz' }))).toMatchObject({ detail: { reason: 'expr_error', field: 'angle2' } });
      expect(await fail(h, 'revolve', REVOLVE({ sketch: 'Across', axis: 'Top' }))).toMatchObject({ detail: { reason: 'bad_selector', field: 'axis' } });
      expect(h.doc.state.get().doc).toBe(doc);
      expect(names(h)).toEqual(['Ring sketch', 'Revolve 1', 'Across']);
    },
    REAL_KERNEL_MS,
  );
});
