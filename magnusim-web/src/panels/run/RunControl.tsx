import { useEffect, useState } from 'react';
import { SciNumberInput } from '../../forms/SciNumberInput';
import { dispatchPanelDone, type IslandProps } from '../../islands';
import {
  copyRunFrom,
  deleteRun,
  renameRun,
  resetTransientAdvanced,
  runCopyPick,
  runSetupFix,
  runStateNow,
  saveRunSettings,
  saveTransientSettings,
  simStart,
  simStop,
  subscribeRunState,
  type RunState,
  type TransientSettings,
} from '../legacyBridge';
import { scopeIds } from '../scope';
import { ResidualPlot } from './ResidualPlot';
import { RunMonitors } from './RunMonitors';

/** Live run panel state from the runtime (`cfd:run-state`). */
export function useRunState(): RunState | null {
  const [state, setState] = useState<RunState | null>(() => runStateNow());
  useEffect(() => {
    setState(runStateNow());
    return subscribeRunState(setState);
  }, []);
  return state;
}

function RunTitle({ name, canRename }: { name: string; canRename: boolean }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  useEffect(() => {
    if (!editing) setDraft(name);
  }, [name, editing]);
  function stop(commit: boolean) {
    setEditing(false);
    const next = draft.trim();
    if (commit && next && next !== name) void renameRun(next);
    else setDraft(name);
  }
  return (
    <div className="mat-panel-head">
      <div className="mesh-title-row">
        {editing ? (
          <input
            type="text"
            className="mesh-rename-input"
            maxLength={64}
            aria-label="Run name"
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => stop(true)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                stop(true);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                stop(false);
              }
            }}
          />
        ) : (
          <>
            <span className="mat-panel-title" data-run-title="1">
              {name}
            </span>
            {canRename ? (
              <button type="button" className="mesh-rename" title="Rename run" aria-label="Rename run" onClick={() => setEditing(true)}>
                <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" focusable="false">
                  <g fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M4 16.8V20h3.2L18.4 8.8l-3.2-3.2L4 16.8z" />
                    <path d="M13.8 6.9l3.2 3.2" />
                  </g>
                </svg>
              </button>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

function NumberRow({
  label,
  title,
  value,
  disabled,
  unit,
  placeholder,
  onCommit,
}: {
  label: string;
  title?: string;
  value: number | null | undefined;
  disabled: boolean;
  unit?: string;
  placeholder?: string;
  onCommit: (v: number | null) => void;
}) {
  const [text, setText] = useState(value == null ? '' : String(value));
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setText(value == null ? '' : String(value));
  }, [value, editing]);
  function commit() {
    setEditing(false);
    const raw = text.trim();
    if (!raw) {
      if (placeholder) onCommit(null);
      else setText(value == null ? '' : String(value));
      return;
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      setText(value == null ? '' : String(value));
      return;
    }
    if (n !== value) onCommit(n);
  }
  const input = (
    <input
      type="text"
      inputMode="decimal"
      className="bc-input"
      aria-label={label}
      disabled={disabled}
      placeholder={placeholder}
      value={text}
      onFocus={() => setEditing(true)}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
    />
  );
  return (
    <div className="mat-row">
      <span className="mat-k" title={title}>
        {label}
      </span>
      {unit ? (
        <span className="mat-v bc-value-row">
          {input}
          <span className="bc-unit-label">{unit}</span>
        </span>
      ) : (
        input
      )}
    </div>
  );
}

function TransientFields({ state }: { state: RunState }) {
  const t = state.transient_settings;
  const locked = state.locked;
  const fixed = t.time_step_mode === 'fixed';
  const save = (patch: Partial<TransientSettings>) => void saveTransientSettings({ ...t, ...patch });
  return (
    <div data-run-transient="1">
      <NumberRow
        label="Simulation time"
        title="Physical time to simulate (seconds)."
        value={t.end_time}
        unit="s"
        disabled={locked}
        onCommit={(v) => v != null && save({ end_time: v })}
      />
      <NumberRow
        label="Result frames"
        title="How many result frames to write over the simulation time. The interval between frames is calculated."
        value={t.write_count}
        disabled={locked}
        onCommit={(v) => v != null && save({ write_count: Math.round(v) })}
      />
      {state.transient_hint ? (
        <p className="mat-assign-hint sim-tr-hint" data-run-transient-hint="1">
          {state.transient_hint.text}
          {state.transient_hint.warn ? <span className="sim-tr-warn"> {state.transient_hint.warn}</span> : null}
        </p>
      ) : null}
      <details className="mesh-advanced">
        <summary>Advanced settings</summary>
        <div className="mat-row">
          <span className="mat-k" title="Adjustable: the step follows the flow to hold the Courant number below the limit. Fixed: one constant step.">
            Time step
          </span>
          <select
            className="bc-select"
            aria-label="Time step mode"
            disabled={locked}
            value={fixed ? 'fixed' : 'adjustable'}
            onChange={(e) => save({ time_step_mode: e.target.value })}
          >
            <option value="adjustable">Adjustable (Courant-limited)</option>
            <option value="fixed">Fixed</option>
          </select>
        </div>
        {!fixed ? (
          <NumberRow
            label="Max Courant number"
            title="Largest cell Courant number allowed. 1 is time-accurate; up to ~5 runs faster with more outer correctors."
            value={t.max_co}
            disabled={locked}
            onCommit={(v) => v != null && save({ max_co: v })}
          />
        ) : null}
        <div className="mat-row">
          <span className="mat-k" title="Leave blank to calculate from the mesh size and inlet speed.">
            {fixed ? 'Time step Δt' : 'Initial Δt'}
          </span>
          <span className="mat-v bc-value-row">
            <SciOrAuto value={t.delta_t} label="Time step in seconds" disabled={locked} onCommit={(v) => save({ delta_t: v })} />
            <span className="bc-unit-label">s</span>
          </span>
        </div>
        {!fixed ? (
          <div className="mat-row">
            <span
              className="mat-k"
              title="Cap for the adjustable step. Blank uses simulation time ÷ result frames. Never larger than that interval, so every result frame is written."
            >
              Max Δt
            </span>
            <span className="mat-v bc-value-row">
              <SciOrAuto
                value={t.max_delta_t}
                label="Maximum time step in seconds"
                placeholder={state.frame_interval > 0 ? String(Number(state.frame_interval.toPrecision(6))) : 'auto'}
                disabled={locked}
                onCommit={(v) => save({ max_delta_t: v })}
              />
              <span className="bc-unit-label">s</span>
            </span>
          </div>
        ) : null}
        <div className="mat-row">
          <span className="mat-k" title="Euler is first order and robust. Backward is second order in time.">
            Time scheme
          </span>
          <select
            className="bc-select"
            aria-label="Time scheme"
            disabled={locked}
            value={t.time_scheme === 'backward' ? 'backward' : 'Euler'}
            onChange={(e) => save({ time_scheme: e.target.value })}
          >
            <option value="Euler">Euler (1st order)</option>
            <option value="backward">Backward (2nd order)</option>
          </select>
        </div>
        <NumberRow
          label="Outer correctors"
          title="PIMPLE outer loops per time step. 1 = PISO; 2–3 allow a higher Courant number."
          value={t.n_outer_correctors}
          disabled={locked}
          onCommit={(v) => v != null && save({ n_outer_correctors: Math.round(v) })}
        />
        <NumberRow
          label="Pressure correctors"
          title="Pressure corrections per outer loop."
          value={t.n_correctors}
          disabled={locked}
          onCommit={(v) => v != null && save({ n_correctors: Math.round(v) })}
        />
        <NumberRow
          label="Non-orthogonal correctors"
          title="Extra non-orthogonal corrections for skewed cells."
          value={t.n_non_orth_correctors}
          disabled={locked}
          onCommit={(v) => v != null && save({ n_non_orth_correctors: Math.round(v) })}
        />
        {!locked ? (
          <button type="button" className="mat-clear-link sim-tr-reset" onClick={() => void resetTransientAdvanced()}>
            Reset advanced to defaults
          </button>
        ) : null}
      </details>
    </div>
  );
}

/** A number that may be left blank ("auto"); shows tiny steps as 1.0000e-4. */
function SciOrAuto({
  value,
  label,
  placeholder = 'auto',
  disabled,
  onCommit,
}: {
  value: number | null | undefined;
  label: string;
  placeholder?: string;
  disabled: boolean;
  onCommit: (v: number | null) => void;
}) {
  const [blankKey, setBlankKey] = useState(0);
  if (value == null) {
    return (
      <input
        key={blankKey}
        type="text"
        inputMode="decimal"
        className="bc-input"
        aria-label={label}
        placeholder={placeholder}
        disabled={disabled}
        defaultValue=""
        onBlur={(e) => {
          const raw = e.target.value.trim();
          if (!raw) return;
          const n = Number(raw);
          if (Number.isFinite(n) && n > 0) onCommit(n);
          else setBlankKey((k) => k + 1);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
      />
    );
  }
  return (
    <span onBlur={(e) => {
      const input = e.target as HTMLInputElement;
      if (input.value.trim() === '') onCommit(null);
    }}>
      <SciNumberInput value={value} label={label} disabled={disabled} onCommit={(n) => onCommit(n > 0 ? n : null)} />
    </span>
  );
}

function RunStatus({ state, ids }: { state: RunState; ids: { project_id: string; simulation_id: string } }) {
  const p = state.progress;
  if (!p.show) return null;
  return (
    <div className="sim-finished" data-run-status={state.status}>
      <div className="mat-k">{p.title}</div>
      <div className="mesh-finished-line" data-run-line="1">
        {p.line}
      </div>
      {p.elapsed ? <div className="mesh-elapsed">{p.elapsed}</div> : null}
      {p.eta ? <div className="sim-eta">{p.eta}</div> : null}
      <ResidualPlot rows={p.residuals} endTime={p.end} transient={state.transient} />
      {p.meta ? <div className="mesh-finished-meta">{p.meta}</div> : null}
      <RunMonitors projectId={ids.project_id} simulationId={ids.simulation_id} runId={state.run_id} live={state.running} />
    </div>
  );
}

function CopyFromRun({ state }: { state: RunState }) {
  const c = state.copy;
  if (!c.available) return null;
  return (
    <div className="sim-copy-from" data-run-copy="1">
      {c.picking ? (
        <div className="sim-copy-picker">
          <label className="mat-k" htmlFor="run-copy-source">
            Copy settings from
          </label>
          <select
            id="run-copy-source"
            className="bc-select"
            aria-label="Run to copy settings from"
            defaultValue=""
            onChange={(e) => e.target.value && void copyRunFrom(e.target.value)}
          >
            <option value="">Select a run…</option>
            {c.sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
          <p className="mat-assign-hint">Or click a run in the tree.</p>
          <button type="button" className="mat-clear-link" onClick={() => runCopyPick(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <button type="button" className="fp-btn" onClick={() => runCopyPick(true)}>
          Copy from previous run
        </button>
      )}
      {c.note ? <p className="mat-assign-hint">{c.note}</p> : null}
    </div>
  );
}

/**
 * The run flyout: settings, Start with the reason it cannot start yet, live
 * progress and residuals. The runtime owns the gate and the solve; this panel
 * renders `cfd:run-state` and acts through legacyBridge.
 */
export function RunControl(props: IslandProps) {
  const state = useRunState();
  const ids = scopeIds(props);
  const [note, setNote] = useState('');
  if (!state || !state.has_run) {
    return (
      <div data-run-control="1">
        <div className="mat-panel-head">
          <span className="mat-panel-title">Run</span>
        </div>
        <p className="mat-assign-hint">Add a run under Simulation to set it up and start it.</p>
        <div className="mat-panel-foot foot-end">
          <button type="button" className="js-btn tree-panel-done" onClick={() => dispatchPanelDone()}>
            Done
          </button>
        </div>
      </div>
    );
  }
  const locked = state.locked;
  const report = (e: unknown) => setNote(e instanceof Error ? e.message : String(e));
  return (
    <div data-run-control="1" data-run-id={state.run_id}>
      <RunTitle name={state.name} canRename={!!state.run_id} />
      <div className="mat-panel-body">
        <CopyFromRun state={state} />
        <div className="mat-row sim-mode-row">
          <span className="mat-k">Time dependency</span>
          <span className="mat-v" data-run-mode="1">
            {state.transient ? 'Transient' : 'Steady-state'}
          </span>
        </div>
        {state.transient ? (
          <TransientFields state={state} />
        ) : (
          <div data-run-steady="1">
            <NumberRow
              label="Iterations"
              title="SIMPLE iteration count. Not seconds — this is a steady run (deltaT = 1)."
              value={state.settings.end_time}
              disabled={locked}
              onCommit={(v) => v != null && void saveRunSettings({ end_time: Math.max(1, Math.round(v)) })}
            />
            <NumberRow
              label="Write interval"
              title="Write a results folder every N iterations"
              value={state.settings.write_interval}
              disabled={locked}
              onCommit={(v) => v != null && void saveRunSettings({ write_interval: Math.max(1, Math.round(v)) })}
            />
          </div>
        )}
        <div className="sim-run-row">
          {state.start.visible ? (
            <button
              type="button"
              className="fp-btn fp-btn-primary"
              data-run-start="1"
              title={state.start.title}
              disabled={!state.start.enabled}
              onClick={() => {
                setNote('');
                void simStart(ids.scope).catch(report);
              }}
            >
              {state.start.label}
            </button>
          ) : null}
          {state.stop.visible ? (
            <button
              type="button"
              className="fp-btn"
              data-run-stop="1"
              title={state.stop.title}
              onClick={() => void simStop().catch(report)}
            >
              {state.stop.label}
            </button>
          ) : null}
        </div>
        {state.reason ? (
          <div className="mat-assign-hint sim-run-hint" data-run-reason="1">
            <span className="sim-run-hint-msg">{state.reason.text}</span>
            {state.reason.fix_label ? (
              <button type="button" className="sim-fix-go" data-setup-fix="1" onClick={() => runSetupFix()}>
                {state.reason.fix_label}
              </button>
            ) : null}
          </div>
        ) : null}
        {note ? (
          <p className="mat-assign-hint" role="alert">
            {note}
          </p>
        ) : null}
        <RunStatus state={state} ids={ids} />
      </div>
      <div className="mat-panel-foot">
        {state.can_delete ? (
          <button type="button" className="mat-clear-link" title="Delete run" onClick={() => void deleteRun().catch(report)}>
            Delete
          </button>
        ) : (
          <span />
        )}
        <button type="button" className="js-btn tree-panel-done" onClick={() => dispatchPanelDone()}>
          Done
        </button>
      </div>
    </div>
  );
}
