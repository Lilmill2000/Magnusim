// The shell module (P4a): the `shell` feature type, its panel, and MODIFY's "Shell"
// command (faces of one body selected before open as the faces to remove).
// Owner: P4a SOLIDS.
// SPDX-License-Identifier: GPL-3.0-or-later
import '../p2/p2.css';
import type { FeatureTypeDef } from '../../types/doc-service';
import type { CadModule } from '../../types/modules';
import { localCommand } from '../solids/commands';
import { SOLIDS_ICONS } from '../solids/icons';
import { shellDef } from './def';
import { ShellPanel } from './panel';

export const SHELL_COMMAND = 'modify.shell';

const shellModule: CadModule = {
  id: 'shell',
  features: [shellDef as unknown as FeatureTypeDef],
  panels: { shell: ShellPanel },
  install(services) {
    return services.commands.register(
      localCommand(services, { id: SHELL_COMMAND, type: 'shell', label: 'Shell', icon: SOLIDS_ICONS.shell, order: 13, edges: false, hint: 'Hollow a body to a wall thickness, with the picked faces removed (the openings)' }),
    );
  },
};

export default shellModule;
