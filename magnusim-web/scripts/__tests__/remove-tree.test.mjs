/**
 * Deleting a run (a study, a geometry, a project) while the worker read a file in it
 * failed at once on Windows: "Could not delete run folder: EPERM", the folder left half
 * removed. Opening a finished run's Run panel loads its result fields, so the worker
 * reads its time folders right then. Every delete passed rmSync maxRetries for this,
 * but Node 24's rmSync ignores it and fails at the first EPERM. removeTree and
 * removeTreeSync retry themselves.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { removeTree, removeTreeSync } from '../remove-tree.js';
import { WINDOWS_ONLY, holdOpen } from './hold-open.mjs';

const root = mkdtempSync(join(tmpdir(), 'magnusim-remove-tree-'));
after(() => rmSync(root, { recursive: true, force: true }));

/** A run's case folder with a saved time: case/100/{p,U}. Returns [case dir, time dir]. */
function seedCase(name) {
  const time = join(root, name, 'case', '100');
  mkdirSync(join(time, 'uniform'), { recursive: true });
  for (const f of ['p', 'U', join('uniform', 'time')]) writeFileSync(join(time, f), 'FoamFile {}\n');
  return [join(root, name, 'case'), time];
}

describe('removeTree: a folder a reader holds a file of', () => {
  it('removes a tree, and a missing path is fine', async () => {
    const [caseDir] = seedCase('plain');
    removeTreeSync(caseDir);
    assert.equal(existsSync(caseDir), false);
    removeTreeSync(caseDir);
    const [other] = seedCase('plain-async');
    await removeTree(other);
    assert.equal(existsSync(other), false);
    await removeTree(other);
  });

  it('removeTreeSync waits for the reader to let go', { skip: WINDOWS_ONLY }, async () => {
    const [caseDir, time] = seedCase('sync');
    const reader = await holdOpen(join(time, 'U'), 800);
    // The lock is real: a plain delete (Node's own retries asked for) fails at once.
    assert.throws(() => rmSync(time, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }), /EPERM|EBUSY|EACCES/);
    assert.equal(existsSync(join(time, 'U')), true);
    removeTreeSync(caseDir, { maxRetries: 10, retryDelay: 100 });
    assert.equal(existsSync(caseDir), false);
    await reader.done;
  });

  it('removeTree waits for the reader to let go', { skip: WINDOWS_ONLY }, async () => {
    const [caseDir, time] = seedCase('async');
    const reader = await holdOpen(join(time, 'p'), 800);
    assert.throws(() => rmSync(time, { recursive: true, force: true }), /EPERM|EBUSY|EACCES/);
    await removeTree(caseDir, { maxRetries: 10, retryDelay: 100 });
    assert.equal(existsSync(caseDir), false);
    await reader.done;
  });

  it('gives up after its retries while the reader holds on', { skip: WINDOWS_ONLY }, async () => {
    const [caseDir, time] = seedCase('held');
    const reader = await holdOpen(join(time, 'U'), 4000);
    const t0 = Date.now();
    assert.throws(() => removeTreeSync(caseDir, { maxRetries: 3, retryDelay: 50 }), /EPERM|EBUSY|EACCES/);
    // Waited 50 + 100 + 150 ms between its four tries.
    assert.ok(Date.now() - t0 >= 300, `gave up after ${Date.now() - t0} ms`);
    await assert.rejects(removeTree(caseDir, { maxRetries: 2, retryDelay: 50 }), /EPERM|EBUSY|EACCES/);
    await reader.done;
    removeTreeSync(caseDir);
    assert.equal(existsSync(caseDir), false);
  });
});
