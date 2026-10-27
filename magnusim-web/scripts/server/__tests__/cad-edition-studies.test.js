/**
 * Golden: the CAD edition's worker (scripts/server/cad-edition/node-worker.ts) answers
 * the study, plugin-data and project.json calls as the Python worker does, and leaves
 * the same files. The same calls run through both, each in a project of its own, with
 * only CAD installed; study ids, times and the project id are the only differences
 * allowed.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-cad-golden-'));
const PROJECTS = join(ROOT, 'projects');
const BUNDLED = join(ROOT, 'bundled', 'cad');
mkdirSync(PROJECTS, { recursive: true });
mkdirSync(join(BUNDLED, 'workspace'), { recursive: true });
mkdirSync(join(ROOT, 'user'), { recursive: true });
writeFileSync(join(ROOT, 'local.json'), '{}');
process.env.MAGNUSIM_PROJECTS_ROOT = PROJECTS;

const { WEB_ROOT, PY_ROOT } = await import('../../python-env.js');
const { WorkerClient, RpcError } = await import('../worker.ts');
const { CadEditionWorker, NOT_IN_EDITION } = await import('../cad-edition/node-worker.ts');

for (const name of ['manifest.toml', 'plugin.py', 'workspace/index.html']) {
  copyFileSync(join(WEB_ROOT, 'bundled-plugins', 'cad', name), join(BUNDLED, name));
}

const PY = 'p-py';
const JS = 'p-js';
let python;
const js = new CadEditionWorker();

before(() => {
  python = new WorkerClient({
    name: 'cad-golden-worker',
    timeoutMs: 120_000,
    env: {
      MAGNUSIM_PROJECTS_ROOT: PROJECTS,
      MAGNUSIM_BUNDLED_DIR: join(ROOT, 'bundled'),
      MAGNUSIM_PLUGINS_DIR: join(ROOT, 'user'),
      MAGNUSIM_LOCAL_JSON: join(ROOT, 'local.json'),
      // This tree's SDK, not an editable install of another checkout's.
      PYTHONPATH: [join(PY_ROOT, 'sdk'), PY_ROOT].join(process.platform === 'win32' ? ';' : ':'),
    },
  });
  python.start();
});

after(() => {
  python?.stop();
});

function seedProject(pid) {
  const dir = join(PROJECTS, pid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'project.json'), `${JSON.stringify({ id: pid, title: 'Golden', siblings_migrated: 2 }, null, 2)}\n`);
  // A study of a plugin this edition does not have (a project made in Magnusim).
  const other = join(dir, 'plugins', 'incompressible_flow', 'studies', 'st-0000aaaa');
  mkdirSync(other, { recursive: true });
  writeFileSync(
    join(other, 'study.json'),
    JSON.stringify({ id: 'st-0000aaaa', kind: 'flow', title: 'Wing', plugin: 'incompressible_flow', plugin_name: 'Incompressible Flow', rev: 3, created_at: '2026-01-01T00:00:00+00:00' }),
  );
  return dir;
}

/** Ids, times and the project id, as placeholders in order of appearance. */
function normalizer() {
  const ids = new Map();
  return (value) =>
    JSON.parse(
      JSON.stringify(value)
        .replace(/st-[0-9a-f]{8}/g, (id) => {
          if (id === 'st-0000aaaa') return id;
          if (!ids.has(id)) ids.set(id, `<study${ids.size + 1}>`);
          return ids.get(id);
        })
        .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\+00:00|Z)/g, '<time>')
        .replace(/p-(?:py|js)/g, '<pid>'),
    );
}

async function answer(worker, method, params) {
  try {
    return { ok: await worker.call(method, params) };
  } catch (err) {
    if (!(err instanceof RpcError)) throw err;
    // A Python crash's data is its traceback; a conflict's is the current rev.
    return { code: err.code, message: err.message, ...(err.code === -32009 ? { data: err.data } : {}) };
  }
}

function filesOf(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[relative(dir, p).replace(/\\/g, '/')] = readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return out;
}

/**
 * The calls, run in order on both; `$1`.. in a param is the id of the study the
 * n-th create made on that side.
 */
