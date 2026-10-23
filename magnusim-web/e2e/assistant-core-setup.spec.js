// The Assistant sets up a study in the workbench through its host tools (core host tools spec
// 4.9, 4.10, 16.3): from the dock, the scripted model makes a study, puts a material on both
// bodies and a velocity inlet on an outside face; the window shows the new study, its material
// and its BC. A BC on the face the two bodies share is refused, and the dock's step says why.
// Then the model deletes the BC: the person is asked first (a "Can't be undone" question), and
// after Allow the BC is gone from the study. A Don't leaves it there.
//
// The page shows what the AI changed after a reload here: the live reload of an open window
// (ui_sync) comes with its own lane, and these reloads go when it lands.
// Its own server with the Assistant's test switches and the scripted model
// (support/fake-llm.mjs). No WSL.
// SPDX-License-Identifier: GPL-3.0-or-later
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dockGate, dockSend, dockTurn, openDock, resultsIn, useScriptedModel } from './support/assistant.js';
import { startFakeLlm } from './support/fake-llm.mjs';
import { startHost } from './support/host-server.mjs';
import { expect, test } from './support/stress.js';

const HERE = dirname(fileURLToPath(import.meta.url));
// Two boxes that share the face x = 10 mm (face 2@Body1 and face 7@Body2).
const SHARED = join(HERE, '..', 'python', 'tests', 'fixtures', 'geometry', 'two-boxes-shared-face.brep');
const STEP = { timeout: 30_000 };

let host;
let fake;
let project;

const api = (path) => `${host.base}${path}`;

async function postOk(request, path, data = {}) {
  const r = await request.post(api(path), { data });
  const j = await r.json().catch(() => ({}));
  expect(r.ok(), `${path}: ${r.status()} ${JSON.stringify(j)}`).toBe(true);
  return j;
}

async function getJson(request, path) {
  const r = await request.get(api(path));
  expect(r.status(), path).toBe(200);
  return r.json();
}

test.beforeAll(async ({ request }) => {
  test.setTimeout(300_000);
  fake = await startFakeLlm();
  host = await startHost({
    name: 'assistant-core-setup',
    env: { MAGNUSIM_TEST_ASSISTANT: '1', MAGNUSIM_TEST_ASSISTANT_PROVIDER_URL: fake.base, MAGNUSIM_TEST_EVENT_HUB: '1' },
  });
  project = (await postOk(request, '/api/project', { title: 'Setup by the Assistant', folder: 'My Projects', units: 'Metric', category: 'Other' })).id;
  await postOk(request, '/api/geometry/import', { project_id: project, step_path: SHARED });
  // The face table (which faces the bodies share) is ready before the model reads it.
  await expect
    .poll(async () => {
      const r = await request.get(api(`/api/geometry/cad?project_id=${project}&part=meta`));
      return r.status() === 200 ? ((await r.json()).faces || []).length : 0;
    }, { timeout: 120_000 })
    .toBeGreaterThan(0);
});

test.afterAll(async () => {
  if (host) host.stop();
  if (fake) await fake.stop();
});

test.beforeEach(async ({ request, page }) => {
  await postOk(request, '/api/test/assistant/reset', {});
  await useScriptedModel(request, host.base, fake, 'cloud');
  await page.setViewportSize({ width: 1280, height: 800 });
});

test.afterEach(() => {
  expect(fake.pending(), 'scripted answers left unused').toBe(0);
});

const tree = (page) => page.locator('#left-tree');

async function openProject(page) {
  // A second open is a reload: the same address with a new hash would keep the page as it was.
  if (page.url() === api(`/#/p/${project}`)) await page.reload();
  else await page.goto(api(`/#/p/${project}`));
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, project, { timeout: 60_000 });
  await openDock(page);
}

const setup = (o) => ({ project_id: '', simulation_id: '', kind: '', action: '', id: '', other_id: '', name: '', type: '', faces: [], bodies: [], values: [], rev: 0, ...o });

test('the Assistant makes a study, a material on both bodies and an inlet; the window shows them; the shared face is refused with why', async ({ page, request }) => {
  test.setTimeout(240_000);
  await openProject(page);
  fake.reply(
    {
      text: 'Making the study.',
      tools: [{ name: 'study_edit', input: { project_id: '', action: 'create', id: '', ids: [], analysis: 'incompressible_steady', geometry_id: '', copy_from: '', copy_mode: '', time_dependency: 'steady', name: 'Pipe flow', plugin: '', kind: '', values: [] } }],
    },
    { tools: [{ name: 'setup_edit', input: setup({ kind: 'material', action: 'add', type: 'water', bodies: ['Body1', 'Body2'] }) }] },
    { tools: [{ name: 'setup_edit', input: setup({ kind: 'bc', action: 'add', type: 'Velocity inlet', name: 'Inlet', faces: ['face 1@Body1'], values: [{ key: 'value', value: '3' }] }) }] },
    { tools: [{ name: 'setup_edit', input: setup({ kind: 'bc', action: 'add', type: 'Wall', name: 'Divider', faces: ['face 2@Body1'] }) }] },
    { text: 'The study is set up.' },
  );
  await dockSend(page, 'Set up a pipe flow study with water');
  await expect(dockTurn(page).locator('[data-turn-end="done"]')).toBeVisible({ timeout: 120_000 });

  // What the tools answered.
  const chats = fake.requests().filter((r) => r.kind === 'chat');
  const [created] = resultsIn(chats.at(-4));
  expect(created.ok, JSON.stringify(created)).toBe(true);
  const study = created.data.ids.study;
  expect(created.data.ids.run).toBeTruthy();
  expect(resultsIn(chats.at(-3))[0].ok).toBe(true);
  expect(resultsIn(chats.at(-2))[0].ok).toBe(true);
  const refused = resultsIn(chats.at(-1))[0];
  expect([refused.ok, refused.error.code]).toEqual([false, 'inside_face']);
  // The dock's step says why.
  await expect(dockTurn(page)).toContainText('A face two bodies share is inside the model');

  // The records are saved where the panels read them.
  const sims = await getJson(request, `/api/simulation?project_id=${project}`);
  expect(sims.active_id).toBe(study);
  expect(sims.simulations.find((s) => s.id === study).name).toBe('Pipe flow');
  const mats = await getJson(request, `/api/materials?project_id=${project}&simulation_id=${study}`);
  expect(mats.materials.map((m) => [m.name, m.assigned_volumes])).toEqual([['Water', ['Body1', 'Body2']]]);
  const bcs = await getJson(request, `/api/bcs?project_id=${project}&simulation_id=${study}`);
  expect(bcs.boundary_conditions.map((b) => [b.name, b.bc_type, b.faces, b.value])).toEqual([['Inlet', 'Velocity inlet', ['face 1@Body1'], 3]]);

  // The window shows them (after a reload until the open window's live reload lands).
  await openProject(page);
  await expect(tree(page)).toContainText('Pipe flow', STEP);
  await expect(tree(page)).toContainText('Inlet', STEP);
  await expect(tree(page)).toContainText('Water', STEP);
  await expect(tree(page)).not.toContainText('Divider');
});

