// The Assistant does what the person's direct-edit and Construct panels do (the owner's rule:
// anything a person can do in CAD, the Assistant can do through its tools), as the person sees it:
// on the person's 40 x 30 x 6 plate, a scripted turn press-pulls its top face 4 mm (the volume chip
// adds up to 12000 mm3 from 7200 and the tree shows Press-pull 1, built), makes a construction axis
// where Top and Right cross (the tree shows Axis 1, a construction feature, built), and splits the
// body by Right moved 10 mm (the tree shows Split 1 and the bodies Body 1 and Body 1 (2)). Each call
// answers ok with what it made. A split by a body that is also a target is refused before anything
// changes. One Undo, named for the request, takes all three away.
// Move/copy body, as the person sees it: the scripted model copies the person's block 30 mm along Y
// (direct, kind move_body, copy true): the tree shows Body-Copy 1 built and the bodies Body 1 and
// Body 1 (Copy), and the dock's step names the copy and where it is (the middle of its box).
// The assembly check, as the person sees it in the Assistant's dock: the scripted model builds a
// shaft (a head and a rod) and a wheel resting on its head with nothing above it, and checks the
// stack: the dock's check step says one part can slide along its shaft and names the wheel (+Z);
// after the model presses a collar on above the wheel and checks again, the step says nothing is
// loose.
// Its own server with the Assistant's test switches and the scripted model (e2e/assistant-helpers.ts).
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type Page } from '@playwright/test';
// @ts-expect-error the app's helpers are plain JavaScript (the suite's tsconfig has no allowJs)
import * as core from '../../../e2e/support/assistant.js';
import { addSolid } from './helpers';
import { cadFrame, chats, newProject, openNewPart, resetAssistant, resultsIn, startAssistantHost, startTurn, STEP, STEP_MS, useScriptedModel, type AssistantHost } from './assistant-helpers';

let host: AssistantHost;

test.beforeAll(async ({ request }) => {
  test.setTimeout(300_000);
  host = await startAssistantHost('cad-assistant-features', 110);
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

type W = { __CAD__: { services: { doc: { state: { get(): { history: { undoLabel: string | null } } } } }; assistant: { setPace(p: string | null, scale?: number | null): void } } };

const DIRECT = (o: Record<string, unknown>) => ({ edit: '', name: '', kind: 'press_pull', faces: [], distance: '', bodies: [], tool: '', keep_tool: false, move: [], turn: { angle: '', axis: '', pivot: [] }, copy: false, shape: 'box', padding: 'zero', sides: [], ...o });
const CONSTRUCT = (o: Record<string, unknown>) => ({ edit: '', name: '', method: 'offset', refs: [], value: '', xyz: [], flip: false, from_end: false, ...o });

/** The tree's feature rows as the person reads them: name, type and state. */
const treeRows = (page: Page) =>
  cadFrame(page).evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('[data-cad-tree] [data-feature-row]'), (e) => `${e.querySelector('.tree-row .tl')?.textContent ?? ''} ${e.dataset.featureType ?? ''} ${e.dataset.state ?? ''}`));
/** The tree's body rows by name. */
const bodyRows = (page: Page) => cadFrame(page).evaluate(() => Array.from(document.querySelectorAll('[data-cad-tree] [data-body-row] .cad-body-name'), (e) => e.textContent ?? ''));

