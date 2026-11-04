// The job tools (Assistant phase 5 spec 06, C4: §4.12-4.14, §8): compute, wait and jobs
// against a stand-in for the app's own routes that records every request, through the
// job tools' own route table and caller (exact method, path and body keys). Also the cards
// (escalate, gateText, chainKey), the per-turn record and the turn's end line of what
// still runs, the result links the dock shows (never sent to the model), and the schemas.
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-assistant-jobs-'));
process.env.MAGNUSIM_PROJECTS_ROOT = join(ROOT, 'projects');
process.env.MAGNUSIM_LOCAL_JSON = join(ROOT, 'local.json');
process.env.MAGNUSIM_ASSISTANT_HOME = join(ROOT, 'home');
for (const k of Object.keys(process.env)) if (k.startsWith('MAGNUSIM_TEST_ASSISTANT')) delete process.env[k];

const { createJobTools } = await import('../assistant/host/job-tools.ts');
const { createHostTransport, HOST_ROUTES, TOOL_HEADER, HOST_WRITE_RATE } = await import('../assistant/host-call.ts');
const { parseJobId, meshStageWords } = await import('../assistant/host/job-state.ts');
const turnJobs = await import('../assistant/host/turn-jobs.ts');
const { checkSchema, emitSchema, validateInput } = await import('../assistant/schema.ts');
const { safeLinks } = await import('../assistant/links.ts');
const { ToolRunner } = await import('../assistant/runner.ts');
const { TURN_HEADER } = await import('../assistant/access.ts');
const { HostCallError } = await import('../assistant/host-call.ts');
const { grants } = await import('../assistant/grants.ts');
const { defaultHostTools } = await import('../assistant/host-tools.ts');

after(() => rmSync(ROOT, { recursive: true, force: true }));

const P = 'p1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ the app stand-in

/** The app's state the routes answer from; each test sets what it needs. */
let S;
function freshState() {
  return {
    live: null,
    items: [],
    mesh: { id: 'm1', name: 'Mesh 1', generated: false, live_mesh_result: null, settings: { advanced: { mesh_engine: 'standard' } }, simulation_id: 's1' },
    run: { id: 'r1', run_id: 'r1', name: 'Run 1', status: 'draft', mesh_id: 'm1', endTime: 500, cores: 8, case_dir: 'C:\\Users\\x\\proj\\run1\\case', simulation_id: 's1' },
    start: [202, { ok: true, status: 'running' }],
    generate: [202, { ok: true, status: 'running', job_id: 'job-mesh-1' }],
    export: { status: 'running', fraction: 0.4, message: 'Writing' },
    times: ['0.1', '0.5'],
    meshStop: [200, { ok: true, stopped: true }],
    runStop: [200, { ok: true, stopping: true }],
    reorder: [200, { ok: true }],
    // The study's stored settings (RH3: its numerics) and the analyses' numerics schemas.
    study: {},
    registry: { analysis: [] },
  };
}

const app = { seen: [], port: 0 };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : null;
    app.seen.push({ method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), body, headers: req.headers });
    const [status, json] = answer(req.method, u.pathname, u.searchParams, body);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(json));
  });
});

function answer(method, path, q, body) {
  const pid = q.get('project_id') ?? body?.project_id;
  if (path === '/api/compute-queue' && method === 'GET') {
    const items = S.items.filter((r) => !q.get('project_id') || r.project_id === q.get('project_id')).map((r) => ({ ...r }));
    return [200, { ok: true, items, live: S.live && (!q.get('project_id') || S.live.project_id === q.get('project_id')) ? S.live : null, busy: S.live }];
  }
  if (path === '/api/compute-queue' && method === 'POST' && body.action === 'remove') {
    S.items = S.items.filter((r) => r.id !== body.id);
    return [200, { ok: true, items: S.items }];
  }
  if (path === '/api/compute-queue' && method === 'POST') {
    const item = { ...body, position: S.items.length + 1 };
    S.items.push(item);
    return [200, { ok: true, items: S.items, item }];
  }
  if (path === '/api/compute-queue' && method === 'PATCH') return S.reorder;
  if (path === '/api/compute-queue/kick') return [200, { ok: true }];
  if (path === '/api/project') return [200, { ok: true, project: { id: pid, title: 'Wing' } }];
  if (path === '/api/registry') return [200, S.registry];
  if (path === '/api/simulation') {
    return [200, { ok: true, active_id: 's1', simulation: { id: 's1', name: 'Pipe flow', geometry_id: 'g1', ...S.study }, simulations: [{ id: 's1', name: 'Pipe flow', geometry_id: 'g1' }] }];
  }
  if (path === '/api/mesh' && method === 'GET') {
    const want = q.get('mesh_id');
    if (want && want !== S.mesh.id) return [200, { ok: true, simulation_id: 's1', mesh: null, meshes: [S.mesh] }];
    return [200, { ok: true, simulation_id: 's1', mesh: S.mesh, meshes: [S.mesh] }];
  }
  if (path === '/api/mesh/generate') return S.generate;
  if (path === '/api/mesh/stop') return S.meshStop;
  if (path === '/api/run/status') {
    const want = q.get('run_id') || S.run.id;
    const run = want === S.run.id ? S.run : null;
    return [200, { ok: true, run, runs: [S.run], runs_all: [S.run], active_run_id: S.run.id }];
  }
  if (path === '/api/run/start' || path === '/api/run/continue') return S.start;
  if (path === '/api/run/reopen') return [200, { ok: true, reopened: true, run: { ...S.run, status: 'draft', has_results: false } }];
  if (path === '/api/run/update') return [200, { ok: true, run: { ...S.run, ...(body || {}) } }];
  if (path === '/api/run/stop') return S.runStop;
  if (path === '/api/times') return [200, { times: S.times, case_dir: q.get('case') }];
  if (path === '/api/results/export-vtk' && method === 'POST') return [202, { ok: true, job_id: 'job-exp-1', status: 'queued' }];
  if (path.startsWith('/api/results/export-vtk/')) return [200, { ok: true, job_id: 'job-exp-1', ...S.export }];
  if (/^\/api\/jobs\/[^/]+\/stop$/.test(path)) return [200, { ok: true }];
  if (path === '/api/prefs/hardware-check') return [200, { ok: true, hardware: { physical_cores: 8, logical_cpus: 16, ram_gb: 32, disk_free_gb: 100, openfoam_ok: true, n_procs: 7, profile: 'standard', wsl_distro: 'Ubuntu' } }];
  if (/^\/api\/plugins\/[^/]+\/env\/install$/.test(path)) return [202, { ok: true, install: { state: 'installing' } }];
  if (/^\/api\/plugins\/[^/]+\/env$/.test(path)) return [200, { ok: true, name: 'Heat Transfer', env: { state: 'missing' }, install: { state: 'installing', label: 'Downloading' } }];
  if (path === '/api/plugin-geometry/status') return [200, { ok: true, job: { id: q.get('job_id'), status: 'choosing', stage: null } }];
  return [404, { error: `no route ${method} ${path}` }];
}

before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  app.port = server.address().port;
});
after(() => server.close());
beforeEach(() => {
  S = freshState();
  app.seen = [];
});

let clock = 1_000_000;
/** The tools on the stand-in, each call's turn its own (the rate limits are per turn). */
function tools(over = {}) {
  const call = createHostTransport({ port: () => app.port }).call;
  const syncs = [];
  const list = createJobTools({ call, uiSync: (e) => syncs.push(e), newId: () => 'abc123def456', ...over });
  return { ...Object.fromEntries(list.map((t) => [t.name, t])), syncs };
}
let turnN = 0;
const ctx = (o = {}) => ({ tab: null, projectId: P, simulationId: null, cloud: true, local: false, place: 'workbench', budgetTokens: null, prompt: null, ...o });
function rt(o = {}) {
  const progress = [];
  const ac = o.controller ?? new AbortController();
  return { signal: ac.signal, ctx: ctx(o.ctx), turn: o.turn ?? `t-${++turnN}`, progress: (f, label, opts) => progress.push({ f, label, ...(opts?.waiting ? { waiting: true } : {}) }), progressLog: progress };
}
const input = (o) => ({ project_id: '', simulation_id: '', action: '', mesh_id: '', run_id: '', extra_iterations: 0, end_time: 0, frames: '', time: -1, plugin: '', chain: [], estimate_minutes: 0, numerics: '', ...o });
const writes = () => app.seen.filter((r) => r.method !== 'GET');

// ------------------------------------------------------------------ schemas

describe('the job tools: schemas and definitions', () => {
  it('every schema passes the check, every property is required, and each tool as sent strict is at most 2,048 bytes', () => {
    const t = tools();
    for (const name of ['compute', 'wait', 'jobs']) {
      const def = t[name];
      assert.equal(checkSchema(def.schema).ok, true, name);
      assert.deepEqual([...def.schema.required].sort(), Object.keys(def.schema.properties).sort(), `${name}: every property required`);
      assert.equal(def.schema.additionalProperties, false);
      const sent = JSON.stringify({ name: def.name, description: def.description, input_schema: emitSchema('anthropic', def.schema) });
      assert.ok(Buffer.byteLength(sent, 'utf8') <= 2048, `${name}: ${Buffer.byteLength(sent, 'utf8')} bytes`);
      assert.ok(def.description.length <= 400, `${name} description ${def.description.length}`);
      for (const [k, p] of Object.entries(def.schema.properties)) assert.ok(!p.description || p.description.length <= 160, `${name}.${k}`);
      assert.equal(def.source.kind, 'host');
    }
    // compute's base is edit: escalate raises all but queue_kick (C3).
    assert.deepEqual([t.compute.risk, t.wait.risk, t.jobs.risk], ['edit', 'read', 'edit']);
    assert.deepEqual([t.compute.priority, t.wait.priority, t.jobs.priority], [84, 82, 58]);
  });

  it('places (§15): compute and jobs on Home and the workbench; wait there and in a workspace (a CAD turn waits on what it started)', () => {
    const t = tools();
    assert.deepEqual([t.compute.contexts, t.wait.contexts, t.jobs.contexts], [['home', 'workbench'], ['home', 'workbench', 'workspace'], ['home', 'workbench']]);
    assert.equal(t.compute.available(ctx({ projectId: null, place: 'home' })), true);
    assert.equal(t.wait.available(ctx({ place: 'workspace' })), true);
  });

  it('the server registers them after the read and edit tools', () => {
    const names = defaultHostTools(() => app.port).map((d) => d.name);
    assert.deepEqual(names, [
      'app_status',
      'catalog',
      'projects',
      'project_summary',
      'read_setup',
      'explain_ready',
      'read_results',
      'project_edit',
      'study_edit',
      'setup_edit',
      'import_file',
      'delete',
      'chat_history',
      'compute',
      'wait',
      'jobs',
    ]);
  });

  it('job ids name what runs', () => {
    assert.deepEqual(parseJobId('mesh.m-1'), { kind: 'mesh', id: 'm-1', job_id: 'mesh.m-1' });
    assert.deepEqual(parseJobId('solve.r1'), { kind: 'solve', id: 'r1', job_id: 'solve.r1' });
    assert.deepEqual(parseJobId('export.job-abc'), { kind: 'export', id: 'job-abc', job_id: 'export.job-abc' });
    assert.deepEqual(parseJobId('hw.check'), { kind: 'hw', id: 'check', job_id: 'hw.check' });
    for (const bad of ['', 'mesh.', 'mesh.a/b', 'export.x1', 'link.x', 'run.r1', 'mesh.../x', 42, null]) assert.equal(parseJobId(bad), null, String(bad));
    assert.equal(meshStageWords('surface_mesh'), 'meshing the surface');
    assert.equal(meshStageWords('snappyHexMesh'), 'snapping the mesh to the surface');
  });
});

