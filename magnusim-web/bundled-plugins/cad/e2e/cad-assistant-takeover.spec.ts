// The person always wins (CAD tools spec §8.4, §12.3 takeover 1-7, T12): what the person does while
// the Assistant makes a step, as the person sees it in the host frame and the model reads it. Each
// race is forced at a named hold point in the frame (__CAD__.assistant.hold, then release), never
// slept for:
//   1. Escape (sketch mode's own key) at sketch-step:2 of a watched sketch: the step goes, nothing
//      of it is kept (the tree, the stored model), the model gets busy taken_over (escape), the chip
//      says "Assistant paused · you took over" while the turn runs; the next turn's edit runs.
//   2. The toolbar's Extrude while the Assistant's Fillet panel is open: the person's own Extrude
//      panel opens and the Assistant's step is gone (taken_over, a command). A tree rename while the
//      Assistant draws a sketch: the sketch goes, the rename is kept and stored, and the model hears
//      what stayed (detail.kept). On an offset plane the step made first, the plane stays too (the
//      revert would undo the rename): the chip names it ("you took over · Plate sketch plane stayed").
//   3. Ctrl+Z in a sketch the Assistant draws: taken over, the sketch gone; the person's Line there
//      before it is refused with the note.
//   4. Looking is not taking over: clicks and a drag in the view at the Assistant's sketch, a click
//      on an edge at its fillet: both steps are kept as the Assistant drew them, the chip never
//      paused. At the Assistant's extrude (the S4 integration, once extrude was built): clicks on
//      the sketch's regions and a drag on the arrow keep the extrude as the Assistant asked.
//   5. A person's panel opened at after-plan, and at between-opens of a sketch on an offset plane:
//      the Assistant waits (the chip says for what), the person's panel is untouched and
//      uncommitted; once it is closed the call finishes as one undo step.
//   6. The person's Ctrl+Z between two calls of a turn: "Assistant paused · you undid its steps", the
//      next read tells the model, the next edit waits; Resume lets the turn go on.
//   7. Ask each step (the chip's toggle): Keep keeps the step, Discard reverts it (step_declined).
//      The person's Ctrl+Z while the chip asks "Hole 1 · keep it?" (no panel open; the toolbar's
//      Undo says it takes the step over) takes the whole hole back at once: no "Hole 1 sketch"
//      left in the tree or the stored model, the history as before, the model hears taken_over.
//   8. (The chip's buttons are 24 px targets with Stop set apart, its live region its words.)
//      Pause while the Assistant draws a sketch (sketch-step:2) holds it where it is: the chip
//      says paused with Resume, its read-only panel stays, nothing is stored; Resume finishes it,
//      and with Ask each step on the chip then asks, and Keep keeps it.
// The sketches are drawn at the watch pace with no delays (setPace('watch', 0)): every entity is
// its own apply, so sketch-step:2 is a sketch half drawn.
// Deviations from the spec's rows: sketch mode's ribbon has no Extrude, so row 2's Extrude takes
// over the Assistant's Fillet panel; row 4 also looks at the Assistant's sketch and fillet.
// Its own server with the Assistant's test switches and the scripted model (e2e/assistant-helpers.ts).
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type Page } from '@playwright/test';
import { addSolid, historyNames, modelOnPage, runCommand, showTreeDuringSketch, singleVolume } from './helpers';
import {
  cadFrame,
  chats,
  chipButton,
  chipWords,
  forcePace,
  holdAt,
  keyboardInFrame,
  newProject,
  openNewPart,
  reachedHold,
  readRecord,
  recordShown,
  releaseHold,
  resetAssistant,
  resultsIn,
  startAssistantHost,
  startTurn,
  STEP,
  STEP_MS,
  storedModel,
  studyOf,
  useScriptedModel,
  type AssistantHost,
} from './assistant-helpers';

let host: AssistantHost;

