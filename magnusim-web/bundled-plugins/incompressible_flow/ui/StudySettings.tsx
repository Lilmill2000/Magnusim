/**
 * The study panel rows between Analysis and the foot: Turbulence model, Time
 * dependency, Algorithm, the hint, and the numerics: a steady study's SIMPLE ones,
 * and (RH3) both modes' schemes, linear solvers and velocity limit under Advanced
 * settings (a transient study says where its time step and correctors live). Every
 * value here reaches the written case (incompressible_flow.physics). The settings
 * schema's "reference" group is drawn as its own section (Reference values).
 */
import type { RJSFSchema } from '@rjsf/utils';
import type { StudySettingsProps } from '../../../src/plugin-api';
import { host } from './host';
import { ReferenceValues } from './ReferenceValues';

const TURBULENCE_ALIASES: Record<string, string> = {
  laminar: 'laminar',
  kepsilon: 'kEpsilon',
  komegasst: 'kOmegaSST',
  sst: 'kOmegaSST',
  lrr: 'LRR',
  ssg: 'SSG',
  spalartallmaras: 'SpalartAllmaras',
  realizableke: 'realizableKE',
  realizablekepsilon: 'realizableKE',
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

/** Reynolds-stress models solve with Relaxation U 0.5 unless the study sets one (physics.default_relax_u). */
export const RSM_RELAX_U = 0.5;

export function numericsData(
  record: Record<string, unknown>,
  schema: RJSFSchema,
  turbKey: string | null | undefined,
): Record<string, unknown> {
  const data = host().pluginUi.schema.pickSchemaValues(record, schema);
  const hasRelax = typeof data.relax_u === 'number' && Number.isFinite(data.relax_u);
  if (!hasRelax && (turbKey === 'LRR' || turbKey === 'SSG') && schema.properties && 'relax_u' in schema.properties) {
    data.relax_u = RSM_RELAX_U;
  }
  return data;
}

/** The settings schema without its "reference" group, and whether it had one. */
export function splitReferenceSchema(schema: RJSFSchema): { settings: RJSFSchema; reference: boolean } {
  const props = (schema.properties || {}) as Record<string, RJSFSchema & { 'x-cfddesk'?: { group?: string } }>;
  const kept: Record<string, RJSFSchema> = {};
  let reference = false;
  for (const [key, prop] of Object.entries(props)) {
    if (prop?.['x-cfddesk']?.group === 'reference') reference = true;
    else kept[key] = prop;
  }
  const required = Array.isArray(schema.required) ? schema.required.filter((k) => k in kept) : undefined;
  return { settings: { ...schema, properties: kept, ...(required ? { required } : {}) }, reference };
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
export function sameValue(a: unknown, b: unknown): boolean {
  const blank = (v: unknown) => v === undefined || v === null || v === '';
  if (blank(a) && blank(b)) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * RH3: the scheme settings (x-cfddesk.group "schemes") the study sets itself, over its Numerics
 * preset: a blank-able one with a value, another one away from its default.
 */
export function schemesChanged(record: Record<string, unknown>, schema: RJSFSchema): string[] {
  const props = (schema.properties || {}) as Record<string, RJSFSchema & { 'x-cfddesk'?: { group?: string; optional?: boolean } }>;
  const out: string[] = [];
  for (const [key, prop] of Object.entries(props)) {
    const x = prop['x-cfddesk'] || {};
    if (x.group !== 'schemes') continue;
    const v = record[key];
    if (v === undefined || v === null || v === '') continue;
    if (x.optional || v !== prop.default) out.push(key);
  }
  return out;
}

/**
 * RH3: the line under the numerics when a study's schemes depart from its preset: "Robust, 2 terms
 * changed · Use the preset for all" (which clears them: the study then follows its preset).
 */
export function PresetNote({
  record,
  schema,
  save,
}: {
  record: Record<string, unknown>;
  schema: RJSFSchema;
  save: (patch: Record<string, unknown>) => unknown;
}) {
  const props = (schema.properties || {}) as Record<string, RJSFSchema & { enum?: unknown[]; 'x-cfddesk'?: { enum_labels?: string[] } }>;
  const preset = props.numerics_preset;
  if (!preset) return null;
  const changed = schemesChanged(record, schema);
  if (!changed.length) return null;
  const value = String(record.numerics_preset || preset.default || '');
  const labels = preset['x-cfddesk']?.enum_labels || [];
  const i = Array.isArray(preset.enum) ? preset.enum.indexOf(value) : -1;
  const name = (i >= 0 && labels[i]) || value;
  return (
    <p className="mat-assign-hint sim-def-hint" data-study-preset-note="1">
      {`${name}, ${changed.length} term${changed.length === 1 ? '' : 's'} changed · `}
      <button
        type="button"
        className="mat-clear-link"
        data-study-preset-reset="1"
        onClick={() => void save(Object.fromEntries(changed.map((k) => [k, null])))}
      >
        Use the preset for all
      </button>
    </p>
  );
}

/** SIMPLEC's own relaxation, used in place of the study's (physics.SIMPLEC_RELAX_U / _P). */
export const SIMPLEC_RELAX_U = 0.9;
export const SIMPLEC_RELAX_P = 1;

const TIME_HINT =
  'Steady-state solves for the converged flow with simpleFoam. Transient marches through real time with pimpleFoam and writes frames you can animate.';

export function StudySettings({ study, row, save, setTimeDependency }: StudySettingsProps) {
  const { SchemaForm, schema: tools } = host().pluginUi;
  const record = (study.record || {}) as Record<string, unknown>;
  const transient = study.time_dependency === 'Transient';
  const { settings: settingsSchema, reference } = splitReferenceSchema(
    tools.mergeObjectSchemas([(row?.schema || row?.settings_schema) as RJSFSchema | undefined]),
  );
  const numericsSchema = tools.mergeObjectSchemas([row?.numerics_schema as RJSFSchema | undefined]);
  const turbKey = turbulenceKey(record);
  const settingsData = {
    ...tools.pickSchemaValues(record, settingsSchema),
    ...(turbKey ? { turbulence_model: turbKey } : {}),
  };
  const hasSettings = Object.keys(settingsSchema.properties || {}).length > 0;
  // RH3: a transient study has numerics too (its schemes, linear solvers and velocity limit).
  const hasNumerics = Object.keys(numericsSchema.properties || {}).length > 0;
  // SIMPLEC hides the relaxation rows (their depends_on, read from the saved
  // study like this note) and says what it uses instead.
  const simplecOn = hasNumerics && 'simplec' in (numericsSchema.properties || {}) && record.simplec === true;
  // A Reynolds-stress model keeps its own lower relaxation under SIMPLEC (physics.simplec_relax_u).
  const rsm = turbKey === 'LRR' || turbKey === 'SSG';
  const simplecU = rsm ? Math.min(SIMPLEC_RELAX_U, RSM_RELAX_U) : SIMPLEC_RELAX_U;

  return (
    <>
      {hasSettings ? (
        <SchemaForm
          className="schema-form sim-study-settings"
          schema={settingsSchema}
          formData={settingsData}
          hideFooter
          onCommit={(values) => {
            const patch = tools.pickSchemaValues(values, settingsSchema);
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
      <p className="mat-assign-hint sim-def-hint">{TIME_HINT}</p>
      {hasNumerics ? (
        <SchemaForm
          className="schema-form sim-study-numerics"
          schema={numericsSchema}
          formData={numericsData(record, numericsSchema, turbKey)}
          hideFooter
          boundsOnEdit
          onCommit={(values) => {
            const patch = { ...blanked(values, numericsSchema), ...tools.pickSchemaValues(values, numericsSchema) };
            // Only what the person changed is saved: a saved value (one outside its range included)
            // stays as it is, and a default the form showed stays blank.
            const shown = shownValues(numericsData(record, numericsSchema, turbKey), numericsSchema);
            const changed = Object.fromEntries(Object.entries(patch).filter(([k, v]) => !sameValue(shown[k], v)));
            if (Object.keys(changed).length) void save(changed);
          }}
        />
      ) : null}
      {hasNumerics ? <PresetNote record={record} schema={numericsSchema} save={save} /> : null}
      {simplecOn ? (
        <p className="mat-assign-hint sim-def-hint" data-study-simplec-note="1">
          SIMPLEC relaxes velocity and turbulence by {simplecU}
          {rsm ? ` (the Reynolds-stress model's own, below SIMPLEC's ${SIMPLEC_RELAX_U})` : ''} and leaves pressure unrelaxed (
          {SIMPLEC_RELAX_P}), in place of the study&apos;s relaxation.
        </p>
      ) : null}
      {transient ? (
        <p className="mat-assign-hint sim-def-hint" data-study-transient-note="1">
          The time step and PIMPLE correctors are on each run&apos;s panel.
        </p>
      ) : null}
      {reference ? <ReferenceValues record={record} save={save} /> : null}
    </>
  );
}
