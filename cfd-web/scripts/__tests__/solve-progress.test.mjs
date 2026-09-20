import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseSolveProgress, solveDisplayStage } from '../w27-solve.js';

const TIME_ONLY = `
Courant Number mean: 0.12 max: 0.98
deltaT = 0.000123
Time = 0.000123
Smooth solver:  Solving for Ux, Initial residual = 0.5, Final residual = 1e-3, No Iterations 2
DICPCG:  Solving for p, Initial residual = 0.4, Final residual = 1e-4, No Iterations 10
`;

const JSONL_NO_STAGE = `
{"event":"progress","time":0.015,"sim_time":0.015,"co_max":0.9}
{"event":"residual","field":"p","initial":0.4,"time":0.015}
{"event":"time_saved","t":0.266}
`;

const PREFIXED = `
MAGNUSIM_EVENT {"event":"progress","time":0.02,"sim_time":0.02}
CFDDESK_EVENT {"event":"time_saved","t":0.02}
`;

describe('parseSolveProgress', () => {
  it('promotes to solve from Time= when no stage event arrived', () => {
    const snap = parseSolveProgress(TIME_ONLY);
    assert.equal(snap.stage, 'solve');
    assert.ok(snap.sim_time > 0);
    assert.ok(snap.n_steps >= 1);
  });

  it('promotes to solve from progress/time_saved JSONL without a stage event', () => {
    const snap = parseSolveProgress(JSONL_NO_STAGE);
    assert.equal(snap.stage, 'solve');
    assert.ok(snap.sim_time > 0);
    assert.deepEqual(snap.live_saved_times, [0.266]);
  });

  it('parses MAGNUSIM_EVENT / CFDDESK_EVENT prefixes', () => {
    const snap = parseSolveProgress(PREFIXED);
    assert.equal(snap.stage, 'solve');
    assert.equal(snap.sim_time, 0.02);
  });
});

describe('solveDisplayStage', () => {
  it('does not leave Starting on a run that already has frames', () => {
    assert.equal(solveDisplayStage({ stage: 'starting', n_saved_times: 8, last_saved_iteration: 0.26 }), 'solve');
    assert.equal(solveDisplayStage({ stage: 'starting' }), 'starting');
    assert.equal(solveDisplayStage({ stage: 'copy', n_saved_times: 8 }), 'copy');
  });
});
