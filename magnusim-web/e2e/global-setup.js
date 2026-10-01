// Before the first test: when this run may mesh or solve in WSL, wait for the PC's
// WSL test lock (e2e/support/wsl-lock.mjs), so two such runs never share WSL's CPU.
// A run that cannot reach a WSL test (MAGNUSIM_E2E_WSL=0, or only specs that never
// mesh or solve) does not wait.
// SPDX-License-Identifier: GPL-3.0-or-later
import { acquireWslLock, mayRunWslTests, wslSpecFiles } from './support/wsl-lock.mjs';

export default async function globalSetup(config) {
  if (process.env.MAGNUSIM_E2E_WSL !== '1' || process.env.MAGNUSIM_E2E_LOCK === '0') return undefined;
  const at = process.argv.indexOf('test');
  const args = at >= 0 ? process.argv.slice(at + 1) : [];
  const testDir = config.projects[0]?.testDir || config.rootDir;
  if (!mayRunWslTests(args, wslSpecFiles(testDir))) return undefined;
  const release = await acquireWslLock({ what: `playwright test ${args.join(' ')}`.trim() });
  return async () => release();
}
