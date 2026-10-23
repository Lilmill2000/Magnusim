// The chat dock with a coding agent (phase 4 spec 2.3, 2.7, 2.9, 11.3-8): the provider picker
// lists the agent found beside the API-key providers ("<name> (coding agent)", its detail and
// who pays), a pick of it sends the request to the agent, and the dock shows its line, its plan,
// the workspace tool it called and its counters, billed to its own account; Attach takes its files, no pictures; the picker is
// locked after the first message. The agent is the scripted coding agent
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

test("the picker offers the coding agent beside the API keys; a request on it shows its line, plan, Magnusim's tool, counters and who pays; Attach takes files, no pictures; locked after", async ({ page, request }) => {
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
  // A coding agent takes the person's files (it imports them by id) but no pictures.
  const attach = dock.locator('[data-dock-attach]');
  await expect(attach).toBeEnabled();
  await expect(attach).toHaveAttribute('title', `Attach geometry files (${AGENT.name} doesn't take pictures)`);
  await expect(dock.locator('[data-dock-file]')).toHaveAttribute('accept', '.step,.stp,.iges,.igs,.brep,.brp,.stl,.obj,.ply');

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
  await page.screenshot({ path: test.info().outputPath('agent-turn.png') });
  if (process.env.DOCK_SHOTS) await page.screenshot({ path: `${process.env.DOCK_SHOTS}/agent-turn-${page.viewportSize()?.width ?? 0}.png` });
});
