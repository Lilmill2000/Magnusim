// ux010 (DRAW, Daniel: "Is there a way to not have the standard mouse or crosshair with the
// arrows? some other mouse thing would be ideal" and, after the first sheet, "for the dark mode,
// can they just be white"): sketch mode's own cursors, small SVGs in the app's look, given to CSS
// `cursor` so the OS still draws them (no lag), each with a keyword fallback:
//   draw      a thin precise crosshair (hotspot at its centre) with the tool's icon at its lower right
//   pick      a small arrow (hotspot at its tip) with a tiny icon of what is under it at its lower
//             right: a point, a line, an arc, a circle or an ellipse (entityPickKind: every other
//             kind shows as one of those five)
//   drag      the same small arrow with a tiny four-way arrow: a drag under way, a drag handle (a
//             fillet's radius arrow), the banana's picture in a sketch
//   grab      an open hand, grabbing a closed hand: the 3D banana's (model mode), never in a sketch
// Daniel (2026-10-28) on the hand a sketch showed over geometry: "it gets way too big and kind of
// covers up some of what you're trying to look at, especially when you're trying to hover over a
// point ... if I hover over something in the sketch, say a line, a tiny little line icon appears
// next to the mouse cursor". The kind icon is 11 CSS px, at the arrow's lower right, clear of the
// hotspot (PICK_ICON_BOX).
// Two tones: on a light view dark strokes with a white halo (as OS cursors are); on a dark view
// plain white, with only a faint dark edge so it does not melt into a light spot (cursorTone).
// Each is a data: URI (the frame's CSP allows data: images; nothing in the host changes), at 1x
// and, through image-set(), at 2x, so 150 % and 200 % displays get a sharp one; the hotspot is
// given in CSS px (the browser scales it with the image).
// Owner: DRAW (ux010).
// SPDX-License-Identifier: GPL-3.0-or-later
import type { SketchFeature } from '../types/doc';

export type SketchCursorKind = 'draw' | 'pick' | 'drag' | 'grab' | 'grabbing';
export type CursorTone = 'light' | 'dark';

/** What the pick cursor shows of the sketch item under the pointer: every kind is one of these five. */
export type PickKind = 'point' | 'line' | 'arc' | 'circle' | 'ellipse';
export const PICK_KINDS: readonly PickKind[] = Object.freeze(['point', 'line', 'arc', 'circle', 'ellipse']);
const isPickKind = (s: string): s is PickKind => (PICK_KINDS as readonly string[]).includes(s);

/**
 * The kind a sketch entity shows as under the pointer (Daniel: "those are the main types; everything
 * else can be grouped into that"):
 *   point    a point (a sketch point; a curve's end or centre is a point hit, not an entity)
 *   line     a line or a centerline: a rectangle's, a polygon's, a parallelogram's and a slot's
 *            straight sides are lines
 *   arc      an arc (a fillet's, a slot's end, a sector's), and the open curves: an open spline, a
 *            parabola, a conic
 *   circle   a circle, and a closed spline (a closed curve)
 *   ellipse  an ellipse and a piece of one
 * Projected and linked curves are entities of these kinds: they show by their shape.
 */
export function entityPickKind(e: { kind: string; closed?: boolean }): PickKind {
  switch (e.kind) {
    case 'point':
      return 'point';
    case 'line':
      return 'line';
    case 'circle':
      return 'circle';
    case 'ellipse':
    case 'ellipse_arc':
      return 'ellipse';
    case 'spline':
      return e.closed ? 'circle' : 'arc';
    default:
      // arc, parabola, conic, and any open curve to come.
      return 'arc';
  }
}

/** The kind a hover shows (null: a dimension or a relation, or what is no longer in the sketch). */
export function pickKindOf(d: Pick<SketchFeature, 'entities'>, h: { what: 'point' | 'entity' | 'constraint'; id: string } | null): PickKind | null {
  if (!h || h.what === 'constraint') return null;
  if (h.what === 'point') return 'point';
  const e = d.entities.find((x) => x.id === h.id);
  return e ? entityPickKind(e as { kind: string; closed?: boolean }) : null;
}

/** The view's cursor keyword for a kind under the Select tool ("pick:line"), read back by cursorFor. */
export const pickKeyword = (k: PickKind): string => `pick:${k}`;

