// H15: the step-list runner and plugin OpenFOAM cases in Node (scripts/foam-runner.js).
import { after, afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-runner-'));
const PROJECTS = join(ROOT, 'projects');
mkdirSync(PROJECTS, { recursive: true });
process.env.MAGNUSIM_PROJECTS_ROOT = PROJECTS;
process.env.MAGNUSIM_LOCAL_JSON = join(ROOT, 'local.json');
process.env.MAGNUSIM_WSL_CASE_ROOT = '/home/tester/cases';
process.env.MAGNUSIM_QUEUE_QUIET = '1';

const runner = await import('../../foam-runner.js');
const store = await import('../../foam-store.js');
const slot = await import('../../compute-slot.js');
const queue = await import('../compute-queue.ts');

const {
  activeCaseKeys,
  adoptFoamCase,
  buildFoamSpec,
  bumpPluginEpoch,
  caseFolderProblem,
  finishFoam,
  foamEndFromEvidence,
  foamRunPhase,
  foamWslCaseId,
  foldFoamEvent,
  newFoamFold,
  onQueueLeave,
  pluginEpoch,
  reconcileFoamQueue,
  registerStepRunKind,
  relayEvent,
  resetFoamRunnerForTests,
  runFoamSteps,
  setFoamRunnerDepsForTests,
  startFoam,
  stopFoamCase,
  stopFoamCasesFor,
  studyHasActiveCase,
} = runner;
const { createFoamRecord, foamEventBus, readFoamRecord, resetFoamStoreForTests, updateFoamRecord } = store;
const { computeSlotHolder, claimComputeSlot, resetComputeSlotForTests, releaseComputeSlot } = slot;

const PLUGIN_DIR = join(PROJECTS, 'p1', 'plugins', 'foam-demo');
const SPECS = join(ROOT, 'foam-specs');

after(() => rmSync(ROOT, { recursive: true, force: true }));

/** @type {any} */
let fx;

function makeCase(name) {
  const dir = join(PLUGIN_DIR, 'studies', 's1', 'cases', name);
  mkdirSync(join(dir, 'system'), { recursive: true });
  writeFileSync(join(dir, 'system', 'controlDict'), 'application pimpleFoam;\n');
  return dir;
}

function newCase(name, extra = {}) {
  const caseDir = makeCase(name);
  const token = extra.token || '0011aabb';
  const rowId = `q-test${name}`;
  const rec = createFoamRecord({
    kind: 'foam',
    project_id: 'p1',
    plugin: 'foam-demo',
    plugin_name: 'Foam demo',
    study_id: 's1',
    study_title: 'Cavity case 1',
    case_rel: `cases/${name}`,
    case_parts: ['studies', 's1', 'cases', name],
    case_key: `studies/s1/cases/${name}`,
    case_dir: caseDir,
    case_base: PLUGIN_DIR,
    token,
    wsl_case: foamWslCaseId('foam-demo', 's1', token),
    wsl_root: '/home/tester/cases',
    app: 'pimpleFoam',
    n_procs: 4,
    pre: [{ tool: 'blockMesh', args: [], parallel: false }],
    results: { rho: 1, kinematic_fields: ['p'], frame_fields: ['U', 'p'] },
    launch: { keep_frames: 'all', process_names: ['pimpleFoam'], stop_strategy: 'stopAt_writeNow', parallel: 'mpirun', time_dependency: 'transient', write_format: 'binary' },
    row_id: rowId,
    ...extra,
  });
  queue.enqueueFoamJob({ id: rowId, kind: 'foam', project_id: 'p1', name: `Cavity case 1 · ${name} · Foam demo`, job_id: rec.id, foam: { plugin: 'foam-demo', study_id: 's1' } });
  return { rec, row: queue.snapshotComputeQueue().items.find((r) => r.id === rowId) };
}

function writeStatus(caseDir, doc) {
  writeFileSync(join(caseDir, '.magnusim-run.json'), JSON.stringify(doc));
}

// A clock like the real one (job ids carry Date.now() in base 36).
const NOW = 1_759_300_000_000;

beforeEach(() => {
  // Each test starts from no records and no case folders.
  rmSync(join(ROOT, 'foam-cases.json'), { force: true });
  rmSync(join(PLUGIN_DIR, 'studies', 's1', 'cases'), { recursive: true, force: true });
  mkdirSync(join(PROJECTS, 'p1'), { recursive: true });
  writeFileSync(join(PROJECTS, 'p1', 'project.json'), '{"id":"p1"}');
  mkdirSync(join(PLUGIN_DIR, 'studies', 's1'), { recursive: true });
  writeFileSync(join(PLUGIN_DIR, 'studies', 's1', 'study.json'), '{"id":"s1"}');
  resetFoamStoreForTests({ filePath: join(ROOT, 'foam-cases.json') });
  resetComputeSlotForTests();
  queue.resetComputeQueueForTests({ filePath: join(ROOT, 'queue.json'), items: [], deps: {} });
  resetFoamRunnerForTests();
  // The runner's own handlers for plugin cases, as at module load.
  registerStepRunKind('foam', { onEvent: (rec, ev) => store.emitFoamEvent(rec.id, ev), onEnd: () => {} });
  fx = {
    spawned: [],
    watches: [],
    kills: [],
    relayKills: [],
    probes: [],
    notices: [],
    alive: true,
    probeAnswer: 'dead',
    registryLoaded: true,
    pluginOn: true,
    events: [],
  };
  foamEventBus().on('event', (m) => fx.events.push(m));
  setFoamRunnerDepsForTests({
    spawnJob: (opts) => {
      if (fx.spawnThrows) throw new Error('spawn EPERM');
      fx.spawned.push(opts);
      return { child: { pid: 4242 } };
    },
    watchWslCaseGone: (opts) => {
      fx.watches.push(opts);
      return { cancel() {} };
    },
    killWslCase: (opts) => fx.kills.push(opts),
    probeWslCase: async (opts) => {
      fx.probes.push(opts);
      return fx.probeAnswer;
    },
    relayAlive: async () => fx.alive,
    killRelay: (id) => fx.relayKills.push(id),
    pushComputeNotice: (n) => fx.notices.push(n),
    liveRegistryLoaded: () => fx.registryLoaded,
    pluginLoaded: (key) => (fx.pluginOn && key === 'foam-demo' ? { key, name: 'Foam demo', version: '1.0.0' } : null),
    solverForApplication: (app) => (app === 'pimpleFoam' ? { key: 'pimpleFoam', application: 'pimpleFoam', time_dependency: 'transient', parallel: 'mpirun', stop_strategy: 'stopAt_writeNow' } : null),
    hardwareRankCap: () => 3,
    slotsHint: () => 8,
    hookNames: () => [],
    specDir: () => SPECS,
  });
});

afterEach(() => {
  mock.timers.reset();
  setFoamRunnerDepsForTests(null);
  resetFoamRunnerForTests();
  foamEventBus().removeAllListeners();
});

const frames = (id) => fx.events.filter((m) => m.job_id === id).map((m) => m.ev);

describe('startFoam and runFoamSteps', () => {
  it('make no RPC and have no await (source scan); they return synchronously', () => {
    const src = readFileSync(join(HERE, '..', '..', 'foam-runner.js'), 'utf8').replace(/\r\n/g, '\n');
    for (const name of ['export function runFoamSteps(', 'export function startFoam(']) {
      const start = src.indexOf(name);
      assert.ok(start > 0, name);
      const end = src.indexOf('\n}\n', start);
      const body = src.slice(start, end).replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      assert.ok(!/\bawait\b|\basync\b/.test(body), `${name} has no await`);
      assert.ok(!/\.call\(|worker|fetch\(/.test(body), `${name} makes no RPC`);
    }
    const { row } = newCase('c1');
    const out = startFoam(row);
    assert.ok(!(out instanceof Promise));
    assert.deepEqual(out, { ok: true });
  });

  it('a start: the claim at the spawn, the record running before it, the spec file, the w27-case sidecar', () => {
    const { rec, row } = newCase('c1');
    let statusAtSpawn = null;
    let holderAtSpawn = null;
    setFoamRunnerDepsForTests({
      ...runnerDeps(),
      spawnJob: (opts) => {
        statusAtSpawn = readFoamRecord(rec.id).status;
        holderAtSpawn = computeSlotHolder();
        fx.spawned.push(opts);
        return { child: { pid: 1 } };
      },
    });
    assert.deepEqual(startFoam(row), { ok: true });
    assert.equal(statusAtSpawn, 'running');
    assert.equal(holderAtSpawn.kind, 'foam');
    assert.equal(holderAtSpawn.job_id, rec.id);
    assert.equal(holderAtSpawn.phase, 'running');
    assert.equal(holderAtSpawn.name, 'Cavity case 1 · c1 · Foam demo');
    const spawn = fx.spawned[0];
    assert.deepEqual(spawn.args, ['--launch', '--spec', join(SPECS, `${rec.id}.json`)]);
    assert.match(spawn.script, /run_foam_case\.py$/);
    assert.equal(typeof spawn.onClose, 'function');
    const spec = JSON.parse(readFileSync(join(SPECS, `${rec.id}.json`), 'utf8'));
    assert.equal(spec.v, 1);
    assert.equal(spec.kind, 'foam');
    assert.equal(spec.n_procs, 3, 'clamped to the hardware cap');
    assert.equal(spec.slots_hint, 8);
    assert.deepEqual(spec.solver, { app: 'pimpleFoam', keep_frames: 'all', frame_fields: ['U', 'p'], process_names: ['pimpleFoam'], stop_strategy: 'stopAt_writeNow', parallel: 'mpirun' });
    assert.equal(spec.owner, null, 'no hooks listening');
    const side = JSON.parse(readFileSync(join(rec.case_dir, 'w27-case.json'), 'utf8'));
    assert.deepEqual(side, { kinematic_fields: ['p'], frame_fields: ['U', 'p'], app: 'pimpleFoam', plugin: 'foam-demo', study_id: 's1', rho: 1 });
    assert.deepEqual(frames(rec.id).map((e) => e.event), ['start']);
  });

  it('ranks: a serial solver runs on 1 unless a WSL step runs in parallel (then n_procs, capped)', () => {
    const serial = {
      ...runnerDeps(),
      solverForApplication: (app) => (app === 'pimpleFoam' ? { application: 'pimpleFoam', time_dependency: 'steady', parallel: 'none', stop_strategy: 'stopAt_writeNow' } : null),
    };
    setFoamRunnerDepsForTests(serial);
    const span = newCase('c1', {
      n_procs: 2,
      launch: { keep_frames: 'all', process_names: ['pimpleFoam'], stop_strategy: 'stopAt_writeNow', parallel: 'none' },
      pre: [{ tool: 'blockMesh', args: [], parallel: false }, { tool: 'decomposePar', args: [], parallel: false }, { tool: 'renumberMesh', args: ['-overwrite'], parallel: true }, { tool: 'reconstructParMesh', args: ['-constant'], parallel: false }],
    });
    assert.deepEqual(startFoam(span.row), { ok: true });
    const spec = JSON.parse(readFileSync(join(SPECS, `${span.rec.id}.json`), 'utf8'));
    assert.equal(spec.n_procs, 2, 'the parallel step gets its ranks');
    assert.equal(spec.solver.parallel, 'none', 'the solver itself stays serial');
    releaseComputeSlot(computeSlotHolder().token);
    const plain = newCase('c2', { n_procs: 2, launch: { keep_frames: 'all', process_names: ['pimpleFoam'], stop_strategy: 'stopAt_writeNow', parallel: 'none' } });
    assert.deepEqual(startFoam(plain.row), { ok: true });
    assert.equal(JSON.parse(readFileSync(join(SPECS, `${plain.rec.id}.json`), 'utf8')).n_procs, 1, 'nothing runs in parallel');
    releaseComputeSlot(computeSlotHolder().token);
    const many = newCase('c3', {
      n_procs: 16,
      launch: { keep_frames: 'all', process_names: ['pimpleFoam'], stop_strategy: 'stopAt_writeNow', parallel: 'none' },
      pre: [{ tool: 'renumberMesh', args: ['-overwrite'], parallel: true }],
    });
    assert.deepEqual(startFoam(many.row), { ok: true });
    assert.equal(JSON.parse(readFileSync(join(SPECS, `${many.rec.id}.json`), 'utf8')).n_procs, 3, 'capped by hardwareRankCap');
  });

  it('every refusal takes no claim; the plugin list not loaded yet is a hold, not busy', () => {
    const { rec, row } = newCase('c1');
    fx.registryLoaded = false;
    const held = startFoam(row);
    assert.deepEqual(held, { ok: false, error: 'The plugin list is not loaded yet' });
    assert.equal(held.busy, undefined);
    assert.equal(computeSlotHolder(), null);
    assert.equal(readFoamRecord(rec.id).status, 'queued');
    fx.registryLoaded = true;
    const other = claimComputeSlot('mesh', { project_id: 'p9' });
    assert.deepEqual(startFoam(row), { busy: true });
    assert.deepEqual(runFoamSteps({ job_id: rec.id }), { busy: true });
    releaseComputeSlot(other.token);
    assert.deepEqual(startFoam({ ...row, id: 'q-not-queued' }), { missing: true });
    fx.pluginOn = false;
    const off = startFoam(row);
    assert.equal(off.final, true);
    assert.equal(off.error, 'Foam demo is off. Turn it on in Settings → Plugins');
    assert.equal(readFoamRecord(rec.id).code, 'plugin_off');
    assert.equal(computeSlotHolder(), null);
    // The others, each on its own case.
    fx.pluginOn = true;
    const app = newCase('c2', { app: 'icoFoam' });
    assert.equal(startFoam(app.row).error, 'icoFoam is no longer a registered solver');
    const gone = newCase('c3');
    rmSync(gone.rec.case_dir, { recursive: true, force: true });
    assert.equal(startFoam(gone.row).error, 'cases/c3 is missing');
    const study = newCase('c4', { study_id: 's-gone' });
    assert.equal(startFoam(study.row).error, 'The study was deleted');
    assert.equal(computeSlotHolder(), null);
    assert.equal(fx.spawned.length, 0);
  });

  it('a link inside the case path is refused (a junction on Windows)', () => {
    const real = join(ROOT, 'elsewhere');
    mkdirSync(real, { recursive: true });
    mkdirSync(join(PLUGIN_DIR, 'studies', 's1', 'cases'), { recursive: true });
    symlinkSync(real, join(PLUGIN_DIR, 'studies', 's1', 'cases', 'lnk'), process.platform === 'win32' ? 'junction' : 'dir');
    const p = { project_id: 'p1', kind: 'foam', plugin: 'foam-demo', case_base: PLUGIN_DIR, case_parts: ['studies', 's1', 'cases', 'lnk'], case_dir: join(PLUGIN_DIR, 'studies', 's1', 'cases', 'lnk') };
    assert.equal(caseFolderProblem(p).code, 'invalid_path');
    assert.equal(caseFolderProblem({ ...p, case_base: join(PROJECTS, 'p1') }).code, 'invalid_path', 'a plugin case lies in its plugin folder');
    assert.equal(caseFolderProblem({ ...p, case_parts: ['..', 'x'] }).code, 'invalid_path');
  });

  it('a spawn that throws: the record fails with code launch and the slot is free', () => {
    const { rec, row } = newCase('c1');
    fx.spawnThrows = true;
    const out = startFoam(row);
    assert.deepEqual(out, { ok: false, final: true, code: 'launch', error: 'The case could not start' });
    const after = readFoamRecord(rec.id);
    assert.equal(after.status, 'failed');
    assert.equal(after.code, 'launch');
    assert.equal(computeSlotHolder(), null);
    assert.deepEqual(frames(rec.id).map((e) => e.event), ['end']);
  });
});

function runnerDeps() {
  return {
    spawnJob: (opts) => {
      fx.spawned.push(opts);
      return { child: { pid: 4242 } };
    },
    watchWslCaseGone: (opts) => {
      fx.watches.push(opts);
      return { cancel() {} };
    },
    killWslCase: (opts) => fx.kills.push(opts),
    probeWslCase: async (opts) => {
      fx.probes.push(opts);
      return fx.probeAnswer;
    },
    relayAlive: async () => fx.alive,
    killRelay: (id) => fx.relayKills.push(id),
    pushComputeNotice: (n) => fx.notices.push(n),
    liveRegistryLoaded: () => fx.registryLoaded,
    pluginLoaded: (key) => (fx.pluginOn && key === 'foam-demo' ? { key, name: 'Foam demo' } : null),
    solverForApplication: (app) => (app === 'pimpleFoam' ? { application: 'pimpleFoam', time_dependency: 'transient', parallel: 'mpirun', stop_strategy: 'stopAt_writeNow' } : null),
    hardwareRankCap: () => 3,
    slotsHint: () => 8,
    hookNames: () => [],
    specDir: () => SPECS,
  };
}

describe('the runner API', () => {
  it('the plan → spec table: a plugin case, a core and a plugin prepare step, a parallel span with no solver', () => {
    const base = { job_id: 'fc-aaaaaaaa-111111', token: 'aabbccdd', case_dir: 'C:/c', case_base: 'C:/b', case_parts: ['studies', 's1', 'm1'], plugin: 'meshing', wsl_case: 'cfddesk-pf-meshing-s1-aabbccdd', wsl_root: '/r', n_procs: 2, slots_hint: null };
    const mesher = buildFoamSpec({
      ...base,
      claim: { kind: 'mesh', project_id: 'p1' },
      prepare: { job: 'meshing_write_case', runtime: 'core', args: ['--size', '0.5'], env: { MAGNUSIM_JOB_ID: 'fc-aaaaaaaa-111111', MAGNUSIM_CASE_DIR: 'C:/c' } },
      pre: [{ tool: 'blockMesh' }, { tool: 'decomposePar' }, { tool: 'snappyHexMesh', args: ['-overwrite'], parallel: true }, { tool: 'reconstructParMesh', args: ['-constant'] }],
      solver: null,
      owner: 'plugin:p1/meshing/s1',
      hooks: ['solve.parse_line'],
    });
    assert.deepEqual(mesher, {
      v: 1,
      kind: 'mesh',
      job_id: 'fc-aaaaaaaa-111111',
      token: 'aabbccdd',
      project_id: 'p1',
      case_dir: 'C:/c',
      case_base: 'C:/b',
      case_parts: ['studies', 's1', 'm1'],
      plugin: 'meshing',
      wsl_case: 'cfddesk-pf-meshing-s1-aabbccdd',
      wsl_root: '/r',
      n_procs: 2,
      slots_hint: null,
      prepare: { job: 'meshing_write_case', runtime: 'core', args: ['--size', '0.5'], env: { MAGNUSIM_JOB_ID: 'fc-aaaaaaaa-111111', MAGNUSIM_CASE_DIR: 'C:/c' } },
      pre: [
        { tool: 'blockMesh', args: [], parallel: false },
        { tool: 'decomposePar', args: [], parallel: false },
        { tool: 'snappyHexMesh', args: ['-overwrite'], parallel: true },
        { tool: 'reconstructParMesh', args: ['-constant'], parallel: false },
      ],
      solver: null,
      owner: null,
      hooks: [],
    });
    const plugin = buildFoamSpec({ ...base, claim: { kind: 'mesh', project_id: 'p1' }, prepare: { job: 'x', runtime: 'plugin', args: [], env: {} }, pre: [], solver: null });
    assert.equal(plugin.prepare.runtime, 'plugin');
    assert.ok(!('tool' in plugin.prepare) && !('python' in plugin.prepare), 'the spec names no program');
    const foam = buildFoamSpec({ ...base, claim: { kind: 'foam', project_id: 'p1' }, prepare: null, pre: [{ tool: 'blockMesh' }], solver: { app: 'pimpleFoam', keep_frames: 'all', frame_fields: ['U', 'p'], process_names: ['pimpleFoam'], stop_strategy: 'stopAt_writeNow', parallel: 'mpirun' }, owner: 'plugin:p1/foam-demo/s1', hooks: ['solve.parse_line'] });
    assert.equal(foam.kind, 'foam');
    assert.equal(foam.owner, 'plugin:p1/foam-demo/s1');
    assert.deepEqual(foam.hooks, ['solve.parse_line']);
  });

  it('the claim is plan.claim.kind; a kind with no handler is followed and finished in the store', () => {
    makeCase('m1');
    const rec = createFoamRecord({ kind: 'mesh', project_id: 'p1', plugin: 'foam-demo', case_rel: 'cases/m1', case_parts: ['studies', 's1', 'cases', 'm1'], case_dir: join(PLUGIN_DIR, 'studies', 's1', 'cases', 'm1'), case_base: PLUGIN_DIR, token: 'aabbccdd', wsl_case: 'cfddesk-pf-foam-demo-s1-aabbccdd', wsl_root: '/r', pre: [{ tool: 'blockMesh', args: [], parallel: false }] });
    const out = runFoamSteps({ job_id: rec.id, claim: { kind: 'mesh', project_id: 'p1', mesh_id: 'mesh_1', name: 'Mesh 1' }, case_base: rec.case_base, case_parts: rec.case_parts, case_dir: rec.case_dir, plugin: 'foam-demo', wsl_case: rec.wsl_case, wsl_root: '/r', token: 'aabbccdd', prepare: null, pre: rec.pre, n_procs: 1, solver: null });
    assert.deepEqual(out, { ok: true });
    assert.equal(computeSlotHolder().kind, 'mesh');
    assert.equal(computeSlotHolder().mesh_id, 'mesh_1');
    writeStatus(rec.case_dir, { outcome: { ok: true, phase: 'pre' }, clean: true, exit_code: 0, pre_ok: true });
    fx.spawned[0].onExit(0);
    fx.spawned[0].onClose();
    const done = readFoamRecord(rec.id);
    assert.equal(done.status, 'done');
    assert.deepEqual(done.result.saved_times, []);
    assert.equal(done.result.write_format, null);
    assert.equal(computeSlotHolder(), null);
  });

  it('handlers registered again replace the old ones', () => {
    const seen = [];
    registerStepRunKind('mesh', { onEvent: () => seen.push('old') });
    registerStepRunKind('mesh', { onEvent: () => seen.push('new'), onEnd: () => seen.push('end') });
    makeCase('m2');
    const rec = createFoamRecord({ kind: 'mesh', project_id: 'p1', case_dir: join(PLUGIN_DIR, 'studies', 's1', 'cases', 'm2') });
    finishFoam(rec.id, 'failed', { error: 'x' });
    assert.deepEqual(seen, ['new', 'end']);
  });

  it('a plan with no steps, a record not queued: final refusals with no claim', () => {
    const { rec } = newCase('c1');
    assert.equal(runFoamSteps({ job_id: 'fc-zzzzzzzz-000000' }).code, 'missing');
    const none = runFoamSteps({ job_id: rec.id, claim: { kind: 'foam', project_id: 'p1' }, prepare: null, pre: [], solver: null });
    assert.equal(none.code, 'invalid_spec');
    assert.equal(computeSlotHolder(), null);
  });
});

function started(name = 'c1', extra = {}) {
  const c = newCase(name, extra);
  assert.deepEqual(startFoam(c.row), { ok: true });
  queue.removeComputeJob(null, c.row.id);
  return { ...c, spawn: fx.spawned[fx.spawned.length - 1], token: computeSlotHolder().token };
}

describe('the launch is decided at close', () => {
  it('starter exit 0, close, no status file: the run drains (the slot stays held)', () => {
    const { rec, spawn, token } = started();
    spawn.onExit(0);
    assert.equal(readFoamRecord(rec.id).status, 'running', 'exit alone decides nothing');
    spawn.onClose();
    assert.equal(fx.watches.length, 1);
    assert.equal(computeSlotHolder().token, token);
    assert.equal(computeSlotHolder().phase, 'draining');
    assert.equal(readFoamRecord(rec.id).stage, 'ending');
    const w = fx.watches[0];
    assert.equal(w.wslCase, rec.wsl_case);
    assert.deepEqual(w.scripts, ['foam-pre-0011aabb.sh', 'solve-pf-0011aabb.sh']);
    assert.equal(w.root, '/home/tester/cases');
    // WSL gone, no status: nothing reached WSL.
    w.onGone();
    w.release();
    const end = readFoamRecord(rec.id);
    assert.equal(end.status, 'failed');
    assert.equal(end.code, 'relay_failed');
    assert.equal(computeSlotHolder(), null);
  });

  for (const code of [3, -1, null]) {
    it(`starter exit ${code} with no status: failed launch, released at once`, () => {
      const { rec, spawn } = started();
      spawn.onExit(code);
      spawn.onClose();
      const end = readFoamRecord(rec.id);
      assert.equal(end.status, 'failed');
      assert.equal(end.code, 'launch');
      assert.equal(end.error, 'The case could not start');
      assert.equal(computeSlotHolder(), null);
      assert.equal(fx.watches.length, 0);
    });
  }

  it('a clean final status finishes at close: no drain, marker and spec removed', () => {
    const { rec, spawn } = started();
    writeFileSync(join(rec.case_dir, '.magnusim-stop'), '{}');
    mkdirSync(join(rec.case_dir, '0.1'), { recursive: true });
    for (const f of ['U', 'p']) writeFileSync(join(rec.case_dir, '0.1', f), 'x');
    writeStatus(rec.case_dir, { outcome: { ok: true, phase: 'solve', exit_code: 0 }, clean: true, exit_code: 0, n_procs: 2 });
    spawn.onExit(0);
    spawn.onClose();
    const end = readFoamRecord(rec.id);
    assert.equal(end.status, 'done');
    assert.deepEqual(end.result.saved_times, [0.1]);
    assert.equal(end.result.last_saved, 0.1);
    assert.equal(end.result.write_format, 'binary');
    assert.ok(!existsSync(join(rec.case_dir, '.magnusim-stop')));
    assert.ok(!existsSync(join(SPECS, `${rec.id}.json`)));
    assert.equal(computeSlotHolder(), null);
    // Once: a second close changes nothing.
    spawn.onClose();
    assert.equal(frames(rec.id).filter((e) => e.event === 'end').length, 1);
  });

  it('a store write that throws in afterRelayGone: the slot is free and end is still emitted', () => {
    const { rec, spawn } = started();
    writeStatus(rec.case_dir, { outcome: { ok: true, phase: 'solve' }, clean: true, exit_code: 0 });
    resetFoamStoreForTests({
      filePath: join(ROOT, 'foam-cases.json'),
      writeFileSync: () => {
        throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      },
    });
    foamEventBus().on('event', (m) => fx.events.push(m));
    readFoamRecord(rec.id);
    spawn.onExit(0);
    assert.doesNotThrow(() => spawn.onClose());
    assert.equal(computeSlotHolder(), null);
    assert.ok(frames(rec.id).some((e) => e.event === 'end' && e.status === 'done'));
  });
});

describe('stop', () => {
  it('saved first, then the marker; a later user stop raises the level; all kills WSL now', () => {
    const { rec } = started();
    const out = stopFoamCase(rec.id, { by: 'user' });
    assert.deepEqual(out, { ok: true, status: 'running', stopping: true });
    const r1 = readFoamRecord(rec.id);
    assert.equal(r1.stop.level, 'graceful');
    assert.equal(r1.stop.by, 'user');
    const marker = JSON.parse(readFileSync(join(rec.case_dir, '.magnusim-stop'), 'utf8'));
    assert.equal(marker.level, 'graceful');
    assert.equal(marker.by, 'user');
    assert.equal(fx.kills.length, 0);
    assert.equal(computeSlotHolder().stop_requested, true);
    stopFoamCase(rec.id, { by: 'user' });
    assert.equal(readFoamRecord(rec.id).stop.level, 'solver');
    assert.equal(fx.kills.length, 0);
    stopFoamCase(rec.id, { by: 'user' });
    assert.equal(readFoamRecord(rec.id).stop.level, 'all');
    assert.equal(fx.kills.length, 1, 'level all: WSL is killed at once');
    assert.equal(JSON.parse(readFileSync(join(rec.case_dir, '.magnusim-stop'), 'utf8')).seq, 3);
    stopFoamCase(rec.id, { by: 'user', force: true });
    assert.equal(fx.kills.length, 1, 'once');
    assert.ok(frames(rec.id).some((e) => e.event === 'stage' && e.stage === 'stopping'));
  });

  it('a relay still alive 120 s after the all-kill with WSL dead is ended by identity; never for an old status', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW });
    const { rec } = started();
    writeStatus(rec.case_dir, { updated_at: '2000-01-01T00:00:00Z', stage: 'solve' });
    stopFoamCase(rec.id, { by: 'user', force: true });
    mock.timers.tick(119_000);
    for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
    assert.deepEqual(fx.relayKills, []);
    fx.probeAnswer = 'dead';
    mock.timers.tick(1_000);
    for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
    assert.deepEqual(fx.relayKills, [rec.id]);
  });

  it('a relay alive 120 s after the all-kill while WSL still runs is never killed', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW });
    const { rec } = started();
    stopFoamCase(rec.id, { by: 'user', force: true });
    fx.probeAnswer = 'live';
    const probesBefore = fx.probes.length;
    mock.timers.tick(120_000);
    for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
    assert.equal(fx.probes.length, probesBefore + 1, 'WSL was asked');
    assert.deepEqual(fx.relayKills, [], 'the relay still follows a live case');
  });

  it('a host stop never escalates; by and reason are written once; a user stop after it raises the level', () => {
    const { rec } = started();
    stopFoamCasesFor({ plugin: 'foam-demo' }, 'plugin_off', 'Foam demo was turned off');
    const r1 = readFoamRecord(rec.id);
    assert.deepEqual([r1.stop.level, r1.stop.by, r1.stop.reason], ['graceful', 'plugin_off', 'Foam demo was turned off']);
    assert.equal(fx.notices.length, 1);
    assert.deepEqual([fx.notices[0].reason, fx.notices[0].error, fx.notices[0].name], ['stopped', 'Foam demo was turned off', 'Cavity case 1 · c1 · Foam demo']);
    stopFoamCasesFor({ plugin: 'foam-demo' }, 'reload', 'plugins were reloaded');
    stopFoamCase(rec.id, { by: 'env_removed', reason: 'x' });
    const r2 = readFoamRecord(rec.id);
    assert.deepEqual([r2.stop.level, r2.stop.by, r2.stop.reason], ['graceful', 'plugin_off', 'Foam demo was turned off']);
    assert.equal(fx.notices.length, 1, 'no second notice');
    stopFoamCase(rec.id, { by: 'user' });
    const r3 = readFoamRecord(rec.id);
    assert.deepEqual([r3.stop.level, r3.stop.by], ['solver', 'plugin_off']);
    // Its end reads the host's reason.
    writeStatus(rec.case_dir, { outcome: { ok: false, stopped: true, phase: 'solve' }, clean: true });
    fx.spawned[0].onExit(0);
    fx.spawned[0].onClose();
    const end = readFoamRecord(rec.id);
    assert.equal(end.status, 'stopped');
    assert.equal(end.error, 'Stopped: Foam demo was turned off');
  });

  it('queued cases: a user stop removes the row; a host stop drops it with a notice', () => {
    const a = newCase('qa');
    const leaves = [];
    queue.configureComputeQueue({ onLeave: (row, reason, error) => { leaves.push(reason); onQueueLeave(row, reason, error); } });
    setFoamRunnerDepsForTests({ ...runnerDeps(), dropFoamJobs: queue.dropFoamJobs, pushComputeNotice: (n) => fx.notices.push(n) });
    stopFoamCase(a.rec.id, { by: 'user' });
    assert.equal(readFoamRecord(a.rec.id).status, 'stopped');
    assert.equal(readFoamRecord(a.rec.id).error, 'Removed from the queue before it started');
    assert.equal(queue.queueHasRow(a.row.id), false);
    const b = newCase('qb');
    stopFoamCasesFor({ plugin: 'foam-demo' }, 'plugin_off', 'Foam demo was turned off');
    assert.equal(readFoamRecord(b.rec.id).status, 'stopped');
    assert.equal(readFoamRecord(b.rec.id).error, 'Foam demo was turned off');
    assert.deepEqual(leaves, ['removed', 'dropped']);
    assert.ok(queue.snapshotComputeQueue().failed.some((f) => f.reason === 'dropped' && f.job_id === b.rec.id));
  });
});

