// The profile overlay in the viewport (docs/p2p3-plan.md §3.3 layer orders):
//   profiles.regions  (20) closed regions shaded (proposal §3.3: --mg-primary at
//                          12%), picked ones in the pick green, the one under
//                          the pointer in the hover blue; in both modes
//   profiles.sketches (30) a finished sketch's lines in model mode, coloured by
//                          how defined it is (sketch mode draws its own)
//   profiles.markers  (40) open-profile markers: a small white ring at every
//                          open end of a chain (Fusion's hint), html
// Reads rebuild.outputs (the sketch's SketchOutput), the view's sketch
// visibility, the selection (region items) and profilesView (hover, the open
// Extrude panel's profiles). Owner: P3-PROFILES (src/features/sketch/).
// SPDX-License-Identifier: GPL-3.0-or-later
import { BufferAttribute, BufferGeometry, DoubleSide, Mesh, MeshBasicMaterial } from 'three';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import type { AppServices } from '../../types/app';
import type { FeatureId, SketchFeature, Vec3 } from '../../types/doc';
import type { SketchOutput } from '../../types/sketch';
import type { OverlayLayer, ViewportHandle } from '../../types/viewport';
import { overlayColors } from './colors';
import { entityGeometry, type EntityGeom } from './geometry';
import { toModel } from './plane';
import { drawnSketches, editedSketch, profilesView } from './view';

export const LAYER_REGIONS = 'profiles.regions';
export const LAYER_SKETCHES = 'profiles.sketches';
export const LAYER_MARKERS = 'profiles.markers';

/** Line widths (CSS px): sketch lines, construction lines. */
const LINE_PX = 1.6;
const CONSTRUCTION_PX = 1;

interface DrawnSketch {
  output: SketchOutput;
  feature: SketchFeature;
  lines: boolean;
  positions: BufferAttribute;
  meshes: Map<string, Mesh<BufferGeometry, MeshBasicMaterial>>;
  segs: LineSegments2[];
  markers: { el: HTMLElement; at: Vec3 }[];
}

/** Line segments (pairs of model points) approximating one entity. */
export function entitySegments(g: EntityGeom, plane: SketchOutput['plane']): number[] {
  const out: number[] = [];
  const push = (u0: number, v0: number, u1: number, v1: number) => {
    out.push(...toModel(plane, [u0, v0]), ...toModel(plane, [u1, v1]));
  };
  if (g.kind === 'line') push(g.a[0], g.a[1], g.b[0], g.b[1]);
  // P4b (SKETCH): a spline's polyline.
  else if (g.kind === 'spline') for (let i = 1; i < g.poly.length; i++) push(g.poly[i - 1][0], g.poly[i - 1][1], g.poly[i][0], g.poly[i][1]);
  else if (g.kind === 'circle' || g.kind === 'arc') {
    let a0 = 0;
    let sweep = 360;
    if (g.kind === 'arc') {
      a0 = g.a0;
      const d = (((g.a1 - g.a0) % 360) + 360) % 360;
      sweep = g.ccw ? d || 360 : -((360 - d) % 360 || 360);
    }
    const n = Math.max(8, Math.ceil(Math.abs(sweep) / 5));
    let pu = g.c[0] + g.r * Math.cos((a0 * Math.PI) / 180);
    let pv = g.c[1] + g.r * Math.sin((a0 * Math.PI) / 180);
    for (let i = 1; i <= n; i++) {
      const a = ((a0 + (sweep * i) / n) * Math.PI) / 180;
      const u = g.c[0] + g.r * Math.cos(a);
      const v = g.c[1] + g.r * Math.sin(a);
      push(pu, pv, u, v);
      pu = u;
      pv = v;
    }
  }
  return out;
}

export class ProfileOverlay {
  private readonly regions: OverlayLayer;
  private readonly sketches: OverlayLayer;
  private readonly marks: OverlayLayer;
  private readonly drawn = new Map<FeatureId, DrawnSketch>();
  private readonly colors = overlayColors();
  private readonly mats;
  private readonly lineMats;
  private readonly offs: (() => void)[] = [];
  private queued = false;

