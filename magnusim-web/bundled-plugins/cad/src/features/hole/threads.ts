// Cosmetic threads in the viewport (layer `hole.threads`, order 35): each tapped hole's thread
// (ExtrudeFeature.thread, set by Hole) drawn as a helix at the thread's major diameter, one turn
// per pitch (at most TURNS_MAX turns), faintly through the material, round each of the hole's
// circles (h1, h2...) from its sketch plane into the cut, as deep as the cut goes: a Blind cut's
// distance, or to the far side of the body for Through all (the body's box along the hole). The
// designation ("M6x1") is labelled beside the first hole. The solid is not changed. A thread that
// is also modelled (a thread feature cut it into the wall) keeps only its label: the real groove
// is there to see. It reads the document and redraws only when a thread, its cut, its sketch, its
// body or its modelled thread changed.
// Owner: ASSISTANT (the person's side of hole).
// SPDX-License-Identifier: GPL-3.0-or-later
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { toModel, ydirOf } from '../sketch/plane';
import type { AppServices } from '../../types/app';
import type { ExtrudeFeature, HoleThread, SketchFeature, Vec3 } from '../../types/doc';
import type { SketchOutput } from '../../types/sketch';
import type { OverlayLayer, ViewportHandle } from '../../types/viewport';
import { paletteOf } from '../../viewport/palette';

const THREADS_LAYER = 'hole.threads';
/** Segments per turn of the helix, and the most turns drawn per hole (a long fine thread is drawn coarser). */
const PER_TURN = 24;
const TURNS_MAX = 200;

/** One thread to draw: its cut's name, the thread, each hole's centre, the direction into the cut, the sketch's x, its length (mm, or null: to the far side of `body`), and whether it is modelled (label only). */
interface ThreadDraw {
  name: string;
  modelled: boolean;
  thread: HoleThread;
  centres: Vec3[];
  d: Vec3;
  x: Vec3;
  length: number | null;
  body: string | null;
}

/** Segment pairs of a helix about centre `c` along `d` (unit), starting along `x`: radius r, pitch p, length L. */
function helix(c: Vec3, d: Vec3, x: Vec3, r: number, p: number, L: number): number[] {
  const y: Vec3 = [d[1] * x[2] - d[2] * x[1], d[2] * x[0] - d[0] * x[2], d[0] * x[1] - d[1] * x[0]];
  const turns = Math.min(TURNS_MAX, L / p);
  const n = Math.max(2, Math.ceil(turns * PER_TURN));
  const out: number[] = [];
  let prev: number[] | null = null;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const a = 2 * Math.PI * turns * t;
    const q = [0, 1, 2].map((k) => c[k] + d[k] * L * t + r * (Math.cos(a) * x[k] + Math.sin(a) * y[k]));
    if (prev) out.push(...prev, ...q);
    prev = q;
  }
  return out;
}

/** The threads the document holds now, with what changes them (their key). */
function threadsOf(services: AppServices): { list: ThreadDraw[]; key: string } {
  const s = services.doc.state.get();
  const list: ThreadDraw[] = [];
  const parts: string[] = [];
  // The holes a built thread feature cut the thread into.
  const modelled = new Set(s.doc.features.flatMap((g) => (g.type === 'thread' && !g.suppressed && s.rebuild.features[g.id]?.state === 'ok' ? [g.hole] : [])));
  for (const g of s.doc.features) {
    if (g.type !== 'extrude' || !g.thread || g.suppressed) continue;
    const f = g as ExtrudeFeature;
    const st = s.rebuild.features[f.id]?.state;
    if (st !== 'ok' && st !== 'warning') continue;
    const sketchId = f.profiles[0]?.sketch;
    const sk = s.doc.features.find((x) => x.id === sketchId) as SketchFeature | undefined;
    const out = sketchId ? (s.rebuild.outputs[sketchId] as SketchOutput | undefined) : undefined;
    if (!sk || !out || out.type !== 'sketch') continue;
    const n = out.plane.normal;
    const d: Vec3 = f.flip ? [-n[0], -n[1], -n[2]] : [n[0], n[1], n[2]];
    const centres = sk.entities.flatMap((e) => (e.kind === 'circle' && /^h\d+$/.test(e.id) && out.points[e.c] ? [toModel(out.plane, out.points[e.c])] : []));
    if (!centres.length) continue;
    const blind = f.extent.kind === 'blind' ? services.doc.units.evaluate(f.extent.distance, 'length') : null;
    const length = blind ? (blind.ok ? Math.abs(blind.value) : null) : null;
    if (f.extent.kind === 'blind' && length == null) continue;
    const body = f.scope[0] ?? null;
    const shape = length == null ? (s.rebuild.bodies.find((b) => b.id === body)?.shape ?? null) : null;
    list.push({ name: f.name, modelled: modelled.has(f.id), thread: f.thread!, centres, d, x: out.plane.xdir as Vec3, length, body });
    parts.push(JSON.stringify([f.name, modelled.has(f.id), f.thread, centres, d, out.plane.xdir, length, shape]));
  }
  return { list, key: parts.join('|') };
}

