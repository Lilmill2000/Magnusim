// The fillet and hole e2e part (S4), shared by Magnusim's and Magnusim CAD's Find specs: Body 1,
// made in the page with the Part's own kernel and written to STEP there (never a file of
// Daniel's): an 80 x 50 x 20 block with R5 on its 4 vertical edges and R2 round its top (4
// straight rounds, 4 corner pieces), four 6 mm through holes and a counterbore (6 mm through,
// 10 mm 5 deep) in its middle: 25 faces, 12 fillet faces, 5 drilled holes. Imported through
// FILE > Import STEP as a person does. The same part as tests/assistant/rounded-block.ts.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, type FrameLocator, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workspaceFrame } from './helpers';

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

/** Make the part in the open Part's page and import it with FILE > Import STEP (the panel's Done): what was made. */
export async function importRoundedBlock(page: Page, frame: FrameLocator): Promise<RoundedBlockMade> {
  const made = await workspaceFrame(page).evaluate(roundedBlockInPage);
  const dir = join(tmpdir(), 'cad-e2e-s4');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `rounded-block-${process.pid}-${Date.now()}.step`);
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
