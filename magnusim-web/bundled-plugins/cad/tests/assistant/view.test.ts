// The view tool (CAD tools spec §3.2.4, §9.2, §12.3 watch 5) through the page's tool handler as the
// bridge calls it, on the REAL kernel, with a viewport whose snapshot frames the shown bodies with
// the picture's own orthographic camera (src/viewport/snapshot.ts) and sees faces by a brute-force
// cast over their triangles, and a canvas that records what is drawn (jsdom has none):
//   - one view fills the picture; 2 to 4 make a 2 x 2 sheet with each tile's name; 768 px small,
//     1280 px large, small always on a local turn; one PNG, or a JPEG (0.85) when the PNG is over
//     1.4 MB; the data lists the views and their scale, the shown and hidden bodies, the cut;
//   - the person's view is never touched: no camera call, the Part's view, its files and its view
//     file unchanged;
//   - hide by name (any case) or id, bodies hidden in the tree apart, an unknown name not_found;
//   - section "<Top|Front|Right> [offset <length>] [flip]" (parameters allowed), bad_section;
//   - labels bodies (names at their boxes' centres, #b handles) and faces (#f handles on the
//     largest faces the picture really sees, at most 30, kept by their stored references, the
//     same handle for the same face in one key, a new table for a new key); the handles are the
//     key's one table, so find reads them and goes on numbering after them, and body takes #b;
//   - not_ready no_images for a model that reads no images (nothing drawn), no_viewport without a
//     3D view, without pictures or with its graphics context lost;
//   - notes for the person's sketch, the rollback bar and a hidden window; the shown sketches'
//     dimension values in the data and the text.
// SPDX-License-Identifier: GPL-3.0-or-later
import { Sphere, Vector3 } from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HINTS } from '../../src/assistant/errors';
import {
  composeSheet,
  FACE_LABELS_MAX,
  faceSpots,
  JPEG_QUALITY,
  keepsWords,
  parseSection,
  sheetLayout,
  setViewRaster,
  type Ctx2D,
  type Raster,
} from '../../src/assistant/view';
import { currentHandles } from '../../src/assistant/selectors/handles';
import type { BodyId, RegionRef, Vec3 } from '../../src/types/doc';
import type { SketchOutput } from '../../src/types/sketch';
import type { SnapshotOptions, SnapshotResult, SnapshotView, ViewportHandle } from '../../src/types/viewport';
import { VIEWPORT_BG } from '../../src/viewport/colors';
import { projectToPicture, SNAPSHOT_DIRS, snapshotRig } from '../../src/viewport/snapshot';
import { assistantHarness, REAL_KERNEL_MS, rectangle, type AssistantHarness } from './harness';

let h: AssistantHarness | null = null;
afterEach(() => {
  h?.dispose();
  h = null;
  setViewRaster(null);
  delete (document as unknown as { hidden?: boolean }).hidden;
});

type Row = Record<string, unknown>;
const VIEW = { views: ['iso'], hide: [], section: '', labels: 'none', size: 'small' };
const BG: [number, number, number] = [(VIEWPORT_BG >> 16) & 255, (VIEWPORT_BG >> 8) & 255, VIEWPORT_BG & 255];
/** Each view's picture is one colour in the fake, so the sheet shows where each went. */
const VIEW_RGB: Record<SnapshotView, [number, number, number]> = {
  iso: [200, 30, 30],
  iso_back: [30, 200, 30],
  front: [30, 30, 200],
  back: [200, 200, 30],
  left: [200, 30, 200],
  right: [30, 200, 200],
  top: [120, 60, 20],
  bottom: [20, 60, 120],
};

// ------------------------------------------------------------ the fakes

interface FakeView {
  handle: ViewportHandle;
  shots: SnapshotOptions[];
  camera: ReturnType<typeof vi.fn>[];
  lost: boolean;
  /** The snapshot throws not_ready while the stats still say the context is fine. */
  dies: boolean;
}

const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * A viewport whose snapshot frames the shown bodies (`hide` left out) from the view's direction
 * with the picture's own camera, as the real one does, and fills the picture with the view's
 * colour; visibleFaceAt casts through every front-facing triangle of the shown bodies.
 */
