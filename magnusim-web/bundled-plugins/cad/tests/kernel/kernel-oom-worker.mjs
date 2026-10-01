// Gate 9 helper: runs the kernel in a worker thread, so the test can stop it with a
// wall-clock watchdog (as the page does) if an op on a full heap ever hangs.
// Messages: {op, params, bytes?} -> {ok, ...result} | {ok:false, error, kind, oom}.
// Plain JavaScript: worker threads load it without the test's TypeScript transform.
// Owner: KERNEL-HARDENING.
// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parentPort, workerData } from 'node:worker_threads';

const mod = await import(pathToFileURL(join(workerData.dir, 'mk32.mjs')).href);
const M = await mod.default({ wasmBinary: readFileSync(join(workerData.dir, 'mk32.wasm')), print() {}, printErr() {} });
const enc = new TextEncoder();
const dec = new TextDecoder();
const u32 = (x) => x >>> 0;

function call(op, params) {
  const b = enc.encode(JSON.stringify({ op, params }));
  const p = u32(M._mk_alloc(b.length + 1));
  if (!p) return { ok: false, error: 'out of memory (request)', kind: 'internal', oom: true };
  M.HEAPU8.set(b, p);
  M.HEAPU8[p + b.length] = 0;
  const r = u32(M._mk_call(p));
  M._mk_free(p);
  if (!r) return { ok: false, error: 'out of memory (no result)', kind: 'internal', oom: true };
  const h = M.HEAPU8;
  const out = JSON.parse(dec.decode(h.subarray(r, h.indexOf(0, r))));
  M._mk_free(r);
  for (const buf of out.buffers || []) M._mk_free(buf.ptr);
  delete out.buffers;
  return out;
}

parentPort.on('message', (m) => {
  let reply;
  try {
    if (m.op === '__alloc') {
      // mk_alloc straight: a request past MAXIMUM_MEMORY must return 0, not trap.
      const p = u32(M._mk_alloc(m.params.bytes));
      if (p) M._mk_free(p);
      reply = { ok: true, ptr: p };
    } else if (m.op === '__heap') {
      reply = { ok: true, heap_bytes: M.HEAPU8.buffer.byteLength };
    } else {
      const params = { ...m.params };
      if (m.bytes) {
        const u8 = new Uint8Array(m.bytes);
        const p = u32(M._mk_alloc(u8.length));
        if (!p) {
          parentPort.postMessage({ ok: false, error: 'out of memory (input bytes)', kind: 'internal', oom: true });
          return;
        }
        M.HEAPU8.set(u8, p);
        params.ptr = p;
        params.len = u8.length;
      }
      reply = call(m.op, params);
    }
  } catch (e) {
    reply = { ok: false, error: String(e && e.message ? e.message : e), kind: 'trap' };
  }
  parentPort.postMessage(reply);
});
parentPort.postMessage({ ready: true });
