/**
 * How the page shows a run's monitors, from what the analysis publishes: the
 * quantities its monitor series carry (MonitorQuantity rows: the run_monitors
 * answer's `quantities`, else the analysis's registry row), each monitor row
 * (`key`, `default_quantity`, series points) and the summary line under the
 * monitors. The monitor types users may add come from the registry's monitor
 * rows. Nothing here knows a particular physics.
 *
 * An answer from a server that does not pass `quantities` or `summary` through
 * still renders: the quantities fall back to the analysis's registry row, then
 * to LEGACY_MONITOR_QUANTITIES (the API 1.1 table, python/cfddesk/registry/contract.py),
 * and the summary to the API 1.1 flow `balance`.
 */
import type { MonitorQuantity, MonitorSummaryItem, RegistryRow, RunMonitor, RunMonitors } from './api/registry.gen';
import { siUnitLabel } from './units/convert';

/** A run_monitors answer as GET /api/run/monitors gives it: any key may be missing. */
export type MonitorAnswer = Partial<RunMonitors> & { analysis_key?: string | null };

/** One series point: `t` and the samples the quantities read. */
export type MonitorSample = { t?: unknown } & Record<string, unknown>;

function legacy(
  key: string,
  label: string,
  sample: string,
  unitQuantity: string,
  unit: string,
  csv: string,
  extra: Partial<MonitorQuantity> = {},
): MonitorQuantity {
  return {
    key,
    label,
    sample,
    component: null,
    unit_quantity: unitQuantity,
    unit,
    color: '#3884e6',
    magnitude: false,
    direction_from: '',
    direction: ['', ''],
    plot: true,
    details: true,
    headline: false,
    csv,
    ...extra,
  };
}

/**
 * The quantities of an analysis that declares none (API 1.1 rows: p_Pa, Umag,
 * U, Un_m_s, Q_m3s per point). The same table as contract.LEGACY_MONITOR_QUANTITIES.
 */
export const LEGACY_MONITOR_QUANTITIES: readonly MonitorQuantity[] = Object.freeze([
  legacy('p', 'Pressure', 'p_Pa', 'pressure', 'Pa', 'pressure_Pa', { color: '#6941c6', headline: true }),
  legacy('Umag', 'Mean velocity', 'Umag', 'velocity', 'm/s', 'mean_velocity_m_s', { headline: true }),
  legacy('Ux', 'Velocity X', 'U', 'velocity', 'm/s', 'Ux_m_s', { component: 0 }),
  legacy('Uy', 'Velocity Y', 'U', 'velocity', 'm/s', 'Uy_m_s', { component: 1 }),
  legacy('Uz', 'Velocity Z', 'U', 'velocity', 'm/s', 'Uz_m_s', { component: 2 }),
  legacy('Un', 'Normal velocity', 'Un_m_s', 'velocity', 'm/s', 'Un_m_s', {
    magnitude: true,
    direction_from: 'Q_m3s',
    direction: ['in', 'out'],
    plot: false,
  }),
  legacy('Q', 'Flow rate', 'Q_m3s', 'volumetric_flow', 'm³/s', 'flow_m3_s', {
    magnitude: true,
    direction_from: 'Q_m3s',
    direction: ['in', 'out'],
    plot: false,
    headline: true,
  }),
  legacy('mdot', 'Mass flow', 'mdot_kgs', 'mass_flow', 'kg/s', 'mass_kg_s', { magnitude: true, plot: false }),
]);

/**
 * The quantities a run's monitors carry: the answer's own, else the ones the
 * analysis declares (its registry row's monitor_quantities), else the API 1.1 table.
 */
export function monitorQuantities(
  answer: MonitorAnswer | null | undefined,
  declared?: readonly MonitorQuantity[] | null,
): readonly MonitorQuantity[] {
  if (answer && Array.isArray(answer.quantities) && answer.quantities.length) return answer.quantities;
  if (Array.isArray(declared) && declared.length) return declared;
  return LEGACY_MONITOR_QUANTITIES;
}

export function quantityByKey(qs: readonly MonitorQuantity[], key: string | null | undefined): MonitorQuantity | undefined {
  return key ? qs.find((q) => q.key === key) : undefined;
}

