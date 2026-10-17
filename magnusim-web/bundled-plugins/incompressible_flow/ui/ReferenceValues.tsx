/**
 * The study's reference values (incompressible_flow.reference): what Forces
 * monitors and the pressure coefficient measure against. Saved on the study
 * record in SI (`ref_*` keys); shown in the project's units. A blank value is
 * calculated (speed, directions) or has a fixed default (pressure, centre of
 * rotation); area and length have none.
 */
import { useEffect, useRef, useState } from 'react';
import { fieldUnit, fromSi, preferredUnit, toSi, type Quantity } from '@magnusim/plugin-ui';
import { host } from './host';

export const REFERENCE_KEYS = [
  'ref_speed',
  'ref_pressure',
  'ref_area',
  'ref_length',
  'ref_cofr',
  'ref_drag_dir',
  'ref_lift_dir',
] as const;

type Vec = [number, number, number];

function finite(v: unknown): number | null {
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** A saved vector, or null when it is not three numbers. */
export function savedVec(v: unknown): Vec | null {
  if (!Array.isArray(v) || v.length !== 3) return null;
  const n = v.map(finite);
  return n.every((x) => x != null) ? (n as Vec) : null;
}

/** The unit a reference quantity is shown in: lengths like the geometry (mm or in). */
export function referenceUnit(q: Quantity, imperial: boolean): string {
  return q === 'length' ? fieldUnit(q, imperial ? 'imperial' : 'metric') : preferredUnit(q, imperial);
}

const shown = (n: number) => String(Number(n.toPrecision(6)));

/** Text typed into a box as a number, null when blank, undefined when it is not a number. */
export function parseTyped(text: string): number | null | undefined {
  const raw = text.trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

type Save = (patch: Record<string, unknown>) => Promise<void> | void;

/**
 * A row's value: the one last typed until its save has answered (the study record
 * changes only then), else the saved one. A box of a vector typed meanwhile builds on
 * it, so X then Z typed quickly keeps X, and a box never shows its old value meanwhile.
 */
function usePendingValue(saved: unknown, field: string, save: Save): [unknown, (value: unknown) => void] {
  const [pending, setPending] = useState<{ value: unknown } | null>(null);
  const latest = useRef(0);
  const commit = (value: unknown) => {
    const mine = ++latest.current;
    setPending({ value });
    void Promise.resolve(save({ [field]: value })).finally(() => {
      if (latest.current === mine) setPending(null);
    });
  };
  return [pending ? pending.value : saved, commit];
}

function TextNumber({
  label,
  valueText,
  placeholder,
  onCommit,
}: {
  label: string;
  valueText: string;
  placeholder?: string;
  onCommit: (text: string) => void;
}) {
  const [text, setText] = useState(valueText);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setText(valueText);
  }, [valueText, editing]);
  return (
    <input
      type="text"
      inputMode="decimal"
      className="bc-input sim-ref-input"
      aria-label={label}
      placeholder={placeholder}
      value={text}
      onFocus={() => setEditing(true)}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        setEditing(false);
        onCommit(text);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
    />
  );
}

function ScalarRow({
  field,
  label,
  title,
  quantity,
  value,
  placeholder,
  imperial,
  positive,
  save,
}: {
  field: string;
  label: string;
  title: string;
  quantity: Quantity;
  value: unknown;
  placeholder: string;
  imperial: boolean;
  positive?: boolean;
  save: Save;
}) {
  const unit = referenceUnit(quantity, imperial);
  const [current, commit] = usePendingValue(value, field, save);
  const si = finite(current);
  const text = si == null ? '' : shown(fromSi(quantity, si, unit));
  return (
    <div className="sim-def-row" data-ref-field={field}>
      <span className="sim-def-k" title={title}>
        {label}
      </span>
      <span className="sim-def-v bc-value-row">
        <TextNumber
          label={label}
          valueText={text}
          placeholder={placeholder}
          onCommit={(typed) => {
            const n = parseTyped(typed);
            if (n === undefined || (positive && n != null && !(n > 0))) return;
            const next = n == null ? null : toSi(quantity, n, unit);
            if (next !== si) commit(next);
          }}
        />
        <span className="bc-unit-label">{unit}</span>
      </span>
    </div>
  );
}

