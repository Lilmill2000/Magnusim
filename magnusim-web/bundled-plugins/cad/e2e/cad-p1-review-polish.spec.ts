// Review round 1, the smaller findings, each as the user meets it in the real
// host frame with the real kernel:
//   - sizes too small to model are refused in the field, in plain words;
//   - volume readouts group digits (or read in m³) and say when they are a total;
//   - Escape in a panel field reverts, and a second Escape closes the panel;
//   - N with nothing selected says why; a double-click on the part's row renames it;
//   - Fit keeps the view direction and looks unlike the viewport's house button
//     (which also goes home); Fit leaves a margin; a part whose size changes many
//     times over is framed again; a hovered origin plane does not stay lit after
//     a redo brings a body back under the still pointer;
//   - the section slider spans the kernel's exact extent and starts on a round value;
//   - the viewport's context menu starts with the core's items (Normal to, Orbit around…);
//   - bodies are listed in the order they were made.
// window.__CAD__ is used only to read the viewport's projection, pivot and hover, and
// (helpers.ts addSketch / addSolid) to set sketched solids up: there is no Box or
// Cylinder since decision 2026-10-01; an extrude's distance is the size field.
// Owner: INTEGRATE (review round 1).
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import { addSketch, addSolid, newPartFromTree, newProject, openProject, partOpened, watchPage, workspaceFrame } from './helpers';

type Vec3 = [number, number, number];
type Loc = ReturnType<FrameLocator['locator']>;

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

type VpState = { animating: boolean; bodies: number; hover: string; pivot: Vec3 };
type Handle = {
  project(p: number[]): [number, number] | null;
  orbitPivot(): Vec3;
  state: { get(): { animating: boolean; bodies: number; hover: { item: { kind: string } } | null } };
};

/** What the viewport is doing: a transition running, bodies drawn, what is hovered, the orbit pivot. */
const vpState = (page: Page): Promise<VpState> =>
  workspaceFrame(page).evaluate(() => {
    const h = (window as unknown as { __CAD__: { services: { viewport: { get(): { handle: unknown } } } } }).__CAD__.services.viewport.get().handle as Handle;
    const s = h.state.get();
    return { animating: s.animating, bodies: s.bodies, hover: s.hover ? s.hover.item.kind : 'none', pivot: h.orbitPivot() };
  });

/** Model points projected to frame pixels (null entries when behind the camera); null while a transition runs. */
const project = (page: Page, pts: Vec3[]) =>
  workspaceFrame(page).evaluate((list) => {
    const h = (window as unknown as { __CAD__: { services: { viewport: { get(): { handle: unknown } } } } }).__CAD__.services.viewport.get().handle as Handle;
    if (h.state.get().animating) return null;
    const c = document.querySelector('[data-cad-viewport] canvas')!.getBoundingClientRect();
    return { xy: list.map((p) => h.project(p)), canvas: { top: c.top, bottom: c.bottom, height: c.height } };
  }, pts);

const still = async (page: Page) => ((await vpState(page)).animating ? 'moving' : 'still');

/** The box's top face (z = 20 of the 20 mm cube) is seen straight on: it projects to a square (equal diagonals), not a keystone. */
async function topFaceOn(page: Page): Promise<string> {
  const r = await project(page, [
    [0, 0, 20],
    [20, 0, 20],
    [20, 20, 20],
    [0, 20, 20],
  ]);
  if (!r) return 'moving';
  if (r.xy.some((p) => !p)) return 'off';
  const [a, b, c, d] = r.xy as [number, number][];
  const d1 = Math.hypot(a[0] - c[0], a[1] - c[1]);
  const d2 = Math.hypot(b[0] - d[0], b[1] - d[1]);
  return Math.abs(d1 - d2) < 0.75 ? 'straight on' : `skewed (diagonals ${d1.toFixed(1)} / ${d2.toFixed(1)} px)`;
}

