import { describe, expect, it } from 'vitest';
import {
  OVERCLAIM,
  attemptWords,
  badgeTitle,
  chipTitle,
  chipWord,
  continueHealthWords,
  earlierPartLines,
  fixLabel,
  healthNextWords,
  healthSubline,
  restartSentence,
  type HealthRecord,
  type HealthRunView,
} from './runHealthWords';

const FIX = {
  label: 'New run: 3 outer correctors, Max Courant 5',
  target: 'new_run' as const,
  values: [
    { key: 'transient.n_outer_correctors', value: 3 },
    { key: 'transient.max_co', value: 5 },
  ],
  cost: { steps: 177_878, wall_s: 308_946 },
};

function rec(extra: Partial<HealthRecord> = {}): HealthRecord {
  return {
    v: 1,
    verdict: 'unhealthy',
    unit: 'time step',
    window: 50,
    t: 0.2006,
    first_unhealthy: { t: 0.0069061069, step: 25, wall_s: 15 },
    timeline: [
      { t: 0.0002, verdict: 'watch' },
      { t: 0.0069, verdict: 'unhealthy' },
    ],
    restart: 'from_zero',
    findings: [{ code: 'velocity_clipped', level: 'error', text: 'Velocity clipped', fix: [FIX, { ...FIX, label: 'New run: Max Courant 1', cost: { steps: 889_391, wall_s: 514_911 } }] }],
    ...extra,
  };
}

const run = (status: string, saved: number | null, extra: Partial<HealthRunView> = {}): HealthRunView => ({ name: 'Run_2', status, saved, transient: true, ...extra });

describe('the chip', () => {
  it('says the verdict, and "Checking" with what it needs, in time steps or iterations', () => {
    expect(chipWord(null, true)).toBe('Checking (needs 6 time steps)');
    expect(chipWord(null, false)).toBe('Checking (needs 6 iterations)');
    expect(chipWord(rec({ verdict: 'pending', unit: 'iteration' }), true)).toBe('Checking (needs 6 iterations)');
    expect(chipWord(rec({ verdict: 'healthy' }), true)).toBe('Healthy');
    expect(chipWord(rec({ verdict: 'watch' }), true)).toBe('Watch closely');
    expect(chipWord(rec(), true)).toBe('Unhealthy');
    expect(chipWord(rec({ verdict: 'failed' }), true)).toBe('Failed');
  });

  it("its title: Healthy never reads as good results, with the real window and what was not checked", () => {
    expect(chipTitle(rec({ verdict: 'healthy' }), true)).toBe(
      'No stability problems found in the last 50 time steps. This does not check mesh independence or whether averages have settled.',
    );
    expect(chipTitle(rec({ verdict: 'healthy', window: 12, unit: 'iteration' }), false)).toBe(
      'No stability problems found in the last 12 iterations. This does not check mesh independence or whether the residuals have reached their targets.',
    );
    expect(chipTitle(rec({ verdict: 'healthy', window: 1 }), true)).toMatch(/^No stability problems found in the last time step\./);
    const skipped = rec({
      verdict: 'healthy',
      skipped: [
        { code: 'speed_growth', why: 'no fixed inflow' },
        { code: 'monitor_drift', why: 'no fixed inflow' },
      ],
    });
    expect(chipTitle(skipped, true)).toMatch(/ Not checked: speed growth \(no fixed inflow\), pressure-drop drift \(no fixed inflow\)\.$/);
  });
});

