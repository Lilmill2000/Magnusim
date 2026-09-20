import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { solveStartBlockReason } from '../solve-start-block.js';

describe('solve start block', () => {
  it('lets a fresh or finished-dead run start', () => {
    assert.equal(solveStartBlockReason({ status: 'draft' }), null);
    assert.equal(solveStartBlockReason({ status: 'stopped' }), null);
    assert.equal(solveStartBlockReason({ status: 'running' }, { windowsLive: false, wslLive: false }), null);
  });

  it('blocks a finished run', () => {
    assert.equal(solveStartBlockReason({ status: 'done' }), 'finished');
  });

  it('blocks an orphan WSL solve so Start cannot double-spawn', () => {
    assert.equal(
      solveStartBlockReason({ status: 'running' }, { windowsLive: false, wslLive: true }),
      'already_running',
    );
    assert.equal(
      solveStartBlockReason({ status: 'starting' }, { windowsLive: true, wslLive: false }),
      'already_running',
    );
  });

  it('allows Start after Stop while the solver is still draining', () => {
    assert.equal(
      solveStartBlockReason({ status: 'running', stop_requested: true }, { wslLive: true }),
      'draining',
    );
  });
});
