// @vitest-environment node
// gate:l2-cad fails, never passes by skipping (link review L3): without the
// app's Python it stops at once with the reason, and a report with a skipped
// test is a failure. The app's Python is found as scripts/app-python.mjs says:
// MAGNUSIM_PYTHON, else the app's venv, else a python / python3 on PATH that
// imports cfddesk and magnusim_sdk (CI has no venv).
// Owner: LINK.
// SPDX-License-Identifier: GPL-3.0-or-later
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findAppPython, venvPythons } from '../../scripts/app-python.mjs';
import { e2eVerdict, gateEnv, vitestVerdict } from '../../scripts/gate-l2-cad.mjs';
import { censusVerdict, ciGrepInvert, L3_CI_LEFT_OUT, L3_E2E, L3_E2E_CENSUS, L3_E2E_CI_CENSUS, L3_UNIT, missingInputs, unitFilesVerdict } from '../../scripts/gate-l3-cad.mjs';

const PLUGIN = join(__dirname, '..', '..');
/** The environment with the app's Python named and missing (no other name for it left over). */
const missingPythonEnv = (missing: string) => {
  const env: Record<string, string | undefined> = { ...process.env, MAGNUSIM_PYTHON: missing };
  delete env.CAD_E2E_PYTHON;
  return env;
};

