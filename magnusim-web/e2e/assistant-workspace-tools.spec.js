// Workspace tools for the Assistant, end to end (Foundation spec 8.4, 10.3): a scripted model
// (support/fake-llm.mjs, the first cloud dialect) → the server's turn loop → the page relay on
// the tab's event stream → the bridge → the plugin's frame → back. The test plugin ai-demo
// (python/tests/fixtures/assistant-plugins) keeps a counter in its page and offers nine tools:
// get_count, add (its result names what it did in a summary), slow_add (progress every 200 ms
// until window.__release() in the frame), reset (destructive, with a confirm note), mystery (a
// risk the host does not know), snap (a 64x64 PNG), read_study (a 1 s window, waiting on the
// app's answer to its read of the study), fail_hint (it always fails, with a hint and a detail)
// and label (a string, a list and a boolean, every one required; #label shows the input it got).
//
// Covered (spec 10.3's thirteen, then three more): the tools come and go with the workspace; the
// cloud privacy question once per project; an edit tool runs without asking; a destructive one
// (and mystery) asks with Don't focused, Enter answering it, and Stop closes the question; the
// second click of a double-click on Allow never answers the question asked right behind it; Stop,
// Back, a reload, a lost event stream and the plugin turned off, each during a slow call (and the
// plugin turned off with a question open, then a reconnect: a new link that sends nothing of the
// dead frame); a call to the app in flight
// keeping a tool call alive past the server's stall window; a hidden tab kept for the call and
// the hold after it, then dormant (409 tab_hidden) and back when shown; two tabs; an image
// result (for a local model that can't read it, words in its place: H6; a context error on a
// request with a picture is the context, never a refused picture); a remote viewer; a tab
// hidden at load; the terminal client
// (scripts/assistant-run.mjs) on the only connected tab. And the shared helpers
// (support/assistant.js, CAD tools spec H1): the scripted model on the local server, its steps
// answering from the request, and questions answered through their route. And a failed call's
// hint and detail reaching the model and the terminal, a result's summary only the log (H2).
// And the turn bound to the tab reaching its frame (its title, what it used, its end), whose own
// Stop ends it, and the frame's page loaded again during the turn hearing it run (H3). And a
// destructive tool's confirm note as its question's text, mystery's question saying "can't be
// undone" without one (H10).
// And one turn per tab: a second one while it works is refused 409 tab_busy (H4). And every
// problem with a call's input in one result, the terminal showing them all (H9); a local
// model's string, list and boolean fields left out filled with "", [] and false (H9).
// And a cloud provider that can't compile the tools strictly: sent again unchecked by it (H8),
// and the shared turn helper failing a turn that got that note unless the test expects it.
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
import { answerGate, followTurn, offeredTools, resultsIn, startTurn, trackTab, useScriptedModel } from './support/assistant.js';
import { LLAMA_SERVER, startFakeLlm, TEXT_ONLY_REFUSAL } from './support/fake-llm.mjs';
import { startHost, WEB_ROOT } from './support/host-server.mjs';
import { serverStream, setHidden } from './support/link-streams.js';
import { expect, test } from './support/stress.js';

const PLUGIN = 'ai-demo';
const PLUGIN_NAME = 'Workspace demo';
const TOOLS = ['add', 'fail_hint', 'get_count', 'label', 'mystery', 'read_study', 'reset', 'slow_add', 'snap'].map((n) => `${PLUGIN}__${n}`);
/** What fail_hint throws (the fixture's FAIL_HINT). */
const FAIL = {
  code: 'invalid_input',
  message: 'step_too_big: the counter takes at most 3 at a time.',
  hint: 'Call add with by set to 1, 2 or 3.',
  detail: { reason: 'step_too_big', field: 'by', allowed: [1, 2, 3] },
};
const GUIDE = 'The counter starts at 0 each time the workspace opens. Read it with get_count; add or slow_add change it; reset sets it to 0.';
/** What reset's question says it does (the fixture's confirm note on reset). */
const RESET_NOTE = 'Sets the counter to 0; add can bring it back.';
const PROJECT_TITLE = 'Counter project';
const HOLD_MS = 2000;
/** One step's ceiling in the newer tests: well past Playwright's 5 s default, for CI's slow runners. */
const STEP_MS = 15_000;
const STEP = { timeout: STEP_MS };
/** The page's own grace before a hidden tab lets its stream go (src/api/eventHub.ts HIDDEN_GRACE_MS). */
const HIDDEN_GRACE_MS = 3000;
const STRICT_REFUSED = ['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'pattern', 'format', 'title'];
const TAB_HIDDEN_TEXT =
  "That tab isn't connected to the Assistant: its window is in the background or covered, or it was closed. Show the Magnusim window and try again.";
const PRIVACY_DENIED_TEXT =
  'Settings → Assistant is set to never send project data to a cloud provider. Ask from Home, use a local server, or change the setting.';
const TAB_BUSY_TEXT = 'A turn is already working in that tab: wait for it or stop it.';

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
  await useScriptedModel(request, host.base, fake, 'cloud');
});

test.afterAll(async () => {
  if (host) host.stop();
  if (fake) await fake.stop();
});

test.beforeEach(async ({ request }) => {
  // No turn, question or conversation of an earlier test; the scripted cloud model (a test
  // may switch to the local one); consent asked afresh, then allowed (the privacy test asks
  // for itself).
  await postOk(request, '/api/test/assistant/reset', {});
  await useScriptedModel(request, host.base, fake, 'cloud');
  await postOk(request, '/api/assistant/settings', { forget_consents: true });
});

test.afterEach(() => {
  // An answer left queued: the test's turns did not go as scripted. It fails here, by name;
  // after a failure Playwright replaces the worker, so the next test starts with a new fake
  // and a new server, and nothing queued here can answer its requests.
  expect(fake.pending(), 'scripted answers left unused').toBe(0);
});

// ---------------------------------------------------------------- the page

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
// (startTurn, followTurn, resultsIn, offeredTools and answerGate: support/assistant.js)

