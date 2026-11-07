// Parity both ways (Daniel: "anything the AI has I should have"): what was the Assistant's alone,
// used by a person with clicks and keys, and what they see:
//   cad:pp-hole     SOLID's Hole: a face clicked, two centres clicked on it, diameter and a blind
//               depth typed, Done: "Hole 1 sketch" and "Hole 1" in the tree, the volume drops by
//               the two holes, one Ctrl+Z takes both back and Ctrl+Y brings them; then a blind
//               hole with a drill point at a typed 120 deg: its tip sketch and cut at that angle;
//   cad:pp-tree     a body's colour from its swatch (and "Colour…" in its menu), a feature dragged to a
//               new place in the history and moved with Move down, a drag the order rule refuses
//               (said, nothing moved), and Delete of two selected features as one undo step;
//   cad:pp-view     the Back isometric view (its key 8 and the views menu), the section's Middle, Find
//               with the selector language and Select all, Picture with body names from two
//               directions;
//   cad:pp-measure  Measure of a body (solids, sealed voids) and its cross-section at Top offset 5,
//               two typed points, and a parameter's comment in the Parameters panel;
//   cad:pp-find-fillets  Find of fillets and holes by size (S4) on an imported STEP part: the
//               find tool's counts (8 fillet faces up to 2 mm, 4 holes up to 6 mm; the unit test
//               person-parity.test.ts and cad-assistant-fillet-selectors.spec.ts check the tool
//               gives the same), the rows' sizes, and Select all of the 8 faces.
// Setup (a block) goes in through the document as the other specs do; everything asserted is what
// the person sees (the tree, the panels, the chips) or the record their click stored.
// Owner: ASSISTANT (the person's side of the Assistant's tools).
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type APIRequestContext, type FrameLocator, type Page } from '@playwright/test';
import { addSolid, historyNames, modelOnPage, newPartFromTree, newProject, openProject, partOpened, runCommand, singleVolume, tempFilesRemovedAfterEach, watchPage, workspaceFrame } from './helpers';
import { importRoundedBlock } from './rounded-block';

const tempFile = tempFilesRemovedAfterEach();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type W = { __CAD__: { services: any } };

async function freshPart(page: Page, request: APIRequestContext) {
  await watchPage(page);
  const projectId = await newProject(request);
  await openProject(page, projectId);
  await newPartFromTree(page, 'Part 1');
  const frame = await partOpened(page);
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  return frame;
}

/** The rebuild is done and every feature has a state. */
async function settled(page: Page) {
  await expect
    .poll(() =>
      workspaceFrame(page).evaluate(() => {
        const st = (window as unknown as W).__CAD__.services.doc.state.get();
        return st.rebuild.status === 'done' && st.doc.features.every((f: { id: string }) => st.rebuild.features[f.id] && st.rebuild.features[f.id].state !== 'pending');
      }),
    )
    .toBe(true);
}

const undoLabel = (page: Page) => workspaceFrame(page).evaluate(() => (window as unknown as W).__CAD__.services.doc.state.get().history.undoLabel as string | null);
const featureRow = (frame: FrameLocator, name: string) => frame.locator('[data-cad-tree] [data-feature-row]').filter({ has: frame.locator('> .tree-row .tl', { hasText: new RegExp(`^(?:[(][-+?][)] )?${name}$`) }) });
const toolPanel = (frame: FrameLocator) => frame.locator('[data-cad-panel="tool"]');

/** The CAD frame's toasts from now on (the bridge's, as the person sees them in the app). */
async function recordToasts(page: Page) {
  await workspaceFrame(page).evaluate(() => {
    const s = (window as unknown as W).__CAD__.services;
    const w = window as unknown as { __toasts: string[] };
    w.__toasts = [];
    const orig = s.bridge.toast.bind(s.bridge);
    s.bridge.toast = (m: string, k?: string) => {
      w.__toasts.push(m);
      return orig(m, k);
    };
  });
}
const toasts = (page: Page) => workspaceFrame(page).evaluate(() => (window as unknown as { __toasts: string[] }).__toasts);

