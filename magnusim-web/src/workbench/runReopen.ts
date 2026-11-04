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
 * A stopped run with a saved time Continue can go on from (A2, Daniel 2026-11-03): a change of
 * only its Max Courant, outer correctors, pressure correctors or Max time step (CONTINUE_KEYS)
 * asks one question with three answers: Start over (as above), Use when continuing (its results
 * stay; Continue goes on with the new values, and the run records the change in
 * `continue_changes`) or Cancel. Every other solve setting asks the two-way question.
 *
 * Numerics at Continue (RH3, spec 5.3): a Start records what numerics the run starts with
 * (`numerics_used`). When the study's numerics differ from that record, Continue says so and
 * asks: the study's new numerics, or as it was (numericsDiff makes the one list every text uses).
 *
 * Pure, with no imports: the server imports this file as it is.
 */

/** Statuses a run can be started over from (its results deleted first). */
export const REOPENABLE: readonly string[] = Object.freeze(['stopped', 'failed']);

/** The run settings only a fresh Start uses (the keys of POST /api/run/update). */
export const SOLVE_KEYS: readonly string[] = Object.freeze(['endTime', 'writeInterval', 'transient', 'mesh_id', 'time_dependency']);

/** The run settings Continue uses too: changing them never deletes results. */
export const FREE_KEYS: readonly string[] = Object.freeze([
  'name',
  'cores',
  'settle',
  'settle_time_dependency',
  'result_controls',
  'views',
  'current_view',
  // RH2: the pre-run check codes kept as set ("Keep as set").
  'checks_kept',
]);

/**
 * The solve settings a stopped run can take for when it continues (A2): Continue writes them
 * from where it goes on. A subset of the transient settings (SOLVE_KEYS' `transient`).
 */
export const CONTINUE_KEYS: readonly string[] = Object.freeze([
  'transient.max_co',
  'transient.n_outer_correctors',
  'transient.n_correctors',
  'transient.max_delta_t',
]);

/** Transient keys that are bookkeeping, never the person's settings. */
const TRANSIENT_BOOKKEEPING = new Set(['source', 'estimate']);

/**
 * What a change of a run's solve settings does:
 * - draft: saved on it;
 * - free: an ended run with nothing to overwrite: it becomes a draft quietly, then saved;
 * - overwrites: an ended run with results: asks first, then deletes them;
 * - continues: a stopped Transient run with a saved time Continue goes on from, in a study that
 *   is still Transient: as overwrites, but a change of only CONTINUE_KEYS may instead wait for
 *   Continue (A2, three answers);
 * - new_run: a finished run: a new run with its settings and the change;
 * - locked: solving or stopping: refused until it has ended.
 */
export type RunEditState = 'draft' | 'free' | 'overwrites' | 'continues' | 'new_run' | 'locked';

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
  continue_from?: unknown;
  continue_changes?: unknown;
  /** RH3: what numerics it started with (NumericsUsed). */
  numerics_used?: unknown;
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

/**
 * Where Continue goes on from (the rule of the Run panel's Continue box): the run's
 * `continue_from` when the read has it (the latest saved time in its case folder; null: none),
 * else its last saved iteration or time when above 0; null when there is none.
 */
