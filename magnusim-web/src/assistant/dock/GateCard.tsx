/**
 * A question of the Assistant as a card in the dock (phase 4 spec 4.3, 4.4, 4.6): its badge, its
 * title and copy (host-written, shown as text), its detail rows, who asks and how long it stays
 * open, then No (first) and Yes, and how to answer by keyboard.
 *
 * Enter or Escape anywhere in the card answers No, and goes no further (no click follows, the
 * dock stays open). Yes is guarded (src/workbench/guardedYes.ts, as the app's confirm dialog):
 * disabled for its first 500 ms, then a click whose press began on it, never the second click
 * of a double-click; by keyboard Tab to it, then Space. A privacy question also offers
 * "Privacy settings" (Settings → Assistant), and stays open meanwhile.
 *
 * The keyboard is given to the oldest card's No by gates.ts, not here.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react';
import { openSetupWizard } from '../../wizard/controller';
import { guardYes, type GuardedYes } from '../../workbench/guardedYes';
import { ANSWER_HERE_ONLY, closesIn, gateHelp, PRIVACY_SETTINGS, PROJECT_DATA, riskBadge } from './copy';
import { cardRemounted, type OpenCard } from './gates';

/** The footer's "Closes in" is read again this often. */
export const CLOSES_TICK_MS = 30_000;

/** Whole minutes left until `expiresAt` (ISO), or null without one. */
export function minutesLeft(expiresAt: string, now = Date.now()): number | null {
  const t = Date.parse(expiresAt);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((t - now) / 60_000));
}

export function GateCard({ card, who, first = false }: { card: OpenCard; who?: string | null; /** The oldest card: opening the dock gives its No the keyboard. */ first?: boolean }) {
  const g = card.gate;
  const id = useId();
  const yes = useRef<HTMLButtonElement>(null);
  const guard = useRef<GuardedYes | null>(null);
  const [, setArmed] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  // Before the card is painted: Yes is disabled until the guard lets it go.
  useLayoutEffect(() => {
    const gy = guardYes(yes.current, { onArmed: () => setArmed(true) });
    guard.current = gy;
    return () => gy.dispose();
  }, []);
  // Drawn again in another place (strip → under its request): the keyboard it had comes back.
  useEffect(() => cardRemounted(), []);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), CLOSES_TICK_MS);
    return () => clearInterval(t);
  }, []);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLElement>) => {
    if ((e.key !== 'Enter' && e.key !== 'Escape') || e.nativeEvent.isComposing) return;
    // Handled: no keypress follows to click what has the keyboard, and the dock stays open.
    e.preventDefault();
    e.stopPropagation();
    card.answer(false);
  };
  const onYes = (e: ReactMouseEvent<HTMLButtonElement>) => {
    if (!guard.current?.accepts(e.nativeEvent)) return;
    card.answer(true);
  };

  const badges: Array<{ text: string; tone: string }> = [];
  if (g.kind === 'privacy') badges.push({ text: PROJECT_DATA, tone: 'warning' });
  else if (g.risk === 'destructive') badges.push({ text: riskBadge('destructive'), tone: 'danger' });
  else if (g.risk === 'compute') badges.push({ text: riskBadge('compute'), tone: 'warning' });
  if (g.link_only) badges.push({ text: ANSWER_HERE_ONLY, tone: '' });
  const rows = Array.isArray(g.detail) ? g.detail.filter((r) => r && typeof r.label === 'string' && typeof r.value === 'string').slice(0, 6) : [];
  const left = minutesLeft(g.expires_at, now);

  return (
    <section
      className="dock-gate"
      role="alertdialog"
      aria-labelledby={`${id}-t`}
      aria-describedby={`${id}-c`}
      data-gate={g.id}
      data-gate-kind={g.kind}
      onKeyDown={onKeyDown}
    >
      {badges.length ? (
        <div className="dock-gate-badges">
          {badges.map((b) => (
            <span key={b.text} className={`dock-badge ${b.tone}`} data-gate-badge="1">
              {b.text}
            </span>
          ))}
        </div>
      ) : null}
      <h3 className="dock-gate-title" id={`${id}-t`}>
        {g.title}
      </h3>
      <p className="dock-gate-copy" id={`${id}-c`}>
        {g.copy}
      </p>
      {rows.length ? (
        <dl className="dock-gate-detail">
          {rows.map((r, i) => (
            <div key={i}>
              <dt>{r.label}</dt>
              <dd>{r.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {who || left !== null ? (
        <p className="dock-muted dock-gate-footer">
          {[who, left !== null ? closesIn(left) : null].filter(Boolean).join(' · ')}
        </p>
      ) : null}
      <div className="dock-gate-buttons">
        <button type="button" className="dock-gate-no" data-gate-answer="no" data-dock-autofocus={first ? '1' : undefined} onClick={() => card.answer(false)}>
          {g.no}
        </button>
        <button type="button" ref={yes} className="dock-gate-yes" data-gate-answer="yes" onClick={onYes}>
          {g.yes}
        </button>
        {g.kind === 'privacy' ? (
          <button type="button" className="dock-link-button" data-gate-privacy-settings="1" onClick={() => openSetupWizard({ required: false, step: 'assistant' })}>
            {PRIVACY_SETTINGS}
          </button>
        ) : null}
      </div>
      <p className="dock-muted dock-gate-help">{gateHelp(g.no, g.yes)}</p>
    </section>
  );
}
