// An SVG drawing as curves (common.ts DrawingCurve), read as data only: a small XML tokenizer of
// its own (no DOMParser, nothing put in the page, nothing rendered, nothing fetched), entity
// declarations never expanded (a "billion laughs" file is just counted), character references
// decoded in attribute values only. Drawn: path (M L H V C S Q T A Z, absolute and relative),
// line, polyline, polygon, rect (rx/ry rounding as the spec's path), circle and ellipse, in g, a
// and nested svg, every transform (matrix, translate, scale, rotate, skewX, skewY) applied exactly;
// y flipped so the drawing reads the right way up in the sketch. Cubic Beziers are degree-3 sketch
// splines, quadratic ones raised to degree 3 (the same curves); arcs and circles are circles or
// circular arcs when the transform keeps them round, else ellipses or arcs of one. Counted and
// left out: script, foreignObject, style, image, use, text, defs/symbol/clipPath/mask/pattern/
// marker content, hidden elements (display none), unknown elements, event attributes (on...),
// links to other files (href to anything but #id), entity declarations and references.
// Units: the root's width/height (mm, cm, in, pt, pc, or px at 96 per inch) over its viewBox give
// mm per user unit; else a user unit is a CSS px (96 per inch).
// SPDX-License-Identifier: GPL-3.0-or-later
import type { Vec2 } from '../../types/doc';
import { applyLinear, applyMat, conicPiece, cubic, DrawingRefused, elevate, finiteCurve, IDENTITY, mul, READ_MAX_CURVES, sig, skip, type Drawing, type DrawingCurve, type Mat2 } from './common';

type V2 = Vec2;

/** How deep elements may nest before the rest is skipped. */
const MAX_DEPTH = 256;
/** A length longer than this is unreadable; a transform list longer than MAX_TRANSFORM too (no real one is). */
const MAX_LENGTH = 256;
const MAX_TRANSFORM = 4096;

/** User units per unit of an SVG length (CSS: 96 px per inch). */
const PER_UNIT: Readonly<Record<string, number>> = { '': 1, px: 1, mm: 96 / 25.4, cm: 96 / 2.54, in: 96, pt: 96 / 72, pc: 16, q: 96 / 101.6 };
const MM_PER_PX = 25.4 / 96;

interface Tag {
  name: string;
  attrs: Record<string, string>;
  selfClosing: boolean;
}

const BUILTIN: Readonly<Record<string, string>> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

/** An attribute value with its character references decoded; a declared entity is left as written (counted). */
function decode(v: string, skipped: Record<string, number>): string {
  if (!v.includes('&')) return v;
  return v.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z_][\w.-]*);/g, (m, ref: string) => {
    if (ref[0] === '#') {
      const n = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
    }
    if (BUILTIN[ref] !== undefined) return BUILTIN[ref];
    skip(skipped, 'entityRef');
    return m;
  });
}

