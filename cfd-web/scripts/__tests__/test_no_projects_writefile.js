/**
 * Phase 1 Step 9 lint-style guard.
 * Fails on scripts with active writeProject->project.json (writeFileSync).
 * Also fails on Node writeFileSync of simulation.json / simulations.json.
 * Allowlist: job-runner.js, w28-media.js, w16-project-geometry.js (geometry* until Phase 3).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(__dirname, '..');
const ALLOW = new Set(['job-runner.js', 'w28-media.js', 'w16-project-geometry.js']);

const offendersProject = [];
const offendersSim = [];
for (const name of readdirSync(SCRIPTS)) {
  if (!name.endsWith('.js')) continue;
  if (ALLOW.has(name)) continue;
  const text = readFileSync(join(SCRIPTS, name), 'utf8');
  const m = text.match(/function writeProject\s*\([\s\S]*?\n\}/);
  if (m) {
    const body = m[0];
    if (/writeFileSync\s*\(/.test(body) && /projectJsonPath|project\.json/.test(body)) {
      offendersProject.push(name);
    }
  }
  // Sibling study files: Node must not writeFileSync simulation(s).json
  if (
    /writeFileSync\s*\(\s*simulationJsonPath\b/.test(text) ||
    /writeFileSync\s*\(\s*simulationsJsonPath\b/.test(text) ||
    /writeFileSync\s*\([^)]*simulation\.json/.test(text) ||
    /writeFileSync\s*\([^)]*simulations\.json/.test(text)
  ) {
    offendersSim.push(name);
  }
}
let failed = false;
if (offendersProject.length) {
  console.error('FAIL active writeProject->project.json:', offendersProject.join(', '));
  failed = true;
}
if (offendersSim.length) {
  console.error('FAIL Node writeFileSync simulation(s).json:', offendersSim.join(', '));
  failed = true;
}
if (failed) process.exit(1);
console.log('PASS: no active writeProject(project.json) or simulation(s).json writeFileSync outside allowlist');
