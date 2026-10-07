// What sketch mode draws over the viewport while a sketch is edited, and how
// the viewport's pointer reaches its tools:
//   layer "sketch-geometry" (order 30, in the sketch's own plane frame): the
//     grid, entities coloured by definition state (under: the core's blue
//     accent, fully: #101828, over: red; construction dashed and muted),
//     points, the hover halo and the selection, a tool's preview (rubber band,
//     inference guides, a trim's doomed piece in red, the window), and the
//     dimensions' extension and dimension lines;
//   layer "sketch-annotations" (order 40, html): constraint glyphs (white
//     badges, selectable, deletable), dimension labels (driven grey in
//     parentheses; double-click edits, drag moves, right-click for Make it
//     driven / driving), the value boxes typed while drawing, and inference
//     glyphs at the pointer.
// The pointer tool takes left presses (Alt + left still orbits; middle pans,
// wheel and right drag zoom) and every move, double-click and right-click.
// Owner: P3-SKETCH.
// SPDX-License-Identifier: GPL-3.0-or-later
import { BufferGeometry, Color, Float32BufferAttribute, Group, Matrix4, Points, PointsMaterial, Vector3, type Object3D } from 'three';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { floatingRects, freeSpot, type ScreenRect } from '../lib/chrome';
import { openModal } from '../lib/modal';
import type { PlaneFrame, SketchConstraint, SketchDimension, SketchFeature, Vec2, Vec3 } from '../types/doc';
import type { FrameBox, OverlayLayer, ViewportHandle, ViewportPointer } from '../types/viewport';
import { uiFor } from '../ui/controller';
import type { MenuEntry } from '../ui/kit';
import { angleVertex, dimensionLabel, LABEL_GAP_PX, layoutDimension, type LabelReach } from './dimensions';
import { colourOf, overIds } from './dof';
import { mid, polar } from './geom';
import { GLYPH_ICON } from './icons';
import { entityOf, evaluateDimensions, isDimension, lineEnds, measureDimension, ORIGIN, pointAt, RELATION_LABELS, refLabel } from './model';
import { planeY, toModel, type SketchHit, type SketchMode, type SketchPointer, type SketchView } from './mode';
import { drawnPoints, hitTest, samples } from './pick';
// P4b SELECT
import { constructionItems } from './select-menu';
import { linkLook } from './project/style';
import { linkMenuItems } from './project/menu';

const SVG_NS = 'http://www.w3.org/2000/svg';

interface Palette {
  under: string;
  fully: string;
  over: string;
  construction: string;
  pick: string;
  hover: string;
  preview: string;
  dim: string;
  driven: string;
  grid: string;
  gridMajor: string;
  doomed: string;
  /** P4b (SELECT): linked geometry (purple) and a lost reference (amber). */
  linked: string;
  lost: string;
}

function readPalette(): Palette {
  const s = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => s.getPropertyValue(name).trim() || fallback;
  return {
    under: v('--cad-sketch-under', '#1570ef'),
    fully: v('--cad-sketch-full', '#101828'),
    over: v('--cad-sketch-over', '#b42318'),
    construction: v('--mg-text-muted', '#667085'),
    pick: v('--cad-pick', '#2ec47e'),
    hover: v('--cad-hover-pick', '#b2ccff'),
    preview: v('--mg-primary', '#1570ef'),
    dim: v('--mg-text', '#101828'),
    driven: v('--mg-text-muted', '#667085'),
    grid: v('--mg-divider', '#e8ebf0'),
    gridMajor: v('--mg-card-border', '#cfd3db'),
    doomed: v('--mg-danger', '#b42318'),
    linked: v('--cad-sketch-projected', '#7a3fd1'),
    lost: v('--cad-sketch-lost', '#b54708'),
  };
}

/** Fat lines in the sketch's plane (u, v, 0) with a colour per segment. */
class Lines {
  readonly obj: LineSegments2;
  readonly mat: LineMaterial;
  constructor(
    parent: Group,
    width: number,
    opts: { dashed?: boolean; depthTest?: boolean; opacity?: number; order?: number; under?: boolean } = {},
  ) {
    // Drawn in three.js' transparent pass (after the opaque bodies and in layer order), so the
    // profile shading of the layer below (order 20, translucent) never washes over sketch lines.
    this.mat = new LineMaterial({ linewidth: width, worldUnits: false, vertexColors: true, dashed: !!opts.dashed, transparent: !opts.under, opacity: opts.opacity ?? 1 });
    this.mat.depthTest = opts.depthTest ?? false;
    this.mat.depthWrite = false;
    this.obj = new LineSegments2(new LineSegmentsGeometry(), this.mat);
    this.obj.renderOrder = opts.order ?? 1000;
    this.obj.frustumCulled = false;
    parent.add(this.obj);
  }
  set(segs: { a: Vec2; b: Vec2; color: string }[]) {
    const pos = new Float32Array(Math.max(1, segs.length) * 6);
    const col = new Float32Array(Math.max(1, segs.length) * 6);
    const c = new Color();
    segs.forEach((s, i) => {
      pos.set([s.a[0], s.a[1], 0, s.b[0], s.b[1], 0], i * 6);
      c.setStyle(s.color);
      col.set([c.r, c.g, c.b, c.r, c.g, c.b], i * 6);
    });
    const g = new LineSegmentsGeometry();
    g.setPositions(pos);
    g.setColors(col);
    this.obj.geometry.dispose();
    this.obj.geometry = g;
    this.obj.visible = segs.length > 0;
    if (this.mat.dashed) this.obj.computeLineDistances();
  }
  dispose() {
    this.obj.geometry.dispose();
    this.mat.dispose();
  }
}

class Dots {
  readonly obj: Points;
  readonly mat: PointsMaterial;
  constructor(parent: Group, size: number) {
    this.mat = new PointsMaterial({ size, sizeAttenuation: false, vertexColors: true, depthTest: false, depthWrite: false, transparent: true });
    this.obj = new Points(new BufferGeometry(), this.mat);
    this.obj.renderOrder = 1010;
    this.obj.frustumCulled = false;
    parent.add(this.obj);
  }
  set(pts: { at: Vec2; color: string }[]) {
    const pos = new Float32Array(pts.length * 3);
    const col = new Float32Array(pts.length * 3);
    const c = new Color();
    pts.forEach((p, i) => {
      pos.set([p.at[0], p.at[1], 0], i * 3);
      c.setStyle(p.color);
      col.set([c.r, c.g, c.b], i * 3);
    });
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new Float32BufferAttribute(col, 3));
    this.obj.geometry.dispose();
    this.obj.geometry = g;
    this.obj.visible = pts.length > 0;
  }
  dispose() {
    this.obj.geometry.dispose();
    this.mat.dispose();
  }
}

function svgIcon(d: string, size = 12): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(SVG_NS, 'path');
  p.setAttribute('d', d);
  p.setAttribute('fill', 'none');
  p.setAttribute('stroke', 'currentColor');
  p.setAttribute('stroke-width', '2');
  p.setAttribute('stroke-linecap', 'round');
  p.setAttribute('stroke-linejoin', 'round');
  svg.append(p);
  return svg;
}

