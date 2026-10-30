// The server's log, for a problem report: server.mjs sends the server's console lines and what
// ended it here (MAGNUSIM_SERVER_LOG, config.mjs serverEnv). A line is its time, its level and
// its text, scrubbed by the redact it is given (the Assistant's: every key the server holds and
// anything shaped like one), and capped. Past maxBytes the file moves along: server.log becomes
// server.1.log, that one server.2.log (`keep` files in all, the oldest goes). Appends are
// synchronous (the server logs little, and the line about a crash must be on disk before the
// process ends). A write that fails never reaches the caller. Its line waits in memory and goes
// in at the next write that works: a file held open for a moment (a viewer, a virus scan) loses
// nothing. After a few failures in a row the log rests a few seconds before it tries again (an
// error line tries at once). Only a removed user data folder stops it for good.
// The log stays on this PC: nothing here sends it anywhere.
// SPDX-License-Identifier: GPL-3.0-or-later
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';

/** The longest text a line keeps, in characters (a longer one is cut, and says so). */
export const MAX_LINE = 4000;
/** Text past this is dropped before redact sees it (a key cut here is past MAX_LINE anyway). */
const MAX_INPUT = 64 * 1024;
/** Failed writes in a row before the log rests (RETRY_MS). */
export const MAX_FAILURES = 3;
/** How long the log rests after MAX_FAILURES, in ms; the lines meanwhile wait in memory. */
export const RETRY_MS = 5000;
/** The most that waits in memory, in bytes; past it the oldest lines go (and the log says so). */
export const MAX_HELD = 256 * 1024;

/** server.log's n-th older copy: server.1.log, server.2.log, ... (0: the file itself). */
export function rotatedName(file, n) {
  if (!n) return file;
  const ext = extname(file);
  return join(dirname(file), `${basename(file, ext)}.${n}${ext}`);
}

/**
 * Open the log at `file` (its folder is made at the first write). Nothing is written until then.
 * @param {{ file: string, redact: (text: string) => string, maxBytes?: number, keep?: number, now?: () => Date }} o
 * @returns {{ write(level: string, text: unknown): void, close(): void }}
 */
export function openServerLog({ file, redact, maxBytes = 5 * 2 ** 20, keep = 3, now = () => new Date() }) {
  const dir = dirname(file);
  /** The file's size as this log knows it; null until a write reads it (again after a failure). */
  let size = null;
  let made = false;
  let failures = 0;
  /** No try before this time (ms), after MAX_FAILURES in a row. */
  let restUntil = 0;
  let stopped = false;
  /** Lines (already scrubbed) not yet in the file, oldest first, and how many went for room. */
  let held = [];
  let heldBytes = 0;
  let lost = 0;
  let lastCode = '';

  /** A line with its time and level on each of its lines (a stack: each is found by its time). */
  function stamp(date, level, body) {
    const head = `${date.toISOString()} ${String(level).padEnd(5)}`;
    return `${body.split('\n').map((l) => (l ? `${head} ${l}` : head)).join('\n')}\n`;
  }

  /** The line as it goes in the file (it throws when it cannot be scrubbed: never kept unscrubbed). */
  function lineOf(date, level, text) {
    let body = typeof text === 'string' ? text : String(text);
    if (body.length > MAX_INPUT) body = body.slice(0, MAX_INPUT);
    // Scrubbed whole before it is cut, so a key on the cut is never left half there.
    body = String(redact(body)).replace(/\r\n?/g, '\n').trimEnd();
    if (body.length > MAX_LINE) body = `${body.slice(0, MAX_LINE)}… (cut at ${MAX_LINE} characters)`;
    return stamp(date, level, body);
  }

  function hold(line) {
    held.push(line);
    heldBytes += Buffer.byteLength(line);
    while (heldBytes > MAX_HELD && held.length > 1) {
      heldBytes -= Buffer.byteLength(held.shift());
      lost += 1;
    }
  }

  /** server.log moves to server.1.log, and so on; the oldest goes. */
  function rotate() {
    if (keep <= 1) {
      rmSync(file, { force: true });
      return;
    }
    for (let n = keep - 1; n >= 1; n--) {
      try {
        renameSync(rotatedName(file, n - 1), rotatedName(file, n));
      } catch (err) {
        if (err?.code !== 'ENOENT') throw err;
      }
    }
  }

  function append(line) {
    try {
      appendFileSync(file, line);
    } catch (err) {
      // The logs folder was removed: made again, but only where its parent still is (a removed
      // user data folder is never brought back by its log).
      if (err?.code !== 'ENOENT') throw err;
      mkdirSync(dir);
      appendFileSync(file, line);
    }
  }

  /** One line into the file, moving the file on first when it would pass the cap; throws. */
  function put(line) {
    const bytes = Buffer.byteLength(line);
    if (!made) {
      made = true;
      mkdirSync(dir, { recursive: true });
    }
    if (size === null) {
      try {
        size = statSync(file).size;
      } catch {
        size = 0;
      }
    }
    if (size > 0 && size + bytes > maxBytes) {
      try {
        rotate();
      } catch {
        // Held open elsewhere (Windows): this file goes on, and it is tried again a cap later.
      }
      size = 0;
    }
    append(line);
    size += bytes;
  }

  /** Every waiting line into the file, oldest first; what cannot go in yet waits on. */
  function flush(date) {
    try {
      if (lost) {
        put(stamp(date, 'warn', `${lost} earlier lines of this log were lost: the file could not be written (${lastCode || 'error'})`));
        lost = 0;
      }
      while (held.length) {
        put(held[0]);
        heldBytes -= Buffer.byteLength(held.shift());
      }
      failures = 0;
      restUntil = 0;
    } catch (err) {
      lastCode = err?.code || lastCode;
      if (err?.code === 'ENOENT' && !existsSync(dirname(dir))) {
        // The user data folder is gone (the app removed): nothing will ever be written here.
        stopped = true;
        held = [];
        heldBytes = 0;
        return;
      }
      // A part of a line may have gone in: the size is read again at the next try.
      size = null;
      failures += 1;
      if (failures >= MAX_FAILURES) restUntil = date.getTime() + RETRY_MS;
    }
  }

  return {
    write(level, text) {
      if (stopped) return;
      try {
        const date = now();
        try {
          hold(lineOf(date, level, text));
        } catch {
          return; // its redact failed: the line is not kept
        }
        // Resting: the line waits, but an error (a crash) is tried at once.
        if (date.getTime() < restUntil && level !== 'error') return;
        flush(date);
      } catch {
        /* the log never throws into the server */
      }
    },
    /** What waits goes in now, if it can (resting or not), and the log writes nothing after. */
    close() {
      if (stopped) return;
      try {
        if (held.length || lost) flush(now());
      } catch {
        /* as write */
      }
      stopped = true;
      held = [];
      heldBytes = 0;
    },
  };
}
