/**
 * The Assistant's file writes: async, atomic, private (0600 files in 0700 folders on
 * POSIX; on Windows the per-user %APPDATA% ACL applies).
 *
 * Each write goes to its own temp file `${path}.${pid}.${serial}.tmp`, so two writers
 * never share one, and is renamed over the target. Windows refuses a rename over a file
 * someone has open for a moment (the indexer, antivirus), so the rename is retried 7
 * times, 50·n ms apart (about 1.4 s), without blocking the server.
 */
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const RENAME_LOCK_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const POSIX = process.platform !== 'win32';
let serial = 0;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const codeOf = (err: unknown) => String((err as { code?: unknown } | null)?.code || '');

/** A folder only this account may open (0700 on POSIX; created if missing). */
export async function ensurePrivateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (POSIX) await chmod(dir, 0o700).catch(() => {});
}

export async function writeFileAtomic(path: string, text: string, o: { mode?: number } = {}): Promise<void> {
  const mode = o.mode ?? 0o600;
  await ensurePrivateDir(dirname(path));
  serial = (serial + 1) % 1e9;
  const tmp = `${path}.${process.pid}.${serial}.tmp`;
  try {
    await writeFile(tmp, text, { encoding: 'utf8', mode, flag: 'wx' });
    if (POSIX) await chmod(tmp, mode);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(tmp, path);
      return;
    } catch (err) {
      if (!RENAME_LOCK_CODES.has(codeOf(err)) || attempt >= 7) {
        await unlink(tmp).catch(() => {});
        throw err;
      }
      await sleep(50 * (attempt + 1));
    }
  }
}

export type JsonRead = { state: 'missing' } | { state: 'ok'; value: unknown } | { state: 'bad'; error: string };

/** A JSON file: missing, parsed, or there but unreadable as JSON. Other read errors throw. */
export async function readJsonFile(path: string): Promise<JsonRead> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if (codeOf(err) === 'ENOENT') return { state: 'missing' };
    throw err;
  }
  try {
    return { state: 'ok', value: JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw) };
  } catch (err) {
    return { state: 'bad', error: err instanceof Error ? err.message : String(err) };
  }
}

/** The parsed JSON, or `fallback` when the file is missing or not JSON. */
export async function readJsonOr<T>(path: string, fallback: T): Promise<unknown> {
  const r = await readJsonFile(path);
  return r.state === 'ok' ? r.value : fallback;
}