test('cad:pp-hole SOLID Hole: a face and two centres clicked, diameter and blind depth typed, Done makes the sketch and the cut as one step', async ({ page, request }) => {
  test.setTimeout(240_000);
  const frame = await freshPart(page, request);
  await addSolid(page, { size: [60, 40, 10] });
  await expect.poll(() => singleVolume(frame)).toBeCloseTo(24_000, 3);
  await runCommand(frame, 'solid.hole');
  const panel = toolPanel(frame);
  await expect(panel.locator('[data-tool-panel="solid.hole"]')).toBeVisible();
  // The top face (z = 10), then two centres on it.
  const face = await modelOnPage(page, [30, 20, 10]);
  await page.mouse.click(face[0], face[1]);
  await expect(panel.locator('[data-pick-field="hole-face"] [data-pick-row]')).toHaveCount(1);
  await expect(panel.locator('[data-tool-panel="solid.hole"]')).toHaveAttribute('data-hole-along', 'Z');
  for (const p of [
    [15, 12, 10],
    [45, 28, 10],
  ] as [number, number, number][]) {
    const at = await modelOnPage(page, p);
    await page.mouse.click(at[0], at[1]);
  }
  await expect(panel.locator('[data-hole-centre]')).toHaveCount(2);
  // The coordinate along the face's normal is the face's own.
  await expect(panel.locator('[data-hole-coord="0-z"]')).toBeDisabled();
  await panel.locator('[data-field="diameter"]').fill('6 mm');
  await panel.locator('[data-field="depth"] select').selectOption('blind');
  await panel.locator('[data-field="distance"]').fill('4 mm');
  await panel.locator('[data-panel-done]').click();
  await expect(panel).toHaveCount(0);
  await expect(historyNames(frame)).toHaveText(['Sketch 1', 'Extrude 1', 'Hole 1 sketch', 'Hole 1']);
  await settled(page);
  await expect(featureRow(frame, 'Hole 1')).toHaveAttribute('data-state', 'ok');
  await expect(featureRow(frame, 'Hole 1 sketch')).toHaveAttribute('data-sketch-state', 'fully');
  const holes = 24_000 - 2 * Math.PI * 9 * 4;
  await expect.poll(() => singleVolume(frame), { timeout: 30_000 }).toBeCloseTo(holes, 2);
  // What it stored: the hole tool's sketch (d, h1x...) and its blind cut into Body 1.
  const stored = await workspaceFrame(page).evaluate(() => {
    const d = (window as unknown as W).__CAD__.services.doc.state.get().doc;
    const sk = d.features.find((f: { name: string }) => f.name === 'Hole 1 sketch');
    const cut = d.features.find((f: { name: string }) => f.name === 'Hole 1');
    return { dims: sk.constraints.filter((c: { expr?: string }) => c.expr).map((c: { id: string; expr: string }) => `${c.id}=${c.expr}`), op: cut.op, flip: cut.flip, extent: cut.extent, scope: cut.scope.length, profiles: cut.profiles.length };
  });
  expect(stored.dims).toEqual(expect.arrayContaining(['d=6 mm', expect.stringMatching(/^h1x=/), expect.stringMatching(/^h2y=/)]));
  expect(stored).toMatchObject({ op: 'cut', flip: true, extent: { kind: 'blind', distance: '4 mm' }, scope: 1, profiles: 2 });
  expect(await undoLabel(page)).toBe('Hole 1');
  // One Ctrl+Z takes the whole hole back; Ctrl+Y brings it.
  await frame.locator('[data-cad-app]').click({ position: { x: 5, y: 5 } }).catch(() => {});
  await page.keyboard.press('Control+z');
  await expect(historyNames(frame)).toHaveText(['Sketch 1', 'Extrude 1']);
  await expect.poll(() => singleVolume(frame), { timeout: 30_000 }).toBeCloseTo(24_000, 2);
  await page.keyboard.press('Control+y');
  await expect(historyNames(frame)).toHaveText(['Sketch 1', 'Extrude 1', 'Hole 1 sketch', 'Hole 1']);
  await expect.poll(() => singleVolume(frame), { timeout: 30_000 }).toBeCloseTo(holes, 2);

  // A blind hole with a drill point of 120 deg (Bottom, Point angle): the hole tool's tip sketch and cut, at that angle.
  await runCommand(frame, 'solid.hole');
  await expect(panel.locator('[data-tool-panel="solid.hole"]')).toBeVisible();
  await page.mouse.click(face[0], face[1]);
  await expect(panel.locator('[data-pick-field="hole-face"] [data-pick-row]')).toHaveCount(1);
  const mid = await modelOnPage(page, [30, 20, 10]);
  await page.mouse.click(mid[0], mid[1]);
  await expect(panel.locator('[data-hole-centre]')).toHaveCount(1);
  await panel.locator('[data-field="diameter"]').fill('4 mm');
  await panel.locator('[data-field="depth"] select').selectOption('blind');
  await panel.locator('[data-field="distance"]').fill('3 mm');
  await panel.locator('[data-field="tip"] select').selectOption('drill');
  await panel.locator('input[data-field="tip-angle"]').fill('120 deg');
  await panel.locator('[data-panel-done]').click();
  await expect(panel).toHaveCount(0);
  await expect(historyNames(frame)).toHaveText(['Sketch 1', 'Extrude 1', 'Hole 1 sketch', 'Hole 1', 'Hole 2 sketch', 'Hole 2', 'Hole 2 tip sketch', 'Hole 2 tip']);
  await settled(page);
  const tip = await workspaceFrame(page).evaluate(() => {
    const cut = (window as unknown as W).__CAD__.services.doc.state.get().doc.features.find((f: { name: string }) => f.name === 'Hole 2 tip');
    return { extent: cut.extent, taper: cut.taper };
  });
  expect(tip).toEqual({ extent: { kind: 'blind', distance: '(4 mm) / 2 / tan((120 deg) / 2)' }, taper: '(120 deg) / 2' });
  // The hole, 3 mm deep, and its cone (radius 2, 2 / tan(60 deg) deep).
  const pointed = holes - Math.PI * 4 * 3 - (Math.PI * 4 * (2 / Math.tan(Math.PI / 3))) / 3;
  await expect.poll(() => singleVolume(frame), { timeout: 30_000 }).toBeCloseTo(pointed, 2);
  expect(await undoLabel(page)).toBe('Hole 2');
});

