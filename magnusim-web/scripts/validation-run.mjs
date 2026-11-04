// npm run test:validation: the validation set (validation/README.md), real meshes and solves
// through the app's routes, one run at a time under the PC's WSL test lock, then its report.
//
//   npm run test:validation                               every case and variant at 8 cores, then the report
//   npm run test:validation -- --case c1 --variant standard --cores 4
//   npm run test:validation -- --coarse                   each case's coarse settings (results-coarse/, no report)
//   npm run test:validation -- --mesh-only                mesh and record the mesh facts only (results-probe/, no report)
//   npm run test:validation -- --case c1 --variant standard --mesh '{"hex_element_core":false}'
//                                                         mesh settings changed by hand (results-probe/, no report)
//   npm run test:validation -- --case c1 --variant standard --study '{"grad_limiter":"none"}'
//                                                         study settings changed by hand (results-probe/, no report)
//   npm run test:validation -- --no-report                skip the report
// Anything else goes to Playwright (e.g. --reporter=line). MAGNUSIM_E2E_PORT picks the app's port.
// SPDX-License-Identifier: GPL-3.0-or-later
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The run's environment and Playwright arguments from the command line. */
export function parseValidationArgs(argv, base = process.env) {
  const env = { ...base, MAGNUSIM_E2E_VALIDATION: '1', MAGNUSIM_E2E_WSL: base.MAGNUSIM_E2E_WSL === '0' ? '0' : '1' };
  delete env.MAGNUSIM_E2E_SETTLED;
  const cases = [];
  const variants = [];
  const passthrough = [];
  let report = true;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [name, inline] = a.startsWith('--') && a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, null];
    const value = () => (inline !== null ? inline : argv[++i]);
    if (name === '--case') cases.push(...value().split(','));
    else if (name === '--variant') variants.push(...value().split(','));
    else if (name === '--cores') env.MAGNUSIM_VALIDATION_CORES = String(Number(value()) || 8);
    else if (name === '--coarse') env.MAGNUSIM_VALIDATION_COARSE = '1';
    else if (name === '--mesh-only') env.MAGNUSIM_VALIDATION_MESH_ONLY = '1';
    else if (name === '--mesh') env.MAGNUSIM_VALIDATION_MESH = String(value());
    else if (name === '--study') env.MAGNUSIM_VALIDATION_STUDY = String(value());
    else if (name === '--no-report') report = false;
    else passthrough.push(a);
  }
  if (cases.length) env.MAGNUSIM_VALIDATION_CASES = cases.join(',');
  if (variants.length) env.MAGNUSIM_VALIDATION_VARIANTS = variants.join(',');
  // Coarse runs go to results-coarse/, mesh-only runs and changed mesh or study settings
  // to results-probe/: nothing the report reads, so no report after them.
  if (env.MAGNUSIM_VALIDATION_COARSE === '1' || env.MAGNUSIM_VALIDATION_MESH_ONLY === '1' || env.MAGNUSIM_VALIDATION_MESH || env.MAGNUSIM_VALIDATION_STUDY) report = false;
  const args = [join(WEB_ROOT, 'node_modules', '@playwright', 'test', 'cli.js'), 'test', '-c', 'validation/playwright.config.js', ...passthrough];
  return { env, args, report };
}

export function main(argv = process.argv.slice(2)) {
  const { env, args, report } = parseValidationArgs(argv);
  console.log(`[validation] playwright ${args.slice(1).join(' ')}`);
  const run = spawnSync(process.execPath, args, { cwd: WEB_ROOT, env, stdio: 'inherit' });
  let code = run.status ?? 1;
  if (report) {
    const r = spawnSync(process.execPath, [join(WEB_ROOT, 'scripts', 'validation-report.mjs')], { cwd: WEB_ROOT, stdio: 'inherit' });
    if (r.status !== 0) code = code || r.status || 1;
  }
  return code;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main());
