/**
 * The study panel rows of a Heat Transfer study: which solver runs and why (the
 * solver follows the study's materials: a body of a solid material makes it
 * conjugate heat transfer), the physics (gravity, density model, operating
 * pressure, reference and starting temperature, turbulence model), each solid's
 * heat source (set in its material: it copies and goes with the record), time
 * dependency, algorithm, and the numerics. Every value reaches the written case
 * (heat_transfer.physics). Temperatures show in °C or °F (the project's units)
 * with a K/°C/°F picker; they are saved in K. A conjugate heat transfer study on
 * a Standard mesh says that its wall heat reads high there (tetrahedra).
 */
import type { RJSFSchema } from '@rjsf/utils';
import { useEffect, useState } from 'react';
import type { StudySettingsProps } from '../../../src/plugin-api';
import { host } from './host';
import { SOLID_MODEL, bodiesText, useStudyMaterials, type StudyMaterial } from './materials';

export const SOLVERS = { steady: 'buoyantSimpleFoam', transient: 'buoyantPimpleFoam' } as const;
export const CHT_SOLVERS = { steady: 'chtMultiRegionSimpleFoam', transient: 'chtMultiRegionFoam' } as const;

/** "Body2 is Aluminium 6061", "Body2 and Body3 are Copper". */
function isText(m: StudyMaterial): string {
  return `${bodiesText(m.bodies)} ${m.bodies.length > 1 ? 'are' : 'is'} ${m.name}`;
}

