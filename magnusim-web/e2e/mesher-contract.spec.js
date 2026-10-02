import { expect, test } from '@playwright/test';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startHost } from './support/host-server.mjs';

// What the Mesh panel shows for a mesher comes from the mesher (MeshBackend), not
// from core literals: a plugin mesher's own setting is saved and comes back after a
// reload (the panel and the server kept only the core's keys), and the refinement
// menu offers the types that mesher applies (it was the same two for every mesher,
// while the registry claimed types no mesher implements). The fixture mesher
// (python/tests/fixtures/plugins/example-extra-mesher) adds `surface_bias` and
// applies inflate layers only. No WSL: nothing is meshed.
const FIXTURE = 'sample-project-steady-state-e2e';
const SIM = 'sim_1';
const MESH = 'mesh_1';
const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
let host;
let plugins;

test.beforeAll(async () => {
  plugins = mkdtempSync(join(tmpdir(), 'mesher-contract-'));
  const from = join(WEB, 'python', 'tests', 'fixtures', 'plugins', 'example-extra-mesher');
  cpSync(from, join(plugins, 'example-extra-mesher'), {
    recursive: true,
    filter: (src) => !src.includes('__pycache__'),
  });
  host = await startHost({ name: 'mesher-contract', pluginsDir: plugins, enablePlugins: ['example-extra-mesher'] });
});

test.afterAll(() => {
  if (host) host.stop();
  if (plugins) rmSync(plugins, { recursive: true, force: true });
});

async function openProject(page) {
  await page.goto(`${host.base}/#/p/${FIXTURE}`);
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, FIXTURE, { timeout: 90_000 });
}

test("a plugin mesher's own setting and refinement menu come from the mesher", async ({ page, request }) => {
  test.setTimeout(240_000);
  const form = page.locator('#panel-mesh-form .cfd-island');
  const bias = form.locator('[data-schema-key="surface_bias"] input');
  const engine = form.locator('select[data-mesh-engine="1"]');
  const openMesh = async () => {
    await page.locator(`#left-tree [data-w20-mesh-item="${MESH}"] > .tree-row .tl`).first().click();
    await expect(form.locator('[data-mesh-generate="1"]')).toBeVisible({ timeout: 30_000 });
    // The engine select sits in the advanced disclosure.
    const advanced = form.locator('details.mesh-advanced');
    if (!(await advanced.evaluate((el) => el.open))) await advanced.locator('> summary').click();
  };
  const saved = async () =>
    (await (await request.get(`${host.base}/api/mesh?project_id=${FIXTURE}&simulation_id=${SIM}&mesh_id=${MESH}`)).json())
      .mesh || {};
  const menu = async () => {
    const li = page.locator(`#left-tree li[data-w20-mesh-item="${MESH}"]`).first();
    if (!(await li.evaluate((el) => el.classList.contains('expanded')))) {
      await li.locator(':scope > .tree-row .tw').click();
    }
    await page.locator(`[data-refs-plus="${MESH}"]`).first().click();
    await expect(page.locator('#panel-ref-picker')).toBeVisible();
    const types = await page.locator('#panel-ref-picker .ml-type').evaluateAll((els) =>
      els.map((el) => el.getAttribute('data-ref-type')),
    );
    await page.locator('#ref-picker-close').click();
    return types;
  };

  await openProject(page);
  await openMesh();
  // Standard offers both refinement types its run applies.
  expect(await menu()).toEqual(['Surface custom sizing', 'Inflate boundary layer']);

  // The plugin mesher's own setting shows, and a new pick saves its default.
  await openMesh();
  await engine.selectOption('example_extra_mesher');
  await expect(bias).toBeVisible();
  await expect(bias).toHaveValue('1.5');
  await expect.poll(async () => (await saved()).settings?.mesher_settings?.surface_bias).toBe(1.5);

  // A changed value is saved as given and comes back after a reload.
  await bias.fill('2.25');
  await bias.press('Enter');
  await expect.poll(async () => (await saved()).settings?.mesher_settings?.surface_bias).toBe(2.25);
  const s = (await saved()).settings || {};
  expect(s.advanced?.mesh_engine).toBe('example_extra_mesher');
  expect(s.mesher_settings).not.toHaveProperty('fineness');
  await page.reload();
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, FIXTURE, { timeout: 90_000 });
  await openMesh();
  await expect(engine).toHaveValue('example_extra_mesher');
  await expect(bias).toHaveValue('2.25');

  // Its refinement menu is its own: inflate layers only.
  expect(await menu()).toEqual(['Inflate boundary layer']);
  // The refinements API refuses a type this mesh's mesher does not apply, and says why.
  const refused = await request.post(`${host.base}/api/mesh/refinements`, {
    data: { project_id: FIXTURE, simulation_id: SIM, mesh_id: MESH, type: 'Surface custom sizing', faces: ['face 4@Body1'] },
  });
  expect(refused.status()).toBe(400);
  expect((await refused.json()).error).toBe('Extra mesher does not apply Surface custom sizing refinements.');
});
