// The chat dock with a coding agent (phase 4 spec 2.3, 2.7, 2.9, 11.3-8): the provider picker
// lists the agent found beside the API-key providers ("<name> (coding agent)", its detail and
// who pays), a pick of it sends the request to the agent, and the dock shows its line, its plan,
// the workspace tool it called and its counters, billed to its own account; Attach takes its
// files, and the person's pictures while the agent may take them (its catalogue entry before it
// started, then what its start said); the picker is locked after the first message. An agent
// that takes pictures gets them with the message and the transcript shows them; one whose start
// says it takes none ends the request with the words why, and the dock then takes files only.
// The agent is the scripted coding agent
// (e2e/support/fake-acp-agent.mjs) installed as npm installs the known agent in a temp folder
// that agent discovery's test switches point at (never this PC's PATH or home), signed in by its
// login file there; the turns work in the ai-demo counter workspace.
// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dockSend, dockTurn, openDock, resetAssistant, trackTab, useScriptedModel } from './support/assistant.js';
import { startFakeAcp } from './support/fake-acp.mjs';
import { startFakeLlm } from './support/fake-llm.mjs';
import { e2eTemp, startHost } from './support/host-server.mjs';
import { expect, test } from './support/stress.js';

const WIN = process.platform === 'win32';
const AGENT = { id: 'claude', name: 'Claude Code', pkg: '@agentclientprotocol/claude-agent-acp', program: 'claude-agent-acp', version: '0.85.1' };
const PLUGIN = 'ai-demo';
const STEP = { timeout: 30_000 };
const ACCEPT_FILES = '.step,.stp,.iges,.igs,.brep,.brp,.stl,.obj,.ply,.svg,.dxf';
const ACCEPT_ALL = `image/png,image/jpeg,image/webp,${ACCEPT_FILES}`;
/** The words a request with pictures ends with on an agent whose start says it takes none (turns.ts AGENT_IMAGES_TEXT). */
const AGENT_IMAGES_TEXT = / doesn't take pictures\. Send the message without them\.$/;

let host;
let fake;
let llm;
let home;
let project;
let study;

const api = (path) => `${host.base}${path}`;
async function postOk(request, path, data = {}) {
  const r = await request.post(api(path), { data });
  const j = await r.json().catch(() => ({}));
  expect(r.ok(), `${path}: ${r.status()} ${JSON.stringify(j)}`).toBe(true);
  return j;
}

const winRel = (...parts) => parts.join('/').split('/').join('\\');
/** npm's Windows shim for a script inside <dir>/node_modules (what discovery parses, never runs). */
const cmdShim = (rel) =>
  [
    '@ECHO off',
    'GOTO start',
    ':find_dp0',
    'SET dp0=%~dp0',
    'EXIT /b',
    ':start',
    'SETLOCAL',
    'CALL :find_dp0',
    '',
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ') ELSE (',
    '  SET "_prog=node"',
    '  SET PATHEXT=%PATHEXT:;.JS;=;%',
    ')',
    '',
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${rel}" %*`,
    '',
  ].join('\r\n');

/** The known agent installed as npm installs it globally, its bin the fake's launcher. */
async function installKnown(prefix) {
  const { chmodSync, symlinkSync } = await import('node:fs');
  const modules = WIN ? join(prefix, 'node_modules') : join(prefix, 'lib', 'node_modules');
  const pkgDir = join(modules, ...AGENT.pkg.split('/'));
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: AGENT.pkg, version: AGENT.version, bin: { [AGENT.program]: 'dist/index.js' } }));
  const script = fake.writeLauncher(join(pkgDir, 'dist', 'index.js'), { version: AGENT.version });
  if (WIN) {
    writeFileSync(join(prefix, `${AGENT.program}.cmd`), cmdShim(winRel('node_modules', AGENT.pkg, 'dist/index.js')));
  } else {
    chmodSync(script, 0o755);
    mkdirSync(join(prefix, 'bin'), { recursive: true });
    symlinkSync(join('..', 'lib', 'node_modules', ...AGENT.pkg.split('/'), 'dist', 'index.js'), join(prefix, 'bin', AGENT.program));
  }
}