/** Page coordinates of a model point. */
async function pagePoint(page: Page, p: Vec3): Promise<[number, number]> {
  await expect.poll(() => still(page)).toBe('still');
  const r = await project(page, [p]);
  expect(r && r.xy[0]).toBeTruthy();
  const box = (await page.locator('#workspace-frame').boundingBox())!;
  return [box.x + r!.xy[0]![0], box.y + r!.xy[0]![1]];
}

/** The box [lo, hi] on the canvas: its corners' vertical extent, its largest screen size, the canvas rect. */
async function boxOnCanvas(page: Page, lo: Vec3, hi: Vec3) {
  const pts: Vec3[] = [];
  for (const x of [lo[0], hi[0]]) for (const y of [lo[1], hi[1]]) for (const z of [lo[2], hi[2]]) pts.push([x, y, z]);
  const r = await project(page, pts);
  if (!r || r.xy.some((p) => !p)) return null;
  const xs = r.xy.map((p) => p![0]);
  const ys = r.xy.map((p) => p![1]);
  return { ...r.canvas, minY: Math.min(...ys), maxY: Math.max(...ys), span: Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) };
}

const fmtSpan = (r: { span: number } | null) => (r ? Math.round(r.span) : -1);

test('cad:p1-review-panels tiny sizes refused, grouped volume readouts and totals, Escape twice, N says why, rename from the part row', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  const tb = frame.locator('[data-cad-toolbar]');
  const tree = frame.locator('[data-cad-tree]');
  const panel = frame.locator('[data-cad-panel="feature"]');
  const chip = frame.locator('[data-chip="volume"]');

  // A 20 x 20 profile extruded 20 mm (the Extrude panel, new).
  await addSketch(page);
  await tb.locator('[data-command="solid.extrude"]').click();
  const len = panel.locator('.nui[data-field="distance"] input');
  await setField(panel, 'distance', '20');
  await expect(chip).toHaveText('Volume8000 mm³');
  // A size too small to model is refused where it is typed, in plain words (it used to
  // reach the kernel: "Box 1 failed: Standard_DomainError").
  await len.fill('1e-9');
  await len.press('Enter');
  await expect(panel.locator('.nui[data-field="distance"] [data-nui-error]')).toHaveText('Distance must be at least 0.000001 mm');
  await expect(chip).toHaveText('Volume8000 mm³');
  await expect(tree.locator('[data-feature-row][data-feature-type="extrude"]')).toHaveAttribute('data-state', 'ok');
  // Escape reverts what was typed and keeps the panel; a second Escape closes it (it did nothing).
  await len.press('Escape');
  await expect(len).toHaveValue('20');
  await expect(panel.locator('.nui[data-field="distance"] [data-nui-error]')).toHaveCount(0);
  await expect(panel).toHaveCount(1);
  await len.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(tree.locator('[data-feature-row] > .tree-row .tl')).toHaveText(['Sketch 1', 'Extrude 1']);

  // Readouts group digits instead of the field's scientific style ("1.0000e+6 mm³").
  await tree.locator('[data-feature-row][data-feature-type="extrude"] > .tree-row').dblclick();
  await setField(panel, 'distance', '2500');
  await expect(chip).toHaveText('Volume1,000,000 mm³');
  await setField(panel, 'distance', '1e6');
  await expect(chip).toHaveText('Volume400,000,000 mm³');
  await setField(panel, 'distance', '2500000');
  await expect(chip).toHaveText('Volume1 m³');
  await setField(panel, 'distance', '20');
  await expect(chip).toHaveText('Volume8000 mm³');
  await panel.locator('[data-panel-done]').click();

  // A cylinder (Ø20 × 20, sketched and extruded) as a second body (it overlaps the cube): each body
  // with its own volume, never added together (P4a, Daniel 2026-10-02).
  await addSolid(page, { circle: true, size: [20, 20] });
  await expect(chip).toHaveText('VolumeBody 1: 8000 mm³ · Body 2: 6283.19 mm³');
  // A hidden body is not listed, and the chip says so.
  await tree.locator('[data-bodies-folder] > .tree-row').click();
  await tree.locator('[data-body-row]').nth(1).locator('[data-body-act="visibility"]').click();
  await expect(chip).toHaveText('VolumeBody 1 · 8000 mm³ (1 hidden body not listed)');
  await tree.locator('[data-body-row]').nth(1).locator('[data-body-act="visibility"]').click();
  await expect(chip).toHaveText('VolumeBody 1: 8000 mm³ · Body 2: 6283.19 mm³');

  // N with nothing selected says why (it did nothing; the reason was only in the Views menu).
  const canvas = (await page.locator('#workspace-frame').boundingBox())!;
  await page.mouse.click(canvas.x + canvas.width - 40, canvas.y + 120); // empty space: clears the selection
  await page.keyboard.press('n');
  await expect(page.locator('#workspace-overlay [data-ws-toast]')).toHaveText(/Normal to: Select a planar face or a plane to look at it straight on/);

  // A double-click on the part's own row renames it, as the header's crumb does.
  await tree.locator('[data-part-name] > .tree-row').dblclick();
  await expect(page.locator('#modal-prompt')).toBeVisible();
  await expect(page.locator('#pm-input')).toHaveValue('Part 1');
  await page.locator('#pm-input').fill('Gearbox');
  await page.locator('#pm-confirm').click();
  await expect(page.locator('#modal-prompt')).toBeHidden();
  await expect(tree.locator('[data-part-name] > .tree-row .tl')).toHaveText('Gearbox');
  await expect(page.locator('#workspace-overlay [data-ws-crumb]')).toHaveText(/Magnusim CAD\s*›\s*Gearbox/);
  await expect(frame.locator('[data-chip="save"][data-state="conflict"]')).toHaveCount(0);

  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

test('cad:p1-review-viewport Fit margin and direction, refit after a size typed wrong, stale plane hover, section range, the core menu items', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  const tb = frame.locator('[data-cad-toolbar]');
  const tree = frame.locator('[data-cad-tree]');
  const panel = frame.locator('[data-cad-panel="feature"]');
  const menu = frame.locator('[data-cad-menu]');

  // A cylinder (Ø20 × 20 along Z at the origin, sketched and extruded): the section slider spans its exact
  // extent along Y, -10 to 10 (the tessellation reaches only 9.983), and starts at 0.
  await addSolid(page, { circle: true, size: [20, 20] });
  await frame.locator('[data-vp-opens="section"]').click();
  const slider = frame.locator('[data-section-offset]');
  await expect(slider).toBeVisible();
  expect(Number(await slider.getAttribute('min'))).toBeLessThanOrEqual(-9.9999);
  expect(Number(await slider.getAttribute('min'))).toBeGreaterThan(-10.001);
  expect(Number(await slider.getAttribute('max'))).toBeGreaterThanOrEqual(9.9999);
  await expect(frame.locator('[data-section-value]')).toHaveText('Y 0 mm');
  await frame.locator('[data-vp-opens="section"]').click();
  await expect(slider).toHaveCount(0);
  for (const type of ['extrude', 'sketch']) {
    await tree.locator(`[data-feature-row][data-feature-type="${type}"] > .tree-row`).click({ button: 'right' });
    await menu.locator('[data-menu-item="delete"]').click();
  }
  await expect(tree.locator('[data-tree-empty="history"]')).toHaveText('No features yet');

  // The first body is framed with a margin: none of the cube's corners within 6% of the canvas's top or bottom
  // (Fit filled the whole height, so an iso cube touched the bottom edge under the chips).
  await addSolid(page);
  await tb.locator('[data-command="view.iso"]').click();
  await expect.poll(() => boxOnCanvas(page, [0, 0, 0], [20, 20, 20]).then((r) => (r ? 'still' : 'moving'))).toBe('still');
  const m = (await boxOnCanvas(page, [0, 0, 0], [20, 20, 20]))!;
  expect(m.minY - m.top, 'room above the part').toBeGreaterThan(0.06 * m.height);
  expect(m.bottom - m.maxY, 'room below the part').toBeGreaterThan(0.06 * m.height);

  // Fit keeps the view direction; the viewport's house button (the core's "Fit model to
  // viewport") also turns to the home direction. They no longer share a glyph.
  const glyph = (loc: Loc) => loc.evaluateAll((paths) => paths.map((p) => (p.getAttribute('d') ?? '').trim()).join(' ').replace(/\s+/g, ' '));
  const fitGlyph = await glyph(tb.locator('[data-command="view.fit"] svg path'));
  const homeGlyph = await glyph(frame.locator('[data-vp-fit] svg path'));
  expect(homeGlyph).toContain('M4 11.2L12 4.5l8 6.7'); // the core's house
  expect(fitGlyph, 'the toolbar Fit is not drawn as the house').not.toBe(homeGlyph);
  await tb.locator('[data-command="view.top"]').click();
  await expect.poll(() => topFaceOn(page)).toBe('straight on');
  await tb.locator('[data-command="view.fit"]').click();
  await expect.poll(() => still(page)).toBe('still');
  expect(await topFaceOn(page)).toBe('straight on');
  await frame.locator('[data-vp-fit]').click();
  await expect.poll(() => still(page)).toBe('still');
  expect(await topFaceOn(page)).toMatch(/^skewed/);

  // A size typed wrong (1e6 mm) and framed, then put back to 20 mm: the part is framed
  // again (it stayed a dot until F).
  await tree.locator('[data-feature-row][data-feature-type="extrude"] > .tree-row').dblclick();
  await setField(panel, 'distance', '1e6');
  await expect(frame.locator('[data-chip="volume"]')).toHaveText('Volume400,000,000 mm³');
  await tb.locator('[data-command="view.fit"]').click();
  await expect.poll(() => boxOnCanvas(page, [0, 0, 0], [20, 20, 1e6]).then(fmtSpan)).toBeGreaterThan(200);
  await setField(panel, 'distance', '20');
  await panel.locator('[data-panel-done]').click();
  await expect(frame.locator('[data-chip="volume"]')).toHaveText('Volume8000 mm³');
  await expect.poll(() => boxOnCanvas(page, [0, 0, 0], [20, 20, 20]).then(fmtSpan), { message: 'the 20 mm box is framed, not a dot' }).toBeGreaterThan(200);

  // The core's viewport items come first: on a face, Normal to and Orbit around this face,
  // then Orbit around model center / origin.
  const mid = await pagePoint(page, [10, 10, 20]); // the top face's middle
  await page.mouse.click(mid[0], mid[1], { button: 'right' });
  await expect(menu.locator('[data-menu-item]').first()).toHaveText('Normal to');
  await expect(menu.locator('[data-menu-item]').nth(1)).toHaveText('Orbit around this face');
  await expect(menu.locator('[data-menu-item]').nth(2)).toHaveText('Orbit around model center');
  await expect(menu.locator('[data-menu-item]').nth(3)).toHaveText('Orbit around origin');
  await menu.locator('[data-menu-item="orbit-origin"]').click();
  expect((await vpState(page)).pivot).toEqual([0, 0, 0]);
  await page.mouse.click(mid[0], mid[1], { button: 'right' });
  await menu.locator('[data-menu-item="orbit-here"]').click();
  const pivot = (await vpState(page)).pivot;
  expect(pivot[2]).toBeCloseTo(20, 3);
  expect(Math.abs(pivot[0] - 10)).toBeLessThan(2);
  expect(Math.abs(pivot[1] - 10)).toBeLessThan(2);
  await page.mouse.click(mid[0], mid[1], { button: 'right' });
  await menu.locator('[data-menu-item="normal-to"]').click();
  await expect.poll(() => topFaceOn(page)).toBe('straight on');
  // On empty space: the orbit choices, then Fit.
  const fb = (await page.locator('#workspace-frame').boundingBox())!;
  await page.mouse.click(fb.x + fb.width - 60, fb.y + 140, { button: 'right' });
  await expect(menu.locator('[data-menu-item]')).toHaveText(['Orbit around model center', 'Orbit around origin', 'Fit']);
  await menu.locator('[data-menu-item="orbit-center"]').click();
  expect((await vpState(page)).pivot).toEqual([10, 10, 10]);

  // Undo to the empty part (the origin planes show), hover a plane, then redo without
  // moving the pointer: the plane is no longer lit as hovered (it stayed so until the mouse moved).
  // Two Ctrl+Z (the extrude, then its sketch: planes stay hidden while a sketch shows): the
  // 1e6-and-back edit made no undo step of its own (it would change nothing).
  await tree.locator('[data-part-name] > .tree-row').click();
  await tb.locator('[data-command="view.iso"]').click();
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  await expect(tree.locator('[data-tree-empty="history"]')).toHaveText('No features yet');
  await expect.poll(async () => (await vpState(page)).bodies).toBe(0);
  await expect.poll(() => still(page)).toBe('still');
  // The middle of the Top plane, which keeps the cube's size (review round 2); the cube comes back over it.
  const onPlane = await pagePoint(page, [10, 10, 0]);
  await page.mouse.move(onPlane[0], onPlane[1], { steps: 4 });
  await expect.poll(async () => (await vpState(page)).hover).toBe('origin');
  await page.keyboard.press('Control+y');
  await page.keyboard.press('Control+y');
  await expect(tree.locator('[data-feature-row] > .tree-row .tl')).toHaveText(['Sketch 1', 'Extrude 1']);
  await expect.poll(async () => (await vpState(page)).bodies).toBe(1);
  await expect.poll(async () => (await vpState(page)).hover, { message: 'no stale plane hover' }).not.toBe('origin');

  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

test('cad:p1-review-bodies bodies are listed in the order they were made, whatever the history did to them since', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  const tb = frame.locator('[data-cad-toolbar]');
  const tree = frame.locator('[data-cad-tree]');
  const panel = frame.locator('[data-cad-panel="feature"]');
  const menu = frame.locator('[data-cad-menu]');
  // Two cubes side by side, sketched and extruded (Body 1, Body 2); then, rolled back to after
  // Extrude 1, a third (Body 3) goes in between: the history reads ... Extrude 1, Sketch 3, Extrude 3, Sketch 2, Extrude 2.
  for (const x of [0, 50]) await addSolid(page, { at: [x, 0, 0] });
  const e1 = tree.locator('[data-feature-row][data-feature-type="extrude"]').first();
  await e1.locator('> .tree-row').click({ button: 'right' });
  await menu.locator('[data-menu-item="rollback"]').click();
  await expect(tree.locator('[data-rollback-bar]')).toHaveAttribute('aria-valuenow', '2');
  await addSolid(page, { at: [100, 0, 0] });
  await e1.locator('> .tree-row').click({ button: 'right' });
  await menu.locator('[data-menu-item="roll-end"]').click();
  await expect(tree.locator('[data-feature-row] > .tree-row .tl')).toHaveText(['Sketch 1', 'Extrude 1', 'Sketch 3', 'Extrude 3', 'Sketch 2', 'Extrude 2']);
  await expect(tree.locator('[data-bodies-folder] > .tree-row .tl')).toHaveText('Bodies (3)');
  await tree.locator('[data-bodies-folder] > .tree-row').click();
  // The list keeps the order they were made in (it followed the history: Body 1, Body 3, Body 2).
  await expect(tree.locator('[data-body-row] .cad-body-name')).toHaveText(['Body 1', 'Body 2', 'Body 3']);
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});
