// H15: one compute slot per server process (scripts/compute-slot.js).
import { after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-slot-'));
const PROJECTS = join(ROOT, 'projects');
mkdirSync(PROJECTS, { recursive: true });
// Before the first app import: PROJECTS_ROOT is read once.
process.env.MAGNUSIM_PROJECTS_ROOT = PROJECTS;
process.env.MAGNUSIM_LOCAL_JSON = join(ROOT, 'local.json');

const slot = await import('../../compute-slot.js');
const {
  claimComputeSlot,
  computeSlotHolder,
  currentSlotToken,
  folderBusyMessage,
  holderIsRow,
  holderNamesProject,
  markBootOnce,
  noteStartCancel,
  patchComputeSlot,
  projectBusyMessage,
  releaseComputeSlot,
  resetComputeSlotForTests,
  runClaimed,
  sameProjectFolder,
  setSlotReleaseHook,
  slotRefusal,
  solveClaimDecision,
  takeStartCancel,
} = slot;

after(() => {
  try {
    rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* Windows may still hold a file */
  }
});

beforeEach(() => resetComputeSlotForTests());

describe('one claim', () => {
  it('a second claim is refused with the holder; stale tokens do nothing', () => {
    const a = claimComputeSlot('mesh', { project_id: 'p1', mesh_id: 'm1', name: 'Mesh 1' }, { phase: 'running' });
    assert.equal(a.ok, true);
    const b = claimComputeSlot('solve', { project_id: 'p2', run_id: 'r1' });
    assert.equal(b.ok, false);
    assert.equal(b.holder.kind, 'mesh');
    assert.equal(b.holder.mesh_id, 'm1');
    assert.equal(computeSlotHolder().token, a.token);
    // A copy: changing it changes nothing.
    computeSlotHolder().phase = 'draining';
    assert.equal(computeSlotHolder().phase, 'running');
    assert.equal(patchComputeSlot('slot-stale', { phase: 'draining' }), false);
    assert.equal(releaseComputeSlot('slot-stale'), false);
    assert.equal(currentSlotToken(), a.token);
    assert.equal(releaseComputeSlot(a.token), true);
    assert.equal(computeSlotHolder(), null);
    // A token released once is stale for good.
    const c = claimComputeSlot('foam', { project_id: 'p1', job_id: 'fc-abcdefgh-123456' });
    assert.equal(releaseComputeSlot(a.token), false);
    assert.equal(currentSlotToken(), c.token);
  });

  it('patchComputeSlot merges phase, stop, name and ids; kind moves only on the boot check claim, never back to check', () => {
    const c = claimComputeSlot('check', { name: 'Checking for jobs left running', project_ids: ['p1', 'p2'] }, { phase: 'checking' });
    assert.deepEqual(computeSlotHolder().project_ids, ['p1', 'p2']);
    patchComputeSlot(c.token, { kind: 'check', phase: 'draining' });
    assert.equal(computeSlotHolder().kind, 'check');
    patchComputeSlot(c.token, { kind: 'solve', phase: 'draining', project_ids: null, project_id: 'p1', run_id: 'r9', name: 'Run 9', stop_requested: true });
    const h = computeSlotHolder();
    assert.equal(h.kind, 'solve');
    assert.equal(h.phase, 'draining');
    assert.equal(h.project_ids, undefined);
    assert.equal(h.run_id, 'r9');
    assert.equal(h.stop_requested, true);
    // The check hands its claim to the next job it follows: a plugin case after a core run.
    patchComputeSlot(c.token, { kind: 'foam', phase: 'running', run_id: null, job_id: 'fc-abcdefgh-123456', project_id: 'p2' });
    assert.deepEqual([computeSlotHolder().kind, computeSlotHolder().run_id, computeSlotHolder().job_id], ['foam', null, 'fc-abcdefgh-123456']);
    // Never back to check.
    patchComputeSlot(c.token, { kind: 'check' });
    assert.equal(computeSlotHolder().kind, 'foam');
    releaseComputeSlot(c.token);
    // A claim a job took keeps its kind: a solve claim never becomes a mesh.
    const s = claimComputeSlot('solve', { project_id: 'p1', run_id: 'r1' }, { phase: 'running' });
    patchComputeSlot(s.token, { kind: 'mesh' });
    assert.equal(computeSlotHolder().kind, 'solve');
    patchComputeSlot(s.token, { kind: 'check' });
    assert.equal(computeSlotHolder().kind, 'solve');
  });

  it('runClaimed releases on a refusal and on a throw, not after keep()', async () => {
    let c = claimComputeSlot('solve', { project_id: 'p', run_id: 'r' }, { phase: 'starting' });
    const refused = await runClaimed(c.token, () => ({ ok: false, status: 400 }));
    assert.equal(refused.status, 400);
    assert.equal(computeSlotHolder(), null);

    c = claimComputeSlot('solve', { project_id: 'p', run_id: 'r' }, { phase: 'starting' });
    await assert.rejects(
      runClaimed(c.token, async () => {
        await Promise.resolve();
        throw new Error('boom');
      }),
      /boom/,
    );
    assert.equal(computeSlotHolder(), null, 'released before the rejection reached the caller');

    c = claimComputeSlot('solve', { project_id: 'p', run_id: 'r' }, { phase: 'starting' });
    await assert.rejects(runClaimed(c.token, () => { throw new Error('sync'); }), /sync/);
    assert.equal(computeSlotHolder(), null);

    c = claimComputeSlot('solve', { project_id: 'p', run_id: 'r' }, { phase: 'starting' });
    let saw = null;
    await runClaimed(c.token, async (s) => {
      patchComputeSlot(s.token, { stop_requested: true });
      saw = s.stopRequested();
      s.keep();
      return { ok: true };
    });
    assert.equal(saw, true);
    assert.equal(computeSlotHolder().token, c.token, 'kept: the job holds it now');
    releaseComputeSlot(c.token);
  });

  it('one claim for two module instances (a Vite re-import)', async () => {
    const other = await import('../../compute-slot.js?v=2');
    assert.notEqual(other.claimComputeSlot, claimComputeSlot);
    const c = claimComputeSlot('mesh', { project_id: 'p1', mesh_id: 'm1' });
    assert.equal(other.computeSlotHolder().token, c.token);
    assert.equal(other.claimComputeSlot('solve', { project_id: 'p2' }).ok, false);
    assert.equal(other.releaseComputeSlot(c.token), true);
    assert.equal(computeSlotHolder(), null);
  });

  it('a release calls the hook; a hook that throws never makes a release throw', () => {
    let calls = 0;
    setSlotReleaseHook(() => {
      calls += 1;
    });
    let c = claimComputeSlot('mesh', { project_id: 'p' });
    releaseComputeSlot(c.token);
    assert.equal(calls, 1);
    releaseComputeSlot(c.token);
    assert.equal(calls, 1, 'a stale release calls nothing');
    setSlotReleaseHook(() => {
      throw new Error('hook failed');
    });
    c = claimComputeSlot('mesh', { project_id: 'p' });
    assert.doesNotThrow(() => releaseComputeSlot(c.token));
    assert.equal(computeSlotHolder(), null);
    setSlotReleaseHook(null);
  });

  it('with no hook a release schedules no timer (so this file exits on its own)', () => {
    setSlotReleaseHook(null);
    const timers = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
    const before = timers();
    const c = claimComputeSlot('solve', { project_id: 'p' });
    releaseComputeSlot(c.token);
    assert.equal(timers(), before);
  });

  it('slotRefusal is the busy 409 the client queues on', () => {
    const c = claimComputeSlot('foam', { project_id: 'p1', name: 'Case · c1 · Foam demo' });
    const r = slotRefusal(computeSlotHolder());
    assert.equal(r.status, 409);
    assert.equal(r.bodyExtra.code, 'busy');
    assert.match(r.bodyExtra.error, /already running/);
    assert.deepEqual(r.bodyExtra.busy, { kind: 'foam', phase: 'running', project_id: 'p1', name: 'Case · c1 · Foam demo' });
    releaseComputeSlot(c.token);
  });
});

describe('the pending stop is keyed by the click', () => {
  it('kept 10 s, consumed once by that start_id only; other ids and bad ids never', () => {
    let now = 1_000_000;
    resetComputeSlotForTests({ now: () => now });
    const a = 's-lq2x8k9c-a1b2c3';
    const b = 's-lq2x8k9c-ffffff';
    assert.equal(noteStartCancel(a), true);
    assert.equal(takeStartCancel(b), false, 'another click');
    assert.equal(takeStartCancel(undefined), false, 'a queue start has no id');
    now += 9_000;
    assert.equal(takeStartCancel(a), true);
    assert.equal(takeStartCancel(a), false, 'consumed once');
    noteStartCancel(a);
    now += 10_001;
    assert.equal(takeStartCancel(a), false, 'older than 10 s');
    for (const bad of ['', 'short', 'S-UPPER-CASE-ID', 'x'.repeat(41), 's-has space', 42, null]) {
      assert.equal(noteStartCancel(bad), false, String(bad));
      assert.equal(takeStartCancel(bad), false, String(bad));
    }
  });
});

describe('a solve Start decides by the holder (solveClaimDecision)', () => {
  const cases = [
    [null, { runId: 'r1', sameFolder: false }, 'claim'],
    [{ kind: 'solve', phase: 'starting', run_id: 'r1' }, { runId: 'r1', sameFolder: true }, 'same_run'],
    // A cancelled start of this run that has not ended yet: the new Start queues behind it.
    [{ kind: 'solve', phase: 'starting', run_id: 'r1', stop_requested: true }, { runId: 'r1', sameFolder: true }, 'busy'],
    [{ kind: 'solve', phase: 'running', run_id: 'r1', stop_requested: true }, { runId: 'r1', sameFolder: true }, 'same_run'],
    [{ kind: 'solve', phase: 'running', run_id: 'r1' }, { runId: 'r1', sameFolder: true }, 'same_run'],
    [{ kind: 'solve', phase: 'draining', run_id: 'r1' }, { runId: 'r1', sameFolder: true }, 'busy'],
    [{ kind: 'solve', phase: 'running', run_id: 'r1' }, { runId: 'r1', sameFolder: false }, 'busy'],
    [{ kind: 'solve', phase: 'running', run_id: 'r2' }, { runId: 'r1', sameFolder: true }, 'busy'],
    [{ kind: 'mesh', phase: 'running', run_id: null }, { runId: 'r1', sameFolder: true }, 'busy'],
    [{ kind: 'foam', phase: 'running' }, { runId: 'r1', sameFolder: true }, 'busy'],
    [{ kind: 'check', phase: 'checking' }, { runId: 'r1', sameFolder: true }, 'busy'],
  ];
  for (const [holder, opts, want] of cases) {
    it(`${holder ? holder.kind + '/' + holder.phase : 'free'} ${JSON.stringify(opts)} -> ${want}`, () => {
      assert.equal(solveClaimDecision(holder, opts), want);
    });
  }
});

describe('startSolve claims before its first await (source scan)', () => {
  const src = readFileSync(join(HERE, '..', '..', 'w27-solve.js'), 'utf8');
  const wrapStart = src.indexOf('export async function startSolve(');
  const bodyStart = src.indexOf('async function startSolveBody(opts = {}, slot) {');
  const bodyEnd = src.indexOf('const STOP_GRACE_MS');
  // Code only: comments may say "await".
  const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const wrapper = code(src.slice(wrapStart, bodyStart));
  const body = code(src.slice(bodyStart, bodyEnd));

  it('the wrapper claims, and has no await at all', () => {
    assert.ok(wrapStart > 0 && bodyStart > wrapStart && bodyEnd > bodyStart);
    assert.ok(!/\bawait\b/.test(wrapper), 'no await before the claim');
    const iClaim = wrapper.indexOf("claimComputeSlot('solve'");
    assert.ok(iClaim > 0);
    assert.ok(wrapper.indexOf('solveClaimDecision(') < iClaim);
    assert.ok(wrapper.indexOf('takeStartCancel(') < iClaim);
    assert.ok(wrapper.indexOf('runClaimed(') > iClaim);
    assert.match(wrapper, /code: 'same_run'/);
    assert.match(wrapper, /code: 'stopped', stopped: true/);
  });

  it('from the stop check to spawnJob there is no await; keep() comes after spawnJob', () => {
    const iStop = body.indexOf('if (slot.stopRequested())');
    const iSpawn = body.indexOf('spawnJob({');
    const iKeep = body.indexOf('slot.keep()');
    assert.ok(iStop > 0 && iSpawn > iStop && iKeep > iSpawn, `${iStop} ${iSpawn} ${iKeep}`);
    assert.ok(!/\bawait\b/.test(body.slice(iStop, iSpawn)));
    const iHold = body.indexOf('MAGNUSIM_TEST_START_HOLD_MS');
    assert.ok(iHold > 0 && iHold < iStop);
    // The last await before the stop check is the test hold, after every check of the run.
    assert.ok(body.lastIndexOf('await', iStop) > body.indexOf('normalizeSteadySettings('));
    assert.ok(body.indexOf('persistRun(id, simId, {') > iStop, 'the run is marked running only after the stop check');
  });

  it("right after spawnJob the claim is the run's: kept, phase running, its token on liveRun", () => {
    // A claim left `starting` would make the Run panel's Stop a "cancel this start" that stops nothing.
    const iSpawn = body.indexOf('spawnJob({');
    const after = body.slice(body.indexOf('slot.keep()', iSpawn));
    assert.match(after, /^slot\.keep\(\); patchComputeSlot\(slot\.token, \{ phase: 'running' \}\);\s*\n\s*thisRun = liveRun = \{/);
    assert.match(after.slice(0, after.indexOf('};')), /slot_token: slot\.token,/);
    assert.equal(body.split('slot.keep()').length, 2, 'kept in one place only');
  });

  it('on the runner: after the plan (its only await) the Stop is read again, then the launch and keep() with no await between', () => {
    const start = src.indexOf('async function startSolveOnRunner(');
    const runner = code(src.slice(start, src.indexOf('\n}\n', start)));
    const iPlan = runner.indexOf("await commitRpc('analysis.plan_run'");
    const iStop = runner.indexOf('if (slot.stopRequested())');
    const iLaunch = runner.indexOf('launchCoreSolve({');
    const iKeep = runner.indexOf('slot.keep()');
    assert.ok(iPlan > 0 && iStop > iPlan && iLaunch > iStop && iKeep > iLaunch, `${iPlan} ${iStop} ${iLaunch} ${iKeep}`);
    assert.equal(runner.split('await').length, 2, 'one await: the plan');
    assert.equal(runner.split('slot.keep()').length, 2, 'kept in one place only');
    assert.match(runner, /claimToken: slot\.token,/);
    // startSolveBody hands over after its own stop check and the running stamp.
    assert.ok(body.indexOf('return startSolveOnRunner({') > body.indexOf('builtFrom ? { builtFrom } : undefined'));
  });
});

describe('project folders', () => {
  it('compare by real folder: the same id, another letter case on Windows, a junction', () => {
    mkdirSync(join(PROJECTS, 'proj-a'), { recursive: true });
    mkdirSync(join(PROJECTS, 'proj-b'), { recursive: true });
    assert.equal(sameProjectFolder('proj-a', 'proj-a'), true);
    assert.equal(sameProjectFolder('proj-a', 'proj-b'), false);
    assert.equal(sameProjectFolder('', ''), false);
    assert.equal(sameProjectFolder(null, 'proj-a'), false);
    if (process.platform === 'win32') {
      assert.equal(sameProjectFolder('PROJ-A', 'proj-a'), true);
      symlinkSync(join(PROJECTS, 'proj-a'), join(PROJECTS, 'proj-link'), 'junction');
      assert.equal(sameProjectFolder('proj-link', 'proj-a'), true);
      assert.equal(sameProjectFolder('proj-link', 'proj-b'), false);
    }
    assert.equal(sameProjectFolder('../proj-a', 'proj-a'), false);
  });

  it('the holder names a project by its job, or by the boot check list', () => {
    assert.equal(holderNamesProject(null, 'proj-a'), false);
    assert.equal(holderNamesProject({ kind: 'mesh', project_id: 'proj-a' }, 'proj-a'), true);
    assert.equal(holderNamesProject({ kind: 'check', project_id: null, project_ids: ['proj-b'] }, 'proj-b'), true);
    assert.equal(holderNamesProject({ kind: 'check', project_id: null, project_ids: ['proj-b'] }, 'proj-a'), false);
  });

  it('the busy texts', () => {
    assert.equal(projectBusyMessage({ kind: 'foam', phase: 'running' }), 'A plugin case in this project is running. Stop it before deleting the project.');
    assert.equal(projectBusyMessage({ kind: 'mesh', phase: 'running' }), 'A mesh in this project is generating. Stop it before deleting the project.');
    assert.equal(projectBusyMessage({ kind: 'solve', phase: 'starting' }), 'A run in this project is solving. Stop it before deleting the project.');
    assert.equal(projectBusyMessage({ kind: 'solve', phase: 'draining' }), 'A job in this project is still stopping. Try again when it has stopped.');
    assert.equal(projectBusyMessage({ kind: 'foam', phase: 'draining' }), 'A job in this project is still stopping. Try again when it has stopped.');
    assert.equal(projectBusyMessage({ kind: 'check', phase: 'checking' }), 'The app is checking this project for jobs left running. Try again in a few seconds.');
    assert.equal(folderBusyMessage({ kind: 'mesh', phase: 'running' }, 'Queue project A'), 'A job in Queue project A is running. Stop it before deleting the folder.');
    assert.equal(folderBusyMessage({ kind: 'solve', phase: 'draining' }, 'P'), 'A job in P is still stopping. Try again when it has stopped.');
    assert.equal(folderBusyMessage({ kind: 'check', phase: 'checking' }, 'P'), 'The app is checking P for jobs left running. Try again in a few seconds.');
  });

  it('holderIsRow: the claim is the job of that queue row', () => {
    const mesh = { kind: 'mesh', project_id: 'proj-a', mesh_id: 'm1' };
    const solve = { kind: 'solve', project_id: 'proj-a', run_id: 'r1' };
    const foam = { kind: 'foam', project_id: 'proj-a', job_id: 'fc-aaaaaaaa-111111' };
    assert.equal(holderIsRow(mesh, { kind: 'mesh', project_id: 'proj-a', mesh_id: 'm1' }), true);
    assert.equal(holderIsRow(mesh, { kind: 'mesh', project_id: 'proj-b', mesh_id: 'm1' }), false);
    assert.equal(holderIsRow(mesh, { kind: 'mesh', project_id: 'proj-a', mesh_id: 'm2' }), false);
    assert.equal(holderIsRow(solve, { kind: 'solve', project_id: 'proj-a', run_id: 'r1' }), true);
    assert.equal(holderIsRow(solve, { kind: 'mesh', project_id: 'proj-a', mesh_id: 'r1' }), false);
    assert.equal(holderIsRow(foam, { kind: 'foam', project_id: 'proj-a', job_id: 'fc-aaaaaaaa-111111' }), true);
    assert.equal(holderIsRow(foam, { kind: 'foam', project_id: 'proj-a', job_id: 'fc-aaaaaaaa-222222' }), false);
    assert.equal(holderIsRow(null, { kind: 'mesh', project_id: 'proj-a', mesh_id: 'm1' }), false);
  });

  it('markBootOnce is true once per process', () => {
    assert.equal(markBootOnce(), true);
    assert.equal(markBootOnce(), false);
  });
});
