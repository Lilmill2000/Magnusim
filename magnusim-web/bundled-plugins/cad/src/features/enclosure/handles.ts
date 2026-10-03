// While an Enclosure panel is open: a drag arrow on each side (layer
// enclosure.handles, order 50). A box has six (+X ... -Z, from the middle of
// each face, outwards); a cylinder three (Radius across the axis at
// mid-height, Top and Bottom along it). Dragging an arrow moves that side out
// or in: the side's own value (EnclosureFeature.sides) becomes its padding as
// built plus how far the arrow went, rounded to what a pixel means at that
// zoom. The body follows live (the panel session applies it at most every
// 90 ms) and the release stores the value; the value shows beside the arrow
// ("+X 12.5 mm"). The other sides keep theirs. A side goes into the part as far
// as the part's far side and no further (sideMin): the arrow stops there and
// its value says so (SD review round 1: −X dragged past the part made a slab
// beside it).
// Owner: SD pass (src/features/enclosure/).
// SPDX-License-Identifier: GPL-3.0-or-later
import { ConeGeometry, CylinderGeometry, Group, Mesh, MeshBasicMaterial, Quaternion, Vector3 } from 'three';
import type { AppServices } from '../../types/app';
import type { EnclosureFeature, EnclosureSide, OriginAxisRef, Vec3 } from '../../types/doc';
import type { EditSession, EnclosureOutput } from '../../types/doc-service';
import type { DocUnits } from '../../types/units';
import type { OverlayLayer, ViewportHandle, ViewportTool } from '../../types/viewport';
import { formatQuantity } from '../../ui/kit/format';
import { PICK_COLOR } from '../../viewport/colors';
import { axisParamAt, roundedDistance } from '../extrude/handle';
import { sideAnchors, sideLabel, sideMinWith, type EnclosureShape } from './geometry';

export const HANDLES_LAYER = 'enclosure.handles';
export const HANDLES_TOOL_ID = 'enclosure.handles';
/** Arrow size in CSS px (as the extrude's): shaft length and radius, head length and radius; grab distance. */
const SHAFT_PX = 52;
const SHAFT_R_PX = 1.8;
const HEAD_PX = 16;
const HEAD_R_PX = 6.5;
const GRAB_PX = 12;
/** Live drag updates at most this often (ms); the release always applies. */
const DRAG_APPLY_MS = 90;

export interface SideArrow {
  side: EnclosureSide;
  base: Vec3;
  dir: Vec3;
}

/** The shape the output describes (what was built), or null. */
export function shapeOfOutput(out: EnclosureOutput | null | undefined): EnclosureShape | null {
  if (!out) return null;
  if (out.box) return { kind: 'box', min: out.box.min, max: out.box.max, pad: out.pad };
  if (out.cylinder) return { kind: 'cylinder', ...out.cylinder, pad: out.pad };
  return null;
}

/** The arrows for what was built (null output: none). */
export function arrowsOf(out: EnclosureOutput | null | undefined): SideArrow[] {
  const s = shapeOfOutput(out);
  return s ? sideAnchors(s) : [];
}

/** The axis of what was built (a box: Z, which no side of a box uses). */
export function outputAxis(out: EnclosureOutput): OriginAxisRef {
  const a = out.cylinder?.axis;
  return a ? (a[0] ? 'origin:x' : a[1] ? 'origin:y' : 'origin:z') : 'origin:z';
}

/** The least value a side's arrow can take (mm): the part's far side (geometry sideMin), with the other sides as built. */
export function dragMin(out: EnclosureOutput, side: EnclosureSide): number {
  return sideMinWith(side, outputAxis(out), out.bbox, (s) => out.pad[s] ?? 0);
}

/**
 * The side's new value when its arrow was dragged `t` mm out (negative: in), or null when the move
 * is under a pixel. `limited`: it stopped at dragMin (the value is the least step past it).
 */
