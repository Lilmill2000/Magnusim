// Small hand-written drawings for Import SVG/DXF's tests (unit and e2e): an SVG in mm and one in
// px (a rounded rectangle, a circle and a closed cubic path in a transformed group), a DXF in
// inches (LWPOLYLINE bulges, ARC, CIRCLE, SPLINE, ELLIPSE, an INSERT of a block, a TEXT, a layer
// the file has off), a DXF whose arc and polyline lie in a mirrored object coordinate system, a
// hostile SVG (script, onload, foreignObject, external links, use, image, style, an entity bomb),
// and a binary DXF's first bytes. Built here, never read from anyone's files.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * 100 x 50 mm over a 100 x 50 viewBox (1 unit = 1 mm): a 40 x 20 rectangle at (10, 10) rounded
 * r 5, a circle r 10 at (75, 25), and in a group translated (10, 40) and scaled 2 a closed path:
 * a cubic from (0, 0) to (15, 0), then lines down 3, back and up. In the sketch (y up): the
 * rectangle spans u 10..50, v -30..-10; the circle is at (75, -25); the path's cubic has poles
 * (10, -40), (20, -30), (30, -50), (40, -40) and its lines run to v -46.
 */
export const SVG_MM = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="50mm" viewBox="0 0 100 50">
  <title>plate</title>
  <rect x="10" y="10" width="40" height="20" rx="5"/>
  <circle cx="75" cy="25" r="10"/>
  <g transform="translate(10 40) scale(2)">
    <path d="M0 0 C 5 -5, 10 5, 15 0 l 0 3 H 0 z"/>
  </g>
</svg>
`;

/** The rounded rectangle's area (mm²): 40 x 20 less the corners' squares, plus their quarter discs. */
export const SVG_MM_RECT_AREA = 40 * 20 - (4 - Math.PI) * 25;

/**
 * 96 x 48 px over a 96 x 48 viewBox (1 unit = 1 px = 0.264583 mm): a 96 x 48 rectangle rounded
 * rx 12 ry 6 (elliptical corners), and a circle r 12 under rotate(30) skewX(20) (an ellipse).
 */
export const SVG_PX = `<svg xmlns="http://www.w3.org/2000/svg" width="96px" height="48" viewBox="0 0 96 48">
  <rect width="96" height="48" rx="12" ry="6"/>
  <g transform="rotate(30) skewX(20)"><circle cx="40" cy="10" r="12"/></g>
</svg>`;

/** A path's arc (sweep 1) from (0, 0) to (20, 0): in the sketch it passes over the top, clockwise. */
export const SVG_ARC = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><path d="M0 0 A10 10 0 0 1 20 0"/></svg>`;

/** Every hostile thing an SVG can carry, around one 10 x 10 square and one line that are drawn. */
export const SVG_HOSTILE = `<?xml version="1.0"?>
<!DOCTYPE svg [
  <!ENTITY a "aaaaaaaaaa">
  <!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">
  <!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;">
  <!ENTITY d "&c;&c;&c;&c;&c;&c;&c;&c;&c;&c;">
  <!ENTITY e "&d;&d;&d;&d;&d;&d;&d;&d;&d;&d;">
  <!ENTITY f "&e;&e;&e;&e;&e;&e;&e;&e;&e;&e;">
  <!ENTITY g "&f;&f;&f;&f;&f;&f;&f;&f;&f;&f;">
  <!ENTITY h "&g;&g;&g;&g;&g;&g;&g;&g;&g;&g;">
  <!ENTITY i "&h;&h;&h;&h;&h;&h;&h;&h;&h;&h;">
]>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="50mm" height="50mm" viewBox="0 0 50 50" onload="window.__drawingRan = 'onload'">
  <script>window.__drawingRan = 'script'</script>
  <script xlink:href="http://example.invalid/evil.js"></script>
  <foreignObject width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml"><img src="x" onerror="window.__drawingRan = 'img'"/><iframe src="http://example.invalid/"></iframe></div></foreignObject>
  <image href="http://example.invalid/picture.png" width="5" height="5"/>
  <use xlink:href="#sq" x="20"/>
  <style>@import url(http://example.invalid/sheet.css); rect { fill: url(http://example.invalid/f.svg#p) }</style>
  <text x="1" y="1">&i;</text>
  <rect id="sq" x="0" y="0" width="10" height="10" onclick="window.__drawingRan = 'click'"/>
  <rect x="0" y="0" width="&i;" height="10"/>
  <a href="http://example.invalid/"><line x1="0" y1="20" x2="10" y2="20"/></a>
</svg>`;

