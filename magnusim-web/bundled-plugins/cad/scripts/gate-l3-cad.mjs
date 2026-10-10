// gate:l3-cad (npm run test:gate:l3-cad): the exit-sync gate (host API 1.6, L3),
// built like gate:l2-cad: it must FAIL, never pass by skipping.
//   1. The app's Python (scripts/app-python.mjs: MAGNUSIM_PYTHON, else the app's
//      python/.venv, else a python or python3 on PATH that imports cfddesk and
//      magnusim_sdk, as in CI) and Daniel's Vortex STEP (CAD_E2E_VORTEX_STEP) must be
//      there: without either the gate stops at once and says so. Everything the gate
//      starts gets the Python as MAGNUSIM_PYTHON.
//   2. vitest on L3_UNIT with --allowOnly=false (a stray it.only fails), and its JSON
//      report must show no skipped or todo test, and every L3_UNIT file with tests that ran.
//   3. The exit e2e (e2e/cad-link-exit.spec.ts, against the real host) and Edit in CAD's
//      (e2e/cad-edit-in-cad.spec.ts, host API 1.7: cad:edit-flow and its neighbours) through
//      scripts/e2e.mjs with CAD_L3_REQUIRE=1 (a missing Python or Vortex fails the
//      tests instead of skipping them) and --forbid-only (a stray test.only fails), and
//      its JSON report must show no skipped test, and pass the census (L3_E2E_CENSUS):
//      exactly the expected tests, by id, each run, each expected to pass. No test is
//      marked test.fail(): the host defects of the L3 reviews were fixed in 253d6a4 and
//      their markers are gone; a test marked to fail fails the census.
// gate:l3-cad:ci (npm run test:gate:l3-cad:ci, `--ci`): the same gate, as strict, for CI,
// which never has Daniel's STEP files. It does not need CAD_E2E_VORTEX_STEP; it leaves out
// exactly the cases in L3_CI_LEFT_OUT (by --grep-invert, so they are neither run nor
// skipped) and holds its own census, L3_E2E_CI_CENSUS: every other test of the full census.
// Every case left out has a synthetic twin in the census (L3_CI_LEFT_OUT says which).
// The local gate (no --ci) stays the full gate.
// Owner: LINK.
// SPDX-License-Identifier: GPL-3.0-or-later
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { appPythonMissing, probePython } from './app-python.mjs';
import { e2eVerdict, gateEnv, gatePython, vitestVerdict } from './gate-l2-cad.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const L3_UNIT = ['tests/link/leave.test.ts', 'tests/link/controller.test.ts', 'tests/app/bootstrap.test.tsx', 'tests/doc/service.test.ts', 'tests/ui/panels.test.tsx', 'tests/link/adopt.test.ts', 'tests/link/edit-open.test.ts'];
export const L3_E2E = ['e2e/cad-link-exit.spec.ts', 'e2e/cad-edit-in-cad.spec.ts'];

/**
 * The exit e2e, test by test: [id (the title's first word), expected status]. Every test is
 * expected to pass; 'failed' would be a test.fail() marker, and there is none.
 */
export const L3_E2E_CENSUS = [
  ['cad:l3-first-exit', 'passed'],
  ['cad:l3-question', 'passed'],
  ['cad:l3-no-change', 'passed'],
  ['cad:l3-refused', 'passed'],
  ['cad:l3-behind-row-refused', 'passed'],
  ['cad:l3-behind-row-no-body', 'passed'],
  ['cad:l3-no-body', 'passed'],
  ['cad:l3-save-on-its-way', 'passed'],
  ['cad:l3-save-refused', 'passed'],
  ['cad:l3-clean-second-tab', 'passed'],
  ['cad:l3-removed-feature', 'passed'],
  ['cad:l3-background', 'passed'],
  ['cad:l3-other-exits', 'passed'],
  ['cad:l3-typed', 'passed'],
  ['cad:l3-report', 'passed'],
  ['cad:l3-background-camera', 'passed'],
  ['cad:l3-include', 'passed'],
  ['cad:l3-vortex-include', 'passed'],
  // Edit in CAD (host API 1.7).
  ['cad:edit-flow', 'passed'],
  ['cad:edit-unchanged', 'passed'],
  ['cad:edit-ineligible', 'passed'],
  ['cad:edit-viewport', 'passed'],
  ['cad:edit-two-tabs', 'passed'],
  ['cad:edit-undo-to-import', 'passed'],
  ['cad:edit-surface-only', 'passed'],
  ['cad:edit-wait-stop', 'passed'],
  ['cad:edit-vortex', 'passed'],
];

