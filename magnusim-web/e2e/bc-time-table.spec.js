import { expect, test } from '@playwright/test';
import { startHost } from './support/host-server.mjs';

// "Varies with time" on a velocity inlet (Incompressible Flow, F12): a steady
// study does not offer it; on a transient study's inlet the switch starts a
// table at the fixed value, rows are edited, added and saved with what
// happens after the last row, a table the run would refuse says why, the hub
// card says it follows the table and gives the table's range, and after a reload
// the panel shows the saved rows. Its own server (own projects copy).
// No WSL: nothing is solved (the plugin's tests check the written case, and
// each table BC was run in OpenFOAM v2606).
const FIXTURE = 'sample-project-steady-state-e2e';
let host;

test.beforeAll(async () => {
  host = await startHost({ name: 'bc-time-table' });
});

test.afterAll(() => {
  if (host) host.stop();
});

async function openProject(page) {
  await page.goto(`${host.base}/#/p/${FIXTURE}`);
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, FIXTURE, { timeout: 90_000 });
}

test('a transient inlet keeps its time table after a reload; a steady study offers none', async ({ page, request }) => {
  test.setTimeout(300_000);
  const picker = page.locator('#panel-bc-picker .cfd-island');
  const editor = page.locator('#panel-bc-editor .cfd-island [data-bc-editor="1"]');
  const hub = page.locator('#panel-bcs-hub .cfd-island');
  const field = (label) => editor.getByLabel(label, { exact: true });
  const type = async (label, value) => {
    await field(label).fill(String(value));
    await field(label).press('Enter');
  };
  let sim = null;
  const saved = async (id) => {
    const url = `${host.base}/api/bcs?project_id=${FIXTURE}&simulation_id=${encodeURIComponent(sim)}`;
    const list = (await (await request.get(url)).json()).boundary_conditions || [];
    return list.find((b) => b.id === id) || {};
  };

  /** The active study's Boundary conditions node (each study in the tree has one). */
  const bcsNode = () => page.locator(`#left-tree [data-w17-sim-id="${sim}"] [data-w19-bcs="1"]`).first();

  /** Pick a type in the "+" picker, Add it, and wait for its editor; its id. */
  const add = async (key, title) => {
    await bcsNode().locator('.bc-plus').first().click();
    await expect(picker).toBeVisible();
    await picker.locator(`[data-bc-key="${key}"]`).click();
    await picker.locator('[data-bc-add="1"]').click();
    await expect(editor.locator('[data-bc-title="1"]')).toHaveText(new RegExp(`^${title} \\d+$`), { timeout: 15_000 });
    const id = await editor.getAttribute('data-bc-id');
    expect(id).toBeTruthy();
    await expect.poll(async () => (await saved(id)).id, { timeout: 15_000 }).toBe(id);
    return id;
  };

  /** Show the BC hub: the Boundary conditions row opens it, or first closes an open BC panel. */
  const showHub = async () => {
    const row = bcsNode().locator(':scope > .tree-row .tl').first();
    await row.click();
    const shown = await hub.waitFor({ state: 'visible', timeout: 3000 }).then(() => true, () => false);
    if (!shown) await row.click();
    await expect(hub).toBeVisible();
  };

  await openProject(page);
  sim = await page.evaluate(() => window.__CFD_W17__.activeId);

  // The fixture's study is steady: its inlet has a fixed value and no table.
  const steadyInlet = await add('velocity_inlet', 'Velocity inlet');
  await expect(field('Velocity')).toHaveValue('5');
  await expect(field('Varies with time')).toHaveCount(0);
  expect((await saved(steadyInlet)).time_varying).toBeUndefined();

  // A transient study.
  await page.locator('#btn-create-simulation').click();
  await page.locator('#cs-time-dep [data-time-dep="Transient"]').click();
  await page.locator('#cs-create').click();
  await expect(page.locator('#modal-create-simulation')).toBeHidden({ timeout: 30_000 });
  await expect.poll(() => page.evaluate(() => window.__CFD_W17__.activeId)).not.toBe(sim);
  sim = await page.evaluate(() => window.__CFD_W17__.activeId);

  const inlet = await add('velocity_inlet', 'Velocity inlet');
  await expect(field('Velocity')).toHaveValue('5');
  // On: the table starts at the fixed value, and replaces it.
  await editor.locator('[data-bc-time-varying="1"] label').click();
  await expect(field('Varies with time')).toBeChecked();
  await expect(field('Velocity')).toHaveCount(0);
  await expect(field('Row 2 value')).toHaveValue('5');
  await expect
    .poll(async () => {
      const b = await saved(inlet);
      return [b.time_varying, b.time_table, b.time_table_unit];
    })
    .toEqual([true, [[0, 5], [1, 5]], 'm/s']);

  // Edit rows, add one, repeat the table after its last row.
  await type('Row 2 time', 0.5);
  await expect.poll(async () => (await saved(inlet)).time_table).toEqual([[0, 5], [0.5, 5]]);
  await type('Row 2 value', 8);
  await expect.poll(async () => (await saved(inlet)).time_table).toEqual([[0, 5], [0.5, 8]]);
  await editor.locator('[data-bc-time-add="1"]').click();
  await expect(field('Row 3 time')).toHaveValue('1');
  await type('Row 3 value', 2);
  await field('After the last point').selectOption('Repeat');
  await expect
    .poll(async () => {
      const b = await saved(inlet);
      return [b.time_table, b.time_after_last];
    })
    .toEqual([[[0, 5], [0.5, 8], [1, 2]], 'Repeat']);
  await expect(editor.locator('[data-bc-time-plot="1"] svg')).toBeVisible();

  // A table the run would refuse says why; fixing it clears the message.
  await type('Row 3 time', 0.5);
  await expect(editor.locator('[data-bc-time-problem="1"]')).toHaveText(
    'The times must increase from row to row (row 3 is at 0.5 s, not after 0.5 s).'
  );
  await type('Row 3 time', 1);
  await expect(editor.locator('[data-bc-time-problem="1"]')).toHaveCount(0);
  await expect.poll(async () => (await saved(inlet)).time_table).toEqual([[0, 5], [0.5, 8], [1, 2]]);

  // The hub card says the inlet follows its table, with the table's range (not the fixed 5 m/s).
  await showHub();
  await expect(hub.locator(`[data-open-bc="${inlet}"] .hub-item-sub`)).toHaveText(/^Velocity inlet · Varies with time, 2–8 m\/s · /);
  await expect(hub.locator(`[data-open-bc="${inlet}"] .hub-item-sub`)).not.toContainText('5 m/s');

  // After a reload the transient study's inlet shows its table.
  await page.reload();
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, FIXTURE, { timeout: 90_000 });
  expect(await page.evaluate(() => window.__CFD_W17__.activeId)).toBe(sim);
  await showHub();
  await hub.locator(`[data-open-bc="${inlet}"]`).click();
  await expect(editor).toHaveAttribute('data-bc-id', inlet);
  await expect(field('Varies with time')).toBeChecked();
  await expect(field('Row 1 time')).toHaveValue('0');
  await expect(field('Row 2 time')).toHaveValue('0.5');
  await expect(field('Row 2 value')).toHaveValue('8');
  await expect(field('Row 3 value')).toHaveValue('2');
  await expect(field('After the last point')).toHaveValue('Repeat');

  // Off again: the card names no table.
  await editor.locator('[data-bc-time-varying="1"] label').click();
  await expect(field('Velocity')).toHaveValue('5');
  await expect.poll(async () => (await saved(inlet)).time_varying).toBe(false);
  await showHub();
  await expect(hub.locator(`[data-open-bc="${inlet}"] .hub-item-sub`)).toHaveText(/^Velocity inlet · (?!Varies)/);
});
