/**
 * One request in the dock's transcript (phase 4 spec 2.4-2.10, 4.5): the person's message
 * with its pictures, then the turn's rows in the order the log gave them (the model's text per
 * step, tool steps, questions as one line each, review dividers, notes, fallbacks, a coding
 * agent's rows), then, while it runs, the footer with its counters, and at its end one block
 * (`data-turn-end`). The spend meter shows under the newest turn.
 *
 * `cards` are the question cards of this turn shown in this tab: they sit under its last row
 * (the gate presenter places them, spec 4.3). `endExtra` goes into the end block (Undo these
 * changes, spec 8.3).
 */
import { useEffect, useReducer, type ReactNode } from 'react';
import type { AgentContext, AssistantStatus, ConversationRoom, ConversationTurn } from '../wire';
import { AgentLine, AgentLineItem, AgentPlan, AgentTools } from './AgentBits';
import {
  ATTACHED_FILES,
  endBody,
  endLabel,
  fallbackLine,
  fileChip,
  FROM_PROGRAM,
  gateAsked,
  gateClosedLine,
  LOG_DROPPED,
  RECORD_GONE,
  reviewDivider,
  updatedLine,
  usageLine,
  yourPictureAlt,
} from './copy';
import { Meter } from './Meter';
import { ModelText } from './ModelText';
import { countersOf, footerWords } from './pill';
import { Thumb, ToolStep } from './ToolStep';
import { isEnded, STILL_STOPPING_MS, streamingStep, turnPhase, type TurnItem, type TurnView } from './turnView';

const TERMINAL_ROW: ReadonlySet<string> = new Set(['done', 'stopped', 'failed', 'capped']);

/** How many of a turn's newest tool steps show open (spec 2.6). */
export const OPEN_STEPS = 3;

export interface TurnBlockProps {
  view: TurnView;
  /** The conversation list's row for it (its title before the snapshot came). */
  row?: ConversationTurn | null;
  newest: boolean;
  status: AssistantStatus | null;
  /** The workspace's name for "Waits for you in <Workspace>". */
  workspace: string;
  /** When this page sent Stop for it (performance.now()), or null. */
  stopSentAt?: number | null;
  /** This tab's own copies of the person's pictures (blob: URLs), in order, while it has them. */
  localPictures?: readonly string[];
  onOpenPicture?: (turn: string, n: string) => void;
  /** A line under the turn while it runs (its questions show in another window). */
  note?: string | null;
  cards?: ReactNode;
  endExtra?: ReactNode;
  /** The conversation's nearest limit (its row's room), for the meter's readout under the newest turn. */
  room?: ConversationRoom | null;
  /** A coding agent's: the context its agent uses (its row's context), for the meter under the newest turn. */
  agentContext?: AgentContext | null;
}

function Row({ view, item, open, workspace, streaming, onOpenPicture }: { view: TurnView; item: TurnItem; open: boolean; workspace: string; streaming: boolean; onOpenPicture?: (turn: string, n: string) => void }) {
  switch (item.kind) {
    case 'text':
      return <ModelText text={item.text} streaming={streaming} />;
    case 'earlier_text':
      return <ModelText text={item.text} />;
    case 'tool':
      return <ToolStep turn={view.id} item={item} open={open} workspace={workspace} onOpenPicture={onOpenPicture ? (n) => onOpenPicture(view.id, n) : undefined} />;
    case 'gate':
      return (
        <p className="dock-muted dock-line" data-dock-line="gate" data-gate-record={item.gate}>
          {gateAsked(item.title)}
        </p>
      );
    case 'gate_closed':
      return (
        <p className="dock-muted dock-line" data-dock-line="gate_closed" data-gate-record={item.gate} data-gate-answer-record={`${item.answer}/${item.by}`}>
          {gateClosedLine(item.answer, item.by, item.yes, item.no, item.title)}
        </p>
      );
    case 'note':
      return (
        <p className="dock-muted dock-line dock-note" data-dock-line="note">
          <span aria-hidden="true">ⓘ </span>
          {item.text}
        </p>
      );
    case 'fallback':
      return (
        <p className="dock-muted dock-line" data-dock-line="fallback">
          {fallbackLine(item.from, item.to)}
        </p>
      );
    case 'review':
      return (
        <div className="dock-divider" role="separator" data-dock-review={`${item.round}/${item.of}`}>
          <span>{reviewDivider(item.round, item.of)}</span>
        </div>
      );
    case 'updated': {
      const line = updatedLine(item.updated.kinds, item.updated.ids, item.updated.names);
      return line ? (
        <p className="dock-muted dock-line" data-dock-line="updated" data-dock-updated="1">
          {line}
        </p>
      ) : null;
    }
    case 'plan':
      return <AgentPlan item={item} />;
    case 'agent_tools':
      return <AgentTools item={item} />;
    default:
      return <AgentLineItem item={item} />;
  }
}

