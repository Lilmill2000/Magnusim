/**
 * Phase 1 Step 9 lint-style guard.
 * Phase 2 land14 extends coverage: scripts/__tests__/test_no_node_sibling_writes.js + prove-no-node-sibling-writes.mjs.
 * Fails on scripts with active writeProject->project.json (writeFileSync).
 * Fails on Node writeFileSync of simulation(s).json and other project setup JSON.
 * Allowlist: job-runner.js, w28-media.js, w16-project-geometry.js (geometry* until Phase 3).
 * Note: vite-plugin-case-fields.js / prefs.js write under .cache or local prefs â€” not projects/.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(__dirname, '..');
const ALLOW = new Set(['job-runner.js', 'w28-media.js', 'w16-project-geometry.js']);

const SETUP_JSON_PATTERNS = [
  /writeFileSync\s*\(\s*simulationJsonPath\b/,
  /writeFileSync\s*\(\s*simulationsJsonPath\b/,
  /writeFileSync\s*\([^)]*simulation\.json/,
  /writeFileSync\s*\([^)]*simulations\.json/,
  /writeFileSync\s*\([^)]*materials\.json/,
  /writeFileSync\s*\([^)]*boundary_conditions\.json/,
  /writeFileSync\s*\([^)]*mesh_refinements\.json/,
  /writeFileSync\s*\([^)]*result_controls\.json/,
  /writeFileSync\s*\([^)]*area_average\.json/,
  /writeFileSync\s*\([^)]*simulation_control\.json/,
  /writeFileSync\s*\([^)]*catalog\.json/,
  /writeFileSync\s*\([^)]*['"`]mesh\.json/,
];

const offendersProject = [];
const offendersSetup = [];
const offendersProjectsPath = [];
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
  for (const re of SETUP_JSON_PATTERNS) {
    if (re.test(text)) {
      offendersSetup.push(name);
      break;
    }
  }
  // Heuristic: writeFileSync near PROJECTS_ROOT / projects/ join for generate.log under mesh/
  if (
    /writeFileSync\s*\(\s*winLog\b/.test(text) &&
    /join\([^)]*PROJECTS_ROOT[^)]*['"`]mesh['"`]/.test(text) &&
    /const winLog = join\(winOut/.test(text)
  ) {
    offendersProjectsPath.push(name + ':winLog-under-projects');
  }
}
let failed = false;
if (offendersProject.length) {
  console.error('FAIL active writeProject->project.json:', offendersProject.join(', '));
  failed = true;
}
if (offendersSetup.length) {
  console.error('FAIL Node writeFileSync project setup JSON:', offendersSetup.join(', '));
  failed = true;
}
if (offendersProjectsPath.length) {
  console.error('FAIL projects/ job log writeFileSync:', offendersProjectsPath.join(', '));
  failed = true;
}
if (failed) process.exit(1);
console.log(
  'PASS: no active writeProject/setup-JSON writeFileSync outside allowlist (job-runner/w28/w16)',
);

