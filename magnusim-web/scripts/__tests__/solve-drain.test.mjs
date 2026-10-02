// H15: a core solve's end. Drain only when WSL may still run; finishRun acts on its
// own run; every end releases the compute slot (scripts/w27-solve.js, finishRun).
import { after, afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-drain-'));
const PROJECTS = join(ROOT, 'projects');
mkdirSync(PROJECTS, { recursive: true });
process.env.MAGNUSIM_PROJECTS_ROOT = PROJECTS;
process.env.MAGNUSIM_LOCAL_JSON = join(ROOT, 'local.json');
process.env.MAGNUSIM_WSL_CASE_ROOT = '/home/tester/cases';

const w27 = await import('../w27-solve.js');
const layout = await import('../project-layout.js');
const studyIo = await import('../study-io.js');
const slot = await import('../compute-slot.js');
const watch = await import('../wsl-case-watch.js');
const { coreDrainNeeded, noteSolveEvent, patchRunDocIfPresent, runDocStopRequested } = w27;

after(() => {
  try {
    rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* Windows may hold a file */
  }
});

function seedRun(pid = 'proj-a', runId = 'run_1') {
  const dir = join(PROJECTS, pid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'project.json'), JSON.stringify({ id: pid, title: pid }));
  if (!existsSync(join(dir, 'geometries'))) {
    layout.createGeometryFolder(dir, { id: 'g1', name: 'G', original_filename: 'g.step' });
    layout.createStudyFolder(dir, 'g1', { id: 's1', name: 'Study 1' });
  }
  return studyIo.persistRun(pid, 's1', { id: runId, run_id: runId, name: 'Run 1', simulation_id: 's1', status: 'running', wsl_case: `cfddesk-w27-${runId}` });
}

describe('when a core run drains', () => {
  const table = [
    [{ exitCode: 0, sawResult: true, sawWslStart: true, killSent: false }, false, 'a clean end'],
    [{ exitCode: 0, sawResult: false, sawWslStart: true, killSent: true }, false, 'exit 0 means solve.sh sent its result'],
    [{ exitCode: 1, sawResult: true, sawWslStart: true, killSent: false }, false, 'a failed run that ended in order'],
    [{ exitCode: 1, sawResult: false, sawWslStart: false, killSent: false }, false, 'never reached WSL'],
    [{ exitCode: 1, sawResult: false, sawWslStart: true, killSent: false }, true, 'a relay crash after WSL started'],
    [{ exitCode: -1, sawResult: false, sawWslStart: false, killSent: true }, true, 'a forced stop'],
    [{ exitCode: -2, sawResult: false, sawWslStart: true, killSent: true }, true, 'killed by a signal'],
  ];
  for (const [args, want, why] of table) {
    it(`${why}: ${want ? 'drain' : 'no drain'}`, () => assert.equal(coreDrainNeeded(args), want));
  }

  it('solve.sh start and result events are noted', () => {
    const seen = { wslStart: false, result: false };
    noteSolveEvent(seen, { event: 'stage', stage: 'solve' });
    assert.deepEqual(seen, { wslStart: false, result: false });
    noteSolveEvent(seen, { event: 'start', run_id: 'r' });
    noteSolveEvent(seen, { event: 'result', ok: false });
    assert.deepEqual(seen, { wslStart: true, result: true });
    assert.doesNotThrow(() => noteSolveEvent(seen, null));
  });
});

describe('run doc writes of a drain', () => {
  it('patchRunDocIfPresent merges into run.json and never creates a folder', () => {
    const run = seedRun('proj-a', 'run_1');
    const out = patchRunDocIfPresent('proj-a', 'run_1', { draining: true });
    assert.equal(out.draining, true);
    assert.equal(JSON.parse(readFileSync(join(run.dir, 'run.json'), 'utf8')).draining, true);
    assert.equal(JSON.parse(readFileSync(join(run.dir, 'run.json'), 'utf8')).name, 'Run 1');
    rmSync(run.dir, { recursive: true, force: true });
    assert.equal(patchRunDocIfPresent('proj-a', 'run_1', { draining: false }), null);
    assert.ok(!existsSync(run.dir), 'no folder made again');
    assert.equal(studyIo.runFolderOf('proj-a', 'run_1'), null, 'no run of that id anywhere');
    assert.equal(patchRunDocIfPresent('no-project', 'run_9', { x: 1 }), null);
    assert.ok(!existsSync(join(PROJECTS, 'no-project')));
  });

  it('runDocStopRequested: the doc says so; a deleted run counts as a stop; an unreadable doc does not', () => {
    const run = seedRun('proj-b', 'run_2');
    assert.equal(runDocStopRequested('proj-b', 'run_2'), false);
    patchRunDocIfPresent('proj-b', 'run_2', { stop_requested: true });
    assert.equal(runDocStopRequested('proj-b', 'run_2'), true);
    writeFileSync(join(run.dir, 'run.json'), '{not json');
    // findRun reads id.json; the doc itself is unreadable.
    assert.equal(runDocStopRequested('proj-b', 'run_2'), false);
    rmSync(run.dir, { recursive: true, force: true });
    assert.equal(runDocStopRequested('proj-b', 'run_2'), true);
  });
});