describe('the subline', () => {
  it('live, ended, the real window count, the onset, a missing head and a stale record', () => {
    expect(healthSubline(rec({ verdict: 'healthy' }), run('running', null), 14)).toBe('Last 50 time steps, up to t = 0.201 s · updated 14 s ago');
    expect(healthSubline(rec({ verdict: 'healthy', window: 12, t: 0.0031 }), run('running', null), 3)).toBe('Last 12 time steps, up to t = 0.0031 s · updated 3 s ago');
    expect(healthSubline(rec({ verdict: 'healthy', window: 12, unit: 'iteration', t: 17 }), run('running', null, { transient: false }), null)).toBe('Last 12 iterations, up to iteration 17');
    expect(healthSubline(rec({ verdict: 'healthy', live: false, t: 0.2007 }), run('done', 0.2), null)).toBe('Last 50 time steps before it ended at t = 0.201 s');
    expect(healthSubline(rec({ window: 1 }), run('running', null), 1)).toMatch(/^Last time step, up to/);
    expect(healthSubline(rec(), run('running', null), 2)).toMatch(/ · Unhealthy since t = 0\.0069 s \(15 s into the solve\)$/);
    expect(healthSubline(rec({ head_missing: true, checked_steps: 1200, live: false }), run('done', 0.2), null)).toMatch(/ · Checked the last 1,200 time steps only$/);
    expect(healthSubline(rec({ stale: true, t: 0.18 }), run('running', null), null)).toMatch(/ · details from t = 0\.18 s \(the latest check was too large to keep\)$/);
  });
});

