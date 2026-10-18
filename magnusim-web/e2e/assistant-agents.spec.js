// Coding agents in Settings → Assistant (phase 3 spec 7.6, tests 1–3): agent discovery's test
// switches point at a temp search folder holding the scripted coding agent (e2e/support/
// fake-acp-agent.mjs) installed as npm installs the known agents (a .cmd shim beside
// node_modules/<package> on Windows; <prefix>/bin links into lib/node_modules elsewhere), and
// at a temp home for their login files. Its own server with the Assistant's test switches (a
// test home, never this PC's settings, agents or keys; the cloud providers go to a fake).
//
// Covered: the rows (Claude Code found through its own package at its checked version, so its
// own tools are off, and signed out until its login file exists, then ready after Refresh;
// Codex found and signed in, but its own tools stay on, so it is off until allowed; the others
// missing, with their install line and Copy); the Default choice offering the agents found
// beside a saved API key (D-A); a custom agent added with a variable to pass, its allow switch
// (the question with Don't focused, Enter answering Don't, Allow, off with no question), the
// allow routes refused without the page's Origin, the switch asked again once the program's
// path changed, and Remove. No agent is ever started for a message here (the Test and agent
// turns are the next commit's): the fake's controller records none.
// SPDX-License-Identifier: GPL-3.0-or-later
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { startFakeAcp } from './support/fake-acp.mjs';
import { startFakeLlm } from './support/fake-llm.mjs';
import { removeTreeSync } from '../scripts/remove-tree.js';
import { e2eTemp, startHost } from './support/host-server.mjs';
import { assistantPane, assistantStatus, openAssistantStep, openCard, resetAssistant, saveKey } from './support/assistant.js';
import { expect, test } from './support/stress.js';

const WIN = process.platform === 'win32';
const CLAUDE = { id: 'claude', name: 'Claude Code', pkg: '@agentclientprotocol/claude-agent-acp', program: 'claude-agent-acp', version: '0.85.1' };
const CODEX = { id: 'codex', name: 'Codex', pkg: '@agentclientprotocol/codex-acp', program: 'codex-acp', version: '2.1.1' };
const CUSTOM_NAME = 'E2E agent';
const CUSTOM_PROGRAM = 'e2e-agent';

const OWN_TOOLS_OFF = 'Its own shell, file and web tools are off while it works for Magnusim.';
const OWN_TOOLS_ON = 'Its own tools stay on: it can run commands and change files on this PC by its own rules.';
const LOGIN_YES = 'Signed in (its login file is on this PC).';
const LOGIN_UNKNOWN = "Magnusim can't tell whether it is signed in; Test will say.";
const allowWarning = (name) =>
  `${name}'s own tools can't be switched off from Magnusim. Once allowed, it can run commands and change files on this PC by its own rules, as it does in a terminal. It can also read your Magnusim projects, whatever the privacy setting says. Magnusim's questions cover only Magnusim's tools. Anyone else signed in to this PC can reach Magnusim's settings too; allow agents only on a PC whose other accounts you trust.`;

let host;
let fake;
let llm;
/** The search folders: `first` (empty until a test puts a program there) before `prefix`'s. */
let first;
let searchDir;
let home;

const api = (path) => `${host.base}${path}`;
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

/**
 * A known agent installed as npm installs it globally, its bin the fake's launcher (which
 * answers --version without a controller). Windows: <prefix>/<program>.cmd beside
 * <prefix>/node_modules/<pkg>; elsewhere <prefix>/bin/<program> -> ../lib/node_modules/<pkg>/<bin>.
 */
function installKnown(prefix, a) {
  const modules = WIN ? join(prefix, 'node_modules') : join(prefix, 'lib', 'node_modules');
  const pkgDir = join(modules, ...a.pkg.split('/'));
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: a.pkg, version: a.version, bin: { [a.program]: 'dist/index.js' } }));
  const script = fake.writeLauncher(join(pkgDir, 'dist', 'index.js'), { version: a.version });
  if (WIN) {
    writeFileSync(join(prefix, `${a.program}.cmd`), cmdShim(winRel('node_modules', a.pkg, 'dist/index.js')));
  } else {
    chmodSync(script, 0o755);
    mkdirSync(join(prefix, 'bin'), { recursive: true });
    symlinkSync(join('..', 'lib', 'node_modules', ...a.pkg.split('/'), 'dist', 'index.js'), join(prefix, 'bin', a.program));
  }
}

