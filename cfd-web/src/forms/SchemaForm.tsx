import { useEffect, useMemo, useRef } from 'react';
import Form from '@rjsf/core';
import validator from '@rjsf/validator-ajv8';
import type { RJSFSchema, UiSchema, WidgetProps } from '@rjsf/utils';
import { fromSi, toSi, unitLabels, type Quantity } from '../units/convert';
import { prefersImperial } from '../prefs';

export interface SchemaFormProps {
  schema: RJSFSchema;
  formData?: Record<string, unknown>;
  onCommit: (values: Record<string, unknown>) => void;
  onDone?: () => void;
  onDelete?: () => void;
  deleteLabel?: string;
  className?: string;
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
  return (
    <span className="bc-value-row">
      <input
        className="bc-input"
        type="number"
        value={display ?? ''}
        aria-label={props.label}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (!Number.isFinite(n)) {
            props.onChange(undefined);
            return;
          }
          props.onChange(qty && unit ? toSi(qty, n, unit) : n);
        }}
      />
      {unit ? <span className="bc-unit-label">{unit}</span> : null}
    </span>
  );
}

function ToggleWidget(props: WidgetProps) {
  const on = !!props.value;
  return (
    <button
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
  ToggleWidget,
  Vector3Widget,
  PickHintWidget,
};

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
      };
    };
    const x = prop['x-cfddesk'] || {};
    const field: UiSchema = {};
    const widget = String(x.widget || x.x_widget || '');
    if (widget === 'faces' || widget === 'body' || widget === 'patch') {
      field['ui:widget'] = 'PickHintWidget';
      field['ui:options'] = { ...(field['ui:options'] as object), pick: widget };
    } else if (prop.type === 'boolean') field['ui:widget'] = 'ToggleWidget';
    else if (prop.type === 'number' || prop.type === 'integer') field['ui:widget'] = 'NumberUnitWidget';
    else if (prop.type === 'array' && (prop.minItems === 3 || prop.maxItems === 3)) {
      field['ui:widget'] = 'Vector3Widget';
    }
    if (x.advanced) field['ui:classNames'] = 'schema-advanced';
    if (x.group) field['ui:options'] = { ...(field['ui:options'] as object), group: x.group };
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
  onDone,
  onDelete,
  deleteLabel = 'Delete',
  className,
}: SchemaFormProps) {
  const props = (schema && schema.properties) || {};
  const timer = useRef<number | null>(null);
  const uiSchema = useMemo(() => buildUiSchema(schema), [schema]);
  const live = formData || {};
  const shown = useMemo(() => pruneDepends(schema, live), [schema, live]);

  useEffect(() => {
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, []);

  if (!Object.keys(props).length) {
    return (
      <div className={className || 'schema-form'}>
        <p className="mat-assign-hint">No settings on this schema.</p>
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
        liveValidate
        onChange={(e) => {
          const values = (e.formData || {}) as Record<string, unknown>;
          if (timer.current) window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => onCommit(values), 300);
        }}
        onSubmit={(e) => {
          onCommit((e.formData || {}) as Record<string, unknown>);
          onDone?.();
        }}
      >
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
      </Form>
    </div>
  );
}
