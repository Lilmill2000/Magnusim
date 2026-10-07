import { expect, test } from '@playwright/test';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startHost } from './support/host-server.mjs';

// What the BC panel offers comes from the BC families the study's analysis
// publishes (registry kind bc_family), not from core literals: the picker lists
// a plugin's own family with its hint, its record is edited in a form built from
// the family's fields (it names no UI component), the edit survives a reload, and
// its faces paint in the family's colour ('other'). The fixture plugin
// (python/tests/fixtures/bc-plugins/example-extra-bc) adds an analysis that offers
// Incompressible Flow's BCs plus a mirror plane. No WSL: nothing is solved.
const FIXTURE = 'sample-project-steady-state-e2e';
const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
// The 'other' colour: the hub swatch (.hub-swatch-other) and the face paint (BC_KIND_RGB.other).
const OTHER_RGB = [219, 39, 119];
// Incompressible Flow's own families, in the order it registers them.
const IF_FAMILIES = [
  'velocity_inlet',
  'velocity_outlet',
  'pressure_outlet',
  'total_pressure_inlet',
  'freestream',
  'wall',
  'symmetry',
];
let host;
let plugins;

test.beforeAll(async () => {
  plugins = mkdtempSync(join(tmpdir(), 'bc-contract-'));
  const from = join(WEB, 'python', 'tests', 'fixtures', 'bc-plugins', 'example-extra-bc');
  cpSync(from, join(plugins, 'example-extra-bc'), {
    recursive: true,
    filter: (src) => !src.includes('__pycache__'),
  });
  host = await startHost({ name: 'bc-contract', pluginsDir: plugins, enablePlugins: ['example-extra-bc'] });
});

test.afterAll(() => {
  if (host) host.stop();
  if (plugins) rmSync(plugins, { recursive: true, force: true });
});

async function openProject(page) {
  await page.goto(`${host.base}/#/p/${FIXTURE}`);
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, FIXTURE, { timeout: 90_000 });
}

