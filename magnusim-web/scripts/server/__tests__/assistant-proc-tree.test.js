// A coding agent and everything it starts stop together (phase 3 spec 4.4, 4.11): the
// environment allowlist, the private working folder outside the checkout, the projects and the
// Assistant's home, the stderr ring, and the tree kill with the scripted fake agent and its
// helper processes. On Windows: the job object (a helper whose parent already exited dies; a
// program that starts helpers at its first instruction leaves none, thanks to the trampoline;
// Magnusim killed outright takes the tree with it through the keeper's pipe) and the
// best-effort taskkill fallback when PowerShell is blocked, and the keeper warmed ahead (one per
// process, whichever copy of the module warmed it, ended with the Assistant). On POSIX: the
// process group (polite and stubborn agents, a leader that already ended, helpers
// given their SIGTERM grace), Magnusim stopped by Ctrl+C, its terminal closing or SIGTERM taking
// every group with it, and the pids.json sweep of groups a crashed Magnusim left behind, on
// proof only (never an unrelated group, a group with a member older than its recorded leader, a
// record of another boot, or a crashed run's record that carries this pid). A start stopped
// midway (Stop, the switch going off, the session ended) starts nothing, or nothing that is
// still running once it has said so. No process is left: every pid is checked. Every agent
// starts with tmp: ROOT, so nothing here reads or removes the system temp folder's working
// folders.
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-assistant-proc-tree-'));
process.env.MAGNUSIM_PROJECTS_ROOT = join(ROOT, 'projects');
process.env.MAGNUSIM_LOCAL_JSON = join(ROOT, 'local.json');
process.env.MAGNUSIM_ASSISTANT_HOME = join(ROOT, 'home');
for (const k of Object.keys(process.env)) if (k.startsWith('MAGNUSIM_TEST_ASSISTANT')) delete process.env[k];

const procTree = await import('../../proc-tree.js');
const agentProc = await import('../assistant/agents/process.ts');
const jobWin = await import('../assistant/agents/job-win.ts');
const rpc = await import('../assistant/agents/rpc.ts');
const { registerSecretForRedaction } = await import('../assistant/redact.ts');
const { resetAssistantState, shutdownAssistant } = await import('../assistant/state.ts');
const { startFakeAcp, FAKE_ACP_AGENT } = await import('../../../e2e/support/fake-acp.mjs');
const { removeTree } = await import('../../remove-tree.js');
const { AgentSession } = await import('../assistant/agents/session.ts');
const { mintBinding, resetBindingsForTests } = await import('../assistant/mcp/sessions.ts');
const { killOwn } = await import('./assistant-own-pids.js');

const WIN = process.platform === 'win32';
const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, '..', '..', '..');
const PROCESS_TS = join(HERE, '..', 'assistant', 'agents', 'process.ts');
const LAUNCH = join(HERE, '..', 'assistant', 'agents', 'launch.mjs');
// A ceiling, so a test that would hang fails instead; deaths are checked within CEILING.
const LIMIT = { timeout: 90_000 };
const CEILING = 10_000;

/**
 * Every pid a test made: at the end, each one still running as one of this file's processes is
 * killed, whatever happened (a pid the OS has given to another program since is left alone).
 */
const made = new Set();
const cleanups = [];
after(async () => {
  for (const c of cleanups.reverse()) {
    try {
      await c();
    } catch {
      /* cleaned up as far as it goes */
    }
  }
  jobWin.dropWarmKeeper();
  // Every pid a fake reported too, whether or not its test got to look at it.
  for (const fake of FAKES) for (const p of fake.pids()) made.add(p.pid);
  // This file's processes: its drivers and agents' folders under ROOT, the fakes (by their
  // controller), their helpers and the test's own one-liners, the trampoline, the job keepers.
  const marks = [ROOT, FAKE_ACP_AGENT, LAUNCH, ...FAKES.map((f) => f.url), 'setInterval(()=>{},1<<30)', 'process.stdin.resume()', 'process.stderr.write(', jobWin.JOB_KEEPER_B64.slice(0, 64)];
  killOwn([...made], marks);
  resetBindingsForTests();
  resetAssistantState();
  try {
    // Every agent's working folder is in here (tmp: ROOT), even those of a Magnusim killed outright.
    await removeTree(ROOT);
  } catch {
    /* the OS temp cleaner takes it */
  }
});

function alive(pid) {
  if (!pid) return false;
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      // A zombie has ended; init reaps it later.
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

/** Whether POSIX process group `pgid` has emptied within `ms` (polling for it; nothing is slept for). */
async function groupGone(pgid, ms = CEILING) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      process.kill(-pgid, 0);
    } catch (err) {
      if (err.code === 'ESRCH') return true;
    }
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** The first line of `stream` that is a JSON object (log lines come first). */
function firstJson(stream) {
  return new Promise((resolve, reject) => {
    let buf = '';
    stream.setEncoding('utf8');
    const onData = (d) => {
      buf += d;
      for (const line of buf.split('\n')) {
        if (!line.startsWith('{') || !line.trim().endsWith('}')) continue;
        stream.off('data', onData);
        resolve(JSON.parse(line.trim()));
        return;
      }
    };
    stream.on('data', onData);
    stream.once('end', () => reject(new Error(`no JSON line: ${buf}`)));
  });
}

/** Waits (polling) until cond() holds, at most `ms`. */
async function until(cond, ms = CEILING) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('not in time');
    await new Promise((r) => setTimeout(r, 20));
  }
}

/**
 * A spy on child_process: spawnSync calls and spawn's programs (and processes), for the ESM
 * importers too. `before(program, args)` may throw instead of the spawn; `after(program, args,
 * child)` runs once it is spawned, before the caller gets it.
 */
function spyChildProcess({ before, after: afterSpawn } = {}) {
  const cp = createRequire(import.meta.url)('node:child_process');
  const real = { spawn: cp.spawn, spawnSync: cp.spawnSync };
  const spy = { sync: [], spawned: [], children: [] };
  cp.spawnSync = (...a) => {
    spy.sync.push(a[0]);
    return real.spawnSync(...a);
  };
  cp.spawn = (...a) => {
    const program = String(a[0]);
    const args = Array.isArray(a[1]) ? a[1].map(String) : [];
    spy.spawned.push(program);
    before?.(program, args);
    const child = real.spawn(...a);
    spy.children.push({ program, args, child });
    afterSpawn?.(program, args, child);
    return child;
  };
  syncBuiltinESMExports();
  spy.restore = () => {
    cp.spawn = real.spawn;
    cp.spawnSync = real.spawnSync;
    syncBuiltinESMExports();
  };
  return spy;
}

const FAKES = [];
async function fakeAgent(options = {}) {
  const fake = await startFakeAcp(options);
  FAKES.push(fake);
  cleanups.push(() => fake.stop());
  return fake;
}

/** Starts the fake as an agent, contained, with a client of ours on rpc.ts. */
async function startFake(fake, o = {}) {
  const proc = await agentProc.startAgentProcess({ argv: o.argv ?? fake.argv, label: 'fake', tmp: ROOT, ...o.start });
  made.add(proc.pid);
  cleanups.push(() => proc.stop('test cleanup'));
  const peer = new rpc.RpcPeer({ input: proc.stdout, output: proc.stdin, exited: proc.exited, tail: () => proc.tail() });
  return { proc, peer };
}

/** initialize, session/new (no MCP server), then a prompt running `steps` (not awaited). */
async function promptFake(fake, peer, cwd, ...steps) {
  await peer.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  const s = await peer.request('session/new', { cwd, mcpServers: [] });
  fake.script(...steps);
  const prompt = peer.request('session/prompt', { sessionId: s.sessionId, prompt: [{ type: 'text', text: 'go' }] });
  prompt.catch(() => {});
  // In an object: an async function returning the promise itself would adopt its rejection.
  return { prompt };
}

