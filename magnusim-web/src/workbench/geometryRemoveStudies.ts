/**
 * The studies a geometry's removal takes with it. The server removes them with the
 * geometry (dropGeometryStudies); the tab has to forget them too. When the last geometry
 * went, the tab kept them: the removed study stayed the active one, and after a new part
 * was added (Daniel: the same file name, a changed part) the Create Simulation dialog still
 * offered it under "Start from".
 *
 * A study with no geometry_id belongs to the project's first geometry (`firstGeometryId`,
 * as studyGeometryId in the runtime says).
 */

type StudyLike = { id?: unknown; geometry_id?: unknown } | null | undefined;

export interface StudiesOnRemove<T> {
  /** Ids of the removed geometry's studies. */
  removed: string[];
  /** Every other study, in the same order. */
  left: T[];
}

export function splitStudiesOnRemove<T extends StudyLike>(
  list: readonly T[] | null | undefined,
  removedGeometryId: string,
  firstGeometryId: string,
): StudiesOnRemove<T> {
  const gone = String(removedGeometryId || '');
  const removed: string[] = [];
  const left: T[] = [];
  for (const s of list || []) {
    const id = String((s && s.id) || '');
    const geom = String((s && s.geometry_id) || '') || String(firstGeometryId || '');
    if (id && gone && geom === gone) removed.push(id);
    else left.push(s);
  }
  return { removed, left };
}
