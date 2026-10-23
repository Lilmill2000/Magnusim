// The delete host tool against a stand-in for the app (Core host tools spec 4.15, 14.2): every
// kind reads its target first, sends exactly one named body (a BC and a refinement by their id
// string, never {delete:true}; a material always with material_id; a generated mesh through
// POST /api/mesh {delete_generated}), and its question names what goes with it. A project or a
// folder goes by id from anywhere; the rest only in the window's project.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-host-delete-'));
process.env.MAGNUSIM_PROJECTS_ROOT = join(ROOT, 'projects');
process.env.MAGNUSIM_LOCAL_JSON = join(ROOT, 'local.json');
process.env.MAGNUSIM_ASSISTANT_HOME = join(ROOT, 'home');

const { createHostTransport } = await import('../assistant/host-call.ts');
const { paced } = await import('../assistant/host/common.ts');
const { deleteTool, DELETE_KINDS } = await import('../assistant/host/delete.ts');
const { startFakeApp, makeRt, world } = await import('./assistant-host-harness.js');

let app;
// The calls' pacing runs on this clock: a call that waits for its slot moves it on.
let fakeNow = 0;
const synced = [];
before(async () => {
  app = await startFakeApp();
});
after(async () => {
  await app.stop();
  rmSync(ROOT, { recursive: true, force: true });
});

const tool = () =>
  deleteTool({
    hostCall: paced(createHostTransport({ port: () => app.port, now: () => fakeNow }).call, async (ms) => { fakeNow += ms; }),
    assistant: async () => ({ provider: 'anthropic', model: 'm' }),
    version: async () => '0',
    plugins: () => [],
    uiSync: { emit: (e) => synced.push(e) },
  });
const del = (kind, id, sub_id = '', o = {}) => ({ project_id: '', simulation_id: '', kind, id, sub_id, ...o });
const fresh = () => {
  Object.assign(app.w, world());
  app.over = null;
  synced.length = 0;
};
const ac = (ctx = {}) => ({ ctx: makeRt({ ctx }).ctx, signal: new AbortController().signal, turn: 't' });

async function run(input, r = makeRt()) {
  const from = app.seen.length;
  const out = await tool().run(input, r);
  return { out, writes: app.writes(from).map((w) => [w.path, w.body]) };
}

/** kind, id, sub_id, the one body sent, the card's knock-on line. */
const CASES = [
  ['project', 'p1', '', ['/api/project/delete', { project_id: 'p1' }], 'Deletes the project and everything in it: 2 geometries, 3 studies, their meshes, runs and results.'],
  ['folder', 'Aero', '', ['/api/folders', { delete: true, name: 'Aero' }], 'Deletes these projects and everything in them.'],
  ['geometry', 'g1', '', ['/api/geometry/remove', { project_id: 'p1', geometry_id: 'g1' }], 'Its 2 studies go too: "Cruise" and "Climb", with their meshes, runs and results.'],
  ['study', 's2', '', ['/api/simulation/delete', { project_id: 'p1', simulation_id: 's2' }], 'Its 2 meshes and 2 runs, with their results, go too.'],
  ['plugin_study', 'cs1', '', ['/api/plugin-studies/delete', { project_id: 'p1', plugin: 'cad', study_id: 'cs1' }], 'Its design and history go. Geometries already sent to the simulation stay.'],
  ['mesh_generated', 'm1', '', ['/api/mesh', { project_id: 'p1', simulation_id: 's1', mesh_id: 'm1', delete_generated: true }], "Run 1 and Run 2 can't run again until it is generated again."],
  ['mesh', 'm2', '', ['/api/mesh', { project_id: 'p1', simulation_id: 's1', mesh_id: 'm2', delete_record: true }], 'Its settings, 0 refinements and generated mesh go; its queued jobs leave the queue.'],
  ['refinement', 'ref-1', '', ['/api/mesh/refinements', { project_id: 'p1', simulation_id: 's1', delete: 'ref-1' }], "Its 1 face go back to the mesh's own sizing."],
  ['run', 'r2', '', ['/api/run/delete', { project_id: 'p1', simulation_id: 's1', run_id: 'r2' }], 'Its settings go.'],
  ['material', 'mat-2', '', ['/api/materials', { delete: true, project_id: 'p1', simulation_id: 's1', geometry_id: 'g1', material_id: 'mat-2' }], 'Body2 has no material then.'],
  ['bc', 'bc-1', '', ['/api/bcs', { project_id: 'p1', simulation_id: 's1', delete: 'bc-1' }], 'Face 1 becomes unassigned.'],
  ['monitor', 'rc-1', 'r1', ['/api/run/update', { result_controls: [], project_id: 'p1', simulation_id: 's1', run_id: 'r1' }], 'It goes from "Run 1", with what it recorded.'],
  ['saved_view', 'v1', 'r1', ['/api/run/update', { views: [], project_id: 'p1', simulation_id: 's1', run_id: 'r1' }], 'It goes from "Run 1".'],
  ['media', 'md1', 'run-r1', ['/api/media/delete', { project_id: 'p1', simulation_id: 's1', owner: 'run-r1', id: 'md1' }], 'It goes from the gallery.'],
  ['lost_faces', 'g2', '', ['/api/geometry/lost-faces/forget', { project_id: 'p1', geometry_id: 'g2', geometry_rev: 4 }], 'The 1 entry that lost faces stop showing; their records keep the faces they still have.'],
];

