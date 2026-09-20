/**
 * Optional npm helper: regenerate scripts/generated/registry.json
 * from python/tools/registry_dump.py. Consumers: scripts/registry-defaults.js (land13).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { PYTHON, pyTool, WEB_ROOT } from './python-env.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outPath = join(WEB_ROOT, 'scripts', 'generated', 'registry.json');
mkdirSync(dirname(outPath), { recursive: true });

const check = process.argv.includes('--check');
const argv = check
  ? [pyTool('registry_dump.py'), '--check', '--committed', outPath]
  : [pyTool('registry_dump.py'), '--force', '--out', outPath];
const r = spawnSync(PYTHON, argv, {
  encoding: 'utf8',
  cwd: WEB_ROOT,
});
if (r.status !== 0) {
  console.error(r.stderr || r.stdout || 'registry_dump failed');
  process.exit(r.status || 1);
}
console.log(check ? (r.stdout || '').trim() || 'registry check ok' : `wrote ${outPath}`);
