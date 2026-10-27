/**
 * catalog (Core host tools spec 4.2): what the app offers, from the registry and the
 * plugins list: analyses, BC types, material presets, meshers and their settings,
 * refinement types, monitors, result filters, plugin study kinds, start actions, samples
 * and plugins. With a key, that item's fields: key, type, unit, allowed values, range, as
 * setup_edit and study_edit take them in `values`. Not project data.
 */
import type { ToolOutcome, ToolRunContext } from '../registry.ts';
import { cleanText } from '../sanitize.ts';
import {
  failed,
  fail,
  fieldInfo,
  flattenSchema,
  hostTool,
  isRecord,
  objectSchema,
  offeredIn,
  okData,
  records,
  S,
  str,
  text,
  via,
  type Field,
  type HostToolDeps,
  type HostToolDef,
} from './common.ts';

export const CATALOG_KINDS = [
  'analyses',
  'bc_types',
  'materials',
  'meshers',
  'mesh_settings',
  'refinement_types',
  'monitors',
  'filters',
  'study_kinds',
  'start_actions',
  'samples',
  'plugins',
] as const;

/** The most of a catalog answer, in bytes of JSON. */
const CATALOG_MAX_BYTES = 12 * 1024;

/** The refinement types the core makes (w26 REF_TYPES), with the fields each takes. */
export const REFINEMENT_FIELDS: Readonly<Record<string, Field[]>> = Object.freeze({
  'Surface custom sizing': [
    field('sizing', 'string', 'Sizing', { enum: ['Automatic', 'Custom'] }),
    field('fineness', 'integer', 'Fineness', { min: 1, max: 10 }),
    field('default_size', 'number', 'Element size', { min: 0, unitKey: 'default_size_unit' }),
    field('default_size_unit', 'string', 'Element size unit', { enum: ['mm', 'm', 'in'] }),
    field('min_size', 'number', 'Minimum size', { min: 0 }),
    field('min_size_unit', 'string', 'Minimum size unit', { enum: ['mm', 'm', 'in'] }),
  ],
  'Inflate boundary layer': [
    field('n_layers', 'integer', 'Layers', { min: 1, max: 50 }),
    field('total_thickness', 'number', 'Total thickness', { min: 0 }),
    field('total_thickness_unit', 'string', 'Total thickness unit', { enum: ['mm', 'm', 'in'] }),
  ],
});

function field(key: string, type: string, label: string, o: { enum?: unknown[]; min?: number; max?: number; unit?: string; unitKey?: string; items?: string; minItems?: number; maxItems?: number; description?: string } = {}): Field {
  return {
    key,
    type,
    label,
    unit: o.unit ?? '',
    enum: o.enum ?? null,
    min: o.min ?? null,
    max: o.max ?? null,
    items: o.items ?? null,
    min_items: o.minItems ?? null,
    max_items: o.maxItems ?? null,
    description: o.description ?? '',
  };
}

/** The keys of the mesh settings the core models (w20 buildSettings), beside a mesher's own. */
const CORE_MESH_SCHEMA_KEYS = new Set(['fineness', 'add_layers', 'physics_based', 'hex_element_core', 'small_feature_suppression', 'gap_refinement_factor', 'global_gradation_rate']);

/** A mesher's settings fields as setup_edit {kind:'mesh', action:'update'} takes them (the buildSettings keys). */
export function meshFields(registry: Record<string, unknown>, engine: string): Field[] {
  const meshers = records(registry.mesher);
  const row = meshers.find((m) => m.key === engine) ?? null;
  const schema = flattenSchema(row?.schema);
  const label = (k: string, fallback: string) => schema.find((f) => f.key === k)?.label ?? fallback;
  const out: Field[] = [
    field('fineness', 'integer', label('fineness', 'Fineness'), { min: 1, max: 10 }),
    field('automatic_boundary_layers', 'boolean', label('add_layers', 'Automatic boundary layers')),
    field('physics_based_meshing', 'boolean', label('physics_based', 'Physics-based meshing')),
    field('hex_element_core', 'boolean', label('hex_element_core', 'Hex element core')),
    field('advanced.small_feature_suppression', 'string', label('small_feature_suppression', 'Small feature suppression'), { unit: 'm', description: '"" = automatic' }),
    field('advanced.mesh_engine', 'string', 'Mesher', { enum: meshers.map((m) => m.key).filter((k): k is string => typeof k === 'string') }),
    field('advanced.gap_refinement_factor', 'number', label('gap_refinement_factor', 'Gap refinement factor'), { min: 0 }),
    field('advanced.global_gradation_rate', 'number', label('global_gradation_rate', 'Global gradation rate'), { min: 1, max: 3 }),
  ];
  // A mesher's own fields (not modelled by the core) live under mesher_settings.
  for (const f of schema) if (!CORE_MESH_SCHEMA_KEYS.has(f.key)) out.push({ ...f, key: `mesher_settings.${f.key}` });
  return out;
}

