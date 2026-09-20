/**
 * mesh.json must stay small. A generate log belongs in the job log file,
 * not in the settings document — a multi-MB excerpt freezes reopen.
 */

export const MESH_LOG_EXCERPT_MAX = 4000;

export function slimLogExcerpt(text, max = MESH_LOG_EXCERPT_MAX) {
  if (text == null) return null;
  const s = String(text);
  if (!s) return '';
  return s.length > max ? s.slice(-max) : s;
}

export function slimLiveMeshResult(live) {
  if (!live || typeof live !== 'object') return live || null;
  if (!Object.prototype.hasOwnProperty.call(live, 'log_excerpt')) return live;
  const excerpt = slimLogExcerpt(live.log_excerpt);
  if (excerpt === live.log_excerpt) return live;
  return { ...live, log_excerpt: excerpt };
}

export function slimMeshDoc(doc) {
  if (!doc || typeof doc !== 'object') return doc;
  let changed = false;
  const live = slimLiveMeshResult(doc.live_mesh_result);
  if (live !== doc.live_mesh_result) changed = true;
  const meshes = Array.isArray(doc.meshes)
    ? doc.meshes.map((m) => {
        if (!m || !m.live_mesh_result) return m;
        const sl = slimLiveMeshResult(m.live_mesh_result);
        if (sl === m.live_mesh_result) return m;
        changed = true;
        return { ...m, live_mesh_result: sl };
      })
    : doc.meshes;
  return changed ? { ...doc, live_mesh_result: live, meshes } : doc;
}

export function meshDocLogIsBloated(doc, max = MESH_LOG_EXCERPT_MAX) {
  if (!doc) return false;
  const too = (live) => typeof (live && live.log_excerpt) === 'string' && live.log_excerpt.length > max;
  if (too(doc.live_mesh_result)) return true;
  return Array.isArray(doc.meshes) && doc.meshes.some((m) => too(m && m.live_mesh_result));
}
