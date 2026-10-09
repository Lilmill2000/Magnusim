// UX 0.1.0 (TOOLBAR): Daniel 2026-10-07, "I need to be able to drag something from More onto the
// main toolbar and it replaced the last thing there ... drag tangent arc up there and it moves
// spline to the More tab", as a user meets it with the mouse:
//   - sketch DRAW at 1600 px shows Line, Rectangle, Circle, 3-point arc and Spline; Tangent arc is in
//     More. Dragged from More onto the bar's last slot it takes it and Spline goes to More; the bar
//     keeps its count. While dragging, the menu stays open as long as the pointer is in it, a mark
//     shows where it lands, Spline is highlighted and the note says "Spline moves to More";
//   - the layout survives a reload and a new sketch;
//   - dropped between Line and Rectangle it goes in there (the bar's last goes to More);
//   - a bar command dragged into its group's open More goes there, nothing comes up in exchange;
//   - over another group the drop is refused (not-allowed pointer, the group marked, the note says
//     why) and nothing changes, from More and from the bar;
//   - the keyboard's way: a More item's right-click "Swap with <the bar's last>";
//   - model mode: PATTERN's Circular pattern dragged onto the bar takes Linear pattern's slot.
// The layout is the user's (host plugin prefs, one file per plugin on the test server): every test
// here runs in the serial phase and starts and ends with no user layout.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import { addSolid, baseUrl, newPartFromTree, newProject, openProject, partOpened, runCommand, watchPage } from './helpers';

type Request = Parameters<typeof newProject>[0];

const tb = (frame: FrameLocator) => frame.locator('[data-cad-toolbar]');
const menu = (frame: FrameLocator) => frame.locator('[data-cad-menu]');
const ghost = (frame: FrameLocator) => frame.locator('[data-tb-ghost]');
const btn = (frame: FrameLocator, id: string) => tb(frame).locator(`.tb-btn[data-command="${id}"]`);

async function freshPart(page: Page, request: Request) {
  const seen = await watchPage(page);
  const projectId = await newProject(request);
  await openProject(page, projectId);
  await newPartFromTree(page, 'Part 1');
  const frame = await partOpened(page);
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  await expect(tb(frame)).toHaveAttribute('data-layout-ready', '1');
  return { seen, frame };
}

/** The ids of a group's buttons on the bar, in order. */
async function shownIds(frame: FrameLocator, group: string): Promise<string[]> {
  return tb(frame)
    .locator(`[data-group="${group}"] .tb-items > .tb-btn[data-command]`)
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-command') ?? ''));
}

async function moreIds(frame: FrameLocator, group: string): Promise<string[]> {
  const more = tb(frame).locator(`[data-tb-more="${group}"]`);
  return (await more.count()) ? ((await more.getAttribute('data-more-commands')) ?? '').split(' ').filter(Boolean) : [];
}

async function userLayout(request: Request): Promise<unknown> {
  const r = await request.post(`${baseUrl()}/api/plugin-prefs/get`, { data: { plugin: 'cad', key: 'toolbar-layout' } });
  expect(r.ok(), await r.text()).toBe(true);
  return (await r.json()).value ?? null;
}

async function forgetUserLayout(request: Request) {
  for (const key of ['toolbar-layout', 'toolbar-layout.migrated']) {
    const r = await request.post(`${baseUrl()}/api/plugin-prefs/remove`, { data: { plugin: 'cad', key } });
    expect(r.ok(), await r.text()).toBe(true);
  }
}

async function sketchOnTop(frame: FrameLocator) {
  await frame.locator('[data-tree-node="origin:top"] > .tree-row').click();
  await runCommand(frame, 'sketch.new');
  await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
}

async function finishSketch(frame: FrameLocator) {
  await btn(frame, 'sketch.finish').click();
  await expect(frame.locator('[data-cad-toolbar="model"]')).toBeVisible();
}

const centre = (b: { x: number; y: number; width: number; height: number }) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });

/**
 * Open the group's More, press on `id` there, start the drag inside the menu (it stays open), then
 * move to `to` (a page point, from `target()`), run `check` while the pointer is there, and let go.
 */