// ------------------------------------------------------------------ the caller

describe("the job tools' routes (host-routes.ts, through host-call.ts)", () => {
  it('sends the turn and tool headers, JSON bodies with named keys only, and fills path segments it checks', async () => {
    const call = createHostTransport({ port: () => app.port }).call;
    await call('mesh.stop', { project_id: P, simulation_id: 's1', mesh_id: 'm1', extra: 'never sent' }, { turn: 't-h', tool: 'jobs.stop' });
    const r = app.seen.at(-1);
    assert.deepEqual([r.method, r.path, r.body], ['POST', '/api/mesh/stop', { project_id: P, simulation_id: 's1', mesh_id: 'm1' }]);
    assert.equal(r.headers[TURN_HEADER], 't-h');
    assert.equal(r.headers[TOOL_HEADER], 'jobs.stop');
    assert.equal(r.headers.origin, undefined);
    await call('export.get', { id: 'job-x1', project_id: P }, { turn: 't-h2' });
    assert.deepEqual([app.seen.at(-1).path, app.seen.at(-1).query], ['/api/results/export-vtk/job-x1', { project_id: P }]);
    await assert.rejects(call('export.get', { id: '../etc', project_id: P }, { turn: 't-h3' }));
    for (const id of ['queue.add', 'queue.remove', 'queue.reorder', 'queue.kick', 'mesh.get', 'mesh.generate', 'mesh.stop', 'run.status', 'run.start', 'run.continue', 'run.stop', 'results.times', 'export.start', 'export.get', 'jobs.stop', 'prefs.hardware_check', 'plugins.env.get', 'plugins.env.install', 'link.status']) {
      assert.ok(HOST_ROUTES[id], id);
    }
    assert.equal(HOST_ROUTES['prefs.hardware_check'].timeoutMs, 150_000);
  });

  it("a 4xx keeps its text, paths out, and the app's code", async () => {
    const call = createHostTransport({ port: () => app.port }).call;
    S.meshStop = [409, { ok: false, code: 'not_running', error: 'Mesh 1 is not generating. C:\\Users\\dan\\proj' }];
    const e = await call('mesh.stop', { project_id: P, simulation_id: 's1', mesh_id: 'm1' }, { turn: 't-e1' }).catch((x) => x);
    assert.equal(e.status, 409);
    assert.equal(e.appCode, 'not_running');
    assert.doesNotMatch(e.message, /Users/);
    assert.equal(HOST_WRITE_RATE.calls, 2);
  });
});

// ------------------------------------------------------------------ compute

describe('compute', () => {
  it('mesh_generate: the study\'s active mesh, the stored settings (no settings key), queue_if_busy; answers a job id to wait on', async () => {
    const t = tools();
    const r = rt();
    const out = await t.compute.run(input({ action: 'mesh_generate' }), r);
    assert.equal(out.ok, true, JSON.stringify(out));
    const gen = writes().find((x) => x.path === '/api/mesh/generate');
    assert.deepEqual(gen.body, { project_id: P, simulation_id: 's1', mesh_id: 'm1', geometry_id: 'g1', name: 'Mesh 1', queue_if_busy: true });
    assert.deepEqual(out.data, {
      done: 'Mesh 1 is generating',
      job_id: 'mesh.m1',
      state: 'running',
      position: 0,
      hint: 'Follow it with wait {job_ids:["mesh.m1"]}',
      detail: { engine_job: 'job-mesh-1' },
    });
    assert.equal(t.syncs.length, 1);
    assert.deepEqual([t.syncs[0].kinds, t.syncs[0].ids], [['mesh'], { mesh: ['m1'] }]);
    assert.equal(turnJobs.startedJobs(r.turn)[0].job_id, 'mesh.m1');
  });

  it('mesh_generate when busy: queued, with its place in line and the queue row', async () => {
    S.generate = [202, { ok: true, queued: true, item: { id: 'q-9', kind: 'mesh', mesh_id: 'm1' }, items: [{ id: 'q-8' }, { id: 'q-9', position: 2 }] }];
    const out = await tools().compute.run(input({ action: 'mesh_generate', mesh_id: 'm1' }), rt());
    assert.deepEqual([out.data.state, out.data.position, out.data.detail.queue_row], ['queued', 2, 'q-9']);
    assert.match(out.data.done, /queued \(number 2 in line\)/);
  });

  it('run_start: start_id, then busy → the page\'s queue row (flat body), same_run → already running, a mesh not generated → not_ready', async () => {
    S.mesh.generated = true;
    let out = await tools().compute.run(input({ action: 'run_start' }), rt());
    assert.equal(out.ok, true, JSON.stringify(out));
    const start = writes().find((x) => x.path === '/api/run/start');
    assert.deepEqual(start.body, { project_id: P, simulation_id: 's1', run_id: 'r1', start_id: 'ai-abc123def456' });
    assert.equal(out.data.job_id, 'solve.r1');

    app.seen = [];
    S.start = [409, { ok: false, code: 'busy', error: 'Another job is already running' }];
    out = await tools().compute.run(input({ action: 'run_start', run_id: 'r1' }), rt());
    const queued = writes().find((x) => x.path === '/api/compute-queue');
    assert.ok(queued, JSON.stringify(out) + JSON.stringify(app.seen.map((x) => [x.method, x.path])));
    assert.deepEqual(queued.body, { id: 'q-abc123def456', kind: 'solve', mesh_id: 'm1', run_id: 'r1', simulation_id: 's1', project_id: P, name: 'Run 1', mesh_generating: false });
    assert.deepEqual([out.data.state, out.data.position], ['queued', 1]);

    S.start = [409, { ok: false, code: 'same_run', error: 'This run is already solving.' }];
    out = await tools().compute.run(input({ action: 'run_start', run_id: 'r1' }), rt());
    assert.deepEqual([out.ok, out.data.state, out.data.done], [true, 'running', 'Run 1 is already running']);

    S.mesh.generated = false;
    app.seen = [];
    out = await tools().compute.run(input({ action: 'run_start' }), rt());
    assert.equal(out.error.code, 'not_ready');
    assert.match(out.error.message, /"Mesh 1" is not generated/);
    assert.match(out.error.hint, /mesh_generate first, or chain both/);
    assert.equal(writes().length, 0, 'nothing started');
    // A mesh still generating (or queued) is fine: the run queues behind it.
    S.live = { kind: 'mesh', mesh_id: 'm1', project_id: P };
    S.start = [409, { ok: false, code: 'busy', error: 'busy' }];
    out = await tools().compute.run(input({ action: 'run_start' }), rt());
    assert.equal(out.data.state, 'queued');
    assert.equal(writes().find((x) => x.path === '/api/compute-queue').body.mesh_generating, true);
  });

  it('run_start answers what the pre-run check found as it started (RH2: "Started with 1 warning: …", the Run panel line "Checked at start")', async () => {
    S.mesh.generated = true;
    const before = S.run;
    S.run = {
      ...S.run,
      prepare_run: {
        checks: [
          { code: 'piso_high_co', level: 'warn', text: 'Max Courant 100 with 1 outer corrector.', short: 'Max Courant 100 with PISO' },
          { code: 'still_start', level: 'info', text: 'The run starts from rest.', short: 'starts from rest' },
        ],
      },
    };
    try {
      const out = await tools().compute.run(input({ action: 'run_start' }), rt());
      assert.equal(out.ok, true, JSON.stringify(out));
      assert.equal(out.data.done, 'Run 1 started. Started with 1 warning: Max Courant 100 with PISO.');
      assert.equal(out.data.detail.checked_at_start, 'Started with 1 warning: Max Courant 100 with PISO.');
      // Nothing found: the plain answer.
      S.run = { ...before, prepare_run: { checks: [] } };
      const plain = await tools().compute.run(input({ action: 'run_start' }), rt());
      assert.equal(plain.data.done, 'Run 1 started');
    } finally {
      S.run = before;
    }
  });

  it('run_start on a run with no mesh of its own: it takes the study mesh first, as the page Start does (seen live: "Generated mesh case missing" after the mesh had just finished)', async () => {
    S.mesh.generated = true;
    S.run = { ...S.run, mesh_id: '', rev: 4 };
    const out = await tools().compute.run(input({ action: 'run_start' }), rt());
    assert.equal(out.ok, true, JSON.stringify(out));
    const sent = writes().map((x) => [x.path, x.body]);
    assert.deepEqual(sent.slice(0, 2), [
      ['/api/run/update', { mesh_id: 'm1', project_id: P, simulation_id: 's1', run_id: 'r1', base_rev: 4 }],
      ['/api/run/start', { project_id: P, simulation_id: 's1', run_id: 'r1', start_id: 'ai-abc123def456' }],
    ]);
    // A run that has its mesh is started as it is: no update.
    app.seen = [];
    S.run = { ...S.run, mesh_id: 'm1' };
    await tools().compute.run(input({ action: 'run_start' }), rt());
    assert.deepEqual(writes().map((x) => x.path), ['/api/run/start']);
  });

  it('run_continue: extra_iterations or end_time; busy queues it with settings.continue', async () => {
    S.run.status = 'done';
    let out = await tools().compute.run(input({ action: 'run_continue' }), rt());
    assert.equal(out.error.code, 'bad_values');
    out = await tools().compute.run(input({ action: 'run_continue', extra_iterations: 200 }), rt());
    assert.equal(out.ok, true);
    assert.deepEqual(writes().find((x) => x.path === '/api/run/continue').body, { project_id: P, simulation_id: 's1', run_id: 'r1', extra_iterations: 200, start_id: 'ai-abc123def456' });
    S.start = [409, { ok: false, code: 'busy', error: 'busy' }];
    app.seen = [];
    out = await tools().compute.run(input({ action: 'run_continue', end_time: 2.5 }), rt());
    assert.deepEqual(writes().find((x) => x.path === '/api/compute-queue').body.settings, { continue: { end_time: 2.5 } });
  });

  it('vtk_export: the run\'s case goes to the app, never back; time -1 is the latest saved time', async () => {
    S.run.status = 'done';
    const out = await tools().compute.run(input({ action: 'vtk_export' }), rt());
    assert.equal(out.ok, true, JSON.stringify(out));
    const post = writes().find((x) => x.path === '/api/results/export-vtk');
    assert.deepEqual(post.body, { project_id: P, case: S.run.case_dir, frames: 'current', time: '0.5' });
    assert.equal(out.data.job_id, 'export.job-exp-1');
    assert.doesNotMatch(JSON.stringify(out), /Users|case_dir|\\\\/);
    const bad = await tools().compute.run(input({ action: 'vtk_export', time: 0.3 }), rt());
    assert.equal(bad.error.code, 'bad_values');
    const all = await tools().compute.run(input({ action: 'vtk_export', frames: 'all' }), rt());
    assert.equal(all.ok, true);
    assert.equal(writes().at(-1).body.frames, 'all');
    assert.equal(writes().at(-1).body.time, undefined);
  });

  it('hardware_check and plugin_env_install need no project; queue_kick asks the queue', async () => {
    const t = tools();
    const home = rt({ ctx: { projectId: null } });
    const hw = await t.compute.run(input({ action: 'hardware_check' }), home);
    assert.equal(hw.ok, true);
    assert.deepEqual(hw.data.detail, { cores: 8, logical_cpus: 16, ram_gb: 32, disk_free_gb: 100, openfoam: 'ok', solver_ranks: 7, profile: 'standard' });
    assert.equal(hw.data.job_id, 'hw.check');
    assert.ok(home.progressLog.some((p) => p.label === 'Checking this PC'), 'a long call keeps its stall window open');
    const env = await t.compute.run(input({ action: 'plugin_env_install', plugin: 'heat_transfer' }), home);
    assert.deepEqual([env.ok, env.data.job_id, env.data.state], [true, 'env.heat_transfer', 'running']);
    assert.equal(writes().at(-1).path, '/api/plugins/heat_transfer/env/install');
    const bad = await t.compute.run(input({ action: 'plugin_env_install', plugin: '../x' }), home);
    assert.equal(bad.error.code, 'bad_values');
    const noProject = await t.compute.run(input({ action: 'mesh_generate' }), home);
    assert.equal(noProject.error.code, 'no_project');
    const kick = await t.compute.run(input({ action: 'queue_kick' }), rt());
    assert.equal(kick.ok, true);
    assert.deepEqual(writes().at(-1).body, { project_id: P });
  });

  it('writes go only to the project open in the window', async () => {
    const out = await tools().compute.run(input({ action: 'mesh_generate', project_id: 'other' }), rt());
    assert.equal(out.error.code, 'not_this_project');
    assert.match(out.error.hint, /core__show \{target:'project', project_id:'other'\}/);
    assert.equal(writes().length, 0);
  });

  it('chain: only mesh and solve ids; chainKey is the job a call would start', async () => {
    const t = tools();
    const bad = await t.compute.run(input({ action: 'mesh_generate', chain: ['export.job-1', 'nope'] }), rt());
    assert.equal(bad.error.code, 'bad_values');
    assert.equal(bad.error.detail.length, 2);
    assert.equal(t.compute.chainKey(input({ action: 'mesh_generate', mesh_id: 'm1' })), 'mesh.m1');
    assert.equal(t.compute.chainKey(input({ action: 'run_start', run_id: 'r1' })), 'solve.r1');
    assert.equal(t.compute.chainKey(input({ action: 'mesh_generate' })), null, 'the active mesh is not known from the input alone');
    assert.equal(t.compute.chainKey(input({ action: 'hardware_check' })), null);
  });
});

