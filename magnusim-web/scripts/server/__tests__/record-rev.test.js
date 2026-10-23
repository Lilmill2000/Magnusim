// A record's rev (Assistant phase 5, C2): every record the Assistant can write carries an
// integer `rev`; a write that changes it moves it on by one, a write that changes nothing keeps
// it; a save that sends `base_rev` other than the stored rev is refused (409 stale_record), and
// a save without one is written as before (older pages and plugin callers).
// - Node's choke point persistChildItem (BCs, materials, result controls, refinements);
// - the BC, refinement, mesh and run routes through their real handlers (the 409 answer, and
//   nothing written);
// - the BC defaults' defaults_rev;
// - only the settings saves move a mesh's or a run's rev: a generate's result or a status write
//   keeps it, whatever rev the record it was given was read at;
// - the router answers a StaleRecord thrown by any writer 409, and routes.ts maps the worker's
//   -32012 to the same answer.
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-record-rev-'));
process.env.MAGNUSIM_PROJECTS_ROOT = join(ROOT, 'projects');
process.env.MAGNUSIM_LOCAL_JSON = join(ROOT, 'local.json');
mkdirSync(process.env.MAGNUSIM_PROJECTS_ROOT, { recursive: true });
const PROJECTS = process.env.MAGNUSIM_PROJECTS_ROOT;

const { createGeometryFolder, createStudyFolder, persistChildItem, studyBcsDir, writeJsonAtomic } = await import('../../project-layout.js');
const { StaleRecord, STALE_RECORD_TEXT, firstStale, stampRev, staleBody } = await import('../../record-rev.js');
const { handleW19Api } = await import('../../w19-boundary-conditions.js');
const { handleW26Api } = await import('../../w26-mesh-refinements.js');
const { handleW20Api } = await import('../../w20-mesh.js');
const { persistOneMesh, persistRun, persistBcDefaults } = await import('../../study-io.js');
const { createDraftRun, updateRunSettings, getRunStatus } = await import('../../w27-solve.js');
const { attachWorkerBridge } = await import('../../py-json.js');
// The run's sidecar write (runs.upsert) answers at once: no Python process for it here.
attachWorkerBridge((method) => (method === 'runs.upsert' ? Promise.resolve({ ok: true }) : null));
const { Router, dispatch } = await import('../router.ts');
const { rpcStatus } = await import('../routes.ts');
const { RpcError } = await import('../worker.ts');

after(() => {
  attachWorkerBridge(null);
  rmSync(ROOT, { recursive: true, force: true });
});

const SIM = 'sim_1';
let n = 0;

/** A project with one geometry and one study; its id and the study's folder. */
function seedProject() {
  n += 1;
  const id = `rev-${n}`;
  const dir = join(PROJECTS, id);
  mkdirSync(dir, { recursive: true });
  writeJsonAtomic(join(dir, 'project.json'), { id, title: 'Revs', units: 'Metric', active_geometry_id: 'geom-1', geometries: [{ id: 'geom-1', name: 'Box' }] });
  writeJsonAtomic(join(dir, 'simulations.json'), { active_id: SIM, simulations: [{ id: SIM, name: 'Study 1', geometry_id: 'geom-1' }] });
  createGeometryFolder(dir, { id: 'geom-1', name: 'Box', original_filename: 'box.step' });
  const study = createStudyFolder(dir, 'geom-1', { id: SIM, name: 'Study 1' });
  return { id, dir, study };
}

/** One of the legacy w* handlers, as the router calls it: {status, json}. */
async function call(handler, path, body) {
  const out = {};
  const parts = path.split('/').filter(Boolean);
  await handler({ method: 'POST' }, { setHeader() {} }, new URL(`http://x${path}`), parts, {
    readJsonBody: async () => body,
    sendJson: (_res, status, json) => Object.assign(out, { status, json }),
  });
  return out;
}

function bcOnDisk(study, id) {
  const dir = studyBcsDir(study.dir);
  for (const name of readdirSync(dir)) {
    if (!name.startsWith('BC_')) continue;
    const rec = JSON.parse(readFileSync(join(dir, name, 'bc.json'), 'utf8'));
    if (rec.id === id) return rec;
  }
  return null;
}

