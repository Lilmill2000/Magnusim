// Sketch mode's outline icons (24 viewBox, stroke currentColor, round caps and
// joins; design-language §6): toolbar commands and the constraint glyphs on
// the sketch. One path d each (several M subpaths).
// Owner: P3-SKETCH.
// SPDX-License-Identifier: GPL-3.0-or-later

const dot = (x: number, y: number, r = 1.6) => `M${x - r} ${y}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;

export const SKETCH_ICONS = {
  sketch: 'M3 16l9-4 9 4-9 4z M8 13.8L14.5 4.5l2.5 1.7-6.5 9.3-3 1z',
  line: `M6 18L18 6 ${dot(6, 18)} ${dot(18, 6)}`,
  rectangle: `M5 7h14v10H5z ${dot(5, 7, 1.3)} ${dot(19, 17, 1.3)}`,
  rectangleCenter: `M5 7h14v10H5z ${dot(12, 12, 1.3)}`,
  circle: `M12 12m-7.5 0a7.5 7.5 0 1 0 15 0a7.5 7.5 0 1 0 -15 0 ${dot(12, 12, 1.2)}`,
  arc: `M4.5 17a8.5 8.5 0 0 1 15 0 ${dot(4.5, 17, 1.4)} ${dot(12, 8.6, 1.4)} ${dot(19.5, 17, 1.4)}`,
  arcTangent: `M3 17h8a6 6 0 0 0 6-6V5 ${dot(11, 17, 1.4)} ${dot(17, 5, 1.4)}`,
  point: `${dot(12, 12, 2.2)} M12 4v3.5 M12 16.5V20 M4 12h3.5 M16.5 12H20`,
  centerline: 'M4 20l3-3 M9 15l1-1 M12 12l3-3 M17 7l1-1 M20 4l0 0',
  construction: 'M4 20l2.5-2.5 M8.5 15.5L11 13 M13 11l2.5-2.5 M17.5 6.5L20 4',
  coincident: `${dot(10, 12, 3)} ${dot(14, 12, 3)}`,
  horizontal: 'M4 12h16 M4 9v6 M20 9v6',
  vertical: 'M12 4v16 M9 4h6 M9 20h6',
  parallel: 'M5 17L13 5 M11 19l8-12',
  perpendicular: 'M5 19h14 M12 19V5 M12 15h4v4',
  tangent: 'M12 14m-5 0a5 5 0 1 0 10 0a5 5 0 1 0 -10 0 M3 9h18',
  equal: 'M5 9h14 M5 15h14',
  midpoint: 'M4 16L20 8 M12 12l-2.5-3.5 M12 12l3.2-2.2',
  symmetric: 'M12 3v2 M12 8v2 M12 13v2 M12 18v2 M9 8l-5 4 5 4z M15 8l5 4-5 4z',
  concentric: 'M12 12m-8 0a8 8 0 1 0 16 0a8 8 0 1 0 -16 0 M12 12m-4 0a4 4 0 1 0 8 0a4 4 0 1 0 -8 0',
  collinear: 'M3 16l6-4 M13 9.3L21 4 M3 16h0',
  fix: 'M7 11V8a5 5 0 0 1 10 0v3 M5 11h14v9H5z M12 15v2',
  onCurve: `M4 17a9 9 0 0 1 16 0 ${dot(12, 8.5, 2.2)}`,
  intersection: 'M5 5l14 14 M19 5L5 19',
  dimension: 'M4 7v10 M20 7v10 M4 12h16 M7.5 9.5L4 12l3.5 2.5 M16.5 9.5L20 12l-3.5 2.5',
  trim: 'M6 6m-2.5 0a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0 -5 0 M6 18m-2.5 0a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0 -5 0 M8 7.5l12 9 M8 16.5l12-9',
  extend: 'M3 12h11 M11 9l3 3-3 3 M18 5v14',
  finish: 'M10 4H5v16h5 M15 8l4 4-4 4 M19 12H9',
  lookAt: 'M3 9l9-5 9 5-9 5z M12 14v6 M8.5 18L12 20l3.5-2',
  undo: 'M9 14L4 9l5-5 M4 9h10.5a5.5 5.5 0 0 1 0 11H11',
  redo: 'M15 14l5-5-5-5 M20 9H9.5a5.5 5.5 0 0 0 0 11H13',
  trash: 'M5 7h14M10 7V5h4v2M7 7l1 13h8l1-13',
} as const;

/** Glyph icon per relation kind (and per inference glyph). */
export const GLYPH_ICON: Record<string, string> = {
  coincident: SKETCH_ICONS.coincident,
  horizontal: SKETCH_ICONS.horizontal,
  vertical: SKETCH_ICONS.vertical,
  parallel: SKETCH_ICONS.parallel,
  perpendicular: SKETCH_ICONS.perpendicular,
  tangent: SKETCH_ICONS.tangent,
  equal: SKETCH_ICONS.equal,
  midpoint: SKETCH_ICONS.midpoint,
  symmetric: SKETCH_ICONS.symmetric,
  point_on_line: SKETCH_ICONS.onCurve,
  point_on_circle: SKETCH_ICONS.onCurve,
  'on-curve': SKETCH_ICONS.onCurve,
  intersection: SKETCH_ICONS.intersection,
  concentric: SKETCH_ICONS.concentric,
  collinear: SKETCH_ICONS.collinear,
  fix: SKETCH_ICONS.fix,
};
