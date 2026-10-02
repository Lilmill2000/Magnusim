// H15: the step-list runner end to end without WSL: Node's runFoamSteps, the hidden
// starter and the real relay (python/tools/run_foam_case.py) running a prepare step
// on the core interpreter. Needs the Python side (part P1); no WSL.
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, '..', '..');
const FIXTURE_PLUGINS = join(WEB, 'python', 'tests', 'fixtures', 'foam-plugins');
const RELAY = join(WEB, 'python', 'tools', 'run_foam_case.py');
const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-steps-relay-'));
const PROJECTS = join(ROOT, 'projects');
const PLUGINS = join(ROOT, 'plugins');
mkdirSync(PROJECTS, { recursive: true });
// The relay loads the registry itself: it must find foam-demo, and only this test's settings.
cpSync(FIXTURE_PLUGINS, PLUGINS, { recursive: true });
writeFileSync(join(ROOT, 'local.json'), '{}');
process.env.MAGNUSIM_PROJECTS_ROOT = PROJECTS;
process.env.MAGNUSIM_LOCAL_JSON = join(ROOT, 'local.json');
process.env.MAGNUSIM_PLUGINS_DIR = PLUGINS;
process.env.MAGNUSIM_WSL_CASE_ROOT = '/home/tester/cases';
process.env.MAGNUSIM_QUEUE_QUIET = '1';

const ready = existsSync(RELAY) && existsSync(join(FIXTURE_PLUGINS, 'foam-demo', 'jobs', 'write_mesh_case.py'));
const runner = ready ? await import('../foam-runner.js') : null;
const store = ready ? await import('../foam-store.js') : null;
const slot = ready ? await import('../compute-slot.js') : null;
const queue = ready ? await import('../server/compute-queue.ts') : null;

after(() => {
  try {
    rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* a relay may still hold a file for a moment */
  }
});

const PID = 'proj-mesh';
const KEY = 'foam-demo';
const caseBase = join(PROJECTS, PID, 'plugins', KEY);
const JOB_ROW = { key: 'foam_demo_write_mesh_case', runtime: 'core', plugin: KEY, args_from_params: ['sleep', 'fail'] };
let n = 0;
/** @type {any[]} */
let frames = [];

async function until(check, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = check();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail(`timed out after ${ms} ms waiting for ${what}`);
}

/** A meshing plan with only the prepare step: the fixture JobKind on the core interpreter. */
function plan(params) {
  n += 1;
  const name = `m${n}`;
  const parts = ['studies', 's1', 'meshes', name];
  const caseDir = join(caseBase, ...parts);
  mkdirSync(caseDir, { recursive: true });
  const token = `00aa00${String(n).padStart(2, '0')}`;
  const rec = store.createFoamRecord({
    kind: 'mesh',
    project_id: PID,
    plugin: KEY,
    study_id: 's1',
    case_rel: `meshes/${name}`,
    case_parts: parts,
    case_dir: caseDir,
    case_base: caseBase,
    token,
    wsl_case: runner.foamWslCaseId(KEY, 's1', token),
    wsl_root: '/home/tester/cases',
    prepare: { job: JOB_ROW.key, runtime: 'core' },
  });
  return {
    rec,
    plan: {
      job_id: rec.id,
      claim: { kind: 'mesh', project_id: PID, mesh_id: name, name: `Mesh ${name}` },
      case_base: caseBase,
      case_parts: parts,
      case_dir: caseDir,
      plugin: KEY,
      wsl_case: rec.wsl_case,
      wsl_root: rec.wsl_root,
      token,
      prepare: runner.prepareFromJob(JOB_ROW, params, { jobId: rec.id, caseDir }),
      pre: [],
      n_procs: 1,
      slots_hint: null,
      solver: null,
    },
  };
}

const ended = (id) => () => {
  const r = store.readFoamRecord(id);
  return r && !['queued', 'running'].includes(r.status) ? r : null;
};