/** The run settings fields of a study's analysis (setup_edit {kind:'run', action:'update'}). */
export function runFields(registry: Record<string, unknown>, analysisKey: string): Field[] {
  const analyses = records(registry.analysis);
  const row = analyses.find((a) => a.key === analysisKey) ?? null;
  const family = row ? str(row.family) || str(row.plugin) : '';
  // The transient sibling's control schema names the transient keys.
  const transient =
    (row && row.time_dependency === 'transient' ? row : null) ??
    analyses.find((a) => a.time_dependency === 'transient' && (str(a.family) || str(a.plugin)) === family) ??
    null;
  const out: Field[] = [
    field('endTime', 'integer', 'Iterations (steady)', { min: 1 }),
    field('writeInterval', 'integer', 'Save every (steady)', { min: 1 }),
    field('cores', 'integer', 'Cores', { min: 1, max: 256, description: 'null = Auto' }),
    field('mesh_id', 'string', 'Mesh', { description: 'a mesh id from read_setup meshes' }),
  ];
  for (const f of flattenSchema(transient?.control_schema)) out.push({ ...f, key: `transient.${f.key}` });
  return out;
}

/** A study's settings fields: its analysis's settings and numerics schemas. */
export function studyFields(registry: Record<string, unknown>, analysisKey: string): Field[] {
  const row = records(registry.analysis).find((a) => a.key === analysisKey) ?? null;
  return [...flattenSchema(row?.schema ?? row?.settings_schema), ...flattenSchema(row?.numerics_schema)];
}

/** A BC family by its key, its record type or its label. */
export function bcFamily(registry: Record<string, unknown>, type: string): Record<string, unknown> | null {
  const t = type.trim().toLowerCase();
  return records(registry.bc_family).find((f) => [f.key, f.record_type, f.label].some((v) => typeof v === 'string' && v.toLowerCase() === t)) ?? null;
}

/** A material model by its key, or the model of a preset key. */
export function materialModel(registry: Record<string, unknown>, key: string): { model: Record<string, unknown>; preset: Record<string, unknown> | null } | null {
  for (const m of records(registry.material)) {
    if (m.key === key) return { model: m, preset: null };
    const p = records(m.library).find((x) => x.key === key);
    if (p) return { model: m, preset: p };
  }
  return null;
}

/** Trims a list to the answer size, saying how many more there are. */
function capped<T>(list: T[], name: string): { items: T[]; more: string } {
  const out: T[] = [];
  let bytes = 0;
  for (const item of list) {
    bytes += JSON.stringify(item).length + 1;
    if (bytes > CATALOG_MAX_BYTES) break;
    out.push(item);
  }
  return { items: out, more: out.length < list.length ? `${list.length - out.length} more ${name}; pass a key` : '' };
}