/** A program of no package, found by its name in `dir`: a cmd shim to a node script (Windows), else a node script itself. */
function installProgram(dir, name) {
  mkdirSync(dir, { recursive: true });
  if (WIN) {
    fake.writeLauncher(join(dir, 'node_modules', name, 'agent.js'));
    writeFileSync(join(dir, `${name}.cmd`), cmdShim(winRel('node_modules', name, 'agent.js')));
  } else {
    chmodSync(fake.writeLauncher(join(dir, name)), 0o755);
  }
}

/** The test home's Assistant settings file (the custom agents and the allow records live there). */
function settingsFile() {
  const candidates = [join(host.tmp, 'assistant', 'assistant', 'settings.json'), join(host.tmp, 'assistant', 'settings.json')];
  const file = candidates.find((f) => existsSync(f));
  expect(file, 'the settings file').toBeTruthy();
  return JSON.parse(readFileSync(file, 'utf8'));
}

async function agentsNow(request) {
  const r = await request.get(api('/api/assistant/agents'));
  expect(r.status()).toBe(200);
  return (await r.json()).agents;
}

const rowOf = (page, id) => assistantPane(page).locator(`[data-assistant-agent="${id}"]`);
const customRow = (page) => assistantPane(page).locator('[data-assistant-agent-kind="custom"]');
const modal = (page) => page.locator('#modal-confirm');

/** Records what Copy put on the clipboard (the page's own clipboard, not this PC's). */
async function recordClipboard(page) {
  await page.addInitScript(() => {
    window.__copied = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text) => {
          window.__copied.push(String(text));
        },
      },
    });
  });
}

test.beforeAll(async () => {
  test.setTimeout(240_000);
  fake = await startFakeAcp({ style: 'tool_name_meta' });
  llm = await startFakeLlm();
  const tmp = e2eTemp('assistant-agents');
  const prefix = join(tmp, 'npm');
  first = join(tmp, 'first');
  home = join(tmp, 'home');
  mkdirSync(first, { recursive: true });
  mkdirSync(prefix, { recursive: true });
  installKnown(prefix, CLAUDE);
  installKnown(prefix, CODEX);
  searchDir = WIN ? prefix : join(prefix, 'bin');
  installProgram(searchDir, CUSTOM_PROGRAM);
  // Codex is signed in (its login file); Claude Code isn't yet.
  mkdirSync(join(home, '.codex'), { recursive: true });
  writeFileSync(join(home, '.codex', 'auth.json'), '{}');
  host = await startHost({
    name: 'assistant-agents',
    tmp,
    env: {
      MAGNUSIM_TEST_ASSISTANT: '1',
      MAGNUSIM_TEST_ASSISTANT_PROVIDER_URL: llm.base,
      MAGNUSIM_TEST_ASSISTANT_AGENT_PATHS: [first, searchDir].join(delimiter),
      MAGNUSIM_TEST_ASSISTANT_AGENT_HOME: home,
    },
  });
  // The switches hold (else discovery would look at this PC's own agents): stop here.
  const status = await (await fetch(api('/api/assistant/status'))).json();
  expect(status.test_provider, 'the cloud providers go to the fake').toBe(true);
});

test.beforeEach(async ({ request }) => {
  // Each test from the start: no settings, keys, custom agents or switches; Claude Code not
  // signed in; the custom program only where the npm prefix is.
  await resetAssistant(request, host.base);
  removeTreeSync(join(home, '.claude'));
  removeTreeSync(first);
  mkdirSync(first, { recursive: true });
});

test.afterAll(async () => {
  if (host) host.stop();
  if (llm) await llm.stop();
  if (fake) {
    // Nothing here starts an agent for a message or a connect: the controller heard from none.
    expect(fake.pids(), 'no agent process reported to the controller').toEqual([]);
    expect(fake.records(), 'no agent talked to the controller').toEqual([]);
    await fake.stop();
  }
});

