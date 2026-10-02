// H15 core gap (b): a project or folder with a running or stopping job cannot be
// deleted (by folder, in any spelling); deleting a project drops its queued jobs.
import { after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-del-jobs-'));
const PROJECTS = join(ROOT, 'projects');
mkdirSync(PROJECTS, { recursive: true });
process.env.MAGNUSIM_PROJECTS_ROOT = PROJECTS;
process.env.MAGNUSIM_LOCAL_JSON = join(ROOT, 'local.json');
process.env.MAGNUSIM_WSL_CASE_ROOT = '/home/tester/cases';
process.env.MAGNUSIM_QUEUE_QUIET = '1';

const { deleteFolder, deleteProject } = await import('../w16-project-geometry.js');
const slot = await import('../compute-slot.js');
const queue = await import('../server/compute-queue.ts');
const { claimComputeSlot, resetComputeSlotForTests } = slot;

after(() => {
  try {
    rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* Windows may hold a file */
  }
});

function project(id, title, folder) {
  const dir = join(PROJECTS, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'project.json'), JSON.stringify({ id, title, ...(folder ? { folder } : {}) }));
  return dir;
}

beforeEach(() => {
  rmSync(PROJECTS, { recursive: true, force: true });
  mkdirSync(PROJECTS, { recursive: true });
  resetComputeSlotForTests();
  queue.resetComputeQueueForTests({ filePath: join(ROOT, 'queue.json'), items: [], deps: {} });
  project('proj-a', 'Queue project A');
  project('proj-b', 'Queue project B');
});

const HOLDERS = [
  [['foam', 'running'], 'A plugin case in this project is running. Stop it before deleting the project.'],
  [['mesh', 'running'], 'A mesh in this project is generating. Stop it before deleting the project.'],
  [['solve', 'starting'], 'A run in this project is solving. Stop it before deleting the project.'],
  [['solve', 'running'], 'A run in this project is solving. Stop it before deleting the project.'],
  [['solve', 'draining'], 'A job in this project is still stopping. Try again when it has stopped.'],
  [['foam', 'draining'], 'A job in this project is still stopping. Try again when it has stopped.'],
];

