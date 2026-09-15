/**
 * Optional npm helper: regenerate scripts/generated/registry.json
 * from python/tools/registry_dump.py. Does NOT wire W17 consumers.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { PYTHON, pyTool, WEB_ROOT } from './python-env.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outPath = join(WEB_ROOT, 'scripts', 'generated', 'registry.json');
mkdirSync(dirname(outPath), { recursive: true });

const r = spawnSync(PYTHON, [pyTool('registry_dump.py'), '--force', '--out', outPath], {
  encoding: 'utf8',
  cwd: WEB_ROOT,
});
if (r.status !== 0) {
  console.error(r.stderr || r.stdout || 'registry_dump failed');
  process.exit(r.status || 1);
}
console.log('wrote', outPath);
