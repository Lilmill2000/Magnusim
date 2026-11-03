// The fillet and hole e2e part (S4), shared by Magnusim's and Magnusim CAD's Find specs: Body 1,
// made in the page with the Part's own kernel and written to STEP there (never a file of
// Daniel's): an 80 x 50 x 20 block with R5 on its 4 vertical edges and R2 round its top (4
// straight rounds, 4 corner pieces), four 6 mm through holes and a counterbore (6 mm through,
// 10 mm 5 deep) in its middle: 25 faces, 12 fillet faces, 5 drilled holes. Imported through
// FILE > Import STEP as a person does. The same part as tests/assistant/rounded-block.ts.
// Also (S5, Delete faces' box select): where on the page an R5 vertical faces the camera, and a
// Ctrl+drag box there.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, type FrameLocator, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { modelOnPage, workspaceFrame } from './helpers';

export interface RoundedBlockMade {
  /** The STEP file, base64. */
  b64: string;
  /** Body 1's volume, and the sharp reference's (the same part with no R2 round its top). */
  volume: number;
  sharp: number;
}

/** Runs in the Part's frame (frame.evaluate): the part made with kernel ops, as STEP. Self-contained (it is sent as text). */
export async function roundedBlockInPage(): Promise<RoundedBlockMade> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type R = Record<string, any>;
  const k = (window as unknown as { __CAD__: { services: { kernel: { call(op: string, p: R): Promise<{ result: R; buffers: Record<string, ArrayBuffer> }> } } } }).__CAD__.services.kernel;
  const r = async (op: string, p: R) => (await k.call(op, p)).result;
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
  const edges = async (id: number): Promise<R[]> => (await r('topo', { id, faces: 'none', vertices: 'none', edge_ends: true })).edges;
  const make = async (top: boolean): Promise<number> => {
    const box = (await r('box', { dx: 80, dy: 50, dz: 20, origin: [0, 0, 0] })).id;
    const vertical = (await edges(box)).filter((e) => near(e.first[0], e.last[0]) && near(e.first[1], e.last[1])).map((e) => e.i);
    let id = (await r('fillet', { id: box, edges: vertical, r: 5 })).id;
    if (top) {
      const rim = (await edges(id)).filter((e) => near(e.first[2], 20) && near(e.last[2], 20)).map((e) => e.i);
      id = (await r('fillet', { id, edges: rim, r: 2 })).id;
    }
    const cyl = async (rad: number, h: number, origin: number[]) => (await r('cylinder', { r: rad, h, origin, axis: [0, 0, 1] })).id;
    const tools: number[] = [];
    for (const [x, y] of [
      [15, 12],
      [65, 12],
      [15, 38],
      [65, 38],
    ])
      tools.push(await cyl(3, 22, [x, y, -1]));
    tools.push(await cyl(3, 22, [40, 25, -1]), await cyl(5, 6, [40, 25, 15]));
    return (await r('boolean', { op: 'cut', targets: [id], tools })).id;
  };
  const id = await make(true);
  const sharpId = await make(false);
  const volume = (await r('props', { id, volume: true, bbox: 'none' })).volume;
  const sharp = (await r('props', { id: sharpId, volume: true, bbox: 'none' })).volume;
  const step = (await k.call('export_step', { shapes: [{ id, name: 'Body 1' }], schema: 'AP214' })).buffers.step;
  await r('release', { ids: [id, sharpId] });
  let bin = '';
  const u8 = new Uint8Array(step);
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return { b64: btoa(bin), volume, sharp };
}

/**
 * Runs in the Part's frame: a 60 x 40 x 20 box with one 6 mm through hole and three closed round voids
 * (r4) inside, as STEP (review 2026-11-02: recognition reads each void as a hole with no cylinder,
 * and the words counted them as drilled holes). Self-contained (it is sent as text).
 */