test.beforeAll(async ({ request }) => {
  test.setTimeout(240_000);
  fake = await startFakeAcp({ style: 'tool_name_meta', agentInfo: { name: 'claude-agent-acp', title: AGENT.name, version: AGENT.version } });
  llm = await startFakeLlm();
  const tmp = e2eTemp('assistant-dock-agent');
  const prefix = join(tmp, 'npm');
  home = join(tmp, 'home');
  mkdirSync(prefix, { recursive: true });
  await installKnown(prefix);
  // Signed in: its login file.
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude', '.credentials.json'), '{}');
  host = await startHost({
    name: 'assistant-dock-agent',
    tmp,
    pluginsFrom: 'python/tests/fixtures/assistant-plugins',
    env: {
      MAGNUSIM_TEST_ASSISTANT: '1',
      MAGNUSIM_TEST_ASSISTANT_PROVIDER_URL: llm.base,
      MAGNUSIM_TEST_ASSISTANT_AGENT_PATHS: WIN ? prefix : join(prefix, 'bin'),
      MAGNUSIM_TEST_ASSISTANT_AGENT_HOME: home,
      MAGNUSIM_TEST_EVENT_HUB: '1',
    },
  });
  project = (await postOk(request, '/api/project', { title: 'Agent dock project', folder: 'My Projects', units: 'Metric', category: 'Other' })).id;
  study = (await postOk(request, '/api/plugin-studies/create', { project_id: project, plugin: PLUGIN, kind: 'counter_case', title: 'Counter 1' })).study.id;
});

test.afterAll(async () => {
  if (host) host.stop();
  if (fake) await fake.stop();
  if (llm) await llm.stop();
});

test.afterEach(async ({ request }) => {
  const unused = fake.pending();
  // The reset ends every agent; none of its processes is left.
  await resetAssistant(request, host.base);
  const isRunning = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return err.code === 'EPERM';
    }
  };
  await expect.poll(() => fake.pids().filter((p) => isRunning(p.pid)).length, { timeout: 15_000, message: 'no agent process left' }).toBe(0);
  expect(unused, 'every scripted prompt was used').toBe(0);
});

// First in this file: nothing has looked for agents since the server started.
test('after the app starts, the dock offers the coding agent without Settings having been opened (seen live: no Claude Code in the picker after a restart)', async ({ page, request }) => {
  test.setTimeout(120_000);
  await useScriptedModel(request, host.base, llm, 'cloud');
  const before = await (await request.get(api('/api/assistant/status'))).json();
  expect(before.agents_checked_at ?? null, 'no discovery yet: the test means something').toBeNull();
  expect(Object.keys(before.providers_ready)).not.toContain(`agent:${AGENT.id}`);
  await page.goto(api('/#/'));
  await openDock(page);
  const dock = page.locator('#assistant-dock');
  await dock.locator('.dock-picker-button').click();
  const agent = dock.locator(`[data-dock-provider-option="agent:${AGENT.id}"]`);
  await expect(agent.locator('.dock-picker-option-text')).toHaveText(`${AGENT.name} (coding agent)`, STEP);
  await expect(agent).not.toHaveAttribute('aria-disabled', 'true');
});

