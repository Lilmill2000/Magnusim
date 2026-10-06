// Resolving stored geometry references (src/types/references.ts) at a rebuild:
// what an AxisRef, PlaneRef, PointRef, EdgeRef or FaceRef is now, from the
// bodies built before the feature (faces, edges and vertices by their persistent
// names, src/naming), the sketches' and CONSTRUCT features' outputs, and the
// origin. A lost reference is an error in the panels' words ("End face of
// Extrude 1 not found on Body 1 after rebuild", "Plane 1 did not build"); a name
// matched on geometry that moved kind is a warning ("Reference repaired · check").
// Nothing is repaired silently and nothing here writes the document.
// Owner: REFERENCE (P4a). SOLIDS may use it for Revolve's axis.
// SPDX-License-Identifier: GPL-3.0-or-later
import { AXIS_DIR } from '../../doc/features/primitives';
import { describeFace, kernelLookup, resolveFace } from '../../naming';
import { ORIGIN_PLANES, type BodyId, type FeatureId, type PlaneFrame, type SketchFeature, type Vec3 } from '../../types/doc';
import type { BuildContext, BuiltBody, FeatureOutput } from '../../types/doc-service';
import type { KernelCallError } from '../../types/kernel';
import type { TopoResult } from '../../types/kernel-protocol';
import type { AxisRef, EdgeRef, FaceRef, GeomRef, PlaneRef, PointRef } from '../../types/references';
import { faceFrame, toModel } from '../sketch/plane';
import { curveWords, sketchPointWords } from '../solids/geom';
import { edgeInfo, edgeWords, vertexPoint, vertexWords, type EdgeInfo } from './brep';
import { axisThrough, unit } from './geom';

export type Resolved<T> = { ok: true; value: T; warning?: string } | { ok: false; message: string };
export type Axis = { origin: Vec3; dir: Vec3 };
type Ctx = Pick<BuildContext, 'bodies' | 'kernel' | 'outputs' | 'doc' | 'bodyName' | 'featureName'>;
type TopoFace = TopoResult['faces'][number];

const ORIGIN_AXIS_LABEL: Record<string, string> = { 'origin:x': 'X axis', 'origin:y': 'Y axis', 'origin:z': 'Z axis' };

/** Feature ids a list of references depends on (FeatureTypeDef.parents). */
export function refParents(refs: readonly (GeomRef | null | undefined)[]): FeatureId[] {
  const out = new Set<FeatureId>();
  for (const r of refs) {
    if (!r) continue;
    if (r.kind === 'normal') for (const id of refParents([r.plane])) out.add(id);
    else if (r.kind === 'feature') out.add(r.feature);
    else if (r.kind === 'sketch-line') out.add(r.sketch);
    else if (r.kind === 'sketch-point') out.add(r.sketch);
    else if (r.kind === 'sketch-curve') out.add(r.sketch);
  }
  return [...out];
}

/** Bodies a list of references reads (FeatureTypeDef.uses): their geometry changing rebuilds the feature. */
export function refBodies(refs: readonly (GeomRef | null | undefined)[]): BodyId[] {
  const out = new Set<BodyId>();
  for (const r of refs) {
    if (r && r.kind === 'normal') for (const b of refBodies([r.plane])) out.add(b);
    else if (r && 'body' in r) out.add(r.body);
  }
  return [...out];
}

/**
 * A reference in words, for panel rows and messages: "Top plane", "Z axis", "Origin",
 * "Plane 1", "End face of Extrude 1", "Side 2 of Extrude 1", "Line of Sketch 1", "Corner of
 * Line 1 and Line 2 of Sketch 3". `facesOf` gives a body's face names, so sides are numbered
 * as the PICKED chip and the Fillet panel number them (P4a review: "Side e_6cctu2upm20i").
 */
