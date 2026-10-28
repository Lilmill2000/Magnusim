// E2, "the colour follows what's under it" (Daniel, 2026-10-28; palette.ts): in a dark view a thin
// mark is drawn in LIGHT's ink for its role wherever a light surface shows under it, and in the
// dark palette's own ink elsewhere, pixel by pixel. One stencil bit says "a light surface shows
// here":
//   - FACE_BIT (0x80). An opaque body's face writes it where it passes the depth test (Replace,
//     write mask FACE_BIT): set for a light surface, cleared for a dark one (isLightSurface), by
//     the colour the face is drawn in (materials.ts bodyShownColor), so the frontmost opaque
//     surface decides. A body of a dark colour clears it, but its faces lit by a pick or a hover
//     (the pick green, the hover blue: light surfaces) set it again in a second, stencil-only
//     pass (materials.ts createLitFacesMaterial, at LIT_FACES_ORDER), and a whole body selected or
//     hovered is the light blue it is drawn in. A section cap (section.ts) sets it where it draws.
//     A see-through body (an Enclosure's air), the origin and reference planes and the region
//     tints never touch it: what shows through them is what decides. Neither do the banana's taped
//     picture in a sketch and the 3D banana (not a body face or a cap, the light surfaces E2 names;
//     whether they should is Daniel's call: the picture is mostly grey tape). The section caps' parity
//     counter keeps to the other bits (PARITY_MASK), so the two never meet.
//   - Every mark drawn twice: the mark as it is, restricted to pixels without the bit (its
//     material tests the stencil, writes nothing), and a twin, a child of it (its visibility and
//     transform), sharing its geometry and a copy of its material in its face ink, restricted to
//     pixels with the bit. A mark that colours per segment or point (the sketch's lines and
//     points) gives its twin a geometry of its own in the face colours (setFaceColours).
//   - Which marks: a material with a face ink (setFaceInk: its role's LIGHT colour), or a geometry
//     with face colours; the bodies' B-rep edges too (E1: the view gives their material LIGHT's
//     near-black and twins them with the layers). The owner says so; the view (syncFaceTwins,
//     before every render) makes, shows, hides and updates the twins, so a material swap (hover,
//     pick: no face ink, so drawn
//     once as it is), a geometry swap, a new dash, width or opacity, and the section's clipping
//     planes follow at once. A twin may have an opacity of its own (setFaceOpacity: sketch mode's
//     hover halo, fainter over the background in a dark view).
//   - The bit is final when a mark tests it only if the mark draws after every surface that
//     writes it (drawsAfterSurfaces). three draws its opaque pass by group order (the renderOrder
//     of the nearest Group above an object: a layer's group is 100 and more, but a Group nested in
//     it starts its own, 0 unless set), then by the object's own renderOrder, and its transparent
//     pass after the whole opaque one; the surfaces draw in group order 0 at LIT_FACES_ORDER and
//     less. So a mark is transparent, or under a Group of order above 0, or its own order is above
//     LIT_FACES_ORDER. The layers' unit tests walk their marks with it.
// In LIGHT (and for every picture, D1) nothing is restricted, no twin is drawn and no body writes
// the stencil: the light view is the pixels it was.
// Owner: VIEWPORT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { AlwaysStencilFunc, EqualStencilFunc, KeepStencilOp, ReplaceStencilOp, type BufferGeometry, type Material, type Object3D } from 'three';

/** The stencil bit "a light surface shows here". */
export const FACE_BIT = 0x80;
/** The bits the section caps' parity counter may use (section.ts): all but FACE_BIT. */
export const PARITY_MASK = 0x7f;
/**
 * The render order of the last surface pass that writes FACE_BIT: a body's lit faces (the section
 * caps draw at -1, the bodies at 0, all in the scene's group order 0).
 */
export const LIT_FACES_ORDER = 0.5;

/** The group order three sorts an object by: the renderOrder of the nearest Group above it (0 for none). */
export function groupOrderOf(o: Object3D): number {
  for (let p = o.parent; p; p = p.parent) if ((p as Object3D & { isGroup?: boolean }).isGroup) return p.renderOrder;
  return 0;
}

/**
 * Whether a mark draws after every surface that writes FACE_BIT, so the bit under it is final when
 * it tests it: transparent (three's transparent pass comes after the opaque one), or in the opaque
 * pass after the bodies' group order 0, or in it with an order of its own above LIT_FACES_ORDER.
 */
export function drawsAfterSurfaces(o: Object3D): boolean {
  const m = (o as Object3D & { material?: Material | Material[] }).material;
  if (m && !Array.isArray(m) && m.transparent) return true;
  const g = groupOrderOf(o);
  return g > 0 || (g === 0 && o.renderOrder > LIT_FACES_ORDER);
}

/** The marks under `root` drawn twice now (a twin shown) that would draw before a surface writing FACE_BIT: none, or the bit is not final for them. */
export function marksBeforeSurfaces(root: Object3D): Object3D[] {
  const out: Object3D[] = [];
  root.traverse((o) => {
    if (!twins.has(o) && o.children.some((c) => twins.has(c) && c.visible) && !drawsAfterSurfaces(o)) out.push(o);
  });
  return out;
}