export function savedTimeOf(rec: RunLike | null | undefined): number | null {
  if (!rec) return null;
  const raw = rec.continue_from !== undefined ? rec.continue_from : num(rec.last_saved_iteration) > 0 ? rec.last_saved_iteration : null;
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * What a change of this run's solve settings does (RunEditState). `studyTransient`: its study's
 * mode now, when the caller knows it.
 */
export function runEditState(rec: RunLike | null | undefined, opts?: { studyTransient?: boolean | null }): RunEditState {
  const st = statusOf(rec);
  if (!st || st === 'draft' || st === 'idle') return 'draft';
  if (st === 'done' || st === 'finished') return 'new_run';
  if (REOPENABLE.includes(st)) {
    // Continue is offered for a stopped run with a saved time only (never a failed one). The four
    // settings that can wait for it are transient ones: a steady run's Continue never uses them,
    // and a run whose study is now Steady-state starts over as one (endedRunReason says so).
    if (st === 'stopped' && savedTimeOf(rec) !== null) {
      return solvedTransient(rec) && opts?.studyTransient !== false ? 'continues' : 'overwrites';
    }
    return hasOverwritable(rec) ? 'overwrites' : 'free';
  }
  return 'locked';
}

/** A change of a solve setting deletes the run's results (asked first): overwrites, or continues. */
export function overwritesResults(state: RunEditState): boolean {
  return state === 'overwrites' || state === 'continues';
}

/** The edit state as the Assistant's read_setup reports it. */
export function runSettingsWord(state: RunEditState): 'editable' | 'overwrites' | 'continues' | 'new_run' | 'locked' {
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
 * A stopped run's transient block once a change waits for its Continue (A2): the block it solved
 * with, kept whole (its write interval and what its Start worked out, which Continue reads), with
 * only the changed CONTINUE_KEYS taken from `clean` (the edit as its analysis cleaned it). A Max
 * time step given is the person's now ('user'), a blank one is worked out again ('auto').
 */
export function continueTransient(old: unknown, clean: Record<string, unknown>, changed: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = isObj(old) ? { ...old } : {};
  const source = isObj(out.source) ? { ...out.source } : null;
  for (const key of changed) {
    if (!CONTINUE_KEYS.includes(key)) continue;
    const k = key.slice('transient.'.length);
    const v = clean[k] === undefined ? null : clean[k];
    out[k] = v;
    if (source && k === 'max_delta_t') source[k] = v === null || v === '' ? 'auto' : 'user';
  }
  if (source) out.source = source;
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
    a >= 100 ? n.toFixed(0) : a >= 10 ? n.toFixed(1) : a >= 1 ? String(Number(n.toFixed(2))) : a >= 1e-3 ? String(Number(n.toFixed(4))) : n.toExponential(1);
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
export function overwriteWords(
  rec: RunLike,
  opts: { action: 'edit' | 'start'; studyTransient?: boolean | null; assistant?: boolean; health?: unknown },
): Words {
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
      copy:
        goes + ' are deleted, and it solves again from the beginning.' + keep + (modeChanges ? ' It solves ' + study + ', as its study is now.' : '') +
        unhealthySentence(rec, opts.health),
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

/** Whether a health record offers a new run with a fix (a finding's `new_run` fix, or the tree's `has_fix`). */
function offersNewRunFix(health: Record<string, unknown>): boolean {
  if (health.has_fix === true) return true;
  const findings = Array.isArray(health.findings) ? health.findings : [];
  return findings.some((f) => isObj(f) && Array.isArray(f.fix) && f.fix.some((x) => isObj(x) && x.target === 'new_run'));
}

/**
 * RH1 (A3): the sentence Start's question and the Assistant's run_start card add for a run that
 * became unhealthy (its health record's `first_unhealthy`), else ''. One function makes both
 * texts, so they are the same. "with the fix" only when its health offers one; an onset in the
 * unread middle of an old log (`approx`) reads "between t = A and t = B".
 */
export function unhealthySentence(rec: RunLike, health: unknown): string {
  const fu = isObj(health) && isObj(health.first_unhealthy) ? health.first_unhealthy : null;
  const t = fu ? Number(fu.t) : NaN;
  if (!isObj(health) || !fu || fu.t === null || fu.t === undefined || !Number.isFinite(t)) return '';
  const transient = solvedTransient(rec);
  const at = (v: number) => (transient ? 't = ' + simTime(v) : 'iteration ' + Math.round(v));
  const by = fu.by_t === null || fu.by_t === undefined ? NaN : Number(fu.by_t);
  const when = fu.approx ? (Number.isFinite(by) ? 'between ' + at(t) + ' and ' + at(by) : 'after ' + at(t)) : 'at ' + at(t);
  const keeps = offersNewRunFix(health) ? 'A new run with the fix keeps these results.' : 'A new run keeps these results.';
  return ' ' + quoted(rec) + ' became unhealthy ' + when + '. ' + keeps;
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

// ---------------------------------------------------------------- A2: a change for when it continues

/** Every changed key (solveChanged's) is one Continue can take, and there is at least one. */
export function onlyContinueKeys(changed: readonly string[]): boolean {
  return changed.length > 0 && changed.every((k) => CONTINUE_KEYS.includes(k));
}

/**
 * One change a run records for its Continue: a key ("transient.max_co"), its value before and
 * after. A numerics change (RH3) also keeps its label and words ("Relaxation p 0.3 → 0.2").
 */
export interface ContinueChange {
  key: string;
  from: unknown;
  to: unknown;
  label?: string;
  text?: string;
}

/**
 * A run's `continue_changes` entry: what changed for its Continue, from which saved time, when
 * and by whom. `applied_at` is null while it waits for Continue (at most one entry waits, of kind
 * `settings`), then the time the Continue that took it started.
 */
export interface ContinueEntry {
  from_t: number | null;
  from_iteration: number | null;
  at: string;
  by: 'person' | 'assistant' | 'both';
  kind: 'settings' | 'numerics';
  changes: ContinueChange[];
  applied_at: string | null;
  /** RH3: a numerics entry's changes past the 8 it keeps. */
  more?: number;
}

/** At most this many entries are kept (the oldest applied one goes first). */
export const CONTINUE_CHANGES_MAX = 20;
/** At most this many changes in one entry. */
const ENTRY_CHANGES_MAX = 8;

function entriesOf(raw: unknown): ContinueEntry[] {
  return (Array.isArray(raw) ? raw : []).filter((e): e is ContinueEntry => isObj(e) && Array.isArray((e as Record<string, unknown>).changes));
}

/** The entry still waiting for Continue, or null. */
export function pendingContinue(rec: RunLike | null | undefined): ContinueEntry | null {
  return entriesOf(rec && rec.continue_changes).find((e) => !e.applied_at && (e.kind || 'settings') === 'settings') || null;
}

/** The keys waiting for Continue (the Run panel's "Takes effect when you Continue" marks). */
export function continuePendingKeys(rec: RunLike | null | undefined): string[] {
  const e = pendingContinue(rec);
  return e ? e.changes.map((c) => String(c.key)) : [];
}

/**
 * A new run made from this run (Health's fix, A3) solves from t = 0 and never continues it, so the
 * values waiting for its Continue are not its: each waiting key at the value this run solved with
 * (its `from`), set on the new run before the fix's own values. A Max time step that equals the
 * run's write interval is what a blank one works out to, so it is blank (auto) again. [] when
 * nothing waits.
 */
export function valuesBeforeContinue(rec: RunLike | null | undefined): Array<{ key: string; value: unknown }> {
  const e = pendingContinue(rec);
  if (!e) return [];
  const t = rec && isObj(rec.transient) ? rec.transient : {};
  return e.changes
    .filter((c) => CONTINUE_KEYS.includes(String(c.key)))
    .map((c) => {
      const key = String(c.key);
      let value = c.from === undefined || c.from === '' ? null : c.from;
      if (key === 'transient.max_delta_t' && value !== null && t.write_interval != null && sameValue(value, t.write_interval)) value = null;
      return { key, value };
    });
}

/** A run's value of a key ("transient.max_co", "endTime"), as stored on it. */
export function transientValue(rec: RunLike | null | undefined, key: string): unknown {
  const t = rec && isObj(rec.transient) ? rec.transient : {};
  return key.startsWith('transient.') ? t[key.slice('transient.'.length)] : rec ? rec[key] : undefined;
}

/**
 * The changes a body makes of a run's CONTINUE_KEYS (each key of `changed` that is one):
 * from the run's stored value, to the body's.
 */
export function continueChangesOf(rec: RunLike | null | undefined, body: Record<string, unknown> | null | undefined, changed: readonly string[]): ContinueChange[] {
  const bodyT = body && isObj(body.transient) ? body.transient : {};
  return changed
    .filter((k) => CONTINUE_KEYS.includes(k))
    .map((k) => ({ key: k, from: transientValue(rec, k) ?? null, to: bodyT[k.slice('transient.'.length)] ?? null }));
}

/**
 * The merge rule (A2), the same for the person and the Assistant, applied by the server to
 * every `at_continue` save: the waiting entry takes the changes (a key it has keeps its `from`
 * and takes the new `to`; a new key comes with `from` = the value Continue would otherwise
 * use); a key whose `to` equals its `from` leaves it, and an entry left empty goes. Its `at` is
 * now; its `by` becomes 'both' when the other side changes an entry it did not start. With no
 * entry waiting, a new one starts. At most CONTINUE_CHANGES_MAX entries are kept: the oldest
 * applied ones go first.
 */
export function mergeContinueChanges(
  raw: unknown,
  changes: readonly ContinueChange[],
  opts: { by: 'person' | 'assistant'; at: string; from_t: number | null; from_iteration: number | null },
): ContinueEntry[] {
  const list = entriesOf(raw).map((e) => ({ ...e, changes: e.changes.map((c) => ({ ...c })) }));
  let entry = list.find((e) => !e.applied_at && (e.kind || 'settings') === 'settings') || null;
  if (!entry) {
    entry = { from_t: opts.from_t, from_iteration: opts.from_iteration, at: opts.at, by: opts.by, kind: 'settings', changes: [], applied_at: null };
    list.push(entry);
  } else if (entry.by !== opts.by) {
    entry.by = 'both';
  }
  for (const c of changes) {
    const had = entry.changes.find((x) => x.key === c.key);
    if (had) had.to = c.to;
    else entry.changes.push({ key: c.key, from: c.from, to: c.to });
  }
  entry.changes = entry.changes.filter((c) => !sameValue(c.from, c.to)).slice(0, ENTRY_CHANGES_MAX);
  entry.at = opts.at;
  let out = entry.changes.length ? list : list.filter((e) => e !== entry);
  while (out.length > CONTINUE_CHANGES_MAX) {
    const i = out.findIndex((e) => !!e.applied_at);
    if (i < 0) break;
    out = [...out.slice(0, i), ...out.slice(i + 1)];
  }
  return out;
}

/** The entries as a Continue that starts now leaves them: the waiting one applied (`at`). Null when there are none. */
export function applyContinueChanges(raw: unknown, at: string): ContinueEntry[] | null {
  const list = entriesOf(raw);
  if (!list.length) return null;
  return list.map((e) => (e.applied_at ? e : { ...e, applied_at: at }));
}

/** The words of a key: "Max Courant", "outer correctors", "pressure correctors", "Max time step". */
const CONTINUE_LABELS: Record<string, string> = {
  'transient.max_co': 'Max Courant',
  'transient.n_outer_correctors': 'outer correctors',
  'transient.n_correctors': 'pressure correctors',
  'transient.max_delta_t': 'Max time step',
};

/** The words of a solve setting that cannot wait for Continue (not_continue_settings). */
const OTHER_LABELS: Record<string, string> = {
  endTime: 'Iterations',
  writeInterval: 'Write interval',
  mesh_id: 'The mesh',
  time_dependency: 'Time dependency',
  'transient.end_time': 'Simulation time',
  'transient.write_count': 'Result frames',
  'transient.average_from': 'Average from',
  'transient.time_step_mode': 'Time step',
  'transient.delta_t': 'Initial Δt',
  'transient.time_scheme': 'Time scheme',
  'transient.n_non_orth_correctors': 'Non-orthogonal correctors',
};

function labelOf(key: string): string {
  return CONTINUE_LABELS[key] || OTHER_LABELS[key] || key.replace(/^transient\./, '').replace(/_/g, ' ');
}

const capital = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** A value as the words show it: a number with at most 6 significant digits; Max time step in s; blank "auto". */
function valueText(key: string, v: unknown): string {
  if (v === null || v === undefined || v === '') return 'auto';
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  const plain = String(Number(n.toPrecision(6)));
  return key === 'transient.max_delta_t' ? plain + ' s' : plain;
}

/** "Max Courant 100 → 5". */
export function continueChangeText(c: ContinueChange): string {
  return labelOf(c.key) + ' ' + valueText(c.key, c.from) + ' → ' + valueText(c.key, c.to);
}

/** "A", "A and B", "A, B and C". */
function andList(items: string[]): string {
  if (items.length <= 1) return items[0] || '';
  return items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1];
}

/** Where a run goes on from: "t = 0.45 s", "iteration 450". */
function fromText(rec: RunLike | null | undefined, at: number | null): string {
  const n = at === null ? 0 : at;
  return solvedTransient(rec) ? 't = ' + simTime(n) : 'iteration ' + String(Number(n.toPrecision(10)));
}

/** "Max Courant 100 → 5, outer correctors 1 → 3 (from t = 0.45 s)": an entry's changes. */
export function continueEntryText(rec: RunLike | null | undefined, e: ContinueEntry): string {
  const at = e.from_t !== null && e.from_t !== undefined ? e.from_t : e.from_iteration;
  return e.changes.map(continueChangeText).join(', ') + ' (from ' + fromText(rec, at === null || at === undefined ? savedTimeOf(rec) : Number(at)) + ')';
}

/** The Continue box's line: "Continue applies: Max Courant 100 → 5 (from t = 0.45 s)." ('' when nothing waits). */
export function continueAppliesLine(rec: RunLike | null | undefined): string {
  const e = pendingContinue(rec);
  return e && e.changes.length ? 'Continue applies: ' + continueEntryText(rec, e) + '.' : '';
}

/** The toast once a change waits for Continue: 'Max Courant 5 takes effect when "Run 1" continues.' */
export function takesEffectToast(rec: RunLike, changes: readonly ContinueChange[]): string {
  const said = changes.map((c) => labelOf(c.key) + ' ' + valueText(c.key, c.to));
  return capital(andList(said)) + (changes.length > 1 ? ' take' : ' takes') + ' effect when ' + quoted(rec) + ' continues.';
}

/**
 * A health record's sentence for a run whose saved results are from after it became unhealthy
 * (or ''). An onset in the unread middle of an old log (`approx`) is a span, as unhealthySentence
 * says it: "(between t = A and t = B)", or "(after t = A)".
 */
function fromZeroSentence(health: unknown): string {
  if (!isObj(health) || health.restart !== 'from_zero') return '';
  const first = isObj(health.first_unhealthy) ? health.first_unhealthy : null;
  const t = first && first.t !== null && first.t !== undefined && Number.isFinite(Number(first.t)) ? Number(first.t) : null;
  if (t === null) return ' Its saved results are from after it became unhealthy; continuing from them carries that on.';
  const by = first && first.by_t !== null && first.by_t !== undefined ? Number(first.by_t) : NaN;
  const when = first && first.approx ? (Number.isFinite(by) ? 'between t = ' + simTime(t) + ' and t = ' + simTime(by) : 'after t = ' + simTime(t)) : 't = ' + simTime(t);
  return ' Its saved results are from after it became unhealthy (' + when + '); continuing from them carries that on.';
}

/** "its results (12 saved, up to t = 0.45 s)". */
function resultsPhrase(rec: RunLike): string {
  const w = whatGoes(rec);
  return w.charAt(0).toLowerCase() + w.slice(1);
}

export interface ChoiceWords {
  title: string;
  copy: string;
  over: { label: string; line: string };
  cont: { label: string; line: string };
  cancel: string;
}

/**
 * The question when a stopped run's change is only of CONTINUE_KEYS (A2): Start over, Use when
 * continuing, or Cancel (the safe answer). `health`: the run's health record, when it has one.
 */
export function continueChoiceWords(rec: RunLike, changes: readonly ContinueChange[], health?: unknown): ChoiceWords {
  const name = quoted(rec);
  const from = fromText(rec, savedTimeOf(rec));
  const many = changes.length > 1;
  return {
    title: 'Change ' + name + '?',
    copy: capital(changes.map(continueChangeText).join(', ')) + '. ' + name + ' has results up to ' + from + '.',
    over: {
      label: 'Start over',
      line: 'Deletes ' + resultsPhrase(rec) + ' now. Start solves it again from ' + (solvedTransient(rec) ? 't = 0' : 'the beginning') + '.',
    },
    cont: {
      label: 'Use when continuing',
      line:
        'Keeps its results. Continue goes on from ' + from + ' with the new ' + (many ? 'values' : 'value') + ', and the run records the ' + (many ? 'changes' : 'change') + '.' +
        fromZeroSentence(health),
    },
    cancel: 'Cancel',
  };
}

/** The Assistant's refusal when it did not say how a change of a stopped run's CONTINUE_KEYS applies (choose_restart). */
export function chooseRestartWords(rec: RunLike, changes: readonly ContinueChange[]): { message: string; hint: string } {
  return {
    message:
      quoted(rec) + ' has results up to ' + fromText(rec, savedTimeOf(rec)) + '. Say how ' + andList(changes.map(continueChangeText)) + (changes.length > 1 ? ' apply.' : ' applies.'),
    hint:
      'Pass type "at_continue" to keep its results and apply it when it continues, or type "start_over" to delete its results and solve again from ' +
      (solvedTransient(rec) ? 't = 0' : 'the beginning') +
      ' (the person is asked). Ask the person which.',
  };
}

/**
 * The Assistant's card before a change waits for Continue (`at_continue`): a new change, one
 * that joins the change already waiting (the merged list), or one that empties it.
 */
export function continueCardWords(rec: RunLike, changes: readonly ContinueChange[], health?: unknown): { title: string; copy: string } {
  const name = quoted(rec);
  const title = 'Allow the Assistant to change ' + name + ' for when it continues?';
  const waiting = pendingContinue(rec);
  if (waiting) {
    const merged = mergeContinueChanges(rec.continue_changes, changes, { by: 'assistant', at: '', from_t: null, from_iteration: null });
    const after = merged.find((e) => !e.applied_at && e.kind === 'settings') || null;
    if (!after) {
      const back = changes.map((c) => {
        const had = waiting.changes.find((x) => x.key === c.key);
        return labelOf(c.key) + ' back to ' + valueText(c.key, had ? had.from : c.to);
      });
      return { title, copy: 'Sets ' + andList(back) + ': nothing is left waiting for ' + name + ' to continue.' };
    }
    return {
      title,
      copy: 'Joins the change already waiting for ' + name + ' to continue. Continue then applies: ' + continueEntryText(rec, after) + '. Its results are kept.' + fromZeroSentence(health),
    };
  }
  return {
    title,
    copy:
      capital(andList(changes.map(continueChangeText))) + (changes.length > 1 ? ' take' : ' takes') + ' effect when ' + name + ' continues from ' + fromText(rec, savedTimeOf(rec)) +
      '. Its results are kept.' + fromZeroSentence(health),
  };
}

/** The Assistant's answer once a change waits for Continue (or nothing is left waiting). */
export function continueDoneWords(rec: RunLike): string {
  const line = continueAppliesLine(rec);
  return line ? 'Saved for when ' + quoted(rec) + ' continues. ' + line + ' Its results are kept.' : 'Nothing is left waiting for ' + quoted(rec) + ' to continue.';
}

/**
 * Why a change cannot wait for Continue (not_continue_settings). `changed`: the keys it changes;
 * `studyTransient`: the run's study's mode now, when known.
 */
export function notContinueWords(rec: RunLike, changed: readonly string[], studyTransient?: boolean | null): string {
  const other = changed.find((k) => !CONTINUE_KEYS.includes(k));
  if (other) {
    return 'Only Max Courant, the outer and pressure correctors and Max time step can wait for Continue. ' + labelOf(other) + ' needs Start over or a new run.';
  }
  const st = statusOf(rec);
  if (st === 'failed') return 'A failed run does not continue (Continue is offered only for stopped and finished runs): a change of its settings starts it over.';
  if (st === 'done' || st === 'finished') return finishedRefusal(rec);
  if (st === 'stopped') {
    if (savedTimeOf(rec) === null) return quoted(rec) + ' has no saved time to continue from: a change of its settings starts it over.';
    if (!solvedTransient(rec)) {
      return quoted(rec) + ' solved Steady-state: its Continue goes on in iterations and never uses Max Courant, the correctors or Max time step. A change of them starts it over.';
    }
    if (studyTransient === false) {
      return quoted(rec) + ' solved Transient; its study is now Steady-state: a change of its settings starts it over as a Steady-state run.';
    }
    if (!changed.length) return 'This changes none of Max Courant, the correctors or Max time step of ' + quoted(rec) + ': nothing new waits for its Continue.';
  }
  return 'Only a stopped run with a saved time can take a change for when it continues.';
}

// ---------------------------------------------------------------- RH3: numerics at Continue

/**
 * What a run started with (RH3, spec 5.3): `values` holds its study's stored value of every
 * numerics setting of the run's analysis and mode at its Start (raw; null when blank, which is
 * the preset's). The server writes it at every fresh Start and at a Continue that takes the
 * study's new numerics; nothing else changes it.
 */
export interface NumericsUsed {
  analysis: string;
  mode: 'steady' | 'transient';
  at: string;
  values: Record<string, unknown>;
}

/** A numerics setting whose study value differs from what the run started with. */
export interface NumericsDifference {
  key: string;
  /** The setting's label (its schema title). */
  label: string;
  /** What the run started with (null: blank, the preset's). */
  from: unknown;
  /** The study's value now (null: blank). */
  to: unknown;
  /** "Relaxation p 0.3 → 0.2": the words every text of it uses. */
  text: string;
}

/** The answers to the Continue question once the study's numerics differ (the route's and the Assistant's `numerics`). */
export const NUMERICS_ANSWERS: readonly string[] = Object.freeze(['new', 'as_was']);

/** The run's record of what it started with, or null (a run started before RH3, or a draft). */
export function numericsUsedOf(rec: RunLike | null | undefined): NumericsUsed | null {
  const used = rec && isObj(rec.numerics_used) ? rec.numerics_used : null;
  return used && isObj(used.values) ? (used as unknown as NumericsUsed) : null;
}

/** A numerics schema's fields by key ({} for none). */
function numericsFields(schema: unknown): Record<string, Record<string, unknown>> {
  const props = isObj(schema) && isObj(schema.properties) ? schema.properties : {};
  const out: Record<string, Record<string, unknown>> = {};
  for (const [k, v] of Object.entries(props)) if (isObj(v)) out[k] = v;
  return out;
}

const blankValue = (v: unknown) => v === null || v === undefined || v === '';

/**
 * The record a Start writes (`numerics_used`): every numerics field of the run's analysis and
 * mode (its numerics_schema), at the study's stored value, raw, blanks as null.
 */
export function numericsSnapshot(analysis: string, transient: boolean, study: unknown, schema: unknown, at: string): NumericsUsed {
  const s = isObj(study) ? study : {};
  const values: Record<string, unknown> = {};
  for (const key of Object.keys(numericsFields(schema))) values[key] = blankValue(s[key]) ? null : s[key];
  return { analysis: String(analysis || ''), mode: transient ? 'transient' : 'steady', at, values };
}

/**
 * The values a Continue "as it was" goes on with: what the run started with, and blank (the
 * preset's) for a field of its analysis the record does not hold.
 */
export function numericsAsWas(used: NumericsUsed, schema: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(numericsFields(schema))) out[key] = null;
  for (const [k, v] of Object.entries(used.values)) out[k] = blankValue(v) ? null : v;
  return out;
}

/** A value as the differences say it: blank "preset", a choice by its label, on/off, a number (tolerances as 1e-7). */
function numericsValueText(field: Record<string, unknown> | undefined, v: unknown): string {
  if (blankValue(v)) return 'preset';
  if (typeof v === 'boolean') return v ? 'on' : 'off';
  const x = field && isObj(field['x-cfddesk']) ? field['x-cfddesk'] : null;
  const choices = field && Array.isArray(field.enum) ? field.enum : null;
  const labels = x && Array.isArray(x.enum_labels) ? x.enum_labels : null;
  if (choices && labels) {
    const i = choices.indexOf(v);
    if (i >= 0 && typeof labels[i] === 'string') return String(labels[i]);
  }
  if (typeof v === 'number' && Number.isFinite(v)) {
    const a = Math.abs(v);
    return a !== 0 && a < 1e-3 ? v.toExponential().replace('e+', 'e') : String(Number(v.toPrecision(6)));
  }
  return String(v);
}

/**
 * The one list of what differs between the numerics a run started with (`run.numerics_used`) and
 * its study's stored values now, in the schema's order: the page's Continue box and question,
 * the route's refusal and the Assistant's refusal and card all say it from here. [] for a run
 * with no record (started before RH3: Continue uses the study's values, as before) or no study.
 */
export function numericsDiff(run: RunLike | null | undefined, study: unknown, schema: unknown): NumericsDifference[] {
  const used = numericsUsedOf(run);
  if (!used || !isObj(study)) return [];
  const fields = numericsFields(schema);
  const keys = Object.keys(fields).length ? Object.keys(fields) : Object.keys(used.values);
  const out: NumericsDifference[] = [];
  for (const key of keys) {
    const from = blankValue(used.values[key]) ? null : used.values[key];
    const to = blankValue(study[key]) ? null : study[key];
    if (sameValue(from, to)) continue;
    const field = fields[key];
    const label = field && typeof field.title === 'string' && field.title ? field.title : key.replace(/_/g, ' ');
    out.push({ key, label, from, to, text: label + ' ' + numericsValueText(field, from) + ' → ' + numericsValueText(field, to) });
  }
  return out;
}

/** "Relaxation p 0.3 → 0.2, Relaxation U 0.7 → 0.5". */
export function numericsDiffText(diffs: readonly NumericsDifference[]): string {
  return diffs.map((d) => d.text).join(', ');
}

/** 'The study's numerics changed after "Run_2" started: Relaxation p 0.3 → 0.2.' (the Continue box's line, the question's text, the route's refusal). */
export function numericsChangedText(rec: RunLike, diffs: readonly NumericsDifference[]): string {
  return "The study's numerics changed after " + quoted(rec) + ' started: ' + numericsDiffText(diffs) + '.';
}

export interface ContinueNumericsWords {
  title: string;
  /** The run's health first (its saved results come after it became unhealthy), else ''. */
  health: string;
  copy: string;
  fresh: { label: string; line: string };
  asWas: { label: string; line: string };
  cancel: string;
}

/**
 * The person's Continue question once the study's numerics differ from what the run started
 * with: "Continue with the new numerics", "Continue as it was" or Cancel. `health`: the copy of
 * the Continue question of a run whose saved results come after it became unhealthy (from_zero),
 * shown first: one question, never two.
 */
export function continueNumericsWords(rec: RunLike, diffs: readonly NumericsDifference[], health?: string): ContinueNumericsWords {
  return {
    title: 'Continue ' + quoted(rec) + '?',
    health: health || '',
    copy: numericsChangedText(rec, diffs),
    fresh: {
      label: 'Continue with the new numerics',
      line: 'Goes on from ' + fromText(rec, savedTimeOf(rec)) + " with the study's numerics now. The run records the change.",
    },
    asWas: { label: 'Continue as it was', line: 'Goes on with the numerics it started with. The study keeps the new values for new runs.' },
    cancel: 'Cancel',
  };
}

/** The Assistant's refusal of a run_continue that did not say which numerics (choose_numerics). */
export function chooseNumericsWords(rec: RunLike, diffs: readonly NumericsDifference[]): { message: string; hint: string } {
  return {
    message: "The study's numerics changed after " + quoted(rec) + ' started (' + numericsDiffText(diffs) + ').',
    hint: 'Pass numerics "as_was" to continue with the numerics it started with, or "new" to use the study\'s numerics now. Ask the person which.',
  };
}

/** The sentence the Assistant's run_continue card adds for its answer. */
export function numericsCardSentence(rec: RunLike, diffs: readonly NumericsDifference[], answer: string): string {
  return answer === 'new'
    ? 'Continues ' + quoted(rec) + " with the study's new numerics (" + numericsDiffText(diffs) + ').'
    : 'Continues ' + quoted(rec) + " with the numerics it started with; the study's newer values (" + numericsDiffText(diffs) + ') are not used.';
}

/**
 * The run's `continue_changes` with the entry of a Continue that took the study's new numerics:
 * written applied (`at`), from where it goes on, by whom, with its differences (at most 8; `more`
 * counts the rest). At most CONTINUE_CHANGES_MAX entries are kept: the oldest applied ones go first.
 */
export function withNumericsEntry(
  raw: unknown,
  diffs: readonly NumericsDifference[],
  opts: { by: 'person' | 'assistant'; at: string; from_t: number | null; from_iteration: number | null },
): ContinueEntry[] {
  const entry: ContinueEntry = {
    from_t: opts.from_t,
    from_iteration: opts.from_iteration,
    at: opts.at,
    by: opts.by,
    kind: 'numerics',
    changes: diffs.slice(0, ENTRY_CHANGES_MAX).map((d) => ({ key: d.key, label: d.label, from: d.from, to: d.to, text: d.text })),
    applied_at: opts.at,
    ...(diffs.length > ENTRY_CHANGES_MAX ? { more: diffs.length - ENTRY_CHANGES_MAX } : {}),
  };
  let out = [...entriesOf(raw), entry];
  while (out.length > CONTINUE_CHANGES_MAX) {
    const i = out.findIndex((e) => !!e.applied_at);
    if (i < 0) break;
    out = [...out.slice(0, i), ...out.slice(i + 1)];
  }
  return out;
}
