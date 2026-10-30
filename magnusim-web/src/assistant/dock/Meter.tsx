/**
 * The spend meter under the newest turn (phase 4 spec 2.9), by the turn's billing:
 * - usd: "This request: $0.42 of $8.00 · Today: $3.10 of $15.00" ("about" when estimated); a
 *   bar of the larger share, warning from 80% of either cap. Today is the newest usage event's
 *   day_usd, else the status's spent_today_usd; its cap the status's caps.day_usd. From 80% of
 *   today's limit a line says so, and that a cheaper model or a lower Effort costs less.
 * - free: "Local server · no cost".
 * - agent_account: "Billed to your <Name> account (Magnusim can't see the cost)".
 * Under it, from 70% of the conversation's nearest limit (its row's room, read when the dock
 * opens and after each request: shown only while none runs, so the numbers are current), how
 * full the conversation is: "Conversation: 72% full (pictures 72 of 100)". A coding agent's
 * conversation is never full (its agent shortens its memory itself): under its meter, how much of
 * its own context the agent uses, as it last said (the row's context, shown while none runs):
 * "Context: 150,000 of 200,000 tokens (75%)".
 */
import type { AgentContext, AssistantStatus, ConversationRoom } from '../wire';
import { agentContextLine, dayNear, METER_FREE, meterAgent, meterUsd, roomLine } from './copy';
import type { TurnView } from './turnView';

/** The room readout shows from this share of the conversation's nearest limit. */
export const ROOM_FROM = 0.7;
/** The day line shows from this share of today's limit. */
export const DAY_NEAR_FROM = 0.8;

export interface MeterNumbers {
  billing: 'usd' | 'free' | 'agent_account';
  text: string;
  /** usd: the larger share of a cap (0..1), and whether it is past 80%. */
  share: number | null;
  warn: boolean;
  /** usd, from 80% of today's limit: the day line. */
  day?: string;
}

/** The room readout for a conversation's row, or null below ROOM_FROM (or without a room). */
export function roomOf(room: ConversationRoom | null | undefined): string | null {
  if (!room || !(room.limit > 0) || room.used / room.limit < ROOM_FROM) return null;
  return roomLine(room.reason, room.used, room.limit, typeof room.usd === 'number' ? room.usd : undefined);
}

export function meterOf(v: TurnView, status: AssistantStatus | null): MeterNumbers | null {
  const s = v.summary;
  const billing = s?.billing ?? (v.agent ? 'agent_account' : null);
  if (!billing) return null;
  if (billing === 'free') return { billing, text: METER_FREE, share: null, warn: false };
  if (billing === 'agent_account') {
    const name = v.agent?.name ?? s?.agent?.name ?? '';
    return { billing, text: meterAgent(name), share: null, warn: false };
  }
  const turnUsd = v.usage ? v.usage.turn_usd : (s?.usd ?? 0);
  const estimated = v.usage ? v.usage.estimated : !!s?.estimated;
  const turnCap = s?.used?.usd_cap || status?.caps?.turn_usd || 0;
  const dayUsd = v.usage ? v.usage.day_usd : (status?.spent_today_usd ?? 0);
  const dayCap = status?.caps?.day_usd || 0;
  const shares = [turnCap > 0 ? turnUsd / turnCap : 0, dayCap > 0 ? dayUsd / dayCap : 0];
  const share = Math.min(1, Math.max(...shares));
  const day = dayCap > 0 && dayUsd / dayCap >= DAY_NEAR_FROM ? dayNear(dayUsd, dayCap) : null;
  return { billing, text: meterUsd(turnUsd, turnCap, estimated, dayUsd, dayCap), share, warn: shares.some((x) => x >= 0.8), ...(day ? { day } : {}) };
}

export function Meter({ view, status, room = null, agentContext = null }: { view: TurnView; status: AssistantStatus | null; room?: ConversationRoom | null; agentContext?: AgentContext | null }) {
  const m = meterOf(view, status);
  const roomText = roomOf(room);
  const contextText = m?.billing === 'agent_account' && agentContext && agentContext.size > 0 ? agentContextLine(agentContext.used, agentContext.size) : null;
  if (!m && !roomText) return null;
  return (
    <>
      {m ? (
        <div className={`dock-meter${m.warn ? ' warn' : ''}`} data-dock-meter={m.billing}>
          <span className="dock-meter-text">{m.text}</span>
          {m.share !== null ? (
            <span className="dock-meter-bar" aria-hidden="true">
              <span style={{ width: `${Math.round(m.share * 100)}%` }} />
            </span>
          ) : null}
        </div>
      ) : null}
      {m?.day ? (
        <p className="dock-muted dock-meter-note" data-dock-day-near="1">
          {m.day}
        </p>
      ) : null}
      {roomText ? (
        <p className="dock-muted dock-meter-note" data-dock-room={room?.reason}>
          {roomText}
        </p>
      ) : null}
      {contextText ? (
        <p className="dock-muted dock-meter-note" data-dock-agent-context="1">
          {contextText}
        </p>
      ) : null}
    </>
  );
}