// ---- finishRun itself, from the source, with stand-ins around it ----

const SRC = readFileSync(join(HERE, '..', 'w27-solve.js'), 'utf8').replace(/\r\n/g, '\n');
const FINISH = (() => {
  const start = SRC.indexOf('  const finishRun = (code, signal, errMsg) => {');
  const end = SRC.indexOf('  const { child, jobLog } = spawnJob({', start);
  return SRC.slice(start, end);
})();

/** The real forceKillDoc source, run with stand-ins (no process is started). */
function forceKillDocWith(liveRun) {
  const start = SRC.indexOf('function forceKillDoc(rec, run) {');
  const body = SRC.slice(start, SRC.indexOf('\n}\n', start) + 2);
  const spawned = [];
  const make = new Function(
    'deps',
    `let liveRun = deps.liveRun;
    const wslCaseOf = (rec, run) => (rec && rec.wsl_case) || (run && run.wsl_case) || '';
    const runIdOf = (rec) => rec && (rec.run_id || rec.id);
    const invalidateWslLive = () => {};
    const stopHookArgs = () => [];
    const coreOwner = () => null;
    const spawn = (...a) => deps.spawned.push(a);
    const PYTHON = 'python';
    const pyTool = (n) => n;
    const processNamesArgs = () => [];
    const wslCasePath = (id) => '/r/' + id;
    const WSL_DISTRO = 'Ubuntu';
    ${body}
    return forceKillDoc;`,
  );
  return { forceKillDoc: make({ liveRun, spawned }), spawned };
}

describe('a forced stop marks the kill (so its end drains)', () => {
  it('kill_sent on the run given, or on the live run of that id; never on another run', () => {
    const run = { run_id: 'run_1', wsl_case: 'cfddesk-w27-run_1', child: { kill() {} }, kill_sent: false };
    const a = forceKillDocWith(null);
    a.forceKillDoc({ run_id: 'run_1', wsl_case: 'cfddesk-w27-run_1' }, run);
    assert.equal(run.kill_sent, true);
    assert.equal(a.spawned.length, 1, 'stop_solve.py --force');
    // The grace timer's kill passes no run: the live run of that id is marked.
    const live = { run_id: 'run_2', wsl_case: 'cfddesk-w27-run_2', child: { kill() {} }, kill_sent: false };
    forceKillDocWith(live).forceKillDoc({ run_id: 'run_2', wsl_case: 'cfddesk-w27-run_2' }, null);
    assert.equal(live.kill_sent, true);
    const other = { run_id: 'run_3', child: { kill() {} }, kill_sent: false };
    forceKillDocWith(other).forceKillDoc({ run_id: 'run_4', wsl_case: 'cfddesk-w27-run_4' }, null);
    assert.equal(other.kill_sent, false);
  });
});