export function catalogTool(d: HostToolDeps): HostToolDef {
  const contexts = ['home', 'workbench'] as const;
  return hostTool({
    name: 'catalog',
    title: 'Read what the app offers',
    description:
      'Lists analyses, BC types, material presets, meshers, mesh settings, refinement types, monitors, filters, plugin study kinds, start actions, samples or plugins. key "" lists the kind; a key gives its fields (key, type, unit, allowed values, range) for values.',
    schema: objectSchema({
      kind: S.enum(CATALOG_KINDS),
      key: S.text(120, '"" lists the kind; a key gives that item\'s fields (key, type, unit, allowed values, range).'),
    }),
    risk: 'read',
    projectData: false,
    priority: 74,
    workerBacked: true,
    contexts,
    available: offeredIn(contexts),
    async run(input: Record<string, unknown>, rt: ToolRunContext): Promise<ToolOutcome> {
      const kind = str(input.kind);
      const key = str(input.key).trim();
      try {
        const o = via(rt, `catalog.${kind}`);
        if (['study_kinds', 'start_actions', 'samples', 'plugins'].includes(kind)) {
          const list = records(((await d.hostCall('plugins.list', {}, o)) as Record<string, unknown>).plugins);
          return pluginKinds(kind, key, list);
        }
        const registry = (await d.hostCall('registry.get', {}, o)) as Record<string, unknown>;
        const pick = <T extends Record<string, unknown>>(rows: T[], what: string): T | ToolOutcome => {
          const hit = rows.find((r) => r.key === key);
          return hit ?? fail('not_found', `No ${what} "${cleanText(key, 80)}".`, `catalog {kind:'${kind}', key:''} lists them.`);
        };
        switch (kind) {
          case 'analyses': {
            const rows = records(registry.analysis);
            if (!key) {
              const list = rows.map((a) => ({ key: text(a.key, 80), label: text(a.label), plugin: text(a.plugin, 64), time_dependency: text(a.time_dependency, 20) }));
              return answer({ analyses: list, default_analysis: registry.default_analysis ?? null }, `${list.length} analyses`);
            }
            const a = pick(rows, 'analysis');
            if (!isRecord(a) || 'ok' in a) return a as ToolOutcome;
            return answer(
              {
                key,
                label: text(a.label),
                time_dependency: text(a.time_dependency, 20),
                settings: studyFields(registry, key).map(fieldInfo),
                run_settings: runFields(registry, key).map(fieldInfo),
                bc_types: Array.isArray(a.bc_types) ? a.bc_types : [],
                material_models: Array.isArray(a.material_models) ? a.material_models : [],
                monitors: Array.isArray(a.monitors) ? a.monitors : [],
                default_mesher: text(a.default_mesher, 64),
              },
              `Analysis ${key}`,
            );
          }
          case 'bc_types': {
            const families = records(registry.bc_family);
            if (!key) {
              let menu: unknown[] = [];
              try {
                menu = records(((await d.hostCall('bc.menu', {}, o)) as Record<string, unknown>).menu).map((m) => ({
                  key: text(m.key, 64),
                  label: text(m.label),
                  variants: records(m.variants).map((v) => ({ key: text(v.key, 64), label: text(v.label) })),
                }));
              } catch {
                menu = [];
              }
              const list = families.map((f) => ({ key: text(f.key, 64), type: text(f.record_type), label: text(f.label), plugin: text(f.plugin, 64) }));
              return answer({ types: list, menu, note: "setup_edit takes `type` (a record type from this list's `type`) and the family fields in values." }, `${list.length} BC types`);
            }
            const f = bcFamily(registry, key);
            if (!f) return fail('not_found', `No BC type "${cleanText(key, 80)}".`, "catalog {kind:'bc_types', key:''} lists them.");
            const unitFields = records(f.values).map((r) => ({ field: text(r.field, 64), unit_field: text(r.unit_field, 64), quantity: text(r.quantity, 64), when: isRecord(r.when) ? r.when : {} }));
            // A value with its own unit field is in the unit that field names, not the SI one.
            const byUnitField = new Map(unitFields.filter((u) => u.field && u.unit_field).map((u) => [u.field, u.unit_field]));
            const fields = flattenSchema(f.fields).map((x) => (byUnitField.has(x.key) ? { ...x, unit: `the unit in ${byUnitField.get(x.key)}` } : x));
            return answer(
              { key: text(f.key, 64), type: text(f.record_type), label: text(f.label), fields: fields.map(fieldInfo), units: unitFields, defaults: isRecord(f.defaults) ? f.defaults : {} },
              `BC type ${text(f.label)}`,
            );
          }
          case 'materials': {
            const models = records(registry.material);
            if (!key) {
              const presets = models.flatMap((m) =>
                records(m.library).map((p) => ({ key: text(p.key, 64), label: text(p.name), model: text(m.key, 64), kind: (isRecord(m) && m.role === 'solid') || /solid/.test(str(m.key)) ? 'solid' : 'fluid' })),
              );
              const c = capped(presets, 'presets');
              return answer({ models: models.map((m) => ({ key: text(m.key, 64), label: text(m.label), plugin: text(m.plugin, 64) })), presets: c.items, ...(c.more ? { more: c.more } : {}) }, `${presets.length} material presets`);
            }
            const hit = materialModel(registry, key);
            if (!hit) return fail('not_found', `No material or preset "${cleanText(key, 80)}".`, "catalog {kind:'materials', key:''} lists them.");
            return answer(
              {
                model: text(hit.model.key, 64),
                label: text(hit.preset?.name ?? hit.model.label),
                fields: flattenSchema(hit.model.schema).map(fieldInfo),
                ...(hit.preset ? { values: isRecord(hit.preset.values) ? hit.preset.values : {} } : {}),
              },
              `Material ${key}`,
            );
          }
          case 'meshers': {
            const list = records(registry.mesher).map((m) => ({
              key: text(m.key, 64),
              label: text(m.label),
              refinement_types: records(m.refinement_types).map((r) => text(r.label)),
            }));
            return answer({ meshers: list }, `${list.length} meshers`);
          }
          case 'mesh_settings': {
            const engine = key || str(records(registry.mesher)[0]?.key);
            if (!records(registry.mesher).some((m) => m.key === engine)) return fail('not_found', `No mesher "${cleanText(engine, 80)}".`, "catalog {kind:'meshers', key:''} lists them.");
            return answer({ mesher: engine, fields: meshFields(registry, engine).map(fieldInfo) }, `Mesh settings of ${engine}`);
          }
          case 'refinement_types': {
            if (!key) return answer({ types: Object.keys(REFINEMENT_FIELDS) }, `${Object.keys(REFINEMENT_FIELDS).length} refinement types`);
            const fields = REFINEMENT_FIELDS[key];
            if (!fields) return fail('not_found', `No refinement type "${cleanText(key, 80)}".`, "catalog {kind:'refinement_types', key:''} lists them.");
            return answer({ type: key, fields: fields.map(fieldInfo) }, `Refinement ${key}`);
          }
          case 'monitors': {
            const rows = records(registry.monitor);
            if (!key) {
              const list = rows.filter((m) => m.user_creatable !== false).map((m) => ({ key: text(m.key, 64), label: text(m.label), target: text(m.target ?? 'patch', 20), plugin: text(m.plugin, 64) }));
              return answer({ monitors: list }, `${list.length} monitor types`);
            }
            const m = pick(rows, 'monitor type');
            if (!isRecord(m) || 'ok' in m) return m as ToolOutcome;
            const target = str(m.target) || 'patch';
            return answer(
              {
                key,
                label: text(m.label),
                target,
                places: target === 'point' ? 'values points: [[x,y,z], ...] in metres' : target === 'boundary' ? 'values boundaries: BC ids (or "@walls")' : 'faces',
                fields: flattenSchema(m.schema).map(fieldInfo),
                quantities: Array.isArray(m.quantities) ? m.quantities : [],
              },
              `Monitor ${key}`,
            );
          }
          case 'filters': {
            const rows = records(registry.filter);
            if (!key) return answer({ filters: rows.map((f) => ({ key: text(f.key, 64), label: text(f.label), plugin: text(f.plugin, 64) })) }, `${rows.length} filters`);
            const f = pick(rows, 'filter');
            if (!isRecord(f) || 'ok' in f) return f as ToolOutcome;
            return answer({ key, label: text(f.label), fields: flattenSchema(f.schema).map(fieldInfo) }, `Filter ${key}`);
          }
          default:
            return fail('invalid_input', `Unknown kind "${cleanText(kind, 40)}".`);
        }
      } catch (err) {
        return failed(err);
      }
    },
  });
}

