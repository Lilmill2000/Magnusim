// A tiny observable state container (zustand-like, no dependency).
// Implementation: src/lib/store.ts (createStateStore, useStateStore). Frozen.
// SPDX-License-Identifier: GPL-3.0-or-later

export type Listener<T> = (state: T, prev: T) => void;

export interface ReadonlyStateStore<T> {
  get(): T;
  /** Called after every change with the new and previous state. Returns unsubscribe. */
  subscribe(fn: Listener<T>): () => void;
}

export interface StateStore<T> extends ReadonlyStateStore<T> {
  /** Shallow-merge a partial (objects) or replace via an updater. No-op if nothing changed (Object.is per key). */
  set(next: Partial<T> | ((prev: T) => T)): void;
}