async function dragFromMore(page: Page, frame: FrameLocator, group: string, id: string, target: () => Promise<{ x: number; y: number }>, check?: () => Promise<void>) {
  const more = tb(frame).locator(`[data-tb-more="${group}"]`);
  await more.click();
  await expect(more).toHaveAttribute('aria-expanded', 'true');
  const item = menu(frame).locator(`[data-command="${id}"]`);
  const box = (await item.boundingBox())!;
  const at = centre(box);
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  // A drag starts once the pointer leaves the item (a small wobble on it is still a click: review S6).
  await page.mouse.move(at.x + 12, at.y + box.height, { steps: 4 });
  // Dragging inside the menu: it stays open, and the dragged command follows the pointer.
  await expect(ghost(frame)).toHaveAttribute('data-tb-ghost', id);
  await expect(menu(frame)).toBeVisible();
  const to = await target();
  await page.mouse.move(to.x, to.y, { steps: 10 });
  // Out of the menu toward the bar: it closes.
  await expect(menu(frame)).toHaveCount(0);
  if (check) await check();
  await page.mouse.up();
  await expect(ghost(frame)).toHaveCount(0);
}

test("cad:ux010-toolbar-sketch drag Tangent arc from DRAW's More onto the bar: Spline goes to More, the count holds; kept through a reload and a new sketch; between Line and Rectangle; a bar command into More; another group refused; Swap with", { tag: '@serial' }, async ({ page, request }) => {
  await forgetUserLayout(request);
  await page.setViewportSize({ width: 1600, height: 1000 });
  let { seen, frame } = await freshPart(page, request);
  await sketchOnTop(frame);
  // Daniel's starting point.
  await expect.poll(() => shownIds(frame, 'draw')).toEqual(['sketch.line', 'sketch.rectangle', 'sketch.circle', 'sketch.arc', 'sketch.spline']);
  expect(await moreIds(frame, 'draw')).toContain('sketch.arc-tangent');
  const count = (await shownIds(frame, 'draw')).length;

  // 1. Tangent arc onto the last slot (Spline's right half).
  await dragFromMore(
    page,
    frame,
    'draw',
    'sketch.arc-tangent',
    async () => {
      const b = (await btn(frame, 'sketch.spline').boundingBox())!;
      return { x: b.x + b.width * 0.75, y: b.y + b.height / 2 };
    },
    async () => {
      await expect(btn(frame, 'sketch.spline')).toHaveClass(/is-displaced/);
      await expect(btn(frame, 'sketch.spline')).toHaveClass(/is-drop-after/);
      await expect(frame.locator('[data-tb-drop-note]')).toHaveText('Spline moves to More');
      await expect(ghost(frame)).toHaveAttribute('data-drop', 'bar');
      await page.screenshot({ path: test.info().outputPath('drag-onto-bar.png') });
    },
  );
  await expect.poll(() => shownIds(frame, 'draw')).toEqual(['sketch.line', 'sketch.rectangle', 'sketch.circle', 'sketch.arc', 'sketch.arc-tangent']);
  expect(await moreIds(frame, 'draw')).toContain('sketch.spline');
  expect(await moreIds(frame, 'draw')).not.toContain('sketch.arc-tangent');
  expect((await shownIds(frame, 'draw')).length).toBe(count);
  await expect(tb(frame)).toHaveAttribute('data-layout', 'custom');
  // The drag ran nothing: Tangent arc is not the tool in use.
  await expect(btn(frame, 'sketch.arc-tangent')).not.toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => userLayout(request)).toMatchObject({ sketch: { place: { 'sketch.arc-tangent': 'bar', 'sketch.spline': 'more' } } });
  await finishSketch(frame);

  // 2. Reload the page, then a new sketch: the same DRAW.
  await page.reload();
  frame = page.frameLocator('#workspace-frame');
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready', { timeout: 60_000 });
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-kernel', 'ready', { timeout: 60_000 });
  await expect(tb(frame)).toHaveAttribute('data-layout-ready', '1');
  await sketchOnTop(frame);
  await expect.poll(() => shownIds(frame, 'draw')).toEqual(['sketch.line', 'sketch.rectangle', 'sketch.circle', 'sketch.arc', 'sketch.arc-tangent']);
  expect(await moreIds(frame, 'draw')).toContain('sketch.spline');

  // 3. Center rectangle between Line and Rectangle: in there; Tangent arc (now the last) goes to More.
  await dragFromMore(
    page,
    frame,
    'draw',
    'sketch.rectangle-center',
    async () => {
      const b = (await btn(frame, 'sketch.rectangle').boundingBox())!;
      return { x: b.x + 4, y: b.y + b.height / 2 };
    },
    async () => {
      await expect(btn(frame, 'sketch.rectangle')).toHaveClass(/is-drop-before/);
      await expect(btn(frame, 'sketch.arc-tangent')).toHaveClass(/is-displaced/);
      await expect(frame.locator('[data-tb-drop-note]')).toHaveText('Tangent arc moves to More');
    },
  );
  await expect.poll(() => shownIds(frame, 'draw')).toEqual(['sketch.line', 'sketch.rectangle-center', 'sketch.rectangle', 'sketch.circle', 'sketch.arc']);
  expect(await moreIds(frame, 'draw')).toEqual(expect.arrayContaining(['sketch.arc-tangent', 'sketch.spline']));

  // 4. A bar command (Circle) into DRAW's open More: it goes there, nothing comes up.
  const more = tb(frame).locator('[data-tb-more="draw"]');
  await more.click();
  await expect(menu(frame)).toBeVisible();
  const circle = centre((await btn(frame, 'sketch.circle').boundingBox())!);
  await page.mouse.move(circle.x, circle.y);
  await page.mouse.down();
  // The press on a DRAW button leaves DRAW's More open.
  await expect(menu(frame)).toBeVisible();
  await page.mouse.move(circle.x, circle.y + 12, { steps: 3 });
  const into = centre((await menu(frame).boundingBox())!);
  await page.mouse.move(into.x, into.y, { steps: 8 });
  await expect(menu(frame)).toHaveAttribute('data-drop-into', '1');
  await expect(frame.locator('[data-tb-drop-note]')).toHaveText('Circle moves to More');
  await expect(btn(frame, 'sketch.circle')).toHaveClass(/is-dragging/);
  await page.mouse.up();
  await expect(menu(frame)).toHaveCount(0);
  await expect.poll(() => shownIds(frame, 'draw')).toEqual(['sketch.line', 'sketch.rectangle-center', 'sketch.rectangle', 'sketch.arc']);
  expect(await moreIds(frame, 'draw')).toContain('sketch.circle');
  // The drag ran nothing (Circle is not the tool in use).
  expect(await frame.locator('[data-cad-app]').evaluate(() => (window as unknown as { __CAD__: { services: { apis: { get(): { sketch?: { state: { get(): { tool: string | null } } } } } } } }).__CAD__.services.apis.get().sketch?.state.get().tool ?? null)).not.toBe('circle');

  // 5. Another group refused: Point from DRAW's More over CONSTRAIN, then a DRAW button over DIMENSION.
  const before = { shown: await shownIds(frame, 'draw'), more: await moreIds(frame, 'draw'), stored: await userLayout(request) };
  await dragFromMore(
    page,
    frame,
    'draw',
    'sketch.point',
    async () => centre((await tb(frame).locator('[data-group="constrain"] .tb-items').boundingBox())!),
    async () => {
      await expect(ghost(frame)).toHaveAttribute('data-drop', 'refused');
      await expect(tb(frame).locator('[data-group="constrain"]')).toHaveAttribute('data-drop-refused', '1');
      await expect(frame.locator('[data-tb-drop-note]')).toHaveText('Point can only go in Draw');
      await expect(frame.locator('html')).toHaveClass(/cad-tb-drag-refused/);
      expect(await tb(frame).locator('[data-group="constrain"]').evaluate((el) => getComputedStyle(el).cursor)).toBe('not-allowed');
      await page.screenshot({ path: test.info().outputPath('drag-refused.png') });
    },
  );
  const line = centre((await btn(frame, 'sketch.line').boundingBox())!);
  await page.mouse.move(line.x, line.y);
  await page.mouse.down();
  const dim = centre((await tb(frame).locator('[data-group="dimension"] .tb-items').boundingBox())!);
  await page.mouse.move(dim.x, dim.y, { steps: 10 });
  await expect(ghost(frame)).toHaveAttribute('data-drop', 'refused');
  await expect(frame.locator('[data-tb-drop-note]')).toHaveText('Line can only go in Draw');
  await page.mouse.up();
  await expect(ghost(frame)).toHaveCount(0);
  await expect(frame.locator('html')).not.toHaveClass(/cad-tb-drag/);
  expect(await shownIds(frame, 'draw')).toEqual(before.shown);
  expect(await moreIds(frame, 'draw')).toEqual(before.more);
  expect(await shownIds(frame, 'dimension')).toEqual(['sketch.dimension']);
  expect(await userLayout(request)).toEqual(before.stored);

  // 6. The keyboard's way: right-click Spline in More, "Swap with Arc"; the count holds.
  await more.click();
  await menu(frame).locator('[data-command="sketch.spline"]').click({ button: 'right', force: true });
  const swap = menu(frame).locator('[data-menu-item="tb-swap"]');
  await expect(swap).toHaveText('Swap with 3-point arc');
  await swap.click();
  await expect.poll(() => shownIds(frame, 'draw')).toEqual(['sketch.line', 'sketch.rectangle-center', 'sketch.rectangle', 'sketch.spline']);
  expect(await moreIds(frame, 'draw')).toContain('sketch.arc');

  // Reset toolbar: DRAW as at first.
  await tb(frame).locator('[data-group="view"] .tb-group-label').click({ button: 'right', force: true });
  await menu(frame).locator('[data-menu-item="tb-reset"]').click();
  await expect(tb(frame)).toHaveAttribute('data-layout', 'default');
  await expect.poll(() => shownIds(frame, 'draw')).toEqual(['sketch.line', 'sketch.rectangle', 'sketch.circle', 'sketch.arc', 'sketch.spline']);
  await finishSketch(frame);
  expect(seen.errors, 'console errors').toEqual([]);
  await forgetUserLayout(request);
});

