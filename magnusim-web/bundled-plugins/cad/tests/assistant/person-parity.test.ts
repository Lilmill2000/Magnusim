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
//   - the Back isometric view: the same direction as the pictures' iso_back;
//   - Delete faces' Add by size (S5: features/delete_faces/by-size.ts, the panel's Fillets up to and
//     Holes up to): the same face references, in the same order, as direct delete_faces stores for
//     "Body 1 faces fillet <= 2 mm" and "Body 1 faces hole <= 6 mm", only faces not picked yet, and
//     the same refusal words as Find for a body over the face limit.
//     Two face limits (kernel API 9): a fillet search within the fillets' limit works on a body over
//     the holes' limit, a hole search there is refused, and the person and the Assistant get the
//     same words naming both limits (the Assistant both numbers in detail too).
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { addBySize, type AddedBySize } from '../../src/features/delete_faces/by-size';
import { findError, runFind } from '../../src/features/find/panel';
import { forgetBreps } from '../../src/features/import/feature';
import { recognitionOf } from '../../src/kernel/recognition';
import { RECOGNIZE_MAX_FILLET_FACES, RECOGNIZE_MAX_HOLE_FACES } from '../../src/kernel/timeouts';
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
      // Over a face limit: the same words and the same hint (the panel shows them together), naming
      // both limits; the Assistant gets both numbers in detail. A body over the holes' limit only:
      // fillets are still found, for both.
      const limits = recognitionOf(h.services.kernel).limits;
      const overWords = async (q: string) => {
        const big = await fail(h!, 'find', { query: q, limit: 10 });
        const person = await runFind(h!.services, q).then(
          () => null,
          (e: unknown) => findError(e),
        );
        expect(person, q).toBe(`${big.message.replace(/^bad_selector: /, '')} ${big.hint}`);
        return { person, detail: (big as unknown as { detail: unknown }).detail };
      };
      limits.maxHoleFaces = 10;
      try {
        const fillets = await ok(h, 'find', { query: 'Body 1 faces fillet <= 2 mm', limit: 10 });
        expect(fillets.data.count).toBe(8);
        expect((await runFind(h.services, 'Body 1 faces fillet <= 2 mm')).count).toBe(8);
        // A fillet query that matches nothing still says what Body 1 has (its fillets are searched
        // without holes, within their own limit), for both (review 2026-11-02: no test held it).
        const noneOver = await fail(h, 'find', { query: q0, limit: 10 });
        expect(noneOver.message).toBe(`nothing_selected: "${q0}" matches nothing: Body 1 has 12 fillet faces, R2 to R5.`);
        expect((await runFind(h.services, q0)).nothing).toBe(`"${q0}" matches nothing: Body 1 has 12 fillet faces, R2 to R5.`);
        expect(await overWords('Body 1 faces hole <= 6 mm')).toEqual({
          person: 'Body 1 has 25 faces: holes are found on bodies of up to 10 faces and fillets on bodies of up to 5,000 faces. Select its faces in the view instead.',
          detail: { reason: 'bad_selector', body: 'Body 1', why: 'too_large', faces: 25, over: 'holes', limit: 10, limits: { fillets: 5000, holes: 10 } },
        });
        limits.maxFilletFaces = 12;
        expect(await overWords('Body 1 faces fillet <= 2 mm')).toEqual({
          person: 'Body 1 has 25 faces: fillets are found on bodies of up to 12 faces and holes on bodies of up to 10 faces. Select its faces in the view instead.',
          detail: { reason: 'bad_selector', body: 'Body 1', why: 'too_large', faces: 25, over: 'fillets', limit: 12, limits: { fillets: 12, holes: 10 } },
        });
      } finally {
        limits.maxFilletFaces = RECOGNIZE_MAX_FILLET_FACES;
        limits.maxHoleFaces = RECOGNIZE_MAX_HOLE_FACES;
      }
    },
    MS,
  );

  it(
    "Delete faces' Add by size (S5): the references direct delete_faces stores for the same selectors, only faces not picked, and Find's refusal words",
    async () => {
      h = await assistantHarness({ solver: false });
      await importRoundedBlock(h);
      const added = (r: AddedBySize) => {
        if (!r.ok) throw new Error(`Add refused: ${r.words}`);
        return r;
      };
      // The person: MODIFY > Delete faces with nothing picked (the Part's one solid body), Fillets up
      // to 2 mm, Add; Holes up to Ø 6 mm, Add (the panel applies each as clicks would).
      const s = h.doc.beginNew('delete_faces');
      const f1 = added(await addBySize(h.services, { feature: s.feature, body: '', kind: 'fillets', size: 2, picked: [] }));
      expect(f1.query).toBe('Body 1 faces fillet <= 2 mm');
      expect(f1.words).toBe('Added 8 faces: 1 fillet chain, R2');
      expect(f1.added).toHaveLength(8);
      expect(f1.refs).toEqual(f1.added);
      s.update({ body: f1.body, faces: f1.added });
      await h.settle();
      // The Delete faces is in the Part now: Add reads the body as it is just before it.
      expect(docNow(h).features.some((f) => f.id === s.feature)).toBe(true);
      const f2 = added(await addBySize(h.services, { feature: s.feature, body: f1.body, kind: 'holes', size: 6, picked: f1.added }));
      expect(f2.query).toBe('Body 1 faces hole <= 6 mm');
      expect(f2.words).toBe('Added 4 faces: 4 holes up to Ø6 mm (4 through)');
      s.update({ faces: [...f1.added, ...f2.added] });
      await h.settle();
      // Nothing new: what the body has, in words (the faces before this Delete faces).
      const again = await addBySize(h.services, { feature: s.feature, body: f1.body, kind: 'fillets', size: 2, picked: [...f1.added, ...f2.added] });
      expect(again).toEqual({ ok: false, words: 'No fillets up to 2 mm on Body 1 that are not already picked (Body 1 has 12 fillet faces, R2 to R5)' });
      // R5 too, past the picked R2s: only the 4 R5 faces are added.
      const f5 = added(await addBySize(h.services, { feature: s.feature, body: f1.body, kind: 'fillets', size: 5, picked: [...f1.added, ...f2.added] }));
      expect(f5.words).toBe('Added 4 faces: 4 fillet chains, R5');
      expect(f5.refs).toHaveLength(12);
      expect(f5.added.every((r) => !f1.added.some((x) => x.name === r.name))).toBe(true);
      s.update({ faces: [...f1.added, ...f2.added, ...f5.added] });
      await h.settle();
      s.commit();
      await h.settle();
      const person = docNow(h).features.find((f) => f.type === 'delete_faces') as Feature & { faces: { name: string }[]; body: string };
      const personFaces = person.faces;
      const personVolume = h.doc.state.get().rebuild.bodies[0].volume;
      const personState = h.doc.state.get().rebuild.features[person.id]?.state;
      expect(personFaces).toHaveLength(16);
      h.doc.undo();
      await h.settle();
      expect(docNow(h).features.some((f) => f.type === 'delete_faces')).toBe(false);

      // The Assistant: direct delete_faces with the selectors Add runs: the same references, in the same order.
      const DIRECT = { edit: '', name: '', kind: 'delete_faces', distance: '', bodies: [], tool: '', keep_tool: false, move: [], turn: { angle: '', axis: '', pivot: [] }, copy: false };
      await ok(h, 'direct', { ...DIRECT, faces: ['Body 1 faces fillet <= 2 mm', 'Body 1 faces hole <= 6 mm', 'Body 1 faces fillet <= 5 mm'] });
      const ai = docNow(h).features.find((f) => f.type === 'delete_faces') as Feature & { faces: { name: string }[]; body: string };
      expect(ai.body).toBe(person.body);
      expect(ai.faces).toEqual(personFaces);
      expect(h.doc.state.get().rebuild.features[ai.id]?.state).toBe(personState);
      expect(h.doc.state.get().rebuild.bodies[0].volume).toBe(personVolume);
      h.doc.undo();
      await h.settle();

      // Over the holes' face limit: Find's words and hint for holes, both limits named, and nothing
      // added; fillets (within their own limit) are still added.
      const t = h.doc.beginNew('delete_faces');
      const limits = recognitionOf(h.services.kernel).limits;
      limits.maxHoleFaces = 10;
      try {
        const big = await addBySize(h.services, { feature: t.feature, body: '', kind: 'holes', size: 6, picked: [] });
        const find = await runFind(h.services, 'Body 1 faces hole <= 6 mm').then(
          () => null,
          (e: unknown) => findError(e),
        );
        expect(big).toEqual({ ok: false, words: find });
        expect(find).toMatch(/^Body 1 has \d+ faces: holes are found on bodies of up to 10 faces and fillets on bodies of up to 5,000 faces\. Select its faces in the view instead\.$/);
        expect(added(await addBySize(h.services, { feature: t.feature, body: '', kind: 'fillets', size: 2, picked: [] })).words).toBe('Added 8 faces: 1 fillet chain, R2');
      } finally {
        limits.maxHoleFaces = RECOGNIZE_MAX_HOLE_FACES;
      }
      t.discard();
    },
    MS,
  );

  it(
    "Delete faces' Add by size with two solid bodies and none picked: words, never a guess; a body picked, it works on that one",
    async () => {
      h = await assistantHarness({ solver: false });
      await importRoundedBlock(h, { body2: true });
      expect(h.doc.state.get().rebuild.bodies.map((b) => b.name)).toEqual(['Body 1', 'Body 2']);
      const s = h.doc.beginNew('delete_faces');
      expect(await addBySize(h.services, { feature: s.feature, body: '', kind: 'fillets', size: 2, picked: [] })).toEqual({ ok: false, words: 'Click a face of the body first' });
      const [b1, b2] = h.doc.state.get().rebuild.bodies.map((b) => b.id);
      const one = await addBySize(h.services, { feature: s.feature, body: b1, kind: 'fillets', size: 2, picked: [] });
      expect(one).toMatchObject({ ok: true, body: b1, words: 'Added 8 faces: 1 fillet chain, R2' });
      // Body 2 (a plain box) has none: what it has, in words.
      expect(await addBySize(h.services, { feature: s.feature, body: b2, kind: 'holes', size: 6, picked: [] })).toEqual({ ok: false, words: 'No holes up to Ø6 mm on Body 2 that are not already picked (Body 2 has no drilled holes)' });
      s.discard();
    },
    MS,
  );

  it('the Back isometric view looks the way the pictures\' iso_back does', () => {
    expect(VIEW_DIRS.iso_back).toEqual(SNAPSHOT_DIRS.iso_back);
    expect(VIEW_DIRS.iso_back.dir.map((v) => Math.sign(v))).toEqual([-1, 1, 1]);
  });
});
