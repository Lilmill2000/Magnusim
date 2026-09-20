import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGeometryFolder, createStudyFolder, writeJsonAtomic } from '../../project-layout.js';

const root = mkdtempSync(join(tmpdir(), 'magnusim-run-selection-'));
process.env.MAGNUSIM_PROJECTS_ROOT = root;
const { createDraftRun, getRunStatus, updateRunSettings } = await import('../../w27-solve.js');
after(() => rmSync(root, {recursive: true, force: true}));

describe('study run selection', () => {
  it('persists the newest selected run and honors an explicitly requested study', async () => {
    const project = join(root, 'test-project');
    mkdirSync(project);
    writeJsonAtomic(join(project, 'project.json'), {id: 'test-project', title: 'Test'});
    createGeometryFolder(project, {id: 'geo', name: 'elbow.step'});
    const studies = ['study-a', 'study-b'].map((id) => ({id, name: id, geometry_id: 'geo', time_dependency: 'Steady-state'}));
    const folders = studies.map((study) => createStudyFolder(project, 'geo', study));
    writeJsonAtomic(join(project, 'simulations.json'), {active_id: 'study-a', simulations: studies});
    for (const runId of ['first', 'second']) {
      const result = await createDraftRun({projectId: 'test-project', simulationId: 'study-a', runId});
      assert.equal(result.ok, true);
      assert.equal(getRunStatus('test-project', undefined, 'study-a').body.active_run_id, runId);
      if (runId === 'first') writeJsonAtomic(join(folders[0].dir, 'simulation_runs', 'catalog.json'), { active_id: 'first' });
    }
    await createDraftRun({projectId: 'test-project', simulationId: 'study-b', runId: 'other'});
    const a = getRunStatus('test-project', undefined, 'study-a').body;
    const b = getRunStatus('test-project', undefined, 'study-b').body;
    assert.equal(a.active_run_id, 'second');
    assert.equal(b.active_run_id, 'other');
    assert.deepEqual(a.runs.map((run) => run.id).sort(), ['first', 'second']);
    assert.deepEqual(b.runs.map((run) => run.id), ['other']);
  });

  it('updates a run on its own study even if the open study id is wrong', async () => {
    const project = join(root, 'cross-study-update');
    mkdirSync(project);
    writeJsonAtomic(join(project, 'project.json'), {id: 'cross-study-update', title: 'Test'});
    createGeometryFolder(project, {id: 'geo', name: 'elbow.step'});
    const studies = ['test-sim', 'teardrop-sim'].map((id) => ({
      id,
      name: id,
      geometry_id: 'geo',
      time_dependency: 'Transient',
    }));
    studies.forEach((study) => createStudyFolder(project, 'geo', study));
    writeJsonAtomic(join(project, 'simulations.json'), {active_id: 'test-sim', simulations: studies});
    await createDraftRun({projectId: 'cross-study-update', simulationId: 'test-sim', runId: 'test-run'});
    await createDraftRun({projectId: 'cross-study-update', simulationId: 'teardrop-sim', runId: 'tear-run'});
    const updated = await updateRunSettings('cross-study-update', {
      run_id: 'tear-run',
      simulation_id: 'test-sim',
      transient: { max_co: 200, end_time: 1, write_count: 30 },
    });
    assert.equal(updated.ok, true);
    assert.equal(updated.run.id, 'tear-run');
    assert.equal(updated.run.transient.max_co, 200);
    const tear = getRunStatus('cross-study-update', 'tear-run', 'teardrop-sim').body;
    const row = tear.runs.find((r) => r.id === 'tear-run');
    assert.equal(row.transient.max_co, 200);
  });
});