/** The quantities a monitor's plot may show, in order. */
export function plotQuantities(qs: readonly MonitorQuantity[]): MonitorQuantity[] {
  return qs.filter((q) => q.plot);
}

/** The quantity a monitor's plot opens on: its row's default_quantity, else the first plotted one. */
export function defaultQuantity(row: RunMonitor | null | undefined, qs: readonly MonitorQuantity[]): string {
  const plots = plotQuantities(qs);
  const named = row && typeof row.default_quantity === 'string' ? row.default_quantity : '';
  if (named && plots.some((q) => q.key === named)) return named;
  return plots.length ? plots[0].key : '';
}

/** The row's latest point: `last`, else the end of its series. */
export function lastSample(row: RunMonitor | null | undefined): MonitorSample | null {
  if (!row) return null;
  const last = (row as { last?: unknown }).last;
  if (last && typeof last === 'object') return last as MonitorSample;
  const series = Array.isArray(row.series) ? row.series : [];
  return series.length ? (series[series.length - 1] as MonitorSample) : null;
}

function finite(v: unknown): number | null {
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** The value `q` reads from a point (its component of a list sample), or null. */
export function pickSample(q: MonitorQuantity, sample: MonitorSample | null | undefined): number | null {
  if (!sample) return null;
  const raw = sample[q.sample];
  if (q.component != null) return Array.isArray(raw) ? finite(raw[q.component]) : null;
  return Array.isArray(raw) ? null : finite(raw);
}

/** The value as shown and plotted: its absolute value for a magnitude quantity. */
export function shownValue(q: MonitorQuantity, sample: MonitorSample | null | undefined): number | null {
  const v = pickSample(q, sample);
  return v != null && q.magnitude ? Math.abs(v) : v;
}

/** The unit label `q`'s samples are in. */
export function unitOf(q: MonitorQuantity): string {
  return q.unit || siUnitLabel(q.unit_quantity);
}

/** A number with about three significant digits (exponent form outside 1e-3 to 1e5). */
export function fmtNum(v: unknown, digits?: number): string {
  const n = finite(v);
  if (n == null) return '—';
  const a = Math.abs(n);
  if (a === 0) return '0';
  if (a >= 1e5 || a < 1e-3) return n.toExponential(digits != null ? digits : 2);
  const d = digits != null ? digits : a >= 100 ? 0 : a >= 10 ? 1 : a >= 1 ? 2 : 3;
  return n.toFixed(d);
}

const signOf = (n: number) => (n < 0 ? '-' : '');

/** m³/s, in L/s below 0.01 m³/s. */
function fmtFlow(n: number): string {
  const a = Math.abs(n);
  if (a < 0.01) return signOf(n) + fmtNum(a * 1000, a * 1000 < 1 ? 3 : 2) + ' L/s';
  return signOf(n) + fmtNum(a, 4) + ' m³/s';
}

/** kg/s, in g/s below 0.01 kg/s. */
function fmtMassFlow(n: number): string {
  const a = Math.abs(n);
  if (a < 0.01) return signOf(n) + fmtNum(a * 1000, 3) + ' g/s';
  return signOf(n) + fmtNum(a, 4) + ' kg/s';
}

/** A percentage (its absolute value), '< 0.01 %' below that. */
export function fmtPercent(v: unknown): string {
  const n = finite(v);
  if (n == null) return '—';
  const a = Math.abs(n);
  if (a < 0.01) return '< 0.01 %';
  return fmtNum(a, 2) + ' %';
}

const withUnit = (text: string, unit: string) => (unit ? text + ' ' + unit : text);

/**
 * A monitor value with its unit ('—' when there is none). A magnitude quantity
 * shows its absolute value. Volume and mass flows in m³/s and kg/s switch to
 * L/s and g/s below 0.01; a pressure shows whole numbers from 100 up, else one
 * decimal.
 */
export function formatMonitorValue(q: MonitorQuantity, value: unknown): string {
  let n = finite(value);
  if (n == null) return '—';
  if (q.magnitude) n = Math.abs(n);
  const unit = unitOf(q);
  if (q.unit_quantity === 'volumetric_flow' && unit === 'm³/s') return fmtFlow(n);
  if (q.unit_quantity === 'mass_flow' && unit === 'kg/s') return fmtMassFlow(n);
  if (unit === '%') return fmtPercent(n);
  if (q.unit_quantity === 'pressure') return withUnit(fmtNum(n, Math.abs(n) >= 100 ? 0 : 1), unit);
  return withUnit(fmtNum(n), unit);
}

/** ' <word>' naming the direction of a point (by the sign of `direction_from`), or ''. */
export function directionSuffix(q: MonitorQuantity, sample: MonitorSample | null | undefined): string {
  if (!q.direction_from || !sample) return '';
  const d = finite(sample[q.direction_from]);
  if (d == null) return '';
  const words = Array.isArray(q.direction) ? q.direction : ['', ''];
  const word = String((d < 0 ? words[0] : words[1]) || '').trim();
  return word ? ' ' + word : '';
}

/** `q` at a point, formatted, with its direction: '' when the point has no value. */
export function formatSampleValue(q: MonitorQuantity, sample: MonitorSample | null | undefined): string {
  const v = pickSample(q, sample);
  if (v == null) return '';
  return formatMonitorValue(q, v) + directionSuffix(q, sample);
}

/** A monitor's details at its latest point: [label, value] per detail quantity it has. */
export function detailRows(row: RunMonitor | null | undefined, qs: readonly MonitorQuantity[]): Array<[string, string]> {
  const last = lastSample(row);
  const out: Array<[string, string]> = [];
  for (const q of qs) {
    if (!q.details) continue;
    const text = formatSampleValue(q, last);
    if (text) out.push([q.label, text]);
  }
  return out;
}

/**
 * The lines of a plot's hover readout at a point: the plotted quantity, then
 * the other headline quantities that have a value.
 */
export function tipLines(
  qs: readonly MonitorQuantity[],
  chosenKey: string,
  sample: MonitorSample | null | undefined,
): Array<{ label: string; value: string; chosen: boolean }> {
  const out: Array<{ label: string; value: string; chosen: boolean }> = [];
  const chosen = quantityByKey(qs, chosenKey);
  if (chosen) {
    const value = formatSampleValue(chosen, sample);
    if (value) out.push({ label: chosen.label, value, chosen: true });
  }
  for (const q of qs) {
    if (!q.headline || q.key === chosenKey) continue;
    const value = formatSampleValue(q, sample);
    if (value) out.push({ label: q.label, value, chosen: false });
  }
  return out;
}

const csvCell = (v: unknown) => {
  const n = finite(v);
  return n == null ? '' : String(n);
};

/** One monitor's series as CSV: the time (or iteration) and each exported quantity, signed. */
export function monitorCsv(row: RunMonitor | null | undefined, qs: readonly MonitorQuantity[], timeAxis: boolean): string {
  const cols = qs.filter((q) => q.csv);
  const lines = [[timeAxis ? 'time_s' : 'iteration', ...cols.map((q) => q.csv)].join(',')];
  for (const s of (row && Array.isArray(row.series) ? row.series : []) as MonitorSample[]) {
    lines.push([csvCell(s.t), ...cols.map((q) => csvCell(pickSample(q, s)))].join(','));
  }
  return lines.join('\n');
}

/** A monitor's name as cards and exports show it. */
export function monitorName(row: RunMonitor | null | undefined): string {
  return String((row && (row.name || row.patch || row.key)) || 'Monitor');
}

/**
 * Every monitor's series in one CSV, one row per time (or iteration): each
 * monitor's number quantities (not the components of a list sample), as shown
 * (absolute values for magnitudes), headed "<monitor> <label> [<unit>]".
 */
export function monitorsCsv(rows: readonly RunMonitor[], qs: readonly MonitorQuantity[], timeAxis: boolean): string {
  const cols = qs.filter((q) => q.component == null);
  const times = new Set<number>();
  for (const m of rows) for (const s of (m.series || []) as MonitorSample[]) times.add(Number(s.t));
  const sorted = [...times].filter(Number.isFinite).sort((a, b) => a - b);
  const head = [timeAxis ? 'time_s' : 'iteration'];
  for (const m of rows) for (const q of cols) head.push(monitorName(m) + ' ' + q.label + ' [' + unitOf(q) + ']');
  const byT = rows.map((m) => {
    const map = new Map<number, MonitorSample>();
    for (const s of (m.series || []) as MonitorSample[]) map.set(Number(s.t), s);
    return map;
  });
  const lines = [head.map((h) => '"' + h.replace(/"/g, '""') + '"').join(',')];
  for (const t of sorted) {
    const row: string[] = [String(t)];
    rows.forEach((_, i) => {
      const s = byT[i].get(t);
      for (const q of cols) row.push(csvCell(s ? shownValue(q, s) : null));
    });
    lines.push(row.join(','));
  }
  return lines.join('\n');
}

/**
 * The summary line of an answer that has no `summary` (API 1.1, or a server
 * that does not pass it through): the flow balance, warning above 1 %.
 */
export function balanceSummary(balance: unknown): { items: MonitorSummaryItem[]; warn: boolean } {
  const b = balance && typeof balance === 'object' ? (balance as Record<string, unknown>) : null;
  if (!b) return { items: [], warn: false };
  const qIn = finite(b.in_m3s);
  const qOut = finite(b.out_m3s);
  if (!((qIn != null && qIn > 0) || (qOut != null && qOut > 0))) return { items: [], warn: false };
  const items: MonitorSummaryItem[] = [
    { label: 'Flow in', value: qIn, quantity: 'Q', unit: '' },
    { label: 'out', value: qOut, quantity: 'Q', unit: '' },
  ];
  const imbalance = finite(b.imbalance);
  if (imbalance == null) return { items, warn: false };
  const pct = Math.abs(imbalance) * 100;
  items.push({ label: 'imbalance', value: pct, quantity: '', unit: '%' });
  return { items, warn: pct > 1 };
}

/** The summary line's parts and whether it warns: the answer's own, else from its balance. */
export function summaryOf(answer: MonitorAnswer | null | undefined): { items: MonitorSummaryItem[]; warn: boolean } {
  if (!answer) return { items: [], warn: false };
  if (Array.isArray(answer.summary)) return { items: answer.summary, warn: !!answer.summary_warn };
  return balanceSummary(answer.balance);
}

/** The summary as one line: "<label> <value>" parts joined by ' · '. */
export function summaryText(items: readonly MonitorSummaryItem[], qs: readonly MonitorQuantity[]): string {
  return items
    .map((item) => {
      const q = quantityByKey(qs, item.quantity) || quantityByKey(LEGACY_MONITOR_QUANTITIES, item.quantity);
      const unit = String(item.unit || '');
      const value = q ? formatMonitorValue(q, item.value) : unit === '%' ? fmtPercent(item.value) : withUnit(fmtNum(item.value), unit);
      return String(item.label || '') + ' ' + value;
    })
    .join(' · ');
}

/** The monitor types a user may add (registry monitor rows), for an analysis when it lists its monitors. */
export function monitorTypes(
  rows: readonly RegistryRow[] | null | undefined,
  analysis?: (RegistryRow & { monitors?: string[] }) | null,
): RegistryRow[] {
  const allowed = analysis && Array.isArray(analysis.monitors) ? new Set(analysis.monitors) : null;
  return (rows || []).filter((r) => r && r.key && r.user_creatable && (!allowed || allowed.has(r.key)));
}

/** A result-control record as saved: its type (`monitor_type`) and the names older records carry. */
export interface MonitorRecord {
  monitor_type?: unknown;
  kind?: unknown;
  type?: unknown;
  name?: unknown;
  category?: unknown;
}

/**
 * The monitor type of a result control: its `monitor_type`, else (a record
 * saved before monitor types) the type whose label or one of whose aliases
 * appears in its kind, type, name or category, ignoring case. Null when none.
 */
export function resolveMonitorType(rc: MonitorRecord | null | undefined, types: readonly RegistryRow[]): RegistryRow | null {
  if (!rc) return null;
  const stamped = typeof rc.monitor_type === 'string' ? rc.monitor_type : '';
  if (stamped) return types.find((t) => t.key === stamped) || null;
  const text = [rc.kind, rc.type, rc.name, rc.category]
    .filter((v) => v != null && v !== '')
    .map(String)
    .join(' ')
    .toLowerCase();
  if (!text) return null;
  for (const t of types) {
    const words = [t.label, ...(t.aliases || [])].map((w) => String(w || '').trim().toLowerCase()).filter(Boolean);
    if (words.some((w) => text.includes(w))) return t;
  }
  return null;
}
