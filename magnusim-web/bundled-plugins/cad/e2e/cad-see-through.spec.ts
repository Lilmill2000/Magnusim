// See-through bodies (Daniel 2026-10-29: per-body see-through as a view state, like a hidden body;
// INSPECT > See-through for the selected bodies, the body's menu in the tree toggles it back), as
// the person meets them:
//   cad:see-through-inspect  a block with a smaller one inside it. Body 1 selected in the tree,
//                          INSPECT > See-through: the view draws it translucent (the opacity of its
//                          surface, read through window.__CAD__), the button shows pressed, the tree
//                          row has the see-through mark (Body 2's has none); a click where Body 2
//                          shows through Body 1's top lands on Body 2 inside it; a section through
//                          both: Body 1's cut is a see-through cap (what is behind shows), Body 2's
//                          cap is as before, and
//                          Body 1 made opaque from its menu (Make Body 1 opaque) caps it opaque again;
//                          Make Body 1 see-through from the menu; reloaded, the Part keeps it so.
// What is asserted is what the person sees: the drawn surface's opacity, the tree's mark and menu,
// the toolbar button, what a click selects and the pixels of the cut.
// Owner: VIEWPORT (see-through bodies).
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type APIRequestContext, type FrameLocator, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { addSolid, modelOnPage, newPartFromTree, newProject, openProject, partOpened, runCommand, watchPage, workspaceFrame } from './helpers';
import { PNG } from './png';

type V3 = [number, number, number];
type RGB = [number, number, number];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type W = { __CAD__: { services: any } };

async function freshPart(page: Page, request: APIRequestContext) {
  const seen = await watchPage(page);
  const projectId = await newProject(request);
  await openProject(page, projectId);
  await newPartFromTree(page, 'Part 1');
  const frame = await partOpened(page);
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  return { frame, seen };
}

/** Each body's surface opacity as the view draws it now (1 opaque). */
const opacity = (page: Page) => workspaceFrame(page).evaluate(() => (window as unknown as W).__CAD__.services.viewport.get().handle.stats().opacity as Record<string, number>);
const saved = (page: Page) => workspaceFrame(page).evaluate(() => ((window as unknown as W).__CAD__.services.doc.state.get().view.seeThroughBodies ?? null) as string[] | null);
const selected = (page: Page) => workspaceFrame(page).evaluate(() => (window as unknown as W).__CAD__.services.selection.get().items as { kind: string; body?: string }[]);
const bodyRow = (frame: FrameLocator, id: string) => frame.locator(`[data-cad-tree] [data-body-row="${id}"]`);
const button = (frame: FrameLocator) => frame.locator('[data-cad-toolbar] .tb-btn[data-command="inspect.see-through"]');

/** The mean colour of a 7 x 7 px square around each page point (the cap's hatching averaged out). */
async function colours(page: Page, pts: [number, number][]): Promise<RGB[]> {
  const img = PNG.decode(await page.screenshot());
  const dpr = img.width / (page.viewportSize()!.width || img.width);
  return pts.map(([x, y]) => {
    const sum = [0, 0, 0];
    for (let dx = -3; dx <= 3; dx++)
      for (let dy = -3; dy <= 3; dy++) {
        const p = PNG.at(img, Math.round(x * dpr) + dx, Math.round(y * dpr) + dy);
        for (let i = 0; i < 3; i++) sum[i] += p[i];
      }
    return sum.map((v) => Math.round(v / 49)) as RGB;
  });
}
/** How far apart two colours are: the channels' differences summed. */
const dist = (a: RGB, b: RGB) => a.reduce((n, v, i) => n + Math.abs(v - b[i]), 0);

const SHOTS = process.env.CAD_E2E_SHOTS || '';
async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

/** A body's row menu (right-click on its row in the tree): its labels. */
async function rowMenu(frame: FrameLocator, id: string): Promise<string[]> {
  await bodyRow(frame, id).locator('> .tree-row').click({ button: 'right' });
  const menu = frame.locator('[data-cad-menu]');
  await expect(menu).toBeVisible();
  return menu.locator('[data-menu-item]').allTextContents();
}

