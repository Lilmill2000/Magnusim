/**
 * Regenerate scripts/generated/registry.json (and its docs copy) from
 * python/tools/registry_dump.py --shipped: the core builtins plus the bundled
 * plugins, i.e. what ships. User plugins never change it: Node reads their keys
 * from the live worker registry (scripts/registry-defaults.js).
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { PYTHON, pyTool, WEB_ROOT } from './python-env.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outPath = join(WEB_ROOT, 'scripts', 'generated', 'registry.json');
const docsPath = join(WEB_ROOT, 'docs', 'plugins', 'registry.json');
mkdirSync(dirname(outPath), { recursive: true });

const check = process.argv.includes('--check');
const argv = check
  ? [pyTool('registry_dump.py'), '--shipped', '--check', '--committed', outPath]
  : [pyTool('registry_dump.py'), '--shipped', '--force', '--out', outPath];
const r = spawnSync(PYTHON, argv, {
  encoding: 'utf8',
  cwd: WEB_ROOT,
});
if (r.status !== 0) {
  console.error(r.stderr || r.stdout || 'registry_dump failed');
  process.exit(r.status || 1);
}
if (check) {
  const same =
    existsSync(docsPath) && readFileSync(docsPath, 'utf8') === readFileSync(outPath, 'utf8');
  if (!same) {
    console.error(`${docsPath} differs from ${outPath}; run npm run gen:registry`);
    process.exit(1);
  }
  console.log((r.stdout || '').trim() || 'registry check ok');
} else {
  mkdirSync(dirname(docsPath), { recursive: true });
  copyFileSync(outPath, docsPath);
  console.log(`wrote ${outPath} and ${docsPath}`);
}
