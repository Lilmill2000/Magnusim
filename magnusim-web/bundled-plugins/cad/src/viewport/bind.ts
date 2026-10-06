// The viewport's wiring into the app: bodies from DocService.state (by
// tessKey), highlight and filter from services.selection, picks into the
// selection (click replaces, Ctrl+click toggles, a click on empty space clears:
// runtime.js applyCadPick 23694-23720), right-click and double-click onto the
// bus, and B-rep vertex positions (kernel `topo` with vertices only). Each
// Part keeps how it was viewed (review round 3): the origin planes' mode and
// the camera go into the document's view state (saved, not undoable) when the
// user changes them, and come back when the Part is opened (the camera after
// the first rebuild, over the framing of the first bodies).
// Owner: VIEWPORT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { clearSelection, isSelected, selectItem } from '../lib/selection';
import { selectionKey } from '../types/selection';
import { combineSelection } from './boxselect';
import type { AppServices } from '../types/app';
import type { DocState } from '../types/doc-service';
import type { BodyInfo } from '../types/kernel';
import type { Selection } from '../types/selection';
import type { ViewportBody, ViewportHandle } from '../types/viewport';

/**
 * Vertex positions come from `topo` asking for vertices only (faces and
 * edges "none"): a full topo measures every face (80 s on the 11,776-face P0
 * part); the vertices alone are one point per vertex.
 */
export const TOPO_VERTICES_ONLY = { faces: 'none', edges: 'none', vertices: 'all' } as const;

export function toViewportBodies(list: readonly BodyInfo[], vertices: ReadonlyMap<string, Float32Array>, seeThrough: (id: BodyInfo['id']) => boolean = () => false): ViewportBody[] {
  const out: ViewportBody[] = [];
  for (const b of list) {
    if (!b.tess) continue;
    out.push({ id: b.id, color: b.color, visible: b.visible, tessKey: b.tessKey, tess: b.tess, feature: b.feature, bbox: b.bbox ?? null, vertices: vertices.get(`${b.id}|${b.tessKey}`) ?? null, ...(seeThrough(b.id) ? { seeThrough: true } : {}) });
  }
  return out;
}

/** Whether the feature that owns body `id` draws it see-through (FeatureTypeDef.seeThrough: an Enclosure's body). */
export function seeThroughOf(s: Pick<DocState, 'doc'>, services: Pick<AppServices, 'doc'>, id: BodyInfo['id']): boolean {
  const registry = services.doc.features;
  if (!registry) return false;
  for (const f of s.doc.features) {
    const def = registry.get(f.type);
    if (def?.seeThrough && def.ownsBody?.(f, id) && def.seeThrough(f, id)) return true;
  }
  return false;
}

