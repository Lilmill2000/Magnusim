/**
 * The CAD edition's registry (scripts/server/cad-edition/registry.js): what the Python
 * worker answers with only CAD installed, less what the edition has none of. The
 * committed file is the worker's own answer (gen:cad-edition:check runs the worker),
 * so the edition's registry cannot drift from Magnusim's.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WEB_ROOT } from '../../python-env.js';
import { edition, isCadEdition } from '../../edition.js';
import { pluginRow, pluginsList, registryDescribe } from '../cad-edition/registry.js';

const KINDS = ['analysis', 'solver', 'mesher', 'bc', 'bc_family', 'material', 'monitor', 'filter'];

describe('edition', () => {
  it('is Magnusim unless MAGNUSIM_EDITION is cad', () => {
    const was = process.env.MAGNUSIM_EDITION;
    try {
      for (const [value, want] of [
        [undefined, 'magnusim'],
        ['', 'magnusim'],
        ['magnusim', 'magnusim'],
        ['full', 'magnusim'],
        ['cad', 'cad'],
        [' CAD ', 'cad'],
      ]) {
        if (value === undefined) delete process.env.MAGNUSIM_EDITION;
        else process.env.MAGNUSIM_EDITION = value;
        assert.equal(edition(), want, `MAGNUSIM_EDITION=${JSON.stringify(value)}`);
        assert.equal(isCadEdition(), want === 'cad');
      }
    } finally {
      if (was === undefined) delete process.env.MAGNUSIM_EDITION;
      else process.env.MAGNUSIM_EDITION = was;
    }
  });
});

describe('CAD edition registry', () => {
  it('describes CAD alone: no analyses, meshers, BCs, materials or filters, nothing required', () => {
    const doc = registryDescribe();
    for (const kind of KINDS) assert.deepEqual(doc[kind], [], kind);
    assert.deepEqual(
      doc.plugins.map((p) => p.key),
      ['cad'],
    );
    assert.equal(doc.plugins[0].links_geometry, false, 'no project geometries to link');
    assert.deepEqual(doc.required_missing, []);
    assert.deepEqual(doc.missing, []);
    assert.equal(doc.default_analysis, null);
  });

  it('lists CAD on, with its start actions and the manifest version, and no geometry actions', () => {
    const { ok, plugins } = pluginsList();
    assert.equal(ok, true);
    assert.equal(plugins.length, 1);
    const [cad] = plugins;
    assert.equal(cad.key, 'cad');
    assert.equal(cad.status, 'enabled');
    assert.equal(cad.enabled, true);
    assert.equal(cad.tier, 'bundled');
    assert.equal(cad.license, 'GPL-3.0-or-later');
    const manifest = readFileSync(join(WEB_ROOT, 'bundled-plugins', 'cad', 'manifest.toml'), 'utf8');
    assert.equal(cad.version, /^version\s*=\s*"([^"]+)"/m.exec(manifest)?.[1]);
    assert.deepEqual(cad.workspaces.map((w) => w.key), ['part']);
    assert.ok(cad.start_actions.some((a) => a.places.includes('home')), 'New design on Home');
    assert.deepEqual(cad.geometry_actions, []);
  });

  it('hands out copies', () => {
    pluginsList().plugins[0].name = 'changed';
    registryDescribe().plugins.length = 0;
    assert.equal(pluginRow('cad')?.name, 'Magnusim CAD');
    assert.equal(registryDescribe().plugins.length, 1);
    assert.equal(pluginRow('incompressible_flow'), null);
  });

  it('is what the Python worker answers today (gen:cad-edition:check)', () => {
    const r = spawnSync(process.execPath, [join(WEB_ROOT, 'scripts', 'gen-cad-edition.mjs'), '--check'], {
      cwd: WEB_ROOT,
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr || r.stdout);
  });
});
