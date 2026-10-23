// Where the Assistant itself put the rollback bar (workspace roll_back_to), per Part: an edit of the
// same key then answers busy rolled_back at once ("roll_to_end first"), instead of waiting ten
// minutes for the person to move a bar they did not move. The person's own rollback is still
// waited for (busy.ts). Forgotten once the bar is somewhere else.
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { AppServices } from '../types/app';
import { ToolError } from './errors';

const marks = new WeakMap<AppServices, { key: string; rollback: number }>();

/** The workspace tool moved the bar for `key` (null: to the end, nothing kept). */
export function noteOwnRollback(services: AppServices, key: string, rollback: number | null): void {
  if (rollback === null) marks.delete(services);
  else marks.set(services, { key, rollback });
}

/** busy rolled_back at once when the bar is where this key's own workspace call left it, else null. */
export function ownRollbackBlock(services: AppServices, key: string): ToolError | null {
  const m = marks.get(services);
  if (!m) return null;
  const s = services.doc.state.get();
  const r = s.view.rollback;
  if (r === null || r !== m.rollback || r >= s.doc.features.length) {
    marks.delete(services);
    return null;
  }
  if (m.key !== key) return null;
  const last = r > 0 ? s.doc.features[r - 1]?.name : null;
  return new ToolError('rolled_back', `You rolled the bar back ${last ? `to after ${last}` : 'to the top'} with workspace: call workspace roll_to_end before an edit.`, { detail: { by: 'assistant' } });
}