test("cad:ux010-toolbar-model drag Circular pattern from PATTERN's More onto the bar: it takes Linear pattern's slot, which goes to More", { tag: '@serial' }, async ({ page, request }) => {
  await forgetUserLayout(request);
  await page.setViewportSize({ width: 1600, height: 1000 });
  const { seen, frame } = await freshPart(page, request);
  await addSolid(page);
  expect(await shownIds(frame, 'pattern')).toEqual(['pattern.linear']);
  await dragFromMore(
    page,
    frame,
    'pattern',
    'pattern.circular',
    async () => centre((await btn(frame, 'pattern.linear').boundingBox())!),
    async () => {
      await expect(btn(frame, 'pattern.linear')).toHaveClass(/is-displaced/);
      await expect(frame.locator('[data-tb-drop-note]')).toHaveText('Linear pattern moves to More');
    },
  );
  await expect.poll(() => shownIds(frame, 'pattern')).toEqual(['pattern.circular']);
  expect(await moreIds(frame, 'pattern')).toEqual(['pattern.linear', 'pattern.mirror']);
  // Nothing ran: no feature panel.
  await expect(frame.locator('[data-cad-panel="feature"]')).toHaveCount(0);
  await expect.poll(() => userLayout(request)).toMatchObject({ model: { place: { 'pattern.circular': 'bar', 'pattern.linear': 'more' } } });
  // Escape during a drag cancels it: Mirror over the bar, Escape, let go: nothing changes.
  const stored = await userLayout(request);
  await tb(frame).locator('[data-tb-more="pattern"]').click();
  const mirror = centre((await menu(frame).locator('[data-command="pattern.mirror"]').boundingBox())!);
  await page.mouse.move(mirror.x, mirror.y);
  await page.mouse.down();
  const onBar = centre((await btn(frame, 'pattern.circular').boundingBox())!);
  await page.mouse.move(onBar.x, onBar.y, { steps: 10 });
  await expect(ghost(frame)).toHaveAttribute('data-drop', 'bar');
  await page.keyboard.press('Escape');
  await expect(ghost(frame)).toHaveCount(0);
  await page.mouse.up();
  expect(await shownIds(frame, 'pattern')).toEqual(['pattern.circular']);
  expect(await userLayout(request)).toEqual(stored);
  await expect(frame.locator('[data-cad-panel="feature"]')).toHaveCount(0);
  // A plain click on a More item still runs it (no drag): Linear pattern's panel opens.
  await tb(frame).locator('[data-tb-more="pattern"]').click();
  await menu(frame).locator('[data-command="pattern.linear"]').click();
  await expect(frame.locator('[data-cad-panel="feature"] [data-panel-title]')).toHaveText('Linear pattern 1');
  await page.keyboard.press('Escape');
  await expect(frame.locator('[data-cad-panel="feature"]')).toHaveCount(0);
  expect(seen.errors, 'console errors').toEqual([]);
  await forgetUserLayout(request);
});

