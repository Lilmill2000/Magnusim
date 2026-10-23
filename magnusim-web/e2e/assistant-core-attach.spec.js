// Files attached in the Assistant's dock (core host tools spec 13, C9): the person attaches a
// STEP or STL file beside the pictures (Attach, paste or a drop) in a project; its chip shows
// its name and size and uploads at once; the request names it and the model gets one line per
// file with its attachment_id; the person's message lists it. Too big or another type is
// refused in plain words before anything is sent; a file the server can't read as its type is
// refused with the server's words. A forgotten conversation's files go; one never sent is swept
// and the send then says so; a conversation can't use another conversation's file. An attached
// STEP the model imports (import_file by its attachment_id) asks first, then the project has it.
// Its own server with the Assistant's test switches (a test home, never this PC's keys) and the
// scripted model (support/fake-llm.mjs). No WSL.
// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dockSend, dockTurn, openDock, useScriptedModel } from './support/assistant.js';
import { startFakeLlm } from './support/fake-llm.mjs';
import { startHost } from './support/host-server.mjs';
import { expect, test } from './support/stress.js';

const STEP_WAIT = { timeout: 15_000 };
const PROJECT_TITLE = 'Attach project';

let host;
let fake;
let project;

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
    name: 'assistant-attach',
    env: {
      MAGNUSIM_TEST_ASSISTANT: '1',
      MAGNUSIM_TEST_ASSISTANT_PROVIDER_URL: fake.base,
      MAGNUSIM_TEST_EVENT_HUB: '1',
    },
  });
  project = (await postOk(request, '/api/project', { title: PROJECT_TITLE, folder: 'My Projects', units: 'Metric', category: 'Other' })).id;
});

test.afterAll(async () => {
  if (host) host.stop();
  if (fake) await fake.stop();
});

test.beforeEach(async ({ request, page }) => {
  await postOk(request, '/api/test/assistant/reset', { files: true });
  await useScriptedModel(request, host.base, fake, 'cloud');
  await page.setViewportSize({ width: 1280, height: 800 });
});

test.afterEach(() => {
  expect(fake.pending(), 'scripted answers left unused').toBe(0);
});

// ---------------------------------------------------------------- helpers

const dock = (page) => page.locator('#assistant-dock');
const chips = (page) => dock(page).locator('[data-dock-file-chip]');
const fileErrors = (page) => dock(page).locator('[data-dock-file-error]');
const chats = () => fake.requests().filter((r) => r.kind === 'chat');

/** A STEP file of about `kb` KB that the server reads as STEP. */
function stepFile(kb = 3) {
  const head = "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('bracket'),'2;1');\nENDSEC;\nDATA;\n";
  const tail = 'ENDSEC;\nEND-ISO-10303-21;\n';
  const pad = Math.max(0, kb * 1024 - head.length - tail.length);
  return Buffer.from(head + '/* pad */\n'.repeat(Math.ceil(pad / 10)).slice(0, pad) + tail);
}

/** A binary STL of `n` triangles (84 + 50 n bytes), its header starting "solid" as exporters write it. */
function stlFile(n) {
  const b = Buffer.alloc(84 + 50 * n);
  b.write('solid wing', 0, 'ascii');
  b.writeUInt32LE(n, 80);
  return b;
}

/** With DOCK_SHOTS=<folder>: a screenshot of the window for a person to look at (never compared). */
async function shot(page, name) {
  if (!process.env.DOCK_SHOTS) return;
  await page.screenshot({ path: `${process.env.DOCK_SHOTS}/attach-${name}.png` });
}

/** Every text the person's messages carried to the model (any dialect). */
function userTexts(req) {
  const out = [];
  for (const m of req.body?.messages ?? []) {
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') out.push(m.content);
    else for (const c of m.content ?? []) if (c && typeof c.text === 'string') out.push(c.text);
  }
  return out;
}

/** Opens the project in the window and the dock. */
async function openProject(page) {
  await page.goto(api(`/#/p/${project}`));
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, project, { timeout: 60_000 });
  await openDock(page);
  await expect(dock(page).locator('[data-dock-context]')).toHaveText(`Project: ${PROJECT_TITLE}`);
}

