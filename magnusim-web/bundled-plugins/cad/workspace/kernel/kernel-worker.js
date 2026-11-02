class w extends Error {
  kind;
  oom;
  detail;
  constructor(s, c = "internal", l = null) {
    super(s), this.name = "KernelError", this.kind = c, this.oom = !!(l && l.oom), this.detail = l;
  }
}
const U = () => typeof performance < "u" ? performance.now() : Date.now(), N = new TextEncoder(), $ = new TextDecoder();
async function q(e) {
  const s = String(e.moduleUrl), c = U(), l = await import(
    /* @vite-ignore */
    s
  ), r = {
    locateFile: (n) => new URL(n, s).href,
    print: e.print ?? (() => {
    }),
    printErr: e.printErr ?? ((n) => console.warn("[kernel]", n))
  };
  e.wasmBinary && (r.wasmBinary = e.wasmBinary);
  const i = await l.default(r), g = U() - c, y = (n) => typeof n == "bigint" ? Number(n) : n >>> 0;
  let f = null;
  const m = () => i.HEAPU8, k = (n) => y(i._mk_alloc(n)), d = (n) => i._mk_free(n);
  function h(n) {
    const o = m();
    let t = o.indexOf(0, n);
    return t < 0 && (t = o.length), $.decode(o.subarray(n, t));
  }
  function u(n, o = {}) {
    if (f) throw new w(`kernel is dead after a trap: ${f}`, "trap");
    const t = N.encode(JSON.stringify({ op: n, params: o }));
    let a = 0, _ = 0;
    try {
      if (a = k(t.length + 1), !a) return { ok: !1, error: "out of memory (request buffer)", kind: "internal", oom: !0 };
      const p = m();
      p.set(t, a), p[a + t.length] = 0, _ = y(i._mk_call(a));
    } catch (p) {
      throw f = String(p instanceof Error ? p.message : p), new w(`kernel trapped in ${n}: ${f}`, "trap");
    } finally {
      a && !f && d(a);
    }
    if (!_) return { ok: !1, error: "out of memory (no result)", kind: "internal", oom: !0 };
    const A = h(_);
    return d(_), JSON.parse(A);
  }
  function B(n, o = {}) {
    const t = u(n, o);
    if (!t.ok) throw new w(t.error ?? "failed", t.kind ?? "internal", t);
    return t;
  }
  function S(n) {
    const o = k(n.length);
    if (!o) throw new w(`out of memory (cannot place ${n.length} bytes)`, "internal", { oom: !0 });
    return m().set(n, o), { ptr: o, len: n.length };
  }
  function O(n) {
    const o = {};
    for (const t of n.buffers ?? []) {
      const a = m().slice(t.ptr, t.ptr + t.len);
      d(t.ptr), t.type === "f32" ? o[t.name] = new Float32Array(a.buffer, 0, a.byteLength / 4) : t.type === "u32" ? o[t.name] = new Uint32Array(a.buffer, 0, a.byteLength / 4) : o[t.name] = a;
    }
    return n.buffers = [], o;
  }
  return {
    variant: "wasm32",
    version: B("version"),
    initMs: g,
    module: i,
    tryCall: u,
    call: B,
    putBytes: S,
    takeBuffers: O,
    heapBytes: () => m().buffer.byteLength,
    get dead() {
      return f;
    }
  };
}
const x = performance.now(), E = [];
let b = null;
function v() {
  try {
    return b ? b.heapBytes() : 0;
  } catch {
    return 0;
  }
}
function M(e, s, c) {
  const l = { type: "result", id: e, ok: !1, error: c, ms: performance.now() - s, heap_bytes: v() };
  self.postMessage(l);
}
function L(e) {
  const s = performance.now(), c = b, l = { ...e.params || {} };
  try {
    if (e.bytes) {
      const { ptr: h, len: u } = c.putBytes(new Uint8Array(e.bytes));
      l.ptr = h, l.len = u;
    }
    const r = c.tryCall(e.op, l);
    if (!r.ok) {
      M(e.id, s, { message: r.error ?? "failed", kind: r.kind ?? "internal", oom: !!r.oom, low_memory: !!r.low_memory });
      return;
    }
    const i = c.takeBuffers(r), g = {}, y = [];
    for (const [h, u] of Object.entries(i))
      g[h] = u.buffer, y.push(u.buffer);
    const { ok: f, buffers: m, ...k } = r, d = { type: "result", id: e.id, ok: !0, result: k, buffers: g, ms: performance.now() - s, heap_bytes: v() };
    self.postMessage(d, y);
  } catch (r) {
    const i = r instanceof w ? r : null;
    M(e.id, s, {
      message: String(r instanceof Error ? r.message : r),
      kind: i ? i.kind : "internal",
      oom: !!(i && i.oom)
    });
  }
}
self.addEventListener("message", (e) => {
  const s = e.data;
  !s || s.type !== "call" || (b ? L(s) : E.push(s));
});
const C = "mk32.mjs";
q({ moduleUrl: new URL(C, import.meta.url).href }).then((e) => {
  for (b = e, self.postMessage({
    type: "ready",
    variant: "wasm32",
    occt: e.version.occt,
    api: Number(e.version.api ?? 0),
    asi: typeof e.version.asi == "string" ? e.version.asi : null,
    init_ms: performance.now() - x,
    heap_bytes: v()
  }); E.length; ) L(E.shift());
}).catch((e) => {
  self.postMessage({ type: "fatal", error: String(e instanceof Error ? e.message : e) });
});