function fakeViewport(x: AssistantHarness, o: { snapshot?: boolean } = {}): FakeView {
  const camera = ['fit', 'setView', 'lookAt', 'setCamera', 'orbitAround', 'reframe', 'refitIfOffScreen'].map(() => vi.fn());
  const fv: FakeView = { handle: null as unknown as ViewportHandle, shots: [], camera, lost: false, dies: false };
  const snapshot = (opts: SnapshotOptions): SnapshotResult => {
    if (fv.lost || fv.dies) throw Object.assign(new Error('not_ready'), { code: 'not_ready' });
    fv.shots.push(JSON.parse(JSON.stringify(opts)));
    const shown = x.doc.state.get().rebuild.bodies.filter((b) => b.visible && b.tess && !opts.hide.includes(b.id));
    const box = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    for (const b of shown) for (let k = 0; k < 3; k++) (box.min[k] = Math.min(box.min[k], b.bbox[k])), (box.max[k] = Math.max(box.max[k], b.bbox[k + 3]));
    const sphere = shown.length ? new Sphere(new Vector3(...box.min.map((v, k) => (v + box.max[k]) / 2)), Math.hypot(...box.max.map((v, k) => v - box.min[k])) / 2) : new Sphere(new Vector3(), 50);
    sphere.radius *= 1.1;
    const rig = snapshotRig(opts.view, sphere, opts.width, opts.height);
    const cam = rig.apply(opts.width / opts.height);
    const rgba = new Uint8ClampedArray(opts.width * opts.height * 4);
    const [r, g, b] = VIEW_RGB[opts.view];
    for (let i = 0; i < rgba.length; i += 4) rgba.set([r, g, b, 255], i);
    const project = (p: Vec3) => projectToPicture(cam, opts.width, opts.height, p);
    const dir = SNAPSHOT_DIRS[opts.view].dir;
    return {
      rgba,
      width: opts.width,
      height: opts.height,
      mmPerPx: rig.orthoHeight / opts.height,
      project,
      visibleFaceAt(body, px, py) {
        let best: { body: BodyId; face: number; depth: number } | null = null;
        for (const s of shown) {
          const t = s.tess!;
          for (let f = 0; f < t.faceRanges.length / 2; f++) {
            const start = t.faceRanges[2 * f];
            for (let i = start; i < start + t.faceRanges[2 * f + 1]; i += 3) {
              const v = [t.indices[i], t.indices[i + 1], t.indices[i + 2]];
              const pts = v.map((k) => [t.positions[3 * k], t.positions[3 * k + 1], t.positions[3 * k + 2]] as Vec3);
              const n = v.reduce((acc, k) => acc.map((a, j) => a + t.normals[3 * k + j]), [0, 0, 0]);
              if (dot(n, dir) <= 0) continue;
              const q = pts.map(project);
              if (q.some((p) => !p)) continue;
              const [a, b2, c] = q as [number, number][];
              const d = (b2[1] - c[1]) * (a[0] - c[0]) + (c[0] - b2[0]) * (a[1] - c[1]);
              if (Math.abs(d) < 1e-12) continue;
              const w0 = ((b2[1] - c[1]) * (px - c[0]) + (c[0] - b2[0]) * (py - c[1])) / d;
              const w1 = ((c[1] - a[1]) * (px - c[0]) + (a[0] - c[0]) * (py - c[1])) / d;
              const w2 = 1 - w0 - w1;
              if (w0 < -1e-9 || w1 < -1e-9 || w2 < -1e-9) continue;
              const depth = w0 * dot(pts[0], dir) + w1 * dot(pts[1], dir) + w2 * dot(pts[2], dir);
              if (!best || depth > best.depth) best = { body: s.id, face: f, depth };
            }
          }
        }
        return best && best.body === body ? best.face : null;
      },
    };
  };
  const [fit, setView, lookAt, setCamera, orbitAround, reframe, refitIfOffScreen] = camera;
  fv.handle = {
    fit,
    setView,
    lookAt,
    setCamera,
    orbitAround,
    reframe,
    refitIfOffScreen,
    camera: () => ({ position: [100, -100, 100], target: [0, 0, 0], up: [0, 0, 1], projection: 'perspective' }),
    userCameraMoves: () => 0,
    stats: () => ({ frames: 0, lastFrameMs: 0, lastSetBodiesMs: 0, lastUploadFrameMs: 0, lastPickMs: 0, bvh: {}, triangles: 0, drawCalls: 0, contextLost: fv.lost }),
    ...(o.snapshot === false ? {} : { snapshot }),
  } as unknown as ViewportHandle;
  x.services.viewport.set({ handle: fv.handle });
  return fv;
}

interface Drawn {
  width: number;
  height: number;
  image: Uint8ClampedArray | null;
  texts: { text: string; x: number; y: number }[];
  blobs: { type: string; quality?: number }[];
}

/** A canvas that records what is put on it and answers blobs of the sizes asked. */
function recordingRaster(o: { pngBytes?: number } = {}): { raster: Raster; drawn: Drawn[] } {
  const drawn: Drawn[] = [];
  const raster: Raster = (width, height) => {
    const d: Drawn = { width, height, image: null, texts: [], blobs: [] };
    drawn.push(d);
    const g = {
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 1,
      font: '',
      textAlign: 'start',
      textBaseline: 'alphabetic',
      createImageData: (w: number, ht: number) => ({ width: w, height: ht, data: new Uint8ClampedArray(w * ht * 4) }) as unknown as ImageData,
      putImageData: (img: ImageData) => void (d.image = new Uint8ClampedArray(img.data)),
      fillRect: () => undefined,
      strokeRect: () => undefined,
      fillText: (text: string, tx: number, ty: number) => void d.texts.push({ text, x: tx, y: ty }),
    } as unknown as Ctx2D;
    return {
      getContext: () => g,
      async convertToBlob(b) {
        d.blobs.push({ type: b.type, ...(b.quality !== undefined ? { quality: b.quality } : {}) });
        const size = b.type === 'image/png' ? (o.pngBytes ?? 2048) : 1024;
        return new Blob([new Uint8Array(size)], { type: b.type });
      },
    };
  };
  setViewRaster(raster);
  return { raster, drawn };
}