test('a delete asks first: Don\'t leaves the BC, Allow removes it from the study', async ({ page, request }) => {
  test.setTimeout(240_000);
  // Its own study and inlet, made through the routes (whatever the first test left).
  const study = (await postOk(request, '/api/simulation', { project_id: project, analysis_type: 'incompressible_steady', activate: true })).simulation.id;
  await postOk(request, '/api/simulation/update', { project_id: project, simulation_id: study, name: 'Delete test' });
  const inlet = (await postOk(request, '/api/bcs', { project_id: project, simulation_id: study, name: 'Inlet', bc_type: 'Velocity inlet', faces: ['face 1@Body1'] })).bc;
  await openProject(page);
  const del = { name: 'delete', input: { project_id: '', simulation_id: '', kind: 'bc', id: inlet.id, sub_id: '' } };

  fake.reply({ tools: [del] }, { text: 'Left it.' });
  await dockSend(page, 'Delete the inlet');
  const gate = dockGate(page);
  await expect(gate).toBeVisible(STEP);
  // The card names the item and what goes with it (the tool's own words, spec 14.2).
  await expect(gate.locator('.dock-gate-title')).toHaveText('Allow the Assistant to delete boundary condition "Inlet"?');
  await expect(gate.locator('.dock-gate-copy')).toContainText('Face 1 becomes unassigned.');
  await expect(gate).toContainText("Can't be undone");
  await gate.locator('[data-gate-answer="no"]').click();
  await expect(dockTurn(page).locator('[data-turn-end="done"]')).toBeVisible(STEP);
  expect((await getJson(request, `/api/bcs?project_id=${project}&simulation_id=${study}`)).boundary_conditions.map((b) => b.name)).toEqual(['Inlet']);

  fake.reply({ tools: [del] }, { text: 'Deleted.' });
  await dockSend(page, 'Delete the inlet, really');
  await expect(dockGate(page)).toBeVisible(STEP);
  await dockGate(page).locator('[data-gate-answer="yes"]').click({ timeout: 15_000 });
  await expect(dockTurn(page).locator('[data-turn-end="done"]')).toBeVisible(STEP);
  expect((await getJson(request, `/api/bcs?project_id=${project}&simulation_id=${study}`)).boundary_conditions).toEqual([]);
  await openProject(page);
  const row = tree(page).locator(`[data-w17-sim-id="${study}"]`).first();
  await expect(row).toContainText('Delete test', STEP);
  await expect(row).toContainText('Boundary conditions');
  await expect(row).not.toContainText('Inlet');
});

// A units change converts the values entered (spec 4.8): project_edit asks first, a "Can't be
// undone" card that says what converts; Don't leaves the units.
test("a units change asks first, naming what it converts; Don't leaves the units", async ({ page, request }) => {
  test.setTimeout(240_000);
  const study = (await postOk(request, '/api/simulation', { project_id: project, analysis_type: 'incompressible_steady', activate: true })).simulation.id;
  await postOk(request, '/api/bcs', { project_id: project, simulation_id: study, name: 'Inlet units', bc_type: 'Velocity inlet', faces: ['face 1@Body1'], value: 4 });
  await openProject(page);
  const all = (await getJson(request, `/api/bcs?project_id=${project}`)).boundary_conditions_all.length;
  fake.reply(
    { tools: [{ name: 'project_edit', input: { action: 'update', project_id: '', title: '', description: '', category: '', units: 'Imperial', folder: '', plugin: '', key: '' } }] },
    { text: 'Left the units.' },
  );
  await dockSend(page, 'Use US units');
  const gate = dockGate(page);
  await expect(gate).toBeVisible(STEP);
  await expect(gate.locator('.dock-gate-title')).toHaveText('Allow the Assistant to change the units of this project?');
  await expect(gate.locator('.dock-gate-copy')).toContainText(`Converts the values you entered in ${all} boundary condition${all === 1 ? '' : 's'}`);
  await expect(gate.locator('.dock-gate-copy')).toContainText('from Metric to US units. Results already computed are not converted.');
  await expect(gate).toContainText("Can't be undone");
  await gate.locator('[data-gate-answer="no"]').click();
  await expect(dockTurn(page).locator('[data-turn-end="done"]')).toBeVisible(STEP);
  expect((await getJson(request, `/api/project?project_id=${project}`)).project.units).toBe('Metric');
});
