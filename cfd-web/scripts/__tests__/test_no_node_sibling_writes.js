/**
 * Phase 2 land14 — Node never-writes siblings (SoT) guard.
 *
 * Fails if scripts/ (Node land) uses writeFile / writeFileSync / promises.writeFile
 * against project sibling JSON that Project/Python owns via write-through:
 *   materials.json, boundary_conditions.json, mesh.json, mesh_refinements.json,
 *   result_controls.json, area_average.json, simulation_control.json,
 *   simulations.json, simulation.json, runs/catalog.json
 *
 * Allowlist (not sibling SoT / plan-allowlisted):
 *   job-runner.js, w28-media.js, w16-project-geometry.js (geometry* until Phase 3)
 *
 * Python write-through (writeJsonCli / set-* via py-json.js) is ALLOWED —
 * that is Project path owning the write, not Node fs as SoT.
 *
 * Usage:
 *   node scripts/__tests__/test_no_node_sibling_writes.js
 *   node scripts/__tests__/test_no_node_sibling_writes.js --scan <extra-file>
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(__dirname, '..');
const ROOT = join(SCRIPTS, '..');

const ALLOW_FILES = new Set([
  'job-runner.js',
  'w28-media.js',
  'w16-project-geometry.js',
]);

/** Basename / rel patterns that must not be Node-fs-written as SoT. */
const SIBLING_NAMES = [
  'materials.json',
  'boundary_conditions.json',
  'mesh.json',
  'mesh_refinements.json',
  'result_controls.json',
  'area_average.json',
  'simulation_control.json',
  'simulations.json',
  'simulation.json',
  'runs/catalog.json',
  'catalog.json',
];

const WRITE_APIS = String.raw`(?:writeFileSync|writeFile|outputFileSync|writeJsonSync|promises\.writeFile)`;

const SETUP_JSON_PATTERNS = [
  new RegExp(WRITE_APIS + String.raw`\s*\(\s*simulationJsonPath\b`),
  new RegExp(WRITE_APIS + String.raw`\s*\(\s*simulationsJsonPath\b`),
  new RegExp(WRITE_APIS + String.raw`\s*\(\s*materialsJsonPath\b`),
  new RegExp(WRITE_APIS + String.raw`\s*\(\s*bcsJsonPath\b`),
  new RegExp(WRITE_APIS + String.raw`\s*\(\s*meshJsonPath\b`),
  new RegExp(WRITE_APIS + String.raw`\s*\(\s*refinementsJsonPath\b`),
  new RegExp(WRITE_APIS + String.raw`\s*\(\s*resultControlsJsonPath\b`),
  ...SIBLING_NAMES.map((name) => {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\//g, String.raw`[\\/]`);
    return new RegExp(WRITE_APIS + String.raw`\s*\([^)]*['"\`]` + esc + String.raw`['"\`]`);
  }),
];

const PROJECT_WRITE_RE =
  /function writeProject\s*\([\s\S]*?\n\}/;

function listJsFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === 'node_modules' || name === 'generated' || name === 'fixtures') continue;
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      // Skip prove plants under __tests__ except when --scan targets them.
      if (name === '__tests__') continue;
      listJsFiles(p, out);
    } else if (/\.(js|mjs|cjs)$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

function scanFile(absPath) {
  const base = absPath.split(/[/\\]/).pop();
  if (ALLOW_FILES.has(base)) return [];
  const text = readFileSync(absPath, 'utf8');
  const hits = [];
  const rel = relative(ROOT, absPath).replace(/\\/g, '/');

  const m = text.match(PROJECT_WRITE_RE);
  if (m) {
    const body = m[0];
    if (/writeFileSync\s*\(/.test(body) && /projectJsonPath|project\.json/.test(body)) {
      hits.push(`${rel}: active writeProject->project.json writeFileSync`);
    }
  }

  for (const re of SETUP_JSON_PATTERNS) {
    if (re.test(text)) {
      hits.push(`${rel}: Node fs write of sibling SoT JSON (${re.source.slice(0, 60)}…)`);
      break;
    }
  }

  return hits;
}

function main() {
  const args = process.argv.slice(2);
  const extra = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--scan' && args[i + 1]) {
      extra.push(args[++i]);
    }
  }

  const files = listJsFiles(SCRIPTS);
  // Top-level scripts only was Phase 1; land14 also walks nested (except __tests__/fixtures).
  // Re-add __tests__ guard itself is fine to skip; extra --scan files are checked always.
  const offenders = [];
  for (const f of files) {
    offenders.push(...scanFile(f));
  }
  for (const f of extra) {
    offenders.push(...scanFile(f));
  }

  if (offenders.length) {
    console.error('FAIL Phase 2 land14: Node must not write sibling SoT JSON:');
    for (const o of offenders) console.error('  -', o);
    process.exit(1);
  }
  console.log(
    'PASS land14: no Node fs writeFile* of sibling SoT JSON outside allowlist (job-runner/w28/w16)',
  );
}

main();
