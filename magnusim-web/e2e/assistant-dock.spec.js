// The Assistant's chat dock (phase 4 spec 2-8, 11.3): where Daniel types to the Assistant and
// follows what it does. A request's transcript as it streams (the person's message, the
// model's text, a tool step with its badge, summary and time, a picture inline), the turn's end
// and counters.
// Its own server with the Assistant's test switches (a test home, never this PC's keys), the
// scripted model (support/fake-llm.mjs) and the ai-demo test plugin
// (python/tests/fixtures/assistant-plugins) for a workspace. Rect checks allow 2 px (fonts
// differ under Linux); no pixel snapshots; races are held by the fake, never slept.
// SPDX-License-Identifier: GPL-3.0-or-later
import { answerGate, dockGate, dockSend, dockTurn, openDock, startTurn, trackTab, useScriptedModel } from './support/assistant.js';
import { startFakeLlm, userImagesOf } from './support/fake-llm.mjs';
import { startHost } from './support/host-server.mjs';
import { serverStream, setHidden } from './support/link-streams.js';
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
      MAGNUSIM_TEST_ASSISTANT_HOLD_MS: '2000',
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

const chats = () => fake.requests().filter((r) => r.kind === 'chat');
const composer = (page) => dock(page).getByRole('textbox', { name: 'Message to the Assistant' });

