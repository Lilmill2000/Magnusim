// Fillets and drilled holes found by their shape (kernel API 8 `recognize`, Analysis Situs
// asiAlgo), for every caller in the page: the selectors and Find (`fillet`, sized `hole`), the
// Delete faces panel's Add by size, and Delete faces' build at its red exits ("the rest", the
// second way). One client per kernel: answers are cached per shape and query (the newest 32
// shapes), and dropped when the kernel restarts (every shape id dies then), as the selectors'
// topo cache is. Every refusal comes back as words with its reason, never as an empty answer:
// a body over its face limit, a body with no solid, a kernel below API 8, or the kernel's own
// words when recognition failed. Two face limits (kernel API 9): one for a search of fillets only,
// one for any search with holes (the drill-hole recogniser is quadratic); every caller asks for
// holes only when it needs them, and the words of a body over a limit name both, the one the
// search ran into first. Callers add the body's name ("Body 1 has 3,000 faces: holes are found on
// bodies of up to 2,600 faces and fillets on bodies of up to 5,000 faces").
// Owner: KERNEL-HARDENING.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { KernelAdapter, KernelCallError } from '../types/kernel';
import type { RecognizeResult, RecognizedBlend, ShapeId } from '../types/kernel-protocol';
import { RECOGNIZE_MAX_FILLET_FACES, RECOGNIZE_MAX_HOLE_FACES } from './timeouts';

/** The kernel contract revision that has `recognize` and `suppress_blends`. */
export const RECOGNIZE_API = 8;
/** Shapes kept. */
export const RECOGNITION_CACHE_SHAPES = 32;
/**
 * The drill-hole mode every caller gets unless it asks for another (decision D6, measured 2026-11-02
 * on the shipped kernel): hard finds the holes whose mouth straddles a fillet and the next face (5 of
 * the verifier's 7 such bodies; soft finds none of them), loses no hole soft finds on the gate's 216
 * code-built rows or the 11 NIST parts, and differs elsewhere only where holes cross: it joins them
 * into one hole (cross-drilled 6 and 4: one hole of bores 4 to 6), as on NIST FTC-10 (26 soft holes,
 * 16 hard). Same cost: a 2,006-face plate of 2,000 holes 2.16 s soft, 2.12 s hard.
 */
export const HOLES_MODE: 'soft' | 'hard' = 'hard';

export interface FeaturesQuery {
  /** Fillets (default true). */
  blends?: boolean;
  /** Drilled holes (default true). */
  holes?: boolean;
  /**
   * Analysis Situs' own radius limit: the fillets SuppressBlendsInc takes at R (suppress_blends
   * runs at the largest picked r_max x 1.001). Default: every fillet (the body's box diagonal).
   */
  max_r?: number;
  /** asiAlgo_RecognizeDrillHoles' mode (default HOLES_MODE). */
  holes_mode?: 'soft' | 'hard';
}

export interface FeaturesOptions {
  /** The body's face count when the caller knows it: a body over the limit is refused without a kernel call. */
  faces?: number | null;
  /** Stops waiting (rejects with an AbortError). A running recognition is not cut off: its answer is still cached. */
  signal?: AbortSignal;
}

/** Why fillets and holes could not be found on a body. */
export type FeaturesRefusal =
  /** More faces than a limit: `faces`, `over` (the search the limit is for), `limit` (that one), `limits` (both). */
  | 'too_large'
  /** A surface body (no solid). */
  | 'not_solid'
  /** The kernel answers an API below 8 (`api`). */
  | 'old_kernel'
  /** The kernel could not do it (`words` are its own). */
  | 'failed';

/** The two face limits: fillets (a search without holes) and holes (any search with them). */
export interface FaceLimits {
  fillets: number;
  holes: number;
}

/** Which search a limit is for. */
export type LimitKind = 'fillets' | 'holes';

export type Features =
  | { ok: true; result: RecognizeResult }
  | { ok: false; reason: FeaturesRefusal; words: string; faces?: number; over?: LimitKind; limit?: number; limits?: FaceLimits; api?: number };

export interface RecognitionClient {
  /** Fillets, chains and drilled holes of `shape` (cached per shape and query), or the refusal in words. */
  features(shape: ShapeId, query?: FeaturesQuery, opts?: FeaturesOptions): Promise<Features>;
  /**
   * The limits every call uses: `maxFilletFaces` (RECOGNIZE_MAX_FILLET_FACES) for a search without
   * holes, `maxHoleFaces` (RECOGNIZE_MAX_HOLE_FACES) for any search with holes. Tests lower them
   * (window.__CAD__.recognition) to show the over-limit words on a small body. Changing them drops
   * nothing: they are part of the cache key.
   */
  readonly limits: { maxFilletFaces: number; maxHoleFaces: number };
  /** How many recognize calls went to the kernel (tests). */
  readonly calls: number;
  clear(): void;
}