describe('finishRun (source)', () => {
  it('acts on its own run, drains only when needed, releases in finally', () => {
    assert.ok(FINISH.length > 500);
    assert.match(FINISH, /const run = thisRun;/);
    assert.match(FINISH, /if \(liveRun === run\) liveRun = null;/);
    assert.ok(!/liveRun\.(stop_requested|baseRunning|progress|stop_timer)/.test(FINISH), 'reads from thisRun, never from liveRun');
    assert.match(FINISH, /coreDrainNeeded\(\{ exitCode: exit_code, sawResult: seen\.result, sawWslStart: seen\.wslStart, killSent: !!\(run && run\.kill_sent\) \}\)/);
    assert.match(FINISH, /draining: true, wsl_case: wslCaseId/);
    assert.match(FINISH, /stop: \(\) => runDocStopRequested\(id, runId\)/);
    assert.match(FINISH, /onGone: \(\) => patchRunDocIfPresent\(id, runId, \{ draining: false \}\)/);
    assert.match(FINISH, /finally \{\s*if \(!watching\) releaseComputeSlot\(token\);/);
    const iPatch = FINISH.indexOf("patchComputeSlot(token, { phase: 'draining'");
    const iPersist = FINISH.indexOf('persistRunDoc(id, {');
    const iWatch = FINISH.indexOf('watchWslCaseGone({');
    assert.ok(iPatch > 0 && iPatch < iPersist && iPersist < iWatch);
  });
});

/** The real finishRun source, run with these stand-ins. */
function finishRunWith(over = {}) {
  const deps = {
    slot: { token: over.token },
    snapshotProgress: () => ({ stage: 'solve', residuals: [] }),
    parseSolveProgress: () => ({ stage: 'solve', residuals: [] }),
    prepResult: { analysis_key: 'k' },
    listSavedTimes: () => [],
    winOut: 'C:/run/case',
    isTransient: false,
    coreDrainNeeded,
    patchComputeSlot: slot.patchComputeSlot,
    persistRunDoc: () => {},
    id: 'proj-a',
    solver: 'simpleFoam',
    wslCaseId: 'cfddesk-w27-run_1',
    invalidateLiveSolveCache: () => {},
    onDone: () => {},
    runId: 'run_1',
    draft: { name: 'Run 1' },
    watchWslCaseGone: watch.watchWslCaseGone,
    runDocStopRequested: () => false,
    patchRunDocIfPresent: () => null,
    pushComputeNotice: () => {},
    LOST_TEXT: watch.LOST_TEXT,
    releaseComputeSlot: slot.releaseComputeSlot,
    scheduleComputeQueueKick: () => {},
    thisRun: null,
    otherLive: null,
    seen: { wslStart: false, result: false },
    ...over,
  };
  const make = new Function(
    'deps',
    `const { slot, snapshotProgress, parseSolveProgress, prepResult, listSavedTimes, winOut, isTransient, coreDrainNeeded,
      patchComputeSlot, persistRunDoc, id, solver, wslCaseId, invalidateLiveSolveCache, onDone, runId, draft,
      watchWslCaseGone, runDocStopRequested, patchRunDocIfPresent, pushComputeNotice, LOST_TEXT, releaseComputeSlot,
      scheduleComputeQueueKick, seen } = deps;
    const runTail = { text: () => '' };
    let thisRun = deps.thisRun;
    let liveRun = deps.otherLive || deps.thisRun;
    let runFinished = false;
    ${FINISH}
    return { finishRun, liveRun: () => liveRun };`,
  );
  return make(deps);
}

describe('finishRun releases on every end', () => {
  beforeEach(() => slot.resetComputeSlotForTests());
  afterEach(() => mock.timers.reset());

  it('no drain: onDone throws and the slot is free; liveRun cleared only when it is this run', () => {
    const c = slot.claimComputeSlot('solve', { project_id: 'proj-a', run_id: 'run_1' }, { phase: 'running' });
    const run = { run_id: 'run_1', slot_token: c.token, baseRunning: { name: 'Run 1' }, stop_requested: false };
    const persisted = [];
    const f = finishRunWith({
      token: c.token,
      thisRun: run,
      persistRunDoc: (pid, doc) => persisted.push(doc),
      onDone: () => {
        throw new Error('onDone failed');
      },
      seen: { wslStart: true, result: true },
    });
    f.finishRun(0, null, null);
    assert.equal(slot.computeSlotHolder(), null);
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].status, 'done');
    assert.equal(persisted[0].draining, undefined);
    assert.equal(f.liveRun(), null);
    // Another run is live by now: it is left alone.
    const other = { run_id: 'run_2' };
    const c2 = slot.claimComputeSlot('solve', { project_id: 'proj-a', run_id: 'run_1' });
    const g = finishRunWith({ token: c2.token, thisRun: { run_id: 'run_1', slot_token: c2.token }, otherLive: other });
    g.finishRun(0, null, null);
    assert.equal(g.liveRun(), other);
  });

  it('drain: the slot stays held (draining) until WSL is gone; an onGone that throws still frees it', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000 });
    const c = slot.claimComputeSlot('solve', { project_id: 'proj-a', run_id: 'run_1' }, { phase: 'running' });
    const run = { run_id: 'run_1', slot_token: c.token, kill_sent: true, stop_requested: true, baseRunning: {} };
    const persisted = [];
    let probes = 0;
    const f = finishRunWith({
      token: c.token,
      thisRun: run,
      persistRunDoc: (pid, doc) => persisted.push(doc),
      watchWslCaseGone: (opts) =>
        watch.watchWslCaseGone({
          ...opts,
          probe: async () => {
            probes += 1;
            return 'dead';
          },
        }),
      patchRunDocIfPresent: () => {
        throw new Error('run.json locked');
      },
    });
    f.finishRun(-1, null, null);
    const h = slot.computeSlotHolder();
    assert.deepEqual([h.phase, h.stop_requested], ['draining', true]);
    assert.equal(persisted[0].draining, true);
    assert.equal(persisted[0].wsl_case, 'cfddesk-w27-run_1');
    assert.equal(persisted[0].status, 'stopped');
    for (let i = 0; i < 2; i += 1) {
      mock.timers.tick(2_000);
      for (let k = 0; k < 5; k += 1) await new Promise((r) => setImmediate(r));
    }
    assert.equal(probes, 2);
    assert.equal(slot.computeSlotHolder(), null, 'released although onGone threw');
  });

  it('a drain whose watch cannot start releases in finally', () => {
    const c = slot.claimComputeSlot('solve', { project_id: 'proj-a', run_id: 'run_1' });
    const f = finishRunWith({
      token: c.token,
      thisRun: { run_id: 'run_1', slot_token: c.token },
      seen: { wslStart: true, result: false },
      watchWslCaseGone: () => {
        throw new Error('no watch');
      },
    });
    f.finishRun(1, null, null);
    assert.equal(slot.computeSlotHolder(), null);
  });

  it('a persist that throws still frees the slot', () => {
    const c = slot.claimComputeSlot('solve', { project_id: 'proj-a', run_id: 'run_1' });
    const f = finishRunWith({
      token: c.token,
      thisRun: { run_id: 'run_1', slot_token: c.token },
      persistRunDoc: () => {
        throw new Error('disk');
      },
    });
    f.finishRun(0, null, null);
    assert.equal(slot.computeSlotHolder(), null);
  });
});

