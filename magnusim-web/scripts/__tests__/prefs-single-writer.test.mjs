import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

// gate:h6-prefs-single-writer — the worker owns plugins.disabled; a Node prefs
// save (units, port, hardware) must not write an older copy of it back.
describe('prefs single writer', () => {
  it('a units save keeps a plugin the worker turned off in the meantime', () => {
    const dir = mkdtempSync(join(tmpdir(), 'magnusim-prefs-writer-'));
    const jsonPath = join(dir, '.magnusim-local.json');
    writeFileSync(jsonPath, JSON.stringify({ units: 'Metric' }));
    try {
      const script = [
        "import { readFileSync, writeFileSync } from 'node:fs';",
        "import { readLocalDoc, writeLocalDoc } from './scripts/prefs.js';",
        'readLocalDoc();', // cache the file before the worker writes
        `const p = ${JSON.stringify(jsonPath)};`,
        "const doc = JSON.parse(readFileSync(p, 'utf8'));",
        "doc.plugins = { disabled: ['example-laminar'] };",
        "writeFileSync(p, JSON.stringify(doc));",
        "writeLocalDoc({ units: 'Imperial' });",
      ].join('\n');
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd: webRoot,
        env: { ...process.env, MAGNUSIM_LOCAL_JSON: jsonPath },
        encoding: 'utf8',
      });
      assert.equal(r.status, 0, r.stderr);
      const saved = JSON.parse(readFileSync(jsonPath, 'utf8'));
      assert.equal(saved.units, 'Imperial');
      assert.deepEqual(saved.plugins, { disabled: ['example-laminar'] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
