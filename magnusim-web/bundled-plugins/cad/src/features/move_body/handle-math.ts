// Move/copy body's drag handle, its math (no three.js, no DOM; tests/features/move_body/
// move-body-handle.test.ts): where the handle sits, what a drag along an arrow or round a ring
// sets in the panel's fields, how the bodies are drawn meanwhile.
//   Where       the pivot after the move: the turn goes about a line through the pivot, so the
//               pivot only moves by Move X, Y, Z (turn, then move = move, then turn about the
//               moved line). The pivot is the typed one, else the centre of the bodies' box just
//               before the feature; about a picked axis, the point of that axis nearest the centre.
//   An arrow    Move X, Y or Z: what it had plus how far the pointer went along it (the point of
//               the arrow's line nearest the pointer's ray, as the Extrude's arrow).
//   A ring      the Angle about its axis: the pointer's ray meets the ring's plane; the angle it
//               went round the pivot (right hand about the axis), added up move by move so a drag
//               of more than half a turn keeps counting. A ring about another of X, Y, Z than
//               About turns About to it and starts from no turn: the feature turns about one axis.
//   Rounded     to what a pixel means at that zoom, in the Part's display unit (the Extrude's and
//               the Enclosure's arrows); with Ctrl held, to whole steps: 1 mm (0.1 in, 0.01 ft), 15 deg.
//   Drawn       the bodies as built carry `shown` (the feature's transform when it is built, else
//               none); the preview draws them moved by target * shown^-1, a rigid motion on the
//               view's side (no rebuild, no kernel call per mouse move).
// Owner: P2-FEATURES.
// SPDX-License-Identifier: GPL-3.0-or-later
import { deriveBodyId } from '../../doc/features/body-ids';
import type { BodyId, MoveAbout, MoveBodyFeature, Vec3 } from '../../types/doc';
import type { DocState, MoveBodyOutput } from '../../types/doc-service';
import type { DocUnits, LengthUnit, UnitsService } from '../../types/units';
import { DEG_PER, exprToStore, MM_PER } from '../../ui/kit/format';
import { roundedDistance } from '../extrude/handle';
import { compose, IDENTITY, type Mat } from '../pattern/transforms';
import { moveBodyDef, moveMatrix, type MoveValues } from './feature';

/** The handle's parts: the X, Y, Z arrows and rings, or the one ring about a picked axis. */
export type HandlePart = 'x' | 'y' | 'z' | 'ring-x' | 'ring-y' | 'ring-z' | 'ring-axis';
export type Line = { origin: Vec3; dir: Vec3 };

const WORLD: Record<'x' | 'y' | 'z', Vec3> = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
export const AXES = ['x', 'y', 'z'] as const;
/** Whole steps Ctrl snaps lengths to, in the display unit: a millimetre (a tenth of an inch, a hundredth of a foot). */
export const SNAP_LENGTH: Record<LengthUnit, number> = { mm: 1, cm: 0.1, m: 0.001, in: 0.1, ft: 0.01 };
/** Ctrl's length step in words ("1 mm", "0.1 in"): a whole millimetre in a metric Part. */
export const snapLengthWords = (u: LengthUnit): string => (u === 'in' || u === 'ft' ? `${SNAP_LENGTH[u]} ${u}` : '1 mm');
/** Whole steps Ctrl snaps angles to (degrees). */
export const SNAP_DEG = 15;
/** A ring seen this close to edge on (|cos| of its axis to the view) is not drawn: its angle cannot be read. */
export const EDGE_ON = 0.1;

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** The world direction of an arrow or a ring about X, Y or Z. */
export const worldAxis = (a: 'x' | 'y' | 'z'): Vec3 => WORLD[a];

/** Two unit vectors across `axis`: u, and v = axis x u (a turn by +a takes u towards v). */
export function basisOf(axis: Vec3): { u: Vec3; v: Vec3 } {
  const a = unit(axis);
  const k = [0, 1, 2].reduce((best, i) => (Math.abs(a[i]) < Math.abs(a[best]) - 1e-12 ? i : best), 0);
  const e: Vec3 = [0, 0, 0];
  e[k] = 1;
  const d = dot(e, a);
  const u = unit([e[0] - d * a[0], e[1] - d * a[1], e[2] - d * a[2]]);
  return { u, v: cross(a, u) };
}

/** Where a ray meets the ring's plane, as an angle round `origin` from u towards v (radians); null when it runs nearly along the plane. */
export function ringPhase(origin: Vec3, axis: Vec3, ray: { origin: Vec3; dir: Vec3 }): number | null {
  const a = unit(axis);
  const d = unit(ray.dir);
  const den = dot(d, a);
  if (Math.abs(den) < EDGE_ON * 0.5) return null;
  const s = dot(sub(origin, ray.origin), a) / den;
  const p: Vec3 = [ray.origin[0] + d[0] * s - origin[0], ray.origin[1] + d[1] * s - origin[1], ray.origin[2] + d[2] * s - origin[2]];
  const { u, v } = basisOf(a);
  if (Math.hypot(dot(p, u), dot(p, v)) < 1e-12) return null;
  return Math.atan2(dot(p, v), dot(p, u));
}

