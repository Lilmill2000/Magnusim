// Coding agents in the desktop app (packaged, desktop/dist/win-unpacked after npm run dist): the
// app's own executable is Electron, not Node, so an agent, its launcher and the MCP bridge run
// on the Node.js found on PATH (scripts/server/assistant/agents/node.ts). Settings' Test starts
// the e2e's stand-in agent (e2e/support/fake-acp.mjs, installed as npm installs one), which calls
// Magnusim's test tool and answers. With no Node.js on PATH the agent's row says what it needs.
// The installed app takes no test switches (MAGNUSIM_PACKAGED), so it finds the stand-in where it
// looks for any agent: the stand-in's npm folder first on PATH, a home and AppData of its own (with
// the login file), so this PC's own agents and sign-ins never come into it. What the test did is
// in the app's server log (<user data>/logs/server.log), as a person reporting a problem has it:
// the Assistant's [assistant] lines, and nothing of the login file or anything shaped like a key.
// SPDX-License-Identifier: GPL-3.0-or-later
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readdirSync } from 'node:fs';
import { _electron as electron, expect, test, type Page } from '../e2e-cad/pw';
// @ts-expect-error plain ESM test support with no types
import { startFakeAcp } from '../e2e/support/fake-acp.mjs';
// @ts-expect-error plain ESM script with no types
import { removeTreeSync } from '../scripts/remove-tree.js';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXE = join(WEB, 'desktop', 'dist', 'win-unpacked', 'Magnusim CAD.exe');
const AGENT = { pkg: '@agentclientprotocol/claude-agent-acp', program: 'claude-agent-acp', version: '0.85.1' };
const OWN_TOOLS_OFF = 'Its own shell, file and web tools are off while it works for Magnusim.';
const NEEDS_NODE = 'Coding agents need Node.js on this PC. Install it from nodejs.org, then start Magnusim CAD again.';
/** The stand-in's login file: fake tokens, which the server's log must never hold (nor any piece shaped like a key). */
const TOKENS = { accessToken: `sk-ant-oat01-${randomBytes(24).toString('hex')}`, refreshToken: `sk-ant-ort01-${randomBytes(24).toString('hex')}` };
const LOGIN = JSON.stringify({ claudeAiOauth: { ...TOKENS, expiresAt: 4102444800000, scopes: ['user:inference'] } });
const KEY_LIKE = /sk-[\w-]{16,}|Bearer\s+\S{12,}|accessToken|refreshToken|claudeAiOauth/i;
/** A line of the log: its time, its level, its text. */
const LOG_LINE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z (info |warn |error|debug) /;

/** The app's server log, in the user data the test gave it ('' while there is none). */
const serverLog = (root: string) => {
  try {
    return readFileSync(join(root, 'user data', 'logs', 'server.log'), 'utf8');
  } catch {
    return '';
  }
};

/** npm's Windows shim for a script in <prefix>/node_modules (what discovery reads, never runs). */
const cmdShim = (rel: string) =>
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

/** PATH without any folder holding node.exe (or not), the rest as it is. */
function pathWith(node: boolean): string {
  return String(process.env.PATH || '')
    .split(delimiter)
    .filter((d) => node || !(d && existsSync(join(d, 'node.exe'))))
    .filter((d) => !/python|windowsapps/i.test(d))
    .join(delimiter);
}

async function launch(root: string, opts: { node: boolean; prefix: string; home: string }) {
  const appData = join(root, 'appdata');
  const localAppData = join(root, 'localappdata');
  mkdirSync(appData, { recursive: true });
  mkdirSync(localAppData, { recursive: true });
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PATH: [opts.prefix, pathWith(opts.node)].join(delimiter),
    USERPROFILE: opts.home,
    HOME: opts.home,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    MAGNUSIM_PROJECTS_ROOT: join(root, 'projects'),
    MAGNUSIM_ASSISTANT_HOME: join(root, 'assistant'),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.MAGNUSIM_LOCAL_JSON;
  for (const k of Object.keys(env)) if (k.startsWith('MAGNUSIM_TEST_')) delete env[k];
  const app = await electron.launch({ executablePath: EXE, args: [`--user-data-dir=${join(root, 'user data')}`], env });
  const page = await app.firstWindow();
  await expect(page).toHaveTitle('Magnusim CAD - Projects', { timeout: 60_000 });
  return { app, page };
}

