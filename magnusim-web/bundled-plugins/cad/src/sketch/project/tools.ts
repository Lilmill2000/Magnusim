// Sketch mode's Project and Intersect tools (P4b SELECT; Daniel's must-haves
// 3 and 4):
//   Project: click a vertex (a fixed point), an edge (a fixed curve) or a face
//     (its outer edges) of any body, imported STEP bodies included; with
//     Silhouette on, click a body for its outline along the sketch normal. Each
//     click is one sketch undo step. What is made is LINKED: fixed, purple, and
//     read again at every rebuild (src/sketch/project/rebuild.ts).
//   Intersect: the curves where the sketch plane cuts bodies: the bodies
//     clicked, or every shown body when none is ("Intersect" in the panel).
// Sketch mode also reads every link again when a sketch is opened
// (refreshLinks), so what moved upstream is where it is now, and what is lost
// says so.
// Owner: P4b SELECT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { createStateStore } from '../../lib/store';
import { kernelLookup, refOfEdge, refOfFace, refOfVertex } from '../../naming';
import type { BodyId, SketchLink, SketchLinkSource } from '../../types/doc';
import type { AppServices } from '../../types/app';
import type { SelectionItem } from '../../types/selection';
import type { StateStore } from '../../types/state';
import { newId } from '../../lib/ids';
import type { SketchMode, SketchPointer, SketchTool } from '../mode';
import { applyLinkCurves, type LinkDraft } from './curves';
import { readLink, sourceWords, type LinkEnv } from './source';

/** The Project / Intersect options and picks (the Sketch panel's block shows them). */
export interface ProjectState {
  silhouette: boolean;
  /** Intersect: the bodies clicked so far (none = every shown body). */
  bodies: BodyId[];
}

const states = new WeakMap<object, StateStore<ProjectState>>();
export function projectStateOf(services: object): StateStore<ProjectState> {
  let s = states.get(services);
  if (!s) {
    s = createStateStore<ProjectState>({ silhouette: false, bodies: [] });
    states.set(services, s);
  }
  return s;
}

/** The env to read links in sketch mode: the bodies drawn now (the rebuild stops after the edited sketch). */
export function sketchEnv(services: AppServices): LinkEnv {
  const s = services.doc.state.get();
  const bodies = new Map(s.rebuild.bodies.map((b) => [b.id, { shape: b.shape, names: b.names ?? null }] as const));
  const names = new Map(s.rebuild.bodies.map((b) => [b.id, b.name] as const));
  return {
    kernel: services.kernel,
    bodies,
    bodyName: (id) => names.get(id) ?? s.doc.bodies[id]?.name ?? 'a body',
    featureName: (id) => s.doc.features.find((f) => f.id === id)?.name ?? null,
  };
}

function sameSource(a: SketchLinkSource, b: SketchLinkSource): boolean {
  if (a.kind !== b.kind || a.body !== b.body) return false;
  if ('ref' in a && 'ref' in b) return a.ref.name === b.ref.name;
  return true;
}

/**
 * Add a link for `source` to the sketch: read it now and add its curves (one sketch undo step).
 * Resolves with the words of what happened (for the panel's note), or the refusal.
 */
export async function addLink(mode: SketchMode, source: SketchLinkSource, type: SketchLink['type'], opts: { auto?: boolean } = {}): Promise<{ ok: true; link: SketchLink; entities: string[] } | { ok: false; reason: string }> {
  const d = mode.stored();
  const plane = mode.plane();
  if (!d || !plane) return { ok: false, reason: 'The sketch is closed' };
  const env = sketchEnv(mode.services);
  const words = sourceWords(source, env);
  const have = (d.links ?? []).find((l) => l.type === type && sameSource(l.source, source));
  // Projected on purpose after a snap made it (light, construction): it becomes an ordinary projection.
  if (have?.auto && !opts.auto) {
    const ids = new Set(have.entities.map((x) => x.entity));
    const res = await mode.apply('Project', (cur) => {
      const links = (cur.links ?? []).map((l) => (l.id === have.id ? { ...l, auto: undefined } : l));
      const entities = cur.entities.map((e) => (ids.has(e.id) && e.kind !== 'point' && e.construction ? (({ construction: _c, ...rest }) => rest)(e) : e));
      return { ok: true, draft: { ...cur, links, entities: entities as typeof cur.entities }, optional: [], removed: [] };
    });
    return res.ok ? { ok: true, link: { ...have, auto: undefined }, entities: [...ids] } : { ok: false, reason: res.reason };
  }
  if (have) return { ok: false, reason: `${words} is already in ${d.name}` };
  const link: SketchLink = { id: newId('e').replace(/^e_/, 'l_'), type, source, ...(opts.auto ? { auto: true } : {}), entities: [] };
  const r = await readLink(link, plane, env);
  if (r.state === 'lost') return { ok: false, reason: r.message.replace(/ not found after rebuild$/, ' cannot be read') };
  if (!r.curves.length) return { ok: false, reason: `${words} gives nothing on the sketch plane` };
  let made: string[] = [];
  let out: SketchLink = link;
  const res = await mode.apply(type === 'intersection' ? 'Intersect' : 'Project', (cur) => {
    const a = applyLinkCurves(cur as LinkDraft, link, r.curves, { construction: !!opts.auto });
    made = a.added;
    out = a.link;
    return { ok: true, draft: a.draft, optional: [], removed: [] };
  });
  if (!res.ok) return { ok: false, reason: res.reason };
  return { ok: true, link: out, entities: made };
}

