// The CONSTRUCT feature types (Daniel's must-have 9; proposal §2.4): reference
// Plane, Axis and Point. Each is a history feature that makes no body and
// publishes its geometry (PlaneOutput, AxisOutput, PointOutput) for later
// features: a sketch on a plane, Revolve's axis, an extrude direction, a pattern
// axis, a mirror plane. Its inputs are stored references (src/types/references.ts)
// resolved at every rebuild, so it follows upstream edits; a lost input turns it
// red with the reason ("Plane 1 failed: End face of Extrude 1 not found on
// Body 1 after rebuild"), and the features that use it then say it did not build.
// Owner: REFERENCE (P4a).
// SPDX-License-Identifier: GPL-3.0-or-later
import { newId, nextName } from '../../lib/ids';
import type { CadDoc, ExprVec3, PlaneFrame, RefAxisFeature, RefPlaneFeature, RefPointFeature, Vec3 } from '../../types/doc';
import type { BuildContext, ExprField, FeatureBuildResult, FeatureTypeDef, ResolveResult } from '../../types/doc-service';
import type { GeomRef } from '../../types/references';
import type { Expr, LengthUnit, UnitsService } from '../../types/units';
import { edgeCrossings } from './brep';
import { resolveCurve } from './curves';
import { add, axisThrough, flipFrame, midplane, offsetPlane, planeAtAngle, planeNormalTo, planesCross, planeThrough, scale, unit, type GeomResult } from './geom';
import { refBodies, refParents, resolveAxis, resolveEdgeRef, resolveFaceRef, resolvePlane, resolvePoint, type Axis, type Resolved, wordsIn } from './resolve';

/** Outline glyphs (24 viewBox, stroke): a plane in perspective; an axis (dash-dot) through a ring; a point (asterisk). */
export const PLANE_ICON = 'M3.5 16.5l5-9h12l-5 9z';
export const AXIS_ICON = 'M4 20L20 4 M8.5 9.5a2.5 4 45 1 0 6 6';
export const POINT_ICON = 'M12 6v12 M6.8 9l10.4 6 M6.8 15l10.4-6';

const DEFAULT_OFFSET: Record<LengthUnit, Expr> = { mm: '10 mm', cm: '1 cm', m: '0.01 m', in: '0.5 in', ft: '0.5 in' };

export const PLANE_METHODS: { value: RefPlaneFeature['method']; label: string }[] = [
  { value: 'offset', label: 'Offset from a plane' },
  { value: 'angle', label: 'At an angle' },
  { value: 'three_points', label: 'Through 3 points' },
  { value: 'midplane', label: 'Midplane' },
  { value: 'normal_to_curve', label: 'Normal to a curve' },
];
export const AXIS_METHODS: { value: RefAxisFeature['method']; label: string }[] = [
  { value: 'two_points', label: 'Through 2 points' },
  // Short enough for the select (P4a review: "Axis of a cylinder or cone" was cut off).
  { value: 'cylinder', label: 'Of a round face' },
  { value: 'edge', label: 'Along an edge' },
  { value: 'two_planes', label: 'Where 2 planes cross' },
];
export const POINT_METHODS: { value: RefPointFeature['method']; label: string }[] = [
  { value: 'vertex', label: 'At a vertex' },
  { value: 'center', label: 'Centre of an arc, circle or sphere' },
  { value: 'on_edge', label: 'On an edge' },
  { value: 'edge_plane', label: 'Where an edge crosses a plane' },
  { value: 'coordinates', label: 'Coordinates' },
];

type Num = { ok: true; value: number } | { ok: false; message: string };
function evalField(label: string, expr: Expr, quantity: 'length' | 'angle' | 'scalar', units: UnitsService): Num {
  const r = units.evaluate(typeof expr === 'string' ? expr : String(expr ?? ''), quantity);
  return r.ok ? { ok: true, value: r.value } : { ok: false, message: `${label}: ${r.error}` };
}
function evalPercent(label: string, expr: Expr, units: UnitsService): Num {
  const r = evalField(label, expr, 'scalar', units);
  if (!r.ok) return r;
  if (!(r.value >= 0 && r.value <= 100)) return { ok: false, message: `${label} must be from 0 to 100` };
  return r;
}