/** 2,412 */
export const withCommas = (n: number): string => Math.round(n).toLocaleString('en-US');

/**
 * Both limits, the one a search ran into (`over`) first: "holes are found on bodies of up to 2,600
 * faces and fillets on bodies of up to 5,000"; one number when they are the same ("fillets and
 * holes are found on bodies of up to 2,000"). The kernel's own words (facade.cpp tooManyFacesWords).
 */
export function limitWords(over: LimitKind, limits: FaceLimits): string {
  if (limits.fillets === limits.holes) return `fillets and holes are found on bodies of up to ${withCommas(limits.fillets)}`;
  const [a, b] = over === 'fillets' ? (['fillets', 'holes'] as const) : (['holes', 'fillets'] as const);
  return `${a} are found on bodies of up to ${withCommas(limits[a])} faces and ${b} on bodies of up to ${withCommas(limits[b])}`;
}

/** The kernel's own words for a body over a limit (facade.cpp opRecognize), so both refusals read the same. */
export function tooLargeWords(faces: number, over: LimitKind, limits: FaceLimits): string {
  return `this body has ${withCommas(faces)} faces: ${limitWords(over, limits)}`;
}

/** The limit a search of a body of `faces` faces runs into, as the kernel tells it (fillets first, then holes), or null. */
export function overLimit(faces: number, q: FeaturesQuery, limits: FaceLimits): LimitKind | null {
  if (q.blends !== false && faces > limits.fillets) return 'fillets';
  if (q.holes !== false && faces > limits.holes) return 'holes';
  return null;
}

/** The words for a kernel too old to find fillets or holes (plan §3.2). */
export function oldKernelWords(api: number): string {
  return `This kernel cannot find fillets or holes (it answers API ${api}; they need API ${RECOGNIZE_API}).`;
}

const NOT_SOLID = 'no solid in this body (fillets and holes are found on solids only)';

/**
 * Whether a recognised blend counts as a fillet in the app: 'ordinary' and 'vertex' do; 'cliff'
 * (tangent on one side only, such as engraved-text arcs) and 'uncertain' do not (decision D7).
 */
export function isFillet(b: Pick<RecognizedBlend, 'kind'>): boolean {
  return b.kind === 'ordinary' || b.kind === 'vertex';
}

/**
 * What a body has, for "matches nothing" words: its fillet faces (D7's fillets) and their radii; its
 * drilled holes (those with a bore: a cylinder) and their bores, and apart from them the holes
 * recognition found with no cylinder (`unsized`: a bore made of B-splines, a closed round void; no
 * size ever matches them, so they are not counted as drilled holes).
 */
export interface FeaturesSummary {
  fillets: { faces: number; r_min: number | null; r_max: number | null };
  holes: { count: number; d_min: number | null; d_max: number | null; unsized: number };
}

export function summaryOf(r: RecognizeResult): FeaturesSummary {
  const fillets = r.blends.filter(isFillet);
  const sized = r.holes.filter((h) => h.d_min !== null && h.d_max !== null);
  const min = (v: number[]) => (v.length ? Math.min(...v) : null);
  const max = (v: number[]) => (v.length ? Math.max(...v) : null);
  return {
    fillets: { faces: fillets.length, r_min: min(fillets.map((b) => b.r_min)), r_max: max(fillets.map((b) => b.r_max)) },
    holes: { count: sized.length, d_min: min(sized.map((h) => h.d_min as number)), d_max: max(sized.map((h) => h.d_max as number)), unsized: r.holes.length - sized.length },
  };
}

function abortError(): Error {
  const e = new Error('The search was stopped');
  e.name = 'AbortError';
  return e;
}

function keyOf(q: FeaturesQuery, limits: FaceLimits): string {
  return [q.blends === false ? 0 : 1, q.holes === false ? 0 : 1, q.max_r ?? '', q.holes === false ? '' : (q.holes_mode ?? HOLES_MODE), limits.fillets, limits.holes].join('|');
}

/** recognize's refusal of a body over a limit (one limit, API 8's words, or API 9's two) as a Features; null for any other words. */
function tooLargeOf(words: string, q: FeaturesQuery): Features | null {
  const m = /^this body has ([\d,]+) faces: (?:fillets and holes are found on bodies of up to ([\d,]+)|(fillets|holes) are found on bodies of up to ([\d,]+) faces and (?:fillets|holes) on bodies of up to ([\d,]+))$/.exec(words);
  if (!m) return null;
  const n = (t: string) => Number(t.replace(/,/g, ''));
  const faces = n(m[1]);
  if (m[2]) {
    const both = n(m[2]);
    return { ok: false, reason: 'too_large', words, faces, over: q.blends === false ? 'holes' : 'fillets', limit: both, limits: { fillets: both, holes: both } };
  }
  const over = m[3] as LimitKind;
  const limit = n(m[4]);
  const other = n(m[5]);
  return { ok: false, reason: 'too_large', words, faces, over, limit, limits: over === 'fillets' ? { fillets: limit, holes: other } : { fillets: other, holes: limit } };
}