describe('project delete', () => {
  for (const [[kind, phase], message] of HOLDERS) {
    it(`refused while a ${kind} job ${phase} in it: "${message}"`, () => {
      claimComputeSlot(kind, { project_id: 'proj-a', name: 'Job' }, { phase });
      const out = deleteProject('proj-a');
      assert.deepEqual([out.status, out.body.error], [409, message]);
      assert.ok(existsSync(join(PROJECTS, 'proj-a', 'project.json')));
      assert.equal(deleteProject('proj-b').status, 200, 'another project deletes');
    });
  }

  it('the same project in another spelling, or through a junction, is refused too', () => {
    claimComputeSlot('mesh', { project_id: 'proj-a', mesh_id: 'm1' }, { phase: 'running' });
    if (process.platform === 'win32') {
      const upper = deleteProject('PROJ-A');
      assert.equal(upper.status, 409);
      assert.ok(existsSync(join(PROJECTS, 'proj-a')));
      resetComputeSlotForTests();
      symlinkSync(join(PROJECTS, 'proj-a'), join(PROJECTS, 'proj-link'), 'junction');
      claimComputeSlot('mesh', { project_id: 'proj-link', mesh_id: 'm1' }, { phase: 'running' });
      assert.equal(deleteProject('proj-a').status, 409, 'the holder names the junction, the delete the folder');
    } else {
      assert.equal(deleteProject('proj-a').status, 409);
    }
  });

  it('the boot check names its projects: that project is refused with the check text, another is not', () => {
    claimComputeSlot('check', { name: 'Checking for jobs left running', project_ids: ['proj-a'] }, { phase: 'checking' });
    const out = deleteProject('proj-a');
    assert.equal(out.status, 409);
    assert.equal(out.body.error, 'The app is checking this project for jobs left running. Try again in a few seconds.');
    assert.equal(deleteProject('proj-b').status, 200);
  });

  it('the boot check following jobs in two projects: the other project is refused with the left-running text', () => {
    project('proj-c', 'Queue project C', 'H15 boot');
    const c = claimComputeSlot('check', { project_ids: ['proj-a', 'proj-c'] }, { phase: 'checking' });
    // The check now follows the core run in A; C's plugin case is followed after it.
    slot.patchComputeSlot(c.token, { kind: 'solve', phase: 'draining', project_id: 'proj-a', run_id: 'r1', project_ids: ['proj-a', 'proj-c'] });
    assert.equal(deleteProject('proj-a').body.error, 'A job in this project is still stopping. Try again when it has stopped.');
    const other = deleteProject('proj-c');
    assert.deepEqual([other.status, other.body.error], [409, 'A job left running in this project has not ended yet. Try again when it has ended.']);
    assert.equal(deleteFolder('H15 boot').body.error, 'A job left running in Queue project C has not ended yet. Try again when it has ended.');
    assert.ok(existsSync(join(PROJECTS, 'proj-c')));
    assert.equal(deleteProject('proj-b').status, 200);
  });

  it('a delete in another letter case drops that project’s queued rows (Windows)', { skip: process.platform !== 'win32' }, () => {
    queue.enqueueComputeJob({ kind: 'mesh', mesh_id: 'm1', project_id: 'proj-a', name: 'Mesh 1' });
    queue.enqueueComputeJob({ kind: 'mesh', mesh_id: 'm1', project_id: 'proj-b', name: 'Mesh 1' });
    assert.deepEqual(queue.computeRowsForProject('PROJ-A').length, 1);
    assert.equal(deleteProject('PROJ-A').status, 200);
    assert.ok(!existsSync(join(PROJECTS, 'proj-a')));
    assert.deepEqual(queue.snapshotComputeQueue().items.map((r) => r.project_id), ['proj-b']);
  });

  it('a delete drops that project’s queued jobs of every kind, after its folder is gone; a refused delete keeps them', () => {
    const leaves = [];
    queue.configureComputeQueue({ onLeave: (row, reason, error) => leaves.push([row.kind, reason, error]) });
    queue.enqueueComputeJob({ kind: 'mesh', mesh_id: 'm1', project_id: 'proj-a', name: 'Mesh 1' });
    queue.enqueueFoamJob({ kind: 'foam', project_id: 'proj-a', name: 'S · c1 · Foam demo', job_id: 'fc-aaaaaaaa-111111', foam: { plugin: 'foam-demo', study_id: 's1' } });
    queue.enqueueComputeJob({ kind: 'mesh', mesh_id: 'm1', project_id: 'proj-b', name: 'Mesh 1' });
    const c = claimComputeSlot('solve', { project_id: 'proj-a', run_id: 'r1' }, { phase: 'running' });
    assert.equal(deleteProject('proj-a').status, 409);
    assert.equal(queue.snapshotComputeQueue().items.length, 3, 'refused: its rows stay');
    slot.releaseComputeSlot(c.token);
    assert.equal(deleteProject('proj-a').status, 200);
    assert.ok(!existsSync(join(PROJECTS, 'proj-a')));
    assert.deepEqual(queue.snapshotComputeQueue().items.map((r) => r.project_id), ['proj-b']);
    assert.deepEqual(leaves, [
      ['mesh', 'dropped', 'The project was deleted'],
      ['foam', 'dropped', 'The project was deleted'],
    ]);
    assert.deepEqual(queue.snapshotComputeQueue().failed.map((f) => [f.reason, f.error]), [
      ['dropped', 'The project was deleted'],
      ['dropped', 'The project was deleted'],
    ]);
    // In the source: the rows are read before rmSync and dropped after it, all synchronous.
    const src = readFileSync(join(HERE, '..', 'w16-project-geometry.js'), 'utf8');
    const fn = src.slice(src.indexOf('export function deleteProject('), src.indexOf('function createProject('));
    const iHeld = fn.indexOf('holderNamesProject(held, id)');
    const iRows = fn.indexOf('computeRowsForProject(id)');
    const iRm = fn.indexOf('rmSync(abs');
    const iDrop = fn.indexOf('dropComputeRows(rowIds');
    assert.ok(iHeld > 0 && iHeld < iRows && iRows < iRm && iRm < iDrop, `${iHeld} ${iRows} ${iRm} ${iDrop}`);
    assert.ok(!/\bawait\b/.test(fn));
  });
});

describe('folder delete', () => {
  it('a job in any of its projects refuses it and deletes nothing', () => {
    project('proj-a', 'Queue project A', 'H15 busy');
    project('proj-b', 'Queue project B', 'H15 busy');
    claimComputeSlot('mesh', { project_id: 'proj-a', mesh_id: 'm1' }, { phase: 'running' });
    const out = deleteFolder('H15 busy');
    assert.equal(out.status, 409);
    assert.equal(out.body.error, 'A job in Queue project A is running. Stop it before deleting the folder.');
    assert.ok(existsSync(join(PROJECTS, 'proj-a')) && existsSync(join(PROJECTS, 'proj-b')));
    resetComputeSlotForTests();
    claimComputeSlot('solve', { project_id: 'proj-b', run_id: 'r1' }, { phase: 'draining' });
    assert.equal(deleteFolder('H15 busy').body.error, 'A job in Queue project B is still stopping. Try again when it has stopped.');
    resetComputeSlotForTests();
    claimComputeSlot('check', { project_ids: ['proj-b'] }, { phase: 'checking' });
    assert.equal(deleteFolder('H15 busy').body.error, 'The app is checking Queue project B for jobs left running. Try again in a few seconds.');
    assert.ok(existsSync(join(PROJECTS, 'proj-a')) && existsSync(join(PROJECTS, 'proj-b')));
    resetComputeSlotForTests();
    assert.equal(deleteFolder('H15 busy').status, 200);
    assert.ok(!existsSync(join(PROJECTS, 'proj-a')) && !existsSync(join(PROJECTS, 'proj-b')));
  });
});
