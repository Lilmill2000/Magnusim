// What is VISIBLE inside a selection box, in one GPU pass (P4b SELECT): every
// shown body's faces, edges and B-rep vertices are drawn into an off-screen
// target with their ids as colours (faces pushed back so an edge or a vertex
// wins over its own faces, as on screen; the section plane clips; a
// see-through body hides nothing, as in picking), and the box's pixels are read
// back. Cost: one draw of the scene plus a read of the box, whatever the face
// count (a 10k-face import stays fast; no per-face ray test). The per-vertex
// face-id and per-edge segment buffers are built once per tessellation.
// Owner: P4b SELECT.
// SPDX-License-Identifier: GPL-3.0-or-later
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  LineSegments,
  Mesh,
  NoBlending,
  Points,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  UnsignedByteType,
  WebGLRenderTarget,
  type Camera,
  type Plane,
  type WebGLRenderer,
} from 'three';
import type { BodyData } from './tess';
import { EDGE_HIDDEN } from '../types/kernel-protocol';
import type { Rect } from './boxselect';

const TAG_FACE = 1;
const TAG_EDGE = 2;
const TAG_VERTEX = 3;

const VS = /* glsl */ `
#include <common>
#include <clipping_planes_pars_vertex>
attribute float iid;
uniform float uBase;
uniform float uSize;
varying float vId;
#ifdef FACES
varying vec3 vNormalV;
varying vec3 vViewV;
#endif
void main() {
  vId = uBase + iid;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
#ifdef FACES
  vNormalV = normalMatrix * normal;
  vViewV = isOrthographic ? vec3(0.0, 0.0, 1.0) : -mvPosition.xyz;
#endif
  gl_Position = projectionMatrix * mvPosition;
  gl_PointSize = uSize;
  #include <clipping_planes_vertex>
}
`;

const FS = /* glsl */ `
#include <common>
#include <clipping_planes_pars_fragment>
uniform float uTag;
varying float vId;
#ifdef FACES
varying vec3 vNormalV;
varying vec3 vViewV;
#endif
void main() {
  #include <clipping_planes_fragment>
#ifdef FACES
  // A face seen from behind (by its outward normal, whatever its triangles' winding) is the far
  // side of the body: it never shows, so it must not leak through at the outline's pixels.
  if (dot(normalize(vNormalV), normalize(vViewV)) < -1e-4) discard;
#endif
  float id = floor(vId + 0.5);
  float r = mod(id, 256.0);
  float g = mod(floor(id / 256.0), 256.0);
  float b = floor(id / 65536.0);
  gl_FragColor = vec4(r / 255.0, g / 255.0, b / 255.0, uTag / 255.0);
}
`;

function idMaterial(tag: number, opts: { offset?: boolean; size?: number } = {}): ShaderMaterial {
  const m = new ShaderMaterial({
    defines: tag === TAG_FACE ? { FACES: '' } : {},
    vertexShader: VS,
    fragmentShader: FS,
    uniforms: { uBase: { value: 0 }, uTag: { value: tag }, uSize: { value: opts.size ?? 1 } },
    blending: NoBlending,
    transparent: false,
    depthTest: true,
    depthWrite: true,
    side: 2, // DoubleSide: a face seen from behind (an open shell) still hides what is behind it
    clipping: true,
  });
  if (opts.offset) {
    m.polygonOffset = true;
    m.polygonOffsetFactor = 1;
    m.polygonOffsetUnits = 4;
  }
  return m;
}

/** One body as the pass draws it. */
export interface BoxBody {
  data: BodyData;
  /** B-rep vertex positions (kernel order), or null when not known yet. */
  vertices: Float32Array | null;
  seeThrough: boolean;
}

/**
 * Per body (same order as given): the faces, edges and vertices with at least one visible pixel in
 * the box, and how many pixels each edge shows (an edge hidden behind the body can show the one
 * pixel where it meets a visible edge at a shared corner: the caller asks for more).
 */
export interface VisibleInBox {
  faces: Set<number>[];
  edges: Set<number>[];
  vertices: Set<number>[];
  edgePixels: Map<number, number>[];
}

