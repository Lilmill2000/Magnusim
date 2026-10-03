import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PYTHON, PY_ROOT } from '../python-env.js';
import {
  analysisKeyFor,
  analysisSupportsTimeDependency,
  runDefaultsFor,
  steadyDefaultsFromRegistry,
} from '../registry-defaults.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const text = (rel) => readFileSync(join(root, rel), 'utf8');

// The run defaults of the default steady and transient analyses, as the worker's
// registry.describe publishes them. The core loads the plugins itself, so the
// path is the core's alone and nothing here imports a plugin.
const PY_DEFAULTS = [
  'import json',
  'from cfddesk.worker import methods',
  'd = methods.registry_describe()',
  'keys = d["default_analysis"]',
  'rows = {r["key"]: r for r in d["analysis"]}',
  'print(json.dumps({"keys": keys, "s": rows[keys["steady"]]["run_defaults"], "t": rows[keys["transient"]]["run_defaults"]}))',
].join('; ');

function pythonDefaults() {
  const r = spawnSync(PYTHON, ['-c', PY_DEFAULTS], {
    cwd: PY_ROOT,
    encoding: 'utf8',
    env: { ...process.env, PYTHONPATH: PY_ROOT },
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split(/\r?\n/).pop());
}

// gate:h7-defaults-single-source — one copy of the run-control defaults.
describe('run-control defaults have one source', () => {
  it('Node reads the transient and steady defaults Python defines', () => {
    const py = pythonDefaults();
    assert.deepEqual(runDefaultsFor(py.keys.transient), py.t);
    assert.deepEqual(runDefaultsFor(py.keys.steady), py.s);
    assert.deepEqual({ ...steadyDefaultsFromRegistry() }, py.s);
  });

  it('the page keeps no copy of its own and Node no time-step estimate', () => {
    const runtime = text('src/workbench/runtime.js');
    assert.equal(runtime.includes('TRANSIENT_DEFAULTS_CLIENT'), false);
    // Run defaults are the run's analysis's run_defaults (registry.describe), steady
    // iterations / write interval (200 / 50) included.
    assert.match(runtime, /runDefaults\(/);
    const page = runtime + text('src/workbench/catalogs.js');
    assert.equal(/endTime:\s*200\b|writeInterval:\s*50\b|\|\|\s*200,|\|\|\s*50,/.test(page), false);
    // Nor the server: a new study's control.json was seeded with 500 / 50, and runs
    // fell back to the default analysis's 200 / 50 frozen when the module loaded.
    const server = text('scripts/w17-simulation.js') + text('scripts/w27-solve.js');
    assert.equal(/endTime:\s*\d|writeInterval:\s*\d|DEFAULT_END_TIME|steadyDefaultsFromRegistry\(\)/.test(server), false);
    const w30 = text('scripts/w30-transient.js');
    assert.equal(/export function (estimateDeltaT|resolveTransientControl|flowThroughTime)/.test(w30), false);
    const w27 = text('scripts/w27-solve.js');
    assert.equal(w27.includes('transientControlFor'), false);
    // The run's time dependency and transient settings go to its analysis's plan and prepare job.
    assert.match(w27, /'analysis\.plan_run'/);
    assert.match(w27, /time_dependency: timeDependency,/);
    assert.match(w27, /transient: JSON\.stringify\(transientSettings\)/);
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
