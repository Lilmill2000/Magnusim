/**
 * GET hydrate / catalog / materials must never start project_cli.
 * IF Item 7: reading core solves on the step-list runner (the run status, Home's
 * summary) starts no process either: a run's record says whether it runs, and a doc
 * whose record has ended is written as ended, with no probe.
 */
import { describe, it, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-get-no-spawn-'));
const PROJECTS = join(ROOT, 'projects');
mkdirSync(PROJECTS, { recursive: true });
process.env.MAGNUSIM_PROJECTS_ROOT = PROJECTS;
process.env.MAGNUSIM_LOCAL_JSON = join(ROOT, 'local.json');
process.env.MAGNUSIM_QUEUE_QUIET = '1';

const { handleProjectHydrate } = await import('../../project-hydrate.js');
const { getMaterials } = await import('../../w18-materials.js');
const { getRunStatus, projectSolveSummary } = await import('../../w27-solve.js');
const { getSimulation } = await import('../../w17-simulation.js');
const store = await import('../../foam-store.js');
const layout = await import('../../project-layout.js');
const io = await import('../../study-io.js');

after(() => {
  mock.restoreAll();
  syncBuiltinESMExports();
  try {
    rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* Windows may hold a file */
  }
});

describe('GET-no-spawn', () => {
  before(() => {
    process.env.CFDDESK_FORBID_PROJECT_CLI = '1';
  });

  it('hydrate + catalog + materials GET do not spawn project_cli', () => {
    const sent = [];
    const res = {
      headers: {},
      setHeader(k, v) {
        this.headers[k] = v;
      },
    };
    const sendJson = (_r, status, body) => {
      sent.push({ status, body });
    };
    handleProjectHydrate(
      { method: 'GET' },
      res,
      new URL('http://127.0.0.1/api/project/hydrate?project_id=no-such-project'),
      { sendJson },
    );
    assert.equal(sent.length, 1);
    assert.equal(sent[0].status, 503);

    assert.doesNotThrow(() => getMaterials('no-such-project'));
    assert.doesNotThrow(() => getSimulation('no-such-project'));
    assert.doesNotThrow(() => getRunStatus('no-such-project'));
  });

  it('getRunStatus of core solves on the runner (one running, one whose record ended) starts no process', () => {
    store.resetFoamStoreForTests({ filePath: join(ROOT, 'foam-cases.json') });
    const dir = join(PROJECTS, 'p1');
    mkdirSync(dir, { recursive: true });
    const g = layout.createGeometryFolder(dir, { id: 'g1', name: 'Part' });
    writeFileSync(join(dir, 'project.json'), JSON.stringify({ id: 'p1', title: 'P1', geometries: [{ id: g.id, name: g.name }], active_geometry_id: g.id }));
    layout.createStudyFolder(dir, g.id, { id: 's1', name: 'Study 1' });
    writeFileSync(join(dir, 'simulations.json'), JSON.stringify({ active_id: 's1', simulations: [{ id: 's1', name: 'Study 1', geometry_id: g.id }] }));
    const record = (runId, status) => {
      const rec = store.createFoamRecord({ kind: 'solve', project_id: 'p1', run_id: runId, simulation_id: 's1', case_dir: join(ROOT, 'none'), app: 'simpleFoam', wsl_case: `cfddesk-w27-${runId}` });
      if (status !== 'queued') store.updateFoamRecord(rec.id, { status, ...(status === 'done' ? { finished_at: new Date().toISOString() } : {}) });
      return rec;
    };
    const live = record('r_live', 'running');
    const ended = record('r_ended', 'done');
    for (const [rid, rec] of [['r_live', live], ['r_ended', ended]]) {
      io.persistRun('p1', 's1', { id: rid, run_id: rid, name: rid, simulation_id: 's1', status: 'running', runner_job_id: rec.id, wsl_case: `cfddesk-w27-${rid}`, pid: null, path_kind: 'simpleFoam' });
    }
    const calls = [];
    mock.method(cp, 'spawn', (cmd, args) => {
      calls.push(['spawn', cmd, ...(args || [])].join(' '));
      throw new Error('spawn during a GET');
    });
    mock.method(cp, 'spawnSync', (cmd, args) => {
      calls.push(['spawnSync', cmd, ...(args || [])].join(' '));
      throw new Error('spawnSync during a GET');
    });
    syncBuiltinESMExports();
    try {
      const body = getRunStatus('p1', 'r_live', 's1').body;
      assert.equal(body.run.status, 'running');
      assert.equal(body.live_run_id, 'r_live');
      const runs = Object.fromEntries(body.runs.map((r) => [r.id, r.status]));
      assert.deepEqual(runs, { r_live: 'running', r_ended: 'done' }, 'the ended record is read as ended');
      assert.equal(projectSolveSummary('p1').simulating, true);
    } finally {
      mock.restoreAll();
      syncBuiltinESMExports();
    }
    assert.deepEqual(calls, [], 'no process was started');
  });
});
