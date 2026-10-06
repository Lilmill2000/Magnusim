// P4a CONSTRUCT (Daniel's must-have 9) and the volume chip, in the real host
// frame with the real kernel, as the user clicks them:
//   - the toolbar's CONSTRUCT group: Plane, Axis, Point;
//   - Top plane selected -> Plane: "Offset from a plane" with Top in its field;
//     20 typed -> it is built 20 mm up (the panel reads it, the view draws it,
//     labelled "Plane 1"); Done; the plane is picked and hovered in the view;
//     Sketch on it (selected, then Sketch), a 30 x 20 rectangle drawn on it,
//     Extrude 10 -> the body spans z 20..30; the plane moved to 35 -> 35..45;
//     "Sketch on Plane 1" from the view's menu; Delete refused while used;
//   - a Plane on a block's top face follows the block's height, and turns red
//     with the reason when the block is suppressed (its row in the panel too);
//   - Axis of a cylinder from the face selected first; Axis where Front and
//     Right cross (picked in the tree); Point at coordinates, drawn as a dot;
//   - the volume chip: a part and an Enclosure each with its own volume, never
//     added; the selected body's alone.
// window.__CAD__ is used only to project model points and read exact figures.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { addSketch, addSolid, drawBlock, modelOnPage, newPartFromTree, newProject, openProject, partOpened, watchPage, workspaceFrame, runCommand, groupCommandLabels, commandControl } from './helpers';

const SHOTS = process.env.CAD_E2E_SHOTS || '';
async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

type V3 = [number, number, number];
const tb = (frame: FrameLocator) => frame.locator('[data-cad-toolbar]');
const panel = (frame: FrameLocator) => frame.locator('[data-cad-panel="feature"]');
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const featureRow = (frame: FrameLocator, name: string) => frame.locator('[data-cad-tree] [data-feature-row]').filter({ has: frame.locator('> .tree-row .tl', { hasText: new RegExp(`^${esc(name)}$`) }) });
const cad = <T>(page: Page, fn: (arg: never) => T | Promise<T>, arg?: unknown) => workspaceFrame(page).evaluate(fn as never, arg as never) as Promise<T>;
const volumeChip = (frame: FrameLocator) => frame.locator('[data-chip="volume"]');

async function freshPart(page: Page, request: Parameters<typeof newProject>[0]) {
  const seen = await watchPage(page);
  const projectId = await newProject(request);
  await openProject(page, projectId);
  await newPartFromTree(page, 'Part 1');
  const frame = await partOpened(page);
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  return { seen, frame };
}

async function still(page: Page) {
  await expect.poll(() => cad<boolean>(page, (() => (window as unknown as { __CAD__: { services: { viewport: { get(): { handle: { state: { get(): { animating: boolean } } } } } } } }).__CAD__.services.viewport.get().handle.state.get().animating) as never)).toBe(false);
}

/** A click on empty view space (right of the middle): lets go of the selection. */
async function clickEmpty(page: Page) {
  const box = (await page.locator('#workspace-frame').boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.93, box.y + box.height * 0.5);
}

async function setField(frame: FrameLocator, field: string, value: string) {
  const input = panel(frame).locator(`.nui[data-field="${field}"] input`);
  await input.fill(value);
  await input.press('Enter');
  await expect(panel(frame).locator(`.nui[data-field="${field}"] [data-nui-error]`)).toHaveCount(0);
}

/** The built bodies' exact boxes, by name, once the rebuild is done. */
async function boxes(page: Page): Promise<Record<string, number[]>> {
  let out: Record<string, number[]> = {};
  await expect
    .poll(async () => {
      out = await cad<Record<string, number[]>>(page, (async () => {
        const doc = (window as unknown as { __CAD__: { services: { doc: { state: { get(): { rebuild: { status: string; bodies: { id: string; name: string }[] } } }; measure(id: string): Promise<{ bbox: number[] }> } } } }).__CAD__.services.doc;
        const r = doc.state.get().rebuild;
        if (r.status !== 'done') return {};
        const o: Record<string, number[]> = {};
        for (const b of r.bodies) o[b.name] = (await doc.measure(b.id)).bbox.map((v) => Math.round(v * 1e6) / 1e6);
        return o;
      }) as never);
      return Object.keys(out).length;
    }, { timeout: 60_000 })
    .toBeGreaterThan(0);
  return out;
}