test('rows: each known agent found or missing, with its sign-in state; Claude Code (its own tools off) is ready once its login file exists; Copy puts the install line on the clipboard', async ({ page, request }) => {
  test.setTimeout(120_000);
  await recordClipboard(page);
  await page.goto(`${host.base}/#/`);
  const pane = await openAssistantStep(page);
  const block = pane.locator('[data-assistant-agents]');
  await expect(block.locator('[data-assistant-agent]')).toHaveCount(5, { timeout: 30_000 });
  expect(await block.locator('[data-assistant-agent]').evaluateAll((els) => els.map((el) => el.getAttribute('data-assistant-agent')))).toEqual([
    'claude',
    'codex',
    'opencode',
    'grok',
    'gemini',
  ]);

  // Claude Code: found through its own package at its checked version: its own tools are off; no login file yet.
  const claude = rowOf(page, 'claude');
  await expect(claude).toHaveAttribute('data-assistant-agent-state', 'signed_out');
  await expect(claude.locator('[data-assistant-agent-line]')).toHaveText(`Claude Code 0.85.1 · Not signed in. · ${OWN_TOOLS_OFF}`);
  await expect(claude.locator('[data-assistant-agent-program]')).toContainText(CLAUDE.program);
  await expect(claude.locator('[data-assistant-agent-allow]')).toHaveCount(0);
  const signIn = claude.getByRole('group', { name: 'Sign in to Claude Code' });
  await expect(signIn).toBeVisible();
  await expect(signIn.locator('[data-assistant-agent-signin-footer]')).toHaveText("Magnusim has no field for Claude Code's key on purpose: the agent keeps its own login.");
  await expect(signIn.getByRole('button', { name: "I've signed in: connect again" })).toBeVisible();

  // Codex: found and signed in, but its own tools stay on: off until allowed, the warning beside its switch.
  const codex = rowOf(page, 'codex');
  await expect(codex).toHaveAttribute('data-assistant-agent-state', 'needs_allow');
  await expect(codex.locator('[data-assistant-agent-line]')).toHaveText(`Codex 2.1.1 · ${LOGIN_YES}`);
  await expect(codex.getByRole('switch', { name: 'Allow this agent' })).not.toBeChecked();
  await expect(codex.getByRole('note')).toHaveText(allowWarning('Codex'));

  // The others aren't installed: their install line, Copy for a command.
  const opencode = rowOf(page, 'opencode');
  await expect(opencode).toHaveAttribute('data-assistant-agent-state', 'missing');
  await expect(opencode.locator('[data-assistant-agent-line]')).toHaveText('OpenCode · not installed.');
  await expect(opencode.locator('code[data-assistant-agent-install]')).toHaveText('npm install -g opencode-ai');
  await opencode.locator('[data-assistant-agent-install-copy]').click();
  await expect(opencode.locator('[data-assistant-agent-install-copied]')).toHaveText('Copied.');
  expect(await page.evaluate(() => window.__copied)).toEqual(['npm install -g opencode-ai']);
  await expect(rowOf(page, 'gemini')).toHaveAttribute('data-assistant-agent-state', 'missing');
  await expect(rowOf(page, 'gemini').locator('code[data-assistant-agent-install]')).toHaveText('npm install -g @google/gemini-cli');
  await expect(rowOf(page, 'grok').locator('[data-assistant-agent-install]')).toHaveText('Install Grok Build (docs.x.ai/build), then run grok login');
  await expect(rowOf(page, 'grok').locator('[data-assistant-agent-install-copy]')).toHaveCount(0);

  // The Default choice offers the agents found, and only those.
  const defaults = pane.getByRole('radiogroup', { name: 'Default provider' });
  await expect(defaults.locator('[data-assistant-default-option]')).toHaveCount(6);
  await expect(defaults.locator('[data-assistant-default-option="agent:claude"]')).toContainText('Claude Code (coding agent)');
  await expect(defaults.locator('[data-assistant-default-option="agent:claude"] [data-assistant-default-state]')).toHaveText('Not signed in');
  await expect(defaults.locator('[data-assistant-default-option="agent:codex"] [data-assistant-default-state]')).toHaveText('Off until you allow it');
  for (const id of ['opencode', 'grok', 'gemini']) await expect(defaults.locator(`[data-assistant-default-option="agent:${id}"]`)).toHaveCount(0);

  // Signed in (its login file now exists, never opened): Refresh shows it ready.
  signInClaude();
  await block.locator('[data-assistant-agents-refresh]').click();
  await expect(claude).toHaveAttribute('data-assistant-agent-state', 'ready');
  await expect(claude.locator('[data-assistant-agent-line]')).toHaveText(`Claude Code 0.85.1 · ${LOGIN_YES} · ${OWN_TOOLS_OFF}`);
  await expect(claude.getByRole('button', { name: 'Test' })).toBeVisible();
  await expect(claude.locator('[data-assistant-agent-billing]')).toHaveText(
    "Billed to your Claude Code account; Magnusim's $ limits don't apply to it. The limits under Coding agents do.",
  );
  await expect(claude.locator('[data-assistant-agent-signin]')).toHaveCount(0);
  await expect(defaults.locator('[data-assistant-default-option="agent:claude"] [data-assistant-dot]')).toHaveAttribute('data-assistant-dot', 'ready');
  const rows = await agentsNow(request);
  expect(rows.find((r) => r.id === 'claude')).toMatchObject({ found: true, verified_package: true, lockdown: 'tools_off', signed_in: 'yes', ready: true });
});

