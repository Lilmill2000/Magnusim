/**
 * The CAD edition's worker (scripts/server/cad-edition/node-worker.ts) against every worker
 * method the server's code names: each is answered, or refused at once with a coded error
 * (CadEditionRefusal: RPC -32601, reason not_in_cad_edition, the method named), never
 * undefined and never a hang. And project.json saves ride out Windows' file locks (another
 * writer or a reader holding it: both apps may share one projects folder) as the Python
 * worker's atomic_write does.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-cad-worker-'));
process.env.MAGNUSIM_PROJECTS_ROOT = join(ROOT, 'projects');
mkdirSync(process.env.MAGNUSIM_PROJECTS_ROOT, { recursive: true });

// The renames the store makes, failed on demand as Windows fails them while a file is held.
const realRename = fs.renameSync;
let held = [];
fs.renameSync = (from, to) => {
  const code = held.shift();
  if (code) throw Object.assign(new Error(`${code}: operation not permitted, rename`), { code });
  return realRename(from, to);
};
syncBuiltinESMExports();

const { WEB_ROOT } = await import('../../python-env.js');
const { RpcError } = await import('../worker.ts');
const { CadEditionRefusal, CadEditionWorker, NOT_IN_EDITION, NOT_IN_EDITION_REASON, cadEditionMethods } = await import('../cad-edition/node-worker.ts');

/** Worker method names in the server's code: call('x.y', workerAnswer(deps, 'x.y', commitRpc('x.y', ['x.y', { (py-json's table). */
function methodsNamed() {
  const files = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== '__tests__' && e.name !== 'generated' && e.name !== 'node_modules') walk(p);
      } else if (/\.(ts|js|mjs)$/.test(e.name)) files.push(p);
    }
  };
  walk(join(WEB_ROOT, 'scripts'));
  const found = new Set();
  const patterns = [
    // call(, worker.call(, callWorker(, runRpc(, commitRpc(...
    /\b\w*(?:call|Call|Worker|Rpc|rpc)\(\s*'([a-z_]+(?:\.[a-z_]+)+)'/g,
    /worker(?:Answer|Json)\(\s*deps\s*,\s*(?:ctx\s*,\s*)?'([a-z_]+(?:\.[a-z_]+)+)'/g,
    /commitRpc\(\s*'([a-z_]+(?:\.[a-z_]+)+)'/g,
    /\[\s*'([a-z_]+(?:\.[a-z_]+)+)'\s*,\s*\{/g,
  ];
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    for (const re of patterns) for (const m of text.matchAll(re)) found.add(m[1]);
  }
  return [...found].sort();
}

function within(ms, promise) {
  return Promise.race([promise, new Promise((_, no) => setTimeout(() => no(new Error(`no answer in ${ms} ms`)), ms))]);
}

describe('CAD edition worker: every method the server names', () => {
  it('is answered, or refused at once with not_in_cad_edition naming it', async () => {
    const worker = new CadEditionWorker();
    const named = methodsNamed();
    // The walk found the server's calls (a regression in the patterns would pass vacuously).
    for (const m of ['registry.describe', 'plugins.list', 'project.write_project', 'plugin_studies.create', 'mesh.set', 'project.tree', 'geometry.link_check', 'cad.preview']) {
      assert.ok(named.includes(m), `the walk finds ${m}`);
    }
    const ours = new Set(cadEditionMethods());
    const refused = [];
    for (const method of named) {
      let out;
      try {
        out = await within(1000, worker.call(method, {}));
      } catch (err) {
        assert.ok(err instanceof RpcError, `${method}: ${err}`);
        assert.equal(typeof err.code, 'number', method);
        if (!ours.has(method)) {
          assert.ok(err instanceof CadEditionRefusal, `${method} is refused as not in the edition`);
          assert.equal(err.code, NOT_IN_EDITION);
          assert.deepEqual(err.data, { code: NOT_IN_EDITION_REASON, method, edition: 'cad' });
          assert.match(err.message, new RegExp(`^${method.replace(/\./g, '\\.')} is not in Magnusim CAD$`));
          refused.push(method);
        }
        continue;
      }
      assert.ok(ours.has(method), `${method} answered though the edition does not have it`);
      assert.notEqual(out, undefined, `${method} answered undefined`);
    }
    assert.ok(refused.length > 20, `the simulation methods are refused (${refused.length})`);
    assert.ok(!refused.includes('plugin_studies.update'));
  });
});

describe('CAD edition worker: project.json under Windows file locks', () => {
  const project = (name) => {
    const dir = join(process.env.MAGNUSIM_PROJECTS_ROOT, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'project.json'), JSON.stringify({ id: name, title: 'Before', siblings_migrated: 2 }));
    return dir;
  };

  it('a save waits out a held file (EPERM, EBUSY, EACCES) and lands whole', async () => {
    const dir = project('held-briefly');
    held = ['EPERM', 'EBUSY', 'EACCES'];
    const worker = new CadEditionWorker();
    const out = await worker.call('project.write_project', { project_dir: dir, doc: { title: 'After' } });
    assert.equal(held.length, 0, 'retried past each refusal');
    assert.equal(out.title, 'After');
    const doc = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'));
    assert.equal(doc.title, 'After');
    assert.equal(doc.siblings_migrated, 2, 'the migration marker on disk is kept');
    assert.deepEqual(readdirSync(dir), ['project.json'], 'no temp file left beside it');
  });

  it('a file held past the retries fails the save, leaves the old file and no temp', async () => {
    const dir = project('held-long');
    held = Array(8).fill('EPERM');
    const worker = new CadEditionWorker();
    await assert.rejects(worker.call('project.write_project', { project_dir: dir, doc: { title: 'After' } }), /EPERM/);
    held = [];
    assert.equal(JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')).title, 'Before');
    assert.deepEqual(readdirSync(dir), ['project.json']);
  });

  it('another error is not retried', async () => {
    const dir = project('not-a-lock');
    held = ['ENOSPC', 'EPERM'];
    const worker = new CadEditionWorker();
    await assert.rejects(worker.call('project.write_project', { project_dir: dir, doc: {} }), /ENOSPC/);
    assert.deepEqual(held, ['EPERM'], 'stopped at the first, unretried error');
    held = [];
  });
});
