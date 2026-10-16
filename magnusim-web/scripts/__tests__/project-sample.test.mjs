// Sample projects (manifest [[samples]], host API 1.8): the placeholders a sample's JSON
// holds, the tool that makes a sample from a project, and the server copying one as a new
// project (a title no project has, the placeholders filled in for its own folder).
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const root = mkdtempSync(join(tmpdir(), 'cfd-sample-'));
const projects = join(root, 'projects');
mkdirSync(projects);
process.env.MAGNUSIM_PROJECTS_ROOT = projects;

const { fillSampleFolder, fillSampleText, namesAPlace, sampleProblem, sampleText, SAMPLE_MAX_BYTES, SAMPLE_TOKENS } = await import(
  '../project-sample.js'
);
const { sampleFromProject } = await import('../sample-from-project.mjs');
const { attachWorkerBridge } = await import('../py-json.js');
const { createProjectFromSample, handleW16Api, sweepSampleStaging } = await import('../w16-project-geometry.js');

after(() => {
  attachWorkerBridge(null);
  rmSync(root, { recursive: true, force: true });
});

const json = (value) => JSON.stringify(value, null, 2);

describe('sample placeholders', () => {
  it('a project made on Windows becomes placeholders with / between parts, and fills in for this PC', () => {
    const made = { projectDir: 'C:\\Users\\me\\projects\\box-1', projectsRoot: 'C:\\Users\\me\\projects', projectId: 'box-1' };
    const text = json({
      id: 'box-1',
      case_dir: 'C:\\Users\\me\\projects\\box-1\\geometries\\G\\meshes\\Mesh_1\\case',
      projects_root: 'C:\\Users\\me\\projects',
      url: '/api/geometry/cad?project_id=box-1&part=faces',
    });
    const sample = sampleText(text, made);
    assert.deepEqual(JSON.parse(sample), {
      id: SAMPLE_TOKENS.projectId,
      case_dir: '{{project_dir}}/geometries/G/meshes/Mesh_1/case',
      projects_root: '{{projects_root}}',
      url: '/api/geometry/cad?project_id={{project_id}}&part=faces',
    });
    const here = { projectDir: join(projects, 'box-2'), projectsRoot: projects, projectId: 'box-2' };
    assert.deepEqual(JSON.parse(fillSampleText(sample, here)), {
      id: 'box-2',
      case_dir: join(projects, 'box-2', 'geometries', 'G', 'meshes', 'Mesh_1', 'case'),
      projects_root: projects,
      url: '/api/geometry/cad?project_id=box-2&part=faces',
    });
  });

  it('a project made on Linux reads the same', () => {
    const made = { projectDir: '/home/me/projects/box-1', projectsRoot: '/home/me/projects', projectId: 'box-1' };
    const sample = sampleText(json({ step_path: '/home/me/projects/box-1/geometries/G/source.step' }), made);
    assert.equal(JSON.parse(sample).step_path, '{{project_dir}}/geometries/G/source.step');
    for (const [path, dir] of [[win32, 'D:\\p\\x'], [posix, '/srv/p/x']]) {
      const parts = JSON.parse(sample).step_path.split('/').slice(1);
      assert.equal(path.join(dir, ...parts), path === win32 ? 'D:\\p\\x\\geometries\\G\\source.step' : '/srv/p/x/geometries/G/source.step');
    }
  });
});