export function draggedSide(out: EnclosureOutput, side: EnclosureSide, t: number, pixelMm: number, units: DocUnits): { expr: string; mm: number; limited: boolean } | null {
  const pad0 = out.pad[side] ?? 0;
  if (Math.abs(t) < Math.max(pixelMm, 1e-6) / 2) return null;
  const min = dragMin(out, side);
  const r = roundedDistance(pad0 + t, pixelMm, units);
  if (r.mm >= min) return { ...r, limited: false };
  // Half a pixel past the limit rounds to a value the limit allows.
  const at = roundedDistance(min + Math.max(pixelMm, 1e-6) * 0.51, pixelMm, units);
  return { ...(at.mm >= min ? at : { expr: `${min + 1e-6} mm`, mm: min + 1e-6 }), limited: true };
}

class Arrows {
  private readonly mat: MeshBasicMaterial;
  private readonly hot: MeshBasicMaterial;
  private readonly items: { group: Group; arrow: SideArrow }[] = [];
  readonly label: HTMLElement;
  private lit: EnclosureSide | null = null;

  constructor(
    private readonly layer: OverlayLayer,
    color: number,
  ) {
    this.mat = new MeshBasicMaterial({ color, depthTest: false, depthWrite: false, transparent: true, opacity: 0.95 });
    this.hot = new MeshBasicMaterial({ color: PICK_COLOR, depthTest: false, depthWrite: false, transparent: true, opacity: 0.95 });
    this.label = document.createElement('span');
    this.label.className = 'cad-extrude-value cad-enclosure-value';
    this.label.dataset.enclosureValue = '1';
    this.label.style.display = 'none';
    layer.html.appendChild(this.label);
  }

  set(arrows: SideArrow[]) {
    while (this.items.length > arrows.length) {
      const it = this.items.pop()!;
      this.layer.group.remove(it.group);
      for (const c of it.group.children) (c as Mesh).geometry.dispose();
    }
    while (this.items.length < arrows.length) {
      const g = new Group();
      const shaft = new Mesh(new CylinderGeometry(SHAFT_R_PX, SHAFT_R_PX, SHAFT_PX, 10), this.mat);
      shaft.position.y = SHAFT_PX / 2;
      const head = new Mesh(new ConeGeometry(HEAD_R_PX, HEAD_PX, 18), this.mat);
      head.position.y = SHAFT_PX + HEAD_PX / 2;
      for (const m of [shaft, head]) {
        m.renderOrder = 10;
        m.frustumCulled = false;
      }
      g.add(shaft, head);
      g.name = 'enclosure-arrow';
      this.layer.group.add(g);
      this.items.push({ group: g, arrow: arrows[this.items.length] });
    }
    arrows.forEach((a, i) => {
      this.items[i].arrow = a;
      this.items[i].group.userData.side = a.side;
    });
    this.lit = null;
    for (const { group } of this.items) for (const c of group.children) (c as Mesh).material = this.mat;
    this.layer.changed();
  }

  /** The arrows now (tests read where they are through the panel tool's `arrows()`). */
  list(): SideArrow[] {
    return this.items.map((i) => i.arrow);
  }

  place(handle: ViewportHandle) {
    const up = new Vector3(0, 1, 0);
    for (const { group, arrow } of this.items) {
      const s = handle.pixelSize(arrow.base);
      group.position.set(...arrow.base);
      group.quaternion.copy(new Quaternion().setFromUnitVectors(up, new Vector3(...arrow.dir).normalize()));
      group.scale.setScalar(s);
    }
  }

  highlight(side: EnclosureSide | null) {
    if (side === this.lit) return;
    this.lit = side;
    for (const { group, arrow } of this.items) for (const c of group.children) (c as Mesh).material = arrow.side === side ? this.hot : this.mat;
    this.layer.changed();
  }

  /** The arrow within grabbing distance of frame client coordinates (the nearest), or null. */
  at(handle: ViewportHandle, x: number, y: number): SideArrow | null {
    let best: { a: SideArrow; d: number } | null = null;
    for (const { arrow } of this.items) {
      const s = handle.pixelSize(arrow.base);
      const p0 = handle.project(arrow.base);
      const p1 = handle.project([arrow.base[0] + arrow.dir[0] * (SHAFT_PX + HEAD_PX) * s, arrow.base[1] + arrow.dir[1] * (SHAFT_PX + HEAD_PX) * s, arrow.base[2] + arrow.dir[2] * (SHAFT_PX + HEAD_PX) * s]);
      if (!p0 || !p1) continue;
      const vx = p1[0] - p0[0];
      const vy = p1[1] - p0[1];
      const l2 = vx * vx + vy * vy;
      // An arrow seen end-on has no length on screen: only its tip can be taken.
      const t = l2 < 1 ? 0 : Math.max(0, Math.min(1, ((x - p0[0]) * vx + (y - p0[1]) * vy) / l2));
      const d = Math.hypot(x - (p0[0] + t * vx), y - (p0[1] + t * vy));
      if (d <= GRAB_PX && (!best || d < best.d)) best = { a: arrow, d };
    }
    return best?.a ?? null;
  }