describe('adoption after a restart', () => {
  it('a stop survives: adopted with a stop and no marker, the marker is written again', () => {
    const { rec } = newCase('c1');
    updateFoamRecord(rec.id, { status: 'running', stop: { at: 'x', by: 'user', level: 'solver', reason: null, seq: 2 } });
    const c = claimComputeSlot('check', { project_ids: ['p1'] }, { phase: 'checking' });
    adoptFoamCase(readFoamRecord(rec.id), c.token, () => releaseComputeSlot(c.token));
    const marker = JSON.parse(readFileSync(join(rec.case_dir, '.magnusim-stop'), 'utf8'));
    assert.equal(marker.level, 'solver');
  });

  it('a job the shared boot claim does not describe yet never changes it (its drain, its stop)', () => {
    const { rec } = newCase('c1');
    updateFoamRecord(rec.id, { status: 'running' });
    const c = claimComputeSlot('check', { project_ids: ['p1'] }, { phase: 'checking' });
    // The check describes another job it follows (first in its list): a case whose relay lives.
    slot.patchComputeSlot(c.token, { kind: 'foam', phase: 'running', project_id: 'p1', job_id: 'fc-aaaaaaaa-0f0f0f', project_ids: null });
    assert.equal(foamRunPhase(rec.id), null, 'not followed yet');
    adoptFoamCase(readFoamRecord(rec.id), c.token, () => releaseComputeSlot(c.token), { relayGone: true });
    assert.equal(fx.watches.length, 1, 'its relay is gone: it drains');
    assert.equal(foamRunPhase(rec.id), 'draining');
    stopFoamCase(rec.id, { by: 'user' });
    const h = computeSlotHolder();
    assert.deepEqual([h.kind, h.job_id, h.phase, h.stop_requested], ['foam', 'fc-aaaaaaaa-0f0f0f', 'running', false], 'the described case is unchanged');
    // Once the claim describes it, its stop shows.
    slot.patchComputeSlot(c.token, { job_id: rec.id });
    stopFoamCase(rec.id, { by: 'user' });
    assert.equal(computeSlotHolder().stop_requested, true);
  });

  it('polls its status file; alive:false with no final status drains, then evidence, then the release', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW });
    const { rec } = newCase('c1');
    updateFoamRecord(rec.id, { status: 'running' });
    let released = 0;
    const c = claimComputeSlot('check', { project_ids: ['p1'] }, { phase: 'checking' });
    adoptFoamCase(readFoamRecord(rec.id), c.token, () => {
      released += 1;
      releaseComputeSlot(c.token);
    });
    writeStatus(rec.case_dir, { stage: 'solve', saved: [0.1, 0.2], time: 0.25, n_steps: 50, wsl_reached: true });
    mock.timers.tick(2000);
    const evs = frames(rec.id);
    assert.deepEqual(evs.filter((e) => e.event === 'time_saved').map((e) => e.t), [0.1, 0.2]);
    assert.ok(evs.some((e) => e.event === 'stage' && e.stage === 'solve'));
    const p = evs.find((e) => e.event === 'progress');
    assert.deepEqual([p.time, p.n_steps, p.points], [0.25, 50, []]);
    fx.alive = false;
    mock.timers.tick(8000);
    for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
    assert.equal(fx.watches.length, 1, 'the relay is gone with no final status: drain');
    assert.equal(released, 0);
    fx.watches[0].onGone();
    fx.watches[0].release();
    assert.equal(readFoamRecord(rec.id).status, 'lost', 'WSL was reached, no clean end');
    assert.equal(released, 1);
  });
});

