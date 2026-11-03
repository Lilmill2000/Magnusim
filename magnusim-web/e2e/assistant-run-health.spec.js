// The Assistant and run health (RH1, spec 3.13, 3.17): the scripted model reads a run's health the
// way the person sees it, and acts on it the way the person can.
// - A wait on the solving run returns early with the alert when it turns Unhealthy (the run
//   keeps running); read_results status carries the Courant number, the time step and the health
//   verdict; health carries the findings (their words are the Run panel's) and what to do;
//   log_tail "issues" and log_tail at a finding's log_at (its hit_line is the finding's line).
//   Nothing in any answer is a path.
// - The request's system blocks carry the CFD guide (Magnusim only).
// - With the run stopped: health's `next` is the Run panel's What to do sentence, word for word;
//   the new-run fix is one setup_edit {kind:'run', action:'add', other_id, name, values} call that
//   makes "Run_2 fixed" with the fix's values, while Run_2 keeps its results.
// Its own server with the scripted model (support/fake-llm.mjs) and the fake compute replaying
// Run_2's log through the real tracker (MAGNUSIM_TEST_SOLVE_LOG).
// Fails on the code before RH1: read_results had no health or log_tail.
// SPDX-License-Identifier: GPL-3.0-or-later
import { cpSync, mkdirSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedElbowProject } from './prepare-projects.js';
import { dockGate, dockSend, dockTurn, openDock, resultsIn, useScriptedModel } from './support/assistant.js';
import { openRunPanel } from './support/compute-slot.js';
import { startFakeLlm } from './support/fake-llm.mjs';
import { e2eTemp, startHost } from './support/host-server.mjs';
import { expect, test } from './support/stress.js';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const HEALTH = join(WEB, 'python', 'tests', 'fixtures', 'health');
const CAVITY = join(WEB, 'python', 'tests', 'fixtures', 'foam-results', 'cavity-2d');
const PID = 'assistant-run-health-e2e';
const STEP = { timeout: 30_000 };
const PATHS = /[A-Za-z]:\\\\|\/home\/|\/mnt\/[a-z]\//;
let host;
let fake;
let sim;
let meshId;
let rid;

const api = (path) => `${host.base}${path}`;
const getJson = async (request, path) => (await request.get(api(path))).json();
async function postOk(request, path, data = {}) {
  const r = await request.post(api(path), { data });
  const j = await r.json().catch(() => ({}));
  expect(r.ok(), `${path}: ${r.status()} ${JSON.stringify(j)}`).toBe(true);
  return j;
}
const results = (o) => ({ project_id: '', simulation_id: '', run_id: '', kind: '', field: '', time: -1, points: [], samples: 0, filter_key: '', values: [], ...o });
const wait = (ids, timeout = 120) => ({ project_id: '', job_ids: ids, until: 'all', timeout_s: timeout });
const setup = (o) => ({ project_id: '', simulation_id: '', kind: '', action: '', id: '', other_id: '', name: '', type: '', faces: [], bodies: [], values: [], rev: 0, ...o });
const runRow = async (request, id) => (await getJson(request, `/api/run/status?project_id=${PID}&simulation_id=${sim}`)).runs.find((r) => String(r.id) === id) || {};
/** The tool results a scripted step got (the last request's). */
const lastResults = () => resultsIn(fake.requests().at(-1));

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ request }) => {
  test.setTimeout(240_000);
  fake = await startFakeLlm();
  const tmp = e2eTemp('assistant-run-health');
  const projects = join(tmp, 'projects');
  mkdirSync(projects, { recursive: true });
  seedElbowProject(projects, PID, 'Health project');
  host = await startHost({
    name: 'assistant-run-health',
    tmp,
    projects,
    env: {
      MAGNUSIM_TEST_ASSISTANT: '1',
      MAGNUSIM_TEST_ASSISTANT_PROVIDER_URL: fake.base,
      MAGNUSIM_TEST_COMPUTE: 'fake',
      MAGNUSIM_TEST_MESH_SECONDS: '1',
      MAGNUSIM_TEST_SOLVE_SECONDS: '600',
      MAGNUSIM_TEST_SOLVE_LOG: join(HEALTH, 'run2-head.log.gz'),
      MAGNUSIM_TEST_SOLVE_PACE_MS: '80',
      PYTHONPATH: [join(WEB, 'python'), join(WEB, 'python', 'sdk'), process.env.PYTHONPATH || ''].filter(Boolean).join(delimiter),
    },
  });
  const doc = await getJson(request, `/api/mesh?project_id=${PID}`);
  sim = doc.simulation_id;
  meshId = String(doc.mesh.id);
  const gen = await request.post(api('/api/mesh/generate'), { data: { project_id: PID, simulation_id: sim, mesh_id: meshId } });
  expect(gen.status(), await gen.text()).toBeLessThan(300);
  await expect.poll(async () => (await getJson(request, `/api/mesh?project_id=${PID}&mesh_id=${meshId}`)).mesh?.live_mesh_result?.status, { timeout: 90_000 }).toBe('done');
  await postOk(request, '/api/simulation/update', { project_id: PID, simulation_id: sim, time_dependency: 'Transient' });
  const made = await postOk(request, '/api/run/create', { project_id: PID, simulation_id: sim, name: 'Run_2', mesh_id: meshId });
  rid = String(made.run_id || made.run?.id || made.run?.run_id);
  await postOk(request, '/api/run/update', {
    project_id: PID,
    simulation_id: sim,
    run_id: rid,
    transient: { end_time: 10, write_count: 60, max_co: 100, n_outer_correctors: 1, n_correctors: 2, time_step_mode: 'adjustable' },
  });
});

