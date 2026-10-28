// The view tool's pictures (CAD tools spec §3.2.4, §9.2): the Part drawn off screen by the
// viewport (ViewportHandle.snapshot: its own orthographic camera, so the person's camera, saved
// view, section view and count of camera moves never change), one picture per direction asked,
// put together into one image:
//   - one view fills the picture; 2 to 4 make a 2 x 2 sheet with each tile's name in its corner;
//     the long side is 768 px (small) or 1280 px (large; a local turn always gets small);
//   - labels 'bodies' writes each shown body's name at its box's centre; 'faces' writes a handle
//     ("#f3") on each of the 30 largest faces as the picture shows them, only where the picture
//     really sees that face there, and lists the handles with their words;
//   - PNG, or JPEG (quality 0.85) when the PNG is over 1.4 MB.
// The data says what was drawn and what not, the scale, the cut, the values of the shown
// sketches' dimensions (pictures carry no HTML overlays), whether a software renderer drew it,
// and a note when the picture is not the whole Part (the person's sketch or the rollback bar
// rolls later features back) or the window is hidden. A turn whose model reads no images gets
// not_ready no_images, and no picture is drawn.
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { Vector3 } from 'three';
import { pickFace } from '../features/p2/refs';
import { drawnSketches, profilesView } from '../features/sketch/view';
import { describeFace } from '../naming/names';
import { evaluateDimensions, isDimension, quantityOf } from '../sketch/model';
import type { AppServices } from '../types/app';
import type { CallCtx, ToolReply } from '../types/assistant';
import type { BodyId, Vec3 } from '../types/doc';
import type { DocState } from '../types/doc-service';
import type { BodyInfo } from '../types/kernel';
import type { EvalResult } from '../types/units';
import type { DisplayMode, Projection, SnapshotOptions, SnapshotResult, SnapshotView, ViewportHandle } from '../types/viewport';
import { LIGHT } from '../viewport/palette';
import { SNAPSHOT_DIRS, snapshotClip } from '../viewport/snapshot';
import { heartbeat, waitForRead } from './busy';
import { ToolError } from './errors';
import { faceWords, LabelIndex } from './labels';
import { len, sig6 } from './numbers';
import { VIEW_DIRECTIONS } from './schemas';
import { handlesOf } from './selectors/handles';

/** The picture's long side (px) by size; its short side is 3/4 of it. */
export const SHEET_LONG_PX = Object.freeze({ small: 768, large: 1280 });
export const SHEET_ASPECT = 0.75;
/** The most faces labelled in one picture. */
export const FACE_LABELS_MAX = 30;
/** A face smaller than this in the picture (px²), or with no room for a label, gets none. */
export const FACE_MIN_PX2 = 150;
export const FACE_MIN_INRADIUS_PX = 4;
/** Faces are labelled only on pictures of at most this many triangles in all (else the note says so). */
export const LABEL_TRIANGLES_MAX = 600_000;
/** A PNG over this many bytes goes as a JPEG of this quality instead (the app takes at most 1.5 MB). */
export const JPEG_ABOVE_BYTES = 1.4 * 1024 * 1024;
export const JPEG_QUALITY = 0.85;
/** The shown sketches' dimension values listed (the rest counted). */
export const DIMENSIONS_MAX = 40;
/** Body names listed (shown, hidden in the tree) and bodies labelled; the rest counted. */
export const BODY_NAMES_MAX = 100;
/** The text size of names and handles on the picture (px), by size. */
export const LABEL_FONT_PX = Object.freeze({ small: 13, large: 18 });

export type ViewLabels = 'none' | 'bodies' | 'faces';
export type ViewSize = 'small' | 'large';

export interface ViewInput {
  views: SnapshotView[];
  hide: string[];
  section: string;
  labels: ViewLabels;
  size: ViewSize;
  /** How the bodies are drawn (the input's shaded_edges is the viewport's shaded-edges). */
  display: DisplayMode;
  projection: Projection;
}

const LABELS: readonly ViewLabels[] = ['none', 'bodies', 'faces'];
const SIZES: readonly ViewSize[] = ['small', 'large'];
const DISPLAYS: Readonly<Record<string, DisplayMode>> = { shaded_edges: 'shaded-edges', shaded: 'shaded', wireframe: 'wireframe' };
const PROJECTIONS: readonly Projection[] = ['orthographic', 'perspective'];