/** A CONSTRUCT feature's built output (rounded), by its name. */
async function built(page: Page, name: string): Promise<Record<string, unknown> | null> {
  return cad(page, ((n: string) => {
    const s = (window as unknown as { __CAD__: { services: { doc: { state: { get(): { doc: { features: { id: string; name: string }[] }; rebuild: { outputs: Record<string, unknown> } } } } } } }).__CAD__.services.doc.state.get();
    const f = s.doc.features.find((x) => x.name === n);
    const o = f ? s.rebuild.outputs[f.id] : null;
    return o ? JSON.parse(JSON.stringify(o, (_k, v) => (typeof v === 'number' ? Math.round(v * 1e6) / 1e6 || 0 : v))) : null;
  }) as never, name);
}

test('cad:p4a-construct-toolbar CONSTRUCT has Plane, Axis and Point, after MODIFY', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  const labels = await tb(frame).locator('.tb-group-label').allTextContents();
  expect(labels.indexOf('CONSTRUCT')).toBeGreaterThan(labels.indexOf('MODIFY'));
  expect(labels.indexOf('CONSTRUCT')).toBeLessThan(labels.indexOf('CFD PREP'));
  expect(await groupCommandLabels(frame, 'construct')).toEqual(['Plane', 'Axis', 'Point']);
  // Offered on an empty Part (a plane off Top needs no body).
  // Each can run (Axis and Point may be in CONSTRUCT's More menu at this width).
  for (const id of ['construct.plane', 'construct.axis', 'construct.point']) await expect(await commandControl(frame, id)).not.toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Escape');
  expect(seen.csp).toEqual([]);
  expect(seen.errors).toEqual([]);
});

