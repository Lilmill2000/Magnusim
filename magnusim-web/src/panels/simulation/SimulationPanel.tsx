import { useEffect, useState } from 'react';
import type { RJSFSchema } from '@rjsf/utils';
import { analysisLabel } from '../../api/w17';
import type { RegistryRow } from '../../api/registry.gen';
import { SchemaForm } from '../../forms/SchemaForm';
import { useProjectStore } from '../../store/project';
import { dispatchPanelDone, type IslandProps } from '../../islands';
import {
  deleteStudy,
  saveStudy,
  setStudyTimeDependency,
  studyStateNow,
  subscribeStudyState,
  type StudyState,
  type TimeDependency,
} from '../legacyBridge';
import { PanelChrome } from '../PanelChrome';
import { RenameTitle } from '../RenameTitle';
import { mergeObjectSchemas, pickSchemaValues, scopeIds, useRegistryReady } from '../scope';
import { requiredPluginMessage } from '../../app/RequiredPluginError';
import { analysisMissingText, defaultAnalysisKey, siblingKey } from '../../analysis';
import { openSetupWizard } from '../../wizard/controller';
import type { StudySettingsProps } from '../../plugin-api';
import { useSettingsSlot } from '../../plugin-api/slots';

/** Every enabled analysis. Disabled plugins are already absent from the registry list. */
export function visibleAnalyses(rows: RegistryRow[]): RegistryRow[] {
  return rows.filter((row) => String(row.key || '').trim());
}

function analysisRows(): RegistryRow[] {
  return visibleAnalyses((useProjectStore.getState().registry?.analysis || []) as RegistryRow[]);
}