test.beforeAll(async ({ request }) => {
  test.setTimeout(300_000);
  host = await startAssistantHost('cad-assistant-takeover', 100);
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

type W = {
  __CAD__: {
    assistant: { setAskEach(on: boolean | null): void; waiting(): string[]; calls: { tool: string; ok: boolean; reason?: string }[] };
    services: {
      commands: { get(id: string): { hint?: string } | undefined };
      doc: { addParam(p: { name: string; expr: string; quantity: string }): unknown; assistant: { current(): unknown }; state: { get(): { doc: { features: { id: string; name: string; type: string }[]; params: { name: string }[] }; history: { undoLabel: string | null } } } };
      apis: { get(): { assistant: { actions: { setAskEach(on: boolean): void } } } };
    };
  };
};

const E = (id: string, kind: string, at: number[]) => ({ id, kind, at, construction: false });
const C = (id: string, kind: string, refs: string[], value = '') => ({ id, kind, refs, value });
/** A 60 x 40 plate centred on the origin with a hole: two entities, so sketch-step:2 is after the hole is drawn. */
const PLATE = (name: string, on = 'Top') => ({
  edit: '',
  name,
  on,
  entities: [E('r', 'center_rect', [0, 0, 60, 40]), E('h', 'circle', [10, 0, 3])],
  constraints: [C('c0', 'coincident', ['r.center', 'origin']), C('dw', 'distance', ['r.bottom'], '60 mm'), C('dh', 'distance', ['r.left'], '40 mm')],
  infer: false,
});
const sketchCall = (name: string, on = 'Top') => ({ name: 'cad__sketch', input: PLATE(name, on) });
const PARAM = (name: string, expr: string) => ({ name: 'cad__set_params', input: { set: [{ name, kind: 'length', expr, comment: '', rename_to: '' }], remove: [] } });
const HOLE = (face: string, x: string, y: string) => ({ name: 'cad__hole', input: { name: '', face, centers: [{ x, y, z: '' }], diameter: '5 mm', depth: 'through', distance: '' } });
const FILLET = (target: string) => ({ name: 'cad__modify', input: { edit: '', name: '', kind: 'fillet', targets: [target], size: '2 mm', size2: '', flip: false, inward: false } });

const names = (page: Page) => cadFrame(page).evaluate(() => (window as unknown as W).__CAD__.services.doc.state.get().doc.features.map((f) => f.name));
const params = (page: Page) => cadFrame(page).evaluate(() => (window as unknown as W).__CAD__.services.doc.state.get().doc.params.map((p) => p.name));
const undoLabel = (page: Page) => cadFrame(page).evaluate(() => (window as unknown as W).__CAD__.services.doc.state.get().history.undoLabel);
/** The model's next request has come (the n-th chat from `before`), with the result of the call before it. */
async function nthRequest(n: number, before: number) {
  await expect.poll(() => chats(host).length, { message: `the model's request ${n}`, timeout: STEP_MS * 2 }).toBeGreaterThanOrEqual(before + n);
  return chats(host)[before + n - 1];
}

test("cad:assistant-takeover-escape Escape in a sketch the Assistant draws takes it over: nothing kept, the chip says paused; the next turn's edit runs", async ({ page, request }) => {
  test.setTimeout(240_000);
  const pid = await newProject(request, host, 'Assistant takeover escape');
  const { frame, tab } = await openNewPart(page, request, host, pid);
  const sid = studyOf(page);
  await forcePace(page, 'watch', 0);
  await holdAt(page, 'sketch-step:2');
  const before = chats(host).length;
  host.fake.reply({ tools: [sketchCall('Plate sketch')] }, { hold: 'after', text: 'You took over: I stop here.' });
  const t = await startTurn(request, host, { text: 'Sketch a plate with a hole.', tab });
  await reachedHold(page, 'sketch-step:2');
  // Half drawn, read-only, the person's own sketch mode.
  const panel = frame.locator('[data-cad-panel="sketch"]');
  await expect(panel).toHaveAttribute('data-panel-owner', 'assistant', STEP);
  await keyboardInFrame(page, frame);
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0, STEP);
  await releaseHold(page, 'sketch-step:2');
  const [r] = resultsIn(await nthRequest(2, before));
  expect(r).toMatchObject({ tool: 'cad__sketch', ok: false, error: { code: 'busy', message: 'taken_over: You took over (Escape): Sketch Plate sketch was not kept.', detail: { reason: 'taken_over', why: 'escape' } } });
  // While the turn runs the Assistant is paused in this Part.
  await expect(frame.locator('[data-chip="assistant"]')).toHaveAttribute('data-assistant-state', 'paused', STEP);
  await expect(chipWords(frame)).toHaveText('Assistant paused · you took over');
  await expect(chipButton(frame, 'resume')).toBeVisible();
  // Nothing of it in the tree or in the stored model.
  await expect(historyNames(frame)).toHaveCount(0);
  await expect.poll(async () => (await storedModel(request, host, pid, sid))?.features.length ?? 0, STEP).toBe(0);
  host.fake.release('after');
  expect((await t.ended(STEP_MS * 2)).turn.state).toBe('done');
  // A new turn starts unpaused: its edit runs.
  await forcePace(page, 'fast', 0);
  const before2 = chats(host).length;
  host.fake.reply({ tools: [PARAM('a', '3 mm')] }, { text: 'a is set.' });
  const t2 = await startTurn(request, host, { text: 'Add a.', tab });
  expect((await t2.ended(STEP_MS * 2)).turn.state).toBe('done');
  expect(resultsIn(chats(host)[before2 + 1])[0]).toMatchObject({ tool: 'cad__set_params', ok: true });
  expect(await params(page)).toEqual(['a']);
});

test("cad:assistant-takeover-command the toolbar's Extrude takes over the Assistant's Fillet panel; a tree rename during its sketch is kept and stored", async ({ page, request }) => {
  test.setTimeout(240_000);
  const pid = await newProject(request, host, 'Assistant takeover command');
  const { frame, tab } = await openNewPart(page, request, host, pid);
  const sid = studyOf(page);
  await forcePace(page, 'fast', 0);
  await addSolid(page, { size: [40, 30, 10] });
  await expect(historyNames(frame)).toHaveText(['Sketch 1', 'Extrude 1'], STEP);
  // The Assistant's Fillet panel is open (after-open); the person clicks Extrude in the toolbar.
  await holdAt(page, 'after-open');
  const before = chats(host).length;
  host.fake.reply({ tools: [FILLET('Extrude 1.end')] }, { text: 'You took over.' });
  const t = await startTurn(request, host, { text: 'Round the top edges.', tab });
  await reachedHold(page, 'after-open');
  const panel = frame.locator('[data-cad-panel]');
  await expect(panel).toHaveAttribute('data-panel-owner', 'assistant', STEP);
  await runCommand(frame, 'solid.extrude');
  // The person's own new Extrude panel (no owner mark), and the Assistant's Fillet is gone.
  await expect(panel).not.toHaveAttribute('data-panel-owner', /.+/, STEP);
  await expect(panel.locator('[data-panel-title]')).toHaveText('Extrude 2');
  await releaseHold(page, 'after-open');
  expect((await t.ended(STEP_MS * 2)).turn.state).toBe('done');
  const [r] = resultsIn(chats(host)[before + 1]);
  expect(r).toMatchObject({ tool: 'cad__modify', ok: false, error: { code: 'busy', message: expect.stringMatching(/^taken_over: You took over \(a command\): .+ was not kept\.$/), detail: { reason: 'taken_over', why: 'command' } } });
  expect(await names(page)).toEqual(['Sketch 1', 'Extrude 1']);
  // The person undoes their own new Extrude (the toolbar's Undo on a new feature's panel).
  await frame.locator('[data-cad-toolbar] [data-command="edit.undo"]').click();
  await expect(panel).toHaveCount(0, STEP);
  await expect(historyNames(frame)).toHaveText(['Sketch 1', 'Extrude 1'], STEP);

  // A rename in the tree while the Assistant draws a sketch: the sketch goes, the rename stays.
  await forcePace(page, 'watch', 0);
  await holdAt(page, 'sketch-step:2');
  const before2 = chats(host).length;
  host.fake.reply({ tools: [sketchCall('Plate sketch')] }, { text: 'The person renamed a feature while I drew.' });
  const t2 = await startTurn(request, host, { text: 'Sketch a plate.', tab });
  await reachedHold(page, 'sketch-step:2');
  await showTreeDuringSketch(frame);
  await frame.locator('[data-cad-tree] [data-feature-row]').filter({ has: frame.locator('> .tree-row .tl', { hasText: /^Extrude 1$/ }) }).locator('> .tree-row').click();
  await page.keyboard.press('F2');
  const input = frame.locator('[data-cad-tree] [data-feature-row] input');
  await expect(input).toHaveValue('Extrude 1', STEP);
  await input.fill('Base');
  await input.press('Enter');
  await expect(frame.locator('[data-cad-panel="sketch"]')).toHaveCount(0, STEP);
  await releaseHold(page, 'sketch-step:2');
  expect((await t2.ended(STEP_MS * 2)).turn.state).toBe('done');
  const [r2] = resultsIn(chats(host)[before2 + 1]);
  expect(r2).toMatchObject({ tool: 'cad__sketch', ok: false, error: { code: 'busy', detail: { reason: 'taken_over', why: 'command', kept: ['renamed Extrude 1 to Base'] } } });
  await expect(historyNames(frame)).toHaveText(['Sketch 1', 'Base'], STEP);
  await expect.poll(async () => (await storedModel(request, host, pid, sid))?.features.map((f) => f.name), STEP).toEqual(['Sketch 1', 'Base']);
});

test("cad:assistant-takeover-command-plane a tree rename while the Assistant draws on its own offset plane: the sketch goes, the plane and the rename stay, and the chip names the plane", async ({ page, request }) => {
  test.setTimeout(240_000);
  const pid = await newProject(request, host, 'Assistant takeover plane');
  const { frame, tab } = await openNewPart(page, request, host, pid);
  const sid = studyOf(page);
  await forcePace(page, 'fast', 0);
  await addSolid(page, { size: [40, 30, 10] });
  await expect(historyNames(frame)).toHaveText(['Sketch 1', 'Extrude 1'], STEP);
  await forcePace(page, 'watch', 0);
  await holdAt(page, 'sketch-step:2');
  const before = chats(host).length;
  host.fake.reply({ tools: [sketchCall('Plate sketch', 'Top offset 20 mm')] }, { hold: 'plane-stayed', text: 'The person renamed a feature while I drew.' });
  const t = await startTurn(request, host, { text: 'Sketch a plate above the block.', tab });
  await reachedHold(page, 'sketch-step:2');
  await showTreeDuringSketch(frame);
  await frame.locator('[data-cad-tree] [data-feature-row]').filter({ has: frame.locator('> .tree-row .tl', { hasText: /^Extrude 1$/ }) }).locator('> .tree-row').click();
  await page.keyboard.press('F2');
  const input = frame.locator('[data-cad-tree] [data-feature-row] input');
  await expect(input).toHaveValue('Extrude 1', STEP);
  await input.fill('Base');
  await input.press('Enter');
  await expect(frame.locator('[data-cad-panel="sketch"]')).toHaveCount(0, STEP);
  await releaseHold(page, 'sketch-step:2');
  const [r] = resultsIn(await nthRequest(2, before));
  expect(r).toMatchObject({ tool: 'cad__sketch', ok: false, error: { code: 'busy', detail: { reason: 'taken_over', why: 'command', kept: expect.arrayContaining(['renamed Extrude 1 to Base', 'added Plate sketch plane (ref_plane)']) } } });
  // What the person sees: the plane stayed beside their rename, and the chip says so.
  await expect(historyNames(frame)).toHaveText(['Sketch 1', 'Base', 'Plate sketch plane'], STEP);
  await expect(chipWords(frame)).toHaveText('Assistant paused · you took over · Plate sketch plane stayed', STEP);
  host.fake.release('plane-stayed');
  expect((await t.ended(STEP_MS * 2)).turn.state).toBe('done');
  await expect.poll(async () => (await storedModel(request, host, pid, sid))?.features.map((f) => f.name), STEP).toEqual(['Sketch 1', 'Base', 'Plate sketch plane']);
});

test("cad:assistant-takeover-undo Ctrl+Z in a sketch the Assistant draws takes it over; the person's Line there is refused with the note", async ({ page, request }) => {
  test.setTimeout(240_000);
  const pid = await newProject(request, host, 'Assistant takeover undo');
  const { frame, tab } = await openNewPart(page, request, host, pid);
  await forcePace(page, 'watch', 0);
  await holdAt(page, 'sketch-step:2');
  const before = chats(host).length;
  host.fake.reply({ tools: [sketchCall('Plate sketch')] }, { text: 'You took over.' });
  const t = await startTurn(request, host, { text: 'Sketch a plate.', tab });
  await reachedHold(page, 'sketch-step:2');
  const panel = frame.locator('[data-cad-panel="sketch"]');
  await expect(panel).toHaveAttribute('data-panel-owner', 'assistant', STEP);
  // The person's Line: refused with the note in the panel's foot; nothing taken over.
  await frame.locator('[data-cad-toolbar] [data-command="sketch.line"]').click();
  await expect(panel.locator('[data-run-reason]')).toContainText('The Assistant is drawing this sketch · Esc takes over', STEP);
  await expect(panel).toHaveAttribute('data-panel-owner', 'assistant');
  // Ctrl+Z takes it over.
  await keyboardInFrame(page, frame);
  await page.keyboard.press('Control+z');
  await expect(panel).toHaveCount(0, STEP);
  await releaseHold(page, 'sketch-step:2');
  expect((await t.ended(STEP_MS * 2)).turn.state).toBe('done');
  expect(resultsIn(chats(host)[before + 1])[0]).toMatchObject({ tool: 'cad__sketch', ok: false, error: { code: 'busy', detail: { reason: 'taken_over', why: 'undo' } } });
  await expect(historyNames(frame)).toHaveCount(0);
});

test('cad:assistant-takeover-looking clicks and a drag in the view, and a click on an edge, take nothing over: both steps are kept as drawn', async ({ page, request }) => {
  test.setTimeout(240_000);
  const pid = await newProject(request, host, 'Assistant takeover looking');
  const { frame, tab } = await openNewPart(page, request, host, pid);
  await forcePace(page, 'fast', 0);
  await addSolid(page, { size: [40, 30, 10] });
  await recordShown(page, 'chip', '[data-chip="assistant"]', 'data-assistant-state');
  await forcePace(page, 'watch', 0);
  await holdAt(page, 'sketch-step:2');
  const before = chats(host).length;
  host.fake.reply({ tools: [sketchCall('Plate sketch', 'Front')] }, { hold: 'mid', tools: [FILLET('Extrude 1.end')] }, { text: 'Both are made.' });
  const t = await startTurn(request, host, { text: 'A plate sketch, then round the top.', tab });
  // Half way through the sketch: a click on the view and a drag across it.
  await reachedHold(page, 'sketch-step:2');
  const box = (await frame.locator('[data-cad-viewport] canvas').boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2 + 40, { steps: 6 });
  await page.mouse.up();
  await expect(frame.locator('[data-cad-panel="sketch"]')).toHaveAttribute('data-panel-owner', 'assistant');
  await releaseHold(page, 'sketch-step:2');
  // The sketch is kept; the model's next answer (the fillet) is held until its hold point is set.
  await nthRequest(2, before);
  await holdAt(page, 'before-commit');
  host.fake.release('mid');
  // At the fillet's before-commit: a click on one of the block's top edges.
  await reachedHold(page, 'before-commit');
  const edge = await modelOnPage(page, [20, 0, 10]);
  await page.mouse.click(edge[0], edge[1]);
  await expect(frame.locator('[data-cad-panel]')).toHaveAttribute('data-panel-owner', 'assistant');
  await releaseHold(page, 'before-commit');
  expect((await t.ended(STEP_MS * 3)).turn.state).toBe('done');
  const [sketched] = resultsIn(chats(host)[before + 1]);
  const [rounded] = resultsIn(chats(host)[before + 2]);
  expect(sketched).toMatchObject({ tool: 'cad__sketch', ok: true });
  expect(rounded).toMatchObject({ tool: 'cad__modify', ok: true });
  // (The plate's hole has no dimensions: the sketch is under-defined, "(-)".)
  await expect(historyNames(frame)).toHaveText(['Sketch 1', 'Extrude 1', '(-) Plate sketch', 'Fillet 1'], STEP);
  // The fillet is the Assistant's (the top face it was asked for), not the clicked edge.
  const fillet = await cadFrame(page).evaluate(() => {
    const f = (window as unknown as W).__CAD__.services.doc.state.get().doc.features.find((x) => x.type === 'fillet') as unknown as { faces: unknown[]; edges: unknown[] };
    return { faces: f.faces.length, edges: f.edges.length };
  });
  expect(fillet).toEqual({ faces: 1, edges: 0 });
  expect(await readRecord(page, 'chip')).not.toContain('paused');
});

/** The plate (PLATE, its hole beside the centre) extruded 5 mm: its even-odd region, the plate less the hole. */
const EXTRUDE_PLATE = { name: 'cad__extrude', input: { edit: '', name: 'Plate', sketch: 'Plate sketch', regions: ['all'], extent: 'blind', distance: '5 mm', distance2: '', to: '', flip: false, op: 'new', bodies: [], body_name: '', color: '' } };

test("cad:assistant-takeover-looking-extrude clicks on the sketch's regions and a drag on the arrow, at the Assistant's extrude, take nothing over: it is kept as asked", async ({ page, request }) => {
  test.setTimeout(240_000);
  const pid = await newProject(request, host, 'Assistant takeover looking extrude');
  const { frame, tab } = await openNewPart(page, request, host, pid);
  await forcePace(page, 'fast', 0);
  await recordShown(page, 'chip', '[data-chip="assistant"]', 'data-assistant-state');
  const before = chats(host).length;
  host.fake.reply({ tools: [sketchCall('Plate sketch')] }, { hold: 'mid-extrude', tools: [EXTRUDE_PLATE] }, { text: 'The plate is made.' });
  const t = await startTurn(request, host, { text: 'A plate with a hole.', tab });
  // The sketch is made; the extrude is held until its hold point is set.
  await nthRequest(2, before);
  await holdAt(page, 'before-commit');
  host.fake.release('mid-extrude');
  await reachedHold(page, 'before-commit');
  await expect(frame.locator('[data-cad-panel="feature"]')).toHaveAttribute('data-panel-owner', 'assistant');
  // In the person's own Extrude panel a click on a region adds or drops it: a click in the hole,
  // a click on the plate, then a drag up from the arrow at the extrude's end.
  for (const at of [[10, 0, 0], [-20, 10, 0]] as [number, number, number][]) {
    const xy = await modelOnPage(page, at);
    await page.mouse.click(xy[0], xy[1]);
  }
  const arrow = await modelOnPage(page, [0, 0, 5]);
  await page.mouse.move(arrow[0], arrow[1]);
  await page.mouse.down();
  await page.mouse.move(arrow[0], arrow[1] - 80, { steps: 6 });
  await page.mouse.up();
  await expect(frame.locator('[data-cad-panel="feature"]')).toHaveAttribute('data-panel-owner', 'assistant');
  await releaseHold(page, 'before-commit');
  expect((await t.ended(STEP_MS * 3)).turn.state).toBe('done');
  const [made] = resultsIn(chats(host)[before + 2]);
  expect(made).toMatchObject({ tool: 'cad__extrude', ok: true, data: { feature: { name: 'Plate', type: 'extrude', state: 'ok' }, broke: [] } });
  // (The plate's hole has no dimensions: the sketch is under-defined, "(-)".)
  await expect(historyNames(frame)).toHaveText(['(-) Plate sketch', 'Plate'], STEP);
  // The extrude is the Assistant's: 5 mm of the plate less its hole.
  const ext = await cadFrame(page).evaluate(() => {
    const f = (window as unknown as W).__CAD__.services.doc.state.get().doc.features.find((x) => x.type === 'extrude') as unknown as { extent: { kind: string; distance: string }; profiles: unknown[] };
    return { kind: f.extent.kind, distance: f.extent.distance, profiles: f.profiles.length };
  });
  expect(ext).toEqual({ kind: 'blind', distance: '5 mm', profiles: 1 });
  await expect.poll(async () => Math.abs((await singleVolume(frame)) - (60 * 40 * 5 - Math.PI * 9 * 5)), STEP).toBeLessThan(0.5);
  expect(await readRecord(page, 'chip')).not.toContain('paused');
  expect(await undoLabel(page)).toBe('Assistant: A plate with a hole.');
});

test("cad:assistant-takeover-person-panel a person's panel opened at after-plan, and at between-opens, is waited for, untouched and uncommitted; then the call finishes as one step", async ({ page, request }) => {
  test.setTimeout(240_000);
  const pid = await newProject(request, host, 'Assistant takeover person panel');
  const { frame, tab } = await openNewPart(page, request, host, pid);
  await forcePace(page, 'fast', 0);
  await addSolid(page, { size: [40, 30, 10] });
  const chip = frame.locator('[data-chip="assistant"]');
  const panel = frame.locator('[data-cad-panel]');
  const extrudeRow = frame.locator('[data-cad-tree] [data-feature-row]').filter({ has: frame.locator('> .tree-row .tl', { hasText: /^Extrude 1$/ }) }).locator('> .tree-row');
  /** The person opens Extrude 1 and types a new distance (live, not committed). */
  const personEdits = async () => {
    await extrudeRow.dblclick();
    await expect(panel.locator('[data-panel-title]')).toHaveText('Extrude 1', STEP);
    await expect(panel).not.toHaveAttribute('data-panel-owner', /.+/);
    const dist = panel.locator('.nui[data-field="distance"] input');
    await dist.fill(String(depth));
    await dist.press('Enter');
  };
  const distance = () => cadFrame(page).evaluate(() => ((window as unknown as W).__CAD__.services.doc.state.get().doc.features.find((f) => f.name === 'Extrude 1') as unknown as { extent: { distance: string } }).extent.distance);
  let depth = 10;
  for (const point of ['after-plan', 'between-opens']) {
    depth += 4;
    const label0 = await undoLabel(page);
    await holdAt(page, point);
    const before = chats(host).length;
    host.fake.reply({ tools: [sketchCall(`Offset ${point}`, 'Top offset 25 mm')] }, { text: 'The sketch is made.' });
    const t = await startTurn(request, host, { text: `Sketch above the block (${point}).`, tab });
    await reachedHold(page, point);
    await personEdits();
    await releaseHold(page, point);
    // The Assistant waits for the person; their panel stays theirs, uncommitted.
    await expect(chip).toHaveAttribute('data-assistant-state', 'waiting', STEP);
    await expect(chipWords(frame)).toHaveText('Assistant waits for you: close the Extrude 1 panel');
    await expect(panel.locator('.nui[data-field="distance"] input')).toHaveValue(String(depth));
    // Uncommitted: no new undo step, and nothing of the Assistant's in the Part while it waits.
    expect(await undoLabel(page)).toBe(label0);
    expect(await names(page)).toEqual(['Sketch 1', 'Extrude 1']);
    // The person closes it (Escape keeps what they typed, as their own step); the call goes on and
    // finishes as one undo step of its own on top.
    await panel.locator('[data-panel-title]').click();
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0, STEP);
    expect((await t.ended(STEP_MS * 2)).turn.state).toBe('done');
    expect(resultsIn(chats(host)[before + 1])[0]).toMatchObject({ tool: 'cad__sketch', ok: true });
    expect(await names(page)).toEqual(['Sketch 1', 'Extrude 1', `Offset ${point} plane`, `Offset ${point}`]);
    expect(await distance()).toBe(`${depth} mm`);
    expect(await undoLabel(page)).toBe(`Assistant: Sketch above the block (${point}).`);
    await frame.locator('[data-cad-toolbar] [data-command="edit.undo"]').click();
    await expect(historyNames(frame)).toHaveText(['Sketch 1', 'Extrude 1'], STEP);
    // The person's own change stays.
    expect(await distance()).toBe(`${depth} mm`);
  }
});

