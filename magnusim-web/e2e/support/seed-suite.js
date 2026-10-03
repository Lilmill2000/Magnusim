// Runs a plugin suite's own seed module (appSuiteConfig's `seed`) after
// e2e/prepare-projects.js has seeded the core's projects. The module's default export
// gets the test projects root (MAGNUSIM_PROJECTS_ROOT, else e2e/.tmp-projects).
//   node e2e/support/seed-suite.js <seed module>
// SPDX-License-Identifier: GPL-3.0-or-later
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const E2E_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * @param {string} modulePath
 * @param {string} destRoot
 */
export async function runSuiteSeed(modulePath, destRoot) {
  const mod = await import(pathToFileURL(resolve(modulePath)).href);
  if (typeof mod.default !== 'function') {
    throw new Error(`${modulePath}: a seed module's default export is a function (destRoot) => void`);
  }
  await mod.default(destRoot);
}

const self = fileURLToPath(import.meta.url).toLowerCase();
if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === self) {
  const modulePath = process.argv[2];
  if (!modulePath) {
    process.stderr.write('usage: node e2e/support/seed-suite.js <seed module>\n');
    process.exit(2);
  }
  const root = process.env.MAGNUSIM_PROJECTS_ROOT || resolve(E2E_DIR, '.tmp-projects');
  await runSuiteSeed(modulePath, root);
}
