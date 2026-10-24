// The read host tools against a stand-in for the app (Core host tools spec 4.1-4.7, 16.1):
// catalog (every kind, and a key's fields), projects (Home's filters; the list sent to a
// cloud provider only when allowed), project_summary (another project's consent; its
// picture), read_setup (every what; inside faces marked; no path in any answer) and
// read_results (every kind; the case folder passed to the results routes and never
// returned; the server-wide attached case never set).
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-host-reads-'));
process.env.MAGNUSIM_PROJECTS_ROOT = join(ROOT, 'projects');
process.env.MAGNUSIM_LOCAL_JSON = join(ROOT, 'local.json');
process.env.MAGNUSIM_ASSISTANT_HOME = join(ROOT, 'home');

const { createHostTools } = await import('../assistant/host-tools.ts');
const { createHostTransport } = await import('../assistant/host-call.ts');
const { paced } = await import('../assistant/host/common.ts');
const { resultText } = await import('../assistant/sanitize.ts');
const { startFakeApp, makeRt, pathFree, world, WIN } = await import('./assistant-host-harness.js');

let app;
// The calls' rate runs on this clock: a call that waits for its slot moves it on, never the test's time.
let fakeNow = 0;
before(async () => {
  app = await startFakeApp();
});
after(async () => {
  await app.stop();
  rmSync(ROOT, { recursive: true, force: true });
});

function tools(o = {}) {
  const list = createHostTools({
    hostCall: paced(createHostTransport({ port: () => app.port, now: () => fakeNow }).call, async (ms) => { fakeNow += ms; }),
    assistant: async () => ({ provider: 'anthropic', model: 'm' }),
    version: async () => '0.5.0',
    plugins: () => [],
    assistantSettings: async () => ({ effort: 'default', privacy: o.privacy ?? 'ask', caps: { turn_usd: 8 } }),
    spentToday: async () => 1.234,
    ...o,
  });
  return Object.fromEntries(list.map((t) => [t.name, t]));
}
const rt = makeRt;
const fresh = () => {
  app.w = Object.assign(app.w, world());
  app.over = null;
};
async function ok(tool, input, r = rt()) {
  const out = await tools()[tool].run(input, r);
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.ok(pathFree(out.data), `${tool}: a path in ${resultText(tool, out)}`);
  return out.data;
}

describe('app_status', () => {
  it('the Assistant\'s own settings read only, today\'s spend, hardware and units; nothing writes them', async () => {
    fresh();
    const d = await ok('app_status', {});
    assert.deepEqual(d.assistant, { provider: 'anthropic', model: 'm', effort: 'default', privacy: 'ask', caps: { turn_usd: 8 }, spent_today_usd: 1.23, can_change_these: false });
    assert.deepEqual(d.hardware, { cores: 8, ram_gb: 32, openfoam: 'ok', checked_at: '2026-10-20T10:00:00Z' });
    assert.equal(d.units, 'Metric');
    assert.deepEqual(d.plugins.map((p) => [p.key, p.on, p.env]), [
      ['cad', true, 'none'],
      ['heat_transfer', false, 'ready'],
    ]);
    // Another project's queued run: its kind and place only.
    assert.deepEqual(d.compute.queue, [{ kind: 'solve', mine: false, position: 1 }]);
    assert.equal(d.where, 'workbench');
  });
  it("this turn's spend and caps so far, read when asked (read-only; none outside a turn)", async () => {
    fresh();
    let use = { steps: 4, steps_cap: 120, minutes: 2.1, minutes_cap: 60, usd: 0.12, usd_cap: 8 };
    const r = rt({ ctx: { used: () => use } });
    let d = await ok('app_status', {}, r);
    assert.deepEqual(d.assistant.this_turn, { steps: 4, steps_cap: 120, minutes: 2.1, minutes_cap: 60, usd: 0.12, usd_cap: 8 });
    assert.equal(d.assistant.can_change_these, false);
    use = { ...use, steps: 5 };
    d = await ok('app_status', {}, r);
    assert.equal(d.assistant.this_turn.steps, 5, 'read at the call, not when the turn began');
    d = await ok('app_status', {}, rt({ ctx: { used: () => { throw new Error('gone'); } } }));
    assert.equal(d.assistant.this_turn, undefined);
  });
});

