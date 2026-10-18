// Coding agents, end to end (phase 3 spec 7.6, tests 1-10): Settings → Assistant → Coding agents,
// and turns on a coding agent in the open workspace. Agent discovery's test switches point at a
// temp search folder holding the scripted coding agent (e2e/support/fake-acp-agent.mjs)
// installed as npm installs the known agents (a .cmd shim beside node_modules/<package> on
// Windows; <prefix>/bin links into lib/node_modules elsewhere), and at a temp home for their
// login files. Each agent has a controller of its own (Claude Code's marks Magnusim's tools as
// its adapter does, Codex's flags them, the custom agent's marks nothing). The turns work in the
// test plugin ai-demo's counter workspace (python/tests/fixtures/assistant-plugins), through
// Magnusim's real bridge and MCP listener and the page relay. Its own server with the
// Assistant's test switches (a test home, never this PC's settings, agents or keys; the cloud
// providers go to a fake; the hold is 2 s; Stop's wait for the agent is its real 3 s).
//
// Covered, Settings: the rows (Claude Code found through its own package at its checked
// version, so its own tools are off, and signed out until its login file exists, then ready
// after Refresh; Codex found and signed in, but its own tools stay on, so it is off until
// allowed; the others missing, with their install line and Copy; each row says which modes
// Magnusim uses with it); signing in (connect again hears the agent ask for it: the Sign in
// block shows the terminal command the agent sent, as its program's name, and Copy puts it on
// the clipboard; signed in, connect again connects; the Test calls Magnusim's test tool; the
// Model it listed saved, and no Mode select when Magnusim uses one mode); the Default choice
// offering the agents found beside a saved API key (D-A), a coding agent as the default keeping
// every key, and the coding agents' limits shown and saved; a custom agent added with a
// variable to pass, a turn on it refused without the launch proof and while it is off (nothing
// started), its allow switch (the question with Don't focused, Enter answering Don't, Allow,
// then a turn runs; off with no question, which ends what it ran), the allow routes refused
// without the page's Origin, the switch asked again once the program's path changed (a turn
// then refused), Turn off and Remove.
//
// Covered, turns: Claude Code (its own tools off) works in the open workspace through
// Magnusim's tools, its permission request for them auto-allowed and logged, nothing asked, no
// $ counted, and it got no file system, terminal or token; a destructive tool asks in the app
// with Don't focused (Enter answers it; Allow in the same conversation, the agent kept); a
// custom agent's own tool is a question only the window answers (the answer key is refused);
// privacy Ask for agent:claude asks before any agent starts, Don't send sends nothing, Send is
// remembered; Stop on a stubborn agent (it ignores the cancel) aborts the call, and 3 s later
// its whole tree (helpers, bridge) is killed; Stop while its own question is open answers the
// permission cancelled before session/cancel, and a polite agent is kept; a crash mid-tool
// fails the turn with its last words and the next message starts it again with a note; a
// hidden tab keeps its link past the page's grace while an agent's call runs; Codex (its own
// tools on) is refused until allowed, then its flagged calls count as Magnusim's and it runs
// read-only; the terminal client (--agent, --tab auto) on the browser tab with the launch
// token, and its refusal of an agent that is off; API-key turns beside agent turns (D-A), each
// conversation bound to its provider, the agent billed to its own account and the API key's
// spend counted. Every launcher start (discovery's --version probes, and each agent started)
// writes its pid; after each test (a reset ends every agent) and at the end, every one, and
// every process an agent reported to its controller (itself, its MCP bridge, its helpers), has
// ended (by its command line, as the OS reuses pids).
// SPDX-License-Identifier: GPL-3.0-or-later
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startFakeAcp } from './support/fake-acp.mjs';
import { startFakeLlm } from './support/fake-llm.mjs';
import { removeTreeSync } from '../scripts/remove-tree.js';
import { e2eTemp, startHost, WEB_ROOT } from './support/host-server.mjs';
import { serverStream, setHidden } from './support/link-streams.js';
import { infoPathOf } from './support/mcp-client.mjs';
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
/** One scripted agent's controller per agent, so each keeps its own style: Claude Code's, Codex's and the custom agent's. */
let fake;
let codexFake;
let customFake;
let llm;
/** The ai-demo counter study the turns work in. */
let project;
let study;
/** The search folders: `first` (empty until a test puts a program there) before `prefix`'s. */
let first;
let searchDir;
let home;
/** Where every launcher start writes its pid, and the fake's own launchers (outside the search folders). */
let pidsFile;
let launchers;
let launcherCount = 0;
/** What each scripted agent is when it starts (each test starts from these). */
const BASE_FAKE = Object.freeze({ requireSignIn: false, authMethods: [], stubborn: false });
/** Claude Code's adapter marks Magnusim's tools with their name in _meta; the Test's line names its version. */
const CLAUDE_FAKE = Object.freeze({ ...BASE_FAKE, style: 'tool_name_meta', agentInfo: { name: 'claude-agent-acp', title: 'Claude Code', version: CLAUDE.version } });
/** Codex's adapter flags its MCP calls and approvals; it lists the read-only mode Magnusim starts it in. */
const CODEX_FAKE = Object.freeze({
  ...BASE_FAKE,
  style: 'mcp_call_flag',
  agentInfo: { name: 'codex-acp', title: 'Codex', version: CODEX.version },
  modes: {
    currentModeId: 'agent',
    availableModes: [
      { id: 'read-only', name: 'Read Only' },
      { id: 'agent', name: 'Agent' },
    ],
  },
  configOptions: null,
});
/** A custom command marks nothing: every permission request is the person's question. */
const CUSTOM_FAKE = Object.freeze({ ...BASE_FAKE, style: 'none', agentInfo: { name: 'e2e-agent', title: 'E2E agent', version: '1.0.0' } });

const PLUGIN = 'ai-demo';
const TOOLS = ['add', 'get_count', 'mystery', 'read_study', 'reset', 'slow_add', 'snap'].map((n) => `${PLUGIN}__${n}`);
const PROJECT_TITLE = 'Counter project';
const KEY = 'sk-ant-e2e-agents-turns-0123456789abcdef';
/** The page's own grace before a hidden tab lets its stream go (src/api/eventHub.ts HIDDEN_GRACE_MS). */
const HIDDEN_GRACE_MS = 3000;
/** Stop's wait for the agent's answer before the tree kill (spec 4.11; not shortened here). */
const AGENT_CANCEL_MS = 3000;
const LAUNCH_PROOF_TEXT = 'Start a coding agent from the Magnusim window or with assistant-run on this account.';
const notAllowedText = (name) => `${name} is off until you allow it in Settings → Assistant: its own tools can run commands and change files on this PC.`;

const api = (path) => `${host.base}${path}`;

/**
 * The fake's launcher behind a first script at `file` that writes its pid to `pidsFile`, at
 * every start: discovery's --version probes too, which never reach the fake's controller.
 */
function writeLauncher(file, ctrl, opts) {
  const inner = ctrl.writeLauncher(join(launchers, `${(launcherCount += 1)}.mjs`), opts);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    [
      '#!/usr/bin/env node',
      "// Writes this start's pid, then runs the scripted agent (written by assistant-agents.spec.js).",
      "import('node:fs')",
      '  .then((fs) => {',
      `    fs.appendFileSync(${JSON.stringify(pidsFile)}, process.pid + '\\n');`,
      `    return import(${JSON.stringify(pathToFileURL(inner).href)});`,
      '  })',
      '  .catch((err) => {',
      "    process.stderr.write(String((err && err.stack) || err) + '\\n');",
      '    process.exit(70);',
      '  });',
      '',
    ].join('\n'),
  );
  return file;
}

/** The pids every launcher start wrote. */
const launcherPids = () =>
  readFileSync(pidsFile, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map(Number);

/** Whether a process still runs (EPERM: it does, as another account's). */
function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/** The controllers there are. */
const controllers = () => [fake, codexFake, customFake].filter(Boolean);

/** Every process an agent reported to its controller (itself, its MCP bridge, its helpers) and every launcher start. */
const everyPid = () => [...new Set([...controllers().flatMap((c) => c.pids().map((p) => p.pid)), ...(pidsFile && existsSync(pidsFile) ? launcherPids() : [])])];

/** The command lines of the running `pids` (pid → text), or null when the OS can't say. */
function commandLines(pids) {
  const out = new Map();
  if (!pids.length) return out;
  try {
    if (process.platform === 'linux') {
      for (const pid of pids) {
        try {
          out.set(pid, readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' '));
        } catch {
          /* gone */
        }
      }
    } else if (WIN) {
      const ps = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const filter = pids.map((pid) => `ProcessId=${Number(pid)}`).join(' OR ');
      const text = execFileSync(ps, ['-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process -Filter '${filter}' | ForEach-Object { [string]$_.ProcessId + [char]9 + $_.CommandLine }`], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 30_000,
      });
      for (const line of text.split(/\r?\n/)) {
        const tab = line.indexOf('\t');
        if (tab > 0) out.set(Number(line.slice(0, tab)), line.slice(tab + 1));
      }
    } else {
      for (const pid of pids) {
        try {
          out.set(pid, execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }));
        } catch {
          /* gone */
        }
      }
    }
  } catch {
    return null;
  }
  return out;
}

