import { expect, test } from '@playwright/test';
import { STUDY_START_PROJECT } from './seed.js';

// The study panel's starting flow and numerics rows (IF features F7, F9): each
// setting saves to the study, survives a reload and shows what the solve uses.
// No WSL: the written case is checked by the plugin's pytest.
const PROJECT = STUDY_START_PROJECT;
const SIM = 'sim_1';

async function getJson(request, url) {
  for (let i = 0; ; i++) {
    try {
      return await (await request.get(url)).json();
    } catch (e) {
      if (i >= 2 || !/ECONNRESET|socket hang up/i.test(String(e))) throw e;
    }
  }
}

async function openStudy(page) {
  await page.goto(`/#/p/${PROJECT}`);
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, PROJECT, { timeout: 60_000 });
  await page.locator(`#left-tree [data-w17-sim-id="${SIM}"] > .tree-row`).first().click();
  const panel = page.locator('#panel-study-settings .cfd-island');
  await expect(panel.locator('[data-study-panel="1"]')).toBeVisible({ timeout: 15_000 });
  return panel;
}

const simUrl = `/api/simulation?project_id=${PROJECT}&simulation_id=${SIM}`;

test('Numerics preset and SIMPLEC save, survive a reload, and SIMPLEC shows the relaxation it uses', async ({ page, request }) => {
  test.setTimeout(120_000);
  page.setDefaultTimeout(30_000);
  const sim = async () => (await getJson(request, simUrl)).simulation || {};
  let panel = await openStudy(page);

  const preset = panel.locator('[data-schema-key="numerics_preset"] select');
  await expect(preset.locator('option')).toHaveText(['Robust', 'Accurate']);
  await expect(preset.locator('option:checked')).toHaveText('Robust');
  await preset.selectOption({ label: 'Accurate' });
  await expect.poll(async () => (await sim()).numerics_preset).toBe('accurate');

  const simplec = panel.locator('[data-schema-key="simplec"] button');
  await expect(simplec).toHaveAttribute('aria-pressed', 'false');
  await expect(panel.locator('[data-schema-key="relax_u"]')).toBeVisible();
  await expect(panel.locator('[data-study-simplec-note]')).toHaveCount(0);
  await simplec.click();
  await expect.poll(async () => (await sim()).simplec).toBe(true);
  // The study's own relaxation is not what a SIMPLEC solve uses: its rows go and the note says what is used.
  await expect(panel.locator('[data-schema-key="relax_u"]')).toHaveCount(0);
  await expect(panel.locator('[data-schema-key="relax_p"]')).toHaveCount(0);
  await expect(panel.locator('[data-study-simplec-note]')).toHaveText(
    /SIMPLEC relaxes velocity and turbulence by 0\.9 and leaves pressure unrelaxed \(1\)/,
  );

  await page.reload();
  panel = await openStudy(page);
  await expect(panel.locator('[data-schema-key="numerics_preset"] select option:checked')).toHaveText('Accurate');
  await expect(panel.locator('[data-schema-key="simplec"] button')).toHaveAttribute('aria-pressed', 'true');
  await expect(panel.locator('[data-study-simplec-note]')).toBeVisible();
  await expect(panel.locator('[data-schema-key="relax_u"]')).toHaveCount(0);

  // Off again: the study's relaxation rows come back with their values.
  await panel.locator('[data-schema-key="simplec"] button').click();
  await expect.poll(async () => (await sim()).simplec).toBe(false);
  await expect(panel.locator('[data-schema-key="relax_u"]')).toBeVisible();
  await expect(panel.locator('[data-study-simplec-note]')).toHaveCount(0);
  await panel.locator('[data-schema-key="numerics_preset"] select').selectOption({ label: 'Robust' });
  await expect.poll(async () => (await sim()).numerics_preset).toBe('robust');
});

test('Starting flow, its custom velocity and the potential-flow start save and survive a reload', async ({ page, request }) => {
  test.setTimeout(120_000);
  page.setDefaultTimeout(30_000);
  const sim = async () => (await getJson(request, simUrl)).simulation || {};
  let panel = await openStudy(page);

  const start = panel.locator('[data-schema-key="initial_flow"] select');
  await expect(start.locator('option')).toHaveText(['Still', 'From the inlet', 'Custom']);
  await expect(start.locator('option:checked')).toHaveText('Still');
  // The components show only for a Custom start.
  await expect(panel.locator('[data-schema-key="initial_ux"]')).toHaveCount(0);
  await start.selectOption({ label: 'From the inlet' });
  await expect.poll(async () => (await sim()).initial_flow).toBe('inlet');
  await expect(panel.locator('[data-schema-key="initial_ux"]')).toHaveCount(0);

  await panel.locator('[data-schema-key="initial_flow"] select').selectOption({ label: 'Custom' });
  await expect.poll(async () => (await sim()).initial_flow).toBe('custom');
  const ux = panel.locator('[data-schema-key="initial_ux"]');
  await expect(ux).toBeVisible();
  await expect(panel.locator('[data-schema-key="initial_uy"]')).toBeVisible();
  await expect(panel.locator('[data-schema-key="initial_uz"]')).toBeVisible();
  // Typed in the project's velocity unit, saved in m/s.
  const unit = (await ux.locator('.bc-unit-label').textContent())?.trim();
  expect(['m/s', 'ft/s']).toContain(unit);
  const toSi = unit === 'ft/s' ? 0.3048 : 1;
  await ux.locator('input').fill('3');
  await ux.locator('input').press('Enter');
  const uz = panel.locator('[data-schema-key="initial_uz"] input');
  await uz.fill('-1.5');
  await uz.press('Enter');
  await expect.poll(async () => (await sim()).initial_ux).toBeCloseTo(3 * toSi, 6);
  await expect.poll(async () => (await sim()).initial_uz).toBeCloseTo(-1.5 * toSi, 6);

  // The potential-flow start: shown, off by default, saved when turned on.
  const potential = panel.locator('[data-schema-key="potential_flow"] button');
  await expect(panel.locator('[data-schema-key="potential_flow"]')).toContainText('Initialise with potential flow');
  await expect(potential).toHaveAttribute('aria-pressed', 'false');
  await potential.click();
  await expect.poll(async () => (await sim()).potential_flow).toBe(true);

  await page.reload();
  panel = await openStudy(page);
  await expect(panel.locator('[data-schema-key="initial_flow"] select option:checked')).toHaveText('Custom');
  await expect(panel.locator('[data-schema-key="initial_ux"] input')).toHaveValue('3');
  await expect(panel.locator('[data-schema-key="initial_uz"] input')).toHaveValue('-1.5');
  await expect(panel.locator('[data-schema-key="potential_flow"] button')).toHaveAttribute('aria-pressed', 'true');

  // Back to the defaults: a still start, no potential flow.
  await panel.locator('[data-schema-key="potential_flow"] button').click();
  await expect.poll(async () => (await sim()).potential_flow).toBe(false);
  await panel.locator('[data-schema-key="initial_flow"] select').selectOption({ label: 'Still' });
  await expect.poll(async () => (await sim()).initial_flow).toBe('still');
  await expect(panel.locator('[data-schema-key="initial_ux"]')).toHaveCount(0);
});
