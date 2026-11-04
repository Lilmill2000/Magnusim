import { describe, expect, it } from 'vitest';
import {
  applyContinueChanges,
  chooseNumericsWords,
  continueNumericsWords,
  numericsAsWas,
  numericsCardSentence,
  numericsChangedText,
  numericsDiff,
  numericsSnapshot,
  numericsUsedOf,
  withNumericsEntry,
  chooseRestartWords,
  CONTINUE_KEYS,
  continueAppliesLine,
  continueCardWords,
  continueChangesOf,
  continueChoiceWords,
  continueDoneWords,
  continuePendingKeys,
  continueTransient,
  endedRunReason,
  mergeContinueChanges,
  notContinueWords,
  onlyContinueKeys,
  overwritesResults,
  pendingContinue,
  savedTimeOf,
  takesEffectToast,
  finishedRefusal,
  hasOverwritable,
  keepAutoBlank,
  newRunToast,
  newRunWords,
  noSavedTimeText,
  overwriteWords,
  overwrittenToast,
  runEditState,
  runSettingsWord,
  solveChanged,
  STOPPING_REASON,
  unhealthySentence,
  unresolveTransient,
  valuesBeforeContinue,
} from './runReopen';

// A run that ended and a change of its settings (Daniel, 2026-11-03): stopped and failed runs
// are started over once asked, finished runs are never overwritten (a change makes a new run).
const stopped = {
  id: 'r1',
  name: 'Run 1',
  status: 'stopped',
  time_dependency: 'Steady-state',
  endTime: 500,
  writeInterval: 50,
  mesh_id: 'm1',
  has_results: true,
  n_saved_times: 12,
  last_saved_iteration: 450,
  iteration: 460,
  n_steps: 460,
};

describe('runEditState', () => {
  it('says what a change of the solve settings does, by status', () => {
    expect(runEditState(null)).toBe('draft');
    expect(runEditState({ status: 'draft' })).toBe('draft');
    expect(runEditState({})).toBe('draft');
    // A stopped Transient run with a saved time: Continue can go on from it (A2), unless its study
    // is now Steady-state (it starts over as one: the two-way question).
    const tr = { ...stopped, time_dependency: 'Transient' };
    expect(runEditState(tr)).toBe('continues');
    expect(runEditState(tr, { studyTransient: true })).toBe('continues');
    expect(runEditState(tr, { studyTransient: false })).toBe('overwrites');
    // A steady run's Continue never uses Max Courant, the correctors or Max time step: a plain start-over.
    expect(runEditState(stopped)).toBe('overwrites');
    expect(runEditState(stopped, { studyTransient: true })).toBe('overwrites');
    expect(runEditState({ ...stopped, status: 'failed' })).toBe('overwrites');
    // Its case folder has no saved time (the read says so): no Continue, a plain start-over.
    expect(runEditState({ ...stopped, continue_from: null })).toBe('overwrites');
    expect(runEditState({ ...stopped, last_saved_iteration: 0, n_steps: 40, continue_from: undefined })).toBe('overwrites');
    // Stopped before anything was written: quietly a draft again.
    expect(runEditState({ status: 'stopped', iteration: 0 })).toBe('free');
    expect(runEditState({ status: 'failed', has_results: false, n_saved_times: 0 })).toBe('free');
    expect(runEditState({ ...stopped, status: 'done' })).toBe('new_run');
    expect(runEditState({ status: 'running' })).toBe('locked');
    expect(runEditState({ status: 'starting' })).toBe('locked');
  });

  it('read_setup words: editable, overwrites, continues, new_run, locked', () => {
    expect(runSettingsWord('draft')).toBe('editable');
    expect(runSettingsWord('free')).toBe('editable');
    expect(runSettingsWord('overwrites')).toBe('overwrites');
    expect(runSettingsWord('continues')).toBe('continues');
    expect([overwritesResults('overwrites'), overwritesResults('continues'), overwritesResults('free'), overwritesResults('new_run')]).toEqual([true, true, false, false]);
    expect(runSettingsWord('new_run')).toBe('new_run');
    expect(runSettingsWord('locked')).toBe('locked');
  });

  it('something to overwrite: saved results, a saved iteration or solver steps', () => {
    expect(hasOverwritable({ n_saved_times: 1 })).toBe(true);
    expect(hasOverwritable({ last_saved_iteration: 50 })).toBe(true);
    expect(hasOverwritable({ n_steps: 40 })).toBe(true);
    expect(hasOverwritable({ has_results: true })).toBe(true);
    expect(hasOverwritable({ iteration: 0, n_saved_times: 0 })).toBe(false);
  });
});

