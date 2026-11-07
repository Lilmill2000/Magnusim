/**
 * The study panel rows of a Heat Transfer study: which solver runs and why (the
 * solver follows the study's materials: a body of a solid material makes it
 * conjugate heat transfer), the physics (gravity, density model, operating
 * pressure, reference and starting temperature, turbulence model), each solid's
 * heat source (set in its material: it copies and goes with the record), time
 * dependency, algorithm, and the numerics. Every value reaches the written case
 * (heat_transfer.physics). Temperatures show in °C or °F (the project's units)
 * with a K/°C/°F picker; they are saved in K. A study on a Standard mesh says
 * how far the heat through walls was off there in the validation set and HT5's proofs
 * (tetrahedra). A new mesh of a Heat Transfer study starts on Hex-dominant.
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

/**
 * The mesher of the study's mesh; with no mesh yet, `fresh`: the one a new mesh starts
 * with (the analysis row's default_mesher, host API 1.8). '' while unknown.
 */
export function useStudyMeshEngine(projectId: string, simId: string, fresh = ''): string {
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
          if (live) setEngine(m ? String(m.ui_mesh_engine || m.settings?.advanced?.mesh_engine || 'standard') : fresh);
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
  }, [projectId, simId, fresh]);
  return engine;
}

/** HT5's composite wall on a Standard mesh read this much more heat through its walls than the exact answer. */
export const STANDARD_HEAT_HIGH_PCT = 6;
/** The validation set's laminar pipes on a Standard mesh read Nu up to this much high (VALIDATION.md). */
export const STANDARD_LAMINAR_HIGH_PCT = 14;
/** Its turbulent pipe (k-omega SST, wall functions, no layers) on a Standard mesh read Nu within this much (VALIDATION.md). */
export const STANDARD_TURBULENT_WITHIN_PCT = 1;

/**
 * The note of a study on a Standard mesh: how far the heat through walls was off there. The pre-run
 * check says the same (heat_transfer/precheck.py STANDARD_MESH_NOTE, word for word), where the
 * Assistant reads it.
 */
export const STANDARD_MESH_NOTE =
  `On a Standard mesh (tetrahedra) the heat through walls is less accurate next to a laminar flow: up to about ${STANDARD_LAMINAR_HIGH_PCT} % ` +
  `high (the validation's laminar pipes), and about ${STANDARD_HEAT_HIGH_PCT} % high through a solid's walls. Its turbulent pipe ` +
  `(k-omega SST, wall functions) read within about ${STANDARD_TURBULENT_WITHIN_PCT} %, and natural convection in a cavity within 1.5 %. ` +
  'Mesh with Hex-dominant for heat numbers.';

/**
 * RH3: the scheme settings (x-cfddesk.group "schemes") the study sets itself, over its Numerics
 * preset: a blank-able one with a value, another one away from its default.
 */
export function schemesChanged(record: Record<string, unknown>, schema: RJSFSchema): string[] {
  const props = (schema.properties || {}) as Record<string, RJSFSchema & { 'x-cfddesk'?: { group?: string; optional?: boolean } }>;
  return Object.entries(props)
    .filter(([key, prop]) => {
      const x = prop['x-cfddesk'] || {};
      const v = record[key];
      return x.group === 'schemes' && !(v === undefined || v === null || v === '') && (x.optional || v !== prop.default);
    })
    .map(([key]) => key);
}

/**
 * RH3: "Robust, 2 terms changed · Use the preset for all" under the numerics when the study's
 * schemes depart from its preset; the button clears them, so the study follows its preset again.
 */
