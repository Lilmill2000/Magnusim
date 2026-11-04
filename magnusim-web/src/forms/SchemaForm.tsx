import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import Form from '@rjsf/core';
import validator from '@rjsf/validator-ajv8';
import type { ObjectFieldTemplateProps, RJSFSchema, UiSchema, WidgetProps } from '@rjsf/utils';
import { fieldQuantity, fieldUnit, fromSi, toSi, unitLabels } from '../units/convert';
import { prefersImperial } from '../prefs';
import { subscribeFacePicks } from '../viewer/pick';
import { SciNumberInput } from './SciNumberInput';
import {
  fieldWidgetsVersion,
  hasFieldWidget,
  pluginFieldWidgets,
  pluginWidgetName,
  subscribeFieldWidgets,
} from '../plugin-api/fieldWidgets';

export interface SchemaFormProps {
  schema: RJSFSchema;
  formData?: Record<string, unknown>;
  onCommit: (values: Record<string, unknown>) => void;
  onLive?: (values: Record<string, unknown>) => void;
  onDone?: () => void;
  onDelete?: () => void;
  deleteLabel?: string;
  className?: string;
  /** The host renders its own Done/Delete foot (mesh panel puts Generate between). */
  hideFooter?: boolean;
  /** Host rows appended inside the Advanced disclosure (the mesh engine select). */
  advancedExtra?: ReactNode;
  /**
   * A typed number commits on blur and Enter only, at once, not 0.3 s after a keystroke: for a
   * form whose save may ask the person first (a run that ended), so no question comes up in the
   * middle of typing.
   */
  commitOnBlur?: boolean;
  /**
   * A note under a field, by its key (a run's "Takes effect when you Continue"): shown in a
   * line below the field's row.
   */
  fieldNotes?: Record<string, ReactNode>;
  /**
   * Bounds apply only to an edit (host API 1.9, run health RH3): a number edited outside its
   * field's minimum or maximum is not saved, and the field says why ("Not saved: 0.9 is outside
   * 0 to 0.5."); a saved value outside them is kept and used as saved, and the field says so
   * ("Saved as 1e-2, outside 1e-12 to 1e-3. It is used as saved."). For forms whose saved
   * values are used as saved (a study's numerics, a run's settings).
   */
  boundsOnEdit?: boolean;
}

interface SchemaFormContext {
  advancedExtra?: ReactNode;
  commitOnBlur?: boolean;
  fieldNotes?: Record<string, ReactNode>;
  boundsOnEdit?: boolean;
  /** The edits refused for being out of range, by key: the field's words. */
  refused?: Record<string, string>;
}

/** Advanced settings' sub-heads, by x-cfddesk.group (RH3): their fields under them, in this order. */
export const SUBHEADS: Readonly<Record<string, string>> = Object.freeze({
  schemes: 'Schemes',
  linear_solvers: 'Linear solvers',
  limiters: 'Limiters',
});

type Bounds = { min: number | null; max: number | null };

function boundsOf(schema: RJSFSchema | undefined): Bounds {
  const s = (schema || {}) as { minimum?: unknown; maximum?: unknown };
  return {
    min: typeof s.minimum === 'number' && Number.isFinite(s.minimum) ? s.minimum : null,
    max: typeof s.maximum === 'number' && Number.isFinite(s.maximum) ? s.maximum : null,
  };
}

/** A bound or a value as the field's note says it: 1e-2 when the range is a tolerance's (its minimum under 1e-3), else 0.5, 2000. */
export function rangeNumber(x: number, small: boolean): string {
  return small && x !== 0 ? x.toExponential().replace('e+', 'e') : String(x);
}

/** "outside 1e-12 to 1e-3", "below 0", "above 5" for `v`, or '' when it is in range. */
export function outsideWords(v: unknown, b: Bounds): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '';
  const below = b.min !== null && v < b.min;
  const above = b.max !== null && v > b.max;
  if (!below && !above) return '';
  const small = b.min !== null && b.min > 0 && b.min < 1e-3;
  if (b.min !== null && b.max !== null) return `outside ${rangeNumber(b.min, small)} to ${rangeNumber(b.max, small)}`;
  return b.min !== null ? `below ${rangeNumber(b.min, small)}` : `above ${rangeNumber(b.max as number, small)}`;
}