const STEPS = [
  ['plugin_studies.list', {}],
  ['plugin_studies.create', { plugin: 'cad', kind: 'part', title: 'Bracket' }],
  ['plugin_studies.create', { plugin: 'cad', kind: 'part', title: '' }],
  ['plugin_studies.create', { plugin: 'cad', kind: 'part', title: '   ' }],
  ['plugin_studies.create', { plugin: 'cad', kind: 'nope', title: 'X' }],
  ['plugin_studies.create', { plugin: '../x', kind: 'part', title: 'X' }],
  ['plugin_studies.create', { plugin: 'incompressible_flow', kind: 'flow', title: 'X' }],
  ['plugin_studies.get', { plugin: 'cad', study_id: '$1' }],
  ['plugin_studies.get', { plugin: 'cad', study_id: 'Bad Id' }],
  ['plugin_studies.get', { plugin: 'cad', study_id: 'st-99999999' }],
  ['plugin_studies.update', { plugin: 'cad', study_id: '$1', rev: 1, patch: { model: { sketches: [1, 2.5, 'é'] }, id: 'x', plugin_version: '9', title: 'Bracket 2' } }],
  ['plugin_studies.update', { plugin: 'cad', study_id: '$1', rev: 1, patch: { title: 'stale' } }],
  ['plugin_studies.update', { plugin: 'cad', study_id: '$1', rev: 2, patch: 'nope' }],
  ['plugin_studies.update', { plugin: 'incompressible_flow', study_id: 'st-0000aaaa', rev: 3, patch: {} }],
  ['plugin_studies.rename', { plugin: 'cad', study_id: '$1', rev: 2, title: '  Renamed  ' }],
  ['plugin_studies.rename', { plugin: 'cad', study_id: '$1', rev: 3, title: ' ' }],
  ['plugin_data.write', { plugin: 'cad', rel: 'views/main.json', doc: { camera: [0, 1, 2], name: 'ünï' } }],
  ['plugin_data.read', { plugin: 'cad', rel: 'views/main.json' }],
  ['plugin_data.read', { plugin: 'cad', rel: 'views\\main.json' }],
  ['plugin_data.read', { plugin: 'cad', rel: 'views/none.json' }],
  ['plugin_data.write', { plugin: 'cad', rel: 'studies/$1/study.json', doc: {} }],
  ['plugin_data.write', { plugin: 'cad', rel: 'studies/$1/view.json', doc: { zoom: 2 } }],
  ['plugin_data.write', { plugin: 'cad', rel: 'studies', doc: {} }],
  ['plugin_data.write', { plugin: 'cad', rel: '../escape.json', doc: {} }],
  ['plugin_data.write', { plugin: 'cad', rel: '.magnusim-x.json', doc: {} }],
  ['plugin_data.write', { plugin: 'cad', rel: 'a:b.json', doc: {} }],
  ['plugin_data.write', { plugin: 'cad', rel: '', doc: {} }],
  ['plugin_studies.create', { plugin: 'cad', kind: 'part', title: 'Second' }],
  ['plugin_studies.list', {}],
  ['plugin_studies.delete', { plugin: 'cad', study_id: '$1' }],
  ['plugin_studies.get', { plugin: 'cad', study_id: '$1' }],
  ['plugin_studies.delete', { plugin: 'cad', study_id: '$1' }],
  ['plugin_data.write', { plugin: 'cad', rel: 'studies/$1/view.json', doc: { zoom: 3 } }],
  ['plugin_studies.list', {}],
];

