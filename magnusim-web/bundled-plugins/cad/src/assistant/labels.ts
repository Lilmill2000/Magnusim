// Labels: the Assistant's names for the faces and edges the Part's features made (CAD tools spec
// §5.3), read from the stored face names, and the person's words for them (describeFace,
// edgeWords, vertexWords). The selector parser (selectors/parse.ts) reads everything this writes:
//   F:<x>:start / end              <X>.start / <X>.end
//   F:<x>:start:<n>                <X>.start(<n+1>)
//   F:<x>:side:<token>             <X>.side(<the token's entity>): r__top shows as r.top, a
//                                  trimmed piece e_1.b as its root e_1
//   F:<x>:side:<token>@<path>      <X>.side(<part>@<path part>)   (a sweep's side)
//   F:<x>:fillet:E:... / chamfer   <X>.fillet(<k>), k by the stored names' natural order
//   F:<x>:inner:<src>              <X>.inner(<label of src>)
//   F:<x>:cut, import:<s>:<i>,     <X>.cut, <X>.import(<i+1>) (<s+1>.<i+1> past the first shape),
//   heal, enclosure:+x             <X>.heal, <X>.enclosure(+x)
//   F:<p>:i<key>:<src> / F:<m>:m:  <P>.copy(<key>) / <M>.mirror
//   merged A|B                     the label of A (every part's label selects the face)
//   split <name>#k, or several     the label plus ~k (1-based); a split face warns
//   faces with one label
//   edge E:A&B                     <label A> & <label B>
// A label that several faces share gets ~1, ~2, ... in a fixed order (the bodies' order, then
// the stored names' natural order, then #k), so every label written selects exactly one face.
// Faces that no role here names (an unnamed body, a primitive, a face named by position) have no
// label: find gives their handle and a point on them instead.
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { describeFace, isCopyRole, splitMerged, splitSuffix } from '../naming/names';
import { edgeWords, splitEdgeName, vertexWords } from '../naming/edges';
import type { FeatureId } from '../types/doc';
import type { FaceNames } from '../types/naming';

/** The roles a label names (CAD tools spec §5.2 ROLE). */
export const LABEL_ROLES = ['start', 'end', 'side', 'cut', 'inner', 'fillet', 'chamfer', 'copy', 'mirror', 'import', 'heal', 'enclosure'] as const;
export type LabelRole = (typeof LABEL_ROLES)[number];

/** The warning a label of a split face carries. */
export const SPLIT_WARNING = "split face: its number can swap after upstream edits; prefer a role or 'at' selector";

/** One label without its ~k, in two spellings: `key` compares (ids), `text` is what the model reads. */
export interface BaseLabel {
  feature: FeatureId;
  role: LabelRole;
  /** The role's detail as the parser canonicalises it ('' for none). */
  detail: string;
  /** "<feature id>\0<role>\0<detail>". */
  key: string;
  /** "Base.side(r.top)". */
  text: string;
}

/** Natural order (numbers inside names counted as numbers). */
export const natural = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true });