describe('the rev helpers', () => {
  it('stampRev counts a change, keeps an unchanged record, drops base_rev, and keeps the stored rev for a report', () => {
    assert.deepEqual(stampRev({ a: 1 }, null), { a: 1, rev: 1 });
    assert.deepEqual(stampRev({ a: 1, base_rev: 3, updated_at: 'later' }, { a: 1, rev: 3, updated_at: 'then' }), { a: 1, rev: 3, updated_at: 'later' });
    assert.equal(stampRev({ a: 2 }, { a: 1, rev: 3 }).rev, 4);
    assert.equal(stampRev({ a: 2, rev: 9 }, { a: 1, rev: 3 }, { bump: false }).rev, 3);
    assert.equal('rev' in stampRev({ a: 2, rev: 9 }, null, { bump: false }), false);
    // A key that is not a setting (a run's live filter set) changes nothing.
    assert.equal(stampRev({ a: 1, current_view: 'x' }, { a: 1, current_view: 'y', rev: 2 }, { ignore: ['current_view'] }).rev, 2);
  });

  it('firstStale checks each sent record that says the rev it read; a record that is gone has rev 0', () => {
    const stored = [{ id: 'a', rev: 2 }, { id: 'b' }];
    assert.equal(firstStale('bc', stored, [{ id: 'a', base_rev: 2 }, { id: 'b', base_rev: 0 }, { id: 'c' }, { name: 'n', base_rev: 5 }]), null);
    const s = firstStale('bc', stored, [{ id: 'a', base_rev: 1 }]);
    assert.ok(s instanceof StaleRecord);
    assert.deepEqual(staleBody(s), { ok: false, code: 'stale_record', kind: 'bc', id: 'a', rev: 2, error: STALE_RECORD_TEXT });
    assert.equal(firstStale('bc', stored, [{ id: 'gone', base_rev: 3 }]).rev, 0);
  });
});

describe('persistChildItem', () => {
  it('moves the rev on a change, keeps it on the same values, refuses a stale base_rev before writing, and never stores base_rev', () => {
    const { study } = seedProject();
    const parent = studyBcsDir(study.dir);
    const bc = { id: 'bc-1', name: 'Inlet', bc_type: 'Velocity inlet', velocity: 1, simulation_id: SIM };
    assert.equal(persistChildItem(parent, 'bc', bc).rev, 1);
    assert.equal(persistChildItem(parent, 'bc', { ...bc, velocity: 2, base_rev: 1 }).rev, 2);
    assert.equal(persistChildItem(parent, 'bc', { ...bc, velocity: 2, updated_at: 'now' }).rev, 2);
    assert.throws(
      () => persistChildItem(parent, 'bc', { ...bc, velocity: 12, base_rev: 1 }),
      (e) => e instanceof StaleRecord && e.kind === 'bc' && e.id === 'bc-1' && e.rev === 2 && e.status === 409,
    );
    const stored = bcOnDisk(study, 'bc-1');
    assert.equal(stored.velocity, 2);
    assert.equal(stored.rev, 2);
    assert.equal('base_rev' in stored, false);
    // Without base_rev: written as before.
    assert.equal(persistChildItem(parent, 'bc', { ...bc, velocity: 5 }).rev, 3);
  });
});

