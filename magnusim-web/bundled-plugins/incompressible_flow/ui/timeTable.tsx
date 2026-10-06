/**
 * "Varies with time" on a velocity inlet, a pressure boundary or a
 * total-pressure inlet (incompressible_flow.time_table): in a transient study
 * the BC follows a table of (time, value) rows instead of its fixed value,
 * linear between rows, holding the last value or repeating the table after
 * it. A steady study offers no table (and the case writer ignores one).
 *
 * The rows are saved with the unit they were typed in (time_table_unit) and
 * shown in the BC's unit; a table typed for another quantity (before the BC
 * became a pressure) is shown empty, never read as this one.
 */
import type { ClipboardEvent, ReactNode } from 'react';
import { Button, LinePlot, Select, Toggle, UNITS, convertQuantity, resolveUnit, type Quantity } from '@magnusim/plugin-ui';
import type { BcSettingsProps } from '../../../src/plugin-api';
import { host } from './host';

export type TableRow = [number | null, number | null];

/** After the last row (incompressible_flow.time_table.AFTER_LAST). */
export const AFTER_LAST = ['Hold', 'Repeat'] as const;
export type AfterLast = (typeof AFTER_LAST)[number];

const AFTER_LAST_LABELS: Record<AfterLast, string> = {
  Hold: 'Hold the last value',
  Repeat: 'Repeat the table',
};

/** The study solves in time (incompressible_flow.contract.study_is_transient). */
export function studyIsTransient(study: Record<string, unknown> | null | undefined): boolean {
  if (!study) return false;
  const td = String(study.time_dependency || '').trim().toLowerCase();
  if (td) return td.startsWith('transient');
  return String(study.analysis_type || '').endsWith('_transient');
}

export function variesWithTime(bc: Record<string, unknown>): boolean {
  const v = bc.time_varying;
  if (typeof v === 'string') return ['true', 'yes', 'on', '1'].includes(v.trim().toLowerCase());
  return v === true;
}

export function afterLast(raw: unknown): AfterLast {
  const want = String(raw || '').trim().toLowerCase();
  return AFTER_LAST.find((a) => a.toLowerCase() === want) || 'Hold';
}

function cell(v: unknown): number | null {
  if (v === null || v === undefined || typeof v === 'boolean' || (typeof v === 'string' && !v.trim())) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** The saved rows as (time, value); a blank or non-number cell is null. */
export function tableRows(raw: unknown): TableRow[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((r): TableRow => {
    if (Array.isArray(r)) return [cell(r[0]), cell(r[1])];
    if (r && typeof r === 'object') {
      const o = r as Record<string, unknown>;
      return [cell(o.t ?? o.time), cell(o.value)];
    }
    return [null, null];
  });
}

/** What keeps the table from being solved, in the user's words (the run's readiness check says the same), else null. */
export function tableProblem(rows: TableRow[]): string | null {
  if (rows.length < 2) return 'The table needs at least 2 rows (time, value).';
  for (let i = 0; i < rows.length; i += 1) {
    if (rows[i][0] === null) return `Row ${i + 1} has no time.`;
    if (rows[i][1] === null) return `Row ${i + 1} has no value.`;
  }
  for (let i = 1; i < rows.length; i += 1) {
    const prev = rows[i - 1][0] as number;
    const cur = rows[i][0] as number;
    if (!(cur > prev)) return `The times must increase from row to row (row ${i + 1} is at ${cur} s, not after ${prev} s).`;
  }
  return null;
}

/** The row Add row appends: one step (the last gap, else 1 s) after the last time, at the last value. */
export function nextRow(rows: TableRow[]): TableRow {
  if (!rows.length) return [0, 0];
  const [t, v] = rows[rows.length - 1];
  const prev = rows.length > 1 ? rows[rows.length - 2][0] : null;
  const step = t !== null && prev !== null && t > prev ? t - prev : 1;
  return [round(t === null ? 0 : t + step), v];
}

function round(n: number): number {
  return Number(n.toPrecision(10));
}

/**
 * Rows pasted as two columns (time, value) from a spreadsheet or a text file:
 * tab, comma, semicolon or space separated; lines without two numbers (a
 * header) are skipped. Null when the text holds no such line (a single number
 * pastes into its cell as usual).
 */
export function parseTableText(text: string): TableRow[] | null {
  const rows: TableRow[] = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const parts = line.trim().split(/[\t;,]+|\s+/).filter(Boolean);
    if (parts.length < 2) continue;
    const t = cell(parts[0]);
    const v = cell(parts[1]);
    if (t === null || v === null) continue;
    rows.push([t, v]);
  }
  return rows.length ? rows : null;
}

export function isUnitOf(quantity: Quantity, unit: unknown): boolean {
  return resolveUnit(quantity, String(unit || '')) in UNITS[quantity];
}

/** The rows' values from one unit to another of the same quantity (rounded as the panel shows them). */
export function convertRows(rows: TableRow[], quantity: Quantity, from: string, to: string): TableRow[] {
  return rows.map(([t, v]) => [t, v === null ? null : round(convertQuantity(quantity, v, from, to))]);
}

/**
 * The rows as the panel shows them, in `unit`: converted from the unit they
 * were typed in; none when that unit is not one of `quantity`'s.
 */
export function shownRows(bc: Record<string, unknown>, quantity: Quantity, unit: string): TableRow[] {
  const rows = tableRows(bc.time_table);
  const typed = String(bc.time_table_unit || bc.unit || unit);
  if (!isUnitOf(quantity, typed)) return [];
  return convertRows(rows, quantity, typed, unit);
}

