// Edge and vertex references (proposal §4.5 point 3: "edges are named by their two
// faces, vertices by their three faces"), made at pick time and resolved at every
// rebuild with the same rules as faces (src/naming/resolve.ts): by name, the
// signature checked on every name match (same kind: clean; another kind, split or
// merged: "Reference repaired · check"), then by signature alone (runner-up at least
// 50% worse); nothing found is an error; nothing is repaired silently.
//   edges    E:<faceA>&<faceB>      the names of its two faces, sorted (a seam: the same face twice)
//   vertices V:<a>&<b>&<c>...       the names of every face at it, sorted
// Face names can hold an edge name themselves (a press-pull side, a fillet face:
// F:<feature>:side:E:<a>&<b>), so a name is split with splitEdgeName / splitVertexName,
// which match each nested "E:" with its own '&'.
// Also the words panels use: "End · Side 2 of Extrude 1".
// Owner: P4a SOLIDS (the naming layer's edge half; REFERENCE uses it for axes and points).
// SPDX-License-Identifier: GPL-3.0-or-later
import type { FeatureId, PersistentRef, RefSemantic, RefSignature, Vec3 } from '../types/doc';
import type { ShapeId, TopoResult } from '../types/kernel-protocol';
import type { FaceNames, NamingLookup, RefResolution } from '../types/naming';
import { edgeName, ENCLOSURE_SIDE_WORDS, sideNumber, splitMerged, splitSuffix, vertexName } from './names';
import { sameKind, signatureDistance } from './resolve';

type TopoEdge = TopoResult['edges'][number];
type TopoVertex = TopoResult['vertices'][number];

const REPAIRED = 'Reference repaired · check';

// ------------------------------------------------------------ the grammar

/** Is position i of s the start of a nested edge name ("E:" at the start or after ':', '|', '&')? */
function edgeAt(s: string, i: number): boolean {
  return s.startsWith('E:', i) && (i === 0 || s[i - 1] === ':' || s[i - 1] === '|' || s[i - 1] === '&');
}

/**
 * The '&' positions of s that belong to its top level: each nested "E:<a>&<b>" inside a
 * face name takes the first '&' after it that no later-opened edge took.
 */
function topLevelAmps(s: string, from: number): number[] {
  const out: number[] = [];
  let open = 0;
  for (let i = from; i < s.length; i++) {
    if (edgeAt(s, i)) {
      open++;
      i++;
    } else if (s[i] === '&') {
      if (open > 0) open--;
      else out.push(i);
    }
  }
  return out;
}

/** The two face names of an edge name ("E:<a>&<b>"), or null when it is not one. */
export function splitEdgeName(name: string): [string, string] | null {
  if (!name.startsWith('E:')) return null;
  const amps = topLevelAmps(name, 2);
  if (amps.length !== 1) return null;
  return [name.slice(2, amps[0]), name.slice(amps[0] + 1)];
}

/** The face names of a vertex name ("V:<a>&<b>&<c>"), or null. */
export function splitVertexName(name: string): string[] | null {
  if (!name.startsWith('V:')) return null;
  const amps = topLevelAmps(name, 2);
  const parts: string[] = [];
  let at = 2;
  for (const a of amps) {
    parts.push(name.slice(at, a));
    at = a + 1;
  }
  parts.push(name.slice(at));
  return parts.every(Boolean) ? parts : null;
}

/** The name of edge `i` from its faces (sorted), or null when its faces have no names. */
function edgeNameOf(e: TopoEdge, faces: readonly string[]): string | null {
  const f = [...new Set(e.faces)];
  if (!f.length) return null;
  const a = faces[f[0]];
  const b = faces[f.length > 1 ? f[1] : f[0]];
  if (!a || !b) return null;
  return edgeName(a, b);
}

function vertexNameOf(v: TopoVertex, faces: readonly string[]): string | null {
  if (!v.faces?.length) return null;
  const names = v.faces.map((i) => faces[i]);
  if (names.some((n) => !n)) return null;
  return vertexName([...new Set(names)]);
}

// ------------------------------------------------------------ signatures