const fail = (name: string, why: string): FeatureBuildResult => ({ ok: false, message: `${name} failed: ${why}` });
const warnings = (...rs: (Resolved<unknown> | null)[]) => rs.flatMap((r) => (r && r.ok && r.warning ? [r.warning] : []));
function okResult(output: NonNullable<Extract<FeatureBuildResult, { ok: true }>['output']>, warn: string[]): FeatureBuildResult {
  return { ok: true, bodies: [], removed: [], output, ...(warn.length ? { warning: warn.join('; ') } : {}) };
}
const geomFail = (name: string, r: GeomResult<unknown> & { ok: false }) => fail(name, r.message);

// ------------------------------------------------------------ Plane

/** The references a plane of this method reads (the others are kept for switching back). */
export function planeRefs(f: RefPlaneFeature): GeomRef[] {
  const out: (GeomRef | null)[] = [];
  if (f.method === 'offset') out.push(f.plane);
  else if (f.method === 'angle') out.push(f.plane, f.axis);
  else if (f.method === 'three_points') out.push(...f.points.slice(0, 3));
  else if (f.method === 'midplane') out.push(f.plane, f.plane2);
  else if (f.method === 'normal_to_curve') out.push(f.edge, ...f.points.slice(0, 1));
  return out.filter((r): r is GeomRef => !!r);
}

export function planeIncomplete(f: RefPlaneFeature): string | null {
  switch (f.method) {
    case 'offset':
      return f.plane ? null : 'Pick a plane or a flat face';
    case 'angle':
      return !f.plane ? 'Pick a plane or a flat face' : !f.axis ? 'Pick an axis or a straight edge to turn about' : null;
    case 'three_points':
      return f.points.length >= 3 ? null : `Pick ${3 - f.points.length} more point${f.points.length === 2 ? '' : 's'}`;
    case 'midplane':
      return !f.plane || !f.plane2 ? `Pick ${!f.plane && !f.plane2 ? 'two planes or flat faces' : 'a second plane or flat face'}` : null;
    case 'normal_to_curve':
      return f.edge ? null : 'Pick an edge (the curve)';
    default:
      return 'Pick how the plane is made';
  }
}

export interface PlaneValues {
  distance: number;
  angle: number;
  percent: number;
}

export const refPlaneDef: FeatureTypeDef<RefPlaneFeature, PlaneValues> = {
  type: 'ref_plane',
  label: 'Plane',
  icon: PLANE_ICON,
  create(doc: CadDoc, init = {}) {
    return {
      id: newId('f'),
      type: 'ref_plane',
      name: nextName('Plane', doc.features.map((f) => f.name)),
      method: 'offset',
      plane: null,
      plane2: null,
      axis: null,
      points: [],
      edge: null,
      distance: DEFAULT_OFFSET[doc.units.length] ?? '10 mm',
      angle: '45 deg',
      percent: '50',
      flip: false,
      ...init,
    };
  },
  resolve(f, units): ResolveResult<PlaneValues> {
    const values: PlaneValues = { distance: 0, angle: 0, percent: 0 };
    if (f.method === 'offset') {
      const d = evalField('Distance', f.distance, 'length', units);
      if (!d.ok) return d;
      values.distance = d.value;
    } else if (f.method === 'angle') {
      const a = evalField('Angle', f.angle, 'angle', units);
      if (!a.ok) return a;
      values.angle = a.value;
    } else if (f.method === 'normal_to_curve' && !f.points.length) {
      const p = evalPercent('Position', f.percent, units);
      if (!p.ok) return p;
      values.percent = p.value;
    }
    return { ok: true, values };
  },
  incomplete(f, units) {
    return planeIncomplete(f) ?? (() => {
      const r = refPlaneDef.resolve(f, units);
      return r.ok ? null : r.message;
    })();
  },
  parents: (f) => refParents(planeRefs(f)),
  uses: (f) => refBodies(planeRefs(f)),
  exprs: (f) => [
    { path: 'distance', expr: f.distance },
    { path: 'angle', expr: f.angle },
    { path: 'percent', expr: f.percent },
  ],
  mapExprs: (f, fn) => ({ ...f, distance: fn(f.distance), angle: fn(f.angle), percent: fn(f.percent) }),
  async build(f, v, ctx) {
    const missing = planeIncomplete(f);
    if (missing) return fail(f.name, missing);
    const plane = await buildPlane(f, v, ctx);
    if (!plane.ok) return fail(f.name, plane.message);
    return okResult({ type: 'plane', frame: f.flip && f.method !== 'offset' ? flipFrame(plane.value) : plane.value }, plane.warnings);
  },
};

