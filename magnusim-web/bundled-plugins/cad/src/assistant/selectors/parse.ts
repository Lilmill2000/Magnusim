// The selector language (CAD tools spec §5.2): one string names faces, edges, vertices, bodies,
// planes, axes or sketch regions. Keywords are case-insensitive. Names (features, bodies) are
// matched whole, the longest known name first (case-insensitive), and may be quoted
// ("Boss.v2".end); a name the person typed is never read as syntax. Pure: the Part's names come in
// as data, and nothing here reads the Part.
//   handle     #f3 #e7 #v2 #b1                       (find, get_model and view hand them out)
//   selection                                        the person's selection
//   face       FEATURE.ROLE[(DETAIL)][~k] | SCOPE faces FILTER* | [BODY] face at (x, y, z) | #f
//   edge       edges of FACE FILTER* | FACE & FACE | SCOPE edges FILTER* | [BODY] edge at (...) | #e
//              (a face query goes in brackets there, its own filters inside: "edges of (Body 1
//              faces >Z) |X"; written bare with a filter it is refused, as the filters would be
//              read as the faces' or the edges' either way)
//   vertex     SCOPE vertices FILTER* | [BODY] vertex at (...) | #v
//   body       BODY | bodies of FEATURE | all bodies | bodies | #b
//   plane      (Top|Front|Right|XY|XZ|YZ | PLANE FEATURE | FACE) [offset EXPR [flip]]
//   axis       (X|Y|Z) [axis] | SKETCH.ENTITY | AXIS FEATURE | EDGE | axis of FACE | normal of PLANE
//   region     all | largest | r<N> | at(u, v) | <region key>, in the tool's sketch, or after
//              "<sketch> "; "<sketch> regions" lists them all (find); "<sketch>" alone is "all"
//   SCOPE      BODY | feature FEATURE | FEATURE | all     (a plain name is the body when one has it)
//   FILTER     >AX[n] <AX[n] (farthest / nearest by centre, n = 1 the first level) | +AX -AX (facing)
//              | |AX #AX (parallel / perpendicular) | %TYPE | hole | boss | radius [SIZE] | largest
//              | smallest | nearest (x, y, z) | fillet [SIZE] | hole SIZE
//              AX: X | Y | Z | (x, y, z)      SIZE: EXPR | <= EXPR | >= EXPR
//              (fillet and a sized hole are faces found by their shape, kernel API 8: a fillet face, a
//              whole drilled hole; a plain hole stays the per-face filter. A bare < or > after
//              fillet, hole or radius is refused with words: <Z and >Z are levels)
// A name that is both a body and a feature is read by the grammar: X.role, bodies of X and
// feature X take the feature; a plain name in a body place takes the body.
// Errors give the 1-based column of the first character the parser could not read.
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { Vec2, Vec3 } from '../../types/doc';
import { LABEL_ROLES, storedId } from '../labels';

/** What a field takes ('any': find, which lists whatever the selector names). */
export type Want = 'face' | 'edge' | 'vertex' | 'body' | 'plane' | 'axis' | 'region' | 'any';

/** What a selector yields. */
export type SelKind = 'face' | 'edge' | 'vertex' | 'body' | 'plane' | 'axis' | 'region';

export interface Named {
  id: string;
  name: string;
}

export interface FeatureRow extends Named {
  type: string;
}

/** The Part's names the parser may meet. */
export interface KnownNames {
  features: readonly FeatureRow[];
  bodies: readonly Named[];
}

/** An axis direction: X, Y, Z or (x, y, z) (unit length). */
export interface Ax {
  dir: Vec3;
  text: string;
}

/** How a size compares: `<=` the largest, `>=` the smallest, `=` equal within the filter's tolerance. */
export type SizeCmp = '<=' | '>=' | '=';

/** A size after fillet, hole or radius: "2 mm", "<= 2 mm", ">= 5 mm" (the expression as written). */
export interface Size {
  cmp: SizeCmp;
  expr: string;
}

export type Filter =
  | { f: '>' | '<'; ax: Ax; n: number; col: number; text: string }
  | { f: '+' | '-'; ax: Ax; col: number; text: string }
  | { f: '|' | '#'; ax: Ax; col: number; text: string }
  | { f: '%'; type: string; col: number; text: string }
  | { f: 'hole' | 'boss' | 'largest' | 'smallest'; col: number; text: string }
  | { f: 'radius'; expr: string; cmp: SizeCmp; col: number; text: string }
  | { f: 'nearest'; p: Vec3; col: number; text: string }
  /** Faces shaped like a fillet (any size, or a size of the fillet's own radius). */
  | { f: 'fillet'; size: Size | null; col: number; text: string }
  /** Every face of the drilled holes whose bore diameter fits the size (wall, bottom, countersink, rim). */
  | { f: 'sized-hole'; size: Size; col: number; text: string };

export type Scope = { s: 'body'; body: Named } | { s: 'feature'; feature: Named } | { s: 'all' };

export type OriginPlane = 'origin:top' | 'origin:front' | 'origin:right';
export type OriginAxis = 'origin:x' | 'origin:y' | 'origin:z';

export type PlaneBase = { b: 'origin'; plane: OriginPlane; word: string } | { b: 'feature'; feature: Named } | { b: 'face'; face: Sel };

export type AxisBase =
  | { b: 'origin'; axis: OriginAxis; word: string }
  | { b: 'feature'; feature: Named }
  | { b: 'sketch-line'; sketch: Named; entity: string; text: string }
  | { b: 'edge'; edge: Sel }
  | { b: 'face-axis'; face: Sel }
  | { b: 'normal'; plane: Sel };

