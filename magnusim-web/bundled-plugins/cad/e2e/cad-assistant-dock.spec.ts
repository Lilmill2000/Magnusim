// The app's Assistant panel (its dock) beside the Part's own Assistant chip (chat dock spec 7.1,
// 8.3, 11.4): a build sent from the dock in an open Part shows in both, with the same counter
// words, the per-edit picture in the dock, and no control in both places (the chip has no Stop
// or Undo while docked; the dock has no Pause or Resume); Stop in the dock reverts the call it is
// on; Undo these changes in the dock undoes the request's group, Ctrl+Y brings it back, and a
// person's edit withdraws it; Ctrl+/ typed in the Part opens the dock and, typed in the dock,
// closes it back to the Part; a question of a CAD request shows as the dock's card with No
// focused while the Part had the keyboard (Enter answers No); the app's toasts stay clear of the
// Part's chips; a sketch the person draws between two dock messages is pictured whole by view's
// sketch, named in the dock's step, and told in the next request's user_changes (the host names
// the conversation of each turn); view's picture of a hidden sketch far
// above the part shows its lines; a feature name one word off gets no closest name; five
// extrudes in one answer of the model (one step) get one picture, after the last of them (the
// host says each call's place in its step), and the four before it point the model to it.
// Its own server with the Assistant's test switches and the scripted model (e2e/assistant-helpers.ts).
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type Page } from '@playwright/test';
// @ts-expect-error the app's helpers are plain JavaScript (the suite's tsconfig has no allowJs)
import * as core from '../../../e2e/support/assistant.js';
import { drawRectangle } from './helpers';
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
  resultsIn,
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

const EXTRUDE_IN = (o: Record<string, unknown>) => ({ edit: '', name: '', sketch: '', regions: ['all'], face: '', direction: '', extent: 'blind', distance: '', distance2: '', to: '', flip: false, op: 'new', bodies: [], body_name: '', color: '', ...o });
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
  await expect.poll(() => img.evaluate((el: Element) => (el as HTMLImageElement).naturalWidth), STEP).toBeGreaterThan(0);
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

test("cad:assistant-dock-view-tools the pill and the open panel stay clear of the Part's view tools at the bottom right: Home, views and the axis triad", async ({ page, request }) => {
  test.setTimeout(180_000);
  const pid = await newProject(request, host, 'Dock view tools');
  const { frame, tab } = await openNewPart(page, request, host, pid);
  await forcePace(page, 'fast', 0);
  host.fake.reply({ tools: [SKETCH] }, { tools: [EXTRUDE] }, { text: 'Built.' });
  expect((await (await startTurn(request, host, { text: 'Make a disc.', tab })).ended(STEP_MS * 2)).turn.state).toBe('done');
  const fb = (await page.locator('#workspace-frame').boundingBox())!;
  const tools = async () =>
    (await frame.locator('.cad-vp-gizmo button, .cad-vp-triad-slot').evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; })))
      .filter((r) => r.right > r.left && r.bottom > r.top)
      .map((r) => ({ left: fb.x + r.left, top: fb.y + r.top, right: fb.x + r.right, bottom: fb.y + r.bottom }));
  const rectOf = async (sel: string): Promise<Rect> => {
    const b = (await page.locator(sel).boundingBox())!;
    return { left: b.x, top: b.y, right: b.x + b.width, bottom: b.y + b.height };
  };
  const clear = async (what: string, sel: string) => {
    const r = await rectOf(sel);
    const ts = await tools();
    expect(ts.length).toBeGreaterThanOrEqual(2);
    for (const t of ts) expect(overlap(r, t), `${what} ${JSON.stringify(r)} and a view tool ${JSON.stringify(t)}`).toBe(false);
  };
  // The ended request's pill (shown 120 s), then the open panel.
  await expect(page.locator('[data-assistant-pill]')).toBeVisible(STEP);
  await clear('the pill', '[data-assistant-pill]');
  await core.openDock(page);
  await clear('the open panel', '#assistant-dock');
  // Home answers a click while the panel is open: nothing of the app's lies over it.
  const home = frame.locator('.cad-vp-gizmo button').first();
  const hb = (await home.boundingBox())!;
  const top = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.id ?? '', { x: hb.x + hb.width / 2, y: hb.y + hb.height / 2 });
  expect(top).toBe('workspace-frame');
});

