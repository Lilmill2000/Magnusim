/**
 * W30 — Transient time dependency (pimpleFoam).
 *
 * The steady stack (w27-solve.js) writes a simpleFoam case with pseudo-time
 * iterations. This module holds everything that differs for a transient run:
 * the settings model with sensible defaults, the auto-calculated numbers
 * (time step, write interval), and the pimpleFoam system/ dictionaries.
 * The 0/ fields, constant/ and BC mapping are shared with the steady writer.
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
 *
 * Defaults follow what SimScale exposes for a transient incompressible run
 * (End time, Delta t, Adjustable time step + Maximal Courant number, Maximal
 * step, Write control "Adjustable runtime" + Write interval) and the standard
 * OpenFOAM pimpleFoam tutorials (PIMPLE nOuterCorrectors 1 / nCorrectors 2,
 * adjustTimeStep yes, writeControl adjustableRunTime).
 */

export const TRANSIENT_LABEL = 'Transient';
export const STEADY_LABEL = 'Steady-state';

export const TRANSIENT_DEFAULTS = Object.freeze({
  end_time: 5,
  write_count: 50,
  time_step_mode: 'adjustable',
  max_co: 1,
  delta_t: null,
  max_delta_t: null,
  time_scheme: 'Euler',
  n_outer_correctors: 1,
  n_correctors: 2,
  n_non_orth_correctors: 0,
});

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
    out.max_co = v > 0 ? Math.min(v, 50) : b.max_co;
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

/** Physical time in seconds → the shortest string OpenFOAM reads back. */
export function foamNum(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '0';
  if (n === 0) return '0';
  const a = Math.abs(n);
  if (a >= 1e-3 && a < 1e6) {
    // up to 8 significant digits, trailing zeros trimmed
    return String(Number(n.toPrecision(8)));
  }
  return n.toExponential(6).replace(/\.?0+e/, 'e');
}

/**
 * Time-step estimate for the mesh + flow: Co ≈ maxCo on the smallest cell.
 *   dt ≈ 0.5 · maxCo · h_min / U
 * h_min is the cube root of checkMesh's smallest cell volume when the mesh
 * log is available, else the recorded surface size (standard-meta.json
 * sizing), else a uniform-cell estimate from the bounding box. The 0.5 covers
 * the flow speeding up past the inlet speed and cell anisotropy; measured
 * against the ball test it lands within ~2× of the step pimpleFoam settles
 * on. Returns null when nothing is known.
 */
export function estimateDeltaT({ meshMeta, nCells, speedRef, maxCo }) {
  const U = Math.max(num(speedRef, 0), 0.05);
  let h = null;
  let basis = null;
  const minVol = meshMeta && num(meshMeta.min_cell_volume_m3, NaN);
  if (minVol > 0) {
    h = Math.cbrt(minVol);
    basis = 'min_cell';
  }
  const sz = meshMeta && meshMeta.sizing;
  if (!(h > 0) && sz) {
    const cands = [sz.surface_size_m, sz.core_size_m].map((v) => num(v, NaN)).filter((v) => v > 0);
    if (cands.length) {
      h = Math.min(...cands);
      basis = 'surface_size';
    }
  }
  if (!(h > 0) && sz && Array.isArray(sz.bbox_m) && sz.bbox_m.length === 3 && nCells > 0) {
    const vol = sz.bbox_m.reduce((a, b) => a * Math.max(num(b, 0), 1e-9), 1);
    // The fluid rarely fills the box; assume ~40 % fill.
    h = Math.cbrt((0.4 * vol) / nCells);
    basis = 'bbox';
  }
  if (!(h > 0)) return null;
  const co = num(maxCo, TRANSIENT_DEFAULTS.max_co) || 1;
  const dt = 0.5 * co * (h / U);
  return { delta_t: dt, h_m: h, u_ref: U, basis };
}

/**
 * Domain flow-through time (longest bbox side / reference speed) — a hint for
 * choosing the simulation time. Null without a bbox.
 */
