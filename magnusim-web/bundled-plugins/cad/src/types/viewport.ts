// The 3D viewport's public surface.
// Owner: VIEWPORT (src/viewport/). Others call only what is here.
// P2/P3 (docs/p2p3-plan.md §3.3): overlay layers (sketch geometry, regions,
// manipulators, measure markers) and pointer tools (sketch tools, selection
// fields of panels, drag handles) that see pointer events before the camera
// and the selection do.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { Group } from 'three';
import type { BodyId, FeatureId, OriginPlaneRef, PlaneFrame, SavedCamera, Vec2, Vec3 } from './doc';
import type { TessPayload } from './kernel';
import type { PickResult, SelectionItem, SelectKind } from './selection';
import type { ReadonlyStateStore } from './state';

/**
 * A layer of extra drawing in model coordinates (mm), over the bodies. Its
 * owner adds three.js objects to `group` (lines: LineSegments2 with the
 * viewport's resolution, see setLineResolution; meshes; points) and calls
 * changed() after changing them. `html` is an absolutely placed element over
 * the canvas (pointer-events: none; children may set auto) for labels, glyphs
 * and value boxes, placed with project() and moved in onFrame().
 */
export interface OverlayLayer {
  readonly id: string;
  readonly group: Group;
  readonly html: HTMLElement;
  setVisible(visible: boolean): void;
  /** Redraw at the next frame. */
  changed(): void;
  /** Remove the group and the html element. */
  dispose(): void;
}

/** An axis-aligned box in model coordinates (mm). */
export interface FrameBox {
  min: Vec3;
  max: Vec3;
}

/** A pointer event offered to viewport tools before the camera and the selection (frame CSS px). */
export interface ViewportPointer {
  /** 'click': a press and release within the click threshold (5 px) that no tool captured, or that the capturing tool released. */
  type: 'down' | 'move' | 'up' | 'click' | 'dblclick' | 'contextmenu' | 'leave';
  button: number;
  buttons: number;
  clientX: number;
  clientY: number;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  /** The pointer's ray in model coordinates. */
  ray: { origin: Vec3; dir: Vec3 };
  /** The native event (preventDefault, pointerId). */
  native: PointerEvent | MouseEvent;
}

/**
 * A pointer tool: sketch tools, a panel's selection field, a drag handle.
 * Tools form a stack (newest first). A tool that returns true from a 'down'
 * captures the pointer: it gets every event until 'up' and nothing orbits or
 * selects. Unconsumed events go to the next tool, then to the viewport's own
 * handling (orbit / pan / zoom / pick into the selection).
 */
export interface ViewportTool {
  id: string;
  /** CSS cursor while this tool is the newest (e.g. 'crosshair'). */
  cursor?: string;
  onPointer(e: ViewportPointer): boolean;
}

/**
 * Standard views. `home` is the core viewer's default direction (front-left,
 * slightly above; the Fit button), `iso` a true isometric from front-right-top.
 */
export type StandardView = 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom' | 'iso' | 'home';
export type DisplayMode = 'shaded-edges' | 'shaded' | 'wireframe';
export type Projection = 'perspective' | 'orthographic';
/** Origin planes: 'auto' draws them on an empty part and while one is selected or hovered; 'always' draws them all the time. */
export type PlanesMode = 'auto' | 'always';

/** Section view: a clipping plane parallel to an origin plane, with capped cuts. */
export interface SectionState {
  on: boolean;
  plane: OriginPlaneRef;
  /** Distance of the cut from the origin along the plane's normal (mm). */
  offset: number;
  /** Keep the other side. */
  flip: boolean;
}

/** One body to draw: the kernel's tessellation plus display state. */
export interface ViewportBody {
  id: BodyId;
  /** "#rrggbb". */
  color: string;
  visible: boolean;
  /** Changes whenever the geometry changes; the same key keeps the uploaded mesh. */
  tessKey: string;
  tess: TessPayload;
  /** The feature that last changed the body (a selected feature highlights its bodies). */
  feature?: FeatureId;
  /**
   * Drawn translucent (no depth writes, so what is inside shows and nothing z-fights with a
   * coplanar face of it), and a click through it picks an opaque body behind it first (its own
   * faces where nothing opaque is behind). Edges and vertices behind it stay pickable.
   */
  seeThrough?: boolean;
  /**
   * The kernel's bounding box [xmin, ymin, zmin, xmax, ymax, zmax] (exact once
   * measured), for ranges the user reads (the section slider): a tessellated
   * Ø20 cylinder reaches only 9.983 mm.
   */
  bbox?: readonly number[] | null;
  /**
   * B-rep vertex positions (xyz) in the kernel's vertex-index order. Without
   * them the body's vertices are not pickable (see setVertices).
   */
  vertices?: Float32Array | null;
}