class ThreadOverlay {
  private readonly layer: OverlayLayer;
  private readonly mat: LineMaterial;
  private lines: LineSegments2[] = [];
  private labels: { el: HTMLSpanElement; at: Vec3 }[] = [];
  private readonly offs: (() => void)[] = [];
  private queued = false;
  /** The newest sync (an older one that finishes late draws nothing). */
  private run = 0;
  /** What the drawn threads were built from: a document change that leaves it alone redraws nothing. */
  private key = '';

  constructor(
    private readonly services: AppServices,
    private readonly handle: ViewportHandle,
  ) {
    this.layer = handle.addLayer(THREADS_LAYER, {
      order: 35,
      palette: (p) => {
        this.mat.color.setHex(p.constructLine);
        this.layer.changed();
      },
    });
    this.layer.html.dataset.threadsLayer = '1';
    // Seen through the material (a thread is inside its hole), faint, in the construction colour.
    this.mat = new LineMaterial({ color: paletteOf(handle).constructLine, linewidth: 1.4, worldUnits: false, transparent: true, opacity: 0.7, depthTest: false, depthWrite: false });
    this.offs.push(
      services.doc.state.subscribe(() => this.later()),
      handle.onFrame(() => this.place()),
    );
    this.later();
  }

  private later(): void {
    if (this.queued) return;
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false;
      void this.sync();
    });
  }

  /** Each thread's length (a Through all one from its body's box), then the helices, if anything changed. */
  private async sync(): Promise<void> {
    const { list, key } = threadsOf(this.services);
    if (key === this.key) return;
    const run = ++this.run;
    const drawn: { t: ThreadDraw; length: number }[] = [];
    for (const t of list) {
      let L = t.length;
      if (L == null) {
        const b = this.services.doc.state.get().rebuild.bodies.find((x) => x.id === t.body);
        if (!b) continue;
        try {
          const bb = (await this.services.kernel.call('props', { id: b.shape, bbox: 'fast' })).result.bbox;
          if (!bb) continue;
          // The farthest corner of the body's box along the hole, from its first centre.
          const c = t.centres[0];
          L = 0;
          for (const cx of [bb[0], bb[3]]) for (const cy of [bb[1], bb[4]]) for (const cz of [bb[2], bb[5]]) L = Math.max(L, (cx - c[0]) * t.d[0] + (cy - c[1]) * t.d[1] + (cz - c[2]) * t.d[2]);
        } catch {
          continue;
        }
        if (run !== this.run) return;
      }
      if (L > 0) drawn.push({ t, length: L });
    }
    if (run !== this.run) return;
    this.key = key;
    this.draw(drawn);
  }

  private draw(list: { t: ThreadDraw; length: number }[]): void {
    this.clear();
    for (const { t, length } of list) {
      if (!t.modelled) {
        const pos: number[] = [];
        for (const c of t.centres) pos.push(...helix(c, t.d, t.x, t.thread.major / 2, t.thread.pitch, length));
        const geo = new LineSegmentsGeometry();
        geo.setPositions(pos);
        const line = new LineSegments2(geo, this.mat);
        line.renderOrder = 35;
        this.layer.group.add(line);
        this.lines.push(line);
      }
      // The label just outside the first hole's mouth, on its diagonal.
      const c0 = t.centres[0];
      const y = ydirOf({ origin: c0, normal: t.d, xdir: t.x });
      const at = [0, 1, 2].map((k) => c0[k] + t.thread.major * 0.75 * Math.SQRT1_2 * (t.x[k] + y[k])) as Vec3;
      const el = this.layer.html.ownerDocument.createElement('span');
      el.className = 'cad-thread-label';
      el.dataset.thread = t.name;
      el.textContent = t.thread.designation;
      this.layer.html.appendChild(el);
      this.labels.push({ el, at });
    }
    this.layer.changed();
  }

  private place(): void {
    if (!this.lines.length && !this.labels.length) return;
    const [rw, rh] = this.handle.lineResolution();
    this.mat.resolution.set(rw, rh);
    // project() gives frame client px; the labels sit in the layer's own box.
    const r = this.layer.html.getBoundingClientRect();
    for (const l of this.labels) {
      const p = this.handle.project(l.at);
      l.el.style.display = p ? '' : 'none';
      if (p) {
        l.el.style.left = `${p[0] - r.left}px`;
        l.el.style.top = `${p[1] - r.top}px`;
      }
    }
  }

  private clear(): void {
    for (const l of this.lines) {
      this.layer.group.remove(l);
      l.geometry.dispose();
    }
    for (const l of this.labels) l.el.remove();
    this.lines = [];
    this.labels = [];
  }

  dispose(): void {
    this.run++;
    for (const off of this.offs.splice(0)) off();
    this.clear();
    this.mat.dispose();
    this.layer.dispose();
  }
}

/** Keep a thread overlay on whichever viewport the app has. Returns the uninstall. */
export function installThreads(services: AppServices): () => void {
  let handle: ViewportHandle | null = null;
  let overlay: ThreadOverlay | null = null;
  const attach = (next: ViewportHandle | null) => {
    if (next === handle) return;
    overlay?.dispose();
    overlay = null;
    handle = next;
    if (!handle || typeof handle.addLayer !== 'function') return;
    overlay = new ThreadOverlay(services, handle);
  };
  attach(services.viewport.get().handle);
  const off = services.viewport.subscribe((st) => attach(st.handle));
  return () => {
    off();
    attach(null);
  };
}
