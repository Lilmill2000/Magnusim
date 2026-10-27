/**
 * Regenerate scripts/generated/cad-edition-registry.json: the registry the CAD
 * edition's server answers (registry.describe, plugins.list), which has no Python.
 *
 * python/tools/cad_edition_dump.py asks the real worker methods with only
 * bundled-plugins/cad installed; this keeps the CAD rows and drops what the
 * edition has none of: the core's builtin meshers and filters (no simulation),
 * the required simulation plugin it reports missing, and CAD's geometry links
 * (no project geometries: Edit in CAD and LINK are Magnusim's).
 *
 * --check: fail (exit 1) when the committed file differs (run npm run gen:cad-edition).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { PYTHON, pyTool, WEB_ROOT } from './python-env.js';

const outPath = join(WEB_ROOT, 'scripts', 'generated', 'cad-edition-registry.json');
const KINDS = ['analysis', 'solver', 'mesher', 'bc', 'bc_family', 'material', 'monitor', 'filter'];
const PLUGINS = new Set(['cad']);

function cadEditionRegistry(dump) {
  const describe = { ...dump.describe };
  for (const kind of KINDS) describe[kind] = [];
  describe.plugins = (dump.describe.plugins || [])
    .filter((p) => PLUGINS.has(p.key))
    .map((p) => ({ ...p, links_geometry: false }));
  describe.missing = [];
  describe.required_missing = [];
  describe.default_analysis = null;
  const plugins = (dump.plugins || [])
    .filter((p) => PLUGINS.has(p.key))
    .map((p) => ({ ...p, geometry_actions: [] }));
  for (const p of plugins) {
    if (p.status !== 'enabled') throw new Error(`${p.key} did not load: ${p.error || p.status}`);
  }
  if (plugins.length !== PLUGINS.size) throw new Error('the dump has no CAD plugin row');
  return { describe, plugins };
}

function main() {
  const r = spawnSync(PYTHON, [pyTool('cad_edition_dump.py')], { encoding: 'utf8', cwd: WEB_ROOT, maxBuffer: 64 << 20 });
  if (r.status !== 0) {
    console.error(r.stderr || r.stdout || 'cad_edition_dump failed');
    process.exit(r.status || 1);
  }
  const text = `${JSON.stringify(cadEditionRegistry(JSON.parse(r.stdout)), null, 2)}\n`;
  if (process.argv.includes('--check')) {
    const committed = existsSync(outPath) ? readFileSync(outPath, 'utf8') : '';
    if (committed !== text) {
      console.error(`${outPath} is out of date; run npm run gen:cad-edition`);
      process.exit(1);
    }
    console.log('cad edition registry check ok');
    return;
  }
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, text);
  console.log(`wrote ${outPath}`);
}

main();
