// The UI shell as a user meets it, in the real host frame with the real
// document service and kernel: the toolbar shows only working commands with
// tooltips; Box and Cylinder open flyouts that apply live, refuse bad input
// inline and close with Done; the design tree shows history, bodies, the
// rollback bar, suppressed / failed rows and a context menu; the Parameters
// panel drives a size; the chips show volume and save state; and the chrome
// matches the core's recipes (computed styles). No CSP violations, no
// console errors.
// Owner: UI-SHELL.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { newPartFromTree, newProject, openPart, openProject, partOpened, watchPage, workspaceFrame } from './helpers';
import { PNG } from './png';

async function freshPart(page: Page, request: Parameters<typeof newProject>[0], title = 'Part 1') {
  const seen = await watchPage(page);
  const projectId = await newProject(request);
  await openProject(page, projectId);
  const row = await newPartFromTree(page, title);
  const frame = await partOpened(page);
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  return { seen, frame, row, projectId };
}

async function shot(page: Page, name: string) {
  const dir = process.env.CAD_E2E_SHOTS;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: join(dir, `${name}.png`) });
}

/**
 * The viewport pixel at a model point (page coordinates via the viewport's own
 * projection), once the viewport shows bodies and no view transition runs.
 */
async function pixelAt(page: Page, p: [number, number, number]): Promise<string> {
  const inside = workspaceFrame(page);
  const info = await inside.evaluate((pt) => {
    type H = { project(p: number[]): [number, number] | null; state: { get(): { bodies: number; animating: boolean } } };
    const h = (window as unknown as { __CAD__: { services: { viewport: { get(): { handle: H | null } } } } }).__CAD__.services.viewport.get().handle;
    if (!h) return null;
    const s = h.state.get();
    return { xy: h.project(pt), bodies: s.bodies, animating: s.animating, w: window.innerWidth, hgt: window.innerHeight };
  }, p);
  if (!info || !info.xy || info.bodies < 1 || info.animating) return `not ready ${JSON.stringify(info)}`;
  const [x, y] = info.xy;
  if (x < 2 || y < 2 || x > info.w - 3 || y > info.hgt - 3) return `off screen ${JSON.stringify(info)}`;
  const box = await page.locator('#workspace-frame').boundingBox();
  const png = await page.screenshot({ clip: { x: box!.x + x - 2, y: box!.y + y - 2, width: 5, height: 5 } });
  return PNG.center(png).join(',');
}

/** Page coordinates of a model point (the viewport's own projection plus the frame's offset). */
async function pagePoint(page: Page, p: [number, number, number]): Promise<[number, number]> {
  const xy = await workspaceFrame(page).evaluate((pt) => {
    const h = (window as unknown as { __CAD__: { services: { viewport: { get(): { handle: { project(p: number[]): [number, number] | null } | null } } } } }).__CAD__.services.viewport.get().handle;
    return h ? h.project(pt) : null;
  }, p);
  expect(xy).not.toBeNull();
  const box = await page.locator('#workspace-frame').boundingBox();
  return [box!.x + xy![0], box!.y + xy![1]];
}

const styleOf = (loc: ReturnType<FrameLocator['locator']>, props: string[]) =>
  loc.evaluate((el, names) => {
    const s = getComputedStyle(el);
    return Object.fromEntries(names.map((n) => [n, s.getPropertyValue(n)]));
  }, props);

