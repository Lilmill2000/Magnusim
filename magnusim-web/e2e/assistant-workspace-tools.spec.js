// Workspace tools for the Assistant, end to end (Foundation spec 8.4, 10.3): a scripted model
// (support/fake-llm.mjs, the first cloud dialect) → the server's turn loop → the page relay on
// the tab's event stream → the bridge → the plugin's frame → back. The test plugin ai-demo
// (python/tests/fixtures/assistant-plugins) keeps a counter in its page and offers seven tools:
// get_count, add, slow_add (progress every 200 ms until window.__release() in the frame),
// reset (destructive), mystery (a risk the host does not know), snap (a 64x64 PNG) and
// read_study (a 1 s window, waiting on the app's answer to its read of the study).
//
// Covered (spec 10.3's thirteen, then three more): the tools come and go with the workspace; the
// cloud privacy question once per project; an edit tool runs without asking; a destructive one
// (and mystery) asks with Don't focused, Enter answering it, and Stop closes the question; the
// second click of a double-click on Allow never answers the question asked right behind it; Stop,
// Back, a reload, a lost event stream and the plugin turned off (then a reconnect: a new link
// that sends nothing of the dead frame), each during a slow call; a call to the app in flight
// keeping a tool call alive past the server's stall window; a hidden tab kept for the call and
// the hold after it, then dormant (409 tab_hidden) and back when shown; two tabs; an image
// result; a remote viewer; a tab hidden at load; the terminal client
// (scripts/assistant-run.mjs) on the only connected tab.
// Each test asserts what the user sees (the counter, the app's dialog and its focus, the
// page's markers) and the protocol facts (the fake's requests, /tabs, the test state route).
// Its own server with the Assistant's test switches (a test home, never this PC's keys); the
// hold is 2 s (MAGNUSIM_TEST_ASSISTANT_HOLD_MS), a dropped link's tools are kept 60 s
// (MAGNUSIM_TEST_ASSISTANT_DORMANT_MS) so the dormant check is not a race. No test sleeps but
// the hidden tab's, which must outlast the page's own 3 s grace to show it holds, and the held
// read's, which must outlast the server's stall window (1 s + 10 s, then a 2 s grace) to show
// that it waits.
// SPDX-License-Identifier: GPL-3.0-or-later
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { startFakeLlm } from './support/fake-llm.mjs';
import { startHost, WEB_ROOT } from './support/host-server.mjs';
import { serverStream, setHidden } from './support/link-streams.js';
import { expect, test } from './support/stress.js';

const PLUGIN = 'ai-demo';
const PLUGIN_NAME = 'Workspace demo';
const TOOLS = ['add', 'get_count', 'mystery', 'read_study', 'reset', 'slow_add', 'snap'].map((n) => `${PLUGIN}__${n}`);
const GUIDE = 'The counter starts at 0 each time the workspace opens. Read it with get_count; add or slow_add change it; reset sets it to 0.';
const PROJECT_TITLE = 'Counter project';
const KEY = 'sk-ant-e2e-workspace-tools-0123456789abcdef';
const HOLD_MS = 2000;
/** The page's own grace before a hidden tab lets its stream go (src/api/eventHub.ts HIDDEN_GRACE_MS). */
const HIDDEN_GRACE_MS = 3000;
const STRICT_REFUSED = ['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'pattern', 'format', 'title'];
const TAB_HIDDEN_TEXT =
  "That tab isn't connected to the Assistant: its window is in the background or covered, or it was closed. Show the Magnusim window and try again.";
const PRIVACY_DENIED_TEXT =
  'Settings → Assistant is set to never send project data to a cloud provider. Ask from Home, use a local server, or change the setting.';

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

const chats = () => fake.requests().filter((r) => r.kind === 'chat');

test.beforeAll(async ({ request }) => {
  test.setTimeout(240_000);
  fake = await startFakeLlm();
  host = await startHost({
    name: 'assistant-ws-tools',
    pluginsFrom: 'python/tests/fixtures/assistant-plugins',
    env: {
      MAGNUSIM_TEST_ASSISTANT: '1',
      MAGNUSIM_TEST_ASSISTANT_PROVIDER_URL: fake.base,
      MAGNUSIM_TEST_EVENT_HUB: '1',
      MAGNUSIM_TEST_ASSISTANT_HOLD_MS: String(HOLD_MS),
      MAGNUSIM_TEST_ASSISTANT_DORMANT_MS: '60000',
    },
  });
  // The cloud providers go to the fake, or nothing here saves a key.
  const status = await getJson(request, '/api/assistant/status');
  expect(status.test_provider, 'the cloud providers go to the fake').toBe(true);
  expect(status.test_hold_ms).toBe(HOLD_MS);
  expect(status.test_dormant_ms).toBe(60_000);
  const pj = await postOk(request, '/api/project', { title: PROJECT_TITLE, folder: 'My Projects', units: 'Metric', category: 'Other' });
  project = pj.id;
  study = (await postOk(request, '/api/plugin-studies/create', { project_id: project, plugin: PLUGIN, kind: 'counter_case', title: 'Counter 1' })).study.id;
  await postOk(request, '/api/assistant/settings', { provider: 'anthropic' });
  await postOk(request, '/api/assistant/key', { provider: 'anthropic', key: KEY });
});

test.afterAll(async () => {
  if (host) host.stop();
  if (fake) await fake.stop();
});

test.beforeEach(async ({ request }) => {
  // No turn, question or conversation of an earlier test; consent asked afresh, then allowed
  // (the privacy test asks for itself).
  await postOk(request, '/api/test/assistant/reset', {});
  await postOk(request, '/api/assistant/settings', { provider: 'anthropic', privacy: 'allow', forget_consents: true });
});

test.afterEach(() => {
  // An answer left queued: the test's turns did not go as scripted. It fails here, by name;
  // after a failure Playwright replaces the worker, so the next test starts with a new fake
  // and a new server, and nothing queued here can answer its requests.
  expect(fake.pending(), 'scripted answers left unused').toBe(0);
});

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

/** The counter workspace's frame (Playwright Frame, for evaluate), once it connected. */
async function counterFrame(page) {
  let found = null;
  await expect
    .poll(
      async () => {
        for (const f of page.frames()) {
          if (f.isDetached() || !f.url().includes(`/plugins/${PLUGIN}/workspace/index.html`)) continue;
          if (await f.evaluate(() => !!window.__ws).catch(() => false)) {
            found = f;
            return true;
          }
        }
        return false;
      },
      { timeout: 60_000, message: 'the counter page connects' },
    )
    .toBe(true);
  return found;
}

/**
 * Opens the counter workspace of `sid` in `page` and waits until its tools are offered:
 * {frame (a FrameLocator), handle (the Frame), tab}. `available` false: the page's
 * registration is expected to be refused (remote).
 */
async function openCounter(page, request, { sid = study, available = true } = {}) {
  const tabOf = trackTab(page);
  await page.goto(api(`/#/p/${project}`));
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, project, { timeout: 60_000 });
  await page.evaluate((h) => {
    window.location.hash = h;
  }, `#/p/${project}/ws/${PLUGIN}/counter/${sid}`);
  const frame = page.frameLocator('#workspace-frame');
  await expect(page.locator('#workspace-overlay .ws-shell')).toHaveAttribute('data-workspace-connected', '1', { timeout: 60_000 });
  await expect(frame.locator('#ai-available')).toHaveText(available ? 'yes' : 'no', { timeout: 30_000 });
  const handle = await counterFrame(page);
  if (!available) return { frame, handle, tab: tabOf() };
  await expect.poll(tabOf, { message: "the tab's event stream" }).not.toBe('');
  const tab = tabOf();
  await expect.poll(async () => tabRow(request, tab).then((r) => (r ? `${r.connected}:${r.tools.length}` : 'none')), { timeout: 30_000 }).toBe(`true:${TOOLS.length}`);
  return { frame, handle, tab };
}