describe('catalog', () => {
  const cat = (kind, key = '') => ok('catalog', { kind, key });
  it('every kind lists; a key gives that item\'s fields', async () => {
    fresh();
    const a = await cat('analyses');
    assert.ok(a.analyses.some((x) => x.key === 'incompressible_steady'));
    const one = await cat('analyses', 'incompressible_steady');
    assert.ok(one.settings.some((f) => f.key === 'turbulence_model' && f.enum.includes('kOmegaSST')));
    assert.ok(one.run_settings.some((f) => f.key === 'endTime'));
    assert.ok(one.run_settings.some((f) => f.key === 'transient.end_time' && f.unit === 's'));
    const bc = await cat('bc_types');
    assert.ok(bc.types.some((t) => t.type === 'Velocity inlet'));
    assert.deepEqual(bc.menu[0].key, 'inlet');
    const inlet = await cat('bc_types', 'Velocity inlet');
    assert.ok(inlet.fields.some((f) => f.key === 'velocity_type'));
    assert.ok(inlet.units.some((u) => u.field === 'value' && u.unit_field === 'unit'));
    const mats = await cat('materials');
    assert.ok(mats.presets.some((p) => p.key === 'air'));
    const air = await cat('materials', 'air');
    assert.deepEqual([air.model, air.values.rho], ['newtonian_incompressible', 1.204]);
    assert.ok((await cat('meshers')).meshers.some((m) => m.key === 'standard'));
    const ms = await cat('mesh_settings', 'standard');
    assert.ok(ms.fields.some((f) => f.key === 'advanced.mesh_engine' && f.enum.includes('cfmesh')));
    assert.deepEqual((await cat('refinement_types')).types, ['Surface custom sizing', 'Inflate boundary layer']);
    assert.ok((await cat('refinement_types', 'Inflate boundary layer')).fields.some((f) => f.key === 'n_layers'));
    assert.ok((await cat('monitors')).monitors.some((m) => m.key === 'probe' && m.target === 'point'));
    assert.match((await cat('monitors', 'probe')).places, /points/);
    assert.ok((await cat('filters')).filters.some((f) => f.key === 'cut_plane'));
    assert.ok((await cat('filters', 'cut_plane')).fields.length > 0);
    assert.deepEqual((await cat('study_kinds')).study_kinds.map((k) => [k.plugin, k.key, k.edits_geometry]), [
      ['cad', 'part', false],
      ['cad', 'part', true],
    ]);
    assert.deepEqual((await cat('start_actions')).start_actions.map((k) => k.key), ['part']);
    assert.deepEqual((await cat('samples')).samples.map((k) => [k.plugin, k.key]), [['cad', 'bracket']]);
    assert.deepEqual((await cat('plugins')).plugins.map((p) => [p.key, p.on]), [
      ['cad', true],
      ['heat_transfer', false],
    ]);
  });
  it('an unknown key is not_found, with the way to list', async () => {
    const out = await tools().catalog.run({ kind: 'analyses', key: 'nope' }, rt());
    assert.deepEqual([out.ok, out.error.code], [false, 'not_found']);
    assert.match(out.error.hint, /catalog/);
  });
});

describe('projects', () => {
  it("Home's filters: folder, search over title and description, sort, limit; never the projects folder", async () => {
    fresh();
    const r = rt({ ctx: { cloud: false, local: true } });
    const all = await tools().projects.run({ folder: '', search: '', sort: 'modified', limit: 0 }, r);
    assert.deepEqual(all.data.projects.map((p) => p.id), ['p2', 'p1', 'p3']);
    assert.deepEqual(all.data.folders, ['My Projects', 'Aero']);
    assert.ok(!JSON.stringify(all).includes('thumb') && !JSON.stringify(all).includes(WIN));
    const aero = await tools().projects.run({ folder: 'Aero', search: '', sort: 'name', limit: 0 }, r);
    assert.deepEqual(aero.data.projects.map((p) => p.title), ['Duct', 'Wing']);
    const found = await tools().projects.run({ folder: '', search: 'TUNNEL', sort: 'name', limit: 0 }, r);
    assert.deepEqual(found.data.projects.map((p) => p.id), ['p1']);
    const one = await tools().projects.run({ folder: '', search: '', sort: 'name', limit: 1 }, r);
    assert.deepEqual([one.data.projects.length, one.data.total], [1, 3]);
  });
  it('names the project list for its privacy question: the runner asks it once per destination before the call', async () => {
    assert.equal(tools().projects.projectOf({}, rt().ctx), '*projects');
    // Reached here, the runner allowed it.
    const sent = await tools().projects.run({ folder: '', search: '', sort: 'name', limit: 0 }, rt());
    assert.equal(sent.ok, true);
  });
});