async function helperPids(fake, n) {
  await fake.waitFor(() => fake.pids('helper').length >= n);
  const pids = fake.pids('helper').map((p) => p.pid);
  for (const p of pids) made.add(p);
  return pids;
}

async function agentPid(fake) {
  await fake.waitFor(() => fake.pids('agent').length >= 1);
  const pid = fake.pids('agent').at(-1).pid;
  made.add(pid);
  return pid;
}

// --------------------------------------------------------------------------------------------
describe('the environment allowlist (spec 4.4)', () => {
  const BASE = {
    PATH: ['/usr/bin', 'relative/bin', '', '/usr/bin/', '/opt/x/bin'].join(':'),
    HOME: '/home/u',
    LANG: 'en_GB.UTF-8',
    LC_ALL: 'C',
    XDG_CONFIG_HOME: '/home/u/.config',
    TERM: 'xterm',
    https_proxy: 'http://proxy:3128',
    NO_PROXY: 'localhost',
    NODE_EXTRA_CA_CERTS: '/etc/ca.pem',
    ACME_API_KEY: 'acme-key',
    ACME_CONFIG_DIR: '/home/u/.acme',
    ACME_MODE: 'quiet',
    OTHER_API_KEY: 'other-key',
    GOOGLE_APPLICATION_CREDENTIALS: '/secret.json',
    GITHUB_PAT: 'pat',
    DATABASE_URL: 'postgres://u:p@h/db',
    MAGNUSIM_ASSISTANT_HOME: '/x',
    MAGNUSIM_TEST_ASSISTANT: '1',
    CFDDESK_PROJECTS_ROOT: '/p',
    npm_config_prefix: '/n',
    NODE_OPTIONS: '--require /evil.js',
    ELECTRON_RUN_AS_NODE: '1',
    home: 'lower-case is another variable on POSIX',
  };

  it("passes the system's variables, proxies and the agent's own; drops everything else", () => {
    const env = agentProc.agentEnv(
      { keyVars: ['ACME_API_KEY'], dirVar: 'ACME_CONFIG_DIR', envPrefixes: ['ACME_'], searchFolders: ['/home/u/.npm-global/bin', '/opt/x/bin'], extra: { ACME_SETTINGS: '{"tools":[]}' } },
      BASE,
      'linux',
    );
    assert.deepEqual(Object.keys(env).sort(), [
      'ACME_API_KEY',
      'ACME_CONFIG_DIR',
      'ACME_MODE',
      'ACME_SETTINGS',
      'HOME',
      'LANG',
      'LC_ALL',
      'NODE_EXTRA_CA_CERTS',
      'NO_PROXY',
      'PATH',
      'TERM',
      'XDG_CONFIG_HOME',
      'https_proxy',
    ]);
    assert.equal(env.PATH, '/usr/bin:/opt/x/bin:/home/u/.npm-global/bin', 'absolute entries in order, no duplicates, search folders appended');
    assert.equal(env.ACME_SETTINGS, '{"tools":[]}');
  });

  it("another agent's key never reaches this one; a custom agent gets only what it lists; Magnusim's never", () => {
    const custom = agentProc.agentEnv({ keepEnv: ['GOOGLE_APPLICATION_CREDENTIALS', 'NODE_OPTIONS', 'MAGNUSIM_TEST_ASSISTANT', 'npm_config_prefix'] }, BASE, 'linux');
    assert.equal(custom.GOOGLE_APPLICATION_CREDENTIALS, '/secret.json', 'listed by the person');
    for (const k of ['ACME_API_KEY', 'OTHER_API_KEY', 'GITHUB_PAT', 'DATABASE_URL', 'NODE_OPTIONS', 'MAGNUSIM_TEST_ASSISTANT', 'MAGNUSIM_ASSISTANT_HOME', 'CFDDESK_PROJECTS_ROOT', 'npm_config_prefix', 'ELECTRON_RUN_AS_NODE', 'home']) {
      assert.ok(!(k in custom), k);
    }
    const extra = agentProc.agentEnv({ extra: { MAGNUSIM_X: '1', NODE_OPTIONS: 'x' } }, BASE, 'linux');
    assert.ok(!('MAGNUSIM_X' in extra) && !('NODE_OPTIONS' in extra), 'not even from the catalogue');
  });

  it('on Windows names compare without case, PATH keeps its own name, and drive paths count as absolute', () => {
    const env = agentProc.agentEnv(
      { keyVars: ['ACME_API_KEY'], searchFolders: ['C:\\Users\\u\\AppData\\Roaming\\npm'] },
      { Path: 'C:\\Windows\\system32;relative;C:\\WINDOWS\\System32\\;C:\\Tools', SYSTEMROOT: 'C:\\Windows', acme_api_key: 'k', Https_Proxy: 'p', ComSpec: 'C:\\Windows\\system32\\cmd.exe', Magnusim_Test_Assistant: '1' },
      'win32',
    );
    assert.deepEqual(Object.keys(env).sort(), ['ComSpec', 'Https_Proxy', 'Path', 'SYSTEMROOT', 'acme_api_key']);
    assert.equal(env.Path, 'C:\\Windows\\system32;C:\\Tools;C:\\Users\\u\\AppData\\Roaming\\npm');
  });
});

