// The tunnel's scene: what a study keeps (studies/<id>/scene.json through ws.files).
// SI units throughout. The flow itself is not kept: it starts again when the tunnel opens.
// World frame: x downstream from the inlet, y up from the bottom wall, metres.
// SPDX-License-Identifier: GPL-3.0-or-later
import { parseCode } from '../geometry/naca';
import { MAX_POINTS, MIN_POINTS } from '../geometry/datfile';
import { referenceLength, type Shape } from '../geometry/shapes';

/**
 * 2: rakes, and the view's tracers, trail, arrows and streamlines; 3: the flow model (older
 * files read as is, with the model automatic).
 */
export const SCENE_VERSION = 3;

export type Walls = 'farfield' | 'slip' | 'noslip' | 'periodic';
export type Resolution = 'auto' | 'low' | 'medium' | 'high' | 'ultra';
export type FieldMode = 'particles' | 'vorticity' | 'speed' | 'pressure' | 'schlieren' | 'rheoscopic' | 'none';
/** What colours the particles in the particles view. */
export type ParticleColor = 'speed' | 'vorticity';
export type RheoPreset = 'kalliroscope' | 'pearl' | 'copper';
export type RakeKind = 'streaks' | 'timelines' | 'dye';
export type Density = 'low' | 'normal' | 'high';
export type TrailLength = 'off' | 'short' | 'long';
export type FluidKey = 'air' | 'water';
export type SimSpeed = 'max' | 'realtime';
/**
 * How the flow is simulated: 'resolved' runs the grid's own Reynolds number (exact when the
 * grid resolves the real one); 'sa' the Spalart–Allmaras turbulence model with wall
 * functions at the real one; 'auto' picks by the real Reynolds number.
 */
export type FlowModel = 'auto' | 'resolved' | 'sa';

export interface Body {
  id: string;
  name: string;
  shape: Shape;
  /** The pivot's position (m). */
  x: number;
  y: number;
  /** Degrees, positive nose up (clockwise with the wind from the left). */
  angle: number;
  /** Turning rate (rad/s), positive counter-clockwise. */
  spin: number;
  /** In the flow (false: kept in the list, out of the tunnel). */
  enabled: boolean;
  locked: boolean;
}

/** A rake: a line of emitters that release streaks, timelines or dye into the flow. */
export interface Rake {
  id: string;
  kind: RakeKind;
  /** Its ends (m). */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  emitters: number;
  /** Index into the rake colours (the app's series colours). */
  color: number;
  enabled: boolean;
}

export interface View {
  field: FieldMode;
  autoRange: boolean;
  min: number;
  max: number;
  speed: SimSpeed;
  tracers: boolean;
  density: Density;
  trail: TrailLength;
  arrows: boolean;
  streamlines: boolean;
  rheoPreset: RheoPreset;
  particleColor: ParticleColor;
}

export interface Scene {
  version: number;
  tunnel: { length: number; height: number; walls: Walls; resolution: Resolution };
  flow: { speed: number; fluid: FluidKey; model: FlowModel };
  bodies: Body[];
  rakes: Rake[];
  view: View;
}

export const FLUIDS: Record<FluidKey, { label: string; nu: number; rho: number }> = {
  air: { label: 'Air (20 °C)', nu: 1.516e-5, rho: 1.204 },
  water: { label: 'Water (20 °C)', nu: 1.004e-6, rho: 998.2 },
};

export const LIMITS = {
  length: [0.01, 1000] as const,
  height: [0.005, 1000] as const,
  speed: [1e-4, 340] as const,
  maxBodies: 8,
  maxRakes: 8,
  /** Dye rakes: one colour channel each. */
  maxDyeRakes: 4,
  emitters: [1, 64] as const,
};

export const RAKE_COLORS = 6;

let seq = 0;
export function newBodyId(): string {
  seq = (seq + 1) % 1e6;
  return `b${Date.now().toString(36)}${seq.toString(36)}`;
}

