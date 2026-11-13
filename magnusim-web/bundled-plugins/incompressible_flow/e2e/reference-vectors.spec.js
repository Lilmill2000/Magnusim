import { expect, test } from '@playwright/test';
import { REFERENCE_PROJECT } from './seed.js';

// The study panel's Reference values: a centre of rotation and the drag and lift
// directions are lists of three numbers. Typed, they are saved on the study (SI), shown
// again after a reload and carried by a copy of the study; a reference value blanked is
// cleared (null clears a schema key).
// No WSL. Fails on the code before host API 1.8's study route: it kept scalars only, so
// a typed centre of rotation or direction reverted and never reached the case.
const PROJECT = REFERENCE_PROJECT;
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

const study = async (request, sid = SIM) =>
  (await getJson(request, `/api/simulation?project_id=${PROJECT}&simulation_id=${sid}`)).simulation || {};

async function openStudy(page, sid = SIM) {
  const panel = page.locator('#panel-study-settings .cfd-island');
  const row = page.locator(`#left-tree [data-w17-sim-id="${sid}"] > .tree-row`).first();
  if ((await page.evaluate(() => window.__CFD_W17__.activeId)) !== sid) {
    // Another study's panel may be open: this study first (its row opens its panel).
    await row.click();
    await expect.poll(() => page.evaluate(() => window.__CFD_W17__.activeId)).toBe(sid);
    await panel.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});
  }
  if (!(await panel.isVisible())) await row.click();
  await expect(panel).toBeVisible({ timeout: 30_000 });
  await expect(panel.locator('[data-study-reference="1"]')).toBeVisible();
  return panel;
}

async function type(box, text) {
  await box.fill(text);
  await box.press('Enter');
}

test('a centre of rotation and a drag direction are saved, shown after a reload and copied with the study; a blanked reference value is cleared', async ({
  page,
  request,
}) => {
  test.setTimeout(240_000);
  // A run again on the same project (--repeat-each) starts from no reference values.
  const reset = await request.post('/api/simulation/update', {
    data: { project_id: PROJECT, simulation_id: SIM, ref_cofr: null, ref_drag_dir: null, ref_lift_dir: null, ref_area: null },
  });
  expect(reset.ok(), await reset.text()).toBe(true);
  await page.goto(`/#/p/${encodeURIComponent(PROJECT)}`);
  await expect(page.locator('#app.workbench')).toBeVisible({ timeout: 60_000 });
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, PROJECT, { timeout: 60_000 });
  let panel = await openStudy(page);
  const cofr = (p, axis) => p.getByLabel(`Centre of rotation ${axis}`, { exact: true });
  const drag = (p, axis) => p.getByLabel(`Drag direction ${axis}`, { exact: true });

  // Typed in mm (the project's lengths), saved in m.
  await type(cofr(panel, 'X'), '250');
  await expect.poll(async () => (await study(request)).ref_cofr).toEqual([0.25, 0, 0]);
  // On a slow machine X's save can redraw the panel after Z is typed and before its
  // Enter, putting Z back to 0 (seen on GitHub CI, 2026-11-13; a known bug to fix after
  // v0.5.0): type Z again until it is the saved value.
  await expect(async () => {
    await type(cofr(panel, 'Z'), '-10');
    await expect.poll(async () => (await study(request)).ref_cofr, { timeout: 3_000 }).toEqual([0.25, 0, -0.01]);
  }).toPass({ timeout: 30_000 });
  await type(drag(panel, 'Y'), '1');
  await expect.poll(async () => (await study(request)).ref_drag_dir).toEqual([0, 1, 0]);

  await page.reload();
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, PROJECT, { timeout: 60_000 });
  panel = await openStudy(page);
  await expect(cofr(panel, 'X')).toHaveValue('250');
  await expect(cofr(panel, 'Y')).toHaveValue('0');
  await expect(cofr(panel, 'Z')).toHaveValue('-10');
  await expect(drag(panel, 'Y')).toHaveValue('1');

  // A copy of the study (its settings) carries them.
  await page.locator('#btn-create-simulation').click();
  await expect(page.locator('#modal-create-simulation')).toBeVisible();
  await page.locator('#cs-copy-from').selectOption(SIM);
  await page.locator('#cs-copy-mode [data-copy-mode="settings"]').click();
  await page.locator('#cs-create').click();
  await expect(page.locator('#modal-create-simulation')).toBeHidden({ timeout: 30_000 });
  if (await page.locator('#modal-confirm').isVisible()) await page.locator('#cf-confirm').click();
  const copySid = await page.evaluate(() => window.__CFD_W17__.activeId);
  expect(copySid).not.toBe(SIM);
  const copied = await study(request, copySid);
  expect([copied.ref_cofr, copied.ref_drag_dir]).toEqual([[0.25, 0, -0.01], [0, 1, 0]]);
  const copyPanel = await openStudy(page, copySid);
  await expect(cofr(copyPanel, 'X')).toHaveValue('250');

  // A reference value blanked is cleared (the panel saves null): the area, typed then blanked.
  panel = await openStudy(page);
  const area = panel.getByLabel('Reference area', { exact: true });
  await type(area, '0.5');
  await expect.poll(async () => typeof (await study(request)).ref_area).toBe('number');
  await type(area, '');
  await expect.poll(async () => 'ref_area' in (await study(request))).toBe(false);
  await page.reload();
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, PROJECT, { timeout: 60_000 });
  panel = await openStudy(page);
  await expect(panel.getByLabel('Reference area', { exact: true })).toHaveValue('');
  await expect(cofr(panel, 'X')).toHaveValue('250');
  await expect(drag(panel, 'Y')).toHaveValue('1');
});
