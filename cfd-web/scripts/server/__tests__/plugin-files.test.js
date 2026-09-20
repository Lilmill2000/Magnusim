import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { safePluginFile } from '../routes.ts';

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
