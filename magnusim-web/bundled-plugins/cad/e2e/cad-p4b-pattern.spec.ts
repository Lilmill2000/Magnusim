// P4b PATTERN: the PATTERN group beside Extrude (Linear pattern, Circular pattern, Mirror) as a
// user meets it: the command in the toolbar with a feature row, a body or faces picked, the
// direction, axis or plane picked from the tree, values typed, a copy skipped by clicking its
// number in the view, Done. Asserted: the tree rows and their state, the panel's words, the
// copies' markers, the volume chip (analytic volumes), and the failure words (a copy that does
// not touch the body under Join). Also the Measure carry-over: picks survive a rebuild that
// leaves them as they were. Setup (blocks, holes) goes in through the document, as the other
// specs do.
// Owner: P4b PATTERN.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type APIRequestContext, type FrameLocator, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { addSolid, chipVolumes, featureRowNamed, modelOnPage, newPartFromTree, newProject, openProject, partOpened, runCommand, watchPage, workspaceFrame } from './helpers';

type V3 = [number, number, number];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type W = { __CAD__: { services: any } };

async function freshPart(page: Page, request: APIRequestContext) {
  const seen = await watchPage(page);
  const projectId = await newProject(request);
  await openProject(page, projectId);
  await newPartFromTree(page, 'Part 1');
  const frame = await partOpened(page);
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  return { seen, frame };
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

/** The volumes the chip lists (sorted), waiting for them to be `want` within `rel`. */
async function expectVolumes(frame: FrameLocator, want: number[], rel = 1e-6) {
  const sorted = [...want].sort((a, b) => a - b);
  await expect
    .poll(
      async () => {
        const got = (await chipVolumes(frame)).sort((a, b) => a - b);
        return got.length === sorted.length && got.every((g, i) => Math.abs(g / sorted[i] - 1) < rel) ? 'ok' : got.join(', ');
      },
      { timeout: 30_000 },
    )
    .toBe('ok');
}

const panel = (frame: FrameLocator) => frame.locator('[data-cad-panel="feature"]');
const foot = (frame: FrameLocator) => panel(frame).locator('[data-run-reason] .mgk-reason-msg');
const words = (frame: FrameLocator) => panel(frame).locator('[data-instance-words]');
const marker = (frame: FrameLocator, key: string) => frame.locator(`.cad-pattern-markers [data-pattern-marker="${key}"]`);

/** A history row clicked: it is selected, as a user selects a feature before a command. */
async function selectRow(frame: FrameLocator, name: string) {
  const row = frame.locator('[data-cad-tree] [data-feature-row]').filter({ has: frame.locator('> .tree-row .tl', { hasText: new RegExp(`^(?:[(]-[)] )?${name}$`) }) });
  await row.locator('> .tree-row').click();
  await expect(row).toHaveAttribute('aria-selected', 'true');
}

/** An Origin row (plane or axis) clicked in the tree: what an active pick field takes. */
async function originRow(frame: FrameLocator, ref: 'origin:x' | 'origin:y' | 'origin:z' | 'origin:top' | 'origin:front' | 'origin:right') {
  await frame.locator(`[data-tree-node="${ref}"] > .tree-row`).click();
}

async function typeIn(frame: FrameLocator, field: string, value: string) {
  const input = panel(frame).locator(`.nui[data-field="${field}"] input`);
  await input.fill(value);
  await input.press('Enter');
  await expect(panel(frame).locator(`.nui[data-field="${field}"] [data-nui-error]`)).toHaveCount(0);
}

/** A click on a model point once the view is still (two reads 150 ms apart at the same spot). */
async function clickAt(page: Page, p: V3) {
  let last = '';
  await expect
    .poll(async () => {
      const moving = await workspaceFrame(page).evaluate(() => (window as unknown as W).__CAD__.services.viewport.get().handle?.state.get().animating ?? true);
      const at = moving ? 'moving' : (await modelOnPage(page, p)).map((v) => v.toFixed(1)).join(',');
      const same = at !== 'moving' && at === last;
      last = at;
      return same;
    }, { intervals: [150] })
    .toBe(true);
  const [x, y] = await modelOnPage(page, p);
  await page.mouse.move(x, y);
  await page.mouse.click(x, y);
}

const HOLE = (r: number, h: number) => Math.PI * r * r * h;

/** A screenshot into CAD_E2E_SHOTS (nothing without it). */
async function shot(page: Page, name: string) {
  const dir = process.env.CAD_E2E_SHOTS;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: join(dir, `${name}.png`) });
}

