// One approval for a declared chain (core host tools spec C3, 7.2, 14.2): the scripted model asks
// to mesh with `chain: ["solve.<run>"]`. The person sees one compute card that names both jobs
// (the Steps row: Generate "Mesh 1", then Start "Run chain") and the Assistant's estimate. After
// Allow the mesh generates, the run starts with no second card (the transcript says "Covered by
// your earlier approval"), and the tree shows both done without a reload. A third compute call
// the chain did not declare asks again. With Don't, neither job runs, and the run the model then
// asks for gets its own card (no grant was kept).
// Its own server with the Assistant's test switches, the scripted model (support/fake-llm.mjs)
// and the fake compute (MAGNUSIM_TEST_COMPUTE=fake: a stand-in mesher and solver, no WSL).
// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { seedElbowProject } from './prepare-projects.js';
import { dockGate, dockSend, dockTurn, openDock, resultsIn, useScriptedModel } from './support/assistant.js';
import { startFakeLlm } from './support/fake-llm.mjs';
import { e2eTemp, startHost } from './support/host-server.mjs';
import { expect, test } from './support/stress.js';

const ALLOWED = 'assistant-chain-allow-e2e';
const DENIED = 'assistant-chain-deny-e2e';
const STEP = { timeout: 30_000 };
let host;
let fake;

const api = (path) => `${host.base}${path}`;
const getJson = async (request, path) => (await request.get(api(path))).json();
async function postOk(request, path, data = {}) {
  const r = await request.post(api(path), { data });
  const j = await r.json().catch(() => ({}));
  expect(r.ok(), `${path}: ${r.status()} ${JSON.stringify(j)}`).toBe(true);
  return j;
}

/** A compute call's input as a strict model sends it: every field, "" / 0 / -1 / [] when unused. */
const compute = (o) => ({ project_id: '', simulation_id: '', action: '', mesh_id: '', run_id: '', extra_iterations: 0, end_time: 0, frames: '', time: -1, plugin: '', chain: [], estimate_minutes: 0, ...o });
const wait = (ids, timeout = 120) => ({ project_id: '', job_ids: ids, until: 'all', timeout_s: timeout });

/** The project's study, its mesh and a run on that mesh named `name`. */
async function studyOf(request, pid, ...names) {
  const doc = await getJson(request, `/api/mesh?project_id=${pid}`);
  const sim = doc.simulation_id;
  const meshId = String(doc.mesh.id);
  const runs = [];
  for (const name of names) {
    const made = await postOk(request, '/api/run/create', { project_id: pid, simulation_id: sim, name, mesh_id: meshId });
    runs.push(String(made.run_id || made.run?.id || made.run?.run_id));
  }
  return { sim, meshId, runs };
}

test.beforeAll(async () => {
  test.setTimeout(240_000);
  fake = await startFakeLlm();
  const tmp = e2eTemp('assistant-core-chain');
  const projects = join(tmp, 'projects');
  mkdirSync(projects, { recursive: true });
  seedElbowProject(projects, ALLOWED, 'Chain allowed');
  seedElbowProject(projects, DENIED, 'Chain denied');
  host = await startHost({
    name: 'assistant-core-chain',
    tmp,
    projects,
    env: {
      MAGNUSIM_TEST_ASSISTANT: '1',
      MAGNUSIM_TEST_ASSISTANT_PROVIDER_URL: fake.base,
      MAGNUSIM_TEST_COMPUTE: 'fake',
      MAGNUSIM_TEST_MESH_SECONDS: '4',
      MAGNUSIM_TEST_SOLVE_SECONDS: '4',
    },
  });
});

test.afterAll(async () => {
  host?.stop();
  await fake?.stop();
});

test.beforeEach(async ({ request, page }) => {
  await postOk(request, '/api/test/assistant/reset', {});
  await useScriptedModel(request, host.base, fake, 'cloud');
  await page.setViewportSize({ width: 1280, height: 800 });
});