/** Claude Code signed in: its login file exists (discovery only checks that it does). */
function signInClaude() {
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude', '.credentials.json'), '{}');
}

test('Default and keys side by side (D-A): an API key saved and the agents found are both offered and both ready; the agent limits show', async ({ page, request }) => {
  test.setTimeout(120_000);
  signInClaude();
  await page.goto(`${host.base}/#/`);
  const pane = await openAssistantStep(page);
  await expect(rowOf(page, 'claude')).toHaveAttribute('data-assistant-agent-state', 'ready', { timeout: 30_000 });
  await openCard(page, 'anthropic');
  const key = `sk-ant-e2e-agents-${Date.now().toString(16)}a1b2`;
  await saveKey(page, key, 'anthropic');
  const status = await assistantStatus(request, host.base);
  expect(status.providers_ready.anthropic).toMatchObject({ kind: 'key', ready: true });
  expect(status.providers_ready['agent:claude']).toMatchObject({ kind: 'agent', ready: true, billing: 'agent_account' });
  const defaults = pane.getByRole('radiogroup', { name: 'Default provider' });
  await expect(defaults.locator('[data-assistant-default-option="anthropic"] [data-assistant-default-state]')).toHaveAttribute('data-assistant-default-state', 'ready');
  await expect(defaults.locator('[data-assistant-default-option="agent:claude"] [data-assistant-default-billing]')).toHaveText(
    "Billed to your Claude Code account; Magnusim's $ limits don't apply to it.",
  );
  await expect(pane.locator('[data-assistant-spent]')).toHaveText('Spent today (API keys): $0.00 of $15.00');
  const agentLimits = pane.getByRole('group', { name: 'Coding agents limits' });
  if (status.agent_caps) {
    await expect(agentLimits.getByLabel('Changes per message')).toHaveValue(String(status.agent_caps.changes));
  } else {
    // A server whose status doesn't carry the agent limits yet shows none.
    await expect(agentLimits).toHaveCount(0);
  }
});

