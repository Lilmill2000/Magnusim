/**
 * Phase 1 Step 9 lint-style guard.
 * Fails on scripts with active writeProject->project.json (writeFileSync).
 * Allowlist: job-runner.js, w28-media.js, w16-project-geometry.js (geometry* until Phase 3).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(__dirname, '..');
const ALLOW = new Set(['job-runner.js', 'w28-media.js', 'w16-project-geometry.js']);

const offenders = [];
for (const name of readdirSync(SCRIPTS)) {
  if (!name.endsWith('.js')) continue;
  if (ALLOW.has(name)) continue;
  const text = readFileSync(join(SCRIPTS, name), 'utf8');
  const m = text.match(/function writeProject\s*\([\s\S]*?\n\}/);
  if (!m) continue;
  const body = m[0];
  if (/writeFileSync\s*\(/.test(body) && /projectJsonPath|project\.json/.test(body)) {
    offenders.push(name);
  }
}
if (offenders.length) {
  console.error('FAIL active writeProject->project.json:', offenders.join(', '));
  process.exit(1);
}
console.log('PASS: no active writeProject(project.json) outside allowlist');
