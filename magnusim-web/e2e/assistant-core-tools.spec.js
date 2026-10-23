// The app page's own Assistant tools and a turn bound to its window (core host tools spec 5,
// C5, C7): what Daniel sees when the Assistant moves his window. From Home a dock request is
// bound to the window; core__show opens a project and the window shows it, the project's
// privacy question comes in the dock before anything of it is sent, and the conversation moves
// to the project. In a project: another project's read asks that project's question first
// (Don't send: that call is refused and the turn goes on); core__show switches the study shown
// and opens a run's results; core__view's picture shows in the dock step (saved to the run's
// Screenshots when asked) and hides a face in the viewport. The person first: while Daniel
// holds the mouse in the viewer, or works in the Filters panel, the step waits saying so, then
// answers person_busy and the camera has not moved; once he lets go, it moves.
// Its own server with the Assistant's test switches (a test home, never this PC's keys) and the
// scripted model (support/fake-llm.mjs). No WSL: the run's results are a copy of the committed
// cavity case.
// SPDX-License-Identifier: GPL-3.0-or-later
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appReady, dockGate, dockPanel, dockSend, dockTurn, offeredTools, openDock, resultsIn, trackTab, useScriptedModel } from './support/assistant.js';
import { startFakeLlm } from './support/fake-llm.mjs';
import { startHost } from './support/host-server.mjs';
import { expect, test } from './support/stress.js';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROUND = join(WEB, 'python', 'tests', 'fixtures', 'geometry', 'transient-test.step');
const CAVITY = join(WEB, 'python', 'tests', 'fixtures', 'foam-results', 'cavity-2d');
const WING = 'Core Wing';
const TAIL = 'Core Tail';
const WAIT_LABEL = 'Waiting for you to finish with the view';

let host;
let fake;
let wing;
let tail;
let studyA;
let studyB;
let run;

test.describe.configure({ mode: 'serial' });

const api = (path) => `${host.base}${path}`;

async function postOk(request, path, data = {}) {
  const r = await request.post(api(path), { data });
  const j = await r.json().catch(() => ({}));
  expect(r.ok(), `${path}: ${r.status()} ${JSON.stringify(j)}`).toBe(true);
  return j;
}

async function getJson(request, path) {
  for (let i = 0; ; i++) {
    try {
      const r = await request.get(api(path));
      expect(r.status(), path).toBe(200);
      return await r.json();
    } catch (e) {
      if (i >= 2 || !/ECONNRESET|socket hang up/i.test(String(e))) throw e;
    }
  }
}

const q = (path, extra = {}) => `${path}?${new URLSearchParams({ project_id: wing, ...extra })}`;
const chats = () => fake.requests().filter((r) => r.kind === 'chat');
const call = (name, input) => ({ tools: [{ name, input }] });
const view = (action, o = {}) => call('core__view', { action, target_ids: [], aspect: 'view', size: 'small', with_legend: true, on: false, save: false, ...o });
const show = (target, o = {}) => call('core__show', { target, project_id: '', id: '', panel: '', ...o });

