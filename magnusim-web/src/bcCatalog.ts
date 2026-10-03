import type { BcFamilyRow, BcFamilyValue } from './api/registry.gen';
import { analysisRow, siblingKey } from './analysis';
import { useProjectStore } from './store/project';
import { UNITS, preferredUnit, resolveUnit, type Quantity } from './units/convert';

/**
 * The boundary conditions the page offers, as their plugins publish them
 * (registry kind bc_family): the picker's types and hints, the legend and face
 * colours, a new record's fields, and which record field holds a value with
 * units. Nothing here names a particular analysis's BC; it reads the rows.
 */

/** The colour group of a BC: the legend swatch and the face paint. */
export type BcColor = 'inlet' | 'outlet' | 'pressure' | 'wall' | 'other';

const COLORS: ReadonlySet<string> = new Set(['inlet', 'outlet', 'pressure', 'wall', 'other']);

type BcRecordLike = Record<string, unknown> | null | undefined;

interface FieldSchema {
  type?: string;
  enum?: unknown[];
  default?: unknown;
  items?: { type?: string };
  minItems?: number;
  maxItems?: number;
}

/** Every registered BC family, in registry order. */
export function bcFamilyRows(): BcFamilyRow[] {
  return ((useProjectStore.getState().registry?.bc_family || []) as BcFamilyRow[]).filter(
    (row) => row && String(row.key || '').trim() && String(row.record_type || '').trim(),
  );
}

/**
 * The families a study of `analysisKey` offers: those with a variant among the
 * analysis's bc_types. Blank, or a name studies saved before analysis keys, is
 * the default analysis. Every family when the analysis is not installed, so a
 * record is never hidden.
 */
export function familiesFor(analysisKey: string | null | undefined): BcFamilyRow[] {
  const all = bcFamilyRows();
  const key = String(analysisKey || '').trim();
  const row = analysisRow(key) || analysisRow(siblingKey(key, 'steady'));
  if (!row || !Array.isArray(row.bc_types)) return all;
  const offered = new Set(row.bc_types.map(String));
  return all.filter((family) => (family.variants || []).some((v) => offered.has(String(v))));
}

/** A bc_type compared without case, spaces, '_' or '-' ("pressure_outlet" = "Pressure outlet"). */
function typeText(raw: unknown): string {
  return String(raw || '').toLowerCase().replace(/[\s_-]+/g, '');
}

/** The family whose record_type or one of its aliases is `type`, or undefined. */
export function familyForType(type: unknown): BcFamilyRow | undefined {
  const want = typeText(type);
  if (!want) return undefined;
  return bcFamilyRows().find((family) =>
    [family.record_type, ...(Array.isArray(family.aliases) ? family.aliases : [])].some((n) => typeText(n) === want),
  );
}

/** The family a saved BC record belongs to (its bc_type, or an older record's type). */
export function familyOf(record: BcRecordLike): BcFamilyRow | undefined {
  if (!record) return undefined;
  return familyForType(record.bc_type || record.type);
}

/** The bc_type a record is saved under: its family's record_type ("Pressure outlet" is "Pressure"), else the text as given. */
export function canonicalBcType(raw: unknown): string {
  const family = familyForType(raw);
  return family ? String(family.record_type) : String(raw || '').trim();
}

/** The colour group of a record; 'other' for a family that names none and for a record no plugin knows. */
export function colorOf(record: BcRecordLike): BcColor {
  const color = String(familyOf(record)?.color || '');
  return (COLORS.has(color) ? color : 'other') as BcColor;
}

function fieldProps(family: BcFamilyRow | undefined): Record<string, FieldSchema> {
  const props = (family?.fields as { properties?: Record<string, FieldSchema> } | null)?.properties;
  return props && typeof props === 'object' ? props : {};
}

function copy<T>(v: T): T {
  if (Array.isArray(v)) return v.slice() as unknown as T;
  if (v && typeof v === 'object') return { ...(v as object) } as T;
  return v;
}

function isBlank(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
}

/** A choice as one of its choices: exact, else ignoring case, spaces, '_' and '-', else the field default. */
export function normalizeChoice(prop: FieldSchema, value: unknown): unknown {
  const choices = Array.isArray(prop.enum) ? prop.enum : [];
  const s = typeof value === 'string' ? value.trim() : value;
  if (choices.includes(s)) return s;
  const hit = choices.find((c) => typeText(c) === typeText(s));
  if (hit !== undefined) return hit;
  return 'default' in prop ? copy(prop.default) : choices[0];
}

/** A value made to its field's type (as the BC routes store it). */
function normalizeField(prop: FieldSchema, value: unknown): unknown {
  if (Array.isArray(prop.enum) && prop.enum.length) return normalizeChoice(prop, value);
  if (prop.type === 'number' || prop.type === 'integer') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
    return 'default' in prop ? copy(prop.default) : value;
  }
  if (prop.type === 'string') return String(value).trim();
  if (prop.type === 'boolean') return value === true || value === 'true';
  if (prop.type === 'array') {
    if (!Array.isArray(value)) return copy(prop.default);
    const numeric = prop.items && (prop.items.type === 'number' || prop.items.type === 'integer');
    const n = Number.isInteger(prop.minItems) && prop.minItems === prop.maxItems ? Number(prop.minItems) : value.length;
    const out: unknown[] = [];
    for (let i = 0; i < n; i += 1) out.push(numeric ? Number(value[i]) || 0 : value[i]);
    return out;
  }
  return value;
}

/**
 * The fields of a family the study's BC defaults name (the defaults panel's
 * wall treatment is a field of the Wall family): only choice fields.
 */
