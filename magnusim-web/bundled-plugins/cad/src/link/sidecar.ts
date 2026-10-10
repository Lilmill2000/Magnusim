// LINK (host API 1.5): the face-name sidecar, face_names.json (format
// "magnusim.face-names" version 1), exactly as the app's own writer makes it
// (magnusim_sdk.link.write_face_names): sorted keys, no whitespace, UTF-8, one
// line and a newline, rows sorted by index, keys with no value left out. So two
// exports of one saved design are byte-identical, and the app sees "no change"
// from the file's hash alone. The sidecar has no per-save field (no
// source_version): only the design decides its bytes.
// - `name` is the match key: CAD's stable persistent face name without its
//   internal "#k" split suffix (the pieces of one split face share it, and the
//   app's split rule maps one old name onto every new face that has it).
// - `label` is what the app shows ("Extrude 1 · Side 3"); it never matches.
// - Bodies: `index` (1-based solid order), `id` (CAD's stable body id), `name`
//   (unique in this export), `label`, `color`.
// Owner: LINK.
// SPDX-License-Identifier: GPL-3.0-or-later
import { canonicalJson, hashString } from '../doc/canonical';
import { ENCLOSURE_SIDE_WORDS, splitMerged, splitSuffix } from '../naming/names';
import type { FeatureId } from '../types/doc';

export const NAMES_FORMAT = 'magnusim.face-names';
export const NAMES_VERSION = 1;
/** The app's limits (magnusim_sdk.link NAME_MAX, LABEL_MAX). */
export const NAME_MAX = 200;
export const LABEL_MAX = 120;

export interface SidecarBody {
  index: number;
  id?: string;
  name?: string;
  label?: string;
  color?: string;
}

export interface SidecarFace {
  index: number;
  body: number;
  name?: string;
  label?: string;
  /**
   * Edit in CAD (host 1.7, an originalNames file only): the fingerprint of the CAD face a named row
   * names, in mm; `normal` null for a curved face (kept as null in the file).
   */
  centroid?: number[];
  area?: number;
  normal?: number[] | null;
}

// Control characters, and the bidirectional controls a name could hide text with
// (the app's clean_text removes the same).
// eslint-disable-next-line no-control-regex
const CLEAN_RE = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

/** A name or label as the app keeps it: no control or bidi characters, trimmed. */
export function cleanText(value: string): string {
  return value.replace(CLEAN_RE, '').trim();
}

/**
 * At most `max` characters, an ellipsis at the end when cut. Never cuts between
 * the two halves of a surrogate pair (an emoji in a name): a lone half is not
 * valid text, and the app would refuse the sidecar. Exported for tests.
 */
export function cap(text: string, max: number): string {
  if (text.length <= max) return text;
  let head = text.slice(0, max - 1);
  if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
  return `${head}…`;
}

/** The name of piece `k` (2, 3, ...) of a body of several solids: "Bar · piece 2". */
export function pieceName(name: string, k: number): string {
  const suffix = ` · piece ${k}`;
  return `${cap(cleanText(name) || 'Body', NAME_MAX - 6 - suffix.length)}${suffix}`;
}

/**
 * The match key of a face: its persistent name without the "#k" split suffix
 * (null when the face has no name). A name longer than the app takes (a face
 * merged from many) keeps its start and a hash of the whole, so it stays one
 * stable key per design.
 */
export function faceKey(name: string | null | undefined): string | null {
  if (!name) return null;
  const base = cleanText(splitSuffix(name).base);
  if (!base) return null;
  if (base.length <= NAME_MAX) return base;
  const tag = `~${hashString(base)}`;
  return `${base.slice(0, NAME_MAX - tag.length)}${tag}`;
}

/**
 * Text order with digit runs compared as numbers ("e_2" before "e_10"), the same in
 * every browser (no locale), so labels do not depend on where the export ran.
 */
export function natural(a: string, b: string): number {
  const ra = a.match(/\d+|\D+/g) ?? [];
  const rb = b.match(/\d+|\D+/g) ?? [];
  for (let i = 0; i < Math.min(ra.length, rb.length); i++) {
    const x = ra[i];
    const y = rb[i];
    if (x === y) continue;
    const dx = /^\d/.test(x);
    const dy = /^\d/.test(y);
    if (dx && dy && Number(x) !== Number(y)) return Number(x) - Number(y);
    return x < y ? -1 : 1;
  }
  return ra.length - rb.length || (a < b ? -1 : a > b ? 1 : 0);
}