describe('project_summary', () => {
  it('another project is named for its own privacy question (the runner asks it first); this one is read as is', async () => {
    fresh();
    const other = await tools().project_summary.run({ project_id: 'p2', with_thumbnail: false }, rt());
    assert.equal(other.ok, true);
    assert.equal(tools().project_summary.projectOf({ project_id: 'p2' }, rt().ctx), 'p2');
    assert.equal(tools().project_summary.projectOf({ project_id: '' }, rt().ctx), 'p1');
    const mine = await ok('project_summary', { project_id: '', with_thumbnail: false });
    assert.deepEqual(mine.geometries.map((g) => [g.id, g.linked, g.active]), [
      ['g1', false, true],
      ['g2', true, false],
    ]);
    assert.deepEqual(mine.plugin_studies, [{ id: 'cs1', plugin: 'cad', kind: 'part', title: 'Plate' }]);
  });
  it('with_thumbnail: the picture as an image; a picture still being made is "not ready"', async () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    app.w.thumb = png;
    const out = await tools().project_summary.run({ project_id: '', with_thumbnail: true }, rt());
    assert.equal(out.images.length, 1);
    assert.deepEqual([out.images[0].mediaType, out.images[0].width], ['image/png', 1]);
    app.w.thumb = null;
    const later = await tools().project_summary.run({ project_id: '', with_thumbnail: true }, rt());
    assert.equal(later.images, undefined);
    assert.equal(later.data.thumbnail, 'not ready');
  });
});

