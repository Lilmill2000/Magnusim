// H15: the boot check (scripts/compute-rediscover.js): jobs a previous server left
// running hold the compute slot before anything starts, and until they are gone.
import { after, afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-rediscover-'));
const PROJECTS = join(ROOT, 'projects');
mkdirSync(PROJECTS, { recursive: true });
process.env.MAGNUSIM_PROJECTS_ROOT = PROJECTS;
process.env.MAGNUSIM_LOCAL_JSON = join(ROOT, 'local.json');
process.env.MAGNUSIM_WSL_CASE_ROOT = '/home/tester/cases';
process.env.MAGNUSIM_QUEUE_QUIET = '1';

const { rediscoverAtBoot, BOOT_PROBE_BOUND_MS } = await import('../compute-rediscover.js');
const slot = await import('../compute-slot.js');
const watch = await import('../wsl-case-watch.js');
const queue = await import('../server/compute-queue.ts');
const w27 = await import('../w27-solve.js');
const layout = await import('../project-layout.js');
const studyIo = await import('../study-io.js');
const { computeSlotHolder, resetComputeSlotForTests, setSlotReleaseHook, holderIsRow } = slot;

after(() => {
  try {
    rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* Windows may hold a file */
  }
});

const flush = async () => {
  for (let i = 0; i < 6; i += 1) await new Promise((r) => setImmediate(r));
};

function coreDoc(pid, runId, extra = {}) {
  return { project_id: pid, run_id: runId, wsl_case: `cfddesk-w27-${runId}`, name: `Run ${runId}`, stop_requested: false, ...extra };
}

/** Fake deps; each test changes what it needs. */
function fakes(over = {}) {
  const log = { probes: [], alive: [], reaped: [], watches: [], adopted: [], notices: [], reconciled: 0 };
  const deps = {
    listCore: () => [],
    listRunner: () => [],
    reconcile: () => {
      log.reconciled += 1;
    },
    wslRoot: () => '/home/tester/cases',
    probe: async (a) => {
      log.probes.push(a);
      return 'dead';
    },
    relayAlive: async (id) => {
      log.alive.push(id);
      return true;
    },
    reap: (pid, runId) => log.reaped.push([pid, runId]),
    runDocStopRequested: () => false,
    watch: (opts) => {
      log.watches.push(opts);
      return { cancel() {} };
    },
    adopt: (rec, token, release, o) => log.adopted.push({ rec, token, release, o }),
    runnerPhase: () => null,
    readRecord: () => null,
    notice: (n) => log.notices.push(n),
    boundMs: BOOT_PROBE_BOUND_MS,
    ...over,
  };
  return { deps, log };
}

beforeEach(() => {
  resetComputeSlotForTests();
  queue.resetComputeQueueForTests({ filePath: join(ROOT, 'queue.json'), items: [], deps: {} });
});
afterEach(() => mock.timers.reset());

describe('the boot check', () => {
  it('runs once per process; with nothing left running it claims nothing (and still reconciles the foam queue)', async () => {
    const { deps, log } = fakes();
    assert.equal(rediscoverAtBoot({ deps }), null);
    assert.equal(log.reconciled, 1);
    assert.equal(computeSlotHolder(), null);
    const again = fakes({ listCore: () => [coreDoc('p1', 'r1')] });
    assert.equal(rediscoverAtBoot({ deps: again.deps }), null, 'once per process');
    assert.equal(computeSlotHolder(), null);
  });

  it('holds the slot (check) from before the first request; a kick at 400 ms sees busy', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
    let answer;
    const { deps } = fakes({ listCore: () => [coreDoc('p1', 'r1')], probe: () => new Promise((r) => (answer = r)) });
    const started = [];
    queue.resetComputeQueueForTests({
      filePath: join(ROOT, 'queue.json'),
      items: [{ kind: 'mesh', mesh_id: 'm1', project_id: 'p2' }],
      deps: { isBusy: () => computeSlotHolder() !== null, startMesh: (row) => (started.push(row.mesh_id), { ok: true }) },
    });
    const done = rediscoverAtBoot({ deps });
    const h = computeSlotHolder();
    assert.deepEqual([h.kind, h.phase, h.name, h.project_ids], ['check', 'checking', 'Checking for jobs left running', ['p1']]);
    queue.scheduleComputeQueueKick(400);
    mock.timers.tick(400);
    await flush();
    assert.deepEqual(started, [], 'the queue waits for the check');
    answer('dead');
    await done;
    assert.equal(computeSlotHolder(), null);
  });

  it('probes are bounded at 20 s: one that has not answered is unknown, and is followed', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
    const { deps, log } = fakes({ listCore: () => [coreDoc('p1', 'r1')], probe: () => new Promise(() => {}) });
    const done = rediscoverAtBoot({ deps });
    mock.timers.tick(BOOT_PROBE_BOUND_MS - 1);
    await flush();
    assert.equal(log.watches.length, 0);
    assert.equal(computeSlotHolder().kind, 'check');
    mock.timers.tick(1);
    await done;
    assert.equal(log.watches.length, 1);
    const h = computeSlotHolder();
    assert.deepEqual([h.kind, h.phase, h.run_id, h.project_id, h.project_ids], ['solve', 'draining', 'r1', 'p1', undefined]);
  });

  it('an unknown core run keeps the slot until WSL has not answered for 10 minutes', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
    const { deps, log } = fakes({
      listCore: () => [coreDoc('p1', 'r1')],
      probe: async () => 'unknown',
      watch: (opts) => watch.watchWslCaseGone({ ...opts, probe: async () => 'unknown', kill: () => {} }),
    });
    await rediscoverAtBoot({ deps });
    assert.equal(computeSlotHolder().phase, 'draining');
    for (let i = 0; i < 290; i += 1) {
      mock.timers.tick(2000);
      await flush();
    }
    assert.ok(computeSlotHolder(), 'still held at 9 min 40 s');
    for (let i = 0; i < 20; i += 1) {
      mock.timers.tick(2000);
      await flush();
    }
    assert.equal(computeSlotHolder(), null);
    assert.equal(log.notices.length, 1);
    assert.equal(log.notices[0].error, 'WSL stopped answering. Results saved before then are in the run folder');
    assert.equal(log.notices[0].reason, 'stopped');
  });

  it('dead core runs are reaped; live ones are followed as a drain (kind solve), with the run doc as the stop', async () => {
    const stops = [];
    const { deps, log } = fakes({
      listCore: () => [coreDoc('p1', 'dead1'), coreDoc('p1', 'live1', { stop_requested: true })],
      probe: async (a) => (a.wslCase.endsWith('dead1') ? 'dead' : 'live'),
      runDocStopRequested: (pid, runId) => (stops.push([pid, runId]), true),
    });
    await rediscoverAtBoot({ deps });
    assert.deepEqual(log.reaped, [['p1', 'dead1']]);
    assert.equal(log.watches.length, 1);
    const w = log.watches[0];
    assert.deepEqual([w.wslCase, w.scripts, w.root], ['cfddesk-w27-live1', ['solve-live1.sh'], '/home/tester/cases']);
    // The claim's stop flag was read from the run doc when the claim was handed to it.
    assert.deepEqual(stops, [['p1', 'live1']]);
    stops.length = 0;
    assert.equal(w.stop(), true);
    assert.deepEqual(stops, [['p1', 'live1']], 'the watch reads the run doc at each probe');
    const h = computeSlotHolder();
    assert.deepEqual([h.kind, h.phase, h.run_id, h.stop_requested, h.name], ['solve', 'draining', 'live1', true, 'Run live1']);
    w.onGone();
    assert.deepEqual(log.reaped.at(-1), ['p1', 'live1']);
    w.release();
    assert.equal(computeSlotHolder(), null);
  });

  it('runner records: adopted while their relay lives, through afterRelayGone when it is gone', async () => {
    const recs = [
      { id: 'fc-aaaaaaaa-111111', kind: 'foam', project_id: 'p1', plugin: 'foam-demo', plugin_name: 'Foam demo', study_id: 's1', study_title: 'Cavity', case_rel: 'cases/c1' },
      { id: 'fc-aaaaaaaa-222222', kind: 'mesh', project_id: 'p2', plugin: 'meshing', study_id: 's2' },
    ];
    const { deps, log } = fakes({ listRunner: () => recs, relayAlive: async (id) => (log.alive.push(id), id.endsWith('111111')) });
    await rediscoverAtBoot({ deps });
    assert.deepEqual(log.alive, ['fc-aaaaaaaa-111111', 'fc-aaaaaaaa-222222']);
    assert.deepEqual(log.adopted.map((a) => [a.rec.id, a.o.relayGone]), [['fc-aaaaaaaa-111111', false], ['fc-aaaaaaaa-222222', true]]);
    const h = computeSlotHolder();
    assert.deepEqual([h.kind, h.phase, h.job_id, h.name], ['foam', 'running', 'fc-aaaaaaaa-111111', 'Cavity · c1 · Foam demo']);
    assert.ok(holderIsRow(h, { kind: 'foam', project_id: 'p1', job_id: 'fc-aaaaaaaa-111111' }));
    // Two followed jobs: the slot is released only after both ended; it moves to the other first.
    assert.deepEqual(h.project_ids, ['p1', 'p2'], 'both projects stay named while both are followed');
    log.adopted[0].release();
    assert.equal(computeSlotHolder().job_id, 'fc-aaaaaaaa-222222');
    assert.equal(computeSlotHolder().kind, 'mesh', "the claim takes the next job's kind");
    assert.equal(computeSlotHolder().project_ids, undefined);
    assert.equal(computeSlotHolder().phase, 'draining', 'its relay is gone: it drains');
    log.adopted[0].release();
    assert.ok(computeSlotHolder(), 'one end per job');
    log.adopted[1].release();
    assert.equal(computeSlotHolder(), null);
  });

  it('a core solve on the runner is adopted with its run on the claim (kind solve, its run id and name)', async () => {
    const rec = { id: 'fc-aaaaaaaa-333333', kind: 'solve', project_id: 'p1', plugin: 'incompressible_flow', run_id: 'r7', run_name: 'Run 7', simulation_id: 's1' };
    const foam = { id: 'fc-aaaaaaaa-444444', kind: 'foam', project_id: 'p2', plugin: 'foam-demo', plugin_name: 'Foam demo', study_id: 's1', study_title: 'Cavity', case_rel: 'cases/c1' };
    const { deps, log } = fakes({ listRunner: () => [foam, rec] });
    await rediscoverAtBoot({ deps });
    assert.deepEqual(log.adopted.map((a) => a.rec.id), [foam.id, rec.id]);
    assert.equal(computeSlotHolder().kind, 'foam');
    log.adopted[0].release();
    const h = computeSlotHolder();
    assert.deepEqual(
      [h.kind, h.phase, h.job_id, h.run_id, h.name, h.plugin, h.study_id, h.project_id],
      ['solve', 'running', rec.id, 'r7', 'Run 7', null, null, 'p1'],
    );
    assert.ok(holderIsRow(h, { kind: 'solve', project_id: 'p1', run_id: 'r7' }));
    log.adopted[1].release();
    assert.equal(computeSlotHolder(), null);
  });

  it('a reap that throws still releases the check claim', async () => {
    const { deps } = fakes({
      listCore: () => [coreDoc('p1', 'r1')],
      reap: () => {
        throw new Error('run.json locked');
      },
    });
    await rediscoverAtBoot({ deps });
    assert.equal(computeSlotHolder(), null);
  });

  it('two followed core runs: an onGone that throws still moves the claim to the other, and the last end releases', async () => {
    const { deps, log } = fakes({
      listCore: () => [coreDoc('p1', 'a'), coreDoc('p2', 'b')],
      probe: async () => 'live',
      reap: (pid, runId) => {
        if (runId === 'a') throw new Error('reap failed');
      },
      watch: (opts) => {
        log.watches.push(opts);
        return { cancel() {} };
      },
    });
    await rediscoverAtBoot({ deps });
    assert.equal(log.watches.length, 2);
    assert.equal(computeSlotHolder().run_id, 'a');
    // The watch runs onGone in try/catch and then releases (wsl-case-watch.js).
    try {
      log.watches[0].onGone();
    } catch {
      /* the watch logs it */
    } finally {
      log.watches[0].release();
    }
    assert.deepEqual([computeSlotHolder().run_id, computeSlotHolder().project_id], ['b', 'p2']);
    log.watches[1].release();
    assert.equal(computeSlotHolder(), null);
  });

  it('a core run then a plugin case: both projects stay named until their job ends; the claim takes each job in turn', async () => {
    const rec = { id: 'fc-abc123-aaaaaa', kind: 'foam', project_id: 'pfoam', plugin: 'foam-demo', plugin_name: 'Foam demo', study_id: 's1', study_title: 'Cavity', case_rel: 'cases/c1' };
    const { deps, log } = fakes({
      listCore: () => [coreDoc('pcore', 'aa11bb22')],
      listRunner: () => [rec],
      probe: async () => 'live',
    });
    await rediscoverAtBoot({ deps });
    let h = computeSlotHolder();
    assert.deepEqual([h.kind, h.phase, h.run_id, h.project_id, h.project_ids], ['solve', 'draining', 'aa11bb22', 'pcore', ['pcore', 'pfoam']]);
    // The plugin case's project cannot be deleted while it runs (project and folder delete read this).
    assert.equal(slot.holderNamesProject(h, 'pfoam'), true);
    assert.equal(slot.projectBusyMessage(h, 'pfoam'), 'A job left running in this project has not ended yet. Try again when it has ended.');
    assert.equal(slot.folderBusyMessage(h, 'Foam project', 'pfoam'), 'A job left running in Foam project has not ended yet. Try again when it has ended.');
    assert.equal(slot.projectBusyMessage(h, 'pcore'), 'A job in this project is still stopping. Try again when it has stopped.');
    // The core run ends: the claim is the plugin case's, with its kind (never a phantom core solve).
    log.watches[0].release();
    h = computeSlotHolder();
    assert.deepEqual(
      [h.kind, h.phase, h.run_id, h.job_id, h.plugin, h.project_id, h.project_ids],
      ['foam', 'running', null, 'fc-abc123-aaaaaa', 'foam-demo', 'pfoam', undefined],
    );
    assert.ok(holderIsRow(h, { kind: 'foam', project_id: 'pfoam', job_id: 'fc-abc123-aaaaaa' }));
    assert.equal(slot.holderNamesProject(h, 'pcore'), false);
    assert.equal(slot.projectBusyMessage(h, 'pfoam'), 'A plugin case in this project is running. Stop it before deleting the project.');
    log.adopted[0].release();
    assert.equal(computeSlotHolder(), null);
  });

  it("the claim takes the next job as it is now: its relay died meanwhile (draining), a stop asked meanwhile", async () => {
    const recs = [
      { id: 'fc-aaaaaaaa-111111', kind: 'foam', project_id: 'p1', plugin: 'foam-demo', study_id: 's1', case_rel: 'cases/c1' },
      { id: 'fc-aaaaaaaa-222222', kind: 'foam', project_id: 'p1', plugin: 'foam-demo', study_id: 's1', case_rel: 'cases/c2' },
    ];
    const phases = {};
    const records = {};
    const { deps, log } = fakes({
      listRunner: () => recs,
      runnerPhase: (id) => phases[id] || null,
      readRecord: (id) => records[id] || null,
    });
    await rediscoverAtBoot({ deps });
    assert.deepEqual([computeSlotHolder().job_id, computeSlotHolder().phase, computeSlotHolder().stop_requested], ['fc-aaaaaaaa-111111', 'running', false]);
    // While the first is described, the second's relay dies and a Stop is asked for it.
    phases['fc-aaaaaaaa-222222'] = 'draining';
    records['fc-aaaaaaaa-222222'] = { ...recs[1], stop: { by: 'user', level: 'graceful' } };
    log.adopted[0].release();
    const h = computeSlotHolder();
    assert.deepEqual([h.job_id, h.phase, h.stop_requested], ['fc-aaaaaaaa-222222', 'draining', true]);
    log.adopted[1].release();
    assert.equal(computeSlotHolder(), null);
  });

  it('a follow that throws ends that job: the claim moves to the next, or is released when none is left', async () => {
    const rec = { id: 'fc-abc123-bbbbbb', kind: 'foam', project_id: 'p2', plugin: 'foam-demo', study_id: 's1', case_rel: 'cases/c1' };
    const first = fakes({
      listCore: () => [coreDoc('p1', 'r1')],
      listRunner: () => [rec],
      probe: async () => 'live',
      watch: () => {
        throw new Error('watch could not start');
      },
    });
    await rediscoverAtBoot({ deps: first.deps });
    const h = computeSlotHolder();
    assert.deepEqual([h.kind, h.job_id, h.project_id], ['foam', 'fc-abc123-bbbbbb', 'p2']);
    first.log.adopted[0].release();
    assert.equal(computeSlotHolder(), null);
    // The only followed job's adopt throws: the claim goes at once.
    resetComputeSlotForTests();
    const only = fakes({
      listRunner: () => [rec],
      adopt: () => {
        throw new Error('adopt failed');
      },
    });
    await rediscoverAtBoot({ deps: only.deps });
    assert.equal(computeSlotHolder(), null);
  });

  it('a check release before boot() kicks nothing; boot() installs the kick and kicks once (source and behaviour)', async () => {
    let kicks = 0;
    queue.resetComputeQueueForTests({ filePath: join(ROOT, 'queue.json'), items: [], deps: { isBusy: () => (kicks += 1, computeSlotHolder() !== null) } });
    setSlotReleaseHook(null);
    const { deps } = fakes({ listCore: () => [coreDoc('p1', 'r1')] });
    await rediscoverAtBoot({ deps });
    assert.equal(computeSlotHolder(), null);
    await new Promise((r) => setTimeout(r, 350));
    assert.equal(kicks, 0, 'no hook yet: no kick');
    const live = readFileSync(join(HERE, '..', 'server', 'live-routes.js'), 'utf8').replace(/\r\n/g, '\n');
    const boot = live.slice(live.indexOf('    boot() {'), live.indexOf('\n    },\n', live.indexOf('    boot() {')));
    const hookLine = 'setSlotReleaseHook(() => scheduleComputeQueueKick(250));';
    assert.ok(boot.includes(hookLine));
    assert.ok(boot.indexOf(hookLine) < boot.indexOf('scheduleComputeQueueKick(400)'));
    // What boot() does with the slot: the hook, then its one kick.
    setSlotReleaseHook(() => queue.scheduleComputeQueueKick(250));
    queue.scheduleComputeQueueKick(400);
    await new Promise((r) => setTimeout(r, 550));
    assert.equal(kicks, 1);
    const c = slot.claimComputeSlot('mesh', { project_id: 'p1' });
    slot.releaseComputeSlot(c.token);
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(kicks, 2, 'every release kicks once boot() ran');
    setSlotReleaseHook(null);
  });

  it('registerLiveRoutes clears an old hook first and runs the check right after wiring the queue (source)', () => {
    const live = readFileSync(join(HERE, '..', 'server', 'live-routes.js'), 'utf8').replace(/\r\n/g, '\n');
    const start = live.indexOf('export function registerLiveRoutes(');
    const body = live.slice(start, live.indexOf("router.get('/api/compute-queue'", start));
    const iNull = body.indexOf('setSlotReleaseHook(null);');
    const iApi = body.indexOf('getCaseFieldApi()');
    const iWire = body.indexOf('wireComputeQueue(api);');
    const iCheck = body.indexOf('rediscoverAtBoot()');
    const iHooks = body.indexOf("worker.on('registry-changed'");
    assert.ok(iNull > 0 && iNull < iApi, 'the hook is cleared before anything else');
    assert.ok(iWire < iCheck && iCheck < iHooks, `${iWire} ${iCheck} ${iHooks}`);
    assert.ok(!/setSlotReleaseHook\(\(\)/.test(body), 'only boot() installs the kick');
  });
});

