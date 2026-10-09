// Sketch mode's Select tool (moved here from tools.ts in P4b; owner SELECT): a
// click picks (Ctrl toggles, Shift adds), a drag on geometry moves it (what is
// under-defined), a plain left drag elsewhere orbits and Shift + left drag pans
// (the viewport's, as in the core viewer: Daniel 2026-10-06), and Ctrl + left
// drag, anywhere, draws a selection box as in model mode (Daniel's must-have
// 6, SolidWorks style; Ctrl+Shift adds): left to right ENCLOSES
// (solid box: only what lies wholly inside), right to left TOUCHES (dashed:
// anything it meets). The box is tested on the SCREEN (each curve's samples
// projected), so it is right in any view, not only looking straight at the
// sketch. It takes curves, point entities and dimension labels, and with the
// sketch selection filter (the viewport's filter in sketch mode: Points,
// Curves, Dimensions) only those kinds (Points then also takes the ends and
// centres of curves). A press on a dimension label or a value box never
// reaches the canvas, so a box never starts on one.
// Owner: P4b SELECT.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { SketchFeature, Vec2 } from '../types/doc';
import { allInRect, BOX_START_PX, boxCombine, boxFrom, combineSelection, polylineMeetsRect, rectInRect, rectsMeet, type BoxMode, type Rect } from '../viewport/boxselect';
import { entityOf, ORIGIN, pointAt } from './model';
import { toModel, type SketchHit, type SketchMode, type SketchPointer, type SketchTool } from './mode';
import { drawnPoints, hitTest, samples } from './pick';
import { sketchFilterOf, type SketchPickKind } from './select-filter';
// ux010 (DRAW): a selected arc with a radius dimension shows the fillet's radius arrow.
import { RadiusHandle, radiusDimensionOf } from './tools/radius-handle';
import { autoProjectItem, modelItemAt } from './project/tools';

const DRAG_PX = 4;

const KIND_WORDS: Record<SketchPickKind, string> = { point: 'points', curve: 'curves', dimension: 'dimensions' };

/** The sketch box's caption: "Enclose · curves, points, dimensions". */
export function sketchBoxCaption(mode: BoxMode, filter: readonly SketchPickKind[]): string {
  const kinds: SketchPickKind[] = filter.length ? (['curve', 'point', 'dimension'] as const).filter((k) => filter.includes(k)) : ['curve', 'point', 'dimension'];
  return `${mode === 'enclose' ? 'Enclose' : 'Touch'} · ${kinds.map((k) => KIND_WORDS[k]).join(', ')}`;
}

/**
 * Whether the Select tool takes a left press: Ctrl (the box, or a Ctrl+click), or a press on sketch
 * geometry (a point or a curve: it drags, or refuses the drag of what is fully defined). Anything
 * else is the viewport's (orbit; Shift pans), and its click still reaches the tool.
 */
export function selectTakesPress(e: { ctrl: boolean }, hit: SketchHit | null): boolean {
  return e.ctrl || (!!hit && hit.what !== 'constraint');
}

/** What a click may pick under a sketch filter (empty = everything). */
export function hitOptions(filter: readonly SketchPickKind[]): { points: boolean; entities: boolean } {
  if (!filter.length) return { points: true, entities: true };
  return { points: filter.includes('point'), entities: filter.includes('curve') };
}

/**
 * The sketch items a screen box selects. `screen` projects a sketch u/v point to frame client px
 * (null behind the camera); `dims` are the dimension labels' screen boxes. With no filter: curves,
 * point entities and dimensions; with one, only its kinds (Points adds curve ends and centres).
 */
