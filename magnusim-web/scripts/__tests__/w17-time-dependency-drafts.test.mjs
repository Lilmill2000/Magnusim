import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

// A study's time-dependency change re-saves its draft runs in the route (Core host tools
// spec 4.16): POST /api/simulation/update with time_dependency carries every draft run of
// that study with it, so the page and the Assistant change a study the same way. A run
// that started keeps what it solved with; another study's drafts are not touched.
const root = mkdtempSync(join(tmpdir(), 'cfd-w17-drafts-'));
process.env.MAGNUSIM_PROJECTS_ROOT = root;
process.env.MAGNUSIM_LOCAL_JSON = join(root, 'local.json');

const { createGeometryFolder, writeJsonAtomic } = await import('../project-layout.js');
const { handleW17Api } = await import('../w17-simulation.js');
const { createDraftRun, getRunStatus, patchRunDocIfPresent } = await import('../w27-solve.js');

after(() => rmSync(root, { recursive: true, force: true }));

function seedProject(projectId) {
  const dir = join(root, projectId);
  mkdirSync(dir, { recursive: true });
  writeJsonAtomic(join(dir, 'project.json'), { id: projectId, title: projectId, active_geometry_id: 'geom-1', geometries: [{ id: 'geom-1', name: 'Box' }] });
  createGeometryFolder(dir, { id: 'geom-1', name: 'Box', original_filename: 'box.step' });
}

async function post(sub, body) {
  const out = {};
  const parts = ['api', 'simulation', ...(sub ? [sub] : [])];
  await handleW17Api({ method: 'POST' }, { setHeader() {} }, new URL(`http://x/api/simulation${sub ? `/${sub}` : ''}`), parts, {
    readJsonBody: async () => body,
    sendJson: (_res, status, json) => Object.assign(out, { status, json: JSON.parse(JSON.stringify(json)) }),
  });
  return out;
}

const runsOf = async (pid, sid) => {
  const st = await getRunStatus(pid, null, sid);
  const body = st && st.body ? st.body : st;
  return Object.fromEntries((body.runs || []).map((r) => [r.name, r]));
};

describe("a study's time dependency carries its draft runs", () => {
  it('drafts follow, a started run keeps its own, another study is untouched; the answer lists them', async () => {
    seedProject('p-td');
    const a = (await post('', { project_id: 'p-td', time_dependency: 'Steady-state' })).json.simulation.id;
    const b = (await post('', { project_id: 'p-td', time_dependency: 'Steady-state' })).json.simulation.id;
    const d1 = (await createDraftRun({ projectId: 'p-td', simulationId: a, name: 'Draft 1' })).run.id;
    await createDraftRun({ projectId: 'p-td', simulationId: a, name: 'Draft 2' });
    const done = (await createDraftRun({ projectId: 'p-td', simulationId: a, name: 'Solved' })).run.id;
    await createDraftRun({ projectId: 'p-td', simulationId: b, name: 'Other' });
    // "Solved" ran: its status is no longer draft.
    assert.ok(patchRunDocIfPresent('p-td', done, { status: 'done' }));
    assert.equal((await runsOf('p-td', a)).Solved.status, 'done');

    const r = await post('update', { project_id: 'p-td', simulation_id: a, time_dependency: 'Transient' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.runs_followed.length, 2);
    assert.ok(r.json.runs_followed.includes(d1));
    const mine = await runsOf('p-td', a);
    assert.equal(mine['Draft 1'].time_dependency, 'Transient');
    assert.equal(mine['Draft 2'].time_dependency, 'Transient');
    assert.equal(mine.Solved.time_dependency, 'Steady-state');
    assert.equal((await runsOf('p-td', b)).Other.time_dependency, 'Steady-state');

    // A change of anything else re-saves no run.
    const named = await post('update', { project_id: 'p-td', simulation_id: a, name: 'Renamed' });
    assert.equal(named.json.runs_followed, undefined);
  });
});
