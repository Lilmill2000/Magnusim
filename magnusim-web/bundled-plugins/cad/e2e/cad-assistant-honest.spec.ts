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
// features?", its copy saying Ctrl+Z brings them back, Don't focused): Enter answers Don't, the
// model gets declined and the Part never hears the call; a click on Allow deletes the feature the
// tree shows, and one Ctrl+Z brings it back.
// Its own server with the Assistant's test switches and the scripted model (e2e/assistant-helpers.ts).
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type Page } from '@playwright/test';
import { addSolid, historyNames, runCommand } from './helpers';
import { cadFrame, chats, newProject, openNewPart, readRecord, recordShown, resetAssistant, resultsIn, startAssistantHost, startTurn, STEP, STEP_MS, useScriptedModel, type AssistantHost } from './assistant-helpers';

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
  await expect(chip).toHaveText('Assistant: Make the fillet 10 mm, and add a and b. · done');
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
  // The app's own question, over the whole window (not the Part's frame).
  const dialog = page.locator('#modal-confirm');

  // Don't (Enter, the focused answer): the model hears declined, the Part never hears the call.
  const before = chats(host).length;
  host.fake.reply({ tools: [{ name: 'cad__delete', input: { features: ['Extrude 1'] } }] }, { text: 'The extrude stays.' });
  const t1 = await startTurn(request, host, { text: 'Delete the extrude.', tab });
  await expect(dialog).toBeVisible(STEP);
  await expect(page.locator('#cf-heading')).toHaveText('Allow the Assistant to delete features?');
  await expect(page.locator('#cf-copy')).toContainText('Deletes features from the Part; Ctrl+Z brings them back.');
  await expect(page.locator('#cf-copy')).toContainText('What it sent: {"features":["Extrude 1"]}. Nothing runs until you choose.');
  await expect(page.locator('#cf-confirm')).toHaveText('Allow');
  await expect(page.locator('#cf-cancel')).toHaveText("Don't");
  await expect(page.locator('#cf-cancel')).toBeFocused();
  // Nothing happened yet: the feature is still in the tree while the question is open.
  await expect(rows).toHaveText(['Sketch 1', 'Extrude 1']);
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden(STEP);
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
  await expect(page.locator('#cf-cancel')).toBeFocused();
  await page.locator('#cf-confirm').click();
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
const PATTERN = (o: Record<string, unknown>) => ({ edit: '', name: '', kind: 'linear', of: 'bodies', items: [], about: 'X axis', count: '', spacing: '', symmetric: false, flip: false, about2: '', count2: '', spacing2: '', flip2: false, op: 'new', bodies: [], ...o });

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