test('cad:p4a-construct-plane-sketch a Plane 20 mm above Top, a sketch on it, Extrude 10: the body spans z 20..30, and follows the plane to 35', { tag: '@smoke' }, async ({ page, request }) => {
  test.setTimeout(300_000);
  const { seen, frame } = await freshPart(page, request);
  // Top plane selected first: the new Plane offsets from it.
  await frame.locator('[data-cad-tree] [data-tree-node="origin:top"] > .tree-row').click();
  await tb(frame).locator('[data-command="construct.plane"]').click();
  const p = panel(frame);
  await expect(p.locator('[data-panel-title]')).toHaveText('Plane 1');
  await expect(p.locator('[data-field="method"] select')).toHaveValue('offset');
  await expect(p.locator('[data-pick-list="plane"] [data-pick-row] .cad-pick-name')).toHaveText(['Top plane']);
  // No header tick; Done in the foot; Delete (a new feature: discards it).
  await expect(p.locator('[data-panel-done]')).toBeVisible();
  await expect(p.locator('[data-panel-delete]')).toBeVisible();
  await setField(frame, 'distance', '20');
  await expect(p.locator('[data-construct-readout]')).toHaveText('Built: through 0, 0, 20 mm, normal 0, 0, 1');
  await expect(featureRow(frame, 'Plane 1')).toHaveAttribute('data-state', 'ok');
  // Drawn and labelled in the view.
  await expect(frame.locator('[data-construct-label]')).toHaveText(['Plane 1']);
  await expect(frame.locator('[data-construct-label]')).toBeVisible();
  await shot(page, 'p4a-plane-offset-panel');
  await p.locator('[data-panel-done]').click();
  await expect(p).toHaveCount(0);
  expect(await built(page, 'Plane 1')).toEqual({ type: 'plane', frame: { origin: [0, 0, 20], normal: [0, 0, 1], xdir: [1, 0, 0] } });

  // In the view: hovering the plane lights it, a click selects it (its tree row too), empty space clears.
  await page.mouse.move(5, 5);
  await still(page);
  const at = await modelOnPage(page, [-30, -30, 20]);
  await page.mouse.move(at[0], at[1]);
  await expect(frame.locator('[data-construct-label]')).toHaveAttribute('data-state', 'hover');
  await page.mouse.click(at[0], at[1]);
  await expect(frame.locator('[data-construct-label]')).toHaveAttribute('data-state', 'pick');
  await expect(featureRow(frame, 'Plane 1')).toHaveAttribute('aria-selected', 'true');

  // Sketch on it: the plane selected, then Sketch.
  await tb(frame).locator('[data-command="sketch.new"]').click();
  await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
  await expect(frame.locator('[data-cad-panel]')).toContainText('Plane 1');
  await still(page);
  await page.keyboard.press('r');
  const o = await modelOnPage(page, [0, 0, 20]);
  await page.mouse.click(o[0], o[1]);
  const c = await modelOnPage(page, [24, 16, 20]);
  await page.mouse.move(c[0], c[1]);
  await expect(frame.locator('[data-sketch-box="width"]')).toBeVisible();
  await page.keyboard.type('30');
  await page.keyboard.press('Tab');
  await page.keyboard.type('20');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await frame.locator('[data-cad-toolbar] [data-command="sketch.finish"]').click();
  await expect(frame.locator('[data-cad-toolbar="model"]')).toBeVisible();
  await tb(frame).locator('[data-command="solid.extrude"]').click();
  await expect(p.locator('[data-profile-list] [data-profile]')).toHaveCount(1);
  await setField(frame, 'distance', '10');
  await p.locator('[data-panel-done]').click();
  await expect(p).toHaveCount(0);
  expect((await boxes(page))['Body 1']).toEqual([0, 0, 20, 30, 20, 30]);
  await expect(volumeChip(frame)).toHaveText('Volume6000 mm³');
  await shot(page, 'p4a-plane-sketch-extrude');

  // The plane moves up to 35: the sketch and the extrude follow (z 35..45).
  await featureRow(frame, 'Plane 1').locator('> .tree-row').dblclick();
  await expect(p.locator('[data-panel-title]')).toHaveText('Plane 1');
  // A sketch uses it: no Delete in the foot.
  await expect(p.locator('[data-panel-delete]')).toHaveCount(0);
  await setField(frame, 'distance', '35');
  await p.locator('[data-panel-done]').click();
  await expect.poll(async () => JSON.stringify((await boxes(page))['Body 1'])).toBe(JSON.stringify([0, 0, 35, 30, 20, 45]));
  // Delete from the tree's menu is offered disabled, with the reason.
  await featureRow(frame, 'Plane 1').locator('> .tree-row').click({ button: 'right' });
  const del = frame.locator('[role="menu"] [role="menuitem"]', { hasText: /^Delete Plane 1/ });
  await expect(del).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Escape');

  // The view's menu on the plane: "Sketch on Plane 1" starts a sketch on it.
  await page.mouse.move(5, 5);
  await still(page);
  // In front of the body, on the plane's square (it spans the body's footprint, 15 % wider).
  const side = await modelOnPage(page, [15, -5, 35]);
  await page.mouse.click(side[0], side[1], { button: 'right' });
  const item = frame.locator('[role="menu"] [role="menuitem"]', { hasText: 'Sketch on Plane 1' });
  await expect(item).toBeVisible();
  await item.click();
  await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
  await expect(frame.locator('[data-cad-panel]')).toContainText('Plane 1');
  await frame.locator('[data-cad-toolbar] [data-command="sketch.finish"]').click();
  await expect(frame.locator('[data-cad-toolbar="model"]')).toBeVisible();
  expect(seen.csp).toEqual([]);
  expect(seen.errors).toEqual([]);
});

