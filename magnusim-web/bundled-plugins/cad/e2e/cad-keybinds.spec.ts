// Keybinds (Daniel 2026-10-27: "set keybind ... shows the current keybind and also lets me change
// it"), in the real host frame:
//  - the Set keybind dialog (opened through the test handle for a sketch command from model mode; a
//    right-click on a row of the views menu opens it too): Rectangle to Shift+R takes Show
//    relations' key (Replace); Shift+R then starts the rectangle in a sketch and plain R does not;
//    the tooltip says Shift+R; Reset to default brings R back;
//  - a change made outside the page (ws.prefs written on the server, as the app's Settings saves it,
//    and announced to the app's tabs) takes effect at once, without reopening the Part;
//  - the toolbar's right-click menus have Set keybind... for the command right-clicked: a command on
//    the bar, VIEW's Fit, a command in its group's More, and a flyout's button (for the variant on it).
// The keybinds are the user's pref on the server every test shares: both run in the serial phase, and put it back.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type APIRequestContext, type FrameLocator, type Locator, type Page } from '@playwright/test';
import { baseUrl, ensureCadOn, newPartFromTree, newProject, openProject, partOpened, readWithRetry, watchPage, workspaceFrame } from './helpers';

const PREF = 'keybinds';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type W = { __CAD__: { services: any; keybinds: { model: any; open(id: string): void } } };

async function cad<T>(page: Page, fn: (arg: never) => T | Promise<T>, arg?: unknown): Promise<T> {
  return workspaceFrame(page).evaluate(fn as never, arg as never) as Promise<T>;
}

async function setPref(request: APIRequestContext, value: unknown) {
  const r = await readWithRetry(() =>
    value === null ? request.post(`${baseUrl()}/api/plugin-prefs/remove`, { data: { plugin: 'cad', key: PREF } }) : request.post(`${baseUrl()}/api/plugin-prefs/set`, { data: { plugin: 'cad', key: PREF, value } }),
  );
  expect(r.ok(), await r.text()).toBe(true);
}

/** The user's toolbar layout (ws.prefs) back to the default. */
async function forgetToolbarLayout(request: APIRequestContext) {
  for (const key of ['toolbar-layout', 'toolbar-layout.migrated']) {
    const r = await readWithRetry(() => request.post(`${baseUrl()}/api/plugin-prefs/remove`, { data: { plugin: 'cad', key } }));
    expect(r.ok(), await r.text()).toBe(true);
  }
}

async function storedPref(request: APIRequestContext): Promise<unknown> {
  const r = await readWithRetry(() => request.post(`${baseUrl()}/api/plugin-prefs/get`, { data: { plugin: 'cad', key: PREF } }));
  expect(r.ok(), await r.text()).toBe(true);
  return (await r.json()).value ?? null;
}

/** The sketch tool in hand now (null outside a sketch). */
const toolNow = (page: Page) => cad<string | null>(page, (() => (window as unknown as W).__CAD__.services.apis.get().sketch?.tool?.id ?? null) as never);
const keysOf = (page: Page, id: string) => cad<string[]>(page, ((i: string) => [...(window as unknown as W).__CAD__.keybinds.model.current(i)]) as never, id);
const shownOf = (page: Page, id: string) => cad<string | null>(page, ((i: string) => (window as unknown as W).__CAD__.services.commands.get(i)?.shortcut ?? null) as never, id);

async function enterSketchOnTop(frame: FrameLocator) {
  await frame.locator('[data-tree-node="origin:top"] > .tree-row').click();
  await frame.locator('[data-cad-toolbar] [data-command="sketch.new"]').click();
  await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
}

/** Opens Set keybind for a command as its right-click item does, and gives its field the keyboard. */
async function openDialog(page: Page, frame: FrameLocator, id: string) {
  await cad(page, ((i: string) => (window as unknown as W).__CAD__.keybinds.open(i)) as never, id);
  const dlg = frame.locator(`[data-cad-keybind-dialog="${id}"]`);
  await expect(dlg).toBeVisible();
  await dlg.locator('[data-keybind-capture]').click();
  return dlg;
}

