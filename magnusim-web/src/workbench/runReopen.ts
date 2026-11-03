/**
 * A run that ended, and a change of its settings (Daniel, 2026-11-03): the one rule the run
 * panel (runtime.js), the server (w27-solve.js) and the Assistant (host/setup-edit.ts,
 * host/compute.ts) share, with the words each of them shows.
 *
 * - A stopped or failed run can be started over. The first change of a solve setting (or a
 *   Start) on one that has something to overwrite asks first: its results are deleted at once
 *   and it becomes a draft again. One with nothing to overwrite becomes a draft quietly.
 * - A finished (done) run is never overwritten. A change of its settings makes a new run with
 *   the same settings and that change; Start stays refused.
 * - A run that is solving or stopping keeps its settings until it has ended.
 *
 * Solve settings are what only a fresh Start uses (Continue ignores them or can't handle a
 * change of them): iterations, write interval, the transient settings, the run's mesh and its
 * time dependency. Free settings (name, cores, the settle stop, monitors, saved views) are used
 * by Continue too, so changing them deletes nothing.
 *
 * Pure, with no imports: the server imports this file as it is.
 */

/** Statuses a run can be started over from (its results deleted first). */
export const REOPENABLE: readonly string[] = Object.freeze(['stopped', 'failed']);

/** The run settings only a fresh Start uses (the keys of POST /api/run/update). */
export const SOLVE_KEYS: readonly string[] = Object.freeze(['endTime', 'writeInterval', 'transient', 'mesh_id', 'time_dependency']);

/** The run settings Continue uses too: changing them never deletes results. */
export const FREE_KEYS: readonly string[] = Object.freeze(['name', 'cores', 'settle', 'settle_time_dependency', 'result_controls', 'views', 'current_view']);

/** Transient keys that are bookkeeping, never the person's settings. */
const TRANSIENT_BOOKKEEPING = new Set(['source', 'estimate']);

/**
 * What a change of a run's solve settings does:
 * - draft: saved on it;
 * - free: an ended run with nothing to overwrite: it becomes a draft quietly, then saved;
 * - overwrites: an ended run with results: asks first, then deletes them;
 * - new_run: a finished run: a new run with its settings and the change;
 * - locked: solving or stopping: refused until it has ended.
 */
export type RunEditState = 'draft' | 'free' | 'overwrites' | 'new_run' | 'locked';

export interface RunLike {
  id?: unknown;
  run_id?: unknown;
  name?: unknown;
  status?: unknown;
  stop_requested?: unknown;
  has_results?: unknown;
  n_saved_times?: unknown;
  last_saved_iteration?: unknown;
  n_steps?: unknown;
  iteration?: unknown;
  sim_time?: unknown;
  endTime?: unknown;
  writeInterval?: unknown;
  mesh_id?: unknown;
  time_dependency?: unknown;
  transient?: unknown;
  [k: string]: unknown;
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const statusOf = (rec: RunLike | null | undefined): string => String((rec && rec.status) || '').trim();
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** A run that solved (or was solving) in seconds rather than iterations. */
export function solvedTransient(rec: RunLike | null | undefined): boolean {
  return /transient/i.test(String((rec && rec.time_dependency) || ''));
}

/** The mode's name as the panel shows it. */
export function modeName(transient: boolean): 'Transient' | 'Steady-state' {
  return transient ? 'Transient' : 'Steady-state';
}

/** The run has saved results, or residuals and monitor data, that a fresh Start deletes. */
export function hasOverwritable(rec: RunLike | null | undefined): boolean {
  if (!rec) return false;
  return rec.has_results === true || num(rec.n_saved_times) > 0 || num(rec.last_saved_iteration) > 0 || num(rec.n_steps) > 0;
}

/** What a change of this run's solve settings does (RunEditState). */
export function runEditState(rec: RunLike | null | undefined): RunEditState {
  const st = statusOf(rec);
  if (!st || st === 'draft' || st === 'idle') return 'draft';
  if (st === 'done' || st === 'finished') return 'new_run';
  if (REOPENABLE.includes(st)) return hasOverwritable(rec) ? 'overwrites' : 'free';
  return 'locked';
}

/** The edit state as the Assistant's read_setup reports it. */
export function runSettingsWord(state: RunEditState): 'editable' | 'overwrites' | 'new_run' | 'locked' {
  return state === 'draft' || state === 'free' ? 'editable' : state;
}

function sameValue(a: unknown, b: unknown): boolean {
  const blank = (v: unknown) => v === null || v === undefined || v === '';
  if (blank(a) && blank(b)) return true;
  if (blank(a) !== blank(b)) return false;
  if (typeof a === 'number' || typeof b === 'number') {
    const x = Number(a);
    const y = Number(b);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return String(a) === String(b);
    return Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(x), Math.abs(y));
  }
  if (typeof a === 'boolean' || typeof b === 'boolean') return a === b;
  if (isObj(a) || isObj(b) || Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a) === JSON.stringify(b);
  return String(a) === String(b);
}

