// The app's Assistant panel (its dock) beside the Part's own Assistant chip (chat dock spec 7.1,
// 8.3, 11.4): a build sent from the dock in an open Part shows in both, with the same counter
// words, the per-edit picture in the dock, and no control in both places (the chip has no Stop
// or Undo while docked; the dock has no Pause or Resume); Stop in the dock reverts the call it is
// on; Undo these changes in the dock undoes the request's group, Ctrl+Y brings it back, and a
// person's edit withdraws it; Ctrl+/ typed in the Part opens the dock and, typed in the dock,
// closes it back to the Part; a question of a CAD request shows as the dock's card with No
// focused while the Part had the keyboard (Enter answers No); the app's toasts stay clear of the
// Part's chips.
// Its own server with the Assistant's test switches and the scripted model (e2e/assistant-helpers.ts).
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type Page } from '@playwright/test';
// @ts-expect-error the app's helpers are plain JavaScript (the suite's tsconfig has no allowJs)
import * as core from '../../../e2e/support/assistant.js';
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
  releaseHold,
  resetAssistant,
  startAssistantHost,
  startTurn,
  STEP,
  STEP_MS,
  useScriptedModel,
  type AssistantHost,
} from './assistant-helpers';

let host: AssistantHost;

test.beforeAll(async ({ request }) => {
  test.setTimeout(300_000);
  host = await startAssistantHost('cad-assistant-dock', 110);
  await useScriptedModel(request, host, 'cloud');
});

test.afterAll(async () => {
  if (host) await host.stop();
});

test.beforeEach(async ({ request, page }) => {
  await resetAssistant(request, host);
  await useScriptedModel(request, host, 'cloud');
  await page.setViewportSize({ width: 1280, height: 800 });
});

test.afterEach(() => {
  expect(host.fake.pending(), 'scripted answers left unused').toBe(0);
});

type DockCad = {
  __CAD__: {
    services: { doc: { undo(): void; redo(): void; state: { get(): { doc: { features: { name: string }[] }; history: { undoLabel: string | null } } } } };
  };
};
const features = (page: Page) => cadFrame(page).evaluate(() => (window as unknown as DockCad).__CAD__.services.doc.state.get().doc.features.map((f) => f.name));

const EXTRUDE_IN = (o: Record<string, unknown>) => ({ edit: '', name: '', sketch: '', regions: ['all'], extent: 'blind', distance: '', distance2: '', to: '', flip: false, op: 'new', bodies: [], body_name: '', color: '', ...o });
/** A disc on Top, fully defined. */
const DISC = (name: string, r: number) => ({
  edit: '',
  name,
  on: 'Top',
  entities: [{ id: 'c', kind: 'circle', at: [0, 0, r], construction: false }],
  constraints: [
    { id: 'cu', kind: 'distance_x', refs: ['origin', 'c.center'], value: '0 mm' },
    { id: 'cv', kind: 'distance_y', refs: ['origin', 'c.center'], value: '0 mm' },
    { id: 'cd', kind: 'diameter', refs: ['c'], value: `${2 * r} mm` },
  ],
  infer: false,
});
const SKETCH = { name: 'cad__sketch', input: DISC('Disc sketch', 10) };
const EXTRUDE = { name: 'cad__extrude', input: EXTRUDE_IN({ name: 'Disc', sketch: 'Disc sketch', distance: '5 mm' }) };