test('cad:keybinds-dialog Set keybind: Rectangle to Shift+R (Replace takes it from Show relations), Shift+R starts it in a sketch and R does not; Reset brings R back', { tag: '@serial' }, async ({ page, request }) => {
  test.setTimeout(180_000);
  await ensureCadOn(request);
  await setPref(request, null);
  try {
    const seen = await watchPage(page);
    await openProject(page, await newProject(request));
    await newPartFromTree(page, 'Part 1');
    const frame = await partOpened(page);
    await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
    expect(await keysOf(page, 'sketch.rectangle')).toEqual(['KeyR']);

    const dlg = await openDialog(page, frame, 'sketch.rectangle');
    await expect(dlg.locator('h2')).toHaveText('Set keybind: Rectangle');
    await expect(dlg.locator('[data-keybind-current]')).toHaveText('R');
    await expect(dlg.locator('[data-keybind-capture]')).toHaveText('Press the new keys');
    await page.keyboard.press('Shift+R');
    await expect(dlg.locator('[data-keybind-status]')).toHaveText('Shift+R is the key of Show relations (sketch). Replace it?');
    await dlg.locator('[data-keybind-action="replace"]').click();
    await expect(dlg.locator('[data-keybind-current]')).toHaveText('Shift+R');
    await expect(dlg.locator('[data-keybind-status]')).toHaveText('Rectangle: Shift+R; taken from Show relations (sketch)');
    await dlg.locator('[data-keybind-action="done"]').click();
    await expect(dlg).toHaveCount(0);
    // Kept in the user's prefs, by the key's place on the keyboard.
    await expect.poll(() => storedPref(request)).toEqual({ 'sketch.rectangle': ['Shift+KeyR'], 'view.sketch-relations': [] });

    await enterSketchOnTop(frame);
    expect(await shownOf(page, 'sketch.rectangle')).toBe('Shift+R');
    await page.keyboard.press('l');
    await expect.poll(() => toolNow(page)).toBe('line');
    // Plain R is no shortcut now.
    await page.keyboard.press('r');
    await page.waitForTimeout(300);
    expect(await toolNow(page)).toBe('line');
    await page.keyboard.press('Shift+R');
    await expect.poll(() => toolNow(page)).toBe('rectangle-corner');
    // The toolbar's tooltip says the new key.
    await expect(frame.locator('[data-cad-toolbar="sketch"] [data-command="sketch.rectangle"]').first()).toHaveAttribute('aria-keyshortcuts', 'Shift+R');

    // Reset to default brings R back (Show relations keeps none until it is reset too).
    await page.keyboard.press('Escape');
    const again = await openDialog(page, frame, 'sketch.rectangle');
    await again.locator('[data-keybind-action="reset"]').click();
    await expect(again.locator('[data-keybind-current]')).toHaveText('R');
    await again.locator('[data-keybind-action="done"]').click();
    await expect(again).toHaveCount(0);
    // The keyboard back in the view (an empty place of the sketch: nothing to select).
    const canvas = frame.locator('[data-cad-viewport] canvas');
    const box = (await canvas.boundingBox())!;
    await canvas.click({ position: { x: Math.round(box.width * 0.7), y: Math.round(box.height * 0.35) } });
    await page.keyboard.press('l');
    await expect.poll(() => toolNow(page)).toBe('line');
    await page.keyboard.press('r');
    await expect.poll(() => toolNow(page)).toBe('rectangle-corner');
    await expect.poll(() => storedPref(request)).toEqual({ 'view.sketch-relations': [] });
    // The views menu's rows show their keys; a right-click on one opens Set keybind for it (Escape closes it).
    await frame.locator('[data-vp-opens="views"]').click();
    const front = frame.locator('[data-vp-pop="views"] [data-view="front"]');
    await expect(front.locator('kbd')).toHaveText('1');
    await front.click({ button: 'right' });
    const viewDlg = frame.locator('[data-cad-keybind-dialog="view.front"]');
    await expect(viewDlg).toBeVisible();
    await expect(viewDlg.locator('h2')).toHaveText('Set keybind: Front view');
    await expect(viewDlg.locator('[data-keybind-current]')).toHaveText('1');
    await expect(frame.locator('[data-vp-pop="views"]')).toHaveCount(0);
    await viewDlg.locator('[data-keybind-capture]').click();
    // A key two commands have: the question names both and where each works (Replace would take it from both).
    await page.keyboard.press('Delete');
    await expect(viewDlg.locator('[data-keybind-status]')).toHaveText('Delete is the key of Delete selected features (model) and Delete (sketch). Replace both?');
    await viewDlg.locator('[data-keybind-action="cancel"]').click();
    await viewDlg.locator('[data-keybind-capture]').click();
    await page.keyboard.press('Escape');
    await expect(viewDlg).toHaveCount(0);
    expect(await keysOf(page, 'view.front')).toEqual(['Digit1']);
    expect(seen.errors).toEqual([]);
  } finally {
    await setPref(request, null);
  }
});

