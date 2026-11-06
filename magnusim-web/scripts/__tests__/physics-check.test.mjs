// npm run test:physics (scripts/physics-check.mjs): when the quick physics checks run, skip or
// fail, and what pytest is asked for. No WSL here: whether OpenFOAM is found is stubbed.
// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PHYSICS_TESTS, physicsArgs, physicsPlan } from '../physics-check.mjs';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('the checks run where WSL with OpenFOAM is found, and are skipped, saying why, where it is not', () => {
  let asked = 0;
  const found = (v) => () => {
    asked += 1;
    return v;
  };
  assert.deepEqual(physicsPlan({}, found(true)), { run: true });
  assert.deepEqual(physicsPlan({}, found(false)), { run: false, code: 0, why: 'skipped: WSL with OpenFOAM (openfoam2606 simpleFoam) was not found' });
  // Insisted on: a missing toolchain fails, as MAGNUSIM_E2E_WSL=1 does for the e2e suites.
  assert.equal(physicsPlan({ MAGNUSIM_E2E_WSL: '1' }, found(false)).code, 1);
  assert.deepEqual(physicsPlan({ MAGNUSIM_E2E_WSL: '1' }, found(true)), { run: true });
  // Turned off by hand: skipped without asking WSL.
  asked = 0;
  assert.deepEqual(physicsPlan({ MAGNUSIM_E2E_WSL: '0' }, found(true)), { run: false, code: 0, why: 'skipped: MAGNUSIM_E2E_WSL=0' });
  assert.equal(asked, 0);
});

test('pytest is asked for the quick checks only, on their own file, with their numbers printed', () => {
  const args = physicsArgs();
  assert.deepEqual(args.slice(0, 2), ['-m', 'pytest']);
  assert.equal(args[args.indexOf('-m', 2) + 1], 'wsl and physics');
  assert.ok(args.includes('-s'));
  assert.equal(args.at(-1), PHYSICS_TESTS);
  assert.deepEqual(physicsArgs(['-k', 'cavity']).slice(-3), [PHYSICS_TESTS, '-k', 'cavity']);
  // The file is there, and every test in it is a WSL physics check (none runs in the default pytest).
  const file = join(WEB, 'python', PHYSICS_TESTS);
  assert.ok(existsSync(file), file);
  assert.match(readFileSync(file, 'utf8'), /^pytestmark = \[pytest\.mark\.wsl, pytest\.mark\.physics\]$/m);
});
