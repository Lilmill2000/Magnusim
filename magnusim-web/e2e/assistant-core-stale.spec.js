// What the Assistant changes shows in the open workbench, and a person's save made from an older
// copy is refused rather than written over it (Assistant phase 5, C2; spec 06 §6.5).
//
// The Assistant's write is the route a host tool calls (POST /api/bcs, materials.set, POST
// /api/mesh, with the rev it read as base_rev), then the frame a tool emits after it
// (MAGNUSIM_TEST_UI_SYNC's POST /api/test/ui-sync, what uiSync.emit sends). Each case asserts
// what the person sees:
// - with the panel open and nothing unsaved, the panel shows the new value without a reload;
// - an unsaved edit in the focused field stays while the change lands, and committing it then is
//   the person's later edit: it is saved;
// - a commit already on its way (held in the page) when the Assistant wrote is refused: the
//   "Not saved: changed elsewhere" notice names the Assistant (another window when this window
//   heard no write), the panel shows the saved values, and the server keeps the Assistant's;
// - the Mesh panel shows a later change to a setting the person edited and saved earlier in
//   the same panel (finding 7: it kept showing the person's old value);
// - the dock's step says "Updated: Boundary conditions (…)" under the call that wrote.
// Its own server (own projects copy, the test switches); no WSL.
// SPDX-License-Identifier: GPL-3.0-or-later
import { dockSend, openDock, useScriptedModel } from './support/assistant.js';
import { startFakeLlm } from './support/fake-llm.mjs';
import { startHost } from './support/host-server.mjs';
import { expect, test } from './support/stress.js';

const FIXTURE = 'sample-project-steady-state-e2e';
const SIM = 'sim_1';
const NOTICE_TITLE = 'Not saved: changed elsewhere';
const TAIL = 'Your change was not saved. The panel now shows the saved values. Make your change again if you still want it.';

let host;
let fake;
let n = 0;

const api = (path) => `${host.base}${path}`;
const q = (extra = {}) => new URLSearchParams({ project_id: FIXTURE, simulation_id: SIM, ...extra }).toString();

async function postOk(request, path, data) {
  const r = await request.post(api(path), { data });
  const j = await r.json().catch(() => ({}));
  expect(r.ok(), `${path}: ${r.status()} ${JSON.stringify(j)}`).toBe(true);
  return j;
}

async function getJson(request, path) {
  const r = await request.get(api(path));
  expect(r.ok(), path).toBe(true);
  return r.json();
}

test.beforeAll(async () => {
  test.setTimeout(240_000);
  fake = await startFakeLlm();
  host = await startHost({
    name: 'core-stale',
    // A run's Cores offers 1 up to 3 here (the run case picks 2).
    prefs: { hardware: { n_procs: 3 } },
    env: {
      MAGNUSIM_TEST_UI_SYNC: '1',
      MAGNUSIM_TEST_EVENT_HUB: '1',
      MAGNUSIM_TEST_ASSISTANT: '1',
      MAGNUSIM_TEST_ASSISTANT_PROVIDER_URL: fake.base,
    },
  });
});

test.afterAll(async () => {
  if (host) host.stop();
  if (fake) await fake.stop();
});

/** The project open in the workbench, its `ui` channel on the server; resolves to the syncs applied so far. */
async function openProject(page, request) {
  await page.goto(api(`/#/p/${FIXTURE}`));
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, FIXTURE, { timeout: 90_000 });
  await expect
    .poll(async () => Object.values((await getJson(request, '/api/test/event-hub')).tabs || {}).some((t) => (t.kinds?.ui || 0) > 0), {
      message: "the window follows the project's ui channel",
      timeout: 30_000,
    })
    .toBe(true);
}

const syncsApplied = (page) => page.evaluate(() => window.__CFD_UI_SYNCS__ || 0);

/** Waits until the window applied one more sync than `before`. */
async function syncLanded(page, before) {
  await page.waitForFunction((b) => (window.__CFD_UI_SYNCS__ || 0) > b, before, { timeout: 15_000 });
}

/** What a host tool emits after its write. */
function emit(request, body) {
  return postOk(request, '/api/test/ui-sync', { project_id: FIXTURE, simulation_id: SIM, by: 'assistant', tool: 'setup_edit', revs: {}, ...body });
}

