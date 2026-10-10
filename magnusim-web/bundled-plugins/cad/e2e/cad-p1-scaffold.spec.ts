// The Part workspace as a user first meets it: STUDIES "+ New Part" creates a
// Part and the host opens it in its workspace frame by itself, the page connects,
// the kernel worker starts (ready handshake, OCCT 7.9.3), and the viewport and
// the design tree show an empty part. No CSP violations, no console errors.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { newPartFromTree, newProject, openProject, partOpened, watchPage, workspaceFrame, groupCommandLabels } from './helpers';
import { PNG } from './png';

test('cad:p1-scaffold + New Part opens an empty Part with the kernel ready', { tag: '@smoke' }, async ({ page, request }) => {
  const seen = await watchPage(page);
  const projectId = await newProject(request);
  await openProject(page, projectId);

  // The plugin is bundled and loaded: its study kind offers "+ New Part".
  await newPartFromTree(page, 'Part 1');
  const frame = await partOpened(page);

  // Host header: Back, crumb "Magnusim CAD › Part 1".
  await expect(page.locator('#workspace-overlay [data-ws-crumb]')).toHaveText(/Magnusim CAD\s*›\s*Part 1/);
  await expect(page.locator('#workspace-overlay [data-ws-loading]')).toHaveCount(0);

  // Empty part: the origin planes and no features; the toolbar holds only the
  // commands that work (Sketch, Extrude, Parameters, the views, Undo/Redo); no kernel chip once ready.
  const tree = frame.locator('[data-cad-tree]');
  await expect(tree.locator('.geo-head')).toHaveText(['PART', 'HISTORY']);
  await expect(tree.locator('[data-tree-node="origin"] > .tree-row .tl')).toHaveText('Origin');
  await expect(tree.locator('[data-tree-node^="origin:"] .tl')).toHaveText(['Top plane', 'Front plane', 'Right plane', 'X axis', 'Y axis', 'Z axis']);
  await expect(tree.locator('[data-tree-empty="history"]')).toHaveText('No features yet');
  const tb = frame.locator('[data-cad-toolbar]');
  // P2/P3: SKETCH first; INSPECT and FILE after MODIFY. SD: no one-click solids (SOLID is Extrude
  // only), and CFD PREP (Enclosure) after the modelling groups.
  await expect(tb.locator('.tb-group-label')).toHaveText(['SKETCH', 'SOLID', 'PATTERN', 'MODIFY', 'CONSTRUCT', 'CFD PREP', 'INSPECT', 'FILE', 'VIEW', 'SCALE MODELS', 'EDIT']);
  expect(await groupCommandLabels(frame, 'solid')).toEqual(['Extrude', 'Revolve', 'Sweep', 'Loft']);
  await expect(tb.locator('[data-group="cfd"] .tb-txt')).toHaveText(['Enclosure']);
  await expect(tb.locator('[data-group="edit"] [data-command="edit.undo"]')).toHaveAttribute('aria-disabled', 'true');
  await expect(frame.locator('[data-chip="kernel"]')).toHaveCount(0);

  // The viewport is drawn in the core's background colour.
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-viewport', 'ready');
  const inside = workspaceFrame(page);
  const snap = await inside.evaluate(() => {
    const cad = (window as unknown as { __CAD__: { snapshot(): Record<string, unknown> } }).__CAD__;
    const canvas = document.querySelector('.cad-viewport-canvas') as HTMLCanvasElement | null;
    return { snapshot: cad.snapshot(), canvas: canvas ? [canvas.clientWidth, canvas.clientHeight] : null };
  });
  expect(snap.snapshot).toMatchObject({ kernel: { state: 'ready', info: { occt: '7.9.3', variant: 'wasm32' } }, doc: { status: 'ready', features: 0 }, viewport: true });
  expect(snap.canvas && snap.canvas[0] > 400 && snap.canvas[1] > 300).toBe(true);
  const box = await frame.locator('.cad-viewport-canvas').boundingBox();
  expect(box).not.toBeNull();
  // Top-right corner: clear of the origin planes an empty part shows (centre) and of the
  // viewport chrome and triad (bottom-right).
  const shot = await page.screenshot({ clip: { x: box!.x + box!.width - 60, y: box!.y + 40, width: 20, height: 20 } });
  const px = PNG.center(shot);
  expect(px, `viewport pixel ${px}`).toEqual([0xf0, 0xf2, 0xf7]);

  // Clicking a plane row selects it (#d7e8ff), like the core tree.
  await tree.locator('[data-tree-node="origin:top"] > .tree-row').click();
  await expect(tree.locator('[data-tree-node="origin:top"]')).toHaveClass(/selected/);
  const bg = await tree.locator('[data-tree-node="origin:top"] > .tree-row').evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg).toBe('rgb(215, 232, 255)');
  // The twisty collapses and expands the origin.
  await tree.locator('[data-tree-node="origin"] > .tree-row').click();
  await expect(tree.locator('[data-tree-node="origin:top"]')).toBeHidden();
  await tree.locator('[data-tree-node="origin"] > .tree-row').click();
  await expect(tree.locator('[data-tree-node="origin:top"]')).toBeVisible();

  const shots = process.env.CAD_E2E_SHOTS;
  if (shots) {
    mkdirSync(shots, { recursive: true });
    await page.screenshot({ path: join(shots, 'scaffold.png') });
  }

  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);

  // Back returns to the project, and the Part row stays.
  await page.locator('#workspace-overlay [data-ws-back]').click();
  await expect(page.locator('#workspace-overlay')).toBeHidden();
  await expect(page.locator('#plugin-studies-section li[data-plugin="cad"]')).toHaveCount(1);
});
