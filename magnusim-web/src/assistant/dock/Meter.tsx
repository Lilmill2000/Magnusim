/**
 * The spend meter under the newest turn (phase 4 spec 2.9), by the turn's billing:
 * - usd: "This request: $0.42 of $8.00 · Today: $3.10 of $15.00" ("about" when estimated); a
 *   bar of the larger share, warning from 80% of either cap. Today is the newest usage event's
 *   day_usd, else the status's spent_today_usd; its cap the status's caps.day_usd.
 * - free: "Local server · no cost".
 * - agent_account: "Billed to your <Name> account (Magnusim can't see the cost)".
 */
import type { AssistantStatus } from '../wire';
import { METER_FREE, meterAgent, meterUsd } from './copy';
import type { TurnView } from './turnView';

export interface MeterNumbers {
  billing: 'usd' | 'free' | 'agent_account';
  text: string;
  /** usd: the larger share of a cap (0..1), and whether it is past 80%. */
  share: number | null;
  warn: boolean;
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
  return { billing, text: meterUsd(turnUsd, turnCap, estimated, dayUsd, dayCap), share, warn: shares.some((x) => x >= 0.8) };
}

export function Meter({ view, status }: { view: TurnView; status: AssistantStatus | null }) {
  const m = meterOf(view, status);
  if (!m) return null;
  return (
    <div className={`dock-meter${m.warn ? ' warn' : ''}`} data-dock-meter={m.billing}>
      <span className="dock-meter-text">{m.text}</span>
      {m.share !== null ? (
        <span className="dock-meter-bar" aria-hidden="true">
          <span style={{ width: `${Math.round(m.share * 100)}%` }} />
        </span>
      ) : null}
    </div>
  );
}
