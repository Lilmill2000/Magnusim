// The 3D viewport's public surface.
// Owner: VIEWPORT (src/viewport/). Others call only what is here.
// P2/P3 (docs/p2p3-plan.md §3.3): overlay layers (sketch geometry, regions,
// manipulators, measure markers) and pointer tools (sketch tools, selection
// fields of panels, drag handles) that see pointer events before the camera
// and the selection do.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { Group } from 'three';
import type { BodyId, FeatureId, PlaneFrame, SavedCamera, Vec2, Vec3 } from './doc';
import type { PlaneRef } from './references';
import type { TessPayload } from './kernel';
import type { MarkPalette } from '../viewport/palette';
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
export type StandardView = 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom' | 'iso' | 'iso_back' | 'home';
/**
 * Options of a camera call. `auto`: the app's own move (sketch entry's Normal to, the turn to
 * Isometric of a new extrude, a refit, a Part's camera put back), not the person's:
 * userCameraMoves() does not count it.
 */
export interface CameraCallOpts {
  auto?: boolean;
}
export type DisplayMode = 'shaded-edges' | 'shaded' | 'wireframe';
export type Projection = 'perspective' | 'orthographic';
/** Origin planes: 'auto' draws them on an empty part and while one is selected or hovered; 'always' draws them all the time. */
export type PlanesMode = 'auto' | 'always';

/**
 * Section view: a clipping plane parallel to a plane (an origin plane, a construction plane or a flat
 * face), with capped cuts. A view state: never a feature, never undone; the Part keeps it in its
 * view (CadView.section, src/features/section).
 */
export interface SectionState {
  on: boolean;
  /** The plane the cut is parallel to (src/types/references.ts PlaneRef). */
  plane: PlaneRef;
  /**
   * That plane where it is now (model mm): the cut is `offset` along `frame.normal` from
   * `frame.origin`. An origin plane's is its own; a construction plane's or a face's is found by
   * src/features/section (it follows the plane when an edit moves it).
   */
  frame: PlaneFrame;
  /** Distance of the cut from the plane along its normal (mm). */
  offset: number;
  /** Keep the other side. */
  flip: boolean;
}

/** A cut as a picture takes it: an origin plane by its word, or any plane by its frame; `offset` mm along its normal, `flip` keeps the other side. */
export type SnapshotSection = { plane: 'top' | 'front' | 'right'; offset: number; flip: boolean } | { frame: { origin: Vec3; normal: Vec3 }; offset: number; flip: boolean };

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

/**
 * P4b SELECT: a box drawn by a Ctrl + left drag (model mode; Ctrl+Shift adds): left to right encloses
 * (solid box), right to left touches (dashed box). `items` are what it found (visible items only,
 * of the kinds the selection filter allows: edges with no filter); `combine` says how they go into
 * the selection (Shift adds, Ctrl toggles).
 */
export interface BoxSelectEvent {
  items: SelectionItem[];
  mode: 'enclose' | 'touch';
  combine: 'replace' | 'add' | 'toggle';
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
  /** P4b SELECT: time of the last box selection (ms: the GPU id pass and the enclose tests). */
  lastBoxMs?: number;
  /** BVH build per body (ms, in the worker or on the main thread). */
  bvh: Record<BodyId, { ms: number; worker: boolean }>;
  triangles: number;
  drawCalls: number;
  /** The WebGL context is lost (nothing draws; snapshot throws not_ready). */
  contextLost?: boolean;
  /** The camera is where the last framing put it: nobody orbited, panned or zoomed since. */
  framed?: boolean;
  /**
   * What the view's frames on screen were drawn in, from its very first: the palette (its name)
   * and the clear colour, one entry per change with the frame it starts at (the first 64 changes;
   * pictures, drawn off screen, are not frames). A view dark from its start has one dark entry at
   * frame 0 (e2e cad:dark-first-paint).
   */
  looks?: { frame: number; palette: MarkPalette['name']; background: number }[];
  /** Each body's surface opacity as it is drawn now: 1 opaque, less see-through (materials.ts SEE_THROUGH_OPACITY). */
  opacity?: Record<BodyId, number>;
}

/** Directions of ViewportHandle.snapshot: the standard views but Home, and iso from back-left-top. */
export type SnapshotView = 'iso' | 'iso_back' | 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom';

