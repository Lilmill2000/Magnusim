// Other apps (MCP) in the open workspace, end to end (phase 3 spec 7.6): the MCP SDK's own
// client, through Magnusim's real bridge (scripts/assistant-mcp.mjs) and loopback listener, to
// the server's MCP service, the page relay on the tab's event stream, the bridge and the test
// plugin's frame (ai-demo, python/tests/fixtures/assistant-plugins: a counter with add, reset
// and get_count among its tools). Its own server with the Assistant's test switches (a test
// home, never this PC's settings or mcp.json; the hold is 2 s).
//
// Covered: a call reaches the open workspace (the counter reads 2) and GET /api/assistant/mcp
// lists the connection by the app's own name; a destructive tool asks as the app's own dialog
// with Don't focused (Enter answers Don't, a click on Allow runs it) while the client hears
// that it waits; privacy Ask gives "Let other apps read project …?" once; the workspace
// closing gives list_changed, and the old name then gives unavailable with the hint.
// SPDX-License-Identifier: GPL-3.0-or-later
import { startHost } from './support/host-server.mjs';
import { infoPathOf, resultJson, startMcpClient } from './support/mcp-client.mjs';
import { expect, test } from './support/stress.js';

const PLUGIN = 'ai-demo';
const TOOLS = ['add', 'get_count', 'mystery', 'read_study', 'reset', 'slow_add', 'snap'].map((n) => `${PLUGIN}__${n}`);
const PROJECT_TITLE = 'Counter project';
const APP_NAME = 'E2E Desk App';
const WAITING_TEXT = 'Waiting for an answer in Magnusim';
const TOOLS_CHANGED_HINT = 'The tools changed. List the tools again.';

let host;
let project;
let study;
/** Every client a test started: closed after it, whatever happened. */
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

test.beforeAll(async ({ request }) => {
  test.setTimeout(240_000);
  host = await startHost({
    name: 'assistant-mcp',
    pluginsFrom: 'python/tests/fixtures/assistant-plugins',
    env: {
      MAGNUSIM_TEST_ASSISTANT: '1',
      MAGNUSIM_TEST_EVENT_HUB: '1',
      MAGNUSIM_TEST_ASSISTANT_HOLD_MS: '2000',
    },
  });
  const pj = await postOk(request, '/api/project', { title: PROJECT_TITLE, folder: 'My Projects', units: 'Metric', category: 'Other' });
  project = pj.id;
  study = (await postOk(request, '/api/plugin-studies/create', { project_id: project, plugin: PLUGIN, kind: 'counter_case', title: 'Counter 1' })).study.id;
});

test.afterAll(async () => {
  for (const a of apps.splice(0)) await a.close();
  if (host) host.stop();
});

test.afterEach(async ({ request }) => {
  for (const a of apps.splice(0)) await a.close();
  // Every app's bridge is gone: its connection closed on the server too.
  await expect.poll(async () => (await getJson(request, '/api/assistant/mcp')).connections.length, { timeout: 10_000 }).toBe(0);
});

/** Other apps on, with this privacy mode (no answer remembered); the listener runs. Returns the mcp.json path. */
async function appsOn(request, privacy) {
  await postOk(request, '/api/test/assistant/reset', {});
  await postOk(request, '/api/assistant/settings', { mcp: { clients: true }, privacy, forget_consents: true });
  const mcp = await getJson(request, '/api/assistant/mcp');
  expect(mcp).toMatchObject({ ok: true, clients: true, running: true });
  return infoPathOf(mcp);
}

/** Another app connected through the bridge (closed after the test). */
async function connect(info, o = {}) {
  const app = await startMcpClient({ info, name: APP_NAME, ...o });
  apps.push(app);
  return app;
}

// ---------------------------------------------------------------- the page

/** The id of `page`'s event stream's tab, from its /api/events?tab= request ('' before one). */
function trackTab(page) {
  let tab = '';
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.pathname === '/api/events' && u.searchParams.get('tab')) tab = u.searchParams.get('tab');
  });
  return () => tab;
}

async function tabRow(request, tab) {
  return (await getJson(request, '/api/assistant/tabs')).tabs.find((t) => t.tab === tab) || null;
}

/** Opens the counter workspace in `page` and waits until its tools are offered: {frame (a FrameLocator), tab}. */
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
  await expect.poll(async () => tabRow(request, tab).then((r) => (r ? `${r.connected}:${r.tools.length}` : 'none')), { timeout: 30_000 }).toBe(`true:${TOOLS.length}`);
  return { frame, tab };
}

const modal = (page) => page.locator('#modal-confirm');

// ---------------------------------------------------------------- tests

test("another app's call reaches the open workspace: the counter reads 2, and GET /api/assistant/mcp lists the connection by the app's own name", async ({ page, request }) => {
  const info = await appsOn(request, 'allow');
  const w = await openCounter(page, request);
  const app = await connect(info);
  const names = (await app.client.listTools()).tools.map((t) => t.name);
  expect(names).toEqual(expect.arrayContaining(TOOLS));
  const r = await app.client.callTool({ name: `${PLUGIN}__add`, arguments: { by: 2 } });
  expect(r.isError, JSON.stringify(r)).toBeFalsy();
  expect(resultJson(r)).toMatchObject({ tool: `${PLUGIN}__add`, ok: true, data: { count: 2 } });
  await expect(w.frame.locator('#counter')).toHaveText('2');
  await expect(modal(page)).toBeHidden();
  const mcp = await getJson(request, '/api/assistant/mcp');
  expect(mcp.connections).toEqual([expect.objectContaining({ kind: 'external', name: APP_NAME, calls: 1 })]);
  expect((await getJson(request, '/api/assistant/status')).mcp).toMatchObject({ clients: true, running: true, connected: 1 });
});

