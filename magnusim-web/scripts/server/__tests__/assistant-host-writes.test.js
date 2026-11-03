// The study and setup host tools against a stand-in for the app (Core host tools spec 4.9,
// 4.10, 16.1): every study_edit and setup_edit kind × action sends the exact method, path and
// body keys of the spec (copied from the real handlers), and nothing else. Also: every problem
// with values at once (bad_values); writes only to the window's project (not_this_project);
// faces checked, a face two bodies share refused (inside_face); a name already used refused;
// never an empty /api/mesh body, never {delete:true}; the escalations that make a call ask
// first.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-host-writes-'));
process.env.MAGNUSIM_PROJECTS_ROOT = join(ROOT, 'projects');
process.env.MAGNUSIM_LOCAL_JSON = join(ROOT, 'local.json');
process.env.MAGNUSIM_ASSISTANT_HOME = join(ROOT, 'home');

const { createHostTransport } = await import('../assistant/host-call.ts');
const { paced } = await import('../assistant/host/common.ts');
const { studyEditTool } = await import('../assistant/host/study-edit.ts');
const { setupEditTool, SETUP_PAIRS, newMonitorRecord, monitorBoundaryTokens } = await import('../assistant/host/setup-edit.ts');
const { startFakeApp, makeRt, world, REGISTRY } = await import('./assistant-host-harness.js');

let app;
// The calls' rate runs on this clock: a call that waits for its slot moves it on, never the test's time.
let fakeNow = 0;
const synced = [];
before(async () => {
  app = await startFakeApp();
});
after(async () => {
  await app.stop();
  rmSync(ROOT, { recursive: true, force: true });
});

const deps = (o = {}) => ({
  hostCall: paced(createHostTransport({ port: () => app.port, now: () => fakeNow }).call, async (ms) => { fakeNow += ms; }),
  assistant: async () => ({ provider: 'anthropic', model: 'm' }),
  version: async () => '0',
  plugins: () => [],
  uiSync: { emit: (e) => synced.push(e) },
  ...o,
});
const fresh = () => {
  Object.assign(app.w, world());
  app.over = null;
  synced.length = 0;
};
const rt = makeRt;

/** Runs a tool and returns {out, writes: [{method, path, keys, body}]} (the writes it sent). */
async function sent(tool, input, r = rt()) {
  const from = app.seen.length;
  const out = await tool.run(input, r);
  const writes = app.writes(from).map((w) => ({ method: w.method, path: w.path, keys: w.body ? Object.keys(w.body).sort() : [], body: w.body, query: w.query }));
  return { out, writes };
}
const keys = (...k) => [...k].sort();

// ------------------------------------------------------------------ study_edit

const study = (o) => ({ project_id: '', action: '', id: '', ids: [], analysis: '', geometry_id: '', copy_from: '', copy_mode: '', time_dependency: '', name: '', plugin: '', kind: '', values: [], ...o });