  constructor(
    private readonly services: AppServices,
    private readonly handle: ViewportHandle,
  ) {
    // The finished sketches shown in model mode count when the view frames the part (their lines;
    // regions alone are the sketch being edited, which sketch mode frames itself).
    this.regions = handle.addLayer(LAYER_REGIONS, { order: 20 });
    this.sketches = handle.addLayer(LAYER_SKETCHES, { order: 30, frame: true });
    this.marks = handle.addLayer(LAYER_MARKERS, { order: 40 });
    const c = this.colors;
    // Seen from either side; pulled towards the camera so a region on a face (a sketch on it) shows over it.
    const fill = (k: { color: number; opacity: number }) =>
      new MeshBasicMaterial({ color: k.color, transparent: true, opacity: k.opacity, side: DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4 });
    this.mats = { region: fill(c.region), hover: fill(c.hover), picked: fill(c.picked) };
    const line = (color: number, width: number) => {
      const m = new LineMaterial({ color, linewidth: width, worldUnits: false });
      m.polygonOffset = true;
      m.polygonOffsetFactor = -2;
      m.polygonOffsetUnits = -8;
      return m;
    };
    // P4b (SELECT): linked geometry in purple, a lost reference in amber (projected, intersection).
    this.lineMats = {
      under: line(c.under, LINE_PX),
      full: line(c.full, LINE_PX),
      over: line(c.over, LINE_PX),
      construction: line(c.construction, CONSTRUCTION_PX),
      linked: line(c.linked, LINE_PX),
      lost: line(c.lost, LINE_PX),
      // P4b (SELECT, fix round 1, polish 4): a linked curve made construction (or an auto-made reference)
      // stays purple, dashed as construction is, as sketch mode draws it.
      linkedConstruction: line(c.linked, CONSTRUCTION_PX),
    };
    // Construction lines and centerlines are dashed in model mode too, as in sketch mode (review P2/P3
    // round 1: a centerline looked solid). The dash follows the zoom (place(), every frame).
    this.lineMats.construction.dashed = true;
    this.lineMats.linkedConstruction.dashed = true;
    const later = () => this.later();
    this.offs.push(
      services.doc.state.subscribe(later),
      services.selection.subscribe(later),
      services.mode.subscribe(later),
      profilesView(services).subscribe(later),
      handle.onFrame(() => this.place()),
    );
    this.sync();
  }