/** A PNG of w × h drawn in the page, as a Buffer. */
async function pngOf(page, w, h, label = '') {
  const b64 = await page.evaluate(
    async ([w, h, label]) => {
      const c = new OffscreenCanvas(w, h);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#3366cc';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#ffffff';
      ctx.font = '20px sans-serif';
      ctx.fillText(label, 4, 24);
      const blob = await c.convertToBlob({ type: 'image/png' });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let s = '';
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(s);
    },
    [w, h, label],
  );
  return Buffer.from(b64, 'base64');
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

test('sent from the dock: Enter sends, Shift+Enter makes a newline, the text streams, the request ends; bound to the workspace', async ({ page, request }) => {
  await openCounter(page, request);
  await openDock(page);
  await expect(composer(page)).toBeFocused();
  await expect(dock(page).locator('[data-dock-intro]')).toHaveText(/^Tell the Assistant what to do in .+\.$/);
  await expect(dock(page).locator('[data-dock-context]')).toHaveAttribute('data-dock-context', 'tools');
  await expect(dock(page).locator('[data-dock-context]')).toContainText(`in ${PROJECT_TITLE}`);
  const sent = [];
  page.on('request', (r) => {
    if (new URL(r.url()).pathname === '/api/assistant/turns' && r.method() === 'POST') sent.push(r.postDataJSON());
  });
  const before = chats().length;
  fake.reply({ text: 'Adding two to the counter now.', chunkMs: 40, hold: 'stream', tools: [{ name: `${PLUGIN}__add`, input: { by: 2 } }] }, { text: 'Done: it reads 2.' });
  const id = await dockSend(page, 'Add two\nplease');
  expect(sent[0]).toMatchObject({ text: 'Add two\nplease', tab: 'link' });
  expect(typeof sent[0].link).toBe('string');
  expect(sent[0].context).toBeUndefined();
  const turn = dockTurn(page);
  await expect(turn).toHaveAttribute('data-dock-turn', id, STEP);
  await expect(turn.locator('[data-dock-prompt]')).toHaveText('Add two\nplease');
  await expect(turn.getByText('From the command line or another program')).toHaveCount(0);
  // The partial text, before the fake lets the rest go.
  await expect(turn.locator('[data-dock-text][aria-busy="true"]')).toBeVisible(STEP);
  await expect(composer(page)).toHaveValue('');
  await expect(dock(page).locator('[data-dock-stop]')).toBeVisible();
  await shot(page, 'streaming');
  fake.release('stream');
  await expect(turn.locator('[data-turn-end="done"]')).toBeVisible(STEP);
  await expect(turn.locator('[data-dock-text]').last()).toHaveText('Done: it reads 2.');
  await expect(dock(page).locator('[data-dock-send]')).toBeVisible();
  expect(JSON.stringify(chats()[before].body.messages)).toContain('Add two\\nplease');
  await shot(page, 'ended');
});

test('Stop in the dock ends a slow call stopped, and the model hears nothing after; the pill has the same Stop', async ({ page, request }) => {
  const w = await openCounter(page, request);
  await openDock(page);
  fake.reply({ tools: [{ name: `${PLUGIN}__slow_add`, input: { by: 5 } }] });
  const id = await dockSend(page, 'Add five slowly');
  await expect(w.frame.locator('#slow')).toHaveText('running', STEP);
  await expect(dockTurn(page).locator('[data-dock-phase]')).toHaveText(/^Working: Add slowly/, STEP);
  const before = chats().length;
  const t0 = performance.now();
  await dock(page).locator('[data-dock-stop]').click();
  await expect(dockTurn(page).locator('[data-turn-end="stopped"]')).toBeVisible(STEP);
  expect(performance.now() - t0, 'within the Stop route bound').toBeLessThan(8000);
  await expect(dockTurn(page).locator('[data-dock-step]').first()).toHaveAttribute('data-dock-step-state', 'failed');
  expect(chats().length, 'no request after Stop').toBe(before);
  const ended = await getJson(request, `/api/assistant/turns/${id}`);
  expect(ended.turn.state).toBe('stopped');

  // The same from the pill, with the dock closed.
  fake.reply({ tools: [{ name: `${PLUGIN}__slow_add`, input: { by: 1 } }] });
  const second = await dockSend(page, 'Add one slowly');
  await expect(w.frame.locator('#slow')).toHaveText('running', STEP);
  await dock(page).locator('[data-dock-close]').click();
  const pill = page.locator('[data-assistant-pill]');
  await expect(pill).toHaveAttribute('data-pill', 'running', STEP);
  await expect(pill.locator('.assistant-dock-pill-text')).toHaveText(/^Assistant · Working: Add slowly/);
  await shot(page, 'pill-running');
  await pill.getByRole('button', { name: 'Stop the Assistant' }).click();
  await expect.poll(async () => (await getJson(request, `/api/assistant/turns/${second}`)).turn.state, STEP).toBe('stopped');
  await expect(pill).toHaveAttribute('data-pill', 'done', STEP);
  await expect(pill.locator('.assistant-dock-pill-text')).toHaveText('Assistant: stopped');
});

test('pictures: two by Attach, one pasted, one dropped; a fifth refused; a wide one shrunk; the model gets all four with the message', async ({ page, request }) => {
  await page.goto(api('/#/'));
  await openDock(page);
  await expect(dock(page).locator('[data-dock-context]')).toHaveText('Home · no project');
  const a = await pngOf(page, 64, 48, 'A');
  const wide = await pngOf(page, 2600, 120, 'W');
  await dock(page).locator('[data-dock-file]').setInputFiles([
    { name: 'a.png', mimeType: 'image/png', buffer: a },
    { name: 'wide.png', mimeType: 'image/png', buffer: wide },
  ]);
  const chips = dock(page).locator('[data-dock-picture-chip]');
  await expect(chips).toHaveCount(2, STEP);
  await expect(chips.nth(0)).toContainText('a.png · 64 × 48');
  await expect(chips.nth(1)).toContainText('wide.png · 2000 × 92');
  await expect(chips.nth(1)).toContainText('Shrunk to 2000 × 92 px to fit');
  // A paste and a drop, built in the page (never the OS clipboard).
  const put = async (how, name) =>
    page.evaluate(
      async ([how, name, b64]) => {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const dt = new DataTransfer();
        dt.items.add(new File([bytes], name, { type: 'image/png' }));
        if (how === 'paste') {
          document.querySelector('#assistant-dock textarea').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
        } else {
          const panel = document.getElementById('assistant-dock');
          panel.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true }));
          panel.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
        }
      },
      [how, name, a.toString('base64')],
    );
  await put('paste', 'pasted.png');
  await expect(chips).toHaveCount(3, STEP);
  await put('drop', 'dropped.png');
  await expect(chips).toHaveCount(4, STEP);
  await expect(dock(page).getByText('Pictures go to the provider with your message.')).toBeVisible();
  await put('paste', 'fifth.png');
  await expect(dock(page).locator('[data-dock-picture-error]')).toHaveText('At most 4 pictures per message.');
  await expect(chips).toHaveCount(4);
  await shot(page, 'pictures');
  fake.reply({ text: 'I see four pictures.' });
  const id = await dockSend(page, 'What do you see?');
  await expect(dockTurn(page).locator('[data-turn-end="done"]')).toBeVisible(STEP);
  const req = chats().at(-1);
  expect(userImagesOf(req.dialect, req.body).map((i) => i.media_type)).toEqual(['image/png', 'image/webp', 'image/png', 'image/png']);
  // The request carried no project (Home), and its pictures show with the message.
  const turn = await getJson(request, `/api/assistant/turns/${id}`);
  expect(turn.turn.project_id).toBeNull();
  expect(turn.turn.prompt_images.map((p) => p.n)).toEqual(['p1', 'p2', 'p3', 'p4']);
  await expect(dockTurn(page).locator('.dock-you img')).toHaveCount(4);
  await expect(chips).toHaveCount(0);
});

