// The Assistant module (CAD tools spec §2.1): the Part's tools for the app's Assistant and its
// chip in the dock. Found by src/modules.ts's glob like every feature folder; the work is in
// src/assistant/.
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { AssistantChip } from '../../assistant/AssistantChip';
import { installAssistant } from '../../assistant/install';
import type { CadModule } from '../../types/modules';

const assistantModule: CadModule = {
  id: 'assistant',
  chips: [AssistantChip],
  install: (services) => installAssistant(services),
};

export default assistantModule;