describe('study_edit: every action, the exact routes and bodies', () => {
  const t = () => studyEditTool(deps());
  it('create: the study, then its name (the route ignores it), then Run 1 when the study has none', async () => {
    fresh();
    app.over = (m, path, q) => (m === 'GET' && path === '/api/run/status' && q.get('simulation_id') === 's-new' ? { ok: true, runs: [], run: null } : undefined);
    const { out, writes } = await sent(t(), study({ action: 'create', analysis: 'incompressible_steady', time_dependency: 'steady', name: 'Pipe flow' }));
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.deepEqual(
      writes.map((w) => [w.method, w.path, w.keys]),
      [
        ['POST', '/api/simulation', keys('project_id', 'analysis_type', 'time_dependency', 'activate')],
        ['POST', '/api/simulation/update', keys('project_id', 'simulation_id', 'name')],
        ['POST', '/api/run/create', keys('project_id', 'simulation_id', 'name')],
      ],
    );
    assert.deepEqual(writes[0].body, { project_id: 'p1', analysis_type: 'incompressible_steady', time_dependency: 'Steady-state', activate: true });
    assert.deepEqual(writes[2].body, { project_id: 'p1', simulation_id: 's-new', name: 'Run 1' });
    assert.deepEqual(out.data.ids, { study: 's-new', run: 'r-new' });
    assert.deepEqual(synced.at(-1).kinds, ['study', 'runs', 'active', 'tree']);
    assert.deepEqual(synced.at(-1).active, { study: 's-new' });
  });
  it('create on a study that has a run makes no second; an unknown analysis is refused before any write', async () => {
    fresh();
    const { writes } = await sent(t(), study({ action: 'create', analysis: '' }));
    assert.deepEqual(writes.map((w) => w.path), ['/api/simulation']);
    const bad = await sent(t(), study({ action: 'create', analysis: 'nope' }));
    assert.deepEqual([bad.out.error.code, bad.writes], ['not_found', []]);
  });
  it('copy: copy_from, copy_mode, activate', async () => {
    fresh();
    const { writes } = await sent(t(), study({ action: 'copy', copy_from: 's2', copy_mode: 'clone' }));
    assert.deepEqual(writes[0].body, { project_id: 'p1', copy_from: 's2', copy_mode: 'clone', activate: true });
  });
  it('rename, set and set_time go to /api/simulation/update; a study other than the active one is made active again after', async () => {
    fresh();
    let r = await sent(t(), study({ action: 'rename', id: 's1', name: 'Cruise 2' }));
    assert.deepEqual(r.writes.map((w) => [w.path, w.body]), [['/api/simulation/update', { project_id: 'p1', simulation_id: 's1', name: 'Cruise 2' }]]);
    r = await sent(t(), study({ action: 'rename', id: 's2', name: 'Climb 2' }));
    assert.deepEqual(r.writes.map((w) => [w.path, w.body]), [
      ['/api/simulation/update', { project_id: 'p1', simulation_id: 's2', name: 'Climb 2' }],
      ['/api/simulation/activate', { project_id: 'p1', simulation_id: 's1' }],
    ]);
    r = await sent(t(), study({ action: 'set', values: [{ key: 'turbulence_model', value: '"laminar"' }, { key: 'ref_speed', value: '12' }] }));
    assert.deepEqual(r.writes[0].body, { turbulence_model: 'laminar', ref_speed: 12, project_id: 'p1', simulation_id: 's1' });
    r = await sent(t(), study({ action: 'set_time', time_dependency: 'transient' }));
    assert.deepEqual(r.writes[0].body, { project_id: 'p1', simulation_id: 's1', time_dependency: 'Transient' });
    assert.deepEqual(synced.at(-1).kinds, ['study', 'runs']);
  });
  it('set: every bad value at once, nothing written', async () => {
    fresh();
    const r = await sent(t(), study({ action: 'set', values: [{ key: 'turbulence_model', value: '"fast"' }, { key: 'nope', value: '1' }, { key: 'ref_speed', value: 'not json' }] }));
    assert.equal(r.out.error.code, 'bad_values');
    assert.deepEqual(r.out.error.detail.map((p) => p.key), ['turbulence_model', 'nope', 'ref_speed']);
    assert.match(r.out.error.message, /^3 values are not right/);
    assert.deepEqual(r.writes, []);
  });
  it('activate checks the id first (the route says 200 to any id); reorder needs exactly the geometry\'s studies', async () => {
    fresh();
    let r = await sent(t(), study({ action: 'activate', id: 's9' }));
    assert.deepEqual([r.out.error.code, r.writes], ['not_found', []]);
    r = await sent(t(), study({ action: 'activate', id: 's2' }));
    assert.deepEqual(r.writes.map((w) => [w.path, w.body]), [['/api/simulation/activate', { project_id: 'p1', simulation_id: 's2' }]]);
    r = await sent(t(), study({ action: 'reorder', ids: ['s2'] }));
    assert.deepEqual([r.out.error.code, r.writes], ['invalid_input', []]);
    r = await sent(t(), study({ action: 'reorder', ids: ['s2', 's1'] }));
    assert.deepEqual(r.writes.map((w) => [w.path, w.body]), [['/api/simulation/reorder', { project_id: 'p1', ids: ['s2', 's1'], geometry_id: 'g1' }]]);
  });
  it('plugin_create and plugin_rename (with the study\'s rev); a stale rev is stale_record', async () => {
    fresh();
    let r = await sent(t(), study({ action: 'plugin_create', plugin: 'cad', kind: 'part', name: 'Bracket' }));
    assert.deepEqual(r.writes.map((w) => [w.path, w.body]), [['/api/plugin-studies/create', { project_id: 'p1', plugin: 'cad', kind: 'part', title: 'Bracket' }]]);
    assert.match(r.out.data.hint, /core__show \{target:'workspace', id:'ps-new'\}/);
    r = await sent(t(), study({ action: 'plugin_rename', id: 'cs1', name: 'Plate 2' }));
    assert.deepEqual(r.writes.map((w) => [w.path, w.body]), [['/api/plugin-studies/rename', { project_id: 'p1', plugin: 'cad', study_id: 'cs1', title: 'Plate 2', rev: 3 }]]);
    app.over = (m, path) => (path === '/api/plugin-studies/rename' ? { status: 409, body: { error: 'changed', code: -32009, ok: false } } : undefined);
    r = await sent(t(), study({ action: 'plugin_rename', id: 'cs1', name: 'Plate 3' }));
    assert.equal(r.out.error.code, 'stale_record');
  });
  it('writes only to the window\'s project', async () => {
    fresh();
    const r = await sent(t(), study({ project_id: 'p2', action: 'rename', id: 's1', name: 'x' }));
    assert.deepEqual([r.out.error.code, r.writes], ['not_this_project', []]);
    assert.match(r.out.error.message, /\("Wing"\)/);
    assert.match(r.out.error.hint, /core__show \{target:'project', project_id:'p2'\}/);
    assert.match(t().available({ tab: null, projectId: null, simulationId: null, cloud: true, local: false }), /Not offered on Home/);
  });
  it('set / set_time ask first when the study\'s runs have results (escalate), naming them', async () => {
    fresh();
    const a = await t().escalate(study({ action: 'set' }), { ctx: rt().ctx, signal: new AbortController().signal, turn: 't' });
    assert.equal(a.risk, 'destructive');
    assert.equal(a.note, 'Run 1 has results made with the old settings; they will no longer match these settings.');
    assert.equal(await t().escalate(study({ action: 'rename' }), { ctx: rt().ctx, signal: new AbortController().signal, turn: 't' }), null);
    assert.match(t().gateText(study({ action: 'set' }), a).copy, /Run 1 has results/);
  });
});

// ------------------------------------------------------------------ setup_edit

const setup = (o) => ({ project_id: '', simulation_id: '', kind: '', action: '', id: '', other_id: '', name: '', type: '', faces: [], bodies: [], values: [], rev: 0, ...o });