test.beforeAll(async ({ request }) => {
  test.setTimeout(420_000);
  fake = await startFakeLlm();
  host = await startHost({
    name: 'assistant-core',
    env: {
      MAGNUSIM_TEST_ASSISTANT: '1',
      MAGNUSIM_TEST_ASSISTANT_PROVIDER_URL: fake.base,
      MAGNUSIM_TEST_EVENT_HUB: '1',
      MAGNUSIM_TEST_ASSISTANT_HOLD_MS: '2000',
    },
  });
  wing = (await postOk(request, '/api/project', { title: WING, folder: 'My Projects', units: 'Metric', category: 'Other' })).id;
  tail = (await postOk(request, '/api/project', { title: TAIL, folder: 'My Projects', units: 'Metric', category: 'Other' })).id;
  // The import makes the preview before it answers; a socket the server let go meanwhile still imported.
  await request.post(api('/api/geometry/import'), { data: { project_id: wing, step_path: ROUND, filename: 'round.step' }, timeout: 300_000 }).catch((e) => {
    if (!/socket hang up|ECONNRESET/i.test(String(e))) throw e;
  });
  await expect.poll(async () => ((await getJson(request, q('/api/project'))).project?.geometries || []).length, { timeout: 180_000 }).toBe(1);
  const thumb = api(`/api/geometry/thumb?project_id=${encodeURIComponent(wing)}`);
  await expect.poll(async () => (await request.get(thumb)).status(), { timeout: 120_000 }).not.toBe(202);
  const study = async () => {
    const j = await postOk(request, '/api/simulation', { project_id: wing });
    return String((j.simulation || j.sim || j).id || '');
  };
  studyA = await study();
  studyB = await study();
  expect(studyA && studyB && studyA !== studyB, `${studyA} ${studyB}`).toBeTruthy();
  await postOk(request, '/api/simulation/activate', { project_id: wing, simulation_id: studyA });
  // A finished run of study A whose case is a copy of the cavity (U and p, five saved times).
  const made = await postOk(request, q('/api/run/create'), { project_id: wing, simulation_id: studyA, name: 'Run 1' });
  run = String(made.run_id || (made.run && (made.run.id || made.run.run_id)));
  expect(run, JSON.stringify(made)).toBeTruthy();
  const rows = (await getJson(request, q('/api/run/status', { simulation_id: studyA }))).runs || [];
  const runDir = dirname(rows.find((r) => String(r.id) === run).case_dir);
  const caseDir = join(runDir, 'case');
  cpSync(CAVITY, caseDir, { recursive: true });
  const sidecar = join(caseDir, 'w27-case.json');
  const doc = JSON.parse(readFileSync(sidecar, 'utf8'));
  delete doc.plugin;
  delete doc.study_id;
  writeFileSync(sidecar, JSON.stringify(doc, null, 2));
  const runJson = join(runDir, 'run.json');
  const rec = JSON.parse(readFileSync(runJson, 'utf8'));
  writeFileSync(
    runJson,
    JSON.stringify({ ...rec, status: 'done', stage: 'done', has_results: true, n_saved_times: 5, last_saved_iteration: 0.5, finished_at: new Date().toISOString(), case_dir: caseDir }, null, 2),
  );
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

/** The window's core page, as the server holds it now ({place, project_id, ...}), or null. */
async function coreOf(request, tab) {
  return (await getJson(request, '/api/assistant/tabs')).tabs.find((t) => t.tab === tab)?.core ?? null;
}

/** Wing's workbench, open and drawn, with the window's core page on the server. */
async function openWing(page, request) {
  const tabOf = trackTab(page);
  await page.goto(api(`/#/p/${wing}`));
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, wing, { timeout: 60_000 });
  await appReady(page);
  await expect.poll(async () => (await coreOf(request, tabOf()))?.project_id, { timeout: 30_000, message: "the window's core page" }).toBe(wing);
  return tabOf;
}

/** A point of the window where `selector` is what the person's pointer would be on (nothing over it). */
async function pointIn(page, selector) {
  const at = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    const r = el?.getBoundingClientRect();
    if (!el || !r) return null;
    for (let y = r.top + 8; y < r.bottom - 4; y += 12) {
      for (let x = r.left + 8; x < r.right - 4; x += 12) {
        const hit = document.elementFromPoint(x, y);
        if (hit && el.contains(hit)) return { x, y };
      }
    }
    return null;
  }, selector);
  expect(at, `a point on ${selector} with nothing over it`).toBeTruthy();
  return at;
}

const activeStudy = (page) => page.evaluate(() => window.__CFD_W17__?.activeId ?? null);
const camera = (page) => page.evaluate(() => window.__CFD_VIEW__.renderer.getActiveCamera().getPosition().map((v) => Math.round(v * 1e6) / 1e6));

