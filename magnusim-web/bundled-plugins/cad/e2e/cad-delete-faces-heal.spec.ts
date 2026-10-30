// Delete faces never shows a heal past the gap as a success (2026-10-30): an L-block (Extrude
// 60 x 40 x 20, Extrude Cut 30 x 40 x 10 off one end), every face's edges rounded R2 by Fillet 1,
// then the 30 blends selected, Delete faces, "Delete faces and heal". OCCT's heal filled the step
// and the app showed Delete faces 1 ok with the volume chip at 48,000 mm³ (the full box). Now
// Delete faces 1 is red and says what the heal would have done, that the body is unchanged and
// that deleting Fillet 1 takes the fillet off; the chip keeps 35,601.6 mm³ and the size chip the
// L-block's 60 x 40 x 20. Done keeps the red row; the body stays as Fillet 1 left it.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type APIRequestContext, type FrameLocator, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { addSolid, featureRowNamed, newPartFromTree, newProject, openProject, partOpened, runCommand, watchPage, workspaceFrame } from './helpers';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type W = { __CAD__: { services: any } };

async function shot(page: Page, name: string) {
  const dir = process.env.CAD_E2E_SHOTS;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: join(dir, `${name}.png`) });
}

async function freshPart(page: Page, request: APIRequestContext) {
  const seen = await watchPage(page);
  const projectId = await newProject(request);
  await openProject(page, projectId);
  await newPartFromTree(page, 'Part 1');
  const frame = await partOpened(page);
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  return { seen, frame };
}

const cad = <T>(page: Page, fn: (arg: never) => T | Promise<T>, arg?: unknown) => workspaceFrame(page).evaluate(fn as never, arg as never) as Promise<T>;

/** The rebuild is done and every feature has a state. */
async function settled(page: Page) {
  await expect
    .poll(() =>
      cad<boolean>(page, (() => {
        const st = (window as unknown as W).__CAD__.services.doc.state.get();
        return st.rebuild.status === 'done' && st.doc.features.every((f: { id: string }) => st.rebuild.features[f.id] && st.rebuild.features[f.id].state !== 'pending');
      }) as never),
      { timeout: 60_000 },
    )
    .toBe(true);
}

const panel = (frame: FrameLocator) => frame.locator('[data-cad-panel="feature"]');
const volumeChip = (frame: FrameLocator) => frame.locator('[data-chip="volume"]');
const sizeChip = (frame: FrameLocator) => frame.locator('[data-chip="size"]');
const chipVolumes = (frame: FrameLocator) => volumeChip(frame).locator('[data-volume-mm3]').evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-volume-mm3'))));

/** The chip's one volume, read until it is `v` within `rel` (one body listed). */
async function expectOneVolume(frame: FrameLocator, v: number, rel = 1e-6) {
  await expect
    .poll(
      async () => {
        const vs = await chipVolumes(frame);
        return vs.length === 1 ? Math.abs(vs[0] / v - 1) : 1;
      },
      { timeout: 30_000 },
    )
    .toBeLessThan(rel);
}

/** Select faces of the one body: all of them, or the ones not flat. */
async function selectFaces(page: Page, which: 'all' | 'round'): Promise<number> {
  return cad<number>(page, (async (w: string) => {
    const s = (window as unknown as W).__CAD__.services;
    const b = s.doc.state.get().rebuild.bodies[0];
    const t = (await s.kernel.call('topo', { id: b.shape, faces: 'all', edges: 'none', vertices: 'none', face_bbox: 'none' })).result;
    const idx = t.faces.filter((f: { type: string }) => w === 'all' || f.type !== 'plane').map((f: { i: number }) => f.i);
    s.selection.set((st: object) => ({ ...st, items: idx.map((index: number) => ({ kind: 'face', body: b.id, index })) }));
    return idx.length;
  }) as never, which);
}

test('cad:delete-faces-heal-fill Delete faces of every blend of a rounded L-block: red with what the heal would do, the body and its chips unchanged', async ({ page, request }) => {
  test.setTimeout(180_000);
  const { seen, frame } = await freshPart(page, request);
  const block = await addSolid(page, { size: [60, 40, 20] });
  await addSolid(page, { at: [30, 0, 10], size: [30, 40, 10], op: 'cut', scope: [block.body!] });
  await settled(page);
  await expectOneVolume(frame, 36000);
  // Fillet 1: every face selected (all their edges), radius 2.
  expect(await selectFaces(page, 'all')).toBe(8);
  await runCommand(frame, 'modify.fillet');
  await expect(panel(frame).locator('[data-panel-title]')).toHaveText('Fillet 1');
  const radius = panel(frame).locator('.nui[data-field="radius"] input');
  await radius.fill('2');
  await radius.press('Enter');
  await settled(page);
  await expect(featureRowNamed(frame as never, 'Fillet 1')).toHaveAttribute('data-state', 'ok');
  const filleted = 35601.6258;
  await expectOneVolume(frame, filleted);
  await panel(frame).locator('[data-panel-done]').click();
  await expect(panel(frame)).toHaveCount(0);
  // The 30 blends, Delete faces, "Delete faces and heal".
  expect(await selectFaces(page, 'round')).toBe(30);
  await runCommand(frame, 'modify.delete-faces');
  const dlg = frame.locator('[data-cad-dialog]');
  await expect(dlg.locator('h2')).toHaveText('Delete faces of Fillet 1?');
  await dlg.locator('[data-dialog-choice="faces"]').click();
  await expect(panel(frame).locator('[data-feature-panel="delete_faces"]')).toBeVisible();
  await settled(page);
  const row = featureRowNamed(frame as never, 'Delete faces 1');
  await expect(row).toHaveAttribute('data-state', 'error');
  const reason = panel(frame).locator('[data-run-reason]').first();
  await expect(reason).toHaveText(
    /^Delete faces 1 failed: healing filled more than the gap the deleted faces leave: it would add 12,398\.\d+ mm³ over faces you kept \([^)]*Extrude 2[^)]*\); the body is unchanged\. To take the whole fillet off, delete Fillet 1 instead/,
    { timeout: 30_000 },
  );
  // The body is as Fillet 1 left it: not the 60 x 40 x 20 box of 48,000 mm³ the heal made.
  await expectOneVolume(frame, filleted);
  await expect(volumeChip(frame)).not.toContainText('48,000');
  await expect
    .poll(async () => ((await sizeChip(frame).locator('[data-size-mm]').getAttribute('data-size-mm')) ?? '').split(',').map((v) => Math.round(Number(v) * 1e6) / 1e6))
    .toEqual([60, 40, 20]);
  const faces = await cad<number>(page, (() => (window as unknown as W).__CAD__.services.doc.state.get().rebuild.bodies[0].faces) as never);
  expect(faces).toBe(38);
  await shot(page, 'delete-faces-heal-fill');
  // Done: the row stays red, the body unchanged.
  await panel(frame).locator('[data-panel-done]').click();
  await expect(panel(frame)).toHaveCount(0);
  await expect(row).toHaveAttribute('data-state', 'error');
  await expectOneVolume(frame, filleted);
  expect(seen.errors).toEqual([]);
});
