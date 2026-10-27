// The ribbon resized as Excel's (v0.5.0, Daniel: "resizable groups and multi-row"), and its sizes
// from one scale factor, as the person meets them with the mouse and the keyboard:
//   - every size of the ribbon follows --cad-toolbar-scale (1 by default; the host's appearance
//     setting is to drive it): a small button's row, its icon, a large button's icon, the names;
//   - the line between two groups shows a col-resize pointer; dragged left it narrows the group
//     (DRAW): what does not fit goes into the group's own More, the least used first; dragged back
//     right everything comes back out (no More); a double-click sets it back to as wide as its
//     commands; Left / Right on the focused line step it;
//   - the toolbar's bottom edge (row-resize) dragged up makes it two rows, then one (no large
//     buttons below three rows, everything still on the toolbar or in a More); dragged down, four;
//   - the layout (a width, the rows) is the person's, per toolbar: kept through a reload, the model
//     toolbar unchanged by the sketch toolbar's; Reset toolbar (right-click) brings the defaults;
//   - screenshots: the sketch ribbon with DRAW narrowed, at two rows, and at scale 1.25.
// The layout is the user's (host plugin prefs, one file per plugin on the test server): every test
// here runs in the serial phase and starts and ends with no user layout.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { baseUrl, newPartFromTree, newProject, openProject, partOpened, runCommand, watchPage } from './helpers';

type Request = Parameters<typeof newProject>[0];

const SHOTS = process.env.CAD_E2E_SHOTS || '';
async function shot(page: Page, frame: FrameLocator, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  const box = (await frame.locator('[data-cad-toolbar]').boundingBox())!;
  await page.screenshot({ path: join(SHOTS, `${name}.png`), clip: { x: 0, y: 0, width: page.viewportSize()!.width, height: Math.ceil(box.y + box.height + 24) } });
}

const tb = (frame: FrameLocator) => frame.locator('[data-cad-toolbar]');
const group = (frame: FrameLocator, g: string) => tb(frame).locator(`.tb-group[data-group="${g}"]`);
const menu = (frame: FrameLocator) => frame.locator('[data-cad-menu]');

async function userLayout(request: Request): Promise<{ model?: { rows?: number; widths?: Record<string, number> }; sketch?: { rows?: number; widths?: Record<string, number> } } | null> {
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

/** Two frames after a change: the ribbon's fit (before paint) has run. */
async function settled(frame: FrameLocator) {
  await frame.locator('[data-cad-app]').evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

/** Drags from the centre of `el` by (dx, dy) with the mouse. */
async function dragBy(page: Page, el: ReturnType<FrameLocator['locator']>, dx: number, dy: number) {
  const b = (await el.boundingBox())!;
  const x = b.x + b.width / 2;
  const y = b.y + b.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 8 });
  await page.mouse.up();
}

/** In the frame: a small button's and a large button's sizes, and the toolbar's height. */
async function sizes(frame: FrameLocator) {
  return tb(frame).evaluate((el) => {
    const r = (sel: string) => el.querySelector(sel)!.getBoundingClientRect();
    return {
      smallH: r('.tb-btn.is-small[data-command="sketch.extend"]').height,
      smallIcon: r('.tb-btn.is-small[data-command="sketch.extend"] .tb-svg').width,
      largeIcon: r('.tb-btn.is-large[data-command="sketch.trim"] .tb-svg').width,
      font: parseFloat(getComputedStyle(el.querySelector('.tb-btn[data-command="sketch.extend"]')!).fontSize),
      bar: el.getBoundingClientRect().height,
    };
  });
}