/** A DXF as text from its group code / value pairs. */
export function dxf(pairs: (string | number)[]): string {
  const out: string[] = [];
  for (let i = 0; i < pairs.length; i += 2) out.push(String(pairs[i]), String(pairs[i + 1]));
  return `${out.join('\n')}\n`;
}

const line = (layer: string, a: [number, number], b: [number, number]) => [0, 'LINE', 8, layer, 10, a[0], 20, a[1], 30, 0, 11, b[0], 21, b[1], 31, 0];

/**
 * A part in inches ($INSUNITS 1): a closed LWPOLYLINE slot 4 long and 2 wide (two bulge-1
 * semicircles; area 8 + pi) with a CIRCLE hole r 0.25 in it; an ARC r 1 at (8, 1) from 0 to 180
 * deg closed by a LINE (a half disc); a degree-3 SPLINE on 4 poles closed by a LINE it crosses
 * once (two regions); an ELLIPSE
 * (major 2 along X, ratio 0.5) at (16, 1); an INSERT of block SQ (a unit square of LINEs on layer
 * 0) at (20, 0), scale 2, turned 90 deg, on layer Parts (a 2 x 2 square, x 18..20, y 0..2); a
 * TEXT on Notes; a LINE on Hidden, a layer the file has off.
 */
export const DXF_PART = dxf([
  0, 'SECTION', 2, 'HEADER', 9, '$ACADVER', 1, 'AC1015', 9, '$INSUNITS', 70, 1, 0, 'ENDSEC',
  0, 'SECTION', 2, 'TABLES', 0, 'TABLE', 2, 'LAYER', 70, 4,
  0, 'LAYER', 2, '0', 70, 0, 62, 7, 6, 'CONTINUOUS',
  0, 'LAYER', 2, 'Parts', 70, 0, 62, 1, 6, 'CONTINUOUS',
  0, 'LAYER', 2, 'Notes', 70, 0, 62, 2, 6, 'CONTINUOUS',
  0, 'LAYER', 2, 'Hidden', 70, 0, 62, -3, 6, 'CONTINUOUS',
  0, 'ENDTAB', 0, 'ENDSEC',
  0, 'SECTION', 2, 'BLOCKS',
  0, 'BLOCK', 8, '0', 2, 'SQ', 70, 0, 10, 0, 20, 0, 30, 0,
  ...line('0', [0, 0], [1, 0]), ...line('0', [1, 0], [1, 1]), ...line('0', [1, 1], [0, 1]), ...line('0', [0, 1], [0, 0]),
  0, 'ENDBLK', 8, '0',
  0, 'ENDSEC',
  0, 'SECTION', 2, 'ENTITIES',
  0, 'LWPOLYLINE', 8, '0', 90, 4, 70, 1, 10, 0, 20, 0, 10, 4, 20, 0, 42, 1, 10, 4, 20, 2, 10, 0, 20, 2, 42, 1,
  0, 'CIRCLE', 8, '0', 10, 2, 20, 1, 30, 0, 40, 0.25,
  0, 'ARC', 8, '0', 10, 8, 20, 1, 30, 0, 40, 1, 50, 0, 51, 180,
  ...line('0', [7, 1], [9, 1]),
  0, 'SPLINE', 8, '0', 210, 0, 220, 0, 230, 1, 70, 8, 71, 3, 72, 8, 73, 4, 74, 0,
  40, 0, 40, 0, 40, 0, 40, 0, 40, 1, 40, 1, 40, 1, 40, 1,
  10, 10, 20, 0, 30, 0, 10, 11, 20, 2, 30, 0, 10, 12, 20, -2, 30, 0, 10, 13, 20, 0, 30, 0,
  ...line('0', [13, 0], [10, 0]),
  0, 'ELLIPSE', 8, '0', 10, 16, 20, 1, 30, 0, 11, 2, 21, 0, 31, 0, 210, 0, 220, 0, 230, 1, 40, 0.5, 41, 0, 42, 2 * Math.PI,
  0, 'INSERT', 8, 'Parts', 2, 'SQ', 10, 20, 20, 0, 30, 0, 41, 2, 42, 2, 43, 1, 50, 90,
  0, 'TEXT', 8, 'Notes', 10, 0, 20, 5, 30, 0, 40, 1, 1, 'Hello',
  ...line('Hidden', [0, 10], [5, 10]),
  0, 'ENDSEC', 0, 'EOF',
]);

