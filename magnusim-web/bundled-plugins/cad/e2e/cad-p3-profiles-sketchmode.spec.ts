// P3-PROFILES with sketch mode (P3-SKETCH): a sketch drawn with the mouse (a
// rectangle by two corners, a circle by its centre and a typed diameter)
// shows its closed regions shaded while it is drawn, and after Finish sketch
// a region clicked in the view extrudes from the E key. The draft for the
// phase gate's "draw, then extrude" path; the numbers come from what the
// panel says (the drawn sizes depend on where the clicks land and snap).
// Needs the kernel's API 3 profile ops (CAD_E2E_KERNEL_DIR serves a build that
// has them, as in cad-p3-profiles-extrude.spec.ts).
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { newPartFromTree, newProject, openProject, partOpened, watchPage, workspaceFrame } from './helpers';
import { PNG } from './png';

type V3 = [number, number, number];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type W = { __CAD__: { services: any } };

const KERNEL_DIR = process.env.CAD_E2E_KERNEL_DIR;
test.beforeEach(async ({ context }) => {
  if (!KERNEL_DIR) return;
  for (const f of ['mk32.mjs', 'mk32.wasm']) {
    await context.route(`**/plugins/cad/workspace/kernel/${f}`, (route) => route.fulfill({ path: join(KERNEL_DIR, f), contentType: f.endsWith('.wasm') ? 'application/wasm' : 'text/javascript' }));
  }
});

async function shot(page: Page, name: string) {
  const dir = process.env.CAD_E2E_SHOTS;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: join(dir, `${name}.png`) });
}

/** Page point of a model point, through the viewport's own projection. */
async function at(page: Page, p: V3): Promise<[number, number]> {
  const s = await workspaceFrame(page).evaluate((q) => (window as unknown as W).__CAD__.services.viewport.get().handle.project(q) as [number, number] | null, p);
  expect(s, `projection of ${p}`).not.toBeNull();
  const box = (await page.locator('#workspace-frame').boundingBox())!;
  return [box.x + s![0], box.y + s![1]];
}

/** Mean colour of a 7 x 7 patch (grid lines or a stray pixel do not decide it). */
async function patch(page: Page, pt: [number, number]): Promise<[number, number, number]> {
  const img = PNG.decode(await page.screenshot({ clip: { x: Math.round(pt[0]) - 3, y: Math.round(pt[1]) - 3, width: 7, height: 7 } }));
  const sum = [0, 0, 0];
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) PNG.at(img, x, y).forEach((v, i) => (sum[i] += v));
  return sum.map((v) => v / (img.width * img.height)) as [number, number, number];
}

/** Every sketch edit has been solved and stored (sketch mode's queue is empty). */
async function sketchIdle(page: Page) {
  await workspaceFrame(page).evaluate(async () => {
    const api = (window as unknown as W).__CAD__.services.apis.get().sketch as { idle?(): Promise<void> } | null;
    await api?.idle?.();
  });
}

async function clickModel(page: Page, p: V3) {
  const s = await at(page, p);
  await page.mouse.click(s[0], s[1]);
}

test('cad:p3-profiles-sketchmode a rectangle and a circle drawn in sketch mode shade their regions while drawn; after Finish sketch the plate region extrudes from E', async ({ page, request }) => {
  const seen = await watchPage(page);
  const projectId = await newProject(request);
  await openProject(page, projectId);
  await newPartFromTree(page, 'Part 1');
  const frame = await partOpened(page);
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');

  // Sketch on the Top plane.
  await frame.locator('[data-tree-node="origin:top"] > .tree-row').click();
  await frame.locator('[data-command="sketch.new"]').click();
  await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
  await expect.poll(() => frame.locator('[data-cad-app]').evaluate(() => (window as unknown as W).__CAD__.services.viewport.get().handle.state.get().animating)).toBe(false);

  // A rectangle (two corners) and a circle inside it (centre, then a point on it).
  await frame.locator('[data-command="sketch.rectangle"]').click();
  await clickModel(page, [12, 8, 0]);
  await clickModel(page, [52, 32, 0]);
  await sketchIdle(page);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  // The circle: its centre clicked, its diameter typed in the value box beside it.
  await page.keyboard.press('c');
  await clickModel(page, [32, 20, 0]);
  await page.keyboard.type('12');
  await expect(frame.locator('[data-sketch-box="diameter"]')).toBeFocused();
  await page.keyboard.press('Enter');
  await sketchIdle(page);
  await page.keyboard.press('Escape');

  // While it is drawn: two regions, shaded (the plate's patch is bluer than outside the rectangle).
  await expect
    .poll(() => workspaceFrame(page).evaluate(() => {
      const s = (window as unknown as W).__CAD__.services.doc.state.get();
      const id = s.session?.feature;
      const o = id ? s.rebuild.outputs[id] : null;
      return o && o.type === 'sketch' ? o.regions.length : -1;
    }), { timeout: 20_000 })
    .toBe(2);
  const outside = await patch(page, await at(page, [70, 45, 0]));
  const inside = await patch(page, await at(page, [16, 12, 0]));
  expect(outside[0] - inside[0], `plate shaded: inside ${inside}, outside ${outside}`).toBeGreaterThan(12);
  await shot(page, 'p3p-sketchmode-drawn');

  // Finish sketch: model mode, the sketch row, its regions still shown.
  await frame.locator('[data-command="sketch.finish"]').click();
  await expect(frame.locator('[data-cad-toolbar="sketch"]')).toHaveCount(0);
  const row = frame.locator('[data-cad-tree] [data-feature-type="sketch"]');
  await expect(row.locator('> .tree-row .tl')).toHaveText(/Sketch 1$/);
  await expect(row).toHaveAttribute('data-sketch-shown', '1');

  // Click the plate region, E: Extrude with it; the volume is its area x 10 mm.
  await clickModel(page, [16, 12, 0]);
  await expect.poll(() => workspaceFrame(page).evaluate(() => (window as unknown as W).__CAD__.services.selection.get().items.map((i: { kind: string }) => i.kind))).toEqual(['region']);
  await page.keyboard.press('e');
  const panel = frame.locator('[data-cad-panel="feature"]');
  await expect(panel.locator('[data-profile-list] [data-profile]')).toHaveCount(1);
  const area = Number(await panel.locator('[data-profile-area]').getAttribute('data-profile-area'));
  expect(area).toBeGreaterThan(500);
  await expect.poll(async () => Number(await frame.locator('[data-chip="volume"] [data-volume-mm3]').getAttribute('data-volume-mm3')), { timeout: 30_000 }).toBeCloseTo(area * 10, 3);
  await panel.locator('[data-panel-done]').click();
  await expect(frame.locator('[data-cad-tree] [data-feature-type="extrude"]')).toHaveAttribute('data-state', 'ok');
  await expect(row).toHaveAttribute('data-sketch-shown', '0');
  await shot(page, 'p3p-sketchmode-extruded');
  expect(seen.csp).toEqual([]);
  expect(seen.errors).toEqual([]);
});
