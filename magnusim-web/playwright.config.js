// The core's browser tests (e2e/). The server, the projects they seed, the WSL
// toolchain and lock are shared with the bundled plugins' suites: e2e/support/app-config.js.
import { join } from 'node:path';
import { WEB_ROOT, appSuiteConfig } from './e2e/support/app-config.js';

export default appSuiteConfig({ name: 'core', testDir: join(WEB_ROOT, 'e2e') });