test.afterEach(() => {
  expect(fake.pending(), 'scripted answers left unused').toBe(0);
});

async function openProject(page, pid) {
  await page.goto(api(`/#/p/${pid}`));
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, pid, { timeout: 60_000 });
  await openDock(page);
}

const meshRow = (page, id) => page.locator(`#left-tree [data-w20-mesh-item="${id}"] > .tree-row`);
const runRow = (page, id) => page.locator(`#left-tree [data-w27-run="${id}"] > .tree-row`);
const meshLive = async (request, pid, id) => (await getJson(request, `/api/mesh?project_id=${pid}&mesh_id=${id}`)).mesh?.live_mesh_result?.status || '';
const runStatus = async (request, pid, sim, id) => (await getJson(request, `/api/run/status?project_id=${pid}&simulation_id=${sim}&run_id=${id}`)).run?.status || '';
/** The question lines the transcript keeps (one per card the person was shown). */
const cardsShown = (page) => dockTurn(page).locator('[data-dock-line="gate"]');

/** The card's detail rows as {label: value}. */
async function detailOf(card) {
  const rows = await card.locator('.dock-gate-detail > div').evaluateAll((divs) => divs.map((d) => [d.querySelector('dt')?.textContent ?? '', d.querySelector('dd')?.textContent ?? '']));
  return Object.fromEntries(rows);
}

test('one card covers "mesh, then run": it names both jobs and the estimate; Allow runs both with no second card; an undeclared call asks again', async ({ page, request }) => {
  test.setTimeout(240_000);
  const { sim, meshId, runs } = await studyOf(request, ALLOWED, 'Run chain', 'Run other');
  const [rid, other] = runs;
  fake.reply(
    { text: 'Meshing, then running.', tools: [{ name: 'compute', input: compute({ action: 'mesh_generate', mesh_id: meshId, chain: [`solve.${rid}`], estimate_minutes: 12 }) }] },
    { tools: [{ name: 'wait', input: wait([`mesh.${meshId}`]) }] },
    { tools: [{ name: 'compute', input: compute({ action: 'run_start', run_id: rid }) }] },
    { tools: [{ name: 'wait', input: wait([`solve.${rid}`]) }] },
    // Not in the chain: the person is asked again.
    { tools: [{ name: 'compute', input: compute({ action: 'run_start', run_id: other }) }] },
    { text: 'Mesh 1 and Run chain are done.' },
  );
  await openProject(page, ALLOWED);
  await dockSend(page, 'Mesh it and run it.');

  // One card, naming both steps and the estimate.
  const card = dockGate(page);
  await expect(card).toBeVisible(STEP);
  await expect(card.locator('.dock-gate-title')).toHaveText('Allow the Assistant to mesh and run?');
  await expect(card.locator('.dock-gate-copy')).toContainText('Covers these steps, each once: 1. Generate "Mesh 1". 2. Start "Run chain".');
  await expect(card).toContainText('Runs a computation');
  const rows = await detailOf(card);
  expect(rows).toMatchObject({ Steps: 'Generate "Mesh 1", then Start "Run chain"', Mesh: 'Mesh 1', "Assistant's estimate": 'about 12 min' });
  await card.locator('[data-gate-answer="yes"]').click(STEP);

  // The mesh generates and the run solves, in the tree, live; no second card for the run.
  await expect(meshRow(page, meshId).locator('.tree-check')).toBeVisible({ timeout: 60_000 });
  await expect(dockTurn(page).locator('[data-dock-line="note"]').filter({ hasText: 'Covered by your earlier approval: Start "Run chain"' })).toHaveCount(1, { timeout: 60_000 });
  await expect(runRow(page, rid).locator('.tree-check')).toBeVisible({ timeout: 60_000 });
  expect(await runStatus(request, ALLOWED, sim, rid)).toBe('done');

  // The third call asks again: its own card, for its own run.
  const third = dockGate(page);
  await expect(third).toBeVisible({ timeout: 60_000 });
  await expect(third.locator('.dock-gate-title')).toHaveText('Allow the Assistant to start a run?');
  await expect(third.locator('.dock-gate-copy')).toContainText('Starts "Run other"');
  await third.locator('[data-gate-answer="no"]').click();
  await expect(dockTurn(page).locator('[data-turn-end="done"]')).toBeVisible(STEP);
  // Two cards in all: the chain's and the undeclared run's.
  await expect(cardsShown(page)).toHaveCount(2);
  expect(await runStatus(request, ALLOWED, sim, other)).not.toMatch(/running|done|queued/);

  // What the model got: the covered run started; the undeclared one was declined.
  const chats = fake.requests().filter((r) => r.kind === 'chat');
  expect(resultsIn(chats[3])[0]).toMatchObject({ ok: true, data: { job_id: `solve.${rid}` } });
  expect(resultsIn(chats[5])[0]).toMatchObject({ ok: false, error: { code: 'declined' } });
});