interface Ink {
  /** The outermost edge: a white halo (light view) or a faint dark rim (dark view). */
  halo: string;
  haloW: number;
  /** Strokes and outlines. */
  ink: string;
  /** Inside a shape (a hand's palm and fingers). */
  fill: string;
}

const INKS: Record<CursorTone, Ink> = {
  light: { halo: '#ffffff', haloW: 2, ink: '#101828', fill: '#ffffff' },
  dark: { halo: 'rgba(16,24,40,0.45)', haloW: 0.8, ink: '#ffffff', fill: '#ffffff' },
};

/**
 * The tone a sketch's cursors take: white on a dark view. `theme` is the host's theme name
 * (ws.context.theme.name: "light" today), `background` the view's colour (0xRRGGBB); either one
 * dark is enough.
 */
export function cursorTone(theme: string | null | undefined, background: number | null | undefined): CursorTone {
  if (theme && /dark/i.test(theme)) return 'dark';
  if (background == null || !Number.isFinite(background)) return 'light';
  const ch = (shift: number) => {
    const c = ((background >> shift) & 0xff) / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const lum = 0.2126 * ch(16) + 0.7152 * ch(8) + 0.0722 * ch(0);
  return lum < 0.18 ? 'dark' : 'light';
}

const stroke = (d: string, color: string, w: number) => `<path d="${d}" fill="none" stroke="${color}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`;

/** The crosshair: four thin arms around a small gap, and a centre dot; hotspot (10, 10). */
function cross(k: Ink): string {
  const arms = 'M10.5 1.5V7.5M10.5 13.5V19.5M1.5 10.5H7.5M13.5 10.5H19.5';
  return `${stroke(arms, k.halo, 1 + k.haloW)}${stroke(arms, k.ink, 1)}<circle cx="10.5" cy="10.5" r="1.3" fill="${k.ink}" stroke="${k.halo}" stroke-width="${k.haloW * 0.4}"/>`;
}

/** A tool's 24-unit outline icon at the crosshair's lower right (12 px). */
function toolIcon(d: string, k: Ink): string {
  return `<g transform="translate(18.5 18.5) scale(0.52)">${stroke(d, k.halo, 2.1 + k.haloW * 1.9)}${stroke(d, k.ink, 2.1)}</g>`;
}

/** The pick and drag cursors' hotspot: the arrow's tip (CSS px). */
export const ARROW_TIP = Object.freeze({ x: 2, y: 2 });
/** Where the kind icon (and the drag's four-way arrow) sits: its box's top left and size (CSS px). */
export const PICK_ICON_BOX = Object.freeze({ x: 16, y: 16, size: 11 });
/** The arrow's outline (about 10 x 15 px, a little smaller than the system's), its tip at ARROW_TIP. */
export const ARROW_PATH = 'M2 2V15.6L5.3 12.5L7.5 17.3L9.7 16.3L7.5 11.6H12Z';

function arrow(k: Ink): string {
  return `<path d="${ARROW_PATH}" fill="${k.halo}" stroke="${k.halo}" stroke-width="${k.haloW}" stroke-linejoin="round"/><path d="${ARROW_PATH}" fill="${k.ink}"/>`;
}

const ICON_W = 1.5;
/** A dot of the icons (an end of a line or an arc; the point itself, larger), with its halo. */
const dotAt = (x: number, y: number, r: number, k: Ink) => `<circle cx="${x}" cy="${y}" r="${r + k.haloW / 2}" fill="${k.halo}"/><circle cx="${x}" cy="${y}" r="${r}" fill="${k.ink}"/>`;

/**
 * The kind's tiny icon in PICK_ICON_BOX (16..27 both ways, centre 21.5): a dot; a slanted segment
 * with its ends; a half circle with its ends; a circle; an ellipse. `data-pick` names it (the e2e
 * reads the drawn image's kind from it).
 */
function pickIcon(kind: PickKind, k: Ink): string {
  const c = PICK_ICON_BOX.x + PICK_ICON_BOX.size / 2;
  const lo = PICK_ICON_BOX.x + 1;
  const hi = PICK_ICON_BOX.x + PICK_ICON_BOX.size - 1;
  const outline = (d: string) => stroke(d, k.halo, ICON_W + k.haloW) + stroke(d, k.ink, ICON_W);
  let body: string;
  switch (kind) {
    case 'point':
      body = dotAt(c, c, 2.7, k);
      break;
    case 'line':
      body = outline(`M${lo} ${hi}L${hi} ${lo}`) + dotAt(lo, hi, 1.25, k) + dotAt(hi, lo, 1.25, k);
      break;
    case 'arc':
      body = outline(`M${lo} ${c + 2.5}A${c - lo} ${c - lo} 0 0 1 ${hi} ${c + 2.5}`) + dotAt(lo, c + 2.5, 1.25, k) + dotAt(hi, c + 2.5, 1.25, k);
      break;
    case 'circle':
      body = outline(`M${c - 5} ${c}a5 5 0 1 0 10 0a5 5 0 1 0 -10 0`);
      break;
    case 'ellipse':
      body = outline(`M${c - 5.5} ${c}a5.5 3.2 0 1 0 11 0a5.5 3.2 0 1 0 -11 0`);
      break;
  }
  return `<g data-pick="${kind}">${body}</g>`;
}

/** The drag's four-way arrow in PICK_ICON_BOX. */
function moveIcon(k: Ink): string {
  const c = PICK_ICON_BOX.x + PICK_ICON_BOX.size / 2;
  const lo = PICK_ICON_BOX.x + 0.25;
  const hi = PICK_ICON_BOX.x + PICK_ICON_BOX.size - 0.25;
  const h = 1.9;
  const d = `M${c} ${lo}V${hi}M${lo} ${c}H${hi}M${c - h} ${lo + h}L${c} ${lo}L${c + h} ${lo + h}M${c - h} ${hi - h}L${c} ${hi}L${c + h} ${hi - h}M${lo + h} ${c - h}L${lo} ${c}L${lo + h} ${c + h}M${hi - h} ${c - h}L${hi} ${c}L${hi - h} ${c + h}`;
  return `<g data-drag="1">${stroke(d, k.halo, ICON_W + k.haloW)}${stroke(d, k.ink, ICON_W)}</g>`;
}

/**
 * A hand (32 units, hotspot at the palm, 15 15): the fingers are round-capped strokes on a rounded
 * palm. Open: four fingers spread up and the thumb out; closed: the fingers curled short.
 */
function hand(open: boolean, k: Ink): string {
  const fingers = open
    ? ['M11.2 15V6.8', 'M14.4 14V4.6', 'M17.6 14V5.6', 'M20.6 15.2V8.6', 'M9.6 19.4L6 15.2']
    : ['M11.2 15V11.4', 'M14.4 14V10.4', 'M17.6 14V10.6', 'M20.6 15.2V12.2', 'M9.6 19.4L8 17.2'];
  const d = fingers.join('');
  const palm = open ? 'M9.4 14.4H22.4V20.6A5.4 5.4 0 0 1 17 26H14.8A5.4 5.4 0 0 1 9.4 20.6Z' : 'M9.4 13H22.4V19.6A5.4 5.4 0 0 1 17 25H14.8A5.4 5.4 0 0 1 9.4 19.6Z';
  const fw = 2.6;
  // Outer edge, then the outline, then the inside (the fill covers the inner outline lines, so the
  // fingers and the palm read as one glove; on a dark view the fill is white too, the gaps between
  // the fingers keep them apart).
  const edge = `${stroke(d, k.halo, fw + 1.8 + k.haloW)}<path d="${palm}" fill="${k.halo}" stroke="${k.halo}" stroke-width="${1.8 + k.haloW}" stroke-linejoin="round"/>`;
  const outline = `${stroke(d, k.ink, fw + 1.8)}<path d="${palm}" fill="${k.ink}" stroke="${k.ink}" stroke-width="1.8" stroke-linejoin="round"/>`;
  const inside = `${stroke(d, k.fill, fw)}<path d="${palm}" fill="${k.fill}"/>`;
  // On a light view the knuckle lines say "hand"; on a dark (all white) one, faint lines between
  // the fingers and at the thumb do.
  const knuckles =
    k.ink === k.fill
      ? stroke(open ? 'M12.8 8V15.2M16 6.4V15M19.1 8.2V15.2M10 18.6L8.4 16.8' : 'M12.8 12V14.6M16 11.6V14.4M19.1 12.2V14.6M10 18L9.2 16.9', k.halo, 0.75)
      : stroke(open ? 'M12.8 16.4V18M16 16V17.6M19.2 16.4V18' : 'M12.8 14.8V16.4M16 14.6V16.2M19.2 14.8V16.4', k.ink, 0.9);
  return edge + outline + inside + knuckles;
}

function svg(body: string, px: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 32 32">${body}</svg>`;
}

function uri(s: string): string {
  return `data:image/svg+xml,${encodeURIComponent(s)}`;
}

/**
 * The body (32-unit SVG), hotspot and keyword of each cursor. `icon`: the draw cursor's tool icon
 * (a 24-unit path), or the pick cursor's kind (a PickKind; anything else shows the arrow alone).
 */
export function cursorParts(kind: SketchCursorKind, icon?: string | null, tone: CursorTone = 'light'): { body: string; x: number; y: number; fallback: string } {
  const k = INKS[tone];
  switch (kind) {
    case 'draw':
      return { body: cross(k) + (icon ? toolIcon(icon, k) : ''), x: 10, y: 10, fallback: 'crosshair' };
    case 'pick':
      return { body: arrow(k) + (icon && isPickKind(icon) ? pickIcon(icon, k) : ''), x: ARROW_TIP.x, y: ARROW_TIP.y, fallback: 'default' };
    case 'drag':
      return { body: arrow(k) + moveIcon(k), x: ARROW_TIP.x, y: ARROW_TIP.y, fallback: 'move' };
    case 'grab':
      return { body: hand(true, k), x: 15, y: 15, fallback: 'grab' };
    case 'grabbing':
      return { body: hand(false, k), x: 15, y: 15, fallback: 'grabbing' };
  }
}

/** A cursor's SVG text at `px` pixels square (the PNG previews render these). */
export function cursorSvg(kind: SketchCursorKind, icon?: string | null, px = 32, tone: CursorTone = 'light'): string {
  return svg(cursorParts(kind, icon, tone).body, px);
}

const supports = (v: string): boolean => {
  try {
    return typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('cursor', v);
  } catch {
    return false;
  }
};

const cache = new Map<string, string>();

/**
 * The CSS cursor value: image-set (1x and 2x SVG) where the browser takes it in `cursor`, else the
 * 1x SVG; always ending with the keyword (a browser that takes no image still shows that).
 */
export function sketchCursor(kind: SketchCursorKind, icon?: string | null, tone: CursorTone = 'light'): string {
  const key = `${kind}|${tone}|${icon ?? ''}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const { body, x, y, fallback } = cursorParts(kind, icon, tone);
  const one = `url("${uri(svg(body, 32))}")`;
  const two = `url("${uri(svg(body, 64))}")`;
  const candidates = [`image-set(${one} 1x, ${two} 2x) ${x} ${y}, ${fallback}`, `-webkit-image-set(${one} 1x, ${two} 2x) ${x} ${y}, ${fallback}`, `${one} ${x} ${y}, ${fallback}`];
  const value = candidates.find(supports) ?? fallback;
  cache.set(key, value);
  return value;
}

/**
 * What the canvas shows for a keyword a sketch tool asks for: 'crosshair' the draw cursor (with the
 * tool's icon), 'pick:<kind>' the small arrow with that kind's icon, 'drag' (and 'move', 'grab' and
 * 'grabbing') the small arrow with the four-way arrow: no hand in a sketch. Other keywords as they
 * are.
 */
export function cursorFor(keyword: string, icon?: string | null, tone: CursorTone = 'light'): string {
  switch (keyword) {
    case 'crosshair':
      return sketchCursor('draw', icon, tone);
    case 'drag':
    case 'move':
    case 'grab':
    case 'grabbing':
      return sketchCursor('drag', null, tone);
    default: {
      const kind = keyword.startsWith('pick:') ? keyword.slice(5) : '';
      return isPickKind(kind) ? sketchCursor('pick', kind, tone) : keyword;
    }
  }
}