async function buildPlane(f: RefPlaneFeature, v: PlaneValues, ctx: BuildContext): Promise<{ ok: true; value: PlaneFrame; warnings: string[] } | { ok: false; message: string }> {
  const done = (g: GeomResult<PlaneFrame>, ...rs: Resolved<unknown>[]) => (g.ok ? { ok: true as const, value: g.value, warnings: warnings(...rs) } : g);
  if (f.method === 'offset') {
    const p = await resolvePlane(f.plane!, ctx);
    if (!p.ok) return p;
    return done({ ok: true, value: offsetPlane(p.value, f.flip ? -v.distance : v.distance) }, p);
  }
  if (f.method === 'angle') {
    const p = await resolvePlane(f.plane!, ctx);
    if (!p.ok) return p;
    const a = await resolveAxis(f.axis!, ctx);
    if (!a.ok) return a;
    const g = planeAtAngle(p.value, a.value, v.angle);
    if (!g.ok) return { ok: false, message: `${wordsIn(ctx, f.axis!)} does not lie in ${wordsIn(ctx, f.plane!)} or run parallel to it` };
    return done(g, p, a);
  }
  if (f.method === 'three_points') {
    const pts: Vec3[] = [];
    const rs: Resolved<Vec3>[] = [];
    for (const ref of f.points.slice(0, 3)) {
      const r = await resolvePoint(ref, ctx);
      if (!r.ok) return r;
      rs.push(r);
      pts.push(r.value);
    }
    return done(planeThrough(pts[0], pts[1], pts[2]), ...rs);
  }
  if (f.method === 'midplane') {
    const a = await resolvePlane(f.plane!, ctx);
    if (!a.ok) return a;
    const b = await resolvePlane(f.plane2!, ctx);
    if (!b.ok) return b;
    return done(midplane(a.value, b.value), a, b);
  }
  // normal_to_curve: the curve's tangent at the point picked on it, or at `percent` of its length.
  const words = (r: GeomRef) => wordsIn(ctx, r);
  const e = await resolveCurve(f.edge!, ctx, words);
  if (!e.ok) return e;
  const rs: Resolved<unknown>[] = [e];
  let at: { point: Vec3; tangent: Vec3 };
  if (f.points.length) {
    const p = await resolvePoint(f.points[0], ctx);
    if (!p.ok) return p;
    rs.push(p);
    const near = await e.value.nearest(p.value);
    // On the curve: within a millionth of its length (a vertex at its end, a point on it).
    if (!near || near.distance > Math.max(1e-6, e.value.length * 1e-6)) return { ok: false, message: `${words(f.points[0])} is not on ${words(f.edge!)}` };
    at = near;
  } else {
    at = await e.value.at({ fraction: v.percent / 100 });
  }
  return done(planeNormalTo(at.point, at.tangent), ...rs);
}

// ------------------------------------------------------------ Axis

