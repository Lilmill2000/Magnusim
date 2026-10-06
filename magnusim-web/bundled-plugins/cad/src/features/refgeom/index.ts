// CONSTRUCT (Daniel's must-have 9; proposal §2.4): reference Plane, Axis and
// Point as history features, in the toolbar's CONSTRUCT group. Each command
// opens its panel with what is selected taken as its first input where it fits
// (a plane: Offset from it; two planes: Midplane; three points: Through 3
// points; ...). The module draws them in the view (overlay.ts), hovers and
// picks them into the shared selection (tool.ts), and adds "Sketch on Plane 1"
// and "Normal to Plane 1" to the viewport's menu for a plane.
// Owner: REFERENCE (P4a).
// SPDX-License-Identifier: GPL-3.0-or-later
import './refgeom.css';
import '../p2/p2.css';
import type { AppServices } from '../../types/app';
import type { CommandDef } from '../../types/commands';
import type { Feature, FeatureType, RefAxisFeature, RefPlaneFeature, RefPointFeature } from '../../types/doc';
import type { FeatureTypeDef } from '../../types/doc-service';
import type { CadModule, ContextMenuContribution } from '../../types/modules';
import type { GeomRef, PlaneRef, PointRef } from '../../types/references';
import type { SelectionItem } from '../../types/selection';
import type { ViewportHandle } from '../../types/viewport';
import { uiFor } from '../../ui/controller';
import { constructOf, constructOutput } from './api';
import { AXIS_ICON, PLANE_ICON, POINT_ICON, refAxisDef, refPlaneDef, refPointDef } from './defs';
import { ConstructOverlay } from './overlay';
import { RefAxisPanel, RefPlanePanel, RefPointPanel } from './panels';
import { refFromItem, type Accept } from './refs';
import { constructTool } from './tool';
import { userItems } from '../../lib/selection';

export const CONSTRUCT_COMMANDS = { plane: 'construct.plane', axis: 'construct.axis', point: 'construct.point' } as const;

/** The selection as references of one kind (each item that fits; [] when one does not). */
async function selectedAs(services: AppServices, items: readonly SelectionItem[], accept: Accept): Promise<GeomRef[] | null> {
  const out: GeomRef[] = [];
  for (const it of items) {
    const r = await refFromItem(services, it, accept, null);
    if (!r.ok) return null;
    out.push(r.ref);
  }
  return out;
}

/** What a new Plane starts from, given the selection. */
export async function planeInit(services: AppServices, items: readonly SelectionItem[]): Promise<Partial<RefPlaneFeature>> {
  if (!items.length) return {};
  const planes = await selectedAs(services, items, 'plane');
  if (planes?.length === 1) return { method: 'offset', plane: planes[0] as PlaneRef };
  if (planes?.length === 2) return { method: 'midplane', plane: planes[0] as PlaneRef, plane2: planes[1] as PlaneRef };
  const points = await selectedAs(services, items, 'point');
  if (points?.length === 3) return { method: 'three_points', points: points as PointRef[] };
  if (items.length === 2) {
    const p = await refFromItem(services, items[0], 'plane', null);
    const a = await refFromItem(services, items[1], 'axis', null);
    if (p.ok && a.ok && a.ref.kind !== 'face') return { method: 'angle', plane: p.ref as PlaneRef, axis: a.ref as RefPlaneFeature['axis'] };
  }
  if (items.length === 1) {
    const e = await refFromItem(services, items[0], 'edge', null);
    if (e.ok) return { method: 'normal_to_curve', edge: e.ref as RefPlaneFeature['edge'] };
  }
  return {};
}

/** What a new Axis starts from. */
export async function axisInit(services: AppServices, items: readonly SelectionItem[]): Promise<Partial<RefAxisFeature>> {
  if (!items.length) return {};
  if (items.length === 1) {
    const round = await refFromItem(services, items[0], 'round', null);
    if (round.ok) return { method: 'cylinder', face: round.ref as RefAxisFeature['face'] };
    const e = await refFromItem(services, items[0], 'axis', null);
    if (e.ok && e.ref.kind === 'edge') return { method: 'edge', edge: e.ref };
  }
  const planes = await selectedAs(services, items, 'plane');
  if (planes?.length === 2) return { method: 'two_planes', planes: planes as PlaneRef[] };
  const points = await selectedAs(services, items, 'point');
  if (points?.length === 2) return { method: 'two_points', points: points as PointRef[] };
  return {};
}