  dispose() {
    this.set([]);
    this.mat.dispose();
    this.hot.dispose();
    this.label.remove();
  }
}

export interface EnclosureToolOptions {
  session: EditSession;
  color: number;
  /** The enclosure's last build output (what the arrows sit on), or null. */
  output(): EnclosureOutput | null;
}

/**
 * The open Enclosure panel's arrows and their tool. Returns stop; `refresh`
 * re-places the arrows after a rebuild; `arrows()` says where they are now.
 */
export function startEnclosureHandles(services: AppServices, handle: ViewportHandle, opts: EnclosureToolOptions): { stop(): void; refresh(): void; dragging(): boolean; arrows(): SideArrow[] } {
  const layer = handle.addLayer(HANDLES_LAYER, { order: 50 });
  const arrows = new Arrows(layer, opts.color);
  /** `applied`: a live update went to the session during this drag; `before`: the side's own value when it began (none: it followed the padding). */
  let drag: { arrow: SideArrow; base0: Vec3; grab: number; lastApply: number; pending: { expr: string; mm: number } | null; applied: boolean; out: EnclosureOutput; before: string | undefined } | null = null;
  let swallowClick = false;
  /** Escape ended a drag with the button still down: the rest of that press is the drag's. */
  let held = false;
  let stopped = false;
  const units = () => services.doc.state.get().doc.units;
  const draft = () => opts.session.draft as EnclosureFeature;
  const canvas = layer.html.parentElement?.querySelector<HTMLCanvasElement>('canvas') ?? null;
  let cursorSet = '';
  const cursor = (c: '' | 'grab' | 'grabbing') => {
    if (!canvas || c === cursorSet) return;
    cursorSet = c;
    canvas.style.cursor = c;
  };

  const refresh = () => {
    if (stopped || drag) return;
    arrows.set(arrowsOf(opts.output()));
    arrows.place(handle);
  };

  const showValue = (side: EnclosureSide, mm: number, at: Vec3, limited: boolean) => {
    const p = handle.project(at);
    const box = layer.html.getBoundingClientRect();
    if (!p) return;
    const axis = drag ? outputAxis(drag.out) : 'origin:z';
    // One minus sign throughout: the side's name has U+2212 ("−X"), so its value does too (SD review round 2: "−X -39.9 mm").
    arrows.label.textContent = `${sideLabel(side, axis)} ${formatQuantity(mm, 'length', units()).replace(/^-/, '−')}${limited ? ' · as far in as it goes' : ''}`;
    arrows.label.dataset.limited = limited ? '1' : '';
    arrows.label.style.display = '';
    arrows.label.style.transform = `translate(${(p[0] - box.left + 14).toFixed(1)}px, ${(p[1] - box.top - 10).toFixed(1)}px)`;
  };

  const apply = (side: EnclosureSide, expr: string | null) => {
    if (expr == null || !opts.session.open) return;
    const f = draft();
    opts.session.update({ sides: { ...(f.sides ?? {}), [side]: expr } } as Partial<EnclosureFeature>);
  };

  // Escape during a drag puts the side back as it was and keeps the panel open, as Escape does for a
  // typed field (SD review round 2: it closed the panel and kept the dragged value).
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !drag) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const d = drag;
    drag = null;
    held = true;
    arrows.label.style.display = 'none';
    arrows.highlight(null);
    cursor('');
    if (d.applied && opts.session.open) {
      const sides = { ...(draft().sides ?? {}) };
      if (d.before === undefined) delete sides[d.arrow.side];
      else sides[d.arrow.side] = d.before;
      opts.session.update({ sides } as Partial<EnclosureFeature>);
    }
    refresh();
  };
  window.addEventListener('keydown', onKey, true);

  const tool: ViewportTool = {
    id: HANDLES_TOOL_ID,
    onPointer(e) {
      if (held) {
        if (e.type === 'up' || e.type === 'leave') {
          held = false;
          swallowClick = e.type === 'up';
        }
        return true;
      }
      if (services.mode.get().mode !== 'model') return false;
      if (drag) {
        if (e.type === 'move') {
          const d = drag;
          const at = axisParamAt(d.base0, d.arrow.dir, e.ray);
          if (at == null) return true;
          const t = at - d.grab;
          const px = handle.pixelSize(d.base0);
          const next = draggedSide(d.out, d.arrow.side, t, px, units());
          // The arrow stops where the side stops (never past the part's far side).
          const tt = next?.limited ? next.mm - (d.out.pad[d.arrow.side] ?? 0) : t;
          d.arrow.base = [d.base0[0] + d.arrow.dir[0] * tt, d.base0[1] + d.arrow.dir[1] * tt, d.base0[2] + d.arrow.dir[2] * tt];
          arrows.place(handle);
          layer.changed();
          if (!next) return true;
          d.pending = next;
          showValue(d.arrow.side, next.mm, d.arrow.base, next.limited);
          const now = performance.now();
          if (now - d.lastApply >= DRAG_APPLY_MS && services.doc.state.get().rebuild.status !== 'running') {
            d.lastApply = now;
            apply(d.arrow.side, next.expr);
            d.applied = true;
            d.pending = null;
          }
          return true;
        }
        if (e.type === 'up' || e.type === 'leave') {
          const d = drag;
          drag = null;
          swallowClick = e.type === 'up';
          arrows.label.style.display = 'none';
          arrows.highlight(null);
          cursor(e.type === 'up' && arrows.at(handle, e.clientX, e.clientY) ? 'grab' : '');
          // The release point is where the side goes: moves are drawn once a frame, so the last
          // one before a quick release may not have been seen (a 25 mm drag stored 22.7 mm).
          const at = e.type === 'up' ? axisParamAt(d.base0, d.arrow.dir, e.ray) : null;
          const px = handle.pixelSize(d.base0);
          // Back where it was taken: the value it had (only if a live update changed it meanwhile).
          const last = at == null ? d.pending : (draggedSide(d.out, d.arrow.side, at - d.grab, px, units()) ?? (d.applied ? roundedDistance(d.out.pad[d.arrow.side] ?? 0, px, units()) : null));
          if (last) apply(d.arrow.side, last.expr);
          refresh();
          return true;
        }
        return true;
      }
      if (e.type === 'down' && e.button === 0 && !e.alt) {
        const a = arrows.at(handle, e.clientX, e.clientY);
        const out = opts.output();
        if (!a || !out) return false;
        const base0: Vec3 = [a.base[0], a.base[1], a.base[2]];
        const at = axisParamAt(base0, a.dir, e.ray);
        const own = draft().sides?.[a.side];
        drag = { arrow: a, base0, grab: at ?? 0, lastApply: 0, pending: null, applied: false, out, before: typeof own === 'string' && own !== '' ? own : undefined };
        arrows.highlight(a.side);
        cursor('grabbing');
        return true;
      }
      if (e.type === 'move' && !e.buttons) {
        const a = arrows.at(handle, e.clientX, e.clientY);
        arrows.highlight(a?.side ?? null);
        cursor(a ? 'grab' : '');
        return !!a;
      }
      if (e.type === 'click' && swallowClick) {
        swallowClick = false;
        return true;
      }
      swallowClick = false;
      if (e.type === 'leave') {
        arrows.highlight(null);
        cursor('');
      }
      return false;
    },
  };
  const pop = handle.pushTool(tool);
  const offFrame = handle.onFrame(() => arrows.place(handle));
  refresh();
  return {
    refresh,
    dragging: () => !!drag,
    arrows: () => arrows.list(),
    stop() {
      if (stopped) return;
      stopped = true;
      window.removeEventListener('keydown', onKey, true);
      cursor('');
      pop();
      offFrame();
      arrows.dispose();
      layer.dispose();
    },
  };
}