describe('the end from evidence', () => {
  const rec = { app: 'pimpleFoam', pre: [{ tool: 'blockMesh' }], prepare: null };
  const cases = [
    [{ ...rec, stop: { by: 'user' } }, { outcome: { ok: true, phase: 'solve' } }, ['stopped', null, null]],
    [{ ...rec, stop: { by: 'plugin_off', reason: 'Foam demo was turned off' } }, null, ['stopped', null, 'Stopped: Foam demo was turned off']],
    [rec, { outcome: { ok: true, phase: 'solve' } }, ['done', null, null]],
    [rec, { outcome: { ok: true, phase: 'pre' } }, ['failed', null, 'The run ended before its last step']],
    [{ app: null, pre: [{ tool: 'blockMesh' }] }, { outcome: { ok: true, phase: 'pre' } }, ['done', null, null]],
    [{ app: null, pre: [], prepare: { job: 'j' } }, { outcome: { ok: true, phase: 'prepare' } }, ['done', null, null]],
    [rec, { outcome: { ok: false, phase: 'gate', code: 'has_results', error: 'This case already ran. Write a new case folder for each run.' } }, ['failed', 'has_results', 'This case already ran. Write a new case folder for each run.']],
    [rec, { outcome: { ok: false, phase: 'gate', code: 'pre_not_allowed' } }, ['failed', 'pre_not_allowed', 'A step is not allowed']],
    [{ app: null, pre: [], prepare: { job: 'meshing_write_case' } }, { outcome: { ok: false, phase: 'prepare', job: 'meshing_write_case', exit_code: 3 } }, ['failed', 'prepare', 'Prepare step meshing_write_case failed (exit 3). See log.prepare in the case folder']],
    [rec, { outcome: { ok: false, phase: 'pre', tool: 'blockMesh', index: 1, exit_code: 1 } }, ['failed', null, 'blockMesh failed (exit 1). See log.blockMesh.1 in the case folder']],
    [rec, { outcome: { ok: false, phase: 'pre', tool: 'snappyHexMesh', index: 2, exit_code: 50 } }, ['failed', null, 'snappyHexMesh wrote a time folder']],
    [rec, { outcome: { ok: false, phase: 'pre', exit_code: 46 } }, ['failed', null, 'The case has no mesh (constant/polyMesh)']],
    [rec, { outcome: { ok: false, phase: 'solve', exit_code: 1 } }, ['failed', null, 'pimpleFoam failed (exit 1)']],
    [rec, { outcome: { ok: false, phase: 'solve', exit_code: 47 } }, ['failed', null, 'The case copy could not be opened in WSL']],
    [rec, { outcome: { ok: false, phase: 'solve', exit_code: 48 } }, ['failed', null, 'A result frame could not be copied back']],
    [rec, { outcome: { ok: false, stopped: true, phase: 'pre' } }, ['stopped', null, null]],
    [rec, null, ['failed', 'relay_failed', 'The case could not start. See the log']],
    [rec, { wsl_reached: false }, ['failed', 'relay_failed', 'The case could not start. See the log']],
    [rec, { wsl_reached: true }, ['lost', 'lost', 'The app lost track of this case while it ran. Results saved before then are in the case folder']],
    [rec, { wsl_reached: true, cleanup_seen: true }, ['done', null, null]],
    [rec, { wsl_reached: true, result_ok: true }, ['done', null, null]],
    [{ app: null, pre: [{ tool: 'blockMesh' }] }, { wsl_reached: true, pre_ok: true }, ['done', null, null]],
    [{ app: null, pre: [{ tool: 'blockMesh' }] }, { wsl_reached: true, result_ok: true }, ['lost', 'lost', 'The app lost track of this case while it ran. Results saved before then are in the case folder']],
  ];
  cases.forEach(([r, st, want], i) => {
    it(`case ${i + 1}: ${want[0]}${want[1] ? ' ' + want[1] : ''}`, () => {
      const got = foamEndFromEvidence(r, st);
      assert.deepEqual([got.status, got.code, got.error], want);
    });
  });

  it('a drain that will not end: stuck → stopped stuck; unreachable → lost', () => {
    const a = started('c1');
    a.spawn.onExit(0);
    a.spawn.onClose();
    fx.watches[0].onLost('stuck');
    fx.watches[0].release();
    const ra = readFoamRecord(a.rec.id);
    assert.deepEqual([ra.status, ra.code, ra.error], ['stopped', 'stuck', 'Its processes in WSL would not stop. Restart WSL (wsl --shutdown) before running more cases']);
    assert.equal(computeSlotHolder(), null);
    const b = started('c2', { token: 'ccddeeff' });
    b.spawn.onExit(0);
    b.spawn.onClose();
    fx.watches[1].onLost('unreachable');
    const rb = readFoamRecord(b.rec.id);
    assert.deepEqual([rb.status, rb.code], ['lost', 'lost']);
    assert.equal(fx.watches[1].stop(), false, 'the drain reads the stop at every probe');
    stopFoamCase(b.rec.id, { by: 'user' });
  });
});

