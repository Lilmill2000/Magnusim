// SPDX-License-Identifier: GPL-3.0-or-later
// Magnusim CAD plugin: sketch solver adapter over PlaneGCS (FreeCAD's 2D constraint
// solver, LGPL-2.0-or-later) compiled to WebAssembly through the salusoft89/planegcs embind
// wrapper (LGPL-2.1-or-later), rebuilt with -sDYNAMIC_EXECUTION=0 -sEMBIND_AOT=1 (no eval,
// no new Function) and our patches (solver-build/SOURCES.md).
//
// createSolver({moduleUrl}) -> {load, solve, dragStart, dragStartEntity, dragMove, dragEnd,
//                               setValue, analyze, values, stats, dispose}
//
// Drags follow FreeCAD's Sketcher: a temporary soft coincidence (tag -1) pulls the dragged
// point to the pointer, solved by SQP against the hard constraints. On top of that,
// dragStart({freeze:true}, the default) fixes every parameter the last diagnosis found
// fully determined, so a drag solves only the under-defined part of the sketch.
// dragStartEntity(id, grab) drags a whole entity: a line translates (both ends follow the
// pointer's offset from the grab point), a circle or an arc changes its radius (its edge
// follows the pointer, its centre is held softly where it was).
//
// Sketch JSON (all lengths in mm, angles in degrees):
//   points:      { "<pointId>": [u, v], ... }
//   entities:    [ {id, kind:"point",  p:"<pt>"},
//                  {id, kind:"line",   p:["<pt>","<pt>"]},
//                  {id, kind:"circle", c:"<pt>", r:R},
//                  {id, kind:"arc",    c:"<pt>", a:"<start pt>", b:"<end pt>", ccw?:true},
//                  ... construction?: true (ignored by the solver) ]
//   constraints: [ {id, kind, refs:[ids], value?, driving?:true}, ... ]
//     kinds: coincident horizontal vertical parallel perpendicular tangent equal distance
//            distance_x distance_y radius diameter angle midpoint symmetric point_on_line
//            point_on_circle concentric fix
//   A constraint with driving:false is a reference (driven) dimension: it is not given to
//   the solver, and its measured value is reported in values.measures.
// P4b (SKETCH):
//   entities also: {id, kind:"spline", form:"fit"|"control", pts:[...], degree, closed?, handles?:[pt|null, pt|null]}
//     The curve is a pure function of its points (src/sketch/tools/bspline.ts): the solver
//     holds only the points, so a spline's freedoms are its points'. tangent with a spline
//     at a shared end works through the end's neighbour (a control spline's second pole, a
//     fit spline's handle) as a line.
//   solver-only kinds (sketch patterns, src/sketch/tools/pattern.ts):
//     pattern_shift refs [p, q] value [dx, dy]: q - p = (dx, dy)
//     pattern_along refs [p, q, L1, (L2)] value [sx, sy, d1, (d2)]: q = p + (sx, sy) + d1 dir(L1) + d2 dir(L2)
//     offset_end refs [srcEnd, copyEnd, srcLine|srcArc]: the copy's end squared to its source
//     pattern_rotate refs [c, p, q] value deg: q = c + R(deg) (p - c)

const ALG = { BFGS: 0, LM: 1, DOGLEG: 2 };
const STATUS = { Success: 0, Converged: 1, Failed: 2, SuccessfulSolutionInvalid: 3 };
const TEMP_TAG = -1; // GCS::DefaultTemporaryConstraint: soft, ignored by the diagnosis
const INTERNAL_TAG = 0; // high priority, never reported as conflicting (arc rules)
const DEG = Math.PI / 180;
// P4b fix 1 (SKETCH): a point on a spline needs the spline's poles as affine combinations of its points.
import { closestOnSpline, splineAffine, splineCurve } from '../sketch/tools/bspline';

export class SketchInputError extends Error {}

function vecToArray(vec) {
  const out = new Array(vec.size());
  for (let i = 0; i < out.length; i++) out[i] = vec.get(i);
  vec.delete();
  return out;
}

function normAngle(a) {
  // (-pi, pi]
  while (a <= -Math.PI) a += 2 * Math.PI;
  while (a > Math.PI) a -= 2 * Math.PI;
  return a;
}