/** The tool's input checked (the app checks it against the schema first; this is what the page relies on). */
export function readViewInput(input: Record<string, unknown>): ViewInput {
  const bad = (field: string, message: string) => new ToolError('bad_input', message, { detail: { field } });
  const raw = input.views;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 4) throw bad('views', 'views must list 1 to 4 directions.');
  const views: SnapshotView[] = [];
  raw.forEach((v, i) => {
    if (typeof v !== 'string' || !(VIEW_DIRECTIONS as readonly string[]).includes(v)) throw bad(`views[${i}]`, `views[${i}] must be one of ${VIEW_DIRECTIONS.join(', ')}.`);
    if (!views.includes(v as SnapshotView)) views.push(v as SnapshotView);
  });
  const hide = input.hide ?? [];
  if (!Array.isArray(hide) || hide.length > 32 || hide.some((h) => typeof h !== 'string')) throw bad('hide', 'hide must list at most 32 body names.');
  const section = input.section ?? '';
  if (typeof section !== 'string') throw bad('section', 'section must be "" or "<Top|Front|Right> [offset <length> | middle] [flip]".');
  const labels = input.labels ?? 'none';
  if (!LABELS.includes(labels as ViewLabels)) throw bad('labels', `labels must be one of ${LABELS.join(', ')}.`);
  const size = input.size ?? 'small';
  if (!SIZES.includes(size as ViewSize)) throw bad('size', 'size must be small or large.');
  // Absent (an older caller): shaded with edges, orthographic, as the pictures always were.
  const display = DISPLAYS[String(input.display ?? 'shaded_edges')];
  if (!display) throw bad('display', 'display must be shaded_edges, shaded or wireframe.');
  const projection = (input.projection ?? 'orthographic') as Projection;
  if (!PROJECTIONS.includes(projection)) throw bad('projection', 'projection must be orthographic or perspective.');
  return { views, hide: hide as string[], section, labels: labels as ViewLabels, size: size as ViewSize, display, projection };
}

// ------------------------------------------------------------ the cut

export type SectionPlane = 'top' | 'front' | 'right';

/**
 * A cut parallel to an origin plane, as the snapshot takes it: `offset` mm along the plane's normal.
 * `middle`: asked as "<plane> middle", the offset is the middle of the shown bodies' box along that
 * normal (sectionAtMiddle), 0 until it is known.
 */
export interface SectionChoice {
  plane: SectionPlane;
  offset: number;
  flip: boolean;
  middle?: true;
}

const PLANE_WORDS: Readonly<Record<string, SectionPlane>> = { top: 'top', xy: 'top', front: 'front', xz: 'front', right: 'right', yz: 'right' };
const PLANE_NAMES: Readonly<Record<SectionPlane, string>> = { top: 'Top', front: 'Front', right: 'Right' };
/** The axis of each plane's normal and its sign (Front's normal points at -Y: ORIGIN_PLANES). */
const PLANE_AXIS: Readonly<Record<SectionPlane, { axis: 'x' | 'y' | 'z'; sign: 1 | -1 }>> = { top: { axis: 'z', sign: 1 }, front: { axis: 'y', sign: -1 }, right: { axis: 'x', sign: 1 } };

const SECTION_FORM = '"" or "<Top|Front|Right> [offset <length> | middle] [flip]"';

/** `section` read: null for "", else the cut; bad_section in words when it is neither. */
export function parseSection(text: string, evaluate: (expr: string) => EvalResult): SectionChoice | null {
  const t = text.trim();
  if (!t) return null;
  const m = /^(\S+)(?:\s+offset\s+(.+?)|\s+(middle))?(\s+flip)?$/i.exec(t);
  const plane = m ? PLANE_WORDS[m[1].toLowerCase()] : undefined;
  if (!m || !plane) throw new ToolError('bad_section', `"${t}" is not a section: write ${SECTION_FORM}.`, { detail: { section: t } });
  let offset = 0;
  if (m[2] !== undefined) {
    const r = evaluate(m[2]);
    if (!r.ok) throw new ToolError('bad_section', `The offset "${m[2]}" of "${t}" is not a length: ${r.error}`, { detail: { section: t, field: 'offset' } });
    offset = r.value;
  }
  return { plane, offset, flip: !!m[4], ...(m[3] ? { middle: true as const } : {}) };
}

/**
 * A "<plane> middle" cut at the middle of `boxes` (the shown bodies' [xmin, ymin, zmin, xmax, ymax,
 * zmax]) along the plane's normal; any other cut as it is. No box: through the origin.
 */
export function sectionAtMiddle(c: SectionChoice | null, boxes: readonly (readonly number[])[]): SectionChoice | null {
  if (!c || !c.middle) return c;
  const { axis, sign } = PLANE_AXIS[c.plane];
  const i = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
  const ok = boxes.filter((b) => b.length >= 6 && Number.isFinite(b[i]) && Number.isFinite(b[i + 3]));
  if (!ok.length) return { ...c, offset: 0 };
  const lo = Math.min(...ok.map((b) => b[i]));
  const hi = Math.max(...ok.map((b) => b[i + 3]));
  // The offset is along the plane's normal: Front's points at -Y.
  return { ...c, offset: (sign * (lo + hi)) / 2 };
}