// ---------------------------------------------------------------- boundary conditions

const editor = (page) => page.locator('#panel-bc-editor .cfd-island [data-bc-editor="1"]');

/** A new Velocity inlet BC of its own: its id and name. */
async function newBc(request) {
  n += 1;
  const name = `Inlet ${n}`;
  const j = await postOk(request, '/api/bcs', { project_id: FIXTURE, simulation_id: SIM, name, bc_type: 'Velocity Inlet', value: 5, faces: [] });
  return { id: j.bc.id, name };
}

async function storedBc(request, id) {
  return (await getJson(request, `/api/bcs?${q()}`)).boundary_conditions.find((b) => b.id === id);
}

/** The Assistant writes the BC's value through the route (with the rev it read), then says so. */
async function aiWritesBc(request, bc, value, { heard = true } = {}) {
  const now = await storedBc(request, bc.id);
  const j = await postOk(request, '/api/bcs', { project_id: FIXTURE, simulation_id: SIM, id: bc.id, name: bc.name, bc_type: now.bc_type, value, base_rev: now.rev });
  if (heard) await emit(request, { kinds: ['bcs'], ids: { bc: [bc.id] }, revs: { [bc.id]: j.bc.rev }, names: { [bc.id]: bc.name } });
  return j.bc.rev;
}

async function openBc(page, id) {
  await page.evaluate((x) => window.__CFD_OPEN_BC__(x), id);
  await expect(editor(page)).toHaveAttribute('data-bc-id', id);
}

/** The BC editor's value field (a Velocity inlet's Velocity). */
const valueField = (page) => editor(page).getByRole('textbox', { name: 'Velocity', exact: true });

test.describe('a boundary condition open in its panel', () => {
  test('with nothing unsaved, the panel shows what the Assistant wrote without a reload', async ({ page, request }) => {
    const bc = await newBc(request);
    await openProject(page, request);
    await openBc(page, bc.id);
    await expect(valueField(page)).toHaveValue('5');
    const before = await syncsApplied(page);
    await aiWritesBc(request, bc, 10);
    await syncLanded(page, before);
    await expect(valueField(page)).toHaveValue('10');
    await expect(page.locator('#modal-confirm')).toBeHidden();
  });

  test('an unsaved edit in the focused field stays while the change lands; committing it then saves it', async ({ page, request }) => {
    const bc = await newBc(request);
    await openProject(page, request);
    await openBc(page, bc.id);
    await expect(valueField(page)).toHaveValue('5');
    await valueField(page).fill('12');
    const before = await syncsApplied(page);
    await aiWritesBc(request, bc, 10);
    await syncLanded(page, before);
    await expect(valueField(page)).toHaveValue('12');
    // The person commits after the Assistant's change landed: a later edit of theirs, saved.
    await valueField(page).press('Enter');
    await expect.poll(async () => Number((await storedBc(request, bc.id)).value), { timeout: 15_000 }).toBe(12);
    await expect(page.locator('#modal-confirm')).toBeHidden();
  });

  for (const heard of [true, false]) {
    test(`a commit on its way when ${heard ? 'the Assistant' : 'another window'} wrote is refused, with the notice, and the panel shows the saved value`, async ({ page, request }) => {
      const bc = await newBc(request);
      await openProject(page, request);
      await openBc(page, bc.id);
      await expect(valueField(page)).toHaveValue('5');
      // Hold the person's save in the page until the Assistant has written.
      let release = () => {};
      const held = new Promise((r) => (release = r));
      let reached = () => {};
      const inHand = new Promise((r) => (reached = r));
      await page.route('**/api/worker', async (route) => {
        const body = route.request().postDataJSON();
        if (body && body.method === 'bcs.set') {
          reached();
          await held;
        }
        await route.continue();
      });
      await valueField(page).fill('12');
      await valueField(page).press('Enter');
      await inHand;
      const before = await syncsApplied(page);
      await aiWritesBc(request, bc, 10, { heard });
      if (heard) await syncLanded(page, before);
      release();
      const dialog = page.locator('#modal-confirm');
      await expect(dialog).toBeVisible({ timeout: 15_000 });
      await expect(page.locator('#cf-heading')).toHaveText(NOTICE_TITLE);
      await expect(page.locator('#cf-copy')).toHaveText(
        heard
          ? `The Assistant changed boundary condition "${bc.name}" while you were editing it. ${TAIL}`
          : `Boundary condition "${bc.name}" was changed in another window while you were editing it. ${TAIL}`,
      );
      await expect(page.locator('#cf-cancel')).toBeHidden();
      await expect(valueField(page)).toHaveValue('10');
      await page.locator('#cf-confirm').click();
      await expect(dialog).toBeHidden();
      // Nothing was written over the Assistant's value, and closing the notice saved nothing.
      await page.waitForTimeout(500);
      expect(Number((await storedBc(request, bc.id)).value)).toBe(10);
      await expect(valueField(page)).toHaveValue('10');
      await page.unroute('**/api/worker');
    });
  }
});