const dock = (page: Page) => page.locator('#assistant-dock');
/** With DOCK_SHOTS=<folder>: a screenshot for a person to look at (never compared). */
async function shot(page: Page, name: string) {
  if (!process.env.DOCK_SHOTS) return;
  await page.screenshot({ path: `${process.env.DOCK_SHOTS}/${name}-${page.viewportSize()?.width ?? 0}.png` });
}
const dockTurn = (page: Page) => core.dockTurn(page);
const SLACK = 2;
type Rect = { left: number; top: number; right: number; bottom: number };
const overlap = (a: Rect, b: Rect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

test('cad:assistant-dock-coexist a build sent from the dock: the chip works with no Stop or Undo, the dock counts as the chip does and shows the extrude\'s picture; Pause in the chip is a wait in the dock, with no Resume there', async ({ page, request }) => {
  test.setTimeout(240_000);
  const pid = await newProject(request, host, 'Dock and chip');
  const { frame } = await openNewPart(page, request, host, pid);
  await forcePace(page, 'fast', 0);
  const chip = frame.locator('[data-chip="assistant"]');
  host.fake.reply({ tools: [SKETCH] }, { hold: 'dock-extrude', tools: [EXTRUDE] }, { text: 'A disc, 5 mm tall.' });
  await core.dockSend(page, 'Make a disc 20 mm across and 5 mm tall');
  await expect(chip).toHaveAttribute('data-assistant-state', /thinking|working/, STEP);
  await expect(chip.locator('[data-assistant-action="stop"], [data-assistant-action="undo"]')).toHaveCount(0);
  // The same counter words: the chip's "N of M steps" is the start of the dock's counters.
  await expect(dockTurn(page).locator('[data-dock-counters]')).toHaveText(/^\d+ of \d+ steps · \d+ of \d+ min$/, STEP);
  const counted = async () => {
    const chipText = (await chipWords(frame).textContent()) || '';
    const dockText = (await dockTurn(page).locator('[data-dock-counters]').textContent()) || '';
    return [/(\d+ of \d+ steps)/.exec(chipText)?.[1] ?? '', dockText.split(' · ')[0]];
  };
  await expect.poll(async () => { const [a, b] = await counted(); return a !== '' && a === b; }, STEP).toBe(true);
  // Pause in the chip: the dock's footer says the Part waits for the person; the dock offers no Resume.
  await chipButton(frame, 'pause').click();
  await expect(chip).toHaveAttribute('data-assistant-state', 'paused', STEP);
  host.fake.release('dock-extrude');
  await expect(dockTurn(page).locator('[data-dock-phase]')).toHaveText(/^Waits for you in .+: Paused by the person$/, STEP);
  await expect(dock(page).getByRole('button', { name: /^(Resume|Pause)$/ })).toHaveCount(0);
  await shot(page, 'cad-workspace-chip');
  await chipButton(frame, 'resume').click();
  await expect(dockTurn(page).locator('[data-turn-end="done"]')).toBeVisible({ timeout: STEP_MS * 2 });
  // The extrude's step shows the Part's picture after the edit.
  const extrude = dockTurn(page).locator('[data-dock-step]').filter({ hasText: 'Extrude' });
  const img = extrude.locator('.dock-step-pictures img').first();
  await expect(img).toBeVisible(STEP);
  await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth), STEP).toBeGreaterThan(0);
  expect(await features(page)).toEqual(['Disc sketch', 'Disc']);
});

test('cad:assistant-dock-stop Stop in the dock: the call it is on is not kept, and the chip says stopped', async ({ page, request }) => {
  test.setTimeout(240_000);
  const pid = await newProject(request, host, 'Dock stop');
  const { frame } = await openNewPart(page, request, host, pid);
  await forcePace(page, 'fast', 0);
  const before = chats(host).length;
  host.fake.reply({ tools: [SKETCH] }, { hold: 'stop-extrude', tools: [EXTRUDE] });
  await core.dockSend(page, 'Make a disc');
  await expect.poll(() => chats(host).length, { timeout: STEP_MS * 2 }).toBeGreaterThanOrEqual(before + 2);
  await holdAt(page, 'before-commit');
  host.fake.release('stop-extrude');
  await reachedHold(page, 'before-commit');
  await dock(page).locator('[data-dock-stop]').click();
  await expect(dockTurn(page).locator('[data-turn-end="stopped"]')).toBeVisible({ timeout: STEP_MS * 2 });
  await releaseHold(page, 'before-commit');
  await expect.poll(() => features(page), STEP).toEqual(['Disc sketch']);
  await expect(frame.locator('[data-chip="assistant"]')).toHaveAttribute('data-assistant-state', 'ended', STEP);
  await expect(chipWords(frame)).toHaveText(/ · stopped$/);
  expect(chats(host).length).toBe(before + 2);
});