async function tabsNow(request) {
  const j = await getJson(request, '/api/assistant/tabs');
  return j.tabs;
}

async function tabRow(request, tab) {
  return (await tabsNow(request)).find((t) => t.tab === tab) || null;
}

async function relayState(request) {
  return getJson(request, '/api/test/assistant/state');
}

// ---------------------------------------------------------------- turns

/** Starts a turn (202) and follows its event log through the long-poll. */
async function startTurn(request, body) {
  const r = await request.post(api('/api/assistant/turns'), { data: body });
  const j = await r.json();
  expect(r.status(), JSON.stringify(j)).toBe(202);
  return followTurn(request, j.turn);
}

function followTurn(request, id) {
  const events = [];
  let next = 0;
  let summary = null;
  let ended = false;
  const pull = async (waitMs) => {
    const r = await request.get(api(`/api/assistant/turns/${id}?since=${next}&wait_ms=${Math.max(0, Math.floor(waitMs))}`), { timeout: 40_000 });
    expect(r.status()).toBe(200);
    const j = await r.json();
    events.push(...j.events);
    next = j.next;
    summary = j.turn;
    ended = j.ended;
  };
  return {
    id,
    events,
    /** The first event `pred` takes, within `ms`. */
    async waitFor(pred, what, ms = 30_000) {
      const until = Date.now() + ms;
      for (;;) {
        const hit = events.find(pred);
        if (hit) return hit;
        if (ended) throw new Error(`the turn ended before ${what}: ${JSON.stringify(events.slice(-8))}`);
        if (Date.now() > until) throw new Error(`no ${what} within ${ms} ms: ${JSON.stringify(events.slice(-8))}`);
        await pull(Math.min(5000, until - Date.now()));
      }
    },
    /** The events so far (asked now, without waiting for more). */
    async latest() {
      if (!ended) await pull(0);
      return events;
    },
    /** The turn's summary and events once it ended, within `ms`. */
    async ended(ms = 30_000) {
      const until = Date.now() + ms;
      while (!ended) {
        if (Date.now() > until) throw new Error(`the turn did not end within ${ms} ms: ${JSON.stringify(events.slice(-8))}`);
        await pull(Math.min(5000, until - Date.now()));
      }
      return { turn: summary, events };
    },
  };
}

const ofType = (events, type) => events.filter((e) => e.type === type);

/** The tool results the request carries in its last user message: [{tool, ok, data?, text?, error?, images}]. */
function resultsIn(req) {
  const user = [...req.body.messages].reverse().find((m) => m.role === 'user');
  return (Array.isArray(user.content) ? user.content : [])
    .filter((b) => b.type === 'tool_result')
    .map((b) => ({ ...JSON.parse(b.content[0].text), images: b.content.slice(1) }));
}

/** Schema keywords a strict tool may not use, anywhere in `schema`. */
function refusedKeywords(schema, path = '') {
  if (!schema || typeof schema !== 'object') return [];
  const out = STRICT_REFUSED.filter((k) => Object.hasOwn(schema, k)).map((k) => `${path || '(root)'}.${k}`);
  for (const [name, sub] of Object.entries(schema.properties || {})) out.push(...refusedKeywords(sub, `${path}.${name}`));
  if (schema.items) out.push(...refusedKeywords(schema.items, `${path}[]`));
  return out;
}

const modal = (page) => page.locator('#modal-confirm');

/** A slow call runs in the page: its progress reached the turn and the page shows it running. */
async function slowRunning(t, w, by) {
  const call = await t.waitFor((e) => e.type === 'tool_call' && e.tool === `${PLUGIN}__slow_add`, 'the slow call');
  const progress = await t.waitFor((e) => e.type === 'tool_progress' && e.call === call.call && e.label.startsWith(`Adding ${by}: step`), 'its progress label');
  await expect(w.frame.locator('#slow')).toHaveText('running');
  return { call, progress };
}

// ---------------------------------------------------------------- tests