// ---------------------------------------------------------------- materials

const fluid = (page) => page.locator('#panel-air-material');
const nuField = (page) => fluid(page).getByLabel('Kinematic viscosity');

async function storedAir(request) {
  const j = await getJson(request, `/api/materials?${q()}`);
  return (j.materials || [])[0] || j.air;
}

async function aiWritesAir(request, nu, { heard = true } = {}) {
  const air = await storedAir(request);
  // Every key the record keeps the value under (the panel's materialRecord writes them all).
  const rec = { ...air, kinematic_viscosity: nu, nu, base_rev: air.rev ?? 0 };
  delete rec.rev;
  const j = await postOk(request, '/api/worker', {
    method: 'materials.set',
    params: { project_id: FIXTURE, sim_id: SIM, body: { materials: [rec], only_id: air.id, simulation_id: SIM } },
  });
  const saved = (j.materials || []).find((m) => m.id === air.id) || {};
  if (heard) await emit(request, { kinds: ['materials'], ids: { material: [air.id] }, revs: { [air.id]: saved.rev ?? 0 }, names: { [air.id]: air.name } });
  return air;
}

async function openFluid(page, request) {
  const air = await storedAir(request);
  await page.evaluate((id) => window.__CFD_OPEN_MATERIAL__ && window.__CFD_OPEN_MATERIAL__(id), air.id);
  await expect(nuField(page)).toBeVisible({ timeout: 15_000 });
  return air;
}