/** The tags of an XML text in order (comments, CDATA, processing instructions and DOCTYPE stepped over). */
function tokenize(text: string, skipped: Record<string, number>, on: (t: Tag | { close: string }) => void): void {
  const n = text.length;
  let i = 0;
  while (i < n) {
    const lt = text.indexOf('<', i);
    if (lt < 0) break;
    i = lt;
    if (text.startsWith('<!--', i)) {
      const k = text.indexOf('-->', i + 4);
      i = k < 0 ? n : k + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', i)) {
      const k = text.indexOf(']]>', i + 9);
      i = k < 0 ? n : k + 3;
      continue;
    }
    if (text.startsWith('<?', i)) {
      const k = text.indexOf('?>', i + 2);
      i = k < 0 ? n : k + 2;
      continue;
    }
    if (text.startsWith('<!', i)) {
      // DOCTYPE (and its internal subset): every entity declaration counted, none expanded.
      let k = i + 2;
      let quote = '';
      let subset = false;
      for (; k < n; k++) {
        const ch = text[k];
        if (quote) {
          if (ch === quote) quote = '';
        } else if (ch === '"' || ch === "'") quote = ch;
        else if (ch === '[') subset = true;
        else if (ch === ']') subset = false;
        else if (ch === '<' && text.startsWith('<!ENTITY', k)) skip(skipped, 'entity');
        else if (ch === '<' && text.startsWith('<!--', k)) {
          const e = text.indexOf('-->', k + 4);
          k = e < 0 ? n : e + 2;
        } else if (ch === '>' && !subset) break;
      }
      i = k + 1;
      continue;
    }
    if (text[i + 1] === '/') {
      const k = text.indexOf('>', i + 2);
      if (k < 0) break;
      on({ close: text.slice(i + 2, k).trim() });
      i = k + 1;
      continue;
    }
    // A start tag: its name, then attributes.
    let k = i + 1;
    while (k < n && !/[\s/>]/.test(text[k])) k++;
    const name = text.slice(i + 1, k);
    if (!name) {
      i = k + 1;
      continue;
    }
    const attrs: Record<string, string> = {};
    let selfClosing = false;
    let ended = false;
    while (k < n) {
      while (k < n && /\s/.test(text[k])) k++;
      if (text[k] === '>') {
        k++;
        ended = true;
        break;
      }
      if (text[k] === '/' && text[k + 1] === '>') {
        k += 2;
        selfClosing = true;
        ended = true;
        break;
      }
      const a0 = k;
      while (k < n && !/[\s=/>]/.test(text[k])) k++;
      const an = text.slice(a0, k);
      if (!an) {
        k++;
        continue;
      }
      while (k < n && /\s/.test(text[k])) k++;
      let value = '';
      if (text[k] === '=') {
        k++;
        while (k < n && /\s/.test(text[k])) k++;
        const q = text[k];
        if (q === '"' || q === "'") {
          const e = text.indexOf(q, k + 1);
          if (e < 0) {
            k = n;
            break;
          }
          value = text.slice(k + 1, e);
          k = e + 1;
        } else {
          const v0 = k;
          while (k < n && !/[\s>]/.test(text[k])) k++;
          value = text.slice(v0, k);
        }
      }
      attrs[an] = decode(value, skipped);
    }
    if (!ended) break;
    on({ name, attrs, selfClosing });
    i = k;
  }
}

// ------------------------------------------------------------ numbers, lengths, transforms

// One way only to read a number's digits (no pattern that can split a run of digits two ways: a
// long bad value is read in a time that grows with its length, not its square).
const NUM = /[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?/y;

/** The numbers in a list ("10, 20 30-5e1"), or null when anything else is there (or one is not finite: 1e999). */
function numbers(s: string): number[] | null {
  const out: number[] = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    while (i < n && /[\s,]/.test(s[i])) i++;
    if (i >= n) break;
    NUM.lastIndex = i;
    const m = NUM.exec(s);
    if (!m) return null;
    const x = Number(m[0]);
    if (!Number.isFinite(x)) return null;
    out.push(x);
    i = NUM.lastIndex;
  }
  return out;
}

