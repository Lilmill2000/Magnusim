// Box selection, SolidWorks style (Daniel's must-have 6, P4b SELECT): a drag
// from left to right ENCLOSES (a solid box: only what lies wholly inside it),
// from right to left TOUCHES (a dashed box: anything it meets). The pure maths
// of both tests, in screen pixels: which way a box was dragged, whether a
// projected point, polyline or triangle set lies inside the box or meets it.
// The viewport's GPU id pass (boxpick.ts) says what is visible inside the box;
// these tests decide the rest. Sketch mode uses the same rules on its plane
// (src/sketch/select-tool.ts). Unit-tested (tests/viewport/boxselect.test.ts).
// Owner: P4b SELECT.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { SelectKind } from '../types/selection';

/** A box in screen pixels (x right, y down), corners sorted. */
export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export type BoxMode = 'enclose' | 'touch';

/** The box between the press and the pointer, and its mode: dragged right (or straight up/down) encloses, dragged left touches. */
export function boxFrom(ax: number, ay: number, bx: number, by: number): { rect: Rect; mode: BoxMode } {
  return { rect: { x0: Math.min(ax, bx), y0: Math.min(ay, by), x1: Math.max(ax, bx), y1: Math.max(ay, by) }, mode: bx < ax ? 'touch' : 'enclose' };
}

export function pointInRect(r: Rect, x: number, y: number): boolean {
  return x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;
}

/** Whether the segment (ax, ay)-(bx, by) meets the box (Liang-Barsky clipping). */
export function segmentMeetsRect(r: Rect, ax: number, ay: number, bx: number, by: number): boolean {
  if (pointInRect(r, ax, ay) || pointInRect(r, bx, by)) return true;
  const dx = bx - ax;
  const dy = by - ay;
  let t0 = 0;
  let t1 = 1;
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0;
    const t = q / p;
    if (p < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
    return true;
  };
  return clip(-dx, ax - r.x0) && clip(dx, r.x1 - ax) && clip(-dy, ay - r.y0) && clip(dy, r.y1 - ay) && t0 <= t1;
}

/** Whether every point of a flat [x, y, x, y, ...] list lies in the box (an empty list is not inside). */
export function allInRect(r: Rect, xy: ArrayLike<number>): boolean {
  if (xy.length < 2) return false;
  for (let i = 0; i + 1 < xy.length; i += 2) if (!pointInRect(r, xy[i], xy[i + 1])) return false;
  return true;
}

/** Whether a polyline [x, y, ...] meets the box: a point inside, or a segment crossing it. */
export function polylineMeetsRect(r: Rect, xy: ArrayLike<number>): boolean {
  if (xy.length < 2) return false;
  if (xy.length < 4) return pointInRect(r, xy[0], xy[1]);
  for (let i = 0; i + 3 < xy.length; i += 2) if (segmentMeetsRect(r, xy[i], xy[i + 1], xy[i + 2], xy[i + 3])) return true;
  return false;
}

function sign(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  return (px - bx) * (ay - by) - (ax - bx) * (py - by);
}

