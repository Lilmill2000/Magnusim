import { expect, test } from '@playwright/test';
import { rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { seedElbowProject } from '../../../e2e/support/plugin-suite.js';

// The two turbulence models Incompressible Flow gained (F8): Spalart-Allmaras and
// Realizable k-epsilon. Each is picked in the study panel, saved as its OpenFOAM model,
// and still picked after a reload. The velocity inlet's "Turbulence at the inlet" rows
// follow the model: Spalart-Allmaras solves for nuTilda alone, so its viscosity-ratio
// setting has no intensity and its Auto says the nuTilda rule (3 x the fluid's
// viscosity); Realizable k-epsilon shows the k-epsilon rows (with the intensity);
// Laminar shows none. No WSL: nothing is solved (the plugin's tests write the cases,
// and both models were run in OpenFOAM v2606).
const PROJECT = 'turbulence-models-e2e';
const SIM = 'sim_1';
const PROJECTS_ROOT = process.env.MAGNUSIM_PROJECTS_ROOT || resolve('e2e/.tmp-projects');

test.beforeAll(() => {
  rmSync(join(PROJECTS_ROOT, PROJECT), { recursive: true, force: true });
  seedElbowProject(PROJECTS_ROOT, PROJECT, 'Turbulence models');
});

test.afterAll(() => {
  rmSync(join(PROJECTS_ROOT, PROJECT), { recursive: true, force: true });
});

const getJson = async (request, url) => {
  for (let i = 0; ; i++) {
    try {
      return await (await request.get(url)).json();
    } catch (e) {
      if (i >= 2 || !/ECONNRESET|socket hang up/i.test(String(e))) throw e;
    }
  }
};

test('Spalart-Allmaras and Realizable k-epsilon are picked, kept after a reload, and set the inlet turbulence rows', async ({
  page,
  request,
}) => {
  test.setTimeout(240_000);
  const simNow = async () => (await getJson(request, `/api/simulation?project_id=${PROJECT}&simulation_id=${SIM}`)).simulation || {};
  const bcsNow = async () =>
    (await getJson(request, `/api/bcs?project_id=${PROJECT}&simulation_id=${SIM}`)).boundary_conditions || [];
  const inletId = (await bcsNow()).find((b) => /velocity\s*inlet/i.test(String(b.bc_type)))?.id;
  expect(inletId, 'the elbow sample has a velocity inlet').toBeTruthy();
  const savedInlet = async () => (await bcsNow()).find((b) => b.id === inletId) || {};

  const studyPanel = page.locator('#panel-study-settings .cfd-island');
  const turbulence = studyPanel.locator('[data-schema-key="turbulence_model"] select');
  const editor = page.locator('#panel-bc-editor .cfd-island [data-bc-editor="1"]');
  const hub = page.locator('#panel-bcs-hub .cfd-island');
  const field = (label) => editor.getByLabel(label, { exact: true });
  const hint = editor.locator('[data-bc-turbulence="1"] .mat-assign-hint');

  const openProject = async () => {
    await page.goto(`/#/p/${encodeURIComponent(PROJECT)}`);
    await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, PROJECT, { timeout: 90_000 });
  };
  const reload = async () => {
    await page.reload();
    await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, PROJECT, { timeout: 90_000 });
  };
  /** The study panel; the study's row toggles it, so it is clicked only while the panel is shut. */
  const openStudy = async () => {
    if (await turbulence.isVisible()) return;
    await page.locator(`#left-tree [data-w17-sim-id="${SIM}"] > .tree-row`).first().click();
    await expect(turbulence).toBeVisible({ timeout: 15_000 });
  };
  /** Pick a model by its label; it is saved as its OpenFOAM name, and still picked after a reload. */
  const pickModel = async (label, key) => {
    await openStudy();
    await turbulence.selectOption({ label });
    await expect.poll(async () => (await simNow()).turbulence_model, { timeout: 15_000 }).toBe(key);
    await reload();
    await openStudy();
    await expect(turbulence.locator('option:checked')).toHaveText(label, { timeout: 15_000 });
  };
  /** The velocity inlet in the BC editor (from the BC hub). */
  const openInlet = async () => {
    const row = page.locator('#left-tree [data-w19-bcs="1"] > .tree-row .tl').first();
    await row.click();
    const shown = await hub.waitFor({ state: 'visible', timeout: 3000 }).then(
      () => true,
      () => false,
    );
    if (!shown) await row.click();
    await expect(hub).toBeVisible();
    await hub.locator(`[data-open-bc="${inletId}"]`).click();
    await expect(editor).toHaveAttribute('data-bc-id', inletId);
  };

  await openProject();
  await openStudy();
  await expect(turbulence.locator('option')).toHaveText([
    'Laminar',
    'Spalart-Allmaras (one equation)',
    'k-epsilon',
    'Realizable k-epsilon',
    'k-omega SST',
    'LRR (Reynolds stress)',
    'SSG (Reynolds stress)',
  ]);
  await studyPanel.locator('[data-schema-key="turbulence_model"] .mat-k').hover();
  await expect(studyPanel.locator('[data-schema-key="turbulence_model"] [role="tooltip"]')).toContainText(
    'Spalart-Allmaras solves one equation and suits flow around wings and bodies in a freestream',
  );

  // Spalart-Allmaras: the inlet's choices name the ratio setting without an intensity.
  await pickModel('Spalart-Allmaras (one equation)', 'SpalartAllmaras');
  await openInlet();
  await expect(field('Turbulence at the inlet').locator('option')).toHaveText(['Auto', 'Intensity and length scale', 'Viscosity ratio']);
  await expect(field('Turbulence at the inlet')).toHaveValue('Auto');
  await expect(hint).toHaveText(
    "Auto: ν̃ (modified turbulent viscosity) = 3 × the fluid's viscosity, a calm inflow (3 to 5 × is usual for external flow).",
  );
  await field('Turbulence at the inlet').selectOption({ label: 'Viscosity ratio' });
  await expect(field('Viscosity ratio')).toBeVisible();
  await expect(field('Turbulence intensity')).toHaveCount(0);
  await expect(hint).toContainText("from a turbulent viscosity this many times the fluid's");
  await field('Viscosity ratio').fill('4');
  await field('Viscosity ratio').press('Enter');
  await expect
    .poll(async () => {
      const b = await savedInlet();
      return [b.turbulence_spec, b.turbulence_viscosity_ratio];
    })
    .toEqual(['Intensity and viscosity ratio', 4]);
  await reload();
  await openInlet();
  await expect(field('Turbulence at the inlet').locator('option:checked')).toHaveText('Viscosity ratio');
  await expect(field('Viscosity ratio')).toHaveValue('4');
  await expect(field('Turbulence intensity')).toHaveCount(0);

  // Realizable k-epsilon: the same setting is k-epsilon's, with its intensity.
  await pickModel('Realizable k-epsilon', 'realizableKE');
  await openInlet();
  await expect(field('Turbulence at the inlet').locator('option')).toHaveText([
    'Auto',
    'Intensity and length scale',
    'Intensity and viscosity ratio',
  ]);
  await expect(field('Turbulence at the inlet')).toHaveValue('Intensity and viscosity ratio');
  await expect(field('Turbulence intensity')).toBeVisible();
  await expect(field('Viscosity ratio')).toHaveValue('4');
  await expect(hint).toContainText('k from the intensity of');

  // Laminar: no turbulence rows at all.
  await pickModel('Laminar', 'laminar');
  await openInlet();
  await expect(editor.locator('[data-bc-turbulence="1"]')).toHaveCount(0);
  await expect(field('Turbulence at the inlet')).toHaveCount(0);
});
