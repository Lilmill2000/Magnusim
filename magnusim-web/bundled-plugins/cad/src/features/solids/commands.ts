// The MODIFY commands of the P4a local operations (Fillet, Chamfer, Shell): select
// first, then act. Edges and faces of one body selected before open in the panel
// (a face: all its edges for Fillet and Chamfer, an opening for Shell); otherwise
// the panel opens empty to pick in the view. Unavailable until a body exists.
// Owner: P4a SOLIDS.
// SPDX-License-Identifier: GPL-3.0-or-later
import { kernelLookup } from '../../naming';
import { refOfEdge } from '../../naming/edges';
import type { AppServices } from '../../types/app';
import type { CommandDef } from '../../types/commands';
import type { BodyId, Feature, FeatureType, PersistentRef } from '../../types/doc';
import { uiFor } from '../../ui/controller';
import { pickFace } from '../p2/refs';
import { userItems } from '../../lib/selection';

export const NO_BODY = 'Make or import a body first';

/** The selected edges and faces of one body as references, or why they cannot be taken. */
export async function preselectedEdgesFaces(services: AppServices, opts: { edges: boolean }): Promise<{ body: BodyId; edges: PersistentRef[]; faces: PersistentRef[] } | { refused: string } | null> {
  const items = userItems(services.selection).filter((it) => (opts.edges && it.kind === 'edge') || it.kind === 'face');
  if (!items.length) return null;
  const bodies = new Set(items.map((it) => (it.kind === 'edge' || it.kind === 'face' ? it.body : '')));
  if (bodies.size > 1) return { refused: 'pick edges and faces of one body: they are on several' };
  const info = services.doc.state.get().rebuild.bodies.find((b) => bodies.has(b.id));
  if (!info) return null;
  const edges: PersistentRef[] = [];
  const faces: PersistentRef[] = [];
  for (const it of items) {
    if (it.kind === 'edge') {
      try {
        edges.push(await refOfEdge(kernelLookup(services.kernel), info.shape, info.names ?? null, it.index));
      } catch (err) {
        return { refused: err instanceof Error ? err.message : String(err) };
      }
    } else if (it.kind === 'face') {
      const r = await pickFace(services, info, it.index, null);
      if (!r.ok) return { refused: r.reason };
      faces.push(r.ref);
    }
  }
  return { body: info.id, edges, faces };
}

export function localCommand(services: AppServices, o: { id: string; type: FeatureType; label: string; icon: string; order: number; hint: string; edges: boolean; shortcut?: string }): CommandDef {
  const ui = uiFor(services);
  return {
    id: o.id,
    label: o.label,
    group: 'modify',
    icon: o.icon,
    order: o.order,
    hint: o.hint,
    ...(o.shortcut ? { shortcut: o.shortcut } : {}),
    explainRefusal: true,
    activeWhen: { featureType: o.type },
    enabled: () => ui.editBlock() ?? (services.doc.state.get().rebuild.bodies.length ? true : NO_BODY),
    run: async () => {
      const p = ui.state.get().panel;
      if (p?.kind === 'feature' && p.isNew && p.type === o.type) return;
      const pre = await preselectedEdgesFaces(services, { edges: o.edges });
      if (pre && 'refused' in pre) {
        services.bridge.toast(`${o.label}: ${pre.refused}`, 'info');
        ui.openNew(o.type);
        return;
      }
      ui.openNew(o.type, pre ? ({ body: pre.body, ...(o.edges ? { edges: pre.edges } : {}), faces: pre.faces } as Partial<Feature>) : undefined);
    },
  };
}