describe('what to do, by the run state and restart (A3)', () => {
  const STATES: Array<[string, HealthRunView]> = [
    ['running', run('running', null)],
    ['stopping', run('running', null, { stopping: true })],
    ['stopped with a saved time', run('stopped', 0.1667)],
    ['stopped without one', run('stopped', null)],
    ['failed', run('failed', 0.1667)],
    ['done', run('done', 0.1667)],
  ];
  const RESTARTS: Array<[string, Partial<HealthRecord>, number | null]> = [
    ['from_zero', { restart: 'from_zero' }, 0.1667],
    ['continue_after_fix, saved before the onset', { restart: 'continue_after_fix' }, 0.005],
    ['continue_after_fix, Healthy again', { restart: 'continue_after_fix', timeline: [{ t: 0.0069, verdict: 'unhealthy' }, { t: 0.05, verdict: 'healthy' }] }, 0.1],
    ['null', { restart: null }, 0.1667],
  ];

  it('never claims Continue will be healthy, safe or fixed', () => {
    for (const [, view] of STATES) {
      for (const [, extra, saved] of RESTARTS) {
        const v = { ...view, saved: view.saved === null ? null : saved };
        const next = healthNextWords(v, rec(extra));
        expect(next.text).not.toMatch(OVERCLAIM);
        const box = continueHealthWords(v, rec(extra), null);
        if (box) expect(box.text).not.toMatch(OVERCLAIM);
      }
    }
  });

  it('a running run: a plain Stop and the new-run buttons, no Continue sentence', () => {
    const next = healthNextWords(run('running', null), rec());
    expect(next.stop).toBe(true);
    expect(next.text).toBe('');
    expect(next.fixes.map((f) => f.words)).toEqual([
      'New run: 3 outer correctors, Max Courant 5 (~180,000 steps, about 4 days)',
      'New run: Max Courant 1 (~890,000 steps, about 6 days)',
    ]);
  });

  it('stopping, no saved time, failed', () => {
    expect(healthNextWords(run('running', null, { stopping: true }), rec()).text).toBe('Stopping: it is writing its current time step.');
    expect(healthNextWords(run('stopped', null), rec()).text).toBe('It has no saved time to continue from.');
    const failed = healthNextWords(run('failed', 0.1), rec());
    expect(failed.text).toBe('A failed run does not continue (Continue is offered only for stopped and finished runs); starting it again deletes its results.');
    expect(failed.stop).toBe(false);
  });

  it('the restart sentences; "Use when continuing" only for a stopped run with a saved time', () => {
    expect(restartSentence(run('stopped', 0.1667), rec())).toBe(
      'Its saved results (from t = 0.167 s) come after the problem began (t = 0.0069 s), so Continue would carry it on. Start again from t = 0 in a new run; Run_2 and its results stay.',
    );
    const before = restartSentence(run('stopped', 0.005), rec({ restart: 'continue_after_fix' }));
    expect(before).toBe(
      'Its last saved time (t = 0.005 s) is before it became unhealthy (t = 0.0069 s). Continue goes on from there; with the same settings it will likely become unhealthy again. A change made with "Use when continuing" (Max Courant or the correctors) may avoid that, but only Health on the continued part can tell. A new run from t = 0 is the surer way.',
    );
    const again = restartSentence(run('stopped', 0.1), rec({ restart: 'continue_after_fix', timeline: [{ t: 0.0069, verdict: 'unhealthy' }, { t: 0.05, verdict: 'healthy' }] }));
    expect(again).toBe(
      'It was unhealthy from t = 0.0069 s and Healthy again by its last saved time (t = 0.1 s). Results saved in between hold the problem, and Continue with the same settings may repeat it. A new run from t = 0 is the surer way.',
    );
    const done = restartSentence(run('done', 0.005), rec({ restart: 'continue_after_fix' }));
    expect(done).toMatch(/A finished run's settings do not change, so a change needs a new run\.$/);
    for (const [, view] of STATES) {
      for (const [, extra, saved] of RESTARTS) {
        const v = { ...view, saved: view.saved === null ? null : saved };
        const text = healthNextWords(v, rec(extra)).text;
        if (/Use when continuing/.test(text)) expect(v.status).toBe('stopped');
      }
    }
    expect(restartSentence(run('stopped', 0.1), rec({ restart: null }))).toBe('');
    expect(restartSentence(run('stopped', 0.1), rec({ restart: null, head_missing: true }))).toBe('The start of its log is gone, so when the problem began is unknown.');
  });
});

describe('the Continue box (spec 3.12)', () => {
  it('from_zero asks first; a pending change says Health checks the continued part', () => {
    const z = continueHealthWords(run('stopped', 0.1667), rec(), null);
    expect(z).toEqual({
      text: 'Its saved results (t = 0.167 s) are from after it became unhealthy (t = 0.0069 s); continuing carries that on. A new run from t = 0 is safer.',
      ask: true,
    });
    const pending = continueHealthWords(run('stopped', 0.005), rec({ restart: 'continue_after_fix' }), { changes: [{ key: 'transient.max_co', from: 100, to: 5 }] });
    expect(pending?.text).toBe('Health checks the continued part from t = 0.005 s; whether the change is enough shows only there.');
    expect(pending?.ask).toBe(false);
    expect(continueHealthWords(run('running', null), rec(), null)).toBeNull();
    expect(continueHealthWords(run('failed', 0.1), rec(), null)).toBeNull();
    expect(continueHealthWords(run('stopped', 0.1), rec({ first_unhealthy: null }), null)).toBeNull();
  });
});

describe('labels, earlier parts and the badge', () => {
  it('the fix label has its cost; none without rates', () => {
    expect(fixLabel(FIX)).toBe('New run: 3 outer correctors, Max Courant 5 (~180,000 steps, about 4 days)');
    expect(fixLabel({ ...FIX, cost: { steps: 9000, wall_s: 7200 } })).toBe('New run: 3 outer correctors, Max Courant 5 (~9,000 steps, about 2 hours)');
    expect(fixLabel({ ...FIX, cost: null })).toBe('New run: 3 outer correctors, Max Courant 5');
  });

  it('an earlier part and the change made at its Continue', () => {
    expect(attemptWords({ verdict: 'unhealthy', codes: ['velocity_clipped', 'turbulence_bounded'] })).toBe('Unhealthy (velocity clipping, turbulence bounding)');
    expect(
      earlierPartLines(
        [{ last_saved_iteration: 0.2, health: { verdict: 'unhealthy', codes: ['velocity_clipped', 'turbulence_bounded'] } }],
        [{ from_t: 0.2, applied_at: '2026-11-03T10:00:00Z', changes: [{ key: 'transient.max_co', from: 100, to: 5 }] }],
        true,
      ),
    ).toEqual(['Earlier part (to t = 0.2 s): Unhealthy (velocity clipping, turbulence bounding). Then Max Courant 100 → 5 from t = 0.2 s.']);
  });

  it('the tree badge title', () => {
    expect(badgeTitle(rec(), true)).toBe('Health: Unhealthy since t = 0.0069 s');
  });
});
