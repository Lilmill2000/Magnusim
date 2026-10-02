import type { RegistryRow } from './api/registry.gen';
import { useProjectStore } from './store/project';

/**
 * What the page shows for a mesher comes from its registry row (MeshBackend):
 * the stage names while it runs, the finished mesh's summary, and the
 * refinement types the Mesh panel offers.
 */
export interface MesherRow {
  key?: string;
  label?: string;
  engine?: string;
  stage_labels?: Record<string, string>;
  stage_details?: [string, string, string][];
  report?: [string, string, string][];
  refinement_types?: RefinementType[];
}

/** A refinement type a mesher applies: its key, the label records store, and a one-line hint. */
export interface RefinementType {
  key: string;
  label: string;
  hint?: string;
}

/** The run path each core engine reports as path_kind, for a result that names no mesher. */
const PATH_KIND_MESHER: Record<string, string> = {
  standard: 'standard',
  cartesianMesh: 'cfmesh',
  cfMesh: 'cfmesh',
  snappyHexMesh: 'snappy_hexdominant',
};

/** Refinement types offered when the registry has not loaded yet. */
const FALLBACK_REFINEMENTS: RefinementType[] = [
  { key: 'surface_custom_sizing', label: 'Surface custom sizing', hint: 'Set a max element size on selected faces' },
  { key: 'inflate_boundary_layer', label: 'Inflate boundary layer', hint: 'Prism layers — set count and total thickness' },
];

export function mesherRows(): MesherRow[] {
  return ((useProjectStore.getState().registry?.mesher || []) as RegistryRow[]).filter((row) =>
    String(row.key || '').trim(),
  ) as MesherRow[];
}

/** The mesher row for a mesh job or result: its mesh_backend, else its run path. */
export function mesherFor(
  rows: MesherRow[],
  meshBackend: string | null | undefined,
  pathKind?: string | null,
): MesherRow | undefined {
  const key = String(meshBackend || '') || PATH_KIND_MESHER[String(pathKind || '')] || '';
  return key ? rows.find((row) => row.key === key) : undefined;
}

/** The panel's text for a running stage: the mesher's detail line, its stage label, or "Working". */
export function stageText(row: MesherRow | undefined, stage: string, detail: string): string {
  if (!stage || stage === 'starting') return 'Starting';
  for (const [s, pattern, label] of row?.stage_details || []) {
    if (s !== stage) continue;
    try {
      if (new RegExp(pattern, 'i').test(detail)) return label;
    } catch {
      /* the registry refuses a bad pattern; nothing to show for one */
    }
  }
  return row?.stage_labels?.[stage] || 'Working';
}

/**
 * The finished mesh's summary lines from the mesher's report: a true value
 * shows its text, a false one the alternative, a number fills "{length}".
 */
export function reportBits(
  row: MesherRow | undefined,
  result: Record<string, unknown>,
  formatLength: (metres: unknown) => string | null,
): string[] {
  const bits: string[] = [];
  for (const [key, text, otherwise] of row?.report || []) {
    if (!key) {
      if (text) bits.push(text);
      continue;
    }
    const v = result[key];
    if (v === true) {
      if (text) bits.push(text);
    } else if (v === false) {
      if (otherwise) bits.push(otherwise);
    } else if (typeof v === 'number' && text.includes('{length}')) {
      const len = formatLength(v);
      if (len) bits.push(text.replace('{length}', len));
    }
  }
  return bits;
}

/** The refinement types the Mesh panel offers for a mesh made by this mesher. */
export function refinementMenu(row: MesherRow | undefined): RefinementType[] {
  const types = row?.refinement_types;
  return Array.isArray(types) && types.length ? types : FALLBACK_REFINEMENTS;
}