test('cad:toolbar-resize the ribbon follows one scale factor; a group narrowed by its line puts what does not fit in its More and gets it back when widened; the bottom edge sets the rows; kept per toolbar through a reload; Reset toolbar', { tag: '@serial' }, async ({ page, request }) => {
  await forgetUserLayout(request);
  await page.setViewportSize({ width: 1920, height: 1000 });
  const seen = await watchPage(page);
  await openProject(page, await newProject(request));
  await newPartFromTree(page, 'Part 1');
  let frame = await partOpened(page);
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  await expect(tb(frame)).toHaveAttribute('data-layout-ready', '1');
  const modelHeight = (await tb(frame).boundingBox())!.height;
  await sketchOnTop(frame);
  await settled(frame);

  // ---- one scale factor: 1 by default (22 px rows, 18 px small icons, 28 px large ones, 11 px names).
  const base = await sizes(frame);
  expect(base).toMatchObject({ smallH: 22, smallIcon: 18, largeIcon: 28, font: 11 });
  await frame.locator('[data-cad-app]').evaluate(() => document.documentElement.style.setProperty('--cad-toolbar-scale', '1.25'));
  await settled(frame);
  const big = await sizes(frame);
  expect(big.smallH).toBeCloseTo(27.5, 0);
  expect(big.smallIcon).toBeCloseTo(22.5, 0);
  expect(big.largeIcon).toBeCloseTo(35, 0);
  expect(big.font).toBeCloseTo(13.75, 1);
  expect(big.bar).toBeGreaterThan(base.bar * 1.15);
  await page.mouse.move(900, 600);
  await shot(page, frame, 'sketch-ribbon-1920-scale-1.25');
  await frame.locator('[data-cad-app]').evaluate(() => document.documentElement.style.removeProperty('--cad-toolbar-scale'));
  await settled(frame);
  expect((await sizes(frame)).smallH).toBe(22);

  // ---- the line at DRAW's right: a col-resize pointer; dragged left, DRAW narrows and folds.
  const line = tb(frame).locator('[data-tb-resize="draw"]');
  await expect(line).toHaveAttribute('role', 'separator');
  expect(await line.evaluate((el) => getComputedStyle(el).cursor)).toBe('col-resize');
  const w0 = (await group(frame, 'draw').locator('.tb-items').boundingBox())!.width;
  await expect(tb(frame).locator('[data-tb-more="draw"]')).toHaveCount(0);
  await dragBy(page, line, -150, 0);
  await expect(group(frame, 'draw')).toHaveAttribute('data-width', String(Math.round(w0 - 150)));
  await settled(frame);
  const narrowed = Number(await group(frame, 'draw').getAttribute('data-width-folded'));
  expect(narrowed, 'commands folded for the narrower DRAW').toBeGreaterThan(0);
  const more = tb(frame).locator('[data-tb-more="draw"]');
  await expect(more).toBeVisible();
  // The least used go first (FOLD_ORDER: Point, Construction, Ellipse, ...); Line never.
  const inMore = ((await more.getAttribute('data-more-commands')) ?? '').split(' ');
  expect(inMore).toContain('sketch.point');
  expect(inMore).not.toContain('sketch.line');
  // Nothing spills out of the group: its items fit the width the person set.
  expect(await group(frame, 'draw').locator('.tb-items').evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  expect((await group(frame, 'draw').locator('.tb-items').boundingBox())!.width).toBeCloseTo(w0 - 150, 0);
  // Everything in that More is reachable from the keyboard: Down opens it on its first command.
  await more.focus();
  await page.keyboard.press('ArrowDown');
  await expect(menu(frame)).toBeVisible();
  await expect(menu(frame).locator('button[role^="menuitem"]')).toHaveCount(inMore.length);
  await page.keyboard.press('Escape');
  await expect(menu(frame)).toHaveCount(0);
  await expect.poll(async () => (await userLayout(request))?.sketch?.widths).toEqual({ draw: Math.round(w0 - 150) });
  await page.mouse.move(900, 600);
  await shot(page, frame, 'sketch-ribbon-draw-narrowed');
  // Wider again: everything comes back out of More (the bar is full).
  await dragBy(page, line, 400, 0);
  await settled(frame);
  await expect(group(frame, 'draw')).toHaveAttribute('data-width-folded', '0');
  await expect(tb(frame).locator('[data-tb-more="draw"]')).toHaveCount(0);
  // A double-click: as wide as its commands again.
  await line.dblclick();
  await expect(group(frame, 'draw')).not.toHaveAttribute('data-width', /.+/);
  expect((await group(frame, 'draw').locator('.tb-items').boundingBox())!.width).toBeCloseTo(w0, 0);
  // The keyboard: Left on the focused line narrows it a step, Home sets it back.
  await line.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(group(frame, 'draw')).toHaveAttribute('data-width', String(Math.round(w0 - 16)));
  await page.keyboard.press('Home');
  await expect(group(frame, 'draw')).not.toHaveAttribute('data-width', /.+/);

  // ---- the bottom edge: rows. Up: two rows, then one (no large buttons); down: four.
  const handle = tb(frame).locator('[data-tb-rows-handle]');
  expect(await handle.evaluate((el) => getComputedStyle(el).cursor)).toBe('row-resize');
  await expect(tb(frame)).toHaveAttribute('data-rows', '3');
  const h3 = (await tb(frame).boundingBox())!.height;
  await dragBy(page, handle, 0, -23);
  await expect(tb(frame)).toHaveAttribute('data-rows', '2');
  await settled(frame);
  await expect(tb(frame).locator('.tb-btn.is-large')).toHaveCount(0);
  expect((await tb(frame).boundingBox())!.height).toBeLessThan(h3 - 15);
  // Every sketch command is still a button or in a More.
  const reach = await tb(frame).evaluate((el) => [
    ...Array.from(el.querySelectorAll('.tb-btn[data-command]')).map((b) => b.getAttribute('data-command')),
    ...Array.from(el.querySelectorAll('[data-tb-more]')).flatMap((m) => (m.getAttribute('data-more-commands') ?? '').split(' ')),
  ]);
  for (const id of ['sketch.line', 'sketch.trim', 'sketch.dimension', 'sketch.finish', 'sketch.point', 'sketch.intersect']) expect(reach, `${id} at two rows`).toContain(id);
  await page.mouse.move(900, 600);
  await shot(page, frame, 'sketch-ribbon-2-rows');
  await dragBy(page, handle, 0, -23);
  await expect(tb(frame)).toHaveAttribute('data-rows', '1');
  await dragBy(page, handle, 0, 3 * 23);
  await expect(tb(frame)).toHaveAttribute('data-rows', '4');
  await expect(tb(frame).locator('.tb-btn.is-large[data-command="sketch.line"]')).toHaveCount(1);
  // Up / Down on the focused edge step it.
  await handle.focus();
  await page.keyboard.press('ArrowUp');
  await expect(tb(frame)).toHaveAttribute('data-rows', '3');
  await page.keyboard.press('ArrowUp');
  await expect(tb(frame)).toHaveAttribute('data-rows', '2');

  // ---- kept per toolbar, through a reload: the sketch toolbar two rows with DRAW narrowed, the
  // model toolbar as it was.
  await dragBy(page, line, -120, 0);
  await expect(group(frame, 'draw')).toHaveAttribute('data-width', /\d+/);
  const drawW = await group(frame, 'draw').getAttribute('data-width');
  await expect.poll(async () => (await userLayout(request))?.sketch).toMatchObject({ rows: 2, widths: { draw: Number(drawW) } });
  await runCommand(frame, 'sketch.finish');
  await expect(frame.locator('[data-cad-toolbar="model"]')).toBeVisible();
  await expect(tb(frame)).toHaveAttribute('data-rows', '3');
  expect((await tb(frame).boundingBox())!.height).toBeCloseTo(modelHeight, 0);
  await page.reload();
  frame = page.frameLocator('#workspace-frame');
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready', { timeout: 60_000 });
  await expect(tb(frame)).toHaveAttribute('data-layout-ready', '1');
  await sketchOnTop(frame);
  await expect(tb(frame)).toHaveAttribute('data-rows', '2');
  await expect(group(frame, 'draw')).toHaveAttribute('data-width', drawW!);

  // ---- Reset toolbar (right-click on the line): the defaults.
  await tb(frame).locator('[data-tb-resize="draw"]').click({ button: 'right' });
  await expect(menu(frame).locator('[data-menu-item="tb-width-auto"]')).toBeVisible();
  await menu(frame).locator('[data-menu-item="tb-reset"]').click();
  await expect(tb(frame)).toHaveAttribute('data-rows', '3');
  await expect(tb(frame)).toHaveAttribute('data-layout', 'default');
  await expect(group(frame, 'draw')).not.toHaveAttribute('data-width', /.+/);
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
  await forgetUserLayout(request);
});
