/**
 * gate:h2-one-hydrate — GET /api/project/hydrate is one project.hydrate worker call.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('gate:h2-one-hydrate', () => {
  it('calls project.hydrate once and does not import w16-w27 getters', () => {
    const hydrate = readFileSync(join(scriptsRoot, 'project-hydrate.js'), 'utf8');
    const live = readFileSync(join(scriptsRoot, 'server', 'live-routes.js'), 'utf8');
    const calls = hydrate.match(/workerCall\('project\.hydrate'/g) || [];
    assert.equal(calls.length, 1);
    assert.match(hydrate, /project\.tree/);
    assert.equal(/from\s+['"]\.\/w(1[6-9]|2[0-7])/.test(hydrate), false);
    assert.equal(/getSimulation|getMaterials|getBcs|getMesh/.test(hydrate), false);
    const route = live.slice(live.indexOf("'/api/project/hydrate'"));
    const handler = route.slice(0, route.indexOf('router.add'));
    assert.equal(handler.includes("call('project.hydrate'"), false);
    assert.match(handler, /workerCall/);
  });
});