test('cad:keybinds-live a keybind saved outside the page (Settings) applies at once, without reopening the Part', { tag: '@serial' }, async ({ page, request }) => {
  test.setTimeout(180_000);
  await ensureCadOn(request);
  await setPref(request, null);
  try {
    await openProject(page, await newProject(request));
    await newPartFromTree(page, 'Part 1');
    const frame = await partOpened(page);
    await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
    await enterSketchOnTop(frame);
    await page.keyboard.press('r');
    await expect.poll(() => toolNow(page)).toBe('rectangle-corner');
    await page.keyboard.press('l');
    await expect.poll(() => toolNow(page)).toBe('line');
    // Settings stores ws.prefs on the server and tells the app's tabs (the host's prefs channel).
    const value = { 'sketch.rectangle': ['KeyG'] };
    await setPref(request, value);
    await page.evaluate((v) => {
      const ch = new BroadcastChannel('magnusim-plugin-prefs');
      ch.postMessage({ plugin: 'cad', key: 'keybinds', value: v, from: 'settings-e2e' });
      ch.close();
    }, value);
    await expect.poll(() => keysOf(page, 'sketch.rectangle')).toEqual(['KeyG']);
    expect(await shownOf(page, 'sketch.rectangle')).toBe('G');
    await page.keyboard.press('r');
    await page.waitForTimeout(300);
    expect(await toolNow(page)).toBe('line');
    await page.keyboard.press('g');
    await expect.poll(() => toolNow(page)).toBe('rectangle-corner');
    // Settings' reset (the pref removed) brings the defaults back, live too.
    await setPref(request, null);
    await page.evaluate(() => {
      const ch = new BroadcastChannel('magnusim-plugin-prefs');
      ch.postMessage({ plugin: 'cad', key: 'keybinds', value: null, from: 'settings-e2e' });
      ch.close();
    });
    await expect.poll(() => keysOf(page, 'sketch.rectangle')).toEqual(['KeyR']);
    await page.keyboard.press('l');
    await expect.poll(() => toolNow(page)).toBe('line');
    await page.keyboard.press('r');
    await expect.poll(() => toolNow(page)).toBe('rectangle-corner');
    // The words that name a key follow it (review): the Construction badge says Construction's key,
    // and changes with it while it shows; Line's tooltip names 3-point arc's key.
    await page.keyboard.press('x');
    const badge = frame.locator('[data-sketch-construction-badge]');
    const badgeText = badge.locator('[data-sketch-construction-text]');
    await expect(badgeText).toHaveText('Construction · X');
    const moved = { 'sketch.construction': ['Shift+KeyX'], 'sketch.arc': ['Shift+KeyA'] };
    await setPref(request, moved);
    await page.evaluate((v) => {
      const ch = new BroadcastChannel('magnusim-plugin-prefs');
      ch.postMessage({ plugin: 'cad', key: 'keybinds', value: v, from: 'settings-e2e' });
      ch.close();
    }, moved);
    await expect(badgeText).toHaveText('Construction · Shift+X');
    await expect(badge).toHaveAttribute('title', /Shift\+X or × turns it off\.$/);
    await expect(badge.locator('[data-sketch-construction-off]')).toHaveAttribute('title', 'Turn off construction (Shift+X)');
    expect(await cad<string>(page, (() => (window as unknown as W).__CAD__.services.commands.get('sketch.line').hint) as never)).toBe(
      'Chained lines, click by click; Shift+A or a drag from the end makes a tangent arc',
    );
    await page.keyboard.press('Shift+X');
    await expect(badge).toBeHidden();
  } finally {
    await setPref(request, null);
  }
});