test.describe('P4b patterns', () => {
  test('cad:p4b-pattern-linear a hole (Extrude Cut) patterned along X: 4 holes, the panel says so, a copy skipped by its number in the view and made again; count 5; undo', { tag: '@smoke' }, async ({ page, request }) => {
    const { seen, frame } = await freshPart(page, request);
    // The PATTERN group sits right after SOLID, greyed with the reason until a body exists.
    const labels = await frame.locator('[data-cad-toolbar="model"] .tb-group-label').allTextContents();
    expect(labels.slice(0, 3)).toEqual(['SKETCH', 'SOLID', 'PATTERN']);
    await expect(frame.locator('[data-cad-toolbar] [data-group="pattern"] [data-command="pattern.linear"]')).toHaveAttribute('data-disabled-reason', 'Make or import a body first');
    // A 100 x 20 x 10 plate and a hole d 6 at (10, 10) cut through it.
    await addSolid(page, { size: [100, 20, 10] });
    await addSolid(page, { circle: true, at: [10, 10, 0], size: [6, 10], op: 'cut' });
    await settled(page);
    const plate = 100 * 20 * 10;
    const hole = HOLE(3, 10);
    await expectVolumes(frame, [plate - hole]);
    // Extrude 2 selected (its row), then Linear pattern: the panel repeats it, As each feature (Cut).
    await page.keyboard.press('Escape');
    await selectRow(frame, 'Extrude 2');
    await runCommand(frame, 'pattern.linear');
    await expect(panel(frame).locator('[data-feature-panel="pattern_linear"]')).toBeVisible();
    await expect(panel(frame).locator('[data-field="of"] select')).toHaveValue('features');
    await expect(panel(frame).locator('[data-pick-field="features"] [data-pick-row]')).toHaveText([/^Extrude 2\s*Cut/]);
    await expect(panel(frame).locator('[data-field="op"] select option:checked')).toHaveText('As each feature');
    await expect(panel(frame).locator('[data-op-words]')).toHaveText("Each feature's own: Cut");
    // Direction 1: the X axis row under Origin.
    await expect(panel(frame).locator('[data-pick-field="dir1"]')).toHaveAttribute('data-active', '1');
    await originRow(frame, 'origin:x');
    await expect(panel(frame).locator('[data-pick-field="dir1"] [data-pick-row]')).toHaveText(/X axis/);
    await typeIn(frame, 'dir1-count', '4');
    await typeIn(frame, 'dir1-distance', '20');
    await settled(page);
    await expect(featureRowNamed(frame, 'Linear pattern 1')).toHaveAttribute('data-state', 'ok');
    await expectVolumes(frame, [plate - 4 * hole]);
    await expect(words(frame)).toHaveText('4 instances: the original and 3 copies');
    // A number on each copy (2, 3, 4) and the original's 1.
    await expect(frame.locator('.cad-pattern-markers button[data-pattern-marker]')).toHaveCount(3);
    await expect(marker(frame, 'original')).toHaveText('1');
    // Instance 3 skipped by a click on its number: 3 holes; the panel and the marker say so.
    await marker(frame, '3').click();
    await settled(page);
    await expectVolumes(frame, [plate - 3 * hole]);
    await expect(words(frame)).toHaveText('4 instances: the original and 3 copies, 1 skipped');
    await expect(marker(frame, '3')).toHaveAttribute('aria-pressed', 'true');
    await expect(panel(frame).locator('[data-skipped-instance="3"]')).toContainText('Instance 3 · skipped');
    await shot(page, 'p4b-pattern-linear-skipped');
    // Made again from the panel's row.
    await panel(frame).locator('[data-restore-instance="3"]').click();
    await settled(page);
    await expectVolumes(frame, [plate - 4 * hole]);
    await expect(marker(frame, '3')).toHaveAttribute('aria-pressed', 'false');
    await panel(frame).locator('[data-panel-done]').click();
    await expect(panel(frame)).toHaveCount(0);
    // Reopened: count 5.
    await featureRowNamed(frame, 'Linear pattern 1').locator('> .tree-row').dblclick();
    await expect(panel(frame).locator('.nui[data-field="dir1-count"] input')).toHaveValue('4');
    await typeIn(frame, 'dir1-count', '5');
    await settled(page);
    await expectVolumes(frame, [plate - 5 * hole]);
    await expect(words(frame)).toHaveText('5 instances: the original and 4 copies');
    await panel(frame).locator('[data-panel-done]').click();
    // Undo: back to 4 holes; Redo: 5.
    await page.keyboard.press('Control+z');
    await expectVolumes(frame, [plate - 4 * hole]);
    await page.keyboard.press('Control+y');
    await expectVolumes(frame, [plate - 5 * hole]);
    expect(seen.errors).toEqual([]);
  });

  test('cad:p4b-pattern-fillet-instance a fillet on the rim of instance 3 keeps its edge when the count goes from 4 to 5 (the copies are named after their source)', async ({ page, request }) => {
    const { seen, frame } = await freshPart(page, request);
    await addSolid(page, { size: [100, 20, 10] });
    await addSolid(page, { circle: true, at: [10, 10, 0], size: [6, 10], op: 'cut' });
    await settled(page);
    await page.keyboard.press('Escape');
    await selectRow(frame, 'Extrude 2');
    await runCommand(frame, 'pattern.linear');
    await originRow(frame, 'origin:x');
    await typeIn(frame, 'dir1-count', '4');
    await typeIn(frame, 'dir1-distance', '20');
    await settled(page);
    await panel(frame).locator('[data-panel-done]').click();
    await expect(panel(frame)).toHaveCount(0);
    // Fillet 1 mm on the top rim of instance 3 (the hole at x = 50), clicked in the view.
    await page.keyboard.press('Escape');
    await runCommand(frame, 'modify.fillet');
    await expect(panel(frame).locator('[data-feature-panel="fillet"]')).toBeVisible();
    await clickAt(page, [50, 7, 10]);
    await expect(panel(frame).locator('[data-pick-row]')).toHaveCount(1);
    await expect(panel(frame).locator('[data-pick-row]').first()).toContainText('instance 3');
    const row = (await panel(frame).locator('[data-pick-row]').first().textContent())!.replace('×', '').trim();
    await typeIn(frame, 'radius', '1');
    await settled(page);
    await expect(featureRowNamed(frame, 'Fillet 1')).toHaveAttribute('data-state', 'ok');
    const filleted = (await chipVolumes(frame))[0];
    expect(filleted).toBeLessThan(100 * 20 * 10 - 4 * HOLE(3, 10));
    await panel(frame).locator('[data-panel-done]').click();
    // Count 5: one more hole; Fillet 1 still finds instance 3's rim (no red, no repair).
    await featureRowNamed(frame, 'Linear pattern 1').locator('> .tree-row').dblclick();
    await typeIn(frame, 'dir1-count', '5');
    await settled(page);
    await panel(frame).locator('[data-panel-done]').click();
    await expect(featureRowNamed(frame, 'Fillet 1')).toHaveAttribute('data-state', 'ok');
    await expectVolumes(frame, [filleted - HOLE(3, 10)], 1e-5);
    await featureRowNamed(frame, 'Fillet 1').locator('> .tree-row').dblclick();
    await expect(panel(frame).locator('[data-pick-row]')).toHaveCount(1);
    await expect(panel(frame).locator('[data-pick-row]').first()).toContainText(row.replace(/\s+/g, ' ').slice(0, 20));
    await expect(panel(frame).locator('[data-pick-missing]')).toHaveCount(0);
    expect(seen.errors).toEqual([]);
  });

  test('cad:p4b-pattern-join-fails a block patterned as a body: New body makes copies; Join with copies apart is red, names them, and the block still shows; touching, one body', async ({ page, request }) => {
    const { seen, frame } = await freshPart(page, request);
    await addSolid(page, { size: [10, 10, 10] });
    await settled(page);
    await page.keyboard.press('Escape');
    await runCommand(frame, 'pattern.linear');
    await panel(frame).locator('[data-field="of"] select').selectOption('bodies');
    await expect(panel(frame).locator('[data-pick-field="bodies"]')).toHaveAttribute('data-active', '1');
    await clickAt(page, [5, 5, 10]);
    await expect(panel(frame).locator('[data-pick-field="bodies"] [data-pick-row]')).toHaveText([/^Body 1/]);
    await expect(panel(frame).locator('[data-field="op"] select')).toHaveValue('new');
    // The Bodies list stays active for more bodies; an axis row in the tree goes to the direction.
    await expect(panel(frame).locator('[data-pick-field="bodies"]')).toHaveAttribute('data-active', '1');
    await originRow(frame, 'origin:x');
    await expect(panel(frame).locator('[data-pick-field="dir1"] [data-pick-row]')).toHaveText(/X axis/);
    await typeIn(frame, 'dir1-count', '3');
    await typeIn(frame, 'dir1-distance', '15');
    await settled(page);
    await expect(frame.locator('[data-cad-tree] [data-body-row] .tl')).toHaveText([/^Body 1$/, /^Body 1 \(Instance 2\)$/, /^Body 1 \(Instance 3\)$/]);
    // The volume chip lists each body once the panel (which shows its body selected) is closed.
    await panel(frame).locator('[data-panel-done]').click();
    await expect(panel(frame)).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expectVolumes(frame, [1000, 1000, 1000]);
    // Join: the copies stand 5 mm apart: red, with the copies named; the block still shows.
    await featureRowNamed(frame, 'Linear pattern 1').locator('> .tree-row').dblclick();
    await panel(frame).locator('[data-field="op"] select').selectOption('join');
    await settled(page);
    await expect(foot(frame)).toHaveText("Linear pattern 1 failed: Instances 2 and 3 of Body 1 don't touch Body 1; Join needs overlap. Use New body or change the spacing");
    await expect(featureRowNamed(frame, 'Linear pattern 1')).toHaveAttribute('data-state', 'error');
    await expectVolumes(frame, [1000]);
    await expect(marker(frame, '2')).toHaveClass(/is-failed/);
    await shot(page, 'p4b-pattern-join-fails');
    // 10 mm apart they share faces: one body of 3000.
    await typeIn(frame, 'dir1-distance', '10');
    await settled(page);
    await expect(featureRowNamed(frame, 'Linear pattern 1')).toHaveAttribute('data-state', 'ok');
    await expectVolumes(frame, [3000]);
    await panel(frame).locator('[data-panel-done]').click();
    expect(seen.errors).toEqual([]);
  });

  test('cad:p4b-pattern-circular six holes about the Z axis (full 360°); then 3 over 90°; then symmetric: 5', async ({ page, request }) => {
    const { seen, frame } = await freshPart(page, request);
    // A disc d 60, 5 thick, and a hole d 6 at (20, 0).
    await addSolid(page, { circle: true, size: [60, 5] });
    await addSolid(page, { circle: true, at: [20, 0, 0], size: [6, 5], op: 'cut' });
    await settled(page);
    const disc = Math.PI * 900 * 5;
    const hole = HOLE(3, 5);
    await page.keyboard.press('Escape');
    await selectRow(frame, 'Extrude 2');
    await runCommand(frame, 'pattern.circular');
    await expect(panel(frame).locator('[data-pick-field="axis"]')).toHaveAttribute('data-active', '1');
    await originRow(frame, 'origin:z');
    await expect(panel(frame).locator('[data-pick-field="axis"] [data-pick-row]')).toHaveText(/Z axis/);
    await typeIn(frame, 'count', '6');
    await settled(page);
    await expectVolumes(frame, [disc - 6 * hole]);
    await expect(words(frame)).toHaveText('6 instances: the original and 5 copies');
    await expect(frame.locator('.cad-pattern-markers button[data-pattern-marker]')).toHaveCount(5);
    await panel(frame).locator('[data-field="mode"] select').selectOption('angle');
    await typeIn(frame, 'count', '3');
    await typeIn(frame, 'angle', '90');
    await settled(page);
    await expectVolumes(frame, [disc - 3 * hole]);
    await panel(frame).locator('input[data-field="symmetric"]').check();
    await settled(page);
    await expectVolumes(frame, [disc - 5 * hole]);
    await expect(words(frame)).toHaveText('5 instances: the original and 4 copies');
    await panel(frame).locator('[data-panel-done]').click();
    await expect(featureRowNamed(frame, 'Circular pattern 1')).toHaveAttribute('data-state', 'ok');
    expect(seen.errors).toEqual([]);
  });

  test('cad:p4b-mirror a block mirrored across the Right plane (As each feature: New body) is a second body; a block against the plane mirrored as a body with Join is one body', async ({ page, request }) => {
    const { seen, frame } = await freshPart(page, request);
    await addSolid(page, { at: [5, 0, 0], size: [10, 10, 10] });
    await settled(page);
    await page.keyboard.press('Escape');
    await selectRow(frame, 'Extrude 1');
    await runCommand(frame, 'pattern.mirror');
    await expect(panel(frame).locator('[data-pick-field="plane"]')).toHaveAttribute('data-active', '1');
    await originRow(frame, 'origin:right');
    await expect(panel(frame).locator('[data-pick-field="plane"] [data-pick-row]')).toHaveText(/Right plane/);
    await settled(page);
    await expectVolumes(frame, [1000, 1000]);
    await expect(frame.locator('[data-cad-tree] [data-body-row]')).toHaveText([/Body 1/, /Body 1 \(Mirror copy\)/]);
    await expect(words(frame)).toHaveText('The original and its mirror copy');
    await panel(frame).locator('[data-panel-done]').click();
    await expect(featureRowNamed(frame, 'Mirror 1')).toHaveAttribute('data-state', 'ok');
    // A second Part step: a block from x = 0 (against the Right plane), mirrored as a body, Join.
    await addSolid(page, { at: [0, 30, 0], size: [10, 10, 10] });
    await settled(page);
    await page.keyboard.press('Escape');
    await runCommand(frame, 'pattern.mirror');
    await panel(frame).locator('[data-field="of"] select').selectOption('bodies');
    await clickAt(page, [5, 35, 10]);
    await expect(panel(frame).locator('[data-pick-field="bodies"] [data-pick-row]')).toHaveCount(1);
    await panel(frame).locator('[data-pick-field="plane"] [data-pick-list]').click();
    await originRow(frame, 'origin:right');
    await panel(frame).locator('[data-field="op"] select').selectOption('join');
    await settled(page);
    await expect(featureRowNamed(frame, 'Mirror 2')).toHaveAttribute('data-state', 'ok');
    await panel(frame).locator('[data-panel-done]').click();
    await page.keyboard.press('Escape');
    await expectVolumes(frame, [1000, 1000, 2000]);
    expect(seen.errors).toEqual([]);
  });

  test('cad:p4b-pattern-edge-face a body patterned along an edge clicked in the view; a body mirrored across its own top face clicked in the view (Join)', async ({ page, request }) => {
    const { seen, frame } = await freshPart(page, request);
    await addSolid(page, { size: [10, 10, 10] });
    await settled(page);
    await page.keyboard.press('Escape');
    await runCommand(frame, 'pattern.linear');
    await panel(frame).locator('[data-field="of"] select').selectOption('bodies');
    await clickAt(page, [5, 5, 10]);
    await expect(panel(frame).locator('[data-pick-field="bodies"] [data-pick-row]')).toHaveCount(1);
    // Direction 1: its box clicked, then the block's bottom front edge (along X) clicked in the view.
    await panel(frame).locator('[data-pick-field="dir1"] [data-pick-list]').click();
    await expect(panel(frame).locator('[data-pick-field="dir1"]')).toHaveAttribute('data-active', '1');
    await clickAt(page, [5, 0, 0]);
    await expect(panel(frame).locator('[data-pick-field="dir1"] [data-pick-row]')).toHaveCount(1);
    await expect(panel(frame).locator('[data-pick-field="dir1"] [data-pick-row] [data-pick-sub]')).toHaveText('edge');
    await typeIn(frame, 'dir1-count', '2');
    await typeIn(frame, 'dir1-distance', '10');
    await settled(page);
    await expect(featureRowNamed(frame, 'Linear pattern 1')).toHaveAttribute('data-state', 'ok');
    await expect(frame.locator('[data-cad-tree] [data-body-row] .tl')).toHaveText([/^Body 1$/, /^Body 1 \(Instance 2\)$/]);
    await panel(frame).locator('[data-panel-done]').click();
    await page.keyboard.press('Escape');
    await expectVolumes(frame, [1000, 1000]);
    // Mirror Body 1 across its top face (z = 10), clicked in the view, joined to it: 2000.
    await runCommand(frame, 'pattern.mirror');
    await panel(frame).locator('[data-field="of"] select').selectOption('bodies');
    await clickAt(page, [5, 5, 10]);
    await expect(panel(frame).locator('[data-pick-field="bodies"] [data-pick-row]')).toHaveText([/^Body 1/]);
    await panel(frame).locator('[data-pick-field="plane"] [data-pick-list]').click();
    await expect(panel(frame).locator('[data-pick-field="plane"]')).toHaveAttribute('data-active', '1');
    await clickAt(page, [3, 3, 10]);
    await expect(panel(frame).locator('[data-pick-field="plane"] [data-pick-row]')).toHaveText(/End face of Extrude 1/);
    await panel(frame).locator('[data-field="op"] select').selectOption('join');
    await settled(page);
    await expect(featureRowNamed(frame, 'Mirror 1')).toHaveAttribute('data-state', 'ok');
    await panel(frame).locator('[data-panel-done]').click();
    await page.keyboard.press('Escape');
    await expectVolumes(frame, [1000, 2000]);
    expect(seen.errors).toEqual([]);
  });

  test('cad:p4b-pattern-faces the faces of a round boss picked in the view and patterned along X: copies of the boss on the same body (3 bosses)', async ({ page, request }) => {
    const { seen, frame } = await freshPart(page, request);
    await addSolid(page, { size: [60, 20, 10] });
    // A boss d 10, 5 tall on the top at (10, 10), joined.
    await addSolid(page, { circle: true, at: [10, 10, 10], size: [10, 5], op: 'join' });
    await settled(page);
    const block = 60 * 20 * 10;
    const boss = Math.PI * 25 * 5;
    await expectVolumes(frame, [block + boss]);
    await page.keyboard.press('Escape');
    await runCommand(frame, 'pattern.linear');
    await panel(frame).locator('[data-field="of"] select').selectOption('faces');
    await expect(panel(frame).locator('[data-pick-field="faces"]')).toHaveAttribute('data-active', '1');
    // Its top and its round side.
    await clickAt(page, [10, 10, 15]);
    await expect(panel(frame).locator('[data-pick-field="faces"] [data-pick-row]')).toHaveCount(1);
    await clickAt(page, [10, 5, 12.5]);
    await expect(panel(frame).locator('[data-pick-field="faces"] [data-pick-row]')).toHaveCount(2);
    await expect(panel(frame).locator('[data-field="op"]')).toHaveCount(0);
    await panel(frame).locator('[data-pick-field="dir1"] [data-pick-list]').click();
    await originRow(frame, 'origin:x');
    await typeIn(frame, 'dir1-count', '3');
    await typeIn(frame, 'dir1-distance', '20');
    await settled(page);
    await expect(featureRowNamed(frame, 'Linear pattern 1')).toHaveAttribute('data-state', 'ok');
    await expectVolumes(frame, [block + 3 * boss]);
    await shot(page, 'p4b-pattern-faces');
    await panel(frame).locator('[data-panel-done]').click();
    expect(seen.errors).toEqual([]);
  });

  test('cad:p4b-pattern-of-mirror a mirror of a hole, a linear pattern of that mirror, a mirror of that pattern: 4 holes; mirrored where it misses the block it is red', async ({ page, request }) => {
    const { seen, frame } = await freshPart(page, request);
    // A 40 x 20 x 10 block from x = -20, and a hole d 4 at (10, 3).
    await addSolid(page, { at: [-20, 0, 0], size: [40, 20, 10] });
    await addSolid(page, { circle: true, at: [10, 3, 0], size: [4, 10], op: 'cut' });
    await settled(page);
    const box = 40 * 20 * 10;
    const hole = HOLE(2, 10);
    const mirrorOf = async (row: string, plane: 'origin:right' | 'origin:front') => {
      await page.keyboard.press('Escape');
      await selectRow(frame, row);
      await runCommand(frame, 'pattern.mirror');
      await originRow(frame, plane);
      await settled(page);
    };
    await mirrorOf('Extrude 2', 'origin:right');
    await expectVolumes(frame, [box - 2 * hole]);
    await panel(frame).locator('[data-panel-done]').click();
    // A pattern of the mirror: 6 mm along Y.
    await page.keyboard.press('Escape');
    await selectRow(frame, 'Mirror 1');
    await runCommand(frame, 'pattern.linear');
    await originRow(frame, 'origin:y');
    await typeIn(frame, 'dir1-count', '2');
    await typeIn(frame, 'dir1-distance', '6');
    await settled(page);
    await expectVolumes(frame, [box - 3 * hole]);
    await panel(frame).locator('[data-panel-done]').click();
    // A mirror of the pattern.
    await mirrorOf('Linear pattern 1', 'origin:right');
    await expect(featureRowNamed(frame, 'Mirror 2')).toHaveAttribute('data-state', 'ok');
    await expectVolumes(frame, [box - 4 * hole]);
    await panel(frame).locator('[data-panel-done]').click();
    // Across the Front plane the pattern's copy lands outside the block: red, with the reason.
    await mirrorOf('Linear pattern 1', 'origin:front');
    await expect(foot(frame)).toHaveText('Mirror 3 failed: Nothing to cut: no copy of Linear pattern 1 overlaps a body made before it');
    await expect(featureRowNamed(frame, 'Mirror 3')).toHaveAttribute('data-state', 'error');
    await expectVolumes(frame, [box - 4 * hole]);
    expect(seen.errors).toEqual([]);
  });

  test('cad:p4b-measure-keeps-picks Measure keeps its picks through rebuilds that leave them as they were (a parameter added; the height parameter renamed); a real change clears them and says so', async ({ page, request }) => {
    const { seen, frame } = await freshPart(page, request);
    const made = await addSolid(page, { size: [20, 20, 20] });
    await settled(page);
    // The block's height is the parameter h (20 mm), set up before measuring.
    const hId = await workspaceFrame(page).evaluate((id) => {
      const d = (window as unknown as W).__CAD__.services.doc;
      const p = d.addParam({ name: 'h', expr: '20 mm', quantity: 'length' });
      const s = d.beginEdit(id);
      s.update({ extent: { kind: 'blind', distance: 'h' } });
      s.commit();
      return p as string;
    }, made.extrude);
    await settled(page);
    await page.keyboard.press('Escape');
    await runCommand(frame, 'inspect.measure');
    const tool = frame.locator('[data-tool-panel="inspect.measure"]');
    await expect(tool).toBeVisible();
    // The top face and the front face: at right angles.
    await clickAt(page, [10, 10, 20]);
    await clickAt(page, [10, 0, 10]);
    await expect(tool.locator('[data-pick-row]')).toHaveCount(2);
    await expect(tool.locator('[data-measure-value="angle"]')).toHaveText('90°');
    const seq = () => workspaceFrame(page).evaluate(() => (window as unknown as W).__CAD__.services.doc.state.get().rebuild.seq as number);
    const tess = () => workspaceFrame(page).evaluate(() => (window as unknown as W).__CAD__.services.doc.state.get().rebuild.bodies[0].tessKey as string);
    // A rebuild that changes nothing of the body (as the sketch solver arriving late did, split.md):
    // a parameter added.
    let before = await seq();
    const key0 = await tess();
    await workspaceFrame(page).evaluate(() => (window as unknown as W).__CAD__.services.doc.addParam({ name: 'unused', expr: '5 mm', quantity: 'length' }));
    await expect.poll(seq).toBeGreaterThan(before);
    await settled(page);
    expect(await tess()).toBe(key0);
    await expect(tool.locator('[data-pick-row]')).toHaveCount(2);
    await expect(tool).not.toContainText('The part changed');
    await expect(tool.locator('[data-measure-value="angle"]')).toHaveText('90°');
    // The body rebuilt with the same geometry (h renamed "height": the extrude's expression changes).
    before = await seq();
    await workspaceFrame(page).evaluate((id) => (window as unknown as W).__CAD__.services.doc.updateParam(id, { name: 'height' }), hId);
    await expect.poll(seq).toBeGreaterThan(before);
    await settled(page);
    expect(await tess()).not.toBe(key0);
    await expect(tool.locator('[data-pick-row]')).toHaveCount(2);
    await expect(tool).not.toContainText('The part changed');
    await expect(tool.locator('[data-measure-value="angle"]')).toHaveText('90°');
    // 30 mm tall: the top face moved and the front face grew: the picks go, and the panel says why.
    await workspaceFrame(page).evaluate((id) => (window as unknown as W).__CAD__.services.doc.updateParam(id, { expr: '30 mm' }), hId);
    await settled(page);
    await expect(tool.locator('[data-pick-row]')).toHaveCount(0);
    await expect(tool).toContainText('The part changed: pick again');
    expect(seen.errors).toEqual([]);
  });
});