// ---- the core run docs it reads and writes ----

function seedProject(pid) {
  const dir = join(PROJECTS, pid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'project.json'), JSON.stringify({ id: pid, title: pid }));
  layout.createGeometryFolder(dir, { id: 'g1', name: 'G', original_filename: 'g.step' });
  layout.createStudyFolder(dir, 'g1', { id: 's1', name: 'Study 1' });
}

const runDoc = (pid, runId, fields) => studyIo.persistRun(pid, 's1', { id: runId, run_id: runId, name: runId, simulation_id: 's1', ...fields });
const readDoc = (pid, runId) => JSON.parse(readFileSync(join(studyIo.runFolderOf(pid, runId).dir, 'run.json'), 'utf8'));

describe('run docs of the boot check', () => {
  it('lists running, starting and draining docs with a WSL case; relay pids are not trusted', () => {
    seedProject('proj-l');
    runDoc('proj-l', 'r_run', { status: 'running', wsl_case: 'cfddesk-w27-r_run', pid: process.pid });
    runDoc('proj-l', 'r_start', { status: 'starting', wsl_case: 'cfddesk-w27-r_start' });
    runDoc('proj-l', 'r_drain', { status: 'stopped', draining: true, wsl_case: 'cfddesk-w27-r_drain' });
    runDoc('proj-l', 'r_done', { status: 'done', wsl_case: 'cfddesk-w27-r_done' });
    runDoc('proj-l', 'r_nocase', { status: 'running' });
    const found = w27.listSolveDocsToCheck().filter((d) => d.project_id === 'proj-l');
    assert.deepEqual(found.map((d) => d.run_id).sort(), ['r_drain', 'r_run', 'r_start']);
    assert.equal(found.find((d) => d.run_id === 'r_run').wsl_case, 'cfddesk-w27-r_run');
  });

  it('a run on the step-list runner (runner_job_id) is not listed: its runner record is followed instead', () => {
    seedProject('proj-n');
    runDoc('proj-n', 'r_legacy', { status: 'running', wsl_case: 'cfddesk-w27-r_legacy' });
    runDoc('proj-n', 'r_runner', { status: 'running', wsl_case: 'cfddesk-w27-r_runner', runner_job_id: 'fc-aaaaaaaa-555555', pid: null });
    runDoc('proj-n', 'r_runner_drain', { status: 'stopped', draining: true, wsl_case: 'cfddesk-w27-r_runner_drain', runner_job_id: 'fc-aaaaaaaa-666666' });
    const found = w27.listSolveDocsToCheck().filter((d) => d.project_id === 'proj-n');
    assert.deepEqual(found.map((d) => d.run_id), ['r_legacy']);
  });

  it('reapCheckedSolveDoc never makes a deleted run again, and keeps a stop asked for after the snapshot', () => {
    seedProject('proj-r');
    runDoc('proj-r', 'gone', { status: 'running', wsl_case: 'cfddesk-w27-gone' });
    const dir = studyIo.runFolderOf('proj-r', 'gone').dir;
    rmSync(dir, { recursive: true, force: true });
    assert.equal(w27.reapCheckedSolveDoc('proj-r', 'gone'), null);
    assert.ok(!existsSync(dir));
    assert.equal(studyIo.runFolderOf('proj-r', 'gone'), null, 'no run of that id anywhere');
    runDoc('proj-r', 'kept', { status: 'running', wsl_case: 'cfddesk-w27-kept' });
    w27.patchRunDocIfPresent('proj-r', 'kept', { stop_requested: true });
    w27.reapCheckedSolveDoc('proj-r', 'kept');
    const doc = readDoc('proj-r', 'kept');
    assert.equal(doc.status, 'failed', 'no saved frame');
    assert.equal(doc.stop_requested, true);
    assert.equal(doc.draining, false);
    runDoc('proj-r', 'drained', { status: 'stopped', draining: true, wsl_case: 'cfddesk-w27-drained' });
    w27.reapCheckedSolveDoc('proj-r', 'drained');
    assert.deepEqual([readDoc('proj-r', 'drained').status, readDoc('proj-r', 'drained').draining], ['stopped', false]);
  });

  it('a list call never reaps a run the slot holds (starting too), nor anything during the check; its own Start may', () => {
    seedProject('proj-g');
    const fresh = (runId) => runDoc('proj-g', runId, { status: 'running', pid: 999999 });
    const status = (runId) => w27.getRunStatus('proj-g', runId, 's1');
    fresh('held');
    slot.claimComputeSlot('solve', { project_id: 'proj-g', run_id: 'held' }, { phase: 'running' });
    status('held');
    assert.equal(readDoc('proj-g', 'held').status, 'running', 'held running');
    resetComputeSlotForTests();
    slot.claimComputeSlot('solve', { project_id: 'proj-g', run_id: 'held' }, { phase: 'draining' });
    status('held');
    assert.equal(readDoc('proj-g', 'held').status, 'running', 'held draining');
    resetComputeSlotForTests();
    slot.claimComputeSlot('check', { project_ids: ['other'] }, { phase: 'checking' });
    status('held');
    assert.equal(readDoc('proj-g', 'held').status, 'running', 'nothing is reaped while the check runs');
    resetComputeSlotForTests();
    slot.claimComputeSlot('solve', { project_id: 'proj-g', run_id: 'held' }, { phase: 'starting' });
    status('held');
    // Its doc says running while the worker plans it, before the runner has a record:
    // a status read then must not reap it (the v0.3.0 gate's "exited before the first
    // saved iteration"); its own Start may, clearing a doc an earlier attempt left.
    assert.equal(readDoc('proj-g', 'held').status, 'running', 'a status read never reaps the run its slot is starting');
    w27.reapStaleRunningDocForTests('proj-g', readDoc('proj-g', 'held'), { ownStart: true });
    assert.equal(readDoc('proj-g', 'held').status, 'failed', 'its own Start reaps its stale doc');
    resetComputeSlotForTests();
    fresh('free');
    status('free');
    assert.equal(readDoc('proj-g', 'free').status, 'failed', 'no holder: reaped as today');
  });
});