describe('read_setup', () => {
  const read = (what, more = {}) => ok('read_setup', { project_id: '', simulation_id: '', what, id: '', other_id: '', page: 0, ...more });
  it('every what, as the panels show it, no path anywhere', async () => {
    fresh();
    const study = await read('study');
    assert.deepEqual([study.id, study.analysis, study.settings.turbulence_model, study.active], ['s1', 'incompressible_steady', 'kOmegaSST', true]);
    const mats = await read('materials');
    assert.deepEqual(mats.materials[0], { id: 'mat-1', name: 'Air', preset: 'air', material_model: 'newtonian_incompressible', role: 'fluid', properties: { nu: 1.5e-5, rho: 1.2 }, bodies: ['Body1'] });
    const bcs = await read('bcs');
    assert.deepEqual(bcs.bcs[0], { id: 'bc-1', name: 'Inlet', type: 'Velocity inlet', faces: ['face 1@Body1'], values: { velocity_type: 'Fixed', value: 5, unit: 'm/s', direction: 'Normal to face' } });
    assert.deepEqual(bcs.defaults, { wall_type: 'No-slip' });
    const meshes = await read('meshes');
    assert.deepEqual(meshes.meshes.map((m) => [m.id, m.engine, m.generated.status, m.generated.cells, m.active]), [
      ['m1', 'standard', 'done', 1200, true],
      ['m2', 'cfmesh', 'not generated', null, false],
    ]);
    const mesh = await read('mesh', { id: 'm1' });
    assert.deepEqual([mesh.settings.fineness, mesh.settings['advanced.mesh_engine'], mesh.settings.automatic_boundary_layers], [5, 'standard', true]);
    const refs = await read('refinements', { id: 'm1' });
    assert.deepEqual(refs.refinements[0].values, { sizing: 'Custom', default_size: 2, default_size_unit: 'mm' });
    assert.deepEqual((await read('refinements', { id: 'm2' })).refinements, []);
    const runs = await read('runs');
    assert.deepEqual(runs.runs.map((r) => [r.id, r.status, r.active]), [
      ['r1', 'done', true],
      ['r2', 'draft', false],
    ]);
    const run = await read('run', { id: 'r1' });
    assert.deepEqual([run.endTime, run.cores, run.monitors[0].type, run.views[0].name, run.has_results], [200, 4, 'area_average', 'Side', true]);
    const geom = await read('geometry');
    assert.deepEqual([geom.id, geom.bodies, geom.faces, geom.inside_faces, geom.linked, geom.geometry_rev], ['g1', 2, 5, 2, false, null]);
    const linkedGeom = await read('geometry', { id: 'g2' });
    assert.deepEqual([linkedGeom.linked, linkedGeom.geometry_rev], [true, 4]);
    const bodies = await read('bodies');
    assert.deepEqual(bodies.bodies, [
      { name: 'Body1', index: 1 },
      { name: 'Body2', index: 2, label: 'Core' },
    ]);
    const faces = await read('faces');
    assert.equal(faces.total, 5);
    assert.deepEqual(faces.faces[0], { id: 'face 1@Body1', name: 'Inlet face', body: 'Body1', area: 1, normal: [1, 0, 0], centroid: [0, 0, 0], surface: 'Plane', inside: false });
    assert.deepEqual([faces.faces[2].inside, faces.faces[2].shared_with], [true, 'face 4@Body2']);
    const map = await read('face_map', { other_id: 'g2' });
    assert.deepEqual(map.map, { 'face 1@Body1': 'face 1@Body1' });
    const lost = await read('lost_faces', { id: 'g2' });
    assert.deepEqual(lost.entries[0], { study_id: 's3', study: 'Plate flow', kind: 'bc', id: 'bc-9', name: 'Wall', field: 'faces', faces: ['face 7@Body1'], reason: 'gone' });
    const linked = await read('linked');
    assert.deepEqual(linked.linked, [{ geometry_id: 'g2', name: 'Plate', plugin: 'cad', study_id: 'cs1', state: 'lost_faces', lost: 1, rev: 4 }]);
    const ps = await read('plugin_study', { id: 'cs1' });
    assert.deepEqual([ps.plugin, ps.rev, ps.available], ['cad', 3, true]);
  });
  it('faces page by 200; a preview still being made is waited for; an unknown id is not_found', async () => {
    fresh();
    app.w.meta.g1.faces = Array.from({ length: 450 }, (_, i) => ({ id: i + 1, body: 1, area: 1 }));
    const p2 = await read('faces', { page: 2 });
    assert.deepEqual([p2.faces.length, p2.faces[0].id, p2.next_page], [50, 'face 401@Body1', undefined]);
    assert.equal((await read('faces', { page: 0 })).next_page, 1);
    let calls = 0;
    app.over = (m, path) => (path === '/api/geometry/cad' && (calls += 1) < 3 ? { status: 202, body: { ok: false, pending: true, code: 'preview_pending' } } : undefined);
    const labels = [];
    const waited = await tools().read_setup.run({ project_id: '', simulation_id: '', what: 'bodies', id: '', other_id: '', page: 0 }, rt({ progress: (_f, l) => labels.push(l) }));
    assert.equal(waited.ok, true);
    assert.deepEqual(labels, ["Waiting for the geometry's preview", "Waiting for the geometry's preview"]);
    app.over = null;
    const none = await tools().read_setup.run({ project_id: '', simulation_id: '', what: 'mesh', id: 'm9', other_id: '', page: 0 }, rt());
    assert.equal(none.error.code, 'not_found');
    const study = await tools().read_setup.run({ project_id: '', simulation_id: 's9', what: 'bcs', id: '', other_id: '', page: 0 }, rt());
    assert.equal(study.error.code, 'not_found');
  });
  it('project_id always passed; the study the call names, else the shown one', async () => {
    fresh();
    const from = app.seen.length;
    await read('bcs', { simulation_id: 's2' });
    const bcs = app.seen.slice(from).find((r) => r.path === '/api/bcs');
    assert.deepEqual([bcs.query.project_id, bcs.query.simulation_id], ['p1', 's2']);
    for (const r of app.seen.slice(from)) if (r.path !== '/api/registry' && r.path !== '/api/projects') assert.equal(r.query.project_id, 'p1', r.path);
  });
});

