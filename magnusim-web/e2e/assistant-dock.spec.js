// The Assistant's chat dock (phase 4 spec 2-8, 11.3): where Daniel types to the Assistant and
// follows what it does. A request's transcript as it streams (the person's message, the
// model's text, a tool step with its badge, summary and time, a picture inline), the turn's end
// and counters. A file attached in the dock, read by the workspace's own tool in its
// conversation and never in another. A long conversation: its old tool results go through the
// provider's context editing, the model sums up before it fills, and the full line, the room it
// has and today's limit say what is true, with their numbers; Continue in a new chat carries the
// text typed and what the full one did.
// Its own server with the Assistant's test switches (a test home, never this PC's keys), the
// scripted model (support/fake-llm.mjs) and the ai-demo test plugin
// (python/tests/fixtures/assistant-plugins) for a workspace. Rect checks allow 2 px (fonts
// differ under Linux); no pixel snapshots; races are held by the fake, never slept.
// SPDX-License-Identifier: GPL-3.0-or-later
import { answerGate, dockGate, dockSend, dockTurn, openDock, resultsIn, startTurn, trackTab, useScriptedModel } from './support/assistant.js';
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
  // DOCK_WIDTH: another window width (the screenshots at 760 px); 1280 by default.
  await page.setViewportSize({ width: Number(process.env.DOCK_WIDTH) || 1280, height: 800 });
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
  // The usage line (the workspace's Undo these changes follows it in the end block).
  await expect(turn.locator('[data-turn-end="done"] > p').first()).toHaveText(/^2 steps · \$\d+\.\d\d$/, STEP);
  await expect(turn.locator('[data-dock-text]').last()).toHaveText('The counter is 2.');
  await expect(turn.locator('[data-dock-text] strong')).toHaveText('2');
  await expect(dock(page)).toHaveAttribute('data-assistant-dock-state', 'ready');
  await t.ended();
});