test('cad:pp-tree a body colour from its swatch, a drag and Move down in the history, a refused drag, and Delete of two features as one step', async ({ page, request }) => {
  test.setTimeout(240_000);
  const frame = await freshPart(page, request);
  await addSolid(page, { size: [20, 20, 20] });
  await recordToasts(page);
  // Colour: the Bodies folder, the body's swatch (its colour picker), a colour chosen.
  await frame.locator('[data-bodies-folder] > .tree-row').click();
  const body = await workspaceFrame(page).evaluate(() => (window as unknown as W).__CAD__.services.doc.state.get().rebuild.bodies[0].id as string);
  const row = frame.locator(`[data-body-row="${body}"]`);
  await row.locator('> .tree-row').click({ button: 'right' });
  const menu = frame.locator('[data-cad-menu]');
  await expect(menu.locator('[data-menu-item="body-color"]')).toHaveText(/Colour/);
  await menu.locator('[data-menu-item="body-color"]').click();
  await expect(menu).toHaveCount(0);
  await row.locator('[data-body-color]').fill('#cc3311');
  await expect(row.locator('[data-body-color]')).toHaveAttribute('data-color', '#cc3311');
  await expect(row.locator('.cad-swatch')).toHaveCSS('background-color', 'rgb(204, 51, 17)');
  expect(await workspaceFrame(page).evaluate((id) => (window as unknown as W).__CAD__.services.doc.state.get().doc.bodies[id].color, body)).toBe('#cc3311');
  expect(await undoLabel(page)).toBe('Colour of Body 1');

  // Order: a plane made after the extrude, dragged above the sketch, then Move down.
  await workspaceFrame(page).evaluate(() => {
    const s = (window as unknown as W).__CAD__.services;
    const p = s.doc.beginNew('ref_plane', { method: 'offset', plane: { kind: 'origin', plane: 'origin:top' }, distance: '30 mm' });
    p.commit();
  });
  await settled(page);
  await expect(historyNames(frame)).toHaveText(['Sketch 1', 'Extrude 1', 'Plane 1']);
  await featureRow(frame, 'Plane 1').locator('> .tree-row').dragTo(featureRow(frame, 'Sketch 1').locator('> .tree-row'), { targetPosition: { x: 20, y: 3 } });
  await expect(historyNames(frame)).toHaveText(['Plane 1', 'Sketch 1', 'Extrude 1']);
  expect(await undoLabel(page)).toBe('Move Plane 1');
  await featureRow(frame, 'Plane 1').locator('> .tree-row').click({ button: 'right' });
  await menu.locator('[data-menu-item="move-down"]').click();
  await expect(historyNames(frame)).toHaveText(['Sketch 1', 'Plane 1', 'Extrude 1']);
  // The order rule: the extrude cannot go above its sketch; it says so and nothing moves.
  await featureRow(frame, 'Extrude 1').locator('> .tree-row').dragTo(featureRow(frame, 'Sketch 1').locator('> .tree-row'), { targetPosition: { x: 20, y: 3 } });
  await expect.poll(() => toasts(page)).toContainEqual('Move Extrude 1 failed: Extrude 1 uses Sketch 1: it cannot move above it');
  await expect(historyNames(frame)).toHaveText(['Sketch 1', 'Plane 1', 'Extrude 1']);

  // Delete of two: the sketch and its extrude selected, Delete, one undo step for both.
  await featureRow(frame, 'Sketch 1').locator('> .tree-row').click();
  await featureRow(frame, 'Extrude 1').locator('> .tree-row').click({ modifiers: ['Control'] });
  await featureRow(frame, 'Extrude 1').locator('> .tree-row').click({ button: 'right' });
  await expect(menu.locator('[data-menu-item="delete"]')).toHaveText('Delete 2 features');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Delete');
  await expect(historyNames(frame)).toHaveText(['Plane 1']);
  expect(await undoLabel(page)).toBe('Delete Sketch 1 and Extrude 1');
  await page.keyboard.press('Control+z');
  await expect(historyNames(frame)).toHaveText(['Sketch 1', 'Plane 1', 'Extrude 1']);
});