/**
 * Of these pids, the ones still running as one of this spec's agents, bridges, helpers or
 * launchers (a pid the OS has given to another program since is none of them).
 */
function strays(pids, root) {
  const running = pids.filter(isRunning);
  const lines = commandLines(running);
  if (lines === null) return running;
  const norm = (s) => String(s).toLowerCase().replace(/\\/g, '/');
  const marks = [norm(root), ...controllers().map((c) => norm(c.url)), 'setinterval(()=>{},1<<30)', 'assistant-mcp.mjs'];
  return running.filter((pid) => {
    const line = lines.get(pid);
    return typeof line === 'string' && marks.some((m) => norm(line).includes(m));
  });
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

/**
 * A known agent installed as npm installs it globally, its bin the fake's launcher (which
 * answers --version without a controller). Windows: <prefix>/<program>.cmd beside
 * <prefix>/node_modules/<pkg>; elsewhere <prefix>/bin/<program> -> ../lib/node_modules/<pkg>/<bin>.
 */
function installKnown(prefix, a, ctrl) {
  const modules = WIN ? join(prefix, 'node_modules') : join(prefix, 'lib', 'node_modules');
  const pkgDir = join(modules, ...a.pkg.split('/'));
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: a.pkg, version: a.version, bin: { [a.program]: 'dist/index.js' } }));
  const script = writeLauncher(join(pkgDir, 'dist', 'index.js'), ctrl, { version: a.version });
  if (WIN) {
    writeFileSync(join(prefix, `${a.program}.cmd`), cmdShim(winRel('node_modules', a.pkg, 'dist/index.js')));
  } else {
    chmodSync(script, 0o755);
    mkdirSync(join(prefix, 'bin'), { recursive: true });
    symlinkSync(join('..', 'lib', 'node_modules', ...a.pkg.split('/'), 'dist', 'index.js'), join(prefix, 'bin', a.program));
  }
}

/** A program of no package, found by its name in `dir`: a cmd shim to a node script (Windows), else a node script itself. */
function installProgram(dir, name, ctrl = customFake) {
  mkdirSync(dir, { recursive: true });
  if (WIN) {
    writeLauncher(join(dir, 'node_modules', name, 'agent.js'), ctrl);
    writeFileSync(join(dir, `${name}.cmd`), cmdShim(winRel('node_modules', name, 'agent.js')));
  } else {
    chmodSync(writeLauncher(join(dir, name), ctrl), 0o755);
  }
}