/** The sketch tool in use, as sketch mode keeps it. */
async function sketchTool(frame: FrameLocator): Promise<string | null> {
  return frame.locator('[data-cad-app]').evaluate(
    () => (window as unknown as { __CAD__: { services: { apis: { get(): { sketch?: { state: { get(): { tool: string | null } } } } } } } }).__CAD__.services.apis.get().sketch?.state.get().tool ?? null,
  );
}

async function resetToolbar(frame: FrameLocator) {
  await tb(frame).locator('[data-group="view"] .tb-group-label').click({ button: 'right', force: true });
  await menu(frame).locator('[data-menu-item="tb-reset"]').click();
  await expect(tb(frame)).toHaveAttribute('data-layout', 'default');
}

test('cad:ux010-toolbar-narrow at 1150 and 1000 px a command dragged (or swapped) from More stays on the bar and the note says what happens; a lost release drops nothing; a wobbly click on a More item runs it; Enter on a More item runs that item, not Finish sketch', { tag: '@serial' }, async ({ page, request }) => {
  await forgetUserLayout(request);
  await page.setViewportSize({ width: 1150, height: 900 });
  const { seen, frame } = await freshPart(page, request);
  await sketchOnTop(frame);
  const label = (id: string) => btn(frame, id).getAttribute('aria-label');

  // B2: at 1150 and 1000 px, Tangent arc dragged onto DRAW's last slot stays on the bar.
  for (const width of [1150, 1000]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(() => moreIds(frame, 'draw'), `Tangent arc in More at ${width}`).toContain('sketch.arc-tangent');
    const before = await shownIds(frame, 'draw');
    const last = before[before.length - 1];
    const lastLabel = await label(last);
    await dragFromMore(
      page,
      frame,
      'draw',
      'sketch.arc-tangent',
      async () => {
        const b = (await btn(frame, last).boundingBox())!;
        return { x: b.x + b.width * 0.75, y: b.y + b.height / 2 };
      },
      async () => {
        await expect(frame.locator('[data-tb-drop-note]')).toHaveText(`${lastLabel} moves to More`);
        await expect(btn(frame, last)).toHaveClass(/is-displaced/);
      },
    );
    await expect.poll(() => shownIds(frame, 'draw'), `DRAW at ${width}`).toEqual([...before.slice(0, -1), 'sketch.arc-tangent']);
    await expect(btn(frame, 'sketch.arc-tangent')).toBeVisible();
    expect(await moreIds(frame, 'draw')).toContain(last);
    if (width === 1150) await page.screenshot({ path: test.info().outputPath('narrow-1150-after.png') });
    // A narrower frame folds the group's other commands first: Tangent arc stays.
    await page.setViewportSize({ width: 900, height: 900 });
    await expect.poll(() => shownIds(frame, 'draw')).toContain('sketch.arc-tangent');
    await page.setViewportSize({ width, height: 900 });
    await resetToolbar(frame);
  }

  // B2 for the keyboard's way: Swap with at 1000 px keeps Spline on the bar.
  await expect.poll(() => moreIds(frame, 'draw')).toContain('sketch.spline');
  const before = await shownIds(frame, 'draw');
  const last = before[before.length - 1];
  await tb(frame).locator('[data-tb-more="draw"]').click();
  await menu(frame).locator('[data-command="sketch.spline"]').click({ button: 'right', force: true });
  await expect(menu(frame).locator('[data-menu-item="tb-swap"]')).toHaveText(`Swap with ${await label(last)}`);
  await menu(frame).locator('[data-menu-item="tb-swap"]').click();
  await expect.poll(() => shownIds(frame, 'draw')).toEqual([...before.slice(0, -1), 'sketch.spline']);
  await expect(btn(frame, 'sketch.spline')).toBeVisible();
  await resetToolbar(frame);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await expect.poll(() => shownIds(frame, 'draw')).toEqual(['sketch.line', 'sketch.rectangle', 'sketch.circle', 'sketch.arc', 'sketch.spline']);

  // S5: the window loses the press mid-drag (alt-tab): the drag ends, the release later drops nothing.
  const stored = await userLayout(request);
  const more = tb(frame).locator('[data-tb-more="draw"]');
  await more.click();
  let at = centre((await menu(frame).locator('[data-command="sketch.arc-tangent"]').boundingBox())!);
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  const spline = centre((await btn(frame, 'sketch.spline').boundingBox())!);
  await page.mouse.move(spline.x, spline.y, { steps: 10 });
  await expect(ghost(frame)).toHaveAttribute('data-drop', 'bar');
  await frame.locator('[data-cad-app]').evaluate(() => window.dispatchEvent(new Event('blur')));
  await expect(ghost(frame)).toHaveCount(0);
  await page.mouse.up();
  expect(await shownIds(frame, 'draw')).toEqual(['sketch.line', 'sketch.rectangle', 'sketch.circle', 'sketch.arc', 'sketch.spline']);
  expect(await userLayout(request)).toEqual(stored);
  // A move with no button held (the release went unheard) ends it too, and drops nothing.
  await more.click();
  at = centre((await menu(frame).locator('[data-command="sketch.arc-tangent"]').boundingBox())!);
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.move(spline.x, spline.y, { steps: 10 });
  await expect(ghost(frame)).toHaveAttribute('data-drop', 'bar');
  await frame.locator('[data-cad-app]').evaluate((_el, [x, y]) => window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, pointerType: 'mouse', buttons: 0, clientX: x, clientY: y, bubbles: true })), [spline.x, spline.y] as [number, number]);
  await expect(ghost(frame)).toHaveCount(0);
  await page.mouse.up();
  expect(await userLayout(request)).toEqual(stored);
  // Nothing stray is left: the next click on a toolbar command runs it.
  await btn(frame, 'sketch.line').click();
  await expect.poll(() => sketchTool(frame)).toBe('line');
  await page.keyboard.press('Escape');

  // S6: a press on a More item, 8 px of hand movement, release on it: the item runs.
  await more.click();
  const item = menu(frame).locator('[data-command="sketch.centerline"]');
  at = centre((await item.boundingBox())!);
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.move(at.x + 8, at.y + 2, { steps: 4 });
  await expect(ghost(frame)).toHaveCount(0);
  await page.mouse.up();
  await expect(menu(frame)).toHaveCount(0);
  await expect.poll(() => sketchTool(frame)).toBe('centerline');
  await page.keyboard.press('Escape');

  // A toggle in More (Construction, DRAW's construction drawing) shows its state as a check mark,
  // a menuitemcheckbox, not as the hover look (review N2).
  await more.click();
  const cons = menu(frame).locator('[data-command="sketch.construction"]');
  await expect(cons).toHaveAttribute('role', 'menuitemcheckbox');
  await expect(cons).toHaveAttribute('aria-checked', 'false');
  await expect(cons.locator('.cad-menu-check')).not.toHaveAttribute('data-on', '1');
  await cons.click();
  await expect(menu(frame)).toHaveCount(0);
  await more.click();
  await expect(cons).toHaveAttribute('aria-checked', 'true');
  await expect(cons.locator('.cad-menu-check')).toHaveAttribute('data-on', '1');
  await cons.click();
  await more.click();
  await expect(cons).toHaveAttribute('aria-checked', 'false');
  await page.keyboard.press('Escape');
  await expect(menu(frame)).toHaveCount(0);

  // Enter on a More menu item runs that item, not Finish sketch.
  await more.click();
  const focused = menu(frame).locator('button[role^="menuitem"]:focus');
  await expect(focused).toHaveCount(1);
  expect(await focused.getAttribute('data-command')).toBe('sketch.rectangle-center');
  await page.keyboard.press('Enter');
  await expect(menu(frame)).toHaveCount(0);
  await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
  await expect.poll(() => sketchTool(frame)).toBe('rectangle-center');
  await page.keyboard.press('Escape');
  // A button the keyboard reached (Tab from Line to Rectangle): Enter runs it, the sketch stays open.
  await btn(frame, 'sketch.line').focus();
  await page.keyboard.press('Tab');
  await expect.poll(() => frame.locator('[data-cad-app]').evaluate(() => document.activeElement?.getAttribute('data-command') ?? null)).toBe('sketch.rectangle');
  await page.keyboard.press('Enter');
  await expect.poll(() => sketchTool(frame)).toBe('rectangle-corner');
  await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
  await page.keyboard.press('Escape');
  // A button clicked with the MOUSE keeps the focus but not Enter: Enter does what it always did
  // (Finish sketch), as after Daniel clicks Rectangle, draws and presses Enter.
  await btn(frame, 'sketch.circle').click();
  await expect.poll(() => sketchTool(frame)).toBe('circle');
  await page.keyboard.press('Escape');
  await expect.poll(() => frame.locator('[data-cad-app]').evaluate(() => document.activeElement?.getAttribute('data-command') ?? null)).toBe('sketch.circle');
  await page.keyboard.press('Enter');
  await expect(frame.locator('[data-cad-toolbar="model"]')).toBeVisible();
  expect(seen.errors, 'console errors').toEqual([]);
  await forgetUserLayout(request);
});
