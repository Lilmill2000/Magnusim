import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { slimRunDoc } from '../w27-solve.js';

describe('slimRunDoc', () => {
  it('drops log re-parse payload and keeps first-paint fields', () => {
    const slim = slimRunDoc({
      id: 'run-1',
      run_id: 'run-1',
      name: 'Run 1',
      status: 'done',
      case_dir: 'C:/case',
      has_results: true,
      residuals: [{ i: 1, p: 0.1 }],
      log_excerpt: 'Time = 200\n',
      log_path: 'C:/case/log.simpleFoam',
      iteration: 200,
      n_saved_times: 2,
    });
    assert.equal(slim.id, 'run-1');
    assert.equal(slim.has_results, true);
    assert.equal(slim.iteration, 200);
    assert.equal(slim.n_saved_times, 2);
    assert.equal(slim.residuals, undefined);
    assert.equal(slim.log_excerpt, undefined);
    assert.equal(slim.log_path, undefined);
  });
});