export interface ViewportState {
  /** False until the renderer has drawn its first frame. */
  ready: boolean;
  display: DisplayMode;
  projection: Projection;
  /** The item under the pointer (pre-highlight), or null. */
  hover: PickResult | null;
  /** Triangles currently drawn (all visible bodies). */
  triangles: number;
  /** Visible bodies. */
  bodies: number;
  section: SectionState;
  planes: PlanesMode;
  /** Bodies whose picking structure is still being built (their faces are not pickable yet). */
  bvhPending: number;
  /** A standard view or fit transition is running. */
  animating: boolean;
}

/** A pointer action in the viewport, after the click / drag thresholds. */
export interface ViewportPickEvent {
  type: 'click' | 'contextmenu' | 'dblclick';
  pick: PickResult | null;
  /** Ctrl (or Cmd) was held: toggle instead of replace. */
  additive: boolean;
  clientX: number;
  clientY: number;
}

/** Numbers for tests and performance reports (never shown in the UI). */
export interface ViewportStats {
  frames: number;
  /** CPU time of the last frame's render call (ms). */
  lastFrameMs: number;
  /** Main-thread time of the last setBodies (geometry build, ms; GPU upload happens at the next frame). */
  lastSetBodiesMs: number;
  /** CPU time of the first frame after the last setBodies (includes the GPU upload), ms. */
  lastUploadFrameMs: number;
  /** Time of the last pick (ms). */
  lastPickMs: number;
  /** BVH build per body (ms, in the worker or on the main thread). */
  bvh: Record<BodyId, { ms: number; worker: boolean }>;
  triangles: number;
  drawCalls: number;
}

/**
 * Created by the viewport's React host (src/viewport/ViewportView.tsx) once its
 * element is in the DOM, and published as services.viewport. When created with
 * the app's services it binds itself: bodies from DocService.state, highlight
 * and filter from services.selection, clicks into the selection, context menu
 * and double-click onto the bus. Tests and tools may drive it directly.
 */
export interface ViewportHandle {
  readonly state: ReadonlyStateStore<ViewportState>;
  /** Replace the bodies drawn. A body whose tessKey is unchanged keeps its GPU mesh and picking structure. */
  setBodies(bodies: ViewportBody[]): void;
  /** Show or hide one body now (the next setBodies carries the document's value again). */
  setVisibility(id: BodyId, visible: boolean): void;
  /** B-rep vertex positions for a body (kernel order), when they arrive after its tessellation. */
  setVertices(id: BodyId, tessKey: string, vertices: Float32Array): void;
  /** Show these items as selected (faces/edges/vertices in pick green, bodies in the core's body blue, planes). */
  highlight(items: SelectionItem[]): void;
  /** Temporary hover highlight for hover in lists (the selection list hovers a face); [] clears it. */
  flash(items: SelectionItem[]): void;
  /** Which kinds a click may pick. Empty = faces, edges, vertices and planes (a click on a face never picks the whole body). */
  setFilter(kinds: SelectKind[]): void;
  /** Clicks, right-clicks (context menu) and double-clicks with what is under the pointer. Returns unsubscribe. */
  onPick(fn: (e: ViewportPickEvent) => void): () => void;
  /**
   * Frame the visible bodies and the shown sketches (the origin planes when there are neither),
   * keeping the view direction. Bodies the rollback hides never count.
   * Framing (fit, setView, lookAt) centres the part in what floating panels leave free: elements
   * marked [data-view-cover] over the left of the view. Until the user orbits, pans or zooms,
   * bodies that grow out of the framed view are framed again.
   */
  fit(opts?: { animate?: boolean }): void;
  setView(view: StandardView, opts?: { animate?: boolean }): void;
  /** Turn the camera to look straight at a plane (Normal To / sketch entry), framing the shown part. `normal` points at the viewer. */
  lookAt(normal: Vec3, up?: Vec3, opts?: { animate?: boolean }): void;
  setDisplay(mode: DisplayMode): void;
  setProjection(p: Projection): void;
  setSection(patch: Partial<SectionState>): void;
  setPlanes(mode: PlanesMode): void;
  /**
   * In Auto mode the origin planes are drawn only on an empty part. Sketches are not bodies, so
   * whatever draws one (finished sketches, sketch mode) says so here: while any owner is `busy`
   * the planes stay hidden unless hovered or selected, as they do once bodies exist.
   */
  setPlanesBusy(owner: string, busy: boolean): void;
  /**
   * While any owner wants them, the origin planes are drawn (and pickable) whatever the bodies
   * and sketches say: Sketch with nothing selected waits for a plane or a flat face to be picked.
   * Not saved (the Origin planes setting stays the user's).
   */
  setPlanesWanted(owner: string, wanted: boolean): void;
  /** Range of the section offset along a plane's normal that cuts the visible bodies (mm), or null without bodies. */
  sectionRange(plane: OriginPlaneRef): [number, number] | null;
  /** Pick at frame client coordinates, respecting the selection filter. */
  pick(clientX: number, clientY: number): PickResult | null;
  /** Model point to frame client coordinates (null when behind the camera). For manipulators and tests. */
  project(p: Vec3): [number, number] | null;
  /** The normal of a planar face or an origin plane (pointing out of the material), or null when it is not planar. */
  planeNormal(item: SelectionItem): Vec3 | null;
  /**
   * Orbit about this point from now on (the core's "Orbit around this point /
   * model center / origin"); 'center' is the middle of the visible bodies.
   * The next change of the geometry puts the pivot back on the part.
   */
  orbitAround(target: Vec3 | 'center'): void;
  /** The point the camera orbits about (for tests). */
  orbitPivot(): Vec3;
  /** Where the camera is now (position, target, up, projection), as a Part keeps it. */
  camera(): SavedCamera;
  /** Put the camera where a Part kept it (no transition; nothing is reported to onCameraChange). */
  setCamera(camera: SavedCamera): void;
  /**
   * The user moved the camera (orbit, pan, zoom, Fit, a standard view, Normal
   * to, the projection) and it has come to rest. Not called for the viewport's
   * own framing of a part's first bodies. Returns unsubscribe.
   */
  onCameraChange(fn: (camera: SavedCamera) => void): () => void;
  stats(): ViewportStats;
  /**
   * Draw `frames` frames synchronously, orbiting a little each frame, and wait
   * for the GPU after each one. Returns ms per frame. For performance tests.
   */
  measure(frames: number): { msPerFrame: number; frames: number };