test("the picker offers the coding agent beside the API keys; a request on it shows its line, plan, Magnusim's tool, counters and who pays; Attach takes files, and pictures until its start says no; locked after", async ({ page, request }) => {
  test.setTimeout(180_000);
  await resetAssistant(request, host.base);
  await useScriptedModel(request, host.base, llm, 'cloud');
  await postOk(request, '/api/assistant/settings', { privacy: 'allow' });
  // Discovery looks in the test folder only.
  const agents = await (await request.get(api('/api/assistant/agents?refresh=1'))).json();
  expect(agents.agents.find((a) => a.id === AGENT.id)).toMatchObject({ found: true, ready: true });

  const tabOf = trackTab(page);
  await page.goto(api(`/#/p/${project}`));
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, project, { timeout: 60_000 });
  await page.evaluate((h) => {
    window.location.hash = h;
  }, `#/p/${project}/ws/${PLUGIN}/counter/${study}`);
  const frame = page.frameLocator('#workspace-frame');
  await expect(frame.locator('#ai-available')).toHaveText('yes', { timeout: 60_000 });
  await expect.poll(tabOf).not.toBe('');
  await openDock(page);
  const dock = page.locator('#assistant-dock');
  await dock.locator('.dock-picker-button').click();
  const options = dock.getByRole('listbox').getByRole('option');
  await expect(options.first()).toContainText(' · default');
  const agent = dock.locator(`[data-dock-provider-option="agent:${AGENT.id}"]`);
  await expect(agent.locator('.dock-picker-option-text')).toHaveText(`${AGENT.name} (coding agent)`);
  await expect(agent.locator('.dock-picker-option-billing')).toHaveText(`Billed to your ${AGENT.name} account`);
  await expect(agent).not.toHaveAttribute('aria-disabled', 'true');
  // The local server, not set up here, can't be picked.
  await expect(dock.locator('[data-dock-provider-option="openai_compatible"]')).toHaveAttribute('aria-disabled', 'true');
  await agent.click();
  await expect(dock.locator('.dock-picker-button')).toContainText(AGENT.name);
  // A coding agent takes the person's files (it imports them by id). Not started yet, its
  // catalogue entry says it takes pictures: Attach takes them too.
  const attach = dock.locator('[data-dock-attach]');
  await expect(attach).toBeEnabled();
  await expect(attach).toHaveAttribute('title', 'Attach pictures or files');
  await expect(dock.locator('[data-dock-file]')).toHaveAttribute('accept', ACCEPT_ALL);

  fake.script(
    { plan: [{ content: 'Add 2 to the counter', status: 'in_progress', priority: 'high' }] },
    { askOurs: { tool: `${PLUGIN}__add` } },
    { call: { tool: `${PLUGIN}__add`, args: { by: 2 } } },
    { say: 'Added 2.' },
  );
  await dockSend(page, 'Add 2 to the counter');
  const turn = dockTurn(page);
  await expect(turn.locator('[data-turn-end="done"]')).toBeVisible({ timeout: 60_000 });
  await expect(turn.locator('[data-dock-agent]')).toHaveText(new RegExp(`^${AGENT.name} ${AGENT.version.replace(/\./g, '\\.')} · its own tools are off$`));
  await expect(turn.locator('[data-dock-plan] h4')).toHaveText('Its plan');
  await expect(turn.locator('[data-dock-plan-entry]')).toHaveCount(1);
  await expect(turn.locator('[data-dock-step]').first().locator('.dock-step-title')).toHaveText('Add to the counter');
  await expect(turn.locator('[data-dock-line="agent_permission"]')).toHaveText(/^Auto-allowed: .+\. Magnusim asks you itself when one of its tools needs it\.$/);
  await expect(turn.locator('[data-turn-end="done"] > p').first()).toHaveText(new RegExp(`· billed to your ${AGENT.name} account$`));
  await expect(turn.locator('[data-dock-meter]')).toHaveText(`Billed to your ${AGENT.name} account (Magnusim can't see the cost)`);
  await expect(frame.locator('#counter')).toHaveText('2');
  await expect(dock.locator('[data-dock-provider-locked]')).toContainText(AGENT.name);
  // This agent's start said it takes no pictures: the dock says so for the next message.
  await expect(attach).toHaveAttribute('title', `Attach geometry files or drawings (${AGENT.name} doesn't take pictures)`, STEP);
  await expect(dock.locator('[data-dock-file]')).toHaveAttribute('accept', ACCEPT_FILES);
  await page.screenshot({ path: test.info().outputPath('agent-turn.png') });
  if (process.env.DOCK_SHOTS) await page.screenshot({ path: `${process.env.DOCK_SHOTS}/agent-turn-${page.viewportSize()?.width ?? 0}.png` });
});

