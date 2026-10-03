import type { RegistryRow } from './api/registry.gen';
import { analysisRow, defaultAnalysisKey } from './analysis';
import { useProjectStore } from './store/project';
import type { Quantity } from './units/convert';

/**
 * What the Materials panel shows and saves comes from the study's material
 * model (its registry row, registry kind "material"): the fluids it offers
 * (presets), the property fields, and how a saved record stores the values.
 * Nothing here names a particular fluid or property.
 */

/** One preset of a material model: a fluid the Fluid picker offers. */
export interface MaterialPreset {
  key: string;
  name: string;
  /** Property values in SI, e.g. { nu: 1.516e-5, rho: 1.204 }. */
  values?: Record<string, number>;
  /** What a saved record of this preset that lacks a number reads (older versions' fill-in); else `values`. */
  legacy_values?: Record<string, number>;
  /** The library code a record of it saves. */
  library?: string;
  /** Library codes a saved record may carry for it. */
  codes?: string[];
  /** Record names (any case) that read as it. */
  names?: string[];
}

interface PropertySchema {
  title?: string;
  default?: unknown;
  minimum?: number;
  'x-cfddesk'?: { unit?: string; quantity?: string };
}

/** A material model's registry row (API 1.4 adds library, record_keys, record_constants, custom_preset). */
export interface MaterialModelRow {
  key: string;
  label?: string;
  schema?: { properties?: Record<string, PropertySchema> } | null;
  library?: MaterialPreset[];
  record_keys?: Record<string, string[]>;
  record_constants?: Record<string, unknown>;
  custom_preset?: string;
}

/** One property field of a model (from its schema). */
export interface MaterialProperty {
  key: string;
  label: string;
  quantity: Quantity | null;
  /** The schema's own unit label, for a property with no quantity. */
  unit: string;
  min?: number;
}

/** A material record as saved on disk (what the case writer reads). */
export interface SavedMaterial {
  id?: string;
  name?: string;
  library?: string;
  preset?: string;
  material_model?: string;
  assigned_volumes?: string[];
  simulation_id?: string;
  created_at?: string;
  [key: string]: unknown;
}

export function materialModelRows(): MaterialModelRow[] {
  const rows = (useProjectStore.getState().registry?.material || []) as RegistryRow[];
  return rows.filter((row) => String(row.key || '').trim()) as unknown as MaterialModelRow[];
}

/**
 * The material model of an analysis: the first of its material_models that is
 * registered. A blank or unknown key reads the default analysis. An analysis
 * row that does not say (no material_models) gets the first model.
 */
export function modelFor(analysisKey?: string | null, rows: MaterialModelRow[] = materialModelRows()): MaterialModelRow | undefined {
  if (!rows.length) return undefined;
  const analysis = analysisRow(analysisKey) || analysisRow(defaultAnalysisKey());
  const keys = analysis?.material_models;
  if (!Array.isArray(keys)) return rows[0];
  for (const key of keys) {
    const hit = rows.find((row) => row.key === key);
    if (hit) return hit;
  }
  return undefined;
}

export function presets(model: MaterialModelRow | undefined): MaterialPreset[] {
  return (Array.isArray(model?.library) ? model.library : []).filter((p) => p && String(p.key || '').trim());
}

/** The key of the preset a record has once its values are its own. */
export function customPresetKey(model: MaterialModelRow | undefined): string {
  return String(model?.custom_preset || 'custom');
}

export function presetByKey(model: MaterialModelRow | undefined, key: unknown): MaterialPreset | undefined {
  const want = String(key || '');
  return want ? presets(model).find((p) => p.key === want) : undefined;
}

function codesOf(p: MaterialPreset): string[] {
  const codes = Array.isArray(p.codes) && p.codes.length ? p.codes : p.library ? [p.library] : [];
  return codes.map((c) => String(c).toUpperCase());
}

function namesOf(p: MaterialPreset): string[] {
  return (Array.isArray(p.names) ? p.names : [p.name]).map((n) => String(n).trim().toLowerCase());
}

/** A new material's preset: the one whose codes include DEFAULT, else the first that is not custom. */
export function defaultPreset(model: MaterialModelRow | undefined): MaterialPreset | undefined {
  const list = presets(model);
  const custom = customPresetKey(model);
  return list.find((p) => codesOf(p).includes('DEFAULT')) || list.find((p) => p.key !== custom) || list[0];
}

/**
 * The preset a saved record is: its preset key, else its library code (one of
 * a preset's codes), else its name (one of a preset's names, any case), else
 * the default preset when it has no name, else custom.
 */
export function presetOf(
  model: MaterialModelRow | undefined,
  record: { preset?: unknown; library?: unknown; name?: unknown } | null | undefined,
): MaterialPreset | undefined {
  const list = presets(model);
  if (!list.length) return undefined;
  const byKey = presetByKey(model, record?.preset);
  if (byKey) return byKey;
  const code = String(record?.library || '').trim().toUpperCase();
  const byCode = code ? list.find((p) => codesOf(p).includes(code)) : undefined;
  if (byCode) return byCode;
  const name = String(record?.name || '').trim().toLowerCase();
  if (!name) return defaultPreset(model);
  return list.find((p) => namesOf(p).includes(name)) || presetByKey(model, customPresetKey(model));
}