// --------------------------------------------------------------------------------------------
describe('the working folder', LIMIT, () => {
  it('is private, empty, under the OS temp folder, outside the checkout, the projects and the Assistant home', async () => {
    const dir = await agentProc.makeAgentWorkdir();
    cleanups.push(() => Promise.resolve(rmSync(dir, { recursive: true, force: true })));
    assert.ok(dir.startsWith(join(tmpdir(), 'magnusim-agent-')), dir);
    assert.equal(await agentProc.workdirRefusal(dir), null);
    if (!WIN) assert.equal(statSync(dir).mode & 0o777, 0o700);
    const roots = agentProc.forbiddenRoots();
    assert.equal(roots.home, join(ROOT, 'home'));
    assert.equal(roots.projects, join(ROOT, 'projects'));
    assert.ok(existsSync(join(roots.repo, 'magnusim-web', 'package.json')), roots.repo);
  });

  it('a start refuses a folder inside the repository, the projects or the Assistant home', async () => {
    const roots = agentProc.forbiddenRoots();
    assert.match(await agentProc.workdirRefusal(join(WEB, 'scripts', 'x')), /inside the repository/);
    assert.match(await agentProc.workdirRefusal(join(ROOT, 'projects', 'p1')), /inside the projects folder/);
    assert.match(await agentProc.workdirRefusal(join(ROOT, 'home', 'assistant')), /inside the Assistant's folder/);
    mkdirSync(join(ROOT, 'home'), { recursive: true });
    await assert.rejects(agentProc.makeAgentWorkdir({ tmp: join(ROOT, 'home') }), /inside the Assistant's folder/);
    // A temp folder inside "the repository" (a stand-in root, so nothing is made in the checkout).
    const inRepo = mkdtempSync(join(ROOT, 'repo-'));
    await assert.rejects(agentProc.makeAgentWorkdir({ tmp: inRepo, roots: { ...roots, repo: inRepo } }), /inside the repository/);
    assert.deepEqual(readdirSync(inRepo), [], 'the refused folder is removed');
  });

  it('leftover working folders older than a day go at the next start; newer ones and files stay', async () => {
    const tmp = mkdtempSync(join(ROOT, 'tmp-'));
    const old = join(tmp, 'magnusim-agent-old');
    const fresh = join(tmp, 'magnusim-agent-new');
    const other = join(tmp, 'someone-else');
    for (const d of [old, fresh, other]) mkdirSync(join(d, 'inside'), { recursive: true });
    writeFileSync(join(tmp, 'magnusim-agent-file'), 'x');
    const dayAgo = (Date.now() - 25 * 3600_000) / 1000;
    for (const p of [old, other, join(tmp, 'magnusim-agent-file')]) utimesSync(p, dayAgo, dayAgo);
    assert.equal(await agentProc.sweepAgentWorkdirs({ tmp }), 1);
    assert.ok(!existsSync(old));
    assert.ok(existsSync(fresh) && existsSync(other) && existsSync(join(tmp, 'magnusim-agent-file')));
  });

  it("a start sweeps the temp folder its working folder goes in (so a test never touches the system's)", async () => {
    const tmp = mkdtempSync(join(ROOT, 'tmp-start-'));
    const old = join(tmp, 'magnusim-agent-old');
    mkdirSync(old);
    const dayAgo = (Date.now() - 25 * 3600_000) / 1000;
    utimesSync(old, dayAgo, dayAgo);
    const proc = await agentProc.startAgentProcess({ argv: [process.execPath, '-e', 'process.stdin.resume()'], label: 'sweep', tmp });
    made.add(proc.pid);
    cleanups.push(() => proc.stop());
    assert.ok(proc.cwd.startsWith(join(tmp, 'magnusim-agent-')), proc.cwd);
    await until(() => !existsSync(old));
    await proc.stop();
  });
});

// --------------------------------------------------------------------------------------------
describe('killProcessTreeAsync', LIMIT, () => {
  it('ends a process and its child without ever calling spawnSync', async () => {
    const code = "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1<<30)'],{stdio:'ignore'});console.log(c.pid);setInterval(()=>{},1<<30);";
    const parent = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, ...procTree.ownProcessGroup() });
    made.add(parent.pid);
    const child = Number(await new Promise((r) => parent.stdout.once('data', (d) => r(String(d).trim()))));
    made.add(child);
    assert.deepEqual([parent.pid, child].filter(alive), [parent.pid, child]);
    const spy = spyChildProcess();
    try {
      await procTree.killProcessTreeAsync(parent.pid);
    } finally {
      spy.restore();
    }
    assert.deepEqual(spy.sync, [], 'never spawnSync');
    if (WIN) assert.match(spy.spawned.join(' '), /taskkill\.exe$/i);
    assert.deepEqual(await stillAlive([parent.pid, child]), []);
    await procTree.killProcessTreeAsync(null);
  });
});