test('review rounds: after its edit and its answer, the workspace asks it to check its work; the divider shows and the request ends done', async ({ page, request }) => {
  const w = await openCounter(page, request);
  const frame = page.frames().find((f) => f.url().includes(`/plugins/${PLUGIN}/workspace/`));
  await frame.evaluate(() => window.__register({ review: { rounds: 2, prompt: 'Read the counter and check it.' } }));
  await expect(w.frame.locator('#ai-available')).toHaveText('yes', STEP);
  await openDock(page);
  fake.reply({ tools: [{ name: `${PLUGIN}__add`, input: { by: 1 } }] }, { text: 'Added one.' }, { text: 'It reads 1, as asked.' });
  await dockSend(page, 'Add one');
  const turn = dockTurn(page);
  await expect(turn.locator('[data-dock-review]').first()).toHaveText(/^Checking its work · round 1 of 2$/, STEP);
  await expect(turn.locator('[data-turn-end="done"]')).toBeVisible(STEP);
});

test('the provider picker: the default first, a provider with no key disabled with why; locked after the first message', async ({ page }) => {
  await page.goto(api('/#/'));
  await openDock(page);
  const button = dock(page).locator('.dock-picker-button');
  await button.click();
  const list = dock(page).getByRole('listbox');
  const options = list.getByRole('option');
  await expect(options.first()).toContainText(' · default');
  await expect(options.first()).toHaveAttribute('aria-selected', 'true');
  const noKey = list.locator('[aria-disabled="true"]').filter({ hasText: 'No key · not ready' });
  await expect(noKey.first()).toBeVisible();
  await shot(page, 'picker');
  await page.keyboard.press('Escape');
  await expect(list).toHaveCount(0);
  await expect(button).toBeFocused();
  await expect(dock(page)).toBeVisible();
  fake.reply({ text: 'Hello.' });
  await dockSend(page, 'Hello');
  await expect(dockTurn(page).locator('[data-turn-end="done"]')).toBeVisible(STEP);
  await expect(dock(page).locator('[data-dock-provider-locked]')).toHaveAttribute('title', 'A conversation keeps its provider. Start a new one to use another.');
});

// ---------------------------------------------------------------- questions (spec 4)

test("a question shows as a card in the dock with No focused, the frame's keyboard taken; Enter answers No; Yes is guarded; the app's dialog never shows", async ({ page, request }) => {
  const w = await openCounter(page, request);
  const handle = page.frames().find((f) => f.url().includes(`/plugins/${PLUGIN}/workspace/`));
  await openDock(page);
  // The dock closed again, the keyboard in the workspace's page.
  await dock(page).locator('[data-dock-close]').click();
  await page.locator('#workspace-frame').click({ position: { x: 300, y: 300 } });
  expect(await handle.evaluate(() => document.hasFocus())).toBe(true);
  fake.reply({ tools: [{ name: `${PLUGIN}__reset`, input: {} }] }, { text: 'I left it.' });
  const id = await startTurn(request, host.base, { text: 'Reset the counter.', tab: w.tab }).then((t) => t.id);
  const card = dockGate(page);
  await expect(card).toBeVisible(STEP);
  await expect(dock(page)).toBeVisible();
  await expect(card).toHaveAttribute('role', 'alertdialog');
  await expect(card.locator('.dock-gate-title')).toHaveText('Allow the Assistant to reset the counter?');
  await expect(card.locator('[data-gate-badge]')).toHaveText(["Can't be undone"]);
  await expect(card.locator('.dock-gate-help')).toHaveText('Enter or Escape answers “Don\'t”. “Allow” takes a click, or Tab then Space.');
  await expect(card.locator('.dock-gate-footer')).toHaveText(/^Asked by a request started outside this window: "Reset the counter\." · Closes in \d+ min$/);
  await expect(card.locator('[data-gate-answer="no"]')).toBeFocused();
  await expect(page.locator('#modal-confirm')).toBeHidden();
  await expect(page.locator('[data-assistant-pill]')).toBeHidden();
  await shot(page, 'question-card');
  await page.keyboard.press('Enter');
  await expect(card).toBeHidden(STEP);
  await expect.poll(async () => (await getJson(request, `/api/assistant/turns/${id}`)).turn.state, STEP).toBe('done');
  const log = (await getJson(request, `/api/assistant/turns/${id}?since=0`)).events;
  expect(log.filter((e) => e.type === 'gate_closed').map((e) => [e.answer, e.by])).toEqual([['deny', 'user']]);
  await expect(dock(page).locator('[data-gate-answer-record="deny/user"]')).toHaveText("You chose “Don't”: Allow the Assistant to reset the counter?", STEP);
  await expect(w.frame.locator('#counter')).toHaveText('0');

  // Again: Yes is off at first; a fast double-click on it never allows; a deliberate click does.
  fake.reply({ tools: [{ name: `${PLUGIN}__add`, input: { by: 2 } }] }, { tools: [{ name: `${PLUGIN}__reset`, input: {} }] }, { text: 'Reset.' });
  const second = await dockSend(page, 'Add two, then reset it');
  await expect(card).toBeVisible(STEP);
  const yes = card.locator('[data-gate-answer="yes"]');
  await expect(yes).toBeDisabled();
  await expect(yes).toBeEnabled();
  const box = await yes.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down({ clickCount: 2 });
  await page.mouse.up({ clickCount: 2 });
  await expect(card).toBeVisible();
  expect((await getJson(request, `/api/assistant/turns/${second}?since=0`)).events.filter((e) => e.type === 'gate_closed')).toEqual([]);
  await yes.click();
  await expect(card).toBeHidden(STEP);
  await expect(dockTurn(page).locator('[data-turn-end="done"]')).toBeVisible(STEP);
  await expect(w.frame.locator('#counter')).toHaveText('0');
  await expect(dockTurn(page).locator('[data-gate-answer-record="allow/user"]')).toHaveText('You chose “Allow”: Allow the Assistant to reset the counter?');
  await expect(page.locator('#modal-confirm')).toBeHidden();
});

