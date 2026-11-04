/**
 * Run health's words (RH1, spec 2.1, 3.10-3.12): the one source the Run panel's Health block,
 * its Continue box and the Assistant's `health` answer and cards share, so the person and the
 * Assistant read the same text.
 *
 * "Healthy" never reads as accurate or converged; no sentence says or implies that Continue
 * will be healthy, safe or fixed (`OVERCLAIM`, checked by runHealthWords.test.ts). The words of
 * what to do are gated by the run's state first (running, stopping, stopped with or without a
 * saved time, failed, done), then by `restart`. "Use when continuing" is offered only to a run
 * that can take it (`continues`, runReopen.ts's rule), and once a change waits for Continue the
 * words say only Health on the continued part can tell.
 *
 * Pure, with no imports: the server imports this file as it is.
 */

export type HealthVerdict = 'pending' | 'healthy' | 'watch' | 'unhealthy' | 'failed';
export type HealthRestart = 'continue_after_fix' | 'from_zero' | null;

export interface HealthFix {
  label: string;
  target: 'run' | 'study' | 'new_run' | 'mesh';
  name?: string;
  values: Array<{ key: string; value: unknown }>;
  cost?: { steps: number | null; wall_s: number | null } | null;
}

export interface HealthFinding {
  code: string;
  level: 'error' | 'warn' | 'info';
  text?: string;
  evidence?: { line?: number | null; text?: string; log_at?: number | null; key?: string | null } | null;
  since_t?: number | null;
  fix?: HealthFix[];
}

export interface HealthRecord {
  v: number;
  verdict: HealthVerdict;
  at?: string;
  step?: number | null;
  t?: number | null;
  unit?: 'time step' | 'iteration';
  window?: number | null;
  live?: boolean;
  stale?: boolean;
  trimmed?: boolean;
  head_missing?: boolean;
  checked_steps?: number | null;
  checked?: string[];
  skipped?: Array<{ code: string; why: string }>;
  findings?: HealthFinding[];
  timeline?: Array<{ t: number | null; verdict: HealthVerdict }>;
  first_unhealthy?: { t: number | null; step?: number | null; wall_s?: number | null; approx?: boolean; by_t?: number | null } | null;
  restart?: HealthRestart;
  rates?: { co_max_per_s: number; s_per_step: number; n_outer: number } | null;
  [k: string]: unknown;
}

/** What the words need of the run itself. */
export interface HealthRunView {
  name: string;
  status: string;
  /** A Stop was asked and it is writing its current step. */
  stopping?: boolean;
  /** The latest saved time Continue would go on from (seconds or iteration), else null. */
  saved: number | null;
  transient: boolean;
  /**
   * A change of its Max Courant or the correctors can wait for its Continue ("Use when
   * continuing"): runReopen.ts runEditState is 'continues' (a stopped transient run with a saved
   * time, its study still Transient). Absent or false: it cannot, so the words never offer it.
   */
  continues?: boolean;
}

/** No health words may say or imply that Continue will be healthy, safe or fixed. */
export const OVERCLAIM = /\b(safe|fine|fixed)\b|will be healthy/i;

export const VERDICT_WORDS: Record<Exclude<HealthVerdict, 'pending'>, string> = {
  healthy: 'Healthy',
  watch: 'Watch closely',
  unhealthy: 'Unhealthy',
  failed: 'Failed',
};

/** The checks as the words name them ("Not checked: speed growth (no fixed inflow)"). */
export const CHECK_NAMES: Record<string, string> = {
  velocity_clipped: 'velocity clipping',
  pv_coupling: 'pressure-velocity coupling',
  residuals_high: 'residuals',
  residuals_stalled: 'residuals',
  solver_at_limit: 'linear solvers',
  turbulence_bounded: 'turbulence bounding',
  speed_growth: 'speed growth',
  monitor_drift: 'pressure-drop drift',
  courant_mode: 'Courant number',
  courant_spread: 'Courant spread',
  continuity_bias: 'continuity',
  bounded_from_start: 'bounding at the start',
  not_settled: 'settling',
  failed: 'solver errors',
  diffusion_high: 'diffusion number',
  temperature_range: 'temperature range',
};