test('cad:p4a-construct-plane-face a Plane on a block\'s top face follows the block; suppressing the block turns it red with the reason', async ({ page, request }) => {
  test.setTimeout(300_000);
  const { seen, frame } = await freshPart(page, request);
  await drawBlock(page, frame, 40, 30, 20);
  await page.mouse.move(5, 5);
  await still(page);
  // The block's top face picked in the view, then Plane: offset from that face.
  const topFace = await modelOnPage(page, [20, 15, 20]);
  await page.mouse.click(topFace[0], topFace[1]);
  await tb(frame).locator('[data-command="construct.plane"]').click();
  const p = panel(frame);
  await expect(p.locator('[data-pick-list="plane"] [data-pick-row] .cad-pick-name')).toHaveText(['End face of Extrude 1']);
  await setField(frame, 'distance', '5');
  await expect(p.locator('[data-construct-readout]')).toHaveText('Built: through 0, 0, 25 mm, normal 0, 0, 1');
  await p.locator('[data-panel-done]').click();
  // The block grows to 32: the plane is on its top face, 5 mm up.
  await featureRow(frame, 'Extrude 1').locator('> .tree-row').dblclick();
  await setField(frame, 'distance', '32');
  await p.locator('[data-panel-done]').click();
  await expect.poll(async () => (await built(page, 'Plane 1')) as unknown).toEqual({ type: 'plane', frame: { origin: [0, 0, 37], normal: [0, 0, 1], xdir: [1, 0, 0] } });
  // Suppress the block's Extrude: the plane has nothing to stand on: red, with the reason.
  await featureRow(frame, 'Extrude 1').locator('> .tree-row').click({ button: 'right' });
  await frame.locator('[role="menu"] [role="menuitem"]', { hasText: 'Suppress Extrude 1' }).click();
  await expect(featureRow(frame, 'Plane 1')).toHaveAttribute('data-state', 'error');
  await expect(featureRow(frame, 'Plane 1').locator('[data-feature-badge]')).toHaveAttribute('data-message', 'Plane 1 failed: Body 1 is not there at this point');
  await expect(frame.locator('[data-construct-label]')).toHaveCount(0);
  // Its panel says so, and its row is red ("not found").
  await featureRow(frame, 'Plane 1').locator('> .tree-row').dblclick();
  await expect(p.locator('[data-pick-list="plane"] [data-pick-missing="1"]')).toHaveCount(1);
  await expect(p).toContainText('Plane 1 failed: Body 1 is not there at this point');
  await shot(page, 'p4a-plane-lost');
  await p.locator('[data-panel-done]').click();
  // Unsuppress: built again where it was.
  await featureRow(frame, 'Extrude 1').locator('> .tree-row').click({ button: 'right' });
  await frame.locator('[role="menu"] [role="menuitem"]', { hasText: 'Unsuppress Extrude 1' }).click();
  await expect(featureRow(frame, 'Plane 1')).toHaveAttribute('data-state', 'ok');
  expect(seen.csp).toEqual([]);
  expect(seen.errors).toEqual([]);
});

