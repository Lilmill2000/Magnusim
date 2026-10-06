// F5: a run that ends itself because it converged (API 1.4). Its analysis's log parser
// gives a `converged` event, which the runner's frames leave out: the end reads it back
// from the job log (convergedFromJobLog) and the run doc says how it ended (endedRunDoc):
//   - residuals met: note "simpleFoam converged after 215 iterations: ...", converged
//     {by: 'residuals', iteration: 215};
//   - a settled monitor: note "Converged: <the analysis's sentence>.", converged {by: 'monitor', ...};
//   - ran to its end: the note before ("simpleFoam finished. ..."), converged false when the
//     run could have converged (residual targets or a settle stop), left out otherwise;
//   - stopped and failed runs get no converged.
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-converged-'));
const PROJECTS = join(ROOT, 'projects');
mkdirSync(PROJECTS, { recursive: true });
process.env.MAGNUSIM_PROJECTS_ROOT = PROJECTS;
process.env.MAGNUSIM_LOCAL_JSON = join(ROOT, 'local.json');
process.env.MAGNUSIM_QUEUE_QUIET = '1';

const core = await import('../core-solve.js');

after(() => {
  try {
    rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* Windows may hold a file */
  }
});

/** A job log as the runner writes it: one JSON row per event. */
function jobLog(name, rows) {
  const path = join(ROOT, name);
  const ts = '2026-10-05T10:00:00.000Z';
  writeFileSync(path, rows.map((r) => JSON.stringify({ ts, kind: 'solve', job_id: 'j1', level: 'info', msg: r.event, ...r })).join('\n') + '\n');
  return path;
}

const STEADY = { time_dependency: 'Steady-state', prepare_run: { residual_control: true } };
const TRANSIENT = { time_dependency: 'Transient', prepare_run: {} };
const DONE = { status: 'done', app: 'simpleFoam', result: { exit_code: 0 } };

describe('convergedFromJobLog', () => {
  it('reads the converged event near the end of the job log', () => {
    const path = jobLog('a.jsonl', [
      { event: 'progress', time: 214 },
      { event: 'residual', field: 'p', initial: 0.0067 },
      { event: 'converged', by: 'residuals', time: 215 },
      { event: 'log', line: 'End' },
      { event: 'stage', stage: 'copy' },
      { event: 'result', ok: true, exit_code: 0 },
    ]);
    assert.deepEqual(core.convergedFromJobLog(path), { by: 'residuals', time: 215 });
  });

  it('reads a prefixed event line and a monitor end', () => {
    const path = join(ROOT, 'b.log');
    writeFileSync(path, 'MAGNUSIM_EVENT {"event":"progress","time":0.08}\nMAGNUSIM_EVENT {"event":"converged","by":"monitor","time":0.0817949}\n');
    assert.deepEqual(core.convergedFromJobLog(path), { by: 'monitor', time: 0.0817949 });
  });

  it('is null without one, for an unknown kind, and for a missing log', () => {
    const plain = jobLog('c.jsonl', [{ event: 'progress', time: 10 }, { event: 'log', line: 'PIMPLE: converged in 3 iterations' }]);
    assert.equal(core.convergedFromJobLog(plain), null);
    const odd = jobLog('d.jsonl', [{ event: 'converged', by: 'luck', time: 3 }]);
    assert.equal(core.convergedFromJobLog(odd), null);
    assert.equal(core.convergedFromJobLog(join(ROOT, 'none.jsonl')), null);
    assert.equal(core.convergedFromJobLog(null), null);
  });

  it('only searches the end of a long log', () => {
    const rows = [{ event: 'converged', by: 'residuals', time: 1 }];
    for (let i = 0; i < 6000; i++) rows.push({ event: 'log', line: 'x'.repeat(60) });
    assert.equal(core.convergedFromJobLog(jobLog('e.jsonl', rows)), null);
  });
});

describe('endedRunDoc: how a run ended', () => {
  it('a steady run whose residuals met their targets', () => {
    const out = core.endedRunDoc(STEADY, DONE, { converged: { by: 'residuals', time: 215 }, saved: [200, 215] });
    assert.equal(out.status, 'done');
    assert.deepEqual(out.converged, { by: 'residuals', iteration: 215 });
    assert.equal(out.note, 'simpleFoam converged after 215 iterations: the residuals met their targets. Results are in the run folder.');
  });

  it('a run stopped by its settled monitor says what settled', () => {
    const doc = {
      ...STEADY,
      prepare_run: { residual_control: true, stop_when: { label: 'Forces 1 · Cd', text: 'Forces 1 · Cd stayed within 0.001 of its average over 100 iterations' } },
    };
    const out = core.endedRunDoc(doc, DONE, { converged: { by: 'monitor', time: 140 }, saved: [140] });
    assert.deepEqual(out.converged, { by: 'monitor', iteration: 140, text: 'Forces 1 · Cd stayed within 0.001 of its average over 100 iterations' });
    assert.equal(out.note, 'Converged: Forces 1 · Cd stayed within 0.001 of its average over 100 iterations. Results are in the run folder.');
  });

  it('a transient run on its seconds axis', () => {
    const out = core.endedRunDoc(TRANSIENT, { ...DONE, app: 'pimpleFoam' }, { converged: { by: 'monitor', time: 0.0817949 }, saved: [0.08, 0.0817949] });
    assert.deepEqual(out.converged, { by: 'monitor', time: 0.0817949 });
    assert.equal(out.note, 'pimpleFoam stopped when its monitor settled at t = 0.0817949 s. Results are in the run folder.');
  });

  it('a run that reached its end keeps the note before and says it did not converge when it could have', () => {
    const out = core.endedRunDoc(STEADY, DONE, { saved: [200] });
    assert.equal(out.note, 'simpleFoam finished. Results are in the run folder.');
    assert.equal(out.converged, false);
    const settle = core.endedRunDoc({ ...TRANSIENT, prepare_run: { stop_when: { label: 'x', text: 'y' } } }, DONE, { saved: [1] });
    assert.equal(settle.converged, false);
    // A transient run without a settle stop has nothing to converge on.
    assert.equal('converged' in core.endedRunDoc(TRANSIENT, DONE, { saved: [1] }), false);
    // A stop that could not be used is not one.
    const unusable = core.endedRunDoc({ ...TRANSIENT, prepare_run: { stop_when: { error: 'gone' } } }, DONE, { saved: [1] });
    assert.equal('converged' in unusable, false);
  });

  it('stopped and failed runs get no converged', () => {
    const stopped = core.endedRunDoc(STEADY, { status: 'stopped', app: 'simpleFoam' }, { saved: [50], converged: { by: 'residuals', time: 50 } });
    assert.equal('converged' in stopped, false);
    const failed = core.endedRunDoc(STEADY, { status: 'failed', app: 'simpleFoam', error: 'simpleFoam failed (exit 1)' }, {});
    assert.equal('converged' in failed, false);
  });

  it('takes the iteration from the progress when the event has no time', () => {
    const out = core.endedRunDoc(STEADY, DONE, { converged: { by: 'residuals', time: null }, snap: { sim_time: 88, residuals: [] }, saved: [88] });
    assert.deepEqual(out.converged, { by: 'residuals', iteration: 88 });
  });
});