describe('the BC route', () => {
  it('answers each saved record with its rev, refuses a stale save 409 with nothing written, and never stores base_rev as a field', async () => {
    const p = seedProject();
    const made = await call(handleW19Api, '/api/bcs', { project_id: p.id, simulation_id: SIM, name: 'Inlet', bc_type: 'Velocity inlet', faces: ['face 1@Body1'] });
    assert.equal(made.status, 200, JSON.stringify(made.json));
    const id = made.json.bc.id;
    assert.equal(made.json.bc.rev, 1);
    assert.equal(made.json.boundary_conditions.find((b) => b.id === id).rev, 1);
    const ok = await call(handleW19Api, '/api/bcs', { project_id: p.id, simulation_id: SIM, id, name: 'Inlet', bc_type: 'Velocity inlet', value: '10', base_rev: 1 });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal(ok.json.bc.rev, 2);
    const stale = await call(handleW19Api, '/api/bcs', { project_id: p.id, simulation_id: SIM, id, name: 'Inlet', bc_type: 'Velocity inlet', value: '12', base_rev: 1 });
    assert.equal(stale.status, 409);
    assert.deepEqual(stale.json, { ok: false, code: 'stale_record', kind: 'bc', id, rev: 2, error: STALE_RECORD_TEXT });
    const stored = bcOnDisk(p.study, id);
    assert.equal(String(stored.value), '10');
    assert.equal('base_rev' in stored, false);
    // A batch is refused whole when one of its records is stale.
    const other = await call(handleW19Api, '/api/bcs', { project_id: p.id, simulation_id: SIM, name: 'Outlet', bc_type: 'Pressure outlet', faces: ['face 2@Body1'] });
    const batch = await call(handleW19Api, '/api/bcs', {
      project_id: p.id,
      simulation_id: SIM,
      bcs: [
        { id: other.json.bc.id, name: 'Outlet', bc_type: 'Pressure outlet', value: '3', base_rev: 1 },
        { id, name: 'Inlet', bc_type: 'Velocity inlet', value: '99', base_rev: 1 },
      ],
    });
    assert.equal(batch.status, 409);
    assert.equal(bcOnDisk(p.study, other.json.bc.id).rev, 1);
  });

  it('moves defaults_rev only when the defaults change, and refuses a stale defaults_base_rev', async () => {
    const p = seedProject();
    const first = await call(handleW19Api, '/api/bcs', { project_id: p.id, simulation_id: SIM, defaults: { wall_type: 'Slip' } });
    assert.equal(first.status, 200, JSON.stringify(first.json));
    assert.equal(first.json.defaults_rev, 1);
    const same = await call(handleW19Api, '/api/bcs', { project_id: p.id, simulation_id: SIM, defaults: { wall_type: 'Slip' }, defaults_base_rev: 1 });
    assert.equal(same.json.defaults_rev, 1);
    const stale = await call(handleW19Api, '/api/bcs', { project_id: p.id, simulation_id: SIM, defaults: { wall_type: 'No-slip' }, defaults_base_rev: 0 });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.kind, 'bc_defaults');
    persistBcDefaults(p.id, SIM, { wall_type: 'No-slip' }, { [SIM]: { wall_type: 'No-slip' } });
    const file = JSON.parse(readFileSync(join(studyBcsDir(p.study.dir), 'defaults.json'), 'utf8'));
    assert.equal(file.defaults_rev, 2);
  });
});

describe('the refinement route', () => {
  it('stamps the rev and refuses a stale save', async () => {
    const p = seedProject();
    const mesh = await call(handleW20Api, '/api/mesh', { project_id: p.id, simulation_id: SIM, create: true, name: 'Mesh 1' });
    assert.ok(mesh.status < 300, JSON.stringify(mesh.json));
    const meshId = mesh.json.active_id;
    const made = await call(handleW26Api, '/api/mesh/refinements', { project_id: p.id, simulation_id: SIM, name: 'Wall', type: 'Surface custom sizing', mesh_id: meshId, faces: ['face 1@Body1'] });
    assert.equal(made.status, 200, JSON.stringify(made.json));
    const id = made.json.refinement.id;
    assert.equal(made.json.refinement.rev, 1);
    const ok = await call(handleW26Api, '/api/mesh/refinements', { project_id: p.id, simulation_id: SIM, id, fineness: 9, base_rev: 1 });
    assert.equal(ok.json.refinement.rev, 2);
    const stale = await call(handleW26Api, '/api/mesh/refinements', { project_id: p.id, simulation_id: SIM, id, fineness: 3, base_rev: 1 });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.kind, 'refinement');
    assert.equal(stale.json.rev, 2);
  });
});

