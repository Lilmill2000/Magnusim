// Handles (CAD tools spec §5.5): short names (#f3 a face, #e7 an edge, #v2 a vertex, #b1 a body)
// that find, get_model and view hand out for the rest of one request. The table belongs to the
// call's key (the turn, or the outside session) and starts again when the key changes; it holds at
// most 2000 handles (the oldest go first). A handle keeps the stored reference a pick in the view
// would make (never an index): each use resolves it again on the bodies the selector reads, so a
// rebuild in between is followed by name, a moved face says so, and a face that is gone answers
// selector_stale. The same face listed twice keeps its handle.
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { AppServices } from '../../types/app';
import type { BodyId, PersistentRef } from '../../types/doc';

export type HandleKind = 'face' | 'edge' | 'vertex' | 'body';

/** The most handles a key keeps. */
export const HANDLES_MAX = 2000;

const LETTER: Record<HandleKind, string> = { face: 'f', edge: 'e', vertex: 'v', body: 'b' };

export interface HandleEntry {
  kind: HandleKind;
  body: BodyId;
  /** The body's name when it was listed (said when the body is gone). */
  bodyName: string;
  /** The stored reference of a face, edge or vertex (null for a body). */
  ref: PersistentRef | null;
  /** Its label when it had one, and its words, as find listed it. */
  label: string | null;
  words: string;
}

export interface HandleTable {
  readonly key: string;
  /** The handle of this face, edge, vertex or body (the one it already has, or the next of its kind). */
  give(entry: HandleEntry): string;
  /** What a handle was given for, or null (never given under this key, or dropped as the oldest). */
  get(handle: string): HandleEntry | null;
  readonly size: number;
}

/**
 * The same thing twice: one handle. A face's or a vertex's name is its own on its body (a rebuild
 * that moves it keeps its handle); two edges between the same two faces share a name and differ by
 * where they are.
 */
function identity(e: HandleEntry): string {
  if (!e.ref) return `${e.kind}:${e.body}`;
  if (e.kind !== 'edge') return `${e.kind}:${e.body}:${e.ref.name}`;
  const at = e.ref.signature.at.map((v) => Math.round(v * 1e4) / 1e4).join(',');
  return `${e.kind}:${e.body}:${e.ref.name}:${at}`;
}

function createTable(key: string): HandleTable {
  const byHandle = new Map<string, HandleEntry>();
  const byIdentity = new Map<string, string>();
  const next: Record<HandleKind, number> = { face: 1, edge: 1, vertex: 1, body: 1 };
  return {
    key,
    give(entry) {
      const id = identity(entry);
      const had = byIdentity.get(id);
      if (had && byHandle.has(had)) {
        // Listed again: its reference as it is now, newest last (the oldest go first).
        byHandle.delete(had);
        byHandle.set(had, entry);
        return had;
      }
      const handle = `#${LETTER[entry.kind]}${next[entry.kind]++}`;
      byHandle.set(handle, entry);
      byIdentity.set(id, handle);
      while (byHandle.size > HANDLES_MAX) {
        const oldest = byHandle.keys().next().value as string;
        const e = byHandle.get(oldest)!;
        byHandle.delete(oldest);
        byIdentity.delete(identity(e));
      }
      return handle;
    },
    get(handle) {
      return byHandle.get(handle.trim().toLowerCase()) ?? null;
    },
    get size() {
      return byHandle.size;
    },
  };
}

const tables = new WeakMap<AppServices, HandleTable>();

/** The handle table of `key` in this page: the current one, or a new one when the key changed. */
export function handlesOf(services: AppServices, key: string): HandleTable {
  let t = tables.get(services);
  if (!t || t.key !== key) {
    t = createTable(key);
    tables.set(services, t);
  }
  return t;
}

/** The table of `key` if it is the current one (reading never starts a new table). */
export function currentHandles(services: AppServices, key: string): HandleTable | null {
  const t = tables.get(services);
  return t && t.key === key ? t : null;
}
