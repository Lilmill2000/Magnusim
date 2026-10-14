// Body shapes and their outlines in the body's own frame: metres, counter-clockwise,
// the pivot (where the body turns and the point its position names) at the origin.
// An airfoil turns about its quarter chord; the other shapes about their centre.
// SPDX-License-Identifier: GPL-3.0-or-later
import { generate } from './naca';
import { bboxRings, ensureCcw, type Poly, type Rings } from './polygon';
import { sketchProfile, type Profile, type SketchData } from '../sketch/model';

export type Shape =
  | { kind: 'naca'; code: string; chord: number }
  | { kind: 'dat'; name: string; x: number[]; y: number[]; chord: number }
  | { kind: 'circle'; diameter: number }
  | { kind: 'rect'; width: number; height: number }
  | { kind: 'ellipse'; width: number; height: number }
  | { kind: 'plate'; length: number; thickness: number }
  /** Drawn with the sketcher (points in mm, origin at the body's pivot). */
  | { kind: 'sketch'; name: string; sketch: SketchData };

export type ShapeKind = Shape['kind'];

const CIRCLE_SEGMENTS = 256;

function ring(rx: number, ry: number, n = CIRCLE_SEGMENTS): Poly {
  const out: Poly = [];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    out.push(rx * Math.cos(a), ry * Math.sin(a));
  }
  return out;
}

function box(w: number, h: number): Poly {
  return [-w / 2, -h / 2, w / 2, -h / 2, w / 2, h / 2, -w / 2, h / 2];
}

/**
 * Selig points (chord 1) with the rear half at least `tmin` thick, widened evenly about
 * the mean line: a trailing edge thinner than the grid's cells is drawn onto it unevenly
 * (more on one side than the other, by where it falls), which bends the flow leaving it
 * and so the lift; at two cells thick it is drawn the same wherever it lies. The mean line
 * (camber, and so the lift) is unchanged.
 */
export function thickenRear(x: number[], y: number[], tmin: number): { x: number[]; y: number[] } {
  if (!(tmin > 0)) return { x, y };
  let le = 0;
  for (let i = 1; i < x.length; i++) if (x[i] < x[le]) le = i;
  // Upper surface: indices le..0 (x rising); lower: le..end (x rising).
  const up = Array.from({ length: le + 1 }, (_, k) => le - k);
  const lo = Array.from({ length: x.length - le }, (_, k) => le + k);
  const at = (idx: number[], xv: number) => {
    for (let k = 1; k < idx.length; k++) {
      const a = idx[k - 1];
      const b = idx[k];
      if (x[b] >= xv) return x[b] === x[a] ? y[b] : y[a] + ((y[b] - y[a]) * (xv - x[a])) / (x[b] - x[a]);
    }
    return y[idx[idx.length - 1]];
  };
  const yo = y.slice();
  for (let i = 0; i < x.length; i++) {
    if (x[i] < 0.5) continue;
    const isUp = i < le;
    const other = at(isUp ? lo : up, x[i]);
    const t = isUp ? y[i] - other : other - y[i];
    if (t >= tmin) continue;
    const m = 0.5 * (y[i] + other);
    yo[i] = m + (isUp ? 0.5 : -0.5) * tmin;
  }
  return { x, y: yo };
}

/** Unit-chord Selig points scaled to `chord` and moved so the quarter chord is the origin. */
function section(x: number[], y: number[], chord: number, minThickness = 0): Poly {
  const s = thickenRear(x, y, minThickness / chord);
  const out: Poly = [];
  for (let i = 0; i < s.x.length; i++) out.push((s.x[i] - 0.25) * chord, s.y[i] * chord);
  return ensureCcw(out);
}

const profiles = new WeakMap<SketchData, Profile>();

/** A sketch's loops and what stops them (cached per sketch object: edits make new ones). */
export function profileOf(s: SketchData): Profile {
  let p = profiles.get(s);
  if (!p) {
    p = sketchProfile(s);
    profiles.set(s, p);
  }
  return p;
}

/** A sketch's rings in metres. */
function sketchRings(s: SketchData): Rings {
  return profileOf(s).rings.map((r) => ensureCcw(r.flatMap(([x, y]) => [x / 1000, y / 1000])));
}

/** Whether a shape has an outline the flow can see (a sketch needs a closed loop). */
export const hasOutline = (shape: Shape): boolean => shape.kind !== 'sketch' || sketchRings(shape.sketch).length > 0;

/**
 * Every ring of the outline (one, except for a sketch: islands and holes, filled even-odd;
 * none when a sketch has no closed loop). `minThickness` as for outline.
 */
export function outlineRings(shape: Shape, minThickness = 0): Rings {
  if (shape.kind === 'sketch') return sketchRings(shape.sketch);
  return [outline(shape, minThickness)];
}

/**
 * The outline; `minThickness` (same units) keeps an airfoil's rear half at least that thick
 * (see thickenRear). A sketch's largest ring (empty without one): outlineRings has them all.
 */
export function outline(shape: Shape, minThickness = 0): Poly {
  switch (shape.kind) {
    case 'sketch': {
      const rings = sketchRings(shape.sketch);
      let best: Poly = [];
      let area = -1;
      for (const r of rings) {
        const b = bboxRings([r]);
        const a = (b.x1 - b.x0) * (b.y1 - b.y0);
        if (a > area) {
          area = a;
          best = r;
        }
      }
      return best;
    }
    case 'naca': {
      const s = generate(shape.code, 121);
      return section(s.x, s.y, shape.chord, minThickness);
    }
    case 'dat':
      return section(shape.x, shape.y, shape.chord, minThickness);
    case 'circle':
      return ring(shape.diameter / 2, shape.diameter / 2);
    case 'ellipse':
      return ring(shape.width / 2, shape.height / 2);
    case 'rect':
      return box(shape.width, shape.height);
    case 'plate':
      return box(shape.length, shape.thickness);
  }
}

/** The length Reynolds numbers and coefficients of this body are based on. */
export function referenceLength(shape: Shape): number {
  switch (shape.kind) {
    case 'naca':
    case 'dat':
      return shape.chord;
    case 'circle':
      return shape.diameter;
    case 'ellipse':
    case 'rect':
      return shape.height;
    case 'plate':
      return shape.length;
    case 'sketch': {
      // Its larger extent. Not closed (yet, or a side deleted for a moment): the curves drawn
      // so far, so the flow model Auto picks does not change under it. Nothing drawn: 1 cm,
      // so nothing divides by 0.
      const rings = sketchRings(shape.sketch);
      if (rings.length) {
        const b = bboxRings(rings);
        return Math.max(b.x1 - b.x0, b.y1 - b.y0);
      }
      const pts = profileOf(shape.sketch).curves.flat();
      if (!pts.length) return 0.01;
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      return Math.max(0.01, (Math.max(...xs) - Math.min(...xs)) / 1000, (Math.max(...ys) - Math.min(...ys)) / 1000);
    }
  }
}

export function shapeLabel(shape: Shape): string {
  switch (shape.kind) {
    case 'naca':
      return `NACA ${shape.code}`;
    case 'dat':
      return shape.name;
    case 'circle':
      return 'Cylinder';
    case 'ellipse':
      return 'Ellipse';
    case 'rect':
      return 'Rectangle';
    case 'plate':
      return 'Flat plate';
    case 'sketch':
      return shape.name || 'Sketch';
  }
}