export function newRakeId(): string {
  seq = (seq + 1) % 1e6;
  return `r${Date.now().toString(36)}${seq.toString(36)}`;
}

export function defaultScene(): Scene {
  return {
    version: SCENE_VERSION,
    tunnel: { length: 8, height: 4, walls: 'farfield', resolution: 'auto' },
    flow: { speed: 10, fluid: 'air', model: 'auto' },
    bodies: [
      { id: newBodyId(), name: 'NACA 2412', shape: { kind: 'naca', code: '2412', chord: 1 }, x: 2.5, y: 2, angle: 6, spin: 0, enabled: true, locked: false },
    ],
    rakes: [],
    view: {
      field: 'particles',
      autoRange: true,
      min: -10,
      max: 10,
      speed: 'max',
      tracers: false,
      density: 'normal',
      trail: 'short',
      arrows: false,
      streamlines: false,
      rheoPreset: 'kalliroscope',
      particleColor: 'speed',
    },
  };
}

/** At or above this real Reynolds number the automatic flow model is the turbulence model. */
export const TURBULENT_RE = 1e5;

/** The flow model a scene runs ('off': resolved): as chosen, or (automatic) by the largest real Reynolds number of its bodies. */
export function flowModelFor(scene: Scene): 'off' | 'sa' {
  if (scene.flow.model !== 'auto') return scene.flow.model === 'sa' ? 'sa' : 'off';
  const nu = FLUIDS[scene.flow.fluid].nu;
  const re = Math.max(0, ...scene.bodies.filter((b) => b.enabled).map((b) => (scene.flow.speed * referenceLength(b.shape)) / nu));
  return re >= TURBULENT_RE ? 'sa' : 'off';
}

export class SceneError extends Error {}

const num = (v: unknown, what: string, lo = -Infinity, hi = Infinity): number => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < lo || n > hi) throw new SceneError(`${what} must be a number from ${lo} to ${hi}.`);
  return n;
};
const oneOf = <T extends string>(v: unknown, opts: readonly T[], fallback: T): T => (opts.includes(v as T) ? (v as T) : fallback);

function parseShape(s: unknown): Shape {
  const o = (s ?? {}) as Record<string, unknown>;
  switch (o.kind) {
    case 'naca':
      return { kind: 'naca', code: parseCode(String(o.code)), chord: num(o.chord, 'Chord', 1e-4, 1000) };
    case 'dat': {
      const x = Array.isArray(o.x) ? o.x.map(Number) : [];
      const y = Array.isArray(o.y) ? o.y.map(Number) : [];
      if (x.length !== y.length || x.length < MIN_POINTS || x.length > MAX_POINTS || ![...x, ...y].every(Number.isFinite)) {
        throw new SceneError('An imported airfoil needs matching x and y lists of finite numbers.');
      }
      return { kind: 'dat', name: String(o.name ?? 'Imported airfoil').slice(0, 80), x, y, chord: num(o.chord, 'Chord', 1e-4, 1000) };
    }
    case 'circle':
      return { kind: 'circle', diameter: num(o.diameter, 'Diameter', 1e-4, 1000) };
    case 'rect':
      return { kind: 'rect', width: num(o.width, 'Width', 1e-4, 1000), height: num(o.height, 'Height', 1e-4, 1000) };
    case 'ellipse':
      return { kind: 'ellipse', width: num(o.width, 'Width', 1e-4, 1000), height: num(o.height, 'Height', 1e-4, 1000) };
    case 'plate':
      return { kind: 'plate', length: num(o.length, 'Length', 1e-4, 1000), thickness: num(o.thickness, 'Thickness', 1e-5, 1000) };
    default:
      throw new SceneError(`Unknown body shape “${String(o.kind)}”.`);
  }
}

