import { useEffect, useState } from 'react';
import type { RJSFSchema } from '@rjsf/utils';
import type { RegistryRow } from '../../api/registry.gen';
import { SchemaForm } from '../../forms/SchemaForm';
import { dispatchPanelDone, type IslandProps } from '../../islands';
import type { RunSettingsProps } from '../../plugin-api';
import { useSettingsSlot } from '../../plugin-api/slots';
import {
  copyRunFrom,
  deleteRun,
  renameRun,
  runCopyPick,
  runSetupFix,
  runStateNow,
  saveRunCores,
  saveRunSettings,
  saveRunSettle,
  saveTransientSettings,
  simStart,
  simStop,
  subscribeRunState,
  type RunState,
} from '../legacyBridge';
import { mergeObjectSchemas, pickSchemaValues, scopeIds, useRegistryReady } from '../scope';
import { ResidualPlot } from './ResidualPlot';
import { RunCores, runCanUseCores, useRankCap } from './RunCores';
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

/**
 * An analysis without its own run settings: its run model's fields
 * (control_schema), read-only once the run has started.
 */
export function GenericRunSettings({ run, row, saveSteady, saveTransient }: RunSettingsProps) {
  const schema = mergeObjectSchemas([row?.control_schema as RJSFSchema | undefined]);
  const props = (schema.properties || {}) as Record<string, { title?: string }>;
  const values: Record<string, unknown> = run.transient
    ? { ...run.transient_settings }
    : { end_time: run.settings.end_time, write_interval: run.settings.write_interval };
  if (!Object.keys(props).length) return null;
  if (run.locked) {
    return (
      <div data-run-settings="generic">
        {Object.entries(props).map(([key, prop]) => (
          <div className="mat-row" key={key}>
            <span className="mat-k">{prop.title || key}</span>
            <span className="mat-v">{values[key] == null ? 'auto' : String(values[key])}</span>
          </div>
        ))}
      </div>
    );
  }
  return (
    <div data-run-settings="generic">
      <SchemaForm
        className="schema-form run-settings"
        schema={schema}
        formData={pickSchemaValues(values, schema)}
        hideFooter
        onCommit={(next) => {
          const patch = pickSchemaValues(next, schema);
          if (run.transient) void saveTransient({ ...run.transient_settings, ...patch });
          else void saveSteady(patch as { end_time?: number; write_interval?: number });
        }}
      />
    </div>
  );
}

function RunStatus({
  state,
  ids,
  row,
}: {
  state: RunState;
  ids: { project_id: string; simulation_id: string };
  row: RegistryRow | undefined;
}) {
  const p = state.progress;
  if (!p.show) return null;
  return (
    <div className="sim-finished" data-run-status={state.status}>
      <div className="mat-k">{p.title}</div>
      <div className="mesh-finished-line" data-run-line="1">
        {p.line}
      </div>
      {p.converged ? (
        // How it ended (API 1.4). Marked: the v0.2.0 panel (h10 parity) had no such line.
        <p className={'run-converged' + (p.converged.kind === 'no' ? ' is-not' : '')} data-run-converged={p.converged.kind}>
          {p.converged.text}
        </p>
      ) : null}
      {p.elapsed ? <div className="mesh-elapsed">{p.elapsed}</div> : null}
      {p.eta ? <div className="sim-eta">{p.eta}</div> : null}
      <ResidualPlot
        rows={p.residuals}
        endTime={p.end}
        seconds={(row?.x_axis || (state.transient ? 'seconds' : 'iterations')) === 'seconds'}
        series={row?.residual_series || []}
      />
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
  const registry = useRegistryReady();
  const row = ((registry?.analysis || []) as RegistryRow[]).find((r) => r.key === state?.analysis_key);
  const { Component: Settings, waiting } = useSettingsSlot<RunSettingsProps>('run-settings', row);
  const rankCap = useRankCap();
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
  const report = (e: unknown) => setNote(e instanceof Error ? e.message : String(e));
  const settingsProps: RunSettingsProps = {
    run: state,
    row,
    saveSteady: (patch) => saveRunSettings(patch).then(() => undefined, report),
    saveTransient: (settings) => saveTransientSettings(settings).then(() => undefined, report),
    saveSettle: (settle) => saveRunSettle(settle).then(() => undefined, report),
  };
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
        {waiting ? null : Settings ? <Settings {...settingsProps} /> : <GenericRunSettings {...settingsProps} />}
        {runCanUseCores(state, registry, row) ? (
          <RunCores
            cores={state.cores ?? null}
            locked={state.locked}
            cap={rankCap}
            onSave={(cores) => void saveRunCores(cores).catch(report)}
          />
        ) : null}
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
        {state.older_geometry ? (
          <p className="mat-assign-hint" data-run-older="1">
            {state.older_geometry}
          </p>
        ) : null}
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
        <RunStatus state={state} ids={ids} row={row} />
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
