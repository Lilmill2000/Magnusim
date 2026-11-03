/**
 * The run panel's settings of a Heat Transfer run: a steady run's iterations and
 * write interval, or a transient run's simulation time, result frames and time
 * step (its analysis's control schema), and "Stop when a monitor settles" on
 * one of the run's Heat Transfer monitors (heat_transfer/settle.py writes it).
 * Locked while the run solves or stops. A finished run's solve fields stay usable
 * (run.edit 'new_run': the core asks, and the change goes to a new run); its stop
 * is shown read-only. A stopped run's Max Courant, outer and pressure correctors and
 * Max Δt may wait for its Continue (run.continue_pending): each says "Takes effect when
 * you Continue".
 */
import type { ReactNode } from 'react';
import type { RJSFSchema } from '@rjsf/utils';
import type { RunSettingsProps } from '../../../src/plugin-api';
import type { RunSettleMonitor, RunState } from '../../../src/panels/legacyBridge';
import { host } from './host';
import { SOLID_MODEL, scopeProject, useStudyMaterials } from './materials';

export interface SettleQuantity {
  key: string;
  label: string;
  unit: string;
  tolerance: number;
}

export interface SettleSetting {
  source: 'monitor';
  id: string;
  quantity: string;
  tolerance: number;
  window: number;
}

export interface SettleChoice {
  id: string;
  name: string;
  kind: string;
  quantity: SettleQuantity;
  label: string;
  /** Why the stop could not watch it as placed ('' when it can). */
  problem: string;
}

/** Per monitor type (heat_transfer/settle.py QUANTITIES; keep the two in step). */
export const SETTLE_QUANTITIES: Record<string, readonly SettleQuantity[]> = {
  ht_wall_heat_flux: [{ key: 'Q', label: 'Heat flow', unit: 'W', tolerance: 0.01 }],
  ht_surface_temperature: [
    { key: 'T_avg', label: 'Average temperature', unit: 'K', tolerance: 0.01 },
    { key: 'T_max', label: 'Highest temperature', unit: 'K', tolerance: 0.01 },
  ],
  ht_thermocouple: [{ key: 'T_pt', label: 'Temperature (average of its points)', unit: 'K', tolerance: 0.01 }],
};

/** What keeps a monitor from stopping the run, or ''. */
export function monitorProblem(m: RunSettleMonitor): string {
  if (m.targets === 0) return `${m.name} is placed on nothing`;
  if (m.kind !== 'ht_thermocouple' && (m.targets || 0) > 1) {
    return `${m.name} is on ${m.targets} boundaries; the stop watches a monitor on one`;
  }
  return '';
}

/** Every quantity of the run's Heat Transfer monitors the run can stop on, in order. */
export function settleChoices(monitors: readonly RunSettleMonitor[] | undefined): SettleChoice[] {
  const out: SettleChoice[] = [];
  for (const m of monitors || []) {
    if (m.source !== 'monitor') continue;
    for (const q of SETTLE_QUANTITIES[m.kind] || []) {
      out.push({ id: m.id, name: m.name, kind: m.kind, quantity: q, label: `${m.name} · ${q.label}`, problem: monitorProblem(m) });
    }
  }
  return out;
}

export function readSettle(raw: unknown): SettleSetting | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const tolerance = Number(r.tolerance);
  const window = Number(r.window);
  if (!r.id || !r.quantity || !(tolerance > 0) || !(window > 0)) return null;
  return { source: 'monitor', id: String(r.id), quantity: String(r.quantity), tolerance, window };
}

export function settleNumber(x: number): string {
  return String(Number(x.toPrecision(6)));
}

/**
 * How a quantity's tolerance shows: a temperature difference in °C (metric: the same
 * number as K) or °F (imperial: 1.8 times), saved in K; anything else in its own unit.
 */
export function shownTolerance(q: SettleQuantity, imperial: boolean): { unit: string; factor: number } {
  if (q.unit === 'K') return imperial ? { unit: '°F', factor: 1.8 } : { unit: '°C', factor: 1 };
  return { unit: q.unit, factor: 1 };
}

/** "Heater flux · Heat flow stays within 0.01 W of its average over 50 iterations". */
export function settleSentence(c: SettleChoice, s: SettleSetting, transient: boolean, imperial = false): string {
  const span = transient ? `${settleNumber(s.window)} s` : `${Math.round(s.window)} iteration${Math.round(s.window) === 1 ? '' : 's'}`;
  const shown = shownTolerance(c.quantity, imperial);
  return `${c.label} stays within ${settleNumber(s.tolerance * shown.factor)} ${shown.unit} of its average over ${span}`;
}