export function createRecognitionClient(kernel: KernelAdapter): RecognitionClient {
  // shape -> query key -> answer. A Map keeps insertion order: the first key is the oldest shape.
  const cache = new Map<ShapeId, Map<string, Promise<Features>>>();
  const limits = { maxFilletFaces: RECOGNIZE_MAX_FILLET_FACES, maxHoleFaces: RECOGNIZE_MAX_HOLE_FACES };
  let calls = 0;
  const clear = () => cache.clear();
  kernel.onRespawn(clear);

  const touch = (shape: ShapeId): Map<string, Promise<Features>> => {
    let m = cache.get(shape);
    if (m) cache.delete(shape);
    else m = new Map();
    cache.set(shape, m);
    while (cache.size > RECOGNITION_CACHE_SHAPES) cache.delete(cache.keys().next().value as ShapeId);
    return m;
  };

  const ask = async (shape: ShapeId, q: FeaturesQuery, lim: FaceLimits): Promise<Features> => {
    const api = kernel.status.get().info?.api;
    if (typeof api === 'number' && api > 0 && api < RECOGNIZE_API) return { ok: false, reason: 'old_kernel', api, words: oldKernelWords(api) };
    calls++;
    try {
      const params = {
        id: shape,
        max_fillet_faces: lim.fillets,
        max_hole_faces: lim.holes,
        ...(q.blends === false ? { blends: false } : {}),
        ...(q.holes === false ? { holes: false } : { holes_mode: q.holes_mode ?? HOLES_MODE }),
        ...(q.max_r !== undefined ? { max_r: q.max_r } : {}),
      };
      const r = await kernel.call('recognize', params);
      return { ok: true, result: r.result };
    } catch (err) {
      const e = err as KernelCallError;
      const words = String(e?.message ?? err);
      if (e?.kind === 'input') {
        if (/^unknown op 'recognize'/.test(words)) {
          const said = typeof api === 'number' && api > 0 ? api : RECOGNIZE_API - 1;
          return { ok: false, reason: 'old_kernel', api: said, words: oldKernelWords(said) };
        }
        if (words === NOT_SOLID) return { ok: false, reason: 'not_solid', words };
        // One limit (max_faces, API 8's words) or API 9's two, the one the query ran into first.
        const big = tooLargeOf(words, q);
        if (big) return big;
      }
      // Anything else (an OCCT failure, a stopped or restarted kernel) is not kept: the next call asks again.
      throw Object.assign(new Error(words), { kind: e?.kind, refusal: { ok: false, reason: 'failed', words } satisfies Features });
    }
  };

  const features = async (shape: ShapeId, query: FeaturesQuery = {}, opts: FeaturesOptions = {}): Promise<Features> => {
    if (opts.signal?.aborted) throw abortError();
    const lim: FaceLimits = { fillets: limits.maxFilletFaces, holes: limits.maxHoleFaces };
    const over = typeof opts.faces === 'number' ? overLimit(opts.faces, query, lim) : null;
    if (over) return { ok: false, reason: 'too_large', faces: opts.faces!, over, limit: lim[over], limits: lim, words: tooLargeWords(opts.faces!, over, lim) };
    const key = keyOf(query, lim);
    const m = touch(shape);
    let p = m.get(key);
    if (!p) {
      p = ask(shape, query, lim);
      m.set(key, p);
      p.catch(() => {
        if (cache.get(shape)?.get(key) === p) cache.get(shape)!.delete(key);
      });
    }
    let answer: Features;
    try {
      answer = await p;
    } catch (err) {
      const refusal = (err as { refusal?: Features }).refusal;
      if (!refusal) throw err;
      answer = refusal;
    }
    if (opts.signal?.aborted) throw abortError();
    return answer;
  };

  return {
    features,
    limits,
    get calls() {
      return calls;
    },
    clear,
  };
}

const clients = new WeakMap<KernelAdapter, RecognitionClient>();

/** The page's recognition client (one per kernel adapter: the services' kernel and every feature build's ctx.kernel share it). */
export function recognitionOf(kernel: KernelAdapter): RecognitionClient {
  let c = clients.get(kernel);
  if (!c) {
    c = createRecognitionClient(kernel);
    clients.set(kernel, c);
  }
  return c;
}
