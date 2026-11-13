// Refinement near bodies (R2): patches of half-size cells round a body that move with it.
//
// 1. In the tunnel: x2 puts one patch round the default airfoil, the lift settles where a
//    uniform grid of the patch's cells puts it (NACA 2412 at 6°, Re 660,000: 0.845 to 0.875 at
//    256 cells across the chord, against 0.80 to 0.97 unrefined, by where the airfoil falls on
//    the grid), steady; switching the flow model while refined keeps the GPU work valid; x4
//    adds a second level; a drag moves the patches with the airfoil and the flow stays stable.
// 2. The refinement's own checks: Schäfer–Turek 2D-2 on a coarse grid of 10 cells per diameter
//    with a patch reproduces the uniform 20-cell result, and NACA 0012 at Re 6 million on 50
//    cells per chord with one patch level matches a uniform 100.
// 3. Two refined bodies brought together (their patches join into one) and apart again (one
//    each): the GPU work stays valid (a group's old patches were destroyed before the frame
//    that copies from them was submitted, which dropped that frame), and the flow runs on.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test } from '@playwright/test';
import { newTunnel, openTunnel, pageXY, scaledTimeout, scene, stats, T, useTunnelHost } from './helpers.js';

const env = useTunnelHost('tunnel2d-refine');

async function liftOver(page, frame, id, ms) {
  const xs = [];
  for (let t = 0; t < ms; t += 250) {
    xs.push((await T(frame, (b) => window.__TUNNEL__.bodyLive(b), id)).cl);
    await page.waitForTimeout(250);
  }
  return { mean: xs.reduce((a, b) => a + b, 0) / xs.length, spread: Math.max(...xs) - Math.min(...xs) };
}

test('refining round the airfoil: patches, the lift a finer grid gives, model switches and drags', async ({ page, request }) => {
  env.needsFastGpu();
  scaledTimeout(300_000);
  const errors = [];
  page.on('console', (m) => {
    if ((m.type() === 'error' || m.type() === 'warning') && /Invalid|WebGPU|GPU/.test(m.text()) && !/powerPreference/.test(m.text())) errors.push(m.text());
  });
  const study = await newTunnel(env.host, request, 'Refined tunnel');
  const frame = await openTunnel(env.host, page, study);
  const id = (await scene(frame)).bodies[0].id;
  const refine = frame.getByRole('combobox', { name: 'Refine near bodies' });
  await refine.selectOption('1');
  await expect.poll(() => T(frame, () => window.__TUNNEL__.refine().length), { timeout: 30_000 }).toBe(1);
  const info = await T(frame, () => window.__TUNNEL__.refine());
  expect(info[0].ids).toEqual([id]);
  expect(info[0].levels).toHaveLength(1);
  // The note counts the cells across the body on its finest grid: 128 x 2 on the medium grid.
  await expect(frame.locator('[data-t2d-model-note="sa"]')).toContainText('256 cells across the body');
  // Settle (a few chord passes at the refined speed), then read the lift.
  const st0 = await stats(frame);
  await expect.poll(async () => (await stats(frame)).simTime, { timeout: 150_000, intervals: [1000] }).toBeGreaterThan(st0.simTime + 0.8);
  const lift = await liftOver(page, frame, id, 3000);
  expect(lift.mean).toBeGreaterThan(0.83);
  expect(lift.mean).toBeLessThan(0.89);
  expect(lift.spread).toBeLessThan(0.02);

  // The flow model switched while refined (new pipelines): the GPU work stays valid.
  await frame.getByRole('combobox', { name: 'Flow model' }).selectOption('resolved');
  await page.waitForTimeout(3000);
  await frame.getByRole('combobox', { name: 'Flow model' }).selectOption('auto');
  await page.waitForTimeout(2000);
  expect(errors).toEqual([]);
  expect((await stats(frame)).state).toBe('running');

  // x4: a second level inside the first.
  await refine.selectOption('2');
  await expect.poll(() => T(frame, () => window.__TUNNEL__.refine()[0]?.levels.length ?? 0), { timeout: 30_000 }).toBe(2);
  const before = (await T(frame, () => window.__TUNNEL__.refine()))[0].levels[0];

  // A drag: the patches follow the airfoil, and the flow stays stable.
  const b = (await scene(frame)).bodies[0];
  const at = await pageXY(page, await T(frame, ([x, y]) => window.__TUNNEL__.toScreen(x, y), [b.x + 0.15, b.y]));
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  for (let i = 1; i <= 40; i++) {
    await page.mouse.move(at.x + i * 2, at.y - i * 3);
    await page.waitForTimeout(100);
  }
  await page.mouse.up();
  await expect
    .poll(async () => {
      const lv = (await T(frame, () => window.__TUNNEL__.refine()))[0]?.levels[0];
      return lv ? lv.oy - before.oy : 0;
    }, { timeout: 60_000 })
    .toBeGreaterThan(5);
  await page.waitForTimeout(2000);
  expect((await stats(frame)).state).toBe('running');
  expect(Number.isFinite((await T(frame, (bid) => window.__TUNNEL__.bodyLive(bid), id)).cl)).toBe(true);
  expect(errors).toEqual([]);

  // Off again: no patches.
  await refine.selectOption('0');
  await expect.poll(() => T(frame, () => window.__TUNNEL__.refine().length), { timeout: 30_000 }).toBe(0);
});

