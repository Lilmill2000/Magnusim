import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PYTHON, PY_ROOT } from '../python-env.js';
import { analysisKeyFor, analysisSupportsTimeDependency, steadyDefaultsFromRegistry } from '../registry-defaults.js';
import { TRANSIENT_DEFAULTS } from '../w30-transient.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const text = (rel) => readFileSync(join(root, rel), 'utf8');

function pythonDefaults() {
  const r = spawnSync(
    PYTHON,
    [
      '-c',
      'import json; from cfddesk.project.transient import TRANSIENT_DEFAULTS, STEADY_DEFAULTS; print(json.dumps({"t": TRANSIENT_DEFAULTS, "s": STEADY_DEFAULTS}))',
    ],
    { cwd: PY_ROOT, encoding: 'utf8', env: { ...process.env, PYTHONPATH: PY_ROOT } },
  );
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split(/\r?\n/).pop());
}

// gate:h7-defaults-single-source — one copy of the run-control defaults.
describe('run-control defaults have one source', () => {
  it('Node reads the transient and steady defaults Python defines', () => {
    const py = pythonDefaults();
    assert.deepEqual({ ...TRANSIENT_DEFAULTS }, py.t);
    assert.deepEqual({ ...steadyDefaultsFromRegistry() }, py.s);
  });

  it('the page keeps no copy of its own and Node no time-step estimate', () => {
    const runtime = text('src/workbench/runtime.js');
    assert.equal(runtime.includes('TRANSIENT_DEFAULTS_CLIENT'), false);
    assert.match(runtime, /window\.__CFD_TRANSIENT_DEFAULTS__/);
    // Nor of the steady iterations / write interval (200 / 50).
    assert.match(runtime, /window\.__CFD_STEADY_DEFAULTS__/);
    const page = runtime + text('src/workbench/catalogs.js');
    assert.equal(/endTime:\s*200\b|writeInterval:\s*50\b|\|\|\s*200,|\|\|\s*50,/.test(page), false);
    const w30 = text('scripts/w30-transient.js');
    assert.equal(/export function (estimateDeltaT|resolveTransientControl|flowThroughTime)/.test(w30), false);
    const w27 = text('scripts/w27-solve.js');
    assert.equal(w27.includes('transientControlFor'), false);
    assert.match(w27, /'--time-dependency'/);
    assert.match(w27, /'--transient-json'/);
    assert.match(w27, /analysis\.run_preview/);
  });
});

describe('analysis key follows the time dependency', () => {
  it('swaps to the sibling key', () => {
    assert.equal(analysisKeyFor('incompressible_steady', 'Transient'), 'incompressible_transient');
    assert.equal(analysisKeyFor('incompressible_transient', 'Steady-state'), 'incompressible_steady');
    assert.equal(analysisKeyFor('Incompressible', 'Transient'), 'incompressible_transient');
    assert.equal(analysisKeyFor('', 'Steady-state'), 'incompressible_steady');
    assert.equal(analysisSupportsTimeDependency('incompressible_steady', 'Transient'), true);
  });

  it('an unknown key with no sibling is not supported', () => {
    assert.equal(analysisKeyFor('no_such_steady', 'Transient'), 'no_such_steady');
    assert.equal(analysisSupportsTimeDependency('no_such_steady', 'Transient'), false);
  });
});
