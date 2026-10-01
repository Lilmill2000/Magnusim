// A typed event bus for one-off notifications (state belongs in stores). Frozen (scaffold).
// SPDX-License-Identifier: GPL-3.0-or-later

export interface EventBus<E extends object> {
  on<K extends keyof E>(name: K, fn: (payload: E[K]) => void): () => void;
  once<K extends keyof E>(name: K, fn: (payload: E[K]) => void): () => void;
  emit<K extends keyof E>(name: K, payload: E[K]): void;
}

export function createBus<E extends object>(): EventBus<E> {
  const map = new Map<keyof E, Set<(payload: never) => void>>();
  const bus: EventBus<E> = {
    on(name, fn) {
      let set = map.get(name);
      if (!set) map.set(name, (set = new Set()));
      set.add(fn as (payload: never) => void);
      return () => {
        set!.delete(fn as (payload: never) => void);
      };
    },
    once(name, fn) {
      const off = bus.on(name, (p) => {
        off();
        fn(p);
      });
      return off;
    },
    emit(name, payload) {
      const set = map.get(name);
      if (!set) return;
      for (const fn of [...set]) {
        try {
          (fn as (p: E[typeof name]) => void)(payload);
        } catch (err) {
          console.error(`[cad] handler of ${String(name)} failed`, err);
        }
      }
    },
  };
  return bus;
}
