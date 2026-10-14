// @ts-check
/**
 * Remove a file or folder tree, retrying while Windows says it is in use.
 *
 * A reader can hold a file for a moment: the worker loading a run's result fields
 * (the Run panel of a finished run loads them), the indexer, antivirus. Windows then
 * refuses to delete that file, and the folder holding it. Node's rmSync takes
 * maxRetries/retryDelay but no longer honours them (Node 24 fails at the first EPERM,
 * leaving the tree half removed), so the retries live here. Same back-off as Node's:
 * retry n waits n * retryDelay ms.
 */
import { rmSync } from 'node:fs';
import { rm } from 'node:fs/promises';

/** The errors a file someone holds open gives on Windows. */
const LOCK_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY', 'EMFILE', 'ENFILE']);
const sleepCell = new Int32Array(new SharedArrayBuffer(4));

/**
 * @typedef {{ maxRetries?: number, retryDelay?: number }} RemoveTreeOptions
 */

/** @param {unknown} err */
function isLock(err) {
  return LOCK_CODES.has(String((err && /** @type {{ code?: unknown }} */ (err).code) || ''));
}

/**
 * Remove `path` (a missing one is fine). Blocks while it waits.
 * @param {string} path
 * @param {RemoveTreeOptions} [opts]
 */
export function removeTreeSync(path, { maxRetries = 10, retryDelay = 100 } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (err) {
      if (!isLock(err) || attempt >= maxRetries) throw err;
      Atomics.wait(sleepCell, 0, 0, retryDelay * (attempt + 1));
    }
  }
}

/**
 * Remove `path` (a missing one is fine) without blocking the server while it waits.
 * @param {string} path
 * @param {RemoveTreeOptions} [opts]
 */
export async function removeTree(path, { maxRetries = 10, retryDelay = 100 } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (err) {
      if (!isLock(err) || attempt >= maxRetries) throw err;
      await new Promise((resolve) => setTimeout(resolve, retryDelay * (attempt + 1)));
    }
  }
}