/** A drop of `files` ([{name, size?, bytes?}]) on the dock, built in the page; `size` stands in for a big file's. */
async function dropFiles(page, files) {
  await page.evaluate((list) => {
    const made = list.map((f) => {
      const file = new File([Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0))], f.name);
      if (f.size) Object.defineProperty(file, 'size', { value: f.size });
      return file;
    });
    const panel = document.getElementById('assistant-dock');
    const ev = (type) => {
      const e = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(e, 'dataTransfer', { value: { types: ['Files'], files: made, items: [] } });
      return e;
    };
    panel.dispatchEvent(ev('dragenter'));
    panel.dispatchEvent(ev('drop'));
  }, files.map((f) => ({ name: f.name, size: f.size ?? 0, b64: (f.bytes ?? Buffer.alloc(1)).toString('base64') })));
}

/** POST /api/assistant/turns from the window itself, with its own live link (as the dock sends one). */
function postTurnFromWindow(page, body) {
  return page.evaluate(async (b) => {
    const { withAssistantLink } = await import('/src/assistant/relay.ts');
    return withAssistantLink(async (link) => {
      const r = await fetch('/api/assistant/turns', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...b, link }) });
      return { status: r.status, body: await r.json() };
    });
  }, body);
}

// ---------------------------------------------------------------- tests

test('a STEP and an STL attached in the dock: chips with name and size, uploaded; the request names them, the model gets one line each, the message lists them', async ({ page, request }) => {
  await openProject(page);
  await expect(dock(page).locator('[data-dock-attach]')).toHaveAttribute('aria-label', 'Attach pictures or files');
  const step = stepFile(3);
  const stl = stlFile(40);
  await dock(page).locator('[data-dock-file]').setInputFiles([
    { name: 'bracket.step', mimeType: 'application/octet-stream', buffer: step },
    { name: 'wing.stl', mimeType: 'application/octet-stream', buffer: stl },
  ]);
  await expect(chips(page)).toHaveCount(2, STEP_WAIT);
  await expect(chips(page).nth(0)).toContainText('bracket.step · 3 KB');
  await expect(chips(page).nth(1)).toContainText('wing.stl · 2 KB');
  for (const i of [0, 1]) await expect(chips(page).nth(i)).toHaveAttribute('data-dock-file-state', 'ready', STEP_WAIT);
  await expect(dock(page).getByText('Files stay on this PC. The Assistant gets their names and can import them into the project open here.')).toBeVisible();
  await shot(page, 'chips');
  // Kept on this PC, from this window, not yet any conversation's.
  const kept = (await getJson(request, '/api/test/assistant/state')).attachments;
  expect(kept.map((a) => [a.name, a.bytes, a.format, a.conversation]).sort()).toEqual([
    ['bracket.step', step.length, 'step', null],
    ['wing.stl', stl.length, 'stl', null],
  ]);

  fake.reply({ text: 'I can import bracket.step and wing.stl.' });
  const id = await dockSend(page, 'Import these two');
  await expect(dockTurn(page).locator('[data-turn-end="done"]')).toBeVisible(STEP_WAIT);
  const byName = Object.fromEntries(kept.map((a) => [a.name, a.id]));
  expect(userTexts(chats().at(-1))).toContain(
    `[Attached file: "bracket.step", 3 KB, attachment_id ${byName['bracket.step']}]\n[Attached file: "wing.stl", 2 KB, attachment_id ${byName['wing.stl']}]`,
  );
  // The person's message lists its files; the composer is clear for the next one.
  const files = dockTurn(page).locator('[data-dock-you-file]');
  await expect(files).toHaveText(['bracket.step · 3 KB', 'wing.stl · 2 KB']);
  await shot(page, 'sent');
  await expect(chips(page)).toHaveCount(0);
  const turn = await getJson(request, `/api/assistant/turns/${id}`);
  expect(turn.turn.attachments.map((a) => a.name)).toEqual(['bracket.step', 'wing.stl']);
  expect(turn.turn.project_id).toBe(project);
  const after = (await getJson(request, '/api/test/assistant/state')).attachments;
  expect(after.map((a) => a.conversation)).toEqual([turn.turn.conversation, turn.turn.conversation]);
});