const px = (d: Drawn, x: number, y: number) => [...d.image!.subarray((y * d.width + x) * 4, (y * d.width + x) * 4 + 3)];

// ------------------------------------------------------------ the Part

/** A w x d x t block with a corner at (x0, y0, 0): its sketch on Top, extruded (new body). */
async function block(x: AssistantHarness, w: number, d: number, t: number, x0 = 0, y0 = 0) {
  const rect = rectangle(w, d, x0, y0);
  const sketch = await x.add('sketch', { points: rect.points, entities: rect.entities });
  const out = x.doc.state.get().rebuild.outputs[sketch] as SketchOutput;
  const r = out.regions[0];
  const profile: RegionRef = { sketch, region: r.key, entities: [...r.entities].sort(), sample: r.sample };
  const extrude = await x.add('extrude', { profiles: [profile], extent: { kind: 'blind', distance: `${t} mm` }, op: 'new' });
  const body = (x.doc.state.get().doc.features.find((f) => f.id === extrude) as { creates?: BodyId }).creates as BodyId;
  return { sketch, extrude, body };
}

const bodyOf = (x: AssistantHarness, id: BodyId) => x.doc.state.get().rebuild.bodies.find((b) => b.id === id)!;
const saved = (x: AssistantHarness) => vi.waitFor(() => expect(x.doc.state.get().save.state).toBe('saved'), { timeout: 10_000, interval: 10 });

// ------------------------------------------------------------ the pure parts