/** The end block's words, or null while the turn runs. */
function EndBlock({ view, extra }: { view: TurnView; extra?: ReactNode }) {
  const s = view.summary;
  if (view.gone && !view.end) {
    return (
      <div className="dock-end" data-turn-end="gone">
        <p className="dock-muted">{RECORD_GONE}</p>
        {extra}
      </div>
    );
  }
  if (!isEnded(view)) return null;
  const state = view.end ? view.end.state : (view.state as 'done' | 'stopped' | 'failed' | 'capped');
  const message = view.end ? view.end.message : (s?.message ?? null);
  const reason = view.end ? view.end.reason : (s?.end_reason ?? null);
  const label = endLabel(state);
  const billing = s?.billing ?? (view.agent ? 'agent_account' : 'usd');
  const steps = s?.used?.steps ?? s?.step ?? 0;
  const usd = view.usage ? view.usage.turn_usd : (s?.usd ?? 0);
  const agentName = view.agent?.name ?? s?.agent?.name ?? null;
  return (
    <div className={`dock-end${state === 'done' ? '' : ` ${state}`}`} data-turn-end={state}>
      {label ? <strong className="dock-end-label">{label}</strong> : null}
      {state === 'done' ? <p className="dock-muted">{usageLine(steps, billing, usd, agentName)}</p> : endBody(state, message, reason) ? <p>{endBody(state, message, reason)}</p> : null}
      {s?.log_dropped ? <p className="dock-muted">{LOG_DROPPED}</p> : null}
      {extra}
    </div>
  );
}

export function TurnBlock({ view, row, newest, status, workspace, stopSentAt = null, localPictures, onOpenPicture, note, cards, endExtra, room = null, agentContext = null }: TurnBlockProps) {
  const ended = isEnded(view);
  // "Still stopping…" once the Stop's bound passed.
  const [, tick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (ended || stopSentAt === null) return;
    const left = stopSentAt + STILL_STOPPING_MS - performance.now();
    if (left <= 0) return;
    const t = setTimeout(tick, left + 20);
    return () => clearTimeout(t);
  }, [ended, stopSentAt]);

  const prompt = view.prompt ?? row?.title ?? '';
  const startedBy = view.summary?.started_by ?? row?.started_by ?? null;
  const pictures = view.promptImages;
  const files = view.summary?.attachments ?? [];
  const streaming = streamingStep(view);
  const toolKeys = view.items.filter((it) => it.kind === 'tool').map((it) => it.key);
  const openTools = new Set(toolKeys.slice(-OPEN_STEPS));
  const phase = turnPhase(view, stopSentAt === null ? null : { sentAt: stopSentAt, now: performance.now() });
  const counters = countersOf(view);
  // A turn the list says ended, before its snapshot came: no footer meanwhile.
  const waitingForPast = !view.summary && view.lastSeq === 0 && !!row && TERMINAL_ROW.has(row.state);

  return (
    <article className="dock-turn" data-dock-turn={view.id} data-turn-state={ended ? 'ended' : 'running'}>
      <div className="dock-you">
        <p className="dock-bubble" data-dock-prompt="1">
          {prompt}
        </p>
        {pictures.length || (localPictures && localPictures.length) ? (
          <div className="dock-you-pictures">
            {localPictures && localPictures.length
              ? localPictures.map((src, i) => (
                  <span key={src} className="dock-thumb small">
                    <img src={src} alt={yourPictureAlt(i + 1, localPictures.length)} />
                  </span>
                ))
              : pictures.map((im, i) => (
                  <Thumb key={im.n} turn={view.id} image={im} alt={yourPictureAlt(i + 1, pictures.length)} className="small" onOpen={onOpenPicture ? () => onOpenPicture(view.id, im.n) : undefined} />
                ))}
          </div>
        ) : null}
        {files.length ? (
          <ul className="dock-you-files" aria-label={ATTACHED_FILES}>
            {files.map((f) => (
              <li key={f.id} data-dock-you-file={f.name}>
                {fileChip(f.name, f.bytes)}
              </li>
            ))}
          </ul>
        ) : null}
        {startedBy === 'program' ? <p className="dock-muted dock-from">{FROM_PROGRAM}</p> : null}
      </div>
      {view.agent ? <AgentLine agent={view.agent} /> : null}
      {view.items.map((it) => (
        <Row key={it.key} view={view} item={it} open={openTools.has(it.key)} workspace={workspace} streaming={it.kind === 'text' && it.step === streaming} onOpenPicture={onOpenPicture} />
      ))}
      {cards}
      {!ended && !waitingForPast ? (
        <div className="dock-footer">
          <p className="dock-phase" data-dock-phase={phase.kind}>
            {footerWords(phase, workspace)}
          </p>
          {counters ? (
            <p className="dock-muted dock-counters" data-dock-counters="1">
              {counters}
            </p>
          ) : null}
          {note ? <p className="dock-muted" data-dock-elsewhere-note="1">{note}</p> : null}
        </div>
      ) : null}
      <EndBlock view={view} extra={endExtra} />
      {newest ? <Meter view={view} status={status} room={room} agentContext={agentContext} /> : null}
    </article>
  );
}