test("cad:assistant-takeover-person-undo the person's Ctrl+Z between two calls pauses the Assistant: the next read tells the model, the edit waits; Resume goes on", async ({ page, request }) => {
  test.setTimeout(240_000);
  const pid = await newProject(request, host, 'Assistant takeover person undo');
  const { frame, tab } = await openNewPart(page, request, host, pid);
  await forcePace(page, 'fast', 0);
  const before = chats(host).length;
  host.fake.reply({ tools: [PARAM('a', '3 mm')] }, { hold: 'between', tools: [{ name: 'cad__get_model', input: { detail: 'brief', feature: '' } }] }, { tools: [PARAM('b', '4 mm')] }, { text: 'b is set.' });
  const t = await startTurn(request, host, { text: 'Add a, then b.', tab });
  await nthRequest(2, before);
  expect(await params(page)).toEqual(['a']);
  // The person undoes the Assistant's step.
  await keyboardInFrame(page, frame);
  await page.keyboard.press('Control+z');
  await expect.poll(() => params(page), STEP).toEqual([]);
  await expect(frame.locator('[data-chip="assistant"]')).toHaveAttribute('data-assistant-state', 'paused', STEP);
  await expect(chipWords(frame)).toHaveText('Assistant paused · you undid its steps');
  host.fake.release('between');
  // The read answers, and tells the model what the person did; the edit then waits.
  const [read] = resultsIn(await nthRequest(3, before));
  expect(read).toMatchObject({ tool: 'cad__get_model', ok: true, data: { user_changes: expect.arrayContaining(['the person undid your steps (Assistant: Add a, then b.); do not redo them unless asked']) } });
  await expect.poll(() => cadFrame(page).evaluate(() => (window as unknown as W).__CAD__.assistant.calls.length), STEP).toBeGreaterThanOrEqual(2);
  await expect(frame.locator('[data-chip="assistant"]')).toHaveAttribute('data-assistant-state', 'paused');
  expect(await params(page)).toEqual([]);
  // Resume: the edit runs and the turn goes on.
  await chipButton(frame, 'resume').click();
  expect((await t.ended(STEP_MS * 2)).turn.state).toBe('done');
  expect(resultsIn(chats(host)[before + 3])[0]).toMatchObject({ tool: 'cad__set_params', ok: true });
  expect(await params(page)).toEqual(['b']);
});