/** Where a relation's glyph sits: next to the entity it constrains (one glyph per curve it names). */
function glyphAnchors(f: SketchFeature, c: SketchConstraint): Vec2[] {
  const out: Vec2[] = [];
  const curveMid = (id: string): Vec2 | null => {
    const e = entityOf(f, id);
    if (!e) return null;
    if (e.kind === 'line') {
      const ends = lineEnds(f, id);
      return ends ? mid(ends[0], ends[1]) : null;
    }
    if (e.kind === 'point') return pointAt(f, e.p);
    const pts = samples(f, e, 16);
    return pts.length ? pts[Math.floor(pts.length / 2)] : null;
  };
  const at = (r: string) => pointAt(f, r) ?? curveMid(r);
  switch (c.kind) {
    case 'coincident':
    case 'point_on_line':
    case 'point_on_circle':
    case 'midpoint': {
      const p = at(c.refs[0]);
      if (p) out.push(p);
      break;
    }
    case 'horizontal':
    case 'vertical':
      if (c.refs.length === 2) {
        const a = at(c.refs[0]);
        const b = at(c.refs[1]);
        if (a && b) out.push(mid(a, b));
      } else {
        const p = at(c.refs[0]);
        if (p) out.push(p);
      }
      break;
    case 'symmetric': {
      const p = at(c.refs[2]);
      if (p) out.push(p);
      break;
    }
    case 'fix': {
      const p = at(c.refs[0]);
      if (p) out.push(p);
      break;
    }
    default:
      for (const r of c.refs) {
        const p = at(r);
        if (p) out.push(p);
      }
  }
  return out;
}

/** [u0, u1, v0, v1] in the sketch's plane. */
type UvBox = [number, number, number, number];

function uvBoxOf(pts: readonly Vec2[]): UvBox | null {
  let b: UvBox | null = null;
  for (const [u, v] of pts) {
    if (!Number.isFinite(u) || !Number.isFinite(v)) continue;
    if (!b) b = [u, u, v, v];
    else b = [Math.min(b[0], u), Math.max(b[1], u), Math.min(b[2], v), Math.max(b[3], v)];
  }
  return b;
}

