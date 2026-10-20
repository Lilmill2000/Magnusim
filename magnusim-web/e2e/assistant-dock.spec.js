// The Assistant's chat dock (phase 4 spec 2-8, 11.3): where Daniel types to the Assistant and
// follows what it does. A request's transcript as it streams (the person's message, the
// model's text, a tool step with its badge, summary and time, a picture inline), the turn's end
// and counters.
// Its own server with the Assistant's test switches (a test home, never this PC's keys), the
// scripted model (support/fake-llm.mjs) and the ai-demo test plugin
// (python/tests/fixtures/assistant-plugins) for a workspace. Rect checks allow 2 px (fonts
// differ under Linux); no pixel snapshots; races are held by the fake, never slept.
// SPDX-License-Identifier: GPL-3.0-or-later
import { startTurn, trackTab, useScriptedModel } from './support/assistant.js';
import { startFakeLlm } from './support/fake-llm.mjs';
import { startHost } from './support/host-server.mjs';
import { expect, test } from './support/stress.js';

const PLUGIN = 'ai-demo';
const PROJECT_TITLE = 'Dock project';
const STEP = { timeout: 15_000 };

let host;
let fake;
let project;
let study;

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
  test.setTimeout(240_000);
  fake = await startFakeLlm();
  host = await startHost({
    name: 'assistant-dock',
    pluginsFrom: 'python/tests/fixtures/assistant-plugins',
    env: {
      MAGNUSIM_TEST_ASSISTANT: '1',
      MAGNUSIM_TEST_ASSISTANT_PROVIDER_URL: fake.base,
      MAGNUSIM_TEST_EVENT_HUB: '1',
    },
  });
  const status = await getJson(request, '/api/assistant/status');
  expect(status.test_provider, 'the cloud providers go to the fake').toBe(true);
  project = (await postOk(request, '/api/project', { title: PROJECT_TITLE, folder: 'My Projects', units: 'Metric', category: 'Other' })).id;
  study = (await postOk(request, '/api/plugin-studies/create', { project_id: project, plugin: PLUGIN, kind: 'counter_case', title: 'Counter 1' })).study.id;
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

// ---------------------------------------------------------------- the page

const dock = (page) => page.locator('#assistant-dock');
/** The newest request's block in the dock. */
const dockTurn = (page) => dock(page).locator('[data-dock-turn]').last();

/** Opens the counter workspace and waits until its tools reached the server: {frame, tab}. */
async function openCounter(page, request) {
  const tabOf = trackTab(page);
  await page.goto(api(`/#/p/${project}`));
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, project, { timeout: 60_000 });
  await page.evaluate((h) => {
    window.location.hash = h;
  }, `#/p/${project}/ws/${PLUGIN}/counter/${study}`);
  const frame = page.frameLocator('#workspace-frame');
  await expect(page.locator('#workspace-overlay .ws-shell')).toHaveAttribute('data-workspace-connected', '1', { timeout: 60_000 });
  await expect(frame.locator('#ai-available')).toHaveText('yes', { timeout: 30_000 });
  await expect.poll(tabOf, { message: "the tab's event stream" }).not.toBe('');
  const tab = tabOf();
  await expect
    .poll(async () => ((await getJson(request, '/api/assistant/tabs')).tabs.find((t) => t.tab === tab)?.tools.length ?? 0), { timeout: 30_000 })
    .toBeGreaterThan(0);
  return { frame, tab };
}

/** With DOCK_SHOTS=<folder>: a screenshot of the window for a person to look at (never compared). */
async function shot(page, name) {
  if (!process.env.DOCK_SHOTS) return;
  const vp = page.viewportSize();
  await page.screenshot({ path: `${process.env.DOCK_SHOTS}/${name}-${vp ? vp.width : 0}.png` });
}

/** Opens the dock with its header button (the workbench's, borrowed by a workspace). */
async function openDock(page) {
  if (await dock(page).isVisible()) return;
  await page.locator('#wb-assistant:visible, #home-assistant:visible').first().click();
  await expect(dock(page)).toBeVisible();
}

// ---------------------------------------------------------------- tests

test('a request bound to this window shows in the dock as it streams: its text, a tool step and its picture, then its end', async ({ page, request }) => {
  const w = await openCounter(page, request);
  fake.reply(
    { text: 'Let me add two.', chunkMs: 40, hold: 'first', tools: [{ name: `${PLUGIN}__add`, input: { by: 2 } }] },
    { tools: [{ name: `${PLUGIN}__snap`, input: {} }] },
    { text: 'The counter is **2**.' },
  );
  const t = await startTurn(request, host.base, { text: 'Add two to the counter\nthen picture it', tab: w.tab });
  await openDock(page);
  const turn = dockTurn(page);
  await expect(turn).toHaveAttribute('data-dock-turn', t.id, STEP);
  await expect(turn.locator('[data-dock-prompt]')).toHaveText('Add two to the counter\nthen picture it', STEP);
  await expect(turn.getByText('From the command line or another program')).toBeVisible();
  // Held after its first chunk: the partial text shows, with the caret.
  await expect(turn.locator('[data-dock-text][aria-busy="true"]')).toContainText('Let', STEP);
  fake.release('first');
  const step = turn.locator('[data-dock-step]').first();
  await expect(step.locator('.dock-step-title')).toHaveText('Add to the counter', STEP);
  await expect(step.locator('[data-dock-risk]')).toHaveText('Changes');
  await expect(step.locator('[data-dock-result]')).toHaveText(/^✓ .+ · \d+\.\d s$/, STEP);
  const snap = turn.locator('[data-dock-step]').nth(1);
  const img = snap.locator('.dock-step-pictures img');
  await expect(img).toHaveAttribute('alt', 'Picture 1 of 1 from Picture the counter', STEP);
  await expect.poll(() => img.evaluate((el) => el.naturalWidth), STEP).toBe(64);
  await shot(page, 'tool-step-picture');
  await expect(turn.locator('[data-turn-end="done"]')).toHaveText(/^2 steps · \$\d+\.\d\d$/, STEP);
  await expect(turn.locator('[data-dock-text]').last()).toHaveText('The counter is 2.');
  await expect(turn.locator('[data-dock-text] strong')).toHaveText('2');
  await expect(dock(page)).toHaveAttribute('data-assistant-dock-state', 'ready');
  await t.ended();
});
