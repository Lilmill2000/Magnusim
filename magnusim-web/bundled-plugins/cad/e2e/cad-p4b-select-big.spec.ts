// P4b fix round 1, B-3 (opt-in: CAD_E2E_BIG_STEP, Daniel's 113 MB part, read where it is, never copied): a Ctrl
// box over the whole 11,776-face import, timed as the user meets it, from the release until the selection is
// applied and highlighted, the count chip says so, and the page answers again. The review measured 5-8 s: the
// box's own pass was 0.1-0.3 s, the rest was three or four full frames of the part (the box's own frame, a hover
// pick at the release, the dock growing with the count chip), each about 1.5 s in the e2e browser's software
// WebGL. Now one frame follows the release: the budget is the box's pass plus one and a half frames plus 1 s
// (the frame's cost measured in the same run, so the test holds on a real GPU and on software rendering).
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test } from '@playwright/test';
import { existsSync } from 'node:fs';
import { newPartFromTree, newProject, openProject, partOpened, watchPage, workspaceFrame } from './helpers';

const BIG = process.env.CAD_E2E_BIG_STEP || '';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type W = { __CAD__: { services: any } };

test('cad:p4b-select-big-box (needs CAD_E2E_BIG_STEP) a Ctrl box over the 11,776-face import: release -> selection applied, highlighted, chip updated, page answering, within one frame of the part', { tag: '@serial' }, async ({ page, request }) => {
  test.skip(!BIG, 'CAD_E2E_BIG_STEP is not set: this test needs the 113 MB STEP');
  expect(existsSync(BIG), `CAD_E2E_BIG_STEP names no file: ${BIG}`).toBe(true);
  test.setTimeout(1_200_000);
  const seen = await watchPage(page);
  const projectId = await newProject(request);
  await openProject(page, projectId);
  await newPartFromTree(page, 'Part 1');
  const frame = await partOpened(page);
  const chooser = page.waitForEvent('filechooser');
  await frame.locator('[data-cad-toolbar] [data-command="file.import-step"]').click();
  await (await chooser).setFiles(BIG);
  const p = frame.locator('[data-cad-panel]');
  await expect(p.locator('[data-import-diagnostics]')).toBeVisible({ timeout: 900_000 });
  await expect(p.locator('[data-import-progress]')).toHaveCount(0, { timeout: 300_000 });
  await p.locator('[data-panel-done]').click();
  const cad = <T>(fn: () => T) => workspaceFrame(page).evaluate(fn as never) as Promise<T>;
  await expect.poll(() => cad(() => (window as unknown as W).__CAD__.services.doc.state.get().rebuild.status === 'done'), { timeout: 600_000 }).toBe(true);
  await expect.poll(() => cad(() => (window as unknown as W).__CAD__.services.viewport.get().handle.state.get().bvhPending), { timeout: 120_000 }).toBe(0);
  await page.keyboard.press('7');
  await page.waitForTimeout(1500);
  const fb = (await page.locator('#workspace-frame').boundingBox())!;
  const chip = frame.locator('[data-chip="selection"] [data-selection-count]');
  const results: Record<string, number | string>[] = [];
  for (const mode of ['enclose', 'touch']) {
    const a: [number, number] = [fb.x + 280, fb.y + 140];
    const b: [number, number] = [fb.x + fb.width - 20, fb.y + fb.height - 120];
    const [s, e] = mode === 'enclose' ? [a, b] : [b, a];
    await page.mouse.move(s[0], s[1]);
    await page.keyboard.down('Control');
    await page.mouse.down();
    await page.mouse.move(e[0], e[1], { steps: 8 });
    const frames0 = await cad(() => (window as unknown as W).__CAD__.services.viewport.get().handle.stats().frames);
    const t0 = Date.now();
    await page.mouse.up();
    await page.keyboard.up('Control');
    await expect(chip).toHaveText(/^\d+ edges$/, { timeout: 60_000 });
    await cad(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
    const ms = Date.now() - t0;
    const st = await cad(() => (window as unknown as W).__CAD__.services.viewport.get().handle.stats());
    results.push({ mode, ms, boxMs: Math.round(st.lastBoxMs), frames: st.frames - frames0, chip: (await chip.textContent()) ?? '' });
    await page.keyboard.press('Escape');
    await expect(chip).toHaveCount(0);
    await cad(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
  }
  // One frame of the part, measured here (the GPU waited for).
  const frameMs = await cad(() => (window as unknown as W).__CAD__.services.viewport.get().handle.measure(2).msPerFrame);
  console.log(`[big-box] frame ${Math.round(frameMs)} ms; ${JSON.stringify(results)}`);
  test.info().annotations.push({ type: 'big-box', description: JSON.stringify({ frameMs: Math.round(frameMs), results }) });
  for (const r of results) {
    expect(r.frames as number, `${r.mode}: frames drawn after the release`).toBeLessThanOrEqual(2);
    expect(r.ms as number, `${r.mode}: release -> selection, highlight, chip, page answering`).toBeLessThan((r.boxMs as number) + 1.5 * frameMs + 1000);
  }
  expect(seen.errors).toEqual([]);
});
