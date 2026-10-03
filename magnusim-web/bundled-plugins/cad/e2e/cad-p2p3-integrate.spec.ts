// Findings of the P2+P3 integration (INTEGRATE), one assertion of what the user
// sees per finding, each failing without its fix:
//  - A circle drawn by two clicks with a small radius: the rim click landed on
//    the circle's own Diameter value box (it sat on the rim), so no circle was
//    made (seen after a rectangle, as P3-PROFILES reported). Value boxes now keep
//    out from under the pointer.
// The surface-body volume ("Surface body: no volume", it read "8000 mm³") is
// asserted in the P2 gate's knit test; the Size chip in its press-pull test.
// window.__CAD__ is used only to project model points and to read the drawn sketch.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type Page } from '@playwright/test';
import { newPartFromTree, newProject, openProject, partOpened, watchPage, workspaceFrame } from './helpers';

type V3 = [number, number, number];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type W = { __CAD__: { services: any } };

async function at(page: Page, p: V3): Promise<[number, number]> {
  const xy = await workspaceFrame(page).evaluate((pt) => (window as unknown as W).__CAD__.services.viewport.get().handle.project(pt) as [number, number] | null, p);
  expect(xy, `model point ${p} is not on screen`).not.toBeNull();
  const box = (await page.locator('#workspace-frame').boundingBox())!;
  return [box.x + xy![0], box.y + xy![1]];
}

async function clickAt(page: Page, p: V3) {
  const [x, y] = await at(page, p);
  await page.mouse.click(x, y);
}

const idle = (page: Page) => workspaceFrame(page).evaluate(async () => (window as unknown as W).__CAD__.services.apis.get().sketch?.idle?.());
const kinds = (page: Page) => workspaceFrame(page).evaluate(() => ((window as unknown as W).__CAD__.services.apis.get().sketch.draft().entities as { kind: string }[]).map((e) => e.kind));

test('cad:p2p3-integrate-small-circle a circle of a small radius drawn by two clicks after a rectangle is made (its Diameter box no longer swallows the rim click)', async ({ page, request }) => {
  const seen = await watchPage(page);
  const projectId = await newProject(request);
  await openProject(page, projectId);
  await newPartFromTree(page, 'Part 1');
  const frame = await partOpened(page);
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  await frame.locator('[data-tree-node="origin:top"] > .tree-row').click();
  await frame.locator('[data-command="sketch.new"]').click();
  await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
  await expect.poll(() => workspaceFrame(page).evaluate(() => (window as unknown as W).__CAD__.services.viewport.get().handle.state.get().animating)).toBe(false);
  // A rectangle by two corners, then Escape twice (the tool, then the selection).
  await frame.locator('[data-command="sketch.rectangle"]').click();
  await clickAt(page, [12, 8, 0]);
  await clickAt(page, [52, 32, 0]);
  await idle(page);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  // Circle: the centre, then a point 6 mm away (about 24 px here): the circle is made.
  await page.keyboard.press('c');
  await clickAt(page, [70, 20, 0]);
  await expect(frame.locator('[data-sketch-box="diameter"]')).toBeVisible();
  // The box is not under the pointer where the rim click goes.
  const [rx, ry] = await at(page, [76, 20, 0]);
  await page.mouse.move(rx, ry);
  const r = (await frame.locator('[data-sketch-box="diameter"]').boundingBox())!;
  expect(rx < r.x || rx > r.x + r.width || ry < r.y || ry > r.y + r.height, `the Diameter box (${JSON.stringify(r)}) is under the pointer (${rx}, ${ry})`).toBe(true);
  await page.mouse.click(rx, ry);
  await idle(page);
  expect(await kinds(page)).toEqual(['line', 'line', 'line', 'line', 'circle']);
  const c = await workspaceFrame(page).evaluate(() => ((window as unknown as W).__CAD__.services.apis.get().sketch.draft().entities as { kind: string; r?: number }[]).find((e) => e.kind === 'circle')!.r);
  expect(c).toBeGreaterThan(5);
  expect(c).toBeLessThan(7);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Enter');
  await expect(frame.locator('[data-cad-toolbar="model"]')).toBeVisible();
  expect(seen.csp).toEqual([]);
  expect(seen.errors).toEqual([]);
});
