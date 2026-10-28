// A 2D canvas context that writes down what is drawn: each call with its arguments and each
// property set, in order (no canvas draws in the unit tests). The log is what a test compares.
// SPDX-License-Identifier: GPL-3.0-or-later

const names = new WeakMap<object, string>();

/** Names an object (a canvas drawn from) in the logs. */
export function nameFor<T extends object>(o: T, name: string): T {
  names.set(o, name);
  return o;
}

function fmt(v: unknown): string {
  if (typeof v === 'number' || typeof v === 'boolean' || v === undefined || v === null) return String(v);
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(fmt).join(', ')}]`;
  if (typeof v === 'object') return names.get(v) ?? `<${(v as object).constructor?.name ?? 'object'}>`;
  return typeof v;
}

/** A context for `canvas` that appends to `log` (each line after `prefix`). */
export function recordingContext(log: string[], canvas: { width: number; height: number }, prefix = ''): CanvasRenderingContext2D {
  const state: Record<string, unknown> = {
    fillStyle: '#000000',
    strokeStyle: '#000000',
    lineWidth: 1,
    globalAlpha: 1,
    font: '10px sans-serif',
    textAlign: 'start',
    textBaseline: 'alphabetic',
  };
  const calls = new Map<string, (...args: unknown[]) => unknown>();
  return new Proxy({} as Record<string, unknown>, {
    get(_, k) {
      if (typeof k !== 'string' || k === 'then') return undefined;
      if (k === 'canvas') return canvas;
      if (k in state) return state[k];
      let fn = calls.get(k);
      if (!fn) {
        fn = (...args: unknown[]) => {
          log.push(`${prefix}${k}(${args.map(fmt).join(', ')})`);
          return k === 'measureText' ? { width: 6 * String(args[0]).length } : undefined;
        };
        calls.set(k, fn);
      }
      return fn;
    },
    set(_, k, v) {
      if (typeof k === 'string') {
        state[k] = v;
        log.push(`${prefix}${k} = ${fmt(v)}`);
      }
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}