test("a coding agent imports a file the person attached in the dock: Magnusim asks first, then the project has it (the agent's calls know the conversation)", async ({ page, request }) => {
  test.setTimeout(240_000);
  await resetAssistant(request, host.base);
  await useScriptedModel(request, host.base, llm, 'cloud');
  await postOk(request, '/api/assistant/settings', { privacy: 'allow' });
  const agents = await (await request.get(api('/api/assistant/agents?refresh=1'))).json();
  expect(agents.agents.find((a) => a.id === AGENT.id)).toMatchObject({ found: true, ready: true });
  await page.goto(api(`/#/p/${project}`));
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, project, { timeout: 60_000 });
  await openDock(page);
  const dock = page.locator('#assistant-dock');
  await dock.locator('.dock-picker-button').click();
  await dock.locator(`[data-dock-provider-option="agent:${AGENT.id}"]`).click();
  await expect(dock.locator('.dock-picker-button')).toContainText(AGENT.name);
  const { readFileSync } = await import('node:fs');
  const { dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const elbow = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'python', 'tests', 'fixtures', 'geometry', 'elbow.step'));
  await dock.locator('[data-dock-file]').setInputFiles([{ name: 'elbow.step', mimeType: 'application/octet-stream', buffer: elbow }]);
  await expect(dock.locator('[data-dock-file-chip]').first()).toHaveAttribute('data-dock-file-state', 'ready', STEP);
  const [att] = (await (await request.get(api('/api/test/assistant/state'))).json()).attachments;
  expect(att.id).toMatch(/^att-/);
  const before = ((await (await request.get(api(`/api/project?project_id=${project}`))).json()).project.geometries || []).length;
  fake.script(
    { askOurs: { tool: 'import_file' } },
    { call: { tool: 'import_file', args: { project_id: '', attachment_id: att.id, path: '', as: 'geometry', length_unit: '' } } },
    { say: 'Imported the elbow.' },
  );
  await dockSend(page, 'Import the elbow I attached');
  // An import runs a computation on this PC: Magnusim asks the person first, in the dock.
  const gate = dock.locator('[data-gate]').first();
  await expect(gate.locator('.dock-gate-title')).toHaveText('Allow the Assistant to import the attached file?', { timeout: 60_000 });
  await gate.locator('[data-gate-answer="yes"]').click();
  const turn = dockTurn(page);
  await expect(turn.locator('[data-turn-end="done"]')).toBeVisible({ timeout: 180_000 });
  // The call found the file of this conversation (not not_found): the step succeeded and the project has it.
  await expect(turn.locator('[data-dock-step]').first()).not.toHaveAttribute('data-dock-step-state', 'failed');
  const geoms = (await (await request.get(api(`/api/project?project_id=${project}`))).json()).project.geometries;
  expect(geoms.length).toBe(before + 1);
  expect(geoms.at(-1).original_filename).toBe('elbow.step');
});

/** A small PNG drawn in the page: its bytes as the browser encodes them. */
async function pngOf(page, w, h) {
  const b64 = await page.evaluate(
    async ([w, h]) => {
      const c = new OffscreenCanvas(w, h);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#3366cc';
      ctx.fillRect(0, 0, w, h);
      const bytes = new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer());
      let s = '';
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(s);
    },
    [w, h],
  );
  return Buffer.from(b64, 'base64');
}

/** The dock on Home with the coding agent picked (found by a fresh discovery). */
async function pickAgentAtHome(page, request) {
  const agents = await (await request.get(api('/api/assistant/agents?refresh=1'))).json();
  expect(agents.agents.find((a) => a.id === AGENT.id)).toMatchObject({ found: true, ready: true });
  await page.goto(api('/#/'));
  await openDock(page);
  const dock = page.locator('#assistant-dock');
  await dock.locator('.dock-picker-button').click();
  await dock.locator(`[data-dock-provider-option="agent:${AGENT.id}"]`).click();
  await expect(dock.locator('.dock-picker-button')).toContainText(AGENT.name);
  return dock;
}

const promptsSent = () => fake.received().filter((m) => m.method === 'session/prompt');