  /** Sync on the next microtask (several stores change together). */
  private later() {
    if (this.queued) return;
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false;
      this.sync();
    });
  }

  /** The sketches drawn now, by id (for tests). */
  shown(): FeatureId[] {
    return [...this.drawn.keys()];
  }

  sync(): void {
    const s = this.services.doc.state.get();
    const mode = this.services.mode.get().mode;
    const view = profilesView(this.services).get();
    const list = drawnSketches(s, mode, view, this.services.doc.features);
    const keep = new Set(list.map((d) => d.feature.id));
    for (const [id, d] of this.drawn) {
      if (!keep.has(id)) {
        this.drop(d);
        this.drawn.delete(id);
      }
    }
    // Sketch mode draws the edited sketch's own lines; model mode shows a finished sketch's.
    const lines = mode !== 'sketch' && !editedSketch(s);
    for (const { feature, output } of list) {
      const was = this.drawn.get(feature.id);
      if (was && was.output === output && was.feature === feature && was.lines === lines) continue;
      if (was) this.drop(was);
      this.drawn.set(feature.id, this.make(feature, output, lines));
    }
    // States: picked (selection, or the open Extrude's profiles), hover.
    const picked = new Set<string>();
    for (const it of this.services.selection.get().items) if (it.kind === 'region') picked.add(`${it.feature}\n${it.key}`);
    for (const u of view.used) picked.add(`${u.feature}\n${u.key}`);
    const hover = view.hover ? `${view.hover.feature}\n${view.hover.key}` : null;
    for (const [id, d] of this.drawn) {
      for (const [key, mesh] of d.meshes) {
        const k = `${id}\n${key}`;
        const m = picked.has(k) ? this.mats.picked : k === hover ? this.mats.hover : this.mats.region;
        if (mesh.material !== m) mesh.material = m;
        mesh.userData.state = picked.has(k) ? 'picked' : k === hover ? 'hover' : 'normal';
      }
    }
    // Sketches are not bodies: while one is shown (or sketch mode is on), Auto hides the origin planes.
    this.handle.setPlanesBusy(LAYER_SKETCHES, mode === 'sketch' || this.drawn.size > 0);
    this.place();
    this.regions.changed();
    this.sketches.changed();
  }

  private make(feature: SketchFeature, output: SketchOutput, lines: boolean): DrawnSketch {
    const meshes = new Map<string, Mesh<BufferGeometry, MeshBasicMaterial>>();
    // All regions of a sketch share one position buffer (the kernel's u/v nodes on the plane).
    const uv = output.regions[0]?.tri.uv ?? new Float32Array(0);
    const pos = new Float32Array((uv.length / 2) * 3);
    for (let i = 0; i < uv.length / 2; i++) pos.set(toModel(output.plane, [uv[2 * i], uv[2 * i + 1]]), 3 * i);
    const positions = new BufferAttribute(pos, 3);
    for (const r of output.regions) {
      if (!r.tri.idx.length) continue;
      const g = new BufferGeometry();
      g.setAttribute('position', r.tri.uv === uv ? positions : new BufferAttribute(this.positionsOf(output, r.tri.uv), 3));
      g.setIndex(new BufferAttribute(r.tri.idx, 1));
      const mesh = new Mesh(g, this.mats.region);
      mesh.name = `region:${feature.id}:${r.key}`;
      mesh.userData = { feature: feature.id, key: r.key, state: 'normal' };
      mesh.renderOrder = 1;
      mesh.frustumCulled = false;
      meshes.set(r.key, mesh);
      this.regions.group.add(mesh);
    }
    const segs: LineSegments2[] = [];
    if (lines) {
      let geom: EntityGeom[] = [];
      try {
        // P4b (SELECT): the entities as the build re-projected them, when it did.
        geom = entityGeometry(output.entities ? { entities: output.entities } : feature, output.points, output.radii);
      } catch {
        geom = [];
      }
      // Each entity in its own definition colour, as sketch mode draws it: an under-defined sketch's
      // fully defined entities (solved.fully, kept by the last analysis) in the fully defined colour
      // (review P2/P3 round 1: a dimensioned rectangle was blue in model mode beside a free circle).
      const state = feature.solved?.state;
      const fully = new Set(feature.solved?.fully ?? []);
      const under: number[] = [];
      const full: number[] = [];
      const construction: number[] = [];
      // P4b (SELECT): linked entities (purple) and those whose source is lost (amber).
      const linked: number[] = [];
      const linkedConstruction: number[] = [];
      const lostLines: number[] = [];
      const linkedIds = new Set((output.entities ?? feature.entities).filter((e) => e.link).map((e) => e.id));
      const lostIds = new Set(Object.values(output.links ?? {}).flatMap((s) => s.lost ?? []));
      for (const g of geom) {
        const arr = lostIds.has(g.id) ? lostLines : linkedIds.has(g.id) ? (g.construction ? linkedConstruction : linked) : g.construction ? construction : state === 'fully' || (state === 'under' && fully.has(g.id)) ? full : under;
        arr.push(...entitySegments(g, output.plane));
      }
      const over = state === 'over';
      for (const [arr, m] of [
        [under, over ? this.lineMats.over : this.lineMats.under],
        [full, over ? this.lineMats.over : this.lineMats.full],
        [construction, this.lineMats.construction],
        [linked, this.lineMats.linked],
        [linkedConstruction, this.lineMats.linkedConstruction],
        [lostLines, this.lineMats.lost],
      ] as const) {
        if (!arr.length) continue;
        const lg = new LineSegmentsGeometry();
        lg.setPositions(arr);
        const seg = new LineSegments2(lg, m);
        if (m.dashed) seg.computeLineDistances();
        seg.name = `sketch:${feature.id}`;
        seg.renderOrder = 2;
        seg.frustumCulled = false;
        segs.push(seg);
        this.sketches.group.add(seg);
      }
    }
    const markers = output.open.map((o) => {
      const el = document.createElement('span');
      el.className = 'cad-open-end';
      el.dataset.openEnd = feature.id;
      el.dataset.entity = o.entity;
      this.marks.html.appendChild(el);
      return { el, at: toModel(output.plane, o.at) };
    });
    return { output, feature, lines, positions, meshes, segs, markers };
  }

  private positionsOf(output: SketchOutput, uv: Float32Array): Float32Array {
    const pos = new Float32Array((uv.length / 2) * 3);
    for (let i = 0; i < uv.length / 2; i++) pos.set(toModel(output.plane, [uv[2 * i], uv[2 * i + 1]]), 3 * i);
    return pos;
  }

  private drop(d: DrawnSketch) {
    for (const m of d.meshes.values()) {
      this.regions.group.remove(m);
      m.geometry.dispose();
    }
    for (const s of d.segs) {
      this.sketches.group.remove(s);
      s.geometry.dispose();
    }
    for (const m of d.markers) m.el.remove();
  }

  /** Put the open-end markers where their points are now (the camera may have moved). */
  private place() {
    const box = this.marks.html.getBoundingClientRect();
    // 6 px dashes and 4 px gaps at the first drawn sketch's plane (mm per pixel there).
    const first = this.drawn.values().next().value as DrawnSketch | undefined;
    if (first) {
      const px = this.handle.pixelSize(first.output.plane.origin);
      const m = this.lineMats.construction;
      if (px > 0 && Math.abs(m.dashSize - 6 * px) > 1e-3 * px) {
        m.dashSize = 6 * px;
        m.gapSize = 4 * px;
        this.lineMats.linkedConstruction.dashSize = 6 * px;
        this.lineMats.linkedConstruction.gapSize = 4 * px;
        this.sketches.changed();
      }
    }
    for (const d of this.drawn.values()) {
      for (const m of d.markers) {
        const p = this.handle.project(m.at);
        if (!p) {
          m.el.style.display = 'none';
          continue;
        }
        m.el.style.display = '';
        m.el.style.transform = `translate(${(p[0] - box.left).toFixed(1)}px, ${(p[1] - box.top).toFixed(1)}px)`;
      }
    }
  }

  dispose(): void {
    for (const off of this.offs.splice(0)) off();
    this.handle.setPlanesBusy(LAYER_SKETCHES, false);
    for (const d of this.drawn.values()) this.drop(d);
    this.drawn.clear();
    for (const m of Object.values(this.mats)) m.dispose();
    for (const m of Object.values(this.lineMats)) m.dispose();
    this.regions.dispose();
    this.sketches.dispose();
    this.marks.dispose();
  }
}