test('cad:assistant-takeover-ask-each Ask each step: Keep keeps the step, Discard reverts it and the model hears step_declined', async ({ page, request }) => {
  test.setTimeout(240_000);
  const pid = await newProject(request, host, 'Assistant ask each step');
  const { frame, tab } = await openNewPart(page, request, host, pid);
  await forcePace(page, 'fast', 0);
  const chip = frame.locator('[data-chip="assistant"]');
  const before = chats(host).length;
  host.fake.reply({ hold: 'think', tools: [PARAM('a', '3 mm')] }, { tools: [PARAM('b', '4 mm')] }, { text: 'a is kept, b was declined.' });
  const t = await startTurn(request, host, { text: 'Add a and b.', tab });
  // While the model thinks, the person turns Ask each step on (the chip's toggle).
  await expect(chip).toHaveAttribute('data-assistant-state', 'thinking', STEP);
  await chipButton(frame, 'ask').click();
  await expect(chipButton(frame, 'ask')).toHaveAttribute('aria-pressed', 'true');
  try {
    host.fake.release('think');
    // a: the step waits for the person, with the change in the Part.
    await expect(chip).toHaveAttribute('data-assistant-state', 'approve', STEP);
    await expect(chipWords(frame)).toHaveText('Assistant: Parameters · keep it?');
    expect(await params(page)).toEqual(['a']);
    await chipButton(frame, 'keep').click();
    // b: Discard.
    await expect.poll(() => params(page), STEP).toEqual(['a', 'b']);
    await expect(chip).toHaveAttribute('data-assistant-state', 'approve', STEP);
    await chipButton(frame, 'discard').click();
    expect((await t.ended(STEP_MS * 2)).turn.state).toBe('done');
    expect(await params(page)).toEqual(['a']);
    expect(resultsIn(chats(host)[before + 1])[0]).toMatchObject({ tool: 'cad__set_params', ok: true });
    expect(resultsIn(chats(host)[before + 2])[0]).toMatchObject({
      tool: 'cad__set_params',
      ok: false,
      error: { code: 'busy', message: 'step_declined: The person declined this step: Parameters was not kept.', hint: 'The person declined this step: ask what to change.', detail: { reason: 'step_declined', why: 'discard' } },
    });
  } finally {
    // The person's choice is kept in the app's preferences: off again for the other tests.
    await cadFrame(page).evaluate(() => (window as unknown as W).__CAD__.services.apis.get().assistant.actions.setAskEach(false));
  }
});

