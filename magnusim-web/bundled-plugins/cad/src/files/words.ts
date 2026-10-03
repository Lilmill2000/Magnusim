// Plain words for what can go wrong moving files in and out of the Part:
// the host's refusal codes for ws.files (host API 1.2), and the size rule the
// manifest sets ([files] max_file_mb = 512).
// Owner: P2-FEATURES.
// SPDX-License-Identifier: GPL-3.0-or-later
import { MAX_FILE_BYTES } from '../types/files';

/** "29.2 KB", "1.3 MB", "600 MB" (base 1024, as the size rule is written). */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const digits = v >= 100 ? 0 : 1;
  return `${Number(v.toFixed(digits))} ${units[i]}`;
}

/** The size rule, said before anything uploads: null when the file fits. */
export function sizeProblem(bytes: number, what = 'STEP'): string | null {
  if (bytes <= MAX_FILE_BYTES) return null;
  return `This ${what} is ${formatBytes(bytes)}. Parts can store files up to ${formatBytes(MAX_FILE_BYTES)}.`;
}

/** The host's ws.files refusal codes, in words (after "Not stored: "). */
const CODES: Record<string, string> = {
  too_large: `the file is larger than a Part can store (${formatBytes(MAX_FILE_BYTES)})`,
  quota: "the project's CAD files are at their 4096 MB limit",
  disk_full: 'the disk is full',
  plugin_off: 'Magnusim CAD was turned off',
  busy: 'Magnusim is busy; try again',
  invalid_path: 'the file name is not allowed',
  not_allowed: "this Magnusim cannot store CAD files (it needs host API 1.2)",
  study_not_found: 'this Part was deleted',
  not_found: 'the file is not there',
  changed: 'the file changed while it was written',
};

export function plainFileReason(err: unknown): string {
  const code = err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code ?? '') : '';
  if (code && CODES[code]) return CODES[code];
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return msg.replace(/^Error:\s*/, '') || 'the host refused it';
}

/** True for the error an aborted transfer rejects with. */
export function isAbort(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: unknown; code?: unknown };
  return e.name === 'AbortError' || e.code === 'aborted' || e.code === 'abort';
}

export function abortError(): Error {
  const e = new Error('Stopped');
  e.name = 'AbortError';
  return e;
}
