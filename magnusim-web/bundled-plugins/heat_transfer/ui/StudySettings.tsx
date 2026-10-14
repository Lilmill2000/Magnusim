/**
 * The study panel rows of a Heat Transfer study: which solver runs and why, the
 * physics (gravity, density model, operating pressure, reference and starting
 * temperature, turbulence model), time dependency, algorithm, and the numerics.
 * Every value reaches the written case (heat_transfer.physics). Temperatures
 * show in °C or °F (the project's units) with a K/°C/°F picker; they are saved in K.
 */
import type { RJSFSchema } from '@rjsf/utils';
import type { StudySettingsProps } from '../../../src/plugin-api';
import { host } from './host';

export const SOLVERS = { steady: 'buoyantSimpleFoam', transient: 'buoyantPimpleFoam' } as const;

/** Which solver runs and why (the solver follows the study's materials). */
export function solverLine(transient: boolean): string {
  const solver = transient ? SOLVERS.transient : SOLVERS.steady;
  return (
    `Solves buoyant flow of one fluid with ${solver}: every body is fluid. ` +
    'Give every body the same fluid material.'
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

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function StudySettings({ study, row, save, setTimeDependency }: StudySettingsProps) {
  const { SchemaForm, schema: tools } = host().pluginUi;
  const record = (study.record || {}) as Record<string, unknown>;
  const transient = study.time_dependency === 'Transient';
  const settingsSchema = shownSettingsSchema(
    tools.mergeObjectSchemas([(row?.schema || row?.settings_schema) as RJSFSchema | undefined]),
    record,
  );
  const numericsSchema = tools.mergeObjectSchemas([row?.numerics_schema as RJSFSchema | undefined]);
  const commit = (schema: RJSFSchema) => (values: Record<string, unknown>) => {
    const patch = tools.pickSchemaValues(values, schema);
    const changed = Object.fromEntries(Object.entries(patch).filter(([k, v]) => !same(record[k], v)));
    if (Object.keys(changed).length) void save(changed);
  };
  const hasNumerics = Object.keys(numericsSchema.properties || {}).length > 0;
  return (
    <>
      <p className="mat-assign-hint sim-def-hint" data-ht-solver="1">
        {solverLine(transient)}
      </p>
      <SchemaForm
        className="schema-form sim-study-settings"
        schema={settingsSchema}
        formData={tools.pickSchemaValues(record, settingsSchema)}
        hideFooter
        onCommit={commit(settingsSchema)}
      />
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
      {transient ? (
        <p className="mat-assign-hint sim-def-hint" data-study-transient-note="1">
          Transient runs take their simulation time, frames and time step from each run&apos;s panel.
        </p>
      ) : null}
    </>
  );
}