describe('CAD edition worker vs the Python worker', () => {
  it('answers the study and plugin-data calls the same, and leaves the same files', async () => {
    const sides = { [PY]: { worker: python, ids: [] }, [JS]: { worker: js, ids: [] } };
    const results = { [PY]: [], [JS]: [] };
    for (const pid of [PY, JS]) seedProject(pid);
    for (const [method, raw] of STEPS) {
      for (const pid of [PY, JS]) {
        const side = sides[pid];
        const params = JSON.parse(JSON.stringify({ project_id: pid, ...raw }).replace(/\$(\d)/g, (_, n) => side.ids[n - 1] || 'st-missing0'));
        const got = await answer(side.worker, method, params);
        if (method === 'plugin_studies.create' && got.ok) side.ids.push(got.ok.study.id);
        results[pid].push([method, raw, got]);
      }
    }
    const normPy = normalizer();
    const normJs = normalizer();
    // What the edition drops on purpose (scripts/gen-cad-edition.mjs): CAD's geometry
    // links, since it has no project geometries.
    for (const [, , got] of results[PY]) {
      for (const kind of got.ok?.kinds || []) Object.assign(kind, { links_geometry: false, geometry_action: null });
    }
    // Studies made in the same second list in the order of their random ids, on both.
    for (const pid of [PY, JS]) {
      for (const [, , got] of results[pid]) got.ok?.studies?.sort((a, b) => (a.title < b.title ? -1 : 1));
    }
    const py = normPy(results[PY]);
    const jsOut = normJs(results[JS]);
    for (let i = 0; i < STEPS.length; i++) {
      assert.deepEqual(jsOut[i], py[i], `step ${i + 1}: ${STEPS[i][0]} ${JSON.stringify(STEPS[i][1])}`);
    }
    assert.deepEqual(normJs(filesOf(join(PROJECTS, JS))), normPy(filesOf(join(PROJECTS, PY))));
  });

  it('saves project.json as the Python worker does', async () => {
    const out = {};
    for (const [pid, worker] of [
      ['w-py', python],
      ['w-js', js],
    ]) {
      const dir = join(PROJECTS, pid);
      mkdirSync(dir, { recursive: true });
      const fresh = join(PROJECTS, `${pid}-new`);
      mkdirSync(fresh, { recursive: true });
      const steps = [];
      steps.push(await answer(worker, 'project.write_project', { project_dir: dir, doc: { title: 'none yet' } }));
      steps.push(await answer(worker, 'project.write_project', { project_dir: fresh, doc: { title: 'New', units: 'Metric' }, create: true }));
      writeFileSync(join(dir, 'project.json'), JSON.stringify({ id: pid, siblings_migrated: 3 }));
      steps.push(
        await answer(worker, 'project.write_project', {
          project_dir: dir,
          doc: { id: pid, title: 'Wing ✈', updated_at: '2026-10-27T10:00:00Z', folder: 'A', persistence: 'x', n: [1, 2] },
        }),
      );
      steps.push(await answer(worker, 'project.write_project', { project_dir: dir, body: { title: 'from body' } }));
      steps.push(await answer(worker, 'project.write_project', { project_dir: join(PROJECTS, 'gone'), doc: {} }));
      steps.push(await answer(worker, 'project.write_project', { project_dir: dir, doc: 'nope' }));
      out[pid] = {
        steps: JSON.parse(JSON.stringify(steps).replaceAll(pid, '<pid>')),
        file: readFileSync(join(dir, 'project.json'), 'utf8').replaceAll(pid, '<pid>'),
        fresh: readFileSync(join(fresh, 'project.json'), 'utf8').replaceAll(pid, '<pid>'),
        leftovers: readdirSync(dir).filter((n) => n !== 'project.json'),
      };
    }
    // Times are now; the one step 3 gives is kept as given on both sides.
    const norm = (v) => JSON.parse(JSON.stringify(v).replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ/g, '<time>'));
    assert.deepEqual(norm(out['w-js']), norm(out['w-py']));
    assert.equal(out['w-js'].steps[2].ok.updated_at, '2026-10-27T10:00:00Z');
    assert.equal(existsSync(join(PROJECTS, 'gone')), false, 'a save never makes a deleted project again');
  });

  it('refuses at once what is Magnusim\'s, with its own code', async () => {
    for (const method of ['mesh.set', 'project.tree', 'geometry.link_check', 'cad.preview', 'plugins.enable']) {
      const started = Date.now();
      await assert.rejects(js.call(method, {}), (err) => {
        assert.ok(err instanceof RpcError);
        assert.equal(err.code, NOT_IN_EDITION);
        assert.match(err.message, /is not in Magnusim CAD/);
        return true;
      });
      assert.ok(Date.now() - started < 200, `${method} answered at once`);
    }
    assert.equal(js.unavailable, false);
    assert.ok(statSync(PROJECTS).isDirectory());
  });
});