// ------------------------------------------------------------------ cards

describe('compute and jobs cards (escalate, gateText)', () => {
  const ac = (o = {}) => ({ ctx: ctx(o), signal: new AbortController().signal, turn: `t-card-${++turnN}` });

  it('mesh_generate: Mesh, Engine, Last time, Queue and the estimate; the copy names the study and project', async () => {
    const t = tools();
    S.live = { kind: 'solve', run_id: 'x', project_id: 'other' };
    S.items = [{ id: 'q-1', kind: 'mesh', project_id: 'other' }];
    const a = await t.compute.escalate(input({ action: 'mesh_generate', estimate_minutes: 5 }), ac());
    assert.equal(a.risk, 'compute');
    assert.deepEqual(a.detail, [
      { label: 'Mesh', value: 'Mesh 1' },
      { label: 'Engine', value: 'Standard' },
      { label: 'Last time', value: 'first time' },
      { label: 'Queue', value: '2nd in line' },
      { label: "Assistant's estimate", value: 'about 5 min' },
    ]);
    const g = t.compute.gateText(input({ action: 'mesh_generate' }), a);
    assert.equal(g.title, 'Allow the Assistant to generate a mesh?');
    assert.equal(g.copy, 'Generates "Mesh 1" for study "Pipe flow" in project "Wing". It runs on this PC; other jobs wait in the queue.');
  });

  it('a generated mesh generates again only after a destructive card that names the runs that used it', async () => {
    S.mesh.generated = true;
    S.mesh.live_mesh_result = { status: 'done', n_cells: 1_200_000 };
    S.run.status = 'done';
    const t = tools();
    const a = await t.compute.escalate(input({ action: 'mesh_generate' }), ac());
    assert.equal(a.risk, 'destructive');
    assert.equal(a.note, 'Mesh 1 is generated and Run 1 used it; generating again replaces it.');
    assert.equal(a.detail.find((d) => d.label === 'Last time').value, '1.2 M cells');
    assert.equal(t.compute.gateText(input({ action: 'mesh_generate' }), a).title, 'Allow the Assistant to generate "Mesh 1" again?');
  });

  it('a chain card covers the declared steps by name', async () => {
    const t = tools();
    const i = input({ action: 'mesh_generate', mesh_id: 'm1', chain: ['solve.r1'], estimate_minutes: 12 });
    const a = await t.compute.escalate(i, ac());
    assert.equal(a.note, 'Covers these steps, each once: 1. Generate "Mesh 1". 2. Start "Run 1". Nothing else is covered; you can stop either from the tree.');
    assert.equal(a.detail[0].value, 'Generate "Mesh 1", then Start "Run 1"');
    // The covered call's transcript line names its job as the card did.
    assert.deepEqual(a.labels, { 'solve.r1': 'Start "Run 1"' });
    assert.equal(t.compute.gateText(i, a).title, 'Allow the Assistant to mesh and run?');
  });

  it('a regenerate card with a chain names every step it covers (seen live: "generate again" quietly covered starting the run)', async () => {
    const t = tools();
    S.mesh.generated = true;
    const i = input({ action: 'mesh_generate', mesh_id: 'm1', chain: ['solve.r1'] });
    const a = await t.compute.escalate(i, ac());
    assert.equal(a.risk, 'destructive');
    assert.match(a.note, /generating again replaces it\. Covers these steps, each once: 1\. Generate "Mesh 1" again\. 2\. Start "Run 1"\./);
    assert.equal(a.detail[0].value, 'Generate "Mesh 1" again, then Start "Run 1"');
    assert.deepEqual(a.labels, { 'solve.r1': 'Start "Run 1"' });
    assert.equal(t.compute.gateText(i, a).title, 'Allow the Assistant to generate "Mesh 1" again, and the steps after it?');
    // A run started first, with a step after it: that step is on its card too.
    S.mesh.generated = true;
    const r = await t.compute.escalate(input({ action: 'run_start', chain: ['mesh.m1'] }), ac());
    assert.match(r.note, /Covers these steps, each once: 1\. Start "Run 1"\. 2\. Generate "Mesh 1"\./);
    assert.deepEqual(r.labels, { 'mesh.m1': 'Generate "Mesh 1"' });
  });

  it('run_start: Run, Mesh, Cores, Queue; continuing a converged run is destructive', async () => {
    const t = tools();
    const a = await t.compute.escalate(input({ action: 'run_start' }), ac());
    assert.equal(a.note, 'Starts "Run 1" of study "Pipe flow" (500 iterations, 8 cores).');
    assert.deepEqual(a.detail.map((d) => d.label), ['Run', 'Mesh', 'Cores', 'Queue']);
    assert.equal(t.compute.gateText(input({ action: 'run_start' }), a).title, 'Allow the Assistant to start a run?');
    S.run.status = 'done';
    S.run.converged = { iteration: 320, by: 'residuals' };
    const c = await t.compute.escalate(input({ action: 'run_continue', extra_iterations: 100 }), ac());
    assert.equal(c.risk, 'destructive');
    assert.equal(c.note, 'Run 1 has converged; continuing changes its results.');
    assert.equal(t.compute.gateText(input({ action: 'run_continue' }), c).title, 'Allow the Assistant to continue "Run 1" past convergence?');
  });

  it('the other actions: export, this PC, a plugin\'s tools; queue_kick asks nothing more', async () => {
    const t = tools();
    S.run.status = 'done';
    S.run.n_saved_times = 40;
    const e = await t.compute.escalate(input({ action: 'vtk_export', frames: 'all' }), ac());
    assert.equal(e.note, 'Writes a VTK file of "Run 1" (all 40 times) in the project; you download it from the Assistant panel.');
    assert.equal(t.compute.gateText(input({ action: 'vtk_export' }), e).title, 'Allow the Assistant to export results?');
    const hw = await t.compute.escalate(input({ action: 'hardware_check' }), ac({ projectId: null }));
    assert.equal(t.compute.gateText(input({ action: 'hardware_check' }), hw).title, 'Allow the Assistant to check this PC?');
    const env = await t.compute.escalate(input({ action: 'plugin_env_install', plugin: 'heat_transfer' }), ac());
    assert.equal(t.compute.gateText(input({ action: 'plugin_env_install', plugin: 'heat_transfer' }), env).title, "Allow the Assistant to install heat_transfer's tools?");
    assert.equal(await t.compute.escalate(input({ action: 'queue_kick' }), ac()), null);
  });

  it('jobs: force_stop is destructive and names the run; the rest stays edit', async () => {
    const t = tools();
    const a = await t.jobs.escalate({ project_id: '', action: 'force_stop', job_id: 'solve.r1', ids: [] }, ac());
    assert.deepEqual(a, { risk: 'destructive', note: 'Ends Run 1 at once; its last time step may be incomplete.', detail: [{ label: 'Run', value: 'Run 1' }] });
    assert.deepEqual(t.jobs.gateText({}, a), { title: 'Allow the Assistant to force-stop "Run 1"?', copy: 'Ends it at once; its last time step may be incomplete.', detail: [{ label: 'Run', value: 'Run 1' }] });
    assert.equal(await t.jobs.escalate({ project_id: '', action: 'stop', job_id: 'solve.r1', ids: [] }, ac()), null);
  });
});