test('cad:assistant-dock-undo Undo these changes: in the dock (not the chip), the Part as before the request, Ctrl+Y brings it back; a person\'s edit withdraws it', async ({ page, request }) => {
  test.setTimeout(240_000);
  const pid = await newProject(request, host, 'Dock undo');
  const { frame } = await openNewPart(page, request, host, pid);
  await forcePace(page, 'fast', 0);
  host.fake.reply({ tools: [SKETCH] }, { tools: [EXTRUDE] }, { text: 'Done.' });
  await core.dockSend(page, 'Make a disc');
  await expect(dockTurn(page).locator('[data-turn-end="done"]')).toBeVisible({ timeout: STEP_MS * 2 });
  const undo = dockTurn(page).locator('[data-dock-undo]');
  await expect(undo).toHaveText('Undo these changes', STEP);
  await expect(undo).toHaveAttribute('title', /^Undo the Assistant's changes of this request in .+ \(one step\)$/);
  await expect(chipButton(frame, 'undo')).toHaveCount(0);
  await undo.click();
  await expect.poll(() => features(page), STEP).toEqual([]);
  await expect(dockTurn(page).locator('[data-dock-undo-said]')).toHaveText(/^Undone\. Redo \(Ctrl\+Y\) in .+ brings them back\.$/);
  await expect(undo).toHaveCount(0);
  await keyboardInFrame(page, frame);
  await page.keyboard.press('Control+y');
  await expect.poll(() => features(page), STEP).toEqual(['Disc sketch', 'Disc']);
  // Offered again once its group is the newest again (the dock, closed to give the Part the
  // keyboard, opened again); a person's edit withdraws it.
  await core.openDock(page);
  await expect(undo).toBeVisible(STEP);
  await cadFrame(page).evaluate(() => (window as unknown as { __CAD__: { services: { doc: { addParam(p: { name: string; expr: string; quantity: string }): unknown } } } }).__CAD__.services.doc.addParam({ name: 'w', expr: '2 mm', quantity: 'length' }));
  await expect(undo).toHaveCount(0, STEP);
});

test('cad:assistant-dock-keys Ctrl+/ typed in the Part opens the dock; typed in the dock it closes and the Part has the keyboard again', async ({ page, request }) => {
  test.setTimeout(180_000);
  const pid = await newProject(request, host, 'Dock keys');
  const { frame } = await openNewPart(page, request, host, pid);
  await keyboardInFrame(page, frame);
  await page.keyboard.press('Control+Slash');
  await expect(dock(page)).toBeVisible(STEP);
  await expect(dock(page).getByRole('textbox', { name: 'Message to the Assistant' })).toBeFocused();
  await page.keyboard.press('Control+Slash');
  await expect(dock(page)).toBeHidden(STEP);
  await expect.poll(() => cadFrame(page).evaluate(() => document.hasFocus()), STEP).toBe(true);
});

test('cad:assistant-dock-question a CAD question shows as the dock\'s card with No focused while the Part had the keyboard; Enter answers No', async ({ page, request }) => {
  test.setTimeout(240_000);
  const pid = await newProject(request, host, 'Dock question');
  const { frame, tab } = await openNewPart(page, request, host, pid);
  await forcePace(page, 'fast', 0);
  host.fake.reply({ tools: [SKETCH] }, { tools: [EXTRUDE] }, { text: 'Built.' });
  expect((await (await startTurn(request, host, { text: 'Make a disc.', tab })).ended(STEP_MS * 2)).turn.state).toBe('done');
  await keyboardInFrame(page, frame);
  host.fake.reply({ tools: [{ name: 'cad__delete', input: { features: ['Disc'] } }] }, { text: 'The disc stays.' });
  const t = await startTurn(request, host, { text: 'Delete the disc.', tab });
  const card = core.dockGate(page);
  await expect(card).toBeVisible(STEP);
  await expect(card.locator('.dock-gate-title')).toHaveText('Allow the Assistant to delete features?');
  await expect(card.locator('[data-gate-answer="no"]')).toBeFocused();
  await expect(page.locator('#modal-confirm')).toBeHidden();
  await page.keyboard.press('Enter');
  await expect(card).toBeHidden(STEP);
  expect((await t.ended(STEP_MS * 2)).turn.state).toBe('done');
  expect(await features(page)).toEqual(['Disc sketch', 'Disc']);
});

test("cad:assistant-dock-toasts the app's toasts stay clear of the Part's chips, 136 px up at the left", async ({ page, request }) => {
  test.setTimeout(180_000);
  const pid = await newProject(request, host, 'Dock toasts');
  const { frame, tab } = await openNewPart(page, request, host, pid);
  await forcePace(page, 'fast', 0);
  // The Assistant's chip (an ended request) and the Part's own chips.
  host.fake.reply({ tools: [SKETCH] }, { tools: [EXTRUDE] }, { text: 'Built.' });
  expect((await (await startTurn(request, host, { text: 'Make a disc.', tab })).ended(STEP_MS * 2)).turn.state).toBe('done');
  await expect(frame.locator('[data-chip="assistant"]')).toBeVisible(STEP);
  await page.mouse.move(640, 10);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('cfd:toast', { detail: { message: 'A toast beside the chips' } })));
  const toast = page.locator('.app-toasts .mgk-toast').filter({ hasText: 'A toast beside the chips' });
  await expect(toast).toBeVisible();
  const box = (await toast.boundingBox())!;
  const t: Rect = { left: box.x, top: box.y, right: box.x + box.width, bottom: box.y + box.height };
  const vp = page.viewportSize()!;
  expect(t.left).toBeGreaterThanOrEqual(16 - SLACK);
  expect(vp.height - t.bottom).toBeGreaterThanOrEqual(136 - SLACK);
  const fb = (await page.locator('#workspace-frame').boundingBox())!;
  const chips = await frame.locator('.cad-dock .cad-chip').evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; }));
  expect(chips.length).toBeGreaterThanOrEqual(2);
  for (const c of chips) {
    const host: Rect = { left: fb.x + c.left, top: fb.y + c.top, right: fb.x + c.right, bottom: fb.y + c.bottom };
    expect(overlap(t, host), `the toast ${JSON.stringify(t)} and a chip ${JSON.stringify(host)}`).toBe(false);
  }
});
