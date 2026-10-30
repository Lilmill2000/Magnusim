// The server's log (desktop/server-log.mjs): what a person reporting a problem finds in
// logs\server.log. Every line has its time and level, nothing in it escaped the redact it was
// given, it moves on to server.1.log and server.2.log at its cap, and a write that cannot be
// done (the folder removed, the disk full) never throws into the server. A file held open for
// a while loses no line: they wait, and go in when it is free. server.mjs keeps its console
// there from the start.
// SPDX-License-Identifier: GPL-3.0-or-later
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_FAILURES, MAX_HELD, MAX_LINE, openServerLog, RETRY_MS, rotatedName } from '../server-log.mjs';
import { removeTreeSync } from '../../scripts/remove-tree.js';

const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..', 'server.mjs');
const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-cad-server-log-'));
after(() => removeTreeSync(ROOT));

/** A fake key, planted where a real one could be: the file must never hold it, nor a piece of it. */
const KEY = `sk-test-${'0123456789abcdef'.repeat(3)}`;
const scrub = (text) => text.split(KEY).join('[redacted]');
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z (info |warn |error|debug) /;

let n = 0;
/** A log folder of its own for each test. */
function place() {
  const dir = join(ROOT, `case-${++n}`, 'logs');
  return { dir, file: join(dir, 'server.log') };
}
const lines = (file) => readFileSync(file, 'utf8').split('\n').filter(Boolean);

