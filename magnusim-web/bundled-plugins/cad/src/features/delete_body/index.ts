// Delete body: the feature the tree's Delete on a body adds (its context menu, or the Delete key
// with only bodies selected: UiController.deleteBodies, one feature for all of them, one undo
// step), and its panel for Edit. No toolbar command of its own.
// Owner: P2-FEATURES.
// SPDX-License-Identifier: GPL-3.0-or-later
import '../p2/p2.css';
import type { CadModule } from '../../types/modules';
import { deleteBodyDef } from './feature';
import { DeleteBodyPanel } from './panel';

const module: CadModule = {
  id: 'delete_body',
  features: [deleteBodyDef],
  panels: { delete_body: DeleteBodyPanel },
};

export default module;