/** The words of one (not merged) face name after its feature's name, or null. */
function partWords(base: string, sideRank: (feature: FeatureId, token: string) => number): { feature: FeatureId; words: string } | null {
  const m = /^F:([^:]+):([^:]+)(?::(.*))?$/.exec(base);
  if (!m) return null;
  const [, feature, role, detail = ''] = m;
  const n = /^\d+$/.test(detail) ? Number(detail) : null;
  switch (role) {
    case 'start':
      return { feature, words: n == null ? 'Start' : `Start ${n + 1}` };
    case 'end':
      return { feature, words: n == null ? 'End' : `End ${n + 1}` };
    case 'side':
      return { feature, words: `Side ${sideRank(feature, detail)}` };
    case 'enclosure':
      return { feature, words: ENCLOSURE_SIDE_WORDS[detail] ?? 'Face' };
    case 'import':
    case 'primitive': {
      const last = Number(detail.split(':').pop());
      return { feature, words: Number.isInteger(last) ? `Face ${last + 1}` : 'Face' };
    }
    case 'cut':
      return { feature, words: 'Cut face' };
    default:
      return { feature, words: 'Face' };
  }
}

/**
 * Labels for the faces of one export: "Extrude 1 · Side 3", "Enclosure 1 · +X
 * face", "Imported 1 · Face 12", a split piece "Extrude 1 · End · part 2", a
 * merged face "Extrude 1 · End + Extrude 2 · End". A side's number is its place
 * among that feature's side names in this export (sorted), so it is the same for
 * the same design. null for a face with no name or whose feature is gone.
 */
export function faceLabeler(names: readonly (string | null | undefined)[], featureName: (id: FeatureId) => string | null): (name: string | null | undefined) => string | null {
  const sides = new Map<FeatureId, Set<string>>();
  for (const full of names) {
    if (!full) continue;
    for (const part of splitMerged(full)) {
      const m = /^F:([^:]+):side:(.*)$/.exec(splitSuffix(part).base);
      if (!m) continue;
      const set = sides.get(m[1]) ?? new Set<string>();
      set.add(m[2]);
      sides.set(m[1], set);
    }
  }
  const ranks = new Map<FeatureId, Map<string, number>>();
  for (const [feature, set] of sides) {
    const sorted = [...set].sort(natural);
    ranks.set(feature, new Map(sorted.map((t, i) => [t, i + 1])));
  }
  const sideRank = (feature: FeatureId, token: string) => ranks.get(feature)?.get(token) ?? 1;
  const one = (part: string): string | null => {
    const { base, k } = splitSuffix(part);
    const w = partWords(base, sideRank);
    if (!w) return null;
    const owner = featureName(w.feature);
    if (!owner) return null;
    return `${owner} · ${w.words}${k == null ? '' : ` · part ${k + 1}`}`;
  };
  return (full) => {
    if (!full) return null;
    const parts = splitMerged(full);
    const words = [...new Set(parts.map(one).filter((x): x is string => !!x))].sort(natural);
    if (!words.length) return null;
    let text = words.join(' + ');
    if (text.length > LABEL_MAX && words.length > 1) text = `${words[0]} + ${words.length - 1} more`;
    const clean = cleanText(cap(text, LABEL_MAX));
    return clean || null;
  };
}

/**
 * Body names unique within one export: "Body 1", then "Body 1 (2)", "Body 1 (3)" for the next
 * ones that clash (two bodies of one name). The pieces of one body are named by pieceName first.
 */
export function uniqueNames(names: readonly string[]): string[] {
  const used = new Set<string>();
  return names.map((raw) => {
    const base = cap(cleanText(raw) || 'Body', NAME_MAX - 6);
    let name = base;
    for (let n = 2; used.has(name); n++) name = `${base} (${n})`;
    used.add(name);
    return name;
  });
}

function row<T extends object>(r: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) if (v !== undefined && v !== '' && (v !== null || (k === 'normal' && 'centroid' in r))) out[k] = v;
  return out as T;
}

/**
 * The sidecar's bytes (as text): the app's canonical form. Rows are sorted by
 * index; `shape_sha256` (lower-case hex) ties it to the BREP it describes.
 */
export function faceNamesText(bodies: readonly SidecarBody[], faces: readonly SidecarFace[], shapeSha256: string): string {
  const doc = {
    format: NAMES_FORMAT,
    version: NAMES_VERSION,
    length_unit: 'mm',
    shape_sha256: shapeSha256.toLowerCase(),
    bodies: [...bodies].map(row).sort((a, b) => a.index - b.index),
    faces: [...faces].map(row).sort((a, b) => a.index - b.index),
  };
  return `${canonicalJson(doc)}\n`;
}
