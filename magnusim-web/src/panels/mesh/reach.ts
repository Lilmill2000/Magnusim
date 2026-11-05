/**
 * "Refine out to" on Surface custom sizing (the validation set's gap G4; Daniel's yes on
 * 2026-11-05): how far from its faces a custom size's cells keep that size. Empty (null) keeps
 * the default band, about three cells of the size, and so does a shorter distance. The record
 * stores it with its unit (`reach`, `reach_unit`: scripts/w26-mesh-refinements.js).
 *
 * Hex-dominant writes it as the distance of the faces' refinement region
 * (python/tools/generate_snappy.py, cfddesk/mesh/snappy_hexdominant.refine_distance_m).
 * Standard and cfMesh size the faces only: the refinement editor says so under the field, and
 * the Assistant's read_setup refinements carries the same words.
 */

/** A mesher's registry row, as far as the note reads it (src/mesher.ts MesherRow). */
export interface ReachMesher {
  key?: string;
  label?: string;
  engine?: string;
}

/** The record's keys. */
export const REACH = 'reach';
export const REACH_UNIT = 'reach_unit';

/** The mesh run paths (a mesher's `engine`) whose run refines out to the distance. */
export const REACH_ENGINES: readonly string[] = Object.freeze(['snappy_hexdominant']);

/** The core meshers' names, for a mesh whose mesher's row has not loaded. */
const CORE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  standard: 'Standard',
  cfmesh: 'cfMesh',
  snappy_hexdominant: 'Hex-dominant',
});

/** Whether a mesh made by this mesher (`key`, its row when loaded) refines out to the distance. */
export function reachApplies(row: ReachMesher | null | undefined, key: string): boolean {
  const engine = String(row?.engine || row?.key || key || '');
  return REACH_ENGINES.includes(engine);
}

/** The words under Refine out to on a mesh made by this mesher: '' when its run uses it. */
export function reachNote(row: ReachMesher | null | undefined, key: string): string {
  if (reachApplies(row, key)) return '';
  const name = String(row?.label || CORE_LABELS[key] || key || 'This mesher');
  return `${name} ignores Refine out to: it sizes these faces only. Hex-dominant refines the cells out to this distance.`;
}

/**
 * A typed Refine out to as the record keeps it: a distance above 0, or null (empty, 0: the
 * default band). Undefined for anything else (a negative or non-numeric value).
 */
export function reachValue(raw: unknown): number | null | undefined {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.trim()) : Number.NaN;
  if (!Number.isFinite(n) || n < 0) return undefined;
  return n === 0 ? null : n;
}