function answer(data: Record<string, unknown>, summary: string): ToolOutcome {
  return okData(data, summary);
}

/** study_kinds, start_actions, samples and plugins, from the plugins list. */
function pluginKinds(kind: string, key: string, plugins: Record<string, unknown>[]): ToolOutcome {
  const on = plugins.filter((p) => p.enabled !== false);
  if (kind === 'plugins') {
    const list = plugins.map((p) => ({ key: text(p.key, 64), name: text(p.name), version: text(p.version, 40), on: p.enabled !== false, status: text(p.status, 40) }));
    const rows = key ? list.filter((p) => p.key === key) : list;
    if (key && !rows.length) return fail('not_found', `No plugin "${cleanText(key, 64)}".`, "catalog {kind:'plugins', key:''} lists them.");
    return okData({ plugins: rows }, `${rows.length} plugins`);
  }
  if (kind === 'samples') {
    const list = on.flatMap((p) => records(p.samples).map((s) => ({ plugin: text(p.key, 64), key: text(s.key, 120), title: text(s.title), hint: text(s.hint, 300) })));
    const rows = key ? list.filter((s) => s.key === key) : list;
    if (key && !rows.length) return fail('not_found', `No sample "${cleanText(key, 120)}".`, "catalog {kind:'samples', key:''} lists them.");
    return okData({ samples: capped(rows, 'samples').items }, `${rows.length} samples`);
  }
  // Start actions name the study kind a plugin's workspace starts (Home's start buttons);
  // geometry actions the kind that edits a geometry (Edit in CAD).
  const row = (p: Record<string, unknown>, a: Record<string, unknown>, editsGeometry: boolean) => ({
    plugin: text(p.key, 64),
    key: text(a.study_kind, 80),
    title: text(a.kind_title),
    workspace: text(a.workspace, 80),
    label: text(a.label ?? a.home_label),
    ...(kind === 'study_kinds' ? { edits_geometry: editsGeometry } : {}),
  });
  const list = on.flatMap((p) => [
    ...records(p.start_actions).map((a) => row(p, a, false)),
    ...(kind === 'study_kinds' ? records(p.geometry_actions).map((a) => row(p, a, true)) : []),
  ]);
  const rows = key ? list.filter((s) => s.key === key) : list;
  if (key && !rows.length) return fail('not_found', `No study kind "${cleanText(key, 80)}".`, `catalog {kind:'${kind}', key:''} lists them.`);
  return okData({ [kind]: rows }, `${rows.length} ${kind.replace('_', ' ')}`);
}
