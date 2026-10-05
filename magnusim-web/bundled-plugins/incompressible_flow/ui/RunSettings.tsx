/**
 * The run panel's settings: a steady run's iterations and write interval, or a
 * transient run's simulation time, result frames, the calculated time step
 * (hint) and the advanced PIMPLE settings. Locked once the run has started.
 */
import { useEffect, useState } from 'react';
import type { RunSettingsProps } from '../../../src/plugin-api';
import type { RunState } from '../../../src/panels/legacyBridge';
import { host } from './host';
import { frameInterval, normalizeTransient, transientHint, type TransientSettings } from './transient';

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
  const { SciNumberInput } = host().pluginUi;
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
    <span
      onBlur={(e) => {
        const input = e.target as HTMLInputElement;
        if (input.value.trim() === '') onCommit(null);
      }}
    >
      <SciNumberInput value={value} label={label} disabled={disabled} onCommit={(n) => onCommit(n > 0 ? n : null)} />
    </span>
  );
}

function TransientFields({
  run,
  defaults,
  saveTransient,
}: {
  run: RunState;
  defaults: Record<string, unknown>;
  saveTransient: RunSettingsProps['saveTransient'];
}) {
  const t = normalizeTransient(run.transient_settings, {}, defaults);
  const locked = run.locked;
  const fixed = t.time_step_mode === 'fixed';
  const save = (patch: Partial<TransientSettings>) =>
    void saveTransient({ ...normalizeTransient({ ...t, ...patch }, t, defaults) });
  const hint = transientHint(t, run.run_preview);
  const interval = frameInterval(t);
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
      <NumberRow
        label="Average from"
        title="Time the Mean velocity and Mean pressure results start averaging from. 0 averages from the start; a later time leaves out the start-up. Frames saved before it hold no averages."
        value={t.average_from}
        unit="s"
        disabled={locked}
        onCommit={(v) => v != null && save({ average_from: v })}
      />
      <p className="mat-assign-hint sim-tr-hint" data-run-transient-hint="1">
        {hint.text}
        {hint.warn ? <span className="sim-tr-warn"> {hint.warn}</span> : null}
      </p>
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
                placeholder={interval > 0 ? String(Number(interval.toPrecision(6))) : 'auto'}
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
          <button
            type="button"
            className="mat-clear-link sim-tr-reset"
            onClick={() =>
              void saveTransient({
                ...normalizeTransient(
                  { ...defaults, end_time: t.end_time, write_count: t.write_count, average_from: t.average_from },
                  t,
                  defaults,
                ),
              })
            }
          >
            Reset advanced to defaults
          </button>
        ) : null}
      </details>
    </div>
  );
}

export function RunSettings({ run, row, saveSteady, saveTransient }: RunSettingsProps) {
  const defaults = { ...(row?.run_defaults || {}) };
  if (run.transient) return <TransientFields run={run} defaults={defaults} saveTransient={saveTransient} />;
  return (
    <div data-run-steady="1">
      <NumberRow
        label="Iterations"
        title="SIMPLE iteration count. Not seconds — this is a steady run (deltaT = 1)."
        value={run.settings.end_time}
        disabled={run.locked}
        onCommit={(v) => v != null && void saveSteady({ end_time: Math.max(1, Math.round(v)) })}
      />
      <NumberRow
        label="Write interval"
        title="Write a results folder every N iterations"
        value={run.settings.write_interval}
        disabled={run.locked}
        onCommit={(v) => v != null && void saveSteady({ write_interval: Math.max(1, Math.round(v)) })}
      />
    </div>
  );
}