describe('the mesh settings save', () => {
  it('moves the rev on a settings change, refuses a stale base_rev, and a generate result keeps the rev', async () => {
    const p = seedProject();
    const mesh = await call(handleW20Api, '/api/mesh', { project_id: p.id, simulation_id: SIM, create: true, name: 'Mesh 1' });
    const meshId = mesh.json.active_id;
    assert.equal(mesh.json.rev, 1);
    assert.equal(mesh.json.meshes.find((m) => m.id === meshId).rev, 1);
    const ok = await call(handleW20Api, '/api/mesh', { project_id: p.id, simulation_id: SIM, mesh_id: meshId, fineness: 3, base_rev: 1 });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal(ok.json.rev, 2);
    const stale = await call(handleW20Api, '/api/mesh', { project_id: p.id, simulation_id: SIM, mesh_id: meshId, fineness: 8, base_rev: 1 });
    assert.equal(stale.status, 409);
    assert.deepEqual([stale.json.code, stale.json.kind, stale.json.id, stale.json.rev], ['stale_record', 'mesh', meshId, 2]);
    // A generate's result (a writer that reports) keeps the rev, whatever rev its record had.
    persistOneMesh(p.id, SIM, { ...ok.json.mesh, id: meshId, rev: 1, live_mesh_result: { status: 'done', n_cells: 5 } }, { generator: true });
    const again = await call(handleW20Api, '/api/mesh', { project_id: p.id, simulation_id: SIM, mesh_id: meshId, fineness: 4, base_rev: 2 });
    assert.equal(again.status, 200, JSON.stringify(again.json));
    assert.equal(again.json.rev, 3);
  });
});

describe('the run settings save', () => {
  it('moves the rev on a settings save, refuses a stale base_rev, and a status write keeps the rev', async () => {
    const p = seedProject();
    const made = await createDraftRun({ projectId: p.id, simulationId: SIM, runId: 'run-1' });
    assert.equal(made.ok, true);
    const one = await updateRunSettings(p.id, { run_id: 'run-1', simulation_id: SIM, name: 'First' });
    assert.equal(one.ok, true, JSON.stringify(one));
    const rev = one.run.rev;
    assert.ok(Number.isInteger(rev) && rev >= 1);
    const two = await updateRunSettings(p.id, { run_id: 'run-1', simulation_id: SIM, name: 'Second', base_rev: rev });
    assert.equal(two.ok, true, JSON.stringify(two));
    assert.equal(two.run.rev, rev + 1);
    const stale = await updateRunSettings(p.id, { run_id: 'run-1', simulation_id: SIM, name: 'Third', base_rev: rev });
    assert.equal(stale.ok, false);
    assert.equal(stale.status, 409);
    assert.deepEqual([stale.code, stale.kind, stale.id, stale.rev], ['stale_record', 'run', 'run-1', rev + 1]);
    // The live filter set is not a setting: it moves no rev.
    const view = await updateRunSettings(p.id, { run_id: 'run-1', simulation_id: SIM, current_view: { field: 'p' } });
    assert.equal(view.run.rev, rev + 1);
    // A status write with an old copy of the run keeps the stored rev.
    persistRun(p.id, SIM, { ...two.run, rev: 1, status: 'draft', stage: '' });
    const read = getRunStatus(p.id, 'run-1', SIM).body.runs.find((r) => r.id === 'run-1');
    assert.equal(read.rev, rev + 1);
    assert.equal(read.name, 'Second');
  });
});

describe('the routes answer a refusal 409', () => {
  it('the router answers a StaleRecord any writer throws', async () => {
    const router = new Router();
    router.post('/api/test-stale', () => {
      throw new StaleRecord('mesh', 'm-1', 4);
    });
    const res = {
      statusCode: 0,
      body: '',
      setHeader() {},
      end(b) {
        this.body = String(b || '');
      },
    };
    const handled = await dispatch(router, { method: 'POST', url: '/api/test-stale', headers: {} }, res);
    assert.equal(handled, true);
    assert.equal(res.statusCode, 409);
    assert.deepEqual(JSON.parse(res.body), { ok: false, code: 'stale_record', kind: 'mesh', id: 'm-1', rev: 4, error: STALE_RECORD_TEXT });
  });

  it("routes.ts maps the worker's -32012 to the same 409", () => {
    const out = rpcStatus(new RpcError(-32012, 'stale_record', { code: 'stale_record', kind: 'bc', id: 'bc-7', rev: 5 }));
    assert.equal(out.status, 409);
    assert.deepEqual(out.body, { ok: false, code: 'stale_record', kind: 'bc', id: 'bc-7', rev: 5, error: STALE_RECORD_TEXT });
    // -32010 and -32011 keep their answers.
    assert.equal(rpcStatus(new RpcError(-32010, 'changed', { code: 'geometry_changed' })).status, 409);
    assert.equal(rpcStatus(new RpcError(-32011, 'updating', { code: 'geometry_updating' })).status, 503);
  });
});