export function edgeSignature(e: TopoEdge): RefSignature {
  return {
    kind: 'edge',
    type: e.type,
    size: e.length,
    at: (e.mid ?? e.first ?? [0, 0, 0]) as Vec3,
    dir: (e.dir ?? e.axis_dir ?? null) as Vec3 | null,
    radius: e.radius ?? null,
    bbox: null,
  };
}

export function vertexSignature(v: TopoVertex): RefSignature {
  return { kind: 'vertex', type: 'vertex', at: [...v.p] as Vec3, dir: null, radius: null, bbox: null };
}

/** The semantic hint of a sub-shape's name: the feature that made its first face. */
function semanticOf(faceNames: readonly string[]): RefSemantic | undefined {
  const m = /^F:([^:|#]+):([^:|#]+)/.exec(splitMerged(faceNames[0] ?? '')[0] ?? '');
  return m ? { feature: m[1], role: 'other' } : undefined;
}

// ------------------------------------------------------------ making references

/**
 * The stored reference for edge `index` of a body: its name now (its two faces' names),
 * a semantic hint and its signature. Throws when the body or the edge's faces have no
 * names (a bug: every feature names its faces).
 */
export async function refOfEdge(lookup: NamingLookup, shape: ShapeId, names: FaceNames | null, index: number): Promise<PersistentRef> {
  if (!lookup.edges) throw new Error('this lookup cannot read edges');
  const [e] = await lookup.edges(shape, [index]);
  if (!e) throw new Error(`edge ${index} of this body is not there`);
  const name = names ? edgeNameOf(e, names.faces) : null;
  if (!name) throw new Error(`edge ${index} of this body has no name`);
  const sem = semanticOf(splitEdgeName(name) ?? []);
  return { name, ...(sem ? { semantic: sem } : {}), signature: edgeSignature(e) };
}

/** The stored reference for vertex `index` of a body (its faces' names, its point). */
export async function refOfVertex(lookup: NamingLookup, shape: ShapeId, names: FaceNames | null, index: number): Promise<PersistentRef> {
  if (!lookup.vertices) throw new Error('this lookup cannot read vertices');
  const [v] = await lookup.vertices(shape, [index]);
  if (!v) throw new Error(`vertex ${index} of this body is not there`);
  const name = names ? vertexNameOf(v, names.faces) : null;
  if (!name) throw new Error(`vertex ${index} of this body has no name`);
  const sem = semanticOf(splitVertexName(name) ?? []);
  return { name, ...(sem ? { semantic: sem } : {}), signature: vertexSignature(v) };
}

// ------------------------------------------------------------ resolution

/** Does face name `n` (now) stand for `want` (stored): the same, split from it (#k), or merged with it. */
function faceRelated(n: string, want: string): boolean {
  if (n === want) return true;
  const wantBase = splitSuffix(want).base;
  return splitMerged(n).some((p) => p === want || splitSuffix(p).base === want || splitSuffix(p).base === wantBase || p === wantBase);
}

/** Edges whose name is the stored one (exact), else whose faces stand for its faces (split or merged). */
function edgeCandidates(ref: string, current: (string | null)[]): number[] {
  const exact: number[] = [];
  const related: number[] = [];
  const want = splitEdgeName(ref);
  current.forEach((n, i) => {
    if (!n) return;
    if (n === ref) exact.push(i);
    else if (want) {
      const have = splitEdgeName(n);
      if (have && ((faceRelated(have[0], want[0]) && faceRelated(have[1], want[1])) || (faceRelated(have[0], want[1]) && faceRelated(have[1], want[0])))) related.push(i);
    }
  });
  return exact.length ? exact : related;
}

function vertexCandidates(ref: string, current: (string | null)[]): number[] {
  const exact: number[] = [];
  const related: number[] = [];
  const want = splitVertexName(ref);
  current.forEach((n, i) => {
    if (!n) return;
    if (n === ref) exact.push(i);
    else if (want) {
      const have = splitVertexName(n);
      if (have && want.every((w) => have.some((h) => faceRelated(h, w)))) related.push(i);
    }
  });
  return exact.length ? exact : related;
}

function scaleOf(points: readonly Vec3[]): number {
  const lo: Vec3 = [Infinity, Infinity, Infinity];
  const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const p of points)
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], p[k]);
      hi[k] = Math.max(hi[k], p[k]);
    }
  const d = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  return Number.isFinite(d) && d > 0 ? d : 1;
}