function smallRange(b: Bounds): boolean {
  return b.min !== null && b.min > 0 && b.min < 1e-3;
}

/** The caution of a field's current value (x-cfddesk.caution, host API 1.9), or ''. */
export function cautionOf(schema: RJSFSchema | undefined, value: unknown): string {
  const x = ((schema || {}) as { 'x-cfddesk'?: { caution?: Record<string, unknown> } })['x-cfddesk'];
  const c = x && x.caution && typeof x.caution === 'object' ? x.caution : null;
  if (!c || value === undefined || value === null) return '';
  const text = c[String(value)];
  return typeof text === 'string' ? text : '';
}

function AdvancedDetails({ children }: { children: ReactNode }) {
  return (
    <details className="mesh-advanced">
      <summary>Advanced settings</summary>
      {children}
    </details>
  );
}

/**
 * A number in its quantity's unit, stored in SI. A temperature field's unit is
 * a K/°C/°F picker (API 1.8), starting on the unit system's; the pick changes
 * only what is shown and typed.
 */
function NumberUnitWidget(props: WidgetProps) {
  const qty = fieldQuantity(props.schema);
  const preferred = qty ? fieldUnit(qty, prefersImperial() ? 'imperial' : 'metric') : '';
  const fixed = String(props.options?.unit || '');
  const [picked, setPicked] = useState('');
  const choices = qty === 'temperature' && !fixed ? unitLabels(qty) : [];
  const unit = choices.length && picked ? picked : String(fixed || preferred || '');
  const display =
    qty && unit && typeof props.value === 'number' ? fromSi(qty, props.value, unit) : props.value;
  const emit = (n: number) => props.onChange(qty && unit ? toSi(qty, n, unit) : n);
  const blurOnly = !!(props.registry?.formContext as SchemaFormContext | undefined)?.commitOnBlur;
  return (
    <span className="bc-value-row">
      <SciNumberInput
        id={props.id}
        value={typeof display === 'number' ? display : null}
        label={props.label}
        onLive={blurOnly ? undefined : emit}
        onCommit={emit}
      />
      {choices.length ? (
        <select
          className="bc-select"
          aria-label={`${props.label} unit`}
          value={unit}
          onChange={(e) => setPicked(e.target.value)}
        >
          {choices.map((u) => (
            <option key={u} value={u}>
              {u}
            </option>
          ))}
        </select>
      ) : unit ? (
        <span className="bc-unit-label">{unit}</span>
      ) : null}
    </span>
  );
}

/** COARSE-to-FINE slider, the chrome the legacy mesh form used for fineness. */
function RangeWidget(props: WidgetProps) {
  const schema = props.schema as RJSFSchema & { minimum?: number; maximum?: number };
  const min = Number(schema.minimum ?? 1);
  const max = Number(schema.maximum ?? 10);
  const value = typeof props.value === 'number' ? props.value : min;
  const options = props.options as { low?: string; high?: string } | undefined;
  return (
    <span className="mesh-fineness-wrap">
      <span className="mesh-fineness-ends">
        <span>{options?.low || 'COARSE'}</span>
        <span>{options?.high || 'FINE'}</span>
      </span>
      <input
        id={props.id}
        type="range"
        min={min}
        max={max}
        step={Number(schema.multipleOf ?? 1)}
        value={value}
        aria-label={props.label}
        onChange={(e) => props.onChange(Number(e.target.value))}
      />
      <span className="mesh-fineness-val">{value}</span>
    </span>
  );
}

function ToggleWidget(props: WidgetProps) {
  const on = !!props.value;
  return (
    <button
      id={props.id}
      type="button"
      className={on ? 'mesh-toggle is-on' : 'mesh-toggle'}
      aria-pressed={on}
      aria-label={props.label}
      onClick={() => props.onChange(!on)}
    >
      {on ? 'ON' : 'OFF'}
    </button>
  );
}

