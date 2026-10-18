// The handles the view tool hands out (CAD tools spec §5.5, §9.2): "#f3" for a face, "#b1" for a
// body, numbered per kind in order of first listing, one table per call key (the turn, or the
// outside session), cleared when the key changes, at most HANDLES_MAX entries. Each handle keeps
// what it names as {kind, body, ref, label}, never an index, so it can be resolved again after
// a rebuild. A listing of something already in the table gives its handle again.
// This is the view tool's own small table: find and the selectors (selectors/handles.ts, with
// their resolution of a handle) share one table with it once they are in the build.
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { AppServices } from '../types/app';
import type { BodyId, PersistentRef } from '../types/doc';

/** The most handles one key's table keeps (a listing past it hands out no new handle). */
export const HANDLES_MAX = 2000;

export type HandleKind = 'face' | 'edge' | 'vertex' | 'body';

/** What a handle names: a face, edge or vertex by its stored reference on a body, or a body. */
export interface HandleEntry {
  kind: HandleKind;
  body: BodyId;
  /** The stored reference (faces, edges, vertices); null for a body. */
  ref: PersistentRef | null;
  /** Its label in the selector language (Base.end), when there is one. */
  label: string | null;
}

export interface HandleTable {
  readonly key: string;
  /** The handle of `entry`: the one it already has, or the next of its kind; null when the table is full. */
  add(entry: HandleEntry): string | null;
  get(handle: string): HandleEntry | null;
  readonly size: number;
}

const PREFIX: Record<HandleKind, string> = { face: 'f', edge: 'e', vertex: 'v', body: 'b' };

const identity = (e: HandleEntry) => `${e.kind}|${e.body}|${e.ref?.name ?? ''}`;

function createTable(key: string): HandleTable {
  const byHandle = new Map<string, HandleEntry>();
  const byIdentity = new Map<string, string>();
  const next: Record<HandleKind, number> = { face: 0, edge: 0, vertex: 0, body: 0 };
  return {
    key,
    add(entry) {
      const id = identity(entry);
      const had = byIdentity.get(id);
      if (had) return had;
      if (byHandle.size >= HANDLES_MAX) return null;
      const handle = `#${PREFIX[entry.kind]}${++next[entry.kind]}`;
      byHandle.set(handle, { ...entry });
      byIdentity.set(id, handle);
      return handle;
    },
    get: (handle) => byHandle.get(handle.trim().toLowerCase()) ?? null,
    get size() {
      return byHandle.size;
    },
  };
}

const tables = new WeakMap<AppServices, HandleTable>();

/** The handle table of `key` in this page (a new, empty one when the key changed). */
export function handlesFor(services: AppServices, key: string): HandleTable {
  let t = tables.get(services);
  if (!t || t.key !== key) {
    t = createTable(key);
    tables.set(services, t);
  }
  return t;
}