// ------------------------------------------------------------------ wait

describe('wait', () => {
  /** A wait whose polls run without real time: each pause advances the clock. */
  function fast(over = {}) {
    let now = 0;
    const pauses = [];
    const t = tools({
      now: () => now,
      sleep: async (ms, signal) => {
        pauses.push(ms);
        now += ms;
        await over.onPause?.(pauses.length, signal);
      },
      pollMs: 2_000,
      ...over,
    });
    return { t, pauses, clock: () => now };
  }
  const w = (o) => ({ project_id: '', job_ids: [], until: 'all', timeout_s: 0, ...o });

  it('follows a mesh to its end, reporting progress each poll', async () => {
    S.live = { kind: 'mesh', mesh_id: 'm1', project_id: P };
    S.mesh.live_mesh_result = { status: 'running', stage: 'surface_mesh', started_at: new Date().toISOString() };
    const { t } = fast({
      onPause: (n) => {
        if (n === 2) {
          S.live = null;
          S.mesh.live_mesh_result = { status: 'done', n_cells: 1200, n_points: 1500, started_at: new Date().toISOString() };
        }
      },
    });
    const r = rt();
    const out = await t.wait.run(w({ job_ids: ['mesh.m1'] }), r);
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.deepEqual(out.data.jobs, [
      { job_id: 'mesh.m1', kind: 'mesh', name: 'Mesh 1', status: 'done', position: 0, progress: { fraction: 1, label: 'Mesh 1: generated' }, result: { cells: 1200, points: 1500 }, error: '' },
    ]);
    assert.deepEqual([out.data.ended, out.data.timed_out], [true, false]);
    assert.deepEqual(
      r.progressLog.map((p) => p.label),
      ['Mesh 1: meshing the surface', 'Mesh 1: meshing the surface'],
    );
    assert.equal(out.summary, 'Mesh 1 done');
  });

  it('a solve: iteration progress with its fraction; until any ends at the first; the queue read once per poll', async () => {
    S.run.status = 'running';
    S.run.iteration = 120;
    S.live = { kind: 'solve', run_id: 'r1', project_id: P };
    S.export = { status: 'done', fraction: 1, file_name: 'Run_1-vtk-0.5.zip', bytes: 2048 };
    const { t } = fast();
    const r = rt();
    const out = await t.wait.run(w({ job_ids: ['solve.r1', 'export.job-exp-1'], until: 'any' }), r);
    assert.equal(out.data.ended, true);
    const [solve, exp] = out.data.jobs;
    assert.deepEqual([solve.status, solve.progress], ['running', { fraction: 0.24, label: 'Run 1: iteration 120 of 500' }]);
    assert.equal(exp.status, 'done');
    assert.deepEqual(exp.result, { file_name: 'Run_1-vtk-0.5.zip', bytes: 2048, times: null });
    assert.equal(app.seen.filter((x) => x.path === '/api/compute-queue').length, 1, 'one queue read for the poll');
  });

  it('an export\'s Download link goes to the person (links), never to the model', async () => {
    S.export = { status: 'done', fraction: 1, file_name: 'Run_1-vtk-all-frames.zip', bytes: 4096 };
    const { t } = fast();
    const out = await t.wait.run(w({ job_ids: ['export.job-exp-1'] }), rt());
    assert.deepEqual(out.links, [{ label: 'Download Run_1-vtk-all-frames.zip', href: `/api/results/export-vtk/job-exp-1/file?project_id=${P}` }]);
    assert.doesNotMatch(JSON.stringify(out.data), /\/api\/results/);
  });

  it('times out with the hint to call again; the jobs keep running', async () => {
    S.live = { kind: 'mesh', mesh_id: 'm1', project_id: P };
    S.mesh.live_mesh_result = { status: 'running', stage: 'gmsh' };
    const { t, clock } = fast();
    const out = await t.wait.run(w({ job_ids: ['mesh.m1'], timeout_s: 10 }), rt());
    assert.deepEqual([out.data.ended, out.data.timed_out, out.data.hint], [false, true, 'Call wait again with the same job ids.']);
    assert.ok(clock() >= 9_750 && clock() <= 10_000, String(clock()));
    assert.equal(out.data.jobs[0].status, 'running');
    assert.match(out.summary, /^Still waiting: Mesh 1 running/);
    assert.equal(writes().length, 0, 'wait never writes');
  });

  it('Stop aborts the wait at once (within the 2 s grace), and nothing is stopped', async () => {
    S.live = { kind: 'mesh', mesh_id: 'm1', project_id: P };
    S.mesh.live_mesh_result = { status: 'running', stage: 'gmsh' };
    const controller = new AbortController();
    const t = tools({ pollMs: 2_000 });
    const t0 = Date.now();
    setTimeout(() => controller.abort(), 300);
    const out = await t.wait.run(w({ job_ids: ['mesh.m1'] }), rt({ controller }));
    assert.ok(Date.now() - t0 < 2_000, `${Date.now() - t0} ms`);
    assert.equal(out.error.code, 'stopped');
    assert.match(out.error.message, /the jobs keep running/);
    assert.equal(writes().length, 0);
  });

  it('a link job waiting for the person reports waiting; env and hw jobs are followed too', async () => {
    turnJobs.rememberJob('t-link', { job_id: 'link.gl-1', kind: 'link', id: 'gl-1', name: 'Plate update', project_id: P, simulation_id: '', plugin: 'cad', study_id: 'ps-1', since: new Date().toISOString(), last: 'running' });
    const { t } = fast();
    const r = rt();
    const out = await t.wait.run(w({ job_ids: ['link.gl-1', 'hw.check'], until: 'any', timeout_s: 4 }), r);
    const link = out.data.jobs[0];
    assert.deepEqual([link.status, link.waiting], ['running', true]);
    assert.ok(r.progressLog.some((p) => p.waiting === true), 'the turn\'s minutes stop while it waits for the person');
    assert.deepEqual(app.seen.find((x) => x.path === '/api/plugin-geometry/status').query, { project_id: P, plugin: 'cad', study_id: 'ps-1', job_id: 'gl-1' });
    const env = await t.wait.run(w({ job_ids: ['env.heat_transfer'], timeout_s: 2 }), rt({ ctx: { projectId: null } }));
    assert.deepEqual([env.data.jobs[0].status, env.data.jobs[0].progress.label], ['running', 'Heat Transfer tools: Downloading']);
  });

  it('a mesh that left the queue before it started is cancelled, not an older result', async () => {
    const r = rt();
    turnJobs.rememberJob(r.turn, { job_id: 'mesh.m1', kind: 'mesh', id: 'm1', name: 'Mesh 1', project_id: P, simulation_id: 's1', since: new Date().toISOString(), last: 'queued' });
    S.mesh.live_mesh_result = { status: 'done', n_cells: 10, started_at: new Date(Date.now() - 3_600_000).toISOString() };
    const { t } = fast();
    const out = await t.wait.run(w({ job_ids: ['mesh.m1'] }), r);
    assert.deepEqual([out.data.jobs[0].status, out.data.jobs[0].error], ['cancelled', 'Mesh 1 left the queue before it started.']);
  });

  it('bad ids are refused, all at once', async () => {
    const out = await tools().wait.run(w({ job_ids: ['nope', 'mesh.ok', 'export.x'] }), rt());
    assert.equal(out.error.code, 'bad_values');
    assert.equal(out.error.detail.length, 2);
  });
});

// ------------------------------------------------------------------ jobs