export function axisRefs(f: RefAxisFeature): GeomRef[] {
  const out: (GeomRef | null)[] = [];
  if (f.method === 'two_points') out.push(...f.points.slice(0, 2));
  else if (f.method === 'cylinder') out.push(f.face);
  else if (f.method === 'edge') out.push(f.edge);
  else if (f.method === 'two_planes') out.push(...f.planes.slice(0, 2));
  return out.filter((r): r is GeomRef => !!r);
}

export function axisIncomplete(f: RefAxisFeature): string | null {
  switch (f.method) {
    case 'two_points':
      return f.points.length >= 2 ? null : `Pick ${2 - f.points.length} more point${f.points.length === 1 ? '' : 's'}`;
    case 'cylinder':
      return f.face ? null : 'Pick a cylindrical or conical face';
    case 'edge':
      return f.edge ? null : 'Pick a straight or round edge';
    case 'two_planes':
      return f.planes.length >= 2 ? null : `Pick ${f.planes.length ? 'a second plane or flat face' : 'two planes or flat faces'}`;
    default:
      return 'Pick how the axis is made';
  }
}

export const refAxisDef: FeatureTypeDef<RefAxisFeature, Record<string, never>> = {
  type: 'ref_axis',
  label: 'Axis',
  icon: AXIS_ICON,
  create(doc, init = {}) {
    return { id: newId('f'), type: 'ref_axis', name: nextName('Axis', doc.features.map((f) => f.name)), method: 'two_points', points: [], face: null, edge: null, planes: [], flip: false, ...init };
  },
  resolve: () => ({ ok: true, values: {} }),
  incomplete: (f) => axisIncomplete(f),
  parents: (f) => refParents(axisRefs(f)),
  uses: (f) => refBodies(axisRefs(f)),
  exprs: () => [],
  mapExprs: (f) => f,
  async build(f, _v, ctx) {
    const missing = axisIncomplete(f);
    if (missing) return fail(f.name, missing);
    let axis: Resolved<Axis>;
    let warn: string[] = [];
    if (f.method === 'two_points') {
      const a = await resolvePoint(f.points[0], ctx);
      if (!a.ok) return fail(f.name, a.message);
      const b = await resolvePoint(f.points[1], ctx);
      if (!b.ok) return fail(f.name, b.message);
      const g = axisThrough(a.value, b.value);
      if (!g.ok) return geomFail(f.name, g);
      axis = { ok: true, value: g.value };
      warn = warnings(a, b);
    } else if (f.method === 'cylinder') {
      const face = await resolveFaceRef(f.face!, ctx);
      if (!face.ok) return fail(f.name, face.message);
      const t = face.value.type;
      if (t !== 'cylinder' && t !== 'cone') return fail(f.name, `${wordsIn(ctx, f.face!)} is not a cylinder or a cone (it is ${t === 'plane' ? 'flat' : `a ${t} face`})`);
      axis = await resolveAxis({ kind: 'face-axis', body: f.face!.body, ref: f.face!.ref }, ctx);
    } else if (f.method === 'edge') {
      axis = await resolveAxis(f.edge!, ctx);
    } else {
      const a = await resolvePlane(f.planes[0], ctx);
      if (!a.ok) return fail(f.name, a.message);
      const b = await resolvePlane(f.planes[1], ctx);
      if (!b.ok) return fail(f.name, b.message);
      const g = planesCross(a.value, b.value, scale(add(a.value.origin, b.value.origin), 0.5));
      if (!g.ok) return fail(f.name, `${wordsIn(ctx, f.planes[0])} and ${wordsIn(ctx, f.planes[1])} are parallel, so they do not cross`);
      axis = { ok: true, value: g.value };
      warn = warnings(a, b);
    }
    if (!axis.ok) return fail(f.name, axis.message);
    warn = [...warn, ...warnings(axis)];
    // A cylinder's axis, a round edge's and two planes' crossing have no sense of their own: they
    // point up (+Z), else towards +Y, else +X, so an extruded-up cylinder's axis reads 0, 0, 1
    // (P4a review: it read 0, 0, -1). Reverse direction turns it.
    const free = f.method === 'cylinder' || f.method === 'two_planes' || (f.method === 'edge' && f.edge?.kind === 'edge' && f.edge.ref.signature.type === 'circle');
    const base = free ? upward(axis.value.dir) : axis.value.dir;
    const dir = f.flip ? scale(base, -1) : base;
    return okResult({ type: 'axis', origin: axis.value.origin, dir: unit(dir) ?? dir }, warn);
  },
};