test('from Home the request is bound to the window: core__show opens the project on screen, its privacy question comes first in the dock, and the conversation moves to it', async ({ page, request }) => {
  test.setTimeout(180_000);
  await postOk(request, '/api/assistant/settings', { privacy: 'ask' });
  const tabOf = trackTab(page);
  await page.goto(api('/#/'));
  await appReady(page);
  await expect.poll(async () => (await coreOf(request, tabOf()))?.place, { timeout: 30_000, message: "Home's core page" }).toBe('home');
  const before = chats().length;
  let homeTools = [];
  let wingTools = [];
  fake.reply(
    (body) => {
      homeTools = offeredTools(body).map((t) => t.name);
      return show('project', { project_id: wing });
    },
    (body) => {
      wingTools = offeredTools(body).map((t) => t.name);
      return { text: 'The wing is open.' };
    },
  );
  const started = page.waitForRequest((r) => new URL(r.url()).pathname === '/api/assistant/turns' && r.method() === 'POST');
  await dockSend(page, 'Open the wing');
  expect((await started).postDataJSON().tab, "bound to this window from Home (its core page's registration)").toBe('link');
  // The window shows the project, as a click on its card does.
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, wing, { timeout: 60_000 });
  await expect(page).toHaveURL(new RegExp(`#/p/${wing}$`));
  await expect(page.locator('#app')).toBeVisible();
  // Its question, in the dock, before the next request carries anything of it.
  const card = dockGate(page);
  await expect(card.locator('.dock-gate-title')).toHaveText(`Send project "${WING}" to Anthropic?`, { timeout: 30_000 });
  expect(chats()).toHaveLength(before + 1);
  await card.locator('[data-gate-answer="yes"]').click();
  await expect(dockTurn(page).locator('[data-turn-end="done"]')).toBeVisible({ timeout: 30_000 });
  await expect(dockTurn(page)).toContainText('The wing is open.');
  await expect(dockTurn(page).locator('[data-dock-line="note"]')).toContainText(`Moved to project "${WING}".`);
  expect(homeTools).toEqual(expect.arrayContaining(['core__show', 'core__view']));
  expect(homeTools, "Home offers no tool that needs the window's project").not.toContain('project_summary');
  expect(wingTools, "the next step's tools are the workbench's").toEqual(expect.arrayContaining(['core__show', 'core__view', 'project_summary']));
  // The conversation is the project's now: the dock goes on with it here (no read-only notice), listed under "Here".
  await expect(dockPanel(page).locator('[data-dock-readonly]')).toHaveCount(0);
  await expect(dockPanel(page).getByRole('textbox', { name: 'Message to the Assistant' })).toBeVisible();
  await dockPanel(page).locator('[data-dock-menu]').click();
  await expect(dockPanel(page).locator('[data-dock-group="Here"] [data-dock-conversation]')).toHaveCount(1);
});

test("another project's read asks that project's question in the dock; Don't send refuses that call and the turn goes on", async ({ page, request }) => {
  test.setTimeout(180_000);
  await postOk(request, '/api/assistant/settings', { privacy: 'ask' });
  await openWing(page, request);
  let seen = [];
  fake.reply(call('project_summary', { project_id: tail }), (body) => {
    seen = resultsIn(body);
    return { text: 'I could not read the tail.' };
  });
  await dockSend(page, 'Compare with the tail');
  // Wing's own question when it is not remembered yet; then Tail's.
  const card = dockGate(page);
  const title = card.locator('.dock-gate-title');
  await expect(title).toHaveText(/^Send project "Core (Wing|Tail)" to Anthropic\?$/, { timeout: 30_000 });
  if ((await title.textContent()) === `Send project "${WING}" to Anthropic?`) {
    await card.locator('[data-gate-answer="yes"]').click();
    await expect(dockGate(page).locator('.dock-gate-title')).toHaveText(`Send project "${TAIL}" to Anthropic?`, { timeout: 30_000 });
  }
  await dockGate(page).locator('[data-gate-answer="no"]').click();
  await expect(dockTurn(page).locator('[data-turn-end="done"]')).toBeVisible({ timeout: 30_000 });
  const step = dockTurn(page).locator('[data-dock-step]').first();
  await expect(step).toHaveAttribute('data-dock-step-state', 'failed');
  await expect(step.locator('.dock-step-code')).toHaveText('privacy_declined');
  await expect(dockTurn(page)).toContainText('I could not read the tail.');
  expect(seen.map((r) => r.error?.code)).toEqual(['privacy_declined']);
  expect(JSON.stringify(seen)).not.toContain(TAIL);
});