test('the tools come and go with the workspace: /tabs lists them all, the first request carries them sorted with no limit keyword, Back takes them away', async ({
  page,
  request,
}) => {
  const w = await openCounter(page, request);
  const row = await tabRow(request, w.tab);
  expect(row).toMatchObject({
    connected: true,
    tools: TOOLS,
    refused: [],
    active_turns: 0,
    workspace: { project_id: project, plugin: PLUGIN, plugin_name: PLUGIN_NAME, workspace: 'counter', study_id: study },
  });
  expect(typeof row.since).toBe('number');
  expect((await relayState(request)).links[w.tab]).toMatchObject({ connected: true, tools: TOOLS.length, pending: 0 });

  const before = chats().length;
  fake.reply({ text: 'Hello.' });
  const t = await startTurn(request, { text: 'Say hello.', tab: w.tab });
  const { turn } = await t.ended();
  expect(turn).toMatchObject({ state: 'done', tab: w.tab, project_id: project });
  const sent = chats()[before].body;
  const names = sent.tools.map((x) => x.name);
  const hostTools = names.filter((n) => !n.includes('__'));
  // The host's own tools first, then the workspace's, each by name.
  expect(names).toEqual([...[...hostTools].sort(), ...TOOLS]);
  for (const tool of sent.tools) {
    expect(tool.strict, tool.name).toBe(true);
    expect(refusedKeywords(tool.input_schema), tool.name).toEqual([]);
  }
  // A limit reaches the model as words.
  const add = sent.tools.find((x) => x.name === `${PLUGIN}__add`);
  expect(add.input_schema.properties.by.description).toMatch(/-100.*100/);
  // The workspace's fixed notes are the second system block.
  expect(sent.system.map((s) => s.text).join('\n')).toContain(GUIDE);

  await page.locator('#workspace-overlay [data-ws-back]').click();
  await expect(page.locator('#workspace-overlay')).toBeHidden();
  await expect.poll(async () => tabRow(request, w.tab)).toBeNull();
  expect((await tabsNow(request)).filter((r) => r.connected)).toEqual([]);
  expect((await relayState(request)).links[w.tab] || { tools: 0 }).toMatchObject({ tools: 0 });
});