describe('setup_edit: every kind × action, the exact routes and bodies', () => {
  const t = () => setupEditTool(deps());
  it('every pair the spec names is taken; any other is refused, naming the valid ones', async () => {
    assert.deepEqual(Object.keys(SETUP_PAIRS), ['material', 'bc', 'bc_defaults', 'mesh', 'refinement', 'run', 'monitor', 'saved_view', 'geometry']);
    const r = await sent(t(), setup({ kind: 'bc_defaults', action: 'add' }));
    assert.deepEqual([r.out.error.code, r.out.error.detail.valid, r.writes], ['invalid_input', ['update'], []]);
  });

  it('material add: materials.set with the study\'s list, only_id(s), the preset\'s values under every record key; bodies move from the other material', async () => {
    fresh();
    const r = await sent(t(), setup({ kind: 'material', action: 'add', type: 'water', bodies: ['Body1'] }));
    assert.equal(r.out.ok, true, JSON.stringify(r.out));
    assert.deepEqual(r.writes.map((w) => [w.method, w.path, w.keys]), [['POST', '/api/worker', keys('method', 'params')]]);
    const p = r.writes[0].body.params;
    assert.equal(r.writes[0].body.method, 'materials.set');
    assert.deepEqual(Object.keys(p).sort(), keys('project_id', 'sim_id', 'body'));
    assert.deepEqual(Object.keys(p.body).sort(), keys('project_id', 'simulation_id', 'materials', 'air', 'only_id', 'only_ids'));
    const added = p.body.materials.find((m) => m.id === p.body.only_id);
    assert.match(added.id, /^mat-[0-9a-z]+-[0-9a-f]{6}$/);
    assert.deepEqual([added.name, added.preset, added.material_model, added.rho, added.density, added.assigned_volumes, added.body_ids], ['Water', 'water', 'newtonian_incompressible', 998.2, 998.2, ['Body1'], ['Body1']]);
    // Air gave up Body1: it is written too.
    assert.deepEqual(p.body.only_ids, [added.id, 'mat-1']);
    assert.deepEqual(p.body.materials.find((m) => m.id === 'mat-1').assigned_volumes, []);
    assert.equal(r.out.data.rev, 2);
  });
  it('material update / assign / unassign / clear: the stored record merged; values checked; unknown bodies refused', async () => {
    fresh();
    let r = await sent(t(), setup({ kind: 'material', action: 'update', id: 'mat-2', values: [{ key: 'rho', value: '1000' }] }));
    let rec = r.writes[0].body.params.body.materials.find((m) => m.id === 'mat-2');
    assert.deepEqual([rec.rho, rec.density, rec.name, rec.assigned_volumes], [1000, 1000, 'Water', ['Body2']]);
    r = await sent(t(), setup({ kind: 'material', action: 'assign', id: 'mat-2', bodies: ['Body1'] }));
    rec = r.writes[0].body.params.body.materials.find((m) => m.id === 'mat-2');
    assert.deepEqual(rec.assigned_volumes, ['Body2', 'Body1']);
    r = await sent(t(), setup({ kind: 'material', action: 'unassign', id: 'mat-2', bodies: ['Body2'] }));
    assert.deepEqual(r.writes[0].body.params.body.materials.find((m) => m.id === 'mat-2').assigned_volumes, []);
    r = await sent(t(), setup({ kind: 'material', action: 'clear', id: 'mat-1' }));
    assert.deepEqual(r.writes[0].body.params.body.materials.find((m) => m.id === 'mat-1').assigned_volumes, []);
    r = await sent(t(), setup({ kind: 'material', action: 'update', id: 'mat-2', values: [{ key: 'rho', value: '-1' }, { key: 'mu', value: '1' }] }));
    assert.deepEqual([r.out.error.code, r.out.error.detail.length, r.writes], ['bad_values', 2, []]);
    r = await sent(t(), setup({ kind: 'material', action: 'assign', id: 'mat-2', bodies: ['Body9'] }));
    assert.deepEqual([r.out.error.code, r.writes], ['not_found', []]);
  });

  it('bc add: one record by name and type, the family fields, the checked faces, the geometry; a used name is refused', async () => {
    fresh();
    let r = await sent(t(), setup({ kind: 'bc', action: 'add', type: 'Velocity inlet', name: 'Inlet 2', faces: ['face 5@Body2', 'Face 5@body2'], values: [{ key: 'value', value: '12' }] }));
    assert.equal(r.out.ok, true, JSON.stringify(r.out));
    assert.deepEqual(r.writes.map((w) => [w.path, w.keys]), [['/api/bcs', keys('project_id', 'simulation_id', 'geometry_id', 'name', 'bc_type', 'faces', 'value')]]);
    assert.deepEqual(r.writes[0].body, { value: 12, project_id: 'p1', simulation_id: 's1', geometry_id: 'g1', name: 'Inlet 2', bc_type: 'Velocity inlet', faces: ['face 5@Body2'] });
    assert.deepEqual(synced.at(-1).kinds, ['bcs', 'tree']);
    r = await sent(t(), setup({ kind: 'bc', action: 'add', type: 'Velocity inlet', name: 'Inlet' }));
    assert.deepEqual([r.out.error.code, r.writes], ['invalid_input', []]);
  });
  it("a new Wall's answer says its wall type, and why when the model gave none (seen live: it expected No-slip and found Slip)", async () => {
    fresh();
    let r = await sent(t(), setup({ kind: 'bc', action: 'add', type: 'Wall', name: 'Pipe wall', faces: ['face 1@Body1'] }));
    assert.equal(r.out.data.done, 'Added boundary condition "Pipe wall" (Wall, Slip) on 1 face. It is Slip: a new Wall takes the other wall type than walls with no BC; values wall_type changes it.');
    r = await sent(t(), setup({ kind: 'bc', action: 'add', type: 'Wall', name: 'Wall 2', faces: ['face 1@Body1'], values: [{ key: 'wall_type', value: '"No-slip"' }] }));
    assert.equal(r.out.data.done, 'Added boundary condition "Wall 2" (Wall, No-slip) on 1 face.');
    r = await sent(t(), setup({ kind: 'bc', action: 'add', type: 'Velocity inlet', name: 'Inlet 2', faces: ['face 5@Body2'] }));
    assert.equal(r.out.data.done, 'Added boundary condition "Inlet 2" (Velocity inlet) on 1 face.');
  });
  it('a face two bodies share is refused (inside_face), an unknown face is not_found: nothing written', async () => {
    fresh();
    let r = await sent(t(), setup({ kind: 'bc', action: 'add', type: 'Wall', faces: ['face 3@Body1', 'face 4@Body2'] }));
    assert.equal(r.out.error.code, 'inside_face');
    assert.deepEqual(r.out.error.detail, [
      { face: 'face 3@Body1', shared_with: 'face 4@Body2' },
      { face: 'face 4@Body2', shared_with: 'face 3@Body1' },
    ]);
    assert.match(r.out.error.hint, /inside the model/);
    assert.deepEqual(r.writes, []);
    r = await sent(t(), setup({ kind: 'refinement', action: 'add', other_id: 'm1', type: 'Surface custom sizing', faces: ['face 4@Body2'] }));
    assert.deepEqual([r.out.error.code, r.writes], ['inside_face', []]);
    r = await sent(t(), setup({ kind: 'bc', action: 'add', type: 'Wall', faces: ['face 99@Body1'] }));
    assert.deepEqual([r.out.error.code, r.writes], ['not_found', []]);
  });
  it('bc update / assign / unassign / clear: by id, the stored fields carried, faces merged; base_rev when the record has a rev', async () => {
    fresh();
    app.w.bcs[0].rev = 4;
    let r = await sent(t(), setup({ kind: 'bc', action: 'update', id: 'bc-1', values: [{ key: 'value', value: '7' }] }));
    assert.deepEqual(r.writes[0].body, {
      velocity_type: 'Fixed',
      value: 7,
      unit: 'm/s',
      direction: 'Normal to face',
      project_id: 'p1',
      simulation_id: 's1',
      geometry_id: 'g1',
      id: 'bc-1',
      name: 'Inlet',
      bc_type: 'Velocity inlet',
      faces: ['face 1@Body1'],
      base_rev: 4,
    });
    r = await sent(t(), setup({ kind: 'bc', action: 'assign', id: 'bc-1', faces: ['face 5@Body2'] }));
    assert.deepEqual(r.writes[0].body.faces, ['face 1@Body1', 'face 5@Body2']);
    r = await sent(t(), setup({ kind: 'bc', action: 'unassign', id: 'bc-1', faces: ['face 1'] }));
    assert.deepEqual(r.writes[0].body.faces, []);
    r = await sent(t(), setup({ kind: 'bc', action: 'clear', id: 'bc-2' }));
    assert.deepEqual([r.writes[0].body.faces, r.writes[0].body.bc_type], [[], 'Pressure']);
    // A rev the call read that is no longer the record's: stale, nothing written.
    r = await sent(t(), setup({ kind: 'bc', action: 'update', id: 'bc-1', rev: 3, values: [{ key: 'value', value: '1' }] }));
    assert.deepEqual([r.out.error.code, r.writes], ['stale_record', []]);
  });
  it('bc_defaults update: the wall type only', async () => {
    fresh();
    const r = await sent(t(), setup({ kind: 'bc_defaults', action: 'update', values: [{ key: 'wall_type', value: '"Slip"' }] }));
    assert.deepEqual(r.writes.map((w) => [w.path, w.body]), [['/api/bcs', { project_id: 'p1', simulation_id: 's1', defaults: { wall_type: 'Slip' } }]]);
  });

  it('mesh add / update / activate / rename / restore_defaults / copy_from: always a mesh_id, never an empty body', async () => {
    fresh();
    const cases = [
      [setup({ kind: 'mesh', action: 'add', name: 'Fine' }), [['/api/mesh', { project_id: 'p1', simulation_id: 's1', create: true, name: 'Fine' }]]],
      [
        setup({ kind: 'mesh', action: 'update', id: 'm2', values: [{ key: 'fineness', value: '8' }, { key: 'advanced.gap_refinement_factor', value: '0.1' }] }),
        [['/api/mesh', { fineness: 8, advanced: { gap_refinement_factor: 0.1 }, project_id: 'p1', simulation_id: 's1', mesh_id: 'm2' }]],
      ],
      [setup({ kind: 'mesh', action: 'activate', id: 'm2' }), [['/api/mesh', { project_id: 'p1', simulation_id: 's1', activate: 'm2' }]]],
      [setup({ kind: 'mesh', action: 'rename', id: 'm2', name: 'Coarse' }), [['/api/mesh', { project_id: 'p1', simulation_id: 's1', mesh_id: 'm2', name: 'Coarse' }]]],
      [setup({ kind: 'mesh', action: 'restore_defaults', id: 'm2' }), [['/api/mesh', { project_id: 'p1', simulation_id: 's1', mesh_id: 'm2', use_bank_defaults: true }]]],
      [
        setup({ kind: 'mesh', action: 'copy_from', id: 'm2', other_id: 'm1' }),
        [
          ['/api/mesh', { project_id: 'p1', simulation_id: 's1', mesh_id: 'm2', copy_from: 'm1' }],
          ['/api/mesh/refinements', { project_id: 'p1', simulation_id: 's1', mesh_id: 'm2', copy_from_mesh: 'm1' }],
        ],
      ],
    ];
    for (const [input, want] of cases) {
      const r = await sent(t(), input);
      assert.equal(r.out.ok, true, `${input.action}: ${JSON.stringify(r.out)}`);
      assert.deepEqual(r.writes.map((w) => [w.path, w.body]), want, input.action);
    }
    // An update with nothing to change sends nothing (an empty body restores the defaults).
    const none = await sent(t(), setup({ kind: 'mesh', action: 'update', id: 'm2' }));
    assert.deepEqual([none.out.error.code, none.writes], ['invalid_input', []]);
    // A mesher's own setting goes under mesher_settings, merged with the stored ones.
    app.w.meshes[1].settings.mesher_settings = { keep: 1 };
    const own = await sent(t(), setup({ kind: 'mesh', action: 'update', id: 'm2', values: [{ key: 'fineness', value: '11' }, { key: 'advanced.mesh_engine', value: '"nope"' }] }));
    assert.deepEqual([own.out.error.code, own.out.error.detail.length], ['bad_values', 2]);
  });
  it('mesh add with values: the settings sent with it are saved (seen live: a coarse mesh added with fineness 2 was meshed at the default 5)', async () => {
    fresh();
    let r = await sent(t(), setup({ kind: 'mesh', action: 'add', name: 'Coarse', values: [{ key: 'fineness', value: '2' }] }));
    assert.equal(r.out.ok, true, JSON.stringify(r.out));
    assert.deepEqual(r.writes.map((w) => [w.path, w.body]), [
      ['/api/mesh', { project_id: 'p1', simulation_id: 's1', create: true, name: 'Coarse' }],
      ['/api/mesh', { fineness: 2, project_id: 'p1', simulation_id: 's1', mesh_id: 'm-new', base_rev: 1 }],
    ]);
    assert.match(r.out.summary, /Added mesh "Coarse" with 1 setting/);
    // A value it can't take: the mesh is added with its defaults, and the answer says the values were not saved.
    fresh();
    r = await sent(t(), setup({ kind: 'mesh', action: 'add', name: 'Bad', values: [{ key: 'fineness', value: '40' }] }));
    assert.equal(r.out.error.code, 'bad_values');
    assert.match(r.out.error.hint, /was added \(id m-new\) with its default settings; these values were not saved/);
    assert.deepEqual(r.writes.map((w) => w.body.create === true), [true]);
  });
  it('mesh update on a generated mesh, refinement copy onto a mesh with refinements: they ask first', async () => {
    fresh();
    const ac = { ctx: rt().ctx, signal: new AbortController().signal, turn: 't' };
    const a = await t().escalate(setup({ kind: 'mesh', action: 'update', id: 'm1' }), ac);
    assert.equal(a.risk, 'destructive');
    assert.match(a.note, /^Mesh 1 is generated; changing its settings marks it out of date and it must be generated again\. Run 1 has results/);
    const b = await t().escalate(setup({ kind: 'refinement', action: 'copy_from', id: 'm1', other_id: 'm2' }), ac);
    assert.match(b.note, /Its 1 refinement is replaced by the copied ones\./);
    const c = await t().escalate(setup({ kind: 'geometry', action: 'add_original', id: 'g2' }), ac);
    assert.equal(c.risk, 'compute');
    const d = await t().escalate(setup({ kind: 'geometry', action: 'link_choice', other_id: 'gl-1', type: 'overwrite' }), ac);
    assert.equal(d.note, 'Replaces geometry "Plate" in place; 1 study uses it and keep their setup on matching faces.');
    assert.equal(await t().escalate(setup({ kind: 'mesh', action: 'add' }), ac), null);
    assert.equal(t().gateText(setup({ kind: 'mesh', action: 'update' }), a).title, 'Allow the Assistant to change this mesh?');
  });

  it('refinement add / update / assign / unassign / copy_from: by id or name and mesh, the type\'s fields', async () => {
    fresh();
    let r = await sent(t(), setup({ kind: 'refinement', action: 'add', other_id: 'm1', type: 'Inflate boundary layer', name: 'Walls', faces: ['face 5@Body2'], values: [{ key: 'n_layers', value: '5' }] }));
    assert.deepEqual(r.writes.map((w) => [w.path, w.body]), [
      ['/api/mesh/refinements', { n_layers: 5, project_id: 'p1', simulation_id: 's1', name: 'Walls', type: 'Inflate boundary layer', mesh_id: 'm1', faces: ['face 5@Body2'], faces_explicit: true }],
    ]);
    r = await sent(t(), setup({ kind: 'refinement', action: 'update', id: 'ref-1', values: [{ key: 'default_size', value: '1' }] }));
    assert.deepEqual(r.writes[0].body, {
      sizing: 'Custom',
      default_size: 1,
      default_size_unit: 'mm',
      project_id: 'p1',
      simulation_id: 's1',
      id: 'ref-1',
      name: 'Nose',
      type: 'Surface custom sizing',
      mesh_id: 'm1',
      faces: ['face 1@Body1'],
      faces_explicit: true,
    });
    r = await sent(t(), setup({ kind: 'refinement', action: 'assign', id: 'ref-1', faces: ['face 2'] }));
    assert.deepEqual(r.writes[0].body.faces, ['face 1@Body1', 'face 2@Body1']);
    r = await sent(t(), setup({ kind: 'refinement', action: 'unassign', id: 'ref-1', faces: ['face 1@Body1'] }));
    assert.deepEqual(r.writes[0].body.faces, []);
    r = await sent(t(), setup({ kind: 'refinement', action: 'copy_from', id: 'm2', other_id: 'm1' }));
    assert.deepEqual(r.writes.map((w) => [w.path, w.body]), [['/api/mesh/refinements', { project_id: 'p1', simulation_id: 's1', mesh_id: 'm2', copy_from_mesh: 'm1' }]]);
    r = await sent(t(), setup({ kind: 'refinement', action: 'add', other_id: 'm1', type: 'Surface custom sizing', name: 'Nose' }));
    assert.deepEqual([r.out.error.code, r.writes], ['invalid_input', []]);
  });

  it('run add / update / activate / rename / copy_from: camelCase keys, no `settings`, the transient block merged', async () => {
    fresh();
    let r = await sent(t(), setup({ kind: 'run', action: 'add', name: 'Run 3', values: [{ key: 'mesh_id', value: '"m1"' }] }));
    assert.deepEqual(r.writes.map((w) => [w.path, w.body]), [['/api/run/create', { project_id: 'p1', simulation_id: 's1', name: 'Run 3', mesh_id: 'm1' }]]);
    r = await sent(t(), setup({ kind: 'run', action: 'update', id: 'r2', values: [{ key: 'endTime', value: '300' }, { key: 'cores', value: 'null' }, { key: 'transient.max_co', value: '0.5' }] }));
    assert.deepEqual(r.writes[0].body, { endTime: 300, cores: null, transient: { max_co: 0.5 }, project_id: 'p1', simulation_id: 's1', run_id: 'r2' });
    assert.ok(!('settings' in r.writes[0].body));
    r = await sent(t(), setup({ kind: 'run', action: 'activate', id: 'r2' }));
    assert.deepEqual(r.writes.map((w) => [w.path, w.body]), [['/api/run/activate', { project_id: 'p1', run_id: 'r2', simulation_id: 's1' }]]);
    assert.deepEqual(synced.at(-1).active, { run: 'r2' });
    r = await sent(t(), setup({ kind: 'run', action: 'rename', id: 'r2', name: 'Run B' }));
    assert.deepEqual(r.writes.map((w) => [w.path, w.body]), [['/api/run/rename', { project_id: 'p1', run_id: 'r2', name: 'Run B', simulation_id: 's1' }]]);
    // copy_from builds the run panel's body (runCopyBody.ts): mesh, times, transient, monitors cloned, cores, settle following its monitor.
    r = await sent(t(), setup({ kind: 'run', action: 'copy_from', id: 'r2', other_id: 'r1' }));
    const b = r.writes[0].body;
    assert.deepEqual(Object.keys(b).sort(), keys('mesh_id', 'endTime', 'writeInterval', 'time_dependency', 'transient', 'result_controls', 'cores', 'settle', 'settle_time_dependency', 'project_id', 'simulation_id', 'run_id'));
    assert.deepEqual([b.run_id, b.mesh_id, b.endTime, b.writeInterval, b.time_dependency, b.cores, b.settle_time_dependency], ['r2', 'm1', 200, 50, 'Steady-state', 4, 'Steady-state']);
    assert.equal(b.transient.end_time, 2);
    assert.equal(b.result_controls.length, 1);
    assert.notEqual(b.result_controls[0].id, 'rc-1');
    assert.equal(b.result_controls[0].results, null);
    assert.equal(b.settle.id, b.result_controls[0].id, 'the settle follows its monitor to the copy');
  });

  it('monitor add / update: the run\'s whole list with this one, as the panel makes it; saved_view rename; saving a view is deferred', async () => {
    fresh();
    let r = await sent(t(), setup({ kind: 'monitor', action: 'add', other_id: 'r1', type: 'probe', name: 'Tip', values: [{ key: 'points', value: '[[0,0,1]]' }] }));
    const list = r.writes[0].body.result_controls;
    assert.deepEqual(r.writes.map((w) => [w.path, w.keys]), [['/api/run/update', keys('result_controls', 'project_id', 'simulation_id', 'run_id')]]);
    assert.deepEqual(list.map((x) => x.name), ['Area average 1', 'Tip']);
    const probe = list[1];
    assert.deepEqual([probe.monitor_type, probe.kind, probe.category, probe.points], ['probe', 'Point probe', 'Point data', [[0, 0, 1]]]);
    r = await sent(t(), setup({ kind: 'monitor', action: 'update', other_id: 'r1', id: 'rc-1', faces: ['face 2@Body1'] }));
    assert.deepEqual(r.writes[0].body.result_controls.map((x) => x.faces), [['face 2@Body1']]);
    r = await sent(t(), setup({ kind: 'saved_view', action: 'rename', other_id: 'r1', id: 'v1', name: 'Top' }));
    assert.deepEqual(r.writes[0].body, { views: [{ id: 'v1', name: 'Top' }], project_id: 'p1', simulation_id: 's1', run_id: 'r1' });
    r = await sent(t(), setup({ kind: 'saved_view', action: 'add', other_id: 'r1' }));
    assert.deepEqual([r.out.error.code, r.writes], ['deferred', []]);
  });
  it('a new monitor record is the run panel\'s (src/monitorTargets.ts newMonitorRecord), with its boundaries', async () => {
    const { newMonitorRecord: page } = await import('../../../src/monitorTargets.ts');
    for (const row of REGISTRY.monitor) {
      assert.deepEqual(newMonitorRecord(row, 'rc-x', 'M 1'), page(row, 'rc-x', 'M 1', {}), row.key);
      assert.deepEqual(newMonitorRecord(row, 'rc-x', 'M 1', { boundaries: ['bc-1', '@walls'] }), page(row, 'rc-x', 'M 1', { boundaries: ['bc-1', '@walls'] }), row.key);
    }
  });

  it("a new boundary monitor starts on every boundary it can measure, as the panel's (boundaryChoices): Forces on the walls; one on any boundary on all of them", async () => {
    const { boundaryChoices } = await import('../../../src/monitorTargets.ts');
    const bcs = [
      { id: 'bc-1', name: 'Inlet', bc_type: 'Velocity inlet', faces: ['face 1@Body1'] },
      { id: 'bc-w', name: 'Wing', bc_type: 'No-slip wall', faces: ['face 2@Body1'] },
      { id: 'bc-s', name: 'Flap', bc_type: 'wall', faces: ['face 3@Body1'] },
      { id: 'bc-e', name: 'Empty wall', bc_type: 'Wall', faces: [] },
      { id: 'bc-o', name: 'Out', bc_type: 'Pressure outlet', faces: ['face 4@Body1'] },
    ];
    // The page's family of a record, by its type (src/bcCatalog.ts familyKeyOf over the registry's rows).
    const familyOf = (bc) => ({ 'Velocity inlet': 'velocity_inlet', 'No-slip wall': 'wall', wall: 'wall', Wall: 'wall', 'Pressure outlet': 'pressure_outlet' })[bc.bc_type] ?? '';
    for (const row of REGISTRY.monitor.filter((m) => m.target === 'boundary')) {
      const tokens = monitorBoundaryTokens(bcs, row.boundary_kinds, REGISTRY.bc_family);
      assert.deepEqual(tokens, boundaryChoices(bcs, row.boundary_kinds, familyOf).map((c) => c.token), row.key);
    }
    assert.deepEqual(monitorBoundaryTokens(bcs, ['wall'], REGISTRY.bc_family), ['bc-w', 'bc-s', '@walls']);
    assert.deepEqual(monitorBoundaryTokens(bcs, [], REGISTRY.bc_family), ['bc-1', 'bc-w', 'bc-s', 'bc-o', '@walls']);
    // Through the tool: a Forces monitor the AI adds starts on the study's walls.
    fresh();
    app.w.bcs.push({ id: 'bc-w', name: 'Wing', bc_type: 'Wall', faces: ['face 2@Body1'] }, { id: 'bc-e', name: 'Empty', bc_type: 'Wall', faces: [] });
    let r = await sent(t(), setup({ kind: 'monitor', action: 'add', other_id: 'r1', type: 'forces', name: 'Lift' }));
    assert.equal(r.out.ok, true, JSON.stringify(r.out));
    const forces = r.writes[0].body.result_controls.find((x) => x.name === 'Lift');
    assert.deepEqual(forces.boundaries, ['bc-w', '@walls']);
    // Given boundaries are kept as given.
    r = await sent(t(), setup({ kind: 'monitor', action: 'add', other_id: 'r1', type: 'forces', name: 'Wing only', values: [{ key: 'boundaries', value: '["bc-w"]' }] }));
    assert.deepEqual(r.writes[0].body.result_controls.find((x) => x.name === 'Wing only').boundaries, ['bc-w']);
  });

  it('geometry activate / link_choice / add_original / edit_in_cad', async () => {
    fresh();
    let r = await sent(t(), setup({ kind: 'geometry', action: 'activate', id: 'g2' }));
    assert.deepEqual(r.writes.map((w) => [w.path, w.body]), [['/api/geometry/activate', { project_id: 'p1', geometry_id: 'g2' }]]);
    assert.deepEqual(synced.at(-1).active, { geometry: 'g2' });
    r = await sent(t(), setup({ kind: 'geometry', action: 'link_choice', other_id: 'gl-1', type: 'new', values: [{ key: 'copy', value: '["s3"]' }] }));
    assert.deepEqual(r.writes.map((w) => [w.path, w.body]), [['/api/plugin-geometry/choose', { project_id: 'p1', plugin: 'cad', study_id: 'cs1', job_id: 'gl-1', choice: 'new', copy: ['s3'] }]]);
    r = await sent(t(), setup({ kind: 'geometry', action: 'add_original', id: 'g2' }));
    assert.deepEqual(r.writes.map((w) => [w.path, w.body]), [['/api/geometry/original/import', { project_id: 'p1', geometry_id: 'g2' }]]);
    r = await sent(t(), setup({ kind: 'geometry', action: 'edit_in_cad', id: 'g1' }));
    assert.deepEqual(r.writes.map((w) => [w.path, w.body]), [['/api/geometry-actions/open', { project_id: 'p1', geometry_id: 'g1', plugin: 'cad', study_kind: 'part' }]]);
    assert.match(r.out.data.hint, /core__show \{target:'workspace', id:'cs-edit'\}/);
  });

  it('a linked geometry\'s face-carrying writes send its rev (geometry_rev)', async () => {
    fresh();
    app.w.active_study = 's3';
    const r = await sent(t(), setup({ simulation_id: 's3', kind: 'bc', action: 'add', type: 'Wall', name: 'W', faces: ['face 1'] }), rt({ ctx: { simulationId: 's3' } }));
    assert.equal(r.writes[0].body.geometry_rev, 4);
    assert.equal(r.writes[0].body.geometry_id, 'g2');
  });

  it('writes only to the window\'s project; not offered on Home or in a workspace', async () => {
    fresh();
    const r = await sent(t(), setup({ project_id: 'p3', kind: 'mesh', action: 'add' }));
    assert.deepEqual([r.out.error.code, r.writes], ['not_this_project', []]);
    assert.match(t().available({ tab: 'T1', projectId: 'p1', simulationId: 's1', cloud: true, local: false }), /workspace/);
  });
});