describe('openServerLog', () => {
  it('writes each line with its ISO time and level, in a folder it makes at the first write', () => {
    const { dir, file } = place();
    let t = Date.parse('2026-10-29T12:00:00.000Z');
    const log = openServerLog({ file, redact: scrub, now: () => new Date((t += 1000)) });
    assert.equal(existsSync(dir), false, 'nothing is made before a line is written');
    log.write('info', '[assistant] connection test {"provider":"cloud","ok":true}');
    log.write('warn', 'a plugin could not load');
    log.write('error', 'Error: boom\n    at x (file.js:1:1)\r\n    at y (file.js:2:2)\n');
    log.write('debug', 42);
    assert.deepEqual(lines(file), [
      '2026-10-29T12:00:01.000Z info  [assistant] connection test {"provider":"cloud","ok":true}',
      '2026-10-29T12:00:02.000Z warn  a plugin could not load',
      // A stack: every line of it carries the time, so each is found by its time.
      '2026-10-29T12:00:03.000Z error Error: boom',
      '2026-10-29T12:00:03.000Z error     at x (file.js:1:1)',
      '2026-10-29T12:00:03.000Z error     at y (file.js:2:2)',
      '2026-10-29T12:00:04.000Z debug 42',
    ]);
  });

  it('passes every line through redact, and never keeps a key, whole or cut, even on the cap', () => {
    const { file } = place();
    const seen = [];
    const log = openServerLog({ file, redact: (t) => (seen.push(t), scrub(t)) });
    log.write('error', `provider said 401 for ${KEY}`);
    log.write('info', `{"key":"${KEY}"}\nand on the next line ${KEY}`);
    // A key right where a long line is cut: redact sees it whole, before the cut.
    log.write('info', `${'x'.repeat(MAX_LINE - 5)}${KEY}`);
    log.write('info', `${'y'.repeat(MAX_LINE * 20)}${KEY}`);
    assert.equal(seen.length, 4, 'one redact for each line');
    const text = readFileSync(file, 'utf8');
    assert.ok(!text.includes(KEY), 'the key');
    assert.ok(!text.includes('sk-te'), 'no piece of it either');
    assert.match(text, /provider said 401 for \[redacted\]/);
    for (const l of lines(file)) assert.match(l, TIME);
  });

  it('never writes a line its redact could not scrub', () => {
    const { file } = place();
    const log = openServerLog({ file, redact: (t) => {
      if (t.includes(KEY)) throw new Error('no');
      return t;
    } });
    log.write('info', `a line with ${KEY}`);
    log.write('info', 'a plain line');
    assert.deepEqual(lines(file).map((l) => l.replace(TIME, '')), ['a plain line']);
  });

  it('cuts a line at about 4000 characters, and says so', () => {
    const { file } = place();
    const log = openServerLog({ file, redact: scrub });
    log.write('info', 'z'.repeat(50_000));
    const [line] = lines(file);
    assert.ok(line.length < MAX_LINE + 100, String(line.length));
    assert.ok(line.endsWith(`… (cut at ${MAX_LINE} characters)`));
    assert.equal(MAX_LINE, 4000);
  });

  it('moves on at its cap: exactly 3 files, the newest lines in server.log, none over the cap', () => {
    const { dir, file } = place();
    const maxBytes = 2000;
    const log = openServerLog({ file, redact: scrub, maxBytes });
    for (let i = 1; i <= 200; i++) log.write('info', `line ${String(i).padStart(4, '0')} ${'.'.repeat(40)}`);
    assert.deepEqual(readdirSync(dir).sort(), ['server.1.log', 'server.2.log', 'server.log']);
    assert.equal(rotatedName(file, 2), join(dir, 'server.2.log'));
    const number = (l) => Number(/line (\d+)/.exec(l)[1]);
    const [two, one, now] = ['server.2.log', 'server.1.log', 'server.log'].map((f) => lines(join(dir, f)).map(number));
    assert.equal(now.at(-1), 200, 'the last line written is the last in server.log');
    // Oldest to newest, with no line lost between the files.
    assert.deepEqual([...two, ...one, ...now], Array.from({ length: two.length + one.length + now.length }, (_, k) => 200 - now.length - one.length - two.length + 1 + k));
    for (const f of readdirSync(dir)) assert.ok(statSync(join(dir, f)).size <= maxBytes, `${f}: ${statSync(join(dir, f)).size}`);
  });

  it('counts a server.log an earlier run left, and moves it on when it is full', () => {
    const { dir, file } = place();
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, `${'2026-10-28T00:00:00.000Z info  an earlier run\n'.repeat(40)}`);
    const before = statSync(file).size;
    const log = openServerLog({ file, redact: scrub, maxBytes: before + 10 });
    log.write('info', 'this run');
    assert.equal(lines(file).length, 1);
    assert.match(lines(file)[0], /this run$/);
    assert.equal(statSync(join(dir, 'server.1.log')).size, before);
  });

  it('never throws when its folder is removed; it makes logs\\ again only where its parent still is', () => {
    const { dir, file } = place();
    const log = openServerLog({ file, redact: scrub });
    log.write('info', 'before');
    // The logs folder alone removed (a person clearing it): made again, and the line kept.
    removeTreeSync(dir);
    assert.doesNotThrow(() => log.write('info', 'after the logs folder went'));
    assert.deepEqual(lines(file).map((l) => l.replace(TIME, '')), ['after the logs folder went']);
    // The whole user data folder removed: no throw, and nothing brings it back.
    const userData = join(dir, '..');
    removeTreeSync(userData);
    assert.doesNotThrow(() => {
      for (let i = 0; i < 10; i++) log.write('error', `line ${i}`);
    });
    assert.equal(existsSync(userData), false);
  });

  it("with the Assistant's redact (server.mjs's): a key the server registered, or one shaped like a key, never reaches the file", async () => {
    const { redact, registerSecretForRedaction } = await import('../../scripts/server/assistant/redact.ts');
    const { file } = place();
    // A local server's key has no shape to know it by: only its registration hides it.
    const local = `local-model-key-${process.pid}-${Date.now()}`;
    registerSecretForRedaction(local);
    const log = openServerLog({ file, redact });
    log.write('error', `[assistant] provider error {"status":401,"said":"bad key ${local}"}`);
    log.write('error', `Authorization: Bearer ${'t0k3n'.repeat(5)} for sk-ant-api03-${'a'.repeat(30)}`);
    const text = readFileSync(file, 'utf8');
    assert.ok(!text.includes(local));
    assert.doesNotMatch(text, /sk-ant-api03|t0k3nt0k3n/);
    assert.match(text, /bad key \[redacted\]/);
  });

  it('stops for good, at once, when the user data folder is gone, and a closed log writes nothing', () => {
    const { dir, file } = place();
    let calls = 0;
    const log = openServerLog({ file, redact: (t) => (calls++, t) });
    log.write('info', 'one');
    removeTreeSync(join(dir, '..'));
    for (let i = 0; i < MAX_FAILURES + 5; i++) log.write('info', `lost ${i}`);
    assert.equal(calls, 2, 'after that failure, a line is not even looked at');
    // Folder back: the stopped log stays stopped.
    mkdirSync(dir, { recursive: true });
    log.write('error', 'still stopped');
    log.close();
    assert.equal(existsSync(file), false);

    const other = place();
    const open = openServerLog({ file: other.file, redact: scrub });
    open.write('info', 'kept');
    open.close();
    open.write('info', 'not kept');
    assert.deepEqual(lines(other.file).map((l) => l.replace(TIME, '')), ['kept']);
  });

  /** A clock the test moves on: `at` ms past 2026-10-29 12:00. */
  function clock() {
    const c = { at: 0, now: () => new Date(Date.parse('2026-10-29T12:00:00.000Z') + c.at) };
    return c;
  }
  /** server.log made a folder: no write goes in until it is a file again (as a held file). */
  function block(file) {
    removeTreeSync(file);
    mkdirSync(file, { recursive: true });
  }

  it('a file it cannot write for a while loses nothing: the lines wait, it rests after a few failures, then tries again', () => {
    const { file } = place();
    const c = clock();
    const log = openServerLog({ file, redact: scrub, now: c.now });
    log.write('info', 'before');
    block(file);
    for (let i = 1; i <= MAX_FAILURES; i++) {
      c.at += 100;
      log.write('info', `held ${i}`);
    }
    // Resting now: the file is free again, but the log does not try before RETRY_MS has passed.
    removeTreeSync(file);
    c.at += 1000;
    log.write('info', 'while it rests');
    assert.equal(existsSync(file), false, 'not tried while it rests');
    c.at += RETRY_MS;
    log.write('info', 'after the rest');
    const kept = lines(file);
    assert.deepEqual(kept.map((l) => l.replace(TIME, '')), ['held 1', 'held 2', 'held 3', 'while it rests', 'after the rest']);
    // Each with the time it was written, not the time it went in.
    assert.match(kept[0], /^2026-10-29T12:00:00\.100Z info  held 1$/);
    assert.match(kept[3], /^2026-10-29T12:00:01\.300Z info  while it rests$/);
    // And on as before: one try for each line.
    log.write('info', 'next');
    assert.equal(lines(file).at(-1).replace(TIME, ''), 'next');
  });

  it('a lasting failure never throws, an error line (a crash) is tried at once even while it rests, and close() makes a last try', () => {
    const { file } = place();
    const c = clock();
    const log = openServerLog({ file, redact: scrub, now: c.now });
    block(file);
    for (let i = 0; i < 50; i++) {
      c.at += 500;
      assert.doesNotThrow(() => log.write('info', `line ${i}`));
    }
    removeTreeSync(file);
    c.at += 100;
    log.write('error', 'uncaught exception; the server stops: Error: boom');
    const kept = lines(file).map((l) => l.replace(TIME, ''));
    assert.equal(kept.length, 51, 'every line that waited, then the crash');
    assert.equal(kept.at(-1), 'uncaught exception; the server stops: Error: boom');

    // close(): a line that waits during a rest still goes in.
    block(file);
    for (let i = 0; i < MAX_FAILURES; i++) log.write('info', `fails ${i}`);
    removeTreeSync(file);
    log.write('info', 'server exited (0)');
    assert.equal(existsSync(file), false, 'resting');
    log.close();
    assert.deepEqual(lines(file).map((l) => l.replace(TIME, '')), ['fails 0', 'fails 1', 'fails 2', 'server exited (0)']);
  });

  it(`keeps at most ${MAX_HELD} bytes waiting: the oldest go, and the log says how many`, () => {
    const { file } = place();
    const c = clock();
    const log = openServerLog({ file, redact: scrub, now: c.now });
    block(file);
    const total = 8000;
    for (let i = 1; i <= total; i++) log.write('info', `line ${String(i).padStart(5, '0')} ${'.'.repeat(40)}`);
    removeTreeSync(file);
    c.at += RETRY_MS;
    log.write('info', 'free again');
    const kept = lines(file).map((l) => l.replace(TIME, ''));
    const [note] = kept;
    const lost = Number(/^(\d+) earlier lines of this log were lost: the file could not be written \(EISDIR\)$/.exec(note)?.[1]);
    assert.ok(lost > 0, note);
    assert.equal(kept.length - 2, total - lost, 'the rest kept');
    assert.equal(kept.at(-2).slice(0, 10), `line ${String(total).padStart(5, '0')}`, 'the newest kept');
    assert.equal(kept.at(-1), 'free again');
    assert.ok(statSync(file).size < MAX_HELD + 1000);
  });

  it('a file another program holds open without write sharing (a viewer, a scan): the lines after it lets go are kept', { skip: process.platform !== 'win32' && 'Windows sharing modes' }, async () => {
    const { file } = place();
    const c = clock();
    const log = openServerLog({ file, redact: scrub, now: c.now });
    log.write('info', 'before lock');
    // Opened for reading, sharing reading only: as Excel, or a scanner, holds a file.
    const holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "$f = [IO.File]::Open($env:LOCK_FILE, 'Open', 'Read', 'Read'); [Console]::Out.WriteLine('held'); [Console]::Out.Flush(); [void][Console]::In.ReadLine(); $f.Close()"],
    { env: { ...process.env, LOCK_FILE: file }, stdio: ['pipe', 'pipe', 'pipe'] });
    try {
      await new Promise((resolve, reject) => {
        let said = '';
        const t = setTimeout(() => reject(new Error(`the file was not held: ${said}`)), 30_000);
        const hear = (d) => {
          said += String(d);
          if (said.includes('held')) {
            clearTimeout(t);
            resolve();
          }
        };
        holder.stdout.on('data', hear);
        holder.stderr.on('data', hear);
        holder.once('exit', (code) => reject(new Error(`the holder stopped (${code}): ${said}`)));
      });
      for (let i = 1; i <= MAX_FAILURES + 2; i++) {
        c.at += 100;
        log.write('info', `during lock ${i}`);
      }
      assert.deepEqual(lines(file).map((l) => l.replace(TIME, '')), ['before lock'], 'nothing went in while it was held');
    } finally {
      holder.stdin.end();
      await new Promise((r) => (holder.exitCode !== null || holder.signalCode ? r() : holder.once('exit', r)));
    }
    c.at += RETRY_MS;
    log.write('info', 'after release: the crash a person wanted kept');
    assert.deepEqual(lines(file).map((l) => l.replace(TIME, '')), [
      'before lock',
      ...Array.from({ length: MAX_FAILURES + 2 }, (_, i) => `during lock ${i + 1}`),
      'after release: the crash a person wanted kept',
    ]);
  });
});