test('cad:p4a-construct-axis-point Axis of a cylinder (face selected first), Axis where Front and Right cross (tree picks), Point at coordinates', async ({ page, request }) => {
  test.setTimeout(300_000);
  const { seen, frame } = await freshPart(page, request);
  await addSolid(page, { circle: true, at: [10, 5, 0], size: [20, 30] });
  await page.mouse.move(5, 5);
  await still(page);
  // The cylinder's side face, then Axis: "Of a round face" with it.
  const sideAt = await modelOnPage(page, [10, -5, 15]);
  await page.mouse.click(sideAt[0], sideAt[1]);
  await runCommand(frame, 'construct.axis');
  const p = panel(frame);
  await expect(p.locator('[data-panel-title]')).toHaveText('Axis 1');
  await expect(p.locator('[data-field="method"] select')).toHaveValue('cylinder');
  await expect(p.locator('[data-pick-list="face"] [data-pick-row]')).toHaveCount(1);
  // An extruded-up cylinder's axis points up (P4a review: it read 0, 0, -1).
  await expect(p.locator('[data-construct-readout]')).toHaveText(/^Built: through 10, 5, -?\d+(\.\d+)? mm, direction 0, 0, 1$/);
  await expect(frame.locator('[data-construct-label][data-kind="axis"]')).toHaveText('Axis 1');
  await p.locator('[data-panel-done]').click();

  // Where two planes cross: Front and Right picked in the tree.
  await clickEmpty(page);
  await runCommand(frame, 'construct.axis');
  await expect(p.locator('[data-panel-title]')).toHaveText('Axis 2');
  await p.locator('[data-field="method"] select').selectOption('two_planes');
  await expect(p.locator('[data-pick-field="planes"]')).toHaveAttribute('data-active', '1');
  await frame.locator('[data-cad-tree] [data-tree-node="origin:front"] > .tree-row').click();
  await frame.locator('[data-cad-tree] [data-tree-node="origin:right"] > .tree-row').click();
  await expect(p.locator('[data-pick-list="planes"] [data-pick-row] .cad-pick-name')).toHaveText(['Front plane', 'Right plane']);
  await expect(p.locator('[data-construct-readout]')).toHaveText(/^Built: through 0, 0, \d+(\.\d+)? mm, direction 0, 0, 1$/);
  // Right taken out (its row's x), Top picked instead: Front and Top cross along X.
  await p.locator('[data-pick-list="planes"] [data-pick-remove]').nth(1).click();
  await expect(p.locator('[data-pick-list="planes"] [data-pick-row] .cad-pick-name')).toHaveText(['Front plane']);
  await frame.locator('[data-cad-tree] [data-tree-node="origin:top"] > .tree-row').click();
  await expect(p.locator('[data-pick-list="planes"] [data-pick-row] .cad-pick-name')).toHaveText(['Front plane', 'Top plane']);
  await expect(p.locator('[data-construct-readout]')).toHaveText(/^Built: through -?\d+(\.\d+)?, 0, 0 mm, direction 1, 0, 0$/);
  await p.locator('[data-panel-done]').click();
  await expect(featureRow(frame, 'Axis 2')).toHaveAttribute('data-state', 'ok');

  // A Point at coordinates: drawn as a dot, labelled, and picked by a click on it.
  await clickEmpty(page);
  await runCommand(frame, 'construct.point');
  await expect(p.locator('[data-panel-title]')).toHaveText('Point 1');
  await p.locator('[data-field="method"] select').selectOption('coordinates');
  await setField(frame, 'x', '-20');
  await setField(frame, 'y', '30');
  await setField(frame, 'z', '40');
  await expect(p.locator('[data-construct-readout]')).toHaveText('Built: at -20, 30, 40 mm');
  await p.locator('[data-panel-done]').click();
  await expect(frame.locator('[data-construct-label][data-kind="point"]')).toHaveText('Point 1');
  // Fit frames the point too.
  await tb(frame).locator('[data-command="view.fit"]').click();
  await still(page);
  const dot = await modelOnPage(page, [-20, 30, 40]);
  await page.mouse.click(dot[0], dot[1]);
  await expect(frame.locator('[data-construct-label][data-kind="point"]')).toHaveAttribute('data-state', 'pick');
  await expect(featureRow(frame, 'Point 1')).toHaveAttribute('aria-selected', 'true');
  // Hidden with its eye: not drawn; shown again.
  await featureRow(frame, 'Point 1').locator('[data-construct-act="visibility"]').click();
  await expect(frame.locator('[data-construct-label][data-kind="point"]')).toHaveCount(0);
  await featureRow(frame, 'Point 1').locator('[data-construct-act="visibility"]').click();
  await expect(frame.locator('[data-construct-label][data-kind="point"]')).toHaveCount(1);
  await shot(page, 'p4a-axis-point');
  expect(seen.csp).toEqual([]);
  expect(seen.errors).toEqual([]);
});

