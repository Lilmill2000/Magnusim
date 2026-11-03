import { useEffect, useRef, useState } from 'react';
import type { RunState } from '../legacyBridge';
import { addHealthFixRun, refreshRunPanel, simStop } from '../legacyBridge';
import {
  BEFORE_CHECKS,
  HEALTH_WHY,
  NOT_CHECKED,
  chipTitle,
  chipWord,
  earlierPartLines,
  healthNextWords,
  healthSubline,
  type HealthFix,
  type HealthRecord,
  type HealthRunView,
} from '../../workbench/runHealthWords';

/** The view of the run the Health words read (runHealthWords.ts). */
export function healthRunView(state: RunState): HealthRunView {
  const r = state.health_run;
  return {
    name: state.name,
    status: (r && r.status) || state.status,
    stopping: !!(r && r.stopping),
    saved: r && typeof r.saved === 'number' ? r.saved : null,
    transient: state.transient,
  };
}

const SHOWN = 3;

interface LogAnswer {
  lines: string[];
  hit_line: number | null;
  live?: boolean;
  as_of?: string | null;
  missing?: boolean;
  part?: string | null;
  error?: string;
}

/** Where Solver output reads from: the end, the start, or a finding's line. */
type LogAt = { at: 'end' } | { at: 'start' } | { at: 'line'; log_at: number; key: string };

/**
 * The run's solver output (RH1, spec 3.10): the last 200 lines, or from the start, or around a
 * finding's line ("Show in log"), the problem lines only on request, from the Windows copy of
 * its log (about 10 s behind a live run).
 */
function SolverOutput({
  ids,
  runId,
  live,
  open,
  setOpen,
  where,
  setWhere,
  copyFailed,
}: {
  ids: { project_id: string; simulation_id: string };
  runId: string;
  live: boolean;
  open: boolean;
  setOpen: (on: boolean) => void;
  where: LogAt;
  setWhere: (w: LogAt) => void;
  copyFailed: boolean;
}) {
  const [issues, setIssues] = useState(false);
  const [log, setLog] = useState<LogAnswer | null>(null);
  const hitRef = useRef<HTMLSpanElement | null>(null);
  const atKey = where.at === 'line' ? `${where.log_at}|${where.key}` : where.at;
  useEffect(() => {
    if (!open || !runId) return;
    let gone = false;
    const load = async () => {
      const q = new URLSearchParams({ project_id: ids.project_id, simulation_id: ids.simulation_id, run_id: runId, lines: '200' });
      if (where.at === 'line') {
        q.set('at', String(where.log_at));
        if (where.key) q.set('key', where.key);
      } else q.set('at', where.at);
      if (issues) q.set('filter', 'issues');
      try {
        const r = await fetch(`/api/run/solver-log?${q}`, { cache: 'no-store' });
        const j = (await r.json()) as LogAnswer & { ok?: boolean };
        if (!gone) setLog(r.ok ? j : { lines: [], hit_line: null, error: String((j && (j as { error?: string }).error) || 'The solver output could not be read.') });
      } catch {
        if (!gone) setLog({ lines: [], hit_line: null, error: 'The solver output could not be read.' });
      }
    };
    void load();
    // A live run's copy is refreshed every 10 s.
    const timer = live && where.at === 'end' ? window.setInterval(load, 10_000) : null;
    return () => {
      gone = true;
      if (timer) window.clearInterval(timer);
    };
  }, [open, runId, atKey, issues, live, ids.project_id, ids.simulation_id]);
  useEffect(() => {
    if (log && log.hit_line !== null) hitRef.current?.scrollIntoView?.({ block: 'center' });
  }, [log]);
  return (
    <details className="run-solver-log" data-run-solver-log="1" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>Solver output (last 200 lines)</summary>
      <div className="run-solver-log-bar">
        <span className="run-solver-log-at" data-run-solver-log-at={where.at === 'start' ? 'start' : 'end'} role="group" aria-label="Where the output starts">
          <button type="button" className={'fp-btn' + (where.at !== 'start' ? ' is-on' : '')} aria-pressed={where.at !== 'start'} data-at="end" onClick={() => setWhere({ at: 'end' })}>
            End
          </button>
          <button type="button" className={'fp-btn' + (where.at === 'start' ? ' is-on' : '')} aria-pressed={where.at === 'start'} data-at="start" onClick={() => setWhere({ at: 'start' })}>
            From the start
          </button>
        </span>
        <label className="run-solver-log-issues">
          <input type="checkbox" checked={issues} data-run-solver-log-issues="1" onChange={(e) => setIssues(e.target.checked)} /> Only problem lines
        </label>
      </div>
      {live ? <p className="mat-assign-hint">Copied from the solver every 10 s</p> : null}
      {copyFailed ? <p className="mat-assign-hint">The log may end before the run did.</p> : null}
      {log?.error ? <p className="mat-assign-hint" role="alert">{log.error}</p> : null}
      {log?.missing ? <p className="mat-assign-hint">This run has no solver output.</p> : null}
      {log && !log.missing && !log.error ? (
        <pre className="run-solver-log-lines" data-run-solver-log-lines="1">
          {log.lines.map((line, i) => (
            <span
              key={i}
              ref={i === log.hit_line ? hitRef : undefined}
              className={i === log.hit_line ? 'is-hit' : undefined}
              data-line={i}
              {...(i === log.hit_line ? { 'data-hit': '1' } : {})}
            >
              {line + '\n'}
            </span>
          ))}
        </pre>
      ) : null}
    </details>
  );
}

