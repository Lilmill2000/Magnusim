import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { safePluginFile } from '../routes.ts';
import { CASE_BUSY, PluginFiles, caseBusy, caseKeyOf } from '../plugin-files.ts';

test('plugin assets cannot escape through keys, manifests, paths, or directory links', () => {
  const root = mkdtempSync(join(tmpdir(), 'magnusim-plugin-'));
  try {
    const ui = join(root, 'plugins', 'example', 'ui');
    mkdirSync(ui, { recursive: true });
    writeFileSync(join(ui, 'index.js'), 'export {};');
    writeFileSync(join(root, 'private.txt'), 'private fixture');
    assert.equal(safePluginFile(root, 'example', 'ui', 'index.js'), join(ui, 'index.js'));
    assert.equal(safePluginFile(root, '../..', '.', 'private.txt'), null);
    assert.equal(safePluginFile(root, 'example', '../..', 'private.txt'), null);
    assert.equal(safePluginFile(root, 'example', root, 'private.txt'), null);
    assert.equal(safePluginFile(root, 'example', 'ui', '../../../private.txt'), null);
    symlinkSync(root, join(ui, 'outside'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(safePluginFile(root, 'example', 'ui', 'outside/private.txt'), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('caseBusy: a write inside a running case folder; a delete inside, of or above it; names as Windows compares them', () => {
  const keys = [caseKeyOf(['studies', 's1', 'cases', 'c1'])];
  assert.deepEqual(keys, ['studies/s1/cases/c1']);
  assert.equal(caseBusy(['studies', 's1', 'cases', 'c1', '0', 'U'], keys, 'write'), true);
  assert.equal(caseBusy(['studies', 's1', 'CASES', 'C1.', '0', 'U'], keys, 'write'), true, 'another letter case, a trailing dot');
  assert.equal(caseBusy(['studies', 's1', 'cases', 'c10', 'U'], keys, 'write'), false);
  assert.equal(caseBusy(['studies', 's1', 'cases'], keys, 'write'), false);
  assert.equal(caseBusy(['studies', 's1', 'cases'], keys, 'delete'), true, 'an ancestor');
  assert.equal(caseBusy(['studies', 's1', 'cases', 'c1'], keys, 'delete'), true, 'the folder itself');
  assert.equal(caseBusy(['studies', 's1', 'cases', 'c2'], keys, 'delete'), false);
  assert.equal(caseBusy(['studies', 's1', 'cases', 'c1'], [], 'delete'), false);
});

test('PluginFiles: a running case folder refuses writes, commits and deletes (busy), by the names on disk', async () => {
  const root = mkdtempSync(join(tmpdir(), 'magnusim-busy-'));
  try {
    const pdir = join(root, 'p1');
    const caseDir = join(pdir, 'plugins', 'foam-demo', 'studies', 's1', 'cases', 'c1');
    mkdirSync(join(caseDir, '0'), { recursive: true });
    writeFileSync(join(pdir, 'project.json'), '{}');
    writeFileSync(join(pdir, 'plugins', 'foam-demo', 'studies', 's1', 'study.json'), '{}');
    writeFileSync(join(caseDir, '0', 'U'), 'x');
    mkdirSync(join(pdir, 'plugins', 'foam-demo', 'studies', 's1', 'cases', 'c2'), { recursive: true });
    const active = [];
    const files = new PluginFiles({
      plugins: async () => [{ key: 'foam-demo', status: 'enabled' }],
      projectDir: (pid) => join(root, pid),
      activeCases: () => active.slice(),
    });
    const busy = (err) => err.code === 'busy' && err.status === 409 && err.message === CASE_BUSY;
    // Begun before the case runs; committed while it runs.
    const early = await files.begin('p1', 'foam-demo', { rel: 'studies/s1/cases/c1/0/p', size: 0 });
    active.push('studies/s1/cases/c1');
    await assert.rejects(files.begin('p1', 'foam-demo', { rel: 'studies/s1/cases/c1/0/U', size: 1 }), busy);
    await assert.rejects(files.begin('p1', 'foam-demo', { rel: 'studies/s1/CASES/C1/0/U', size: 1 }), busy);
    await assert.rejects(files.commit(early.upload, 'p1', 'foam-demo', undefined), busy);
    await assert.rejects(files.delete('p1', 'foam-demo', 'studies/s1/cases', true), busy);
    await assert.rejects(files.delete('p1', 'foam-demo', 'studies/s1/cases/c1', true), busy);
    await assert.rejects(files.delete('p1', 'foam-demo', 'studies/s1/cases/c1/0/U', false), busy);
    assert.ok(existsSync(join(caseDir, '0', 'U')));
    assert.equal(await files.delete('p1', 'foam-demo', 'studies/s1/cases/c2', true), 0, 'another case folder is free');
    const next = await files.begin('p1', 'foam-demo', { rel: 'studies/s1/notes.txt', size: 0 });
    assert.equal(typeof next.upload, 'string');
    await files.abort(next.upload, 'p1', 'foam-demo');
    // The busy commit kept its upload: it goes through once the case has finished.
    active.length = 0;
    const done = await files.commit(early.upload, 'p1', 'foam-demo', undefined);
    assert.equal(done.rel, 'studies/s1/cases/c1/0/p');
    // Where a path really lands, without writing.
    assert.deepEqual(await files.realParts('p1', 'foam-demo', 'studies/s1/cases/c1/0/U', 'write'), ['studies', 's1', 'cases', 'c1', '0', 'U']);
    // The case folder of a submit: its rules, and its real parts under the study.
    const folder = await files.caseFolder('p1', 'foam-demo', 's1', 'cases/c1');
    assert.deepEqual(folder.parts, ['studies', 's1', 'cases', 'c1']);
    assert.equal(folder.base, join(pdir, 'plugins', 'foam-demo'));
    assert.equal(folder.dir, caseDir);
    for (const bad of ['', 'cases/__APP__', 'cases/../x', 'a/b/c/d/e/f/g/h/i', 'cases/c1.', '.hidden', 'cases/a b']) {
      await assert.rejects(files.caseFolder('p1', 'foam-demo', 's1', bad), (e) => e.code === 'invalid_path', bad);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