export type RegionWhich = { w: 'all' } | { w: 'largest' } | { w: 'r'; n: number } | { w: 'at'; uv: Vec2 } | { w: 'key'; key: string } | { w: 'regions' };

export type Sel =
  | { t: 'handle'; of: 'face' | 'edge' | 'vertex' | 'body'; n: number; text: string }
  | { t: 'selection' }
  | {
      t: 'role';
      of: 'face';
      feature: Named;
      /** A role of LABEL_ROLES (another word reads too: resolving it answers unknown_role with the feature's roles). */
      role: string;
      /** The detail as labels canonicalise it (stored ids, 1-based numbers, an inner face's key), or null for any. */
      detail: string | null;
      /** ~k (1-based), or null. */
      k: number | null;
      text: string;
    }
  | { t: 'query'; of: 'face' | 'edge' | 'vertex'; scope: Scope; filters: Filter[]; text: string }
  | { t: 'at'; of: 'face' | 'edge' | 'vertex'; body: Named | null; p: Vec3; text: string }
  | { t: 'edges-of'; of: 'edge'; face: Sel; filters: Filter[]; text: string }
  | { t: 'pair'; of: 'edge'; a: Sel; b: Sel; text: string }
  | { t: 'body'; of: 'body'; body: Named }
  | { t: 'bodies-of'; of: 'body'; feature: Named }
  | { t: 'all-bodies'; of: 'body' }
  | { t: 'plane'; of: 'plane'; base: PlaneBase; offset: string | null; flip: boolean; text: string }
  | { t: 'axis'; of: 'axis'; base: AxisBase; text: string }
  | { t: 'region'; of: 'region'; sketch: Named | null; which: RegionWhich; text: string };

/** A selector that does not read: where (1-based column) and why. */
export class SelectorSyntaxError extends Error {
  constructor(
    message: string,
    readonly column: number,
    readonly text: string,
  ) {
    super(message);
    this.name = 'SelectorSyntaxError';
  }
}

const FACE_TYPES = ['plane', 'cylinder', 'cone', 'sphere', 'torus', 'bspline'];
const EDGE_TYPES = ['line', 'circle', 'ellipse', 'bspline'];
const FILTER_WORDS = ['hole', 'boss', 'largest', 'smallest', 'radius', 'nearest', 'fillet'];
/** What a size-taking filter's refusal words show when no size was written. */
const SIZE_EXAMPLE: Record<'fillet' | 'hole' | 'radius', string> = { fillet: '2 mm', hole: '6 mm', radius: '3 mm' };
const ORIGIN_PLANES: Record<string, OriginPlane> = { top: 'origin:top', xy: 'origin:top', front: 'origin:front', xz: 'origin:front', right: 'origin:right', yz: 'origin:right' };
const PLANE_WORDS: Record<OriginPlane, string> = { 'origin:top': 'Top', 'origin:front': 'Front', 'origin:right': 'Right' };
const AXES: Record<string, { axis: OriginAxis; dir: Vec3 }> = { x: { axis: 'origin:x', dir: [1, 0, 0] }, y: { axis: 'origin:y', dir: [0, 1, 0] }, z: { axis: 'origin:z', dir: [0, 0, 1] } };
const KIND_OF_HANDLE: Record<string, 'face' | 'edge' | 'vertex' | 'body'> = { f: 'face', e: 'edge', v: 'vertex', b: 'body' };
const SKETCH = 'sketch';

type R<T> = { v: T; at: number } | null;

const isWordChar = (c: string | undefined) => !!c && /[A-Za-z0-9_]/.test(c);

class Parser {
  private readonly lower: string;
  private errAt = -1;
  private errMsg = '';
  private errRank = 0;
  private readonly features: (FeatureRow & { low: string })[];
  private readonly bodies: (Named & { low: string })[];
  /** The scope an example in refusal words names when the query has none ("edges of ..."). */
  private readonly firstBody: string;

  constructor(
    readonly src: string,
    names: KnownNames,
  ) {
    this.lower = src.toLowerCase();
    const byLength = <T extends Named>(rows: readonly T[]) => rows.map((r) => ({ ...r, low: r.name.toLowerCase() })).sort((a, b) => b.low.length - a.low.length);
    this.features = byLength(names.features);
    this.bodies = byLength(names.bodies);
    this.firstBody = names.bodies[0]?.name ?? 'Body 1';
  }

  // ---------------------------------------------------------------- errors

  /** Record why the text does not read at `at`: the farthest place wins, then the more telling words (rank). */
  private fail(at: number, msg: string, rank = 0): null {
    if (at > this.errAt || (at === this.errAt && rank > this.errRank)) {
      this.errAt = at;
      this.errMsg = msg;
      this.errRank = rank;
    }
    return null;
  }

  error(fallback: string): SelectorSyntaxError {
    const at = Math.max(0, this.errAt);
    return new SelectorSyntaxError(this.errAt >= 0 ? this.errMsg : fallback, at + 1, this.src);
  }

  // ---------------------------------------------------------------- lexing

  sp(i: number): number {
    while (i < this.src.length && /\s/.test(this.src[i])) i++;
    return i;
  }

  end(i: number): boolean {
    return this.sp(i) >= this.src.length;
  }