describe('the sheet, the cut and the faces a picture shows', () => {
  it('one view fills the picture; 2 to 4 make a 2 x 2 sheet, 768 or 1280 px wide, 3/4 as high', () => {
    expect(sheetLayout(1, 768)).toEqual({ width: 768, height: 576, tiles: [{ x: 0, y: 0, w: 768, h: 576 }], sheet: false });
    expect(sheetLayout(2, 768).tiles).toEqual([
      { x: 0, y: 0, w: 384, h: 288 },
      { x: 384, y: 0, w: 384, h: 288 },
    ]);
    const four = sheetLayout(4, 1280);
    expect([four.width, four.height, four.sheet]).toEqual([1280, 960, true]);
    expect(four.tiles.map((t) => [t.x, t.y, t.w, t.h])).toEqual([
      [0, 0, 640, 480],
      [640, 0, 640, 480],
      [0, 480, 640, 480],
      [640, 480, 640, 480],
    ]);
  });

  it("composes the tiles over the view's background, with the lines between them", () => {
    const layout = sheetLayout(3, 768);
    const tile = (rgb: number[]) => {
      const rgba = new Uint8ClampedArray(384 * 288 * 4);
      for (let i = 0; i < rgba.length; i += 4) rgba.set([...rgb, 255], i);
      return { rgba, width: 384, height: 288 };
    };
    const out = composeSheet(layout, [tile([1, 2, 3]), tile([4, 5, 6]), tile([7, 8, 9])]);
    const at = (x: number, y: number) => [...out.subarray((y * 768 + x) * 4, (y * 768 + x) * 4 + 4)];
    expect(out.length).toBe(768 * 576 * 4);
    expect(at(10, 10)).toEqual([1, 2, 3, 255]);
    expect(at(700, 10)).toEqual([4, 5, 6, 255]);
    expect(at(10, 500)).toEqual([7, 8, 9, 255]);
    // The fourth place stays the view's background.
    expect(at(700, 500)).toEqual([...BG, 255]);
    // The lines between the tiles.
    expect(at(384, 100)).not.toEqual([4, 5, 6, 255]);
    expect(at(100, 288)).not.toEqual([7, 8, 9, 255]);
  });

  it('reads a cut: a plane, an offset in any length (parameters too), flip; anything else is bad_section', () => {
    const units = (e: string) => (e.trim() === 'w/2' ? { ok: true as const, value: 15, quantity: 'length' as const, uses: ['w'] } : /^(-?\d+(\.\d+)?)( mm)?$/.test(e.trim()) ? { ok: true as const, value: Number(e.trim().split(' ')[0]), quantity: 'length' as const, uses: [] } : { ok: false as const, error: 'Unknown name' });
    expect(parseSection('', units)).toBeNull();
    expect(parseSection('  ', units)).toBeNull();
    expect(parseSection('Top offset 4 mm flip', units)).toEqual({ plane: 'top', offset: 4, flip: true });
    expect(parseSection('front', units)).toEqual({ plane: 'front', offset: 0, flip: false });
    expect(parseSection('YZ offset w/2', units)).toEqual({ plane: 'right', offset: 15, flip: false });
    expect(parseSection('XY flip', units)).toEqual({ plane: 'top', offset: 0, flip: true });
    for (const bad of ['Side', 'Top 4', 'Top offset', 'Top offset banana', 'Front offset 3 mm sideways']) {
      expect(() => parseSection(bad, units), bad).toThrow(/^bad_section: /);
    }
    // What each cut keeps, in model words (Front's normal points at -Y).
    expect(keepsWords({ plane: 'top', offset: 4, flip: false })).toBe('z <= 4 mm');
    expect(keepsWords({ plane: 'top', offset: 4, flip: true })).toBe('z >= 4 mm');
    expect(keepsWords({ plane: 'front', offset: 10, flip: false })).toBe('y >= -10 mm');
    expect(keepsWords({ plane: 'right', offset: -2, flip: true })).toBe('x >= -2 mm');
  });

  it('a face counts where it faces the camera and the cut keeps it, and only where the picture sees it', () => {
    // Two squares in one body: face 0 at z = 0 facing +Z (20 x 20), face 1 facing -Z.
    const quad = (z: number, n: number): { p: number[]; nrm: number[] } => ({ p: [0, 0, z, 20, 0, z, 20, 20, z, 0, 20, z], nrm: Array(4).fill([0, 0, n]).flat() });
    const a = quad(0, 1);
    const b = quad(-1, -1);
    const tess = {
      positions: new Float32Array([...a.p, ...b.p]),
      normals: new Float32Array([...a.nrm, ...b.nrm]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6]),
      faceRanges: new Uint32Array([0, 6, 6, 6]),
      edgePositions: new Float32Array(0),
      edgeRanges: new Uint32Array(0),
    };
    // The picture: 10 px per mm, looking down -Z (top).
    const shot = { width: 400, height: 400, project: (p: Vec3) => [p[0] * 10, 400 - p[1] * 10] as [number, number], visibleFaceAt: (_b: BodyId, _x: number, _y: number) => 0 as number | null };
    const spots = faceSpots({ id: 'b1', tess }, shot, [0, 0, 1]);
    expect(spots.map((s) => [s.face, Math.round(s.area)])).toEqual([[0, 40000]]);
    // The label goes to the middle of the face as the picture shows it.
    expect(spots[0].at[0]).toBeCloseTo(100, 6);
    expect(spots[0].at[1]).toBeCloseTo(300, 6);
    expect(spots[0].point.map((v) => Math.round(v * 1e6) / 1e6)).toEqual([10, 10, 0]);
    // Seen only right of x = 120 px (something in front of the rest): the incentre of its roomiest triangle there.
    const right = faceSpots({ id: 'b1', tess }, { ...shot, visibleFaceAt: (_b: BodyId, x: number) => (x > 120 ? 0 : null) }, [0, 0, 1]);
    const r = 20 - 10 * Math.SQRT2;
    expect(right[0].at[0]).toBeCloseTo((20 - r) * 10, 4);
    expect(right[0].at[1]).toBeCloseTo(400 - r * 10, 4);
    // Not seen there (another face in front): no label.
    expect(faceSpots({ id: 'b1', tess }, { ...shot, visibleFaceAt: () => null }, [0, 0, 1])).toEqual([]);
    // Cut away: nothing left of it.
    expect(faceSpots({ id: 'b1', tess }, shot, [0, 0, 1], (p) => p[0] > 100)).toEqual([]);
    // A cut keeping half of it: half its area.
    expect(Math.round(faceSpots({ id: 'b1', tess }, shot, [0, 0, 1], (p) => p[1] < p[0])[0]?.area ?? 0)).toBe(20000);
  });
});

// ------------------------------------------------------------ the tool

