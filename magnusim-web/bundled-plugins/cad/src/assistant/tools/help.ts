// help: the fixed CAD reference (CAD tools spec §3.2.5, §10.2). Needs no Part and never waits.
// The features topic says which tools this build answers, and which the page does not offer now
// (the eval's core set); the guide topic is the guide the page registered (guide.ts guideWithout).
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { ToolImpl } from '../../types/assistant';
import { ToolError } from '../errors';
import { guideWithout } from '../guide';
import { BODY_ROW_WITHOUT_SIMULATION, guideRows, HELP, isHelpTopic, NOT_OFFERED } from '../help';
import { runtimeOf } from '../runtime';
import { HELP_TOPICS, TOOL_NAMES } from '../schemas';

export const tool: ToolImpl = {
  kind: 'read',
  async run(ctx) {
    const topic = ctx.input.topic;
    if (!isHelpTopic(topic)) throw new ToolError('bad_input', `topic must be one of ${HELP_TOPICS.join(', ')}.`, { detail: { field: 'topic' } });
    const rt = runtimeOf(ctx.services);
    const built = rt?.isBuilt ?? (() => true);
    const offered = rt?.offered ?? TOOL_NAMES;
    const missing = TOOL_NAMES.filter((n) => !offered.includes(n));
    const base = topic === 'guide' && missing.length ? guideRows(guideWithout(missing)) : HELP[topic];
    // Magnusim CAD (no projects, no simulation): the body tool as offered there. (Help needs no Part:
    // with no bridge it answers as in Magnusim.)
    const links = ctx.services.bridge?.projectLinks() !== false;
    const rows = base.map((row) => {
      if (topic !== 'features') return row;
      const r = !links && row.about === 'body' ? BODY_ROW_WITHOUT_SIMULATION : row;
      if (!built(r.about)) return { ...r, text: `${r.text} Not in this build yet.` };
      return missing.includes(r.about) ? { ...r, text: `${r.text} ${NOT_OFFERED}` } : r;
    });
    return { text: `help ${topic}: ${rows.length} ${rows.length === 1 ? 'row' : 'rows'}`, data: { topic, rows }, summary: `Read help ${topic}` };
  },
};