// ---- hardwareRankCap: resolveNProcs gives the same ranks as before ----

/** resolveNProcs as it was at c6ffe2f (HEAD before H15). */
const OLD_RESOLVE = `function resolveNProcs(nCells, opts) {
  const n = Number(nCells) || 0;
  const threshold = opts && opts.transient ? TRANSIENT_LARGE_MESH_CELLS : LARGE_MESH_CELLS;
  if (n > 0 && n < threshold) return 1;
  const logical = Math.max(1, (cpus() || []).length);
  let nProcs;
  if (PHYSICAL_CORES >= 1) nProcs = Math.max(2, Math.min(PHYSICAL_CORES, logical));
  else nProcs = Math.max(2, logical >= 8 ? Math.floor(logical / 2) : logical);
  const hw = hardwarePrefs();
  const cap = hw && Number(hw.n_procs);
  if (Number.isFinite(cap) && cap >= 1) nProcs = Math.min(nProcs, Math.floor(cap));
  const savedSlots = hw && Number(hw.wsl_mpi_slots);
  const liveSlots = probeWslMpiSlots(WSL_DISTRO);
  const slots = liveSlots >= 1 ? liveSlots : Number.isFinite(savedSlots) && savedSlots >= 1 ? Math.floor(savedSlots) : 0;
  if (slots >= 1) nProcs = Math.min(nProcs, slots);
  return Math.max(1, nProcs);
}`;

function fnSource(name, from) {
  const start = from.indexOf(name);
  return from.slice(start, from.indexOf('\n}\n', start) + 2);
}

describe('hardwareRankCap', () => {
  it('keeps resolveNProcs results (fake cpus, prefs and WSL slots)', () => {
    const newResolve = fnSource('function resolveNProcs(', SRC);
    const cap = fnSource('export function hardwareRankCap(', SRC).replace('export function', 'function');
    assert.match(newResolve, /let nProcs = hardwareRankCap\(\);/);
    const build = (body) =>
      new Function('env', `const { cpus, hardwarePrefs, probeWslMpiSlots, PHYSICAL_CORES } = env;
        const TRANSIENT_LARGE_MESH_CELLS = 50000, LARGE_MESH_CELLS = 200000, WSL_DISTRO = 'Ubuntu';
        ${body}
        return resolveNProcs;`);
    const oldFn = (env) => build(OLD_RESOLVE)(env);
    const newFn = (env) => build(`${cap}\n${newResolve}`)(env);
    let checked = 0;
    for (const logical of [1, 2, 4, 8, 16, 32]) {
      for (const physical of [0, 1, 4, 16]) {
        for (const hw of [null, { n_procs: 3 }, { n_procs: 0 }, { wsl_mpi_slots: 6 }, { n_procs: 12, wsl_mpi_slots: 4 }]) {
          for (const live of [0, 2, 64]) {
            for (const cells of [0, 1000, 60000, 300000]) {
              for (const transient of [false, true]) {
                const env = { cpus: () => new Array(logical).fill({}), hardwarePrefs: () => hw, probeWslMpiSlots: () => live, PHYSICAL_CORES: physical };
                assert.equal(newFn(env)(cells, { transient }), oldFn(env)(cells, { transient }), JSON.stringify({ logical, physical, hw, live, cells, transient }));
                checked += 1;
              }
            }
          }
        }
      }
    }
    assert.ok(checked > 1000);
    // And the cap alone never asks WSL.
    assert.ok(!/probeWslMpiSlots|spawnSync/.test(cap));
    assert.equal(typeof w27.hardwareRankCap(), 'number');
  });
});