describe('solveChanged', () => {
  it('names the solve settings a save changes; free settings and equal numbers are no change', () => {
    expect(solveChanged(stopped, { endTime: 500, writeInterval: 50 })).toEqual([]);
    expect(solveChanged(stopped, { endTime: 500.0000000001 })).toEqual([]);
    expect(solveChanged(stopped, { endTime: 200, writeInterval: 50 })).toEqual(['endTime']);
    expect(solveChanged(stopped, { mesh_id: 'm2' })).toEqual(['mesh_id']);
    expect(solveChanged(stopped, { time_dependency: 'Transient' })).toEqual(['time_dependency']);
    expect(solveChanged(stopped, { time_dependency: 'Steady-state' })).toEqual([]);
    expect(solveChanged(stopped, { cores: 4, settle: null, name: 'x', result_controls: [], views: [] })).toEqual([]);
  });

  it('a transient block: key by key, its bookkeeping ignored', () => {
    const rec = { ...stopped, time_dependency: 'Transient', transient: { end_time: 1, write_count: 20, delta_t: 0.001, source: { delta_t: 'auto' } } };
    expect(solveChanged(rec, { transient: { end_time: 1, write_count: 20, delta_t: 0.001, source: {}, estimate: { x: 1 } } })).toEqual([]);
    expect(solveChanged(rec, { transient: { end_time: 2, write_count: 20 } })).toEqual(['transient.end_time']);
    // A key the stored block lacks: a change only when the save gives it a value.
    expect(solveChanged(rec, { transient: { max_delta_t: null } })).toEqual([]);
    expect(solveChanged(rec, { transient: { max_delta_t: 0.01 } })).toEqual(['transient.max_delta_t']);
  });

  it("RH3's run keys (outer relaxation, outer tolerance) are solve settings, not Continue's: a stopped run gets the two-way question", () => {
    const rec = { ...stopped, time_dependency: 'Transient', transient: { end_time: 1, write_count: 20, n_outer_correctors: 3 } };
    // A run saved before RH3 has none of them; a save that leaves them blank changes nothing.
    expect(solveChanged(rec, { transient: { end_time: 1, outer_relax_p: null, outer_relax_eq: null, outer_tolerance: null } })).toEqual([]);
    const changed = solveChanged(rec, { transient: { outer_relax_p: 0.4, outer_tolerance: 0.001 } });
    expect(changed).toEqual(['transient.outer_relax_p', 'transient.outer_tolerance']);
    expect(changed.some((k) => CONTINUE_KEYS.includes(k))).toBe(false);
    expect(onlyContinueKeys(changed)).toBe(false);
    expect(onlyContinueKeys([...changed, 'transient.max_co'])).toBe(false);
  });
});

describe('transient values worked out at Start', () => {
  const solved = { end_time: 1, write_count: 20, delta_t: 0.0004, max_delta_t: 0.05, max_co: 1, source: { delta_t: 'auto', max_delta_t: 'user' }, estimate: { cells: 10 } };

  it('a run started over gets them blank again; typed values stay', () => {
    expect(unresolveTransient(solved)).toEqual({ end_time: 1, write_count: 20, delta_t: null, max_delta_t: 0.05, max_co: 1 });
    expect(unresolveTransient(null)).toBeNull();
  });

  it('an edit that carries a worked-out value unchanged keeps it blank; a typed one stays', () => {
    expect(keepAutoBlank(solved, { end_time: 2, delta_t: 0.0004, max_delta_t: 0.05, source: { delta_t: 'auto' } })).toEqual({ end_time: 2, delta_t: null, max_delta_t: 0.05 });
    expect(keepAutoBlank(solved, { end_time: 2, delta_t: 0.002 })).toEqual({ end_time: 2, delta_t: 0.002 });
  });
});

