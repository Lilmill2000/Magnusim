// Stored face references for P2 features (docs/p2p3-plan.md §1.1, §3.6):
// made once, when the user picks a face (refOfFace on the body as it is shown,
// which is the only re-anchoring point), resolved at every rebuild against the
// body the feature works on (resolveFace: by name, then by signature; never
// silently). A face picked on a body this same feature already changed keeps
// its name through the feature's history, so it resolves on the feature's
// input; a face the feature itself made cannot be picked for it.
// Owner: P2-FEATURES.
// SPDX-License-Identifier: GPL-3.0-or-later
import { describeFace, kernelLookup, refOfFace, resolveFace } from '../../naming';
import { splitMerged } from '../../naming/names';
import type { AppServices } from '../../types/app';
import type { BodyId, Feature, FeatureId, PersistentRef } from '../../types/doc';
import type { BuildContext, BuiltBody } from '../../types/doc-service';
import type { BodyInfo } from '../../types/kernel';
import type { NamingLookup } from '../../types/naming';
import type { SelectionItem } from '../../types/selection';

/** The faces in a selection (body + face index). */
export function selectedFaces(items: readonly SelectionItem[]): { kind: 'face'; body: BodyId; index: number }[] {
  const out: { kind: 'face'; body: BodyId; index: number }[] = [];
  for (const it of items) if (it.kind === 'face') out.push({ kind: 'face', body: it.body, index: it.index });
  return out;
}

/** The feature a face name says made it ("F:<feature>:..."), or null. */
export function featureOfName(name: string): FeatureId | null {
  const m = /^F:([^:|#]+):/.exec(splitMerged(name)[0] ?? name);
  return m ? m[1] : null;
}

/** Words for a stored reference in a panel row ("Face 3 (Imported 1)"). */
export function refLabel(services: AppServices, ref: PersistentRef): string {
  const features = services.doc.state.get().doc.features;
  return describeFace(ref.name, (id) => features.find((f) => f.id === id)?.name ?? null);
}

/** The words a build uses when a stored face is not on the body it works on (resolveRefs). */
export function notFoundWords(face: string, body: string): string {
  return `${face} not found on ${body} after rebuild`;
}

/**
 * Whether a feature's status says a stored face is not on its body: the error resolveRefs
 * gives, naming the face (`label`, in refLabel's words), or naming none of them when `any`.
 */
export function statusLostFace(status: { state: string; message?: string } | undefined, label: string | null): boolean {
  if (status?.state !== 'error' || !status.message || !/ not found on .+ after rebuild/.test(status.message)) return false;
  return label == null || status.message.includes(`${label} not found on `);
}

export type PickedFace = { ok: true; body: BodyId; ref: PersistentRef } | { ok: false; reason: string };

/**
 * A stored reference for face `index` of a shown body. Refuses a body with no
 * face names (a result the kernel could not name), and a face that `self`
 * (the feature being edited) made.
 */
export async function pickFace(services: AppServices, body: BodyInfo, index: number, self: FeatureId | null, lookup?: NamingLookup): Promise<PickedFace> {
  const names = body.names ?? null;
  const name = names?.faces[index];
  if (!name) return { ok: false, reason: `The faces of ${body.name} have no names, so they cannot be kept by a feature` };
  if (self && splitMerged(name).every((n) => featureOfName(n) === self)) return { ok: false, reason: 'That face is made by this feature itself' };
  try {
    const ref = await refOfFace(lookup ?? kernelLookup(services.kernel), body.shape, names, index);
    return { ok: true, body: body.id, ref };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** The faces of the shown bodies a list of stored references points at now (for highlighting). */
export function shownFaces(body: BodyInfo | undefined, refs: readonly PersistentRef[]): number[] {
  if (!body?.names) return [];
  const want = new Set(refs.map((r) => r.name));
  const out: number[] = [];
  body.names.faces.forEach((n, i) => {
    if (want.has(n) || splitMerged(n).some((p) => want.has(p))) out.push(i);
  });
  return out;
}

/** The index of the face a stored name names in a list of face names (merged names included), or -1. */
export function faceIndexIn(faces: readonly string[], name: string): number {
  return faces.findIndex((n) => n === name || splitMerged(n).includes(name));
}

export type Resolved = { ok: true; indices: number[]; warning: string | null } | { ok: false; message: string };

/**
 * Resolve stored references against the body a build works on. Every
 * reference must be found (no partial result): a miss is the feature's error,
 * a repaired match its warning ("Reference repaired · check").
 */
export async function resolveRefs(ctx: BuildContext, body: BuiltBody, refs: readonly PersistentRef[], lookup?: NamingLookup): Promise<Resolved> {
  if (!refs.length) return { ok: true, indices: [], warning: null };
  if (!body.names) return { ok: false, message: `the faces of ${ctx.bodyName(body.id)} have no names (the step that made it gave none)` };
  const look = lookup ?? kernelLookup(ctx.kernel);
  const indices: number[] = [];
  let warning: string | null = null;
  for (const ref of refs) {
    const r = await resolveFace({ ref, shape: body.shape, names: body.names, lookup: look });
    // Which face, in the words the panels use (review P2/P3 round 2: "Face not found after rebuild" named none).
    if (!r.ok) return { ok: false, message: notFoundWords(describeFace(ref.name, (id) => ctx.featureName?.(id) ?? null), ctx.bodyName(body.id)) };
    if (r.warning) warning = r.warning;
    if (!indices.includes(r.index)) indices.push(r.index);
  }
  return { ok: true, indices, warning };
}

/** The feature (by type) a face name says made it, for words and the Delete dialog. */
export function makerOf(features: readonly Feature[], name: string): Feature | null {
  const id = featureOfName(name);
  return id ? (features.find((f) => f.id === id) ?? null) : null;
}