describe('events', () => {
  it('progress: at most one frame per 250 ms, one per stage change, points ≤ 400 with the last kept', () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW });
    const { rec, spawn } = started();
    spawn.onEvent({ event: 'stage', stage: 'solve' });
    for (let i = 0; i < 1000; i += 1) {
      spawn.onEvent({ event: 'progress', time: (i + 1) * 0.001, sim_time: (i + 1) * 0.001 });
      spawn.onEvent({ event: 'residual', field: 'Ux', initial: 0.5, fields: { Ux: 0.5 } });
      spawn.onEvent({ event: 'residual', field: 'Ux', initial: 0.9, fields: { Ux: 0.9 } });
      spawn.onEvent({ event: 'residual', field: 'p', initial: 0.1, fields: { p: 0.1 } });
      if (i === 500) spawn.onEvent({ event: 'stage', stage: 'reconstruct' });
      mock.timers.tick(1);
    }
    mock.timers.tick(300);
    const progress = frames(rec.id).filter((e) => e.event === 'progress');
    assert.ok(progress.length <= 6, `${progress.length} progress frames`);
    assert.ok(progress.length >= 2);
    for (const p of progress) assert.ok(p.points.length <= 400);
    const last = progress.at(-1);
    assert.equal(last.points.at(-1).t, 0.999, 'the last closed step is the last point');
    assert.equal(last.residuals.Ux, 0.9, 'the largest initial residual of the step');
    assert.equal(last.residuals.p, 0.1);
    // One burst: thinned to 400.
    const st = newFoamFold();
    for (let i = 0; i < 1001; i += 1) foldFoamEvent(st, { event: 'progress', time: i });
    assert.equal(st.steps, 1000);
    const one = runner.takeProgressFrame(st, 0);
    assert.equal(one.points.length, 400);
    assert.equal(one.points.at(-1).t, 999);
  });

  it('a Courant block printed before Time = t lands on step t; a deltaT-only one fills delta_t', () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW });
    const { rec, spawn } = started();
    spawn.onEvent({ event: 'stage', stage: 'solve' });
    // What the log parser sends for a pimpleFoam log: the step's Courant number and
    // deltaT lines come before its 'Time =' line (the progress event's own co_* are
    // left out here, so the fold alone decides).
    for (let i = 1; i <= 3; i += 1) {
      spawn.onEvent({ event: 'courant', mean: i / 10, max: i });
      spawn.onEvent({ event: 'courant', delta_t: i / 1000 });
      spawn.onEvent({ event: 'progress', time: i / 1000, sim_time: i / 1000 });
      spawn.onEvent({ event: 'residual', field: 'Ux', initial: 1 / i, fields: { Ux: 1 / i } });
    }
    mock.timers.tick(300);
    finishFoam(rec.id, 'done');
    const points = frames(rec.id)
      .filter((e) => e.event === 'progress')
      .flatMap((e) => e.points);
    assert.deepEqual(points, [
      { t: 0.001, co_mean: 0.1, co_max: 1, delta_t: 0.001, Ux: 1 },
      { t: 0.002, co_mean: 0.2, co_max: 2, delta_t: 0.002, Ux: 0.5 },
      { t: 0.003, co_mean: 0.3, co_max: 3, delta_t: 0.003, Ux: 1 / 3 },
    ]);
    // The progress event's own values win; a deltaT-only block keeps the step before's Courant.
    const st = newFoamFold();
    foldFoamEvent(st, { event: 'courant', mean: 0.5, max: 0.9 });
    foldFoamEvent(st, { event: 'progress', time: 1, co_mean: 0.4 });
    foldFoamEvent(st, { event: 'courant', delta_t: 0.25 });
    foldFoamEvent(st, { event: 'progress', time: 2 });
    foldFoamEvent(st, { event: 'progress', time: 3 });
    const frame = runner.takeProgressFrame(st, 0);
    assert.deepEqual(frame.points, [
      { t: 1, co_mean: 0.4, co_max: 0.9 },
      { t: 2, co_mean: 0.4, co_max: 0.9, delta_t: 0.25 },
    ]);
    assert.deepEqual([frame.time, frame.co_mean, frame.co_max, frame.delta_t], [2, 0.4, 0.9, 0.25]);
  });

  it('no frame event carries a path, a pid or a log line', () => {
    const { rec, spawn } = started();
    const raw = [
      { event: 'relay_launch', launcher_pid: 99, relay_pid: 100 },
      { event: 'start', run_id: 'pf-0011aabb', dst: '/home/tester/cases/cfddesk-pf-foam-demo-s1-0011aabb', n_procs: 1, app: 'pimpleFoam' },
      { event: 'stage', stage: 'copy_to_wsl' },
      { event: 'log', line: 'cwd=/home/tester/cases/cfddesk-pf-foam-demo-s1-0011aabb' },
      { event: 'pre', tool: 'blockMesh', index: 1, exit_code: 0, log: 'C:\\x\\log.blockMesh.1' },
      { event: 'phase', phase: 'pre', seconds: 1.5 },
      { event: 'ranks', n_procs: 2 },
      { event: 'prepare_stage', stage: 'writing' },
      { event: 'prepare_stage', stage: '/mnt/c/evil' },
      { event: 'time_saved', t: 0.1, dir: '/mnt/c/x' },
      { event: 'error', code: 48, error: `result frame copy failed ${rec.case_dir}` },
      { event: 'error', code: 99, error: 'Traceback /home/x' },
      { event: 'result', ok: true, exit_code: 0, win_out: rec.case_dir },
      { event: 'stage', stage: 'decompose_end', exit_code: 0 },
      { event: 'relay_end', exit_code: 0, clean: true, outcome: { ok: true } },
    ];
    for (const ev of raw) spawn.onEvent(ev);
    const text = JSON.stringify(frames(rec.id));
    for (const bad of ['/home/', '/mnt/', 'C:\\', 'C:/', rec.case_dir.replace(/\\/g, '\\\\'), 'cwd=', 'Traceback', '"pid"', 'launcher_pid']) {
      assert.ok(!text.includes(bad), `${bad} in ${text}`);
    }
    assert.deepEqual(frames(rec.id).map((e) => e.event), ['start', 'stage', 'pre', 'phase', 'ranks', 'prepare_stage', 'time_saved', 'warning']);
    const warning = frames(rec.id).find((e) => e.event === 'warning');
    assert.deepEqual(warning, { event: 'warning', code: 48, message: 'A result frame could not be copied back' });
    assert.equal(relayEvent.length, 3);
  });
});