test('cloud privacy is asked once per project: Enter sends nothing, Send runs and is remembered, Never send refuses the turn', async ({ page, request }) => {
  await postOk(request, '/api/assistant/settings', { privacy: 'ask', forget_consents: true });
  const w = await openCounter(page, request);
  const dialog = modal(page);
  const before = chats().length;

  // Enter on the question: Don't send.
  const t1 = await startTurn(request, { text: 'Read the counter.', tab: w.tab });
  await expect(dialog).toBeVisible();
  await expect(page.locator('#cf-heading')).toHaveText(`Send project "${PROJECT_TITLE}" to Anthropic?`);
  await expect(page.locator('#cf-confirm')).toHaveText('Send');
  await expect(page.locator('#cf-cancel')).toHaveText("Don't send");
  await expect(page.locator('#cf-cancel')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  const e1 = await t1.ended();
  expect(e1.turn).toMatchObject({ state: 'stopped', end_reason: 'privacy', message: 'Nothing was sent.' });
  expect(ofType(e1.events, 'gate')[0].gate).toMatchObject({ kind: 'privacy', yes: 'Send', no: "Don't send" });
  expect(ofType(e1.events, 'gate_closed')[0]).toMatchObject({ answer: 'deny', by: 'user' });
  expect(chats().length, 'nothing reached the provider').toBe(before);

  // Send, by a click: the turn runs.
  fake.reply({ text: 'The counter is 0.' });
  const t2 = await startTurn(request, { text: 'Read the counter.', tab: w.tab });
  await expect(dialog).toBeVisible();
  await page.locator('#cf-confirm').click();
  await expect(dialog).toBeHidden();
  expect((await t2.ended()).turn.state).toBe('done');
  expect(chats().length).toBe(before + 1);

  // Remembered for this project: no question.
  fake.reply({ text: 'Still 0.' });
  const t3 = await startTurn(request, { text: 'Read the counter again.', tab: w.tab });
  const e3 = await t3.ended();
  expect(e3.turn.state).toBe('done');
  expect(ofType(e3.events, 'gate')).toEqual([]);
  await expect(dialog).toBeHidden();
  expect((await getJson(request, '/api/assistant/status')).consents).toBe(1);

  // Never send: refused before the turn starts.
  await postOk(request, '/api/assistant/settings', { privacy: 'deny' });
  const r = await request.post(api('/api/assistant/turns'), { data: { text: 'Read the counter.', tab: w.tab } });
  expect(r.status()).toBe(400);
  expect(await r.json()).toMatchObject({ ok: false, code: 'privacy_denied', error: PRIVACY_DENIED_TEXT });
  expect(chats().length).toBe(before + 2);
});

test('an edit tool runs without asking: the counter reads 2 and the model gets its result', async ({ page, request }) => {
  const w = await openCounter(page, request);
  const before = chats().length;
  fake.reply({ tools: [{ name: `${PLUGIN}__add`, input: { by: 2 } }] }, { text: 'The counter is 2.' });
  const t = await startTurn(request, { text: 'Add 2 to the counter.', tab: w.tab });
  const { turn, events } = await t.ended();
  expect(turn.state).toBe('done');
  await expect(w.frame.locator('#counter')).toHaveText('2');
  await expect(modal(page)).toBeHidden();
  expect(ofType(events, 'gate')).toEqual([]);
  // The person reads the workspace's title, the model its key.
  expect(ofType(events, 'tool_call')[0]).toMatchObject({ tool: `${PLUGIN}__add`, risk: 'edit', source: `${PLUGIN_NAME} (Counter)` });
  expect(chats()[before].body.messages[0].content.map((b) => b.text).join(' ')).toContain('"workspace":"counter"');
  expect(ofType(events, 'tool_result')[0]).toMatchObject({ ok: true });
  expect(resultsIn(chats()[before + 1])).toEqual([{ tool: `${PLUGIN}__add`, ok: true, text: 'The counter is 2.', data: { count: 2 }, images: [] }]);
  // The page got the turn's id with the call.
  expect(await w.handle.evaluate(() => window.__aiCalls.map((c) => [c.tool, c.turn]))).toEqual([['add', t.id]]);
});

test("a destructive tool asks first with Don't focused: Enter answers Don't, a click on Allow runs it; mystery asks too", async ({ page, request }) => {
  const w = await openCounter(page, request);
  const dialog = modal(page);
  const before = chats().length;

  fake.reply({ tools: [{ name: `${PLUGIN}__add`, input: { by: 2 } }] }, { tools: [{ name: `${PLUGIN}__reset`, input: {} }] }, { text: 'I left it at 2.' });
  const t1 = await startTurn(request, { text: 'Add 2, then reset the counter.', tab: w.tab });
  await expect(dialog).toBeVisible();
  await expect(w.frame.locator('#counter')).toHaveText('2');
  await expect(page.locator('#cf-heading')).toHaveText('Allow the Assistant to reset the counter?');
  await expect(page.locator('#cf-copy')).toHaveText(`${PLUGIN_NAME} (Counter) · can't be undone. What it sent: {}. Nothing runs until you choose.`);
  await expect(page.locator('#cf-confirm')).toHaveText('Allow');
  await expect(page.locator('#cf-cancel')).toHaveText("Don't");
  await expect(page.locator('#cf-cancel')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  const e1 = await t1.ended();
  expect(e1.turn.state).toBe('done');
  await expect(w.frame.locator('#counter')).toHaveText('2');
  expect(ofType(e1.events, 'gate')[0].gate).toMatchObject({ kind: 'confirm', risk: 'destructive', tool: `${PLUGIN}__reset` });
  const declined = resultsIn(chats()[before + 2]);
  expect(declined).toEqual([expect.objectContaining({ tool: `${PLUGIN}__reset`, ok: false, error: expect.objectContaining({ code: 'declined' }) })]);
  expect(await w.handle.evaluate(() => window.__aiCalls.map((c) => c.tool))).toEqual(['add']);

  fake.reply({ tools: [{ name: `${PLUGIN}__reset`, input: {} }] }, { text: 'Reset.' });
  const t2 = await startTurn(request, { text: 'Reset the counter.', tab: w.tab });
  await expect(dialog).toBeVisible();
  await expect(page.locator('#cf-cancel')).toBeFocused();
  await page.locator('#cf-confirm').click();
  expect((await t2.ended()).turn.state).toBe('done');
  await expect(w.frame.locator('#counter')).toHaveText('0');

  // A risk the host does not know counts as destructive: it asks too.
  fake.reply({ tools: [{ name: `${PLUGIN}__mystery`, input: {} }] }, { text: 'Nothing happened.' });
  const t3 = await startTurn(request, { text: 'Do the mystery thing.', tab: w.tab });
  await expect(dialog).toBeVisible();
  await expect(page.locator('#cf-heading')).toHaveText('Allow the Assistant to do the mystery thing?');
  await expect(page.locator('#cf-cancel')).toBeFocused();
  await page.locator('#cf-confirm').click();
  const e3 = await t3.ended();
  expect(e3.turn.state).toBe('done');
  expect(ofType(e3.events, 'gate')[0].gate).toMatchObject({ risk: 'destructive', tool: `${PLUGIN}__mystery` });
  expect(ofType(e3.events, 'tool_call')[0]).toMatchObject({ risk: 'destructive' });
  expect(await w.handle.evaluate(() => window.__aiCalls.map((c) => c.tool))).toEqual(['add', 'reset', 'mystery']);

  // Stop while the question is open: it closes unanswered, and nothing runs.
  fake.reply({ tools: [{ name: `${PLUGIN}__reset`, input: {} }] });
  const t4 = await startTurn(request, { text: 'Reset the counter.', tab: w.tab });
  await expect(dialog).toBeVisible();
  await postOk(request, `/api/assistant/turns/${t4.id}/stop`, {});
  await expect(dialog).toBeHidden();
  const e4 = await t4.ended();
  expect(e4.turn.state).toBe('stopped');
  expect(ofType(e4.events, 'gate_closed')[0]).toMatchObject({ answer: 'deny', by: 'stop' });
  expect(ofType(e4.events, 'tool_result')[0]).toMatchObject({ ok: false, code: 'stopped' });
  expect(await w.handle.evaluate(() => window.__aiCalls.length)).toBe(3);
});

test('a double-click on Allow answers one question only: the one asked right behind it, under the pointer, stays open until a click of its own', async ({ page, request }) => {
  const w = await openCounter(page, request);
  const dialog = modal(page);
  const before = chats().length;
  fake.reply({ tools: [{ name: `${PLUGIN}__reset`, input: {} }, { name: `${PLUGIN}__mystery`, input: {} }] }, { text: 'Reset; the mystery thing is not done.' });
  const t = await startTurn(request, { text: 'Reset the counter, then do the mystery thing.', tab: w.tab });
  await expect(page.locator('#cf-heading')).toHaveText('Allow the Assistant to reset the counter?');
  // Allow is off for its first moment on screen.
  await expect(page.locator('#cf-confirm')).toBeEnabled();
  const centre = async () => {
    const box = await page.locator('#cf-confirm').boundingBox();
    return [box.x + box.width / 2, box.y + box.height / 2];
  };
  // A double-click: its first click allows reset ...
  await page.mouse.click(...(await centre()));
  // ... the next question opens in its place, and the double-click's second click lands on its Allow.
  await expect(page.locator('#cf-heading')).toHaveText('Allow the Assistant to do the mystery thing?');
  await page.mouse.move(...(await centre()));
  await page.mouse.down({ clickCount: 2 });
  await page.mouse.up({ clickCount: 2 });
  await expect(dialog).toBeVisible();
  expect(ofType(await t.latest(), 'gate_closed').map((e) => e.answer)).toEqual(['allow']);
  expect(await w.handle.evaluate(() => window.__aiCalls.map((c) => c.tool))).toEqual(['reset']);
  // Only a click of its own answers it (the press may have taken the focus from Don't; Enter answers Don't anyway).
  await page.locator('#cf-cancel').click();
  await expect(dialog).toBeHidden();
  const { turn, events } = await t.ended();
  expect(turn.state).toBe('done');
  expect(ofType(events, 'gate_closed').map((e) => [e.answer, e.by])).toEqual([
    ['allow', 'user'],
    ['deny', 'user'],
  ]);
  expect(resultsIn(chats()[before + 1]).map((r) => [r.tool, r.ok ? 'ok' : r.error.code])).toEqual([
    [`${PLUGIN}__reset`, 'ok'],
    [`${PLUGIN}__mystery`, 'declined'],
  ]);
  expect(await w.handle.evaluate(() => window.__aiCalls.map((c) => c.tool))).toEqual(['reset']);
});

test('Stop during a slow tool: its progress shows, the page aborts it, the counter is unchanged, the turn ends stopped', async ({ page, request }) => {
  const w = await openCounter(page, request);
  fake.reply({ tools: [{ name: `${PLUGIN}__slow_add`, input: { by: 5 } }] });
  const t = await startTurn(request, { text: 'Add 5 slowly.', tab: w.tab });
  const { call } = await slowRunning(t, w, 5);
  expect((await relayState(request)).links[w.tab]).toMatchObject({ pending: 1 });
  const stopAt = Date.now();
  const r = await postOk(request, `/api/assistant/turns/${t.id}/stop`, {});
  expect(r.turn.state).toBe('stopped');
  await expect(w.frame.locator('#aborted')).toHaveText('aborted');
  const { turn, events } = await t.ended();
  expect(Date.now() - stopAt, 'stopped within the 10 s ceiling').toBeLessThan(10_000);
  expect(turn).toMatchObject({ state: 'stopped', end_reason: 'user' });
  expect(ofType(events, 'tool_result').find((e) => e.call === call.call)).toMatchObject({ ok: false, code: 'stopped' });
  await expect(w.frame.locator('#counter')).toHaveText('0');
  await expect.poll(async () => (await relayState(request)).links[w.tab].pending).toBe(0);
});

test("a call to the app in flight keeps a tool call alive past the server's stall window: read_study waits on a held read of its study", async ({ page, request }) => {
  // About 15 s of it is the wait past the server's window, on top of the usual.
  test.setTimeout(120_000);
  const w = await openCounter(page, request);
  const before = chats().length;
  // The page's read of the study waits until the test lets it go.
  let letGo = () => undefined;
  const held = new Promise((done) => {
    letGo = done;
  });
  let heldAt = 0;
  const STUDY_READ = /\/api\/plugin-studies\/get\?/;
  await page.route(STUDY_READ, async (route) => {
    heldAt ||= Date.now();
    await held;
    await route.continue();
  });
  // The page's signs of life: bare progress POSTs (no ack, no label).
  const bare = [];
  page.on('request', (r) => {
    if (r.method() !== 'POST' || new URL(r.url()).pathname !== '/api/assistant/relay/progress') return;
    const body = r.postDataJSON();
    if (!body.ack && body.label === undefined && body.fraction === null) bare.push(Date.now());
  });
  try {
    fake.reply({ tools: [{ name: `${PLUGIN}__read_study`, input: {} }] }, { text: 'It is Counter 1.' });
    const t = await startTurn(request, { text: "Read the study's title.", tab: w.tab });
    const call = await t.waitFor((e) => e.type === 'tool_call' && e.tool === `${PLUGIN}__read_study`, 'the call');
    await expect.poll(() => heldAt, { message: 'the page reads the study' }).toBeGreaterThan(0);
    // The tool's own window is 1 s; the server's is 11 s (+10 s), and a stall there then waits
    // 2 s for the page's last answer before the call fails. Past all that, with the read held:
    const SERVER_STALL_FAILS_MS = 1000 + 10_000 + 2000;
    await page.waitForTimeout(Math.max(0, heldAt + SERVER_STALL_FAILS_MS + 2000 - Date.now()));
    expect(ofType(await t.latest(), 'tool_result'), 'not stalled while its read is held').toEqual([]);
    expect((await relayState(request)).links[w.tab]).toMatchObject({ pending: 1 });
    expect(bare.length, 'signs of life went to the server').toBeGreaterThanOrEqual(2);
    // They hold the window and add no row to the turn's log.
    expect(ofType(t.events, 'tool_progress')).toEqual([]);
    letGo();
    const result = await t.waitFor((e) => e.type === 'tool_result' && e.call === call.call, 'the result', 10_000);
    expect(result).toMatchObject({ ok: true });
    expect((await t.ended()).turn.state).toBe('done');
    expect(resultsIn(chats()[before + 1])).toEqual([
      { tool: `${PLUGIN}__read_study`, ok: true, text: 'The study is Counter 1.', data: { title: 'Counter 1' }, images: [] },
    ]);
  } finally {
    letGo();
    // A read still held when the test failed may outlive the page: nothing to report then.
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  }
});

test('Back during a tool call: the call ends "its page closed", the workspace closes with no stall card, the turn goes on to done', async ({ page, request }) => {
  const w = await openCounter(page, request);
  const before = chats().length;
  fake.reply({ tools: [{ name: `${PLUGIN}__slow_add`, input: { by: 5 } }] }, { text: 'Its page closed.' });
  const t = await startTurn(request, { text: 'Add 5 slowly.', tab: w.tab });
  const { call } = await slowRunning(t, w, 5);
  await page.locator('#workspace-overlay [data-ws-back]').click();
  await expect(page.locator('#workspace-overlay')).toBeHidden();
  const { turn, events } = await t.ended();
  expect(turn.state).toBe('done');
  const result = ofType(events, 'tool_result').find((e) => e.call === call.call);
  expect(result).toMatchObject({ ok: false, code: 'closed' });
  // The page's own end (the host bridge's words, as the page sent it before withdrawing its tools):
  // the call ran until then, so like the server's own text it may or may not have finished.
  expect(result.summary).toBe('its page closed before the tool finished; it may or may not have finished');
  expect(resultsIn(chats()[before + 1])[0]).toMatchObject({ ok: false, error: { code: 'closed' } });
  // No leave card and no error card: the workspace simply closed.
  await expect(page.locator('[data-ws-leave], [data-ws-error]')).toHaveCount(0);
  await expect.poll(async () => tabRow(request, w.tab)).toBeNull();
});

test('a reload during a tool call fails it as disconnected at once; the reloaded page registers again', async ({ page, request }) => {
  const w = await openCounter(page, request);
  fake.reply({ tools: [{ name: `${PLUGIN}__slow_add`, input: { by: 5 } }] }, { text: 'It disconnected.' });
  const t = await startTurn(request, { text: 'Add 5 slowly.', tab: w.tab });
  const { call } = await slowRunning(t, w, 5);
  const tabOf = trackTab(page);
  // The clock runs from the reload to the failed call, with the wait started at the same time:
  // the old page's stream ends when the new document commits, long before the app loads again.
  let failedAt = 0;
  const reloadAt = Date.now();
  const [result] = await Promise.all([
    t.waitFor((e) => e.type === 'tool_result' && e.call === call.call, 'the call fails', 10_000).then((e) => {
      failedAt = Date.now();
      return e;
    }),
    page.reload({ waitUntil: 'commit' }),
  ]);
  expect(failedAt - reloadAt, 'within the 10 s ceiling').toBeLessThan(10_000);
  expect(result).toMatchObject({ ok: false, code: 'tab_disconnected' });
  expect(result.summary).toBe('The page hosting Counter disconnected while the tool ran; it may or may not have finished. Read its state again before retrying.');
  expect((await t.ended()).turn.state).toBe('done');
  // The reloaded page is a new tab, and registers again.
  await expect(page.frameLocator('#workspace-frame').locator('#ai-available')).toHaveText('yes', { timeout: 60_000 });
  await expect.poll(tabOf).not.toBe('');
  expect(tabOf()).not.toBe(w.tab);
  await expect.poll(async () => tabRow(request, tabOf()).then((r) => (r ? `${r.connected}:${r.tools.length}` : 'none')), { timeout: 30_000 }).toBe(`true:${TOOLS.length}`);
});

test('a lost event stream during a tool call fails it as disconnected; the registration is back after the reconnect, on a new link', async ({ page, request }) => {
  const w = await openCounter(page, request);
  fake.reply({ tools: [{ name: `${PLUGIN}__slow_add`, input: { by: 5 } }] }, { text: 'It disconnected.' });
  const t = await startTurn(request, { text: 'Add 5 slowly.', tab: w.tab });
  const { call } = await slowRunning(t, w, 5);
  const revBefore = (await relayState(request)).links[w.tab].rev;
  const dropped = await postOk(request, '/api/test/event-hub/drop', { tab: w.tab });
  expect(dropped.dropped).toBe(1);
  const result = await t.waitFor((e) => e.type === 'tool_result' && e.call === call.call, 'the call fails', 10_000);
  expect(result).toMatchObject({ ok: false, code: 'tab_disconnected' });
  // The page stopped its call too.
  await expect(w.frame.locator('#aborted')).toHaveText('aborted');
  expect((await t.ended()).turn.state).toBe('done');
  // Reconnected: a new link, the list posted again (a higher rev), connected with all its tools.
  await expect.poll(async () => tabRow(request, w.tab).then((r) => (r ? `${r.connected}:${r.tools.length}` : 'none')), { timeout: 30_000 }).toBe(`true:${TOOLS.length}`);
  expect((await relayState(request)).links[w.tab].rev).toBeGreaterThan(revBefore);
  await expect(w.frame.locator('#counter')).toHaveText('0');
});

test('the plugin turned off during a tool call ends it at once; its tools never come back without a new page, not on a new link either', async ({ page, request }) => {
  // Counts the `linked` frames this page gets, a new link of its assistant channel each. The
  // app's own listener runs in the same dispatch, right after this one: once the test sees the
  // count move, the app has taken the new link and sent whatever it sends on one.
  await page.addInitScript(() => {
    window.__linked = 0;
    const Real = window.EventSource;
    if (!Real) return;
    window.EventSource = class extends Real {
      constructor(...args) {
        super(...args);
        this.addEventListener('linked', () => {
          window.__linked += 1;
        });
      }
    };
  });
  const w = await openCounter(page, request);
  fake.reply({ tools: [{ name: `${PLUGIN}__slow_add`, input: { by: 5 } }] });
  const t = await startTurn(request, { text: 'Add 5 slowly.', tab: w.tab });
  const { call } = await slowRunning(t, w, 5);
  // A question of another turn on this tab (a destructive tool's) stays open across the plugin
  // going off: the page keeps its assistant channel for it, so the stream drop below is a real
  // reconnect, with a new link. (Not a privacy question: privacy is read live, so asking for one
  // by changing the setting would make the running turn ask again too.)
  fake.reply({ tools: [{ name: `${PLUGIN}__reset`, input: {} }] });
  const asking = await startTurn(request, { text: 'Reset the counter.', tab: w.tab });
  await expect(modal(page)).toBeVisible();
  await expect(page.locator('#cf-heading')).toHaveText('Allow the Assistant to reset the counter?');
  // The next requests: the slow turn's once its call failed, then the asking one's after its No.
  fake.reply({ text: 'It was turned off.' }, { text: 'I left it.' });
  const assistantChannels = async () => ((await serverStream(request, host, w.tab)) || { kinds: {} }).kinds.assistant || 0;
  const registerAgain = () => w.handle.evaluate(() => window.__register());
  // Every list this page sends from here on: none may be, until a new page.
  const listsSent = [];
  const onRequest = (r) => {
    if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/assistant/relay/tools') listsSent.push(r.postDataJSON());
  };
  page.on('request', onRequest);
  let off = false;
  try {
    await postOk(request, `/api/plugins/${PLUGIN}/disable`, {});
    off = true;
    const result = await t.waitFor((e) => e.type === 'tool_result' && e.call === call.call, 'the call fails', 10_000);
    expect(result).toMatchObject({ ok: false, code: 'plugin_off' });
    expect(result.summary).toBe(`${PLUGIN_NAME} was turned off or replaced while the tool ran; it may or may not have finished.`);
    expect((await relayState(request)).links[w.tab]).toMatchObject({ pending: 0, tools: 0 });
    // The page stopped its call too.
    await expect(w.frame.locator('#aborted')).toHaveText('aborted');
    await expect(w.frame.locator('#counter')).toHaveText('0');
    expect((await t.ended()).turn.state).toBe('done');
    expect(await tabRow(request, w.tab)).toBeNull();
    expect(await assistantChannels(), 'kept for the open question').toBe(1);

    // The stream drops and comes back: on the new link the page sends nothing of the dead frame,
    // and the server lists nothing of it.
    const linked = await page.evaluate(() => window.__linked);
    expect(linked, 'the page counted its first link').toBeGreaterThanOrEqual(1);
    expect((await postOk(request, '/api/test/event-hub/drop', { tab: w.tab })).dropped).toBe(1);
    await page.waitForFunction((n) => window.__linked > n, linked, { polling: 100, timeout: 30_000 });
    expect((await relayState(request)).links[w.tab]).toMatchObject({ connected: true, pending: 0, tools: 0 });
    expect(await tabRow(request, w.tab)).toBeNull();
    expect(listsSent, 'no list sent on the new link').toEqual([]);
    // The question came back on the new link: still one dialog, answered there.
    await expect(modal(page)).toBeVisible();
    await page.locator('#cf-cancel').click();
    await expect(modal(page)).toBeHidden();
    expect((await asking.ended()).turn.state).toBe('done');
    await expect(w.frame.locator('#counter')).toHaveText('0');
    // With nothing of this page left on the server, its channel goes; the frame registering
    // again is refused in the page.
    await expect.poll(assistantChannels, { timeout: 15_000 }).toBe(0);
    expect(await registerAgain()).toMatchObject({ available: false, reason: 'plugin_off' });
    await expect(w.frame.locator('#ai-available')).toHaveText('no');
    expect(await tabRow(request, w.tab)).toBeNull();
    expect(await assistantChannels()).toBe(0);
  } finally {
    if (off) {
      await postOk(request, `/api/plugins/${PLUGIN}/enable`, {});
      await postOk(request, '/api/worker', { method: 'registry.reload', params: {} });
    }
  }
  // Turned on again: that frame's tools still don't come back; a new page's do.
  expect(await registerAgain()).toMatchObject({ available: false, reason: 'plugin_off' });
  expect(await tabRow(request, w.tab)).toBeNull();
  expect(listsSent, 'nothing of the dead frame was ever sent again').toEqual([]);
  page.off('request', onRequest);
  const tabOf = trackTab(page);
  await page.reload();
  await expect(page.frameLocator('#workspace-frame').locator('#ai-available')).toHaveText('yes', { timeout: 60_000 });
  await expect.poll(tabOf).not.toBe('');
  await expect.poll(async () => tabRow(request, tabOf()).then((r) => (r ? `${r.connected}:${r.tools.length}` : 'none')), { timeout: 30_000 }).toBe(`true:${TOOLS.length}`);
});

test('a hidden tab keeps its stream for a running call and for the hold after the turn, then lets it go: dormant, 409 tab_hidden; shown again, its tools are back', async ({
  page,
  request,
}) => {
  const w = await openCounter(page, request);
  fake.reply({ tools: [{ name: `${PLUGIN}__slow_add`, input: { by: 4 } }] }, { text: 'Added 4.' });
  const t = await startTurn(request, { text: 'Add 4 slowly.', tab: w.tab });
  const { call } = await slowRunning(t, w, 4);
  const assistantChannels = async () => ((await serverStream(request, host, w.tab)) || { kinds: {} }).kinds.assistant || 0;

  // Hidden while the call runs: past the page's own grace, the channel is still there.
  await setHidden(page, true);
  await page.waitForTimeout(HIDDEN_GRACE_MS + 1000);
  expect(await assistantChannels(), 'kept while the call runs').toBe(1);
  expect(await w.handle.evaluate(() => window.__release())).toBe(true);
  const result = await t.waitFor((e) => e.type === 'tool_result' && e.call === call.call, 'the result', 10_000);
  expect(result).toMatchObject({ ok: true });
  const { turn } = await t.ended();
  expect(turn.state).toBe('done');
  await expect(w.frame.locator('#counter')).toHaveText('4');

  // The turn ended: the hold keeps the stream 2 s, then the page's grace lets it go.
  const row = await tabRow(request, w.tab);
  expect(row).toMatchObject({ connected: true, active_turns: 0 });
  expect(row.hold_until).toBeGreaterThan(Date.now() - 1000);
  expect(await assistantChannels(), 'kept for the hold').toBe(1);
  await expect.poll(assistantChannels, { timeout: 15_000, intervals: [100], message: 'let go after the hold and the grace' }).toBe(0);
  expect(Date.now(), 'not before the hold and the grace').toBeGreaterThanOrEqual(row.hold_until + HIDDEN_GRACE_MS - 500);
  await expect.poll(async () => (await tabRow(request, w.tab))?.connected).toBe(false);
  expect((await tabRow(request, w.tab)).tools).toEqual(TOOLS);
  const r = await request.post(api('/api/assistant/turns'), { data: { text: 'Read the counter.', tab: w.tab } });
  expect(r.status()).toBe(409);
  expect(await r.json()).toMatchObject({ ok: false, code: 'tab_hidden', error: TAB_HIDDEN_TEXT });

  // Shown again: the stream opens, the relay links and registers again.
  await setHidden(page, false);
  await expect.poll(async () => tabRow(request, w.tab).then((x) => (x ? `${x.connected}:${x.tools.length}` : 'none')), { timeout: 30_000 }).toBe(`true:${TOOLS.length}`);
});

test('two tabs: a turn bound to one changes only that one', async ({ page, request, context }) => {
  const a = await openCounter(page, request);
  const other = await context.newPage();
  try {
    const b = await openCounter(other, request);
    expect(b.tab).not.toBe(a.tab);
    fake.reply({ tools: [{ name: `${PLUGIN}__add`, input: { by: 3 } }] }, { text: 'Added 3.' });
    expect((await (await startTurn(request, { text: 'Add 3.', tab: a.tab })).ended()).turn.state).toBe('done');
    await expect(a.frame.locator('#counter')).toHaveText('3');
    await expect(b.frame.locator('#counter')).toHaveText('0');
    fake.reply({ tools: [{ name: `${PLUGIN}__add`, input: { by: -1 } }] }, { text: 'Took 1 away.' });
    expect((await (await startTurn(request, { text: 'Take 1 away.', tab: b.tab })).ended()).turn.state).toBe('done');
    await expect(b.frame.locator('#counter')).toHaveText('-1');
    await expect(a.frame.locator('#counter')).toHaveText('3');
    // A question of a turn bound to B shows in B only.
    fake.reply({ tools: [{ name: `${PLUGIN}__reset`, input: {} }] }, { text: 'Reset.' });
    const t = await startTurn(request, { text: 'Reset the counter.', tab: b.tab });
    await expect(modal(other)).toBeVisible();
    await expect(other.locator('#cf-cancel')).toBeFocused();
    await expect(modal(page)).toBeHidden();
    await other.locator('#cf-confirm').click();
    expect((await t.ended()).turn.state).toBe('done');
    await expect(b.frame.locator('#counter')).toHaveText('0');
    await expect(a.frame.locator('#counter')).toHaveText('3');
    await expect(modal(page)).toBeHidden();
    expect(await a.handle.evaluate(() => window.__aiCalls.length)).toBe(1);
    expect(await b.handle.evaluate(() => window.__aiCalls.length)).toBe(2);
  } finally {
    await other.close();
  }
});

test('an image result: snap puts a 64x64 PNG block in the next request', async ({ page, request }) => {
  const w = await openCounter(page, request);
  const before = chats().length;
  fake.reply({ tools: [{ name: `${PLUGIN}__snap`, input: {} }] }, { text: 'A picture of 0.' });
  const t = await startTurn(request, { text: 'Show me the counter.', tab: w.tab });
  const { turn, events } = await t.ended();
  expect(turn.state).toBe('done');
  expect(ofType(events, 'tool_result')[0]).toMatchObject({ ok: true, summary: 'Done (1 image)' });
  const [result] = resultsIn(chats()[before + 1]);
  expect(result).toMatchObject({ tool: `${PLUGIN}__snap`, ok: true, text: 'A picture of the counter (0).' });
  expect(result.images).toHaveLength(1);
  expect(result.images[0]).toMatchObject({ type: 'image', source: { type: 'base64', media_type: 'image/png' } });
  const png = Buffer.from(result.images[0].source.data, 'base64');
  expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([64, 64]);
});

test('a remote viewer: the page hears its tools are not available, and nothing registers', async ({ browser, request }) => {
  const context = await browser.newContext();
  try {
    // Every API request of this browser comes through a proxy, as over the public tunnel (the
    // proxy adds the header, so the browser's own requests stay as they are).
    await context.route(/\/api\//, (route) => route.continue({ headers: { ...route.request().headers(), 'x-forwarded-for': '203.0.113.9' } }));
    const page = await context.newPage();
    const before = Object.keys((await relayState(request)).links);
    const w = await openCounter(page, request, { available: false });
    await expect(w.frame.locator('#ai-reason')).toHaveText('remote');
    // The server sees this page as remote.
    const seen = await page.evaluate(async () => {
      const r = await fetch('/api/assistant/status', { cache: 'no-store' });
      return { status: r.status, reason: (await r.json()).reason };
    });
    expect(seen).toEqual({ status: 403, reason: 'remote' });
    const after = await relayState(request);
    expect(Object.keys(after.links).filter((tab) => !before.includes(tab))).toEqual([]);
    if (w.tab) expect(((await serverStream(request, host, w.tab)) || { kinds: {} }).kinds.assistant || 0).toBe(0);
    expect((await tabsNow(request)).filter((r) => r.tab === w.tab)).toEqual([]);
  } finally {
    await context.close();
  }
});

test('a tab hidden at load: its page hears not_connected and registers again once shown', async ({ page, request }) => {
  // The window opens in the background: the page and its frame say hidden from the start.
  await page.addInitScript(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
  });
  const tabOf = trackTab(page);
  await page.goto(api(`/#/p/${project}`));
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, project, { timeout: 60_000 });
  await page.evaluate((h) => {
    window.location.hash = h;
  }, `#/p/${project}/ws/${PLUGIN}/counter/${study}`);
  const frame = page.frameLocator('#workspace-frame');
  await expect(page.locator('#workspace-overlay .ws-shell')).toHaveAttribute('data-workspace-connected', '1', { timeout: 60_000 });
  // No stream while hidden, so no link: the bridge's 5 s bound answers not_connected.
  await expect(frame.locator('#ai-available')).toHaveText('no', { timeout: 30_000 });
  await expect(frame.locator('#ai-reason')).toHaveText('not_connected');
  expect(tabOf(), 'no event stream while hidden').toBe('');
  const handle = await counterFrame(page);
  // Shown: both documents say so, and the page registers again by itself.
  await setHidden(page, false);
  await setHidden(handle, false);
  await expect(frame.locator('#ai-available')).toHaveText('yes', { timeout: 30_000 });
  await expect.poll(tabOf).not.toBe('');
  await expect.poll(async () => tabRow(request, tabOf()).then((r) => (r ? `${r.connected}:${r.tools.length}` : 'none')), { timeout: 30_000 }).toBe(`true:${TOOLS.length}`);
  // One registration, from this page's second list (its first was abandoned at the 5 s bound).
  expect((await relayState(request)).links[tabOf()]).toMatchObject({ connected: true, tools: TOOLS.length });
});

test('the terminal client binds a turn to the only connected tab (--tab auto); its question shows in the app too, and the app\'s answer counts', async ({
  page,
  request,
}) => {
  const w = await openCounter(page, request);
  fake.reply({ tools: [{ name: `${PLUGIN}__add`, input: { by: 7 } }] }, { tools: [{ name: `${PLUGIN}__reset`, input: {} }] }, { text: 'Added 7, then reset.' });
  const cli = spawn(process.execPath, [join(WEB_ROOT, 'scripts', 'assistant-run.mjs'), '--port', String(host.port), '--tab', 'auto', 'Add 7, then reset the counter.'], {
    cwd: WEB_ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let out = '';
  cli.stdout.on('data', (b) => (out += b));
  cli.stderr.on('data', (b) => (out += b));
  const exited = new Promise((done) => cli.once('exit', done));
  try {
    await expect(modal(page)).toBeVisible({ timeout: 30_000 });
    await expect(w.frame.locator('#counter')).toHaveText('7');
    await expect(page.locator('#cf-cancel')).toBeFocused();
    await expect.poll(() => out, { message: 'the terminal asks too' }).toContain('waiting for an answer in the app; you can also answer here');
    await page.locator('#cf-confirm').click();
    expect(await exited, out).toBe(0);
  } finally {
    cli.kill();
  }
  await expect(w.frame.locator('#counter')).toHaveText('0');
  expect(out).toContain('→ ai-demo__add {"by":7}');
  expect(out).toContain('(answered: allowed)');
  expect(out).toContain('Added 7, then reset.');
});
