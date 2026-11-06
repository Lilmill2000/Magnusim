// The validation set's driver, its pure parts (validation/e2e/driver.mjs): the face-table
// check, the read-back comparison, the route parameters it builds; and npm run
// test:validation's options (scripts/validation-run.mjs). The driver's HTTP flow itself runs
// in the validation suite (npm run test:validation).
// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  estimateTooBig,
  faceTableProblems,
  gitFacts,
  latestTime,
  liveMesh,
  pointsParam,
  quantityLine,
  readBackProblems,
  resultControlsWithBcs,
  runOf,
  runProgress,
  runSettingsSent,
  sharedMeshOf,
} from '../../validation/e2e/driver.mjs';
import { parseValidationArgs } from '../validation-run.mjs';

const PLAN_FACES = [
  { id: 1, body: 1, area_mm2: 18849.555922, centroid_mm: [150, 0, 0], normal: [0, 0, -1], surface_type: 'Cylinder' },
  { id: 2, body: 1, area_mm2: 314.159265, centroid_mm: [300, 0, 0], normal: [1, 0, 0], surface_type: 'Plane' },
];
const APP_FACES = [
  { id: 1, area: 18849.5559215, centroid: [150, 1e-13, 6e-13], normal: [0, 2e-13, -1], surface_type: 'Cylinder', body: 1 },
  { id: 2, area: 314.1592653589793, centroid: [300, 0, 0], normal: [1, 0, 0], surface_type: 'Plane', body: 1 },
];

