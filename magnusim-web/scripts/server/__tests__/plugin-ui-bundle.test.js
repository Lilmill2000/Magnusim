import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundlePluginUi } from '../plugin-ui-bundle.ts';
import { safePluginFile } from '../routes.ts';

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

test('a bundled plugin UI in TSX is served as one module on the host React', async () => {
  const entry = safePluginFile(WEB, 'incompressible_flow', 'ui', 'index.tsx', 'bundled');
  assert.ok(entry, 'incompressible_flow/ui/index.tsx is served from bundled-plugins');
  assert.equal(safePluginFile(WEB, 'incompressible_flow', 'ui', 'index.tsx', 'user'), null);
  const code = await bundlePluginUi(entry, dirname(entry));
  assert.match(code, /registerStudySettings/);
  assert.match(code, /registerRunSettings/);
  assert.match(code, /registerBcSettings/);
  assert.match(code, /__MAGNUSIM_HOST_REACT__/);
  // No second React, and nothing imported at run time: one self-contained module.
  assert.doesNotMatch(code, /^import\s/m);
  assert.doesNotMatch(code, /react-dom|scheduler/);
});

test('a plugin UI may import only react and its own files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'magnusim-plugin-ui-'));
  try {
    const ui = join(root, 'ui');
    mkdirSync(ui, { recursive: true });
    writeFileSync(join(root, 'secret.ts'), 'export const s = 1;');
    writeFileSync(join(ui, 'own.ts'), 'export const n = 2;');
    writeFileSync(join(ui, 'ok.tsx'), "import { useState } from 'react';\nimport { n } from './own';\nexport const C = () => { useState(n); return <b>{n}</b>; };");
    writeFileSync(join(ui, 'leaves.tsx'), "import { s } from '../secret';\nexport const x = s;");
    writeFileSync(join(ui, 'package.tsx'), "import x from 'lodash';\nexport const y = x;");
    const ok = await bundlePluginUi(join(ui, 'ok.tsx'), ui);
    assert.match(ok, /export/);
    await assert.rejects(bundlePluginUi(join(ui, 'leaves.tsx'), ui), /leaves its ui folder/);
    await assert.rejects(bundlePluginUi(join(ui, 'package.tsx'), ui), /only react, @magnusim\/plugin-ui and its own files/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
