// Review round 2, the smaller findings, each as the user meets it in the real
// host frame with the real kernel (the blockers are in cad-p1-document.spec.js):
//   - Escape in a viewport popover closes the popover only, not the feature panel under it;
//   - a selected body that is suppressed or deleted leaves the selection: the
//     volume chip falls back to the total instead of vanishing;
//   - a size field shows a value as the readouts do ("1,000,000", not "1.0000e+6"),
//     and the plain digits while it is edited (review round 3);
//   - undo of a feature inserted at the rollback bar keeps the bar where it was;
//   - an inline rename's error does not widen the tree card;
//   - a selected face wins over a coplanar face of another body (no wedge); Normal to frames the part;
//   - rolled to the start, the origin planes keep the part's size (they fit the view);
//   - plane labels sit away from the bodies, never over one;
//   - a long body name in the volume chip ends in an ellipsis; a disabled menu
//     item's reason sits beside it, not over the items under it.
// window.__CAD__ is used only to read the viewport's projection and picks, and
// (helpers.ts addSketch / addSolid) to set sketched solids up: there is no Box
// or Cylinder since decision 2026-10-01.
// Owner: INTEGRATE (review round 2).
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import { addSketch, addSolid, newPartFromTree, newProject, openProject, partOpened, watchPage, workspaceFrame } from './helpers';
import { PNG } from './png';

type Vec3 = [number, number, number];
type Loc = ReturnType<FrameLocator['locator']>;
type RGB = [number, number, number];

async function freshPart(page: Page, request: Parameters<typeof newProject>[0], title = 'Part 1') {
  const seen = await watchPage(page);
  const projectId = await newProject(request);
  await openProject(page, projectId);
  const row = await newPartFromTree(page, title);
  const frame = await partOpened(page);
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-viewport', 'ready');
  return { seen, frame, row, projectId };
}

async function setField(panel: Loc, field: string, value: string) {
  const input = panel.locator(`.nui[data-field="${field}"] input`);
  await input.fill(value);
  await input.press('Enter');
  await expect(panel.locator(`.nui[data-field="${field}"] [data-nui-error]`)).toHaveCount(0);
}

/** A sketch on Top, then the Extrude panel opened on it (as a new feature). */
async function openNewExtrude(page: Page, frame: FrameLocator) {
  await addSketch(page);
  await frame.locator('[data-cad-toolbar] [data-command="solid.extrude"]').click();
  const panel = frame.locator('[data-cad-panel="feature"]');
  await expect(panel.locator('[data-panel-title]')).toHaveText('Extrude 1');
  return panel;
}

const featureRow = (frame: FrameLocator, name: string) => frame.locator('[data-cad-tree] [data-feature-row]').filter({ has: frame.locator('> .tree-row .tl', { hasText: new RegExp(`^${name}$`) }) });

async function rowMenu(frame: FrameLocator, row: Loc, item: string) {
  await row.locator('> .tree-row').click({ button: 'right' });
  const menu = frame.locator('[data-cad-menu]');
  await menu.locator(`[data-menu-item="${item}"]`).click();
  await expect(menu).toHaveCount(0);
}

type Handle = {
  project(p: number[]): [number, number] | null;
  pick(x: number, y: number): { item: { kind: string; body?: string } } | null;
  state: { get(): { animating: boolean; bodies: number } };
};
type W = { __CAD__: { services: { viewport: { get(): { handle: unknown } } } } };

const still = (page: Page) =>
  workspaceFrame(page).evaluate(() => {
    const h = (window as unknown as W).__CAD__.services.viewport.get().handle as Handle;
    return h.state.get().animating ? 'moving' : 'still';
  });

/** Model points projected to page pixels (the frame's offset added), once no view transition runs. */
async function onPage(page: Page, pts: Vec3[]): Promise<([number, number] | null)[]> {
  await expect.poll(() => still(page)).toBe('still');
  const xy = await workspaceFrame(page).evaluate((list) => {
    const h = (window as unknown as W).__CAD__.services.viewport.get().handle as Handle;
    return list.map((p) => h.project(p));
  }, pts);
  const box = (await page.locator('#workspace-frame').boundingBox())!;
  return xy.map((p) => (p ? [box.x + p[0], box.y + p[1]] : null));
}