test.afterAll(async () => {
  host?.stop();
  await fake?.stop();
});

test.beforeEach(async ({ request, page }) => {
  await postOk(request, '/api/test/assistant/reset', {});
  await useScriptedModel(request, host.base, fake, 'cloud');
  await page.setViewportSize({ width: 1280, height: 900 });
});

test.afterEach(async () => {
  expect(fake.pending(), 'scripted answers left unused').toBe(0);
});

async function openRun(page) {
  const panel = await openRunPanel(page, { base: host.base, projectId: PID, simulationId: sim, runId: rid });
  await openDock(page);
  return panel;
}

test('the AI follows a solving run: the alert, status, health, its problem lines and a finding\'s line; no paths', async ({ page, request }) => {
  test.setTimeout(240_000);
  await postOk(request, '/api/run/start', { project_id: PID, simulation_id: sim, run_id: rid });
  // Its log read to the end (the run still solves): the record then holds still, so the dock's
  // words and the panel's can be compared.
  await expect.poll(async () => Number((await runRow(request, rid)).sim_time) || 0, { timeout: 60_000 }).toBeGreaterThan(0.0188);
  await page.waitForTimeout(1500);
  const seen = {};
  fake.reply(
    { text: 'Watching the run.', tools: [{ name: 'wait', input: wait([`solve.${rid}`]) }] },
    () => {
      seen.wait = lastResults()[0];
      return { tools: [{ name: 'read_results', input: results({ run_id: rid, kind: 'status' }) }] };
    },
    () => {
      seen.status = lastResults()[0];
      return { tools: [{ name: 'read_results', input: results({ run_id: rid, kind: 'health' }) }] };
    },
    () => {
      seen.health = lastResults()[0];
      return { tools: [{ name: 'read_results', input: results({ run_id: rid, kind: 'log_tail', filter_key: 'issues' }) }] };
    },
    () => {
      seen.issues = lastResults()[0];
      const f = seen.health.data.findings.find((x) => x.code === 'pv_coupling');
      seen.finding = f;
      return { tools: [{ name: 'read_results', input: results({ run_id: rid, kind: 'log_tail', time: f.evidence.log_at }) }] };
    },
    () => {
      seen.at = lastResults()[0];
      return { text: 'Run_2 is unhealthy.' };
    },
  );
  const panel = await openRun(page);
  await dockSend(page, 'Is Run_2 healthy?');
  await expect(dockTurn(page).locator('[data-turn-end="done"]')).toBeVisible({ timeout: 150_000 });
  // The wait came back early with the alert; the run keeps running.
  expect(seen.wait.data.alert).toEqual({ job_id: `solve.${rid}`, verdict: 'unhealthy', top: expect.any(String) });
  expect((await runRow(request, rid)).status).toBe('running');
  // Status: the run panel's line and its health.
  const st = seen.status.data;
  expect(st.courant && st.courant.max).toBeGreaterThan(1);
  expect(st.delta_t).toBeGreaterThan(0);
  expect(st.health.verdict).toBe('unhealthy');
  expect(st.health_checked).toBe(true);
  // Health: the record and what to do, as the panel words them.
  const h = seen.health.data;
  expect(h.verdict).toBe('unhealthy');
  expect(h.shown_in).toBe('Run panel → Health');
  expect(h.next.stop).toBe(true);
  expect(h.next.fixes[0].label).toBe('New run: 3 outer correctors, Max Courant 5');
  // The finding words in the dock's data are the panel's.
  const panelText = await panel.locator('[data-run-health-finding="pv_coupling"] [data-run-health-text="1"]').textContent();
  expect(seen.finding.text).toBe(panelText);
  // log_tail issues: problem lines only; at a finding's log_at: its line is the hit.
  expect(seen.issues.data.lines.length).toBeGreaterThan(0);
  expect(seen.issues.data.lines.every((l) => /limitVelocity|bounding|No Iterations|Courant|FOAM|nan/i.test(l))).toBe(true);
  const at = seen.at.data;
  expect(at.hit_line).not.toBeNull();
  expect(at.lines[at.hit_line]).toMatch(/^GAMG:\s+Solving for p, Initial residual/);
  if (seen.finding.evidence.text) expect(at.lines[at.hit_line]).toBe(seen.finding.evidence.text);
  // No paths anywhere.
  for (const r of [seen.wait, seen.status, seen.health, seen.issues, seen.at]) expect(JSON.stringify(r)).not.toMatch(PATHS);
  // The CFD guide went with the system prompt, in its own block.
  const chat = fake.requests().filter((r) => r.kind === 'chat');
  const system = chat[0].body.system || [];
  expect(system.map((b) => String(b.text || '')).some((t) => t.startsWith('Judging and fixing CFD runs\n1. Is a run healthy:'))).toBe(true);
});