test('refused in plain words: a file over 500 MB and another type before anything is sent; a .step that is not STEP with the server\'s words', async ({ page, request }) => {
  await openProject(page);
  const uploads = [];
  page.on('request', (r) => {
    if (new URL(r.url()).pathname === '/api/assistant/attachments') uploads.push(r.url());
  });
  // A 600 MB file (its size stands in; nothing that big is read or sent).
  await dropFiles(page, [{ name: 'huge.step', size: 600 * 1024 * 1024 }]);
  await expect(fileErrors(page)).toHaveText(['huge.step is larger than 500 MB. Import it with + Add geometry.']);
  await dock(page).locator('[data-dock-file]').setInputFiles([{ name: 'plugin.zip', mimeType: 'application/zip', buffer: Buffer.from('PK\u0003\u0004 not for the Assistant') }]);
  await expect(fileErrors(page)).toHaveText(['Only pictures and geometry files (STEP, IGES, BREP, STL, OBJ, PLY) can be attached.']);
  await expect(chips(page)).toHaveCount(0);
  expect(uploads, 'nothing was sent').toEqual([]);
  // Named STEP, but a picture's bytes: the server reads its first bytes and says so.
  await dock(page).locator('[data-dock-file]').setInputFiles([{ name: 'fake.step', mimeType: 'application/octet-stream', buffer: Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex') }]);
  await expect(fileErrors(page)).toHaveText(["fake.step doesn't look like a STEP file."], STEP_WAIT);
  await expect(chips(page)).toHaveCount(0);
  expect((await getJson(request, '/api/test/assistant/state')).attachments).toEqual([]);
  // A fifth file in one message.
  await dock(page).locator('[data-dock-file]').setInputFiles(['a', 'b', 'c', 'd', 'e'].map((n) => ({ name: `${n}.step`, mimeType: 'application/octet-stream', buffer: stepFile(1) })));
  await expect(chips(page)).toHaveCount(4, STEP_WAIT);
  await expect(fileErrors(page)).toHaveText(['At most 4 files per message.']);
  await shot(page, 'fifth');
});

test("swept when it should be: a forgotten conversation's file goes; one never sent goes after an hour, and sending it then says so", async ({ page, request }) => {
  await openProject(page);
  await dock(page).locator('[data-dock-file]').setInputFiles([{ name: 'part.step', mimeType: 'application/octet-stream', buffer: stepFile(1) }]);
  await expect(chips(page).first()).toHaveAttribute('data-dock-file-state', 'ready', STEP_WAIT);
  fake.reply({ text: 'Noted.' });
  const id = await dockSend(page, 'Keep this one');
  await expect(dockTurn(page).locator('[data-turn-end="done"]')).toBeVisible(STEP_WAIT);
  const conv = (await getJson(request, `/api/assistant/turns/${id}`)).turn.conversation;
  expect((await getJson(request, '/api/test/assistant/state')).attachments.map((a) => a.conversation)).toEqual([conv]);
  // Forget the conversation in the dock: its file goes with it.
  await dock(page).locator('[data-dock-menu]').click();
  await dock(page).locator(`[data-dock-forget="${conv}"]`).click();
  await page.locator('#cf-confirm').click();
  await expect.poll(async () => (await getJson(request, '/api/test/assistant/state')).attachments.length, STEP_WAIT).toBe(0);

  // Attached and never sent: the sweep takes it after an hour (as if the sweep ran then).
  await dock(page).locator('[data-dock-file]').setInputFiles([{ name: 'late.stl', mimeType: 'application/octet-stream', buffer: stlFile(2) }]);
  await expect(chips(page).first()).toHaveAttribute('data-dock-file-state', 'ready', STEP_WAIT);
  expect((await postOk(request, '/api/test/assistant/attachments/sweep', { later_ms: 30 * 60 * 1000 })).removed).toBe(0);
  expect((await postOk(request, '/api/test/assistant/attachments/sweep', { later_ms: 61 * 60 * 1000 })).removed).toBe(1);
  const sent = chats().length;
  await dock(page).getByRole('textbox', { name: 'Message to the Assistant' }).fill('Import it now');
  await dock(page).locator('[data-dock-send]').click();
  await expect(dock(page).locator('[data-dock-refusal="attachment_gone"]')).toHaveText('An attached file is no longer kept on this PC. Remove it and attach it again.', STEP_WAIT);
  // The chip stays for the person to remove; the request was never sent.
  await expect(chips(page)).toHaveCount(1);
  expect(chats().length).toBe(sent);
  await dock(page).getByRole('button', { name: 'Remove late.stl' }).click();
  await expect(chips(page)).toHaveCount(0);
});

test('an attached STEP is imported by the Assistant: it asks first, then the project has the new geometry and the window shows it', async ({ page, request }) => {
  test.setTimeout(240_000);
  await openProject(page);
  const elbow = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'python', 'tests', 'fixtures', 'geometry', 'elbow.step'));
  await dock(page).locator('[data-dock-file]').setInputFiles([{ name: 'elbow.step', mimeType: 'application/octet-stream', buffer: elbow }]);
  await expect(chips(page).first()).toHaveAttribute('data-dock-file-state', 'ready', STEP_WAIT);
  const [att] = (await getJson(request, '/api/test/assistant/state')).attachments;
  const before = ((await getJson(request, `/api/project?project_id=${project}`)).project.geometries || []).length;
  fake.reply(
    { text: 'Importing it.', tools: [{ name: 'import_file', input: { project_id: '', attachment_id: att.id, path: '', as: 'geometry', length_unit: '' } }] },
    { text: 'elbow.step is in the project.' },
  );
  await dockSend(page, 'Import the elbow');
  // An import runs a computation on this PC: the person is asked first, in the dock.
  const gate = dock(page).locator('[data-gate]').first();
  await expect(gate).toBeVisible(STEP_WAIT);
  await expect(gate.locator('.dock-gate-title')).toHaveText('Allow the Assistant to import a geometry file?');
  await gate.locator('[data-gate-answer="yes"]').click({ timeout: STEP_WAIT.timeout });
  await expect(dockTurn(page).locator('[data-turn-end="done"]')).toBeVisible({ timeout: 120_000 });
  const geoms = (await getJson(request, `/api/project?project_id=${project}`)).project.geometries;
  expect(geoms.length).toBe(before + 1);
  const added = geoms.at(-1);
  expect(added.original_filename).toBe('elbow.step');
  // The window shows it (after a reload until the open window's live reload lands).
  await page.reload();
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, project, { timeout: 60_000 });
  await expect(page.locator('#left-tree')).toContainText(added.name, STEP_WAIT);
});

