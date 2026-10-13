// Presets whose real Reynolds number the grid resolves: no model, no floor; the flow is the
// real one (in two dimensions), and each comes with published values to compare against.
// Water, a 2 cm body in a tank 45 diameters long and 30 high (its edges open: the published
// values are for a body in unbounded flow, and a tank a body fills 1/30 of raises drag and the
// shedding frequency by well under 1 %), 12 diameters from the inlet, on the high grid (30 cells
// across the body: finer grids change the values by under 0.5 %), the speed set for the
// Reynolds number.
// SPDX-License-Identifier: GPL-3.0-or-later
import { defaultScene, FLUIDS, newBodyId, type Scene } from './scene';
import type { Shape } from '../geometry/shapes';

/** A published range for one measured quantity. */
export type Range = [number, number];

export interface Preset {
  id: string;
  title: string;
  /** What the flow does, in a sentence or two. */
  summary: string;
  /** What the 2D result does not include, when it matters. */
  caveat?: string;
  build(): Scene;
  /** Published values: Strouhal number, mean drag, lift amplitude, recirculation length (diameters). */
  refs: { st?: Range; cd?: Range; clAmp?: Range; wake?: Range };
  sources: string;
  /** Convective times (D / U) the flow needs before the measurement means anything. */
  settle: number;
  /** Over how many convective times the measurement is averaged. */
  window: number;
}

const D = 0.02;
const NU = FLUIDS.water.nu;
/** The tank (diameters): its length and height, and how far the body sits from the inlet. */
const TANK = { length: 45, height: 30, x: 12 };

function scene(re: number, shape: Shape, name: string, opts: { streamlines?: boolean } = {}): Scene {
  const d = defaultScene();
  return {
    ...d,
    tunnel: { ...d.tunnel, length: TANK.length * D, height: TANK.height * D, walls: 'farfield', resolution: 'high', refine: 0 },
    flow: { speed: (re * NU) / D, fluid: 'water', model: 'resolved' },
    bodies: [{ id: newBodyId(), name, shape, x: TANK.x * D, y: (TANK.height / 2) * D, angle: 0, spin: 0, enabled: true, locked: false }],
    rakes: [],
    view: { ...d.view, field: 'vorticity', autoRange: true, streamlines: !!opts.streamlines, tracers: false },
  };
}

const circle: Shape = { kind: 'circle', diameter: D };

export const PRESETS: Preset[] = [
  {
    id: 'cylinder-re20',
    title: 'Cylinder, Re 20: a steady wake',
    summary: 'Slow flow past a cylinder: a small pair of standing vortices sits behind it and nothing sheds.',
    build: () => ({ ...scene(20, circle, 'Cylinder', { streamlines: true }), preset: 'cylinder-re20' }),
    refs: { cd: [1.99, 2.15], wake: [0.88, 0.97] },
    sources: 'Dennis & Chang 1970; Fornberg 1980; Park, Kwon & Choi 1998.',
    settle: 120,
    window: 20,
  },
  {
    id: 'cylinder-re40',
    title: 'Cylinder, Re 40: twin vortices',
    summary: 'The standing vortex pair has grown to over two diameters long, still steady: the last Reynolds number before the wake starts to shed.',
    build: () => ({ ...scene(40, circle, 'Cylinder', { streamlines: true }), preset: 'cylinder-re40' }),
    refs: { cd: [1.5, 1.6], wake: [2.13, 2.35] },
    sources: 'Dennis & Chang 1970; Fornberg 1980; Park, Kwon & Choi 1998; Tritton 1959 (experiment).',
    settle: 160,
    window: 20,
  },
  {
    id: 'cylinder-re100',
    title: 'Cylinder, Re 100: the Kármán vortex street',
    summary: 'The wake sheds vortices from each side in turn, at a Strouhal number of about 0.165, and the cylinder feels a lift that swings with them.',
    build: () => ({ ...scene(100, circle, 'Cylinder'), preset: 'cylinder-re100' }),
    refs: { st: [0.162, 0.168], cd: [1.31, 1.37], clAmp: [0.31, 0.35] },
    sources: 'Williamson 1996 (experiment, St); Park, Kwon & Choi 1998; Posdziech & Grundmann 2007; Qu et al. 2013.',
    settle: 120,
    window: 40,
  },
  {
    id: 'cylinder-re200',
    title: 'Cylinder, Re 200: a stronger street',
    summary: 'Shedding is faster (St about 0.196) and the lift swing about twice as large as at Re 100.',
    caveat: 'A real cylinder wake turns three-dimensional from Re about 190: this is the two-dimensional flow, which the published 2D simulations match, not an experiment.',
    build: () => ({ ...scene(200, circle, 'Cylinder'), preset: 'cylinder-re200' }),
    refs: { st: [0.19, 0.2], cd: [1.3, 1.4], clAmp: [0.64, 0.72] },
    sources: 'Braza, Chassaing & Ha Minh 1986; Henderson 1995 (2D); Posdziech & Grundmann 2007.',
    settle: 100,
    window: 30,
  },
  {
    id: 'square-re100',
    title: 'Square cylinder, Re 100',
    summary: 'A square cylinder, a face to the flow: the flow leaves at its sharp front corners, and the street sheds more slowly than a round cylinder’s (St about 0.146).',
    build: () => ({ ...scene(100, { kind: 'rect', width: D, height: D }, 'Square cylinder'), preset: 'square-re100' }),
    refs: { st: [0.141, 0.15], cd: [1.45, 1.53] },
    sources: 'Sohankar, Norberg & Davidson 1998; Sharma & Eswaran 2004.',
    settle: 120,
    window: 40,
  },
];

export function presetById(id: string | null | undefined): Preset | null {
  return PRESETS.find((p) => p.id === id) ?? null;
}

/**
 * Whether a scene is still its preset's setup (the tunnel, the flow and the bodies as built;
 * the view, markers, resolution and refinement may differ): the published values apply only then.
 */
export function matchesPreset(s: Scene, p: Preset): boolean {
  const ref = p.build();
  const near = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));
  if (!near(s.tunnel.length, ref.tunnel.length) || !near(s.tunnel.height, ref.tunnel.height) || s.tunnel.walls !== ref.tunnel.walls) return false;
  if (!near(s.flow.speed, ref.flow.speed) || s.flow.fluid !== ref.flow.fluid || s.flow.model === 'sa') return false;
  const live = s.bodies.filter((b) => b.enabled);
  if (live.length !== ref.bodies.length) return false;
  return live.every((b, i) => {
    const r = ref.bodies[i];
    return JSON.stringify(b.shape) === JSON.stringify(r.shape) && near(b.x, r.x) && near(b.y, r.y) && near(b.angle, r.angle) && b.spin === 0;
  });
}
