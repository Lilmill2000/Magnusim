// gate:l2-cad (npm run test:gate:l2-cad): the LINK gate, which must FAIL, never
// pass by skipping (link review L3: without the app's Python the checker tests
// were skipped and the gate still went green).
//   1. The app's Python (CAD_E2E_PYTHON, default ../../python/.venv/Scripts/python.exe)
//      must be there: without it the gate stops at once and says so.
//   2. vitest tests/kernel/kernel-link.test.ts tests/link, with
//      CAD_LINK_REQUIRE_PYTHON=1 (the tests fail instead of skipping), and its
//      JSON report must show no skipped or todo test.
//   3. The link e2e (cad-link.spec.ts, cad-link-plugins.spec.ts) through
//      scripts/e2e.mjs, and its JSON report must show no skipped test.
// Owner: LINK.
// SPDX-License-Identifier: GPL-3.0-or-later
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The app's Python the checker tests run (the same rule as the tests). */
export function gatePython(env = process.env) {
  return env.CAD_E2E_PYTHON || join(ROOT, '..', '..', 'python', '.venv', 'Scripts', 'python.exe');
}

/** vitest's JSON report: why the gate fails, or null. */
export function vitestVerdict(report) {
  if (!report || typeof report !== 'object') return 'vitest wrote no report';
  const skipped = (report.numPendingTests ?? 0) + (report.numTodoTests ?? 0);
  if (report.numFailedTests) return `${report.numFailedTests} unit test(s) failed`;
  if (skipped) return `${skipped} unit test(s) were skipped: the gate runs every test`;
  if (!report.numPassedTests) return 'no unit test ran';
  if (report.success === false) return 'vitest did not succeed';
  return null;
}

/** Playwright's JSON report: why the gate fails, or null. */
export function e2eVerdict(report) {
  const st = report && typeof report === 'object' ? report.stats : null;
  if (!st) return 'Playwright wrote no report';
  if (st.unexpected) return `${st.unexpected} e2e test(s) failed`;
  if (st.skipped) return `${st.skipped} e2e test(s) were skipped: the gate runs every test`;
  if (!st.expected && !st.flaky) return 'no e2e test ran';
  return null;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function fail(message) {
  console.error(`[gate:l2-cad] FAILED: ${message}`);
  process.exit(1);
}

function main() {
  const python = gatePython();
  if (!existsSync(python)) fail(`the app's Python is missing (looked for ${python}); the link checker tests cannot run. Set CAD_E2E_PYTHON to the core venv's python.exe.`);
  const out = join(ROOT, '.cache', 'gate-l2-cad');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const env = { ...process.env, CAD_E2E_PYTHON: python, CAD_LINK_REQUIRE_PYTHON: '1' };

  const vitestJson = join(out, 'vitest.json');
  const vitestCli = join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');
  const v = spawnSync(process.execPath, [vitestCli, 'run', 'tests/kernel/kernel-link.test.ts', 'tests/link', '--reporter=default', '--reporter=json', `--outputFile.json=${vitestJson}`], { cwd: ROOT, stdio: 'inherit', env });
  const vWhy = vitestVerdict(readJson(vitestJson)) ?? (v.status !== 0 ? `vitest exited with ${v.status}` : null);
  if (vWhy) fail(vWhy);

  const e2eJson = join(out, 'e2e.json');
  const e = spawnSync(process.execPath, [join(ROOT, 'scripts', 'e2e.mjs'), 'e2e/cad-link.spec.ts', 'e2e/cad-link-plugins.spec.ts', '--reporter=list,json'], { cwd: ROOT, stdio: 'inherit', env: { ...env, PLAYWRIGHT_JSON_OUTPUT_NAME: e2eJson } });
  const eWhy = e2eVerdict(readJson(e2eJson)) ?? (e.status !== 0 ? `the e2e run exited with ${e.status}` : null);
  if (eWhy) fail(eWhy);
  console.log('[gate:l2-cad] passed: every unit and e2e test ran, none skipped');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