export function bindViewport(handle: ViewportHandle, services: AppServices): () => void {
  const { doc, selection, bus, kernel } = services;
  const offs: (() => void)[] = [];
  const vertices = new Map<string, Float32Array>();
  // Requests in flight only: a key that is no longer drawn leaves both maps, so a body that comes
  // back with the same id and tessKey (an Undo, an edit put back) is asked again (P4a review: it
  // kept its key here, got no vertices, and no vertex could be picked on it).
  const asked = new Set<string>();
  let live = new Set<string>();

  const syncBodies = (s: DocState) => {
    const list = s.rebuild.bodies;
    live = new Set(list.map((b) => `${b.id}|${b.tessKey}`));
    for (const key of [...vertices.keys()]) if (!live.has(key)) vertices.delete(key);
    for (const key of [...asked]) if (!live.has(key)) asked.delete(key);
    handle.setBodies(toViewportBodies(list, vertices, (id) => seeThroughOf(s, services, id)));
    for (const b of list) void fetchVertices(b);
  };

  async function fetchVertices(b: BodyInfo) {
    const key = `${b.id}|${b.tessKey}`;
    if (!b.tess || vertices.has(key) || asked.has(key)) return;
    asked.add(key);
    try {
      const r = await kernel.call('topo', { id: b.shape, ...TOPO_VERTICES_ONLY });
      const v = r.result.vertices;
      const arr = new Float32Array(v.length * 3);
      v.forEach((x, i) => arr.set(x.p, 3 * i));
      // Gone while it was asked (an edit, an Undo): nothing to keep; it is asked again if it comes back.
      if (!live.has(key)) return;
      vertices.set(key, arr);
      handle.setVertices(b.id, b.tessKey, arr);
    } catch {
      // The shape died (respawn) or the kernel is busy failing: the next rebuild asks again.
    } finally {
      asked.delete(key);
    }
  }

  const applySelection = (sel: Selection) => {
    handle.highlight(sel.items);
    handle.setFilter(sel.filter);
  };

  // The Part's saved view: planes mode once it is read, the camera once its first rebuild is drawn.
  let restorePlanes = true;
  let restoreCamera = true;
  const restore = (s: DocState) => {
    if (s.status !== 'ready') return;
    if (restorePlanes) {
      // Put back before the flag drops: the planes listener below must not write it again.
      handle.setPlanes(s.view?.planes ?? 'auto');
      restorePlanes = false;
    }
    if (restoreCamera && s.rebuild.seq > 0 && s.rebuild.status !== 'running') {
      if (s.view?.camera) handle.setCamera(s.view.camera);
      restoreCamera = false;
    }
  };

  syncBodies(doc.state.get());
  restore(doc.state.get());
  offs.push(
    doc.state.subscribe((s, prev) => {
      if (s.rebuild.bodies !== prev.rebuild.bodies) syncBodies(s);
      // Loaded again (Reload after a conflict): its saved view applies again.
      if (s.status === 'loading' && prev.status !== 'loading') {
        restorePlanes = true;
        restoreCamera = true;
      }
      if (restorePlanes || restoreCamera) restore(s);
    }),
  );
  offs.push(
    handle.onCameraChange((c) => {
      if (!restoreCamera) doc.setCamera(c);
    }),
    handle.state.subscribe((v, prev) => {
      if (v.planes !== prev.planes && !restorePlanes) doc.setPlanes(v.planes);
    }),
  );
  // Sketch mode ended (Finish sketch): a sketch drawn past the edge of an unmoved view is framed
  // (P4a review: nothing refit after the first large sketch). Once its layer shows as a sketch.
  let wasSketch = services.mode?.get().mode === 'sketch';
  if (services.mode) {
    offs.push(
      services.mode.subscribe((m) => {
        const sketch = m.mode === 'sketch';
        // Once the view is still (Finish sketch may start a transition; real Chrome: the check ran during it).
        if (wasSketch && !sketch) {
          let tries = 0;
          const check = () => {
            if (handle.state.get().animating && tries++ < 40) setTimeout(check, 50);
            else handle.refitIfOffScreen?.();
          };
          setTimeout(check, 60);
        }
        wasSketch = sketch;
      }),
    );
  }
  applySelection(selection.get());
  offs.push(
    selection.subscribe((s, prev) => {
      if (s.items !== prev.items || s.filter !== prev.filter) applySelection(s);
    }),
  );
  offs.push(
    handle.onPick((e) => {
      if (e.type === 'click') {
        if (e.pick) selectItem(selection, e.pick.item, e.additive);
        else if (!e.additive) clearSelection(selection);
      } else if (e.type === 'contextmenu') {
        // Right-click on something not selected selects it first (it is what the menu acts on).
        if (e.pick && !isSelected(selection.get(), e.pick.item)) selectItem(selection, e.pick.item, false);
        bus.emit('viewport:contextmenu', { pick: e.pick, clientX: e.clientX, clientY: e.clientY });
      } else if (e.type === 'dblclick' && e.pick) {
        bus.emit('viewport:dblclick', { pick: e.pick });
      }
    }),
  );
  // P4b SELECT: a box drawn by Ctrl + left drag (Ctrl+Shift adds; an empty box without Shift clears).
  if (handle.onBoxSelect) {
    offs.push(
      handle.onBoxSelect((e) => {
        selection.set((prev) => ({ ...prev, items: combineSelection(prev.items, e.items, e.combine, selectionKey) }));
      }),
    );
  }
  return () => {
    for (const off of offs) off();
  };
}