export function flowThroughTime(meshMeta, speedRef) {
  const sz = meshMeta && meshMeta.sizing;
  const U = num(speedRef, 0);
  if (!sz || !Array.isArray(sz.bbox_m) || !(U > 0)) return null;
  const L = Math.max(...sz.bbox_m.map((v) => num(v, 0)));
  return L > 0 ? L / U : null;
}

/**
 * Resolve every number the writer needs from the user's settings plus the
 * case (mesh metadata, reference speed). `source` records which values were
 * calculated so the UI can show "auto".
 */
export function resolveTransientControl(settings, ctx) {
  const t = normalizeTransient(settings);
  const c = ctx || {};
  const endTime = t.end_time;
  const writeInterval = endTime / Math.max(1, t.write_count);
  const est = estimateDeltaT({
    meshMeta: c.meshMeta,
    nCells: c.nCells,
    speedRef: c.speedRef,
    maxCo: t.max_co,
  });
  const source = {};
  let deltaT = t.delta_t;
  if (!(deltaT > 0)) {
    // Fallback when the mesh is unknown: 1/100 of a write interval.
    deltaT = est ? est.delta_t : writeInterval / 100;
    source.delta_t = 'auto';
  } else {
    source.delta_t = 'user';
  }
  // Never start with a step longer than a write interval.
  deltaT = Math.min(deltaT, writeInterval);
  let maxDeltaT = t.max_delta_t;
  if (!(maxDeltaT > 0)) {
    maxDeltaT = writeInterval;
    source.max_delta_t = 'auto';
  } else {
    source.max_delta_t = 'user';
  }
  // A leftover or typed max Δt bigger than the frame interval (simulation
  // time ÷ frames) can skip result writes, especially after someone raises
  // the frame count. Always keep the cap at or below one interval.
  if (maxDeltaT > writeInterval) {
    maxDeltaT = writeInterval;
    if (source.max_delta_t === 'user') source.max_delta_t = 'capped';
  }
  const adjust = t.time_step_mode !== 'fixed';
  // Adjustable: the solver settles near the estimate (the 0.5 in the estimate
  // is the safety margin, not a prediction); fixed: exact.
  const stepsEst = adjust ? (est ? Math.round(endTime / Math.max(est.delta_t, 1e-12)) : null) : Math.round(endTime / deltaT);
  return {
    ...t,
    end_time: endTime,
    write_interval: writeInterval,
    delta_t: deltaT,
    max_delta_t: maxDeltaT,
    adjust_time_step: adjust,
    source,
    estimate: {
      delta_t: est ? est.delta_t : null,
      h_m: est ? est.h_m : null,
      basis: est ? est.basis : null,
      u_ref: est ? est.u_ref : c.speedRef != null ? Number(c.speedRef) : null,
      steps: stepsEst,
      flow_through_s: flowThroughTime(c.meshMeta, c.speedRef),
    },
  };
}

// ---------------------------------------------------------------------------
// pimpleFoam dictionaries. `functions` is the shared monitor block text.

export function transientControlDict(ctrl, functionsText) {
  const adjust = ctrl.adjust_time_step;
  return `application     pimpleFoam;
startFrom       startTime;
startTime       0;
stopAt          endTime;
endTime         ${foamNum(ctrl.end_time)};
deltaT          ${foamNum(ctrl.delta_t)};
writeControl    ${adjust ? 'adjustableRunTime' : 'runTime'};
writeInterval   ${foamNum(ctrl.write_interval)};
purgeWrite      0;
writeFormat     ascii;
writePrecision  8;
writeCompression off;
timeFormat      general;
timePrecision   8;
runTimeModifiable true;

adjustTimeStep  ${adjust ? 'yes' : 'no'};
maxCo           ${foamNum(ctrl.max_co)};
maxDeltaT       ${foamNum(ctrl.max_delta_t)};

functions
{
${functionsText || '    // no area-average probes'}
}`;
}