/** A record patch saving `rows` (typed in `unit`). */
function rowsPatch(rows: TableRow[], unit: string): Record<string, unknown> {
  return { time_table: rows.map(([t, v]) => [t, v]), time_table_unit: unit };
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mat-row">
      <span className="mat-k">{label}</span>
      <span className="mat-v">{children}</span>
    </div>
  );
}

/** The "Varies with time" switch; nothing in a steady study. Turning it on with no table starts one at the fixed value. */
export function VariesWithTimeRow({
  bc,
  study,
  save,
  quantity,
  unit,
}: Pick<BcSettingsProps, 'bc' | 'study' | 'save'> & { quantity: Quantity; unit: string }) {
  if (!studyIsTransient(study)) return null;
  const on = variesWithTime(bc);
  const toggle = (next: boolean) => {
    if (!next) {
      void save({ time_varying: false });
      return;
    }
    const rows = shownRows(bc, quantity, unit);
    const v = cell(bc.value) ?? 0;
    const seed: TableRow[] = rows.length ? rows : [[0, v], [1, v]];
    void save({ time_varying: true, ...rowsPatch(seed, unit) });
  };
  return (
    <Row label="Varies with time">
      <span data-bc-time-varying="1">
        <Toggle label="Varies with time" checked={on} onChange={toggle} />
      </span>
    </Row>
  );
}

/** The table, its unit, what happens after the last row, a preview and what is wrong with it. */
export function TimeTable({
  bc,
  save,
  quantity,
  unit,
  units,
  valueLabel,
  speedNote,
}: Pick<BcSettingsProps, 'bc' | 'save'> & {
  quantity: Quantity;
  unit: string;
  units: string[];
  valueLabel: string;
  /** A velocity inlet's: its turbulence at the inlet uses the largest value. */
  speedNote?: boolean;
}) {
  const { SciNumberInput } = host().pluginUi;
  const rows = shownRows(bc, quantity, unit);
  const after = afterLast(bc.time_after_last);
  const problem = tableProblem(rows);
  const saveRows = (next: TableRow[]) => void save(rowsPatch(next, unit));
  const setCell = (i: number, j: 0 | 1, n: number) => {
    const next = rows.map((r) => [r[0], r[1]] as TableRow);
    next[i][j] = n;
    saveRows(next);
  };
  const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    const pasted = parseTableText(e.clipboardData.getData('text'));
    if (!pasted) return;
    e.preventDefault();
    saveRows(pasted);
  };
  const plotRows = problem ? [] : rows.map(([t, v]) => ({ t: t as number, v: v as number }));
  return (
    <div data-bc-time-table="1">
      <Row label="Unit">
        <Select
          label={`${valueLabel} unit`}
          value={unit}
          options={units.map((u) => ({ value: u, label: u }))}
          onChange={(u) => void save({ unit: u })}
        />
      </Row>
      <div onPaste={onPaste}>
        <div className="mat-row">
          <span className="mat-k">Time (s)</span>
          <span className="mat-k">
            {valueLabel} ({unit})
          </span>
        </div>
        {rows.map(([t, v], i) => (
          <div className="mat-row" key={i} data-bc-time-row={i}>
            <SciNumberInput label={`Row ${i + 1} time`} value={t} onCommit={(n) => setCell(i, 0, n)} />
            <span className="bc-value-row">
              <SciNumberInput label={`Row ${i + 1} value`} value={v} onCommit={(n) => setCell(i, 1, n)} />
              <button
                type="button"
                className="bc-assign-x"
                aria-label={`Remove row ${i + 1}`}
                onClick={() => saveRows(rows.filter((_r, k) => k !== i))}
              >
                ×
              </button>
            </span>
          </div>
        ))}
      </div>
      <Button variant="link" onClick={() => saveRows([...rows, nextRow(rows)])} attrs={{ 'data-bc-time-add': '1' }}>
        Add row
      </Button>
      <Row label="Between points">Linear</Row>
      <Row label="After the last point">
        <Select
          label="After the last point"
          value={after}
          options={AFTER_LAST.map((a) => ({ value: a, label: AFTER_LAST_LABELS[a] }))}
          onChange={(a) => void save({ time_after_last: a })}
        />
      </Row>
      {problem ? (
        <p className="mat-assign-hint" role="alert" data-bc-time-problem="1">
          {problem}
        </p>
      ) : (
        <div data-bc-time-plot="1">
          <LinePlot
            rows={plotRows}
            series={[{ key: 'v', label: valueLabel, format: (n) => `${Number(n.toPrecision(4))} ${unit}` }]}
            label={`${valueLabel} over time`}
            x={{ kind: 'linear', label: 't', format: (n) => `${Number(n.toPrecision(4))} s` }}
            y={{ scale: 'linear', unit }}
            legend={false}
            height={96}
          />
        </div>
      )}
      <div className="mat-assign-hint" data-bc-time-hint="1">
        Times are seconds from the start of the run; between rows the value changes linearly.
        {after === 'Repeat' ? ' After the last row the table starts over (a pulse that repeats).' : ' After the last row the last value is kept.'}{' '}
        Paste two columns (time, value) from a spreadsheet into any cell to replace the table.
        {speedNote ? " Turbulence at the inlet uses the table's largest value." : ''}
      </div>
    </div>
  );
}
