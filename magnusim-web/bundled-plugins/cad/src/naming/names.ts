// Persistent names (proposal §4.5 point 3): the grammar, and names after an
// operation from the kernel's history. Pure functions; no kernel calls.
//   faces    F:<feature>:<role>[:<detail>]       F:f_ab:side:e_1[p:pt_a>p:pt_b]
//                                                  F:f_ab:start, F:f_imp:import:0:12
//   split    <name>#<k>                           k = 0.. ordered by centroid (x, y, z)
//   merged   <a>|<b>                              sorted, unique (UnifySameDomain)
//   edges    E:<faceA>&<faceB>                    sorted
//   vertices V:<faceA>&<faceB>&<faceC>            sorted
// Owner: DOC-CORE (naming layer).
// SPDX-License-Identifier: GPL-3.0-or-later
import type { FeatureId } from '../types/doc';
import type { HistorySource, ShapeId, TopoResult } from '../types/kernel-protocol';
import type { FaceNames, NamingInput, NamingResult } from '../types/naming';

export type FaceRole = 'side' | 'start' | 'end' | 'import' | 'primitive' | 'cut' | 'heal' | 'moved' | 'new' | 'gen' | 'enclosure';

/** An Enclosure's face names' details in words (F:<id>:enclosure:+x is the +X face). */
export const ENCLOSURE_SIDE_WORDS: Record<string, string> = {
  '+x': '+X face',
  '-x': '−X face',
  '+y': '+Y face',
  '-y': '−Y face',
  '+z': '+Z face',
  '-z': '−Z face',
  side: 'Side face',
  top: 'Top face',
  bottom: 'Bottom face',
  '+x-end': '+X end',
  '-x-end': '−X end',
  '+y-end': '+Y end',
  '-y-end': '−Y end',
};

/**
 * What a face that keeps its own place on a body is called there, without the body ("+Z face",
 * "−X end"), or null for a face known only by its number. Today: an Enclosure's sides, which
 * Measure and the pick lists show as "+Z face of Enclosure 1" (SD review round 1: they said
 * "Face 6 of Enclosure 1"). A face merged from several has no such name.
 */
export function placeWords(name: string | null | undefined): string | null {
  if (!name || splitMerged(name).length > 1) return null;
  const { base, k } = splitSuffix(name);
  const m = /^F:([^:]+):enclosure:(.+)$/.exec(base);
  const w = m ? ENCLOSURE_SIDE_WORDS[m[2]] : undefined;
  return w ? `${w}${k == null ? '' : ` · part ${k + 1}`}` : null;
}

/** "F:<feature>:<role>" or "F:<feature>:<role>:<detail>". */
export function faceName(feature: FeatureId, role: FaceRole | string, detail?: string | number): string {
  return detail === undefined || detail === '' ? `F:${feature}:${role}` : `F:${feature}:${role}:${detail}`;
}

/** The name of a face merged from several (sorted, unique, joined by '|'). */
export function mergeNames(names: readonly string[]): string {
  const parts = new Set<string>();
  for (const n of names) for (const p of splitMerged(n)) parts.add(p);
  return [...parts].sort().join('|');
}