test("a conversation can't use another conversation's file", async ({ page, request }) => {
  await openProject(page);
  await dock(page).locator('[data-dock-file]').setInputFiles([{ name: 'mine.step', mimeType: 'application/octet-stream', buffer: stepFile(1) }]);
  await expect(chips(page).first()).toHaveAttribute('data-dock-file-state', 'ready', STEP_WAIT);
  fake.reply({ text: 'Mine.' });
  const id = await dockSend(page, 'This one is mine');
  await expect(dockTurn(page).locator('[data-turn-end="done"]')).toBeVisible(STEP_WAIT);
  const conv = (await getJson(request, `/api/assistant/turns/${id}`)).turn.conversation;
  const [att] = (await getJson(request, '/api/test/assistant/state')).attachments;
  expect(att.conversation).toBe(conv);
  // The same window names it in a new conversation: refused, nothing sent to the model.
  const before = chats().length;
  const r = await postTurnFromWindow(page, { text: 'Use theirs', context: { project_id: project }, attachments: [att.id] });
  expect(r).toEqual({ status: 409, body: { ok: false, code: 'attachment_gone', error: 'An attached file is no longer kept on this PC. Remove it and attach it again.' } });
  expect(chats().length).toBe(before);
  expect((await getJson(request, '/api/test/assistant/state')).attachments.map((a) => a.conversation)).toEqual([conv]);
  // Its own conversation may name it again.
  fake.reply({ text: 'Again.' });
  const again = await postTurnFromWindow(page, { text: 'Once more', conversation: conv, context: { project_id: project }, attachments: [att.id] });
  expect(again.status, JSON.stringify(again.body)).toBe(202);
  await expect.poll(async () => (await getJson(request, `/api/assistant/turns/${again.body.turn}`)).turn.state, STEP_WAIT).toBe('done');
});
