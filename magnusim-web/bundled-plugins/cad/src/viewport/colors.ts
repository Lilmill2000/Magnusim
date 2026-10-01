// The core 3D viewer's values the Part viewport copies, with where they come
// from (magnusim-web/src/workbench/runtime.js unless noted; line numbers at
// snapshot HEAD cff8aaa). Colours are sRGB; the shaders use them as vtk.js does
// (no linearisation), so a face lights to the same pixel as in the core.
// Owner: VIEWPORT.
// SPDX-License-Identifier: GPL-3.0-or-later

/** vtkFullScreenRenderWindow background [0.94, 0.95, 0.97] (runtime.js:1031). */
export const VIEWPORT_BG = 0xf0f2f7;
/** CAD body colour [0.74, 0.79, 0.86] (runtime.js:17532, CAD_COLOR 17708). */
export const BODY_COLOR = 0xbdc9db;
/** Body material: ambient .16, diffuse .78, specular .22, power 28, Phong (runtime.js:17534-17538). */
export const BODY_LIGHT = { ambient: 0.16, diffuse: 0.78, specular: 0.22, power: 28 } as const;
/** CAD edges [0.04, 0.045, 0.055], line width 2.4, unlit (runtime.js:17565-17568, 17686-17687). */
export const EDGE_COLOR = 0x0a0b0e;
export const EDGE_WIDTH_PX = 2.4;
/** The current pick on a face, rgb(46, 196, 126) (runtime.js:17813-17815). */
export const PICK_COLOR = 0x2ec47e;
/** A picked edge: lit tube [0.18, 0.77, 0.49], 3.2 CSS px across (runtime.js:17585, EDGE_MARK_CSS_PX 22804). */
export const PICK_EDGE_COLOR = 0x2ec47d;
export const PICK_EDGE_WIDTH_PX = 3.2;
/** A picked vertex: sphere [0.10, 0.84, 0.46], 11 CSS px across (runtime.js:17597, VERTEX_MARK_CSS_PX 22801). */
export const PICK_VERTEX_COLOR = 0x1ad675;
export const PICK_VERTEX_PX = 11;
/** A selected body, CAD_HIGHLIGHT [0.28, 0.52, 0.92] (runtime.js:17709). */
export const BODY_SELECTED_COLOR = 0x4785eb;
/** Faces in the set being edited, rgb(72, 132, 235) (runtime.js:17824-17826). */
export const SET_COLOR = 0x4884eb;
/** Hover pre-highlight: the core has none; proposal §3.2 / ARCHITECTURE §7 approve --mg-selected-border #b2ccff. */
export const HOVER_COLOR = 0xb2ccff;
/** Orientation triad arrows X / Y / Z (runtime.js:1115-1120), 72 px, bottom-right (runtime.js:1127-1132). */
export const TRIAD_COLORS = [0xdc2828, 0x24a840, 0x2860dc] as const;
export const TRIAD_PX = 72;
/** Default camera direction, from front-left and slightly above, Z up (runtime.js:9118, 9372). */
export const HOME_DIR: [number, number, number] = [-0.55, -0.75, 0.42];
/** vtk.js camera view angle (vtkCamera default 30 deg; resetCamera frames the bounding sphere at r / sin(15 deg)). */
export const FOV_DEG = 30;

/** Mouse: a left click moves at most 5 px (ARCHITECTURE §7, runtime.js:16099); a right click at most 16 px (runtime.js:1505-1512). */
export const CLICK_PX = 5;
export const RIGHT_CLICK_PX = 16;
/** Edges and vertices are picked in screen space within this many CSS px (proposal §4.7; the core uses 7 / 10, runtime.js:22802-22803). */
export const PICK_TOL_PX = 8;
/** A vertex beats an edge when it is at most this much farther than the edge (px): vertices are small targets. */
export const VERTEX_BONUS_PX = 4;

/** Origin planes (no core precedent): a light fill in the set blue, a firmer border; hover and pick as for faces. */
export const PLANE_FILL = { color: SET_COLOR, opacity: 0.07 } as const;
export const PLANE_BORDER = { color: SET_COLOR, opacity: 0.55 } as const;
export const PLANE_HOVER_FILL = { color: HOVER_COLOR, opacity: 0.45 } as const;
export const PLANE_PICK_FILL = { color: PICK_COLOR, opacity: 0.28 } as const;

/** "#rrggbb" -> 0xrrggbb (the body colour when the string is not a colour). */
export function parseHex(color: string | undefined): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(color ?? '').trim());
  return m ? parseInt(m[1], 16) : BODY_COLOR;
}

/** 0xrrggbb -> [r, g, b] in 0..1 (sRGB, not linearised). */
export function rgb01(hex: number): [number, number, number] {
  return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
}
