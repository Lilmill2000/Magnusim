// A file lock between processes (builds and e2e runs share workspace/).
// The lock file holds {pid, at, what}; a lock whose process is gone is stale.
// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Wait (bounded) for the lock; returns release(). Throws after `waitMs`. */
export async function acquireLock(file, waitMs, what = process.argv.slice(1).join(' ')) {
  mkdirSync(dirname(file), { recursive: true });
  const until = Date.now() + waitMs;
  let said = false;
  for (;;) {
    try {
      writeFileSync(file, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), what }), { flag: 'wx' });
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let holder = null;
      try {
        holder = JSON.parse(readFileSync(file, 'utf8'));
      } catch {
        /* being written */
      }
      if (holder && holder.pid && !alive(holder.pid)) {
        try {
          unlinkSync(file);
        } catch {
          /* someone else cleared it */
        }
        continue;
      }
      if (Date.now() > until) throw new Error(`${file} is held by pid ${holder?.pid} (${holder?.what}) since ${holder?.at}`);
      if (!said) {
        console.error(`waiting for ${file} (pid ${holder?.pid}: ${holder?.what})`);
        said = true;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      const h = JSON.parse(readFileSync(file, 'utf8'));
      if (h.pid === process.pid) unlinkSync(file);
    } catch {
      /* gone */
    }
  };
  process.once('exit', release);
  return release;
}