/** The names a merged name is made of. */
export function splitMerged(name: string): string[] {
  // '|' separates merged names; it never appears inside one (ids and tokens do not use it outside x: split points, which sit in brackets).
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of name) {
    if (ch === '[') depth++;
    else if (ch === ']') depth = Math.max(0, depth - 1);
    if (ch === '|' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.filter(Boolean);
}

/** A name without its split suffix ("A#2" -> "A"), and the suffix (or null). */
export function splitSuffix(name: string): { base: string; k: number | null } {
  // Only a '#<digits>' after the last ']' is a split suffix: a crossing's ordinal
  // inside a sub-segment token's brackets (x:e_1|e_2#0) is not.
  const hash = name.lastIndexOf('#');
  if (hash < 0 || hash < name.lastIndexOf(']')) return { base: name, k: null };
  const tail = name.slice(hash + 1);
  if (!/^\d+$/.test(tail)) return { base: name, k: null };
  return { base: name.slice(0, hash), k: Number(tail) };
}

/** "E:<a>&<b>" (sorted). */
export function edgeName(faceA: string, faceB: string): string {
  return faceA <= faceB ? `E:${faceA}&${faceB}` : `E:${faceB}&${faceA}`;
}

/** "V:<a>&<b>&<c>" (sorted). */
export function vertexName(faces: readonly string[]): string {
  return `V:${[...faces].sort().join('&')}`;
}

/**
 * Names for the faces of a shape a feature made from nothing it can trace
 * (an import's healed BREP, a primitive before semantic names): by role and
 * face index. Stable as long as the shape is (an import's stored BREP is).
 */
export function indexedNames(feature: FeatureId, role: FaceRole | string, faces: number, detail?: string | number): FaceNames {
  const prefix = detail === undefined || detail === '' ? `F:${feature}:${role}` : `F:${feature}:${role}:${detail}`;
  return { faces: Array.from({ length: faces }, (_, i) => `${prefix}:${i}`) };
}

/** Sort keys for '#k' suffixes: centroid x, then y, then z (rounded), then face index. */
function orderOf(indices: number[], topo: Pick<TopoResult, 'faces'> | null | undefined): number[] {
  if (!topo) return [...indices].sort((a, b) => a - b);
  const at = new Map<number, number[]>();
  for (const f of topo.faces) if (f.centroid) at.set(f.i, f.centroid);
  const r = (v: number) => Math.round(v * 1e6) / 1e6;
  return [...indices].sort((a, b) => {
    const ca = at.get(a);
    const cb = at.get(b);
    if (ca && cb) for (let k = 0; k < 3; k++) if (r(ca[k]) !== r(cb[k])) return r(ca[k]) - r(cb[k]);
    return a - b;
  });
}

/**
 * Names of an operation's result faces from its history (NamingInput):
 * - modified / same from one input face: that face's name;
 * - from several input faces (merged by unify): the merged name;
 * - a sweep's seg / cap: F:<feature>:side:<seg> / F:<feature>:start|end;
 * - generated from an input edge (no seg): F:<feature>:<role>:E:<a>&<b> when
 *   the input's names give the edge's faces, else by edge index (a warning);
 * - no history: F:<feature>:<role or 'new'>;
 * then names given to several faces (a face split in two) get #k suffixes.
 */
export function namesAfter(input: NamingInput, edgeFaces?: (shape: ShapeId, edge: number) => [number, number] | null): NamingResult {
  const warnings: string[] = [];
  const raw: (string | null)[] = new Array(input.faces).fill(null);
  let unnamedInputs = 0;
  let byPosition = 0;
  const nameOfSource = (s: HistorySource): string | null => {
    if (s.seg !== undefined) return faceName(input.feature, 'side', s.seg);
    if (s.cap !== undefined) return faceName(input.feature, s.cap);
    if (s.shape === undefined) return null;
    const names = input.inputs.get(s.shape);
    if (s.face !== undefined) {
      const n = names?.faces[s.face];
      if (n) return n;
      unnamedInputs++;
      return `F:#${s.shape}:${s.face}`;
    }
    if (s.edge !== undefined) {
      const pair = edgeFaces?.(s.shape, s.edge) ?? null;
      if (pair && names?.faces[pair[0]] && names.faces[pair[1]]) return faceName(input.feature, input.role ?? 'gen', edgeName(names.faces[pair[0]], names.faces[pair[1]]));
      byPosition++;
      return faceName(input.feature, input.role ?? 'gen', `e${s.edge}`);
    }
    if (s.vertex !== undefined) {
      byPosition++;
      return faceName(input.feature, input.role ?? 'gen', `v${s.vertex}`);
    }
    return null;
  };
  for (const entry of input.history.faces) {
    if (entry.out < 0 || entry.out >= input.faces) continue;
    // A face that is the same as / modified from input faces keeps their names; a
    // face only generated (from an edge, a sweep segment) gets the generated name.
    const kept = entry.from.filter((s) => s.how !== 'generated' && s.face !== undefined);
    const sources = kept.length ? kept : entry.from;
    const names = sources.map(nameOfSource).filter((n): n is string => !!n);
    if (names.length) raw[entry.out] = names.length === 1 ? names[0] : mergeNames(names);
  }
  let fresh = 0;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] == null) {
      raw[i] = faceName(input.feature, input.role ?? 'new');
      fresh++;
    }
  }
  // Same name on several faces: #k by geometry.
  const groups = new Map<string, number[]>();
  raw.forEach((n, i) => {
    const list = groups.get(n!) ?? [];
    list.push(i);
    groups.set(n!, list);
  });
  const faces = raw as string[];
  for (const [n, list] of groups) {
    if (list.length < 2) continue;
    orderOf(list, input.topo).forEach((i, k) => (faces[i] = `${n}#${k}`));
  }
  if (unnamedInputs) warnings.push(`${unnamedInputs} face${unnamedInputs === 1 ? '' : 's'} came from a body with no face names`);
  if (byPosition) warnings.push(`${byPosition} face${byPosition === 1 ? ' was' : 's were'} named by position (no edge names)`);
  if (fresh && !input.role) warnings.push(`${fresh} face${fresh === 1 ? ' has' : 's have'} no history and ${fresh === 1 ? 'was' : 'were'} named as new`);
  return { names: { faces }, warnings };
}