test("a project's first cloud request asks the privacy question as a card: Don't send ends it, nothing was sent", async ({ page, request }) => {
  await postOk(request, '/api/assistant/settings', { privacy: 'ask', forget_consents: true });
  await page.goto(api(`/#/p/${project}`));
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, project, { timeout: 60_000 });
  await openDock(page);
  await expect(dock(page).locator('[data-dock-context]')).toHaveText(`Project: ${PROJECT_TITLE}`);
  const before = chats().length;
  const sent = [];
  page.on('request', (r) => {
    if (new URL(r.url()).pathname === '/api/assistant/turns' && r.method() === 'POST') sent.push(r.postDataJSON());
  });
  await dockSend(page, 'What is in this project?');
  expect(sent[0].context).toMatchObject({ project_id: project });
  expect(sent[0].tab).toBeUndefined();
  const card = dockGate(page);
  await expect(card).toHaveAttribute('data-gate-kind', 'privacy', STEP);
  await expect(card.locator('[data-gate-badge]')).toHaveText(['Project data']);
  await expect(card.locator('[data-gate-privacy-settings]')).toHaveText('Privacy settings');
  await expect(card.locator('[data-gate-answer="no"]')).toHaveText("Don't send");
  await expect(card.locator('[data-gate-answer="no"]')).toBeFocused();
  // The card sits under its request.
  await expect(dockTurn(page).locator('[data-gate]')).toHaveCount(1);
  await card.locator('[data-gate-answer="no"]').click();
  await expect(dockTurn(page).locator('[data-turn-end="stopped"]')).toContainText('Nothing was sent.', STEP);
  expect(chats().length).toBe(before);
});

