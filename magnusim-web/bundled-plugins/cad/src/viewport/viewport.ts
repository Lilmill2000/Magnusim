// The three.js viewport: bodies (one BufferGeometry per body from the kernel's
// tessellation) with B-rep edges as screen-width lines, the origin planes, the
// orientation triad, hover pre-highlight and selection highlight, BVH picking
// (built in the picking worker for large bodies), the core's mouse mapping
// with zoom to cursor, perspective / orthographic, standard views with smooth
// transitions, fit, section view and body visibility. Renders on demand.
// Values copied from the core viewer: src/viewport/colors.ts.
// Owner: VIEWPORT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { Box3, BufferGeometry, Float32BufferAttribute, Group, LessEqualDepth, Mesh, Plane, Points, Ray, Scene, Sphere, Vector3, WebGLRenderer, type Material, type Object3D } from 'three';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import type { MeshBVH } from 'three-mesh-bvh';
import { floatingRects } from '../lib/chrome';
import { createStateStore } from '../lib/store';
import type { AppServices } from '../types/app';
import { ORIGIN_PLANES, type BodyId, type OriginPlaneRef, type SavedCamera, type Vec2, type Vec3 } from '../types/doc';
import type { PickResult, SelectionItem, SelectKind } from '../types/selection';
import type { DisplayMode, FrameBox, OverlayLayer, PlanesMode, Projection, SectionState, StandardView, ViewportBody, ViewportHandle, ViewportPickEvent, ViewportPointer, ViewportState, ViewportStats, ViewportTool } from '../types/viewport';
import { bindViewport } from './bind';
import { BvhClient } from './bvh';
import { CameraRig, VIEW_DIRS, type CameraPose } from './camera';
import {
  BODY_COLOR,
  CLICK_PX,
  EDGE_COLOR,
  EDGE_WIDTH_PX,
  HOME_DIR,
  HOVER_COLOR,
  PICK_EDGE_COLOR,
  PICK_EDGE_WIDTH_PX,
  PICK_VERTEX_COLOR,
  PICK_VERTEX_PX,
  RIGHT_CLICK_PX,
  TRIAD_PX,
  VIEWPORT_BG,
  parseHex,
  rgb01,
} from './colors';
import { BODY_LIT_OFFSET_UNITS, BODY_OFFSET_UNITS, createBodyMaterial, createPointsMaterial, SEE_THROUGH_OFFSET_UNITS, setBodyColor, setClipping, setSeeThrough, type BodyMaterial } from './materials';
import { OriginPlanes, type PlaneState } from './origin';
import { kindsForFilter, pickAt, raycastBodies, rayAt, type PickBody, type PickView } from './pick';
import { DEFAULT_SECTION, SectionCaps, sectionPlane } from './section';
import { buildBodyData, edgeSegments, HL_HOVER, HL_NONE, HL_PICK, meshCentroid, planarFaceNormal, setFaceHl, type BodyData } from './tess';
import { Triad } from './triad';

export { VIEWPORT_BG };
/** Core default view direction, from front-left and slightly above (runtime.js:9118). Z up. */
export const DEFAULT_VIEW_DIR: Vec3 = HOME_DIR;

/** A camera move is reported (and kept with the Part) once it has rested this long (ms). */
const CAMERA_REST_MS = 400;
/** A standard view / fit transition (ms). */
const TRANSITION_MS = 320;
/**
 * Fit frames the bodies' bounding sphere this much larger than the view height
 * (vtk's resetCamera fills it exactly), so a framed part keeps clear of the
 * frame's edges and of the status chips along the bottom.
 */
const FIT_MARGIN = 1.2;
/** The visible part grew or shrank this many times in one rebuild: frame it again (a size typed wrong and fixed). */
const REFIT_RATIO = 10;
/** At most one hover pick per this many ms (about one per frame). */
const HOVER_MS = 16;

export interface ViewportOptions {
  /** The app's services: the viewport binds itself to the document, selection and bus (bind.ts). */
  services?: AppServices;
  /** Starts the picking worker (default: services.bridge.spawnWorker; null = always on the main thread). */
  spawnWorker?: ((url: string) => Worker) | null;
  /** Absolute URL of the picking worker (default: pick/pick-worker.js next to the page). */
  pickWorkerUrl?: string;
}

interface BodyRec {
  id: BodyId;
  tessKey: string;
  data: BodyData;
  mesh: Mesh<BufferGeometry, BodyMaterial>;
  edges: LineSegments2;
  edgeMat: LineMaterial;
  color: number;
  docVisible: boolean;
  override: boolean | null;
  feature: string | undefined;
  vertices: Float32Array | null;
  /** The kernel's box (ViewportBody.bbox), for the section slider's range. */
  kbox: readonly number[] | null;
  bvh: MeshBVH | null;
  cancelBvh: () => void;
  /** Faces whose hl is not 0 right now. */
  faceHl: Map<number, number>;
  /** ViewportBody.seeThrough. */
  seeThrough: boolean;
}

/** Screen-width lines. An overlay (picked or hovered edges) is pulled towards the camera so it wins over the edge it covers. */
function makeLineMaterial(color: number, width: number, overlay = false): LineMaterial {
  const m = new LineMaterial({ color, linewidth: width, worldUnits: false, depthFunc: LessEqualDepth });
  if (overlay) {
    m.polygonOffset = true;
    m.polygonOffsetFactor = -2;
    m.polygonOffsetUnits = -8;
  }
  return m;
}