function SettleStop({ run, saveSettle }: { run: RunState; saveSettle: RunSettingsProps['saveSettle'] }) {
  const transient = run.transient;
  const imperial = host().pluginUi.unitSystem() === 'imperial';
  // A conjugate heat transfer run (a solid body) never stops on its residuals.
  const materials = useStudyMaterials(scopeProject(host().scope), String((run.study && run.study.id) || ''));
  const cht = materials ? materials.some((m) => m.model === SOLID_MODEL) : null;
  const choices = settleChoices(run.monitors);
  const settle = readSettle(run.settle);
  const chosen = settle ? choices.find((c) => c.id === settle.id && c.quantity.key === settle.quantity) || null : null;
  const save = (next: SettleSetting | null) => void saveSettle?.(next ? { ...next } : null);
  if (run.locked) {
    if (!settle) return null;
    const planned = run.stop_when || null;
    const error = planned ? planned.error || '' : chosen ? chosen.problem : 'the monitor it watches was deleted';
    return (
      <div data-run-settle="1">
        <div className="mat-row">
          <span className="mat-k">Stop when settled</span>
          {run.stops_off ? (
            <span className="mat-v" data-run-settle-off="1">
              Off for this part: the run continued past its convergence.
            </span>
          ) : error ? (
            <span className="mat-v sim-tr-warn" data-run-settle-unused="1">{`Stop when settled was not used: ${error}.`}</span>
          ) : (
            <span className="mat-v">
              {planned && planned.text ? planned.text.replace(/ stayed within /, ' stays within ') : chosen ? settleSentence(chosen, settle, transient, imperial) : ''}
            </span>
          )}
        </div>
      </div>
    );
  }
  const index = chosen ? choices.indexOf(chosen) : settle ? -2 : -1;
  const frame = transient ? Number(run.transient_settings?.end_time) / Math.max(1, Number(run.transient_settings?.write_count) || 1) : 0;
  const defaultWindow = transient ? (frame > 0 ? frame : 1) : 50;
  let hint = '';
  if (settle && chosen && !chosen.problem) {
    hint = `Ends the run once ${settleSentence(chosen, settle, transient, imperial)}.` + (transient || cht !== false ? '' : ' The residual target still ends it too.');
  } else if (!choices.length) {
    hint = 'Add a Wall heat flux, Surface temperature or Thermocouple monitor (Monitors +) to stop on.';
  }
  const warn = settle && chosen && chosen.problem ? `Not used as set: ${chosen.problem}. Pick another, or Off.` : '';
  const numberRow = (label: string, value: number, unit: string, field: string, title: string, onCommit: (v: number) => void) => (
    <div className="mat-row" data-run-field={field}>
      <span className="mat-k" title={title}>
        {label}
      </span>
      <span className="bc-value-row">
        <input
          className="bc-input"
          type="number"
          step="any"
          aria-label={label}
          defaultValue={value}
          key={`${field}:${value}`}
          onBlur={(e) => {
            const n = Number(e.target.value);
            if (Number.isFinite(n) && n > 0 && n !== value) onCommit(n);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          }}
        />
        <span className="bc-unit-label">{unit}</span>
      </span>
    </div>
  );
  return (
    <div data-run-settle="1">
      <div className="mat-row">
        <span
          className="mat-k"
          title="End the run once a monitor's value stops changing: it stays within the amount below of its average over the window."
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
              source: 'monitor',
              id: c.id,
              quantity: c.quantity.key,
              tolerance: keep && settle ? settle.tolerance : c.quantity.tolerance,
              window: settle ? settle.window : defaultWindow,
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
            <option key={`${c.id}:${c.quantity.key}`} value={String(i)}>
              {c.label}
            </option>
          ))}
        </select>
      </div>
      {settle && chosen ? (
        <>
          {(() => {
            // A temperature's tolerance is a difference: in °C the same number as K, in °F 1.8 times.
            const shown = shownTolerance(chosen.quantity, imperial);
            return numberRow(
              'Within',
              Number((settle.tolerance * shown.factor).toPrecision(6)),
              shown.unit,
              'settle_tolerance',
              'How close the value must stay to its average over the window.',
              (v) => save({ ...settle, tolerance: Number((v / shown.factor).toPrecision(12)) }),
            );
          })()}
          {numberRow('Over the last', settle.window, transient ? 's' : 'iterations', 'settle_window', 'The averaging window.', (v) =>
            save({ ...settle, window: transient ? v : Math.max(1, Math.round(v)) }),
          )}
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

/** "Takes effect when you Continue" under each setting that waits for the stopped run's Continue. */
export function continueNotes(run: RunState): Record<string, ReactNode> | undefined {
  const keys = (run.continue_pending || []).filter((k) => k.startsWith('transient.')).map((k) => k.slice('transient.'.length));
  if (!keys.length) return undefined;
  return Object.fromEntries(
    keys.map((k) => [
      k,
      <span key={k} data-run-takes-effect={k}>
        Takes effect when you Continue
      </span>,
    ]),
  );
}

export function RunSettings({ run, row, saveSteady, saveTransient, saveSettle }: RunSettingsProps) {
  const { SchemaForm, schema: tools } = host().pluginUi;
  const schema = tools.mergeObjectSchemas([row?.control_schema as RJSFSchema | undefined]);
  const props = (schema.properties || {}) as Record<string, { title?: string; 'x-cfddesk'?: { unit?: string } }>;
  const values: Record<string, unknown> = run.transient
    ? { ...run.transient_settings }
    : { end_time: run.settings.end_time, write_interval: run.settings.write_interval };
  return (
    <div data-run-settings="heat_transfer">
      {run.locked && run.edit !== 'new_run' ? (
        Object.entries(props).map(([key, prop]) => (
          <div className="mat-row" key={key}>
            <span className="mat-k">{prop.title || key}</span>
            <span className="mat-v">
              {values[key] == null ? 'calculated' : `${String(values[key])}${prop['x-cfddesk']?.unit ? ` ${prop['x-cfddesk'].unit}` : ''}`}
            </span>
          </div>
        ))
      ) : (
        <SchemaForm
          className="schema-form run-settings"
          schema={schema}
          formData={tools.pickSchemaValues(values, schema)}
          hideFooter
          // A change of a run that ended asks first (the core's question): never in the middle of typing.
          commitOnBlur={run.edit === 'overwrites' || run.edit === 'continues' || run.edit === 'new_run'}
          fieldNotes={continueNotes(run)}
          onCommit={(next) => {
            const patch = tools.pickSchemaValues(next, schema);
            if (run.transient) void saveTransient({ ...run.transient_settings, ...patch });
            else void saveSteady(patch as { end_time?: number; write_interval?: number });
          }}
        />
      )}
      <SettleStop run={run} saveSettle={saveSettle} />
    </div>
  );
}