/** The viewport canvas in page pixels. */
async function canvasRect(page: Page) {
  const r = await workspaceFrame(page).evaluate(() => {
    const c = document.querySelector('[data-cad-viewport] canvas')!.getBoundingClientRect();
    return { x: c.left, y: c.top, w: c.width, h: c.height };
  });
  const box = (await page.locator('#workspace-frame').boundingBox())!;
  return { x: box.x + r.x, y: box.y + r.y, w: r.w, h: r.h };
}

/** Pixels (r, g, b) at page points, from one screenshot. */
async function pixels(page: Page, pts: [number, number][]): Promise<RGB[]> {
  const img = PNG.decode(await page.screenshot());
  const dpr = img.width / (page.viewportSize()!.width || img.width);
  return pts.map(([x, y]) => {
    const px = PNG.at(img, Math.round(x * dpr), Math.round(y * dpr));
    return [px[0], px[1], px[2]];
  });
}

const BG: RGB = [0xf0, 0xf2, 0xf7];
const near = (a: RGB, b: RGB, tol: number) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

test('cad:p1-review2-escape Escape in a viewport popover closes the popover, not the open feature panel', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  const panel = await openNewExtrude(page, frame);
  // Views and Selection filter: one Escape closes the popover; the panel stays (it closed too).
  for (const which of ['views', 'filter']) {
    await frame.locator(`[data-vp-opens="${which}"]`).click();
    await expect(frame.locator(`[data-vp-pop="${which}"]`)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(frame.locator(`[data-vp-pop="${which}"]`)).toHaveCount(0);
    await expect(panel, `${which}: the panel stays open`).toHaveCount(1);
  }
  // Section view: the button turns the cut on and opens its popover; Escape closes the popover only.
  await frame.locator('[data-vp-opens="section"]').click();
  await expect(frame.locator('[data-vp-pop="section"]')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(frame.locator('[data-vp-pop="section"]')).toHaveCount(0);
  await expect(panel, 'section: the panel stays open').toHaveCount(1);
  await expect(frame.locator('[data-vp-opens="section"]')).toHaveAttribute('aria-pressed', 'true');
  await frame.locator('[data-vp-opens="section"]').click();
  await expect(frame.locator('[data-vp-opens="section"]')).toHaveAttribute('aria-pressed', 'false');
  // With nothing above it, Escape closes the panel (Done: Extrude 1 is kept).
  await frame.locator('[data-cad-panel="feature"] [data-panel-title]').click();
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(frame.locator('[data-cad-tree] [data-feature-row] > .tree-row .tl')).toHaveText(['Sketch 1', 'Extrude 1']);
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

test('cad:p1-review2-volume-fallback a selected body that is suppressed or deleted leaves the selection: the chip shows the total', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  const chip = frame.locator('[data-chip="volume"]');
  const tree = frame.locator('[data-cad-tree]');
  const menu = frame.locator('[data-cad-menu]');
  await addSolid(page);
  await addSolid(page, { at: [50, 0, 0] });
  await expect(chip).toHaveText('VolumeTotal of 2 bodies · 16,000 mm³');
  await frame.locator('[data-cad-toolbar] [data-command="view.fit"]').click();
  // Right-click the second cube's front face in the viewport: it is selected (the chip says Body 2),
  // and its menu suppresses Extrude 2. The selection was left on a body that is gone, and the chip vanished.
  const onBox2 = async () => (await onPage(page, [[60, 0, 10]]))[0]!;
  let at = await onBox2();
  await page.mouse.click(at[0], at[1], { button: 'right' });
  await expect(chip).toHaveText('VolumeBody 2 · 8000 mm³');
  await menu.locator('[data-menu-item="suppress"]').click();
  await expect(featureRow(frame, 'Extrude 2')).toHaveAttribute('data-suppressed', '1');
  await expect(tree.locator('[data-bodies-folder] > .tree-row .tl')).toHaveText('Bodies (1)');
  await expect(chip).toHaveText('Volume8000 mm³');
  // Unsuppressed: the old selection is gone, so the chip is the total of both.
  await rowMenu(frame, featureRow(frame, 'Extrude 2'), 'suppress');
  await expect(chip).toHaveText('VolumeTotal of 2 bodies · 16,000 mm³');
  // Deleted from the same menu while selected: the same.
  at = await onBox2();
  await page.mouse.click(at[0], at[1], { button: 'right' });
  await expect(chip).toHaveText('VolumeBody 2 · 8000 mm³');
  await menu.locator('[data-menu-item="delete"]').click();
  await expect(tree.locator('[data-bodies-folder] > .tree-row .tl')).toHaveText('Bodies (1)');
  await expect(chip).toHaveText('Volume8000 mm³');
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

test('cad:p1-review2-size-format a size field shows 1,000,000 as the chip does; while edited it shows the plain digits', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  const chip = frame.locator('[data-chip="volume"]');
  // A 20 x 20 profile: its extrude's distance is the size field.
  const panel = await openNewExtrude(page, frame);
  const len = panel.locator('.nui[data-field="distance"] input');
  await setField(panel, 'distance', '1e6');
  // Out of the field it reads as the chip does: it read "1.0000e+6" while the chip read "400,000,000 mm³".
  await len.press('Tab');
  await expect(len).toHaveValue('1,000,000');
  await expect(chip).toHaveText('Volume400,000,000 mm³');
  // In the field: the value as stored, with no digit groups to edit around (review round 3:
  // commas are refused in numbers, as the core's number fields refuse them).
  await len.click();
  await expect(len).toHaveValue('1e6');
  await setField(panel, 'distance', '2000000');
  await len.press('Tab');
  await expect(len).toHaveValue('2,000,000');
  await expect(chip).toHaveText('Volume800,000,000 mm³');
  await setField(panel, 'distance', '12345.678');
  await len.press('Tab');
  await expect(len).toHaveValue('12,345.7');
  await setField(panel, 'distance', '20');
  await len.press('Tab');
  await expect(len).toHaveValue('20');
  await expect(chip).toHaveText('Volume8000 mm³');
  await panel.locator('[data-panel-done]').click();
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

test('cad:p1-review2-undo-insert undo of a feature inserted at the rollback bar keeps the features below the bar rolled back', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  const tree = frame.locator('[data-cad-tree]');
  const bar = tree.locator('[data-rollback-bar]');
  const labels = tree.locator('[data-feature-row] > .tree-row .tl');
  await addSolid(page);
  await addSolid(page, { circle: true, at: [40, 0, 0] });
  await rowMenu(frame, featureRow(frame, 'Extrude 1'), 'rollback');
  await expect(bar).toHaveAttribute('aria-valuenow', '2');
  await expect(featureRow(frame, 'Extrude 2')).toHaveAttribute('data-rolled-back', /.*/);
  // Insert at the bar (one edit: a sketch).
  await addSketch(page, { at: [0, 40] });
  await expect(labels).toHaveText(['Sketch 1', 'Extrude 1', 'Sketch 3', 'Sketch 2', 'Extrude 2']);
  await expect(bar).toHaveAttribute('aria-valuenow', '3');
  // Undo it: the bar stays above Sketch 2 (it jumped to the end and brought Extrude 2 back).
  await tree.locator('[data-part-name] > .tree-row').click();
  await page.keyboard.press('Control+z');
  await expect(labels).toHaveText(['Sketch 1', 'Extrude 1', 'Sketch 2', 'Extrude 2']);
  await expect(bar).toHaveAttribute('aria-valuenow', '2');
  await expect(featureRow(frame, 'Extrude 2')).toHaveAttribute('data-rolled-back', /.*/);
  await expect(featureRow(frame, 'Extrude 2').locator('> .tree-row')).toHaveCSS('opacity', '0.55');
  await expect(frame.locator('[data-chip="volume"]')).toHaveText('Volume8000 mm³');
  // Redo: the sketch is back above the bar.
  await page.keyboard.press('Control+y');
  await expect(labels).toHaveText(['Sketch 1', 'Extrude 1', 'Sketch 3', 'Sketch 2', 'Extrude 2']);
  await expect(bar).toHaveAttribute('aria-valuenow', '3');
  await expect(featureRow(frame, 'Sketch 3')).not.toHaveAttribute('data-rolled-back', /.*/);
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

test('cad:p1-review2-rename-error an inline rename error wraps inside the tree card; the card keeps its width', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  const tree = frame.locator('[data-cad-tree]');
  await addSolid(page);
  await addSolid(page, { circle: true, at: [40, 0, 0] });
  const before = (await tree.boundingBox())!.width;
  await featureRow(frame, 'Extrude 2').locator('> .tree-row').click();
  await page.keyboard.press('F2');
  const input = tree.locator('input[aria-label="Feature name"]');
  await input.fill('Extrude 1');
  await input.press('Enter');
  const err = tree.locator('.cad-rename-err');
  await expect(err).toHaveText('A feature named "Extrude 1" already exists');
  // It widened the card from 231 to 252 px before.
  expect(Math.abs((await tree.boundingBox())!.width - before), 'tree card width').toBeLessThan(0.5);
  const e = (await err.boundingBox())!;
  const t = (await tree.boundingBox())!;
  expect(e.x + e.width).toBeLessThanOrEqual(t.x + t.width);
  expect(await tree.evaluate((el) => el.scrollWidth - el.clientWidth)).toBe(0);
  await input.press('Escape');
  await expect(err).toHaveCount(0);
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

test('cad:p1-review2-coplanar a selected face wins where it shares a plane with another body; Normal to frames the part', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  const canvas = await canvasRect(page);
  // The review's scene: a 20 mm cube and a Ø20, 20 tall cylinder at the origin (both sketched and
  // extruded), both tops at z = 20; a quarter of the cylinder's top lies on the cube's.
  await addSolid(page);
  await addSolid(page, { circle: true, size: [20, 20] });
  await frame.locator('[data-cad-toolbar] [data-command="view.fit"]').click();
  // Select the cube's top (a click clear of the cylinder): it turns the pick green.
  const top = (await onPage(page, [[15, 15, 20]]))[0]!;
  await page.mouse.click(top[0], top[1]);
  await expect(frame.locator('[data-chip="volume"]')).toHaveText('VolumeBody 1 · 8000 mm³');
  // From straight above, the shared quarter is the cube's selected top: green everywhere (the
  // cylinder's top won there, or in wedges, before).
  await frame.locator('[data-cad-toolbar] [data-command="view.top"]').click();
  await page.mouse.move(5, 500);
  const pts: Vec3[] = [];
  for (let r = 2; r <= 8; r += 2) for (let a = 10; a <= 80; a += 14) pts.push([r * Math.cos((a * Math.PI) / 180), r * Math.sin((a * Math.PI) / 180), 20]);
  const green = async () => {
    const at = await onPage(page, pts);
    const px = await pixels(page, at.map((p) => p!));
    const off = px.filter(([r, g]) => g - r < 60);
    return off.length ? `${off.length} of ${px.length} not the pick green: ${JSON.stringify(off.slice(0, 3))}` : 'all green';
  };
  await expect.poll(green, { timeout: 15_000 }).toBe('all green');
  // From the home direction too.
  await frame.locator('[data-cad-toolbar] [data-command="view.fit"]').click();
  await expect.poll(green, { timeout: 15_000 }).toBe('all green');

  // Zoomed in on the cube, then Normal to on its top: the whole part is framed (the cylinder was cut off).
  const t2 = (await onPage(page, [[15, 15, 20]]))[0]!;
  await page.mouse.move(t2[0], t2[1]);
  for (let i = 0; i < 15; i++) await page.mouse.wheel(0, -100);
  // Zoomed in this far, the cylinder's far side is off the canvas.
  const off = await onPage(page, [[-10, -10, 0], [-10, 20, 0], [20, -10, 0]]);
  expect(off.some((c) => !c || c[0] < canvas.x || c[0] > canvas.x + canvas.w || c[1] < canvas.y || c[1] > canvas.y + canvas.h), 'zoomed in: part of the part is off screen').toBe(true);
  const t3 = (await onPage(page, [[15, 15, 20]]))[0]!;
  await page.mouse.click(t3[0], t3[1], { button: 'right' });
  await frame.locator('[data-cad-menu] [data-menu-item="normal-to"]').click();
  const corners: Vec3[] = [];
  for (const x of [-10, 20]) for (const y of [-10, 20]) for (const z of [0, 20]) corners.push([x, y, z]);
  const all = await onPage(page, corners);
  for (const c of all) expect(c && c[0] >= canvas.x && c[0] <= canvas.x + canvas.w && c[1] >= canvas.y && c[1] <= canvas.y + canvas.h, `part corner ${JSON.stringify(c)} on screen after Normal to`).toBe(true);
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

test('cad:p1-review2-planes rolled to the start the planes keep the part size; labels stay off bodies', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  const tree = frame.locator('[data-cad-tree]');
  const labels = frame.locator('.cad-vp-label');
  await addSolid(page);
  await frame.locator('[data-cad-toolbar] [data-command="view.fit"]').click();
  await expect.poll(() => still(page)).toBe('still');
  const canvas = await canvasRect(page);
  const inside = (b: { x: number; y: number; width: number; height: number }) => b.x >= canvas.x && b.y >= canvas.y && b.x + b.width <= canvas.x + canvas.w && b.y + b.height <= canvas.y + canvas.h;

  // Rolled to the start: no body, so the planes show; they keep the part's size (they
  // were 100 mm and filled the view fitted to the 20 mm cube).
  const bar = tree.locator('[data-rollback-bar]');
  await bar.focus();
  await page.keyboard.press('Home');
  await expect(bar).toHaveAttribute('aria-valuenow', '0');
  await expect(labels.filter({ visible: true })).toHaveCount(3);
  for (const l of await labels.all()) expect(inside((await l.boundingBox())!), `${await l.textContent()} label on screen`).toBe(true);
  // The canvas's corners are background, not plane.
  const px = await pixels(page, [
    [canvas.x + canvas.w - 30, canvas.y + 30],
    [canvas.x + canvas.w - 30, canvas.y + canvas.h - 120],
    [canvas.x + 300, canvas.y + canvas.h - 30],
  ]);
  for (const p of px) expect(near(p, BG, 3), `background at a canvas corner: ${p}`).toBe(true);
  await bar.focus();
  await page.keyboard.press('End');
  await expect(bar).toHaveAttribute('aria-valuenow', '2');

  // Origin planes Always, with the cube: no label is drawn over the cube.
  await frame.locator('[data-vp-opens="views"]').click();
  await frame.locator('[data-vp-seg="Origin planes"] [data-value="always"]').click();
  await page.keyboard.press('Escape');
  for (const view of ['view.fit', 'view.front', 'view.top', 'view.right', 'view.iso']) {
    await frame.locator(`[data-cad-toolbar] [data-command="${view}"]`).click();
    await expect.poll(() => still(page)).toBe('still');
    await page.waitForTimeout(100);
    const shown = await labels.filter({ visible: true }).all();
    for (const l of shown) {
      const b = (await l.boundingBox())!;
      const frameBox = (await page.locator('#workspace-frame').boundingBox())!;
      const hits = await workspaceFrame(page).evaluate(
        (r) => {
          const h = (window as unknown as W).__CAD__.services.viewport.get().handle as Handle;
          return [[r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h], [r.x + r.w / 2, r.y + r.h / 2]].map(([x, y]) => h.pick(x, y)?.item.kind ?? 'none');
        },
        { x: b.x - frameBox.x, y: b.y - frameBox.y, w: b.width, h: b.height },
      );
      expect(hits.filter((k) => k === 'face' || k === 'edge' || k === 'vertex' || k === 'body'), `${view}: "${await l.textContent()}" label over the cube`).toEqual([]);
    }
    // From the side the planes' corners clear the cube; from straight above, the Top plane lies
    // under the cube and the other two are edge-on, so no label shows there.
    if (view === 'view.fit' || view === 'view.iso') expect(shown.length, `${view}: some plane labels show`).toBeGreaterThan(0);
  }
  await frame.locator('[data-vp-opens="views"]').click();
  await frame.locator('[data-vp-seg="Origin planes"] [data-value="auto"]').click();
  await page.keyboard.press('Escape');

  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

test('cad:p1-review2-chip-and-menu a long body name in the volume chip ends in an ellipsis; a disabled item says why beside itself', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  const tree = frame.locator('[data-cad-tree]');
  await addSolid(page);
  await addSolid(page, { circle: true, at: [40, 0, 0] });
  const name = `A body with an extremely long name ${'x'.repeat(64)}`.slice(0, 64);
  await tree.locator('[data-bodies-folder] > .tree-row').click();
  const body1 = tree.locator('[data-body-row]').first();
  await body1.locator('[data-body-act="rename"]').click();
  const bin = tree.locator('input[aria-label="Body name"]');
  await bin.fill(name);
  await bin.press('Enter');
  await body1.locator('> .tree-row .tl').click();
  const chip = frame.locator('[data-chip="volume"]');
  await expect(chip).toHaveText(`Volume${name} · 8000 mm³`);
  const nameEl = chip.locator('.cad-chip-name');
  expect(await nameEl.evaluate((el) => ({ cut: el.scrollWidth > el.clientWidth, overflow: getComputedStyle(el).textOverflow }))).toEqual({ cut: true, overflow: 'ellipsis' });
  await expect(chip.locator('.cad-chip-which')).toHaveAttribute('title', name);
  // It was 544 px wide at 1280: now it stays well clear of the viewport buttons. The chip is capped
  // at 320 px whatever font the platform draws (Linux CI falls back to the wider DejaVu Sans), and
  // the name still ends in an ellipsis inside the cap.
  await page.setViewportSize({ width: 1280, height: 800 });
  const c = (await chip.boundingBox())!;
  expect(c.width, 'chip width (capped)').toBeLessThanOrEqual(320.5);
  expect(await nameEl.evaluate((el) => el.scrollWidth > el.clientWidth), 'name still cut inside the cap').toBe(true);
  await expect(chip.locator('[data-volume-mm3]'), 'the volume itself is never cut').toBeVisible();
  const fit = await chip.evaluate((el) => {
    const v = el.querySelector('[data-volume-mm3]')!.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return v.right <= r.right + 0.5 && v.width > 0;
  });
  expect(fit, 'the volume sits whole inside the chip').toBe(true);
  const gizmo = (await frame.locator('[data-cad-gizmo]').boundingBox())!;
  expect(c.x + c.width + 40, 'clear of the viewport buttons').toBeLessThan(gizmo.x);
  await page.setViewportSize({ width: 1600, height: 1000 });

  // The cylinder's side (curved): Normal to is disabled, and its reason sits beside it.
  await frame.locator('[data-cad-toolbar] [data-command="view.iso"]').click();
  const side = (await onPage(page, [[40, 0, 10]]))[0]!;
  await page.mouse.click(side[0], side[1], { button: 'right' });
  const menu = frame.locator('[data-cad-menu]');
  const item = menu.locator('[data-menu-item="normal-to"]');
  await expect(item).toHaveAttribute('aria-disabled', 'true');
  await item.hover();
  const tip = frame.locator('[data-cad-tip]');
  await expect(tip).toContainText('Only flat faces can snap normal');
  const t = (await tip.boundingBox())!;
  const m = (await menu.boundingBox())!;
  // Beside the menu, not over the items under the disabled one.
  expect(t.x >= m.x + m.width - 0.5 || t.x + t.width <= m.x + 0.5, `tooltip ${JSON.stringify(t)} beside the menu ${JSON.stringify(m)}`).toBe(true);
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});