/** The test home's Assistant settings file (the custom agents and the allow records live there). */
function settingsFile() {
  const candidates = [join(host.tmp, 'assistant', 'assistant', 'settings.json'), join(host.tmp, 'assistant', 'settings.json')];
  const file = candidates.find((f) => existsSync(f));
  expect(file, 'the settings file').toBeTruthy();
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** The agents' rows (refresh: looked for again, each version and login file read anew). */
async function agentsNow(request, refresh = false) {
  const r = await request.get(api(`/api/assistant/agents${refresh ? '?refresh=1' : ''}`));
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

test.beforeAll(async ({ request }) => {
  test.setTimeout(240_000);
  fake = await startFakeAcp(CLAUDE_FAKE);
  codexFake = await startFakeAcp(CODEX_FAKE);
  customFake = await startFakeAcp(CUSTOM_FAKE);
  llm = await startFakeLlm();
  const tmp = e2eTemp('assistant-agents');
  const prefix = join(tmp, 'npm');
  first = join(tmp, 'first');
  home = join(tmp, 'home');
  launchers = join(tmp, 'launchers');
  pidsFile = join(tmp, 'launcher-pids.txt');
  writeFileSync(pidsFile, '');
  mkdirSync(first, { recursive: true });
  mkdirSync(prefix, { recursive: true });
  installKnown(prefix, CLAUDE, fake);
  installKnown(prefix, CODEX, codexFake);
  searchDir = WIN ? prefix : join(prefix, 'bin');
  installProgram(searchDir, CUSTOM_PROGRAM);
  // Codex is signed in (its login file); Claude Code isn't yet.
  mkdirSync(join(home, '.codex'), { recursive: true });
  writeFileSync(join(home, '.codex', 'auth.json'), '{}');
  host = await startHost({
    name: 'assistant-agents',
    tmp,
    pluginsFrom: 'python/tests/fixtures/assistant-plugins',
    env: {
      MAGNUSIM_TEST_ASSISTANT: '1',
      MAGNUSIM_TEST_ASSISTANT_PROVIDER_URL: llm.base,
      MAGNUSIM_TEST_ASSISTANT_AGENT_PATHS: [first, searchDir].join(delimiter),
      MAGNUSIM_TEST_ASSISTANT_AGENT_HOME: home,
      MAGNUSIM_TEST_EVENT_HUB: '1',
      MAGNUSIM_TEST_ASSISTANT_HOLD_MS: '2000',
    },
  });
  // The switches hold (else discovery would look at this PC's own agents): stop here.
  const status = await (await fetch(api('/api/assistant/status'))).json();
  expect(status.test_provider, 'the cloud providers go to the fake').toBe(true);
  // The counter workspace the turns work in.
  project = (await postOk(request, '/api/project', { title: PROJECT_TITLE, folder: 'My Projects', units: 'Metric', category: 'Other' })).id;
  study = (await postOk(request, '/api/plugin-studies/create', { project_id: project, plugin: PLUGIN, kind: 'counter_case', title: 'Counter 1' })).study.id;
});

test.beforeEach(async ({ request }) => {
  // Each test from the start: no settings, keys, custom agents, switches or agents running;
  // Claude Code not signed in; the custom program only where the npm prefix is; the scripted
  // agent as it starts by default.
  await resetAssistant(request, host.base);
  fake.configure(CLAUDE_FAKE);
  codexFake.configure(CODEX_FAKE);
  customFake.configure(CUSTOM_FAKE);
  // A test that failed before its turn reached the agent leaves its scripts: they never run here.
  for (const c of controllers()) {
    c.reset();
    c.signOut();
  }
  removeTreeSync(join(home, '.claude'));
  removeTreeSync(first);
  mkdirSync(first, { recursive: true });
});

test.afterEach(async ({ request }) => {
  // Every prompt a test scripted was taken by an agent it ran (read before the reset ends them).
  const unused = controllers().map((c) => c.pending());
  // The reset ends every agent: nothing an agent or a launcher started is left running.
  await resetAssistant(request, host.base);
  await expect.poll(() => strays(everyPid(), host.tmp), { timeout: 15_000, message: 'no agent, bridge, helper or launcher process left running' }).toEqual([]);
  expect(unused, 'every scripted prompt was used (Claude Code, Codex, the custom agent)').toEqual(controllers().map(() => 0));
});

test.afterAll(async () => {
  // Read before the host goes (it removes its temp folder, the pids file with it).
  const started = pidsFile && existsSync(pidsFile) ? launcherPids() : [];
  const all = everyPid();
  const root = host?.tmp ?? '';
  if (host) host.stop();
  if (llm) await llm.stop();
  try {
    if (host) {
      // Every launcher start (discovery's --version probes, each agent started) and every process
      // an agent reported (itself, its bridge, its helpers) has ended, the server's stop included.
      expect(started.length, 'the launcher wrote the pids of the probes it ran').toBeGreaterThan(0);
      await expect.poll(() => strays(all, root), { timeout: 15_000, message: 'no agent, bridge, helper or launcher process left running' }).toEqual([]);
    }
  } finally {
    for (const c of controllers()) await c.stop();
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
  // Each row says which modes Magnusim uses with the agent (the Mode select offers only those).
  expect(rows.find((r) => r.id === 'claude').allowed_modes).toEqual(['default']);
  expect(rows.find((r) => r.id === 'codex').allowed_modes).toEqual(['read-only']);
  expect(rows.find((r) => r.id === 'opencode').allowed_modes).toBe('initial');
});

test("signing in: connect again hears Claude Code ask for it, and the Sign in block shows its terminal command (Copy); signed in, it connects; the Test calls Magnusim's test tool; the Model it listed is saved, and no Mode to choose (Magnusim uses only Default with it)", async ({ page, request }) => {
  test.setTimeout(180_000);
  await recordClipboard(page);
  // The agent's own way to sign in, as the real adapter sends it: Magnusim's Node, its own script and safe arguments.
  const listed = (await agentsNow(request)).find((r) => r.id === 'claude');
  expect(listed.script, 'the resolved script').toBeTruthy();
  // The agents this test starts (the controller lives for the whole file).
  const startedBefore = fake.pids('agent').length;
  fake.configure({
    requireSignIn: true,
    authMethods: [
      {
        id: 'claude-login',
        name: 'Log in with your account',
        type: 'terminal',
        args: ['--cli', 'auth', 'login'],
        _meta: { 'terminal-auth': { command: process.execPath, args: [listed.script, '--cli', 'auth', 'login'], label: 'Log in' } },
      },
    ],
  });
  await page.goto(`${host.base}/#/`);
  await openAssistantStep(page);
  const claude = rowOf(page, 'claude');
  await expect(claude).toHaveAttribute('data-assistant-agent-state', 'signed_out', { timeout: 30_000 });
  const signIn = claude.getByRole('group', { name: 'Sign in to Claude Code' });
  // Nothing heard from the agent yet: its own documentation, no command.
  await expect(signIn.locator('[data-assistant-agent-signin-docs]')).toHaveText('Sign in to Claude Code the way its own documentation says.');
  await expect(signIn.locator('[data-assistant-agent-signin-command]')).toHaveCount(0);

  // Connect again: the agent says it isn't signed in; the block shows the command it sent, as the program's name.
  await signIn.getByRole('button', { name: "I've signed in: connect again" }).click();
  await expect(claude.locator('[data-assistant-agent-result="failed"]')).toHaveText("Claude Code isn't signed in. Settings → Assistant shows how to sign in.");
  const command = signIn.locator('[data-assistant-agent-signin-command="claude-login"]');
  await expect(command).toHaveText(`${CLAUDE.program} --cli auth login`);
  await signIn.locator('[data-assistant-agent-signin-copy="claude-login"]').click();
  await expect(signIn.locator('[data-assistant-agent-signin-copied]')).toHaveText('Copied.');
  expect(await page.evaluate(() => window.__copied)).toEqual([`${CLAUDE.program} --cli auth login`]);
  // The server keeps the agent's ways to sign in on its row (sign_in), the command exactly as shown.
  const asked = (await agentsNow(request)).find((r) => r.id === 'claude');
  expect(asked.sign_in.methods).toEqual([expect.objectContaining({ id: 'claude-login', type: 'terminal', command: `${CLAUDE.program} --cli auth login` })]);
  const checks = fake.pids('agent').slice(startedBefore);
  expect(checks.length, 'the connect check started the agent').toBeGreaterThan(0);
  // It got no message: a connect check sends none.
  expect(checks.flatMap((p) => fake.received(p.pid)).filter((m) => m.method === 'session/prompt')).toEqual([]);

  // Signed in (its own marker, and the login file): connect again connects.
  fake.signIn();
  signInClaude();
  await signIn.getByRole('button', { name: "I've signed in: connect again" }).click();
  await expect(claude.locator('[data-assistant-agent-result="ok"]')).toHaveText(`Connected to Claude Code ${CLAUDE.version}.`);
  await expect(claude).toHaveAttribute('data-assistant-agent-state', 'ready');
  await expect(claude.locator('[data-assistant-agent-line]')).toHaveText(`Claude Code ${CLAUDE.version} · ${LOGIN_YES} · ${OWN_TOOLS_OFF}`);
  await expect(claude.locator('[data-assistant-agent-signin]')).toHaveCount(0);
  const connected = (await agentsNow(request)).find((r) => r.id === 'claude');
  expect(connected.sign_in).toBeNull();
  expect(connected.last.modes.map((m) => m.id)).toEqual(['default', 'plan']);
  expect(connected.last.models.map((m) => m.id)).toEqual(['fake-large', 'fake-small']);

  // Model as it listed them. Mode: of the modes it listed (default, plan) Magnusim uses only
  // Default, which it sets at every start, so there is nothing to choose and no Mode select.
  const model = claude.locator('select[data-assistant-agent-model]');
  await expect(model.locator('option')).toHaveText(["The agent's own choice", 'Fake large', 'Fake small']);
  await expect(claude.locator('select[data-assistant-agent-mode]')).toHaveCount(0);
  await model.selectOption('fake-small');
  await expect.poll(async () => (await agentsNow(request)).find((r) => r.id === 'claude').model).toBe('fake-small');
  expect(settingsFile().agents.claude).toMatchObject({ model: 'fake-small', mode: null });

  // Test: one short message; the agent calls Magnusim's test tool, then answers.
  fake.script({ call: { tool: 'connection_check', args: { word: 'ok' } } }, { say: 'done' });
  await claude.getByRole('button', { name: 'Test' }).click();
  await expect(claude.locator('[data-assistant-agent-result="ok"]')).toHaveText(
    new RegExp(`^Claude Code ${CLAUDE.version.replace(/\./g, '\\.')} answered in \\d+\\.\\d s and called Magnusim's test tool\\. ${OWN_TOOLS_OFF.replace(/\./g, '\\.')}$`),
    { timeout: 60_000 },
  );
  // The Test's session took the saved model, and its one prompt is the test message.
  const testPid = fake.pids('agent').at(-1).pid;
  const got = fake.received(testPid);
  expect(got.find((m) => m.method === 'session/set_config_option' && m.params.configId === 'model')?.params.value).toBe('fake-small');
  expect(got.filter((m) => m.method === 'session/prompt')).toHaveLength(1);
  expect(fake.events('mcp_result', testPid)).toEqual([expect.objectContaining({ tool: 'connection_check', error: null })]);
  // Each check ended its agent (the tree kill): none runs now.
  await expect.poll(() => fake.pids().filter((p) => isRunning(p.pid)).map((p) => p.pid), { timeout: 15_000 }).toEqual([]);
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
  // The coding agents' limits (spec 4.10, the defaults after a reset): in the status, shown, and saved.
  const agentLimits = pane.getByRole('group', { name: 'Coding agents limits' });
  expect(status.agent_caps, 'the status carries the agent limits').toEqual({ changes: 24, calls: 400, turn_minutes: 60 });
  await expect(agentLimits.getByLabel('Changes per message')).toHaveValue('24');
  await expect(agentLimits.getByLabel('Tool calls per message')).toHaveValue('400');
  await expect(agentLimits.getByLabel('Minutes per message')).toHaveValue('60');
  await agentLimits.getByLabel('Changes per message').fill('30');
  await agentLimits.getByLabel('Changes per message').press('Enter');
  await expect.poll(async () => (await assistantStatus(request, host.base)).agent_caps).toEqual({ changes: 30, calls: 400, turn_minutes: 60 });
  await expect(agentLimits.getByLabel('Changes per message')).toHaveValue('30');
  expect(settingsFile().agent_caps).toEqual({ changes: 30, calls: 400, turn_minutes: 60 });
  // Out of bounds: refused with the bounds, and nothing saved.
  await agentLimits.getByLabel('Tool calls per message').fill('5');
  await agentLimits.getByLabel('Tool calls per message').press('Enter');
  await expect(agentLimits.locator('[data-assistant-cap-error="agent_calls"]')).toHaveText('This limit must be a whole number from 10 to 2,000.');
  expect((await assistantStatus(request, host.base)).agent_caps.calls).toBe(400);
});

test('Default and keys side by side (D-A): the agent as the default keeps every key; back again, nothing is lost', async ({ page, request }) => {
  test.setTimeout(120_000);
  signInClaude();
  // A coding agent as the default: the status' readiness is that agent's.
  await agentsNow(request, true);
  const asDefault = await request.post(api('/api/assistant/settings'), { data: { provider: 'agent:claude' } });
  expect(asDefault.status(), JSON.stringify(await asDefault.json())).toBe(200);
  expect(await asDefault.json()).toMatchObject({ provider: 'agent:claude', default_provider: 'agent:claude', ready: true, ready_reason: null });
  removeTreeSync(join(home, '.claude'));
  await agentsNow(request, true);
  expect(await assistantStatus(request, host.base)).toMatchObject({ ready: false, ready_reason: 'agent_signed_out' });
  signInClaude();
  await request.post(api('/api/assistant/settings'), { data: { provider: 'anthropic' } });
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
  expect(listed.allowed_modes, 'a custom agent stays in the mode it starts in').toBe('initial');
  const noOrigin = await request.post(api('/api/assistant/agents/allow'), { data: { id, allow: true, fingerprint: listed.fingerprint } });
  expect(noOrigin.status()).toBe(403);
  expect(await noOrigin.json()).toMatchObject({ code: 'browser_only' });
  const addNoOrigin = await request.post(api('/api/assistant/agents/custom'), { data: { name: 'Sneaky', command: CUSTOM_PROGRAM } });
  expect(addNoOrigin.status()).toBe(403);
  expect(await addNoOrigin.json()).toMatchObject({ code: 'browser_only' });
  // A turn on it: without this account's proof, refused; with it, refused while it is off. Nothing starts.
  const token = await launchToken(request);
  const starts = customFake.pids('agent').length;
  const noProof = await request.post(api('/api/assistant/turns'), { data: { text: 'Hello.', provider: `agent:${id}` } });
  expect(noProof.status()).toBe(403);
  expect(await noProof.json()).toMatchObject({ code: 'launch_proof', error: LAUNCH_PROOF_TEXT });
  const whileOff = await request.post(api('/api/assistant/turns'), { data: { text: 'Hello.', provider: `agent:${id}` }, headers: { 'x-magnusim-launch': token } });
  expect(whileOff.status()).toBe(400);
  expect(await whileOff.json()).toMatchObject({ code: 'agent_not_allowed', error: notAllowedText(CUSTOM_NAME) });
  expect(customFake.pids('agent').length, 'nothing started').toBe(starts);

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
  // Allowed: the turn runs on it (from Home), its own account pays.
  customFake.script({ say: 'Hello from the custom agent.' });
  const hello = await agentTurn(request, { text: 'Hello.', provider: `agent:${id}` }, token);
  const helloEnd = await hello.ended(60_000);
  expect(helloEnd.turn).toMatchObject({ state: 'done', provider: `agent:${id}`, billing: 'agent_account', agent: { id, name: CUSTOM_NAME } });
  expect(ofType(helloEnd.events, 'agent')).toEqual([expect.objectContaining({ name: CUSTOM_NAME, own_tools: 'on' })]);
  expect(ofType(helloEnd.events, 'text').map((e) => e.text).join('')).toBe('Hello from the custom agent.');
  // Kept between messages: its process runs on until the switch goes off.
  const kept = customFake.pids('agent').at(-1).pid;
  expect(isRunning(kept)).toBe(true);

  // Off: at once, no question.
  await toggle.click();
  await expect(sw).not.toBeChecked();
  await expect(row).toHaveAttribute('data-assistant-agent-state', 'needs_allow');
  await expect(modal(page)).toBeHidden();
  expect(allowPosts).toEqual([
    { id, allow: true, fingerprint: listed.fingerprint },
    { id, allow: false },
  ]);
  // Off is the kill switch: what it still ran is gone (its bridge too).
  const keptTree = customFake.pids().filter((p) => p.agent === kept);
  await expect.poll(() => keptTree.filter((p) => isRunning(p.pid)).map((p) => p.role), { timeout: 15_000 }).toEqual([]);

  // Allowed again, then its program found elsewhere (an earlier search folder): asked again.
  // The program moves only once Allow has answered (the switch shows on while it saves, and a
  // program moved meanwhile is refused as changed).
  await toggle.click();
  await page.locator('#cf-confirm').click();
  await expect(sw).toBeChecked();
  await expect(row).toHaveAttribute('data-assistant-agent-state', 'ready');
  expect((await agentsNow(request)).find((r) => r.id === id)).toMatchObject({ allowed: true, fingerprint: listed.fingerprint });
  installProgram(first, CUSTOM_PROGRAM);
  await block.locator('[data-assistant-agents-refresh]').click();
  await expect(row).toHaveAttribute('data-assistant-agent-state', 'allow_changed');
  await expect(row.locator('[data-assistant-agent-allow-changed]')).toHaveText(`${CUSTOM_NAME}'s command or program changed since you allowed it. Allow it again to use it.`);
  await expect(sw).not.toBeChecked();
  await expect(row.locator('[data-assistant-agent-program]')).toContainText(first);
  const changed = (await agentsNow(request)).find((r) => r.id === id);
  expect(changed).toMatchObject({ allowed: false, allow_changed: true, ready: false, reason: 'agent_allow_changed' });
  expect(changed.fingerprint).not.toBe(listed.fingerprint);
  // A turn on it is refused until it is allowed again, and nothing starts.
  const startsChanged = customFake.pids('agent').length;
  const afterChange = await request.post(api('/api/assistant/turns'), { data: { text: 'Hello.', provider: `agent:${id}` }, headers: { 'x-magnusim-launch': token } });
  expect(afterChange.status()).toBe(400);
  expect(await afterChange.json()).toMatchObject({ code: 'agent_allow_changed', error: `${CUSTOM_NAME}'s command changed since you allowed it. Allow it again in Settings → Assistant.` });
  expect(customFake.pids('agent').length).toBe(startsChanged);

  // The old allow is still kept (what started under it may still run): Turn off clears it, with no question.
  const turnOff = row.getByRole('button', { name: 'Turn off' });
  await expect(turnOff).toBeVisible();
  await turnOff.click();
  await expect(row).toHaveAttribute('data-assistant-agent-state', 'needs_allow');
  await expect(turnOff).toHaveCount(0);
  await expect(modal(page)).toBeHidden();
  await expect(sw).toBeFocused();
  expect(allowPosts.at(-1)).toEqual({ id, allow: false });
  expect((await agentsNow(request)).find((r) => r.id === id)).toMatchObject({ allowed: false, allow_changed: false, reason: 'agent_not_allowed' });
  expect(settingsFile().agents?.[id]?.allowed ?? null).toBeNull();

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

// ---------------------------------------------------------------- agent turns (spec 7.6, tests 4-10)

async function postOk(request, path, data = {}, headers = {}) {
  const r = await request.post(api(path), { data, headers });
  const j = await r.json().catch(() => ({}));
  expect(r.ok(), `${path}: ${r.status()} ${JSON.stringify(j)}`).toBe(true);
  return j;
}

async function getJson(request, path) {
  const r = await request.get(api(path));
  expect(r.status(), path).toBe(200);
  return r.json();
}

/** What the page sends with the browser-only routes (the app's own origin). */
const fromPage = () => ({ origin: host.base });

/**
 * This launch's token, from the server's mcp.json (its path is the bridge's --info): a turn on a
 * coding agent needs it, or the tab's live link. The connection starts with an agent turn's
 * start, so a first start without the proof (refused) starts it when it isn't running yet.
 */
async function launchToken(request) {
  const info = infoPathOf(await getJson(request, '/api/assistant/mcp'));
  if (!existsSync(info)) {
    const r = await request.post(api('/api/assistant/turns'), { data: { text: 'Hello.', provider: 'agent:claude' } });
    expect(r.status()).toBe(403);
    expect((await r.json()).code).toBe('launch_proof');
  }
  await expect.poll(() => existsSync(info), { message: 'the connection file' }).toBe(true);
  return JSON.parse(readFileSync(info, 'utf8')).token;
}

/** Follows a turn's event log through the long-poll. */
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

/** Starts a turn (202) and follows it: {id, conversation, answerKey, waitFor, ended}. `token`: an agent turn's launch proof. */
async function startTurn(request, body, token = null) {
  const r = await request.post(api('/api/assistant/turns'), { data: body, headers: token ? { 'x-magnusim-launch': token } : {} });
  const j = await r.json();
  expect(r.status(), JSON.stringify(j)).toBe(202);
  return Object.assign(followTurn(request, j.turn), { conversation: j.conversation, answerKey: j.answer_key });
}

/** A turn on a coding agent, with this launch's token. */
const agentTurn = (request, body, token) => startTurn(request, body, token);

const ofType = (events, type) => events.filter((e) => e.type === type);

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
  return (await getJson(request, '/api/assistant/tabs')).tabs.find((x) => x.tab === tab) || null;
}

/** The counter workspace's frame (a Playwright Frame, for evaluate), once it connected. */
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

/** Opens the counter workspace in `page` and waits until its tools are offered: {frame (a FrameLocator), handle (the Frame), tab}. */
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
  const handle = await counterFrame(page);
  await expect.poll(tabOf, { message: "the tab's event stream" }).not.toBe('');
  const tab = tabOf();
  await expect.poll(async () => tabRow(request, tab).then((r) => (r ? `${r.connected}:${r.tools.length}` : 'none')), { timeout: 30_000 }).toBe(`true:${TOOLS.length}`);
  return { frame, handle, tab };
}

/** A custom agent (the scripted one, style none) added as the page adds it; allowed when asked. Its id. */
async function addCustom(request, { allow = false } = {}) {
  const added = await postOk(request, '/api/assistant/agents/custom', { name: CUSTOM_NAME, command: `${CUSTOM_PROGRAM} --acp` }, fromPage());
  const id = added.agent.id;
  if (allow) {
    const fingerprint = added.agent.fingerprint ?? (await agentsNow(request)).find((r) => r.id === id).fingerprint;
    const ok = await postOk(request, '/api/assistant/agents/allow', { id, allow: true, fingerprint }, fromPage());
    expect(ok.agent).toMatchObject({ allowed: true, ready: true });
  }
  return id;
}

/** The agent process `ctrl`'s fake reported last, and every process of its tree it reported (itself, its bridge, its helpers). */
function lastAgent(ctrl) {
  const agent = ctrl.pids('agent').at(-1);
  expect(agent, 'an agent started').toBeTruthy();
  return { pid: agent.pid, tree: ctrl.pids().filter((p) => p.agent === agent.pid && p.instance === agent.instance) };
}

/** A slow call runs in the page: its progress reached the turn and the page shows it running. */
async function slowRunning(t, w) {
  const call = await t.waitFor((e) => e.type === 'tool_call' && e.tool === `${PLUGIN}__slow_add`, 'the slow call');
  await t.waitFor((e) => e.type === 'tool_progress' && e.call === call.call, 'its progress');
  await expect(w.frame.locator('#slow')).toHaveText('running');
  return call;
}

test("a turn on Claude Code (its own tools off) works in the open workspace through Magnusim's tools: Auto-allowed is logged, nothing is asked, the counter reads 2, and its own account pays (no $ counted)", async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  signInClaude();
  await postOk(request, '/api/assistant/settings', { privacy: 'allow' });
  const token = await launchToken(request);
  const w = await openCounter(page, request);
  const spent = (await getJson(request, '/api/assistant/status')).spent_today_usd;
  fake.script(
    { plan: [{ content: 'Add 2 to the counter', status: 'in_progress', priority: 'high' }] },
    { askOurs: { tool: `${PLUGIN}__add` } },
    { call: { tool: `${PLUGIN}__add`, args: { by: 2 } } },
    { say: 'Added 2.' },
  );
  const t = await agentTurn(request, { text: 'Add 2 to the counter.', tab: w.tab, provider: 'agent:claude' }, token);
  const { turn, events } = await t.ended(60_000);
  expect(turn).toMatchObject({
    state: 'done',
    end_reason: 'end_turn',
    provider: 'agent:claude',
    billing: 'agent_account',
    agent: { id: 'claude', name: 'Claude Code', version: CLAUDE.version },
    tab: w.tab,
    project_id: project,
    usd: 0,
  });
  await expect(w.frame.locator('#counter')).toHaveText('2');
  await expect(modal(page)).toBeHidden();
  expect(ofType(events, 'agent')).toEqual([expect.objectContaining({ name: 'Claude Code', version: CLAUDE.version, own_tools: 'off' })]);
  expect(ofType(events, 'plan')).toEqual([expect.objectContaining({ entries: [{ content: 'Add 2 to the counter', status: 'in_progress', priority: 'high' }] })]);
  // Its permission request for Magnusim's tool: allowed by Magnusim (its own question covers it), never asked.
  expect(ofType(events, 'agent_permission')).toEqual([expect.objectContaining({ title: `${PLUGIN}__add`, outcome: 'auto_allowed', by: 'magnusim' })]);
  expect(ofType(events, 'gate')).toEqual([]);
  // The call is logged once, as Magnusim's own (the agent's updates for it are not its own tools).
  const calls = ofType(events, 'tool_call');
  expect(calls.map((e) => e.tool)).toEqual([`${PLUGIN}__add`]);
  expect(ofType(events, 'tool_result')).toEqual([expect.objectContaining({ call: calls[0].call, ok: true })]);
  expect(ofType(events, 'agent_tool')).toEqual([]);
  expect(ofType(events, 'text').map((e) => e.text).join('')).toBe('Added 2.');
  // Its own account pays: no usage, and today's API-key spend is unchanged.
  expect(ofType(events, 'usage')).toEqual([]);
  expect((await getJson(request, '/api/assistant/status')).spent_today_usd).toBe(spent);

  // What the agent got: no file system or terminal; the bridge with its binding and no token; its own tools off.
  const { pid } = lastAgent(fake);
  expect(fake.events('permission_outcome', pid)).toEqual([expect.objectContaining({ outcome: { outcome: 'selected', optionId: 'allow' } })]);
  const got = fake.received(pid);
  expect(got.find((m) => m.method === 'initialize').params.clientCapabilities).toMatchObject({ fs: { readTextFile: false, writeTextFile: false }, terminal: false });
  const session = got.find((m) => m.method === 'session/new');
  const server = session.params.mcpServers[0];
  expect(server.name).toBe('magnusim');
  expect(server).not.toHaveProperty('type');
  expect(server.args).toEqual(expect.arrayContaining(['--binding', '--info']));
  expect(JSON.stringify(session).includes(token), 'no token in what the agent got').toBe(false);
  expect(session.params._meta.claudeCode.options).toMatchObject({ tools: [], allowDangerouslySkipPermissions: false, settingSources: [], strictMcpConfig: true });
  expect(got.find((m) => m.method === 'session/set_mode')?.params.modeId).toBe('default');
  expect(fake.events('mcp_tools', pid)[0].tools).toEqual(expect.arrayContaining(TOOLS));
  // It asked to read a file: Magnusim serves no file system (-32601).
  const fsAnswer = await fake.waitFor((r) => r.event === 'fs_answer' && r.pid === pid);
  expect(fsAnswer.answer.error.code).toBe(-32601);
});

test("a destructive tool asks in the app with Don't focused: Enter answers Don't and the counter stays; in the same conversation (the agent kept) a click on Allow runs it", async ({ page, request }) => {
  test.setTimeout(180_000);
  signInClaude();
  await postOk(request, '/api/assistant/settings', { privacy: 'allow' });
  const token = await launchToken(request);
  const w = await openCounter(page, request);
  const counter = w.frame.locator('#counter');
  const dialog = modal(page);
  fake.script({ call: { tool: `${PLUGIN}__add`, args: { by: 2 } } }, { call: { tool: `${PLUGIN}__reset` } }, { say: 'It was not reset.' });
  const t1 = await agentTurn(request, { text: 'Add 2, then reset the counter.', tab: w.tab, provider: 'agent:claude' }, token);
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await expect(counter).toHaveText('2');
  await expect(page.locator('#cf-heading')).toContainText('reset the counter');
  await expect(page.locator('#cf-cancel')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  const e1 = await t1.ended(60_000);
  expect(e1.turn.state).toBe('done');
  const reset1 = ofType(e1.events, 'tool_call').find((e) => e.tool === `${PLUGIN}__reset`);
  expect(ofType(e1.events, 'tool_result').find((e) => e.call === reset1.call)).toMatchObject({ ok: false, code: 'declined' });
  expect(ofType(e1.events, 'gate_closed')).toEqual([expect.objectContaining({ answer: 'deny', by: 'user' })]);
  await expect(counter).toHaveText('2');

  // The same conversation (its provider kept): the agent kept between messages; Allow runs it.
  const { pid } = lastAgent(fake);
  fake.script({ call: { tool: `${PLUGIN}__reset` } }, { say: 'Reset.' });
  const t2 = await agentTurn(request, { text: 'Reset it now.', conversation: t1.conversation, tab: w.tab }, token);
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('#cf-cancel')).toBeFocused();
  await page.locator('#cf-confirm').click();
  await expect(dialog).toBeHidden();
  const e2 = await t2.ended(60_000);
  expect(e2.turn).toMatchObject({ state: 'done', provider: 'agent:claude' });
  await expect(counter).toHaveText('0');
  expect(lastAgent(fake).pid, 'the same agent process').toBe(pid);
  expect(ofType(e2.events, 'note')).toEqual([]);
});

test("the agent's own tool: a custom agent's request is a question only the app's window answers (link only): the answer key is refused, Enter answers Don't, and the agent hears reject", async ({ page, request }) => {
  test.setTimeout(180_000);
  await postOk(request, '/api/assistant/settings', { privacy: 'allow' });
  const id = await addCustom(request, { allow: true });
  const token = await launchToken(request);
  const w = await openCounter(page, request);
  const dialog = modal(page);
  customFake.script({ askOwn: { title: 'Run the build script', kind: 'execute', rawInput: { command: 'npm run build' } } }, { say: 'I did not run it.' });
  const t = await agentTurn(request, { text: 'Build it.', tab: w.tab, provider: `agent:${id}` }, token);
  const gate = (await t.waitFor((e) => e.type === 'gate', 'the question')).gate;
  expect(gate).toMatchObject({ kind: 'confirm', link_only: true, title: `Let ${CUSTOM_NAME} use its own tool (execute)?`, yes: 'Allow once', no: "Don't", source: `${CUSTOM_NAME} (its own tool)` });
  await expect(dialog).toBeVisible();
  await expect(page.locator('#cf-heading')).toHaveText(`Let ${CUSTOM_NAME} use its own tool (execute)?`);
  await expect(page.locator('#cf-copy')).toContainText(`${CUSTOM_NAME} asks to use one of its own tools. Magnusim can't see or check what it does on this PC. As the agent describes it: Run the build script.`);
  await expect(page.locator('#cf-copy')).toContainText('npm run build');
  await expect(page.locator('#cf-confirm')).toHaveText('Allow once');
  await expect(page.locator('#cf-cancel')).toHaveText("Don't");
  await expect(page.locator('#cf-cancel')).toBeFocused();
  // The program that started the turn holds its answer key, but this question is the window's only.
  const byKey = await request.post(api(`/api/assistant/gates/${gate.id}`), { data: { allow: true, answer_key: t.answerKey } });
  expect(byKey.status()).toBe(403);
  expect((await byKey.json()).code).toBe('not_shown');
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  const { turn, events } = await t.ended(60_000);
  expect(turn).toMatchObject({ state: 'done', provider: `agent:${id}`, billing: 'agent_account' });
  expect(ofType(events, 'agent')).toEqual([expect.objectContaining({ name: CUSTOM_NAME, own_tools: 'on' })]);
  expect(ofType(events, 'agent_tool')).toEqual([expect.objectContaining({ title: 'Run the build script', kind: 'execute', status: 'pending' })]);
  expect(ofType(events, 'agent_permission')).toEqual([expect.objectContaining({ outcome: 'declined', by: 'user' })]);
  const { pid } = lastAgent(customFake);
  expect(customFake.events('permission_outcome', pid)).toEqual([expect.objectContaining({ outcome: { outcome: 'selected', optionId: 'reject' } })]);
});

test("privacy Ask for destination agent:claude: the question shows in the app before anything is sent (no agent started), only the window answers it; Don't send sends nothing; Send starts the agent, and it is remembered", async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  signInClaude();
  await postOk(request, '/api/assistant/settings', { privacy: 'ask', forget_consents: true });
  const token = await launchToken(request);
  const w = await openCounter(page, request);
  const dialog = modal(page);
  const starts = fake.pids('agent').length;
  const t1 = await agentTurn(request, { text: 'Read the counter.', tab: w.tab, provider: 'agent:claude' }, token);
  const gate = (await t1.waitFor((e) => e.type === 'gate', 'the privacy question')).gate;
  expect(gate).toMatchObject({ kind: 'privacy', link_only: true, title: `Send project "${PROJECT_TITLE}" to Claude Code?`, yes: 'Send', no: "Don't send" });
  await expect(dialog).toBeVisible();
  await expect(page.locator('#cf-heading')).toHaveText(`Send project "${PROJECT_TITLE}" to Claude Code?`);
  await expect(page.locator('#cf-copy')).toHaveText(
    "The Assistant's coding agent, Claude Code, is about to read this project's names, settings, results and pictures of the open workspace and send them to its own service under your account. Settings → Assistant can change this.",
  );
  await expect(page.locator('#cf-cancel')).toBeFocused();
  expect(fake.pids('agent').length, 'no agent started before the answer').toBe(starts);
  const byKey = await request.post(api(`/api/assistant/gates/${gate.id}`), { data: { allow: true, answer_key: t1.answerKey } });
  expect(byKey.status()).toBe(403);
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  const e1 = await t1.ended();
  expect(e1.turn).toMatchObject({ state: 'stopped', end_reason: 'privacy', message: 'Nothing was sent.' });
  expect(fake.pids('agent').length, 'nothing was sent: no agent started').toBe(starts);

  // Send: only now the agent starts, and lists the project's tools.
  fake.script({ call: { tool: `${PLUGIN}__get_count` } }, { say: 'It reads 0.' });
  const t2 = await agentTurn(request, { text: 'Read the counter.', tab: w.tab, provider: 'agent:claude' }, token);
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  expect(fake.pids('agent').length).toBe(starts);
  await page.locator('#cf-confirm').click();
  await expect(dialog).toBeHidden();
  const e2 = await t2.ended(60_000);
  expect(e2.turn.state).toBe('done');
  expect(fake.pids('agent').length).toBe(starts + 1);
  expect((await getJson(request, '/api/assistant/status')).consents).toBe(1);
  // Remembered for this project and this agent: the next message asks nothing.
  fake.script({ say: 'Still 0.' });
  const e3 = await (await agentTurn(request, { text: 'And now?', conversation: t2.conversation, tab: w.tab }, token)).ended(60_000);
  expect(e3.turn.state).toBe('done');
  expect(ofType(e3.events, 'gate')).toEqual([]);
});

test('Stop during a tool on a stubborn agent: the page aborts the call, the turn ends stopped, the agent hears session/cancel, and 3 s later its whole tree (helpers, bridge) is killed', async ({ page, request }) => {
  test.setTimeout(180_000);
  signInClaude();
  await postOk(request, '/api/assistant/settings', { privacy: 'allow' });
  const token = await launchToken(request);
  const w = await openCounter(page, request);
  // Stubborn: it ignores the cancel, the end of its input and SIGTERM, and its helpers outlive it on purpose.
  fake.configure({ stubborn: true });
  fake.script('ignoreCancel', { spawnHelpers: 2 }, { call: { tool: `${PLUGIN}__slow_add`, args: { by: 5 } } }, { hold: 'never' });
  const t = await agentTurn(request, { text: 'Add 5 slowly.', tab: w.tab, provider: 'agent:claude' }, token);
  const call = await slowRunning(t, w);
  const { pid, tree } = lastAgent(fake);
  expect(tree.map((p) => p.role).sort()).toEqual(['agent', 'helper', 'helper', 'mcp']);
  expect(tree.filter((p) => isRunning(p.pid))).toHaveLength(4);
  const stopAt = Date.now();
  const r = await postOk(request, `/api/assistant/turns/${t.id}/stop`, {});
  await expect(w.frame.locator('#aborted')).toHaveText('aborted');
  const { turn, events } = await t.ended();
  expect(turn).toMatchObject({ state: 'stopped', end_reason: 'user' });
  expect(r.turn?.state ?? 'stopping').toMatch(/^(stopped|stopping)$/);
  expect(ofType(events, 'tool_result').find((e) => e.call === call.call)).toMatchObject({ ok: false, code: 'stopped' });
  await expect(w.frame.locator('#counter')).toHaveText('0');
  // It heard the cancel (it was there to hear it), ignored it, and its whole tree went after the wait.
  await fake.waitFor((rec) => rec.pid === pid && rec.dir === 'in' && rec.msg?.method === 'session/cancel', 10_000);
  await expect.poll(() => tree.filter((p) => isRunning(p.pid)).map((p) => p.role), { timeout: AGENT_CANCEL_MS + 10_000, message: 'the agent, its helpers and its bridge are gone' }).toEqual([]);
  expect(Date.now() - stopAt, 'within the wait and the ceiling').toBeLessThan(AGENT_CANCEL_MS + 10_000);
  expect(Date.parse(turn.ended_at) - stopAt, 'the kill waited for the agent to answer the cancel').toBeGreaterThanOrEqual(AGENT_CANCEL_MS - 1000);
  // The conversation keeps no process.
  const agents = (await getJson(request, '/api/test/assistant/state')).agents;
  expect(Object.values(agents).filter((a) => a.pid !== null)).toEqual([]);
});

test("Stop while the agent's own question is open: the question goes, the agent hears its permission cancelled before session/cancel, and a polite agent answers, so nothing is killed", async ({ page, request }) => {
  test.setTimeout(180_000);
  await postOk(request, '/api/assistant/settings', { privacy: 'allow' });
  const id = await addCustom(request, { allow: true });
  const token = await launchToken(request);
  const w = await openCounter(page, request);
  const dialog = modal(page);
  // After its question it waits (a cancel ends the wait): nothing it says comes between the cancelled answer and the cancel.
  customFake.script({ askOwn: { title: 'Delete the build folder', kind: 'delete', rawInput: { path: 'build' } } }, { hold: 'after-the-question' }, { say: 'Never said.' });
  const t = await agentTurn(request, { text: 'Clean up.', tab: w.tab, provider: `agent:${id}` }, token);
  await t.waitFor((e) => e.type === 'gate', 'the question');
  await expect(dialog).toBeVisible();
  const { pid, tree } = lastAgent(customFake);
  await postOk(request, `/api/assistant/turns/${t.id}/stop`, {});
  await expect(dialog).toBeHidden();
  const { turn, events } = await t.ended();
  expect(turn).toMatchObject({ state: 'stopped', end_reason: 'user' });
  expect(ofType(events, 'gate_closed')).toEqual([expect.objectContaining({ by: 'stop' })]);
  expect(ofType(events, 'text')).toEqual([]);
  // In the order it got them: its open permission answered cancelled, then session/cancel.
  await customFake.waitFor((rec) => rec.pid === pid && rec.dir === 'in' && rec.msg?.method === 'session/cancel', 10_000);
  const got = customFake.received(pid);
  const reply = got.findIndex((m) => m.result?.outcome !== undefined);
  const cancel = got.findIndex((m) => m.method === 'session/cancel');
  expect(got[reply].result.outcome).toEqual({ outcome: 'cancelled' });
  expect(reply, 'the permission answered before the cancel').toBeLessThan(cancel);
  // Polite: it answered the prompt cancelled at once, so it was not killed (kept for the conversation).
  await customFake.waitFor((rec) => rec.pid === pid && rec.dir === 'out' && rec.msg?.result?.stopReason === 'cancelled', 10_000);
  expect(tree.filter((p) => isRunning(p.pid)).map((p) => p.role).sort()).toEqual(['agent', 'mcp']);
  const agents = Object.values((await getJson(request, '/api/test/assistant/state')).agents);
  expect(agents).toEqual([expect.objectContaining({ agent: id, state: 'ready' })]);
});

test('the agent crashing mid-tool: the call ends, the turn fails agent_exited with its last words, its bridge is gone, and the next message starts it again with a note', async ({ page, request }) => {
  test.setTimeout(180_000);
  signInClaude();
  await postOk(request, '/api/assistant/settings', { privacy: 'allow' });
  const token = await launchToken(request);
  const w = await openCounter(page, request);
  fake.script('exitDuringCall', { call: { tool: `${PLUGIN}__slow_add`, args: { by: 3 } } });
  const t = await agentTurn(request, { text: 'Add 3 slowly.', tab: w.tab, provider: 'agent:claude' }, token);
  const { turn, events } = await t.ended(60_000);
  expect(turn).toMatchObject({ state: 'failed', end_reason: 'agent_exited', message: "Claude Code stopped unexpectedly. Its last words: 'fake agent: exiting during a call'" });
  const call = ofType(events, 'tool_call').find((e) => e.tool === `${PLUGIN}__slow_add`);
  expect(call, 'the slow call ran').toBeTruthy();
  // The call says the agent went (never "Stopped by the user", never "The server stopped").
  expect(ofType(events, 'tool_result').find((e) => e.call === call.call)).toMatchObject({
    ok: false,
    code: 'stopped',
    summary: 'Claude Code stopped unexpectedly while it ran; it may or may not have finished.',
  });
  await expect(w.frame.locator('#aborted')).toHaveText('aborted');
  await expect(w.frame.locator('#counter')).toHaveText('0');
  const { pid, tree } = lastAgent(fake);
  expect(tree.map((p) => p.role).sort()).toEqual(['agent', 'mcp']);
  await expect.poll(() => tree.filter((p) => isRunning(p.pid)).map((p) => p.role), { timeout: 15_000, message: 'no bridge left' }).toEqual([]);

  // The next message of the conversation starts it again, and says it doesn't remember.
  fake.script({ say: 'Here again.' });
  const e2 = await (await agentTurn(request, { text: 'Are you there?', conversation: t.conversation, tab: w.tab }, token)).ended(60_000);
  expect(e2.turn).toMatchObject({ state: 'done', provider: 'agent:claude' });
  expect(ofType(e2.events, 'note').map((e) => e.text)).toContain("Claude Code was started again, so it doesn't remember this conversation's earlier messages.");
  expect(lastAgent(fake).pid, 'a new agent process').not.toBe(pid);
});

test("a hidden tab keeps its link through an agent's tool call: past the page's own grace the call still runs, its result is delivered, and the turn ends done", async ({ page, request }) => {
  test.setTimeout(180_000);
  signInClaude();
  await postOk(request, '/api/assistant/settings', { privacy: 'allow' });
  const token = await launchToken(request);
  const w = await openCounter(page, request);
  fake.script({ call: { tool: `${PLUGIN}__slow_add`, args: { by: 4 } } }, { say: 'Added 4.' });
  const t = await agentTurn(request, { text: 'Add 4 slowly.', tab: w.tab, provider: 'agent:claude' }, token);
  const call = await slowRunning(t, w);
  const assistantChannels = async () => ((await serverStream(request, host, w.tab)) || { kinds: {} }).kinds.assistant || 0;
  await setHidden(page, true);
  const hiddenAt = Date.now();
  try {
    // Its progress goes on past the page's own grace (no sleep: the page's own reports are the clock).
    await t.waitFor((e) => e.type === 'tool_progress' && e.call === call.call && e.at >= hiddenAt + HIDDEN_GRACE_MS + 1000, 'progress past the grace', 30_000);
    expect(await assistantChannels(), 'kept while the call runs').toBe(1);
    expect(await w.handle.evaluate(() => window.__release())).toBe(true);
    const result = await t.waitFor((e) => e.type === 'tool_result' && e.call === call.call, 'the result', 15_000);
    expect(result).toMatchObject({ ok: true });
    const { turn } = await t.ended(60_000);
    expect(turn.state).toBe('done');
    await expect(w.frame.locator('#counter')).toHaveText('4');
  } finally {
    await setHidden(page, false);
  }
});

test("an agent whose own tools stay on (Codex) is refused until its allow switch is on, then works: its flagged calls and approvals count as Magnusim's (Auto-allowed), and it runs in read-only mode", async ({ page, request }) => {
  test.setTimeout(180_000);
  await postOk(request, '/api/assistant/settings', { privacy: 'allow' });
  const token = await launchToken(request);
  const starts = codexFake.pids('agent').length;
  const refused = await request.post(api('/api/assistant/turns'), { data: { text: 'Add 1.', provider: 'agent:codex' }, headers: { 'x-magnusim-launch': token } });
  expect(refused.status()).toBe(400);
  expect(await refused.json()).toMatchObject({ code: 'agent_not_allowed', error: notAllowedText('Codex') });
  expect(codexFake.pids('agent').length, 'nothing started').toBe(starts);

  // Its switch in Settings: the question first, then Allow.
  await page.goto(`${host.base}/#/`);
  await openAssistantStep(page);
  const codex = rowOf(page, 'codex');
  await expect(codex).toHaveAttribute('data-assistant-agent-state', 'needs_allow', { timeout: 30_000 });
  await codex.locator('label.wiz-assistant-switch').click();
  await expect(modal(page)).toBeVisible();
  await expect(page.locator('#cf-cancel')).toBeFocused();
  await page.locator('#cf-confirm').click();
  await expect(codex.getByRole('switch', { name: 'Allow this agent' })).toBeChecked();
  await expect(codex).toHaveAttribute('data-assistant-agent-state', 'ready');

  const w = await openCounter(page, request);
  codexFake.script({ askOurs: { tool: `${PLUGIN}__add` } }, { call: { tool: `${PLUGIN}__add`, args: { by: 1 } } }, { say: 'Added 1.' });
  const t = await agentTurn(request, { text: 'Add 1.', tab: w.tab, provider: 'agent:codex' }, token);
  const { turn, events } = await t.ended(60_000);
  expect(turn).toMatchObject({ state: 'done', provider: 'agent:codex', billing: 'agent_account', agent: { id: 'codex', name: 'Codex' } });
  await expect(w.frame.locator('#counter')).toHaveText('1');
  expect(ofType(events, 'agent')).toEqual([expect.objectContaining({ name: 'Codex', own_tools: 'on' })]);
  expect(ofType(events, 'agent_permission')).toEqual([expect.objectContaining({ title: `${PLUGIN}__add`, outcome: 'auto_allowed', by: 'magnusim' })]);
  expect(ofType(events, 'tool_call').map((e) => e.tool)).toEqual([`${PLUGIN}__add`]);
  expect(ofType(events, 'agent_tool')).toEqual([]);
  expect(ofType(events, 'gate')).toEqual([]);
  const { pid } = lastAgent(codexFake);
  const got = codexFake.received(pid);
  expect(got.find((m) => m.method === 'session/set_mode')?.params.modeId).toBe('read-only');
  expect(got.find((m) => m.method === 'session/new').params._meta?.claudeCode).toBeUndefined();
  expect(codexFake.events('permission_outcome', pid)).toEqual([expect.objectContaining({ outcome: { outcome: 'selected', optionId: 'allow' } })]);
});

test('the terminal client: --agent claude --tab auto runs on the browser tab with the launch token and prints the agent lines and who pays; an agent that is off exits 1 with the reason', async ({ page, request }) => {
  test.setTimeout(180_000);
  signInClaude();
  await postOk(request, '/api/assistant/settings', { privacy: 'allow' });
  const w = await openCounter(page, request);
  const cli = (args) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [join(WEB_ROOT, 'scripts', 'assistant-run.mjs'), '--port', String(host.port), ...args], {
        cwd: WEB_ROOT,
        // The server's own Assistant home: the client finds its connection file (the token) there.
        env: { ...process.env, MAGNUSIM_ASSISTANT_HOME: join(host.tmp, 'assistant') },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (b) => (out += b));
      child.stderr.on('data', (b) => (err += b));
      const timer = setTimeout(() => child.kill(), 90_000);
      child.once('exit', (code) => {
        clearTimeout(timer);
        resolve({ code, out, err });
      });
    });
  fake.script({ plan: ['Add 3'] }, { askOurs: { tool: `${PLUGIN}__add` } }, { call: { tool: `${PLUGIN}__add`, args: { by: 3 } } }, { say: 'Added 3.' });
  const r = await cli(['--agent', 'claude', '--tab', 'auto', 'Add 3 to the counter.']);
  expect(r.code, `${r.out}\n${r.err}`).toBe(0);
  await expect(w.frame.locator('#counter')).toHaveText('3');
  expect(r.out).toContain(`Claude Code ${CLAUDE.version} is working (its own tools are off).`);
  expect(r.out).toContain('plan:\n  [ ] Add 3');
  expect(r.out).toContain(`auto-allowed: ${PLUGIN}__add`);
  expect(r.out).toContain(`→ ${PLUGIN}__add {"by":3}`);
  expect(r.out).toContain('Added 3.');
  expect(r.out).toContain("Billed to your Claude Code account (Magnusim can't see the cost).");
  const token = JSON.parse(readFileSync(infoPathOf(await getJson(request, '/api/assistant/mcp')), 'utf8')).token;
  expect(`${r.out}${r.err}`.includes(token), 'the token is never printed').toBe(false);

  // An agent that is off: refused with the reason, nothing started.
  const starts = codexFake.pids('agent').length;
  const off = await cli(['--agent', 'codex', '--tab', 'auto', 'Add 1.']);
  expect(off.code).toBe(1);
  expect(off.err).toContain(notAllowedText('Codex'));
  expect(codexFake.pids('agent').length).toBe(starts);
});