test("Don't runs neither job, and keeps no approval: the run the model asks for next has its own card", async ({ page, request }) => {
  test.setTimeout(180_000);
  const { sim, meshId, runs } = await studyOf(request, DENIED, 'Run chain');
  const [rid] = runs;
  fake.reply(
    { tools: [{ name: 'compute', input: compute({ action: 'mesh_generate', mesh_id: meshId, chain: [`solve.${rid}`], estimate_minutes: 5 }) }] },
    { tools: [{ name: 'compute', input: compute({ action: 'run_start', run_id: rid }) }] },
    { text: 'Left both.' },
  );
  await openProject(page, DENIED);
  await dockSend(page, 'Mesh it and run it.');
  const card = dockGate(page);
  await expect(card.locator('.dock-gate-title')).toHaveText('Allow the Assistant to mesh and run?', STEP);
  await card.locator('[data-gate-answer="no"]').click();
  // The run's own card: Don't again.
  const second = dockGate(page);
  await expect(second.locator('.dock-gate-title')).toHaveText('Allow the Assistant to start a run?', STEP);
  await second.locator('[data-gate-answer="no"]').click();
  await expect(dockTurn(page).locator('[data-turn-end="done"]')).toBeVisible(STEP);
  await expect(cardsShown(page)).toHaveCount(2);
  await expect(dockTurn(page).locator('[data-dock-line="note"]').filter({ hasText: 'Covered by your earlier approval' })).toHaveCount(0);
  // Nothing ran: the tree shows neither generating nor done.
  await expect(meshRow(page, meshId).locator('.tree-spin, .tree-check')).toHaveCount(0);
  await expect(runRow(page, rid).locator('.tree-spin, .tree-check')).toHaveCount(0);
  expect(await meshLive(request, DENIED, meshId)).not.toMatch(/running|done|queued/);
  expect(await runStatus(request, DENIED, sim, rid)).not.toMatch(/running|done|queued/);
});

// The chain card's whole copy (spec 14.2) is longer than a confirm note (CONFIRM_NOTE_MAX, 120
// characters): a tool that words its own card (gateText) gets its escalation's note whole, so the
// person reads "Nothing else is covered; you can stop either from the tree."
test('the chain card shows its whole copy, uncut', async ({ page, request }) => {
  const { meshId, runs } = await studyOf(request, DENIED, 'Run copy');
  fake.reply({ tools: [{ name: 'compute', input: compute({ action: 'mesh_generate', mesh_id: meshId, chain: [`solve.${runs[0]}`] }) }] }, { text: 'Left it.' });
  await openProject(page, DENIED);
  await dockSend(page, 'Mesh it and run it.');
  const card = dockGate(page);
  await expect(card.locator('.dock-gate-copy')).toHaveText('Covers these steps, each once: 1. Generate "Mesh 1". 2. Start "Run copy". Nothing else is covered; you can stop either from the tree.', STEP);
  await card.locator('[data-gate-answer="no"]').click();
  await expect(dockTurn(page).locator('[data-turn-end="done"]')).toBeVisible(STEP);
});