export async function createSolver({ moduleUrl, wasmUrl, moduleFactory, dlGaussStep = 3, sparseSqpMinParams = 64 } = {}) {
  let factory = moduleFactory;
  if (!factory) {
    // A variable, not a literal: the bundler leaves the URL to be resolved at run time.
    const name = 'planegcs.mjs';
    const url = moduleUrl ?? new URL(name, import.meta.url).href;
    factory = (await import(/* @vite-ignore */ url)).default;
  }
  const opts = {};
  if (wasmUrl) opts.locateFile = (p) => (p.endsWith('.wasm') ? wasmUrl : p);
  const t0 = performance.now();
  const M = await factory(opts);
  const initMs = performance.now() - t0;
  const gcs = new M.GcsSystem();
  // DogLeg Gauss-Newton step: 3 = sparse least-norm LDLT with a dense FullPivLU fallback
  // (spike patch); 0 = FullPivLU, the upstream default.
  if (typeof gcs.set_dl_gauss_step === 'function') gcs.set_dl_gauss_step(dlGaussStep);
  // Drag solves (hard + soft subsystems) of components with at least this many parameters
  // use the sparse SQP (spike patch); smaller ones and 0 = the upstream dense SQP.
  if (typeof gcs.set_sparse_sqp_min_params === 'function') gcs.set_sparse_sqp_min_params(sparseSqpMinParams);

  // ---- state of the loaded sketch ----
  let sk = null; // {points, entities, constraints}
  let pointParams = new Map(); // pointId -> [ix, iy]
  let entityInfo = new Map(); // entityId -> {kind, params:[idx], pts:[ptIds], ...}
  let consInfo = new Map(); // constraintId -> {tag, kind, refs, valueParams:[{idx, unit}], driving}
  let tagToCons = new Map(); // tag -> constraintId
  let paramOwner = []; // idx -> {owner, name}
  let fitGlues = []; // P4b fix 1: points held on fit splines (their frozen parameters are checked after a solve)
  let nParams = 0;
  let dragTarget = null; // [ix, iy] fixed target params, allocated once per load
  let dragTarget2 = null; // a second pair (a line's other end; a circle's held centre)
  let drag = null; // {pointId | entity, kind, init:[u,v], step, reinits}
  let lastGood = null; // Float64Array of the last accepted parameter values
  let frozen = []; // parameter indices fixed for the current drag
  let geomVersion = 0; // bumped whenever parameter values may have changed
  let analyzedVersion = -1; // geomVersion at the last diagnosis made at the current values

  const h = () => M.HEAPF64;

  function readParams() {
    const ptr = gcs.params_to_buffer();
    return h().slice(ptr >>> 3, (ptr >>> 3) + nParams);
  }
  function writeParams(arr, first = 0) {
    const ptr = gcs.input_buffer(arr.length);
    h().set(arr, ptr >>> 3);
    gcs.params_from_buffer(first, arr.length);
  }

  function push(value, fixed, owner, name) {
    const idx = gcs.push_p_param(value, fixed);
    paramOwner[idx] = { owner, name, fixed };
    nParams = idx + 1;
    return idx;
  }

  // Geometry handles (embind objects) must be deleted after use.
  function withGeo(makers, fn) {
    const objs = [];
    try {
      for (const mk of makers) objs.push(mk());
      return fn(...objs);
    } finally {
      for (const o of objs) o.delete();
    }
  }
  const P = (pt) => () => gcs.make_point(pt[0], pt[1]);
  const L = (e) => () => gcs.make_line(e.p1[0], e.p1[1], e.p2[0], e.p2[1]);
  const C = (e) => () => gcs.make_circle(e.c[0], e.c[1], e.r);
  const A = (e) => () => gcs.make_arc(e.c[0], e.c[1], e.s[0], e.s[1], e.e[0], e.e[1], e.a0, e.a1, e.r);
  const CRVX = (e) => (e.kind === 'line' ? L(e) : e.kind === 'arc' ? A(e) : C(e));

  // end points (point ids) of a line or arc entity
  function endIds(e) {
    if (e.kind === 'line') return e.pts;
    if (e.kind === 'arc') return [e.pts[1], e.pts[2]];
    // P4b (SKETCH): an open spline's first and last points
    if (e.kind === 'spline') return e.closed ? [] : [e.fitPts[0], e.fitPts[e.fitPts.length - 1]];
    return [];
  }
  // P4b (SKETCH): a spline at one of its ends as the line from the end to its neighbour
  // (a control spline's next pole, a fit spline's handle): {kind:'line', p1, p2}.
  function splineEndLine(e, endId, cid) {
    const n = e.fitPts.length;
    const atStart = e.fitPts[0] === endId;
    let nb;
    if (e.form === 'control') nb = atStart ? e.fitPts[1] : e.fitPts[n - 2];
    else nb = atStart ? e.handleIds[0] : e.handleIds[1];
    if (!nb) throw new SketchInputError(`constraint ${cid}: a fit spline is tangent at an end only through a tangent handle there`);
    return { kind: 'line', p1: pointParams.get(endId), p2: pointParams.get(nb) };
  }
  function sharedEnd(id1, id2) {
    const a = endIds(entityInfo.get(id1));
    const b = new Set(endIds(entityInfo.get(id2)));
    return a.find((p) => b.has(p)) ?? null;
  }
  // GCS curve normals: line = rotate90ccw(p2 - p1), circle/arc = center - p
  function normalAt(e, p, vals) {
    if (e.kind === 'line') return [-(vals[e.p2[1]] - vals[e.p1[1]]), vals[e.p2[0]] - vals[e.p1[0]]];
    return [vals[e.c[0]] - vals[p[0]], vals[e.c[1]] - vals[p[1]]];
  }

  function refKind(id) {
    if (pointParams.has(id)) return 'point';
    const e = entityInfo.get(id);
    if (!e) return null;
    return e.kind === 'point' ? 'point' : e.kind;
  }
  function ptOf(id) {
    if (pointParams.has(id)) return pointParams.get(id);
    const e = entityInfo.get(id);
    if (e && e.kind === 'point') return e.p;
    return null;
  }

  function measure(c, vals) {
    // reference (driven) dimension, measured from the solved geometry
    const pt = (id) => {
      const p = ptOf(id);
      return [vals[p[0]], vals[p[1]]];
    };
    const kinds = c.refs.map(refKind);
    const lineEnds = (id) => {
      const e = entityInfo.get(id);
      return [[vals[e.p1[0]], vals[e.p1[1]]], [vals[e.p2[0]], vals[e.p2[1]]]];
    };
    const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
    switch (c.kind) {
      case 'distance':
        if (kinds.length === 1 && kinds[0] === 'line') return dist(...lineEnds(c.refs[0]));
        if (kinds[0] === 'point' && kinds[1] === 'point') return dist(pt(c.refs[0]), pt(c.refs[1]));
        return null;
      case 'distance_x':
      case 'distance_y': {
        const k = c.kind === 'distance_x' ? 0 : 1;
        if (kinds.length === 1 && kinds[0] === 'line') {
          const [a, b] = lineEnds(c.refs[0]);
          return b[k] - a[k];
        }
        if (kinds.length === 1) return pt(c.refs[0])[k];
        return pt(c.refs[1])[k] - pt(c.refs[0])[k];
      }
      case 'radius':
      case 'diameter': {
        const e = entityInfo.get(c.refs[0]);
        const r = vals[e.r];
        return c.kind === 'radius' ? r : 2 * r;
      }
      case 'angle': {
        const dir = (id) => {
          const [a, b] = lineEnds(id);
          return Math.atan2(b[1] - a[1], b[0] - a[0]);
        };
        if (kinds.length === 1) return normAngle(dir(c.refs[0])) / DEG;
        return normAngle(dir(c.refs[1]) - dir(c.refs[0])) / DEG;
      }
      default:
        return null;
    }
  }

  // P4b fix 1 (SKETCH): point P on spline e, at a free curve parameter u (one constraint per
  // coordinate, ConstraintPointOnAffineSpline in our PlaneGCS patch). The poles are fixed affine
  // combinations of the spline's points and handles; a fit spline's chord-length parameters are frozen
  // for this load, and solve() re-loads until they agree with the solved points (fitGlues).
  function onSpline(P0, e, T, cid) {
    if (typeof gcs.add_constraint_point_on_affine_spline !== 'function') throw new SketchInputError(`constraint ${cid}: this solver build cannot hold a point on a spline`);
    const vals = readParams();
    const xy = (id) => {
      const q = pointParams.get(id);
      return [vals[q[0]], vals[q[1]]];
    };
    const hs = e.handleIds.map((id) => (id ? xy(id) : null));
    const s = { form: e.form, degree: e.raw.degree, pts: e.fitPts.map(xy), closed: e.closed, handles: hs, knots: e.raw.knots, mults: e.raw.mults, spans: e.raw.spans };
    let aff;
    try {
      aff = splineAffine(s);
    } catch (err) {
      throw new SketchInputError(`constraint ${cid}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const inputs = [...e.fitPts, ...e.handleIds.filter((h) => h)];
    const u0 = closestOnSpline(aff.curve, [vals[P0[0]], vals[P0[1]]]).u;
    const ui = push(u0, false, cid, 'u');
    const nPoles = aff.W.length;
    const w = new M.DoubleVector();
    for (const row of aff.W) for (const x of row) w.push_back(x);
    const flat = new M.DoubleVector();
    for (const x of aff.flat) flat.push_back(x);
    try {
      for (const k of [0, 1]) {
        const q = new M.IntVector();
        for (const id of inputs) q.push_back(pointParams.get(id)[k]);
        try {
          gcs.add_constraint_point_on_affine_spline(P0[k], ui, q, w, nPoles, flat, aff.curve.degree, T, true);
        } finally {
          q.delete();
        }
      }
    } finally {
      w.delete();
      flat.delete();
    }
    if (e.form === 'fit') fitGlues.push({ p: P0, entity: e });
  }

  function addConstraint(c, tag) {
    const cid = c.id;
    const refs = c.refs ?? [];
    const kinds = refs.map((r) => {
      const k = refKind(r);
      if (!k) throw new SketchInputError(`constraint ${cid}: reference "${r}" not found`);
      return k;
    });
    const sig = kinds.join(',');
    const info = { tag, kind: c.kind, refs, valueParams: [], driving: true };
    const ent = (i) => entityInfo.get(refs[i]);
    const pt = (i) => ptOf(refs[i]);
    const val = (unit, v = c.value) => {
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        throw new SketchInputError(`constraint ${cid}: numeric value required`);
      }
      const idx = push(unit === 'deg' ? v * DEG : v, true, cid, 'value');
      info.valueParams.push({ idx, unit });
      return idx;
    };
    const bad = () => {
      throw new SketchInputError(`constraint ${cid}: kind "${c.kind}" does not accept refs (${sig})`);
    };
    const T = tag;
    switch (c.kind) {
      case 'coincident':
        // P4b fix 1 (SKETCH): a point on a spline (it slides along it; see onSpline).
        if (sig === 'point,spline') onSpline(pt(0), ent(1), T, cid);
        else if (sig === 'point,point') withGeo([P(pt(0)), P(pt(1))], (a, b) => gcs.add_constraint_p2p_coincident(a, b, T, true, 1));
        else if (sig === 'point,line') withGeo([P(pt(0)), L(ent(1))], (a, l) => gcs.add_constraint_point_on_line_pl(a, l, T, true, 1));
        else if (sig === 'point,circle' || sig === 'point,arc') withGeo([P(pt(0)), C(ent(1))], (a, cc) => gcs.add_constraint_point_on_circle(a, cc, T, true, 1));
        else bad();
        break;
      case 'horizontal':
      case 'vertical': {
        const kind = c.kind;
        if (sig === 'line') withGeo([L(ent(0))], (l) => gcs[`add_constraint_${kind}_l`](l, T, true, 1));
        else if (sig === 'point,point') withGeo([P(pt(0)), P(pt(1))], (a, b) => gcs[`add_constraint_${kind}_pp`](a, b, T, true, 1));
        else bad();
        break;
      }
      case 'parallel':
        if (sig === 'line,line') withGeo([L(ent(0)), L(ent(1))], (a, b) => gcs.add_constraint_parallel(a, b, T, true, 1));
        else bad();
        break;
      case 'perpendicular':
        if (sig === 'line,line') withGeo([L(ent(0)), L(ent(1))], (a, b) => gcs.add_constraint_perpendicular_ll(a, b, T, true, 1));
        else bad();
        break;
      case 'tangent': {
        // Curves that share an end point get endpoint tangency (FreeCAD's angle-via-point
        // form): edge tangency plus a shared point is degenerate (its Jacobian row vanishes
        // at the solution) and would be diagnosed as redundant.
        const curve = (k) => k === 'line' || k === 'arc' || k === 'circle' || k === 'spline';
        let at = null;
        if (refs.length === 3 && curve(kinds[0]) && curve(kinds[1]) && kinds[2] === 'point') at = refs[2];
        else if (refs.length === 2 && curve(kinds[0]) && curve(kinds[1])) at = sharedEnd(refs[0], refs[1]);
        if ((kinds[0] === 'spline' || kinds[1] === 'spline') && !at) throw new SketchInputError(`constraint ${cid}: a spline is tangent only at an end it shares`);
        if (at) {
          // P4b (SKETCH): a spline side is the line from the end to its neighbour.
          const e1 = kinds[0] === 'spline' ? splineEndLine(ent(0), at, cid) : ent(0);
          const e2 = kinds[1] === 'spline' ? splineEndLine(ent(1), at, cid) : ent(1);
          const p = ptOf(at);
          const vals = readParams();
          const n1 = normalAt(e1, p, vals), n2 = normalAt(e2, p, vals);
          const cur = Math.atan2(-n2[0] * n1[1] + n2[1] * n1[0], n2[0] * n1[0] + n2[1] * n1[1]);
          const want = Math.abs(normAngle(cur)) > Math.PI / 2 ? Math.PI : 0;
          const ai = push(want, true, cid, 'angle');
          info.valueParams.push({ idx: ai, unit: 'internal' });
          withGeo([CRVX(e1), CRVX(e2), P(p)], (a, b, q) => gcs.add_constraint_angle_via_point(a, b, q, ai, T, true, 1));
          break;
        }
        if (sig === 'line,circle') withGeo([L(ent(0)), C(ent(1))], (l, cc) => gcs.add_constraint_tangent_lc(l, cc, T, true, 1));
        else if (sig === 'circle,line') withGeo([L(ent(1)), C(ent(0))], (l, cc) => gcs.add_constraint_tangent_lc(l, cc, T, true, 1));
        else if (sig === 'line,arc') withGeo([L(ent(0)), A(ent(1))], (l, a) => gcs.add_constraint_tangent_la(l, a, T, true, 1));
        else if (sig === 'arc,line') withGeo([L(ent(1)), A(ent(0))], (l, a) => gcs.add_constraint_tangent_la(l, a, T, true, 1));
        else if (sig === 'circle,circle') withGeo([C(ent(0)), C(ent(1))], (a, b) => gcs.add_constraint_tangent_cc(a, b, T, true, 1));
        else if (sig === 'arc,arc') withGeo([A(ent(0)), A(ent(1))], (a, b) => gcs.add_constraint_tangent_aa(a, b, T, true, 1));
        else if (sig === 'circle,arc') withGeo([C(ent(0)), A(ent(1))], (a, b) => gcs.add_constraint_tangent_ca(a, b, T, true, 1));
        else if (sig === 'arc,circle') withGeo([C(ent(1)), A(ent(0))], (a, b) => gcs.add_constraint_tangent_ca(a, b, T, true, 1));
        else bad();
        break;
      }
      case 'equal':
        if (sig === 'line,line') withGeo([L(ent(0)), L(ent(1))], (a, b) => gcs.add_constraint_equal_length(a, b, T, true, 1));
        else if (sig === 'circle,circle') withGeo([C(ent(0)), C(ent(1))], (a, b) => gcs.add_constraint_equal_radius_cc(a, b, T, true, 1));
        else if (sig === 'circle,arc') withGeo([C(ent(0)), A(ent(1))], (a, b) => gcs.add_constraint_equal_radius_ca(a, b, T, true, 1));
        else if (sig === 'arc,circle') withGeo([C(ent(1)), A(ent(0))], (a, b) => gcs.add_constraint_equal_radius_ca(a, b, T, true, 1));
        else if (sig === 'arc,arc') withGeo([A(ent(0)), A(ent(1))], (a, b) => gcs.add_constraint_equal_radius_aa(a, b, T, true, 1));
        else bad();
        break;
      case 'distance': {
        const v = () => val('mm');
        if (sig === 'line') { const e = ent(0); const vi = v(); withGeo([P(e.p1), P(e.p2)], (a, b) => gcs.add_constraint_p2p_distance(a, b, vi, T, true, 1)); }
        else if (sig === 'point,point') { const vi = v(); withGeo([P(pt(0)), P(pt(1))], (a, b) => gcs.add_constraint_p2p_distance(a, b, vi, T, true, 1)); }
        else if (sig === 'point,line') { const vi = v(); withGeo([P(pt(0)), L(ent(1))], (a, l) => gcs.add_constraint_p2l_distance(a, l, vi, T, true, 1)); }
        else if (sig === 'line,point') { const vi = v(); withGeo([P(pt(1)), L(ent(0))], (a, l) => gcs.add_constraint_p2l_distance(a, l, vi, T, true, 1)); }
        else if (sig === 'line,line') { const vi = v(); withGeo([P(ent(0).p1), L(ent(1))], (a, l) => gcs.add_constraint_p2l_distance(a, l, vi, T, true, 1)); }
        else if (sig === 'point,circle' || sig === 'point,arc') { const vi = v(); withGeo([P(pt(0)), C(ent(1))], (a, cc) => gcs.add_constraint_p2cdistance(a, cc, vi, T, true, 1)); }
        else if (sig === 'circle,circle') { const vi = v(); withGeo([C(ent(0)), C(ent(1))], (a, b) => gcs.add_constraint_c2cdistance(a, b, vi, T, true, 1)); }
        else if (sig === 'circle,line') { const vi = v(); withGeo([C(ent(0)), L(ent(1))], (cc, l) => gcs.add_constraint_c2ldistance(cc, l, vi, T, true, 1)); }
        else if (sig === 'line,circle') { const vi = v(); withGeo([C(ent(1)), L(ent(0))], (cc, l) => gcs.add_constraint_c2ldistance(cc, l, vi, T, true, 1)); }
        else bad();
        break;
      }
      case 'distance_x':
      case 'distance_y': {
        const k = c.kind === 'distance_x' ? 0 : 1;
        let a, b;
        if (sig === 'line') { a = ent(0).p1; b = ent(0).p2; }
        else if (sig === 'point,point') { a = pt(0); b = pt(1); }
        else if (sig === 'point') {
          const vi = val('mm');
          withGeo([P(pt(0))], (p) => gcs[k === 0 ? 'add_constraint_coordinate_x' : 'add_constraint_coordinate_y'](p, vi, T, true, 1));
          break;
        } else bad();
        const vi = val('mm');
        // ConstraintDifference: param2 - param1 = difference
        gcs.add_constraint_difference(a[k], b[k], vi, T, true, 1);
        break;
      }
      case 'radius':
      case 'diameter': {
        const which = c.kind;
        const vi = val('mm');
        if (sig === 'circle') withGeo([C(ent(0))], (cc) => gcs[`add_constraint_circle_${which}`](cc, vi, T, true, 1));
        else if (sig === 'arc') withGeo([A(ent(0))], (a) => gcs[`add_constraint_arc_${which}`](a, vi, T, true, 1));
        else bad();
        break;
      }
      case 'angle': {
        const vi = val('deg');
        if (sig === 'line,line') withGeo([L(ent(0)), L(ent(1))], (a, b) => gcs.add_constraint_l2l_angle_ll(a, b, vi, T, true, 1));
        // p2p_angle without incrAngle drops the tag inside GCS; the incr_angle form keeps it
        else if (sig === 'line') { const e = ent(0); withGeo([P(e.p1), P(e.p2)], (a, b) => gcs.add_constraint_p2p_angle_incr_angle(a, b, vi, 0, T, true, 1)); }
        else bad();
        break;
      }
      case 'midpoint':
        if (sig === 'point,line') { const e = ent(1); withGeo([P(e.p1), P(e.p2), P(pt(0))], (a, b, m) => gcs.add_constraint_p2p_symmetric_ppp(a, b, m, T, true, 1)); }
        else if (sig === 'line,point') { const e = ent(0); withGeo([P(e.p1), P(e.p2), P(pt(1))], (a, b, m) => gcs.add_constraint_p2p_symmetric_ppp(a, b, m, T, true, 1)); }
        else bad();
        break;
      case 'symmetric':
        if (sig === 'point,point,line') withGeo([P(pt(0)), P(pt(1)), L(ent(2))], (a, b, l) => gcs.add_constraint_p2p_symmetric_ppl(a, b, l, T, true, 1));
        else if (sig === 'point,point,point') withGeo([P(pt(0)), P(pt(1)), P(pt(2))], (a, b, m) => gcs.add_constraint_p2p_symmetric_ppp(a, b, m, T, true, 1));
        else bad();
        break;
      case 'point_on_line':
        if (sig === 'point,line') withGeo([P(pt(0)), L(ent(1))], (a, l) => gcs.add_constraint_point_on_line_pl(a, l, T, true, 1));
        else bad();
        break;
      case 'point_on_circle':
        if (sig === 'point,spline') onSpline(pt(0), ent(1), T, cid);
        else if (sig === 'point,circle' || sig === 'point,arc') withGeo([P(pt(0)), C(ent(1))], (a, cc) => gcs.add_constraint_point_on_circle(a, cc, T, true, 1));
        else bad();
        break;
      case 'concentric': {
        const ok = (k) => k === 'circle' || k === 'arc';
        if (kinds.length === 2 && ok(kinds[0]) && ok(kinds[1])) withGeo([P(ent(0).c), P(ent(1).c)], (a, b) => gcs.add_constraint_p2p_coincident(a, b, T, true, 1));
        else bad();
        break;
      }
      case 'fix': {
        // FreeCAD "Lock": coordinate constraints against fixed values, so the point stays an
        // unknown and over-constraining it is still diagnosed.
        const vals = readParams();
        const fixPoint = (p, uv) => {
          const xi = push(uv ? uv[0] : vals[p[0]], true, cid, 'value_u');
          const yi = push(uv ? uv[1] : vals[p[1]], true, cid, 'value_v');
          info.valueParams.push({ idx: xi, unit: 'mm' }, { idx: yi, unit: 'mm' });
          withGeo([P(p)], (pp) => {
            gcs.add_constraint_coordinate_x(pp, xi, T, true, 1);
            gcs.add_constraint_coordinate_y(pp, yi, T, true, 1);
          });
        };
        if (sig === 'point') fixPoint(pt(0), Array.isArray(c.value) ? c.value : null);
        else if (sig === 'line') { fixPoint(ent(0).p1); fixPoint(ent(0).p2); }
        else if (sig === 'circle') {
          const e = ent(0);
          fixPoint(e.c);
          const ri = push(vals[e.r], true, cid, 'value_r');
          info.valueParams.push({ idx: ri, unit: 'mm' });
          withGeo([C(e)], (cc) => gcs.add_constraint_circle_radius(cc, ri, T, true, 1));
        } else if (sig === 'arc') { const e = ent(0); fixPoint(e.c); fixPoint(e.s); fixPoint(e.e); }
        // P4b (SKETCH): a spline: every point (handles too)
        else if (sig === 'spline') { for (const id of ent(0).pts) fixPoint(pointParams.get(id)); }
        else bad();
        break;
      }
      // P4b (SKETCH): sketch pattern ties (solver-only kinds; see the header)
      case 'pattern_shift': {
        // q - p = value (a fixed shift, mm)
        if (sig !== 'point,point' || !Array.isArray(c.value)) bad();
        const Pp = pt(0), Q = pt(1);
        const dx = push(c.value[0], true, cid, 'dx');
        const dy = push(c.value[1], true, cid, 'dy');
        gcs.add_constraint_difference(Pp[0], Q[0], dx, T, true, 1);
        gcs.add_constraint_difference(Pp[1], Q[1], dy, T, true, 1);
        break;
      }
      case 'pattern_along': {
        // q = p + (sx, sy) + d1 dir(L1) [+ d2 dir(L2)]: through helper points, each leg
        // a distance and a parallel to its line (the side the copy was made on is kept).
        const v = Array.isArray(c.value) ? c.value : [];
        const lines = refs.slice(2);
        if (kinds[0] !== 'point' || kinds[1] !== 'point' || !lines.length || kinds.slice(2).some((k) => k !== 'line') || v.length !== 2 + lines.length) bad();
        const Pp = pt(0), Q = pt(1);
        const vals = readParams();
        let from = Pp;
        let cur = [vals[Pp[0]], vals[Pp[1]]];
        const legs = [];
        if (v[0] || v[1]) legs.push({ shift: [v[0], v[1]] });
        lines.forEach((l, k) => legs.push({ line: ent(2 + k), d: v[2 + k] }));
        legs.forEach((leg, k) => {
          const last = k === legs.length - 1;
          let guess;
          if (leg.shift) guess = [cur[0] + leg.shift[0], cur[1] + leg.shift[1]];
          else {
            const e = leg.line;
            const ux = vals[e.p2[0]] - vals[e.p1[0]], uy = vals[e.p2[1]] - vals[e.p1[1]];
            const ul = Math.hypot(ux, uy) || 1;
            guess = [cur[0] + (leg.d * ux) / ul, cur[1] + (leg.d * uy) / ul];
          }
          const to = last ? Q : [push(guess[0], false, cid, 'hx'), push(guess[1], false, cid, 'hy')];
          if (leg.shift) {
            const dx = push(leg.shift[0], true, cid, 'dx');
            const dy = push(leg.shift[1], true, cid, 'dy');
            gcs.add_constraint_difference(from[0], to[0], dx, T, true, 1);
            gcs.add_constraint_difference(from[1], to[1], dy, T, true, 1);
          } else if (Math.abs(leg.d) < 1e-12) {
            withGeo([P(from), P(to)], (a, b) => gcs.add_constraint_p2p_coincident(a, b, T, true, 1));
          } else {
            const di = push(Math.abs(leg.d), true, cid, 'd');
            const seg = { p1: from, p2: to };
            withGeo([P(from), P(to)], (a, b) => gcs.add_constraint_p2p_distance(a, b, di, T, true, 1));
            withGeo([L(seg), L(leg.line)], (a, b) => gcs.add_constraint_parallel(a, b, T, true, 1));
          }
          from = to;
          cur = guess;
        });
        break;
      }
      case 'offset_end': {
        // An offset copy's free end squared to its source: on the source line's normal through
        // the source end, or on the ray from an arc's centre through it.
        if (sig === 'point,point,line') withGeo([L({ p1: pt(0), p2: pt(1) }), L(ent(2))], (a, b) => gcs.add_constraint_perpendicular_ll(a, b, T, true, 1));
        else if (sig === 'point,point,arc') withGeo([P(pt(1)), L({ p1: ent(2).c, p2: pt(0) })], (a, l) => gcs.add_constraint_point_on_line_pl(a, l, T, true, 1));
        else bad();
        break;
      }
      case 'pattern_rotate': {
        if (sig !== 'point,point,point') bad();
        const C0 = pt(0), Pp = pt(1), Q = pt(2);
        const vals = readParams();
        if (Math.hypot(vals[Pp[0]] - vals[C0[0]], vals[Pp[1]] - vals[C0[1]]) < 1e-9) {
          // A point at the centre stays there.
          withGeo([P(C0), P(Q)], (a, b) => gcs.add_constraint_p2p_coincident(a, b, T, true, 1));
          break;
        }
        const ai = val('deg');
        const l1 = { p1: C0, p2: Pp };
        const l2 = { p1: C0, p2: Q };
        withGeo([L(l1), L(l2)], (a, b) => gcs.add_constraint_equal_length(a, b, T, true, 1));
        withGeo([L(l1), L(l2)], (a, b) => gcs.add_constraint_l2l_angle_ll(a, b, ai, T, true, 1));
        break;
      }
      default:
        throw new SketchInputError(`constraint ${cid}: unknown kind "${c.kind}"`);
    }
    return info;
  }

  function load(sketch) {
    drag = null;
    frozen = [];
    geomVersion++;
    gcs.clear_data();
    pointParams = new Map();
    entityInfo = new Map();
    consInfo = new Map();
    tagToCons = new Map();
    paramOwner = [];
    nParams = 0;
    fitGlues = [];
    sk = sketch;

    for (const [pid, uv] of Object.entries(sketch.points ?? {})) {
      pointParams.set(pid, [push(uv[0], false, pid, 'u'), push(uv[1], false, pid, 'v')]);
    }
    const ptParams = (id, eid) => {
      const p = pointParams.get(id);
      if (!p) throw new SketchInputError(`entity ${eid}: point "${id}" not found`);
      return p;
    };
    const uvOf = (id) => sketch.points[id];
    for (const e of sketch.entities ?? []) {
      switch (e.kind) {
        case 'point':
          entityInfo.set(e.id, { kind: 'point', p: ptParams(e.p, e.id), pts: [e.p], params: [...ptParams(e.p, e.id)] });
          break;
        case 'line': {
          const p1 = ptParams(e.p[0], e.id);
          const p2 = ptParams(e.p[1], e.id);
          entityInfo.set(e.id, { kind: 'line', p1, p2, pts: [e.p[0], e.p[1]], params: [...p1, ...p2] });
          break;
        }
        case 'circle': {
          const c = ptParams(e.c, e.id);
          const r = push(e.r, false, e.id, 'r');
          entityInfo.set(e.id, { kind: 'circle', c, r, pts: [e.c], params: [...c, r] });
          break;
        }
        case 'arc': {
          // GCS arcs run counter-clockwise from start to end; a clockwise arc swaps its ends.
          const ccw = e.ccw !== false;
          const sId = ccw ? e.a : e.b;
          const eId = ccw ? e.b : e.a;
          const c = ptParams(e.c, e.id);
          const s = ptParams(sId, e.id);
          const en = ptParams(eId, e.id);
          const cu = uvOf(e.c), su = uvOf(sId), eu = uvOf(eId);
          const r0 = Math.hypot(su[0] - cu[0], su[1] - cu[1]);
          let a0 = Math.atan2(su[1] - cu[1], su[0] - cu[0]);
          let a1 = Math.atan2(eu[1] - cu[1], eu[0] - cu[0]);
          while (a1 <= a0) a1 += 2 * Math.PI;
          const r = push(r0, false, e.id, 'r');
          const ai0 = push(a0, false, e.id, 'a0');
          const ai1 = push(a1, false, e.id, 'a1');
          const info = { kind: 'arc', c, s, e: en, r, a0: ai0, a1: ai1, pts: [e.c, e.a, e.b], params: [...c, ...s, ...en, r, ai0, ai1] };
          entityInfo.set(e.id, info);
          withGeo([A(info)], (a) => gcs.add_constraint_arc_rules(a, INTERNAL_TAG, true, 1));
          break;
        }
        // P4b (SKETCH): a spline is its points (fit points or poles, then handles).
        case 'spline': {
          const fitPts = [...(e.pts ?? [])];
          if (fitPts.length < 2) throw new SketchInputError(`entity ${e.id}: a spline needs two points or more`);
          const handleIds = [e.handles?.[0] ?? null, e.handles?.[1] ?? null];
          const all = [...fitPts, ...handleIds.filter((h) => h && !fitPts.includes(h))];
          const params = [];
          for (const id of all) params.push(...ptParams(id, e.id));
          entityInfo.set(e.id, { kind: 'spline', form: e.form === 'control' ? 'control' : 'fit', closed: !!e.closed, fitPts, handleIds, pts: all, params, raw: e });
          break;
        }
        default:
          throw new SketchInputError(`entity ${e.id}: unknown kind "${e.kind}"`);
      }
    }
    // drag targets: fixed parameters reused by every drag
    dragTarget = [push(0, true, '#drag', 'u'), push(0, true, '#drag', 'v')];
    dragTarget2 = [push(0, true, '#drag2', 'u'), push(0, true, '#drag2', 'v')];

    let tag = 0;
    for (const c of sketch.constraints ?? []) {
      if (consInfo.has(c.id)) throw new SketchInputError(`constraint ${c.id}: duplicate id`);
      if (c.driving === false) {
        consInfo.set(c.id, { tag: null, kind: c.kind, refs: c.refs ?? [], valueParams: [], driving: false });
        continue;
      }
      tag += 1;
      const info = addConstraint(c, tag);
      consInfo.set(c.id, info);
      tagToCons.set(tag, c.id);
    }
    lastGood = readParams();
    return { params: nParams, unknowns: paramOwner.filter((p) => !p.fixed).length, constraints: tag };
  }

  function values(vals = readParams()) {
    const points = {};
    for (const [id, [ix, iy]] of pointParams) points[id] = [vals[ix], vals[iy]];
    const radii = {};
    for (const [id, e] of entityInfo) if (e.kind === 'circle' || e.kind === 'arc') radii[id] = vals[e.r];
    const measures = {};
    for (const [id, c] of consInfo) if (!c.driving) measures[id] = measure(c, vals);
    return { points, radii, measures };
  }

  const tagsToIds = (tags) => tags.map((t) => tagToCons.get(t)).filter((x) => x !== undefined);

  function diagnosisLists() {
    return {
      conflicting: tagsToIds(vecToArray(gcs.get_conflicting())),
      redundant: tagsToIds(vecToArray(gcs.get_redundant())),
      partiallyRedundant: tagsToIds(vecToArray(gcs.get_partially_redundant())),
    };
  }

  // One solve of the prepared system; tries DogLeg, then Levenberg-Marquardt, then BFGS
  // (FreeCAD Sketcher's fallback order). On failure the last good values are restored.
  function solvePrepared(fallback = true) {
    const algs = fallback ? [ALG.DOGLEG, ALG.LM, ALG.BFGS] : [ALG.DOGLEG];
    // GCS checks the redundant (excluded) constraints against the parameters before the
    // solution is applied, so a sketch with redundant constraints returns Converged even
    // when the solve succeeded. Accept Converged in that case only.
    const redundantSketch = gcs.has_redundant() && !gcs.has_conflicting();
    const good = (st) => st === STATUS.Success || (st === STATUS.Converged && redundantSketch);
    let st = STATUS.Failed;
    for (const alg of algs) {
      st = gcs.solve_prepared(alg);
      if (good(st)) break;
    }
    if (good(st)) {
      gcs.apply_solution();
      lastGood = readParams();
      return true;
    }
    writeParams(lastGood);
    return false;
  }

  function statusOf(ok, lists) {
    if (lists.conflicting.length) return 'conflicting';
    if (!ok) return 'failed';
    if (lists.redundant.length) return 'redundant';
    return 'ok';
  }

  function solve() {
    if (!sk) throw new Error('load() a sketch first');
    const t0 = performance.now();
    unfreeze();
    gcs.init_solution(ALG.DOGLEG); // diagnoses only when the constraint set changed
    if (gcs.has_conflicting()) {
      // Like FreeCAD's Sketcher, a sketch whose diagnosis found conflicting constraints is
      // not solved: the geometry stays where it is and the conflict is reported.
      const lists = diagnosisLists();
      const dof = gcs.dof();
      refreeze();
      return { status: 'conflicting', solved: false, dof, ...lists, values: values(lastGood), ms: performance.now() - t0 };
    }
    let ok = solvePrepared(true);
    // P4b fix 1 (SKETCH): a point held on a fit spline used the chord-length parameters of the load;
    // when the solve moved the fit points, load again at the solved points until they agree.
    for (let pass = 0; ok && fitGlues.length && pass < 6 && !drag && fitGluesOff(); pass++) {
      const v = values(lastGood);
      load({ ...sk, points: { ...sk.points, ...v.points } });
      unfreeze();
      gcs.init_solution(ALG.DOGLEG);
      ok = solvePrepared(true);
    }
    geomVersion++;
    const lists = diagnosisLists();
    const dof = gcs.dof();
    refreeze();
    return { status: statusOf(ok, lists), solved: ok, dof, ...lists, values: values(lastGood), ms: performance.now() - t0 };
  }

  /** Whether a point held on a fit spline is off the curve its solved points make (beyond round-off). */
  function fitGluesOff() {
    const vals = lastGood;
    const xy = (id) => {
      const q = pointParams.get(id);
      return [vals[q[0]], vals[q[1]]];
    };
    for (const g of fitGlues) {
      const e = g.entity;
      let curve;
      try {
        curve = splineCurve({ form: 'fit', degree: 3, pts: e.fitPts.map(xy), closed: e.closed, handles: e.handleIds.map((id) => (id ? xy(id) : null)), spans: e.raw.spans });
      } catch {
        continue;
      }
      const p = [vals[g.p[0]], vals[g.p[1]]];
      const scale = Math.max(1, Math.abs(p[0]) + Math.abs(p[1]));
      if (closestOnSpline(curve, p).d > 1e-9 * scale) return true;
    }
    return false;
  }

  function setValue(constraintId, v) {
    const c = consInfo.get(constraintId);
    if (!c) throw new SketchInputError(`constraint ${constraintId} not found`);
    const sc = sk.constraints.find((x) => x.id === constraintId);
    sc.value = v;
    if (!c.driving) return solve();
    if (c.kind === 'fix') {
      if (!Array.isArray(v) || c.valueParams.length !== 2) throw new SketchInputError(`constraint ${constraintId}: fix takes [u, v] on a point`);
      gcs.set_p_param(c.valueParams[0].idx, v[0], true);
      gcs.set_p_param(c.valueParams[1].idx, v[1], true);
    } else {
      const vp = c.valueParams[0];
      if (!vp) throw new SketchInputError(`constraint ${constraintId} has no value`);
      gcs.set_p_param(vp.idx, vp.unit === 'deg' ? v * DEG : v, true);
    }
    return solve();
  }

  // ---- freezing: during a drag, parameters the diagnosis found fully determined (not in
  // GCS's dependent-parameter list) cannot move, so they are made fixed. The drag then
  // solves only the under-defined part of the sketch, split into small components.
  function freezeDetermined() {
    const dep = new Set(vecToArray(gcs.get_dependent_params()));
    const vals = readParams();
    for (let i = 0; i < nParams; i++) {
      const o = paramOwner[i];
      if (o && !o.fixed && !dep.has(i)) {
        gcs.set_p_param(i, vals[i], true);
        frozen.push(i);
      }
    }
  }
  function unfreeze() {
    if (!frozen.length) return;
    const vals = readParams();
    for (const i of frozen) gcs.set_p_param(i, vals[i], false);
    frozen = [];
  }

  function dragStart(pointId, { freeze = true } = {}) {
    if (!sk) throw new Error('load() a sketch first');
    const p = ptOf(pointId);
    if (!p) throw new SketchInputError(`point "${pointId}" not found`);
    gcs.clear_by_id(TEMP_TAG);
    unfreeze();
    drag = null;
    if (freeze) {
      // The dependent-parameter list must come from a diagnosis at the current values:
      // solve() diagnoses before it solves, so reuse only a diagnosis made since.
      if (analyzedVersion !== geomVersion) {
        gcs.diagnose_fresh(ALG.DOGLEG);
        analyzedVersion = geomVersion;
      } else {
        gcs.init_solution(ALG.DOGLEG);
      }
    } else {
      gcs.init_solution(ALG.DOGLEG);
    }
    if (gcs.has_conflicting()) {
      // FreeCAD refuses to drag in a sketch with conflicting constraints
      return { ok: false, reason: 'conflicting', movable: false, frozenParams: 0, conflicting: diagnosisLists().conflicting };
    }
    if (freeze) freezeDetermined();
    const vals = readParams();
    const init = [vals[p[0]], vals[p[1]]];
    writeParams(init, dragTarget[0]);
    withGeo([P(dragTarget), P(p)], (t, q) => gcs.add_constraint_p2p_coincident(t, q, TEMP_TAG, true, 1));
    gcs.init_solution(ALG.DOGLEG);
    drag = { kind: 'point', pointId, init, grab: init, step: 0, reinits: 0, freeze, frozen: frozen.length };
    const movable = !frozen.includes(p[0]) || !frozen.includes(p[1]);
    return { ok: true, at: init, movable, frozenParams: frozen.length };
  }

  // A whole entity: a line translates with the pointer (both ends held softly at their
  // start positions plus the pointer's offset from `grab`); a circle or an arc takes the
  // pointer on its edge (its radius follows) while its centre is held softly in place.
  function dragStartEntity(entityId, grab, { freeze = true } = {}) {
    if (!sk) throw new Error('load() a sketch first');
    const e = entityInfo.get(entityId);
    if (!e || e.kind === 'point') throw new SketchInputError(`entity "${entityId}" cannot be dragged as a whole`);
    if (!Array.isArray(grab) || grab.length !== 2) throw new SketchInputError('dragStartEntity needs the grab point [u, v]');
    gcs.clear_by_id(TEMP_TAG);
    unfreeze();
    drag = null;
    if (freeze) {
      if (analyzedVersion !== geomVersion) {
        gcs.diagnose_fresh(ALG.DOGLEG);
        analyzedVersion = geomVersion;
      } else {
        gcs.init_solution(ALG.DOGLEG);
      }
    } else {
      gcs.init_solution(ALG.DOGLEG);
    }
    if (gcs.has_conflicting()) {
      return { ok: false, reason: 'conflicting', movable: false, frozenParams: 0, conflicting: diagnosisLists().conflicting };
    }
    if (freeze) freezeDetermined();
    const vals = readParams();
    let ends = null;
    // P4b (SKETCH): a spline translates as a whole (each of its points held softly at its start plus the offset).
    let multi = null;
    if (e.kind === 'spline') {
      multi = e.pts.map((id) => {
        const p = pointParams.get(id);
        const start = [vals[p[0]], vals[p[1]]];
        const t = [push(start[0], true, '#dragm', 'u'), push(start[1], true, '#dragm', 'v')];
        withGeo([P(t), P(p)], (a, q) => gcs.add_constraint_p2p_coincident(a, q, TEMP_TAG, true, 1));
        return { t, start };
      });
    } else if (e.kind === 'line') {
      ends = [[vals[e.p1[0]], vals[e.p1[1]]], [vals[e.p2[0]], vals[e.p2[1]]]];
      writeParams(ends[0], dragTarget[0]);
      writeParams(ends[1], dragTarget2[0]);
      withGeo([P(dragTarget), P(e.p1)], (t, q) => gcs.add_constraint_p2p_coincident(t, q, TEMP_TAG, true, 1));
      withGeo([P(dragTarget2), P(e.p2)], (t, q) => gcs.add_constraint_p2p_coincident(t, q, TEMP_TAG, true, 1));
    } else {
      // circle or arc: the pointer on the edge, the centre held where it is
      writeParams(grab, dragTarget[0]);
      writeParams([vals[e.c[0]], vals[e.c[1]]], dragTarget2[0]);
      const cc = { c: e.c, r: e.r };
      withGeo([P(dragTarget), C(cc)], (t, c) => gcs.add_constraint_point_on_circle(t, c, TEMP_TAG, true, 1));
      withGeo([P(dragTarget2), P(e.c)], (t, q) => gcs.add_constraint_p2p_coincident(t, q, TEMP_TAG, true, 1));
    }
    gcs.init_solution(ALG.DOGLEG);
    drag = { kind: multi ? 'multi' : e.kind === 'line' ? 'line' : 'radius', entity: entityId, ends, multi, init: [...grab], grab: [...grab], step: 0, reinits: 0, freeze, frozen: frozen.length };
    const movable = e.params.some((i) => !frozen.includes(i));
    return { ok: true, at: [...grab], movable, frozenParams: frozen.length };
  }

  // FreeCAD Sketcher: each move re-solves from the drag-start reference; when the pointer
  // gets further than 20 first-steps away, the reference is re-initialised at the current
  // solution. reinit:'always' re-initialises before every move instead.
  function dragMove(u, v, { reinit = 'far', full = true } = {}) {
    if (!drag) return { status: 'idle' }; // no drag in progress (never started or refused)
    const d = Math.hypot(u - drag.init[0], v - drag.init[1]);
    if (reinit === 'always' || (drag.step > 0 && d > 20 * drag.step)) {
      gcs.init_solution(ALG.DOGLEG);
      if (drag.kind === 'point') {
        const vals = readParams();
        const p = ptOf(drag.pointId);
        drag.init = [vals[p[0]], vals[p[1]]];
      } else {
        drag.init = [u, v];
      }
      drag.step = 0;
      drag.reinits += 1;
    } else if (drag.step === 0) {
      drag.step = d;
    }
    if (drag.kind === 'multi') {
      // P4b (SKETCH): a spline's points follow the pointer's offset.
      const du = u - drag.grab[0];
      const dv = v - drag.grab[1];
      for (const m of drag.multi) writeParams([m.start[0] + du, m.start[1] + dv], m.t[0]);
    } else if (drag.kind === 'line') {
      const du = u - drag.grab[0];
      const dv = v - drag.grab[1];
      writeParams([drag.ends[0][0] + du, drag.ends[0][1] + dv], dragTarget[0]);
      writeParams([drag.ends[1][0] + du, drag.ends[1][1] + dv], dragTarget2[0]);
    } else {
      writeParams([u, v], dragTarget[0]);
    }
    const ok = solvePrepared(false);
    geomVersion++;
    return { status: ok ? 'ok' : 'failed', values: full ? values(lastGood) : undefined };
  }

  function dragEnd() {
    if (!drag) return solve();
    gcs.clear_by_id(TEMP_TAG);
    unfreeze();
    drag = null;
    return solve();
  }

  // Re-applies the drag freeze after a full-system call made during a drag.
  function refreeze() {
    if (drag && drag.freeze) {
      freezeDetermined();
      gcs.init_solution(ALG.DOGLEG);
      drag.frozen = frozen.length;
    }
  }

  function analyze() {
    if (!sk) throw new Error('load() a sketch first');
    const t0 = performance.now();
    unfreeze();
    const dof = gcs.diagnose_fresh(ALG.DOGLEG);
    analyzedVersion = geomVersion;
    const dep = vecToArray(gcs.get_dependent_params());
    refreeze();
    const depSet = new Set(dep);
    const lists = diagnosisLists();
    const over = new Set();
    for (const cid of [...lists.conflicting, ...lists.redundant]) {
      for (const r of consInfo.get(cid).refs) over.add(r);
    }
    const perEntity = {};
    for (const [id, e] of entityInfo) {
      if (over.has(id) || e.pts.some((p) => over.has(p))) perEntity[id] = 'over';
      else perEntity[id] = e.params.some((i) => depSet.has(i)) ? 'under' : 'fully';
    }
    const perPoint = {};
    for (const [id, [ix, iy]] of pointParams) {
      if (over.has(id)) perPoint[id] = 'over';
      else perPoint[id] = depSet.has(ix) || depSet.has(iy) ? 'under' : 'fully';
    }
    const dependentParams = dep.map((i) => (paramOwner[i] ? `${paramOwner[i].owner}.${paramOwner[i].name}` : `#${i}`));
    return { dof, perEntity, perPoint, dependentParams, ...lists, ms: performance.now() - t0 };
  }

  function stats() {
    return { params: nParams, initMs, dragging: !!drag, dragReinits: drag ? drag.reinits : 0, frozenParams: frozen.length, heapBytes: M.HEAPF64.buffer.byteLength };
  }

  function dispose() {
    gcs.clear_data();
    gcs.delete();
  }

  const _internals = () => ({ M, gcs, pointParams, entityInfo, consInfo, dragTarget, frozen, paramOwner });
  return { load, solve, dragStart, dragStartEntity, dragMove, dragEnd, setValue, analyze, values: () => values(), stats, dispose, _internals };
}
