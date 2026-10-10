// The taped banana in a sketch (ux010, Daniel 2026-10-09: "add something similar to that but to the
// sketch section and use this image ... a banana duct taped to a wall, so someone can add this to
// their sketch to see the scale"). The image (Daniel's, made by him; GPL-3.0-or-later with the
// plugin, LICENSES/README.md) lies flat in the edited sketch's plane at its true size, upright in
// the sketch's u/v, behind every sketch curve, dimension and glyph. It is never sketch geometry:
// never snapped to, in no region or profile, not selectable, constrainable or dimensionable, not in
// a box selection or the DOF; the kernel never sees it. With the Select tool a press on an opaque
// pixel of it (and on no sketch point or curve) drags it in the plane; with a drawing tool the
// picture is ignored (draw or trace over it). Shown only
// while that sketch is edited; its place is kept per sketch with the Part's view
// (DocService.setSketchBanana), as the 3D banana's is.
// Owner: TOOLBAR builder (ux010).
// SPDX-License-Identifier: GPL-3.0-or-later
import { CanvasTexture, CustomBlending, DoubleSide, Matrix4, Mesh, OneMinusSrcAlphaFactor, PlaneGeometry, ShaderMaterial, SrcAlphaFactor, Vector3 } from 'three';
import { modeFor, planeY, toModel, type SketchMode } from '../../sketch/mode';
import { sketchCursor } from '../../sketch/cursors';
import { hitTest } from '../../sketch/pick';
import type { AppServices } from '../../types/app';
import type { FeatureId, PlaneFrame, Vec2, Vec3 } from '../../types/doc';
import type { OverlayLayer, ViewportHandle, ViewportPointer, ViewportTool } from '../../types/viewport';
import { uiFor } from '../../ui/controller';
import imageUrl from './banana-taped.webp';
import { LEASH_MIN, onLeash } from './placement';

/** The image's real size (mm): the banana in it is 205 mm along its curve, as the 3D banana. */
export const TAPED_W = 137.7;
export const TAPED_H = 181.0;
export const SKETCH_BANANA_LAYER = 'scale-sketch-banana';
/** The smallest gap between the sketch (its curves and dimension labels) and the image (mm). */
export const TAPED_GAP = 20;
/** The gap as a share of the sketch's size. */
export const TAPED_GAP_SHARE = 0.15;

/**
 * Where the image goes in a sketch spanning `uvs` (its points, circles' rims and dimension labels):
 * its left edge max(20 mm, 15 % of the sketch's size) to +u of them, centred on them in v; just
 * right of the origin, by the same 20 mm, when there are none.
 */
export function placeTaped(uvs: readonly Vec2[]): Vec2 {
  const ok = uvs.filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (!ok.length) return [TAPED_GAP + TAPED_W / 2, 0];
  let u0 = Infinity;
  let u1 = -Infinity;
  let v0 = Infinity;
  let v1 = -Infinity;
  for (const [u, v] of ok) (u0 = Math.min(u0, u)), (u1 = Math.max(u1, u)), (v0 = Math.min(v0, v)), (v1 = Math.max(v1, v));
  const gap = Math.max(TAPED_GAP, TAPED_GAP_SHARE * Math.max(u1 - u0, v1 - v0));
  return [u1 + gap + TAPED_W / 2, (v0 + v1) / 2];
}

/** A point of the image (sketch u/v) as the image's pixel (x right, y down), or null outside it. */
export function imagePixel(at: Vec2, uv: Vec2, size: { w: number; h: number }): [number, number] | null {
  const fx = (uv[0] - (at[0] - TAPED_W / 2)) / TAPED_W;
  const fy = (at[1] + TAPED_H / 2 - uv[1]) / TAPED_H;
  if (fx < 0 || fx >= 1 || fy < 0 || fy >= 1) return null;
  return [Math.floor(fx * size.w), Math.floor(fy * size.h)];
}

interface Picture {
  canvas: HTMLCanvasElement;
  alpha: Uint8Array;
  w: number;
  h: number;
  /** An opaque pixel near the middle (u/v from the centre, mm): where tests press. */
  grip: Vec2;
}

