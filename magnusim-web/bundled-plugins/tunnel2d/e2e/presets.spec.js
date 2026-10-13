// The exact-Reynolds-number presets (R3): flows the grid resolves, run as they are, with
// published values to compare.
//
// 1. Each preset, picked from the toolbar, runs at its real Reynolds number (the Wind panel
//    says the grid resolves it, no model) and, once settled, measures within 1 % of the
//    published range on every quantity it shows (Strouhal number, drag, lift swing, wake length).
// 2. A preset's panel says when the setup has been changed from it, and Undo brings back the
//    tunnel there was before it.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test } from '@playwright/test';
import { newTunnel, openTunnel, scene, useTunnelHost } from './helpers.js';

const env = useTunnelHost('tunnel2d-presets');

/** The panel's rows: quantity -> { value, range } (the published range is in the third cell). */
async function rows(frame) {
  return frame.locator('[data-t2d-preset-row]').evaluateAll((els) =>
    els.map((e) => {
      const r = e.querySelectorAll('td')[1].textContent.split('–').map((v) => Number(v.trim()));
      return { q: e.getAttribute('data-t2d-preset-row'), value: Number(e.getAttribute('data-value')), lo: r[0], hi: r[1] };
    }),
  );
}

const PRESETS = ['cylinder-re20', 'cylinder-re40', 'cylinder-re100', 'cylinder-re200', 'square-re100'];

test('every preset runs at its real Reynolds number and measures what is published', async ({ page, request }) => {
  env.needsFastGpu();
  test.setTimeout(600_000);
  const study = await newTunnel(env.host, request, 'Presets');
  const frame = await openTunnel(env.host, page, study);
  for (const id of PRESETS) {
    await frame.getByRole('combobox', { name: 'Presets' }).selectOption(id);
    const panel = frame.locator(`[data-t2d-preset="${id}"]`);
    await expect(panel).toBeVisible();
    await expect(panel.locator('[data-t2d-preset-exact]')).toBeVisible();
    // Real and simulated Reynolds numbers are the same, and the Wind panel says why.
    const re = frame.locator('[data-t2d-re]');
    await expect(re.locator('[data-t2d-model-note="resolved"]')).toBeVisible();
    expect(Number(await re.getAttribute('data-sim'))).toBeCloseTo(Number(await re.getAttribute('data-real')), 3);
    await expect(panel).toHaveAttribute('data-settled', 'yes', { timeout: 240_000 });
    await page.waitForTimeout(2000);
    const got = await rows(frame);
    expect(got.length).toBeGreaterThan(1);
    for (const r of got) {
      expect(Number.isFinite(r.value), `${id} ${r.q} measured`).toBe(true);
      expect(r.value, `${id} ${r.q}: ${r.value} against ${r.lo}–${r.hi}`).toBeGreaterThan(r.lo * 0.99);
      expect(r.value, `${id} ${r.q}: ${r.value} against ${r.lo}–${r.hi}`).toBeLessThan(r.hi * 1.01);
    }
  }
});

test("a preset's panel says when its setup changed, and Undo brings the tunnel back", async ({ page, request }) => {
  env.needsGpu();
  const study = await newTunnel(env.host, request, 'Preset edits');
  const frame = await openTunnel(env.host, page, study);
  const before = await scene(frame);
  await frame.getByRole('combobox', { name: 'Presets' }).selectOption('cylinder-re100');
  const panel = frame.locator('[data-t2d-preset="cylinder-re100"]');
  await expect(panel).toBeVisible();
  await expect(panel.locator('[data-t2d-preset-exact]')).toBeVisible();
  // Double the wind speed: no longer the preset.
  const s = await scene(frame);
  const speed = frame.getByRole('textbox', { name: 'Wind speed' });
  await speed.fill(String(2 * s.flow.speed));
  await speed.press('Enter');
  await expect(panel).toContainText('has been changed from the preset');
  // Undo twice: the speed, then the preset itself.
  await frame.getByRole('button', { name: 'Undo' }).click();
  await expect(panel.locator('[data-t2d-preset-exact]')).toBeVisible();
  await frame.getByRole('button', { name: 'Undo' }).click();
  await expect(panel).toHaveCount(0);
  const after = await scene(frame);
  expect(after.bodies.map((b) => b.shape)).toEqual(before.bodies.map((b) => b.shape));
});
