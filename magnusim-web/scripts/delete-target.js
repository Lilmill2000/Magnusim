/**
 * What a record delete names (POST /api/bcs and /api/mesh/refinements with `delete`).
 *
 *   {delete: '<id or name>'}            that record
 *   {delete: true, id | name}           that record
 *   {action: 'delete', id | name}       that record
 *   {delete: 'all'}                     every record of the study (asked for in words)
 *
 * `delete: true` once read as the text "true", which meant all: a delete of one id wiped
 * the study. A bare `delete: true` (no id or name) now names nothing and is refused.
 * @param {Record<string, unknown> | null | undefined} body
 * @returns {{ all: true } | { which: string } | { error: string }}
 */
export function deleteTarget(body) {
  const b = body || {};
  const flag = typeof b.delete === 'string' ? b.delete.trim() : '';
  if (flag === 'all') return { all: true };
  if (flag && flag !== 'true') return { which: flag };
  const which = String(b.id || b.name || '').trim();
  if (which) return { which };
  return { error: 'Name the record to delete (id), or send delete: "all" to delete every one of the study' };
}
