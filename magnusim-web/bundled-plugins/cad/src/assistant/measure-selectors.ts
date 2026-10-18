// measure's targets in the selector language (CAD tools spec §3.2.3, §5): faces, edges and vertices
// (roles, queries, points, "A & B", handles), bodies and the selectors' planes and axes, read by
// the selectors (selectors/resolve.ts) on the bodies built now and handed to measure as its
// Entity. The measure tool registers it (measure-targets.ts registerSelectorResolver); measure's
// own forms (body names first, "(x, y, z)", selection, the origin planes and axes, construction
// geometry by name) are read before it.
// A target is one thing: several are selector_ambiguous with up to 8 candidates, each with a
// handle, as in every single-entity field of the selectors. A sketch region is no measure target.
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { CallCtx } from '../types/assistant';
import type { BodyInfo } from '../types/kernel';
import { ToolError } from './errors';
import type { Entity, SelectorResolver } from './measure-targets';
import { candidates, edgeLabel, faceLabel, hitWords, selectAny, withScene, type Hit, type Scene } from './selectors/resolve';

/** "face Base.end on Body 1" (its label, else the person's words), as measure names what it measured. */
function wordsOf(sc: Scene, h: Exclude<Hit, { kind: 'region' | 'plane' | 'axis' | 'body' }>): string {
  const label = h.kind === 'face' ? faceLabel(sc, h) : h.kind === 'edge' ? edgeLabel(sc, h) : null;
  if (label) return `${h.kind} ${label} on ${h.body.name}`;
  if (h.kind === 'face' && !h.name) return `a face of ${h.body.name}`;
  const words = hitWords(sc, h);
  return /^an? (edge|vertex) of /.test(words) ? words : `${h.kind} ${words} on ${h.body.name}`;
}

const warningsOf = (h: Hit) => (h.warnings.length ? { warnings: [...h.warnings] } : {});

/** One hit as measure's Entity, on the body as the rebuild shows it. */
function entityOf(sc: Scene, h: Hit, field: string): Entity {
  if (h.kind === 'plane') return { kind: 'plane', frame: h.frame, words: h.words, ...warningsOf(h) };
  if (h.kind === 'axis') return { kind: 'axis', origin: [...h.origin], dir: [...h.dir], words: h.words, ...warningsOf(h) };
  if (h.kind === 'region') {
    throw new ToolError('bad_selector', `${field}: ${hitWords(sc, h)} is a sketch region; measure takes a body, a face, edge or vertex, a point, a plane or an axis (measure the body made from it).`, { detail: { field } });
  }
  const body: BodyInfo | undefined = sc.state.rebuild.bodies.find((b) => b.id === h.body.id);
  if (!body) throw new ToolError('nothing_selected', `${field}: ${h.body.name} is not built now.`, { detail: { field } });
  if (h.kind === 'body') return { kind: 'body', body, words: body.name, ...warningsOf(h) };
  return { kind: h.kind, body, index: h.index, words: wordsOf(sc, h), ...warningsOf(h) };
}

/** What a selector names on the bodies built now, as measure's entities (one, or none). */
export const selectorTargets: SelectorResolver = (ctx: CallCtx, text: string, { field }) =>
  withScene(ctx, {}, async (sc) => {
    const r = await selectAny(sc, text, field);
    if (r.hits.length > 1) {
      throw new ToolError('selector_ambiguous', `${field}: "${r.text}" names ${r.hits.length} things; a target is one: narrow it, or use one of the candidates' handles.`, {
        detail: { field, count: r.hits.length, candidates: await candidates(sc, r.hits) },
      });
    }
    return r.hits.map((h) => entityOf(sc, h, field));
  });