test('cad:pp-view the Back isometric view by its key and menu, the section Middle, Find and Select all, and a Picture with body names', async ({ page, request }) => {
  test.setTimeout(240_000);
  const frame = await freshPart(page, request);
  await addSolid(page, { size: [40, 20, 10] });
  const dir = () =>
    workspaceFrame(page).evaluate(() => {
      const c = (window as unknown as W).__CAD__.services.viewport.get().handle.camera();
      const d = [0, 1, 2].map((i) => c.position[i] - c.target[i]);
      const n = Math.hypot(d[0], d[1], d[2]);
      return d.map((v) => Math.round((v / n) * 1000) / 1000);
    });
  // Key 8 with the view focused.
  await frame.locator('[data-cad-viewport] canvas').click({ position: { x: 8, y: 8 } });
  await page.keyboard.press('8');
  await expect.poll(dir).toEqual([-0.577, 0.577, 0.577]);
  // The views menu: Front, then Back isometric.
  await frame.locator('[data-vp-opens="views"]').click();
  await frame.locator('[data-view="front"]').click();
  await expect.poll(dir).toEqual([0, -1, 0]);
  await frame.locator('[data-vp-opens="views"]').click();
  await expect(frame.locator('[data-view="iso_back"]')).toHaveText('Back isometric8');
  await frame.locator('[data-view="iso_back"]').click();
  await expect.poll(dir).toEqual([-0.577, 0.577, 0.577]);

  // The section's Middle: through the middle of the block along the plane's normal.
  await frame.locator('[data-vp-opens="section"]').click();
  await frame.locator('[data-section-middle]').click();
  const section = () => workspaceFrame(page).evaluate(() => (window as unknown as W).__CAD__.services.viewport.get().handle.state.get().section);
  await expect.poll(async () => (await section()).offset).toBeCloseTo(-10, 6);
  await frame.locator('[data-vp-opens="section"]').click();

  // Find: a query in the selector language, its one match, Select all.
  await runCommand(frame, 'inspect.find');
  const find = toolPanel(frame);
  await find.locator('[data-find-query]').fill('Body 1 faces >Z');
  await find.locator('[data-find-query]').press('Enter');
  await expect(find.locator('[data-find-count]')).toHaveAttribute('data-find-count', '1');
  await expect(find.locator('[data-find-row]')).toHaveCount(1);
  await find.locator('[data-find-select-all]').click();
  const picked = await workspaceFrame(page).evaluate(() => (window as unknown as W).__CAD__.services.selection.get().items);
  expect(picked).toEqual([{ kind: 'face', body: expect.any(String), index: expect.any(Number) }]);
  // A query that does not read says so.
  await find.locator('[data-find-query]').fill('Body 1 faces >>');
  await find.locator('[data-find-run]').click();
  await expect(find.locator('[data-run-reason]')).toContainText(/selector|read|expected/i);

  // Picture: iso and Back isometric, body names, drawn off screen: the person's view does not move.
  await runCommand(frame, 'file.picture');
  const pic = toolPanel(frame);
  await pic.locator('[data-picture-view="iso_back"] input').check();
  await pic.locator('[data-field="labels"] select').selectOption('bodies');
  const before = await dir();
  await pic.locator('[data-picture-take]').click();
  await expect(pic.locator('[data-picture-image]')).toBeVisible({ timeout: 60_000 });
  await expect(pic.locator('[data-picture-image]')).toHaveAttribute('data-picture-text', /^Pictured iso, iso_back/);
  await expect(pic.locator('[data-picture-label]')).toHaveText([/Body 1/]);
  await expect(pic.locator('[data-picture-save]')).toHaveAttribute('download', 'Part picture.png');
  expect(await dir()).toEqual(before);
});

