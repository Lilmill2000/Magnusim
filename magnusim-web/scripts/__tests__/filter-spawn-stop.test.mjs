import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runFilterToolAsync, stopFilterToolsFor } from '../filter-spawn.js';

// Deleting a mesh while its surface export still reads the files: on Windows the
// delete failed (open files cannot be removed) and the mesh stayed "generated".
describe('filter tools reading a case folder', () => {
  it('are stopped so the folder can be deleted', async () => {
    const root = mkdtempSync(join(tmpdir(), 'magnusim-stop-'));
    const caseDir = join(root, 'case');
    mkdirSync(join(caseDir, 'constant'), { recursive: true });
    const held = join(caseDir, 'constant', 'points');
    writeFileSync(held, 'x');
    const ready = join(root, 'ready');
    const code = [
      'import sys, time',
      `f = open(${JSON.stringify(held)}, "rb")`,
      `open(${JSON.stringify(ready)}, "w").close()`,
      'time.sleep(60)',
    ].join('\n');
    const run = runFilterToolAsync(['-c', code], { caseDir, timeout: 90000 });
    for (let i = 0; i < 200 && !existsSync(ready); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(existsSync(ready), 'tool started and holds the file');

    const stopped = await stopFilterToolsFor(join(caseDir, '..', 'case'));
    assert.equal(stopped, 1);
    const result = await run;
    assert.notEqual(result.status, 0);
    rmSync(caseDir, { recursive: true, force: true });
    assert.equal(existsSync(caseDir), false);
    rmSync(root, { recursive: true, force: true });
  });

  it('leave tools on other folders alone', async () => {
    assert.equal(await stopFilterToolsFor(join(tmpdir(), 'magnusim-no-such-case')), 0);
    assert.equal(await stopFilterToolsFor(null), 0);
  });
});
