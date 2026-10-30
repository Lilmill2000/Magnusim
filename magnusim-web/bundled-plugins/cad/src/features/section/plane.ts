// Section view (INSPECT > Section view, the view tools' section, the Assistant's workspace section):
// the plane a cut is parallel to, in words and where it is now. A plane is a PlaneRef
// (src/types/references.ts): an origin plane (its own frame), a construction plane (its feature's
// built frame: the cut follows it when an edit moves it) or a flat face by its stored reference (the
// naming layer finds it again after each rebuild, as a feature's face does). The offset is along the
// plane's own normal from its frame's origin (an origin plane: from the origin, as "Front offset
// 10 mm" means everywhere; a face: from its centre, the normal out of the material).
// Owner: VIEWPORT (the section view's plane).
// SPDX-License-Identifier: GPL-3.0-or-later
import { resolvePlane, refWords } from '../refgeom/resolve';
import type { AppServices } from '../../types/app';
import { ORIGIN_PLANES, type BodyId, type FeatureId, type PlaneFrame, type SketchFeature, type Vec3 } from '../../types/doc';
import type { BuiltBody, DocState, FeatureOutput } from '../../types/doc-service';
import type { PlaneRef } from '../../types/references';

/** The command (INSPECT > Section view) and its panel. */
export const SECTION_COMMAND = 'inspect.section';

/** A plane's identity, to tell two picks apart ("origin:origin:top", "feature:f_1", "face:b_1:F:f_2:end"). */
export function sectionPlaneKey(p: PlaneRef): string {
  return p.kind === 'origin' ? `origin:${p.plane}` : p.kind === 'feature' ? `feature:${p.feature}` : `face:${p.body}:${p.ref.name}`;
}

/** The plane in the person's words, as the Part names it now ("Front plane", "Plane 1", "End face of Extrude 1"). */
export function sectionPlaneWords(s: Pick<DocState, 'doc' | 'rebuild'>, p: PlaneRef): string {
  const feature = (id: FeatureId) => s.doc.features.find((f) => f.id === id)?.name ?? null;
  const body = (id: BodyId) => s.rebuild.bodies.find((b) => b.id === id)?.name ?? s.doc.bodies[id]?.name ?? null;
  const words = refWords(
    p,
    feature,
    body,
    (id) => s.doc.features.find((f) => f.id === id) as SketchFeature | undefined,
    (id) => s.rebuild.bodies.find((b) => b.id === id)?.names?.faces ?? null,
  );
  // A face is said with its body: two bodies may have an "End face of Extrude 1".
  if (p.kind === 'face') {
    const b = body(p.body);
    return b && !words.includes(` of ${b}`) ? `${words} on ${b}` : words;
  }
  return words;
}

/** An origin plane's word as the Assistant writes it ("Top"), or null for any other plane. */
export function originWord(p: PlaneRef): 'Top' | 'Front' | 'Right' | null {
  return p.kind === 'origin' ? (ORIGIN_PLANES[p.plane].label.replace(/ plane$/, '') as 'Top' | 'Front' | 'Right') : null;
}

export type FrameFound = { ok: true; frame: PlaneFrame; warning?: string } | { ok: false; message: string };

/**
 * Where the plane is now, on the Part as built (the rollback bar's position): an origin plane's frame,
 * a construction plane's built frame, a flat face found by its stored reference (a kernel call).
 * Not found: why, in the panels' words ("Plane 1 did not build", "End face of Extrude 1 not found on
 * Body 1 after rebuild", "it uses a feature that was deleted").
 */