let loading: Promise<Picture> | null = null;
function loadPicture(): Promise<Picture> {
  if (!loading) {
    loading = (async () => {
      // Fetched (the frame's own folder, CORS-clean) so WebGL may use it and its alpha can be read.
      const r = await fetch(new URL(imageUrl, document.baseURI).href);
      if (!r.ok) throw new Error(`the banana picture: HTTP ${r.status}`);
      const bitmap = await createImageBitmap(await r.blob());
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const g = canvas.getContext('2d', { willReadFrequently: true })!;
      g.drawImage(bitmap, 0, 0);
      const data = g.getImageData(0, 0, canvas.width, canvas.height).data;
      const w = canvas.width;
      const h = canvas.height;
      const alpha = new Uint8Array(w * h);
      for (let i = 0; i < w * h; i++) alpha[i] = data[4 * i + 3];
      // The opaque pixel nearest the middle.
      let best: [number, number] = [w / 2, h / 2];
      let bd = Infinity;
      for (let y = 0; y < h; y += 3)
        for (let x = 0; x < w; x += 3)
          if (alpha[y * w + x] > 250) {
            const d = (x - w / 2) ** 2 + (y - h / 2) ** 2;
            if (d < bd) (bd = d), (best = [x, y]);
          }
      const grip: Vec2 = [((best[0] + 0.5) / w - 0.5) * TAPED_W, (0.5 - (best[1] + 0.5) / h) * TAPED_H];
      return { canvas, alpha, w, h, grip };
    })();
    loading.catch(() => {
      loading = null;
    });
  }
  return loading;
}

const VS = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
// The picture as it is (no lighting, no colour conversion), see-through where it is.
const FS = /* glsl */ `
uniform sampler2D map;
varying vec2 vUv;
void main() {
  vec4 c = texture2D(map, vUv);
  if (c.a < 0.1) discard;
  gl_FragColor = c;
}
`;

interface Shown {
  feature: FeatureId;
  plane: PlaneFrame;
  at: Vec2;
  layer: OverlayLayer;
  mesh: Mesh;
  pic: Picture;
  popTool: () => void;
  canvas: HTMLCanvasElement | null;
}