export function createViewport(host: HTMLElement, opts: ViewportOptions = {}): ViewportHandle {
  const services = opts.services;
  const state = createStateStore<ViewportState>({
    ready: false,
    display: 'shaded-edges',
    projection: 'perspective',
    hover: null,
    triangles: 0,
    bodies: 0,
    section: { ...DEFAULT_SECTION },
    planes: 'auto',
    bvhPending: 0,
    animating: false,
  });
  const stats: ViewportStats = { frames: 0, lastFrameMs: 0, lastSetBodiesMs: 0, lastUploadFrameMs: 0, lastPickMs: 0, bvh: {}, triangles: 0, drawCalls: 0 };

  // ------------------------------------------------------------ renderer
  const renderer = new WebGLRenderer({ antialias: true, alpha: false, stencil: true, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  renderer.setPixelRatio(pixelRatio);
  renderer.setClearColor(VIEWPORT_BG, 1);
  renderer.autoClear = false;
  renderer.localClippingEnabled = true;
  const canvas = renderer.domElement;
  canvas.className = 'cad-viewport-canvas';
  canvas.setAttribute('data-cad-canvas', '1');
  host.appendChild(canvas);

  const scene = new Scene();
  const rig = new CameraRig();
  rig.orient(HOME_DIR, [0, 0, 1]);
  const origin = new OriginPlanes(host);
  scene.add(origin.group);
  const triad = new Triad();
  const caps = new SectionCaps(pixelRatio);
  scene.add(caps.group);
  const clip = new Plane();

  const bvhClient = new BvhClient({
    spawnWorker: opts.spawnWorker !== undefined ? opts.spawnWorker : services ? (url: string) => services.bridge.spawnWorker(url) : null,
    workerUrl: opts.pickWorkerUrl,
  });

  const bodies = new Map<BodyId, BodyRec>();
  let order: BodyId[] = [];
  const pickListeners = new Set<(e: ViewportPickEvent) => void>();
  let selected: SelectionItem[] = [];
  let flashItems: SelectionItem[] = [];
  let filter: SelectKind[] = [];
  let lastGeomKey = '';
  let uploadPending = false;
  let disposed = false;

  // Selection / hover overlays: edges as wider lines, vertices as round markers.
  const selEdgeMat = makeLineMaterial(PICK_EDGE_COLOR, PICK_EDGE_WIDTH_PX, true);
  const hovEdgeMat = makeLineMaterial(HOVER_COLOR, PICK_EDGE_WIDTH_PX, true);
  const selEdges = new LineSegments2(new LineSegmentsGeometry(), selEdgeMat);
  const hovEdges = new LineSegments2(new LineSegmentsGeometry(), hovEdgeMat);
  selEdges.renderOrder = 5;
  hovEdges.renderOrder = 6;
  selEdges.visible = false;
  hovEdges.visible = false;
  selEdges.frustumCulled = false;
  hovEdges.frustumCulled = false;
  const pointsMat = createPointsMaterial(PICK_VERTEX_PX, pixelRatio);
  const points = new Points(new BufferGeometry(), pointsMat);
  points.renderOrder = 7;
  points.visible = false;
  points.frustumCulled = false;
  scene.add(selEdges, hovEdges, points);
  let edgeOverlayKey = '';
  const lineMats = (): LineMaterial[] => [selEdgeMat, hovEdgeMat, ...[...bodies.values()].map((b) => b.edgeMat)];

  // ------------------------------------------------------------ overlays and tools (P2/P3)
  // Layers: other areas' drawing (sketch geometry, regions, handles, measure
  // markers) in model coordinates, plus an html element over the canvas each.
  const layers = new Map<string, { layer: OverlayLayer; group: Group; html: HTMLElement; frame: boolean | (() => FrameBox | null) }>();
  const frameListeners = new Set<() => void>();
  /** Fat lines in layers get the viewport's size, as the bodies' edges do. */
  function layerLineMats(): LineMaterial[] {
    const out: LineMaterial[] = [];
    for (const { group } of layers.values()) {
      group.traverse((o: Object3D) => {
        const m = (o as Object3D & { material?: Material | Material[] }).material;
        for (const x of Array.isArray(m) ? m : m ? [m] : []) if (x instanceof LineMaterial) out.push(x);
      });
    }
    return out;
  }
  // Tools: newest first; one that consumes a 'down' captures the pointer until 'up'.
  const tools: ViewportTool[] = [];
  let captured: { tool: ViewportTool; pointerId: number; x0: number; y0: number; moved: boolean } | null = null;
  function applyCursor() {
    const top = tools[tools.length - 1];
    canvas.style.cursor = top?.cursor ?? '';
  }
  function pointerOf(type: ViewportPointer['type'], e: PointerEvent | MouseEvent): ViewportPointer {
    const p = local(e);
    const ray = rayAt(pickView(), p.x, p.y);
    return {
      type,
      button: e.button,
      buttons: e.buttons,
      clientX: e.clientX,
      clientY: e.clientY,
      ctrl: e.ctrlKey || e.metaKey,
      shift: e.shiftKey,
      alt: e.altKey,
      ray: { origin: [ray.origin.x, ray.origin.y, ray.origin.z], dir: [ray.direction.x, ray.direction.y, ray.direction.z] },
      native: e,
    };
  }
  /** Offer an event to the tools (newest first); true when one consumed it. */
  function offerTools(type: ViewportPointer['type'], e: PointerEvent | MouseEvent): boolean {
    if (!tools.length) return false;
    const ev = pointerOf(type, e);
    for (let i = tools.length - 1; i >= 0; i--) {
      const t = tools[i];
      let used = false;
      try {
        used = t.onPointer(ev);
      } catch (err) {
        console.error(`[cad] viewport tool ${t.id} failed`, err);
      }
      if (used) {
        if (type === 'down' && 'pointerId' in e) {
          const p = local(e);
          captured = { tool: t, pointerId: e.pointerId, x0: p.x, y0: p.y, moved: false };
        }
        return true;
      }
    }
    return false;
  }
  /** Send an event to the capturing tool only. */
  function toCaptured(type: ViewportPointer['type'], e: PointerEvent | MouseEvent) {
    if (!captured) return;
    try {
      captured.tool.onPointer(pointerOf(type, e));
    } catch (err) {
      console.error(`[cad] viewport tool ${captured.tool.id} failed`, err);
    }
  }

  // ------------------------------------------------------------ sizes
  let width = 1;
  let height = 1;
  function resize() {
    width = Math.max(1, host.clientWidth);
    height = Math.max(1, host.clientHeight);
    renderer.setSize(width, height, false);
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    request();
  }

  // ------------------------------------------------------------ render loop
  let frame = 0;
  /** A camera transition; `aim` when it frames the part (re-aimed while the panels beside it change). */
  let anim: { from: CameraPose; to: CameraPose; t0: number; ms: number; aim?: { dir: Vec3 | null; up: Vec3 | null; cover: number } } | null = null;
  /** The camera is where the last framing put it (fit, a standard view, Look at): no orbit, pan or zoom since. */
  let framed = true;
  /**
   * Owners drawing something other than bodies (sketches): Auto then hides the origin planes as
   * it does once bodies exist (review P2/P3 round 1: on an empty Part the Top plane's square sat
   * under the sketch in the same blue as its shaded regions).
   */
  const planesBusy = new Set<string>();
  const planesWanted = new Set<string>();
  /** The sphere (with the fit margin) the last framing showed. */
  let framedOn: Sphere | null = null;

  function request() {
    if (!frame && !disposed) frame = requestAnimationFrame(render);
  }

  function visibleOf(b: BodyRec): boolean {
    return b.override ?? b.docVisible;
  }

  function sceneSphere(): Sphere {
    const box = new Box3();
    for (const b of bodies.values()) if (visibleOf(b)) box.union(b.data.bounds);
    box.union(origin.box());
    // What the layers frame is inside the camera's depth range too (a sketch far from the origin).
    box.union(layersBox());
    return box.getBoundingSphere(new Sphere());
  }

  function triadRect(): { x: number; y: number; s: number } {
    const slot = host.querySelector<HTMLElement>('[data-triad-slot]');
    const c = canvas.getBoundingClientRect();
    if (slot && c.width > 0) {
      const r = slot.getBoundingClientRect();
      if (r.width > 0) return { x: r.left - c.left, y: c.bottom - r.bottom, s: Math.min(r.width, r.height) };
    }
    return { x: width - 10 - TRIAD_PX, y: 10, s: TRIAD_PX };
  }

  /** Observes the floating chrome's containers once they are there (set where the observers are made). */
  let watchChrome: () => void = () => {};

  function render() {
    frame = 0;
    if (disposed) return;
    watchChrome();
    if (anim) {
      // A panel that opens with the move (the Sketch panel with Look at) changes the free part of the view.
      if (anim.aim) {
        const cover = coverLeft();
        if (Math.abs(cover - anim.aim.cover) > 1) {
          anim.aim.cover = cover;
          anim.to = poseFor(anim.aim.dir, anim.aim.up, true);
        }
      }
      const t = Math.min(1, (performance.now() - anim.t0) / anim.ms);
      const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      rig.setPose(CameraRig.blend(anim.from, anim.to, e));
      if (t >= 1) {
        rig.setPose(anim.to);
        anim = null;
        state.set({ animating: false });
      } else request();
    }
    const t0 = performance.now();
    drawFrame();
    for (const fn of [...frameListeners]) {
      try {
        fn();
      } catch (err) {
        console.error('[cad] frame listener failed', err);
      }
    }
    const ms = performance.now() - t0;
    stats.lastFrameMs = ms;
    if (uploadPending) {
      stats.lastUploadFrameMs = ms;
      uploadPending = false;
    }
    stats.frames++;
    stats.drawCalls = renderer.info.render.calls;
    if (!state.get().ready) state.set({ ready: true });
  }

  function drawFrame() {
    rig.scene.copy(sceneSphere());
    const cam = rig.apply(width / height, width);
    for (const m of lineMats()) m.resolution.set(width, height);
    if (layers.size) for (const m of layerLineMats()) m.resolution.set(width, height);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, width, height);
    renderer.clear(true, true, true);
    renderer.render(scene, cam);
    const calls = renderer.info.render.calls;
    // The triad, in its own corner viewport.
    const tr = triadRect();
    renderer.clearDepth();
    renderer.setScissorTest(true);
    renderer.setScissor(tr.x, tr.y, tr.s, tr.s);
    renderer.setViewport(tr.x, tr.y, tr.s, tr.s);
    triad.sync(rig.quaternion());
    renderer.render(triad.scene, triad.camera);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, width, height);
    renderer.info.render.calls += calls;
    placePlaneLabels();
  }

  /** The origin planes' labels: away from the shown bodies, never drawn over one, never under the floating chrome. */
  function placePlaneLabels() {
    const c = canvas.getBoundingClientRect();
    const blocked = floatingRects(host.ownerDocument).map((r) => ({ left: r.left - c.left, top: r.top - c.top, right: r.right - c.left, bottom: r.bottom - c.top }));
    const shown = [...bodies.values()].filter(visibleOf);
    if (!shown.length) {
      origin.placeLabels((p) => projectLocal(p), rig.dop(), { size: { w: width, h: height }, blocked });
      return;
    }
    const box = new Box3();
    for (const b of shown) box.union(b.data.bounds);
    const view = pickView();
    const picks = pickBodies();
    const ray = new Ray();
    origin.placeLabels((p) => projectLocal(p), rig.dop(), {
      size: { w: width, h: height },
      away: box.getCenter(new Vector3()),
      covered: (x, y) => x >= 0 && y >= 0 && x <= width && y <= height && !!raycastBodies(picks, rayAt(view, x, y, ray), view),
      blocked,
    });
  }

  // ------------------------------------------------------------ projection helpers
  function projectLocal(p: Vector3): [number, number] | null {
    const cam = rig.apply(width / height, width);
    const v = p.clone().project(cam);
    if (v.z > 1 || v.z < -1) return null;
    return [((v.x + 1) / 2) * width, ((1 - v.y) / 2) * height];
  }

  function pickView(): PickView {
    const cam = rig.apply(width / height, width);
    const s = state.get();
    return {
      camera: cam,
      width,
      height,
      worldPerPixel: (p) => rig.worldPerPixel(p, height),
      clip: s.section.on ? clip : null,
      occlude: s.display !== 'wireframe',
      faces: s.display !== 'wireframe',
    };
  }

  function pickBodies(): PickBody[] {
    const out: PickBody[] = [];
    for (const id of order) {
      const b = bodies.get(id);
      if (b && visibleOf(b)) out.push({ id: b.id, data: b.data, bvh: b.bvh, vertices: b.vertices, seeThrough: b.seeThrough });
    }
    return out;
  }

  function pickLocal(x: number, y: number): PickResult | null {
    const t0 = performance.now();
    const r = pickAt(pickBodies(), origin.picks(), pickView(), x, y, kindsForFilter(filter));
    if (r) {
      const rect = canvas.getBoundingClientRect();
      r.screen = [r.screen[0] + rect.left, r.screen[1] + rect.top];
    }
    stats.lastPickMs = performance.now() - t0;
    return r;
  }

  // ------------------------------------------------------------ bodies
  function disposeBody(b: BodyRec) {
    b.cancelBvh();
    scene.remove(b.mesh, b.edges);
    b.mesh.geometry.dispose();
    b.mesh.material.dispose();
    b.edges.geometry.dispose();
    b.edgeMat.dispose();
    delete stats.bvh[b.id];
  }

  function makeBody(src: ViewportBody): BodyRec {
    const data = buildBodyData(src.tess);
    const color = parseHex(src.color);
    const material = createBodyMaterial(color);
    if (src.seeThrough) setSeeThrough(material, true);
    const mesh = new Mesh(data.geometry, material);
    mesh.name = `body:${src.id}`;
    mesh.frustumCulled = false;
    const eg = new LineSegmentsGeometry();
    if (data.drawEdges.length >= 6) eg.setPositions(data.drawEdges);
    const edgeMat = makeLineMaterial(EDGE_COLOR, EDGE_WIDTH_PX);
    const edges = new LineSegments2(eg, edgeMat);
    edges.name = `edges:${src.id}`;
    edges.frustumCulled = false;
    edges.renderOrder = 1;
    scene.add(mesh, edges);
    const rec: BodyRec = {
      id: src.id,
      tessKey: src.tessKey,
      data,
      mesh,
      edges,
      edgeMat,
      color,
      docVisible: src.visible,
      override: null,
      feature: src.feature,
      vertices: src.vertices ?? null,
      kbox: src.bbox ?? null,
      bvh: null,
      cancelBvh: () => {},
      faceHl: new Map(),
      seeThrough: !!src.seeThrough,
    };
    rec.cancelBvh = bvhClient.build(
      data.geometry,
      data.triangles,
      (r) => {
        rec.bvh = r.bvh;
        stats.bvh[rec.id] = { ms: r.ms, worker: r.worker };
        updateCounts();
      },
      (err) => console.warn(`[cad] picking structure for ${rec.id} failed: ${err.message}`),
    );
    return rec;
  }

  function updateCounts() {
    let tris = 0;
    let n = 0;
    let pending = 0;
    for (const b of bodies.values()) {
      if (!b.bvh) pending++;
      if (!visibleOf(b)) continue;
      n++;
      tris += b.data.triangles;
    }
    stats.triangles = tris;
    state.set({ triangles: tris, bodies: n, bvhPending: pending });
  }

  function applyDisplay() {
    const s = state.get();
    for (const b of bodies.values()) {
      const v = visibleOf(b);
      b.mesh.visible = v && s.display !== 'wireframe';
      b.edges.visible = v && s.display !== 'shaded' && b.data.drawEdges.length >= 6;
    }
    applySection();
  }

  function applySection() {
    const s = state.get().section;
    const planes = s.on ? [sectionPlane(s, clip)] : null;
    for (const b of bodies.values()) {
      setClipping(b.mesh.material, planes);
      setClipping(b.edgeMat, planes);
    }
    for (const m of [selEdgeMat, hovEdgeMat, pointsMat]) setClipping(m, planes);
    const shaded = state.get().display !== 'wireframe';
    caps.group.visible = s.on && shaded;
    if (s.on) {
      caps.setBodies(
        [...bodies.values()].map((b) => ({ key: `${b.id}|${b.tessKey}`, geometry: b.data.geometry, visible: visibleOf(b) })),
        clip,
      );
      caps.place(clip, sceneSphere(), BODY_COLOR);
    } else caps.setBodies([], clip);
  }

  function geometryChanged() {
    const box = new Box3();
    const vis = [...bodies.values()].filter(visibleOf);
    for (const b of vis) box.union(b.data.bounds);
    origin.fitTo(vis.length ? box : null);
    const c = meshCentroid(vis.map((b) => ({ positions: b.data.tess.positions, indices: b.data.tess.indices })));
    rig.pivot.set(...(c ?? ([0, 0, 0] as Vec3)));
    // Keep the pivot inside the framed scene (as the core does, runtime.js:9277-9285).
    if (!box.isEmpty()) {
      const grown = box.clone().expandByScalar(0.1 * Math.max(...box.getSize(new Vector3()).toArray()));
      if (!grown.containsPoint(rig.pivot)) box.getCenter(rig.pivot);
    }
  }

  /**
   * Frame the part again when it changed size many times over (a 1e6 mm box typed back to
   * 20 mm must not stay a dot), or when it reaches past the framed sphere of a view nobody has
   * moved since it was framed (review P2/P3 round 1: the Vortex's fluid-domain Box was cut off
   * until F).
   */
  function refitCheck(radiusBefore: number) {
    const now = framedSphere(true);
    const r = now.radius;
    if (radiusBefore > 0 && (r > radiusBefore * REFIT_RATIO || r * REFIT_RATIO < radiusBefore)) fit();
    else if (framed && framedOn && now.center.distanceTo(framedOn.center) + r > framedOn.radius * 1.001) fit();
  }

  /**
   * While a tool holds the pointer (an extrude arrow being dragged), the view does not refit:
   * the camera moving under a still pointer turns it into another value, and the part ran away
   * (review P2/P3 round 2: an arrow dragged to the spot of 25 mm stored 77.6 mm, the view
   * refitting on each live rebuild). The size before the hold; one check runs at the release.
   */
  let refitHeld: { radius: number; first: boolean } | null = null;
  function releaseRefit() {
    const held = refitHeld;
    refitHeld = null;
    if (!held || disposed || ![...bodies.values()].some(visibleOf)) return;
    if (held.first) fit();
    else refitCheck(held.radius);
  }

  function setBodies(list: ViewportBody[]) {
    const t0 = performance.now();
    const hadVisible = [...bodies.values()].some(visibleOf);
    const radiusBefore = hadVisible ? framedSphere(true).radius : 0;
    const seen = new Set<BodyId>();
    let geomChanged = false;
    for (const src of list) {
      seen.add(src.id);
      const old = bodies.get(src.id);
      if (old && old.tessKey === src.tessKey) {
        const color = parseHex(src.color);
        if (color !== old.color) {
          old.color = color;
          setBodyColor(old.mesh.material, color);
        }
        if (visibleOf(old) !== src.visible) geomChanged = true;
        old.docVisible = src.visible;
        old.override = null;
        old.feature = src.feature;
        old.kbox = src.bbox ?? old.kbox;
        if (src.vertices) old.vertices = src.vertices;
        if (old.seeThrough !== !!src.seeThrough) {
          old.seeThrough = !!src.seeThrough;
          setSeeThrough(old.mesh.material, old.seeThrough);
        }
        continue;
      }
      if (old) disposeBody(old);
      try {
        bodies.set(src.id, makeBody(src));
      } catch (err) {
        bodies.delete(src.id);
        console.warn(`[cad] body ${src.id} cannot be drawn: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      geomChanged = true;
      uploadPending = true;
    }
    for (const [id, b] of bodies) {
      if (seen.has(id)) continue;
      disposeBody(b);
      bodies.delete(id);
      geomChanged = true;
    }
    order = list.map((b) => b.id).filter((id) => bodies.has(id));
    const key = order.map((id) => `${id}|${bodies.get(id)!.tessKey}|${visibleOf(bodies.get(id)!)}`).join(',');
    if (geomChanged || key !== lastGeomKey) {
      lastGeomKey = key;
      geometryChanged();
    }
    applyDisplay();
    updateCounts();
    applyHighlight();
    stats.lastSetBodiesMs = performance.now() - t0;
    // The first bodies of a part are framed (like the core on a new import); so
    // is a part whose size changed many times over (a 1e6 mm box typed back to
    // 20 mm must not stay a dot).
    const hasVisible = [...bodies.values()].some(visibleOf);
    if (captured && hasVisible) {
      // A tool holds the pointer (an extrude arrow being dragged): the view waits for the release.
      if (!refitHeld) refitHeld = { radius: radiusBefore, first: !hadVisible };
    } else if (anim?.aim && hasVisible) {
      // A framing on its way (a standard view, Look at) frames the bodies as they are now: the
      // first body's own framing must not stop it (review P2/P3 round 2: the turn to Isometric of
      // a new extrude was cut short by the framing of the body it made).
      anim.to = poseFor(anim.aim.dir, anim.aim.up, true);
      framedOn = framedSphere();
      framedOn.radius *= FIT_MARGIN;
    } else if (!hadVisible && hasVisible) fit({ animate: false });
    else if (hadVisible && hasVisible) refitCheck(radiusBefore);
    // What is under a pointer that has not moved may have changed (a redo that
    // brings a body back hides the origin plane that was hovered): drop the
    // hover first (a hovered plane is drawn, and so pickable), then pick again.
    if (geomChanged && state.get().hover) setHover(null);
    if (geomChanged && hoverAt) scheduleHover(hoverAt);
    request();
  }

  // ------------------------------------------------------------ highlight
  function hoverItems(): SelectionItem[] {
    const h = state.get().hover;
    return [...(h ? [h.item] : []), ...flashItems];
  }

  function applyHighlight() {
    const want = new Map<BodyId, Map<number, number>>();
    const bodyState = new Map<BodyId, number>();
    const planes: Partial<Record<OriginPlaneRef, PlaneState>> = {};
    const selEdgeList: [BodyId, number][] = [];
    const hovEdgeList: [BodyId, number][] = [];
    const pts: { p: Vec3; c: number }[] = [];
    const selKeys = new Set<string>();
    const faceMap = (id: BodyId) => {
      let m = want.get(id);
      if (!m) want.set(id, (m = new Map()));
      return m;
    };
    const vertexAt = (id: BodyId, i: number): Vec3 | null => {
      const v = bodies.get(id)?.vertices;
      return v && 3 * i + 2 < v.length ? [v[3 * i], v[3 * i + 1], v[3 * i + 2]] : null;
    };
    const isPlane = (ref: string): ref is OriginPlaneRef => ref in ORIGIN_PLANES;
    for (const it of selected) {
      switch (it.kind) {
        case 'face':
          faceMap(it.body).set(it.index, HL_PICK);
          break;
        case 'edge':
          selEdgeList.push([it.body, it.index]);
          selKeys.add(`e:${it.body}:${it.index}`);
          break;
        case 'vertex': {
          const p = vertexAt(it.body, it.index);
          if (p) pts.push({ p, c: PICK_VERTEX_COLOR });
          selKeys.add(`v:${it.body}:${it.index}`);
          break;
        }
        case 'body':
          bodyState.set(it.body, 2);
          break;
        case 'feature':
          for (const b of bodies.values()) if (b.feature === it.feature) bodyState.set(b.id, 2);
          break;
        case 'origin':
          if (isPlane(it.ref)) planes[it.ref] = 'pick';
          break;
      }
    }
    for (const it of hoverItems()) {
      switch (it.kind) {
        case 'face': {
          const m = faceMap(it.body);
          if (m.get(it.index) !== HL_PICK) m.set(it.index, HL_HOVER);
          break;
        }
        case 'edge':
          if (!selKeys.has(`e:${it.body}:${it.index}`)) hovEdgeList.push([it.body, it.index]);
          break;
        case 'vertex': {
          const p = vertexAt(it.body, it.index);
          if (p && !selKeys.has(`v:${it.body}:${it.index}`)) pts.push({ p, c: HOVER_COLOR });
          break;
        }
        case 'body':
          if (bodyState.get(it.body) !== 2) bodyState.set(it.body, 1);
          break;
        case 'feature':
          for (const b of bodies.values()) if (b.feature === it.feature && bodyState.get(b.id) !== 2) bodyState.set(b.id, 1);
          break;
        case 'origin':
          if (isPlane(it.ref) && planes[it.ref] !== 'pick') planes[it.ref] = 'hover';
          break;
      }
    }
    let changed = origin.setState(planes);
    const anyBody = [...bodies.values()].some(visibleOf);
    if (origin.setShown(state.get().planes === 'always' || planesWanted.size > 0 || (!anyBody && planesBusy.size === 0))) changed = true;
    for (const b of bodies.values()) {
      const target = want.get(b.id) ?? new Map<number, number>();
      for (const face of [...b.faceHl.keys()]) {
        if (target.has(face)) continue;
        setFaceHl(b.data, face, HL_NONE);
        b.faceHl.delete(face);
        changed = true;
      }
      for (const [face, v] of target) {
        if (b.faceHl.get(face) === v) continue;
        setFaceHl(b.data, face, v);
        b.faceHl.set(face, v);
        changed = true;
      }
      const bs = bodyState.get(b.id) ?? 0;
      if (b.mesh.material.uniforms.uBodyState.value !== bs) {
        b.mesh.material.uniforms.uBodyState.value = bs;
        changed = true;
      }
      // A body with something lit on it is pushed back less than the others, so
      // where it shares a face plane with another body its highlight wins the
      // depth test instead of fighting it (review round 2: a grey wedge in a
      // selected box top). Its own edges still win over it.
      // A see-through body (an Enclosure) is pushed back further than any: where it shares a face
      // plane with the part (Zero padding) the part's face wins whole, instead of fighting it in
      // patches (SD review round 1: grey triangles on the shared faces).
      const units = b.seeThrough ? SEE_THROUGH_OFFSET_UNITS : bs > 0 || target.size > 0 ? BODY_LIT_OFFSET_UNITS : BODY_OFFSET_UNITS;
      if (b.mesh.material.polygonOffsetUnits !== units) {
        b.mesh.material.polygonOffsetUnits = units;
        changed = true;
      }
    }
    // Edge and vertex overlays (rebuilt only when their contents change).
    const eKey = (l: [BodyId, number][]) => l.map(([b, e]) => `${b}:${e}:${bodies.get(b)?.tessKey ?? ''}:${bodies.get(b) && visibleOf(bodies.get(b)!)}`).join(',');
    const key = `${eKey(selEdgeList)}|${eKey(hovEdgeList)}|${pts.map((p) => p.p.join(':') + '/' + p.c).join(',')}`;
    if (key !== edgeOverlayKey) {
      edgeOverlayKey = key;
      setEdgeOverlay(selEdges, selEdgeList);
      setEdgeOverlay(hovEdges, hovEdgeList);
      setPoints(pts);
      changed = true;
    }
    if (changed) request();
  }

  function setEdgeOverlay(obj: LineSegments2, list: [BodyId, number][]) {
    const parts: Float32Array[] = [];
    for (const [id, e] of list) {
      const b = bodies.get(id);
      if (!b || !visibleOf(b) || e < 0 || e >= b.data.edges) continue;
      const seg = edgeSegments(b.data, e);
      if (seg.length >= 6) parts.push(seg);
    }
    const n = parts.reduce((s, p) => s + p.length, 0);
    obj.geometry.dispose();
    const g = new LineSegmentsGeometry();
    if (n >= 6) {
      const all = new Float32Array(n);
      let o = 0;
      for (const p of parts) {
        all.set(p, o);
        o += p.length;
      }
      g.setPositions(all);
    }
    obj.geometry = g;
    obj.visible = n >= 6;
  }

  function setPoints(pts: { p: Vec3; c: number }[]) {
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(pts.flatMap((x) => x.p), 3));
    g.setAttribute('color', new Float32BufferAttribute(pts.flatMap((x) => rgb01(x.c)), 3));
    points.geometry.dispose();
    points.geometry = g;
    points.visible = pts.length > 0;
  }

  function setHover(p: PickResult | null) {
    const prev = state.get().hover;
    const same = !!prev && !!p ? JSON.stringify(prev.item) === JSON.stringify(p.item) : prev === p;
    state.set({ hover: p });
    if (!same) applyHighlight();
  }

  // ------------------------------------------------------------ camera moves
  /** What a layer draws now (visible objects only: an empty, hidden line set is not at the origin). */
  function shownBox(group: Group): Box3 {
    const out = new Box3();
    group.updateMatrixWorld(true);
    const walk = (o: Object3D) => {
      if (!o.visible) return;
      const g = (o as Object3D & { geometry?: BufferGeometry }).geometry;
      if (g && typeof g.computeBoundingBox === 'function') {
        if (!g.boundingBox) g.computeBoundingBox();
        const b = g.boundingBox;
        if (b && !b.isEmpty() && Number.isFinite(b.min.x) && Number.isFinite(b.max.x)) out.union(b.clone().applyMatrix4(o.matrixWorld));
      }
      for (const c of o.children) walk(c);
    };
    walk(group);
    return out;
  }

  /**
   * What the layers that count in framing draw now: the shown sketches (`frame: true`) and the
   * sketch being edited (a function); `shownOnly` leaves the latter out.
   */
  function layersBox(shownOnly = false): Box3 {
    const out = new Box3();
    for (const l of layers.values()) {
      if (!l.frame || !l.group.visible || (shownOnly && l.frame !== true)) continue;
      if (l.frame === true) {
        out.union(shownBox(l.group));
        continue;
      }
      let b: FrameBox | null = null;
      try {
        b = l.frame();
      } catch (err) {
        console.error(`[cad] layer ${l.layer.id} could not say what it frames`, err);
      }
      if (b && [...b.min, ...b.max].every(Number.isFinite)) out.union(new Box3(new Vector3(...b.min), new Vector3(...b.max)));
    }
    return out;
  }

  /**
   * What a framing shows: the shown bodies (never one the rollback hides: those are not in the
   * last setBodies) and the shown sketches (review P2/P3 round 2: a new extrude framed only the
   * lens it made, cutting off the circles of its sketch); the origin planes' extent only when
   * neither is drawn. Review round 4: with no body the planes' extent stayed in, and it keeps
   * the size the last bodies gave it, so a reopened sketch whose later bodies were rolled back
   * was framed on those bodies (most of it and its dimensions off-screen), and a sketch-only
   * part's 35 mm sketch sat small in the origin planes' extent.
   * `forRefit`: what the view's own refits follow (a body growing out of the view), which leaves
   * out the sketch being edited: the camera never moves by itself while lines are drawn.
   */
  function framedSphere(forRefit = false): Sphere {
    const box = new Box3();
    for (const b of bodies.values()) if (visibleOf(b)) box.union(b.data.bounds);
    box.union(layersBox(forRefit));
    if (box.isEmpty()) box.copy(origin.box());
    const sphere = box.getBoundingSphere(new Sphere());
    // One sketch point alone has no size: a small view around it.
    if (!(sphere.radius > 1e-6)) sphere.radius = 1;
    return sphere;
  }

  function goTo(to: CameraPose, animate: boolean, aim?: { dir: Vec3 | null; up: Vec3 | null }) {
    if (!animate) {
      anim = null;
      rig.setPose(to);
      state.set({ animating: false });
      request();
      return;
    }
    anim = { from: rig.pose(), to, t0: performance.now(), ms: TRANSITION_MS, aim: aim ? { ...aim, cover: coverLeft() } : undefined };
    state.set({ animating: true });
    request();
  }

  /**
   * CSS px over the left of the view that floating panels cover (elements marked
   * [data-view-cover]: the tree column and the open panel). Framing centres the
   * part in the rest (review P2/P3 round 1: at 1280 px, Look at put the sketch
   * origin at x = 640 with the tree and the Sketch panel over x < 600). At most
   * half the view.
   */
  function coverLeft(): number {
    const c = canvas.getBoundingClientRect();
    if (!(c.width > 0)) return 0;
    let right = 0;
    for (const el of host.ownerDocument.querySelectorAll<HTMLElement>('[data-view-cover]')) {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0 || r.left - c.left > c.width / 4 || r.bottom <= c.top || r.top >= c.bottom) continue;
      right = Math.max(right, r.right - c.left);
    }
    return Math.min(right, c.width / 2);
  }

  function poseFor(dir: Vec3 | null, up: Vec3 | null, frameIt: boolean): CameraPose {
    const tmp = new CameraRig();
    tmp.setPose(rig.pose());
    tmp.projection = rig.projection;
    if (dir) tmp.orient(dir, up ?? [0, 0, 1]);
    if (frameIt) {
      const sphere = framedSphere();
      sphere.radius *= FIT_MARGIN;
      tmp.frame(sphere);
      tmp.frameBeside(width, height, coverLeft());
    }
    return tmp.pose();
  }

  /** The direction of the last framing (null: the one the camera had), for reframe(). */
  let lastAim: { dir: Vec3 | null; up: Vec3 | null } | null = null;

  /**
   * Frame the shown bodies and sketches (fit, a standard view, Look at). Until the
   * user moves the camera, the view stays "framed": bodies that grow out of it are
   * framed again (setBodies).
   */
  function frameTo(dir: Vec3 | null, up: Vec3 | null, animate: boolean) {
    framed = true;
    lastAim = { dir, up };
    framedOn = framedSphere();
    framedOn.radius *= FIT_MARGIN;
    goTo(poseFor(dir, up, true), animate, { dir, up });
  }

  /** The last framing again with what is drawn now, while nobody has moved the camera since it. */
  function reframe(): boolean {
    if (!framed || !lastAim || disposed) return false;
    const now = framedSphere();
    now.radius *= FIT_MARGIN;
    if (anim?.aim) {
      anim.to = poseFor(anim.aim.dir, anim.aim.up, true);
      framedOn = now;
      request();
      return true;
    }
    // Nothing changed: the camera stays where it is (no transition to the same place).
    const eps = 1e-6 * Math.max(1, now.radius);
    if (framedOn && now.center.distanceTo(framedOn.center) <= eps && Math.abs(now.radius - framedOn.radius) <= eps) return true;
    frameTo(lastAim.dir, lastAim.up, true);
    return true;
  }

  // ------------------------------------------------------------ the camera a Part keeps
  const cameraListeners = new Set<(c: SavedCamera) => void>();
  let cameraTimer: ReturnType<typeof setTimeout> | 0 = 0;

  function savedCamera(): SavedCamera {
    const p = rig.pose();
    return {
      position: [p.position.x, p.position.y, p.position.z],
      target: [p.target.x, p.target.y, p.target.z],
      up: [p.up.x, p.up.y, p.up.z],
      orthoHeight: p.orthoHeight,
      projection: state.get().projection,
    };
  }

  /** The user moved the camera: tell the listeners once it rests (a transition finishes first). */
  function cameraMoved() {
    if (cameraTimer) clearTimeout(cameraTimer);
    cameraTimer = setTimeout(() => {
      cameraTimer = 0;
      if (disposed) return;
      if (anim) {
        cameraMoved();
        return;
      }
      const c = savedCamera();
      for (const fn of [...cameraListeners]) {
        try {
          fn(c);
        } catch (err) {
          console.error('[cad] camera listener failed', err);
        }
      }
    }, CAMERA_REST_MS);
  }

  // The pivot and plane sizes follow the geometry (geometryChanged on setBodies / setVisibility), not the view.
  function fit(o: { animate?: boolean } = {}) {
    frameTo(null, null, o.animate ?? true);
  }

  function setView(view: StandardView, o: { animate?: boolean } = {}) {
    const v = VIEW_DIRS[view];
    frameTo(v.dir, v.up, o.animate ?? true);
  }

  function lookAt(normal: Vec3, up: Vec3 = [0, 0, 1], o: { animate?: boolean } = {}) {
    const n = new Vector3(...normal).normalize();
    let u: Vec3 = up;
    if (Math.abs(n.dot(new Vector3(...up).normalize())) > 0.99) u = Math.abs(n.z) > 0.9 ? [0, 1, 0] : [0, 0, 1];
    // Framed as a standard view is (review round 2: after Normal to the cylinder was cut off).
    frameTo([n.x, n.y, n.z], u, o.animate ?? true);
  }

  // ------------------------------------------------------------ pointer input
  let drag: { button: number; mode: 'orbit' | 'pan' | 'zoom' | null; x0: number; y0: number; x: number; y: number; moved: boolean; additive: boolean; anchor: Vector3 | null; id: number } | null = null;
  let hoverAt: { x: number; y: number } | null = null;
  // Hover picks run at most every HOVER_MS on a timer (not rAF: a pick must not
  // wait on a frame the browser may hold back, and a pointer that stops moving
  // still gets its pick).
  let hoverTimer: ReturnType<typeof setTimeout> | 0 = 0;
  let lastHover = 0;

  const local = (e: { clientX: number; clientY: number }) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  function anchorAt(x: number, y: number): Vector3 {
    const view = pickView();
    const ray = rayAt(view, x, y);
    const hit = view.faces ? raycastBodies(pickBodies(), ray, view) : null;
    if (hit) return hit.point;
    // Otherwise the point at the target's depth under the pointer.
    const dop = rig.dop();
    const denom = ray.direction.dot(dop);
    const t = Math.abs(denom) > 1e-9 ? new Vector3().subVectors(rig.target, ray.origin).dot(dop) / denom : 0;
    return ray.at(Math.max(t, 0), new Vector3());
  }

  function emit(ev: ViewportPickEvent) {
    for (const fn of [...pickListeners]) {
      try {
        fn(ev);
      } catch (err) {
        console.error('[cad] pick listener failed', err);
      }
    }
  }

  function scheduleHover(p: { x: number; y: number }) {
    hoverAt = p;
    if (hoverTimer) return;
    hoverTimer = setTimeout(runHover, Math.max(0, HOVER_MS - (performance.now() - lastHover)));
  }

  function runHover() {
    hoverTimer = 0;
    lastHover = performance.now();
    if (!hoverAt || drag || disposed) return;
    setHover(pickLocal(hoverAt.x, hoverAt.y));
  }

  function stopAnim() {
    if (!anim) return;
    anim = null;
    state.set({ animating: false });
  }

  function onPointerDown(e: PointerEvent) {
    if (drag) return;
    if (captured) {
      toCaptured('down', e);
      return;
    }
    if (e.button !== 0 && e.button !== 1 && e.button !== 2) return;
    if (e.button === 1) e.preventDefault();
    // A tool (sketch tool, a panel's picker, a drag handle) may take the press: then it gets
    // the whole gesture and nothing orbits or selects.
    if (offerTools('down', e)) {
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        /* synthetic events have no capture */
      }
      if (state.get().hover) setHover(null);
      stopAnim();
      return;
    }
    const p = local(e);
    drag = { button: e.button, mode: null, x0: p.x, y0: p.y, x: p.x, y: p.y, moved: false, additive: e.ctrlKey || e.metaKey, anchor: null, id: e.pointerId };
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic events have no capture */
    }
    stopAnim();
  }

  function onPointerMove(e: PointerEvent) {
    const p = local(e);
    if (captured && e.pointerId === captured.pointerId) {
      if (Math.hypot(p.x - captured.x0, p.y - captured.y0) > CLICK_PX) captured.moved = true;
      toCaptured('move', e);
      return;
    }
    // A press whose release never reached us (let go outside the frame without capture): forget it.
    if (drag && e.pointerId === drag.id && e.buttons === 0 && e.pointerType === 'mouse') drag = null;
    if (drag && e.pointerId === drag.id) {
      if (!drag.mode) {
        const threshold = drag.button === 2 ? RIGHT_CLICK_PX : CLICK_PX;
        if (Math.hypot(p.x - drag.x0, p.y - drag.y0) <= threshold) return;
        drag.mode = drag.button === 1 || (drag.button === 0 && e.shiftKey) ? 'pan' : drag.button === 2 ? 'zoom' : 'orbit';
        drag.moved = true;
        if (drag.mode === 'zoom') drag.anchor = anchorAt(drag.x0, drag.y0);
        if (state.get().hover) setHover(null);
        // The whole move counts from the press point.
        drag.x = drag.x0;
        drag.y = drag.y0;
      }
      const dx = p.x - drag.x;
      const dy = p.y - drag.y;
      drag.x = p.x;
      drag.y = p.y;
      framed = false;
      if (drag.mode === 'orbit') rig.orbit(dx, dy, width, height);
      else if (drag.mode === 'pan') rig.pan(dx, dy, height);
      else rig.zoomAt(Math.exp((dy * 1.9) / height), drag.anchor);
      request();
      return;
    }
    if (e.buttons) return;
    // Hover: a tool that takes the move (it pre-highlights its own things) stops the model's hover.
    if (offerTools('move', e)) {
      if (state.get().hover) setHover(null);
      return;
    }
    scheduleHover(p);
  }

  function onPointerUp(e: PointerEvent) {
    if (captured && e.pointerId === captured.pointerId) {
      const c = captured;
      toCaptured('up', e);
      if (!c.moved && e.button === 0) toCaptured('click', e);
      captured = null;
      try {
        canvas.releasePointerCapture(e.pointerId);
      } catch {
        /* not captured */
      }
      releaseRefit();
      return;
    }
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* not captured */
    }
    const p = local(e);
    if (d.moved) {
      scheduleHover(p);
      cameraMoved();
      return;
    }
    if (d.button === 0) {
      if (offerTools('click', e)) return;
      emit({ type: 'click', pick: pickLocal(p.x, p.y), additive: d.additive || e.ctrlKey || e.metaKey, clientX: e.clientX, clientY: e.clientY });
    } else if (d.button === 2) {
      if (offerTools('contextmenu', e)) return;
      emit({ type: 'contextmenu', pick: pickLocal(p.x, p.y), additive: false, clientX: e.clientX, clientY: e.clientY });
    }
  }

  function onPointerCancel(e: PointerEvent) {
    if (captured && e.pointerId === captured.pointerId) {
      toCaptured('up', e);
      captured = null;
      releaseRefit();
    }
    if (drag && e.pointerId === drag.id) drag = null;
  }

  function onWheel(e: WheelEvent) {
    e.preventDefault();
    // vtk.js normalizeWheel: one notch = spin 1 (Chrome wheelDeltaY 120 / deltaY 100); zoom factor 1 - spin / 10.
    const wd = (e as WheelEvent & { wheelDeltaY?: number }).wheelDeltaY;
    let spin = typeof wd === 'number' && wd !== 0 ? -wd / 120 : (e.deltaY * (e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1)) / 100;
    spin = Math.max(-5, Math.min(5, spin));
    const f = 1 - spin / 10;
    if (!(f > 0)) return;
    const p = local(e);
    stopAnim();
    framed = false;
    rig.zoomAt(f, anchorAt(p.x, p.y));
    request();
    scheduleHover(p);
    cameraMoved();
  }

  function onDblClick(e: MouseEvent) {
    if (offerTools('dblclick', e)) return;
    const p = local(e);
    const pick = pickLocal(p.x, p.y);
    if (pick) emit({ type: 'dblclick', pick, additive: false, clientX: e.clientX, clientY: e.clientY });
  }

  function onLeave(e: PointerEvent) {
    hoverAt = null;
    if (!drag && state.get().hover) setHover(null);
    if (!captured && tools.length) offerTools('leave', e);
  }

  const onContextMenu = (e: Event) => e.preventDefault();
  const onAux = (e: Event) => e.preventDefault();
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerCancel);
  canvas.addEventListener('pointerleave', onLeave);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('dblclick', onDblClick);
  canvas.addEventListener('contextmenu', onContextMenu);
  canvas.addEventListener('auxclick', onAux);

  const ro = new ResizeObserver(resize);
  ro.observe(host);
  // The floating chrome (the tree column with its panel, the dock) changes size when a panel
  // opens or a chip comes: a frame then places the plane labels clear of it again.
  const chromeRo = new ResizeObserver(() => request());
  let chromeSeen = 0;
  watchChrome = () => {
    const els = host.ownerDocument.querySelectorAll('[data-view-cover], [data-cad-dock]');
    if (els.length === chromeSeen) return;
    chromeSeen = els.length;
    for (const el of Array.from(els)) chromeRo.observe(el);
  };
  watchChrome();
  resize();
  rig.frame(framedSphere());

  let unbind: () => void = () => {};

  const handle: ViewportHandle = {
    state,
    setBodies,
    setVisibility(id, visible) {
      const b = bodies.get(id);
      if (!b || visibleOf(b) === visible) return;
      b.override = visible;
      lastGeomKey = '';
      geometryChanged();
      applyDisplay();
      updateCounts();
      applyHighlight();
      if (state.get().hover) setHover(null);
      request();
    },
    setVertices(id, tessKey, vertices) {
      const b = bodies.get(id);
      if (!b || b.tessKey !== tessKey) return;
      b.vertices = vertices;
      edgeOverlayKey = '';
      applyHighlight();
    },
    highlight(items) {
      selected = items.slice();
      applyHighlight();
    },
    flash(items) {
      flashItems = items.slice();
      applyHighlight();
    },
    setFilter(kinds) {
      if (kinds.length === filter.length && kinds.every((k, i) => k === filter[i])) return;
      filter = kinds.slice();
      if (state.get().hover) setHover(null);
    },
    onPick(fn) {
      pickListeners.add(fn);
      return () => {
        pickListeners.delete(fn);
      };
    },
    fit(o) {
      fit(o);
      cameraMoved();
    },
    setView(view, o) {
      setView(view, o);
      cameraMoved();
    },
    lookAt(normal, up, o) {
      lookAt(normal, up, o);
      cameraMoved();
    },
    reframe() {
      if (!reframe()) return false;
      cameraMoved();
      return true;
    },
    refitIfOffScreen() {
      if (disposed || !framed || anim) return false;
      const box = new Box3();
      for (const b of bodies.values()) if (visibleOf(b)) box.union(b.data.bounds);
      box.union(layersBox(true));
      if (box.isEmpty()) return false;
      const off = [box.min.x, box.max.x].some((x) =>
        [box.min.y, box.max.y].some((y) =>
          [box.min.z, box.max.z].some((z) => {
            const s = projectLocal(new Vector3(x, y, z));
            return !s || s[0] < 0 || s[1] < 0 || s[0] > width || s[1] > height;
          }),
        ),
      );
      if (!off) return false;
      fit();
      cameraMoved();
      return true;
    },
    setDisplay(mode: DisplayMode) {
      if (state.get().display === mode) return;
      state.set({ display: mode });
      applyDisplay();
      if (state.get().hover) setHover(null);
      request();
    },
    setProjection(p: Projection) {
      if (state.get().projection === p) return;
      stopAnim();
      rig.setProjection(p);
      state.set({ projection: p });
      request();
      cameraMoved();
    },
    setSection(patch: Partial<SectionState>) {
      const next = { ...state.get().section, ...patch };
      if (!Number.isFinite(next.offset)) next.offset = 0;
      if (!(next.plane in ORIGIN_PLANES)) next.plane = 'origin:front';
      state.set({ section: next });
      applySection();
      if (state.get().hover) setHover(null);
      request();
    },
    setPlanes(mode: PlanesMode) {
      if (state.get().planes === mode) return;
      state.set({ planes: mode });
      applyHighlight();
      if (state.get().hover) setHover(null);
      request();
    },
    setPlanesBusy(owner: string, busy: boolean) {
      if (planesBusy.has(owner) === busy) return;
      if (busy) planesBusy.add(owner);
      else planesBusy.delete(owner);
      applyHighlight();
      request();
    },
    setPlanesWanted(owner: string, wanted: boolean) {
      if (planesWanted.has(owner) === wanted) return;
      if (wanted) planesWanted.add(owner);
      else planesWanted.delete(owner);
      applyHighlight();
      request();
    },
    sectionRange(plane: OriginPlaneRef) {
      // The kernel's box where there is one (exact), else the tessellation's.
      const box = new Box3();
      for (const b of bodies.values()) {
        if (!visibleOf(b)) continue;
        const k = b.kbox;
        if (k && k.length === 6 && k.every(Number.isFinite)) box.union(new Box3(new Vector3(k[0], k[1], k[2]), new Vector3(k[3], k[4], k[5])));
        else box.union(b.data.bounds);
      }
      if (box.isEmpty()) return null;
      const n = new Vector3(...ORIGIN_PLANES[plane].normal).normalize();
      let lo = Infinity;
      let hi = -Infinity;
      for (const x of [box.min.x, box.max.x])
        for (const y of [box.min.y, box.max.y])
          for (const z of [box.min.z, box.max.z]) {
            const d = n.x * x + n.y * y + n.z * z;
            lo = Math.min(lo, d);
            hi = Math.max(hi, d);
          }
      return [lo, hi];
    },
    pick(clientX, clientY) {
      const r = canvas.getBoundingClientRect();
      return pickLocal(clientX - r.left, clientY - r.top);
    },
    project(p) {
      const s = projectLocal(new Vector3(...p));
      if (!s) return null;
      const r = canvas.getBoundingClientRect();
      return [r.left + s[0], r.top + s[1]];
    },
    orbitAround(target) {
      if (target === 'center') {
        const box = new Box3();
        for (const b of bodies.values()) if (visibleOf(b)) box.union(b.data.bounds);
        if (box.isEmpty()) rig.pivot.set(0, 0, 0);
        else box.getCenter(rig.pivot);
      } else rig.pivot.set(target[0], target[1], target[2]);
    },
    orbitPivot() {
      return [rig.pivot.x, rig.pivot.y, rig.pivot.z];
    },
    camera: savedCamera,
    setCamera(c) {
      stopAnim();
      // The camera a Part kept is the user's: bodies that grow out of it are not framed again.
      framed = false;
      if (state.get().projection !== c.projection) {
        rig.setProjection(c.projection);
        state.set({ projection: c.projection });
      }
      rig.setPose({ position: new Vector3(...c.position), target: new Vector3(...c.target), up: new Vector3(...c.up), orthoHeight: c.orthoHeight });
      request();
    },
    onCameraChange(fn) {
      cameraListeners.add(fn);
      return () => {
        cameraListeners.delete(fn);
      };
    },
    planeNormal(item) {
      if (item.kind === 'origin') {
        const def = (ORIGIN_PLANES as Record<string, { normal: Vec3 } | undefined>)[item.ref];
        return def ? ([...def.normal] as Vec3) : null;
      }
      if (item.kind === 'face') {
        const b = bodies.get(item.body);
        return b ? planarFaceNormal(b.data, item.index) : null;
      }
      return null;
    },
    addLayer(id, o = {}) {
      layers.get(id)?.layer.dispose();
      const group = new Group();
      group.name = `layer:${id}`;
      group.renderOrder = 100 + (o.order ?? 10);
      const html = document.createElement('div');
      html.className = 'cad-viewport-layer';
      html.dataset.layer = id;
      html.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden;';
      host.appendChild(html);
      scene.add(group);
      const layer: OverlayLayer = {
        id,
        group,
        html,
        setVisible(visible) {
          group.visible = visible;
          html.style.display = visible ? '' : 'none';
          request();
        },
        changed: () => request(),
        dispose() {
          if (layers.get(id)?.layer !== layer) return;
          layers.delete(id);
          scene.remove(group);
          html.remove();
          request();
        },
      };
      layers.set(id, { layer, group, html, frame: typeof o.frame === 'function' ? o.frame : !!o.frame });
      request();
      return layer;
    },
    pushTool(tool) {
      tools.push(tool);
      applyCursor();
      let popped = false;
      return () => {
        if (popped) return;
        popped = true;
        const i = tools.lastIndexOf(tool);
        if (i >= 0) tools.splice(i, 1);
        if (captured?.tool === tool) {
          captured = null;
          releaseRefit();
        }
        applyCursor();
      };
    },
    rayAt(clientX, clientY) {
      const r = canvas.getBoundingClientRect();
      const ray = rayAt(pickView(), clientX - r.left, clientY - r.top);
      return { origin: [ray.origin.x, ray.origin.y, ray.origin.z], dir: [ray.direction.x, ray.direction.y, ray.direction.z] };
    },
    toPlane(clientX, clientY, plane) {
      const r = canvas.getBoundingClientRect();
      const ray = rayAt(pickView(), clientX - r.left, clientY - r.top);
      const n = new Vector3(...plane.normal).normalize();
      const denom = ray.direction.dot(n);
      if (Math.abs(denom) < 1e-12) return null;
      const o = new Vector3(...plane.origin);
      const t = new Vector3().subVectors(o, ray.origin).dot(n) / denom;
      const p = ray.at(t, new Vector3());
      const x = new Vector3(...plane.xdir);
      x.sub(n.clone().multiplyScalar(x.dot(n))).normalize();
      const y = new Vector3().crossVectors(n, x);
      const d = new Vector3().subVectors(p, o);
      const uv: Vec2 = [d.dot(x), d.dot(y)];
      return { p: [p.x, p.y, p.z], uv };
    },
    pixelSize(at) {
      rig.apply(width / height, width);
      return rig.worldPerPixel(new Vector3(...at), height);
    },
    onFrame(fn) {
      frameListeners.add(fn);
      return () => {
        frameListeners.delete(fn);
      };
    },
    lineResolution: () => [width, height],
    stats: () => ({ ...stats, bvh: { ...stats.bvh } }),
    measure(frames) {
      const gl = renderer.getContext();
      const px = new Uint8Array(4);
      const n = Math.max(1, Math.floor(frames));
      const t0 = performance.now();
      for (let i = 0; i < n; i++) {
        rig.orbit(3, 0, width, height);
        drawFrame();
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      }
      const ms = (performance.now() - t0) / n;
      request();
      return { msPerFrame: ms, frames: n };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unbind();
      ro.disconnect();
      chromeRo.disconnect();
      if (frame) cancelAnimationFrame(frame);
      if (hoverTimer) clearTimeout(hoverTimer);
      if (cameraTimer) clearTimeout(cameraTimer);
      cameraListeners.clear();
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerCancel);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('dblclick', onDblClick);
      canvas.removeEventListener('contextmenu', onContextMenu);
      canvas.removeEventListener('auxclick', onAux);
      for (const b of bodies.values()) disposeBody(b);
      bodies.clear();
      for (const { layer } of [...layers.values()]) layer.dispose();
      tools.length = 0;
      captured = null;
      frameListeners.clear();
      bvhClient.dispose();
      origin.dispose();
      triad.dispose();
      caps.dispose();
      for (const m of [selEdgeMat, hovEdgeMat, pointsMat]) m.dispose();
      selEdges.geometry.dispose();
      hovEdges.geometry.dispose();
      points.geometry.dispose();
      renderer.dispose();
      canvas.remove();
      pickListeners.clear();
    },
  };

  if (services) unbind = bindViewport(handle, services);
  request();
  return handle;
}