const ofType = (events, type) => events.filter((e) => e.type === type);

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
  await expect(w.frame.locator('#slow')).toHaveText('running', STEP);
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
  const t = await startTurn(request, host.base, { text: 'Say hello.', tab: w.tab });
  const { turn } = await t.ended();
  expect(turn).toMatchObject({ state: 'done', tab: w.tab, project_id: project });
  const sent = chats()[before].body;
  const names = sent.tools.map((x) => x.name);
  const hostTools = names.filter((n) => !n.includes('__'));
  // The host's own tools first, then the workspace's, each by name.
  expect(names).toEqual([...[...hostTools].sort(), ...TOOLS]);
  // Every one strict, with no keyword a strict tool may not use.
  expect(offeredTools(chats()[before])).toEqual(names.map((name) => ({ name, strict: true })));
  for (const tool of sent.tools) expect(refusedKeywords(tool.input_schema), tool.name).toEqual([]);
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
  const t1 = await startTurn(request, host.base, { text: 'Read the counter.', tab: w.tab });
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
  const t2 = await startTurn(request, host.base, { text: 'Read the counter.', tab: w.tab });
  await expect(dialog).toBeVisible();
  await page.locator('#cf-confirm').click();
  await expect(dialog).toBeHidden();
  expect((await t2.ended()).turn.state).toBe('done');
  expect(chats().length).toBe(before + 1);

  // Remembered for this project: no question.
  fake.reply({ text: 'Still 0.' });
  const t3 = await startTurn(request, host.base, { text: 'Read the counter again.', tab: w.tab });
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
  const t = await startTurn(request, host.base, { text: 'Add 2 to the counter.', tab: w.tab });
  const { turn, events } = await t.ended();
  expect(turn.state).toBe('done');
  await expect(w.frame.locator('#counter')).toHaveText('2');
  await expect(modal(page)).toBeHidden();
  expect(ofType(events, 'gate')).toEqual([]);
  // The person reads the workspace's title, the model its key.
  expect(ofType(events, 'tool_call')[0]).toMatchObject({ tool: `${PLUGIN}__add`, risk: 'edit', source: `${PLUGIN_NAME} (Counter)` });
  expect(chats()[before].body.messages[0].content.map((b) => b.text).join(' ')).toContain('"workspace":"counter"');
  // The log names what it did; the model gets the text and data, never that line.
  expect(ofType(events, 'tool_result')[0]).toMatchObject({ ok: true, summary: 'Added 2: the counter is 2' });
  expect(resultsIn(chats()[before + 1])).toEqual([{ tool: `${PLUGIN}__add`, ok: true, text: 'The counter is 2.', data: { count: 2 }, images: [] }]);
  // The page got the turn's id with the call.
  expect(await w.handle.evaluate(() => window.__aiCalls.map((c) => [c.tool, c.turn]))).toEqual([['add', t.id]]);
});

