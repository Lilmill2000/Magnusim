// Coding agents on this PC (phase 3 spec 4.2, 4.3, 4.9, 5.1-5.4): the catalogue's shapes; the
// search folders; discovery on fake folders (PATH order, .exe before .cmd before .bat, the npm
// package, the cmd-shim line, an extensionless node script, a .bat it can't start, the POSIX
// executable bit and a link into the package); the identity rule (a lookalike earlier in PATH,
// a shim to another package, a package of another name or an older version, a custom command
// with the known name: never tools-off); the version probe (killed at 3 s with what it
// started, given the agent's environment and its own folder); signed in from the login file's
// existence only (never opened, a spy); the fingerprint (path, script and arguments, never the
// version); the agents' settings fields; and the routes: the list, the allow switch (browser
// only, the row's fingerprint, off always taken and stopping the agent first, never a settings
// field), custom agents (browser only, at most 8, removed with their choices), readiness in
// the status (read from the cache: the status never starts a process).
//
// Nothing here reads this PC's real agents, home or temp folder: discovery searches only the
// test's folders (MAGNUSIM_TEST_ASSISTANT_AGENT_PATHS, or the folders a call names) with a test
// home (under which the real environment's agent variables are not read either), and every
// probe's working folder is in the test's own temp folder. The agents are the scripted fake
// (through its launcher) and small scripts; every process is checked by pid. Discovery starts
// only the verified package or an allowed program (a lookalike never runs: report files).
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-assistant-agents-'));
process.env.MAGNUSIM_PROJECTS_ROOT = join(ROOT, 'projects');
process.env.MAGNUSIM_LOCAL_JSON = join(ROOT, 'local.json');
process.env.MAGNUSIM_ASSISTANT_HOME = join(ROOT, 'home');
for (const k of Object.keys(process.env)) if (k.startsWith('MAGNUSIM_TEST_ASSISTANT')) delete process.env[k];
// The agents' own variables of whoever runs the tests never count here.
for (const k of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_HOME', 'XAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'XDG_CONFIG_HOME']) {
  delete process.env[k];
}
process.env.MAGNUSIM_TEST_ASSISTANT = '1';
process.env.MAGNUSIM_TEST_ASSISTANT_PROTECTOR = 'file';
// The routes' discovery: these folders and this home only.
const AGENT_HOME = join(ROOT, 'agent-home');
const PATH_A = join(ROOT, 'path-a');
const PATH_B = join(ROOT, 'path-b');
for (const d of [AGENT_HOME, PATH_A, PATH_B]) mkdirSync(d, { recursive: true });
process.env.MAGNUSIM_TEST_ASSISTANT_AGENT_HOME = AGENT_HOME;
process.env.MAGNUSIM_TEST_ASSISTANT_AGENT_PATHS = [PATH_A, PATH_B].join(delimiter);

const D = await import('../assistant/agents/discover.ts');
const K = await import('../assistant/agents/known.ts');
const S = await import('../assistant/settings.ts');
const { CLAUDE_CODE_SESSION } = await import('../assistant/agents/acp.ts');
const { Router, dispatch } = await import('../router.ts');
const { sendJson } = await import('../http.ts');
const { assistantGuard } = await import('../assistant/access.ts');
const routes = await import('../assistant-routes.ts');
const { registerEventHubRoutes } = await import('../event-hub.ts');
const { relayPage } = await import('./assistant-harness.js');
const { resetAssistantState } = await import('../assistant/state.ts');
const { appVersion } = await import('../assistant/host-tools.ts');
const { startFakeAcp } = await import('../../../e2e/support/fake-acp.mjs');
const { removeTree } = await import('../../remove-tree.js');
const { stopAllAgentProcesses } = await import('../assistant/agents/process.ts');
const { dropWarmKeeper } = await import('../assistant/agents/job-win.ts');
const { killOwn } = await import('./assistant-own-pids.js');

const WIN = process.platform === 'win32';
const LIMIT = { timeout: 120_000 };
const CEILING = 10_000;
/** Every probe's working folder goes here, never the system temp folder. */
const TMP = join(ROOT, 'tmp');
mkdirSync(TMP, { recursive: true });

const fake = await startFakeAcp();
/** Pids a test saw: at the end, each one still running as one of this file's processes is killed. */
const made = new Set();

after(async () => {
  // Any agent process still running (a failed check's), with its tree and its job keeper.
  await stopAllAgentProcesses('test end');
  dropWarmKeeper();
  // Only this file's own (its scripts under ROOT, their helpers): a pid the OS has given to
  // another program since is left alone.
  killOwn([...made], [ROOT, fake.url, 'setInterval(()=>{},1<<30)']);
  await fake.stop();
  resetAssistantState();
  try {
    await removeTree(ROOT);
  } catch {
    /* the OS temp cleaner takes it */
  }
});

// ------------------------------------------------------------------------------------------------
// Fake folders
// ------------------------------------------------------------------------------------------------

/** npm's cmd-shim for a script at `rel` (backslashes) under the shim's folder. */
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

const winRel = (...parts) => parts.join('/').split('/').join('\\');