export function sketchBoxHits(
  f: Pick<SketchFeature, 'points' | 'entities'>,
  rect: Rect,
  mode: BoxMode,
  screen: (uv: Vec2) => [number, number] | null,
  filter: readonly SketchPickKind[] = [],
  dims: readonly { id: string; rect: Rect }[] = [],
): SketchHit[] {
  const want = (k: SketchPickKind) => !filter.length || filter.includes(k);
  const flat = (pts: Vec2[]): number[] | null => {
    const out: number[] = [];
    for (const p of pts) {
      const s = screen(p);
      if (!s) return null;
      out.push(s[0], s[1]);
    }
    return out;
  };
  const test = (pts: Vec2[]) => {
    const xy = flat(pts);
    if (!xy) return false;
    return mode === 'enclose' ? allInRect(rect, xy) : polylineMeetsRect(rect, xy);
  };
  const out: SketchHit[] = [];
  for (const e of f.entities) {
    if (e.kind === 'point' ? !want('point') : !want('curve')) continue;
    if (test(samples(f, e, 64))) out.push({ what: 'entity', id: e.id });
  }
  if (filter.includes('point')) {
    const entityPts = new Set(f.entities.filter((e) => e.kind === 'point').map((e) => (e as { p: string }).p));
    for (const id of drawnPoints(f)) {
      if (entityPts.has(id)) continue;
      const p = pointAt(f, id);
      if (p && test([p])) out.push({ what: 'point', id });
    }
  }
  if (want('dimension')) {
    for (const d of dims) if (mode === 'enclose' ? rectInRect(rect, d.rect) : rectsMeet(rect, d.rect)) out.push({ what: 'constraint', id: d.id });
  }
  return out;
}

/** The dimension labels on screen (client px), from sketch mode's annotation layer. */
function dimensionRects(doc: Document): { id: string; rect: Rect }[] {
  const out: { id: string; rect: Rect }[] = [];
  for (const el of Array.from(doc.querySelectorAll<HTMLElement>('[data-sketch-dim]:not(.is-preview)'))) {
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) continue;
    out.push({ id: el.getAttribute('data-sketch-dim') ?? '', rect: { x0: r.left, y0: r.top, x1: r.right, y1: r.bottom } });
  }
  return out;
}

/** The selection box element (the viewport's own look: .cad-box-select, data-box-mode), in client px. */
class BoxEl {
  private el: HTMLDivElement | null = null;
  constructor(private readonly host: () => HTMLElement | null) {}
  show(rect: Rect, mode: BoxMode, caption: string) {
    const host = this.host();
    if (!host) return;
    if (!this.el) {
      this.el = host.ownerDocument.createElement('div');
      this.el.className = 'cad-box-select';
      this.el.setAttribute('data-box-select', '1');
      const cap = host.ownerDocument.createElement('span');
      cap.className = 'cad-box-caption';
      this.el.appendChild(cap);
      host.appendChild(this.el);
    }
    const h = host.getBoundingClientRect();
    this.el.dataset.boxMode = mode;
    this.el.style.left = `${rect.x0 - h.left}px`;
    this.el.style.top = `${rect.y0 - h.top}px`;
    this.el.style.width = `${rect.x1 - rect.x0}px`;
    this.el.style.height = `${rect.y1 - rect.y0}px`;
    (this.el.firstElementChild as HTMLElement).textContent = caption;
  }
  hide() {
    this.el?.remove();
    this.el = null;
  }
}