test("cad:keybinds-toolbar-menu Set keybind on the toolbar: a bar command, Fit, a More item, a flyout (its variant), a flyout's arrow and list item, VIEW's More and a collapsed group's dropdown each open the dialog for that command", { tag: '@serial' }, async ({ page, request }) => {
  test.setTimeout(180_000);
  await ensureCadOn(request);
  await setPref(request, null);
  await forgetToolbarLayout(request);
  try {
    const seen = await watchPage(page);
    await openProject(page, await newProject(request));
    await newPartFromTree(page, 'Part 1');
    const frame = await partOpened(page);
    await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
    const bar = frame.locator('[data-cad-toolbar]');
    const menu = frame.locator('[data-cad-menu]');
    /** Right-click `target`, pick Set keybind, see the dialog for `id` with its current key, close it. */
    const viaMenu = async (target: Locator, id: string, label: string, current: string | null) => {
      await target.click({ button: 'right', force: true });
      await expect(menu).toBeVisible();
      const item = menu.locator('[data-menu-item="set-keybind"]');
      await expect(item).toHaveText('Set keybind…');
      await item.click();
      await expect(menu).toHaveCount(0);
      const dlg = frame.locator(`[data-cad-keybind-dialog="${id}"]`);
      await expect(dlg).toBeVisible();
      await expect(dlg.locator('h2')).toHaveText(`Set keybind: ${label}`);
      if (current != null) await expect(dlg.locator('[data-keybind-current]')).toHaveText(current);
      await dlg.locator('[data-keybind-action="done"]').click();
      await expect(dlg).toHaveCount(0);
    };

    // A command on the bar, and VIEW's Fit (its menu was Reset toolbar alone).
    await viaMenu(bar.locator('.tb-btn[data-command="solid.extrude"]'), 'solid.extrude', 'Extrude', 'E');
    await viaMenu(bar.locator('.tb-btn[data-command="view.fit"]'), 'view.fit', 'Fit', 'F');

    // A command in its group's More: Revolve moved there, then right-clicked in the open More.
    await bar.locator('.tb-btn[data-command="solid.revolve"]').click({ button: 'right', force: true });
    await menu.locator('[data-menu-item="tb-to-more"]').click();
    await expect(menu).toHaveCount(0);
    await bar.locator('[data-tb-more="solid"]').click();
    await viaMenu(menu.locator('[data-command="solid.revolve"]'), 'solid.revolve', 'Revolve', 'None');

    // A flyout: its button runs the variant used last, and Set keybind is for that variant.
    await frame.locator('[data-tree-node="origin:top"] > .tree-row').click();
    await bar.locator('[data-command="sketch.new"]').click();
    await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
    const arrow = bar.locator('[data-tb-flyout][data-flyout-commands~="sketch.slot-arc-center"]');
    await arrow.click();
    await expect(arrow).toHaveAttribute('aria-expanded', 'true');
    await menu.locator('[data-command="sketch.slot-arc-center"]').click();
    await expect(menu).toHaveCount(0);
    await page.keyboard.press('Escape');
    const slotButton = bar.locator('.tb-btn[data-variant="sketch.slot-arc-center"]');
    await expect(slotButton).toHaveCount(1);
    const variantLabel = await cad<string>(page, (() => (window as unknown as W).__CAD__.services.commands.get('sketch.slot-arc-center').label) as never);
    await viaMenu(slotButton, 'sketch.slot-arc-center', variantLabel, 'None');
    const labelOf = (id: string) => cad<string>(page, ((i: string) => (window as unknown as W).__CAD__.services.commands.get(i).label) as never, id);

    // Review 3 of the integration: a flyout's arrow (the variant on its button) and an item of its
    // list (that variant) have Set keybind too.
    const rectArrow = bar.locator('[data-tb-flyout="sketch.rectangle"]');
    await viaMenu(rectArrow, 'sketch.rectangle', 'Rectangle', 'R');
    await rectArrow.click();
    await expect(rectArrow).toHaveAttribute('aria-expanded', 'true');
    await viaMenu(menu.locator('[data-command="sketch.rectangle-center"]'), 'sketch.rectangle-center', await labelOf('sketch.rectangle-center'), null);

    // VIEW narrowed by the person: its More's items have Set keybind (and Reset toolbar).
    const viewLine = bar.locator('[data-tb-resize="view"]');
    const vb = (await viewLine.boundingBox())!;
    await page.mouse.move(vb.x + vb.width / 2, vb.y + vb.height / 2);
    await page.mouse.down();
    await page.mouse.move(vb.x - 300, vb.y + vb.height / 2, { steps: 6 });
    await page.mouse.up();
    const viewMore = bar.locator('[data-tb-more="view"]');
    await expect(viewMore).toBeVisible();
    const viewFolded = ((await viewMore.getAttribute('data-more-commands')) ?? '').split(' ').filter(Boolean);
    expect(viewFolded.length).toBeGreaterThan(0);
    await viewMore.click();
    await menu.locator(`[data-command="${viewFolded[0]}"]`).click({ button: 'right', force: true });
    await expect(menu.locator('[data-menu-item="tb-reset"]')).toBeVisible();
    await page.keyboard.press('Escape');
    await viewMore.click();
    await viaMenu(menu.locator(`[data-command="${viewFolded[0]}"]`), viewFolded[0], await labelOf(viewFolded[0]), null);

    // A frame narrow enough that a sketch group collapses into one dropdown: its items have Set keybind.
    let collapsed = '';
    for (let w = 900; w >= 480 && !collapsed; w -= 20) {
      await page.setViewportSize({ width: w, height: 900 });
      await expect.poll(() => frame.locator('[data-cad-app]').evaluate(() => window.innerWidth)).toBe(w);
      await frame.locator('[data-cad-app]').evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      collapsed = ((await bar.getAttribute('data-fit-collapsed')) ?? '').split(' ').filter(Boolean)[0] ?? '';
    }
    expect(collapsed, 'a collapsed group').not.toBe('');
    const dropdown = bar.locator(`[data-tb-group-menu="${collapsed}"]`);
    const inside = ((await dropdown.getAttribute('data-more-commands')) ?? '').split(' ').filter(Boolean);
    await dropdown.click();
    await viaMenu(menu.locator(`[data-command="${inside[0]}"]`), inside[0], await labelOf(inside[0]), null);

    // Nothing was changed: the keybinds stay the defaults.
    expect(await storedPref(request)).toBeNull();
    expect(seen.errors).toEqual([]);
  } finally {
    await setPref(request, null);
    await forgetToolbarLayout(request);
  }
});
