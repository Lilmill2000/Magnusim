// @ts-check
/**
 * A run's health record (RH1, spec 3.6): its shape check, and how a `health` event becomes the
 * run doc's `health` (healthPatch). Shared by the runner's relayEvent (foam-runner.js),
 * core-solve.js, the fake solve (test-solve.js) and the old-run check (w27-solve.js), so every
 * path keeps the same record: checked, scrubbed, and at most 4 KB.
 *
 * An event over 4 KB (the Python side shrinks to 4 KB, so it should never be) keeps the last
 * record, takes the new verdict, time and step when they check, and sets `stale: true`: the
 * chip never freezes on an old verdict.
 */
import { scrubContext, scrubHealth, scrubText } from './solver-log-scrub.js';

export const HEALTH_MAX_BYTES = 4096;
export const VERDICTS = Object.freeze(['pending', 'healthy', 'watch', 'unhealthy', 'failed']);
const LEVELS = new Set(['error', 'warn', 'info']);
const TARGETS = new Set(['run', 'study', 'new_run', 'mesh']);
const RESTARTS = new Set(['continue_after_fix', 'from_zero']);
const UNITS = new Set(['time step', 'iteration']);
const CODE = /^[a-z][a-z0-9_]{0,39}$/;
const KEY = /^[0-9a-f]{12}$/;

/** @param {unknown} v */
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
/** @param {unknown} v */
const finiteOrNull = (v) => v === null || v === undefined || (typeof v === 'number' && Number.isFinite(v));
/** @param {unknown} v @param {number} max */
const shortText = (v, max) => typeof v === 'string' && v.length <= max;

/** The record's size as stored (compact JSON, UTF-8). @param {unknown} rec */
export function healthBytes(rec) {
  return Buffer.byteLength(JSON.stringify(rec), 'utf8');
}

/**
 * What is wrong with a health record's shape ('' when nothing).
 * @param {any} h
 */
export function healthProblem(h) {
  if (!isObj(h)) return 'not an object';
  if (h.v !== 1) return 'v';
  if (!VERDICTS.includes(h.verdict)) return 'verdict';
  if (!finiteOrNull(h.step) || !finiteOrNull(h.t) || !finiteOrNull(h.window)) return 'step, t or window';
  if (h.unit !== undefined && !UNITS.has(h.unit)) return 'unit';
  if (h.at !== undefined && !shortText(h.at, 40)) return 'at';
  if (h.restart !== undefined && h.restart !== null && !RESTARTS.has(h.restart)) return 'restart';
  if (h.checked !== undefined && !(Array.isArray(h.checked) && h.checked.length <= 16 && h.checked.every((c) => typeof c === 'string' && CODE.test(c)))) return 'checked';
  if (
    h.skipped !== undefined &&
    !(Array.isArray(h.skipped) && h.skipped.length <= 8 && h.skipped.every((s) => isObj(s) && typeof s.code === 'string' && CODE.test(s.code) && shortText(s.why, 60)))
  ) {
    return 'skipped';
  }
  if (h.findings !== undefined) {
    if (!Array.isArray(h.findings) || h.findings.length > 6) return 'findings';
    for (const f of h.findings) {
      if (!isObj(f) || typeof f.code !== 'string' || !CODE.test(f.code) || !LEVELS.has(f.level)) return 'finding';
      if (f.text !== undefined && !shortText(f.text, 240)) return 'finding text';
      if (f.since_t !== undefined && !finiteOrNull(f.since_t)) return 'finding since_t';
      const ev = f.evidence;
      if (ev !== undefined && ev !== null) {
        if (!isObj(ev)) return 'evidence';
        if (ev.log_at !== undefined && ev.log_at !== null && !(Number.isInteger(ev.log_at) && ev.log_at >= 0)) return 'evidence log_at';
        if (ev.key !== undefined && ev.key !== null && !(typeof ev.key === 'string' && KEY.test(ev.key))) return 'evidence key';
        if (ev.text !== undefined && !shortText(ev.text, 200)) return 'evidence text';
        if (ev.line !== undefined && !finiteOrNull(ev.line)) return 'evidence line';
      }
      if (f.fix !== undefined) {
        if (!Array.isArray(f.fix) || f.fix.length > 2) return 'fix';
        for (const x of f.fix) {
          if (!isObj(x) || !shortText(x.label, 60) || !TARGETS.has(x.target)) return 'fix row';
          if (x.name !== undefined && !shortText(x.name, 64)) return 'fix name';
          if (!Array.isArray(x.values) || x.values.length > 4 || !x.values.every((v) => isObj(v) && typeof v.key === 'string' && v.key.length <= 80)) return 'fix values';
          if (x.cost !== undefined && x.cost !== null && !(isObj(x.cost) && finiteOrNull(x.cost.steps) && finiteOrNull(x.cost.wall_s))) return 'fix cost';
        }
      }
    }
  }
  if (h.timeline !== undefined && !(Array.isArray(h.timeline) && h.timeline.length <= 20 && h.timeline.every((e) => isObj(e) && finiteOrNull(e.t) && VERDICTS.includes(e.verdict)))) return 'timeline';
  if (h.first_unhealthy !== undefined && h.first_unhealthy !== null && !(isObj(h.first_unhealthy) && finiteOrNull(h.first_unhealthy.t))) return 'first_unhealthy';
  if (h.warnings !== undefined && !(Array.isArray(h.warnings) && h.warnings.length <= 3 && h.warnings.every((w) => isObj(w) && shortText(w.text, 160)))) return 'warnings';
  for (const k of ['clipping', 'bounding', 'at_limit']) {
    const max = k === 'clipping' ? 2 : k === 'bounding' ? 6 : 8;
    if (h[k] !== undefined && !(Array.isArray(h[k]) && h[k].length <= max && h[k].every(isObj))) return k;
  }
  for (const k of ['courant', 'delta_t', 'rates', 'continuity']) if (h[k] !== undefined && h[k] !== null && !isObj(h[k])) return k;
  if (h.residuals_last !== undefined && !(isObj(h.residuals_last) && Object.keys(h.residuals_last).length <= 12)) return 'residuals_last';
  return '';
}