function unionUv(a: UvBox | null, b: UvBox | null): UvBox | null {
  if (!a || !b) return a ?? b;
  return [Math.min(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.max(a[3], b[3])];
}

export function attachOverlay(mode: SketchMode, handle: ViewportHandle): () => void {
  const { services } = mode;
  const pal = readPalette();
  // The sketch's curves, points and dimensions count when the view frames the part (entering or
  // reopening the sketch, Fit, Look at, the standard views); its grid and origin do not.
  const geo: OverlayLayer = handle.addLayer('sketch-geometry', { order: 30, frame: () => frameBox() });
  const ann: OverlayLayer = handle.addLayer('sketch-annotations', { order: 40 });
  const frame = new Group();
  frame.matrixAutoUpdate = false;
  geo.group.add(frame);
  const dimFrame = new Group();
  dimFrame.matrixAutoUpdate = false;
  ann.group.add(dimFrame);
  const canvas = geo.html.parentElement?.querySelector<HTMLCanvasElement>('canvas') ?? null;

  // The grid lies on the plane, under bodies and profile shading (the opaque pass).
  const grid = new Lines(frame, 1, { depthTest: true, order: 900, under: true });
  // Pushed back a little: a face or an edge lying in the sketch plane (a box face sketched on) wins over it.
  grid.mat.polygonOffset = true;
  grid.mat.polygonOffsetFactor = 2;
  grid.mat.polygonOffsetUnits = 8;
  const halo = new Lines(frame, 7, { opacity: 0.85, order: 990 });
  // The core's edge width: the line's middle row is drawn in its colour, not blended (fully defined lines read #101828).
  const solid = new Lines(frame, 2.4);
  const dashed = new Lines(frame, 1.6, { dashed: true });
  const preview = new Lines(frame, 1.6, { order: 1001 });
  const guides = new Lines(frame, 1, { dashed: true, order: 1002 });
  const dots = new Dots(frame, 7);
  const dimLines = new Lines(dimFrame, 1, { order: 1003 });
  const html = ann.html;
  html.classList.add('cad-sketch-annotations');
  html.setAttribute('data-sketch-annotations', '1');

  // ------------------------------------------------------------ the plane frame
  let plane: PlaneFrame | null = null;
  const applyPlane = (p: PlaneFrame | null) => {
    plane = p;
    if (!p) return;
    const y = planeY(p);
    const m = new Matrix4().makeBasis(new Vector3(...p.xdir), new Vector3(...y), new Vector3(...p.normal)).setPosition(new Vector3(...p.origin));
    for (const g of [frame, dimFrame]) {
      g.matrix.copy(m);
      g.matrixWorldNeedsUpdate = true;
    }
  };
  applyPlane(mode.plane());

  const pxAt = (uv: Vec2) => (plane ? handle.pixelSize(toModel(plane, uv)) : 1);
  const hostRect = () => html.getBoundingClientRect();
  const screenOf = (uv: Vec2): [number, number] | null => {
    if (!plane) return null;
    const s = handle.project(toModel(plane, uv));
    if (!s) return null;
    const r = hostRect();
    return [s[0] - r.left, s[1] - r.top];
  };

  // ------------------------------------------------------------ what a framing shows
  /**
   * The u/v extent of the sketch's curves and points (`curvesUv`) and of its dimensions' lines
   * (`dimsUv`): what Fit, Look at and the framing of a reopened sketch show of it. Review P2/P3
   * round 4: sketch mode's layers did not count, so a reopened sketch was framed on bodies the
   * rollback hid, and most of it and its dimensions were off-screen.
   */
  let curvesUv: UvBox | null = null;
  let dimsUv: UvBox | null = null;
  function frameBox(): FrameBox | null {
    const b = unionUv(curvesUv, dimsUv);
    if (!plane || !b) return null;
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const uv of [[b[0], b[2]], [b[1], b[2]], [b[1], b[3]], [b[0], b[3]]] as Vec2[]) {
      const p = toModel(plane, uv);
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], p[k]);
        max[k] = Math.max(max[k], p[k]);
      }
    }
    return { min, max };
  }

  // ------------------------------------------------------------ geometry
  function drawGeometry(v: SketchView) {
    const d = v.draft;
    if (!d) {
      for (const l of [halo, solid, dashed, preview, guides, dimLines]) l.set([]);
      dots.set([]);
      curvesUv = null;
      dimsUv = null;
      return;
    }
    const over = overIds(d, [...(v.status?.conflicting ?? []), ...(v.status?.redundant ?? [])]);
    const sel = new Set(mode.selected().map((h) => h.id));
    const hov = v.hover?.id ?? null;
    const colorOf = (id: string, kind: 'entity' | 'point') => {
      if (sel.has(id)) return pal.pick;
      const s = colourOf(id, kind, v.analysis, over);
      return s === 'over' ? pal.over : s === 'fully' ? pal.fully : pal.under;
    };
    const solidSegs: { a: Vec2; b: Vec2; color: string }[] = [];
    const dashSegs: { a: Vec2; b: Vec2; color: string }[] = [];
    const haloSegs: { a: Vec2; b: Vec2; color: string }[] = [];
    // A constraint picked or hovered highlights what it constrains.
    const related = new Set<string>();
    for (const c of d.constraints) if (sel.has(c.id) || c.id === hov) c.refs.forEach((r) => related.add(r));
    // P4b (SELECT): linked entities purple (an auto-made reference drawn light: dashed), a lost one amber.
    const look = linkLook(d, mode.feature ? services.doc.state.get().rebuild.outputs[mode.feature] : undefined);
    for (const e of d.entities) {
      if (e.kind === 'point') continue;
      const pts = samples(d, e, 96);
      const construction = !!e.construction;
      let color = colorOf(e.id, 'entity');
      if (construction && !sel.has(e.id) && !over.has(e.id)) color = pal.construction;
      const lk = look.entities.get(e.id);
      if (lk && !sel.has(e.id)) color = lk.lost ? pal.lost : pal.linked;
      const into = construction || lk?.light ? dashSegs : solidSegs;
      for (let i = 1; i < pts.length; i++) into.push({ a: pts[i - 1], b: pts[i], color });
      if (e.id === hov || related.has(e.id)) for (let i = 1; i < pts.length; i++) haloSegs.push({ a: pts[i - 1], b: pts[i], color: pal.hover });
    }
    solid.set(solidSegs);
    dashed.set(dashSegs);
    halo.set(haloSegs);
    const px = pxAt([0, 0]);
    dashed.mat.dashSize = 6 * px;
    dashed.mat.gapSize = 4 * px;
    guides.mat.dashSize = 4 * px;
    guides.mat.gapSize = 4 * px;
    const pts: { at: Vec2; color: string }[] = [{ at: [0, 0], color: sel.has(ORIGIN) ? pal.pick : pal.fully }];
    for (const id of drawnPoints(d)) {
      const p = pointAt(d, id);
      if (!p) continue;
      const pe = d.entities.find((e) => e.kind === 'point' && e.p === id);
      const key = pe ? pe.id : id;
      const lp = look.points.get(id);
      pts.push({ at: p, color: key === hov || related.has(id) ? pal.preview : sel.has(key) ? pal.pick : lp ? (lp.lost ? pal.lost : pal.linked) : colorOf(id, 'point') });
    }
    // What a framing shows of it: its curves and points (not the origin, nor a tool's preview).
    curvesUv = uvBoxOf([...solidSegs, ...dashSegs].flatMap((s) => [s.a, s.b]).concat(pts.slice(1).map((p) => p.at)));
    // The tool's preview.
    const pv = v.preview;
    const prevSegs: { a: Vec2; b: Vec2; color: string }[] = [];
    const guideSegs: { a: Vec2; b: Vec2; color: string }[] = [];
    if (pv) {
      for (const [a, b] of pv.lines) prevSegs.push({ a, b, color: pal.preview });
      for (const arc of pv.arcs) {
        const n = Math.max(8, Math.ceil((arc.sweep / (2 * Math.PI)) * 96));
        let prev = polar(arc.c, arc.r, arc.a0);
        for (let i = 1; i <= n; i++) {
          const cur = polar(arc.c, arc.r, arc.a0 + (arc.sweep * i) / n);
          prevSegs.push({ a: prev, b: cur, color: pal.preview });
          prev = cur;
        }
      }
      for (const [a, b] of pv.doomed) prevSegs.push({ a, b, color: pal.doomed });
      for (const [a, b] of pv.guides) guideSegs.push({ a, b, color: pal.preview });
      if (pv.window) {
        const { a, b, crossing } = pv.window;
        const c: Vec2[] = [a, [b[0], a[1]], b, [a[0], b[1]]];
        for (let i = 0; i < 4; i++) (crossing ? guideSegs : prevSegs).push({ a: c[i], b: c[(i + 1) % 4], color: pal.preview });
      }
      for (const p of pv.points) pts.push({ at: p, color: pal.preview });
    }
    // P4b (SKETCH): a selected control-point spline shows its control polygon dashed; a fit spline its tangent handles.
    for (const e of d.entities) {
      // P4b SELECT: a projected spline shows no control polygon (its poles are the source's).
      if (e.kind !== 'spline' || e.link || !(sel.has(e.id) || e.id === hov)) continue;
      const at = (id: string) => pointAt(d, id);
      if (e.form === 'control') {
        const ring = e.closed ? [...e.pts, e.pts[0]] : e.pts;
        for (let i = 1; i < ring.length; i++) {
          const a = at(ring[i - 1]);
          const b = at(ring[i]);
          if (a && b) guideSegs.push({ a, b, color: pal.construction });
        }
      }
      const hs = e.handles ?? [null, null];
      ([[e.pts[0], hs[0]], [e.pts[e.pts.length - 1], hs[1]]] as [string, string | null][]).forEach(([end, h]) => {
        const a = at(end);
        const b = h ? at(h) : null;
        if (a && b) guideSegs.push({ a, b, color: pal.construction });
      });
    }
    preview.set(prevSegs);
    guides.set(guideSegs);
    dots.set(pts);
    drawDimensions(v);
  }

  // ------------------------------------------------------------ the grid
  let gridKey = '';
  function drawGrid() {
    if (!plane || !canvas) return;
    const r = canvas.getBoundingClientRect();
    const corners = [
      [r.left, r.top],
      [r.right, r.top],
      [r.right, r.bottom],
      [r.left, r.bottom],
    ].map(([x, y]) => handle.toPlane(x, y, plane!)?.uv ?? null);
    if (corners.some((c) => !c)) {
      if (gridKey) grid.set([]);
      gridKey = '';
      return;
    }
    const us = corners.map((c) => c![0]);
    const vs = corners.map((c) => c![1]);
    const px = pxAt([(Math.min(...us) + Math.max(...us)) / 2, (Math.min(...vs) + Math.max(...vs)) / 2]);
    const step = Math.pow(10, Math.ceil(Math.log10(Math.max(1e-9, 14 * px))));
    const span = Math.max(Math.max(...us) - Math.min(...us), Math.max(...vs) - Math.min(...vs));
    if (span / step > 400) return;
    const u0 = Math.floor(Math.min(...us) / step) * step;
    const u1 = Math.ceil(Math.max(...us) / step) * step;
    const v0 = Math.floor(Math.min(...vs) / step) * step;
    const v1 = Math.ceil(Math.max(...vs) / step) * step;
    const key = [step, u0, u1, v0, v1].map((x) => x.toPrecision(6)).join('|');
    if (key === gridKey) return;
    gridKey = key;
    const segs: { a: Vec2; b: Vec2; color: string }[] = [];
    const major = pal.gridMajor;
    for (let u = u0; u <= u1 + step / 2; u += step) {
      const isMajor = Math.abs(u / (step * 10) - Math.round(u / (step * 10))) < 1e-6;
      segs.push({ a: [u, v0], b: [u, v1], color: isMajor ? major : pal.grid });
    }
    for (let w = v0; w <= v1 + step / 2; w += step) {
      const isMajor = Math.abs(w / (step * 10) - Math.round(w / (step * 10))) < 1e-6;
      segs.push({ a: [u0, w], b: [u1, w], color: isMajor ? major : pal.grid });
    }
    grid.set(segs);
  }

  // ------------------------------------------------------------ html: glyphs, dimensions, boxes
  const glyphEls = new Map<string, { el: HTMLElement; at: Vec2; slot: number }>();
  /** Each dimension's label: its element, where it stands (its centre), and its size (px) when last measured. */
  const dimEls = new Map<string, { el: HTMLElement; at: Vec2; size?: [number, number] }>();
  /**
   * ci2: how far a label of this size (px) reaches from its centre along a sketch direction, in mm
   * (dimensions.ts LabelReach): the pill is upright on the screen, so it is half its width times the
   * direction's screen x plus half its height times its screen y, at the scale the screen shows
   * that direction at (a slanted view shortens it).
   */
  const labelReach =
    ([w, h]: [number, number]): LabelReach =>
    (at, dir) => {
      const k = 32 * pxAt(at);
      const s0 = screenOf(at);
      const s1 = screenOf([at[0] + dir[0] * k, at[1] + dir[1] * k]);
      if (!s0 || !s1) return null;
      const len = Math.hypot(s1[0] - s0[0], s1[1] - s0[1]);
      if (len < 1e-6) return null;
      const reachPx = (Math.abs(s1[0] - s0[0]) / len) * (w / 2) + (Math.abs(s1[1] - s0[1]) / len) * (h / 2);
      return (reachPx * k) / len;
    };
  /**
   * The pixel size (mm per px where it stands) each dimension was laid out at: its label's
   * offset and its arrows are so many px. When the view's scale changes (a framing, a zoom,
   * a resize) the dimensions are laid out again at once. Review P2/P3 round 3: a reopened
   * sketch's framing changed the scale and the labels stayed at the old one until the next
   * render, so the first click on one moved them all and a double-click's second click missed.
   */
  const dimPx = new Map<string, { at: Vec2; px: number }>();
  const boxEls = new Map<string, { wrap: HTMLElement; input: HTMLInputElement; err: HTMLElement; at: Vec2; along: [Vec2, Vec2] | null }>();
  /** The pointer over the canvas (client px), so value boxes keep out from under it. */
  let pointerAt: [number, number] | null = null;
  const inferEls: { el: HTMLElement; at: Vec2; slot: number }[] = [];
  let editor: { id: string; input: HTMLInputElement; at: Vec2; close(commit: boolean): void } | null = null;
  let labelDrag: { id: string; at: Vec2 } | null = null;

  const forwardWheel = (el: HTMLElement) =>
    el.addEventListener(
      'wheel',
      (e) => {
        if (!canvas) return;
        e.preventDefault();
        canvas.dispatchEvent(new WheelEvent('wheel', e));
      },
      { passive: false },
    );

  function pickConstraint(id: string, additive: boolean, fromClick = false) {
    if (refusedPick(id, fromClick)) return;
    mode.select([{ what: 'constraint', id }], additive);
  }

  /**
   * Review P7: a refused label click says why only once it is not the first click of a
   * double-click (which edits the value, a legitimate use in Mirror and Dimension): the note
   * waits the double-click time and a double-click cancels it.
   */
  let refusalNote: ReturnType<typeof setTimeout> | null = null;
  const DOUBLE_CLICK_MS = 400;
  function cancelRefusalNote() {
    if (refusalNote) clearTimeout(refusalNote);
    refusalNote = null;
  }

  /**
   * ci2: a tool whose picks are the selection (Mirror, the patterns, ...) keeps them when a
   * dimension label or relation glyph is clicked, and says why it isn't a pick (SketchTool
   * refusesPick). Linux CI: a click on Mirror's second line landed on a label, which replaced
   * the picks with the dimension and dropped the first line. True when refused.
   */
  function refusedPick(id: string, deferNote = false): boolean {
    const c = mode.draft()?.constraints.find((k) => k.id === id);
    const why = mode.tool?.refusesPick?.(c && isDimension(c) ? 'dimension' : 'relation');
    if (!why) return false;
    cancelRefusalNote();
    if (deferNote && c && isDimension(c)) {
      refusalNote = setTimeout(() => {
        refusalNote = null;
        if (!mode.view.get().editing) mode.note(why);
      }, DOUBLE_CLICK_MS);
    } else mode.note(why);
    return true;
  }

  function glyphMenu(id: string, x: number, y: number) {
    const d = mode.draft();
    const c = d?.constraints.find((k) => k.id === id);
    if (!d || !c) return;
    // ci2: its menu acts on the selection (Delete): not while a tool's picks are the selection.
    if (refusedPick(id)) return;
    if (!mode.selected().some((h) => h.id === id)) pickConstraint(id, false);
    const items: MenuEntry[] = [{ id: 'delete', label: `Delete ${isDimension(c) ? 'dimension' : RELATION_LABELS[c.kind as keyof typeof RELATION_LABELS]}`, danger: true, run: () => void mode.deleteSelected() }];
    if (isDimension(c)) {
      items.unshift(
        { id: 'edit', label: 'Edit value', disabled: c.driving ? null : 'A driven dimension only shows a value', run: () => mode.view.set({ editing: id }) },
        { id: 'driving', label: c.driving ? 'Make it driven' : 'Make it driving', run: () => void mode.toggleDriving(id) },
        { sep: true, id: 'sep-dim' },
      );
    }
    uiFor(services).showMenu(x, y, items, 'Sketch');
  }

  function syncGlyphs(v: SketchView) {
    const d = v.draft;
    const keep = new Set<string>();
    if (d) {
      const slots = new Map<string, number>();
      const sel = new Set(mode.selected().map((h) => h.id));
      const conflict = new Set([...(v.status?.conflicting ?? []), ...(v.status?.redundant ?? [])]);
      for (const c of d.constraints) {
        if (isDimension(c)) continue;
        const anchors = glyphAnchors(d, c);
        anchors.forEach((at, i) => {
          const key = `${c.id}:${i}`;
          keep.add(key);
          const slotKey = `${at[0].toFixed(6)},${at[1].toFixed(6)}`;
          const slot = slots.get(slotKey) ?? 0;
          slots.set(slotKey, slot + 1);
          let rec = glyphEls.get(key);
          if (!rec) {
            const el = document.createElement('div');
            el.className = 'cad-sk-glyph';
            el.setAttribute('data-sketch-glyph', c.kind);
            el.setAttribute('data-constraint', c.id);
            // A button for the keyboard and screen readers too: Tab reaches it, Space or Enter selects it
            // (then Delete deletes it); review P2/P3 round 1: a div with only a title.
            el.setAttribute('role', 'button');
            el.tabIndex = 0;
            el.addEventListener('keydown', (e) => {
              if (e.key !== 'Enter' && e.key !== ' ') return;
              e.preventDefault();
              e.stopPropagation();
              pickConstraint(c.id, e.ctrlKey || e.metaKey);
            });
            el.append(svgIcon(GLYPH_ICON[c.kind] ?? GLYPH_ICON.coincident));
            el.addEventListener('pointerdown', (e) => e.stopPropagation());
            el.addEventListener('click', (e) => {
              e.stopPropagation();
              pickConstraint(c.id, e.ctrlKey || e.metaKey);
            });
            el.addEventListener('pointerenter', () => mode.setHover({ what: 'constraint', id: c.id }));
            el.addEventListener('pointerleave', () => mode.setHover(null));
            el.addEventListener('contextmenu', (e) => {
              e.preventDefault();
              e.stopPropagation();
              glyphMenu(c.id, e.clientX, e.clientY);
            });
            forwardWheel(el);
            html.append(el);
            rec = { el, at, slot };
            glyphEls.set(key, rec);
          }
          rec.at = at;
          rec.slot = slot;
          // Its words follow what it refers to now (review P2/P3 round 1: after a trim the On line
          // kept naming the old piece; they were set once, when the glyph was made).
          const words = `${RELATION_LABELS[c.kind as keyof typeof RELATION_LABELS] ?? c.kind}: ${c.refs.map((r) => refLabel(d, r)).join(', ')}`;
          if (rec.el.title !== words) {
            rec.el.title = words;
            rec.el.setAttribute('aria-label', words);
          }
          rec.el.classList.toggle('is-selected', sel.has(c.id));
          rec.el.setAttribute('aria-pressed', sel.has(c.id) ? 'true' : 'false');
          rec.el.classList.toggle('is-over', conflict.has(c.id));
          rec.el.classList.toggle('is-inferred', !!(c as { inferred?: boolean }).inferred);
        });
      }
    }
    for (const [k, rec] of glyphEls) if (!keep.has(k)) {
      rec.el.remove();
      glyphEls.delete(k);
    }
  }

  function dimValue(d: SketchFeature, c: SketchDimension): number | null {
    if (c.driving) {
      const ev = evaluateDimensions({ constraints: [c] }, services.doc.units);
      if (ev.values[c.id] != null) return ev.values[c.id];
    }
    return measureDimension(d, c);
  }

  function drawDimensions(v: SketchView) {
    const d = v.draft;
    const segs: { a: Vec2; b: Vec2; color: string }[] = [];
    const keep = new Set<string>();
    /** The dimensions' lines and labels (not one being placed): what a framing shows of them. */
    const shown: Vec2[] = [];
    dimPx.clear();
    if (d) {
      const sel = new Set(mode.selected().map((h) => h.id));
      const conflict = new Set([...(v.status?.conflicting ?? []), ...(v.status?.redundant ?? [])]);
      // Not solved with nothing flagged: the driving dimensions are what cannot all hold (red, as the panel lists them).
      if (v.status?.state === 'unsolved' && !conflict.size) for (const c of d.constraints) if (isDimension(c) && c.driving) conflict.add(c.id);
      const list: (SketchDimension & { preview?: boolean })[] = d.constraints.filter(isDimension).map((c) => (labelDrag?.id === c.id ? { ...c, at: labelDrag.at } : c));
      if (v.preview?.dimension) {
        const pd = v.preview.dimension;
        list.push({ id: '#preview', kind: pd.kind as SketchDimension['kind'], refs: pd.refs, expr: '', driving: true, at: pd.at, preview: true });
      }
      // ci2: each label's words first, then every label's size (one layout read for them all), then
      // where each goes: a label with no place of its own stands with its near side a gap from what it
      // measures, however wide its words are (Linux's DejaVu Sans put a vertical line's "20 mm" pill
      // on the line, so a click on the line picked the label).
      const labels = list.map((c) => {
        const value = c.preview ? measureDimension(d, c) : dimValue(d, c);
        const text = value == null ? '?' : dimensionLabel(c, value, services.doc.units);
        let rec = dimEls.get(c.id);
        if (!rec) {
          const el = document.createElement('div');
          el.className = 'cad-sk-dim';
          el.setAttribute('data-sketch-dim', c.id);
          if (!c.preview) wireDimension(el, c.id);
          else el.classList.add('is-preview');
          forwardWheel(el);
          html.append(el);
          rec = { el, at: c.at ?? [0, 0] };
          dimEls.set(c.id, rec);
        }
        if (rec.el.textContent !== text) rec.el.textContent = text;
        return { c, rec, text };
      });
      for (const { rec } of labels) {
        // Hidden (off the view): the size it last had.
        const w = rec.el.offsetWidth;
        const h = rec.el.offsetHeight;
        if (w > 0 && h > 0) rec.size = [w, h];
      }
      // Review P1: a label with no place of its own also keeps a gap from the labels placed before it
      // (a 30° pill covered its line's "40 mm"): it is moved out, away from the one it overlaps.
      const placed: { at: Vec2; s: [number, number]; size: [number, number] }[] = [];
      const overlapPx = (s: [number, number], size: [number, number]) => {
        let worst: { other: (typeof placed)[number]; by: number } | null = null;
        for (const q of placed) {
          const ox = (size[0] + q.size[0]) / 2 + LABEL_GAP_PX - Math.abs(s[0] - q.s[0]);
          const oy = (size[1] + q.size[1]) / 2 + LABEL_GAP_PX - Math.abs(s[1] - q.s[1]);
          if (ox > 0 && oy > 0 && (!worst || Math.min(ox, oy) > worst.by)) worst = { other: q, by: Math.min(ox, oy) };
        }
        return worst;
      };
      for (const { c, rec, text } of labels) {
        const px = pxAt(c.at ?? [0, 0]);
        dimPx.set(c.id, { at: c.at ?? [0, 0], px });
        let lay = layoutDimension(d, c, px, c.at || !rec.size ? undefined : labelReach(rec.size));
        if (!lay) continue;
        if (!c.at && !c.preview && rec.size) {
          for (let i = 0; i < 6; i++) {
            const s = screenOf(lay.text);
            const hit = s ? overlapPx(s, rec.size) : null;
            if (!hit) break;
            const from = angleVertex(d, c) ?? hit.other.at;
            let dir: Vec2 = [lay.text[0] - from[0], lay.text[1] - from[1]];
            const len = Math.hypot(dir[0], dir[1]);
            dir = len > 1e-12 ? [dir[0] / len, dir[1] / len] : [0, 1];
            const at: Vec2 = [lay.text[0] + dir[0] * (hit.by + 2) * px, lay.text[1] + dir[1] * (hit.by + 2) * px];
            const moved = layoutDimension(d, { ...c, at }, px);
            if (!moved) break;
            lay = moved;
          }
        }
        {
          const s = screenOf(lay.text);
          if (s && rec.size) placed.push({ at: lay.text, s, size: rec.size });
        }
        const color = c.preview ? pal.preview : sel.has(c.id) ? pal.pick : conflict.has(c.id) ? pal.over : c.driving ? pal.dim : pal.driven;
        for (const [a, b] of lay.lines) segs.push({ a, b, color });
        if (!c.preview) for (const [a, b] of lay.lines) shown.push(a, b);
        if (!c.preview) shown.push(lay.text);
        for (const ar of lay.arrows) {
          const L = 8 * px;
          const back: Vec2 = [-ar.dir[0] * L, -ar.dir[1] * L];
          const side: Vec2 = [-ar.dir[1] * L * 0.35, ar.dir[0] * L * 0.35];
          segs.push({ a: ar.at, b: [ar.at[0] + back[0] + side[0], ar.at[1] + back[1] + side[1]], color });
          segs.push({ a: ar.at, b: [ar.at[0] + back[0] - side[0], ar.at[1] + back[1] - side[1]], color });
        }
        keep.add(c.id);
        rec.at = lay.text;
        if (!c.preview) rec.el.setAttribute('aria-label', `${c.driving ? 'Dimension' : 'Driven dimension'} ${text}`);
        if (!c.preview) rec.el.setAttribute('aria-pressed', sel.has(c.id) ? 'true' : 'false');
        rec.el.setAttribute('data-driving', c.driving ? '1' : '0');
        rec.el.setAttribute('data-kind', c.kind);
        rec.el.classList.toggle('is-driven', !c.driving);
        rec.el.classList.toggle('is-selected', sel.has(c.id));
        rec.el.classList.toggle('is-over', conflict.has(c.id));
        rec.el.style.visibility = v.editing === c.id ? 'hidden' : '';
      }
    }
    for (const [k, rec] of dimEls) if (!keep.has(k)) {
      rec.el.remove();
      dimEls.delete(k);
    }
    dimLines.set(segs);
    dimsUv = uvBoxOf(shown);
  }

  function wireDimension(el: HTMLElement, id: string) {
    let down: { x: number; y: number; moved: boolean; pointer: number } | null = null;
    // Keyboard: Tab reaches it, Space selects it, Enter edits its value (as a double-click does).
    el.setAttribute('role', 'button');
    el.tabIndex = 0;
    el.addEventListener('keydown', (e) => {
      if (e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        pickConstraint(id, e.ctrlKey || e.metaKey);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      }
    });
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      down = { x: e.clientX, y: e.clientY, moved: false, pointer: e.pointerId };
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* synthetic */
      }
    });
    el.addEventListener('pointermove', (e) => {
      if (!down || !plane) return;
      if (!down.moved && Math.hypot(e.clientX - down.x, e.clientY - down.y) <= 4) return;
      down.moved = true;
      const hit = handle.toPlane(e.clientX, e.clientY, plane);
      if (!hit) return;
      labelDrag = { id, at: hit.uv };
      drawDimensions(mode.view.get());
      place();
    });
    el.addEventListener('pointerup', (e) => {
      if (!down) return;
      const d = down;
      down = null;
      if (d.moved && labelDrag) {
        const at = labelDrag.at;
        void mode.moveLabel(id, at).finally(() => {
          labelDrag = null;
        });
      } else pickConstraint(id, e.ctrlKey || e.metaKey, true);
    });
    el.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      cancelRefusalNote();
      const c = mode.stored()?.constraints.find((x) => x.id === id);
      if (c && isDimension(c) && !c.driving) {
        mode.note('A driven dimension only shows a value: right-click it and Make it driving to set it');
        return;
      }
      mode.view.set({ editing: id });
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      glyphMenu(id, e.clientX, e.clientY);
    });
  }

  function syncEditor(v: SketchView) {
    const id = v.editing;
    if (!id) {
      if (editor) {
        // Closed from outside (a press in the sketch, another tool): a changed value still applies.
        const e = editor;
        editor = null;
        e.close(true);
        e.input.parentElement?.remove();
      }
      return;
    }
    const d = v.draft;
    const c = d?.constraints.find((x) => x.id === id);
    if (!d || !c || !isDimension(c)) {
      mode.view.set({ editing: null });
      return;
    }
    if (editor?.id === id) {
      editor.at = dimEls.get(id)?.at ?? editor.at;
      return;
    }
    if (editor) {
      const e = editor;
      editor = null;
      e.close(true);
      e.input.parentElement?.remove();
    }
    const wrap = document.createElement('div');
    wrap.className = 'cad-sk-box is-editor';
    const input = document.createElement('input');
    input.className = 'mgk-input';
    input.setAttribute('data-sketch-dim-edit', id);
    input.setAttribute('aria-label', 'Dimension value');
    input.spellcheck = false;
    const literal = /^\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?\s*(mm|cm|m|in|ft|deg|rad)?\s*$/.test(c.expr);
    const value = dimValue(d, c);
    input.value = literal && value != null ? dimensionLabel({ ...c, expr: '1' }, value, services.doc.units).replace(/^[R⌀]/, '').replace(/°$/, '') : c.expr;
    let closed = false;
    const close = (commit: boolean) => {
      if (closed) return;
      closed = true;
      const text = input.value;
      if (mode.view.get().editing === id) mode.view.set({ editing: null });
      if (commit && text.trim() && text !== input.defaultValue) void mode.setDimension(id, text);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        close(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close(false);
      }
    });
    input.addEventListener('blur', () => close(true));
    input.defaultValue = input.value;
    wrap.append(input);
    html.append(wrap);
    editor = { id, input, at: dimEls.get(id)?.at ?? c.at ?? [0, 0], close };
    place();
    queueMicrotask(() => {
      input.focus();
      input.select();
    });
  }

  function syncBoxes(v: SketchView) {
    const boxes = v.preview?.boxes ?? [];
    const keep = new Set(boxes.map((b) => b.id));
    for (const [id, rec] of boxEls) if (!keep.has(id)) {
      rec.wrap.remove();
      boxEls.delete(id);
    }
    for (const b of boxes) {
      let rec = boxEls.get(b.id);
      if (!rec) {
        const wrap = document.createElement('label');
        wrap.className = 'cad-sk-box';
        const k = document.createElement('span');
        k.className = 'cad-sk-box-k';
        k.textContent = b.label;
        const input = document.createElement('input');
        input.className = 'mgk-input';
        input.setAttribute('data-sketch-box', b.id);
        input.setAttribute('aria-label', b.label);
        input.spellcheck = false;
        input.addEventListener('input', () => mode.tool?.box?.(b.id, 'input', input.value));
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            // Placed: let go of the box. A line chain keeps its boxes for the next segment, and
            // the focused one kept its old text, so the next digits went into the wrong box and
            // A typed 'a' instead of switching to a tangent arc (review P2/P3 round 1).
            if (mode.tool?.box?.(b.id, 'enter', input.value) === true && document.activeElement === input) input.blur();
          } else if (e.key === 'Tab') {
            e.preventDefault();
            e.stopPropagation();
            mode.tool?.box?.(b.id, 'tab', input.value);
            const ids = [...boxEls.keys()];
            const next = boxEls.get(ids[(ids.indexOf(b.id) + (e.shiftKey ? ids.length - 1 : 1)) % ids.length]);
            next?.input.focus();
            next?.input.select();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            input.blur();
            mode.escape();
          }
        });
        // Why the typed value cannot be used, in words under the box ("Radius must be at least 20 mm").
        const err = document.createElement('span');
        err.className = 'cad-sk-box-err';
        err.setAttribute('data-sketch-box-error', b.id);
        err.setAttribute('role', 'alert');
        err.hidden = true;
        wrap.append(k, input, err);
        // A pointer moving onto a box still moves what is being drawn (and the box then moves
        // out from under it). Review P2/P3 round 2: the first move after a typed segment landed
        // on the next segment's Angle box, so the preview and the boxes stayed at the old pointer.
        wrap.addEventListener('pointermove', (e) => {
          if (!canvas || e.buttons || typeof PointerEvent !== 'function') return;
          canvas.dispatchEvent(new PointerEvent('pointermove', e));
        });
        forwardWheel(wrap);
        html.append(wrap);
        rec = { wrap, input, err, at: b.at, along: b.along ?? null };
        boxEls.set(b.id, rec);
      }
      rec.at = b.at;
      rec.along = b.along ?? null;
      // Typed text is the user's; a box with nothing typed follows the pointer, also while it has the
      // keyboard (after Tab), its text all selected so the next key replaces it.
      const focused = document.activeElement === rec.input;
      const typed = b.locked || !!b.error;
      if (rec.input.value !== b.text && (!focused || !typed)) {
        const all = focused && rec.input.selectionStart === 0 && rec.input.selectionEnd === rec.input.value.length;
        rec.input.value = b.text;
        if (all) rec.input.select();
      }
      rec.wrap.classList.toggle('is-locked', b.locked);
      rec.wrap.classList.toggle('is-error', !!b.error);
      rec.input.setAttribute('aria-invalid', b.error ? 'true' : 'false');
      rec.wrap.title = b.error ?? '';
      if (rec.err.textContent !== (b.error ?? '')) rec.err.textContent = b.error ?? '';
      rec.err.hidden = !b.error;
    }
  }

  function syncInference(v: SketchView) {
    for (const r of inferEls.splice(0)) r.el.remove();
    for (const g of v.preview?.glyphs ?? []) {
      g.kinds.forEach((k, i) => {
        const el = document.createElement('div');
        el.className = 'cad-sk-glyph is-inference';
        el.setAttribute('data-sketch-infer', k);
        el.append(svgIcon(GLYPH_ICON[k] ?? GLYPH_ICON.coincident));
        html.append(el);
        inferEls.push({ el, at: g.at, slot: i });
      });
    }
  }

  // ------------------------------------------------------------ placing html each frame
  function put(el: HTMLElement, uv: Vec2, dx = 0, dy = 0) {
    const s = screenOf(uv);
    if (!s) {
      el.style.display = 'none';
      return;
    }
    el.style.display = '';
    el.style.transform = `translate(${Math.round(s[0] + dx)}px, ${Math.round(s[1] + dy)}px)`;
  }

  /**
   * A box that measures a segment, beside it: across from its middle, its near edge 14 px from
   * the line on the side below it (right of a line that runs nearly up and down), as Fusion puts
   * a line's length beside the line. A horizontal line's box stays where it was (14 px below).
   */
  function besideSegment(el: HTMLElement, [a, b]: [Vec2, Vec2]) {
    const sa = screenOf(a);
    const sb = screenOf(b);
    if (!sa || !sb) return;
    const len = Math.hypot(sb[0] - sa[0], sb[1] - sa[1]);
    if (len < 2) return;
    let n: Vec2 = [-(sb[1] - sa[1]) / len, (sb[0] - sa[0]) / len];
    if (Math.abs(n[1]) >= 0.35 ? n[1] < 0 : n[0] < 0) n = [-n[0], -n[1]];
    const r = el.getBoundingClientRect();
    const reach = 14 + (Math.abs(n[0]) * r.width) / 2 + (Math.abs(n[1]) * r.height) / 2;
    const cx = (sa[0] + sb[0]) / 2 + n[0] * reach;
    const cy = (sa[1] + sb[1]) / 2 + n[1] * reach;
    // The box is drawn centred on its x (translate -50% 0), its top at y.
    el.style.transform = `translate(${Math.round(cx)}px, ${Math.round(cy - r.height / 2)}px)`;
  }

  /** Move a placed element by (dx, dy) client px. */
  function shiftBy(el: HTMLElement, dx: number, dy: number) {
    const m = /translate\((-?\d+)px, (-?\d+)px\)/.exec(el.style.transform);
    if (!m) return;
    el.style.transform = `translate(${Number(m[1]) + Math.round(dx)}px, ${Number(m[2]) + Math.round(dy)}px)`;
  }

  /**
   * The value boxes: each below what it measures where it can, else at the nearest spot
   * inside the viewport that is free: never under the pointer (the next click there places
   * the shape), never over another box, and never under what floats over the view (the
   * tree, the open panel, the dock's chips, the view buttons; src/lib/chrome.ts). Review
   * P2/P3 round 1: a small circle's Diameter box sat on its rim and took the rim click;
   * round 2: the Angle box covered the focused Length box; round 3: boxes sat under the
   * Sketch panel and the dock, and at the bottom edge (or for a zero-length line) the
   * Angle box was pushed back under the Length box, so the typed value could not be seen.
   * A box that measures a segment (a line's Length, a rectangle's Width and Height) sits beside
   * it, across from its middle, as Fusion places it, and no box covers what is being drawn
   * (round 4: on a vertical line both boxes sat on the line).
   */
  function placeBoxes() {
    const shown: HTMLElement[] = [];
    for (const rec of boxEls.values()) {
      put(rec.wrap, rec.at, 0, 14);
      if (rec.wrap.style.display === 'none') continue;
      if (rec.along) besideSegment(rec.wrap, rec.along);
      shown.push(rec.wrap);
    }
    if (!shown.length) return;
    const host = hostRect();
    const pad = 6;
    const zone = 12;
    const area: ScreenRect = { left: host.left + pad, top: host.top + pad, right: host.right - pad, bottom: host.bottom - pad };
    const taken: ScreenRect[] = floatingRects(document);
    if (pointerAt) taken.push({ left: pointerAt[0] - zone, right: pointerAt[0] + zone, top: pointerAt[1] - zone, bottom: pointerAt[1] + zone });
    const pv = mode.view.get().preview;
    // The points of what is being drawn (a line's start, a circle's centre) stay in sight too.
    for (const p of pv?.points ?? []) {
      const s = screenOf(p);
      if (s) taken.push({ left: host.left + s[0] - 8, right: host.left + s[0] + 8, top: host.top + s[1] - 8, bottom: host.top + s[1] + 8 });
    }
    // And so do its lines and arcs, in short pieces (a slanted line's own box would cover the view).
    const piece = (a: Vec2, b: Vec2) => {
      const sa = screenOf(a);
      const sb = screenOf(b);
      if (!sa || !sb) return;
      const n = Math.min(16, Math.max(1, Math.ceil(Math.hypot(sb[0] - sa[0], sb[1] - sa[1]) / 16)));
      for (let i = 0; i < n; i++) {
        const x0 = sa[0] + ((sb[0] - sa[0]) * i) / n;
        const y0 = sa[1] + ((sb[1] - sa[1]) * i) / n;
        const x1 = sa[0] + ((sb[0] - sa[0]) * (i + 1)) / n;
        const y1 = sa[1] + ((sb[1] - sa[1]) * (i + 1)) / n;
        taken.push({ left: host.left + Math.min(x0, x1) - 2, right: host.left + Math.max(x0, x1) + 2, top: host.top + Math.min(y0, y1) - 2, bottom: host.top + Math.max(y0, y1) + 2 });
      }
    };
    for (const [a, b] of pv?.lines ?? []) piece(a, b);
    for (const arc of pv?.arcs ?? []) {
      const n = Math.max(4, Math.ceil(Math.abs(arc.sweep) / (Math.PI / 8)));
      for (let i = 0; i < n; i++) piece(polar(arc.c, arc.r, arc.a0 + (arc.sweep * i) / n), polar(arc.c, arc.r, arc.a0 + (arc.sweep * (i + 1)) / n));
    }
    for (const el of shown) {
      const r = el.getBoundingClientRect();
      // Nowhere free (a tiny view): kept inside the view at least.
      const spot = freeSpot({ left: r.left, top: r.top }, r.width, r.height, taken, area) ?? {
        left: Math.max(area.left, Math.min(r.left, area.right - r.width)),
        top: Math.max(area.top, Math.min(r.top, area.bottom - r.height)),
      };
      const dx = Math.round(spot.left - r.left);
      const dy = Math.round(spot.top - r.top);
      if (dx || dy) shiftBy(el, dx, dy);
      taken.push({ left: r.left + dx, top: r.top + dy, right: r.right + dx, bottom: r.bottom + dy });
    }
  }

  /** Laid out at another scale than the view's now (see dimPx). */
  function dimensionsStale(): boolean {
    for (const d of dimPx.values()) if (Math.abs(pxAt(d.at) - d.px) > d.px * 1e-3) return true;
    return false;
  }

  function place() {
    if (dimPx.size && dimensionsStale()) {
      drawDimensions(mode.view.get());
      if (editor) editor.at = dimEls.get(editor.id)?.at ?? editor.at;
      ann.changed();
    }
    for (const rec of glyphEls.values()) put(rec.el, rec.at, 10 + rec.slot * 18, 6);
    for (const rec of dimEls.values()) put(rec.el, rec.at);
    for (const rec of inferEls) put(rec.el, rec.at, 12 + rec.slot * 18, -24);
    placeBoxes();
    if (editor) put(editor.input.parentElement!, editor.at);
    drawGrid();
  }

  // ------------------------------------------------------------ the pointer
  const drawing = () => (mode.tool?.id ?? 'select') !== 'select';
  function applyCursor() {
    if (!canvas) return;
    const v = mode.view.get();
    canvas.style.cursor = v.dragging ? 'grabbing' : v.cursor || (drawing() ? 'crosshair' : 'default');
  }

  let pressed = false;
  function toSketch(type: SketchPointer['type'], e: ViewportPointer): SketchPointer | null {
    if (!plane) return null;
    const hit = handle.toPlane(e.clientX, e.clientY, plane);
    if (!hit) return null;
    return { type, uv: hit.uv, px: handle.pixelSize(hit.p as Vec3), ctrl: e.ctrl, shift: e.shift, pressed, clientX: e.clientX, clientY: e.clientY };
  }

  function contextMenu(e: ViewportPointer) {
    const d = mode.draft();
    if (!d) return;
    const sp = toSketch('move', e);
    const hit: SketchHit | null = sp ? hitTest(d, sp.uv, sp.px) : null;
    if (hit && !mode.selected().some((h) => h.id === hit.id)) mode.select([hit], false);
    const picked = mode.selected();
    const items: MenuEntry[] = [];
    if (drawing()) items.push({ id: 'cancel-tool', label: 'Stop drawing', run: () => mode.setTool('select') });
    if (picked.length) {
      // P4b SELECT: Construction as a state item (Make construction / Make normal on a mixed selection), and linked geometry's items.
      items.push(...constructionItems(mode, d, picked), ...linkMenuItems(mode, d, picked));
      items.push({ id: 'delete', label: 'Delete', danger: true, disabled: picked.every((h) => h.id === ORIGIN) ? 'The origin cannot be deleted' : null, run: () => void mode.deleteSelected() });
    }
    if (items.length) items.push({ sep: true, id: 'sep-sketch' });
    items.push({ id: 'look', label: 'Normal to', run: () => void services.commands.run('view.sketch-look') }, { id: 'finish', label: 'Finish sketch', run: () => mode.finish() });
    uiFor(services).showMenu(e.clientX, e.clientY, items, 'Sketch');
  }

  // P4b (SELECT): the last move, sent again when a snap on the model is ready (read from the kernel meanwhile).
  let lastMove: ViewportPointer | null = null;
  mode.repeatPointer = () => {
    const sp = lastMove && !pressed ? toSketch('move', lastMove) : null;
    if (sp && mode.tool) mode.tool.pointer(sp);
  };
  const popTool = handle.pushTool({
    id: 'sketch',
    cursor: 'crosshair',
    onPointer(e) {
      if (!mode.tool) return false;
      pointerAt = e.type === 'leave' ? null : [e.clientX, e.clientY];
      if (e.type === 'contextmenu') {
        contextMenu(e);
        return true;
      }
      if (e.type === 'down') {
        if (e.button !== 0 || e.alt) return false;
        const sp = toSketch('down', e);
        // P4b (INTEGRATE, mouse binding): a press the tool leaves (the Select tool off sketch
        // geometry, no Ctrl) orbits or pans; its click still comes to the tool.
        if (sp && mode.tool.takesPress && !mode.tool.takesPress(sp)) return false;
        if (mode.view.get().editing) mode.view.set({ editing: null });
        pressed = true;
        if (sp) mode.tool.pointer(sp);
        return true;
      }
      if (e.type === 'up') {
        const sp = toSketch('up', e);
        pressed = false;
        if (sp) mode.tool.pointer(sp);
        return true;
      }
      if (e.type === 'leave') {
        mode.setHover(null);
        const sp = toSketch('leave', e);
        if (sp) mode.tool.pointer(sp);
        return false;
      }
      const sp = toSketch(e.type, e);
      if (sp) mode.tool.pointer(sp);
      if (e.type === 'move') lastMove = e;
      // The boxes move out from under the pointer now, before the press that may follow.
      if (e.type === 'move' && boxEls.size) place();
      applyCursor();
      if (e.type === 'click' && mode.view.get().preview?.boxes.length) mode.state.set({ typing: true });
      return true;
    },
  });

  // Digits typed while a tool shows value boxes go into the first one: it is the active box
  // (Fusion), so Tab moves on to the next one (review P2/P3 round 2: the first Tab went into
  // Length, and "Tab 180 Enter" stored a 180 mm line instead of a 180 degree one).
  const onKey = (e: KeyboardEvent) => {
    const boxes = [...boxEls.entries()];
    if (!boxes.length || e.ctrlKey || e.metaKey || e.altKey) return;
    if (openModal(document)) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
    if (/^[0-9.\-+(]$/.test(e.key) || e.key === 'Tab') {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Tab') {
        const next = boxes[e.shiftKey ? boxes.length - 1 : 1 % boxes.length][1].input;
        next.focus();
        next.select();
        return;
      }
      const [id, rec] = boxes[0];
      const first = rec.input;
      first.focus();
      // The key that moved the keyboard into the box is its first character.
      first.value = e.key;
      first.setSelectionRange(first.value.length, first.value.length);
      mode.tool?.box?.(id, 'input', first.value);
    }
  };
  document.addEventListener('keydown', onKey, true);

  // ------------------------------------------------------------ wiring
  const render = () => {
    const v = mode.view.get();
    if (v.plane !== plane) applyPlane(v.plane ?? mode.plane());
    drawGeometry(v);
    syncGlyphs(v);
    syncBoxes(v);
    syncInference(v);
    syncEditor(v);
    place();
    applyCursor();
    geo.changed();
    ann.changed();
  };
  const offView = mode.view.subscribe(render);
  const offSel = services.selection.subscribe(render);
  // P4b (SELECT): a rebuild's link states (Lost reference: amber) arrive after the edit that started it.
  const offLinks = services.doc.state.subscribe((st, prev) => {
    const f = mode.feature;
    if (f && st.rebuild.outputs[f] !== prev.rebuild.outputs[f] && mode.draft()?.links?.length) render();
  });
  const offFrame = handle.onFrame(place);
  render();

  return () => {
    offView();
    offSel();
    offLinks();
    offFrame();
    popTool();
    mode.repeatPointer = null;
    document.removeEventListener('keydown', onKey, true);
    for (const l of [grid, halo, solid, dashed, preview, guides, dimLines]) l.dispose();
    dots.dispose();
    for (const o of [...frame.children, ...dimFrame.children] as Object3D[]) o.removeFromParent();
    geo.dispose();
    ann.dispose();
    if (canvas) canvas.style.cursor = '';
  };
}
