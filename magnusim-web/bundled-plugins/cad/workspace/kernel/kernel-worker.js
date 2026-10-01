class w extends Error {
  kind;
  oom;
  detail;
  constructor(s, l = "internal", c = null) {
    super(s), this.name = "KernelError", this.kind = l, this.oom = !!(c && c.oom), this.detail = c;
  }
}
const M = () => typeof performance < "u" ? performance.now() : Date.now(), $ = new TextEncoder(), q = new TextDecoder();
async function x(t) {
  const s = String(t.moduleUrl), l = M(), c = await import(
    /* @vite-ignore */
    s
  ), r = {
    locateFile: (e) => new URL(e, s).href,
    print: t.print ?? (() => {
    }),
    printErr: t.printErr ?? ((e) => console.warn("[kernel]", e))
  };
  t.wasmBinary && (r.wasmBinary = t.wasmBinary);
  const i = await c.default(r), b = M() - l, d = (e) => typeof e == "bigint" ? Number(e) : e >>> 0;
  let f = null;
  const m = () => i.HEAPU8, g = (e) => d(i._mk_alloc(e)), y = (e) => i._mk_free(e);
  function h(e) {
    const o = m();
    let n = o.indexOf(0, e);
    return n < 0 && (n = o.length), q.decode(o.subarray(e, n));
  }
  function u(e, o = {}) {
    if (f) throw new w(`kernel is dead after a trap: ${f}`, "trap");
    const n = $.encode(JSON.stringify({ op: e, params: o }));
    let a = 0, _ = 0;
    try {
      if (a = g(n.length + 1), !a) return { ok: !1, error: "out of memory (request buffer)", kind: "internal", oom: !0 };
      const p = m();
      p.set(n, a), p[a + n.length] = 0, _ = d(i._mk_call(a));
    } catch (p) {
      throw f = String(p instanceof Error ? p.message : p), new w(`kernel trapped in ${e}: ${f}`, "trap");
    } finally {
      a && !f && y(a);
    }
    if (!_) return { ok: !1, error: "out of memory (no result)", kind: "internal", oom: !0 };
    const A = h(_);
    return y(_), JSON.parse(A);
  }
  function U(e, o = {}) {
    const n = u(e, o);
    if (!n.ok) throw new w(n.error ?? "failed", n.kind ?? "internal", n);
    return n;
  }
  function S(e) {
    const o = g(e.length);
    if (!o) throw new w(`out of memory (cannot place ${e.length} bytes)`, "internal", { oom: !0 });
    return m().set(e, o), { ptr: o, len: e.length };
  }
  function O(e) {
    const o = {};
    for (const n of e.buffers ?? []) {
      const a = m().slice(n.ptr, n.ptr + n.len);
      y(n.ptr), n.type === "f32" ? o[n.name] = new Float32Array(a.buffer, 0, a.byteLength / 4) : n.type === "u32" ? o[n.name] = new Uint32Array(a.buffer, 0, a.byteLength / 4) : o[n.name] = a;
    }
    return e.buffers = [], o;
  }
  return {
    variant: "wasm32",
    version: U("version"),
    initMs: b,
    module: i,
    tryCall: u,
    call: U,
    putBytes: S,
    takeBuffers: O,
    heapBytes: () => m().buffer.byteLength,
    get dead() {
      return f;
    }
  };
}
const C = performance.now(), E = [];
let k = null;
function B() {
  try {
    return k ? k.heapBytes() : 0;
  } catch {
    return 0;
  }
}
function v(t, s, l) {
  const c = { type: "result", id: t, ok: !1, error: l, ms: performance.now() - s, heap_bytes: B() };
  self.postMessage(c);
}
function L(t) {
  const s = performance.now(), l = k, c = { ...t.params || {} };
  try {
    if (t.bytes) {
      const { ptr: h, len: u } = l.putBytes(new Uint8Array(t.bytes));
      c.ptr = h, c.len = u;
    }
    const r = l.tryCall(t.op, c);
    if (!r.ok) {
      v(t.id, s, { message: r.error ?? "failed", kind: r.kind ?? "internal", oom: !!r.oom, low_memory: !!r.low_memory });
      return;
    }
    const i = l.takeBuffers(r), b = {}, d = [];
    for (const [h, u] of Object.entries(i))
      b[h] = u.buffer, d.push(u.buffer);
    const { ok: f, buffers: m, ...g } = r, y = { type: "result", id: t.id, ok: !0, result: g, buffers: b, ms: performance.now() - s, heap_bytes: B() };
    self.postMessage(y, d);
  } catch (r) {
    const i = r instanceof w ? r : null;
    v(t.id, s, {
      message: String(r instanceof Error ? r.message : r),
      kind: i ? i.kind : "internal",
      oom: !!(i && i.oom)
    });
  }
}
self.addEventListener("message", (t) => {
  const s = t.data;
  !s || s.type !== "call" || (k ? L(s) : E.push(s));
});
const D = "mk32.mjs";
x({ moduleUrl: new URL(D, import.meta.url).href }).then((t) => {
  for (k = t, self.postMessage({ type: "ready", variant: "wasm32", occt: t.version.occt, init_ms: performance.now() - C, heap_bytes: B() }); E.length; ) L(E.shift());
}).catch((t) => {
  self.postMessage({ type: "fatal", error: String(t instanceof Error ? t.message : t) });
});