test("cad:assistant-dock-sketch-spec the person draws a sketch between two dock messages: the next request's view of it pictures it whole, and the dock's step names it with its picture", async ({ page, request }) => {
  test.setTimeout(240_000);
  const pid = await newProject(request, host, 'Dock sketch spec');
  const { frame } = await openNewPart(page, request, host, pid);
  await forcePace(page, 'fast', 0);
  // Message 1: the Assistant makes a disc 20 mm across.
  host.fake.reply({ tools: [SKETCH] }, { tools: [EXTRUDE] }, { text: 'A disc.' });
  await core.dockSend(page, 'Make a disc 20 mm across and 5 mm tall');
  await expect(dockTurn(page).locator('[data-turn-end="done"]')).toBeVisible({ timeout: STEP_MS * 2 });
  // Between two messages the person closes the panel and draws a 60 x 30 rectangle, far wider than the disc.
  await dock(page).locator('[data-dock-close]').click();
  await expect(dock(page)).toBeHidden(STEP);
  await drawRectangle(page, frame, 60, 30);
  const names = await features(page);
  expect(names.slice(0, 2)).toEqual(['Disc sketch', 'Disc']);
  const sketch = names[2];
  expect(sketch).toMatch(/^Sketch \d+$/);
  // Message 2: the scripted model reads the Part, then looks at the person's sketch.
  const before = chats(host).length;
  const VIEW_IN = { views: ['iso'], hide: [], section: '', labels: 'none', size: 'small', display: 'shaded_edges', projection: 'orthographic', sketch };
  host.fake.reply({ tools: [{ name: 'cad__get_model', input: { detail: 'brief', feature: '', regions: 'short' } }] }, { tools: [{ name: 'cad__view', input: VIEW_IN }] }, { text: 'I see your rectangle.' });
  await core.dockSend(page, 'Make it the shape of my sketch');
  await expect(dockTurn(page).locator('[data-turn-end="done"]')).toBeVisible({ timeout: STEP_MS * 2 });
  const [read] = resultsIn(chats(host)[before + 1]);
  expect(read).toMatchObject({ tool: 'cad__get_model', ok: true });
  // This host names each turn's conversation (AssistantTurn.conversation), so the second request
  // shares the first one's baseline and tells the sketch the person drew between them
  // (unit: model.test.ts, rev.test.ts).
  expect(read.data?.user_changes).toEqual([`added ${sketch} (sketch)`]);
  const [viewed] = resultsIn(chats(host)[before + 2]);
  expect(viewed).toMatchObject({ tool: 'cad__view', ok: true, data: { views: [], sketch: { name: sketch, normal: [0, 0, 1] } } });
  expect(viewed.images).toHaveLength(1);
  // Framed on the sketch, not on the disc: its 60 mm fit in the 768 px picture with room to spare
  // (framed on the disc they would take about 990 px).
  const mmPerPx = (viewed.data!.sketch as { mm_per_px: number }).mm_per_px;
  expect(60 / mmPerPx).toBeLessThan(768);
  expect(60 / mmPerPx).toBeGreaterThan(0.4 * 768);
  // What the person sees: the dock's view step names the sketch and shows its picture.
  const step = dockTurn(page).locator('[data-dock-step]').filter({ hasText: `Pictured ${sketch}` });
  await expect(step).toBeVisible(STEP);
  const img = step.locator('.dock-step-pictures img').first();
  await expect(img).toBeVisible(STEP);
  await expect.poll(() => img.evaluate((el: Element) => (el as HTMLImageElement).naturalWidth), STEP).toBe(768);
  await shot(page, 'cad-dock-sketch-spec');
});

