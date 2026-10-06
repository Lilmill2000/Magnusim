/**
 * The study panel rows between Analysis and the foot: Turbulence model, Time
 * dependency, Algorithm, the hint, and the steady SIMPLE numerics (a transient
 * study says where its time step and correctors live instead). Every value
 * here reaches the written case (incompressible_flow.physics). The settings
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
  const hasNumerics = !transient && Object.keys(numericsSchema.properties || {}).length > 0;
  // SIMPLEC hides the relaxation rows (their depends_on, read from the saved
  // study like this note) and says what it uses instead.
  const simplecOn = hasNumerics && 'simplec' in (numericsSchema.properties || {}) && record.simplec === true;

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
          onCommit={(values) => {
            const patch = tools.pickSchemaValues(values, numericsSchema);
            const changed = Object.fromEntries(Object.entries(patch).filter(([k, v]) => record[k] !== v));
            if (Object.keys(changed).length) void save(changed);
          }}
        />
      ) : null}
      {simplecOn ? (
        <p className="mat-assign-hint sim-def-hint" data-study-simplec-note="1">
          SIMPLEC relaxes velocity and turbulence by {SIMPLEC_RELAX_U} and leaves pressure unrelaxed ({SIMPLEC_RELAX_P}), in place of
          the study&apos;s relaxation.
        </p>
      ) : null}
      {hasNumerics ? null : transient ? (
        <p className="mat-assign-hint sim-def-hint" data-study-transient-note="1">
          Transient runs take their time step, time scheme and PIMPLE correctors from each run&apos;s panel.
        </p>
      ) : null}
      {reference ? <ReferenceValues record={record} save={save} /> : null}
    </>
  );
}