function VectorRow({
  field,
  label,
  title,
  quantity,
  value,
  placeholder,
  imperial,
  save,
}: {
  field: string;
  label: string;
  title: string;
  quantity?: Quantity;
  value: unknown;
  placeholder: [string, string, string];
  imperial: boolean;
  save: Save;
}) {
  const unit = quantity ? referenceUnit(quantity, imperial) : '';
  const [current, commitValue] = usePendingValue(value, field, save);
  const si = savedVec(current);
  const texts = si ? si.map((c) => shown(quantity ? fromSi(quantity, c, unit) : c)) : ['', '', ''];
  const commit = (i: number, typed: string) => {
    const n = parseTyped(typed);
    if (n === undefined) return;
    const parts = texts.map((t, j) => (j === i ? (n == null ? '' : String(n)) : t));
    if (parts.every((t) => !t.trim())) {
      if (si) commitValue(null);
      return;
    }
    const next = parts.map((t) => {
      const v = finite(t) ?? 0;
      return quantity ? toSi(quantity, v, unit) : v;
    }) as Vec;
    if (quantity == null && next.every((c) => c === 0)) return;
    if (!si || next.some((c, j) => c !== si[j])) commitValue(next);
  };
  return (
    <div className="sim-def-row" data-ref-field={field}>
      <span className="sim-def-k" title={title}>
        {label}
      </span>
      <span className="sim-def-v bc-value-row sim-ref-vec">
        {(['X', 'Y', 'Z'] as const).map((axis, i) => (
          <TextNumber
            key={axis}
            label={`${label} ${axis}`}
            valueText={texts[i]}
            placeholder={placeholder[i]}
            onCommit={(typed) => commit(i, typed)}
          />
        ))}
        {unit ? <span className="bc-unit-label">{unit}</span> : null}
      </span>
    </div>
  );
}

/** The Reference values rows of the study panel. */
export function ReferenceValues({
  record,
  save,
}: {
  record: Record<string, unknown>;
  save: Save;
}) {
  const imperial = host().pluginUi.unitSystem() === 'imperial';
  return (
    <div className="sim-ref" data-study-reference="1">
      <div className="mat-k sim-ref-head">Reference values</div>
      <p className="mat-assign-hint sim-def-hint">
        What Forces monitors and the pressure coefficient (Cp) measure against. The density is the fluid&apos;s.
      </p>
      <ScalarRow
        field="ref_speed"
        label="Reference speed"
        title="The free-stream speed U∞ coefficients divide by. Blank uses the inlet's (or freestream's) speed."
        quantity="velocity"
        value={record.ref_speed}
        placeholder="Inlet speed"
        imperial={imperial}
        positive
        save={save}
      />
      <ScalarRow
        field="ref_pressure"
        label="Reference pressure"
        title="The free-stream gauge pressure p∞ the pressure coefficient subtracts. Blank is 0."
        quantity="pressure"
        value={record.ref_pressure}
        placeholder="0"
        imperial={imperial}
        save={save}
      />
      <ScalarRow
        field="ref_area"
        label="Reference area"
        title="The area force coefficients divide by (a frontal or wing area). Forces monitors give no coefficients without it."
        quantity="area"
        value={record.ref_area}
        placeholder="Not set"
        imperial={imperial}
        positive
        save={save}
      />
      <ScalarRow
        field="ref_length"
        label="Reference length"
        title="The length the moment coefficient divides by (a chord). No moment coefficient without it."
        quantity="length"
        value={record.ref_length}
        placeholder="Not set"
        imperial={imperial}
        positive
        save={save}
      />
      <VectorRow
        field="ref_cofr"
        label="Centre of rotation"
        title="The point moments are taken about. Blank is the origin."
        quantity="length"
        value={record.ref_cofr}
        placeholder={['0', '0', '0']}
        imperial={imperial}
        save={save}
      />
      <VectorRow
        field="ref_drag_dir"
        label="Drag direction"
        title="The direction drag is measured along. Blank uses the inlet's (or freestream's) flow direction, else +X."
        value={record.ref_drag_dir}
        placeholder={['auto', 'auto', 'auto']}
        imperial={imperial}
        save={save}
      />
      <VectorRow
        field="ref_lift_dir"
        label="Lift direction"
        title="The direction lift is measured along, made square to drag. Blank is +Z (+Y when drag runs along Z)."
        value={record.ref_lift_dir}
        placeholder={['auto', 'auto', 'auto']}
        imperial={imperial}
        save={save}
      />
      <p className="mat-assign-hint sim-def-hint" data-ref-hint="1">
        Blank speed: the inlet&apos;s speed. Blank directions: drag along the inlet&apos;s flow (else +X), lift +Z (+Y
        when drag runs along Z), at right angles to drag.
      </p>
    </div>
  );
}