  /** A keyword at i (case-insensitive, not followed by a word character): its end, or -1. */
  word(i: number, w: string): number {
    if (!this.lower.startsWith(w, i)) return -1;
    if (isWordChar(w[w.length - 1]) && isWordChar(this.src[i + w.length])) return -1;
    return i + w.length;
  }

  /** Several keywords separated by spaces ("all bodies", "edges of"). */
  words(i: number, ws: string): number {
    let at = i;
    for (const w of ws.split(' ')) {
      at = this.word(at, w);
      if (at < 0) return -1;
      at = this.sp(at);
    }
    // Leave the trailing spaces for the next part.
    let back = at;
    while (back > i && /\s/.test(this.src[back - 1])) back--;
    return back;
  }

  num(i: number): R<number> {
    const m = /^[+-]?(\d+(\.\d*)?|\.\d+)(e[+-]?\d+)?/i.exec(this.src.slice(i));
    if (!m) return this.fail(i, 'expected a number');
    return { v: Number(m[0]), at: i + m[0].length };
  }

  /** "(a, b[, c])" with `n` numbers. */
  tuple(i: number, n: number): R<number[]> {
    let at = this.sp(i);
    if (this.src[at] !== '(') return this.fail(at, `expected "(" and ${n} numbers`);
    const out: number[] = [];
    at++;
    for (let k = 0; k < n; k++) {
      at = this.sp(at);
      const v = this.num(at);
      if (!v) return null;
      out.push(v.v);
      at = this.sp(v.at);
      if (k < n - 1) {
        if (this.src[at] !== ',') return this.fail(at, `expected "," (${n} numbers in mm)`);
        at++;
      }
    }
    if (this.src[at] !== ')') return this.fail(at, `expected ")" after ${n} numbers`);
    return { v: out, at: at + 1 };
  }

  /** The known names (of `rows`) at i, longest first; a quoted name matches whole. */
  names<T extends Named & { low: string }>(i: number, rows: readonly T[], what: string): { row: T; at: number }[] {
    if (this.src[i] === '"') {
      let j = i + 1;
      let text = '';
      while (j < this.src.length && this.src[j] !== '"') {
        if (this.src[j] === '\\' && j + 1 < this.src.length) j++;
        text += this.src[j];
        j++;
      }
      if (j >= this.src.length) {
        this.fail(i, 'a quote is not closed');
        return [];
      }
      const low = text.toLowerCase();
      const hit = rows.filter((r) => r.low === low);
      if (!hit.length) this.fail(i, `nothing in this Part is called "${text}"`, 2);
      return hit.map((row) => ({ row, at: j + 1 }));
    }
    const out: { row: T; at: number }[] = [];
    for (const row of rows) {
      if (!row.low || !this.lower.startsWith(row.low, i)) continue;
      const after = this.src[i + row.low.length];
      if (isWordChar(row.low[row.low.length - 1]) && isWordChar(after)) continue;
      out.push({ row, at: i + row.low.length });
    }
    if (!out.length) this.fail(i, `no ${what} starts here`, 1);
    return out;
  }

  private plain(row: FeatureRow | Named): Named {
    return { id: row.id, name: row.name };
  }

  // ---------------------------------------------------------------- pieces

  handle(i: number, kinds: string): R<Sel> {
    const m = /^#([fevb])([1-9][0-9]*)(?![A-Za-z0-9_])/.exec(this.src.slice(i));
    if (!m) return this.fail(i, 'expected a handle such as #f3');
    if (!kinds.includes(m[1])) return this.fail(i, `${m[0]} is ${articled(KIND_OF_HANDLE[m[1]])}; this place takes ${kinds.split('').map((k) => articled(KIND_OF_HANDLE[k])).join(' or ')}`, 3);
    return { v: { t: 'handle', of: KIND_OF_HANDLE[m[1]], n: Number(m[2]), text: m[0] }, at: i + m[0].length };
  }

  selection(i: number): R<Sel> {
    const at = this.word(i, 'selection');
    return at < 0 ? this.fail(i, 'expected "selection"') : { v: { t: 'selection' }, at };
  }

  ax(i: number): R<Ax> {
    if (this.src[i] === '(') {
      const t = this.tuple(i, 3);
      if (!t) return null;
      const l = Math.hypot(t.v[0], t.v[1], t.v[2]);
      if (!(l > 0)) return this.fail(i, 'a direction cannot be (0, 0, 0)');
      return { v: { dir: [t.v[0] / l, t.v[1] / l, t.v[2] / l], text: this.src.slice(i, t.at) }, at: t.at };
    }
    const c = this.lower[i];
    if (c && AXES[c] && !isWordChar(this.src[i + 1])) return { v: { dir: [...AXES[c].dir] as Vec3, text: c.toUpperCase() }, at: i + 1 };
    return this.fail(i, 'expected X, Y, Z or (x, y, z)');
  }

