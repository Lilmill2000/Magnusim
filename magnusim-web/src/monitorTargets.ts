/**
 * Where a monitor is placed, by its type's `target` (registry monitor rows):
 * faces it is assigned in the viewport ('patch'), whole boundaries picked from
 * the study's BCs ('boundary'), or points in the fluid ('point'). What a new
 * result control of each saves, the boundaries a 'boundary' monitor may take
 * (by the BC semantics its type names), and whether a BC has a patch of its
 * own in a mesh. Nothing here knows a particular physics.
 */
import type { RegistryRow } from './api/registry.gen';

/** What a 'boundary' monitor saves for the walls no BC claims (the mesh's `walls` patch). */
export const DEFAULT_WALLS_TOKEN = '@walls';
export const DEFAULT_WALLS_LABEL = 'Walls with no boundary condition';

export type MonitorTarget = 'patch' | 'boundary' | 'point' | (string & {});

export interface BoundaryChoice {
  /** What the result control saves: the BC's id (its name when it has none), or DEFAULT_WALLS_TOKEN. */
  token: string;
  label: string;
  /** The BC's name (the mesh names its patch from it); '' for the walls no BC claims. */
  bcName: string;
}

type BcLike = { id?: unknown; name?: unknown; faces?: unknown; [k: string]: unknown };

/** The target of a monitor type row ('patch' when it names none, as area averages did). */
export function targetOf(row: RegistryRow | null | undefined): MonitorTarget {
  return String((row && row.target) || 'patch');
}

/**
 * The boundaries a 'boundary' monitor may be placed on: the study's BCs that
 * have faces and whose BC family its type's `boundary_kinds` lists (any when
 * it lists none), then the walls no BC claims when it takes walls.
 */
export function boundaryChoices(
  bcs: readonly BcLike[] | null | undefined,
  kinds: readonly string[] | null | undefined,
  familyOf: (bc: BcLike) => string,
): BoundaryChoice[] {
  const want = Array.isArray(kinds) && kinds.length ? new Set(kinds.map(String)) : null;
  const out: BoundaryChoice[] = [];
  const seen = new Set<string>();
  for (const bc of bcs || []) {
    if (!bc || !Array.isArray(bc.faces) || !bc.faces.length) continue;
    if (want && !want.has(familyOf(bc))) continue;
    const name = String(bc.name || '').trim();
    const token = bc.id != null && String(bc.id) ? String(bc.id) : name;
    if (!token || seen.has(token)) continue;
    seen.add(token);
    out.push({ token, label: name || token, bcName: name });
  }
  if (!want || want.has('wall')) out.push({ token: DEFAULT_WALLS_TOKEN, label: DEFAULT_WALLS_LABEL, bcName: '' });
  return out;
}

/** A BC's mesh patch name, as the mesher makes it (magnusim_sdk.study.sanitize_patch_name). */
export function sanitizePatchName(label: string): string {
  let s = String(label || '')
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
  if (!s) return 'patch';
  if (/^[0-9]/.test(s)) s = 'p_' + s;
  return s;
}

/** The patch names a mesh record lists (strings or {name}), or null when it lists none. */
export function meshPatchNames(mesh: Record<string, unknown> | null | undefined): string[] | null {
  if (!mesh) return null;
  const live = (mesh.live_mesh_result || {}) as Record<string, unknown>;
  for (const raw of [mesh.patches, live.patches, live.patch_names, mesh.patch_names]) {
    if (!Array.isArray(raw) || !raw.length) continue;
    const names = raw
      .map((p) => (p && typeof p === 'object' ? (p as { name?: unknown }).name : p))
      .map((p) => String(p || '').trim())
      .filter(Boolean);
    if (names.length) return names;
  }
  return null;
}

/**
 * True when a mesh with these patches has none for this boundary (a BC added
 * after the mesh: its faces are in another patch). False when the patches are
 * not known.
 */
export function boundaryLacksPatch(choice: BoundaryChoice, patches: readonly string[] | null): boolean {
  if (!patches) return false;
  if (choice.token === DEFAULT_WALLS_TOKEN) return !patches.includes('walls');
  const want = sanitizePatchName(choice.bcName || choice.label);
  const numbered = new RegExp('^' + want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:_\\d+)?$');
  return !patches.some((p) => p === want || numbered.test(p));
}

/** What a result control of this type saves when it is created ("Point probe 1", its target's fields). */
export function newMonitorRecord(
  typeRow: RegistryRow,
  id: string,
  name: string,
  opts: { boundaries?: string[] } = {},
): Record<string, unknown> {
  const target = targetOf(typeRow);
  const base = {
    id,
    name,
    monitor_type: typeRow.key,
    kind: typeRow.label || 'Area average',
    category: target === 'boundary' ? 'Boundary data' : target === 'point' ? 'Point data' : 'Surface data',
    write_control: 'Time step',
    faces: [] as string[],
    results: null,
    series: null,
    chart_values: null,
    results_available: false,
  };
  if (target === 'boundary') return { ...base, boundaries: (opts.boundaries || []).slice() };
  if (target === 'point') return { ...base, points: [] };
  return base;
}

/** "3 faces", "2 walls", "1 point": what a result control is placed on; '' when nothing. */
export function placedText(rc: Record<string, unknown> | null | undefined, typeRow?: RegistryRow | null): string {
  if (!rc) return '';
  const n = (k: string) => (Array.isArray(rc[k]) ? (rc[k] as unknown[]).length : 0);
  const word = (count: number, one: string, many: string) => count + ' ' + (count === 1 ? one : many);
  if (n('points')) return word(n('points'), 'point', 'points');
  if (n('boundaries')) {
    const kinds = typeRow && Array.isArray(typeRow.boundary_kinds) ? typeRow.boundary_kinds : [];
    const walls = kinds.length === 1 && kinds[0] === 'wall';
    return walls ? word(n('boundaries'), 'wall', 'walls') : word(n('boundaries'), 'boundary', 'boundaries');
  }
  if (n('faces')) return word(n('faces'), 'face', 'faces');
  return '';
}

/** True when a result control is placed on something (faces, boundaries or points). */
export function isPlaced(rc: Record<string, unknown> | null | undefined): boolean {
  return !!rc && ['faces', 'boundaries', 'points'].some((k) => Array.isArray(rc[k]) && (rc[k] as unknown[]).length > 0);
}

/** A saved point: three finite numbers (metres), else null. */
export function savedPoint(p: unknown): [number, number, number] | null {
  if (!Array.isArray(p) || p.length !== 3) return null;
  const n = p.map((v) => (v == null || v === '' ? NaN : Number(v)));
  return n.every(Number.isFinite) ? (n as [number, number, number]) : null;
}