export function PresetNote({ record, schema, save }: { record: Record<string, unknown>; schema: RJSFSchema; save: (patch: Record<string, unknown>) => unknown }) {
  const props = (schema.properties || {}) as Record<string, RJSFSchema & { enum?: unknown[]; 'x-cfddesk'?: { enum_labels?: string[] } }>;
  const preset = props.numerics_preset;
  const changed = preset ? schemesChanged(record, schema) : [];
  if (!preset || !changed.length) return null;
  const value = String(record.numerics_preset || preset.default || '');
  const i = Array.isArray(preset.enum) ? preset.enum.indexOf(value) : -1;
  const name = (i >= 0 && (preset['x-cfddesk']?.enum_labels || [])[i]) || value;
  return (
    <p className="mat-assign-hint sim-def-hint" data-study-preset-note="1">
      {`${name}, ${changed.length} term${changed.length === 1 ? '' : 's'} changed · `}
      <button type="button" className="mat-clear-link" data-study-preset-reset="1" onClick={() => void save(Object.fromEntries(changed.map((k) => [k, null])))}>
        Use the preset for all
      </button>
    </p>
  );
}

/** A blank-able field (x-cfddesk.optional) the form left without a value (set back to "Not set"): null. */
export function blanked(values: Record<string, unknown>, schema: RJSFSchema): Record<string, unknown> {
  const props = (schema.properties || {}) as Record<string, { 'x-cfddesk'?: { optional?: boolean } }>;
  return Object.fromEntries(Object.entries(props).filter(([k, p]) => p['x-cfddesk']?.optional && values[k] === undefined).map(([k]) => [k, null]));
}

/**
 * What the form shows of each field before an edit: the value it was given, else the field's
 * default as the form fills it in (a blank-able field, x-cfddesk.optional, stays blank). An edit
 * saves only the fields whose value differs from this, so a default the study never set stays
 * blank (blank is written as that default) and a run's Continue names only what the person changed.
 */
export function shownValues(data: Record<string, unknown>, schema: RJSFSchema): Record<string, unknown> {
  const props = (schema.properties || {}) as Record<string, RJSFSchema & { 'x-cfddesk'?: { optional?: boolean } }>;
  const out = { ...data };
  for (const [key, prop] of Object.entries(props)) {
    const v = out[key];
    if ((v === undefined || v === '') && !prop['x-cfddesk']?.optional && prop.default !== undefined && prop.default !== null) out[key] = prop.default;
  }
  return out;
}

/** A saved value and a form's value are the same (blank: undefined, null or ''). */
function same(a: unknown, b: unknown): boolean {
  const blank = (v: unknown) => v === undefined || v === null || v === '';
  if (blank(a) && blank(b)) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}

export function StudySettings({ study, row, save, setTimeDependency }: StudySettingsProps) {
  const { SchemaForm, schema: tools } = host().pluginUi;
  const record = (study.record || {}) as Record<string, unknown>;
  const transient = study.time_dependency === 'Transient';
  const materials = useStudyMaterials(String(study.project_id || ''), String(study.id || ''));
  const solids = (materials || []).filter((m) => m.model === SOLID_MODEL);
  const cht = solids.length > 0;
  const engine = useStudyMeshEngine(
    String(study.project_id || ''),
    String(study.id || ''),
    String((row as { default_mesher?: string } | undefined)?.default_mesher || ''),
  );
  const settingsSchema = shownSettingsSchema(
    tools.mergeObjectSchemas([(row?.schema || row?.settings_schema) as RJSFSchema | undefined]),
    record,
  );
  const numericsSchema = shownNumericsSchema(tools.mergeObjectSchemas([row?.numerics_schema as RJSFSchema | undefined]), cht);
  // Only what the person changed is saved. The numerics compare with what the form showed, so a
  // default it showed stays blank (blank is written as that default; a run's Continue names only
  // what changed); the settings keep comparing with the saved record, as before.
  const commit = (schema: RJSFSchema, shownDefaults = false) => (values: Record<string, unknown>) => {
    const patch = { ...blanked(values, schema), ...tools.pickSchemaValues(values, schema) };
    const shown = shownDefaults ? shownValues(tools.pickSchemaValues(record, schema), schema) : record;
    const changed = Object.fromEntries(Object.entries(patch).filter(([k, v]) => !same(shown[k], v)));
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
      {engine === 'standard' && materials !== null ? (
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
          boundsOnEdit
          onCommit={commit(numericsSchema, true)}
        />
      ) : null}
      {hasNumerics ? <PresetNote record={record} schema={numericsSchema} save={save} /> : null}
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