test('cad:assistant-takeover-ask-each-undo Ctrl+Z while the chip asks to keep a hole takes all of it back: no hole sketch left in the tree or the stored model', async ({ page, request }) => {
  test.setTimeout(240_000);
  const pid = await newProject(request, host, 'Assistant ask each undo');
  const { frame, tab } = await openNewPart(page, request, host, pid);
  const sid = studyOf(page);
  await forcePace(page, 'fast', 0);
  await addSolid(page, { size: [40, 30, 10] });
  await expect(historyNames(frame)).toHaveText(['Sketch 1', 'Extrude 1'], STEP);
  await expect.poll(async () => (await storedModel(request, host, pid, sid))?.features.map((f) => f.name), STEP).toEqual(['Sketch 1', 'Extrude 1']);
  const label = await undoLabel(page);
  const chip = frame.locator('[data-chip="assistant"]');
  await cadFrame(page).evaluate(() => (window as unknown as W).__CAD__.assistant.setAskEach(true));
  try {
    const before = chats(host).length;
    host.fake.reply({ tools: [HOLE('Extrude 1.end', '20 mm', '15 mm')] }, { hold: 'undone', text: 'You took it back.' });
    const t = await startTurn(request, host, { text: 'Drill a hole in the middle.', tab });
    // The hole is made (its sketch and its cut), and the chip asks; no panel is open.
    await expect(chip).toHaveAttribute('data-assistant-state', 'approve', STEP);
    await expect(chipWords(frame)).toHaveText('Assistant: Hole 1 · keep it?');
    await expect(historyNames(frame)).toHaveText(['Sketch 1', 'Extrude 1', 'Hole 1 sketch', 'Hole 1'], STEP);
    await expect(frame.locator('[data-cad-panel]')).toHaveCount(0);
    expect(await cadFrame(page).evaluate(() => (window as unknown as W).__CAD__.services.commands.get('edit.undo')?.hint)).toBe('Take over from the Assistant: its step is discarded (nothing else is undone)');
    // One Ctrl+Z: every piece of the step goes at once.
    await keyboardInFrame(page, frame);
    await page.keyboard.press('Control+z');
    await expect(historyNames(frame)).toHaveText(['Sketch 1', 'Extrude 1'], STEP);
    await expect(chip).toHaveAttribute('data-assistant-state', 'paused', STEP);
    await expect(chipWords(frame)).toHaveText('Assistant paused · you took over');
    const [r] = resultsIn(await nthRequest(2, before));
    host.fake.release('undone');
    expect((await t.ended(STEP_MS * 2)).turn.state).toBe('done');
    expect(r).toMatchObject({ tool: 'cad__hole', ok: false, error: { code: 'busy', message: 'taken_over: You took over (Undo): Hole 1 was not kept.', detail: { reason: 'taken_over', why: 'undo' } } });
    expect((r as { error: { detail: Record<string, unknown> } }).error.detail.kept).toBeUndefined();
    // Nothing of it stays: the tree, the history and the stored model are as before the request.
    await expect(historyNames(frame)).toHaveText(['Sketch 1', 'Extrude 1']);
    expect(await undoLabel(page)).toBe(label);
    await expect.poll(async () => (await storedModel(request, host, pid, sid))?.features.map((f) => f.name), STEP).toEqual(['Sketch 1', 'Extrude 1']);
  } finally {
    await cadFrame(page).evaluate(() => (window as unknown as W).__CAD__.assistant.setAskEach(null));
  }
});

