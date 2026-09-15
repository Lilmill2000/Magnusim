/**
 * Which geometry is active, and whether a setup record belongs to it.
 * Records with no geometry_id belong to the project's first / primary geometry
 * (existing single-geometry projects).
 */
export function geometriesOf(proj) {
  if (Array.isArray(proj && proj.geometries) && proj.geometries.length) {
    return proj.geometries.filter((g) => g && g.id);
  }
  return [];
}

export function primaryGeometryId(proj) {
  const list = geometriesOf(proj);
  if (list[0] && list[0].id) return String(list[0].id);
  if (proj && proj.geometry && proj.geometry.id) return String(proj.geometry.id);
  return null;
}

export function activeGeometryId(proj, explicit) {
  const want = String(explicit || '').trim();
  if (want) return want;
  if (proj && proj.active_geometry_id) return String(proj.active_geometry_id);
  return primaryGeometryId(proj);
}

export function matchesGeometry(rec, geomId, primaryId) {
  const want = String(geomId || '').trim();
  if (!want) return true;
  const gid = rec && rec.geometry_id != null ? String(rec.geometry_id).trim() : '';
  if (!gid) return !!primaryId && want === String(primaryId);
  return gid === want;
}

export function filterByGeometry(list, geomId, primaryId) {
  return (list || []).filter((rec) => matchesGeometry(rec, geomId, primaryId));
}

/** Untagged records belong only to a singleton catalog study, never to a later or first-of-many study. */
export function matchesStudy(rec, simId, legacySimId) {
  const want = String(simId || '').trim();
  if (!want) return false;
  const sid = rec && rec.simulation_id != null ? String(rec.simulation_id).trim() : '';
  if (!sid) return !!legacySimId && want === String(legacySimId);
  return sid === want;
}

export function filterByStudy(list, simId, legacySimId) {
  return (list || []).filter((rec) => matchesStudy(rec, simId, legacySimId));
}