export function refWords(ref: GeomRef, featureName: (id: FeatureId) => string | null, bodyName: (id: BodyId) => string | null = () => null, sketchOf?: (id: FeatureId) => SketchFeature | undefined, facesOf: (id: BodyId) => readonly string[] | null = () => null): string {
  switch (ref.kind) {
    case 'origin':
      if ('plane' in ref) return ORIGIN_PLANES[ref.plane]?.label ?? 'An origin plane';
      if ('axis' in ref) return ORIGIN_AXIS_LABEL[ref.axis] ?? 'An origin axis';
      return 'Origin';
    case 'feature':
      return featureName(ref.feature) ?? 'A deleted feature';
    case 'sketch-line':
      return `Line of ${featureName(ref.sketch) ?? 'a deleted sketch'}`;
    case 'sketch-point':
      return `${sketchPointWords(sketchOf?.(ref.sketch), ref.point)} of ${featureName(ref.sketch) ?? 'a deleted sketch'}`;
    case 'sketch-curve':
      return `${curveWords(sketchOf?.(ref.sketch), ref.entity)} of ${featureName(ref.sketch) ?? 'a deleted sketch'}`;
    case 'face':
    case 'face-axis': {
      // A face known only by its number (an import's) is named as Measure and Delete faces name it:
      // its number on the body as shown, and the body ("Face 7 of flange"; P4a review: "Face 8 of
      // Imported 1 (flange.step)" here, "Face 7 of flange" there).
      const faces = facesOf(ref.body);
      const body = bodyName(ref.body);
      if (faces && body && /^F:[^:]+:(import|primitive):/.test(ref.ref.name)) {
        const i = faces.findIndex((n) => n === ref.ref.name || n.split('|').includes(ref.ref.name));
        if (i >= 0) return `Face ${i + 1} of ${body}`;
      }
      return describeFace(ref.ref.name, featureName, faces);
    }
    case 'edge':
      return edgeWords(ref.ref.name, featureName, bodyName(ref.body), facesOf(ref.body));
    case 'vertex':
      return vertexWords(ref.ref.name, featureName, bodyName(ref.body), facesOf(ref.body));
    case 'normal':
      return `Normal to ${refWords(ref.plane, featureName, bodyName, sketchOf, facesOf)}`;
  }
}

/** A reference in words inside a build (its feature, body and sketch names as they are now). */
export function wordsIn(ctx: Pick<BuildContext, 'doc' | 'featureName' | 'bodyName'>, ref: GeomRef): string {
  return ctxWords(ctx as Ctx, ref);
}

function ctxWords(ctx: Ctx, ref: GeomRef): string {
  return refWords(
    ref,
    (id) => (ctx.doc.features.some((f) => f.id === id) ? ctx.featureName(id) : null),
    (id) => ctx.bodyName(id),
    (id) => ctx.doc.features.find((f) => f.id === id) as SketchFeature | undefined,
    (id) => ctx.bodies.get(id)?.names?.faces ?? null,
  );
}

/** The output of a referenced feature, or why it has none. */
function outputOf(ctx: Ctx, id: FeatureId): { ok: true; out: FeatureOutput } | { ok: false; message: string } {
  const out = ctx.outputs.get(id);
  if (out) return { ok: true, out };
  const f = ctx.doc.features.find((g) => g.id === id);
  if (!f) return { ok: false, message: 'it uses a feature that was deleted' };
  if (f.suppressed) return { ok: false, message: `${f.name} is suppressed` };
  return { ok: false, message: `${f.name} did not build` };
}

function bodyOf(ctx: Ctx, id: BodyId): { ok: true; body: BuiltBody } | { ok: false; message: string } {
  const body = ctx.bodies.get(id);
  if (!body) return { ok: false, message: `${ctx.bodyName(id)} is not there at this point` };
  if (!body.names) return { ok: false, message: `the faces of ${ctx.bodyName(id)} have no names (the step that made it gave none)` };
  return { ok: true, body };
}