test("core__show opens a run's results; a picture saved goes to its Screenshots; with the app's own Filters panel the view moves, while Daniel works in it it waits, then person_busy", async ({ page, request }) => {
  test.setTimeout(300_000);
  await openWing(page, request);
  const before = chats().length;
  let fitWithPanel = null;
  let busy = null;
  fake.reply(
    show('study', { id: studyA }),
    show('results', { id: run }),
    view('picture', { save: true }),
    view('fit'),
    (body) => {
      fitWithPanel = resultsIn(body)[0];
      return { hold: 'filters', ...view('fit') };
    },
    (body) => {
      busy = resultsIn(body)[0];
      return { text: 'You were busy.' };
    },
  );
  await dockSend(page, 'Show the results and picture them');
  // The results are on screen, with the Filters panel the app opens with them.
  await expect(page.locator('#legend .legend-title')).toHaveText('Velocity Magnitude', { timeout: 90_000 });
  await expect(page.locator('#filters-panel')).not.toHaveClass(/is-hidden/);
  // The saved picture is in the run's Screenshots.
  await expect
    .poll(async () => ((await getJson(request, q('/api/media/list', { owner: `run-${run}`, simulation_id: studyA }))).items || []).length, { timeout: 30_000 })
    .toBe(1);
  // Held before the second fit: Daniel works in the Filters panel (scrolls it) meanwhile.
  await expect.poll(() => chats().length - before, { timeout: 60_000 }).toBe(5);
  expect(fitWithPanel?.ok, 'the panel the app opened is not the person using it').toBe(true);
  const at = await pointIn(page, '#filters-panel');
  const cam = await camera(page);
  let scrolling = true;
  const scroll = (async () => {
    while (scrolling) {
      await page.mouse.move(at.x, at.y);
      await page.mouse.wheel(0, 40);
      await page.waitForTimeout(400);
    }
  })();
  // His scrolling has reached the panel before the call comes.
  await page.waitForFunction(() => window.__CFD_ASSISTANT_CORE__.filtersInUse(), null, { timeout: 10_000 });
  fake.release('filters');
  const step = dockTurn(page).locator('[data-dock-step]').nth(4);
  await expect(step.locator('[data-dock-progress="waiting"]')).toHaveText(WAIT_LABEL, { timeout: 30_000 });
  await expect(step).toHaveAttribute('data-dock-step-state', 'failed', { timeout: 30_000 });
  scrolling = false;
  await scroll;
  await expect(step.locator('.dock-step-code')).toHaveText('person_busy');
  await expect(dockTurn(page).locator('[data-turn-end="done"]')).toBeVisible({ timeout: 30_000 });
  expect(busy?.error?.code).toBe('person_busy');
  expect(await camera(page), 'the camera did not move under the person').toEqual(cam);
});