function joinAnd(parts: string[]): string {
  if (parts.length <= 1) return parts[0] || '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/**
 * Which solver runs and why. `materials` null: not known yet (the line for buoyant
 * flow, which is what a study without a solid material solves).
 */
export function solverLine(transient: boolean, materials: readonly StudyMaterial[] | null = null): string {
  const solids = (materials || []).filter((m) => m.model === SOLID_MODEL);
  const fluids = (materials || []).filter((m) => m.model !== SOLID_MODEL);
  if (solids.length) {
    const solver = transient ? CHT_SOLVERS.transient : CHT_SOLVERS.steady;
    const fluid = fluids.length ? ` ${joinAnd(fluids.map(isText))} (fluid).` : ' No body is fluid: heat conduction through the solids only.';
    return `Conjugate heat transfer with ${solver}: ${joinAnd(solids.map(isText))} (solid).${fluid}`;
  }
  const solver = transient ? SOLVERS.transient : SOLVERS.steady;
  const which = fluids.length ? ` ${joinAnd(fluids.map(isText))}.` : '';
  return (
    `Solves buoyant flow of one fluid with ${solver}: every body is fluid.${which} ` +
    'Give a body a solid material for conjugate heat transfer (heat conducted through solids).'
  );
}

/**
 * The settings schema without rows that would do nothing as the study is set: the
 * gravity magnitude while gravity is off (the custom direction has its own depends_on).
 */
export function shownSettingsSchema(schema: RJSFSchema, record: Record<string, unknown>): RJSFSchema {
  const props = { ...((schema.properties || {}) as Record<string, RJSFSchema>) };
  if (String(record.gravity || '') === 'off') delete props.gravity_magnitude;
  const required = Array.isArray(schema.required) ? schema.required.filter((k) => k in props) : undefined;
  return { ...schema, properties: props, ...(required ? { required } : {}) };
}

/** The numerics schema without the residual target in a conjugate heat transfer study (its solver never reads it). */
export function shownNumericsSchema(schema: RJSFSchema, cht: boolean): RJSFSchema {
  if (!cht) return schema;
  const props = { ...((schema.properties || {}) as Record<string, RJSFSchema>) };
  delete props.residual_target;
  const required = Array.isArray(schema.required) ? schema.required.filter((k) => k in props) : undefined;
  return { ...schema, properties: props, ...(required ? { required } : {}) };
}

export type HeatSourceMode = 'none' | 'power' | 'density';

export interface HeatSourceRow {
  mode: HeatSourceMode;
  power_W: number;
  power_density_W_m3: number;
}

function finiteOr0(v: unknown): number {
  const n = typeof v === 'number' ? v : v === '' || v == null ? NaN : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * A study record's heat sources by material id. Saved as JSON text: a study record keeps
 * plain values only (an object is read too).
 */
export function heatSources(record: Record<string, unknown>): Record<string, unknown> {
  let raw: unknown = record.heat_sources;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      raw = null;
    }
  }
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

/** A study record's heat source of one material (none when it has none): older studies kept them there. */
export function heatSourceOf(record: Record<string, unknown>, id: string): HeatSourceRow {
  const all = heatSources(record);
  const raw = (all[id] && typeof all[id] === 'object' ? all[id] : {}) as Record<string, unknown>;
  const mode: HeatSourceMode = raw.mode === 'power' || raw.mode === 'density' ? raw.mode : 'none';
  return { mode, power_W: finiteOr0(raw.power_W), power_density_W_m3: finiteOr0(raw.power_density_W_m3) };
}

/**
 * A solid's heat source: its material record's (heat_source_W, heat_source_W_m3), else
 * (a study saved before the source moved onto the record) the study's row for it.
 */
export function solidSource(m: StudyMaterial, record: Record<string, unknown>): HeatSourceRow {
  if (m.heatSourceW === undefined && m.heatSourceWm3 === undefined) return heatSourceOf(record, m.id);
  const w = m.heatSourceW || 0;
  const d = m.heatSourceWm3 || 0;
  return { mode: w ? 'power' : d ? 'density' : 'none', power_W: w, power_density_W_m3: d };
}

function shown(v: number): string {
  return String(Number(v.toPrecision(4)));
}

/** "10 W", "34.12 BTU/h", "None"; both kinds when both are set (Start refuses that). */
export function sourceText(row: HeatSourceRow, imperial: boolean): string {
  const { kit } = host().pluginUi;
  const part = (q: 'power' | 'power_density', si: number) => {
    const unit = kit.preferredUnit(q, imperial);
    return `${shown(kit.fromSi(q, si, unit))} ${unit}`;
  };
  const parts = [
    ...(row.power_W ? [part('power', row.power_W)] : []),
    ...(row.power_density_W_m3 && (row.mode !== 'power' || row.power_W) ? [part('power_density', row.power_density_W_m3)] : []),
  ];
  if (row.mode === 'none' || !parts.length) return 'None';
  return parts.length > 1 ? `${parts.join(' and ')} (set one of them to 0)` : parts[0];
}

/** Each solid's heat source, as set in its material. */
function HeatSources({ record, solids }: { record: Record<string, unknown>; solids: StudyMaterial[] }) {
  const imperial = host().pluginUi.unitSystem() === 'imperial';
  return (
    <div data-ht-heat-sources="1">
      {solids.map((m) => (
        <div className="sim-def-row" key={m.id} data-ht-heat-source={m.id}>
          <span className="sim-def-k" title={`Heat given off in ${bodiesText(m.bodies)}, spread evenly: set in the material.`}>
            {`Heat source: ${m.name} (${bodiesText(m.bodies)})`}
          </span>
          <span className="sim-def-v" data-ht-heat-source-value="1">
            {sourceText(solidSource(m, record), imperial)}
          </span>
        </div>
      ))}
      <p className="mat-assign-hint sim-def-hint" data-ht-heat-source-hint="1">
        A solid&apos;s heat source is set in its material (Materials, then the solid): it goes with the material when the
        study is copied.
      </p>
    </div>
  );
}

/** The mesher of the study's mesh ('standard' until another is picked; '' while unknown). */
export function useStudyMeshEngine(projectId: string, simId: string): string {
  const [engine, setEngine] = useState('');
  useEffect(() => {
    if (!projectId || !simId) {
      setEngine('');
      return undefined;
    }
    let live = true;
    const load = () => {
      const q = new URLSearchParams({ project_id: projectId, simulation_id: simId });
      fetch(`/api/mesh?${q}`)
        .then((r) => r.json())
        .then((j: { mesh?: { ui_mesh_engine?: string; settings?: { advanced?: { mesh_engine?: string } } } | null }) => {
          const m = (j && j.mesh) || null;
          if (live) setEngine(String((m && (m.ui_mesh_engine || m.settings?.advanced?.mesh_engine)) || 'standard'));
        })
        .catch(() => {
          if (live) setEngine('');
        });
    };
    load();
    window.addEventListener('cfd:mesh-settings', load);
    window.addEventListener('cfd:mesh-job', load);
    return () => {
      live = false;
      window.removeEventListener('cfd:mesh-settings', load);
      window.removeEventListener('cfd:mesh-job', load);
    };
  }, [projectId, simId]);
  return engine;
}

/** HT5's composite wall on a Standard mesh read this much more heat through its walls than the exact answer. */
export const STANDARD_HEAT_HIGH_PCT = 6;

export const STANDARD_MESH_NOTE =
  `On a Standard mesh (tetrahedra) the heat through a solid's walls reads about ${STANDARD_HEAT_HIGH_PCT} % high ` +
  '(its temperatures are right): mesh with Hex-dominant for heat numbers.';

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function StudySettings({ study, row, save, setTimeDependency }: StudySettingsProps) {
  const { SchemaForm, schema: tools } = host().pluginUi;
  const record = (study.record || {}) as Record<string, unknown>;
  const transient = study.time_dependency === 'Transient';
  const materials = useStudyMaterials(String(study.project_id || ''), String(study.id || ''));
  const solids = (materials || []).filter((m) => m.model === SOLID_MODEL);
  const cht = solids.length > 0;
  const engine = useStudyMeshEngine(String(study.project_id || ''), String(study.id || ''));
  const settingsSchema = shownSettingsSchema(
    tools.mergeObjectSchemas([(row?.schema || row?.settings_schema) as RJSFSchema | undefined]),
    record,
  );
  const numericsSchema = shownNumericsSchema(tools.mergeObjectSchemas([row?.numerics_schema as RJSFSchema | undefined]), cht);
  const commit = (schema: RJSFSchema) => (values: Record<string, unknown>) => {
    const patch = tools.pickSchemaValues(values, schema);
    const changed = Object.fromEntries(Object.entries(patch).filter(([k, v]) => !same(record[k], v)));
    if (Object.keys(changed).length) void save(changed);
  };
  const hasNumerics = Object.keys(numericsSchema.properties || {}).length > 0;
  return (
    <>
      <p className="mat-assign-hint sim-def-hint" data-ht-solver="1" data-ht-cht={cht ? '1' : '0'}>
        {solverLine(transient, materials)}
      </p>
      <SchemaForm
        className="schema-form sim-study-settings"
        schema={settingsSchema}
        formData={tools.pickSchemaValues(record, settingsSchema)}
        hideFooter
        onCommit={commit(settingsSchema)}
      />
      {cht ? <HeatSources record={record} solids={solids} /> : null}
      {cht && engine === 'standard' ? (
        <p className="mat-assign-hint sim-def-hint" data-ht-standard-mesh="1">
          {STANDARD_MESH_NOTE}
        </p>
      ) : null}
      <div className="sim-def-row">
        <span className="sim-def-k" title="Steady-state solves for the settled temperature and flow. Transient marches through real time.">
          Time dependency
        </span>
        <span className="sim-def-v">
          <select
            className="bc-select sim-def-select"
            aria-label="Time dependency"
            value={transient ? 'Transient' : 'Steady-state'}
            onChange={(e) => void setTimeDependency(e.target.value as 'Steady-state' | 'Transient')}
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
      {hasNumerics ? (
        <SchemaForm
          className="schema-form sim-study-numerics"
          schema={numericsSchema}
          formData={tools.pickSchemaValues(record, numericsSchema)}
          hideFooter
          onCommit={commit(numericsSchema)}
        />
      ) : null}
      {cht && !transient ? (
        <p className="mat-assign-hint sim-def-hint" data-ht-cht-stop="1">
          A conjugate heat transfer run does not stop on its residuals: it runs its iterations, or until a monitor
          settles (the run&apos;s Stop when settled).
        </p>
      ) : null}
      {transient ? (
        <p className="mat-assign-hint sim-def-hint" data-study-transient-note="1">
          Transient runs take their simulation time, frames and time step from each run&apos;s panel.
        </p>
      ) : null}
    </>
  );
}
