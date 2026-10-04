// What a bundled plugin's own browser suite (bundled-plugins/<key>/e2e/, run on the
// core's Playwright) may use from the core's e2e harness. Its specs, seed module and
// playwright.config.js import from here and nowhere else in the core
// (scripts/__tests__/e2e-suites.test.mjs), so the harness can change behind this one
// file. docs/TESTING.md, "A bundled plugin's own suite".
// SPDX-License-Identifier: GPL-3.0-or-later
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { seedElbowProject as seedCoreElbowProject } from '../prepare-projects.js';

export { appSuiteConfig } from './app-config.js';
export { NO_HEAVY, NO_WSL, wslPathExists } from '../toolchain.js';
export { computeQueue, foamRecords, killFoamRelays, removeTestWslRoot, waitSlotFree } from './compute-slot.js';
export { addAir, addBc, createStudy, setup } from './two-plates.js';
export { PYTHON } from '../../scripts/python-env.js';
// A second app server of its own (only the plugins a test names), and the core's
// seeded projects for it.
export { e2eTemp, startHost } from './host-server.mjs';
export { NO_GEOMETRY_PROJECT, prepareE2eProjectsRoot } from '../prepare-projects.js';
// The machine's WSL test lock, for a test that runs OpenFOAM itself.
export { acquireWslLock } from './wsl-lock.mjs';

/**
 * Seed a fresh copy of the core's elbow sample (one study with its mesh, Air and BCs)
 * as destRoot/<id>, titled `title`. A project already there is replaced.
 * @param {string} destRoot
 * @param {string} id
 * @param {string} title
 */
export function seedElbowProject(destRoot, id, title) {
  rmSync(join(destRoot, id), { recursive: true, force: true });
  seedCoreElbowProject(destRoot, id, title);
}