test('cad:p4a-construct-edges a Point at a vertex, an Axis along an edge and a Plane normal to an edge, picked in the view, follow the block; a Plane normal to a sketch curve (a Sweep path)', async ({ page, request }) => {
  test.setTimeout(300_000);
  const { seen, frame } = await freshPart(page, request);
  await addSolid(page, { size: [40, 30, 20] });
  const p = panel(frame);
  // A Point: "At a vertex", the block's corner (40, 0, 20) clicked in the view.
  await clickEmpty(page);
  await runCommand(frame, 'construct.point');
  await expect(p.locator('[data-panel-title]')).toHaveText('Point 1');
  await expect(p.locator('[data-field="method"] select')).toHaveValue('vertex');
  await page.mouse.move(5, 5);
  await still(page);
  let at = await modelOnPage(page, [40, 0, 20]);
  await page.mouse.click(at[0], at[1]);
  await expect(p.locator('[data-pick-list="vertex"] [data-pick-row]')).toHaveCount(1);
  await expect(p.locator('[data-pick-list="vertex"] [data-pick-row] .cad-pick-name')).toHaveText(/^Corner of .+ of Extrude 1$/);
  await expect(p.locator('[data-construct-readout]')).toHaveText('Built: at 40, 0, 20 mm');
  await p.locator('[data-panel-done]').click();

  // An Axis "Along an edge": the top front edge (y = 0, z = 20) clicked at its middle.
  await clickEmpty(page);
  await runCommand(frame, 'construct.axis');
  await p.locator('[data-field="method"] select').selectOption('edge');
  await expect(p.locator('[data-pick-field="edge"]')).toHaveAttribute('data-active', '1');
  await page.mouse.move(5, 5);
  await still(page);
  at = await modelOnPage(page, [20, 0, 20]);
  await page.mouse.click(at[0], at[1]);
  await expect(p.locator('[data-pick-list="edge"] [data-pick-row] .cad-pick-name')).toHaveText(/^.+ · .+ of Extrude 1$/);
  await expect(p.locator('[data-construct-readout]')).toHaveText(/^Built: through -?\d+(\.\d+)?, 0, 20 mm, direction -?1, 0, 0$/);
  await p.locator('[data-panel-done]').click();

  // A Plane "Normal to a curve" on the vertical edge at (40, 0), half way up.
  await clickEmpty(page);
  await tb(frame).locator('[data-command="construct.plane"]').click();
  await p.locator('[data-field="method"] select').selectOption('normal_to_curve');
  await page.mouse.move(5, 5);
  await still(page);
  at = await modelOnPage(page, [40, 0, 10]);
  await page.mouse.click(at[0], at[1]);
  await expect(p.locator('[data-pick-list="edge"] [data-pick-row]')).toHaveCount(1);
  await expect(p.locator('.nui[data-field="percent"] input')).toHaveValue('50');
  await expect(p.locator('[data-construct-readout]')).toHaveText(/^Built: through 40, 0, 10 mm, normal 0, 0, -?1$/);
  await p.locator('[data-panel-done]').click();
  await expect(featureRow(frame, 'Plane 1')).toHaveAttribute('data-state', 'ok');

  // The block 30 high: the corner point, the edge's axis and the normal plane follow it.
  await featureRow(frame, 'Extrude 1').locator('> .tree-row').dblclick();
  await setField(frame, 'distance', '30');
  await p.locator('[data-panel-done]').click();
  await expect.poll(async () => (await built(page, 'Point 1')) as unknown).toEqual({ type: 'point', p: [40, 0, 30] });
  await expect.poll(async () => ((await built(page, 'Plane 1')) as { frame?: { origin: number[] } } | null)?.frame?.origin).toEqual([40, 0, 15]);
  await expect.poll(async () => ((await built(page, 'Axis 1')) as { origin?: number[] } | null)?.origin?.slice(1)).toEqual([0, 30]);
  for (const n of ['Point 1', 'Axis 1', 'Plane 1']) await expect(featureRow(frame, n)).toHaveAttribute('data-state', 'ok');
  await shot(page, 'p4a-edges-follow');

  // A sketch with a line (a Sweep path, say) on Top, off the block: Plane "Normal to a curve" on it, at its start.
  await addSketch(page, { at: [60, 0], size: [20, 10] });
  await clickEmpty(page);
  await tb(frame).locator('[data-command="construct.plane"]').click();
  await expect(p.locator('[data-panel-title]')).toHaveText('Plane 2');
  await p.locator('[data-field="method"] select').selectOption('normal_to_curve');
  await page.mouse.move(5, 5);
  await still(page);
  // The rectangle's first line runs from (60, 0) to (80, 0) on Top.
  at = await modelOnPage(page, [70, 0, 0]);
  await page.mouse.click(at[0], at[1]);
  await expect(p.locator('[data-pick-list="edge"] [data-pick-row] .cad-pick-name')).toHaveText('Line 1 of Sketch 2');
  await setField(frame, 'percent', '0');
  await expect(p.locator('[data-construct-readout]')).toHaveText('Built: through 60, 0, 0 mm, normal 1, 0, 0');
  await p.locator('[data-panel-done]').click();
  await expect(featureRow(frame, 'Plane 2')).toHaveAttribute('data-state', 'ok');
  expect(seen.csp).toEqual([]);
  expect(seen.errors).toEqual([]);
});