test('core__show switches the study on screen; core__view hides a face in the viewport and its picture shows in the dock step', async ({ page, request }) => {
  test.setTimeout(180_000);
  await openWing(page, request);
  await expect.poll(() => activeStudy(page), { timeout: 30_000 }).toBeTruthy();
  const other = (await activeStudy(page)) === studyA ? studyB : studyA;
  let pictured = [];
  fake.reply(
    show('study', { id: other }),
    view('hide', { target_ids: ['face 1@Body1'] }),
    view('picture', { aspect: '16:9', size: 'medium' }),
    (body) => {
      pictured = resultsIn(body);
      return { text: 'Done.' };
    },
  );
  await dockSend(page, 'Show the other study, hide face 1 and picture it');
  await expect(dockTurn(page).locator('[data-turn-end="done"]')).toBeVisible({ timeout: 60_000 });
  // The study shown is the other one: its row is the active study's (its + for a material).
  await expect.poll(() => activeStudy(page)).toBe(other);
  await expect(page.locator(`#left-tree li[data-w17-sim-id="${other}"] #btn-materials-plus`)).toHaveCount(1);
  // The face is hidden in the viewport.
  expect(await page.evaluate(() => window.__CFD_VIEWPORT_FACES__().hidden)).toContain('face 1@Body1');
  // Every step shows its picture; the last one is the picture asked for (1024 px wide, 16:9).
  const steps = dockTurn(page).locator('[data-dock-step]');
  await expect(steps).toHaveCount(3);
  for (const i of [1, 2]) {
    const img = steps.nth(i).locator('.dock-step-pictures img').first();
    await expect(img).toBeVisible();
    await expect.poll(() => img.evaluate((el) => el.naturalWidth)).toBeGreaterThan(0);
  }
  expect(pictured).toHaveLength(1);
  expect(pictured[0].ok).toBe(true);
  expect(pictured[0].data.picture).toMatchObject({ width: 1024, height: 576, aspect: '16:9' });
  expect(pictured[0].images).toHaveLength(1);
});

test('while Daniel holds the mouse in the viewer the view waits, then person_busy, and the camera stays; once he lets go it moves', async ({ page, request }) => {
  test.setTimeout(180_000);
  await openWing(page, request);
  // A camera of the person's own (not the framed one a fit gives).
  await page.evaluate(() => {
    const cam = window.__CFD_VIEW__.renderer.getActiveCamera();
    const p = cam.getPosition();
    cam.setPosition(p[0] * 1.7 + 1, p[1] * 0.4 - 2, p[2] * 1.3 + 3);
    window.__CFD_VIEW__.renderWindow.render();
  });
  let busy = null;
  let moved = null;
  fake.reply({ text: 'Fitting.', hold: 'press', ...view('fit') }, (body) => {
    busy = resultsIn(body)[0];
    return { hold: 'release', ...view('fit') };
  }, (body) => {
    moved = resultsIn(body)[0];
    return { text: 'Fitted.' };
  });
  const sent = chats().length;
  await dockSend(page, 'Fit the view');
  await expect.poll(() => chats().length - sent, { timeout: 30_000 }).toBe(1);
  const at = await pointIn(page, '#viewer');
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  const before = await camera(page);
  fake.release('press');
  const steps = dockTurn(page).locator('[data-dock-step]');
  await expect(steps.first().locator('[data-dock-progress="waiting"]')).toHaveText(WAIT_LABEL, { timeout: 30_000 });
  await expect(steps.first()).toHaveAttribute('data-dock-step-state', 'failed', { timeout: 30_000 });
  await expect(steps.first().locator('.dock-step-code')).toHaveText('person_busy');
  expect(await camera(page), 'the camera did not move under his hand').toEqual(before);
  await page.mouse.up();
  await page.waitForTimeout(1600);
  fake.release('release');
  await expect(dockTurn(page).locator('[data-turn-end="done"]')).toBeVisible({ timeout: 30_000 });
  expect(busy?.error?.code).toBe('person_busy');
  expect(moved?.ok).toBe(true);
  expect(await camera(page), 'fitted once he let go').not.toEqual(before);
  await openDock(page);
});
