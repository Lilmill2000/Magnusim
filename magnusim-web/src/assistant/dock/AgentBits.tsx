/**
 * A coding agent's rows in a turn's transcript (phase 4 spec 2.7): its line at the top of the
 * turn, its plan (one checklist, replaced in place by each newer one), its own tools as one
 * group updated by call, and the lines for its permission requests, mode and model. The
 * agent's name, titles and plan entries are server data shown as text; each status icon has
 * its words beside it (no colour-only signal).
 */
import type { TurnItem } from './turnView';
import { agentLine, agentModelLine, agentModeLine, agentPermissionLine, agentToolLine, OWN_TOOLS_HEADING, PLAN_HEADING } from './copy';

type Plan = Extract<TurnItem, { kind: 'plan' }>;
type Tools = Extract<TurnItem, { kind: 'agent_tools' }>;

const PLAN_ICON = { pending: '○', in_progress: '◐', completed: '●' } as const;
const PLAN_WORD = { pending: 'pending', in_progress: 'in progress', completed: 'done' } as const;
const TOOL_ICON = { pending: '○', in_progress: '◐', completed: '✓', failed: '✗' } as const;
const TOOL_WORD = { pending: 'pending', in_progress: 'in progress', completed: 'done', failed: 'failed' } as const;

export function AgentLine({ agent }: { agent: { name: string; version: string | null; own_tools: 'off' | 'on' } }) {
  return (
    <p className="dock-muted dock-agent-line" data-dock-agent={agent.own_tools}>
      {agentLine(agent.name, agent.version, agent.own_tools)}
    </p>
  );
}

export function AgentPlan({ item }: { item: Plan }) {
  return (
    <section className="dock-plan" data-dock-plan="1">
      <h4 className="dock-subhead">{PLAN_HEADING}</h4>
      <ul>
        {item.entries.map((e, i) => (
          <li key={i} data-dock-plan-entry={e.status} className={e.priority === 'high' ? 'high' : undefined}>
            <span aria-hidden="true">{PLAN_ICON[e.status] ?? '○'}</span> <span className="dock-sr">{PLAN_WORD[e.status] ?? ''}: </span>
            {e.content}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function AgentTools({ item }: { item: Tools }) {
  return (
    <section className="dock-agent-tools" data-dock-agent-tools="1">
      <h4 className="dock-subhead">{OWN_TOOLS_HEADING}</h4>
      <ul>
        {item.tools.map((t) => (
          <li key={t.call} data-dock-agent-tool={t.status}>
            <span aria-hidden="true">{TOOL_ICON[t.status] ?? '○'}</span> <span className="dock-sr">{TOOL_WORD[t.status] ?? ''}: </span>
            {agentToolLine(t.title, t.kind)}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function AgentLineItem({ item }: { item: Extract<TurnItem, { kind: 'agent_permission' | 'agent_mode' | 'agent_model' }> }) {
  const text =
    item.kind === 'agent_permission' ? agentPermissionLine(item.title, item.outcome, item.by) : item.kind === 'agent_mode' ? agentModeLine(item.label) : agentModelLine(item.label);
  return <p className="dock-muted dock-line" data-dock-line={item.kind}>{text}</p>;
}
