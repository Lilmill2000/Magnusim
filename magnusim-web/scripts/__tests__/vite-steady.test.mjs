// run.bat's steady mode (MAGNUSIM_STEADY=1, vite.config.js): no file watcher, no hot
// reload, and the app's entry and lazy imports compiled at start; without it (npm run dev,
// run.bat --live, every e2e server) the watcher and hot reload are as before.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
let serial = 0;

/** vite.config.js as it reads with MAGNUSIM_STEADY set to `steady` (undefined: unset). */
async function config(steady) {
  const before = process.env.MAGNUSIM_STEADY;
  if (steady === undefined) delete process.env.MAGNUSIM_STEADY;
  else process.env.MAGNUSIM_STEADY = steady;
  try {
    serial += 1;
    return (await import(`${pathToFileURL(join(WEB, 'vite.config.js')).href}?steady=${serial}`)).default;
  } finally {
    if (before === undefined) delete process.env.MAGNUSIM_STEADY;
    else process.env.MAGNUSIM_STEADY = before;
  }
}

describe('vite steady mode', () => {
  it('MAGNUSIM_STEADY=1: no watcher, no hot reload, and the entry and lazy imports warmed up (files that exist)', async () => {
    const c = await config('1');
    assert.equal(c.server.watch, null);
    assert.equal(c.server.hmr, false);
    const warm = c.server.warmup.clientFiles;
    assert.deepEqual(warm, ['./src/app/main.tsx', './src/workbench/runtime.js', './src/workspace/startActions.ts']);
    for (const f of warm) assert.ok(existsSync(join(WEB, f)), f);
  });

  it('unset (npm run dev, run.bat --live, the e2e servers) or 0: the watcher and hot reload as before', async () => {
    for (const v of [undefined, '0']) {
      const c = await config(v);
      assert.equal(typeof c.server.watch, 'object');
      assert.notEqual(c.server.watch, null);
      assert.equal(typeof c.server.watch.ignored, 'function');
      assert.equal(c.server.hmr, undefined);
      assert.equal(c.server.warmup, undefined);
    }
  });

  it('run.bat starts steady and --live turns it off', async () => {
    const { readFileSync } = await import('node:fs');
    const bat = readFileSync(join(WEB, 'run.bat'), 'utf8');
    const steady = bat.indexOf('set MAGNUSIM_STEADY=1');
    const live = bat.indexOf('if /i "%~1"=="--live" set MAGNUSIM_STEADY=0');
    const dev = bat.indexOf('call npm run dev');
    assert.ok(steady > 0 && live > steady && dev > live, 'set steady, then --live, then start the server');
  });
});