/** A script that prints `text` and exits (plain, so it runs as CommonJS or ESM). */
function printer(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(`${text}\n`)});\n`);
  if (!WIN) chmodSync(file, 0o755);
  return file;
}

/**
 * An npm prefix as npm makes it on Windows: `<dir>/<program>.cmd` (the shim) and
 * `<dir>/node_modules/<pkg>/package.json` whose bin points at `bin`, with the fake's launcher
 * there (its --version prints `fake-acp-agent <probeVersion>`).
 */
function npmPrefix(dir, { pkg, program, version = '1.0.0', bin = 'dist/index.js', name = pkg, probeVersion = version, shim = true }) {
  const pkgDir = join(dir, 'node_modules', ...pkg.split('/'));
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name, version, bin: { [program]: bin } }));
  const script = join(pkgDir, ...bin.split('/'));
  fake.writeLauncher(script, { version: probeVersion });
  if (!WIN) chmodSync(script, 0o755);
  if (shim) writeFileSync(join(dir, `${program}.cmd`), cmdShim(winRel('node_modules', pkg, bin)));
  return { pkgDir, script };
}

const CLAUDE = { pkg: '@agentclientprotocol/claude-agent-acp', program: 'claude-agent-acp' };

/**
 * A script that appends one line to `report` each time it runs ({name, argv, env names}) and
 * prints `<name> <version>`: a run that never happens leaves no line.
 */
function reporter(file, report, name, version) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      `fs.appendFileSync(${JSON.stringify(report)}, JSON.stringify({ name: ${JSON.stringify(name)}, argv: process.argv.slice(2), env: Object.keys(process.env) }) + '\\n');`,
      `process.stdout.write(${JSON.stringify(`${name} ${version}\n`)});`,
      '',
    ].join('\n'),
  );
  if (!WIN) chmodSync(file, 0o755);
  return file;
}

/** The lines a reporter() wrote ([] when it never ran). */
const runsOf = (report) =>
  existsSync(report)
    ? readFileSync(report, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

let n = 0;
/** A new empty folder under ROOT. */
function folder(name) {
  n += 1;
  const d = join(ROOT, `${name}-${n}`);
  mkdirSync(d, { recursive: true });
  return d;
}

/** Discovery on the given folders and home, as Windows lays them out (files only: works on Linux too). */
const discover = (folders, o = {}) =>
  D.discoverAgents({ platform: 'win32', folders, home: o.home ?? folder('home'), env: o.env ?? {}, custom: o.custom ?? [], settings: S.defaultSettings(), probe: false, tmp: TMP, ...o });
const entry = (d, id) => d.agents.find((a) => a.id === id);

/** The row an entry gives with default settings (a tools-off agent needs no switch). */
async function rowOf(e, settings = S.defaultSettings()) {
  return D.agentRow(e, { settings, mcp: { available: true, reason: null }, appVersion: await appVersion() });
}

function alive(pid) {
  if (!pid) return false;
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      return stat.slice(stat.lastIndexOf(')') + 2)[0] !== 'Z';
    } catch {
      return false;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/** The pids still alive after at most `ms` (polling for their end; nothing is slept for). */
async function stillAlive(pids, ms = CEILING) {
  const end = Date.now() + ms;
  for (;;) {
    const left = pids.filter(alive);
    if (!left.length || Date.now() > end) return left;
    await new Promise((r) => setTimeout(r, 50));
  }
}

// ------------------------------------------------------------------------------------------------
// The catalogue
// ------------------------------------------------------------------------------------------------

describe('the catalogue (spec 4.2)', () => {
  it('each known agent: programs, ACP arguments, package, install line, login, variables, class, modes and tools rule', () => {
    const byId = Object.fromEntries(K.KNOWN_AGENTS.map((a) => [a.id, a]));
    assert.deepEqual(Object.keys(byId), ['claude', 'codex', 'opencode', 'grok', 'gemini']);
    for (const a of K.KNOWN_AGENTS) {
      assert.match(a.id, K.AGENT_ID_RE);
      assert.ok(a.name && a.install && a.programs.length, a.id);
      assert.equal(K.knownAgent(a.id), a);
      // tools_off only with its live check, for its own package.
      if (a.lockdown === 'tools_off') assert.ok(a.checked && a.checked.package === a.npmPackage && a.checked.minVersion, a.id);
      // The deprecated adapter overwrites the lockdown: never a known program.
      assert.ok(!a.programs.includes('claude-code-acp'), a.id);
    }
    assert.deepEqual(
      K.KNOWN_AGENTS.map((a) => [a.id, [...a.programs], [...a.args], a.npmPackage, a.lockdown, a.allowedModes === 'initial' ? 'initial' : [...a.allowedModes], a.ours]),
      [
        ['claude', ['claude-agent-acp'], [], '@agentclientprotocol/claude-agent-acp', 'tools_off', ['default'], 'tool_name_meta'],
        ['codex', ['codex-acp'], [], '@agentclientprotocol/codex-acp', 'none', ['read-only'], 'mcp_call_flag'],
        ['opencode', ['opencode'], ['acp'], 'opencode-ai', 'documented', 'initial', null],
        ['grok', ['grok'], ['--no-auto-update', 'agent', 'stdio'], '@xai-official/grok', 'none', 'initial', null],
        ['gemini', ['gemini'], ['--acp'], '@google/gemini-cli', 'documented', ['default'], null],
      ],
    );
    assert.equal(byId.claude.checked.minVersion, '0.85.1');
    assert.equal(byId.claude.sessionMeta, CLAUDE_CODE_SESSION);
    for (const id of ['codex', 'opencode', 'grok', 'gemini']) assert.equal(byId[id].sessionMeta, null, id);
    assert.deepEqual(
      Object.fromEntries(K.KNOWN_AGENTS.map((a) => [a.id, [[...a.keyVars], [...a.envPrefixes]]])),
      {
        claude: [['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'], ['CLAUDE_', 'ANTHROPIC_']],
        codex: [['OPENAI_API_KEY', 'CODEX_API_KEY'], ['CODEX_', 'OPENAI_']],
        opencode: [[], ['OPENCODE_']],
        grok: [['XAI_API_KEY'], ['XAI_', 'GROK_']],
        gemini: [['GEMINI_API_KEY', 'GOOGLE_API_KEY'], ['GEMINI_', 'GOOGLE_']],
      },
    );
    assert.deepEqual(byId.claude.login, { file: '.claude/.credentials.json', dirVar: 'CLAUDE_CONFIG_DIR', fileInDir: '.credentials.json', keyring: ['darwin'] });
    assert.deepEqual(byId.codex.login, { file: '.codex/auth.json', dirVar: 'CODEX_HOME', fileInDir: 'auth.json', keyring: true });
    assert.deepEqual(byId.grok.startAuth, { methods: ['xai.api_key', 'cached_token'], meta: { headless: true } });
    // The version probe's arguments: Grok Build's never let it update itself.
    assert.deepEqual(
      Object.fromEntries(K.KNOWN_AGENTS.map((a) => [a.id, a.versionArgs && [...a.versionArgs]])),
      { claude: ['--version'], codex: ['--version'], opencode: ['--version'], grok: ['--no-auto-update', '--version'], gemini: ['--version'] },
    );
    assert.equal(K.knownAgent('nope'), null);
    assert.equal(K.knownAgent('constructor'), null);
  });

  it('what each agent gets at a start (env()), its modes, and a custom command’s policy', () => {
    const codex = K.knownAgent('codex').env({});
    assert.equal(codex.INITIAL_AGENT_MODE, 'read-only');
    assert.deepEqual(JSON.parse(codex.CODEX_CONFIG), { web_search: 'disabled', features: { shell_tool: false } });
    assert.equal(codex.DISABLE_MCP_CONFIG_FILTERING, 'true');
    const oc = JSON.parse(K.knownAgent('opencode').env({ defaultAgent: 'mine' }).OPENCODE_CONFIG_CONTENT);
    const P = { bash: 'deny', edit: 'deny', webfetch: 'deny', websearch: 'deny', read: 'deny', glob: 'deny', grep: 'deny', task: 'deny', skill: 'deny', lsp: 'deny', external_directory: 'deny' };
    assert.deepEqual(oc, { permission: P, agent: { build: { permission: P }, plan: { permission: P }, mine: { permission: P } } });
    // A default agent name that isn't a plain name is left out.
    assert.deepEqual(Object.keys(JSON.parse(K.openCodeConfig('x"y')).agent), ['build', 'plan']);
    assert.deepEqual(K.knownAgent('gemini').env({ systemSettingsPath: '/p/s.json' }), { GEMINI_CLI_SYSTEM_SETTINGS_PATH: '/p/s.json' });
    assert.deepEqual(JSON.parse(K.knownAgent('gemini').systemSettings()), { tools: { core: [] }, security: { disableYoloMode: true }, mcp: { allowed: ['magnusim'] } });
    assert.equal(K.modeAllowed(K.knownAgent('claude'), 'default'), true);
    for (const mode of ['plan', 'bypassPermissions', 'dontAsk', 'acceptEdits']) assert.equal(K.modeAllowed(K.knownAgent('claude'), mode), false, mode);
    assert.equal(K.modeAllowed(K.knownAgent('codex'), 'agent'), false);
    assert.equal(K.modeAllowed(K.knownAgent('opencode'), 'build'), false, "'initial': no mode is ever set");
    assert.equal(K.modeAllowed(null, 'default'), false, 'a custom command: none');
    assert.deepEqual({ ...K.CUSTOM_POLICY }, { allowedModes: 'initial', ours: null, sessionMeta: null, startAuth: null });
    assert.equal(K.agentIdOf('agent:claude'), 'claude');
    assert.equal(K.agentIdOf('agent:custom-0a1b2c'), 'custom-0a1b2c');
    for (const bad of ['claude', 'agent:', 'agent:Bad', 'agent:../x', null]) assert.equal(K.agentIdOf(bad), null, String(bad));
  });
});

// ------------------------------------------------------------------------------------------------
// Search folders and the test switches
// ------------------------------------------------------------------------------------------------

describe('search folders (spec 4.3)', () => {
  it('the test switches: exactly their folders and home, only with MAGNUSIM_TEST_ASSISTANT=1 in a test home', () => {
    const a = resolve(ROOT, 'sa');
    const b = resolve(ROOT, 'sb');
    const base = { MAGNUSIM_TEST_ASSISTANT_AGENT_PATHS: [a, 'relative', b, a].join(delimiter), MAGNUSIM_TEST_ASSISTANT_AGENT_HOME: AGENT_HOME };
    const on = D.agentTestSwitches({ ...base, MAGNUSIM_TEST_ASSISTANT: '1', MAGNUSIM_ASSISTANT_HOME: join(ROOT, 'h') });
    assert.deepEqual(on, { paths: [a, b], home: AGENT_HOME, ignored: [] });
    const off = D.agentTestSwitches({ ...base, MAGNUSIM_ASSISTANT_HOME: join(ROOT, 'h') });
    assert.deepEqual([off.paths, off.home], [null, null]);
    assert.equal(off.ignored.length, 2);
    assert.match(off.ignored[0], /without MAGNUSIM_TEST_ASSISTANT=1/);
    const realHome = D.agentTestSwitches({ ...base, MAGNUSIM_TEST_ASSISTANT: '1' });
    assert.deepEqual([realHome.paths, realHome.home], [null, null]);
    assert.match(realHome.ignored[0], /outside a test home/);
    assert.deepEqual(D.agentTestSwitches({}), { paths: null, home: null, ignored: [] });
  });

  it("this PC's folders: PATH first and in order, the npm prefix, the home folders, nvm newest first; absolute only, no duplicates", async () => {
    const home = folder('fhome');
    for (const v of ['v9.0.0', 'v22.12.0', 'v20.1.0']) mkdirSync(join(home, '.nvm', 'versions', 'node', v), { recursive: true });
    const nvm = (v) => join(home, '.nvm', 'versions', 'node', v, 'bin');
    if (WIN) {
      const env = { Path: 'C:\\First;relative\\x;C:\\Second\\;c:\\first', APPDATA: 'C:\\Users\\u\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', NVM_SYMLINK: 'C:\\nvm4w\\nodejs' };
      const list = await D.searchFolders({ env, platform: 'win32', home });
      assert.deepEqual(list, [
        'C:\\First',
        'C:\\Second\\',
        'C:\\Users\\u\\AppData\\Roaming\\npm',
        join(home, '.npm-global', 'bin'),
        join(home, '.local', 'bin'),
        join(home, '.volta', 'bin'),
        join(home, '.bun', 'bin'),
        join(home, '.grok', 'bin'),
        nvm('v22.12.0'),
        nvm('v20.1.0'),
        nvm('v9.0.0'),
        'C:\\nvm4w\\nodejs',
        'C:\\Users\\u\\AppData\\Local\\Volta\\bin',
      ]);
    } else {
      const env = { PATH: '/first:relative/x:/second/:/first', NPM_CONFIG_PREFIX: '/opt/npm' };
      const list = await D.searchFolders({ env, platform: process.platform, home });
      assert.deepEqual(list, [
        '/first',
        '/second/',
        '/opt/npm/bin',
        join(home, '.npm-global', 'bin'),
        join(home, '.local', 'bin'),
        join(home, '.volta', 'bin'),
        join(home, '.bun', 'bin'),
        join(home, '.grok', 'bin'),
        nvm('v22.12.0'),
        nvm('v20.1.0'),
        nvm('v9.0.0'),
        '/opt/homebrew/bin',
        '/usr/local/bin',
        '/usr/bin',
      ]);
    }
  });
});

// ------------------------------------------------------------------------------------------------
// Discovery
// ------------------------------------------------------------------------------------------------

describe('discovery on fake folders (spec 4.3)', () => {
  it('an npm prefix with the known shim and its package: [node, script], verified at the minimum version, tools off; the version from --version', LIMIT, async () => {
    const prefix = folder('prefix');
    const { script } = npmPrefix(prefix, { ...CLAUDE, version: '0.85.1', probeVersion: '0.85.1-probed' });
    const d = await discover([prefix], { probe: true });
    const e = entry(d, 'claude');
    assert.equal(e.found, true);
    assert.equal(e.program, join(prefix, 'claude-agent-acp.cmd'));
    assert.equal(e.script, script);
    assert.deepEqual(e.argv, [process.execPath, script]);
    assert.equal(e.verifiedPackage, true);
    assert.equal(e.lockdown, 'tools_off');
    assert.equal(e.version, '0.85.1-probed', 'asked with --version');
    const row = await rowOf(e);
    assert.equal(row.needs_allow, false);
    assert.equal(row.own_tools, 'off');
    // The others are missing, with their install lines.
    for (const id of ['codex', 'opencode', 'grok', 'gemini']) {
      const m = await rowOf(entry(d, id));
      assert.equal(m.found, false, id);
      assert.equal(m.install, K.knownAgent(id).install, id);
      assert.equal(m.reason, 'agent_missing', id);
    }
    // No probe left a working folder behind.
    assert.deepEqual(readdirSync(TMP).filter((x) => x.startsWith('magnusim-agent-')), []);
  });

  it('npm’s cmd-shim line without the package, an extensionless node script, an .exe target, and a .bat it can’t start', async () => {
    const dir = folder('mixed');
    // codex-acp.cmd: no @agentclientprotocol/codex-acp package; the shim line points into node_modules.
    const fork = printer(join(dir, 'node_modules', 'some-fork', 'bin', 'codex.js'), 'codex-acp 2.1.1');
    writeFileSync(join(dir, 'node_modules', 'some-fork', 'package.json'), JSON.stringify({ name: 'some-fork', version: '1.0.0' }));
    writeFileSync(join(dir, 'codex-acp.cmd'), cmdShim(winRel('node_modules', 'some-fork', 'bin', 'codex.js')));
    // grok.cmd: its package's bin is an extensionless #!/usr/bin/env node script.
    const grokPkg = join(dir, 'node_modules', '@xai-official', 'grok');
    mkdirSync(join(grokPkg, 'bin'), { recursive: true });
    writeFileSync(join(grokPkg, 'package.json'), JSON.stringify({ name: '@xai-official/grok', version: '1.0.49', bin: { grok: 'bin/grok' } }));
    printer(join(grokPkg, 'bin', 'grok'), 'grok 1.0.49');
    writeFileSync(join(dir, 'grok.cmd'), cmdShim(winRel('node_modules', '@xai-official', 'grok', 'bin', 'grok')));
    // opencode.cmd: its package's bin is a native program.
    const ocPkg = join(dir, 'node_modules', 'opencode-ai');
    mkdirSync(join(ocPkg, 'bin'), { recursive: true });
    writeFileSync(join(ocPkg, 'package.json'), JSON.stringify({ name: 'opencode-ai', version: '1.18.34', bin: { opencode: 'bin/opencode.exe' } }));
    writeFileSync(join(ocPkg, 'bin', 'opencode.exe'), 'MZ');
    writeFileSync(join(dir, 'opencode.cmd'), cmdShim(winRel('node_modules', 'opencode-ai', 'bin', 'opencode.exe')));
    // gemini.bat: no package, nothing a shim line names.
    writeFileSync(join(dir, 'gemini.bat'), '@echo off\r\ngemini-real.exe %*\r\n');
    // A shim line that climbs out of node_modules is no shim line.
    const outside = folder('outside');
    printer(join(outside, 'escape.js'), 'escape 1.0.0');
    mkdirSync(join(outside, 'node_modules'));
    writeFileSync(join(outside, 'claude-agent-acp.cmd'), cmdShim(winRel('node_modules', '..', 'escape.js')));

    // The person's default OpenCode agent (its permissions are overridden too, at a start).
    const ocHome = folder('oc-home');
    mkdirSync(join(ocHome, '.config', 'opencode'), { recursive: true });
    writeFileSync(join(ocHome, '.config', 'opencode', 'opencode.json'), '{\n  "default_agent": "reviewer"\n}\n');
    const d = await discover([dir], { home: ocHome });
    const codex = entry(d, 'codex');
    assert.deepEqual(codex.argv, [process.execPath, fork]);
    assert.equal(codex.verifiedPackage, false);
    assert.equal(codex.lockdown, 'none');
    const grok = entry(d, 'grok');
    assert.deepEqual(grok.argv, [process.execPath, join(grokPkg, 'bin', 'grok'), '--no-auto-update', 'agent', 'stdio']);
    assert.equal(grok.verifiedPackage, true, 'its own package (no live check to meet)');
    assert.equal(grok.lockdown, 'none', 'its class is none whatever the package');
    const oc = entry(d, 'opencode');
    assert.deepEqual(oc.argv, [join(ocPkg, 'bin', 'opencode.exe'), 'acp']);
    assert.equal(oc.lockdown, 'documented');
    assert.equal(oc.defaultAgent, 'reviewer');
    assert.equal((await rowOf(oc)).needs_allow, true, 'documented, not yet checked: the switch');
    const climbed = entry(await discover([outside]), 'claude');
    assert.deepEqual([climbed.found, climbed.argv, climbed.error?.code], [true, null, 'cant_start_script']);
    // A shim line to something that is neither a node script nor an .exe.
    const sh = folder('sh');
    mkdirSync(join(sh, 'node_modules', 'gem'), { recursive: true });
    writeFileSync(join(sh, 'node_modules', 'gem', 'run.sh'), '#!/bin/sh\necho 1\n');
    writeFileSync(join(sh, 'gemini.cmd'), cmdShim(winRel('node_modules', 'gem', 'run.sh')));
    const shell = entry(await discover([sh]), 'gemini');
    assert.deepEqual([shell.argv, shell.error?.code, shell.script], [null, 'cant_start_script', join(sh, 'node_modules', 'gem', 'run.sh')]);
    const gemini = entry(d, 'gemini');
    assert.equal(gemini.found, true);
    assert.equal(gemini.argv, null);
    assert.deepEqual(gemini.error.code, 'cant_start_script');
    assert.match(gemini.error.message, /without a command shell, so it can't start gemini\.bat/);
    const row = await rowOf(gemini);
    assert.equal(row.reason, 'cant_start_script');
    assert.equal(row.program, join(dir, 'gemini.bat'), 'the row shows the program');
  });

  it('PATH order, and the identity rule: only the verified package at its minimum version is tools-off', async () => {
    const verified = folder('verified');
    npmPrefix(verified, { ...CLAUDE, version: '0.85.1' });
    const claudeOf = async (folders, custom = []) => entry(await discover(folders, { custom }), 'claude');

    // Control: the verified package alone.
    assert.equal((await claudeOf([verified])).lockdown, 'tools_off');

    // A lookalike .exe in an earlier folder wins the lookup, and is never tools-off.
    const planted = folder('planted');
    writeFileSync(join(planted, 'claude-agent-acp.exe'), 'MZ');
    const e1 = await claudeOf([planted, verified]);
    assert.equal(e1.program, join(planted, 'claude-agent-acp.exe'));
    assert.deepEqual(e1.argv, [join(planted, 'claude-agent-acp.exe')]);
    assert.equal(e1.verifiedPackage, false);
    assert.equal(e1.lockdown, 'none');
    const r1 = await rowOf(e1);
    assert.deepEqual([r1.needs_allow, r1.own_tools, r1.reason], [true, 'on', 'agent_not_allowed']);
    // In one folder: .exe before .cmd.
    const both = folder('both');
    npmPrefix(both, { ...CLAUDE, version: '0.85.1' });
    writeFileSync(join(both, 'claude-agent-acp.exe'), 'MZ');
    assert.equal((await claudeOf([both])).program, join(both, 'claude-agent-acp.exe'));

    // A shim pointing at another package's script.
    const other = folder('other');
    printer(join(other, 'node_modules', 'other', 'x.js'), 'x 1.0.0');
    writeFileSync(join(other, 'claude-agent-acp.cmd'), cmdShim(winRel('node_modules', 'other', 'x.js')));
    const e2 = await claudeOf([other]);
    assert.deepEqual(e2.argv, [process.execPath, join(other, 'node_modules', 'other', 'x.js')]);
    assert.equal(e2.lockdown, 'none');

    // The package folder holds a package of another name.
    const renamed = folder('renamed');
    npmPrefix(renamed, { ...CLAUDE, version: '0.85.1', name: 'not-the-adapter' });
    const e3 = await claudeOf([renamed]);
    assert.equal(e3.found, true);
    assert.equal(e3.verifiedPackage, false);
    assert.equal(e3.lockdown, 'none');

    // The package's bin points outside the package.
    const escaping = folder('escaping');
    const esc = npmPrefix(escaping, { ...CLAUDE, version: '0.85.1', bin: '../escape.js' });
    assert.ok(existsSync(esc.script), 'the escaping script exists');
    const e6 = await claudeOf([escaping]);
    assert.equal(e6.verifiedPackage, false);
    assert.equal(e6.lockdown, 'none');

    // A version below the minimum.
    const old = folder('old');
    npmPrefix(old, { ...CLAUDE, version: '0.85.0' });
    const e4 = await claudeOf([old]);
    assert.equal(e4.verifiedPackage, false);
    assert.equal(e4.lockdown, 'none');
    assert.equal(e4.version, '0.85.0');

    // A custom command named like the known program: a custom command, class none.
    const named = join(planted, 'claude-agent-acp.exe');
    const d5 = await discover([verified], { custom: [{ id: 'custom-0a0b0c', name: 'Mine', argv: [named, '--acp'], keep_env: [] }] });
    const c5 = entry(d5, 'custom-0a0b0c');
    assert.equal(c5.kind, 'custom');
    assert.deepEqual(c5.argv, [named, '--acp']);
    assert.equal(c5.lockdown, 'none');
    assert.equal((await rowOf(c5)).needs_allow, true);
  });

  it('discovery starts only the verified package or an allowed program, with no key, login-folder or agent variable; never a lookalike', LIMIT, async () => {
    const report = join(folder('reports'), 'runs.jsonl');
    const verified = folder('pverified');
    const { script } = npmPrefix(verified, { ...CLAUDE, version: '0.85.1' });
    reporter(script, report, 'adapter', '0.85.1-probed');
    // A lookalike shim in an earlier folder, to another package's script.
    const planted = folder('pplanted');
    reporter(join(planted, 'node_modules', 'evil', 'x.js'), report, 'lookalike', '6.6.6');
    writeFileSync(join(planted, 'claude-agent-acp.cmd'), cmdShim(winRel('node_modules', 'evil', 'x.js')));
    const env = { ANTHROPIC_API_KEY: 'sk-test-owner-key', CLAUDE_CODE_OAUTH_TOKEN: 'owner-oauth', CLAUDE_CONFIG_DIR: folder('cfgdir'), CLAUDE_EXTRA: 'own prefix', HTTPS_PROXY: 'http://proxy.invalid:1' };

    const lookalike = entry(await discover([planted, verified], { probe: true, refresh: true, env }), 'claude');
    assert.equal(lookalike.verifiedPackage, false);
    assert.equal(lookalike.version, null, 'not asked');
    assert.deepEqual(runsOf(report), [], 'the lookalike never ran');

    const own = entry(await discover([verified], { probe: true, refresh: true, env }), 'claude');
    assert.equal(own.version, '0.85.1-probed');
    const [run] = runsOf(report);
    assert.equal(run.name, 'adapter');
    assert.deepEqual(run.argv, ['--version']);
    const has = (name) => run.env.some((k) => k.toUpperCase() === name);
    for (const name of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR', 'CLAUDE_EXTRA']) assert.ok(!has(name), `${name} never reaches a version probe`);
    assert.ok(has('HTTPS_PROXY') && has('PATH'), 'the system part of the allowlist does');

    // Allowed for that very program (its fingerprint): asked.
    const s = S.defaultSettings();
    s.agents.claude = { model: null, mode: null, allowed: { fingerprint: lookalike.fingerprint, at: 'now' }, lockdown_failed: null };
    const allowed = entry(await discover([planted, verified], { probe: true, refresh: true, env, settings: s }), 'claude');
    assert.equal(allowed.version, '6.6.6');
    assert.deepEqual(runsOf(report).map((r) => r.name), ['adapter', 'lookalike']);
    // Allowed for another program: not asked.
    s.agents.claude.allowed.fingerprint = 'd'.repeat(64);
    assert.equal(entry(await discover([planted, verified], { probe: true, refresh: true, env, settings: s }), 'claude').version, null);
    assert.equal(runsOf(report).length, 2);

    // Grok Build's own package: asked with --no-auto-update.
    const grokDir = folder('pgrok');
    const grok = npmPrefix(grokDir, { pkg: '@xai-official/grok', program: 'grok', version: '1.0.49', bin: 'bin/grok.js' });
    reporter(grok.script, report, 'grok', '1.0.49');
    assert.equal(entry(await discover([grokDir], { probe: true, refresh: true }), 'grok').version, '1.0.49');
    assert.deepEqual(runsOf(report).at(-1).argv, ['--no-auto-update', '--version']);
  });

  it('under the test home switch the real environment’s agent variables are not read: the test home is the only place looked at', async () => {
    const dir = folder('envscrub');
    printer(join(dir, 'node_modules', 'codex-fork', 'bin', 'codex.js'), 'codex-acp 2.1.1');
    writeFileSync(join(dir, 'codex-acp.cmd'), cmdShim(winRel('node_modules', 'codex-fork', 'bin', 'codex.js')));
    npmPrefix(dir, { pkg: 'opencode-ai', program: 'opencode', version: '1.18.34', bin: 'bin/oc.js' });
    const codexHome = folder('real-codex-home');
    writeFileSync(join(codexHome, 'auth.json'), '{}');
    const xdg = folder('real-xdg');
    mkdirSync(join(xdg, 'opencode'));
    writeFileSync(join(xdg, 'opencode', 'opencode.json'), '{"default_agent": "leaked"}');
    const real = { CODEX_HOME: codexHome, XDG_CONFIG_HOME: xdg, OPENAI_API_KEY: 'sk-real-owner-key' };
    const scrubbed = D.testHomeEnv({ ...real, PATH: '/bin', CLAUDE_CONFIG_DIR: '/c', ANTHROPIC_BASE_URL: 'x', GROK_X: 'y', HOME: '/h' });
    assert.deepEqual(scrubbed, { PATH: '/bin', HOME: '/h' });
    // No env given: the switches' home (AGENT_HOME, with no login of these) and the real environment without them.
    const look = () => D.discoverAgents({ platform: 'win32', folders: [dir], custom: [], settings: S.defaultSettings(), probe: false, tmp: TMP });
    Object.assign(process.env, real);
    let d;
    try {
      d = await look();
    } finally {
      for (const k of Object.keys(real)) delete process.env[k];
    }
    assert.deepEqual([entry(d, 'codex').signedIn, entry(d, 'codex').keyVar], ['unknown', null], 'neither CODEX_HOME’s file nor the key counted');
    assert.equal(entry(d, 'opencode').defaultAgent, null, 'XDG_CONFIG_HOME not read');
    // Control: the same variables given to discovery are read.
    const given = await D.discoverAgents({ platform: 'win32', folders: [dir], home: AGENT_HOME, env: real, custom: [], settings: S.defaultSettings(), probe: false, tmp: TMP });
    assert.equal(entry(given, 'codex').signedIn, 'yes');
    assert.equal(entry(given, 'opencode').defaultAgent, 'leaked');
  });

  it('POSIX: a custom command by its full path must be executable, or a node script', { skip: WIN && 'POSIX executable bits' }, async () => {
    const dir = folder('pcustom');
    writeFileSync(join(dir, 'data.txt'), 'not a program\n');
    chmodSync(join(dir, 'data.txt'), 0o644);
    writeFileSync(join(dir, 'tool'), '#!/bin/sh\necho 1\n');
    chmodSync(join(dir, 'tool'), 0o755);
    printer(join(dir, 'agent.js'), 'agent 1.0.0');
    chmodSync(join(dir, 'agent.js'), 0o644);
    const custom = [
      { id: 'custom-0d0d01', name: 'Data', argv: [join(dir, 'data.txt'), '--acp'], keep_env: [] },
      { id: 'custom-0d0d02', name: 'Tool', argv: [join(dir, 'tool'), '--acp'], keep_env: [] },
      { id: 'custom-0d0d03', name: 'Script', argv: [join(dir, 'agent.js')], keep_env: [] },
    ];
    const d = await D.discoverAgents({ platform: process.platform, folders: [], home: folder('home'), env: {}, custom, settings: S.defaultSettings(), probe: false, tmp: TMP });
    const data = entry(d, 'custom-0d0d01');
    assert.deepEqual([data.found, data.argv, data.error?.code], [false, null, 'bad_command']);
    assert.match(data.error.message, /isn't marked as a program/);
    assert.equal((await rowOf(data)).reason, 'bad_command');
    assert.deepEqual(entry(d, 'custom-0d0d02').argv, [join(dir, 'tool'), '--acp']);
    assert.deepEqual(entry(d, 'custom-0d0d03').argv, [process.execPath, join(dir, 'agent.js')]);
  });

  it('a custom command: found on PATH or by its full path, never relative, and a .bat it can’t start', async () => {
    const dir = folder('custom');
    printer(join(dir, 'node_modules', 'mine', 'agent.js'), 'mine 3.0.0');
    writeFileSync(join(dir, 'my-agent.cmd'), cmdShim(winRel('node_modules', 'mine', 'agent.js')));
    writeFileSync(join(dir, 'bare.bat'), '@echo off\r\nreal.exe %*\r\n');
    const custom = [
      { id: 'custom-000001', name: 'On PATH', argv: ['my-agent', '--stdio'], keep_env: [] },
      { id: 'custom-000002', name: 'Bat', argv: [join(dir, 'bare.bat')], keep_env: [] },
      { id: 'custom-000003', name: 'Relative', argv: ['sub\\x.exe'], keep_env: [] },
      { id: 'custom-000004', name: 'Missing', argv: ['nowhere-agent'], keep_env: [] },
    ];
    const d = await discover([dir], { custom });
    assert.deepEqual(entry(d, 'custom-000001').argv, [process.execPath, join(dir, 'node_modules', 'mine', 'agent.js'), '--stdio']);
    assert.equal(entry(d, 'custom-000002').error.code, 'cant_start_script');
    assert.equal(entry(d, 'custom-000003').error.code, 'bad_command');
    assert.equal(entry(d, 'custom-000004').found, false);
    assert.equal((await rowOf(entry(d, 'custom-000004'))).reason, 'agent_missing');
    for (const c of custom) assert.equal(entry(d, c.id).signedIn, 'unknown', 'Magnusim can’t tell where a custom agent signs in');
  });

  it('POSIX: only an executable counts, and only a link into the package is the verified package', { skip: WIN && 'POSIX executables and links' }, async () => {
    // npm's global layout: <prefix>/bin/<program> -> ../lib/node_modules/<pkg>/<bin>.
    const prefix = folder('posix');
    const pkgDir = join(prefix, 'lib', 'node_modules', ...CLAUDE.pkg.split('/'));
    mkdirSync(join(pkgDir, 'dist'), { recursive: true });
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: CLAUDE.pkg, version: '0.85.1', bin: { [CLAUDE.program]: 'dist/index.js' } }));
    const script = join(pkgDir, 'dist', 'index.js');
    fake.writeLauncher(script, { version: '0.85.1' });
    chmodSync(script, 0o755);
    mkdirSync(join(prefix, 'bin'));
    symlinkSync(join('..', 'lib', 'node_modules', '@agentclientprotocol', 'claude-agent-acp', 'dist', 'index.js'), join(prefix, 'bin', CLAUDE.program));
    const posix = (folders) => D.discoverAgents({ platform: process.platform, folders, home: folder('home'), env: {}, custom: [], probe: false, tmp: TMP });
    const linked = entry(await posix([join(prefix, 'bin')]), 'claude');
    assert.deepEqual(linked.argv, [process.execPath, script]);
    assert.equal(linked.verifiedPackage, true);
    assert.equal(linked.lockdown, 'tools_off');
    // A copy of the same script (not a link into the package): found, never tools-off.
    const copyDir = folder('copy');
    copyFileSync(script, join(copyDir, CLAUDE.program));
    chmodSync(join(copyDir, CLAUDE.program), 0o755);
    const copied = entry(await posix([copyDir]), 'claude');
    assert.deepEqual(copied.argv, [process.execPath, join(copyDir, CLAUDE.program)]);
    assert.equal(copied.lockdown, 'none');
    // Not executable: not found there; the next folder's is.
    const plain = folder('plain');
    writeFileSync(join(plain, CLAUDE.program), '#!/usr/bin/env node\n');
    chmodSync(join(plain, CLAUDE.program), 0o644);
    assert.equal(entry(await posix([plain]), 'claude').found, false);
    assert.equal(entry(await posix([plain, join(prefix, 'bin')]), 'claude').program, join(prefix, 'bin', CLAUDE.program));
  });
});

// ------------------------------------------------------------------------------------------------
// The version probe
// ------------------------------------------------------------------------------------------------

describe('the version probe (spec 4.3)', () => {
  it('the version is the first word starting with a digit, at most 40 characters', () => {
    assert.equal(D.versionOf('fake-acp-agent 1.0.0\n'), '1.0.0');
    assert.equal(D.versionOf('codex-acp 2.1.1 (abc)'), '2.1.1');
    assert.equal(D.versionOf('0.85.1'), '0.85.1');
    assert.equal(D.versionOf('v1.2.3'), null);
    assert.equal(D.versionOf(''), null);
    assert.equal(D.versionOf(`x ${'9'.repeat(60)}`).length, 40);
    assert.equal(D.compareVersions('0.85.1', '0.85.1'), 0);
    assert.equal(D.compareVersions('0.85.10', '0.85.9'), 1);
    assert.equal(D.compareVersions('0.85.1-beta.1', '0.85.1'), -1);
    assert.equal(D.compareVersions('1.0', '0.99.99'), 1);
  });

  it('a --version that never answers is tree-killed at 3 s with what it started, gets the agent’s environment and its own folder, and reads null', LIMIT, async () => {
    const dir = folder('hang');
    const report = join(dir, 'report.json');
    // It starts a helper that ignores SIGTERM, reports, and never ends (nor does it end on SIGTERM).
    const script = join(dir, 'hang.cjs');
    writeFileSync(
      script,
      [
        "const { spawn } = require('node:child_process');",
        "const fs = require('node:fs');",
        "process.on('SIGTERM', () => {});",
        "const helper = spawn(process.execPath, ['-e', \"process.on('SIGTERM',()=>{});setInterval(()=>{},1<<30)\"], { stdio: 'ignore', windowsHide: true });",
        `fs.writeFileSync(${JSON.stringify(report)}, JSON.stringify({ pid: process.pid, helper: helper.pid, cwd: process.cwd(), env: Object.keys(process.env) }));`,
        'setInterval(() => {}, 1 << 30);',
        '',
      ].join('\n'),
    );
    const baseEnv = {
      ...process.env,
      ANTHROPIC_API_KEY: 'test-own-key',
      CLAUDE_EXTRA: 'own prefix',
      OPENAI_API_KEY: 'test-other-vendor',
      MAGNUSIM_TEST_SECRET: 'never',
      npm_config_cache: 'never',
      HTTPS_PROXY: 'http://proxy.invalid:1',
    };
    // Monotonic: a wall clock can step back (WSL resyncs its clock under load).
    const t0 = performance.now();
    const v = await D.probeVersion([process.execPath, script, '--version'], {
      env: { keyVars: ['ANTHROPIC_API_KEY'], envPrefixes: ['CLAUDE_', 'ANTHROPIC_'], searchFolders: [] },
      label: 'hang --version',
      baseEnv,
      tmp: TMP,
    });
    const took = performance.now() - t0;
    assert.equal(v, null);
    assert.ok(took >= D.PROBE_MS - 100, `it waited for the limit (${took} ms)`);
    // The limit, then the stop's two graces at most (a slow runner gets the ceiling on top).
    assert.ok(took < D.PROBE_MS + 2 * 1_200 + CEILING, `it stopped at the limit (${took} ms)`);
    assert.ok(existsSync(report), 'the probe ran');
    const r = JSON.parse(readFileSync(report, 'utf8'));
    made.add(r.pid);
    made.add(r.helper);
    assert.deepEqual(await stillAlive([r.pid, r.helper]), [], 'the probe and what it started are gone');
    // Its own private folder in the given temp folder, not Magnusim's.
    assert.notEqual(resolve(r.cwd), resolve(process.cwd()));
    assert.ok(resolve(r.cwd).toLowerCase().includes('magnusim-agent-'), r.cwd);
    // The agent's environment: its own key and prefix and the proxy pass; nothing else of the person's.
    const has = (name) => r.env.some((k) => k.toUpperCase() === name.toUpperCase());
    for (const name of ['ANTHROPIC_API_KEY', 'CLAUDE_EXTRA', 'HTTPS_PROXY', 'PATH']) assert.ok(has(name), name);
    for (const name of ['OPENAI_API_KEY', 'MAGNUSIM_TEST_SECRET', 'npm_config_cache', 'MAGNUSIM_ASSISTANT_HOME']) assert.ok(!has(name), name);
  });
});

// ------------------------------------------------------------------------------------------------
// Signed in
// ------------------------------------------------------------------------------------------------

/** Records every path fs opens or reads (fs and fs/promises, for ESM importers too). */
function spyFsReads() {
  const require = createRequire(import.meta.url);
  const fs = require('node:fs');
  const fsp = require('node:fs/promises');
  const paths = [];
  const saved = [];
  const wrap = (obj, name) => {
    const real = obj[name];
    saved.push([obj, name, real]);
    obj[name] = function (p, ...rest) {
      paths.push(String(p && typeof p === 'object' && 'href' in p ? p.pathname : p));
      return real.call(this, p, ...rest);
    };
  };
  for (const name of ['open', 'openSync', 'readFile', 'readFileSync', 'createReadStream']) wrap(fs, name);
  for (const name of ['open', 'readFile']) wrap(fsp, name);
  syncBuiltinESMExports();
  return {
    paths,
    restore() {
      for (const [obj, name, real] of saved) obj[name] = real;
      syncBuiltinESMExports();
    },
  };
}

describe('signed in: only whether the login file exists (spec 4.3)', () => {
  it('a login file it can’t read still reads signed in, and discovery never opens or reads it (a spy)', async () => {
    const home = folder('login-home');
    const file = join(home, '.claude', '.credentials.json');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '{"token":"never-read"}');
    // POSIX: no read permission at all. (Windows: a deny ACL needs icacls, which this test does not
    // run; the spy below is the check there.)
    if (!WIN) chmodSync(file, 0o000);
    const prefix = folder('login-prefix');
    npmPrefix(prefix, { ...CLAUDE, version: '0.85.1' });
    const spy = spyFsReads();
    let d;
    try {
      d = await discover([prefix], { home });
    } finally {
      spy.restore();
      if (!WIN) chmodSync(file, 0o600);
    }
    assert.equal(entry(d, 'claude').signedIn, 'yes');
    // The spy sees discovery's own reads (its package.json)...
    assert.ok(spy.paths.some((p) => p.endsWith('package.json')), 'the spy sees discovery read');
    // ...and never the login file, nor anything in its folder.
    const loginDir = resolve(dirname(file)).toLowerCase();
    assert.deepEqual(spy.paths.filter((p) => resolve(p).toLowerCase().startsWith(loginDir)), []);
  });

  it('else a key variable gives key, neither gives no; the folder variable moves the file; a keyring login is unknown', async () => {
    const claude = K.knownAgent('claude');
    const codex = K.knownAgent('codex');
    const home = folder('lhome');
    const state = (agent, env, platform = 'linux') => D.loginState(agent.login, agent.keyVars, { home, env, platform });
    assert.deepEqual(await state(claude, {}), { signed_in: 'no', key_var: null });
    assert.deepEqual(await state(claude, { CLAUDE_CODE_OAUTH_TOKEN: 'x' }), { signed_in: 'key', key_var: 'CLAUDE_CODE_OAUTH_TOKEN' });
    assert.deepEqual(await state(claude, { ANTHROPIC_API_KEY: '  ' }), { signed_in: 'no', key_var: null }, 'an empty variable is no key');
    // CLAUDE_CONFIG_DIR: the file in that folder, and only there.
    const cfg = folder('cfg');
    writeFileSync(join(cfg, '.credentials.json'), 'x');
    assert.equal((await state(claude, { CLAUDE_CONFIG_DIR: cfg })).signed_in, 'yes');
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', '.credentials.json'), 'x');
    assert.equal((await state(claude, {})).signed_in, 'yes');
    assert.equal((await state(claude, { CLAUDE_CONFIG_DIR: folder('empty') })).signed_in, 'no', 'the variable moved the folder');
    // A login that may be in a keyring: unknown (Codex always; Claude Code on macOS).
    assert.deepEqual(await state(codex, {}), { signed_in: 'unknown', key_var: null });
    assert.equal((await state(codex, { CODEX_API_KEY: 'k' })).signed_in, 'key');
    assert.equal((await D.loginState(claude.login, claude.keyVars, { home: folder('mac'), env: {}, platform: 'darwin' })).signed_in, 'unknown');
    // No known file: unknown.
    assert.equal((await D.loginState(undefined, [], { home, env: {} })).signed_in, 'unknown');
  });
});

// ------------------------------------------------------------------------------------------------
// The fingerprint
// ------------------------------------------------------------------------------------------------

describe('the fingerprint (spec 4.3)', () => {
  it('changes with the program, the script and the arguments, never with the version', async () => {
    const fp = (o = {}) => D.agentFingerprint(o.kind ?? 'known', o.id ?? 'claude', o.program ?? '/a/p', o.script === undefined ? '/a/s.js' : o.script, o.args ?? [], o.platform ?? 'linux');
    const base = fp();
    assert.match(base, /^[0-9a-f]{64}$/);
    assert.equal(fp(), base);
    for (const o of [{ program: '/b/p' }, { script: '/a/t.js' }, { script: null }, { args: ['--x'] }, { kind: 'custom' }, { id: 'codex' }]) assert.notEqual(fp(o), base, JSON.stringify(o));
    assert.equal(fp({ program: 'C:\\A\\P', platform: 'win32' }), fp({ program: 'c:\\a\\p', platform: 'win32' }), 'Windows paths compare without case');
    assert.notEqual(fp({ program: '/A/P' }), fp({ program: '/a/p' }));

    // Through discovery: a new version in place keeps it; a moved program changes it.
    const prefix = folder('fp');
    const { pkgDir } = npmPrefix(prefix, { ...CLAUDE, version: '0.85.1' });
    const before = entry(await discover([prefix]), 'claude');
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: CLAUDE.pkg, version: '0.90.0', bin: { [CLAUDE.program]: 'dist/index.js' } }));
    const updated = entry(await discover([prefix]), 'claude');
    assert.equal(updated.version, '0.90.0');
    assert.equal(updated.fingerprint, before.fingerprint, 'an update in place keeps the switch');
    const moved = folder('fp-moved');
    cpSync(prefix, moved, { recursive: true });
    assert.notEqual(entry(await discover([moved]), 'claude').fingerprint, before.fingerprint);
    // A custom command's arguments are in it.
    const exe = join(folder('fp-exe'), 'tool.exe');
    writeFileSync(exe, 'MZ');
    const custom = (args) => discover([], { custom: [{ id: 'custom-0f0f0f', name: 'T', argv: [exe, ...args], keep_env: [] }] }).then((d) => entry(d, 'custom-0f0f0f').fingerprint);
    assert.notEqual(await custom(['--acp']), await custom(['--acp', '--yolo']));
    assert.equal(await custom(['--acp']), await custom(['--acp']));
  });
});

// ------------------------------------------------------------------------------------------------
// Rows
// ------------------------------------------------------------------------------------------------

describe('rows and when an agent may start (spec 4.9, 4.13, 5.4)', () => {
  it('a fired lockdown tripwire needs the switch until the next update; readiness follows the spec’s order', async () => {
    const prefix = folder('rows');
    npmPrefix(prefix, { ...CLAUDE, version: '0.85.1' });
    const home = folder('rows-home');
    const e = entry(await discover([prefix], { home }), 'claude');
    const version = await appVersion();
    const s = S.defaultSettings();
    s.agents.claude = { model: null, mode: null, allowed: null, lockdown_failed: { version, at: 'x' } };
    const tripped = await rowOf(e, s);
    assert.deepEqual([tripped.lockdown, tripped.needs_allow, tripped.reason], ['none', true, 'agent_not_allowed']);
    s.agents.claude.lockdown_failed.version = `${version}-older`;
    assert.equal((await rowOf(e, s)).lockdown, 'tools_off', 'another Magnusim version: the lockdown holds again');
    // Signed out (no file, no key, no keyring), then the connection's package missing.
    const out = await rowOf(e);
    assert.equal(out.signed_in, 'no');
    assert.equal(out.reason, 'agent_signed_out');
    const signedIn = { ...e, signedIn: 'yes' };
    const noMcp = D.agentRow(signedIn, { settings: S.defaultSettings(), mcp: { available: false, reason: 'deps_missing' }, appVersion: version });
    assert.equal(noMcp.reason, 'mcp_unavailable');
    assert.equal((await rowOf(signedIn)).ready, true);
  });

  it('a program whose tools stay on needs its switch for everything; only a documented lockdown’s verified package may connect and sign in without it', async () => {
    const PURPOSES = ['connect', 'sign_in', 'test', 'turn'];
    const row = (o) => ({ id: 'x', name: 'X', kind: 'known', found: true, verified_package: false, lockdown: 'none', needs_allow: true, allowed: false, allow_changed: false, reason: null, error: null, ...o });
    const refused = (r, purpose) => D.agentStartRefusal(r, purpose)?.code ?? null;
    const custom = row({ kind: 'custom' });
    for (const p of PURPOSES) assert.equal(refused(custom, p), 'agent_not_allowed', `custom ${p}`);
    const documented = row({ verified_package: true, lockdown: 'documented' });
    assert.deepEqual(PURPOSES.map((p) => refused(documented, p)), [null, null, 'agent_not_allowed', 'agent_not_allowed']);
    // Class none on its own package (an agent whose tools can't be switched off, a fired tripwire): the switch for everything.
    const classNone = row({ verified_package: true, lockdown: 'none' });
    assert.deepEqual(PURPOSES.map((p) => refused(classNone, p)), PURPOSES.map(() => 'agent_not_allowed'));
    const shimmed = row({ verified_package: false });
    assert.equal(refused(shimmed, 'connect'), 'agent_not_allowed');
    const toolsOff = row({ verified_package: true, lockdown: 'tools_off', needs_allow: false });
    for (const p of PURPOSES) assert.equal(refused(toolsOff, p), null, p);
    assert.equal(refused(row({ kind: 'custom', allowed: true }), 'turn'), null);
    assert.equal(refused(row({ kind: 'custom', allow_changed: true }), 'connect'), 'agent_allow_changed');
    assert.equal(refused(row({ found: false }), 'connect'), 'agent_missing');

    // Through discovery: each known agent's own package.
    const dir = folder('start');
    npmPrefix(dir, { pkg: '@agentclientprotocol/codex-acp', program: 'codex-acp', version: '2.1.1' });
    npmPrefix(dir, { pkg: '@xai-official/grok', program: 'grok', version: '1.0.49', bin: 'bin/grok.js' });
    npmPrefix(dir, { pkg: 'opencode-ai', program: 'opencode', version: '1.18.34', bin: 'bin/oc.js' });
    npmPrefix(dir, { ...CLAUDE, version: '0.85.1' });
    writeFileSync(join(dir, 'gemini.bat'), '@echo off\r\ngemini-real.exe %*\r\n');
    const d = await discover([dir], {
      custom: [
        { id: 'custom-0e0e01', name: 'Relative', argv: ['sub\\x.exe'], keep_env: [] },
        { id: 'custom-0e0e02', name: 'Gone', argv: ['nowhere-agent'], keep_env: [] },
      ],
    });
    const at = async (id, s) => rowOf(entry(d, id), s);
    for (const id of ['codex', 'grok']) {
      const r = await at(id);
      assert.deepEqual([r.verified_package, r.lockdown], [true, 'none'], id);
      for (const p of PURPOSES) assert.equal(refused(r, p), 'agent_not_allowed', `${id} ${p}`);
    }
    const oc = await at('opencode');
    assert.deepEqual(PURPOSES.map((p) => refused(oc, p)), [null, null, 'agent_not_allowed', 'agent_not_allowed']);
    const tripped = S.defaultSettings();
    tripped.agents.claude = { model: null, mode: null, allowed: null, lockdown_failed: { version: await appVersion(), at: 'x' } };
    const claudeTripped = await at('claude', tripped);
    for (const p of PURPOSES) assert.equal(refused(claudeTripped, p), 'agent_not_allowed', `tripped ${p}`);
    // The refusals carry the row's own text: spec 4.3's copy for a script, the command's problem, a custom command not found.
    const gemini = await at('gemini');
    assert.equal(gemini.error, D.CANT_START_TEXT('gemini.bat'));
    assert.deepEqual(D.agentStartRefusal(gemini, 'turn'), { code: 'cant_start_script', error: D.CANT_START_TEXT('gemini.bat') });
    const relative = D.agentStartRefusal(await at('custom-0e0e01'), 'connect');
    assert.equal(relative.code, 'bad_command');
    assert.match(relative.error, /^Relative's command can't be used\. Give the program's full path/);
    assert.deepEqual(D.agentStartRefusal(await at('custom-0e0e02'), 'turn'), { code: 'agent_missing', error: "Magnusim can't find nowhere-agent on this PC." });
    assert.match(D.agentStartRefusal(await at('codex', S.defaultSettings()), 'turn').error, /^Codex is off until you allow it/);
  });
});

// ------------------------------------------------------------------------------------------------
// Settings
// ------------------------------------------------------------------------------------------------

describe('the agents’ settings (spec 5.1)', () => {
  it('a mode must be one Magnusim uses for that agent; allowed, lockdown_failed and custom_agents are never a settings field', () => {
    const d = S.defaultSettings();
    d.custom_agents = [{ id: 'custom-0a1b2c', name: 'Mine', argv: ['x'], keep_env: [] }];
    const v = (patch) => S.validatePatch(d, patch);
    const refused = (patch, field) => {
      const r = v(patch);
      assert.equal(r.ok, false, JSON.stringify(patch));
      assert.equal(r.status, 400);
      assert.equal(r.field, field, JSON.stringify(patch));
    };
    const ok = v({ agents: { claude: { mode: 'default', model: 'opus' }, codex: { mode: 'read-only' } } });
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.settings.agents.claude, { model: 'opus', mode: 'default', allowed: null, lockdown_failed: null });
    assert.equal(v({ agents: { claude: { mode: null } } }).ok, true);
    refused({ agents: { claude: { mode: 'plan' } } }, 'agents.mode');
    refused({ agents: { claude: { mode: 'bypassPermissions' } } }, 'agents.mode');
    refused({ agents: { codex: { mode: 'agent' } } }, 'agents.mode');
    refused({ agents: { opencode: { mode: 'build' } } }, 'agents.mode');
    refused({ agents: { 'custom-0a1b2c': { mode: 'default' } } }, 'agents.mode');
    refused({ agents: { claude: { model: 'no spaces' } } }, 'agents.model');
    refused({ agents: { codex: { allowed: { fingerprint: 'a'.repeat(64), at: 'now' } } } }, 'agents.allowed');
    // Even beside a valid change, and for an id it doesn't know.
    refused({ agents: { claude: { mode: 'default' }, nope: { allowed: null } } }, 'agents.allowed');
    refused({ agents: { codex: { lockdown_failed: null } } }, 'agents.lockdown_failed');
    refused({ agents: { nope: { mode: 'default' } } }, 'agents.nope');
    refused({ agents: { claude: { colour: 'red' } } }, 'agents.colour');
    refused({ custom_agents: [] }, 'custom_agents');
    const caps = { changes: [1, 200, 0, 201], calls: [10, 2000, 9, 2001], turn_minutes: [1, 240, 0, 241] };
    for (const [key, [lo, hi, below, above]] of Object.entries(caps)) {
      assert.equal(v({ agent_caps: { [key]: lo } }).ok, true, `${key} ${lo}`);
      assert.equal(v({ agent_caps: { [key]: hi } }).ok, true, `${key} ${hi}`);
      refused({ agent_caps: { [key]: below } }, `agent_caps.${key}`);
      refused({ agent_caps: { [key]: above } }, `agent_caps.${key}`);
      refused({ agent_caps: { [key]: lo + 0.5 } }, `agent_caps.${key}`);
    }
    refused({ agent_caps: { steps: 5 } }, 'agent_caps.steps');
  });

  it('a file’s agents are read as own properties of agents it knows, and broken records are dropped', () => {
    const fp = 'b'.repeat(64);
    const s = S.normalizeSettings({
      custom_agents: [
        { id: 'custom-00aa11', name: 'Ok', argv: ['a', 'b'], keep_env: ['MY_KEY'] },
        { id: 'custom-00aa11', name: 'Duplicate', argv: ['a'], keep_env: [] },
        { id: 'custom-zz', name: 'Bad id', argv: ['a'], keep_env: [] },
        { id: 'custom-00aa22', name: 'No argv', argv: [], keep_env: [] },
        { id: 'custom-00aa33', name: 'Bad env', argv: ['a'], keep_env: ['1BAD'] },
      ],
      agents: JSON.parse(
        `{"claude": {"allowed": {"fingerprint": "${fp}", "at": "t"}, "mode": "default"}, "codex": {"allowed": {"fingerprint": "short", "at": "t"}}, "nope": {"mode": "x"}, "__proto__": {"mode": "x"}, "custom-00aa11": {"model": "m"}}`,
      ),
      agent_caps: { changes: 5, calls: 3, turn_minutes: 30 },
    });
    assert.deepEqual(s.custom_agents, [{ id: 'custom-00aa11', name: 'Ok', argv: ['a', 'b'], keep_env: ['MY_KEY'] }]);
    assert.deepEqual(Object.keys(s.agents).sort(), ['claude', 'codex', 'custom-00aa11']);
    assert.deepEqual(s.agents.claude.allowed, { fingerprint: fp, at: 't' });
    assert.equal(s.agents.codex.allowed, null, 'a broken record is no switch');
    assert.deepEqual(s.agent_caps, { changes: 5, calls: 400, turn_minutes: 30 });
    assert.equal(Object.getPrototypeOf(s.agents), Object.prototype);
  });

  it('a saved mode is kept at load only when Magnusim may use it for that agent now', () => {
    const s = S.normalizeSettings({
      custom_agents: [{ id: 'custom-00bb11', name: 'Mine', argv: ['a'], keep_env: [] }],
      agents: {
        claude: { mode: 'bypassPermissions', model: 'opus' },
        codex: { mode: 'read-only' },
        gemini: { mode: 'default' },
        opencode: { mode: 'build' },
        grok: { mode: 'agent-full-access' },
        'custom-00bb11': { mode: 'default' },
      },
    });
    assert.deepEqual(
      Object.fromEntries(Object.entries(s.agents).map(([id, p]) => [id, p.mode])),
      { claude: null, codex: 'read-only', gemini: 'default', opencode: null, grok: null, 'custom-00bb11': null },
    );
    assert.equal(s.agents.claude.model, 'opus', 'the rest of its choices stay');
    assert.equal(S.agentPrefs(s, 'claude').mode, null);
  });

  it('a custom agent’s name is 1–40 characters as cleanText counts them (an emoji is one)', () => {
    const smile = String.fromCodePoint(0x1f642);
    assert.equal(S.customNameValid(smile.repeat(40)), true);
    assert.equal(S.customNameValid(smile.repeat(41)), false);
    assert.equal(S.customNameValid('a'.repeat(40)), true);
    assert.equal(S.customNameValid('a'.repeat(41)), false);
    assert.equal(S.customNameValid(''), false);
    assert.equal(S.customNameValid('a\u0007b'), false);
    const c = S.normalizeCustomAgent({ id: 'custom-00cc11', name: smile.repeat(40), argv: ['a'], keep_env: [] });
    assert.equal(c?.name, smile.repeat(40));
  });
});

// ------------------------------------------------------------------------------------------------
// The routes
// ------------------------------------------------------------------------------------------------

/** The app's middleware for /api/ (without the same-origin check, so the routes' own browser check is what refuses). */
function serve(router) {
  const server = http.createServer(async (req, res) => {
    try {
      if (assistantGuard(req, res)) return;
      const handled = await dispatch(router, req, res);
      if (!handled) sendJson(res, 404, { error: 'route not found' });
    } catch (err) {
      sendJson(res, 500, { error: String(err?.message || err) });
    }
  });
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done(server)));
}

let server;
let port;
let handle;
/** The Settings page's tab: its event stream, and the live relay link it sends with the browser-only calls. */
let settingsTab = null;
let LINK = null;
const keepAlive = new http.Agent({ keepAlive: true, maxSockets: 8 });

function request(method, path, { headers = {}, body } = {}) {
  const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
  return new Promise((done, fail) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        agent: keepAlive,
        headers: {
          host: `127.0.0.1:${port}`,
          ...(payload !== undefined && !('content-type' in headers) ? { 'content-type': 'application/json' } : {}),
          ...(payload !== undefined ? { 'content-length': Buffer.byteLength(payload) } : {}),
          ...headers,
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (d) => (text += d));
        res.on('end', () => {
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            /* not JSON */
          }
          done({ status: res.statusCode, json });
        });
      },
    );
    req.on('error', fail);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

const get = (path) => request('GET', path);
/** The app's own Origin alone: any program on this PC can send it. */
const originPost = (path, body, headers = {}) => request('POST', path, { body, headers: { origin: `http://127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin', ...headers } });
/** As the Settings page sends it: the app's own Origin, and its tab's live relay link in the body. */
const browserPost = (path, body, headers = {}) => originPost(path, body && typeof body === 'object' ? { ...body, link: LINK } : body, headers);
const plainPost = (path, body, headers = {}) => request('POST', path, { body, headers });
const SETTINGS_FILE = join(ROOT, 'home', 'assistant', 'settings.json');
const onDisk = () => (existsSync(SETTINGS_FILE) ? JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')) : null);
const rowsOf = async (q = '') => {
  const r = await get(`/api/assistant/agents${q}`);
  assert.equal(r.status, 200);
  return Object.fromEntries(r.json.agents.map((a) => [a.id, a]));
};

/** A spy on child_process (every way to start a process), for the ESM importers too. */
function spyProcesses() {
  const cp = createRequire(import.meta.url)('node:child_process');
  const names = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'];
  const real = Object.fromEntries(names.map((n) => [n, cp[n]]));
  const calls = [];
  for (const name of names) {
    cp[name] = (...a) => {
      calls.push([name, String(a[0])]);
      return real[name](...a);
    };
  }
  syncBuiltinESMExports();
  return {
    calls,
    restore() {
      for (const name of names) cp[name] = real[name];
      syncBuiltinESMExports();
    },
  };
}

describe('the routes (spec 4.9, 5.2, 5.3)', LIMIT, () => {
  let claudeScript;
  /** Every run of the codex fork (discovery may start it only once it is allowed). */
  const CODEX_RUNS = join(ROOT, 'codex-fork-runs.jsonl');
  before(async () => {
    resetAssistantState();
    // path-b: the verified adapter (signed in), and a codex shim to a fork (class none, keyring login).
    ({ script: claudeScript } = npmPrefix(PATH_B, { ...CLAUDE, version: '0.85.1' }));
    reporter(join(PATH_B, 'node_modules', 'codex-fork', 'bin', 'codex.js'), CODEX_RUNS, 'codex-acp', '2.1.1');
    writeFileSync(join(PATH_B, 'codex-acp.cmd'), cmdShim(winRel('node_modules', 'codex-fork', 'bin', 'codex.js')));
    if (!WIN) {
      // POSIX looks for the bare program names, executable.
      symlinkSync(claudeScript, join(PATH_B, CLAUDE.program));
      symlinkSync(join(PATH_B, 'node_modules', 'codex-fork', 'bin', 'codex.js'), join(PATH_B, 'codex-acp'));
    }
    mkdirSync(join(AGENT_HOME, '.claude'), { recursive: true });
    writeFileSync(join(AGENT_HOME, '.claude', '.credentials.json'), '{}');
    const router = new Router();
    registerEventHubRoutes(router);
    handle = routes.registerAssistantRoutes(router, { port: () => port });
    server = await serve(router);
    port = server.address().port;
    // The Settings page's tab opens its relay channel for the proof alone (no workspace).
    settingsTab = await relayPage(`http://127.0.0.1:${port}`);
    LINK = await settingsTab.open();
  });

  after(async () => {
    D.setAgentRunHooks(null);
    settingsTab?.close();
    handle?.shutdown();
    keepAlive.destroy();
    await new Promise((r) => server.close(r));
  });

  it('the status reads only the cache and never starts a process; GET /agents looks, and lists every agent', async () => {
    const spy = spyProcesses();
    let status;
    let rows;
    try {
      status = (await get('/api/assistant/status')).json;
      assert.equal(spy.calls.length, 0, `the status started ${JSON.stringify(spy.calls)}`);
      assert.equal(status.agents_checked_at, null);
      assert.deepEqual(Object.keys(status.providers_ready).filter((k) => k.startsWith('agent:')), [], 'nothing looked for yet');
      rows = await rowsOf();
      assert.ok(spy.calls.length > 0, 'GET /agents asks the versions (the spy sees processes start)');
      spy.calls.length = 0;
      status = (await get('/api/assistant/status')).json;
      assert.equal(spy.calls.length, 0, `the status started ${JSON.stringify(spy.calls)}`);
    } finally {
      spy.restore();
    }
    const claude = rows.claude;
    assert.equal(claude.found, true);
    assert.equal(claude.script, claudeScript);
    assert.equal(claude.version, '0.85.1');
    assert.deepEqual([claude.verified_package, claude.lockdown, claude.own_tools, claude.needs_allow], [true, 'tools_off', 'off', false]);
    assert.deepEqual([claude.signed_in, claude.ready, claude.reason], ['yes', true, null]);
    assert.match(claude.fingerprint, /^[0-9a-f]{64}$/);
    const codex = rows.codex;
    assert.deepEqual([codex.found, codex.verified_package, codex.lockdown, codex.own_tools], [true, false, 'none', 'on']);
    assert.equal(codex.version, null, 'a shim to another package is not asked its version');
    assert.deepEqual(runsOf(CODEX_RUNS), [], 'GET /agents never started it');
    assert.deepEqual([codex.needs_allow, codex.allowed, codex.signed_in, codex.reason], [true, false, 'unknown', 'agent_not_allowed']);
    for (const id of ['opencode', 'grok', 'gemini']) {
      assert.deepEqual([rows[id].found, rows[id].install, rows[id].reason], [false, K.knownAgent(id).install, 'agent_missing'], id);
    }
    assert.ok(status.agents_checked_at);
    assert.ok(['job', 'group', 'best_effort'].includes(status.agents_tree_kill));
    const pr = status.providers_ready;
    assert.deepEqual(pr['agent:claude'], { label: 'Claude Code', kind: 'agent', ready: true, reason: null, billing: 'agent_account', detail: 'Signed in · 0.85.1' });
    assert.equal(pr['agent:codex'].ready, false);
    assert.equal(pr['agent:codex'].reason, 'agent_not_allowed');
    assert.equal(pr['agent:opencode'], undefined, 'only found or custom agents');
    // An API-key provider beside it (D-A): both ready at once.
    const key = await plainPost('/api/assistant/key', { provider: 'anthropic', key: 'sk-ant-api03-TEST-agents-0123456789abcdefXYZ' });
    assert.equal(key.status, 200);
    assert.equal(key.json.providers_ready.anthropic.ready, true);
    assert.equal(key.json.providers_ready['agent:claude'].ready, true);
  });

  it('the status and every settings answer carry the agent limits; each row says which modes Magnusim uses with it; an agent default says why it can’t run', async () => {
    const DEFAULT_CAPS = { changes: 24, calls: 400, turn_minutes: 60 };
    assert.deepEqual((await get('/api/assistant/status')).json.agent_caps, DEFAULT_CAPS);
    const saved = await plainPost('/api/assistant/settings', { agent_caps: { changes: 30 } });
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    assert.deepEqual(saved.json.agent_caps, { ...DEFAULT_CAPS, changes: 30 }, 'the settings answer is the status, with the new limit');
    assert.deepEqual((await get('/api/assistant/status')).json.agent_caps, { ...DEFAULT_CAPS, changes: 30 });
    const back = await plainPost('/api/assistant/settings', { agent_caps: { changes: 24 } });
    assert.deepEqual(back.json.agent_caps, DEFAULT_CAPS);
    const key = await plainPost('/api/assistant/key', { provider: 'anthropic', key: 'sk-ant-api03-TEST-agents-0123456789abcdefXYZ' });
    assert.deepEqual(key.json.agent_caps, DEFAULT_CAPS, 'a key answer is the status too');

    // The catalogue's allowedModes on each row (the page's Mode select offers only these).
    const rows = await rowsOf();
    assert.deepEqual(rows.claude.allowed_modes, ['default']);
    assert.deepEqual(rows.codex.allowed_modes, ['read-only']);
    assert.deepEqual(rows.gemini.allowed_modes, ['default']);
    assert.equal(rows.opencode.allowed_modes, 'initial');
    assert.equal(rows.grok.allowed_modes, 'initial');

    // A coding agent as the default: the status' ready and ready_reason are that agent's.
    const before = (await get('/api/assistant/status')).json.provider;
    try {
      let r = await plainPost('/api/assistant/settings', { provider: 'agent:claude' });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.deepEqual([r.json.provider, r.json.default_provider, r.json.ready, r.json.ready_reason], ['agent:claude', 'agent:claude', true, null]);
      r = await plainPost('/api/assistant/settings', { provider: 'agent:codex' });
      assert.deepEqual([r.json.ready, r.json.ready_reason], [false, 'agent_not_allowed']);
      // Looked for and not found: missing (not "not looked for yet"); its row names it and says why
      // (Settings' Default choice shows it), though an agent not installed is otherwise not offered.
      r = await plainPost('/api/assistant/settings', { provider: 'agent:gemini' });
      assert.deepEqual([r.json.ready, r.json.ready_reason], [false, 'agent_missing']);
      assert.deepEqual(r.json.providers_ready['agent:gemini'], { label: 'Gemini CLI', kind: 'agent', ready: false, reason: 'agent_missing', billing: 'agent_account', detail: 'Not installed' });
      r = await plainPost('/api/assistant/settings', { provider: 'agent:claude' });
      assert.equal(r.json.providers_ready['agent:gemini'], undefined, 'not the default: not offered');
    } finally {
      await plainPost('/api/assistant/settings', { provider: before });
    }
  });

  it('the allow switch: browser only, the row’s fingerprint, and never a settings field', async () => {
    const before = await rowsOf();
    const fp = before.codex.fingerprint;
    const allow = { id: 'codex', allow: true, fingerprint: fp };
    const refused = async (r, status, code) => {
      assert.equal(r.status, status, JSON.stringify(r.json));
      assert.equal(r.json.code, code);
    };
    await refused(await plainPost('/api/assistant/agents/allow', allow), 403, 'browser_only');
    assert.match((await plainPost('/api/assistant/agents/allow', allow)).json.error, /Settings → Assistant in the Magnusim window/);
    await refused(await plainPost('/api/assistant/agents/allow', allow, { origin: 'http://evil.example' }), 403, 'browser_only');
    await refused(await plainPost('/api/assistant/agents/allow', allow, { origin: `http://127.0.0.1:${port + 1}` }), 403, 'browser_only');
    await refused(await plainPost('/api/assistant/agents/allow', allow, { origin: 'null' }), 403, 'browser_only');
    await refused(await browserPost('/api/assistant/agents/allow', allow, { 'sec-fetch-site': 'cross-site' }), 403, 'browser_only');
    await refused(await browserPost('/api/assistant/agents/allow', allow, { 'sec-fetch-site': 'same-site' }), 403, 'browser_only');
    await refused(await browserPost('/api/assistant/agents/allow', allow, { 'x-magnusim-assistant-turn': 't1' }), 403, 'recursion');
    assert.equal((await request('POST', '/api/assistant/agents/allow', { body: JSON.stringify(allow), headers: { origin: `http://127.0.0.1:${port}`, 'content-type': 'text/plain' } })).status, 415);
    await refused(await browserPost('/api/assistant/agents/allow', { ...allow, fingerprint: 'c'.repeat(64) }), 409, 'fingerprint_changed');
    const changed = await browserPost('/api/assistant/agents/allow', { id: 'codex', allow: true });
    await refused(changed, 409, 'fingerprint_changed');
    assert.equal(changed.json.agent.fingerprint, fp, 'with the row as it is now');
    await refused(await browserPost('/api/assistant/agents/allow', { id: 'nope', allow: true }), 404, 'agent_unknown');
    await refused(await browserPost('/api/assistant/agents/allow', { id: 'codex', allow: 'yes' }), 400, 'bad_request');
    await refused(await browserPost('/api/assistant/agents/allow', { id: 'claude', allow: true, fingerprint: before.claude.fingerprint }), 409, 'allow_not_needed');
    await refused(await browserPost('/api/assistant/agents/allow', { id: 'gemini', allow: true }), 409, 'agent_missing');
    assert.equal(onDisk()?.agents?.codex?.allowed ?? null, null, 'nothing allowed so far');
    // Through the settings route: refused, whatever comes with it.
    const viaSettings = await plainPost('/api/assistant/settings', { agents: { codex: { allowed: { fingerprint: fp, at: 'now' } } } });
    assert.equal(viaSettings.status, 400);
    assert.equal(viaSettings.json.field, 'agents.allowed');
    assert.equal(onDisk()?.agents?.codex?.allowed ?? null, null);

    const ok = await browserPost('/api/assistant/agents/allow', allow);
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.deepEqual([ok.json.agent.allowed, ok.json.agent.needs_allow, ok.json.agent.ready, ok.json.agent.reason], [true, true, true, null]);
    assert.equal(onDisk().agents.codex.allowed.fingerprint, fp);
    // Allowed for that program: discovery may now ask its version.
    assert.deepEqual(runsOf(CODEX_RUNS), []);
    assert.equal((await rowsOf('?refresh=1')).codex.version, '2.1.1');
    assert.deepEqual(runsOf(CODEX_RUNS).map((r) => r.argv), [['--version']]);
    const status = (await get('/api/assistant/status')).json;
    assert.equal(status.providers_ready['agent:codex'].ready, true, 'a keyring login (unknown) counts as ready');
    // Its mode is a settings field.
    assert.equal((await plainPost('/api/assistant/settings', { agents: { codex: { mode: 'read-only' } } })).status, 200);
    assert.equal(onDisk().agents.codex.allowed.fingerprint, fp, 'a settings save keeps the switch');
  });

  it('allow:true is refused while that agent runs; allow:false is always taken, saved first, and stops it before answering', async () => {
    const stops = [];
    let running = true;
    let entered;
    const stopEntered = new Promise((r) => (entered = r));
    let release;
    const stopReleased = new Promise((r) => (release = r));
    D.setAgentRunHooks({
      running: (id) => running && id === 'codex',
      async stop(id, text) {
        const record = { id, text, allowedWhenStopped: onDisk()?.agents?.codex?.allowed ?? null, finished: false };
        stops.push(record);
        entered();
        // As agent turns' stop: it takes a while (cancel, its wait, the tree kill).
        await stopReleased;
        running = false;
        record.finished = true;
      },
    });
    try {
      const rows = await rowsOf();
      const on = await browserPost('/api/assistant/agents/allow', { id: 'codex', allow: true, fingerprint: rows.codex.fingerprint });
      assert.equal(on.status, 409);
      assert.equal(on.json.code, 'agent_running');
      assert.equal(stops.length, 0);
      // Off: no fingerprint, while it runs.
      const offSent = browserPost('/api/assistant/agents/allow', { id: 'codex', allow: false });
      let answeredAt = null;
      offSent.then(() => (answeredAt = stops.map((s) => s.finished)));
      await Promise.race([stopEntered, new Promise((_, fail) => setTimeout(() => fail(new Error('the stop never started')), CEILING))]);
      // No answer while the stop runs (a window long enough for a route that didn't wait to answer).
      const early = await Promise.race([offSent.then(() => 'answered'), new Promise((r) => setTimeout(() => r('waiting'), 1_500))]);
      assert.equal(early, 'waiting', 'the route answers only after the stop finished');
      release();
      const off = await offSent;
      assert.equal(off.status, 200, JSON.stringify(off.json));
      assert.deepEqual(answeredAt, [true], 'the stop had finished when the answer came');
      assert.deepEqual(stops, [{ id: 'codex', text: 'Codex was turned off in Settings.', allowedWhenStopped: null, finished: true }]);
      assert.equal(off.json.agent.allowed, false);
      assert.equal(off.json.agent.reason, 'agent_not_allowed');
      assert.equal(onDisk().agents.codex.allowed, null);
      // Still browser only.
      assert.equal((await plainPost('/api/assistant/agents/allow', { id: 'codex', allow: false })).status, 403);
    } finally {
      release();
      D.setAgentRunHooks(null);
    }
  });

  it('allow:false stops the agent even when the switch can’t be saved, and says so', async () => {
    const stops = [];
    D.setAgentRunHooks({ running: () => false, stop: async (id, text) => void stops.push({ id, text }) });
    // A settings file of its own when no earlier test saved one (run alone): the one the save would
    // replace. The server has read it by then, as any server has before Settings shows a switch
    // (the settings stay in memory: only the save meets the folder below).
    if (!existsSync(SETTINGS_FILE)) {
      mkdirSync(dirname(SETTINGS_FILE), { recursive: true });
      writeFileSync(SETTINGS_FILE, '{"version":1}\n');
    }
    assert.equal((await get('/api/assistant/status')).status, 200);
    const saved = readFileSync(SETTINGS_FILE);
    // settings.json is a folder: the save's rename fails (as on a locked file), whatever the platform.
    await removeTree(SETTINGS_FILE);
    mkdirSync(join(SETTINGS_FILE, 'blocked'), { recursive: true });
    try {
      const off = await browserPost('/api/assistant/agents/allow', { id: 'codex', allow: false });
      assert.equal(off.status, 500, JSON.stringify(off.json));
      assert.equal(off.json.code, 'save_failed');
      assert.match(off.json.error, /^Codex was stopped, but Magnusim couldn't save its switch as off/);
      assert.deepEqual(stops, [{ id: 'codex', text: 'Codex was turned off in Settings.' }]);
    } finally {
      D.setAgentRunHooks(null);
      await removeTree(SETTINGS_FILE);
      writeFileSync(SETTINGS_FILE, saved);
    }
  });

  it('a changed command asks again: the row and the readiness say so', async () => {
    const rows = await rowsOf();
    assert.equal((await browserPost('/api/assistant/agents/allow', { id: 'codex', allow: true, fingerprint: rows.codex.fingerprint })).status, 200);
    // Another codex-acp earlier in PATH.
    printer(join(PATH_A, 'node_modules', 'other-codex', 'bin', 'codex.js'), 'codex-acp 9.9.9');
    writeFileSync(join(PATH_A, 'codex-acp.cmd'), cmdShim(winRel('node_modules', 'other-codex', 'bin', 'codex.js')));
    if (!WIN) symlinkSync(join(PATH_A, 'node_modules', 'other-codex', 'bin', 'codex.js'), join(PATH_A, 'codex-acp'));
    const after1 = await rowsOf();
    assert.notEqual(after1.codex.fingerprint, rows.codex.fingerprint);
    assert.deepEqual([after1.codex.allowed, after1.codex.allow_changed, after1.codex.reason], [false, true, 'agent_allow_changed']);
    assert.equal((await get('/api/assistant/status')).json.providers_ready['agent:codex'].reason, 'agent_allow_changed');
    // The verified adapter updated in place: same fingerprint.
    const pkgJson = join(dirname(dirname(claudeScript)), 'package.json');
    writeFileSync(pkgJson, JSON.stringify({ name: CLAUDE.pkg, version: '0.86.0', bin: { [CLAUDE.program]: 'dist/index.js' } }));
    const after2 = await rowsOf('?refresh=1');
    assert.equal(after2.claude.fingerprint, rows.claude.fingerprint);
    assert.equal(after2.claude.lockdown, 'tools_off');
  });

  it('the app’s origin alone (any program can send it) adds, allows and runs nothing: a custom agent added, its switch on, and its Test, connect check and sign-in each need the window’s live link (the checks: or the token); the command never ran', async () => {
    const marker = join(ROOT, 'forged-command-ran.txt');
    const script = join(folder('forged'), 'write-marker.cjs');
    writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran');\n`);
    const command = `"${process.execPath}" "${script}"`;
    const WINDOW_PROOF = "Magnusim couldn't confirm that this came from its own window. Reload the page and try again.";
    const proofRefused = (r, what) => assert.deepEqual([r.status, r.json?.code, r.json?.error], [403, 'launch_proof', WINDOW_PROOF], what);
    const customs = () => onDisk()?.custom_agents ?? [];
    const before = customs().length;
    // Added: the origin alone, a link that is no tab's live one, or the launch token instead: refused, nothing saved.
    proofRefused(await originPost('/api/assistant/agents/custom', { name: 'Forged', command }), 'add, no link');
    proofRefused(await originPost('/api/assistant/agents/custom', { name: 'Forged', command, link: 'c'.repeat(24) }), 'add, a dead link');
    assert.deepEqual([(await plainPost('/api/assistant/agents/custom', { name: 'Forged', command, link: LINK })).json.code], ['browser_only'], 'the link without the origin');
    assert.equal(customs().length, before, 'nothing added');
    // Through the window it is added (off), and its row shows the fingerprint; the origin alone can't switch it on.
    const added = await browserPost('/api/assistant/agents/custom', { name: 'Forged', command });
    assert.equal(added.status, 200, JSON.stringify(added.json));
    const { id, fingerprint } = added.json.agent;
    try {
      assert.equal(onDisk().custom_agents.find((c) => c.id === id).link, undefined, 'the link is never saved');
      proofRefused(await originPost('/api/assistant/agents/allow', { id, allow: true, fingerprint }), 'allow, no link');
      proofRefused(await originPost('/api/assistant/agents/allow', { id, allow: true, fingerprint, link: 'c'.repeat(24) }), 'allow, a dead link');
      assert.equal(onDisk()?.agents?.[id]?.allowed ?? null, null, 'still off');
      // Allowed through the window: its checks still need the proof (the token or the window's link).
      assert.equal((await browserPost('/api/assistant/agents/allow', { id, allow: true, fingerprint })).status, 200);
      for (const [path, body] of [
        ['/api/assistant/agents/test', { id, message: false }],
        ['/api/assistant/agents/test', { id, message: true }],
        ['/api/assistant/agents/sign-in', { id, method: 'browser' }],
        ['/api/assistant/test', { provider: `agent:${id}` }],
      ]) {
        proofRefused(await originPost(path, body), `${path} ${JSON.stringify(body)}`);
        proofRefused(await plainPost(path, { ...body, link: 'c'.repeat(24) }), `${path} with a dead link`);
      }
      assert.equal(existsSync(marker), false, 'the command never ran');
      // Off is the kill switch: always taken, no link needed.
      const off = await originPost('/api/assistant/agents/allow', { id, allow: false });
      assert.equal(off.status, 200, JSON.stringify(off.json));
      assert.equal(onDisk()?.agents?.[id]?.allowed ?? null, null);
    } finally {
      await plainPost('/api/assistant/agents/custom/remove', { id });
    }
    assert.equal(existsSync(marker), false, 'the command never ran');
  });

  it('custom agents: added only from the browser, off until allowed, at most 8, and removed with their choices', async () => {
    const add = (body, headers) => (headers === null ? plainPost : browserPost)('/api/assistant/agents/custom', body, headers ?? {});
    const cmd = `"${process.execPath}" "${fake.agentPath}" --acp`;
    // The agents were looked for, as Settings lists them before anyone can add one (with no look
    // yet, every agent's readiness reads not_checked).
    await rowsOf();
    const none = await add({ name: 'Mine', command: cmd }, null);
    assert.equal(none.status, 403);
    assert.equal(none.json.code, 'browser_only');
    assert.deepEqual(onDisk()?.custom_agents ?? [], []);
    const bad = async (body, code) => {
      const r = await add(body);
      assert.equal(r.status, 400, JSON.stringify(r.json));
      assert.equal(r.json.code, code, JSON.stringify(body));
    };
    await bad({ name: '  ', command: cmd }, 'bad_name');
    await bad({ name: 'X', command: '' }, 'bad_command');
    await bad({ name: 'X', command: 'nowhere-agent-xyz --acp' }, 'bad_command');
    await bad({ name: 'X', command: WIN ? 'sub\\agent.exe' : 'sub/agent' }, 'bad_command');
    await bad({ name: 'X', command: cmd, keep_env: ['MAGNUSIM_ASSISTANT_HOME'] }, 'bad_keep_env');
    await bad({ name: 'X', command: cmd, keep_env: ['1X'] }, 'bad_keep_env');
    await bad({ name: 'X', command: cmd, keep_env: Array.from({ length: 9 }, (_, i) => `V${i}`) }, 'bad_keep_env');
    if (WIN) {
      const bat = join(folder('bat'), 'agent.bat');
      writeFileSync(bat, '@echo off\r\nreal.exe %*\r\n');
      await bad({ name: 'X', command: `"${bat}"` }, 'cant_start_script');
    }
    assert.deepEqual(onDisk()?.custom_agents ?? [], [], 'nothing saved by a refusal');

    const r = await add({ name: 'My agent', command: cmd, keep_env: ['MY_AGENT_KEY'] });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const row = r.json.agent;
    assert.match(row.id, /^custom-[0-9a-f]{6}$/);
    assert.deepEqual(
      [row.kind, row.name, row.found, row.lockdown, row.own_tools, row.needs_allow, row.allowed, row.signed_in, row.reason],
      ['custom', 'My agent', true, 'none', 'on', true, false, 'unknown', 'agent_not_allowed'],
    );
    assert.equal(row.program, process.execPath);
    assert.deepEqual(onDisk().custom_agents, [{ id: row.id, name: 'My agent', argv: [process.execPath, fake.agentPath, '--acp'], keep_env: ['MY_AGENT_KEY'] }]);
    let status = (await get('/api/assistant/status')).json;
    assert.equal(status.providers_ready[`agent:${row.id}`].reason, 'agent_not_allowed');
    assert.equal((await rowsOf())[row.id].fingerprint, row.fingerprint);
    // Its own switch, as any agent's.
    assert.equal((await browserPost('/api/assistant/agents/allow', { id: row.id, allow: true, fingerprint: row.fingerprint })).status, 200);
    status = (await get('/api/assistant/status')).json;
    assert.equal(status.providers_ready[`agent:${row.id}`].ready, true);
    // Under "Never send project data" its own tools stay on, so every turn on it is refused, even
    // from Home: not ready, and its line says why (the row too).
    assert.equal((await plainPost('/api/assistant/settings', { privacy: 'deny' })).status, 200);
    try {
      status = (await get('/api/assistant/status')).json;
      const denied = status.providers_ready[`agent:${row.id}`];
      assert.deepEqual([denied.ready, denied.reason, denied.detail], [false, 'privacy_denied', 'Off while Never send project data is on']);
      assert.deepEqual([(await rowsOf())[row.id].ready, (await rowsOf())[row.id].reason], [false, 'privacy_denied']);
      // An agent whose own tools are off may still run from Home: still ready.
      assert.deepEqual([status.providers_ready['agent:claude'].ready, status.providers_ready['agent:claude'].reason], [true, null]);
    } finally {
      assert.equal((await plainPost('/api/assistant/settings', { privacy: 'ask' })).status, 200);
    }
    assert.equal((await get('/api/assistant/status')).json.providers_ready[`agent:${row.id}`].ready, true);

    // At most 8. A name counts characters as the person sees them: 45 emoji keep their first 40.
    const smile = String.fromCodePoint(0x1f642);
    const ids = [row.id];
    for (let i = 1; i < 8; i += 1) {
      const more = await add({ name: i === 1 ? smile.repeat(45) : `Agent ${i}`, command: cmd });
      assert.equal(more.status, 200, JSON.stringify(more.json));
      ids.push(more.json.agent.id);
    }
    assert.equal(onDisk().custom_agents.find((c) => c.id === ids[1]).name, smile.repeat(40));
    await bad({ name: 'Ninth', command: cmd }, 'too_many');
    assert.equal(onDisk().custom_agents.length, 8);

    // Removed: not while it runs; then with its choices.
    const remove = (id) => plainPost('/api/assistant/agents/custom/remove', { id });
    // An unknown id: 404 agent_unknown, as /agents/allow and /agents/test answer it.
    const gone = await remove('custom-ffffff');
    assert.deepEqual([gone.status, gone.json.code, gone.json.error], [404, 'agent_unknown', 'No custom agent called custom-ffffff. Settings → Assistant lists them.']);
    assert.equal((await browserPost('/api/assistant/agents/allow', { id: 'custom-ffffff', allow: false })).json.code, 'agent_unknown');
    const known = await remove('claude');
    assert.deepEqual([known.status, known.json.code], [404, 'agent_unknown'], 'a known agent is not removed');
    D.setAgentRunHooks({ running: (id) => id === row.id, stop: async () => {} });
    try {
      const busy = await remove(row.id);
      assert.equal(busy.status, 409);
      assert.equal(busy.json.code, 'agent_running');
    } finally {
      D.setAgentRunHooks(null);
    }
    assert.equal(onDisk().agents[row.id].allowed.fingerprint, row.fingerprint);
    // Removed: what it still has (a session kept between messages) is stopped too.
    const stops = [];
    D.setAgentRunHooks({ running: () => false, stop: async (id, text) => void stops.push({ id, text, listed: onDisk().custom_agents.some((c) => c.id === id) }) });
    try {
      assert.equal((await remove(row.id)).status, 200);
    } finally {
      D.setAgentRunHooks(null);
    }
    assert.deepEqual(stops, [{ id: row.id, text: 'My agent was removed in Settings.', listed: false }]);
    assert.ok(!onDisk().custom_agents.some((c) => c.id === row.id));
    assert.equal(onDisk().agents[row.id], undefined, 'its choices went with it');
    assert.equal((await get('/api/assistant/status')).json.providers_ready[`agent:${row.id}`], undefined);
    assert.equal((await rowsOf())[row.id], undefined);
    for (const id of ids.slice(1)) assert.equal((await remove(id)).status, 200);
  });

  describe('a discovery that runs while things change', () => {
    /** OpenCode's own package in path-b, whose --version counts its runs and waits while HOLD exists. */
    const OC = join(ROOT, 'oc-probe');
    const COUNT = join(OC, 'count');
    const STARTED = join(OC, 'started');
    const HOLD = join(OC, 'hold');
    let ocPkg;
    before(() => {
      mkdirSync(OC, { recursive: true });
      const made = npmPrefix(PATH_B, { pkg: 'opencode-ai', program: 'opencode', version: '1.18.34', bin: 'bin/oc.js' });
      ocPkg = made.pkgDir;
      writeFileSync(
        made.script,
        [
          '#!/usr/bin/env node',
          "const fs = require('node:fs');",
          `const n = (fs.existsSync(${JSON.stringify(COUNT)}) ? Number(fs.readFileSync(${JSON.stringify(COUNT)}, 'utf8')) : 0) + 1;`,
          `fs.writeFileSync(${JSON.stringify(COUNT)}, String(n));`,
          `fs.writeFileSync(${JSON.stringify(STARTED)}, String(n));`,
          "const done = () => process.stdout.write('opencode 1.0.' + n + '\\n');",
          `if (!fs.existsSync(${JSON.stringify(HOLD)})) done();`,
          `else { const t = setInterval(() => { if (!fs.existsSync(${JSON.stringify(HOLD)})) { clearInterval(t); done(); } }, 20); }`,
          '',
        ].join('\n'),
      );
      if (!WIN) symlinkSync(made.script, join(PATH_B, 'opencode'));
    });
    after(async () => {
      for (const f of [HOLD, join(PATH_B, 'opencode.cmd'), join(PATH_B, 'opencode'), ocPkg]) await removeTree(f);
    });
    const runs = () => (existsSync(COUNT) ? Number(readFileSync(COUNT, 'utf8')) : 0);
    /** A discovery held at OpenCode's version until release() (a long probe limit: the test releases it). */
    async function heldDiscovery() {
      if (existsSync(STARTED)) await removeTree(STARTED);
      writeFileSync(HOLD, '');
      const run = D.refreshAgents({ refresh: true, probeMs: 120_000 });
      const end = Date.now() + CEILING;
      while (!existsSync(STARTED)) {
        assert.ok(Date.now() < end, 'the held probe never started');
        await new Promise((r) => setTimeout(r, 20));
      }
      return { run, release: () => removeTree(HOLD) };
    }

    it('a custom agent added or removed while a discovery runs is in (or out of) what it keeps', LIMIT, async () => {
      const cmd = `"${process.execPath}" "${fake.agentPath}" --acp`;
      const held = await heldDiscovery();
      let joined;
      let id;
      try {
        const added = await browserPost('/api/assistant/agents/custom', { name: 'Added meanwhile', command: cmd });
        assert.equal(added.status, 200, JSON.stringify(added.json));
        id = added.json.agent.id;
        // GET /agents' work, which joins the discovery that runs.
        joined = D.listAgents({ mcp: async () => ({ available: true, reason: null }) });
      } finally {
        await held.release();
      }
      const d = await held.run;
      assert.ok(d.agents.some((a) => a.id === id), 'the discovery that ran meanwhile has it');
      assert.equal(D.agentsCache(), d);
      const rows = Object.fromEntries((await joined).body.agents.map((a) => [a.id, a]));
      assert.equal(rows[id]?.name, 'Added meanwhile', 'the joined list shows it');
      assert.ok((await D.ensureAgents()).agents.some((a) => a.id === id), 'a turn’s start finds it');
      assert.equal((await get('/api/assistant/status')).json.providers_ready[`agent:${id}`].reason, 'agent_not_allowed', 'looked up, not not_checked');

      const held2 = await heldDiscovery();
      try {
        assert.equal((await plainPost('/api/assistant/agents/custom/remove', { id })).status, 200);
      } finally {
        await held2.release();
      }
      const d2 = await held2.run;
      assert.ok(!d2.agents.some((a) => a.id === id), 'the discovery that ran meanwhile doesn’t bring it back');
      assert.equal(D.agentsCache(), d2);
      assert.ok(!(await D.ensureAgents()).agents.some((a) => a.id === id));
      assert.equal((await get('/api/assistant/status')).json.providers_ready[`agent:${id}`], undefined);
    });

    it('Refresh asked while a plain discovery runs asks every version again, once, right after it', LIMIT, async () => {
      await rowsOf();
      const before = runs();
      const plain = D.refreshAgents();
      const refresh = D.refreshAgents({ refresh: true });
      assert.notEqual(refresh, plain, 'not merged into the plain one');
      assert.equal(D.refreshAgents({ refresh: true }), refresh, 'one Refresh run queued');
      assert.equal(D.refreshAgents(), plain, 'a plain caller joins the one running');
      const [p, r] = await Promise.all([plain, refresh]);
      assert.equal(entry(p, 'opencode').version, `1.0.${before}`, 'the plain run kept the version it had');
      assert.equal(entry(r, 'opencode').version, `1.0.${before + 1}`, 'the Refresh asked again');
      assert.equal(runs(), before + 1);
      assert.equal(D.agentsCache(), r);
    });
  });
});