/** A picture of the Part drawn off screen (ViewportHandle.snapshot). */
export interface SnapshotOptions {
  view: SnapshotView;
  /** The picture's size in pixels (1 to 4096 each, at most what the GPU draws). */
  width: number;
  height: number;
  /** Bodies left out of the picture (the view keeps showing them). */
  hide: BodyId[];
  /** A cut as the section view makes it (SnapshotSection), or null. */
  section: SnapshotSection | null;
  /** How the bodies are drawn in the picture (default 'shaded-edges'; the view's own display is never touched). */
  display?: DisplayMode;
  /** The picture's projection (default 'orthographic'; perspective: mmPerPx holds at the framed centre only). */
  projection?: Projection;
  /** Look along this instead of from `view` (the view tool's sketch): `dir` from the part towards the camera (unit), `up` the picture's up. */
  along?: { dir: Vec3; up: Vec3 };
  /** Frame this box (model mm) instead of the shown bodies (a sketch's curves). */
  fit?: { min: Vec3; max: Vec3 };
  /** A sketch drawn in the picture over the bodies, shown in the view or not (the layers' `plain` hook gets it). */
  sketch?: FeatureId;
}

/** What a snapshot tells the layers' `plain` hook as it starts: the sketch it pictures (SnapshotOptions.sketch), or null. */
export interface SnapshotPicture {
  sketch: FeatureId | null;
}

