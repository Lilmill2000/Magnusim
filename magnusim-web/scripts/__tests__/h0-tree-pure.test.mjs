import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

test('gate:h0-tree-pure', () => {
  const tree = readFileSync(join(root, 'src/chrome/treeModel.ts'), 'utf8');
  const left = readFileSync(join(root, 'src/chrome/LeftTree.tsx'), 'utf8');
  assert.equal(tree.includes('window.__CFD_'), false);
  assert.equal(left.includes('window.__CFD_'), false);
});
