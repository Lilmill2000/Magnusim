// @ts-check
/**
 * One solver step at a time, from the events an analysis's log parser emits
 * (magnusim_sdk.progress): `progress` (an OpenFOAM `Time = t` line), `courant`
 * (a Courant number and/or deltaT line) and `residual` (a `Solving for` line).
 * The step-list runner folds a run's live events with it (foam-runner.js) and
 * w27-solve.js re-reads a run's job log with it (parseSolveProgress), so the
 * live and the read-back steps cannot disagree.
 *
 * The step rule:
 * - A `progress` event opens step t and closes the step before it.
 * - OpenFOAM prints a step's Courant number and deltaT before its `Time = t`
 *   line, so a `courant` event is held and given to the NEXT step that opens,
 *   never to the open one.
 * - A step's co_max, co_mean and delta_t: the progress event's own value wins,
 *   then the held one, then the step before it.
 * - A `residual` event goes to the open step: per field, the last initial
 *   residual of the step ('last', the run log's rule) or the largest ('max',
 *   the runner's frames).
 *
 * A fold is any object with `current` and `held` (newSolveFold): callers keep
 * their own bookkeeping next to them.
 *
 * A multi-region run (host API 1.8; magnusim_sdk.progress.RegionProgressParser)
 * keys its residuals `<region>:<field>` (`air:h`): regionsOf and regionSeries
 * plot an analysis's declared series once per region.
 */

/** The per-step numbers that are not residuals. */
export const STEP_METRICS = Object.freeze(['co_max', 'co_mean', 'delta_t']);

// A field, or a region's field (`air:h`).
const FIELD_RE = /^(?:[A-Za-z][A-Za-z0-9_]{0,63}:)?[A-Za-z][A-Za-z0-9_.]{0,63}$/;
const NOT_A_FIELD = new Set(['t', ...STEP_METRICS]);

/**
 * @typedef {Record<string, number> & { t: number }} SolveStep
 * @typedef {{ current: SolveStep | null, held: Record<string, number> | null }} SolveFold
 */

/**
 * The regions a residual row names (`<region>:<field>` keys), in the order they appear.
 * @param {Record<string, unknown> | null | undefined} row
 * @returns {string[]}
 */
export function regionsOf(row) {
  /** @type {string[]} */
  const out = [];
  for (const k of Object.keys(row || {})) {
    const at = k.indexOf(':');
    if (at > 0 && !out.includes(k.slice(0, at))) out.push(k.slice(0, at));
  }
  return out;
}

/**
 * An analysis's declared residual series for a multi-region run: each solved
 * series once per region, keyed `<region>:<key>` with its fields `<region>:<field>`
 * and `region` set; dashed per-step metrics (the Courant number) stay as they are.
 * With no regions the series come back unchanged.
 * @param {any[]} series
 * @param {string[]} regions
 * @returns {any[]}
 */
export function regionSeries(series, regions) {
  if (!regions.length || !Array.isArray(series)) return series;
  const out = [];
  for (const region of regions) {
    for (const s of series) {
      if (s.dashed) continue;
      const fields = s.fields && s.fields.length ? s.fields : [s.key];
      out.push({ ...s, key: `${region}:${s.key}`, region, fields: fields.map((f) => `${region}:${f}`) });
    }
  }
  for (const s of series) if (s.dashed) out.push(s);
  return out;
}

/** @param {unknown} v */
function num(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** @returns {SolveFold} */
export function newSolveFold() {
  return { current: null, held: null };
}

/**
 * Close the open step: it is returned and no step is open after.
 * @param {SolveFold} fold
 * @returns {SolveStep | null}
 */
export function closeStep(fold) {
  const step = fold ? fold.current : null;
  if (fold) fold.current = null;
  return step || null;
}

/**
 * Fold one event (see the step rule above).
 * @param {SolveFold} fold
 * @param {any} ev
 * @param {{ residual?: 'last' | 'max' }} [opts]
 * @returns {SolveStep | null} the step a `progress` event closed, else null
 */
export function foldSolveEvent(fold, ev, opts = {}) {
  if (!fold || !ev || typeof ev !== 'object') return null;
  if (ev.event === 'progress') {
    const t = num(ev.time ?? ev.sim_time);
    if (t === null) return null;
    const prev = fold.current;
    const held = fold.held || {};
    fold.held = null;
    const closed = closeStep(fold);
    /** @type {SolveStep} */
    const step = /** @type {any} */ ({ t });
    for (const k of STEP_METRICS) {
      const own = num(ev[k]);
      const v = own !== null ? own : num(held[k]) !== null ? num(held[k]) : prev ? num(prev[k]) : null;
      if (v !== null) step[k] = v;
    }
    fold.current = step;
    return closed;
  }
  if (ev.event === 'courant') {
    const block = fold.held || {};
    const mean = num(ev.mean);
    const max = num(ev.max);
    const dt = num(ev.delta_t);
    if (mean !== null) block.co_mean = mean;
    if (max !== null) block.co_max = max;
    if (dt !== null) block.delta_t = dt;
    fold.held = block;
    return null;
  }
  if (ev.event === 'residual' && fold.current) {
    /** @type {Record<string, unknown>} */
    const fields = {};
    if (ev.field) fields[String(ev.field)] = ev.initial;
    if (ev.fields && typeof ev.fields === 'object') Object.assign(fields, ev.fields);
    const step = fold.current;
    for (const [k, v] of Object.entries(fields)) {
      const x = num(v);
      if (x === null || !FIELD_RE.test(k) || NOT_A_FIELD.has(k)) continue;
      const before = step[k];
      step[k] = opts.residual === 'max' && Number.isFinite(before) ? Math.max(before, x) : x;
    }
  }
  return null;
}