export async function findSectionFrame(services: Pick<AppServices, 'doc' | 'kernel'>, p: PlaneRef): Promise<FrameFound> {
  const s = services.doc.state.get();
  const bodies = new Map<BodyId, BuiltBody>(s.rebuild.bodies.map((b) => [b.id, { id: b.id, shape: b.shape, valid: b.valid, feature: b.feature, names: b.names ?? null, placement: b.placement ?? null }]));
  const ctx = {
    kernel: services.kernel,
    bodies,
    outputs: new Map<FeatureId, FeatureOutput>(Object.entries(s.rebuild.outputs)),
    doc: s.doc,
    bodyName: (id: BodyId) => s.rebuild.bodies.find((b) => b.id === id)?.name ?? s.doc.bodies[id]?.name ?? 'a body',
    featureName: (id: FeatureId) => s.doc.features.find((f) => f.id === id)?.name ?? 'a deleted feature',
  };
  try {
    const r = await resolvePlane(p, ctx as unknown as Parameters<typeof resolvePlane>[1]);
    if (!r.ok) return { ok: false, message: r.message };
    return { ok: true, frame: r.value, ...(r.warning ? { warning: r.warning } : {}) };
  } catch (err) {
    // The kernel stopped (a respawn): the plane is not found now.
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/** Two frames that cut in the same place (the same origin and normal within 1e-9). */
export function sameFrame(a: Pick<PlaneFrame, 'origin' | 'normal'>, b: Pick<PlaneFrame, 'origin' | 'normal'>): boolean {
  return [0, 1, 2].every((i) => Math.abs(a.origin[i] - b.origin[i]) <= 1e-9 && Math.abs(a.normal[i] - b.normal[i]) <= 1e-9);
}

const unit = (v: readonly number[]): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

/** The point where the cut crosses the frame's normal line: origin + offset * normal (model mm). */
export function cutPoint(frame: Pick<PlaneFrame, 'origin' | 'normal'>, offset: number): Vec3 {
  const n = unit(frame.normal);
  return [frame.origin[0] + n[0] * offset, frame.origin[1] + n[1] * offset, frame.origin[2] + n[2] * offset];
}

/** The axis a normal lies along (+-X, Y or Z within 1e-9), or null for a slanted one. */
function axisOf(normal: readonly number[]): { axis: 'x' | 'y' | 'z'; sign: 1 | -1 } | null {
  const n = unit(normal);
  for (let i = 0; i < 3; i++) if (Math.abs(Math.abs(n[i]) - 1) <= 1e-9) return { axis: (['x', 'y', 'z'] as const)[i], sign: n[i] > 0 ? 1 : -1 };
  return null;
}

/** A length for words ("4", "-10", "2.5"). */
const len = (v: number) => String(Number(v.toFixed(6)) + 0);

/**
 * What a cut keeps, in model words: "z <= 4 mm" for a plane square to an axis (the side away from its
 * normal unless flipped), else "the side against its normal" / "along its normal".
 */
export function keepsWords(frame: Pick<PlaneFrame, 'origin' | 'normal'>, offset: number, flip: boolean, length: (mm: number) => string = (mm) => `${len(mm)} mm`): string {
  const a = axisOf(frame.normal);
  if (!a) return flip ? 'the side along its normal' : 'the side against its normal';
  const at = cutPoint(frame, offset)[a.axis === 'x' ? 0 : a.axis === 'y' ? 1 : 2];
  // Unflipped, the side away from the normal stays: sign * coord <= sign * at.
  const below = (a.sign === 1) !== flip;
  return `${a.axis} ${below ? '<=' : '>='} ${length(at)}`;
}

/**
 * A cut in the Assistant's words (the view tool's data, the workspace's view, get_model): the plane by
 * its words ("Top", "Plane 1", "End face of Extrude 1 on Body 1"), the offset (mm, to 1e-4), the side,
 * `middle` when it was asked so, and what it keeps.
 */
export function sectionWords(s: Pick<DocState, 'doc' | 'rebuild'>, c: { plane: PlaneRef; frame: Pick<PlaneFrame, 'origin' | 'normal'>; offset: number; flip: boolean; middle?: true }): Record<string, unknown> {
  const offset = Math.round(c.offset * 1e4) / 1e4 + 0;
  return { plane: originWord(c.plane) ?? sectionPlaneWords(s, c.plane), offset_mm: offset, flip: c.flip, ...(c.middle ? { middle: true } : {}), keeps: keepsWords(c.frame, c.offset, c.flip) };
}

/** The axis index (0, 1, 2) a normal lies along, or -1 for a slanted one. */
export function axisIndexOf(normal: readonly number[]): number {
  const a = axisOf(normal);
  return a ? ['x', 'y', 'z'].indexOf(a.axis) : -1;
}
