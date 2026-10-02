// H15: probing, killing and waiting for one WSL case copy's processes (scripts/wsl-case-watch.js).
import { after, afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-watch-'));
process.env.MAGNUSIM_PROJECTS_ROOT = join(ROOT, 'projects');
process.env.MAGNUSIM_LOCAL_JSON = join(ROOT, 'local.json');
// The configured WSL case root: no `wsl printenv HOME` probe in this test.
process.env.MAGNUSIM_WSL_CASE_ROOT = '/home/tester/cases-configured';

const watchMod = await import('../wsl-case-watch.js');
const { KILL_EVERY_MS, MAX_KILLS, UNREACHABLE_MS, WATCH_EVERY_MS, killWslCase, parseProbeAnswer, probeWslCase, setCaseProcsSpawnForTests, watchWslCaseGone } =
  watchMod;
const { claimComputeSlot, computeSlotHolder, releaseComputeSlot, resetComputeSlotForTests } = await import('../compute-slot.js');

after(() => {
  setCaseProcsSpawnForTests(null);
  rmSync(ROOT, { recursive: true, force: true });
});

afterEach(() => {
  mock.timers.reset();
  resetComputeSlotForTests();
});

const flush = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
};

/** Advance the fake clock by one watch period and let the probe answer. */
async function step(n = 1) {
  for (let i = 0; i < n; i += 1) {
    mock.timers.tick(WATCH_EVERY_MS);
    await flush();
  }
}

function harness(opts = {}) {
  const calls = { probes: 0, kills: [], gone: 0, lost: [], release: 0 };
  const state = { answer: opts.answer || 'live', stop: !!opts.stop, current: true };
  const c = claimComputeSlot('solve', { project_id: 'p', run_id: 'r1' }, { phase: 'draining' });
  const handle = watchWslCaseGone({
    token: c.token,
    wslCase: 'cfddesk-w27-r1',
    scripts: ['solve-r1.sh'],
    root: '/r',
    stop: () => {
      if (opts.stopThrows) throw new Error('doc unreadable');
      return state.stop;
    },
    onGone: () => {
      calls.gone += 1;
      if (opts.goneThrows) throw new Error('patch failed');
    },
    onLost: (reason) => {
      calls.lost.push(reason);
      if (opts.lostThrows) throw new Error('notice failed');
    },
    isCurrent: opts.isCurrent ? () => state.current : undefined,
    release: opts.defaultRelease
      ? undefined
      : () => {
          calls.release += 1;
        },
    probe: async (a) => {
      calls.probes += 1;
      assert.equal(a.wslCase, 'cfddesk-w27-r1');
      assert.equal(a.root, '/r');
      return typeof state.answer === 'function' ? state.answer() : state.answer;
    },
    kill: (a) => calls.kills.push({ at: Date.now(), ...a }),
  });
  return { calls, state, token: c.token, handle };
}