describe('the words', () => {
  it('a change on a stopped run: Overwrite "Run 1"?, with Continue as the way to keep them', () => {
    expect(overwriteWords(stopped, { action: 'edit', studyTransient: false })).toEqual({
      title: 'Overwrite "Run 1"?',
      copy:
        'Changing this setting starts "Run 1" over. Its results (12 saved, up to iteration 450) are deleted now, and Start solves it again from the beginning. To keep them, cancel and add a run, or use Continue to go on from iteration 450.',
      yes: 'Overwrite',
    });
  });

  it('transient, nothing saved yet, failed, and a study now in the other mode', () => {
    const tr = { ...stopped, time_dependency: 'Transient', last_saved_iteration: 0.45, sim_time: 0.47 };
    expect(overwriteWords(tr, { action: 'edit', studyTransient: true }).copy).toContain('Its results (12 saved, up to t = 0.45 s) are deleted now');
    const nothing = { ...stopped, has_results: false, n_saved_times: 0, last_saved_iteration: 0, iteration: 40, n_steps: 40 };
    expect(overwriteWords(nothing, { action: 'edit', studyTransient: false }).copy).toBe(
      'Changing this setting starts "Run 1" over. Its residuals and monitor data up to iteration 40 are deleted now, and Start solves it again from the beginning. To keep them, cancel and add a run.',
    );
    expect(overwriteWords({ ...stopped, status: 'failed' }, { action: 'edit', studyTransient: false }).copy).toMatch(/To keep them, cancel and add a run\.$/);
    expect(overwriteWords(stopped, { action: 'edit', studyTransient: true }).copy).toMatch(/ It becomes a Transient run, as its study is now\.$/);
  });

  it('Start on a stopped run: Start "Run 1" over?', () => {
    expect(overwriteWords(stopped, { action: 'start', studyTransient: true })).toEqual({
      title: 'Start "Run 1" over?',
      copy:
        'Its results (12 saved, up to iteration 450) are deleted, and it solves again from the beginning. To keep them, cancel and use Continue to go on from iteration 450, or add a run. It solves Transient, as its study is now.',
      yes: 'Overwrite and start',
    });
  });

  it("the Assistant's cards", () => {
    expect(overwriteWords(stopped, { action: 'edit', assistant: true }).title).toBe('Allow the Assistant to overwrite "Run 1"?');
    expect(overwriteWords(stopped, { action: 'start', assistant: true }).title).toBe('Allow the Assistant to start "Run 1" over?');
  });

  it('a finished run: a new run takes the change', () => {
    const done = { ...stopped, status: 'done' };
    expect(newRunWords(done)).toEqual({
      title: '"Run 1" has finished',
      copy: 'Its results stay as they are. Make a new run with the same settings and this change?',
      yes: 'Make new run',
    });
    expect(newRunToast({ name: 'Run 3' }, done)).toBe('Made "Run 3" with the settings of "Run 1" and your change. "Run 1" keeps its results.');
    expect(finishedRefusal(done)).toBe('"Run 1" has finished and its results stay as they are: a change of its settings goes to a new run with the same settings.');
    expect(overwrittenToast(stopped)).toBe('"Run 1" starts over: its old results were deleted.');
    expect(overwrittenToast(stopped, { droppedContinue: true })).toBe(
      '"Run 1" starts over: its old results were deleted. Its queued Continue was removed from the queue.',
    );
    expect(overwrittenToast(stopped, { deleted: false, droppedContinue: true })).toBe('"Run 1" starts over. Its queued Continue was removed from the queue.');
  });
});

describe('the Run panel reason lines', () => {
  it('a finished run says a change makes a new run', () => {
    expect(endedRunReason({ status: 'done', time_dependency: 'Steady-state' }, false)).toBe(
      'This run finished. Changing a setting makes a new run with the same settings and that change.',
    );
    expect(endedRunReason({ status: 'done', time_dependency: 'Transient' }, false)).toBe(
      "This run solved Transient; its study is now Steady-state. Changing a setting makes a new Steady-state run with this run's settings.",
    );
  });

  it('a stopped run whose study changed mode says Start or a change solves the new mode here', () => {
    expect(endedRunReason({ ...stopped, time_dependency: 'Transient' }, false)).toBe(
      'This run solved Transient; its study is now Steady-state. Start or a settings change solves Steady-state in this run and overwrites its results. Add a run to keep them.',
    );
    expect(endedRunReason({ status: 'stopped', time_dependency: 'Steady-state' }, true)).toBe(
      'This run solved Steady-state; its study is now Transient. Start or a settings change solves Transient in this run.',
    );
    expect(endedRunReason(stopped, false)).toBeNull();
    expect(endedRunReason({ status: 'draft' }, true)).toBeNull();
  });

  it('stopping, and Continue with nothing saved', () => {
    expect(STOPPING_REASON).toBe("Stopping. You can change this run's settings once it has stopped.");
    expect(noSavedTimeText('stopped')).toBe("This run can't continue: its case folder has no saved result. Start solves it again from the beginning.");
    expect(noSavedTimeText('done')).toBe("This run can't continue: its case folder has no saved result. Add a run to solve again.");
  });
});

