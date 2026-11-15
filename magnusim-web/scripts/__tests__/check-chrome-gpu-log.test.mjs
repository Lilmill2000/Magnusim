// scripts/check-chrome-gpu-log.mjs: a browser suite's Chrome log that says the GPU was lost
// fails CI; a clean one passes; no log, or a log with no browser in it, fails too.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readGpuLog } from '../check-chrome-gpu-log.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'check-chrome-gpu-log.mjs');
const LAUNCHED = '2026-11-15T05:41:21.522Z pw:browser <launched> pid=3301';
const NOISE = '2026-11-15T05:41:21.600Z pw:browser [pid=3301][err] [3301:3317:1115/054121.600:ERROR:dbus/bus.cc:406] Failed to connect to the bus';
// As GitHub's runners wrote them (2026-11-14 and 15).
const LOST = [
  '2026-11-15T03:01:12.345Z pw:browser [pid=3195][err] [3230:3230:1115/023616.1:ERROR:gpu/ipc/service/shared_image_stub.cc:221] SharedImageStub: Unable to create shared image',
  '2026-11-15T03:01:12.346Z pw:browser [pid=3195][err] [3195:3195:1115/023616.2:ERROR:...] A valid external Instance reference no longer exists.',
  '2026-11-15T04:40:41.893Z pw:browser [pid=3246][err] [3279:3279:1115/044041.893968:ERROR:gpu/command_buffer/service/shared_image/shared_image_representation.cc:438] Unable to initialize SkSurface',
];

function check(text) {
  const dir = mkdtempSync(join(tmpdir(), 'magnusim-gpu-log-'));
  try {
    const file = join(dir, 'chrome.log');
    if (text !== null) writeFileSync(file, text);
    return spawnSync(process.execPath, [SCRIPT, file], { encoding: 'utf8' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('Chrome kept its GPU through a browser suite', () => {
  it('a log with browsers launched and no GPU lost passes', () => {
    const r = check([LAUNCHED, NOISE, LAUNCHED].join('\n'));
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /2 browsers launched/);
  });

  it('each line saying the GPU was lost fails it, and is shown', () => {
    for (const line of LOST) {
      const r = check([LAUNCHED, NOISE, line].join('\n'));
      assert.equal(r.status, 1, line);
      assert.match(r.stderr, /Chrome lost its GPU \(1 lines\)/);
      assert.ok(r.stderr.includes(line.slice(-40)), r.stderr);
    }
    assert.equal(readGpuLog(LOST.join('\r\n')).lost.length, 3);
  });

  it('no log, or one with no browser launched in it, fails: no log is not a pass', () => {
    const none = check(null);
    assert.equal(none.status, 1);
    assert.match(none.stderr, /was not written/);
    const empty = check(NOISE);
    assert.equal(empty.status, 1);
    assert.match(empty.stderr, /no browser launched/);
  });
});