describe('queue side and busy folders', () => {
  it('reconcile at boot: queued with no row, rows with no queued record, other kinds left queued', () => {
    const lost = createFoamRecord({ kind: 'foam', project_id: 'p1', plugin: 'foam-demo', study_id: 's1' });
    const mesh = createFoamRecord({ kind: 'mesh', project_id: 'p1' });
    const kept = newCase('ck');
    queue.enqueueFoamJob({ kind: 'foam', project_id: 'p1', name: 'x', job_id: 'fc-zzzzzzzz-000000', foam: { plugin: 'foam-demo', study_id: 's1' } });
    const leaves = [];
    queue.configureComputeQueue({ onLeave: (row, reason) => leaves.push([row.job_id, reason]) });
    setFoamRunnerDepsForTests({ ...runnerDeps(), queueRows: () => queue.snapshotComputeQueue().items, dropComputeRows: queue.dropComputeRows });
    reconcileFoamQueue();
    assert.equal(readFoamRecord(lost.id).error, 'Lost from the queue');
    assert.equal(readFoamRecord(mesh.id).error, 'Lost before it started');
    assert.equal(readFoamRecord(kept.rec.id).status, 'queued');
    assert.deepEqual(leaves, [['fc-zzzzzzzz-000000', 'skipped']]);
    assert.equal(queue.snapshotComputeQueue().failed.length, 0, 'no notice for a skip');
  });

  it('onQueueLeave finishes the record once, by reason', () => {
    const r = (n) => newCase(n);
    const a = r('l1');
    onQueueLeave(a.row, 'removed');
    assert.equal(readFoamRecord(a.rec.id).error, 'Removed from the queue before it started');
    onQueueLeave(a.row, 'failed', 'x');
    assert.equal(readFoamRecord(a.rec.id).status, 'stopped', 'once');
    const b = r('l2');
    onQueueLeave(b.row, 'failed', 'Start failed on the server. See the server log');
    assert.deepEqual([readFoamRecord(b.rec.id).status, readFoamRecord(b.rec.id).error], ['failed', 'Start failed on the server. See the server log']);
    const c = r('l3');
    onQueueLeave(c.row, 'dropped', 'The project was deleted');
    assert.deepEqual([readFoamRecord(c.rec.id).status, readFoamRecord(c.rec.id).error], ['stopped', 'The project was deleted']);
    onQueueLeave({ kind: 'mesh', mesh_id: 'm1' }, 'removed');
  });

  it('active case keys and the study check compare projects by folder; foam records only', () => {
    const { rec } = started('busy1');
    assert.deepEqual(activeCaseKeys('p1', 'foam-demo'), ['studies/s1/cases/busy1']);
    if (process.platform === 'win32') assert.deepEqual(activeCaseKeys('P1', 'foam-demo'), ['studies/s1/cases/busy1'], 'another letter case');
    assert.deepEqual(activeCaseKeys('p1', 'other'), []);
    assert.equal(studyHasActiveCase('p1', 'foam-demo', 's1'), true);
    assert.equal(studyHasActiveCase('p1', 'foam-demo', 's2'), false);
    if (process.platform === 'win32') assert.equal(studyHasActiveCase('P1', 'foam-demo', 's1'), true);
    createFoamRecord({ kind: 'mesh', project_id: 'p1', plugin: 'foam-demo', study_id: 's1', case_key: 'x' });
    assert.equal(activeCaseKeys('p1', 'foam-demo').length, 1);
    finishFoam(rec.id, 'failed', {});
    assert.deepEqual(activeCaseKeys('p1', 'foam-demo'), []);
  });

  it('the plugin epoch moves on each bump, per plugin and for all', () => {
    const a = pluginEpoch('foam-demo');
    bumpPluginEpoch('other');
    assert.equal(pluginEpoch('foam-demo'), a);
    bumpPluginEpoch('foam-demo');
    const b = pluginEpoch('foam-demo');
    assert.notEqual(b, a);
    bumpPluginEpoch('*');
    assert.notEqual(pluginEpoch('foam-demo'), b);
  });

  it('a WSL case id is the slugify rule of case_id.py', () => {
    assert.equal(foamWslCaseId('Foam_Demo.v2', 'study-1', '0011aabb'), 'cfddesk-pf-foam-demo-v2-study-1-0011aabb');
    assert.equal(foamWslCaseId('___', 'a'.repeat(40), 'ffffffff'), `cfddesk-pf-x-${'a'.repeat(24)}-ffffffff`);
  });
});