export interface SnapshotResult {
  /** RGBA, rows top to bottom, width x height x 4 bytes. */
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  /** Model mm per picture pixel (the picture is orthographic). */
  mmPerPx: number;
  /** Where a model point is in the picture (px, y down), or null when it is outside the picture's depth. */
  project(p: Vec3): [number, number] | null;
  /** The face of `body` seen at picture pixel (x, y), or null (another body, the cut's cap or nothing in front). */
  visibleFaceAt(body: BodyId, x: number, y: number): number | null;
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
  /**
   * Replace the bodies drawn. A body whose tessKey is unchanged keeps its GPU mesh and picking
   * structure. `frame: false`: the view frames nothing for them (the first bodies, a size change,
   * bodies past a framed view): an Assistant step's bodies once the person moved the camera
   * during its request, or while the window is hidden.
   */
  setBodies(bodies: ViewportBody[], o?: { frame?: boolean }): void;
  /** Show or hide one body now (the next setBodies carries the document's value again). */
  setVisibility(id: BodyId, visible: boolean): void;
  /** B-rep vertex positions for a body (kernel order), when they arrive after its tessellation. */
  setVertices(id: BodyId, tessKey: string, vertices: Float32Array): void;
  /**
   * Draw these bodies moved by a rigid motion (3x4 row-major, as the kernel's `copies` takes it;
   * null: where they are built), with no rebuild: a drag handle's preview (Move/copy body's).
   * Their faces and edges move; picking, framing, the section's caps and the highlight of picked
   * edges keep the bodies as built. A body drawn anew (a new tessKey) starts unmoved.
   */
  previewMotion?(ids: readonly BodyId[], matrix: readonly number[] | null): void;
  /** The box of a body as the view draws it now (a preview's motion included), or null (tests). */
  drawnBox?(id: BodyId): FrameBox | null;
  /** Show these items as selected (faces/edges/vertices in pick green, bodies in the core's body blue, planes). */
  highlight(items: SelectionItem[]): void;
  /** Temporary hover highlight for hover in lists (the selection list hovers a face); [] clears it. */
  flash(items: SelectionItem[]): void;
  /** Which kinds a click may pick. Empty = faces, edges, vertices and planes (a click on a face never picks the whole body). */
  setFilter(kinds: SelectKind[]): void;
  /** Clicks, right-clicks (context menu) and double-clicks with what is under the pointer. Returns unsubscribe. */
  onPick(fn: (e: ViewportPickEvent) => void): () => void;
  /** P4b SELECT: box selections (a Ctrl + left drag, anywhere). Returns unsubscribe. */
  onBoxSelect?(fn: (e: BoxSelectEvent) => void): () => void;
  /** P4b SELECT: what a box over these frame client coordinates selects now (tests, timing). */
  boxSelect?(rect: { x0: number; y0: number; x1: number; y1: number }, mode: 'enclose' | 'touch', kinds?: ('face' | 'edge' | 'vertex' | 'body')[]): SelectionItem[];
  /**
   * Frame the visible bodies and the shown sketches (the origin planes when there are neither),
   * keeping the view direction. Bodies the rollback hides never count.
   * Framing (fit, setView, lookAt) centres the part in what floating panels leave free: elements
   * marked [data-view-cover] over the left of the view. Until the user orbits, pans or zooms,
   * bodies that grow out of the framed view are framed again.
   * Every camera call here without `auto` (CameraCallOpts) is the person's: userCameraMoves() counts it.
   */
  fit(opts?: { animate?: boolean } & CameraCallOpts): void;
  setView(view: StandardView, opts?: { animate?: boolean } & CameraCallOpts): void;
  /** Turn the camera to look straight at a plane (Normal To / sketch entry), framing the shown part. `normal` points at the viewer. */
  lookAt(normal: Vec3, up?: Vec3, opts?: { animate?: boolean } & CameraCallOpts): void;
  setDisplay(mode: DisplayMode): void;
  setProjection(p: Projection): void;
  /**
   * Change the section view. A new origin plane brings its own frame; a construction plane or a
   * face needs its `frame` in the same patch (src/features/section finds it), else it throws.
   */
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
  /** Range of the section offset along a plane's normal (from the frame's origin) that cuts the visible bodies (mm), or null without bodies. */
  sectionRange(frame: Pick<PlaneFrame, 'origin' | 'normal'>): [number, number] | null;
  /** Pick at frame client coordinates, respecting the selection filter. */
  pick(clientX: number, clientY: number): PickResult | null;
  /** P4b SELECT: pick these kinds of body geometry (no planes) at frame client coordinates, whatever the selection filter. */
  pickKinds?(clientX: number, clientY: number, kinds: SelectKind[]): PickResult | null;
  /** Model point to frame client coordinates (null when behind the camera). For manipulators and tests. */
  project(p: Vec3): [number, number] | null;
  /** The normal of a planar face or an origin plane (pointing out of the material), or null when it is not planar. */
  planeNormal(item: SelectionItem): Vec3 | null;
  /**
   * Orbit about this point from now on (the core's "Orbit around this point /
   * model center / origin"); 'center' is the middle of the visible bodies.
   * The next change of the geometry puts the pivot back on the part.
   */
  orbitAround(target: Vec3 | 'center', opts?: CameraCallOpts): void;
  /** The point the camera orbits about (for tests). */
  orbitPivot(): Vec3;
  /** Where the camera is now (position, target, up, projection), as a Part keeps it. */
  camera(): SavedCamera;
  /** Put the camera where a Part kept it (no transition; nothing is reported to onCameraChange). */
  setCamera(camera: SavedCamera, opts?: CameraCallOpts): void;
  /**
   * How many times the person has moved the camera since the viewport was made: each call of this
   * handle's fit, setView, lookAt, orbitAround or setCamera without `auto` (Fit, the standard
   * views, Normal to, F, 1-7, N, Orbit around), each reframe or refitIfOffScreen without `auto`
   * that moved the camera, each orbit, pan or zoom drag (once per drag) and each wheel step. The app's own
   * moves pass `auto` and are not counted, nor is the viewport's own framing of new bodies, nor a
   * snapshot. The Assistant's camera latch compares it before and after (counts, not frames).
   */
  userCameraMoves?(): number;
  /**
   * A picture of the Part drawn off screen in this task (no animation frame needed): an
   * orthographic camera of its own framing the shown bodies (`hide` left out) from `view` (or the
   * box `fit` along `along`: a sketch's curves, that sketch drawn over the bodies), with
   * the sketches and reference planes but no manipulators, markers, bananas, selection, hover or
   * flash, an optional cut of its own, and the triad in a corner. The person's camera, framing,
   * section view, highlight and saved view are never touched, userCameraMoves() does not change,
   * and nothing is written. Throws an Error with code 'not_ready' when the WebGL context is lost.
   * HTML overlays (dimension values, plane labels) are not in the picture. Layers that colour by
   * the selection or hover draw plain through addLayer's `plain` (the profile regions, the
   * reference geometry); sketch mode's own layers do not: in a picture taken while a sketch is
   * edited, that sketch's selection, hover halo and a tool's preview show as on screen.
   * A picture is LIGHT whatever the host's theme (palette.ts): its background, the edges, the
   * triad and every layer it shows with a `palette` hook (sketch mode's too) are drawn in LIGHT's
   * colours, swapped and put back in this task, so the view never shows a light frame.
   */
  snapshot?(o: SnapshotOptions): SnapshotResult;
  /**
   * The user moved the camera (orbit, pan, zoom, Fit, a standard view, Normal
   * to, the projection) and it has come to rest. Not called for the viewport's
   * own framing of a part's first bodies. Returns unsubscribe.
   */
  onCameraChange(fn: (camera: SavedCamera) => void): () => void;
  stats(): ViewportStats;
  /**
   * The colours the view draws its marks in now (src/viewport/palette.ts: LIGHT, or a dark
   * palette with the host's dark theme). Layers build their materials from it; without it (a test
   * fake) they draw LIGHT (paletteOf).
   */
  palette?(): MarkPalette;
  /**
   * Draw the marks in this palette from now on (app/appearance.ts, from the host's theme): the
   * background, the edges, the triad, and each layer through its `palette` hook, without a
   * rebuild; the next frame shows it. Surfaces keep their colours (D2). With a dark palette the
   * layers' marks that say so (src/viewport/onface.ts) take their light inks where a light surface
   * shows under them (E2). A palette that draws the same as the live one changes nothing.
   */
  setPalette?(p: MarkPalette): void;
  /**
   * Whether the view shows a light surface at this point (client px): an opaque body face of a
   * light colour, or a section cap (E2's rule for the marks, src/viewport/onface.ts
   * isLightSurface). One BVH ray, as picking (a body still without one counts as none). Sketch
   * mode's cursors take the light tone there in a dark view.
   */
  lightSurfaceAt?(clientX: number, clientY: number): boolean;
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
   * together; the origin planes' extent only when neither is drawn. `plain`: called with true
   * just before a snapshot draws and with false right after it (both in that task): the layer
   * then draws without its selection, hover and flash colours, synchronously, and puts them back;
   * with true it also gets the picture (the sketch it pictures: drawn whether shown or not).
   * `palette`: called with the new palette on every setPalette, and, while a dark palette is
   * live, with LIGHT just before a snapshot draws and with the live one right after it (a layer a
   * picture leaves out, SNAPSHOT_HIDDEN_LAYERS, is not called for it). The layer recolours what it
   * draws then, synchronously (material colours, or its lines drawn again). Never called when the
   * layer is added: a layer builds its materials from palette() (paletteOf).
   */
  addLayer(id: string, opts?: { order?: number; frame?: boolean | (() => FrameBox | null); plain?: (on: boolean, picture?: SnapshotPicture) => void; palette?: (p: MarkPalette) => void }): OverlayLayer;
  /**
   * The last framing (Fit, a standard view, Look at) again, with what is drawn now, when the
   * camera is still where that framing put it (nobody orbited, panned or zoomed since). A
   * reopened sketch calls it once its rebuild has rolled the later bodies back (review P2/P3
   * round 4: the view stayed on bodies the rollback hid). False when the camera was moved; true
   * also when nothing changed and the camera stays where it is (then not a move: not counted by
   * userCameraMoves, nothing reported to onCameraChange).
   */
  reframe(opts?: CameraCallOpts): boolean;
  /**
   * Fit (keeping the direction) when what is drawn now (bodies and shown sketches) reaches off the
   * screen and nobody has orbited, panned or zoomed since the last framing; true when it did. Sketch
   * mode's end calls it (P4a review: a first large sketch stayed half off-screen after Finish).
   */
  refitIfOffScreen?(opts?: CameraCallOpts): boolean;
  /**
   * Whether any of these model points is off the part of the view the floating panels leave free
   * ([data-view-cover] over its left), with the camera where it is now (mid-transition too: ask
   * once it rests). Sketch mode's Import SVG/DXF asks it of the drawing it previews, and fits
   * (its preview counting: the tool's frameUv) when the drawing does not all show.
   */
  offView?(points: readonly Vec3[]): boolean;
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