test('cad:assistant-takeover-pause-mid-step Pause while the Assistant draws a sketch holds it where it is; Resume finishes it, then Ask each step asks', async ({ page, request }) => {
  test.setTimeout(240_000);
  const pid = await newProject(request, host, 'Assistant pause mid step');
  const { frame, tab } = await openNewPart(page, request, host, pid);
  const sid = studyOf(page);
  await forcePace(page, 'watch', 0);
  const chip = frame.locator('[data-chip="assistant"]');
  await cadFrame(page).evaluate(() => (window as unknown as W).__CAD__.assistant.setAskEach(true));
  try {
    await holdAt(page, 'sketch-step:2');
    host.fake.reply({ tools: [sketchCall('Plate sketch')] }, { hold: 'paused-mid', text: 'The plate sketch is kept.' });
    const t = await startTurn(request, host, { text: 'Sketch a plate with a hole.', tab });
    await reachedHold(page, 'sketch-step:2');
    const panel = frame.locator('[data-cad-panel="sketch"]');
    await expect(panel).toHaveAttribute('data-panel-owner', 'assistant', STEP);
    // The chip's buttons are 24 px targets, Stop set apart from Pause; its live region is its words alone.
    const pause = (await chipButton(frame, 'pause').boundingBox())!;
    const stop = (await chipButton(frame, 'stop').boundingBox())!;
    expect(pause.height).toBeGreaterThanOrEqual(24);
    expect(stop.height).toBeGreaterThanOrEqual(24);
    expect(stop.x - (pause.x + pause.width), 'Stop set apart from Pause').toBeGreaterThanOrEqual(12);
    await expect(chip.locator('[role="status"]')).toHaveCount(1);
    await expect(chip.locator('[role="status"] button')).toHaveCount(0);
    await chipButton(frame, 'pause').click();
    await expect(chip).toHaveAttribute('data-assistant-state', 'paused', STEP);
    await releaseHold(page, 'sketch-step:2');
    // Held where it is: the chip says paused with Resume, its panel stays, nothing is stored.
    await expect.poll(() => cadFrame(page).evaluate(() => (window as unknown as W).__CAD__.assistant.waiting().length), STEP).toBe(0);
    await expect(chipWords(frame)).toHaveText('Assistant paused');
    await expect(chipButton(frame, 'resume')).toBeVisible();
    await expect(panel).toHaveAttribute('data-panel-owner', 'assistant');
    expect(await cadFrame(page).evaluate(() => (window as unknown as W).__CAD__.services.doc.assistant.current() !== null)).toBe(true);
    expect((await storedModel(request, host, pid, sid))?.features.length ?? 0).toBe(0);
    await expect(chip).toHaveAttribute('data-assistant-state', 'paused');
    // Resume: the sketch is finished, then the chip asks; Keep keeps it.
    await chipButton(frame, 'resume').click();
    await expect(chip).toHaveAttribute('data-assistant-state', 'approve', STEP);
    await expect(chipWords(frame)).toHaveText('Assistant: Sketch Plate sketch · keep it?');
    await chipButton(frame, 'keep').click();
    host.fake.release('paused-mid');
    expect((await t.ended(STEP_MS * 2)).turn.state).toBe('done');
    // Kept as drawn (its hole circle has no dimension: under-defined).
    await expect(historyNames(frame)).toHaveText(['(-) Plate sketch'], STEP);
    await expect.poll(async () => (await storedModel(request, host, pid, sid))?.features.map((f) => f.name), STEP).toEqual(['Plate sketch']);
  } finally {
    await cadFrame(page).evaluate(() => (window as unknown as W).__CAD__.assistant.setAskEach(null));
  }
});