/** A name as a label writes it: in quotes when it holds characters the selector grammar uses. */
export function quoteName(name: string): string {
  if (!/["().&~#,@]|^\s|\s$/.test(name) && !/\s(of|at|offset|flip|faces|edges|vertices)(\s|$)/i.test(name)) return name;
  return `"${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** A model-side sketch id from a stored one: the first "__" (a macro's part) as ".". */
export const modelId = (stored: string) => stored.replace('__', '.');
/** A stored sketch id from a model-side one ("r.top" -> "r__top"). */
export const storedId = (model: string) => model.replace('.', '__');

/** The '@' of a side token outside its brackets (a sweep's path entity follows it), or -1. */
function topAt(token: string): number {
  let depth = 0;
  for (let i = 0; i < token.length; i++) {
    const c = token[i];
    if (c === '[') depth++;
    else if (c === ']') depth = Math.max(0, depth - 1);
    else if (c === '@' && depth === 0) return i;
  }
  return -1;
}

/** The root entity of a sub-segment token ("e_1.b[p:a>p:b]" -> "e_1"), or null when it names no sketch entity. */
function tokenRoot(token: string): string | null {
  const bracket = token.indexOf('[');
  const id = bracket >= 0 ? token.slice(0, bracket) : token;
  const dot = id.indexOf('.');
  const root = dot > 0 ? id.slice(0, dot) : id;
  // An edge's name (extrude of a face), or a name by position (e3, v2: no brackets), is no sketch entity.
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(root) || (bracket < 0 && /^[ev]\d+$/.test(root))) return null;
  return root;
}

/** The parts of a stored face name: F:<id>:<role>[:<detail>] (no split suffix). */
export function parsePart(part: string): { feature: FeatureId; role: string; detail: string } | null {
  const m = /^F:([^:]+):([^:]+)(?::(.*))?$/.exec(part);
  return m ? { feature: m[1], role: m[2], detail: m[3] ?? '' } : null;
}

/**
 * The raw details of `feature`'s faces with `role` among `names` (every part, and the sources inside
 * a copy's or an inner face's name), in natural order: a fillet face's number is its place here.
 */
export function roleDetails(names: readonly string[], feature: FeatureId, role: string): string[] {
  const out = new Set<string>();
  const walk = (name: string, depth: number) => {
    if (depth > 8) return;
    for (const part of splitMerged(name)) {
      const p = parsePart(splitSuffix(part).base);
      if (!p) continue;
      if (p.feature === feature && p.role === role) out.add(p.detail);
      if ((isCopyRole(p.role) || p.role === 'inner') && p.detail.startsWith('F:')) walk(p.detail, depth + 1);
    }
  };
  for (const n of names) walk(n, 0);
  return [...out].sort(natural);
}

export interface LabelNames {
  /** A feature's name by id, or null for a feature that is gone. */
  featureName(id: FeatureId): string | null;
}

/**
 * The base label of one stored name part (no merged parts; a split suffix is ignored), or null.
 * `bodyNames`: the face names of the body it is on (fillet and chamfer numbers count there).
 */
export function baseLabel(part: string, names: LabelNames, bodyNames: readonly string[]): BaseLabel | null {
  const p = parsePart(splitSuffix(part).base);
  if (!p) return null;
  const fname = names.featureName(p.feature);
  if (fname === null) return null;
  const make = (role: LabelRole, detail: string, shown: string = detail): BaseLabel => ({
    feature: p.feature,
    role,
    detail,
    key: `${p.feature}\u0000${role}\u0000${detail}`,
    text: `${quoteName(fname)}.${role}${shown ? `(${shown})` : ''}`,
  });
  if (isCopyRole(p.role)) return p.role === 'm' ? make('mirror', '') : make('copy', p.role.slice(1));
  switch (p.role) {
    case 'start':
    case 'end': {
      if (!p.detail) return make(p.role, '');
      if (!/^\d+$/.test(p.detail)) return null;
      return make(p.role, String(Number(p.detail) + 1));
    }
    case 'side': {
      const at = topAt(p.detail);
      const main = tokenRoot(at >= 0 ? p.detail.slice(0, at) : p.detail);
      if (!main) return null;
      if (at < 0) return make('side', main, modelId(main));
      const path = tokenRoot(p.detail.slice(at + 1));
      if (!path) return null;
      return make('side', `${main}@${path}`, `${modelId(main)}@${modelId(path)}`);
    }
    case 'fillet':
    case 'chamfer': {
      const k = roleDetails(bodyNames, p.feature, p.role).indexOf(p.detail);
      return k < 0 ? null : make(p.role, String(k + 1));
    }
    case 'inner': {
      const src = p.detail.startsWith('F:') ? firstLabel(p.detail, names, bodyNames) : null;
      return src ? make('inner', src.key, src.text) : null;
    }
    case 'import': {
      const m = /^(\d+):(\d+)$/.exec(p.detail);
      if (!m) return null;
      const s = Number(m[1]);
      const i = Number(m[2]) + 1;
      return make('import', s === 0 ? String(i) : `${s + 1}.${i}`);
    }
    case 'enclosure':
      return p.detail ? make('enclosure', p.detail) : null;
    case 'cut':
    case 'heal':
      return make(p.role, '');
    default:
      return null;
  }
}

/** The base label of the first part of a (merged) name that has one. */
export function firstLabel(name: string, names: LabelNames, bodyNames: readonly string[]): BaseLabel | null {
  for (const part of splitMerged(name)) {
    const b = baseLabel(part, names, bodyNames);
    if (b) return b;
  }
  return null;
}

/** A body as the labels see it. */
export interface LabelBody {
  id: string;
  names?: FaceNames | null;
}

interface Member {
  body: number;
  face: number;
  /** The raw part that gave the key (natural order), and its split number. */
  part: string;
  k: number;
}

/** One face's labels: the one written for it, and every base label that selects it. */
export interface FaceLabel {
  /** "Base.end", "Base.side(l2)~2", or null when no part of its name has a label. */
  label: string | null;
  /** Its keys (any part's base label selects it). */
  keys: string[];
  /** The label of a split face (#k), or one of several faces of one label: say so. */
  warning: string | null;
}

/**
 * The labels of every face of a set of bodies (in their order), with the ~k numbering across the
 * set. `of(body, face)` gives one face's; `members(key)` the faces a base label selects, in ~k order.
 */
export class LabelIndex {
  private readonly groups = new Map<string, Member[]>();
  private readonly faces: FaceLabel[][] = [];

  constructor(
    readonly bodies: readonly LabelBody[],
    readonly names: LabelNames,
  ) {
    const display: (BaseLabel | null)[][] = [];
    bodies.forEach((b, bi) => {
      const list = b.names?.faces ?? [];
      display[bi] = [];
      this.faces[bi] = [];
      list.forEach((name, fi) => {
        const keys: string[] = [];
        let first: BaseLabel | null = null;
        let split = false;
        for (const part of splitMerged(name)) {
          const lb = baseLabel(part, names, list);
          if (!lb) continue;
          first ??= lb;
          const { k } = splitSuffix(part);
          if (k !== null) split = true;
          if (!keys.includes(lb.key)) {
            keys.push(lb.key);
            const g = this.groups.get(lb.key) ?? [];
            g.push({ body: bi, face: fi, part: splitSuffix(part).base, k: k ?? -1 });
            this.groups.set(lb.key, g);
          }
        }
        display[bi][fi] = first;
        this.faces[bi][fi] = { label: null, keys, warning: split ? SPLIT_WARNING : null };
      });
    });
    for (const g of this.groups.values()) g.sort((a, b) => a.body - b.body || natural(a.part, b.part) || a.k - b.k || a.face - b.face);
    display.forEach((row, bi) =>
      row.forEach((lb, fi) => {
        if (!lb) return;
        const g = this.groups.get(lb.key)!;
        const fl = this.faces[bi][fi];
        fl.label = g.length === 1 ? lb.text : `${lb.text}~${g.findIndex((m) => m.body === bi && m.face === fi) + 1}`;
      }),
    );
  }

  /** One face's labels (an unknown face: none). */
  of(body: number, face: number): FaceLabel {
    return this.faces[body]?.[face] ?? { label: null, keys: [], warning: null };
  }

  /** The faces a base label selects, in ~k order. */
  members(key: string): { body: number; face: number }[] {
    return (this.groups.get(key) ?? []).map((m) => ({ body: m.body, face: m.face }));
  }

  /**
   * The faces of every base label whose key `pred` takes (a role with no detail takes them all), each
   * once, in ~k order: the bodies' order, then the stored names' natural order, then #k.
   */
  select(pred: (key: string) => boolean): { body: number; face: number }[] {
    const seen = new Set<string>();
    const all: Member[] = [];
    for (const [key, g] of this.groups) {
      if (!pred(key)) continue;
      for (const m of g) {
        const id = `${m.body}:${m.face}`;
        if (seen.has(id)) continue;
        seen.add(id);
        all.push(m);
      }
    }
    all.sort((a, b) => a.body - b.body || natural(a.part, b.part) || a.k - b.k || a.face - b.face);
    return all.map((m) => ({ body: m.body, face: m.face }));
  }

  /** The roles of `feature` still on the bodies, counted ("start", "side x4"). */
  rolesOf(feature: FeatureId): Map<string, number> {
    const out = new Map<string, number>();
    for (const [key, g] of this.groups) {
      const [fid, role] = key.split('\u0000');
      if (fid !== feature) continue;
      out.set(role, (out.get(role) ?? 0) + g.length);
    }
    return out;
  }
}

/** The person's words for a face ("End face of Plate"). */
export function faceWords(name: string | null | undefined, names: LabelNames, bodyNames: readonly string[] | null): string {
  return name ? describeFace(name, (id) => names.featureName(id), bodyNames) : 'a face with no name';
}

/** The person's words for an edge by its two faces' names, or null. */
export function edgeWordsOf(faceA: string | null | undefined, faceB: string | null | undefined, names: LabelNames, bodyNames: readonly string[] | null): string | null {
  if (!faceA || !faceB) return null;
  const n = faceA <= faceB ? `E:${faceA}&${faceB}` : `E:${faceB}&${faceA}`;
  return splitEdgeName(n) ? edgeWords(n, (id) => names.featureName(id), bodyNames) : null;
}

/** The person's words for a vertex by its faces' names, or null. */
export function vertexWordsOf(faceNames: readonly (string | null | undefined)[], names: LabelNames, bodyNames: readonly string[] | null): string | null {
  if (!faceNames.length || faceNames.some((n) => !n)) return null;
  return vertexWords(`V:${[...new Set(faceNames as string[])].sort().join('&')}`, (id) => names.featureName(id), bodyNames);
}
