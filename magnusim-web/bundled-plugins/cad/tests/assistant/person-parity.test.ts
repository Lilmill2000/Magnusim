// The person's side of what was the Assistant's alone (Daniel's rule both ways), on the REAL kernel
// and solver: each control the person now has stores exactly what the Assistant's tool stores, so a
// thing either made is the other's and editable either way.
//   - Hole (features/hole: planFor + makeHoles, the Hole panel's Done): the same sketch and cut
//     records as the hole tool's, one undo step "<name>", made_by hole; the Assistant then edits
//     the person's hole by its sketch's d;
//   - body colour (UiController.setBodyColor, the tree's swatch and "Colour…"): the same BodyDef;
//   - history order (UiController.moveFeature, a tree drag and Move up / Move down): the same
//     order as edit_feature move, and the same refusal words;
//   - Delete of several features (UiController.deleteFeatures, Delete with several selected): the
//     same Part as the delete tool's, one undo step; refused as a whole while a feature left uses one;
//   - Find (features/find runFind): the find tool's rows for the same query, and Select all the
//     same items as workspace select; for fillets and sized holes (S4) the same rows, count and
//     holes, and the same words for a no-match and a body over the face limit;
//   - Measure (features/measure bodyRows, sectionRows): the measure tool's solids, voids, overlap and
//     section area;
//   - a parameter's comment (the Parameters panel's updateParam) as set_params stores it;
//   - the Back isometric view: the same direction as the pictures' iso_back.
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { findError, runFind } from '../../src/features/find/panel';
import { forgetBreps } from '../../src/features/import/feature';
import { recognitionOf } from '../../src/kernel/recognition';
import { RECOGNIZE_MAX_FACES } from '../../src/kernel/timeouts';
import { makeHoles, planFor } from '../../src/features/hole/make';
import { bodyRows, sectionRows } from '../../src/features/measure/panel';
import { madeWith } from '../../src/assistant/made-with';
import type { CadDoc, Feature } from '../../src/types/doc';
import type { SelectionItem } from '../../src/types/selection';
import { uiFor } from '../../src/ui/controller';
import { VIEW_DIRS } from '../../src/viewport/camera';
import { SNAPSHOT_DIRS } from '../../src/viewport/snapshot';
import { fail, ok } from './extrude-tools';
import { assistantHarness, type AssistantHarness } from './harness';
import { undoLabel } from './parts';
import { importRoundedBlock } from './rounded-block';
import { block, featureNamed, partNow, type Row } from './sketch-tools';

let h: AssistantHarness | null = null;
afterEach(() => {
  h?.dispose();
  h = null;
  forgetBreps();
});

const MS = 240_000;
const P = (name: string, expr: string, comment = '') => ({ name, kind: 'length', expr, comment, rename_to: '' });
const EDIT = (feature: string, o: Row = {}) => ({ feature, set: [], rename_to: '', suppress: 'keep', move: '', ...o });
const BODY = (body: string, o: Row = {}) => ({ body, rename_to: '', color: '', simulation: 'keep', visibility: 'keep', ...o });

/** A feature's record with its ids and the ids it names replaced by what they name (two Parts compared). */
function recordOf(doc: CadDoc, name: string): unknown {
  const f = doc.features.find((g) => g.name === name);
  if (!f) throw new Error(`no feature ${name}`);
  const names = new Map(doc.features.map((g) => [g.id, `<${g.name}>`]));
  return JSON.parse(JSON.stringify(f, (k, v) => (k === 'id' ? undefined : typeof v === 'string' && names.has(v) ? names.get(v) : v)));
}

/** The one face a query names, as the person's pick (the Find panel's row). */
async function faceItem(x: AssistantHarness, query: string): Promise<SelectionItem> {
  const r = await runFind(x.services, query);
  expect(r.count, query).toBe(1);
  const it = r.rows[0].items[0];
  expect(it.kind).toBe('face');
  return it;
}

