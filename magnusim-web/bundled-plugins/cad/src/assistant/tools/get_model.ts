// get_model: read the Part (CAD tools spec §3.2.1, §4).
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { ToolImpl } from '../../types/assistant';
import { waitForRead } from '../busy';
import { readModel } from '../model';

export const tool: ToolImpl = {
  kind: 'read',
  async run(ctx) {
    await waitForRead(ctx);
    const detail = ctx.input.detail === 'full' ? 'full' : 'brief';
    const feature = typeof ctx.input.feature === 'string' ? ctx.input.feature : '';
    // One sketch's regions in short unless asked for in full.
    const regions = ctx.input.regions === 'full' ? 'full' : 'short';
    return readModel(ctx, { detail, feature, regions });
  },
};