interface IdGeoms {
  faces: BufferGeometry | null;
  edges: BufferGeometry | null;
  vertices: BufferGeometry | null;
  vertexKey: Float32Array | null;
}

const cache = new WeakMap<BodyData, IdGeoms>();

function geomsOf(b: BoxBody): IdGeoms {
  let g = cache.get(b.data);
  if (!g) {
    g = { faces: faceGeometry(b.data), edges: edgeGeometry(b.data), vertices: null, vertexKey: null };
    cache.set(b.data, g);
  }
  if (b.vertices && g.vertexKey !== b.vertices) {
    g.vertices?.dispose();
    const n = b.vertices.length / 3;
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(b.vertices, 3));
    const ids = new Float32Array(n);
    for (let i = 0; i < n; i++) ids[i] = i;
    geo.setAttribute('iid', new BufferAttribute(ids, 1));
    g.vertices = geo;
    g.vertexKey = b.vertices;
  }
  return g;
}

/** The body's triangles with each vertex carrying its face's index (the kernel writes each face's nodes together). */
function faceGeometry(data: BodyData): BufferGeometry | null {
  if (!data.triangles) return null;
  const pos = data.tess.positions;
  const n = pos.length / 3;
  const ids = new Float32Array(n);
  for (let k = 0; k < data.faces; k++) {
    const first = data.faceVerts[2 * k];
    const count = data.faceVerts[2 * k + 1];
    if (count) ids.fill(k, first, first + count);
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(pos, 3));
  geo.setAttribute('normal', new BufferAttribute(data.tess.normals, 3));
  geo.setAttribute('iid', new BufferAttribute(ids, 1));
  geo.setIndex(new BufferAttribute(data.tess.indices, 1));
  return geo;
}

/** The body's drawn edges as segments, each vertex carrying its edge's index (hidden edges left out). */
function edgeGeometry(data: BodyData): BufferGeometry | null {
  const { edgePositions, edgeRanges, edgeFlags } = data.tess;
  const edges = edgeRanges.length / 2;
  const flags = edgeFlags && edgeFlags.length === edges ? edgeFlags : null;
  let segs = 0;
  for (let e = 0; e < edges; e++) {
    if (flags && flags[e] & EDGE_HIDDEN) continue;
    const c = edgeRanges[2 * e + 1];
    if (c >= 2) segs += c - 1;
  }
  if (!segs) return null;
  const p = new Float32Array(segs * 6);
  const ids = new Float32Array(segs * 2);
  let o = 0;
  for (let e = 0; e < edges; e++) {
    if (flags && flags[e] & EDGE_HIDDEN) continue;
    const s = edgeRanges[2 * e];
    const c = edgeRanges[2 * e + 1];
    for (let i = s; i + 1 < s + c; i++) {
      p.set(edgePositions.subarray(3 * i, 3 * i + 6), 6 * o);
      ids[2 * o] = e;
      ids[2 * o + 1] = e;
      o++;
    }
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(p, 3));
  geo.setAttribute('iid', new BufferAttribute(ids, 1));
  return geo;
}

/**
 * Draw the bodies' ids and read what shows inside `rect` (CSS px of a `width` x `height` view).
 * `faces: false` (wireframe) draws no surfaces, so nothing is hidden.
 */