/** Kernel errors about the input are the reference's problem; stops (watchdog, crash) go to the rebuild. */
function kernelProblem(err: unknown): string {
  const e = err as KernelCallError;
  if (e && (e.kind === 'occt' || e.kind === 'input' || e.kind === 'internal')) return e.message;
  throw err;
}

/** A face reference resolved: its topo (type, normal or axis, centroid). */
export async function resolveFaceRef(ref: FaceRef | Extract<GeomRef, { kind: 'face' | 'face-axis' }>, ctx: Ctx): Promise<Resolved<TopoFace>> {
  const b = bodyOf(ctx, ref.body);
  if (!b.ok) return b;
  const lookup = kernelLookup(ctx.kernel);
  try {
    const r = await resolveFace({ ref: ref.ref, shape: b.body.shape, names: b.body.names!, lookup });
    if (!r.ok) return { ok: false, message: `${ctxWords(ctx, ref)} not found on ${ctx.bodyName(ref.body)} after rebuild` };
    const [face] = await lookup.faces(b.body.shape, [r.index]);
    if (!face) return { ok: false, message: `${ctxWords(ctx, ref)} not found on ${ctx.bodyName(ref.body)} after rebuild` };
    return { ok: true, value: face, ...(r.how !== 'name' ? { warning: `${ctxWords(ctx, ref)}: ${r.warning ?? 'Reference repaired · check'}` } : {}) };
  } catch (err) {
    return { ok: false, message: kernelProblem(err) };
  }
}

/** An edge reference resolved: its index on the body and what it is (line, circle, ... with its points). */
export async function resolveEdgeRef(ref: EdgeRef | Extract<AxisRef, { kind: 'edge' }>, ctx: Ctx): Promise<Resolved<EdgeInfo>> {
  const b = bodyOf(ctx, ref.body);
  if (!b.ok) return b;
  try {
    return await edgeInfo(ctx.kernel, b.body, ref.ref, () => ctxWords(ctx, ref), ctx.bodyName(ref.body));
  } catch (err) {
    return { ok: false, message: kernelProblem(err) };
  }
}

export async function resolvePlane(ref: PlaneRef, ctx: Ctx): Promise<Resolved<PlaneFrame>> {
  if (ref.kind === 'origin') {
    const p = ORIGIN_PLANES[ref.plane];
    if (!p) return { ok: false, message: 'that origin plane does not exist' };
    return { ok: true, value: { origin: [...p.origin] as Vec3, normal: [...p.normal] as Vec3, xdir: [...p.xdir] as Vec3 } };
  }
  if (ref.kind === 'feature') {
    const o = outputOf(ctx, ref.feature);
    if (!o.ok) return o;
    if (o.out.type !== 'plane') return { ok: false, message: `${ctx.featureName(ref.feature)} is not a plane` };
    return { ok: true, value: o.out.frame };
  }
  const r = await resolveFaceRef(ref, ctx);
  if (!r.ok) return r;
  const f = r.value;
  if (f.type !== 'plane' || !f.normal || !f.centroid) return { ok: false, message: `${ctxWords(ctx, ref)} is not flat` };
  return { ok: true, value: faceFrame(f.normal as Vec3, f.centroid as Vec3), ...(r.warning ? { warning: r.warning } : {}) };
}