// ------------------------------------------------------------------ a run that ended (runReopen.ts)

describe("setup_edit on a run that ended: the person's rules and words", () => {
  const t = () => setupEditTool(deps());
  const ac = () => ({ ctx: rt().ctx, signal: new AbortController().signal, turn: 't' });
  const stopped = { id: 'r3', name: 'Run 3', status: 'stopped', mesh_id: 'm1', endTime: 100, writeInterval: 50, time_dependency: 'Steady-state', has_results: true, n_saved_times: 2, last_saved_iteration: 100, iteration: 120, n_steps: 120, rev: 4, result_controls: [] };
  const withStopped = (o = {}) => {
    fresh();
    app.w.runs.push({ ...stopped, ...o });
  };

  it("a change of a stopped run's solve settings asks as destructive with the dialog's words, then sends overwrite with the rev it read", async () => {
    withStopped();
    const tool = t();
    const input = setup({ kind: 'run', action: 'update', id: 'r3', values: [{ key: 'endTime', value: '300' }] });
    const a = await tool.escalate(input, ac());
    assert.equal(a.risk, 'destructive');
    assert.equal(
      a.note,
      'Changing this setting starts "Run 3" over. Its results (2 saved, up to iteration 100) are deleted now, and Start solves it again from the beginning. To keep them, cancel and add a run, or use Continue to go on from iteration 100.',
    );
    assert.deepEqual(a.detail, [{ label: 'Run', value: 'Run 3' }]);
    assert.equal(tool.gateText(input, a).title, 'Allow the Assistant to overwrite "Run 3"?');
    const r = await sent(tool, input);
    assert.deepEqual(r.writes[0].body, { endTime: 300, project_id: 'p1', simulation_id: 's1', run_id: 'r3', overwrite: true, base_rev: 4 });
    // copy_from into it asks the same.
    const copy = setup({ kind: 'run', action: 'copy_from', id: 'r3', other_id: 'r1' });
    const c = await tool.escalate(copy, ac());
    assert.equal(c.risk, 'destructive');
    assert.equal(tool.gateText(copy, c).title, 'Allow the Assistant to overwrite "Run 3"?');
  });

  it('asks nothing for a free setting, a draft, or a stopped run with nothing saved, and never sends overwrite then', async () => {
    withStopped();
    const tool = t();
    const cores = setup({ kind: 'run', action: 'update', id: 'r3', values: [{ key: 'cores', value: '2' }] });
    assert.equal(await tool.escalate(cores, ac()), null);
    assert.equal(await tool.escalate(setup({ kind: 'run', action: 'update', id: 'r2', values: [{ key: 'endTime', value: '300' }] }), ac()), null);
    withStopped({ has_results: false, n_saved_times: 0, last_saved_iteration: 0, n_steps: 0, iteration: 0 });
    const quiet = setup({ kind: 'run', action: 'update', id: 'r3', values: [{ key: 'endTime', value: '300' }] });
    assert.equal(await t().escalate(quiet, ac()), null);
    const r = await sent(t(), quiet);
    assert.equal('overwrite' in r.writes[0].body, false);
    // A call that never had the card (the run gained results meanwhile) does not send it either: the route refuses, and asking again shows the card.
    withStopped();
    const unasked = await sent(t(), setup({ kind: 'run', action: 'update', id: 'r3', values: [{ key: 'endTime', value: '300' }] }));
    assert.equal('overwrite' in unasked.writes[0].body, false);
  });

  it("a finished run's solve settings are refused with the person's words and the one call that makes a new run; nothing is written", async () => {
    fresh();
    const tool = t();
    const input = setup({ kind: 'run', action: 'update', id: 'r1', values: [{ key: 'endTime', value: '300' }] });
    assert.equal(await tool.escalate(input, ac()), null, 'nothing is asked for what is refused');
    const r = await sent(tool, input);
    assert.deepEqual([r.out.error.code, r.writes], ['run_finished', []]);
    assert.equal(r.out.error.message, '"Run 1" has finished and its results stay as they are: a change of its settings goes to a new run with the same settings.');
    assert.equal(
      r.out.error.hint,
      `setup_edit {kind:'run', action:'add', other_id:'r1', values:[{"key":"endTime","value":"300"}]} makes the next run with the settings of "Run 1" and these changes; "Run 1" keeps its results.`,
    );
    // Its free settings still save (a monitor, a name).
    const named = await sent(tool, setup({ kind: 'run', action: 'update', id: 'r1', values: [{ key: 'cores', value: '2' }] }));
    assert.equal(named.out.ok, true, JSON.stringify(named.out));
  });

  it('add with other_id: the next run with that run\'s settings and the changes, in one call; the finished run untouched', async () => {
    fresh();
    const r = await sent(t(), setup({ kind: 'run', action: 'add', other_id: 'r1', values: [{ key: 'endTime', value: '300' }] }));
    assert.equal(r.out.ok, true, JSON.stringify(r.out));
    assert.deepEqual(r.writes.map((w) => w.path), ['/api/run/create', '/api/run/update']);
    assert.deepEqual(r.writes[0].body, { project_id: 'p1', simulation_id: 's1', name: '', mesh_id: 'm1' });
    const b = r.writes[1].body;
    assert.deepEqual([b.run_id, b.mesh_id, b.endTime, b.writeInterval, b.time_dependency, b.cores], ['r-new', 'm1', 300, 50, 'Steady-state', 4]);
    assert.equal(b.result_controls.length, 1);
    assert.notEqual(b.result_controls[0].id, 'rc-1');
    assert.equal(r.out.data.done, 'Added run "Run 3" with the settings of "Run 1" and endTime changed.');
    assert.equal(r.writes.some((w) => w.body && w.body.run_id === 'r1'), false, 'the finished run is not written');
    assert.deepEqual(synced.at(-1).kinds, ['runs', 'tree']);
  });

  it('read_setup says what a change of each run does (settings)', async () => {
    withStopped();
    const { readSetupTool } = await import('../assistant/host/read-setup.ts');
    const read = readSetupTool(deps());
    const out = await read.run({ project_id: '', simulation_id: '', what: 'runs', id: '', other_id: '', page: 0 }, rt());
    assert.deepEqual(out.data.runs.map((r) => [r.id, r.settings]), [
      ['r1', 'new_run'],
      ['r2', 'editable'],
      ['r3', 'overwrites'],
    ]);
    const one = await read.run({ project_id: '', simulation_id: '', what: 'run', id: 'r3', other_id: '', page: 0 }, rt());
    assert.equal(one.data.settings, 'overwrites');
  });
});