test('the plan\'s face table matches the app\'s within its tolerances, and a difference is named', () => {
  assert.deepEqual(faceTableProblems(PLAN_FACES, APP_FACES), []);
  const moved = APP_FACES.map((f) => (f.id === 2 ? { ...f, centroid: [299.9, 0, 0] } : f));
  assert.match(faceTableProblems(PLAN_FACES, moved).join(), /face 2: centroid \[299\.9,0,0\] mm/);
  const flipped = APP_FACES.map((f) => (f.id === 2 ? { ...f, normal: [-1, 0, 0] } : f));
  assert.match(faceTableProblems(PLAN_FACES, flipped).join(), /face 2: normal/);
  const bigger = APP_FACES.map((f) => (f.id === 1 ? { ...f, area: 18900 } : f));
  assert.match(faceTableProblems(PLAN_FACES, bigger).join(), /face 1: area 18900/);
  // Renumbered or extra faces.
  assert.match(faceTableProblems(PLAN_FACES, [APP_FACES[0]]).join(), /the app has 1 faces, the plan 2.*face 2: not in the app's table/);
});

test('a read-back lists every key the stored record does not hold as sent', () => {
  const sent = { name: 'Inlet', value: 1.0, faces: ['face 3@Body1'], advanced: { mesh_engine: 'standard' }, wall_type: 'No-slip' };
  assert.deepEqual(readBackProblems(sent, { ...sent, value: 1, id: 'bc-1', extra: true }), []);
  assert.deepEqual(readBackProblems({ x: 2e-4 }, { x: 0.0002 + 1e-15 }), []);
  assert.deepEqual(readBackProblems(sent, { ...sent, value: 5, faces: [], advanced: { mesh_engine: 'snappy_hexdominant' }, wall_type: 'Slip' }), [
    'value: sent 1, stored 5',
    'faces: sent ["face 3@Body1"], stored []',
    'advanced.mesh_engine: sent "standard", stored "snappy_hexdominant"',
    'wall_type: sent "No-slip", stored "Slip"',
  ]);
  assert.deepEqual(readBackProblems({ n: 4 }, {}), ['n: sent 4, stored undefined']);
});

test('the route parameters and the answers it reads', () => {
  assert.equal(pointsParam([[0, 0, 0], [0.3, 0, 1e-3]]), '0,0,0;0.3,0,0.001');
  assert.equal(latestTime({ times: ['0', '142'] }), '142');
  assert.equal(latestTime({ times: [0, 50, 100, 75] }), 100);
  assert.equal(latestTime({ times: ['0'] }), null);
  assert.equal(latestTime({}), null);
  assert.deepEqual(liveMesh({ mesh: { live_mesh_result: { status: 'done' } } }), { status: 'done' });
  assert.deepEqual(liveMesh({}), {});
  const answer = { run: { run_id: 'a', status: 'done' }, runs: [{ id: 'a' }, { id: 'b', status: 'draft' }] };
  assert.equal(runOf(answer, 'a').status, 'done');
  assert.equal(runOf(answer, 'b').status, 'draft');
  assert.equal(runOf(answer, 'c'), null);
  assert.equal(runProgress({ iteration: 42 }), '42');
  assert.equal(runProgress({ progress: { time: 0.5 } }), '0.5');
  assert.equal(runProgress({}), '');
  // A transient run's iteration is its time rounded: its time and steps show it moving (the stall check).
  const before = runProgress({ iteration: 1, sim_time: 1.2345, n_steps: 9000 });
  const after = runProgress({ iteration: 1, sim_time: 1.4012, n_steps: 10210 });
  assert.equal(before, '1.2345 (9000 steps)');
  assert.notEqual(before, after);
  assert.equal(runProgress({ progress: { sim_time: 0.25, n_steps: 12 } }), '0.25 (12 steps)');
  assert.equal(runProgress({ iteration: 7, n_steps: 7 }), '7 (7 steps)');
});

test('a Forces monitor on a BC gets that BC\'s id; a transient run reads back its transient block', () => {
  const controls = [
    { id: 'rc-forces', name: 'Cylinder', monitor_type: 'forces', boundaries: ['@bc:Cylinder', '@walls'] },
    { id: 'rc-wake', name: 'Wake axis', monitor_type: 'probe', points: [[0.01, 0, 0]] },
  ];
  const { controls: out, missing } = resultControlsWithBcs(controls, { Cylinder: 'bc-7', 'Far field': 'bc-1' });
  assert.deepEqual(missing, []);
  assert.deepEqual(out[0].boundaries, ['bc-7', '@walls']);
  assert.equal(out[1], controls[1]);
  // The plan's record is not changed; a BC the run has no id of is named.
  assert.deepEqual(controls[0].boundaries, ['@bc:Cylinder', '@walls']);
  assert.deepEqual(resultControlsWithBcs(controls, {}).missing, ['Cylinder']);
  assert.deepEqual(resultControlsWithBcs(undefined, {}), { controls: [], missing: [] });
  // Steady: the iteration limit, write interval and cores; transient: its block as sent.
  assert.deepEqual(runSettingsSent({ name: 'V', endTime: 3000, writeInterval: 3000, cores: 4, result_controls: [] }), { endTime: 3000, writeInterval: 3000, cores: 4 });
  const transient = { end_time: 3, write_count: 50, time_step_mode: 'adjustable', max_co: 1, average_from: 1.5 };
  const sent = runSettingsSent({ name: 'V', cores: 8, transient, result_controls: [] });
  assert.deepEqual(sent, { cores: 8, transient });
  assert.deepEqual(readBackProblems(sent, { cores: 8, transient: { ...transient, write_interval: 0.06, delta_t: 1e-4 } }), []);
  assert.deepEqual(readBackProblems(sent, { cores: 8, transient: { ...transient, write_count: 30 } }), ['transient.write_count: sent 50, stored 30']);
});

test('npm run test:validation: its options become the suite\'s gate and knobs', () => {
  const o = parseValidationArgs(['--case', 'c1', '--variant=standard', '--cores', '4', '--reporter=line'], { PATH: 'x', MAGNUSIM_E2E_SETTLED: '1' });
  assert.equal(o.env.MAGNUSIM_E2E_VALIDATION, '1');
  assert.equal(o.env.MAGNUSIM_E2E_WSL, '1');
  assert.equal(o.env.MAGNUSIM_E2E_SETTLED, undefined);
  assert.equal(o.env.MAGNUSIM_VALIDATION_CASES, 'c1');
  assert.equal(o.env.MAGNUSIM_VALIDATION_VARIANTS, 'standard');
  assert.equal(o.env.MAGNUSIM_VALIDATION_CORES, '4');
  assert.equal(o.report, true);
  assert.deepEqual(o.args.slice(1), ['test', '-c', 'validation/playwright.config.js', '--reporter=line']);
  // Coarse and mesh-only runs make nothing the report reads.
  assert.equal(parseValidationArgs(['--coarse']).report, false);
  assert.equal(parseValidationArgs(['--coarse']).env.MAGNUSIM_VALIDATION_COARSE, '1');
  assert.equal(parseValidationArgs(['--mesh-only']).report, false);
  // Mesh settings changed by hand: a probe (results-probe/), no report either.
  const probe = parseValidationArgs(['--case', 'c1', '--mesh', '{"hex_element_core":false}']);
  assert.equal(probe.env.MAGNUSIM_VALIDATION_MESH, '{"hex_element_core":false}');
  assert.equal(probe.report, false);
  const studyProbe = parseValidationArgs(['--study', '{"grad_limiter":"none"}']);
  assert.equal(studyProbe.env.MAGNUSIM_VALIDATION_STUDY, '{"grad_limiter":"none"}');
  assert.equal(studyProbe.report, false);
  assert.equal(parseValidationArgs(['--no-report']).report, false);
  // WSL turned off by hand stays off (the suite then fails: it needs WSL).
  assert.equal(parseValidationArgs([], { MAGNUSIM_E2E_WSL: '0' }).env.MAGNUSIM_E2E_WSL, '0');
});

test("a quantity's log line: its error in per cent, or in its own unit where the reference is zero", () => {
  const ref = (value) => ({ value });
  assert.equal(quantityLine({ key: 'f', value: 0.02234, reference: ref(0.0211), error: { abs: 0.00124, rel_pct: 5.877 }, verdict: 'report_only' }), 'f 0.022340 vs 0.0211 (5.88 %, report_only)');
  // A difference whose reference is zero (the cavity's profiles) has no relative error.
  assert.equal(quantityLine({ key: 'u_rms', unit: 'U_lid', value: 0.0042, reference: ref(0), error: { abs: 0.0042, rel_pct: null }, verdict: 'report_only' }), 'u_rms 0.0042000 vs 0 (+0.00420 U_lid, report_only)');
  assert.equal(quantityLine({ key: 'x', value: -0.5, reference: ref(0), error: { abs: -0.5, rel_pct: null }, verdict: 'fail' }), 'x -0.50000 vs 0 (-0.500, fail)');
  assert.equal(quantityLine({ key: 'u_rms', value: null, reference: ref(0), error: null, verdict: 'missing' }), 'u_rms missing vs 0 (-, missing)');
});

test("a run uses an earlier variant's mesh only when that run made it from the same plan", () => {
  const plan = { mesh_from: { variant: 'hexdominant_sst', key: 'k1' }, coarse: false };
  const ids = { project_id: 'p', geometry_id: 'g', simulation_id: 's', mesh_id: 'm', mesh_case_dir: 'C:/x', run_id: 'r' };
  const driver = { ids, steps: [{ step: 'mesh' }, { step: 'mesh-facts' }, { step: 'run-settings' }], failed_step: null };
  const ok = sharedMeshOf(plan, { plan: { mesh_key: 'k1', coarse: false }, driver });
  assert.deepEqual(ok, { ids: { project_id: 'p', geometry_id: 'g', simulation_id: 's', mesh_id: 'm', mesh_case_dir: 'C:/x' }, variant: 'hexdominant_sst' });
  // A later solve that failed still leaves its mesh.
  assert.ok(sharedMeshOf(plan, { plan: { mesh_key: 'k1' }, driver: { ...driver, failed_step: 'solve' } }).ids);
  assert.match(sharedMeshOf({}, null).reason, /meshes its own/);
  assert.match(sharedMeshOf(plan, null).reason, /no run of hexdominant_sst/);
  assert.match(sharedMeshOf(plan, { plan: { mesh_key: 'k2' }, driver }).reason, /not the same geometry, fluid, BCs and mesh/);
  assert.match(sharedMeshOf(plan, { plan: { mesh_key: 'k1', coarse: true }, driver }).reason, /was coarse/);
  assert.match(sharedMeshOf(plan, { plan: { mesh_key: 'k1' }, driver: { ...driver, ids: { project_id: 'p' } } }).reason, /left no mesh/);
  assert.match(sharedMeshOf(plan, { plan: { mesh_key: 'k1' }, driver: { ...driver, failed_step: 'mesh', steps: [{ step: 'mesh' }] } }).reason, /before its mesh was done/);
});

test('a plan whose estimated mesh is over the cap is not generated', () => {
  const plan = { mesh: { estimate: { n_cells: 3_500_000 } } };
  assert.match(estimateTooBig(plan, 2_000_000), /about 3500000 cells, over the 2000000 allowed/);
  assert.equal(estimateTooBig(plan, 5_000_000), '');
  assert.equal(estimateTooBig(plan, 0), '');
  assert.equal(estimateTooBig({ mesh: {} }, 2_000_000), '');
});

test("a rerun does not count the set's own outputs as changes to the tree; any other change does, an untracked file of the app's too", (t) => {
  const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (git(process.cwd(), '--version').status !== 0) {
    t.skip('no git');
    return;
  }
  const repo = mkdtempSync(join(tmpdir(), 'mg-val-git-'));
  try {
    const web = join(repo, 'magnusim-web');
    const run = join(web, 'validation', 'results', 'c1', 'hexdominant');
    mkdirSync(run, { recursive: true });
    mkdirSync(join(repo, 'docs', 'validation'), { recursive: true });
    writeFileSync(join(run, 'result.json'), '{}\n');
    writeFileSync(join(run, 'plan.json'), '{}\n');
    writeFileSync(join(web, 'validation', 'VALIDATION.md'), '# V\n');
    writeFileSync(join(repo, 'docs', 'validation', 'index.html'), '<p>\n');
    writeFileSync(join(web, 'app.js'), 'x\n');
    git(repo, 'init', '-q');
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A');
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'one');
    assert.equal(gitFacts(web).dirty, false);
    // What a rerun does: the old result deleted, the plan, the report and the page rewritten.
    unlinkSync(join(run, 'result.json'));
    writeFileSync(join(run, 'plan.json'), '{"x":1}\n');
    writeFileSync(join(web, 'validation', 'VALIDATION.md'), '# W\n');
    writeFileSync(join(repo, 'docs', 'validation', 'index.html'), '<p>2\n');
    const clean = gitFacts(web);
    assert.equal(clean.dirty, false);
    assert.doesNotMatch(String(clean.describe), /dirty/);
    // A new result folder the run writes, and untracked files beside the app (the root's logs), are not changes.
    mkdirSync(join(run, '..', 'standard'), { recursive: true });
    writeFileSync(join(run, '..', 'standard', 'result.json'), '{}\n');
    writeFileSync(join(repo, 'gates-1.log'), 'x\n');
    assert.equal(gitFacts(web).dirty, false);
    // An untracked file of the app's that git ignores is not a change; one it does not ignore is.
    writeFileSync(join(web, '.gitignore'), '*.tmp\n');
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', 'magnusim-web/.gitignore');
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'ignore');
    writeFileSync(join(web, 'scratch.tmp'), 'x\n');
    assert.equal(gitFacts(web).dirty, false);
    mkdirSync(join(web, 'lib'), { recursive: true });
    writeFileSync(join(web, 'lib', 'new_module.py'), 'x = 1\n');
    const untracked = gitFacts(web);
    assert.equal(untracked.dirty, true, 'an untracked module of the app is a change');
    assert.match(String(untracked.describe), /-dirty$/);
    unlinkSync(join(web, 'lib', 'new_module.py'));
    assert.equal(gitFacts(web).dirty, false);
    // A change to the app's own code is a change.
    writeFileSync(join(web, 'app.js'), 'y\n');
    const dirty = gitFacts(web);
    assert.equal(dirty.dirty, true);
    assert.match(String(dirty.describe), /-dirty$/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