// A2 (Daniel, 2026-11-03): a stopped run's Max Courant, outer and pressure correctors and Max
// time step can wait for Continue instead of starting it over; the run records the change.
describe('A2: a change for when a stopped run continues', () => {
  const tr = {
    ...stopped,
    time_dependency: 'Transient',
    last_saved_iteration: 0.45,
    sim_time: 0.47,
    transient: { end_time: 1, write_count: 20, max_co: 100, n_outer_correctors: 1, n_correctors: 2, max_delta_t: 0.05 },
  };

  it('the four keys, and where Continue goes on from', () => {
    expect(CONTINUE_KEYS).toEqual(['transient.max_co', 'transient.n_outer_correctors', 'transient.n_correctors', 'transient.max_delta_t']);
    expect(onlyContinueKeys(['transient.max_co', 'transient.n_correctors'])).toBe(true);
    expect(onlyContinueKeys(['transient.max_co', 'transient.end_time'])).toBe(false);
    expect(onlyContinueKeys(['endTime'])).toBe(false);
    expect(onlyContinueKeys([])).toBe(false);
    expect(savedTimeOf(tr)).toBe(0.45);
    expect(savedTimeOf({ ...tr, continue_from: 0.4 })).toBe(0.4);
    expect(savedTimeOf({ ...tr, continue_from: null })).toBeNull();
    expect(savedTimeOf({ status: 'stopped' })).toBeNull();
    expect(continueChangesOf(tr, { transient: { ...tr.transient, max_co: 5 } }, ['transient.max_co'])).toEqual([{ key: 'transient.max_co', from: 100, to: 5 }]);
  });

  it("the dialog's words: Start over, Use when continuing, Cancel", () => {
    const w = continueChoiceWords(tr, [{ key: 'transient.max_co', from: 100, to: 5 }]);
    expect(w).toEqual({
      title: 'Change "Run 1"?',
      copy: 'Max Courant 100 → 5. "Run 1" has results up to t = 0.45 s.',
      over: { label: 'Start over', line: 'Deletes its results (12 saved, up to t = 0.45 s) now. Start solves it again from t = 0.' },
      cont: { label: 'Use when continuing', line: 'Keeps its results. Continue goes on from t = 0.45 s with the new value, and the run records the change.' },
      cancel: 'Cancel',
    });
    const two = continueChoiceWords(tr, [
      { key: 'transient.n_outer_correctors', from: 1, to: 3 },
      { key: 'transient.max_delta_t', from: 0.05, to: null },
    ]);
    expect(two.copy).toBe('Outer correctors 1 → 3, Max time step 0.05 s → auto. "Run 1" has results up to t = 0.45 s.');
    expect(two.cont.line).toBe('Keeps its results. Continue goes on from t = 0.45 s with the new values, and the run records the changes.');
    // Health says its saved results are from after it became unhealthy.
    const sick = continueChoiceWords(tr, [{ key: 'transient.max_co', from: 100, to: 5 }], { restart: 'from_zero', first_unhealthy: { t: 0.0069061069, step: 25 } });
    expect(sick.cont.line).toMatch(/ Its saved results are from after it became unhealthy \(t = 0\.0069 s\); continuing from them carries that on\.$/);
    expect(continueChoiceWords(tr, [{ key: 'transient.max_co', from: 100, to: 5 }], { restart: 'continue_after_fix' }).cont.line).not.toMatch(/unhealthy/);
  });

  it('an onset in the unread middle of an old log is a span in the question and the card, as every health text says it (S6)', () => {
    const ch = [{ key: 'transient.max_co', from: 100, to: 5 }];
    const span = { restart: 'from_zero', first_unhealthy: { t: 0.0031, approx: true, by_t: 0.0069061069 } };
    expect(continueChoiceWords(tr, ch, span).cont.line).toMatch(
      / Its saved results are from after it became unhealthy \(between t = 0\.0031 s and t = 0\.0069 s\); continuing from them carries that on\.$/,
    );
    expect(continueCardWords(tr, ch, span).copy).toMatch(/became unhealthy \(between t = 0\.0031 s and t = 0\.0069 s\);/);
    const after = { restart: 'from_zero', first_unhealthy: { t: 0.0031, approx: true } };
    expect(continueChoiceWords(tr, ch, after).cont.line).toMatch(/became unhealthy \(after t = 0\.0031 s\);/);
    for (const h of [span, after]) expect(continueChoiceWords(tr, ch, h).cont.line).not.toMatch(/\(t = 0\.0031 s\)/);
  });

  it("a fix's new run takes the values the run solved with, not the ones waiting for its Continue (S3)", () => {
    const solved = { ...tr, transient: { ...tr.transient, write_interval: 0.05, max_co: 5, n_outer_correctors: 3, max_delta_t: 0.01 } };
    const waiting = mergeContinueChanges(
      [],
      [
        { key: 'transient.max_co', from: 100, to: 5 },
        { key: 'transient.n_outer_correctors', from: 1, to: 3 },
        { key: 'transient.max_delta_t', from: 0.05, to: 0.01 },
      ],
      { by: 'person', at: 'a', from_t: 0.45, from_iteration: null },
    );
    // A Max time step equal to the write interval is what a blank one worked out: blank again.
    expect(valuesBeforeContinue({ ...solved, continue_changes: waiting })).toEqual([
      { key: 'transient.max_co', value: 100 },
      { key: 'transient.n_outer_correctors', value: 1 },
      { key: 'transient.max_delta_t', value: null },
    ]);
    // One the person typed below it stays.
    const typed = mergeContinueChanges([], [{ key: 'transient.max_delta_t', from: 0.02, to: 0.01 }], { by: 'person', at: 'a', from_t: 0.45, from_iteration: null });
    expect(valuesBeforeContinue({ ...solved, continue_changes: typed })).toEqual([{ key: 'transient.max_delta_t', value: 0.02 }]);
    // Nothing waits (none, or only applied ones): nothing to set.
    expect(valuesBeforeContinue(solved)).toEqual([]);
    expect(valuesBeforeContinue({ ...solved, continue_changes: applyContinueChanges(waiting, 'b') })).toEqual([]);
  });

  it('the merge rule: joins the waiting entry, a key set back leaves it, an emptied entry goes, by becomes both', () => {
    const at = '2026-11-03T10:00:00.000Z';
    let list = mergeContinueChanges(undefined, [{ key: 'transient.max_co', from: 100, to: 5 }], { by: 'person', at, from_t: 0.45, from_iteration: null });
    expect(list).toEqual([{ from_t: 0.45, from_iteration: null, at, by: 'person', kind: 'settings', changes: [{ key: 'transient.max_co', from: 100, to: 5 }], applied_at: null }]);
    // The Assistant joins: a new key with its stored value as from; a key it has keeps its from.
    list = mergeContinueChanges(list, [{ key: 'transient.n_outer_correctors', from: 1, to: 3 }, { key: 'transient.max_co', from: 5, to: 3 }], { by: 'assistant', at: 'later', from_t: 0.5, from_iteration: null });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ by: 'both', at: 'later', from_t: 0.45 });
    expect(list[0].changes).toEqual([
      { key: 'transient.max_co', from: 100, to: 3 },
      { key: 'transient.n_outer_correctors', from: 1, to: 3 },
    ]);
    expect(pendingContinue({ continue_changes: list })).toBe(list[0]);
    expect(continuePendingKeys({ continue_changes: list })).toEqual(['transient.max_co', 'transient.n_outer_correctors']);
    // Set back: the key leaves; the last one gone takes the entry with it.
    list = mergeContinueChanges(list, [{ key: 'transient.max_co', from: 3, to: 100 }], { by: 'both' as never, at: 'x', from_t: null, from_iteration: null });
    expect(list[0].changes).toEqual([{ key: 'transient.n_outer_correctors', from: 1, to: 3 }]);
    list = mergeContinueChanges(list, [{ key: 'transient.n_outer_correctors', from: 3, to: 1 }], { by: 'person', at: 'y', from_t: null, from_iteration: null });
    expect(list).toEqual([]);
    expect(continuePendingKeys({ continue_changes: list })).toEqual([]);
  });

  it('a Continue applies the waiting entry; a new change after it starts a new entry; at most 20 are kept', () => {
    const one = mergeContinueChanges([], [{ key: 'transient.max_co', from: 100, to: 5 }], { by: 'person', at: 'a', from_t: 0.45, from_iteration: null });
    const applied = applyContinueChanges(one, 'b') || [];
    expect(applied[0].applied_at).toBe('b');
    expect(pendingContinue({ continue_changes: applied })).toBeNull();
    expect(applyContinueChanges(undefined, 'b')).toBeNull();
    const next = mergeContinueChanges(applied, [{ key: 'transient.max_co', from: 5, to: 2 }], { by: 'assistant', at: 'c', from_t: 0.9, from_iteration: null });
    expect(next.map((e) => [e.by, e.applied_at, e.from_t])).toEqual([
      ['person', 'b', 0.45],
      ['assistant', null, 0.9],
    ]);
    let many: ReturnType<typeof mergeContinueChanges> = [];
    for (let i = 0; i < 25; i++) {
      many = mergeContinueChanges(many, [{ key: 'transient.max_co', from: i, to: i + 1 }], { by: 'person', at: String(i), from_t: i, from_iteration: null });
      many = applyContinueChanges(many, 'done ' + i) || [];
    }
    expect(many).toHaveLength(20);
    expect(many[0].from_t).toBe(5);
  });

  it("the Continue box's line, the toast, and read words", () => {
    const list = mergeContinueChanges([], [{ key: 'transient.max_co', from: 100, to: 5 }, { key: 'transient.n_outer_correctors', from: 1, to: 3 }], { by: 'person', at: 'a', from_t: 0.05, from_iteration: null });
    expect(continueAppliesLine({ ...tr, continue_changes: list })).toBe('Continue applies: Max Courant 100 → 5, outer correctors 1 → 3 (from t = 0.05 s).');
    expect(continueAppliesLine(tr)).toBe('');
    expect(takesEffectToast(tr, [{ key: 'transient.max_co', from: 100, to: 5 }])).toBe('Max Courant 5 takes effect when "Run 1" continues.');
    expect(takesEffectToast(tr, [{ key: 'transient.n_outer_correctors', from: 1, to: 3 }, { key: 'transient.max_co', from: 100, to: 5 }])).toBe(
      'Outer correctors 3 and Max Courant 5 take effect when "Run 1" continues.',
    );
  });

  it("the Assistant's refusal, cards and answer", () => {
    const run2 = { ...tr, name: 'Run_2', last_saved_iteration: 0.1667 };
    const ch = [{ key: 'transient.max_co', from: 100, to: 5 }];
    expect(chooseRestartWords(run2, ch)).toEqual({
      message: '"Run_2" has results up to t = 0.1667 s. Say how Max Courant 100 → 5 applies.',
      hint: 'Pass type "at_continue" to keep its results and apply it when it continues, or type "start_over" to delete its results and solve again from t = 0 (the person is asked). Ask the person which.',
    });
    expect(continueCardWords(run2, ch)).toEqual({
      title: 'Allow the Assistant to change "Run_2" for when it continues?',
      copy: 'Max Courant 100 → 5 takes effect when "Run_2" continues from t = 0.1667 s. Its results are kept.',
    });
    // Joining the change already waiting: the merged list.
    const waiting = { ...run2, continue_changes: mergeContinueChanges([], [{ key: 'transient.max_co', from: 100, to: 5 }], { by: 'person', at: 'a', from_t: 0.1667, from_iteration: null }) };
    expect(continueCardWords(waiting, [{ key: 'transient.max_co', from: 5, to: 3 }, { key: 'transient.n_outer_correctors', from: 1, to: 3 }]).copy).toBe(
      'Joins the change already waiting for "Run_2" to continue. Continue then applies: Max Courant 100 → 3, outer correctors 1 → 3 (from t = 0.1667 s). Its results are kept.',
    );
    expect(continueCardWords(waiting, [{ key: 'transient.max_co', from: 5, to: 100 }]).copy).toBe('Sets Max Courant back to 100: nothing is left waiting for "Run_2" to continue.');
    expect(continueDoneWords(waiting)).toBe('Saved for when "Run_2" continues. Continue applies: Max Courant 100 → 5 (from t = 0.1667 s). Its results are kept.');
    expect(continueDoneWords(run2)).toBe('Nothing is left waiting for "Run_2" to continue.');
    // Never "safe", "fixed" or "enough": only what it does.
    for (const t of [continueCardWords(run2, ch).copy, continueChoiceWords(run2, ch).cont.line, continueDoneWords(waiting)]) expect(t).not.toMatch(/\b(safe|fixed|fixes|enough|healthy)\b/i);
  });

  it('why a change cannot wait for Continue', () => {
    expect(notContinueWords(tr, ['transient.max_co', 'endTime'])).toBe(
      'Only Max Courant, the outer and pressure correctors and Max time step can wait for Continue. Iterations needs Start over or a new run.',
    );
    expect(notContinueWords(tr, ['transient.end_time'])).toMatch(/ Simulation time needs Start over or a new run\.$/);
    expect(notContinueWords({ ...tr, status: 'failed' }, ['transient.max_co'])).toMatch(/^A failed run does not continue/);
    expect(notContinueWords({ ...tr, continue_from: null }, ['transient.max_co'])).toBe('"Run 1" has no saved time to continue from: a change of its settings starts it over.');
    // A saved time, but a steady run, or a study now Steady-state: said as it is, never "no saved time".
    expect(notContinueWords({ ...tr, time_dependency: 'Steady-state' }, ['transient.max_co'])).toBe(
      '"Run 1" solved Steady-state: its Continue goes on in iterations and never uses Max Courant, the correctors or Max time step. A change of them starts it over.',
    );
    expect(notContinueWords(tr, ['transient.max_co'], false)).toBe('"Run 1" solved Transient; its study is now Steady-state: a change of its settings starts it over as a Steady-state run.');
    expect(notContinueWords(tr, [], true)).toBe('This changes none of Max Courant, the correctors or Max time step of "Run 1": nothing new waits for its Continue.');
    for (const c of [[], ['transient.max_co']]) expect(notContinueWords(tr, c, false)).not.toMatch(/no saved time/);
  });

  it('a change for Continue keeps the block the run solved with and takes only the changed keys', () => {
    // As its Start worked it out: the write interval Continue reads, the auto time steps.
    const solved = {
      end_time: 1,
      write_count: 4,
      write_interval: 0.25,
      max_co: 100,
      delta_t: 0.001,
      max_delta_t: 0.25,
      n_outer_correctors: 1,
      n_correctors: 2,
      adjust_time_step: true,
      source: { delta_t: 'auto', max_delta_t: 'auto' },
      estimate: { delta_t: 0.001 },
    };
    // The analysis's clean copy of the edit (unknown keys gone, auto values blank).
    const clean = { end_time: 1, write_count: 4, max_co: 5, delta_t: null, max_delta_t: null, n_outer_correctors: 3, n_correctors: 2 };
    expect(continueTransient(solved, clean, ['transient.max_co', 'transient.n_outer_correctors'])).toEqual({ ...solved, max_co: 5, n_outer_correctors: 3 });
    // A Max time step given is the person's now; a blank one is worked out again.
    expect(continueTransient(solved, { ...clean, max_delta_t: 0.1 }, ['transient.max_delta_t'])).toEqual({ ...solved, max_delta_t: 0.1, source: { delta_t: 'auto', max_delta_t: 'user' } });
    const typed = { ...solved, max_delta_t: 0.1, source: { delta_t: 'auto', max_delta_t: 'user' } };
    expect(continueTransient(typed, clean, ['transient.max_delta_t'])).toEqual({ ...solved, max_delta_t: null, source: { delta_t: 'auto', max_delta_t: 'auto' } });
    // Only the four keys: anything else in `changed` is not taken.
    expect(continueTransient(solved, { ...clean, end_time: 9 }, ['transient.end_time'])).toEqual(solved);
  });
});

