import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseSolveProgress, solveDisplayStage } from '../w27-solve.js';

// What the analysis's log parser (Python) emits for one step: Courant, the
// time, and two residuals. gate:h8-single-parser: Node reads only these events.
const STEP_EVENTS = `
MAGNUSIM_EVENT {"event":"courant","mean":0.12,"max":0.98}
MAGNUSIM_EVENT {"event":"courant","delta_t":0.000123}
MAGNUSIM_EVENT {"event":"progress","time":0.000123,"sim_time":0.000123}
MAGNUSIM_EVENT {"event":"residual","field":"Ux","initial":0.5,"time":0.000123}
MAGNUSIM_EVENT {"event":"residual","field":"p","initial":0.4,"time":0.000123}
`;

// The same step as raw OpenFOAM output. Node no longer parses solver lines.
const RAW_SOLVER_LINES = `
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
  it('builds the step from the parser events (residuals, Courant, time step)', () => {
    const snap = parseSolveProgress(STEP_EVENTS);
    assert.equal(snap.stage, 'solve');
    assert.equal(snap.sim_time, 0.000123);
    assert.equal(snap.n_steps, 1);
    assert.equal(snap.co_max, 0.98);
    assert.equal(snap.delta_t, 0.000123);
    assert.equal(snap.residuals.length, 1);
    assert.equal(snap.residuals[0].U, 0.5); // U = max of Ux, Uy, Uz
    assert.equal(snap.residuals[0].p, 0.4);
  });

  it('does not parse raw solver output (one parser, in Python)', () => {
    const snap = parseSolveProgress(RAW_SOLVER_LINES);
    assert.equal(snap.n_steps, 0);
    assert.equal(snap.sim_time, 0);
    assert.deepEqual(snap.residuals, []);
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

  it('keeps the seconds of each solve phase', () => {
    const snap = parseSolveProgress(
      [
        'MAGNUSIM_EVENT {"event":"phase","phase":"copy_in","seconds":2.5}',
        'MAGNUSIM_EVENT {"event":"phase","phase":"solve","seconds":94}',
        'MAGNUSIM_EVENT {"event":"phase","phase":"reconstruct","seconds":19}',
      ].join('\n'),
    );
    assert.deepEqual(snap.phases, { copy_in: 2.5, solve: 94, reconstruct: 19 });
    assert.equal(parseSolveProgress(PREFIXED).phases, undefined);
  });
});

describe('solveDisplayStage', () => {
  it('does not leave Starting on a run that already has frames', () => {
    assert.equal(solveDisplayStage({ stage: 'starting', n_saved_times: 8, last_saved_iteration: 0.26 }), 'solve');
    assert.equal(solveDisplayStage({ stage: 'starting' }), 'starting');
    assert.equal(solveDisplayStage({ stage: 'copy', n_saved_times: 8 }), 'copy');
  });
});
