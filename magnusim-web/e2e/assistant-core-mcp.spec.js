// Another app with no Magnusim window of its own (core host tools spec 9.5, L9): an MCP client
// through Magnusim's real bridge (support/mcp-client.mjs), against real app windows.
// - No window open: the client gets the Home subset of the app's tools (12: no core page tools,
//   nothing that needs the window's project), reads that need no project data run, and a read
//   of a project that would ask the person answers no_window at once (nobody could see the
//   question).
// - Two windows open (Home and a project's workbench): the client is still tab-less (the same
//   12), but a call whose project_id is open in exactly one window runs in that window: its
//   privacy question shows in that window's dock (not Home's), and after Allow it reads the
//   project. A project open in no window still answers no_window.
// Its own server with the Assistant's test switches (a test home, never this PC's settings or
// mcp.json). No WSL.
// SPDX-License-Identifier: GPL-3.0-or-later
import { appReady, dockGate, noAgentsHere } from './support/assistant.js';
import { e2eTemp, startHost } from './support/host-server.mjs';
import { infoPathOf, resultJson, startMcpClient } from './support/mcp-client.mjs';
import { expect, test } from './support/stress.js';

const WING = 'Mcp Wing';
const TAIL = 'Mcp Tail';
const APP_NAME = 'E2E Desk App';
/** The Home subset a tab-less app gets (spec 15): Home's tools without the window's own. */
const HOME_SUBSET = ['app_status', 'catalog', 'compute', 'delete', 'explain_ready', 'jobs', 'project_edit', 'project_summary', 'projects', 'read_results', 'read_setup', 'wait'];

let host;
let wing;
let tail;
const apps = [];

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

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ request }) => {
  test.setTimeout(240_000);
  const tmp = e2eTemp('assistant-core-mcp');
  host = await startHost({ name: 'assistant-core-mcp', tmp, env: { MAGNUSIM_TEST_ASSISTANT: '1', MAGNUSIM_TEST_EVENT_HUB: '1', ...noAgentsHere(tmp) } });
  wing = (await postOk(request, '/api/project', { title: WING, folder: 'My Projects', units: 'Metric', category: 'Other' })).id;
  tail = (await postOk(request, '/api/project', { title: TAIL, folder: 'My Projects', units: 'Metric', category: 'Other' })).id;
});

test.afterAll(async () => {
  for (const a of apps.splice(0)) await a.close();
  host?.stop();
});

test.afterEach(async ({ request }) => {
  for (const a of apps.splice(0)) await a.close();
  await expect.poll(async () => (await getJson(request, '/api/assistant/mcp')).connections.length, { timeout: 10_000 }).toBe(0);
});

/** Other apps on, privacy Ask with nothing remembered; the app connected through the bridge. */
async function connectApp(request) {
  await postOk(request, '/api/test/assistant/reset', {});
  await postOk(request, '/api/assistant/settings', { mcp: { clients: true }, privacy: 'ask', forget_consents: true });
  const mcp = await getJson(request, '/api/assistant/mcp');
  expect(mcp).toMatchObject({ ok: true, clients: true, running: true });
  const app = await startMcpClient({ info: infoPathOf(mcp), name: APP_NAME });
  apps.push(app);
  return app;
}

/** The app windows whose core page the server holds now: [{tab, place, project_id}]. */
async function windows(request) {
  return (await getJson(request, '/api/assistant/tabs')).tabs.filter((t) => t.core && t.core.connected).map((t) => ({ tab: t.tab, place: t.core.place, project_id: t.core.project_id }));
}

const summary = (projectId) => ({ name: 'project_summary', arguments: { project_id: projectId, with_thumbnail: false } });
const listed = async (app) => (await app.client.listTools()).tools.map((t) => t.name).sort();

test('no Magnusim window: the Home subset of 12; a read with no project data runs; a project read that would ask answers no_window', async ({ request }) => {
  await expect.poll(async () => (await windows(request)).length, { timeout: 15_000, message: 'no app window' }).toBe(0);
  const app = await connectApp(request);
  expect(await listed(app)).toEqual(HOME_SUBSET);
  const status = await app.client.callTool({ name: 'app_status', arguments: {} });
  expect(status.isError, JSON.stringify(status)).toBeFalsy();
  expect(resultJson(status).ok).toBe(true);
  const r = await app.client.callTool(summary(wing));
  expect(r.isError).toBe(true);
  expect(resultJson(r).error).toMatchObject({ code: 'no_window' });
});

test('Home and a workbench open: still the Home subset; a project_id open in exactly one window runs there (its question in that window), one open in none answers no_window', async ({ page, request }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(api('/#/'));
  await appReady(page);
  const work = await page.context().newPage();
  await work.setViewportSize({ width: 1280, height: 800 });
  await work.goto(api(`/#/p/${wing}`));
  await work.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, wing, { timeout: 60_000 });
  await expect
    .poll(async () => (await windows(request)).map((w) => `${w.place}:${w.project_id || ''}`).sort(), { timeout: 30_000, message: "both windows' core pages" })
    .toEqual(['home:', `workbench:${wing}`]);

  const app = await connectApp(request);
  // Two windows: no one window is the app's, so it is tab-less.
  expect(await listed(app)).toEqual(HOME_SUBSET);

  // The wing is open in one window: the call runs there, and its question shows in that window.
  const read = app.client.callTool(summary(wing));
  const card = dockGate(work);
  await expect(card.locator('.dock-gate-title')).toHaveText(`Let other apps read project "${WING}"?`, { timeout: 30_000 });
  await expect(card.locator('.dock-gate-copy')).toContainText(`("${APP_NAME}", as it calls itself)`);
  // Not in the Home window.
  await expect(page.locator('#assistant-dock [data-gate]')).toHaveCount(0);
  await card.locator('[data-gate-answer="yes"]').click();
  await expect(card).toBeHidden();
  const r = await read;
  expect(r.isError, JSON.stringify(r)).toBeFalsy();
  expect(resultJson(r)).toMatchObject({ ok: true });
  expect(JSON.stringify(resultJson(r).data)).toContain(WING);

  // The tail is open in no window: nobody could see its question.
  const none = await app.client.callTool(summary(tail));
  expect(none.isError).toBe(true);
  expect(resultJson(none).error).toMatchObject({ code: 'no_window' });
  await expect(work.locator('#assistant-dock [data-gate]')).toHaveCount(0);
  await expect(page.locator('#assistant-dock [data-gate]')).toHaveCount(0);
  await work.close();
});