const SRGB = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
function luminance(hex: number): number {
  return 0.2126 * SRGB(((hex >> 16) & 255) / 255) + 0.7152 * SRGB(((hex >> 8) & 255) / 255) + 0.0722 * SRGB((hex & 255) / 255);
}
function contrastOf(a: number, b: number): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** The light view's fully defined ink and the dark view's (the two a mark over a surface may take). */
const LIGHT_INK = 0x101828;
const DARK_INK = 0xe6e9ef;

/**
 * A body colour is a light surface when the light view's dark ink reads at least as well on it
 * as the dark view's light ink: the default body colour and the light custom ones are; a dark
 * custom colour (a navy body) is not, so the marks over it keep their light inks.
 */
export function isLightSurface(color: number): boolean {
  return contrastOf(color, LIGHT_INK) >= contrastOf(color, DARK_INK);
}

/** A body face's material: 'mark' sets FACE_BIT where it shows, 'clear' takes it away there, 'off' leaves the stencil alone (light). */
export function surfaceStencil(m: Material, how: 'mark' | 'clear' | 'off'): void {
  if (how === 'off') {
    m.stencilWrite = false;
    return;
  }
  m.stencilWrite = true;
  m.stencilFunc = AlwaysStencilFunc;
  m.stencilRef = how === 'mark' ? FACE_BIT : 0;
  m.stencilFuncMask = 0xff;
  m.stencilWriteMask = FACE_BIT;
  m.stencilFail = KeepStencilOp;
  m.stencilZFail = KeepStencilOp;
  m.stencilZPass = ReplaceStencilOp;
}

/** Materials this module restricted (only those are given back their plain draw). */
const restricted = new WeakSet<Material>();

/** A mark's material drawn only where a light surface shows ('face'), only where none does ('ground'), or everywhere (null). It writes nothing. */
export function drawOnly(m: Material, where: 'face' | 'ground' | null): void {
  if (where === null) {
    if (restricted.has(m)) {
      m.stencilWrite = false;
      restricted.delete(m);
    }
    return;
  }
  // three.js tests a material's stencil only while it "writes" it; a write mask of 0 writes nothing.
  m.stencilWrite = true;
  m.stencilWriteMask = 0;
  m.stencilFunc = EqualStencilFunc;
  m.stencilRef = where === 'face' ? FACE_BIT : 0;
  m.stencilFuncMask = FACE_BIT;
  m.stencilFail = KeepStencilOp;
  m.stencilZFail = KeepStencilOp;
  m.stencilZPass = KeepStencilOp;
  restricted.add(m);
}

/** What this material's mark is drawn in over a light surface (0xrrggbb). */
const faceInks = new WeakMap<Material, number>();
/** A mark material's face ink: its role's LIGHT colour, or null for none (it is drawn once, as it is: LIGHT, a pick, a hover). */
export function setFaceInk(m: Material, ink: number | null): void {
  if (ink === null) faceInks.delete(m);
  else faceInks.set(m, ink);
}
export function faceInkOf(m: Material): number | undefined {
  return faceInks.get(m);
}

/** A mark material's twin's opacity, where it is not the mark's own (sketch mode's hover halo). */
const faceOpacities = new WeakMap<Material, number>();
/** The opacity this mark's twin is drawn at over a light surface, or null for the mark's own. */
export function setFaceOpacity(m: Material, opacity: number | null): void {
  if (opacity === null) faceOpacities.delete(m);
  else faceOpacities.set(m, opacity);
}
export function faceOpacityOf(m: Material): number | undefined {
  return faceOpacities.get(m);
}

/** A geometry's twin in the face colours (a mark coloured per segment or point). */
const faceGeometries = new WeakMap<BufferGeometry, BufferGeometry>();
/** The geometries whose face colours are disposed with them (one listener each). */
const watched = new WeakSet<BufferGeometry>();
/**
 * The geometry of a mark coloured per segment or point, in the colours it takes over a light
 * surface; null for none. The face geometry is the caller's to build; it goes (is disposed) with
 * `src`, or when another takes its place.
 */
export function setFaceColours(src: BufferGeometry, face: BufferGeometry | null): void {
  const was = faceGeometries.get(src);
  if (was === face) return;
  was?.dispose();
  if (!face) {
    faceGeometries.delete(src);
    return;
  }
  faceGeometries.set(src, face);
  if (watched.has(src)) return;
  watched.add(src);
  src.addEventListener('dispose', function gone() {
    src.removeEventListener('dispose', gone);
    watched.delete(src);
    const f = faceGeometries.get(src);
    faceGeometries.delete(src);
    f?.dispose();
  });
}
export function faceColoursOf(g: BufferGeometry): BufferGeometry | undefined {
  return faceGeometries.get(g);
}

