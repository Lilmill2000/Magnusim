// SPDX-License-Identifier: GPL-3.0-or-later
// Magnusim CAD plugin: sketch solver worker (module imported inside a worker, e.g. by
// ws.spawnWorker's classic blob worker through a dynamic import()). Built to
// workspace/solver/solver-worker.js (scripts/build.mjs WORKERS), next to planegcs.mjs/.wasm.
//
// Protocol (same shape as the kernel worker):
//   worker -> main  {type:"ready", solver:"planegcs", initMs}            (posted first)
//                   {type:"error", error}                                 (the solver could not start)
//   main -> worker  {type:"call", id, op, params}
//                   op: load(sketch) | solve() | dragStart(pointId, opts?) | dragStartEntity(id, grab, opts?)
//                       | dragMove(u, v, opts?) | dragEnd() | setValue(constraintId, value) | analyze()
//                       | values() | stats() | solveOnce(sketch)
//                   params: an array of arguments for op
//   worker -> main  {type:"result", id, ok, result | error}
// Drag moves are coalesced: when several dragMove calls are queued, only the newest is
// solved and the older ones are answered with {superseded:true}.
// solveOnce(sketch) loads, solves and forgets on a second solver instance, so a rebuild's
// re-solve never disturbs the sketch being edited in sketch mode.
import { createSolver } from './solver-api.mjs';

const OPS = new Set(['load', 'solve', 'dragStart', 'dragStartEntity', 'dragMove', 'dragEnd', 'setValue', 'analyze', 'values', 'stats']);
// A variable, not a literal: the bundler leaves the URL to be resolved at run time.
const MODULE = 'planegcs.mjs';
const moduleUrl = new URL(MODULE, import.meta.url).href;

const post = (msg) => self.postMessage(msg);
let solver = null;
let scratch = null;
const queue = [];
let flushing = false;

function solveOnce(sketch) {
  if (!scratch) throw new Error('the solver is not ready');
  scratch.load(sketch);
  return scratch.solve();
}

async function run(msg) {
  const { id, op, params } = msg;
  try {
    const args = Array.isArray(params) ? params : params === undefined ? [] : [params];
    let result;
    if (op === 'solveOnce') {
      if (!scratch) scratch = await createSolver({ moduleUrl });
      result = solveOnce(args[0]);
    } else {
      if (!OPS.has(op)) throw new Error(`unknown op "${op}"`);
      result = solver[op](...args);
    }
    post({ type: 'result', id, ok: true, result });
  } catch (err) {
    post({ type: 'result', id, ok: false, error: String(err && err.message ? err.message : err) });
  }
}

async function flush() {
  while (queue.length) {
    const msg = queue.shift();
    if (msg.op === 'dragMove' && queue.some((m) => m.op === 'dragMove')) {
      // a newer drag target is already waiting: skip this one
      post({ type: 'result', id: msg.id, ok: true, result: { superseded: true } });
      continue;
    }
    await run(msg);
  }
  flushing = false;
}

function schedule() {
  if (flushing || !solver) return;
  flushing = true;
  setTimeout(() => void flush(), 0); // lets queued messages arrive, so stale drag moves can be dropped
}

self.addEventListener('message', (ev) => {
  const msg = ev.data;
  if (!msg || msg.type !== 'call') return;
  queue.push(msg);
  schedule(); // waits for the module while it loads
});

try {
  const t0 = performance.now();
  solver = await createSolver({ moduleUrl });
  post({ type: 'ready', solver: 'planegcs', initMs: performance.now() - t0 });
  schedule();
} catch (err) {
  post({ type: 'error', error: String(err && err.message ? err.message : err) });
}