test('cad:p1-ui-box toolbar, Box flyout with live apply and inline errors, chips, undo and redo', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  const tb = frame.locator('[data-cad-toolbar]');
  const tree = frame.locator('[data-cad-tree]');
  const tip = frame.locator('[data-cad-tip]');

  // Only commands that work, in the core's toolbar groups.
  await expect(tb.locator('[data-group="solid"] .tb-txt')).toHaveText(['Box', 'Cylinder']);
  await expect(tb.locator('[data-group="modify"] .tb-txt')).toHaveText(['Parameters']);
  await expect(tb.locator('[data-group="edit"] .tb-txt')).toHaveText(['Undo', 'Redo']);
  await expect(tb.locator('.tb-group-label').first()).toHaveText('SOLID');
  await expect(tb.locator('.tb-group-label').last()).toHaveText('EDIT');
  const undo = tb.locator('[data-command="edit.undo"]');
  await expect(undo).toHaveAttribute('aria-disabled', 'true');
  await undo.hover();
  await expect(tip).toBeVisible();
  await expect(tip).toContainText('Undo');
  await expect(tip.locator('kbd')).toHaveText('Ctrl+Z');
  await expect(tip).toContainText('Nothing to undo');
  await tb.locator('[data-command="solid.box"]').hover();
  await expect(tip).toContainText('A box body from its size and corner position');

  // Box: the flyout opens beside the tree and the box is in the part at once.
  await tb.locator('[data-command="solid.box"]').click();
  const panel = frame.locator('[data-cad-panel="feature"]');
  await expect(panel.locator('[data-panel-title]')).toHaveText('Box 1');
  await expect(panel.locator('.mat-panel-head')).toHaveText('Box 1'); // no tick in the head
  await expect(panel.locator('.mat-panel-foot button')).toHaveText(['Delete', 'Done']);
  await expect(tb.locator('[data-command="solid.box"]')).toHaveClass(/is-active/);
  await expect(tree.locator('[data-feature-row] > .tree-row .tl')).toHaveText(['Box 1']);
  await expect(tree.locator('[data-bodies-folder] > .tree-row .tl')).toHaveText('Bodies (1)');
  const vol = frame.locator('[data-chip="volume"]');
  await expect(vol).toHaveText('Volume8000 mm³');
  const flyout = await frame.locator('[data-cad-flyout]').boundingBox();
  const card = await tree.boundingBox();
  expect(flyout!.x).toBeGreaterThan(card!.x + card!.width);

  // Live apply of a valid value; an invalid one shows why and changes nothing.
  const len = panel.locator('.nui[data-field="size.0"] input');
  await expect(len).toHaveValue('20');
  await expect(panel.locator('.nui[data-field="size.0"] [data-nui-after]')).toHaveText('mm');
  await len.fill('50');
  await len.press('Enter');
  await expect(vol).toHaveText('Volume20,000 mm³');
  await len.fill('50 kg');
  await len.press('Enter');
  await expect(panel.locator('.nui[data-field="size.0"] [data-nui-error]')).toBeVisible();
  await expect(len).toHaveAttribute('aria-invalid', 'true');
  await expect(vol).toHaveText('Volume20,000 mm³');
  await len.press('Escape');
  await expect(len).toHaveValue('50');
  await expect(panel.locator('.nui[data-field="size.0"] [data-nui-error]')).toHaveCount(0);
  const height = panel.locator('.nui[data-field="size.2"] input');
  await height.fill('0');
  await height.press('Enter');
  await expect(panel.locator('.nui[data-field="size.2"] [data-nui-error]')).toHaveText('Height must be more than 0');
  await height.press('Escape');
  // A unit typed with the value is kept; the field shows it in the part's unit.
  const cz = panel.locator('.nui[data-field="origin.2"] input');
  await cz.fill('1 in');
  await cz.press('Enter');
  await expect(cz).toHaveValue('25.4');

  // The body the panel made is drawn: Fit (the toolbar's VIEW group runs the
  // viewport's command), then a viewport pixel at its middle is not background.
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-viewport', 'ready');
  await expect(tb.locator('[data-group="view"] .tb-txt')).toHaveText(['Fit', 'Front view', 'Top view', 'Right view', 'Isometric view']);
  await tb.locator('[data-command="view.fit"]').click();
  await expect.poll(() => pixelAt(page, [25, 10, 35.4]), { timeout: 15_000 }).toMatch(/^\d+,\d+,\d+$/);
  expect(await pixelAt(page, [25, 10, 35.4])).not.toBe('240,242,247');
  await shot(page, 'ui-box-panel');

  // Done closes; the box stays; Undo is now available and names the step.
  await panel.locator('[data-panel-done]').click();
  await expect(panel).toHaveCount(0);
  await expect(undo).not.toHaveAttribute('aria-disabled', 'true');
  await undo.hover();
  await expect(tip).toContainText('Undo Box 1');
  await expect(frame.locator('[data-chip="save"]')).toHaveText('Saved', { timeout: 20_000 });

  // Right-click on the body in the viewport: the body's and its feature's actions; Edit reopens the panel.
  const mid = await pagePoint(page, [25, 10, 35.4]);
  await page.mouse.click(mid[0], mid[1], { button: 'right' });
  const menu = frame.locator('[data-cad-menu]');
  // The core's viewport items first (proposal §3.2; runtime.js showFaceCtxMenu), then the CAD ones.
  await expect(menu.locator('[data-menu-item]')).toHaveText(['Normal to', 'Orbit around this face', 'Orbit around model center', 'Orbit around origin', 'Hide Body 1', 'Rename Body 1', 'Edit Box 1', 'Rename Box 1', 'Suppress Box 1', 'Roll back to here', 'Delete Box 1']);
  await menu.locator('[data-menu-item="edit"]').click();
  await expect(menu).toHaveCount(0);
  await expect(panel.locator('[data-panel-title]')).toHaveText('Box 1');
  await expect(panel.locator('.nui[data-field="size.0"] input')).toHaveValue('50');
  await panel.locator('[data-panel-done]').click();
  await expect(panel).toHaveCount(0);

  // Keyboard: Ctrl+Z / Ctrl+Y (the frame gets keys after a click inside it until host G7).
  await tree.locator('[data-part-name] > .tree-row').click();
  await page.keyboard.press('Control+z');
  await expect(tree.locator('[data-tree-empty="history"]')).toHaveText('No features yet');
  await expect(vol).toHaveCount(0);
  await page.keyboard.press('Control+y');
  await expect(tree.locator('[data-feature-row] > .tree-row .tl')).toHaveText(['Box 1']);
  await expect(vol).toHaveText('Volume20,000 mm³');

  // A new box, then Delete in its panel discards it.
  await tb.locator('[data-command="solid.box"]').click();
  await expect(panel.locator('[data-panel-title]')).toHaveText('Box 2');
  await expect(tree.locator('[data-feature-row] > .tree-row .tl')).toHaveText(['Box 1', 'Box 2']);
  await panel.locator('[data-panel-delete]').click();
  await expect(panel).toHaveCount(0);
  await expect(tree.locator('[data-feature-row] > .tree-row .tl')).toHaveText(['Box 1']);

  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

test('cad:p1-ui-parity tree, flyout, Done, toolbar and chips use the core recipes', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  const tree = frame.locator('[data-cad-tree]');
  await frame.locator('[data-command="solid.box"]').click();
  const panel = frame.locator('[data-cad-panel="feature"]');
  await expect(panel.locator('[data-panel-title]')).toHaveText('Box 1');

  // Tree rows (LeftTree rows inherit .tree-section's 11px/600: the core page computes 11px, which
  // e2e/cad-p1-document.spec.js reads live; 24px rows, 3px 8px, selected #d7e8ff) and section heads (.geo-head 11px/600 #3a4250).
  const row = tree.locator('[data-feature-row] > .tree-row').first();
  await expect(tree.locator('[data-feature-row]').first()).toHaveClass(/selected/);
  expect(await styleOf(row, ['font-size', 'min-height', 'padding-top', 'padding-left', 'background-color', 'border-radius'])).toEqual({
    'font-size': '11px',
    'min-height': '24px',
    'padding-top': '3px',
    'padding-left': '8px',
    'background-color': 'rgb(215, 232, 255)',
    'border-radius': '3px',
  });
  expect(Math.round((await row.boundingBox())!.height)).toBe(24);
  // Leaves in a folder keep the twisty column (icons line up) and the 24 px row.
  expect(Math.round((await tree.locator('[data-tree-node="origin:top"] > .tree-row').boundingBox())!.height)).toBe(24);
  const originIcon = await tree.locator('[data-tree-node="origin"] > .tree-row .tree-ico').boundingBox();
  const planeIcon = await tree.locator('[data-tree-node="origin:top"] > .tree-row .tree-ico').boundingBox();
  expect(planeIcon!.x - originIcon!.x).toBe(18);
  expect(await styleOf(tree.locator('.geo-head').first(), ['font-size', 'font-weight', 'color'])).toEqual({ 'font-size': '11px', 'font-weight': '600', color: 'rgb(58, 66, 80)' });
  expect(await styleOf(tree, ['background-color', 'border-top-color', 'border-top-left-radius', 'font-size'])).toEqual({
    'background-color': 'rgb(255, 255, 255)',
    'border-top-color': 'rgb(207, 211, 219)',
    'border-top-left-radius': '6px',
    'font-size': '12px',
  });
  expect(await styleOf(tree.locator('[data-tree-node="origin"] > .tree-row .tw'), ['width', 'color'])).toEqual({ width: '18px', color: 'rgb(106, 113, 128)' });

  // Flyout panel (PanelChrome): card, 14px/600 title, slate accent, Done recipe, Delete link.
  const card = frame.locator('[data-cad-panel="feature"]');
  expect(await styleOf(card, ['border-top-color', 'border-left-width', 'border-left-color', 'padding-top', 'padding-left', 'background-color'])).toEqual({
    'border-top-color': 'rgb(207, 211, 219)',
    'border-left-width': '3px',
    'border-left-color': 'rgb(52, 64, 84)',
    'padding-top': '10px',
    'padding-left': '12px',
    'background-color': 'rgb(255, 255, 255)',
  });
  expect(await styleOf(card.locator('[data-panel-title]'), ['font-size', 'font-weight', 'color'])).toEqual({ 'font-size': '14px', 'font-weight': '600', color: 'rgb(16, 24, 40)' });
  expect(await styleOf(card.locator('[data-panel-done]'), ['min-width', 'font-size', 'border-top-color', 'background-color', 'border-top-left-radius', 'padding-top', 'padding-left'])).toEqual({
    'min-width': '72px',
    'font-size': '11px',
    'border-top-color': 'rgb(154, 163, 178)',
    'background-color': 'rgb(238, 241, 246)',
    'border-top-left-radius': '3px',
    'padding-top': '4px',
    'padding-left': '10px',
  });
  expect(await styleOf(card.locator('[data-panel-delete]'), ['font-size', 'color', 'background-color'])).toEqual({ 'font-size': '11px', color: 'rgb(23, 92, 211)', 'background-color': 'rgba(0, 0, 0, 0)' });
  expect(await styleOf(card.locator('.mat-k').first(), ['color'])).toEqual({ color: 'rgb(102, 112, 133)' });
  expect(await styleOf(card.locator('.bc-input').first(), ['font-size', 'padding-top', 'padding-left', 'border-top-color'])).toEqual({
    'font-size': '12px',
    'padding-top': '2px',
    'padding-left': '6px',
    'border-top-color': 'rgb(208, 213, 221)',
  });

  // Toolbar (.tb-btn 10px, labels 10px/700 #6a7180, bar #f2f3f6) and chips (600 12px #344054 on white).
  expect(await styleOf(frame.locator('[data-cad-toolbar]'), ['background-color'])).toEqual({ 'background-color': 'rgb(242, 243, 246)' });
  expect(await styleOf(frame.locator('.tb-group-label').first(), ['font-size', 'font-weight', 'color'])).toEqual({ 'font-size': '10px', 'font-weight': '700', color: 'rgb(106, 113, 128)' });
  expect(await styleOf(frame.locator('[data-command="solid.box"]'), ['font-size', 'min-width', 'border-top-left-radius'])).toEqual({ 'font-size': '10px', 'min-width': '64px', 'border-top-left-radius': '4px' });
  // The core's .measure-chip (style.css:1093-1106): 600 12px/1.35 "Segoe UI", padding 8/10/8/12 (review round 1: CAD had 6/10).
  expect(await styleOf(frame.locator('[data-chip="volume"]'), ['font-size', 'font-weight', 'font-family', 'line-height', 'color', 'background-color', 'border-top-color', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left'])).toEqual({
    'font-size': '12px',
    'font-weight': '600',
    'font-family': '"Segoe UI", system-ui, sans-serif',
    'line-height': '16.2px',
    color: 'rgb(52, 64, 84)',
    'background-color': 'rgb(255, 255, 255)',
    'border-top-color': 'rgb(208, 213, 221)',
    'padding-top': '8px',
    'padding-right': '10px',
    'padding-bottom': '8px',
    'padding-left': '12px',
  });
  await shot(page, 'ui-parity');
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

test('cad:p1-ui-tree rollback bar, suppress, failed feature, rename, delete, reopen', async ({ page, request }) => {
  const { seen, frame, row: partRow } = await freshPart(page, request);
  const tb = frame.locator('[data-cad-toolbar]');
  const tree = frame.locator('[data-cad-tree]');
  const panel = frame.locator('[data-cad-panel="feature"]');
  const vol = frame.locator('[data-chip="volume"]');
  const labels = tree.locator('[data-feature-row] > .tree-row .tl');
  const menu = frame.locator('[data-cad-menu]');

  await tb.locator('[data-command="solid.box"]').click();
  await expect(vol).toHaveText('Volume8000 mm³');
  await panel.locator('[data-panel-done]').click();

  // A cylinder cut from the box: Operation shows once there is another body.
  await tb.locator('[data-command="solid.cylinder"]').click();
  await expect(panel.locator('[data-panel-title]')).toHaveText('Cylinder 1');
  await panel.locator('select[data-field="op"]').selectOption('cut');
  await expect(tree.locator('[data-bodies-folder] > .tree-row .tl')).toHaveText('Bodies (1)');
  // 8000 - quarter of a Ø20 × 20 cylinder = 6429.2 mm³
  await expect(vol).toHaveText('Volume6429.2 mm³');

  // Moved away it cuts nothing: the row turns red with a "What's wrong" tooltip; the panel foot says why.
  const cx = panel.locator('.nui[data-field="origin.0"] input');
  await cx.fill('100');
  await cx.press('Enter');
  const cyl = tree.locator('[data-feature-row][data-feature-type="cylinder"]');
  await expect(cyl).toHaveAttribute('data-state', 'error');
  await expect(cyl.locator('> .tree-row .tl')).toHaveCSS('color', 'rgb(180, 35, 24)');
  const badge = cyl.locator('[data-feature-badge="error"]');
  await expect(badge).toHaveAttribute('aria-label', /What's wrong: Nothing to cut/);
  await badge.hover();
  await expect(frame.locator('[data-cad-tip]')).toContainText("What's wrong");
  await expect(frame.locator('[data-cad-tip]')).toContainText('Nothing to cut');
  await expect(panel.locator('[data-run-reason]')).toContainText('Nothing to cut');
  await expect(vol).toHaveText('Volume8000 mm³');
  await cx.fill('0');
  await cx.press('Enter');
  await expect(cyl).toHaveAttribute('data-state', 'ok');
  await expect(vol).toHaveText('Volume6429.2 mm³');
  // Bug 2026-09-30: the badge's tooltip stayed on screen after the error was fixed
  // (the pointer never left; the badge went away under it).
  await expect(badge).toHaveCount(0);
  await expect(frame.locator('[data-cad-tip]')).toHaveCount(0);
  await expect(panel.locator('[data-run-reason]')).toHaveCount(0);
  await panel.locator('[data-panel-done]').click();
  await expect(panel).toHaveCount(0);
  await shot(page, 'ui-tree-cut');

  // Drag the rollback bar above Box 1: everything below is dimmed and not built.
  const bar = tree.locator('[data-rollback-bar]');
  const b = await bar.boundingBox();
  const first = await tree.locator('[data-feature-row] > .tree-row').first().boundingBox();
  await page.mouse.move(b!.x + 10, b!.y + b!.height / 2);
  await page.mouse.down();
  await page.mouse.move(first!.x + 30, first!.y + 6, { steps: 6 });
  await page.mouse.up();
  await expect(tree.locator('[data-feature-row][data-rolled-back]')).toHaveCount(2);
  await expect(tree.locator('[data-feature-row] > .tree-row').first()).toHaveCSS('opacity', '0.55');
  await expect(tree.locator('[data-bodies-folder] > .tree-row .tl')).toHaveText('Bodies (0)');
  await expect(vol).toHaveCount(0);
  await expect(bar).toHaveAttribute('aria-valuenow', '0');
  // Arrow keys move it back down.
  await bar.focus();
  await page.keyboard.press('ArrowDown');
  await expect(tree.locator('[data-feature-row][data-rolled-back]')).toHaveCount(1);
  await expect(vol).toHaveText('Volume8000 mm³');
  await page.keyboard.press('End');
  await expect(tree.locator('[data-feature-row][data-rolled-back]')).toHaveCount(0);
  await expect(vol).toHaveText('Volume6429.2 mm³');

  // Suppress from the context menu: the row greys and strikes through; the cut is gone.
  await cyl.locator('> .tree-row').click({ button: 'right' });
  await expect(menu.locator('[data-menu-item]')).toHaveText(['Edit Cylinder 1', 'Rename Cylinder 1', 'Suppress Cylinder 1', 'Roll back to here', 'Delete Cylinder 1']);
  await expect(menu.locator('[data-menu-item="rollback"]')).toHaveAttribute('aria-disabled', 'true');
  await menu.locator('[data-menu-item="suppress"]').click();
  await expect(menu).toHaveCount(0);
  await expect(cyl.locator('> .tree-row .tl')).toHaveCSS('text-decoration-line', 'line-through');
  await expect(cyl.locator('> .tree-row .tl')).toHaveCSS('color', 'rgb(152, 162, 179)');
  await expect(cyl.locator('.tree-sub')).toHaveText('Suppressed');
  await expect(vol).toHaveText('Volume8000 mm³');
  // Ctrl+Z brings it back.
  await tree.locator('[data-part-name] > .tree-row').click();
  await page.keyboard.press('Control+z');
  await expect(cyl.locator('.tree-sub')).toHaveCount(0);
  await expect(vol).toHaveText('Volume6429.2 mm³');

  // Rename in place (F2) with the core's rules: a duplicate is refused inline.
  await tree.locator('[data-feature-row][data-feature-type="box"] > .tree-row').click();
  await page.keyboard.press('F2');
  const input = tree.locator('[data-feature-row][data-feature-type="box"] input');
  await expect(input).toHaveValue('Box 1');
  await input.fill('cylinder 1');
  await input.press('Enter');
  await expect(tree.locator('[data-feature-row][data-feature-type="box"] [role="alert"]')).toHaveText('A feature named "Cylinder 1" already exists');
  await input.fill('Base');
  await input.press('Enter');
  await expect(labels).toHaveText(['Base', 'Cylinder 1']);

  // Double-click opens the panel on the feature.
  await cyl.locator('> .tree-row').dblclick();
  await expect(panel.locator('[data-panel-title]')).toHaveText('Cylinder 1');
  await panel.locator('[data-panel-done]').click();

  // Delete from the menu.
  await cyl.locator('> .tree-row').click({ button: 'right' });
  await menu.locator('[data-menu-item="delete"]').click();
  await expect(labels).toHaveText(['Base']);
  await expect(vol).toHaveText('Volume8000 mm³');
  await expect(frame.locator('[data-chip="save"]')).toHaveText('Saved', { timeout: 20_000 });

  // Back and reopen: the tree comes back as it was.
  await page.locator('#workspace-overlay [data-ws-back]').click();
  await expect(page.locator('#workspace-overlay')).toBeHidden();
  const again = await openPart(page, partRow);
  await expect(again.locator('[data-cad-tree] [data-feature-row] > .tree-row .tl')).toHaveText(['Base']);
  await expect(again.locator('[data-cad-tree] [data-bodies-folder] > .tree-row .tl')).toHaveText('Bodies (1)');
  await expect(again.locator('[data-chip="volume"]')).toHaveText('Volume8000 mm³');

  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

test('cad:p1-ui-params the Parameters panel drives a size; bad input is refused inline', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  const tb = frame.locator('[data-cad-toolbar]');
  const tree = frame.locator('[data-cad-tree]');
  const vol = frame.locator('[data-chip="volume"]');

  await tb.locator('[data-command="solid.box"]').click();
  await frame.locator('[data-panel-done]').click();
  await expect(vol).toHaveText('Volume8000 mm³');

  await tb.locator('[data-command="modify.parameters"]').click();
  const params = frame.locator('[data-cad-panel="params"]');
  await expect(params.locator('[data-panel-title]')).toHaveText('Parameters');
  await expect(params.locator('.mat-panel-foot button')).toHaveText(['Done']);
  await expect(params.locator('[data-params-empty]')).toHaveText('No parameters yet');
  const add = async (name: string, expr: string) => {
    await params.locator('[aria-label="New parameter name"]').fill(name);
    await params.locator('[aria-label="New parameter expression"]').fill(expr);
    await params.locator('[data-param-add-btn]').click();
  };
  await add('2x', '10');
  await expect(params.locator('[data-param-error="new"]')).toHaveText('A name starts with a letter or _ and has only letters, digits and _');
  await add('width', '40');
  await expect(params.locator('[data-param-row="width"] [data-param-value]')).toHaveText('40 mm');
  await expect(tree.locator('[data-params-row] .tl')).toHaveText('Parameters (1)');
  await add('depth', 'width / 4 + 1 mm');
  await expect(params.locator('[data-param-row="depth"] [data-param-value]')).toHaveText('11 mm');

  // A size bound to a parameter.
  await tree.locator('[data-feature-row] > .tree-row').first().dblclick();
  const panel = frame.locator('[data-cad-panel="feature"]');
  const len = panel.locator('.nui[data-field="size.0"] input');
  await len.fill('width');
  await len.press('Enter');
  await expect(panel.locator('.nui[data-field="size.0"] [data-nui-after]')).toHaveText('= 40 mm');
  await expect(vol).toHaveText('Volume16,000 mm³');
  await panel.locator('[data-panel-done]').click();

  // Change the parameter: the box follows.
  await tb.locator('[data-command="modify.parameters"]').click();
  const wexpr = params.locator('[data-param-row="width"] .nui input');
  await wexpr.fill('width * 2');
  await wexpr.press('Enter');
  await expect(params.locator('[data-param-row="width"] [data-nui-error]')).toHaveText('width cannot use itself');
  await wexpr.fill('60');
  await wexpr.press('Enter');
  await expect(vol).toHaveText('Volume24,000 mm³');
  await expect(params.locator('[data-param-row="depth"] [data-param-value]')).toHaveText('16 mm');

  // In use: refused with the document's reason.
  await params.locator('[data-param-row="width"] [data-param-delete]').click();
  await expect(params.locator('[data-param-error="width"]')).toHaveText("width can't be deleted: depth and Box 1 use it");
  await expect(params.locator('[data-param-row]')).toHaveCount(2);
  await shot(page, 'ui-params');
  await params.locator('[data-panel-done]').click();
  await expect(params).toHaveCount(0);

  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

// ---------------------------------------------------------------- review round 1

/** Type into a panel field and commit (Enter); no error may show. */
async function setField(panel: ReturnType<FrameLocator['locator']>, field: string, value: string) {
  const input = panel.locator(`.nui[data-field="${field}"] input`);
  await input.fill(value);
  await input.press('Enter');
  await expect(panel.locator(`.nui[data-field="${field}"] [data-nui-error]`)).toHaveCount(0);
}

/** The viewport looks along `n` (points 0 and 10·n land on the same pixel), after any view transition. */
async function looksAlong(page: Page, n: [number, number, number]): Promise<string> {
  return workspaceFrame(page).evaluate((dir) => {
    type H = { project(p: number[]): [number, number] | null; state: { get(): { animating: boolean } } };
    const h = (window as unknown as { __CAD__: { services: { viewport: { get(): { handle: H | null } } } } }).__CAD__.services.viewport.get().handle;
    if (!h || h.state.get().animating) return 'moving';
    const a = h.project([0, 0, 0]);
    const b = h.project([dir[0] * 10, dir[1] * 10, dir[2] * 10]);
    if (!a || !b) return 'off';
    return Math.hypot(a[0] - b[0], a[1] - b[1]) < 1 ? 'along' : `off by ${Math.hypot(a[0] - b[0], a[1] - b[1]).toFixed(1)} px`;
  }, n);
}

test('cad:p1-ui-review the behaviours review round 1 exercised: Look at, the planes eye, Roll to end, Intersect, Cylinder axis, parameters', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  const tb = frame.locator('[data-cad-toolbar]');
  const tree = frame.locator('[data-cad-tree]');
  const panel = frame.locator('[data-cad-panel="feature"]');
  const menu = frame.locator('[data-cad-menu]');
  const vol = frame.locator('[data-chip="volume"] [data-volume-mm3]');
  const labels = tree.locator('[data-feature-row] > .tree-row .tl');
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-viewport', 'ready');

  // The Origin row's eye: open while the planes are drawn (an empty part, "auto"), not pressed.
  const eye = tree.locator('[data-origin-act="planes"]');
  await expect(eye).toHaveAttribute('data-planes', 'auto');
  await expect(eye).toHaveAttribute('data-planes-drawn', '1');
  await expect(eye).toHaveAttribute('aria-pressed', 'false');

  // A plane's "Look at": the camera turns to look straight at it.
  for (const [ref, label, n] of [
    ['origin:front', 'Front plane', [0, -1, 0]],
    ['origin:top', 'Top plane', [0, 0, 1]],
  ] as const) {
    await tree.locator(`[data-tree-node="${ref}"] > .tree-row`).click({ button: 'right' });
    await expect(menu.locator('[data-menu-item]')).toHaveText(['Look at']);
    await menu.locator('[data-menu-item="look-at"]').click();
    await expect(menu).toHaveCount(0);
    await expect.poll(() => looksAlong(page, n as unknown as [number, number, number]), { message: `${label}: Look at` }).toBe('along');
  }

  // Box 1 (20 mm cube at the origin): the planes hide; the eye says so (crossed out).
  await tb.locator('[data-command="solid.box"]').click();
  await panel.locator('[data-panel-done]').click();
  await expect(vol).toHaveText('8000 mm³');
  await expect(eye).toHaveAttribute('data-planes-drawn', '0');
  // Pressed: always drawn.
  await eye.click();
  await expect(eye).toHaveAttribute('aria-pressed', 'true');
  await expect(eye).toHaveAttribute('data-planes', 'always');
  await expect(eye).toHaveAttribute('data-planes-drawn', '1');
  await eye.click();
  await expect(eye).toHaveAttribute('data-planes', 'auto');
  await expect(eye).toHaveAttribute('data-planes-drawn', '0');

  // Intersect: a Ø20 × 20 cylinder centred on the box's middle keeps only their common part, pi·10²·20.
  await tb.locator('[data-command="solid.cylinder"]').click();
  await expect(panel.locator('[data-panel-title]')).toHaveText('Cylinder 1');
  await setField(panel, 'origin.0', '10');
  await setField(panel, 'origin.1', '10');
  await panel.locator('select[data-field="op"]').selectOption('intersect');
  await expect(vol).toHaveText('6283.19 mm³');
  await expect(tree.locator('[data-bodies-folder] > .tree-row .tl')).toHaveText('Bodies (1)');
  await panel.locator('[data-panel-done]').click();
  // Its own Delete undoes it: back to the cube.
  await tree.locator('[data-feature-row][data-feature-type="cylinder"] > .tree-row').click({ button: 'right' });
  await menu.locator('[data-menu-item="delete"]').click();
  await expect(vol).toHaveText('8000 mm³');

  // The Cylinder's axis: Ø10, 30 long from (0, 10, 10), joined to the cube. Along X it
  // is inside the cube for its first 20 mm: 8000 + pi·25·10. Along Z its axis is the
  // cube's edge line x = 0: half of it overlaps the cube for 10 mm, so
  // 8000 + pi·25·30 - pi·25·10 / 2.
  await tb.locator('[data-command="solid.cylinder"]').click();
  await panel.locator('select[data-field="axis"]').selectOption('origin:x');
  await setField(panel, 'diameter', '10');
  await setField(panel, 'height', '30');
  await setField(panel, 'origin.1', '10');
  await setField(panel, 'origin.2', '10');
  await panel.locator('select[data-field="op"]').selectOption('join');
  await expect(vol).toHaveText('8785.4 mm³');
  await panel.locator('select[data-field="axis"]').selectOption('origin:z');
  await expect(vol).toHaveText('9963.5 mm³');
  await panel.locator('select[data-field="axis"]').selectOption('origin:x');
  await expect(vol).toHaveText('8785.4 mm³');
  await panel.locator('[data-panel-done]').click();
  await expect(labels).toHaveText(['Box 1', 'Cylinder 1']);

  // "Roll back to here", then "Roll to end" (offered only while the bar is not at the end).
  const bar = tree.locator('[data-rollback-bar]');
  await tree.locator('[data-feature-row][data-feature-type="box"] > .tree-row').click({ button: 'right' });
  await expect(menu.locator('[data-menu-item="roll-end"]')).toHaveCount(0);
  await menu.locator('[data-menu-item="rollback"]').click();
  await expect(bar).toHaveAttribute('aria-valuenow', '1');
  await expect(vol).toHaveText('8000 mm³');
  await tree.locator('[data-feature-row][data-feature-type="box"] > .tree-row').click({ button: 'right' });
  await expect(menu.locator('[data-menu-item="roll-end"]')).toHaveText('Roll to end');
  await menu.locator('[data-menu-item="roll-end"]').click();
  await expect(bar).toHaveAttribute('aria-valuenow', '2');
  await expect(tree.locator('[data-feature-row][data-rolled-back]')).toHaveCount(0);
  await expect(vol).toHaveText('8785.4 mm³');

  // Parameters: a cycle is refused with its path; a new one that names itself says so;
  // a unit change that does not fit says what the value is, once; a rename follows into the features.
  await tb.locator('[data-command="modify.parameters"]').click();
  const params = frame.locator('[data-cad-panel="params"]');
  const add = async (name: string, expr: string) => {
    await params.locator('[aria-label="New parameter name"]').fill(name);
    await params.locator('[aria-label="New parameter expression"]').fill(expr);
    await params.locator('[data-param-add-btn]').click();
  };
  await add('w', 'w * 2');
  await expect(params.locator('[data-param-error="new"]')).toHaveText('w cannot use itself');
  await add('a', '20');
  await add('b', 'a * 2');
  await expect(params.locator('[data-param-row="b"] [data-param-value]')).toHaveText('40 mm');
  const aexpr = params.locator('[data-param-row="a"] .nui input');
  await aexpr.fill('b / 2');
  await aexpr.press('Enter');
  await expect(params.locator('[data-param-row="a"] [data-nui-error]')).toHaveText('Circular reference: a → b → a');
  await aexpr.press('Escape');
  await expect(aexpr).toHaveValue('20 mm');
  await params.locator('[data-param-row="a"] [data-param-unit]').selectOption('scalar');
  await expect(params.locator('[data-param-error="a"]')).toHaveText('20 mm is a length, not a plain number');
  await params.locator('[data-panel-done]').click();
  // Box 1's length uses b; renaming b to depth renames it there too, and the volume stays.
  await tree.locator('[data-feature-row][data-feature-type="box"] > .tree-row').dblclick();
  await setField(panel, 'size.0', 'b');
  await expect(panel.locator('.nui[data-field="size.0"] [data-nui-after]')).toHaveText('= 40 mm');
  await panel.locator('[data-panel-done]').click();
  const withB = Number(await vol.getAttribute('data-volume-mm3'));
  await tb.locator('[data-command="modify.parameters"]').click();
  const bname = params.locator('[data-param-row="b"] .cad-param-name');
  await bname.fill('depth');
  await bname.press('Enter');
  await expect(params.locator('[data-param-row="depth"] .nui input')).toHaveValue('a * 2');
  await params.locator('[data-panel-done]').click();
  await tree.locator('[data-feature-row][data-feature-type="box"] > .tree-row').dblclick();
  await expect(panel.locator('.nui[data-field="size.0"] input')).toHaveValue('depth');
  await expect(panel.locator('.nui[data-field="size.0"] [data-nui-after]')).toHaveText('= 40 mm');
  expect(Number(await vol.getAttribute('data-volume-mm3'))).toBeCloseTo(withB, 6);
  await panel.locator('[data-panel-done]').click();

  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});