export function selectTool(mode: SketchMode): SketchTool {
  let press: { at: Vec2; px: number; hit: SketchHit | null; client: [number, number]; ctrl: boolean; shift: boolean } | null = null;
  let dragging: 'drag' | 'window' | 'refused' | null = null;
  let starting: Promise<boolean> | null = null;
  /** The last Ctrl press was handled as a click at its release (its own click event is then ignored). */
  let ctrlClicked = false;
  const filter = sketchFilterOf(mode.services);
  const host = () => (mode.services.viewport.get().handle && typeof document !== 'undefined' ? (document.querySelector<HTMLElement>('[data-cad-canvas]')?.parentElement ?? null) : null);
  const box = new BoxEl(host);
  const hit = (d: SketchFeature, uv: Vec2, px: number) => hitTest(d, uv, px, hitOptions(filter.get().kinds));
  // Follow-up (Daniel, 2026-10-06: "I don't like how the mouse icon changes to the little red circle
  // with a line through it when the sketch is fully defined"): what cannot be dragged keeps the normal
  // arrow (the hover highlight still shows what is under it); a drag of it says why in the panel.
  const cursorFor = (h: SketchHit | null): string => {
    if (!h || h.what === 'constraint') return '';
    const a = mode.view.get().analysis;
    if (!a) return 'move';
    const s = h.what === 'point' ? a.perPoint[h.id] : a.perEntity[h.id];
    return s === 'fully' || h.id === ORIGIN ? '' : 'move';
  };
  /** Sketch u/v to frame client px: the view's own projection; without a view (unit tests), the press's local scale. */
  const screenOf = (p: { at: Vec2; px: number; client: [number, number] }): ((uv: Vec2) => [number, number] | null) => {
    const h = mode.services.viewport.get().handle;
    const plane = mode.plane();
    if (h && plane) return (uv) => h.project(toModel(plane, uv));
    return (uv) => [p.client[0] + (uv[0] - p.at[0]) / p.px, p.client[1] - (uv[1] - p.at[1]) / p.px];
  };
  const apply = (hits: SketchHit[], how: 'replace' | 'add' | 'toggle') => {
    const cur = mode.selected();
    mode.select(combineSelection(cur, hits, how, (h) => `${h.what}:${h.id}`), false);
  };
  // ---- ux010 (DRAW): one arc selected that a driving radius dimension holds (a fillet): its radius
  // arrow, dragged as right after the fillet was made (the panel's foot says why it stops).
  const radius = new RadiusHandle(mode, () => {
    mode.note(radius.stopped);
  });
  let grabbed = false;
  /** The release of a drag of the arrow: the click the view may send after it is the drag's. */
  let swallowClick = false;
  const showRadius = () => {
    const pv = mode.view.get().preview;
    const hs = radius.previewHandles() ?? [];
    if (!hs.length && !pv?.handles?.length) return;
    if (pv && (pv.window || pv.lines.length)) return;
    mode.setPreview(hs.length ? { lines: [], arcs: [], points: [], guides: [], glyphs: [], doomed: [], window: null, boxes: [], dimension: null, handles: hs } : null);
  };
  const pickRadius = () => {
    if (radius.dragging) return;
    const d = mode.stored();
    const sel = mode.selected();
    const one = sel.length === 1 && sel[0].what === 'entity' && d ? sel[0].id : null;
    const ent = one && d ? entityOf(d, one) : null;
    const dim = ent?.kind === 'arc' && d ? radiusDimensionOf(d, ent.id) : null;
    radius.target = ent && dim ? { arc: ent.id, dim } : null;
    radius.hovered = false;
    showRadius();
  };
  const offSel = mode.services.selection.subscribe(() => pickRadius());
  const offDraft = mode.view.subscribe((v, prev) => {
    // After an edit, an Undo or a Redo (they clear the preview): the arrow drawn again, or gone with its arc.
    const lost = !!prev.preview?.handles?.length && !v.preview?.handles?.length;
    if ((v.draft === prev.draft && !lost) || radius.dragging || !radius.target) return;
    radius.check();
    queueMicrotask(() => {
      if (mode.tool?.id === 'select' && !radius.dragging) showRadius();
    });
  });
  pickRadius();
  return {
    id: 'select',
    hint: () => 'Click to select (Ctrl toggles, Shift adds; Ctrl+click on a body vertex or edge adds it, projected). Ctrl+drag to box select: left to right selects what the box encloses, right to left what it touches (Ctrl+Shift adds). Drag under-defined geometry to move it; drag elsewhere to orbit.',
    // ux010 (PANELS): the compact panel's one line.
    shortHint: () => 'Click to select; Ctrl+drag to box select.',
    takesPress(e) {
      const d = mode.draft();
      // ux010 (DRAW): a press on the radius arrow is its drag.
      if (radius.target && radius.hit(e)) return true;
      return !!d && selectTakesPress(e, hit(d, e.uv, e.px));
    },
    cancel() {
      // ux010 (DRAW, review S4): Escape during the radius arrow's drag cancels it: nothing is stored.
      if (radius.dragging) {
        radius.cancel();
        grabbed = false;
        swallowClick = true;
        mode.note(null);
        showRadius();
        return true;
      }
      if (dragging === 'window') {
        dragging = null;
        press = null;
        box.hide();
        mode.setPreview(null);
        return true;
      }
      return false;
    },
    dispose() {
      box.hide();
      // ux010 (DRAW)
      radius.cancel();
      offSel();
      offDraft();
    },
    pointer(e) {
      const d = mode.draft();
      if (!d) return;
      // ---- ux010 (DRAW): the radius arrow of a selected fillet arc.
      if (swallowClick) {
        swallowClick = false;
        if (e.type === 'click') return;
      }
      if (e.type === 'down' && radius.target && radius.begin(e)) {
        grabbed = true;
        mode.setHover(null);
        showRadius();
        return;
      }
      if (grabbed) {
        if (e.type === 'move' && radius.dragging) {
          radius.move(e);
          showRadius();
        } else if (e.type === 'up') {
          grabbed = false;
          swallowClick = true;
          void radius.end().then(() => {
            mode.note(radius.stopped);
            showRadius();
          });
        }
        return;
      }
      if (e.type === 'move' && !e.pressed && radius.target) {
        const on = radius.hit(e);
        if (on !== radius.hovered) {
          radius.hovered = on;
          showRadius();
        }
        if (on) {
          mode.setHover(null);
          mode.view.set({ cursor: 'grab' });
          return;
        }
      }
      if (e.type === 'move' && !e.pressed) {
        const h = hit(d, e.uv, e.px);
        mode.setHover(h);
        mode.view.set({ cursor: cursorFor(h) });
        return;
      }
      if (e.type === 'down') {
        press = { at: e.uv, px: e.px, hit: hit(d, e.uv, e.px), client: [e.clientX, e.clientY], ctrl: e.ctrl, shift: e.shift };
        dragging = null;
        return;
      }
      if (e.type === 'move' && press) {
        // P4b SELECT (fix round 1): a Ctrl press boxes only past BOX_START_PX (a drifting Ctrl+click stays a click).
        const moved = Math.hypot(e.clientX - press.client[0], e.clientY - press.client[1]) > (press.ctrl ? BOX_START_PX : DRAG_PX);
        if (!dragging && moved) {
          if (press.ctrl) {
            dragging = 'window';
          } else if (press.hit && press.hit.what !== 'constraint' && press.hit.id !== ORIGIN) {
            const h = press.hit;
            const ent = h.what === 'entity' ? entityOf(d, h.id) : null;
            const target = h.what === 'point' ? { point: h.id } : ent?.kind === 'point' ? { point: ent.p } : { entity: h.id, grab: press.at };
            dragging = 'drag';
            starting = mode.beginDrag(target);
            void starting.then((ok) => {
              // Refused: mode.beginDrag put the reason in the panel ("... fully defined: change a dimension to move it").
              if (!ok && dragging === 'drag') dragging = 'refused';
            });
          } else if (press.hit && press.hit.id === ORIGIN) {
            dragging = 'refused';
            mode.note("The origin can't be moved: it is the sketch's fixed point");
          } else {
            dragging = 'window';
          }
        }
        if (dragging === 'drag') {
          void starting?.then((ok) => ok && mode.dragTo(e.uv));
        } else if (dragging === 'window') {
          const { rect, mode: m } = boxFrom(press.client[0], press.client[1], e.clientX, e.clientY);
          box.show(rect, m, sketchBoxCaption(m, filter.get().kinds));
        }
        return;
      }
      if (e.type === 'up' && press) {
        const p = press;
        const how = dragging;
        press = null;
        dragging = null;
        if (how === 'drag') {
          void starting?.then((ok) => (ok ? mode.endDrag() : undefined));
          starting = null;
        } else if (!how && p.ctrl) {
          // A Ctrl press let go before it became a box: the Ctrl+click it was (the view sends no click
          // after a drift past its click distance).
          ctrlClicked = true;
          click({ ...e, ctrl: true });
        } else if (how === 'window') {
          box.hide();
          mode.setPreview(null);
          const { rect, mode: m } = boxFrom(p.client[0], p.client[1], e.clientX, e.clientY);
          const hits = sketchBoxHits(d, rect, m, screenOf(p), filter.get().kinds, typeof document === 'undefined' ? [] : dimensionRects(document));
          apply(hits, boxCombine({ shift: p.shift || e.shift }));
        }
        return;
      }
      if (e.type === 'click') {
        if (ctrlClicked) {
          ctrlClicked = false;
          return;
        }
        click(e);
      }
    },
  };
  function click(e: SketchPointer) {
    const d = mode.draft();
    if (!d) return;
    const h = hit(d, e.uv, e.px);
    mode.note(null);
    if (h) apply([h], e.ctrl ? 'toggle' : e.shift ? 'add' : 'replace');
    else if ((e.ctrl || e.shift) && mode.selected().length) {
      // A body vertex or edge added to a sketch selection (Ctrl or Shift): auto-projected, so a
      // relation (Coincident, On curve, Midpoint, ...) can tie the sketch to it (scope addition A.3).
      const m = modelItemAt(mode, e);
      if (m) void autoProjectItem(mode, m).then((r) => r && apply([{ what: r.what, id: r.id }], 'add'));
    } else if (!e.ctrl && !e.shift) mode.select([], false);
  }
}
