// The CAD edition's test server: Magnusim CAD from source (scripts/server/cad-edition/serve.mjs
// --dev) on the port given, with an emptied projects folder and prefs of its own, no Python to
// find (MAGNUSIM_PYTHON names a missing file, Python's folders are off PATH) and the spawn
// guard on. playwright.cad.config.js starts it. Outside e2e/ so the core suite never runs these.
// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';

const root = process.env.MAGNUSIM_PROJECTS_ROOT;
const prefs = process.env.MAGNUSIM_LOCAL_JSON;
if (!root || !prefs) throw new Error('MAGNUSIM_PROJECTS_ROOT and MAGNUSIM_LOCAL_JSON must be set');
rmSync(root, { recursive: true, force: true, maxRetries: 5 });
mkdirSync(root, { recursive: true });
writeFileSync(prefs, '{}\n');
process.env.MAGNUSIM_PYTHON = join(root, 'no-python.exe');
process.env.PATH = String(process.env.PATH || '')
  .split(delimiter)
  .filter((dir) => !/python|windowsapps/i.test(dir))
  .join(delimiter);

const { startCadServer } = await import('../scripts/server/cad-edition/serve.mjs');
const port = Number(process.argv[2] || 8092);
await startCadServer({ port, dev: true });
console.log(`Magnusim CAD test server on http://127.0.0.1:${port}/`);