  /** Where a filter could start (stops a size's expression). */
  private filterStarts(i: number): boolean {
    const c = this.src[i];
    if (!c) return true;
    if ('<>|%&'.includes(c)) return true;
    if (c === '#' && !/^#[fevb][1-9]/.test(this.src.slice(i))) return true;
    if ((c === '+' || c === '-') && /^[+-]([xyzXYZ](?![A-Za-z0-9_])|\()/.test(this.src.slice(i))) return true;
    return FILTER_WORDS.some((w) => this.word(i, w) >= 0);
  }

  /** Whether an axis (X, Y, Z or "(x, y, z)") starts at i: "fillet <Z" is a level filter after fillet, "fillet < 2 mm" is not. */
  private axisAt(i: number): boolean {
    return /^([xyzXYZ](?![A-Za-z0-9_])|\()/.test(this.src.slice(i));
  }

  /**
   * An expression's words from k (its first word's start), up to the next filter, "offset" (a
   * plane's), "&" (an edge's two faces) or a ")" it did not open, or the end: its end (k for none).
   */
  private exprFrom(k: number): number {
    let at = k;
    let end = k;
    let depth = 0;
    for (;;) {
      const s = at === k ? k : this.sp(at);
      if (s >= this.src.length || (s !== k && s === at)) break;
      const c = this.src[s];
      if (c === '&' || (c === ')' && depth === 0)) break;
      if (s !== k && (this.filterStarts(s) || this.word(s, 'offset') >= 0)) break;
      let e = s;
      let closed = false;
      while (e < this.src.length && !/\s/.test(this.src[e])) {
        if (this.src[e] === '(') depth++;
        else if (this.src[e] === ')') {
          if (depth === 0) {
            closed = true;
            break;
          }
          depth--;
        }
        e++;
      }
      if (e === s) break;
      end = e;
      at = e;
      if (closed) break;
    }
    return end;
  }

  /**
   * The size after fillet, hole or radius (i: just after the word): "<= EXPR", ">= EXPR", a plain
   * EXPR (equal), or none (the end, the next filter, "offset", "&", ")"). A bare < or > that is no
   * level filter ("fillet <Z" is fillet, then the nearest level along Z) is refused with words.
   */
  private size(i: number, word: 'fillet' | 'hole' | 'radius'): R<Size | null> {
    const s = this.sp(i);
    const none: R<Size | null> = { v: null, at: i };
    if (s >= this.src.length || s === i) return none;
    const two = this.src.slice(s, s + 2);
    if (two === '<=' || two === '>=') {
      const k = this.sp(s + 2);
      const e = k < this.src.length ? this.exprFrom(k) : k;
      if (e === k) return this.fail(k, `expected a size after "${word} ${two}" (${word} ${two} ${SIZE_EXAMPLE[word]})`, 3);
      return { v: { cmp: two, expr: this.src.slice(k, e).trim() }, at: e };
    }
    const c = this.src[s];
    if ((c === '<' || c === '>') && (word === 'radius' || !this.axisAt(s + 1))) {
      const k = this.sp(s + 1);
      const e = k < this.src.length ? this.exprFrom(k) : k;
      const typed = this.src.slice(k, e).trim() || SIZE_EXAMPLE[word];
      return this.fail(s, `write <= or >= after ${word} (<Z and >Z are levels): ${word} ${c}= ${typed}`, 3);
    }
    if (this.filterStarts(s) || this.word(s, 'offset') >= 0 || c === '&' || c === ')') return none;
    const e = this.exprFrom(s);
    return e === s ? none : { v: { cmp: '=', expr: this.src.slice(s, e).trim() }, at: e };
  }

  /** One filter at i. scope: the query's scope as written, for the examples in refusal words. */
  filter(i: number, of: 'face' | 'edge' | 'vertex', scope = ''): R<Filter> {
    const c = this.src[i];
    const col = i + 1;
    const cut = (at: number) => this.src.slice(i, at);
    const facesOf = `${scope || this.firstBody} faces`;
    if (c === '>' || c === '<') {
      const a = this.ax(i + 1);
      if (!a) return null;
      let at = a.at;
      let n = 1;
      if (this.src[at] === '[') {
        const m = /^\[\s*([0-9]+)\s*\]/.exec(this.src.slice(at));
        if (!m) return this.fail(at, 'expected [n] with n 1 or more');
        n = Number(m[1]);
        if (n < 1) return this.fail(at + 1, 'levels count from [1] (the farthest); [2] is the next');
        at += m[0].length;
      }
      return { v: { f: c, ax: a.v, n, col, text: cut(at) }, at };
    }
    if (c === '+' || c === '-') {
      if (of !== 'face') return this.fail(i, `${c}X filters faces by the way they face; for ${of}s use |X or #X`);
      const a = this.ax(i + 1);
      return a ? { v: { f: c, ax: a.v, col, text: cut(a.at) }, at: a.at } : null;
    }
    if (c === '|' || c === '#') {
      const a = this.ax(i + 1);
      return a ? { v: { f: c, ax: a.v, col, text: cut(a.at) }, at: a.at } : null;
    }
    if (c === '%') {
      const m = /^%([A-Za-z]+)/.exec(this.src.slice(i));
      const types = of === 'face' ? FACE_TYPES : of === 'edge' ? EDGE_TYPES : [];
      if (!m || !types.includes(m[1].toLowerCase())) return this.fail(i + 1, of === 'vertex' ? 'vertices have no type' : `expected %${types.join(', %')}`);
      return { v: { f: '%', type: m[1].toLowerCase(), col, text: m[0] }, at: i + m[0].length };
    }
    for (const w of ['hole', 'boss', 'largest', 'smallest'] as const) {
      const at = this.word(i, w);
      if (at < 0) continue;
      if (w === 'hole') {
        // A sized hole: whole drilled holes by their bore.
        const sz = this.size(at, 'hole');
        if (!sz) return null;
        if (sz.v) {
          const text = cut(sz.at);
          if (of !== 'face') return this.fail(i, `${text} filters faces: ${facesOf} ${text}`, 3);
          return { v: { f: 'sized-hole', size: sz.v, col, text }, at: sz.at };
        }
      }
      if ((w === 'hole' || w === 'boss') && of !== 'face') return this.fail(i, `${w} filters round faces`);
      if (of === 'vertex') return this.fail(i, `${w} does not apply to vertices`);
      return { v: { f: w, col, text: w }, at };
    }
    let at = this.word(i, 'fillet');
    if (at >= 0) {
      const sz = this.size(at, 'fillet');
      if (!sz) return null;
      const text = cut(sz.at);
      if (of !== 'face') return this.fail(i, `fillet filters faces: ${facesOf} ${sz.v ? text : 'fillet <= 2 mm'}`, 3);
      return { v: { f: 'fillet', size: sz.v, col, text }, at: sz.at };
    }
    at = this.word(i, 'radius');
    if (at >= 0) {
      if (of === 'vertex') return this.fail(i, 'radius does not apply to vertices');
      const sz = this.size(at, 'radius');
      if (!sz) return null;
      if (!sz.v) return this.fail(this.sp(at), 'expected a radius after "radius" ("3 mm", "<= 3 mm", "r")');
      return { v: { f: 'radius', expr: sz.v.expr, cmp: sz.v.cmp, col, text: cut(sz.at) }, at: sz.at };
    }
    at = this.word(i, 'nearest');
    if (at >= 0) {
      const t = this.tuple(at, 3);
      return t ? { v: { f: 'nearest', p: t.v as Vec3, col, text: cut(t.at) }, at: t.at } : null;
    }
    return this.fail(i, 'expected a filter (>Z, +Z, |Z, #Z, %plane, hole, largest, radius 3 mm, fillet <= 2 mm, nearest (x, y, z))');
  }

  filters(i: number, of: 'face' | 'edge' | 'vertex', scope = ''): R<Filter[]> {
    const out: Filter[] = [];
    let at = i;
    for (;;) {
      const j = this.sp(at);
      // The end, or no space before it: no more filters here.
      if (j >= this.src.length || j === at) return { v: out, at };
      const c = this.src[j];
      if (c === '&' || c === ')') return { v: out, at };
      // "offset" (a plane from a face) ends a face's filters.
      if (this.word(j, 'offset') >= 0) return { v: out, at };
      const f = this.filter(j, of, scope);
      if (!f) return null;
      out.push(f.v);
      at = f.at;
    }
  }

  /** SCOPE faces|edges|vertices FILTER* (no filters with `bare`: the words up to "faces"). */
  query(i: number, of: 'face' | 'edge' | 'vertex', bare = false): R<Sel> {
    const word = of === 'face' ? 'faces' : of === 'edge' ? 'edges' : 'vertices';
    const after = (scope: Scope, at: number): R<Sel> => {
      const s = this.sp(at);
      if (s === at && at < this.src.length) return this.fail(at, `expected " ${word}"`);
      const w = this.word(s, word);
      if (w < 0) return this.fail(s, `expected "${word}" after the scope`);
      const f = bare ? { v: [], at: w } : this.filters(w, of, this.src.slice(i, at).trim());
      return f ? { v: { t: 'query', of, scope, filters: f.v, text: this.src.slice(i, f.at).trim() }, at: f.at } : null;
    };
    let at = this.word(i, 'all');
    if (at >= 0) {
      const r = after({ s: 'all' }, at);
      if (r) return r;
    }
    at = this.word(i, 'feature');
    if (at >= 0) {
      const s = this.sp(at);
      for (const c of this.names(s, this.features, 'feature')) {
        const r = after({ s: 'feature', feature: this.plain(c.row) }, c.at);
        if (r) return r;
      }
    }
    // A plain name: the body that has it, else the feature.
    const cands = [...this.names(i, this.bodies, 'body').map((c) => ({ at: c.at, scope: { s: 'body', body: this.plain(c.row) } as Scope })), ...this.names(i, this.features, 'feature').map((c) => ({ at: c.at, scope: { s: 'feature', feature: this.plain(c.row) } as Scope }))];
    cands.sort((a, b) => b.at - a.at);
    for (const c of cands) {
      const r = after(c.scope, c.at);
      if (r) return r;
    }
    return this.fail(i, `expected a body, "feature <name>" or "all", then "${word}"`);
  }

  /** [BODY] face|edge|vertex at (x, y, z). */
  at(i: number, of: 'face' | 'edge' | 'vertex'): R<Sel> {
    const tail = (body: Named | null, from: number): R<Sel> => {
      const s = this.sp(from);
      const w = this.word(s, of);
      if (w < 0) return this.fail(s, `expected "${of} at (x, y, z)"`);
      const a = this.word(this.sp(w), 'at');
      if (a < 0) return this.fail(this.sp(w), 'expected "at (x, y, z)"');
      const t = this.tuple(a, 3);
      return t ? { v: { t: 'at', of, body, p: t.v as Vec3, text: this.src.slice(i, t.at).trim() }, at: t.at } : null;
    };
    const direct = tail(null, i);
    if (direct) return direct;
    for (const c of this.names(i, this.bodies, 'body')) {
      if (this.sp(c.at) === c.at) continue;
      const r = tail(this.plain(c.row), c.at);
      if (r) return r;
    }
    return null;
  }

  /** The text of a role's detail: balanced brackets after "(". */
  private detailText(i: number): R<string> {
    let depth = 0;
    for (let j = i; j < this.src.length; j++) {
      const c = this.src[j];
      if (c === '(') depth++;
      else if (c === ')') {
        if (depth === 0) return { v: this.src.slice(i, j).trim(), at: j + 1 };
        depth--;
      }
    }
    return this.fail(i - 1, 'a "(" is not closed');
  }

  /** FEATURE.ROLE[(DETAIL)][~k]. */
  role(i: number): R<Sel> {
    for (const c of this.names(i, this.features, 'feature')) {
      if (this.src[c.at] !== '.') {
        this.fail(c.at, `expected "." and a role after ${c.row.name} (${LABEL_ROLES.join(', ')})`);
        continue;
      }
      const r = this.roleAfter(i, c.row, c.at + 1);
      if (r) return r;
    }
    return null;
  }

  private roleAfter(start: number, feature: FeatureRow, i: number): R<Sel> {
    const m = /^([A-Za-z]+)/.exec(this.src.slice(i));
    const role = m ? m[1].toLowerCase() : null;
    if (!role || isWordChar(this.src[i + m![0].length])) return this.fail(i, `expected a role: ${LABEL_ROLES.join(', ')}`);
    let at = i + m![0].length;
    let detail: string | null = null;
    if (this.src[at] === '(') {
      const d = this.detailText(at + 1);
      if (!d) return null;
      const canon = this.canonDetail(role, d.v, at + 1);
      if (canon === null) return null;
      detail = canon;
      at = d.at;
    }
    let k: number | null = null;
    if (this.src[at] === '~') {
      const km = /^~([0-9]+)/.exec(this.src.slice(at));
      if (!km || Number(km[1]) < 1) return this.fail(at + 1, 'expected ~k with k 1 or more');
      k = Number(km[1]);
      at += km[0].length;
    }
    if (isWordChar(this.src[at])) return this.fail(at, 'unexpected text after the role');
    return { v: { t: 'role', of: 'face', feature: this.plain(feature), role, detail, k, text: this.src.slice(start, at) }, at };
  }

  /** A role's detail as labels.ts canonicalises it, or null (an error recorded at `col`). */
  private canonDetail(role: string, d: string, col: number): string | null {
    const bad = (what: string) => this.fail(col, `${role}(...) takes ${what}`);
    switch (role) {
      case 'start':
      case 'end':
      case 'fillet':
      case 'chamfer':
        return /^[1-9][0-9]*$/.test(d) ? String(Number(d)) : bad(role === 'start' || role === 'end' ? 'a profile number from 1' : 'a number from 1');
      case 'side': {
        const m = /^([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)?)(?:\s*@\s*([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)?))?$/.exec(d);
        if (!m) return bad('a sketch entity or its part (l2, r.top, p.3; a sweep side o@a2)');
        return `${storedId(m[1]).toLowerCase()}${m[2] ? `@${storedId(m[2]).toLowerCase()}` : ''}`;
      }
      case 'copy':
        return /^-?\d+(\.-?\d+)?$/.test(d) ? d : bad("a copy's key (2, 3.1, -1)");
      case 'import':
        return /^[1-9]\d*(\.[1-9]\d*)?$/.test(d) ? d : bad('a face number from 1');
      case 'enclosure':
        return /^[+-]?[A-Za-z-]+$/.test(d) ? d.toLowerCase() : bad('a side (+x, -z, top, side)');
      case 'inner': {
        const inner = new Parser(d, { features: this.features, bodies: [] });
        const r = inner.role(0);
        if (!r || !inner.end(r.at)) return bad("the label of the face it was offset from (Base.end)");
        const s = r.v as Extract<Sel, { t: 'role' }>;
        return `${s.feature.id}\u0000${s.role}\u0000${s.detail ?? ''}`;
      }
      case 'cut':
      case 'heal':
      case 'mirror':
        return bad('no detail');
      default:
        // Not a role: resolving it says which roles the feature has.
        return d;
    }
  }

  // ---------------------------------------------------------------- selectors

  face(i: number): R<Sel> {
    return this.first(i, [() => this.handle(i, 'f'), () => this.selection(i), () => this.at(i, 'face'), () => this.role(i), () => this.query(i, 'face')]);
  }

  edge(i: number): R<Sel> {
    return this.first(i, [() => this.handle(i, 'e'), () => this.selection(i), () => this.edgesOf(i), () => this.at(i, 'edge'), () => this.pair(i), () => this.query(i, 'edge')]);
  }

  vertex(i: number): R<Sel> {
    return this.first(i, [() => this.handle(i, 'v'), () => this.selection(i), () => this.at(i, 'vertex'), () => this.query(i, 'vertex')]);
  }

  private edgesOf(i: number): R<Sel> {
    const at = this.words(i, 'edges of');
    if (at < 0) return this.fail(i, 'expected "edges of <face>"');
    const s = this.sp(at);
    const withFilters = (face: Sel, from: number): R<Sel> => {
      const fl = this.filters(from, 'edge');
      return fl ? { v: { t: 'edges-of', of: 'edge', face, filters: fl.v, text: this.src.slice(i, fl.at).trim() }, at: fl.at } : null;
    };
    // Any face in brackets (a query with its own filters): the filters after them are the edges'.
    if (this.src[s] === '(') {
      const f = this.face(this.sp(s + 1));
      if (f) {
        const close = this.sp(f.at);
        if (this.src[close] === ')') {
          const r = withFilters(f.v, close + 1);
          if (r) return r;
        } else this.fail(close, 'expected ")" after the face', 2);
      }
    }
    for (const alt of [() => this.handle(s, 'f'), () => this.selection(s), () => this.at(s, 'face'), () => this.role(s)]) {
      const f = alt();
      if (!f) continue;
      const r = withFilters(f.v, f.at);
      if (r) return r;
    }
    // A face query written bare: with nothing after "faces" it is every face of the scope; a filter
    // after it could be the faces' or the edges', so the brackets must say which.
    const q = this.query(s, 'face', true);
    if (!q) return null;
    const next = this.sp(q.at);
    if (next < this.src.length && next > q.at && this.src[next] !== '&' && this.src[next] !== ')') {
      const query = this.src.slice(s, q.at).trim();
      const rest = this.src.slice(next).trim();
      return this.fail(next, `put a face query in brackets here, the faces' filters inside and the edges' after them: "edges of (${query} ${rest})" takes every edge of those faces, "edges of (${query}) ${rest}" filters the edges`, 3);
    }
    return withFilters(q.v, q.at);
  }

  private pair(i: number): R<Sel> {
    const a = this.face(i);
    if (!a) return null;
    const amp = this.sp(a.at);
    if (this.src[amp] !== '&') return this.fail(amp, 'expected "&" between two faces');
    const b = this.face(this.sp(amp + 1));
    return b ? { v: { t: 'pair', of: 'edge', a: a.v, b: b.v, text: this.src.slice(i, b.at).trim() }, at: b.at } : null;
  }

  body(i: number): R<Sel> {
    return this.first(i, [
      () => this.handle(i, 'b'),
      () => this.selection(i),
      () => {
        const at = this.words(i, 'all bodies');
        return at < 0 ? this.fail(i, 'expected "all bodies"') : { v: { t: 'all-bodies', of: 'body' }, at };
      },
      () => {
        const at = this.words(i, 'bodies of');
        if (at < 0) return this.fail(i, 'expected "bodies of <feature>"');
        const s = this.sp(at);
        const c = this.names(s, this.features, 'feature')[0];
        return c ? { v: { t: 'bodies-of', of: 'body', feature: this.plain(c.row) }, at: c.at } : null;
      },
      () => {
        const at = this.word(i, 'bodies');
        return at < 0 || !this.end(at) ? this.fail(i, 'expected "bodies"') : { v: { t: 'all-bodies', of: 'body' }, at };
      },
      () => {
        const out = this.names(i, this.bodies, 'body').map((c) => ({ v: { t: 'body', of: 'body', body: this.plain(c.row) } as Sel, at: c.at }));
        return out.find((o) => this.end(o.at)) ?? out[0] ?? null;
      },
    ]);
  }

  plane(i: number): R<Sel> {
    const bases: (() => R<PlaneBase>)[] = [
      () => {
        const m = /^(top|front|right|xy|xz|yz)(?![A-Za-z0-9_])/i.exec(this.src.slice(i));
        if (!m) return this.fail(i, 'expected Top, Front, Right, a construction plane or a flat face');
        const plane = ORIGIN_PLANES[m[1].toLowerCase()];
        return { v: { b: 'origin', plane, word: PLANE_WORDS[plane] }, at: i + m[0].length };
      },
      () => {
        const c = this.names(i, this.features.filter((f) => f.type === 'ref_plane'), 'construction plane');
        return c.length ? { v: { b: 'feature', feature: this.plain(c[0].row) }, at: c[0].at } : null;
      },
      () => {
        const f = this.face(i);
        return f ? { v: { b: 'face', face: f.v }, at: f.at } : null;
      },
    ];
    for (const base of bases) {
      const b = base();
      if (!b) continue;
      const tail = this.planeTail(b.at);
      if (!tail) continue;
      return { v: { t: 'plane', of: 'plane', base: b.v, offset: tail.v.offset, flip: tail.v.flip, text: this.src.slice(i, tail.at).trim() }, at: tail.at };
    }
    return null;
  }

  /** [offset EXPR [flip]] up to the end. */
  private planeTail(i: number): R<{ offset: string | null; flip: boolean }> {
    const s = this.sp(i);
    if (s >= this.src.length) return { v: { offset: null, flip: false }, at: i };
    const at = s > i ? this.word(s, 'offset') : -1;
    if (at < 0) return this.fail(s, 'expected "offset <length>" or the end');
    let rest = this.src.slice(at).trim();
    let flip = false;
    const m = /\s+flip$/i.exec(rest);
    if (m) {
      flip = true;
      rest = rest.slice(0, m.index).trim();
    }
    if (!rest) return this.fail(at, 'expected a length after "offset" ("12 mm", "t")');
    return { v: { offset: rest, flip }, at: this.src.length };
  }

  axis(i: number): R<Sel> {
    const wrap = (base: AxisBase, at: number): R<Sel> => ({ v: { t: 'axis', of: 'axis', base, text: this.src.slice(i, at).trim() }, at });
    return this.first(i, [
      () => {
        const m = /^([xyz])(\s+axis)?(?![A-Za-z0-9_])/i.exec(this.src.slice(i));
        if (!m) return this.fail(i, 'expected X axis, Y axis or Z axis');
        const a = AXES[m[1].toLowerCase()];
        return wrap({ b: 'origin', axis: a.axis, word: `${m[1].toUpperCase()} axis` }, i + m[0].length);
      },
      () => {
        const at = this.words(i, 'axis of');
        if (at < 0) return this.fail(i, 'expected "axis of <round face>"');
        const f = this.face(this.sp(at));
        return f ? wrap({ b: 'face-axis', face: f.v }, f.at) : null;
      },
      () => {
        const at = this.words(i, 'normal of');
        if (at < 0) return this.fail(i, 'expected "normal of <plane>"');
        const p = this.plane(this.sp(at));
        return p ? wrap({ b: 'normal', plane: p.v }, p.at) : null;
      },
      () => {
        for (const c of this.names(i, this.features.filter((f) => f.type === SKETCH), 'sketch')) {
          if (this.src[c.at] !== '.') continue;
          const m = /^([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)?)(?![A-Za-z0-9_.])/.exec(this.src.slice(c.at + 1));
          if (!m) {
            this.fail(c.at + 1, 'expected a line of the sketch (its id, or a part such as r.left)');
            continue;
          }
          return wrap({ b: 'sketch-line', sketch: this.plain(c.row), entity: storedId(m[1]).toLowerCase(), text: m[1] }, c.at + 1 + m[0].length);
        }
        return null;
      },
      () => {
        const c = this.names(i, this.features.filter((f) => f.type === 'ref_axis'), 'construction axis');
        return c.length ? wrap({ b: 'feature', feature: this.plain(c[0].row) }, c[0].at) : null;
      },
      () => {
        const e = this.edge(i);
        return e ? wrap({ b: 'edge', edge: e.v }, e.at) : null;
      },
    ]);
  }

  region(i: number): R<Sel> {
    const which = (sketch: Named | null, from: number): R<Sel> => {
      const s = this.sp(from);
      const wrap = (w: RegionWhich, at: number): R<Sel> => ({ v: { t: 'region', of: 'region', sketch, which: w, text: this.src.slice(i, at).trim() }, at });
      if (sketch && s >= this.src.length) return wrap({ w: 'all' }, from);
      if (sketch && s === from) return this.fail(from, 'expected a space and a region after the sketch');
      for (const [w, kind] of [
        ['regions', 'regions'],
        ['all', 'all'],
        ['largest', 'largest'],
      ] as const) {
        const at = this.word(s, w);
        if (at >= 0 && this.end(at)) return wrap({ w: kind }, at);
      }
      const r = /^r([1-9][0-9]*)(?![A-Za-z0-9_])/i.exec(this.src.slice(s));
      if (r && this.end(s + r[0].length)) return wrap({ w: 'r', n: Number(r[1]) }, s + r[0].length);
      const at = this.word(s, 'at');
      if (at >= 0) {
        const t = this.tuple(at, 2);
        return t ? wrap({ w: 'at', uv: t.v as Vec2 }, t.at) : null;
      }
      // A region's key, as get_model and find never show it but a tool may keep it.
      const key = this.src.slice(s).trim();
      if (/^[+-]/.test(key) && key.includes('[')) return wrap({ w: 'key', key }, this.src.length);
      return this.fail(s, 'expected all, largest, r<N> or at(u, v)');
    };
    for (const c of this.names(i, this.features.filter((f) => f.type === SKETCH), 'sketch')) {
      const r = which(this.plain(c.row), c.at);
      if (r) return r;
    }
    return which(null, i);
  }

  /** The alternative that reads the most text (the earlier one on a tie). */
  first<T>(i: number, alts: (() => R<T>)[]): R<T> {
    void i;
    let best: R<T> = null;
    for (const alt of alts) {
      const r = alt();
      if (r && (!best || r.at > best.at)) best = r;
    }
    return best;
  }

  /** The first alternative that reads the whole text. */
  whole(alts: (() => R<Sel>)[]): Sel | null {
    for (const alt of alts) {
      const r = alt();
      if (r && this.end(r.at)) return r.v;
      if (r) this.fail(this.sp(r.at), 'unexpected text here');
    }
    return null;
  }
}

const articled = (k: string) => (k === 'edge' ? 'an edge' : `a ${k}`);

/** What `want` reads, as words for an error. */
const WANT_WORDS: Record<Want, string> = {
  face: 'a face selector',
  edge: 'an edge selector',
  vertex: 'a vertex selector',
  body: 'a body',
  plane: 'a plane',
  axis: 'an axis',
  region: 'a region',
  any: 'a selector',
};

/**
 * Read `text` as a selector for `want`. Throws SelectorSyntaxError (with a 1-based column) when it
 * does not read. 'any' (find) tries every kind, in this order: handles and selection, bodies,
 * sketch regions, edges, vertices, faces, planes, axes.
 */
export function parseSelector(text: string, names: KnownNames, want: Want): Sel {
  const src = text;
  if (!src.trim()) throw new SelectorSyntaxError(`${WANT_WORDS[want]} is needed here, not ""`, 1, src);
  const p = new Parser(src, names);
  const i = p.sp(0);
  const alts: Record<Exclude<Want, 'any'>, () => ReturnType<Parser['face']>> = {
    face: () => p.face(i),
    edge: () => p.edge(i),
    vertex: () => p.vertex(i),
    body: () => p.body(i),
    plane: () => p.plane(i),
    axis: () => p.axis(i),
    region: () => p.region(i),
  };
  const order: Exclude<Want, 'any'>[] = want === 'any' ? ['body', 'region', 'edge', 'vertex', 'face', 'plane', 'axis'] : [want];
  const list = order.map((w) => alts[w]);
  if (want === 'any') {
    // Handles and selection name their own kind.
    list.unshift(
      () => p.handle(i, 'fevb'),
      () => p.selection(i),
    );
  }
  const sel = p.whole(list);
  if (sel) return sel;
  throw p.error(`"${src}" is not ${WANT_WORDS[want]}`);
}