export function SimulationHub(props: IslandProps) {
  const registry = useRegistryReady();
  const rows = visibleAnalyses((registry?.analysis || []) as RegistryRow[]);
  const missing = registry?.required_missing || [];
  const blocked = missing.length ? requiredPluginMessage(missing[0]) : '';

  const [selected, setSelected] = useState('');
  const creating = props.panelId === 'cs-type-list';

  function pick(row: RegistryRow) {
    setSelected(row.key);
    // Create Simulation: the detail title and Steady/Transient toggle follow the picked analysis.
    if (creating) window.__CFD_CREATE_PICK_ANALYSIS__?.(row);
  }

  useEffect(() => {
    if (selected || !rows.length) return;
    pick(rows.find((row) => row.key === defaultAnalysisKey()) || rows[0]);
  }, [rows, selected]);

  // Without its required plugin the app cannot create a study: Create stays off and says why.
  useEffect(() => {
    if (creating) window.__CFD_CREATE_BLOCK__?.(blocked);
  }, [creating, blocked]);

  useEffect(() => {
    if (!creating) return undefined;
    // The Steady/Transient toggle picks the picked analysis's sibling of that
    // time dependency (its family's), never another family's analysis.
    const onTimeDep = (ev: Event) => {
      const value = String((ev as CustomEvent<{ value?: string }>).detail?.value || '');
      const want = /transient/i.test(value) ? 'transient' : 'steady';
      const td = (row: RegistryRow) => (/transient/i.test(String(row.time_dependency || '')) ? 'transient' : 'steady');
      const current = rows.find((row) => row.key === selected);
      if (current && td(current) === want) return;
      const key = siblingKey(current ? current.key : '', want);
      const hit = rows.find((row) => row.key === key && td(row) === want);
      if (hit) pick(hit);
      // No such sibling: the toggle goes back to what the picked analysis solves.
      else if (current) window.__CFD_CREATE_PICK_ANALYSIS__?.(current);
    };
    window.addEventListener('cfd:create-time-dep', onTimeDep);
    return () => window.removeEventListener('cfd:create-time-dep', onTimeDep);
  }, [rows, selected, creating]);

  const list = blocked ? (
    <p className="mat-assign-hint required-plugin-picker" role="alert" data-required-plugin-error="picker">
      {blocked}
    </p>
  ) : (
    <ul className="ml-list" data-scope={props.scope || ''}>
      {rows.map((row) => (
        <li key={row.key}>
          <button
            type="button"
            className={selected === row.key ? 'ml-type is-selected' : 'ml-type'}
            data-analysis-key={row.key}
            onClick={() => pick(row)}
          >
            <span className="ml-type-name">{analysisLabel(row)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
  if (props.panelId === 'cs-type-list') return list;
  return <PanelChrome title="Simulation">{list}</PanelChrome>;
}

/**
 * The registered analysis a study solves with (its family at its time
 * dependency; blank or a pre-key name is the default analysis), or undefined
 * when it is not installed: never another analysis's row.
 */
function rowFor(analysisType: unknown, timeDependency: unknown, rows: RegistryRow[]): RegistryRow | undefined {
  const key = siblingKey(String(analysisType || ''), timeDependency);
  return key ? rows.find((row) => row.key === key) : undefined;
}

function useStudyState(): StudyState | null {
  const [state, setState] = useState<StudyState | null>(() => studyStateNow());
  useEffect(() => subscribeStudyState(setState), []);
  return state;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** An analysis without its own study settings: its settings, time dependency and numerics, from its schemas. */
export function GenericStudySettings({ study, row, rows, save, setTimeDependency }: StudySettingsProps) {
  const record = (study.record || {}) as Record<string, unknown>;
  const transient = study.time_dependency === 'Transient';
  const settingsSchema = mergeObjectSchemas([(row?.schema || row?.settings_schema) as RJSFSchema | undefined]);
  const numericsSchema = mergeObjectSchemas([row?.numerics_schema as RJSFSchema | undefined]);
  const hasSettings = Object.keys(settingsSchema.properties || {}).length > 0;
  // The analysis's schema decides (its transient sibling may have numerics of its own).
  const hasNumerics = Object.keys(numericsSchema.properties || {}).length > 0;
  const family = row?.family?.key;
  const hasSibling =
    !!family && rows.filter((r) => r.family?.key === family).some((r) => r.time_dependency !== row?.time_dependency);
  const algorithm = study.algorithm || row?.algorithm_label || '';
  const commit = (schema: RJSFSchema) => (values: Record<string, unknown>) => {
    const patch = pickSchemaValues(values, schema);
    const changed = Object.fromEntries(Object.entries(patch).filter(([k, v]) => record[k] !== v));
    if (Object.keys(changed).length) void save(changed);
  };
  return (
    <>
      {hasSettings ? (
        <SchemaForm
          className="schema-form sim-study-settings"
          schema={settingsSchema}
          formData={pickSchemaValues(record, settingsSchema)}
          hideFooter
          onCommit={commit(settingsSchema)}
        />
      ) : null}
      {hasSibling ? (
        <div className="sim-def-row">
          <span className="sim-def-k">Time dependency</span>
          <span className="sim-def-v">
            <select
              className="bc-select sim-def-select"
              aria-label="Time dependency"
              value={transient ? 'Transient' : 'Steady-state'}
              onChange={(e) => void setTimeDependency(e.target.value as TimeDependency)}
            >
              <option value="Steady-state">Steady-state</option>
              <option value="Transient">Transient</option>
            </select>
          </span>
        </div>
      ) : null}
      {algorithm ? (
        <div className="sim-def-row">
          <span className="sim-def-k">Algorithm</span>
          <span className="sim-def-v" data-study-algorithm="1">
            {algorithm}
          </span>
        </div>
      ) : null}
      {hasNumerics ? (
        <SchemaForm
          className="schema-form sim-study-numerics"
          schema={numericsSchema}
          formData={pickSchemaValues(record, numericsSchema)}
          hideFooter
          onCommit={commit(numericsSchema)}
        />
      ) : null}
    </>
  );
}

/**
 * Study panel: the core's chrome (title and rename, Analysis, Done/Delete, a
 * failed save's message) around the analysis's own settings (its plugin's
 * study-settings component, else the generic form from its schemas).
 */
export function SimulationDefaults(_props: IslandProps) {
  const registry = useRegistryReady();
  const study = useStudyState();
  const [error, setError] = useState('');
  const rows = visibleAnalyses((registry?.analysis || []) as RegistryRow[]);
  const row = rowFor(study?.analysis_type, study?.time_dependency, rows);
  const { Component: Settings, waiting } = useSettingsSlot<StudySettingsProps>('study-settings', row);
  // Its analysis is not installed (its plugin is off or did not load): say so
  // instead of a settings form.
  const missing = study?.has_study && registry && !row ? analysisMissingText('', 'study') : '';

  async function save(patch: Record<string, unknown>) {
    setError('');
    try {
      await saveStudy(patch);
    } catch (e) {
      setError(errorText(e));
    }
  }

  async function setTimeDependency(value: TimeDependency) {
    setError('');
    try {
      await setStudyTimeDependency(value);
    } catch (e) {
      setError(errorText(e));
    }
  }

  if (!study?.has_study) {
    return (
      <PanelChrome title="Simulation">
        <p className="mat-assign-hint">Create a simulation to set its physics.</p>
      </PanelChrome>
    );
  }

  const settingsProps: StudySettingsProps = { study, row, rows, save, setTimeDependency };
  return (
    <div className="sim-study-panel" data-study-panel="1">
      <RenameTitle name={study.name || 'Simulation'} label="simulation" onRename={(next) => save({ name: next })} />
      <div className="sim-def-row">
        <span className="sim-def-k">Analysis</span>
        <span className="sim-def-v" data-study-analysis="1">
          {study.analysis || (row ? analysisLabel(row) : '')}
        </span>
      </div>
      {missing ? (
        <div className="mat-assign-hint sim-run-hint" data-study-missing="1">
          <span className="sim-run-hint-msg">{missing}</span>
          <button
            type="button"
            className="sim-fix-go"
            onClick={() => openSetupWizard({ required: false, step: 'plugins' })}
          >
            Open Settings → Plugins
          </button>
        </div>
      ) : waiting ? null : Settings ? (
        <Settings {...settingsProps} />
      ) : (
        <GenericStudySettings {...settingsProps} />
      )}
      {error ? (
        <p className="mat-assign-hint" data-run-reason="1" role="alert">
          {error}
        </p>
      ) : null}
      <div className="mat-panel-foot">
        <div className="mesh-foot-left">
          <button
            type="button"
            className="mat-clear-link"
            title="Delete this simulation"
            onClick={() => {
              deleteStudy().catch((e) => setError(errorText(e)));
            }}
          >
            Delete
          </button>
        </div>
        <button type="button" className="js-btn tree-panel-done" onClick={() => dispatchPanelDone()}>
          Done
        </button>
      </div>
    </div>
  );
}

export function simulationSaveBody(
  props: IslandProps,
  values: Record<string, unknown>,
): Record<string, unknown> {
  const ids = scopeIds(props);
  const rows = analysisRows();
  const row = rowFor(values.analysis_type, values.time_dependency, rows);
  const schema = mergeObjectSchemas([
    (row?.schema || row?.settings_schema) as RJSFSchema | undefined,
    row?.numerics_schema as RJSFSchema | undefined,
  ]);
  return {
    ...pickSchemaValues(values, schema),
    project_id: ids.project_id,
    simulation_id: ids.simulation_id,
    geometry_id: ids.geometry_id || undefined,
    scope: ids.scope,
  };
}