export async function resolveAxis(ref: AxisRef, ctx: Ctx): Promise<Resolved<Axis>> {
  if (ref.kind === 'origin') {
    const d = AXIS_DIR[ref.axis];
    if (!d) return { ok: false, message: 'that origin axis does not exist' };
    return { ok: true, value: { origin: [0, 0, 0], dir: [...d] as Vec3 } };
  }
  if (ref.kind === 'feature') {
    const o = outputOf(ctx, ref.feature);
    if (!o.ok) return o;
    if (o.out.type !== 'axis') return { ok: false, message: `${ctx.featureName(ref.feature)} is not an axis` };
    return { ok: true, value: { origin: o.out.origin, dir: o.out.dir } };
  }
  if (ref.kind === 'normal') {
    const p = await resolvePlane(ref.plane, ctx);
    if (!p.ok) return p;
    const dir = unit(p.value.normal);
    if (!dir) return { ok: false, message: `${ctxWords(ctx, ref.plane)} has no normal` };
    return { ok: true, value: { origin: [...p.value.origin] as Vec3, dir }, ...(p.warning ? { warning: p.warning } : {}) };
  }
  if (ref.kind === 'sketch-line') {
    const o = outputOf(ctx, ref.sketch);
    if (!o.ok) return o;
    const sk = ctx.doc.features.find((f) => f.id === ref.sketch) as SketchFeature | undefined;
    const e = sk?.entities.find((x) => x.id === ref.entity);
    if (o.out.type !== 'sketch' || !e || e.kind !== 'line') return { ok: false, message: `the line of ${ctx.featureName(ref.sketch)} is gone` };
    const pa = o.out.points[e.p[0]];
    const pb = o.out.points[e.p[1]];
    if (!pa || !pb) return { ok: false, message: `the line of ${ctx.featureName(ref.sketch)} is gone` };
    const r = axisThrough(toModel(o.out.plane, pa), toModel(o.out.plane, pb));
    return r.ok ? { ok: true, value: r.value } : { ok: false, message: `the line of ${ctx.featureName(ref.sketch)} has no length` };
  }
  if (ref.kind === 'face-axis') {
    const r = await resolveFaceRef(ref, ctx);
    if (!r.ok) return r;
    const f = r.value;
    const dir = f.axis ? unit(f.axis.dir as Vec3) : null;
    if (!f.axis || !dir) return { ok: false, message: `${ctxWords(ctx, ref)} has no axis (it is ${f.type === 'plane' ? 'flat' : `a ${f.type} face`})` };
    return { ok: true, value: { origin: [...f.axis.origin] as Vec3, dir }, ...(r.warning ? { warning: r.warning } : {}) };
  }
  const r = await resolveEdgeRef(ref, ctx);
  if (!r.ok) return r;
  const e = r.value;
  if (e.type === 'line') {
    const a = axisThrough(e.first, e.last);
    return a.ok ? { ok: true, value: a.value, ...(r.warning ? { warning: r.warning } : {}) } : { ok: false, message: `${ctxWords(ctx, ref)} has no length` };
  }
  if (e.type === 'circle' && e.center && e.axisDir) {
    return { ok: true, value: { origin: e.center, dir: e.axisDir }, ...(r.warning ? { warning: r.warning } : {}) };
  }
  return { ok: false, message: `${ctxWords(ctx, ref)} is neither straight nor round, so it gives no axis` };
}

export async function resolvePoint(ref: PointRef, ctx: Ctx): Promise<Resolved<Vec3>> {
  if (ref.kind === 'origin') return { ok: true, value: [0, 0, 0] };
  if (ref.kind === 'feature') {
    const o = outputOf(ctx, ref.feature);
    if (!o.ok) return o;
    if (o.out.type !== 'point') return { ok: false, message: `${ctx.featureName(ref.feature)} is not a point` };
    return { ok: true, value: o.out.p };
  }
  if (ref.kind === 'sketch-point') {
    const o = outputOf(ctx, ref.sketch);
    if (!o.ok) return o;
    const uv = o.out.type === 'sketch' ? o.out.points[ref.point] : undefined;
    if (o.out.type !== 'sketch' || !uv) return { ok: false, message: `the point of ${ctx.featureName(ref.sketch)} is gone` };
    return { ok: true, value: toModel(o.out.plane, uv) };
  }
  const b = bodyOf(ctx, ref.body);
  if (!b.ok) return b;
  try {
    return await vertexPoint(ctx.kernel, b.body, ref.ref, () => ctxWords(ctx, ref), ctx.bodyName(ref.body));
  } catch (err) {
    return { ok: false, message: kernelProblem(err) };
  }
}