export function transientFvSchemes(ctrl) {
  const ddt = ctrl.time_scheme === 'backward' ? 'backward' : 'Euler';
  // Same convection/gradient choices as the steady case, without `bounded`
  // (that variant is for steady-state continuity errors only).
  return `ddtSchemes { default ${ddt}; }
gradSchemes
{
    default         Gauss linear;
    grad(U)         cellLimited Gauss linear 1;
    grad(k)         cellLimited Gauss linear 1;
    grad(omega)     cellLimited Gauss linear 1;
}
divSchemes
{
    default         none;
    div(phi,U)      Gauss linearUpwind grad(U);
    div(phi,k)      Gauss limitedLinear 1;
    div(phi,omega)  Gauss limitedLinear 1;
    div((nuEff*dev2(T(grad(U))))) Gauss linear;
}
laplacianSchemes { default Gauss linear limited corrected 0.5; }
interpolationSchemes { default linear; }
snGradSchemes { default limited corrected 0.5; }
wallDist { method meshWave; }`;
}

export function transientFvSolution(ctrl) {
  const nOuter = Math.max(1, Math.round(ctrl.n_outer_correctors));
  const nCorr = Math.max(1, Math.round(ctrl.n_correctors));
  const nNonOrth = Math.max(0, Math.round(ctrl.n_non_orth_correctors));
  // With a single outer corrector (PISO mode) no under-relaxation is applied;
  // with several, relax the intermediate outer iterations and solve the final
  // one unrelaxed so the time step is converged.
  const relax =
    nOuter > 1
      ? `relaxationFactors
{
    fields
    {
        p               0.3;
        pFinal          1;
    }
    equations
    {
        "(U|k|omega)"   0.7;
        "(U|k|omega)Final" 1;
    }
}`
      : `relaxationFactors
{
    equations
    {
        ".*"            1;
    }
}`;
  return `solvers
{
    p
    {
        solver          GAMG;
        tolerance       1e-7;
        relTol          0.01;
        smoother        GaussSeidel;
        nCellsInCoarsestLevel 20;
        maxIter         200;
    }
    pFinal
    {
        $p;
        relTol          0;
    }
    "(U|k|omega)"
    {
        solver          smoothSolver;
        smoother        symGaussSeidel;
        tolerance       1e-8;
        relTol          0.1;
        maxIter         50;
    }
    "(U|k|omega)Final"
    {
        $U;
        relTol          0;
    }
}
PIMPLE
{
    momentumPredictor   yes;
    nOuterCorrectors    ${nOuter};
    nCorrectors         ${nCorr};
    nNonOrthogonalCorrectors ${nNonOrth};
    turbOnFinalIterOnly yes;
    consistent          no;
}
${relax}`;
}

/** Run-status progress fields that only exist for a transient solve. */
export function transientProgressFromLine(line, current) {
  // "Courant Number mean: 0.12 max: 0.98"
  const co = line.match(/^Courant Number mean:\s*([0-9.eE+-]+)\s+max:\s*([0-9.eE+-]+)/);
  if (co && current) {
    const mean = Number(co[1]);
    const v = Number(co[2]);
    if (Number.isFinite(mean)) current.co_mean = mean;
    if (Number.isFinite(v)) current.co_max = v;
    return true;
  }
  // "deltaT = 0.000123"
  const dt = line.match(/^deltaT\s*=\s*([0-9.eE+-]+)/);
  if (dt && current) {
    const v = Number(dt[1]);
    if (Number.isFinite(v)) current.delta_t = v;
    return true;
  }
  return false;
}

/** Human summary for notes / hints. */
export function describeTransient(ctrl) {
  const c = ctrl || {};
  const bits = [];
  if (c.end_time != null) bits.push(`${foamNum(c.end_time)} s`);
  if (c.write_count != null) bits.push(`${c.write_count} frames`);
  if (c.adjust_time_step === false) bits.push(`fixed Δt ${foamNum(c.delta_t)} s`);
  else if (c.max_co != null) bits.push(`Co ≤ ${foamNum(c.max_co)}`);
  return bits.join(' · ');
}