/** In square inches: the slot less its hole, the hole, the half disc, the ellipse, the square. */
export const DXF_PART_AREAS = { slot: 8 + Math.PI - Math.PI * 0.0625, hole: Math.PI * 0.0625, half: Math.PI / 2, ellipse: Math.PI * 2 * 1, square: 4 };

/**
 * Object coordinates mirrored (extrusion 0, 0, -1, an R12 file with no $INSUNITS): an ARC at (5,
 * 0) r 1 from 0 to 90 deg (in world coordinates it runs clockwise from (-6, 0) to (-5, 1)) and an
 * LWPOLYLINE from (0, 0) to (1, 0) (world (0, 0) to (-1, 0)); a POINT at z 3 (projected).
 */
export const DXF_OCS = dxf([
  0, 'SECTION', 2, 'ENTITIES',
  0, 'ARC', 8, '0', 10, 5, 20, 0, 30, 0, 40, 1, 50, 0, 51, 90, 210, 0, 220, 0, 230, -1,
  0, 'LWPOLYLINE', 8, '0', 90, 2, 70, 0, 10, 0, 20, 0, 10, 1, 20, 0, 210, 0, 220, 0, 230, -1,
  0, 'POINT', 8, '0', 10, 3, 20, 4, 30, 3,
  0, 'ENDSEC', 0, 'EOF',
]);

/** A binary DXF's first bytes (its sentinel). */
export const DXF_BINARY = new Uint8Array([...'AutoCAD Binary DXF\r\n'].map((c) => c.charCodeAt(0)).concat([0x1a, 0, 0, 0, 0, 0]));

/** A square of four separate lines whose ends miss each other by `gap` mm (in a mm DXF). */
export const squareDxf = (gap: number) =>
  dxf([
    0, 'SECTION', 2, 'HEADER', 9, '$INSUNITS', 70, 4, 0, 'ENDSEC',
    0, 'SECTION', 2, 'ENTITIES',
    ...line('0', [0, 0], [10, 0]),
    ...line('0', [10 + gap, 0], [10, 10]),
    ...line('0', [10, 10 + gap], [0, 10]),
    ...line('0', [0, 10], [0, gap]),
    0, 'ENDSEC', 0, 'EOF',
  ]);

/** `n` separate short lines (2n points: a drawing over the import's load cap when n > 5,000). */
export const manyLinesDxf = (n: number) =>
  dxf([0, 'SECTION', 2, 'ENTITIES', ...Array.from({ length: n }, (_, i) => line('0', [i, 0], [i, 1])).flat(), 0, 'ENDSEC', 0, 'EOF']);

/** UTF-8 bytes of a text. */
export const bytesOf = (s: string) => new TextEncoder().encode(s);