function PickHintWidget(props: WidgetProps) {
  const kind = String(props.options?.pick || 'item');
  return <p className="mat-assign-hint">Pick {kind} in the viewport or tree.</p>;
}

function FacePickerWidget(props: WidgetProps) {
  const ids = Array.isArray(props.value) ? props.value.map((id) => String(id)) : [];
  const onChange = props.onChange;
  useEffect(() => subscribeFacePicks((next) => onChange(next)), [onChange]);
  return (
    <div data-face-picker="1">
      {ids.length ? (
        <ul className="ml-list">
          {ids.map((id) => (
            <li key={id} data-face-id={id}>
              {id}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mat-assign-hint">Pick faces in the viewport or tree.</p>
      )}
    </div>
  );
}

function Vector3Widget(props: WidgetProps) {
  const v = Array.isArray(props.value) ? props.value : [0, 0, 0];
  const set = (i: number, n: number) => {
    const next = [v[0] ?? 0, v[1] ?? 0, v[2] ?? 0];
    next[i] = n;
    props.onChange(next);
  };
  return (
    <span className="bc-value-row">
      {['X', 'Y', 'Z'].map((lab, i) => (
        <input
          key={lab}
          className="bc-input"
          type="number"
          aria-label={`${props.label} ${lab}`}
          value={v[i] ?? 0}
          onChange={(e) => set(i, Number(e.target.value))}
        />
      ))}
    </span>
  );
}

const widgets = {
  NumberUnitWidget,
  RangeWidget,
  ToggleWidget,
  Vector3Widget,
  PickHintWidget,
  FacePickerWidget,
};

function FieldTemplate(props: {
  id: string;
  classNames?: string;
  label?: string;
  children?: ReactNode;
  hidden?: boolean;
  displayLabel?: boolean;
  schema?: RJSFSchema;
  formData?: unknown;
  registry?: { formContext?: unknown };
}) {
  if (props.hidden) return null;
  const id = String(props.id || '');
  // The root object is the form itself, not a row; wrapping it shrinks every row to its content.
  if (id === 'root') return <>{props.children}</>;
  const key = id.startsWith('root_') ? id.slice('root_'.length) : '';
  const help = String(props.schema?.description || '');
  const tipId = help ? `${id}__help` : undefined;
  const ctx = props.registry?.formContext as SchemaFormContext | undefined;
  const note = key ? ctx?.fieldNotes?.[key] : null;
  const caution = key ? cautionOf(props.schema, props.formData) : '';
  const refused = key && ctx?.boundsOnEdit ? ctx.refused?.[key] || '' : '';
  const b = boundsOf(props.schema);
  const outside = key && ctx?.boundsOnEdit && !refused ? outsideWords(props.formData, b) : '';
  const row = (
    <div className={`mat-row schema-field ${props.classNames || ''}`} data-schema-key={key || undefined}>
      {props.displayLabel && props.label ? (
        <span className="mat-k" data-help={help ? '1' : undefined}>
          <label htmlFor={id}>{props.label}</label>
          {help ? (
            <>
              <span className="mat-k-help" tabIndex={0} role="button" aria-label={`About ${props.label}`} aria-describedby={tipId}>
                ?
              </span>
              <span className="mat-k-tip" role="tooltip" id={tipId}>
                {help}
              </span>
            </>
          ) : null}
        </span>
      ) : null}
      <span className="mat-v">{props.children}</span>
    </div>
  );
  const hasNote = !(note === null || note === undefined || note === false);
  if (!hasNote && !caution && !refused && !outside) return row;
  return (
    <>
      {row}
      {hasNote ? (
        <p className="mat-assign-hint schema-field-note" data-schema-note={key}>
          {note}
        </p>
      ) : null}
      {caution ? (
        <p className="mat-assign-hint schema-field-note sim-tr-warn" data-schema-caution={key}>
          {caution}
        </p>
      ) : null}
      {refused ? (
        <p className="mat-assign-hint schema-field-note sim-tr-warn" data-schema-refused={key} role="alert">
          {refused}
        </p>
      ) : null}
      {outside ? (
        <p className="mat-assign-hint schema-field-note" data-schema-saved-outside={key}>
          {`Saved as ${rangeNumber(props.formData as number, smallRange(b))}, ${outside}. It is used as saved.`}
        </p>
      ) : null}
    </>
  );
}

/**
 * Advanced fields collapse into one disclosure, the way the legacy panels read. Inside it, the
 * fields of a sub-head group (SUBHEADS: Schemes, Linear solvers, Limiters) go under their
 * sub-head, after the others.
 */
function ObjectFieldTemplate(props: ObjectFieldTemplateProps) {
  const extra = (props.registry?.formContext as SchemaFormContext | undefined)?.advancedExtra;
  const plain = props.properties.filter((p) => !isAdvanced(props.schema, p.name));
  const advanced = props.properties.filter((p) => isAdvanced(props.schema, p.name));
  if (!advanced.length && !extra) return <>{props.properties.map((p) => p.content)}</>;
  const loose = advanced.filter((p) => !SUBHEADS[groupOf(props.schema, p.name)]);
  const groups: string[] = [];
  for (const p of advanced) {
    const g = groupOf(props.schema, p.name);
    if (SUBHEADS[g] && !groups.includes(g)) groups.push(g);
  }
  return (
    <>
      {plain.map((p) => p.content)}
      <AdvancedDetails>
        {loose.map((p) => p.content)}
        {groups.map((g) => (
          <div key={g} className="schema-subgroup" data-schema-group={g}>
            <p className="schema-subhead" data-schema-subhead={g}>
              {SUBHEADS[g]}
            </p>
            {advanced.filter((p) => groupOf(props.schema, p.name) === g).map((p) => p.content)}
          </div>
        ))}
        {extra}
      </AdvancedDetails>
    </>
  );
}

function xOf(schema: RJSFSchema, name: string): { advanced?: boolean; group?: string } {
  const prop = (schema.properties || {})[name] as
    | (RJSFSchema & { 'x-cfddesk'?: { advanced?: boolean; group?: string } })
    | undefined;
  return prop?.['x-cfddesk'] || {};
}

function isAdvanced(schema: RJSFSchema, name: string): boolean {
  return !!xOf(schema, name).advanced;
}

function groupOf(schema: RJSFSchema, name: string): string {
  return String(xOf(schema, name).group || '');
}

/**
 * The edit's values with each number edited outside its field's range put back as saved
 * (`saved`), and the words of each refused one ("Not saved: 0.9 is outside 0 to 0.5."). Only the
 * keys this edit changes are checked: a saved value outside its range is kept.
 */
export function refuseOutOfRange(
  schema: RJSFSchema,
  values: Record<string, unknown>,
  saved: Record<string, unknown>,
): { values: Record<string, unknown>; refused: Record<string, string> } {
  const props = (schema.properties || {}) as Record<string, RJSFSchema>;
  const out = { ...values };
  const refused: Record<string, string> = {};
  for (const [key, prop] of Object.entries(props)) {
    const v = values[key];
    if (v === saved[key] || typeof v !== 'number') continue;
    const b = boundsOf(prop);
    const outside = outsideWords(v, b);
    if (!outside) continue;
    refused[key] = `Not saved: ${rangeNumber(v, smallRange(b))} is ${outside}.`;
    out[key] = saved[key];
  }
  return { values: out, refused };
}

/** Drop the draft URI ajv8 cannot load, and turn saved strings into the schema's type. */
export function prepareSchemaForm(
  schema: RJSFSchema,
  formData: Record<string, unknown> | undefined,
): { schema: RJSFSchema; formData: Record<string, unknown> } {
  const next = { ...(schema || {}) } as RJSFSchema;
  delete (next as { $schema?: string }).$schema;
  const props = { ...((next.properties || {}) as Record<string, RJSFSchema>) };
  next.properties = props;
  const data = { ...(formData || {}) };
  for (const [key, raw] of Object.entries(props)) {
    let prop = raw;
    // A choice that may be left blank (x-cfddesk.optional, RH3) starts on "Not set", never on
    // its first choice: it has no default to show.
    if (blankChoice(prop)) {
      const { default: _blank, ...rest } = prop as RJSFSchema & { default?: unknown };
      prop = rest as RJSFSchema;
      props[key] = prop;
      if (data[key] === null) delete data[key];
    }
    const type = prop?.type;
    const value = data[key];
    if ((value === undefined || value === '') && prop?.default !== undefined) {
      data[key] = prop.default;
      continue;
    }
    if (type === 'integer' || type === 'number') {
      const n = typeof value === 'number' ? value : Number(value);
      if (Number.isFinite(n)) data[key] = type === 'integer' ? Math.round(n) : n;
    } else if (type === 'boolean' && typeof value === 'string') {
      data[key] = value === 'true' || value === '1';
    }
  }
  return { schema: next, formData: data };
}

/** A choice that may be left blank (x-cfddesk.optional, no default): its select offers "Not set". */
function blankChoice(prop: RJSFSchema | undefined): boolean {
  const p = (prop || {}) as RJSFSchema & { enum?: unknown[]; default?: unknown; 'x-cfddesk'?: { optional?: boolean } };
  return !!p['x-cfddesk']?.optional && Array.isArray(p.enum) && (p.default === null || p.default === undefined);
}

/** The words of a blank choice's empty option. */
export const NOT_SET = 'Not set';

function buildUiSchema(schema: RJSFSchema): UiSchema {
  const ui: UiSchema = {};
  const props = schema.properties || {};
  for (const [key, raw] of Object.entries(props)) {
    const prop = raw as RJSFSchema & {
      'x-cfddesk'?: {
        group?: string;
        advanced?: boolean;
        depends_on?: Record<string, unknown>;
        widget?: string;
        x_widget?: string;
        enum_labels?: string[];
      };
    };
    const x = prop['x-cfddesk'] || {};
    const field: UiSchema = {};
    const widget = String(x.widget || x.x_widget || '');
    if (widget && hasFieldWidget(widget)) {
      // A plugin registered this widget (pluginUi.registerFieldWidget).
      field['ui:widget'] = pluginWidgetName(widget);
    } else if (widget === 'faces' || widget === 'body' || widget === 'patch') {
      field['ui:widget'] = 'FacePickerWidget';
      field['ui:options'] = { ...(field['ui:options'] as object), pick: widget };
    } else if (widget === 'range') {
      field['ui:widget'] = 'RangeWidget';
      field['ui:classNames'] = 'mesh-fineness-row';
    } else if (prop.type === 'boolean') field['ui:widget'] = 'ToggleWidget';
    else if (prop.type === 'number' || prop.type === 'integer') field['ui:widget'] = 'NumberUnitWidget';
    else if (prop.type === 'array' && (prop.minItems === 3 || prop.maxItems === 3)) {
      field['ui:widget'] = 'Vector3Widget';
    }
    if (x.advanced) {
      field['ui:classNames'] = [field['ui:classNames'], 'schema-advanced']
        .filter(Boolean)
        .join(' ');
    }
    if (x.group) field['ui:options'] = { ...(field['ui:options'] as object), group: x.group };
    if (Array.isArray(x.enum_labels) && Array.isArray(prop.enum) && x.enum_labels.length === prop.enum.length) {
      field['ui:enumNames'] = x.enum_labels;
    }
    if (blankChoice(prop)) field['ui:placeholder'] = NOT_SET;
    ui[key] = field;
  }
  return ui;
}

function pruneDepends(schema: RJSFSchema, values: Record<string, unknown>): RJSFSchema {
  const props = { ...(schema.properties || {}) };
  for (const [key, raw] of Object.entries(props)) {
    const prop = raw as { 'x-cfddesk'?: { depends_on?: Record<string, unknown> } };
    const dep = prop['x-cfddesk']?.depends_on;
    if (!dep) continue;
    const ok = Object.entries(dep).every(([k, v]) => values[k] === v);
    if (!ok) delete props[key];
  }
  return { ...schema, properties: props };
}

export function SchemaForm({
  schema,
  formData,
  onCommit,
  onLive,
  onDone,
  onDelete,
  deleteLabel = 'Delete',
  className,
  hideFooter = false,
  advancedExtra,
  commitOnBlur = false,
  fieldNotes,
  boundsOnEdit = false,
}: SchemaFormProps) {
  const props = (schema && schema.properties) || {};
  const timer = useRef<number | null>(null);
  const skipMount = useRef(true);
  const [refused, setRefused] = useState<Record<string, string>>({});
  const prepared = useMemo(() => prepareSchemaForm(schema, formData), [schema, formData]);
  // A plugin widget registered after this form mounted must still replace the
  // core widget: the registry's version rebuilds the uiSchema.
  const widgetsVersion = useSyncExternalStore(subscribeFieldWidgets, fieldWidgetsVersion, fieldWidgetsVersion);
  const uiSchema = useMemo(() => buildUiSchema(prepared.schema), [prepared.schema, widgetsVersion]);
  const live = prepared.formData;
  const shown = useMemo(() => pruneDepends(prepared.schema, live), [prepared.schema, live]);

  useEffect(() => {
    skipMount.current = false;
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, []);

  if (!Object.keys(props).length) {
    return (
      <div className={className || 'schema-form'}>
        {advancedExtra ? <AdvancedDetails>{advancedExtra}</AdvancedDetails> : <p className="mat-assign-hint">No settings on this schema.</p>}
        {hideFooter ? null : (
        <div className="mat-panel-foot">
          <div className="mesh-foot-left">
            {onDelete ? (
              <button type="button" className="mat-clear-link" onClick={onDelete}>
                {deleteLabel}
              </button>
            ) : (
              <span />
            )}
          </div>
          <button type="button" className="js-btn tree-panel-done" onClick={() => onDone?.()}>
            Done
          </button>
        </div>
        )}
      </div>
    );
  }

  return (
    <div className={className || 'schema-form'}>
      <Form
        schema={shown}
        uiSchema={uiSchema}
        validator={validator}
        formData={live}
        widgets={{ ...widgets, ...pluginFieldWidgets() }}
        templates={{ FieldTemplate, ObjectFieldTemplate }}
        formContext={{ advancedExtra, commitOnBlur, fieldNotes, boundsOnEdit, refused } satisfies SchemaFormContext}
        showErrorList={false}
        liveValidate
        onChange={(e) => {
          const values = (e.formData || {}) as Record<string, unknown>;
          onLive?.(values);
          if (skipMount.current) {
            skipMount.current = false;
            return;
          }
          if (timer.current) window.clearTimeout(timer.current);
          // RH3: an edit outside a field's range is not saved (and says why); a saved value
          // outside it is kept. Checked as the value is committed, not on every keystroke.
          const commit = () => {
            if (!boundsOnEdit) return onCommit(values);
            const checked = refuseOutOfRange(prepared.schema, values, live);
            setRefused(checked.refused);
            onCommit(checked.values);
          };
          // Numbers change here only on blur and Enter then: the change is the person's last word.
          if (commitOnBlur) {
            timer.current = null;
            commit();
            return;
          }
          timer.current = window.setTimeout(commit, 300);
        }}
        onSubmit={(e) => {
          onCommit((e.formData || {}) as Record<string, unknown>);
          onDone?.();
        }}
      >
        {hideFooter ? (
          <span hidden />
        ) : (
          <div className="mat-panel-foot">
            <div className="mesh-foot-left">
              {onDelete ? (
                <button type="button" className="mat-clear-link" onClick={onDelete}>
                  {deleteLabel}
                </button>
              ) : (
                <span />
              )}
            </div>
            <button type="submit" className="js-btn tree-panel-done">
              Done
            </button>
          </div>
        )}
      </Form>
    </div>
  );
}