describe('watchWslCaseGone', () => {
  it('two dead probes in a row end it: onGone, then the release, once', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    const seq = ['dead', 'live', 'dead', 'dead', 'dead'];
    const { calls } = harness({ answer: () => seq.shift() || 'dead' });
    await step(3);
    assert.equal(calls.gone, 0, 'a live probe between two dead ones');
    await step(1);
    assert.equal(calls.gone, 1);
    assert.equal(calls.release, 1);
    await step(5);
    assert.equal(calls.probes, 4, 'no probe after the end');
    assert.equal(calls.release, 1);
  });

  it('a Stop is read at every probe: a kill on the next live, then at most every 30 s', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    const { calls, state } = harness({ answer: 'live' });
    await step(3);
    assert.equal(calls.kills.length, 0, 'no stop yet');
    state.stop = true;
    await step(1);
    assert.equal(calls.kills.length, 1);
    assert.deepEqual(calls.kills[0].scripts, ['solve-r1.sh']);
    assert.equal(calls.kills[0].root, '/r');
    const first = calls.kills[0].at;
    await step(KILL_EVERY_MS / WATCH_EVERY_MS - 1);
    assert.equal(calls.kills.length, 1, 'not again within 30 s');
    await step(1);
    assert.equal(calls.kills.length, 2);
    assert.ok(calls.kills[1].at - first >= KILL_EVERY_MS);
  });

  it('still live after 5 kills: onLost("stuck") once, then the release', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    const { calls } = harness({ answer: 'live', stop: true, lostThrows: true });
    await step((MAX_KILLS + 1) * (KILL_EVERY_MS / WATCH_EVERY_MS) + 2);
    assert.equal(calls.kills.length, MAX_KILLS);
    assert.deepEqual(calls.lost, ['stuck']);
    assert.equal(calls.release, 1, 'released although onLost threw');
    await step(20);
    assert.deepEqual(calls.lost, ['stuck']);
  });

  it('unknown for 10 minutes in a row: onLost("unreachable") once; a known answer restarts the count', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    let n = 0;
    // Probe 250 (at 500 s) answers live: the count starts again at probe 251.
    const { calls } = harness({ answer: () => (++n === 250 ? 'live' : 'unknown') });
    await step(UNREACHABLE_MS / WATCH_EVERY_MS - 10);
    assert.deepEqual(calls.lost, []);
    await step(150);
    assert.deepEqual(calls.lost, [], 'the live answer at probe 250 restarted the 10 minutes');
    await step(UNREACHABLE_MS / WATCH_EVERY_MS);
    assert.deepEqual(calls.lost, ['unreachable']);
    assert.equal(calls.release, 1);
  });

  it('a dead answer also restarts the unknown count: unknown, dead, unknown across 10 minutes is not "unreachable"', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    let n = 0;
    // Probe 200 (at 400 s) answers dead, once: no two dead in a row, and the 10 minutes start again.
    const { calls } = harness({ answer: () => (++n === 200 ? 'dead' : 'unknown') });
    await step(UNREACHABLE_MS / WATCH_EVERY_MS + 100);
    assert.deepEqual(calls.lost, [], 'about 13 minutes of unknown with one dead in the middle');
    assert.equal(calls.gone, 0);
    await step(UNREACHABLE_MS / WATCH_EVERY_MS);
    assert.deepEqual(calls.lost, ['unreachable']);
  });

  it('two dead answers count only in a row: dead, unknown, dead is not gone', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    const answers = ['dead', 'unknown', 'dead', 'unknown', 'dead', 'unknown'];
    const { calls } = harness({ answer: () => answers.shift() || 'live' });
    await step(8);
    assert.equal(calls.gone, 0, 'WSL state was unknown between the two dead answers');
    assert.equal(calls.release, 0);
  });

  it('when the slot moved on it ends silently: no kill, no callback, no release', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    const { calls, state } = harness({ answer: 'live', stop: true, isCurrent: true });
    state.current = false;
    await step(5);
    assert.equal(calls.probes, 0);
    assert.equal(calls.kills.length, 0);
    assert.equal(calls.gone + calls.lost.length + calls.release, 0);
  });

  it('isCurrent defaults to "my token still holds the slot"; the default release frees the slot', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    const { calls, token } = harness({ answer: 'dead', defaultRelease: true });
    await step(2);
    assert.equal(calls.gone, 1);
    assert.equal(computeSlotHolder(), null, 'released by the watch');
    // A watch whose token is no longer current does nothing.
    const other = harness({ answer: 'live', stop: true, defaultRelease: true });
    releaseComputeSlot(other.token);
    claimComputeSlot('mesh', { project_id: 'q' });
    await step(3);
    assert.equal(other.calls.kills.length, 0);
    assert.equal(other.calls.probes, 0);
    assert.notEqual(token, other.token);
  });

  it('onGone that throws still releases once; a stop() that throws counts as no stop', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    const a = harness({ answer: 'dead', goneThrows: true });
    await step(2);
    assert.equal(a.calls.gone, 1);
    assert.equal(a.calls.release, 1);
    resetComputeSlotForTests();
    const b = harness({ answer: 'live', stopThrows: true });
    await step(4);
    assert.equal(b.calls.kills.length, 0);
  });
});