type Drawn = Object3D & { isMesh?: boolean; isLine?: boolean; isPoints?: boolean; geometry: BufferGeometry; material: Material | Material[] };
type AnyMaterial = Material & { color?: { setHex(n: number): unknown; copy(c: unknown): unknown } };

const drawable = (o: Object3D): o is Drawn => !!((o as Drawn).isMesh || (o as Drawn).isLine || (o as Drawn).isPoints);

/** Each mark's twin, and the twins themselves (never twinned, never framed). */
const twinOf = new WeakMap<Object3D, Drawn>();
const twins = new WeakSet<Object3D>();
/** Whether an object is a mark's face twin (the view's framing and tests leave them out). */
export function isFaceTwin(o: Object3D): boolean {
  return twins.has(o);
}

/** The twin's copy of each mark material (one per material: marks sharing a material share it). */
const twinMats = new WeakMap<Material, Material>();
function twinMaterial(src: Material): Material {
  let t = twinMats.get(src);
  if (t) return t;
  const made = src.clone();
  // Not copied by Material.copy: a shader edit (the sketch's round points) and its cache key.
  made.onBeforeCompile = src.onBeforeCompile;
  made.customProgramCacheKey = src.customProgramCacheKey;
  const defs = (src as Material & { defines?: Record<string, unknown> }).defines;
  if (defs) (made as Material & { defines?: Record<string, unknown> }).defines = { ...defs };
  made.name = `${src.name || 'mark'}~face`;
  twinMats.set(src, made);
  t = made;
  src.addEventListener('dispose', function gone() {
    src.removeEventListener('dispose', gone);
    twinMats.delete(src);
    made.dispose();
  });
  return t;
}

/** What a mark's look may change to after its twin is made: copied onto the twin's material before each render. */
const PLAIN_KEYS = ['opacity', 'depthTest', 'depthWrite', 'depthFunc', 'polygonOffset', 'polygonOffsetFactor', 'polygonOffsetUnits', 'side', 'blending', 'colorWrite', 'visible', 'alphaTest', 'clipIntersection', 'linewidth', 'dashSize', 'gapSize', 'dashScale', 'dashOffset', 'size', 'sizeAttenuation'] as const;
/** The same, but the shader program depends on them. */
const PROGRAM_KEYS = ['transparent', 'vertexColors', 'alphaToCoverage', 'dashed', 'worldUnits'] as const;

function copyLook(dst: AnyMaterial, src: AnyMaterial, ink: number | undefined) {
  const d = dst as unknown as Record<string, unknown>;
  const s = src as unknown as Record<string, unknown>;
  const opacity = faceOpacities.get(src);
  for (const k of PLAIN_KEYS) if (k in src && d[k] !== s[k] && !(k === 'opacity' && opacity !== undefined)) d[k] = s[k];
  if (opacity !== undefined && dst.opacity !== opacity) dst.opacity = opacity;
  for (const k of PROGRAM_KEYS) {
    if (!(k in src) || d[k] === s[k]) continue;
    d[k] = s[k];
    dst.needsUpdate = true;
  }
  if (dst.clippingPlanes !== src.clippingPlanes) dst.clippingPlanes = src.clippingPlanes;
  if (dst.color && src.color) {
    if (ink !== undefined) dst.color.setHex(ink);
    else dst.color.copy(src.color);
  }
}

function makeTwin(o: Drawn, geometry: BufferGeometry, material: Material): Drawn {
  const Ctor = o.constructor as new (g: BufferGeometry, m: Material) => Drawn;
  const t = new Ctor(geometry, material);
  t.name = 'face-twin';
  t.frustumCulled = false;
  t.raycast = () => {};
  twins.add(t);
  twinOf.set(o, t);
  o.add(t);
  return t;
}

/**
 * Before a render: every mark under `root` that has a face ink or face colours drawn twice, the
 * mark over the background and its twin over light surfaces (`on`: the palette has face inks),
 * or once as it is (`on` false: light, and every picture). Cheap: a walk of the layers' objects
 * and a few property copies per twin.
 */
export function syncFaceTwins(root: Object3D, on: boolean): void {
  const marks: Drawn[] = [];
  root.traverse((o) => {
    if (!twins.has(o) && drawable(o) && !Array.isArray(o.material)) marks.push(o);
  });
  for (const o of marks) {
    const m = o.material as Material;
    const ink = faceInks.get(m);
    const faceGeo = faceGeometries.get(o.geometry);
    let t = twinOf.get(o);
    if (!on || (ink === undefined && !faceGeo)) {
      drawOnly(m, null);
      if (t) t.visible = false;
      continue;
    }
    const tm = twinMaterial(m);
    const geometry = faceGeo ?? o.geometry;
    if (!t) t = makeTwin(o, geometry, tm);
    if (t.geometry !== geometry) t.geometry = geometry;
    if (t.material !== tm) t.material = tm;
    copyLook(tm as AnyMaterial, m as AnyMaterial, faceGeo ? undefined : ink);
    t.renderOrder = o.renderOrder;
    t.visible = true;
    drawOnly(m, 'ground');
    drawOnly(tm, 'face');
  }
}