test("a plugin's BC family is offered, edited in its generic form, kept, and painted in its colour", async ({ page, request }) => {
  test.setTimeout(240_000);
  const picker = page.locator('#panel-bc-picker .cfd-island');
  const editor = page.locator('#panel-bc-editor .cfd-island [data-bc-editor="1"]');
  const pickerKeys = () => picker.locator('[data-bc-key]').evaluateAll((els) => els.map((el) => el.getAttribute('data-bc-key')));

  await openProject(page);

  // A study of Incompressible Flow's own analysis offers its families only.
  await page.locator('#left-tree [data-w19-bcs="1"] .bc-plus').first().click();
  await expect(picker).toBeVisible();
  await expect.poll(pickerKeys).toEqual(IF_FAMILIES);
  await picker.locator('button[aria-label="Close"]').click();

  // A study of the fixture's analysis.
  await page.locator('#btn-create-simulation').click();
  await page.locator('#cs-type-list [data-analysis-key="extra_bc_steady"]').click();
  await page.locator('#cs-create').click();
  await expect(page.locator('#modal-create-simulation')).toBeHidden({ timeout: 30_000 });
  const sid = await page.evaluate(() => window.__CFD_W17__.activeId);
  expect(sid).toBeTruthy();
  const bcsNow = async () =>
    (await (await request.get(`${host.base}/api/bcs?project_id=${FIXTURE}&simulation_id=${encodeURIComponent(sid)}`)).json())
      .boundary_conditions || [];
  const mirrorBc = async () => (await bcsNow()).find((b) => b.bc_type === 'Mirror plane') || null;

  // The picker lists the plugin's family, with its hint, after the analysis's IF ones.
  await page.locator(`#left-tree [data-w17-sim-id="${sid}"] [data-w19-bcs="1"] .bc-plus`).first().click();
  await expect(picker).toBeVisible();
  await expect.poll(pickerKeys).toEqual([...IF_FAMILIES, 'mirror_plane']);
  const sym = picker.locator('[data-bc-key="mirror_plane"]');
  await expect(sym.locator('.ml-type-name')).toHaveText('Mirror plane');
  await expect(sym.locator('.ml-type-sub')).toHaveText('Mirror plane: no flow through it');

  // Add creates it with the family's seed, and opens its editor on the generic form.
  await sym.click();
  await picker.locator('[data-bc-add="1"]').click();
  await expect(editor).toBeVisible({ timeout: 15_000 });
  await expect(editor.locator('[data-bc-title="1"]')).toHaveText(/^Mirror plane \d+$/);
  await expect.poll(async () => (await mirrorBc())?.mirror, { timeout: 15_000 }).toBe('Plane');
  const id = (await mirrorBc()).id;
  const mirror = editor.locator('[data-schema-key="mirror"] select');
  await expect(mirror).toBeVisible();
  await expect(mirror.locator('option:checked')).toHaveText('Plane');
  await expect(editor.getByLabel('Boundary condition type')).toHaveValue('Mirror plane');

  // A face clicked on the model is assigned and paints in the 'other' colour.
  // Wait until the model is drawn: on a cold start (a fresh install, the first test
  // to open the project) a click before the first geometry load hits an empty canvas.
  await page.waitForFunction(() => window.__CFD_W16_STATE__?.ready === true, null, { timeout: 60_000 });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const box = await page.locator('#viewer').boundingBox();
  expect(box).toBeTruthy();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const chips = editor.locator('[data-face-picker="1"] [data-face-id]');
  await expect(chips).toHaveCount(1, { timeout: 10_000 });
  const face = await chips.first().getAttribute('data-face-id');
  await expect.poll(async () => (await mirrorBc())?.faces || []).toEqual([face]);
  await expect
    .poll(() => page.evaluate((f) => (window.__CFD_W16_STATE__.facePaint || {})[f] || null, face))
    .toEqual(OTHER_RGB);

  // Edit the field in the generic form: saved as the family's choice.
  await mirror.selectOption('Wedge');
  await expect.poll(async () => (await mirrorBc())?.mirror, { timeout: 15_000 }).toBe('Wedge');
  expect((await mirrorBc()).faces).toEqual([face]);

  // After a reload: the edit is still there, and the hub card and the model show the colour.
  await page.reload();
  await page.waitForFunction((pid) => window.__CFD_PROJECT_READY__ === pid, FIXTURE, { timeout: 90_000 });
  const activeStudy = () => page.evaluate(() => (window.__CFD_W17__ && window.__CFD_W17__.activeId) || null);
  if ((await activeStudy()) !== sid) {
    await page.locator(`#left-tree [data-w17-sim-id="${sid}"] > .tree-row .tl`).first().click();
  }
  await expect.poll(activeStudy, { timeout: 30_000 }).toBe(sid);
  await page.locator(`#left-tree [data-w17-sim-id="${sid}"] [data-w19-bcs="1"] > .tree-row .tl`).first().click();
  const hub = page.locator('#panel-bcs-hub .cfd-island');
  await expect(hub).toBeVisible();
  const card = hub.locator(`[data-open-bc="${id}"]`);
  await expect(card.locator('.hub-item-sub')).toHaveText(`Mirror plane · ${face}`);
  const swatch = await card.locator('.hub-swatch').evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(swatch).toBe(`rgb(${OTHER_RGB.join(', ')})`);
  await expect(hub.locator('.bc-legend')).toContainText('Mirror plane');
  await expect
    .poll(() => page.evaluate((f) => (window.__CFD_W16_STATE__.facePaint || {})[f] || null, face))
    .toEqual(OTHER_RGB);
  await card.click();
  await expect(editor.locator('[data-bc-title="1"]')).toHaveText(/^Mirror plane \d+$/);
  await expect(editor.locator('[data-schema-key="mirror"] select option:checked')).toHaveText('Wedge');
  expect((await mirrorBc()).mirror).toBe('Wedge');
});