/** An SVG length's number and unit ("10mm": 10 and "mm"), or null when it cannot be read (too long, not a number, not finite). */
function lengthParts(v: string): { n: number; unit: string } | null {
  if (v.length > MAX_LENGTH) return null;
  const m = /^\s*([-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?)\s*([a-zA-Z%]*)\s*$/.exec(v);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? { n, unit: m[2].toLowerCase() } : null;
}

/** An SVG length in user units ("10", "10mm", "2.5in"), null when missing, NaN when unreadable (%, em). */
function length(v: string | undefined): number | null {
  if (v === undefined) return null;
  const l = lengthParts(v);
  const per = l ? PER_UNIT[l.unit] : undefined;
  return l && per !== undefined ? l.n * per : NaN;
}

/** A transform list as one matrix (the leftmost applied last); null when it cannot be read. */
export function parseTransform(v: string | undefined): Mat2 | null {
  if (!v || !v.trim()) return IDENTITY;
  if (v.length > MAX_TRANSFORM) return null;
  let m: Mat2 = IDENTITY;
  const re = /([a-zA-Z]+)\s*\(([^)]*)\)/y;
  let i = 0;
  const s = v.trim();
  while (i < s.length) {
    // The separators between transforms (spaces, one comma) stepped over by hand: no pattern backtracks over them.
    while (i < s.length && /\s/.test(s[i])) i++;
    if (s[i] === ',') i++;
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;
    re.lastIndex = i;
    const t = re.exec(s);
    if (!t) return null;
    i = re.lastIndex;
    const a = numbers(t[2]);
    if (!a) return null;
    const rad = (d: number) => (d * Math.PI) / 180;
    let k: Mat2;
    switch (t[1]) {
      case 'matrix':
        if (a.length !== 6) return null;
        k = [a[0], a[1], a[2], a[3], a[4], a[5]];
        break;
      case 'translate':
        if (a.length < 1 || a.length > 2) return null;
        k = [1, 0, 0, 1, a[0], a[1] ?? 0];
        break;
      case 'scale':
        if (a.length < 1 || a.length > 2) return null;
        k = [a[0], 0, 0, a[1] ?? a[0], 0, 0];
        break;
      case 'rotate': {
        if (a.length !== 1 && a.length !== 3) return null;
        const c = Math.cos(rad(a[0]));
        const sn = Math.sin(rad(a[0]));
        const r: Mat2 = [c, sn, -sn, c, 0, 0];
        k = a.length === 3 ? mul(mul([1, 0, 0, 1, a[1], a[2]], r), [1, 0, 0, 1, -a[1], -a[2]]) : r;
        break;
      }
      case 'skewX':
        if (a.length !== 1) return null;
        k = [1, 0, Math.tan(rad(a[0])), 1, 0, 0];
        break;
      case 'skewY':
        if (a.length !== 1) return null;
        k = [1, Math.tan(rad(a[0])), 0, 1, 0, 0];
        break;
      default:
        return null;
    }
    m = mul(m, k);
  }
  // A transform that overflows (scale(1e200) scale(1e200)) draws nothing readable.
  return m.every(Number.isFinite) ? m : null;
}

/** A nested svg's (or the root's) viewBox mapping into its viewport, by preserveAspectRatio. */
function viewportMap(attrs: Record<string, string>, w: number | null, h: number | null): Mat2 | null {
  const vb = attrs.viewBox !== undefined ? numbers(attrs.viewBox) : null;
  if (!vb || vb.length !== 4 || !(vb[2] > 0) || !(vb[3] > 0) || w === null || h === null || !(w > 0) || !(h > 0)) return vb && vb.length === 4 ? [1, 0, 0, 1, -vb[0], -vb[1]] : IDENTITY;
  const par = (attrs.preserveAspectRatio ?? '').trim().split(/\s+/);
  let sx = w / vb[2];
  let sy = h / vb[3];
  if (par[0] !== 'none') {
    const s = par[1] === 'slice' ? Math.max(sx, sy) : Math.min(sx, sy);
    const align = par[0] || 'xMidYMid';
    const ax = /xMid/.test(align) ? 0.5 : /xMax/.test(align) ? 1 : 0;
    const ay = /YMid/.test(align) ? 0.5 : /YMax/.test(align) ? 1 : 0;
    const tx = (w - vb[2] * s) * ax;
    const ty = (h - vb[3] * s) * ay;
    sx = s;
    sy = s;
    return [sx, 0, 0, sy, tx - vb[0] * sx, ty - vb[1] * sy];
  }
  return [sx, 0, 0, sy, -vb[0] * sx, -vb[1] * sy];
}

// ------------------------------------------------------------ path data