test("cad:assistant-dock-sketch-far a sketch the view hides, far above the part: view's picture of it shows its lines; a name one word off gets no closest name, the same words do", async ({ page, request }) => {
  test.setTimeout(240_000);
  const pid = await newProject(request, host, 'Dock far sketch');
  await openNewPart(page, request, host, pid);
  await forcePace(page, 'fast', 0);
  // A 40 x 20 rectangle on Top offset 60 mm (its plane "Lid sketch plane"), beside the disc and
  // far above it, then the sketch and its plane hidden: nothing the view shows is near it.
  const LID = { name: 'cad__sketch', input: { edit: '', name: 'Lid sketch', on: 'Top offset 60 mm', entities: [{ id: 'r', kind: 'rect', at: [40, -10, 80, 10], construction: false }], constraints: [], infer: false } };
  const HIDE = (target: string) => ({ name: 'cad__workspace', input: { action: 'hide', target, value: '', items: [], person_asked: false } });
  const VIEW = { name: 'cad__view', input: { views: ['iso'], hide: [], section: '', labels: 'none', size: 'small', display: 'shaded_edges', projection: 'orthographic', sketch: 'Lid sketch' } };
  const READ = (feature: string) => ({ name: 'cad__get_model', input: { detail: 'brief', feature, regions: 'short' } });
  const before = chats(host).length;
  host.fake.reply({ tools: [SKETCH] }, { tools: [EXTRUDE] }, { tools: [LID] }, { tools: [HIDE('Lid sketch'), HIDE('Lid sketch plane')] }, { tools: [VIEW] }, { tools: [READ('Lip sketch')] }, { tools: [READ('lid-sketch')] }, { text: 'Done.' });
  await core.dockSend(page, 'Make a disc, and a lid sketch above it');
  await expect(dockTurn(page).locator('[data-turn-end="done"]')).toBeVisible({ timeout: STEP_MS * 3 });
  expect(resultsIn(chats(host)[before + 4])).toMatchObject([{ tool: 'cad__workspace', ok: true }, { tool: 'cad__workspace', ok: true }]);
  const [viewed] = resultsIn(chats(host)[before + 5]);
  expect(viewed).toMatchObject({ tool: 'cad__view', ok: true, data: { sketch: { name: 'Lid sketch', normal: [0, 0, 1] } } });
  // What the person sees: the dock's view step with a picture that shows the rectangle's lines
  // (left out of the camera's depth, the picture was the background alone).
  const step = dockTurn(page).locator('[data-dock-step]').filter({ hasText: 'Pictured Lid sketch' });
  await expect(step).toBeVisible(STEP);
  const img = step.locator('.dock-step-pictures img').first();
  await expect.poll(() => img.evaluate((el: Element) => (el as HTMLImageElement).naturalWidth), STEP).toBe(768);
  const ink = await img.evaluate((el: Element) => {
    const im = el as HTMLImageElement;
    const c = document.createElement('canvas');
    [c.width, c.height] = [im.naturalWidth, im.naturalHeight];
    const g = c.getContext('2d')!;
    g.drawImage(im, 0, 0);
    const { data } = g.getImageData(0, 0, c.width, c.height);
    const bg = [data[0], data[1], data[2]];
    let n = 0;
    // The triad's corner (bottom right) left out.
    for (let y = 0; y < c.height; y++)
      for (let x = 0; x < c.width; x++) {
        if (x > 0.75 * c.width && y > 0.75 * c.height) continue;
        const i = 4 * (y * c.width + x);
        if (Math.max(Math.abs(data[i] - bg[0]), Math.abs(data[i + 1] - bg[1]), Math.abs(data[i + 2] - bg[2])) > 40) n++;
      }
    return n;
  });
  expect(ink).toBeGreaterThan(500);
  // A name one word off ("Lip" for "Lid") names no other feature; the same words ("lid-sketch") do.
  const [lip] = resultsIn(chats(host)[before + 6]);
  expect(lip).toMatchObject({ tool: 'cad__get_model', ok: false });
  expect(JSON.stringify(lip)).not.toContain('losest');
  const [lid] = resultsIn(chats(host)[before + 7]);
  expect(lid).toMatchObject({ tool: 'cad__get_model', ok: false, error: { detail: { closest: 'Lid sketch' } } });
  const failed = dockTurn(page).locator('[data-dock-step][data-dock-step-state="failed"] [data-dock-result]');
  await expect(failed.filter({ hasText: 'Lip sketch' })).toBeVisible(STEP);
  await expect(failed.filter({ hasText: 'Lip sketch' })).not.toContainText('Closest');
  await expect(failed.filter({ hasText: 'lid-sketch' })).toContainText('Closest: "Lid sketch".');
  await shot(page, 'cad-dock-sketch-far');
});