test("cad:pp-measure Measure of a body (solids, voids) and its cross-section, two typed points, and a parameter's comment", async ({ page, request }) => {
  test.setTimeout(240_000);
  const frame = await freshPart(page, request);
  await addSolid(page, { size: [60, 40, 10] });
  await runCommand(frame, 'inspect.measure');
  const m = toolPanel(frame);
  // A body: its row in the tree.
  await frame.locator('[data-bodies-folder] > .tree-row').click();
  const body = await workspaceFrame(page).evaluate(() => (window as unknown as W).__CAD__.services.doc.state.get().rebuild.bodies[0].id as string);
  await frame.locator(`[data-body-row="${body}"] > .tree-row .cad-body-name`).click();
  await expect(m.locator('[data-measure-value="solids"]')).toHaveText('1', { timeout: 30_000 });
  await expect(m.locator('[data-measure-value="voids"]')).toHaveText('0');
  await expect(m.locator('[data-measure-value="valid"]')).toHaveText('Yes');
  // Its cross-section at Top offset 5: 60 x 40.
  await m.locator('[data-measure-section-plane] select').selectOption('Top');
  await m.locator('[data-measure-section-offset]').fill('5');
  await m.locator('[data-measure-section-offset]').press('Enter');
  await expect(m.locator('[data-measure-value="section-area"]')).toHaveText('2400 mm²', { timeout: 30_000 });
  // Two typed points instead: 5 mm apart.
  await m.locator('[data-pick-remove]').click();
  for (const p of ['0, 0, 0', '3, 4, 0']) {
    await m.locator('[data-measure-point-input]').fill(p);
    await m.locator('[data-measure-point-add]').click();
  }
  await expect(m.locator('[data-pick-row]')).toHaveCount(2);
  await expect(m.locator('[data-measure-value="distance"]')).toHaveText('5 mm', { timeout: 30_000 });
  await m.locator('[data-panel-done]').click();

  // A parameter with a comment, then the comment changed and cleared (each one undo step).
  await workspaceFrame(page).evaluate(() => {
    (window as unknown as W).__CAD__.services.doc.addParam({ name: 'w', expr: '60 mm', quantity: 'length' });
  });
  await frame.locator('[data-params-row] > .tree-row').click();
  const params = frame.locator('[data-cad-panel="params"]');
  const comment = params.locator('[data-param-comment="w"]');
  await comment.fill('Plate width');
  await comment.press('Enter');
  const stored = () => workspaceFrame(page).evaluate(() => (window as unknown as W).__CAD__.services.doc.state.get().doc.params.find((p: { name: string }) => p.name === 'w').comment ?? null);
  await expect.poll(stored).toBe('Plate width');
  expect(await undoLabel(page)).toBe('Edit parameter w');
  await comment.fill('');
  await comment.press('Enter');
  await expect.poll(stored).toBe(null);
  // A new one with its comment.
  await params.locator('input[aria-label="New parameter name"]').fill('t');
  await params.locator('input[aria-label="New parameter expression"]').fill('10 mm');
  await params.locator('[data-param-comment="new"]').fill('Plate thickness');
  await params.locator('[data-param-add-btn]').click();
  await expect(params.locator('[data-param-comment="t"]')).toHaveValue('Plate thickness');
});

test('cad:pp-find-fillets Find of fillets and holes by size: the counts the find tool gives, the sizes in the rows, Select all', async ({ page, request }) => {
  test.setTimeout(240_000);
  const frame = await freshPart(page, request);
  await importRoundedBlock(page, frame, tempFile);
  await settled(page);
  await runCommand(frame, 'inspect.find');
  const find = toolPanel(frame);
  await find.locator('[data-find-query]').fill('Body 1 faces fillet <= 2 mm');
  await find.locator('[data-find-query]').press('Enter');
  await expect(find.locator('[data-find-count]')).toHaveAttribute('data-find-count', '8', { timeout: 30_000 });
  await expect(find.locator('[data-find-row] [data-find-type]')).toHaveText(Array(8).fill('fillet R2'));
  await find.locator('[data-find-select-all]').click();
  const picked = await workspaceFrame(page).evaluate(() => (window as unknown as W).__CAD__.services.selection.get().items as { kind: string }[]);
  expect(picked.map((it) => it.kind)).toEqual(Array(8).fill('face'));
  await find.locator('[data-find-query]').fill('Body 1 faces hole <= 6 mm');
  await find.locator('[data-find-query]').press('Enter');
  await expect(find.locator('[data-find-count]')).toHaveAttribute('data-find-holes', '4', { timeout: 30_000 });
  await expect(find.locator('[data-find-count]')).toHaveAttribute('data-find-count', '4');
  await expect(find.locator('[data-find-row] [data-find-type]')).toHaveText(Array(4).fill('hole Ø6 through'));
});