/**
 * The solve settings `body` (a POST /api/run/update body) changes on `rec`, by key: a number
 * within 1e-9 of the stored one, and a transient block's bookkeeping (source, estimate), are no
 * change. A transient key the stored block lacks counts only when the body gives it a value.
 */
export function solveChanged(rec: RunLike | null | undefined, body: Record<string, unknown> | null | undefined): string[] {
  const out: string[] = [];
  if (!body) return out;
  const r = rec || {};
  if (body.endTime != null && !sameValue(num(body.endTime), r.endTime == null ? null : num(r.endTime))) out.push('endTime');
  if (body.writeInterval != null && !sameValue(num(body.writeInterval), r.writeInterval == null ? null : num(r.writeInterval))) out.push('writeInterval');
  if (body.mesh_id != null && String(body.mesh_id) !== String(r.mesh_id || '')) out.push('mesh_id');
  if (body.time_dependency != null && /transient/i.test(String(body.time_dependency)) !== solvedTransient(r)) out.push('time_dependency');
  if (isObj(body.transient)) {
    const stored = isObj(r.transient) ? r.transient : {};
    for (const [k, v] of Object.entries(body.transient)) {
      if (TRANSIENT_BOOKKEEPING.has(k)) continue;
      if (!sameValue(v, stored[k])) {
        out.push('transient.' + k);
      }
    }
  }
  return out;
}

/**
 * A started run's transient block made a draft's again: each value its analysis worked out
 * (`source[k] === 'auto'`: the time step, its cap) is blank again, so the next Start works it
 * out for the new settings; the bookkeeping goes.
 */
export function unresolveTransient(t: unknown): Record<string, unknown> | null {
  if (!isObj(t)) return null;
  const source = isObj(t.source) ? t.source : {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(t)) {
    if (TRANSIENT_BOOKKEEPING.has(k)) continue;
    out[k] = source[k] === 'auto' ? null : v;
  }
  return out;
}

/**
 * An edit of a run that is started over: a value it carries unchanged from the old block that
 * was worked out (`auto`) stays blank, so only what the person typed is kept.
 */
export function keepAutoBlank(old: unknown, edit: Record<string, unknown>): Record<string, unknown> {
  if (!isObj(old) || !isObj(old.source)) return { ...edit };
  const out: Record<string, unknown> = { ...edit };
  for (const [k, how] of Object.entries(old.source)) {
    if (how === 'auto' && k in out && sameValue(out[k], old[k])) out[k] = null;
  }
  for (const k of TRANSIENT_BOOKKEEPING) delete out[k];
  return out;
}

function simTime(v: unknown): string {
  const n = num(v);
  if (n === 0) return '0 s';
  const a = Math.abs(n);
  const s =
    a >= 100 ? n.toFixed(0) : a >= 10 ? n.toFixed(1) : a >= 1 ? String(Number(n.toFixed(2))) : a >= 0.01 ? String(Number(n.toFixed(3))) : a >= 1e-3 ? String(Number(n.toFixed(4))) : n.toExponential(1);
  return s + ' s';
}

const quoted = (rec: RunLike | null | undefined) => '"' + String((rec && rec.name) || 'this run') + '"';

/** Where the run's results go up to: "iteration 450", "t = 0.45 s". */
function upTo(rec: RunLike, saved: boolean): string {
  const transient = solvedTransient(rec);
  const at = saved
    ? num(rec.last_saved_iteration)
    : Math.max(num(rec.last_saved_iteration), transient ? num(rec.sim_time) : num(rec.iteration), transient ? 0 : num(rec.n_steps));
  return transient ? 't = ' + simTime(at || rec.sim_time) : 'iteration ' + (at || num(rec.iteration) || num(rec.n_steps));
}

/** "Its results (12 saved, up to iteration 450)" or "Its residuals and monitor data up to iteration 40". */
function whatGoes(rec: RunLike): string {
  const n = num(rec.n_saved_times);
  if (n > 0 || num(rec.last_saved_iteration) > 0) {
    return 'Its results (' + (n > 0 ? n + ' saved, ' : '') + 'up to ' + upTo(rec, true) + ')';
  }
  return 'Its residuals and monitor data up to ' + upTo(rec, false);
}

/** Continue can go on from its last saved result: a stopped run with one. */
function canContinue(rec: RunLike): boolean {
  return statusOf(rec) === 'stopped' && (num(rec.n_saved_times) > 0 || num(rec.last_saved_iteration) > 0);
}

export interface Words {
  title: string;
  copy: string;
  yes: string;
}

/**
 * The question before a run's results are overwritten: on the first change of a solve setting
 * (`action: 'edit'`) or on Start (`action: 'start'`). `studyTransient`: the run's study's mode
 * now (a run started over takes it). `assistant`: the Assistant's card asks it.
 */
