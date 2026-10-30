// The Assistant's edits say honestly what happened, as the person and the model meet them (CAD
// tools spec §12.3 honest 5, T2): on a plate whose top edges are filleted with the parameter r,
// a set_params that would turn the fillet red changes nothing: the model gets failed
// broke_downstream naming Fillet 1, and the person's open Parameters panel still shows r's old
// value. Rows in any order (b uses a, set after it) apply in one step: the model gets each value,
// the panel shows them, and one Undo ("Undo Assistant: <request>") takes both away.
// Honest 1 (T4): a sketch whose constraint repeats a rect's own horizontal is refused before
// anything opens: invalid_input sketch_conflict naming both (the model's h1 and "r's own horizontal
// on r.top"); the person's tree, panels and Undo stay as they were. Resent without it, the sketch
// is made through the person's sketch panel, fully defined, and one Undo takes it back.
// delete (honest 7, T9) asks the person first in the app's dialog ("Allow the Assistant to delete
// features?", its copy saying one Undo takes back the whole request with the deletion, Don't focused): Enter answers Don't, the
// model gets declined and the Part never hears the call; a click on Allow deletes the feature the
// tree shows, and one Ctrl+Z brings it back.
// A sketch the model moves onto an offset plane: the tree shows the new plane above the sketch,
// which builds on it with no warning and moves with it when the person changes its distance. A
// plate with a keyhole (a circle and an overlapping slot) extruded as "all": the hole stays open
// (the volume chip shows the plate less the keyhole, not a solid plate).
// Honest 8: with the person's rollback bar above the end, the Assistant's edit waits (the chip reads
// "Assistant waits for you: move the rollback bar to the end", nothing changes) while its read
// answers with where the bar is; the person's drag of the bar to the end lets the edit finish, as
// one undo step.
// Its own server with the Assistant's test switches and the scripted model (e2e/assistant-helpers.ts).
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type Page } from '@playwright/test';
import { addSolid, historyNames, runCommand } from './helpers';
import { cadFrame, chats, chipWords, newProject, openNewPart, readRecord, recordShown, resetAssistant, resultsIn, startAssistantHost, startTurn, STEP, STEP_MS, useScriptedModel, type AssistantHost } from './assistant-helpers';

let host: AssistantHost;

test.beforeAll(async ({ request }) => {
  test.setTimeout(300_000);
  host = await startAssistantHost('cad-assistant-honest', 70);
  await useScriptedModel(request, host, 'cloud');
});

test.afterAll(async () => {
  if (host) await host.stop();
});

test.beforeEach(async ({ request }) => {
  await resetAssistant(request, host);
  await useScriptedModel(request, host, 'cloud');
});

test.afterEach(() => {
  expect(host.fake.pending(), 'scripted answers left unused').toBe(0);
});

type Doc = {
  addParam(p: { name: string; expr: string; quantity: string }): unknown;
  beginNew(type: string, init: unknown): { feature: string; commit(): void };
  beginEdit(id: string): { update(p: unknown): void; commit(): void };
  undo(): void;
  state: { get(): { doc: { params: { name: string; expr: string }[] }; rebuild: { status: string; features: Record<string, { state: string }>; bodies: { id: string; names: { faces: string[] } | null }[] }; history: { undoLabel: string | null } } };
};
type W = { __CAD__: { services: { doc: Doc }; assistant: { setPace(p: string | null, scale?: number | null): void } } };

const row = (name: string, expr: string) => ({ name, kind: 'length', expr, comment: '', rename_to: '' });

/** The person's plate: 40 x 30 x t, its top face's edges filleted r (2 mm), every feature built. */
async function filletedPlate(page: Page): Promise<string> {
  const made = await addSolid(page, { size: [40, 30, 6] });
  const fillet = await cadFrame(page).evaluate(
    ({ extrude, body }) => {
      const doc = (window as unknown as W).__CAD__.services.doc;
      doc.addParam({ name: 't', expr: '6 mm', quantity: 'length' });
      doc.addParam({ name: 'r', expr: '2 mm', quantity: 'length' });
      const ex = doc.beginEdit(extrude);
      ex.update({ extent: { kind: 'blind', distance: 't' } });
      ex.commit();
      // The top face by its name (a face reference as the Fillet panel keeps it).
      const ref = { name: `F:${extrude}:end`, signature: { kind: 'face', type: 'plane', at: [20, 15, 6], dir: [0, 0, 1] } };
      const fl = doc.beginNew('fillet', { body, edges: [], faces: [ref], radius: 'r' });
      fl.commit();
      return fl.feature;
    },
    { extrude: made.extrude, body: made.body },
  );
  await expect
    .poll(() => cadFrame(page).evaluate((id) => {
      const r = (window as unknown as W).__CAD__.services.doc.state.get().rebuild;
      return r.status === 'done' ? (r.features[id]?.state ?? null) : null;
    }, fillet), { timeout: STEP_MS * 3 })
    .toBe('ok');
  return fillet;
}

