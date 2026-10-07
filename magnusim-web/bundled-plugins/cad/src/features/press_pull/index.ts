// Press-pull (proposal §2.8, §3.4; docs/p2p3-plan.md §1.4): MODIFY's
// "Press-pull" (Q). Faces selected before (flat or curved, of one body) are taken
// into the panel.
// Owner: P2-FEATURES.
// SPDX-License-Identifier: GPL-3.0-or-later
import '../p2/p2.css';
import type { AppServices } from '../../types/app';
import type { PersistentRef, PressPullFeature } from '../../types/doc';
import type { CadModule } from '../../types/modules';
import { WELL_KNOWN_COMMANDS } from '../../types/modules';
import { uiFor } from '../../ui/controller';
import { P2_ICONS } from '../p2/icons';
import { pickFace, selectedFaces } from '../p2/refs';
import { pressPullDef } from './feature';
import { PressPullPanel } from './panel';
import { userItems } from '../../lib/selection';

export async function runPressPull(services: AppServices): Promise<void> {
  const ui = uiFor(services);
  const p = ui.state.get().panel;
  if (p?.kind === 'feature' && p.isNew && p.type === 'press_pull') return;
  const faces = selectedFaces(userItems(services.selection));
  const bodyIds = [...new Set(faces.map((f) => f.body))];
  if (!faces.length || bodyIds.length !== 1) {
    if (bodyIds.length > 1) services.bridge.toast('Press-pull works on one body: pick its faces in the panel', 'info');
    ui.openNew('press_pull');
    return;
  }
  const body = services.doc.state.get().rebuild.bodies.find((b) => b.id === bodyIds[0]);
  if (!body) return;
  const refs: PersistentRef[] = [];
  for (const f of faces) {
    const r = await pickFace(services, body, f.index, null);
    if (!r.ok) {
      services.bridge.toast(`Press-pull: ${r.reason}`, 'error');
      ui.openNew('press_pull');
      return;
    }
    refs.push(r.ref);
  }
  ui.openNew('press_pull', { body: body.id, faces: refs } as Partial<PressPullFeature>);
}

const module: CadModule = {
  id: 'press_pull',
  features: [pressPullDef],
  panels: { press_pull: PressPullPanel },
  contextMenu(services, pick) {
    if (!pick || pick.item.kind !== 'face') return [];
    const block = uiFor(services).editBlock();
    return [{ id: 'press-pull', label: 'Press-pull', disabled: block ?? null, run: () => void runPressPull(services) }];
  },
  install(services) {
    const ui = uiFor(services);
    return services.commands.register({
      id: WELL_KNOWN_COMMANDS.pressPull,
      label: 'Press-pull',
      group: 'modify',
      icon: P2_ICONS.pressPull,
      shortcut: 'Q',
      order: 20,
      hint: 'Move faces along their normal: out adds material, in removes it; a curved face changes its radius',
      activeWhen: { featureType: 'press_pull' },
      explainRefusal: true,
      enabled: () => ui.editBlock() ?? (services.doc.state.get().rebuild.bodies.length ? true : 'Make or import a body first'),
      run: () => runPressPull(services),
    });
  },
};

export default module;