/** The source a model pick gives (a vertex, an edge, a face's outer edges, or a body's silhouette). */
export async function sourceOfPick(services: AppServices, item: SelectionItem, silhouette: boolean): Promise<SketchLinkSource | string> {
  if (item.kind !== 'vertex' && item.kind !== 'edge' && item.kind !== 'face' && item.kind !== 'body') return 'Click a vertex, an edge or a face of a body';
  const info = services.doc.state.get().rebuild.bodies.find((b) => b.id === item.body);
  if (!info) return 'That body is not built';
  if (silhouette) return { kind: 'silhouette', body: item.body };
  if (item.kind === 'body') return 'Click a vertex, an edge or a face';
  if (!info.names) return `${info.name} has no face names, so its geometry cannot be followed`;
  const lookup = kernelLookup(services.kernel);
  if (item.kind === 'vertex') return { kind: 'vertex', body: item.body, ref: await refOfVertex(lookup, info.shape, info.names, item.index) };
  if (item.kind === 'edge') return { kind: 'edge', body: item.body, ref: await refOfEdge(lookup, info.shape, info.names, item.index) };
  return { kind: 'face', body: item.body, ref: await refOfFace(lookup, info.shape, info.names, item.index) };
}

function flash(services: AppServices, items: SelectionItem[]) {
  services.viewport.get().handle?.flash(items);
}