test('cad:assistant-dock-step-picture five extrudes in one answer of the model: the dock shows one picture for that step, on its last extrude; the four before it point the model to that picture', async ({ page, request }) => {
  test.setTimeout(240_000);
  const pid = await newProject(request, host, 'Dock step picture');
  await openNewPart(page, request, host, pid);
  await forcePace(page, 'fast', 0);
  // Answer 1: the disc's sketch (a step of one edit: its own picture). Answer 2: five extrudes of
  // it, all in one answer, so the host sends each with its place in that step (editsLeftInStep 4..0).
  const NAMES = ['Disc 1', 'Disc 2', 'Disc 3', 'Disc 4', 'Disc 5'];
  const FIVE = NAMES.map((name, i) => ({ name: 'cad__extrude', input: EXTRUDE_IN({ name, sketch: 'Disc sketch', distance: `${i + 1} mm` }) }));
  const before = chats(host).length;
  host.fake.reply({ tools: [SKETCH] }, { tools: FIVE }, { text: 'Five discs.' });
  await core.dockSend(page, 'Make five discs, 1 to 5 mm tall');
  await expect(dockTurn(page).locator('[data-turn-end="done"]')).toBeVisible({ timeout: STEP_MS * 3 });
  expect(await features(page)).toEqual(['Disc sketch', ...NAMES]);
  // What the person sees: the dock's five extrude steps, a picture on the fifth only, and the
  // turn's pictures are the sketch's and that one.
  const extrudes = dockTurn(page).locator('[data-dock-step]').filter({ has: page.locator('.dock-step-title', { hasText: /^Extrude$/ }) });
  await expect(extrudes).toHaveCount(5, STEP);
  await expect(extrudes.locator('.dock-step-pictures img')).toHaveCount(1, STEP);
  for (let i = 0; i < 4; i++) await expect(extrudes.nth(i).locator('.dock-step-pictures img')).toHaveCount(0);
  const img = extrudes.nth(4).locator('.dock-step-pictures img');
  await expect(img).toBeVisible(STEP);
  await expect.poll(() => img.evaluate((el: Element) => (el as HTMLImageElement).naturalWidth), STEP).toBe(640);
  await expect(dockTurn(page).locator('.dock-step-pictures img')).toHaveCount(2);
  // What the model gets back for that step: the four earlier extrudes carry the pointer line
  // (pictures.ts PICTURE_LATER) and no picture; the fifth carries the one picture and its line.
  const five = resultsIn(chats(host)[before + 2]);
  expect(five.map((r) => [r.tool, r.ok])).toEqual(NAMES.map(() => ['cad__extrude', true]));
  for (const r of five.slice(0, 4)) {
    expect(r.data?.picture).toBe("see this step's last edit");
    expect(r.images).toHaveLength(0);
  }
  expect(five[4].images).toHaveLength(1);
  expect(String(five[4].data?.picture)).toMatch(/^Picture: iso view of the Part framed on /);
  await shot(page, 'cad-dock-step-picture');
});