test('cad:assistant-features press-pull, a construction axis and a split, as the person sees them; a bad split changes nothing; one Undo takes all', async ({ page, request }) => {
  test.setTimeout(240_000);
  const pid = await newProject(request, host, 'Assistant features');
  const { frame, tab } = await openNewPart(page, request, host, pid);
  await cadFrame(page).evaluate(() => (window as unknown as W).__CAD__.assistant.setPace('fast', 0));
  await addSolid(page, { size: [40, 30, 6] });
  // The volume chip's bodies, added up (one entry per body once the split makes two).
  const mm3 = () => cadFrame(page).evaluate(() => Math.round(Array.from(document.querySelectorAll('[data-chip="volume"] [data-volume-mm3]'), (e) => Number(e.getAttribute('data-volume-mm3'))).reduce((a, b) => a + b, 0)));
  await expect.poll(mm3, STEP).toBe(7200);
  await expect.poll(() => treeRows(page), STEP).toEqual(['Sketch 1 sketch ok', 'Extrude 1 extrude ok']);
  const label = () => cadFrame(page).evaluate(() => (window as unknown as W).__CAD__.services.doc.state.get().history.undoLabel);
  const undoBefore = await label();

  const before = chats(host).length;
  host.fake.reply(
    { tools: [{ name: 'cad__direct', input: DIRECT({ faces: ['Extrude 1.end'], distance: '4 mm' }) }] },
    { tools: [{ name: 'cad__construct', input: CONSTRUCT({ method: 'two_planes', refs: ['Top', 'Right'] }) }] },
    { tools: [{ name: 'cad__direct', input: DIRECT({ kind: 'split', bodies: ['Body 1'], tool: 'Right', distance: '10 mm' }) }] },
    { tools: [{ name: 'cad__direct', input: DIRECT({ kind: 'split', bodies: ['Body 1'], tool: 'Body 1' }) }] },
    { text: 'The plate is 10 mm thick, with an axis where Top and Right cross, split at x = 10 mm.' },
  );
  const t = await startTurn(request, host, { text: 'Make the plate 10 mm thick, add an axis and split it at x 10.', tab });
  expect((await t.ended(STEP_MS * 4)).turn.state).toBe('done');
  const [, afterPull, afterAxis, afterSplit, afterBad] = chats(host).slice(before);
  expect(resultsIn(afterPull)[0]).toMatchObject({ tool: 'cad__direct', ok: true, data: { feature: { name: 'Press-pull 1', type: 'press_pull', state: 'ok' } } });
  expect(resultsIn(afterAxis)[0]).toMatchObject({ tool: 'cad__construct', ok: true, data: { feature: { name: 'Axis 1', type: 'ref_axis', state: 'ok' }, built: { origin_mm: [0, 0, 0] } } });
  expect(resultsIn(afterAxis)[0].text).toMatch(/^Axis 1 ok: construction axis by two_planes through \(0, 0, 0\), along \(0, -?1, 0\)$/);
  expect(resultsIn(afterSplit)[0]).toMatchObject({ tool: 'cad__direct', ok: true, data: { feature: { name: 'Split 1', type: 'split', state: 'ok' }, resolved: { tool: 'Right offset 10 mm' } } });
  expect(resultsIn(afterBad)[0]).toMatchObject({ tool: 'cad__direct', ok: false, error: { code: 'invalid_input', detail: { reason: 'bad_input', field: 'bodies' } } });

  // What the person sees: the thicker plate, the three rows built, two bodies.
  await expect.poll(mm3, STEP).toBe(12000);
  await expect.poll(() => treeRows(page), STEP).toEqual(['Sketch 1 sketch ok', 'Extrude 1 extrude ok', 'Press-pull 1 press_pull ok', 'Axis 1 ref_axis ok', 'Split 1 split ok']);
  await expect.poll(() => bodyRows(page), STEP).toEqual(['Body 1', 'Body 1 (2)']);
  // The request names the undo group (its last full stop left out).
  expect(await label()).toBe('Assistant: Make the plate 10 mm thick, add an axis and split it at x 10');

  // One Undo, named for the request, takes all three away.
  await frame.locator('[data-cad-toolbar] [data-command="edit.undo"]').hover();
  await expect(frame.locator('[data-cad-tip]')).toContainText('Undo Assistant: Make the plate 10 mm thick, add an axis and split it at x 10', STEP);
  await frame.locator('[data-cad-toolbar] [data-command="edit.undo"]').click();
  await expect.poll(() => treeRows(page), STEP).toEqual(['Sketch 1 sketch ok', 'Extrude 1 extrude ok']);
  await expect.poll(() => bodyRows(page), STEP).toEqual(['Body 1']);
  await expect.poll(mm3, STEP).toBe(7200);
  expect(await label()).toBe(undoBefore);
});

test("cad:assistant-features-move the model copies the person's block 30 mm along Y: the tree shows the copy, and the dock's step names it and where it is", async ({ page, request }) => {
  test.setTimeout(240_000);
  const pid = await newProject(request, host, 'Assistant move');
  await openNewPart(page, request, host, pid);
  await cadFrame(page).evaluate(() => (window as unknown as W).__CAD__.assistant.setPace('fast', 0));
  await addSolid(page, { size: [20, 10, 10] });
  await expect.poll(() => treeRows(page), STEP).toEqual(['Sketch 1 sketch ok', 'Extrude 1 extrude ok']);
  const before = chats(host).length;
  host.fake.reply({ tools: [{ name: 'cad__direct', input: DIRECT({ kind: 'move_body', bodies: ['Body 1'], move: ['0', '30 mm', '0'], copy: true }) }] }, { text: 'Body 1 (Copy) is 30 mm along Y from Body 1.' });
  await core.dockSend(page, 'Copy the block 30 mm along Y');
  await expect(core.dockTurn(page).locator('[data-turn-end="done"]')).toBeVisible({ timeout: STEP_MS * 4 });
  const [moved] = resultsIn(chats(host)[before + 1]);
  expect(moved).toMatchObject({ tool: 'cad__direct', ok: true, data: { feature: { name: 'Body-Copy 1', type: 'move_body', state: 'ok' }, copies: [{ name: 'Body 1 (Copy)', at_mm: [10, 35, 5] }] } });
  // What the person sees: the copy beside the block in the tree, and the step that made it.
  await expect.poll(() => treeRows(page), STEP).toEqual(['Sketch 1 sketch ok', 'Extrude 1 extrude ok', 'Body-Copy 1 move_body ok']);
  await expect.poll(() => bodyRows(page), STEP).toEqual(['Body 1', 'Body 1 (Copy)']);
  const step = core.dockTurn(page).locator('[data-dock-step]').filter({ hasText: 'Body 1 (Copy)' });
  await expect(step.locator('[data-dock-result]')).toContainText('copied Body 1 by (0, 30, 0) mm: Body 1 (Copy) at (10, 35, 5)', STEP);
  await expect(step).toHaveAttribute('data-dock-step-state', 'ok');
});

