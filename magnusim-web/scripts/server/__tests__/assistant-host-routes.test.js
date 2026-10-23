// The read and edit tools' entries of the host route table (core host tools spec 3, 4): each
// passes the denylist (host-call.ts checks it when it freezes the table), and each builder
// names every key it sends, so a model's input never reaches a body, every write names its
// project, a BC or refinement is never deleted by `true`, a mesh body is never empty, and the
// worker is only asked what its entry says. Through the transport: a file streams as the raw
// import with its project in the query, and a typed path goes only when the person typed it.
// The transport itself (headers, rates, retries, scrubbing) is assistant-host-call.test.js's.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createReadStream, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-host-routes-'));
process.env.MAGNUSIM_PROJECTS_ROOT = join(ROOT, 'projects');
process.env.MAGNUSIM_LOCAL_JSON = join(ROOT, 'local.json');
process.env.MAGNUSIM_ASSISTANT_HOME = join(ROOT, 'home');

const { HOST_ROUTES, deniedRoute, createHostTransport } = await import('../assistant/host-call.ts');
const { HOST_ROUTE_TABLE } = await import('../assistant/host-routes.ts');
const { startFakeApp } = await import('./assistant-host-harness.js');

let app;
before(async () => {
  app = await startFakeApp();
});
after(async () => {
  await app.stop();
  rmSync(ROOT, { recursive: true, force: true });
});

/** Plausible args: every arg a builder may read. */
const ARGS = {
  project_id: 'p1',
  simulation_id: 's1',
  id: 'x-1',
  key: 'cad',
  field: 'p',
  mesh_id: 'm1',
  run_id: 'r1',
  fields: {},
  settings: {},
  changes: {},
  materials: [{ id: 'mat-1' }],
  only_id: 'mat-1',
};

describe('the tools\' entries of HOST_ROUTES', () => {
  it('every entry passes the denylist and is in the frozen table', () => {
    for (const [id, r] of Object.entries(HOST_ROUTE_TABLE)) {
      assert.equal(deniedRoute(r), null, id);
      assert.ok(Object.hasOwn(HOST_ROUTES, id), id);
    }
    assert.ok(Object.keys(HOST_ROUTES).length > 60);
  });

  it('a body names its keys: a model input never reaches it; a write names its project', () => {
    for (const [id, r] of Object.entries(HOST_ROUTES)) {
      if (!r.body) continue;
      const body = r.body({ ...ARGS, injected: 'yes', mode: 'replace' });
      const flat = JSON.stringify(body);
      assert.ok(!flat.includes('"injected"') && !flat.includes('"mode"'), `${id}: an unknown arg reached the body`);
      // App-wide: folders, a new project, the BC menu, the queue's order (jobs checks the ids are this project's rows first), this PC's check and a plugin's tools.
      const appWide = ['folders.create', 'folders.delete', 'project.create', 'project.sample', 'bc.menu', 'queue.reorder', 'prefs.hardware_check', 'plugins.env.install'];
      const query = typeof r.query === 'function' ? r.query({ ...ARGS }) : r.query || {};
      if (!appWide.includes(id)) assert.ok(flat.includes('"project_id"') || !!query.project_id, `${id}: project_id`);
      if (r.path === '/api/bcs' || r.path === '/api/mesh/refinements') assert.notEqual(body.delete, true, `${id}: {delete:true} deletes every record`);
      if (r.path === '/api/mesh') assert.ok(Object.keys(body).length > 2, `${id}: never an empty mesh body`);
      if (r.path === '/api/worker') assert.equal(body.method, r.worker, `${id}: the worker method of its entry`);
    }
  });

  it('a file streams as the raw import with its project in the query; a path goes only when typed in this message', async () => {
    const call = createHostTransport({ port: () => app.port }).call;
    const file = join(ROOT, 'part.step');
    writeFileSync(file, 'ISO-10303-21;\n'.repeat(200));
    let from = app.seen.length;
    await call('geometry.import_raw', { project_id: 'p1', filename: 'part.step', length_unit: 'MM', raw: { stream: createReadStream(file), bytes: statSync(file).size, type: 'application/octet-stream' } }, { turn: 't' });
    const r = app.seen[from];
    assert.deepEqual([r.method, r.path, r.query], ['POST', '/api/geometry/import', { project_id: 'p1', filename: 'part.step', length_unit: 'MM' }]);
    assert.equal(r.headers['content-type'], 'application/octet-stream');
    assert.equal(r.bytes.length, statSync(file).size);
    from = app.seen.length;
    await assert.rejects(call('geometry.import_path', { project_id: 'p1', step_path: file }, { turn: 't', prompt: 'Import my part' }), (e) => e.code === 'not_allowed');
    assert.equal(app.seen.length, from, 'nothing sent');
    await call('geometry.import_path', { project_id: 'p1', step_path: file }, { turn: 't2', prompt: `Import ${file}` });
    assert.deepEqual(app.seen.at(-1).body, { project_id: 'p1', step_path: file });
  });
});
