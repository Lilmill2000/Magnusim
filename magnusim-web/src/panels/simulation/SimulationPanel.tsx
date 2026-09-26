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

  const [selected, setSelected] = useState('');
  const creating = props.panelId === 'cs-type-list';

  function pick(row: RegistryRow) {
    setSelected(row.key);
    // Create Simulation: the detail title and Steady/Transient toggle follow the picked analysis.
    if (creating) window.__CFD_CREATE_PICK_ANALYSIS__?.(row);
  }

  useEffect(() => {
    if (selected || !rows.length) return;
    pick(rows.find((row) => row.key === 'incompressible_steady') || rows[0]);
  }, [rows, selected]);

  useEffect(() => {
    if (!creating) return undefined;
    // The Steady/Transient toggle picks the analysis with that time dependency.
    const onTimeDep = (ev: Event) => {
      const value = String((ev as CustomEvent<{ value?: string }>).detail?.value || '');
      const want = /transient/i.test(value) ? 'transient' : 'steady';
      const current = rows.find((row) => row.key === selected);
      if (current && String(current.time_dependency || 'steady') === want) return;
      const hit = rows.find((row) => String(row.time_dependency || 'steady') === want);
      if (hit) pick(hit);
    };
    window.addEventListener('cfd:create-time-dep', onTimeDep);
    return () => window.removeEventListener('cfd:create-time-dep', onTimeDep);
  }, [rows, selected, creating]);

  const list = (
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

function rowFor(key: string | undefined, rows: RegistryRow[]): RegistryRow | undefined {
  if (key) {
    const hit = rows.find((row) => row.key === key);
    if (hit) return hit;
  }
  return rows.find((row) => row.key === 'incompressible_steady') || rows[0];
}

const TURBULENCE_ALIASES: Record<string, string> = {
  laminar: 'laminar',
  kepsilon: 'kEpsilon',
  komegasst: 'kOmegaSST',
  sst: 'kOmegaSST',
  lrr: 'LRR',
  ssg: 'SSG',
};

/** Model key from a study record. Created studies store "k-omega SST" as display text. */
export function turbulenceKey(record: Record<string, unknown> | undefined): string | undefined {
  const defaults = (record?.defaults || {}) as Record<string, unknown>;
  for (const raw of [record?.turbulence_model, record?.turbulence_model_key, defaults.turbulence_model]) {
    const key = TURBULENCE_ALIASES[String(raw || '').toLowerCase().replace(/[^a-z]/g, '')];
    if (key) return key;
  }
  return undefined;
}

function useStudyState(): StudyState | null {
  const [state, setState] = useState<StudyState | null>(() => studyStateNow());
  useEffect(() => subscribeStudyState(setState), []);
  return state;
}

const TIME_HINT =
  'Steady-state solves for the converged flow with simpleFoam. Transient marches through real time with pimpleFoam and writes frames you can animate.';

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Reynolds-stress models solve with Relaxation U 0.5 unless the study sets one (study_physics.default_relax_u). */
export const RSM_RELAX_U = 0.5;

export function numericsData(
  record: Record<string, unknown>,
  schema: RJSFSchema,
  turbKey: string | null | undefined,
): Record<string, unknown> {
  const data = pickSchemaValues(record, schema);
  const hasRelax = typeof data.relax_u === 'number' && Number.isFinite(data.relax_u);
  if (!hasRelax && (turbKey === 'LRR' || turbKey === 'SSG') && schema.properties && 'relax_u' in schema.properties) {
    data.relax_u = RSM_RELAX_U;
  }
  return data;
}

/**
 * Study panel: the V0.1.0 rows (title, Analysis, Turbulence model, Time dependency,
 * Algorithm, note) plus the steady SIMPLE numerics. Every value here reaches the
 * written case (cfddesk.project.study_physics).
 */
export function SimulationDefaults(_props: IslandProps) {
  const registry = useRegistryReady();
  const study = useStudyState();
  const [error, setError] = useState('');
  const rows = visibleAnalyses((registry?.analysis || []) as RegistryRow[]);
  const record = (study?.record || {}) as Record<string, unknown>;
  const row = rowFor(study?.analysis_type, rows);
  const transient = study?.time_dependency === 'Transient';
  const settingsSchema = mergeObjectSchemas([(row?.schema || row?.settings_schema) as RJSFSchema | undefined]);
  const numericsSchema = mergeObjectSchemas([row?.numerics_schema as RJSFSchema | undefined]);
  const turbKey = turbulenceKey(record);
  const settingsData = {
    ...pickSchemaValues(record, settingsSchema),
    ...(turbKey ? { turbulence_model: turbKey } : {}),
  };
  const hasSettings = Object.keys(settingsSchema.properties || {}).length > 0;
  const hasNumerics = !transient && Object.keys(numericsSchema.properties || {}).length > 0;

  async function save(patch: Record<string, unknown>) {
    setError('');
    try {
      await saveStudy(patch);
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

  return (
    <div className="sim-study-panel" data-study-panel="1">
      <RenameTitle name={study.name || 'Simulation'} label="simulation" onRename={(next) => save({ name: next })} />
      <div className="sim-def-row">
        <span className="sim-def-k">Analysis</span>
        <span className="sim-def-v" data-study-analysis="1">
          {study.analysis || (row ? analysisLabel(row) : 'Incompressible')}
        </span>
      </div>
      {hasSettings ? (
        <SchemaForm
          className="schema-form sim-study-settings"
          schema={settingsSchema}
          formData={settingsData}
          hideFooter
          onCommit={(values) => {
            const patch = pickSchemaValues(values, settingsSchema);
            if (typeof patch.turbulence_model === 'string') {
              if (patch.turbulence_model === turbKey) delete patch.turbulence_model;
              else patch.turbulence_model_key = patch.turbulence_model;
            }
            if (Object.keys(patch).length) void save(patch);
          }}
        />
      ) : null}
      <div className="sim-def-row">
        <span className="sim-def-k" title="Steady-state solves for the converged flow. Transient marches through real time.">
          Time dependency
        </span>
        <span className="sim-def-v">
          <select
            className="bc-select sim-def-select"
            aria-label="Time dependency"
            value={transient ? 'Transient' : 'Steady-state'}
            onChange={(e) => {
              setError('');
              setStudyTimeDependency(e.target.value as TimeDependency).catch((err) => setError(errorText(err)));
            }}
          >
            <option value="Steady-state">Steady-state</option>
            <option value="Transient">Transient</option>
          </select>
        </span>
      </div>
      <div className="sim-def-row">
        <span className="sim-def-k">Algorithm</span>
        <span className="sim-def-v" data-study-algorithm="1">
          {study.algorithm || (transient ? 'PIMPLE' : 'SIMPLE')}
        </span>
      </div>
      <p className="mat-assign-hint sim-def-hint">{TIME_HINT}</p>
      {hasNumerics ? (
        <SchemaForm
          className="schema-form sim-study-numerics"
          schema={numericsSchema}
          formData={numericsData(record, numericsSchema, turbKey)}
          hideFooter
          onCommit={(values) => {
            const patch = pickSchemaValues(values, numericsSchema);
            const changed = Object.fromEntries(Object.entries(patch).filter(([k, v]) => record[k] !== v));
            if (Object.keys(changed).length) void save(changed);
          }}
        />
      ) : transient ? (
        <p className="mat-assign-hint sim-def-hint" data-study-transient-note="1">
          Transient runs take their time step, time scheme and PIMPLE correctors from each run&apos;s panel.
        </p>
      ) : null}
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
        <button
          type="button"
          className="js-btn tree-panel-done"
          onClick={() => {
            window.dispatchEvent(new CustomEvent('cfd:panel-done'));
            dispatchPanelDone();
          }}
        >
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
  const row = rowFor(String(values.analysis_type || ''), rows);
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
