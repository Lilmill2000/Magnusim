// Carry-overs bundled with LINK L2 (Daniel's small UX decisions of 2026-10-02):
//   - two tabs: when another tab saved while this tab has a change that is not
//     saved, the chip offers "Reload (discard my change)" and "Keep mine (replace
//     the other tab's save)"; Keep mine warns in the app's own dialog first, then
//     this tab's version is stored, and the other tab is told when it saves next;
//     Cancel changes nothing; Reload adopts the other tab's version;
//   - Finish sketch keeps the camera where it is (looking normal to the sketch
//     plane, SolidWorks-like): it does not go back to the view before the sketch.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { addSolid, modelOnPage, newPartFromTree, newProject, openProject, partOpened, watchPage, workspaceFrame } from './helpers';

const SHOTS = process.env.CAD_E2E_SHOTS || '';

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

type CadWin = {
  __CAD__: {
    services: {
      doc: {
        beginEdit(id: string): { update(p: unknown): void; commit(): void };
        state: { get(): { doc: { features: { id: string; type: string; extent?: { distance?: string } }[] }; save: { state: string } } };
      };
      viewport: { get(): { handle: { camera(): { position: number[]; target: number[]; up: number[]; projection: string; orthoHeight: number }; state: { get(): { animating: boolean } } } | null } };
    };
  };
};

const chip = (frame: FrameLocator) => frame.locator('[data-chip="save"]');

async function setHeight(page: Page, extrude: string, mm: number) {
  await workspaceFrame(page).evaluate(
    ({ id, d }) => {
      const s = (window as unknown as CadWin).__CAD__.services.doc.beginEdit(id);
      s.update({ extent: { kind: 'blind', distance: `${d} mm` } });
      s.commit();
    },
    { id: extrude, d: mm },
  );
}

const distance = (page: Page) => workspaceFrame(page).evaluate(() => (window as unknown as CadWin).__CAD__.services.doc.state.get().doc.features.find((f) => f.type === 'extrude')?.extent?.distance ?? null);