/**
 * The cases gate:l3-cad:ci leaves out, each with why and the test that covers the same case
 * on the repository's own files. Only a case that needs one of Daniel's files may be here.
 */
export const L3_CI_LEFT_OUT = [
  {
    id: 'cad:l3-vortex-include',
    why: "it imports Daniel's Vortex STEP (CAD_E2E_VORTEX_STEP), which never leaves his PC",
    twin: 'cad:l3-include',
  },
  {
    id: 'cad:edit-vortex',
    why: "it opens Daniel's Vortex STEP (CAD_E2E_VORTEX_STEP) in CAD from the project, which never leaves his PC",
    twin: 'cad:edit-flow',
  },
];

/** The census of gate:l3-cad:ci: the full census without the cases left out. */
export const L3_E2E_CI_CENSUS = L3_E2E_CENSUS.filter(([id]) => !L3_CI_LEFT_OUT.some((l) => l.id === id));

/** Playwright args that leave the CI gate's cases out (by title id, so they are not even listed). */
export function ciGrepInvert(leftOut = L3_CI_LEFT_OUT) {
  return ['--grep-invert', leftOut.map((l) => `${l.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).join('|')];
}

/** Every spec of a Playwright JSON report: {id, tests: [{expectedStatus, status, results}]}. */
function specsOf(report) {
  const out = [];
  const walk = (suite) => {
    for (const spec of suite?.specs ?? []) out.push({ id: String(spec.title ?? '').split(/\s+/)[0], title: spec.title, tests: spec.tests ?? [] });
    for (const s of suite?.suites ?? []) walk(s);
  };
  for (const s of report?.suites ?? []) walk(s);
  return out;
}

/** The census of the exit e2e (Playwright's JSON report): why the gate fails, or null. */
export function censusVerdict(report, census = L3_E2E_CENSUS) {
  const specs = specsOf(report);
  const want = new Map(census);
  const ids = specs.map((s) => s.id);
  const missing = census.map(([id]) => id).filter((id) => !ids.includes(id));
  if (missing.length) return `the census is short: ${missing.join(', ')} did not run (deleted, renamed or filtered out)`;
  const extra = ids.filter((id) => !want.has(id));
  if (extra.length) return `the census has tests it does not know: ${extra.join(', ')} (add them to L3_E2E_CENSUS)`;
  const twice = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (twice.length) return `the census has the same test twice: ${[...new Set(twice)].join(', ')}`;
  for (const s of specs) {
    if (!s.tests.length) return `${s.id} has no test run`;
    for (const t of s.tests) {
      if (t.expectedStatus !== want.get(s.id)) {
        return want.get(s.id) === 'failed'
          ? `${s.id} is no longer marked test.fail() (expected status ${t.expectedStatus}): if the host defect is fixed, update L3_E2E_CENSUS too`
          : `${s.id} is marked to fail (expected status ${t.expectedStatus}), but the census expects it to pass`;
      }
      const last = (t.results ?? []).at(-1);
      if (!last || last.status === 'skipped') return `${s.id} did not run`;
    }
  }
  return null;
}

/** Every L3_UNIT file ran tests (vitest's JSON report): why the gate fails, or null. */
export function unitFilesVerdict(report, files = L3_UNIT) {
  const ran = new Map();
  for (const r of report?.testResults ?? []) {
    const name = String(r.name ?? '').replace(/\\/g, '/');
    ran.set(name, (r.assertionResults ?? []).filter((a) => a.status === 'passed').length);
  }
  const none = files.filter((f) => ![...ran.entries()].some(([name, n]) => name.endsWith(`/${f}`) && n > 0));
  return none.length ? `no unit test ran in ${none.join(', ')}` : null;
}

/** Why the gate cannot run here (a missing Python, or for the full gate the Vortex), or null. */
export function missingInputs(env = process.env, exists = existsSync, probe = probePython, { ci = false } = {}) {
  const found = gatePython(env, { exists, probe });
  if (!found.python) return `${appPythonMissing(found)} The link checker cannot run.`;
  if (ci) return null;
  const vortex = env.CAD_E2E_VORTEX_STEP || '';
  if (!vortex) return "Daniel's Vortex STEP is not set: set CAD_E2E_VORTEX_STEP to the path of Vortex CFD Test.step (the include case runs on it).";
  if (!exists(vortex)) return `CAD_E2E_VORTEX_STEP names no file (${vortex}).`;
  return null;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

const CI = process.argv.includes('--ci');
const NAME = CI ? 'gate:l3-cad:ci' : 'gate:l3-cad';

function fail(message) {
  console.error(`[${NAME}] FAILED: ${message}`);
  process.exit(1);
}

function main() {
  const why = missingInputs(process.env, existsSync, probePython, { ci: CI });
  if (why) fail(why);
  const found = gatePython();
  console.log(`[${NAME}] the app's Python: ${found.python} (${found.from})`);
  if (CI) for (const l of L3_CI_LEFT_OUT) console.log(`[${NAME}] left out: ${l.id} (${l.why}); ${l.twin} covers its case`);
  const census = CI ? L3_E2E_CI_CENSUS : L3_E2E_CENSUS;
  const out = join(ROOT, '.cache', CI ? 'gate-l3-cad-ci' : 'gate-l3-cad');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const env = { ...gateEnv(found.python), CAD_L3_REQUIRE: '1' };

  const vitestJson = join(out, 'vitest.json');
  const vitestCli = join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');
  const v = spawnSync(process.execPath, [vitestCli, 'run', ...L3_UNIT, '--allowOnly=false', '--reporter=default', '--reporter=json', `--outputFile.json=${vitestJson}`], { cwd: ROOT, stdio: 'inherit', env });
  const vReport = readJson(vitestJson);
  const vWhy = vitestVerdict(vReport) ?? unitFilesVerdict(vReport) ?? (v.status !== 0 ? `vitest exited with ${v.status}` : null);
  if (vWhy) fail(vWhy);

  const e2eJson = join(out, 'e2e.json');
  const e = spawnSync(process.execPath, [join(ROOT, 'scripts', 'e2e.mjs'), ...L3_E2E, ...(CI ? ciGrepInvert() : []), '--forbid-only', '--reporter=list,json'], { cwd: ROOT, stdio: 'inherit', env: { ...env, PLAYWRIGHT_JSON_OUTPUT_NAME: e2eJson } });
  const eReport = readJson(e2eJson);
  const eWhy = e2eVerdict(eReport) ?? censusVerdict(eReport, census) ?? (e.status !== 0 ? `the e2e run exited with ${e.status}` : null);
  if (eWhy) fail(eWhy);
  const marked = census.filter(([, s]) => s === 'failed').map(([id]) => id);
  console.log(`[${NAME}] passed: every unit and e2e test ran, none skipped; the census holds (${census.length} e2e tests; marked test.fail(): ${marked.join(', ') || 'none'}${CI ? `; left out: ${L3_CI_LEFT_OUT.map((l) => l.id).join(', ')}` : ''})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