/** What a cut keeps, in model words ("z <= 4 mm", "y >= -10 mm"). */
export function keepsWords(c: SectionChoice): string {
  const { axis, sign } = PLANE_AXIS[c.plane];
  // Unflipped, the side away from the plane's normal stays (sectionPlane): sign*coord <= offset.
  const below = (sign === 1) !== c.flip;
  return `${axis} ${below ? '<=' : '>='} ${len(sign * c.offset)} mm`;
}

/** The cut as the data gives it. */
export function sectionData(c: SectionChoice | null): Record<string, unknown> | null {
  return c ? { plane: PLANE_NAMES[c.plane], offset_mm: len(c.offset), flip: c.flip, ...(c.middle ? { middle: true } : {}), keeps: keepsWords(c) } : null;
}

// ------------------------------------------------------------ the sheet

export interface Tile {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SheetLayout {
  width: number;
  height: number;
  /** One per view, in the order asked (a sheet has 4 places; the ones no view takes stay empty). */
  tiles: Tile[];
  sheet: boolean;
}

/** One view: the whole picture; 2 to 4: a 2 x 2 sheet, left to right, then top to bottom. */
export function sheetLayout(views: number, longSide: number): SheetLayout {
  const width = Math.round(longSide);
  const height = Math.round(longSide * SHEET_ASPECT);
  if (views <= 1) return { width, height, tiles: [{ x: 0, y: 0, w: width, h: height }], sheet: false };
  const w = Math.floor(width / 2);
  const h = Math.floor(height / 2);
  const tiles: Tile[] = [];
  for (let i = 0; i < Math.min(4, views); i++) tiles.push({ x: (i % 2) * (width - w), y: Math.floor(i / 2) * (height - h), w, h });
  return { width, height, tiles, sheet: true };
}

const rgbOf = (hex: number): [number, number, number] => [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
/** The line between a sheet's tiles. */
export const SEPARATOR = 0xb9c0cc;

/**
 * The pictures put into one image (RGBA, rows top to bottom): the light view's background (a
 * picture is light whatever the host's theme, as each tile is), each tile, the lines between.
 */
export function composeSheet(layout: SheetLayout, shots: readonly Pick<SnapshotResult, 'rgba' | 'width' | 'height'>[]): Uint8ClampedArray {
  const { width: W, height: H } = layout;
  const out = new Uint8ClampedArray(W * H * 4);
  const [br, bg, bb] = rgbOf(LIGHT.background);
  for (let i = 0; i < out.length; i += 4) {
    out[i] = br;
    out[i + 1] = bg;
    out[i + 2] = bb;
    out[i + 3] = 255;
  }
  shots.forEach((s, i) => {
    const t = layout.tiles[i];
    if (!t) return;
    const w = Math.min(t.w, s.width);
    const h = Math.min(t.h, s.height);
    for (let y = 0; y < h; y++) out.set(s.rgba.subarray(y * s.width * 4, (y * s.width + w) * 4), ((t.y + y) * W + t.x) * 4);
  });
  if (layout.sheet) {
    const [sr, sg, sb] = rgbOf(SEPARATOR);
    const put = (x: number, y: number) => {
      const k = (y * W + x) * 4;
      out[k] = sr;
      out[k + 1] = sg;
      out[k + 2] = sb;
      out[k + 3] = 255;
    };
    const mx = Math.floor(W / 2);
    const my = Math.floor(H / 2);
    for (let y = 0; y < H; y++) for (const x of [mx - 1, mx]) put(x, y);
    for (let x = 0; x < W; x++) for (const y of [my - 1, my]) put(x, y);
  }
  return out;
}

// ------------------------------------------------------------ where the labels go

/** One face as one picture shows it: its area there, and the point a label goes (in the picture and in the model). */
export interface FaceSpot {
  body: BodyId;
  face: number;
  /** Its area in the picture (px²), the parts facing the camera and kept by the cut. */
  area: number;
  /** Where its label goes (picture px). */
  at: [number, number];
  /** That point in the model (mm): on the face, or inside the body behind it for a curved face's middle. */
  point: Vec3;
}

/** The roomiest triangles of a face tried for its label, after the middle of its area. */
const LABEL_TRIES = 5;

/**
 * The faces of `body` as `shot` shows them, largest first: the area of each face's triangles that
 * face the camera (`toCamera`, from the part towards the camera) and that the cut keeps, and where
 * its label goes: the middle of that area, else the incentre of one of its roomiest triangles,
 * the first such point where the picture sees that very face (visibleFaceAt). A face with no such
 * point, or with no room for a label (FACE_MIN_PX2, FACE_MIN_INRADIUS_PX), is left out.
 */
export function faceSpots(
  body: Pick<BodyInfo, 'id' | 'tess'>,
  shot: Pick<SnapshotResult, 'project' | 'visibleFaceAt' | 'width' | 'height'>,
  toCamera: Vec3,
  keep: ((p: Vec3) => boolean) | null = null,
): FaceSpot[] {
  const t = body.tess;
  if (!t) return [];
  const P = t.positions;
  const N = t.normals;
  const I = t.indices;
  const R = t.faceRanges;
  const nv = Math.floor(P.length / 3);
  const sx = new Float64Array(nv);
  const sy = new Float64Array(nv);
  // 0: not projected yet, 1: in the picture's depth, 2: not.
  const seen = new Uint8Array(nv);
  const projected = (v: number) => {
    if (!seen[v]) {
      const s = shot.project([P[3 * v], P[3 * v + 1], P[3 * v + 2]]);
      if (s) {
        sx[v] = s[0];
        sy[v] = s[1];
        seen[v] = 1;
      } else seen[v] = 2;
    }
    return seen[v] === 1;
  };
  const inPicture = (at: readonly number[]) => at[0] >= 0 && at[1] >= 0 && at[0] < shot.width && at[1] < shot.height;
  const [dx, dy, dz] = toCamera;
  const out: FaceSpot[] = [];
  const faces = Math.floor(R.length / 2);
  for (let k = 0; k < faces; k++) {
    const start = R[2 * k];
    const end = Math.min(start + R[2 * k + 1], I.length);
    let area = 0;
    // The area's middle (picture) and its triangles' centroids weighed alike (model).
    let cx = 0;
    let cy = 0;
    const cm = [0, 0, 0];
    const rooms: { r: number; at: [number, number]; point: Vec3 }[] = [];
    for (let i = start; i + 2 < end; i += 3) {
      const a = I[i];
      const b = I[i + 1];
      const c = I[i + 2];
      const nx = N[3 * a] + N[3 * b] + N[3 * c];
      const ny = N[3 * a + 1] + N[3 * b + 1] + N[3 * c + 1];
      const nz = N[3 * a + 2] + N[3 * b + 2] + N[3 * c + 2];
      // Facing the camera (the three normals' mean, at more than about 3 degrees off edge-on).
      if (nx * dx + ny * dy + nz * dz <= 0.15) continue;
      if (!projected(a) || !projected(b) || !projected(c)) continue;
      const area2 = Math.abs((sx[b] - sx[a]) * (sy[c] - sy[a]) - (sy[b] - sy[a]) * (sx[c] - sx[a])) / 2;
      if (!(area2 > 1e-9)) continue;
      const centroid: Vec3 = [0, 1, 2].map((j) => (P[3 * a + j] + P[3 * b + j] + P[3 * c + j]) / 3) as Vec3;
      if (keep && !keep(centroid)) continue;
      area += area2;
      cx += (area2 * (sx[a] + sx[b] + sx[c])) / 3;
      cy += (area2 * (sy[a] + sy[b] + sy[c])) / 3;
      for (let j = 0; j < 3; j++) cm[j] += area2 * centroid[j];
      const la = Math.hypot(sx[c] - sx[b], sy[c] - sy[b]);
      const lb = Math.hypot(sx[c] - sx[a], sy[c] - sy[a]);
      const lc = Math.hypot(sx[b] - sx[a], sy[b] - sy[a]);
      const per = la + lb + lc;
      const r = (2 * area2) / per;
      if (r < FACE_MIN_INRADIUS_PX || (rooms.length >= LABEL_TRIES && r <= rooms[rooms.length - 1].r)) continue;
      // The incentre (the side lengths in the picture weigh the corners; the projection is affine).
      const [wa, wb, wc] = [la / per, lb / per, lc / per];
      rooms.push({ r, at: [wa * sx[a] + wb * sx[b] + wc * sx[c], wa * sy[a] + wb * sy[b] + wc * sy[c]], point: [0, 1, 2].map((j) => wa * P[3 * a + j] + wb * P[3 * b + j] + wc * P[3 * c + j]) as Vec3 });
      rooms.sort((x, y) => y.r - x.r);
      if (rooms.length > LABEL_TRIES) rooms.length = LABEL_TRIES;
    }
    if (area < FACE_MIN_PX2 || !rooms.length) continue;
    const middle = { at: [cx / area, cy / area] as [number, number], point: cm.map((v) => v / area) as Vec3 };
    const spot = [middle, ...rooms].find((p) => (!keep || keep(p.point)) && inPicture(p.at) && shot.visibleFaceAt(body.id, p.at[0], p.at[1]) === k);
    if (spot) out.push({ body: body.id, face: k, area, at: spot.at, point: spot.point });
  }
  return out.sort((x, y) => y.area - x.area);
}

/** A label on the picture: its box in sheet px, its text, and what it is. */
export interface Mark {
  kind: 'title' | 'body' | 'face';
  tile: number;
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A label's box for `text` (the width estimated from the font, so placing never needs a canvas). */
export function boxOf(text: string, font: number): { w: number; h: number } {
  return { w: Math.ceil(text.length * font * 0.6) + 8, h: font + 6 };
}

/** The box centred on `at` (tile px), kept inside the tile, in sheet px. */
export function placeIn(tile: Tile, at: readonly [number, number], box: { w: number; h: number }): { x: number; y: number } {
  const x = Math.min(Math.max(tile.x + at[0] - box.w / 2, tile.x + 1), tile.x + tile.w - box.w - 1);
  const y = Math.min(Math.max(tile.y + at[1] - box.h / 2, tile.y + 1), tile.y + tile.h - box.h - 1);
  return { x: Math.round(x), y: Math.round(y) };
}

const overlaps = (a: Pick<Mark, 'x' | 'y' | 'w' | 'h'>, b: Pick<Mark, 'x' | 'y' | 'w' | 'h'>) => a.x < b.x + b.w + 2 && b.x < a.x + a.w + 2 && a.y < b.y + b.h + 2 && b.y < a.y + a.h + 2;

/** Each tile's name in its top-left corner (a sheet only). */
export function titleMarks(layout: SheetLayout, views: readonly SnapshotView[], font: number): Mark[] {
  if (!layout.sheet) return [];
  return views.map((v, i) => {
    const t = layout.tiles[i];
    const box = boxOf(v, font);
    return { kind: 'title', tile: i, text: v, x: t.x + 4, y: t.y + 4, ...box };
  });
}

/** Add `mark` unless it overlaps one already on its tile; true when added. */
export function addMark(marks: Mark[], mark: Mark): boolean {
  if (marks.some((m) => m.tile === mark.tile && overlaps(m, mark))) return false;
  marks.push(mark);
  return true;
}

// ------------------------------------------------------------ drawing and encoding

/** The 2D drawing the labels need (an OffscreenCanvas's context, or a page canvas's). */
export interface Ctx2D {
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  createImageData(width: number, height: number): ImageData;
  putImageData(data: ImageData, x: number, y: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  strokeRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number): void;
}

export interface RasterCanvas {
  getContext(kind: '2d'): Ctx2D | null;
  convertToBlob(o: { type: string; quality?: number }): Promise<Blob>;
}

/** A canvas of w x h to draw the picture on and encode it. */
export type Raster = (width: number, height: number) => RasterCanvas;

/** OffscreenCanvas (also in a sandboxed frame), else a page canvas. */
export const browserRaster: Raster = (width, height) => {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height) as unknown as RasterCanvas;
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  return {
    getContext: (kind) => c.getContext(kind) as unknown as Ctx2D | null,
    convertToBlob: (o) => new Promise<Blob>((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('The picture could not be encoded.'))), o.type, o.quality)),
  };
};

