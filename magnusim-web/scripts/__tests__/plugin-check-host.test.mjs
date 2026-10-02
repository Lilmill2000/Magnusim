// npm run plugin:check's ui rule (python/tools/plugin_check.py) says what the host
// does: the same plugin UIs, bundled by the host's own bundler
// (scripts/server/plugin-ui-bundle.ts) and checked by plugin:check, get the same
// answer. If the bundler's rules change, this fails until the checker follows.
// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { PYTHON, pyTool } from '../python-env.js';
import { bundlePluginUi } from '../server/plugin-ui-bundle.ts';

const TMP = mkdtempSync(join(tmpdir(), 'magnusim-plugin-check-host-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

const COMPONENT = 'export default function Panel() { return null; }\n';

// name -> [ui/index.tsx, does the host refuse it]. Each import is used: esbuild drops
// an unused import from a .ts/.tsx file before resolving it (it may be a type).
const CASES = {
  'own-files': [
    "import { useState } from 'react';\nimport { Button } from '@magnusim/plugin-ui';\nimport { x } from './x';\nimport type { A } from '@rjsf/utils';\nexport const used: unknown[] = [useState, Button, x];\n" + COMPONENT,
    false,
  ],
  'commented-out': ['// import _ from "lodash";\n/* require("left-pad") */\nexport const doc = \'import a from "b"\';\n' + COMPONENT, false],
  'require-package': ['export const _ = require("lodash");\n' + COMPONENT, true],
  'absolute-path': ['import t from "/abs/thing.js";\nexport const used = t;\n' + COMPONENT, true],
  url: ['import z from "https://esm.sh/zod";\nexport const used = z;\n' + COMPONENT, true],
  'dynamic-package': ["export const later = () => import('left-pad');\n" + COMPONENT, true],
  'leaves-the-folder': ["import { y } from '../outside';\nexport const used = y;\n" + COMPONENT, true],
};

function plugin(name, entry) {
  const dir = join(TMP, 'plugins', name);
  mkdirSync(join(dir, 'ui'), { recursive: true });
  writeFileSync(
    join(dir, 'manifest.toml'),
    `key = "${name}"\nname = "Case"\nversion = "0.1.0"\napi_version = "1.4"\nlicense = "GPL-3.0-or-later"\nui = "ui"\nui_entry = "index.tsx"\n`,
  );
  writeFileSync(join(dir, 'plugin.py'), 'def register(hub):\n    return None\n');
  writeFileSync(join(dir, 'ui', 'index.tsx'), entry);
  writeFileSync(join(dir, 'ui', 'x.ts'), 'export const x = 1;\n');
  writeFileSync(join(dir, 'outside.ts'), 'export const y = 1;\n');
  return dir;
}

test('the ui rule refuses exactly what the host bundler refuses', async () => {
  const refused = {};
  for (const [name, [entry]] of Object.entries(CASES)) {
    const dir = plugin(name, entry);
    try {
      await bundlePluginUi(join(dir, 'ui', 'index.tsx'), join(dir, 'ui'), { kitNames: async () => ['Button'] });
      refused[name] = false;
    } catch {
      refused[name] = true;
    }
  }
  // The cases themselves say what the bundler does.
  assert.deepEqual(refused, Object.fromEntries(Object.entries(CASES).map(([k, [, r]]) => [k, r])));
  const r = spawnSync(PYTHON, [pyTool('plugin_check.py'), '--json', '--no-tests', join(TMP, 'plugins', '*')], {
    encoding: 'utf8',
    timeout: 600_000,
    windowsHide: true,
  });
  const doc = JSON.parse(r.stdout);
  const failed = Object.fromEntries(doc.plugins.map((p) => [p.key, p.checks.ui === 'fail']));
  assert.deepEqual(failed, refused, JSON.stringify(doc.plugins.map((p) => [p.key, p.findings]), null, 1));
});