/** Whether a point lies in a triangle (either winding, edges included). */
export function pointInTriangle(px: number, py: number, ax: number, ay: number, bx: number, by: number, cx: number, cy: number): boolean {
  const d1 = sign(px, py, ax, ay, bx, by);
  const d2 = sign(px, py, bx, by, cx, cy);
  const d3 = sign(px, py, cx, cy, ax, ay);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

/** Whether a triangle meets the box: an edge crosses it, or it holds the box (a corner of the box inside it). */
export function triangleMeetsRect(r: Rect, ax: number, ay: number, bx: number, by: number, cx: number, cy: number): boolean {
  if (segmentMeetsRect(r, ax, ay, bx, by) || segmentMeetsRect(r, bx, by, cx, cy) || segmentMeetsRect(r, cx, cy, ax, ay)) return true;
  return pointInTriangle(r.x0, r.y0, ax, ay, bx, by, cx, cy);
}

/** A 2D box [x0, y0, x1, y1] of a flat point list, or null when empty. */
export function bounds2(xy: ArrayLike<number>): Rect | null {
  if (xy.length < 2) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i + 1 < xy.length; i += 2) {
    const x = xy[i], y = xy[i + 1];
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return { x0, y0, x1, y1 };
}

/** Whether box `inner` lies wholly in box `outer`. */
export function rectInRect(outer: Rect, inner: Rect): boolean {
  return inner.x0 >= outer.x0 && inner.x1 <= outer.x1 && inner.y0 >= outer.y0 && inner.y1 <= outer.y1;
}

/** Whether two boxes overlap (touching counts). */
export function rectsMeet(a: Rect, b: Rect): boolean {
  return a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1;
}

/** Model-mode kinds a box selects (decided by the selection filter). */
export type BoxKind = 'face' | 'edge' | 'vertex' | 'body';

/**
 * What a box selects for a selection filter: with no filter, edges (SolidWorks' box selection in
 * a part selects edges; a face filter selects faces, and so on); with a filter, its bodies,
 * faces, edges and vertices. Planes are picked by clicking (the box never takes them).
 */
export function boxKinds(filter: readonly SelectKind[]): BoxKind[] {
  if (!filter.length) return ['edge'];
  return (['body', 'face', 'edge', 'vertex'] as const).filter((k) => filter.includes(k));
}

const KIND_WORDS: Record<BoxKind, string> = { body: 'bodies', face: 'faces', edge: 'edges', vertex: 'vertices' };

/** The caption inside the box: "Enclose · edges", "Touch · faces, edges"; null kinds: "Planes are picked by clicking". */
export function boxCaption(mode: BoxMode, kinds: readonly BoxKind[]): string {
  if (!kinds.length) return 'Nothing to box: planes are picked by clicking';
  return `${mode === 'enclose' ? 'Enclose' : 'Touch'} · ${kinds.map((k) => KIND_WORDS[k]).join(', ')}`;
}

/** How a result goes into the selection: replace, add, or toggle (a Ctrl+click's single pick). */
export type BoxCombine = 'replace' | 'add' | 'toggle';

/**
 * Mouse binding (Daniel, 2026-10-06: "Orbit like the main viewer"): a left drag orbits wherever it
 * starts and Shift + left drag pans, as in the core viewer; Ctrl + left drag (Cmd on a Mac), from
 * empty space or on a body, draws the selection box. Alt + drag always moves the camera. A Ctrl
 * press let go without a drag stays a Ctrl+click (the single-pick toggle).
 */
/**
 * How far (CSS px) a Ctrl press must travel before it becomes a box (P4b fix round 1, polish 3). Ctrl is
 * both the box key and the toggle key, and a selection built pick by pick is not an undo step: a Ctrl+click
 * that drifts a few pixels (6 px in the review) must stay the toggle it was meant to be, not become a tiny
 * box that replaces (or clears) the whole selection. 10 px is twice the click distance (CLICK_PX 5) and
 * still far smaller than any box drawn on purpose.
 */
export const BOX_START_PX = 10;

export function boxStarts(e: { button: number; ctrl: boolean; alt: boolean }): boolean {
  return e.button === 0 && e.ctrl && !e.alt;
}

/** A box replaces the selection (an empty box clears it); with Shift (Ctrl+Shift+drag) it adds. */
export function boxCombine(e: { shift: boolean }): BoxCombine {
  return e.shift ? 'add' : 'replace';
}

/** The next selection: `found` replaces, is added (no duplicates), or toggles each item (by key). */
export function combineSelection<T>(current: readonly T[], found: readonly T[], how: BoxCombine, key: (t: T) => string): T[] {
  if (how === 'replace') return [...found];
  const have = new Map(current.map((t) => [key(t), t] as const));
  if (how === 'add') {
    const out = [...current];
    for (const f of found) if (!have.has(key(f))) out.push(f);
    return out;
  }
  const flip = new Set(found.map(key));
  const out = current.filter((t) => !flip.has(key(t)));
  for (const f of found) if (!have.has(key(f))) out.push(f);
  return out;
}