/** A direction turned to point up (+Z), else towards +Y, else +X. */
export function upward(d: Vec3): Vec3 {
  const eps = 1e-9;
  const k = Math.abs(d[2]) > eps ? 2 : Math.abs(d[1]) > eps ? 1 : 0;
  return d[k] < 0 ? [-d[0], -d[1], -d[2]] : d;
}

// ------------------------------------------------------------ Point

export function pointRefs(f: RefPointFeature): GeomRef[] {
  const out: (GeomRef | null)[] = [];
  if (f.method === 'vertex') out.push(f.vertex);
  else if (f.method === 'center') out.push(f.edge ?? f.face);
  else if (f.method === 'on_edge') out.push(f.edge);
  else if (f.method === 'edge_plane') out.push(f.edge, f.plane);
  return out.filter((r): r is GeomRef => !!r);
}

export function pointIncomplete(f: RefPointFeature): string | null {
  switch (f.method) {
    case 'vertex':
      return f.vertex ? null : 'Pick a vertex';
    case 'center':
      return f.edge || f.face ? null : 'Pick a round edge or a spherical face';
    case 'on_edge':
      return f.edge ? null : 'Pick an edge';
    case 'edge_plane':
      return !f.edge ? 'Pick an edge' : !f.plane ? 'Pick a plane or a flat face' : null;
    case 'coordinates':
      return null;
    default:
      return 'Pick how the point is made';
  }
}

export interface PointValues {
  distance: number;
  percent: number;
  xyz: Vec3;
}

const XYZ_LABELS = ['X', 'Y', 'Z'] as const;

export const refPointDef: FeatureTypeDef<RefPointFeature, PointValues> = {
  type: 'ref_point',
  label: 'Point',
  icon: POINT_ICON,
  create(doc, init = {}) {
    const zero: Expr = doc.units.length === 'mm' ? '0 mm' : `0 ${doc.units.length}`;
    return {
      id: newId('f'),
      type: 'ref_point',
      name: nextName('Point', doc.features.map((f) => f.name)),
      method: 'vertex',
      vertex: null,
      edge: null,
      face: null,
      plane: null,
      along: 'percent',
      distance: DEFAULT_OFFSET[doc.units.length] ?? '10 mm',
      percent: '50',
      fromEnd: false,
      xyz: [zero, zero, zero] as ExprVec3,
      ...init,
    };
  },
  resolve(f, units) {
    const values: PointValues = { distance: 0, percent: 0, xyz: [0, 0, 0] };
    if (f.method === 'on_edge') {
      if (f.along === 'distance') {
        const d = evalField('Distance', f.distance, 'length', units);
        if (!d.ok) return d;
        if (d.value < 0) return { ok: false, message: 'Distance must not be negative' };
        values.distance = d.value;
      } else {
        const p = evalPercent('Position', f.percent, units);
        if (!p.ok) return p;
        values.percent = p.value;
      }
    } else if (f.method === 'coordinates') {
      for (let i = 0; i < 3; i++) {
        const r = evalField(XYZ_LABELS[i], f.xyz?.[i] ?? '', 'length', units);
        if (!r.ok) return r;
        values.xyz[i] = r.value;
      }
    }
    return { ok: true, values };
  },
  incomplete(f, units) {
    return pointIncomplete(f) ?? (() => {
      const r = refPointDef.resolve(f, units);
      return r.ok ? null : r.message;
    })();
  },
  parents: (f) => refParents(pointRefs(f)),
  uses: (f) => refBodies(pointRefs(f)),
  exprs: (f) => {
    const out: ExprField[] = [
      { path: 'distance', expr: f.distance },
      { path: 'percent', expr: f.percent },
    ];
    (f.xyz ?? []).forEach((e, i) => out.push({ path: `xyz[${i}]`, expr: e }));
    return out;
  },
  mapExprs: (f, fn) => ({ ...f, distance: fn(f.distance), percent: fn(f.percent), xyz: (f.xyz ?? ['0', '0', '0']).map(fn) as ExprVec3 }),
  async build(f, v, ctx) {
    const missing = pointIncomplete(f);
    if (missing) return fail(f.name, missing);
    const point = await buildPoint(f, v, ctx);
    if (!point.ok) return fail(f.name, point.message);
    return okResult({ type: 'point', p: point.value }, point.warnings);
  },
};