test("a destructive tool asks as the app's own question in the tab with Don't focused: the client hears it waits, Enter answers Don't, a click on Allow runs it", async ({ page, request }) => {
  const info = await appsOn(request, 'allow');
  const w = await openCounter(page, request);
  const counter = w.frame.locator('#counter');
  const dialog = modal(page);
  const app = await connect(info);
  expect((await app.client.callTool({ name: `${PLUGIN}__add`, arguments: { by: 2 } })).isError).toBeFalsy();
  await expect(counter).toHaveText('2');

  const got = [];
  const declined = app.client.callTool({ name: `${PLUGIN}__reset`, arguments: {} }, { onprogress: (p) => got.push(p) });
  await expect(dialog).toBeVisible();
  await expect(page.locator('#cf-heading')).toHaveText('Allow the Assistant to reset the counter?');
  await expect(page.locator('#cf-confirm')).toHaveText('Allow');
  await expect(page.locator('#cf-cancel')).toHaveText("Don't");
  await expect(page.locator('#cf-cancel')).toBeFocused();
  // The client is told it waits for an answer in Magnusim.
  await expect.poll(() => got.length, { timeout: 10_000 }).toBeGreaterThan(0);
  expect(got[0]).toMatchObject({ message: WAITING_TEXT });
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  const no = await declined;
  expect(no.isError).toBe(true);
  expect(resultJson(no).error.code).toBe('declined');
  await expect(counter).toHaveText('2');

  const allowed = app.client.callTool({ name: `${PLUGIN}__reset`, arguments: {} });
  await expect(dialog).toBeVisible();
  await expect(page.locator('#cf-cancel')).toBeFocused();
  await page.locator('#cf-confirm').click();
  await expect(dialog).toBeHidden();
  const yes = await allowed;
  expect(yes.isError, JSON.stringify(yes)).toBeFalsy();
  await expect(counter).toHaveText('0');
});

test('privacy Ask: the first read of the project asks "Let other apps read project …?" once, naming the app; Allow is remembered for every app', async ({ page, request }) => {
  const info = await appsOn(request, 'ask');
  const w = await openCounter(page, request);
  const dialog = modal(page);
  const app = await connect(info);
  // Before the project is allowed, the workspace's tools come without their own words.
  const before = Object.fromEntries((await app.client.listTools()).tools.map((t) => [t.name, t]));
  expect(before[`${PLUGIN}__get_count`].description).toBe("A tool of the Workspace demo workspace; its details show once you allow this project's data.");

  const first = app.client.callTool({ name: `${PLUGIN}__get_count`, arguments: {} });
  await expect(dialog).toBeVisible();
  await expect(page.locator('#cf-heading')).toHaveText(`Let other apps read project "${PROJECT_TITLE}"?`);
  await expect(page.locator('#cf-copy')).toContainText(`("${APP_NAME}", as it calls itself)`);
  await expect(page.locator('#cf-copy')).toContainText("This answer covers every app using Magnusim's tools.");
  await expect(page.locator('#cf-confirm')).toHaveText('Allow');
  await expect(page.locator('#cf-cancel')).toHaveText("Don't allow");
  await expect(page.locator('#cf-cancel')).toBeFocused();
  await page.locator('#cf-confirm').click();
  await expect(dialog).toBeHidden();
  const r = await first;
  expect(r.isError, JSON.stringify(r)).toBeFalsy();
  expect(resultJson(r)).toMatchObject({ ok: true, data: { count: 0 } });
  // Remembered: another app's calls ask nothing, and see the tools in full.
  const other = await connect(info, { name: 'Another App' });
  const listed = Object.fromEntries((await other.client.listTools()).tools.map((t) => [t.name, t]));
  expect(listed[`${PLUGIN}__get_count`].description).toBe('Read the counter.');
  expect((await other.client.callTool({ name: `${PLUGIN}__add`, arguments: { by: 1 } })).isError).toBeFalsy();
  await expect(w.frame.locator('#counter')).toHaveText('1');
  await expect(dialog).toBeHidden();
  expect((await getJson(request, '/api/assistant/status')).consents).toBe(1);
});

test('the workspace closing (Back) gives list_changed at the client, and the old name then gives unavailable with the hint', async ({ page, request }) => {
  const info = await appsOn(request, 'allow');
  await openCounter(page, request);
  const app = await connect(info);
  expect((await app.client.listTools()).tools.map((t) => t.name)).toEqual(expect.arrayContaining(TOOLS));
  expect(app.changes.n).toBe(0);
  await page.locator('#workspace-overlay [data-ws-back]').click();
  await expect(page.locator('#workspace-overlay')).toBeHidden();
  await expect.poll(() => app.changes.n, { timeout: 10_000, message: 'list_changed' }).toBe(1);
  const r = await app.client.callTool({ name: `${PLUGIN}__add`, arguments: { by: 1 } });
  expect(r.isError).toBe(true);
  expect(resultJson(r).error).toMatchObject({ code: 'unavailable', hint: TOOLS_CHANGED_HINT });
  // Listed again: no workspace tool.
  expect((await app.client.listTools()).tools.filter((t) => t.name.includes('__'))).toEqual([]);
  expect(app.changes.n).toBe(1);
});