/** An angle step into (-pi, pi]: how far the pointer went round since the last move. */
export function wrapPi(a: number): number {
  let x = a % (2 * Math.PI);
  if (x <= -Math.PI) x += 2 * Math.PI;
  if (x > Math.PI) x -= 2 * Math.PI;
  return x;
}

/** A number to store, without float noise ("12.5", "0.1"). */
const clean = (n: number, decimals: number) => String(Number(n.toFixed(Math.min(12, Math.max(0, decimals)))) + 0);

/** A dragged length (mm): rounded to a pixel's step in the display unit, or with `snap` to SNAP_LENGTH. */
export function lengthValue(mm: number, pixelMm: number, units: DocUnits, snap: boolean): { expr: string; mm: number } {
  if (!snap) return roundedDistance(mm, pixelMm, units);
  const per = MM_PER[units.length];
  const step = SNAP_LENGTH[units.length];
  const decimals = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
  const n = Number(clean(Math.round(mm / per / step) * step, decimals));
  return { expr: exprToStore(String(n), 'length', units), mm: n * per };
}

/** A dragged angle (deg): rounded to the step one pixel round the ring means (`degPerPx`), or with `snap` to SNAP_DEG. */
export function angleValue(deg: number, degPerPx: number, units: DocUnits, snap: boolean): { expr: string; deg: number } {
  const per = DEG_PER[units.angle];
  if (snap) {
    const d = Math.round(deg / SNAP_DEG) * SNAP_DEG;
    const n = Number(clean(d / per, 10));
    return { expr: exprToStore(String(n), 'angle', units), deg: n * per };
  }
  const px = Math.max(degPerPx / per, 1e-9);
  const step = Math.pow(10, Math.floor(Math.log10(px)));
  const decimals = Math.max(0, -Math.floor(Math.log10(step)));
  const n = Number(clean(Math.round(deg / per / step) * step, decimals));
  return { expr: exprToStore(String(n), 'angle', units), deg: n * per };
}

/** The inverse of a rigid motion (a turn and a move; 3x4 row-major as the kernel's `copies`). */
export function invertRigid(m: Mat): Mat {
  const r = [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]];
  const t: Vec3 = [m[3], m[7], m[11]];
  // R^T, -R^T t
  const it = [0, 1, 2].map((j) => -(r[j] * t[0] + r[3 + j] * t[1] + r[6 + j] * t[2]));
  return [r[0], r[3], r[6], it[0], r[1], r[4], r[7], it[1], r[2], r[5], r[8], it[2]];
}

/** How the preview draws bodies drawn at `shown` so they stand at `target`. */
export const previewMatrix = (target: Mat, shown: Mat): Mat => compose(target, invertRigid(shown));

/** Two transforms the same within `tol` (mm, and the same in the rotation's terms). */
export function sameMatrix(a: Mat, b: Mat, tol = 1e-6): boolean {
  return a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) <= tol);
}

export const isIdentity = (m: Mat, tol = 1e-9) => sameMatrix(m, IDENTITY, tol);

/** The point of `line` nearest `p`. */
export function nearestOnLine(line: Line, p: Vec3): Vec3 {
  const d = unit(line.dir);
  const s = dot(sub(p, line.origin), d);
  return [line.origin[0] + d[0] * s, line.origin[1] + d[1] * s, line.origin[2] + d[2] * s];
}

/** The centre of the union of the boxes ([xmin, ymin, zmin, xmax, ymax, zmax]), or null. */
export function boxCentre(boxes: readonly (readonly number[])[]): Vec3 | null {
  if (!boxes.length) return null;
  const lo = [0, 1, 2].map((k) => Math.min(...boxes.map((b) => b[k])));
  const hi = [0, 1, 2].map((k) => Math.max(...boxes.map((b) => b[k + 3])));
  const c = [0, 1, 2].map((k) => (lo[k] + hi[k]) / 2);
  return c.every(Number.isFinite) ? (c as Vec3) : null;
}

/** What is drawn now: the transform the bodies carry as built, and the bodies a preview moves. */
export interface Shown {
  matrix: Mat;
  bodies: BodyId[];
}

/**
 * What the view shows of the feature now. Built (its row ok or with a warning): its bodies (Keep a
 * copy: its copies) carry the transform it applied. Not built (incomplete, failed, not in the Part
 * yet): the bodies stand where they were; a copy that is not built has nothing to draw.
 */
export function shownOf(s: Pick<DocState, 'doc' | 'rebuild'>, f: MoveBodyFeature): Shown {
  const stored = s.doc.features.find((g) => g.id === f.id);
  const out = s.rebuild.outputs[f.id];
  const st = s.rebuild.features[f.id]?.state;
  if (stored?.type === 'move_body' && out?.type === 'move_body' && out.matrix && (st === 'ok' || st === 'warning')) {
    const ids = [...new Set(stored.bodies)];
    return { matrix: out.matrix, bodies: stored.copy ? ids.map((b) => deriveBodyId(stored.id, b, 1)) : ids };
  }
  return { matrix: IDENTITY, bodies: f.copy ? [] : [...new Set(f.bodies)] };
}