/** A scene read from a file: checked, with defaults for what is missing. Throws SceneError. */
export function parseScene(raw: unknown): Scene {
  const o = (raw ?? {}) as Record<string, any>;
  const version = Number(o.version ?? SCENE_VERSION);
  if (version > SCENE_VERSION) throw new SceneError(`This tunnel was saved by a newer version of the plugin (scene version ${version}).`);
  const d = defaultScene();
  const t = o.tunnel ?? {};
  const f = o.flow ?? {};
  const v = o.view ?? {};
  const bodies: Body[] = (Array.isArray(o.bodies) ? o.bodies : []).slice(0, LIMITS.maxBodies).map((b: any) => ({
    id: typeof b?.id === 'string' && b.id ? b.id.slice(0, 40) : newBodyId(),
    name: String(b?.name ?? 'Body').slice(0, 80),
    shape: parseShape(b?.shape),
    x: num(b?.x, 'Body x'),
    y: num(b?.y, 'Body y'),
    angle: num(b?.angle ?? 0, 'Body angle', -3600, 3600),
    spin: num(b?.spin ?? 0, 'Body spin', -1e4, 1e4),
    enabled: b?.enabled !== false,
    locked: b?.locked === true,
  }));
  const rakes: Rake[] = (Array.isArray(o.rakes) ? o.rakes : []).slice(0, LIMITS.maxRakes).map((r: any, i: number) => ({
    id: typeof r?.id === 'string' && r.id ? r.id.slice(0, 40) : newRakeId(),
    kind: oneOf(r?.kind, ['streaks', 'timelines', 'dye'] as const, 'streaks'),
    x0: num(r?.x0, 'Rake x'),
    y0: num(r?.y0, 'Rake y'),
    x1: num(r?.x1, 'Rake x'),
    y1: num(r?.y1, 'Rake y'),
    emitters: Math.round(num(r?.emitters ?? 12, 'Rake emitters', ...LIMITS.emitters)),
    color: Math.round(num(r?.color ?? i % RAKE_COLORS, 'Rake colour', 0, RAKE_COLORS - 1)),
    enabled: r?.enabled !== false,
  }));
  return {
    version: SCENE_VERSION,
    tunnel: {
      length: num(t.length ?? d.tunnel.length, 'Tunnel length', ...LIMITS.length),
      height: num(t.height ?? d.tunnel.height, 'Tunnel height', ...LIMITS.height),
      walls: oneOf(t.walls, ['farfield', 'slip', 'noslip', 'periodic'] as const, d.tunnel.walls),
      resolution: oneOf(t.resolution, ['auto', 'low', 'medium', 'high', 'ultra'] as const, d.tunnel.resolution),
    },
    flow: {
      speed: num(f.speed ?? d.flow.speed, 'Wind speed', ...LIMITS.speed),
      fluid: oneOf(f.fluid, ['air', 'water'] as const, d.flow.fluid),
      model: oneOf(f.model, ['auto', 'resolved', 'sa'] as const, d.flow.model),
    },
    bodies,
    rakes,
    view: {
      field: oneOf(v.field, ['particles', 'vorticity', 'speed', 'pressure', 'schlieren', 'rheoscopic', 'none'] as const, d.view.field),
      autoRange: v.autoRange !== false,
      min: Number.isFinite(Number(v.min)) ? Number(v.min) : d.view.min,
      max: Number.isFinite(Number(v.max)) ? Number(v.max) : d.view.max,
      speed: oneOf(v.speed, ['max', 'realtime'] as const, d.view.speed),
      tracers: v.tracers === true,
      density: oneOf(v.density, ['low', 'normal', 'high'] as const, d.view.density),
      trail: oneOf(v.trail, ['off', 'short', 'long'] as const, d.view.trail),
      arrows: v.arrows === true,
      streamlines: v.streamlines === true,
      rheoPreset: oneOf(v.rheoPreset, ['kalliroscope', 'pearl', 'copper'] as const, d.view.rheoPreset),
      particleColor: oneOf(v.particleColor, ['speed', 'vorticity'] as const, d.view.particleColor),
    },
  };
}