let raster: Raster = browserRaster;

/** Tests draw on a canvas of their own (jsdom has none); null puts the browser's back. */
export function setViewRaster(r: Raster | null): void {
  raster = r ?? browserRaster;
}

const MARK_STYLE: Readonly<Record<Mark['kind'], { fill: string; stroke: string; text: string }>> = {
  title: { fill: 'rgba(255,255,255,0.9)', stroke: '#8a93a3', text: '#1d2330' },
  body: { fill: 'rgba(255,255,255,0.92)', stroke: '#3c4454', text: '#1d2330' },
  face: { fill: 'rgba(255,244,196,0.95)', stroke: '#7a5c00', text: '#2a2100' },
};

/** The picture as an image the app takes: PNG, or a JPEG when the PNG is over JPEG_ABOVE_BYTES. */
export async function encodePicture(rgba: Uint8ClampedArray, width: number, height: number, marks: readonly Mark[], font: number, r: Raster = raster): Promise<{ mediaType: 'image/png' | 'image/jpeg'; data: Blob }> {
  const canvas = r(width, height);
  const g = canvas.getContext('2d');
  if (!g) throw new ToolError('no_viewport', 'This page cannot draw pictures (it has no 2D canvas).');
  const img = g.createImageData(width, height);
  img.data.set(rgba);
  g.putImageData(img, 0, 0);
  g.font = `600 ${font}px system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineWidth = 1;
  for (const m of marks) {
    const st = MARK_STYLE[m.kind];
    g.fillStyle = st.fill;
    g.fillRect(m.x, m.y, m.w, m.h);
    g.strokeStyle = st.stroke;
    g.strokeRect(m.x + 0.5, m.y + 0.5, m.w - 1, m.h - 1);
    g.fillStyle = st.text;
    g.fillText(m.text, m.x + m.w / 2, m.y + m.h / 2 + 0.5);
  }
  const png = await canvas.convertToBlob({ type: 'image/png' });
  if (png.size <= JPEG_ABOVE_BYTES) return { mediaType: 'image/png', data: png };
  return { mediaType: 'image/jpeg', data: await canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY }) };
}

let renderer: { known: boolean; software: boolean | null } = { known: false, software: null };

/** Whether the viewport draws with a software renderer (SwiftShader, llvmpipe, WARP), or null when it cannot say. */
export function softwareRenderer(doc: Document | null = typeof document !== 'undefined' ? document : null): boolean | null {
  if (renderer.known) return renderer.software;
  let software: boolean | null = null;
  try {
    // The viewport's own canvas gives back its own context (no new one is made).
    const canvas = doc?.querySelector<HTMLCanvasElement>('canvas[data-cad-canvas]') ?? null;
    const gl = (canvas?.getContext('webgl2') ?? null) as WebGL2RenderingContext | null;
    if (gl) {
      const info = gl.getExtension('WEBGL_debug_renderer_info');
      const name = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? '');
      software = /swiftshader|llvmpipe|softpipe|software|basic render|warp|lavapipe/i.test(name);
      renderer = { known: true, software };
    }
  } catch {
    software = null;
  }
  return software;
}

// ------------------------------------------------------------ the call

/** "the feature after it is" / "the 3 features after it are". */
const later = (n: number) => (n === 1 ? 'the feature after it is' : `the ${n} features after it are`);

/** The viewport's handle with its snapshot, or not_ready no_viewport in words. */
function viewportOf(services: AppServices): ViewportHandle & { snapshot: NonNullable<ViewportHandle['snapshot']> } {
  const handle = services.viewport.get().handle;
  if (!handle || typeof handle.snapshot !== 'function') throw new ToolError('no_viewport', 'The Part has no 3D view open, so no picture can be drawn.');
  if (handle.stats().contextLost) throw lostContext();
  return handle as ViewportHandle & { snapshot: NonNullable<ViewportHandle['snapshot']> };
}

const lostContext = () => new ToolError('no_viewport', "The 3D view's graphics context is lost, so no picture can be drawn now.", { detail: { context_lost: true } });

/** Bodies named in `hide` (by name in any case, or by id), or not_found listing the bodies. */
function bodiesToHide(names: readonly string[], bodies: readonly BodyInfo[]): BodyInfo[] {
  const out: BodyInfo[] = [];
  names.forEach((n, i) => {
    const want = n.trim().toLowerCase();
    const b = bodies.find((x) => x.name.toLowerCase() === want) ?? bodies.find((x) => x.id === n.trim());
    if (!b) {
      const list = bodies.map((x) => x.name);
      throw new ToolError('not_found', `hide[${i}]: no body is called "${n.trim()}". Bodies: ${list.slice(0, 30).join(', ') || 'none'}.`, { detail: { field: `hide[${i}]`, names: list.slice(0, 30) } });
    }
    if (!out.includes(b)) out.push(b);
  });
  return out;
}

/** The driving dimensions of the sketches drawn now, with their values (mm or degrees). */
function shownDimensions(services: AppServices, s: DocState): { sketch: string; id: string; value: number; unit: 'mm' | 'deg' }[] {
  const out: { sketch: string; id: string; value: number; unit: 'mm' | 'deg' }[] = [];
  const mode = services.mode?.get().mode ?? 'model';
  for (const { feature } of drawnSketches(s, mode, profilesView(services).get(), services.doc.features)) {
    const ev = evaluateDimensions(feature, services.doc.units);
    for (const c of feature.constraints) {
      if (!isDimension(c) || !c.driving || ev.values[c.id] === undefined) continue;
      out.push({ sketch: feature.name, id: c.id, value: len(ev.values[c.id]), unit: quantityOf(c.kind) === 'angle' ? 'deg' : 'mm' });
    }
  }
  return out;
}

/** Why the picture is not the whole Part, or the person may not see it, in words. */
function notesNow(services: AppServices, s: DocState): string[] {
  const notes: string[] = [];
  const features = s.doc.features;
  const open = services.doc.session();
  if (open?.open && !open.owner && open.draft.type === 'sketch') {
    const i = features.findIndex((f) => f.id === open.feature);
    const after = i >= 0 ? features.length - i - 1 : 0;
    if (after > 0) notes.push(`The person is editing ${features[i].name}: ${later(after)} rolled back and not in the picture.`);
  } else if (s.view.rollback !== null && s.view.rollback < features.length) {
    const last = s.view.rollback > 0 ? features[s.view.rollback - 1]?.name : null;
    notes.push(`The rollback bar is ${last ? `after ${last}` : 'at the top'}: ${later(features.length - s.view.rollback)} not in the picture.`);
  }
  if (typeof document !== 'undefined' && document.hidden) notes.push('The window is hidden or covered: the person may not be watching.');
  return notes;
}

/** One picture of one view, or not_ready when the graphics context went away. */
function snap(handle: ViewportHandle & { snapshot: NonNullable<ViewportHandle['snapshot']> }, o: SnapshotOptions): SnapshotResult {
  try {
    return handle.snapshot(o);
  } catch (e) {
    if ((e as { code?: unknown })?.code === 'not_ready') throw lostContext();
    throw e;
  }
}

/** view: pictures of the Part, drawn off screen (the person's view never moves). */
export async function takeView(ctx: CallCtx): Promise<ToolReply> {
  const { services } = ctx;
  // A model that reads no images gets words at once, and nothing is drawn.
  if (ctx.turn?.images === false) throw new ToolError('no_images', "This request's model does not read images, so no picture is drawn.");
  const input = readViewInput(ctx.input);
  await waitForRead(ctx);
  viewportOf(services);
  await heartbeat(ctx, services.doc.settled(ctx.signal), 'Waiting for the rebuild');
  await ctx.hold('after-settled');
  ctx.checkAbort();
  // The view (or its context) may have gone while the rebuild caught up.
  const handle = viewportOf(services);
  const s = services.doc.state.get();
  const bodies = s.rebuild.bodies;
  const hidden = bodiesToHide(input.hide, bodies);
  const hideIds = new Set(hidden.map((b) => b.id));
  // "<plane> middle": through the middle of what is drawn.
  const drawn = bodies.filter((b) => b.visible && !!b.tess && !hideIds.has(b.id));
  const section = sectionAtMiddle(
    parseSection(input.section, (e) => services.doc.units.evaluate(e, 'length')),
    drawn.map((b) => b.bbox),
  );
  const size: ViewSize = ctx.budgets.viewSize === 'small' ? 'small' : input.size;
  const layout = sheetLayout(input.views.length, SHEET_LONG_PX[size]);
  const font = LABEL_FONT_PX[size];

  // Every picture in this task: the Part as it is now in each of them.
  ctx.progress(0, `Drawing ${input.views.join(', ')}`);
  const snapOpts = (view: SnapshotView, t: Tile): SnapshotOptions => ({ view, width: t.w, height: t.h, hide: [...hideIds], section: section ? { ...section } : null, display: input.display, projection: input.projection });
  const shots = input.views.map((view, i) => snap(handle, snapOpts(view, layout.tiles[i])));
  const shown = drawn;
  const inTree = bodies.filter((b) => !b.visible && !hideIds.has(b.id));

  const marks = titleMarks(layout, input.views, font);
  const notes = notesNow(services, s);
  // The key's one handle table, shared with find and the selectors (a #f3 here names the same face there).
  const handles = handlesOf(services, ctx.key);
  const labels: { handle: string; words: string }[] = [];
  const labelled = new Map<string, string>();

  if (input.labels === 'bodies') {
    for (const b of shown.slice(0, BODY_NAMES_MAX)) {
      const centre: Vec3 = [(b.bbox[0] + b.bbox[3]) / 2, (b.bbox[1] + b.bbox[4]) / 2, (b.bbox[2] + b.bbox[5]) / 2];
      const box = boxOf(b.name, font);
      const placed: Mark[] = [];
      shots.forEach((shot, i) => {
        const at = shot.project(centre);
        if (!at || at[0] < 0 || at[1] < 0 || at[0] >= shot.width || at[1] >= shot.height) return;
        const mark: Mark = { kind: 'body', tile: i, text: b.name, ...placeIn(layout.tiles[i], at, box), ...box };
        if (addMark(marks, mark)) placed.push(mark);
      });
      if (!placed.length) continue;
      const handle = handles.give({ kind: 'body', body: b.id, bodyName: b.name, ref: null, label: b.name, words: b.name });
      labels.push({ handle, words: b.name });
    }
  } else if (input.labels === 'faces') {
    const triangles = shown.reduce((n, b) => n + (b.tess ? b.tess.indices.length / 3 : 0), 0) * shots.length;
    if (triangles > LABEL_TRIANGLES_MAX) notes.push('The Part has too many faces to label them in a picture: find lists faces with their handles.');
    else {
      const clip = section ? snapshotClip(section) : null;
      const v = new Vector3();
      const keep = clip ? (p: Vec3) => clip.distanceToPoint(v.set(p[0], p[1], p[2])) >= -1e-6 : null;
      const spots = shots.flatMap((shot, i) => shown.flatMap((b) => faceSpots(b, shot, SNAPSHOT_DIRS[input.views[i]].dir, keep).map((spot) => ({ ...spot, tile: i }))));
      spots.sort((a, b) => b.area - a.area);
      // The largest first; a face labelled once may be labelled in every picture that shows it.
      const chosen = new Map<string, { body: BodyInfo; face: number; marks: Mark[] }>();
      const room = boxOf('#f000', font);
      for (const spot of spots) {
        const id = `${spot.body}|${spot.face}`;
        if (!chosen.has(id) && chosen.size >= FACE_LABELS_MAX) continue;
        const mark: Mark = { kind: 'face', tile: spot.tile, text: '', ...placeIn(layout.tiles[spot.tile], spot.at, room), ...room };
        if (!addMark(marks, mark)) continue;
        let c = chosen.get(id);
        if (!c) chosen.set(id, (c = { body: shown.find((b) => b.id === spot.body)!, face: spot.face, marks: [] }));
        c.marks.push(mark);
      }
      // Each face's handle, kept by its stored reference (what a handle names, never an index).
      const names = (fid: string) => s.doc.features.find((f) => f.id === fid)?.name ?? null;
      // Labels over every body built now, as find numbers them (~k across the bodies).
      const labelIndex = new LabelIndex(bodies, { featureName: names });
      const name = await heartbeat(
        ctx,
        (async () => {
          const out = new Map<string, string | null>();
          for (const [id, c] of chosen) {
            ctx.checkAbort();
            const picked = await pickFace(services, c.body, c.face, null);
            if (!picked.ok) {
              out.set(id, null);
              continue;
            }
            const faceName = c.body.names?.faces?.[c.face] ?? null;
            out.set(
              id,
              handles.give({
                kind: 'face',
                body: c.body.id,
                bodyName: c.body.name,
                ref: picked.ref,
                label: labelIndex.of(bodies.indexOf(c.body), c.face).label,
                words: faceWords(faceName, { featureName: names }, c.body.names?.faces ?? null),
              }),
            );
          }
          return out;
        })(),
        'Naming the faces',
      );
      ctx.checkAbort();
      for (const [id, c] of chosen) {
        const handle = name.get(id) ?? null;
        for (const m of c.marks) {
          if (!handle) marks.splice(marks.indexOf(m), 1);
          else {
            m.text = handle;
            const box = boxOf(handle, font);
            // Centred where the room was kept.
            m.x += Math.round((m.w - box.w) / 2);
            m.w = box.w;
          }
        }
        if (!handle || labelled.has(handle)) continue;
        const faceName = c.body.names?.faces?.[c.face];
        const words = faceName ? `${describeFace(faceName, names, c.body.names?.faces ?? null)} on ${c.body.name}` : `a face of ${c.body.name}`;
        labelled.set(handle, words);
        labels.push({ handle, words });
      }
      if (shown.some((b) => !b.names)) notes.push('Faces of bodies without face names get no handle.');
    }
  }

  const rgba = composeSheet(layout, shots);
  const image = await encodePicture(rgba, layout.width, layout.height, marks, font);
  ctx.checkAbort();

  const dims = shownDimensions(services, s);
  const scale = sig6(shots[0].mmPerPx);
  const data: Record<string, unknown> = {
    views: input.views.map((view, i) => ({ view, mm_per_px: sig6(shots[i].mmPerPx) })),
    shown: shown.slice(0, BODY_NAMES_MAX).map((b) => b.name),
    ...(shown.length > BODY_NAMES_MAX ? { shown_more: shown.length - BODY_NAMES_MAX } : {}),
    hidden: hidden.map((b) => b.name),
    ...(inTree.length ? { hidden_in_tree: inTree.slice(0, BODY_NAMES_MAX).map((b) => b.name) } : {}),
    ...(inTree.length > BODY_NAMES_MAX ? { hidden_in_tree_more: inTree.length - BODY_NAMES_MAX } : {}),
    section: sectionData(section),
    ...(input.display !== 'shaded-edges' ? { display: input.display.replace('-', '_') } : {}),
    ...(input.projection !== 'orthographic' ? { projection: input.projection } : {}),
    labels,
    ...(dims.length ? { dimensions: dims.slice(0, DIMENSIONS_MAX) } : {}),
    ...(dims.length > DIMENSIONS_MAX ? { dimensions_more: dims.length - DIMENSIONS_MAX } : {}),
    software_renderer: softwareRenderer(),
    ...(notes.length ? { note: notes.join(' ') } : {}),
  };
  const bits = [`Pictured ${input.views.join(', ')} (${layout.width}x${layout.height} px, ${Number(scale.toPrecision(3))} mm/px)`, shown.length ? `shown ${shown.map((b) => b.name).join(', ')}` : 'no bodies shown'];
  if (hidden.length || inTree.length) bits.push(`hidden ${[...hidden, ...inTree].map((b) => b.name).join(', ')}`);
  if (dims.length) bits.push(`dimensions ${dims.map((d) => `${d.id} ${d.value} ${d.unit}`).join(', ')}`);
  return { text: bits.join('; '), data, summary: `Pictured ${input.views.join(', ')}`, images: [image] };
}
