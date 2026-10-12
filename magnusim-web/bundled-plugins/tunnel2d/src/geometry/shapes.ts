// Body shapes and their outlines in the body's own frame: metres, counter-clockwise,
// the pivot (where the body turns and the point its position names) at the origin.
// An airfoil turns about its quarter chord; the other shapes about their centre.
// SPDX-License-Identifier: GPL-3.0-or-later
import { generate } from './naca';
import { ensureCcw, type Poly } from './polygon';

export type Shape =
  | { kind: 'naca'; code: string; chord: number }
  | { kind: 'dat'; name: string; x: number[]; y: number[]; chord: number }
  | { kind: 'circle'; diameter: number }
  | { kind: 'rect'; width: number; height: number }
  | { kind: 'ellipse'; width: number; height: number }
  | { kind: 'plate'; length: number; thickness: number };

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

/** Unit-chord Selig points scaled to `chord` and moved so the quarter chord is the origin. */
function section(x: number[], y: number[], chord: number): Poly {
  const out: Poly = [];
  for (let i = 0; i < x.length; i++) out.push((x[i] - 0.25) * chord, y[i] * chord);
  return ensureCcw(out);
}

export function outline(shape: Shape): Poly {
  switch (shape.kind) {
    case 'naca': {
      const s = generate(shape.code, 121);
      return section(s.x, s.y, shape.chord);
    }
    case 'dat':
      return section(shape.x, shape.y, shape.chord);
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
  }
}
