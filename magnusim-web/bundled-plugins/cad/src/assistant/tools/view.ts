// view: pictures of the Part from fixed directions, drawn off screen, so the person's view never
// moves (CAD tools spec §3.2.4, §9.2). A read: it never waits for the person.
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { ToolImpl } from '../../types/assistant';
import { takeView } from '../view';

export const tool: ToolImpl = {
  kind: 'read',
  run: (ctx) => takeView(ctx),
};