/** One path's curves, in user units under `m` (the flip included). Null when its data cannot be read. */
function pathCurves(d: string, m: Mat2, out: DrawingCurve[]): boolean {
  const P = (p: V2) => applyMat(m, p);
  let i = 0;
  const n = d.length;
  const ws = () => {
    while (i < n && /[\s,]/.test(d[i])) i++;
  };
  const num = (): number | null => {
    ws();
    NUM.lastIndex = i;
    const r = NUM.exec(d);
    if (!r) return null;
    i = NUM.lastIndex;
    const x = Number(r[0]);
    return Number.isFinite(x) ? x : null;
  };
  const flag = (): number | null => {
    ws();
    const ch = d[i];
    if (ch !== '0' && ch !== '1') return null;
    i++;
    return ch === '1' ? 1 : 0;
  };
  let cur: V2 = [0, 0];
  let start: V2 = [0, 0];
  let lastC: V2 | null = null;
  let lastQ: V2 | null = null;
  let cmd = '';
  const line = (a: V2, b: V2) => {
    if (a[0] !== b[0] || a[1] !== b[1]) out.push({ kind: 'line', a: P(a), b: P(b) });
  };
  ws();
  while (i < n) {
    // Past the reading's cap: stop here (the caller refuses the file) before one long path fills the memory.
    if (out.length > READ_MAX_CURVES) return true;
    const ch = d[i];
    if (/[MmLlHhVvCcSsQqTtAaZz]/.test(ch)) {
      cmd = ch;
      i++;
    } else if (!cmd) return false;
    else if (cmd === 'Z' || cmd === 'z') return false;
    const rel = cmd === cmd.toLowerCase();
    const o: V2 = rel ? cur : [0, 0];
    switch (cmd.toUpperCase()) {
      case 'M': {
        const x = num();
        const y = num();
        if (x === null || y === null) return false;
        cur = [o[0] + x, o[1] + y];
        start = cur;
        // Pairs after a moveto are linetos.
        cmd = rel ? 'l' : 'L';
        lastC = lastQ = null;
        break;
      }
      case 'L': {
        const x = num();
        const y = num();
        if (x === null || y === null) return false;
        const p: V2 = [o[0] + x, o[1] + y];
        line(cur, p);
        cur = p;
        lastC = lastQ = null;
        break;
      }
      case 'H': {
        const x = num();
        if (x === null) return false;
        const p: V2 = [rel ? cur[0] + x : x, cur[1]];
        line(cur, p);
        cur = p;
        lastC = lastQ = null;
        break;
      }
      case 'V': {
        const y = num();
        if (y === null) return false;
        const p: V2 = [cur[0], rel ? cur[1] + y : y];
        line(cur, p);
        cur = p;
        lastC = lastQ = null;
        break;
      }
      case 'C':
      case 'S': {
        let c1: V2;
        if (cmd.toUpperCase() === 'C') {
          const x1 = num();
          const y1 = num();
          if (x1 === null || y1 === null) return false;
          c1 = [o[0] + x1, o[1] + y1];
        } else c1 = lastC ? [2 * cur[0] - lastC[0], 2 * cur[1] - lastC[1]] : cur;
        const x2 = num();
        const y2 = num();
        const x = num();
        const y = num();
        if (x2 === null || y2 === null || x === null || y === null) return false;
        const c2: V2 = [o[0] + x2, o[1] + y2];
        const p: V2 = [o[0] + x, o[1] + y];
        out.push(cubic([P(cur), P(c1), P(c2), P(p)]));
        lastC = c2;
        lastQ = null;
        cur = p;
        break;
      }
      case 'Q':
      case 'T': {
        let q: V2;
        if (cmd.toUpperCase() === 'Q') {
          const x1 = num();
          const y1 = num();
          if (x1 === null || y1 === null) return false;
          q = [o[0] + x1, o[1] + y1];
        } else q = lastQ ? [2 * cur[0] - lastQ[0], 2 * cur[1] - lastQ[1]] : cur;
        const x = num();
        const y = num();
        if (x === null || y === null) return false;
        const p: V2 = [o[0] + x, o[1] + y];
        // A quadratic raised to a cubic: the same curve.
        out.push(cubic(elevate([P(cur), P(q), P(p)])));
        lastQ = q;
        lastC = null;
        cur = p;
        break;
      }
      case 'A': {
        const rx = num();
        const ry = num();
        const phi = num();
        const fa = flag();
        const fs = flag();
        const x = num();
        const y = num();
        if (rx === null || ry === null || phi === null || fa === null || fs === null || x === null || y === null) return false;
        const p: V2 = [o[0] + x, o[1] + y];
        arcTo(cur, p, Math.abs(rx), Math.abs(ry), phi, fa === 1, fs === 1, m, out);
        cur = p;
        lastC = lastQ = null;
        break;
      }
      case 'Z': {
        line(cur, start);
        cur = start;
        lastC = lastQ = null;
        cmd = '';
        break;
      }
    }
    ws();
  }
  return true;
}

