// Delete faces (proposal §2.8; docs/p2p3-plan.md §1.3, §3.9): MODIFY's
// "Delete faces", and the Delete key with only faces selected (the shell runs
// this command then). Faces an import or a P2 edit made open the panel with
// them; faces a native feature made (Extrude, Enclosure, ...) ask first, in
// an in-frame dialog: delete that feature, or delete the faces and heal.
// Owner: P2-FEATURES.
// SPDX-License-Identifier: GPL-3.0-or-later
import '../p2/p2.css';
import type { AppServices } from '../../types/app';
import type { DeleteFacesFeature, PersistentRef } from '../../types/doc';
import type { CadModule } from '../../types/modules';
import { WELL_KNOWN_COMMANDS } from '../../types/modules';
import { uiFor } from '../../ui/controller';
import { askChoice } from '../p2/dialog';
import { P2_ICONS } from '../p2/icons';
import { makerOf, pickFace, selectedFaces } from '../p2/refs';
import { deleteFacesDef } from './feature';
import { DeleteFacesPanel } from './panel';
import { userItems } from '../../lib/selection';

/** Feature types whose faces are edited directly (no "delete the feature instead?" question). */
export const DIRECT_EDIT_TYPES = new Set(['import', 'delete_faces', 'press_pull', 'split', 'combine']);

export async function runDeleteFaces(services: AppServices): Promise<void> {
  const ui = uiFor(services);
  const toast = (m: string) => services.bridge.toast(m, 'info');
  const p = ui.state.get().panel;
  // The open Delete faces panel already takes clicked faces.
  if (p?.kind === 'feature' && p.type === 'delete_faces') return;
  const faces = selectedFaces(userItems(services.selection));
  if (!faces.length) {
    ui.openNew('delete_faces');
    return;
  }
  const bodyIds = [...new Set(faces.map((f) => f.body))];
  if (bodyIds.length > 1) return toast('Delete faces works on one body at a time: select faces of one body');
  const st = services.doc.state.get();
  const body = st.rebuild.bodies.find((b) => b.id === bodyIds[0]);
  if (!body) return;
  // Faces made by a native feature: deleting that feature may be what was meant.
  const names = faces.map((f) => body.names?.faces[f.index] ?? '');
  const makers = [...new Set(names.map((n) => makerOf(st.doc.features, n)).filter((f) => !!f && !DIRECT_EDIT_TYPES.has(f.type)))];
  if (makers.length === 1 && makers[0]) {
    const maker = makers[0];
    const choice = await askChoice({
      title: `Delete faces of ${maker.name}?`,
      message: `${faces.length === 1 ? 'This face was' : 'These faces were'} made by ${maker.name}. Delete the whole feature, or remove only ${faces.length === 1 ? 'this face' : 'these faces'} and heal the gap.`,
      choices: [
        { id: 'feature', label: `Delete feature ${maker.name}` },
        { id: 'faces', label: 'Delete faces and heal' },
      ],
    });
    if (choice === 'feature') {
      ui.deleteFeature(maker.id);
      return;
    }
    if (choice !== 'faces') return;
  }
  const refs: PersistentRef[] = [];
  for (const f of faces) {
    const r = await pickFace(services, body, f.index, null);
    if (!r.ok) return services.bridge.toast(`Delete faces failed: ${r.reason}`, 'error');
    refs.push(r.ref);
  }
  ui.openNew('delete_faces', { body: body.id, faces: refs } as Partial<DeleteFacesFeature>);
}

const module: CadModule = {
  id: 'delete_faces',
  features: [deleteFacesDef],
  panels: { delete_faces: DeleteFacesPanel },
  contextMenu(services, pick) {
    if (!pick || pick.item.kind !== 'face') return [];
    const block = uiFor(services).editBlock();
    return [{ id: 'delete-faces', label: 'Delete faces and heal', disabled: block, run: () => void runDeleteFaces(services) }];
  },
  install(services) {
    const ui = uiFor(services);
    const off = services.commands.register({
      id: WELL_KNOWN_COMMANDS.deleteFaces,
      label: 'Delete faces',
      group: 'modify',
      icon: P2_ICONS.deleteFaces,
      order: 30,
      hint: 'Remove faces (holes, fillets, bosses) and heal the gap. Delete with faces selected does the same.',
      activeWhen: { featureType: 'delete_faces' },
      enabled: () => ui.editBlock() ?? (services.doc.state.get().rebuild.bodies.length ? true : 'Make or import a body first'),
      run: () => runDeleteFaces(services),
    });
    return off;
  },
};

export default module;
