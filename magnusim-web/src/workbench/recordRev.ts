/**
 * A record's rev on the page (Assistant phase 5, C2; the server's scripts/record-rev.js).
 *
 * Every record the Assistant can write comes from the server with an integer `rev`. A panel's
 * save sends the rev its record was loaded with as `base_rev`; the server refuses it (409
 * `stale_record`) when the record changed since, and the page then reloads the record and says
 * so (staleNotice.ts). A record with no rev (an older server, a record not saved yet) sends
 * none and is saved as before.
 *
 * Saves of one record run one at a time (serialSave), and each reads the rev when it is sent:
 * a second quick save sends the rev the first one's answer stored, not the one both started
 * from, so a person's own two quick edits never refuse each other.
 */

/** The record's rev as the server sent it, or null when it has none. */
export function revOf(rec: unknown): number | null {
  const n = rec && typeof rec === 'object' ? (rec as { rev?: unknown }).rev : undefined;
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 ? n : null;
}

/** `body` with the record's rev as `base_rev` (unchanged when the record has none). */
export function withBaseRev<T extends Record<string, unknown>>(body: T, rec?: unknown): T {
  const rev = revOf(rec === undefined ? body : rec);
  const out = { ...body } as Record<string, unknown>;
  delete out.rev;
  if (rev !== null) out.base_rev = rev;
  return out as T;
}

/** Whether an answer (its JSON, or the error a worker call threw) is a stale-record refusal. */
export function isStaleRecord(x: unknown): boolean {
  return !!x && typeof x === 'object' && (x as { code?: unknown }).code === 'stale_record';
}

const chains = new Map<string, Promise<unknown>>();

/**
 * Runs `fn` after the saves of `key` queued before it (each settles, ok or not). The chain is
 * dropped once it is idle.
 */
export function serialSave<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const before = chains.get(key) ?? Promise.resolve();
  const next = before.then(fn, fn);
  const settled = next.then(
    () => undefined,
    () => undefined,
  );
  chains.set(key, settled);
  void settled.then(() => {
    if (chains.get(key) === settled) chains.delete(key);
  });
  return next;
}
