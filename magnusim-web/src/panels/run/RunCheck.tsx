/**
 * RH2: the Run panel's "Before you start" block (spec 4.4): a draft's pre-run check, between its
 * Cores and its Start. The estimate line, then up to 6 rows (problems, warnings, notes), each
 * with its fix ("Apply"), its alternative with its cost, and "Keep as set"; the rows kept as set
 * under "Kept (n)"; "Apply all" with 2 or more fixable rows; "Check again".
 *
 * No row blocks Start: Start's title says what the run starts with. The words are
 * src/workbench/runCheckWords.ts's, which the Assistant's answers use too. A fix that needs a
 * setting the app does not offer yet is named in its row's text and gets no button.
 */
import { useState } from 'react';
import { applyRunCheck, keepRunCheck, runCheckAgain, type RunCheckFix, type RunState } from '../legacyBridge';
import { SHOWN_ROWS, altLabel, applyLabel, splitKept, type CheckRow } from '../../workbench/runCheckWords';

/** The fixes "Apply all" makes: the run and study ones (a place to open or a study copy is not a setting). */
function settable(fix: RunCheckFix | null | undefined): fix is RunCheckFix {
  return !!fix && (fix.target === 'run' || fix.target === 'study') && fix.values.length > 0;
}

export function RunCheck({ state, onError }: { state: RunState; onError: (e: unknown) => void }) {
  const [busy, setBusy] = useState(false);
  const pc = state.precheck;
  const draft = !state.status || state.status === 'draft';
  if (!draft || state.locked) return null;
  if (!pc && !state.precheck_busy && !state.precheck_error) return null;
  if (pc && pc.checked === false) return null;
  const rows = ((pc && pc.checks) || []) as CheckRow[];
  const { open, kept } = splitKept(rows, state.checks_kept || []);
  const shown = open.slice(0, SHOWN_ROWS);
  const fixable = open.filter((r) => settable(r.fix as RunCheckFix | null));
  const act = async (fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  };
  const line = pc && pc.estimate && typeof pc.estimate.line === 'string' ? pc.estimate.line : '';
  return (
    <div className="run-check" data-run-check="1">
      <div className="run-check-head">
        <span className="mat-k">Before you start</span>
        <button type="button" className="mat-clear-link" data-run-check-again="1" disabled={busy} onClick={() => runCheckAgain()}>
          Check again
        </button>
      </div>
      {line ? (
        <p className="mesh-finished-line" data-run-check-estimate="1">
          {line}
        </p>
      ) : null}
      {!pc && state.precheck_busy ? (
        <p className="mat-assign-hint" data-run-check-busy="1">
          Checking…
        </p>
      ) : null}
      {state.precheck_error ? (
        <p className="mat-assign-hint" data-run-check-error="1">
          {`Not checked: ${state.precheck_error}`}
        </p>
      ) : null}
      {pc && !open.length ? (
        <p className="mat-assign-hint" data-run-check-none="1">
          {kept.length ? 'Nothing else found.' : 'Nothing found in its settings, mesh or physics.'}
        </p>
      ) : null}
      {shown.length ? (
        <ul className="run-health-findings">
          {shown.map((r) => (
            <li key={r.code} className={'run-health-finding is-' + r.level} data-run-check-row={r.code} data-level={r.level}>
              <p className="run-health-text" data-run-check-text="1">
                {r.text}
              </p>
              <div className="run-health-buttons">
                {r.fix ? (
                  <button
                    type="button"
                    className="fp-btn"
                    data-run-check-apply={r.code}
                    disabled={busy}
                    onClick={() => void act(() => applyRunCheck(r.fix as RunCheckFix))}
                  >
                    {applyLabel(r.fix)}
                  </button>
                ) : null}
                {r.alt ? (
                  <button
                    type="button"
                    className="mat-clear-link"
                    data-run-check-alt={r.code}
                    disabled={busy}
                    onClick={() => void act(() => applyRunCheck(r.alt as RunCheckFix))}
                  >
                    {altLabel(r.alt)}
                  </button>
                ) : null}
                <button type="button" className="mat-clear-link" data-run-check-keep={r.code} disabled={busy} onClick={() => void act(() => keepRunCheck(r.code))}>
                  Keep as set
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {open.length > shown.length ? (
        <p className="mat-assign-hint" data-run-check-more="1">
          {`${open.length - shown.length} more after these are dealt with.`}
        </p>
      ) : null}
      {fixable.length >= 2 ? (
        <button
          type="button"
          className="fp-btn"
          data-run-check-apply-all="1"
          disabled={busy}
          onClick={() => void act(() => applyRunCheck(fixable.map((r) => r.fix as RunCheckFix)))}
        >
          Apply all
        </button>
      ) : null}
      {kept.length ? (
        <details className="run-check-kept" data-run-check-kept="1">
          <summary>{`Kept (${kept.length})`}</summary>
          <ul className="run-health-findings">
            {kept.map((r) => (
              <li key={r.code} className="run-health-finding" data-run-check-kept-row={r.code} data-level={r.level}>
                <p className="run-health-text">{r.text}</p>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