test('cad:assistant-honest-params a set_params that would break the fillet changes nothing; rows in any order apply in one step', async ({ page, request }) => {
  test.setTimeout(240_000);
  const pid = await newProject(request, host, 'Assistant honest parameters');
  const { frame, tab } = await openNewPart(page, request, host, pid);
  await cadFrame(page).evaluate(() => (window as unknown as W).__CAD__.assistant.setPace('fast', 0));
  const fillet = await filletedPlate(page);
  // The person's Parameters panel stays open through the turn (an idle one: the calls do not wait).
  await runCommand(frame, 'modify.parameters');
  const panel = frame.locator('[data-cad-panel="params"]');
  await expect(panel.locator('[data-param-row="r"] [data-param-value]')).toHaveText('2 mm', STEP);

  const before = chats(host).length;
  host.fake.reply(
    { tools: [{ name: 'cad__set_params', input: { set: [row('r', '10 mm')], remove: [] } }] },
    // b uses a, which comes after it: all rows apply together.
    { tools: [{ name: 'cad__set_params', input: { set: [row('b', 'a * 2'), row('a', '5 mm')], remove: [] } }] },
    { text: 'r stays 2 mm: 10 mm would break the fillet. a and b are set.' },
  );
  const t = await startTurn(request, host, { text: 'Make the fillet 10 mm, and add a and b.', tab });
  const { turn } = await t.ended(STEP_MS * 3);
  expect(turn.state).toBe('done');

  const [, afterBreak, afterRows] = chats(host).slice(before);
  const [broke] = resultsIn(afterBreak);
  expect(broke).toMatchObject({
    tool: 'cad__set_params',
    ok: false,
    error: { code: 'failed', detail: { reason: 'broke_downstream', broke: [{ feature: 'Fillet 1' }] }, hint: 'Nothing changed: pick a value that keeps the features in detail.broke working.' },
  });
  expect(broke.error!.message).toMatch(/^broke_downstream: Nothing changed: after it Fillet 1 would fail \(/);
  // The person sees the old value, and the fillet still builds.
  await expect(panel.locator('[data-param-row="r"] [data-param-value]')).toHaveText('2 mm', STEP);
  expect(await cadFrame(page).evaluate((id) => (window as unknown as W).__CAD__.services.doc.state.get().rebuild.features[id]?.state, fillet)).toBe('ok');

  const [rows] = resultsIn(afterRows);
  expect(rows).toMatchObject({
    tool: 'cad__set_params',
    ok: true,
    data: { params: [{ name: 'b', kind: 'length', expr: 'a * 2', value: 10, unit: 'mm' }, { name: 'a', kind: 'length', expr: '5 mm', value: 5, unit: 'mm' }], broke: [], step: 1 },
  });
  await expect(panel.locator('[data-param-row="a"] [data-param-value]')).toHaveText('5 mm', STEP);
  await expect(panel.locator('[data-param-row="b"] [data-param-value]')).toHaveText('10 mm', STEP);
  // One step: the Undo the person sees names the request, and one Undo takes both rows away.
  const label = () => cadFrame(page).evaluate(() => (window as unknown as W).__CAD__.services.doc.state.get().history.undoLabel);
  expect(await label()).toBe('Assistant: Make the fillet 10 mm, and add a and b.');
  const chip = frame.locator('[data-chip="assistant"]');
  await expect(chip).toHaveAttribute('data-assistant-state', 'ended', STEP);
  await expect(chipWords(frame)).toHaveText('Assistant: Make the fillet 10 mm, and add a and b. · done');
  await panel.locator('[data-panel-done]').click();
  await expect(panel).toHaveCount(0);
  await frame.locator('[data-cad-toolbar] [data-command="edit.undo"]').hover();
  await expect(frame.locator('[data-cad-tip]')).toContainText('Undo Assistant: Make the fillet 10 mm, and add a and b.', STEP);
  await frame.locator('[data-cad-toolbar] [data-command="edit.undo"]').click();
  await expect
    .poll(() => cadFrame(page).evaluate(() => (window as unknown as W).__CAD__.services.doc.state.get().doc.params.map((p) => `${p.name}=${p.expr}`)), STEP)
    .toEqual(['t=6 mm', 'r=2 mm']);
});

test('cad:assistant-honest-conflict a sketch that says one thing twice is refused naming both, changing nothing; resent without it, it is made', async ({ page, request }) => {
  test.setTimeout(240_000);
  const pid = await newProject(request, host, 'Assistant honest conflict');
  const { frame, tab } = await openNewPart(page, request, host, pid);
  await cadFrame(page).evaluate(() => (window as unknown as W).__CAD__.assistant.setPace('fast', 0));
  // The person's block: its tree rows and Undo are what the refused call must leave.
  await addSolid(page, { size: [40, 30, 6] });
  await expect(historyNames(frame)).toHaveText(['Sketch 1', 'Extrude 1'], STEP);
  const label = () => cadFrame(page).evaluate(() => (window as unknown as W).__CAD__.services.doc.state.get().history.undoLabel);
  const undoBefore = await label();
  expect(undoBefore).not.toBeNull();
  // Every panel that shows from now on (none may: the solver refuses before anything opens).
  await recordShown(page, 'panel', '[data-cad-panel]', 'data-cad-panel');

  const before = chats(host).length;
  host.fake.reply(
    {
      tools: [
        {
          name: 'cad__sketch',
          input: {
            edit: '',
            name: 'Plate sketch',
            on: 'Top',
            entities: [{ id: 'r', kind: 'rect', at: [-30, -20, 30, 20], construction: false }],
            constraints: [{ id: 'h1', kind: 'horizontal', refs: ['r.top'], value: '' }],
            infer: false,
          },
        },
      ],
    },
    // Resent without h1, anchored and dimensioned: made, fully defined.
    {
      tools: [
        {
          name: 'cad__sketch',
          input: {
            edit: '',
            name: 'Plate sketch',
            on: 'Top',
            entities: [{ id: 'r', kind: 'rect', at: [-30, -20, 30, 20], construction: false }],
            constraints: [
              { id: 'o', kind: 'coincident', refs: ['r.bl', 'origin'], value: '' },
              { id: 'w', kind: 'distance', refs: ['r.bottom'], value: '60 mm' },
              { id: 'd', kind: 'distance', refs: ['r.left'], value: '40 mm' },
            ],
            infer: false,
          },
        },
      ],
    },
    { text: 'The rectangle keeps its own horizontals: h1 was not needed. The plate sketch is fully defined.' },
  );
  const t = await startTurn(request, host, { text: 'Sketch a plate on Top.', tab });
  const { turn } = await t.ended(STEP_MS * 3);
  expect(turn.state).toBe('done');

  const [, afterSketch, afterMade] = chats(host).slice(before);
  const [refused] = resultsIn(afterSketch);
  expect(refused).toMatchObject({
    tool: 'cad__sketch',
    ok: false,
    error: {
      code: 'invalid_input',
      hint: 'Remove one of your named constraints; never add it back.',
      detail: {
        reason: 'sketch_conflict',
        conflicts: [
          { id: 'h1', kind: 'horizontal', refs: ['r.top'], label: 'horizontal r.top' },
          { id: 'r.h_top', kind: 'horizontal', refs: ['r.top'], internal: "r's own horizontal on r.top" },
        ],
      },
    },
  });
  expect(refused.error!.message).toBe("sketch_conflict: The sketch is over-defined: h1 (horizontal r.top) and r's own horizontal on r.top say the same thing; remove h1. Nothing changed.");
  // The refused call opened no panel: the first panel shown is the made sketch's own.
  const shown = await readRecord(page, 'panel');
  expect(shown[0]).toBe('(none)');
  expect(shown.slice(1)).toEqual(['sketch', '(none)']);
  // The resend is made, fully defined (no "(-)"), the solver's state stored with it.
  const [made] = resultsIn(afterMade);
  expect(made).toMatchObject({ tool: 'cad__sketch', ok: true, data: { feature: { name: 'Plate sketch', state: 'ok' }, solver: { state: 'fully', dof: 0 }, regions: [{ id: 'r1', area_mm2: 2400 }] } });
  expect(made.text).toBe('Sketch "Plate sketch" on Top: fully defined, 1 region (2400 mm²)');
  await expect(historyNames(frame)).toHaveText(['Sketch 1', 'Extrude 1', 'Plate sketch'], STEP);
  await expect(frame.locator('[data-cad-panel]')).toHaveCount(0);
  // One Undo, named after the request, takes the sketch back; the person's block stays (the refusal left nothing).
  expect(await label()).toBe('Assistant: Sketch a plate on Top.');
  await frame.locator('[data-cad-toolbar] [data-command="edit.undo"]').click();
  await expect(historyNames(frame)).toHaveText(['Sketch 1', 'Extrude 1'], STEP);
  expect(await label()).toBe(undoBefore);
});

type DeleteCad = {
  __CAD__: {
    services: { doc: { state: { get(): { doc: { features: { name: string }[] }; rebuild: { status: string; bodies: { name: string }[] } } } } };
    assistant: { setPace(p: string | null, scale?: number | null): void; calls: { tool: string; ok: boolean }[] };
  };
};

test("cad:assistant-honest-delete delete asks the person first: Don't keeps the feature, Allow deletes it, Ctrl+Z brings it back", async ({ page, request }) => {
  test.setTimeout(240_000);
  const pid = await newProject(request, host, 'Assistant honest delete');
  const { frame, tab } = await openNewPart(page, request, host, pid);
  await cadFrame(page).evaluate(() => (window as unknown as DeleteCad).__CAD__.assistant.setPace('fast', 0));
  await addSolid(page, { size: [40, 30, 6] });
  const rows = frame.locator('[data-cad-tree] [data-feature-row] > .tree-row .tl');
  await expect(rows).toHaveText(['Sketch 1', 'Extrude 1'], STEP);
  const built = () =>
    cadFrame(page).evaluate(() => {
      const s = (window as unknown as DeleteCad).__CAD__.services.doc.state.get();
      return s.rebuild.status === 'done' ? s.rebuild.bodies.map((b) => b.name) : null;
    });
  await expect.poll(built, STEP).toEqual(['Body 1']);
  const deleteCalls = () => cadFrame(page).evaluate(() => (window as unknown as DeleteCad).__CAD__.assistant.calls.filter((c) => c.tool === 'delete').map((c) => c.ok));
  // The app's own question, in its Assistant panel over the whole window (not the Part's frame;
  // never the app's confirm dialog).
  const dialog = page.locator('#assistant-dock [data-gate]').first();
  const part = (sel: string) => dialog.locator(sel);

  // Don't (Enter, the focused answer): the model hears declined, the Part never hears the call.
  const before = chats(host).length;
  host.fake.reply({ tools: [{ name: 'cad__delete', input: { features: ['Extrude 1'] } }] }, { text: 'The extrude stays.' });
  const t1 = await startTurn(request, host, { text: 'Delete the extrude.', tab });
  await expect(dialog).toBeVisible(STEP);
  await expect(part('.dock-gate-title')).toHaveText('Allow the Assistant to delete features?');
  await expect(part('.dock-gate-copy')).toContainText('Deletes features from the Part; one Undo takes back the whole request, this deletion with it.');
  await expect(part('.dock-gate-copy')).toContainText('What it sent: {"features":["Extrude 1"]}. Nothing runs until you choose.');
  await expect(part('[data-gate-answer="yes"]')).toHaveText('Allow');
  await expect(part('[data-gate-answer="no"]')).toHaveText("Don't");
  await expect(part('[data-gate-answer="no"]')).toBeFocused();
  // Nothing happened yet: the feature is still in the tree while the question is open.
  await expect(rows).toHaveText(['Sketch 1', 'Extrude 1']);
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden(STEP);
  await expect(page.locator('#modal-confirm')).toBeHidden();
  expect((await t1.ended(STEP_MS * 2)).turn.state).toBe('done');
  const [declined] = resultsIn(chats(host)[before + 1]);
  expect(declined).toMatchObject({ tool: 'cad__delete', ok: false, error: { code: 'declined' } });
  await expect(rows).toHaveText(['Sketch 1', 'Extrude 1'], STEP);
  expect(await built()).toEqual(['Body 1']);
  expect(await deleteCalls()).toEqual([]);

  // Allow (a click): the feature and its body are gone from the tree and the Part.
  const before2 = chats(host).length;
  host.fake.reply({ tools: [{ name: 'cad__delete', input: { features: ['Extrude 1'] } }] }, { text: 'Deleted the extrude.' });
  const t2 = await startTurn(request, host, { text: 'Delete the extrude now.', tab });
  await expect(dialog).toBeVisible(STEP);
  await expect(part('[data-gate-answer="no"]')).toBeFocused();
  await part('[data-gate-answer="yes"]').click();
  await expect(dialog).toBeHidden(STEP);
  expect((await t2.ended(STEP_MS * 2)).turn.state).toBe('done');
  await expect(rows).toHaveText(['Sketch 1'], STEP);
  const [deleted] = resultsIn(chats(host)[before2 + 1]);
  expect(deleted).toMatchObject({
    tool: 'cad__delete',
    ok: true,
    text: 'Deleted Extrude 1 · Body 1 removed',
    data: { deleted: ['Extrude 1'], bodies: { removed: ['Body 1'] }, broke: [], step: 1 },
  });
  expect(await deleteCalls()).toEqual([true]);
  await expect.poll(built, STEP).toEqual([]);
  // The person's Undo names the request, and one Ctrl+Z brings the extrude and its body back.
  await frame.locator('[data-cad-toolbar] [data-command="edit.undo"]').hover();
  await expect(frame.locator('[data-cad-tip]')).toContainText('Undo Assistant: Delete the extrude now.', STEP);
  // The app's Assistant panel opened for the question and covers the view's corner: closed first.
  await page.locator('#assistant-dock [data-dock-close]').click();
  const box = (await frame.locator('[data-cad-viewport] canvas').boundingBox())!;
  await page.mouse.click(box.x + box.width - 30, box.y + box.height - 30);
  await page.keyboard.press('Control+z');
  await expect(rows).toHaveText(['Sketch 1', 'Extrude 1'], STEP);
  await expect.poll(built, STEP).toEqual(['Body 1']);
});

// Honest 4 (T7): a fillet too large for its wall changes nothing. The model gets failed
// feature_failed with CAD's own words (the edges, and the largest radius that works); the person's
// tree, panels and Undo are as before the call. The same call with a radius that fits keeps the
// fillet: its row in the tree, the body's volume falling by the rounded edges, and one Undo.
const MODIFY = (o: Record<string, unknown>) => ({ edit: '', name: '', kind: 'fillet', targets: [], size: '', size2: '', flip: false, inward: false, ...o });
const treeNames = (page: Page) => cadFrame(page).evaluate(() => Array.from(document.querySelectorAll('[data-cad-tree] [data-feature-row] > .tree-row .tl'), (e) => e.textContent ?? ''));

test('cad:assistant-honest-fillet a fillet too large for its wall changes nothing; one that fits is kept', async ({ page, request }) => {
  test.setTimeout(240_000);
  const pid = await newProject(request, host, 'Assistant honest fillet');
  const { frame, tab } = await openNewPart(page, request, host, pid);
  await cadFrame(page).evaluate(() => (window as unknown as W).__CAD__.assistant.setPace('fast', 0));
  // The person's plate: 40 x 30 x 6.
  await addSolid(page, { size: [40, 30, 6] });
  await expect.poll(() => treeNames(page), STEP).toEqual(['Sketch 1', 'Extrude 1']);
  const label = () => cadFrame(page).evaluate(() => (window as unknown as W).__CAD__.services.doc.state.get().history.undoLabel);
  const undoBefore = await label();
  const volume = frame.locator('[data-chip="volume"] [data-volume-mm3]');
  const mm3 = async () => Math.round(Number(await volume.getAttribute('data-volume-mm3')));
  await expect.poll(mm3, STEP).toBe(7200);

  const before = chats(host).length;
  host.fake.reply(
    { tools: [{ name: 'cad__modify', input: MODIFY({ targets: ['Extrude 1.end'], size: '20 mm' }) }] },
    { text: 'A 20 mm round does not fit the 6 mm plate.' },
  );
  const t1 = await startTurn(request, host, { text: 'Round the top edges 20 mm.', tab });
  expect((await t1.ended(STEP_MS * 3)).turn.state).toBe('done');
  const [failed] = resultsIn(chats(host).slice(before)[1]);
  expect(failed).toMatchObject({
    tool: 'cad__modify',
    ok: false,
    error: { code: 'failed', hint: 'Read detail.message and detail.sub, change the inputs and call again.', detail: { reason: 'feature_failed', feature: 'Fillet 1' } },
  });
  expect(failed.error!.message).toMatch(/^feature_failed: Fillet 1 fails: Fillet 1 failed: a radius of 20 mm is too large for .+: \d+(\.\d+)? mm or less works$/);
  // What the person sees: the tree, no panel left open, the volume and the Undo as before.
  await expect.poll(() => treeNames(page), STEP).toEqual(['Sketch 1', 'Extrude 1']);
  await expect(frame.locator('[data-cad-panel]')).toHaveCount(0);
  await expect.poll(mm3, STEP).toBe(7200);
  expect(await label()).toBe(undoBefore);

  const next = chats(host).length;
  host.fake.reply({ tools: [{ name: 'cad__modify', input: MODIFY({ targets: ['Extrude 1.end'], size: '2 mm' }) }] }, { text: 'The top edges are rounded 2 mm.' });
  const t2 = await startTurn(request, host, { text: 'Round the top edges 2 mm.', tab });
  expect((await t2.ended(STEP_MS * 3)).turn.state).toBe('done');
  const [kept] = resultsIn(chats(host).slice(next)[1]);
  expect(kept).toMatchObject({ tool: 'cad__modify', ok: true, data: { feature: { name: 'Fillet 1', type: 'fillet', state: 'ok' }, kept_as: '1 face (every edge of each, a live set)', body: 'Body 1', broke: [] } });
  await expect.poll(() => treeNames(page), STEP).toEqual(['Sketch 1', 'Extrude 1', 'Fillet 1']);
  await expect(frame.locator('[data-cad-panel]')).toHaveCount(0);
  // Four edges rounded: the plate loses about (1 - pi/4) r^2 per mm of edge.
  await expect.poll(mm3, STEP).toBeLessThan(7200 - 0.8 * (1 - Math.PI / 4) * 4 * 140);
  expect(await label()).toBe('Assistant: Round the top edges 2 mm.');
  await frame.locator('[data-cad-toolbar] [data-command="edit.undo"]').click();
  await expect.poll(() => treeNames(page), STEP).toEqual(['Sketch 1', 'Extrude 1']);
});

// T7 too: copies that miss the body they join change nothing and say so by name; the model then
// makes them new bodies and combines them, which the person sees in the tree and the volume chip.
const PATTERN = (o: Record<string, unknown>) => ({ edit: '', name: '', kind: 'linear', of: 'bodies', items: [], about: 'X axis', count: '', spacing: '', flip: false, about2: '', count2: '', spacing2: '', options: [], skip: [], op: 'new', bodies: [], ...o });

test('cad:assistant-honest-pattern copies that miss their body change nothing; new bodies and a combine are kept', async ({ page, request }) => {
  test.setTimeout(240_000);
  const pid = await newProject(request, host, 'Assistant honest pattern');
  const { frame, tab } = await openNewPart(page, request, host, pid);
  await cadFrame(page).evaluate(() => (window as unknown as W).__CAD__.assistant.setPace('fast', 0));
  await addSolid(page, { size: [40, 30, 6] });
  await expect.poll(() => treeNames(page), STEP).toEqual(['Sketch 1', 'Extrude 1']);
  const before = chats(host).length;
  host.fake.reply(
    { tools: [{ name: 'cad__pattern', input: PATTERN({ items: ['Body 1'], count: '3', spacing: '50 mm', op: 'join' }) }] },
    { tools: [{ name: 'cad__pattern', input: PATTERN({ items: ['Body 1'], count: '3', spacing: '50 mm', op: 'new' }) }] },
    { tools: [{ name: 'cad__combine', input: { edit: '', name: '', op: 'join', targets: ['Body 1'], tools: ['bodies of Linear pattern 1'], keep_tools: false } }] },
    { text: 'Three plates in a row, as one body of three pieces.' },
  );
  const t = await startTurn(request, host, { text: 'Three plates in a row, one body.', tab });
  expect((await t.ended(STEP_MS * 3)).turn.state).toBe('done');
  const [, afterMiss, afterNew, afterCombine] = chats(host).slice(before);
  const [miss] = resultsIn(afterMiss);
  expect(miss).toMatchObject({ tool: 'cad__pattern', ok: false, error: { code: 'failed', detail: { reason: 'feature_failed', feature: 'Linear pattern 1' } } });
  expect(miss.error!.message).toContain('Linear pattern 1');
  const [made] = resultsIn(afterNew);
  expect(made).toMatchObject({ tool: 'cad__pattern', ok: true, data: { feature: { name: 'Linear pattern 1', state: 'ok' }, copies: { made: 2 } } });
  expect((made.data!.bodies as { created: { body: string }[] }).created.map((b) => b.body)).toEqual(['Body 1 (Instance 2)', 'Body 1 (Instance 3)']);
  const [joined] = resultsIn(afterCombine);
  expect(joined).toMatchObject({ tool: 'cad__combine', ok: true, data: { targets: ['Body 1'], tools: ['Body 1 (Instance 2)', 'Body 1 (Instance 3)'] } });
  expect(joined.data!.warnings).toEqual(expect.arrayContaining([expect.stringContaining('Body 1 now has 3 solids (it had 1)')]));
  // The person's tree: no trace of the failed call; the pattern and the combine.
  await expect.poll(() => treeNames(page), STEP).toEqual(['Sketch 1', 'Extrude 1', 'Linear pattern 1', 'Combine 1']);
  await expect(frame.locator('[data-cad-panel]')).toHaveCount(0);
  // One body of three plates: the volume chip.
  await expect.poll(async () => Math.round(Number(await frame.locator('[data-chip="volume"] [data-volume-mm3]').getAttribute('data-volume-mm3'))), STEP).toBe(3 * 7200);
});

// Honest 2 and 3 (T5): a join or a cut that meets nothing changes nothing and says which way it
// missed. A boss sketched beside the person's plate and joined fails with CAD's own words
// (feature_failed, detail.sub no_overlap); a pocket on the plate's top face cut away from it
// answers wrong_side with the flip hint, and resent with flip true it cuts (the tree's row, the
// volume chip). The L bracket the model builds (polyline, symmetric extrude): a hole sketched on
// its -X face at v = +22.5 and cut through lies below it, so the answer is off_body with the face's
// frame in words ("u runs +Y, v runs -Z"). Each time the person's tree, panels, volume and Undo are
// as before the call.
const EXTRUDE_IN = (o: Record<string, unknown>) => ({ edit: '', name: '', sketch: '', regions: ['all'], face: '', direction: '', extent: 'blind', distance: '', distance2: '', to: '', flip: false, op: 'new', bodies: [], body_name: '', color: '', ...o });
/** A disc on `on`, fully defined: its centre at (u, v) from the sketch origin and its diameter (no (-) in the tree). */
const DISC = (name: string, on: string, u: number, v: number, r: number) => ({
  edit: '',
  name,
  on,
  entities: [{ id: 'c', kind: 'circle', at: [u, v, r], construction: false }],
  constraints: [
    { id: 'cu', kind: 'distance_x', refs: ['origin', 'c.center'], value: `${u} mm` },
    { id: 'cv', kind: 'distance_y', refs: ['origin', 'c.center'], value: `${v} mm` },
    { id: 'cd', kind: 'diameter', refs: ['c'], value: `${2 * r} mm` },
  ],
  infer: false,
});
type MissCad = { __CAD__: { services: { doc: { state: { get(): { history: { undoLabel: string | null } } } } }; assistant: { setPace(p: string | null, scale?: number | null): void } } };
const undoNow = (page: Page) => cadFrame(page).evaluate(() => (window as unknown as MissCad).__CAD__.services.doc.state.get().history.undoLabel);
const volumeNow = async (page: Page) => Math.round(Number(await cadFrame(page).locator('[data-chip="volume"] [data-volume-mm3]').getAttribute('data-volume-mm3')));

test('cad:assistant-honest-join a boss joined beside the plate changes nothing and answers no_overlap with CAD\'s words', async ({ page, request }) => {
  test.setTimeout(240_000);
  const pid = await newProject(request, host, 'Assistant honest join');
  const { frame, tab } = await openNewPart(page, request, host, pid);
  await cadFrame(page).evaluate(() => (window as unknown as MissCad).__CAD__.assistant.setPace('fast', 0));
  await addSolid(page, { size: [40, 30, 6] });
  await expect.poll(() => treeNames(page), STEP).toEqual(['Sketch 1', 'Extrude 1']);
  await expect.poll(() => volumeNow(page), STEP).toBe(7200);
  const before = chats(host).length;
  host.fake.reply(
    // A disc 30 mm past the plate's end, joined: nothing to join.
    { tools: [{ name: 'cad__sketch', input: DISC('Boss sketch', 'Top', 70, 15, 5) }] },
    { tools: [{ name: 'cad__extrude', input: EXTRUDE_IN({ name: 'Boss', sketch: 'Boss sketch', distance: '6 mm', op: 'join' }) }] },
    { text: 'The boss does not touch the plate.' },
  );
  const t = await startTurn(request, host, { text: 'Add a boss beside the plate.', tab });
  expect((await t.ended(STEP_MS * 3)).turn.state).toBe('done');
  const [, , afterJoin] = chats(host).slice(before);
  const [join] = resultsIn(afterJoin);
  expect(join).toMatchObject({
    tool: 'cad__extrude',
    ok: false,
    error: {
      code: 'failed',
      hint: 'A join needs to overlap the body or share a face with it: move the profile onto the body, or use op new and then combine.',
      detail: { reason: 'feature_failed', feature: 'Boss', sub: 'no_overlap', message: 'Nothing to join: Boss shares no face with a body made before it', profile_bbox_mm: [[65, 10, 0], [75, 20, 0]], bodies: [{ body: 'Body 1', bbox_mm: [[0, 0, 0], [40, 30, 6]] }] },
    },
  });
  expect(join.error!.message).toMatch(/^feature_failed: Boss fails: Nothing to join: Boss shares no face with a body made before it\. It touches no body\. /);
  // What the person sees: the sketch the turn made, no Boss row, no panel, the volume as it was.
  await expect.poll(() => treeNames(page), STEP).toEqual(['Sketch 1', 'Extrude 1', 'Boss sketch']);
  await expect(frame.locator('[data-cad-panel]')).toHaveCount(0);
  await expect.poll(() => volumeNow(page), STEP).toBe(7200);
  // The Undo is the turn's sketch, nothing of the refused join.
  expect(await undoNow(page)).toBe('Assistant: Add a boss beside the plate.');
  await frame.locator('[data-cad-toolbar] [data-command="edit.undo"]').click();
  await expect.poll(() => treeNames(page), STEP).toEqual(['Sketch 1', 'Extrude 1']);
});

test('cad:assistant-honest-miss a cut that points away answers wrong_side with the flip hint; resent with flip it cuts', async ({ page, request }) => {
  test.setTimeout(240_000);
  const pid = await newProject(request, host, 'Assistant honest miss');
  const { frame, tab } = await openNewPart(page, request, host, pid);
  await cadFrame(page).evaluate(() => (window as unknown as MissCad).__CAD__.assistant.setPace('fast', 0));
  await addSolid(page, { size: [40, 30, 6] });
  await expect.poll(() => treeNames(page), STEP).toEqual(['Sketch 1', 'Extrude 1']);
  await expect.poll(() => volumeNow(page), STEP).toBe(7200);

  // A pocket on the plate's top face: cut along its normal (out of the plate), then with flip.
  const before = chats(host).length;
  host.fake.reply(
    { tools: [{ name: 'cad__sketch', input: DISC('Pocket sketch', 'Extrude 1.end', 20, 15, 5) }] },
    { tools: [{ name: 'cad__extrude', input: EXTRUDE_IN({ name: 'Pocket', sketch: 'Pocket sketch', distance: '3 mm', op: 'cut' }) }] },
    { tools: [{ name: 'cad__extrude', input: EXTRUDE_IN({ name: 'Pocket', sketch: 'Pocket sketch', distance: '3 mm', flip: true, op: 'cut' }) }] },
    { text: 'The pocket is cut 3 mm deep.' },
  );
  const t1 = await startTurn(request, host, { text: 'Cut a pocket in the plate.', tab });
  expect((await t1.ended(STEP_MS * 3)).turn.state).toBe('done');
  const [, , afterAway, afterFlip] = chats(host).slice(before);
  const [away] = resultsIn(afterAway);
  expect(away).toMatchObject({
    tool: 'cad__extrude',
    ok: false,
    error: { code: 'failed', hint: 'The cut points away from the body: set flip true, or use hole.', detail: { reason: 'feature_failed', feature: 'Pocket', sub: 'wrong_side', other_way: 'Body 1', frame: { words: 'u runs +X, v runs +Y, origin (0, 0, 6)' } } },
  });
  expect(away.error!.message).toMatch(/It points away from the body: with flip true it would cut Body 1\.$/);
  const [cut] = resultsIn(afterFlip);
  expect(cut).toMatchObject({ tool: 'cad__extrude', ok: true, data: { feature: { name: 'Pocket', type: 'extrude', state: 'ok' }, broke: [] } });
  expect(cut.text).toBe('Extrude Pocket ok · Body 1 7200 → 6964 mm³');
  // The person's tree has the one Pocket that was kept, and the volume chip the cut.
  await expect.poll(() => treeNames(page), STEP).toEqual(['Sketch 1', 'Extrude 1', 'Pocket sketch', 'Pocket']);
  await expect(frame.locator('[data-cad-panel]')).toHaveCount(0);
  await expect.poll(() => volumeNow(page), STEP).toBe(Math.round(7200 - 75 * Math.PI));
});

test('cad:assistant-honest-offbody a hole cut beside the L bracket answers off_body with the face\'s frame in words; nothing changes', async ({ page, request }) => {
  test.setTimeout(240_000);
  // The L bracket the model builds, then a hole on its -X face at v = +22.5: below the bracket (v runs -Z there).
  const L = [0, 0, 50, 0, 50, 5, 5, 5, 5, 40, 0, 40, 0, 0];
  const lProfile = {
    edit: '',
    name: 'L profile',
    on: 'Front',
    entities: [{ id: 'p', kind: 'polyline', at: L, construction: false }],
    constraints: [
      { id: 'o', kind: 'coincident', refs: ['p.p0', 'origin'], value: '' },
      { id: 'a', kind: 'distance', refs: ['p.1'], value: '50 mm' },
      { id: 'b', kind: 'distance', refs: ['p.6'], value: '40 mm' },
      { id: 't1', kind: 'distance', refs: ['p.2'], value: '5 mm' },
      { id: 't2', kind: 'distance', refs: ['p.5'], value: '5 mm' },
    ],
    infer: true,
  };
  const pid = await newProject(request, host, 'Assistant honest bracket');
  const { frame, tab } = await openNewPart(page, request, host, pid);
  await cadFrame(page).evaluate(() => (window as unknown as MissCad).__CAD__.assistant.setPace('fast', 0));
  const next = chats(host).length;
  host.fake.reply(
    { tools: [{ name: 'cad__sketch', input: lProfile }] },
    { tools: [{ name: 'cad__extrude', input: EXTRUDE_IN({ name: 'Bracket', sketch: 'L profile', extent: 'symmetric', distance: '30 mm' }) }] },
    { tools: [{ name: 'cad__sketch', input: DISC('Hole sketch', 'Bracket.side(p.6)', 0, 22.5, 3) }] },
    { tools: [{ name: 'cad__extrude', input: EXTRUDE_IN({ name: 'Hole', sketch: 'Hole sketch', extent: 'through', flip: true, op: 'cut' }) }] },
    { text: 'The hole missed the bracket: v runs -Z on that face.' },
  );
  const t2 = await startTurn(request, host, { text: 'An L bracket with a hole in its upright.', tab });
  expect((await t2.ended(STEP_MS * 4)).turn.state).toBe('done');
  const [, afterProfile, afterBracket, , afterHole] = chats(host).slice(next);
  expect(resultsIn(afterProfile)[0]).toMatchObject({ tool: 'cad__sketch', ok: true, data: { solver: { state: 'fully', dof: 0 } } });
  expect(resultsIn(afterBracket)[0]).toMatchObject({ tool: 'cad__extrude', ok: true, text: 'Extrude Bracket ok · Body 1 made (12750 mm³)' });
  const [hole] = resultsIn(afterHole);
  expect(hole).toMatchObject({
    tool: 'cad__extrude',
    ok: false,
    error: {
      code: 'failed',
      hint: 'The profile lies beside the body: read detail.frame (where u and v point in model axes) and move the profile.',
      detail: { reason: 'feature_failed', feature: 'Hole', sub: 'off_body', frame: { u: [0, 1, 0], v: [0, 0, -1], normal: [-1, 0, 0] }, profile_bbox_mm: [[0, -3, -25.5], [0, 3, -19.5]] },
    },
  });
  expect((hole.error!.detail!.frame as { words: string }).words).toContain('u runs +Y, v runs -Z');
  // The person's tree: the bracket and the hole's sketch, no Hole; the bracket's volume.
  await expect.poll(() => treeNames(page), STEP).toEqual(['L profile', 'Bracket', 'Hole sketch']);
  await expect(frame.locator('[data-cad-panel]')).toHaveCount(0);
  await expect.poll(() => volumeNow(page), STEP).toBe(12750);
  expect(await undoNow(page)).toBe('Assistant: An L bracket with a hole in its upright.');
});

// Honest 3, the hole (T6): on the L bracket's -X face, where a sketched profile at v = +22.5 cut
// beside the bracket, hole takes model coordinates (x "" along the face's normal, y 0, z "b/2")
// and the hole lands in the upright: the sketch's v runs -Z there, so its position is written
// "-(b/2)" for the model. The person's tree shows the hole's sketch and cut, fully defined, the
// volume chip falls by pi 3^2 5, and one Undo takes the whole request back.
test('cad:assistant-honest-hole hole on the bracket\'s -X face lands where the model coordinates say; one Undo takes it back', async ({ page, request }) => {
  test.setTimeout(240_000);
  const L = [0, 0, 50, 0, 50, 5, 5, 5, 5, 40, 0, 40, 0, 0];
  const lProfile = {
    edit: '',
    name: 'L profile',
    on: 'Front',
    entities: [{ id: 'p', kind: 'polyline', at: L, construction: false }],
    constraints: [
      { id: 'o', kind: 'coincident', refs: ['p.p0', 'origin'], value: '' },
      { id: 'da', kind: 'distance', refs: ['p.1'], value: 'a' },
      { id: 'db', kind: 'distance', refs: ['p.6'], value: 'b' },
      { id: 't1', kind: 'distance', refs: ['p.2'], value: 't' },
      { id: 't2', kind: 'distance', refs: ['p.5'], value: 't' },
    ],
    infer: true,
  };
  const row = (name: string, expr: string) => ({ name, kind: 'length', expr, comment: '', rename_to: '' });
  const pid = await newProject(request, host, 'Assistant honest hole');
  const { frame, tab } = await openNewPart(page, request, host, pid);
  await cadFrame(page).evaluate(() => (window as unknown as MissCad).__CAD__.assistant.setPace('fast', 0));
  const next = chats(host).length;
  host.fake.reply(
    { tools: [{ name: 'cad__set_params', input: { set: [row('a', '50 mm'), row('b', '40 mm'), row('t', '5 mm')], remove: [] } }] },
    { tools: [{ name: 'cad__sketch', input: lProfile }] },
    { tools: [{ name: 'cad__extrude', input: EXTRUDE_IN({ name: 'Bracket', sketch: 'L profile', extent: 'symmetric', distance: '30 mm' }) }] },
    { tools: [{ name: 'cad__hole', input: { name: '', face: 'Bracket.side(p.6)', centers: [{ x: '', y: '0 mm', z: 'b/2' }], diameter: '6 mm', depth: 'through', distance: '' } }] },
    { text: 'The bracket has a 6 mm hole through its upright.' },
  );
  const t = await startTurn(request, host, { text: 'An L bracket with a hole in its upright.', tab });
  expect((await t.ended(STEP_MS * 5)).turn.state).toBe('done');
  const [, , , afterBracket, afterHole] = chats(host).slice(next);
  expect(resultsIn(afterBracket)[0]).toMatchObject({ tool: 'cad__extrude', ok: true, text: 'Extrude Bracket ok · Body 1 made (12750 mm³)' });
  const [hole] = resultsIn(afterHole);
  expect(hole).toMatchObject({
    tool: 'cad__hole',
    ok: true,
    text: 'Hole 1 ok: 1 hole 6 mm across, through, in Bracket.side(p.6) · Body 1 12750 → 12609 mm³',
    data: {
      feature: { name: 'Hole 1', type: 'extrude', state: 'ok' },
      made: ['Hole 1 sketch', 'Hole 1'],
      resolved: { face: 'Bracket.side(p.6) (faces -X)', frame: 'u runs +Y, v runs -Z, origin (0, 0, 0)', op: 'cut Body 1' },
      centers_mm: [[0, 0, 20]],
      dimensions: { d: '6 mm', h1x: '0 mm', h1y: '-(b/2)' },
      broke: [],
    },
  });
  // What the person sees: the bracket, the hole's sketch (fully defined: no "(-)") and its cut,
  // no panel left open, the volume chip less pi 3^2 5.
  await expect.poll(() => treeNames(page), STEP).toEqual(['L profile', 'Bracket', 'Hole 1 sketch', 'Hole 1']);
  await expect(frame.locator('[data-cad-panel]')).toHaveCount(0);
  await expect.poll(() => volumeNow(page), STEP).toBe(Math.round(12750 - Math.PI * 9 * 5));
  // One Undo for the whole request.
  expect(await undoNow(page)).toBe('Assistant: An L bracket with a hole in its upright.');
  await frame.locator('[data-cad-toolbar] [data-command="edit.undo"]').click();
  await expect.poll(() => treeNames(page), STEP).toEqual([]);
});

// T8: a sweep the kernel cannot make (its path has a gap) changes nothing: the model gets failed
// feature_failed with CAD's own words, and the person's tree shows only the two sketches. Sent
// with the whole path, the pipe elbow is made through the person's own Sweep panel (read-only,
// the Assistant's): its row in the tree, the volume chip the ring's area times the path's length,
// the faces it made as labels (Pipe.side(o@a2), the bend), and one Undo takes the turn back.
const SWEEP = (o: Record<string, unknown>) => ({ edit: '', name: '', kind: 'sweep', profiles: ['Ring'], path: 'Path', orientation: 'follow', ruled: false, op: 'new', bodies: [], body_name: '', color: '', ...o });
const SKETCH = (name: string, on: string, entities: { id: string; kind: string; at: number[] }[]) => ({ edit: '', name, on, entities: entities.map((e) => ({ ...e, construction: false })), constraints: [], infer: false });

test('cad:assistant-honest-sweep a sweep whose path has a gap changes nothing; the whole path makes the pipe', async ({ page, request }) => {
  test.setTimeout(240_000);
  const pid = await newProject(request, host, 'Assistant honest sweep');
  const { frame, tab } = await openNewPart(page, request, host, pid);
  await cadFrame(page).evaluate(() => (window as unknown as W).__CAD__.assistant.setPace('fast', 0));
  await recordShown(page, 'panel-owner', '[data-cad-panel="feature"]', 'data-panel-owner');
  await recordShown(page, 'panel-title', '[data-cad-panel="feature"]', 'aria-label');
  const before = chats(host).length;
  host.fake.reply(
    { tools: [{ name: 'cad__sketch', input: SKETCH('Ring', 'Top', [{ id: 'o', kind: 'circle', at: [0, 0, 10] }, { id: 'i', kind: 'circle', at: [0, 0, 8] }]) }] },
    // On Front u is +X and v is +Z: 30 up, a R40 bend towards +X, 30 along.
    {
      tools: [
        {
          name: 'cad__sketch',
          input: SKETCH('Path', 'Front', [
            { id: 'l1', kind: 'line', at: [0, 0, 0, 30] },
            { id: 'a2', kind: 'arc', at: [40, 30, 40, 90, 180] },
            { id: 'l3', kind: 'line', at: [40, 70, 70, 70] },
          ]),
        },
      ],
    },
    { tools: [{ name: 'cad__sweep_loft', input: SWEEP({ name: 'Pipe', path: 'Path: l1, l3' }) }] },
    { tools: [{ name: 'cad__sweep_loft', input: SWEEP({ name: 'Pipe' }) }] },
    { text: 'The bend was missing from the path; the pipe elbow is made.' },
  );
  const t = await startTurn(request, host, { text: 'A pipe elbow.', tab });
  expect((await t.ended(STEP_MS * 3)).turn.state).toBe('done');
  const [, , , afterGap, afterPipe] = chats(host).slice(before);
  const [gap] = resultsIn(afterGap);
  expect(gap).toMatchObject({
    tool: 'cad__sweep_loft',
    ok: false,
    error: { code: 'failed', detail: { reason: 'feature_failed', feature: 'Pipe', message: 'Pipe failed: the path has a gap: its curves must join end to end in one chain' } },
  });
  const [pipe] = resultsIn(afterPipe);
  expect(pipe).toMatchObject({ tool: 'cad__sweep_loft', ok: true, data: { feature: { name: 'Pipe', type: 'sweep', state: 'ok' }, path: { sketch: 'Path', curves: ['l1', 'a2', 'l3'] }, broke: [] } });
  expect(pipe.data!.created).toEqual(expect.arrayContaining(['Pipe.start', 'Pipe.end', 'Pipe.side(o@a2)', 'Pipe.side(i@l1)']));
  // What the person saw and sees: the Assistant's own Sweep panel, then the tree with no trace of
  // the failed call, no panel left open, the pipe's volume.
  expect(await readRecord(page, 'panel-owner')).toContain('assistant');
  expect(await readRecord(page, 'panel-title')).toContain('Pipe');
  // (The two sketches are drawn with no dimensions: under-defined, "(-)".)
  await expect.poll(() => treeNames(page), STEP).toEqual(['(-) Ring', '(-) Path', 'Pipe']);
  await expect(frame.locator('[data-cad-panel]')).toHaveCount(0);
  const PIPE = Math.PI * (100 - 64) * (60 + 20 * Math.PI);
  const mm3 = async () => Number(await frame.locator('[data-chip="volume"] [data-volume-mm3]').getAttribute('data-volume-mm3'));
  await expect.poll(async () => Math.abs((await mm3()) / PIPE - 1), STEP).toBeLessThan(1e-3);
  // The turn is one undo step, named after the request.
  const label = () => cadFrame(page).evaluate(() => (window as unknown as W).__CAD__.services.doc.state.get().history.undoLabel);
  expect(await label()).toBe('Assistant: A pipe elbow.');
  await frame.locator('[data-cad-toolbar] [data-command="edit.undo"]').click();
  await expect.poll(() => treeNames(page), STEP).toEqual([]);
});

test('cad:assistant-honest-keyhole a plate with a keyhole extruded as "all" keeps the keyhole open: the volume is the plate less the keyhole', async ({ page, request }) => {
  test.setTimeout(240_000);
  const pid = await newProject(request, host, 'Assistant honest keyhole');
  const { frame, tab } = await openNewPart(page, request, host, pid);
  await cadFrame(page).evaluate(() => (window as unknown as MissCad).__CAD__.assistant.setPace('fast', 0));
  const before = chats(host).length;
  const keyhole = {
    edit: '',
    name: 'Key sk',
    on: 'Top',
    entities: [
      { id: 'r', kind: 'rect', at: [-30, -20, 30, 20], construction: false },
      { id: 'c', kind: 'circle', at: [0, 0, 5], construction: false },
      { id: 's', kind: 'rect', at: [-2, -12, 2, 0], construction: false },
    ],
    constraints: [],
    infer: false,
  };
  host.fake.reply({ tools: [{ name: 'cad__sketch', input: keyhole }] }, { tools: [{ name: 'cad__extrude', input: EXTRUDE_IN({ name: 'Plate', sketch: 'Key sk', distance: '5 mm' }) }] }, { text: 'The plate has its keyhole.' });
  const t = await startTurn(request, host, { text: 'A 60 x 40 x 5 plate with a keyhole.', tab });
  expect((await t.ended(STEP_MS * 3)).turn.state).toBe('done');
  const [, afterSketch, afterExtrude] = chats(host).slice(before);
  // The sketch's answer: the plate (one hole) and the keyhole's three pieces.
  const [sk] = resultsIn(afterSketch);
  expect(sk).toMatchObject({ tool: 'cad__sketch', ok: true });
  expect((sk.data!.regions as { holes: number }[]).map((r) => r.holes)).toEqual([1, 0, 0, 0]);
  const [ex] = resultsIn(afterExtrude);
  expect(ex).toMatchObject({ tool: 'cad__extrude', ok: true, data: { feature: { name: 'Plate', state: 'ok' } } });
  // What the person sees: the plate less the keyhole (a circle r 5 and a 4 x 12 slot overlapping it).
  const inside = 2 * (Math.sqrt(21) + 12.5 * Math.asin(0.4));
  const KEYHOLE = 25 * Math.PI + 48 - inside;
  await expect.poll(() => volumeNow(page), STEP).toBe(Math.round(5 * (2400 - KEYHOLE)));
  await expect(frame.locator('[data-cad-panel]')).toHaveCount(0);
});

type PlaneCad = {
  __CAD__: {
    services: {
      doc: {
        beginEdit(id: string): { update(p: unknown): void; commit(): void };
        state: { get(): { doc: { features: { id: string; name: string; type: string }[] }; rebuild: { status: string; outputs: Record<string, { type: string; plane?: { origin: number[] } }> } } };
      };
    };
    assistant: { setPace(p: string | null, scale?: number | null): void };
  };
};
/** The lid's circle on `on`, fully defined (a new sketch, or `edit` resends it). */
const LID = (edit: string, on: string) => ({
  name: 'cad__sketch',
  input: {
    edit,
    name: edit ? '' : 'Lid sk',
    on,
    entities: [{ id: 'c', kind: 'circle', at: [0, 0, 5], construction: false }],
    constraints: [
      { id: 'o', kind: 'coincident', refs: ['c.center', 'origin'], value: '' },
      { id: 'd', kind: 'diameter', refs: ['c'], value: '10 mm' },
    ],
    infer: false,
  },
});

test('cad:assistant-honest-plane a sketch the model moves onto an offset plane: the tree shows the plane above it, no warning, and the sketch follows the plane', async ({ page, request }) => {
  test.setTimeout(240_000);
  const pid = await newProject(request, host, 'Assistant honest plane');
  const { frame, tab } = await openNewPart(page, request, host, pid);
  await cadFrame(page).evaluate(() => (window as unknown as PlaneCad).__CAD__.assistant.setPace('fast', 0));
  const before = chats(host).length;
  host.fake.reply({ tools: [LID('', 'Top')] }, { tools: [LID('Lid sk', 'Top offset 20 mm')] }, { text: 'The lid sketch is 20 mm above Top.' });
  const t = await startTurn(request, host, { text: 'Sketch the lid 20 mm above Top.', tab });
  expect((await t.ended(STEP_MS * 3)).turn.state).toBe('done');
  const [, , afterMove] = chats(host).slice(before);
  const [moved] = resultsIn(afterMove);
  expect(moved).toMatchObject({ tool: 'cad__sketch', ok: true, data: { plane: { origin_mm: [0, 0, 20] }, warnings: [] } });
  // What the person sees: the plane above the sketch in the tree, the sketch built with no warning.
  await expect.poll(() => treeNames(page), STEP).toEqual(['Lid sk plane', 'Lid sk']);
  const sketchRow = frame.locator('[data-cad-tree] [data-feature-row][data-feature-type="sketch"]');
  await expect(sketchRow).toHaveAttribute('data-state', 'ok', STEP);
  // The person moves the plane to 30 mm: the sketch goes with it, still with no warning.
  const originZ = () =>
    cadFrame(page).evaluate(() => {
      const s = (window as unknown as PlaneCad).__CAD__.services.doc.state.get();
      const f = s.doc.features.find((x) => x.name === 'Lid sk');
      return s.rebuild.status === 'done' && f ? (s.rebuild.outputs[f.id]?.plane?.origin[2] ?? null) : null;
    });
  expect(await originZ()).toBeCloseTo(20, 6);
  await cadFrame(page).evaluate(() => {
    const doc = (window as unknown as PlaneCad).__CAD__.services.doc;
    const plane = doc.state.get().doc.features.find((x) => x.name === 'Lid sk plane')!;
    const e = doc.beginEdit(plane.id);
    e.update({ distance: '30 mm' });
    e.commit();
  });
  await expect.poll(originZ, STEP).toBeCloseTo(30, 6);
  await expect(sketchRow).toHaveAttribute('data-state', 'ok', STEP);
});

test('cad:assistant-honest-rolled-back with the rollback bar above the end the edit waits and the read answers; the person dragging the bar to the end lets it finish', async ({ page, request }) => {
  test.setTimeout(240_000);
  const pid = await newProject(request, host, 'Assistant honest rolled back');
  const { frame, tab } = await openNewPart(page, request, host, pid);
  await cadFrame(page).evaluate(() => (window as unknown as W).__CAD__.assistant.setPace('fast', 0));
  await addSolid(page, { size: [40, 30, 6] });
  await expect.poll(() => treeNames(page), STEP).toEqual(['Sketch 1', 'Extrude 1']);
  const tree = frame.locator('[data-cad-tree]');
  const bar = tree.locator('[data-rollback-bar]');
  const extrudeRow = tree.locator('[data-feature-row]').filter({ has: frame.locator('> .tree-row .tl', { hasText: /^Extrude 1$/ }) }).locator('> .tree-row');
  /** The person drags the rollback bar to page height `y`. */
  const dragBarTo = async (y: number) => {
    const b = (await bar.boundingBox())!;
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2, y, { steps: 8 });
    await page.mouse.up();
  };
  const paramNames = () => cadFrame(page).evaluate(() => (window as unknown as W).__CAD__.services.doc.state.get().doc.params.map((p) => p.name));
  // The person rolls back above Extrude 1.
  await dragBarTo((await extrudeRow.boundingBox())!.y + 2);
  await expect(bar).toHaveAttribute('aria-valuenow', '1', STEP);
  await expect(tree.locator('[data-feature-row][data-rolled-back]')).toHaveCount(1);
  const undo0 = await undoNow(page);

  const before = chats(host).length;
  host.fake.reply(
    { tools: [{ name: 'cad__get_model', input: { detail: 'brief', feature: '', regions: 'short' } }] },
    { tools: [{ name: 'cad__set_params', input: { set: [row('w', '40 mm')], remove: [] } }] },
    { text: 'w is set.' },
  );
  const t = await startTurn(request, host, { text: 'Add w.', tab });
  // The edit waits: the chip asks the person to move the bar, the turn's log says why, nothing changes.
  const chip = frame.locator('[data-chip="assistant"]');
  await expect(chip).toHaveAttribute('data-assistant-state', 'waiting', STEP);
  await expect(chipWords(frame)).toHaveText('Assistant waits for you: move the rollback bar to the end');
  await t.waitFor((e) => e.type === 'tool_progress' && e.label === 'Waiting for the person: the rollback bar is after Sketch 1, not at the end', 'set_params waits for the rollback bar');
  // The read before it answered, saying where the bar is.
  const [read] = resultsIn(chats(host)[before + 1]);
  expect(read).toMatchObject({ tool: 'cad__get_model', ok: true, data: { rolled_back: { after: 'Sketch 1', count: 1 }, person: 'the rollback bar is after Sketch 1, not at the end' } });
  expect(chats(host).length).toBe(before + 2);
  expect(await paramNames()).toEqual([]);
  expect(await undoNow(page)).toBe(undo0);
  await expect(tree.locator('[data-feature-row][data-rolled-back]')).toHaveCount(1);
  // The person drags the bar to the end: the edit goes on, and is one undo step of its own.
  const ex = (await extrudeRow.boundingBox())!;
  await dragBarTo(ex.y + ex.height + 4);
  await expect(bar).toHaveAttribute('aria-valuenow', '2', STEP);
  expect((await t.ended(STEP_MS * 2)).turn.state).toBe('done');
  expect(resultsIn(chats(host)[before + 2])[0]).toMatchObject({ tool: 'cad__set_params', ok: true, data: { params: [{ name: 'w', value: 40 }] } });
  expect(await paramNames()).toEqual(['w']);
  await expect(tree.locator('[data-feature-row][data-rolled-back]')).toHaveCount(0);
  expect(await undoNow(page)).toBe('Assistant: Add w.');
  await frame.locator('[data-cad-toolbar] [data-command="edit.undo"]').click();
  await expect.poll(paramNames, STEP).toEqual([]);
  await expect.poll(() => treeNames(page), STEP).toEqual(['Sketch 1', 'Extrude 1']);
});
