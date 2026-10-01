// Shaders that light like the core viewer. vtk.js with its default headlight
// (Renderer.createLight -> HeadLight) shades a Phong surface as
//   ambient*Ca + max(0,nz)*diffuse*Cd + max(0,nz)^power*specular*Cs
// with nz the view-space normal's z, flipped on back faces (two-sided
// lighting); Property.setColor sets Ca = Cd = Cs (node_modules/@kitware/vtk.js/
// Rendering/OpenGL/PolyDataMapper.js:190, Rendering/Core/Property.js:19-35).
// Scalar colours (the core's pick paint) replace Ca and Cd, not Cs. Colours go
// in and out as sRGB, like vtk.js: no colour-space conversion.
// Owner: VIEWPORT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { DoubleSide, ShaderMaterial, Vector3, type Plane } from 'three';
import { BODY_LIGHT, BODY_SELECTED_COLOR, HOVER_COLOR, PICK_COLOR, rgb01 } from './colors';

const v3 = (hex: number) => new Vector3(...rgb01(hex));

const BODY_VS = /* glsl */ `
#include <common>
#include <clipping_planes_pars_vertex>
attribute float hl;
varying vec3 vNormalV;
varying float vHl;
void main() {
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  vNormalV = normalize(normalMatrix * normal);
  vHl = hl;
  gl_Position = projectionMatrix * mvPosition;
  #include <clipping_planes_vertex>
}
`;

const BODY_FS = /* glsl */ `
#include <common>
#include <clipping_planes_pars_fragment>
uniform vec3 uColor;
uniform vec3 uHover;
uniform vec3 uPick;
uniform vec3 uBodyPick;
uniform float uBodyState;
uniform float uAmbient;
uniform float uDiffuse;
uniform float uSpecular;
uniform float uPower;
#ifdef HATCH
uniform float uHatchGap;
uniform float uHatchWidth;
#endif
varying vec3 vNormalV;
varying float vHl;
void main() {
  #include <clipping_planes_fragment>
  vec3 n = normalize(vNormalV);
  if (!gl_FrontFacing) n = -n;
  float df = max(0.0, n.z);
  float sf = pow(df, uPower);
  vec3 c = uColor;
  if (uBodyState > 1.5) c = uBodyPick;
  else if (uBodyState > 0.5) c = uHover;
  if (vHl > 1.5) c = uPick;
  else if (vHl > 0.5) c = uHover;
  gl_FragColor = vec4(c * uAmbient + df * c * uDiffuse + sf * uColor * uSpecular, 1.0);
  #ifdef HATCH
  // Section caps: diagonal hatching, as a cut face is drawn in CAD (one line every HATCH_GAP css px).
  if (mod(gl_FragCoord.x + gl_FragCoord.y, uHatchGap) < uHatchWidth) gl_FragColor.rgb *= HATCH_SHADE;
  #endif
}
`;

export interface BodyMaterial extends ShaderMaterial {
  uniforms: {
    uColor: { value: Vector3 };
    uHover: { value: Vector3 };
    uPick: { value: Vector3 };
    uBodyPick: { value: Vector3 };
    /** 0 normal, 1 hovered (whole body), 2 selected (whole body). */
    uBodyState: { value: number };
    uAmbient: { value: number };
    uDiffuse: { value: number };
    uSpecular: { value: number };
    uPower: { value: number };
  };
}

/** Hatch of a section cap: every HATCH_GAP_PX css px, HATCH_WIDTH_PX wide, at HATCH_SHADE of the lit colour. */
export const HATCH_GAP_PX = 7;
export const HATCH_WIDTH_PX = 1.5;
export const HATCH_SHADE = 0.62;

/** A body surface's polygon offset units: pushed back so its B-rep edges win. */
export const BODY_OFFSET_UNITS = 4;
/** The same for a body with a highlight on it: less, so it wins over a coplanar face of another body. */
export const BODY_LIT_OFFSET_UNITS = 1;

/**
 * A body's surface. Pushed back a little (polygon offset) so the B-rep edges
 * drawn on it win the depth test, as the core pulls its edge lines forward
 * (runtime.js:17548-17561).
 */
export function createBodyMaterial(
  color: number,
  light: { ambient: number; diffuse: number; specular: number; power: number } = BODY_LIGHT,
  opts: { hatchPixelRatio?: number } = {},
): BodyMaterial {
  const hatch = opts.hatchPixelRatio;
  const m = new ShaderMaterial({
    defines: hatch ? { HATCH: 1, HATCH_SHADE: HATCH_SHADE.toFixed(3) } : {},
    vertexShader: BODY_VS,
    fragmentShader: BODY_FS,
    side: DoubleSide,
    clipping: true,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: BODY_OFFSET_UNITS,
    uniforms: {
      uColor: { value: v3(color) },
      uHover: { value: v3(HOVER_COLOR) },
      uPick: { value: v3(PICK_COLOR) },
      uBodyPick: { value: v3(BODY_SELECTED_COLOR) },
      uBodyState: { value: 0 },
      uAmbient: { value: light.ambient },
      uDiffuse: { value: light.diffuse },
      uSpecular: { value: light.specular },
      uPower: { value: light.power },
      uHatchGap: { value: HATCH_GAP_PX * (hatch ?? 1) },
      uHatchWidth: { value: HATCH_WIDTH_PX * (hatch ?? 1) },
    },
  }) as BodyMaterial;
  return m;
}

export function setBodyColor(m: BodyMaterial, color: number): void {
  m.uniforms.uColor.value.set(...rgb01(color));
}

/** Clipping planes on a material (section view); a material rebuilds only when the count changes. */
export function setClipping(m: { clippingPlanes: Plane[] | null; needsUpdate: boolean }, planes: Plane[] | null): void {
  const had = m.clippingPlanes ? m.clippingPlanes.length : 0;
  const has = planes ? planes.length : 0;
  m.clippingPlanes = planes;
  if (had !== has) m.needsUpdate = true;
}

const POINTS_VS = /* glsl */ `
#include <common>
#include <clipping_planes_pars_vertex>
attribute vec3 color;
uniform float uSize;
uniform float uPixelRatio;
varying vec3 vColor;
void main() {
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  // A little towards the camera so a marker on a surface is not buried in it.
  gl_Position.z -= 2e-4 * gl_Position.w;
  gl_PointSize = uSize * uPixelRatio;
  vColor = color;
  #include <clipping_planes_vertex>
}
`;

const POINTS_FS = /* glsl */ `
#include <common>
#include <clipping_planes_pars_fragment>
varying vec3 vColor;
void main() {
  #include <clipping_planes_fragment>
  vec2 d = gl_PointCoord - vec2(0.5);
  float r2 = dot(d, d);
  if (r2 > 0.25) discard;
  // A lit sphere look, like the core's vertex marker (headlight, ambient .9, diffuse .25).
  float nz = sqrt(max(0.0, 1.0 - 4.0 * r2));
  gl_FragColor = vec4(vColor * (0.9 + 0.25 * nz), 1.0);
}
`;

/** Round screen-size markers for B-rep vertices (per-point colour). */
export function createPointsMaterial(sizePx: number, pixelRatio: number): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader: POINTS_VS,
    fragmentShader: POINTS_FS,
    clipping: true,
    uniforms: { uSize: { value: sizePx }, uPixelRatio: { value: pixelRatio } },
  });
}
