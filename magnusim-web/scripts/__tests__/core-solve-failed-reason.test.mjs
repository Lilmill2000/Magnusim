// API 1.8: a run whose solver died of a cause its analysis's log parser knows. The parser
// gives a `failed_reason` event ({reason}); the end reads it back from the job log
// (failedReasonFromJobLog) and the failed run's error is the reason, its note starts with it
// (endedRunDoc). Only plain one-line text up to 160 characters is taken (the Run
// panel's failure line shows that much whole).
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-failed-reason-'));
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

const REASON = 'Boussinesq density reached zero: use incompressible perfect gas';

function log(name, lines) {
  const path = join(ROOT, name);
  writeFileSync(path, lines.join('\n') + '\n');
  return path;
}

describe('failedReasonFromJobLog', () => {
  it('reads the last failed_reason event of the job log', () => {
    const path = log('a.jsonl', [
      JSON.stringify({ ts: 't', kind: 'solve', event: 'progress', time: 49 }),
      'MAGNUSIM_EVENT ' + JSON.stringify({ event: 'failed_reason', reason: REASON }),
      JSON.stringify({ ts: 't', kind: 'solve', event: 'result', ok: false, exit_code: 136 }),
    ]);
    assert.equal(core.failedReasonFromJobLog(path), REASON);
  });

  it('takes no reason that is not one plain line of at most 160 characters', () => {
    const long = log('b.jsonl', [JSON.stringify({ event: 'failed_reason', reason: 'x'.repeat(161) })]);
    assert.equal(core.failedReasonFromJobLog(long), null);
    const lines = log('c.jsonl', [JSON.stringify({ event: 'failed_reason', reason: 'two\nlines' })]);
    assert.equal(core.failedReasonFromJobLog(lines), null);
    const none = log('d.jsonl', [JSON.stringify({ event: 'failed_reason' })]);
    assert.equal(core.failedReasonFromJobLog(none), null);
    assert.equal(core.failedReasonFromJobLog(join(ROOT, 'missing.jsonl')), null);
    assert.equal(core.failedReasonFromJobLog(''), null);
  });
});

describe('endedRunDoc: a failed run with its cause', () => {
  const FAILED = { status: 'failed', app: 'buoyantSimpleFoam', error: 'buoyantSimpleFoam failed (exit 136)', result: { exit_code: 136 } };
  const DOC = { time_dependency: 'Steady-state', prepare_run: {} };

  it('says the cause first', () => {
    const out = core.endedRunDoc(DOC, FAILED, { saved: [], reason: REASON });
    assert.equal(out.status, 'failed');
    assert.equal(out.error, REASON);
    assert.equal(out.note, `${REASON}. buoyantSimpleFoam failed (exit 136).`);
  });

  it('keeps the note before when the parser named none', () => {
    const out = core.endedRunDoc(DOC, FAILED, { saved: [] });
    assert.equal(out.error, null);
    assert.equal(out.note, 'buoyantSimpleFoam failed (exit 136).');
  });
});