function defaultsFields(family: BcFamilyRow, studyDefaults: Record<string, unknown> | null | undefined): string[] {
  const props = fieldProps(family);
  return Object.keys(studyDefaults || {}).filter((k) => {
    const choices = props[k]?.enum;
    return Array.isArray(choices) && choices.length > 1;
  });
}

/** The family's seed for a unit system (defaults.metric / defaults.imperial). */
function seedOf(family: BcFamilyRow, imperial: boolean): Record<string, unknown> {
  const d = family.defaults || {};
  const seed = (imperial ? d.imperial || d.metric : d.metric || d.imperial) || {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(seed)) out[k] = copy(v);
  return out;
}

/**
 * A new BC of `family`: its bc_type and the family's seed for the unit
 * system. A BC of the family the study's defaults use exists to differ from
 * them, so a field the defaults name starts on its first choice that is not
 * the default (default no-slip walls: a new Wall starts slip).
 */
export function newBcRecord(
  family: BcFamilyRow,
  imperial: boolean,
  studyDefaults?: Record<string, unknown> | null,
): Record<string, unknown> {
  const out: Record<string, unknown> = { bc_type: String(family.record_type), ...seedOf(family, imperial) };
  const props = fieldProps(family);
  for (const k of defaultsFields(family, studyDefaults)) {
    const current = normalizeChoice(props[k], (studyDefaults || {})[k]);
    const other = (props[k].enum || []).find((c) => c !== current);
    if (other !== undefined) out[k] = other;
  }
  return out;
}

function valueRowMatches(row: BcFamilyValue, record: Record<string, unknown>): boolean {
  return Object.entries(row.when || {}).every(([k, want]) => record[k] === want);
}

/** Which field of a record holds a value with units, its unit field and quantity (the family's first matching values row), or null. */
export function valueQuantity(
  record: BcRecordLike,
): { field: string; unit_field: string; quantity: Quantity } | null {
  if (!record) return null;
  const family = familyOf(record);
  for (const row of family?.values || []) {
    if (!row || !valueRowMatches(row, record)) continue;
    const quantity = String(row.quantity || '');
    if (!(quantity in UNITS)) return null;
    return { field: String(row.field), unit_field: String(row.unit_field), quantity: quantity as Quantity };
  }
  return null;
}

/** True when `unit` is a unit of `quantity` (an alias counts). */
export function isUnitOf(quantity: Quantity, unit: unknown): boolean {
  const raw = String(unit || '').trim();
  return !!raw && resolveUnit(quantity, raw) in UNITS[quantity];
}

/**
 * A saved record made whole for its family, as the BC routes store it: a
 * blank field takes its schema default (else the seed), choices and numbers
 * are normalized, and a missing unit is the unit system's unit for the value's
 * quantity. A record no plugin knows is returned as it is.
 */
export function completeBcRecord(record: Record<string, unknown>, imperial: boolean): Record<string, unknown> {
  const family = familyOf(record);
  if (!family) return record;
  const out: Record<string, unknown> = { ...record };
  const props = fieldProps(family);
  const seed = seedOf(family, imperial);
  const unitFields = new Set((family.values || []).map((row) => row && row.unit_field).filter(Boolean));
  for (const [k, prop] of Object.entries(props)) {
    if (unitFields.has(k) || !isBlank(out[k])) continue;
    if (prop && 'default' in prop) out[k] = copy(prop.default);
    else if (k in seed) out[k] = copy(seed[k]);
  }
  for (const [k, v] of Object.entries(seed)) {
    if (!unitFields.has(k) && !(k in props) && isBlank(out[k])) out[k] = copy(v);
  }
  for (const [k, prop] of Object.entries(props)) {
    if (!unitFields.has(k) && k in out) out[k] = normalizeField(prop, out[k]);
  }
  const vq = valueQuantity(out);
  if (vq && isBlank(out[vq.unit_field])) out[vq.unit_field] = preferredUnit(vq.quantity, imperial);
  return out;
}

/**
 * The fields a BC takes when its type changes to `family`: every seed field it
 * lacks, a choice it holds that the family does not offer, and (when its unit
 * is not one of the value's quantity) the seed value in the unit system's unit.
 */
export function typeChangeFields(
  record: Record<string, unknown>,
  family: BcFamilyRow,
  imperial: boolean,
  studyDefaults?: Record<string, unknown> | null,
): Record<string, unknown> {
  const seed = newBcRecord(family, imperial, studyDefaults);
  delete seed.bc_type;
  const props = fieldProps(family);
  const patch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(seed)) {
    if (isBlank(record[k])) patch[k] = v;
  }
  for (const [k, prop] of Object.entries(props)) {
    const cur = k in patch ? patch[k] : record[k];
    if (prop && Array.isArray(prop.enum) && prop.enum.length && !isBlank(cur) && !prop.enum.includes(cur)) {
      patch[k] = normalizeChoice(prop, cur);
    }
  }
  const next = { ...record, ...patch, bc_type: String(family.record_type) };
  const vq = valueQuantity(next);
  if (vq && (isBlank(record[vq.field]) || !isUnitOf(vq.quantity, record[vq.unit_field]))) {
    const seedValue = seed[vq.field];
    patch[vq.field] = isBlank(seedValue) ? copy(props[vq.field]?.default ?? 0) : seedValue;
    patch[vq.unit_field] = preferredUnit(vq.quantity, imperial);
  }
  return patch;
}

/** The value a choice field of a record shows (the field the study's defaults name, e.g. a Wall's treatment), or ''. */
export function defaultsChoiceText(record: BcRecordLike, studyDefaults: Record<string, unknown> | null | undefined): string {
  const family = familyOf(record);
  if (!family || !record) return '';
  const props = fieldProps(family);
  const k = defaultsFields(family, studyDefaults)[0];
  return k ? String(normalizeChoice(props[k], record[k]) ?? '') : '';
}
