/**
 * Magnusim CAD's server (scripts/server/cad-edition/serve.mjs) runs the app's API with
 * no Python and no WSL: no interpreter to find (MAGNUSIM_PYTHON names a missing file,
 * and Python's folders are off PATH), and the spawn guard refuses any start of one.
 * A person's way through it (the plugin list, a new project, a Part made, saved and
 * renamed) answers in full, and nothing was refused on the way.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';

const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-cad-server-'));
process.env.MAGNUSIM_PROJECTS_ROOT = join(ROOT, 'projects');
process.env.MAGNUSIM_LOCAL_JSON = join(ROOT, 'local.json');
process.env.MAGNUSIM_ASSISTANT_HOME = join(ROOT, 'assistant');
process.env.MAGNUSIM_PYTHON = join(ROOT, 'no-python.exe');
process.env.PATH = String(process.env.PATH || '')
  .split(delimiter)
  .filter((dir) => !/python|windowsapps/i.test(dir))
  .join(delimiter);
writeFileSync(process.env.MAGNUSIM_LOCAL_JSON, '{}');

const { startCadServer } = await import('../cad-edition/serve.mjs');
const { blockedReason, spawnTrips } = await import('../cad-edition/spawn-guard.js');
const cp = await import('node:child_process');

let server;
let base;
/** What the guard refused while the server started (before any test planted a spawn). */
let startTrips = [];

before(async () => {
  server = await startCadServer({});
  startTrips = spawnTrips();
  base = `http://127.0.0.1:${server.port}`;
});

after(async () => {
  await server?.close();
});

async function api(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', origin: base },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

describe('spawn guard', () => {
  it('refuses Python and WSL by name, and Python scripts by argument', () => {
    for (const file of ['python', 'python3', 'python3.12', 'PYTHON.EXE', 'pythonw.exe', 'py', 'C:\\x\\.venv\\Scripts\\python.exe', 'wsl', 'wsl.exe', 'wslg']) {
      assert.match(blockedReason(file, []), /not started in Magnusim CAD/, file);
    }
    assert.match(blockedReason('C:\\tools\\run.exe', ['-x', 'C:\\py\\tools\\render.py']), /Python script \(render\.py\)/);
    for (const [file, args] of [
      [process.execPath, ['scripts/assistant-mcp.mjs']],
      ['powershell.exe', ['-NoProfile', '-EncodedCommand', 'AAAA']],
      ['git', ['status']],
      ['pyright', []],
      ['C:\\Users\\me\\.local\\bin\\agent.exe', ['--acp']],
    ]) {
      assert.equal(blockedReason(file, args), '', `${file} may run`);
    }
  });

  it('throws on a planted spawn and still lets Node run', async () => {
    const before = spawnTrips().length;
    assert.throws(() => cp.spawnSync('python', ['-c', 'print(1)']), /python is not started in Magnusim CAD/);
    assert.throws(() => cp.spawn('wsl', ['-d', 'Ubuntu']), /wsl is not started/);
    assert.throws(() => cp.execSync('py -3 tools\\x.py'), /py is not started/);
    assert.equal(spawnTrips().length, before + 3);
    const ok = cp.spawnSync(process.execPath, ['-e', 'process.stdout.write("ran")'], { encoding: 'utf8' });
    assert.equal(ok.stdout, 'ran');
    // exec keeps util.promisify's {stdout, stderr} form.
    const { stdout } = await promisify(cp.execFile)(process.execPath, ['-e', 'process.stdout.write("again")']);
    assert.equal(stdout, 'again');
  });
});

describe('Magnusim CAD server', () => {
  it('starts without spawning WSL or Python (no import-time probe)', () => {
    assert.deepEqual(
      startTrips.map((t) => `${t.call}(${t.file} ${t.args.join(' ')})`),
      [],
    );
  });

  // What the guard test above planted is not the server's.
  let planted = 0;
  before(() => {
    planted = spawnTrips().length;
  });
  const serverTrips = () => spawnTrips().slice(planted);

  it('lists CAD as the one plugin and an empty registry', async () => {
    const plugins = await api('GET', '/api/plugins');
    assert.equal(plugins.status, 200);
    assert.deepEqual(
      plugins.body.plugins.map((p) => [p.key, p.status]),
      [['cad', 'enabled']],
    );
    const registry = await api('GET', '/api/registry');
    assert.equal(registry.status, 200);
    assert.deepEqual(registry.body.mesher, []);
    assert.deepEqual(registry.body.required_missing, []);
  });

  it('makes a project and a Part, saves the Part and renames both, with no Python', async () => {
    const made = await api('POST', '/api/project', { title: 'Bracket set', units: 'Metric' });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const pid = made.body.id;
    const listed = await api('GET', '/api/projects');
    assert.deepEqual(
      listed.body.projects.map((p) => p.title),
      ['Bracket set'],
    );
    const study = await api('POST', '/api/plugin-studies/create', { project_id: pid, plugin: 'cad', kind: 'part', title: 'Bracket' });
    assert.equal(study.status, 200, JSON.stringify(study.body));
    const sid = study.body.study.id;
    assert.equal(study.body.study.available, true);
    const saved = await api('POST', '/api/plugin-studies/update', { project_id: pid, plugin: 'cad', study_id: sid, rev: 1, patch: { model: { features: 2 } } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.study.rev, 2);
    const stale = await api('POST', '/api/plugin-studies/update', { project_id: pid, plugin: 'cad', study_id: sid, rev: 1, patch: {} });
    assert.equal(stale.status, 409, JSON.stringify(stale.body));
    const renamed = await api('POST', '/api/project/update', { id: pid, title: 'Brackets' });
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
    const doc = JSON.parse(readFileSync(join(process.env.MAGNUSIM_PROJECTS_ROOT, pid, 'project.json'), 'utf8'));
    assert.equal(doc.title, 'Brackets');
    assert.equal(doc.persistence, 'filesystem');
    const rec = JSON.parse(readFileSync(join(process.env.MAGNUSIM_PROJECTS_ROOT, pid, 'plugins', 'cad', 'studies', sid, 'study.json'), 'utf8'));
    assert.deepEqual(rec.model, { features: 2 });
    assert.deepEqual(serverTrips(), [], 'nothing tried to start Python or WSL');
  });

  it('answers a simulation route at once, as not in Magnusim CAD', async () => {
    const started = Date.now();
    const tree = await api('GET', '/api/project/tree?project_id=none');
    assert.ok(tree.status >= 400);
    assert.ok(Date.now() - started < 2000, 'no worker restarts or retries');
    assert.deepEqual(serverTrips(), []);
  });
});