/** Choose among scored candidates (see the file header). */
function choose(ref: PersistentRef, candidates: number[], sigs: Map<number, RefSignature>, scale: number, what: 'Edge' | 'Vertex'): RefResolution {
  if (candidates.length) {
    const pool = candidates.map((i) => ({ i, sig: sigs.get(i)! })).filter((x) => x.sig);
    const same = pool.filter((x) => sameKind(ref.signature, x.sig));
    if (candidates.length === 1 && same.length === 1) return { ok: true, index: same[0].i, how: 'name', signature: same[0].sig };
    // Several edges between the same two faces: the nearest of the same kind, cleanly when it is
    // clearly the nearest and where it was (a dimension change moves it); else a repair.
    const from = same.length ? same : pool;
    from.sort((a, b) => signatureDistance(ref.signature, a.sig, scale) - signatureDistance(ref.signature, b.sig, scale));
    const best = from[0];
    if (best && Number.isFinite(signatureDistance(ref.signature, best.sig, scale))) {
      const exactName = candidates.length > 1 && same.length > 1 && same.length === candidates.length;
      const d0 = signatureDistance(ref.signature, best.sig, scale);
      const d1 = from[1] ? signatureDistance(ref.signature, from[1].sig, scale) : Infinity;
      if (exactName && d0 < 0.05 && d1 >= 2 * d0 + 0.05) return { ok: true, index: best.i, how: 'name', signature: best.sig };
      return { ok: true, index: best.i, how: 'moved', warning: REPAIRED, signature: best.sig };
    }
  }
  const scored = [...sigs.entries()]
    .map(([i, sig]) => ({ i, sig, d: signatureDistance(ref.signature, sig, scale) }))
    .filter((s) => Number.isFinite(s.d))
    .sort((a, b) => a.d - b.d);
  if (scored.length && (scored.length === 1 || scored[1].d >= 1.5 * scored[0].d) && scored[0].d < 0.25) {
    return { ok: true, index: scored[0].i, how: 'signature', warning: REPAIRED, signature: scored[0].sig };
  }
  return { ok: false, message: `${what} not found after rebuild` };
}

export interface ResolveSubInput {
  ref: PersistentRef;
  shape: ShapeId;
  names: FaceNames;
  lookup: NamingLookup;
}

/** Resolve a stored edge reference on a body (asks the kernel for every edge's faces). */
export async function resolveEdge(input: ResolveSubInput): Promise<RefResolution> {
  const { ref, shape, names, lookup } = input;
  if (!lookup.edges) return { ok: false, message: 'Edge not found after rebuild' };
  const all = await lookup.edges(shape, 'all');
  const current: (string | null)[] = [];
  const sigs = new Map<number, RefSignature>();
  for (const e of all) {
    current[e.i] = edgeNameOf(e, names.faces);
    if (e.type !== 'degenerate') sigs.set(e.i, edgeSignature(e));
  }
  return choose(ref, edgeCandidates(ref.name, current), sigs, scaleOf([...sigs.values()].map((s) => s.at)), 'Edge');
}

/** Resolve a stored vertex reference on a body. */
export async function resolveVertex(input: ResolveSubInput): Promise<RefResolution> {
  const { ref, shape, names, lookup } = input;
  if (!lookup.vertices) return { ok: false, message: 'Vertex not found after rebuild' };
  const all = await lookup.vertices(shape, 'all');
  const current: (string | null)[] = [];
  const sigs = new Map<number, RefSignature>();
  for (const v of all) {
    current[v.i] = vertexNameOf(v, names.faces);
    sigs.set(v.i, vertexSignature(v));
  }
  return choose(ref, vertexCandidates(ref.name, current), sigs, scaleOf([...sigs.values()].map((s) => s.at)), 'Vertex');
}