test("the refinement's checks: the cylinder benchmark and an airfoil match the finer uniform grid", async ({ page, request }) => {
  env.needsFastGpu();
  scaledTimeout(300_000);
  const study = await newTunnel(env.host, request, 'Refinement checks');
  const frame = await openTunnel(env.host, page, study);
  await frame.getByRole('button', { name: /pause/i }).first().click();

  // 2D-2, coarse 10 cells per D with a patch of 20: as uniform 20 (St 0.302, Cd max 3.253)
  // and within the benchmark's St band; uniform 10 alone is far off (Cd max 3.48).
  const st = await T(frame, () => window.__TUNNEL__.validate(10, 200, true));
  expect(st.bad).toBe(0);
  expect(st.St).toBeGreaterThan(0.295);
  expect(st.St).toBeLessThan(0.305);
  expect(Math.abs(st.cdMax / 3.253 - 1)).toBeLessThan(0.01);

  // NACA 0012, Re 6 million, 10°: 50 cells per chord with one level of patch (trailing edge
  // sized for the patch) against uniform 100: lift and drag within 0.5 %.
  const base = { code: '0012', alpha: 10, re: 6e6, turb: 'sa', tstar: 12 };
  const refined = await T(frame, (c) => window.__TUNNEL__.validateAirfoil({ ...c, chord: 50, refine: 1, teMin: 1 }), base);
  const uniform = await T(frame, (c) => window.__TUNNEL__.validateAirfoil({ ...c, chord: 100 }), base);
  expect(refined.bad + uniform.bad).toBe(0);
  expect(Math.abs(refined.cl / uniform.cl - 1)).toBeLessThan(0.005);
  expect(Math.abs(refined.cd / uniform.cd - 1)).toBeLessThan(0.005);
});

test('two refined bodies brought together and apart: the patches join and part, and the GPU work stays valid', async ({ page, request }) => {
  env.needsFastGpu();
  scaledTimeout(240_000);
  const errors = [];
  page.on('console', (m) => {
    if ((m.type() === 'error' || m.type() === 'warning') && /Invalid|WebGPU|GPU|destroyed/.test(m.text()) && !/powerPreference/.test(m.text())) errors.push(m.text());
  });
  const study = await newTunnel(env.host, request, 'Joined patches');
  const frame = await openTunnel(env.host, page, study);
  const foil = (await scene(frame)).bodies[0];
  await frame.getByRole('combobox', { name: 'Add shape' }).selectOption('circle');
  await expect.poll(async () => (await scene(frame)).bodies.length).toBe(2);
  const cyl = (await scene(frame)).bodies[1];
  await frame.getByRole('combobox', { name: 'Refine near bodies' }).selectOption('1');
  /** The cylinder's position, through the Body panel. */
  const place = async (x, y) => {
    await frame.locator(`[data-t2d-body="${cyl.id}"]`).click();
    for (const [label, v] of [['Position x', x], ['Position y', y]]) {
      const box = frame.getByRole('textbox', { name: label, exact: true });
      await box.fill(String(v));
      await box.press('Enter');
    }
  };
  const groups = async () => (await T(frame, () => window.__TUNNEL__.refine())).map((g) => g.ids.length).sort();
  // Apart: a patch each.
  await place(foil.x, 3.4);
  await expect.poll(groups, { timeout: 60_000 }).toEqual([1, 1]);
  await page.waitForTimeout(1500);
  // Together, just behind the airfoil: one patch round both (copied from the two it replaces).
  await place(foil.x + 1.1, foil.y - 0.2);
  await expect.poll(groups, { timeout: 60_000 }).toEqual([2]);
  await page.waitForTimeout(2000);
  // Apart again: one each (copied from the one they shared).
  await place(foil.x, 3.4);
  await expect.poll(groups, { timeout: 60_000 }).toEqual([1, 1]);
  await page.waitForTimeout(2000);
  console.log(`joined patches: ${errors.length} GPU messages${errors.length ? `: ${errors[0].slice(0, 200)}` : ''}`);
  expect(errors).toEqual([]);
  expect((await stats(frame)).state).toBe('running');
  expect(Number.isFinite((await T(frame, (b) => window.__TUNNEL__.bodyLive(b), foil.id)).cl)).toBe(true);
});
