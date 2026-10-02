// H15: spawnJob's onClose. A starter that exits at once while the relay it started
// keeps its pipes: the launch is decided at close, not at exit (scripts/job-runner.js).
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-jobclose-'));
process.env.MAGNUSIM_PROJECTS_ROOT = join(ROOT, 'projects');
process.env.MAGNUSIM_LOCAL_JSON = join(ROOT, 'local.json');

const { spawnJob } = await import('../job-runner.js');

after(() => rmSync(ROOT, { recursive: true, force: true }));

// The "relay": writes its launch line 300 ms in, split across chunks, with a whole
// stderr line in between, then keeps the pipes 2 s.
const RELAY = join(ROOT, 'relay.cjs');
writeFileSync(
  RELAY,
  `setTimeout(() => {
  process.stdout.write('MAGNUSIM_EVENT {"event":"relay_launch",');
  setTimeout(() => {
    process.stderr.write('MAGNUSIM_EVENT {"event":"warn_line","n":1}\\n');
    setTimeout(() => {
      process.stdout.write('"launcher_pid":1}\\n{"event":"tail_no_newline"}');
      setTimeout(() => process.exit(0), 1700);
    }, 30);
  }, 30);
}, 300);
`,
);
// The "starter": starts the relay on its own pipes and exits 0 at once.
const STARTER = join(ROOT, 'starter.cjs');
writeFileSync(
  STARTER,
  `const { spawn } = require('node:child_process');
const child = spawn(process.execPath, [${JSON.stringify(RELAY)}], { stdio: ['ignore', 'inherit', 'inherit'], detached: true, windowsHide: true });
child.unref();
process.exit(0);
`,
);

describe('spawnJob with onClose', () => {
  it('onExit first; onClose only after the relay ends; lines arrive whole, per stream', async () => {
    const t0 = Date.now();
    const seen = { exitAt: 0, closeAt: 0, events: [], exitCode: null, closes: 0 };
    let child;
    await new Promise((done) => {
      ({ child } = spawnJob({
        kind: 'test',
        jobId: 'close-1',
        python: process.execPath,
        script: STARTER,
        onEvent: (ev) => seen.events.push({ ev, at: Date.now() - t0 }),
        onExit: (code) => {
          seen.exitAt = Date.now() - t0;
          seen.exitCode = code;
        },
        onClose: () => {
          seen.closes += 1;
          seen.closeAt = Date.now() - t0;
          done();
        },
      }));
    });
    assert.equal(seen.exitCode, 0);
    assert.ok(seen.exitAt < seen.closeAt, `exit ${seen.exitAt} close ${seen.closeAt}`);
    assert.ok(seen.closeAt - seen.exitAt > 1200, 'close waits for the relay, not the starter');
    const names = seen.events.map((e) => e.ev.event);
    assert.ok(names.includes('relay_launch'), names.join(','));
    assert.ok(names.includes('warn_line'), 'a stderr line in the middle of a stdout line is its own line');
    assert.ok(names.includes('tail_no_newline'), 'the last line without a newline is flushed at close');
    const launch = seen.events.find((e) => e.ev.event === 'relay_launch');
    assert.equal(launch.ev.launcher_pid, 1, 'the line arrived whole');
    assert.ok(launch.at > seen.exitAt, 'it came after the starter had exited');
    assert.equal(seen.closes, 1);
    assert.equal(child.listenerCount('close') >= 1, true);
  });

  it('a spawn error calls onExit(-1) and then onClose', async () => {
    const got = [];
    await new Promise((done) => {
      spawnJob({
        kind: 'test',
        jobId: 'close-2',
        python: join(ROOT, 'no-such-interpreter.exe'),
        script: STARTER,
        onExit: (code) => got.push(['exit', code]),
        onClose: () => {
          got.push(['close']);
          done();
        },
      });
    });
    assert.deepEqual(got, [['exit', -1], ['close']]);
  });

  it('without onClose nothing changes: no close listener, lines flushed at exit', async () => {
    const SIMPLE = join(ROOT, 'simple.cjs');
    writeFileSync(SIMPLE, `process.stdout.write('{"event":"one"}\\n{"event":"last"}');\n`);
    const events = [];
    let child;
    await new Promise((done) => {
      ({ child } = spawnJob({
        kind: 'test',
        jobId: 'close-3',
        python: process.execPath,
        script: SIMPLE,
        onEvent: (ev) => events.push(ev.event),
        onExit: () => setTimeout(done, 50),
      }));
    });
    assert.equal(child.listenerCount('close'), 0);
    assert.deepEqual(events, ['one', 'last']);
  });
});