describe('jobs', () => {
  const j = (o) => ({ project_id: '', action: 'stop', job_id: '', ids: [], ...o });

  it('stop a mesh: POST /api/mesh/stop of its study; not running is said plainly', async () => {
    const t = tools();
    const out = await t.jobs.run(j({ job_id: 'mesh.m1' }), rt());
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.deepEqual(writes().at(-1).body, { project_id: P, simulation_id: 's1', mesh_id: 'm1' });
    assert.equal(out.data.done, 'Stopped Mesh 1; it is not generated, and its settings are kept');
    assert.deepEqual([t.syncs.at(-1).kinds, t.syncs.at(-1).tool], [['mesh'], 'jobs.stop']);
    S.meshStop = [409, { ok: false, code: 'not_running', error: 'Mesh 1 is not generating.' }];
    const idle = await t.jobs.run(j({ job_id: 'mesh.m1' }), rt());
    assert.equal(idle.error.code, 'not_running');
  });

  it('stop a run gracefully, force_stop at once; a queued run leaves the queue instead', async () => {
    S.run.status = 'running';
    S.live = { kind: 'solve', run_id: 'r1', project_id: P };
    let out = await tools().jobs.run(j({ job_id: 'solve.r1' }), rt());
    assert.deepEqual(writes().at(-1).body, { project_id: P, run_id: 'r1' });
    assert.equal(out.data.status, 'stopping');
    S.runStop = [200, { ok: true, stopped: true, forced: true }];
    out = await tools().jobs.run(j({ action: 'force_stop', job_id: 'solve.r1' }), rt());
    assert.deepEqual(writes().at(-1).body, { project_id: P, run_id: 'r1', force: true });
    assert.equal(out.data.done, 'Stopped Run 1 at once');
    S.live = null;
    S.run.status = 'draft';
    S.items = [{ id: 'q-5', kind: 'solve', run_id: 'r1', project_id: P, name: 'Run 1' }];
    app.seen = [];
    out = await tools().jobs.run(j({ job_id: 'solve.r1' }), rt());
    assert.deepEqual(writes().at(-1).body, { action: 'remove', kind: 'solve', id: 'q-5', project_id: P });
    assert.equal(out.data.done, 'Run 1 left the queue');
    const mesh = await tools().jobs.run(j({ action: 'force_stop', job_id: 'mesh.m1' }), rt());
    assert.equal(mesh.error.code, 'invalid_input');
  });

  // Run health spec RH1 §3.4: a second plain stop never becomes a forced stop, and asks nothing.
  it('two stops make one POST: the second answers that it is already stopping, with no card; force_stop is still the destructive one', async () => {
    S.run.status = 'running';
    S.live = { kind: 'solve', run_id: 'r1', project_id: P };
    S.runStop = [200, { ok: true, stopping: true, run_id: 'r1' }];
    const ac = () => ({ ctx: ctx(), signal: new AbortController().signal, turn: 't-stop-twice' });
    let out = await tools().jobs.run(j({ job_id: 'solve.r1' }), rt());
    assert.equal(out.data.status, 'stopping');
    assert.equal(writes().filter((w) => w.path === '/api/run/stop').length, 1);
    // The slot says it is stopping now.
    S.live = { ...S.live, stopping: true };
    const t = tools();
    assert.equal(await t.jobs.escalate(j({ job_id: 'solve.r1' }), ac()), null, 'a plain stop asks nothing');
    out = await t.jobs.run(j({ job_id: 'solve.r1' }), rt());
    assert.equal(writes().filter((w) => w.path === '/api/run/stop').length, 1, 'no second POST');
    assert.deepEqual([out.ok, out.data.status, out.data.already], [true, 'stopping', true]);
    assert.equal(out.data.done, 'Run 1 is already stopping: it writes its current step first');
    assert.equal(out.data.hint, 'It is writing its current step; wait, or force_stop ends it at once (the person is asked).');
    // The route says so too when the slot had not (already): the same answer.
    S.live = { kind: 'solve', run_id: 'r1', project_id: P };
    S.runStop = [200, { ok: true, stopping: true, already: true, run_id: 'r1' }];
    out = await tools().jobs.run(j({ job_id: 'solve.r1' }), rt());
    assert.deepEqual([out.data.status, out.data.already], ['stopping', true]);
    assert.equal((await t.jobs.escalate(j({ action: 'force_stop', job_id: 'solve.r1' }), ac())).risk, 'destructive');
  });

  it("unqueue and reorder take only this project's rows (the queue's routes take any project's)", async () => {
    S.items = [
      { id: 'q-a', kind: 'mesh', mesh_id: 'm1', project_id: P, name: 'Mesh 1' },
      { id: 'q-b', kind: 'solve', run_id: 'r1', project_id: P, name: 'Run 1' },
      { id: 'q-x', kind: 'mesh', mesh_id: 'm9', project_id: 'other', name: 'Theirs' },
    ];
    const t = tools();
    const foreign = await t.jobs.run(j({ action: 'unqueue', job_id: 'q-x' }), rt());
    assert.equal(foreign.error.code, 'not_found');
    assert.equal(writes().length, 0);
    const mine = await t.jobs.run(j({ action: 'unqueue', job_id: 'q-a' }), rt());
    assert.equal(mine.ok, true);
    assert.deepEqual(writes().at(-1).body, { action: 'remove', kind: 'mesh', id: 'q-a', project_id: P });
    const byJob = await t.jobs.run(j({ action: 'unqueue', job_id: 'solve.r1' }), rt());
    assert.deepEqual([byJob.ok, writes().at(-1).body.id], [true, 'q-b']);
    S.items.push({ id: 'q-c', kind: 'mesh', mesh_id: 'm2', project_id: P });
    S.items.push({ id: 'q-d', kind: 'mesh', mesh_id: 'm3', project_id: P });
    const mixed = await t.jobs.run(j({ action: 'reorder', ids: ['q-d', 'q-x'] }), rt());
    assert.equal(mixed.error.code, 'not_found');
    assert.equal(writes().filter((x) => x.method === 'PATCH').length, 0);
    const ok = await t.jobs.run(j({ action: 'reorder', ids: ['q-d', 'q-c'] }), rt());
    assert.equal(ok.ok, true);
    assert.deepEqual([writes().at(-1).method, writes().at(-1).body], ['PATCH', { ids: ['q-d', 'q-c'] }]);
    S.reorder = [400, { ok: false, error: 'A run cannot sit above the mesh it uses' }];
    const order = await t.jobs.run(j({ action: 'reorder', ids: ['q-c', 'q-d'] }), rt());
    assert.equal(order.error.code, 'bad_order');
  });

  it('cancel_export stops the export job; a link has no stop; writes go only to this window\'s project', async () => {
    const t = tools();
    const out = await t.jobs.run(j({ action: 'cancel_export', job_id: 'export.job-exp-1' }), rt());
    assert.equal(out.ok, true);
    assert.deepEqual([writes().at(-1).path, writes().at(-1).query], ['/api/jobs/job-exp-1/stop', { project_id: P }]);
    const viaStop = await t.jobs.run(j({ job_id: 'export.job-exp-1' }), rt());
    assert.equal(viaStop.ok, true);
    const link = await t.jobs.run(j({ job_id: 'link.gl-1' }), rt());
    assert.deepEqual([link.error.code, link.error.hint], ['cannot_stop', 'A queued update can be unqueued.']);
    const other = await t.jobs.run(j({ project_id: 'p2', job_id: 'mesh.m1' }), rt());
    assert.equal(other.error.code, 'not_this_project');
    const home = await t.jobs.run(j({ job_id: 'mesh.m1' }), rt({ ctx: { projectId: null } }));
    assert.equal(home.error.code, 'no_project');
  });
});

// ------------------------------------------------------------------ the turn's end line

describe("the turn's end line names what still runs", () => {
  after(() => turnJobs.setLiveCheckForTests(null));
  const job = (id, kind, name) => ({ job_id: `${kind}.${id}`, kind, id, name, project_id: P, simulation_id: 's1', since: new Date().toISOString(), last: 'running' });

  it('the jobs a turn started go on its owner list in the grant store', () => {
    turnJobs.rememberJob('t-grant', job('m1', 'mesh', 'Mesh 1'));
    assert.deepEqual(grants().startedBy('t-grant'), [{ job: 'mesh.m1', label: 'Mesh 1' }]);
    grants().end('t-grant');
  });

  it('running and queued jobs are named with how to stop them; ended ones are not', () => {
    turnJobs.rememberJob('t-end', job('m1', 'mesh', 'Mesh 1'));
    turnJobs.rememberJob('t-end', job('r1', 'solve', 'Run 1'));
    turnJobs.rememberJob('t-end', job('r2', 'solve', 'Run 2'));
    turnJobs.setLiveCheckForTests((j) => (j.id === 'm1' ? 'running' : j.id === 'r1' ? 'queued' : 'ended'));
    assert.equal(turnJobs.stillRunningNote('t-end'), 'Still running: Mesh 1, Run 1 (queued). Stop them from the tree, the Queue, or ask the Assistant.');
    // The turn's record goes with it.
    assert.equal(turnJobs.stillRunningNote('t-end'), null);
    turnJobs.rememberJob('t-one', job('m1', 'mesh', 'Mesh 1'));
    turnJobs.setLiveCheckForTests(() => 'running');
    assert.equal(turnJobs.stillRunningNote('t-one'), 'Still running: Mesh 1. Stop it from the tree, the Queue, or ask the Assistant.');
    turnJobs.rememberJob('t-none', job('m1', 'mesh', 'Mesh 1'));
    turnJobs.setLiveCheckForTests(() => 'ended');
    assert.equal(turnJobs.stillRunningNote('t-none'), null);
  });

  it("by default the server's own slot and queue decide (in-process, at once)", async () => {
    turnJobs.setLiveCheckForTests(null);
    const slot = await import('../../compute-slot.js');
    const c = slot.claimComputeSlot('mesh', { project_id: P, mesh_id: 'm7', name: 'Mesh 7' });
    try {
      assert.equal(turnJobs.liveInProcess(job('m7', 'mesh', 'Mesh 7')), 'running');
      assert.equal(turnJobs.liveInProcess(job('m8', 'mesh', 'Mesh 8')), 'ended');
      assert.equal(turnJobs.liveInProcess({ ...job('job-1', 'export', 'Export'), last: 'running' }), 'running');
      assert.equal(turnJobs.liveInProcess({ ...job('job-1', 'export', 'Export'), last: 'done' }), 'ended');
    } finally {
      slot.releaseComputeSlot(c.token);
    }
  });
});

// ------------------------------------------------------------------ links