function fakeChild(stdoutText, { error = false, never = false } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
  };
  setImmediate(() => {
    if (never) return;
    if (error) {
      child.emit('error', new Error('ENOENT'));
      child.emit('close', -4058);
      return;
    }
    if (stdoutText) child.stdout.emit('data', Buffer.from(stdoutText));
    child.emit('close', 0);
  });
  return child;
}

describe('probeWslCase and killWslCase', () => {
  it('pass the configured WSL root when none is given, and read the answer', async () => {
    const spawned = [];
    setCaseProcsSpawnForTests((cmd, args, opts) => {
      spawned.push({ cmd, args, env: opts.env });
      return fakeChild('noise\n{"ok":true,"live":true}\n');
    });
    assert.equal(await probeWslCase({ wslCase: 'cfddesk-w27-r1', scripts: ['solve-r1.sh'] }), 'live');
    assert.equal(spawned[0].env.MAGNUSIM_WSL_CASE_ROOT, '/home/tester/cases-configured');
    assert.deepEqual(spawned[0].args.slice(1), ['probe', '--wsl-case', 'cfddesk-w27-r1', '--script', 'solve-r1.sh']);
    assert.match(spawned[0].args[0], /wsl_case_procs\.py$/);
    await probeWslCase({ wslCase: 'cfddesk-pf-x-y-0011aabb', scripts: [], root: '/given' });
    assert.equal(spawned[1].env.MAGNUSIM_WSL_CASE_ROOT, '/given');
    killWslCase({ wslCase: 'cfddesk-w27-r1', scripts: ['solve-r1.sh'], names: ['simpleFoam', 'mpirun'] });
    assert.deepEqual(spawned[2].args.slice(1), ['kill', '--wsl-case', 'cfddesk-w27-r1', '--script', 'solve-r1.sh', '--names', 'simpleFoam,mpirun']);
    assert.equal(spawned[2].env.MAGNUSIM_WSL_CASE_ROOT, '/home/tester/cases-configured');
  });

  it('never rejects: a bad answer, a WSL failure, a spawn error or a timeout is unknown', async () => {
    assert.equal(parseProbeAnswer('{"ok":true,"live":false}'), 'dead');
    assert.equal(parseProbeAnswer('{"ok":false}'), 'unknown');
    assert.equal(parseProbeAnswer('{"ok":true,"live":false,"invalid_id":true}'), 'dead');
    assert.equal(parseProbeAnswer('garbage'), 'unknown');
    setCaseProcsSpawnForTests(() => fakeChild('{"ok":false}\n'));
    assert.equal(await probeWslCase({ wslCase: 'cfddesk-w27-r1' }), 'unknown');
    setCaseProcsSpawnForTests(() => fakeChild('', { error: true }));
    assert.equal(await probeWslCase({ wslCase: 'cfddesk-w27-r1' }), 'unknown');
    setCaseProcsSpawnForTests(() => {
      throw new Error('spawn EPERM');
    });
    assert.equal(await probeWslCase({ wslCase: 'cfddesk-w27-r1' }), 'unknown');
    assert.doesNotThrow(() => killWslCase({ wslCase: 'cfddesk-w27-r1' }));
    let child = null;
    setCaseProcsSpawnForTests(() => (child = fakeChild('', { never: true })));
    mock.timers.enable({ apis: ['setTimeout'] });
    const p = probeWslCase({ wslCase: 'cfddesk-w27-r1' });
    mock.timers.tick(15_000);
    assert.equal(await p, 'unknown');
    assert.equal(child.killed, true);
  });
});
