// @ts-check
/**
 * This PC's solve rate (RH2): seconds per cell-per-rank per time step and outer loop. Each
 * finished run adds its own (solve seconds / (steps · cells per rank · outer loops)) to the
 * machine settings (`.magnusim-local.json` → `solve_rate.samples`, the newest 20 kept); the rate
 * is their median, and with none Run_2's 1.4e-5 s. The pre-run check's wall-time estimate reads
 * it; magnusim_sdk.run_estimate.pc_solve_rate reads the same samples the same way.
 */
import { readLocalDoc, writeLocalDoc } from './prefs.js';

/** Run_2's rate: 0.6 s per step, 625,000 cells on 15 ranks, 1 outer loop. */
export const DEFAULT_S_PER_CELL_STEP = 1.4e-5;
export const RATE_SAMPLES_MAX = 20;

/** @param {unknown} v */
function pos(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * One run's rate, or null when an input is missing or not positive.
 * @param {{ solve_s: unknown, steps: unknown, cells: unknown, ranks?: unknown, n_outer?: unknown }} p
 */
export function solveRateSample({ solve_s, steps, cells, ranks = 1, n_outer = 1 }) {
  const s = pos(solve_s);
  const n = pos(steps);
  const c = pos(cells);
  if (s === null || n === null || c === null) return null;
  const r = Math.max(1, pos(ranks) ?? 1);
  const o = Math.max(1, pos(n_outer) ?? 1);
  return s / (n * (c / r) * o);
}

/**
 * A finished run's rate from its doc: this attempt's solve phase over its own steps (a continued
 * run's earlier steps left out), its mesh's cells on its ranks, and the outer loops its health
 * hints named (1 when none). Null for a run that did not finish or lacks a number.
 * @param {any} doc
 */
export function runSolveRate(doc) {
  if (!doc || doc.status !== 'done') return null;
  const before = Number(doc.continued && doc.continued.steps_before) || 0;
  const health = doc.health && typeof doc.health === 'object' ? doc.health : {};
  const rates = health.rates && typeof health.rates === 'object' ? health.rates : {};
  return solveRateSample({
    solve_s: doc.phases && doc.phases.solve,
    steps: (Number(doc.n_steps) || 0) - before,
    cells: doc.mesh_source && doc.mesh_source.n_cells,
    ranks: doc.n_procs,
    n_outer: pos(health.n_outer) ?? pos(rates.n_outer) ?? 1,
  });
}

/**
 * This PC's rate: `{s_per_cell_step, runs, source}`, the median of the kept samples (`measured`),
 * else Run_2's (`default`, 0 runs).
 * @param {Record<string, any>} [local] the machine settings (read when not given)
 */
export function pcSolveRate(local) {
  const doc = local || readLocalDoc();
  const block = doc && doc.solve_rate && typeof doc.solve_rate === 'object' ? doc.solve_rate : {};
  const samples = Array.isArray(block.samples) ? block.samples.slice(-RATE_SAMPLES_MAX) : [];
  const vals = samples.map((/** @type {any} */ s) => pos(s && s.s_per_cell_step)).filter((v) => v !== null);
  if (!vals.length) return { s_per_cell_step: DEFAULT_S_PER_CELL_STEP, runs: 0, source: 'default' };
  const sorted = /** @type {number[]} */ (vals).slice().sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return { s_per_cell_step: median, runs: sorted.length, source: 'measured' };
}

/**
 * Add a finished run's rate to the machine settings; returns the sample, or null when the run
 * gives none. The settings keep no name or path of the run: its rate, cells, ranks and steps.
 * @param {any} doc the run's doc as it ended
 * @param {{ read?: () => Record<string, any>, write?: (patch: Record<string, unknown>) => unknown, now?: () => string }} [io]
 */
export function recordSolveRate(doc, io = {}) {
  const rate = runSolveRate(doc);
  if (rate === null) return null;
  const read = io.read || readLocalDoc;
  const write = io.write || writeLocalDoc;
  const sample = {
    s_per_cell_step: Number(rate.toPrecision(4)),
    cells: Math.round(Number(doc.mesh_source.n_cells)),
    ranks: Math.max(1, Math.floor(Number(doc.n_procs) || 1)),
    steps: (Number(doc.n_steps) || 0) - (Number(doc.continued && doc.continued.steps_before) || 0),
    at: io.now ? io.now() : new Date().toISOString(),
  };
  const local = read() || {};
  const prev = local.solve_rate && Array.isArray(local.solve_rate.samples) ? local.solve_rate.samples : [];
  const samples = [...prev, sample].slice(-RATE_SAMPLES_MAX);
  write({ solve_rate: { samples } });
  return sample;
}