describe('result links (the Download the person clicks)', () => {
  it('only the app\'s own export files, labels cleaned, at most four', () => {
    const good = { label: 'Download Run_1.zip\u202e', href: '/api/results/export-vtk/job-abc-1/file?project_id=p1' };
    assert.deepEqual(safeLinks([good]), [{ label: 'Download Run_1.zip', href: good.href }]);
    for (const href of ['https://evil.example/x', '//evil/x', '/api/results/export-vtk/job-1/file?project_id=p1&x=1', 'javascript:alert(1)', '/api/assistant/key']) {
      assert.deepEqual(safeLinks([{ label: 'x', href }]), [], href);
    }
    assert.equal(safeLinks(Array.from({ length: 6 }, (_, i) => ({ label: 'x', href: `/api/results/export-vtk/job-${i}/file?project_id=p1` }))).length, 4);
    assert.deepEqual(safeLinks(null), []);
  });

  it("the runner puts a result's links on the log's tool_result, and the model's result has none", async () => {
    const events = [];
    const def = {
      name: 'wait',
      localName: 'wait',
      title: 'Wait',
      description: 'x',
      schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
      risk: 'read',
      source: { kind: 'host' },
      projectData: false,
      stallMs: 30_000,
      workerBacked: false,
      available: () => true,
      run: async () => ({
        ok: true,
        data: { done: 'ready' },
        links: [
          { label: 'Download a.zip', href: '/api/results/export-vtk/job-1/file?project_id=p1' },
          { label: 'Elsewhere', href: 'https://example.com' },
        ],
        summary: 'Ready',
      }),
    };
    const runner = new ToolRunner({ gates: { ask: async () => 'allow' } });
    const r = await runner.run(
      { type: 'tool_call', callId: 'c1', name: 'wait', input: {} },
      {
        owner: { kind: 'turn', id: 't1', tab: null },
        ctx: ctx(),
        signal: new AbortController().signal,
        offered: new Map([['wait', def]]),
        turn: { id: 't1', step: 1, emit: (e) => events.push(e), setState() {}, pause() {}, resume() {} },
      },
    );
    const result = events.find((e) => e.type === 'tool_result');
    assert.deepEqual(result.links, [{ label: 'Download a.zip', href: '/api/results/export-vtk/job-1/file?project_id=p1' }]);
    assert.doesNotMatch(r.part.text, /export-vtk|example\.com/);
  });
});

describe('inputs the schemas refuse', () => {
  it('compute: an unknown action, too long a chain', () => {
    const t = tools();
    assert.equal(validateInput(t.compute.schema, input({ action: 'mesh_delete' })).ok, false);
    assert.equal(validateInput(t.compute.schema, input({ action: 'mesh_generate', chain: ['a', 'b', 'c', 'd', 'e'] })).ok, false);
    assert.equal(validateInput(t.wait.schema, { project_id: '', job_ids: [], until: 'all', timeout_s: 0 }).ok, false);
    assert.equal(validateInput(t.wait.schema, { project_id: '', job_ids: ['mesh.m1'], until: 'all', timeout_s: 601 }).ok, false);
  });
});

// A call to the app's routes the tools make is sent within the turn's rate: a wait on four
// jobs reads the queue once per poll, not once per job (checked above), and backs off a
// rate-limited read to the next poll instead of failing.
describe('wait under the rate limit', () => {
  it('a rate-limited read waits for the next poll', async () => {
    S.live = { kind: 'mesh', mesh_id: 'm1', project_id: P };
    S.mesh.live_mesh_result = { status: 'running', stage: 'gmsh' };
    let n = 0;
    const real = createHostTransport({ port: () => app.port }).call;
    const flaky = (id, args, o) => {
      n += 1;
      if (n === 1) return Promise.reject(new HostCallError('rate_limited', 'Too many'));
      return real(id, args, o);
    };
    let now = 0;
    const t = createJobTools({ call: flaky, now: () => now, sleep: async (ms) => void (now += ms) });
    const out = await t[1].run({ project_id: '', job_ids: ['mesh.m1'], until: 'all', timeout_s: 3 }, rt());
    assert.equal(out.ok, true);
    assert.equal(out.data.jobs[0].status, 'running');
    await sleep(0);
  });

  it("the job tools are paced as the other host tools are: a call held back past 3 s still runs (up to 15 s), then it gives the refusal; a Stop ends the wait", async () => {
    S.live = { kind: 'mesh', mesh_id: 'm1', project_id: P };
    S.mesh.live_mesh_result = { status: 'running', stage: 'gmsh' };
    const real = createHostTransport({ port: () => app.port }).call;
    let held = 0;
    let n = 0;
    const flaky = (id, args, o) => {
      n += 1;
      if (n <= held) return Promise.reject(new HostCallError('rate_limited', 'Too many'));
      return real(id, args, o);
    };
    let now = 0;
    const slept = [];
    const t = createJobTools({ call: flaky, now: () => now, sleep: async (ms) => void (now += ms), pace: async (ms) => void (slept.push(ms), (now += ms)) });
    // 6 s of refusals (30 x 200 ms): D's own pacing gave up after 12 tries (3 s).
    held = 30;
    let out = await t[1].run({ project_id: '', job_ids: ['mesh.m1'], until: 'all', timeout_s: 60 }, rt());
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(out.data.jobs[0].status, 'running');
    assert.ok(slept.filter((ms) => ms === 200).length >= 30, 'it waited out each refusal');
    // Past 15 s it gives the refusal.
    n = 0;
    held = 1000;
    out = await t[2].run({ project_id: '', action: 'stop', job_id: 'mesh.m1', ids: [] }, rt());
    assert.equal(out.ok, false);
    assert.equal(out.error.code, 'rate_limited');
    // A Stop ends the wait at once (the real sleep, an aborted signal).
    const t2 = createJobTools({ call: () => Promise.reject(new HostCallError('rate_limited', 'Too many')) });
    const stop = new AbortController();
    stop.abort();
    const t0 = Date.now();
    out = await t2[2].run({ project_id: '', action: 'stop', job_id: 'mesh.m1', ids: [] }, rt({ controller: stop }));
    assert.equal(out.ok, false);
    assert.ok(Date.now() - t0 < 1000, 'no wait after a Stop');
    await sleep(0);
  });
});

// Through the runner (C3): the compute card is the tool's own, a declared chain covers the
// next step once, queue_kick asks nothing, and force_stop asks as destructive.
const { createGrants } = await import('../assistant/grants.ts');
describe('the cards through the runner', () => {
  async function runVia(runner, def, input, turn) {
    const events = [];
    const r = await runner.run(
      { type: 'tool_call', callId: `c-${++turnN}`, name: def.name, input },
      {
        owner: { kind: 'turn', id: turn, tab: null },
        ctx: ctx(),
        signal: new AbortController().signal,
        offered: new Map([[def.name, def]]),
        turn: { id: turn, step: 1, emit: (e) => events.push(e), setState() {}, pause() {}, resume() {}, note: (text) => events.push({ type: 'note', text }) },
      },
    );
    return { r, events };
  }

  it('one card for "mesh then run": the run that follows runs with no card and a note; queue_kick asks nothing', async () => {
    S.mesh.generated = false;
    const asked = [];
    const runner = new ToolRunner({ gates: { ask: async (g) => (asked.push(g), 'allow') }, grants: createGrants() });
    const t = tools();
    const turn = `t-chain-${++turnN}`;
    await runVia(runner, t.compute, input({ action: 'mesh_generate', mesh_id: 'm1', chain: ['solve.r1'], estimate_minutes: 12 }), turn);
    assert.equal(asked.length, 1);
    assert.equal(asked[0].title, 'Allow the Assistant to mesh and run?');
    assert.match(asked[0].copy, /1\. Generate "Mesh 1"\. 2\. Start "Run 1"\./);
    assert.equal(asked[0].risk, 'compute');
    S.live = { kind: 'mesh', mesh_id: 'm1', project_id: P };
    const second = await runVia(runner, t.compute, input({ action: 'run_start', run_id: 'r1' }), turn);
    assert.equal(asked.length, 1, 'covered by the earlier approval');
    assert.ok(second.events.some((e) => e.type === 'note' && /Covered by your earlier approval/.test(e.text)));
    await runVia(runner, t.compute, input({ action: 'queue_kick' }), turn);
    assert.equal(asked.length, 1, 'queue_kick starts only what is already approved');
    // Another turn's run is not covered.
    await runVia(runner, t.compute, input({ action: 'run_start', run_id: 'r1' }), `t-other-${++turnN}`);
    assert.equal(asked.length, 2);
  });

  it('jobs force_stop asks as destructive with its own words; stop asks nothing', async () => {
    S.run.status = 'running';
    S.live = { kind: 'solve', run_id: 'r1', project_id: P };
    const asked = [];
    const runner = new ToolRunner({ gates: { ask: async (g) => (asked.push(g), 'deny') }, grants: createGrants() });
    const t = tools();
    const out = await runVia(runner, t.jobs, { project_id: '', action: 'force_stop', job_id: 'solve.r1', ids: [] }, `t-fs-${++turnN}`);
    assert.equal(asked[0].risk, 'destructive');
    assert.equal(asked[0].title, 'Allow the Assistant to force-stop "Run 1"?');
    assert.equal(out.r.code, 'declined');
    assert.equal(writes().filter((x) => x.path === '/api/run/stop').length, 0, 'nothing stopped on Don\'t');
    await runVia(runner, t.jobs, { project_id: '', action: 'stop', job_id: 'solve.r1', ids: [] }, `t-s-${++turnN}`);
    assert.equal(asked.length, 1);
    assert.equal(writes().filter((x) => x.path === '/api/run/stop').length, 1);
  });
});