/** An SVG arc (endpoint form, spec F.6.5) under `m`: a line when a radius is 0, nothing when it has no length. */
function arcTo(p1: V2, p2: V2, rx: number, ry: number, phiDeg: number, large: boolean, sweep: boolean, m: Mat2, out: DrawingCurve[]): void {
  if (p1[0] === p2[0] && p1[1] === p2[1]) return;
  if (rx === 0 || ry === 0) {
    out.push({ kind: 'line', a: applyMat(m, p1), b: applyMat(m, p2) });
    return;
  }
  const phi = (phiDeg * Math.PI) / 180;
  const cs = Math.cos(phi);
  const sn = Math.sin(phi);
  const dx = (p1[0] - p2[0]) / 2;
  const dy = (p1[1] - p2[1]) / 2;
  const x1 = cs * dx + sn * dy;
  const y1 = -sn * dx + cs * dy;
  const lam = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lam > 1) {
    rx *= Math.sqrt(lam);
    ry *= Math.sqrt(lam);
  }
  const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
  const co = (large !== sweep ? 1 : -1) * Math.sqrt(Math.max(0, num / den));
  const cx1 = (co * rx * y1) / ry;
  const cy1 = (-co * ry * x1) / rx;
  const c: V2 = [cs * cx1 - sn * cy1 + (p1[0] + p2[0]) / 2, sn * cx1 + cs * cy1 + (p1[1] + p2[1]) / 2];
  const ang = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const t1 = ang(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
  let dt = ang((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  if (sweep && dt < 0) dt += 2 * Math.PI;
  const U: V2 = [rx * cs, rx * sn];
  const V: V2 = [-ry * sn, ry * cs];
  const piece = conicPiece(applyMat(m, c), applyLinear(m, U), applyLinear(m, V), t1, dt, [applyMat(m, p1), applyMat(m, p2)]);
  if (piece) out.push(piece);
}

// ------------------------------------------------------------ the document

/** Elements that never draw and are passed over quietly with their content. */
const QUIET = new Set(['title', 'desc', 'metadata', 'linearGradient', 'radialGradient', 'stop', 'filter', 'animate', 'animateMotion', 'animateTransform', 'set', 'mpath', 'view', 'cursor', 'font', 'font-face', 'glyph', 'missing-glyph', 'hkern', 'vkern', 'color-profile', 'feBlend']);
const SHAPES = new Set(['path', 'line', 'polyline', 'polygon', 'rect', 'circle', 'ellipse']);
const DEFS = new Set(['defs', 'symbol', 'clipPath', 'mask', 'pattern', 'marker']);
const GROUPS = new Set(['g', 'a', 'switch']);

/** Read an SVG file's text. */
export function readSvg(name: string, text: string): Drawing {
  const skipped: Record<string, number> = {};
  const notes: string[] = [];
  const curves: DrawingCurve[] = [];
  /** The flip: user y down, the sketch's v up. */
  const FLIP: Mat2 = [1, 0, 0, -1, 0, 0];
  /** The drawing elements open now (at most MAX_DEPTH), and how many of each name (a close tag pops to its own). */
  const stack: { name: string; m: Mat2 }[] = [];
  const openNames = new Map<string, number>();
  /**
   * A subtree passed over (quiet, hidden, a shape's content, another vocabulary's, too deep): its
   * root's name and its open elements counted by name, never kept (a deep one costs nothing per level).
   */
  let quiet: { root: string; open: Map<string, number> } | null = null;
  const bump = (m: Map<string, number>, k: string, d: number) => m.set(k, (m.get(k) ?? 0) + d);
  let root: { mmPerUnit: number; units: string } | null = null;
  let tooMany = false;

  const shape = (local: string, a: Record<string, string>, m: Mat2) => {
    const before = curves.length;
    const L = (k: string, dflt = 0) => {
      const v = length(a[k]);
      return v === null ? dflt : v;
    };
    let ok = true;
    switch (local) {
      case 'path':
        ok = pathCurves(a.d ?? '', m, curves);
        break;
      case 'line': {
        const x1 = L('x1');
        const y1 = L('y1');
        const x2 = L('x2');
        const y2 = L('y2');
        ok = [x1, y1, x2, y2].every(Number.isFinite);
        if (ok && (x1 !== x2 || y1 !== y2)) curves.push({ kind: 'line', a: applyMat(m, [x1, y1]), b: applyMat(m, [x2, y2]) });
        break;
      }
      case 'polyline':
      case 'polygon': {
        const v = numbers(a.points ?? '');
        ok = !!v && v.length % 2 === 0;
        if (ok && v!.length >= 4) {
          // Its sides as lines (as the path M x0,y0 L x1,y1 ... Z would make them), up to the reading's cap.
          const k = v!.length / 2;
          const at = (j: number): V2 => [v![2 * (j % k)], v![2 * (j % k) + 1]];
          const sides = local === 'polygon' ? k : k - 1;
          for (let j = 0; j < sides && curves.length <= READ_MAX_CURVES; j++) {
            const p = at(j);
            const q = at(j + 1);
            if (p[0] !== q[0] || p[1] !== q[1]) curves.push({ kind: 'line', a: applyMat(m, p), b: applyMat(m, q) });
          }
        }
        break;
      }
      case 'rect': {
        const x = L('x');
        const y = L('y');
        const w = L('width');
        const h = L('height');
        let rx = length(a.rx);
        let ry = length(a.ry);
        ok = [x, y, w, h].every(Number.isFinite) && (rx === null || Number.isFinite(rx)) && (ry === null || Number.isFinite(ry));
        if (!ok || !(w > 0) || !(h > 0)) break;
        if (rx === null || rx < 0) rx = ry !== null && ry >= 0 ? ry : 0;
        if (ry === null || ry < 0) ry = rx;
        rx = Math.min(rx, w / 2);
        ry = Math.min(ry, h / 2);
        const d =
          rx > 0 && ry > 0
            ? `M${x + rx},${y} H${x + w - rx} A${rx},${ry} 0 0 1 ${x + w},${y + ry} V${y + h - ry} A${rx},${ry} 0 0 1 ${x + w - rx},${y + h} H${x + rx} A${rx},${ry} 0 0 1 ${x},${y + h - ry} V${y + ry} A${rx},${ry} 0 0 1 ${x + rx},${y} Z`
            : `M${x},${y} H${x + w} V${y + h} H${x} Z`;
        ok = pathCurves(d, m, curves);
        break;
      }
      case 'circle':
      case 'ellipse': {
        const cx = L('cx');
        const cy = L('cy');
        const rx = local === 'circle' ? L('r') : L('rx', NaN);
        let ry = local === 'circle' ? rx : L('ry', NaN);
        let rxx = rx;
        // An ellipse with one radius given (SVG 2: auto) takes it for both.
        if (local === 'ellipse') {
          if (Number.isNaN(rx) && a.rx === undefined) rxx = ry;
          if (Number.isNaN(ry) && a.ry === undefined) ry = rxx;
        }
        ok = [cx, cy, rxx, ry].every(Number.isFinite);
        if (!ok || !(rxx > 0) || !(ry > 0)) break;
        const piece = conicPiece(applyMat(m, [cx, cy]), applyLinear(m, [rxx, 0]), applyLinear(m, [0, ry]), 0, 2 * Math.PI);
        if (piece) curves.push(piece);
        else skip(skipped, 'edgeOn');
        break;
      }
    }
    // A shape whose numbers cannot be read draws none of itself; nor one whose curves came out not finite (an overflowing transform).
    if (ok && !tooManyNow() && curves.slice(before).some((c) => !finiteCurve(c))) ok = false;
    if (!ok) {
      curves.length = before;
      skip(skipped, 'unreadable');
    }
    if (tooManyNow()) tooMany = true;
  };
  const tooManyNow = () => curves.length > READ_MAX_CURVES;

  tokenize(text, skipped, (t) => {
    if (tooMany) return;
    if ('close' in t) {
      // Close up to the matching element (a stray close tag changes nothing).
      if (quiet) {
        const k = quiet.open.get(t.close) ?? 0;
        if (!k) return;
        if (t.close === quiet.root && k === 1) quiet = null;
        else bump(quiet.open, t.close, -1);
        return;
      }
      if (!openNames.get(t.close)) return;
      for (;;) {
        const e = stack.pop()!;
        bump(openNames, e.name, -1);
        if (e.name === t.close) break;
      }
      return;
    }
    const a = t.attrs;
    // What would run or reach out if anything ever rendered the file: counted wherever it is.
    for (const [k, v] of Object.entries(a)) {
      if (/^on/i.test(k)) skip(skipped, 'event');
      if ((k === 'href' || /:href$/.test(k)) && v.trim() && !v.trim().startsWith('#')) skip(skipped, 'external');
    }
    if (quiet) {
      if (!t.selfClosing) bump(quiet.open, t.name, 1);
      return;
    }
    const parent = stack[stack.length - 1];
    const push = (m: Mat2) => {
      if (t.selfClosing) return;
      stack.push({ name: t.name, m });
      bump(openNames, t.name, 1);
    };
    /** Its content is passed over. */
    const pass = () => {
      if (!t.selfClosing) quiet = { root: t.name, open: new Map([[t.name, 1]]) };
    };
    if (stack.length >= MAX_DEPTH) {
      skip(skipped, 'deep');
      return pass();
    }
    const colon = t.name.indexOf(':');
    const prefix = colon >= 0 ? t.name.slice(0, colon) : '';
    const local = colon >= 0 ? t.name.slice(colon + 1) : t.name;
    // Another vocabulary's element (Inkscape's, Sodipodi's): its own data, passed over.
    if (prefix && prefix !== 'svg') return pass();
    if (!root && local !== 'svg') return pass();
    const hidden = a.display?.trim() === 'none' || /(^|;)\s*display\s*:\s*none/i.test(a.style ?? '');
    const own = parseTransform(a.transform);
    const base = parent?.m ?? FLIP;
    if (local === 'svg') {
      if (!root) {
        root = rootUnits(a, notes);
        return push(FLIP);
      }
      if (hidden) {
        skip(skipped, 'hidden');
        return pass();
      }
      // A nested viewport: its x, y and viewBox.
      const w = length(a.width);
      const h = length(a.height);
      const vp = viewportMap(a, w ?? null, h ?? null);
      const at = (v: number | null) => (v !== null && Number.isFinite(v) ? v : 0);
      return push(mul(base, mul([1, 0, 0, 1, at(length(a.x)), at(length(a.y))], vp ?? IDENTITY)));
    }
    if (GROUPS.has(local)) {
      if (hidden) {
        skip(skipped, 'hidden');
        return pass();
      }
      if (!own) {
        skip(skipped, 'unreadable');
        return pass();
      }
      return push(mul(base, own));
    }
    if (SHAPES.has(local)) {
      if (hidden) skip(skipped, 'hidden');
      else if (!own) skip(skipped, 'unreadable');
      else shape(local, a, mul(base, own));
      return pass();
    }
    if (local === 'script') skip(skipped, 'script');
    else if (local === 'foreignObject') skip(skipped, 'foreignObject');
    else if (local === 'style') skip(skipped, 'style');
    else if (local === 'image') skip(skipped, 'image');
    else if (local === 'use') skip(skipped, 'use');
    else if (local === 'text') skip(skipped, 'text');
    else if (DEFS.has(local)) skip(skipped, 'defs');
    else if (!QUIET.has(local)) skip(skipped, 'other');
    return pass();
  });
  if (tooMany) throw new DrawingRefused(`${name} has more than ${READ_MAX_CURVES.toLocaleString('en-US')} curves: too many to import`);
  if (!root) throw new DrawingRefused(`${name} is not an SVG drawing (it has no <svg> element)`);
  const r = root as { mmPerUnit: number; units: string };
  return { format: 'svg', name, curves, mmPerUnit: r.mmPerUnit, units: r.units, skipped, notes, layers: [] };
}

/** mm per user unit from the root's width, height and viewBox, and where it came from. */
function rootUnits(a: Record<string, string>, notes: string[]): { mmPerUnit: number; units: string } {
  const vb = a.viewBox !== undefined ? numbers(a.viewBox) : null;
  // The unit as the length's own reading gives it ("" when it has none or cannot be read).
  const unitOf = (v: string | undefined) => (v === undefined ? '' : (lengthParts(v)?.unit ?? ''));
  const w = length(a.width);
  const h = length(a.height);
  const wu = unitOf(a.width);
  const hu = unitOf(a.height);
  // px (and a bare number) is CSS's absolute 1/96 inch too; % and em/ex say nothing of a size; 0 or less is no size (a sprite sheet's).
  const absolute = (u: string) => ['mm', 'cm', 'in', 'pt', 'pc', 'q', 'px', ''].includes(u);
  const sized = (x: number | null, u: string): x is number => x !== null && Number.isFinite(x) && x > 0 && absolute(u);
  if (vb && vb.length === 4 && vb[2] > 0 && vb[3] > 0 && (sized(w, wu) || sized(h, hu))) {
    const sx = sized(w, wu) ? (w * MM_PER_PX) / vb[2] : null;
    const sy = sized(h, hu) ? (h * MM_PER_PX) / vb[3] : null;
    const par = (a.preserveAspectRatio ?? '').trim().split(/\s+/);
    let s = (sx ?? sy) as number;
    let stretched = false;
    if (sx !== null && sy !== null && Math.abs(sx - sy) > 1e-9 * Math.max(sx, sy)) {
      if (par[0] === 'none') stretched = true;
      else s = par[1] === 'slice' ? Math.max(sx, sy) : Math.min(sx, sy);
    }
    if (Number.isFinite(s) && s > 0) {
      if (stretched) notes.push('Its width and height stretch the viewBox by different amounts: read with the width\'s (set the scale to change it)');
      const by = s === sx ? `width ${a.width!.trim()} over a viewBox ${sig(vb[2])} wide` : `height ${a.height!.trim()} over a viewBox ${sig(vb[3])} high`;
      return { mmPerUnit: s, units: by };
    }
    notes.push('Its size over its viewBox gives no scale (a viewBox far too small): read as CSS px (set the scale)');
  } else if (([[w, wu], [h, hu]] as const).some(([x, u]) => x !== null && Number.isFinite(x) && x <= 0 && absolute(u))) {
    notes.push('Its width or height is 0, so it gives no size: read as CSS px (set the scale)');
  }
  const physical = (u: string) => u !== '' && u !== 'px' && absolute(u);
  if (!vb && ((w !== null && physical(wu)) || (h !== null && physical(hu)))) {
    notes.push(`Its size is given in ${physical(wu) ? wu : hu} but it has no viewBox, so its numbers are CSS px`);
  }
  return { mmPerUnit: MM_PER_PX, units: 'CSS px, 96 per inch' };
}
