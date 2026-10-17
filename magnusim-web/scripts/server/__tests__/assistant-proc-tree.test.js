// A coding agent and everything it starts stop together (phase 3 spec 4.4, 4.11): the
// environment allowlist, the private working folder outside the checkout, the projects and the
// Assistant's home, the stderr ring, and the tree kill with the scripted fake agent and its
// helper processes. On Windows: the job object (a helper whose parent already exited dies; a
// program that starts helpers at its first instruction leaves none, thanks to the trampoline;
// Magnusim killed outright takes the tree with it through the keeper's pipe) and the
// best-effort taskkill fallback when PowerShell is blocked. On POSIX: the process group (polite
// and stubborn agents, a leader that already ended, helpers given their SIGTERM grace), and the
// pids.json sweep of groups a crashed Magnusim left behind, on proof only (never an unrelated
// group, a record of another boot, or a crashed run's record that carries this pid). No process
// is left: every pid is checked. Every agent starts with tmp: ROOT, so nothing here reads or
// removes the system temp folder's working folders.
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
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
const { resetAssistantState } = await import('../assistant/state.ts');
const { startFakeAcp } = await import('../../../e2e/support/fake-acp.mjs');
const { removeTree } = await import('../../remove-tree.js');

const WIN = process.platform === 'win32';
const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, '..', '..', '..');
const PROCESS_TS = join(HERE, '..', 'assistant', 'agents', 'process.ts');
const LAUNCH = join(HERE, '..', 'assistant', 'agents', 'launch.mjs');
// A ceiling, so a test that would hang fails instead; deaths are checked within CEILING.
const LIMIT = { timeout: 90_000 };
const CEILING = 10_000;

/** Every pid a test made, killed at the end whatever happened. */
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
  // Every pid a fake reported too, whether or not its test got to look at it.
  for (const fake of FAKES) for (const p of fake.pids()) made.add(p.pid);
  for (const pid of made) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
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

/** A spy on child_process: spawnSync calls and spawn's programs, for the ESM importers too. */
function spyChildProcess() {
  const cp = createRequire(import.meta.url)('node:child_process');
  const real = { spawn: cp.spawn, spawnSync: cp.spawnSync };
  const spy = { sync: [], spawned: [] };
  cp.spawnSync = (...a) => {
    spy.sync.push(a[0]);
    return real.spawnSync(...a);
  };
  cp.spawn = (...a) => {
    spy.spawned.push(String(a[0]));
    return real.spawn(...a);
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
describe('Windows: the job object', { ...LIMIT, skip: WIN ? false : 'Windows only (job objects)' }, () => {
  it('launch.mjs imports nothing but node: modules', () => {
    const src = readFileSync(LAUNCH, 'utf8');
    const specs = [...src.matchAll(/^\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    assert.ok(specs.length > 0);
    assert.deepEqual(
      specs.filter((s) => !s.startsWith('node:')),
      [],
    );
  });

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

  it('a warmed keeper that fails (PowerShell blocked) makes status best effort before any agent starts; a working one puts it back', async () => {
    jobWin.dropWarmKeeper();
    jobWin.warmKeeper({
      spawnImpl: () => {
        throw Object.assign(new Error('blocked by group policy'), { code: 'EACCES' });
      },
    });
    await new Promise((r) => setImmediate(r));
    assert.equal(agentProc.agentsTreeKill(), 'best_effort');
    jobWin.dropWarmKeeper();
    const keeper = jobWin.JobKeeper.start();
    cleanups.push(async () => keeper.close());
    await keeper.ready;
    made.add(keeper.pid);
    assert.equal(agentProc.agentsTreeKill(), 'job');
    keeper.close();
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