describe('compute run_start of a stopped run with results (runReopen.ts)', () => {
  const ac = (o = {}) => ({ ctx: ctx(o), signal: new AbortController().signal, turn: `t-card-${++turnN}` });
  const stoppedRun = () => {
    S.mesh.generated = true;
    S.run.status = 'stopped';
    S.run.has_results = true;
    S.run.n_saved_times = 3;
    S.run.last_saved_iteration = 150;
    S.run.rev = 6;
  };

  it("asks as destructive with the person's Start words, then starts it over (reopen, then start)", async () => {
    stoppedRun();
    const t = tools();
    const i = input({ action: 'run_start' });
    const a = await t.compute.escalate(i, ac());
    assert.equal(a.risk, 'destructive');
    assert.equal(a.note, 'Its results (3 saved, up to iteration 150) are deleted, and it solves again from the beginning. To keep them, cancel and use Continue to go on from iteration 150, or add a run.');
    assert.equal(t.compute.gateText(i, a).title, 'Allow the Assistant to start "Run 1" over?');
    const out = await t.compute.run(i, rt());
    assert.equal(out.ok, true, JSON.stringify(out));
    const writes = app.seen.filter((s) => s.method === 'POST').map((s) => s.path);
    assert.deepEqual(writes.filter((p) => p.startsWith('/api/run/')), ['/api/run/reopen', '/api/run/start']);
    const reopen = app.seen.find((s) => s.path === '/api/run/reopen');
    assert.deepEqual([reopen.body.run_id, reopen.body.overwrite, reopen.body.base_rev], [S.run.id, true, 6]);
    assert.ok(t.syncs.some((e) => e.kinds.includes('tree')));
  });

  it('a chain card never claims to cover starting it over: that start asks on its own', async () => {
    stoppedRun();
    const t = tools();
    const a = await t.compute.escalate(input({ action: 'mesh_generate', mesh_id: 'm1', chain: ['solve.r1'] }), ac());
    assert.match(a.note, /2\. Start "Run 1" over, which asks first: its results are deleted\./);
    assert.deepEqual(a.labels || {}, {});
  });

  it('a start that was not asked about is refused by the route, and says how to ask', async () => {
    stoppedRun();
    S.start = [409, { ok: false, code: 'overwrites_results', final: true, error: 'Its results (3 saved, up to iteration 150) are deleted, and it solves again from the beginning.' }];
    const t = tools();
    const out = await t.compute.run(input({ action: 'run_start' }), rt());
    assert.equal(out.ok, false);
    assert.equal(out.error.code, 'overwrites_results');
    assert.match(out.error.hint, /call compute run_start again, and the person is asked first/);
    assert.equal(app.seen.some((s) => s.path === '/api/run/reopen'), false);
  });
});

describe('run health in the job tools (RH1)', () => {
  const ac = (o = {}) => ({ ctx: ctx(o), signal: new AbortController().signal, turn: `t-health-${++turnN}` });
  const HEALTH = {
    v: 1,
    verdict: 'unhealthy',
    unit: 'time step',
    window: 50,
    first_unhealthy: { t: 0.0069061069, step: 25, wall_s: 15 },
    restart: 'from_zero',
    findings: [
      { code: 'velocity_clipped', level: 'error', text: 'Velocity clipped' },
      { code: 'pv_coupling', level: 'error', text: 'Pressure' },
      { code: 'turbulence_bounded', level: 'error', text: 'k' },
    ],
  };
  const stoppedUnhealthy = (extra = {}) => {
    S.mesh.generated = true;
    Object.assign(S.run, { status: 'stopped', time_dependency: 'Transient', has_results: true, n_saved_times: 12, last_saved_iteration: 0.1667, continue_from: 0.1667, health: HEALTH, ...extra });
  };

  it('wait: a solving run that turns Unhealthy ends the wait at once with the alert, once; the run keeps running', async () => {
    const { resetWaitAlertsForTests } = await import('../assistant/host/wait.ts');
    resetWaitAlertsForTests();
    Object.assign(S.run, { status: 'running', iteration: 0.018, sim_time: 0.018, time_dependency: 'Transient', co_mean: 0.93, co_max: 104, started_at: new Date().toISOString(), health: HEALTH });
    S.live = { kind: 'solve', run_id: 'r1', project_id: P };
    let now = 0;
    const t = tools({ now: () => now, sleep: async (ms) => { now += ms; }, pollMs: 2_000 });
    const r = rt();
    const out = await t.wait.run({ project_id: '', job_ids: ['solve.r1'], until: 'all', timeout_s: 0 }, r);
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.deepEqual(out.data.alert, { job_id: 'solve.r1', verdict: 'unhealthy', top: 'velocity_clipped' });
    assert.equal(out.data.ended, false);
    assert.match(out.data.hint, /read_results \{kind:'health'\}/);
    assert.equal(out.data.jobs[0].progress.label, 'Run 1: t = 0.018 of 500 s · Co 0.93 (max 104) · health: Unhealthy (velocity_clipped, pv_coupling, +1)');
    assert.equal(writes().length, 0, 'nothing is stopped');
    // The next wait follows it on: it ends when the run ends.
    S.run.status = 'stopped';
    S.live = null;
    const again = await t.wait.run({ project_id: '', job_ids: ['solve.r1'], until: 'all', timeout_s: 0 }, rt());
    assert.equal(again.data.alert, undefined);
    assert.deepEqual(again.data.jobs[0].result.health, { verdict: 'unhealthy', word: 'Unhealthy', codes: ['velocity_clipped', 'pv_coupling', 'turbulence_bounded'], restart: 'from_zero' });
  });

  it('a stopping run says so', async () => {
    Object.assign(S.run, { status: 'running', stop_requested: true, time_dependency: 'Transient', sim_time: 0.1 });
    S.live = { kind: 'solve', run_id: 'r1', project_id: P };
    let now = 0;
    const t = tools({ now: () => now, sleep: async (ms) => { now += ms; }, pollMs: 2_000 });
    const out = await t.wait.run({ project_id: '', job_ids: ['solve.r1'], until: 'all', timeout_s: 1 }, rt());
    assert.equal(out.data.jobs[0].stopping, true);
    assert.equal(out.data.jobs[0].progress.label, 'Run 1: stopping: writing its current time step');
  });

  it("run_continue on a run whose saved results come after the onset: destructive, with the person's Continue words", async () => {
    stoppedUnhealthy();
    const t = tools();
    const i = input({ action: 'run_continue', end_time: 1 });
    const a = await t.compute.escalate(i, ac());
    assert.equal(a.risk, 'destructive');
    assert.equal(
      a.note,
      'Runs "Run 1" on to t = 1 s. Its saved results (t = 0.167 s) are from after it became unhealthy (t = 0.0069 s); continuing carries that on. A new run from t = 0 is safer.',
    );
    assert.equal(t.compute.gateText(i, a).title, 'Allow the Assistant to continue "Run 1"?');
  });

  it('run_continue on an unhealthy run: compute, it will likely repeat; a pending change: only Health on the continued part can tell', async () => {
    stoppedUnhealthy({ health: { ...HEALTH, restart: 'continue_after_fix' }, continue_from: 0.005, last_saved_iteration: 0.005 });
    const t = tools();
    const a = await t.compute.escalate(input({ action: 'run_continue', end_time: 1 }), ac());
    assert.equal(a.risk, 'compute');
    assert.match(a.note, /It became unhealthy at t = 0\.0069 s and its settings have not changed since, so Continue will likely repeat the problem\.$/);
    S.run.continue_changes = [{ from_t: 0.005, applied_at: null, changes: [{ key: 'transient.max_co', from: 100, to: 5 }] }];
    const b = await t.compute.escalate(input({ action: 'run_continue', end_time: 1 }), ac());
    assert.equal(b.risk, 'compute');
    assert.match(b.note, /Continue applies: Max Courant 100 → 5 \(from t = 0\.005 s\)\. Health checks the continued part from t = 0\.005 s; whether the change is enough shows only there\.$/);
    // No card says the change is enough, fixes the run, or makes it safe.
    assert.doesNotMatch(b.note.replace('whether the change is enough', ''), /\benough\b|\bfixe[sd]\b|\bsafe\b/i);
  });

  it('run_continue on a from_zero run with a change waiting: the destructive card says what Continue applies too (S7)', async () => {
    stoppedUnhealthy({ continue_changes: [{ from_t: 0.1667, applied_at: null, changes: [{ key: 'transient.max_co', from: 100, to: 5 }] }] });
    const t = tools();
    const a = await t.compute.escalate(input({ action: 'run_continue', end_time: 1 }), ac());
    assert.equal(a.risk, 'destructive');
    assert.equal(
      a.note,
      'Runs "Run 1" on to t = 1 s. Its saved results (t = 0.167 s) are from after it became unhealthy (t = 0.0069 s); continuing carries that on. A new run from t = 0 is safer.' +
        ' Continue applies: Max Courant 100 → 5 (from t = 0.167 s). Health checks the continued part from t = 0.167 s; whether the change is enough shows only there.',
    );
  });

  it("run_start of a run that became unhealthy: the card's copy is the person's Start question's (overwriteWords)", async () => {
    stoppedUnhealthy();
    const { overwriteWords } = await import('../../../src/workbench/runReopen.ts');
    const t = tools();
    const a = await t.compute.escalate(input({ action: 'run_start' }), ac());
    assert.equal(a.risk, 'destructive');
    const person = overwriteWords(S.run, { action: 'start', studyTransient: false, health: HEALTH });
    assert.equal(a.note, person.copy);
    // Its health offers no new run with a fix: the card promises none.
    assert.match(a.note, / "Run 1" became unhealthy at t = 0\.0069 s\. A new run keeps these results\.$/);
    // With a fix offered, both say "with the fix".
    const fixed = { ...HEALTH, findings: [...HEALTH.findings, { code: 'courant_mode', level: 'warn', text: 'Max Courant', fix: [{ label: 'New run: Max Courant 1', target: 'new_run', values: [{ key: 'transient.max_co', value: 1 }] }] }] };
    stoppedUnhealthy({ health: fixed });
    const b = await t.compute.escalate(input({ action: 'run_start' }), ac());
    assert.equal(b.note, overwriteWords(S.run, { action: 'start', studyTransient: false, health: fixed }).copy);
    assert.match(b.note, / "Run 1" became unhealthy at t = 0\.0069 s\. A new run with the fix keeps these results\.$/);
  });
});