export async function voidBlockInPage(): Promise<RoundedBlockMade> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type R = Record<string, any>;
  const k = (window as unknown as { __CAD__: { services: { kernel: { call(op: string, p: R): Promise<{ result: R; buffers: Record<string, ArrayBuffer> }> } } } }).__CAD__.services.kernel;
  const r = async (op: string, p: R) => (await k.call(op, p)).result;
  const tools = [(await r('cylinder', { r: 3, h: 22, origin: [20, 35, -1], axis: [0, 0, 1] })).id];
  for (const x of [10, 30, 50]) tools.push((await r('sphere', { r: 4, center: [x, 20, 10] })).id);
  const box = (await r('box', { dx: 60, dy: 40, dz: 20, origin: [0, 0, 0] })).id;
  const id = (await r('boolean', { op: 'cut', targets: [box], tools })).id;
  const volume = (await r('props', { id, volume: true, bbox: 'none' })).volume;
  const step = (await k.call('export_step', { shapes: [{ id, name: 'Body 2' }], schema: 'AP214' })).buffers.step;
  await r('release', { ids: [id, box, ...tools] });
  let bin = '';
  const u8 = new Uint8Array(step);
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return { b64: btoa(bin), volume, sharp: volume };
}

/**
 * Make the part in the open Part's page and import it with FILE > Import STEP (the panel's Done): what was made.
 * The STEP goes to the temp folder's cad-e2e-s4, at the path tempFile gives (the spec's
 * tempFilesRemovedAfterEach, which removes it after the test).
 */
export async function importRoundedBlock(page: Page, frame: FrameLocator, tempFile: (name: string) => string, make: () => Promise<RoundedBlockMade> = roundedBlockInPage): Promise<RoundedBlockMade> {
  const made = await workspaceFrame(page).evaluate(make);
  const file = tempFile(join('cad-e2e-s4', `rounded-block-${process.pid}-${Date.now()}.step`));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, Buffer.from(made.b64, 'base64'));
  const chooser = page.waitForEvent('filechooser');
  await frame.locator('[data-cad-toolbar] [data-command="file.import-step"]').click();
  await (await chooser).setFiles(file);
  const panel = frame.locator('[data-cad-panel="feature"]');
  await expect(panel.locator('[data-feature-panel="import"]')).toBeVisible();
  await expect(panel.locator('[data-import-diagnostics]')).toBeVisible({ timeout: 120_000 });
  await panel.locator('[data-panel-done]').click();
  await expect(panel).toHaveCount(0);
  return made;
}

/** The view is still (no camera transition running). */
export async function viewStill(page: Page) {
  await expect
    .poll(() => workspaceFrame(page).evaluate(() => (window as unknown as { __CAD__: { services: { viewport: { get(): { handle: { state: { get(): { animating?: boolean } } } | null } } } } }).__CAD__.services.viewport.get().handle?.state.get().animating ?? true))
    .toBe(false);
}

/**
 * The page point in the middle of the R5 vertical that faces the camera (the block's corners at
 * (5, 5), (75, 5), (5, 45), (75, 45), 9 mm up: under the R2 round the top).
 */
export async function r5OnPage(page: Page): Promise<[number, number]> {
  await viewStill(page);
  const cam = await workspaceFrame(page).evaluate(() => {
    const c = (window as unknown as { __CAD__: { services: { viewport: { get(): { handle: { camera(): { position: number[]; target: number[] } } } } } } }).__CAD__.services.viewport.get().handle.camera();
    return [c.position[0] - c.target[0], c.position[1] - c.target[1]];
  });
  let best: [number, number, number] = [5, 5, 9];
  let score = -Infinity;
  for (const [cx, cy] of [
    [5, 5],
    [75, 5],
    [5, 45],
    [75, 45],
  ]) {
    const ox = cx < 40 ? -Math.SQRT1_2 : Math.SQRT1_2;
    const oy = cy < 25 ? -Math.SQRT1_2 : Math.SQRT1_2;
    const s = ox * cam[0] + oy * cam[1];
    if (s > score) {
      score = s;
      best = [cx + 5 * ox, cy + 5 * oy, 9];
    }
  }
  return modelOnPage(page, best);
}

/** A Ctrl + left drag from `a` to `b` (page px): right to left, a box that takes what it touches. */
export async function ctrlBox(page: Page, frame: FrameLocator, a: [number, number], b: [number, number]) {
  await page.mouse.move(a[0], a[1]);
  await page.keyboard.down('Control');
  await page.mouse.down();
  await page.mouse.move((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, { steps: 4 });
  await page.mouse.move(b[0], b[1], { steps: 4 });
  await expect(frame.locator('[data-box-select]')).toHaveCount(1);
  await expect(frame.locator('[data-box-select]')).toHaveAttribute('data-box-mode', b[0] < a[0] ? 'touch' : 'enclose');
  await page.mouse.up();
  await page.keyboard.up('Control');
  await expect(frame.locator('[data-box-select]')).toHaveCount(0);
}