describe('the step-list runner with the real relay (no WSL)', { skip: !ready && 'the Python relay (part P1) is not here yet' }, () => {
  before(() => {
    mkdirSync(join(PROJECTS, PID), { recursive: true });
    writeFileSync(join(PROJECTS, PID, 'project.json'), JSON.stringify({ id: PID, title: 'Mesh project' }));
    mkdirSync(join(caseBase, 'studies', 's1'), { recursive: true });
    writeFileSync(join(caseBase, 'studies', 's1', 'study.json'), JSON.stringify({ id: 's1' }));
    store.resetFoamStoreForTests({ filePath: join(ROOT, 'foam-cases.json') });
    queue.resetComputeQueueForTests({ filePath: join(ROOT, 'queue.json'), items: [], deps: {} });
    runner.setFoamRunnerDepsForTests({ specDir: () => join(ROOT, 'foam-specs') });
    runner.registerStepRunKind('mesh', { onEvent: (rec, ev) => frames.push({ id: rec.id, ev }), onEnd: () => {} });
  });
  beforeEach(() => {
    frames = [];
    slot.resetComputeSlotForTests();
  });
  after(() => runner.setFoamRunnerDepsForTests(null));

  it('a prepare step runs, is awaited, writes the case; only its stage lines reach the events', async () => {
    const { rec, plan: p } = plan({});
    assert.deepEqual(runner.runFoamSteps(p), { ok: true });
    assert.equal(slot.computeSlotHolder().kind, 'mesh');
    const end = await until(ended(rec.id), 60_000, 'the run to end');
    assert.equal(end.status, 'done', `${end.code}: ${end.error}`);
    assert.ok(existsSync(join(rec.case_dir, 'system', 'blockMeshDict')), 'the prepare step wrote the case');
    assert.ok(existsSync(join(rec.case_dir, 'log.prepare')));
    assert.ok(existsSync(join(rec.case_dir, '.magnusim-ran')));
    const mine = frames.filter((f) => f.id === rec.id).map((f) => f.ev);
    assert.deepEqual(mine.filter((e) => e.event === 'prepare_stage').map((e) => e.stage), ['writing'], 'a bad stage name never passes');
    assert.deepEqual(mine.find((e) => e.event === 'prepare'), { event: 'prepare', job: 'foam_demo_write_mesh_case', exit_code: 0 });
    assert.ok(mine.some((e) => e.event === 'stage' && e.stage === 'prepare'));
    assert.ok(!mine.some((e) => e.event === 'result' || e.event === 'time_saved'), 'a forged result line never passes');
    assert.equal(mine.at(-1).event, 'end');
    assert.equal(slot.computeSlotHolder(), null, 'the slot is free');
  });

  it('a prepare step that exits 3 ends failed (code prepare) with the fixed text', async () => {
    const { rec, plan: p } = plan({ fail: 3 });
    runner.runFoamSteps(p);
    const end = await until(ended(rec.id), 60_000, 'the run to end');
    assert.deepEqual([end.status, end.code, end.error], ['failed', 'prepare', 'Prepare step foam_demo_write_mesh_case failed (exit 3). See log.prepare in the case folder']);
    assert.equal(slot.computeSlotHolder(), null);
  });

  it('a Stop during a prepare step that sleeps ends its process tree; the run is stopped', async () => {
    const { rec, plan: p } = plan({ sleep: 60 });
    runner.runFoamSteps(p);
    await until(() => frames.some((f) => f.id === rec.id && f.ev.event === 'prepare_stage'), 60_000, 'the prepare step to start');
    const t0 = Date.now();
    runner.stopFoamCase(rec.id, { by: 'user' });
    const end = await until(ended(rec.id), 30_000, 'the stopped run to end');
    assert.equal(end.status, 'stopped');
    assert.ok(Date.now() - t0 < 25_000, 'it did not wait for the 60 s sleep');
    assert.equal(slot.computeSlotHolder(), null);
    assert.equal(await runner.relayAlive(rec.id), false, 'no process of the run is left (the tool included)');
  });
});