describe('read_results', () => {
  const res = (kind, more = {}) => ok('read_results', { project_id: '', simulation_id: '', run_id: '', kind, field: '', time: -1, points: [], samples: 0, filter_key: '', values: [], ...more });
  it('every kind; the case goes to the results routes and never comes back; /api/case/attach is never called', async () => {
    fresh();
    const from = app.seen.length;
    const st = await res('status');
    assert.deepEqual([st.run_id, st.status, st.iteration, st.end, st.cores, st.has_results], ['r1', 'done', 200, 200, 4, true]);
    const resid = await res('residuals');
    assert.equal(resid.series.Ux.length, 200);
    assert.deepEqual(resid.last, { Ux: 1 / 300, p: 2 / 300 });
    const mon = await res('monitors');
    assert.equal(mon.monitors[0].rows.length, 200);
    const times = await res('times');
    assert.deepEqual(times.times, ['50', '100', '150', '200']);
    const range = await res('field_range', { field: 'p' });
    assert.deepEqual(range, { field: 'p', time: '200', min: -1, max: 2, mean: 0.5, unit: 'Pa', over_all_times: { min: -3, max: 4 } });
    const pts = await res('point', { field: 'p', points: [[0, 0, 0], [1, 1, 1]] });
    assert.deepEqual(pts.points[0], { x: 0, y: 0, z: 0, values: { p: 1.5, U: [1, 0, 0] }, inside: true });
    const line = await res('line', { field: 'p', points: [[0, 0, 0], [1, 0, 0]], samples: 50 });
    assert.deepEqual(line.samples[1], { s: 0.5, x: 0.5, y: 0, z: 0, value: 2 });
    const filt = await res('plugin_filter', { filter_key: 'cut_plane', values: [{ key: 'orientation', value: '"X"' }] });
    assert.deepEqual(filt.answer, { ok: true, value: 3, label: 'ok' });
    const media = await res('media');
    assert.deepEqual(media.items, [{ id: 'md1', kind: 'screenshot', name: 'Side', width: 800, height: 600, duration_s: null, created_at: null }]);
    assert.deepEqual((await res('exports')).exports, []);
    const reqs = app.seen.slice(from);
    assert.ok(!reqs.some((r) => r.path === '/api/case/attach'));
    const caseReads = reqs.filter((r) => ['/api/times', '/api/fields/p/meta', '/api/inspect', '/api/plot-over-path', '/api/fields/p/series-range'].includes(r.path) || r.path.startsWith('/api/filter/'));
    assert.ok(caseReads.length >= 6);
    for (const r of caseReads) assert.deepEqual([r.query.case, r.query.project_id], [`${WIN}\\p1\\s1\\r1`, 'p1'], r.path);
    const line2 = reqs.find((r) => r.path === '/api/plot-over-path');
    assert.deepEqual([line2.query.points, line2.query.subdivisions, line2.query.time], ['0,0,0;1,0,0', '50', '200']);
    const filter = reqs.find((r) => r.path === '/api/filter/cut_plane');
    assert.equal(filter.query.orientation, 'X');
  });
  it('a run with no results says so; a time not saved, a bad value, a missing run are refused', async () => {
    fresh();
    const draft = await tools().read_results.run({ project_id: '', simulation_id: '', run_id: 'r2', kind: 'times', field: '', time: -1, points: [], samples: 0, filter_key: '', values: [] }, rt());
    assert.deepEqual([draft.error.code, draft.error.message], ['no_results', 'Run 2 has no results yet; its status is draft.']);
    const notSaved = await tools().read_results.run({ project_id: '', simulation_id: '', run_id: '', kind: 'field_range', field: 'p', time: 75, points: [], samples: 0, filter_key: '', values: [] }, rt());
    assert.equal(notSaved.error.code, 'not_found');
    const bad = await tools().read_results.run({ project_id: '', simulation_id: '', run_id: '', kind: 'plugin_filter', field: '', time: -1, points: [], samples: 0, filter_key: 'cut_plane', values: [{ key: 'orientation', value: '"Q"' }, { key: 'nope', value: '1' }] }, rt());
    assert.equal(bad.error.code, 'bad_values');
    assert.equal(bad.error.detail.length, 2);
    const gone = await tools().read_results.run({ project_id: '', simulation_id: '', run_id: 'r9', kind: 'status', field: '', time: -1, points: [], samples: 0, filter_key: '', values: [] }, rt());
    assert.equal(gone.error.code, 'not_found');
  });
  it('transient_preview: the transient.* values checked, then a read of the preview', async () => {
    fresh();
    const from = app.seen.length;
    await res('transient_preview', { values: [{ key: 'transient.max_co', value: '0.8' }] });
    const req = app.seen.slice(from).find((r) => r.path === '/api/run/transient-preview');
    assert.deepEqual(req.body, { project_id: 'p1', run_id: 'r1', simulation_id: 's1', transient: { max_co: 0.8 } });
  });
});