// RH3 (run health spec 5.3): run_continue once the study's numerics differ from what the run
// started with (its numerics_used). With numerics "" it is refused choose_numerics with the hint,
// and nothing is asked (no card) or sent; with "as_was" or "new" the compute card lists the same
// differences as the person's Continue question (runReopen.ts numericsDiff), and after Allow the
// route gets that answer, said to be the Assistant's. With nothing different the value is ignored.
describe('RH3: run_continue after a study numerics change', () => {
  const ac = (o = {}) => ({ ctx: ctx(o), signal: new AbortController().signal, turn: `t-numerics-${++turnN}` });
  const SCHEMA = { type: 'object', properties: { relax_u: { type: 'number', title: 'Relaxation U' }, relax_p: { type: 'number', title: 'Relaxation p' } } };
  const stoppedWithNumerics = (extra = {}) => {
    S.mesh.generated = true;
    S.registry = { analysis: [{ key: 'incompressible_steady', numerics_schema: SCHEMA }] };
    S.study = { relax_p: 0.2 };
    Object.assign(S.run, {
      status: 'stopped',
      time_dependency: 'Steady-state',
      has_results: true,
      n_saved_times: 1,
      last_saved_iteration: 450,
      continue_from: 450,
      numerics_used: { analysis: 'incompressible_steady', mode: 'steady', at: '2026-11-04T00:00:00.000Z', values: { relax_u: null, relax_p: 0.3 } },
      ...extra,
    });
  };
  const posted = () => writes().find((x) => x.path === '/api/run/continue');

  it('no numerics: refused choose_numerics with the hint; no card, nothing sent', async () => {
    stoppedWithNumerics();
    const t = tools();
    const i = input({ action: 'run_continue', extra_iterations: 100 });
    assert.equal(await t.compute.escalate(i, ac()), null, 'no card');
    const out = await t.compute.run(i, rt());
    assert.equal(out.ok, false);
    assert.deepEqual(out.error.code, 'choose_numerics');
    assert.equal(out.error.message, `The study's numerics changed after "Run 1" started (Relaxation p 0.3 → 0.2).`);
    assert.equal(out.error.hint, 'Pass numerics "as_was" to continue with the numerics it started with, or "new" to use the study\'s numerics now. Ask the person which.');
    assert.equal(posted(), undefined);
    // Through the runner: nothing is asked.
    const asked = [];
    const runner = new ToolRunner({ gates: { ask: async (g) => (asked.push(g), 'allow') }, grants: createGrants() });
    const { r } = await runVia(runner, t.compute, input({ action: 'run_continue', extra_iterations: 100 }), `t-numerics-${++turnN}`);
    assert.equal(asked.length, 0);
    assert.match(JSON.stringify(r), /choose_numerics/);
    assert.equal(posted(), undefined);
  });

  it("'as_was' and 'new': the card lists the person's differences; after Allow the route gets the answer, as the Assistant's", async () => {
    stoppedWithNumerics();
    S.study = { relax_p: 0.2, relax_u: 0.5 };
    const { numericsDiff, numericsChangedText } = await import('../../../src/workbench/runReopen.ts');
    const list = 'Relaxation U preset → 0.5, Relaxation p 0.3 → 0.2';
    // The person's Continue question says the same differences, from the same function.
    assert.equal(numericsChangedText(S.run, numericsDiff(S.run, S.study, SCHEMA)), `The study's numerics changed after "Run 1" started: ${list}.`);
    const t = tools();
    const asWas = input({ action: 'run_continue', extra_iterations: 100, numerics: 'as_was' });
    const a = await t.compute.escalate(asWas, ac());
    assert.equal(a.risk, 'compute');
    assert.equal(a.note, `Runs "Run 1" for 100 more iterations. Continues "Run 1" with the numerics it started with; the study's newer values (${list}) are not used.`);
    assert.equal(t.compute.gateText(asWas, a).title, 'Allow the Assistant to continue a run?');
    let out = await t.compute.run(asWas, rt());
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.deepEqual(posted().body, { project_id: P, simulation_id: 's1', run_id: 'r1', extra_iterations: 100, start_id: 'ai-abc123def456', numerics: 'as_was', by: 'assistant' });
    app.seen = [];
    const fresh = input({ action: 'run_continue', extra_iterations: 100, numerics: 'new' });
    const b = await t.compute.escalate(fresh, ac());
    assert.equal(b.note, `Runs "Run 1" for 100 more iterations. Continues "Run 1" with the study's new numerics (${list}).`);
    out = await t.compute.run(fresh, rt());
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(posted().body.numerics, 'new');
    // Busy: queued with the answer, as the page queues it.
    S.start = [409, { ok: false, code: 'busy', error: 'busy' }];
    app.seen = [];
    out = await t.compute.run(fresh, rt());
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.deepEqual(writes().find((x) => x.path === '/api/compute-queue').body.settings, { continue: { extra_iterations: 100, numerics: 'new', by: 'assistant' } });
  });

  it('a from_zero run: destructive, its health first, then the differences', async () => {
    stoppedWithNumerics({
      time_dependency: 'Transient',
      continue_from: 0.1667,
      last_saved_iteration: 0.1667,
      numerics_used: { analysis: 'incompressible_steady', mode: 'transient', at: 'x', values: { relax_p: 0.3 } },
      health: { verdict: 'unhealthy', unit: 'time step', t: 0.2, first_unhealthy: { t: 0.0069061069, step: 25 }, restart: 'from_zero', findings: [] },
    });
    const t = tools();
    const i = input({ action: 'run_continue', end_time: 1, numerics: 'new' });
    const a = await t.compute.escalate(i, ac());
    assert.equal(a.risk, 'destructive');
    assert.equal(
      a.note,
      'Runs "Run 1" on to t = 1 s. Its saved results (t = 0.167 s) are from after it became unhealthy (t = 0.0069 s); continuing carries that on. A new run from t = 0 is safer.' +
        ' Continues "Run 1" with the study\'s new numerics (Relaxation p 0.3 → 0.2). Health checks the continued part from t = 0.167 s; whether the change is enough shows only there.',
    );
    assert.equal(t.compute.gateText(i, a).title, 'Allow the Assistant to continue "Run 1"?');
  });

  it('an unhealthy run: "new" says only Health on the continued part can tell, never that its settings have not changed; "as_was" will likely repeat', async () => {
    const health = { verdict: 'unhealthy', unit: 'iteration', t: 400, first_unhealthy: { t: 120, step: 120 }, restart: 'continue_after_fix', findings: [] };
    stoppedWithNumerics({ health });
    const t = tools();
    const fresh = await t.compute.escalate(input({ action: 'run_continue', extra_iterations: 100, numerics: 'new' }), ac());
    assert.equal(fresh.risk, 'compute');
    assert.equal(
      fresh.note,
      'Runs "Run 1" for 100 more iterations. Continues "Run 1" with the study\'s new numerics (Relaxation p 0.3 → 0.2). Health checks the continued part from iteration 450; whether the change is enough shows only there.',
    );
    assert.doesNotMatch(fresh.note, /not changed|likely repeat/);
    const asWas = await t.compute.escalate(input({ action: 'run_continue', extra_iterations: 100, numerics: 'as_was' }), ac());
    assert.equal(
      asWas.note,
      'Runs "Run 1" for 100 more iterations. Continues "Run 1" with the numerics it started with; the study\'s newer values (Relaxation p 0.3 → 0.2) are not used. It became unhealthy at iteration 120 and its settings have not changed since, so Continue will likely repeat the problem.',
    );
    // A change waiting for Continue (A2) and the new numerics: both, then the one Health sentence.
    S.run.continue_changes = [{ from_iteration: 450, applied_at: null, changes: [{ key: 'transient.max_co', from: 100, to: 5 }] }];
    const both = await t.compute.escalate(input({ action: 'run_continue', extra_iterations: 100, numerics: 'new' }), ac());
    assert.equal(
      both.note,
      'Runs "Run 1" for 100 more iterations. Continue applies: Max Courant 100 → 5 (from iteration 450). Continues "Run 1" with the study\'s new numerics (Relaxation p 0.3 → 0.2). Health checks the continued part from iteration 450; whether the change is enough shows only there.',
    );
  });

  it('nothing different, or a run started before RH3: the value is ignored and the card is today\'s', async () => {
    stoppedWithNumerics();
    S.study = { relax_p: 0.3 };
    const t = tools();
    let a = await t.compute.escalate(input({ action: 'run_continue', extra_iterations: 100 }), ac());
    assert.equal(a.note, 'Runs "Run 1" for 100 more iterations.');
    a = await t.compute.escalate(input({ action: 'run_continue', extra_iterations: 100, numerics: 'new' }), ac());
    assert.equal(a.note, 'Runs "Run 1" for 100 more iterations.');
    delete S.run.numerics_used;
    S.study = { relax_p: 0.2 };
    a = await t.compute.escalate(input({ action: 'run_continue', extra_iterations: 100 }), ac());
    assert.equal(a.note, 'Runs "Run 1" for 100 more iterations.');
    const out = await t.compute.run(input({ action: 'run_continue', extra_iterations: 100 }), rt());
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal('numerics' in posted().body, false);
  });

  it("the study changed between the card and the call: the route's refusal comes back as the same choice", async () => {
    stoppedWithNumerics();
    S.study = { relax_p: 0.3 };
    S.start = [409, { ok: false, code: 'choose_numerics', error: "The study's numerics changed after \"Run 1\" started: Relaxation p 0.3 → 0.2." }];
    const t = tools();
    const i = input({ action: 'run_continue', extra_iterations: 100 });
    assert.equal((await t.compute.escalate(i, ac())).risk, 'compute');
    S.study = { relax_p: 0.2 };
    const out = await t.compute.run(i, rt());
    assert.deepEqual([out.ok, out.error.code, out.error.message], [false, 'choose_numerics', `The study's numerics changed after "Run 1" started (Relaxation p 0.3 → 0.2).`]);
  });

  async function runVia(runner, def, i, turn) {
    const events = [];
    const r = await runner.run(
      { type: 'tool_call', callId: `c-${++turnN}`, name: def.name, input: i },
      {
        owner: { kind: 'turn', id: turn, tab: null },
        ctx: ctx(),
        signal: new AbortController().signal,
        offered: new Map([[def.name, def]]),
        turn: { id: turn, step: 1, emit: (e) => events.push(e), setState() {}, pause() {}, resume() {}, note: (text) => events.push({ type: 'note', text }) },
      },
    );
    return { r, events };
  }
});