/**
 * A side's number among the sides of its feature that `faceNames` (a body's face names) holds,
 * in the natural order of their tokens ("1", "2", ...), as the project's face labels number them;
 * null without `faceNames` or when the side is not among them.
 */
export function sideNumber(feature: string, token: string, faceNames: readonly string[] | null | undefined): number | null {
  if (!faceNames) return null;
  const set = new Set<string>();
  for (const full of faceNames)
    for (const part of splitMerged(full)) {
      const m = /^F:([^:]+):side:(.*)$/.exec(splitSuffix(part).base);
      if (m && m[1] === feature) set.add(m[2]);
    }
  const sorted = [...set].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  const i = sorted.indexOf(token);
  return i >= 0 ? i + 1 : null;
}

/**
 * Human words for a face name in panels ("End face of Extrude 1", "Side 2 of Extrude 1", "Face 12
 * of Imported 1"). A side is numbered among its feature's sides on the body (`faceNames`, the
 * body's face names, as the PICKED chip and the Fillet panel number them); without them it is
 * "Side face", never the sketch's internal token (P4a review: "Side e_6cctu2upm20i of Extrude 1").
 * A face merged from several says what it was made of: "End face of Extrude 1 merged with End
 * face of Extrude 2", or "... merged with 2 other faces" (review P2/P3 round 3: "(merged)" explained nothing).
 */
export function describeFace(name: string, featureName: (id: FeatureId) => string | null, faceNames: readonly string[] | null = null): string {
  const parts = splitMerged(name);
  if (parts.length < 2) return describeOne(name, featureName, faceNames);
  const words = parts.map((p) => describeOne(p, featureName, faceNames)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  return `${words[0]} merged with ${words.length === 2 ? words[1] : `${words.length - 1} other faces`}`;
}

/** One face name (not merged) in words. */
function describeOne(name: string, featureName: (id: FeatureId) => string | null, faceNames: readonly string[] | null): string {
  const { base, k } = splitSuffix(name);
  const m = /^F:([^:]+):([^:]+)(?::(.*))?$/.exec(base);
  if (!m) return name;
  const owner = featureName(m[1]) ?? 'a deleted feature';
  const role = m[2];
  const detail = m[3] ?? '';
  const part = k == null ? '' : ` · part ${k + 1}`;
  // "Face 7 of Imported 1 (flange.step)", as Measure says "Face 3 of flange" (review P2/P3 round 1:
  // "Face 7 (Imported 1 (flange.step))" nested its brackets).
  if (role === 'start') return `Start face${part} of ${owner}`;
  if (role === 'end') return `End face${part} of ${owner}`;
  if (role === 'side') {
    const n = sideNumber(m[1], detail, faceNames);
    return `${n == null ? 'Side face' : `Side ${n}`}${part} of ${owner}`;
  }
  if (role === 'fillet') return `Fillet face${part} of ${owner}`;
  if (role === 'chamfer') return `Chamfer face${part} of ${owner}`;
  if (role === 'inner') return `Inner face${part} of ${owner}`;
  if (role === 'import') return `Face ${Number(detail.split(':').pop()) + 1}${part} of ${owner}`;
  if (role === 'primitive') return `Face ${Number(detail) + 1}${part} of ${owner}`;
  if (role === 'cut') return `Cut face${part} of ${owner}`;
  // An Enclosure's sides (SD pass): '+X face of Enclosure 1', 'Top face of Enclosure 1'.
  if (role === 'enclosure') return `${ENCLOSURE_SIDE_WORDS[detail] ?? 'A face'}${part} of ${owner}`;
  return `Face${part} of ${owner}`;
}
