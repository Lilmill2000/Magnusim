// What floats over the viewport, and where an HTML element drawn in the view
// (a sketch value box, an origin plane's label) can go without being hidden by
// it: the tree card and the open panel (the children of [data-view-cover]), the
// dock's chips, the view buttons and the triad, and an open view popover.
// Review P2/P3 round 3: value boxes sat under the Sketch panel and the dock's
// chips, so the typed value could not be seen; "Right" showed as "ght" beside
// the Parameters panel.
// Owner: INTEGRATE.
// SPDX-License-Identifier: GPL-3.0-or-later

/** A rectangle in client px. */
export interface ScreenRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** The floating chrome's elements (see the file comment). */
export const FLOATING_CHROME = '[data-view-cover] > *, [data-cad-dock] > *, [data-cad-gizmo] > *, [data-vp-pop]';

/** The rectangles of the floating chrome shown now (client px). */
export function floatingRects(doc: Document): ScreenRect[] {
  const out: ScreenRect[] = [];
  for (const el of Array.from(doc.querySelectorAll<HTMLElement>(FLOATING_CHROME))) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) out.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
  }
  return out;
}

/** Whether two rectangles come closer than `gap` px. */
export function near(a: ScreenRect, b: ScreenRect, gap = 0): boolean {
  return a.left < b.right + gap && b.left < a.right + gap && a.top < b.bottom + gap && b.top < a.bottom + gap;
}

/**
 * Where a w x h element goes: the spot nearest `want` (its top-left) inside `area`
 * that keeps `gap` px from every rectangle in `taken`, or null when none fits.
 * The candidates are the wanted spot and every spot flush beside a taken rectangle
 * or an edge of the area (the nearest free spot is always one of them). Nearest
 * counts a move sideways `side` times a move up or down, so an element stays under
 * or over what it belongs to where it can, and a move up a little more than a move
 * down.
 */
export function freeSpot(
  want: { left: number; top: number },
  w: number,
  h: number,
  taken: readonly ScreenRect[],
  area: ScreenRect,
  gap = 4,
  side = 1.5,
): { left: number; top: number } | null {
  const xs = new Set<number>([want.left, area.left, area.right - w]);
  const ys = new Set<number>([want.top, area.top, area.bottom - h]);
  for (const t of taken) {
    xs.add(t.right + gap);
    xs.add(t.left - gap - w);
    ys.add(t.bottom + gap);
    ys.add(t.top - gap - h);
  }
  let best: { left: number; top: number } | null = null;
  let cost = Infinity;
  for (const x of xs) {
    if (x < area.left - 0.5 || x + w > area.right + 0.5) continue;
    for (const y of ys) {
      if (y < area.top - 0.5 || y + h > area.bottom + 0.5) continue;
      const dx = x - want.left;
      const dy = y - want.top;
      const c = Math.abs(dx) * side + Math.abs(dy) * (dy < 0 ? 1.1 : 1);
      if (c >= cost) continue;
      const r = { left: x, top: y, right: x + w, bottom: y + h };
      // Rounded to whole px when placed: keep half a pixel more.
      if (taken.some((t) => near(r, t, gap - 0.5))) continue;
      best = { left: x, top: y };
      cost = c;
    }
  }
  return best;
}