test.describe('the fluid open in its panel', () => {
  test('shows what the Assistant wrote; a commit on its way when it wrote is refused with the notice', async ({ page, request }) => {
    await openProject(page, request);
    const air = await openFluid(page, request);
    const before = await syncsApplied(page);
    await aiWritesAir(request, 2e-5);
    await syncLanded(page, before);
    await expect(nuField(page)).toHaveValue('2.0000e-5');

    // The person's commit, held until the Assistant wrote again.
    let release = () => {};
    const held = new Promise((r) => (release = r));
    let reached = () => {};
    const inHand = new Promise((r) => (reached = r));
    await page.route('**/api/worker', async (route) => {
      const body = route.request().postDataJSON();
      if (body && body.method === 'materials.set') {
        reached();
        await held;
      }
      await route.continue();
    });
    await nuField(page).fill('4e-5');
    await nuField(page).press('Enter');
    await inHand;
    const mid = await syncsApplied(page);
    await aiWritesAir(request, 3e-5);
    await syncLanded(page, mid);
    release();
    await expect(page.locator('#modal-confirm')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#cf-heading')).toHaveText(NOTICE_TITLE);
    await expect(page.locator('#cf-copy')).toHaveText(`The Assistant changed material "${air.name}" while you were editing it. ${TAIL}`);
    await expect(nuField(page)).toHaveValue('3.0000e-5');
    await page.locator('#cf-confirm').click();
    await page.waitForTimeout(500);
    expect((await storedAir(request)).kinematic_viscosity).toBe(3e-5);
    await page.unroute('**/api/worker');
  });
});

// ---------------------------------------------------------------- the mesh

const fineness = (page) => page.locator('#panel-mesh-form').getByRole('slider', { name: 'Fineness' });

async function storedMesh(request) {
  return (await getJson(request, `/api/mesh?${q({ mesh_id: 'mesh_1' })}`)).mesh;
}

async function aiWritesFineness(request, value, { heard = true } = {}) {
  const mesh = await storedMesh(request);
  const j = await postOk(request, '/api/mesh', { project_id: FIXTURE, simulation_id: SIM, mesh_id: mesh.id, fineness: value, base_rev: mesh.rev ?? 0 });
  if (heard) await emit(request, { kinds: ['mesh'], ids: { mesh: [mesh.id] }, revs: { [mesh.id]: j.rev }, names: { [mesh.id]: mesh.name } });
  return mesh;
}

async function openMeshForm(page) {
  await page.evaluate(() => window.__CFD_MESH_OPEN_SETTINGS__ && window.__CFD_MESH_OPEN_SETTINGS__('mesh_1'));
  await expect(fineness(page)).toBeVisible({ timeout: 15_000 });
}

test.describe('the mesh open in its panel', () => {
  test("shows a later change to a setting the person edited and saved earlier in the panel (finding 7), and refuses a stale commit", async ({ page, request }) => {
    await openProject(page, request);
    await openMeshForm(page);
    const start = Number(await fineness(page).inputValue());
    const mine = start === 3 ? 4 : 3;
    // The person's own edit, saved.
    await fineness(page).fill(String(mine));
    await expect.poll(async () => Number((await storedMesh(request)).settings.fineness), { timeout: 15_000 }).toBe(mine);
    // The Assistant sets it later: the panel shows its value, not the person's old one.
    const before = await syncsApplied(page);
    const mesh = await aiWritesFineness(request, 9);
    await syncLanded(page, before);
    await expect(fineness(page)).toHaveValue('9');

    // A commit on its way when the Assistant wrote again: refused, with the notice.
    let release = () => {};
    const held = new Promise((r) => (release = r));
    let reached = () => {};
    const inHand = new Promise((r) => (reached = r));
    let holding = true;
    await page.route('**/api/mesh', async (route) => {
      const body = route.request().method() === 'POST' ? route.request().postDataJSON() : null;
      if (holding && body && body.fineness === 2) {
        holding = false;
        reached();
        await held;
      }
      await route.continue();
    });
    await fineness(page).fill('2');
    await inHand;
    const mid = await syncsApplied(page);
    await aiWritesFineness(request, 6);
    await syncLanded(page, mid);
    release();
    await expect(page.locator('#modal-confirm')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#cf-copy')).toHaveText(`The Assistant changed mesh "${mesh.name}" while you were editing it. ${TAIL}`);
    await expect(fineness(page)).toHaveValue('6');
    await page.locator('#cf-confirm').click();
    await page.waitForTimeout(500);
    expect(Number((await storedMesh(request)).settings.fineness)).toBe(6);
    await page.unroute('**/api/mesh');
  });
});

// ---------------------------------------------------------------- a mesh refinement

const refSize = (page) => page.locator('#ref-default-size');

async function newRefinement(request) {
  n += 1;
  const name = `Ref ${n}`;
  const j = await postOk(request, '/api/mesh/refinements', { project_id: FIXTURE, simulation_id: SIM, name, type: 'Surface custom sizing', mesh_id: 'mesh_1', faces: [], default_size: 2 });
  return { id: j.refinement.id, name };
}

async function storedRef(request, id) {
  return (await getJson(request, `/api/mesh/refinements?${q()}`)).refinements.find((r) => r.id === id);
}

async function aiWritesRef(request, ref, size) {
  const now = await storedRef(request, ref.id);
  const j = await postOk(request, '/api/mesh/refinements', { project_id: FIXTURE, simulation_id: SIM, id: ref.id, default_size: size, base_rev: now.rev });
  await emit(request, { kinds: ['refinements'], ids: { refinement: [ref.id] }, revs: { [ref.id]: j.refinement.rev }, names: { [ref.id]: ref.name } });
}

test.describe('a mesh refinement open in its panel', () => {
  test('shows what the Assistant wrote; a change on its way when it wrote is refused with the notice', async ({ page, request }) => {
    const ref = await newRefinement(request);
    await openProject(page, request);
    await page.evaluate((r) => window.__CFD_SHOW_REF__({ ...r, type: 'Surface custom sizing', mesh_id: 'mesh_1' }), ref);
    await expect(refSize(page)).toBeVisible({ timeout: 15_000 });
    await expect(refSize(page)).toHaveValue('2');
    const before = await syncsApplied(page);
    await aiWritesRef(request, ref, 5);
    await syncLanded(page, before);
    await expect(refSize(page)).toHaveValue('5');

    let release = () => {};
    const held = new Promise((r) => (release = r));
    let reached = () => {};
    const inHand = new Promise((r) => (reached = r));
    let holding = true;
    await page.route('**/api/mesh/refinements', async (route) => {
      const body = route.request().method() === 'POST' ? route.request().postDataJSON() : null;
      if (holding && body && body.default_size === 3) {
        holding = false;
        reached();
        await held;
      }
      await route.continue();
    });
    await refSize(page).fill('3');
    await refSize(page).press('Tab');
    await inHand;
    const mid = await syncsApplied(page);
    await aiWritesRef(request, ref, 8);
    await syncLanded(page, mid);
    release();
    await expect(page.locator('#modal-confirm')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#cf-copy')).toHaveText(`The Assistant changed mesh refinement "${ref.name}" while you were editing it. ${TAIL}`);
    await expect(refSize(page)).toHaveValue('8');
    await page.locator('#cf-confirm').click();
    await page.waitForTimeout(800);
    expect((await storedRef(request, ref.id)).default_size).toBe(8);
    await expect(refSize(page)).toHaveValue('8');
    await page.unroute('**/api/mesh/refinements');
  });
});

// ---------------------------------------------------------------- a run

async function newRun(request) {
  n += 1;
  const name = `Run S${n}`;
  const j = await postOk(request, '/api/run/create', { project_id: FIXTURE, simulation_id: SIM, name });
  return { id: String(j.run_id || (j.run && (j.run.id || j.run.run_id))), name };
}

async function storedRun(request, id) {
  return (await getJson(request, `/api/run/status?${q()}`)).runs.find((r) => String(r.id) === id);
}

async function aiWritesCores(request, run, cores) {
  const now = await storedRun(request, run.id);
  const j = await postOk(request, '/api/run/update', { project_id: FIXTURE, simulation_id: SIM, run_id: run.id, cores, base_rev: now.rev });
  await emit(request, { kinds: ['runs'], ids: { run: [run.id] }, revs: { [run.id]: j.run.rev }, names: { [run.id]: run.name } });
}

async function openRun(page, rid) {
  const folder = page.locator(`#left-tree [data-w17-sim-id="${SIM}"] li[data-w27-sim-control="1"]`).first();
  if (!(await folder.evaluate((el) => el.classList.contains('expanded')))) await folder.locator(':scope > .tree-row .tw').click();
  await page.locator(`#left-tree [data-w27-run="${rid}"] > .tree-row .tl`).first().click();
  const runPanel = page.locator('#panel-sim-control .cfd-island [data-run-control="1"]');
  await expect(runPanel).toHaveAttribute('data-run-id', rid);
  return runPanel;
}

test.describe('a run open in its panel', () => {
  test('shows what the Assistant wrote; a choice on its way when it wrote is refused with the notice', async ({ page, request }) => {
    const run = await newRun(request);
    await openProject(page, request);
    const panel = await openRun(page, run.id);
    const cores = panel.getByLabel('Cores', { exact: true });
    await expect(cores).toHaveValue('auto');
    const before = await syncsApplied(page);
    await aiWritesCores(request, run, 1);
    await syncLanded(page, before);
    await expect(cores).toHaveValue('1');

    let release = () => {};
    const held = new Promise((r) => (release = r));
    let reached = () => {};
    const inHand = new Promise((r) => (reached = r));
    let holding = true;
    await page.route('**/api/run/update', async (route) => {
      const body = route.request().postDataJSON();
      if (holding && body && body.cores === 2) {
        holding = false;
        reached();
        await held;
      }
      await route.continue();
    });
    await cores.selectOption('2');
    await inHand;
    const mid = await syncsApplied(page);
    await aiWritesCores(request, run, null);
    await syncLanded(page, mid);
    release();
    await expect(page.locator('#modal-confirm')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#cf-copy')).toHaveText(`The Assistant changed run "${run.name}" while you were editing it. ${TAIL}`);
    await expect(cores).toHaveValue('auto');
    await page.locator('#cf-confirm').click();
    await page.waitForTimeout(500);
    expect((await storedRun(request, run.id)).cores ?? null).toBeNull();
    await page.unroute('**/api/run/update');
  });
});

// ---------------------------------------------------------------- boundary condition defaults

const wallType = (page) => page.locator('#bc-default-wall-type');

async function storedDefaults(request) {
  const j = await getJson(request, `/api/bcs?${q()}`);
  return { wall: j.defaults && j.defaults.wall_type, rev: j.defaults_rev };
}

/** Another window saves the study's wall default (with the rev it read, as a panel does). */
async function otherWindowSetsWall(request, wall) {
  const { rev } = await storedDefaults(request);
  await postOk(request, '/api/bcs', { project_id: FIXTURE, simulation_id: SIM, defaults: { wall_type: wall }, defaults_base_rev: rev });
}

test.describe('the boundary condition defaults panel', () => {
  test('a change made from an older copy is refused with the notice, the panel shows the saved default, and the next change is saved', async ({ page, request }) => {
    await otherWindowSetsWall(request, 'No-slip');
    await openProject(page, request);
    await page.evaluate(() => window.__CFD_BC_OPEN_DEFAULTS__());
    await expect(page.locator('#panel-bc-defaults')).toBeVisible();
    await expect(wallType(page)).toHaveValue('No-slip');
    // Another window changes them twice (this window hears nothing): the panel still shows its copy.
    const read = (await storedDefaults(request)).rev;
    await otherWindowSetsWall(request, 'Slip');
    await otherWindowSetsWall(request, 'No-slip');
    expect((await storedDefaults(request)).rev).toBe(read + 2);
    await expect(wallType(page)).toHaveValue('No-slip');
    // The person's change is from that older copy: refused, not written over the newer save.
    await wallType(page).selectOption('Slip');
    const dialog = page.locator('#modal-confirm');
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#cf-heading')).toHaveText(NOTICE_TITLE);
    await expect(page.locator('#cf-copy')).toHaveText(`The boundary condition defaults were changed in another window while you were editing them. ${TAIL}`);
    await expect(wallType(page)).toHaveValue('No-slip');
    await page.locator('#cf-confirm').click();
    await expect(dialog).toBeHidden();
    await page.waitForTimeout(500);
    expect(await storedDefaults(request)).toEqual({ wall: 'No-slip', rev: read + 2 });
    // The panel read them again: the person's next change is saved.
    await wallType(page).selectOption('Slip');
    await expect.poll(async () => (await storedDefaults(request)).wall, { timeout: 15_000 }).toBe('Slip');
    await expect(dialog).toBeHidden();
    await otherWindowSetsWall(request, 'No-slip');
  });
});

// ---------------------------------------------------------------- the dock

test.describe('the dock', () => {
  test('a call that changed the project says "Updated: …" under its step, and the open panel shows the change', async ({ page, request }) => {
    await postOk(request, '/api/test/assistant/reset', {});
    await useScriptedModel(request, host.base, fake, 'cloud');
    const bc = await newBc(request);
    await openProject(page, request);
    await openBc(page, bc.id);
    const before = await syncsApplied(page);
    // The model's call writes (as a setup tool does) and says so.
    await aiWritesBc(request, bc, 7, { heard: false });
    fake.reply({ tools: [{ name: 'test_ui_sync', input: { kind: 'bcs', record: 'bc', id: bc.id, name: bc.name } }] }, { text: 'Set to 7.' });
    await dockSend(page, 'Set the inlet to 7');
    await openDock(page);
    const step = page.locator('#assistant-dock [data-dock-step]').last();
    await expect(step.locator('[data-dock-updated]')).toHaveText(`Updated: Boundary conditions (${bc.name})`, { timeout: 30_000 });
    await syncLanded(page, before);
    await expect(valueField(page)).toHaveValue('7');
  });
});
