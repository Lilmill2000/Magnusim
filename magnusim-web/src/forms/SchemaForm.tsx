import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import Form from '@rjsf/core';
import validator from '@rjsf/validator-ajv8';
import type { ObjectFieldTemplateProps, RJSFSchema, UiSchema, WidgetProps } from '@rjsf/utils';
import { fromSi, toSi, unitLabels, type Quantity } from '../units/convert';
import { prefersImperial } from '../prefs';
import { subscribeFacePicks } from '../viewer/pick';
import { SciNumberInput } from './SciNumberInput';

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
}

interface SchemaFormContext {
  advancedExtra?: ReactNode;
}

function AdvancedDetails({ children }: { children: ReactNode }) {
  return (
    <details className="mesh-advanced">
      <summary>Advanced settings</summary>
      {children}
    </details>
  );
}

function quantityOf(schema: RJSFSchema | undefined): Quantity | null {
  const x = schema && (schema as { 'x-cfddesk'?: { quantity?: string } })['x-cfddesk'];
  return (x && (x.quantity as Quantity)) || null;
}

function NumberUnitWidget(props: WidgetProps) {
  const qty = quantityOf(props.schema);
  const units = qty ? unitLabels(qty) : [];
  const imperial = prefersImperial();
  const preferred =
    qty === 'length' ? (imperial ? 'in' : 'mm') : qty ? units[0] : '';
  const unit = String(props.options?.unit || preferred || '');
  const display =
    qty && unit && typeof props.value === 'number' ? fromSi(qty, props.value, unit) : props.value;
  const emit = (n: number) => props.onChange(qty && unit ? toSi(qty, n, unit) : n);
  return (
    <span className="bc-value-row">
      <SciNumberInput
        id={props.id}
        value={typeof display === 'number' ? display : null}
        label={props.label}
        onLive={emit}
        onCommit={emit}
      />
      {unit ? <span className="bc-unit-label">{unit}</span> : null}
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
}) {
  if (props.hidden) return null;
  const id = String(props.id || '');
  // The root object is the form itself, not a row; wrapping it shrinks every row to its content.
  if (id === 'root') return <>{props.children}</>;
  const key = id.startsWith('root_') ? id.slice('root_'.length) : '';
  const help = String(props.schema?.description || '');
  const tipId = help ? `${id}__help` : undefined;
  return (
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
}

/** Advanced fields collapse into one disclosure, the way the legacy panels read. */
function ObjectFieldTemplate(props: ObjectFieldTemplateProps) {
  const extra = (props.registry?.formContext as SchemaFormContext | undefined)?.advancedExtra;
  const plain = props.properties.filter((p) => !isAdvanced(props.schema, p.name));
  const advanced = props.properties.filter((p) => isAdvanced(props.schema, p.name));
  if (!advanced.length && !extra) return <>{props.properties.map((p) => p.content)}</>;
  return (
    <>
      {plain.map((p) => p.content)}
      <AdvancedDetails>
        {advanced.map((p) => p.content)}
        {extra}
      </AdvancedDetails>
    </>
  );
}

function isAdvanced(schema: RJSFSchema, name: string): boolean {
  const prop = (schema.properties || {})[name] as
    | (RJSFSchema & { 'x-cfddesk'?: { advanced?: boolean } })
    | undefined;
  return !!prop?.['x-cfddesk']?.advanced;
}

/** Drop the draft URI ajv8 cannot load, and turn saved strings into the schema's type. */
export function prepareSchemaForm(
  schema: RJSFSchema,
  formData: Record<string, unknown> | undefined,
): { schema: RJSFSchema; formData: Record<string, unknown> } {
  const next = { ...(schema || {}) } as RJSFSchema;
  delete (next as { $schema?: string }).$schema;
  const props = (next.properties || {}) as Record<string, RJSFSchema>;
  const data = { ...(formData || {}) };
  for (const [key, prop] of Object.entries(props)) {
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
    if (widget === 'faces' || widget === 'body' || widget === 'patch') {
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
}: SchemaFormProps) {
  const props = (schema && schema.properties) || {};
  const timer = useRef<number | null>(null);
  const skipMount = useRef(true);
  const prepared = useMemo(() => prepareSchemaForm(schema, formData), [schema, formData]);
  const uiSchema = useMemo(() => buildUiSchema(prepared.schema), [prepared.schema]);
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
        widgets={widgets}
        templates={{ FieldTemplate, ObjectFieldTemplate }}
        formContext={{ advancedExtra } satisfies SchemaFormContext}
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
          timer.current = window.setTimeout(() => onCommit(values), 300);
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
