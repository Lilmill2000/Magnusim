/**
 * The result fields every results tool lists (the colouring picker, iso
 * surface and volume, plot over path, cutting planes and their vectors,
 * particle trace, inspect, views and the legend). Nothing here names a
 * physics field: the list is the run's analysis's `result_fields`, filtered by
 * what the frame wrote.
 *
 * Which rows: the case sidecar's own `result_fields` when it lists them, else
 * the run's analysis's rows, else the default analysis's rows. Then only what
 * the frame wrote (the exporter's `fields_available`; unknown = keep all). A
 * case that names no analysis at all (no sidecar list and no known run
 * analysis) also lists every other field it wrote, by its own name and with no
 * unit, so its results still show; so does a case none of whose rows it wrote.
 *
 * A scalar is shown by its key, a vector X by its magnitude magX; a tensor is
 * never shown.
 */
import { siUnitLabel } from '../units/convert';

/** A plain field name: what a tool may send and a cache path may hold. */
export const FIELD_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

const TENSOR_KINDS = new Set(['symm_tensor', 'tensor']);

/** A result field row as an analysis row, the case sidecar or a meta carries it. */
export type ResultFieldRowLike = {
  key?: unknown;
  label?: unknown;
  unit_quantity?: unknown;
  kind?: unknown;
  unit?: unknown;
  magnitude_label?: unknown;
  shown?: unknown;
};

/** An analysis row (registry.describe) as far as results read it. */
export type AnalysisRowLike = { result_fields?: unknown } | null | undefined;

/** One field a results tool lists. */
export type ShownField = {
  /** What a tool colours by and sends: the key, or mag<key> for a vector. */
  name: string;
  /** The analysis's field key (a magnitude's vector). */
  key: string;
  label: string;
  /** '' when neither the analysis nor its quantity names one. */
  unit: string;
  unitQuantity: string;
  /** 'scalar', 'vector' or '' (not declared). */
  kind: string;
};

export type ResultRowsInput = {
  /** The case sidecar's result_fields; null or undefined when it lists none. */
  caseRows?: unknown;
  /** The analysis row of the run whose results show; null when not known. */
  runRow?: AnalysisRowLike;
  /** The default analysis's row. */
  defaultRow?: AnalysisRowLike;
  /** What the frame wrote (fields_available); null or undefined when not known yet. */
  wrote?: readonly string[] | null;
};

function text(value: unknown): string {
  return value == null ? '' : String(value).trim();
}

function rowsOf(row: AnalysisRowLike): unknown[] | null {
  return row && Array.isArray(row.result_fields) ? row.result_fields : null;
}

/**
 * The name a row is shown by: its `shown` (null for a tensor). A row without
 * `shown` (a sidecar row, or a row from before API 1.4) shows a vector X as
 * magX and anything else by its key; when it does not say its kind, the frame
 * tells (magX written and X not means X is a vector).
 */
export function rowShownName(row: unknown, wrote?: readonly string[] | null): string | null {
  const r = (typeof row === 'string' ? { key: row } : row) as ResultFieldRowLike | null;
  if (!r || typeof r !== 'object') return null;
  const key = text(r.key);
  if (!FIELD_NAME_RE.test(key)) return null;
  if ('shown' in r) {
    const shown = text(r.shown);
    return FIELD_NAME_RE.test(shown) ? shown : null;
  }
  const kind = text(r.kind).toLowerCase();
  if (TENSOR_KINDS.has(kind)) return null;
  if (kind === 'vector') return 'mag' + key;
  if (!kind && wrote && !wrote.includes(key) && wrote.includes('mag' + key)) return 'mag' + key;
  return key;
}

function shownField(row: ResultFieldRowLike, name: string): ShownField {
  const key = text(row.key);
  const vector = name !== key && name === 'mag' + key;
  const label = text(row.label) || key;
  const unit = text(row.unit) || siUnitLabel(text(row.unit_quantity).toLowerCase());
  return {
    name,
    key,
    label: vector ? text(row.magnitude_label) || label + ' Magnitude' : label,
    unit,
    unitQuantity: text(row.unit_quantity).toLowerCase(),
    kind: vector ? 'vector' : 'scalar',
  };
}

