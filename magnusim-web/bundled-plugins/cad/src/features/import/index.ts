// Import STEP (proposal §2.8, §2.13, §4.9; docs/p2p3-plan.md §1.2): the FILE
// group's "Import STEP" (the browser's file picker), a STEP dropped anywhere on
// the frame, the Imported feature and its panel. Publishes services.apis.files.
// Owner: P2-FEATURES.
// SPDX-License-Identifier: GPL-3.0-or-later
import '../p2/p2.css';
import type { AppServices } from '../../types/app';
import type { ImportFeature } from '../../types/doc';
import type { CadModule } from '../../types/modules';
import { WELL_KNOWN_COMMANDS } from '../../types/modules';
import { uiFor } from '../../ui/controller';
import { filesFor } from '../../files/transfer';
import { sizeProblem } from '../../files/words';
import { P2_ICONS } from '../p2/icons';
import { importDef } from './feature';
import { ImportPanel } from './panel';
import { importRunsFor } from './runs';

export const STEP_ACCEPT = ['.step', '.stp'];

/**
 * Start importing a picked or dropped file: checks first, then the panel with its progress.
 * `init` adds fields to the new Imported feature (Edit in CAD: its `origin`). True when the
 * import started; false when it was refused (the toast says why).
 */
export function startImport(services: AppServices, file: File, init: Partial<ImportFeature> = {}): boolean {
  const toast = (m: string) => {
    services.bridge.toast(m, 'error');
    return false;
  };
  if (!/\.(step|stp)$/i.test(file.name)) return toast(`Import failed: ${file.name} is not a STEP file (.step, .stp)`);
  const big = sizeProblem(file.size);
  if (big) return toast(big);
  if (services.mode.get().mode !== 'model') return toast('Import failed: finish the sketch first');
  const ui = uiFor(services);
  const block = ui.editBlock();
  if (block) return toast(`Import failed: ${block}`);
  if (!services.bridge.files) return toast("Import failed: this Magnusim cannot store CAD files (it needs host API 1.2)");
  const p = ui.state.get().panel;
  if (p?.kind === 'feature' && p.type === 'import' && importRunsFor(services).state.get().runs[p.feature]?.progress) {
    return toast(`Wait for ${importRunsFor(services).state.get().runs[p.feature].fileName} to finish importing`);
  }
  ui.openNew('import', { ...init, source: { rel: '', size: file.size, sha256: '', fileName: file.name, unit: null } } as Partial<ImportFeature>);
  const s = services.doc.session();
  if (!s || !s.open || s.draft.type !== 'import') return false;
  importRunsFor(services).start(s, file);
  return true;
}

const module: CadModule = {
  id: 'import',
  features: [importDef],
  panels: { import: ImportPanel },
  install(services) {
    const files = filesFor(services);
    const ui = uiFor(services);
    const offs = [
      services.commands.register({
        id: WELL_KNOWN_COMMANDS.importStep,
        label: 'Import STEP',
        group: 'file',
        icon: P2_ICONS.importStep,
        order: 10,
        hint: 'Bring in the bodies of a STEP file (.step, .stp) as an Imported feature. You can also drop the file on the part.',
        activeWhen: { featureType: 'import' },
        enabled: () => ui.editBlock() ?? (services.bridge.files ? true : 'Importing needs Magnusim 1.2 file storage'),
        run: () => {
          // The picker opens from this click (a user gesture): nothing is awaited before it.
          void files.pick(STEP_ACCEPT).then((file) => {
            if (file) startImport(services, file);
          });
        },
      }),
      files.onDrop(STEP_ACCEPT, (file) => services.bus.emit('import:file', { file })),
      services.bus.on('import:file', ({ file }) => startImport(services, file)),
    ];
    return () => {
      for (const off of offs) off();
      importRunsFor(services).dispose();
    };
  },
};

export default module;
