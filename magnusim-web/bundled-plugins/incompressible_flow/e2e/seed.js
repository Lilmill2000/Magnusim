// Incompressible Flow's own e2e projects, seeded after the core's (appSuiteConfig's
// `seed` in playwright.config.js; docs/TESTING.md, "A bundled plugin's own suite").
// SPDX-License-Identifier: GPL-3.0-or-later
import { seedElbowProject } from '../../../e2e/support/plugin-suite.js';

/** Own elbow project for h10-ui-parity.spec.js: it solves a steady and a transient run to compare the panels. */
export const H10_PROJECT = 'h10-ui-parity-e2e';
/** Own elbow project for run-settings-save.spec.js: it edits a draft run's settings. */
export const RUN_SETTINGS_PROJECT = 'run-settings-e2e';
/** Own elbow project for study-start-numerics.spec.js: it edits the study's starting flow and numerics. */
export const STUDY_START_PROJECT = 'study-start-numerics-e2e';

/** @param {string} destRoot the test projects root */
export default function seed(destRoot) {
  seedElbowProject(destRoot, H10_PROJECT, 'UI parity');
  seedElbowProject(destRoot, RUN_SETTINGS_PROJECT, 'Run settings');
  seedElbowProject(destRoot, STUDY_START_PROJECT, 'Study start and numerics');
}