/** A finding's "Why" (spec 2.4): what the check means. */
export const HEALTH_WHY: Record<string, string> = {
  velocity_clipped: 'The velocity limit is 10 times the reference speed; a capped cell holds no real result.',
  pv_coupling: 'The last pressure solve of a step should only polish: a large start means pressure and velocity are not coupled.',
  residuals_high: "A transient run's first residual is roughly how much a field changes in one step.",
  residuals_stalled: "A steady run's residuals should keep falling.",
  solver_at_limit: 'A linear solver stopped at its iteration limit passes the unsolved error to the next step.',
  turbulence_bounded: 'Turbulence values reset from below zero in most steps mean the model is feeding a diverging flow.',
  speed_growth: 'With a fixed inflow, the mean convective cell rate cannot rise several-fold.',
  monitor_drift: 'At a fixed inflow, the pressure drop scales with the dynamic pressure of the inflow.',
  courant_mode: 'With 1 outer corrector (PISO) there is no outer loop to correct the lag of a large time step.',
  courant_spread: 'When the largest Courant number is far above the mean, a few small cells set the time step: a mesh matter.',
  continuity_bias: 'A continuity error that drifts one way means mass is not conserved from step to step.',
  bounded_from_start: 'Turbulence values below zero from the first step point to the inlet values or the mesh.',
  not_settled: 'This covers whether the results settled, not only whether the run was stable.',
  failed: 'The solver stopped with an error or a value that is not a number.',
  diffusion_high: "A solid's diffusion number above what the solver is set for limits the time step.",
  temperature_range: 'Temperatures below 0 K or far above every boundary mean the energy solution is diverging.',
};

/** The Continue keys' names in words (A2's continue_changes). */
const KEY_NAMES: Record<string, string> = {
  'transient.max_co': 'Max Courant',
  'transient.n_outer_correctors': 'outer correctors',
  'transient.n_correctors': 'pressure correctors',
  'transient.max_delta_t': 'Max time step',
};

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** A time as the run panel writes it ("0.0069 s", "0.167 s", "12.5 s"). */
export function simTime(v: unknown): string {
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return '0 s';
  const a = Math.abs(n);
  const s =
    a >= 100 ? n.toFixed(0) : a >= 10 ? n.toFixed(1) : a >= 1 ? String(Number(n.toFixed(2))) : a >= 0.01 ? String(Number(n.toFixed(3))) : a >= 1e-3 ? String(Number(n.toFixed(4))) : n.toExponential(1);
  return s + ' s';
}

/** Where a run is: "t = 0.0069 s" or "iteration 450". */
export function atWords(v: unknown, transient: boolean): string {
  return transient ? 't = ' + simTime(v) : 'iteration ' + Math.round(Number(v) || 0);
}