async function claudeRow(page: Page) {
  await page.locator('#home-prefs').click();
  await page.locator('#wiz-rail li[data-wiz-key="assistant"]').click();
  return page.locator('#setup-wizard [data-assistant-agent="claude"]');
}

test.describe('coding agents in the desktop app', () => {
  test.skip(process.platform !== 'win32' || !existsSync(EXE), 'the packaged Windows app: run npm run dist in desktop/ first');
  let fake: { writeLauncher(file: string, o: { version: string }): string; script(...steps: unknown[]): void; stop(): Promise<void>; events(name: string, pid?: number): unknown[]; pids(role?: string): Array<{ pid: number }> };
  let root: string;
  let prefix: string;
  let home: string;

  test.beforeAll(async () => {
    fake = await startFakeAcp({ style: 'tool_name_meta', agentInfo: { name: 'claude-agent-acp', title: 'Claude Code', version: AGENT.version } });
    root = mkdtempSync(join(tmpdir(), 'magnusim-cad-agents-'));
    prefix = join(root, 'npm');
    home = join(root, 'home');
    const pkgDir = join(prefix, 'node_modules', ...AGENT.pkg.split('/'));
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: AGENT.pkg, version: AGENT.version, bin: { [AGENT.program]: 'dist/index.js' } }));
    fake.writeLauncher(join(pkgDir, 'dist', 'index.js'), { version: AGENT.version });
    writeFileSync(join(prefix, `${AGENT.program}.cmd`), cmdShim(['node_modules', ...AGENT.pkg.split('/'), 'dist', 'index.js'].join('\\')));
    // Signed in: its login file.
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', '.credentials.json'), LOGIN);
  });

  test.afterAll(async () => {
    await fake?.stop();
    if (root) removeTreeSync(root);
  });

  test("Settings' Test starts the agent on Node.js from PATH: it calls Magnusim's test tool and answers", async () => {
    test.setTimeout(180_000);
    const { app, page } = await launch(root, { node: true, prefix, home });
    try {
      const claude = await claudeRow(page);
      await expect(claude).toHaveAttribute('data-assistant-agent-state', 'ready', { timeout: 60_000 });
      await expect(claude.locator('[data-assistant-agent-error]')).toHaveCount(0);
      fake.script({ call: { tool: 'connection_check', args: { word: 'ok' } } }, { say: 'done' });
      await claude.getByRole('button', { name: 'Test' }).click();
      await expect(claude.locator('[data-assistant-agent-result="ok"]')).toHaveText(
        new RegExp(`^Claude Code ${AGENT.version.replace(/\./g, '\\.')} answered in \\d+\\.\\d s and called Magnusim's test tool\\. ${OWN_TOOLS_OFF.replace(/\./g, '\\.')}$`),
        { timeout: 90_000 },
      );
      // The call reached Magnusim through the MCP bridge (also on that Node), and nothing failed.
      const pid = fake.pids('agent').at(-1)!.pid;
      expect(fake.events('mcp_result', pid)).toEqual([expect.objectContaining({ tool: 'connection_check', error: null })]);
      // The server's log has the Assistant's lines for that test (the agent started, its result),
      // each with its time, and nothing of the login file or shaped like a key.
      await expect.poll(() => serverLog(root), { timeout: 15_000 }).toMatch(/^\S+Z info  \[assistant\] agent test \{"agent":"claude","ok":true,/m);
      const log = serverLog(root);
      expect(log).toMatch(/^\S+Z info  \[assistant\] agent started \{/m);
      for (const l of log.split('\n').filter(Boolean)) expect(l).toMatch(LOG_LINE);
      expect(log).not.toContain(LOGIN);
      for (const t of Object.values(TOKENS)) expect(log).not.toContain(t.slice(12));
      expect(log).not.toMatch(KEY_LIKE);
    } finally {
      await app.close();
    }
  });

  test('with no Node.js on PATH, the agent says it needs it, and Test is not offered', async () => {
    test.setTimeout(120_000);
    const { app, page } = await launch(root, { node: false, prefix, home });
    try {
      const claude = await claudeRow(page);
      await expect(claude.locator('[data-assistant-agent-error]')).toHaveText(NEEDS_NODE, { timeout: 60_000 });
      await expect(claude.getByRole('button', { name: 'Test' })).toHaveCount(0);
    } finally {
      await app.close();
    }
  });
});
