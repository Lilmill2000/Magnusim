// The Delete faces panel's Add by size (the Analysis Situs plan §3.3): "Fillets up to R" and "Holes
// up to Ø D" add the faces the selectors "<body> faces fillet <= R mm" and "<body> faces hole <= D
// mm" name (S4's fillet and sized-hole filters, kernel API 8 recognition), read on the body as it is
// just before this Delete faces, which is where its faces resolve: the same code, scene and
// references as the Assistant's direct delete_faces with that selector (selectors/resolve.ts,
// selectors/refs.ts faceRefOf), so the person's Add and the Assistant's faces are the same refs.
// Only faces not already picked are added; the panel then applies them as a click does. Every
// refusal is words: no body to use, a body over the face limit, a surface body, a kernel below
// API 8 (the Find panel's own words for them), or what the body has when nothing new matched.
// Owner: P2-FEATURES.
// SPDX-License-Identifier: GPL-3.0-or-later
import { quoteName } from '../../assistant/labels';
import { personCall, type PersonCall } from '../../assistant/person-call';
import { faceRefOf } from '../../assistant/selectors/refs';
import { evaluate, parseFor, withScene, type FaceHit } from '../../assistant/selectors/resolve';
import { recognitionOf, summaryOf } from '../../kernel/recognition';
import type { AppServices } from '../../types/app';
import type { BodyId, FeatureId, PersistentRef } from '../../types/doc';
import { findError } from '../find/panel';
import { addTarget, addedWords, noneWords, type SizeKind } from './words';

export interface AddBySize {
  /** The Delete faces being made or edited. */
  feature: FeatureId;
  /** The field's body ('' with no face picked yet: the Part's one solid body). */
  body: BodyId | '';
  kind: SizeKind;
  /** The size, mm (above 0). */
  size: number;
  /** The faces picked now (by name): not added again. */
  picked: readonly PersistentRef[];
}

export type AddedBySize =
  /** `added`: the new faces, in the selector's order; `refs`: every face the selector names on the body. */
  | { ok: true; body: BodyId; added: PersistentRef[]; refs: PersistentRef[]; query: string; words: string }
  | { ok: false; words: string };

/** A size as the selector writes it, in mm ("2", "2.54"). */
const mmText = (v: number) => String(+v.toPrecision(12));

/** The selector Add runs: "Body 1 faces fillet <= 2 mm", "Body 1 faces hole <= 6 mm" (the body's name quoted when the grammar needs it). */
export function sizeQuery(bodyName: string, kind: SizeKind, sizeMm: number): string {
  return `${quoteName(bodyName)} faces ${kind === 'fillets' ? 'fillet' : 'hole'} <= ${mmText(sizeMm)} mm`;
}

/** Run Add: the faces to add, or why not, in words. `call` (the panel's) is stopped when the panel closes. */
export async function addBySize(services: AppServices, req: AddBySize, call: PersonCall = personCall(services, 'direct', { kind: 'delete_faces' })): Promise<AddedBySize> {
  const units = services.doc.state.get().doc.units;
  try {
    await services.doc.settled(call.signal);
    // The bodies just before this Delete faces: the stored feature's input, or (a new one not in
    // the Part yet) the bodies shown, where it goes.
    const inPart = services.doc.state.get().doc.features.some((f) => f.id === req.feature);
    return await withScene(call, { before: inPart ? req.feature : null, self: req.feature }, async (sc) => {
      const shown = sc.state.rebuild.bodies;
      const target = addTarget(
        sc.bodies.map((b) => ({ id: b.id, solids: b.solids ?? shown.find((s) => s.id === b.id)?.solids ?? null })),
        req.body,
      );
      if ('why' in target) return { ok: false, words: target.why };
      const bi = sc.bodies.findIndex((b) => b.id === target.body);
      if (bi < 0) return { ok: false, words: `${services.doc.state.get().doc.bodies[target.body]?.name ?? 'The body'} is not there just before this Delete faces: click a face of the body` };
      const b = sc.bodies[bi];
      const query = sizeQuery(b.name, req.kind, req.size);
      // selectSet's own steps (resolve.ts), with no match allowed: what is found is said in words.
      const sel = await evaluate(sc, parseFor(sc, query, 'face', 'faces'), 'face');
      const hits = sel.hits.filter((h): h is FaceHit => h.kind === 'face');
      // Every face's reference as direct delete_faces makes it; the new ones (and their hits) are added.
      const refs: PersistentRef[] = [];
      const added: PersistentRef[] = [];
      const fresh: FaceHit[] = [];
      for (const h of hits) {
        const ref = (await faceRefOf(sc, h)).ref;
        refs.push(ref);
        if (req.picked.some((p) => p.name === ref.name) || added.some((p) => p.name === ref.name)) continue;
        added.push(ref);
        fresh.push(h);
      }
      // The same recognition the filter read (the page's client, cached per shape and query): fillets
      // without holes, or holes alone, each within its own face limit.
      const search = req.kind === 'fillets' ? { holes: false } : { blends: false };
      const rec = await recognitionOf(services.kernel).features(b.shape, search, { faces: b.faces, signal: sc.signal });
      if (!added.length) {
        if (!rec.ok) return { ok: false, words: rec.words };
        return { ok: false, words: noneWords(req.kind, req.size, b.name, summaryOf(rec.result), units) };
      }
      let words: string;
      if (req.kind === 'fillets') {
        const blend = new Map(rec.ok ? rec.result.blends.map((x) => [x.face, x]) : []);
        const chains = new Set(fresh.map((h) => blend.get(h.index)?.chain ?? `face ${h.index}`));
        const radii = fresh.map((h) => h.recognized?.fillet).filter((f): f is { r_min: number; r_max: number } => !!f);
        words = addedWords({ kind: 'fillets', faces: added.length, chains: chains.size, r_min: Math.min(...radii.map((f) => f.r_min)), r_max: Math.max(...radii.map((f) => f.r_max)) }, units);
      } else {
        const holes = new Map(fresh.flatMap((h) => (h.recognized?.hole ? [[h.recognized.hole.key, h.recognized.hole.through] as const] : [])));
        words = addedWords({ kind: 'holes', faces: added.length, holes: holes.size, through: [...holes.values()].filter(Boolean).length, size: req.size }, units);
      }
      return { ok: true, body: b.id, added, refs, query, words };
    });
  } catch (e) {
    if (call.signal.aborted) return { ok: false, words: 'Stopped' };
    return { ok: false, words: findError(e) };
  }
}
