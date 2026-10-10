// ux010 (DRAW, Daniel: "Is there a way to not have the standard mouse or crosshair with the
// arrows? some other mouse thing would be ideal" and, after the first sheet, "can you have the
// cursor be the hand thing for dragging ... for the dark mode, can they just be white"): sketch
// mode's own cursors, small SVGs in the app's look, given to CSS `cursor` so the OS still draws
// them (no lag), each with a keyword fallback:
//   draw      a thin precise crosshair (hotspot at its centre) with the tool's icon at its lower right
//   grab      an open hand: geometry that can be dragged, a drag handle (a fillet's radius arrow)
//   grabbing  a closed hand: a drag under way
// Two tones: on a light view dark strokes with a white halo (as OS cursors are); on a dark view
// plain white, with only a faint dark edge so it does not melt into a light spot (cursorTone).
// Each is a data: URI (the frame's CSP allows data: images; nothing in the host changes), at 1x
// and, through image-set(), at 2x, so 150 % and 200 % displays get a sharp one; the hotspot is
// given in CSS px (the browser scales it with the image).
// Owner: DRAW (ux010).
// SPDX-License-Identifier: GPL-3.0-or-later

export type SketchCursorKind = 'draw' | 'grab' | 'grabbing';
export type CursorTone = 'light' | 'dark';

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

/** The body (32-unit SVG), hotspot and keyword of each cursor. */
export function cursorParts(kind: SketchCursorKind, icon?: string | null, tone: CursorTone = 'light'): { body: string; x: number; y: number; fallback: string } {
  const k = INKS[tone];
  switch (kind) {
    case 'draw':
      return { body: cross(k) + (icon ? toolIcon(icon, k) : ''), x: 10, y: 10, fallback: 'crosshair' };
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
 * What the canvas shows for a keyword a tool asks for: 'crosshair' the draw cursor (with the tool's
 * icon), 'move' and 'grab' the open hand, 'grabbing' the closed hand; other keywords as they are.
 */
export function cursorFor(keyword: string, icon?: string | null, tone: CursorTone = 'light'): string {
  switch (keyword) {
    case 'crosshair':
      return sketchCursor('draw', icon, tone);
    case 'move':
    case 'grab':
      return sketchCursor('grab', null, tone);
    case 'grabbing':
      return sketchCursor('grabbing', null, tone);
    default:
      return keyword;
  }
}