describe('gate:l2-cad never soft-passes', () => {
  it('fails at once, saying why, when the app Python is missing', () => {
    const missing = join(PLUGIN, 'no-such-python', 'python.exe');
    const r = spawnSync(process.execPath, [join(PLUGIN, 'scripts', 'gate-l2-cad.mjs')], { cwd: PLUGIN, encoding: 'utf8', env: missingPythonEnv(missing), timeout: 60_000 });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`[gate:l2-cad] FAILED: the app's Python is missing: MAGNUSIM_PYTHON names no file (${missing}).`);
  });

  it('the package script is the gate script', () => {
    const pkg = JSON.parse(readFileSync(join(PLUGIN, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['test:gate:l2-cad']).toBe('node scripts/gate-l2-cad.mjs');
  });

  it('a skipped or todo unit test fails the gate', () => {
    expect(vitestVerdict({ success: true, numPassedTests: 30, numFailedTests: 0, numPendingTests: 2, numTodoTests: 0 })).toBe('2 unit test(s) were skipped: the gate runs every test');
    expect(vitestVerdict({ success: true, numPassedTests: 30, numFailedTests: 0, numPendingTests: 0, numTodoTests: 1 })).toMatch(/skipped/);
    expect(vitestVerdict({ success: false, numPassedTests: 29, numFailedTests: 1, numPendingTests: 0, numTodoTests: 0 })).toBe('1 unit test(s) failed');
    expect(vitestVerdict(null)).toBe('vitest wrote no report');
    expect(vitestVerdict({ success: true, numPassedTests: 0, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0 })).toBe('no unit test ran');
    expect(vitestVerdict({ success: true, numPassedTests: 30, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0 })).toBeNull();
  });

  it('a skipped e2e test fails the gate', () => {
    expect(e2eVerdict({ stats: { expected: 5, skipped: 1, unexpected: 0, flaky: 0 } })).toBe('1 e2e test(s) were skipped: the gate runs every test');
    expect(e2eVerdict({ stats: { expected: 5, skipped: 0, unexpected: 1, flaky: 0 } })).toBe('1 e2e test(s) failed');
    expect(e2eVerdict({})).toBe('Playwright wrote no report');
    expect(e2eVerdict({ stats: { expected: 0, skipped: 0, unexpected: 0, flaky: 0 } })).toBe('no e2e test ran');
    expect(e2eVerdict({ stats: { expected: 6, skipped: 0, unexpected: 0, flaky: 0 } })).toBeNull();
  });
});

describe('gate:l3-cad never soft-passes', () => {
  it('fails at once, saying why, when the app Python or the Vortex is missing', () => {
    const missing = join(PLUGIN, 'no-such-python', 'python.exe');
    const r = spawnSync(process.execPath, [join(PLUGIN, 'scripts', 'gate-l3-cad.mjs')], { cwd: PLUGIN, encoding: 'utf8', env: missingPythonEnv(missing), timeout: 60_000 });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`[gate:l3-cad] FAILED: the app's Python is missing: MAGNUSIM_PYTHON names no file (${missing}).`);
    const PY = '/opt/app/bin/python';
    const has = (p: string) => p === PY;
    const noProbe = () => null;
    expect(missingInputs({ MAGNUSIM_PYTHON: PY }, has, noProbe)).toBe("Daniel's Vortex STEP is not set: set CAD_E2E_VORTEX_STEP to the path of Vortex CFD Test.step (the include case runs on it).");
    expect(missingInputs({ MAGNUSIM_PYTHON: PY, CAD_E2E_VORTEX_STEP: 'nope.step' }, has, noProbe)).toBe('CAD_E2E_VORTEX_STEP names no file (nope.step).');
    expect(missingInputs({ MAGNUSIM_PYTHON: PY, CAD_E2E_VORTEX_STEP: 'v.step' }, (p) => p === PY || p === 'v.step', noProbe)).toBeNull();
    // CI: no venv, the backend in setup-python's interpreter on PATH.
    expect(missingInputs({ CAD_E2E_VORTEX_STEP: 'v.step' }, (p) => p === 'v.step', (cmd) => (cmd === 'python' ? '/opt/hostedtoolcache/Python/3.12/x64/bin/python' : null))).toBeNull();
    // Nothing anywhere: the gate fails with what it tried, never skips.
    expect(missingInputs({ CAD_E2E_VORTEX_STEP: 'v.step' }, (p) => p === 'v.step', noProbe)).toMatch(/^the app's Python is missing: none of MAGNUSIM_PYTHON, CAD_E2E_PYTHON is set, there is no venv \(.+\), and no python or python3 on PATH can import cfddesk and magnusim_sdk\. Set MAGNUSIM_PYTHON/);
  });

  it('the package script is the gate script, and it runs the exit hook tests and the exit e2e', () => {
    const pkg = JSON.parse(readFileSync(join(PLUGIN, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['test:gate:l3-cad']).toBe('node scripts/gate-l3-cad.mjs');
    expect(L3_UNIT).toContain('tests/link/leave.test.ts');
    expect(L3_UNIT).toContain('tests/link/adopt.test.ts');
    expect(L3_UNIT).toContain('tests/link/edit-open.test.ts');
    expect(L3_E2E).toEqual(['e2e/cad-link-exit.spec.ts', 'e2e/cad-edit-in-cad.spec.ts']);
  });

  it('runs the e2e with --forbid-only and vitest with --allowOnly=false: a stray .only fails the gate', () => {
    const src = readFileSync(join(PLUGIN, 'scripts', 'gate-l3-cad.mjs'), 'utf8');
    expect(src).toContain("'--forbid-only'");
    expect(src).toContain("'--allowOnly=false'");
  });

  it('the census is the specs: every test of cad-link-exit.spec.ts and cad-edit-in-cad.spec.ts by id, and exactly the test.fail() ones are expected to fail', () => {
    const spec = L3_E2E.map((f) => readFileSync(join(PLUGIN, f), 'utf8')).join('\n');
    const blocks = spec.split(/\n  test\(/).slice(1);
    const idOf = (b: string) => /^['"`](cad:(?:l3|edit)-[a-z0-9-]+)/.exec(b)?.[1] ?? '?';
    const failing = blocks.filter((b) => /^\s*test\.fail\(/m.test(b.split(/\n  \}\);/)[0])).map(idOf);
    expect(blocks.map(idOf).sort()).toEqual(L3_E2E_CENSUS.map(([id]) => id).sort());
    expect(failing.sort()).toEqual(L3_E2E_CENSUS.filter(([, s]) => s === 'failed').map(([id]) => id).sort());
  });

  it('no host-defect marker is left: no test.fail(), no defect allowance, every test expected to pass', () => {
    const spec = L3_E2E.map((f) => readFileSync(join(PLUGIN, f), 'utf8')).join('\n');
    expect(spec).not.toMatch(/test\.fail\(/);
    expect(spec).not.toMatch(/HOST.DEFECT/i);
    expect(L3_E2E_CENSUS.filter(([, s]) => s !== 'passed')).toEqual([]);
  });

  it('the census fails a report with a test missing, an unknown one, a test.fail() marker gone or new, or a test that did not run', () => {
    const census: [string, 'passed' | 'failed'][] = [
      ['cad:l3-a', 'passed'],
      ['cad:l3-b', 'failed'],
    ];
    const spec = (title: string, expectedStatus: string, status = expectedStatus === 'failed' ? 'failed' : 'passed') => ({ title, tests: [{ expectedStatus, status: 'expected', results: [{ status }] }] });
    const report = (...specs: unknown[]) => ({ suites: [{ title: 'cad-link-exit.spec.ts', specs: [], suites: [{ title: 'gate:l3-cad exit sync', specs }] }] });
    expect(censusVerdict(report(spec('cad:l3-a one', 'passed'), spec('cad:l3-b two', 'failed')), census)).toBeNull();
    expect(censusVerdict(report(spec('cad:l3-a one', 'passed')), census)).toBe('the census is short: cad:l3-b did not run (deleted, renamed or filtered out)');
    expect(censusVerdict(report(spec('cad:l3-a one', 'passed'), spec('cad:l3-b two', 'failed'), spec('cad:l3-c three', 'passed')), census)).toMatch(/^the census has tests it does not know: cad:l3-c/);
    expect(censusVerdict(report(spec('cad:l3-a one', 'passed'), spec('cad:l3-b two', 'passed')), census)).toMatch(/^cad:l3-b is no longer marked test\.fail\(\)/);
    expect(censusVerdict(report(spec('cad:l3-a one', 'failed'), spec('cad:l3-b two', 'failed')), census)).toMatch(/^cad:l3-a is marked to fail/);
    expect(censusVerdict(report(spec('cad:l3-a one', 'passed', 'skipped'), spec('cad:l3-b two', 'failed')), census)).toBe('cad:l3-a did not run');
    // A test.only under --forbid-only: Playwright runs nothing, and the census says so.
    expect(censusVerdict({ suites: [] }, census)).toMatch(/^the census is short/);
  });

  it("gate:l3-cad:ci: its own script, no Vortex needed, the Python still required, and nothing but Daniel's-file cases left out", () => {
    const pkg = JSON.parse(readFileSync(join(PLUGIN, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['test:gate:l3-cad:ci']).toBe('node scripts/gate-l3-cad.mjs --ci');
    const PY = '/opt/app/bin/python';
    const noProbe = () => null;
    expect(missingInputs({ MAGNUSIM_PYTHON: PY }, (p) => p === PY, noProbe, { ci: true })).toBeNull();
    expect(missingInputs({ MAGNUSIM_PYTHON: '/gone/python' }, () => false, noProbe, { ci: true })).toMatch(/^the app's Python is missing: MAGNUSIM_PYTHON names no file/);
    // The CI gate fails at once without the Python, as the full gate does.
    const missing = join(PLUGIN, 'no-such-python', 'python.exe');
    const r = spawnSync(process.execPath, [join(PLUGIN, 'scripts', 'gate-l3-cad.mjs'), '--ci'], { cwd: PLUGIN, encoding: 'utf8', env: missingPythonEnv(missing), timeout: 60_000 });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`[gate:l3-cad:ci] FAILED: the app's Python is missing: MAGNUSIM_PYTHON names no file (${missing}).`);
    // Left out: exactly the Vortex case, each with a reason and a twin that runs in CI.
    expect(L3_CI_LEFT_OUT.map((l) => l.id)).toEqual(['cad:l3-vortex-include', 'cad:edit-vortex']);
    const spec = L3_E2E.map((f) => readFileSync(join(PLUGIN, f), 'utf8')).join('\n');
    const blocks = spec.split(/\n  test\(/).slice(1);
    const idOf = (b: string) => /^['"`](cad:(?:l3|edit)-[a-z0-9-]+)/.exec(b)?.[1] ?? '?';
    const body = (id: string) => blocks.find((b) => idOf(b) === id)?.split(/\n  \}\);/)[0] ?? '';
    for (const l of L3_CI_LEFT_OUT) {
      expect(l.why).toMatch(/Daniel's/);
      expect(body(l.id), `${l.id} reads a private file`).toMatch(/VORTEX|BIG_STEP/);
      expect(L3_E2E_CI_CENSUS.map(([id]) => id)).toContain(l.twin);
      expect(body(l.twin), `${l.twin} reads no private file`).not.toMatch(/VORTEX|BIG_STEP/);
    }
    // Every test that reads a private file is left out; every other test is in the CI census.
    const ids = blocks.map(idOf);
    const privateIds = ids.filter((id) => /VORTEX|BIG_STEP/.test(body(id)));
    expect(privateIds.sort()).toEqual(L3_CI_LEFT_OUT.map((l) => l.id).sort());
    expect(L3_E2E_CI_CENSUS.map(([id]) => id).sort()).toEqual(ids.filter((id) => !privateIds.includes(id)).sort());
    expect(L3_E2E_CI_CENSUS.length).toBe(L3_E2E_CENSUS.length - L3_CI_LEFT_OUT.length);
    // Left out by --grep-invert on the title id: not run, and not reported as skipped.
    const [flag, pattern] = ciGrepInvert();
    expect(flag).toBe('--grep-invert');
    const re = new RegExp(pattern);
    expect(ids.filter((id) => re.test(`gate:l3-cad exit sync ${id} words`)).sort()).toEqual(['cad:edit-vortex', 'cad:l3-vortex-include']);
    // The CI census is checked like the full one: a left-out case that ran anyway is unknown to it.
    const pass = (id: string) => ({ title: `${id} words`, tests: [{ expectedStatus: 'passed', status: 'expected', results: [{ status: 'passed' }] }] });
    const report = (list: string[]) => ({ suites: [{ title: 'cad-link-exit.spec.ts', specs: [], suites: [{ title: 'gate:l3-cad exit sync', specs: list.map(pass) }] }] });
    expect(censusVerdict(report(L3_E2E_CI_CENSUS.map(([id]) => id)), L3_E2E_CI_CENSUS)).toBeNull();
    expect(censusVerdict(report(L3_E2E_CENSUS.map(([id]) => id)), L3_E2E_CI_CENSUS)).toMatch(/^the census has tests it does not know: cad:l3-vortex-include, cad:edit-vortex/);
    expect(censusVerdict(report(L3_E2E_CI_CENSUS.map(([id]) => id).filter((id) => id !== 'cad:l3-include')), L3_E2E_CI_CENSUS)).toMatch(/^the census is short: cad:l3-include/);
  });

  it('every L3 unit file must have run tests', () => {
    const files = ['tests/link/leave.test.ts', 'tests/link/controller.test.ts'];
    const ran = (name: string, n: number) => ({ name, assertionResults: Array.from({ length: n }, () => ({ status: 'passed' })) });
    expect(unitFilesVerdict({ testResults: [ran('C:\\x\\tests\\link\\leave.test.ts', 3), ran('/x/tests/link/controller.test.ts', 2)] }, files)).toBeNull();
    expect(unitFilesVerdict({ testResults: [ran('/x/tests/link/leave.test.ts', 3)] }, files)).toBe('no unit test ran in tests/link/controller.test.ts');
    expect(unitFilesVerdict({ testResults: [ran('/x/tests/link/leave.test.ts', 3), ran('/x/tests/link/controller.test.ts', 0)] }, files)).toBe('no unit test ran in tests/link/controller.test.ts');
  });
});

describe("the app's Python (scripts/app-python.mjs)", () => {
  const ROOT = '/w/python';
  const [venvWin, venvPosix] = venvPythons(ROOT);
  const probes: string[] = [];
  const probe = (answers: Record<string, string | null>) => (cmd: string) => {
    probes.push(cmd);
    return answers[cmd] ?? null;
  };
  const find = (env: Record<string, string | undefined>, files: string[], answers: Record<string, string | null> = {}) => {
    probes.length = 0;
    return findAppPython(env, { exists: (p) => files.includes(p), probe: probe(answers), pyRoot: ROOT });
  };

  it('MAGNUSIM_PYTHON first, over CAD_E2E_PYTHON, the venv and PATH', () => {
    expect(find({ MAGNUSIM_PYTHON: '/a/python', CAD_E2E_PYTHON: '/b/python' }, ['/a/python', '/b/python', venvWin], { python: '/c/python' })).toEqual({ python: '/a/python', from: 'MAGNUSIM_PYTHON', missing: '' });
    expect(find({ CAD_E2E_PYTHON: '/b/python' }, ['/b/python', venvWin])).toEqual({ python: '/b/python', from: 'CAD_E2E_PYTHON', missing: '' });
    expect(probes).toEqual([]);
  });

  it('a named Python that is not there is missing: no other one is tried in its place', () => {
    expect(find({ MAGNUSIM_PYTHON: '/gone/python' }, [venvWin], { python: '/c/python' })).toEqual({ python: null, from: 'MAGNUSIM_PYTHON', missing: 'MAGNUSIM_PYTHON names no file (/gone/python)' });
    expect(probes).toEqual([]);
    // A command name is run: its interpreter when it imports the backend, else missing.
    expect(find({ MAGNUSIM_PYTHON: 'python3' }, [], { python3: '/usr/bin/python3' })).toEqual({ python: '/usr/bin/python3', from: 'MAGNUSIM_PYTHON', missing: '' });
    expect(find({ MAGNUSIM_PYTHON: 'python3' }, [venvWin], {})).toEqual({ python: null, from: 'MAGNUSIM_PYTHON', missing: 'MAGNUSIM_PYTHON is python3, which cannot import cfddesk and magnusim_sdk' });
  });

  it('then the venv (Windows, then POSIX), without running anything', () => {
    expect(find({}, [venvWin, venvPosix], { python: '/c/python' })).toEqual({ python: venvWin, from: 'venv', missing: '' });
    expect(find({}, [venvPosix], { python: '/c/python' })).toEqual({ python: venvPosix, from: 'venv', missing: '' });
    expect(probes).toEqual([]);
  });

  it('then python, then python3 on PATH, the first that imports cfddesk and magnusim_sdk (CI)', () => {
    expect(find({}, [], { python: '/opt/py/bin/python', python3: '/usr/bin/python3' })).toEqual({ python: '/opt/py/bin/python', from: 'PATH', missing: '' });
    expect(find({}, [], { python3: '/usr/bin/python3' })).toEqual({ python: '/usr/bin/python3', from: 'PATH', missing: '' });
    expect(probes).toEqual(['python', 'python3']);
    const none = find({}, []);
    expect(none.python).toBeNull();
    expect(none.missing).toMatch(/^none of MAGNUSIM_PYTHON, CAD_E2E_PYTHON is set, there is no venv/);
  });

  it('the gates hand the Python they found to everything they start, as MAGNUSIM_PYTHON', () => {
    expect(gateEnv('/opt/py/bin/python', { PATH: '/bin' })).toMatchObject({ PATH: '/bin', MAGNUSIM_PYTHON: '/opt/py/bin/python', CAD_E2E_PYTHON: '/opt/py/bin/python', CAD_LINK_REQUIRE_PYTHON: '1' });
  });
});