const docNow = (x: AssistantHarness) => x.doc.state.get().doc;

describe("the person's side of the Assistant's tools stores what the tools store", () => {
  it(
    'Hole: the same sketch and cut as the hole tool, one undo step, made by hole, and the Assistant edits it',
    async () => {
      h = await assistantHarness({ sketchMode: true });
      await block(h);
      const input = { name: '', centers: [{ x: '12 mm', y: '-7 mm', z: '' }, { x: '-15 mm', y: '8 mm', z: '' }], diameter: '5 mm', depth: 'blind' as const, distance: '3 mm' };
      // The Assistant's hole, its records, then taken back with the person's Ctrl+Z (one step).
      await ok(h, 'hole', { ...input, face: 'Base.end' });
      const ai = { sketch: recordOf(docNow(h), 'Hole 1 sketch'), cut: recordOf(docNow(h), 'Hole 1') };
      const volumeAi = h.doc.state.get().rebuild.bodies[0].volume;
      h.doc.undo();
      await h.settle();
      expect(docNow(h).features.map((f) => f.name)).toEqual(['Base sketch', 'Base']);
      // The person's Hole panel's Done: the hole tool's plan on the picked face, then the two features.
      const plan = await planFor(h.services, await faceItem(h, 'Base.end'), input);
      const made = await makeHoles(h.services, plan);
      await h.settle();
      expect(partNow(h)).toMatchObject({ features: ['Base sketch', 'Base', 'Hole 1 sketch', 'Hole 1'], undo: 'Hole 1', session: false, panel: false, mode: 'model' });
      expect(recordOf(docNow(h), 'Hole 1 sketch')).toEqual(ai.sketch);
      expect(recordOf(docNow(h), 'Hole 1')).toEqual(ai.cut);
      expect(h.doc.state.get().rebuild.bodies[0].volume).toBeCloseTo(volumeAi!, 6);
      expect(madeWith(h.services, made.sketch)).toBe('hole');
      expect(madeWith(h.services, made.cut)).toBe('hole');
      // One undo step takes the whole hole back, as the Assistant's.
      h.doc.undo();
      await h.settle();
      expect(docNow(h).features.map((f) => f.name)).toEqual(['Base sketch', 'Base']);
      h.doc.redo();
      await h.settle();
      // The Assistant edits the person's hole as its own: d on the sketch changes both.
      await ok(h, 'edit_feature', EDIT('Hole 1 sketch', { set: [{ field: 'd', value: '6 mm' }] }));
      expect(h.doc.state.get().rebuild.bodies[0].volume).toBeCloseTo(60 * 40 * 10 - 2 * Math.PI * 9 * 3, 4);
      // Refused before anything changes, with the tool's words: a centre off the face.
      const n = docNow(h).features.length;
      await expect(planFor(h.services, await faceItem(h, 'Base.end'), { ...input, centers: [{ x: '90 mm', y: '0 mm', z: '' }] })).rejects.toThrow(/outside Base\.end/);
      expect(docNow(h).features).toHaveLength(n);
    },
    MS,
  );

  it(
    'body colour, history order and a Delete of several: the same records and refusals as body, edit_feature move and delete',
    async () => {
      h = await assistantHarness({ sketchMode: true });
      await block(h);
      const ui = uiFor(h.services);
      const body = h.doc.state.get().rebuild.bodies[0];
      // Colour: the person's swatch, then the Assistant's body color, the same BodyDef.
      expect(ui.setBodyColor(body.id, '#ff8800')).toBeNull();
      const person = docNow(h).bodies[body.id];
      expect(undoLabel(h)).toBe('Colour of Body 1');
      h.doc.undo();
      await ok(h, 'body', BODY('Body 1', { color: '#ff8800' }));
      expect(docNow(h).bodies[body.id]).toEqual(person);

      // Order: a plane made after the extrude, moved before the sketch (the Assistant's move, then the person's).
      await ok(h, 'construct', { edit: '', name: 'Plane 1', method: 'offset', refs: ['Top'], value: '5 mm', xyz: [], flip: false, from_end: false });
      await ok(h, 'edit_feature', EDIT('Plane 1', { move: 'before Base sketch' }));
      const aiOrder = docNow(h).features.map((f) => f.name);
      expect(aiOrder).toEqual(['Plane 1', 'Base sketch', 'Base']);
      const plane = featureNamed<Feature>(h, 'Plane 1');
      expect(ui.moveFeature(plane.id, 2)).toBeNull();
      expect(docNow(h).features.map((f) => f.name)).toEqual(['Base sketch', 'Base', 'Plane 1']);
      expect(ui.moveFeature(plane.id, 0)).toBeNull();
      expect(docNow(h).features.map((f) => f.name)).toEqual(aiOrder);
      expect(undoLabel(h)).toBe('Move Plane 1');
      // The same refusal: the extrude cannot go above its sketch.
      const extrude = featureNamed<Feature>(h, 'Base');
      const why = ui.moveFeature(extrude.id, 0);
      expect(why).toBe('Base uses Base sketch: it cannot move above it');
      const e = await fail(h, 'edit_feature', EDIT('Base', { move: 'before Base sketch' }));
      expect(e.message).toContain(why!);

      // Delete of several: the sketch and its extrude together, one step, as the delete tool does.
      const before = docNow(h);
      const ids = [featureNamed<Feature>(h, 'Base sketch').id, extrude.id];
      ui.deleteFeatures(ids);
      await h.settle();
      const personAfter = docNow(h).features.map((f) => f.name);
      expect(personAfter).toEqual(['Plane 1']);
      expect(undoLabel(h)).toBe('Delete Base sketch and Base');
      h.doc.undo();
      await h.settle();
      expect(docNow(h)).toEqual(before);
      // Refused as a whole while a feature left uses one (Base uses Base sketch): nothing deleted.
      const history = h.doc.state.get().history;
      ui.deleteFeatures([featureNamed<Feature>(h, 'Base sketch').id, featureNamed<Feature>(h, 'Plane 1').id]);
      expect(docNow(h)).toEqual(before);
      // Refused before anything went: the undo and redo lists as they were (no Plane 1 deleted and taken back).
      expect(h.doc.state.get().history).toEqual(history);
      await ok(h, 'delete', { features: ['Base sketch', 'Base'] });
      expect(docNow(h).features.map((f) => f.name)).toEqual(personAfter);
    },
    MS,
  );

  it(
    "Find, Measure and a parameter's comment: the find tool's rows, the measure tool's numbers, set_params' comment",
    async () => {
      h = await assistantHarness({ sketchMode: true });
      await block(h);
      // Find: the same rows as the find tool for the same query (handles of the person's own table).
      const q = 'Body 1 faces >Z';
      const mine = await runFind(h.services, q);
      const tool = await ok(h, 'find', { query: q, limit: 50 });
      expect(mine.count).toBe(tool.data.count);
      const strip = (r: Row) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== 'handle' && k !== 'items'));
      expect(mine.rows.map(strip)).toEqual((tool.data.rows as Row[]).map(strip));
      expect(mine.items).toEqual([{ kind: 'face', body: h.doc.state.get().rebuild.bodies[0].id, index: expect.any(Number) }]);
      const largest = await runFind(h.services, 'Body 1 faces largest');
      expect(largest.count).toBe(2);

      // Measure: a body's solids and voids, and a section's area, as the measure tool reads them.
      const b = h.doc.state.get().rebuild.bodies[0];
      const rows = await bodyRows(h.services, [{ kind: 'body', body: b.id }], h.doc.state.get().rebuild.bodies);
      const m = await ok(h, 'measure', { targets: ['Body 1'], section: '' });
      const value = (k: string) => rows.find((r) => r.key === k)?.value;
      expect(value('solids')).toBe(String(m.data.solids));
      expect(value('voids')).toBe(String(m.data.voids));
      expect(value('shells')).toBe(String(m.data.shells));
      const cut = await sectionRows(h.services, b, 'Top offset 4 mm');
      const ms = await ok(h, 'measure', { targets: ['Body 1'], section: 'Top offset 4 mm' });
      expect((ms.data.section as Row).area_mm2).toBe(2400);
      expect(cut.find((r) => r.key === 'section-area')?.value).toBe('2400 mm²');

      // A parameter's comment, as the Parameters panel keeps it and as set_params stores it.
      await ok(h, 'set_params', { set: [P('w', '60 mm', 'Plate width')], remove: [] });
      const ai = docNow(h).params.find((p) => p.name === 'w')!;
      const r = h.doc.updateParam(ai.id, { comment: '' });
      expect(r.ok).toBe(true);
      expect(docNow(h).params.find((p) => p.name === 'w')!.comment).toBeUndefined();
      expect(h.doc.updateParam(ai.id, { comment: 'Plate width' }).ok).toBe(true);
      expect(docNow(h).params.find((p) => p.name === 'w')).toEqual(ai);
    },
    MS,
  );

  it(
    "Find of fillets and sized holes (S4): the find tool's count, rows and holes; the same words for a no-match and a body over the face limit",
    async () => {
      h = await assistantHarness({ solver: false });
      await importRoundedBlock(h);
      const strip = (r: Row) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== 'handle' && k !== 'items'));
      for (const q of ['Body 1 faces fillet <= 2 mm', 'Body 1 faces fillet', 'Body 1 faces hole <= 6 mm', 'Body 1 faces hole <= 10 mm']) {
        const mine = await runFind(h.services, q);
        const tool = await ok(h, 'find', { query: q, limit: 25 });
        expect(mine.count, q).toBe(tool.data.count);
        expect(mine.holes, q).toBe((tool.data.holes as number | undefined) ?? null);
        expect(mine.rows.map(strip), q).toEqual((tool.data.rows as Row[]).map(strip));
        expect(mine.items.length, q).toBe(tool.data.count);
        // The hint to check the lit faces: for these queries only.
        expect(mine.shape, q).toBe(true);
      }
      expect((await runFind(h.services, 'Body 1 faces >Z')).shape).toBe(false);
      // A no-match: the panel's line is the tool's message.
      const q0 = 'Body 1 faces fillet <= 1 mm';
      const none = await fail(h, 'find', { query: q0, limit: 10 });
      expect(none.message).toContain('matches nothing: Body 1 has 12 fillet faces, R2 to R5.');
      expect((await runFind(h.services, q0)).nothing).toBe(none.message.replace(/^nothing_selected: /, ''));
      // Over the face limit: the same words and the same hint (the panel shows them together).
      recognitionOf(h.services.kernel).limits.maxFaces = 10;
      try {
        const big = await fail(h, 'find', { query: 'Body 1 faces fillet <= 2 mm', limit: 10 });
        const person = await runFind(h.services, 'Body 1 faces fillet <= 2 mm').then(
          () => null,
          (e: unknown) => findError(e),
        );
        expect(person).toBe(`${big.message.replace(/^bad_selector: /, '')} ${big.hint}`);
        expect(person).toBe('Body 1 has 25 faces: fillets and holes are found on bodies of up to 10 faces. Select its faces in the view instead.');
      } finally {
        recognitionOf(h.services.kernel).limits.maxFaces = RECOGNIZE_MAX_FACES;
      }
    },
    MS,
  );

  it('the Back isometric view looks the way the pictures\' iso_back does', () => {
    expect(VIEW_DIRS.iso_back).toEqual(SNAPSHOT_DIRS.iso_back);
    expect(VIEW_DIRS.iso_back.dir.map((v) => Math.sign(v))).toEqual([-1, 1, 1]);
  });
});
