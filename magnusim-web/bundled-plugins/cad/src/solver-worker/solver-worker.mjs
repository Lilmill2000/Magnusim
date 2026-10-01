// SPDX-License-Identifier: GPL-3.0-or-later
// Magnusim CAD plugin: sketch solver worker (module imported inside a worker, e.g. by
// ws.spawnWorker's classic blob worker through a dynamic import()).
//
// Protocol (same shape as the kernel worker):
//   worker -> main  {type:"ready", solver:"planegcs", initMs}            (posted first)
//   main -> worker  {type:"call", id, op, params}
//                   op: load(sketch) | solve() | dragStart(pointId, opts?) | dragMove(u, v, opts?)
//                       | dragEnd() | setValue(constraintId, value) | analyze() | values() | stats()
//                   params: an array of arguments for op
//   worker -> main  {type:"result", id, ok, result | error}
// Drag moves are coalesced: when several dragMove calls are queued, only the newest is
// solved and the older ones are answered with {superseded:true}.
import { createSolver } from './solver-api.mjs';

const OPS = new Set(['load', 'solve', 'dragStart', 'dragMove', 'dragEnd', 'setValue', 'analyze', 'values', 'stats']);

const post = (msg) => self.postMessage(msg);
let solver = null;
const queue = [];
let flushing = false;

function run(msg) {
  const { id, op, params } = msg;
  try {
    if (!OPS.has(op)) throw new Error(`unknown op "${op}"`);
    const result = solver[op](...(Array.isArray(params) ? params : params === undefined ? [] : [params]));
    post({ type: 'result', id, ok: true, result });
  } catch (err) {
    post({ type: 'result', id, ok: false, error: String(err && err.message ? err.message : err) });
  }
}

function flush() {
  flushing = false;
  while (queue.length) {
    const msg = queue.shift();
    if (msg.op === 'dragMove' && queue.some((m) => m.op === 'dragMove')) {
      // a newer drag target is already waiting: skip this one
      post({ type: 'result', id: msg.id, ok: true, result: { superseded: true } });
      continue;
    }
    run(msg);
  }
}

self.addEventListener('message', (ev) => {
  const msg = ev.data;
  if (!msg || msg.type !== 'call') return;
  queue.push(msg);
  if (!solver) return; // flushed once the module is ready
  if (!flushing) {
    flushing = true;
    setTimeout(flush, 0); // lets queued messages arrive, so stale drag moves can be dropped
  }
});

try {
  const t0 = performance.now();
  solver = await createSolver({ moduleUrl: new URL('./planegcs.mjs', import.meta.url).href });
  post({ type: 'ready', solver: 'planegcs', initMs: performance.now() - t0 });
  if (queue.length && !flushing) {
    flushing = true;
    setTimeout(flush, 0);
  }
} catch (err) {
  post({ type: 'error', error: String(err && err.message ? err.message : err) });
}