test("a coding agent that takes pictures gets the person's picture with the message, after its words; the transcript shows it", async ({ page, request }) => {
  test.setTimeout(180_000);
  await resetAssistant(request, host.base);
  await useScriptedModel(request, host.base, llm, 'cloud');
  // Its initialize says it takes pictures (promptCapabilities.image).
  fake.configure({ images: true });
  try {
    const dock = await pickAgentAtHome(page, request);
    const attach = dock.locator('[data-dock-attach]');
    await expect(attach).toHaveAttribute('title', 'Attach pictures or files');
    await expect(dock.locator('[data-dock-file]')).toHaveAttribute('accept', ACCEPT_ALL);
    const png = await pngOf(page, 64, 48);
    await dock.locator('[data-dock-file]').setInputFiles([{ name: 'part.png', mimeType: 'image/png', buffer: png }]);
    await expect(dock.locator('[data-dock-picture-chip]')).toHaveCount(1, STEP);
    await expect(dock.locator('[data-dock-picture-chip]')).toContainText('part.png · 64 × 48');
    await expect(dock.locator('[data-dock-pictures-note]')).toHaveText(`Pictures go to ${AGENT.name} with your message, and on to its own service.`);
    await expect(dock.locator('[data-dock-picture-error]')).toHaveCount(0);
    fake.script({ say: 'A blue rectangle.' });
    const id = await dockSend(page, 'What is in the picture?');
    const turn = dockTurn(page);
    await expect(turn.locator('[data-turn-end="done"]')).toBeVisible({ timeout: 60_000 });
    // The agent got it as an image block, after the message's words.
    const blocks = promptsSent().at(-1).params.prompt;
    const at = blocks.findIndex((b) => b.type === 'text' && b.text === 'What is in the picture?');
    expect(at, JSON.stringify(blocks.map((b) => b.type))).toBeGreaterThanOrEqual(0);
    expect(blocks[at + 1]).toEqual({ type: 'image', mimeType: 'image/png', data: png.toString('base64') });
    expect(blocks.filter((b) => b.type === 'image')).toHaveLength(1);
    // The transcript shows the person's picture with the message, as for a cloud model.
    const shown = turn.locator('.dock-you img');
    await expect(shown).toHaveCount(1);
    await expect.poll(() => shown.evaluate((img) => img.naturalWidth), STEP).toBe(64);
    const summary = (await (await request.get(api(`/api/assistant/turns/${id}`))).json()).turn;
    expect(summary.prompt_images.map((p) => p.n)).toEqual(['p1']);
    await expect(dock.locator('[data-dock-picture-chip]')).toHaveCount(0);
    // Its start said it takes them: so for the next message too.
    await expect(attach).toHaveAttribute('title', 'Attach pictures or files');
    await page.screenshot({ path: test.info().outputPath('agent-pictures.png') });
  } finally {
    fake.configure({ images: false });
  }
});

test("a coding agent whose start says it takes no pictures: a request with one ends with the words why, nothing sent to it; then the dock takes files only", async ({ page, request }) => {
  test.setTimeout(180_000);
  await resetAssistant(request, host.base);
  await useScriptedModel(request, host.base, llm, 'cloud');
  const dock = await pickAgentAtHome(page, request);
  const attach = dock.locator('[data-dock-attach]');
  // Not started yet: its catalogue entry says it takes pictures, so the dock lets one on.
  await expect(attach).toHaveAttribute('title', 'Attach pictures or files');
  const png = await pngOf(page, 32, 32);
  await dock.locator('[data-dock-file]').setInputFiles([{ name: 'part.png', mimeType: 'image/png', buffer: png }]);
  await expect(dock.locator('[data-dock-picture-chip]')).toHaveCount(1, STEP);
  const before = promptsSent().length;
  const id = await dockSend(page, 'What is in the picture?');
  const turn = dockTurn(page);
  const end = turn.locator('[data-turn-end="failed"]');
  await expect(end).toBeVisible({ timeout: 60_000 });
  await expect(end).toContainText(AGENT_IMAGES_TEXT);
  const summary = (await (await request.get(api(`/api/assistant/turns/${id}`))).json()).turn;
  expect([summary.state, summary.end_reason, summary.message]).toEqual(['failed', 'bad_images', expect.stringMatching(AGENT_IMAGES_TEXT)]);
  expect(promptsSent().length, 'nothing of the request went to the agent').toBe(before);
  // The person's message still shows with its picture.
  await expect(turn.locator('.dock-you img')).toHaveCount(1);
  // The dock now says it takes none: Attach for files only, and a picture is refused with the words why.
  await expect(attach).toHaveAttribute('title', `Attach geometry files or drawings (${AGENT.name} doesn't take pictures)`, STEP);
  await expect(dock.locator('[data-dock-file]')).toHaveAttribute('accept', ACCEPT_FILES);
  await dock.locator('[data-dock-file]').setInputFiles([{ name: 'again.png', mimeType: 'image/png', buffer: png }]);
  await expect(dock.locator('[data-dock-picture-error]')).toHaveText(`${AGENT.name} doesn't take pictures. Send the message without them.`);
  await expect(dock.locator('[data-dock-picture-chip]')).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('agent-no-pictures.png') });
});