/** The handle as the draft places it. */
export interface HandleFrame {
  /** The pivot before the move (model mm): the typed one, the bodies' centre, or the picked axis's point nearest it. */
  pivot: Vec3;
  /** Where the handle is: the pivot after the move. */
  origin: Vec3;
  /** The draft's values (null: a field does not read: no drag). */
  values: MoveValues | null;
  /** The rings: X, Y and Z, or the picked axis alone (none while it is not found). */
  rings: { part: HandlePart; axis: Vec3 }[];
  /** The picked axis (about 'axis'), as found before the feature. */
  turnAxis: Line | null;
}

/**
 * The handle for the draft `f`. `out`: the feature's last output (its centre and picked axis as
 * found before it); `boxes`: the bodies' boxes now (the centre before anything was built);
 * `liveAxis`: the picked axis as the panel finds it when no build has.
 */
export function handleFrameOf(f: MoveBodyFeature, out: MoveBodyOutput | null, boxes: readonly { id: BodyId; bbox: readonly number[] }[], units: UnitsService, liveAxis: Line | null): HandleFrame | null {
  const centre = out?.centre ?? boxCentre(boxes.filter((b) => f.bodies.includes(b.id)).map((b) => b.bbox));
  if (!centre || !f.bodies.length) return null;
  const r = moveBodyDef.resolve(f, units);
  const values = r.ok ? r.values : null;
  let pivot: Vec3 = centre;
  let turnAxis: Line | null = null;
  const rings: HandleFrame['rings'] = [];
  if (f.about === 'axis') {
    turnAxis = (f.axis ? (out?.turnAxis ?? liveAxis) : null) ?? null;
    if (turnAxis) {
      pivot = nearestOnLine(turnAxis, centre);
      rings.push({ part: 'ring-axis', axis: unit(turnAxis.dir) });
    }
  } else {
    pivot = values?.pivot ?? centre;
    for (const a of AXES) rings.push({ part: `ring-${a}`, axis: WORLD[a] });
  }
  const move = values?.move ?? [0, 0, 0];
  return { pivot, origin: [pivot[0] + move[0], pivot[1] + move[1], pivot[2] + move[2]], values, rings, turnAxis };
}

/** The line a turn of these values goes about: X, Y or Z through the pivot, or the picked axis. */
export function turnLine(about: MoveAbout, pivot: Vec3, turnAxis: Line | null): Line | null {
  if (about === 'axis') return turnAxis ? { origin: turnAxis.origin, dir: unit(turnAxis.dir) } : null;
  return { origin: pivot, dir: WORLD[about] };
}

/** The transform of these values (turn about `line`, then move); the draft's own in the build's terms. */
export const targetMatrix = (v: MoveValues, line: Line | null): Mat => moveMatrix(v, line);

/** A drag in progress: an arrow's distance along it (mm), or a ring's turn (deg). */
export type DragAmount = { part: 'x' | 'y' | 'z'; mm: number } | { part: 'ring-x' | 'ring-y' | 'ring-z' | 'ring-axis'; deg: number };

/**
 * The fields a drag sets and the values they make. `v0`: the draft's values when it began; `f`:
 * the draft. An arrow sets its Move field; a ring the Angle (and About, for another of X, Y, Z).
 */
export function draggedFields(
  f: MoveBodyFeature,
  v0: MoveValues,
  drag: DragAmount,
  o: { pixelMm: number; degPerPx: number; units: DocUnits; snap: boolean },
): { patch: Partial<MoveBodyFeature>; values: MoveValues; about: MoveAbout; shown: { quantity: 'length' | 'angle'; value: number } } {
  if ('mm' in drag) {
    const k = AXES.indexOf(drag.part);
    const r = lengthValue(v0.move[k] + drag.mm, o.pixelMm, o.units, o.snap);
    const move = f.move.map((e, i) => (i === k ? r.expr : e)) as MoveBodyFeature['move'];
    const mv = v0.move.map((x, i) => (i === k ? r.mm : x)) as Vec3;
    return { patch: { move }, values: { ...v0, move: mv }, about: f.about, shown: { quantity: 'length', value: r.mm } };
  }
  const about: MoveAbout = drag.part === 'ring-axis' ? 'axis' : (drag.part.slice(5) as 'x' | 'y' | 'z');
  const same = about === f.about;
  const r = angleValue((same ? v0.angle : 0) + drag.deg, o.degPerPx, o.units, o.snap);
  return { patch: same ? { angle: r.expr } : { angle: r.expr, about }, values: { ...v0, angle: r.deg }, about, shown: { quantity: 'angle', value: r.deg } };
}