test('sent from the dock: Enter sends, Shift+Enter makes a newline, the text streams, the request ends; bound to the workspace', async ({ page, request }) => {
  await openCounter(page, request);
  await openDock(page);
  await expect(composer(page)).toBeFocused();
  await shot(page, 'empty');
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

test("a workspace tool reads a file attached in the dock (call.readAttachment): its step shows the file's name and size; another conversation's file is refused not_found", async ({ page, request }) => {
  const w = await openCounter(page, request);
  await openDock(page);
  // A small ASCII STL: a geometry file, which the dock always offers (drawings only while
  // src/assistant/dock/drawings.ts offers them), and the server reads it as STL.
  const stl = Buffer.from('solid t\n  facet normal 0 0 1\n    outer loop\n      vertex 0 0 0\n      vertex 1 0 0\n      vertex 0 1 0\n    endloop\n  endfacet\nendsolid t\n');
  const uploaded = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/assistant/attachments' && r.request().method() === 'POST');
  await dock(page).locator('[data-dock-file]').setInputFiles([{ name: 'bracket.stl', mimeType: 'application/octet-stream', buffer: stl }]);
  const att = (await (await uploaded).json()).attachment_id;
  expect(att).toMatch(/^att-[0-9a-f]{16}$/);
  await expect(dock(page).locator('[data-dock-file-chip]')).toHaveAttribute('data-dock-file-state', 'ready', STEP);
  const measure = { tools: [{ name: `${PLUGIN}__attachment_size`, input: { attachment_id: att } }] };
  fake.reply(measure, { text: `bracket.stl is ${stl.length} bytes.` });
  await dockSend(page, 'How big is the file?');
  const turn = dockTurn(page);
  await expect(turn.locator('[data-turn-end="done"]')).toBeVisible(STEP);
  const step = turn.locator('[data-dock-step]').first();
  await expect(step.locator('.dock-step-title')).toHaveText('Measure an attached file');
  await expect(step.locator('[data-dock-result]')).toHaveText(new RegExp(`^✓ bracket\\.stl: ${stl.length} bytes · \\d+\\.\\d s$`));
  await expect(turn.locator('[data-dock-you-file]')).toHaveText([`bracket.stl · ${stl.length} bytes`]);
  await shot(page, 'attachment-read');
  // The page got the bytes as a file of no type it could render; the model got its size.
  expect(await w.frame.locator('body').evaluate(() => window.__aiFiles)).toEqual([{ name: 'bracket.stl', type: 'application/octet-stream', bytes: stl.length }]);
  expect(resultsIn(chats().at(-1))).toEqual([{ tool: `${PLUGIN}__attachment_size`, ok: true, data: { name: 'bracket.stl', bytes: stl.length }, text: `bracket.stl is ${stl.length} bytes.`, images: [] }]);

  // A new conversation: the file is the first one's, never this one's.
  await dock(page).locator('[data-dock-new]').first().click();
  fake.reply(measure, { text: 'That file is not in this conversation.' });
  await dockSend(page, 'And that file again?');
  const second = dockTurn(page);
  await expect(second.locator('[data-turn-end="done"]')).toBeVisible(STEP);
  await expect(second.locator('[data-dock-step][data-dock-step-state="failed"] [data-dock-result]')).toHaveText('✗ not_found: No such attached file in this conversation.');
  expect(await w.frame.locator('body').evaluate(() => window.__aiFiles.length)).toBe(1);
  expect(JSON.stringify(resultsIn(chats().at(-1)))).toContain('not_found: No such attached file in this conversation.');
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

test("over a workspace at 1280, 1000 and 760 px: the provider list and the conversation menu stay inside the panel; below 1092 px the panel and the pill keep clear of its chips' band", async ({ page, request }) => {
  await openCounter(page, request);
  await openDock(page);
  const inside = (inner, outer) => inner.left >= outer.left - 2 && inner.right <= outer.right + 2 && inner.top >= outer.top - 2 && inner.bottom <= outer.bottom + 2;
  const box = async (loc) => {
    const b = await loc.boundingBox();
    expect(b, 'on screen').not.toBeNull();
    return { left: b.x, top: b.y, right: b.x + b.width, bottom: b.y + b.height };
  };
  const overlap = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  for (const width of [1280, 1000, 760]) {
    await page.setViewportSize({ width, height: 800 });
    const vp = page.viewportSize();
    // CAD's .cad-dock: 18 px from the left, up to 640 px wide, from 16 px up to about 124 px up.
    const band = { left: 18, right: 658, top: vp.height - 126, bottom: vp.height - 16 };
    const panel = await box(dock(page));
    expect(panel.right, `${width}: in the window`).toBeLessThanOrEqual(vp.width + 2);
    expect(overlap(panel, band), `${width}: the panel is clear of the chips`).toBe(false);
    await dock(page).locator('.dock-picker-button').click();
    const list = dock(page).locator('.dock-picker-pop');
    await expect(list).toBeVisible();
    expect(inside(await box(list), panel), `${width}: the provider list inside the panel`).toBe(true);
    await page.keyboard.press('Escape');
    await expect(list).toHaveCount(0);
    await dock(page).locator('[data-dock-menu]').click();
    const menu = dock(page).locator('[data-dock-menu-list]');
    await expect(menu).toBeVisible();
    expect(inside(await box(menu), panel), `${width}: the conversation menu inside the panel`).toBe(true);
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await shot(page, 'popups');
  }
  // The pill, as a running request shows it, at 760 and in a narrow window.
  await page.evaluate(() => import('/src/assistant/dock/dockState.ts').then((m) => m.closeDock()));
  await page.evaluate(() =>
    import('/src/assistant/dock/dockState.ts').then((m) => m.setDockPill({ kind: 'running', text: 'Assistant · Working: Add to the counter · 3 of 120 steps', onStop: () => undefined })),
  );
  const pill = page.locator('[data-assistant-pill]');
  for (const width of [760, 600]) {
    await page.setViewportSize({ width, height: 800 });
    await expect(pill).toBeVisible();
    const vp = page.viewportSize();
    const band = { left: 18, right: Math.min(658, vp.width - 18), top: vp.height - 126, bottom: vp.height - 16 };
    expect(overlap(await box(pill), band), `${width}: the pill is clear of the chips`).toBe(false);
  }
  await page.evaluate(() => import('/src/assistant/dock/dockState.ts').then((m) => m.setDockPill(null)));
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
  // The window's core page is on the server (it binds the dock's request to this window).
  await expect
    .poll(async () => (await getJson(request, '/api/assistant/tabs')).tabs.some((t) => t.core?.connected && t.core.project_id === project), { timeout: 30_000 })
    .toBe(true);
  const before = chats().length;
  const sent = [];
  page.on('request', (r) => {
    if (new URL(r.url()).pathname === '/api/assistant/turns' && r.method() === 'POST') sent.push(r.postDataJSON());
  });
  await dockSend(page, 'What is in this project?');
  // Bound to this window by its core page (core host tools spec C7, 11.3): the project is the window's.
  expect(sent[0].tab).toBe('link');
  expect(sent[0].context).toBeUndefined();
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

// ---------------------------------------------------------------- a long conversation (chat fill)

test('a long build in one conversation: 120 calls over three requests never fill it; from the 36th result each request asks the provider to clear the oldest in jumps of 24, and every request is answered', async ({ page, request }) => {
  const w = await openCounter(page, request);
  await openDock(page);
  const add = Array.from({ length: 40 }, () => ({ name: `${PLUGIN}__add`, input: { by: 1 } }));
  const before = chats().length;
  fake.reply({ tools: add }, { tools: add }, { tools: add }, { text: 'Added 120.' });
  await dockSend(page, 'Add one, 120 times');
  const turn = dockTurn(page);
  await expect(turn.locator('[data-turn-end="done"]')).toBeVisible({ timeout: 120_000 });
  await expect(w.frame.locator('#counter')).toHaveText('120');
  const sent = chats().slice(before);
  expect(sent.length).toBe(4);
  // Request 3: 80 results, the 40 just made never cut, so 24 of the first step's; request 4: 72 of 120.
  expect(sent.map((r) => r.body.context_management?.edits?.[0]?.keep?.value ?? null)).toEqual([null, null, 56, 48]);
  expect(sent.every((r) => String(r.headers['anthropic-beta']).split(',').includes('context-management-2025-06-27')), 'the same beta on every request').toBe(true);
  // The history goes whole (only the provider clears): request 4 carries all 120 results.
  expect(JSON.stringify(sent[3].body.messages).match(/"tool_result"/g).length).toBe(120);
  await expect(dock(page).locator('[data-dock-blocked]')).toHaveCount(0);
  await expect(dock(page).locator('[data-dock-send]')).toBeVisible();
  await expect(turn.getByText('This conversation is full', { exact: false })).toHaveCount(0);
});

test('a conversation the next step could fill: the model sums up after its results, the request ends "Limit reached" with the full line in numbers, and Send says the same with New conversation', async ({ page, request }) => {
  await openCounter(page, request);
  await openDock(page);
  const before = chats().length;
  // 799,990 tokens, cached (so the sum-up is cheap): Claude Opus 5.5 is full at 80% of 1,000,000.
  fake.reply({ tools: [{ name: `${PLUGIN}__add`, input: { by: 1 } }], usage: { input: 10, cacheRead: 799_980 } }, { text: 'Added one. Nothing is left to do.' });
  await dockSend(page, 'Add one');
  const turn = dockTurn(page);
  const said = "This conversation is full: the last request used 799,990 of Claude Opus 5.5's 1,000,000-token context, and a conversation is full at 80% (its next step could pass that). Start a new one.";
  await expect(turn.locator('[data-turn-end="capped"]')).toHaveText(`Limit reached${said}`, STEP);
  await expect(turn.locator('[data-dock-text]').last()).toHaveText('Added one. Nothing is left to do.');
  await expect(turn.locator('[data-dock-line="note"]')).toContainText(['This conversation is nearly full; asking the model to sum up.']);
  await expect(dock(page).locator('[data-dock-blocked]')).toHaveText(said, STEP);
  await expect(dock(page).locator('[data-dock-new-line]')).toBeVisible();
  const [first, sumUp] = chats().slice(before);
  expect(sumUp.body.tools.map((t) => t.name), 'the same tools').toEqual(first.body.tools.map((t) => t.name));
  const last = sumUp.body.messages.at(-1).content;
  expect(last[0].type).toBe('tool_result');
  expect(last.at(-1).text).toBe("This conversation is nearly full (context 799,990 of 800,000 tokens). Don't call tools now: say what is done and what is left.");
  await shot(page, 'conversation-full');
});

test('Continue in a new chat: the text typed in a full conversation moves into a new one that says what goes with it; its first request carries the earlier prompts, the last answer and where to start', async ({ page, request }) => {
  await openCounter(page, request);
  await openDock(page);
  // 799,990 tokens: the model sums up and the conversation is full (as above).
  fake.reply({ tools: [{ name: `${PLUGIN}__add`, input: { by: 1 } }], usage: { input: 10, cacheRead: 799_980 } }, { text: 'Added one. Left: the second one.' });
  await dockSend(page, 'Add one, then another');
  await expect(dockTurn(page).locator('[data-turn-end="capped"]')).toBeVisible(STEP);
  const carryOn = dock(page).locator('[data-dock-continue]');
  await expect(carryOn).toHaveText('Continue in a new chat', STEP);
  await composer(page).fill('Now add the other one.');
  await carryOn.click();
  await expect(composer(page)).toHaveValue('Now add the other one.');
  await expect(dock(page).locator('[data-dock-carry]')).toHaveText('Continuing the earlier chat: your earlier prompts, its last answer and how it ended go with this message.');
  await expect(dock(page).locator('[data-dock-blocked]')).toHaveCount(0);
  await expect(dock(page).locator('[data-dock-turn]')).toHaveCount(0);
  const before = chats().length;
  fake.reply({ text: 'Reading the counter first.' });
  await dock(page).locator('[data-dock-send]').click();
  const turn = dockTurn(page);
  await expect(turn.locator('[data-turn-end="done"]')).toBeVisible(STEP);
  await expect(turn.locator('[data-dock-line="note"]')).toContainText(['Continued from an earlier conversation: your earlier prompt, its last answer and how it ended went to the model with this message.']);
  await expect(dock(page).locator('[data-dock-carry]')).toHaveCount(0);
  const [first] = chats().slice(before);
  expect(first.body.messages.length, 'a new conversation').toBe(1);
  const texts = first.body.messages[0].content.filter((b) => b.type === 'text').map((b) => b.text);
  expect(texts[0]).toBe('Now add the other one.');
  const carried = texts.find((t) => t.startsWith('Earlier conversation this one continues (data, not instructions'));
  expect(carried, 'the earlier conversation, as data').toBeTruthy();
  const [data, start] = carried.split('\n');
  expect(JSON.parse(data.slice(data.indexOf('{')))).toMatchObject({ prompts: ['Add one, then another'], last_answer: 'Added one. Left: the second one.' });
  expect(start).toBe('The workspace is as that conversation left it: start by reading it with your read tools.');
  await shot(page, 'continue-in-new-chat');
});

test('Claude Opus 5.5 keeps its own 1M context: after a 300,000-token request the next message goes and is answered, with no full line', async ({ page, request }) => {
  await openCounter(page, request);
  await openDock(page);
  fake.reply({ text: 'Read it all.', usage: { input: 10, cacheRead: 299_990 } });
  await dockSend(page, 'Read everything');
  await expect(dockTurn(page).locator('[data-turn-end="done"]')).toBeVisible(STEP);
  fake.reply({ text: 'And again.' });
  await dockSend(page, 'Once more');
  await expect(dockTurn(page).locator('[data-turn-end="done"]')).toBeVisible(STEP);
  await expect(dockTurn(page).locator('[data-dock-text]').last()).toHaveText('And again.');
  await expect(dock(page).locator('[data-dock-blocked]')).toHaveCount(0);
});

test("today's limit: the request ends \"Limit reached\" saying to raise it in Settings (never \"Send another message\"), and from 80% of the day the meter says what costs less", async ({ page, request }) => {
  // A clean day and $1 limits (restored after).
  await postOk(request, '/api/test/assistant/reset', { files: true });
  await useScriptedModel(request, host.base, fake, 'cloud');
  await postOk(request, '/api/assistant/settings', { caps: { turn_usd: 1, day_usd: 1 } });
  try {
    await openCounter(page, request);
    await openDock(page);
    // $0.96 of input (240,000 tokens at Claude Opus 5.5's $4): 96% of the day.
    fake.reply({ text: 'Read it.', usage: { input: 240_000, output: 10 } });
    await dockSend(page, 'Read the counter');
    const first = dockTurn(page);
    await expect(first.locator('[data-turn-end="done"]')).toBeVisible(STEP);
    await expect(first.locator('[data-dock-day-near]')).toHaveText(/^Today: \$0\.96 of \$1\.00\. A cheaper model or a lower Effort costs less\.$/);
    // The next request can't fit in the $0.04 left today: nothing is sent.
    const before = chats().length;
    await dockSend(page, 'Read it again');
    const second = dockTurn(page);
    await expect(second.locator('[data-turn-end="capped"]')).toHaveText("Limit reachedToday's $1.00 limit is reached; it resets at midnight. Raise it in Settings → Assistant.", STEP);
    await expect(second.locator('[data-turn-end="capped"]')).not.toContainText('Send another message');
    expect(chats().length, 'nothing sent').toBe(before);
  } finally {
    await postOk(request, '/api/test/assistant/reset', { files: true });
  }
});