/** The model's property fields, in schema order. */
export function properties(model: MaterialModelRow | undefined): MaterialProperty[] {
  const props = model?.schema?.properties || {};
  return Object.entries(props).map(([key, p]) => {
    const x = (p && p['x-cfddesk']) || {};
    return {
      key,
      label: String(p?.title || key),
      quantity: (x.quantity as Quantity) || null,
      unit: String(x.unit || ''),
      ...(typeof p?.minimum === 'number' ? { min: p.minimum } : {}),
    };
  });
}

/** The record keys that may hold a property, the first preferred (the model's record_keys, else the key). */
export function recordKeys(model: MaterialModelRow | undefined, key: string): string[] {
  const keys = model?.record_keys?.[key];
  return Array.isArray(keys) && keys.length ? keys.map(String) : [key];
}

function positive(raw: unknown): number | undefined {
  if (raw === null || raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** A preset's values (a fresh copy). */
export function presetValues(p: MaterialPreset | undefined): Record<string, number> {
  return { ...(p?.values || {}) };
}

/**
 * A saved record's property values. A property it lacks reads its preset's
 * legacy_values (what older versions filled in), else the preset's values, so
 * an older project shows and solves with the numbers it always had.
 */
export function recordValues(
  model: MaterialModelRow | undefined,
  record: SavedMaterial | null | undefined,
): Record<string, number> {
  const p = presetOf(model, record);
  // No record yet: a new material, which gets its preset's values.
  if (!record) return presetValues(p);
  const fill = { ...presetValues(p), ...(p?.legacy_values || {}) };
  const out: Record<string, number> = {};
  const keys = new Set([...properties(model).map((prop) => prop.key), ...Object.keys(fill)]);
  for (const key of keys) {
    const saved = recordKeys(model, key)
      .concat(key)
      .map((k) => positive(record?.[k]))
      .find((v) => v !== undefined);
    const v = saved ?? positive(fill[key]);
    if (v !== undefined) out[key] = v;
  }
  return out;
}

/**
 * recordValues under each property's preferred record key, e.g.
 * { kinematic_viscosity, density }: what a material record of `record` holds,
 * or a new one (no record) gets.
 */
export function recordFields(
  model: MaterialModelRow | undefined,
  record: SavedMaterial | null | undefined,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, v] of Object.entries(recordValues(model, record))) out[recordKeys(model, key)[0]] = v;
  return out;
}

/**
 * The record a material saves (the keys POST /api/materials writes): the
 * model's record_constants, each value under every record key of its
 * property, the preset's library code, material_model and preset. Older app
 * versions read name, library, kinematic_viscosity/nu and density/rho, so they
 * stay. A custom preset keeps the given name, else the record's own.
 */
export function materialRecord(
  model: MaterialModelRow,
  base: SavedMaterial | null,
  fields: { preset: string; name?: string; values: Record<string, number>; volumes: string[] },
  ids: { simulation_id?: string; geometry_id?: string; project_id?: string; id?: string },
  now: string,
): SavedMaterial {
  const p = presetByKey(model, fields.preset) || presetOf(model, base) || defaultPreset(model);
  const custom = !p || p.key === customPresetKey(model);
  const baseCustom = presetOf(model, base)?.key === customPresetKey(model);
  const name = custom
    ? String(fields.name || (baseCustom ? base?.name : '') || p?.name || '').trim() || String(p?.name || '')
    : String(p?.name || '');
  const volumes = fields.volumes.map(String);
  const values: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(fields.values)) {
    for (const k of recordKeys(model, key)) values[k] = v;
  }
  return {
    ...(base || {}),
    id: base?.id || ids.id || newMaterialId(),
    name,
    ...(model.record_constants || {}),
    ...values,
    library: String(p?.library || (p ? codesOf(p)[0] : '') || ''),
    material_model: model.key,
    preset: String(p?.key || customPresetKey(model)),
    assigned_volumes: volumes,
    assigned_volume: volumes[0] || null,
    // The Python material model reads body_ids first; keep the aliases in step.
    body_ids: volumes.slice(),
    volume_ids: volumes.slice(),
    ...(ids.simulation_id ? { simulation_id: ids.simulation_id } : {}),
    ...(ids.geometry_id ? { geometry_id: ids.geometry_id } : {}),
    ...(ids.project_id ? { project_id: ids.project_id } : {}),
    saved: true,
    created_at: base?.created_at || now,
    updated_at: now,
  };
}

function newMaterialId(): string {
  const bytes = new Uint8Array(3);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `mat-${Date.now().toString(36)}-${hex}`;
}