/** The edges of a body around a face (picking a face takes all its edges): indices now. */
export async function edgesOfFace(lookup: NamingLookup, shape: ShapeId, face: number): Promise<number[]> {
  if (!lookup.edges) return [];
  const all = await lookup.edges(shape, 'all');
  return all.filter((e) => e.type !== 'degenerate' && e.faces.includes(face) && !(e.faces.length >= 2 && e.faces.every((f) => f === face))).map((e) => e.i);
}

// ------------------------------------------------------------ words

/** "1", "2"... a side's place among the sides of its feature that `faceNames` holds (natural order of tokens). */
const sideRank = sideNumber;

/**
 * One face name in short words and the feature that made it: {owner: 'f_x', words: 'Side 2'}.
 * Sides are numbered among the sides of their feature in `faceNames` (the body's faces), as
 * the project's face labels number them; without `faceNames` a side is just "Side".
 */
export function faceShortWords(name: string, faceNames: readonly string[] | null = null): { owner: FeatureId | null; words: string } {
  const part = splitMerged(name)[0] ?? name;
  const { base, k } = splitSuffix(part);
  const m = /^F:([^:]+):([^:]+)(?::(.*))?$/.exec(base);
  if (!m) return { owner: null, words: 'Face' };
  const [, owner, role, detail = ''] = m;
  const n = /^\d+$/.test(detail) ? Number(detail) : null;
  let words: string;
  switch (role) {
    case 'start':
      words = n == null ? 'Start' : `Start ${n + 1}`;
      break;
    case 'end':
      words = n == null ? 'End' : `End ${n + 1}`;
      break;
    case 'side': {
      const r = sideRank(owner, detail, faceNames);
      words = r == null ? 'Side' : `Side ${r}`;
      break;
    }
    case 'enclosure':
      words = ENCLOSURE_SIDE_WORDS[detail] ?? 'Face';
      break;
    case 'import':
    case 'primitive': {
      const last = Number(detail.split(':').pop());
      words = Number.isInteger(last) ? `Face ${last + 1}` : 'Face';
      break;
    }
    case 'cut':
      words = 'Cut face';
      break;
    case 'fillet':
      words = 'Fillet';
      break;
    case 'chamfer':
      words = 'Chamfer';
      break;
    case 'inner':
      words = 'Inner face';
      break;
    default:
      words = 'Face';
  }
  return { owner, words: k == null ? words : `${words} · part ${k + 1}` };
}

/**
 * An edge name in words: "End · Side 2 of Extrude 1" (both faces made by one feature),
 * "End of Extrude 1 · Side 1 of Extrude 2" (by two), null when it is not an edge name.
 */
export function edgeWords(name: string, featureName: (id: FeatureId) => string | null, faceNames: readonly string[] | null = null): string | null {
  const pair = splitEdgeName(name);
  if (!pair) return null;
  const [a, b] = pair.map((f) => faceShortWords(f, faceNames));
  const owner = (id: FeatureId | null) => (id ? (featureName(id) ?? 'a deleted feature') : 'a body');
  if (pair[0] === pair[1]) return `Seam of ${a.words} of ${owner(a.owner)}`;
  if (a.owner === b.owner) return `${a.words} · ${b.words} of ${owner(a.owner)}`;
  return `${a.words} of ${owner(a.owner)} · ${b.words} of ${owner(b.owner)}`;
}

/** A vertex name in words: "Corner of End, Side 1 and Side 2 of Extrude 1", null when it is not one. */
export function vertexWords(name: string, featureName: (id: FeatureId) => string | null, faceNames: readonly string[] | null = null): string | null {
  const parts = splitVertexName(name);
  if (!parts) return null;
  const w = parts.map((f) => faceShortWords(f, faceNames));
  const owner = (id: FeatureId | null) => (id ? (featureName(id) ?? 'a deleted feature') : 'a body');
  const list = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
  if (w.every((x) => x.owner === w[0].owner)) return `Corner of ${list(w.map((x) => x.words))} of ${owner(w[0].owner)}`;
  return `Corner of ${list(w.map((x) => `${x.words} of ${owner(x.owner)}`))}`;
}