/**
 * The Run panel's Health block (RH1, spec 3.10): the verdict chip and what it covers, the
 * findings with their line in the log, what to do (a new run with the fix: A3), the solver's
 * output, and earlier parts of a continued run.
 */
export function RunHealth({ state, ids }: { state: RunState; ids: { project_id: string; simulation_id: string } }) {
  const view = healthRunView(state);
  const record = (state.health as HealthRecord | null | undefined) || null;
  const [checked, setChecked] = useState<HealthRecord | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState('');
  const [all, setAll] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [where, setWhere] = useState<LogAt>({ at: 'end' });
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const h = record || checked;
  const live = ['running', 'starting', 'queued'].includes(view.status);
  const ended = ['done', 'stopped', 'failed'].includes(view.status);
  useEffect(() => {
    setChecked(null);
    setChecking(false);
    setCheckError('');
    setAll(false);
    setWhere({ at: 'end' });
  }, [state.run_id]);
  useEffect(() => {
    if (!live) return;
    const t = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(t);
  }, [live]);
  // "Check its log": ask again until the check has a record (or says why not).
  useEffect(() => {
    if (!checking) return;
    let gone = false;
    const q = new URLSearchParams({ project_id: ids.project_id, simulation_id: ids.simulation_id, run_id: state.run_id });
    const timer = window.setInterval(async () => {
      try {
        const r = await fetch(`/api/run/health?${q}`, { cache: 'no-store' });
        const j = (await r.json()) as { health?: HealthRecord | null; checking?: boolean; error?: string };
        if (gone) return;
        if (j.health) {
          setChecked(j.health);
          setChecking(false);
          refreshRunPanel();
        } else if (!j.checking) {
          setChecking(false);
          setCheckError(j.error || 'Its log could not be checked.');
        }
      } catch {
        /* the next try */
      }
    }, 1000);
    return () => {
      gone = true;
      window.clearInterval(timer);
    };
  }, [checking, state.run_id, ids.project_id, ids.simulation_id]);

  if (!h) {
    if (state.health_checked === false) {
      return (
        <div className="run-health" data-run-health-block="1">
          <div className="mat-k">Health</div>
          <p className="mat-assign-hint" data-run-health-none="1">
            {NOT_CHECKED}
          </p>
        </div>
      );
    }
    if (state.health_checked === true && ended) {
      return (
        <div className="run-health" data-run-health-block="1">
          <div className="mat-k">Health</div>
          <p className="mat-assign-hint" data-run-health-none="1">
            It ended before its health could be judged (from the 6th {view.transient ? 'time step' : 'iteration'} on).
          </p>
        </div>
      );
    }
    if (state.health_checked === true) {
      return (
        <div className="run-health" data-run-health-block="1">
          <div className="run-health-head">
            <span className="mat-k">Health</span>
            <span className="run-health-chip is-pending" data-run-health="pending" title={chipTitle(null, view.transient)}>
              {chipWord(null, view.transient)}
            </span>
          </div>
        </div>
      );
    }
    if (!ended) return null;
    return (
      <div className="run-health" data-run-health-block="1">
        <div className="mat-k">Health</div>
        <p className="mat-assign-hint" data-run-health-before="1">
          {BEFORE_CHECKS}
        </p>
        {checking ? (
          <p className="mat-assign-hint" data-run-health-checking="1">
            Checking its log…
          </p>
        ) : (
          <button
            type="button"
            className="fp-btn"
            data-run-health-check="1"
            onClick={async () => {
              setCheckError('');
              const q = new URLSearchParams({ project_id: ids.project_id, simulation_id: ids.simulation_id, run_id: state.run_id, recompute: '1' });
              try {
                const r = await fetch(`/api/run/health?${q}`, { cache: 'no-store' });
                const j = (await r.json()) as { health?: HealthRecord | null; checking?: boolean; error?: string };
                if (j.health) setChecked(j.health);
                else if (j.checking) setChecking(true);
                else setCheckError(j.error || 'Its log could not be checked.');
              } catch {
                setCheckError('Its log could not be checked.');
              }
            }}
          >
            Check its log
          </button>
        )}
        {checkError ? (
          <p className="mat-assign-hint" role="alert">
            {checkError}
          </p>
        ) : null}
      </div>
    );
  }

  const findings = h.findings || [];
  const shown = all ? findings : findings.slice(0, SHOWN);
  const next = healthNextWords(view, h);
  const age = h.at ? (now - Date.parse(h.at)) / 1000 : null;
  const earlier = earlierPartLines(
    (state.health_run && (state.health_run.attempts as Array<Record<string, unknown>>)) || [],
    (state.health_run && (state.health_run.continue_changes as Array<Record<string, unknown>>)) || [],
    view.transient,
  );
  const fix = async (f: HealthFix) => {
    if (busy) return;
    setBusy(true);
    try {
      await addHealthFixRun(state.run_id, f);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="run-health" data-run-health-block="1" data-run-health-verdict={h.verdict}>
      <div className="run-health-head">
        <span className="mat-k">Health</span>
        <span className={'run-health-chip is-' + h.verdict} data-run-health={h.verdict} title={chipTitle(h, view.transient)}>
          {chipWord(h, view.transient)}
        </span>
      </div>
      <div className="mesh-finished-line" data-run-health-subline="1">
        {healthSubline(h, view, live && h.live !== false ? age : null)}
      </div>
      {shown.length ? (
        <ul className="run-health-findings">
          {shown.map((f) => (
            <li key={f.code} className={'run-health-finding is-' + f.level} data-run-health-finding={f.code} data-level={f.level}>
              <p className="run-health-text" data-run-health-text="1">
                {f.text || ''}
              </p>
              <div className="run-health-actions">
                {f.evidence && typeof f.evidence.log_at === 'number' ? (
                  <button
                    type="button"
                    className="mat-clear-link"
                    data-run-health-evidence="1"
                    onClick={() => {
                      setWhere({ at: 'line', log_at: f.evidence!.log_at as number, key: String(f.evidence!.key || '') });
                      setLogOpen(true);
                    }}
                  >
                    Show in log
                  </button>
                ) : null}
                {HEALTH_WHY[f.code] ? (
                  <details className="run-health-why">
                    <summary>Why</summary>
                    <p>{HEALTH_WHY[f.code]}</p>
                  </details>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {findings.length > SHOWN && !all ? (
        <button type="button" className="mat-clear-link" data-run-health-more="1" onClick={() => setAll(true)}>
          Show all {findings.length}
        </button>
      ) : null}
      {next.text || next.stop || next.fixes.length ? (
        <div className="run-health-fix" data-run-health-fix="1">
          <div className="mat-k">What to do</div>
          {next.text ? (
            <p className="mat-assign-hint" data-run-health-next="1">
              {next.text}
            </p>
          ) : null}
          <div className="run-health-buttons">
            {next.stop ? (
              <button type="button" className="fp-btn" data-run-health-stop="1" onClick={() => void simStop()}>
                Stop this run
              </button>
            ) : null}
            {next.fixes.map((f, i) =>
              i === 0 ? (
                <button key={i} type="button" className="fp-btn fp-btn-primary" data-run-health-newrun="0" disabled={busy} onClick={() => void fix(f)}>
                  {f.words}
                </button>
              ) : (
                <button key={i} type="button" className="mat-clear-link" data-run-health-newrun={String(i)} disabled={busy} onClick={() => void fix(f)}>
                  {f.words}
                </button>
              ),
            )}
          </div>
        </div>
      ) : null}
      {earlier.map((line, i) => (
        <p key={i} className="mat-assign-hint" data-run-health-earlier="1">
          {line}
        </p>
      ))}
      <SolverOutput
        ids={ids}
        runId={state.run_id}
        live={live}
        open={logOpen}
        setOpen={setLogOpen}
        where={where}
        setWhere={setWhere}
        copyFailed={(state.warnings || []).some((w) => /did not come back|could not be kept|could not be copied/i.test(w))}
      />
    </div>
  );
}