// --------------------------------------------------------------------------------------------
describe('the agent process', LIMIT, () => {
  it('runs in its working folder with only the allowlisted environment, and keeps a redacted, cleaned stderr ring', async () => {
    const secret = 'sekret-for-the-ring-0123456789';
    registerSecretForRedaction(secret);
    // A terminal escape and a bidi mark: the ring keeps neither (the CLI or page may show a line).
    const ESC = String.fromCharCode(27);
    const RLO = String.fromCharCode(0x202e);
    const fake = await fakeAgent({ envReport: ['HOME', 'USERPROFILE', 'ACME_API_KEY', 'OTHER_API_KEY', 'MAGNUSIM_ASSISTANT_HOME', 'NODE_OPTIONS'], stderrAtStart: `starting with ${secret} ${ESC}[31mred${ESC}[0m ${RLO}end` });
    const { proc } = await startFake(fake, {
      start: { env: { keyVars: ['ACME_API_KEY'] }, baseEnv: { ...process.env, ACME_API_KEY: 'a', OTHER_API_KEY: 'o', NODE_OPTIONS: '--no-warnings' } },
    });
    const env = await fake.waitFor((r) => r.event === 'env');
    assert.ok(env.present.includes('ACME_API_KEY'), 'its own key');
    assert.ok(env.present.includes(WIN ? 'USERPROFILE' : 'HOME'), 'the home folder');
    for (const k of ['OTHER_API_KEY', 'MAGNUSIM_ASSISTANT_HOME', 'NODE_OPTIONS']) assert.ok(!env.present.includes(k), k);
    const realCwd = (p) => (WIN ? p.toLowerCase() : p);
    assert.equal(realCwd(env.cwd), realCwd(proc.cwd));
    assert.ok(existsSync(proc.cwd));
    await until(() => proc.tail().some((l) => l.includes('starting')));
    const tail = proc.tail().join('\n');
    assert.ok(!tail.includes(secret), tail);
    assert.match(tail, /starting with \[redacted\] \[31mred \[0m end/);
    assert.ok(!tail.includes(ESC) && !tail.includes(RLO), JSON.stringify(tail));
    await proc.stop();
    assert.ok(!existsSync(proc.cwd), 'the working folder is removed');
  });

  it('an agent that ends at once still reports its exit code (watched from the spawn on)', async () => {
    // On POSIX a shell that exits at once ends before the start has recorded its group.
    const argv = WIN ? [process.execPath, '-e', 'process.exit(5)'] : ['/bin/sh', '-c', 'exit 5'];
    const proc = await agentProc.startAgentProcess({ argv, label: 'quick', tmp: ROOT });
    made.add(proc.pid);
    cleanups.push(() => proc.stop());
    assert.equal((await proc.exited).code, 5);
    await proc.stop();
  });

  it('keeps only the last 40 stderr lines of 400 characters', async () => {
    const code = "for(let i=0;i<50;i++)process.stderr.write('line '+i+' '+'x'.repeat(500)+'\\n');process.stdin.resume();";
    const proc = await agentProc.startAgentProcess({ argv: [process.execPath, '-e', code], label: 'ring', tmp: ROOT });
    made.add(proc.pid);
    cleanups.push(() => proc.stop());
    await until(() => proc.tail().some((l) => l.startsWith('line 49 ')));
    const tail = proc.tail();
    assert.equal(tail.length, 40);
    assert.ok(tail[0].startsWith('line 10 '));
    assert.ok(tail.every((l) => l.length === 400));
    await proc.stop();
  });

  it('a program that is not there: refused on POSIX; on Windows the trampoline ends with its reason', async () => {
    const missing = join(ROOT, 'no-such-agent');
    if (!WIN) {
      await assert.rejects(agentProc.startAgentProcess({ argv: [missing], label: 'missing', tmp: ROOT }), (e) => e.code === 'agent_missing');
      return;
    }
    const proc = await agentProc.startAgentProcess({ argv: [missing], label: 'missing', tmp: ROOT });
    made.add(proc.pid);
    const info = await proc.exited;
    assert.equal(info.code, 127);
    await proc.stop();
    assert.match(proc.tail().join('\n'), /ENOENT/);
  });

  for (const kind of ['polite', 'stubborn']) {
    it(`a ${kind} agent and its helpers are gone after the stop`, async () => {
      const fake = await fakeAgent({ stubborn: kind === 'stubborn' });
      const { proc, peer } = await startFake(fake);
      void promptFake(fake, peer, proc.cwd, { spawnHelpers: 2 }, { hold: 'never' }).catch(() => {});
      const helpers = await helperPids(fake, 2);
      const agent = await agentPid(fake);
      const all = [proc.pid, agent, ...helpers];
      assert.deepEqual(all.filter(alive), all, 'all running before the stop');
      const t0 = Date.now();
      await proc.stop();
      assert.deepEqual(await stillAlive(all), [], `${kind}: nothing left`);
      assert.ok(Date.now() - t0 < CEILING, `stopped in ${Date.now() - t0} ms`);
      assert.equal(agentProc.agentsTreeKill(), WIN ? 'job' : 'group');
      assert.equal(proc.treeKill, WIN ? 'job' : 'group');
    });
  }

  it('a start stopped once its working folder is made spawns nothing (Windows: nor once its keeper is ready); its folder and keeper go', async () => {
    const tmp = mkdtempSync(join(ROOT, 'tmp-halt-'));
    const marker = join(ROOT, 'halted-agent-ran');
    const ac = new AbortController();
    // The stop lands past the start's first check, while it reads the environment the agent gets.
    const baseEnv = { ...process.env };
    Object.defineProperty(baseEnv, 'ZZ_STOP_LANDS_HERE', {
      enumerable: true,
      get: () => {
        ac.abort(new Error('stopped while it started'));
        return undefined;
      },
    });
    const keeper = WIN ? jobWin.JobKeeper.start() : undefined;
    if (keeper) cleanups.push(async () => keeper.close());
    // Its first act writes the marker; a long grace, so one that did run gets to write it.
    const argv = [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran'); process.stdin.resume();`];
    const spy = spyChildProcess();
    try {
      await assert.rejects(agentProc.startAgentProcess({ argv, label: 'halted', tmp, baseEnv, keeper, signal: ac.signal, graceMs: CEILING }), /stopped while it started/);
    } finally {
      spy.restore();
    }
    assert.deepEqual(
      spy.children.filter((c) => c.args.some((x) => x.includes('halted-agent-ran'))).map((c) => c.program),
      [],
      'nothing was spawned (on Windows not even the trampoline)',
    );
    assert.equal(existsSync(marker), false, 'the agent never ran');
    assert.deepEqual(readdirSync(tmp), [], 'its working folder is gone');
    if (keeper) {
      made.add(keeper.pid);
      await keeper.ended;
      assert.equal(keeper.state, 'closed', 'its keeper is closed');
    }
  });

  it('a session ended while its agent starts: end() resolves only once nothing of the agent runs, and the start fails', async () => {
    const fake = await fakeAgent();
    const conversation = 'ended-while-starting';
    const session = new AgentSession({
      conversation,
      agent: { id: 'fake', name: 'Fake', kind: 'custom', argv: fake.argv, program: process.execPath, programName: 'node', script: null, version: null, fingerprint: null, lockdown: 'none', ownTools: 'on', allowed: true, signedIn: 'unknown', env: {}, defaultAgent: null },
      known: null,
      binding: mintBinding({ conversation, agent: 'fake', name: 'Fake' }),
      prefs: { model: null, mode: null },
      version: '0.0.0',
      tmp: ROOT,
    });
    // The end comes the moment the agent (Windows: its trampoline) is spawned, before its start
    // has finished (the allow switch going off, the conversation dropped, the server stopping).
    let spawned = 0;
    let ending = null;
    const spy = spyChildProcess({
      after: (program, args, child) => {
        if (ending || !args.includes(FAKE_ACP_AGENT)) return;
        spawned = child.pid;
        made.add(spawned);
        ending = session.end('agent_off');
      },
    });
    let start;
    try {
      start = session.start(new AbortController().signal);
      start.catch(() => {});
      await until(() => ending);
    } finally {
      spy.restore();
    }
    await ending;
    assert.equal(alive(spawned), false, 'nothing of the agent runs once end() has resolved');
    await assert.rejects(start);
    if (WIN) assert.deepEqual(fake.pids('agent'), [], 'on Windows the agent itself never ran (the trampoline got no go)');
  });

  it("helpers whose parent already exited die with the tree", async () => {
    const fake = await fakeAgent();
    const { proc, peer } = await startFake(fake);
    const { prompt } = await promptFake(fake, peer, proc.cwd, { spawnHelpers: 2 }, { crash: 'gone before its helpers' });
    const helpers = await helperPids(fake, 2);
    const agent = await agentPid(fake);
    await assert.rejects(prompt, rpc.RpcExited);
    assert.equal((await proc.exited).code, 1);
    assert.deepEqual(await stillAlive([agent], CEILING), [], 'the agent itself has ended');
    assert.deepEqual(helpers.filter(alive), helpers, 'its helpers live on by themselves');
    await proc.stop();
    assert.deepEqual(await stillAlive(helpers), [], 'and are ended by the tree kill');
  });
});

// --------------------------------------------------------------------------------------------
// launch.mjs importing nothing but node: modules is checked on every platform, in
// scripts/__tests__/assistant-boundaries.test.mjs.
describe('Windows: the job object', { ...LIMIT, skip: WIN ? false : 'Windows only (job objects)' }, () => {
  it('a program that starts helpers at its first instruction leaves none (the trampoline holds it until the job is set)', async () => {
    const fake = await fakeAgent();
    // The assignment waits for the agent to say it started (a ceiling of 2 s): with the
    // trampoline it can't have, so nothing it starts is ever outside the job.
    let startedEarly = false;
    const beforeAssign = () =>
      fake.waitFor((r) => r.event === 'pids' && r.role === 'helper', 2_000).then(
        () => (startedEarly = true),
        () => {},
      );
    const { proc } = await startFake(fake, { argv: fake.argvWith({ helpersAtStart: 3 }), start: { beforeAssign } });
    assert.equal(startedEarly, false, 'nothing ran before the job assignment');
    const helpers = await helperPids(fake, 3);
    const agent = await agentPid(fake);
    await proc.stop();
    assert.deepEqual(await stillAlive([proc.pid, agent, ...helpers]), []);
  });

  it('a start stopped while its trampoline is put in the job: no go, so the agent never runs, and the trampoline is gone when the start says so', async () => {
    const ac = new AbortController();
    const marker = join(ROOT, 'stopped-in-job-agent-ran');
    let trampoline = 0;
    const beforeAssign = async (pid) => {
      trampoline = pid;
      made.add(pid);
      ac.abort(new Error('stopped while it was put in the job'));
    };
    const argv = [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran'); process.stdin.resume();`];
    await assert.rejects(agentProc.startAgentProcess({ argv, label: 'stopped-in-job', tmp: ROOT, signal: ac.signal, graceMs: CEILING, beforeAssign }), /stopped while it was put in the job/);
    assert.ok(trampoline > 0, 'the trampoline was spawned');
    assert.equal(alive(trampoline), false, 'the trampoline is gone');
    assert.equal(existsSync(marker), false, 'the agent never ran');
  });

  it('each start warms the keeper the next start takes; a warmed keeper that fails (PowerShell blocked) makes status best effort before the next agent starts; a working one puts it back', async () => {
    jobWin.dropWarmKeeper();
    const argv = [process.execPath, '-e', 'process.stdin.resume()'];
    const start = async (label) => {
      const proc = await agentProc.startAgentProcess({ argv, label, tmp: ROOT });
      made.add(proc.pid);
      cleanups.push(() => proc.stop());
      return proc;
    };
    const isKeeper = (program) => /powershell\.exe$/i.test(program);
    // PowerShell keepers spawned so far, and how many may be (later ones are blocked).
    let keepersSpawned = 0;
    let allowed = Infinity;
    const spy = spyChildProcess({
      before: (program) => {
        if (!isKeeper(program)) return;
        keepersSpawned += 1;
        if (keepersSpawned > allowed) throw Object.assign(new Error('blocked by group policy'), { code: 'EACCES' });
      },
    });
    const keepers = () => spy.children.filter((c) => isKeeper(c.program)).map((c) => c.child.pid);
    try {
      const a = await start('first');
      for (const pid of keepers()) made.add(pid);
      assert.equal(a.keeper.pid, keepers()[0], 'the first start has a keeper of its own');
      assert.equal(keepers().length, 2, 'and warms the next one');
      const b = await start('second');
      for (const pid of keepers()) made.add(pid);
      assert.equal(b.keeper.pid, keepers()[1], 'the next start takes the warmed keeper');
      assert.equal(keepers().length, 3, 'and warms another');
      assert.equal(agentProc.agentsTreeKill(), 'job');
      await Promise.all([a.stop(), b.stop()]);
      // A new keeper for the next start, and PowerShell blocked for the one it warms.
      jobWin.dropWarmKeeper();
      allowed = keepersSpawned + 1;
      const c = await start('third');
      for (const pid of keepers()) made.add(pid);
      assert.equal(c.treeKill, 'job', 'its own keeper worked');
      await new Promise((r) => setImmediate(r));
      assert.equal(agentProc.agentsTreeKill(), 'best_effort', 'the warmed keeper failed: best effort before the next agent starts');
      await c.stop();
      // PowerShell works again: the next start drops the failed keeper, and its own puts the status back.
      allowed = Infinity;
      const d = await start('fourth');
      for (const pid of keepers()) made.add(pid);
      assert.equal(d.treeKill, 'job');
      assert.equal(agentProc.agentsTreeKill(), 'job', 'a working keeper puts it back');
      await d.stop();
      jobWin.dropWarmKeeper();
      assert.deepEqual(await stillAlive(keepers()), [], 'every keeper has ended');
    } finally {
      spy.restore();
    }
  });

  it('the keeper warmed ahead ends when the Assistant shuts down, and a start once it has shut down warms none', async () => {
    jobWin.dropWarmKeeper();
    const argv = [process.execPath, '-e', 'process.stdin.resume()'];
    const spy = spyChildProcess();
    const keepers = () => spy.children.filter((c) => /powershell\.exe$/i.test(c.program)).map((c) => c.child.pid);
    try {
      const a = await agentProc.startAgentProcess({ argv, label: 'warm-at-shutdown', tmp: ROOT });
      made.add(a.pid);
      cleanups.push(() => a.stop());
      for (const pid of keepers()) made.add(pid);
      assert.equal(keepers().length, 2, 'its own keeper and one warmed ahead');
      const warm = keepers()[1];
      await a.stop();
      assert.ok(alive(warm), 'the warmed keeper waits for the next start');
      shutdownAssistant();
      assert.deepEqual(await stillAlive([warm]), [], 'the warmed keeper ended with the Assistant');
      // A start that ends after the shutdown (one on its way then) leaves no keeper waiting.
      const b = await agentProc.startAgentProcess({ argv, label: 'after-shutdown', tmp: ROOT });
      made.add(b.pid);
      cleanups.push(() => b.stop());
      for (const pid of keepers()) made.add(pid);
      assert.equal(keepers().length, 3, 'its own keeper, and none warmed');
      await b.stop();
      assert.deepEqual(await stillAlive(keepers()), [], 'every keeper has ended');
    } finally {
      spy.restore();
      // A fresh Assistant for the tests after this one (the shut-down one warms nothing).
      resetAssistantState();
    }
  });

  it('a copy of the module loaded again (a Vite restart) shares the one warmed keeper and the keeper status with the first', async () => {
    jobWin.dropWarmKeeper();
    const copy = await import(`../assistant/agents/job-win.ts?copy=${process.pid}-${Date.now()}`);
    assert.notEqual(copy.warmKeeper, jobWin.warmKeeper, 'a second copy of the module');
    const spy = spyChildProcess();
    const keepers = () => spy.children.filter((c) => /powershell\.exe$/i.test(c.program)).map((c) => c.child.pid);
    try {
      jobWin.warmKeeper();
      copy.warmKeeper();
      for (const pid of keepers()) made.add(pid);
      assert.equal(keepers().length, 1, 'one keeper warmed, whichever copy asks');
      const taken = copy.takeKeeper();
      assert.equal(taken.pid, keepers()[0], 'the other copy takes it');
      taken.close();
      // A keeper one copy warmed, the other drops.
      copy.warmKeeper();
      for (const pid of keepers()) made.add(pid);
      assert.equal(keepers().length, 2);
      jobWin.dropWarmKeeper();
      assert.deepEqual(await stillAlive(keepers()), [], 'every keeper has ended');
      // What one copy learnt about keepers on this PC, the other reports.
      copy.noteKeeperOutcome(false);
      assert.equal(jobWin.keeperLooksBlocked(), true);
      jobWin.noteKeeperOutcome(true);
      assert.equal(copy.keeperLooksBlocked(), false);
    } finally {
      spy.restore();
      copy.dropWarmKeeper();
      jobWin.dropWarmKeeper();
    }
  });

  it('the keeper puts a process in the job only when its creation time matches, and kill ends the job', async () => {
    const keeper = jobWin.JobKeeper.start();
    cleanups.push(async () => keeper.close());
    await keeper.ready;
    made.add(keeper.pid);
    const before = Date.now();
    const p = spawn(process.execPath, ['-e', 'setInterval(()=>{},1<<30)'], { stdio: 'ignore', windowsHide: true });
    const afterSpawn = Date.now();
    made.add(p.pid);
    // A window that ends before the process was created: a reused pid would look like this.
    await assert.rejects(keeper.assign(p.pid, before - 60_000, before - 30_000), /created at/);
    await keeper.assign(p.pid, before, afterSpawn);
    assert.ok(alive(p.pid));
    await keeper.kill();
    assert.deepEqual(await stillAlive([p.pid]), []);
    assert.ok(alive(keeper.pid), 'the keeper itself is not in its job');
    keeper.close();
    await keeper.ended;
    assert.equal(keeper.state, 'closed');
  });

  it("the keeper's stdin ending (as when Magnusim ends) takes the whole tree, the agent's helpers too", async () => {
    const fake = await fakeAgent({ stubborn: true });
    const { proc } = await startFake(fake, { argv: fake.argvWith({ helpersAtStart: 2 }) });
    const helpers = await helperPids(fake, 2);
    const agent = await agentPid(fake);
    const tree = [proc.pid, agent, ...helpers];
    assert.deepEqual(tree.filter(alive), tree);
    made.add(proc.keeper.pid);
    // Only the keeper's pipe: no kill command, and Magnusim (this process) lives on.
    proc.keeper.close();
    assert.deepEqual(await stillAlive([proc.keeper.pid, ...tree]), []);
    await proc.stop();
  });

  it('Magnusim killed outright: the keeper sees its stdin end and the job takes the whole tree', async () => {
    const fake = await fakeAgent();
    const driver = join(ROOT, 'driver.mjs');
    writeFileSync(
      driver,
      [
        `const { startAgentProcess } = await import(${JSON.stringify(pathToFileURL(PROCESS_TS).href)});`,
        `const proc = await startAgentProcess({ argv: JSON.parse(process.argv[2]), label: 'driver', tmp: ${JSON.stringify(ROOT)} });`,
        `console.log(JSON.stringify({ pid: proc.pid, keeper: proc.keeper ? proc.keeper.pid : null, tree: proc.treeKill }));`,
        `setInterval(() => {}, 1 << 30);`,
      ].join('\n'),
    );
    const d = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', driver, JSON.stringify(fake.argvWith({ helpersAtStart: 2 }))], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
    made.add(d.pid);
    const info = await firstJson(d.stdout);
    made.add(info.pid);
    made.add(info.keeper);
    assert.equal(info.tree, 'job');
    const helpers = await helperPids(fake, 2);
    const agent = await agentPid(fake);
    const tree = [info.pid, agent, ...helpers];
    assert.deepEqual(tree.filter(alive), tree);
    // TerminateProcess: no exit handler of Magnusim runs.
    process.kill(d.pid, 'SIGKILL');
    assert.deepEqual(await stillAlive([d.pid, info.keeper, ...tree]), []);
  });

  it('with PowerShell blocked (test switch), the stop is an async taskkill of the linked tree, and status says best effort', async () => {
    process.env.MAGNUSIM_TEST_ASSISTANT = '1';
    process.env.MAGNUSIM_TEST_ASSISTANT_JOB = 'blocked';
    try {
      const fake = await fakeAgent({ stubborn: true });
      const startSpy = spyChildProcess();
      let started;
      try {
        started = await startFake(fake);
      } finally {
        startSpy.restore();
      }
      const { proc, peer } = started;
      assert.ok(!startSpy.spawned.some((p) => /powershell\.exe$/i.test(p)), 'no keeper is started');
      assert.equal(proc.treeKill, 'best_effort');
      assert.equal(agentProc.agentsTreeKill(), 'best_effort');
      void promptFake(fake, peer, proc.cwd, { spawnHelpers: 2 }, { hold: 'never' }).catch(() => {});
      const helpers = await helperPids(fake, 2);
      const agent = await agentPid(fake);
      const spy = spyChildProcess();
      try {
        await proc.stop();
      } finally {
        spy.restore();
      }
      assert.deepEqual([...startSpy.sync, ...spy.sync], [], 'never spawnSync');
      assert.ok(spy.spawned.some((p) => /taskkill\.exe$/i.test(p)), spy.spawned.join(' '));
      assert.deepEqual(await stillAlive([proc.pid, agent, ...helpers]), []);
    } finally {
      delete process.env.MAGNUSIM_TEST_ASSISTANT;
      delete process.env.MAGNUSIM_TEST_ASSISTANT_JOB;
    }
    // The next agent with a working keeper puts status back to the job.
    const fake = await fakeAgent();
    const { proc } = await startFake(fake);
    assert.equal(proc.treeKill, 'job');
    assert.equal(agentProc.agentsTreeKill(), 'job');
    await proc.stop();
  });
});

// --------------------------------------------------------------------------------------------
describe('the job test switch', () => {
  it('is honoured only with MAGNUSIM_TEST_ASSISTANT=1 in a test home, and reported otherwise', () => {
    const home = { MAGNUSIM_ASSISTANT_HOME: join(ROOT, 'home') };
    assert.deepEqual(jobWin.jobTestSwitch({ ...home, MAGNUSIM_TEST_ASSISTANT: '1', MAGNUSIM_TEST_ASSISTANT_JOB: 'blocked' }), { blocked: true, ignored: null });
    assert.match(jobWin.jobTestSwitch({ ...home, MAGNUSIM_TEST_ASSISTANT_JOB: 'blocked' }).ignored, /without MAGNUSIM_TEST_ASSISTANT=1/);
    assert.equal(jobWin.jobTestSwitch({ ...home, MAGNUSIM_TEST_ASSISTANT_JOB: 'blocked' }).blocked, false);
    assert.match(jobWin.jobTestSwitch({ MAGNUSIM_TEST_ASSISTANT: '1', MAGNUSIM_TEST_ASSISTANT_JOB: 'blocked' }).ignored, /outside a test home/);
    assert.match(jobWin.jobTestSwitch({ ...home, MAGNUSIM_TEST_ASSISTANT: '1', MAGNUSIM_TEST_ASSISTANT_JOB: 'slow' }).ignored, /unknown value/);
    assert.deepEqual(jobWin.jobTestSwitch({}), { blocked: false, ignored: null });
  });

  it('the keeper script checks the language mode, sets KILL_ON_JOB_CLOSE without breakaway, and checks the creation time', () => {
    const s = jobWin.JOB_KEEPER_SCRIPT;
    assert.match(s, /LanguageMode -ne 'FullLanguage'.*exit 4/);
    assert.match(s, /LimitFlags = 0x2000;/);
    assert.ok(!/0x800|0x1000;/.test(s.replace(/0x0001 \| 0x0100 \| 0x1000/, '')), 'no breakaway flag');
    assert.match(s, /GetProcessTimes/);
    assert.ok(jobWin.JOB_KEEPER_ARGS.includes('-NonInteractive') && jobWin.JOB_KEEPER_ARGS.at(-1) === jobWin.JOB_KEEPER_B64);
  });
});

// --------------------------------------------------------------------------------------------
describe('POSIX: the process group', { ...LIMIT, skip: WIN ? 'POSIX only (process groups)' : false }, () => {
  const pidsJson = () => {
    try {
      return JSON.parse(readFileSync(agentProc.pidsFile(), 'utf8')).groups;
    } catch {
      return [];
    }
  };
  const writeGroups = async (groups) => (await import('../assistant/files.ts')).writeFileAtomic(agentProc.pidsFile(), JSON.stringify({ version: 1, groups }));

  it('the group is recorded in pids.json while it runs, and the record goes with the stop', async () => {
    const fake = await fakeAgent();
    const { proc } = await startFake(fake);
    const rec = pidsJson().find((g) => g.pgid === proc.pid);
    assert.ok(rec, 'recorded');
    assert.equal(rec.owner.pid, process.pid);
    if (process.platform === 'linux') assert.match(rec.start, /^linux:\d+$/);
    await proc.stop();
    assert.ok(!pidsJson().some((g) => g.pgid === proc.pid), 'removed');
  });

  it('Magnusim gone: its exit takes the groups; a crash leaves them to the next start, which ends them', async () => {
    const fake = await fakeAgent();
    const driver = join(ROOT, 'driver-posix.mjs');
    writeFileSync(
      driver,
      [
        `const { startAgentProcess } = await import(${JSON.stringify(pathToFileURL(PROCESS_TS).href)});`,
        `const proc = await startAgentProcess({ argv: JSON.parse(process.argv[2]), label: 'driver', tmp: ${JSON.stringify(ROOT)} });`,
        `console.log(JSON.stringify({ pid: proc.pid }));`,
        `process.stdin.on('data', () => process.exit(0));`,
        `setInterval(() => {}, 1 << 30);`,
      ].join('\n'),
    );
    const run = async () => {
      const before = fake.pids('helper').length;
      const d = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', driver, JSON.stringify(fake.argvWith({ helpersAtStart: 2 }))], { stdio: ['pipe', 'pipe', 'inherit'] });
      made.add(d.pid);
      const info = await firstJson(d.stdout);
      made.add(info.pid);
      const helpers = (await helperPids(fake, before + 2)).slice(before);
      return { d, group: [info.pid, ...helpers], pgid: info.pid };
    };
    // A clean exit: the exit hook ends the group, and takes its record.
    const a = await run();
    assert.ok(pidsJson().some((g) => g.pgid === a.pgid));
    a.d.stdin.write('quit\n');
    assert.deepEqual(await stillAlive([a.d.pid, ...a.group]), []);
    assert.ok(!pidsJson().some((g) => g.pgid === a.pgid), 'a clean exit leaves no record');
    // A crash: nothing runs, the group lives on, recorded. The agent ends at the end of its
    // input; its helpers don't, so the group has no leader and the sweep needs its proof.
    const b = await run();
    process.kill(b.d.pid, 'SIGKILL');
    assert.deepEqual(await stillAlive([b.d.pid, b.pgid]), []);
    const helpers = b.group.slice(1);
    assert.deepEqual(helpers.filter(alive), helpers, 'left behind');
    assert.ok(pidsJson().some((g) => g.pgid === b.pgid));
    const signalled = await agentProc.sweepAgentGroups();
    assert.ok(signalled.includes(b.pgid));
    assert.deepEqual(await stillAlive(b.group), []);
    assert.ok(!pidsJson().some((g) => g.pgid === b.pgid), 'the record goes');
  });

  it('Magnusim stopped by Ctrl+C, its terminal closing or SIGTERM: every agent group goes with it, and it ends as that signal ends it', async () => {
    // Stubborn: the agent ignores the end of its input; its helpers ignore SIGINT, SIGHUP and
    // SIGTERM. Each leads its own session, so a terminal's signals never reach them.
    const fake = await fakeAgent({ stubborn: true });
    const driver = join(ROOT, 'driver-signals.mjs');
    writeFileSync(
      driver,
      [
        // A host that handles SIGTERM itself: as Vite does (it closes the server, then exits),
        // or by staying up.
        `if (process.argv[3] === 'host-sigterm') process.once('SIGTERM', () => setTimeout(() => process.exit(143), 50));`,
        `if (process.argv[3] === 'host-stays') process.once('SIGTERM', () => console.log(JSON.stringify({ host: 'handled' })));`,
        `const url = ${JSON.stringify(pathToFileURL(PROCESS_TS).href)};`,
        `const start = async (url, label) => (await import(url)).startAgentProcess({ argv: JSON.parse(process.argv[2]), label, tmp: ${JSON.stringify(ROOT)} });`,
        `const pids = [(await start(url, 'driver')).pid];`,
        // A second copy of the module (as a Vite restart loads the server's modules again), with an agent of its own.
        `if (process.argv[3] === 'two-copies') pids.push((await start(url + '?copy=2', 'driver-2')).pid);`,
        `console.log(JSON.stringify({ pids }));`,
        `setInterval(() => {}, 1 << 30);`,
      ].join('\n'),
    );
    const cases = [
      // A terminal signals its foreground process group: Ctrl+C, and the terminal closing.
      { name: 'Ctrl+C', signal: 'SIGINT', toGroup: true, ends: { code: null, signal: 'SIGINT' } },
      { name: 'the terminal closing', signal: 'SIGHUP', toGroup: true, ends: { code: null, signal: 'SIGHUP' } },
      { name: 'SIGTERM', signal: 'SIGTERM', toGroup: false, ends: { code: null, signal: 'SIGTERM' } },
      { name: 'SIGTERM its host handles', signal: 'SIGTERM', toGroup: false, mode: 'host-sigterm', ends: { code: 143, signal: null } },
      // The host decides: nothing of the agents' is touched while it stays up; then Ctrl+C.
      { name: 'SIGTERM its host handles by staying up', signal: 'SIGTERM', toGroup: false, mode: 'host-stays', stays: true, ends: { code: null, signal: 'SIGINT' } },
      // Two copies of the module, each with its own agent: neither leaves the signal to the other.
      { name: 'Ctrl+C with two copies of the module', signal: 'SIGINT', toGroup: true, mode: 'two-copies', ends: { code: null, signal: 'SIGINT' } },
    ];
    for (const c of cases) {
      const before = fake.pids('helper').length;
      // Its own process group, as a terminal's foreground job.
      const d = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', driver, JSON.stringify(fake.argvWith({ helpersAtStart: 2 })), c.mode ?? ''], { stdio: ['ignore', 'pipe', 'inherit'], detached: true });
      made.add(d.pid);
      const ended = new Promise((r) => d.once('exit', (code, signal) => r({ code, signal })));
      const { pids } = await firstJson(d.stdout);
      for (const pid of pids) made.add(pid);
      const helpers = (await helperPids(fake, before + 2 * pids.length)).slice(before);
      const group = [...pids, ...helpers];
      const recorded = () => pids.filter((pid) => pidsJson().some((g) => g.pgid === pid));
      assert.deepEqual(group.filter(alive), group, `${c.name}: the agents and their helpers run`);
      assert.deepEqual(recorded(), pids, `${c.name}: recorded`);
      process.kill(c.toGroup ? -d.pid : d.pid, c.signal);
      if (c.stays) {
        // Its handler ran after the hook (first in line), which left the signal to it.
        assert.deepEqual(await firstJson(d.stdout), { host: 'handled' });
        assert.deepEqual(recorded(), pids, `${c.name}: the records stay`);
        assert.deepEqual(group.filter(alive), group, `${c.name}: the agent and its helpers still run`);
        process.kill(-d.pid, 'SIGINT');
      }
      assert.deepEqual(await ended, c.ends, `${c.name}: Magnusim ends as that signal ends it`);
      assert.deepEqual(await stillAlive(group), [], `${c.name}: nothing of the agents is left`);
      assert.deepEqual(recorded(), [], `${c.name}: their records go with them`);
    }
  });

  it('Ctrl+C while an agent is being started: its group, spawned but not yet recorded as running, goes too', async () => {
    const fake = await fakeAgent({ stubborn: true });
    const driver = join(ROOT, 'driver-mid-start.mjs');
    writeFileSync(
      driver,
      [
        `import { writeSync } from 'node:fs';`,
        `import { createRequire, syncBuiltinESMExports } from 'node:module';`,
        `const cp = createRequire(import.meta.url)('node:child_process');`,
        `const real = cp.spawn;`,
        // Ctrl+C the moment the agent is spawned, while its start still records its group.
        `cp.spawn = (...a) => {`,
        `  const child = real(...a);`,
        `  if ((a[1] || []).some((x) => String(x) === '--control')) child.once('spawn', () => { writeSync(1, JSON.stringify({ pid: child.pid }) + '\\n'); process.emit('SIGINT', 'SIGINT'); });`,
        `  return child;`,
        `};`,
        `syncBuiltinESMExports();`,
        `const { startAgentProcess } = await import(${JSON.stringify(pathToFileURL(PROCESS_TS).href)});`,
        `await startAgentProcess({ argv: JSON.parse(process.argv[2]), label: 'driver', tmp: ${JSON.stringify(ROOT)} });`,
        `writeSync(1, JSON.stringify({ started: true }) + '\\n');`,
        `setInterval(() => {}, 1 << 30);`,
      ].join('\n'),
    );
    // Helpers at its first instruction: an agent left running keeps its group alive through them.
    const d = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', driver, JSON.stringify(fake.argvWith({ helpersAtStart: 2 }))], { stdio: ['ignore', 'pipe', 'inherit'], detached: true });
    made.add(d.pid);
    const ended = new Promise((r) => d.once('exit', (code, signal) => r({ code, signal })));
    const info = await firstJson(d.stdout);
    assert.ok(info.pid, JSON.stringify(info));
    made.add(info.pid);
    assert.deepEqual(await ended, { code: null, signal: 'SIGINT' }, 'Magnusim ends as Ctrl+C ends it');
    assert.equal(await groupGone(info.pid), true, 'the agent it was starting, and its group, are gone');
    for (const p of fake.pids()) made.add(p.pid);
  });

  it('never signals a leaderless group with a member that started before its recorded leader', { skip: process.platform === 'linux' ? false : 'Linux only (a group whose leader ended is ended only there)' }, async () => {
    // A group whose leader starts a member in a folder, then ends; a stale record names that folder.
    const folder = mkdtempSync(join(ROOT, 'agent-folder-'));
    const code = "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1<<30)'],{stdio:'ignore',cwd:process.argv[1]});c.unref();console.log(c.pid);";
    const g = spawn(process.execPath, ['-e', code, folder], { stdio: ['ignore', 'pipe', 'ignore'], detached: true });
    made.add(g.pid);
    const member = Number(await new Promise((r) => g.stdout.once('data', (d) => r(String(d).trim()))));
    made.add(member);
    assert.deepEqual(await stillAlive([g.pid]), [], 'the leader has ended');
    const [memberStart, boot] = await Promise.all([agentProc.processStart(member), agentProc.bootId()]);
    const ticks = Number(String(memberStart).slice('linux:'.length));
    assert.ok(Number.isInteger(ticks), String(memberStart));
    const record = (start, label) => ({ pgid: g.pid, start, boot, cwd: realpathSync(folder), owner: { pid: 999999, start: 'linux:2' }, label, at: '' });
    // Everything else holds (this boot, a live member in the recorded folder), but the member
    // started before the recorded leader: it can't be the agent's.
    await writeGroups([record(`linux:${ticks + 1}`, 'member older than the leader')]);
    assert.deepEqual(await agentProc.sweepAgentGroups(), []);
    assert.ok(alive(member), 'the member is left alone');
    assert.ok(!pidsJson().some((r) => r.pgid === g.pid), 'the stale record goes');
    // The same record with the leader started first: the agent's group, so it is ended.
    await writeGroups([record(`linux:${ticks}`, 'leader first')]);
    assert.deepEqual(await agentProc.sweepAgentGroups(), [g.pid]);
    assert.deepEqual(await stillAlive([member]), []);
  });

  it('the sweep leaves a group whose leader id now belongs to another program, and a running Magnusim', async () => {
    const code = "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1<<30)'],{stdio:'ignore'});console.log(c.pid);setInterval(()=>{},1<<30);";
    const g = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'ignore'], detached: true });
    made.add(g.pid);
    const child = Number(await new Promise((r) => g.stdout.once('data', (d) => r(String(d).trim()))));
    made.add(child);
    const start = await agentProc.processStart(g.pid);
    const ownerStart = await agentProc.processStart(process.pid);
    const boot = await agentProc.bootId();
    await writeGroups([
      { pgid: g.pid, start: 'linux:1', boot, cwd: process.cwd(), owner: { pid: 999999, start: 'x' }, label: 'reused', at: '' },
      // The same start time counted from another boot: another process.
      { pgid: g.pid, start, boot: 'linux:another-boot', cwd: process.cwd(), owner: { pid: 999999, start: 'x' }, label: 'another boot', at: '' },
      { pgid: g.pid, start, boot, cwd: null, owner: { pid: process.pid + 0, start: ownerStart }, label: 'mine', at: '' },
    ]);
    assert.deepEqual(await agentProc.sweepAgentGroups(), [], 'start time or boot differs; the other record is a running Magnusim (this one)');
    assert.deepEqual([g.pid, child].filter(alive), [g.pid, child]);
    assert.deepEqual(
      pidsJson().map((r) => r.label),
      ['mine'],
      "this run's record is kept",
    );
    await writeGroups([]);
    process.kill(-g.pid, 'SIGKILL');
    assert.deepEqual(await stillAlive([g.pid, child]), []);
  });

  it('never signals an unrelated group whose leader ended, whatever a stale record says', async () => {
    // An unrelated program: its group's leader starts a member and ends.
    const code = "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1<<30)'],{stdio:'ignore'});c.unref();console.log(c.pid);";
    const g = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'ignore'], detached: true });
    made.add(g.pid);
    const member = Number(await new Promise((r) => g.stdout.once('data', (d) => r(String(d).trim()))));
    made.add(member);
    assert.deepEqual(await stillAlive([g.pid]), [], 'the leader has ended');
    assert.ok(alive(member), 'its member lives on in its group');
    const boot = await agentProc.bootId();
    const elsewhere = mkdtempSync(join(ROOT, 'not-its-folder-'));
    const gone = { pid: 999999, start: 'linux:2' };
    await writeGroups([
      // This boot, but nothing of the group works in the recorded folder.
      { pgid: g.pid, start: 'linux:1', boot, cwd: elsewhere, owner: gone, label: 'stale', at: '' },
      // The member's own folder, but from another boot.
      { pgid: g.pid, start: 'linux:1', boot: 'linux:another-boot', cwd: process.cwd(), owner: gone, label: 'another boot', at: '' },
      // A record that says neither.
      { pgid: g.pid, start: 'linux:1', owner: gone, label: 'old', at: '' },
    ]);
    assert.deepEqual(await agentProc.sweepAgentGroups(), []);
    assert.ok(alive(member), 'the unrelated member is left alone');
    assert.ok(!pidsJson().some((r) => r.pgid === g.pid), 'the stale records go');
    process.kill(-g.pid, 'SIGKILL');
    assert.deepEqual(await stillAlive([member]), []);
  });

  it("a crashed run's record that carries this process's pid (pids are reused) is swept, not kept as this run's", async () => {
    const g = spawn(process.execPath, ['-e', 'setInterval(()=>{},1<<30)'], { stdio: 'ignore', detached: true });
    made.add(g.pid);
    await new Promise((r) => g.once('spawn', r));
    const [start, boot] = await Promise.all([agentProc.processStart(g.pid), agentProc.bootId()]);
    await writeGroups([{ pgid: g.pid, start, boot, cwd: null, owner: { pid: process.pid, start: 'linux:1' }, label: 'crashed run', at: '' }]);
    assert.deepEqual(await agentProc.sweepAgentGroups(), [g.pid]);
    assert.deepEqual(await stillAlive([g.pid]), []);
    assert.ok(!pidsJson().some((r) => r.pgid === g.pid), 'its record goes');
  });

  it('a stop gives the group its grace after SIGTERM, also when the agent itself ended at once', async () => {
    const fake = await fakeAgent();
    // A long grace: a polite group ends well within it, so it costs nothing unless broken.
    const { proc, peer } = await startFake(fake, { start: { graceMs: 5_000 } });
    const marker = join(ROOT, `tidy-${proc.pid}`);
    void promptFake(fake, peer, proc.cwd, { spawnHelpers: { count: 2, onTerm: marker } }, { hold: 'never' }).catch(() => {});
    const helpers = await helperPids(fake, 2);
    const agent = await agentPid(fake);
    const t0 = Date.now();
    await proc.stop();
    assert.deepEqual(await stillAlive([proc.pid, agent, ...helpers]), []);
    assert.deepEqual(
      [0, 1].filter((i) => !existsSync(`${marker}.${i}`)),
      [],
      'each helper finished its cleanup after SIGTERM, before any SIGKILL',
    );
    assert.ok(Date.now() - t0 < CEILING, `stopped in ${Date.now() - t0} ms`);
  });
});
// --------------------------------------------------------------------------------------------
describe("this file's own end (test support)", LIMIT, () => {
  it('signals only the pids still running as one of its own processes, never one another program has now', async () => {
    // Its own (a helper's one-liner), and a program that now has a recorded pid (no mark of ours).
    const mine = spawn(process.execPath, ['-e', 'setInterval(()=>{},1<<30)'], { stdio: 'ignore', windowsHide: true });
    const other = spawn(process.execPath, ['-e', 'setTimeout(()=>{},1e9)'], { stdio: 'ignore', windowsHide: true });
    made.add(mine.pid);
    try {
      await Promise.all([mine, other].map((c) => new Promise((r) => c.once('spawn', r))));
      assert.deepEqual(killOwn([mine.pid, other.pid], [ROOT, 'setInterval(()=>{},1<<30)']), [mine.pid]);
      assert.deepEqual(await stillAlive([mine.pid]), [], 'its own process is ended');
      assert.ok(alive(other.pid), 'the other program is left alone');
    } finally {
      other.kill('SIGKILL');
    }
  });
});