test("API-key turns keep working beside agent turns (D-A): each conversation stays bound to its provider; the agent's turn bills its own account (no $ counted, said in Settings) while the API-key turn's spend counts", async ({
  page,
  request,
}) => {
  test.setTimeout(240_000);
  signInClaude();
  await postOk(request, '/api/assistant/settings', { provider: 'anthropic', privacy: 'allow' });
  await postOk(request, '/api/assistant/key', { provider: 'anthropic', key: KEY });
  const token = await launchToken(request);
  const w = await openCounter(page, request);
  const counter = w.frame.locator('#counter');
  const spent0 = (await getJson(request, '/api/assistant/status')).spent_today_usd;

  // The agent's turn, named by the turn (the default stays the API key).
  fake.script({ call: { tool: `${PLUGIN}__add`, args: { by: 1 } } }, { say: 'The agent added 1.' });
  const a = await agentTurn(request, { text: 'Add 1.', tab: w.tab, provider: 'agent:claude' }, token);
  const ea = await a.ended(60_000);
  expect(ea.turn).toMatchObject({ state: 'done', provider: 'agent:claude', billing: 'agent_account', usd: 0 });
  expect(ofType(ea.events, 'usage')).toEqual([]);
  await expect(counter).toHaveText('1');
  expect((await getJson(request, '/api/assistant/status')).spent_today_usd, 'no $ counted for the agent').toBe(spent0);

  // The default's (API key) turn, beside it: the same tools, and its spend counts.
  const usage = { input: 100_000, output: 5_000 };
  llm.reply({ tools: [{ name: `${PLUGIN}__add`, input: { by: 2 } }], usage }, { text: 'Added 2.', usage });
  const k = await startTurn(request, { text: 'Add 2.', tab: w.tab });
  const ek = await k.ended(60_000);
  expect(ek.turn).toMatchObject({ state: 'done', provider: 'anthropic', billing: 'usd', agent: null });
  expect(ofType(ek.events, 'usage').length).toBeGreaterThan(0);
  expect(ek.turn.usd).toBeGreaterThan(0);
  await expect(counter).toHaveText('3');
  const spent1 = (await getJson(request, '/api/assistant/status')).spent_today_usd;
  expect(spent1).toBeCloseTo(spent0 + ek.turn.usd, 6);

  // Each conversation stays bound to its provider.
  const cross1 = await request.post(api('/api/assistant/turns'), { data: { text: 'Again.', conversation: a.conversation, provider: 'anthropic', tab: w.tab } });
  expect(cross1.status()).toBe(409);
  expect(await cross1.json()).toMatchObject({ code: 'conversation_changed', field: 'provider' });
  const cross2 = await request.post(api('/api/assistant/turns'), { data: { text: 'Again.', conversation: k.conversation, provider: 'agent:claude', tab: w.tab }, headers: { 'x-magnusim-launch': token } });
  expect(cross2.status()).toBe(409);
  expect(await cross2.json()).toMatchObject({ code: 'conversation_changed', field: 'provider' });
  // Named by their conversations alone, each goes on with its own.
  fake.script({ say: 'Still the agent.' });
  const a2 = await (await agentTurn(request, { text: 'Who are you?', conversation: a.conversation, tab: w.tab }, token)).ended(60_000);
  expect(a2.turn).toMatchObject({ state: 'done', provider: 'agent:claude', billing: 'agent_account' });
  llm.reply({ text: 'Still the API key.' });
  const k2 = await (await startTurn(request, { text: 'Who are you?', conversation: k.conversation, tab: w.tab })).ended(60_000);
  expect(k2.turn).toMatchObject({ state: 'done', provider: 'anthropic' });
  expect((await getJson(request, '/api/assistant/status')).spent_today_usd).toBeGreaterThan(spent1);

  // Settings says who pays: the agent's billing line, and "Spent today" counts API keys only.
  const settingsPage = await page.context().newPage();
  try {
    await settingsPage.goto(`${host.base}/#/`);
    const pane = await openAssistantStep(settingsPage);
    const spent = (await getJson(request, '/api/assistant/status')).spent_today_usd;
    await expect(pane.locator('[data-assistant-spent]')).toHaveText(`Spent today (API keys): $${spent.toFixed(2)} of $15.00`);
    await expect(rowOf(settingsPage, 'claude').locator('[data-assistant-agent-billing]')).toHaveText(
      "Billed to your Claude Code account; Magnusim's $ limits don't apply to it. The limits under Coding agents do.",
      { timeout: 30_000 },
    );
    await expect(pane.locator('[data-assistant-default-option="agent:claude"] [data-assistant-default-billing]')).toHaveText(
      "Billed to your Claude Code account; Magnusim's $ limits don't apply to it.",
    );
  } finally {
    await settingsPage.close();
  }
});
