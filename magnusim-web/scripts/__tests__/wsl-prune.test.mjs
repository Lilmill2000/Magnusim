import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { scheduleWslPrune, stopWslPrune, wslPruneSettings } from '../wsl-prune.js';

// The server sweeps finished WSL cases in the background (wsl-prune.spec.js runs it
// for real against a throwaway case root).
describe('WSL case sweep schedule', () => {
  afterEach(() => stopWslPrune());

  it('is on by default: cases untouched for 24 h, first sweep 2 min after boot', () => {
    assert.deepEqual(wslPruneSettings({}), { enabled: true, maxAgeHours: 24, delayMs: 120_000 });
  });

  it('reads MAGNUSIM_ and legacy CFDDESK_ settings; a bad number keeps the default', () => {
    assert.deepEqual(
      wslPruneSettings({ MAGNUSIM_WSL_PRUNE_MAX_AGE_H: '0', MAGNUSIM_WSL_PRUNE_DELAY_MS: '1000' }),
      { enabled: true, maxAgeHours: 0, delayMs: 1000 },
    );
    assert.equal(wslPruneSettings({ CFDDESK_WSL_PRUNE: '0' }).enabled, false);
    assert.equal(wslPruneSettings({ MAGNUSIM_WSL_PRUNE: '1' }).enabled, true);
    assert.deepEqual(
      wslPruneSettings({ MAGNUSIM_WSL_PRUNE_MAX_AGE_H: '-3', MAGNUSIM_WSL_PRUNE_DELAY_MS: 'soon' }),
      { enabled: true, maxAgeHours: 24, delayMs: 120_000 },
    );
  });

  it('runs only on Windows, and not when turned off', () => {
    assert.equal(scheduleWslPrune({ platform: 'linux', env: {} }), false);
    assert.equal(scheduleWslPrune({ platform: 'win32', env: { MAGNUSIM_WSL_PRUNE: '0' } }), false);
    // An hour away: the test never waits for it, and stopWslPrune clears it.
    assert.equal(scheduleWslPrune({ platform: 'win32', env: { MAGNUSIM_WSL_PRUNE_DELAY_MS: '3600000' } }), true);
    // One schedule per server.
    assert.equal(scheduleWslPrune({ platform: 'win32', env: {} }), true);
  });

  it('keeps one schedule when a Vite restart imports the module again', async () => {
    const again = await import('../wsl-prune.js?vite-restart');
    assert.notEqual(again.scheduleWslPrune, scheduleWslPrune);
    const key = Symbol.for('magnusim.wslPrune');
    assert.equal(scheduleWslPrune({ platform: 'win32', env: { MAGNUSIM_WSL_PRUNE_DELAY_MS: '3600000' } }), true);
    const first = globalThis[key].timer;
    assert.ok(first);
    assert.equal(again.scheduleWslPrune({ platform: 'win32', env: { MAGNUSIM_WSL_PRUNE_DELAY_MS: '1' } }), true);
    assert.equal(globalThis[key].timer, first);
    again.stopWslPrune();
    assert.equal(globalThis[key].timer, null);
  });
});