test('Default and keys side by side (D-A): the agent as the default keeps every key; back again, nothing is lost', async ({ page, request }) => {
  test.setTimeout(120_000);
  const probe = await request.post(api('/api/assistant/settings'), { data: { provider: 'agent:claude' } });
  const refusal = probe.ok() ? null : await probe.json();
  test.skip(
    probe.status() === 400 && refusal?.field === 'provider' && refusal?.error === 'Unknown provider.',
    'This server does not take a coding agent as the default yet (it comes with agent turns).',
  );
  expect(probe.status(), JSON.stringify(refusal)).toBe(200);
  await request.post(api('/api/assistant/settings'), { data: { provider: 'anthropic' } });
  signInClaude();
  await page.goto(`${host.base}/#/`);
  let pane = await openAssistantStep(page);
  await expect(rowOf(page, 'claude')).toHaveAttribute('data-assistant-agent-state', 'ready', { timeout: 30_000 });
  await openCard(page, 'anthropic');
  await saveKey(page, `sk-ant-e2e-default-${Date.now().toString(16)}c3d4`, 'anthropic');
  await pane.locator('[data-assistant-default-option="agent:claude"] input').check();
  await expect(pane.locator('[data-assistant-default]')).toHaveAttribute('data-assistant-default', 'agent:claude');
  await expect(rowOf(page, 'claude').locator('[data-assistant-agent-default]')).toHaveText('Default');
  await page.reload();
  pane = await openAssistantStep(page);
  await expect(pane.locator('[data-assistant-default]')).toHaveAttribute('data-assistant-default', 'agent:claude');
  const card = await openCard(page, 'anthropic');
  await expect(card.locator('[data-assistant-key-status]')).toHaveText(/^Key set, ends in …/);
  expect((await assistantStatus(request, host.base)).providers_ready.anthropic.ready).toBe(true);
  await pane.locator('[data-assistant-default-option="anthropic"] input').check();
  await expect(pane.locator('[data-assistant-default]')).toHaveAttribute('data-assistant-default', 'anthropic');
  await expect(card.locator('[data-assistant-key-status]')).toHaveText(/^Key set, ends in …/);
  expect((await assistantStatus(request, host.base)).providers_ready['agent:claude'].ready).toBe(true);
});