describe('RH1: Start over on a run that became unhealthy (A3)', () => {
  const run = { id: 'r2', name: 'Run_2', status: 'stopped', time_dependency: 'Transient', has_results: true, n_saved_times: 12, last_saved_iteration: 0.1667 };
  const fix = { label: 'New run: 3 outer correctors, Max Courant 5', target: 'new_run', values: [{ key: 'transient.max_co', value: 5 }] };
  it('adds the health sentence to the Start question, the same text the Assistant card shows', () => {
    const health = { first_unhealthy: { t: 0.0069061069 }, findings: [{ code: 'courant_mode', level: 'warn', fix: [fix] }] };
    const person = overwriteWords(run, { action: 'start', studyTransient: true, health });
    const card = overwriteWords(run, { action: 'start', studyTransient: true, health, assistant: true });
    expect(person.copy).toMatch(/ "Run_2" became unhealthy at t = 0\.0069 s\. A new run with the fix keeps these results\.$/);
    expect(card.copy).toBe(person.copy);
    // The tree's slim record says it with has_fix.
    expect(unhealthySentence(run, { first_unhealthy: { t: 0.0069061069 }, has_fix: true })).toMatch(/A new run with the fix keeps these results\.$/);
  });
  it('promises no fix when its health offers none', () => {
    const health = { first_unhealthy: { t: 0.0069061069 }, findings: [{ code: 'pv_coupling', level: 'error' }] };
    expect(unhealthySentence(run, health)).toBe(' "Run_2" became unhealthy at t = 0.0069 s. A new run keeps these results.');
    expect(unhealthySentence(run, { first_unhealthy: { t: 0.0069061069 } })).not.toMatch(/the fix/);
  });
  it('an onset in the unread middle of an old log is a span, not a time', () => {
    const health = { first_unhealthy: { t: 0.0031, approx: true, by_t: 0.0069061069 } };
    expect(unhealthySentence(run, health)).toBe(' "Run_2" became unhealthy between t = 0.0031 s and t = 0.0069 s. A new run keeps these results.');
    expect(unhealthySentence(run, { first_unhealthy: { t: 0.0031, approx: true } })).toMatch(/became unhealthy after t = 0\.0031 s\./);
  });
  it('says nothing of health without an onset', () => {
    expect(overwriteWords(run, { action: 'start', studyTransient: true, health: { first_unhealthy: null } }).copy).not.toMatch(/unhealthy/);
    expect(overwriteWords(run, { action: 'start', studyTransient: true }).copy).not.toMatch(/unhealthy/);
    expect(unhealthySentence(run, null)).toBe('');
  });
});