describe('the server (desktop/server.mjs) with MAGNUSIM_SERVER_LOG', () => {
  it('keeps its own lines and its console in the log from the start, and the console still says them', async () => {
    const root = join(ROOT, 'server');
    mkdirSync(join(root, 'projects'), { recursive: true });
    const file = join(root, 'user data', 'logs', 'server.log');
    const env = { ...process.env, MAGNUSIM_PROJECTS_ROOT: join(root, 'projects'), MAGNUSIM_LOCAL_JSON: join(root, 'local.json'), MAGNUSIM_ASSISTANT_HOME: join(root, 'assistant'), MAGNUSIM_PYTHON: join(root, 'no-python.exe'), MAGNUSIM_SERVER_LOG: file };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(process.execPath, [SERVER], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let said = '';
    try {
      const port = await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`the server did not start:\n${said}`)), 60_000);
        const hear = (d) => {
          said += String(d);
          const m = / on (\d+)\s*$/m.exec(said);
          if (m) {
            clearTimeout(t);
            resolve(Number(m[1]));
          }
        };
        child.stdout.on('data', hear);
        child.stderr.on('data', hear);
        child.once('exit', (code) => reject(new Error(`the server stopped (${code}):\n${said}`)));
      });
      const kept = lines(file);
      for (const l of kept) assert.match(l, TIME);
      const text = kept.map((l) => l.replace(TIME, ''));
      assert.match(text[0], /^Magnusim CAD server starting \(the API only; pid \d+, Node v\d+/);
      assert.ok(text.includes(`server listening on 127.0.0.1:${port}`), text.join('\n'));
      // Its console.log line: in the log, and on the console as before.
      const consoleLine = `Magnusim CAD server (${SERVER}) on ${port}`;
      assert.ok(text.includes(consoleLine), text.join('\n'));
      assert.ok(said.includes(consoleLine));
    } finally {
      child.kill();
      await new Promise((r) => (child.exitCode !== null || child.signalCode ? r() : child.once('exit', r)));
    }
  });
});
