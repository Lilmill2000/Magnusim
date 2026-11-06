// The validation set's browser-test config (validation/README.md): the core's app server on
// MAGNUSIM_E2E_PORT with its own projects root, the WSL toolchain and the PC's WSL test lock,
// one run at a time. Run it with npm run test:validation; no default suite or CI job uses it.
// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WEB_ROOT, appSuiteConfig } from '../e2e/support/app-config.js';

// The app as it ships: its bundled plugins only. The core suite's server loads the test
// plugins of python/tests/fixtures/plugins, one of which adds a monitor on a "walls" patch to
// every solve (a case whose faces all have their own BCs has none, and the solve stops).
if (!process.env.MAGNUSIM_E2E_PLUGINS_DIR) {
  const none = join(tmpdir(), 'magnusim-validation-no-plugins');
  mkdirSync(none, { recursive: true });
  process.env.MAGNUSIM_E2E_PLUGINS_DIR = none;
}

export default appSuiteConfig({ name: 'validation', testDir: join(WEB_ROOT, 'validation', 'e2e') });