test('cad:link-carry-two-tabs another tab saved first: Reload (discard my change) or Keep mine (replace the other tab\'s save), with a clear warning; nothing goes silently', async ({ page, context, request }) => {
  test.setTimeout(300_000);
  const seen = await watchPage(page);
  const pid = await newProject(request);
  await openProject(page, pid);
  await newPartFromTree(page, 'Part 1');
  const a = await partOpened(page);
  await expect(a.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  const made = await addSolid(page, { size: [40, 30, 20] });
  await expect(chip(a)).toHaveText('Saved', { timeout: 30_000 });
  // Tab B: the same Part.
  const pageB = await context.newPage();
  await pageB.goto(page.url());
  const b = await partOpened(pageB);
  await expect(b.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  // A saves a change; B, which has not seen it, changes the same Part: refused.
  await setHeight(page, made.extrude, 30);
  await expect(chip(a)).toHaveText('Saved', { timeout: 30_000 });
  await setHeight(pageB, made.extrude, 15);
  await expect(chip(b)).toContainText('Changed in another tab', { timeout: 30_000 });
  await expect(chip(b).locator('[data-chip-action]')).toHaveText(['Reload (discard my change)', "Keep mine (replace the other tab's save)"]);
  await shot(pageB, 'link-carry-two-tabs-chip');

  // Keep mine asks first, in the app's dialog; Cancel changes nothing.
  await chip(b).locator('[data-chip-action="Keep mine"]').click();
  await expect(pageB.locator('#modal-confirm')).toBeVisible();
  await expect(pageB.locator('#cf-heading')).toHaveText("Replace the other tab's save?");
  await expect(pageB.locator('#cf-copy')).toHaveText(
    "Another tab saved Part 1 after this tab's last save. Keep mine stores this tab's version over it: what the other tab changed since then is lost. The other tab is told to reload the next time it saves.",
  );
  await expect(pageB.locator('#cf-confirm')).toHaveText('Keep mine');
  await shot(pageB, 'link-carry-keep-mine-warning');
  await pageB.locator('#cf-cancel').click();
  await expect(pageB.locator('#modal-confirm')).toBeHidden();
  await expect(chip(b)).toContainText('Changed in another tab');
  // Keep mine, confirmed: B's version is stored.
  await chip(b).locator('[data-chip-action="Keep mine"]').click();
  await pageB.locator('#cf-confirm').click();
  await expect(chip(b)).toHaveText('Saved', { timeout: 30_000 });
  await expect(pageB.locator('#workspace-overlay [data-ws-toast]')).toContainText("Kept this tab's version of Part 1.");
  expect(await distance(pageB)).toBe('15 mm');

  // A is told when it saves next, and Reload (discard my change) adopts B's version.
  await setHeight(page, made.extrude, 31);
  await expect(chip(a)).toContainText('Changed in another tab', { timeout: 30_000 });
  await chip(a).locator('[data-chip-action="Reload"]').click();
  await expect(chip(a)).toHaveText('Saved', { timeout: 30_000 });
  await expect.poll(() => distance(page)).toBe('15 mm');
  await expect(page.locator('#workspace-overlay [data-ws-toast]')).toContainText("Reloaded the other tab's version: this tab's changes that were not saved are gone.");
  await pageB.close();
  expect(seen.csp, 'CSP violations').toEqual([]);
  // The refused saves are logged by the browser as failed loads (409): only those.
  expect(seen.errors.filter((e) => !/409|Conflict/i.test(e)), 'console errors').toEqual([]);
});

test('cad:link-carry-finish-sketch Finish sketch keeps the camera where it is (normal to the sketch plane), and nothing moves it after', async ({ page, request }) => {
  test.setTimeout(240_000);
  const pid = await newProject(request);
  await openProject(page, pid);
  await newPartFromTree(page, 'Part 1');
  const frame = await partOpened(page);
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  await addSolid(page, { size: [40, 30, 20] });
  const camera = () => workspaceFrame(page).evaluate(() => (window as unknown as CadWin).__CAD__.services.viewport.get().handle!.camera());
  const idle = () =>
    expect.poll(() => workspaceFrame(page).evaluate(() => (window as unknown as CadWin).__CAD__.services.viewport.get().handle!.state.get().animating)).toBe(false);
  // A sketch on the Top plane, a rectangle drawn in it.
  await frame.locator('[data-tree-node="origin:top"] > .tree-row').click();
  await frame.locator('[data-cad-toolbar] [data-command="sketch.new"]').click();
  await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
  await idle();
  await page.keyboard.press('r');
  const o = await modelOnPage(page, [-30, -30, 0]);
  await page.mouse.click(o[0], o[1]);
  const c = await modelOnPage(page, [-10, -15, 0]);
  await page.mouse.click(c[0], c[1]);
  await page.keyboard.press('Escape');
  await idle();
  const before = await camera();
  // Looking straight down at the Top plane.
  expect(Math.abs(before.position[0] - before.target[0])).toBeLessThan(1e-6);
  expect(before.position[2]).toBeGreaterThan(before.target[2]);
  await frame.locator('[data-cad-toolbar] [data-command="sketch.finish"]').click();
  await expect(frame.locator('[data-cad-toolbar="model"]')).toBeVisible();
  await idle();
  await page.waitForTimeout(1000);
  await idle();
  const after = await camera();
  const close = (x: number[], y: number[]) => x.every((v, i) => Math.abs(v - y[i]) < 1e-6);
  expect(close(after.position, before.position) && close(after.target, before.target) && close(after.up, before.up), `camera moved: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`).toBe(true);
  expect([after.projection, after.orthoHeight]).toEqual([before.projection, before.orthoHeight]);
  await shot(page, 'link-carry-finish-sketch-camera');
});