test("a custom agent: added with a variable to pass, off until allowed; the allow switch asks first (Don't focused, Enter answers Don't), Allow, off with no question; asked again once its program's path changed; Remove", async ({ page, request }) => {
  test.setTimeout(180_000);
  const allowPosts = [];
  page.on('request', (r) => {
    if (new URL(r.url()).pathname === '/api/assistant/agents/allow' && r.method() === 'POST') allowPosts.push(r.postDataJSON());
  });
  await page.goto(`${host.base}/#/`);
  const pane = await openAssistantStep(page);
  const block = pane.locator('[data-assistant-agents]');
  await expect(rowOf(page, 'claude')).toBeVisible({ timeout: 30_000 });

  // Add a custom agent…: the name, the command and one variable to pass.
  const open = block.locator('[data-assistant-agent-add-open]');
  await open.click();
  const form = block.locator('[data-assistant-agent-custom-form]');
  await expect(form.getByLabel('Name', { exact: true })).toBeFocused();
  await form.getByLabel('Name', { exact: true }).fill(CUSTOM_NAME);
  await form.getByLabel('Command', { exact: true }).fill(`${CUSTOM_PROGRAM} --acp`);
  await form.getByRole('button', { name: 'Add a variable' }).click();
  await expect(form.getByLabel('Variable 1', { exact: true })).toBeFocused();
  await page.keyboard.type('E2E_AGENT_TOKEN');
  await form.getByRole('button', { name: 'Add', exact: true }).click();
  const row = customRow(page);
  await expect(row).toHaveCount(1);
  await expect(form).toHaveCount(0);
  await expect(row).toHaveAttribute('data-assistant-agent-state', 'needs_allow');
  await expect(row).toBeFocused();
  await expect(row.locator('[data-assistant-agent-line]')).toHaveText(`${CUSTOM_NAME} · ${LOGIN_UNKNOWN}`);
  await expect(row.getByRole('note')).toHaveText(allowWarning(CUSTOM_NAME));
  const id = await row.getAttribute('data-assistant-agent');
  expect(id).toMatch(/^custom-[0-9a-f]{6}$/);
  expect(settingsFile().custom_agents).toEqual([{ id, name: CUSTOM_NAME, argv: [CUSTOM_PROGRAM, '--acp'], keep_env: ['E2E_AGENT_TOKEN'] }]);

  // Only this window may add or allow one: without the page's Origin, both are refused.
  const listed = (await agentsNow(request)).find((r) => r.id === id);
  expect(listed).toMatchObject({ kind: 'custom', needs_allow: true, allowed: false, ready: false, reason: 'agent_not_allowed' });
  const noOrigin = await request.post(api('/api/assistant/agents/allow'), { data: { id, allow: true, fingerprint: listed.fingerprint } });
  expect(noOrigin.status()).toBe(403);
  expect(await noOrigin.json()).toMatchObject({ code: 'browser_only' });
  const addNoOrigin = await request.post(api('/api/assistant/agents/custom'), { data: { name: 'Sneaky', command: CUSTOM_PROGRAM } });
  expect(addNoOrigin.status()).toBe(403);
  expect(await addNoOrigin.json()).toMatchObject({ code: 'browser_only' });

  // The switch: the question first, Don't focused; Enter answers Don't and nothing is sent.
  const sw = row.getByRole('switch', { name: 'Allow this agent' });
  const toggle = row.locator('label.wiz-assistant-switch');
  await expect(sw).not.toBeChecked();
  await toggle.click();
  await expect(modal(page)).toBeVisible();
  await expect(page.locator('#cf-heading')).toHaveText(`Allow ${CUSTOM_NAME} to work for the Assistant?`);
  await expect(page.locator('#cf-copy')).toHaveText(
    `${CUSTOM_NAME} can run commands, read your projects and change files on this PC by its own rules, and Magnusim can't stop that. Allow it only if you trust it as you do in a terminal.`,
  );
  await expect(page.locator('#cf-cancel')).toHaveText("Don't");
  await expect(page.locator('#cf-cancel')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(modal(page)).toBeHidden();
  await expect(sw).not.toBeChecked();
  await expect(sw).toBeFocused();
  expect(allowPosts).toEqual([]);
  expect((await agentsNow(request)).find((r) => r.id === id).allowed).toBe(false);

  // Allow (a click): on, ready, its own tools stay on.
  await toggle.click();
  await expect(modal(page)).toBeVisible();
  await page.locator('#cf-confirm').click();
  await expect(modal(page)).toBeHidden();
  await expect(sw).toBeChecked();
  await expect(row).toHaveAttribute('data-assistant-agent-state', 'ready');
  await expect(row.locator('[data-assistant-agent-line]')).toHaveText(`${CUSTOM_NAME} · ${LOGIN_UNKNOWN} · ${OWN_TOOLS_ON}`);
  await expect(row.getByRole('note')).toHaveText(allowWarning(CUSTOM_NAME));
  expect(allowPosts).toEqual([{ id, allow: true, fingerprint: listed.fingerprint }]);
  expect((await agentsNow(request)).find((r) => r.id === id)).toMatchObject({ allowed: true, ready: true });
  await expect(pane.locator(`[data-assistant-default-option="agent:${id}"]`)).toContainText(`${CUSTOM_NAME} (coding agent)`);

  // Off: at once, no question.
  await toggle.click();
  await expect(sw).not.toBeChecked();
  await expect(row).toHaveAttribute('data-assistant-agent-state', 'needs_allow');
  await expect(modal(page)).toBeHidden();
  expect(allowPosts).toEqual([
    { id, allow: true, fingerprint: listed.fingerprint },
    { id, allow: false },
  ]);

  // Allowed again, then its program found elsewhere (an earlier search folder): asked again.
  await toggle.click();
  await page.locator('#cf-confirm').click();
  await expect(sw).toBeChecked();
  installProgram(first, CUSTOM_PROGRAM);
  await block.locator('[data-assistant-agents-refresh]').click();
  await expect(row).toHaveAttribute('data-assistant-agent-state', 'allow_changed');
  await expect(row.locator('[data-assistant-agent-allow-changed]')).toHaveText(`${CUSTOM_NAME}'s command or program changed since you allowed it. Allow it again to use it.`);
  await expect(sw).not.toBeChecked();
  await expect(row.locator('[data-assistant-agent-program]')).toContainText(first);
  const changed = (await agentsNow(request)).find((r) => r.id === id);
  expect(changed).toMatchObject({ allowed: false, allow_changed: true, ready: false, reason: 'agent_allow_changed' });
  expect(changed.fingerprint).not.toBe(listed.fingerprint);

  // Remove: asked first; gone, and the focus is on Add a custom agent….
  await row.getByRole('button', { name: 'Remove' }).click();
  await expect(page.locator('#cf-heading')).toHaveText(`Remove ${CUSTOM_NAME}?`);
  await page.locator('#cf-confirm').click();
  await expect(customRow(page)).toHaveCount(0);
  await expect(open).toBeFocused();
  expect((await agentsNow(request)).some((r) => r.id === id)).toBe(false);
  expect(settingsFile().custom_agents).toEqual([]);
  await expect(pane.locator(`[data-assistant-default-option="agent:${id}"]`)).toHaveCount(0);
});