/**
 * A `health` event's record as the run doc keeps it, given the record it had (`prev`): checked,
 * scrubbed (`ctx`, solver-log-scrub.js), and at most 4 KB. Null when the event is not one.
 * @param {any} prev the run's health now (or null)
 * @param {any} ev a `health` event, or a record
 * @param {{ hosts: string[], user: string }} [ctx]
 * @returns {any | null}
 */
export function healthPatch(prev, ev, ctx = scrubContext()) {
  if (!isObj(ev)) return null;
  const { event: _drop, ...rec } = /** @type {Record<string, any>} */ (ev);
  if (healthBytes(rec) > HEALTH_MAX_BYTES) {
    // Keep the last record, with the new verdict when it checks: never an old verdict.
    const verdict = VERDICTS.includes(rec.verdict) ? rec.verdict : null;
    if (!verdict) return null;
    const base = isObj(prev) && !healthProblem(prev) ? prev : { v: 1, verdict, findings: [], checked: [], skipped: [] };
    const out = { ...base, verdict, stale: true };
    for (const k of ['at', 'step', 't']) if (rec[k] !== undefined && (k === 'at' ? shortText(rec[k], 40) : finiteOrNull(rec[k]))) out[k] = rec[k];
    return healthBytes(out) <= HEALTH_MAX_BYTES ? out : { v: 1, verdict, at: out.at, step: out.step, t: out.t, stale: true };
  }
  if (healthProblem(rec)) return null;
  const clean = scrubHealth(rec, ctx);
  delete clean.stale;
  return healthBytes(clean) <= HEALTH_MAX_BYTES ? clean : null;
}

/**
 * A failed run's reason as it may be kept: scrubbed, one line, at most 160 characters.
 * @param {unknown} reason
 * @param {{ hosts: string[], user: string }} [ctx]
 */
export function scrubbedReason(reason, ctx = scrubContext()) {
  if (typeof reason !== 'string' || !reason.trim()) return null;
  return scrubText(reason.trim(), ctx, 160) || null;
}

/** The codes of a record's findings (the job log keeps a row only when they or the verdict change). @param {any} h */
export function healthCodes(h) {
  return isObj(h) && Array.isArray(h.findings) ? h.findings.map((/** @type {any} */ f) => String(f && f.code)).join(',') : '';
}

