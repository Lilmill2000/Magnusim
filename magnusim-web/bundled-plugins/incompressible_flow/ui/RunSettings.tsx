/**
 * The run panel's settings: a steady run's iterations and write interval, or a
 * transient run's simulation time, result frames, the calculated time step
 * (hint) and the advanced PIMPLE settings; for either, "Stop when a monitor
 * settles" (settle.ts). Locked once the run has started.
 */
import { useEffect, useState } from 'react';
import type { RunSettingsProps } from '../../../src/plugin-api';
import type { RunState } from '../../../src/panels/legacyBridge';
import { host } from './host';
import {
  choiceOf,
  defaultWindow,
  readSettle,
  settleChoices,
  settleNumber,
  settleProblem,
  settleSentence,
  type SettleSetting,
} from './settle';
import { frameInterval, normalizeTransient, transientHint, type TransientSettings } from './transient';

function NumberRow({
  label,
  title,
  value,
  disabled,
  unit,
  placeholder,
  field,
  onCommit,
}: {
  label: string;
  title?: string;
  value: number | null | undefined;
  disabled: boolean;
  unit?: string;
  placeholder?: string;
  /** Marks the row (data-run-field) for tests; rows of the v0.2.0 panel carry none. */
  field?: string;
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
    <div className="mat-row" data-run-field={field}>
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

/**
 * "Stop when a monitor settles" (API 1.4): end the run once a monitor's quantity
 * stays within an amount of its running average over a window. Only quantities
 * OpenFOAM can read while it solves are offered. Marked (data-run-settle): the
 * v0.2.0 panel had no such rows (h10 parity).
 */
function SettleStop({
  run,
  saveSettle,
  frame,
}: {
  run: RunState;
  saveSettle: RunSettingsProps['saveSettle'];
  /** A transient run's result-frame interval in seconds (0: steady or unknown). */
  frame: number;
}) {
  const transient = run.transient;
  const choices = settleChoices(run.monitors);
  const settle = readSettle(run.settle);
  const chosen = choiceOf(choices, settle);
  const save = (next: SettleSetting | null) => void saveSettle?.(next ? { ...next } : null);
  const windowUnit = transient ? 's' : 'iterations';
  // Never shown as active when it is not: a started run says what its plan found,
  // a draft what the panel can tell (the same checks, settle.py check_settle).
  const problem = settleProblem(settle, choices, run.monitors, run.study);
  if (run.locked) {
    if (!settle) return null;
    const planned = run.stop_when || null;
    const error = planned ? planned.error || '' : problem;
    return (
      <div data-run-settle="1">
        <div className="mat-row">
          <span className="mat-k">Stop when settled</span>
          {run.stops_off ? (
            <span className="mat-v" data-run-settle-off="1">
              Off for this part: the run continued past its convergence.
            </span>
          ) : error ? (
            <span className="mat-v sim-tr-warn" data-run-settle-unused="1">
              {`Stop when settled was not used: ${error}.`}
            </span>
          ) : (
            <span className="mat-v">
              {planned && planned.text
                ? planned.text.replace(/ stayed within /, ' stays within ')
                : chosen
                  ? settleSentence(chosen, settle, transient)
                  : ''}
            </span>
          )}
        </div>
      </div>
    );
  }
  const index = chosen ? choices.indexOf(chosen) : settle ? -2 : -1;
  let hint = '';
  if (settle && chosen && !problem) {
    hint =
      `Ends the run once ${settleSentence(chosen, settle, transient)}.` +
      (!transient
        ? ' The residual targets still end it too.'
        : chosen.kind !== 'forces' && frame > 0
          ? ` A window shorter than ${settleNumber((10 * frame) / 50)} s (10 monitor samples) is made that long.`
          : '');
  } else if (!choices.length) {
    hint = 'Add a monitor (Monitors +) or an inlet or outlet to stop on.';
  }
  // A stop that would not be written says so, and how to fix it.
  let warn = problem ? `Not used as set: ${problem}.` : '';
  if (problem && chosen && chosen.kind === 'forces') warn += " Set it in the study's Reference values.";
  else if (problem) warn += ' Pick another, or Off.';
  else if (chosen && chosen.kind === 'forces' && !run.study) {
    warn = `Force coefficients need the study's reference area${chosen.quantity.key === 'Cm' ? ' and length' : ''} (Reference values).`;
  }
  return (
    <div data-run-settle="1">
      <div className="mat-row">
        <span
          className="mat-k"
          title="End the run once a monitor's value stops changing: it stays within the amount below of its average over the window. Only values OpenFOAM can read while it solves are listed: area averages, boundary pressure, velocity and flow, force coefficients, and point probes (the average of their points)."
        >
          Stop when settled
        </span>
        <select
          className="bc-select"
          aria-label="Stop when a monitor settles"
          value={index >= 0 ? String(index) : index === -2 ? 'gone' : ''}
          disabled={!choices.length && !settle}
          onChange={(e) => {
            const c = e.target.value === '' ? null : choices[Number(e.target.value)];
            if (!c) return save(null);
            const keep = settle && chosen && chosen.quantity.unit === c.quantity.unit;
            save({
              source: c.source,
              id: c.id,
              quantity: c.quantity.key,
              tolerance: keep && settle ? settle.tolerance : c.quantity.tolerance,
              window: settle ? settle.window : defaultWindow(transient, frame),
            });
          }}
        >
          <option value="">Off</option>
          {index === -2 ? (
            <option value="gone" disabled>
              Not available (not used)
            </option>
          ) : null}
          {choices.map((c, i) => (
            <option key={`${c.source}:${c.id}:${c.quantity.key}`} value={String(i)}>
              {c.label}
            </option>
          ))}
        </select>
      </div>
      {settle && chosen ? (
        <>
          <NumberRow
            label="Within"
            title="How close the value must stay to its average over the window (in its own unit, not a percentage)."
            value={settle.tolerance}
            unit={chosen.quantity.unit || undefined}
            field="settle_tolerance"
            disabled={false}
            onCommit={(v) => v != null && v > 0 && save({ ...settle, tolerance: v })}
          />
          <NumberRow
            label="Over the last"
            title={transient ? 'The averaging window, in seconds of simulated time.' : 'The averaging window, in iterations.'}
            value={settle.window}
            unit={windowUnit}
            field="settle_window"
            disabled={false}
            onCommit={(v) => v != null && v > 0 && save({ ...settle, window: transient ? v : Math.max(1, Math.round(v)) })}
          />
        </>
      ) : null}
      {hint || warn ? (
        <p className="mat-assign-hint" data-run-settle-hint="1">
          {hint}
          {warn ? <span className="sim-tr-warn"> {warn}</span> : null}
        </p>
      ) : null}
    </div>
  );
}

function TransientFields({
  run,
  defaults,
  saveTransient,
  saveSettle,
}: {
  run: RunState;
  defaults: Record<string, unknown>;
  saveTransient: RunSettingsProps['saveTransient'];
  saveSettle: RunSettingsProps['saveSettle'];
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
        field="average_from"
        disabled={locked}
        onCommit={(v) => v != null && save({ average_from: v })}
      />
      <p className="mat-assign-hint sim-tr-hint" data-run-transient-hint="1">
        {hint.text}
        {hint.warn ? <span className="sim-tr-warn"> {hint.warn}</span> : null}
      </p>
      <SettleStop run={run} saveSettle={saveSettle} frame={interval} />
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

export function RunSettings({ run, row, saveSteady, saveTransient, saveSettle }: RunSettingsProps) {
  const defaults = { ...(row?.run_defaults || {}) };
  if (run.transient) {
    return <TransientFields run={run} defaults={defaults} saveTransient={saveTransient} saveSettle={saveSettle} />;
  }
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
      <SettleStop run={run} saveSettle={saveSettle} frame={0} />
    </div>
  );
}