const SKETCH = (name: string, on: string, circles: [number, number][]) => ({
  name: 'cad__sketch',
  input: { edit: '', name, on, entities: circles.map(([r, k], i) => ({ id: `c${i + 1}`, kind: 'circle', at: [0, 0, r], construction: k === 1 })), constraints: [], infer: false },
});
const EXTRUDE = (name: string, sketch: string, distance: string, o: Record<string, unknown> = {}) => ({
  name: 'cad__extrude',
  input: { edit: '', name, sketch, regions: ['all'], face: '', direction: '', extent: 'blind', distance, distance2: '', to: '', flip: false, op: 'new', bodies: [], body_name: '', color: '', ...o },
});
const CHECK_STACK = { name: 'cad__check', input: { kind: 'stack', bodies: [], clearance: '', axis: '' } };

test("cad:assistant-features-check the model checks a wheel on a shaft: the dock's check step names the wheel that can slide; after a collar, nothing is loose", async ({ page, request }) => {
  test.setTimeout(300_000);
  const pid = await newProject(request, host, 'Assistant check');
  await openNewPart(page, request, host, pid);
  await cadFrame(page).evaluate(() => (window as unknown as W).__CAD__.assistant.setPace('fast', 0));
  const dockTurn = () => core.dockTurn(page);
  const checkStep = () => dockTurn().locator('[data-dock-step]').filter({ hasText: 'Check an assembly' });

  // Message 1: a shaft (a head 12 across and 2 thick, a rod 4 across and 30 long) and a wheel (bore 4.4, rim 30, 4 thick) on the head.
  const before = chats(host).length;
  host.fake.reply(
    { tools: [SKETCH('Head sketch', 'Top', [[6, 0]])] },
    { tools: [EXTRUDE('Head', 'Head sketch', '2 mm', { body_name: 'Shaft' })] },
    { tools: [SKETCH('Rod sketch', 'Top', [[2, 0]])] },
    { tools: [EXTRUDE('Rod', 'Rod sketch', '30 mm', { op: 'join', bodies: ['Shaft'] })] },
    { tools: [SKETCH('Wheel sketch', 'Top offset 2 mm', [[15, 0], [2.2, 0]])] },
    { tools: [EXTRUDE('Wheel', 'Wheel sketch', '4 mm', { body_name: 'Wheel' })] },
    { tools: [CHECK_STACK] },
    { text: 'The wheel can slide off the top of the shaft.' },
  );
  await core.dockSend(page, 'Make a wheel on a shaft and check that it is held');
  await expect(dockTurn().locator('[data-turn-end="done"]')).toBeVisible({ timeout: STEP_MS * 4 });
  const [first] = resultsIn(chats(host)[before + 7]);
  expect(first).toMatchObject({ tool: 'cad__check', ok: true, data: { kind: 'stack', loose: ['Wheel can slide along Shaft toward +Z: nothing stops it before it comes off Shaft'] } });
  // What the person sees: the check step says one part can slide along its shaft, naming the wheel.
  await expect(checkStep().locator('[data-dock-result]')).toContainText('Checked the stack: 1 part can slide along its shaft: Wheel (+Z)', STEP);
  await expect(checkStep()).toHaveAttribute('data-dock-step-state', 'ok');

  // Message 2: a collar pressed on the shaft above the wheel (its bore the shaft's size), then the check again.
  const again = chats(host).length;
  host.fake.reply(
    { tools: [SKETCH('Collar sketch', 'Top offset 6 mm', [[5, 0], [2, 0]])] },
    { tools: [EXTRUDE('Collar', 'Collar sketch', '3 mm', { body_name: 'Collar' })] },
    { tools: [CHECK_STACK] },
    { text: 'The collar holds the wheel now.' },
  );
  await core.dockSend(page, 'Hold it with a collar');
  await expect(dockTurn().locator('[data-turn-end="done"]')).toBeVisible({ timeout: STEP_MS * 4 });
  const [second] = resultsIn(chats(host)[again + 3]);
  expect(second).toMatchObject({ tool: 'cad__check', ok: true, data: { loose: [] } });
  await expect(checkStep().locator('[data-dock-result]')).toContainText('Checked the stack: Nothing is loose: 1 part on 1 axis, each held both ways within 0.5 mm', STEP);
  await expect(checkStep()).not.toContainText('can slide');
});