/**
 * Where Continue would go on from, against the onset (spec 3.6), from the run's own latest saved
 * time: `from_zero`, `continue_after_fix` or null. It never says Continue will be healthy.
 * @param {any} h the run's health
 * @param {number | null | undefined} latestSaved
 */
export function restartOf(h, latestSaved) {
  if (!isObj(h) || h.head_missing || !isObj(h.first_unhealthy) || !Number.isFinite(Number(h.first_unhealthy.t))) return null;
  const onset = Number(h.first_unhealthy.t);
  if (latestSaved === null || latestSaved === undefined || !Number.isFinite(Number(latestSaved))) return h.restart ?? 'from_zero';
  const saved = Number(latestSaved);
  if (saved < onset) return 'continue_after_fix';
  let at = null;
  for (const e of Array.isArray(h.timeline) ? h.timeline : []) {
    if (isObj(e) && Number.isFinite(Number(e.t)) && Number(e.t) <= saved) at = e.verdict;
  }
  return at === 'healthy' ? 'continue_after_fix' : 'from_zero';
}

/**
 * A run's health as the run ended (spec 2.1): no longer live. A run that failed while its health
 * was still `pending` (before its time loop, or before the 6th step that is scored first) is
 * `failed`, with the run's own reason (`reason`, scrubbed) as its finding: never "Checking" on a
 * failed run. A done or stopped run keeps `pending` (the Health block says it ended before its
 * health could be judged). Null when `h` is not a record.
 * @param {any} h the run's last health (already shape-checked and scrubbed)
 * @param {string} status the run's ended status ('done', 'stopped' or 'failed')
 * @param {unknown} [reason] why it failed, as its run doc says it
 * @param {{ hosts: string[], user: string }} [ctx]
 */
export function endedHealthRecord(h, status, reason, ctx = scrubContext()) {
  if (!isObj(h)) return null;
  /** @type {Record<string, any>} */
  const out = { ...h, live: false };
  if (h.verdict !== 'pending' || status !== 'failed') return out;
  const step = Number(h.step);
  const unit = h.unit === 'iteration' ? 'iteration' : 'time step';
  const lead =
    Number.isFinite(step) && step > 0
      ? `The run failed at ${unit} ${Math.round(step)}, before its health could be judged (from the 6th ${unit} on)`
      : 'The run failed before its time loop started';
  const why = scrubbedReason(reason, ctx);
  const text = (why ? `${lead}: ${why}` : `${lead}.`).slice(0, 240);
  const t = h.t !== null && h.t !== undefined && Number.isFinite(Number(h.t)) ? Number(h.t) : null;
  const others = (Array.isArray(h.findings) ? h.findings : []).filter((/** @type {any} */ f) => isObj(f) && f.code !== 'failed');
  out.verdict = 'failed';
  out.findings = [{ code: 'failed', level: 'error', text, evidence: null, since_t: t }, ...others].slice(0, 6);
  out.timeline = [...(Array.isArray(h.timeline) ? h.timeline : []), { t, verdict: 'failed' }].slice(-20);
  out.restart = null;
  if (healthBytes(out) <= HEALTH_MAX_BYTES && !healthProblem(out)) return out;
  return { v: 1, verdict: 'failed', at: h.at, step: h.step ?? null, t, unit, window: h.window ?? 0, live: false, findings: [out.findings[0]] };
}

/**
 * What an earlier attempt keeps of its health (attempts[i].health, under 300 bytes).
 * @param {any} h
 */
export function attemptHealth(h) {
  if (!isObj(h) || !VERDICTS.includes(h.verdict)) return null;
  const codes = (Array.isArray(h.findings) ? h.findings : [])
    .filter((/** @type {any} */ f) => isObj(f) && (f.level === 'error' || f.level === 'warn'))
    .map((/** @type {any} */ f) => String(f.code))
    .slice(0, 6);
  const fu = isObj(h.first_unhealthy) ? { t: h.first_unhealthy.t ?? null, ...(h.first_unhealthy.approx ? { approx: true } : {}) } : null;
  return { verdict: h.verdict, codes, first_unhealthy: fu };
}

export { scrubContext };
