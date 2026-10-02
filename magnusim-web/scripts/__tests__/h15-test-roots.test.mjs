// H15: every new server or node test sets a temp projects root (and its own local
// settings file) before its first app import, so PROJECTS_ROOT, the queue file and
// the plugin case store never point at this PC's real projects.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(HERE, '..');

export const H15_TESTS = [
  'server/__tests__/compute-slot.test.js',
  'server/__tests__/foam-store.test.js',
  'server/__tests__/foam-runner.test.js',
  'server/__tests__/plugin-cases.test.js',
  'server/__tests__/registered-tool.test.js',
  '__tests__/project-delete-jobs.test.mjs',
  '__tests__/wsl-case-watch.test.mjs',
  '__tests__/solve-hooks.test.mjs',
  '__tests__/solve-drain.test.mjs',
  '__tests__/solve-stop-slot.test.mjs',
  '__tests__/compute-rediscover.test.mjs',
  '__tests__/mesh-slot.test.mjs',
  '__tests__/foam-relay-launch.test.mjs',
  '__tests__/foam-steps-relay.test.mjs',
  '__tests__/job-runner-close.test.mjs',
  '__tests__/stop-ps1.test.mjs',
  '__tests__/h15-test-roots.test.mjs',
];

/** Code only (comments may mention imports). */
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('H15 tests set a temp projects root first', () => {
  for (const rel of H15_TESTS) {
    it(rel, () => {
      const file = join(SCRIPTS, rel);
      assert.ok(existsSync(file), `${rel} exists`);
      const src = code(readFileSync(file, 'utf8'));
      // Static imports: Node's own modules only (an app module would load before the root is set).
      const statics = [...src.matchAll(/^import\s[^;]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
      const appStatic = statics.filter((s) => !s.startsWith('node:'));
      assert.deepEqual(appStatic, [], `${rel} imports app modules statically`);
      const firstDynamic = src.search(/await import\(\s*['"]\.\.?\//);
      if (firstDynamic < 0) return;
      const setRoot = src.search(/process\.env\.MAGNUSIM_PROJECTS_ROOT\s*=/);
      assert.ok(setRoot >= 0 && setRoot < firstDynamic, `${rel}: the projects root is set before the first app import`);
      const setLocal = src.search(/process\.env\.MAGNUSIM_LOCAL_JSON\s*=/);
      assert.ok(setLocal >= 0 && setLocal < firstDynamic, `${rel}: its own local settings file`);
      assert.match(src, /mkdtempSync\(\s*join\(\s*tmpdir\(\)/, `${rel}: the root is a temp folder`);
    });
  }
});