test('reload: the conversation and its transcript come back, a running request shows its open question here again and is answered; another tab reads it without the question', async ({ page, request, context }) => {
  const w = await openCounter(page, request);
  await openDock(page);
  fake.reply({ tools: [{ name: `${PLUGIN}__add`, input: { by: 1 } }] }, { text: 'Added one.' });
  await dockSend(page, 'Add one');
  await expect(dockTurn(page).locator('[data-turn-end="done"]')).toBeVisible(STEP);
  fake.reply({ tools: [{ name: `${PLUGIN}__reset`, input: {} }] }, { text: 'Reset done.' });
  const held = await dockSend(page, 'Now reset it');
  await expect(dockGate(page)).toBeVisible(STEP);
  await expect(dockTurn(page).locator('[data-dock-step]')).toHaveCount(1, STEP);
  const rowsBefore = await dock(page).locator('[data-dock-turn]').evaluateAll((els) => els.map((e) => [e.getAttribute('data-dock-turn'), e.querySelectorAll('[data-dock-step]').length]));

  await page.reload();
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, project, { timeout: 60_000 });
  await expect(w.frame.locator('#ai-available')).toHaveText('yes', { timeout: 30_000 });
  // The question comes back on the new page's link (the dock opens for it), as one card.
  await expect(dockGate(page)).toBeVisible({ timeout: 30_000 });
  await expect(dock(page).locator('[data-gate]')).toHaveCount(1);
  await expect(dockGate(page).locator('[data-gate-answer="no"]')).toBeFocused();
  await expect.poll(() => dock(page).locator('[data-dock-turn]').evaluateAll((els) => els.map((e) => [e.getAttribute('data-dock-turn'), e.querySelectorAll('[data-dock-step]').length])), STEP).toEqual(rowsBefore);
  await expect(dock(page).locator('[data-dock-turn]').first().locator('[data-turn-end="done"]')).toBeVisible();

  // Another tab on the project: the conversation, the request read-only, its question elsewhere.
  const other = await context.newPage();
  try {
    await other.goto(api(`/#/p/${project}`));
    await other.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, project, { timeout: 60_000 });
    await openDock(other);
    await expect(other.locator(`#assistant-dock [data-dock-turn="${held}"] [data-dock-elsewhere-note]`)).toHaveText(/^Its questions? shows? in the window that started it\.$/, STEP);
    await expect(other.locator('#assistant-dock [data-gate]')).toHaveCount(0);
  } finally {
    await other.close();
  }

  await dockGate(page).locator('[data-gate-answer="yes"]').click();
  await expect(dockTurn(page).locator('[data-turn-end="done"]')).toBeVisible(STEP);
  await expect(w.frame.locator('#counter')).toHaveText('0');
});

test('a hidden tab: the request goes on streaming into the dock; once ended, the tab lets its stream go', async ({ page, request }) => {
  const w = await openCounter(page, request);
  await openDock(page);
  fake.reply({ tools: [{ name: `${PLUGIN}__slow_add`, input: { by: 2, steps: 15 } }] }, { text: 'Added two slowly.' });
  await dockSend(page, 'Add two slowly');
  await expect(w.frame.locator('#slow')).toHaveText('running', STEP);
  await setHidden(page, true);
  // The server still follows the turn on this tab's stream while hidden.
  await expect.poll(async () => Object.values((await getJson(request, '/api/test/assistant/state')).turn_channels || {}).reduce((a, b) => a + b, 0), STEP).toBe(1);
  await expect(dockTurn(page).locator('[data-turn-end="done"]')).toBeAttached({ timeout: 30_000 });
  await expect(dockTurn(page).locator('[data-dock-text]').last()).toHaveText('Added two slowly.');
  // Ended, and the hold after it over: the hidden tab lets its stream go after its grace.
  await expect.poll(() => serverStream(request, host, w.tab), { timeout: 30_000, message: 'the stream goes' }).toBeNull();
  await setHidden(page, false);
  await expect(dockTurn(page).locator('[data-dock-step]')).toHaveCount(1);
  await expect(dockTurn(page).locator('[data-dock-result]')).toHaveText(/^✓ /);
});

// ---------------------------------------------------------------- Undo these changes (spec 8.3)

test("Undo these changes: the workspace's offer shows on the ended request, undoes it as one step and says how to redo; the page's own change withdraws a newer offer", async ({ page, request }) => {
  const w = await openCounter(page, request);
  await openDock(page);
  fake.reply({ tools: [{ name: `${PLUGIN}__add`, input: { by: 2 } }] }, { text: 'Added two.' });
  await dockSend(page, 'Add two');
  const turn = dockTurn(page);
  await expect(turn.locator('[data-turn-end="done"]')).toBeVisible(STEP);
  await expect(w.frame.locator('#counter')).toHaveText('2');
  const undo = turn.locator('[data-dock-undo]');
  await expect(undo).toHaveText('Undo these changes', STEP);
  await expect(undo).toHaveAttribute('title', /^Undo the Assistant's changes of this request in .+ \(one step\)$/);
  await shot(page, 'undo');
  await undo.click();
  await expect(w.frame.locator('#counter')).toHaveText('0', STEP);
  await expect(turn.locator('[data-dock-undo-said]')).toHaveText(/^Undone\. Redo \(Ctrl\+Y\) in .+ brings them back\.$/);
  await expect(undo).toHaveCount(0);

  // A newer request's offer goes once the person changes the counter in the page.
  fake.reply({ tools: [{ name: `${PLUGIN}__add`, input: { by: 1 } }] }, { text: 'Added one.' });
  await dockSend(page, 'Add one');
  await expect(dockTurn(page).locator('[data-dock-undo]')).toBeVisible(STEP);
  await w.frame.locator('#bump').click();
  await expect(dockTurn(page).locator('[data-dock-undo]')).toHaveCount(0, STEP);
  await expect(w.frame.locator('#counter')).toHaveText('2');
});
