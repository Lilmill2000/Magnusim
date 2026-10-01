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

export function toViewportBodies(list: readonly BodyInfo[], vertices: ReadonlyMap<string, Float32Array>): ViewportBody[] {
  const out: ViewportBody[] = [];
  for (const b of list) {
    if (!b.tess) continue;
    out.push({ id: b.id, color: b.color, visible: b.visible, tessKey: b.tessKey, tess: b.tess, feature: b.feature, bbox: b.bbox ?? null, vertices: vertices.get(`${b.id}|${b.tessKey}`) ?? null });
  }
  return out;
}

export function bindViewport(handle: ViewportHandle, services: AppServices): () => void {
  const { doc, selection, bus, kernel } = services;
  const offs: (() => void)[] = [];
  const vertices = new Map<string, Float32Array>();
  const asked = new Set<string>();

  const syncBodies = (s: DocState) => {
    const list = s.rebuild.bodies;
    const live = new Set(list.map((b) => `${b.id}|${b.tessKey}`));
    for (const key of [...vertices.keys()]) if (!live.has(key)) vertices.delete(key);
    handle.setBodies(toViewportBodies(list, vertices));
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
      vertices.set(key, arr);
      handle.setVertices(b.id, b.tessKey, arr);
    } catch {
      // The shape died (respawn) or the kernel is busy failing: the next rebuild asks again.
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
  return () => {
    for (const off of offs) off();
  };
}
