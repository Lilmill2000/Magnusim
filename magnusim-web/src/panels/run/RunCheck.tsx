/**
 * RH2: the Run panel's "Before you start" block (spec 4.4): a draft's pre-run check, between its
 * Cores and its Start. The estimate line, then up to 6 rows (problems, warnings, notes), each
 * with its fix ("Apply"), its alternative with its cost, and "Keep as set"; the rows kept as set
 * under "Kept (n)", each with "Undo keep"; "Apply all" with 2 or more fixable problems or
 * warnings shown; "Check again". A check of the run's settings only (no mesh yet) says so.
 *
 * No row blocks Start: Start's title says what the run starts with. The words are
 * src/workbench/runCheckWords.ts's, which the Assistant's answers use too. A fix that needs a
 * setting the app does not offer yet is named in its row's text and gets no button.
 */
import { useState } from 'react';
import { applyRunCheck, keepRunCheck, runCheckAgain, unkeepRunCheck, type RunCheckFix, type RunState } from '../legacyBridge';
import {
  SHOWN_ROWS,
  altLabel,
  applyAllFixes,
  applyAllTitle,
  applyLabel,
  noneFoundWords,
  partialWords,
  splitKept,
  type CheckRow,
} from '../../workbench/runCheckWords';

export function RunCheck({ state, onError }: { state: RunState; onError: (e: unknown) => void }) {
  const [busy, setBusy] = useState(false);
  const pc = state.precheck;
  const draft = !state.status || state.status === 'draft';
  if (!draft || state.locked) return null;
  if (!pc && !state.precheck_busy && !state.precheck_error) return null;
  if (pc && pc.checked === false) return null;
  // Kept as the panel shows it (the run's checks_kept, a Keep as set or Undo keep not saved yet
  // included), not as the last answer was checked with: a save still on its way would leave the
  // answer's `kept` behind, and nothing asks again once it lands.
  const rows = ((pc && pc.checks) || []).map((r) => ({ ...r, kept: false })) as CheckRow[];
  const { open, kept } = splitKept(rows, state.checks_kept || []);
  const shown = open.slice(0, SHOWN_ROWS);
  // "Apply all" changes only what the person sees: the problems and warnings shown, not the notes.
  const fixable = applyAllFixes(shown) as RunCheckFix[];
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
  const partial = pc ? partialWords(pc.estimate) : null;
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
      {partial ? (
        <p className="mat-assign-hint" data-run-check-partial="1">
          {partial}
        </p>
      ) : null}
      {pc && !open.length ? (
        <p className="mat-assign-hint" data-run-check-none="1">
          {noneFoundWords(pc.estimate, kept.length > 0)}
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
          title={applyAllTitle(fixable)}
          disabled={busy}
          onClick={() => void act(() => applyRunCheck(fixable))}
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
                <div className="run-health-buttons">
                  <button
                    type="button"
                    className="mat-clear-link"
                    data-run-check-unkeep={r.code}
                    title="Show this row with its fix again"
                    disabled={busy}
                    onClick={() => void act(() => unkeepRunCheck(r.code))}
                  >
                    Undo keep
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