describe('sample checks', () => {
  const place = { projectDir: join(projects, 'p1'), projectsRoot: projects, projectId: 'p1' };

  it('refuses a path that leaves its folder, a folder placeholder inside a path, and text that is not JSON', () => {
    assert.throws(() => fillSampleText(json({ a: '{{project_dir}}/../outside.json' }), place), /leaves its folder/);
    assert.throws(() => fillSampleText(json({ a: '{{project_dir}}/a\\..\\b' }), place), /leaves its folder/);
    assert.throws(() => fillSampleText(json({ a: 'x/{{project_dir}}/y' }), place), /not at the start/);
    // A place on a PC, or a path under the projects folder (other projects): refused.
    for (const s of ['C:/x/{{project_dir}}/y', 'D:\\data\\x.step', '\\\\server\\share\\x', '//server/share/x', '/home/me/x.step', '/tmp/x']) {
      assert.throws(() => fillSampleText(json({ a: s }), place), /names a place outside its project/, s);
    }
    assert.throws(() => fillSampleText(json({ a: '{{projects_root}}/other-project/project.json' }), place), /leads into other projects/);
    assert.equal(JSON.parse(fillSampleText(json({ a: '{{projects_root}}' }), place)).a, projects);
    // The app's own URL paths are not places.
    assert.equal(namesAPlace('/api/geometry/cad?project_id=x'), false);
    assert.equal(namesAPlace('m/s'), false);
    assert.throws(() => fillSampleText('{"a": "{{project_dir}}"', place), /JSON/);
    // A quote in a string is kept as written (the file is parsed, not cut at "\"").
    assert.equal(JSON.parse(fillSampleText(json({ a: 'say "{{project_id}}"' }), place)).a, 'say "p1"');
    const bad = join(root, 'bad-json');
    mkdirSync(bad, { recursive: true });
    writeFileSync(join(bad, 'x.json'), '{"a": "{{project_id}}",');
    assert.throws(() => fillSampleFolder(bad, place), /x\.json/);
    // Every JSON file is read and checked, one without a placeholder too.
    const plain = join(root, 'plain-json');
    mkdirSync(plain, { recursive: true });
    writeFileSync(join(plain, 'y.json'), '{"a": 1,');
    assert.throws(() => fillSampleFolder(plain, place), /y\.json/);
    writeFileSync(join(plain, 'y.json'), json({ step: 'C:\\Users\\me\\part.step' }));
    assert.throws(() => fillSampleFolder(plain, place), /y\.json: a sample string names a place outside its project/);
  });

  it('refuses a sample holding a link or junction, and one over its size cap', () => {
    const dir = join(root, 'linked');
    mkdirSync(join(dir, 'data'), { recursive: true });
    writeFileSync(join(dir, 'project.json'), json({ id: '{{project_id}}' }));
    writeFileSync(join(dir, 'data', 'big.bin'), Buffer.alloc(2048));
    assert.equal(sampleProblem(dir), '');
    assert.match(sampleProblem(dir, 1024), /the sample is 0\.002 MB; a sample holds at most 0\.001 MB/);
    symlinkSync(join(root, 'made'), join(dir, 'elsewhere'), 'junction');
    assert.match(sampleProblem(dir), /holds a link \(elsewhere\)/);
    // The folder itself a junction (made after the plugin loaded): refused, not followed.
    const plainDir = join(root, 'plain-sample');
    mkdirSync(plainDir, { recursive: true });
    writeFileSync(join(plainDir, 'project.json'), json({ id: '{{project_id}}' }));
    symlinkSync(plainDir, join(root, 'swapped'), 'junction');
    assert.match(sampleProblem(join(root, 'swapped')), /the sample's folder is a link or junction/);
  });
});

/** A small project as the app lays one out: a mesh with a case folder and a run. */
function madeProject(name, { generated = false } = {}) {
  const dir = join(root, 'made', name);
  const study = join(dir, 'geometries', 'G', 'simulations', 'S');
  mkdirSync(join(study, 'meshes', 'Mesh_1', 'case', 'constant'), { recursive: true });
  mkdirSync(join(study, 'simulation_runs', 'Run_1'), { recursive: true });
  writeFileSync(join(dir, 'project.json'), json({ id: name, title: 'Box', project_json: join(dir, 'project.json'), projects_root: join(root, 'made') }));
  writeFileSync(
    join(study, 'meshes', 'Mesh_1', 'mesh.json'),
    json({ id: 'mesh-1', case_dir: join(study, 'meshes', 'Mesh_1', 'case'), live_mesh_result: generated ? { status: 'done', n_cells: 10 } : null }),
  );
  writeFileSync(join(study, 'meshes', 'Mesh_1', 'case', 'constant', 'owner'), 'mesh');
  writeFileSync(join(study, 'simulation_runs', 'Run_1', 'run.json'), json({ id: 'r1', status: 'draft' }));
  return dir;
}

function files(dir, rel = '') {
  const out = [];
  for (const name of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const sub = rel ? `${rel}/${name.name}` : name.name;
    if (name.isDirectory()) out.push(...files(dir, sub));
    else out.push(sub);
  }
  return out.sort();
}

describe('sample-from-project', () => {
  it('copies the inputs: no mesh case, no runs, placeholders for the project', () => {
    const dest = join(root, 'samples', 'box');
    sampleFromProject(madeProject('box-1'), dest);
    assert.deepEqual(files(dest), ['geometries/G/simulations/S/meshes/Mesh_1/mesh.json', 'project.json']);
    const proj = JSON.parse(readFileSync(join(dest, 'project.json'), 'utf8'));
    assert.deepEqual(proj, { id: '{{project_id}}', title: 'Box', project_json: '{{project_dir}}/project.json', projects_root: '{{projects_root}}' });
    const mesh = JSON.parse(readFileSync(join(dest, 'geometries/G/simulations/S/meshes/Mesh_1/mesh.json'), 'utf8'));
    assert.equal(mesh.case_dir, '{{project_dir}}/geometries/G/simulations/S/meshes/Mesh_1/case');
  });

  it('refuses a project whose mesh was generated, and a folder already there', () => {
    assert.throws(() => sampleFromProject(madeProject('box-2', { generated: true }), join(root, 'samples', 'meshed')), /the mesh was generated/);
    assert.throws(() => sampleFromProject(madeProject('box-3'), join(root, 'samples', 'box')), /already exists/);
  });
});

describe('POST /api/project/sample (createProjectFromSample)', () => {
  const sampleDir = join(root, 'plugin', 'samples', 'box');
  mkdirSync(join(sampleDir, 'geometries', 'G'), { recursive: true });
  writeFileSync(
    join(sampleDir, 'project.json'),
    json({ id: '{{project_id}}', title: 'Made', units: 'Metric', geometry: { step_path: '{{project_dir}}/geometries/G/source.step' } }),
  );
  writeFileSync(join(sampleDir, 'geometries', 'G', 'id.json'), json({ id: 'G', dir: '{{project_dir}}/geometries/G' }));
  // Old shipped previews and a source.step written later (a checkout writes in its own order).
  writeFileSync(join(sampleDir, 'geometries', 'G', 'cad_faces.vtp'), 'vtp');
  writeFileSync(join(sampleDir, 'geometries', 'G', 'cad_edges.vtp'), 'vtp');
  writeFileSync(join(sampleDir, 'geometries', 'G', 'source.step'), 'ISO-10303-21;');
  const old = new Date(Date.now() - 3600_000);
  utimesSync(join(sampleDir, 'geometries', 'G', 'cad_faces.vtp'), old, old);
  utimesSync(join(sampleDir, 'geometries', 'G', 'cad_edges.vtp'), old, old);
  // A study no draft run can be made for (its runs folder is a file).
  const brokenDir = join(root, 'plugin', 'samples', 'broken');
  const brokenStudy = join(brokenDir, 'geometries', 'G', 'simulations', 'S');
  mkdirSync(brokenStudy, { recursive: true });
  writeFileSync(join(brokenDir, 'project.json'), json({ id: '{{project_id}}', title: 'Broken' }));
  writeFileSync(join(brokenDir, 'geometries', 'G', 'id.json'), json({ id: 'G' }));
  writeFileSync(join(brokenStudy, 'id.json'), json({ id: 'sim-broken', name: 'S' }));
  writeFileSync(join(brokenStudy, 'simulation_runs'), 'not a folder');
  // A link inside; more than the cap; a JSON file whose fill fails after the copy.
  const linkedDir = join(root, 'plugin', 'samples', 'linked');
  mkdirSync(linkedDir, { recursive: true });
  writeFileSync(join(linkedDir, 'project.json'), json({ id: '{{project_id}}' }));
  symlinkSync(join(root, 'made'), join(linkedDir, 'elsewhere'), 'junction');
  const bigDir = join(root, 'plugin', 'samples', 'big');
  mkdirSync(bigDir, { recursive: true });
  writeFileSync(join(bigDir, 'project.json'), json({ id: '{{project_id}}' }));
  writeFileSync(join(bigDir, 'huge.bin'), '');
  truncateSync(join(bigDir, 'huge.bin'), SAMPLE_MAX_BYTES + 1);
  const badFillDir = join(root, 'plugin', 'samples', 'badfill');
  mkdirSync(join(badFillDir, 'geometries', 'G'), { recursive: true });
  writeFileSync(join(badFillDir, 'project.json'), json({ id: '{{project_id}}' }));
  writeFileSync(join(badFillDir, 'geometries', 'G', 'id.json'), json({ id: 'G', dir: '{{project_dir}}/../elsewhere' }));
  // A study the index (simulations.json) does not list: it gets its draft run too.
  const unindexedDir = join(root, 'plugin', 'samples', 'unindexed');
  const unindexedStudy = join(unindexedDir, 'geometries', 'G', 'simulations', 'S');
  mkdirSync(unindexedStudy, { recursive: true });
  writeFileSync(join(unindexedDir, 'project.json'), json({ id: '{{project_id}}', title: 'Unindexed' }));
  writeFileSync(join(unindexedDir, 'simulations.json'), json({ simulations: [] }));
  writeFileSync(join(unindexedDir, 'geometries', 'G', 'id.json'), json({ id: 'G' }));
  writeFileSync(join(unindexedStudy, 'id.json'), json({ id: 'sim-unindexed', name: 'S', analysis_type: 'incompressible_steady' }));
  const dirs = { broken: brokenDir, linked: linkedDir, big: bigDir, badfill: badFillDir, unindexed: unindexedDir };
  const asked = [];
  const codeError = (code, message) => Object.assign(new Error(message), { code });
  const bridge = (method, params) => {
    if (method !== 'plugins.sample') return null;
    asked.push(params);
    if (params.sample === 'crash') return Promise.reject(new Error('worker stopped'));
    if (dirs[params.sample]) return Promise.resolve({ ok: true, plugin: 'demo', sample: params.sample, title: params.sample, dir: dirs[params.sample] });
    if (params.key !== 'demo' || params.sample !== 'box') return Promise.reject(codeError(-32004, `Demo has no sample '${params.sample}'`));
    return Promise.resolve({ ok: true, plugin: 'demo', sample: 'box', title: 'A box', dir: sampleDir });
  };
  attachWorkerBridge(bridge);

  it('copies the sample as a new project with its placeholders filled in, titled as no project here', async () => {
    const first = await createProjectFromSample({ plugin: 'demo', sample: 'box' });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(first.body.title, 'A box');
    assert.deepEqual(first.body.sample, { plugin: 'demo', key: 'box' });
    const dir = join(projects, first.body.id);
    const proj = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'));
    assert.equal(proj.id, first.body.id);
    assert.equal(proj.title, 'A box');
    assert.equal(proj.units, 'Metric');
    assert.equal(proj.geometry.step_path, join(dir, 'geometries', 'G', 'source.step'));
    assert.equal(JSON.parse(readFileSync(join(dir, 'geometries', 'G', 'id.json'), 'utf8')).dir, join(dir, 'geometries', 'G'));
    // The shipped previews are used, not built again: newer than the copied source.step.
    const step = statSync(join(dir, 'geometries', 'G', 'source.step')).mtimeMs;
    for (const f of ['cad_faces.vtp', 'cad_edges.vtp']) assert.ok(statSync(join(dir, 'geometries', 'G', f)).mtimeMs >= step, f);
    // The plugin's own folder is untouched.
    assert.match(readFileSync(join(sampleDir, 'project.json'), 'utf8'), /\{\{project_id\}\}/);
    const second = await createProjectFromSample({ plugin: 'demo', sample: 'box', folder: 'Samples' });
    assert.equal(second.body.title, 'A box 2');
    assert.equal(second.body.folder, 'Samples');
    assert.notEqual(second.body.id, first.body.id);
    assert.deepEqual(asked.slice(-2), [{ key: 'demo', sample: 'box' }, { key: 'demo', sample: 'box' }]);
  });

  it('says why when the plugin has no such sample, and makes nothing', async () => {
    const before = readdirSync(projects).length;
    const r = await createProjectFromSample({ plugin: 'demo', sample: 'nope' });
    assert.equal(r.status, 404);
    assert.match(r.body.error, /no sample 'nope'/);
    assert.equal((await createProjectFromSample({ plugin: '', sample: '' })).status, 400);
    // The worker failing is the app's (503), not "no such sample".
    const crash = await createProjectFromSample({ plugin: 'demo', sample: 'crash' });
    assert.equal(crash.status, 503);
    assert.match(crash.body.error, /could not read the sample: worker stopped/);
    // A study no draft run can be made for: 500 with the reason, and the copy removed.
    const broken = await createProjectFromSample({ plugin: 'demo', sample: 'broken' });
    assert.equal(broken.status, 500);
    assert.match(broken.body.error, /no draft run for study sim-broken/);
    assert.equal(readdirSync(projects).length, before);
    assert.equal(existsSync(join(projects, 'undefined')), false);
  });

  it('refuses a sample holding a link or over the cap, and a copy whose fill fails is removed', async () => {
    const before = readdirSync(projects).sort();
    const linked = await createProjectFromSample({ plugin: 'demo', sample: 'linked' });
    assert.equal(linked.status, 500);
    assert.match(linked.body.error, /holds a link \(elsewhere\)/);
    const big = await createProjectFromSample({ plugin: 'demo', sample: 'big' });
    assert.equal(big.status, 500);
    assert.match(big.body.error, /a sample holds at most 64 MB/);
    const badFill = await createProjectFromSample({ plugin: 'demo', sample: 'badfill' });
    assert.equal(badFill.status, 500);
    assert.match(badFill.body.error, /could not open the sample: geometries\/G\/id\.json: a sample path leaves its folder/);
    // Nothing left: no project, no staging folder.
    assert.deepEqual(readdirSync(projects).sort(), before);
  });

  it('gives every study a draft run, one simulations.json does not list too', async () => {
    const r = await createProjectFromSample({ plugin: 'demo', sample: 'unindexed' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const runs = join(projects, r.body.id, 'geometries', 'G', 'simulations', 'S', 'simulation_runs');
    assert.deepEqual(readdirSync(runs).filter((n) => n !== 'catalog.json'), ['Run_1']);
    assert.equal(JSON.parse(readFileSync(join(runs, 'Run_1', 'run.json'), 'utf8')).status, 'draft');
    assert.equal(existsSync(join(projects, '.sample-staging')), false);
  });

  it('without the worker (the same RPC run once in Python), a plugin that is not on is still a 404', async () => {
    attachWorkerBridge(null);
    try {
      const r = await createProjectFromSample({ plugin: 'no_such_plugin', sample: 'x' });
      assert.equal(r.status, 404, JSON.stringify(r.body));
      assert.match(r.body.error, /plugin 'no_such_plugin' is not on/);
    } finally {
      attachWorkerBridge(bridge);
    }
  });

  it('POST /api/project/sample: a body that is not JSON is a 400; a copy names its project in X-CFD-Project-Id', async () => {
    const call = async (readJsonBody) => {
      const headers = {};
      let sent = null;
      const res = { setHeader: (k, v) => (headers[k] = v) };
      await handleW16Api({ method: 'POST' }, res, new URL('http://x/api/project/sample'), ['api', 'project', 'sample'], {
        readJsonBody,
        sendJson: (_res, status, body) => (sent = { status, body }),
      });
      return { ...sent, headers };
    };
    const bad = await call(async () => {
      throw new SyntaxError('Unexpected token');
    });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /invalid JSON body/);
    const ok = await call(async () => ({ plugin: 'demo', sample: 'box' }));
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(ok.headers['X-CFD-Project-Id'], ok.body.id);
    assert.equal(ok.headers['X-CFD-Source'], 'project-sample');
    const missing = await call(async () => ({ plugin: 'demo', sample: 'nope' }));
    assert.equal(missing.status, 404);
    assert.equal(missing.headers['X-CFD-Project-Id'], undefined);
  });

  it('a copy the app stopped in the middle of is swept from the staging folder after an hour', async () => {
    const staging = join(projects, '.sample-staging');
    mkdirSync(join(staging, 'old-copy'), { recursive: true });
    writeFileSync(join(staging, 'old-copy', 'project.json'), '{}');
    mkdirSync(join(staging, 'fresh-copy'), { recursive: true });
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(join(staging, 'old-copy'), twoHoursAgo, twoHoursAgo);
    assert.deepEqual(await sweepSampleStaging(projects), ['old-copy']);
    assert.equal(existsSync(join(staging, 'old-copy')), false);
    assert.equal(existsSync(join(staging, 'fresh-copy')), true);
    rmSync(staging, { recursive: true, force: true });
  });
});