/** A whole number with thousands separated ("1,200"). */
function whole(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

const quoted = (name: string) => '"' + (name || 'this run') + '"';
const unitOf = (h: HealthRecord | null | undefined, transient: boolean) => (h?.unit ? h.unit === 'time step' : transient);

/** "the last 12 time steps", "the last time step", "the last 50 iterations". */
function lastSteps(window: number, transientUnit: boolean, capital = false): string {
  const unit = transientUnit ? 'time step' : 'iteration';
  const n = Math.max(0, Math.round(window));
  const s = n === 1 ? `last ${unit}` : `last ${n} ${unit}s`;
  // "Last 12 time steps, up to ..." (the subline); "the last 12 time steps" in a sentence.
  return capital ? s[0].toUpperCase() + s.slice(1) : `the ${s}`;
}

/** The word of a run that ended before its health was judged (never "Checking" on an ended run). */
export const NOT_JUDGED = 'Not judged';

/** "It ended before its health could be judged (from the 6th time step on)." */
export function endedBeforeJudged(transient: boolean): string {
  return `It ended before its health could be judged (from the 6th ${transient ? 'time step' : 'iteration'} on).`;
}

/**
 * The chip's word (spec 2.1). `ended`: the run has ended, so a record still pending reads
 * "Not judged", not "Checking".
 */
export function chipWord(h: HealthRecord | null | undefined, transient: boolean, ended = false): string {
  if (!h || h.verdict === 'pending') {
    if (ended) return NOT_JUDGED;
    return unitOf(h, transient) ? 'Checking (needs 6 time steps)' : 'Checking (needs 6 iterations)';
  }
  return VERDICT_WORDS[h.verdict] || 'Checking';
}

/** " Not checked: speed growth (no fixed inflow), pressure-drop drift (no fixed inflow)." or ''. */
export function notCheckedWords(h: HealthRecord | null | undefined): string {
  const skipped = (h?.skipped || []).filter((s) => s && s.code);
  if (!skipped.length) return '';
  return ' Not checked: ' + skipped.map((s) => `${CHECK_NAMES[s.code] || s.code.replace(/_/g, ' ')} (${s.why})`).join(', ') + '.';
}

/** The chip's title (spec 2.1): "Healthy" never reads as good results. `ended` as chipWord. */
export function chipTitle(h: HealthRecord | null | undefined, transient: boolean, ended = false): string {
  const t = unitOf(h, transient);
  const window = isNum(h?.window) ? (h?.window as number) : 0;
  const last = lastSteps(Math.min(50, window), t);
  const settled = t ? 'whether averages have settled' : 'whether the residuals have reached their targets';
  let text: string;
  if ((!h || h.verdict === 'pending') && ended) text = endedBeforeJudged(t);
  else if (!h || h.verdict === 'pending') text = `Health is judged from the 6th ${t ? 'time step' : 'iteration'} on: the start is not scored.`;
  else if (h.verdict === 'healthy') text = `No stability problems found in ${last}. This does not check mesh independence or ${settled}.`;
  else if (h.verdict === 'watch') text = `Something in ${last} needs watching: see the findings. This does not check mesh independence or ${settled}.`;
  else if (h.verdict === 'unhealthy') text = `Stability problems found in ${last}: see the findings.`;
  else text = 'The solver failed: see the findings.';
  return text + notCheckedWords(h);
}

/** "16 s into the solve", "3 min into the solve". */
function wallWords(s: number): string {
  if (s < 120) return `${Math.round(s)} s into the solve`;
  if (s < 7200) return `${Math.round(s / 60)} min into the solve`;
  return `${Math.round(s / 3600)} h into the solve`;
}

/** When it became unhealthy, in words ("since t = 0.0069 s (15 s into the solve)"). */
export function sinceWords(h: HealthRecord, transient: boolean): string {
  const fu = h.first_unhealthy;
  if (!fu || !isNum(fu.t)) return '';
  const t = unitOf(h, transient);
  if (fu.approx) return onsetAt(h, transient);
  const wall = isNum(fu.wall_s) && fu.wall_s > 0 ? ` (${wallWords(fu.wall_s)})` : '';
  return `since ${atWords(fu.t, t)}${wall}`;
}

/**
 * When it became unhealthy: "t = 0.0069 s". An onset in the unread middle of an old run's log
 * (`approx`, spec 3.9) is not a time: "between t = 0.0031 s and t = 0.0069 s" (or "after
 * t = 0.0031 s" when the later time is unknown). '' when unknown.
 */
export function onsetAt(h: HealthRecord | null | undefined, transient: boolean): string {
  const fu = h?.first_unhealthy;
  if (!fu || !isNum(fu.t)) return '';
  const t = unitOf(h, transient);
  if (fu.approx) return isNum(fu.by_t) ? `between ${atWords(fu.t, t)} and ${atWords(fu.by_t, t)}` : `after ${atWords(fu.t, t)}`;
  return atWords(fu.t, t);
}

/** "at t = 0.0069 s", or "between t = A and t = B" for an approximate onset; '' when unknown. */
export function onsetWhen(h: HealthRecord | null | undefined, transient: boolean): string {
  const at = onsetAt(h, transient);
  if (!at) return '';
  return h?.first_unhealthy?.approx ? at : `at ${at}`;
}

/** "since t = 0.0069 s", or "since some time between t = A and t = B"; '' when unknown. */
export function onsetSince(h: HealthRecord | null | undefined, transient: boolean): string {
  const at = onsetAt(h, transient);
  if (!at) return '';
  return h?.first_unhealthy?.approx ? `since some time ${at}` : `since ${at}`;
}

/** The subline under the chip (spec 3.10). `ageS`: seconds since its `at`, for a live record. */
export function healthSubline(h: HealthRecord, run: HealthRunView, ageS: number | null): string {
  const t = unitOf(h, run.transient);
  const window = isNum(h.window) ? (h.window as number) : 0;
  const ended = !['running', 'starting', 'queued'].includes(run.status) && h.live !== true;
  const where = isNum(h.t) ? atWords(h.t, t) : '';
  let s: string;
  if (ended && h.verdict === 'pending') s = endedBeforeJudged(t).slice(0, -1);
  else if (!window) s = where ? (ended ? `Ended at ${where}` : `Up to ${where}`) : 'Not scored yet';
  else if (ended) s = `${lastSteps(window, t, true)} before it ended${where ? ` at ${where}` : ''}`;
  else s = `${lastSteps(window, t, true)}${where ? `, up to ${where}` : ''}`;
  if (!ended && isNum(ageS)) s += ` · updated ${Math.max(0, Math.round(ageS))} s ago`;
  if (h.verdict === 'unhealthy' || h.verdict === 'failed') {
    const since = sinceWords(h, run.transient);
    if (since) s += ` · ${h.verdict === 'failed' ? 'Failed' : 'Unhealthy'} ${since}`;
  }
  if (h.head_missing && isNum(h.checked_steps)) s += ` · Checked the last ${whole(h.checked_steps)} ${t ? 'time steps' : 'iterations'} only`;
  if (h.stale && isNum(h.t)) s += ` · details from ${atWords(h.t, t)} (the latest check was too large to keep)`;
  return s;
}

/** "about 4 days", "about 6 hours". */
export function wallCost(s: number): string {
  const h = s / 3600;
  if (h < 48) return `about ${Math.max(1, Math.round(h))} hour${Math.round(h) === 1 ? '' : 's'}`;
  return `about ${Math.round(h / 24)} days`;
}

/** Steps to 2 significant figures ("180,000"). */
function steps2(n: number): string {
  if (!(n > 0)) return '0';
  const p = Math.pow(10, Math.max(0, Math.floor(Math.log10(n)) - 1));
  return whole(Math.round(n / p) * p);
}

/** A fix's button words with its cost: "New run: 3 outer correctors, Max Courant 5 (~180,000 steps, about 4 days)". */
export function fixLabel(fix: HealthFix): string {
  const c = fix.cost;
  if (!c || !isNum(c.steps) || !isNum(c.wall_s)) return fix.label;
  return `${fix.label} (~${steps2(c.steps)} steps, ${wallCost(c.wall_s)})`;
}

/** The run's name for a new run that takes a fix: "Run_2 fixed" (made unique where it is added). */
export function fixedRunName(name: string): string {
  return `${String(name || 'Run').trim()} fixed`.slice(0, 64);
}

/** The fixes of the first finding that has new-run fixes (the panel's buttons, the Assistant's call). */
export function healthFixes(h: HealthRecord | null | undefined): HealthFix[] {
  for (const f of h?.findings || []) {
    const fixes = (f.fix || []).filter((x) => x && x.target === 'new_run');
    if (fixes.length) return fixes;
  }
  return [];
}

export type HealthRunState = 'running' | 'stopping' | 'stopped_saved' | 'stopped_unsaved' | 'failed' | 'done' | 'other';

/** The run's state as the words gate on it (spec 3.10's table). */
export function healthRunState(run: HealthRunView): HealthRunState {
  const st = String(run.status || '');
  if (run.stopping && ['running', 'starting', 'queued'].includes(st)) return 'stopping';
  if (['running', 'starting', 'queued'].includes(st)) return 'running';
  if (st === 'stopped') return isNum(run.saved) && run.saved > 0 ? 'stopped_saved' : 'stopped_unsaved';
  if (st === 'failed') return 'failed';
  if (st === 'done' || st === 'finished') return 'done';
  return 'other';
}

/** Whether the latest saved time is before the onset (else it was Healthy again by then). */
function savedBeforeOnset(h: HealthRecord, saved: number | null): boolean {
  const onset = h.first_unhealthy?.t;
  return isNum(saved) && isNum(onset) && saved < onset;
}

/** A change waits for the run's Continue (A2's entry with its changes: only a stopped run's counts; RH3's numerics: a finished run's too). */
function changeWaits(run: HealthRunView, pending: ContinueChange | null | undefined): boolean {
  if (!pending || !Array.isArray(pending.changes) || !pending.changes.length) return false;
  const state = healthRunState(run);
  // RH3: the study's numerics changed after it started (a numerics "change" the Continue
  // question offers): a finished run's Continue takes it too.
  return state === 'stopped_saved' || (state === 'done' && pending.kind === 'numerics');
}

/**
 * The `restart` sentence of a stopped or done run (spec 3.10), or ''. `pending`: the change
 * waiting for its Continue (A2), when one waits: then it says only Health on the continued part
 * can tell, never "with the same settings". "Use when continuing" is offered only when the run
 * can take it (`run.continues`).
 */
export function restartSentence(run: HealthRunView, h: HealthRecord, pending?: ContinueChange | null): string {
  const state = healthRunState(run);
  if (state !== 'stopped_saved' && state !== 'done') return '';
  const t = unitOf(h, run.transient);
  const onset = h.first_unhealthy?.t;
  const name = run.name || 'this run';
  if (h.restart === null || h.restart === undefined) {
    return h.head_missing ? 'The start of its log is gone, so when the problem began is unknown.' : '';
  }
  if (!isNum(onset)) return '';
  const saved = isNum(run.saved) ? atWords(run.saved, t) : 'its last saved time';
  const began = onsetAt(h, run.transient);
  if (h.restart === 'from_zero') {
    return `Its saved results (from ${saved}) come after the problem began (${began}), so Continue would carry it on. Start again from ${t ? 't = 0' : 'iteration 0'} in a new run; ${name} and its results stay.`;
  }
  const surer = `A new run from ${t ? 't = 0' : 'iteration 0'} is the surer way.`;
  const waits = changeWaits(run, pending);
  const checks = `Health checks the continued part from ${saved}; whether the change is enough shows only there.`;
  const end =
    state === 'done'
      ? "A finished run's settings do not change, so a change needs a new run."
      : run.continues
        ? `A change made with "Use when continuing" (Max Courant or the correctors) may avoid that, but only Health on the continued part can tell. ${surer}`
        : surer;
  if (savedBeforeOnset(h, run.saved)) {
    if (waits) return `Its last saved time (${saved}) is before it became unhealthy (${began}). ${checks} ${surer}`;
    return `Its last saved time (${saved}) is before it became unhealthy (${began}). Continue goes on from there; with the same settings it will likely become unhealthy again. ${end}`;
  }
  const doneEnd = state === 'done' ? end : surer;
  const from = h.first_unhealthy?.approx ? `from some time ${began}` : `from ${began}`;
  if (waits) return `It was unhealthy ${from} and Healthy again by its last saved time (${saved}). Results saved in between hold the problem. ${checks} ${surer}`;
  return `It was unhealthy ${from} and Healthy again by its last saved time (${saved}). Results saved in between hold the problem, and Continue with the same settings may repeat it. ${doneEnd}`;
}

export interface HealthNext {
  /** The sentence of what to do ('' when none). */
  text: string;
  /** Offer a plain Stop (the run still solves). */
  stop: boolean;
  /** The new-run buttons: the first is the primary one. */
  fixes: Array<HealthFix & { words: string }>;
}

/**
 * What to do about an unhealthy (or failed) run (spec 3.10, A3), gated by the run's state:
 * the Health block, the Continue box and the Assistant's `next` all show this. `pending`: the
 * change waiting for its Continue (A2), the one the Continue box shows.
 */
export function healthNextWords(run: HealthRunView, h: HealthRecord | null | undefined, pending?: ContinueChange | null): HealthNext {
  const fixes = healthFixes(h).map((f) => ({ ...f, words: fixLabel(f) }));
  const out: HealthNext = { text: '', stop: false, fixes };
  if (!h || (h.verdict !== 'unhealthy' && h.verdict !== 'failed')) return { text: '', stop: false, fixes: [] };
  switch (healthRunState(run)) {
    case 'running':
      out.stop = true;
      break;
    case 'stopping':
      out.text = 'Stopping: it is writing its current time step.';
      break;
    case 'stopped_saved':
    case 'done':
      out.text = restartSentence(run, h, pending);
      break;
    case 'stopped_unsaved':
      out.text = 'It has no saved time to continue from.';
      break;
    case 'failed':
      out.text = 'A failed run does not continue (Continue is offered only for stopped and finished runs); starting it again deletes its results.';
      break;
    default:
      break;
  }
  return out;
}

/**
 * "Max Courant 100 → 5, outer correctors 1 → 3" (A2's continue_changes). A numerics change (RH3)
 * carries its own words ("Relaxation p 0.3 → 0.2", runReopen.ts numericsDiff).
 */
export function changeWords(changes: Array<{ key: string; from: unknown; to: unknown; text?: string }>): string {
  return changes
    .map((c) =>
      typeof c.text === 'string' && c.text
        ? c.text
        : `${KEY_NAMES[c.key] || c.key.replace(/^transient\./, '').replace(/_/g, ' ')} ${String(c.from ?? 'auto')} → ${String(c.to ?? 'auto')}`,
    )
    .join(', ');
}

export interface ContinueChange {
  from_t?: number | null;
  from_iteration?: number | null;
  applied_at?: string | null;
  /** settings (A2's four keys) or numerics (RH3: the study's new numerics taken at a Continue). */
  kind?: string;
  changes?: Array<{ key: string; from: unknown; to: unknown; text?: string }>;
  /** A numerics entry's changes past the ones it keeps. */
  more?: number;
}

/**
 * The Continue box's health line (spec 3.12) and whether Continue asks first (`ask`: a
 * from_zero run). Null when it has none. `pending`: the change waiting for its Continue (A2), or
 * (RH3) the study's numerics changed since it started (`kind` 'numerics', the differences as its
 * changes): either way it says only Health on the continued part can tell, never that its
 * settings have not changed.
 */
export function continueHealthWords(
  run: HealthRunView,
  h: HealthRecord | null | undefined,
  pending?: ContinueChange | null,
): { text: string; ask: boolean } | null {
  if (!h || !h.first_unhealthy || !isNum(h.first_unhealthy.t)) return null;
  const state = healthRunState(run);
  if (state !== 'stopped_saved' && state !== 'done') return null;
  const t = unitOf(h, run.transient);
  const began = onsetAt(h, run.transient);
  const saved = isNum(run.saved) ? atWords(run.saved, t) : '';
  const parts: string[] = [];
  let ask = false;
  if (h.restart === 'from_zero') {
    ask = true;
    parts.push(`Its saved results (${saved}) are from after it became unhealthy (${began}); continuing carries that on. A new run from t = 0 is safer.`);
  }
  if (changeWaits(run, pending)) {
    parts.push(`Health checks the continued part from ${saved || 'its last saved time'}; whether the change is enough shows only there.`);
  } else if (h.restart === 'continue_after_fix') {
    parts.push(restartSentence(run, h));
  } else if (!ask && h.verdict === 'unhealthy') {
    parts.push(`It became unhealthy ${onsetWhen(h, run.transient)} and its settings have not changed since, so Continue will likely repeat the problem.`);
  }
  const text = parts.filter(Boolean).join(' ');
  return text ? { text, ask } : null;
}

/** The person's Continue question on a from_zero run (and the Assistant's card copy). */
export function continueAskWords(run: HealthRunView, h: HealthRecord): { title: string; copy: string; yes: string; no: string } {
  const line = continueHealthWords(run, h, null);
  return { title: `Continue ${quoted(run.name)}?`, copy: line ? line.text : '', yes: 'Continue anyway', no: 'Cancel' };
}

/** The "will likely repeat" sentence of a run that became unhealthy and whose settings have not changed. */
export function repeatSentence(run: HealthRunView, h: HealthRecord): string {
  if (!h.first_unhealthy || !isNum(h.first_unhealthy.t)) return '';
  return `It became unhealthy ${onsetWhen(h, run.transient)} and its settings have not changed since, so Continue will likely repeat the problem.`;
}

/** "Unhealthy (velocity clipping, turbulence bounding)" of an earlier part's health. */
export function attemptWords(a: { verdict?: string; codes?: string[] } | null | undefined): string {
  if (!a || !a.verdict) return '';
  const word = a.verdict === 'pending' ? 'Not judged' : VERDICT_WORDS[a.verdict as Exclude<HealthVerdict, 'pending'>] || a.verdict;
  const codes = (a.codes || []).map((c) => CHECK_NAMES[c] || c.replace(/_/g, ' ')).filter((v, i, all) => all.indexOf(v) === i);
  return codes.length ? `${word} (${codes.slice(0, 3).join(', ')})` : word;
}

/** Two saved times are the same within 1e-9 of their size. */
const sameTime = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(Math.abs(a), Math.abs(b));

/**
 * The Health block's earlier-part lines: "Earlier part (to t = 0.2 s): Unhealthy (velocity
 * clipping, turbulence bounding). Then Max Courant 100 → 5 from t = 0.2 s." A change belongs to
 * the part whose last saved time it went on from (its `from_t`, or `from_iteration`): a Continue
 * with no change adds a part and no entry, so the order alone does not pair them. A part no
 * applied change went on from gets no "Then". A Continue that applied a waiting change and took
 * the study's new numerics (RH3) names both, in that order.
 */
export function earlierPartLines(
  attempts: Array<{ last_saved_iteration?: unknown; end_time?: unknown; health?: { verdict?: string; codes?: string[] } | null }> | null | undefined,
  changes: ContinueChange[] | null | undefined,
  transient: boolean,
): string[] {
  const out: string[] = [];
  const applied = (changes || []).filter((c) => c && c.applied_at && c.changes && c.changes.length);
  const used = new Set<ContinueChange>();
  (attempts || []).forEach((a) => {
    const to = isNum(Number(a.last_saved_iteration)) && Number(a.last_saved_iteration) > 0 ? Number(a.last_saved_iteration) : null;
    const words = attemptWords(a.health || null);
    let line = `Earlier part${to !== null ? ` (to ${atWords(to, transient)})` : ''}: ${words || 'its health was not checked'}.`;
    // Each entry once: a settings entry and a numerics one of the same Continue go on from the same time.
    const found: ContinueChange[] = [];
    if (to !== null) {
      for (const kind of ['settings', 'numerics']) {
        const c = applied.find((x) => {
          if (used.has(x) || (x.kind || 'settings') !== kind) return false;
          const from = isNum(x.from_t) ? x.from_t : isNum(x.from_iteration) ? x.from_iteration : null;
          return from !== null && sameTime(from, to);
        });
        if (c) found.push(c);
      }
    }
    if (found.length) {
      found.forEach((c) => used.add(c));
      const said = found.map((c) => changeWords(c.changes || []) + (isNum(c.more) && c.more > 0 ? ` and ${c.more} more` : '')).join(', ');
      line += ` Then ${said} from ${atWords(to, transient)}.`;
    }
    out.push(line);
  });
  return out;
}

/** The one-time notice when a run turns unhealthy (spec 3.11). */
export function unhealthyNotice(who: string, h: HealthRecord, transient: boolean): string {
  const since = onsetSince(h, transient);
  return `${who} is unhealthy${since ? ' ' + since : ''}. See Health in its Run panel.`;
}

/** The tree badge's title (spec 3.11). */
export function badgeTitle(h: HealthRecord, transient: boolean): string {
  const since = onsetSince(h, transient);
  return `Health: Unhealthy${since ? ' ' + since : ''}`;
}

/** Runs that are not checked, or ran before checks existed (spec 3.10). */
export const NOT_CHECKED = 'Health is not checked for this kind of run.';
export const BEFORE_CHECKS = 'This run ran before health checks existed.';
export const FAILED_BEFORE_SOLVER = 'It failed before its solver started, so there is no solver output to check.';
export const NOT_RECORDED = 'Its health was not recorded.';

/**
 * What the Health block (and the Assistant) say of an ENDED run that has no health record, as
 * its `health_checked` and its progress tell: '' when there is nothing to say this way (a
 * running run, or one from before health checks: "Check its log" is offered there).
 */
export function noRecordWords(run: HealthRunView & { n_steps?: number | null }, healthChecked: boolean | null | undefined): string {
  if (healthChecked === false) return NOT_CHECKED;
  const ended = ['done', 'stopped', 'failed', 'finished'].includes(String(run.status || ''));
  if (healthChecked !== true || !ended) return '';
  const steps = isNum(run.n_steps) ? run.n_steps : 0;
  if (run.status === 'failed' && steps <= 0) return FAILED_BEFORE_SOLVER;
  if (steps >= 6) return NOT_RECORDED;
  return endedBeforeJudged(run.transient);
}
