// A repeated Stop (run health spec RH1 §3.4): a second plain Stop never silently becomes a forced
// stop, for the person and the Assistant, plugin cases included. The rule (stop-decision.js): force
// ends a run at once; a plain Stop is graceful, and a repeated plain one answers that it is
// already stopping. The runner path's levels are in solve-stop-slot.test.mjs and
// server/__tests__/foam-runner.test.js; here the rule itself and the fake solve's Stop
// (MAGNUSIM_TEST_SOLVE_STOP_SECONDS), which the e2e assistant-stop-twice.spec.js drives.
import { after, afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-stop-again-'));
const PROJECTS = join(ROOT, 'projects');
mkdirSync(PROJECTS, { recursive: true });
process.env.MAGNUSIM_PROJECTS_ROOT = PROJECTS;
process.env.MAGNUSIM_LOCAL_JSON = join(ROOT, 'local.json');
process.env.MAGNUSIM_QUEUE_QUIET = '1';

const { stopDecision } = await import('../stop-decision.js');
const fakeSolve = await import('../test-solve.js');
const slot = await import('../compute-slot.js');
const queue = await import('../server/compute-queue.ts');
const layout = await import('../project-layout.js');
const studyIo = await import('../study-io.js');

const PID = 'proj-stop';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

after(() => {
  try {
    rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* Windows may hold a file */
  }
});

describe('stopDecision', () => {
  it('force ends it at once; a plain Stop is graceful, and a repeated plain one is still not forced', () => {
    assert.deepEqual(stopDecision({}, false), { forced: false, already: false, note: 'Stopping.' });
    // The runner's record (stop) and the run doc (stop_requested) both say it is stopping.
    assert.deepEqual(stopDecision({ stop: { level: 'graceful' } }, false), { forced: false, already: true, note: 'Stopping.' });
    assert.deepEqual(stopDecision({ stop_requested: true }, false), { forced: false, already: true, note: 'Stopping.' });
    assert.deepEqual(stopDecision({ stop_requested: true }, true), { forced: true, already: true, note: 'Force-stopping.' });
    assert.deepEqual(stopDecision(null, true), { forced: true, already: false, note: 'Force-stopping.' });
    // Only a real true forces (a query's "0" or a stray truthy value does not).
    assert.equal(stopDecision({}, 'yes').forced, false);
  });
});

describe("the fake solve's Stop (MAGNUSIM_TEST_SOLVE_STOP_SECONDS)", () => {
  let token = '';
  beforeEach(() => {
    slot.resetComputeSlotForTests();
    queue.resetComputeQueueForTests({ filePath: join(ROOT, 'queue.json'), items: [], deps: {} });
    const dir = join(PROJECTS, PID);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'project.json'), JSON.stringify({ id: PID, title: 'Stop' }));
    try {
      layout.createGeometryFolder(dir, { id: 'g1', name: 'G', original_filename: 'g.step' });
      layout.createStudyFolder(dir, 'g1', { id: 's1', name: 'Study 1' });
    } catch {
      /* already there */
    }
  });
  afterEach(() => {
    delete process.env.MAGNUSIM_TEST_SOLVE_STOP_SECONDS;
    delete process.env.MAGNUSIM_TEST_SOLVE_SECONDS;
  });

  function startFake(runId) {
    studyIo.persistRun(PID, 's1', { id: runId, run_id: runId, name: runId, simulation_id: 's1', status: 'draft' });
    const c = slot.claimComputeSlot('solve', { project_id: PID, run_id: runId, name: runId }, { phase: 'starting' });
    token = c.token;
    const ended = [];
    fakeSolve.startFakeSolve({ id: PID, runId, simId: 's1', slot: { token, keep() {} }, endTime: 100, onDone: (r) => ended.push(r) });
    return ended;
  }
  const doc = (runId) => JSON.parse(readFileSync(join(studyIo.runFolderOf(PID, runId, 's1').dir, 'run.json'), 'utf8'));

  it('a plain Stop holds it stopping; a second plain Stop answers already and changes nothing; it ends Stopped.', async () => {
    process.env.MAGNUSIM_TEST_SOLVE_SECONDS = '60';
    process.env.MAGNUSIM_TEST_SOLVE_STOP_SECONDS = '0.6';
    const ended = startFake('run_a');
    const first = fakeSolve.stopFakeSolve(PID, 'run_a');
    assert.deepEqual(first.bodyExtra, { ok: true, stopping: true, run_id: 'run_a' });
    assert.deepEqual([doc('run_a').status, doc('run_a').stage, doc('run_a').stop_requested, doc('run_a').note], ['running', 'stopping', true, 'Stopping.']);
    assert.equal(slot.computeSlotHolder().stop_requested, true);
    const second = fakeSolve.stopFakeSolve(PID, 'run_a');
    assert.deepEqual(second.bodyExtra, { ok: true, stopping: true, already: true, run_id: 'run_a' });
    assert.deepEqual(ended, [], 'still writing its current step');
    await sleep(900);
    assert.deepEqual(ended.map((r) => r.status), ['stopped']);
    assert.deepEqual([doc('run_a').status, doc('run_a').note, doc('run_a').stop_requested], ['stopped', 'Stopped.', false]);
    assert.equal(slot.computeSlotHolder(), null);
  });

  it('force ends it at once, also while a plain Stop holds it', () => {
    process.env.MAGNUSIM_TEST_SOLVE_SECONDS = '60';
    process.env.MAGNUSIM_TEST_SOLVE_STOP_SECONDS = '30';
    const ended = startFake('run_b');
    fakeSolve.stopFakeSolve(PID, 'run_b');
    const forced = fakeSolve.stopFakeSolve(PID, 'run_b', true);
    assert.deepEqual(forced.bodyExtra, { ok: true, stopped: true, forced: true, run_id: 'run_b' });
    assert.deepEqual(ended.map((r) => r.status), ['stopped']);
    assert.equal(doc('run_b').status, 'stopped');
  });

  it('without the hold, a Stop ends it at once, as before', () => {
    process.env.MAGNUSIM_TEST_SOLVE_SECONDS = '60';
    const ended = startFake('run_c');
    const r = fakeSolve.stopFakeSolve(PID, 'run_c');
    assert.deepEqual(r.bodyExtra, { ok: true, stopped: true, run_id: 'run_c' });
    assert.deepEqual(ended.map((x) => x.status), ['stopped']);
  });
});
