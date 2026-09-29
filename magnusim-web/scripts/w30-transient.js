/**
 * W30 — Transient runs on the server: which studies and runs are transient,
 * and the stored transient settings.
 *
 * A transient run's settings are its analysis's run model (Incompressible
 * Flow: incompressible_flow.transient). The run panel edits them through the
 * plugin's run-settings component, and the plugin normalizes them again when
 * it writes the case (prepare_run) or previews it (analysis.run_preview).
 * normalizeTransient below keeps what the server stores inside the same
 * limits, so a settings save that bypasses the panel (the API) is not stored
 * out of range. Defaults: the analysis's run_defaults (registry).
 *
 * Model (stored on the run record and in simulation_control.json):
 *   transient: {
 *     end_time: 5,            // seconds of simulated time (the one required input)
 *     write_count: 50,        // result frames written over end_time
 *     // Advanced — null means "calculate for me"
 *     time_step_mode: 'adjustable' | 'fixed',
 *     max_co: 1,              // Courant number the adjustable step targets
 *     delta_t: null,          // initial (adjustable) or constant (fixed) time step, s
 *     max_delta_t: null,      // cap for the adjustable step, s (default = write interval; never larger)
 *     time_scheme: 'Euler' | 'backward',
 *     n_outer_correctors: 1,
 *     n_correctors: 2,
 *     n_non_orth_correctors: 0,
 *   }
 */

import { transientDefaultsFromRegistry } from './registry-defaults.js';

export const TRANSIENT_LABEL = 'Transient';
export const STEADY_LABEL = 'Steady-state';

/**
 * The transient settings defaults. One copy: incompressible_flow.transient
 * TRANSIENT_DEFAULTS, published through the registered control_schema of
 * incompressible_transient. delta_t / max_delta_t null = calculate for me.
 */
export const TRANSIENT_DEFAULTS = transientDefaultsFromRegistry();

/** Transient runs are long: go parallel from a smaller mesh than steady. */
export const TRANSIENT_LARGE_MESH_CELLS = 50000;

export function isTransientLabel(v) {
  return /transient/i.test(String(v || ''));
}

/** Simulation record (simulation.json) → is this project transient? */
export function simIsTransient(sim) {
  return !!(sim && isTransientLabel(sim.time_dependency));
}

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function posOrNull(v) {
  if (v == null || v === '' || v === 'auto') return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Coerce a partial / stored transient block to the model above. Unknown or
 * invalid values fall back to the defaults; blank advanced values stay null
 * (auto). Always returns a fresh object.
 */
export function normalizeTransient(partial, base) {
  const b = { ...TRANSIENT_DEFAULTS, ...(base || {}) };
  const p = partial && typeof partial === 'object' ? partial : {};
  const out = { ...b };
  if (p.end_time != null || p.endTime != null) {
    const v = num(p.end_time != null ? p.end_time : p.endTime, b.end_time);
    out.end_time = v > 0 ? v : b.end_time;
  }
  if (p.write_count != null) {
    const v = Math.round(num(p.write_count, b.write_count));
    out.write_count = v >= 1 ? Math.min(v, 5000) : b.write_count;
  }
  if (p.time_step_mode != null) {
    out.time_step_mode = /fixed|constant/i.test(String(p.time_step_mode)) ? 'fixed' : 'adjustable';
  }
  if (p.max_co != null) {
    const v = num(p.max_co, b.max_co);
    out.max_co = v > 0 ? v : b.max_co;
  }
  if ('delta_t' in p) out.delta_t = posOrNull(p.delta_t);
  if ('max_delta_t' in p) out.max_delta_t = posOrNull(p.max_delta_t);
  if (p.time_scheme != null) {
    out.time_scheme = /backward|2nd|second/i.test(String(p.time_scheme)) ? 'backward' : 'Euler';
  }
  if (p.n_outer_correctors != null) {
    const v = Math.round(num(p.n_outer_correctors, b.n_outer_correctors));
    out.n_outer_correctors = Math.min(Math.max(v, 1), 50);
  }
  if (p.n_correctors != null) {
    const v = Math.round(num(p.n_correctors, b.n_correctors));
    out.n_correctors = Math.min(Math.max(v, 1), 10);
  }
  if (p.n_non_orth_correctors != null) {
    const v = Math.round(num(p.n_non_orth_correctors, b.n_non_orth_correctors));
    out.n_non_orth_correctors = Math.min(Math.max(v, 0), 5);
  }
  return out;
}