/** Show the taped banana in the edited sketch while the view says so; returns the uninstall. */
export function installSketchBanana(services: AppServices): () => void {
  let shown: Shown | null = null;
  let handle: ViewportHandle | null = null;
  let token = 0;
  let texture: CanvasTexture | null = null;
  // Not `transparent` (three draws transparent things after everything opaque, so the picture
  // would cover the sketch's lines): drawn in the opaque pass, in the layers' order (under the
  // sketch), blended by its own alpha (CustomBlending applies there too).
  const material = new ShaderMaterial({
    vertexShader: VS,
    fragmentShader: FS,
    side: DoubleSide,
    transparent: false,
    blending: CustomBlending,
    blendSrc: SrcAlphaFactor,
    blendDst: OneMinusSrcAlphaFactor,
    // It writes depth (pulled a little toward the eye): the plane's grid stays under it, as on a
    // picture taped to the wall; the sketch's curves draw without a depth test, so stay on top.
    depthWrite: true,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -4,
    uniforms: { map: { value: null } },
  });
  const geometry = new PlaneGeometry(TAPED_W, TAPED_H);

  const activeSketch = (): { mode: SketchMode; feature: FeatureId; plane: PlaneFrame } | null => {
    const mode = modeFor(services);
    if (!mode || !mode.active || !mode.feature) return null;
    const plane = mode.plane();
    return plane ? { mode, feature: mode.feature, plane } : null;
  };
  const atOf = (feature: FeatureId): Vec2 | null => services.doc.state.get().view.scaleModels?.sketch?.[feature]?.at ?? null;

  const put = (s: Shown, at: Vec2) => {
    s.at = at;
    const u = s.plane.xdir;
    const v = planeY(s.plane);
    const c = toModel(s.plane, at);
    s.mesh.matrixAutoUpdate = false;
    s.mesh.matrix.copy(new Matrix4().makeBasis(new Vector3(...u), new Vector3(...v), new Vector3(...s.plane.normal)).setPosition(c[0], c[1], c[2]));
    s.mesh.matrixWorldNeedsUpdate = true;
    s.mesh.updateMatrixWorld(true);
    const corners = [
      [at[0] - TAPED_W / 2, at[1] - TAPED_H / 2],
      [at[0] + TAPED_W / 2, at[1] - TAPED_H / 2],
      [at[0] + TAPED_W / 2, at[1] + TAPED_H / 2],
      [at[0] - TAPED_W / 2, at[1] + TAPED_H / 2],
    ].map((q) => toModel(s.plane, q as Vec2));
    s.layer.html.dataset.sketchBananaAt = at.map((x) => x.toFixed(3)).join(' ');
    s.layer.html.dataset.sketchBananaCorners = JSON.stringify(corners.map((p) => p.map((x) => +x.toFixed(3))));
    s.layer.html.dataset.sketchBananaGrip = JSON.stringify(toModel(s.plane, [at[0] + s.pic.grip[0], at[1] + s.pic.grip[1]]).map((x) => +x.toFixed(3)));
    s.layer.changed();
  };

  /** Where the ray meets the sketch plane (u/v), or null. */
  const uvOf = (s: Shown, e: ViewportPointer): { uv: Vec2; p: Vec3 } | null => {
    const n = s.plane.normal;
    const o = e.ray.origin;
    const d = e.ray.dir;
    const den = n[0] * d[0] + n[1] * d[1] + n[2] * d[2];
    if (Math.abs(den) < 1e-12) return null;
    const t = (n[0] * (s.plane.origin[0] - o[0]) + n[1] * (s.plane.origin[1] - o[1]) + n[2] * (s.plane.origin[2] - o[2])) / den;
    const p: Vec3 = [o[0] + t * d[0], o[1] + t * d[1], o[2] + t * d[2]];
    const q: Vec3 = [p[0] - s.plane.origin[0], p[1] - s.plane.origin[1], p[2] - s.plane.origin[2]];
    const y = planeY(s.plane);
    return { uv: [q[0] * s.plane.xdir[0] + q[1] * s.plane.xdir[1] + q[2] * s.plane.xdir[2], q[0] * y[0] + q[1] * y[1] + q[2] * y[2]], p };
  };
  /** The press is on the picture: on an opaque pixel of it, and on no sketch point or curve. */
  const onPicture = (s: Shown, e: ViewportPointer): Vec2 | null => {
    const hit = uvOf(s, e);
    if (!hit || !handle) return null;
    const px = imagePixel(s.at, hit.uv, s.pic);
    if (!px || s.pic.alpha[px[1] * s.pic.w + px[0]] < 128) return null;
    const mode = modeFor(services);
    const draft = mode?.draft();
    if (draft && hitTest(draft, hit.uv, handle.pixelSize(hit.p), { points: true, entities: true })) return null;
    return hit.uv;
  };

  let cursorSet = '';
  const cursor = (s: Shown, c: '' | 'grab' | 'grabbing') => {
    if (!s.canvas || c === cursorSet) return;
    // Back to the sketch tool's own cursor when the hand goes (the overlay sets it on its next move).
    if (c || cursorSet) s.canvas.style.cursor = c ? sketchCursor(c) : '';
    cursorSet = c;
    s.layer.html.dataset.sketchBananaCursor = c || 'none';
  };

  const toolFor = (s: Shown): ViewportTool => {
    let drag: { grab: Vec2; moved: boolean; rect: [number, number, number, number]; reach: number } | null = null;
    let swallowClick = false;
    return {
      id: 'scale-sketch-banana',
      onPointer(e) {
        if (drag) {
          if (e.type === 'move') {
            const hit = uvOf(s, e);
            if (hit) {
              drag.moved = true;
              // On a leash round the sketch: max(its size, 300 mm) beyond its bounds (it slides along the limit).
              put(s, onLeash([hit.uv[0] - drag.grab[0], hit.uv[1] - drag.grab[1]], drag.rect, drag.reach));
              s.layer.html.dataset.sketchBananaGrab = JSON.stringify(hit.p.map((x) => +x.toFixed(3)));
            }
            return true;
          }
          if (e.type === 'up' || e.type === 'leave') {
            const d = drag;
            drag = null;
            swallowClick = e.type === 'up';
            cursor(s, e.type === 'up' && onPicture(s, e) ? 'grab' : '');
            delete s.layer.html.dataset.sketchBananaDragging;
            if (d.moved) services.doc.setSketchBanana(s.feature, s.at);
            return true;
          }
          return true;
        }
        if (e.type === 'click' && swallowClick) {
          swallowClick = false;
          return true;
        }
        swallowClick = false;
        // Only the Select tool moves it: with a drawing tool in hand the picture is ignored, so a
        // shape can be drawn or traced over it (the coordinator's decision, 2026-10-09).
        const selecting = (modeFor(services)?.state.get().tool ?? 'select') === 'select';
        if (!selecting) {
          if (cursorSet) cursor(s, '');
          return false;
        }
        if (e.type === 'down' && e.button === 0 && !e.alt && !e.ctrl) {
          const uv = onPicture(s, e);
          if (!uv) return false;
          drag = { grab: [uv[0] - s.at[0], uv[1] - s.at[1]], moved: false, ...sketchLeash(services) };
          s.layer.html.dataset.sketchBananaLeash = drag.reach.toFixed(3);
          s.layer.html.dataset.sketchBananaDragging = '1';
          cursor(s, 'grabbing');
          return true;
        }
        if (e.type === 'move' && !e.buttons) {
          // The open hand over the picture (Select tool).
          const over = !!onPicture(s, e);
          cursor(s, over ? 'grab' : '');
          return over;
        }
        if (e.type === 'contextmenu' && onPicture(s, e)) {
          uiFor(services).showMenu(
            e.clientX,
            e.clientY,
            [
              { id: 'sketch-banana-place', label: 'Place next to sketch', run: () => services.doc.setSketchBanana(s.feature, placeTaped(sketchPoints(services))) },
              { sep: true, id: 'sketch-banana-sep' },
              { id: 'sketch-banana-remove', label: 'Remove banana', run: () => services.doc.setSketchBanana(s.feature, null) },
            ],
            'Banana for scale',
          );
          return true;
        }
        if (e.type === 'leave') cursor(s, '');
        return false;
      },
    };
  };

  const hide = () => {
    token++;
    if (!shown) return;
    const s = shown;
    shown = null;
    cursor(s, '');
    cursorSet = '';
    s.popTool();
    s.layer.group.remove(s.mesh);
    s.layer.dispose();
  };

  const sync = () => {
    const sk = activeSketch();
    const at = sk ? atOf(sk.feature) : null;
    if (!sk || !at || !handle) return hide();
    if (shown && shown.feature === sk.feature) {
      if ((shown.at[0] !== at[0] || shown.at[1] !== at[1]) && !shown.layer.html.dataset.sketchBananaDragging) put(shown, at);
      return;
    }
    hide();
    const mine = ++token;
    const h = handle;
    void loadPicture().then(
      (pic) => {
        if (mine !== token || shown) return;
        const now = activeSketch();
        const place = now ? atOf(now.feature) : null;
        if (!now || !place || handle !== h) return;
        if (!texture) {
          texture = new CanvasTexture(pic.canvas);
          texture.anisotropy = 4;
          material.uniforms.map.value = texture;
        }
        const mesh = new Mesh(geometry, material);
        mesh.name = 'banana-taped';
        // Under the sketch's own layers (sketch-geometry is order 30): it never hides a curve.
        // Fit frames it with the sketch while it is shown.
        const layer = h.addLayer(SKETCH_BANANA_LAYER, {
          order: 20,
          frame: () => {
            if (!shown) return null;
            const cs = JSON.parse(shown.layer.html.dataset.sketchBananaCorners ?? '[]') as Vec3[];
            if (!cs.length) return null;
            const min: Vec3 = [0, 1, 2].map((a) => Math.min(...cs.map((c) => c[a]))) as Vec3;
            const max: Vec3 = [0, 1, 2].map((a) => Math.max(...cs.map((c) => c[a]))) as Vec3;
            return { min, max };
          },
        });
        layer.group.add(mesh);
        layer.html.dataset.sketchBanana = 'shown';
        layer.html.dataset.sketchBananaFeature = now.feature;
        const canvas = layer.html.parentElement?.querySelector<HTMLCanvasElement>('canvas') ?? null;
        const s: Shown = { feature: now.feature, plane: now.plane, at: place, layer, mesh, pic, popTool: () => {}, canvas };
        shown = s;
        put(s, place);
        s.popTool = h.pushTool(toolFor(s));
      },
      (err: unknown) => {
        if (mine !== token) return;
        services.bridge.toast(`The banana picture could not be shown: ${err instanceof Error ? err.message : String(err)}`, 'error');
      },
    );
  };

  const offs: (() => void)[] = [];
  offs.push(services.doc.state.subscribe(() => sync()));
  offs.push(services.mode.subscribe(() => sync()));
  let offSketch: (() => void) | null = null;
  let lastTool: string | null = null;
  const watchSketch = () => {
    offSketch?.();
    offSketch =
      services.apis.get().sketch?.state.subscribe(() => {
        sync();
        // The sketch's own pointer tool is pushed again when its tool changes: the picture's goes
        // back on top of it, so a right-click on the picture is the picture's (never mid-drag).
        const tool = modeFor(services)?.state.get().tool ?? null;
        if (tool !== lastTool) {
          lastTool = tool;
          if (shown && handle && !shown.layer.html.dataset.sketchBananaDragging) {
            shown.popTool();
            shown.popTool = handle.pushTool(toolFor(shown));
          }
        }
      }) ?? null;
  };
  offs.push(services.apis.subscribe(() => watchSketch()));
  watchSketch();
  offs.push(
    services.viewport.subscribe((st) => {
      if (st.handle === handle) return;
      hide();
      handle = st.handle;
      sync();
    }),
  );
  handle = services.viewport.get().handle;
  sync();
  return () => {
    for (const off of offs) off();
    offSketch?.();
    hide();
    geometry.dispose();
    material.dispose();
    texture?.dispose();
  };
}

