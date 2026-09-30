/**
 * W30 — Transient runs on the server: which studies and runs are transient.
 *
 * A transient run's settings (the `transient` block on the run record and in
 * the study's control) belong to its analysis's run model: its contract's
 * run_defaults are what a new run starts with, and analysis.run_normalize
 * cleans every save (w27-solve normalizeTransientSettings). The core keeps no
 * copy of their fields or limits.
 */

export const TRANSIENT_LABEL = 'Transient';
export const STEADY_LABEL = 'Steady-state';

/** Transient runs are long: go parallel from a smaller mesh than steady. */
export const TRANSIENT_LARGE_MESH_CELLS = 50000;

export function isTransientLabel(v) {
  return /transient/i.test(String(v || ''));
}

/** Simulation record (simulation.json) → is this project transient? */
export function simIsTransient(sim) {
  return !!(sim && isTransientLabel(sim.time_dependency));
}