export function visibleInBox(
  renderer: WebGLRenderer,
  camera: Camera,
  bodies: readonly BoxBody[],
  opts: { width: number; height: number; rect: Rect; clip: Plane | null; faces: boolean; edges: boolean; vertices: boolean },
): VisibleInBox {
  const out: VisibleInBox = { faces: bodies.map(() => new Set()), edges: bodies.map(() => new Set()), vertices: bodies.map(() => new Set()), edgePixels: bodies.map(() => new Map()) };
  const w = Math.max(1, Math.round(opts.width));
  const h = Math.max(1, Math.round(opts.height));
  const x0 = Math.max(0, Math.floor(opts.rect.x0));
  const y0 = Math.max(0, Math.floor(opts.rect.y0));
  const x1 = Math.min(w, Math.ceil(opts.rect.x1) + 1);
  const y1 = Math.min(h, Math.ceil(opts.rect.y1) + 1);
  if (x1 <= x0 || y1 <= y0 || !bodies.length) return out;

  const clipping = opts.clip ? [opts.clip] : null;
  const scene = new Scene();
  const mats: ShaderMaterial[] = [];
  const objs: (Mesh | LineSegments | Points)[] = [];
  // Item index -> (body, tag, local index): a running base per body and kind (24-bit ids).
  const ranges: { base: number; count: number; body: number; tag: number }[] = [];
  let base = 1;
  const add = (body: number, tag: number, geo: BufferGeometry | null, count: number, make: (m: ShaderMaterial) => Mesh | LineSegments | Points, order: number, opt: { offset?: boolean; size?: number } = {}) => {
    if (!geo || !count) return;
    const m = idMaterial(tag, opt);
    m.uniforms.uBase.value = base;
    m.clippingPlanes = clipping;
    const o = make(m);
    o.frustumCulled = false;
    o.renderOrder = order;
    mats.push(m);
    objs.push(o);
    scene.add(o);
    ranges.push({ base, count, body, tag });
    base += count;
  };
  bodies.forEach((b, i) => {
    const g = geomsOf(b);
    // A see-through body first and writing no depth: what is behind it shows through, as picking does.
    if (opts.faces) {
      add(i, TAG_FACE, g.faces, b.data.faces, (m) => {
        if (b.seeThrough) m.depthWrite = false;
        return new Mesh(g.faces!, m);
      }, b.seeThrough ? 0 : 1, { offset: true });
    }
    if (opts.edges) add(i, TAG_EDGE, g.edges, b.data.edges, (m) => new LineSegments(g.edges!, m), 2);
    if (opts.vertices && g.vertices) add(i, TAG_VERTEX, g.vertices, g.vertices.getAttribute('position').count, (m) => new Points(g.vertices!, m), 3, { size: 5 });
  });
  if (base >= 0xffffff) return out;

  const target = new WebGLRenderTarget(w, h, { format: RGBAFormat, type: UnsignedByteType, depthBuffer: true, stencilBuffer: false });
  const prevTarget = renderer.getRenderTarget();
  const prevAuto = renderer.autoClear;
  const prevClear = renderer.getClearAlpha();
  const clearColor = renderer.getClearColor(new Color());
  try {
    // A render target's viewport is its own pixels (no pixel ratio): one pixel per CSS px.
    renderer.setRenderTarget(target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, true);
    renderer.render(scene, camera);
    const rw = x1 - x0;
    const rh = y1 - y0;
    const buf = new Uint8Array(rw * rh * 4);
    // Render targets have their origin bottom-left.
    renderer.readRenderTargetPixels(target, x0, h - y1, rw, rh, buf);
    let last = -1;
    let lastRange: (typeof ranges)[number] | null = null;
    for (let i = 0; i < buf.length; i += 4) {
      const tag = buf[i + 3];
      if (!tag) continue;
      const id = buf[i] + 256 * buf[i + 1] + 65536 * buf[i + 2];
      if (id === last && tag !== TAG_EDGE) continue;
      last = id;
      const r: (typeof ranges)[number] | null = lastRange && id >= lastRange.base && id < lastRange.base + lastRange.count ? lastRange : ranges.find((x) => id >= x.base && id < x.base + x.count) ?? null;
      if (!r) continue;
      lastRange = r;
      const local = id - r.base;
      (r.tag === TAG_FACE ? out.faces : r.tag === TAG_EDGE ? out.edges : out.vertices)[r.body].add(local);
      if (r.tag === TAG_EDGE) out.edgePixels[r.body].set(local, (out.edgePixels[r.body].get(local) ?? 0) + 1);
    }
  } finally {
    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(clearColor, prevClear);
    renderer.autoClear = prevAuto;
    target.dispose();
    for (const m of mats) m.dispose();
  }
  return out;
}
