import { describe, expect, it } from 'vitest';
import {
  endedRunReason,
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
  unresolveTransient,
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
    expect(runEditState(stopped)).toBe('overwrites');
    expect(runEditState({ ...stopped, status: 'failed' })).toBe('overwrites');
    // Stopped before anything was written: quietly a draft again.
    expect(runEditState({ status: 'stopped', iteration: 0 })).toBe('free');
    expect(runEditState({ status: 'failed', has_results: false, n_saved_times: 0 })).toBe('free');
    expect(runEditState({ ...stopped, status: 'done' })).toBe('new_run');
    expect(runEditState({ status: 'running' })).toBe('locked');
    expect(runEditState({ status: 'starting' })).toBe('locked');
  });

  it('read_setup words: editable, overwrites, new_run, locked', () => {
    expect(runSettingsWord('draft')).toBe('editable');
    expect(runSettingsWord('free')).toBe('editable');
    expect(runSettingsWord('overwrites')).toBe('overwrites');
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