export function overwriteWords(rec: RunLike, opts: { action: 'edit' | 'start'; studyTransient?: boolean | null; assistant?: boolean }): Words {
  const name = quoted(rec);
  const goes = whatGoes(rec);
  const modeChanges = typeof opts.studyTransient === 'boolean' && opts.studyTransient !== solvedTransient(rec);
  const study = modeName(!!opts.studyTransient);
  if (opts.action === 'start') {
    const keep = canContinue(rec)
      ? ' To keep them, cancel and use Continue to go on from ' + upTo(rec, true) + ', or add a run.'
      : ' To keep them, cancel and add a run.';
    return {
      title: opts.assistant ? 'Allow the Assistant to start ' + name + ' over?' : 'Start ' + name + ' over?',
      copy: goes + ' are deleted, and it solves again from the beginning.' + keep + (modeChanges ? ' It solves ' + study + ', as its study is now.' : ''),
      yes: 'Overwrite and start',
    };
  }
  const keep = canContinue(rec)
    ? ' To keep them, cancel and add a run, or use Continue to go on from ' + upTo(rec, true) + '.'
    : ' To keep them, cancel and add a run.';
  return {
    title: opts.assistant ? 'Allow the Assistant to overwrite ' + name + '?' : 'Overwrite ' + name + '?',
    copy:
      'Changing this setting starts ' + name + ' over. ' + goes + ' are deleted now, and Start solves it again from the beginning.' + keep +
      (modeChanges ? ' It becomes a ' + study + ' run, as its study is now.' : ''),
    yes: 'Overwrite',
  };
}

/** The question on the first change of a finished run's settings: a new run takes the change. */
export function newRunWords(rec: RunLike): Words {
  return {
    title: quoted(rec) + ' has finished',
    copy: 'Its results stay as they are. Make a new run with the same settings and this change?',
    yes: 'Make new run',
  };
}

/**
 * The toast once a run was started over. `deleted` (default true): it had results the person
 * said to delete; `droppedContinue`: a queued Continue of it left the queue (it had nothing to
 * go on from any more).
 */
export function overwrittenToast(rec: RunLike, opts?: { deleted?: boolean; droppedContinue?: boolean }): string {
  const said = opts?.deleted === false ? quoted(rec) + ' starts over.' : quoted(rec) + ' starts over: its old results were deleted.';
  return opts?.droppedContinue ? said + ' Its queued Continue was removed from the queue.' : said;
}

/** The toast once a finished run's change went to a new run. */
export function newRunToast(made: RunLike, from: RunLike): string {
  return 'Made ' + quoted(made) + ' with the settings of ' + quoted(from) + ' and your change. ' + quoted(from) + ' keeps its results.';
}

/** Why a finished run's settings change elsewhere (the Assistant's refusal, the route's). */
export function finishedRefusal(rec: RunLike): string {
  return quoted(rec) + ' has finished and its results stay as they are: a change of its settings goes to a new run with the same settings.';
}

/** The route's refusal while a run solves or stops. */
export const RUNNING_REFUSAL = "This run is solving. Its settings can change once it has ended (Stop ends it).";

/** The route's refusal while a run's stop is still writing or copying its results. */
export const STOPPING_REFUSAL = "This run is still stopping. Its settings can change once it has stopped.";

/** The Run panel's line while a run stops. */
export const STOPPING_REASON = "Stopping. You can change this run's settings once it has stopped.";

/**
 * The Run panel's line for a run that ended (or null): a finished run says a change makes a new
 * run; a stopped or failed run whose study now has the other mode says what Start or a change does.
 * `studyTransient`: its study's mode now.
 */
export function endedRunReason(rec: RunLike | null | undefined, studyTransient: boolean): string | null {
  if (!rec) return null;
  const st = statusOf(rec);
  const runT = solvedTransient(rec);
  const differs = runT !== !!studyTransient;
  const was = modeName(runT);
  const now = modeName(!!studyTransient);
  if (st === 'done' || st === 'finished') {
    if (differs) return 'This run solved ' + was + '; its study is now ' + now + '. Changing a setting makes a new ' + now + " run with this run's settings.";
    return 'This run finished. Changing a setting makes a new run with the same settings and that change.';
  }
  if (REOPENABLE.includes(st) && differs) {
    return (
      'This run solved ' + was + '; its study is now ' + now + '. Start or a settings change solves ' + now + ' in this run' +
      (hasOverwritable(rec) ? ' and overwrites its results. Add a run to keep them.' : '.')
    );
  }
  return null;
}

/** Continue's line when the case folder has no saved result: a stopped run can start again, a finished one can't. */
export function noSavedTimeText(status: unknown): string {
  return String(status || '') === 'stopped' || String(status || '') === 'failed'
    ? "This run can't continue: its case folder has no saved result. Start solves it again from the beginning."
    : "This run can't continue: its case folder has no saved result. Add a run to solve again.";
}
