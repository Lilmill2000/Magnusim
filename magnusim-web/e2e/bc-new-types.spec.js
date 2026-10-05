import { expect, test } from '@playwright/test';
import { startHost } from './support/host-server.mjs';

// Incompressible Flow's newer boundary conditions in the BC panel: picking each
// (Freestream, Total pressure inlet, Symmetry, a Moving and a Rotating wall)
// shows its own fields, an edit is saved, inlet turbulence settings and a
// velocity outlet's value are saved too, and after a reload each editor shows
// what was saved. The new types paint in their own colours. Its own server (own
// projects copy). No WSL: nothing is solved (the plugin's tests check the
// written case, and each type was run in OpenFOAM v2606).
const FIXTURE = 'sample-project-steady-state-e2e';
const SIM = 'sim_1';
const FREESTREAM_RGB = 'rgb(22, 163, 74)';
const SYMMETRY_RGB = 'rgb(8, 145, 178)';
let host;

test.beforeAll(async () => {
  host = await startHost({ name: 'bc-new-types' });
});

test.afterAll(() => {
  if (host) host.stop();
});

async function openProject(page) {
  await page.goto(`${host.base}/#/p/${FIXTURE}`);
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, FIXTURE, { timeout: 90_000 });
}

test('each new boundary condition shows its fields, saves them and keeps them after a reload', async ({ page, request }) => {
  test.setTimeout(300_000);
  const picker = page.locator('#panel-bc-picker .cfd-island');
  const editor = page.locator('#panel-bc-editor .cfd-island [data-bc-editor="1"]');
  const hub = page.locator('#panel-bcs-hub .cfd-island');
  const bcsNow = async () =>
    (await (await request.get(`${host.base}/api/bcs?project_id=${FIXTURE}&simulation_id=${SIM}`)).json()).boundary_conditions || [];
  const saved = async (id) => (await bcsNow()).find((b) => b.id === id) || {};
  const field = (label) => editor.getByLabel(label, { exact: true });
  const type = async (label, value) => {
    await field(label).fill(String(value));
    await field(label).press('Enter');
  };

  /** Pick a type in the "+" picker, Add it, and wait for its editor; its id. */
  const add = async (key, title) => {
    await page.locator('#left-tree [data-w19-bcs="1"] .bc-plus').first().click();
    await expect(picker).toBeVisible();
    await picker.locator(`[data-bc-key="${key}"]`).click();
    await picker.locator('[data-bc-add="1"]').click();
    await expect(editor.locator('[data-bc-title="1"]')).toHaveText(new RegExp(`^${title} \\d+$`), { timeout: 15_000 });
    const id = await editor.getAttribute('data-bc-id');
    expect(id).toBeTruthy();
    await expect.poll(async () => (await saved(id)).id, { timeout: 15_000 }).toBe(id);
    return id;
  };

  /** Open a saved BC from the hub. */
  const open = async (id) => {
    await page.locator('#left-tree [data-w19-bcs="1"] > .tree-row .tl').first().click();
    await expect(hub).toBeVisible();
    await hub.locator(`[data-open-bc="${id}"]`).click();
    await expect(editor).toHaveAttribute('data-bc-id', id);
  };

  await openProject(page);

  // The picker offers them with their hints.
  await page.locator('#left-tree [data-w19-bcs="1"] .bc-plus').first().click();
  await expect(picker.locator('[data-bc-key="freestream"] .ml-type-sub')).toHaveText(
    'Far field around a body: the undisturbed flow comes in or leaves'
  );
  await expect(picker.locator('[data-bc-key="total_pressure_inlet"] .ml-type-sub')).toHaveText(
    'Flow comes in, driven by a fixed total pressure'
  );
  await expect(picker.locator('[data-bc-key="symmetry"] .ml-type-sub')).toHaveText('Mirror plane: no flow through it, no friction');
  await picker.locator('button[aria-label="Close"]').click();

  // Freestream: speed, direction, gauge pressure, and its inlet turbulence.
  const far = await add('freestream', 'Freestream');
  await expect(field('Velocity given as')).toHaveValue('Speed and direction');
  await expect(field('Speed')).toHaveValue('10');
  await expect(field('Direction X')).toHaveValue('1');
  await expect(field('Freestream pressure')).toHaveValue('0');
  await expect(field('Turbulence at the inlet')).toHaveValue('Auto');
  await expect(editor.locator('[data-bc-freestream-hint="1"]')).toContainText('The undisturbed flow far from the body');
  await type('Speed', 12);
  await type('Direction Y', 0.5);
  await type('Freestream pressure', 25);
  await field('Turbulence at the inlet').selectOption('Intensity and viscosity ratio');
  await expect(field('Viscosity ratio')).toBeVisible();
  await type('Turbulence intensity', 1);
  await type('Viscosity ratio', 7);
  await expect
    .poll(async () => {
      const b = await saved(far);
      return [b.value, b.vector, b.freestream_pressure, b.turbulence_spec, b.turbulence_intensity, b.turbulence_viscosity_ratio];
    })
    .toEqual([12, [1, 0.5, 0], 25, 'Intensity and viscosity ratio', 1, 7]);

  // Total pressure inlet: its total pressure and unit, and inlet turbulence.
  const intake = await add('total_pressure_inlet', 'Total pressure inlet');
  await expect(field('Total pressure unit')).toHaveValue('Pa');
  await expect(field('Turbulence at the inlet')).toBeVisible();
  await expect(editor.locator('[data-bc-total-pressure-hint="1"]')).toContainText('The total pressure (gauge)');
  await type('Total pressure', 250);
  await expect.poll(async () => [(await saved(intake)).value, (await saved(intake)).unit]).toEqual([250, 'Pa']);

  // Symmetry: no settings, a line that says what it does.
  const mirror = await add('symmetry', 'Symmetry');
  await expect(editor.locator('[data-bc-symmetry-hint="1"]')).toContainText('A mirror plane: no flow crosses it');
  await expect(field('Turbulence at the inlet')).toHaveCount(0);
  expect((await saved(mirror)).bc_type).toBe('Symmetry');

  // A moving wall: its velocity.
  const belt = await add('wall', 'Wall');
  await field('Wall type').selectOption('Moving');
  await expect(field('Wall velocity X')).toHaveValue('1');
  await type('Wall velocity X', 2);
  await expect.poll(async () => [(await saved(belt)).wall_type, (await saved(belt)).wall_velocity]).toEqual(['Moving', [2, 0, 0]]);

  // A rotating wall: axis, origin and speed in rpm.
  const disc = await add('wall', 'Wall');
  await field('Wall type').selectOption('Rotating');
  await expect(field('Axis Z')).toHaveValue('1');
  await type('Origin Y', 0.1);
  await type('Rotation speed', 1500);
  await expect
    .poll(async () => {
      const b = await saved(disc);
      return [b.wall_type, b.rotation_axis, b.rotation_origin, b.rotation_speed];
    })
    .toEqual(['Rotating', [0, 0, 1], [0, 0.1, 0], 1500]);

  // A velocity inlet's turbulence at the inlet; a velocity outlet's outflow.
  const inlet = await add('velocity_inlet', 'Velocity inlet');
  await field('Turbulence at the inlet').selectOption('Intensity and length scale');
  await type('Turbulence intensity', 3);
  await type('Length scale', 0.02);
  await expect
    .poll(async () => {
      const b = await saved(inlet);
      return [b.turbulence_spec, b.turbulence_intensity, b.turbulence_length_scale];
    })
    .toEqual(['Intensity and length scale', 3, 0.02]);
  const vent = await add('velocity_outlet', 'Velocity outlet');
  await expect(editor.locator('[data-bc-velocity-hint="1"]')).toHaveText('Air leaves straight out through the face at this speed.');
  await expect(field('Turbulence at the inlet')).toHaveCount(0);
  await type('Velocity', 3);
  await expect.poll(async () => (await saved(vent)).value).toBe(3);

  // The hub's cards show the new colours.
  await page.locator('#left-tree [data-w19-bcs="1"] > .tree-row .tl').first().click();
  await expect(hub).toBeVisible();
  const swatch = (id) => hub.locator(`[data-open-bc="${id}"] .hub-swatch`).evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(await swatch(far)).toBe(FREESTREAM_RGB);
  expect(await swatch(mirror)).toBe(SYMMETRY_RGB);
  await expect(hub.locator(`[data-open-bc="${belt}"] .hub-item-sub`)).toHaveText(/^Wall · Moving · /);

  // After a reload every editor shows what was saved.
  await page.reload();
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, FIXTURE, { timeout: 90_000 });
  await open(far);
  await expect(field('Speed')).toHaveValue('12');
  await expect(field('Direction Y')).toHaveValue('0.5');
  await expect(field('Freestream pressure')).toHaveValue('25');
  await expect(field('Turbulence at the inlet')).toHaveValue('Intensity and viscosity ratio');
  await expect(field('Viscosity ratio')).toHaveValue('7');
  await open(intake);
  await expect(field('Total pressure')).toHaveValue('250');
  await open(mirror);
  await expect(editor.locator('[data-bc-symmetry-hint="1"]')).toBeVisible();
  await open(belt);
  await expect(field('Wall type')).toHaveValue('Moving');
  await expect(field('Wall velocity X')).toHaveValue('2');
  await open(disc);
  await expect(field('Wall type')).toHaveValue('Rotating');
  await expect(field('Origin Y')).toHaveValue('0.1');
  await expect(field('Rotation speed')).toHaveValue('1500');
  await open(inlet);
  await expect(field('Turbulence at the inlet')).toHaveValue('Intensity and length scale');
  await expect(field('Length scale')).toHaveValue('0.02');
  await open(vent);
  await expect(field('Velocity')).toHaveValue('3');
});
