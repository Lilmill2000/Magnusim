// The PATTERN group (Daniel's item 7: "in the main stuff next to extrude"): Linear pattern,
// Circular pattern and Mirror, right after SOLID on the toolbar. Select first, then act: the
// panel opens with the selected features (tree rows), bodies or faces as what it repeats, and
// a selected plane as the mirror plane (an axis as the circular pattern's axis). Unavailable
// until a body exists.
// Owner: P4b PATTERN.
// SPDX-License-Identifier: GPL-3.0-or-later
import '../p2/p2.css';
import './pattern.css';
import { userItems } from '../../lib/selection';
import type { AppServices } from '../../types/app';
import type { CommandDef } from '../../types/commands';
import type { Feature, PatternCommon } from '../../types/doc';
import type { FeatureTypeDef } from '../../types/doc-service';
import type { CadModule } from '../../types/modules';
import type { AxisRef, PlaneRef } from '../../types/references';
import { uiFor } from '../../ui/controller';
import { pickFace } from '../p2/refs';
import { constructOf } from '../refgeom/api';
import { NO_BODY } from '../solids/commands';
import { circularPatternDef, linearPatternDef, mirrorDef, type PatternType } from './defs';
import { PATTERN_ICONS } from './icons';
import { defaultOp, featureRefusal, PatternPanel } from './panel';

export const PATTERN_COMMANDS = { linear: 'pattern.linear', circular: 'pattern.circular', mirror: 'pattern.mirror' } as const;

/**
 * What the selection gives a new pattern: feature rows (repeatable ones), bodies, or faces of one
 * body; a plane (mirror) or an axis (circular). Null fields are left to the panel.
 */
export async function patternInit(services: AppServices, type: PatternType): Promise<Partial<PatternCommon> & { plane?: PlaneRef; axis?: AxisRef }> {
  const items = userItems(services.selection);
  const s = services.doc.state.get();
  const init: Partial<PatternCommon> & { plane?: PlaneRef; axis?: AxisRef } = {};
  // A plane or an axis picked first (the mirror plane, the circular axis).
  for (const it of items) {
    if (type === 'mirror' && it.kind === 'origin' && (it.ref === 'origin:top' || it.ref === 'origin:front' || it.ref === 'origin:right')) init.plane = { kind: 'origin', plane: it.ref };
    if (type === 'pattern_circular' && it.kind === 'origin' && (it.ref === 'origin:x' || it.ref === 'origin:y' || it.ref === 'origin:z')) init.axis = { kind: 'origin', axis: it.ref };
    const c = it.kind === 'feature' ? constructOf(services, it) : null;
    if (c?.kind === 'plane' && type === 'mirror') init.plane = { kind: 'feature', feature: c.feature };
    if (c?.kind === 'axis' && type === 'pattern_circular') init.axis = { kind: 'feature', feature: c.feature };
  }
  const features = items.flatMap((it) => (it.kind === 'feature' && !featureRefusal(services, '', it.feature) ? [it.feature] : []));
  const bodies = items.flatMap((it) => (it.kind === 'body' ? [it.body] : []));
  const faces = items.flatMap((it) => (it.kind === 'face' ? [{ body: it.body, index: it.index }] : []));
  if (features.length) Object.assign(init, { of: 'features', features, op: defaultOp('features') });
  else if (bodies.length) Object.assign(init, { of: 'bodies', bodies, op: defaultOp('bodies') });
  else if (faces.length && new Set(faces.map((f) => f.body)).size === 1) {
    const info = s.rebuild.bodies.find((b) => b.id === faces[0].body);
    if (info) {
      const refs = [];
      for (const it of faces) {
        const r = await pickFace(services, info, it.index, null);
        if (r.ok) refs.push(r.ref);
      }
      if (refs.length) Object.assign(init, { of: 'faces', faceBody: info.id, faces: refs, op: defaultOp('faces') });
    }
  }
  return init;
}

function patternCommand(services: AppServices, o: { id: string; type: PatternType; label: string; icon: string; order: number; hint: string }): CommandDef {
  const ui = uiFor(services);
  return {
    id: o.id,
    label: o.label,
    group: 'pattern',
    icon: o.icon,
    order: o.order,
    hint: o.hint,
    explainRefusal: true,
    activeWhen: { featureType: o.type },
    enabled: () => ui.editBlock() ?? (services.doc.state.get().rebuild.bodies.length ? true : NO_BODY),
    run: async () => {
      const p = ui.state.get().panel;
      if (p?.kind === 'feature' && p.isNew && p.type === o.type) return;
      ui.openNew(o.type, (await patternInit(services, o.type)) as Partial<Feature>);
    },
  };
}

const patternModule: CadModule = {
  id: 'pattern',
  features: [linearPatternDef, circularPatternDef, mirrorDef] as unknown as FeatureTypeDef[],
  panels: { pattern_linear: PatternPanel, pattern_circular: PatternPanel, mirror: PatternPanel },
  install(services: AppServices) {
    const offs = [
      services.commands.register(patternCommand(services, { id: PATTERN_COMMANDS.linear, type: 'pattern_linear', label: 'Linear pattern', icon: PATTERN_ICONS.linear, order: 10, hint: 'Copies of features, bodies or faces along one or two directions' })),
      services.commands.register(patternCommand(services, { id: PATTERN_COMMANDS.circular, type: 'pattern_circular', label: 'Circular pattern', icon: PATTERN_ICONS.circular, order: 20, hint: 'Copies of features, bodies or faces turned about an axis' })),
      services.commands.register(patternCommand(services, { id: PATTERN_COMMANDS.mirror, type: 'mirror', label: 'Mirror', icon: PATTERN_ICONS.mirror, order: 30, hint: 'A copy of features, bodies or faces reflected in a plane' })),
    ];
    return () => offs.forEach((off) => off());
  },
};

export default patternModule;
