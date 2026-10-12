import { expect, test } from '@playwright/test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NO_WSL } from './toolchain.js';

// A Standard mesh of a part whose small feature suppression used to open its surface.
// plate-tabs.step is a 1.6 m duct crossed by a 1/8 in plate; under each of its two
// slots hangs a tab whose end stops 0.188 mm short of the slot end. Automatic small
// feature suppression is 0.2 mm on a part this size, so the old mesher healed those
// 0.188 mm edges, the faces no longer met, and Generate failed ("HXT 3D mesh failed",
// as on a user's perforated plate with louvers). Now the mesh is ready, with default
// settings at fineness 1.
const WSL = (process.env.MAGNUSIM_E2E_WSL || process.env.CFDDESK_E2E_WSL) === '1';
const HERE = dirname(fileURLToPath(import.meta.url));
const PLATE = join(HERE, '..', 'python', 'tests', 'fixtures', 'geometry', 'plate-tabs.step');

test('a plate with tabs a fraction of a millimetre off its slots meshes with Standard', async ({ page, request }) => {
  test.skip(!WSL, NO_WSL);
  test.setTimeout(900_000);
  await page.goto('/#/');
  await page.waitForFunction(() => typeof window.__CFD_W16_CREATE__ === 'function', null, { timeout: 60_000 });
  const pid = await page.evaluate(
    async (t) =>
      (await window.__CFD_W16_CREATE__({ title: t, description: '', category: 'Other', units: 'Metric', folder: 'My Projects' }))
        .project.id,
    `e2e plate tabs ${Date.now().toString(36)}`,
  );
  await page.goto(`/#/p/${encodeURIComponent(pid)}`);
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, pid, { timeout: 60_000 });
  await page.locator('#geometry-file-input').setInputFiles(PLATE);
  await expect(page.locator('#btn-create-simulation')).toBeVisible({ timeout: 120_000 });
  await page.locator('#btn-create-simulation').click();
  await page.locator('#cs-create').click();
  await expect(page.locator('#modal-create-simulation')).toBeHidden({ timeout: 30_000 });
  const sid = await page.evaluate(() => window.__CFD_W17__.activeId);

  const study = page.locator(`#left-tree [data-w17-sim-id="${sid}"] > .tree-row`).first();
  if ((await study.locator('.tw').textContent())?.trim() === '+') await study.locator('.tw').click();
  await page.locator(`#left-tree [data-w17-sim-id="${sid}"] [data-w20-mesh="1"] > .tree-row .tl`).first().click();
  await page.locator('#btn-create-mesh').click({ timeout: 15_000 });
  const form = page.locator('#panel-mesh-form .cfd-island');
  await expect(form.locator('[data-schema-key="fineness"] input')).toBeVisible({ timeout: 30_000 });
  const mid = await page.evaluate(() => window.__CFD_W20__.active_id);
  await form.locator('[data-schema-key="fineness"] input').fill('1');
  await form.locator('[data-schema-key="fineness"] input').press('Tab');
  await form.locator('[data-mesh-generate="1"]').click();

  // What the user sees: the mesh panel says ready (it said failed before the fix).
  const status = page.locator('#panel-mesh-form [data-mesh-status]');
  await expect(status).toHaveAttribute('data-mesh-status', /ready|failed/, { timeout: 840_000 });
  const rec = (await (await request.get(`/api/mesh?${new URLSearchParams({ project_id: pid, simulation_id: sid, mesh_id: mid })}`)).json()).mesh || {};
  expect(await status.getAttribute('data-mesh-status'), JSON.stringify(rec.live_mesh_result?.error || '')).toBe('ready');
  expect(Number(rec.live_mesh_result?.n_cells || 0)).toBeGreaterThan(0);
  await page.screenshot({ path: test.info().outputPath('plate-tabs-meshed.png') });
});