test('cad:p4a-volume-chip a part and an Enclosure: each body with its own volume, never added; the selected body alone', async ({ page, request }) => {
  test.setTimeout(240_000);
  const { seen, frame } = await freshPart(page, request);
  await addSolid(page, { size: [20, 20, 20] });
  await expect(volumeChip(frame)).toHaveText('Volume8000 mm³');
  // An Enclosure 10 mm out on every side: 40 x 40 x 40.
  await tb(frame).locator('[data-command="cfd.enclosure"]').click();
  const p = panel(frame);
  await p.locator('[data-field="padding"] select').selectOption('fixed');
  await expect(p.locator('.nui[data-field="distance"] input')).toHaveValue('10');
  await p.locator('[data-panel-done]').click();
  // Nothing selected (Escape lets go of the selection; a click "on empty space" can land on the
  // Enclosure when the view has not refitted yet: real Chrome, P4a integration).
  await page.keyboard.press('Escape');
  await expect(volumeChip(frame)).toHaveText('VolumeBody 1: 8000 mm³ · Enclosure 1: 64,000 mm³');
  await expect(volumeChip(frame)).not.toContainText('72,000');
  const vols = await volumeChip(frame).locator('[data-volume-mm3]').evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-volume-mm3'))));
  expect(vols).toHaveLength(2);
  expect(vols[0]).toBeCloseTo(8000, 6);
  expect(vols[1]).toBeCloseTo(64000, 6);
  await shot(page, 'p4a-volume-chip-two-bodies');
  // The selected body's volume alone (a tree row click).
  const folder = frame.locator('[data-cad-tree] [data-bodies-folder]');
  if ((await folder.getAttribute('aria-expanded')) !== 'true') await folder.locator('> .tree-row .tw').click();
  await frame.locator('[data-cad-tree] [data-body-row]').filter({ hasText: 'Enclosure 1' }).locator('.tree-row').first().click();
  await expect(volumeChip(frame)).toHaveText('VolumeEnclosure 1 · 64,000 mm³');
  await frame.locator('[data-cad-tree] [data-body-row]').filter({ hasText: 'Body 1' }).locator('.tree-row').first().click();
  await expect(volumeChip(frame)).toHaveText('VolumeBody 1 · 8000 mm³');
  // Both selected: each on its own, still not added.
  await frame.locator('[data-cad-tree] [data-body-row]').filter({ hasText: 'Enclosure 1' }).locator('.tree-row').first().click({ modifiers: ['Control'] });
  await expect(volumeChip(frame)).toHaveText('VolumeBody 1: 8000 mm³ · Enclosure 1: 64,000 mm³');
  // The Enclosure hidden, nothing selected: the part's alone, and the chip says one is not listed.
  await page.keyboard.press('Escape');
  await frame.locator('[data-cad-tree] [data-body-row]').filter({ hasText: 'Enclosure 1' }).locator('[data-body-act="visibility"]').click();
  await expect(volumeChip(frame)).toHaveText('VolumeBody 1 · 8000 mm³ (1 hidden body not listed)');
  expect(seen.csp).toEqual([]);
  expect(seen.errors).toEqual([]);
});
