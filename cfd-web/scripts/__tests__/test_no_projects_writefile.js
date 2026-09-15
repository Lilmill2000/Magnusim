/**
 * Phase 1 Step 9 lint-style guard.
 * Fails on unexpected scripts with active writeProject->project.json.
 * Known leftovers (not yet routed through project_cli) soft-pass with report.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(__dirname, '..');
const ALLOW = new Set(['job-runner.js', 'w28-media.js', 'w16-project-geometry.js']);
const KNOWN_LEFTOVER = new Set([
  'w17-simulation.js',
  'w19-boundary-conditions.js',
  'w20-mesh.js',
  'w21-mesh-generate.js',
  'w22-area-average.js',
  'w26-mesh-refinements.js',
  'w27-solve.js',
]);

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
const unexpected = offenders.filter((n) => !KNOWN_LEFTOVER.has(n));
const known = offenders.filter((n) => KNOWN_LEFTOVER.has(n));
if (unexpected.length) {
  console.error('FAIL unexpected writeProject->project.json:', unexpected.join(', '));
  process.exit(1);
}
if (known.length) {
  console.log('SOFT PASS Step9 guard: known leftovers still write project.json:', known.join(', '));
  console.log('Routed so far: w18-materials.js (noop writeProject + project_cli set-materials).');
  process.exit(0);
}
console.log('PASS: no active writeProject(project.json) outside allowlist');