  // --- P2/P3: overlays and tools (docs/p2p3-plan.md §3.3) ---
  /**
   * A new overlay layer; `order` sorts layers (higher draws later, default 10). An id in use is
   * replaced. `frame`: what the layer draws counts when the view frames the part (Fit, the
   * standard views, Look at, a refit), as the shown sketches do; `true` for everything it
   * draws, or a function giving the box that counts (model mm; null when nothing does), so a
   * sketch counts its curves and dimensions but not its grid. Sketches and bodies are framed
   * together; the origin planes' extent only when neither is drawn.
   */
  addLayer(id: string, opts?: { order?: number; frame?: boolean | (() => FrameBox | null) }): OverlayLayer;
  /**
   * The last framing (Fit, a standard view, Look at) again, with what is drawn now, when the
   * camera is still where that framing put it (nobody orbited, panned or zoomed since). A
   * reopened sketch calls it once its rebuild has rolled the later bodies back (review P2/P3
   * round 4: the view stayed on bodies the rollback hid). False when the camera was moved.
   */
  reframe(): boolean;
  /**
   * Fit (keeping the direction) when what is drawn now (bodies and shown sketches) reaches off the
   * screen and nobody has orbited, panned or zoomed since the last framing; true when it did. Sketch
   * mode's end calls it (P4a review: a first large sketch stayed half off-screen after Finish).
   */
  refitIfOffScreen?(): boolean;
  /** Push a pointer tool on the stack; returns pop (safe to call twice). */
  pushTool(tool: ViewportTool): () => void;
  /** The ray under frame client coordinates (model mm). */
  rayAt(clientX: number, clientY: number): { origin: Vec3; dir: Vec3 };
  /** Where the pointer meets a plane: model point and the plane's own u/v (mm); null when the ray runs parallel to it. */
  toPlane(clientX: number, clientY: number, plane: PlaneFrame): { p: Vec3; uv: Vec2 } | null;
  /** Model length of one CSS pixel at a model point (pick radii, glyph offsets, handle sizes). */
  pixelSize(at: Vec3): number;
  /** Called after every drawn frame (the camera may have moved): re-place html overlays. Returns unsubscribe. */
  onFrame(fn: () => void): () => void;
  /** Size in device pixels for LineMaterial.resolution (fat lines in overlays). */
  lineResolution(): [number, number];
  dispose(): void;
}