/** The edited sketch's extent (u/v): its points, circles' rims and dimension labels, for placing the picture beside it. */
export function sketchPoints(services: AppServices): Vec2[] {
  const mode = modeFor(services);
  const d = mode?.draft();
  if (!d) return [];
  const extra: Vec2[] = [];
  // The dimension labels as drawn now (their corners on the sketch's plane).
  const plane = mode?.plane();
  const handle = services.viewport.get().handle;
  if (plane && handle) {
    for (const el of document.querySelectorAll<HTMLElement>('.cad-sk-dim')) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      for (const [x, y] of [
        [r.left, r.top],
        [r.right, r.bottom],
        [r.left, r.bottom],
        [r.right, r.top],
      ]) {
        const hit = handle.toPlane(x, y, plane);
        if (hit) extra.push(hit.uv);
      }
    }
  }
  const pts = Object.values(d.points ?? {}).filter((p): p is Vec2 => Array.isArray(p) && p.length === 2);
  // A circle's or an arc's reach (its centre is a point; its rim is not).
  for (const e of d.entities as { c?: string; r?: number }[]) {
    const c = e.c ? d.points[e.c] : null;
    if (c && typeof e.r === 'number') pts.push([c[0] + e.r, c[1] + e.r], [c[0] - e.r, c[1] - e.r]);
  }
  return [...pts, ...extra];
}

/** The sketch's leash for the picture's centre: its bounds and max(their diagonal, 300 mm) beyond them. */
export function sketchLeash(services: AppServices): { rect: [number, number, number, number]; reach: number } {
  return leashAround(sketchPoints(services));
}

/** The leash round points (u/v): their bounding rectangle and max(its diagonal, 300 mm); around the origin with none. */
export function leashAround(uvs: readonly Vec2[]): { rect: [number, number, number, number]; reach: number } {
  if (!uvs.length) return { rect: [0, 0, 0, 0], reach: LEASH_MIN };
  const rect: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [u, v] of uvs) (rect[0] = Math.min(rect[0], u)), (rect[1] = Math.min(rect[1], v)), (rect[2] = Math.max(rect[2], u)), (rect[3] = Math.max(rect[3], v));
  return { rect, reach: Math.max(LEASH_MIN, Math.hypot(rect[2] - rect[0], rect[3] - rect[1])) };
}