test("with the run stopped: health's next is the panel's What to do; the fix is one setup_edit call that keeps Run_2's results", async ({ page, request }) => {
  test.setTimeout(180_000);
  await postOk(request, '/api/run/stop', { project_id: PID, run_id: rid });
  await expect.poll(async () => (await runRow(request, rid)).status, STEP).toBe('stopped');
  const caseDir = (await runRow(request, rid)).case_dir;
  cpSync(join(CAVITY, '0.5'), join(caseDir, '0.16666667'), { recursive: true });
  const seen = {};
  fake.reply(
    { tools: [{ name: 'read_results', input: results({ run_id: rid, kind: 'health' }) }] },
    () => {
      seen.health = lastResults()[0];
      const fix = seen.health.data.next.fixes[0];
      return { tools: [{ name: 'setup_edit', input: setup({ kind: 'run', action: 'add', other_id: rid, name: fix.name, values: fix.values }) }] };
    },
    () => {
      seen.add = lastResults()[0];
      return { text: 'Made Run_2 fixed.' };
    },
  );
  const panel = await openRun(page);
  await expect(panel.locator('[data-run-health="unhealthy"]')).toBeVisible(STEP);
  const panelNext = await panel.locator('[data-run-health-next="1"]').textContent();
  await dockSend(page, 'Fix Run_2.');
  // Adding a run asks when the Assistant's edits ask: allow it when a card comes up.
  const card = dockGate(page);
  const ended = dockTurn(page).locator('[data-turn-end="done"]');
  await expect(card.or(ended)).toBeVisible({ timeout: 60_000 });
  if (await card.isVisible()) await card.locator('[data-gate-answer="yes"]').click(STEP);
  await expect(ended).toBeVisible({ timeout: 60_000 });
  expect(seen.health.data.next.text).toBe(panelNext);
  expect(seen.health.data.next.fixes[0].call).toMatch(/^setup_edit \{kind:'run', action:'add', other_id:'/);
  expect(seen.add.ok, JSON.stringify(seen.add)).toBe(true);
  // "Run_2 fixed" has the fix's values; Run_2 keeps its status and its results.
  const all = (await getJson(request, `/api/run/status?project_id=${PID}&simulation_id=${sim}`)).runs;
  const fixed = all.find((r) => r.name === 'Run_2 fixed');
  expect(fixed, all.map((r) => r.name).join(', ')).toBeTruthy();
  expect([fixed.status || 'draft', fixed.transient?.max_co, fixed.transient?.n_outer_correctors]).toEqual(['draft', 5, 3]);
  const kept = await runRow(request, rid);
  expect(kept.status).toBe('stopped');
  expect(kept.health?.verdict).toBe('unhealthy');
  const own = (await getJson(request, `/api/run/status?project_id=${PID}&simulation_id=${sim}&run_id=${rid}`)).run;
  expect(Number(own.continue_from)).toBeCloseTo(0.16666667, 6);
});