/** The fields results list for a case, in the analysis's order (see the file comment). */
export function resultRowsFor(input: ResultRowsInput): ShownField[] {
  const wrote = Array.isArray(input.wrote) ? input.wrote.map(String) : null;
  const caseRows = Array.isArray(input.caseRows) ? input.caseRows : null;
  const runRows = rowsOf(input.runRow);
  const rows = caseRows || runRows || rowsOf(input.defaultRow) || [];
  const out: ShownField[] = [];
  const seen = new Set<string>();
  for (const raw of rows) {
    const row = (typeof raw === 'string' ? { key: raw } : raw) as ResultFieldRowLike;
    const name = rowShownName(row, wrote);
    if (!name || seen.has(name)) continue;
    if (wrote && !wrote.includes(name)) continue;
    seen.add(name);
    out.push(shownField(row, name));
  }
  // A case whose analysis is not known lists what else it wrote, by name; so
  // does a case none of whose rows it wrote (rather than nothing at all).
  if (wrote && ((!caseRows && !runRows) || !out.length)) {
    for (const name of wrote) {
      if (!FIELD_NAME_RE.test(name) || seen.has(name)) continue;
      seen.add(name);
      out.push({ name, key: name, label: name, unit: '', unitQuantity: '', kind: '' });
    }
  }
  return out;
}

/** The field a tool opens on: `current` when listed, else the first ('' when none). */
export function defaultResultField(fields: readonly ShownField[], current?: string | null): string {
  const cur = text(current);
  if (cur && fields.some((f) => f.name === cur)) return cur;
  return fields.length ? fields[0].name : '';
}

/** { name, label, unit } of a shown field: its row's, else its own name and no unit. */
export function fieldInfoIn(fields: readonly ShownField[], name: string): { name: string; label: string; unit: string } {
  const hit = fields.find((f) => f.name === name);
  return hit ? { name, label: hit.label, unit: hit.unit } : { name, label: name, unit: '' };
}

export type ToolOption = { value: string; label: string };

/** A tool picker's options: every listed field, then a solid colour when the tool has one. */
export function toolOptions(fields: readonly ShownField[], opts?: { solid?: string }): ToolOption[] {
  const out: ToolOption[] = fields.map((f) => ({ value: f.name, label: f.label }));
  if (opts && opts.solid) out.push({ value: 'solid', label: opts.solid });
  return out;
}

/**
 * The vector particles follow and glyphs draw: the first listed vector
 * measured as a velocity ('' when the frame wrote none).
 */
export function velocityVectorName(fields: readonly ShownField[]): string {
  const hit = fields.find((f) => f.kind === 'vector' && f.unitQuantity === 'velocity');
  return hit ? hit.key : '';
}

type FilterSetLike = {
  field?: unknown;
  scale?: unknown;
  pt?: unknown;
  [key: string]: unknown;
};

/**
 * A saved filter set (a view, v:1) for a case that shows `shownNames`: its
 * colouring field and its particle colouring when listed, else the first
 * listed field; only plain field names keep a colour scale. A set whose fields
 * are all listed comes back unchanged. Nothing changes while the list is not
 * known (empty).
 */
export function normalizeFilterSet<T extends FilterSetLike | null | undefined>(set: T, shownNames: readonly string[]): T {
  if (!set || typeof set !== 'object' || !shownNames.length) return set;
  const pick = (value: unknown) => {
    const name = text(value);
    return FIELD_NAME_RE.test(name) && shownNames.includes(name) ? name : shownNames[0];
  };
  const out: FilterSetLike = { ...set };
  if (text(set.field) !== 'cellVolume') out.field = pick(set.field);
  const pt = set.pt && typeof set.pt === 'object' ? (set.pt as Record<string, unknown>) : null;
  if (pt && pt.coloring != null && text(pt.coloring) !== 'solid') {
    const coloring = pick(pt.coloring);
    if (coloring !== pt.coloring) out.pt = { ...pt, coloring };
  }
  if (set.scale && typeof set.scale === 'object') {
    const scale: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(set.scale as Record<string, unknown>)) {
      if (FIELD_NAME_RE.test(k)) scale[k] = v;
    }
    out.scale = scale;
  }
  return out as T;
}