/** What a new Point starts from. */
export async function pointInit(services: AppServices, items: readonly SelectionItem[]): Promise<Partial<RefPointFeature>> {
  if (items.length !== 1 && items.length !== 2) return {};
  if (items.length === 1) {
    const v = await refFromItem(services, items[0], 'point', null);
    if (v.ok && v.ref.kind === 'vertex') return { method: 'vertex', vertex: v.ref };
    const c = await refFromItem(services, items[0], 'center', null);
    if (c.ok) return c.ref.kind === 'edge' ? { method: 'center', edge: c.ref } : { method: 'center', face: c.ref as RefPointFeature['face'] };
    const e = await refFromItem(services, items[0], 'edge', null);
    if (e.ok) return { method: 'on_edge', edge: e.ref as RefPointFeature['edge'] };
    return {};
  }
  const e = await refFromItem(services, items[0], 'edge', null);
  const p = await refFromItem(services, items[1], 'plane', null);
  if (e.ok && p.ok) return { method: 'edge_plane', edge: e.ref as RefPointFeature['edge'], plane: p.ref as PlaneRef };
  return {};
}

function command(services: AppServices, type: FeatureType, id: string, label: string, icon: string, order: number, hint: string, init: (s: AppServices, items: readonly SelectionItem[]) => Promise<Partial<Feature>>): CommandDef {
  const ui = uiFor(services);
  return {
    id,
    label,
    group: 'construct',
    icon,
    order,
    hint,
    activeWhen: { featureType: type },
    enabled: () => ui.editBlock() ?? true,
    run: async () => {
      const p = ui.state.get().panel;
      if (p?.kind === 'feature' && p.isNew && p.type === type) return;
      const items = userItems(services.selection);
      let start: Partial<Feature> = {};
      try {
        start = await init(services, items);
      } catch {
        start = {};
      }
      ui.openNew(type, start);
    },
  };
}

/** "Sketch on Plane 1" and "Normal to Plane 1" for a CONSTRUCT plane right-clicked in the view. */
function contextMenu(services: AppServices, pick: { item: SelectionItem } | null): ContextMenuContribution[] {
  if (!pick) return [];
  const c = constructOf(services, pick.item);
  if (!c || c.kind !== 'plane') return [];
  const s = services.doc.state.get();
  const name = s.doc.features.find((f) => f.id === c.feature)?.name ?? 'the plane';
  const out = constructOutput(s, c.feature);
  const why = out ? null : `${name} is not built`;
  const sketch = services.commands.get('sketch.new');
  const items: ContextMenuContribution[] = [];
  if (sketch) {
    items.push({
      id: 'sketch-on',
      label: `Sketch on ${name}`,
      disabled: why ?? uiFor(services).editBlock(),
      run: () => {
        services.selection.set((sel) => ({ ...sel, items: [{ kind: 'feature', feature: c.feature }] }));
        void services.commands.run('sketch.new');
      },
    });
  }
  items.push({
    id: 'normal-to',
    label: `Normal to ${name}`,
    disabled: why,
    run: () => {
      const h = services.viewport.get().handle;
      if (out && out.type === 'plane' && h) {
        const n = out.frame.normal;
        h.lookAt(n, Math.abs(n[2]) > 0.9 ? [0, 1, 0] : [0, 0, 1]);
      }
    },
  });
  return items;
}

function install(services: AppServices): () => void {
  const offs: (() => void)[] = [
    services.commands.register(command(services, 'ref_plane', CONSTRUCT_COMMANDS.plane, 'Plane', PLANE_ICON, 10, 'A reference plane: offset from a plane or flat face, at an angle, through 3 points, midway between two, or normal to a curve. Sketch on it, mirror about it', planeInit)),
    services.commands.register(command(services, 'ref_axis', CONSTRUCT_COMMANDS.axis, 'Axis', AXIS_ICON, 20, 'A reference axis: through 2 points, the axis of a cylinder or cone, along an edge, or where 2 planes cross. Revolve or pattern about it', axisInit)),
    services.commands.register(command(services, 'ref_point', CONSTRUCT_COMMANDS.point, 'Point', POINT_ICON, 30, 'A reference point: at a vertex, at the centre of an arc, circle or sphere, on an edge, where an edge crosses a plane, or at coordinates', pointInit)),
  ];
  let handle: ViewportHandle | null = null;
  let overlay: ConstructOverlay | null = null;
  let popTool: (() => void) | null = null;
  const attach = (next: ViewportHandle | null) => {
    if (next === handle) return;
    popTool?.();
    popTool = null;
    overlay?.dispose();
    overlay = null;
    handle = next;
    if (!handle || typeof handle.addLayer !== 'function') return;
    overlay = new ConstructOverlay(services, handle);
    popTool = handle.pushTool(constructTool(services, handle));
  };
  attach(services.viewport.get().handle);
  offs.push(services.viewport.subscribe((s) => attach(s.handle)));
  return () => {
    for (const off of offs.splice(0)) off();
    attach(null);
  };
}

const refgeomModule: CadModule = {
  id: 'refgeom',
  features: [refPlaneDef as unknown as FeatureTypeDef, refAxisDef as unknown as FeatureTypeDef, refPointDef as unknown as FeatureTypeDef],
  panels: { ref_plane: RefPlanePanel, ref_axis: RefAxisPanel, ref_point: RefPointPanel },
  contextMenu,
  install,
};

export default refgeomModule;
