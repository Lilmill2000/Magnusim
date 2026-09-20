import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

describe('listenPort', () => {
  it('uses the saved prefs port even when MAGNUSIM_PORT is 8082', () => {
    const dir = mkdtempSync(join(tmpdir(), 'magnusim-prefs-'));
    const jsonPath = join(dir, '.magnusim-local.json');
    writeFileSync(jsonPath, JSON.stringify({ port: 9099 }));
    try {
      const r = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          "import { listenPort, resetPrefsCache } from './scripts/prefs.js'; resetPrefsCache(); process.stdout.write(String(listenPort()));",
        ],
        {
          cwd: webRoot,
          env: {
            ...process.env,
            MAGNUSIM_LOCAL_JSON: jsonPath,
            MAGNUSIM_PORT: '8082',
            CFDDESK_PORT: '8082',
          },
          encoding: 'utf8',
        },
      );
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, '9099');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
