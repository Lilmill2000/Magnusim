// JavaScript wrapper over the kernel facade's C ABI (mk_call / mk_alloc / mk_free).
// Runs inside the kernel worker, or in Node for kernel tests. JavaScript never
// holds OCCT objects: shapes are integer ids, and every call is JSON in, JSON out.
// Owner: KERNEL-HARDENING.
// SPDX-License-Identifier: GPL-3.0-or-later

export class KernelError extends Error {
  kind: 'occt' | 'input' | 'internal' | 'trap';
  oom: boolean;
  detail: unknown;
  constructor(message: string, kind: KernelError['kind'] = 'internal', detail: { oom?: boolean } | null = null) {
    super(message);
    this.name = 'KernelError';
    this.kind = kind;
    this.oom = !!(detail && detail.oom);
    this.detail = detail;
  }
}

/** The Emscripten module (mk32.mjs) surface the wrapper uses. */
interface EmModule {
  HEAPU8: Uint8Array;
  _mk_call(ptr: number): number;
  _mk_alloc(n: number): number;
  _mk_free(ptr: number): void;
}

type EmFactory = (init: Record<string, unknown>) => Promise<EmModule>;

export interface RawResult {
  ok: boolean;
  error?: string;
  kind?: KernelError['kind'];
  oom?: boolean;
  low_memory?: boolean;
  buffers?: { name: string; ptr: number; len: number; type: 'f32' | 'u32' | 'u8' }[];
  [key: string]: unknown;
}

export interface Kernel {
  variant: 'wasm32';
  version: { occt: string; build: string };
  initMs: number;
  module: EmModule;
  /** {ok:false,...} for an ordinary failure; throws KernelError(kind "trap") when the instance died. */
  tryCall(op: string, params?: Record<string, unknown>): RawResult;
  /** Throws KernelError on any failure. */
  call(op: string, params?: Record<string, unknown>): RawResult;
  /** Copies bytes into the wasm heap; the facade takes ownership when they are passed as {ptr,len}. */
  putBytes(u8: Uint8Array): { ptr: number; len: number };
  /** Copies every result buffer out of the heap (and frees it). */
  takeBuffers(result: RawResult): Record<string, Float32Array | Uint32Array | Uint8Array>;
  heapBytes(): number;
  readonly dead: string | null;
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const enc = new TextEncoder();
const dec = new TextDecoder();

export interface CreateKernelOptions {
  /** URL of mk32.mjs (default: ../kernel/mk32.mjs next to the built worker). */
  moduleUrl: string;
  /** The .wasm bytes (Node tests); otherwise it is fetched next to moduleUrl. */
  wasmBinary?: ArrayBuffer | Uint8Array;
  print?: (s: string) => void;
  printErr?: (s: string) => void;
}

export async function createKernel(opts: CreateKernelOptions): Promise<Kernel> {
  const moduleUrl = String(opts.moduleUrl);
  const t0 = now();
  const mod = (await import(/* @vite-ignore */ moduleUrl)) as { default: EmFactory };
  const init: Record<string, unknown> = {
    locateFile: (p: string) => new URL(p, moduleUrl).href,
    print: opts.print ?? (() => {}),
    printErr: opts.printErr ?? ((s: string) => console.warn('[kernel]', s)),
  };
  if (opts.wasmBinary) init.wasmBinary = opts.wasmBinary;
  const M = await mod.default(init);
  const initMs = now() - t0;

  // wasm32 pointers come back as i32 (negative above 2 GB): reinterpret as unsigned.
  const num = (x: number | bigint) => (typeof x === 'bigint' ? Number(x) : x >>> 0);
  let dead: string | null = null;
  const heap = () => M.HEAPU8;
  const alloc = (n: number) => num(M._mk_alloc(n));
  const release = (p: number) => M._mk_free(p);

  function readCString(p: number): string {
    const h = heap();
    let end = h.indexOf(0, p);
    if (end < 0) end = h.length;
    return dec.decode(h.subarray(p, end));
  }

  function tryCall(op: string, params: Record<string, unknown> = {}): RawResult {
    if (dead) throw new KernelError(`kernel is dead after a trap: ${dead}`, 'trap');
    const bytes = enc.encode(JSON.stringify({ op, params }));
    let req = 0;
    let res = 0;
    try {
      req = alloc(bytes.length + 1);
      if (!req) return { ok: false, error: 'out of memory (request buffer)', kind: 'internal', oom: true };
      const h = heap();
      h.set(bytes, req);
      h[req + bytes.length] = 0;
      res = num(M._mk_call(req));
    } catch (e) {
      // A wasm trap (unreachable, out of bounds) or an abort: the instance is unusable.
      dead = String(e instanceof Error ? e.message : e);
      throw new KernelError(`kernel trapped in ${op}: ${dead}`, 'trap');
    } finally {
      if (req && !dead) release(req);
    }
    if (!res) return { ok: false, error: 'out of memory (no result)', kind: 'internal', oom: true };
    const text = readCString(res);
    release(res);
    return JSON.parse(text) as RawResult;
  }

  function call(op: string, params: Record<string, unknown> = {}): RawResult {
    const r = tryCall(op, params);
    if (!r.ok) throw new KernelError(r.error ?? 'failed', r.kind ?? 'internal', r);
    return r;
  }

  function putBytes(u8: Uint8Array): { ptr: number; len: number } {
    const p = alloc(u8.length);
    if (!p) throw new KernelError(`out of memory (cannot place ${u8.length} bytes)`, 'internal', { oom: true });
    heap().set(u8, p);
    return { ptr: p, len: u8.length };
  }

  function takeBuffers(result: RawResult): Record<string, Float32Array | Uint32Array | Uint8Array> {
    const out: Record<string, Float32Array | Uint32Array | Uint8Array> = {};
    for (const b of result.buffers ?? []) {
      const copy = heap().slice(b.ptr, b.ptr + b.len);
      release(b.ptr);
      if (b.type === 'f32') out[b.name] = new Float32Array(copy.buffer, 0, copy.byteLength / 4);
      else if (b.type === 'u32') out[b.name] = new Uint32Array(copy.buffer, 0, copy.byteLength / 4);
      else out[b.name] = copy;
    }
    result.buffers = [];
    return out;
  }

  const version = call('version') as unknown as { occt: string; build: string };
  return {
    variant: 'wasm32',
    version,
    initMs,
    module: M,
    tryCall,
    call,
    putBytes,
    takeBuffers,
    heapBytes: () => heap().buffer.byteLength,
    get dead() {
      return dead;
    },
  };
}