export function projectTool(mode: SketchMode): SketchTool {
  const st = projectStateOf(mode.services);
  let busy = false;
  const pickAt = (e: SketchPointer): SelectionItem | null => {
    const h = mode.services.viewport.get().handle;
    if (!h?.pickKinds) return null;
    const silhouette = st.get().silhouette;
    const hit = h.pickKinds(e.clientX, e.clientY, silhouette ? ['body'] : ['vertex', 'edge', 'face']);
    return hit?.item ?? null;
  };
  return {
    id: 'project',
    hint: () =>
      st.get().silhouette
        ? 'Click a body: its outline seen along the sketch normal is projected, linked to the body'
        : 'Click a vertex, an edge or a face of a body: it is projected onto the sketch, linked to the model',
    cancel: () => false,
    dispose() {
      flash(mode.services, []);
    },
    pointer(e) {
      if (e.type === 'move' && !e.pressed) {
        const it = pickAt(e);
        flash(mode.services, it ? [it] : []);
        mode.view.set({ cursor: it ? 'pointer' : 'crosshair' });
        return;
      }
      if (e.type === 'leave') {
        flash(mode.services, []);
        return;
      }
      if (e.type !== 'click' || busy) return;
      const it = pickAt(e);
      if (!it) {
        mode.note(st.get().silhouette ? 'Nothing to project there: click a body' : 'Nothing to project there: click a vertex, an edge or a face of a body');
        return;
      }
      busy = true;
      void (async () => {
        try {
          const src = await sourceOfPick(mode.services, it, st.get().silhouette);
          if (typeof src === 'string') {
            mode.note(src);
            return;
          }
          const r = await addLink(mode, src, 'projected');
          mode.note(r.ok ? null : `Not projected: ${r.reason}`);
        } catch (err) {
          mode.note(`Not projected: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          busy = false;
        }
      })();
    },
  };
}

/** Intersect the sketch plane with these bodies (or every shown body): one link per body that it cuts. */
export async function intersectBodies(mode: SketchMode, bodies: BodyId[] | null): Promise<string> {
  const s = mode.services.doc.state.get();
  const list = (bodies ?? s.rebuild.bodies.filter((b) => b.visible).map((b) => b.id)).filter((id) => s.rebuild.bodies.some((b) => b.id === id));
  if (!list.length) return 'Nothing to intersect: there is no body before this sketch';
  const done: string[] = [];
  const missed: string[] = [];
  const env = sketchEnv(mode.services);
  for (const id of list) {
    const r = await addLink(mode, { kind: 'section', body: id }, 'intersection');
    if (r.ok) done.push(env.bodyName(id));
    else missed.push(r.reason);
  }
  return [done.length ? `Intersected ${done.join(', ')}.` : '', ...missed.map((m) => `${m}.`)].filter(Boolean).join(' ');
}

export function intersectTool(mode: SketchMode): SketchTool {
  const st = projectStateOf(mode.services);
  st.set({ bodies: [] });
  const show = () => {
    const ids = st.get().bodies;
    flash(mode.services, ids.map((b): SelectionItem => ({ kind: 'body', body: b })));
  };
  return {
    id: 'intersect',
    hint: () => 'Click the bodies to intersect (none: every shown body), then Intersect in the panel',
    cancel() {
      if (!st.get().bodies.length) return false;
      st.set({ bodies: [] });
      show();
      return true;
    },
    dispose() {
      st.set({ bodies: [] });
      flash(mode.services, []);
    },
    pointer(e) {
      if (e.type !== 'click') return;
      const h = mode.services.viewport.get().handle;
      const hit = h?.pickKinds?.(e.clientX, e.clientY, ['body']);
      if (!hit || hit.item.kind !== 'body') return;
      const id = hit.item.body;
      const cur = st.get().bodies;
      st.set({ bodies: cur.includes(id) ? cur.filter((b) => b !== id) : [...cur, id] });
      show();
      mode.refreshHint();
    },
  };
}

/**
 * Read every link of the open sketch again and put what moved where it is now (no undo step: the
 * sketch is as the model is). New curves of a face, silhouette or section are added; curves whose
 * source is gone stay where they were (amber, "Lost reference").
 */
export async function refreshLinks(mode: SketchMode): Promise<void> {
  const d = mode.stored();
  const plane = mode.plane();
  if (!d?.links?.length || !plane) return;
  const env = sketchEnv(mode.services);
  const reads = await Promise.all(d.links.map(async (l) => ({ link: l, r: await readLink(l, plane, env) })));
  await mode.apply(
    'Update references',
    (cur) => {
      let draft = cur as LinkDraft;
      let changed = false;
      for (const { link, r } of reads) {
        if (r.state !== 'ok') continue;
        const live = (draft.links ?? []).find((l) => l.id === link.id);
        if (!live) continue;
        // The same as the rebuild did in memory (src/sketch/project/rebuild.ts), now stored.
        const a = applyLinkCurves(draft, live, r.curves, { construction: !!live.auto });
        if (a.changed) {
          draft = a.draft;
          changed = true;
        }
      }
      return changed ? { ok: true, draft, optional: [], removed: [] } : null;
    },
    { noUndo: true },
  );
}

// ------------------------------------------------------------ model geometry as a pick of the sketch tools

/** The body vertex or edge under the pointer (sketch mode), or null. */
export function modelItemAt(mode: SketchMode, e: Pick<SketchPointer, 'clientX' | 'clientY'>): SelectionItem | null {
  const h = mode.services.viewport.get().handle;
  const hit = h?.pickKinds?.(e.clientX, e.clientY, ['vertex', 'edge']);
  return hit && (hit.item.kind === 'vertex' || hit.item.kind === 'edge') ? hit.item : null;
}

/**
 * A body vertex or edge taken by a sketch tool as one of its picks (scope addition A.3: Coincident,
 * On curve, Midpoint, a distance, ... to model geometry): it is auto-projected (a light, linked
 * reference, one sketch undo step, re-used when that source is linked already) and its sketch item
 * is returned: the projected point entity, or the projected curve. Null (with the reason in the
 * panel's foot) when it cannot be.
 */
export async function autoProjectItem(mode: SketchMode, item: SelectionItem): Promise<{ what: 'entity'; id: string; point?: string } | null> {
  const src = await sourceOfPick(mode.services, item, false).catch((err) => (err instanceof Error ? err.message : String(err)));
  if (typeof src === 'string') {
    mode.note(src);
    return null;
  }
  const d = mode.stored();
  const have = (d?.links ?? []).find((l) => l.source.kind === src.kind && l.source.body === src.body && 'ref' in l.source && 'ref' in src && l.source.ref.name === src.ref.name);
  let ids: string[];
  if (have) ids = have.entities.map((r) => r.entity);
  else {
    const r = await addLink(mode, src, 'projected', { auto: true });
    if (!r.ok) {
      mode.note(`Not projected: ${r.reason}`);
      return null;
    }
    ids = r.entities;
  }
  const e = mode.stored()?.entities.find((x) => ids.includes(x.id));
  if (!e) return null;
  return e.kind === 'point' ? { what: 'entity', id: e.id, point: e.p } : { what: 'entity', id: e.id };
}