test("a destructive tool asks first with Don't focused, in its confirm note's words: Enter answers Don't, a click on Allow runs it; mystery asks too, saying it can't be undone", async ({
  page,
  request,
}) => {
  const w = await openCounter(page, request);
  const dialog = modal(page);
  const before = chats().length;

  fake.reply({ tools: [{ name: `${PLUGIN}__add`, input: { by: 2 } }] }, { tools: [{ name: `${PLUGIN}__reset`, input: {} }] }, { text: 'I left it at 2.' });
  const t1 = await startTurn(request, host.base, { text: 'Add 2, then reset the counter.', tab: w.tab });
  await expect(dialog).toBeVisible();
  await expect(w.frame.locator('#counter')).toHaveText('2');
  await expect(page.locator('#cf-heading')).toHaveText('Allow the Assistant to reset the counter?');
  await expect(page.locator('#cf-copy')).toHaveText(`${PLUGIN_NAME} (Counter) · ${RESET_NOTE} What it sent: {}. Nothing runs until you choose.`, STEP);
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
  const t2 = await startTurn(request, host.base, { text: 'Reset the counter.', tab: w.tab });
  await expect(dialog).toBeVisible();
  await expect(page.locator('#cf-cancel')).toBeFocused();
  await page.locator('#cf-confirm').click();
  expect((await t2.ended()).turn.state).toBe('done');
  await expect(w.frame.locator('#counter')).toHaveText('0');

  // A risk the host does not know counts as destructive: it asks too.
  fake.reply({ tools: [{ name: `${PLUGIN}__mystery`, input: {} }] }, { text: 'Nothing happened.' });
  const t3 = await startTurn(request, host.base, { text: 'Do the mystery thing.', tab: w.tab });
  await expect(dialog).toBeVisible();
  await expect(page.locator('#cf-heading')).toHaveText('Allow the Assistant to do the mystery thing?');
  // No confirm note: the question says it can't be undone.
  await expect(page.locator('#cf-copy')).toHaveText(`${PLUGIN_NAME} (Counter) · can't be undone. What it sent: {}. Nothing runs until you choose.`, STEP);
  await expect(page.locator('#cf-cancel')).toBeFocused();
  await page.locator('#cf-confirm').click();
  const e3 = await t3.ended();
  expect(e3.turn.state).toBe('done');
  expect(ofType(e3.events, 'gate')[0].gate).toMatchObject({ risk: 'destructive', tool: `${PLUGIN}__mystery` });
  expect(ofType(e3.events, 'tool_call')[0]).toMatchObject({ risk: 'destructive' });
  expect(await w.handle.evaluate(() => window.__aiCalls.map((c) => c.tool))).toEqual(['add', 'reset', 'mystery']);

  // Stop while the question is open: it closes unanswered, and nothing runs.
  fake.reply({ tools: [{ name: `${PLUGIN}__reset`, input: {} }] });
  const t4 = await startTurn(request, host.base, { text: 'Reset the counter.', tab: w.tab });
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
  const t = await startTurn(request, host.base, { text: 'Reset the counter, then do the mystery thing.', tab: w.tab });
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
  const t = await startTurn(request, host.base, { text: 'Add 5 slowly.', tab: w.tab });
  const { call } = await slowRunning(t, w, 5);
  expect((await relayState(request)).links[w.tab]).toMatchObject({ pending: 1 });
  // Monotonic: a wall clock can step back (WSL resyncs its clock under load).
  const stopAt = performance.now();
  const r = await postOk(request, `/api/assistant/turns/${t.id}/stop`, {});
  expect(r.turn.state).toBe('stopped');
  await expect(w.frame.locator('#aborted')).toHaveText('aborted');
  const { turn, events } = await t.ended();
  expect(performance.now() - stopAt, 'stopped within the 10 s ceiling').toBeLessThan(10_000);
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
  // Monotonic: a wall clock can step back (WSL resyncs its clock under load).
  await page.route(STUDY_READ, async (route) => {
    heldAt ||= performance.now();
    await held;
    await route.continue();
  });
  // The page's signs of life: bare progress POSTs (no ack, no label).
  const bare = [];
  page.on('request', (r) => {
    if (r.method() !== 'POST' || new URL(r.url()).pathname !== '/api/assistant/relay/progress') return;
    const body = r.postDataJSON();
    if (!body.ack && body.label === undefined && body.fraction === null) bare.push(performance.now());
  });
  try {
    fake.reply({ tools: [{ name: `${PLUGIN}__read_study`, input: {} }] }, { text: 'It is Counter 1.' });
    const t = await startTurn(request, host.base, { text: "Read the study's title.", tab: w.tab });
    const call = await t.waitFor((e) => e.type === 'tool_call' && e.tool === `${PLUGIN}__read_study`, 'the call');
    await expect.poll(() => heldAt, { message: 'the page reads the study' }).toBeGreaterThan(0);
    // The tool's own window is 1 s; the server's is 11 s (+10 s), and a stall there then waits
    // 2 s for the page's last answer before the call fails. Past all that, with the read held:
    const SERVER_STALL_FAILS_MS = 1000 + 10_000 + 2000;
    await page.waitForTimeout(Math.max(0, heldAt + SERVER_STALL_FAILS_MS + 2000 - performance.now()));
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
  const t = await startTurn(request, host.base, { text: 'Add 5 slowly.', tab: w.tab });
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
  const t = await startTurn(request, host.base, { text: 'Add 5 slowly.', tab: w.tab });
  const { call } = await slowRunning(t, w, 5);
  const tabOf = trackTab(page);
  // The clock runs from the reload to the failed call, with the wait started at the same time:
  // the old page's stream ends when the new document commits, long before the app loads again.
  // Monotonic: a wall clock can step back (WSL resyncs its clock under load).
  let failedAt = 0;
  const reloadAt = performance.now();
  const [result] = await Promise.all([
    t.waitFor((e) => e.type === 'tool_result' && e.call === call.call, 'the call fails', 10_000).then((e) => {
      failedAt = performance.now();
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
  const t = await startTurn(request, host.base, { text: 'Add 5 slowly.', tab: w.tab });
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
  const assistantChannels = async (tab) => ((await serverStream(request, host, tab)) || { kinds: {} }).kinds.assistant || 0;
  const registerAgain = (x) => x.handle.evaluate(() => window.__register());
  // Every list a page sends after its plugin went off: none may be, until a new page.
  let listsSent = [];
  const onRequest = (r) => {
    if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/assistant/relay/tools') listsSent.push(r.postDataJSON());
  };
  let off = false;
  const turnOff = async () => {
    listsSent = [];
    page.on('request', onRequest);
    await postOk(request, `/api/plugins/${PLUGIN}/disable`, {});
    off = true;
  };
  const turnOn = async () => {
    await postOk(request, `/api/plugins/${PLUGIN}/enable`, {});
    await postOk(request, '/api/worker', { method: 'registry.reload', params: {} });
    off = false;
  };
  // The slow turn's next answer waits here until the checks of its failed call are done.
  const afterOff = `after-off-${Date.now()}`;
  try {
    // During a slow call of the tab's turn: the call fails at once, and the page stops it too.
    // The turn still runs (its next answer is held), so the server keeps the tab's record
    // however long the disable route takes and whatever the page's channel does meanwhile.
    fake.reply({ tools: [{ name: `${PLUGIN}__slow_add`, input: { by: 5 } }] }, { hold: afterOff, text: 'It was turned off.' });
    const t = await startTurn(request, host.base, { text: 'Add 5 slowly.', tab: w.tab });
    const { call } = await slowRunning(t, w, 5);
    await turnOff();
    const result = await t.waitFor((e) => e.type === 'tool_result' && e.call === call.call, 'the call fails', 10_000);
    expect(result).toMatchObject({ ok: false, code: 'plugin_off' });
    expect(result.summary).toBe(`${PLUGIN_NAME} was turned off or replaced while the tool ran; it may or may not have finished.`);
    expect((await relayState(request)).links[w.tab]).toMatchObject({ pending: 0, tools: 0, turns: 1 });
    await expect(w.frame.locator('#aborted')).toHaveText('aborted');
    await expect(w.frame.locator('#counter')).toHaveText('0');
    fake.release(afterOff);
    expect((await t.ended()).turn.state).toBe('done');
    expect(await tabRow(request, w.tab)).toBeNull();
    // Nothing of the dead frame on the server and no question open: its channel goes, and the
    // frame registering again is refused in the page, before and after the plugin is back.
    await expect.poll(() => assistantChannels(w.tab), { timeout: 15_000 }).toBe(0);
    expect(await registerAgain(w)).toMatchObject({ available: false, reason: 'plugin_off' });
    await expect(w.frame.locator('#ai-available')).toHaveText('no');
    await turnOn();
    expect(await registerAgain(w)).toMatchObject({ available: false, reason: 'plugin_off' });
    expect(await tabRow(request, w.tab)).toBeNull();
    expect(listsSent, 'nothing of the dead frame was ever sent again').toEqual([]);
    page.off('request', onRequest);

    // A new page's tools do come back.
    const tabOf = trackTab(page);
    await page.reload();
    await expect(page.frameLocator('#workspace-frame').locator('#ai-available')).toHaveText('yes', { timeout: 60_000 });
    await expect.poll(tabOf).not.toBe('');
    await expect.poll(async () => tabRow(request, tabOf()).then((r) => (r ? `${r.connected}:${r.tools.length}` : 'none')), { timeout: 30_000 }).toBe(`true:${TOOLS.length}`);
    const w2 = { frame: page.frameLocator('#workspace-frame'), handle: await counterFrame(page), tab: tabOf() };

    // A question of the new page's turn (a destructive tool's; one turn per tab, and nothing runs
    // while it asks) stays open across the plugin going off: the page keeps its assistant channel
    // for it, so the stream drop below is a real reconnect, with a new link. (A running turn alone
    // keeps no channel for a page with nothing to offer.)
    fake.reply({ tools: [{ name: `${PLUGIN}__reset`, input: {} }] }, { text: 'I left it.' });
    const asking = await startTurn(request, host.base, { text: 'Reset the counter.', tab: w2.tab });
    await expect(modal(page)).toBeVisible();
    await expect(page.locator('#cf-heading')).toHaveText('Allow the Assistant to reset the counter?');
    await turnOff();
    await expect.poll(() => tabRow(request, w2.tab), { message: 'its tools go' }).toBeNull();
    expect((await relayState(request)).links[w2.tab]).toMatchObject({ pending: 0, tools: 0 });
    expect(await assistantChannels(w2.tab), 'kept for the open question').toBe(1);
    await expect(modal(page)).toBeVisible();

    // The stream drops and comes back: on the new link the page sends nothing of the dead frame,
    // and the server lists nothing of it.
    const linked = await page.evaluate(() => window.__linked);
    expect(linked, 'the page counted its first link').toBeGreaterThanOrEqual(1);
    expect((await postOk(request, '/api/test/event-hub/drop', { tab: w2.tab })).dropped).toBe(1);
    await page.waitForFunction((n) => window.__linked > n, linked, { polling: 100, timeout: 30_000 });
    expect((await relayState(request)).links[w2.tab]).toMatchObject({ connected: true, pending: 0, tools: 0 });
    expect(await tabRow(request, w2.tab)).toBeNull();
    expect(listsSent, 'no list sent on the new link').toEqual([]);
    // The question came back on the new link: still one dialog, answered there.
    await expect(modal(page)).toBeVisible();
    await page.locator('#cf-cancel').click();
    await expect(modal(page)).toBeHidden();
    expect((await asking.ended()).turn.state).toBe('done');
    await expect(w2.frame.locator('#counter')).toHaveText('0');
    // With nothing of this page left on the server, its channel goes; the frame registering
    // again is refused in the page.
    await expect.poll(() => assistantChannels(w2.tab), { timeout: 15_000 }).toBe(0);
    expect(await registerAgain(w2)).toMatchObject({ available: false, reason: 'plugin_off' });
    await expect(w2.frame.locator('#ai-available')).toHaveText('no');
    expect(await tabRow(request, w2.tab)).toBeNull();
    expect(await assistantChannels(w2.tab)).toBe(0);
    expect(listsSent, 'nothing of the dead frame was ever sent again').toEqual([]);
  } finally {
    page.off('request', onRequest);
    fake.release(afterOff);
    if (off) await turnOn();
  }
});

test('a hidden tab keeps its stream for a running call and for the hold after the turn, then lets it go: dormant, 409 tab_hidden; shown again, its tools are back', async ({
  page,
  request,
}) => {
  const w = await openCounter(page, request);
  fake.reply({ tools: [{ name: `${PLUGIN}__slow_add`, input: { by: 4 } }] }, { text: 'Added 4.' });
  const t = await startTurn(request, host.base, { text: 'Add 4 slowly.', tab: w.tab });
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
  expect(typeof row.hold_until).toBe('number');
  // Timed on this side's monotonic clock from what is left of the hold as the server reads it:
  // never this clock against the server's hold_until (a wall clock can step back: WSL resyncs
  // its clock under load). The server read it after `asked`, so the hold ends no earlier than
  // asked + holdLeft here.
  const asked = performance.now();
  const holdLeft = (await relayState(request)).links[w.tab].hold_left_ms;
  expect(holdLeft, 'the hold runs').toBeGreaterThan(0);
  expect(holdLeft).toBeLessThanOrEqual(HOLD_MS);
  expect(await assistantChannels(), 'kept for the hold').toBe(1);
  await expect.poll(assistantChannels, { timeout: 15_000, intervals: [100], message: 'let go after the hold and the grace' }).toBe(0);
  expect(performance.now() - asked, 'not before the hold and the grace').toBeGreaterThanOrEqual(holdLeft + HIDDEN_GRACE_MS - 500);
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
    expect((await (await startTurn(request, host.base, { text: 'Add 3.', tab: a.tab })).ended()).turn.state).toBe('done');
    await expect(a.frame.locator('#counter')).toHaveText('3');
    await expect(b.frame.locator('#counter')).toHaveText('0');
    fake.reply({ tools: [{ name: `${PLUGIN}__add`, input: { by: -1 } }] }, { text: 'Took 1 away.' });
    expect((await (await startTurn(request, host.base, { text: 'Take 1 away.', tab: b.tab })).ended()).turn.state).toBe('done');
    await expect(b.frame.locator('#counter')).toHaveText('-1');
    await expect(a.frame.locator('#counter')).toHaveText('3');
    // A question of a turn bound to B shows in B only.
    fake.reply({ tools: [{ name: `${PLUGIN}__reset`, input: {} }] }, { text: 'Reset.' });
    const t = await startTurn(request, host.base, { text: 'Reset the counter.', tab: b.tab });
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

test('one turn per app tab: a second one while it works is refused (409 tab_busy, and the terminal says so); the tab takes the next once the first ended', async ({
  page,
  request,
}) => {
  const w = await openCounter(page, request);
  const before = chats().length;
  fake.reply({ tools: [{ name: `${PLUGIN}__slow_add`, input: { by: 2 } }] }, { text: 'Added 2.' });
  const t = await startTurn(request, host.base, { text: 'Add 2 slowly.', tab: w.tab });
  await slowRunning(t, w, 2);
  expect((await tabRow(request, w.tab)).active_turns).toBe(1);
  // By the tab's id, through the route: refused before anything starts.
  const r = await request.post(api('/api/assistant/turns'), { data: { text: 'Read the counter.', tab: w.tab } });
  expect(r.status()).toBe(409);
  expect(await r.json()).toEqual({ ok: false, code: 'tab_busy', error: TAB_BUSY_TEXT });
  // From the terminal, on the only connected tab: the person reads why, and it exits 1.
  const cli = spawn(process.execPath, [join(WEB_ROOT, 'scripts', 'assistant-run.mjs'), '--port', String(host.port), '--tab', 'auto', 'Read the counter.'], {
    cwd: WEB_ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let out = '';
  cli.stdout.on('data', (b) => (out += b));
  cli.stderr.on('data', (b) => (out += b));
  try {
    expect(await new Promise((done) => cli.once('exit', done)), out).toBe(1);
  } finally {
    cli.kill();
  }
  expect(out.trim()).toBe(TAB_BUSY_TEXT);
  // Neither reached the model or the page: the first turn's call still runs, and no question shows.
  expect(chats().length).toBe(before + 1);
  expect((await relayState(request)).running).toBe(1);
  expect(await w.handle.evaluate(() => window.__aiCalls.map((c) => [c.tool, c.turn]))).toEqual([['slow_add', t.id]]);
  await expect(w.frame.locator('#slow')).toHaveText('running');
  await expect(modal(page)).toBeHidden();
  // Let go, the first turn ends as its own.
  expect(await w.handle.evaluate(() => window.__release())).toBe(true);
  expect((await t.ended()).turn.state).toBe('done');
  await expect(w.frame.locator('#counter')).toHaveText('2');
  // The tab is free again: the next turn starts and runs there.
  fake.reply({ tools: [{ name: `${PLUGIN}__get_count`, input: {} }] }, { text: 'It reads 2.' });
  const t2 = await startTurn(request, host.base, { text: 'Read the counter.', tab: w.tab });
  expect((await t2.ended()).turn.state).toBe('done');
  expect(resultsIn(chats().at(-1))).toEqual([{ tool: `${PLUGIN}__get_count`, ok: true, text: 'The counter is 2.', data: { count: 2 }, images: [] }]);
  expect(await w.handle.evaluate(() => window.__aiCalls.map((c) => [c.tool, c.turn]))).toEqual([
    ['slow_add', t.id],
    ['get_count', t2.id],
  ]);
});

test('an image result: snap puts a 64x64 PNG block in the next request', async ({ page, request }) => {
  const w = await openCounter(page, request);
  const before = chats().length;
  fake.reply({ tools: [{ name: `${PLUGIN}__snap`, input: {} }] }, { text: 'A picture of 0.' });
  const t = await startTurn(request, host.base, { text: 'Show me the counter.', tab: w.tab });
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

test("a local model that can't read pictures: its server refuses snap's picture, the request goes again with words in its place, the terminal says so, and the next turn leaves pictures out", async ({
  page,
  request,
}) => {
  // What the person and the model read (the local-server adapter's words, CAD tools spec H6).
  const LEFT_OUT = '[An image was left out: the local server does not accept images.]';
  const REFUSED_NOTE = 'The local server refused the images, so the request went again without them; this model gets none from now on.';
  const LEFT_OUT_NOTE = "The local model doesn't read images: they are left out of its requests.";
  const hasImage = (r) => JSON.stringify(r.body).includes('"image_url"');
  /** One turn in the terminal client on this tab: what the person reads (stdout and stderr), once it exits 0. */
  const terminal = async (text) => {
    const cli = spawn(process.execPath, [join(WEB_ROOT, 'scripts', 'assistant-run.mjs'), '--port', String(host.port), '--tab', w.tab, text], {
      cwd: WEB_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    cli.stdout.on('data', (b) => (out += b));
    cli.stderr.on('data', (b) => (out += b));
    let timer;
    const ceiling = new Promise((done) => {
      timer = setTimeout(() => done('still running after 120 s'), 120_000);
    });
    try {
      expect(await Promise.race([new Promise((done) => cli.once('exit', done)), ceiling]), out).toBe(0);
    } finally {
      clearTimeout(timer);
      cli.kill();
    }
    return out;
  };
  // The model says what came back where the picture was.
  const answer = (body) => ({ text: body.messages.at(-1).content === `Images from the tool results above:\n\n${LEFT_OUT}` ? 'No picture came, only a note.' : 'Something else came.' });

  const w = await openCounter(page, request);
  const model = await useScriptedModel(request, host.base, fake, 'local');
  fake.textOnly(model.model);
  try {
    let before = chats().length;
    fake.reply({ tools: [{ name: `${PLUGIN}__snap`, input: {} }] }, answer);
    let out = await terminal('Show me the counter.');
    // The person reads that the pictures were left out, and the model's answer to the words it got.
    expect(out).toContain(`note: ${REFUSED_NOTE}\n`);
    expect(out).toContain('No picture came, only a note.');
    let sent = chats().slice(before);
    expect(sent.map((r) => [r.dialect, r.refused ?? null, hasImage(r)])).toEqual([
      [model.dialect, null, false],
      [model.dialect, TEXT_ONLY_REFUSAL, true],
      [model.dialect, null, false],
    ]);
    // The result's text still reached the model, and the picture's place says why it is missing.
    expect(resultsIn(sent[2])).toEqual([{ tool: `${PLUGIN}__snap`, ok: true, text: 'A picture of the counter (0).', images: [] }]);
    expect(sent[2].body.messages.at(-1)).toEqual({ role: 'user', content: `Images from the tool results above:\n\n${LEFT_OUT}` });
    expect(await w.handle.evaluate(() => window.__aiCalls.map((c) => c.tool))).toEqual(['snap']);

    // The next turn: the server is not sent a picture again, and the terminal says why.
    before = chats().length;
    fake.reply({ tools: [{ name: `${PLUGIN}__snap`, input: {} }] }, answer);
    out = await terminal('Show me the counter again.');
    expect(out).toContain(`note: ${LEFT_OUT_NOTE}\n`);
    expect(out).not.toContain(REFUSED_NOTE);
    expect(out).toContain('No picture came, only a note.');
    sent = chats().slice(before);
    expect(sent.map((r) => [r.refused ?? null, hasImage(r)])).toEqual([
      [null, false],
      [null, false],
    ]);
  } finally {
    fake.textOnly();
  }
});

test("a local server's context error on a request with a picture (llama.cpp's server's words): the terminal says the conversation is too long, nothing says the pictures were refused, and the next turn still sends them", async ({
  page,
  request,
}) => {
  // What the person reads (the adapters' and the loop's words, CAD tools spec H5/H6).
  const REFUSED_NOTE = 'The local server refused the images, so the request went again without them; this model gets none from now on.';
  const LEFT_OUT_NOTE = "The local model doesn't read images: they are left out of its requests.";
  const hasImage = (r) => JSON.stringify(r.body).includes('"image_url"');
  /** One turn in the terminal client on this tab: its exit code and what the person reads (stdout and stderr). */
  const terminal = async (text) => {
    const cli = spawn(process.execPath, [join(WEB_ROOT, 'scripts', 'assistant-run.mjs'), '--port', String(host.port), '--tab', w.tab, text], {
      cwd: WEB_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    cli.stdout.on('data', (b) => (out += b));
    cli.stderr.on('data', (b) => (out += b));
    let timer;
    const ceiling = new Promise((done) => {
      timer = setTimeout(() => done('still running after 120 s'), 120_000);
    });
    try {
      return { code: await Promise.race([new Promise((done) => cli.once('exit', done)), ceiling]), out };
    } finally {
      clearTimeout(timer);
      cli.kill();
    }
  };

  const w = await openCounter(page, request);
  const model = await useScriptedModel(request, host.base, fake, 'local');
  let before = chats().length;
  // The first answer calls snap; the request that carries its picture is past the server's context.
  fake.reply(() => {
    fake.failNext({ status: 400, body: LLAMA_SERVER.contextRefusals[1], dialect: model.dialect });
    return { tools: [{ name: `${PLUGIN}__snap`, input: {} }] };
  });
  let r = await terminal('Show me the counter.');
  expect(r.code, r.out).toBe(1);
  expect(r.out).toContain(`[failed] This conversation is too long for ${model.model}. Start a new one.`);
  expect(r.out).not.toContain(REFUSED_NOTE);
  expect(r.out).not.toContain(LEFT_OUT_NOTE);
  // Refused once, and not sent again without the picture.
  let sent = chats().slice(before);
  expect(sent.map(hasImage)).toEqual([false, true]);
  expect(await w.handle.evaluate(() => window.__aiCalls.map((c) => c.tool))).toEqual(['snap']);

  // A new conversation: the picture still goes, and the model sees it.
  before = chats().length;
  fake.reply({ tools: [{ name: `${PLUGIN}__snap`, input: {} }] }, (body) => ({ text: JSON.stringify(body.messages.at(-1)).includes('"image_url"') ? 'I see the counter.' : 'No picture came.' }));
  r = await terminal('Show me the counter again.');
  expect(r.code, r.out).toBe(0);
  expect(r.out).toContain('I see the counter.');
  expect(r.out).not.toContain(REFUSED_NOTE);
  expect(r.out).not.toContain(LEFT_OUT_NOTE);
  sent = chats().slice(before);
  expect(sent.map(hasImage)).toEqual([false, true]);
});

test("a cloud provider that can't compile the tools strictly: the request goes again with the workspace's tools unchecked by it, the counter still changes, the terminal says so, and the next turn sends them so at once", async ({
  page,
  request,
}) => {
  // What the person reads (the cloud adapters' note, CAD tools spec H8), and the provider's
  // refusal (the first cloud dialect's words and error shape).
  const NOTE = 'The cloud provider could not compile these tools strictly; they are sent unchecked by the provider; the app still checks every input.';
  const COMPILE_REFUSAL = { type: 'error', error: { type: 'invalid_request_error', message: 'Schema is too complex for compilation.' } };
  /** One turn in the terminal client on this tab: what the person reads (stdout and stderr), once it exits 0. */
  const terminal = async (text) => {
    const cli = spawn(process.execPath, [join(WEB_ROOT, 'scripts', 'assistant-run.mjs'), '--port', String(host.port), '--tab', w.tab, text], {
      cwd: WEB_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    cli.stdout.on('data', (b) => (out += b));
    cli.stderr.on('data', (b) => (out += b));
    let timer;
    const ceiling = new Promise((done) => {
      timer = setTimeout(() => done('still running after 120 s'), 120_000);
    });
    try {
      expect(await Promise.race([new Promise((done) => cli.once('exit', done)), ceiling]), out).toBe(0);
    } finally {
      clearTimeout(timer);
      cli.kill();
    }
    return out;
  };
  /** A request's tools, strict or not: the host's own, then the workspace's. */
  const strictness = (r) => {
    const tools = offeredTools(r);
    return { host: tools.filter((t) => !t.name.includes('__')).map((t) => t.strict), workspace: tools.filter((t) => t.name.includes('__')).map((t) => t.strict) };
  };

  const w = await openCounter(page, request);
  const model = await useScriptedModel(request, host.base, fake, 'cloud');
  let before = chats().length;
  fake.failNext({ status: 400, body: COMPILE_REFUSAL, dialect: model.dialect });
  fake.reply({ tools: [{ name: `${PLUGIN}__add`, input: { by: 2 } }] }, { text: 'Added 2.' });
  let out = await terminal('Add 2 to the counter.');
  // The turn went on: the counter reads 2, and the person reads the note once.
  await expect(w.frame.locator('#counter')).toHaveText('2');
  expect(out.split(`note: ${NOTE}\n`).length - 1, out).toBe(1);
  expect(out).toContain('Added 2.');
  let sent = chats().slice(before);
  const hosts = strictness(sent[0]).host.length;
  expect(hosts).toBeGreaterThan(0);
  const strict = { host: Array(hosts).fill(true), workspace: TOOLS.map(() => true) };
  const unchecked = { host: Array(hosts).fill(true), workspace: TOOLS.map(() => false) };
  // Refused strict (it took no step), sent again with the workspace's tools unchecked by the
  // provider, and the turn's next request the same way.
  expect(sent.map(strictness)).toEqual([strict, unchecked, unchecked]);
  expect(sent[0].step).toBeUndefined();
  expect(offeredTools(sent[1]).map((t) => t.name)).toEqual(offeredTools(sent[0]).map((t) => t.name));
  expect(await w.handle.evaluate(() => window.__aiCalls.map((c) => c.tool))).toEqual(['add']);

  // The next turn: unchecked by the provider from its first request, and the terminal says so again.
  before = chats().length;
  fake.reply({ text: 'The counter is 2.' });
  out = await terminal('What is the counter?');
  expect(out).toContain(`note: ${NOTE}\n`);
  expect(out).toContain('The counter is 2.');
  sent = chats().slice(before);
  expect(sent.map(strictness)).toEqual([unchecked]);

  // The shared turn helper fails a turn that got this note unless the test expects it, so a
  // schema the provider would refuse can't pass a test only because the app sent it again.
  fake.reply({ text: 'Still 2.' }, { text: 'Still 2, as expected.' });
  const unexpected = await startTurn(request, host.base, { text: 'What is the counter now?', tab: w.tab });
  await expect(unexpected.ended()).rejects.toThrow(`the provider refused this turn's strict tools and the app sent them again unchecked by it (note: "${NOTE}")`);
  const expected = await startTurn(request, host.base, { text: 'And now?', tab: w.tab }, { strictFallback: true });
  const { turn, events } = await expected.ended();
  expect(turn.state).toBe('done');
  expect(events.filter((e) => e.type === 'note').map((e) => e.text)).toContain(NOTE);
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
  // The terminal shows the line the page's summary gave the log.
  expect(out).toContain('→ ai-demo__add {"by":7}\n✓ Added 7: the counter is 7\n');
  expect(out).toContain('(answered: allowed)');
  expect(out).toContain('Added 7, then reset.');
});

test("the scripted model on the local server answers from the request: each step reads the counter's last result; questions answered through their route close in the app too", async ({
  page,
  request,
}) => {
  const w = await openCounter(page, request);
  const model = await useScriptedModel(request, host.base, fake, 'local');
  const before = chats().length;
  // Add 3, then twice what the counter then reads, then say what it reads: the later steps
  // are functions of the request they answer.
  fake.reply(
    { tools: [{ name: `${PLUGIN}__add`, input: { by: 3 } }] },
    (body) => ({ tools: [{ name: `${PLUGIN}__add`, input: { by: resultsIn(body)[0].data.count * 2 } }] }),
    (body) => ({ text: `The counter is ${resultsIn(body)[0].data.count}.` }),
  );
  const t1 = await startTurn(request, host.base, { text: 'Add 3, then twice what the counter reads.', tab: w.tab });
  const e1 = await t1.ended();
  expect(e1.turn.state).toBe('done');
  await expect(w.frame.locator('#counter')).toHaveText('9', STEP);
  expect(e1.turn.text_so_far).toBe('The counter is 9.');
  const sent = chats().slice(before);
  expect(sent.map((r) => r.dialect)).toEqual([model.dialect, model.dialect, model.dialect]);
  // The local server is offered the same tools, none strict.
  const offered = offeredTools(sent[0]);
  expect(offered.filter((o) => o.name.startsWith(`${PLUGIN}__`))).toEqual(TOOLS.map((name) => ({ name, strict: false })));
  expect(offered.filter((o) => o.strict)).toEqual([]);
  // The fake's log keeps the step each function returned, and what it read.
  expect(sent[1].step).toEqual({ tools: [{ name: `${PLUGIN}__add`, input: { by: 6 } }] });
  expect(sent[2].step).toEqual({ text: 'The counter is 9.' });
  expect(resultsIn(sent[2])).toEqual([{ tool: `${PLUGIN}__add`, ok: true, text: 'The counter is 9.', data: { count: 9 }, images: [] }]);

  // Two questions in one answer, each answered through the route: the app's dialog shows
  // reset's, then, once the route answered that one, mystery's, and closes after the second;
  // the next answerGate takes the question after the one it answered.
  fake.reply(
    { tools: [{ name: `${PLUGIN}__reset`, input: {} }, { name: `${PLUGIN}__mystery`, input: {} }] },
    (body) => ({ text: resultsIn(body).map((r) => `${r.tool}: ${r.ok ? 'ok' : r.error.code}`).join('; ') }),
  );
  const t2 = await startTurn(request, host.base, { text: 'Reset the counter, then do the mystery thing.', tab: w.tab });
  await expect(modal(page)).toBeVisible(STEP);
  await expect(page.locator('#cf-heading')).toHaveText('Allow the Assistant to reset the counter?', STEP);
  const first = await answerGate(request, host.base, t2, true, { kind: 'confirm', tool: `${PLUGIN}__reset` });
  expect(first).toMatchObject({ kind: 'confirm', tool: `${PLUGIN}__reset`, yes: 'Allow', no: "Don't" });
  await expect(page.locator('#cf-heading')).toHaveText('Allow the Assistant to do the mystery thing?', STEP);
  await expect(modal(page)).toBeVisible();
  const second = await answerGate(request, host.base, t2, false);
  expect(second).toMatchObject({ kind: 'confirm', tool: `${PLUGIN}__mystery` });
  await expect(modal(page)).toBeHidden(STEP);
  const e2 = await t2.ended();
  expect(e2.turn.state).toBe('done');
  expect(ofType(e2.events, 'gate_closed').map((e) => [e.gate, e.answer, e.by])).toEqual([
    [first.id, 'allow', 'user'],
    [second.id, 'deny', 'user'],
  ]);
  await expect(w.frame.locator('#counter')).toHaveText('0', STEP);
  expect(await w.handle.evaluate(() => window.__aiCalls.map((c) => c.tool))).toEqual(['add', 'add', 'reset']);
  expect(chats().at(-1).step).toEqual({ text: `${PLUGIN}__reset: ok; ${PLUGIN}__mystery: declined` });
});

test("the shared answerGate answers as the app takes answers: with the turn's answer key, or in the page's own dialog when no key answers (a turn followed without its key); without the page it throws and the question stays open", async ({
  page,
  request,
}) => {
  const w = await openCounter(page, request);
  fake.reply({ tools: [{ name: `${PLUGIN}__add`, input: { by: 4 } }] }, { tools: [{ name: `${PLUGIN}__reset`, input: {} }] }, { text: 'Reset.' });
  // Started by another program: this test has the turn's id only, not its answer key.
  const r = await request.post(api('/api/assistant/turns'), { data: { text: 'Add 4, then reset the counter.', tab: w.tab } });
  const j = await r.json();
  expect(r.status(), JSON.stringify(j)).toBe(202);
  const t = followTurn(request, host.base, j.turn);
  await expect(modal(page)).toBeVisible(STEP);
  await expect(w.frame.locator('#counter')).toHaveText('4', STEP);
  await expect(answerGate(request, host.base, t, true)).rejects.toThrow(/this turn has no answer key/);
  await expect(modal(page)).toBeVisible();
  expect(ofType(await t.latest(), 'gate_closed'), 'still open: nothing was sent').toEqual([]);
  const gate = await answerGate(request, host.base, t, true, { page });
  expect(gate).toMatchObject({ kind: 'confirm', tool: `${PLUGIN}__reset` });
  await expect(modal(page)).toBeHidden(STEP);
  const { turn, events } = await t.ended();
  expect(turn.state).toBe('done');
  expect(ofType(events, 'gate_closed').map((e) => [e.gate, e.answer, e.by])).toEqual([[gate.id, 'allow', 'user']]);
  await expect(w.frame.locator('#counter')).toHaveText('0', STEP);
});

test("a failed call says how to fix it: its hint and detail reach the model's next request and the terminal shows the hint; a result's summary is the log's line, never the model's", async ({
  page,
  request,
}) => {
  const w = await openCounter(page, request);
  const before = chats().length;
  // The model reads the failed call's detail and adds the largest step it allows.
  fake.reply(
    { tools: [{ name: `${PLUGIN}__fail_hint`, input: {} }] },
    (body) => ({ tools: [{ name: `${PLUGIN}__add`, input: { by: Math.max(...resultsIn(body)[0].error.detail.allowed) } }] }),
    { text: 'Added 3 instead.' },
  );
  const cli = spawn(process.execPath, [join(WEB_ROOT, 'scripts', 'assistant-run.mjs'), '--port', String(host.port), '--tab', w.tab, 'Add 10 to the counter.'], {
    cwd: WEB_ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let out = '';
  cli.stdout.on('data', (b) => (out += b));
  cli.stderr.on('data', (b) => (out += b));
  const exited = new Promise((done) => cli.once('exit', done));
  try {
    expect(await exited, out).toBe(0);
  } finally {
    cli.kill();
  }
  await expect(w.frame.locator('#counter')).toHaveText('3', STEP);
  expect(await w.handle.evaluate(() => window.__aiCalls.map((c) => c.tool))).toEqual(['fail_hint', 'add']);
  // What the model read after the failed call: the error, with how to fix it and what it refers to.
  expect(resultsIn(chats()[before + 1])).toEqual([{ tool: `${PLUGIN}__fail_hint`, ok: false, error: FAIL, images: [] }]);
  expect(chats()[before + 1].step).toEqual({ tools: [{ name: `${PLUGIN}__add`, input: { by: 3 } }] });
  // After add: its text and data; the summary is not the model's.
  expect(resultsIn(chats()[before + 2])).toEqual([{ tool: `${PLUGIN}__add`, ok: true, text: 'The counter is 3.', data: { count: 3 }, images: [] }]);
  expect(JSON.stringify(chats()[before + 2].body)).not.toContain('Added 3: the counter is 3');
  // What the person reads in the terminal: the failed call with its hint under it, then the summary's line.
  expect(out).toContain(`→ ${PLUGIN}__fail_hint {}\n✗ invalid_input: ${FAIL.message}\n  hint: ${FAIL.hint}\n`);
  expect(out).toContain(`→ ${PLUGIN}__add {"by":3}\n✓ Added 3: the counter is 3\n`);
  expect(out).toContain('Added 3 instead.');
});

test("the frame hears its turn: #turn-state shows the request's first line and the frame gets what it used; the frame's own Stop ends the turn stopped within the 10 s ceiling", async ({
  page,
  request,
}) => {
  const w = await openCounter(page, request);
  const { caps } = await getJson(request, '/api/assistant/status');
  fake.reply({ tools: [{ name: `${PLUGIN}__add`, input: { by: 1 } }] }, { tools: [{ name: `${PLUGIN}__slow_add`, input: { by: 5 } }] });
  const t = await startTurn(request, host.base, { text: 'Add 1, then 5 slowly.\nTake your time.', tab: w.tab });
  await expect(w.frame.locator('#turn-state')).toHaveText('running: Add 1, then 5 slowly.', STEP);
  await slowRunning(t, w, 5);
  await expect(w.frame.locator('#counter')).toHaveText('1', STEP);
  // The add's result moved its steps on; the frame has the turn's limits too.
  const lastOf = () => w.handle.evaluate((id) => window.__turns.filter((x) => x.id === id).at(-1), t.id);
  await expect.poll(async () => (await lastOf()).used.steps, { message: "the add's step", ...STEP }).toBe(1);
  expect(await lastOf()).toMatchObject({
    id: t.id,
    state: 'running',
    title: 'Add 1, then 5 slowly.',
    local: false,
    // A cloud model: no local server's context, and it reads images (H6), which the frame heard.
    contextTokens: null,
    images: true,
    used: { stepsCap: caps.steps, usdCap: caps.turn_usd },
  });
  // The frame's own Stop, while the slow call runs.
  const stopAt = Date.now();
  await w.frame.locator('#stop').click();
  // Its answer comes once the turn ended: the same 10 s ceiling, not Playwright's 5 s default.
  await expect(w.frame.locator('#stop-answer')).toHaveText('stopped', { timeout: 10_000 });
  const { turn, events } = await t.ended();
  expect(Date.now() - stopAt, 'stopped within the 10 s ceiling').toBeLessThan(10_000);
  expect(turn).toMatchObject({ state: 'stopped', end_reason: 'user' });
  await expect(w.frame.locator('#turn-state')).toHaveText('stopped: Add 1, then 5 slowly.', STEP);
  await expect(w.frame.locator('#aborted')).toHaveText('aborted', STEP);
  await expect(w.frame.locator('#counter')).toHaveText('1', STEP);
  expect(ofType(events, 'tool_result').map((e) => [e.ok, e.code ?? null])).toEqual([
    [true, null],
    [false, 'stopped'],
  ]);
  expect(await lastOf()).toMatchObject({ state: 'ended', end: { state: 'stopped', reason: 'user' }, used: { steps: 2 } });
  // Only a running turn told to this tab is the frame's to stop.
  expect(await w.handle.evaluate((id) => window.__stopTurn(id), t.id)).toEqual({ stopped: false, reason: 'ended' });
  expect(await w.handle.evaluate(() => window.__stopTurn('t-never-told'))).toEqual({ stopped: false, reason: 'not_this_tab' });
});

test("a reload of the workspace's own page while its turn runs: the reloaded page shows that turn running as it offers its tools again, then how it ended", async ({ page, request }) => {
  const w = await openCounter(page, request);
  const before = chats().length;
  const TITLE = 'Add 1, then wait.';
  // The model's answer after the add waits for the test: nothing of the turn changes meanwhile,
  // so only the offer of the reloaded page's tools can tell it that the turn runs.
  fake.reply({ tools: [{ name: `${PLUGIN}__add`, input: { by: 1 } }] }, { text: 'Added 1.', hold: 'frame-reload' });
  // The old page's tools are withdrawn as the new page says hello; that POST is held, so the
  // relay's channel (and its link) stays while the new page offers its tools.
  let letGo = () => undefined;
  const held = new Promise((done) => {
    letGo = done;
  });
  let withdrawals = 0;
  await page.route('**/api/assistant/relay/tools', async (route) => {
    if ((route.request().postDataJSON()?.tools || []).length === 0) {
      withdrawals += 1;
      await held;
    }
    await route.continue().catch(() => undefined);
  });
  // The turns the frame's current page heard ("<state>: <title>"); null until the reloaded page connected.
  const heardByNewPage = () =>
    w.handle.evaluate(() => (window.__ws && !window.__beforeReload ? window.__turns.map((x) => `${x.state}: ${x.title}`) : null)).catch(() => null);
  try {
    const t = await startTurn(request, host.base, { text: TITLE, tab: w.tab });
    await expect(w.frame.locator('#counter')).toHaveText('1', STEP);
    await expect.poll(() => chats().length, { message: "the model's held answer was asked for", ...STEP }).toBe(before + 2);
    await expect.poll(() => w.handle.evaluate((id) => window.__turns.filter((x) => x.id === id).at(-1)?.used.steps ?? -1, t.id), STEP).toBe(1);
    await expect(w.frame.locator('#turn-state')).toHaveText(`running: ${TITLE}`, STEP);
    // Only the frame's page loads again: the app, its tab and the frame stay.
    await w.handle
      .evaluate(() => {
        window.__beforeReload = true;
        location.reload();
      })
      .catch(() => undefined);
    // Polled often: the new page's offer waits behind the held withdrawal, and gives up after 5 s.
    await expect.poll(heardByNewPage, { message: 'the reloaded page hears the running turn', timeout: 30_000, intervals: [100] }).toEqual([`running: ${TITLE}`]);
    expect(withdrawals, "the old page's withdrawal was still held").toBe(1);
    letGo();
    await expect(w.frame.locator('#turn-state')).toHaveText(`running: ${TITLE}`, STEP);
    await expect(w.frame.locator('#counter')).toHaveText('0', STEP);
    await expect(w.frame.locator('#ai-available')).toHaveText('yes', STEP);
    await expect.poll(async () => tabRow(request, w.tab).then((r) => (r ? `${r.connected}:${r.tools.length}` : 'none')), STEP).toBe(`true:${TOOLS.length}`);
    fake.release('frame-reload');
    expect((await t.ended()).turn.state).toBe('done');
    await expect(w.frame.locator('#turn-state')).toHaveText(`done: ${TITLE}`, STEP);
    expect(await heardByNewPage(), 'told once, then its end').toEqual([`running: ${TITLE}`, `ended: ${TITLE}`]);
  } finally {
    letGo();
    fake.release('frame-reload');
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  }
});

test('a call with several problems in its input hears them all at once: the model and the terminal get every one and the page never runs it; on the local server a number left out is not guessed', async ({
  page,
  request,
}) => {
  const w = await openCounter(page, request);
  const before = chats().length;
  const ALL = 'the input has an unknown field "extra"; by must be at most 100; steps must be at least 1.';
  // The model fixes every problem in one round: it adds 2 only when the one result named them all.
  fake.reply(
    { tools: [{ name: `${PLUGIN}__slow_add`, input: { by: 500, steps: 0, extra: true } }] },
    (body) => ({ tools: [{ name: `${PLUGIN}__add`, input: { by: resultsIn(body)[0].error.message === ALL ? 2 : 1 } }] }),
    { text: 'Added 2.' },
  );
  const cli = spawn(process.execPath, [join(WEB_ROOT, 'scripts', 'assistant-run.mjs'), '--port', String(host.port), '--tab', w.tab, 'Add 500 slowly.'], {
    cwd: WEB_ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let out = '';
  cli.stdout.on('data', (b) => (out += b));
  cli.stderr.on('data', (b) => (out += b));
  const exited = new Promise((done) => cli.once('exit', done));
  try {
    expect(await exited, out).toBe(0);
  } finally {
    cli.kill();
  }
  await expect(w.frame.locator('#counter')).toHaveText('2');
  expect(await w.handle.evaluate(() => window.__aiCalls.map((c) => c.tool))).toEqual(['add']);
  expect(resultsIn(chats()[before + 1])).toEqual([{ tool: `${PLUGIN}__slow_add`, ok: false, error: { code: 'invalid_input', message: ALL }, images: [] }]);
  // What the person reads in the terminal: the refused call with every problem, then the fixed one.
  expect(out).toContain(`→ ${PLUGIN}__slow_add {"by":500,"steps":0,"extra":true}\n✗ invalid_input: ${ALL}\n→ ${PLUGIN}__add {"by":2}\n✓ Added 2: the counter is 2\n`);

  // The local server fills only "", [] and false: a number left out is named, and nothing runs.
  await useScriptedModel(request, host.base, fake, 'local');
  fake.reply({ tools: [{ name: `${PLUGIN}__add`, input: {} }] }, (body) => ({ text: resultsIn(body)[0].error.message }));
  const t = await startTurn(request, host.base, { text: 'Add something.', tab: w.tab });
  const e = await t.ended();
  expect([e.turn.state, e.turn.text_so_far]).toEqual(['done', 'the input is missing by.']);
  await expect(w.frame.locator('#counter')).toHaveText('2');
  expect(await w.handle.evaluate(() => window.__aiCalls.map((c) => c.tool))).toEqual(['add']);
});

test('a local model that leaves out a call\'s string, list and boolean fields has them filled: the page gets "", [] and false and runs it at once; the cloud model\'s same call is refused, naming them all', async ({
  page,
  request,
}) => {
  const w = await openCounter(page, request);
  const call = { tools: [{ name: `${PLUGIN}__label`, input: { text: null } }] };
  // The cloud model: nothing is filled. One result names every field, and the page never runs it.
  fake.reply(call, (body) => ({ text: resultsIn(body)[0].error.message }));
  const cloud = await startTurn(request, host.base, { text: 'Label the counter.', tab: w.tab });
  const c = await cloud.ended();
  expect([c.turn.state, c.turn.text_so_far]).toEqual(['done', 'the input is missing text (null), marks, loud (send "", [] or false when unused).']);
  await expect(w.frame.locator('#label')).toHaveText('');
  expect(await w.handle.evaluate(() => window.__aiCalls.length)).toBe(0);

  // The local server: the same call runs at once, with "", [] and false, in one round.
  await useScriptedModel(request, host.base, fake, 'local');
  const before = chats().length;
  fake.reply(call, { text: 'The label is cleared.' });
  const t = await startTurn(request, host.base, { text: 'Label the counter.', tab: w.tab });
  const e = await t.ended();
  expect([e.turn.state, e.turn.text_so_far]).toEqual(['done', 'The label is cleared.']);
  await expect(w.frame.locator('#label')).toHaveText('{"text":"","marks":[],"loud":false}');
  await expect(w.frame.locator('#calls')).toHaveText('label');
  expect(await w.handle.evaluate(() => window.__aiCalls.map(({ tool, input }) => ({ tool, input })))).toEqual([{ tool: 'label', input: { text: '', marks: [], loud: false } }]);
  expect(chats().length - before).toBe(2);
  expect(resultsIn(chats()[before + 1])).toEqual([{ tool: `${PLUGIN}__label`, ok: true, text: 'The label is empty.', data: { label: '' }, images: [] }]);
  // The turn's log shows what the model sent, and the page's line for what the call did.
  expect(ofType(e.events, 'tool_call')).toMatchObject([{ tool: `${PLUGIN}__label`, input_preview: '{"text":null}' }]);
  expect(ofType(e.events, 'tool_result')).toMatchObject([{ ok: true, summary: 'Cleared the label' }]);
});
