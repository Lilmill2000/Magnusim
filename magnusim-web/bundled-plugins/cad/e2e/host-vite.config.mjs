// The host app's own Vite config (magnusim-web/vite.config.js) with a private
// dependency cache. Used only by e2e/host-server.mjs. A checkout whose
// node_modules is shared (a junction to another checkout) would otherwise share
// Vite's cache (node_modules/.vite) with every other server started from it,
// and a re-optimization there blanks the other servers' pages.
// SPDX-License-Identifier: GPL-3.0-or-later
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import base from '../../../vite.config.js';

const here = dirname(fileURLToPath(import.meta.url));

export default {
  ...base,
  root: resolve(here, '..', '..', '..'),
  cacheDir: resolve(here, '..', '.cache', 'host-vite'),
};