// RH3 (spec 5.3): numerics at Continue. One list of what differs (numericsDiff) makes every text:
// the Continue box's line, the question, the route's and the Assistant's refusals and the card.
describe('numerics at Continue', () => {
  const SCHEMA = {
    type: 'object',
    properties: {
      numerics_preset: { type: 'string', enum: ['robust', 'accurate'], title: 'Numerics', 'x-cfddesk': { enum_labels: ['Robust', 'Accurate'] } },
      simplec: { type: 'boolean', title: 'SIMPLEC (consistent)' },
      relax_u: { type: 'number', title: 'Relaxation U' },
      relax_p: { type: 'number', title: 'Relaxation p' },
      p_tolerance: { type: 'number', title: 'p tolerance' },
      momentum_convection: { type: 'string', enum: ['first_order', 'second_order'], title: 'Momentum convection', 'x-cfddesk': { enum_labels: ['First order (upwind)', 'Second order (linearUpwind)'] } },
    },
  };
  const STUDY = { analysis_type: 'incompressible_steady', relax_p: 0.3, simplec: false, p_tolerance: 1e-7 };
  const used = numericsSnapshot('incompressible_steady', false, STUDY, SCHEMA, '2026-11-04T00:00:00.000Z');
  const steady = { name: 'Run_2', status: 'stopped', time_dependency: 'Steady-state', continue_from: 450, numerics_used: used };
  const transient = { ...steady, time_dependency: 'Transient', continue_from: 0.1666667 };

  it('a Start records every numerics setting of its analysis, raw, blanks as null', () => {
    expect(used).toEqual({
      analysis: 'incompressible_steady',
      mode: 'steady',
      at: '2026-11-04T00:00:00.000Z',
      values: { numerics_preset: null, simplec: false, relax_u: null, relax_p: 0.3, p_tolerance: 1e-7, momentum_convection: null },
    });
    expect(numericsSnapshot('incompressible_transient', true, {}, SCHEMA, 'x').mode).toBe('transient');
    expect(numericsUsedOf(steady)).toBe(used);
    expect(numericsUsedOf({ name: 'Old' })).toBeNull();
    expect(numericsUsedOf({ numerics_used: { analysis: 'x' } })).toBeNull();
  });

  it('nothing differs: an empty list; a run started before RH3 or no study: none either', () => {
    expect(numericsDiff(steady, STUDY, SCHEMA)).toEqual([]);
    // A number within 1e-9 of its size, a blank and a missing key are the same.
    expect(numericsDiff(steady, { ...STUDY, relax_p: 0.3 + 1e-12, relax_u: '' }, SCHEMA)).toEqual([]);
    expect(numericsDiff({ name: 'Old', status: 'stopped' }, { relax_p: 0.2 }, SCHEMA)).toEqual([]);
    expect(numericsDiff(steady, null, SCHEMA)).toEqual([]);
  });

  it('labels from the schema, in its order; blank reads "preset", a choice its label, on/off, a tolerance in exponents', () => {
    const now = { ...STUDY, relax_p: 0.2, relax_u: 0.5, numerics_preset: 'accurate', simplec: true, p_tolerance: 1e-8, momentum_convection: 'first_order' };
    const d = numericsDiff(steady, now, SCHEMA);
    expect(d.map((x) => x.text)).toEqual([
      'Numerics preset → Accurate',
      'SIMPLEC (consistent) off → on',
      'Relaxation U preset → 0.5',
      'Relaxation p 0.3 → 0.2',
      'p tolerance 1e-7 → 1e-8',
      'Momentum convection preset → First order (upwind)',
    ]);
    expect(d[3]).toEqual({ key: 'relax_p', label: 'Relaxation p', from: 0.3, to: 0.2, text: 'Relaxation p 0.3 → 0.2' });
    // A value set back to blank: to null, "preset".
    expect(numericsDiff(steady, { ...STUDY, relax_p: null }, SCHEMA)[0].text).toBe('Relaxation p 0.3 → preset');
    // No schema (its plugin off): the record's keys, named by key.
    expect(numericsDiff(steady, { ...STUDY, relax_p: 0.2 }, null).map((x) => x.text)).toEqual(['relax p 0.3 → 0.2']);
  });

  it("the words: the Continue box's line, the question (transient and steady), the Assistant's refusal and card", () => {
    const d = numericsDiff(transient, { ...STUDY, relax_p: 0.2, relax_u: 0.5 }, SCHEMA);
    const list = 'Relaxation U preset → 0.5, Relaxation p 0.3 → 0.2';
    expect(numericsChangedText(transient, d)).toBe(`The study's numerics changed after "Run_2" started: ${list}.`);
    const w = continueNumericsWords(transient, d);
    expect(w).toEqual({
      title: 'Continue "Run_2"?',
      health: '',
      copy: `The study's numerics changed after "Run_2" started: ${list}.`,
      fresh: { label: 'Continue with the new numerics', line: "Goes on from t = 0.1667 s with the study's numerics now. The run records the change." },
      asWas: { label: 'Continue as it was', line: 'Goes on with the numerics it started with. The study keeps the new values for new runs.' },
      cancel: 'Cancel',
    });
    expect(continueNumericsWords(steady, d).fresh.line).toBe("Goes on from iteration 450 with the study's numerics now. The run records the change.");
    expect(continueNumericsWords(steady, d, 'Its saved results come after it became unhealthy.').health).toBe('Its saved results come after it became unhealthy.');
    expect(chooseNumericsWords(transient, d)).toEqual({
      message: `The study's numerics changed after "Run_2" started (${list}).`,
      hint: 'Pass numerics "as_was" to continue with the numerics it started with, or "new" to use the study\'s numerics now. Ask the person which.',
    });
    expect(numericsCardSentence(transient, d, 'new')).toBe(`Continues "Run_2" with the study's new numerics (${list}).`);
    expect(numericsCardSentence(transient, d, 'as_was')).toBe(`Continues "Run_2" with the numerics it started with; the study's newer values (${list}) are not used.`);
  });

  it('"as it was": what it started with, and blank for a setting its record does not hold', () => {
    const old = { ...used, values: { relax_p: 0.3 } };
    expect(numericsAsWas(old, SCHEMA)).toEqual({ numerics_preset: null, simplec: null, relax_u: null, relax_p: 0.3, p_tolerance: null, momentum_convection: null });
  });

  it('a Continue that took the new numerics records them applied: at most 8 changes (the rest counted), at most 20 entries', () => {
    const d = numericsDiff(steady, { ...STUDY, relax_p: 0.2 }, SCHEMA);
    const waiting = { from_t: null, from_iteration: 450, at: 'a', by: 'person' as const, kind: 'settings' as const, changes: [{ key: 'transient.max_co', from: 100, to: 5 }], applied_at: 'b' };
    const list = withNumericsEntry([waiting], d, { by: 'assistant', at: 'c', from_t: null, from_iteration: 450 });
    expect(list).toEqual([
      waiting,
      { from_t: null, from_iteration: 450, at: 'c', by: 'assistant', kind: 'numerics', changes: [{ key: 'relax_p', label: 'Relaxation p', from: 0.3, to: 0.2, text: 'Relaxation p 0.3 → 0.2' }], applied_at: 'c' },
    ]);
    const many = Array.from({ length: 11 }, (_, i) => ({ key: `k${i}`, label: `K${i}`, from: i, to: i + 1, text: `K${i} ${i} → ${i + 1}` }));
    const e = withNumericsEntry(null, many, { by: 'person', at: 'c', from_t: 0.5, from_iteration: null })[0];
    expect([e.changes.length, e.more]).toEqual([8, 3]);
    const full = Array.from({ length: 20 }, (_, i) => ({ ...waiting, at: String(i) }));
    const capped = withNumericsEntry(full, d, { by: 'person', at: 'z', from_t: null, from_iteration: 450 });
    expect([capped.length, capped[0].at, capped[19].kind]).toEqual([20, '1', 'numerics']);
  });
});