test('cad:see-through-inspect INSPECT > See-through draws the selected body see-through: marked in the tree, a click goes through it, a cut caps it see-through; the menu makes it opaque and back; kept on reload', async ({ page, request }) => {
  test.setTimeout(300_000);
  const { frame, seen } = await freshPart(page, request);
  // Body 1: a 40 x 40 x 20 block; Body 2: a 10 mm cube inside it.
  const outer = await addSolid(page, { size: [40, 40, 20] });
  const inner = await addSolid(page, { size: [10, 10, 10], at: [15, 15, 5] });
  const b1 = outer.body!;
  const b2 = inner.body!;
  await expect.poll(async () => opacity(page), { timeout: 30_000 }).toEqual({ [b1]: 1, [b2]: 1 });

  // Nothing selected: INSPECT > See-through says why.
  await expect(button(frame)).toHaveAttribute('data-disabled-reason', 'Select a body first, in the view or the tree');
  // Body 1 selected in the tree, then INSPECT > See-through.
  const folder = frame.locator('[data-cad-tree] [data-bodies-folder]');
  if ((await folder.getAttribute('aria-expanded')) !== 'true') await folder.locator('> .tree-row .tw').click();
  await bodyRow(frame, b1).locator('> .tree-row').click();
  await expect(button(frame)).not.toHaveAttribute('data-disabled-reason', /./);
  await expect(button(frame)).not.toHaveAttribute('aria-pressed', 'true');
  await runCommand(frame, 'inspect.see-through');
  // Drawn see-through (translucent), Body 2 as it was.
  await expect.poll(async () => opacity(page)).toEqual({ [b1]: 0.28, [b2]: 1 });
  await expect(button(frame)).toHaveAttribute('aria-pressed', 'true');
  // The tree: Body 1's own mark (not a hidden body's), none on Body 2.
  await expect(bodyRow(frame, b1)).toHaveAttribute('data-see-through', 'view');
  await expect(bodyRow(frame, b1)).toHaveAttribute('data-visible', '1');
  await expect(bodyRow(frame, b1).locator('[data-see-through-badge]')).toBeVisible();
  await expect(bodyRow(frame, b2)).not.toHaveAttribute('data-see-through', /./);
  expect(await saved(page)).toEqual([b1]);

  // A click where Body 2's top shows through Body 1 (Body 1's top face is in front of it there):
  // Body 2's face is picked, seen through Body 1.
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await selected(page)).length).toBe(0);
  const top = await modelOnPage(page, [20, 20, 15]);
  await page.mouse.click(top[0], top[1]);
  await expect.poll(async () => (await selected(page)).map((it) => `${it.kind} ${it.body}`)).toEqual([`face ${b2}`]);
  await shot(page, 'see-through-picked-inside');
  await page.keyboard.press('Escape');

  // A section through both (the Front plane at y = 20, seen from the front): Body 1's cut is see-through,
  // Body 2's cap as an opaque body's.
  await workspaceFrame(page).evaluate(() => {
    const h = (window as unknown as W).__CAD__.services.viewport.get().handle;
    h.setSection({ on: true, plane: { kind: 'origin', plane: 'origin:front' }, offset: -20, flip: false });
    h.setView('front', { animate: false });
  });
  await page.mouse.move(2, 2);
  await page.waitForTimeout(300);
  const A: V3 = [5, 20, 10]; // Body 1's cut only
  const B: V3 = [20, 20, 10]; // Body 2's cut
  const at = async () => colours(page, [await modelOnPage(page, A), await modelOnPage(page, B)]);
  const [aSee, bSee] = await at();
  await shot(page, 'see-through-cut');
  // Body 1 opaque again from its menu: its cut is the opaque hatched cap.
  expect((await rowMenu(frame, b1)).slice(0, 2)).toEqual(['Hide Body 1', 'Make Body 1 opaque']);
  await frame.locator('[data-cad-menu] [data-menu-item="body-see-through"]').click();
  await expect.poll(async () => opacity(page)).toEqual({ [b1]: 1, [b2]: 1 });
  await expect(bodyRow(frame, b1)).not.toHaveAttribute('data-see-through', /./);
  await expect(button(frame)).not.toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await selected(page)).length).toBe(0);
  await page.mouse.move(2, 2);
  await page.waitForTimeout(300);
  const [aOpaque, bOpaque] = await at();
  // (Measured: about 70 apart, the see-through cut lighter; the same cap within a few.)
  expect(dist(aSee, aOpaque), `Body 1's cut see-through ${aSee} vs capped ${aOpaque}`).toBeGreaterThan(40);
  expect(dist(bSee, bOpaque), `Body 2's cap ${bSee} vs ${bOpaque}`).toBeLessThan(20);
  expect(dist(aOpaque, bOpaque), `one opaque cap over both ${aOpaque} vs ${bOpaque}`).toBeLessThan(20);
  await workspaceFrame(page).evaluate(() => (window as unknown as W).__CAD__.services.viewport.get().handle.setSection({ on: false }));

  // See-through again from the menu; kept with the Part: reloaded, it is drawn so and marked.
  expect((await rowMenu(frame, b1)).slice(0, 2)).toEqual(['Hide Body 1', 'Make Body 1 see-through']);
  await frame.locator('[data-cad-menu] [data-menu-item="body-see-through"]').click();
  await expect.poll(async () => opacity(page)).toEqual({ [b1]: 0.28, [b2]: 1 });
  await expect.poll(() => saved(page)).toEqual([b1]);
  await page.waitForTimeout(2200); // the view's own save cadence (one write per 2 s at most)
  await page.reload();
  const again = page.frameLocator('#workspace-frame');
  await expect(again.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready', { timeout: 60_000 });
  await expect.poll(async () => opacity(page), { timeout: 60_000 }).toEqual({ [b1]: 0.28, [b2]: 1 });
  await expect(bodyRow(again, b1)).toHaveAttribute('data-see-through', 'view');
  expect(seen.errors, 'console errors').toEqual([]);
});