describe('view', () => {
  it(
    "pictures two views on one sheet, off screen: one PNG, the views' scale, the bodies shown; the person's view untouched",
    async () => {
      h = await assistantHarness();
      const a = await block(h, 20, 20, 20);
      const b = await block(h, 20, 20, 20, 40, 0);
      const fv = fakeViewport(h);
      const { drawn } = recordingRaster();
      await saved(h);
      const view = JSON.stringify(h.doc.state.get().view);
      const files = h.ws.files.writes.length;
      const data = h.ws.log.dataWrites.length;

      const r = await h.call('view', { views: ['iso', 'top'], hide: [], section: '', labels: 'none', size: 'small' });
      expect(r.ok, JSON.stringify(r)).toBe(true);
      const res = (r as { result: Row }).result;
      // One image; the fake host passes it on as JSON, so the canvas says what it was.
      expect((res.images as { mediaType: string }[]).map((i) => i.mediaType)).toEqual(['image/png']);
      expect(drawn).toHaveLength(1);
      expect(drawn[0].blobs).toEqual([{ type: 'image/png' }]);
      expect([drawn[0].width, drawn[0].height]).toEqual([768, 576]);
      // Each view drawn by the viewport at its tile's size, nothing hidden, no cut.
      expect(fv.shots).toEqual([
        { view: 'iso', width: 384, height: 288, hide: [], section: null },
        { view: 'top', width: 384, height: 288, hide: [], section: null },
      ]);
      expect(px(drawn[0], 10, 100)).toEqual(VIEW_RGB.iso);
      expect(px(drawn[0], 700, 100)).toEqual(VIEW_RGB.top);
      expect(px(drawn[0], 100, 500)).toEqual(BG);
      // Each tile's name in its corner.
      expect(drawn[0].texts.map((t) => t.text)).toEqual(['iso', 'top']);
      expect(drawn[0].texts[0].x).toBeLessThan(100);
      expect(drawn[0].texts[1].x).toBeGreaterThan(384);
      const d = res.data as Row;
      expect(d).toMatchObject({ shown: [bodyOf(h, a.body).name, bodyOf(h, b.body).name], hidden: [], section: null, labels: [], software_renderer: null });
      expect(d.views).toEqual([
        { view: 'iso', mm_per_px: expect.any(Number) },
        { view: 'top', mm_per_px: expect.any(Number) },
      ]);
      for (const v of d.views as { mm_per_px: number }[]) expect(v.mm_per_px).toBeGreaterThan(0);
      expect(d.note).toBeUndefined();
      expect(typeof d.rev).toBe('number');
      expect(res.text).toMatch(/^Pictured iso, top \(768x576 px, [\d.]+ mm\/px\); shown Body 1, Body 2$/);
      expect(res.summary).toBe('Pictured iso, top');
      // The person's view: no camera call, the Part's view as it was, nothing written.
      for (const fn of fv.camera) expect(fn).not.toHaveBeenCalled();
      expect(JSON.stringify(h.doc.state.get().view)).toBe(view);
      expect(h.ws.files.writes.length).toBe(files);
      expect(h.ws.log.dataWrites.length).toBe(data);
    },
    REAL_KERNEL_MS,
  );

  it(
    'one view large is 1280 x 960 with no tile name; a local turn always gets small; a PNG over 1.4 MB goes as a JPEG',
    async () => {
      h = await assistantHarness();
      await block(h, 20, 20, 20);
      const fv = fakeViewport(h);
      const { drawn } = recordingRaster({ pngBytes: 1.5 * 1024 * 1024 });
      const big = await h.call('view', { ...VIEW, size: 'large' });
      expect(fv.shots.at(-1)).toMatchObject({ view: 'iso', width: 1280, height: 960 });
      expect([drawn[0].width, drawn[0].height]).toEqual([1280, 960]);
      expect(drawn[0].texts).toEqual([]);
      expect(drawn[0].blobs).toEqual([{ type: 'image/png' }, { type: 'image/jpeg', quality: JPEG_QUALITY }]);
      expect(((big as { result: Row }).result.images as { mediaType: string }[]).map((i) => i.mediaType)).toEqual(['image/jpeg']);
      // A local turn: small whatever is asked.
      h.fake.emitTurn({ id: 't-local', local: true, contextTokens: 65_536, images: true });
      await h.ok('view', { ...VIEW, size: 'large' }, { turn: 't-local' });
      expect(fv.shots.at(-1)).toMatchObject({ width: 768, height: 576 });
    },
    REAL_KERNEL_MS,
  );

  it(
    'hide takes names in any case or ids; bodies hidden in the tree are listed apart; an unknown name is not_found with the names',
    async () => {
      h = await assistantHarness();
      const a = await block(h, 20, 20, 20);
      const b = await block(h, 20, 20, 20, 40, 0);
      const c = await block(h, 10, 10, 10, 0, 40);
      h.doc.setBodyVisible(c.body, false);
      await h.settle();
      const fv = fakeViewport(h);
      recordingRaster();
      const r = await h.ok('view', { ...VIEW, hide: ['body 2', a.body] });
      expect(fv.shots[0].hide.sort()).toEqual([a.body, b.body].sort());
      expect(r.data).toMatchObject({ shown: [], hidden: ['Body 2', 'Body 1'], hidden_in_tree: ['Body 3'] });
      expect(r.text).toContain('no bodies shown; hidden Body 2, Body 1, Body 3');
      const miss = await h.call('view', { ...VIEW, hide: ['Body 9'] });
      expect(miss).toEqual({
        ok: false,
        error: {
          code: 'invalid_input',
          message: 'not_found: hide[0]: no body is called "Body 9". Bodies: Body 1, Body 2, Body 3.',
          hint: HINTS.not_found,
          detail: { reason: 'not_found', field: 'hide[0]', names: ['Body 1', 'Body 2', 'Body 3'] },
        },
      });
    },
    REAL_KERNEL_MS,
  );

  it(
    'section cuts the picture (a parameter offset too) and says what it keeps; a bad one is bad_section and nothing is drawn',
    async () => {
      h = await assistantHarness();
      h.doc.addParam({ name: 'cut', expr: '4 mm', quantity: 'length' });
      await block(h, 20, 20, 20);
      const fv = fakeViewport(h);
      recordingRaster();
      const r = await h.ok('view', { ...VIEW, views: ['front'], section: 'Top offset cut flip' });
      expect(fv.shots[0].section).toEqual({ plane: 'top', offset: 4, flip: true });
      expect(r.data.section).toEqual({ plane: 'Top', offset_mm: 4, flip: true, keeps: 'z >= 4 mm' });
      const bad = await h.call('view', { ...VIEW, section: 'Top offset nothing' });
      expect(bad).toMatchObject({ ok: false, error: { code: 'invalid_input', message: expect.stringMatching(/^bad_section: The offset "nothing" of "Top offset nothing" is not a length: /), detail: { reason: 'bad_section' } } });
      expect(fv.shots).toHaveLength(1);
    },
    REAL_KERNEL_MS,
  );

  it(
    "labels bodies: each name at its box's centre in every picture, listed with a #b handle",
    async () => {
      h = await assistantHarness();
      const a = await block(h, 20, 20, 20);
      await block(h, 20, 20, 20, 40, 0);
      const fv = fakeViewport(h);
      const { drawn } = recordingRaster();
      const r = await h.ok('view', { ...VIEW, views: ['top'], labels: 'bodies' });
      expect(r.data.labels).toEqual([
        { handle: '#b1', words: 'Body 1' },
        { handle: '#b2', words: 'Body 2' },
      ]);
      const names = drawn[0].texts.filter((t) => t.text.startsWith('Body'));
      expect(names.map((t) => t.text)).toEqual(['Body 1', 'Body 2']);
      // Body 1's name sits where the picture shows its box's centre (10, 10, 10), Body 2's to its right.
      expect(names[0].x).toBeLessThan(names[1].x);
      expect(Math.abs(names[0].y - names[1].y)).toBeLessThan(2);
      expect(fv.shots).toHaveLength(1);
      expect(currentHandles(h.services, 'turn:t-test')!.get('#b1')).toEqual({ kind: 'body', body: a.body, bodyName: 'Body 1', ref: null, label: 'Body 1', words: 'Body 1' });
    },
    REAL_KERNEL_MS,
  );

  it(
    'labels faces: handles on the faces the picture sees, kept by their stored references; the same face keeps its handle in one key, a new key starts again',
    async () => {
      h = await assistantHarness();
      const a = await block(h, 40, 20, 20);
      // A smaller block right behind the first as the front view sees it: none of its faces show
      // there (its front face's label would sit clear of the first one's).
      await block(h, 10, 10, 20, 0, 40);
      fakeViewport(h);
      const { drawn } = recordingRaster();
      const top = await h.ok('view', { ...VIEW, views: ['top'], labels: 'faces' });
      const topLabels = top.data.labels as { handle: string; words: string }[];
      expect(topLabels).toEqual([
        { handle: '#f1', words: 'End face of Extrude 1 on Body 1' },
        { handle: '#f2', words: 'End face of Extrude 2 on Body 2' },
      ]);
      expect(drawn[0].texts.map((t) => t.text).sort()).toEqual(['#f1', '#f2']);
      const t1 = currentHandles(h.services, 'turn:t-test')!;
      const e1 = t1.get('#f1')!;
      // The key's one table (find's and the selectors'): the face's label and words with its reference.
      expect(e1).toMatchObject({ kind: 'face', body: a.body, bodyName: 'Body 1', label: 'Extrude 1.end', words: 'End face of Extrude 1' });
      expect(e1.ref!.name).toMatch(/:end$/);
      // Front: only the first block's front face shows (the second is behind it); iso: the first's
      // three faces and what the second shows; the end faces keep their handles.
      const front = await h.ok('view', { ...VIEW, views: ['front'], labels: 'faces' });
      expect((front.data.labels as { words: string }[]).map((l) => l.words)).toEqual([expect.stringMatching(/ of Extrude 1 on Body 1$/)]);
      const iso = await h.ok('view', { ...VIEW, views: ['iso'], labels: 'faces' });
      const isoLabels = iso.data.labels as { handle: string; words: string }[];
      expect(isoLabels.find((l) => l.words === 'End face of Extrude 1 on Body 1')?.handle).toBe('#f1');
      expect(new Set(isoLabels.map((l) => l.handle)).size).toBe(isoLabels.length);
      expect(isoLabels.length).toBeGreaterThanOrEqual(4);
      // A new turn has a table of its own: the same face is its #f1.
      const frontFace = t1.get((front.data.labels as { handle: string }[])[0].handle)!;
      expect(frontFace.ref!.name).not.toBe(e1.ref!.name);
      const next = await h.ok('view', { ...VIEW, views: ['front'], labels: 'faces' }, { turn: 't-next' });
      expect((next.data.labels as { handle: string }[]).map((l) => l.handle)).toEqual(['#f1']);
      expect(currentHandles(h.services, 'turn:t-next')!.get('#f1')).toEqual(frontFace);
      expect(currentHandles(h.services, 'turn:t-test')).toBeNull();
    },
    REAL_KERNEL_MS,
  );

  it(
    "a picture's handles are the request's own: find and body read them, and find's numbers go on after them",
    async () => {
      h = await assistantHarness();
      const a = await block(h, 40, 20, 20);
      fakeViewport(h);
      recordingRaster();
      const top = await h.ok('view', { ...VIEW, views: ['top'], labels: 'faces' });
      expect(top.data.labels).toEqual([{ handle: '#f1', words: 'End face of Extrude 1 on Body 1' }]);
      // find reads the picture's handle: the same face.
      const found = (await h.ok('find', { query: '#f1', limit: 10 })).data.rows as Row[];
      expect(found).toEqual([expect.objectContaining({ handle: '#f1', label: 'Extrude 1.end', body: 'Body 1', normal: [0, 0, 1] })]);
      // find's own listing: the end face keeps #f1, the other five go on from #f2.
      const all = (await h.ok('find', { query: 'Body 1 faces', limit: 10 })).data.rows as Row[];
      expect(all.find((r) => r.label === 'Extrude 1.end')?.handle).toBe('#f1');
      expect(all.map((r) => r.handle).sort()).toEqual(['#f1', '#f2', '#f3', '#f4', '#f5', '#f6']);
      // A picture's body handle names its body in the body tool.
      const named = await h.ok('view', { ...VIEW, views: ['top'], labels: 'bodies' });
      expect(named.data.labels).toEqual([{ handle: '#b1', words: 'Body 1' }]);
      const renamed = await h.ok('body', { body: '#b1', rename_to: 'Plate', color: '', simulation: 'keep' });
      expect(renamed.data).toMatchObject({ body: { name: 'Plate' } });
      expect(bodyOf(h, a.body).name).toBe('Plate');
      // A face handle is no body; a handle this request never gave is stale.
      expect(await h.call('body', { body: '#f1', rename_to: 'Slab', color: '', simulation: 'keep' })).toMatchObject({ ok: false, error: { message: 'bad_selector: body: #f1 is a face, not a body.', detail: { reason: 'bad_selector', field: 'body' } } });
      expect(await h.call('body', { body: '#b9', rename_to: 'Slab', color: '', simulation: 'keep' })).toMatchObject({ ok: false, error: { detail: { reason: 'selector_stale', handle: '#b9' } } });
      expect(await h.call('body', { body: '#b1', rename_to: 'Slab', color: '', simulation: 'keep' }, { turn: 't-other' })).toMatchObject({ ok: false, error: { detail: { reason: 'selector_stale' } } });
      expect(bodyOf(h, a.body).name).toBe('Plate');
    },
    REAL_KERNEL_MS,
  );

  it(
    `labels at most ${FACE_LABELS_MAX} faces, the largest first`,
    async () => {
      h = await assistantHarness();
      // Twelve separate squares in one sketch, extruded as one body: 36 faces face an iso camera.
      const points: Record<string, [number, number]> = {};
      const entities: { id: string; kind: 'line'; p: [string, string] }[] = [];
      for (let i = 0; i < 12; i++) {
        const x0 = (i % 4) * 30;
        const y0 = Math.floor(i / 4) * 30;
        const s = 10 + i;
        const ids = ['a', 'b', 'c', 'd'].map((k) => `pt_${k}${i}`);
        [
          [x0, y0],
          [x0 + s, y0],
          [x0 + s, y0 + s],
          [x0, y0 + s],
        ].forEach((p, k) => (points[ids[k]] = p as [number, number]));
        for (let k = 0; k < 4; k++) entities.push({ id: `e_${i}x${k}`, kind: 'line', p: [ids[k], ids[(k + 1) % 4]] });
      }
      const sketch = await h.add('sketch', { points, entities });
      const out = h.doc.state.get().rebuild.outputs[sketch] as SketchOutput;
      expect(out.regions).toHaveLength(12);
      const profiles: RegionRef[] = out.regions.map((r) => ({ sketch, region: r.key, entities: [...r.entities].sort(), sample: r.sample }));
      await h.add('extrude', { profiles, extent: { kind: 'blind', distance: '8 mm' }, op: 'new' });
      expect(h.doc.state.get().rebuild.bodies[0].faces).toBe(72);
      fakeViewport(h);
      recordingRaster();
      const r = await h.ok('view', { ...VIEW, views: ['iso'], labels: 'faces', size: 'large' });
      const labels = r.data.labels as { handle: string; words: string }[];
      expect(labels.length).toBeLessThanOrEqual(FACE_LABELS_MAX);
      expect(labels.length).toBeGreaterThanOrEqual(12);
      expect(new Set(labels.map((l) => l.handle)).size).toBe(labels.length);
    },
    REAL_KERNEL_MS,
  );

  it(
    "a model that reads no images gets not_ready no_images and nothing is drawn; one whose images are not known gets the picture",
    async () => {
      h = await assistantHarness();
      await block(h, 20, 20, 20);
      const fv = fakeViewport(h);
      const { drawn } = recordingRaster();
      h.fake.emitTurn({ id: 't-text', local: true, contextTokens: 65_536, images: false });
      const r = await h.call('view', VIEW, { turn: 't-text' });
      expect(r).toEqual({
        ok: false,
        error: { code: 'not_ready', message: "no_images: This request's model does not read images, so no picture is drawn.", hint: HINTS.no_images, detail: { reason: 'no_images' } },
      });
      expect(HINTS.no_images).toBe("The model can't read images here: use measure and find.");
      expect(fv.shots).toEqual([]);
      expect(drawn).toEqual([]);
      h.fake.emitTurn({ id: 't-unknown', local: true, contextTokens: 65_536, images: null });
      expect((await h.call('view', VIEW, { turn: 't-unknown' })).ok).toBe(true);
      // An outside client's call (no turn facts) gets it too.
      expect((await h.call('view', VIEW, { turn: '' })).ok).toBe(true);
      expect(fv.shots).toHaveLength(2);
    },
    REAL_KERNEL_MS,
  );

  it(
    'no 3D view, a view without pictures, a lost graphics context: not_ready no_viewport in words',
    async () => {
      h = await assistantHarness();
      await block(h, 20, 20, 20);
      recordingRaster();
      const none = await h.call('view', VIEW);
      expect(none).toEqual({ ok: false, error: { code: 'not_ready', message: 'no_viewport: The Part has no 3D view open, so no picture can be drawn.', hint: HINTS.no_viewport, detail: { reason: 'no_viewport' } } });
      fakeViewport(h, { snapshot: false });
      expect(await h.call('view', VIEW)).toMatchObject({ ok: false, error: { code: 'not_ready', detail: { reason: 'no_viewport' } } });
      const fv = fakeViewport(h);
      fv.lost = true;
      const lost = { ok: false, error: { code: 'not_ready', message: "no_viewport: The 3D view's graphics context is lost, so no picture can be drawn now.", hint: HINTS.no_viewport, detail: { reason: 'no_viewport', context_lost: true } } };
      expect(await h.call('view', VIEW)).toEqual(lost);
      // Lost while drawing (the stats said nothing yet): the same.
      fv.lost = false;
      fv.dies = true;
      expect(await h.call('view', VIEW)).toEqual(lost);
      fv.dies = false;
      expect((await h.call('view', VIEW)).ok).toBe(true);
    },
    REAL_KERNEL_MS,
  );

  it(
    "notes the person's sketch and the rollback bar rolling later features back, and a hidden window; reads never wait for the person",
    async () => {
      h = await assistantHarness();
      const a = await block(h, 20, 20, 20);
      fakeViewport(h);
      recordingRaster();
      // The person edits the block's sketch: the extrude after it is rolled back.
      const s = h.doc.beginEdit(a.sketch);
      const editing = await h.ok('view', VIEW);
      expect(editing.data.note).toBe('The person is editing Sketch 1: the feature after it is rolled back and not in the picture.');
      s.discard();
      await h.settle();
      h.doc.setRollback(1);
      const rolled = await h.ok('view', VIEW);
      expect(rolled.data.note).toBe('The rollback bar is after Sketch 1: the feature after it is not in the picture.');
      h.doc.setRollback(null);
      await h.settle();
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      const hidden = await h.ok('view', VIEW);
      expect(hidden.data.note).toBe('The window is hidden or covered: the person may not be watching.');
    },
    REAL_KERNEL_MS,
  );

  it(
    "lists the shown sketches' dimension values in the data and the text (pictures draw no values)",
    async () => {
      h = await assistantHarness();
      h.doc.addParam({ name: 'w', expr: '40 mm', quantity: 'length' });
      const rect = rectangle(40, 20);
      await h.add('sketch', {
        points: rect.points,
        entities: rect.entities,
        constraints: [
          { id: 'c_w', kind: 'distance', refs: ['e_1'], expr: 'w', driving: true },
          { id: 'c_h', kind: 'distance', refs: ['e_2'], expr: '20 mm', driving: true },
        ],
      });
      fakeViewport(h);
      recordingRaster();
      const r = await h.ok('view', { ...VIEW, views: ['top'] });
      expect(r.data.dimensions).toEqual([
        { sketch: 'Sketch 1', id: 'c_w', value: 40, unit: 'mm' },
        { sketch: 'Sketch 1', id: 'c_h', value: 20, unit: 'mm' },
      ]);
      expect(r.text).toContain('; dimensions c_w 40 mm, c_h 20 mm');
    },
    REAL_KERNEL_MS,
  );

  it('takes 1 to 4 directions of the eight, each once; anything else is bad_input naming the field', async () => {
    h = await assistantHarness();
    const fv = fakeViewport(h);
    recordingRaster();
    await h.settle();
    const r = await h.ok('view', { ...VIEW, views: ['top', 'top', 'iso_back'] });
    expect(fv.shots.map((s) => s.view)).toEqual(['top', 'iso_back']);
    expect(r.data.shown).toEqual([]);
    expect(await h.call('view', { ...VIEW, views: ['up'] })).toMatchObject({ ok: false, error: { code: 'invalid_input', detail: { reason: 'bad_input', field: 'views[0]' } } });
    expect(await h.call('view', { ...VIEW, views: [] })).toMatchObject({ ok: false, error: { code: 'invalid_input', detail: { reason: 'bad_input', field: 'views' } } });
  }, REAL_KERNEL_MS);
});

