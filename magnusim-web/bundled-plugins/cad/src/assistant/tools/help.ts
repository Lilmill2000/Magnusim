// help: the fixed CAD reference (CAD tools spec §3.2.5, §10.2). Needs no Part and never waits.
// The features topic says which tools this build answers.
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { ToolImpl } from '../../types/assistant';
import { ToolError } from '../errors';
import { HELP, isHelpTopic } from '../help';
import { runtimeOf } from '../runtime';
import { HELP_TOPICS } from '../schemas';

export const tool: ToolImpl = {
  kind: 'read',
  async run(ctx) {
    const topic = ctx.input.topic;
    if (!isHelpTopic(topic)) throw new ToolError('bad_input', `topic must be one of ${HELP_TOPICS.join(', ')}.`, { detail: { field: 'topic' } });
    const built = runtimeOf(ctx.services)?.isBuilt ?? (() => true);
    const rows = HELP[topic].map((r) => (topic === 'features' && !built(r.about) ? { ...r, text: `${r.text} Not in this build yet.` } : r));
    return { text: `help ${topic}: ${rows.length} ${rows.length === 1 ? 'row' : 'rows'}`, data: { topic, rows }, summary: `Read help ${topic}` };
  },
};