describe('delete: every kind', () => {
  it('covers every kind of the schema', () => {
    assert.deepEqual(CASES.map((c) => c[0]).sort(), [...DELETE_KINDS].sort());
  });
  for (const [kind, id, sub, body, note] of CASES) {
    it(`${kind}: reads it first, sends one named body, names what goes`, async () => {
      fresh();
      const a = await tool().escalate(del(kind, id, sub), ac());
      assert.deepEqual([a.risk, a.note], ['destructive', note]);
      const { out, writes } = await run(del(kind, id, sub));
      assert.equal(out.ok, true, JSON.stringify(out));
      assert.deepEqual(writes, [body]);
      if (body[1].delete !== undefined && body[0] !== '/api/materials' && body[0] !== '/api/folders') assert.equal(typeof body[1].delete, 'string', 'never {delete:true}');
      assert.ok(synced.length === 1, 'the window hears it');
    });
  }
  it('a target that is not there is not_found, nothing written', async () => {
    fresh();
    for (const [kind, sub] of [['geometry', ''], ['study', ''], ['bc', ''], ['material', ''], ['mesh', ''], ['refinement', ''], ['run', ''], ['monitor', 'r1'], ['media', 'run-r1'], ['plugin_study', ''], ['project', ''], ['folder', '']]) {
      const { out, writes } = await run(del(kind, 'nope', sub));
      assert.deepEqual([out.error.code, writes], ['not_found', []], kind);
    }
  });
  it('the cards: a folder lists its projects; a geometry its studies (at most 6 rows)', async () => {
    fresh();
    const t = tool();
    const folder = del('folder', 'Aero');
    const f = await t.escalate(folder, ac());
    assert.deepEqual(f.detail, [
      { label: 'Project', value: 'Wing' },
      { label: 'Project', value: 'Duct' },
    ]);
    assert.equal(t.gateText(folder, f).title, 'Allow the Assistant to delete folder "Aero" and its 2 projects?');
    const geometry = del('geometry', 'g1');
    const g = await t.escalate(geometry, ac());
    assert.deepEqual(g.detail.map((r) => r.value), ['Cruise', 'Climb']);
    assert.deepEqual(t.gateText(geometry, g), {
      title: 'Allow the Assistant to remove geometry "Wing"?',
      copy: 'Its 2 studies go too: "Cruise" and "Climb", with their meshes, runs and results.',
      detail: g.detail,
    });
    const bc = del('bc', 'bc-1');
    assert.equal(t.gateText(bc, await t.escalate(bc, ac())).title, 'Allow the Assistant to delete boundary condition "Inlet"?');
    // Asked without its escalation (a card for an input not assessed): the kind, generically.
    assert.equal(t.gateText(del('bc', 'bc-1'), null).title, 'Allow the Assistant to delete this bc?');
  });
  it('a study whose mesh or run is in the queue is refused (busy)', async () => {
    fresh();
    app.w.queue = { ok: true, items: [{ id: 'q-2', kind: 'mesh', project_id: 'p1', mesh_id: 'm1', simulation_id: 's1', position: 1 }], live: null };
    const { out, writes } = await run(del('study', 's1'));
    assert.deepEqual([out.error.code, writes], ['busy', []]);
  });
  it('from Home a project or a folder only; the rest only in the window\'s project', async () => {
    fresh();
    const home = makeRt({ ctx: { projectId: null, simulationId: null } });
    let r = await run(del('project', 'p2'), home);
    assert.deepEqual(r.writes, [['/api/project/delete', { project_id: 'p2' }]]);
    r = await run(del('bc', 'bc-1'), home);
    assert.deepEqual([r.out.error.code, r.writes], ['no_project', []]);
    r = await run(del('bc', 'bc-1', '', { project_id: 'p2' }));
    assert.deepEqual([r.out.error.code, r.writes], ['not_this_project', []]);
  });
  it('one lost-face entry, by kind:id:field', async () => {
    fresh();
    const r = await run(del('lost_faces', 'g2', 'bc:bc-9:faces'));
    assert.deepEqual(r.writes, [
      ['/api/geometry/lost-faces/forget', { project_id: 'p1', geometry_id: 'g2', geometry_rev: 4, study_id: 's3', kind: 'bc', id: 'bc-9', entry: { field: 'faces', old: ['face 7@Body1'] } }],
    ]);
  });
});