async function buildPoint(f: RefPointFeature, v: PointValues, ctx: BuildContext): Promise<{ ok: true; value: Vec3; warnings: string[] } | { ok: false; message: string }> {
  const words = (r: GeomRef) => wordsIn(ctx, r);
  if (f.method === 'coordinates') return { ok: true, value: [...v.xyz] as Vec3, warnings: [] };
  if (f.method === 'vertex') {
    const p = await resolvePoint(f.vertex!, ctx);
    return p.ok ? { ok: true, value: p.value, warnings: warnings(p) } : p;
  }
  if (f.method === 'center') {
    if (f.edge) {
      if (f.edge.kind !== 'edge') return { ok: false, message: `${words(f.edge)} is a sketch curve: pick a round edge of a body (a sketch's centre is one of its points)` };
      const e = await resolveEdgeRef(f.edge, ctx);
      if (!e.ok) return e;
      if (e.value.type !== 'circle' || !e.value.center) return { ok: false, message: `${words(f.edge)} is not an arc or a circle` };
      return { ok: true, value: e.value.center, warnings: warnings(e) };
    }
    const face = await resolveFaceRef(f.face!, ctx);
    if (!face.ok) return face;
    if (face.value.type !== 'sphere' || !face.value.axis) return { ok: false, message: `${words(f.face!)} is not a sphere` };
    return { ok: true, value: [...face.value.axis.origin] as Vec3, warnings: warnings(face) };
  }
  const e = await resolveCurve(f.edge!, ctx, words);
  if (!e.ok) return e;
  if (f.method === 'on_edge') {
    if (f.along === 'distance' && v.distance > e.value.length * (1 + 1e-9)) {
      return { ok: false, message: `Distance ${ctx.units.format(v.distance, 'length')} is past the end of ${words(f.edge!)} (it is ${ctx.units.format(e.value.length, 'length')} long)` };
    }
    const at = f.along === 'distance' ? { distance: Math.min(v.distance, e.value.length), fromEnd: f.fromEnd } : { fraction: (f.fromEnd ? 100 - v.percent : v.percent) / 100 };
    const r = await e.value.at(at);
    return { ok: true, value: r.point, warnings: warnings(e) };
  }
  // edge_plane
  if (!e.value.edge) return { ok: false, message: `${words(f.edge!)} is a sketch curve: pick an edge of a body` };
  const p = await resolvePlane(f.plane!, ctx);
  if (!p.ok) return p;
  const hits = await edgeCrossings(ctx.kernel, e.value.edge.shape, e.value.edge.index, { origin: p.value.origin, normal: p.value.normal });
  if (!hits.length) return { ok: false, message: `${words(f.edge!)} does not cross ${words(f.plane!)}` };
  const warn = warnings(e, p);
  if (hits.length > 1) warn.push(`${words(f.edge!)} crosses ${words(f.plane!)} ${hits.length} times: ${f.name} is at the first, from the edge's start`);
  return { ok: true, value: hits[0], warnings: warn };
}

