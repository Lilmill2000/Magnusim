// A tiny observable state container and its React hook. Frozen (scaffold).
// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useRef, useSyncExternalStore } from 'react';
import type { Listener, ReadonlyStateStore, StateStore } from '../types/state';

function shallowSame<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  }
  return true;
}

export function createStateStore<T extends object>(initial: T): StateStore<T> {
  let state = initial;
  const listeners = new Set<Listener<T>>();
  return {
    get: () => state,
    set(next) {
      const prev = state;
      const candidate = typeof next === 'function' ? (next as (p: T) => T)(prev) : ({ ...prev, ...next } as T);
      if (shallowSame(prev, candidate)) return;
      state = candidate;
      for (const fn of [...listeners]) {
        try {
          fn(state, prev);
        } catch (err) {
          // One bad listener must not stop the others.
          console.error('[cad] state listener failed', err);
        }
      }
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}

/**
 * React hook: the selected slice of a store; re-renders only when the slice
 * changes (shallow compare, so selecting a small object is fine).
 */
export function useStateStore<T, S = T>(store: ReadonlyStateStore<T>, selector?: (s: T) => S): S {
  const selRef = useRef(selector);
  selRef.current = selector;
  const last = useRef<{ src: T; sel: unknown; out: S } | null>(null);
  // The selector is usually a new inline arrow each render: read it from a ref,
  // and return the cached slice while it is shallow-equal (a stable snapshot).
  const getSnapshot = useCallback(() => {
    const src = store.get();
    const sel = selRef.current;
    const cached = last.current;
    if (cached && Object.is(cached.src, src) && cached.sel === sel) return cached.out;
    const out = sel ? sel(src) : (src as unknown as S);
    if (cached && shallowSame(cached.out, out)) {
      last.current = { src, sel, out: cached.out };
      return cached.out;
    }
    last.current = { src, sel, out };
    return out;
  }, [store]);
  const subscribe = useCallback((cb: () => void) => store.subscribe(() => cb()), [store]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
